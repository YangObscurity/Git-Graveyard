// lib/grimoire/bundle.ts
// Requirement 10.1 - 10.11; design R3-10 (spec-driven bundle) and R4-22 P9.
//
// The Grimoire_Bundle is a pure, template-only, deterministic serializer. It
// reads only plain data (signals, patch steps, unknowns, labels) and returns
// the three markdown files. It never calls a model, the GitHub API, the clock
// or the network: two calls with equal input produce byte-identical output.
import { engineVersion as GENERATED_ENGINE_VERSION } from "../engine/engine-version";
import type { Signal, UnknownRecord } from "./types";
import type { PatchStep } from "./gate-js";

export const BUNDLE_RULE_IDS = ["M1", "M2", "M3", "M4", "M5", "M6"] as const;
export type BundleRuleId = (typeof BUNDLE_RULE_IDS)[number];

/** Task statuses from the requirements glossary (Requirement 10.7). */
export const BUNDLE_TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "in_review",
  "rejected",
  "merged",
  "failed",
  "abandoned",
  "skipped",
  "blocked",
] as const;

export type BundleTaskStatus = (typeof BUNDLE_TASK_STATUSES)[number];

/** Fixed mapping-row template per rule; every row cites M1 to M6 (Requirement 6.2). */
export const BUNDLE_MAPPING_TEMPLATE: Record<
  BundleRuleId,
  { finding: string; target: string }
> = {
  M1: {
    finding: "Python 2 syntax and Py2 residue",
    target:
      "`print(...)`, `except E as e`, `str(...)`, `.items()`/`.keys()`/`.values()`; unhandled residue stays `unknown`",
  },
  M2: {
    finding: "callback `request` package",
    target:
      "native `fetch` through `request-compat.cjs`; `engines.node` raised to `>=22`",
  },
  M3: {
    finding: "CommonJS `require(` / `module.exports`",
    target: "ESM `import` / `export` for application packages only",
  },
  M4: {
    finding: "webpack 2 configuration",
    target: "current stable Vite; the `CommonsChunkPlugin` mapping is `unknown`",
  },
  M5: {
    finding: "dependency drift of two or more majors",
    target: "report only; one manual task per manifest directory",
  },
  M6: {
    finding: "missing lock file",
    target:
      "`npm install --package-lock-only --ignore-scripts` or `poetry lock` in the manifest directory",
  },
};

/** Deterministic per-rule task and step description templates. */
export const BUNDLE_RULE_DESCRIPTION: Record<BundleRuleId, string> = {
  M1: "rewrite Python 2 syntax to Python 3",
  M2: "route `request(opts, cb)` calls through `request-compat.cjs`",
  M3: "convert CommonJS to ESM",
  M4: "replace the webpack 2 configuration with the current stable Vite",
  M5: "review drifted dependencies",
  M6: "generate the missing lock file",
};

export const DEFAULT_NPM_LOCK_COMMAND =
  "npm install --package-lock-only --ignore-scripts";
export const POETRY_LOCK_COMMAND = "poetry lock";
export const M6_PRESET_OUTCOME = "baked by bake:presets";

export interface BundlePatchStepInput {
  ruleId?: string;
  file?: string;
  reverted?: boolean;
  revertReason?: string;
  compat?: boolean;
  behavior?: string;
  notes?: string;
  description?: string;
  diff?: string;
  hunks?: number;
  acceptedEdits?: number;
  acceptedEditsCount?: number;
  [key: string]: unknown;
}

export interface BundleManualTaskInput {
  ruleId: string;
  target: string;
  description: string;
  checked?: boolean;
  outcome?: string;
}

export interface BundleNormalizedStep {
  key: string;
  ruleId: BundleRuleId;
  file: string;
  reverted: boolean;
  revertReason?: string;
  compat: boolean;
  behavior: string;
  notes: string;
  description: string;
}

