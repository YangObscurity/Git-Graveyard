import { parse, type ParserPlugin } from "@babel/parser";
import * as Diff from "diff";
import type { RuleId, UnknownRecord } from "./types";
import type { EventEnvelope, EvidenceRef } from "../events/types";

export interface EventInput {
  runId: string;
  kind: string;
  actor: string;
  data?: Record<string, unknown>;
  ts?: number;
  seq?: number;
  skeletonId?: string | null;
  taskId?: string | null;
  attempt?: number | null;
  [key: string]: unknown;
}

export type ParseMode = "module" | "script";

export interface PlannedEdit {
  start: number;
  end: number;
  text?: string;
  replacement?: string;
  ruleId?: string;
  file?: string;
  description?: string;
  [key: string]: unknown;
}

export interface PatchStep {
  id?: string;
  ruleId?: RuleId | string;
  file?: string;
  diff?: string;
  diffOmitted?: boolean;
  patch?: string;
  hunks?: number;
  compat?: boolean;
  behavior?: string;
  notes?: string;
  confidence?: "high" | "medium" | "low" | string;
  reverted: boolean;
  revertReason?: "parse_failed" | "all_edits_rejected" | string;
  acceptedEdits?: number;
  acceptedEditsCount?: number;
  edits?: PlannedEdit[];
  plannedEdits?: PlannedEdit[];
  accepted?: boolean | number;
  code?: string;
  content?: string;
  [key: string]: unknown;
}

export type PackageJsonInput =
  | Record<string, unknown>
  | string
  | null
  | undefined;

export interface GateResult {
  ok: boolean;
  files: string[];
  reasons: string[];
  gate: "syntax";
  kind: "gate.result";
  tree?: string | unknown;
  file?: string;
  code?: string;
  mode?: ParseMode;
  originalMode?: ParseMode;
  steps?: PatchStep[];
  revertedSteps?: PatchStep[];
  unknowns?: UnknownRecord[];
  details?: Record<
    string,
    {
      ok: boolean;
      mode?: ParseMode;
      error?: string;
    }
  >;
}

export interface GateJsOptions {
  filePath?: string;
  file?: string;
  path?: string;
  content?: string;
  source?: string;
  originalContent?: string;
  originalSource?: string;
  patchedContent?: string;
  packageJson?: PackageJsonInput;
  packageJsons?: Record<string, PackageJsonInput> | Map<string, PackageJsonInput>;
  packageJsonPath?: string;
  steps?: PatchStep[];
  unknowns?: UnknownRecord[];
  changedFiles?: string[];
  diff?: string;
  eventStore?: {
    append(input: EventInput): EventEnvelope;
    [key: string]: unknown;
  };
  runId?: string;
  taskId?: string;
  actor?: string;
  refs?: EvidenceRef[];
  emit?: (event: unknown) => void;
  [key: string]: unknown;
}

export interface CandidateInput {
  files?: Array<{ path: string; content: string; [key: string]: unknown }>;
  tree?: string | Record<string, string> | Map<string, string>;
  treeSha?: string;
  candidateTree?: string;
  changedFiles?: string[];
  changed?: string[];
  diff?: string;
  packageJson?: PackageJsonInput;
  packageJsons?: Record<string, PackageJsonInput> | Map<string, PackageJsonInput>;
  steps?: PatchStep[];
  empty?: boolean;
  isEmpty?: boolean;
  allowEmpty?: boolean;
  [key: string]: unknown;
}

export interface CandidateCheckOptions {
  packageJson?: PackageJsonInput;
  packageJsons?: Record<string, PackageJsonInput> | Map<string, PackageJsonInput>;
  steps?: PatchStep[];
  changedFiles?: string[];
  head?: unknown;
  tree?: string | unknown;
  treeSha?: string;
  candidateTree?: string | unknown;
  empty?: boolean;
  isEmpty?: boolean;
  allowEmpty?: boolean;
  eventStore?: {
    append(input: EventInput): EventEnvelope;
    [key: string]: unknown;
  };
  runId?: string;
  taskId?: string;
  actor?: string;
  refs?: EvidenceRef[];
  emit?: (event: unknown) => void;
  [key: string]: unknown;
}

/**
 * Normalizes file paths across OS and git representations.
 */
export function normalizeFilePath(p: string): string {
  if (typeof p !== "string") return "";
  let s = p.replace(/\\/g, "/").trim();
  while (s.startsWith("./")) {
    s = s.slice(2);
  }
  return s;
}

/**
 * Verifies whether a given path is a JavaScript or TypeScript source file.
 */
export function isJsOrTsFile(filePath: string): boolean {
  if (typeof filePath !== "string") return false;
  const norm = normalizeFilePath(filePath).toLowerCase();
  const base = norm.split("/").pop() || "";
  return (
    base.endsWith(".js") ||
    base.endsWith(".mjs") ||
    base.endsWith(".cjs") ||
    base.endsWith(".jsx") ||
    base.endsWith(".ts") ||
    base.endsWith(".tsx") ||
    base.endsWith(".mts") ||
    base.endsWith(".cts")
  );
}

/**
 * Verifies whether a given path is a Python source file (.py).
 */
export function isPythonFile(filePath: string): boolean {
  if (typeof filePath !== "string") return false;
  const norm = normalizeFilePath(filePath).toLowerCase();
  const base = norm.split("/").pop() || "";
  return base.endsWith(".py");
}

/**
 * Checks whether a package.json representation has type: "module".
 */
export function hasTypeModule(pkg: PackageJsonInput): boolean {
  if (!pkg) return false;
  if (typeof pkg === "string") {
    try {
      const parsed = JSON.parse(pkg);
      return (
        parsed !== null &&
        typeof parsed === "object" &&
        parsed.type === "module"
      );
    } catch {
      return false;
    }
  }
  if (typeof pkg === "object") {
    return (pkg as Record<string, unknown>).type === "module";
  }
  return false;
}

