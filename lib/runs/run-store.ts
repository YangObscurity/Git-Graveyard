import { DatabaseSync, StatementSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunPhase } from "../events/types";

export type { RunPhase };

/**
 * Requirement 27.2 / Requirement 32.9 / Requirements Glossary (Run Outcome)
 */
export type RunOutcome =
  | "resurrected"
  | "resurrected_build_only"
  | "partial"
  | "not_resurrected"
  | "healthy_already"
  | "cancelled"
  | "killed"
  | "budget_stopped"
  | "error";

export interface RunRecord {
  runId: string;
  url: string;
  sha: string;
  phase: RunPhase;
  outcome: RunOutcome | null;
  sandboxId: string | null;
  inviteCodeHash: string | null;
  queuePosition: number | null;
  caps: Record<string, unknown> | null;
  pushTargetFork: string | null;
  pushBranch: string | null;
  pushFlag: boolean;
  isPublished: boolean;
  isRemoved: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface CreateRunInput {
  runId: string;
  url: string;
  sha: string;
  phase?: RunPhase;
  outcome?: RunOutcome | null;
  sandboxId?: string | null;
  inviteCodeHash?: string | null;
  inviteCode?: string;
  queuePosition?: number | null;
  caps?: Record<string, unknown> | null;
  pushTargetFork?: string | null;
  pushBranch?: string | null;
  pushFlag?: boolean;
  isPublished?: boolean;
  isRemoved?: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface UpdateRunInput {
  url?: string;
  sha?: string;
  phase?: RunPhase;
  outcome?: RunOutcome | null;
  sandboxId?: string | null;
  inviteCodeHash?: string | null;
  queuePosition?: number | null;
  caps?: Record<string, unknown> | null;
  pushTargetFork?: string | null;
  pushBranch?: string | null;
  pushFlag?: boolean;
  isPublished?: boolean;
  isRemoved?: boolean;
  metadata?: Record<string, unknown> | null;
  updatedAt?: number;
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface ListRunsFilter {
  phase?: RunPhase | RunPhase[];
  outcome?: RunOutcome | RunOutcome[] | null;
  sandboxId?: string;
  isPublished?: boolean;
  isRemoved?: boolean;
  limit?: number;
  offset?: number;
}

export interface RunSandboxRecord {
  runId: string;
  sandboxId: string;
  role: string;
  status: "attached" | "detached" | "lost" | "destroyed";
  createdAt: number;
  updatedAt: number;
}

export interface ApprovedPatternRecord {
  patternId: string;
  runId: string;
  pattern: string;
  command: string | null;
  cwd: string | null;
  skeletonId: string | null;
  approvedBy: string;
  description: string | null;
  createdAt: number;
}

export interface ApprovedPatternInput {
  patternId?: string;
  pattern: string;
  command?: string | null;
  cwd?: string | null;
  skeletonId?: string | null;
  approvedBy?: string;
  description?: string | null;
  createdAt?: number;
}

export interface InviteCodeRecord {
  codeHash: string;
  salt: string;
  expiresAt: number | null;
  allowedRunCount: number;
  usedRunCount: number;
  remainingRunCount: number;
  caps: Record<string, unknown> | null;
  pushFlag: boolean;
  revoked: boolean;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateInviteCodeParams {
  code: string;
  expiresAt?: number | null;
  allowedRunCount?: number;
  caps?: Record<string, unknown> | null;
  pushFlag?: boolean;
  salt?: string;
  label?: string;
}

export interface StoredInviteCodeParams {
  codeHash: string;
  salt: string;
  expiresAt?: number | null;
  allowedRunCount?: number;
  usedRunCount?: number;
  caps?: Record<string, unknown> | null;
  pushFlag?: boolean;
  revoked?: boolean;
  label?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface InviteCodeLookupResult {
  valid: boolean;
  status: "valid" | "expired" | "used_up" | "revoked" | "not_found";
  remainingRunCount: number;
  remainingRuns: number;
  codeHash?: string;
  salt?: string;
  expiresAt?: number | null;
  allowedRunCount?: number;
  usedRunCount?: number;
  caps?: Record<string, unknown> | null;
  pushFlag?: boolean;
  record?: InviteCodeRecord | null;
}

export interface ReconcileResult {
  resume: RunRecord[];
  error: RunRecord[];
  toResume: RunRecord[];
  toMarkError: RunRecord[];
  errors: RunRecord[];
}

export interface ReconcileOptions {
  store?: RunStore;
  activeSandboxIds?: Iterable<string> | Set<string> | string[];
  attachedSandboxIds?: Iterable<string> | Set<string> | string[];
  isSandboxAttached?: (sandboxId: string, run: RunRecord) => boolean;
  backend?: {
    list?: (labels?: Record<string, string>) => unknown;
    get?: (id: string) => unknown;
  };
  resumeQueued?: boolean;
}

export interface LookupInviteCodeOptions {
  store?: RunStore;
  details?: boolean;
}

export interface RunStoreOptions {
  path?: string;
  db?: DatabaseSync;
  busyTimeout?: number;
}

interface RunRow {
  runId: string;
  url: string;
  sha: string;
  phase: string;
  outcome: string | null;
  sandboxId: string | null;
  inviteCodeHash: string | null;
  queuePosition: number | bigint | null;
  caps: string | null;
  pushTargetFork: string | null;
  pushBranch: string | null;
  pushFlag: number | bigint;
  isPublished: number | bigint;
  isRemoved: number | bigint;
  metadata: string | null;
  createdAt: number | bigint;
  updatedAt: number | bigint;
  startedAt: number | bigint | null;
  endedAt: number | bigint | null;
}

interface RunSandboxRow {
  runId: string;
  sandboxId: string;
  role: string;
  status: string;
  createdAt: number | bigint;
  updatedAt: number | bigint;
}

interface ApprovedPatternRow {
  patternId: string;
  runId: string;
  pattern: string;
  command: string | null;
  cwd: string | null;
  skeletonId: string | null;
  approvedBy: string;
  description: string | null;
  createdAt: number | bigint;
}

interface InviteCodeRow {
  codeHash: string;
  salt: string;
  expiresAt: number | bigint | null;
  allowedRunCount: number | bigint;
  usedRunCount: number | bigint;
  caps: string | null;
  pushFlag: number | bigint;
  revoked: number | bigint;
  label: string | null;
  createdAt: number | bigint;
  updatedAt: number | bigint;
}

function parseJsonSafe<T = Record<string, unknown>>(raw: string | null | undefined): T | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToRunRecord(row: RunRow): RunRecord {
  return {
    runId: String(row.runId),
    url: String(row.url),
    sha: String(row.sha),
    phase: row.phase as RunPhase,
    outcome: (row.outcome as RunOutcome) || null,
    sandboxId: row.sandboxId !== null && row.sandboxId !== undefined ? String(row.sandboxId) : null,
    inviteCodeHash:
      row.inviteCodeHash !== null && row.inviteCodeHash !== undefined
        ? String(row.inviteCodeHash)
        : null,
    queuePosition:
      row.queuePosition !== null && row.queuePosition !== undefined
        ? Number(row.queuePosition)
        : null,
    caps: parseJsonSafe(row.caps),
    pushTargetFork:
      row.pushTargetFork !== null && row.pushTargetFork !== undefined
        ? String(row.pushTargetFork)
        : null,
    pushBranch:
      row.pushBranch !== null && row.pushBranch !== undefined ? String(row.pushBranch) : null,
    pushFlag: Boolean(row.pushFlag),
    isPublished: Boolean(row.isPublished),
    isRemoved: Boolean(row.isRemoved),
    metadata: parseJsonSafe(row.metadata),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    startedAt: row.startedAt !== null && row.startedAt !== undefined ? Number(row.startedAt) : null,
    endedAt: row.endedAt !== null && row.endedAt !== undefined ? Number(row.endedAt) : null,
  };
}

function rowToRunSandboxRecord(row: RunSandboxRow): RunSandboxRecord {
  return {
    runId: String(row.runId),
    sandboxId: String(row.sandboxId),
    role: String(row.role),
    status: row.status as "attached" | "detached" | "lost" | "destroyed",
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function rowToApprovedPatternRecord(row: ApprovedPatternRow): ApprovedPatternRecord {
  return {
    patternId: String(row.patternId),
    runId: String(row.runId),
    pattern: String(row.pattern),
    command: row.command !== null && row.command !== undefined ? String(row.command) : null,
    cwd: row.cwd !== null && row.cwd !== undefined ? String(row.cwd) : null,
    skeletonId:
      row.skeletonId !== null && row.skeletonId !== undefined ? String(row.skeletonId) : null,
    approvedBy: String(row.approvedBy),
    description:
      row.description !== null && row.description !== undefined ? String(row.description) : null,
    createdAt: Number(row.createdAt),
  };
}

function rowToInviteCodeRecord(row: InviteCodeRow): InviteCodeRecord {
  const allowed = Number(row.allowedRunCount);
  const used = Number(row.usedRunCount);
  const remaining = Math.max(0, allowed - used);
  return {
    codeHash: String(row.codeHash),
    salt: String(row.salt),
    expiresAt: row.expiresAt !== null && row.expiresAt !== undefined ? Number(row.expiresAt) : null,
    allowedRunCount: allowed,
    usedRunCount: used,
    remainingRunCount: remaining,
    caps: parseJsonSafe(row.caps),
    pushFlag: Boolean(row.pushFlag),
    revoked: Boolean(row.revoked),
    label: row.label !== null && row.label !== undefined ? String(row.label) : null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function generateSalt(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function hashInviteCode(code: string, salt: string): string {
  if (typeof code !== "string" || typeof salt !== "string") {
    throw new TypeError("code and salt must be strings");
  }
  return crypto
    .createHash("sha256")
    .update(`${salt}:${code}`, "utf8")
    .digest("hex");
}

export function timingSafeCompareHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function matchCommandPattern(
  pattern: string,
  command: string | string[]
): boolean {
  if (!pattern) return false;
  const cmdStr = Array.isArray(command) ? command.join(" ") : String(command);
  const cleanCmd = cmdStr.trim();
  const cleanPat = pattern.trim();

  if (cleanPat === cleanCmd) {
    return true;
  }

  // Check RegExp format: /pattern/flags
  const rxMatch = cleanPat.match(/^\/(.+)\/([gimsuy]*)$/);
  if (rxMatch) {
    try {
      const rx = new RegExp(rxMatch[1], rxMatch[2]);
      return rx.test(cleanCmd);
    } catch {
      // fallback
    }
  }

  // Check wildcards * or ?
  if (cleanPat.includes("*") || cleanPat.includes("?")) {
    const rxStr = cleanPat
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const rx = new RegExp(`^${rxStr}$`);
    if (rx.test(cleanCmd)) {
      return true;
    }
  }

  // Prefix match
  if (cleanCmd.startsWith(cleanPat + " ") || cleanCmd.startsWith(cleanPat + "\t")) {
    return true;
  }

  // Argv array match on first element
  if (Array.isArray(command) && command.length > 0 && command[0] === cleanPat) {
    return true;
  }

  return false;
}

function isIterable(val: unknown): val is Iterable<string> {
  return (
    val !== null &&
    typeof val === "object" &&
    Symbol.iterator in (val as object) &&
    typeof (val as Record<symbol, unknown>)[Symbol.iterator] === "function"
  );
}

function isDirectoryWritable(dirPath: string): boolean {
  try {
    if (fs.existsSync(dirPath)) {
      fs.accessSync(dirPath, fs.constants.W_OK);
      return true;
    }
  } catch {
    // not writable or directory does not exist
  }
  return false;
}

function resolveDefaultRunStorePath(options?: RunStoreOptions): string {
  if (options?.path) {
    return options.path;
  }
  if (process.env.RUN_STORE_PATH) {
    return process.env.RUN_STORE_PATH;
  }
  if (isDirectoryWritable("/data")) {
    return "/data/runs.db";
  }
  return path.join(os.tmpdir(), "git-graveyard-data", "runs.db");
}

function detectDbStorageLocation(db: DatabaseSync): {
  dbPath: string;
  storageMode: "memory" | "file";
} {
  try {
    const locFn = (db as unknown as { location?: () => string | null }).location;
    if (typeof locFn === "function") {
      const loc = locFn.call(db);
      if (typeof loc === "string" && loc.length > 0) {
        return { dbPath: loc, storageMode: "file" };
      }
      return { dbPath: ":memory:", storageMode: "memory" };
    }
  } catch {
    // fallback to pragma
  }
  try {
    const rows = db.prepare("PRAGMA database_list").all() as Array<{
      name?: string;
      file?: string;
    }>;
    const main = rows.find((r) => r.name === "main") ?? rows[0];
    if (main && typeof main.file === "string" && main.file.length > 0) {
      return { dbPath: main.file, storageMode: "file" };
    }
  } catch {
    // ignore pragma errors
  }
  return { dbPath: ":memory:", storageMode: "memory" };
}

export class RunStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly dbPath: string;
  private readonly storageMode: "memory" | "file";
  private readonly busyTimeoutMs: number;

  private insertRunStmt!: StatementSync;
  private getRunStmt!: StatementSync;
  private updateRunStmt!: StatementSync;
  private deleteRunStmt!: StatementSync;
  private getLivingRunsStmt!: StatementSync;
  private countRunsStmt!: StatementSync;

  private insertSandboxStmt!: StatementSync;
  private getSandboxStmt!: StatementSync;
  private getRunSandboxesStmt!: StatementSync;
  private updateSandboxStatusStmt!: StatementSync;
  private deleteSandboxStmt!: StatementSync;

  private insertPatternStmt!: StatementSync;
  private getPatternsByRunStmt!: StatementSync;
  private deletePatternStmt!: StatementSync;
  private clearPatternsByRunStmt!: StatementSync;

  private insertInviteCodeStmt!: StatementSync;
  private getInviteCodeByHashStmt!: StatementSync;
  private getAllInviteCodesStmt!: StatementSync;
  private incrementInviteCodeUsedStmt!: StatementSync;
  private revokeInviteCodeStmt!: StatementSync;
  private deleteInviteCodeStmt!: StatementSync;

  constructor(optionsOrPath?: string | DatabaseSync | RunStoreOptions) {
    let busyTimeout = 5000;

    if (optionsOrPath instanceof DatabaseSync) {
      this.db = optionsOrPath;
      this.ownsDb = false;
      const detected = detectDbStorageLocation(this.db);
      this.dbPath = detected.dbPath;
      this.storageMode = detected.storageMode;
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
      this.dbPath = dbPath;
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
        const detected = detectDbStorageLocation(this.db);
        this.dbPath = detected.dbPath;
        this.storageMode = detected.storageMode;
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
        this.dbPath = dbPath;
        this.storageMode = dbPath === ":memory:" ? "memory" : "file";
      }
    } else {
      const dbPath = ":memory:";
      this.db = new DatabaseSync(dbPath);
      this.ownsDb = true;
      this.dbPath = dbPath;
      this.storageMode = "memory";
    }

    this.busyTimeoutMs = busyTimeout;
    this.initSchema();
    this.prepareStatements();
  }

  getStorageMode(): "memory" | "file" {
    return this.storageMode;
  }

  private initSchema(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        runId TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        sha TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'queued',
        outcome TEXT,
        sandboxId TEXT,
        inviteCodeHash TEXT,
        queuePosition INTEGER,
        caps TEXT,
        pushTargetFork TEXT,
        pushBranch TEXT,
        pushFlag INTEGER NOT NULL DEFAULT 0,
        isPublished INTEGER NOT NULL DEFAULT 0,
        isRemoved INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        startedAt INTEGER,
        endedAt INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_runs_phase ON runs (phase);
      CREATE INDEX IF NOT EXISTS idx_runs_outcome ON runs (outcome);
      CREATE INDEX IF NOT EXISTS idx_runs_sandboxId ON runs (sandboxId);
      CREATE INDEX IF NOT EXISTS idx_runs_createdAt ON runs (createdAt);

      CREATE TABLE IF NOT EXISTS run_sandboxes (
        runId TEXT NOT NULL,
        sandboxId TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        status TEXT NOT NULL DEFAULT 'attached',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (runId, sandboxId),
        FOREIGN KEY (runId) REFERENCES runs (runId) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_run_sandboxes_sandboxId ON run_sandboxes (sandboxId);

      CREATE TABLE IF NOT EXISTS run_approved_patterns (
        patternId TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        pattern TEXT NOT NULL,
        command TEXT,
        cwd TEXT,
        skeletonId TEXT,
        approvedBy TEXT NOT NULL DEFAULT 'user',
        description TEXT,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (runId) REFERENCES runs (runId) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_run_approved_patterns_runId ON run_approved_patterns (runId);

      CREATE TABLE IF NOT EXISTS invite_codes (
        codeHash TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        expiresAt INTEGER,
        allowedRunCount INTEGER NOT NULL DEFAULT 1,
        usedRunCount INTEGER NOT NULL DEFAULT 0,
        caps TEXT,
        pushFlag INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        label TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_invite_codes_expiresAt ON invite_codes (expiresAt);
    `);
  }

  private prepareStatements(): void {
    this.insertRunStmt = this.db.prepare(`
      INSERT INTO runs (
        runId, url, sha, phase, outcome, sandboxId, inviteCodeHash, queuePosition,
        caps, pushTargetFork, pushBranch, pushFlag, isPublished, isRemoved,
        metadata, createdAt, updatedAt, startedAt, endedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getRunStmt = this.db.prepare(
      "SELECT * FROM runs WHERE runId = ?"
    );

    this.updateRunStmt = this.db.prepare(`
      UPDATE runs SET
        url = ?, sha = ?, phase = ?, outcome = ?, sandboxId = ?, inviteCodeHash = ?,
        queuePosition = ?, caps = ?, pushTargetFork = ?, pushBranch = ?,
        pushFlag = ?, isPublished = ?, isRemoved = ?, metadata = ?,
        updatedAt = ?, startedAt = ?, endedAt = ?
      WHERE runId = ?
    `);

    this.deleteRunStmt = this.db.prepare(
      "DELETE FROM runs WHERE runId = ?"
    );

    this.getLivingRunsStmt = this.db.prepare(`
      SELECT * FROM runs
      WHERE (outcome IS NULL OR outcome = '') AND phase != 'done'
      ORDER BY createdAt ASC
    `);

    this.countRunsStmt = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM runs"
    );

    this.insertSandboxStmt = this.db.prepare(`
      INSERT INTO run_sandboxes (runId, sandboxId, role, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(runId, sandboxId) DO UPDATE SET
        role = excluded.role,
        status = excluded.status,
        updatedAt = excluded.updatedAt
    `);

    this.getSandboxStmt = this.db.prepare(
      "SELECT * FROM run_sandboxes WHERE runId = ? AND sandboxId = ?"
    );

    this.getRunSandboxesStmt = this.db.prepare(
      "SELECT * FROM run_sandboxes WHERE runId = ? ORDER BY createdAt ASC"
    );

    this.updateSandboxStatusStmt = this.db.prepare(
      "UPDATE run_sandboxes SET status = ?, updatedAt = ? WHERE runId = ? AND sandboxId = ?"
    );

    this.deleteSandboxStmt = this.db.prepare(
      "DELETE FROM run_sandboxes WHERE runId = ? AND sandboxId = ?"
    );

    this.insertPatternStmt = this.db.prepare(`
      INSERT INTO run_approved_patterns (
        patternId, runId, pattern, command, cwd, skeletonId, approvedBy, description, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getPatternsByRunStmt = this.db.prepare(
      "SELECT * FROM run_approved_patterns WHERE runId = ? ORDER BY createdAt ASC"
    );

    this.deletePatternStmt = this.db.prepare(
      "DELETE FROM run_approved_patterns WHERE patternId = ?"
    );

    this.clearPatternsByRunStmt = this.db.prepare(
      "DELETE FROM run_approved_patterns WHERE runId = ?"
    );

    this.insertInviteCodeStmt = this.db.prepare(`
      INSERT INTO invite_codes (
        codeHash, salt, expiresAt, allowedRunCount, usedRunCount, caps, pushFlag, revoked, label, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(codeHash) DO UPDATE SET
        salt = excluded.salt,
        expiresAt = excluded.expiresAt,
        allowedRunCount = excluded.allowedRunCount,
        usedRunCount = excluded.usedRunCount,
        caps = excluded.caps,
        pushFlag = excluded.pushFlag,
        revoked = excluded.revoked,
        label = excluded.label,
        updatedAt = excluded.updatedAt
    `);

    this.getInviteCodeByHashStmt = this.db.prepare(
      "SELECT * FROM invite_codes WHERE codeHash = ?"
    );

    this.getAllInviteCodesStmt = this.db.prepare(
      "SELECT * FROM invite_codes ORDER BY createdAt ASC"
    );

    this.incrementInviteCodeUsedStmt = this.db.prepare(
      "UPDATE invite_codes SET usedRunCount = usedRunCount + 1, updatedAt = ? WHERE codeHash = ?"
    );

    this.revokeInviteCodeStmt = this.db.prepare(
      "UPDATE invite_codes SET revoked = 1, updatedAt = ? WHERE codeHash = ?"
    );

    this.deleteInviteCodeStmt = this.db.prepare(
      "DELETE FROM invite_codes WHERE codeHash = ?"
    );
  }

  createRun(input: CreateRunInput): RunRecord {
    if (!input || typeof input !== "object") {
      throw new TypeError("Run input must be an object");
    }
    if (!input.runId || typeof input.runId !== "string") {
      throw new TypeError("runId is required and must be a non-empty string");
    }
    if (!input.url || typeof input.url !== "string") {
      throw new TypeError("url is required and must be a non-empty string");
    }
    if (!input.sha || typeof input.sha !== "string") {
      throw new TypeError("sha is required and must be a non-empty string");
    }

    const now = Date.now();
    const createdAt = typeof input.createdAt === "number" ? input.createdAt : now;
    const updatedAt = typeof input.updatedAt === "number" ? input.updatedAt : createdAt;
    const phase = input.phase ?? "queued";
    const outcome = input.outcome ?? null;
    const sandboxId = input.sandboxId ?? null;

    let inviteCodeHash = input.inviteCodeHash ?? null;
    if (!inviteCodeHash && input.inviteCode) {
      // Look up code hash from inviteCode
      const details = this.lookupInviteCodeDetails(input.inviteCode);
      if (details.codeHash) {
        inviteCodeHash = details.codeHash;
      }
    }

    const capsJson = input.caps ? JSON.stringify(input.caps) : null;
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    this.insertRunStmt.run(
      input.runId,
      input.url,
      input.sha,
      phase,
      outcome,
      sandboxId,
      inviteCodeHash,
      input.queuePosition ?? null,
      capsJson,
      input.pushTargetFork ?? null,
      input.pushBranch ?? null,
      input.pushFlag ? 1 : 0,
      input.isPublished ? 1 : 0,
      input.isRemoved ? 1 : 0,
      metaJson,
      createdAt,
      updatedAt,
      input.startedAt ?? null,
      input.endedAt ?? null
    );

    if (sandboxId) {
      this.attachSandbox(input.runId, sandboxId, "primary");
    }

    const created = this.getRun(input.runId);
    if (!created) {
      throw new Error(`Failed to retrieve newly created run "${input.runId}"`);
    }
    return created;
  }

  getRun(runId: string): RunRecord | null {
    if (!runId || typeof runId !== "string") {
      return null;
    }
    const row = this.getRunStmt.get(runId) as RunRow | undefined;
    if (!row) {
      return null;
    }
    return rowToRunRecord(row);
  }

  updateRun(runId: string, updates: UpdateRunInput): RunRecord {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run "${runId}" not found`);
    }

    const now = Date.now();
    const url = updates.url ?? existing.url;
    const sha = updates.sha ?? existing.sha;
    const phase = updates.phase ?? existing.phase;
    const outcome = updates.outcome !== undefined ? updates.outcome : existing.outcome;
    const sandboxId = updates.sandboxId !== undefined ? updates.sandboxId : existing.sandboxId;
    const inviteCodeHash =
      updates.inviteCodeHash !== undefined ? updates.inviteCodeHash : existing.inviteCodeHash;
    const queuePosition =
      updates.queuePosition !== undefined ? updates.queuePosition : existing.queuePosition;
    const caps = updates.caps !== undefined ? updates.caps : existing.caps;
    const pushTargetFork =
      updates.pushTargetFork !== undefined ? updates.pushTargetFork : existing.pushTargetFork;
    const pushBranch = updates.pushBranch !== undefined ? updates.pushBranch : existing.pushBranch;
    const pushFlag = updates.pushFlag !== undefined ? updates.pushFlag : existing.pushFlag;
    const isPublished =
      updates.isPublished !== undefined ? updates.isPublished : existing.isPublished;
    const isRemoved = updates.isRemoved !== undefined ? updates.isRemoved : existing.isRemoved;
    const metadata = updates.metadata !== undefined ? updates.metadata : existing.metadata;
    const startedAt = updates.startedAt !== undefined ? updates.startedAt : existing.startedAt;
    const endedAt = updates.endedAt !== undefined ? updates.endedAt : existing.endedAt;
    const updatedAt = updates.updatedAt ?? now;

    const capsJson = caps ? JSON.stringify(caps) : null;
    const metaJson = metadata ? JSON.stringify(metadata) : null;

    this.updateRunStmt.run(
      url,
      sha,
      phase,
      outcome,
      sandboxId,
      inviteCodeHash,
      queuePosition ?? null,
      capsJson,
      pushTargetFork ?? null,
      pushBranch ?? null,
      pushFlag ? 1 : 0,
      isPublished ? 1 : 0,
      isRemoved ? 1 : 0,
      metaJson,
      updatedAt,
      startedAt ?? null,
      endedAt ?? null,
      runId
    );

    if (updates.sandboxId && updates.sandboxId !== existing.sandboxId) {
      this.attachSandbox(runId, updates.sandboxId);
    }

    const updated = this.getRun(runId);
    if (!updated) {
      throw new Error(`Failed to retrieve updated run "${runId}"`);
    }
    return updated;
  }

  deleteRun(runId: string): boolean {
    if (!runId || typeof runId !== "string") {
      return false;
    }
    this.deleteRunStmt.run(runId);
    return true;
  }

  getLivingRuns(): RunRecord[] {
    const rows = this.getLivingRunsStmt.all() as unknown as RunRow[];
    return rows.map(rowToRunRecord);
  }

  listRuns(filter?: ListRunsFilter): RunRecord[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter) {
      if (filter.phase) {
        if (Array.isArray(filter.phase)) {
          if (filter.phase.length > 0) {
            const placeholders = filter.phase.map(() => "?").join(", ");
            conditions.push(`phase IN (${placeholders})`);
            params.push(...filter.phase);
          }
        } else {
          conditions.push("phase = ?");
          params.push(filter.phase);
        }
      }

      if (filter.outcome !== undefined) {
        if (filter.outcome === null) {
          conditions.push("(outcome IS NULL OR outcome = '')");
        } else if (Array.isArray(filter.outcome)) {
          if (filter.outcome.length > 0) {
            const placeholders = filter.outcome.map(() => "?").join(", ");
            conditions.push(`outcome IN (${placeholders})`);
            params.push(...filter.outcome);
          }
        } else {
          conditions.push("outcome = ?");
          params.push(filter.outcome);
        }
      }

      if (filter.sandboxId) {
        conditions.push("sandboxId = ?");
        params.push(filter.sandboxId);
      }

      if (filter.isPublished !== undefined) {
        conditions.push("isPublished = ?");
        params.push(filter.isPublished ? 1 : 0);
      }

      if (filter.isRemoved !== undefined) {
        conditions.push("isRemoved = ?");
        params.push(filter.isRemoved ? 1 : 0);
      }
    }

    let sql = "SELECT * FROM runs";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY createdAt ASC";

    if (filter?.limit && filter.limit > 0) {
      sql += " LIMIT ?";
      params.push(filter.limit);
      if (filter.offset && filter.offset > 0) {
        sql += " OFFSET ?";
        params.push(filter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as unknown as RunRow[];
    return rows.map(rowToRunRecord);
  }

  countRuns(): number {
    const row = this.countRunsStmt.get() as { cnt: number | bigint } | undefined;
    return row ? Number(row.cnt) : 0;
  }

  setPhase(runId: string, phase: RunPhase): RunRecord {
    return this.updateRun(runId, { phase });
  }

  getPhase(runId: string): RunPhase | null {
    const run = this.getRun(runId);
    return run ? run.phase : null;
  }

  setOutcome(runId: string, outcome: RunOutcome, phase: RunPhase = "done"): RunRecord {
    const now = Date.now();
    return this.updateRun(runId, { outcome, phase, endedAt: now });
  }

  getOutcome(runId: string): RunOutcome | null {
    const run = this.getRun(runId);
    return run ? run.outcome : null;
  }

  setSandboxId(runId: string, sandboxId: string | null): RunRecord {
    if (sandboxId) {
      this.attachSandbox(runId, sandboxId);
    }
    return this.updateRun(runId, { sandboxId });
  }

  getSandboxId(runId: string): string | null {
    const run = this.getRun(runId);
    return run ? run.sandboxId : null;
  }

  attachSandbox(runId: string, sandboxId: string, role = "primary"): void {
    if (!runId || !sandboxId) return;
    const now = Date.now();
    this.insertSandboxStmt.run(runId, sandboxId, role, "attached", now, now);
  }

  detachSandbox(runId: string, sandboxId: string): void {
    if (!runId || !sandboxId) return;
    const now = Date.now();
    this.updateSandboxStatusStmt.run("detached", now, runId, sandboxId);
  }

  markSandboxLost(runId: string, sandboxId: string): void {
    if (!runId || !sandboxId) return;
    const now = Date.now();
    this.updateSandboxStatusStmt.run("lost", now, runId, sandboxId);
  }

  getRunSandboxes(runId: string): RunSandboxRecord[] {
    if (!runId) return [];
    const rows = this.getRunSandboxesStmt.all(runId) as unknown as RunSandboxRow[];
    return rows.map(rowToRunSandboxRecord);
  }

  private getSandboxRow(runId: string, sandboxId: string): RunSandboxRow | null {
    const row = this.getSandboxStmt.get(runId, sandboxId) as RunSandboxRow | undefined;
    return row ?? null;
  }

  addApprovedPattern(
    runId: string,
    patternOrInput: string | ApprovedPatternInput
  ): ApprovedPatternRecord {
    if (!runId || typeof runId !== "string") {
      throw new TypeError("runId is required");
    }

    const input: ApprovedPatternInput =
      typeof patternOrInput === "string" ? { pattern: patternOrInput } : patternOrInput;

    if (!input.pattern || typeof input.pattern !== "string") {
      throw new TypeError("pattern is required and must be a non-empty string");
    }

    const now = Date.now();
    const patternId =
      input.patternId ??
      `pat-${now}-${Math.random().toString(36).substring(2, 9)}`;

    this.insertPatternStmt.run(
      patternId,
      runId,
      input.pattern.trim(),
      input.command ?? null,
      input.cwd ?? null,
      input.skeletonId ?? null,
      input.approvedBy ?? "user",
      input.description ?? null,
      input.createdAt ?? now
    );

    return {
      patternId,
      runId,
      pattern: input.pattern.trim(),
      command: input.command ?? null,
      cwd: input.cwd ?? null,
      skeletonId: input.skeletonId ?? null,
      approvedBy: input.approvedBy ?? "user",
      description: input.description ?? null,
      createdAt: input.createdAt ?? now,
    };
  }

  getApprovedPatterns(runId: string): ApprovedPatternRecord[] {
    if (!runId) return [];
    const rows = this.getPatternsByRunStmt.all(runId) as unknown as ApprovedPatternRow[];
    return rows.map(rowToApprovedPatternRecord);
  }

  isPatternApproved(
    runId: string,
    command: string | string[],
    options?: { cwd?: string; skeletonId?: string }
  ): boolean {
    if (!runId || !command) return false;
    const patterns = this.getApprovedPatterns(runId);
    for (const pat of patterns) {
      if (pat.cwd && options?.cwd && pat.cwd !== options.cwd) {
        continue;
      }
      if (pat.skeletonId && options?.skeletonId && pat.skeletonId !== options.skeletonId) {
        continue;
      }
      if (matchCommandPattern(pat.pattern, command)) {
        return true;
      }
    }
    return false;
  }

  removeApprovedPattern(patternId: string): boolean {
    if (!patternId) return false;
    this.deletePatternStmt.run(patternId);
    return true;
  }

  clearApprovedPatterns(runId: string): number {
    if (!runId) return 0;
    const countBefore = this.getApprovedPatterns(runId).length;
    this.clearPatternsByRunStmt.run(runId);
    return countBefore;
  }

  reconcileOnBoot(options?: ReconcileOptions | Iterable<string>): ReconcileResult {
    let attachedIds: Set<string> | null = null;
    let isAttachedFn: ((sandboxId: string, run: RunRecord) => boolean) | null = null;
    let resumeQueued = true;

    if (options) {
      if (isIterable(options)) {
        attachedIds = new Set(options);
      } else {
        if (options.activeSandboxIds) {
          attachedIds = new Set(options.activeSandboxIds);
        } else if (options.attachedSandboxIds) {
          attachedIds = new Set(options.attachedSandboxIds);
        }
        if (options.isSandboxAttached) {
          isAttachedFn = options.isSandboxAttached;
        }
        if (options.resumeQueued !== undefined) {
          resumeQueued = options.resumeQueued;
        }
      }
    }

    const livingRuns = this.getLivingRuns();
    const toResume: RunRecord[] = [];
    const toMarkError: RunRecord[] = [];

    const now = Date.now();

    for (const run of livingRuns) {
      let isAttached = false;

      if (isAttachedFn) {
        isAttached = Boolean(run.sandboxId && isAttachedFn(run.sandboxId, run));
      } else if (attachedIds !== null) {
        isAttached = Boolean(run.sandboxId && attachedIds.has(run.sandboxId));
      } else {
        // No explicit filter passed:
        // Check if sandboxId is present and not explicitly recorded as lost or detached
        if (run.sandboxId) {
          const sb = this.getSandboxRow(run.runId, run.sandboxId);
          isAttached = !sb || sb.status === "attached";
        } else {
          isAttached = false;
        }
      }

      if (isAttached) {
        toResume.push(run);
      } else if (!run.sandboxId && run.phase === "queued" && resumeQueued) {
        // Queued run that has not yet been allocated a sandbox box: resume queue
        toResume.push(run);
      } else {
        // Box lost: terminate living run with outcome error (Requirement 32.9)
        if (run.sandboxId) {
          this.markSandboxLost(run.runId, run.sandboxId);
        }
        const updated = this.updateRun(run.runId, {
          outcome: "error",
          phase: "done",
          endedAt: now,
          updatedAt: now,
        });
        toMarkError.push(updated);
      }
    }

    return {
      resume: toResume,
      error: toMarkError,
      toResume,
      toMarkError,
      errors: toMarkError,
    };
  }

  createInviteCode(params: CreateInviteCodeParams): InviteCodeRecord {
    if (!params || typeof params !== "object") {
      throw new TypeError("params must be an object");
    }
    if (!params.code || typeof params.code !== "string") {
      throw new TypeError("code must be a non-empty string");
    }

    const salt = params.salt ?? generateSalt(16);
    const codeHash = hashInviteCode(params.code.trim(), salt);
    const now = Date.now();
    const allowed =
      typeof params.allowedRunCount === "number" && params.allowedRunCount >= 0
        ? params.allowedRunCount
        : 1;

    const capsJson = params.caps ? JSON.stringify(params.caps) : null;

    this.insertInviteCodeStmt.run(
      codeHash,
      salt,
      params.expiresAt ?? null,
      allowed,
      0,
      capsJson,
      params.pushFlag ? 1 : 0,
      0,
      params.label ?? null,
      now,
      now
    );

    const rec = this.getInviteCodeByHash(codeHash);
    if (!rec) {
      throw new Error(`Failed to create invite code record for hash ${codeHash}`);
    }
    return rec;
  }

  storeHashedInviteCode(params: StoredInviteCodeParams): InviteCodeRecord {
    if (!params || typeof params !== "object") {
      throw new TypeError("params must be an object");
    }
    if (!params.codeHash || typeof params.codeHash !== "string") {
      throw new TypeError("codeHash is required");
    }
    if (!params.salt || typeof params.salt !== "string") {
      throw new TypeError("salt is required");
    }

    const now = Date.now();
    const capsJson = params.caps ? JSON.stringify(params.caps) : null;

    this.insertInviteCodeStmt.run(
      params.codeHash,
      params.salt,
      params.expiresAt ?? null,
      params.allowedRunCount ?? 1,
      params.usedRunCount ?? 0,
      capsJson,
      params.pushFlag ? 1 : 0,
      params.revoked ? 1 : 0,
      params.label ?? null,
      params.createdAt ?? now,
      params.updatedAt ?? now
    );

    const rec = this.getInviteCodeByHash(params.codeHash);
    if (!rec) {
      throw new Error(`Failed to retrieve invite code for hash ${params.codeHash}`);
    }
    return rec;
  }

  getInviteCodeByHash(codeHash: string): InviteCodeRecord | null {
    if (!codeHash || typeof codeHash !== "string") {
      return null;
    }
    const row = this.getInviteCodeByHashStmt.get(codeHash) as InviteCodeRow | undefined;
    if (!row) {
      return null;
    }
    return rowToInviteCodeRecord(row);
  }

  listInviteCodes(): InviteCodeRecord[] {
    const rows = this.getAllInviteCodesStmt.all() as unknown as InviteCodeRow[];
    return rows.map(rowToInviteCodeRecord);
  }

  lookupInviteCode(code: string): number | null {
    if (!code || typeof code !== "string") {
      return null;
    }
    const cleanCode = code.trim();
    if (!cleanCode) {
      return null;
    }

    const rows = this.getAllInviteCodesStmt.all() as unknown as InviteCodeRow[];
    for (const row of rows) {
      const computedHash = hashInviteCode(cleanCode, String(row.salt));
      if (!timingSafeCompareHex(computedHash, String(row.codeHash))) {
        continue;
      }

      const now = Date.now();
      const isExpired =
        row.expiresAt !== null &&
        row.expiresAt !== undefined &&
        now > Number(row.expiresAt);
      const isRevoked = Boolean(row.revoked);
      const allowed = Number(row.allowedRunCount);
      const used = Number(row.usedRunCount);

      if (isExpired || isRevoked) {
        return 0;
      }

      return Math.max(0, allowed - used);
    }

    return null;
  }

  lookupInviteCodeDetails(code: string): InviteCodeLookupResult {
    if (!code || typeof code !== "string") {
      return {
        valid: false,
        status: "not_found",
        remainingRunCount: 0,
        remainingRuns: 0,
      };
    }
    const cleanCode = code.trim();
    if (!cleanCode) {
      return {
        valid: false,
        status: "not_found",
        remainingRunCount: 0,
        remainingRuns: 0,
      };
    }

    const rows = this.getAllInviteCodesStmt.all() as unknown as InviteCodeRow[];
    for (const row of rows) {
      const computedHash = hashInviteCode(cleanCode, String(row.salt));
      if (!timingSafeCompareHex(computedHash, String(row.codeHash))) {
        continue;
      }

      const record = rowToInviteCodeRecord(row);
      const now = Date.now();
      const isExpired =
        row.expiresAt !== null &&
        row.expiresAt !== undefined &&
        now > Number(row.expiresAt);
      const isRevoked = Boolean(row.revoked);
      const allowed = Number(row.allowedRunCount);
      const used = Number(row.usedRunCount);
      const remaining = Math.max(0, allowed - used);

      if (isRevoked) {
        return {
          valid: false,
          status: "revoked",
          remainingRunCount: 0,
          remainingRuns: 0,
          codeHash: record.codeHash,
          salt: record.salt,
          expiresAt: record.expiresAt,
          allowedRunCount: allowed,
          usedRunCount: used,
          caps: record.caps,
          pushFlag: record.pushFlag,
          record,
        };
      }

      if (isExpired) {
        return {
          valid: false,
          status: "expired",
          remainingRunCount: 0,
          remainingRuns: 0,
          codeHash: record.codeHash,
          salt: record.salt,
          expiresAt: record.expiresAt,
          allowedRunCount: allowed,
          usedRunCount: used,
          caps: record.caps,
          pushFlag: record.pushFlag,
          record,
        };
      }

      if (used >= allowed) {
        return {
          valid: false,
          status: "used_up",
          remainingRunCount: 0,
          remainingRuns: 0,
          codeHash: record.codeHash,
          salt: record.salt,
          expiresAt: record.expiresAt,
          allowedRunCount: allowed,
          usedRunCount: used,
          caps: record.caps,
          pushFlag: record.pushFlag,
          record,
        };
      }

      return {
        valid: true,
        status: "valid",
        remainingRunCount: remaining,
        remainingRuns: remaining,
        codeHash: record.codeHash,
        salt: record.salt,
        expiresAt: record.expiresAt,
        allowedRunCount: allowed,
        usedRunCount: used,
        caps: record.caps,
        pushFlag: record.pushFlag,
        record,
      };
    }

    return {
      valid: false,
      status: "not_found",
      remainingRunCount: 0,
      remainingRuns: 0,
    };
  }

  useInviteCode(code: string): boolean {
    if (!code || typeof code !== "string") {
      return false;
    }
    const cleanCode = code.trim();
    const rows = this.getAllInviteCodesStmt.all() as unknown as InviteCodeRow[];
    for (const row of rows) {
      const computedHash = hashInviteCode(cleanCode, String(row.salt));
      if (!timingSafeCompareHex(computedHash, String(row.codeHash))) {
        continue;
      }

      const now = Date.now();
      const isExpired =
        row.expiresAt !== null &&
        row.expiresAt !== undefined &&
        now > Number(row.expiresAt);
      const isRevoked = Boolean(row.revoked);
      const allowed = Number(row.allowedRunCount);
      const used = Number(row.usedRunCount);

      if (isExpired || isRevoked || used >= allowed) {
        return false;
      }

      this.incrementInviteCodeUsedStmt.run(now, row.codeHash);
      return true;
    }
    return false;
  }

  consumeInviteCodeRun(codeHash: string): boolean {
    if (!codeHash) return false;
    const row = this.getInviteCodeByHashStmt.get(codeHash) as InviteCodeRow | undefined;
    if (!row) return false;

    const allowed = Number(row.allowedRunCount);
    const used = Number(row.usedRunCount);
    if (used >= allowed || Boolean(row.revoked)) {
      return false;
    }

    const now = Date.now();
    this.incrementInviteCodeUsedStmt.run(now, codeHash);
    return true;
  }

  revokeInviteCode(codeOrHash: string): boolean {
    if (!codeOrHash) return false;
    const now = Date.now();
    const directRow = this.getInviteCodeByHash(codeOrHash);
    if (directRow) {
      this.revokeInviteCodeStmt.run(now, codeOrHash);
      return true;
    }

    const rows = this.getAllInviteCodesStmt.all() as unknown as InviteCodeRow[];
    for (const row of rows) {
      const computedHash = hashInviteCode(codeOrHash.trim(), String(row.salt));
      if (timingSafeCompareHex(computedHash, String(row.codeHash))) {
        this.revokeInviteCodeStmt.run(now, row.codeHash);
        return true;
      }
    }

    return false;
  }

  deleteInviteCode(codeHash: string): boolean {
    if (!codeHash) return false;
    this.deleteInviteCodeStmt.run(codeHash);
    return true;
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

let defaultRunStoreInstance: RunStore | null = null;

export function getDefaultRunStore(options?: RunStoreOptions): RunStore {
  const g = globalThis as unknown as { __sharedRunStore?: RunStore };
  if (g.__sharedRunStore) {
    return g.__sharedRunStore;
  }
  const store = options?.db
    ? new RunStore(options)
    : new RunStore({
        ...options,
        path: resolveDefaultRunStorePath(options),
      });
  g.__sharedRunStore = store;
  defaultRunStoreInstance = store;
  return store;
}

export function resetDefaultRunStore(): void {
  const g = globalThis as unknown as { __sharedRunStore?: RunStore };
  const store = g.__sharedRunStore ?? defaultRunStoreInstance;
  if (store) {
    try {
      if (typeof store.close === "function") {
        store.close();
      }
    } catch {
      // ignore close errors
    }
  }
  g.__sharedRunStore = undefined;
  defaultRunStoreInstance = null;
}

export function createRunStore(
  optionsOrPath?: string | DatabaseSync | RunStoreOptions
): RunStore {
  return new RunStore(optionsOrPath);
}

export function reconcileOnBoot(
  optionsOrStore?: RunStore | Iterable<string> | ReconcileOptions,
  maybeStore?: RunStore
): ReconcileResult {
  let store: RunStore;
  let attachedIds: Set<string> | null = null;
  let isAttachedFn: ((sandboxId: string, run: RunRecord) => boolean) | null = null;
  let resumeQueued = true;

  if (optionsOrStore instanceof RunStore) {
    store = optionsOrStore;
  } else if (maybeStore instanceof RunStore) {
    store = maybeStore;
    if (optionsOrStore) {
      if (isIterable(optionsOrStore)) {
        attachedIds = new Set(optionsOrStore);
      } else {
        if (optionsOrStore.activeSandboxIds) {
          attachedIds = new Set(optionsOrStore.activeSandboxIds);
        } else if (optionsOrStore.attachedSandboxIds) {
          attachedIds = new Set(optionsOrStore.attachedSandboxIds);
        }
        if (optionsOrStore.isSandboxAttached) {
          isAttachedFn = optionsOrStore.isSandboxAttached;
        }
        if (optionsOrStore.resumeQueued !== undefined) {
          resumeQueued = optionsOrStore.resumeQueued;
        }
      }
    }
  } else if (optionsOrStore && isIterable(optionsOrStore)) {
    attachedIds = new Set(optionsOrStore);
    store = maybeStore ?? getDefaultRunStore();
  } else if (optionsOrStore && typeof optionsOrStore === "object") {
    store = optionsOrStore.store ?? getDefaultRunStore();
    if (optionsOrStore.activeSandboxIds) {
      attachedIds = new Set(optionsOrStore.activeSandboxIds);
    } else if (optionsOrStore.attachedSandboxIds) {
      attachedIds = new Set(optionsOrStore.attachedSandboxIds);
    }
    if (optionsOrStore.isSandboxAttached) {
      isAttachedFn = optionsOrStore.isSandboxAttached;
    }
    if (optionsOrStore.resumeQueued !== undefined) {
      resumeQueued = optionsOrStore.resumeQueued;
    }
  } else {
    store = getDefaultRunStore();
  }

  return store.reconcileOnBoot({
    attachedSandboxIds: attachedIds ?? undefined,
    isSandboxAttached: isAttachedFn ?? undefined,
    resumeQueued,
  });
}

export function lookupInviteCode(
  code: string,
  optionsOrStore?: RunStore | LookupInviteCodeOptions
): number | null {
  const store =
    optionsOrStore instanceof RunStore
      ? optionsOrStore
      : optionsOrStore?.store ?? getDefaultRunStore();
  return store.lookupInviteCode(code);
}

export function lookupInviteCodeDetails(
  code: string,
  store?: RunStore
): InviteCodeLookupResult {
  const s = store ?? getDefaultRunStore();
  return s.lookupInviteCodeDetails(code);
}

export function createInviteCode(
  params: CreateInviteCodeParams,
  store?: RunStore
): InviteCodeRecord {
  const s = store ?? getDefaultRunStore();
  return s.createInviteCode(params);
}
