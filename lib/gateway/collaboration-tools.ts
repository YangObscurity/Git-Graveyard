// Task 10.7: MCP collaboration tools
// Requirements: 19.2, 19.11, 19.12, 19.13, 19.15, 19.16, 19.17, 19.18

import * as crypto from "node:crypto";
import type {
  AcknowledgedMessage,
  AckMessageParams,
  AckMessageResult,
  AskParams,
  AskResult,
  ProposeTaskParams,
  ProposeTaskResult,
  QueuedAsk,
  ReasonWithRefs,
  ReportBlockerParams,
  ReportBlockerResult,
  ReportedBlocker,
  ReportTaskResultParams,
  ReportTaskResultResult,
  TaskProposal,
  ToolExecutionContext,
  TypedTaskResult,
  WardenVerdictParams,
  WardenVerdictRecord,
  WardenVerdictResult,
} from "./types";
import type { EventEmitCallback } from "./approval-manager";
import { redactEvent, redactText, redactValue } from "../security/redactor";

export type { ToolExecutionContext, ProposeTaskResult };

export interface WardenVerdictResultWithReasons extends WardenVerdictResult {
  reasons?: ReasonWithRefs[];
}

export interface TaskProposalWithReasons extends TaskProposal {
  reasons?: string[];
  reason?: string;
}

export interface ProposeTaskResultWithReasons extends ProposeTaskResult {
  reasons?: string[];
}

export interface PatchClaim {
  claimId: string;
  paths: string[];
  reason: string;
  skeletonId?: string;
  role?: string;
  runId?: string;
  status: "claimed";
  claimedAt: number;
}

export interface RulingRequest {
  rulingId: string;
  question: string;
  skeletonId?: string;
  role?: string;
  runId?: string;
  status: "pending";
  createdAt: number;
}

export interface ProgressReport {
  taskId: string;
  status: string;
  summary: string;
  refs: string[];
  skeletonId: string;
  role: string;
  runId?: string;
  recordedAt: number;
}

export interface ProgressReportParams {
  taskId?: string;
  status?: string;
  summary: string;
  refs?: string[];
  [key: string]: unknown;
}

export interface ProgressReportResult {
  success: boolean;
  taskId: string;
  status: string;
  summary: string;
  refs: string[];
  [key: string]: unknown;
}

export interface ClaimPatchParams {
  paths?: string[];
  files?: string[];
  reason: string;
  [key: string]: unknown;
}

export interface ClaimPatchResult {
  success: boolean;
  claimId: string;
  paths: string[];
  reason: string;
  [key: string]: unknown;
}

export interface RequestRulingParams {
  question: string;
  [key: string]: unknown;
}

export interface RequestRulingResult {
  recorded: boolean;
  message?: string;
  rulingId: string;
  question: string;
  [key: string]: unknown;
}

/**
 * Helper to emit events for collaboration tools.
 * Requirement N-B12: In emitEvent, redact the event payload with redactValue
 * and the event with redactEvent before invoking options.onEmitEvent.
 */
export async function emitEvent(
  first: CollaborationToolsOptions | Record<string, unknown> | undefined,
  second?: CollaborationToolsOptions | Record<string, unknown>
): Promise<void> {
  let options: CollaborationToolsOptions | undefined;
  let event: Record<string, unknown>;

  if (first && typeof (first as any).onEmitEvent === "function") {
    options = first as CollaborationToolsOptions;
    event = (second as Record<string, unknown>) ?? {};
  } else if (second && typeof (second as any).onEmitEvent === "function") {
    options = second as CollaborationToolsOptions;
    event = (first as Record<string, unknown>) ?? {};
  } else if (first && "kind" in first) {
    event = first as Record<string, unknown>;
    options = second as CollaborationToolsOptions | undefined;
  } else {
    options = first as CollaborationToolsOptions | undefined;
    event = (second as Record<string, unknown>) ?? {};
  }

  if (!options?.onEmitEvent) {
    return;
  }

  const copy = { ...event };
  if (copy.payload !== undefined && copy.payload !== null) {
    copy.payload = redactValue(copy.payload);
  }
  if (copy.data !== undefined && copy.data !== null) {
    copy.data = redactValue(copy.data);
  }
  const redactedEvent = redactEvent(copy);
  await options.onEmitEvent(redactedEvent as any);
}

/**
 * In-memory store for collaboration state: typed task results, warden verdicts,
 * queued questions, proposals, reported blockers, and message acknowledgements.
 */
export class CollaborationStore {
  private readonly asks: Map<string, QueuedAsk> = new Map();
  private readonly proposals: Map<string, TaskProposalWithReasons> = new Map();
  private readonly blockers: Map<string, ReportedBlocker> = new Map();
  private readonly taskResults: Map<string, TypedTaskResult> = new Map();
  private readonly acks: Map<string, AcknowledgedMessage> = new Map();
  private readonly verdicts: Map<string, WardenVerdictRecord> = new Map();
  private readonly claims: Map<string, PatchClaim> = new Map();
  private readonly rulings: Map<string, RulingRequest> = new Map();
  private readonly progressReports: Map<string, ProgressReport> = new Map();