/**
 * Locates the package.json manifest governing a particular file.
 */
export function findPackageJsonForFile(
  filePath: string,
  pkgInput?:
    | PackageJsonInput
    | Record<string, PackageJsonInput>
    | Map<string, PackageJsonInput>
): PackageJsonInput {
  if (!pkgInput) return undefined;

  if (typeof pkgInput === "string") {
    try {
      const parsed = JSON.parse(pkgInput);
      if (parsed && typeof parsed === "object" && !("package.json" in parsed)) {
        return parsed;
      }
    } catch {
      // not a multi-manifest map
    }
  }

  if (
    typeof pkgInput === "object" &&
    pkgInput !== null &&
    !(pkgInput instanceof Map)
  ) {
    if (
      "type" in pkgInput ||
      "name" in pkgInput ||
      "dependencies" in pkgInput ||
      "scripts" in pkgInput ||
      "version" in pkgInput
    ) {
      return pkgInput as Record<string, unknown>;
    }
  }

  const normFile = normalizeFilePath(filePath);
  const segments = normFile.split("/");
  segments.pop();

  while (segments.length >= 0) {
    const dir = segments.join("/");
    const candidatePath =
      dir.length === 0 ? "package.json" : `${dir}/package.json`;

    if (pkgInput instanceof Map) {
      if (pkgInput.has(candidatePath)) {
        return pkgInput.get(candidatePath);
      }
    } else if (typeof pkgInput === "object" && pkgInput !== null) {
      if (candidatePath in pkgInput) {
        return (pkgInput as Record<string, unknown>)[
          candidatePath
        ] as PackageJsonInput;
      }
    }

    if (segments.length === 0) break;
    segments.pop();
  }

  if (pkgInput instanceof Map) {
    return pkgInput.get("package.json") ?? pkgInput.get("./package.json");
  }
  if (typeof pkgInput === "object" && pkgInput !== null) {
    return ((pkgInput as Record<string, unknown>)["package.json"] ??
      (pkgInput as Record<string, unknown>)[
        "./package.json"
      ]) as PackageJsonInput;
  }

  return undefined;
}

/**
 * Requirement 9.5:
 * WHEN parsing an original JavaScript or TypeScript file, THE Grimoire_Gate SHALL parse the file
 * as module if the file has the .mjs extension or sits under a package.json containing type: "module",
 * and as script otherwise.
 */
export function resolveOriginalParseMode(
  filePath: string,
  packageJson?:
    | PackageJsonInput
    | Record<string, PackageJsonInput>
    | Map<string, PackageJsonInput>
): ParseMode {
  const normFile = normalizeFilePath(filePath).toLowerCase();
  if (normFile.endsWith(".mjs")) {
    return "module";
  }
  const pkg = findPackageJsonForFile(filePath, packageJson);
  if (hasTypeModule(pkg)) {
    return "module";
  }
  return "script";
}

/**
 * Checks whether a given patch step applies to a specified target file.
 */
export function isStepForFile(step: PatchStep, filePath: string): boolean {
  if (!step.file) return true;
  const sFile = normalizeFilePath(step.file).toLowerCase();
  const target = normalizeFilePath(filePath).toLowerCase();
  if (sFile === target) return true;
  if (sFile.endsWith("/" + target) || target.endsWith("/" + sFile)) return true;
  const sBase = sFile.split("/").pop();
  const tBase = target.split("/").pop();
  return sBase === tBase;
}

/**
 * Requirement 9.7:
 * WHEN parsing a patched JavaScript or TypeScript file, THE Grimoire_Gate SHALL parse the file
 * as module if an unreverted M3 step changed the file, and in the original file's mode otherwise.
 */
export function resolvePatchedParseMode(
  filePath: string,
  steps: PatchStep[] = [],
  packageJson?:
    | PackageJsonInput
    | Record<string, PackageJsonInput>
    | Map<string, PackageJsonInput>
): ParseMode {
  const normFile = normalizeFilePath(filePath);
  const hasUnrevertedM3 = steps.some((s) => {
    if (s.reverted) return false;
    const rule = (s.ruleId || "").toString().trim().toUpperCase();
    if (rule !== "M3") return false;
    return isStepForFile(s, normFile);
  });

  if (hasUnrevertedM3) {
    return "module";
  }
  return resolveOriginalParseMode(filePath, packageJson);
}

/**
 * General mode resolution helper for original or patched files.
 */
export function resolveParseMode(
  filePath: string,
  packageJsonOrOptions?:
    | PackageJsonInput
    | Record<string, PackageJsonInput>
    | Map<string, PackageJsonInput>
    | {
        packageJson?: PackageJsonInput;
        packageJsons?:
          | Record<string, PackageJsonInput>
          | Map<string, PackageJsonInput>;
        steps?: PatchStep[];
        isPatched?: boolean;
      },
  steps?: PatchStep[]
): ParseMode {
  if (
    packageJsonOrOptions &&
    typeof packageJsonOrOptions === "object" &&
    !Array.isArray(packageJsonOrOptions) &&
    ("packageJson" in packageJsonOrOptions ||
      "steps" in packageJsonOrOptions ||
      "isPatched" in packageJsonOrOptions)
  ) {
    const opts = packageJsonOrOptions as {
      packageJson?: PackageJsonInput;
      packageJsons?:
        | Record<string, PackageJsonInput>
        | Map<string, PackageJsonInput>;
      steps?: PatchStep[];
      isPatched?: boolean;
    };
    const s = steps ?? opts.steps ?? [];
    if (opts.isPatched || s.length > 0) {
      return resolvePatchedParseMode(
        filePath,
        s,
        opts.packageJson ?? opts.packageJsons
      );
    }
    return resolveOriginalParseMode(
      filePath,
      opts.packageJson ?? opts.packageJsons
    );
  }

  const s = steps ?? [];
  if (s.length > 0) {
    return resolvePatchedParseMode(filePath, s, packageJsonOrOptions as any);
  }
  return resolveOriginalParseMode(filePath, packageJsonOrOptions as any);
}

