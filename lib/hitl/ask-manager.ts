// Task 21.2: Human-in-the-loop tier orchestration and AskManager.
// Requirements: 28.1-28.10.
//
// Tier 1: scope, cost and safety actions always need an explicit user decision.
// Tier 2: the Necromancer decides alone but records `necromancer.decision` with
// explicit evidence refs. Runtime asks, task splits and Pact revisions are
// routed through the active Planner session during the Legion phase.

import type { EventStore } from "../events/event-store";
import { checkBudgetIncreaseHardBlocks } from "../policy/hard-blocks";

export type HitlEventSink = Pick<EventStore, "append">;

export type AskKind =
  | "approve_command"
  | "exceed_budget"
  | "plan_change"
  | "stuck_after_rejections"
  | "conflict_choice"
  | "ambiguity"
  | "nothing_to_do"
  | "push_confirm";

export type AskStatus = "pending" | "answered" | "expired";

/** Design-defined options per ask kind (Requirement 28.9). */
export const ASK_OPTIONS: Readonly<Record<AskKind, readonly string[]>> = {
  approve_command: [
    "Approve once",
    "Approve this pattern for the run",
    "Deny",
    "Deny and lay to rest",
  ],
  exceed_budget: ["Raise the cap", "Finish current tasks only", "Stop now"],
  plan_change: ["Add it", "Skip it", "Stop"],
  stuck_after_rejections: ["Re-plan the task", "Skip it", "Stop the run"],
  conflict_choice: ["Prefer A", "Prefer B", "Let the Necromancer re-plan"],
  ambiguity: [],
  nothing_to_do: ["Plan anyway", "Stop"],
  push_confirm: ["Push", "Do not push"],
};

/** Default applied when an ask reaches its deadline unanswered (Requirement 28.7). */
export const ASK_DEFAULTS: Readonly<Record<AskKind, string>> = {
  approve_command: "Deny",
  exceed_budget: "Finish current tasks only",
  plan_change: "Skip it",
  stuck_after_rejections: "Skip it",
  conflict_choice: "Let the Necromancer re-plan",
  ambiguity: "evidence-backed candidate",
  nothing_to_do: "Stop",
  push_confirm: "Do not push",
};

/** Approval wait fallback when the approval-wait Required_Setting is unset. */
export const DEFAULT_APPROVAL_WAIT_MS = 120_000;

export interface ApprovalCard {
  approvalId: string;
  runId: string;
  commandText: string;
  cwd: string;
  riskClass: string;
  skeletonId: string;
  reason: string;
  expiresAt: number;
  options: readonly string[];
}

export interface AskRecord {
  askId: string;
  runId: string;
  kind: AskKind;
  question: string;
  options: readonly string[];
  defaultAction: string;
  refs: string[];
  status: AskStatus;
  raisedAt: number;
  expiresAt: number;
  skeletonId?: string;
  taskId?: string;
  answer?: string;
  answeredAt?: number;
  expiredAt?: number;
  effect?: string;
  card?: ApprovalCard;
}

export interface NecromancerDecision {
  decisionId: string;
  runId: string;
  action: string;
  refs: string[];
  summary: string;
  evidenceTag: "cited" | "no evidence cited";
  skeletonId?: string;
  taskId?: string;
  createdAt: number;
}

export interface ExpiredAskOutcome {
  askId: string;
  runId: string;
  kind: AskKind;
  defaultAction: string;
  effect: string;
}

export interface RouteResult {
  routed: boolean;
  plannerSessionId?: string;
  reason?: string;
}

export class AskManagerError extends Error {
  readonly code: string;
  constructor(message: string, code = "ASK_ERROR") {
    super(message);
    this.name = "AskManagerError";
    this.code = code;
    Object.setPrototypeOf(this, AskManagerError.prototype);
  }
}

export interface AskManagerOptions {
  eventStore: HitlEventSink;
  now?: () => number;
  approvalWaitMs?: number;
}