  // --- Asks (Requirements 19.11, 19.18) ---

  enqueueAsk(ask: QueuedAsk): QueuedAsk {
    const question = redactText(ask.question);
    const stored = { ...ask, question };
    this.asks.set(stored.askId, stored);
    return stored;
  }

  getQueuedAsks(runId?: string): QueuedAsk[] {
    const all = Array.from(this.asks.values());
    return all.filter((a) => {
      const runMatches = !runId || a.runId === runId;
      return runMatches && a.status === "queued";
    });
  }

  getAllAsks(runId?: string): QueuedAsk[] {
    const all = Array.from(this.asks.values());
    if (!runId) return all;
    return all.filter((a) => a.runId === runId);
  }

  getAsk(askId: string): QueuedAsk | undefined {
    return this.asks.get(askId);
  }

  answerAsk(
    askId: string,
    answer: string,
    deliveryMethod: "steer" | "prompt"
  ): boolean {
    const existing = this.asks.get(askId);
    if (!existing) {
      return false;
    }
    existing.status = "answered";
    existing.answer = redactText(answer);
    existing.deliveryMethod = deliveryMethod;
    existing.answeredAt = Date.now();
    return true;
  }

  // --- Task Proposals (Requirement 19.13 & N-B12) ---

  recordProposal(proposal: TaskProposal & { reasons?: string[]; reason?: string }): TaskProposal {
    const title = typeof proposal.title === "string" ? redactText(proposal.title) : proposal.title;
    const reason =
      typeof proposal.reason === "string"
        ? redactText(proposal.reason)
        : proposal.reason;
    const reasons = Array.isArray(proposal.reasons)
      ? proposal.reasons.map((r) => (typeof r === "string" ? redactText(r) : redactText(String(r))))
      : proposal.reasons;
    const stored: TaskProposalWithReasons = {
      ...proposal,
      title,
      ...(proposal.reason !== undefined ? { reason } : {}),
      ...(proposal.reasons !== undefined ? { reasons } : {}),
    };
    this.proposals.set(stored.proposalId, stored);
    return stored;
  }

  recordTaskProposal(proposal: TaskProposal & { reasons?: string[]; reason?: string }): TaskProposal {
    return this.recordProposal(proposal);
  }

  getProposals(runId?: string): TaskProposalWithReasons[] {
    const all = Array.from(this.proposals.values());
    if (!runId) return all;
    return all.filter((p) => p.runId === runId);
  }

  getProposal(proposalId: string): TaskProposalWithReasons | undefined {
    return this.proposals.get(proposalId);
  }

  confirmProposal(proposalId: string): boolean {
    const prop = this.proposals.get(proposalId);
    if (!prop) return false;
    prop.status = "confirmed";
    prop.resolvedAt = Date.now();
    return true;
  }

  rejectProposal(proposalId: string, reason?: string): boolean {
    const prop = this.proposals.get(proposalId);
    if (!prop) return false;
    prop.status = "rejected";
    prop.resolutionReason = typeof reason === "string" ? redactText(reason) : reason;
    prop.resolvedAt = Date.now();
    return true;
  }

  // --- Blockers (Requirement 19.15) ---

  recordBlocker(blocker: ReportedBlocker): ReportedBlocker {
    const text = redactText(blocker.text);
    const kind = redactText(blocker.kind);
    const stored = { ...blocker, text, kind };
    this.blockers.set(stored.blockerId, stored);
    return stored;
  }

  getBlockers(runId?: string): ReportedBlocker[] {
    const all = Array.from(this.blockers.values());
    if (!runId) return all;
    return all.filter((b) => b.runId === runId);
  }

  getBlocker(blockerId: string): ReportedBlocker | undefined {
    return this.blockers.get(blockerId);
  }

  mitigateBlocker(blockerId: string, action?: string): boolean {
    const blk = this.blockers.get(blockerId);
    if (!blk) return false;
    blk.status = "mitigated";
    blk.mitigationAction = typeof action === "string" ? redactText(action) : action;
    blk.mitigatedAt = Date.now();
    return true;
  }

  // --- Task Results (Requirement 19.17) ---

  recordTaskResult(result: TypedTaskResult): TypedTaskResult {
    const key = result.runId ? `${result.runId}:${result.taskId}` : result.taskId;
    const summary = redactText(result.summary);
    const refs = Array.isArray(result.refs) ? result.refs.map((r) => redactText(r)) : [];
    const stored = { ...result, summary, refs };
    this.taskResults.set(key, stored);
    return stored;
  }

  getTaskResults(runId?: string): TypedTaskResult[] {
    const all = Array.from(this.taskResults.values());
    if (!runId) return all;
    return all.filter((r) => r.runId === runId);
  }

  getTaskResult(taskId: string, runId?: string): TypedTaskResult | undefined {
    if (runId) {
      return this.taskResults.get(`${runId}:${taskId}`);
    }
    const found = Array.from(this.taskResults.values()).find((r) => r.taskId === taskId);
    return found;
  }