/**
 * Detects JSX syntax in a source string. Plain JavaScript files enable the jsx
 * parser plugin only when their source actually contains JSX.
 */
function sourceContainsJsx(source: string): boolean {
  return /<\/?[A-Za-z]|<>/.test(source);
}

/**
 * Determines plugin configuration attempts for @babel/parser based on file extension.
 * Plain JavaScript files (.js, .cjs, .mjs, .jsx) never fall back to the typescript plugin
 * and only use the jsx plugin when the source contains JSX (or for .jsx files).
 */
function getPluginAttempts(filePath: string, source: string): ParserPlugin[][] {
  const norm = filePath
    ? normalizeFilePath(filePath).toLowerCase()
    : "file.js";
  const isTsx = norm.endsWith(".tsx");
  const isTs =
    norm.endsWith(".ts") || norm.endsWith(".mts") || norm.endsWith(".cts");
  const isJsx = norm.endsWith(".jsx");

  let base: ParserPlugin[];
  if (isTsx) {
    base = ["typescript", "jsx"];
  } else if (isTs) {
    base = ["typescript"];
  } else if (isJsx) {
    return [
      ["jsx"],
      ["jsx", "decorators-legacy"],
      ["jsx", "decorators"],
    ];
  } else {
    const jsBase: ParserPlugin[] = sourceContainsJsx(source) ? ["jsx"] : [];
    return [
      jsBase,
      [...jsBase, "decorators-legacy"],
      [...jsBase, "decorators"],
    ];
  }

  return [
    base,
    [...base, "decorators-legacy"],
    [...base, "decorators"],
    ["typescript", "jsx", "decorators-legacy"],
  ];
}

/**
 * Attempts parsing with @babel/parser across plugin combinations for the specified sourceType.
 * Plain JavaScript files (.js, .cjs, .mjs, .jsx) are parsed strictly: no
 * allowReturnOutsideFunction, allowAwaitOutsideFunction, allowSuperOutsideMethod or
 * allowUndeclaredExports allowances, and no typescript plugin fallback.
 */
