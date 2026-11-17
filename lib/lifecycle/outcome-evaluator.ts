import type {
  EarlyExitReason,
  OutcomeEvaluationInput,
  RunOutcome,
} from "./lifecycle-manager";
import { evaluateOutcome } from "./lifecycle-manager";
import type { TaskState } from "../events/types";

export type { TaskState };

export interface TaskItemInput {
  id?: string;
  state: TaskState | string;
  [key: string]: unknown;
}

export type TaskStateMap = Record<string, TaskState | string>;

export interface TaskStateSummary {
  readonly total: number;
  readonly merged: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly skipped: number;
  readonly blocked: number;
  readonly open: number;
  readonly inReview: number;
  readonly running: number;
  readonly allTerminal: boolean;
  readonly allMerged: boolean;
  readonly noneMerged: boolean;
  readonly hasFailures: boolean;
  readonly hasUnfinished: boolean;
}

export interface FinalCheckStatus {
  installPassed?: boolean | null;
  buildPassed?: boolean | null;
  testsPassed?: boolean | null;
  hasTests?: boolean | null;
  install?: unknown;
  build?: unknown;
  test?: unknown;
  tests?: unknown;
}

export interface ReportOutcomeEvaluationInput {
  tasks?:
    | readonly TaskItemInput[]
    | readonly TaskState[]
    | TaskStateMap
    | null;
  mergedTasksCount?: number | null;
  failedTasksCount?: number | null;
  totalTasksCount?: number | null;

  hasTests?: boolean | null;
  repoHasTests?: boolean | null;
  installPassed?: boolean | null;
  buildPassed?: boolean | null;
  testsPassed?: boolean | null;

  finalCheck?: FinalCheckStatus | null;

  earlyExitReason?: EarlyExitReason | string | null;
  reason?: EarlyExitReason | string | null;
  exitReason?: EarlyExitReason | string | null;
  stopReason?: string | null;

  userStop?: boolean | null;
  cancelled?: boolean | null;
  killed?: boolean | null;
  budgetStopped?: boolean | null;
  budgetExceeded?: boolean | null;
  healthyAlready?: boolean | null;
  noInitialFailures?: boolean | null;
  hasInitialFailures?: boolean | null;
  unrecoverableError?: boolean | null;
  error?: boolean | Error | string | null;

  outcome?: RunOutcome | string | null;
}

export interface ReportOutcomeResult {
  readonly outcome: RunOutcome;
  readonly summary: TaskStateSummary;
  readonly reason?: string;
  readonly evidence: readonly string[];
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "merged",
  "failed",
  "abandoned",
  "skipped",
]);

const OPEN_STATES: ReadonlySet<string> = new Set([
  "pending",
  "ready",
  "running",
  "in_review",
  "rejected",
  "blocked",
]);

/**
 * Normalizes diverse task representations into a uniform list of TaskItemInput.
 */
export function normalizeTaskList(
  tasksInput?:
    | readonly TaskItemInput[]
    | readonly TaskState[]
    | TaskStateMap
    | null
): TaskItemInput[] {
  if (!tasksInput) {
    return [];
  }

  if (Array.isArray(tasksInput)) {
    return tasksInput.map((item, idx) => {
      if (typeof item === "string") {
        return {
          id: `task-${idx + 1}`,
          state: item,
        };
      }
      if (item && typeof item === "object") {
        return {
          id: item.id ?? `task-${idx + 1}`,
          state: String(item.state ?? "pending"),
          ...item,
        };
      }
      return {
        id: `task-${idx + 1}`,
        state: "pending",
      };
    });
  }

  if (typeof tasksInput === "object") {
    return Object.entries(tasksInput).map(([id, state]) => ({
      id,
      state: typeof state === "string" ? state : String(state ?? "pending"),
    }));
  }

  return [];
}

/**
 * Computes deterministic statistics over normalized task items.
 * Pure function: does not mutate inputs.
 */
