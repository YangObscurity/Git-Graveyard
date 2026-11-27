// Task 22.3: BudgetGovernor runtime metering and multi-dimensional cap enforcement.
// Requirements: 30.1 to 30.19 and 30.21.
//
// The governor tracks every capped dimension the run can hit. Telemetry is appended to the
// `EventStore`: `budget.update` when a cap changes, `budget.warning` once per dimension at the
// warning level, and `budget.exceeded` at 100 percent of any dimension. Credits are only ever
// enforced when the stream actually reported them (probe P5); when credits are unreported the run is
// capped by wall clock and tool calls alone and no credit estimate is computed (Requirement 30.11).
//
// The run wall clock strictly excludes Pact review / approval waits (Requirement 30.12) through
// `pauseClockForPact` / `resumeClockFromPact`.

import type { EventStore } from "../events/event-store";
import type { RunStore } from "../runs/run-store";
import { redactEvent } from "../security/redactor";

export type BudgetDimension =
  | "promptWallClockMs"
  | "promptsPerSkeleton"
  | "toolCallsPerTurn"
  | "toolCallsPerRun"
  | "runWallClockMs"
  | "contextPressurePercent"
  | "creditsPerRun"
  | "creditsPerDay";

export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  "promptWallClockMs",
  "promptsPerSkeleton",
  "toolCallsPerTurn",
  "toolCallsPerRun",
  "runWallClockMs",
  "contextPressurePercent",
  "creditsPerRun",
  "creditsPerDay",
];

export type BudgetCaps = Partial<Record<BudgetDimension, number>>;

export interface BudgetGovernorOptions {
  runId: string;
  eventStore?: EventStore;
  runStore?: RunStore;
  /** Current cap per dimension. An absent dimension is uncapped. */
  caps?: BudgetCaps;
  /** Invite-code ceiling per dimension; no cap may be raised above it (Requirement 30.8). */
  codeCeiling?: BudgetCaps;
  /** Global ceiling per dimension; a second upper bound on a grant (Requirement 30.8). */
  globalCeiling?: BudgetCaps;
  /** Warning threshold as a percentage of the cap (default 80). */
  warningPercent?: number;
  /** Margin above the context cap where steering gives way to cancellation. */
  contextCancelMarginPercent?: number;
  /** Credits already spent today, carried in from previous runs. */
  initialCreditsToday?: number;
  now?: () => number;
}

export interface BudgetUsage {
  promptWallClockMs: number;
  promptsPerSkeleton: number;
  toolCallsPerTurn: number;
  toolCallsPerRun: number;
  runWallClockMs: number;
  contextPressurePercent: number;
  creditsPerRun: number | null;
  creditsPerDay: number | null;
}

export interface BudgetSnapshot {
  runId: string;
  caps: BudgetCaps;
  usage: BudgetUsage;
  pactWaitMs: number;
  warnings: BudgetDimension[];
  exceeded: BudgetDimension[];
  exceededAny: boolean;
  creditsReported: boolean;
  pendingAsk: "exceed_budget" | null;
  runOutcome: string | null;
}

export type BudgetDispatchGate =
  | { allowed: true }
  | { allowed: false; reason: "budget_exceeded"; dimensions: BudgetDimension[] };

export interface GrantCapIncreaseInput {
  actor: string;
  reason?: string;
  now?: number;
}

export type GrantCapIncreaseResult =
  | { ok: true; dimension: BudgetDimension; previousCap: number; newCap: number }
  | {
      ok: false;
      code:
        | "UNKNOWN_DIMENSION"
        | "CAP_NOT_RAISED"
        | "CODE_CEILING_EXCEEDED"
        | "GLOBAL_CEILING_EXCEEDED";
      dimension: BudgetDimension;
      newCap: number;
      ceiling?: number;
    };

const DIMENSION_SET = new Set<string>(BUDGET_DIMENSIONS);

function isDimension(value: string): value is BudgetDimension {
  return DIMENSION_SET.has(value);
}

function toCapMap(input?: BudgetCaps): Map<BudgetDimension, number> {
  const map = new Map<BudgetDimension, number>();
  if (!input) {
    return map;
  }
  for (const dim of BUDGET_DIMENSIONS) {
    const value = input[dim];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      map.set(dim, value);
    }
  }
  return map;
}

