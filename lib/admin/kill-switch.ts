// Task 22.5: Kill switch with three levels.
// Requirements: 39.10, 39.11, 44.11/XR-02.
//
// Every level reports exactly which runs it affects before it acts (`preview`) and records a
// redacted `admin.kill` event when it does act (`execute`).

import type { EventStore } from "../events/event-store";
import type { RunRecord, RunStore } from "../runs/run-store";
import { redactEvent } from "../security/redactor";

export type KillSwitchLevel = "pause_new_runs" | "stop_gracefully" | "hard_kill";

export const KILL_SWITCH_LEVELS: readonly KillSwitchLevel[] = [
  "pause_new_runs",
  "stop_gracefully",
  "hard_kill",
];

const SYSTEM_RUN_ID = "system";

/** Normalizes a possibly-missing/negative count to a non-negative integer, matching the modal. */
function normalizeRunCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * The exact phrase an operator must type before a level can be executed. It states the
 * number of active and queued runs the action affects, so the confirmation cannot be given
 * without reading the current blast radius. The Admin route recomputes this from the live
 * preview and rejects a request whose `confirm` string does not match, so a stale phrase can
 * never execute a larger kill than the operator confirmed.
 */
export function killSwitchConfirmationPhrase(
  level: KillSwitchLevel,
  activeRunCount: number | undefined,
  queuedRunCount: number | undefined
): string {
  const active = normalizeRunCount(activeRunCount);
  const queued = normalizeRunCount(queuedRunCount);
  switch (level) {
    case "pause_new_runs":
      return `PAUSE ${queued} QUEUED`;
    case "stop_gracefully":
      return `STOP ${active} RUNNING`;
    case "hard_kill":
      return `KILL ${active} ACTIVE ${queued} QUEUED`;
    default:
      return "KILL 0 ACTIVE 0 QUEUED";
  }
}

export interface KillSwitchPreview {
  level: KillSwitchLevel;
  affectedRunCount: number;
  affectedRunIds: string[];
  summary: string;
}

export interface KillSwitchExecuteOptions {
  actor: string;
  reason?: string;
}

export interface KillSwitchResult extends KillSwitchPreview {
  executed: true;
  executedAt: number;
  actor: string;
  reason: string | null;
  /**
   * IDs of runs whose live runtime control (`stopRun` / `killRun`) rejected. Empty when every
   * collected control settled successfully. A non-empty list means the level did not fully take
   * effect for those runs, so the caller must surface a retryable failure (HTTP 500) instead of a
   * success and can target exactly those runs on a follow-up execution.
   */
  failedRunIds: string[];
  /**
   * Resolves once every asynchronous runtime control (`stopRun` / `killRun`) collected during
   * `execute` has settled. `execute` stays synchronous for its existing callers; a caller that must
   * wait for the live RuntimeHost / RunOrchestrator (the Admin route) awaits this (or `executeLive`).
   */
  waitForRuntime?: () => Promise<void>;
}

export interface KillSwitchQueueHook {
  cancel(runId: string): unknown;
  remove(runId: string): unknown;
}

/**
 * Live process controls the kill switch can drive in addition to mutating the RunStore: the shared
 * RuntimeHost admission surface and the active RunOrchestrator. Every hook is optional so an
 * isolated unit test (or a process without a live orchestrator) keeps working unchanged.
 */
export interface KillSwitchRuntimeControls {
  pauseAdmission?: () => void;
  resumeAdmission?: () => void;
  pauseHost?: () => void;
  stopRun?: (runId: string, reason?: string) => void | Promise<void>;
  /**
   * Boundary-aware stop: ends a run at its next tool boundary without aborting the in-flight
   * worker turn or deleting its worktree. Preferred over {@link stopRun} for `stop_gracefully`;
   * `stopRun` (which aborts and cleans up worktrees) is only the fallback for a process that does
   * not expose the graceful control.
   */
  stopRunGracefully?: (runId: string, reason?: string) => void | Promise<void>;
  killRun?: (runId: string, reason?: string) => void | Promise<void>;
  cancelQueuedRun?: (runId: string) => boolean;
  /**
   * Removes a queued run from the live orchestrator queue WITHOUT cancelling its record (it only
   * clears the run's queue membership). Preferred over {@link cancelQueuedRun} for `hard_kill`,
   * because `cancelQueuedRun` overwrites the terminal `outcome` with `"cancelled"` and emits a
   * contradictory `run.phase` event that would clobber the `"killed"` outcome.
   */
  removeQueuedRun?: (runId: string) => boolean;
}