export function summarizeTaskStates(
  tasksInput?:
    | readonly TaskItemInput[]
    | readonly TaskState[]
    | TaskStateMap
    | null
): TaskStateSummary {
  const tasks = normalizeTaskList(tasksInput);
  let merged = 0;
  let failed = 0;
  let abandoned = 0;
  let skipped = 0;
  let blocked = 0;
  let inReview = 0;
  let running = 0;
  let open = 0;

  for (const t of tasks) {
    const s = (t.state ?? "").trim().toLowerCase();
    switch (s) {
      case "merged":
        merged++;
        break;
      case "failed":
        failed++;
        break;
      case "abandoned":
        abandoned++;
        break;
      case "skipped":
        skipped++;
        break;
      case "blocked":
        blocked++;
        open++;
        break;
      case "in_review":
        inReview++;
        open++;
        break;
      case "running":
        running++;
        open++;
        break;
      case "ready":
      case "pending":
      case "rejected":
        open++;
        break;
      default:
        if (OPEN_STATES.has(s)) {
          open++;
        }
        break;
    }
  }

  const total = tasks.length;
  const terminalCount = merged + failed + abandoned + skipped;
  const allTerminal = total > 0 && terminalCount === total;
  const allMerged = total > 0 && merged === total;
  const noneMerged = merged === 0;
  const hasFailures = failed > 0 || abandoned > 0;
  const hasUnfinished = open > 0;

  return {
    total,
    merged,
    failed,
    abandoned,
    skipped,
    blocked,
    open,
    inReview,
    running,
    allTerminal,
    allMerged,
    noneMerged,
    hasFailures,
    hasUnfinished,
  };
}

function parseBool(val: unknown): boolean | null {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "number") {
    return val === 0;
  }
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (s === "passed" || s === "success" || s === "ok" || s === "true") {
      return true;
    }
    if (s === "failed" || s === "error" || s === "false") {
      return false;
    }
  }
  if (val && typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (typeof rec.passed === "boolean") {
      return rec.passed;
    }
    if (typeof rec.ok === "boolean") {
      return rec.ok;
    }
    if (typeof rec.exitCode === "number") {
      return rec.exitCode === 0;
    }
    if (typeof rec.status === "string") {
      const s = rec.status.trim().toLowerCase();
      if (s === "passed" || s === "success" || s === "ok") {
        return true;
      }
      if (s === "failed" || s === "error") {
        return false;
      }
    }
  }
  return null;
}

/**
 * Pure outcome evaluator for the report step.
 * Computes terminal run outcome deterministically over task states and verification inputs.
 * Adheres strictly to Requirements 26.1, 26.2, 26.3, 26.14, 41.1, 41.3.
 */
