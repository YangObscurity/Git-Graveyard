// Task 13.4: Pure merge rule implementation
// Requirements: 9.12, 25.6, 25.7, 25.8

import * as crypto from "node:crypto";
import { candidateSha256FromDiff } from "./candidate-hash";
import { checkMergeGateFromEvents, extractEventsFromSource } from "../warden/merge-gate";
import { EventStore } from "../events/event-store";
import { isCheckPassing } from "../warden/warden-review";
import type {
  TaskInput,
  VerdictInput,
  GateResultInput,
  MergeRuleOptions,
  MergeRuleResult,
  MergeStatus,
} from "./types";

/**
 * Computes deterministic SHA-256 hex digest for candidate diff text.
 * Must not hash the commit sha string any more.
 */
export function computeCandidateSha256(diffText: string): string {
  if (!diffText || typeof diffText !== "string" || /^[0-9a-f]{40}$/i.test(diffText.trim())) {
    return "";
  }
  return candidateSha256FromDiff(diffText);
}

/**
 * Normalizes SHA string for comparison.
 */
function normalizeSha(sha?: string): string {
  if (!sha || typeof sha !== "string") {
    return "";
  }
  return sha.trim().toLowerCase();
}

/**
 * Checks whether verdict candidateSha256 matches expected candidateSha256 recomputed from diff.
 */
export function isCandidateShaMatching(
  verdictSha256?: string,
  candidateSha?: string,
  candidateSha256?: string,
  verdictSha?: string,
  callerSuppliedSha256?: string
): boolean {
  const normVerdictSha256 = normalizeSha(verdictSha256);
  const normExpectedSha256 = normalizeSha(candidateSha256);
  const normCandidateSha = normalizeSha(candidateSha);

  if (!normCandidateSha) {
    return false;
  }

  if (!normVerdictSha256 || !normExpectedSha256) {
    return false;
  }

  if (normVerdictSha256 !== normExpectedSha256) {
    return false;
  }

  if (callerSuppliedSha256) {
    if (normalizeSha(callerSuppliedSha256) !== normExpectedSha256) {
      return false;
    }
  }

  return true;
}

/**
 * Inspects whether gate result is passing (ok = true).
 */
export function isGateResultPassing(
  gateResult?: GateResultInput | boolean | null
): boolean {
  if (gateResult === undefined || gateResult === null) {
    return false;
  }
  if (typeof gateResult === "boolean") {
    return false;
  }
  if (typeof gateResult === "object" && !Array.isArray(gateResult)) {
    return (gateResult as GateResultInput).ok === true;
  }
  return false;
}

/**
 * Extracts tree identifier from task or candidate.
 */
function extractTaskTree(task?: TaskInput | string | null): string | undefined {
  if (!task || typeof task !== "object") {
    return undefined;
  }
  if (typeof task.tree === "string" && task.tree.trim()) {
    return task.tree.trim();
  }
  if (typeof task.treeSha === "string" && task.treeSha.trim()) {
    return task.treeSha.trim();
  }
  if (typeof task.candidateTree === "string" && task.candidateTree.trim()) {
    return task.candidateTree.trim();
  }
  if (task.candidate && typeof task.candidate === "object") {
    const c = task.candidate as Record<string, unknown>;
    if (typeof c.tree === "string" && c.tree.trim()) {
      return c.tree.trim();
    }
    if (typeof c.treeSha === "string" && c.treeSha.trim()) {
      return c.treeSha.trim();
    }
  }
  return undefined;
}

/**
 * Extracts tree identifier from gate result.
 */
function extractGateTree(
  gateResult?: GateResultInput | boolean | null
): string | undefined {
  if (!gateResult || typeof gateResult !== "object") {
    return undefined;
  }
  if (typeof gateResult.tree === "string" && gateResult.tree.trim()) {
    return gateResult.tree.trim();
  }
  if (typeof gateResult.treeSha === "string" && gateResult.treeSha.trim()) {
    return gateResult.treeSha.trim();
  }
  if (typeof gateResult.candidateTree === "string" && gateResult.candidateTree.trim()) {
    return gateResult.candidateTree.trim();
  }
  if (gateResult.data && typeof gateResult.data === "object") {
    const d = gateResult.data as Record<string, unknown>;
    if (typeof d.tree === "string" && d.tree.trim()) {
      return d.tree.trim();
    }
    if (typeof d.treeSha === "string" && d.treeSha.trim()) {
      return d.treeSha.trim();
    }
  }
  if (gateResult.result && typeof gateResult.result === "object") {
    const r = gateResult.result as Record<string, unknown>;
    if (typeof r.tree === "string" && r.tree.trim()) {
      return r.tree.trim();
    }
    if (typeof r.treeSha === "string" && r.treeSha.trim()) {
      return r.treeSha.trim();
    }
  }
  return undefined;
}