  // --- Message Acknowledgements (Requirement 19.16) ---

  recordAck(ack: AcknowledgedMessage): AcknowledgedMessage {
    const key = ack.runId ? `${ack.runId}:${ack.msgId}` : ack.msgId;
    this.acks.set(key, { ...ack });
    return ack;
  }

  isMessageAcknowledged(msgId: string, runId?: string): boolean {
    if (runId) {
      return this.acks.has(`${runId}:${msgId}`);
    }
    for (const ack of this.acks.values()) {
      if (ack.msgId === msgId) return true;
    }
    return false;
  }

  getAcks(runId?: string): AcknowledgedMessage[] {
    const all = Array.from(this.acks.values());
    if (!runId) return all;
    return all.filter((a) => a.runId === runId);
  }

  // --- Warden Verdicts (Requirement 19.12) ---

  recordVerdict(verdict: WardenVerdictRecord): WardenVerdictRecord {
    const key = verdict.runId ? `${verdict.runId}:${verdict.target}` : verdict.target;
    const reasons = Array.isArray(verdict.reasons)
      ? verdict.reasons.map((r) => ({
          text: redactText(r.text),
          refs: Array.isArray(r.refs) ? r.refs.map((ref) => redactText(ref)) : [],
        }))
      : [];
    const refs = Array.isArray(verdict.refs)
      ? verdict.refs.map((ref) => redactText(ref))
      : reasons.flatMap((r) => r.refs);
    const stored = { ...verdict, reasons, refs };
    this.verdicts.set(key, stored);
    return stored;
  }

  getVerdicts(runId?: string): WardenVerdictRecord[] {
    const all = Array.from(this.verdicts.values());
    if (!runId) return all;
    return all.filter((v) => v.runId === runId);
  }

  getVerdict(target: string, runId?: string): WardenVerdictRecord | undefined {
    if (runId) {
      return this.verdicts.get(`${runId}:${target}`);
    }
    const found = Array.from(this.verdicts.values()).find((v) => v.target === target);
    return found;
  }

  // --- Patch Claims (Requirement N-B12) ---

  claimPaths(
    pathsOrClaim: string[] | { paths?: string[]; reason: string; runId?: string; skeletonId?: string; role?: string; [key: string]: unknown },
    reason?: string,
    context?: ToolExecutionContext
  ): PatchClaim {
    let paths: string[] = [];
    let recReason = reason ?? "";
    let runId: string | undefined = context?.runId;
    let skeletonId: string | undefined = context?.skeletonId;
    let role: string | undefined = context?.role;

    if (Array.isArray(pathsOrClaim)) {
      paths = pathsOrClaim;
    } else if (typeof pathsOrClaim === "object" && pathsOrClaim !== null) {
      paths = pathsOrClaim.paths ?? [];
      recReason = pathsOrClaim.reason ?? recReason;
      runId = pathsOrClaim.runId ?? runId;
      skeletonId = pathsOrClaim.skeletonId ?? skeletonId;
      role = (pathsOrClaim as any).role ?? role;
    }

    const claimId = `claim-${crypto.randomBytes(6).toString("hex")}`;
    const redactedPaths = paths.map((p) => redactText(p));
    const redactedReason = redactText(recReason);
    const record: PatchClaim = {
      claimId,
      paths: redactedPaths,
      reason: redactedReason,
      runId,
      skeletonId,
      role,
      status: "claimed",
      claimedAt: Date.now(),
    };

    const key = runId ? `${runId}:${claimId}` : claimId;
    this.claims.set(key, record);
    return record;
  }

  getClaims(runId?: string): PatchClaim[] {
    const all = Array.from(this.claims.values());
    if (!runId) return all;
    return all.filter((c) => c.runId === runId);
  }

  getClaim(claimId: string, runId?: string): PatchClaim | undefined {
    if (runId) {
      return this.claims.get(`${runId}:${claimId}`);
    }
    return Array.from(this.claims.values()).find((c) => c.claimId === claimId);
  }

  // --- Ruling Requests (Requirement N-B12) ---

  recordRulingRequest(
    questionOrRuling: string | { question: string; runId?: string; skeletonId?: string; role?: string; [key: string]: unknown },
    context?: ToolExecutionContext
  ): RulingRequest {
    let question = "";
    let runId: string | undefined = context?.runId;
    let skeletonId: string | undefined = context?.skeletonId;
    let role: string | undefined = context?.role;

    if (typeof questionOrRuling === "string") {
      question = questionOrRuling;
    } else if (typeof questionOrRuling === "object" && questionOrRuling !== null) {
      question = questionOrRuling.question ?? "";
      runId = questionOrRuling.runId ?? runId;
      skeletonId = questionOrRuling.skeletonId ?? skeletonId;
      role = questionOrRuling.role ?? role;
    }

    const rulingId = `ruling-${crypto.randomBytes(6).toString("hex")}`;
    const record: RulingRequest = {
      rulingId,
      question: redactText(question),
      runId,
      skeletonId,
      role,
      status: "pending",
      createdAt: Date.now(),
    };

    const key = runId ? `${runId}:${rulingId}` : rulingId;
    this.rulings.set(key, record);
    return record;
  }

