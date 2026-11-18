// Task 12.1: Pact parser and grammar validation
// Requirements: 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11

import { CLOUD_METADATA_IPS } from "../backend/connect-proxy";
import type { RuleId } from "../grimoire/types";

export type { RuleId };

export type PactRole = "bonesetter" | "soul-stitcher";

export const ALLOWED_ROLES: readonly PactRole[] = [
  "bonesetter",
  "soul-stitcher",
] as const;

export const ALLOWED_RULES: readonly RuleId[] = [
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
] as const;

export const PactErrorCodes = {
  INVALID_TASK_ID: "INVALID_TASK_ID",
  DUPLICATE_TASK_ID: "DUPLICATE_TASK_ID",
  INVALID_ROLE: "INVALID_ROLE",
  MISSING_DEPENDENCY: "MISSING_DEPENDENCY",
  DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
  EMPTY_FILES: "EMPTY_FILES",
  PATH_OUTSIDE_REPO: "PATH_OUTSIDE_REPO",
  BLOCKED_COMMAND: "BLOCKED_COMMAND",
  EMPTY_ACCEPT_COMMAND: "EMPTY_ACCEPT_COMMAND",
  INVALID_HARD_FLAG: "INVALID_HARD_FLAG",
  INVALID_RULE: "INVALID_RULE",
  MISSING_METADATA: "MISSING_METADATA",
  DUPLICATE_METADATA: "DUPLICATE_METADATA",
  UNKNOWN_METADATA: "UNKNOWN_METADATA",
  INVALID_SYNTAX: "INVALID_SYNTAX",
  EMPTY_PACT: "EMPTY_PACT",
} as const;

export type PactErrorCode =
  (typeof PactErrorCodes)[keyof typeof PactErrorCodes];

export interface PactParseError {
  code: PactErrorCode | string;
  line: number;
  message: string;
  task?: string;
  details?: Record<string, unknown> | string;
}

export interface PactTask {
  id: string;
  title: string;
  role: PactRole;
  dependencies: string[];
  depends: string[];
  dependsOn: string[];
  files: string[];
  filesInScope: string[];
  acceptanceCommand: string;
  accept: string;
  hard: boolean;
  hardFlag: boolean;
  hardRaw: "yes" | "no";
  ruleIds: RuleId[];
  rules: RuleId[];
  line: number;
}

export interface PactParseSuccess {
  ok: true;
  tasks: PactTask[];
  errors: [];
}

export interface PactParseFailure {
  ok: false;
  tasks: PactTask[];
  errors: PactParseError[];
}

export type PactParseResult = PactParseSuccess | PactParseFailure;

export interface CommandPolicyDecision {
  blocked: boolean;
  reason?: string;
}

export interface PactParserOptions {
  commandPolicy?: (
    command: string,
    argv: string[]
  ) => "allowed" | "needs_approval" | "blocked" | boolean;
  isCommandBlocked?: (command: string) => boolean;
}

const REQUIRED_METADATA_KEYS = [
  "role",
  "depends",
  "files",
  "accept",
  "hard",
  "rules",
] as const;

type MetadataKey = (typeof REQUIRED_METADATA_KEYS)[number];

const METADATA_KEY_SET = new Set<string>(REQUIRED_METADATA_KEYS);
const ALLOWED_ROLE_SET = new Set<string>(ALLOWED_ROLES);
const ALLOWED_RULE_SET = new Set<string>(ALLOWED_RULES);

// Link-local cloud metadata octets
const METADATA_OCTET_PREFIX = [169, 254].join(".");

/**
 * Split command line into argv tokens respecting quotes.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Classifies whether an acceptance command is blocked under Command_Policy.
 * Requirements: 12.9, 20.4, 29.11, 29.12.
 */