export function tryParseJsOrTs(
  source: string,
  filePath: string,
  sourceType: ParseMode
): { ok: true; ast: any } | { ok: false; error: Error } {
  const attempts = getPluginAttempts(filePath, source);
  const norm = filePath
    ? normalizeFilePath(filePath).toLowerCase()
    : "file.js";
  const isPlainJs =
    norm.endsWith(".js") ||
    norm.endsWith(".mjs") ||
    norm.endsWith(".cjs") ||
    norm.endsWith(".jsx");
  const looseOptions = isPlainJs
    ? {}
    : {
        allowReturnOutsideFunction: sourceType === "script",
        allowAwaitOutsideFunction: true,
        allowSuperOutsideMethod: true,
        allowUndeclaredExports: true,
      };
  let lastError: unknown;

  for (const plugins of attempts) {
    try {
      const ast = parse(source, { sourceType, ...looseOptions, plugins });
      return { ok: true, ast };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    error:
      lastError instanceof Error ? lastError : new Error(String(lastError)),
  };
}

/**
 * Requirement 9.4:
 * IF no edit of a patch step is accepted, THEN THE Grimoire_Gate SHALL mark the step reverted
 * with reason all_edits_rejected.
 */
export function isZeroAcceptedEditsStep(step: PatchStep): boolean {
  if (step.reverted) {
    return false;
  }
  if (typeof step.acceptedEdits === "number" && step.acceptedEdits === 0) {
    return true;
  }
  if (
    typeof (step as any).acceptedEditsCount === "number" &&
    (step as any).acceptedEditsCount === 0
  ) {
    return true;
  }
  if (Array.isArray(step.edits) && step.edits.length === 0) {
    return true;
  }
  if (Array.isArray(step.plannedEdits) && step.plannedEdits.length === 0) {
    return true;
  }
  if ((step as any).accepted === false || (step as any).accepted === 0) {
    return true;
  }
  return false;
}

/**
 * Applies offset-based edits to text in reverse offset order.
 */
export function applyEdits(source: string, edits: PlannedEdit[]): string {
  if (!edits || edits.length === 0) return source;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let res = source;
  for (const edit of sorted) {
    const textToInsert = edit.text ?? edit.replacement ?? "";
    res = res.slice(0, edit.start) + textToInsert + res.slice(edit.end);
  }
  return res;
}

/**
 * Applies all currently unreverted steps to the original file content.
 */
export function applyStepsToFile(
  originalContent: string,
  steps: PatchStep[],
  filePath: string,
  options?: GateJsOptions
): { code: string; ok: boolean; failedStep?: PatchStep } {
  const normFile = normalizeFilePath(filePath);
  const matchingSteps = steps.filter((s) => isStepForFile(s, normFile));
  const unrevertedSteps = matchingSteps.filter((s) => !s.reverted);

  if (unrevertedSteps.length === 0) {
    return { code: originalContent, ok: true };
  }

  const hasDirectEdits = unrevertedSteps.some(
    (s) =>
      Boolean(s.diff) ||
      Boolean((s as any).patch) ||
      typeof s.code === "string" ||
      typeof s.content === "string" ||
      (Array.isArray(s.edits) && s.edits.length > 0) ||
      (Array.isArray(s.plannedEdits) && s.plannedEdits.length > 0)
  );

  if (
    !hasDirectEdits &&
    typeof options?.patchedContent === "string" &&
    unrevertedSteps.length === matchingSteps.length
  ) {
    return { code: options.patchedContent, ok: true };
  }

  let current = originalContent;
  for (const step of unrevertedSteps) {
    if (step.diff || (step as any).patch) {
      const patchStr = (step.diff || (step as any).patch)!;
      const patched = Diff.applyPatch(current, patchStr);
      if (typeof patched !== "string") {
        return { code: current, ok: false, failedStep: step };
      }
      current = patched;
    } else if (typeof step.code === "string") {
      current = step.code;
    } else if (typeof step.content === "string") {
      current = step.content;
    } else if (Array.isArray(step.edits) && step.edits.length > 0) {
      current = applyEdits(current, step.edits);
    } else if (
      Array.isArray(step.plannedEdits) &&
      step.plannedEdits.length > 0
    ) {
      current = applyEdits(current, step.plannedEdits);
    }
  }

  return { code: current, ok: true };
}

/**
 * Requirement 9.4 - 9.8:
 * Evaluates JavaScript/TypeScript original and patched syntax, iteratively rolling back
 * failing steps with parse_failed and marking zero accepted edits with all_edits_rejected.
 */
function gateJsSingleFile(
  filePath: string,
  originalContent: string,
  steps: PatchStep[] = [],
  options: GateJsOptions = {}
): GateResult {
  const normFile = normalizeFilePath(filePath);
  if (typeof originalContent !== "string") {
    const errMsg = "content is missing";
    return {
      ok: false,
      file: normFile,
      files: [normFile],
      reasons: [`${normFile}: ${errMsg}`],
      gate: "syntax",
      kind: "gate.result",
      details: {
        [normFile]: { ok: false, error: errMsg },
      },
    };
  }
  const pkgInput = options.packageJson ?? options.packageJsons;

  // Requirement 9.5: Parse original file mode
  const originalMode = resolveOriginalParseMode(normFile, pkgInput);

  // Requirement 9.6: If original file fails to parse, leave unchanged and record original_unparseable
  const origParse = tryParseJsOrTs(originalContent, normFile, originalMode);
  if (!origParse.ok) {
    const unknownRecord: UnknownRecord = {
      reason: "original_unparseable",
      file: normFile,
      line: (origParse.error as any).loc?.line,
    };
    if (options.unknowns) {
      options.unknowns.push(unknownRecord);
    }
    return {
      ok: false,
      file: normFile,
      files: [normFile],
      reasons: [`${normFile}: original_unparseable: ${origParse.error.message}`],
      gate: "syntax",
      kind: "gate.result",
      code: originalContent,
      mode: originalMode,
      originalMode,
      steps: steps.map((s) => ({ ...s })),
      revertedSteps: [],
      unknowns: [unknownRecord],
    };
  }

  // Pure function: clone steps to prevent external state mutation
  const workingSteps: PatchStep[] = steps.map((s) => ({ ...s }));

  // Requirement 9.4: Mark zero accepted edit steps as reverted with all_edits_rejected
  for (const step of workingSteps) {
    if (!step.reverted && isZeroAcceptedEditsStep(step)) {
      step.reverted = true;
      step.revertReason = "all_edits_rejected";
    }
  }

  // Requirement 9.7 & 9.8: Patched parsing and iterative rollback loop
  while (true) {
    const mode = resolvePatchedParseMode(normFile, workingSteps, pkgInput);
    const applyRes = applyStepsToFile(
      originalContent,
      workingSteps,
      normFile,
      options
    );

    let parseOk = false;
    let parseError: Error | undefined;

    if (applyRes.ok) {
      const parseRes = tryParseJsOrTs(applyRes.code, normFile, mode);
      if (parseRes.ok) {
        parseOk = true;
      } else {
        parseError = parseRes.error;
      }
    } else {
      parseError = new Error(
        `Failed to apply patch step: ${applyRes.failedStep?.id || "unknown"}`
      );
    }

    if (parseOk) {
      return {
        ok: true,
        file: normFile,
        files: [normFile],
        reasons: [],
        gate: "syntax",
        kind: "gate.result",
        code: applyRes.code,
        mode,
        originalMode,
        steps: workingSteps,
        revertedSteps: workingSteps.filter((s) => s.reverted),
        unknowns: [],
      };
    }

    // On parse failure: find last unreverted step for this file
    let lastUnrevertedIdx = -1;
    for (let i = workingSteps.length - 1; i >= 0; i--) {
      const s = workingSteps[i];
      if (!s.reverted && isStepForFile(s, normFile)) {
        lastUnrevertedIdx = i;
        break;
      }
    }

    // All steps reverted for this file
    if (lastUnrevertedIdx === -1) {
      return {
        ok: false,
        file: normFile,
        files: [normFile],
        reasons: [
          `${normFile}: parse_failed: ${parseError?.message || "syntax error"}`,
        ],
        gate: "syntax",
        kind: "gate.result",
        code: originalContent,
        mode,
        originalMode,
        steps: workingSteps,
        revertedSteps: workingSteps.filter((s) => s.reverted),
        unknowns: [],
      };
    }

    // Revert the last unreverted step with reason parse_failed
    workingSteps[lastUnrevertedIdx].reverted = true;
    workingSteps[lastUnrevertedIdx].revertReason = "parse_failed";
    // Recompute mode and parse again
  }
}

/**
 * Extracts candidate files, changed files list, and package.json configurations.
 */
function extractCandidateData(
  candidate: any,
  head?: any,
  options?: CandidateCheckOptions
): {
  filesMap: Map<string, string>;
  changedFiles: string[];
  packageJsons: Map<string, PackageJsonInput>;
} {
  const filesMap = new Map<string, string>();
  const packageJsons = new Map<string, PackageJsonInput>();
  const changedSet = new Set<string>();

  // Extract from options.packageJson / packageJsons
  if (options?.packageJson) {
    packageJsons.set("package.json", options.packageJson);
  }
  if (options?.packageJsons) {
    if (options.packageJsons instanceof Map) {
      for (const [k, v] of options.packageJsons.entries()) {
        packageJsons.set(normalizeFilePath(k), v as PackageJsonInput);
      }
    } else if (typeof options.packageJsons === "object") {
      for (const [k, v] of Object.entries(options.packageJsons)) {
        packageJsons.set(normalizeFilePath(k), v as PackageJsonInput);
      }
    }
  }

  // Populate filesMap from candidate
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (typeof item === "string") {
        changedSet.add(normalizeFilePath(item));
      } else if (item && typeof item === "object") {
        const p = normalizeFilePath(item.path || item.file || "");
        if (p) {
          if (typeof item.content === "string") {
            filesMap.set(p, item.content);
          }
          changedSet.add(p);
        }
      }
    }
  } else if (candidate && typeof candidate === "object") {
    if (candidate.packageJson) {
      packageJsons.set("package.json", candidate.packageJson as PackageJsonInput);
    }
    if (candidate.packageJsons) {
      if (candidate.packageJsons instanceof Map) {
        for (const [k, v] of candidate.packageJsons.entries()) {
          packageJsons.set(normalizeFilePath(k), v as PackageJsonInput);
        }
      } else if (typeof candidate.packageJsons === "object") {
        for (const [k, v] of Object.entries(candidate.packageJsons)) {
          packageJsons.set(normalizeFilePath(k), v as PackageJsonInput);
        }
      }
    }

    const rawFiles = candidate.files;
    if (rawFiles) {
      if (Array.isArray(rawFiles)) {
        for (const item of rawFiles) {
          if (item && typeof item === "object") {
            const p = normalizeFilePath(item.path || item.file || "");
            if (p) {
              if (typeof item.content === "string") {
                filesMap.set(p, item.content);
              }
              changedSet.add(p);
            }
          }
        }
      }
    }

    // Parse diff if present
    if (typeof candidate.diff === "string") {
      try {
        const patches = Diff.parsePatch(candidate.diff);
        for (const p of patches) {
          const rawName = p.newFileName || p.oldFileName || "";
          const cleanName = normalizeFilePath(rawName.replace(/^[ab]\//, ""));
          if (cleanName && cleanName !== "/dev/null") {
            changedSet.add(cleanName);
          }
        }
      } catch {
        // Fallback diff regex
        const diffMatches = candidate.diff.matchAll(
          /(?:diff --git a\/(\S+) b\/(\S+)|\+\+\+ (?:b\/)?(\S+))/g
        );
        for (const m of diffMatches) {
          const p = normalizeFilePath(m[2] || m[3] || m[1] || "");
          if (p && p !== "/dev/null") {
            changedSet.add(p);
          }
        }
      }
    }

    // Steps
    if (Array.isArray(candidate.steps)) {
      for (const s of candidate.steps) {
        if (s.file) {
          const p = normalizeFilePath(s.file);
          changedSet.add(p);
          if (typeof s.content === "string" && !filesMap.has(p)) {
            filesMap.set(p, s.content);
          } else if (typeof s.code === "string" && !filesMap.has(p)) {
            filesMap.set(p, s.code);
          }
        }
      }
    }

    // Changed files lists
    const explicitChanged =
      candidate.changedFiles ?? candidate.changed ?? options?.changedFiles;
    const hasExplicitChanged = Array.isArray(explicitChanged);
    if (hasExplicitChanged) {
      for (const f of explicitChanged) {
        changedSet.add(normalizeFilePath(f));
      }
    }
  }

  // Head comparison
  if (head && typeof head === "object") {
    const headFiles = head.files ?? head.tree ?? head;
    if (headFiles instanceof Map) {
      for (const [p, content] of filesMap.entries()) {
        if (headFiles.get(p) !== content) {
          changedSet.add(p);
        }
      }
    } else if (typeof headFiles === "object" && headFiles !== null) {
      for (const [p, content] of filesMap.entries()) {
        if ((headFiles as Record<string, unknown>)[p] !== content) {
          changedSet.add(p);
        }
      }
    }
  }

  // Discover any package.json loaded into filesMap
  for (const [p, content] of filesMap.entries()) {
    if (p.endsWith("package.json")) {
      packageJsons.set(p, content);
    }
  }

  // If changedSet is empty and filesMap has entries, check all files in filesMap
  // unless caller explicitly provided an empty changedFiles list
  const explicitChangedCheck =
    candidate?.changedFiles ?? candidate?.changed ?? options?.changedFiles;
  const callerSpecifiedEmptyChanged =
    Array.isArray(explicitChangedCheck) && explicitChangedCheck.length === 0;

  if (!callerSpecifiedEmptyChanged && changedSet.size === 0 && filesMap.size > 0) {
    for (const p of filesMap.keys()) {
      changedSet.add(p);
    }
  }

  return {
    filesMap,
    changedFiles: Array.from(changedSet),
    packageJsons,
  };
}

const KNOWN_CANDIDATE_KEYS = new Set([
  "files",
  "tree",
  "treeSha",
  "candidateTree",
  "changedFiles",
  "changed",
  "diff",
  "packageJson",
  "packageJsons",
  "steps",
  "empty",
  "isEmpty",
  "allowEmpty",
  "runId",
  "taskId",
  "actor",
  "refs",
  "eventStore",
  "emit",
  "sha256",
]);

/**
 * Requirement 9.9, 9.11, 9.12, 9.13:
 * Verifies that all changed JavaScript and TypeScript files in a Candidate parse
 * using the mode given by the file's extension and post-change package.json type.
 */
export function checkCandidate(
  headOrCandidate: any,
  candidateOrOptions?: any,
  optionsArg?: CandidateCheckOptions
): GateResult {
  let head: any;
  let candidate: any;
  let options: CandidateCheckOptions = {};

  if (candidateOrOptions === undefined) {
    candidate = headOrCandidate;
  } else if (optionsArg !== undefined) {
    head = headOrCandidate;
    candidate = candidateOrOptions;
    options = optionsArg || {};
  } else if (
    candidateOrOptions &&
    typeof candidateOrOptions === "object" &&
    (candidateOrOptions.eventStore !== undefined ||
      candidateOrOptions.emit !== undefined ||
      candidateOrOptions.runId !== undefined ||
      candidateOrOptions.actor !== undefined ||
      candidateOrOptions.taskId !== undefined ||
      candidateOrOptions.refs !== undefined ||
      candidateOrOptions.empty !== undefined ||
      candidateOrOptions.allowEmpty !== undefined ||
      candidateOrOptions.isEmpty !== undefined)
  ) {
    candidate = headOrCandidate;
    options = candidateOrOptions || {};
  } else if (
    candidateOrOptions &&
    typeof candidateOrOptions === "object" &&
    ("files" in candidateOrOptions ||
      "diff" in candidateOrOptions ||
      "changedFiles" in candidateOrOptions ||
      "changed" in candidateOrOptions)
  ) {
    head = headOrCandidate;
    candidate = candidateOrOptions;
    options = {};
  } else {
    candidate = headOrCandidate;
    options = candidateOrOptions || {};
  }

  // Extract candidate tree identifier or structure
  const candidateTree =
    options?.tree ??
    options?.candidateTree ??
    (typeof candidate === "object" && candidate !== null
      ? candidate.tree ?? candidate.treeSha ?? candidate.candidateTree
      : null) ??
    null;

  if (!candidate || (typeof candidate !== "object" && !Array.isArray(candidate))) {
    const result: GateResult = {
      ok: false,
      files: [],
      reasons: ["invalid candidate shape: expected candidate object or files array"],
      gate: "syntax",
      kind: "gate.result",
      tree: candidateTree,
    };
    if (options?.eventStore) {
      emitGateResultEvent(options.eventStore, result, {
        ...options,
        tree: candidateTree,
      });
    } else if (typeof options?.emit === "function") {
      options.emit(result);
    }
    return result;
  }

  // Requirement H-7 (1): When candidate is an array of files, it must be an array of objects,
  // each with a string path and a string content.
  if (Array.isArray(candidate)) {
    const isValid = candidate.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof item.path === "string" &&
        typeof item.content === "string"
    );
    if (!isValid) {
      const result: GateResult = {
        ok: false,
        files: [],
        reasons: ["invalid files shape: expected array of {path, content}"],
        gate: "syntax",
        kind: "gate.result",
        tree: candidateTree,
      };
      if (options?.eventStore) {
        emitGateResultEvent(options.eventStore, result, {
          ...options,
          tree: candidateTree,
        });
      } else if (typeof options?.emit === "function") {
        options.emit(result);
      }
      return result;
    }
  }

  if (!Array.isArray(candidate) && typeof candidate === "object") {
    const candidateKeys = Object.keys(candidate);
    const hasArbitraryKeys = candidateKeys.some(
      (k) => !KNOWN_CANDIDATE_KEYS.has(k)
    );
    if (hasArbitraryKeys) {
      const result: GateResult = {
        ok: false,
        files: [],
        reasons: [
          "invalid candidate shape: object-argument form with arbitrary keys is not supported, expected array form of files",
        ],
        gate: "syntax",
        kind: "gate.result",
        tree: candidateTree,
      };
      if (options?.eventStore) {
        emitGateResultEvent(options.eventStore, result, {
          ...options,
          tree: candidateTree,
        });
      } else if (typeof options?.emit === "function") {
        options.emit(result);
      }
      return result;
    }

    if (
      candidate.tree !== undefined &&
      candidate.tree !== null &&
      typeof candidate.tree !== "string"
    ) {
      const result: GateResult = {
        ok: false,
        files: [],
        reasons: [
          "invalid candidate.tree: expected string tree SHA, Record or Map is not supported; pass files as array of {path, content}",
        ],
        gate: "syntax",
        kind: "gate.result",
        tree: candidateTree,
      };
      if (options?.eventStore) {
        emitGateResultEvent(options.eventStore, result, {
          ...options,
          tree: candidateTree,
        });
      } else if (typeof options?.emit === "function") {
        options.emit(result);
      }
      return result;
    }

    // Requirement H-7 (1): The candidate files input must be an array of objects,
    // each with a string path and a string content. Reject when files is a plain object,
    // a Map, or any other non-array value, and when any entry lacks a string path or a string content.
    if (candidate.files !== undefined) {
      const isValid =
        Array.isArray(candidate.files) &&
        candidate.files.every(
          (item: any) =>
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.path === "string" &&
            typeof item.content === "string"
        );
      if (!isValid) {
        const result: GateResult = {
          ok: false,
          files: [],
          reasons: ["invalid files shape: expected array of {path, content}"],
          gate: "syntax",
          kind: "gate.result",
          tree: candidateTree,
        };
        if (options?.eventStore) {
          emitGateResultEvent(options.eventStore, result, {
            ...options,
            tree: candidateTree,
          });
        } else if (typeof options?.emit === "function") {
          options.emit(result);
        }
        return result;
      }
    }
  }

  const { filesMap, changedFiles, packageJsons } = extractCandidateData(
    candidate,
    head,
    options
  );

  // Requirement F11 (5): Python fails closed
  // The Python gate is an Increment 3 feature (tasks.md task 19). Until it exists,
  // a candidate that changes any .py file fails the gate with the reason PYTHON_GATE_NOT_IN_V1.
  // Put this check in the gate entry path before any JS parsing. Do not add Python parsing.
  const changedPythonFiles = changedFiles.filter(isPythonFile);
  if (changedPythonFiles.length > 0) {
    const reasons = ["PYTHON_GATE_NOT_IN_V1"];
    const details: Record<string, { ok: boolean; mode?: ParseMode; error?: string }> = {};
    for (const f of changedPythonFiles) {
      details[normalizeFilePath(f)] = { ok: false, error: "PYTHON_GATE_NOT_IN_V1" };
    }

    const result: GateResult = {
      ok: false,
      files: changedFiles.filter((f) => isJsOrTsFile(f) || isPythonFile(f)).map(normalizeFilePath),
      reasons,
      gate: "syntax",
      kind: "gate.result",
      details,
      tree: candidateTree,
    };

    if (options?.eventStore) {
      emitGateResultEvent(options.eventStore, result, {
        ...options,
        tree: candidateTree,
      });
    } else if (typeof options?.emit === "function") {
      options.emit({
        kind: "gate.result",
        gate: "syntax",
        ok: result.ok,
        files: result.files,
        reasons: result.reasons,
        tree: candidateTree,
      });
    }

    return result;
  }

  const changedJsTsFiles = changedFiles.filter(isJsOrTsFile).map(normalizeFilePath);

  const reasons: string[] = [];
  const details: Record<
    string,
    { ok: boolean; mode?: ParseMode; error?: string }
  > = {};

  for (const file of changedJsTsFiles) {
    const normFile = normalizeFilePath(file);
    const content = filesMap.get(normFile) ?? filesMap.get(file);

    // Requirement F11 (1): Empty content: a changed JS or TS file whose content is not supplied
    // is a gate failure with ok false. Do not parse an empty string.
    if (
      content === undefined ||
      content === null ||
      (typeof content === "string" && content.trim().length === 0)
    ) {
      const errMsg = "content not supplied";
      reasons.push(`${normFile}: ${errMsg}`);
      details[normFile] = { ok: false, error: errMsg };
      continue;
    }

    // Requirement 9.9: mode given by file's extension and post-change package.json type
    const mode = resolveOriginalParseMode(normFile, packageJsons);

    const parseRes = tryParseJsOrTs(content, normFile, mode);
    if (parseRes.ok) {
      details[normFile] = { ok: true, mode };
    } else {
      const errMsg = parseRes.error.message;
      reasons.push(`${normFile}: ${errMsg}`);
      details[normFile] = { ok: false, mode, error: errMsg };
    }
  }

  // Requirement F11 (3): Empty candidate: a candidate with no changed files passes only when
  // the caller states that the candidate is empty; otherwise it fails.
  const isCallerStatingEmpty = Boolean(
    (typeof candidate === "object" && candidate !== null && (candidate.empty || candidate.isEmpty || candidate.allowEmpty)) ||
    (typeof options === "object" && options !== null && (options.empty || options.isEmpty || options.allowEmpty))
  );

  let ok = reasons.length === 0;
  if (changedFiles.length === 0) {
    if (isCallerStatingEmpty) {
      ok = true;
    } else {
      ok = false;
      reasons.push("candidate has no changed files");
    }
  }

  const result: GateResult = {
    ok,
    files: changedJsTsFiles,
    reasons,
    gate: "syntax",
    kind: "gate.result",
    details,
    tree: candidateTree,
  };

  // Requirement 9.11: Emit gate.result event
  if (options?.eventStore) {
    emitGateResultEvent(options.eventStore, result, {
      ...options,
      tree: candidateTree,
    });
  } else if (typeof options?.emit === "function") {
    options.emit({
      kind: "gate.result",
      gate: "syntax",
      ok: result.ok,
      files: result.files,
      reasons: result.reasons,
      tree: candidateTree,
    });
  }

  return result;
}

