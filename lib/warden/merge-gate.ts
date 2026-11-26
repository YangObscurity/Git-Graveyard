// Task 13.5: Merge gate pure function and candidate evaluation
// Requirements: 9.12, 25.6, 25.7, 25.8

import type {
  MergeGateOptions,
  MergeGateResult,
  MergeGateEventItem,
  GateResultInput,
  WardenVerdictRecord,
  WardenVerdictStatus,
} from "./types";
import { isCheckPassing, validateWardenVerdict } from "./warden-review";
import { candidateSha256FromDiff } from "../merge/candidate-hash";
import { EventStore } from "../events/event-store";

/**
 * Checks whether verdict candidateSha256 matches expected candidateSha256 recomputed from diff.
 * A caller-supplied hash is only compared, never used as the expected value.
 */
function isSha256Matching(
  verdictSha256?: string,
  expectedSha256?: string,
  callerSuppliedSha256?: string
): boolean {
  if (!verdictSha256 || !expectedSha256) {
    return false;
  }

  const normVerdict = verdictSha256.trim().toLowerCase();
  const normExpected = expectedSha256.trim().toLowerCase();

  if (normVerdict !== normExpected) {
    return false;
  }

  if (callerSuppliedSha256) {
    if (callerSuppliedSha256.trim().toLowerCase() !== normExpected) {
      return false;
    }
  }

  return true;
}

/**
 * Extracts events array from an EventStore instance.
 * Uses the EventStore public read method; returns null if no event source is available
 * or if the event source is not an EventStore instance.
 */
export function extractEventsFromSource(
  options: Record<string, unknown>,
  targetRunId?: string
): MergeGateEventItem[] | null {
  const rawTask =
    options.task && typeof options.task === "object" && !Array.isArray(options.task)
      ? (options.task as Record<string, unknown>)
      : undefined;

  const candidateSources = [
    options.events,
    options.eventStore,
    options.eventSource,
    rawTask?.events,
    rawTask?.eventStore,
    rawTask?.eventSource,
  ].filter((c) => c !== undefined && c !== null);

  if (candidateSources.length === 0) {
    return null;
  }

  // Refuse if any non-EventStore value is present
  if (candidateSources.some((c) => !(c instanceof EventStore))) {
    return null;
  }

  const store = candidateSources[0] as EventStore;
  const effectiveRunId =
    targetRunId ??
    (typeof options?.runId === "string" ? options.runId : undefined) ??
    (rawTask && typeof rawTask.runId === "string" ? rawTask.runId : undefined);

  if (!effectiveRunId || typeof effectiveRunId !== "string" || effectiveRunId.trim() === "") {
    return [];
  }

  try {
    return store.getEvents(effectiveRunId.trim()) as unknown as MergeGateEventItem[];
  } catch {
    return [];
  }
}

/**
 * Inspects whether gate result is passing (ok = true).
 */