  getRulingRequests(runId?: string): RulingRequest[] {
    const all = Array.from(this.rulings.values());
    if (!runId) return all;
    return all.filter((r) => r.runId === runId);
  }

  getRulingRequest(rulingId: string, runId?: string): RulingRequest | undefined {
    if (runId) {
      return this.rulings.get(`${runId}:${rulingId}`);
    }
    return Array.from(this.rulings.values()).find((r) => r.rulingId === rulingId);
  }

  // --- Progress Reports (Requirement N-B12) ---

  recordProgressReport(report: ProgressReport): ProgressReport {
    const key = report.runId ? `${report.runId}:${report.taskId}` : report.taskId;
    const summary = typeof report.summary === "string" ? redactText(report.summary) : redactText(String(report.summary ?? ""));
    const refs = Array.isArray(report.refs)
      ? report.refs.map((r) => (typeof r === "string" ? redactText(r) : redactText(String(r))))
      : [];
    const stored: ProgressReport = { ...report, summary, refs };
    this.progressReports.set(key, stored);
    return stored;
  }

  getProgressReports(runId?: string): ProgressReport[] {
    const all = Array.from(this.progressReports.values());
    if (!runId) return all;
    return all.filter((r) => r.runId === runId);
  }

  getProgressReport(taskId: string, runId?: string): ProgressReport | undefined {
    if (runId) {
      return this.progressReports.get(`${runId}:${taskId}`);
    }
    return Array.from(this.progressReports.values()).find((r) => r.taskId === taskId);
  }

  // --- Reset Store ---

  clear(): void {
    this.asks.clear();
    this.proposals.clear();
    this.blockers.clear();
    this.taskResults.clear();
    this.acks.clear();
    this.verdicts.clear();
    this.claims.clear();
    this.rulings.clear();
    this.progressReports.clear();
  }
}

export const defaultCollaborationStore = new CollaborationStore();

export interface CollaborationToolsOptions {
  onEmitEvent?: EventEmitCallback;
  collaborationStore?: CollaborationStore;
  throwOnError?: boolean;
}

export type CollaborationToolRefusal = {
  status: "refused";
  error: string;
  code: string;
};

/**
 * Validates and records typed task result.
 * Requirement 19.17.
 */
export async function handleReportTaskResult(
  params: ReportTaskResultParams,
  context: ToolExecutionContext,
  options?: CollaborationToolsOptions
): Promise<ReportTaskResultResult | CollaborationToolRefusal> {
  if (!params || typeof params.taskId !== "string" || !params.taskId.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid report_task_result: taskId must be a non-empty string");
    }
    return {
      status: "refused",
      error: "Invalid report_task_result: taskId must be a non-empty string",
      code: "INVALID_TASK_ID",
    };
  }
  if (typeof params.status !== "string" || !params.status.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid report_task_result: status must be a non-empty string");
    }
    return {
      status: "refused",
      error: "Invalid report_task_result: status must be a non-empty string",
      code: "INVALID_STATUS",
    };
  }
  if (typeof params.summary !== "string" || !params.summary.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid report_task_result: summary must be a non-empty string");
    }
    return {
      status: "refused",
      error: "Invalid report_task_result: summary must be a non-empty string",
      code: "INVALID_SUMMARY",
    };
  }

  const rawRefs = Array.isArray(params.refs)
    ? params.refs.filter((r) => typeof r === "string" && r.trim().length > 0)
    : [];
  const refs = rawRefs.map((r) => redactText(r.trim()));

  const redactedSummary = redactText(params.summary.trim());

  const store = options?.collaborationStore ?? defaultCollaborationStore;

  const typedResult: TypedTaskResult = {
    taskId: params.taskId.trim(),
    status: params.status.trim(),
    summary: redactedSummary,
    refs,
    skeletonId: context.skeletonId,
    role: context.role,
    runId: context.runId,
    recordedAt: Date.now(),
  };

  store.recordTaskResult(typedResult);

  if (context.runId) {
    await emitEvent(options, {
      kind: "task.state",
      runId: context.runId,
      actor: context.role.toLowerCase(),
      skeletonId: context.skeletonId,
      data: {
        taskId: params.taskId.trim(),
        status: params.status.trim(),
        summary: redactedSummary,
        refs,
      },
      payload: {
        taskId: params.taskId.trim(),
        status: params.status.trim(),
        summary: redactedSummary,
        refs,
      },
    });
  }

  return {
    success: true,
    taskId: params.taskId.trim(),
    status: params.status.trim(),
    summary: redactedSummary,
    refs,
  };
}

/**
 * Handles progress reports with mandatory redaction.
 * Requirement N-B12: In handleProgressReport, redact summary before storing and emitting.
 * Also redact returned/stored response strings where those user-supplied texts appear.
 */