/**
 * Requirement 30.8: an initial cap may never exceed the invite-code ceiling or the global ceiling.
 * Every configured dimension is lowered to `min(codeCeiling[dim], globalCeiling[dim])` when a
 * ceiling is present, so a misconfigured `caps` grant cannot bypass either bound.
 */
function clampCapsToCeilings(
  caps: Map<BudgetDimension, number>,
  codeCeiling: Map<BudgetDimension, number>,
  globalCeiling: Map<BudgetDimension, number>
): Map<BudgetDimension, number> {
  const clamped = new Map<BudgetDimension, number>();
  for (const [dim, cap] of caps) {
    let value = cap;
    const code = codeCeiling.get(dim);
    if (code !== undefined) {
      value = Math.min(value, code);
    }
    const global = globalCeiling.get(dim);
    if (global !== undefined) {
      value = Math.min(value, global);
    }
    clamped.set(dim, value);
  }
  return clamped;
}

export class BudgetGovernor {
  readonly runId: string;

  private readonly eventStore?: EventStore;
  private readonly runStore?: RunStore;
  private readonly now: () => number;
  private readonly warningPercent: number;
  private readonly contextCancelMarginPercent: number;

  private readonly caps: Map<BudgetDimension, number>;
  private readonly codeCeiling: Map<BudgetDimension, number>;
  private readonly globalCeiling: Map<BudgetDimension, number>;

  private readonly runStartedAt: number;
  private pausedForPact = false;
  private pauseStartedAt: number | null = null;
  private pactPauseTotalMs = 0;

  private readonly promptStarts = new Map<string, number>();
  private readonly lastPromptDurations = new Map<string, number>();
  private readonly promptCounts = new Map<string, number>();
  private readonly turnToolCalls = new Map<string, number>();
  private readonly currentTurn = new Map<string, string>();
  private turnCounter = 0;
  private totalToolCalls = 0;

  private contextPressurePercent = 0;
  private creditsRun = 0;
  private creditsDay: number;
  private creditsReported = false;

  private readonly warningsEmitted = new Set<BudgetDimension>();
  /**
   * Latched exceedance set. Once a capped dimension crosses 100 percent it stays here until an
   * explicit `grantCapIncrease` raises usage below the new cap, so `canDispatchPrompt` /
   * `canDispatchSandboxExec` keep blocking new work across `beginTurn()` and any later usage drop
   * (Property P20, Requirement 30.7).
   */
  private readonly exceededDimensions = new Map<BudgetDimension, number>();
  private pendingAsk: "exceed_budget" | null = null;
  private runOutcome: string | null = null;
  private creditExhaustionHandled = false;