export interface BundlePatchTaskRecord {
  index: number;
  ruleId: BundleRuleId;
  file: string;
  checked: boolean;
  description: string;
  outcome?: string;
}

export interface BundleManualTaskRecord {
  index: number;
  ruleId: BundleRuleId;
  target: string;
  checked: boolean;
  description: string;
  outcome?: string;
}

export interface BundleMappingRow {
  ruleId: BundleRuleId;
  fired: boolean;
  finding: string;
  target: string;
  files: string[];
}

export interface BundleDriftedDependency {
  name: string;
  declared?: string;
  declaredVersion?: string;
  latest?: string;
  latestVersion?: string;
  manifestDir?: string;
}

export interface BundleTargetRuntime {
  kind: "node" | "python" | "unspecified";
  value: string;
}

export interface BundleInput {
  owner: string;
  repo: string;
  sha?: string;
  /** Pinned fixture date; the only date allowed inside the bundle (Requirement 10.10). */
  asOf?: string;
  engineVersion?: string;
  targetRuntime?: BundleTargetRuntime | null;
  m2Fired?: boolean;
  removedDependencies?: readonly string[];
  driftedDependencies?: readonly BundleDriftedDependency[];
  signals?: readonly Signal[];
  steps?: readonly (BundlePatchStepInput | PatchStep)[];
  manualTasks?: readonly BundleManualTaskInput[];
  unknowns?: readonly UnknownRecord[];
  pythonFileLabels?: Readonly<Record<string, "m1-clean" | "m1-partial">>;
  /** Deterministic M6 lock command per manifest directory. */
  lockCommands?: Readonly<Record<string, string>>;
  taskStatusCounts?: Readonly<Partial<Record<BundleTaskStatus, number>>>;
  /** Preset bundles tick their M6 manual task (Requirement 10.11, R3-8.4). */
  preset?: boolean;
}

export interface GrimoireBundle {
  requirements: string;
  design: string;
  tasks: string;
  engineVersion: string;
  patchSteps: BundleNormalizedStep[];
  patchTasks: BundlePatchTaskRecord[];
  manualTasks: BundleManualTaskRecord[];
  mappingRows: BundleMappingRow[];
}

export function isBundleRuleId(value: unknown): value is BundleRuleId {
  return (
    typeof value === "string" && (BUNDLE_RULE_IDS as readonly string[]).includes(value)
  );
}

export function resolveEngineVersion(override?: string): string {
  return override && override.length > 0 ? override : GENERATED_ENGINE_VERSION;
}

export function patchStepKey(ruleId: string, file: string): string {
  return `${ruleId}:${file}`;
}

export function normalizeBundlePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * A step is a patch step when it changed its file, or when it was reverted and
 * therefore still needs an Outcome line. Steps with no edit and no revert are
 * dropped so that `tasks.md` and the plan stay a 1:1 bijection
 * (Requirements 10.4, 10.5).
 */
export function isPatchWorthyStep(step: BundlePatchStepInput): boolean {
  if (step.reverted === true) return true;
  if (typeof step.diff === "string" && step.diff.trim().length > 0) return true;
  if (typeof step.hunks === "number" && step.hunks > 0) return true;
  const accepted = step.acceptedEdits ?? step.acceptedEditsCount;
  return typeof accepted === "number" && accepted > 0;
}

/** Deterministic `(ruleId, file)` patch plan: deduped, sorted, M1 to M6 order. */
export function normalizePatchSteps(
  steps?: readonly (BundlePatchStepInput | PatchStep)[]
): BundleNormalizedStep[] {
  const seen = new Set<string>();
  const normalized: BundleNormalizedStep[] = [];
  for (const raw of steps ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as BundlePatchStepInput;
    const ruleId = typeof step.ruleId === "string" ? step.ruleId.toUpperCase() : "";
    const file = typeof step.file === "string" ? normalizeBundlePath(step.file) : "";
    if (!isBundleRuleId(ruleId) || file.length === 0) continue;
    if (!isPatchWorthyStep(step)) continue;
    const key = patchStepKey(ruleId, file);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      key,
      ruleId,
      file,
      reverted: step.reverted === true,
      revertReason:
        step.reverted === true ? step.revertReason ?? "all_edits_rejected" : undefined,
      compat: step.compat === true,
      behavior: typeof step.behavior === "string" ? step.behavior : "preserved",
      notes: typeof step.notes === "string" ? step.notes : "",
      description:
        typeof step.description === "string" && step.description.length > 0
          ? step.description
          : BUNDLE_RULE_DESCRIPTION[ruleId],
    });
  }
  normalized.sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  return normalized;
}

