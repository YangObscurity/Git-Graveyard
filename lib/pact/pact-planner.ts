// Stage 2 Pact Planner: prompt generation, planner session invocation,
// Death Certificate coverage verification, and Pact drafting/revision.
// Requirements: 12.1-12.17, 13.1-13.11, 15.3, 15.5

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CLAUDE_OPUS_5_5_MODEL_ID,
  MODEL_TIER_OPUS,
} from "../agents/model-allowlist";
import type { EventInput, EventStore } from "../events/event-store";
import type { EventEmitterLike } from "../exhume/exhume-harness";
import type { DeathCertificate } from "../exhume/death-certificate";
import type { ExhumerTriageSessionOptions } from "../exhume/triage";
import type { Signal } from "../grimoire/types";
import {
  parsePact,
  type PactTask,
  type PactRole,
  type RuleId,
  type PactParseResult,
  type PactParseError,
} from "./pact-parser";
import { renderPact, type PactInput } from "./pact-renderer";
import {
  PactService,
  type CoverageVerificationResult,
  type DeathCertificateLike,
  type DeathCertificateFailure,
} from "./pact-service";

export type PlannerDeathCertificate =
  | DeathCertificate
  | DeathCertificateLike
  | {
      failures?: readonly (
        | DeathCertificateFailure
        | Record<string, unknown>
      )[];
      certificateHash?: string;
      [key: string]: unknown;
    };

export interface PactPlannerOptions {
  runId: string;
  deathCertificate: PlannerDeathCertificate;
  baseSha?: string;
  repoPath?: string;
  worktreeDir?: string;
  signals?: readonly Signal[] | unknown[];
  feedback?: string;
  revisionNotes?: string;
  previousPact?: string | readonly PactTask[] | PactInput;
  previousVersion?: number;
  pactVersion?: number;
  supervisor?: ExhumerTriageSessionOptions["supervisor"];
  sessionClient?: ExhumerTriageSessionOptions["sessionClient"];
  plannerRunner?: (
    prompt: string,
    context?: unknown
  ) => Promise<string | Record<string, unknown> | PactTask[]>;
  synthesizer?: (
    prompt: string,
    context?: unknown
  ) => Promise<string | Record<string, unknown> | PactTask[]>;
  eventStore?: EventEmitterLike | EventStore;
  emitEvent?: (event: EventInput) => void | Promise<void>;
  events?: EventInput[];
  pactPath?: string;
  writePact?: boolean;
  draftId?: string;
  eventKind?: string;
  enforceNonRemovable?: boolean;
  [key: string]: unknown;
}

export interface PactDraftResult {
  ok: true;
  draftId: string;
  sha256: string;
  markdown: string;
  tasks: PactTask[];
  version: number;
  coverage: CoverageVerificationResult;
  filePath?: string;
  modelVerified?: boolean;
}

export class PactPlannerError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(message: string, code = "PACT_PLANNER_ERROR", details?: unknown) {
    super(message);
    this.name = "PactPlannerError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, PactPlannerError.prototype);
  }
}

export class PactPlannerModelError extends PactPlannerError {
  constructor(message: string) {
    super(message, "PACT_PLANNER_MODEL_ERROR");
    this.name = "PactPlannerModelError";
    Object.setPrototypeOf(this, PactPlannerModelError.prototype);
  }
}

export class PactPlannerGrammarError extends PactPlannerError {
  constructor(message: string, details?: unknown) {
    super(message, "PACT_PLANNER_GRAMMAR_ERROR", details);
    this.name = "PactPlannerGrammarError";
    Object.setPrototypeOf(this, PactPlannerGrammarError.prototype);
  }
}

export class PactPlannerCoverageError extends PactPlannerError {
  readonly coverageResult: CoverageVerificationResult;
  constructor(message: string, coverageResult: CoverageVerificationResult) {
    super(message, "PACT_PLANNER_COVERAGE_ERROR", coverageResult);
    this.name = "PactPlannerCoverageError";
    this.coverageResult = coverageResult;
    Object.setPrototypeOf(this, PactPlannerCoverageError.prototype);
  }
}