export function evaluateReportOutcome(
  tasksOrInput:
    | ReportOutcomeEvaluationInput
    | readonly TaskItemInput[]
    | readonly TaskState[]
    | TaskStateMap
    | null,
  options?: Partial<ReportOutcomeEvaluationInput>
): RunOutcome {
  let input: ReportOutcomeEvaluationInput;

  if (
    tasksOrInput &&
    typeof tasksOrInput === "object" &&
    !Array.isArray(tasksOrInput) &&
    ("tasks" in tasksOrInput ||
      "finalCheck" in tasksOrInput ||
      "installPassed" in tasksOrInput ||
      "buildPassed" in tasksOrInput ||
      "testsPassed" in tasksOrInput ||
      "hasTests" in tasksOrInput ||
      "reason" in tasksOrInput ||
      "earlyExitReason" in tasksOrInput ||
      "userStop" in tasksOrInput ||
      "cancelled" in tasksOrInput ||
      "killed" in tasksOrInput ||
      "budgetStopped" in tasksOrInput ||
      "healthyAlready" in tasksOrInput ||
      "outcome" in tasksOrInput)
  ) {
    input = {
      ...(tasksOrInput as ReportOutcomeEvaluationInput),
      ...(options ?? {}),
    };
  } else {
    input = {
      tasks: tasksOrInput as
        | readonly TaskItemInput[]
        | readonly TaskState[]
        | TaskStateMap
        | null,
      ...(options ?? {}),
    };
  }

  // 1. Direct explicit outcome override if valid
  if (input.outcome) {
    const candidate = String(input.outcome).trim();
    if (candidate === "build-only" || candidate === "resurrected_build_only") {
      return "resurrected_build_only";
    }
    if (
      [
        "resurrected",
        "resurrected_build_only",
        "partial",
        "not_resurrected",
        "healthy_already",
        "cancelled",
        "killed",
        "budget_stopped",
        "error",
      ].includes(candidate)
    ) {
      return candidate as RunOutcome;
    }
  }

  const reason = (
    input.reason ??
    input.earlyExitReason ??
    input.exitReason ??
    input.stopReason ??
    ""
  )
    .trim()
    .toLowerCase();

  // 2. Early exit outcomes
  // 2a. Healthy already
  if (
    input.healthyAlready === true ||
    input.noInitialFailures === true ||
    reason === "healthy_already" ||
    (input.hasInitialFailures === false && (input.userStop || reason))
  ) {
    return "healthy_already";
  }

  // 2b. Cancelled: user stop
  if (
    input.userStop === true ||
    input.cancelled === true ||
    reason === "user_stop" ||
    reason === "cancelled" ||
    reason === "stop_run" ||
    reason === "user_action"
  ) {
    return "cancelled";
  }

  // 2c. Killed: admin kill
  if (
    input.killed === true ||
    reason === "killed" ||
    reason === "admin_kill" ||
    reason === "admin.kill"
  ) {
    return "killed";
  }

  // 2d. Budget stopped
  if (
    input.budgetStopped === true ||
    input.budgetExceeded === true ||
    reason === "budget_stopped" ||
    reason === "budget_stop" ||
    reason === "budget_exceeded" ||
    reason === "budget.exceeded"
  ) {
    return "budget_stopped";
  }

  // 2e. Error: unrecoverable errors
  if (
    input.unrecoverableError === true ||
    Boolean(input.error) ||
    reason === "error" ||
    reason === "unrecoverable_error" ||
    reason === "fatal" ||
    reason === "box_lost"
  ) {
    return "error";
  }

  // 3. Resolve installation, build, and test results
  let installPassed =
    input.installPassed ??
    input.finalCheck?.installPassed ??
    parseBool(input.finalCheck?.install);

  const buildPassed =
    input.buildPassed ??
    input.finalCheck?.buildPassed ??
    parseBool(input.finalCheck?.build);

  const testVal =
    input.finalCheck?.test ??
    input.finalCheck?.tests;

  let hasTests: boolean | null = null;
  if (typeof input.hasTests === "boolean") {
    hasTests = input.hasTests;
  } else if (typeof input.repoHasTests === "boolean") {
    hasTests = input.repoHasTests;
  } else if (typeof input.finalCheck?.hasTests === "boolean") {
    hasTests = input.finalCheck.hasTests;
  } else if (
    testVal === "no_tests_found" ||
    (testVal &&
      typeof testVal === "object" &&
      "status" in (testVal as Record<string, unknown>) &&
      (testVal as Record<string, unknown>).status === "no_tests_found")
  ) {
    hasTests = false;
  } else if (input.testsPassed !== undefined && input.testsPassed !== null) {
    hasTests = true;
  }

  const testsPassed =
    input.testsPassed ??
    input.finalCheck?.testsPassed ??
    parseBool(testVal);

  // Requirement 41.1: If repository installation still fails after the Legion phase,
  // THE Necromancer SHALL end the run with outcome not_resurrected.
  if (installPassed === false) {
    return "not_resurrected";
  }

  // If installPassed was not explicitly set: if build or tests passed, install must have succeeded
  if (installPassed === null || installPassed === undefined) {
    if (buildPassed === true || testsPassed === true) {
      installPassed = true;
    }
  }

  // 4. Summarize task states
  const summary = summarizeTaskStates(input.tasks);

  // If explicit task counts are supplied
  const mergedCount =
    typeof input.mergedTasksCount === "number"
      ? input.mergedTasksCount
      : summary.merged;
  const failedCount =
    typeof input.failedTasksCount === "number"
      ? input.failedTasksCount
      : summary.failed + summary.abandoned;
  const totalCount =
    typeof input.totalTasksCount === "number"
      ? input.totalTasksCount
      : summary.total;

  // Case: No tasks were merged (and tasks existed)
  if (totalCount > 0 && mergedCount === 0) {
    return "not_resurrected";
  }

  // Case: Some tasks were merged, but not all tasks succeeded
  // (some tasks failed, abandoned, were skipped, or left open)
  const hasIncompleteTasks =
    totalCount > 0 &&
    (failedCount > 0 ||
      summary.abandoned > 0 ||
      summary.skipped > 0 ||
      summary.open > 0 ||
      mergedCount < totalCount);

  if (mergedCount > 0 && hasIncompleteTasks) {
    // When some tasks succeeded but others didn't -> partial
    return "partial";
  }

  // Case: All tasks merged (or no tasks defined, but execution succeeded)
  // Check tests & build
  // Requirement 26.14 & 41.3: When the repository has no tests and the final_check build passes,
  // assign resurrected_build_only.
  if (hasTests === false) {
    if (buildPassed === true) {
      return "resurrected_build_only";
    }
    if (installPassed === true && buildPassed === false) {
      return "partial";
    }
    if (buildPassed === false) {
      return "not_resurrected";
    }
    // If buildPassed is null/unspecified but all tasks merged without tests
    if (mergedCount > 0 && !hasIncompleteTasks) {
      return "resurrected_build_only";
    }
  }

  // Requirement 26.3: When evaluating for resurrected, assign resurrected only
  // when final_check build and repository tests have passed.
  if (buildPassed === true && testsPassed === true) {
    return "resurrected";
  }

  // If install passed, but build or tests failed -> partial
  if (installPassed === true) {
    if (buildPassed === false || testsPassed === false) {
      return "partial";
    }
  }

  // If all tasks merged and build passed, but tests are null/unspecified:
  // if hasTests is not false, require tests to pass for resurrected.
  if (mergedCount > 0 && !hasIncompleteTasks) {
    if (buildPassed === true && testsPassed === true) {
      return "resurrected";
    }
    if (buildPassed === true && hasTests === false) {
      return "resurrected_build_only";
    }
    if (installPassed === true) {
      return "partial";
    }
  }

  // Fallback to merged lifecycle evaluateOutcome for parity
  const fallbackInput: OutcomeEvaluationInput = {
    reason: input.reason ?? input.earlyExitReason ?? input.exitReason ?? input.stopReason,
    outcome: input.outcome,
    userStop: input.userStop,
    cancelled: input.cancelled,
    killed: input.killed,
    budgetStopped: input.budgetStopped,
    budgetExceeded: input.budgetExceeded,
    healthyAlready: input.healthyAlready,
    noInitialFailures: input.noInitialFailures,
    hasInitialFailures: input.hasInitialFailures,
    unrecoverableError: input.unrecoverableError,
    error: input.error,
    mergedTasksCount: mergedCount,
    failedTasksCount: failedCount,
    totalTasksCount: totalCount,
    installPassed,
    buildPassed,
    testsPassed,
    hasTests,
  };

  return evaluateOutcome(fallbackInput);
}