export async function handleProgressReport(
  params: ProgressReportParams,
  contextOrOptions?: ToolExecutionContext | CollaborationToolsOptions,
  maybeOptions?: CollaborationToolsOptions
): Promise<ProgressReportResult | CollaborationToolRefusal> {
  const context: Partial<ToolExecutionContext> =
    maybeOptions !== undefined
      ? (contextOrOptions as ToolExecutionContext)
      : (contextOrOptions && "skeletonId" in contextOrOptions ? contextOrOptions : {});
  const options: CollaborationToolsOptions | undefined =
    maybeOptions !== undefined
      ? maybeOptions
      : (contextOrOptions && !("skeletonId" in contextOrOptions) ? contextOrOptions as CollaborationToolsOptions : undefined);

  if (!params || typeof params.summary !== "string" || !params.summary.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid progress_report: summary must be a non-empty string");
    }
    return {
      status: "refused",
      error: "Invalid progress_report: summary must be a non-empty string",
      code: "INVALID_SUMMARY",
    };
  }

  const redactedSummary = redactText(params.summary.trim());
  const taskId = typeof params.taskId === "string" && params.taskId.trim() ? params.taskId.trim() : "task-default";
  const status = typeof params.status === "string" && params.status.trim() ? params.status.trim() : "running";
  const rawRefs = Array.isArray(params.refs)
    ? params.refs.filter((r) => typeof r === "string" && r.trim().length > 0)
    : [];
  const refs = rawRefs.map((r) => redactText(r.trim()));

  const store = options?.collaborationStore ?? defaultCollaborationStore;

  const record: ProgressReport = {
    taskId,
    status,
    summary: redactedSummary,
    refs,
    skeletonId: context.skeletonId ?? "skel-default",
    role: context.role ?? "user",
    runId: context.runId,
    recordedAt: Date.now(),
  };

  store.recordProgressReport(record);
  store.recordTaskResult(record);

  if (context.runId) {
    await emitEvent(options, {
      kind: "progress.report",
      runId: context.runId,
      actor: context.role ? context.role.toLowerCase() : "user",
      skeletonId: context.skeletonId,
      data: {
        taskId,
        status,
        summary: redactedSummary,
        refs,
      },
      payload: {
        taskId,
        status,
        summary: redactedSummary,
        refs,
      },
    });
  }

  return {
    success: true,
    taskId,
    status,
    summary: redactedSummary,
    refs,
  };
}

/**
 * Handles patch claims with mandatory redaction.
 * Requirement N-B12: In handleClaimPatch, redact reason before calling store.claimPaths and emitting.
 * Also redact returned/stored response strings where those user-supplied texts appear.
 */
export async function handleClaimPatch(
  params: ClaimPatchParams,
  contextOrOptions?: ToolExecutionContext | CollaborationToolsOptions,
  maybeOptions?: CollaborationToolsOptions
): Promise<ClaimPatchResult | CollaborationToolRefusal> {
  const context: Partial<ToolExecutionContext> =
    maybeOptions !== undefined
      ? (contextOrOptions as ToolExecutionContext)
      : (contextOrOptions && "skeletonId" in contextOrOptions ? contextOrOptions : {});
  const options: CollaborationToolsOptions | undefined =
    maybeOptions !== undefined
      ? maybeOptions
      : (contextOrOptions && !("skeletonId" in contextOrOptions) ? contextOrOptions as CollaborationToolsOptions : undefined);

  if (!params || typeof params.reason !== "string" || !params.reason.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid claim_patch: reason must be a non-empty string");
    }
    return {
      status: "refused",
      error: "Invalid claim_patch: reason must be a non-empty string",
      code: "INVALID_REASON",
    };
  }

  const redactedReason = redactText(params.reason.trim());
  const rawPaths = Array.isArray(params.paths)
    ? params.paths.filter((p) => typeof p === "string" && p.trim().length > 0)
    : Array.isArray(params.files)
    ? params.files.filter((p) => typeof p === "string" && p.trim().length > 0)
    : [];
  const paths = rawPaths.map((p) => redactText(p.trim()));

  const store = options?.collaborationStore ?? defaultCollaborationStore;
  const claim = store.claimPaths(paths, redactedReason, context as ToolExecutionContext);

  if (context.runId) {
    await emitEvent(options, {
      kind: "claim.patch",
      runId: context.runId,
      actor: context.role ? context.role.toLowerCase() : "user",
      skeletonId: context.skeletonId,
      data: {
        claimId: claim.claimId,
        paths,
        reason: redactedReason,
        refs: [],
      },
      payload: {
        claimId: claim.claimId,
        paths,
        reason: redactedReason,
        refs: [],
      },
    });
  }

  return {
    success: true,
    claimId: claim.claimId,
    paths,
    reason: redactedReason,
  };
}

/**
 * Handles ruling requests with mandatory redaction.
 * Requirement N-B12: In handleRequestRuling, redact question before calling store.recordRulingRequest and emitting.
 * Also redact returned/stored response strings where those user-supplied texts appear.
 */
