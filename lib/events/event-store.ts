import { DatabaseSync, StatementSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventData, EventEnvelope, EventKind, EvidenceRef } from "./types";

export type { EventData, EventEnvelope, EventKind, EvidenceRef };

export interface EventInput {
  runId: string;
  kind: EventKind;
  actor: string;
  data?: Partial<EventData> | Record<string, unknown>;
  ts?: number;
  seq?: number;
  skeletonId?: string | null;
  taskId?: string | null;
  attempt?: number | null;
}

export interface RedactionEventInput {
  runId: string;
  actor?: string;
  ts?: number;
  data?: Partial<EventData> | Record<string, unknown>;
  skeletonId?: string | null;
  taskId?: string | null;
  attempt?: number | null;
}

export interface GetEventsOptions {
  from?: number;
  to?: number;
  afterSeq?: number;
  kind?: string | string[];
  kinds?: string[];
  limit?: number;
}

export interface EventStoreOptions {
  path?: string;
  db?: DatabaseSync;
  busyTimeout?: number;
}

interface EventRow {
  runId: string;
  seq: number | bigint;
  ts: number | bigint;
  kind: string;
  actor: string;
  data: string;
  skeletonId: string | null;
  taskId: string | null;
  attempt: number | bigint | null;
}

function normalizeEventData(rawData: unknown): EventData {
  let refs: EvidenceRef[] = [];
  let extra: Record<string, unknown> = {};

  if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
    extra = { ...(rawData as Record<string, unknown>) };
    if (Array.isArray(extra.refs)) {
      refs = extra.refs.map((r) => String(r));
    }
  }

  return {
    ...extra,
    refs,
  };
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  let data: EventData;
  try {
    const parsed = JSON.parse(row.data);
    data = normalizeEventData(parsed);
  } catch {
    data = { refs: [] };
  }

  const envelope: EventEnvelope = {
    runId: String(row.runId),
    seq: Number(row.seq),
    ts: Number(row.ts),
    kind: String(row.kind),
    actor: String(row.actor),
    data,
  };

  if (row.skeletonId !== null && row.skeletonId !== undefined) {
    envelope.skeletonId = String(row.skeletonId);
  }
  if (row.taskId !== null && row.taskId !== undefined) {
    envelope.taskId = String(row.taskId);
  }
  if (row.attempt !== null && row.attempt !== undefined) {
    envelope.attempt = Number(row.attempt);
  }

  return envelope;
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

