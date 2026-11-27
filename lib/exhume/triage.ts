/**
 * Exhume triage classification, Grimoire base analysis, and Death Certificate storage.
 * Requirements: 11.11, 11.12, 11.13, 11.15.
 * Task: 8.4.
 *
 * Implements:
 * 1. Grimoire base analysis on base tree emitting grimoire.signal and grimoire.summary events.
 * 2. Parsing harness command logs to classify baseline failure classes.
 * 3. Exhumer triage session interface targeting Claude Haiku 5.5 to synthesize log findings
 *    into the Death Certificate data structure in death-certificate.ts.
 * 4. Death Certificate persistence emitting exhume.certificate event.
 * 5. Early completion support setting outcome to healthy_already when install, build,
 *    and tests pass and user stops.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CLAUDE_HAIKU_5_5_MODEL_ID,
  MODEL_TIER_HAIKU,
  ROLE_DEFAULT_MODELS,
  isAllowedModelId,
  type AllowedModelId,
  type ModelTier,
  type SkeletonRole,
} from "../agents/model-allowlist";
import type { EventInput } from "../events/event-store";
import type { RunOutcome } from "../runs/run-store";
import {
  isApprovedSourceOrManifest,
} from "../grimoire/detect";
import {
  detectPythonSignals,
  detectSignals,
  type DetectSignalsInputFile,
} from "../grimoire/signals";
import { isPythonFile } from "../grimoire/gate-js";
import type { RuleId, Signal, UnknownRecord } from "../grimoire/types";
import {
  classifyFailures,
  createDeathCertificate,
  extractFailureExcerpt,
  isRepositoryHealthy,
  saveDeathCertificate,
  type BaselineCommandRow,
  type CreateDeathCertificateParams,
  type DeathCertificate,
  type FailureClassification,
  type StepName,
} from "./death-certificate";
import type { EventEmitterLike } from "./exhume-harness";
import { scanForEscapingSymlinks } from "../security/symlink-scanner";
import {
  extractFileContent,
  extractFilePaths,
  normalizeFilePath,
} from "./script-detector";
import {
  NO_TESTS_FOUND_LABEL,
  NO_TESTS_FOUND_RULE_ID,
  type FileListInput,
  type PackageManager,
  type SupportedLanguage,
} from "./types";

/**
 * Standard Exhumer Skeleton role and model tier targeting.
 * Requirement 11.12 / Requirement 15.3.
 */
export const EXHUMER_ROLE = "exhumer" as const;
export const EXHUMER_MODEL_ID = CLAUDE_HAIKU_5_5_MODEL_ID;
export const EXHUMER_MODEL_TIER = MODEL_TIER_HAIKU;
export type ExhumerRole = typeof EXHUMER_ROLE;
export type ExhumerModelId = typeof EXHUMER_MODEL_ID;
export type ExhumerModelTier = typeof EXHUMER_MODEL_TIER;

/**
 * Common directories to ignore during recursive file scanning.
 */
const IGNORED_DIRECTORY_NAMES = new Set<string>([
  ".git",
  "node_modules",
  ".kiro",
  ".agent-ws",
  ".cache",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".tox",
]);

/**
 * Helper to dispatch an event to configured event store, callback, or array.
 */
export async function dispatchTriageEvent(
  event: EventInput,
  options?: {
    eventStore?: EventEmitterLike;
    emitEvent?: (event: EventInput) => void | Promise<void>;
    events?: EventInput[];
  }
): Promise<void> {
  if (options?.events) {
    options.events.push(event);
  }

  if (typeof options?.emitEvent === "function") {
    try {
      await options.emitEvent(event);
    } catch {
      // Event callback error handled gracefully
    }
  }

  if (options?.eventStore) {
    const store = options.eventStore;
    try {
      if (typeof store.append === "function") {
        await store.append(event);
      } else if (typeof store.emit === "function") {
        await store.emit(event);
      }
    } catch {
      // Event store write error handled gracefully
    }
  }
}

/**
 * Recursively scans base tree directory on disk, respecting submodule exclusion
 * and ignoring build/cache directories.
 * Requirement 3.11: scan no file inside a submodule path.
 */