export async function handleRequestRuling(
  params: RequestRulingParams,
  contextOrOptions?: ToolExecutionContext | CollaborationToolsOptions,
  maybeOptions?: CollaborationToolsOptions
): Promise<RequestRulingResult | CollaborationToolRefusal> {
  const context: Partial<ToolExecutionContext> =
    maybeOptions !== undefined
      ? (contextOrOptions as ToolExecutionContext)
      : (contextOrOptions && "skeletonId" in contextOrOptions ? contextOrOptions : {});
  const options: CollaborationToolsOptions | undefined =
    maybeOptions !== undefined
      ? maybeOptions
      : (contextOrOptions && !("skeletonId" in contextOrOptions) ? contextOrOptions as CollaborationToolsOptions : undefined);

  if (!params || typeof params.question !== "string" || !params.question.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid request_ruling: question must be a non-empty string");
    }
    return {
      status: "refused",
      error: "Invalid request_ruling: question must be a non-empty string",
      code: "INVALID_QUESTION",
    };
  }

  const redactedQuestion = redactText(params.question.trim());
  const store = options?.collaborationStore ?? defaultCollaborationStore;
  const ruling = store.recordRulingRequest(redactedQuestion, context as ToolExecutionContext);

  if (context.runId) {
    await emitEvent(options, {
      kind: "request.ruling",
      runId: context.runId,
      actor: context.role ? context.role.toLowerCase() : "user",
      skeletonId: context.skeletonId,
      data: {
        rulingId: ruling.rulingId,
        question: redactedQuestion,
        refs: [],
      },
      payload: {
        rulingId: ruling.rulingId,
        question: redactedQuestion,
        refs: [],
      },
    });
  }

  return {
    recorded: true,
    message: "recorded; end your turn",
    rulingId: ruling.rulingId,
    question: redactedQuestion,
  };
}

/**
 * Validates presence of target, verdict of approve or reject, reasons each with refs,
 * and candidateSha256. Refuses call if any are missing or invalid.
 * Requirement 19.12.
 */
export async function handleWardenVerdict(
  params: WardenVerdictParams,
  context: ToolExecutionContext,
  options?: CollaborationToolsOptions
): Promise<WardenVerdictResultWithReasons | CollaborationToolRefusal> {
  // Validate target
  if (!params || typeof params.target !== "string" || !params.target.trim()) {
    return {
      status: "refused",
      error: "Missing or empty target in warden_verdict call",
      code: "INVALID_TARGET",
    };
  }

  // Validate verdict: must be strictly "approve" or "reject"
  if (params.verdict !== "approve" && params.verdict !== "reject") {
    return {
      status: "refused",
      error: "Invalid verdict: must be 'approve' or 'reject'",
      code: "INVALID_VERDICT",
    };
  }

  // Validate reasons: must be non-empty array where each item has non-empty refs array
  if (!Array.isArray(params.reasons) || params.reasons.length === 0) {
    return {
      status: "refused",
      error: "Missing or empty reasons array in warden_verdict call",
      code: "MISSING_REASONS",
    };
  }

  for (const r of params.reasons) {
    if (!r || typeof r.text !== "string" || !r.text.trim()) {
      return {
        status: "refused",
        error: "Each reason must have a non-empty text description",
        code: "INVALID_REASONS_FORMAT",
      };
    }
    if (!Array.isArray(r.refs) || r.refs.length === 0) {
      return {
        status: "refused",
        error: "Each reason must have a non-empty array of refs",
        code: "INVALID_REASONS_FORMAT",
      };
    }
    for (const ref of r.refs) {
      if (typeof ref !== "string" || !ref.trim()) {
        return {
          status: "refused",
          error: "Each ref in reason.refs must be a non-empty string",
          code: "INVALID_REF_FORMAT",
        };
      }
    }
  }

  // Validate candidateSha256
  if (
    typeof params.candidateSha256 !== "string" ||
    params.candidateSha256.trim().length === 0
  ) {
    return {
      status: "refused",
      error: "Missing candidateSha256 in warden_verdict call",
      code: "MISSING_CANDIDATE_SHA256",
    };
  }

  const redactedReasons: ReasonWithRefs[] = params.reasons.map((r) => ({
    text: redactText(r.text.trim()),
    refs: r.refs.map((ref) => redactText(ref.trim())),
  }));
  const allRefs = redactedReasons.flatMap((r) => r.refs);
  const store = options?.collaborationStore ?? defaultCollaborationStore;

  const verdictRecord: WardenVerdictRecord = {
    target: params.target.trim(),
    verdict: params.verdict,
    candidateSha256: params.candidateSha256.trim(),
    reasons: redactedReasons,
    refs: allRefs,
    skeletonId: context.skeletonId,
    runId: context.runId,
    recordedAt: Date.now(),
  };

  store.recordVerdict(verdictRecord);

  if (context.runId) {
    await emitEvent(options, {
      kind: "verdict",
      runId: context.runId,
      actor: "warden",
      skeletonId: context.skeletonId,
      data: {
        target: params.target.trim(),
        verdict: params.verdict,
        candidateSha256: params.candidateSha256.trim(),
        reasons: redactedReasons,
        refs: allRefs,
      },
      payload: {
        target: params.target.trim(),
        verdict: params.verdict,
        candidateSha256: params.candidateSha256.trim(),
        reasons: redactedReasons,
        refs: allRefs,
      },
    });
  }

  return {
    success: true,
    target: params.target.trim(),
    verdict: params.verdict,
    candidateSha256: params.candidateSha256.trim(),
    reasons: redactedReasons,
  };
}

