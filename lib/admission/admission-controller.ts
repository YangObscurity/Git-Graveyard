// Task 22.2 (part 2): admission controller.
// Requirements: 31.6, 31.7, 31.8, 31.9, 31.10, 31.11, 31.14, 31.15, 31.16, 41.11, 41.13, 41.15, 45.8.
//
// The controller is the single decision point before a run may be admitted. It composes the
// `SettingsStore`, `RunStore`, `EventStore`, the KillSwitch and the ExecutionBackend capacity probe
// and returns a structured decision the caller (the queue / the Necromancer) applies.

import type { EventStore } from "../events/event-store";
import type { RunRecord, RunStore } from "../runs/run-store";
import type { RequiredSettingsValidation, SettingsStore } from "../admin/settings-store";
import { redactEvent } from "../security/redactor";

/** Sentinel run id for owner alerts that belong to no single run. */
export const SYSTEM_RUN_ID = "system";
/** Requirement 30.3: the global live-run ceiling (prod at most 5 under the default sandbox quota). */
export const HARD_CONCURRENT_LIVE_RUNS_CEILING = 5;

export type AdmissionRejectionCode =
  | "REQUIRED_SETTINGS_MISSING"
  | "TOO_LARGE"
  | "PAUSED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "QUEUE";

export interface AdmissionDecision {
  admitted: boolean;
  code?: AdmissionRejectionCode;
  reason?: string;
  retryAfterMs?: number;
  missing?: string[];
  /** Present when a run is retained queued (Requirement 41.11: `reason: "capacity"`). */
  queueReason?: string;
  concurrentLiveRuns?: number;
  maxParallelSoulStitchers?: number;
}

export interface KillSwitchStatusSource {
  isPaused?: () => boolean;
  pauseNewRuns?: boolean;
  isPausedNewRuns?: () => boolean;
}

export interface BackendCapacitySource {
  capacity?: (() => unknown) | unknown;
  kind?: string;
}

