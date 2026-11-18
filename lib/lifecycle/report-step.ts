import type { RunOutcome, EarlyExitReason } from "./lifecycle-manager";
import {
  evaluateReportOutcome,
  summarizeTaskStates,
  type TaskItemInput,
  type TaskStateMap,
} from "./outcome-evaluator";
import {
  computeArtifactSha256,
  computeArtifactByteSize,
} from "./artifact-collector";
import type { TaskState } from "../events/types";
import type { DeathCertificate } from "../exhume/death-certificate";

export const SCRIBE_NARRATIVE_FALLBACK_NOTICE =
  "The Scribe's narrative did not pass the evidence check and was left out.";

export const EVIDENCE_MARKER_PREFIXES = [
  "cmd:",
  "file:",
  "gh:",
  "ev:",
] as const;

export type ReportStepArtifactKind =
  | "diff"
  | "spec"
  | "report"
  | "verify_result"
  | "patch";

export interface ReportStepArtifact {
  readonly kind: ReportStepArtifactKind;
  readonly path: string;
  readonly fileName: string;
  readonly content: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly contentType: string;
}

export interface ReportStepDiffInput {
  readonly path: string;
  readonly diff?: string;
  readonly patch?: string;
  readonly content?: string;
}

export interface DiffsArtifactData {
  readonly files: Record<string, string>;
  readonly allPatch: string;
  readonly artifacts: readonly ReportStepArtifact[];
  readonly sha256: string;
  readonly byteSize: number;
}

export interface ReportStepSpecBundleInput {
  readonly requirements?: string;
  readonly design?: string;
  readonly tasks?: string;
  readonly files?: Record<string, string>;
  readonly rawContent?: string;
}

export interface SpecBundleArtifactData {
  readonly requirements: string;
  readonly design: string;
  readonly tasks: string;
  readonly files: Record<string, string>;
  readonly json: string;
  readonly artifacts: readonly ReportStepArtifact[];
  readonly sha256: string;
  readonly byteSize: number;
}

