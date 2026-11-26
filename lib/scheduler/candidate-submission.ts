// Task 13.5: Candidate submission pipeline
// Requirements: 9.12, 23.2, 25.6, 25.7, 25.8
// Remediation: R4-A1 (audit B-2, H-5, N-1 and revision validation)

import * as path from "node:path";
import * as Diff from "diff";
import {
  GitService,
  type MergeCandidateResult,
  VerifiedMerge,
  isVerifiedMerge,
} from "../git/git-service";
import { gateJs, isPythonFile, type GateResult } from "../grimoire/gate-js";
import { checkPythonCandidateGate } from "../grimoire/python-gate";
import { candidateSha256FromDiff } from "../merge/candidate-hash";
import {
  scanCandidateDiff,
  scanTextForSecrets,
  type SecretScanResult,
} from "../security/redactor";
import {
  validateCandidateDiff,
  validateCandidateFiles,
  type ScopeCheckResult,
} from "../security/scope-check";
import {
  scanForEscapingSymlinks,
  type SymlinkScanReport,
} from "../security/symlink-scanner";
import { checkMergeGate } from "../warden/merge-gate";
import { isCheckPassing, validateWardenVerdict } from "../warden/warden-review";
import type { EventStore } from "../events/event-store";
import type {
  WardenVerdictRecord,
  MergeGateOptions,
  GateResultInput,
} from "../warden/types";
import type { Scheduler } from "./scheduler";
import {
  VALID_TASK_TRANSITIONS,
  type MergeTaskResult,
  type ScheduledTask,
  type TaskMergeEvidence,
  type TaskState,
} from "./types";

export const NO_REVIEWER_INJECTED = "NO_REVIEWER_INJECTED";

export class NoReviewerInjectedError extends Error {
  constructor(message = NO_REVIEWER_INJECTED) {
    super(message);
    this.name = "NoReviewerInjectedError";
  }
}

const FULL_HEX_SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const STRICT_REF_REGEX =
  /^(?:HEAD|refs\/(?:heads|tags|remotes)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+)$/;

export function isValidSha(sha: unknown): sha is string {
  return typeof sha === "string" && FULL_HEX_SHA_REGEX.test(sha.trim());
}

export function isValidRef(ref: unknown): ref is string {
  if (typeof ref !== "string") return false;
  const trimmed = ref.trim();
  if (trimmed === "HEAD") return true;
  if (!STRICT_REF_REGEX.test(trimmed)) return false;
  if (
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".")
  ) {
    return false;
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    trimmed.includes("@{") ||
    trimmed.includes("~") ||
    trimmed.includes("^") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("*") ||
    trimmed.includes("[") ||
    trimmed.includes("\\") ||
    trimmed.includes(" ") ||
    trimmed.includes("\0")
  ) {
    return false;
  }
  const parts = trimmed.split("/");
  for (const p of parts) {
    if (!p || p.startsWith(".") || p.startsWith("-") || p.endsWith(".lock")) return false;
  }
  return true;
}

export function isValidRevisionOrRef(rev: unknown): rev is string {
  return isValidSha(rev) || isValidRef(rev);
}

export function isValidPath(p: unknown): p is string {
  if (typeof p !== "string" || !p.trim()) return false;
  const trimmed = p.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return false;
  if (trimmed.includes("..") || trimmed.includes("\0")) return false;
  return true;
}

export interface CandidateSubmissionReport {
  scheduler?: Scheduler;
  runId?: string;
  run?: { id: string; [key: string]: unknown };
  task?:
    | ScheduledTask
    | {
        id: string;
        files?: string[];
        filesInScope?: string[];
        acceptanceCommand?: string;
        accept?: string;
        state?: TaskState | string;
        [key: string]: unknown;
      };
  taskId?: string;
  diff?: string;
  candidateDiff?: string;
  changedFiles?: string[];
  filesInScope?: string[];
  allowList?: string[];
  taskFiles?: string[];
  worktreeDir?: string;
  worktreeRoot?: string;
  candidateWorktree?: string;
  gitDir?: string;
  runDir?: string;
  gitService?: GitService;
  candidateSha?: string;
  candidateSha256?: string;
  candidateTree?: string;
  gateTree?: string;
  verdictTree?: string;
  integrationHeadSha?: string;
  expectedIntegrationHeadSha?: string;
  currentHeadSha?: string;
  acceptanceCommand?: string;
  accept?: string;
  // Documented test doubles (Requirement B-1, B-2)
  wardenReviewer?: (
    run: any,
    candidate: any,
    acceptanceCommand: string
  ) => Promise<WardenVerdictRecord | any> | WardenVerdictRecord | any;
  warden?: {
    review: (
      run: any,
      candidate: any,
      acceptanceCommand: string
    ) => Promise<WardenVerdictRecord | any> | WardenVerdictRecord | any;
  };
  reviewer?: (
    run: any,
    candidate: any,
    acceptanceCommand: string
  ) => Promise<WardenVerdictRecord | any> | WardenVerdictRecord | any;
  events?: any;
  eventStore?: EventStore | any;
  eventSource?: any;
  [key: string]: unknown;
}

export interface CandidateSubmissionResult {
  ok: boolean;
  merged: boolean;
  state: TaskState | "merge_rollback_failed";
  reasons: string[];
  reason?: string;
  scopeResult?: ScopeCheckResult;
  redactorResult?: SecretScanResult;
  symlinkReport?: SymlinkScanReport;
  gateResult?: GateResult | unknown;
  verdict?: WardenVerdictRecord | unknown;
  mergeResult?: MergeCandidateResult;
  taskMergeResult?: MergeTaskResult;
}

function transitionTaskDirect(
  task: any,
  newState: TaskState,
  reason?: string
): void {
  const previousState: TaskState = task.state;
  if (previousState === newState) {
    return;
  }
  const allowed = VALID_TASK_TRANSITIONS[previousState];
  if (!allowed || !allowed.includes(newState)) {
    throw new Error(
      `Invalid task state transition from '${previousState}' to '${newState}'`
    );
  }
  task.previousState = previousState;
  task.state = newState;
}