export interface KillSwitchOptions {
  runStore: RunStore;
  eventStore: EventStore;
  queue?: KillSwitchQueueHook | null;
  now?: () => number;
  runtimeControls?: KillSwitchRuntimeControls | null;
}

export interface KillSwitchState {
  pausedNewRuns: boolean;
  stoppingGracefully: boolean;
  lastLevel: KillSwitchLevel | null;
  lastExecutedAt: number | null;
}

/**
 * One asynchronous runtime termination collected by {@link KillSwitchService.execute}: the promise
 * must settle before the execution is considered complete. `finalizeKilled` records whether a
 * successful settle should also mark the run `"killed"` in the `RunStore` (hard kill of an active
 * run), so a rejected control leaves the run retryable.
 */
interface PendingRuntimeControl {
  runId: string;
  promise: Promise<void>;
  finalizeKilled: boolean;
}

function isQueued(run: RunRecord): boolean {
  return run.phase === "queued";
}

function isActive(run: RunRecord): boolean {
  return run.phase !== "queued" && run.phase !== "done";
}

export class KillSwitchService {
  private readonly runStore: RunStore;
  private readonly eventStore: EventStore;
  private readonly queue: KillSwitchQueueHook | null;
  private readonly runtimeControls: KillSwitchRuntimeControls | null;
  private readonly now: () => number;

  private pausedNewRuns = false;
  private stoppingGracefully = false;
  private lastLevel: KillSwitchLevel | null = null;
  private lastExecutedAt: number | null = null;