export interface RaiseAskInput {
  runId: string;
  kind: AskKind;
  question: string;
  options?: readonly string[];
  refs?: string[];
  skeletonId?: string;
  taskId?: string;
  expiresAt?: number;
  askId?: string;
}

export interface RequestApprovalInput {
  runId: string;
  commandText: string;
  cwd: string;
  riskClass: string;
  skeletonId: string;
  reason?: string;
  taskId?: string;
  expiresAt?: number;
  approvalId?: string;
}

export interface DecideInput {
  runId: string;
  action: string;
  refs?: string[];
  summary?: string;
  skeletonId?: string;
  taskId?: string;
  decisionId?: string;
}

/**
 * Orchestrates Tier 1 user approvals and Tier 2 Necromancer decisions.
 */
export class AskManager {
  private readonly eventStore: HitlEventSink;
  private readonly now: () => number;
  readonly approvalWaitMs: number;

  private readonly asks = new Map<string, AskRecord>();
  private readonly decisions = new Map<string, NecromancerDecision>();
  private readonly activePlannerSessions = new Map<string, string>();
  private askSeq = 0;
  private decisionSeq = 0;

  constructor(options: AskManagerOptions) {
    if (!options || !options.eventStore || typeof options.eventStore.append !== "function") {
      throw new AskManagerError(
        "AskManager requires an eventStore with append()",
        "INVALID_OPTIONS"
      );
    }
    this.eventStore = options.eventStore;
    this.now = options.now ?? (() => Date.now());
    this.approvalWaitMs = options.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS;
  }

  /** Tracks the active Planner session for a run (Requirement 28.6). */
  setActivePlannerSession(runId: string, sessionId: string): void {
    if (!runId || !sessionId) {
      throw new AskManagerError("runId and sessionId are required", "INVALID_INPUT");
    }
    this.activePlannerSessions.set(runId, sessionId);
  }

  clearActivePlannerSession(runId: string): void {
    this.activePlannerSessions.delete(runId);
  }

  private emit(
    runId: string,
    kind: string,
    actor: string,
    data: Record<string, unknown>,
    skeletonId?: string,
    taskId?: string
  ): void {
    const payload: {
      runId: string;
      kind: string;
      actor: string;
      data: Record<string, unknown>;
      ts: number;
      skeletonId?: string | null;
      taskId?: string | null;
    } = { runId, kind, actor, data, ts: this.now() };
    if (skeletonId !== undefined) payload.skeletonId = skeletonId;
    if (taskId !== undefined) payload.taskId = taskId;
    this.eventStore.append(payload);
  }

  /**
   * Tier 1: an explicit approval card with the exact command, cwd, risk class,
   * requesting Skeleton and expiry (Requirements 28.1, 28.8, 28.10).
   */
  requestApproval(input: RequestApprovalInput): ApprovalCard {
    if (!input.runId || !input.commandText || !input.cwd || !input.skeletonId) {
      throw new AskManagerError(
        "requestApproval requires runId, commandText, cwd and skeletonId",
        "INVALID_INPUT"
      );
    }
    this.askSeq += 1;
    const approvalId = input.approvalId ?? `${input.runId}:approval:${this.askSeq}`;
    const raisedAt = this.now();
    const expiresAt = input.expiresAt ?? raisedAt + this.approvalWaitMs;
    const options = ASK_OPTIONS.approve_command;

    const ask: AskRecord = {
      askId: approvalId,
      runId: input.runId,
      kind: "approve_command",
      question: `Approve command '${input.commandText}' in ${input.cwd}?`,
      options,
      defaultAction: ASK_DEFAULTS.approve_command,
      refs: [`cmd:${input.commandText}`],
      status: "pending",
      raisedAt,
      expiresAt,
      skeletonId: input.skeletonId,
      taskId: input.taskId,
    };
    const card: ApprovalCard = {
      approvalId,
      runId: input.runId,
      commandText: input.commandText,
      cwd: input.cwd,
      riskClass: input.riskClass,
      skeletonId: input.skeletonId,
      reason: input.reason ?? input.riskClass,
      expiresAt,
      options,
    };
    ask.card = card;
    this.asks.set(approvalId, ask);

    this.emit(
      input.runId,
      "approval.requested",
      "necromancer",
      {
        approvalId,
        commandText: input.commandText,
        cwd: input.cwd,
        riskClass: input.riskClass,
        skeletonId: input.skeletonId,
        reason: card.reason,
        expiresAt,
        options: [...options],
        refs: ask.refs,
      },
      input.skeletonId,
      input.taskId
    );
    return card;
  }