/**
 * Rejects a task and updates scheduler/task state through valid transitions.
 * Any disallowed transition throws an error.
 * Requirement 23.2, 23.12.
 */
function failToRejected(
  report: CandidateSubmissionReport,
  taskId: string | undefined,
  reason: string
): TaskState {
  if (report.scheduler && taskId) {
    const task = report.scheduler.rejectTask(taskId, { reason });
    return task.state;
  }
  if (report.task && typeof report.task === "object") {
    const task = report.task as any;
    task.rejectionReason = reason;
    const currentState: TaskState = task.state ?? "running";
    if (currentState === "running") {
      transitionTaskDirect(task, "in_review", reason);
      transitionTaskDirect(task, "rejected", reason);
    } else if (currentState === "in_review") {
      transitionTaskDirect(task, "rejected", reason);
    } else if (currentState === "rejected") {
      // already rejected
    } else {
      transitionTaskDirect(task, "rejected", reason);
    }

    if (
      typeof task.attempts === "number" &&
      typeof task.maxAttempts === "number" &&
      task.attempts >= task.maxAttempts
    ) {
      transitionTaskDirect(task, "failed", reason);
    }
    return task.state;
  }
  return "rejected";
}

async function execGitRead(
  gitService: GitService,
  gitDir: string | undefined,
  args: string[]
): Promise<string> {
  const cmdArgs = gitDir ? ["-C", gitDir, ...args] : args;
  const res = await gitService.execGit(cmdArgs);
  return res.stdout.trim();
}

async function execGitShow(
  gitService: GitService,
  gitDir: string | undefined,
  refAndPath: string
): Promise<string> {
  const cmdArgs = gitDir
    ? ["-C", gitDir, "show", refAndPath]
    : ["show", refAndPath];
  const res = await gitService.execGit(cmdArgs);
  return res.stdout;
}

/**
 * Guarded rollback of integration ref using GitService.rollbackIntegrationRef (Requirement N-A12).
 * Ref is updated using CAS update-ref with legitimate VerifiedMerge proof.
 */
