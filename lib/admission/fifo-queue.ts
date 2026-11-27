// Task 22.2 (part 1): FIFO admission queue.
// Requirements: 31.6, 31.8, 31.9, 31.14.
//
// The queue holds one ordered list of queued runs. Positions are 1-based and always contiguous.
// Every time a run enters the queue or an existing run shifts position the queue appends a redacted
// `run.queue_position` event (and `run.queued` on enqueue) so the live stream reflects the change.

import type { EventStore } from "../events/event-store";
import type { RunStore } from "../runs/run-store";
import { redactEvent } from "../security/redactor";

export interface QueueEntry {
  runId: string;
  url: string | null;
  sha: string | null;
  inviteCodeHash: string | null;
  caps: Record<string, unknown> | null;
  pushFlag: boolean;
  reason: string | null;
  position: number;
  queuedAt: number;
}

export interface EnqueueInput {
  runId: string;
  url?: string | null;
  sha?: string | null;
  inviteCodeHash?: string | null;
  caps?: Record<string, unknown> | null;
  pushFlag?: boolean;
  reason?: string | null;
  queuedAt?: number;
}

export type EnqueueResult =
  | { ok: true; entry: QueueEntry }
  | { ok: false; code: "QUEUE_FULL" | "DUPLICATE"; entry?: QueueEntry };

export interface QueueSnapshot {
  depth: number;
  queueDepth: number;
  entries: QueueEntry[];
}

export interface FifoQueueOptions {
  eventStore: EventStore;
  runStore?: RunStore;
  /** Maximum number of queued runs; defaults to the `QUEUE_DEPTH_CAP` env or 5. */
  queueDepth?: number;
  /** Idle limit in milliseconds; queued runs older than this expire. Defaults to unlimited. */
  queueIdleLimitMs?: number;
  now?: () => number;
  actor?: string;
}

function appendRedacted(
  eventStore: EventStore,
  runId: string,
  kind: string,
  actor: string,
  data: Record<string, unknown>
): void {
  try {
    eventStore.append(
      redactEvent({
        runId,
        kind,
        actor,
        data: { refs: [], ...data },
      })
    );
  } catch {
    // Admission must never break because telemetry could not be written.
  }
}