/** One manual task per drifted-run manifest directory and per M6 manifest directory. */
export function deriveManualTasks(input: BundleInput): BundleManualTaskInput[] {
  const preset = input.preset !== false;
  const tasks: BundleManualTaskInput[] = [];

  const driftByDir = new Map<string, BundleDriftedDependency[]>();
  for (const dep of input.driftedDependencies ?? []) {
    const dir = normalizeBundlePath(dep.manifestDir ?? ".") || ".";
    const list = driftByDir.get(dir) ?? [];
    list.push(dep);
    driftByDir.set(dir, list);
  }
  for (const dir of Array.from(driftByDir.keys()).sort()) {
    const deps = driftByDir
      .get(dir)!
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rendered = deps.map((dep) => {
      const declared = dep.declaredVersion ?? dep.declared ?? "unknown";
      const latest = dep.latestVersion ?? dep.latest ?? "unknown";
      return `\`${dep.name}\` (\`${declared}\` -> \`${latest}\`)`;
    });
    tasks.push({
      ruleId: "M5",
      target: dir,
      description: `review drifted ${deps.length === 1 ? "dependency" : "dependencies"} ${rendered.join(", ")}`,
    });
  }

  const m6Dirs = new Set<string>();
  for (const signal of input.signals ?? []) {
    if (signal.ruleId === "M6") {
      m6Dirs.add(normalizeBundlePath(signal.manifestDir ?? ".") || ".");
    }
  }
  for (const dir of Array.from(m6Dirs).sort()) {
    const command = input.lockCommands?.[dir] ?? DEFAULT_NPM_LOCK_COMMAND;
    tasks.push({
      ruleId: "M6",
      target: dir,
      description: `run \`${command}\``,
      checked: preset,
      outcome: preset ? M6_PRESET_OUTCOME : undefined,
    });
  }

  return tasks;
}

/** Merges explicit and derived manual tasks, deduped by `(ruleId, target)`. */
export function collectManualTasks(input: BundleInput): BundleManualTaskInput[] {
  const merged = new Map<string, BundleManualTaskInput>();
  for (const task of deriveManualTasks(input)) {
    merged.set(patchStepKey(task.ruleId, task.target), task);
  }
  for (const task of input.manualTasks ?? []) {
    const ruleId = String(task.ruleId).toUpperCase();
    if (!isBundleRuleId(ruleId)) continue;
    merged.set(patchStepKey(ruleId, task.target), { ...task, ruleId });
  }
  return Array.from(merged.values()).sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    if (a.target !== b.target) return a.target < b.target ? -1 : 1;
    return a.description < b.description ? -1 : a.description > b.description ? 1 : 0;
  });
}