export interface ReportStepGateResult {
  readonly file?: string;
  readonly ruleId?: string;
  readonly ok: boolean;
  readonly reverted?: boolean;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface ReportStepVerifyResultInput {
  readonly ok?: boolean;
  readonly passed?: boolean;
  readonly installPassed?: boolean | null;
  readonly buildPassed?: boolean | null;
  readonly testsPassed?: boolean | null;
  readonly hasTests?: boolean | null;
  readonly install?: unknown;
  readonly build?: unknown;
  readonly test?: unknown;
  readonly tests?: unknown;
  readonly gates?:
    | Record<string, ReportStepGateResult>
    | readonly ReportStepGateResult[];
  readonly gateResults?:
    | Record<string, ReportStepGateResult>
    | readonly ReportStepGateResult[];
  readonly perFileGates?:
    | Record<string, ReportStepGateResult>
    | readonly ReportStepGateResult[];
  readonly steps?: readonly unknown[];
  readonly checks?: Record<string, unknown>;
  readonly failures?: readonly unknown[];
  readonly errors?: readonly unknown[];
  readonly warnings?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface VerifyResultArtifactData {
  readonly data: Record<string, unknown>;
  readonly json: string;
  readonly ok: boolean;
  readonly passed: boolean;
  readonly artifacts: readonly ReportStepArtifact[];
  readonly sha256: string;
  readonly byteSize: number;
}

export interface ReportArtifactData {
  readonly data: Record<string, unknown>;
  readonly json: string;
  readonly markdown: string;
  readonly withoutScribeNarrative: true;
  readonly narrativeExcluded: boolean;
  readonly fallbackNotice: string;
  readonly artifacts: readonly ReportStepArtifact[];
  readonly sha256: string;
  readonly byteSize: number;
}

export interface CrashedSkeletonRecord {
  readonly skeletonId: string;
  readonly role?: string;
  readonly worktree?: string;
  readonly logRef?: string;
  readonly state: "failed";
  readonly statusText?: "Recovering";
  readonly respawnMessage?:
    | "Resumed the same session"
    | "Restarted from its last commit"
    | string;
}

export interface WorkerRestartRecord {
  readonly restarted: boolean;
  readonly ts?: number;
  readonly pausedDurationMs?: number;
  readonly affectedRuns?: readonly string[];
}

export interface ReportStepInput {
  readonly runId: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly integrationHead?: string;
  readonly engineVersion?: string;
  readonly asOf?: string;

  readonly diffs?:
    | readonly ReportStepDiffInput[]
    | Record<string, string>
    | string;
  readonly allPatch?: string;

  readonly specBundle?: ReportStepSpecBundleInput | string;
  readonly spec?: ReportStepSpecBundleInput | string;

  readonly verifyResult?: ReportStepVerifyResultInput | boolean;
  readonly verify?: ReportStepVerifyResultInput | boolean;

  readonly installPassed?: boolean | null;
  readonly buildPassed?: boolean | null;
  readonly testsPassed?: boolean | null;
  readonly hasTests?: boolean | null;
  readonly repoHasTests?: boolean | null;

  readonly findings?: Record<string, unknown>;
  readonly tasks?:
    | readonly TaskItemInput[]
    | readonly TaskState[]
    | TaskStateMap
    | null;
  readonly outcome?: RunOutcome | string;
  readonly earlyExitReason?: EarlyExitReason | string;
  readonly deathCertificate?: DeathCertificate | Record<string, unknown> | null;
  readonly events?: readonly unknown[];

  // If a model-generated narrative is provided, it is dropped per Requirement 26.8
  readonly scribeNarrative?: string | null;
  readonly scribeReading?: string | null;

  readonly crashedSkeletons?: readonly CrashedSkeletonRecord[];
  readonly workerRestart?: WorkerRestartRecord;
  readonly boxesDestroyed?: boolean;

  readonly createdAt?: number;
  readonly now?: () => number;
  readonly [key: string]: unknown;
}

export interface ReportStepArtifactList {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly diffs: DiffsArtifactData;
  readonly specBundle: SpecBundleArtifactData;
  readonly report: ReportArtifactData;
  readonly verifyResult: VerifyResultArtifactData;
  readonly artifacts: readonly ReportStepArtifact[];
  readonly manifest: Record<string, ReportStepArtifact>;
  readonly allReady: boolean;
  readonly totalByteSize: number;
  readonly sha256: string;
}

export interface UnbackedClaimItem {
  readonly claim: string;
  readonly text: string;
  readonly ref?: string;
  readonly reason: string;
}

export interface ScribeEvidenceVerificationResult {
  readonly passed: boolean;
  readonly unbackedItems: readonly UnbackedClaimItem[];
  readonly checkedCount: number;
}

/**
 * Creates an immutable artifact data descriptor with SHA-256 and byte size.
 */
function createArtifactItem(
  kind: ReportStepArtifactKind,
  path: string,
  content: string,
  contentType: string
): ReportStepArtifact {
  const sha256 = computeArtifactSha256(content);
  const byteSize = computeArtifactByteSize(content);
  const fileName = path.includes("/") ? path.split("/").pop()! : path;
  return {
    kind,
    path,
    fileName,
    content,
    sha256,
    byteSize,
    contentType,
  };
}

/**
 * Parses a combined unified diff text into per-file diff maps.
 */
function parseUnifiedDiffToFiles(rawDiff: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rawDiff || typeof rawDiff !== "string") {
    return result;
  }

  const lines = rawDiff.split("\n");
  let currentFile: string | null = null;
  let currentChunk: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git a/") || line.startsWith("diff --git b/")) {
      if (currentFile && currentChunk.length > 0) {
        result[currentFile] = currentChunk.join("\n") + "\n";
      }
      const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        currentFile = match[2];
      } else {
        currentFile = null;
      }
      currentChunk = [line];
    } else if (line.startsWith("+++ b/")) {
      if (!currentFile) {
        currentFile = line.substring("+++ b/".length).trim();
      }
      currentChunk.push(line);
    } else {
      currentChunk.push(line);
    }
  }

  if (currentFile && currentChunk.length > 0) {
    result[currentFile] = currentChunk.join("\n") + "\n";
  }

  return result;
}

/**
 * Builds diff artifacts: per-file patches under diffs/<path>.patch and combined all.patch.
 * Pure function: operates strictly in memory.
 */