/**
 * Returns immediately with "recorded; end your turn" while queuing the question
 * for answer delivery via steer or new prompt.
 * Requirements: 19.11, 19.18.
 */
export async function handleAsk(
  params: AskParams,
  context: ToolExecutionContext,
  options?: CollaborationToolsOptions
): Promise<AskResult> {
  const rawQuestion = typeof params?.question === "string" ? params.question.trim() : "";
  const question = redactText(rawQuestion);
  const askId = `ask-${crypto.randomBytes(6).toString("hex")}`;
  const store = options?.collaborationStore ?? defaultCollaborationStore;

  const queuedAsk: QueuedAsk = {
    askId,
    question,
    skeletonId: context.skeletonId,
    role: context.role,
    runId: context.runId,
    status: "queued",
    createdAt: Date.now(),
  };

  store.enqueueAsk(queuedAsk);

  if (context.runId) {
    await emitEvent(options, {
      kind: "ask.raised",
      runId: context.runId,
      actor: context.role.toLowerCase(),
      skeletonId: context.skeletonId,
      data: {
        askId,
        question,
        refs: [],
      },
      payload: {
        askId,
        question,
        refs: [],
      },
    });
  }

  return {
    message: "recorded; end your turn",
    recorded: true,
    question,
    askId,
  };
}

export interface DeliverAnswerOptions {
  deliveryMethod: "steer" | "prompt";
  steerHandler?: (correctionText: string) => Promise<void>;
  onEmitEvent?: EventEmitCallback;
}

/**
 * Delivers an answer to a previously queued ask via steer or new prompt.
 * Requirement 19.18.
 */
export async function deliverAskAnswer(
  askId: string,
  answer: string,
  deliveryOptions: DeliverAnswerOptions,
  options?: CollaborationToolsOptions
): Promise<{ success: boolean; askId: string; deliveryMethod: "steer" | "prompt"; answer?: string; error?: string }> {
  const store = options?.collaborationStore ?? defaultCollaborationStore;
  const ask = store.getAsk(askId);
  if (!ask) {
    return {
      success: false,
      askId,
      deliveryMethod: deliveryOptions.deliveryMethod,
      error: `Ask with id '${askId}' not found in collaboration store`,
    };
  }

  const redactedAnswer = redactText(answer);

  store.answerAsk(askId, redactedAnswer, deliveryOptions.deliveryMethod);

  if (deliveryOptions.deliveryMethod === "steer" && deliveryOptions.steerHandler) {
    await deliveryOptions.steerHandler(redactedAnswer);
  }

  const emitterOpts = {
    onEmitEvent: deliveryOptions.onEmitEvent ?? options?.onEmitEvent,
  };
  if (ask.runId) {
    await emitEvent(emitterOpts, {
      kind: "ask.answered",
      runId: ask.runId,
      actor: "necromancer",
      skeletonId: ask.skeletonId,
      data: {
        askId,
        question: ask.question,
        answer: redactedAnswer,
        deliveryMethod: deliveryOptions.deliveryMethod,
        refs: [],
      },
      payload: {
        askId,
        question: ask.question,
        answer: redactedAnswer,
        deliveryMethod: deliveryOptions.deliveryMethod,
        refs: [],
      },
    });
  }

  return {
    success: true,
    askId,
    deliveryMethod: deliveryOptions.deliveryMethod,
    answer: redactedAnswer,
  };
}

/**
 * Records blocker text and kind for mitigation.
 * Requirement 19.15.
 */
export async function handleReportBlocker(
  params: ReportBlockerParams,
  context: ToolExecutionContext,
  options?: CollaborationToolsOptions
): Promise<ReportBlockerResult | CollaborationToolRefusal> {
  if (!params || typeof params.text !== "string" || !params.text.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid report_blocker: text and kind must be strings");
    }
    return {
      status: "refused",
      error: "Invalid report_blocker: text must be a non-empty string",
      code: "INVALID_BLOCKER_TEXT",
    };
  }
  if (typeof params.kind !== "string" || !params.kind.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid report_blocker: text and kind must be strings");
    }
    return {
      status: "refused",
      error: "Invalid report_blocker: kind must be a non-empty string",
      code: "INVALID_BLOCKER_KIND",
    };
  }

  const blockerId = `blk-${crypto.randomBytes(6).toString("hex")}`;
  const store = options?.collaborationStore ?? defaultCollaborationStore;

  const redactedText = redactText(params.text.trim());
  const redactedKind = redactText(params.kind.trim());

  const blocker: ReportedBlocker = {
    blockerId,
    text: redactedText,
    kind: redactedKind,
    skeletonId: context.skeletonId,
    role: context.role,
    runId: context.runId,
    status: "reported",
    createdAt: Date.now(),
  };

  store.recordBlocker(blocker);

  if (context.runId) {
    await emitEvent(options, {
      kind: "skeleton.tool_result",
      runId: context.runId,
      actor: context.role.toLowerCase(),
      skeletonId: context.skeletonId,
      data: {
        tool: "report_blocker",
        blockerId,
        text: redactedText,
        blockerKind: redactedKind,
        refs: [],
      },
      payload: {
        tool: "report_blocker",
        blockerId,
        text: redactedText,
        blockerKind: redactedKind,
        refs: [],
      },
    });
  }

  return {
    recorded: true,
    blockerId,
    text: redactedText,
    kind: redactedKind,
  };
}