export function scanBaseTreeFiles(
  baseDir: string,
  maxFiles = 1000,
  maxFileSizeBytes = 1024 * 1024
): DetectSignalsInputFile[] {
  const normBase = path.resolve(baseDir);
  if (!fs.existsSync(normBase)) {
    return [];
  }

  const report = scanForEscapingSymlinks(normBase);
  if (!report.clean) {
    throw new Error(
      `Symlink escape detected in treeDir: ${report.reason || "unclean"}`
    );
  }

  // Detect submodule paths from .gitmodules if present
  const submodulePaths = new Set<string>();
  const gitmodulesPath = path.join(normBase, ".gitmodules");
  let gitmodulesStat: fs.Stats | undefined;
  try {
    gitmodulesStat = fs.lstatSync(gitmodulesPath);
  } catch {
    // .gitmodules does not exist
  }

  if (gitmodulesStat) {
    if (gitmodulesStat.isSymbolicLink() || !gitmodulesStat.isFile()) {
      throw new Error(
        `Symlink escape detected: refusing to read escaping or symlinked .gitmodules at ${gitmodulesPath}`
      );
    }
    try {
      const gitmodulesContent = fs.readFileSync(gitmodulesPath, "utf8");
      const pathMatches = gitmodulesContent.matchAll(/path\s*=\s*(.+)/g);
      for (const m of pathMatches) {
        if (m[1]) {
          const subPath = normalizeFilePath(m[1].trim());
          if (subPath) {
            submodulePaths.add(subPath);
          }
        }
      }
    } catch {
      // Ignore gitmodules parse errors
    }
  }

  const collected: DetectSignalsInputFile[] = [];

  function walk(currentDir: string): void {
    if (collected.length >= maxFiles) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (collected.length >= maxFiles) {
        break;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relPath = normalizeFilePath(path.relative(normBase, fullPath));

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        // Submodule check (Requirement 3.11)
        if (submodulePaths.has(relPath)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        // Submodule path prefix check
        let inSubmodule = false;
        for (const sub of submodulePaths) {
          if (relPath === sub || relPath.startsWith(`${sub}/`)) {
            inSubmodule = true;
            break;
          }
        }
        if (inSubmodule) {
          continue;
        }

        // Only scan approved source or manifest files
        if (isApprovedSourceOrManifest(entry.name)) {
          try {
            const stats = fs.statSync(fullPath);
            if (stats.size <= maxFileSizeBytes) {
              const content = fs.readFileSync(fullPath, "utf8");
              const manifestDir = path.dirname(relPath) === "." ? "." : path.dirname(relPath);
              collected.push({
                path: relPath,
                content,
                manifestDir,
              });
            }
          } catch {
            // Unreadable file skipped
          }
        }
      }
    }
  }

  walk(normBase);
  return collected;
}

/**
 * Merges signal lists into a single deterministic, deduplicated list ordered by
 * file, line, column, ruleId, then matched text. Used to combine the synchronous
 * `detectSignals` (non-Python files) and asynchronous `detectPythonSignals`
 * (`.py` files) results in `runGrimoireBaseAnalysis`.
 */