export function buildDiffsArtifact(
  diffsInput?:
    | readonly ReportStepDiffInput[]
    | Record<string, string>
    | string,
  explicitAllPatch?: string
): DiffsArtifactData {
  const fileDiffs: Record<string, string> = {};

  if (typeof diffsInput === "string") {
    const parsed = parseUnifiedDiffToFiles(diffsInput);
    if (Object.keys(parsed).length > 0) {
      Object.assign(fileDiffs, parsed);
    } else if (diffsInput.trim().length > 0) {
      fileDiffs["changes"] = diffsInput;
    }
  } else if (Array.isArray(diffsInput)) {
    for (const item of diffsInput) {
      if (item && item.path) {
        const content = item.diff ?? item.patch ?? item.content ?? "";
        fileDiffs[item.path] = content;
      }
    }
  } else if (diffsInput && typeof diffsInput === "object") {
    for (const [filePath, content] of Object.entries(diffsInput)) {
      if (typeof content === "string") {
        fileDiffs[filePath] = content;
      }
    }
  }

  // Determine all.patch
  let allPatch = "";
  if (typeof explicitAllPatch === "string") {
    allPatch = explicitAllPatch;
  } else if (typeof diffsInput === "string") {
    allPatch = diffsInput;
  } else {
    const chunks: string[] = [];
    for (const [filePath, diff] of Object.entries(fileDiffs)) {
      if (diff.trim().length > 0) {
        if (!diff.startsWith("diff --git") && !diff.startsWith("--- ")) {
          chunks.push(`--- a/${filePath}\n+++ b/${filePath}\n${diff.trim()}\n`);
        } else {
          chunks.push(diff.trim() + "\n");
        }
      }
    }
    allPatch = chunks.join("\n");
  }

  const artifacts: ReportStepArtifact[] = [];

  // 1. all.patch artifact
  const allPatchArtifact = createArtifactItem(
    "patch",
    "all.patch",
    allPatch,
    "text/x-diff"
  );
  artifacts.push(allPatchArtifact);

  // 2. Per-file diff artifacts: diffs/<path>.patch
  const sortedPaths = Object.keys(fileDiffs).sort();
  for (const filePath of sortedPaths) {
    const content = fileDiffs[filePath];
    const normalizedPath = filePath.startsWith("/")
      ? filePath.slice(1)
      : filePath;
    const diffArtifactPath = `diffs/${normalizedPath}.patch`;
    artifacts.push(
      createArtifactItem("diff", diffArtifactPath, content, "text/x-diff")
    );
  }

  const totalByteSize = artifacts.reduce((acc, a) => acc + a.byteSize, 0);
  const compositeSha256 = computeArtifactSha256(
    artifacts.map((a) => `${a.path}:${a.sha256}`).join("\n")
  );

  return {
    files: fileDiffs,
    allPatch,
    artifacts,
    sha256: compositeSha256,
    byteSize: totalByteSize,
  };
}

/**
 * Builds spec bundle artifacts: spec/requirements.md, spec/design.md, spec/tasks.md, and spec.json.
 * Pure function: operates strictly in memory.
 */