export interface AdmissionControllerOptions {
  settingsStore?: SettingsStore;
  eventStore?: EventStore;
  runStore?: RunStore;
  killSwitch?: KillSwitchStatusSource | null;
  backend?: BackendCapacitySource | null;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface AdmissionCheckInput {
  repoSizeKb?: number | null;
  backendKind?: string;
}

export interface AdmissionControllerState {
  authHalted: boolean;
  authFailureReason: string | null;
  backingOff: boolean;
  rateLimitRetryAfterMs: number;
  capacityLimited: boolean;
}

function readNumberSetting(store: SettingsStore | undefined, key: string): number | null {
  if (!store) {
    return null;
  }
  try {
    const value = store.getSetting(key);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}


export class AdmissionController {
  private readonly settingsStore?: SettingsStore;
  private readonly eventStore?: EventStore;
  private readonly runStore?: RunStore;
  private readonly killSwitch?: KillSwitchStatusSource | null;
  private readonly backend?: BackendCapacitySource | null;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;

  private authHalted = false;
  private authFailureReason: string | null = null;
  private backoffUntil = 0;
  private capacityLimited = false;
  private capacityLimitSource: string | null = null;

  constructor(options: AdmissionControllerOptions = {}) {
    this.settingsStore = options.settingsStore;
    this.eventStore = options.eventStore;
    this.runStore = options.runStore;
    this.killSwitch = options.killSwitch ?? null;
    this.backend = options.backend ?? null;
    this.now = options.now ?? (() => Date.now());
    this.env = options.env ?? process.env;
  }

  validateRequiredSettings(): RequiredSettingsValidation {
    if (!this.settingsStore) {
      return { ok: true, missing: [] };
    }
    return this.settingsStore.validateRequiredSettings();
  }

  checkRepoSize(repoSizeKb?: number | null): AdmissionDecision {
    const capKb = readNumberSetting(this.settingsStore, "repoSizeCapKb");
    if (
      capKb !== null &&
      typeof repoSizeKb === "number" &&
      Number.isFinite(repoSizeKb) &&
      repoSizeKb > capKb
    ) {
      return {
        admitted: false,
        code: "TOO_LARGE",
        reason: `Repository size ${repoSizeKb} KB exceeds the ${capKb} KB cap`,
      };
    }
    return { admitted: true };
  }

  isPausedByKillSwitch(): boolean {
    const ks = this.killSwitch;
    if (!ks) {
      return false;
    }
    if (typeof ks.isPausedNewRuns === "function" && ks.isPausedNewRuns()) {
      return true;
    }
    if (typeof ks.isPaused === "function" && ks.isPaused()) {
      return true;
    }
    return ks.pauseNewRuns === true;
  }

  /**
   * Latches an ACP/Kiro authentication failure. New admissions stop with no retry loop, the queue
   * is preserved, and the Owner is alerted through a `system.worker_state` event.
   */
  haltOnAuthFailure(reason: string): void {
    this.authHalted = true;
    this.authFailureReason = reason || "authentication_failure";
    this.emitSystemWorkerState("unavailable", this.authFailureReason);
  }

  clearAuthFailure(): void {
    this.authHalted = false;
    this.authFailureReason = null;
  }

  isAuthHalted(): boolean {
    return this.authHalted;
  }

  getAuthFailureReason(): string | null {
    return this.authFailureReason;
  }

  /** Requirement 41.15: pause the queue and back off after a Kiro rate-limit error. */
  triggerRateLimitBackoff(retryAfterMs: number, now?: number): void {
    const at = typeof now === "number" ? now : this.now();
    const delay =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.floor(retryAfterMs)
        : 0;
    this.backoffUntil = delay > 0 ? at + delay : at;
  }

  clearBackoff(): void {
    this.backoffUntil = 0;
  }

  isBackingOff(now?: number): boolean {
    const at = typeof now === "number" ? now : this.now();
    return at < this.backoffUntil;
  }

  backoffRetryAfterMs(now?: number): number {
    const at = typeof now === "number" ? now : this.now();
    return Math.max(0, this.backoffUntil - at);
  }

  /**
   * Records that probe P8 or spike S4 showed parallel sessions exceed host capacity; the Admission
   * then limits live execution to one Skeleton (Requirement 45.8).
   */
  noteCapacityLimit(source: "probe_p8" | "spike_s4" | "backend" | string): void {
    this.capacityLimited = true;
    this.capacityLimitSource = source;
  }

  clearCapacityLimit(): void {
    this.capacityLimited = false;
    this.capacityLimitSource = null;
  }

  isCapacityLimited(): boolean {
    return this.capacityLimited;
  }

  getCapacityLimitSource(): string | null {
    return this.capacityLimitSource;
  }

  /** Single-Skeleton fallback whenever P8/S4 showed capacity limits. */
  maxParallelSoulStitchers(): number {
    if (this.capacityLimited) {
      return 1;
    }
    const configured = readNumberSetting(this.settingsStore, "parallelSoulStitchers");
    return configured !== null && configured > 0 ? Math.floor(configured) : 1;
  }

  getState(now?: number): AdmissionControllerState {
    return {
      authHalted: this.authHalted,
      authFailureReason: this.authFailureReason,
      backingOff: this.isBackingOff(now),
      rateLimitRetryAfterMs: this.backoffRetryAfterMs(now),
      capacityLimited: this.capacityLimited,
    };
  }

  /**
   * Runs every admission check in order and returns the first rejection, or an admit decision with
   * the effective concurrency and Skeleton fan-out.
   */
  checkAdmission(input: AdmissionCheckInput = {}): AdmissionDecision {
    const settings = this.validateRequiredSettings();
    if (!settings.ok) {
      return {
        admitted: false,
        code: "REQUIRED_SETTINGS_MISSING",
        reason:
          settings.message ??
          `Required settings missing: ${settings.missing.join(", ")}`,
        missing: settings.missing,
      };
    }

    const repo = this.checkRepoSize(input.repoSizeKb);
    if (!repo.admitted) {
      return repo;
    }

    if (this.isPausedByKillSwitch()) {
      return { admitted: false, code: "PAUSED", reason: "New runs are paused" };
    }

    if (this.authHalted) {
      return {
        admitted: false,
        code: "AUTH_FAILED",
        reason: this.authFailureReason ?? "Kiro authentication failure",
      };
    }

    if (this.isBackingOff()) {
      return {
        admitted: false,
        code: "RATE_LIMITED",
        reason: "Kiro rate limit backoff in effect",
        retryAfterMs: this.backoffRetryAfterMs(),
      };
    }

    const backendKind = input.backendKind ?? this.backendKind();
    const capacity = this.readBackendCapacity();
    const limit = this.effectiveConcurrentLiveRuns(backendKind);
    const live = this.countLiveRuns();

    // Requirement 41.11: a cloud backend reporting no free slot retains the run queued.
    const cloudish = backendKind !== "instabox-docker";
    if (cloudish && capacity.reported && capacity.available !== null && capacity.available <= 0) {
      return {
        admitted: false,
        code: "QUEUE",
        reason: "ExecutionBackend reports no available capacity",
        queueReason: "capacity",
        concurrentLiveRuns: limit,
        maxParallelSoulStitchers: this.maxParallelSoulStitchers(),
      };
    }

    if (live >= limit) {
      return {
        admitted: false,
        code: "QUEUE",
        reason: `Concurrency limit reached (${live}/${limit})`,
        queueReason: "capacity",
        concurrentLiveRuns: limit,
        maxParallelSoulStitchers: this.maxParallelSoulStitchers(),
      };
    }

    return {
      admitted: true,
      concurrentLiveRuns: limit,
      maxParallelSoulStitchers: this.maxParallelSoulStitchers(),
    };
  }

  /** Live-run concurrency limit: dev/instabox at most 1, cloud at most `concurrentLiveRuns` (<= 5). */
  effectiveConcurrentLiveRuns(backendKind?: string): number {
    const kind = backendKind ?? this.backendKind();
    const configured = readNumberSetting(this.settingsStore, "concurrentLiveRuns");
    const base = configured !== null && configured > 0 ? Math.floor(configured) : 1;
    if (kind === "instabox-docker") {
      return Math.min(base, 1);
    }
    return Math.min(base, HARD_CONCURRENT_LIVE_RUNS_CEILING);
  }

  countLiveRuns(): number {
    if (!this.runStore) {
      return 0;
    }
    let count = 0;
    for (const run of this.runStore.getLivingRuns() as RunRecord[]) {
      if (run.phase !== "queued" && run.phase !== "done" && !run.outcome) {
        count += 1;
      }
    }
    return count;
  }

  backendKind(): string {
    const envKind = this.env.EXECUTION_BACKEND;
    if (typeof envKind === "string" && envKind.trim().length > 0) {
      return envKind.trim();
    }
    if (this.backend && typeof this.backend.kind === "string" && this.backend.kind.length > 0) {
      return this.backend.kind;
    }
    return "instabox-docker";
  }

  private readBackendCapacity(): { reported: boolean; available: number | null } {
    const backend = this.backend;
    if (!backend) {
      return { reported: false, available: null };
    }
    const capacity = backend.capacity;
    if (typeof capacity === "number") {
      return { reported: true, available: capacity };
    }
    if (typeof capacity !== "function") {
      return { reported: false, available: null };
    }
    try {
      const result = capacity.call(backend);
      if (typeof result === "number" && Number.isFinite(result)) {
        return { reported: true, available: result };
      }
      if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        const value = record.available ?? record.free ?? record.slots;
        if (typeof value === "number" && Number.isFinite(value)) {
          return { reported: true, available: value };
        }
      }
    } catch {
      // A throwing capacity probe is treated as unreported, never as a free slot.
    }
    return { reported: false, available: null };
  }

  private emitSystemWorkerState(state: string, reason: string): void {
    if (!this.eventStore) {
      return;
    }
    try {
      this.eventStore.append(
        redactEvent({
          runId: SYSTEM_RUN_ID,
          kind: "system.worker_state",
          actor: "admission",
          data: {
            refs: [],
            state,
            reason,
            ownerAlert: true,
          },
        })
      );
    } catch {
      // Owner alerts are best-effort and must never break admission.
    }
  }

}