function mergeSignals(...lists: Signal[][]): Signal[] {
  const seen = new Set<string>();
  const merged: Signal[] = [];
  for (const list of lists) {
    for (const signal of list) {
      const key = `${signal.file}:${signal.line}:${signal.column}:${signal.ruleId}:${signal.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(signal);
    }
  }
  merged.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    if (a.matched !== b.matched) return a.matched < b.matched ? -1 : 1;
    return 0;
  });
  return merged;
}

export interface GrimoireBaseAnalysisOptions {
  runId: string;
  treeDir?: string;
  files?: FileListInput;
  eventStore?: EventEmitterLike;
  emitEvent?: (event: EventInput) => void | Promise<void>;
  events?: EventInput[];
  unknowns?: UnknownRecord[];
}

export interface GrimoireBaseAnalysisResult {
  signals: Signal[];
  signalsCount: number;
  rules: RuleId[];
  unknowns: UnknownRecord[];
  eventsEmitted: number;
}

/**
 * Runs Grimoire rules on base tree emitting grimoire.signal and grimoire.summary events.
 * Requirement 11.11: WHEN Exhume runs, THE Necromancer SHALL run the Grimoire on the base tree
 * and emit grimoire.signal and grimoire.summary events.
 */
export async function runGrimoireBaseAnalysis(
  options: GrimoireBaseAnalysisOptions
): Promise<GrimoireBaseAnalysisResult> {
  const runId = options.runId;
  if (options.treeDir && fs.existsSync(options.treeDir)) {
    const report = scanForEscapingSymlinks(options.treeDir);
    if (!report.clean) {
      throw new Error(
        `Symlink escape detected in treeDir: ${report.reason || "unclean"}`
      );
    }
  }

  let inputFiles: DetectSignalsInputFile[] = [];

  if (options.files) {
    if (Array.isArray(options.files)) {
      inputFiles = options.files.map((item) => {
        if (typeof item === "string") {
          return { path: normalizeFilePath(item) };
        }
        return {
          path: normalizeFilePath(item.path),
          content: item.content,
          manifestDir: typeof item.manifestDir === "string" ? item.manifestDir : undefined,
        };
      });
    } else {
      const filesInput = options.files;
      const paths = extractFilePaths(filesInput);
      inputFiles = paths.map((p) => ({
        path: p,
        content: extractFileContent(filesInput, p) ?? undefined,
        manifestDir: path.dirname(p) === "." ? "." : path.dirname(p),
      }));
    }
  } else if (options.treeDir) {
    inputFiles = scanBaseTreeFiles(options.treeDir);
  }

  const unknowns: UnknownRecord[] = options.unknowns ? [...options.unknowns] : [];

  // Split the inputs: `.py` files go through the asynchronous tree-sitter based
  // `detectPythonSignals` (which also loads content from disk when omitted),
  // and every other file goes through the synchronous `detectSignals`.
  const pythonFiles: DetectSignalsInputFile[] = [];
  const otherFiles: DetectSignalsInputFile[] = [];
  for (const file of inputFiles) {
    if (typeof file.path === "string" && isPythonFile(file.path)) {
      pythonFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  }

  const syncResult = detectSignals(otherFiles, { unknowns });
  const asyncResult = await detectPythonSignals(pythonFiles, { unknowns });

  // Merge into one deterministic, deduplicated list. Both producers already
  // sort their own results; re-sorting the union keeps the merged order stable
  // regardless of which path produced a given signal.
  const detectedSignals: Signal[] = mergeSignals(
    Array.from(syncResult),
    Array.from(asyncResult)
  );

  let eventsEmitted = 0;

  // Emit grimoire.signal for each signal found (Requirement 11.11)
  for (const signal of detectedSignals) {
    const signalEvent: EventInput = {
      runId,
      kind: "grimoire.signal",
      actor: "grimoire",
      ts: Date.now(),
      data: {
        ruleId: signal.ruleId,
        file: signal.file,
        line: signal.line,
        column: signal.column,
        matched: signal.matched,
        confidence: signal.confidence,
        manifestDir: signal.manifestDir,
        signal,
        refs: [`file:${signal.file}:${signal.line}`, `signal:${signal.ruleId}`],
      },
    };
    await dispatchTriageEvent(signalEvent, options);
    eventsEmitted++;
  }

  // Deduplicate rule IDs for summary
  const uniqueRules = Array.from(
    new Set(detectedSignals.map((s) => s.ruleId))
  ) as RuleId[];

  // Emit grimoire.summary event (Requirement 11.11)
  const summaryRefs =
    detectedSignals.length > 0
      ? uniqueRules.map((r) => `signal:${r}`)
      : ["grimoire:clean"];

  const summaryEvent: EventInput = {
    runId,
    kind: "grimoire.summary",
    actor: "grimoire",
    ts: Date.now(),
    data: {
      signalsCount: detectedSignals.length,
      signals: detectedSignals,
      rules: uniqueRules,
      refs: summaryRefs,
      summary:
        detectedSignals.length > 0
          ? `Grimoire analysis detected ${detectedSignals.length} signal(s) across rule(s): ${uniqueRules.join(", ")}`
          : "Grimoire analysis detected 0 deprecation signals on base tree",
    },
  };
  await dispatchTriageEvent(summaryEvent, options);
  eventsEmitted++;

  return {
    signals: detectedSignals,
    signalsCount: detectedSignals.length,
    rules: uniqueRules,
    unknowns,
    eventsEmitted,
  };
}

export type LogEntryMap = Record<string, string> | Map<string, string>;

export interface HarnessLogClassificationResult {
  failureClasses: string[];
  failures: FailureClassification[];
  rows: readonly BaselineCommandRow[];
}

/**
 * Parses harness command logs and execution rows to classify baseline failure classes.
 * Task 8.4: parse harness command logs to classify baseline failure classes.
 */
export function parseHarnessLogs(
  rows: readonly BaselineCommandRow[],
  logs?: LogEntryMap
): HarnessLogClassificationResult {
  // Use core classifier first
  const baseResult = classifyFailures(rows);
  const failureClassesSet = new Set<string>(baseResult.failureClasses);
  const failuresList: FailureClassification[] = [...baseResult.failures];

  // Inspect logs by logRef if log map is provided
  if (logs) {
    for (const row of rows) {
      if (!row.logRef) {
        continue;
      }

      let logContent = "";
      if (logs instanceof Map) {
        logContent = logs.get(row.logRef) ?? "";
      } else if (typeof logs === "object" && logs[row.logRef]) {
        logContent = logs[row.logRef];
      }

      if (!logContent) {
        continue;
      }

      const logLower = logContent.toLowerCase();

      // Additional deep log inspection
      if (
        (logLower.includes("syntaxerror") ||
          logLower.includes("invalid syntax") ||
          logLower.includes("unexpected token")) &&
        !failureClassesSet.has("syntax_error")
      ) {
        failureClassesSet.add("syntax_error");
        failuresList.push({
          class: "syntax_error",
          step: row.step,
          message: "Syntax error detected in harness log output",
          excerpt: extractFailureExcerpt(logContent),
          ref: `cmd:${row.logRef}`,
        });
      }

      if (
        (logLower.includes("cannot find module") ||
          logLower.includes("modulenotfounderror") ||
          logLower.includes("no module named") ||
          logLower.includes("importerror") ||
          logLower.includes("err_module_not_found")) &&
        !failureClassesSet.has("missing_dependency")
      ) {
        failureClassesSet.add("missing_dependency");
        failuresList.push({
          class: "missing_dependency",
          step: row.step,
          message: "Missing dependency detected in harness log output",
          excerpt: extractFailureExcerpt(logContent),
          ref: `cmd:${row.logRef}`,
        });
      }

      if (
        (logLower.includes("eresolve") ||
          logLower.includes("conflicting peer dependency") ||
          logLower.includes("peer dep")) &&
        !failureClassesSet.has("peer_dependency_conflict")
      ) {
        failureClassesSet.add("peer_dependency_conflict");
        failuresList.push({
          class: "peer_dependency_conflict",
          step: row.step,
          message: "Peer dependency conflict detected in harness log output",
          excerpt: extractFailureExcerpt(logContent),
          ref: `cmd:${row.logRef}`,
        });
      }

      if (
        (logLower.includes("typeerror") || /ts\d{4}:/i.test(logContent)) &&
        !failureClassesSet.has("type_error")
      ) {
        failureClassesSet.add("type_error");
        failuresList.push({
          class: "type_error",
          step: row.step,
          message: "Type error detected in harness log output",
          excerpt: extractFailureExcerpt(logContent),
          ref: `cmd:${row.logRef}`,
        });
      }

      if (
        (logLower.includes("assertionerror") ||
          logLower.includes("assert ") ||
          logLower.includes("failed asserts")) &&
        !failureClassesSet.has("assertion_error")
      ) {
        failureClassesSet.add("assertion_error");
        failuresList.push({
          class: "assertion_error",
          step: row.step,
          message: "Assertion failure detected in harness log output",
          excerpt: extractFailureExcerpt(logContent),
          ref: `cmd:${row.logRef}`,
        });
      }
    }
  }

  return {
    failureClasses: Array.from(failureClassesSet),
    failures: failuresList,
    rows,
  };
}

export const classifyBaselineLogs = parseHarnessLogs;

export interface ExhumerTriagePromptContext {
  runId: string;
  baseSha: string;
  repoUrl?: string;
  primaryLanguage?: SupportedLanguage | "unknown";
  packageManager?: PackageManager;
  rows: readonly BaselineCommandRow[];
  failureClasses: readonly string[];
  failures: readonly FailureClassification[];
  signals?: readonly Signal[];
  logs?: LogEntryMap;
}

export interface ExhumerTriagePromptPayload {
  role: typeof EXHUMER_ROLE;
  modelId: typeof EXHUMER_MODEL_ID;
  modelTier: typeof EXHUMER_MODEL_TIER;
  prompt: string;
  context: ExhumerTriagePromptContext;
}

/**
 * Builds the structured triage prompt for Claude Haiku 5.5.
 * Requirement 11.12: raise Exhumer triage session on Haiku 5.5 to read logs and report failure classes.
 */
export function buildExhumerTriagePrompt(
  context: ExhumerTriagePromptContext
): ExhumerTriagePromptPayload {
  const tableRows = context.rows.map((r) => {
    const exitCodeStr =
      r.exitCode !== undefined && r.exitCode !== null ? String(r.exitCode) : "-";
    const noteStr = r.reason ?? r.errorExcerpt ?? "-";
    return `| ${r.step} | ${r.command} | ${r.status} | ${exitCodeStr} | ${noteStr} |`;
  });

  const tableText = [
    "| Step | Command | Status | Exit Code | Reason / Excerpt |",
    "|---|---|---|---|---|",
    ...tableRows,
  ].join("\n");

  const failureSummaries = context.failures.map(
    (f, idx) =>
      `${idx + 1}. [${f.class}] Step: ${f.step} - ${f.message}${
        f.excerpt ? `\n   Excerpt: ${f.excerpt}` : ""
      }${f.ref ? ` (${f.ref})` : ""}`
  );

  const signalSummaries = (context.signals ?? []).map(
    (s, idx) =>
      `${idx + 1}. [${s.ruleId}] ${s.file}:${s.line}:${s.column} - matched: "${s.matched}" (${s.confidence} confidence)`
  );

  const prompt = [
    `Role: Exhumer Skeleton triage session`,
    `Assigned Model: ${EXHUMER_MODEL_TIER} (${EXHUMER_MODEL_ID})`,
    `Task: Read baseline execution harness logs and classify failures into the Death Certificate data structure.`,
    ``,
    `Repository Context:`,
    `- Base SHA: ${context.baseSha}`,
    `- Run ID: ${context.runId}`,
    `- Primary Language: ${context.primaryLanguage ?? "unknown"}`,
    `- Package Manager: ${context.packageManager ?? "unknown"}`,
    ``,
    `Baseline Execution Rows:`,
    tableText,
    ``,
    `Detected Failure Classes: ${context.failureClasses.join(", ") || "none"}`,
    failureSummaries.length > 0
      ? `\nFailure Details:\n${failureSummaries.join("\n")}`
      : `\nNo failures observed across baseline commands.`,
    signalSummaries.length > 0
      ? `\nDetected Grimoire Signals:\n${signalSummaries.join("\n")}`
      : `\nNo Grimoire deprecation signals found on base tree.`,
    ``,
    `Please synthesize these findings into the Death Certificate failure classifications and provide a concise summary.`,
  ].join("\n");

  return {
    role: EXHUMER_ROLE,
    modelId: EXHUMER_MODEL_ID,
    modelTier: EXHUMER_MODEL_TIER,
    prompt,
    context,
  };
}

export interface TriageSynthesisOutput {
  failureClasses?: string[];
  failures?: FailureClassification[];
  summary?: string;
}

export type ModelSynthesizerFn = (
  prompt: string,
  context: ExhumerTriagePromptContext
) => Promise<TriageSynthesisOutput | string>;

export interface ExhumerTriageSessionOptions {
  runId: string;
  baseSha: string;
  repoUrl?: string;
  primaryLanguage?: SupportedLanguage | "unknown";
  packageManager?: PackageManager;
  rows: readonly BaselineCommandRow[];
  runtimes?: readonly BaselineCommandRow[];
  install?: BaselineCommandRow;
  retry?: BaselineCommandRow;
  build?: BaselineCommandRow;
  test?: BaselineCommandRow;
  signals?: readonly Signal[];
  logs?: LogEntryMap;
  supervisor?: {
    getVerifiedModel?(): string | null;
    getVerifiedAgent?(): string | null;
    [key: string]: unknown;
  };
  sessionClient?: {
    prompt?(text: string): Promise<unknown>;
    [key: string]: unknown;
  };
  synthesizer?: ModelSynthesizerFn;
  eventStore?: EventEmitterLike;
  emitEvent?: (event: EventInput) => void | Promise<void>;
  events?: EventInput[];
}

export interface ExhumerTriageSessionResult {
  deathCertificate: DeathCertificate;
  failureClasses: string[];
  failures: FailureClassification[];
  summary: string;
  promptPayload: ExhumerTriagePromptPayload;
  modelVerified: boolean;
}

/**
 * Exhumer triage session interface targeting Claude Haiku 5.5 to synthesize log findings
 * into the Death Certificate data structure in lib/exhume/death-certificate.ts.
 * Requirements: 11.12, 15.3.
 * Task: 8.4.
 */
export class ExhumerTriageSession {
  readonly role = EXHUMER_ROLE;
  readonly modelId = EXHUMER_MODEL_ID;
  readonly modelTier = EXHUMER_MODEL_TIER;
  readonly options: ExhumerTriageSessionOptions;

  constructor(options: ExhumerTriageSessionOptions) {
    this.options = { ...options };
  }

  getTargetRole(): SkeletonRole {
    return this.role;
  }

  getTargetModel(): AllowedModelId {
    return this.modelId;
  }

  getTargetTier(): ModelTier {
    return this.modelTier;
  }

  /**
   * Verifies that the supervisor or session targets Claude Haiku 5.5.
   * Requirement 11.12, 15.3, 15.5.
   */
  verifySessionModel(): { ok: boolean; modelId: string | null; error?: string } {
    if (this.options.supervisor && typeof this.options.supervisor.getVerifiedModel === "function") {
      const activeModel = this.options.supervisor.getVerifiedModel();
      if (!activeModel || !isAllowedModelId(activeModel)) {
        return {
          ok: false,
          modelId: activeModel,
          error: `Supervisor model "${activeModel}" is not an allowed model`,
        };
      }
      if (activeModel !== EXHUMER_MODEL_ID) {
        return {
          ok: false,
          modelId: activeModel,
          error: `Supervisor model "${activeModel}" does not match Exhumer assigned tier "${EXHUMER_MODEL_ID}"`,
        };
      }
      return { ok: true, modelId: activeModel };
    }
    return { ok: true, modelId: this.modelId };
  }

  /**
   * Builds the prompt payload for the triage session.
   */
  buildPrompt(): ExhumerTriagePromptPayload {
    const parsed = parseHarnessLogs(this.options.rows, this.options.logs);
    const context: ExhumerTriagePromptContext = {
      runId: this.options.runId,
      baseSha: this.options.baseSha,
      repoUrl: this.options.repoUrl,
      primaryLanguage: this.options.primaryLanguage,
      packageManager: this.options.packageManager,
      rows: this.options.rows,
      failureClasses: parsed.failureClasses,
      failures: parsed.failures,
      signals: this.options.signals,
      logs: this.options.logs,
    };
    return buildExhumerTriagePrompt(context);
  }

  /**
   * Executes the triage session and synthesizes findings into the Death Certificate.
   */
  async runTriageSession(): Promise<ExhumerTriageSessionResult> {
    const modelCheck = this.verifySessionModel();
    if (!modelCheck.ok) {
      throw new Error(
        `Model verification failed for Exhumer triage session: ${modelCheck.error}`
      );
    }

    const parsedLogs = parseHarnessLogs(this.options.rows, this.options.logs);
    const promptPayload = this.buildPrompt();

    let synthesizedClasses = [...parsedLogs.failureClasses];
    let synthesizedFailures = [...parsedLogs.failures];
    let synthesizedSummary = "";

    // 1. Injected model synthesizer if provided
    if (typeof this.options.synthesizer === "function") {
      try {
        const rawRes = await this.options.synthesizer(
          promptPayload.prompt,
          promptPayload.context
        );
        if (typeof rawRes === "string") {
          synthesizedSummary = rawRes;
        } else if (rawRes && typeof rawRes === "object") {
          if (Array.isArray(rawRes.failureClasses)) {
            synthesizedClasses = Array.from(
              new Set([...synthesizedClasses, ...rawRes.failureClasses])
            );
          }
          if (Array.isArray(rawRes.failures)) {
            synthesizedFailures = [...synthesizedFailures, ...rawRes.failures];
          }
          if (typeof rawRes.summary === "string") {
            synthesizedSummary = rawRes.summary;
          }
        }
      } catch (err: unknown) {
        // Fall back gracefully to deterministic parsing
        const msg = err instanceof Error ? err.message : String(err);
        synthesizedSummary = `Synthesizer error: ${msg}. Fallback to deterministic classification.`;
      }
    } else if (
      this.options.sessionClient &&
      typeof this.options.sessionClient.prompt === "function"
    ) {
      try {
        const clientRes = await this.options.sessionClient.prompt(
          promptPayload.prompt
        );
        if (typeof clientRes === "string") {
          synthesizedSummary = clientRes;
        } else if (clientRes && typeof clientRes === "object") {
          const rec = clientRes as Record<string, unknown>;
          if (typeof rec.text === "string") {
            synthesizedSummary = rec.text;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        synthesizedSummary = `Session client error: ${msg}. Fallback to deterministic classification.`;
      }
    }

    // Default summary if none generated
    if (!synthesizedSummary) {
      if (synthesizedClasses.length === 0) {
        synthesizedSummary = "Baseline harness passed all steps. Repository appears healthy.";
      } else {
        synthesizedSummary = `Baseline execution failed with class(es): ${synthesizedClasses.join(", ")}.`;
      }
    }

    // Resolve install, build, and test command rows
    const installRow =
      this.options.install ??
      this.options.rows.find((r) => r.step === "install") ?? {
        step: "install",
        command: "install",
        status: "passed",
      };

    const retryRow =
      this.options.retry ??
      this.options.rows.find((r) => r.step === "retry");

    const buildRow =
      this.options.build ??
      this.options.rows.find((r) => r.step === "build") ?? {
        step: "build",
        command: "build",
        status: "passed",
      };

    const testRow =
      this.options.test ??
      this.options.rows.find((r) => r.step === "test") ?? {
        step: "test",
        command: "test",
        status: "passed",
      };

    const runtimes =
      this.options.runtimes ??
      this.options.rows.filter((r) => r.step === "version");

    // Synthesize into the Death Certificate data structure
    const deathCertParams: CreateDeathCertificateParams = {
      baseSha: this.options.baseSha,
      runId: this.options.runId,
      repoUrl: this.options.repoUrl,
      primaryLanguage: this.options.primaryLanguage,
      packageManager: this.options.packageManager,
      rows: this.options.rows,
      runtimes,
      install: installRow,
      retry: retryRow,
      build: buildRow,
      test: testRow,
      failureClasses: synthesizedClasses,
      failures: synthesizedFailures,
      summary: synthesizedSummary,
    };

    const deathCertificate = createDeathCertificate(deathCertParams);

    return {
      deathCertificate,
      failureClasses: synthesizedClasses,
      failures: synthesizedFailures,
      summary: synthesizedSummary,
      promptPayload,
      modelVerified: modelCheck.ok,
    };
  }
}

/**
 * Functional entry point to run the Exhumer triage session.
 */
export async function runExhumerTriageSession(
  options: ExhumerTriageSessionOptions
): Promise<ExhumerTriageSessionResult> {
  const session = new ExhumerTriageSession(options);
  return session.runTriageSession();
}

export interface PersistDeathCertificateOptions {
  storageDir?: string;
  filePath?: string;
  eventStore?: EventEmitterLike;
  emitEvent?: (event: EventInput) => void | Promise<void>;
  events?: EventInput[];
}

export interface PersistDeathCertificateResult {
  filePath: string;
  sha256: string;
  event: EventInput;
}

/**
 * Persists the Death Certificate to disk and emits exhume.certificate event.
 * Requirement 11.13: WHEN the Death_Certificate is stored,
 * THE Necromancer SHALL emit an exhume.certificate event.
 */
export async function persistDeathCertificate(
  cert: DeathCertificate,
  options?: PersistDeathCertificateOptions
): Promise<PersistDeathCertificateResult> {
  const targetDir =
    options?.storageDir ??
    (cert.runId ? path.resolve("output", cert.runId) : path.resolve("output"));
  const targetPath = options?.filePath ?? path.join(targetDir, "death-certificate.json");

  // Save Death Certificate to disk
  const savedPath = await saveDeathCertificate(cert, targetPath);

  // Requirement 11.13: emit exhume.certificate event
  const certEvent: EventInput = {
    runId: cert.runId ?? "unknown",
    kind: "exhume.certificate",
    actor: "exhumer",
    ts: Date.now(),
    data: {
      baseSha: cert.baseSha,
      healthy: cert.healthy,
      failureClasses: cert.failureClasses,
      sha256: cert.sha256,
      refs: [`cert:${cert.sha256}`],
    },
  };

  await dispatchTriageEvent(certEvent, options);

  return {
    filePath: savedPath,
    sha256: cert.sha256,
    event: certEvent,
  };
}

export interface EarlyCompletionOptions {
  userStop?: boolean;
  userChoice?: string;
  stopHere?: boolean;
  action?: string;
  eventStore?: EventEmitterLike;
  emitEvent?: (event: EventInput) => void | Promise<void>;
  events?: EventInput[];
}

export interface EarlyCompletionResult {
  shouldCompleteEarly: boolean;
  outcome?: "healthy_already";
  reason?: string;
  event?: EventInput;
}

/**
 * Checks if the run qualifies for early completion under Requirement 11.15.
 * Requirement 11.15: WHEN install, build and tests all pass and the user chooses "Stop here",
 * THE Necromancer SHALL end the run with outcome healthy_already.
 */
export function checkEarlyCompletion(
  cert: DeathCertificate,
  options?: EarlyCompletionOptions
): EarlyCompletionResult {
  const isHealthy =
    cert?.healthy === true ||
    Boolean(
      cert?.install &&
        cert?.build &&
        cert?.test &&
        isRepositoryHealthy(cert.install, cert.build, cert.test)
    );

  const userRequestedStop = Boolean(
    options?.userStop === true ||
      options?.stopHere === true ||
      options?.userChoice === "Stop here" ||
      options?.userChoice === "stop_here" ||
      options?.userChoice === "stop" ||
      options?.action === "stop"
  );

  if (isHealthy && userRequestedStop) {
    return {
      shouldCompleteEarly: true,
      outcome: "healthy_already",
      reason: "install, build and tests all pass and user chose Stop here",
    };
  }

  return {
    shouldCompleteEarly: false,
  };
}

/**
 * Handles early completion under Requirement 11.15, emitting terminal run events when applicable.
 */
export async function handleEarlyCompletion(
  cert: DeathCertificate,
  options?: EarlyCompletionOptions
): Promise<EarlyCompletionResult> {
  const check = checkEarlyCompletion(cert, options);
  if (!check.shouldCompleteEarly) {
    return check;
  }

  // Emit run.phase with phase done and outcome healthy_already
  const doneEvent: EventInput = {
    runId: cert.runId ?? "unknown",
    kind: "run.phase",
    actor: "necromancer",
    ts: Date.now(),
    data: {
      phase: "done",
      outcome: "healthy_already",
      reason: check.reason,
      refs: [`cert:${cert.sha256}`],
    },
  };

  await dispatchTriageEvent(doneEvent, options);

  return {
    ...check,
    event: doneEvent,
  };
}

export interface RunTriageOptions
  extends ExhumerTriageSessionOptions,
    PersistDeathCertificateOptions,
    EarlyCompletionOptions {
  treeDir?: string;
  files?: FileListInput;
  enableGrimoire?: boolean;
  saveCertificate?: boolean;
}

export interface TriageResult {
  deathCertificate: DeathCertificate;
  certificatePath?: string;
  signals: Signal[];
  failureClasses: string[];
  failures: FailureClassification[];
  summary: string;
  healthy: boolean;
  earlyCompletion: EarlyCompletionResult;
  outcome?: RunOutcome;
}

/**
 * Comprehensive Exhume triage orchestrator combining:
 * 1. Grimoire base analysis (Requirement 11.11)
 * 2. Log parsing and failure classification (Task 8.4)
 * 3. Exhumer triage session targeting Claude Haiku 5.5 (Requirement 11.12)
 * 4. Death Certificate persistence emitting exhume.certificate (Requirement 11.13)
 * 5. Early completion setting outcome to healthy_already (Requirement 11.15)
 */
export async function runTriage(options: RunTriageOptions): Promise<TriageResult> {
  if (options.treeDir && fs.existsSync(options.treeDir)) {
    const report = scanForEscapingSymlinks(options.treeDir);
    if (!report.clean) {
      throw new Error(
        `Symlink escape detected in treeDir: ${report.reason || "unclean"}`
      );
    }
  }

  // 1. Grimoire base analysis (Requirement 11.11)
  let signals: Signal[] = [];
  if (options.enableGrimoire !== false && (options.treeDir || options.files)) {
    const grimoireRes = await runGrimoireBaseAnalysis({
      runId: options.runId,
      treeDir: options.treeDir,
      files: options.files,
      eventStore: options.eventStore,
      emitEvent: options.emitEvent,
      events: options.events,
    });
    signals = grimoireRes.signals;
  } else if (options.signals) {
    signals = [...options.signals];
  }

  // 2. Exhumer triage session on Claude Haiku 5.5 (Requirement 11.12)
  const sessionRes = await runExhumerTriageSession({
    ...options,
    signals,
  });

  const cert = sessionRes.deathCertificate;

  // 3. Persist Death Certificate and emit exhume.certificate (Requirement 11.13)
  let certificatePath: string | undefined;
  if (options.saveCertificate !== false) {
    const persistRes = await persistDeathCertificate(cert, {
      storageDir: options.storageDir,
      filePath: options.filePath,
      eventStore: options.eventStore,
      emitEvent: options.emitEvent,
      events: options.events,
    });
    certificatePath = persistRes.filePath;
  }

  // 4. Early completion handling for healthy_already (Requirement 11.15)
  const earlyCompletion = await handleEarlyCompletion(cert, {
    userStop: options.userStop,
    userChoice: options.userChoice,
    stopHere: options.stopHere,
    action: options.action,
    eventStore: options.eventStore,
    emitEvent: options.emitEvent,
    events: options.events,
  });

  const outcome: RunOutcome | undefined = earlyCompletion.shouldCompleteEarly
    ? "healthy_already"
    : undefined;

  return {
    deathCertificate: cert,
    certificatePath,
    signals,
    failureClasses: sessionRes.failureClasses,
    failures: sessionRes.failures,
    summary: sessionRes.summary,
    healthy: cert.healthy,
    earlyCompletion,
    outcome,
  };
}