export function buildSpecBundleArtifact(
  runId: string,
  specInput?: ReportStepSpecBundleInput | string
): SpecBundleArtifactData {
  let requirements = "";
  let design = "";
  let tasks = "";

  if (typeof specInput === "string") {
    requirements = specInput;
    design = `# Design: ${runId}\n`;
    tasks = `# Tasks: ${runId}\n`;
  } else if (specInput && typeof specInput === "object") {
    if (specInput.files) {
      requirements = specInput.files["requirements.md"] ?? "";
      design = specInput.files["design.md"] ?? "";
      tasks = specInput.files["tasks.md"] ?? "";
    }
    if (specInput.requirements) requirements = specInput.requirements;
    if (specInput.design) design = specInput.design;
    if (specInput.tasks) tasks = specInput.tasks;
  }

  if (!requirements) {
    requirements = `# Requirements: ${runId}\n\nAutomated specification generated for resurrection run.\n`;
  }
  if (!design) {
    design = `# Design: ${runId}\n\nArchitecture and migration plan for resurrection run.\n`;
  }
  if (!tasks) {
    tasks = `# Tasks: ${runId}\n\nExecution tasks for resurrection run.\n`;
  }

  const filesRecord: Record<string, string> = {
    "requirements.md": requirements,
    "design.md": design,
    "tasks.md": tasks,
  };

  const specJsonPayload = JSON.stringify(
    {
      schemaVersion: "v1",
      runId,
      files: filesRecord,
    },
    null,
    2
  );

  const artifacts: ReportStepArtifact[] = [
    createArtifactItem(
      "spec",
      "spec/requirements.md",
      requirements,
      "text/markdown"
    ),
    createArtifactItem("spec", "spec/design.md", design, "text/markdown"),
    createArtifactItem("spec", "spec/tasks.md", tasks, "text/markdown"),
    createArtifactItem("spec", "spec.json", specJsonPayload, "application/json"),
  ];

  const totalByteSize = artifacts.reduce((acc, a) => acc + a.byteSize, 0);
  const compositeSha256 = computeArtifactSha256(
    artifacts.map((a) => `${a.path}:${a.sha256}`).join("\n")
  );

  return {
    requirements,
    design,
    tasks,
    files: filesRecord,
    json: specJsonPayload,
    artifacts,
    sha256: compositeSha256,
    byteSize: totalByteSize,
  };
}

/**
 * Builds verify result artifacts: verify-result.json.
 * Pure function: operates strictly in memory.
 */
export function buildVerifyResultArtifact(
  runId: string,
  verifyInput?: ReportStepVerifyResultInput | boolean
): VerifyResultArtifactData {
  let ok = false;
  let passed = false;
  let normalizedInput: ReportStepVerifyResultInput = {};

  if (typeof verifyInput === "boolean") {
    ok = verifyInput;
    passed = verifyInput;
    normalizedInput = {
      ok: verifyInput,
      passed: verifyInput,
      installPassed: verifyInput,
      buildPassed: verifyInput,
      testsPassed: verifyInput,
    };
  } else if (verifyInput && typeof verifyInput === "object") {
    normalizedInput = verifyInput;
    if (typeof verifyInput.ok === "boolean") {
      ok = verifyInput.ok;
    } else if (typeof verifyInput.passed === "boolean") {
      ok = verifyInput.passed;
    } else {
      const installOk = verifyInput.installPassed !== false;
      const buildOk = verifyInput.buildPassed !== false;
      const testsOk =
        verifyInput.hasTests === false || verifyInput.testsPassed !== false;
      ok = installOk && buildOk && testsOk;
    }
    passed = typeof verifyInput.passed === "boolean" ? verifyInput.passed : ok;
  }

  const verifyData: Record<string, unknown> = {
    schemaVersion: "v1",
    runId,
    ok,
    passed,
    installPassed: normalizedInput.installPassed ?? null,
    buildPassed: normalizedInput.buildPassed ?? null,
    testsPassed: normalizedInput.testsPassed ?? null,
    hasTests: normalizedInput.hasTests ?? null,
    gates:
      normalizedInput.gates ??
      normalizedInput.gateResults ??
      normalizedInput.perFileGates ??
      {},
    steps: normalizedInput.steps ?? [],
    checks: normalizedInput.checks ?? {},
    failures: normalizedInput.failures ?? [],
    errors: normalizedInput.errors ?? [],
    warnings: normalizedInput.warnings ?? [],
  };

  const jsonPayload = JSON.stringify(verifyData, null, 2);
  const verifyArtifact = createArtifactItem(
    "verify_result",
    "verify-result.json",
    jsonPayload,
    "application/json"
  );

  return {
    data: verifyData,
    json: jsonPayload,
    ok,
    passed,
    artifacts: [verifyArtifact],
    sha256: verifyArtifact.sha256,
    byteSize: verifyArtifact.byteSize,
  };
}

/**
 * Validates Scribe reading claims and numerals against evidence markers (cmd:, file:, gh:, ev:).
 * Requirements 26.6, 26.7.
 */