  constructor(options: KillSwitchOptions) {
    if (!options || !options.runStore || !options.eventStore) {
      throw new TypeError("KillSwitchService requires a runStore and an eventStore");
    }
    this.runStore = options.runStore;
    this.eventStore = options.eventStore;
    this.queue = options.queue ?? null;
    this.runtimeControls = options.runtimeControls ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  isPausedNewRuns(): boolean {
    return this.pausedNewRuns;
  }

  isStoppingGracefully(): boolean {
    return this.stoppingGracefully;
  }

  getState(): KillSwitchState {
    return {
      pausedNewRuns: this.pausedNewRuns,
      stoppingGracefully: this.stoppingGracefully,
      lastLevel: this.lastLevel,
      lastExecutedAt: this.lastExecutedAt,
    };
  }

  /**
   * Restores the enforcement flags from persisted state on a cold start. Called after constructing
   * a fresh service so `isPausedNewRuns()` / `isStoppingGracefully()` match the persisted
   * `SettingsStore` values even when the in-memory flags would otherwise begin `false`.
   */
  rehydrateState(state: {
    pausedNewRuns?: boolean;
    stoppingGracefully?: boolean;
    lastLevel?: KillSwitchLevel | null;
  }): void {
    if (typeof state.pausedNewRuns === "boolean") {
      this.pausedNewRuns = state.pausedNewRuns;
    }
    if (typeof state.stoppingGracefully === "boolean") {
      this.stoppingGracefully = state.stoppingGracefully;
    }
    if (state.lastLevel !== undefined && state.lastLevel !== null) {
      this.lastLevel = state.lastLevel;
    }

    // Reflect the persisted enforcement flags onto the live RuntimeHost / RunOrchestrator so a cold
    // start (or a request after an out-of-band persist) re-arms the same admission pause the kill
    // switch enforced before it restarted.
    if (this.runtimeControls) {
      if (this.pausedNewRuns) {
        this.invokeSync(this.runtimeControls.pauseAdmission);
      }
      if (this.stoppingGracefully) {
        this.invokeSync(this.runtimeControls.pauseHost);
      }
    }
  }

  /** Computes the exact set of runs a level affects BEFORE it acts (Requirement 39.10). */
  preview(level: KillSwitchLevel): KillSwitchPreview {
    const living = this.runStore.getLivingRuns();
    let affected: RunRecord[];
    let summary: string;

    switch (level) {
      case "pause_new_runs": {
        affected = living.filter(isQueued);
        summary = `Pauses new run admission. ${affected.length} queued run(s) stay queued.`;
        break;
      }
      case "stop_gracefully": {
        affected = living.filter(isActive);
        summary = `Asks ${affected.length} running run(s) to end at their next tool boundary; worktrees are kept.`;
        break;
      }
      case "hard_kill": {
        affected = living;
        summary = `Immediately terminates ${affected.length} active/queued run(s) with outcome killed.`;
        break;
      }
      default: {
        affected = [];
        summary = "Unknown kill-switch level.";
      }
    }

    return {
      level,
      affectedRunCount: affected.length,
      affectedRunIds: affected.map((run) => run.runId),
      summary,
    };
  }

  /** Executes a level and records a redacted `admin.kill` event for each affected run. */
  execute(level: KillSwitchLevel, options: KillSwitchExecuteOptions): KillSwitchResult {
    const preview = this.preview(level);
    const actor = options?.actor ?? "owner";
    const reason = options?.reason ?? null;
    const at = this.now();

    // Capture which affected runs were still queued *before* the RunStore mutation below, so the
    // live runtime controls can tell a queued run (cancel) from an active run (stop / kill).
    const queuedRunIds = new Set<string>();
    for (const runId of preview.affectedRunIds) {
      const run = this.runStore.getRun(runId);
      if (run && isQueued(run)) {
        queuedRunIds.add(runId);
      }
    }

    switch (level) {
      case "pause_new_runs":
        // Every level halts new admission, so all three persist `pausedNewRuns = true`.
        this.pausedNewRuns = true;
        break;
      case "stop_gracefully":
        this.pausedNewRuns = true;
        this.stoppingGracefully = true;
        for (const runId of preview.affectedRunIds) {
          this.emit(runId, "system.worker_state", actor, {
            action: "stop_gracefully",
            level,
            actor,
          });
        }
        break;
      case "hard_kill": {
        this.pausedNewRuns = true;
        for (const runId of preview.affectedRunIds) {
          const run = this.runStore.getRun(runId);
          const queued = run !== null && isQueued(run);
          if (this.queue) {
            try {
              if (queued) {
                this.queue.remove(runId);
              } else {
                this.queue.cancel(runId);
              }
            } catch {
              // Queue bookkeeping must never block the kill.
            }
          }
        }
        break;
      }
      default:
        break;
    }

    const pending = this.applyRuntimeControls(level, preview.affectedRunIds, queuedRunIds, reason);

    if (level === "hard_kill") {
      // A queued run has no live `killRun` to await, so it is finalized synchronously. This runs
      // AFTER the live queue removal: the orchestrator's `cancelQueuedRun` fallback writes
      // `outcome: "cancelled"`, so the kill must force `outcome: "killed"` back over it. An active
      // run is only finalized as `"killed"` once its live `killRun` settles (in `waitForRuntime`
      // below), so a rejected kill leaves it retryable.
      for (const runId of preview.affectedRunIds) {
        if (queuedRunIds.has(runId)) {
          try {
            this.finalizeKilled(runId, at, true);
          } catch {
            // A failed terminal write leaves the run unfinalized and retryable.
          }
        }
      }
    }

    if (preview.affectedRunIds.length === 0) {
      this.emit(SYSTEM_RUN_ID, "admin.kill", actor, { level, actor, reason, affectedRunCount: 0 });
    } else {
      for (const runId of preview.affectedRunIds) {
        this.emit(runId, "admin.kill", actor, {
          level,
          actor,
          reason,
          affectedRunCount: preview.affectedRunCount,
        });
      }
    }

    this.lastLevel = level;
    this.lastExecutedAt = at;

    const result: KillSwitchResult = {
      ...preview,
      executed: true,
      executedAt: at,
      actor,
      reason,
      failedRunIds: [],
    };
    if (pending.length > 0) {
      result.waitForRuntime = async () => {
        const settled = await Promise.allSettled(pending.map((task) => task.promise));
        settled.forEach((outcome, index) => {
          const task = pending[index];
          if (outcome.status === "rejected") {
            // A rejected control is NOT a success: the run stays retryable and is reported so the
            // caller returns a retryable failure instead of pretending the kill completed.
            result.failedRunIds.push(task.runId);
            return;
          }
          if (task.finalizeKilled) {
            try {
              this.finalizeKilled(task.runId, at);
            } catch {
              // If the terminal write itself fails the run is not finalized and stays retryable.
              result.failedRunIds.push(task.runId);
            }
          }
        });
      };
    }
    return result;
  }

  /**
   * Async counterpart to {@link execute}: runs the same synchronous mutation and then awaits every
   * asynchronous runtime control (`stopRun` / `killRun`) it collected, so a caller that must not
   * return before the live RunOrchestrator actually stopped/killed the runs can simply `await`.
   */
  async executeLive(
    level: KillSwitchLevel,
    options: KillSwitchExecuteOptions
  ): Promise<KillSwitchResult> {
    const result = this.execute(level, options);
    if (typeof result.waitForRuntime === "function") {
      await result.waitForRuntime();
    }
    return result;
  }

  /**
   * Drives the optional live runtime controls for a level: the admission/host pause and, per affected
   * run, the synchronous `cancelQueuedRun` (queued) or async `stopRun` / `killRun` (active). Every
   * returned task carries the promise so {@link KillSwitchResult.waitForRuntime} can settle them with
   * `Promise.allSettled` — a rejected promise is surfaced through `failedRunIds` instead of being
   * silently treated as success, and an active hard-kill run is only finalized once its `killRun`
   * resolves.
   */
  private applyRuntimeControls(
    level: KillSwitchLevel,
    affectedRunIds: string[],
    queuedRunIds: Set<string>,
    reason: string | null
  ): PendingRuntimeControl[] {
    const controls = this.runtimeControls;
    const pending: PendingRuntimeControl[] = [];
    if (!controls) {
      return pending;
    }

    // All three levels halt new admission on the live host + orchestrator.
    this.invokeSync(controls.pauseAdmission);
    this.invokeSync(controls.pauseHost);

    if (level === "stop_gracefully") {
      for (const runId of affectedRunIds) {
        pending.push({
          runId,
          // A boundary-aware graceful stop keeps the worker's worktree and lets the in-flight
          // turn settle at its next tool boundary. Only fall back to the aborting `stopRun` when
          // the process exposes no graceful control.
          promise: this.runRuntimeControl(
            controls.stopRunGracefully ?? controls.stopRun,
            runId,
            reason
          ),
          finalizeKilled: false,
        });
      }
    } else if (level === "hard_kill") {
      for (const runId of affectedRunIds) {
        if (queuedRunIds.has(runId)) {
          // Prefer `removeQueuedRun` (which leaves the terminal outcome intact) over
          // `cancelQueuedRun` (which would overwrite `outcome: "killed"` with `"cancelled"` and emit
          // a contradictory `run.phase` event). `cancelQueuedRun` is only the backwards-compatible
          // fallback for a caller/test that wires that hook alone.
          if (typeof controls.removeQueuedRun === "function") {
            try {
              controls.removeQueuedRun(runId);
            } catch {
              // A failed queue removal must not block the kill.
            }
          } else if (typeof controls.cancelQueuedRun === "function") {
            try {
              controls.cancelQueuedRun(runId);
            } catch {
              // A failed queue cancellation must not block the kill.
            }
          }
        } else {
          pending.push({
            runId,
            promise: this.runRuntimeControl(controls.killRun, runId, reason),
            finalizeKilled: true,
          });
        }
      }
    }

    return pending;
  }

  private invokeSync(fn?: () => void): void {
    if (typeof fn !== "function") {
      return;
    }
    try {
      fn();
    } catch {
      // A flaky synchronous control must never block the kill switch.
    }
  }

  /**
   * Invokes one asynchronous runtime control and returns its promise WITHOUT swallowing a rejection,
   * so `waitForRuntime` can record the run in `failedRunIds`. A missing control (or one that returns
   * no promise) resolves immediately and counts as success; a synchronously-throwing control becomes
   * a rejected promise so it is reported instead of silently dropped.
   */
  private runRuntimeControl(
    fn?: (runId: string, reason?: string) => void | Promise<void>,
    runId?: string,
    reason?: string | null
  ): Promise<void> {
    if (typeof fn !== "function" || typeof runId !== "string") {
      return Promise.resolve();
    }
    try {
      const outcome = fn(runId, reason ?? undefined);
      if (outcome && typeof (outcome as Promise<void>).then === "function") {
        return Promise.resolve(outcome as Promise<void>);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  /**
   * Finalizes a run as `"killed"` in the RunStore once (guarded so a retry cannot double-write).
   * `force` bypasses the `phase === "done"` guard so a hard kill can correct a run a fallback
   * `cancelQueuedRun` already finalized as `"cancelled"` back to its true `"killed"` outcome.
   */
  private finalizeKilled(runId: string, at: number, force = false): void {
    const run = this.runStore.getRun(runId);
    if (!run) {
      return;
    }
    if (run.phase === "done" && !force) {
      return;
    }
    this.runStore.updateRun(runId, { outcome: "killed", phase: "done", endedAt: at });
  }

  private emit(
    runId: string,
    kind: string,
    actor: string,
    data: Record<string, unknown>
  ): void {
    // Append failures are not swallowed: an action that cannot be recorded must surface so the
    // caller does not believe the audit trail is complete.
    this.eventStore.append(
      redactEvent({
        runId,
        kind,
        actor,
        data: { refs: [], ...data },
      })
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Process-wide registry shared with the Admin kill-switch route
// ---------------------------------------------------------------------------------------------

const killSwitchRegistry = globalThis as unknown as {
  __killSwitchServices?: WeakMap<object, KillSwitchService>;
  __killSwitchUnpersistedAuthority?: WeakSet<object>;
};

/**
 * Returns (creating on first use) the process-wide `RunStore` -> {@link KillSwitchService} registry,
 * so successive Admin calls observe the same in-memory pause/stop state while distinct stores
 * (tests, other processes) stay isolated.
 */
export function killSwitchServiceRegistry(): WeakMap<object, KillSwitchService> {
  if (!killSwitchRegistry.__killSwitchServices) {
    killSwitchRegistry.__killSwitchServices = new WeakMap<object, KillSwitchService>();
  }
  return killSwitchRegistry.__killSwitchServices;
}

/**
 * Marks a store key as the authoritative kill-switch state after a failed `persistState` write. A
 * later rehydrate from the (stale) persisted `SettingsStore` must not silently revert the pause/stop.
 */
export function markKillSwitchUnpersistedAuthority(key: object): void {
  if (!killSwitchRegistry.__killSwitchUnpersistedAuthority) {
    killSwitchRegistry.__killSwitchUnpersistedAuthority = new WeakSet<object>();
  }
  killSwitchRegistry.__killSwitchUnpersistedAuthority.add(key);
}

/** True once a failed persistence write made the in-memory kill-switch state authoritative. */
export function isKillSwitchUnpersistedAuthority(key: object): boolean {
  return killSwitchRegistry.__killSwitchUnpersistedAuthority?.has(key) === true;
}

/**
 * Clears the unpersisted-authority mark for a store key after a later `persistState` write
 * succeeds. Without this a single transient write failure would permanently keep the in-memory
 * state authoritative and prevent future requests from rehydrating persisted `SettingsStore` state.
 */
export function clearKillSwitchUnpersistedAuthority(storeKey: object): void {
  killSwitchRegistry.__killSwitchUnpersistedAuthority?.delete(storeKey);
}

/** Clears the shared kill-switch registry (used by tests between fixtures). */
export function resetKillSwitchRegistry(): void {
  killSwitchRegistry.__killSwitchServices = new WeakMap<object, KillSwitchService>();
  killSwitchRegistry.__killSwitchUnpersistedAuthority = new WeakSet<object>();
}