  constructor(options: BudgetGovernorOptions) {
    if (!options || typeof options.runId !== "string" || options.runId.trim().length === 0) {
      throw new TypeError("BudgetGovernor requires a non-empty runId");
    }
    this.runId = options.runId;
    this.eventStore = options.eventStore;
    this.runStore = options.runStore;
    this.now = options.now ?? (() => Date.now());
    this.warningPercent =
      typeof options.warningPercent === "number" && Number.isFinite(options.warningPercent)
        ? options.warningPercent
        : 80;
    this.contextCancelMarginPercent =
      typeof options.contextCancelMarginPercent === "number" &&
      Number.isFinite(options.contextCancelMarginPercent)
        ? options.contextCancelMarginPercent
        : 5;
    this.codeCeiling = toCapMap(options.codeCeiling);
    this.globalCeiling = toCapMap(options.globalCeiling);
    this.caps = clampCapsToCeilings(
      toCapMap(options.caps),
      this.codeCeiling,
      this.globalCeiling
    );
    this.runStartedAt = this.now();
    this.creditsDay =
      typeof options.initialCreditsToday === "number" && Number.isFinite(options.initialCreditsToday)
        ? Math.max(0, options.initialCreditsToday)
        : 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Clock (run wall clock excludes Pact review / approval waits)
  // ---------------------------------------------------------------------------------------------

  pauseClockForPact(now?: number): void {
    if (this.pausedForPact) {
      return;
    }
    this.pausedForPact = true;
    this.pauseStartedAt = typeof now === "number" ? now : this.now();
  }

  resumeClockFromPact(now?: number): void {
    if (!this.pausedForPact || this.pauseStartedAt === null) {
      return;
    }
    const at = typeof now === "number" ? now : this.now();
    this.pactPauseTotalMs += Math.max(0, at - this.pauseStartedAt);
    this.pausedForPact = false;
    this.pauseStartedAt = null;
  }

  pactWaitMs(now?: number): number {
    const at = typeof now === "number" ? now : this.now();
    const open = this.pausedForPact && this.pauseStartedAt !== null ? at - this.pauseStartedAt : 0;
    return this.pactPauseTotalMs + Math.max(0, open);
  }

  runWallClockMs(now?: number): number {
    const at = typeof now === "number" ? now : this.now();
    let active = at - this.runStartedAt - this.pactPauseTotalMs;
    if (this.pausedForPact && this.pauseStartedAt !== null) {
      active -= at - this.pauseStartedAt;
    }
    return Math.max(0, active);
  }

  // ---------------------------------------------------------------------------------------------
  // Usage recorders
  // ---------------------------------------------------------------------------------------------

  recordPromptStart(skeletonId: string, now?: number): void {
    const at = typeof now === "number" ? now : this.now();
    this.promptStarts.set(skeletonId, at);
    this.promptCounts.set(skeletonId, (this.promptCounts.get(skeletonId) ?? 0) + 1);
  }

  recordPromptEnd(skeletonId: string, now?: number): void {
    const start = this.promptStarts.get(skeletonId);
    if (start === undefined) {
      return;
    }
    const at = typeof now === "number" ? now : this.now();
    this.lastPromptDurations.set(skeletonId, Math.max(0, at - start));
    this.promptStarts.delete(skeletonId);
  }

  beginTurn(skeletonId: string): string {
    this.turnCounter += 1;
    const turnId = `${skeletonId}#turn-${this.turnCounter}`;
    this.currentTurn.set(skeletonId, turnId);
    this.turnToolCalls.set(turnId, 0);
    return turnId;
  }

  recordToolCall(skeletonId: string, turnId?: string): void {
    const id = turnId ?? this.currentTurn.get(skeletonId) ?? `${skeletonId}#turn-0`;
    this.turnToolCalls.set(id, (this.turnToolCalls.get(id) ?? 0) + 1);
    this.totalToolCalls += 1;
  }

  recordContextPressure(percent: number): void {
    if (typeof percent === "number" && Number.isFinite(percent)) {
      this.contextPressurePercent = Math.max(0, percent);
    }
  }

  /** Credits are recorded only when the stream actually reported a finite value (probe P5). */
  recordCredits(credits: number): void {
    if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) {
      return;
    }
    this.creditsReported = true;
    this.creditsRun += credits;
    this.creditsDay += credits;
  }

  setCreditsReported(reported: boolean): void {
    this.creditsReported = reported;
  }

  isCreditsReported(): boolean {
    return this.creditsReported;
  }

  totalToolCallsSoFar(): number {
    return this.totalToolCalls;
  }

  finish(outcome: string): void {
    this.runOutcome = outcome;
  }

  getRunOutcome(): string | null {
    return this.runOutcome;
  }

  getCaps(): BudgetCaps {
    const out: BudgetCaps = {};
    for (const [dim, cap] of this.caps) {
      out[dim] = cap;
    }
    return out;
  }

  getCap(dimension: BudgetDimension): number | undefined {
    return this.caps.get(dimension);
  }

  getCodeCeiling(dimension: BudgetDimension): number | undefined {
    return this.codeCeiling.get(dimension);
  }

  getWarnings(): BudgetDimension[] {
    return [...this.warningsEmitted];
  }

  getExceededDimensions(): BudgetDimension[] {
    return [...this.exceededDimensions.keys()];
  }

  // ---------------------------------------------------------------------------------------------
  // Usage / evaluation
  // ---------------------------------------------------------------------------------------------