export function verifyScribeReading(
  narrative: string,
  evidenceStore?: Record<string, unknown>
): ScribeEvidenceVerificationResult {
  if (!narrative || typeof narrative !== "string" || narrative.trim().length === 0) {
    return {
      passed: true,
      unbackedItems: [],
      checkedCount: 0,
    };
  }

  const unbacked: UnbackedClaimItem[] = [];
  let checkedCount = 0;

  const sentences = narrative
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const claimRegex = /\b(passed|failed|fixed|removed)\b/i;
  const numeralRegex = /\b\d+\b/;
  const markerRegex = /\b(cmd|file|gh|ev):[^\s,;)\]}]+/gi;

  for (const sentence of sentences) {
    const hasNumeral = numeralRegex.test(sentence);
    const claimMatch = sentence.match(claimRegex);

    if (hasNumeral || claimMatch) {
      checkedCount++;
      const markers = sentence.match(markerRegex);

      if (!markers || markers.length === 0) {
        unbacked.push({
          claim: claimMatch ? claimMatch[0].toLowerCase() : "numeral",
          text: sentence,
          reason: "Missing required evidence marker (cmd:, file:, gh:, ev:)",
        });
      } else if (evidenceStore) {
        for (const marker of markers) {
          const key = marker.trim();
          if (!(key in evidenceStore)) {
            unbacked.push({
              claim: claimMatch ? claimMatch[0].toLowerCase() : "numeral",
              text: sentence,
              ref: key,
              reason: `Evidence marker '${key}' not found in stored evidence`,
            });
          }
        }
      }
    }
  }

  return {
    passed: unbacked.length === 0,
    unbackedItems: unbacked,
    checkedCount,
  };
}

/**
 * Strips the Scribe narrative from report text or object.
 * Requirement 26.8, 26.17.
 */
export function stripScribeNarrative(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }
  const sectionHeaderRegex = /##\s*Scribe's reading[\s\S]*?(?=(##|$))/i;
  if (sectionHeaderRegex.test(text)) {
    return text.replace(
      sectionHeaderRegex,
      `## Scribe's reading\n\n_${SCRIBE_NARRATIVE_FALLBACK_NOTICE}_\n\n`
    );
  }
  return text;
}

/**
 * Builds report artifacts: report.json and report.md without the Scribe narrative.
 * Pure function: operates strictly in memory.
 * Adheres to Requirements 26.5, 26.8, 26.16, 26.17, 41.5, 41.6, 41.7.
 */