  /**
   * Tier 1: the user answers an approval card (Requirement 28.1). Returns the
   * resolved ask; "Deny and lay to rest" also marks the Skeleton for teardown.
   */
  resolveApproval(approvalId: string, decision: string): AskRecord {
    const ask = this.asks.get(approvalId);
    if (!ask || ask.kind !== "approve_command") {
      throw new AskManagerError(
        `Unknown approval '${approvalId}'`,
        "APPROVAL_NOT_FOUND"
      );
    }
    if (ask.status !== "pending") {
      throw new AskManagerError(
        `Approval '${approvalId}' is already ${ask.status}`,
        "APPROVAL_ALREADY_RESOLVED"
      );
    }
    const normalized = decision.trim();
    if (!ask.options.includes(normalized)) {
      throw new AskManagerError(
        `Decision '${decision}' is not one of the design-defined options (Requirement 28.9)`,
        "INVALID_DECISION"
      );
    }
    ask.status = "answered";
    ask.answer = normalized;
    ask.answeredAt = this.now();
    ask.effect = this.approvalEffect(normalized);

    this.emit(
      ask.runId,
      "approval.resolved",
      "user",
      {
        approvalId,
        decision: normalized,
        effect: ask.effect,
        skeletonId: ask.skeletonId,
        refs: ask.refs,
      },
      ask.skeletonId,
      ask.taskId
    );
    return ask;
  }

  private approvalEffect(decision: string): string {
    switch (decision) {
      case "Approve once":
        return "run_once";
      case "Approve this pattern for the run":
        return "pattern_approved";
      case "Deny and lay to rest":
        return "denied_lay_to_rest";
      default:
        return "denied";
    }
  }


  private effectFor(kind: AskKind, action: string): string {
    switch (kind) {
      case "approve_command":
        return action === "Deny and lay to rest" ? "denied_lay_to_rest" : "denied";
      case "exceed_budget":
        return action === "Stop now"
          ? "budget_stopped"
          : "finish_current_tasks_then_budget_stopped";
      case "plan_change":
        return "skipped_unaddressed";
      case "stuck_after_rejections":
        return "skipped";
      case "conflict_choice":
        return "re_plan";
      case "ambiguity":
        return "evidence_backed_candidate";
      case "nothing_to_do":
        return "stop";
      case "push_confirm":
        return "no_push";
      default:
        return "noop";
    }
  }

  /**
   * Raises a non-approval ask (budget, plan change, conflict, ambiguity,
   * nothing-to-do, push confirmation) and emits `ask.raised` (Requirement 28.9).
   */
  raiseAsk(input: RaiseAskInput): AskRecord {
    if (!input.runId || !input.kind || !input.question) {
      throw new AskManagerError(
        "raiseAsk requires runId, kind and question",
        "INVALID_INPUT"
      );
    }
    if (input.kind === "approve_command") {
      throw new AskManagerError(
        "Use requestApproval for approve_command asks",
        "INVALID_KIND"
      );
    }
    this.askSeq += 1;
    const askId = input.askId ?? `${input.runId}:ask:${this.askSeq}`;
    const raisedAt = this.now();
    const options =
      input.options && input.options.length > 0
        ? [...input.options]
        : [...ASK_OPTIONS[input.kind]];

    const ask: AskRecord = {
      askId,
      runId: input.runId,
      kind: input.kind,
      question: input.question,
      options,
      defaultAction: ASK_DEFAULTS[input.kind],
      refs: Array.isArray(input.refs) ? [...input.refs] : [],
      status: "pending",
      raisedAt,
      expiresAt: input.expiresAt ?? raisedAt + this.approvalWaitMs,
      skeletonId: input.skeletonId,
      taskId: input.taskId,
    };
    this.asks.set(askId, ask);

    this.emit(
      input.runId,
      "ask.raised",
      "necromancer",
      {
        askId,
        kind: input.kind,
        question: input.question,
        options,
        defaultAction: ask.defaultAction,
        expiresAt: ask.expiresAt,
        refs: ask.refs,
      },
      input.skeletonId,
      input.taskId
    );
    return ask;
  }