/**
 * Verifies DeathCertificate failure coverage via PactService.
 * Maps every failure in deathCertificate to at least one task.
 */
export function verifyDeathCertificateCoverage(
  tasks: PactTask[],
  deathCertificate?: PlannerDeathCertificate | null
): CoverageVerificationResult {
  const dummy = new PactService({
    runStore: {} as any,
    eventStore: {} as any,
  });

  const rawFailures = (deathCertificate?.failures ?? []) as readonly Record<
    string,
    unknown
  >[];
  const normalizedFailures: DeathCertificateFailure[] = rawFailures.map((f) => ({
    ruleId: typeof f.ruleId === "string" ? f.ruleId : undefined,
    id: typeof f.id === "string" ? f.id : undefined,
    file:
      typeof f.file === "string"
        ? f.file
        : typeof f.ref === "string"
          ? f.ref
          : undefined,
    line: typeof f.line === "number" ? f.line : undefined,
    description:
      typeof f.description === "string"
        ? f.description
        : typeof f.message === "string"
          ? f.message
          : undefined,
    message: typeof f.message === "string" ? f.message : undefined,
    stage:
      typeof f.stage === "string"
        ? f.stage
        : typeof f.step === "string"
          ? f.step
          : undefined,
  }));

  const adaptedCert: DeathCertificateLike = {
    ...(deathCertificate as Record<string, unknown>),
    failures: normalizedFailures,
  };

  return dummy.verifyFailureCoverage(tasks, adaptedCert);
}

// Monkey-patch static and instance methods onto PactService
if (!(PactService as any).verifyDeathCertificateCoverage) {
  (PactService as any).verifyDeathCertificateCoverage = verifyDeathCertificateCoverage;
}
if (!(PactService.prototype as any).verifyDeathCertificateCoverage) {
  (PactService.prototype as any).verifyDeathCertificateCoverage = function (
    tasks: PactTask[],
    deathCertificate?: DeathCertificateLike | null
  ) {
    return this.verifyFailureCoverage(tasks, deathCertificate);
  };
}

/**
 * Verifies that the supervisor matches the Planner assigned tier (Claude Opus 5.5).
 */
export function verifyPlannerSupervisor(
  supervisor?: ExhumerTriageSessionOptions["supervisor"]
): { ok: boolean; modelId: string | null; error?: string } {
  if (!supervisor) {
    return { ok: true, modelId: CLAUDE_OPUS_5_5_MODEL_ID };
  }

  if (typeof supervisor.getVerifiedModel === "function") {
    const activeModel = supervisor.getVerifiedModel();
    if (!activeModel) {
      return {
        ok: false,
        modelId: null,
        error: "Supervisor returned null or empty model ID",
      };
    }
    const isOpus =
      activeModel === CLAUDE_OPUS_5_5_MODEL_ID ||
      activeModel === MODEL_TIER_OPUS ||
      activeModel.toLowerCase().includes("opus");
    if (!isOpus) {
      return {
        ok: false,
        modelId: activeModel,
        error: `Supervisor model "${activeModel}" does not match Planner assigned tier "${CLAUDE_OPUS_5_5_MODEL_ID}"`,
      };
    }
  }

  if (typeof supervisor.getVerifiedAgent === "function") {
    const activeAgent = supervisor.getVerifiedAgent();
    if (activeAgent && activeAgent.toLowerCase() !== "planner") {
      return {
        ok: false,
        modelId: null,
        error: `Supervisor agent "${activeAgent}" does not match Planner role "planner"`,
      };
    }
  }

  return { ok: true, modelId: CLAUDE_OPUS_5_5_MODEL_ID };
}

/**
 * Builds the prompt grounded in Death Certificate, repository path, and static analysis signals.
 */
