// Task 12.3: Pact review step - edit, approve and budget checks
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.8, 13.10, 36.8, 36.9, 36.10, 36.11, 36.12, 36.13

import {
  ALLOWED_ROLES,
  ALLOWED_RULES,
  isCommandBlocked,
  isPathOutsideRepo,
  PactErrorCodes,
  type CommandPolicyDecision,
  type PactErrorCode,
  type PactParserOptions,
  type PactRole,
  type PactTask,
  type RuleId,
} from "./pact-parser";

// ---------------------------------------------------------------------------
// Constants & Non-Removable Requirements (Requirement 13.5, 36.8)
// ---------------------------------------------------------------------------

export const NON_REMOVABLE_REQUIREMENTS = [
  "warden_final_check",
  "scribe_report",
  "grimoire_gate",
] as const;

export type NonRemovableRequirement =
  (typeof NON_REMOVABLE_REQUIREMENTS)[number];

export const NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS: Record<
  NonRemovableRequirement,
  string
> = {
  warden_final_check:
    "The Warden final check is a required verification phase before any run can complete.",
  scribe_report:
    "The Scribe report is a required evidence reporting phase that documents all resurrected changes.",
  grimoire_gate:
    "The Grimoire syntax gate is a required safety check enforcing code integrity rules M1-M6.",
};

export const BUDGET_WARNING_THRESHOLD = 0.8;
export const BUDGET_EXCEEDED_THRESHOLD = 1.0;

export const BUDGET_CHECK_TERMS_NOTE =
  "The cap is checked between tool calls. A single tool call may finish after the cap is reached.";

export const BUDGET_CREDITS_UNREPORTED_NOTE =
  "Credits are not reported by the CLI; the cap is minutes and tool calls";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FlaggedTaskDependency {
  taskId: string;
  dependsOnDisabled: string;
  message: string;
}

export interface PactEditError {
  code: PactErrorCode | string;
  message: string;
  task?: string;
  details?: Record<string, unknown> | string;
}

export interface ValidateEditOptions extends PactParserOptions {
  originalTasks?: readonly PactTask[] | PactTask[];
  removedRequirementIds?: readonly string[] | string[];
  disabledTaskIds?: readonly string[] | string[];
  acceptMissingCheckResponsibility?: boolean;
}

export interface PactEditValidationResult {
  ok: boolean;
  errors: PactEditError[];
  warnings: string[];
  flaggedTasks: FlaggedTaskDependency[];
  addedTaskIds: string[];
  removedTaskIds: string[];
  modifiedTaskIds: string[];
  tasks: PactTask[];
}

export interface PactBudget {
  maxMinutes: number;
  maxParallel: number;
  maxCredits?: number | null;
  maxToolCalls?: number;
}

export interface BudgetCeiling {
  maxMinutes?: number;
  maxParallel?: number;
  maxCredits?: number | null;
  maxToolCalls?: number;
}

export interface BudgetUsage {
  minutes?: number;
  runningMs?: number;
  credits?: number | null;
  toolCalls?: number;
  runningParallel?: number;
  liveSkeletons?: number;
}

export type BudgetDimension = "minutes" | "parallel" | "credits" | "toolCalls";

export interface BudgetValidationResult {
  ok: boolean;
  errors: string[];
  normalizedBudget?: PactBudget;
}

export interface DimensionUsageDetail {
  current: number | null;
  cap: number | null;
  ratio: number | null;
  percent: number | null;
  warning: boolean;
  exceeded: boolean;
}

export interface BudgetUsageCheckResult {
  ok: boolean;
  exceeded: boolean;
  warning: boolean;
  percent: number;
  ratio: number;
  cappedDimension?: BudgetDimension;
  exceededDimensions: BudgetDimension[];
  warningDimensions: BudgetDimension[];
  dimensions: Record<BudgetDimension, DimensionUsageDetail>;
}

export interface BudgetTermsDisplay {
  termsNote: string;
  creditsNote?: string;
  maxMinutesFormatted: string;
  maxParallelFormatted: string;
  maxCreditsFormatted: string;
  maxToolCallsFormatted?: string;
}