function resolveDefaultQueueDepth(): number {
  const raw = Number(process.env.QUEUE_DEPTH_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

export class FifoQueue {
  private readonly eventStore: EventStore;
  private readonly runStore?: RunStore;
  private readonly now: () => number;
  private readonly actor: string;
  private readonly queueDepth: number;
  private readonly queueIdleLimitMs: number;
  private entries: QueueEntry[] = [];

  constructor(options: FifoQueueOptions) {
    if (!options || !options.eventStore) {
      throw new TypeError("FifoQueue requires an eventStore");
    }
    this.eventStore = options.eventStore;
    this.runStore = options.runStore;
    this.now = options.now ?? (() => Date.now());
    this.actor = options.actor ?? "necromancer";
    this.queueDepth =
      typeof options.queueDepth === "number" && options.queueDepth > 0
        ? Math.max(1, Math.floor(options.queueDepth))
        : resolveDefaultQueueDepth();
    this.queueIdleLimitMs =
      typeof options.queueIdleLimitMs === "number" && options.queueIdleLimitMs > 0
        ? Math.max(1, Math.floor(options.queueIdleLimitMs))
        : Number.POSITIVE_INFINITY;
  }

  get depth(): number {
    return this.entries.length;
  }

  get cap(): number {
    return this.queueDepth;
  }

  get idleLimitMs(): number {
    return this.queueIdleLimitMs;
  }

  /** Appends a run to the tail. Rejects a full queue (`QUEUE_FULL`) or a duplicate run id. */
  enqueue(input: EnqueueInput): EnqueueResult {
    if (!input || typeof input.runId !== "string" || input.runId.trim().length === 0) {
      throw new TypeError("enqueue requires a non-empty runId");
    }
    const runId = input.runId.trim();

    const existing = this.entries.find((entry) => entry.runId === runId);
    if (existing) {
      return { ok: false, code: "DUPLICATE", entry: { ...existing } };
    }
    if (this.entries.length >= this.queueDepth) {
      return { ok: false, code: "QUEUE_FULL" };
    }

    const entry: QueueEntry = {
      runId,
      url: input.url ?? null,
      sha: input.sha ?? null,
      inviteCodeHash: input.inviteCodeHash ?? null,
      caps: input.caps ?? null,
      pushFlag: input.pushFlag === true,
      reason: input.reason ?? null,
      position: this.entries.length + 1,
      queuedAt: typeof input.queuedAt === "number" ? input.queuedAt : this.now(),
    };
    // Capture the pre-enqueue positions so runs that keep their position emit no event.
    const previous = this.positionMap();
    this.entries.push(entry);

    appendRedacted(this.eventStore, runId, "run.queued", this.actor, {
      queuePosition: entry.position,
      url: entry.url,
      sha: entry.sha,
      reason: entry.reason,
    });

    this.reindexAndEmit(previous);
    return { ok: true, entry: { ...entry } };
  }

  /** Removes and returns the head of the queue, emitting `run.queue_position` for shifted runs. */
  dequeue(): QueueEntry | null {
    if (this.entries.length === 0) {
      return null;
    }
    const previous = this.positionMap();
    const [head] = this.entries.splice(0, 1);
    this.reindexAndEmit(previous);
    return { ...head };
  }

  /** Removes a specific run, emitting `run.queue_position` for shifted runs. */
  remove(runId: string): QueueEntry | null {
    const index = this.entries.findIndex((entry) => entry.runId === runId);
    if (index < 0) {
      return null;
    }
    const previous = this.positionMap();
    const [removed] = this.entries.splice(index, 1);
    this.reindexAndEmit(previous);
    return { ...removed };
  }

  /** Moves a run to a new 1-based position, clamping into range (Requirement 31.14). */
  move(runId: string, newPosition: number): QueueEntry | null {
    const index = this.entries.findIndex((entry) => entry.runId === runId);
    if (index < 0) {
      return null;
    }
    const previous = this.positionMap();
    const [entry] = this.entries.splice(index, 1);
    const target = Math.min(
      Math.max(1, Math.floor(newPosition) || 1),
      this.entries.length + 1
    );
    this.entries.splice(target - 1, 0, entry);
    this.reindexAndEmit(previous);
    const settled = this.entries.find((item) => item.runId === runId);
    return settled ? { ...settled } : null;
  }

  /** Cancels a queued run: removes it and marks the run cancelled when a RunStore is present. */
  cancel(runId: string): QueueEntry | null {
    const removed = this.remove(runId);
    if (!removed) {
      return null;
    }
    const at = this.now();
    if (this.runStore) {
      try {
        this.runStore.updateRun(runId, {
          phase: "done",
          outcome: "cancelled",
          queuePosition: null,
          endedAt: at,
        });
      } catch {
        // A missing run record must not prevent cancellation of its queue entry.
      }
    }
    // Mirror `evictIdle`: a cancelled run must not stay stuck as `phase: "queued"`, so emit the
    // terminal phase/done events the rest of the system listens for.
    appendRedacted(this.eventStore, runId, "run.phase", this.actor, {
      phase: "done",
      reason: "cancelled",
    });
    appendRedacted(this.eventStore, runId, "run.done", this.actor, {
      phase: "done",
      outcome: "cancelled",
      endedAt: at,
      reason: "cancelled",
    });
    return removed;
  }

  /** Immutable copy of the current entries in FIFO order. */
  list(): QueueEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  snapshot(): QueueSnapshot {
    return {
      depth: this.entries.length,
      queueDepth: this.queueDepth,
      entries: this.list(),
    };
  }

  getPosition(runId: string): number | null {
    const entry = this.entries.find((item) => item.runId === runId);
    return entry ? entry.position : null;
  }

  has(runId: string): boolean {
    return this.entries.some((entry) => entry.runId === runId);
  }

  /**
   * Expires every queued run idle for at least `queueIdleLimitMs` (Requirement 31.9) and emits
   * `run.queue_position` for the runs that shift up as a result.
   */
  evictIdle(now?: number): QueueEntry[] {
    if (!Number.isFinite(this.queueIdleLimitMs)) {
      return [];
    }
    const at = typeof now === "number" ? now : this.now();
    const previous = this.positionMap();
    const expired: QueueEntry[] = [];
    const kept: QueueEntry[] = [];
    for (const entry of this.entries) {
      if (at - entry.queuedAt >= this.queueIdleLimitMs) {
        expired.push({ ...entry });
      } else {
        kept.push(entry);
      }
    }
    if (expired.length === 0) {
      return [];
    }
    this.entries = kept;
    // Expired queue items must not stay stuck as `phase: "queued"`: finalize the run row and emit
    // the terminal events the rest of the system listens for.
    for (const entry of expired) {
      if (this.runStore) {
        try {
          this.runStore.updateRun(entry.runId, {
            phase: "done",
            outcome: "cancelled",
            queuePosition: null,
            endedAt: at,
          });
        } catch {
          // A missing run record must not prevent eviction of its queue entry.
        }
      }
      appendRedacted(this.eventStore, entry.runId, "run.phase", this.actor, {
        phase: "done",
        reason: "queue_idle_timeout",
      });
      appendRedacted(this.eventStore, entry.runId, "run.done", this.actor, {
        phase: "done",
        outcome: "cancelled",
        endedAt: at,
        reason: "queue_idle_timeout",
      });
    }
    this.reindexAndEmit(previous);
    return expired;
  }

  clear(): void {
    const previous = this.positionMap();
    this.entries = [];
    this.reindexAndEmit(previous);
  }

  private positionMap(): Map<string, number> {
    const map = new Map<string, number>();
    for (const entry of this.entries) {
      map.set(entry.runId, entry.position);
    }
    return map;
  }

  private reindexAndEmit(previous: Map<string, number>): void {
    this.entries.forEach((entry, index) => {
      const position = index + 1;
      entry.position = position;
      const changed = previous.get(entry.runId) !== position;
      if (changed) {
        appendRedacted(this.eventStore, entry.runId, "run.queue_position", this.actor, {
          queuePosition: position,
          reason: entry.reason,
        });
      }
      if (this.runStore && changed) {
        try {
          this.runStore.updateRun(entry.runId, { queuePosition: position });
        } catch {
          // Ignore missing run rows; the queue remains authoritative for positions.
        }
      }
    });
  }
}

const queueRegistry = globalThis as unknown as {
  __fifoQueues?: WeakMap<object, FifoQueue>;
};

/**
 * Returns the process-wide {@link FifoQueue} bound to a particular `EventStore` so that successive
 * Admin route calls observe the same queue while distinct stores (tests, other processes) stay
 * isolated.
 */
export function resolveFifoQueue(options: FifoQueueOptions): FifoQueue {
  if (!queueRegistry.__fifoQueues) {
    queueRegistry.__fifoQueues = new WeakMap<object, FifoQueue>();
  }
  const key = options.eventStore as unknown as object;
  const existing = queueRegistry.__fifoQueues.get(key);
  if (existing) {
    return existing;
  }
  const queue = new FifoQueue(options);
  queueRegistry.__fifoQueues.set(key, queue);
  return queue;
}

/** Clears the process-wide queue registry (used by tests between fixtures). */
export function resetFifoQueueRegistry(): void {
  queueRegistry.__fifoQueues = new WeakMap<object, FifoQueue>();
}