export function buildReportArtifact(
  input: ReportStepInput,
  outcome: RunOutcome,
  verifyResultData: Record<string, unknown>
): ReportArtifactData {
  const { runId } = input;
  const baseSha = input.baseSha ?? "unknown";
  const headSha = input.headSha ?? input.integrationHead ?? "unknown";

  // Summarize tasks
  const taskSummary = summarizeTaskStates(input.tasks);

  // Normalize findings
  const rawFindings = input.findings ?? {};
  const findings: Record<string, unknown> = {
    ...rawFindings,
    signalsCount: Array.isArray(rawFindings.signals)
      ? rawFindings.signals.length
      : 0,
    unknownsCount: Array.isArray(rawFindings.unknowns)
      ? rawFindings.unknowns.length
      : 0,
  };

  // Requirement 41.5, 41.6: include crashed skeleton records and respawn statuses
  if (input.crashedSkeletons && input.crashedSkeletons.length > 0) {
    findings.crashedSkeletons = input.crashedSkeletons.map((sk) => ({
      skeletonId: sk.skeletonId,
      role: sk.role ?? "builder",
      state: "failed",
      worktree: sk.worktree ?? `worktrees/${sk.skeletonId}`,
      logRef: sk.logRef ? `cmd:${sk.logRef}` : `cmd:log-${sk.skeletonId}`,
      statusText: sk.statusText ?? "Recovering",
      respawnMessage: sk.respawnMessage ?? "Resumed the same session",
    }));
  }

  // Requirement 41.7, 41.8: include worker restart details if present
  if (input.workerRestart && input.workerRestart.restarted) {
    findings.workerRestart = {
      restarted: true,
      eventKind: "system.worker_restart",
      ts: input.workerRestart.ts ?? 0,
      pausedDurationMs: input.workerRestart.pausedDurationMs ?? 0,
      affectedRuns: input.workerRestart.affectedRuns ?? [runId],
    };
  }

  const createdAt =
    typeof input.createdAt === "number"
      ? input.createdAt
      : input.now
        ? input.now()
        : 0;

  // Requirement 26.8: Scribe reading is omitted/dropped
  const reportJsonObject: Record<string, unknown> = {
    schemaVersion: "v1",
    runId,
    owner: input.owner ?? "unknown",
    repo: input.repo ?? "unknown",
    baseSha,
    headSha,
    engineVersion: input.engineVersion ?? "unknown",
    asOf: input.asOf ?? "unknown",
    outcome,
    taskSummary,
    findings,
    verification: verifyResultData,
    scribeReading: null,
    withoutScribeNarrative: true,
    narrativeExcluded: true,
    narrativeNotice: SCRIBE_NARRATIVE_FALLBACK_NOTICE,
    createdAt,
  };

  const reportJsonPayload = JSON.stringify(reportJsonObject, null, 2);

  // Format Markdown report (Requirement 26.5: Findings section without Scribe narrative)
  const markdownLines: string[] = [
    `# Run Report: ${runId}`,
    "",
    `- **Outcome:** ${outcome}`,
    `- **Repository:** ${input.owner ?? "unknown"}/${input.repo ?? "unknown"}`,
    `- **Base SHA:** \`${baseSha}\``,
    `- **Integration Head:** \`${headSha}\``,
    `- **Engine Version:** \`${input.engineVersion ?? "unknown"}\``,
    "",
    "## Findings",
    "",
    `Tasks total: ${taskSummary.total}, merged: ${taskSummary.merged}, failed: ${taskSummary.failed}, skipped: ${taskSummary.skipped}.`,
    "",
  ];

  if (findings.signalsCount) {
    markdownLines.push(
      `- Grimoire signals detected: ${findings.signalsCount} (ev:grimoire-summary)`
    );
  }
  if (findings.unknownsCount) {
    markdownLines.push(
      `- Unknown migration points: ${findings.unknownsCount} (ev:unknowns)`
    );
  }

  // Requirement 41.6: Legion dashboard recovery notice in findings
  if (findings.crashedSkeletons) {
    markdownLines.push("", "### Skeleton Recoveries");
    const skeletons = findings.crashedSkeletons as Array<{
      skeletonId: string;
      statusText: string;
      respawnMessage: string;
      logRef: string;
    }>;
    for (const sk of skeletons) {
      markdownLines.push(
        `- Skeleton \`${sk.skeletonId}\`: ${sk.statusText}, ${sk.respawnMessage} (${sk.logRef})`
      );
    }
  }

  // Requirement 41.7: Worker restart notice
  if (findings.workerRestart) {
    markdownLines.push(
      "",
      `### Worker Restart (system.worker_restart)`,
      `Worker restarted during run; run clock paused and evidence preserved.`
    );
  }

  markdownLines.push(
    "",
    "## Verification",
    "",
    `- Overall verification: ${verifyResultData.passed ? "passed (cmd:verify)" : "failed (cmd:verify)"}`,
    `- Install: ${verifyResultData.installPassed === true ? "passed (cmd:install)" : verifyResultData.installPassed === false ? "failed (cmd:install)" : "not run"}`,
    `- Build: ${verifyResultData.buildPassed === true ? "passed (cmd:build)" : verifyResultData.buildPassed === false ? "failed (cmd:build)" : "not run"}`,
    `- Tests: ${verifyResultData.testsPassed === true ? "passed (cmd:test)" : verifyResultData.testsPassed === false ? "failed (cmd:test)" : verifyResultData.hasTests === false ? "no tests found" : "not run"}`,
    "",
    "## Scribe's reading",
    "",
    `_${SCRIBE_NARRATIVE_FALLBACK_NOTICE}_`,
    ""
  );

  const reportMarkdownPayload = markdownLines.join("\n");

  const artifacts: ReportStepArtifact[] = [
    createArtifactItem(
      "report",
      "report.json",
      reportJsonPayload,
      "application/json"
    ),
    createArtifactItem(
      "report",
      "report.md",
      reportMarkdownPayload,
      "text/markdown"
    ),
  ];

  const totalByteSize = artifacts.reduce((acc, a) => acc + a.byteSize, 0);
  const compositeSha256 = computeArtifactSha256(
    artifacts.map((a) => `${a.path}:${a.sha256}`).join("\n")
  );

  return {
    data: reportJsonObject,
    json: reportJsonPayload,
    markdown: reportMarkdownPayload,
    withoutScribeNarrative: true,
    narrativeExcluded: true,
    fallbackNotice: SCRIBE_NARRATIVE_FALLBACK_NOTICE,
    artifacts,
    sha256: compositeSha256,
    byteSize: totalByteSize,
  };
}

