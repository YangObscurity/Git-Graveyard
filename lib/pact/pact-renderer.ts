// Task 12.2: Pact renderer with round-trip idempotence
// Requirements: 12.12, 12.13

import type {
  PactTask,
  PactRole,
  RuleId,
  PactParseResult,
} from "./pact-parser";

export type { PactTask, PactRole, RuleId };

export type PactInput =
  | readonly PactTask[]
  | { readonly tasks: readonly PactTask[] }
  | PactParseResult
  | null
  | undefined;

/**
 * Normalizes input items into an array of trimmed, non-empty strings.
 * Handles arrays, comma-separated strings, or single string values.
 */
function normalizeStringList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (input !== null && input !== undefined) {
    const s = String(input).trim();
    return s.length > 0 ? [s] : [];
  }
  return [];
}

/**
 * Formats a task ID into standard T<n> format.
 */
function formatTaskId(id: unknown): string {
  if (typeof id === "number") {
    return `T${id}`;
  }
  if (typeof id === "string") {
    const trimmed = id.trim();
    if (/^T\d+$/i.test(trimmed)) {
      return `T${trimmed.slice(1)}`;
    }
    if (/^\d+$/.test(trimmed)) {
      return `T${trimmed}`;
    }
    if (trimmed.length > 0) {
      return trimmed.startsWith("T") ? trimmed : `T${trimmed}`;
    }
  }
  return "T0";
}

/**
 * Renders a single PactTask into standard tasks.md Markdown format.
 * Format:
 * - [ ] T<n>. <title>
 *   - role: <role>
 *   - depends: <comma-separated or empty>
 *   - files: <comma-separated>
 *   - accept: <command>
 *   - hard: yes|no
 *   - rules: <comma-separated or empty>
 */
export function renderTask(
  task: Partial<PactTask> | Record<string, unknown>
): string {
  const t = task as Record<string, unknown>;
  const id = formatTaskId(t.id);
  const title = (typeof t.title === "string" ? t.title : "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  const header = title.length > 0 ? `- [ ] ${id}. ${title}` : `- [ ] ${id}.`;

  const roleRaw =
    typeof t.role === "string" ? t.role.trim().toLowerCase() : "";
  const role = roleRaw === "soul-stitcher" ? "soul-stitcher" : "bonesetter";
  const roleLine = `  - role: ${role}`;

  const rawDepends =
    t.depends ?? t.dependencies ?? t.dependsOn;
  const depsList = normalizeStringList(rawDepends);
  const dependsLine =
    depsList.length > 0 ? `  - depends: ${depsList.join(", ")}` : "  - depends:";

  const rawFiles = t.files ?? t.filesInScope;
  const filesList = normalizeStringList(rawFiles);
  const filesLine =
    filesList.length > 0 ? `  - files: ${filesList.join(", ")}` : "  - files:";

  const acceptCmd = (
    typeof t.accept === "string"
      ? t.accept
      : typeof t.acceptanceCommand === "string"
        ? t.acceptanceCommand
        : ""
  ).trim();
  const acceptLine =
    acceptCmd.length > 0 ? `  - accept: ${acceptCmd}` : "  - accept:";

  let hardStr = "no";
  if (t.hardRaw === "yes" || t.hardRaw === "no") {
    hardStr = t.hardRaw as string;
  } else if (t.hard === true || t.hardFlag === true) {
    hardStr = "yes";
  } else if (t.hard === false || t.hardFlag === false) {
    hardStr = "no";
  } else if (typeof t.hard === "string") {
    const lower = (t.hard as string).trim().toLowerCase();
    if (lower === "yes" || lower === "no") {
      hardStr = lower;
    }
  }
  const hardLine = `  - hard: ${hardStr}`;

  const rawRules = t.rules ?? t.ruleIds;
  const rulesList = normalizeStringList(rawRules);
  const rulesLine =
    rulesList.length > 0 ? `  - rules: ${rulesList.join(", ")}` : "  - rules:";

  return [
    header,
    roleLine,
    dependsLine,
    filesLine,
    acceptLine,
    hardLine,
    rulesLine,
  ].join("\n");
}

/**
 * Extracts tasks list from various input formats.
 */
function extractTasks(input: PactInput): PactTask[] {
  if (!input) {
    return [];
  }
  if (Array.isArray(input)) {
    return input as PactTask[];
  }
  if (typeof input === "object" && input !== null) {
    const candidate = input as { tasks?: unknown };
    if (Array.isArray(candidate.tasks)) {
      return candidate.tasks as PactTask[];
    }
  }
  return [];
}

/**
 * Pure function rendering a parsed Pact data model back into tasks.md text.
 * Requirements: 12.12, 12.13.
 */
export function renderPact(pact: PactInput): string {
  const tasks = extractTasks(pact);
  if (tasks.length === 0) {
    return "";
  }
  return tasks.map((t) => renderTask(t)).join("\n\n") + "\n";
}

/**
 * Convenience aliases matching tasks.md terminology.
 */
export const renderTasks = renderPact;
export const renderTasksMd = renderPact;

export default renderPact;