export function buildPlannerPrompt(options: PactPlannerOptions): string {
  const dc = options.deathCertificate;
  const repoPath = options.worktreeDir ?? options.repoPath ?? "(unspecified)";
  const baseSha = options.baseSha ?? (dc as any)?.baseSha ?? "unknown";
  const failureClasses = (dc as any)?.failureClasses ?? [];
  const summary = (dc as any)?.summary ?? "";
  const signals = options.signals ?? [];
  const rawFailures = (dc?.failures ?? []) as readonly Record<string, unknown>[];
  const failureLines =
    rawFailures.length > 0
      ? rawFailures
          .map((f, i) => {
            const rule = f.ruleId ?? "UNKNOWN";
            const file = f.file ?? f.ref;
            const desc = f.description ?? f.message ?? "failure";
            return `  ${i + 1}. [${rule}] ${file ? `in ${file}: ` : ""}${desc}`;
          })
          .join("\n")
      : "  None (baseline passed)";

  const signalLines =
    signals.length > 0
      ? (signals as any[])
          .map(
            (s, i) =>
              `  ${i + 1}. [${s.ruleId ?? "SIGNAL"}] ${s.message ?? JSON.stringify(s)}`
          )
          .join("\n")
      : "  None";

  return `# Role: Planner Skeleton
You are the Planner Skeleton. Your job is to draft the Pact (tasks.md) for Stage 2 (plan -> pact_review).
The repository suffered death and must be resurrected by Bonesetter and Soul-stitcher.

## Workspace Context
- Repository Path: ${repoPath}
- Base SHA: ${baseSha}

## Death Certificate
- Failure Classes: ${Array.isArray(failureClasses) ? failureClasses.join(", ") : "none"}
- Summary: ${summary}
- Failures:
${failureLines}

## Static Analysis Signals
${signalLines}

## Requirements for the Pact (tasks.md)
1. Every failure listed in the Death Certificate must be addressed by at least one task matching its ruleId or file.
   For a failure without a ruleId (shown as [UNKNOWN]), copy the exact reference after "in" into the \`files:\` line of a task that fixes it.
2. Roles must be strictly either "bonesetter" (for dependency/package updates) or "soul-stitcher" (for code/API fixes).
3. Include non-removable requirements:
   - Grimoire syntax/gate task
   - Warden final check task
   - Scribe report task
4. Output must follow standard Pact markdown format:
   - [ ] T1. <Title>
     - role: <bonesetter|soul-stitcher>
     - depends: <T0, ... or empty>
     - files: <path1, path2>
     - accept: <acceptance command e.g. npm test>
     - hard: <yes|no>
     - rules: <M1, M2, ...>
`;
}

/**
 * Builds the follow-up message sent once when the first Pact leaves failures uncovered.
 * It names each uncovered failure by the reference the coverage check matches on.
 */
export function buildCoverageRetryPrompt(
  uncoveredFailures: ReadonlyArray<{
    ruleId?: string;
    file?: string;
    description?: string;
    message?: string;
  }>
): string {
  const lines = uncoveredFailures
    .map((f, i) => {
      const ref = f.ruleId ?? f.file ?? "unknown";
      const text = f.description ?? f.message;
      return `  ${i + 1}. ${ref}${text ? ` (${text})` : ""}`;
    })
    .join("\n");

  return `Your Pact does not cover all Death Certificate failures. Uncovered:
${lines}

Output the complete Pact (tasks.md) again, keeping the existing tasks and adding or extending tasks so every uncovered failure is covered.
Match each failure by its rule in \`rules:\` or by its exact reference in the \`files:\` line of a task.`;
}

/**
 * Builds the revision prompt grounded in Death Certificate, previous Pact, and user feedback.
 */
export function buildPlannerRevisionPrompt(options: PactPlannerOptions): string {
  const basePrompt = buildPlannerPrompt(options);
  const feedback = options.feedback ?? options.revisionNotes ?? "(none)";
  const prevPact =
    typeof options.previousPact === "string"
      ? options.previousPact
      : options.previousPact
        ? renderPact(options.previousPact as any)
        : "(none)";

  return `${basePrompt}

## Revision Request
User Feedback / Revision Notes:
${feedback}

Previous Pact:
\`\`\`markdown
${prevPact}
\`\`\`

Please revise the Pact according to the user feedback while still ensuring all Death Certificate failures and non-removable requirements are covered.
`;
}