/**
 * Extracts tree identifier from verdict.
 */
function extractVerdictTree(
  verdict?: VerdictInput | string | null
): string | undefined {
  if (!verdict || typeof verdict !== "object") {
    return undefined;
  }
  if (typeof verdict.tree === "string" && verdict.tree.trim()) {
    return verdict.tree.trim();
  }
  if (typeof verdict.treeSha === "string" && verdict.treeSha.trim()) {
    return verdict.treeSha.trim();
  }
  if (typeof verdict.candidateTree === "string" && verdict.candidateTree.trim()) {
    return verdict.candidateTree.trim();
  }
  return undefined;
}

/**
 * Evaluates the merge rule for a task, verdict, and gate result.
 * Pure function: takes a task, a verdict and a gate result, and returns merged
 * only when the verdict is approve, its candidateSha256 matches the candidate,
 * and the gate result is ok for the same tree. Every other path returns not merged
 * with a reason. No git calls.
 *
 * Requirements: 9.12, 25.6, 25.7, 25.8.
 */
export function mergeRule(
  taskOrOptions: TaskInput | MergeRuleOptions | string,
  verdictArg?: VerdictInput | string,
  gateResultArg?: GateResultInput | boolean
): MergeRuleResult {
  let task: TaskInput | string | undefined;
  let verdict: VerdictInput | string | undefined;
  let gateResult: GateResultInput | boolean | undefined;
  let explicitOptions: MergeRuleOptions | undefined;

  // Check if options object was provided as first argument
  if (
    verdictArg === undefined &&
    gateResultArg === undefined &&
    taskOrOptions &&
    typeof taskOrOptions === "object" &&
    ("task" in taskOrOptions ||
      "verdict" in taskOrOptions ||
      "gateResult" in taskOrOptions ||
      "expectedHeadSha" in taskOrOptions ||
      "currentHeadSha" in taskOrOptions ||
      "events" in taskOrOptions ||
      "eventStore" in taskOrOptions ||
      "eventSource" in taskOrOptions)
  ) {
    explicitOptions = taskOrOptions as MergeRuleOptions;
    task = explicitOptions.task ?? (taskOrOptions as TaskInput);
    verdict = explicitOptions.verdict;
    gateResult = explicitOptions.gateResult;
  } else {
    task = taskOrOptions as TaskInput | string;
    verdict = verdictArg;
    gateResult = gateResultArg;
  }

  const reasons: string[] = [];

  // Extract task / candidate info
  let taskId: string | undefined;
  let candidateSha: string | undefined = explicitOptions?.candidateSha;
  let emptyTaskIdRefused = false;

  if (typeof task === "string") {
    const trimmed = task.trim();
    if (trimmed === "") {
      emptyTaskIdRefused = true;
    } else if (/^[0-9a-f]{40}$/i.test(trimmed)) {
      candidateSha = candidateSha ?? trimmed;
    } else {
      taskId = trimmed;
      // Requirement (2): A taskId must never be used as a candidateSha (merge-rule.ts around lines 229-230).
    }
  } else if (task && typeof task === "object") {
    if (typeof task.id === "string" && task.id.trim() === "") {
      emptyTaskIdRefused = true;
    }
    if (typeof task.taskId === "string" && task.taskId.trim() === "") {
      emptyTaskIdRefused = true;
    }
    taskId = task.id ?? task.taskId;
    if (typeof taskId === "string" && taskId.trim() === "") {
      emptyTaskIdRefused = true;
    }
    if (typeof task.candidate === "string") {
      const cTrim = task.candidate.trim();
      if (/^[0-9a-f]{40}$/i.test(cTrim)) {
        candidateSha = candidateSha ?? cTrim;
      }
    } else if (task.candidate && typeof task.candidate === "object") {
      const c = task.candidate as Record<string, unknown>;
      candidateSha =
        candidateSha ??
        (typeof c.candidateSha === "string" ? c.candidateSha : undefined) ??
        (typeof c.sha === "string" ? c.sha : undefined);
    }
    candidateSha =
      candidateSha ??
      (typeof task.candidateSha === "string" ? task.candidateSha : undefined) ??
      (typeof task.sha === "string" ? task.sha : undefined);
  }

  if (explicitOptions && typeof (explicitOptions as Record<string, unknown>).taskId === "string") {
    if (((explicitOptions as Record<string, unknown>).taskId as string).trim() === "") {
      emptyTaskIdRefused = true;
    }
    taskId = taskId ?? ((explicitOptions as Record<string, unknown>).taskId as string);
  }

  let taskIdRejected = false;
  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    taskIdRejected = true;
    if (taskId === undefined) {
      reasons.push("Task ID is missing; taskId must be a non-empty string (Requirement 25.6, 25.7)");
    } else {
      reasons.push("Task ID is empty; empty taskId is refused (Requirement 25.6, 25.7)");
    }
  } else if (emptyTaskIdRefused) {
    taskIdRejected = true;
    reasons.push("Task ID is empty; empty taskId is refused (Requirement 25.6, 25.7)");
  }

  // Requirement (2): A taskId must never be used as a candidateSha
  if (candidateSha && taskId && candidateSha === taskId) {
    candidateSha = undefined;
  }

  // Recompute candidateSha256 from candidate diff
  const candidateDiff =
    (typeof explicitOptions?.diff === "string" ? explicitOptions.diff : undefined) ??
    (typeof explicitOptions?.diffText === "string" ? explicitOptions.diffText : undefined) ??
    (explicitOptions?.candidate && typeof explicitOptions.candidate === "object"
      ? (typeof (explicitOptions.candidate as Record<string, unknown>).diff === "string"
          ? ((explicitOptions.candidate as Record<string, unknown>).diff as string)
          : typeof (explicitOptions.candidate as Record<string, unknown>).diffText === "string"
            ? ((explicitOptions.candidate as Record<string, unknown>).diffText as string)
            : undefined)
      : undefined) ??
    (task && typeof task === "object"
      ? (typeof task.diff === "string" ? task.diff : undefined) ??
        (typeof task.diffText === "string" ? task.diffText : undefined) ??
        (task.candidate && typeof task.candidate === "object"
          ? (typeof (task.candidate as Record<string, unknown>).diff === "string"
              ? ((task.candidate as Record<string, unknown>).diff as string)
              : typeof (task.candidate as Record<string, unknown>).diffText === "string"
                ? ((task.candidate as Record<string, unknown>).diffText as string)
                : undefined)
          : undefined)
      : undefined);

  let expectedCandidateSha256: string | undefined;
  if (
    typeof candidateDiff === "string" &&
    candidateDiff.trim().length > 0 &&
    !/^[0-9a-f]{40}$/i.test(candidateDiff.trim())
  ) {
    expectedCandidateSha256 = candidateSha256FromDiff(candidateDiff);
  }

  const callerSuppliedSha256 =
    explicitOptions?.candidateSha256 ?? explicitOptions?.expectedCandidateSha256;

  // Extract verdict info
  let verdictStatus: string | undefined;
  let verdictCandidateSha: string | undefined;
  let verdictCandidateSha256: string | undefined;
  let verdictOk = true;
  let verdictApproved = false;

  if (!verdict) {
    reasons.push("Verdict is missing (Requirement 25.6)");
  } else if (typeof verdict === "string") {
    verdictApproved = false;
    reasons.push("Verdict must be a structured verdict object, not a bare string");
  } else if (typeof verdict === "object") {
    verdictStatus = String(verdict.verdict ?? verdict.status ?? "").trim().toLowerCase();
    if (verdict.ok === false || verdict.approved === false) {
      verdictOk = false;
    }
    verdictCandidateSha =
      typeof verdict.candidateSha === "string"
        ? verdict.candidateSha.trim()
        : typeof verdict.sha === "string"
        ? verdict.sha.trim()
        : undefined;
    verdictCandidateSha256 =
      typeof verdict.candidateSha256 === "string"
        ? verdict.candidateSha256.trim()
        : typeof verdict.sha256 === "string"
        ? verdict.sha256.trim()
        : undefined;

    let checksPassed = true;
    if ((verdict as any).checks !== undefined) {
      const checks = (verdict as any).checks;
      for (const checkName of ["install", "build", "accept", "tests"] as const) {
        const checkVal = checks && typeof checks === "object" ? checks[checkName] : undefined;
        if (!isCheckPassing(checkVal)) {
          checksPassed = false;
          reasons.push(
            `Warden verdict check '${checkName}' is not passing (Requirement 24.5)`
          );
        }
      }
    }

    verdictApproved = Boolean(verdictStatus === "approve" && verdictOk && checksPassed);
    if (!verdictApproved) {
      if (verdictStatus !== "approve" || !verdictOk) {
        reasons.push(
          `Verdict '${verdictStatus || "unknown"}' is not 'approve' (Requirement 25.6)`
        );
      }
    }
  }

  // 2. Check candidateSha present and candidateSha256 matches candidate (Requirement 25.6, 25.8)
  let candidateShaMatches = false;
  if (!candidateSha) {
    reasons.push("Candidate SHA is missing (Requirement 25.6)");
  }
  if (!expectedCandidateSha256) {
    reasons.push(
      "Candidate diff is missing; cannot recompute candidateSha256 (Requirement 25.6, 25.8)"
    );
  } else if (candidateSha) {
    let callerMatches = true;
    if (callerSuppliedSha256) {
      if (normalizeSha(callerSuppliedSha256) !== expectedCandidateSha256) {
        callerMatches = false;
        reasons.push(
          `Caller-supplied candidateSha256 '${callerSuppliedSha256}' does not match recomputed candidate diff hash '${expectedCandidateSha256}' (Requirement 25.8)`
        );
      }
    }

    const verdictMatches = isCandidateShaMatching(
      verdictCandidateSha256,
      candidateSha,
      expectedCandidateSha256,
      verdictCandidateSha,
      callerSuppliedSha256
    );

    if (!verdictMatches) {
      reasons.push(
        "Verdict candidateSha256 does not match candidate (Requirement 25.8)"
      );
    }

    candidateShaMatches = callerMatches && verdictMatches;
  }

  // 3. Check Grimoire Gate result is ok (Requirement 9.12, 25.7)
  const gatePassed = isGateResultPassing(gateResult);
  if (gateResult === undefined || gateResult === null) {
    reasons.push("Grimoire gate result is missing (Requirement 9.12, 25.7)");
  } else if (!gatePassed) {
    reasons.push("Grimoire syntax gate result is not ok (Requirement 9.12, 25.7)");
  }

  // 4. Check tree match (Requirement 9.12, 25.7)
  const taskTree = extractTaskTree(task) ?? explicitOptions?.tree;
  const gateTree = extractGateTree(gateResult) ?? explicitOptions?.gateTree;
  const verdictTree = extractVerdictTree(verdict) ?? explicitOptions?.verdictTree;
  let treeMatches = true;

  if (!taskTree) {
    treeMatches = false;
    reasons.push("Candidate tree is missing (Requirement 9.12, 25.7)");
  }
  if (!gateTree) {
    treeMatches = false;
    reasons.push("Gate result tree is missing (Requirement 9.12, 25.7)");
  }
  if (verdict && !verdictTree) {
    treeMatches = false;
    reasons.push("Verdict tree is missing (Requirement 9.12, 25.7)");
  }

  if (taskTree && gateTree && taskTree.trim().toLowerCase() !== gateTree.trim().toLowerCase()) {
    treeMatches = false;
    reasons.push(
      `Gate result is for tree '${gateTree}', but candidate is for tree '${taskTree}' (Requirement 9.12, 25.7)`
    );
  }
  if (taskTree && verdictTree && taskTree.trim().toLowerCase() !== verdictTree.trim().toLowerCase()) {
    treeMatches = false;
    reasons.push(
      `Verdict is for tree '${verdictTree}', but candidate is for tree '${taskTree}' (Requirement 9.12, 25.7)`
    );
  }

  // 5. Check Integration_Head movement if provided (Requirement 25.8)
  let headUnchanged = true;
  const currentHead =
    explicitOptions?.currentHeadSha ?? explicitOptions?.integrationHeadSha;
  const expectedHead =
    explicitOptions?.expectedHeadSha ?? explicitOptions?.expectedIntegrationHeadSha;

  if (currentHead || expectedHead) {
    if (!currentHead || !expectedHead || currentHead !== expectedHead) {
      headUnchanged = false;
      reasons.push(
        `Integration_Head moved during review or head SHA missing (expected ${expectedHead ?? "none"}, got ${currentHead ?? "none"}) (Requirement 25.8)`
      );
    }
  }

  // 6. Event replay from event source on every check (Requirement 25.7, Finding M-11)
  let eventsPreceded = false;
  let invalidEventSource = false;

  const rawTaskForEvents =
    (task && typeof task === "object" && !Array.isArray(task)
      ? (task as Record<string, unknown>)
      : undefined) ??
    (explicitOptions?.task &&
    typeof explicitOptions.task === "object" &&
    !Array.isArray(explicitOptions.task)
      ? (explicitOptions.task as Record<string, unknown>)
      : undefined);

  const optsForEvents = explicitOptions as Record<string, unknown> | undefined;

  const candidateSources = [
    optsForEvents?.events,
    optsForEvents?.eventStore,
    optsForEvents?.eventSource,
    rawTaskForEvents?.events,
    rawTaskForEvents?.eventStore,
    rawTaskForEvents?.eventSource,
  ].filter((c) => c !== undefined && c !== null);

  if (candidateSources.length === 0) {
    reasons.push(
      "No event source available for event replay; event source is required (Requirement 25.7)"
    );
  } else if (candidateSources.some((c) => !(c instanceof EventStore))) {
    invalidEventSource = true;
    reasons.unshift("event source must be an EventStore");
  } else {
    const optionsForExtraction: Record<string, unknown> = {
      ...(task && typeof task === "object" && !Array.isArray(task)
        ? { task, ...(task as Record<string, unknown>) }
        : {}),
      ...(explicitOptions as Record<string, unknown>),
    };
    if (!optionsForExtraction.task && task && typeof task === "object" && !Array.isArray(task)) {
      optionsForExtraction.task = task;
    }

    const targetRunId =
      (typeof optionsForExtraction.runId === "string" ? optionsForExtraction.runId : undefined) ??
      (rawTaskForEvents && typeof rawTaskForEvents.runId === "string" ? rawTaskForEvents.runId : undefined);

    const trimmedRunId = targetRunId ? targetRunId.trim() : "";

    if (!trimmedRunId) {
      eventsPreceded = false;
      reasons.push("EventStore replay requires an explicit non-empty runId");
    } else {
      const rawEvents = extractEventsFromSource(optionsForExtraction, trimmedRunId);

      if (rawEvents === null) {
        reasons.push(
          "No event source available for event replay; event source is required (Requirement 25.7)"
        );
      } else {
        const eventCheck = checkMergeGateFromEvents(rawEvents, {
          candidateSha,
          candidateSha256: expectedCandidateSha256,
          diff: candidateDiff,
          diffText: candidateDiff,
          tree: taskTree,
          taskId,
          runId: trimmedRunId,
        });
        eventsPreceded = eventCheck.ok;
        if (!eventCheck.ok) {
          reasons.push(...eventCheck.reasons);
        }
      }
    }
  }

  // Final evaluation
  const merged =
    verdictApproved &&
    candidateShaMatches &&
    gatePassed &&
    treeMatches &&
    headUnchanged &&
    eventsPreceded &&
    !taskIdRejected &&
    !invalidEventSource;

  const status: MergeStatus = merged ? "merged" : "not_merged";

  const res: MergeRuleResult = {
    merged,
    status,
    ok: merged,
    accepted: merged,
    reason: reasons.length > 0 ? reasons[0] : undefined,
    reasons,
    verdictApproved,
    candidateShaMatches,
    gatePassed,
    treeMatches,
    headUnchanged,
    candidateSha,
    candidateSha256: expectedCandidateSha256,
    taskId,
  };
  ((res as unknown) as Record<string, unknown>).eventsPreceded = eventsPreceded;

  return res;
}

export const checkMergeRule = mergeRule;
export const evaluateMergeRule = mergeRule;

export function isMergeAllowed(
  taskOrOptions: TaskInput | MergeRuleOptions | string,
  verdictArg?: VerdictInput | string,
  gateResultArg?: GateResultInput | boolean
): boolean {
  return mergeRule(taskOrOptions, verdictArg, gateResultArg).merged;
}

export const canMerge = isMergeAllowed;
export default mergeRule;