  /**
   * Records the user's answer to an ask and emits `ask.answered`.
   * Requirement 28.9: only the design-defined options are accepted.
   */
  answerAsk(askId: string, answer: string): AskRecord {
    const ask = this.asks.get(askId);
    if (!ask) {
      throw new AskManagerError(`Unknown ask '${askId}'`, "ASK_NOT_FOUND");
    }
    if (ask.kind === "approve_command") {
      throw new AskManagerError(
        "Resolve approve_command asks through resolveApproval",
        "INVALID_KIND"
      );
    }
    if (ask.status !== "pending") {
      throw new AskManagerError(
        `Ask '${askId}' is already ${ask.status}`,
        "ASK_ALREADY_RESOLVED"
      );
    }
    const normalized = answer.trim();
    if (!ask.options.includes(normalized)) {
      throw new AskManagerError(
        `Answer '${answer}' is not one of the design-defined options (Requirement 28.9)`,
        "INVALID_ANSWER"
      );
    }
    ask.status = "answered";
    ask.answer = normalized;
    ask.answeredAt = this.now();
    ask.effect = this.effectFor(ask.kind, normalized);

    this.emit(
      ask.runId,
      "ask.answered",
      "user",
      {
        askId,
        kind: ask.kind,
        answer: normalized,
        effect: ask.effect,
        refs: ask.refs,
      },
      ask.skeletonId,
      ask.taskId
    );
    return ask;
  }

  /**
   * Tier 2: a decision the Necromancer takes alone, emitted as
   * `necromancer.decision` with explicit evidence refs. An empty refs list is
   * tagged "no evidence cited" (Requirements 28.4, 28.5).
   */
  decide(input: DecideInput): NecromancerDecision {
    if (!input.runId || !input.action) {
      throw new AskManagerError("decide requires runId and action", "INVALID_INPUT");
    }
    this.decisionSeq += 1;
    const decisionId = input.decisionId ?? `${input.runId}:decision:${this.decisionSeq}`;
    const refs = Array.isArray(input.refs) ? [...input.refs] : [];
    const decision: NecromancerDecision = {
      decisionId,
      runId: input.runId,
      action: input.action,
      refs,
      summary: input.summary ?? input.action,
      evidenceTag: refs.length > 0 ? "cited" : "no evidence cited",
      createdAt: this.now(),
    };
    if (input.skeletonId) decision.skeletonId = input.skeletonId;
    if (input.taskId) decision.taskId = input.taskId;
    this.decisions.set(decisionId, decision);

    this.emit(
      input.runId,
      "necromancer.decision",
      "necromancer",
      {
        decisionId,
        action: input.action,
        summary: decision.summary,
        refs,
        evidenceTag: decision.evidenceTag,
      },
      input.skeletonId,
      input.taskId
    );
    return decision;
  }

  /**
   * Routes runtime asks, task splits and Pact revisions to the active Planner
   * session while the Legion phase is running (Requirement 28.6). The routing
   * itself is recorded as a Necromancer decision with evidence refs.
   */
  routeToPlanner(input: {
    runId: string;
    phase: string;
    subject: string;
    refs?: string[];
    plannerSessionId?: string;
  }): RouteResult {
    const sessionId =
      input.plannerSessionId ?? this.activePlannerSessions.get(input.runId);
    if (input.phase !== "legion") {
      return {
        routed: false,
        reason: `Planner routing only applies during the legion phase, got '${input.phase}'`,
      };
    }
    if (!sessionId) {
      return { routed: false, reason: "No active Planner session for this run" };
    }
    this.decide({
      runId: input.runId,
      action: "route_to_planner",
      summary: `Route '${input.subject}' to the active Planner session`,
      refs: input.refs && input.refs.length > 0 ? input.refs : [],
    });
    return { routed: true, plannerSessionId: sessionId };
  }