/**
 * Extracts and validates Pact tasks from raw output (string, JSON, markdown, or object).
 */
export function extractAndParsePact(raw: unknown): {
  markdown: string;
  tasks: PactTask[];
} {
  let text = "";

  if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.markdown === "string") {
      text = obj.markdown;
    } else if (typeof obj.text === "string") {
      text = obj.text;
    } else if (typeof obj.content === "string") {
      text = obj.content;
    } else if (Array.isArray(obj.tasks) || Array.isArray(raw)) {
      text = renderPact(raw as any);
    } else {
      text = JSON.stringify(raw);
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) || (parsed && Array.isArray(parsed.tasks))) {
        text = renderPact(parsed);
      } else if (parsed && typeof parsed.markdown === "string") {
        text = parsed.markdown;
      }
    } catch {
      // Not JSON, continue with markdown parsing
    }
  }

  // Extract from markdown code fences if present
  const codeBlockMatch = text.match(/```(?:markdown|tasks)?\s*([\s\S]*?)```/);
  const candidateText = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  let parseResult = parsePact(candidateText);
  if (!parseResult.ok && codeBlockMatch) {
    // Fall back to parsing the full text if fenced block extraction didn't parse
    const fullResult = parsePact(text);
    if (fullResult.ok) {
      parseResult = fullResult;
    }
  }

  if (!parseResult.ok) {
    const errMsg = parseResult.errors
      .map((e) => `[line ${e.line}] ${e.message}`)
      .join("; ");
    throw new PactPlannerGrammarError(
      `Planner produced unparseable Pact: ${errMsg}`,
      parseResult.errors
    );
  }

  return {
    markdown: renderPact(parseResult.tasks),
    tasks: parseResult.tasks,
  };
}

/**
 * Pure deterministic synthesizer creating a valid Pact that covers all Death Certificate failures.
 */
export function synthesizeDefaultPact(options: PactPlannerOptions): {
  markdown: string;
  tasks: PactTask[];
} {
  const dc = options.deathCertificate;
  const rawFailures = (dc?.failures ?? []) as readonly Record<string, unknown>[];
  const tasks: PactTask[] = [];
  let taskCounter = 1;

  for (const f of rawFailures) {
    const id = `T${taskCounter++}`;
    const ruleId = (f.ruleId as RuleId) ?? "M1";
    const rawFile =
      (f.file as string | undefined) ?? (f.ref as string | undefined);
    const file = rawFile ?? (ruleId === "M1" ? "package.json" : "index.js");
    const desc =
      (f.description as string | undefined) ??
      (f.message as string | undefined) ??
      `Fix ${ruleId} failure in ${file}`;
    const isBonesetter =
      ruleId === "M1" ||
      file.endsWith("package.json") ||
      file.endsWith("requirements.txt") ||
      file.endsWith("pyproject.toml");
    const role: PactRole = isBonesetter ? "bonesetter" : "soul-stitcher";
    const depends = taskCounter > 2 ? [`T${taskCounter - 2}`] : [];

    tasks.push({
      id,
      title: desc,
      role,
      dependencies: depends,
      depends,
      dependsOn: depends,
      files: [file],
      filesInScope: [file],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      ruleIds: [ruleId],
      rules: [ruleId],
      line: taskCounter,
    });
  }

  if (tasks.length === 0) {
    tasks.push({
      id: "T1",
      title: "Verify baseline healthy repository",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      ruleIds: [],
      rules: [],
      line: 1,
    });
    taskCounter = 2;
  }

  const prevId = tasks[tasks.length - 1].id;
  const gateId = `T${taskCounter++}`;
  tasks.push({
    id: gateId,
    title: "Run Grimoire syntax gate",
    role: "soul-stitcher",
    dependencies: [prevId],
    depends: [prevId],
    dependsOn: [prevId],
    files: ["package.json"],
    filesInScope: ["package.json"],
    acceptanceCommand: "npm test",
    accept: "npm test",
    hard: false,
    hardFlag: false,
    hardRaw: "no",
    ruleIds: [],
    rules: [],
    line: taskCounter,
  });

  const wardenId = `T${taskCounter++}`;
  tasks.push({
    id: wardenId,
    title: "Execute Warden final check",
    role: "soul-stitcher",
    dependencies: [gateId],
    depends: [gateId],
    dependsOn: [gateId],
    files: ["package.json"],
    filesInScope: ["package.json"],
    acceptanceCommand: "npm test",
    accept: "npm test",
    hard: false,
    hardFlag: false,
    hardRaw: "no",
    ruleIds: [],
    rules: [],
    line: taskCounter,
  });

  const scribeId = `T${taskCounter++}`;
  tasks.push({
    id: scribeId,
    title: "Generate Scribe report",
    role: "soul-stitcher",
    dependencies: [wardenId],
    depends: [wardenId],
    dependsOn: [wardenId],
    files: ["spec/report.md"],
    filesInScope: ["spec/report.md"],
    acceptanceCommand: "npm test",
    accept: "npm test",
    hard: false,
    hardFlag: false,
    hardRaw: "no",
    ruleIds: [],
    rules: [],
    line: taskCounter,
  });

  const markdown = renderPact(tasks);
  return { markdown, tasks };
}