/** Mapping rows that will fire; every row cites M1 to M6 (Requirement 6.2). */
export function buildMappingRows(
  input: BundleInput,
  steps: readonly BundleNormalizedStep[]
): BundleMappingRow[] {
  const fireByRule: Record<BundleRuleId, boolean> = {
    M1: false,
    M2: false,
    M3: false,
    M4: false,
    M5: false,
    M6: false,
  };
  const filesByRule: Record<BundleRuleId, Set<string>> = {
    M1: new Set(),
    M2: new Set(),
    M3: new Set(),
    M4: new Set(),
    M5: new Set(),
    M6: new Set(),
  };

  for (const signal of input.signals ?? []) {
    if (isBundleRuleId(signal.ruleId)) {
      fireByRule[signal.ruleId] = true;
      filesByRule[signal.ruleId].add(normalizeBundlePath(signal.file));
    }
  }
  for (const step of steps) {
    fireByRule[step.ruleId] = true;
    filesByRule[step.ruleId].add(step.file);
  }
  for (const unknown of input.unknowns ?? []) {
    if (isBundleRuleId(unknown.ruleId)) {
      fireByRule[unknown.ruleId] = true;
      if (typeof unknown.file === "string" && unknown.file.length > 0) {
        filesByRule[unknown.ruleId].add(normalizeBundlePath(unknown.file));
      }
    }
  }
  if (input.m2Fired) fireByRule.M2 = true;
  if ((input.removedDependencies ?? []).length > 0) fireByRule.M2 = true;
  if ((input.driftedDependencies ?? []).length > 0) fireByRule.M5 = true;
  if (Object.keys(input.pythonFileLabels ?? {}).length > 0) fireByRule.M1 = true;

  return BUNDLE_RULE_IDS.map((ruleId) => {
    const files = Array.from(filesByRule[ruleId]).filter((f) => f.length > 0);
    files.sort();
    return {
      ruleId,
      fired: fireByRule[ruleId],
      finding: BUNDLE_MAPPING_TEMPLATE[ruleId].finding,
      target: BUNDLE_MAPPING_TEMPLATE[ruleId].target,
      files,
    };
  });
}

function bullet(rule: string, text: string): string {
  return `- ${rule}: ${text}`;
}

function hasRuleFired(rows: readonly BundleMappingRow[], ruleId: BundleRuleId): boolean {
  return rows.some((row) => row.ruleId === ruleId && row.fired);
}