/**
 * Convenience aliases for Candidate check
 */
export const candidateGate = checkCandidate;
export const candidateCheck = checkCandidate;
export const grimoireGate = checkCandidate;
export const checkJsSyntax = checkCandidate;

/**
 * Requirement 9.11 helper: Emits gate.result event into an EventStore.
 * Requirement F11 (4): Tree on the event includes candidate tree next to refs, gate, ok, files and reasons.
 */
export function emitGateResultEvent(
  eventStore: {
    append(input: EventInput): EventEnvelope;
    [key: string]: unknown;
  },
  result: GateResult,
  options?: {
    runId?: string;
    actor?: string;
    taskId?: string;
    attempt?: number;
    refs?: EvidenceRef[];
    tree?: unknown;
    candidateTree?: unknown;
    candidate?: CandidateInput | unknown;
    [key: string]: unknown;
  }
): EventEnvelope | null {
  if (!eventStore || typeof eventStore.append !== "function") {
    return null;
  }
  const tree =
    options?.tree ??
    options?.candidateTree ??
    result.tree ??
    (typeof options?.candidate === "object" && options?.candidate !== null
      ? (options.candidate as any).tree ?? (options.candidate as any).treeSha
      : null) ??
    null;

  return eventStore.append({
    runId: options?.runId || "run-gate",
    kind: "gate.result",
    actor: options?.actor || "Grimoire_Gate",
    taskId: options?.taskId ?? null,
    attempt:
      options?.attempt !== undefined && options?.attempt !== null
        ? Number(options.attempt)
        : null,
    data: {
      refs: options?.refs || [],
      gate: "syntax",
      ok: result.ok,
      files: result.files,
      reasons: result.reasons,
      tree,
    },
  });
}

