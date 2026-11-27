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
}

export interface KillSwitchQueueHook {
  cancel(runId: string): unknown;
  remove(runId: string): unknown;
}

export interface KillSwitchOptions {
  runStore: RunStore;
  eventStore: EventStore;
  queue?: KillSwitchQueueHook | null;
  now?: () => number;
}

export interface KillSwitchState {
  pausedNewRuns: boolean;
  stoppingGracefully: boolean;
  lastLevel: KillSwitchLevel | null;
  lastExecutedAt: number | null;
}

function isQueued(run: RunRecord): boolean {
  return run.phase === "queued";
}

function isActive(run: RunRecord): boolean {
  return run.phase !== "queued";
}

export class KillSwitchService {
  private readonly runStore: RunStore;
  private readonly eventStore: EventStore;
  private readonly queue: KillSwitchQueueHook | null;
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

    switch (level) {
      case "pause_new_runs":
        this.pausedNewRuns = true;
        break;
      case "stop_gracefully":
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
        for (const runId of preview.affectedRunIds) {
          const run = this.runStore.getRun(runId);
          if (run && run.phase !== "done") {
            this.runStore.updateRun(runId, {
              outcome: "killed",
              phase: "done",
              endedAt: at,
            });
          }
          if (this.queue) {
            try {
              if (run && isQueued(run)) {
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

    return {
      ...preview,
      executed: true,
      executedAt: at,
      actor,
      reason,
    };
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

/** Clears the shared kill-switch registry (used by tests between fixtures). */
export function resetKillSwitchRegistry(): void {
  killSwitchRegistry.__killSwitchServices = new WeakMap<object, KillSwitchService>();
  killSwitchRegistry.__killSwitchUnpersistedAuthority = new WeakSet<object>();
}

