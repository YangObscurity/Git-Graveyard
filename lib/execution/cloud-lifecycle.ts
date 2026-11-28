// Cloud sandbox lifecycle management: TTL enforcement, concurrency quotas,
// snapshot prohibition, and artifact/log pull-before-destroy.
// Topology P-B: kiro-cli runs on the production host; Necromancer orchestrates
// outside every cloud sandbox.

import type { SyncResult } from "./sandbox-sync";

/** Default sandbox TTL: 1 hour in milliseconds. */
export const DEFAULT_SANDBOX_TTL_MS = 3_600_000;

/** Renewable hard cap: 24 hours in milliseconds. */
export const MAX_SANDBOX_TTL_MS = 86_400_000;

/**
 * Account concurrency quota: max 5 concurrent runs. Based on the 10-sandbox
 * account quota, reserving room for per-run teardown / Warden overhead.
 */
export const MAX_CONCURRENT_RUNS = 5;

/** Error thrown when snapshot creation is attempted. Snapshots are prohibited. */
export class SnapshotProhibitedError extends Error {
  readonly ok = false as const;
  readonly code = "SNAPSHOT_PROHIBITED" as const;

  constructor(message = "Snapshot creation is prohibited (Requirement 21.16, 43.18)") {
    super(message);
    this.name = "SnapshotProhibitedError";
    Object.setPrototypeOf(this, SnapshotProhibitedError.prototype);
  }
}

/** Error thrown when a TTL or renewal exceeds the 24h hard cap. */
export class TtlCapExceededError extends Error {
  readonly ok = false as const;
  readonly code = "TTL_CAP_EXCEEDED" as const;
  readonly requestedMs: number;
  readonly capMs: number;

  constructor(requestedMs: number, capMs = MAX_SANDBOX_TTL_MS) {
    super(`Requested TTL ${requestedMs}ms exceeds the 24h hard cap of ${capMs}ms`);
    this.name = "TtlCapExceededError";
    this.requestedMs = requestedMs;
    this.capMs = capMs;
    Object.setPrototypeOf(this, TtlCapExceededError.prototype);
  }
}

/** Error thrown when the account concurrency quota would be exceeded. */
export class ConcurrencyQuotaExceededError extends Error {
  readonly ok = false as const;
  readonly code = "CONCURRENCY_QUOTA_EXCEEDED" as const;
  readonly active: number;
  readonly limit: number;

  constructor(active: number, limit = MAX_CONCURRENT_RUNS) {
    super(`Concurrency quota exceeded: ${active} active runs, limit is ${limit}`);
    this.name = "ConcurrencyQuotaExceededError";
    this.active = active;
    this.limit = limit;
    Object.setPrototypeOf(this, ConcurrencyQuotaExceededError.prototype);
  }
}

export interface SandboxLifecycleRecord {
  readonly id: string;
  readonly runId: string;
  readonly createdAt: number;
  /** Absolute expiry timestamp (createdAt + ttlMs), or null if not yet set. */
  expiresAt: number | null;
  ttlMs: number;
  state: "running" | "stopped" | "destroyed" | "expired";
}

export interface PullArtifacts {
  /** Pull workspace files produced in the sandbox back to the host worktree. */
  syncOut?: () => Promise<SyncResult>;
  /** Export logs produced in the sandbox. */
  exportLogs?: () => Promise<void>;
}

export interface DestroyHandle {
  destroy(): Promise<void>;
}

/** Outcome of a pull-and-destroy cycle, including any pull error. */
export interface PullAndDestroyResult {
  readonly id: string;
  readonly destroyed: boolean;
  /** Error raised by syncOut/exportLogs, if any. The sandbox is still destroyed. */
  readonly pullError?: unknown;
}

/**
 * Manages the lifecycle of cloud sandboxes: TTL with 24h hard cap, the 5-run
 * concurrency quota, snapshot prohibition, and artifact/log pull before destroy.
 */
export class CloudSandboxLifecycle {
  private readonly records = new Map<string, SandboxLifecycleRecord>();
  private readonly handles = new Map<string, DestroyHandle>();
  private readonly pullers = new Map<string, PullArtifacts>();
  private readonly runIds = new Set<string>();
  /** Per-record pull errors captured by the most recent expireStale pass. */
  readonly errors = new Map<string, unknown>();