  usageFor(dimension: BudgetDimension, now?: number): number | null {
    const at = typeof now === "number" ? now : this.now();
    switch (dimension) {
      case "promptWallClockMs": {
        let max = 0;
        for (const start of this.promptStarts.values()) {
          max = Math.max(max, at - start);
        }
        for (const duration of this.lastPromptDurations.values()) {
          max = Math.max(max, duration);
        }
        return Math.max(0, max);
      }
      case "promptsPerSkeleton": {
        let max = 0;
        for (const count of this.promptCounts.values()) {
          max = Math.max(max, count);
        }
        return max;
      }
      case "toolCallsPerTurn": {
        let max = 0;
        for (const count of this.turnToolCalls.values()) {
          max = Math.max(max, count);
        }
        return max;
      }
      case "toolCallsPerRun":
        return this.totalToolCalls;
      case "runWallClockMs":
        return this.runWallClockMs(at);
      case "contextPressurePercent":
        return this.contextPressurePercent;
      case "creditsPerRun":
        return this.creditsReported ? this.creditsRun : null;
      case "creditsPerDay":
        return this.creditsReported ? this.creditsDay : null;
      default:
        return null;
    }
  }

  usage(now?: number): BudgetUsage {
    return {
      promptWallClockMs: this.usageFor("promptWallClockMs", now) ?? 0,
      promptsPerSkeleton: this.usageFor("promptsPerSkeleton", now) ?? 0,
      toolCallsPerTurn: this.usageFor("toolCallsPerTurn", now) ?? 0,
      toolCallsPerRun: this.usageFor("toolCallsPerRun", now) ?? 0,
      runWallClockMs: this.usageFor("runWallClockMs", now) ?? 0,
      contextPressurePercent: this.usageFor("contextPressurePercent", now) ?? 0,
      creditsPerRun: this.usageFor("creditsPerRun", now),
      creditsPerDay: this.usageFor("creditsPerDay", now),
    };
  }

  snapshot(now?: number): BudgetSnapshot {
    const at = typeof now === "number" ? now : this.now();
    return {
      runId: this.runId,
      caps: this.getCaps(),
      usage: this.usage(at),
      pactWaitMs: this.pactWaitMs(at),
      warnings: this.getWarnings(),
      exceeded: this.getExceededDimensions(),
      exceededAny: this.exceededDimensions.size > 0,
      creditsReported: this.creditsReported,
      pendingAsk: this.pendingAsk,
      runOutcome: this.runOutcome,
    };
  }


  /**
   * Checks every capped dimension and emits `budget.warning` (once per dimension), then
   * `budget.exceeded` at 100 percent of any dimension while letting commands already running
   * finish cleanly (Requirements 30.5, 30.6, 30.21).
   */
  evaluate(now?: number): BudgetSnapshot {
    const at = typeof now === "number" ? now : this.now();
    for (const dim of BUDGET_DIMENSIONS) {
      const cap = this.caps.get(dim);
      if (cap === undefined) {
        continue;
      }
      const value = this.usageFor(dim, at);
      if (value === null) {
        continue;
      }
      if (value >= cap) {
        if (!this.exceededDimensions.has(dim)) {
          this.exceededDimensions.set(dim, value);
          this.pendingAsk = "exceed_budget";
          const data: Record<string, unknown> = {
            dimension: dim,
            usage: value,
            cap,
            ask: "exceed_budget",
          };
          if (dim === "contextPressurePercent") {
            data.action =
              value >= cap + this.contextCancelMarginPercent ? "cancel_turn" : "steer_wrap_up";
          }
          this.emit("budget.exceeded", data);
          if (dim === "creditsPerRun" || dim === "creditsPerDay") {
            this.handleCreditExhaustion(at);
          }
        }
      } else if (cap > 0 && value >= (cap * this.warningPercent) / 100) {
        if (!this.warningsEmitted.has(dim)) {
          this.warningsEmitted.add(dim);
          const data: Record<string, unknown> = {
            dimension: dim,
            usage: value,
            cap,
            warningPercent: this.warningPercent,
          };
          if (dim === "contextPressurePercent") {
            data.action = "steer_wrap_up";
          }
          this.emit("budget.warning", data);
        }
      }
    }
    return this.snapshot(at);
  }

  canDispatchPrompt(skeletonId: string, now?: number): BudgetDispatchGate {
    void skeletonId;
    this.evaluate(now);
    if (this.exceededDimensions.size > 0) {
      return {
        allowed: false,
        reason: "budget_exceeded",
        dimensions: this.getExceededDimensions(),
      };
    }
    return { allowed: true };
  }