export function isCommandBlocked(
  command: string,
  options?: PactParserOptions
): CommandPolicyDecision {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { blocked: true, reason: "Acceptance command is empty" };
  }

  const argv = tokenizeCommand(trimmed);

  // Custom policy option
  if (options?.isCommandBlocked && options.isCommandBlocked(trimmed)) {
    return { blocked: true, reason: "Blocked by custom CommandPolicy" };
  }
  if (options?.commandPolicy) {
    const policyResult = options.commandPolicy(trimmed, argv);
    if (policyResult === "blocked" || policyResult === true) {
      return { blocked: true, reason: "Blocked by custom CommandPolicy" };
    }
  }

  // 1. Sudo commands
  if (
    argv.some((arg) => arg === "sudo") ||
    /(?:^|\s|\/|;)sudo(?:\s|$)/.test(trimmed)
  ) {
    return { blocked: true, reason: "sudo commands are blocked" };
  }

  // 2. Cloud metadata access (Requirement 29.11)
  if (
    trimmed.includes(METADATA_OCTET_PREFIX) ||
    CLOUD_METADATA_IPS.some((ip) => trimmed.includes(ip)) ||
    /metadata\.google|fd00:ec2::254/i.test(trimmed)
  ) {
    return { blocked: true, reason: "Cloud metadata access is blocked" };
  }

  // 3. Container sockets (Requirement 29.12)
  if (/(?:docker|containerd|podman)\.sock/i.test(trimmed)) {
    return { blocked: true, reason: "Container sockets are blocked" };
  }

  // 4. Host mounts and system mount directories (Requirement 29.12)
  if (
    argv.some(
      (arg) => arg === "--mount" || arg === "--volume" || arg === "-v"
    ) ||
    /(?:--mount\b|--volume\b|-v\s+\/|\/(?:proc|sys)\b)/.test(trimmed)
  ) {
    return {
      blocked: true,
      reason: "Host mounts and system directories are blocked",
    };
  }

  // 5. SSH keys and credentials directory (Requirement 29.11)
  if (
    /(?:^|[\\/])\.ssh(?:\b|[\\/])|id_(?:rsa|ed25519|ecdsa|dsa)/i.test(
      trimmed
    )
  ) {
    return { blocked: true, reason: "SSH keys and ~/.ssh are blocked" };
  }

  // 6. Environment dumps (Requirement 29.11)
  if (
    /^(?:\/usr\/bin\/)?(?:printenv|env)(?:\s+-[a-zA-Z0-9]+)*\s*$/i.test(
      trimmed
    ) ||
    /^(?:export|set)\s*$/i.test(trimmed)
  ) {
    return { blocked: true, reason: "Environment dumps are blocked" };
  }

  // 7. Secrets and tokens (Requirement 29.11)
  if (/(?:KIRO_API_KEY|GITHUB_TOKEN|GH_TOKEN)\b/.test(trimmed)) {
    return {
      blocked: true,
      reason: "Access to Kiro API key or GitHub token is blocked",
    };
  }

  return { blocked: false };
}

/**
 * Validates whether a file path leaves the repository bounds.
 * Requirements: 12.8.
 */
export function isPathOutsideRepo(filePath: string): boolean {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return false;
  }

  const p = filePath.trim().replace(/\\/g, "/");

  // Absolute paths
  if (p.startsWith("/")) {
    return true;
  }

  // Windows drive letters
  if (/^[a-zA-Z]:/.test(p)) {
    return true;
  }

  // Home directory references
  if (p.startsWith("~")) {
    return true;
  }

  // Normalization check for directory traversal
  const parts = p.split("/");
  let depth = 0;
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      depth--;
      if (depth < 0) {
        return true;
      }
    } else {
      depth++;
    }
  }

  return false;
}

/**
 * Splits a comma-separated list into cleaned string tokens.
 */
function splitCommaSeparated(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  let inBacktick = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === "`" && !inDouble && !inSingle) {
      inBacktick = !inBacktick;
      current += ch;
    } else if (ch === "," && !inDouble && !inSingle && !inBacktick) {
      const clean = cleanToken(current);
      if (clean.length > 0) {
        result.push(clean);
      }
      current = "";
    } else {
      current += ch;
    }
  }

  const clean = cleanToken(current);
  if (clean.length > 0) {
    result.push(clean);
  }

  return result;
}

