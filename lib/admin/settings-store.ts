/**
 * SettingsStore — Admin settings storage for budgets and caps (Requirement 30).
 *
 * Requirement 30.1: every cap is exposed as an Admin setting.
 * Requirement 30.2: the Necromancer refuses to start runs while a Required_Setting has no value.
 * Requirement 30.3: ships the starting values and enumerates the Required_Settings without values.
 * Requirement 30.18: an Admin change to a budget setting records an audit entry.
 * Requirement 30.20: the first three Recorded_Runs require recalibration of the E11 settings.
 *
 * The store mirrors the `RunStore` / `EventStore` construction and default-instance pattern and
 * is backed by the built-in `node:sqlite` runtime (no better-sqlite3).
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventEnvelope, EventStore } from "../events/event-store";
import type { RunStore } from "../runs/run-store";

/**
 * FIND-003: sentinel written to `admin_settings.valueJson` for Required_Settings that ship without
 * a value. It is deliberately *not* valid JSON, so it can never collide with a real value — every
 * JSON value serializes to a different string (`null` -> `"null"`, the string "x" -> `"\"x\""`,
 * numbers/booleans -> their literals). Reading it back yields `undefined` (unset), which keeps
 * `getSetting` / `getAllSettings` / `validateRequiredSettings` semantics intact while allowing an
 * explicit `setSetting(key, null, ...)` to round-trip as a real `null`.
 */
export const UNSET_VALUE_SENTINEL = "__UNSET__";

/** `updatedBy` marker written when a Required_Setting is seeded without a value. */
const REQUIRED_SEED_ACTOR = "system:required";

export interface SettingsStoreOptions {
  path?: string;
  db?: DatabaseSync;
  busyTimeout?: number;
}

export interface SetSettingOptions {
  actor: string;
  reason?: string;
  ts?: number;
}

export interface SettingsAuditEntry {
  id: number;
  ts: number;
  actor: string;
  key: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
}

export interface GetAuditLogOptions {
  key?: string;
  limit?: number;
}

export interface RequiredSettingsValidation {
  ok: boolean;
  missing: string[];
  code?: "REQUIRED_SETTING_MISSING";
  message?: string;
}

export interface CalibrationState {
  completedRecordedRuns: number;
  recalibrationRequired: boolean;
  lastCalibratedAt: number | null;
  lastCalibratedRunIds: string[];
}

export interface SyncRecordedRunCountSources {
  eventStore?: EventStore;
  runStore?: RunStore;
  recordedRunIds?: string[];
}

export interface SyncRecordedRunCountResult {
  completedRecordedRuns: number;
  recalibrationRequired: boolean;
}

export interface MarkCalibratedOptions {
  actor: string;
  runIds: string[];
  ts?: number;
}

/**
 * E11 starting defaults (Requirement 30.3). Seeded once, on init, only when a key is absent so
 * an existing database is never overwritten with the shipped values.
 */
export const E11_DEFAULT_SETTINGS: Readonly<Record<string, number>> = {
  wardenRounds: 3,
  promptWallClockMs: 600000, // 10 min
  exhumerTriageWallClockMs: 180000, // 3 min
  promptsPerSkeleton: 4,
  toolCallsPerTurn: 60,
  contextPressurePercent: 80,
  runWallClockMs: 2700000, // 45 min
  silentSkeletonMs: 120000, // 120 s
  budgetWarningPercent: 80,
  liveKiroProcesses: 4,
  parallelSoulStitchers: 1,
  queueDepth: 5,
  // Requirement 30.3: editable live-run concurrency limit (dev default 1, prod ceiling <= 5).
  concurrentLiveRuns: 1,
};

/** Required_Settings that always need an Owner-set value before a run may start. */
export const ALWAYS_REQUIRED_SETTING_KEYS: readonly string[] = [
  "toolCallsPerRun",
  "approvalWaitMs",
  "queueIdleLimitMs",
  "pactIdleLimitMs",
  "repoSizeCapKb",
  "boxCpu",
  "boxMemoryMb",
  "boxPids",
  "boxDiskMb",
  "brokerWatchdogMs",
];