  canDispatchSandboxExec(now?: number): BudgetDispatchGate {
    this.evaluate(now);
    if (this.exceededDimensions.size > 0) {
      return {
        allowed: false,
        reason: "budget_exceeded",
        dimensions: this.getExceededDimensions(),
      };
    }
    return { allowed: true };
  }

  /**
   * Ends the run with outcome `budget_stopped` when Kiro credits are exhausted, keeps the queue and
   * alerts the Owner (Requirements 30.19, 41.16).
   */
  handleCreditExhaustion(now?: number): void {
    if (this.creditExhaustionHandled) {
      return;
    }
    this.creditExhaustionHandled = true;
    this.runOutcome = "budget_stopped";
    const at = typeof now === "number" ? now : this.now();
    if (this.runStore) {
      try {
        if (this.runStore.getRun(this.runId)) {
          this.runStore.updateRun(this.runId, {
            outcome: "budget_stopped",
            phase: "done",
            endedAt: at,
          });
        }
      } catch {
        // The outcome is still surfaced through getRunOutcome even if no record exists.
      }
    }
    // The run is terminal once credits are exhausted, so record the phase transition and the
    // terminal `run.done` alongside the worker-state alert (Requirements 30.19, 41.16).
    this.emit("run.phase", { to: "done", reason: "credits_exhausted" });
    this.emit("run.done", {
      phase: "done",
      outcome: "budget_stopped",
      endedAt: at,
      reason: "credits_exhausted",
    });
    this.emit("system.worker_state", {
      state: "credits_exhausted",
      ownerAlert: true,
      runId: this.runId,
    });
  }

  markCreditExhausted(now?: number): void {
    this.handleCreditExhaustion(now);
  }

  /**
   * Grants a cap increase up to the invite-code ceiling and the global ceiling (Requirement 30.8).
   * The grant clears the dimension's exceeded flag only when usage is now below the new cap, so the
   * run may dispatch again exactly when no dimension remains exceeded (Property P20).
   */
  grantCapIncrease(
    dimension: BudgetDimension,
    newCap: number,
    input: GrantCapIncreaseInput
  ): GrantCapIncreaseResult {
    if (!isDimension(dimension)) {
      return { ok: false, code: "UNKNOWN_DIMENSION", dimension, newCap };
    }
    const previousCap = this.caps.get(dimension) ?? 0;
    if (typeof newCap !== "number" || !Number.isFinite(newCap) || newCap <= previousCap) {
      return { ok: false, code: "CAP_NOT_RAISED", dimension, newCap };
    }
    const ceiling = this.codeCeiling.get(dimension);
    if (ceiling !== undefined && newCap > ceiling) {
      return { ok: false, code: "CODE_CEILING_EXCEEDED", dimension, newCap, ceiling };
    }
    const global = this.globalCeiling.get(dimension);
    if (global !== undefined && newCap > global) {
      return { ok: false, code: "GLOBAL_CEILING_EXCEEDED", dimension, newCap, ceiling: global };
    }

    this.caps.set(dimension, newCap);
    const value = this.usageFor(dimension, input.now);
    if (value !== null && value < newCap) {
      this.exceededDimensions.delete(dimension);
    }
    // Re-arm the warning when the raised cap moves the usage ratio strictly below the warning
    // threshold, so crossing the new threshold later emits a fresh `budget.warning` (Requirement 30.5).
    if (value !== null && value < (newCap * this.warningPercent) / 100) {
      this.warningsEmitted.delete(dimension);
    }
    if (this.exceededDimensions.size === 0) {
      this.pendingAsk = null;
    }
    this.emit("budget.update", {
      dimension,
      previousCap,
      newCap,
      actor: input.actor,
      reason: input.reason,
      change: "cap_increase",
    });
    return { ok: true, dimension, previousCap, newCap };
  }

  private emit(kind: string, data: Record<string, unknown>): void {
    if (!this.eventStore) {
      return;
    }
    try {
      this.eventStore.append(
        redactEvent({
          runId: this.runId,
          kind,
          actor: "budget-governor",
          data: { refs: [], ...data },
        })
      );
    } catch {
      // Telemetry is best-effort and must never break dispatch.
    }
  }
}