/** `requirements.md`: target runtime, dependency changes and checks (R3-10, Requirement 10.1). */
export function renderRequirements(
  input: BundleInput,
  rows: readonly BundleMappingRow[]
): string {
  const version = resolveEngineVersion(input.engineVersion);
  const out: string[] = [];
  out.push(`# Requirements: ${input.owner}/${input.repo}`);
  out.push("");
  out.push(
    `Generated by the Grimoire engine \`${version}\` from templates only (Requirements 10.1, 10.2). ` +
      `The bundle excludes GitHub metadata, Last Words, model text and timings (Requirement 10.10).`
  );
  if (input.asOf) {
    out.push("");
    out.push(
      `The pinned date for this preset is \`${input.asOf}\` (Requirements 4.11, 10.8).`
    );
  }

  // --- Target runtime -------------------------------------------------------
  out.push("");
  out.push("## Target runtime");
  out.push("");
  const runtimeLines: string[] = [];
  const runtime = input.targetRuntime;
  if (runtime && runtime.kind === "python" && runtime.value) {
    runtimeLines.push(
      bullet(
        "M1",
        `WHEN the repository is resurrected, the target Python runtime SHALL be \`${runtime.value}\` (rule M1, Requirement 6.19).`
      )
    );
  }
  if (input.m2Fired) {
    runtimeLines.push(
      bullet(
        "M2",
        "WHEN the repository is resurrected, the target Node runtime SHALL be `>=22` (rule M2, Requirement 7.9)."
      )
    );
  } else if (runtime && runtime.kind === "node" && runtime.value) {
    runtimeLines.push(
      bullet(
        "M2",
        `WHEN the repository is resurrected, the target Node runtime SHALL be \`${runtime.value}\` (rule M2, Requirement 7.9).`
      )
    );
  }
  if (runtimeLines.length === 0) {
    runtimeLines.push(
      bullet(
        "unknown",
        "THE target runtime could not be determined from `engines.node` or `requires-python` (rule unknown, Requirement 10.2)."
      )
    );
  }
  out.push(...runtimeLines);

  // --- Dependency changes ---------------------------------------------------
  out.push("");
  out.push("## Dependency changes");
  out.push("");
  const dependencyLines: string[] = [];
  const removed = Array.from(new Set(input.removedDependencies ?? [])).sort();
  for (const name of removed) {
    dependencyLines.push(
      bullet(
        "M2",
        `the dependency \`${name}\` SHALL be removed from the manifest directory when no file still imports it (rule M2, Requirement 7.7).`
      )
    );
  }
  const drifted = (input.driftedDependencies ?? [])
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dep of drifted) {
    const declared = dep.declaredVersion ?? dep.declared ?? "unknown";
    dependencyLines.push(
      bullet(
        "M5",
        `the dependency \`${dep.name}\` (\`${declared}\`) SHALL be reported as drifted and left unchanged (rule M5, Requirement 8.6).`
      )
    );
  }
  if (hasRuleFired(rows, "M1") && (input.targetRuntime?.kind === "python" || !input.targetRuntime)) {
    dependencyLines.push(
      bullet(
        "M5",
        "Python dependency drift SHALL be recorded as `unknown` in v1 (rule M5, Requirement 8.8)."
      )
    );
  }
  if (dependencyLines.length === 0) {
    dependencyLines.push(
      bullet(
        "unknown",
        "THE Grimoire records no dependency change for this repository (rule unknown, Requirement 10.2)."
      )
    );
  }
  out.push(...dependencyLines);

  // --- Checks ---------------------------------------------------------------
  out.push("");
  out.push("## Checks");
  out.push("");
  const checkLines: string[] = [];
  if (hasRuleFired(rows, "M1")) {
    checkLines.push(
      bullet(
        "M1",
        "WHEN a Python file is emitted, the file SHALL parse under CPython with `feature_version=(3, 13)` (rule M1, Requirement 9.3)."
      )
    );
  }
  if (hasRuleFired(rows, "M2")) {
    checkLines.push(
      bullet(
        "M2",
        "WHEN the resurrected repository is built, `npm install --ignore-scripts` and the test command SHALL run (rule M2, Requirement 11.6)."
      )
    );
  }
  const m6Dirs = Array.from(
    new Set(
      (input.signals ?? [])
        .filter((signal) => signal.ruleId === "M6")
        .map((signal) => normalizeBundlePath(signal.manifestDir ?? ".") || ".")
    )
  ).sort();
  for (const dir of m6Dirs) {
    const command = input.lockCommands?.[dir] ?? DEFAULT_NPM_LOCK_COMMAND;
    checkLines.push(
      bullet(
        "M6",
        `WHEN the lock file for \`${dir}\` is generated, \`${command}\` SHALL run (rule M6, Requirement 8.10).`
      )
    );
  }
  if (checkLines.length === 0) {
    checkLines.push(
      bullet(
        "unknown",
        "THE Grimoire records no additional check for this repository (rule unknown, Requirement 10.2)."
      )
    );
  }
  out.push(...checkLines);
  out.push("");
  return out.join("\n");
}