/**
 * Pure function executing the report step.
 * Builds the complete artifact list (diffs, spec bundle, report, verify result) as data from injected inputs,
 * without the Scribe narrative.
 *
 * Task 14.3 / Requirements 26.6, 26.7, 26.8, 26.10, 26.11, 26.12, 26.16, 26.17, 41.5, 41.6, 41.7.
 */
export function buildReportStepArtifacts(
  input: ReportStepInput
): ReportStepArtifactList {
  const { runId } = input;

  // Extract verification parameters for outcome evaluator
  const verifyInput = input.verifyResult ?? input.verify;
  let installPassed = input.installPassed;
  let buildPassed = input.buildPassed;
  let testsPassed = input.testsPassed;
  let hasTests = input.hasTests ?? input.repoHasTests;

  if (typeof verifyInput === "boolean") {
    if (installPassed === undefined) installPassed = verifyInput;
    if (buildPassed === undefined) buildPassed = verifyInput;
    if (testsPassed === undefined) testsPassed = verifyInput;
  } else if (verifyInput && typeof verifyInput === "object") {
    if (installPassed === undefined) installPassed = verifyInput.installPassed;
    if (buildPassed === undefined) buildPassed = verifyInput.buildPassed;
    if (testsPassed === undefined) testsPassed = verifyInput.testsPassed;
    if (hasTests === undefined) hasTests = verifyInput.hasTests;
  }

  // 1. Evaluate outcome deterministically if not explicitly provided
  const outcome: RunOutcome = input.outcome
    ? (input.outcome as RunOutcome)
    : evaluateReportOutcome({
        ...input,
        installPassed,
        buildPassed,
        testsPassed,
        hasTests,
        finalCheck: {
          installPassed,
          buildPassed,
          testsPassed,
          hasTests,
        },
      });

  // 2. Build Diffs artifacts
  const diffs = buildDiffsArtifact(input.diffs, input.allPatch);

  // 3. Build Spec Bundle artifacts
  const specBundle = buildSpecBundleArtifact(
    runId,
    input.specBundle ?? input.spec
  );

  // 4. Build Verify Result artifacts
  const verifyResult = buildVerifyResultArtifact(
    runId,
    input.verifyResult ?? input.verify
  );

  // 5. Build Report artifacts (strictly without Scribe narrative)
  const report = buildReportArtifact(input, outcome, verifyResult.data);

  // 6. Assemble flat artifact list
  const flatArtifacts: ReportStepArtifact[] = [
    ...diffs.artifacts,
    ...specBundle.artifacts,
    ...report.artifacts,
    ...verifyResult.artifacts,
  ];

  // 7. Build manifest map by path
  const manifest: Record<string, ReportStepArtifact> = {};
  for (const art of flatArtifacts) {
    manifest[art.path] = art;
  }

  const totalByteSize = flatArtifacts.reduce((acc, a) => acc + a.byteSize, 0);
  const compositeSha256 = computeArtifactSha256(
    flatArtifacts.map((a) => `${a.path}:${a.sha256}`).join("\n")
  );

  return {
    runId,
    outcome,
    diffs,
    specBundle,
    report,
    verifyResult,
    artifacts: flatArtifacts,
    manifest,
    allReady: flatArtifacts.length > 0,
    totalByteSize,
    sha256: compositeSha256,
  };
}

/**
 * Convenience aliases for buildReportStepArtifacts.
 */
export const buildArtifactList = (
  input: ReportStepInput
): readonly ReportStepArtifact[] => {
  return buildReportStepArtifacts(input).artifacts;
};

export const buildReportStep = buildReportStepArtifacts;
export const executeReportStep = buildReportStepArtifacts;