/**
 * Records proposals for user confirmation prior to scope changes.
 * Requirement 19.13 & N-B12.
 * In handleProposeTask, redact title, description, and each string in reasons
 * before calling store.recordTaskProposal and emitting.
 * Also redact returned/stored response strings where those user-supplied texts appear.
 */
export async function handleProposeTask(
  params: ProposeTaskParams,
  context: ToolExecutionContext,
  options?: CollaborationToolsOptions
): Promise<ProposeTaskResultWithReasons> {
  const rawTitle =
    typeof params?.title === "string" && params.title.trim().length > 0
      ? params.title.trim()
      : "Proposed Task";
  const redactedTitle = redactText(rawTitle);

  const rawDescription = typeof params?.description === "string" ? params.description : undefined;
  const redactedDescription = rawDescription !== undefined ? redactText(rawDescription) : undefined;

  let redactedReasons: string[] | undefined;
  if (Array.isArray(params?.reasons)) {
    redactedReasons = (params.reasons as unknown[]).map((r) =>
      typeof r === "string" ? redactText(r) : String(r)
    );
  } else if (typeof params?.reasons === "string") {
    redactedReasons = [redactText(params.reasons)];
  }

  const proposalId = `prop-${crypto.randomBytes(6).toString("hex")}`;
  const store = options?.collaborationStore ?? defaultCollaborationStore;

  const proposal: TaskProposal & { reasons?: string[] } = {
    proposalId,
    title: redactedTitle,
    description: redactedDescription,
    reasons: redactedReasons,
    skeletonId: context.skeletonId,
    role: context.role,
    runId: context.runId,
    status: "pending_confirmation",
    createdAt: Date.now(),
  };

  store.recordTaskProposal(proposal);

  if (context.runId) {
    await emitEvent(options, {
      kind: "skeleton.tool_result",
      runId: context.runId,
      actor: context.role.toLowerCase(),
      skeletonId: context.skeletonId,
      data: {
        tool: "propose_task",
        proposalId,
        title: redactedTitle,
        description: redactedDescription,
        ...(redactedReasons ? { reasons: redactedReasons } : {}),
        status: "pending_confirmation",
        refs: [],
      },
      payload: {
        tool: "propose_task",
        proposalId,
        title: redactedTitle,
        description: redactedDescription,
        ...(redactedReasons ? { reasons: redactedReasons } : {}),
        status: "pending_confirmation",
        refs: [],
      },
    });
  }

  return {
    recorded: true,
    proposalId,
    title: redactedTitle,
    description: redactedDescription,
    ...(redactedReasons ? { reasons: redactedReasons } : {}),
    status: "pending_confirmation",
  };
}

/**
 * Marks message as Acknowledged.
 * Requirement 19.16.
 */
export async function handleAckMessage(
  params: AckMessageParams,
  context: ToolExecutionContext,
  options?: CollaborationToolsOptions
): Promise<AckMessageResult | CollaborationToolRefusal> {
  if (!params || typeof params.msgId !== "string" || !params.msgId.trim()) {
    if (options?.throwOnError) {
      throw new Error("Invalid ack_message: msgId must be a non-empty string");
    }
    return {
      status: "refused",
      error: "Invalid ack_message: msgId must be a non-empty string",
      code: "INVALID_MSG_ID",
    };
  }

  const store = options?.collaborationStore ?? defaultCollaborationStore;

  const ack: AcknowledgedMessage = {
    msgId: params.msgId.trim(),
    skeletonId: context.skeletonId,
    role: context.role,
    runId: context.runId,
    acknowledgedAt: Date.now(),
  };

  store.recordAck(ack);

  if (context.runId) {
    await emitEvent(options, {
      kind: "message.acked",
      runId: context.runId,
      actor: context.role.toLowerCase(),
      skeletonId: context.skeletonId,
      data: {
        msgId: params.msgId.trim(),
        refs: [],
      },
      payload: {
        msgId: params.msgId.trim(),
        refs: [],
      },
    });
  }

  return {
    acknowledged: true,
    msgId: params.msgId.trim(),
  };
}