  /**
   * Tier 1 budget ask: raising the cap is refused in code when it exceeds the
   * ceiling; the other options finish current tasks or stop (Requirement 28.1,
   * 30.8).
   */
  resolveBudgetAsk(input: {
    askId: string;
    answer: string;
    currentCap: number;
    requestedCap?: number;
    codeCeiling?: number;
    globalCeiling?: number;
  }): AskRecord {
    const ask = this.asks.get(input.askId);
    if (!ask || ask.kind !== "exceed_budget") {
      throw new AskManagerError(
        `Unknown exceed_budget ask '${input.askId}'`,
        "ASK_NOT_FOUND"
      );
    }
    const normalized = input.answer.trim();
    if (normalized === "Raise the cap") {
      const block = checkBudgetIncreaseHardBlocks({
        dimension: "cap",
        currentCap: input.currentCap,
        requestedCap: input.requestedCap ?? input.currentCap,
        codeCeiling: input.codeCeiling,
        globalCeiling: input.globalCeiling,
      });
      if (block.blocked) {
        throw new AskManagerError(
          block.reason ?? "Budget ceiling increase refused",
          "HARD_BLOCK_BUDGET_CEILING"
        );
      }
    }
    return this.answerAsk(input.askId, normalized);
  }

  /**
   * Applies the design-specified defaults to every ask past its deadline.
   * Command/approval asks are denied; budget asks finish current tasks and then
   * stop; plan changes are skipped as unaddressed (Requirements 28.7, 28.10).
   */
  expireAsks(now?: number): ExpiredAskOutcome[] {
    const at = now ?? this.now();
    const outcomes: ExpiredAskOutcome[] = [];
    for (const ask of this.asks.values()) {
      if (ask.status !== "pending") continue;
      if (ask.expiresAt > at) continue;

      ask.status = "expired";
      ask.expiredAt = at;
      ask.answer = ask.defaultAction;
      const effect = this.effectFor(ask.kind, ask.defaultAction);
      ask.effect = effect;

      if (ask.kind === "approve_command") {
        this.emit(
          ask.runId,
          "approval.resolved",
          "necromancer",
          {
            approvalId: ask.askId,
            decision: ask.defaultAction,
            effect,
            reason: "deadline",
            skeletonId: ask.skeletonId,
            refs: ask.refs,
          },
          ask.skeletonId,
          ask.taskId
        );
      } else {
        this.emit(
          ask.runId,
          "ask.answered",
          "necromancer",
          {
            askId: ask.askId,
            kind: ask.kind,
            answer: ask.defaultAction,
            effect,
            reason: "deadline",
            refs: ask.refs,
          },
          ask.skeletonId,
          ask.taskId
        );
        if (ask.kind === "exceed_budget") {
          this.decide({
            runId: ask.runId,
            action: "finish_current_tasks_then_budget_stopped",
            summary: "Budget ask timed out; finish current tasks then budget_stopped",
            refs: ask.refs,
          });
        }
      }

      outcomes.push({
        askId: ask.askId,
        runId: ask.runId,
        kind: ask.kind,
        defaultAction: ask.defaultAction,
        effect,
      });
    }
    return outcomes;
  }

  getAsk(askId: string): AskRecord | undefined {
    return this.asks.get(askId);
  }

  getDecision(decisionId: string): NecromancerDecision | undefined {
    return this.decisions.get(decisionId);
  }

  pendingAsks(runId?: string): AskRecord[] {
    return [...this.asks.values()].filter(
      (a) => a.status === "pending" && (runId === undefined || a.runId === runId)
    );
  }
}