export interface RecordApprovalOptions {
  approvedTaskIds: readonly string[] | string[] | Set<string>;
  pactVersion: number;
  budget: PactBudget;
  actor?: string;
  runId?: string;
  now?: number;
  originalTasks?: readonly PactTask[] | PactTask[];
  ceiling?: BudgetCeiling;
}

export interface PactApprovedEvent {
  kind: "pact.approved";
  runId?: string;
  actor: string;
  ts: number;
  data: {
    pactVersion: number;
    approvedTaskIds: string[];
    budget: PactBudget;
  };
}

export interface PactApprovalRecord {
  ok: boolean;
  pactVersion: number;
  approvedTaskIds: string[];
  disabledTaskIds: string[];
  allTaskIds: string[];
  budget: PactBudget;
  approvedAt: number;
  approvedBy: string;
  flaggedTasks: FlaggedTaskDependency[];
  errors: string[];
  event: PactApprovedEvent;
}

// ---------------------------------------------------------------------------
// Pure Cycle Detector
// ---------------------------------------------------------------------------

export function detectDependencyCyclesInTasks(
  tasks: Array<{ id: string; dependencies: string[] }>
): string[][] {
  const taskMap = new Map<string, string[]>();
  for (const t of tasks) {
    taskMap.set(t.id, t.dependencies || []);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const seenCycles = new Set<string>();

  function dfs(taskId: string): void {
    visiting.add(taskId);
    path.push(taskId);

    const deps = taskMap.get(taskId) || [];
    for (const depId of deps) {
      if (!taskMap.has(depId)) {
        continue;
      }
      if (visiting.has(depId)) {
        const cycleStartIndex = path.indexOf(depId);
        const cycleMembers = path.slice(cycleStartIndex);
        cycleMembers.push(depId);
        const cycleStr = cycleMembers.join(" -> ");

        const canonical = [...cycleMembers].sort().join(",");
        if (!seenCycles.has(canonical)) {
          seenCycles.add(canonical);
          cycles.push(cycleMembers);
        }
      } else if (!visited.has(depId)) {
        dfs(depId);
      }
    }

    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const t of tasks) {
    if (!visited.has(t.id)) {
      dfs(t.id);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Non-Removable Requirements Helpers
// ---------------------------------------------------------------------------

function matchNonRemovableRequirement(text: string): NonRemovableRequirement | null {
  const lower = text.toLowerCase();
  if (lower.includes("warden") && (lower.includes("check") || lower.includes("verdict") || lower.includes("final"))) {
    return "warden_final_check";
  }
  if (lower.includes("warden_final_check") || lower === "warden") {
    return "warden_final_check";
  }
  if (lower.includes("scribe") && (lower.includes("report") || lower.includes("evidence"))) {
    return "scribe_report";
  }
  if (lower.includes("scribe_report") || lower === "scribe") {
    return "scribe_report";
  }
  if (lower.includes("grimoire") && (lower.includes("gate") || lower.includes("syntax"))) {
    return "grimoire_gate";
  }
  if (lower.includes("grimoire_gate") || lower === "gate") {
    return "grimoire_gate";
  }
  return null;
}

export function isNonRemovableTask(task: Partial<PactTask>): NonRemovableRequirement | null {
  const customLocked = (task as { nonRemovable?: boolean; locked?: boolean }).nonRemovable ??
    (task as { nonRemovable?: boolean; locked?: boolean }).locked;
  if (customLocked && task.id) {
    const matched = matchNonRemovableRequirement(task.id);
    if (matched) {
      return matched;
    }
  }

  if (task.title) {
    const matched = matchNonRemovableRequirement(task.title);
    if (matched) {
      return matched;
    }
  }

  if (task.id) {
    const matched = matchNonRemovableRequirement(task.id);
    if (matched) {
      return matched;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pure Function 1: Validate an Edit (Requirements 13.2, 13.5, 36.8, 36.9, 36.10)
// ---------------------------------------------------------------------------

export function validateEdit(
  first: readonly PactTask[] | PactTask[],
  second?: readonly PactTask[] | PactTask[] | ValidateEditOptions,
  third?: ValidateEditOptions
): PactEditValidationResult {
  let originalTasks: readonly PactTask[] | undefined;
  let editedTasks: readonly PactTask[];
  let options: ValidateEditOptions | undefined;

  if (Array.isArray(first) && Array.isArray(second)) {
    originalTasks = first;
    editedTasks = second;
    options = third;
  } else {
    editedTasks = first;
    options = second as ValidateEditOptions | undefined;
    if (options?.originalTasks) {
      originalTasks = options.originalTasks;
    }
  }

  const errors: PactEditError[] = [];
  const warnings: string[] = [];
  const flaggedTasks: FlaggedTaskDependency[] = [];

  const addedTaskIds: string[] = [];
  const removedTaskIds: string[] = [];
  const modifiedTaskIds: string[] = [];

  const roleSet = new Set<string>(ALLOWED_ROLES);
  const ruleSet = new Set<string>(ALLOWED_RULES);

  // 1. Check non-removable requirements in explicitly removed list
  if (options?.removedRequirementIds) {
    for (const reqId of options.removedRequirementIds) {
      const matched = matchNonRemovableRequirement(reqId);
      if (matched) {
        errors.push({
          code: "NON_REMOVABLE_REQUIREMENT",
          task: reqId,
          message: `Cannot remove non-removable requirement '${matched}': ${NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS[matched]}`,
          details: { requirement: matched },
        });
      }
    }
  }

  // 2. Check if originalTasks had locked non-removable requirements removed
  if (originalTasks && originalTasks.length > 0) {
    const editedIds = new Set(editedTasks.map((t) => t.id));
    const originalMap = new Map(originalTasks.map((t) => [t.id, t]));

    for (const orig of originalTasks) {
      if (!editedIds.has(orig.id)) {
        removedTaskIds.push(orig.id);
        const nonRemovable = isNonRemovableTask(orig);
        if (nonRemovable) {
          errors.push({
            code: "NON_REMOVABLE_REQUIREMENT",
            task: orig.id,
            message: `Cannot remove non-removable requirement '${nonRemovable}' in task ${orig.id}: ${NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS[nonRemovable]}`,
            details: { taskId: orig.id, requirement: nonRemovable },
          });
        }
      }
    }

    for (const edited of editedTasks) {
      const orig = originalMap.get(edited.id);
      if (!orig) {
        addedTaskIds.push(edited.id);
        if (!options?.acceptMissingCheckResponsibility) {
          warnings.push(
            `Task ${edited.id} was added by user and requires planner revision or explicit responsibility acceptance`
          );
        }
      } else {
        const isModified =
          orig.title !== edited.title ||
          orig.role !== edited.role ||
          orig.accept !== edited.accept ||
          orig.acceptanceCommand !== edited.acceptanceCommand ||
          orig.hard !== edited.hard ||
          JSON.stringify(orig.dependencies ?? orig.depends ?? []) !==
            JSON.stringify(edited.dependencies ?? edited.depends ?? []) ||
          JSON.stringify(orig.files ?? orig.filesInScope ?? []) !==
            JSON.stringify(edited.files ?? edited.filesInScope ?? []) ||
          JSON.stringify(orig.rules ?? orig.ruleIds ?? []) !==
            JSON.stringify(edited.rules ?? edited.ruleIds ?? []);
        if (isModified) {
          modifiedTaskIds.push(edited.id);
        }
      }
    }
  }

  // 3. Validate task list not empty
  if (editedTasks.length === 0) {
    errors.push({
      code: PactErrorCodes.EMPTY_PACT,
      message: "No tasks found in edited Pact",
    });
    return {
      ok: false,
      errors,
      warnings,
      flaggedTasks,
      addedTaskIds,
      removedTaskIds,
      modifiedTaskIds,
      tasks: [],
    };
  }

  // 4. Validate each task
  const seenTaskIds = new Set<string>();
  const normalizedTasks: PactTask[] = [];

  for (const raw of editedTasks) {
    const taskId = (raw.id ?? "").trim();

    // ID format check (Requirement 12.5)
    if (!/^T\d+$/.test(taskId)) {
      errors.push({
        code: PactErrorCodes.INVALID_TASK_ID,
        task: taskId,
        message: `Task ID '${taskId}' does not match T<n>`,
      });
    }

    // Duplicate ID check (Requirement 12.5)
    if (seenTaskIds.has(taskId)) {
      errors.push({
        code: PactErrorCodes.DUPLICATE_TASK_ID,
        task: taskId,
        message: `Task ID '${taskId}' repeats`,
      });
    } else if (taskId.length > 0) {
      seenTaskIds.add(taskId);
    }

    // Title check
    const title = (raw.title ?? "").trim();
    if (title.length === 0) {
      errors.push({
        code: PactErrorCodes.INVALID_SYNTAX,
        task: taskId,
        message: `Task ${taskId} is missing a title`,
      });
    }

    // Role check (Requirement 12.6)
    const roleRaw = ((raw.role as string) ?? "").trim().toLowerCase();
    if (!roleSet.has(roleRaw)) {
      errors.push({
        code: PactErrorCodes.INVALID_ROLE,
        task: taskId,
        message: `Task ${taskId} has invalid role: '${raw.role}'. Role must be 'bonesetter' or 'soul-stitcher'.`,
      });
    }
    const role = (roleRaw === "soul-stitcher" ? "soul-stitcher" : "bonesetter") as PactRole;

    // Files check (Requirement 12.8)
    const rawFiles = raw.files ?? raw.filesInScope ?? [];
    const files = Array.isArray(rawFiles)
      ? rawFiles.map((f) => String(f).trim()).filter((f) => f.length > 0)
      : [];
    if (files.length === 0) {
      errors.push({
        code: PactErrorCodes.EMPTY_FILES,
        task: taskId,
        message: `Task ${taskId} has empty files list`,
      });
    } else {
      for (const f of files) {
        if (isPathOutsideRepo(f)) {
          errors.push({
            code: PactErrorCodes.PATH_OUTSIDE_REPO,
            task: taskId,
            message: `Task ${taskId} names a path outside the repository: '${f}'`,
            details: { path: f },
          });
        }
      }
    }

    // Acceptance command check (Requirement 12.9)
    const acceptCmd = (raw.acceptanceCommand ?? raw.accept ?? "").trim();
    if (acceptCmd.length === 0) {
      errors.push({
        code: PactErrorCodes.EMPTY_ACCEPT_COMMAND,
        task: taskId,
        message: `Task ${taskId} acceptance command is empty`,
      });
    } else {
      const blockedCheck: CommandPolicyDecision = isCommandBlocked(acceptCmd, options);
      if (blockedCheck.blocked) {
        errors.push({
          code: PactErrorCodes.BLOCKED_COMMAND,
          task: taskId,
          message: `Task ${taskId} accept command classifies as blocked under CommandPolicy: '${acceptCmd}'. ${blockedCheck.reason ?? ""}`.trim(),
          details: { command: acceptCmd, reason: blockedCheck.reason },
        });
      }
    }

    // Hard flag check (Requirement 12.10)
    let hard = false;
    let hardRaw: "yes" | "no" = "no";
    let hardInvalid = false;

    if (raw.hardRaw !== undefined) {
      const clean = String(raw.hardRaw).trim().toLowerCase();
      if (clean === "yes") {
        hard = true;
        hardRaw = "yes";
      } else if (clean === "no") {
        hard = false;
        hardRaw = "no";
      } else {
        hardInvalid = true;
        errors.push({
          code: PactErrorCodes.INVALID_HARD_FLAG,
          task: taskId,
          message: `Task ${taskId} has invalid hard flag: '${raw.hardRaw}'. Must be 'yes' or 'no'.`,
        });
      }
    } else if (typeof (raw as { hard?: unknown }).hard === "string") {
      const rawHardStr = (raw as { hard?: unknown }).hard as string;
      const clean = rawHardStr.trim().toLowerCase();
      if (clean === "yes") {
        hard = true;
        hardRaw = "yes";
      } else if (clean === "no") {
        hard = false;
        hardRaw = "no";
      } else {
        hardInvalid = true;
        errors.push({
          code: PactErrorCodes.INVALID_HARD_FLAG,
          task: taskId,
          message: `Task ${taskId} has invalid hard flag: '${rawHardStr}'. Must be 'yes' or 'no'.`,
        });
      }
    } else if (typeof (raw as { hard?: unknown }).hard === "boolean") {
      hard = (raw as { hard: boolean }).hard;
      hardRaw = hard ? "yes" : "no";
    } else if (typeof (raw as { hardFlag?: unknown }).hardFlag === "boolean") {
      hard = (raw as { hardFlag: boolean }).hardFlag;
      hardRaw = hard ? "yes" : "no";
    } else if ((raw as { hard?: unknown }).hard !== undefined || (raw as { hardFlag?: unknown }).hardFlag !== undefined) {
      hardInvalid = true;
      errors.push({
        code: PactErrorCodes.INVALID_HARD_FLAG,
        task: taskId,
        message: `Task ${taskId} has invalid hard flag`,
      });
    }

    // Rules check (Requirement 12.11)
    const rawRules = raw.rules ?? raw.ruleIds ?? [];
    const ruleIds: RuleId[] = [];
    if (Array.isArray(rawRules)) {
      for (const r of rawRules) {
        const cleaned = String(r).trim().toUpperCase();
        if (ruleSet.has(cleaned)) {
          ruleIds.push(cleaned as RuleId);
        } else {
          errors.push({
            code: PactErrorCodes.INVALID_RULE,
            task: taskId,
            message: `Task ${taskId} cites invalid rule: '${r}'. Allowed rules are M1 through M6.`,
          });
        }
      }
    }

    // Dependencies list normalization
    const rawDeps = raw.dependencies ?? raw.depends ?? raw.dependsOn ?? [];
    const dependencies = Array.isArray(rawDeps)
      ? rawDeps.map((d) => String(d).trim()).filter((d) => d.length > 0)
      : [];

    normalizedTasks.push({
      id: taskId,
      title,
      role,
      dependencies,
      depends: dependencies,
      dependsOn: dependencies,
      files,
      filesInScope: files,
      acceptanceCommand: acceptCmd,
      accept: acceptCmd,
      hard,
      hardFlag: hard,
      hardRaw,
      ruleIds,
      rules: ruleIds,
      line: raw.line ?? 1,
    });
  }

  // 5. Cross-task dependency validation (Requirements 12.7, 36.9)
  const definedIds = new Set(normalizedTasks.map((t) => t.id));

  for (const t of normalizedTasks) {
    for (const depId of t.dependencies) {
      if (!definedIds.has(depId)) {
        errors.push({
          code: PactErrorCodes.MISSING_DEPENDENCY,
          task: t.id,
          message: `Task ${t.id} depends on missing task ID: '${depId}'`,
          details: { missingId: depId },
        });
      }
    }
  }

  // 6. Dependency cycle check (Requirements 12.7, 36.9)
  const cycleList = detectDependencyCyclesInTasks(normalizedTasks);
  for (const cycle of cycleList) {
    const cycleStr = cycle.join(" -> ");
    errors.push({
      code: PactErrorCodes.DEPENDENCY_CYCLE,
      task: cycle[0],
      message: `Task dependencies form a cycle: ${cycleStr}`,
      details: { cycle, cycleString: cycleStr },
    });
  }

  // 7. Flag tasks that depend on disabled/turned-off tasks (Requirement 36.10)
  const disabledSet = new Set<string>();
  if (options?.disabledTaskIds) {
    for (const d of options.disabledTaskIds) {
      disabledSet.add(d);
    }
  }

  if (disabledSet.size > 0) {
    // Check if non-removable task was turned off
    for (const d of disabledSet) {
      const origTask = originalTasks?.find((t) => t.id === d);
      const nonRem = origTask ? isNonRemovableTask(origTask) : matchNonRemovableRequirement(d);
      if (nonRem) {
        errors.push({
          code: "NON_REMOVABLE_REQUIREMENT",
          task: d,
          message: `Cannot turn off non-removable requirement '${nonRem}' in task ${d}: ${NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS[nonRem]}`,
          details: { taskId: d, requirement: nonRem },
        });
      }
    }

    for (const t of normalizedTasks) {
      if (!disabledSet.has(t.id)) {
        for (const depId of t.dependencies) {
          if (disabledSet.has(depId)) {
            flaggedTasks.push({
              taskId: t.id,
              dependsOnDisabled: depId,
              message: `Task ${t.id} depends on ${depId}, which is off.`,
            });
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    flaggedTasks,
    addedTaskIds,
    removedTaskIds,
    modifiedTaskIds,
    tasks: normalizedTasks,
  };
}

export const validatePactEdit = validateEdit;

// ---------------------------------------------------------------------------
// Pure Function 3: Check the Pact Budget (Requirements 13.4, 30.5, 30.6, 36.11, 36.12, 36.13)
// ---------------------------------------------------------------------------

export function validateBudget(
  budget: unknown,
  ceiling?: BudgetCeiling
): BudgetValidationResult {
  const errors: string[] = [];

  if (!budget || typeof budget !== "object") {
    return {
      ok: false,
      errors: ["Budget must be an object"],
    };
  }

  const b = budget as Record<string, unknown>;

  // maxMinutes: positive finite number
  let maxMinutes = 0;
  if (typeof b.maxMinutes !== "number" || !Number.isFinite(b.maxMinutes) || b.maxMinutes <= 0) {
    errors.push("maxMinutes must be a positive number greater than 0");
  } else {
    maxMinutes = b.maxMinutes;
    if (ceiling?.maxMinutes !== undefined && ceiling.maxMinutes !== null && maxMinutes > ceiling.maxMinutes) {
      errors.push(
        `maxMinutes (${maxMinutes}) exceeds ceiling of ${ceiling.maxMinutes}`
      );
    }
  }

  // maxParallel: positive integer >= 1
  let maxParallel = 1;
  if (
    typeof b.maxParallel !== "number" ||
    !Number.isInteger(b.maxParallel) ||
    b.maxParallel < 1
  ) {
    errors.push("maxParallel must be an integer >= 1");
  } else {
    maxParallel = b.maxParallel;
    if (ceiling?.maxParallel !== undefined && ceiling.maxParallel !== null && maxParallel > ceiling.maxParallel) {
      errors.push(
        `maxParallel (${maxParallel}) exceeds ceiling of ${ceiling.maxParallel}`
      );
    }
  }

  // maxCredits: null or non-negative number
  let maxCredits: number | null | undefined = undefined;
  if (b.maxCredits !== undefined) {
    if (b.maxCredits === null) {
      maxCredits = null;
    } else if (typeof b.maxCredits === "number" && Number.isFinite(b.maxCredits) && b.maxCredits >= 0) {
      maxCredits = b.maxCredits;
      if (
        ceiling?.maxCredits !== undefined &&
        ceiling.maxCredits !== null &&
        maxCredits > ceiling.maxCredits
      ) {
        errors.push(
          `maxCredits (${maxCredits}) exceeds ceiling of ${ceiling.maxCredits}`
        );
      }
    } else {
      errors.push("maxCredits must be a non-negative number or null");
    }
  }

  // maxToolCalls: optional positive integer
  let maxToolCalls: number | undefined = undefined;
  if (b.maxToolCalls !== undefined && b.maxToolCalls !== null) {
    if (
      typeof b.maxToolCalls === "number" &&
      Number.isInteger(b.maxToolCalls) &&
      b.maxToolCalls >= 1
    ) {
      maxToolCalls = b.maxToolCalls;
      if (
        ceiling?.maxToolCalls !== undefined &&
        ceiling.maxToolCalls !== null &&
        maxToolCalls > ceiling.maxToolCalls
      ) {
        errors.push(
          `maxToolCalls (${maxToolCalls}) exceeds ceiling of ${ceiling.maxToolCalls}`
        );
      }
    } else {
      errors.push("maxToolCalls must be an integer >= 1");
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  const normalizedBudget: PactBudget = {
    maxMinutes,
    maxParallel,
    maxCredits,
    maxToolCalls,
  };

  return {
    ok: true,
    errors: [],
    normalizedBudget,
  };
}

export function checkBudgetUsage(
  budget: PactBudget,
  usage: BudgetUsage
): BudgetUsageCheckResult {
  const exceededDimensions: BudgetDimension[] = [];
  const warningDimensions: BudgetDimension[] = [];

  let maxRatio = 0;
  let cappedDimension: BudgetDimension | undefined = undefined;

  function evaluateDimension(
    name: BudgetDimension,
    current: number | null,
    cap: number | null
  ): DimensionUsageDetail {
    if (cap === null || cap <= 0 || current === null) {
      return {
        current,
        cap,
        ratio: null,
        percent: null,
        warning: false,
        exceeded: false,
      };
    }

    const ratio = current / cap;
    const percent = Math.round(ratio * 10000) / 100;
    const isExceeded = ratio >= BUDGET_EXCEEDED_THRESHOLD;
    const isWarning = ratio >= BUDGET_WARNING_THRESHOLD && !isExceeded;

    if (isExceeded) {
      exceededDimensions.push(name);
    } else if (isWarning) {
      warningDimensions.push(name);
    }

    if (ratio > maxRatio) {
      maxRatio = ratio;
      cappedDimension = name;
    }

    return {
      current,
      cap,
      ratio,
      percent,
      warning: isWarning,
      exceeded: isExceeded,
    };
  }

  // Minutes
  const currentMinutes =
    usage.minutes ?? (usage.runningMs !== undefined ? usage.runningMs / 60000 : 0);
  const minutesDetail = evaluateDimension("minutes", currentMinutes, budget.maxMinutes);

  // Parallel
  const currentParallel = usage.runningParallel ?? usage.liveSkeletons ?? 0;
  const parallelDetail = evaluateDimension("parallel", currentParallel, budget.maxParallel);

  // Credits (only evaluated if budget has cap and usage is reported)
  const currentCredits = usage.credits ?? null;
  const creditsCap = budget.maxCredits ?? null;
  const creditsDetail = evaluateDimension("credits", currentCredits, creditsCap);

  // Tool calls
  const currentToolCalls = usage.toolCalls ?? null;
  const toolCallsCap = budget.maxToolCalls ?? null;
  const toolCallsDetail = evaluateDimension(
    "toolCalls",
    currentToolCalls,
    toolCallsCap
  );

  const percent = Math.round(maxRatio * 10000) / 100;
  const exceeded = exceededDimensions.length > 0;
  const warning = warningDimensions.length > 0 || exceeded;

  return {
    ok: !exceeded,
    exceeded,
    warning,
    percent,
    ratio: maxRatio,
    cappedDimension,
    exceededDimensions,
    warningDimensions,
    dimensions: {
      minutes: minutesDetail,
      parallel: parallelDetail,
      credits: creditsDetail,
      toolCalls: toolCallsDetail,
    },
  };
}

export function checkPactBudget(
  budget: PactBudget,
  options?:
    | {
        ceiling?: BudgetCeiling;
        usage?: BudgetUsage;
      }
    | BudgetCeiling
): {
  ok: boolean;
  valid: boolean;
  validationErrors: string[];
  usageResult?: BudgetUsageCheckResult;
} {
  let ceiling: BudgetCeiling | undefined;
  let usage: BudgetUsage | undefined;

  if (options) {
    if ("maxMinutes" in options || "maxParallel" in options) {
      ceiling = options as BudgetCeiling;
    } else {
      const opts = options as { ceiling?: BudgetCeiling; usage?: BudgetUsage };
      ceiling = opts.ceiling;
      usage = opts.usage;
    }
  }

  const valResult = validateBudget(budget, ceiling);
  if (!valResult.ok) {
    return {
      ok: false,
      valid: false,
      validationErrors: valResult.errors,
    };
  }

  if (usage) {
    const usageResult = checkBudgetUsage(valResult.normalizedBudget!, usage);
    return {
      ok: usageResult.ok,
      valid: true,
      validationErrors: [],
      usageResult,
    };
  }

  return {
    ok: true,
    valid: true,
    validationErrors: [],
  };
}

export const checkBudget = checkPactBudget;

export function formatBudgetTerms(
  budget: PactBudget,
  options?: { creditsReported?: boolean }
): BudgetTermsDisplay {
  const creditsReported = options?.creditsReported !== false && budget.maxCredits !== null;
  return {
    termsNote: BUDGET_CHECK_TERMS_NOTE,
    creditsNote: creditsReported ? undefined : BUDGET_CREDITS_UNREPORTED_NOTE,
    maxMinutesFormatted: `${budget.maxMinutes} min`,
    maxParallelFormatted: `${budget.maxParallel} parallel`,
    maxCreditsFormatted:
      budget.maxCredits !== undefined && budget.maxCredits !== null
        ? `${budget.maxCredits} credits`
        : "not reported",
    maxToolCallsFormatted:
      budget.maxToolCalls !== undefined ? `${budget.maxToolCalls} tool calls` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pure Function 2: Record the Approval (Requirements 13.4, 13.8)
// ---------------------------------------------------------------------------

export function recordApproval(
  first: readonly PactTask[] | PactTask[] | RecordApprovalOptions,
  second?: RecordApprovalOptions
): PactApprovalRecord {
  let tasks: readonly PactTask[] | undefined;
  let options: RecordApprovalOptions;

  if (Array.isArray(first)) {
    tasks = first;
    options = second!;
  } else {
    options = first as RecordApprovalOptions;
    if (options.originalTasks) {
      tasks = options.originalTasks;
    }
  }

  const errors: string[] = [];
  const now = options.now ?? Date.now();
  const actor = options.actor ?? "user";

  // Validate pactVersion (must be integer >= 1)
  const pactVersion = options.pactVersion;
  if (
    typeof pactVersion !== "number" ||
    !Number.isInteger(pactVersion) ||
    pactVersion < 1
  ) {
    errors.push("pactVersion must be a positive integer >= 1");
  }

  // Normalize approvedTaskIds
  const rawApproved = options.approvedTaskIds;
  const approvedList: string[] = [];
  if (rawApproved instanceof Set) {
    for (const id of rawApproved) {
      approvedList.push(String(id).trim());
    }
  } else if (Array.isArray(rawApproved)) {
    for (const id of rawApproved) {
      approvedList.push(String(id).trim());
    }
  } else {
    errors.push("approvedTaskIds must be an array or Set of task IDs");
  }

  const approvedSet = new Set<string>();
  for (const id of approvedList) {
    if (!/^T\d+$/.test(id)) {
      errors.push(`Approved task ID '${id}' does not match T<n>`);
    } else {
      approvedSet.add(id);
    }
  }

  // Validate tasks if available
  const allTaskIds: string[] = [];
  const disabledTaskIds: string[] = [];
  const flaggedTasks: FlaggedTaskDependency[] = [];

  if (tasks && tasks.length > 0) {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      allTaskIds.push(t.id);
      if (!approvedSet.has(t.id)) {
        disabledTaskIds.push(t.id);
        const nonRem = isNonRemovableTask(t);
        if (nonRem) {
          errors.push(
            `Cannot approve Pact without non-removable requirement '${nonRem}' in task ${t.id}`
          );
        }
      }
    }

    // Check that all approvedTaskIds exist in tasks
    for (const id of approvedSet) {
      if (!taskMap.has(id)) {
        errors.push(`Approved task ID '${id}' is not defined in the Pact`);
      }
    }

    // Flag approved tasks that depend on disabled tasks
    const disabledSet = new Set(disabledTaskIds);
    for (const id of approvedSet) {
      const task = taskMap.get(id);
      if (task) {
        const deps = task.dependencies ?? task.depends ?? [];
        for (const depId of deps) {
          if (disabledSet.has(depId)) {
            flaggedTasks.push({
              taskId: id,
              dependsOnDisabled: depId,
              message: `Task ${id} depends on ${depId}, which is off.`,
            });
          }
        }
      }
    }
  } else {
    allTaskIds.push(...approvedSet);
  }

  // Validate budget
  const budgetVal = validateBudget(options.budget, options.ceiling);
  if (!budgetVal.ok) {
    errors.push(...budgetVal.errors);
  }

  const finalBudget = budgetVal.normalizedBudget ?? options.budget;
  const approvedTaskIdsArray = Array.from(approvedSet);

  const event: PactApprovedEvent = {
    kind: "pact.approved",
    runId: options.runId,
    actor,
    ts: now,
    data: {
      pactVersion,
      approvedTaskIds: approvedTaskIdsArray,
      budget: finalBudget,
    },
  };

  return {
    ok: errors.length === 0,
    pactVersion,
    approvedTaskIds: approvedTaskIdsArray,
    disabledTaskIds,
    allTaskIds,
    budget: finalBudget,
    approvedAt: now,
    approvedBy: actor,
    flaggedTasks,
    errors,
    event,
  };
}

export const recordPactApproval = recordApproval;

export function isPactApproved(record: unknown): boolean {
  if (!record || typeof record !== "object") {
    return false;
  }
  const r = record as Partial<PactApprovalRecord>;
  return (
    r.ok === true &&
    typeof r.pactVersion === "number" &&
    r.pactVersion >= 1 &&
    Array.isArray(r.approvedTaskIds) &&
    r.approvedTaskIds.length > 0 &&
    r.event?.kind === "pact.approved"
  );
}