export function isGatePassing(
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
 * Checks event history to ensure that an approve Verdict and a passing gate.result
 * both precede any task.state merged event in the EventStore.
 * Requirement 25.7.
 *
 * Rules:
 * - Only the latest verdict and the latest gate.result for the same taskId count.
 * - A later reject, or a later failed gate, invalidates an earlier approve.
 * - Events without a taskId are ignored.
 * - gate.result and verdict events must carry the candidate tree.
 * - When either tree is missing, reject.
 */
export function checkMergeGateFromEvents(
  events: readonly MergeGateEventItem[] | MergeGateEventItem[] | EventStore,
  options: {
    candidateSha?: string;
    candidateSha256?: string;
    diff?: string;
    diffText?: string;
    tree?: string;
    taskId?: string;
    runId?: string;
    targetRunId?: string;
    task?: unknown;
  } = {}
): {
  ok: boolean;
  verdictApproved: boolean;
  gatePassed: boolean;
  eventsPreceded: boolean;
  reasons: string[];
} {
  let eventList: readonly MergeGateEventItem[];
  if (events instanceof EventStore) {
    const rawTask =
      options?.task && typeof options.task === "object" && !Array.isArray(options.task)
        ? (options.task as Record<string, unknown>)
        : undefined;
    const effectiveRunId =
      (options as any)?.targetRunId ??
      (typeof options?.runId === "string" ? options.runId : undefined) ??
      (rawTask && typeof rawTask.runId === "string" ? rawTask.runId : undefined);

    if (!effectiveRunId || typeof effectiveRunId !== "string" || effectiveRunId.trim() === "") {
      return {
        ok: false,
        verdictApproved: false,
        gatePassed: false,
        eventsPreceded: false,
        reasons: ["EventStore replay requires an explicit non-empty runId"],
      };
    }
    try {
      eventList = events.getEvents(effectiveRunId.trim()) as unknown as MergeGateEventItem[];
    } catch {
      eventList = [];
    }
  } else if (Array.isArray(events)) {
    eventList = events;
  } else {
    eventList = [];
  }
  const reasons: string[] = [];
  let approvedVerdictIndex = -1;
  let passingGateIndex = -1;
  let mergedStateIndex = -1;
  let latestVerdictApproved = false;
  let latestGatePassed = false;

  let taskIdRejected = false;
  if (typeof options.taskId !== "string" || options.taskId.trim() === "") {
    taskIdRejected = true;
    if (options.taskId === undefined) {
      reasons.push("Task ID is missing; taskId must be a non-empty string (Requirement 25.6, 25.7)");
    } else {
      reasons.push("Task ID is empty; empty taskId is refused (Requirement 25.6, 25.7)");
    }
  }

  const candidateDiff =
    typeof options.diff === "string"
      ? options.diff
      : typeof options.diffText === "string"
        ? options.diffText
        : undefined;

  const targetSha256 =
    typeof candidateDiff === "string"
      ? candidateSha256FromDiff(candidateDiff)
      : undefined;

  if (!targetSha256) {
    reasons.push(
      "Candidate diff is missing; cannot recompute candidateSha256 in event replay (Requirement 25.6, 25.8)"
    );
  }

  if (!options.tree) {
    reasons.push("Candidate tree is missing in event replay options (Requirement 9.12, 25.7)");
  }

  for (let i = 0; i < eventList.length; i++) {
    const ev = eventList[i];
    if (!ev || typeof ev !== "object") continue;

    const kind = ev.kind;
    const data = (ev.data ?? {}) as Record<string, unknown>;

    // Events without a taskId are ignored (merge-gate.ts around lines 114-131 and 145-146)
    const evTaskId = ev.taskId ?? data.taskId ?? data.target;
    if (!evTaskId || typeof evTaskId !== "string" || evTaskId.trim() === "") {
      continue;
    }

    // Match task ID if specified
    if (options.taskId && evTaskId !== options.taskId) {
      continue;
    }

    // Check for verdict event
    if (kind === "verdict") {
      const v = String(data.verdict ?? "").toLowerCase().trim();
      const evSha256 = String(data.candidateSha256 ?? "").trim().toLowerCase();
      const evTree =
        typeof data.tree === "string" && data.tree.trim()
          ? data.tree.trim()
          : typeof data.candidateTree === "string" && data.candidateTree.trim()
            ? data.candidateTree.trim()
            : undefined;

      const treeMatches = Boolean(
        options.tree && evTree && evTree.toLowerCase() === options.tree.toLowerCase()
      );
      const shaMatches = Boolean(
        targetSha256 && evSha256 && evSha256 === targetSha256
      );

      if (v === "approve" && shaMatches && treeMatches) {
        approvedVerdictIndex = i;
        latestVerdictApproved = true;
      } else {
        // A later reject, or mismatch, invalidates an earlier approve
        approvedVerdictIndex = -1;
        latestVerdictApproved = false;
      }
    }

    // Check for gate.result event
    if (kind === "gate.result") {
      const ok =
        data.ok === true ||
        (data.result &&
          typeof data.result === "object" &&
          (data.result as Record<string, unknown>).ok === true);
      const evTree =
        typeof data.tree === "string" && data.tree.trim()
          ? data.tree.trim()
          : typeof data.candidateTree === "string" && data.candidateTree.trim()
            ? data.candidateTree.trim()
            : undefined;

      const treeMatches = Boolean(
        options.tree && evTree && evTree.toLowerCase() === options.tree.toLowerCase()
      );

      if (ok && treeMatches) {
        passingGateIndex = i;
        latestGatePassed = true;
      } else {
        // A later failed gate invalidates an earlier passing gate
        passingGateIndex = -1;
        latestGatePassed = false;
      }
    }

    // Check for task.state merged event
    if (kind === "task.state" && data.state === "merged") {
      mergedStateIndex = i;
    }
  }

  const verdictApproved = approvedVerdictIndex !== -1 && latestVerdictApproved;
  const gatePassed = passingGateIndex !== -1 && latestGatePassed;

  if (!verdictApproved) {
    reasons.push(
      "Missing preceding 'approve' verdict event with matching candidateSha256 and tree in EventStore (Requirement 25.7)"
    );
  }

  if (!gatePassed) {
    reasons.push(
      "Missing preceding 'gate.result' event with ok = true and matching tree in EventStore (Requirement 25.7)"
    );
  }

  let eventsPreceded = true;
  if (mergedStateIndex !== -1) {
    if (approvedVerdictIndex === -1 || approvedVerdictIndex > mergedStateIndex) {
      eventsPreceded = false;
      reasons.push(
        "Approve verdict event does not precede task.state merged event in EventStore (Requirement 25.7)"
      );
    }
    if (passingGateIndex === -1 || passingGateIndex > mergedStateIndex) {
      eventsPreceded = false;
      reasons.push(
        "Gate result event does not precede task.state merged event in EventStore (Requirement 25.7)"
      );
    }
  }

  const ok =
    verdictApproved &&
    gatePassed &&
    eventsPreceded &&
    Boolean(options.tree) &&
    Boolean(targetSha256) &&
    !taskIdRejected;

  return {
    ok,
    verdictApproved,
    gatePassed,
    eventsPreceded,
    reasons,
  };
}

/**
 * Pure function merge gate that accepts a task only when the verdict is approve
 * with a matching candidateSha256, matching tree, and a passing gate result.
 * Requirements: 9.12, 25.6, 25.7, 25.8.
 */
export function checkMergeGate(
  verdictOrOptions:
    | MergeGateOptions
    | WardenVerdictRecord
    | {
        verdict?: WardenVerdictStatus | string;
        candidateSha256?: string;
        candidateSha?: string;
        diff?: string;
        diffText?: string;
        tree?: string;
        [key: string]: unknown;
      }
    | WardenVerdictStatus
    | string,
  candidateShaOr256?: string,
  gateResultArg?: GateResultInput | boolean
): MergeGateResult {
  let opts: MergeGateOptions = {};

  if (
    typeof verdictOrOptions === "string" &&
    (candidateShaOr256 !== undefined || gateResultArg !== undefined)
  ) {
    // Positional signature: (verdictString, candidateShaOr256, gateResult)
    opts = {
      verdict: verdictOrOptions,
      candidateSha: candidateShaOr256,
      gateResult: gateResultArg,
    };
  } else if (
    verdictOrOptions &&
    typeof verdictOrOptions === "object" &&
    ("candidateSha" in verdictOrOptions ||
      "gateResult" in verdictOrOptions ||
      "expectedCandidateSha256" in verdictOrOptions ||
      "expectedHeadSha" in verdictOrOptions ||
      "events" in verdictOrOptions ||
      "eventStore" in verdictOrOptions ||
      "eventSource" in verdictOrOptions ||
      "taskId" in verdictOrOptions ||
      "task" in verdictOrOptions ||
      "diff" in verdictOrOptions ||
      "tree" in verdictOrOptions)
  ) {
    // Full options object
    opts = verdictOrOptions as MergeGateOptions;
  } else if (verdictOrOptions && typeof verdictOrOptions === "object") {
    // Verdict record object passed as first arg
    opts = {
      verdict: verdictOrOptions as WardenVerdictRecord,
      candidateSha: candidateShaOr256,
      gateResult: gateResultArg,
    };
  } else {
    opts = {
      verdict: String(verdictOrOptions),
      candidateSha: candidateShaOr256,
      gateResult: gateResultArg,
    };
  }

  const reasons: string[] = [];

  let taskIdRejected = false;
  const rawTaskId =
    opts.taskId ??
    (opts.task && typeof opts.task === "object"
      ? opts.task.id ?? (opts.task as Record<string, unknown>).taskId
      : undefined);

  if (typeof rawTaskId !== "string" || rawTaskId.trim() === "") {
    taskIdRejected = true;
    if (rawTaskId === undefined) {
      reasons.push("Task ID is missing; taskId must be a non-empty string (Requirement 25.6, 25.7)");
    } else {
      reasons.push("Task ID is empty; empty taskId is refused (Requirement 25.6, 25.7)");
    }
  }
  if (opts.task && typeof opts.task === "object") {
    if (typeof opts.task.id === "string" && opts.task.id.trim() === "") {
      taskIdRejected = true;
      if (!reasons.some((r) => r.includes("empty taskId is refused"))) {
        reasons.push("Task ID is empty; empty taskId is refused (Requirement 25.6, 25.7)");
      }
    }
    const tObj = opts.task as Record<string, unknown>;
    if (typeof tObj.taskId === "string" && (tObj.taskId as string).trim() === "") {
      taskIdRejected = true;
      if (!reasons.some((r) => r.includes("empty taskId is refused"))) {
        reasons.push("Task ID is empty; empty taskId is refused (Requirement 25.6, 25.7)");
      }
    }
  }

  // Extract verdict details
  let verdictStatus: string | undefined = undefined;
  let verdictCandidateSha256: string | undefined = undefined;
  let verdictTree: string | undefined = opts.verdictTree;

  if (typeof opts.verdict === "string") {
    verdictStatus = opts.verdict.toLowerCase().trim();
  } else if (opts.verdict && typeof opts.verdict === "object") {
    const vObj = opts.verdict as Record<string, unknown>;
    verdictStatus = String(vObj.verdict ?? vObj.status ?? "").toLowerCase().trim();
    verdictCandidateSha256 =
      typeof vObj.candidateSha256 === "string" ? vObj.candidateSha256.trim() : undefined;
    verdictTree =
      (typeof vObj.tree === "string" && vObj.tree.trim()
        ? vObj.tree.trim()
        : undefined) ??
      (typeof vObj.candidateTree === "string" && vObj.candidateTree.trim()
        ? vObj.candidateTree.trim()
        : undefined) ??
      verdictTree;
  }

  // Requirement (2): A verdict must not supply its own candidateSha as the value to compare against (merge-gate.ts around line 274).
  const candidateSha =
    opts.candidateSha ??
    (opts.candidate && typeof opts.candidate === "object"
      ? ((opts.candidate as Record<string, unknown>).candidateSha as string | undefined) ??
        ((opts.candidate as Record<string, unknown>).sha as string | undefined)
      : undefined);

  // Requirement (1): Every expected candidateSha256 is recomputed from the candidate;
  // a caller-supplied hash is only compared, never used as the expected value.
  const candidateDiff =
    (typeof opts.diff === "string" ? opts.diff : undefined) ??
    (typeof opts.diffText === "string" ? opts.diffText : undefined) ??
    (opts.candidate && typeof opts.candidate === "object"
      ? (typeof (opts.candidate as Record<string, unknown>).diff === "string"
          ? ((opts.candidate as Record<string, unknown>).diff as string)
          : typeof (opts.candidate as Record<string, unknown>).diffText === "string"
            ? ((opts.candidate as Record<string, unknown>).diffText as string)
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

  const callerSuppliedSha256 = opts.candidateSha256 ?? opts.expectedCandidateSha256;

  // 1. Verify Verdict is "approve" (Requirement 25.6)
  const verdictApproved = verdictStatus === "approve";
  if (!verdictApproved) {
    reasons.push(
      `Verdict '${verdictStatus ?? "none"}' is not 'approve' (Requirement 25.6)`
    );
  }

  // 1b. N-A1: validate the Warden verdict record with validateWardenVerdict
  // (Requirements 24.7, 24.16). A bare approve string, or a record that omits
  // the required fields, never passes the merge gate.
  const verdictRecordValid = validateWardenVerdict(opts.verdict);
  if (!verdictRecordValid.valid) {
    reasons.push(...verdictRecordValid.reasons);
  }

  // 1c. N-A4: the install, build, accept, and tests checks carried by the
  // verdict must each pass (Requirement 24.5, inspected with isCheckPassing).
  // A failed, missing, or malformed check refuses the merge.
  const verdictChecks =
    opts.verdict && typeof opts.verdict === "object"
      ? ((opts.verdict as Record<string, unknown>).checks as
          | Record<string, unknown>
          | undefined)
      : undefined;

  let checksPassed = true;
  for (const checkName of ["install", "build", "accept", "tests"] as const) {
    if (!isCheckPassing(verdictChecks?.[checkName])) {
      checksPassed = false;
      reasons.push(
        `Warden verdict check '${checkName}' is not passing (Requirement 24.5)`
      );
    }
  }

  // 2. Verify candidateSha and candidateSha256 matches (Requirement 25.6, 25.8)
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
      if (callerSuppliedSha256.trim().toLowerCase() !== expectedCandidateSha256) {
        callerMatches = false;
        reasons.push(
          `Caller-supplied candidateSha256 '${callerSuppliedSha256}' does not match recomputed candidate diff hash '${expectedCandidateSha256}' (Requirement 25.8)`
        );
      }
    }

    const verdictMatches = isSha256Matching(
      verdictCandidateSha256,
      expectedCandidateSha256,
      callerSuppliedSha256
    );

    if (!verdictMatches) {
      reasons.push(
        "Verdict candidateSha256 does not match Candidate sha256 (Requirement 25.8)"
      );
    }

    candidateShaMatches = callerMatches && verdictMatches;
  }

  // 3. Verify Grimoire Gate passed (Requirement 25.7)
  let gatePassed = isGatePassing(opts.gateResult);
  if (opts.gateResult === undefined || opts.gateResult === null) {
    reasons.push("Grimoire syntax gate failed or missing (Requirement 25.7)");
  } else if (!gatePassed) {
    reasons.push("Grimoire syntax gate failed or missing (Requirement 25.7)");
  }

  // 4. Tree binding check (Requirement 9.12, 25.7)
  const candidateTree =
    (typeof opts.tree === "string" && opts.tree.trim() ? opts.tree.trim() : undefined) ??
    (opts.candidate && typeof opts.candidate === "object"
      ? (typeof (opts.candidate as Record<string, unknown>).tree === "string" &&
        (opts.candidate as Record<string, unknown>).tree
          ? ((opts.candidate as Record<string, unknown>).tree as string).trim()
          : undefined)
      : undefined);

  let gateTree: string | undefined =
    typeof opts.gateTree === "string" && opts.gateTree.trim() ? opts.gateTree.trim() : undefined;

  if (opts.gateResult && typeof opts.gateResult === "object") {
    const gr = opts.gateResult as Record<string, unknown>;
    gateTree =
      (typeof gr.tree === "string" && gr.tree.trim() ? gr.tree.trim() : undefined) ??
      (typeof gr.treeSha === "string" && gr.treeSha.trim() ? gr.treeSha.trim() : undefined) ??
      (typeof gr.candidateTree === "string" && gr.candidateTree.trim()
        ? gr.candidateTree.trim()
        : undefined) ??
      (gr.data && typeof gr.data === "object" && typeof (gr.data as Record<string, unknown>).tree === "string"
        ? ((gr.data as Record<string, unknown>).tree as string).trim()
        : undefined) ??
      (gr.result && typeof gr.result === "object" && typeof (gr.result as Record<string, unknown>).tree === "string"
        ? ((gr.result as Record<string, unknown>).tree as string).trim()
        : undefined) ??
      gateTree;
  }

  let treeMatches = true;

  if (!candidateTree) {
    treeMatches = false;
    reasons.push("Candidate tree is missing (Requirement 9.12, 25.7)");
  }
  if (!gateTree) {
    treeMatches = false;
    reasons.push("Gate result tree is missing (Requirement 9.12, 25.7)");
  }
  if (opts.verdict && !verdictTree) {
    treeMatches = false;
    reasons.push("Verdict tree is missing (Requirement 9.12, 25.7)");
  }

  if (candidateTree && gateTree && candidateTree.toLowerCase() !== gateTree.toLowerCase()) {
    treeMatches = false;
    reasons.push(
      `Gate result tree does not match candidate tree (Requirement 9.12, 25.7)`
    );
  }
  if (candidateTree && verdictTree && candidateTree.toLowerCase() !== verdictTree.toLowerCase()) {
    treeMatches = false;
    reasons.push(
      `Verdict tree does not match candidate tree (Requirement 9.12, 25.7)`
    );
  }

  // 5. Integration_Head check (Requirement 25.6, 25.8)
  // Remove the rule that skips the comparison when one side is missing (merge-gate.ts around line 320)
  let headUnchanged = true;
  const currentHead = opts.currentHeadSha ?? opts.integrationHeadSha;
  const expectedHead = opts.expectedHeadSha ?? opts.expectedIntegrationHeadSha;

  if (currentHead || expectedHead) {
    if (!currentHead || !expectedHead || currentHead !== expectedHead) {
      headUnchanged = false;
      reasons.push(
        `Integration_Head moved during review or head SHA missing (expected ${expectedHead ?? "none"}, got ${currentHead ?? "none"}) (Requirement 25.8)`
      );
    }
  }

  // 6. EventStore history check from event source on every check (Requirement 25.7, Finding M-11, Audit N-2)
  let eventsPreceded = false;
  let invalidEventSource = false;

  const rawTaskForEvents =
    opts.task && typeof opts.task === "object" && !Array.isArray(opts.task)
      ? (opts.task as Record<string, unknown>)
      : undefined;

  const candidateSources = [
    opts.events,
    opts.eventStore,
    opts.eventSource,
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
    const effectiveRunId =
      (opts as any)?.targetRunId ??
      (typeof opts.runId === "string" ? opts.runId : undefined) ??
      (rawTaskForEvents && typeof rawTaskForEvents.runId === "string" ? rawTaskForEvents.runId : undefined);

    if (!effectiveRunId || typeof effectiveRunId !== "string" || effectiveRunId.trim() === "") {
      reasons.unshift("EventStore replay requires an explicit non-empty runId");
    } else {
      const rawEvents = extractEventsFromSource(opts as Record<string, unknown>, effectiveRunId.trim());
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
          tree: candidateTree,
          taskId: rawTaskId,
          runId: effectiveRunId.trim(),
        });
        eventsPreceded = eventCheck.ok;
        if (!eventCheck.ok) {
          reasons.push(...eventCheck.reasons);
        }
      }
    }
  }

  const accepted =
    verdictApproved &&
    candidateShaMatches &&
    gatePassed &&
    treeMatches &&
    headUnchanged &&
    eventsPreceded &&
    verdictRecordValid.valid &&
    checksPassed &&
    !taskIdRejected &&
    !invalidEventSource;

  return {
    accepted,
    ok: accepted,
    merged: accepted,
    reason: reasons.length > 0 ? reasons[0] : undefined,
    reasons,
    verdictApproved,
    candidateShaMatches,
    gatePassed,
    treeMatches,
    headUnchanged,
    eventsPreceded,
    candidateSha,
    candidateSha256: expectedCandidateSha256,
  };
}

export const evaluateMergeGate = checkMergeGate;
export const mergeGate = checkMergeGate;

/**
 * Convenience boolean predicate: returns true if merge gate accepts the candidate.
 */
export function isMergeAllowed(
  verdictOrOptions:
    | MergeGateOptions
    | WardenVerdictRecord
    | {
        verdict?: WardenVerdictStatus | string;
        candidateSha256?: string;
        candidateSha?: string;
        diff?: string;
        diffText?: string;
        tree?: string;
        [key: string]: unknown;
      }
    | WardenVerdictStatus
    | string,
  candidateShaOr256?: string,
  gateResultArg?: GateResultInput | boolean
): boolean {
  return checkMergeGate(verdictOrOptions, candidateShaOr256, gateResultArg).accepted;
}

export const canMergeTask = isMergeAllowed;