function cleanToken(token: string): string {
  let s = token.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

interface RawMetadataEntry {
  value: string;
  line: number;
}

interface RawTaskAccumulator {
  id: string;
  title: string;
  line: number;
  metadata: Partial<Record<MetadataKey, RawMetadataEntry>>;
  dependsLine?: number;
}

/**
 * Cycle detection across tasks dependencies using DFS.
 * Requirement: 12.7.
 */
function detectDependencyCycles(
  tasks: Array<{ id: string; dependencies: string[]; line: number; dependsLine?: number }>
): PactParseError[] {
  const errors: PactParseError[] = [];
  const taskMap = new Map<
    string,
    { id: string; dependencies: string[]; line: number; dependsLine?: number }
  >();

  for (const t of tasks) {
    taskMap.set(t.id, t);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const reportedCycles = new Set<string>();

  function dfs(taskId: string): void {
    visiting.add(taskId);
    path.push(taskId);

    const current = taskMap.get(taskId);
    if (current) {
      for (const depId of current.dependencies) {
        if (!taskMap.has(depId)) {
          continue; // Missing dependency reported separately
        }
        if (visiting.has(depId)) {
          const cycleStartIndex = path.indexOf(depId);
          const cycleMembers = path.slice(cycleStartIndex);
          cycleMembers.push(depId);
          const cycleStr = cycleMembers.join(" -> ");

          const canonical = [...cycleMembers].sort().join(",");
          if (!reportedCycles.has(canonical)) {
            reportedCycles.add(canonical);
            errors.push({
              code: PactErrorCodes.DEPENDENCY_CYCLE,
              line: current.dependsLine ?? current.line,
              task: taskId,
              message: `Task dependencies form a cycle: ${cycleStr}`,
              details: { cycle: cycleMembers, cycleString: cycleStr },
            });
          }
        } else if (!visited.has(depId)) {
          dfs(depId);
        }
      }
    }

    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      dfs(task.id);
    }
  }

  return errors;
}

/**
 * Pure parser for tasks.md into validated PactTask models.
 * Requirements: 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11.
 */
export function parsePact(
  input: string,
  options?: PactParserOptions
): PactParseResult {
  if (typeof input !== "string") {
    return {
      ok: false,
      tasks: [],
      errors: [
        {
          code: PactErrorCodes.INVALID_SYNTAX,
          line: 1,
          message: "Input to parsePact must be a string",
        },
      ],
    };
  }

  const lines = input.split(/\r?\n/);
  const errors: PactParseError[] = [];
  const accumulators: RawTaskAccumulator[] = [];
  const seenTaskIds = new Set<string>();

  let currentTask: RawTaskAccumulator | null = null;

  function finalizeCurrentTask(): void {
    if (!currentTask) {
      return;
    }

    // Verify all 6 required metadata bullets are present (Requirement 12.4)
    for (const reqKey of REQUIRED_METADATA_KEYS) {
      if (!currentTask.metadata[reqKey]) {
        errors.push({
          code: PactErrorCodes.MISSING_METADATA,
          line: currentTask.line,
          task: currentTask.id,
          message: `Task ${currentTask.id} is missing required metadata bullet: '${reqKey}'`,
        });
      }
    }

    accumulators.push(currentTask);
    currentTask = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines outside tasks
    if (trimmed.length === 0) {
      continue;
    }

    // Check if this line is a checkbox line: - [ ] or - [x]
    const checkboxMatch = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
    if (checkboxMatch) {
      finalizeCurrentTask();

      const afterCheckbox = checkboxMatch[2].trim();

      // Check task ID format T<n>. <title>
      let taskId = "";
      let taskTitle = "";

      const dotMatch = afterCheckbox.match(/^([^\s.]+)\.\s*(.*)$/);
      const spaceMatch = afterCheckbox.match(/^([^\s]+)\s+(.*)$/);

      if (dotMatch) {
        taskId = dotMatch[1].trim();
        taskTitle = dotMatch[2].trim();
      } else if (spaceMatch) {
        taskId = spaceMatch[1].trim();
        taskTitle = spaceMatch[2].trim();
      } else {
        taskId = afterCheckbox;
        taskTitle = "";
      }

      // Validate task ID matches T<n> (Requirement 12.5)
      const validIdFormat = /^T\d+$/.test(taskId);
      if (!validIdFormat) {
        errors.push({
          code: PactErrorCodes.INVALID_TASK_ID,
          line: lineNumber,
          task: taskId,
          message: `Task ID '${taskId}' does not match T<n>`,
        });
      }

      if (taskTitle.length === 0) {
        errors.push({
          code: PactErrorCodes.INVALID_SYNTAX,
          line: lineNumber,
          task: taskId,
          message: `Task ${taskId} is missing a title`,
        });
      }

      // Validate duplicate task ID (Requirement 12.5)
      if (validIdFormat && seenTaskIds.has(taskId)) {
        errors.push({
          code: PactErrorCodes.DUPLICATE_TASK_ID,
          line: lineNumber,
          task: taskId,
          message: `Task ID '${taskId}' repeats`,
        });
      } else if (validIdFormat) {
        seenTaskIds.add(taskId);
      }

      currentTask = {
        id: taskId,
        title: taskTitle,
        line: lineNumber,
        metadata: {},
      };
      continue;
    }

    // Check if this line is a metadata bullet under a task
    const bulletMatch = line.match(
      /^\s+[-*]\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/
    );
    if (bulletMatch && currentTask) {
      const rawKey = bulletMatch[1].toLowerCase();
      const rawValue = bulletMatch[2].trim();

      if (!METADATA_KEY_SET.has(rawKey)) {
        errors.push({
          code: PactErrorCodes.UNKNOWN_METADATA,
          line: lineNumber,
          task: currentTask.id,
          message: `Task ${currentTask.id} has unknown metadata bullet: '${bulletMatch[1]}'`,
        });
        continue;
      }

      const key = rawKey as MetadataKey;
      if (currentTask.metadata[key]) {
        errors.push({
          code: PactErrorCodes.DUPLICATE_METADATA,
          line: lineNumber,
          task: currentTask.id,
          message: `Task ${currentTask.id} has duplicate metadata bullet: '${key}'`,
        });
      } else {
        currentTask.metadata[key] = {
          value: rawValue,
          line: lineNumber,
        };
        if (key === "depends") {
          currentTask.dependsLine = lineNumber;
        }
      }
      continue;
    }

    // If inside a task, unexpected non-empty non-bullet lines are syntax errors
    if (currentTask) {
      // Top-level headers or dividers end the current task
      if (/^#{1,6}\s+/.test(trimmed) || /^---+\s*$/.test(trimmed)) {
        finalizeCurrentTask();
        continue;
      }

      errors.push({
        code: PactErrorCodes.INVALID_SYNTAX,
        line: lineNumber,
        task: currentTask.id,
        message: `Unexpected line inside task ${currentTask.id}: '${trimmed}'`,
      });
      continue;
    }

    // Top-level non-task lines (headers, comments, introductory text) are allowed outside tasks
  }

  // Finalize last task if file ends
  finalizeCurrentTask();

  // Validate tasks and execution constraints
  const validatedTasks: PactTask[] = [];

  for (const acc of accumulators) {
    const taskId = acc.id;
    let roleValid = true;
    let hardValid = true;

    // 1. Validate role (Requirement 12.6)
    let role: PactRole = "bonesetter";
    const roleEntry = acc.metadata.role;
    if (roleEntry) {
      const cleanRole = cleanToken(roleEntry.value).toLowerCase();
      if (ALLOWED_ROLE_SET.has(cleanRole)) {
        role = cleanRole as PactRole;
      } else {
        roleValid = false;
        errors.push({
          code: PactErrorCodes.INVALID_ROLE,
          line: roleEntry.line,
          task: taskId,
          message: `Task ${taskId} has invalid role: '${roleEntry.value}'. Role must be 'bonesetter' or 'soul-stitcher'.`,
        });
      }
    }

    // 2. Validate files (Requirement 12.8)
    const filesList: string[] = [];
    const filesEntry = acc.metadata.files;
    if (filesEntry) {
      const parsedFiles = splitCommaSeparated(filesEntry.value);
      if (parsedFiles.length === 0) {
        errors.push({
          code: PactErrorCodes.EMPTY_FILES,
          line: filesEntry.line,
          task: taskId,
          message: `Task ${taskId} has empty files list`,
        });
      } else {
        for (const filePath of parsedFiles) {
          filesList.push(filePath);
          if (isPathOutsideRepo(filePath)) {
            errors.push({
              code: PactErrorCodes.PATH_OUTSIDE_REPO,
              line: filesEntry.line,
              task: taskId,
              message: `Task ${taskId} names a path outside the repository: '${filePath}'`,
              details: { path: filePath },
            });
          }
        }
      }
    }

    // 3. Validate accept command under Command_Policy (Requirement 12.9)
    let acceptanceCommand = "";
    const acceptEntry = acc.metadata.accept;
    if (acceptEntry) {
      acceptanceCommand = cleanToken(acceptEntry.value);
      if (acceptanceCommand.length === 0) {
        errors.push({
          code: PactErrorCodes.EMPTY_ACCEPT_COMMAND,
          line: acceptEntry.line,
          task: taskId,
          message: `Task ${taskId} acceptance command is empty`,
        });
      } else {
        const check = isCommandBlocked(acceptanceCommand, options);
        if (check.blocked) {
          errors.push({
            code: PactErrorCodes.BLOCKED_COMMAND,
            line: acceptEntry.line,
            task: taskId,
            message: `Task ${taskId} accept command classifies as blocked under CommandPolicy: '${acceptanceCommand}'. ${check.reason ?? ""}`.trim(),
            details: { command: acceptanceCommand, reason: check.reason },
          });
        }
      }
    }

    // 4. Validate hard flag (Requirement 12.10)
    let hard = false;
    let hardRaw: "yes" | "no" = "no";
    const hardEntry = acc.metadata.hard;
    if (hardEntry) {
      const cleanHard = cleanToken(hardEntry.value).toLowerCase();
      if (cleanHard === "yes") {
        hard = true;
        hardRaw = "yes";
      } else if (cleanHard === "no") {
        hard = false;
        hardRaw = "no";
      } else {
        hardValid = false;
        errors.push({
          code: PactErrorCodes.INVALID_HARD_FLAG,
          line: hardEntry.line,
          task: taskId,
          message: `Task ${taskId} has invalid hard value: '${hardEntry.value}'. Value must be 'yes' or 'no'.`,
        });
      }
    }

    // 5. Validate rules (Requirement 12.11)
    const ruleIds: RuleId[] = [];
    const rulesEntry = acc.metadata.rules;
    if (rulesEntry) {
      const parsedRules = splitCommaSeparated(rulesEntry.value);
      for (const rule of parsedRules) {
        if (ALLOWED_RULE_SET.has(rule)) {
          ruleIds.push(rule as RuleId);
        } else {
          errors.push({
            code: PactErrorCodes.INVALID_RULE,
            line: rulesEntry.line,
            task: taskId,
            message: `Task ${taskId} cites invalid rule: '${rule}'. Rules must cite only M1 through M6.`,
            details: { rule },
          });
        }
      }
    }

    // Parse depends
    const dependencies: string[] = [];
    const dependsEntry = acc.metadata.depends;
    if (dependsEntry) {
      const parsedDepends = splitCommaSeparated(dependsEntry.value);
      dependencies.push(...parsedDepends);
    }

    validatedTasks.push({
      id: taskId,
      title: acc.title,
      role: roleValid ? role : ("bonesetter" as PactRole),
      dependencies,
      depends: dependencies,
      dependsOn: dependencies,
      files: filesList,
      filesInScope: filesList,
      acceptanceCommand,
      accept: acceptanceCommand,
      hard: hardValid ? hard : false,
      hardFlag: hardValid ? hard : false,
      hardRaw,
      ruleIds,
      rules: ruleIds,
      line: acc.line,
    });
  }

  // Cross-task dependency validation (Requirement 12.7)
  const definedTaskIds = new Set(accumulators.map((t) => t.id));

  // 1. Missing dependency check
  for (const acc of accumulators) {
    const dependsEntry = acc.metadata.depends;
    if (dependsEntry) {
      const parsedDepends = splitCommaSeparated(dependsEntry.value);
      for (const depId of parsedDepends) {
        if (!definedTaskIds.has(depId)) {
          errors.push({
            code: PactErrorCodes.MISSING_DEPENDENCY,
            line: dependsEntry.line,
            task: acc.id,
            message: `Task ${acc.id} depends on missing task ID: '${depId}'`,
            details: { missingId: depId },
          });
        }
      }
    }
  }

  // 2. Dependency cycle check (Requirement 12.7)
  const cycleErrors = detectDependencyCycles(
    accumulators.map((acc) => ({
      id: acc.id,
      dependencies: acc.metadata.depends
        ? splitCommaSeparated(acc.metadata.depends.value)
        : [],
      line: acc.line,
      dependsLine: acc.dependsLine,
    }))
  );
  errors.push(...cycleErrors);

  // Empty Pact check
  if (accumulators.length === 0 && errors.length === 0) {
    errors.push({
      code: PactErrorCodes.EMPTY_PACT,
      line: 1,
      message: "No tasks found in tasks.md",
    });
  }

  // Sort errors by line number deterministically
  errors.sort((a, b) => a.line - b.line);

  if (errors.length > 0) {
    return {
      ok: false,
      tasks: validatedTasks,
      errors,
    };
  }

  return {
    ok: true,
    tasks: validatedTasks,
    errors: [],
  };
}

/**
 * Convenience aliases matching tasks.md terminology.
 */
export const parseTasks = parsePact;
export const parseTasksMd = parsePact;

/**
 * Parses a Pact string, throwing an Error with all parse errors if invalid.
 */
export function parsePactOrThrow(
  input: string,
  options?: PactParserOptions
): PactTask[] {
  const result = parsePact(input, options);
  if (!result.ok) {
    const msgs = result.errors
      .map((e) => `[line ${e.line}] ${e.code}: ${e.message}`)
      .join("\n");
    throw new Error(`Pact parsing failed with ${result.errors.length} error(s):\n${msgs}`);
  }
  return result.tasks;
}

export default parsePact;