  constructor(
    private readonly options?: {
      defaultTtlMs?: number;
      maxTtlMs?: number;
      maxConcurrentRuns?: number;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.options?.now ? this.options.now() : Date.now();
  }

  private get defaultTtl(): number {
    return this.options?.defaultTtlMs ?? DEFAULT_SANDBOX_TTL_MS;
  }

  private get maxTtl(): number {
    return this.options?.maxTtlMs ?? MAX_SANDBOX_TTL_MS;
  }

  private get maxConcurrent(): number {
    return this.options?.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS;
  }

  /** Number of currently active (running) runs. */
  get activeRunCount(): number {
    return this.runIds.size;
  }

  /**
   * Registers a new sandbox run. Enforces the concurrency quota and applies the
   * default 1h TTL (capped at 24h). Throws ConcurrencyQuotaExceededError when
   * the 5-run limit would be exceeded.
   */
  register(
    id: string,
    runId: string,
    handle?: DestroyHandle,
    pull?: PullArtifacts
  ): SandboxLifecycleRecord {
    if (this.records.has(id)) {
      throw new Error(`Sandbox '${id}' is already registered`);
    }
    if (this.runIds.has(runId)) {
      throw new Error(`Run '${runId}' is already registered`);
    }
    if (this.runIds.size >= this.maxConcurrent) {
      throw new ConcurrencyQuotaExceededError(this.runIds.size, this.maxConcurrent);
    }

    const ttlMs = Math.min(this.defaultTtl, this.maxTtl);
    const createdAt = this.now();
    const record: SandboxLifecycleRecord = {
      id,
      runId,
      createdAt,
      expiresAt: createdAt + ttlMs,
      ttlMs,
      state: "running",
    };
    this.records.set(id, record);
    this.runIds.add(runId);
    if (handle) this.handles.set(id, handle);
    if (pull) this.pullers.set(id, pull);
    return record;
  }

  /**
   * Renews a sandbox's TTL. Refuses any renewal that would push expiry past the
   * 24h hard cap (measured from createdAt), throwing TtlCapExceededError.
   */
  renew(id: string, additionalMs: number): SandboxLifecycleRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Sandbox '${id}' is not registered`);
    }
    if (record.state === "destroyed" || record.state === "expired") {
      throw new Error(`Sandbox '${id}' is no longer active`);
    }
    if (
      typeof additionalMs !== "number" ||
      !Number.isFinite(additionalMs) ||
      additionalMs <= 0
    ) {
      throw new Error("Renewal duration must be a positive number of ms");
    }

    const requestedTtl = record.ttlMs + additionalMs;
    const hardExpiry = record.createdAt + this.maxTtl;
    const currentExpiry = record.expiresAt ?? record.createdAt + record.ttlMs;
    const newExpiry = currentExpiry + additionalMs;

    if (requestedTtl > this.maxTtl || newExpiry > hardExpiry) {
      throw new TtlCapExceededError(requestedTtl, this.maxTtl);
    }

    record.ttlMs = requestedTtl;
    record.expiresAt = newExpiry;
    return record;
  }
/**
   * Expires stale sandboxes whose expiry has passed. Pulls artifacts and logs
   * before destroying, then marks the record expired. Returns the ids expired.
   */
  async expireStale(now = this.now()): Promise<string[]> {
    const expired: string[] = [];
    this.errors.clear();
    for (const record of this.records.values()) {
      if (record.state !== "running") continue;
      if (record.expiresAt !== null && now >= record.expiresAt) {
        // A pull failure must not stop the sweep: destroy the sandbox, record
        // the error for this record, and continue with the remaining records.
        const result = await this.pullAndDestroy(record.id);
        if (result.pullError !== undefined) {
          this.errors.set(record.id, result.pullError);
        }
        record.state = "expired";
        expired.push(record.id);
      }
    }
    return expired;
  }

  /**
   * Prohibits snapshot creation. Always throws SnapshotProhibitedError.
   */
  async snapshot(_id?: string): Promise<never> {
    throw new SnapshotProhibitedError();
  }

  /**
   * Pulls artifacts and logs (syncOut + log export) before destroying a sandbox
   * on run completion or expiry.
   */
  async pullAndDestroy(id: string): Promise<PullAndDestroyResult> {
    let pullError: unknown;
    try {
      const pull = this.pullers.get(id);
      if (pull) {
        if (pull.syncOut) {
          await pull.syncOut();
        }
        if (pull.exportLogs) {
          await pull.exportLogs();
        }
      }
    } catch (err) {
      // Preserve the pull error but still destroy and release the run slot.
      pullError = err;
    } finally {
      await this.destroy(id);
    }
    return { id, destroyed: true, pullError };
  }

  /**
   * Destroys a sandbox and releases its run slot. Does not pull artifacts;
   * callers that need artifacts pulled first should use pullAndDestroy.
   */
  async destroy(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Sandbox '${id}' is not registered`);
    }
    const handle = this.handles.get(id);
    if (handle) {
      await handle.destroy();
    }
    record.state = "destroyed";
    this.runIds.delete(record.runId);
    this.handles.delete(id);
    this.pullers.delete(id);
    // Keep the record so get() can still report the terminal state.
  }

  get(id: string): SandboxLifecycleRecord | undefined {
    return this.records.get(id);
  }

  list(): SandboxLifecycleRecord[] {
    return [...this.records.values()];
  }

  /** Removes a record entirely (e.g. after terminal cleanup). */
  forget(id: string): void {
    const record = this.records.get(id);
    if (record) {
      this.runIds.delete(record.runId);
    }
    this.records.delete(id);
    this.handles.delete(id);
    this.pullers.delete(id);
  }
}