function normalizeUnknowns(
  unknowns: readonly UnknownRecord[]
): Array<{ reason: string; file: string; line: string }> {
  const seen = new Set<string>();
  const items: Array<{ reason: string; file: string; line: string }> = [];
  for (const unknown of unknowns ?? []) {
    const reason = typeof unknown.reason === "string" ? unknown.reason : "unknown";
    const file = typeof unknown.file === "string" ? normalizeBundlePath(unknown.file) : "";
    const line = typeof unknown.line === "number" ? String(unknown.line) : "";
    const key = `${reason}\u0000${file}\u0000${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ reason, file, line });
  }
  items.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
  });
  return items;
}

function resolvedStatusCounts(
  input: BundleInput,
  patchTasks: readonly BundlePatchTaskRecord[],
  manualTasks: readonly BundleManualTaskRecord[]
): Array<{ status: BundleTaskStatus; count: number }> {
  const checkedPatch = patchTasks.filter((task) => task.checked).length;
  const uncheckedPatch = patchTasks.length - checkedPatch;
  const checkedManual = manualTasks.filter((task) => task.checked).length;
  const uncheckedManual = manualTasks.length - checkedManual;
  const derived: Record<BundleTaskStatus, number> = {
    pending: uncheckedPatch + uncheckedManual,
    ready: 0,
    running: 0,
    in_review: 0,
    rejected: 0,
    merged: checkedPatch,
    failed: 0,
    abandoned: 0,
    skipped: 0,
    blocked: 0,
  };
  const provided = input.taskStatusCounts;
  return BUNDLE_TASK_STATUSES.map((status) => ({
    status,
    count:
      provided && typeof provided[status] === "number"
        ? (provided[status] as number)
        : derived[status],
  }));
}

/** `design.md`: mapping rows, compat notes, behavior notes, unknowns, Outcome (R3-10). */
export function renderDesign(
  input: BundleInput,
  steps: readonly BundleNormalizedStep[],
  rows: readonly BundleMappingRow[],
  patchTasks: readonly BundlePatchTaskRecord[],
  manualTasks: readonly BundleManualTaskRecord[]
): string {
  const version = resolveEngineVersion(input.engineVersion);
  const out: string[] = [];
  out.push(`# Design: ${input.owner}/${input.repo}`);
  out.push("");
  out.push(
    `Generated by the Grimoire engine \`${version}\` from templates only (Requirements 10.1, 10.2). ` +
      `Every mapping row cites a rule ID from M1 to M6 (Requirement 6.2).`
  );

  out.push("");
  out.push("## Mapping");
  out.push("");
  out.push("| Rule | Fired | Finding | Target | Files |");
  out.push("|---|---|---|---|---|");
  for (const row of rows) {
    const files = row.files.length > 0 ? row.files.map((f) => `\`${f}\``).join(", ") : "-";
    out.push(
      `| ${row.ruleId} | ${row.fired ? "yes" : "no"} | ${row.finding} | ${row.target} | ${files} |`
    );
  }

  out.push("");
  out.push("## Compatibility notes");
  out.push("");
  const compatLines = steps
    .filter((step) => step.compat)
    .map((step) =>
      bullet(
        step.ruleId,
        `\`${step.file}\` keeps the compatibility shim; behaviour is \`${step.behavior}\` (Requirements 7.6, 8.4).`
      )
    );
  out.push(
    ...(compatLines.length > 0
      ? compatLines
      : [
          bullet(
            "unknown",
            "no compatibility note applies to this repository (rule unknown, Requirement 10.2)."
          ),
        ])
  );

  out.push("");
  out.push("## Behavior notes");
  out.push("");
  const behaviorLines = steps
    .filter((step) => step.notes.length > 0 || step.behavior === "changed")
    .map((step) =>
      bullet(
        step.ruleId,
        `\`${step.file}\`: ${step.notes.length > 0 ? step.notes : "behaviour changed by this rule"} (Requirement 6.5).`
      )
    );
  out.push(
    ...(behaviorLines.length > 0
      ? behaviorLines
      : [
          bullet(
            "unknown",
            "no behaviour note applies to this repository (rule unknown, Requirement 10.2)."
          ),
        ])
  );

  out.push("");
  out.push("## Unknowns");
  out.push("");
  const unknownItems = normalizeUnknowns(input.unknowns ?? []);
  out.push(
    ...(unknownItems.length > 0
      ? unknownItems.map((item) =>
          bullet(
            "unknown",
            `\`${item.reason}\`${item.file ? ` at \`${item.file}${item.line ? `:${item.line}` : ""}\`` : ""} (Requirement 6.3).`
          )
        )
      : [
          bullet(
            "unknown",
            "no unknown item was recorded for this repository (rule unknown, Requirement 6.3)."
          ),
        ])
  );

  out.push("");
  out.push("## Outcome");
  out.push("");
  const labels = Object.entries(input.pythonFileLabels ?? {})
    .map(([file, label]) => ({ file: normalizeBundlePath(file), label }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  out.push(
    ...(labels.length > 0
      ? labels.map((item) =>
          bullet("M1", `\`${item.file}\` labelled \`${item.label}\` (Requirement 10.7).`)
        )
      : [bullet("unknown", "no Python file was labelled in this run (Requirement 10.7).")])
  );
  out.push("");
  const counts = resolvedStatusCounts(input, patchTasks, manualTasks);
  out.push(
    bullet(
      "unknown",
      `task status counts: ${counts
        .map((entry) => `${entry.status}=${entry.count}`)
        .join(", ")} (Requirements 10.4, 10.5, 10.7).`
    )
  );
  out.push("");
  return out.join("\n");
}

