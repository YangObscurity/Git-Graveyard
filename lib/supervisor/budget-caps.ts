// Budget caps (probe P5, 2026-11-11)
//
// `turn_completion` carries no credit or cost field, so a cap that waits for it
// never fires. The caps that can be enforced are wall clock and tool calls; a
// credit cap is honoured only when the stream reports credits, which kiro-cli
// 3.1.0 does per update (`_meta.kiro.credits`, spike S1).

export interface BudgetCapLimits {
  readonly maxWallClockMs: number;
  readonly maxToolCalls: number;
  /** Credit cap. Omit or null to leave credits uncapped. */
  readonly maxCredits?: number | null;
}

export type BudgetCapReason = "wall_clock" | "tool_calls" | "credits" | null;

export interface BudgetCapSnapshot {
  readonly wallClockMs: number;
  readonly toolCalls: number;
  readonly credits: number;
  readonly creditsReported: boolean;
  readonly exceeded: boolean;
  readonly reason: BudgetCapReason;
}

function isValidLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function collectCreditUsage(node: unknown, seen: Set<unknown>): number {
  if (!node || typeof node !== "object" || seen.has(node)) return 0;
  seen.add(node);

  let total = 0;
  if (Array.isArray(node)) {
    for (const item of node) total += collectCreditUsage(item, seen);
    return total;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "credits" && Array.isArray(value)) {
      for (const entry of value) {
        const usage = (entry as { usage?: unknown } | null)?.usage;
        if (typeof usage === "number" && Number.isFinite(usage)) total += usage;
      }
      continue;
    }
    total += collectCreditUsage(value, seen);
  }
  return total;
}

/**
 * Counts what a run can actually be capped on and reports the first cap hit.
 * Call `start()` when the session begins and `observe()` for every
 * session/update; `snapshot()` stays sticky once a cap is exceeded.
 */
export class BudgetCapTracker {
  private readonly limits: BudgetCapLimits;
  private readonly now: () => number;
  private startedAt: number;
  private toolCallIds: Set<string> = new Set();
  private anonymousToolCalls: number = 0;
  private credits: number = 0;
  private creditsReported: boolean = false;
  private reason: BudgetCapReason = null;

  constructor(limits: BudgetCapLimits, now: () => number = Date.now) {
    if (!isValidLimit(limits?.maxWallClockMs)) {
      throw new Error("maxWallClockMs must be a non-negative finite number");
    }
    if (!isValidLimit(limits?.maxToolCalls)) {
      throw new Error("maxToolCalls must be a non-negative finite number");
    }
    if (limits.maxCredits !== undefined && limits.maxCredits !== null && !isValidLimit(limits.maxCredits)) {
      throw new Error("maxCredits must be a non-negative finite number when given");
    }
    this.limits = limits;
    this.now = now;
    this.startedAt = now();
  }

  public start(at: number = this.now()): void {
    this.startedAt = at;
    this.toolCallIds.clear();
    this.anonymousToolCalls = 0;
    this.credits = 0;
    this.creditsReported = false;
    this.reason = null;
  }

  public observe(update: unknown): BudgetCapSnapshot {
    if (update && typeof update === "object") {
      const u = update as Record<string, unknown>;
      const toolCall = u.toolCall as Record<string, unknown> | undefined;

      const isToolCall =
        u.sessionUpdate === "tool_call" || u.kind === "tool_call" || (!!toolCall && !u.toolResult);
      if (isToolCall) {
        const id = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : undefined;
        if (id) this.toolCallIds.add(id);
        else this.anonymousToolCalls += 1;
      }

      const credits = collectCreditUsage(update, new Set());
      if (credits > 0) {
        this.credits += credits;
        this.creditsReported = true;
      }
    }
    return this.evaluate();
  }

  public snapshot(): BudgetCapSnapshot {
    return this.evaluate();
  }

  private evaluate(): BudgetCapSnapshot {
    const wallClockMs = Math.max(0, this.now() - this.startedAt);
    const toolCalls = this.toolCallIds.size + this.anonymousToolCalls;

    if (!this.reason) {
      if (wallClockMs > this.limits.maxWallClockMs) {
        this.reason = "wall_clock";
      } else if (toolCalls > this.limits.maxToolCalls) {
        this.reason = "tool_calls";
      } else if (
        this.limits.maxCredits !== undefined &&
        this.limits.maxCredits !== null &&
        this.creditsReported &&
        this.credits > this.limits.maxCredits
      ) {
        this.reason = "credits";
      }
    }

    return {
      wallClockMs,
      toolCalls,
      credits: this.credits,
      creditsReported: this.creditsReported,
      exceeded: this.reason !== null,
      reason: this.reason,
    };
  }
}