/**
 * Pure evaluator that returns the outcome alongside a detailed breakdown and evidence.
 */
export function evaluateReportOutcomeWithDetails(
  tasksOrInput:
    | ReportOutcomeEvaluationInput
    | readonly TaskItemInput[]
    | readonly TaskState[]
    | TaskStateMap
    | null,
  options?: Partial<ReportOutcomeEvaluationInput>
): ReportOutcomeResult {
  const summary = summarizeTaskStates(
    typeof tasksOrInput === "object" &&
      tasksOrInput !== null &&
      "tasks" in tasksOrInput
      ? (tasksOrInput as ReportOutcomeEvaluationInput).tasks
      : (tasksOrInput as
          | readonly TaskItemInput[]
          | readonly TaskState[]
          | TaskStateMap
          | null)
  );

  const outcome = evaluateReportOutcome(tasksOrInput, options);

  const evidence: string[] = [];
  evidence.push(`tasks.total:${summary.total}`);
  evidence.push(`tasks.merged:${summary.merged}`);
  evidence.push(`tasks.failed:${summary.failed}`);
  evidence.push(`tasks.abandoned:${summary.abandoned}`);
  evidence.push(`tasks.skipped:${summary.skipped}`);

  let reasonDesc: string;
  switch (outcome) {
    case "resurrected":
      reasonDesc = "All tasks merged, and final check build and tests passed";
      break;
    case "resurrected_build_only":
      reasonDesc = "All tasks merged, repository has no tests, and build passed";
      break;
    case "partial":
      reasonDesc =
        summary.merged > 0 && (summary.failed > 0 || summary.skipped > 0)
          ? "Some tasks merged while others failed or were skipped"
          : "Work was completed but final verification was only partial";
      break;
    case "not_resurrected":
      reasonDesc =
        summary.noneMerged && summary.total > 0
          ? "No tasks were merged into the integration branch"
          : "Installation or critical steps failed";
      break;
    case "healthy_already":
      reasonDesc = "Repository had no initial failures";
      break;
    case "cancelled":
      reasonDesc = "Run was stopped by user request";
      break;
    case "killed":
      reasonDesc = "Run was terminated by administrative action";
      break;
    case "budget_stopped":
      reasonDesc = "Run was stopped due to budget limit exhaustion";
      break;
    case "error":
      reasonDesc = "Run encountered an unrecoverable system error";
      break;
  }

  return {
    outcome,
    summary,
    reason: reasonDesc,
    evidence,
  };
}

/**
 * Alias for evaluateReportOutcome for caller convenience.
 */
export const evaluateOutcomeFromTaskStates = evaluateReportOutcome;
export const evaluateTaskOutcome = evaluateReportOutcome;