export interface BuiltBundleTasks {
  tasks: string;
  steps: BundleNormalizedStep[];
  patchTasks: BundlePatchTaskRecord[];
  manualTasks: BundleManualTaskRecord[];
}

/** Builds `tasks.md` plus the parsed patch/manual task records (Requirements 10.3-10.6, 10.11). */
export function buildBundleTasks(input: BundleInput): BuiltBundleTasks {
  const version = resolveEngineVersion(input.engineVersion);
  const steps = normalizePatchSteps(input.steps);

  const patchTasks: BundlePatchTaskRecord[] = steps.map((step, i) => ({
    index: i + 1,
    ruleId: step.ruleId,
    file: step.file,
    checked: !step.reverted,
    description: step.description,
    outcome: step.reverted
      ? `reverted (${step.revertReason ?? "all_edits_rejected"})`
      : undefined,
  }));

  const manualTasks: BundleManualTaskRecord[] = collectManualTasks(input).map(
    (task, i) => {
      const ruleId = task.ruleId as BundleRuleId;
      const checked = task.checked === true;
      return {
        index: patchTasks.length + i + 1,
        ruleId,
        target: task.target,
        checked,
        description: task.description,
        outcome: checked
          ? task.outcome ?? (ruleId === "M6" ? M6_PRESET_OUTCOME : undefined)
          : undefined,
      };
    }
  );

  const out: string[] = [];
  out.push(`# Tasks: ${input.owner}/${input.repo}`);
  out.push("");
  out.push(
    `Generated by the Grimoire engine \`${version}\` from templates only (Requirements 10.1, 10.3). ` +
      `Each patch task maps one to one to a patch step \`(ruleId, file)\` (Requirement 10.4) and is ` +
      `checked if and only if its step is not reverted (Requirement 10.5).`
  );

  out.push("");
  out.push("## Patch tasks");
  out.push("");
  if (patchTasks.length === 0) {
    out.push("No patch task applies to this repository (rule unknown, Requirement 10.4).");
  } else {
    for (const task of patchTasks) {
      out.push(
        `- [${task.checked ? "x" : " "}] ${task.index}. ${task.ruleId} \`${task.file}\`: ${task.description}`
      );
      if (task.outcome) {
        out.push(`  - Outcome: ${task.outcome}`);
      }
    }
  }

  out.push("");
  out.push("## Manual tasks");
  out.push("");
  if (manualTasks.length === 0) {
    out.push("No manual task applies to this repository (rule unknown, Requirement 10.11).");
  } else {
    for (const task of manualTasks) {
      out.push(
        `- [${task.checked ? "x" : " "}] ${task.index}. ${task.ruleId} (manual) \`${task.target}\`: ${task.description}`
      );
      if (task.outcome) {
        out.push(`  - Outcome: ${task.outcome}`);
      }
    }
  }

  out.push("");
  return { tasks: out.join("\n"), steps, patchTasks, manualTasks };
}

/** `tasks.md` only. */
export function renderTasks(input: BundleInput): string {
  return buildBundleTasks(input).tasks;
}

export interface ParsedBundleTasks {
  patch: BundlePatchTaskRecord[];
  manual: BundleManualTaskRecord[];
}