/** Required_Settings that only apply when probe P5 reports a credit field. */
export const CONDITIONAL_REQUIRED_SETTING_KEYS: readonly string[] = [
  "creditsPerRun",
  "creditsPerDay",
];

/** Every Required_Setting: no starting value, enumerated for the Admin_Page. */
export const REQUIRED_SETTING_KEYS: readonly string[] = [
  ...ALWAYS_REQUIRED_SETTING_KEYS,
  ...CONDITIONAL_REQUIRED_SETTING_KEYS,
];

const REQUIRED_KEY_SET = new Set<string>(REQUIRED_SETTING_KEYS);

/** Thrown by {@link assertRequiredSettingsConfigured} when a Required_Setting has no value. */
export class RequiredSettingMissingError extends Error {
  readonly code = "REQUIRED_SETTING_MISSING";
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Required settings missing: ${missing.join(", ")}`);
    this.name = "RequiredSettingMissingError";
    this.missing = [...missing];
  }
}

/**
 * Resolves only genuine `Object` literals (or null-prototype objects) to a plain record.
 *
 * It deliberately rejects every other exotic object (`Map`, `Set`, `Date`, `RegExp`, class
 * instances, arrays, …) by checking the prototype chain, so a value that cannot round-trip through
 * `JSON.stringify` / `JSON.parse` is never accepted as a setting value.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reserved prototype-pollution keys. `Object.defineProperty` / `JSON.parse` can materialise these
 * as own enumerable properties, so writing them would either silently mutate a prototype or shadow
 * `Object` members. They are rejected in `setSetting` and `setSettingsBatch`.
 */
const RESERVED_SETTING_KEYS = new Set<string>(["__proto__", "constructor", "prototype"]);

/**
 * Count-like settings whose value must be a non-negative *integer*. The generic non-negative finite
 * check below still applies first; this only tightens it for keys where a fractional value (e.g.
 * `concurrentLiveRuns: 1.5`) is meaningless.
 */
const INTEGER_SETTING_KEYS = new Set<string>([
  "concurrentLiveRuns",
  "wardenRounds",
  "promptsPerSkeleton",
  "toolCallsPerTurn",
  "toolCallsPerRun",
  "creditsPerRun",
  "creditsPerDay",
  "contextPressurePercent",
  "budgetWarningPercent",
  "liveKiroProcesses",
  "parallelSoulStitchers",
  "queueDepth",
]);

/**
 * Validates a setting value: numeric settings must be finite and non-negative (and, for count
 * settings, integers); other settings must be a string, boolean, null or a plain object. Arrays,
 * functions, symbols and exotic objects (`Map`/`Set`/`Date`/`RegExp`) are rejected, as are the
 * reserved prototype-pollution keys.
 */
function assertValidSettingValue(key: string, value: unknown): void {
  if (RESERVED_SETTING_KEYS.has(key)) {
    throw new TypeError(`Setting key "${key}" is reserved and cannot be set`);
  }
  if (value === undefined) {
    throw new TypeError(`Setting "${key}" value must not be undefined`);
  }
  if (value === null) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Setting "${key}" must be a finite number (received ${String(value)})`);
    }
    if (value < 0) {
      throw new RangeError(`Setting "${key}" must not be negative (received ${value})`);
    }
    if (INTEGER_SETTING_KEYS.has(key) && !Number.isInteger(value)) {
      throw new RangeError(
        `Setting "${key}" must be a non-negative integer (received ${value})`
      );
    }
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (isPlainObject(value)) {
    return;
  }
  throw new TypeError(
    `Setting "${key}" must be a finite number, string, boolean, null or plain object`
  );
}

function isMissingValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  return false;
}

function isDirectoryWritable(dirPath: string): boolean {
  try {
    if (fs.existsSync(dirPath)) {
      fs.accessSync(dirPath, fs.constants.W_OK);
      return true;
    }
  } catch {
    // directory missing or not writable
  }
  return false;
}

/**
 * Resolves the default on-disk settings database path: an explicit `path` option wins, then the
 * `SETTINGS_STORE_PATH` environment variable, then `/data` when it is writable, and finally a
 * per-user temp directory. Exported so the calibration CLI (FIND-001) can open the same default
 * store when `--settings-db` is omitted.
 */