export class EventStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly dbPath: string;
  private readonly storageMode: "memory" | "file";
  private readonly busyTimeoutMs: number;

  private maxSeqStmt!: StatementSync;
  private insertStmt!: StatementSync;
  private getEventStmt!: StatementSync;
  private countByRunStmt!: StatementSync;
  private countAllStmt!: StatementSync;
  private getRunIdsStmt!: StatementSync;

  constructor(optionsOrPath?: string | DatabaseSync | EventStoreOptions) {
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
      CREATE TABLE IF NOT EXISTS events (
        runId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        data TEXT NOT NULL,
        skeletonId TEXT,
        taskId TEXT,
        attempt INTEGER,
        PRIMARY KEY (runId, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_run_kind ON events (runId, kind);

      CREATE TRIGGER IF NOT EXISTS prevent_events_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'Updates are forbidden on events table');
      END;

      CREATE TRIGGER IF NOT EXISTS prevent_events_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'Deletions are forbidden on events table');
      END;

      CREATE TRIGGER IF NOT EXISTS prevent_events_replace
      BEFORE INSERT ON events
      WHEN EXISTS (SELECT 1 FROM events WHERE runId = NEW.runId AND seq = NEW.seq)
      BEGIN
        SELECT RAISE(ABORT, 'Replacing existing event row is forbidden');
      END;
    `);
  }

  private prepareStatements(): void {
    this.maxSeqStmt = this.db.prepare(
      "SELECT MAX(seq) AS maxSeq FROM events WHERE runId = ?"
    );
    this.insertStmt = this.db.prepare(`
      INSERT INTO events (runId, seq, ts, kind, actor, data, skeletonId, taskId, attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getEventStmt = this.db.prepare(
      "SELECT runId, seq, ts, kind, actor, data, skeletonId, taskId, attempt FROM events WHERE runId = ? AND seq = ?"
    );
    this.countByRunStmt = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM events WHERE runId = ?"
    );
    this.countAllStmt = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM events"
    );
    this.getRunIdsStmt = this.db.prepare(
      "SELECT DISTINCT runId FROM events ORDER BY runId ASC"
    );
  }

  append(input: EventInput): EventEnvelope {
    if (!input || typeof input !== "object") {
      throw new TypeError("Event input must be an object");
    }
    if (!input.runId || typeof input.runId !== "string") {
      throw new TypeError("runId is required and must be a non-empty string");
    }
    if (!input.kind || typeof input.kind !== "string") {
      throw new TypeError("kind is required and must be a non-empty string");
    }
    if (!input.actor || typeof input.actor !== "string") {
      throw new TypeError("actor is required and must be a non-empty string");
    }

    const ts = typeof input.ts === "number" && !Number.isNaN(input.ts) ? input.ts : Date.now();
    const data = normalizeEventData(input.data);
    const serializedData = JSON.stringify(data);

    const inTx = this.db.isTransaction;
    if (!inTx) {
      this.db.exec("BEGIN IMMEDIATE");
    } else {
      this.db.exec("SAVEPOINT append_event");
    }

    let seq: number;
    try {
      const row = this.maxSeqStmt.get(input.runId) as { maxSeq: number | bigint | null } | undefined;
      const currentMax = row && row.maxSeq !== null && row.maxSeq !== undefined ? Number(row.maxSeq) : 0;
      seq = currentMax + 1;

      this.insertStmt.run(
        input.runId,
        seq,
        ts,
        input.kind,
        input.actor,
        serializedData,
        input.skeletonId ?? null,
        input.taskId ?? null,
        input.attempt !== undefined && input.attempt !== null ? Number(input.attempt) : null
      );

      if (!inTx) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec("RELEASE SAVEPOINT append_event");
      }
    } catch (err) {
      if (!inTx) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore rollback error
        }
      } else {
        try {
          this.db.exec("ROLLBACK TO SAVEPOINT append_event");
        } catch {
          // ignore rollback error
        }
      }
      throw err;
    }

    const envelope: EventEnvelope = {
      runId: input.runId,
      seq,
      ts,
      kind: input.kind,
      actor: input.actor,
      data,
    };

    if (input.skeletonId !== undefined && input.skeletonId !== null) {
      envelope.skeletonId = input.skeletonId;
    }
    if (input.taskId !== undefined && input.taskId !== null) {
      envelope.taskId = input.taskId;
    }
    if (input.attempt !== undefined && input.attempt !== null) {
      envelope.attempt = Number(input.attempt);
    }

    return envelope;
  }

  appendBatch(inputs: EventInput[]): EventEnvelope[] {
    return this.insertInputsBatch(inputs, false);
  }

  /**
   * Appends pre-sequenced recorded events preserving valid positive integer `seq`
   * values when supplied (falling back to maxSeq + 1 otherwise).
   */
  appendRecordedBatch(inputs: EventInput[]): EventEnvelope[] {
    return this.insertInputsBatch(inputs, true);
  }

  private insertInputsBatch(inputs: EventInput[], preserveSeq: boolean): EventEnvelope[] {
    if (!Array.isArray(inputs)) {
      throw new TypeError("inputs must be an array");
    }
    if (inputs.length === 0) {
      return [];
    }

    const inTx = this.db.isTransaction;
    if (!inTx) {
      this.db.exec("BEGIN IMMEDIATE");
    } else {
      this.db.exec("SAVEPOINT append_batch");
    }

    const results: EventEnvelope[] = [];
    try {
      const maxSeqByRun = new Map<string, number>();

      for (const input of inputs) {
        if (!input || typeof input !== "object") {
          throw new TypeError("Event input must be an object");
        }
        if (!input.runId || typeof input.runId !== "string") {
          throw new TypeError("runId is required and must be a non-empty string");
        }
        if (!input.kind || typeof input.kind !== "string") {
          throw new TypeError("kind is required and must be a non-empty string");
        }
        if (!input.actor || typeof input.actor !== "string") {
          throw new TypeError("actor is required and must be a non-empty string");
        }

        let currentMax = maxSeqByRun.get(input.runId);
        if (currentMax === undefined) {
          const row = this.maxSeqStmt.get(input.runId) as { maxSeq: number | bigint | null } | undefined;
          currentMax = row && row.maxSeq !== null && row.maxSeq !== undefined ? Number(row.maxSeq) : 0;
        }

        const seq =
          preserveSeq &&
          typeof input.seq === "number" &&
          Number.isInteger(input.seq) &&
          input.seq > 0
            ? input.seq
            : currentMax + 1;
        maxSeqByRun.set(input.runId, Math.max(currentMax, seq));

        const ts = typeof input.ts === "number" && !Number.isNaN(input.ts) ? input.ts : Date.now();
        const data = normalizeEventData(input.data);
        const serializedData = JSON.stringify(data);

        this.insertStmt.run(
          input.runId,
          seq,
          ts,
          input.kind,
          input.actor,
          serializedData,
          input.skeletonId ?? null,
          input.taskId ?? null,
          input.attempt !== undefined && input.attempt !== null ? Number(input.attempt) : null
        );

        const envelope: EventEnvelope = {
          runId: input.runId,
          seq,
          ts,
          kind: input.kind,
          actor: input.actor,
          data,
        };
        if (input.skeletonId !== undefined && input.skeletonId !== null) {
          envelope.skeletonId = input.skeletonId;
        }
        if (input.taskId !== undefined && input.taskId !== null) {
          envelope.taskId = input.taskId;
        }
        if (input.attempt !== undefined && input.attempt !== null) {
          envelope.attempt = Number(input.attempt);
        }

        results.push(envelope);
      }

      if (!inTx) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec("RELEASE SAVEPOINT append_batch");
      }
    } catch (err) {
      if (!inTx) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore rollback error
        }
      } else {
        try {
          this.db.exec("ROLLBACK TO SAVEPOINT append_batch");
        } catch {
          // ignore rollback error
        }
      }
      throw err;
    }

    return results;
  }

  appendRedaction(
    runIdOrInput: string | RedactionEventInput,
    data?: Partial<EventData> | Record<string, unknown>,
    options?: {
      actor?: string;
      ts?: number;
      skeletonId?: string | null;
      taskId?: string | null;
      attempt?: number | null;
    }
  ): EventEnvelope {
    if (typeof runIdOrInput === "string") {
      return this.append({
        runId: runIdOrInput,
        kind: "admin.redaction",
        actor: options?.actor ?? "admin",
        ts: options?.ts,
        data: data ?? {},
        skeletonId: options?.skeletonId,
        taskId: options?.taskId,
        attempt: options?.attempt,
      });
    }

    return this.append({
      runId: runIdOrInput.runId,
      kind: "admin.redaction",
      actor: runIdOrInput.actor ?? "admin",
      ts: runIdOrInput.ts,
      data: runIdOrInput.data ?? data ?? {},
      skeletonId: runIdOrInput.skeletonId,
      taskId: runIdOrInput.taskId,
      attempt: runIdOrInput.attempt,
    });
  }

  private buildSelectQuery(
    runId: string,
    options?: GetEventsOptions
  ): { sql: string; params: Array<string | number> } {
    if (!runId || typeof runId !== "string") {
      throw new TypeError("runId is required and must be a non-empty string");
    }

    const conditions: string[] = ["runId = ?"];
    const params: Array<string | number> = [runId];

    if (options) {
      if (typeof options.from === "number" && !Number.isNaN(options.from)) {
        conditions.push("seq >= ?");
        params.push(options.from);
      }
      if (typeof options.to === "number" && !Number.isNaN(options.to)) {
        conditions.push("seq <= ?");
        params.push(options.to);
      }
      if (typeof options.afterSeq === "number" && !Number.isNaN(options.afterSeq)) {
        conditions.push("seq > ?");
        params.push(options.afterSeq);
      }
      if (options.kind) {
        if (Array.isArray(options.kind)) {
          if (options.kind.length > 0) {
            const placeholders = options.kind.map(() => "?").join(", ");
            conditions.push(`kind IN (${placeholders})`);
            params.push(...options.kind);
          }
        } else if (typeof options.kind === "string") {
          conditions.push("kind = ?");
          params.push(options.kind);
        }
      } else if (options.kinds && options.kinds.length > 0) {
        const placeholders = options.kinds.map(() => "?").join(", ");
        conditions.push(`kind IN (${placeholders})`);
        params.push(...options.kinds);
      }
    }

    let sql = `SELECT runId, seq, ts, kind, actor, data, skeletonId, taskId, attempt FROM events WHERE ${conditions.join(" AND ")} ORDER BY seq ASC`;

    if (options && typeof options.limit === "number" && options.limit > 0) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    return { sql, params };
  }

  getEvents(runId: string, options?: GetEventsOptions): EventEnvelope[] {
    const { sql, params } = this.buildSelectQuery(runId, options);
    const rows = this.db.prepare(sql).all(...params) as unknown as EventRow[];
    return rows.map(rowToEnvelope);
  }

  *iterateEvents(runId: string, options?: GetEventsOptions): IterableIterator<EventEnvelope> {
    const { sql, params } = this.buildSelectQuery(runId, options);
    const stmt = this.db.prepare(sql);
    for (const row of stmt.iterate(...params)) {
      yield rowToEnvelope(row as unknown as EventRow);
    }
  }

  getEvent(runId: string, seq: number): EventEnvelope | null {
    if (!runId || typeof runId !== "string") {
      throw new TypeError("runId is required and must be a non-empty string");
    }
    const row = this.getEventStmt.get(runId, seq) as unknown as EventRow | undefined;
    if (!row) {
      return null;
    }
    return rowToEnvelope(row);
  }

  getLatestSeq(runId: string): number {
    if (!runId || typeof runId !== "string") {
      throw new TypeError("runId is required and must be a non-empty string");
    }
    const row = this.maxSeqStmt.get(runId) as { maxSeq: number | bigint | null } | undefined;
    return row && row.maxSeq !== null && row.maxSeq !== undefined ? Number(row.maxSeq) : 0;
  }

  getRunIds(): string[] {
    const rows = this.getRunIdsStmt.all() as unknown as Array<{ runId: string }>;
    return rows.map((r) => String(r.runId));
  }

  countEvents(runId?: string): number {
    if (runId !== undefined) {
      const row = this.countByRunStmt.get(runId) as { cnt: number | bigint } | undefined;
      return row ? Number(row.cnt) : 0;
    }
    const row = this.countAllStmt.get() as { cnt: number | bigint } | undefined;
    return row ? Number(row.cnt) : 0;
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

let defaultEventStoreInstance: EventStore | null = null;

export function getDefaultEventStore(options?: EventStoreOptions): EventStore {
  const g = globalThis as unknown as { __sharedEventStore?: EventStore };
  if (g.__sharedEventStore) {
    return g.__sharedEventStore;
  }
  const resolvedPath =
    options?.path ??
    process.env.EVENT_STORE_PATH ??
    process.env.RUN_STORE_PATH ??
    (isDirectoryWritable("/data")
      ? "/data/events.db"
      : path.join(os.tmpdir(), "git-graveyard-data", "events.db"));

  const store = options?.db
    ? new EventStore(options)
    : new EventStore({
        ...options,
        path: resolvedPath,
      });
  g.__sharedEventStore = store;
  defaultEventStoreInstance = store;
  return store;
}

export function resetDefaultEventStore(): void {
  const g = globalThis as unknown as {
    __sharedEventStore?: EventStore;
    __sharedEventTap?: unknown;
  };
  const store = g.__sharedEventStore ?? defaultEventStoreInstance;
  if (store) {
    try {
      if (typeof store.close === "function") {
        store.close();
      }
    } catch {
      // ignore close errors
    }
  }
  g.__sharedEventStore = undefined;
  g.__sharedEventTap = undefined;
  defaultEventStoreInstance = null;
}

export function createEventStore(
  optionsOrPath?: string | DatabaseSync | EventStoreOptions
): EventStore {
  return new EventStore(optionsOrPath);
}