/**
 * Parses `tasks.md` back into patch and manual task records so tests can assert
 * the 1:1 bijection (`T = S`) and the `[x]` iff `!reverted` marking (P7).
 */
export function parseBundleTasks(tasks: string): ParsedBundleTasks {
  const patchRe = /^- \[( |x)\] (\d+)\. (M[1-6]) `([^`]+)`: (.*)$/;
  const manualRe = /^- \[( |x)\] (\d+)\. (M[1-6]) \(manual\) `([^`]+)`: (.*)$/;
  const outcomeRe = /^ {2}- Outcome: (.*)$/;
  const patch: BundlePatchTaskRecord[] = [];
  const manual: BundleManualTaskRecord[] = [];
  let lastPatch: BundlePatchTaskRecord | null = null;
  let lastManual: BundleManualTaskRecord | null = null;

  for (const rawLine of tasks.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const outcome = line.match(outcomeRe);
    if (outcome) {
      const value = outcome[1].trim();
      if (lastManual) lastManual.outcome = value;
      else if (lastPatch) lastPatch.outcome = value;
      continue;
    }
    const manualMatch = line.match(manualRe);
    if (manualMatch) {
      const record: BundleManualTaskRecord = {
        index: Number(manualMatch[2]),
        ruleId: manualMatch[3] as BundleRuleId,
        target: manualMatch[4],
        checked: manualMatch[1] === "x",
        description: manualMatch[5].trim(),
      };
      manual.push(record);
      lastManual = record;
      lastPatch = null;
      continue;
    }
    const patchMatch = line.match(patchRe);
    if (patchMatch) {
      const record: BundlePatchTaskRecord = {
        index: Number(patchMatch[2]),
        ruleId: patchMatch[3] as BundleRuleId,
        file: patchMatch[4],
        checked: patchMatch[1] === "x",
        description: patchMatch[5].trim(),
      };
      patch.push(record);
      lastPatch = record;
      lastManual = null;
      continue;
    }
    // Any other non-empty line ends the current task's Outcome block.
    if (line.trim().length > 0) {
      lastPatch = null;
      lastManual = null;
    }
  }

  return { patch, manual };
}

/** Extracts the mapping rows from a rendered `design.md` (Requirement 6.2, P5). */
export function extractMappingRows(design: string): BundleMappingRow[] {
  const rows: BundleMappingRow[] = [];
  let inMapping = false;
  for (const rawLine of design.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^##\s+Mapping\s*$/.test(line)) {
      inMapping = true;
      continue;
    }
    if (inMapping && /^##\s+/.test(line)) {
      inMapping = false;
      continue;
    }
    if (!inMapping) continue;
    const match = line.match(
      /^\|\s*(M[1-6])\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|$/
    );
    if (!match) continue;
    const filesRaw = match[5].trim();
    rows.push({
      ruleId: match[1] as BundleRuleId,
      fired: match[2].trim() === "yes",
      finding: match[3].trim(),
      target: match[4].trim(),
      files:
        filesRaw === "-" || filesRaw === ""
          ? []
          : filesRaw
              .split(",")
              .map((part) => part.trim().replace(/^`/, "").replace(/`$/, ""))
              .filter((part) => part.length > 0),
    });
  }
  return rows;
}

/** Generates the full Grimoire_Bundle deterministically (Requirements 10.1, 10.8). */
export function generateBundle(input: BundleInput): GrimoireBundle {
  const version = resolveEngineVersion(input.engineVersion);
  const built = buildBundleTasks(input);
  const rows = buildMappingRows(input, built.steps);
  const requirements = renderRequirements(input, rows);
  const design = renderDesign(
    input,
    built.steps,
    rows,
    built.patchTasks,
    built.manualTasks
  );
  return {
    requirements,
    design,
    tasks: built.tasks,
    engineVersion: version,
    patchSteps: built.steps,
    patchTasks: built.patchTasks,
    manualTasks: built.manualTasks,
    mappingRows: rows,
  };
}