export function resolveDefaultSettingsStorePath(options?: SettingsStoreOptions): string {
  if (options?.path) {
    return options.path;
  }
  if (process.env.SETTINGS_STORE_PATH) {
    return process.env.SETTINGS_STORE_PATH;
  }
  if (isDirectoryWritable("/data")) {
    return "/data/settings.db";
  }
  return path.join(os.tmpdir(), "git-graveyard-data", "settings.db");
}

/**
 * Parses a stored JSON value.
 *
 * FIND-003: a `raw` value that is not a string, is empty, or equals the {@link UNSET_VALUE_SENTINEL}
 * is treated as `undefined` (unset). A literal `"null"` is *not* special-cased here — it parses to
 * `null`, so an explicit `null` setting and an initial-creation SQL `NULL` audit `beforeJson` stay
 * distinguishable.
 */
function parseStoredValue(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0 || raw === UNSET_VALUE_SENTINEL) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * FIND-003 backward compatibility: databases written before the sentinel existed seeded
 * Required_Settings with the literal string `"null"` and `updatedBy = "system:required"`. That
 * *combination* means "unset". An explicit `setSetting(key, null, { actor })` stores `"null"` with a
 * real actor, so it is preserved as a genuine `null`.
 */
function isLegacyUnsetValue(valueJson: unknown, updatedBy: unknown): boolean {
  return valueJson === "null" && updatedBy === REQUIRED_SEED_ACTOR;
}

/** Reads a setting value, applying the legacy-unset rule on top of {@link parseStoredValue}. */
function readSettingValue(valueJson: unknown, updatedBy: unknown): unknown {
  const value = parseStoredValue(valueJson);
  if (value === null && isLegacyUnsetValue(valueJson, updatedBy)) {
    return undefined;
  }
  return value;
}

function rowToAuditEntry(row: Record<string, unknown>): SettingsAuditEntry {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    actor: String(row.actor),
    key: String(row.key),
    beforeValue: parseStoredValue(row.beforeJson),
    afterValue: parseStoredValue(row.afterJson),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  };
}


function detectStorageMode(db: DatabaseSync): "memory" | "file" {
  try {
    const locFn = (db as unknown as { location?: () => string | null }).location;
    if (typeof locFn === "function") {
      const loc = locFn.call(db);
      return typeof loc === "string" && loc.length > 0 ? "file" : "memory";
    }
  } catch {
    // fall through to pragma
  }
  try {
    const rows = db.prepare("PRAGMA database_list").all() as Array<{
      name?: string;
      file?: string;
    }>;
    const main = rows.find((r) => r.name === "main") ?? rows[0];
    if (main && typeof main.file === "string" && main.file.length > 0) {
      return "file";
    }
  } catch {
    // ignore
  }
  return "memory";
}

/**
 * FIND-004 / WP-17-fix2: returns a run's latest `run.done` envelope — highest `seq`, tie-breaking in
 * favour of the later array index — matching `latestRunDoneEvent` in the calibration script so both
 * agree on what a run's terminal outcome is. Returns `null` when the run never concluded.
 */
function pickLatestRunDoneEvent(events: EventEnvelope[]): EventEnvelope | null {
  let latest: EventEnvelope | null = null;
  for (const ev of events) {
    if (ev.kind !== "run.done") {
      continue;
    }
    if (latest === null || ev.seq >= latest.seq) {
      latest = ev;
    }
  }
  return latest;
}