async function rollbackIntegrationRef(
  gitService: GitService,
  mergeProof: unknown,
  optionsOrGitDir?: { gitDir?: string; runDir?: string } | string,
  maybeRunDir?: string
): Promise<{ ok: boolean; reason?: string }> {
  if (!mergeProof || !isVerifiedMerge(mergeProof)) {
    return {
      ok: false,
      reason: "Rollback failed: missing or invalid VerifiedMerge proof",
    };
  }
  const opts =
    typeof optionsOrGitDir === "string"
      ? { gitDir: optionsOrGitDir, runDir: maybeRunDir }
      : (optionsOrGitDir ?? {});
  try {
    return await (gitService as any).rollbackIntegrationRef(mergeProof, {
      gitDir: opts.gitDir,
      runDir: opts.runDir,
    });
  } catch (err: any) {
    return {
      ok: false,
      reason: `Rollback failed: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * Runs the candidate submission pipeline in the exact order specified:
 * 1. Scope check of the changed files against the task allow-list
 * 2. Diff scan through the redactor
 * 3. Symlink scan using diff headers and worktree
 * 4. Resolve candidate SHA from git (refs/heads/task/<taskId> only, no fallback refs) and read candidate tree
 * 4b. Bind the caller diff to the real git diff --binary --no-color between base and candidate
 * 6. Warden review via injected reviewer (reject with NO_REVIEWER_INJECTED if missing)
 * 7. Verification that verdict binds to candidate SHA and tree (compare gate tree, verdict tree, candidate tree)
 * 8. Pre-git transition check without changing state
 * 9. Git merge candidate into integration branch
 * 10. Post-git apply merged state, release dependents, and emit events
 *
 * If git merge fails, task stays in_review, nothing is released, no event emitted.
 * If state application fails after git merge succeeded, integration ref is reset to previous value.
 * Requirements: 9.12, 23.2, 25.6, 25.7, 25.8 (B-1, B-2, B-3, H-5, H-6, M-13, R4-A1).
 */
export async function onSubmit(
  report: CandidateSubmissionReport
): Promise<CandidateSubmissionResult> {
  const taskId =
    report.taskId ??
    (typeof report.task === "object" ? report.task?.id : undefined);

  try {
    // N-A1: gitService must be a real GitService instance; no duck-typed gitMerger
    const gitService = report.gitService ?? new GitService();
    if (!(gitService instanceof GitService)) {
      const reason = "gitService must be an instance of GitService";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
      };
    }

    // candidate.tree must be a string; a Record or a Map is rejected
    const callerCandidateTree: unknown = report.candidateTree;
    if (
      callerCandidateTree !== undefined &&
      callerCandidateTree !== null &&
      typeof callerCandidateTree !== "string"
    ) {
      const reason = "candidate.tree must be a string (Record or Map rejected)";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
      };
    }

    const runId = report.runId ?? report.run?.id;
    const diff = report.diff ?? report.candidateDiff ?? "";

    // M-13: Use one gitDir value for the whole pipeline, for reports and for reads
    const resolvedGitDir =
      report.gitDir ??
      (report.runDir ? path.join(report.runDir, "git") : undefined) ??
      (typeof runId === "string" && runId && gitService.runsDir
        ? path.join(gitService.runsDir, runId, "git")
        : undefined);
    report.gitDir = resolvedGitDir;

    // -------------------------------------------------------------------------
    // Step 1: Scope check of changed files against the task allow-list
    // -------------------------------------------------------------------------
    const taskObj =
      (report.scheduler && taskId
        ? report.scheduler.getTask(taskId)
        : undefined) ??
      (typeof report.task === "object" ? report.task : undefined);

    const allowList =
      report.allowList ??
      report.filesInScope ??
      report.taskFiles ??
      taskObj?.filesInScope ??
      taskObj?.files ??
      [];

    let scopeResult: ScopeCheckResult;
    if (diff) {
      scopeResult = validateCandidateDiff(diff, {
        filesInScope: allowList,
        allowedFiles: allowList,
      });
    } else if (report.changedFiles && report.changedFiles.length > 0) {
      scopeResult = validateCandidateFiles(report.changedFiles, {
        filesInScope: allowList,
        allowedFiles: allowList,
      });
    } else {
      scopeResult = validateCandidateFiles([], {
        filesInScope: allowList,
        allowedFiles: allowList,
      });
    }

    if (!scopeResult.valid || !scopeResult.passed) {
      const reason =
        scopeResult.reason ??
        (scopeResult.violations.length > 0
          ? scopeResult.violations[0]
          : "Candidate modifies files outside task scope");
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons:
          scopeResult.violations.length > 0
            ? [...scopeResult.violations]
            : [reason],
        scopeResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 2: Diff scan through the redactor
    // -------------------------------------------------------------------------
    let redactorResult = scanCandidateDiff(diff);
    if (
      !redactorResult.hasSecrets &&
      !diff.includes("\n+") &&
      !diff.startsWith("+")
    ) {
      const textScan = scanTextForSecrets(diff);
      if (textScan.hasSecrets) {
        redactorResult = {
          hasSecrets: true,
          passed: false,
          shouldQuarantine: true,
          violations: textScan.violations,
          flaggedFiles:
            textScan.flaggedFiles.length > 0 ? textScan.flaggedFiles : ["diff"],
          reason:
            textScan.reason ?? "Secret violation detected in candidate diff",
        };
      }
    }

    if (redactorResult.hasSecrets || redactorResult.violations.length > 0) {
      const firstV = redactorResult.violations[0];
      const reason = firstV
        ? `Secret violation: ${firstV.type}${firstV.patternName ? ` (${firstV.patternName})` : ""}${firstV.file ? ` in ${firstV.file}` : ""}`
        : "Secret or host credential detected in candidate diff (Requirement 22.14, 42.5)";
      const reasons = redactorResult.violations.map(
        (v) =>
          `Secret violation: ${v.type}${v.patternName ? ` (${v.patternName})` : ""}${v.file ? ` in ${v.file}` : ""}`
      );
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: reasons.length > 0 ? reasons : [reason],
        scopeResult,
        redactorResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 3: Symlink scan using git diff header fields and candidate worktree
    // -------------------------------------------------------------------------
    const diffLines = diff.split("\n");
    const hasSymlinkInDiff = diffLines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed === "new file mode 120000" ||
        trimmed === "deleted file mode 120000" ||
        trimmed === "old mode 120000" ||
        trimmed === "new mode 120000"
      );
    });

    if (hasSymlinkInDiff) {
      const reason =
        "Escaping symlink or directory link detected in candidate diff (Requirement 22.8, 45.10)";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    const worktreeRoot =
      report.candidateWorktree ??
      report.worktreeDir ??
      report.worktreeRoot ??
      report.worktree ??
      (report.task as any)?.candidateWorktree ??
      (report.task as any)?.worktreeRoot ??
      (report.task as any)?.worktreeDir ??
      (report as any).root;

    let symlinkReport: SymlinkScanReport | undefined;
    if (worktreeRoot && typeof worktreeRoot === "string") {
      symlinkReport = scanForEscapingSymlinks(worktreeRoot);
      if (
        !symlinkReport.clean ||
        symlinkReport.hasEscapingSymlinks ||
        symlinkReport.hasEscapes ||
        symlinkReport.length > 0
      ) {
        const reason =
          symlinkReport.reason ??
          "Escaping symlink or outside hardlink detected in candidate worktree (Requirement 22.8, 45.10)";
        const newState = failToRejected(report, taskId, reason);
        return {
          ok: false,
          merged: false,
          state: newState,
          reason,
          reasons:
            symlinkReport.violations.length > 0
              ? [...symlinkReport.violations]
              : [reason],
          scopeResult,
          redactorResult,
          symlinkReport,
        };
      }
    }

    // -------------------------------------------------------------------------
    // Event store verification: merge proof requires event store (audit N-2 HIGH)
    // Refuse before any git step if event store is absent.
    // -------------------------------------------------------------------------
    const eventStore =
      report.eventStore ??
      (report.events && typeof (report.events as any).append === "function"
        ? report.events
        : undefined);

    if (!eventStore || typeof eventStore.append !== "function") {
      const reason = "event store required for merge proof";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }
    report.eventStore = eventStore;

    // -------------------------------------------------------------------------
    // runId is required: there is no run-default fallback (audit N-A9)
    // -------------------------------------------------------------------------
    if (typeof runId !== "string" || !runId.trim()) {
      const reason = "runId is required: no runId (or run.id) was provided";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 4: Resolve candidate SHA from git and read candidate tree (B-2, R4-A1)
    // -------------------------------------------------------------------------
    const candidateSha256 = candidateSha256FromDiff(diff);

    if (!taskId || typeof taskId !== "string" || !taskId.trim()) {
      const reason = "Git read failed: taskId is required to resolve candidate ref";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    const candidateRef = `refs/heads/task/${taskId.trim()}`;
    if (!isValidRef(candidateRef)) {
      const reason = `Git read failed: invalid candidate ref '${candidateRef}' for task '${taskId}'`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    let resolvedCandidateSha: string;
    try {
      resolvedCandidateSha = await execGitRead(gitService, resolvedGitDir, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        candidateRef,
      ]);
    } catch (err: any) {
      const reason = `Git read failed: missing task ref '${candidateRef}' (unable to rev-parse candidate SHA for task '${taskId}'): ${err?.message ?? String(err)}`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    if (!isValidSha(resolvedCandidateSha)) {
      const reason = `Git read failed: resolved candidate SHA '${resolvedCandidateSha}' is not a valid 40-character hex SHA`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    // Accept candidateSha as caller input only when it equals the resolved ref, and reject otherwise
    if (report.candidateSha !== undefined && report.candidateSha !== null) {
      if (!isValidSha(report.candidateSha)) {
        const reason = `Caller candidateSha '${report.candidateSha}' is not a valid 40-character hex SHA`;
        const newState = failToRejected(report, taskId, reason);
        return {
          ok: false,
          merged: false,
          state: newState,
          reason,
          reasons: [reason],
          scopeResult,
          redactorResult,
        };
      }
      if (
        report.candidateSha.trim().toLowerCase() !==
        resolvedCandidateSha.trim().toLowerCase()
      ) {
        const reason = `Candidate SHA mismatch: provided '${report.candidateSha}' does not match resolved ref '${resolvedCandidateSha}' (Requirement 25.6)`;
        const newState = failToRejected(report, taskId, reason);
        return {
          ok: false,
          merged: false,
          state: newState,
          reason,
          reasons: [reason],
          scopeResult,
          redactorResult,
        };
      }
    }

    const candidateSha = resolvedCandidateSha;

    // Validate candidateSha before rev-parse tree
    if (!isValidSha(candidateSha)) {
      const reason = `Git read failed: candidate SHA '${candidateSha}' is invalid`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    // B-2: The pipeline itself reads the candidate tree SHA with git rev-parse and fails closed when missing
    let candidateTree: string;
    try {
      candidateTree = await execGitRead(gitService, resolvedGitDir, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${candidateSha}^{tree}`,
      ]);
    } catch (err: any) {
      const reason = `Git read failed: unable to rev-parse candidate tree for '${candidateSha}': ${err?.message ?? String(err)}`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    if (!isValidSha(candidateTree)) {
      const reason = `Git read failed: candidate tree '${candidateTree}' is not a valid 40-character hex SHA`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    // Expected integration head recorded at submission time (Requirement 5)
    let expectedHeadSha =
      report.expectedIntegrationHeadSha ??
      report.integrationHeadSha ??
      report.currentHeadSha;

    if (expectedHeadSha) {
      if (!isValidRevisionOrRef(expectedHeadSha)) {
        const reason = `Git read failed: invalid expected integration head revision or ref '${expectedHeadSha}'`;
        const newState = failToRejected(report, taskId, reason);
        return {
          ok: false,
          merged: false,
          state: newState,
          reason,
          reasons: [reason],
          scopeResult,
          redactorResult,
        };
      }
      if (!isValidSha(expectedHeadSha)) {
        try {
          expectedHeadSha = await execGitRead(gitService, resolvedGitDir, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            expectedHeadSha,
          ]);
        } catch (err: any) {
          const reason = `Git read failed: unable to rev-parse expected integration head '${expectedHeadSha}': ${err?.message ?? String(err)}`;
          const newState = failToRejected(report, taskId, reason);
          return {
            ok: false,
            merged: false,
            state: newState,
            reason,
            reasons: [reason],
            scopeResult,
            redactorResult,
          };
        }
      }
    } else {
      const runRef = `refs/heads/graveyard/${runId}`;
      if (!isValidRef(runRef)) {
        const reason = `Git read failed: invalid integration branch ref '${runRef}'`;
        const newState = failToRejected(report, taskId, reason);
        return {
          ok: false,
          merged: false,
          state: newState,
          reason,
          reasons: [reason],
          scopeResult,
          redactorResult,
        };
      }
      try {
        expectedHeadSha = await execGitRead(gitService, resolvedGitDir, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          runRef,
        ]);
      } catch (err: any) {
        const reason = `Git read failed: missing integration branch ref '${runRef}' (unable to rev-parse integration head for run '${runId}'): ${err?.message ?? String(err)}`;
        const newState = failToRejected(report, taskId, reason);
        return {
          ok: false,
          merged: false,
          state: newState,
          reason,
          reasons: [reason],
          scopeResult,
          redactorResult,
        };
      }
    }

    if (!isValidSha(expectedHeadSha)) {
      const reason = `Git read failed: expected integration head '${expectedHeadSha}' is not a valid 40-character hex SHA`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 4b: Real diff binding (audit N-A5): the caller's diff must be
    // identical to the real git diff --binary --no-color between the base
    // (expected integration head) and the candidate.
    // -------------------------------------------------------------------------
    let realDiff = "";
    try {
      realDiff = await execGitRead(gitService, resolvedGitDir, [
        "diff",
        "--binary",
        "--no-color",
        expectedHeadSha,
        candidateSha,
      ]);
    } catch (err: any) {
      const reason = `Git read failed: unable to compute the real diff between '${expectedHeadSha}' and '${candidateSha}': ${err?.message ?? String(err)}`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    if (diff.trim() !== realDiff.trim()) {
      const reason = "Caller diff does not match the real git diff between the base and the candidate";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 5: Grimoire syntax gate on files read from candidate tree (B-2, H-6, R4-A1)
    // -------------------------------------------------------------------------
    // Deletions come only from git diff --name-status between integration head and candidate (status D)
    let diffNameStatusRaw = "";
    try {
      diffNameStatusRaw = await execGitRead(gitService, resolvedGitDir, [
        "diff",
        "--name-status",
        expectedHeadSha,
        candidateSha,
      ]);
    } catch (err: any) {
      const reason = `Git read failed: unable to run diff --name-status between '${expectedHeadSha}' and '${candidateSha}': ${err?.message ?? String(err)}`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    const deletedSet = new Set<string>();
    const modifiedFromDiff = new Set<string>();
    // Maps a rename destination path to its pre-rename source path so the
    // Python gate uses the source content at expectedHeadSha as the true
    // baseline for the renamed destination file.
    const renameSourceByDest = new Map<string, string>();

    for (const rawLine of diffNameStatusRaw.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\t+/);
      const statusCode = parts[0]?.trim() ?? "";
      if (statusCode === "D" || statusCode.startsWith("D")) {
        const p = parts[1]?.trim();
        if (p) deletedSet.add(p);
      } else if (statusCode.startsWith("R")) {
        const oldPath = parts[1]?.trim();
        const newPath = parts[2]?.trim();
        if (oldPath) deletedSet.add(oldPath);
        if (newPath) modifiedFromDiff.add(newPath);
        if (oldPath && newPath) renameSourceByDest.set(newPath, oldPath);
      } else if (statusCode.startsWith("C")) {
        if (parts[2]?.trim()) modifiedFromDiff.add(parts[2].trim());
      } else {
        const p = parts[1]?.trim();
        if (p) modifiedFromDiff.add(p);
      }
    }

    const modifiedCandidateSet = new Set<string>();
    for (const f of modifiedFromDiff) {
      if (!deletedSet.has(f)) modifiedCandidateSet.add(f);
    }
    for (const f of scopeResult.touchedFiles) {
      if (!deletedSet.has(f)) modifiedCandidateSet.add(f);
    }
    if (Array.isArray(report.changedFiles)) {
      for (const f of report.changedFiles) {
        if (!deletedSet.has(f)) modifiedCandidateSet.add(f);
      }
    }

    const modifiedFiles = Array.from(modifiedCandidateSet);
    const hasModifiedFiles = modifiedFiles.length > 0;

    const changedFileObjects: Array<{ path: string; content?: string }> = [];
    let unreadableFile: string | undefined;

    for (const file of modifiedFiles) {
      if (!isValidPath(file)) {
        unreadableFile = file;
        break;
      }
      try {
        const content = await execGitShow(
          gitService,
          resolvedGitDir,
          `${candidateTree}:${file}`
        );
        changedFileObjects.push({ path: file, content });
      } catch (err: any) {
        unreadableFile = file;
        break;
      }
    }

    if (unreadableFile) {
      const reason = `Changed file '${unreadableFile}' has no readable content in candidate tree (Requirement 4)`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
      };
    }

    const deletedList = Array.from(deletedSet);
    const jsFileObjects = changedFileObjects.filter((f) => !isPythonFile(f.path));
    const pyAfterObjects = changedFileObjects.filter(
      (f): f is { path: string; content: string } =>
        isPythonFile(f.path) && typeof f.content === "string"
    );
    const pyDeletedFiles = deletedList.filter((p) => isPythonFile(p));
    const pyChangedFiles = Array.from(
      new Set([...pyAfterObjects.map((f) => f.path), ...pyDeletedFiles])
    );
    const jsDeletedList = deletedList.filter((p) => !isPythonFile(p));

    const gateOptions = {
      files: jsFileObjects,
      deletions: jsDeletedList,
      deletedFiles: jsDeletedList,
      deletedPaths: jsDeletedList,
      tree: candidateTree,
      candidateTree,
      taskId,
      diff,
      empty: jsFileObjects.length === 0,
      allowEmpty: jsFileObjects.length === 0,
    };

    // Always run real gateJs (Requirement 1: gateRunner removed)
    const rawGateResult = gateJs(jsFileObjects as any, gateOptions as any);
    const gateResultBase: GateResult =
      typeof (rawGateResult as any)?.then === "function"
        ? await rawGateResult
        : rawGateResult;

    let pyGateResult: GateResult | null = null;
    if (pyChangedFiles.length > 0) {
      const pyBeforeObjects: Array<{ path: string; content: string }> = [];
      for (const pyFile of pyAfterObjects) {
        // For a rename, the true baseline of the destination path is the
        // pre-rename source content, but only when the source was itself a
        // Python file. A non-Python source renamed to a .py destination has no
        // Python baseline (fall back to an empty baseline).
        const mappedSource = renameSourceByDest.get(pyFile.path);
        const baselineRef =
          mappedSource === undefined
            ? pyFile.path
            : isPythonFile(mappedSource)
              ? mappedSource
              : undefined;
        if (baselineRef === undefined) {
          continue;
        }
        try {
          const baseline = await execGitShow(
            gitService,
            resolvedGitDir,
            `${expectedHeadSha}:${baselineRef}`
          );
          pyBeforeObjects.push({ path: pyFile.path, content: baseline });
        } catch {
          // Absent in expectedHeadSha => new Python file with empty baseline.
        }
      }
      pyGateResult = await checkPythonCandidateGate(
        {
          before: pyBeforeObjects,
          after: pyAfterObjects,
          files: pyAfterObjects,
          changedFiles: pyChangedFiles,
          deletions: pyDeletedFiles,
          tree: candidateTree,
          candidateTree,
        },
        {
          runId,
          taskId,
          actor: "gate",
          emit: () => {},
        }
      );
    }

    const jsOk = Boolean(gateResultBase.ok);
    const pyOk = pyGateResult ? Boolean(pyGateResult.ok) : true;
    const mergedFiles = Array.from(
      new Set([
        ...(Array.isArray(gateResultBase.files) ? gateResultBase.files : []),
        ...(pyGateResult && Array.isArray(pyGateResult.files) ? pyGateResult.files : []),
      ])
    );
    const mergedReasons = [
      ...(jsOk ? [] : (gateResultBase.reasons ?? [])),
      ...(pyGateResult && !pyOk ? (pyGateResult.reasons ?? []) : []),
    ];
    const mergedDetails = {
      ...(gateResultBase.details ?? {}),
      ...(pyGateResult?.details ?? {}),
    };

    const gateResult: GateResult = {
      ...gateResultBase,
      ok: jsOk && pyOk,
      reasons: mergedReasons,
      details: mergedDetails,
      tree: candidateTree,
      deletions: deletedList,
      files: mergedFiles,
    } as any;

    // Append gate.result event from real gate computation (audit N-2 HIGH)
    const gateOk = Boolean(gateResult.ok);
    const gateTreeComputed =
      typeof gateResult.tree === "string" && gateResult.tree.trim()
        ? gateResult.tree.trim()
        : candidateTree;
    const gateReasons =
      Array.isArray(gateResult.reasons) && gateResult.reasons.length > 0
        ? [...gateResult.reasons]
        : (gateOk ? [] : ["Grimoire syntax gate failed or missing (Requirement 9.12, 25.7)"]);

    eventStore.append({
      runId,
      kind: "gate.result",
      actor: "gate",
      taskId: taskId ?? null,
      data: {
        ok: gateOk,
        tree: gateTreeComputed,
        candidateSha,
        reasons: gateReasons,
        taskId,
      },
    });

    if (!gateResult || !gateResult.ok) {
      const reasons =
        gateResult?.reasons && gateResult.reasons.length > 0
          ? [...gateResult.reasons]
          : ["Grimoire syntax gate failed or missing (Requirement 9.12, 25.7)"];
      const reason = reasons[0];
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons,
        scopeResult,
        redactorResult,
        gateResult,
      };
    }

    // Do not trust tree echoed back by gate: if present, must match candidate tree
    if (
      gateResult.tree &&
      typeof gateResult.tree === "string" &&
      gateResult.tree.trim().toLowerCase() !== candidateTree.trim().toLowerCase()
    ) {
      const reason = `Gate result tree '${gateResult.tree}' does not match candidate tree '${candidateTree}' (Requirement 9.12, 25.7)`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 6: Warden review via injected reviewer (B-2)
    // -------------------------------------------------------------------------
    const acceptCommand =
      report.acceptanceCommand ??
      report.accept ??
      taskObj?.acceptanceCommand ??
      taskObj?.accept ??
      "";

    const reviewer =
      report.wardenReviewer ??
      report.warden?.review ??
      report.reviewer ??
      (report as any).wardenReview;

    // B-2: Rejects with a named error when no reviewer is injected (no default approval)
    if (!reviewer || typeof reviewer !== "function") {
      const reason = `${NO_REVIEWER_INJECTED}: no Warden reviewer injected`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason, NO_REVIEWER_INJECTED],
        scopeResult,
        redactorResult,
        gateResult,
      };
    }

    const verdict = await reviewer(
      report.run ?? { id: runId },
      { diff, taskId, candidateSha, tree: candidateTree, candidateSha256 },
      acceptCommand
    );

    const isVerdictApproved =
      verdict &&
      (verdict.verdict === "approve" ||
        verdict.status === "approve" ||
        verdict === "approve");

    // Append verdict event from reviewer verdict record (audit N-2 HIGH)
    const verdictRecord =
      typeof verdict === "object" && verdict !== null ? verdict : undefined;
    const verdictStatus =
      typeof verdict === "string"
        ? verdict
        : (verdictRecord?.verdict ??
          verdictRecord?.status ??
          (isVerdictApproved ? "approve" : "reject"));
    const verdictSha256 =
      verdictRecord?.candidateSha256 ??
      (typeof verdict === "string" ? candidateSha256 : undefined);
    const verdictRecordSha =
      verdictRecord?.candidateSha ??
      verdictRecord?.sha ??
      (typeof verdict === "string" ? candidateSha : undefined);
    const verdictRecordTree =
      verdictRecord?.tree ??
      verdictRecord?.candidateTree ??
      (typeof verdict === "string" ? candidateTree : undefined);

    if (!isVerdictApproved) {
      const reason =
        verdict?.reasons?.[0]?.text ??
        (typeof verdict?.reasons?.[0] === "string"
          ? verdict?.reasons?.[0]
          : undefined) ??
        verdict?.reason ??
        `Warden review rejected candidate (verdict: ${verdict?.verdict ?? verdict?.status ?? "reject"})`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    // N-A1: The reviewer result must pass validateWardenVerdict; a bare approve
    // (no candidateSha256, no reasons) does not pass and is rejected.
    const verdictValidation = validateWardenVerdict(verdict);
    if (!verdictValidation.valid) {
      const reason =
        verdictValidation.reasons[0] ??
        "Reviewer verdict failed validateWardenVerdict";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons:
          verdictValidation.reasons.length > 0
            ? [...verdictValidation.reasons]
            : [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    // N-A1: checks install, build, accept and tests must each pass (isCheckPassing)
    const verdictChecks =
      (typeof verdict === "object" && verdict !== null
        ? ((verdict as Record<string, unknown>).checks as
            | Record<string, unknown>
            | undefined)
        : undefined) ?? {};
    const requiredCheckNames = ["install", "build", "accept", "tests"];
    const notPassingChecks = requiredCheckNames.filter(
      (name) => !isCheckPassing(verdictChecks[name])
    );
    if (notPassingChecks.length > 0) {
      const reason = `Reviewer verdict checks not passing: ${notPassingChecks.join(", ")} (Requirement 24.5)`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    // B-2 & H-5: Checks that the verdict binds to the same candidate SHA and tree (no self-comparison)
    const verdictTree = verdict?.tree ?? verdict?.candidateTree;
    if (!verdictTree) {
      const reason = "Verdict tree is missing (Requirement 9.12, 25.7)";
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    if (!isValidSha(verdictTree)) {
      const reason = `Verdict tree '${verdictTree}' is not a valid 40-character hex SHA`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    // Gate tree is candidate tree read from git (Requirement 5)
    const gateTree = candidateTree;

    if (
      typeof verdictTree === "string" &&
      verdictTree.trim().toLowerCase() !== candidateTree.trim().toLowerCase()
    ) {
      const reason = `Verdict tree '${verdictTree}' does not match candidate tree '${candidateTree}' (Requirement 9.12, 25.7)`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    if (gateTree.trim().toLowerCase() !== candidateTree.trim().toLowerCase()) {
      const reason = `Gate tree '${gateTree}' does not match candidate tree '${candidateTree}' (Requirement 9.12, 25.7)`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    if (gateTree.trim().toLowerCase() !== verdictTree.trim().toLowerCase()) {
      const reason = `Gate tree '${gateTree}' does not match verdict tree '${verdictTree}' (Requirement 9.12, 25.7)`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    const verdictSha = verdict?.candidateSha ?? verdict?.sha;
    if (
      verdictSha &&
      typeof verdictSha === "string" &&
      verdictSha.trim().toLowerCase() !== candidateSha.trim().toLowerCase()
    ) {
      const reason = `Verdict candidateSha '${verdictSha}' does not match candidate SHA '${candidateSha}' (Requirement 25.6)`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    eventStore.append({
      runId,
      kind: "verdict",
      actor: "warden",
      taskId: taskId ?? null,
      data: {
        verdict: verdictStatus,
        candidateSha256: verdictSha256,
        candidateSha: verdictRecordSha,
        tree: verdictRecordTree,
        taskId,
      },
    });

    // -------------------------------------------------------------------------
    // Step 7: Transition to in_review and verify merge gate
    // -------------------------------------------------------------------------
    if (report.scheduler && taskId) {
      const liveTask = report.scheduler.getTask(taskId);
      if (liveTask && liveTask.state === "running") {
        report.scheduler.markInReview(taskId);
      }
    } else if (taskObj && (taskObj as any).state === "running") {
      (taskObj as any).state = "in_review";
    }

    // Read current integration head from git at merge check time (Requirement 5)
    let currentHeadSha: string;
    const runBranchRef = `refs/heads/graveyard/${runId}`;
    if (!isValidRef(runBranchRef)) {
      const reason = `Git read failed: invalid integration branch ref '${runBranchRef}'`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    try {
      currentHeadSha = await execGitRead(gitService, resolvedGitDir, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        runBranchRef,
      ]);
    } catch (err: any) {
      const reason = `Git read failed: missing integration branch ref '${runBranchRef}' (unable to rev-parse current integration head for run '${runId}'): ${err?.message ?? String(err)}`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    if (!isValidSha(currentHeadSha)) {
      const reason = `Git read failed: current integration head '${currentHeadSha}' is not a valid 40-character hex SHA`;
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    const gateResultForEvidence: GateResultInput = {
      ...gateResult,
      tree: gateTree,
    };

    const evidence: MergeGateOptions = {
      verdict,
      gateResult: gateResultForEvidence,
      candidateSha,
      candidateSha256,
      tree: candidateTree,
      gateTree,
      verdictTree, // H-5: bind actual verdictTree, no self-comparison fallback
      expectedHeadSha,
      currentHeadSha,
      integrationHeadSha: currentHeadSha,
      diff,
      taskId,
      eventSource: report.eventStore,
      runId,
      task: report.task as any,
    };

    const mergeGateCheck = checkMergeGate(evidence);
    if (!mergeGateCheck.ok) {
      const reasons =
        mergeGateCheck.reasons && mergeGateCheck.reasons.length > 0
          ? [...mergeGateCheck.reasons]
          : [mergeGateCheck.reason ?? "Merge gate check failed"];
      const reason = reasons[0];
      const newState = failToRejected(report, taskId, reason);
      return {
        ok: false,
        merged: false,
        state: newState,
        reason,
        reasons,
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    // -------------------------------------------------------------------------
    // Step 8: Check transition is allowed without changing state (B-3)
    // -------------------------------------------------------------------------
    if (report.scheduler && taskId) {
      const check = report.scheduler.canMergeTask
        ? report.scheduler.canMergeTask(taskId, evidence)
        : undefined;
      if (check && !check.ok) {
        const reason =
          check.reason ??
          (check.reasons?.[0]) ??
          "Merge transition not allowed";
        return {
          ok: false,
          merged: false,
          state: "in_review",
          reason,
          reasons: check.reasons?.length ? check.reasons : [reason],
          scopeResult,
          redactorResult,
          gateResult,
          verdict,
        };
      }
    } else if (taskObj) {
      const st = (taskObj as any).state;
      if (st !== "in_review") {
        const reason = `Task is in state '${st}', but can only merge from 'in_review'`;
        return {
          ok: false,
          merged: false,
          state: "in_review",
          reason,
          reasons: [reason],
          scopeResult,
          redactorResult,
          gateResult,
          verdict,
        };
      }
    }

    // -------------------------------------------------------------------------
    // Step 9: Git-merge the candidate into the integration branch (B-3)
    // -------------------------------------------------------------------------
    let mergeResult: MergeCandidateResult;
    try {
      // mergeCandidate is module-private in GitService (verified merge proof);
      // the instance itself is checked above with instanceof GitService.
      mergeResult = await (gitService as any).mergeCandidate({
        runId,
        candidateSha: candidateSha!,
        expectedIntegrationHeadSha: expectedHeadSha!,
        candidateSha256,
        verdict,
        verdictCandidateSha256: verdict?.candidateSha256 ?? candidateSha256,
        gateResult: gateResultForEvidence,
        gitDir: resolvedGitDir,
        runDir: report.runDir,
      });
    } catch (err: any) {
      // B-3: If git fails, the task stays in_review, nothing is released, no event emitted
      const reason = `GitService.mergeCandidate failed: ${err?.message ?? String(err)}`;
      return {
        ok: false,
        merged: false,
        state: "in_review",
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
      };
    }

    if (!mergeResult || !mergeResult.ok || !mergeResult.merged) {
      // B-3: If git fails, the task stays in_review, nothing is released, no event emitted
      const reason = (mergeResult as any)?.reason ?? "Git mergeCandidate was not accepted";
      return {
        ok: false,
        merged: false,
        state: "in_review",
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
        mergeResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 9a: VerifiedMerge proof verification (audit N-A13)
    // -------------------------------------------------------------------------
    const emitRollbackFailedEvent = (rollbackReason: string) => {
      try {
        const store =
          report.eventStore ??
          eventStore ??
          (report.events && typeof (report.events as any).append === "function"
            ? report.events
            : undefined);
        store?.append({
          runId,
          kind: "task.state",
          actor: "scheduler",
          taskId: taskId ?? null,
          data: {
            taskId,
            state: "merge_rollback_failed",
            reason: rollbackReason,
            refs: [],
          },
        });
      } catch {
        // Ignore secondary event store failure
      }
    };

    const recomputedCandidateSha256 = candidateSha256FromDiff(diff);
    const isProofValid =
      isVerifiedMerge(mergeResult) &&
      mergeResult.runId === runId &&
      mergeResult.candidateSha === candidateSha &&
      mergeResult.candidateSha256 === recomputedCandidateSha256;

    if (!isProofValid) {
      if (isVerifiedMerge(mergeResult)) {
        const rollbackResult = await rollbackIntegrationRef(
          gitService,
          mergeResult,
          { gitDir: resolvedGitDir, runDir: report.runDir }
        );
        if (!rollbackResult.ok) {
          const rollbackReason =
            rollbackResult.reason ??
            "Failed to rollback integration ref after VerifiedMerge proof verification failure";
          emitRollbackFailedEvent(rollbackReason);
          return {
            ok: false,
            merged: false,
            state: "merge_rollback_failed",
            reason: rollbackReason,
            reasons: [rollbackReason],
            scopeResult,
            redactorResult,
            gateResult,
            verdict,
            mergeResult,
          };
        }
      }
      const reason = !isVerifiedMerge(mergeResult)
        ? "VerifiedMerge proof verification failed: merge result is not a valid VerifiedMerge instance"
        : "VerifiedMerge proof verification failed: proof fields mismatch (runId, candidateSha, or candidateSha256)";
      return {
        ok: false,
        merged: false,
        state: "in_review",
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
        mergeResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 9b: Ancestor check (B-3, N-5)
    // Verify with git that the candidate is in the new integration head.
    // -------------------------------------------------------------------------
    let integrationHeadSha: string | undefined =
      (mergeResult as any).integrationHeadSha ?? mergeResult.newHeadSha;
    if (!integrationHeadSha) {
      const integrationBranch = `graveyard/${runId}`;
      const branchRef = `refs/heads/${integrationBranch}`;
      try {
        integrationHeadSha = await execGitRead(gitService, resolvedGitDir, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          branchRef,
        ]);
      } catch {
        // unable to read the integration head ref; the ancestor check below
        // fails and the integration ref is rolled back
      }
    }

    const isCandidateShaValid = isValidSha(candidateSha);
    const isIntegrationHeadShaValid = isValidSha(integrationHeadSha);

    let ancestorVerified = false;
    if (isCandidateShaValid && isIntegrationHeadShaValid) {
      try {
        const res = await gitService.execGit([
          ...(resolvedGitDir ? ["-C", resolvedGitDir] : []),
          "merge-base",
          "--is-ancestor",
          candidateSha!,
          integrationHeadSha!,
        ]);
        // The ancestor check passes only when the exit code is exactly 0
        if (res && res.exitCode === 0) {
          ancestorVerified = true;
        }
      } catch {
        ancestorVerified = false;
      }
    }

    if (!ancestorVerified) {
      const rollbackResult = await rollbackIntegrationRef(
        gitService,
        mergeResult,
        { gitDir: resolvedGitDir, runDir: report.runDir }
      );
      if (!rollbackResult.ok) {
        const rollbackReason =
          rollbackResult.reason ??
          "Failed to rollback integration ref after ancestor check failure";
        emitRollbackFailedEvent(rollbackReason);
        return {
          ok: false,
          merged: false,
          state: "merge_rollback_failed",
          reason: rollbackReason,
          reasons: [rollbackReason],
          scopeResult,
          redactorResult,
          gateResult,
          verdict,
          mergeResult,
        };
      }
      const reason = "merge not verified in integration head";
      return {
        ok: false,
        merged: false,
        state: "in_review",
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
        mergeResult,
      };
    }

    // -------------------------------------------------------------------------
    // Step 10: Only after git succeeds and ancestor verified, apply merged state (B-3, N-3)
    // -------------------------------------------------------------------------
    // B-3/N-A1: the merge proof must be the VerifiedMerge instance returned by
    // the real GitService merge in Step 9; Scheduler.mergeTask accepts only a
    // VerifiedMerge (instanceof check) and never a plain object, and binds its
    // candidateSha to the evidence. The verdict carried by evidence is the
    // validated Warden verdict from Step 6 (validateWardenVerdict and the
    // install/build/accept/tests check gate both passed before Step 7).
    const schedulerEvidence: TaskMergeEvidence = {
      ...evidence,
      runId,
      gitMerge: mergeResult as unknown as TaskMergeEvidence["gitMerge"],
    };

    let taskMergeResult: MergeTaskResult | undefined;
    try {
      if (report.scheduler && taskId) {
        taskMergeResult = report.scheduler.mergeTask(
          taskId,
          schedulerEvidence
        );
        if (!taskMergeResult.ok || !taskMergeResult.merged) {
          throw new Error(
            taskMergeResult.reason ?? "Scheduler mergeTask failed"
          );
        }
        if (taskMergeResult.emissionSettledPromise) {
          const res = await taskMergeResult.emissionSettledPromise;
          if (!res.ok) {
            throw res.error instanceof Error
              ? res.error
              : new Error(String(res.error ?? "Task state emission failed"));
          }
        } else if (taskMergeResult.emissionPromise) {
          await taskMergeResult.emissionPromise;
        }
        if (report.scheduler.getTask(taskId)?.state !== "merged") {
          throw new Error(
            `Task state is not merged after scheduler mergeTask (current: ${report.scheduler.getTask(taskId)?.state})`
          );
        }
      } else if (taskObj) {
        (taskObj as any).state = "merged";
      }
    } catch (err: any) {
      // Guarded rollback (N-3, N-A12)
      const rollbackResult = await rollbackIntegrationRef(
        gitService,
        mergeResult,
        { gitDir: resolvedGitDir, runDir: report.runDir }
      );
      if (!rollbackResult.ok) {
        const rollbackReason =
          rollbackResult.reason ??
          "Failed to rollback integration ref after scheduler merge failure";
        emitRollbackFailedEvent(rollbackReason);
        return {
          ok: false,
          merged: false,
          state: "merge_rollback_failed",
          reason: rollbackReason,
          reasons: [rollbackReason],
          scopeResult,
          redactorResult,
          gateResult,
          verdict,
          mergeResult,
        };
      }
      const reason = `Failed to apply task merged state after git merge succeeded: ${err?.message ?? String(err)}`;
      return {
        ok: false,
        merged: false,
        state: "in_review",
        reason,
        reasons: [reason],
        scopeResult,
        redactorResult,
        gateResult,
        verdict,
        mergeResult,
      };
    }

    return {
      ok: true,
      merged: true,
      state: "merged",
      reasons: [],
      scopeResult,
      redactorResult,
      symlinkReport:
        symlinkReport ??
        (worktreeRoot ? scanForEscapingSymlinks(worktreeRoot) : undefined),
      gateResult,
      verdict,
      mergeResult,
      taskMergeResult,
    };
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    if (reason.startsWith("Invalid task state transition from")) {
      throw err;
    }
    const newState = failToRejected(report, taskId, reason);
    return {
      ok: false,
      merged: false,
      state: newState,
      reason,
      reasons: [reason],
    };
  }
}