async function emitPlannerEvent(
  options: PactPlannerOptions,
  event: EventInput
): Promise<void> {
  if (typeof options.emitEvent === "function") {
    await options.emitEvent(event);
  }
  if (Array.isArray(options.events)) {
    options.events.push(event);
  }
  if (options.eventStore) {
    try {
      if (typeof (options.eventStore as any).append === "function") {
        await (options.eventStore as any).append(event);
      } else if (typeof (options.eventStore as any).emit === "function") {
        await (options.eventStore as any).emit(event);
      }
    } catch {
      // graceful event handling
    }
  }
}

/**
 * Core orchestration logic for generatePactWithPlanner and revisePactWithPlanner.
 */
async function executePlannerWorkflow(
  options: PactPlannerOptions,
  isRevision: boolean
): Promise<PactDraftResult> {
  // 1. Model verification via supervisor if provided (fail-closed)
  const supervisorCheck = verifyPlannerSupervisor(options.supervisor);
  if (!supervisorCheck.ok) {
    throw new PactPlannerModelError(
      `Model verification failed for Planner session: ${supervisorCheck.error}`
    );
  }

  // 2. Build prompt grounded in deathCertificate, repoPath/worktreeDir, signals, feedback
  const prompt = isRevision
    ? buildPlannerRevisionPrompt(options)
    : buildPlannerPrompt(options);

  // 3. Execute runner or synthesize
  let parsedPact: { markdown: string; tasks: PactTask[] };

  if (typeof options.plannerRunner === "function") {
    try {
      const raw = await options.plannerRunner(prompt, {
        deathCertificate: options.deathCertificate,
        repoPath: options.worktreeDir ?? options.repoPath,
        signals: options.signals,
        feedback: options.feedback ?? options.revisionNotes,
        isRevision,
      });
      parsedPact = extractAndParsePact(raw);
    } catch (err) {
      if (err instanceof PactPlannerError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new PactPlannerError(`Planner runner failed: ${msg}`, "PLANNER_RUNNER_FAILED", err);
    }
  } else if (
    options.sessionClient &&
    typeof options.sessionClient.prompt === "function"
  ) {
    try {
      const raw = await options.sessionClient.prompt(prompt);
      parsedPact = extractAndParsePact(raw);

      // One retry: tell the live session what is uncovered. The fail-closed
      // coverage check in step 4 still decides the final outcome.
      const firstCoverage = verifyDeathCertificateCoverage(
        parsedPact.tasks,
        options.deathCertificate
      );
      if (!firstCoverage.ok) {
        const retryRaw = await options.sessionClient.prompt(
          buildCoverageRetryPrompt(firstCoverage.uncoveredFailures)
        );
        parsedPact = extractAndParsePact(retryRaw);
      }
    } catch (err) {
      if (err instanceof PactPlannerError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new PactPlannerError(
        `Session client prompt failed: ${msg}`,
        "SESSION_CLIENT_FAILED",
        err
      );
    }
  } else if (typeof options.synthesizer === "function") {
    try {
      const raw = await options.synthesizer(prompt, {
        deathCertificate: options.deathCertificate,
        repoPath: options.worktreeDir ?? options.repoPath,
        signals: options.signals,
        feedback: options.feedback ?? options.revisionNotes,
        isRevision,
      });
      parsedPact = extractAndParsePact(raw);
    } catch (err) {
      if (err instanceof PactPlannerError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new PactPlannerError(`Synthesizer failed: ${msg}`, "SYNTHESIZER_FAILED", err);
    }
  } else {
    parsedPact = synthesizeDefaultPact(options);
  }

  // 4. Verify DeathCertificate failure coverage via PactService.verifyDeathCertificateCoverage (fail-closed)
  const coverageResult = verifyDeathCertificateCoverage(
    parsedPact.tasks,
    options.deathCertificate
  );
  if (!coverageResult.ok) {
    const uncov = coverageResult.uncoveredFailures
      .map((f) => f.ruleId ?? f.file ?? f.description ?? "unknown")
      .join(", ");
    throw new PactPlannerCoverageError(
      `Pact tasks do not cover all DeathCertificate failures: uncovered [${uncov}]`,
      coverageResult
    );
  }

  // 5. Version, hashes and IDs
  const sha256 = crypto
    .createHash("sha256")
    .update(parsedPact.markdown)
    .digest("hex");

  let version: number;
  if (typeof options.pactVersion === "number") {
    version = options.pactVersion;
  } else if (isRevision) {
    version = (options.previousVersion ?? 1) + 1;
  } else {
    version = 1;
  }

  const draftId =
    options.draftId ??
    `pact-${options.runId}-${isRevision ? `v${version}-` : ""}${sha256.slice(0, 12)}`;

  // 6. Append event (pact.drafted or pact.revised)
  const defaultEventKind = isRevision ? "pact.revised" : "pact.drafted";
  const eventKind = options.eventKind ?? defaultEventKind;

  const event: EventInput = {
    runId: options.runId,
    kind: eventKind,
    actor: "planner",
    ts: Date.now(),
    data: {
      pactVersion: version,
      tasks: parsedPact.tasks,
      markdown: parsedPact.markdown,
      sha256,
      draftId,
      coverage: coverageResult,
      feedback: isRevision ? (options.feedback ?? options.revisionNotes ?? "") : undefined,
      refs: [`pact:${sha256}`],
    },
  };

  await emitPlannerEvent(options, event);

  // 7. Write to file if path requested or available
  let filePath: string | undefined;
  const root = options.worktreeDir ?? options.repoPath;
  const targetPath =
    options.pactPath ?? (root ? path.join(root, "spec", "tasks.md") : undefined);

  if (targetPath && options.writePact !== false) {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, parsedPact.markdown, "utf-8");
      filePath = targetPath;
    } catch (err) {
      if (options.pactPath) {
        throw err;
      }
    }
  }

  return {
    ok: true,
    draftId,
    sha256,
    markdown: parsedPact.markdown,
    tasks: parsedPact.tasks,
    version,
    coverage: coverageResult,
    filePath,
    modelVerified: true,
  };
}

/**
 * Stage 2: Generates the initial draft of the Pact with Planner Skeleton.
 */
export async function generatePactWithPlanner(
  options: PactPlannerOptions
): Promise<PactDraftResult> {
  return executePlannerWorkflow(options, false);
}

/**
 * Stage 2: Revises an existing Pact with Planner Skeleton based on user feedback.
 */
export async function revisePactWithPlanner(
  options: PactPlannerOptions
): Promise<PactDraftResult> {
  return executePlannerWorkflow(options, true);
}