export class SettingsStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly storageMode: "memory" | "file";
  private readonly busyTimeoutMs: number;

  private getSettingStmt!: StatementSync;
  private getAllSettingsStmt!: StatementSync;
  private upsertSettingStmt!: StatementSync;
  private insertAuditStmt!: StatementSync;
  private getAuditAllStmt!: StatementSync;
  private getAuditByKeyStmt!: StatementSync;
  private getAuditRecentStmt!: StatementSync;
  private getAuditRecentByKeyStmt!: StatementSync;
  private upsertMetaStmt!: StatementSync;
  private getMetaStmt!: StatementSync;

  constructor(optionsOrPath?: string | DatabaseSync | SettingsStoreOptions) {
    let busyTimeout = 5000;

    if (optionsOrPath instanceof DatabaseSync) {
      this.db = optionsOrPath;
      this.ownsDb = false;
      this.storageMode = detectStorageMode(this.db);
    } else if (typeof optionsOrPath === "string") {
      const dbPath = optionsOrPath;
      if (dbPath !== ":memory:") {
        const dir = path.dirname(dbPath);
        if (dir && dir !== "." && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(dbPath);
      this.ownsDb = true;
      this.storageMode = dbPath === ":memory:" ? "memory" : "file";
    } else if (optionsOrPath && typeof optionsOrPath === "object") {
      if (
        typeof optionsOrPath.busyTimeout === "number" &&
        Number.isFinite(optionsOrPath.busyTimeout) &&
        optionsOrPath.busyTimeout > 0
      ) {
        busyTimeout = Math.floor(optionsOrPath.busyTimeout);
      }
      if (optionsOrPath.db) {
        this.db = optionsOrPath.db;
        this.ownsDb = false;
        this.storageMode = detectStorageMode(this.db);
      } else {
        const dbPath = optionsOrPath.path ?? ":memory:";
        if (dbPath !== ":memory:") {
          const dir = path.dirname(dbPath);
          if (dir && dir !== "." && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        }
        this.db = new DatabaseSync(dbPath);
        this.ownsDb = true;
        this.storageMode = dbPath === ":memory:" ? "memory" : "file";
      }
    } else {
      this.db = new DatabaseSync(":memory:");
      this.ownsDb = true;
      this.storageMode = "memory";
    }

    this.busyTimeoutMs = busyTimeout;
    this.initSchema();
    this.seedDefaults();
    this.prepareStatements();
  }

  getStorageMode(): "memory" | "file" {
    return this.storageMode;
  }

  private initSchema(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        valueJson TEXT NOT NULL,
        isRequired INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_settings_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        key TEXT NOT NULL,
        beforeJson TEXT,
        afterJson TEXT,
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_admin_settings_audit_key ON admin_settings_audit (key);
      CREATE INDEX IF NOT EXISTS idx_admin_settings_audit_ts ON admin_settings_audit (ts);

      CREATE TABLE IF NOT EXISTS admin_meta (
        key TEXT PRIMARY KEY,
        valueJson TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
  }


  /**
   * Seeds the E11 starting values and enumerates the Required_Settings (Requirement 30.3).
   * Uses INSERT OR IGNORE so an existing database is never overwritten.
   */
  private seedDefaults(): void {
    const now = Date.now();
    const insertIfAbsent = this.db.prepare(
      `INSERT OR IGNORE INTO admin_settings (key, valueJson, isRequired, updatedAt, updatedBy)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const [key, value] of Object.entries(E11_DEFAULT_SETTINGS)) {
      insertIfAbsent.run(key, JSON.stringify(value), 0, now, "system:e11-defaults");
    }
    for (const key of REQUIRED_SETTING_KEYS) {
      // FIND-003: use the non-JSON sentinel instead of the literal "null" so an explicit null set
      // later is never confused with "unset".
      insertIfAbsent.run(key, UNSET_VALUE_SENTINEL, 1, now, REQUIRED_SEED_ACTOR);
    }
  }

  private prepareStatements(): void {
    this.getSettingStmt = this.db.prepare(
      "SELECT valueJson, updatedBy FROM admin_settings WHERE key = ?"
    );
    this.getAllSettingsStmt = this.db.prepare(
      "SELECT key, valueJson, updatedBy FROM admin_settings ORDER BY key ASC"
    );
    this.upsertSettingStmt = this.db.prepare(`
      INSERT INTO admin_settings (key, valueJson, isRequired, updatedAt, updatedBy)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        valueJson = excluded.valueJson,
        isRequired = MAX(admin_settings.isRequired, excluded.isRequired),
        updatedAt = excluded.updatedAt,
        updatedBy = excluded.updatedBy
    `);
    this.insertAuditStmt = this.db.prepare(`
      INSERT INTO admin_settings_audit (ts, actor, key, beforeJson, afterJson, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.getAuditAllStmt = this.db.prepare(
      "SELECT id, ts, actor, key, beforeJson, afterJson, reason FROM admin_settings_audit ORDER BY id ASC"
    );
    this.getAuditByKeyStmt = this.db.prepare(
      "SELECT id, ts, actor, key, beforeJson, afterJson, reason FROM admin_settings_audit WHERE key = ? ORDER BY id ASC"
    );
    this.getAuditRecentStmt = this.db.prepare(
      "SELECT id, ts, actor, key, beforeJson, afterJson, reason FROM admin_settings_audit ORDER BY id DESC LIMIT ?"
    );
    this.getAuditRecentByKeyStmt = this.db.prepare(
      "SELECT id, ts, actor, key, beforeJson, afterJson, reason FROM admin_settings_audit WHERE key = ? ORDER BY id DESC LIMIT ?"
    );
    this.upsertMetaStmt = this.db.prepare(`
      INSERT INTO admin_meta (key, valueJson, updatedAt) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        valueJson = excluded.valueJson,
        updatedAt = excluded.updatedAt
    `);
    this.getMetaStmt = this.db.prepare("SELECT valueJson FROM admin_meta WHERE key = ?");
  }


  getSetting<T = unknown>(key: string): T | undefined {
    if (!key || typeof key !== "string") {
      return undefined;
    }
    const row = this.getSettingStmt.get(key) as
      | { valueJson?: unknown; updatedBy?: unknown }
      | undefined;
    if (!row) {
      return undefined;
    }
    const value = readSettingValue(row.valueJson, row.updatedBy);
    return value === undefined ? undefined : (value as T);
  }

  getAllSettings(): Record<string, unknown> {
    const rows = this.getAllSettingsStmt.all() as Array<{
      key?: unknown;
      valueJson?: unknown;
      updatedBy?: unknown;
    }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const value = readSettingValue(row.valueJson, row.updatedBy);
      if (value === undefined) {
        continue;
      }
      // Assign via `Object.defineProperty` so a stored `__proto__` / `constructor` key is created as
      // a plain own property and can never mutate the result's prototype (prototype pollution).
      Object.defineProperty(out, String(row.key), {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }

  setSetting(key: string, value: unknown, options: SetSettingOptions): SettingsAuditEntry {
    if (!key || typeof key !== "string") {
      throw new TypeError("key must be a non-empty string");
    }
    if (RESERVED_SETTING_KEYS.has(key)) {
      throw new TypeError(`Setting key "${key}" is reserved and cannot be set`);
    }
    const entries = this.setSettingsBatch({ [key]: value }, options);
    return entries[0];
  }

  setSettingsBatch(
    updates: Record<string, unknown>,
    options: SetSettingOptions
  ): SettingsAuditEntry[] {
    const actor = options?.actor;
    if (!actor || typeof actor !== "string" || actor.trim() === "") {
      throw new TypeError("actor is required and must be a non-empty string");
    }
    if (!isPlainObject(updates)) {
      throw new TypeError("updates must be a plain object");
    }

    const entries = Object.entries(updates);
    for (const [key, value] of entries) {
      assertValidSettingValue(key, value);
    }

    const ts =
      typeof options?.ts === "number" && Number.isFinite(options.ts)
        ? Math.floor(options.ts)
        : Date.now();
    const reason = typeof options?.reason === "string" ? options.reason : null;

    const inTx = this.db.isTransaction;
    if (!inTx) {
      this.db.exec("BEGIN IMMEDIATE");
    } else {
      this.db.exec("SAVEPOINT settings_write");
    }

    const results: SettingsAuditEntry[] = [];
    try {
      for (const [key, value] of entries) {
        const before = this.getSetting(key);
        const beforeJson = before === undefined ? null : JSON.stringify(before);
        const afterJson = JSON.stringify(value);
        this.upsertSettingStmt.run(
          key,
          afterJson,
          REQUIRED_KEY_SET.has(key) ? 1 : 0,
          ts,
          String(actor)
        );
        const res = this.insertAuditStmt.run(ts, String(actor), key, beforeJson, afterJson, reason);
        results.push({
          id: Number(res.lastInsertRowid),
          ts,
          actor: String(actor),
          key,
          beforeValue: before,
          afterValue: value,
          reason,
        });
      }
      if (!inTx) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec("RELEASE SAVEPOINT settings_write");
      }
    } catch (err) {
      try {
        if (!inTx) {
          this.db.exec("ROLLBACK");
        } else {
          this.db.exec("ROLLBACK TO SAVEPOINT settings_write");
        }
      } catch {
        // ignore rollback error
      }
      throw err;
    }

    return results;
  }

  getAuditLog(options?: GetAuditLogOptions): SettingsAuditEntry[] {
    const key = options?.key;
    const limit =
      typeof options?.limit === "number" && options.limit > 0 ? Math.floor(options.limit) : null;

    let rows: Array<Record<string, unknown>>;
    if (key) {
      rows = (limit
        ? this.getAuditRecentByKeyStmt.all(key, limit)
        : this.getAuditByKeyStmt.all(key)) as unknown as Array<Record<string, unknown>>;
    } else {
      rows = (limit
        ? this.getAuditRecentStmt.all(limit)
        : this.getAuditAllStmt.all()) as unknown as Array<Record<string, unknown>>;
    }

    const mapped = rows.map(rowToAuditEntry);
    if (limit) {
      mapped.reverse();
    }
    return mapped;
  }


  /**
   * Requirement 30.2: reports every Required_Setting without a value. `creditsPerRun` and
   * `creditsPerDay` are only required when `creditsReported` is true (probe P5).
   */
  validateRequiredSettings(options?: { creditsReported?: boolean }): RequiredSettingsValidation {
    const creditsReported = options?.creditsReported === true;
    const keys = creditsReported
      ? [...ALWAYS_REQUIRED_SETTING_KEYS, ...CONDITIONAL_REQUIRED_SETTING_KEYS]
      : [...ALWAYS_REQUIRED_SETTING_KEYS];

    const missing: string[] = [];
    for (const key of keys) {
      if (isMissingValue(this.getSetting(key))) {
        missing.push(key);
      }
    }

    if (missing.length === 0) {
      return { ok: true, missing: [] };
    }
    return {
      ok: false,
      missing,
      code: "REQUIRED_SETTING_MISSING",
      message: `Required settings missing: ${missing.join(", ")}`,
    };
  }

  isRecalibrationRequired(): boolean {
    return this.getMetaRaw("recalibrationRequired") === true;
  }

  getCalibrationState(): CalibrationState {
    const countRaw = this.getMetaRaw("completedRecordedRuns");
    const completedRecordedRuns =
      typeof countRaw === "number" && Number.isFinite(countRaw) ? countRaw : 0;

    const lastAtRaw = this.getMetaRaw("lastCalibratedAt");
    const lastCalibratedAt =
      typeof lastAtRaw === "number" && Number.isFinite(lastAtRaw) ? lastAtRaw : null;

    const lastIdsRaw = this.getMetaRaw("lastCalibratedRunIds");
    const lastCalibratedRunIds = Array.isArray(lastIdsRaw)
      ? lastIdsRaw.map((id) => String(id))
      : [];

    return {
      completedRecordedRuns,
      recalibrationRequired: this.isRecalibrationRequired(),
      lastCalibratedAt,
      lastCalibratedRunIds,
    };
  }

  /**
   * Requirement 30.20: counts distinct completed Recorded_Runs and requires recalibration once
   * three have concluded (and again whenever new runs conclude after a calibration).
   */
  syncRecordedRunCount(sources: SyncRecordedRunCountSources): SyncRecordedRunCountResult {
    const ids = new Set<string>();

    if (sources.recordedRunIds !== undefined) {
      for (const id of sources.recordedRunIds) {
        if (typeof id === "string" && id.length > 0) {
          ids.add(id);
        }
      }
    } else {
      const runStore = sources.runStore;
      if (runStore) {
        for (const run of runStore.listRuns()) {
          if (run.phase === "done" && run.outcome !== null && run.outcome !== "error") {
            ids.add(run.runId);
          }
        }
      }
      const eventStore = sources.eventStore;
      if (eventStore) {
        // WP-17-fix2: always evaluate the EventStore's `run.done`, even when the RunStore already
        // added the id. A run the RunStore records as `done`/non-error is still not a completed
        // Recorded_Run when its latest `run.done` says `outcome === "error"` — that id is removed.
        for (const runId of eventStore.getRunIds()) {
          const events = eventStore.getEvents(runId, { kind: "run.done" });
          if (events.length === 0) {
            continue;
          }
          // FIND-004: only the *latest* run.done (by seq) decides the run's outcome.
          const latestDone = pickLatestRunDoneEvent(events);
          if (latestDone === null) {
            continue;
          }
          if (latestDone.data.outcome === "error") {
            ids.delete(runId);
            continue;
          }
          ids.add(runId);
        }
      }
    }

    const completed = ids.size;
    const state = this.getCalibrationState();
    let recalibrationRequired = false;

    if (completed >= 3) {
      if (state.lastCalibratedAt === null) {
        recalibrationRequired = true;
      } else {
        const calibrated = new Set(state.lastCalibratedRunIds);
        for (const id of ids) {
          if (!calibrated.has(id)) {
            recalibrationRequired = true;
            break;
          }
        }
      }
    }

    const ts = Date.now();
    this.setMeta("completedRecordedRuns", completed, ts);
    this.setMeta("recalibrationRequired", recalibrationRequired, ts);

    return { completedRecordedRuns: completed, recalibrationRequired };
  }

  markCalibrated(options: MarkCalibratedOptions): void {
    const actor = options?.actor;
    if (!actor || typeof actor !== "string" || actor.trim() === "") {
      throw new TypeError("actor is required and must be a non-empty string");
    }
    const ts =
      typeof options.ts === "number" && Number.isFinite(options.ts)
        ? Math.floor(options.ts)
        : Date.now();
    const runIds = Array.isArray(options.runIds) ? options.runIds.map((id) => String(id)) : [];

    this.setMeta("recalibrationRequired", false, ts);
    this.setMeta("lastCalibratedAt", ts, ts);
    this.setMeta("lastCalibratedRunIds", runIds, ts);
  }

  private getMetaRaw(key: string): unknown {
    const row = this.getMetaStmt.get(key) as { valueJson?: unknown } | undefined;
    if (!row) {
      return undefined;
    }
    return parseStoredValue(row.valueJson);
  }

  private setMeta(key: string, value: unknown, ts: number): void {
    this.upsertMetaStmt.run(key, JSON.stringify(value ?? null), ts);
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Requirement 30.2: throws when any Required_Setting has no value so the Necromancer refuses
 * to start runs.
 */
export function assertRequiredSettingsConfigured(
  store: SettingsStore,
  options?: { creditsReported?: boolean }
): RequiredSettingsValidation {
  const result = store.validateRequiredSettings(options);
  if (!result.ok) {
    throw new RequiredSettingMissingError(result.missing);
  }
  return result;
}


let defaultSettingsStoreInstance: SettingsStore | null = null;

export function getDefaultSettingsStore(options?: SettingsStoreOptions): SettingsStore {
  const g = globalThis as unknown as { __sharedSettingsStore?: SettingsStore };
  if (g.__sharedSettingsStore) {
    return g.__sharedSettingsStore;
  }
  const store = options?.db
    ? new SettingsStore(options)
    : new SettingsStore({
        ...options,
        path: resolveDefaultSettingsStorePath(options),
      });
  g.__sharedSettingsStore = store;
  defaultSettingsStoreInstance = store;
  return store;
}

export function resetDefaultSettingsStore(): void {
  const g = globalThis as unknown as { __sharedSettingsStore?: SettingsStore };
  const store = g.__sharedSettingsStore ?? defaultSettingsStoreInstance;
  if (store) {
    try {
      if (typeof store.close === "function") {
        store.close();
      }
    } catch {
      // ignore close errors
    }
  }
  g.__sharedSettingsStore = undefined;
  defaultSettingsStoreInstance = null;
}

export function createSettingsStore(
  optionsOrPath?: string | DatabaseSync | SettingsStoreOptions
): SettingsStore {
  return new SettingsStore(optionsOrPath);
}