export const emitGateResult = emitGateResultEvent;

/**
 * Primary entry point: gateJs
 * Supports single file with step rollback, options object, and candidate check.
 */
export function gateJs(
  arg1:
    | string
    | GateJsOptions
    | CandidateInput
    | Array<{ path: string; content: string; [key: string]: unknown }>
    | Record<string, string>,
  arg2?: string | PatchStep[] | GateJsOptions,
  arg3?: PatchStep[] | GateJsOptions,
  arg4?: GateJsOptions
): GateResult {
  // Case 1: Positional single-file invocation: gateJs(filePath, originalContent, steps, options)
  if (typeof arg1 === "string") {
    const filePath = arg1;
    const normFile = normalizeFilePath(filePath);
    if (isPythonFile(filePath)) {
      return {
        ok: false,
        file: normFile,
        files: [normFile],
        reasons: ["PYTHON_GATE_NOT_IN_V1"],
        gate: "syntax",
        kind: "gate.result",
        details: {
          [normFile]: { ok: false, error: "PYTHON_GATE_NOT_IN_V1" },
        },
      };
    }

    if (typeof arg2 !== "string") {
      const errMsg = "content is missing";
      const result: GateResult = {
        ok: false,
        file: normFile,
        files: [normFile],
        reasons: [`${normFile}: ${errMsg}`],
        gate: "syntax",
        kind: "gate.result",
        details: {
          [normFile]: { ok: false, error: errMsg },
        },
      };

      const options = (
        typeof arg4 === "object" && arg4 !== null
          ? arg4
          : typeof arg3 === "object" && arg3 !== null && !Array.isArray(arg3)
          ? arg3
          : typeof arg2 === "object" && arg2 !== null && !Array.isArray(arg2)
          ? arg2
          : {}
      ) as GateJsOptions;

      if (options?.eventStore) {
        emitGateResultEvent(options.eventStore, result, options);
      } else if (typeof options?.emit === "function") {
        options.emit(result);
      }

      return result;
    }

    const originalContent = arg2;
    const steps = Array.isArray(arg3) ? arg3 : [];
    const options = (
      typeof arg4 === "object" && arg4 !== null
        ? arg4
        : typeof arg3 === "object" && arg3 !== null && !Array.isArray(arg3)
        ? arg3
        : {}
    ) as GateJsOptions;

    return gateJsSingleFile(filePath, originalContent, steps, options);
  }

  // Case 2: Array invocation: gateJs(filesArray)
  if (Array.isArray(arg1)) {
    return checkCandidate(arg1, arg2 as any);
  }

  // Case 3: Object-based invocation
  if (typeof arg1 === "object" && arg1 !== null) {
    const opts = arg1 as GateJsOptions & CandidateInput;

    const rawFilePath =
      typeof opts.filePath === "string" && opts.filePath.trim().length > 0
        ? opts.filePath
        : typeof opts.file === "string" && opts.file.trim().length > 0
        ? opts.file
        : typeof opts.path === "string" && opts.path.trim().length > 0
        ? opts.path
        : undefined;

    const hasSingleFilePath = rawFilePath !== undefined;

    const hasSingleFileContent =
      opts.originalContent !== undefined ||
      opts.originalSource !== undefined ||
      opts.source !== undefined ||
      opts.content !== undefined;

    // Requirement H-7 (2): When a content field is present but no path field
    // (filePath, file or path) is given, return ok false with reason 'missing path'.
    if (hasSingleFileContent && !hasSingleFilePath) {
      const extraOptions = (
        typeof arg2 === "object" && arg2 !== null && !Array.isArray(arg2)
          ? { ...opts, ...arg2 }
          : opts
      ) as GateJsOptions;

      const result: GateResult = {
        ok: false,
        files: [],
        reasons: ["missing path"],
        gate: "syntax",
        kind: "gate.result",
      };

      if (extraOptions?.eventStore) {
        emitGateResultEvent(extraOptions.eventStore, result, extraOptions);
      } else if (typeof extraOptions?.emit === "function") {
        extraOptions.emit(result);
      }

      return result;
    }

    if (hasSingleFilePath || hasSingleFileContent) {
      const filePath = rawFilePath!;
      const normFile = normalizeFilePath(filePath);
      if (isPythonFile(filePath)) {
        return {
          ok: false,
          file: normFile,
          files: [normFile],
          reasons: ["PYTHON_GATE_NOT_IN_V1"],
          gate: "syntax",
          kind: "gate.result",
          details: {
            [normFile]: { ok: false, error: "PYTHON_GATE_NOT_IN_V1" },
          },
        };
      }

      const rawContent =
        opts.originalContent !== undefined
          ? opts.originalContent
          : opts.originalSource !== undefined
          ? opts.originalSource
          : opts.content !== undefined
          ? opts.content
          : opts.source;

      const extraOptions = (
        typeof arg2 === "object" && arg2 !== null && !Array.isArray(arg2)
          ? { ...opts, ...arg2 }
          : opts
      ) as GateJsOptions;

      if (typeof rawContent !== "string") {
        const errMsg = "content is missing";
        const result: GateResult = {
          ok: false,
          file: normFile,
          files: [normFile],
          reasons: [`${normFile}: ${errMsg}`],
          gate: "syntax",
          kind: "gate.result",
          details: {
            [normFile]: { ok: false, error: errMsg },
          },
        };

        if (extraOptions?.eventStore) {
          emitGateResultEvent(extraOptions.eventStore, result, extraOptions);
        } else if (typeof extraOptions?.emit === "function") {
          extraOptions.emit(result);
        }

        return result;
      }

      const originalContent = rawContent;
      const steps = opts.steps || (Array.isArray(arg2) ? arg2 : []);

      return gateJsSingleFile(filePath, originalContent, steps, extraOptions);
    }

    // Otherwise, treat as candidate check
    return checkCandidate(arg1, arg2 as any);
  }

  // Requirement F11 (2): Unknown arguments: an argument the gate cannot recognise returns ok false, not ok true
  return {
    ok: false,
    files: [],
    reasons: ["unknown argument"],
    gate: "syntax",
    kind: "gate.result",
  };
}

export default gateJs;
