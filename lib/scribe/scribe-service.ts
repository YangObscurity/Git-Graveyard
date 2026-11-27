// Task 23.1 / 23.2: Scribe service that renders Findings deterministically and
// verifies the Scribe reading with citations.
// Requirements: 26.5, 26.6, 26.7, 26.8, 26.16, 26.17, 41.1, 41.3.

import { RunStore, type RunRecord, type RunOutcome, type RunPhase } from "../runs/run-store";
import { EventStore, type EventEnvelope } from "../events/event-store";
import { type Redactor, type RedactionOptions } from "../security/redactor";
import { SCRIBE_NARRATIVE_FALLBACK_NOTICE } from "../lifecycle/report-step";
import type { FinalCheckStatus } from "../lifecycle/outcome-evaluator";
import {
  type EvidenceCommandResult,
  type InstallComparison,
  type InstallErrorLike,
  type ReportCheckResult,
  type UnbackedClaimItem,
  assignRunOutcomeWithInstallComparison,
  buildEvidenceIndex,
  runReportCheckWithRetry,
} from "./report-check";

export type { ReportCheckResult, InstallComparison };
export { SCRIBE_NARRATIVE_FALLBACK_NOTICE };

/**
 * Defaults aligned with lib/agents/templates/scribe.md.
 */
export const SCRIBE_TEMPLATE_DEFAULTS = {
  modelTier: "Claude Haiku 5.5",
  policyPreset: "edit-workspace",
  tools: ["read", "write", "report_task_result", "ack_message"],
  deniedCapabilities: ["shell", "web", "subagent"],
} as const;

export const SCRIBE_PHASE_ORDER: readonly RunPhase[] = [
  "queued",
  "exhume",
  "plan",
  "pact_review",
  "legion",
  "final_check",
  "report",
  "done",
];

export class ScribeServiceError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "ScribeServiceError";
    this.reason = reason;
  }
}

export interface ScribeRunnerContext {
  readonly runId: string;
  readonly run: RunRecord;
  readonly events: readonly EventEnvelope[];
  readonly findingsMarkdown: string;
  readonly unbackedClaims?: readonly UnbackedClaimItem[];
}

export type ScribeRunner = (
  context: ScribeRunnerContext
) => string | null | Promise<string | null>;

export interface ScribeServiceDeps {
  readonly runStore: RunStore;
  readonly eventStore: EventStore;
  readonly redactor?: Redactor;
  readonly scribeRunner?: ScribeRunner;
  readonly retryScribeRunner?: ScribeRunner;
  readonly redactionOptions?: RedactionOptions;
  readonly markers?: readonly string[];
  readonly now?: () => number;
}

export interface ScribeServiceInput {
  readonly runId: string;
  readonly actor?: string;
  readonly finalCheck?: FinalCheckStatus | null;
  readonly baselineInstallError?: InstallErrorLike;
  readonly newInstallError?: InstallErrorLike;
  readonly files?: readonly string[];
  readonly githubRefs?: readonly string[];
  readonly commands?: readonly EvidenceCommandResult[];
  readonly taskStates?: readonly { id: string; state: string }[];
}

export interface ScribeServiceResult {
  readonly runId: string;
  readonly findingsMarkdown: string;
  readonly scribeReading: string;
  readonly narrativeDropped: boolean;
  readonly fallbackNotice: string | null;
  readonly reportCheck: ReportCheckResult;
  readonly outcome: RunOutcome;
  readonly installComparison: InstallComparison;
}

/**
 * A run is past final_check once its phase advanced beyond final_check or a
 * final_check.result event has been recorded.
 */
export function isFinalCheckComplete(
  run: RunRecord,
  events: readonly EventEnvelope[]
): boolean {
  const phaseIndex = SCRIBE_PHASE_ORDER.indexOf(run.phase);
  if (phaseIndex > SCRIBE_PHASE_ORDER.indexOf("final_check")) {
    return true;
  }
  return events.some((e) => e.kind === "final_check.result");
}

export interface DerivedTaskState {
  readonly id: string;
  readonly state: string;
  readonly seq: number;
}

/**
 * Reads the latest task.state event per task id in deterministic order.
 */
export function deriveTaskStates(events: readonly EventEnvelope[]): DerivedTaskState[] {
  const byId = new Map<string, DerivedTaskState>();
  for (const ev of events) {
    if (ev.kind !== "task.state") {
      continue;
    }
    const data = (ev.data ?? {}) as Record<string, unknown>;
    const id = String(data.taskId ?? data.id ?? ev.taskId ?? "");
    if (id.length === 0) {
      continue;
    }
    const state = String(data.state ?? data.status ?? "pending");
    byId.set(id, { id, state, seq: ev.seq });
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Collects the distinct evidence refs carried by the recorded events.
 */
export function collectEvidenceRefs(
  events: readonly EventEnvelope[]
): { ref: string; seq: number }[] {
  const byRef = new Map<string, { ref: string; seq: number }>();
  for (const ev of events) {
    const data = (ev.data ?? {}) as Record<string, unknown>;
    if (!Array.isArray(data.refs)) {
      continue;
    }
    for (const raw of data.refs) {
      const ref = String(raw);
      if (ref.length > 0 && !byRef.has(ref)) {
        byRef.set(ref, { ref, seq: ev.seq });
      }
    }
  }
  return Array.from(byRef.values()).sort((a, b) =>
    a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0
  );
}

/**
 * Renders the Findings markdown section deterministically from RunStore and
 * EventStore records using structured templates. No model output is used here.
 */
export function renderFindingsMarkdown(
  run: RunRecord,
  events: readonly EventEnvelope[]
): string {
  const taskStates = deriveTaskStates(events);
  const evidence = collectEvidenceRefs(events);

  const lines: string[] = [];
  lines.push("## Findings");
  lines.push("");
  lines.push(`- Run: \`${run.runId}\``);
  lines.push(`- Repository: \`${run.url}\``);
  lines.push(`- Commit: \`${run.sha}\``);
  lines.push(`- Phase: \`${run.phase}\``);
  lines.push(`- Recorded outcome: \`${run.outcome ?? "pending"}\``);
  lines.push(`- Recorded events: ${events.length}`);
  lines.push("");
  lines.push("### Tasks");
  lines.push("");
  if (taskStates.length === 0) {
    lines.push("- No task state recorded.");
  } else {
    for (const task of taskStates) {
      lines.push(`- \`${task.id}\`: ${task.state} (ev:${task.seq})`);
    }
  }
  lines.push("");
  lines.push("### Evidence");
  lines.push("");
  if (evidence.length === 0) {
    lines.push("- No evidence references recorded.");
  } else {
    for (const item of evidence) {
      lines.push(`- \`${item.ref}\` (ev:${item.seq})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function coerceFinalCheck(
  source: Record<string, unknown> | null | undefined
): FinalCheckStatus {
  const fc: FinalCheckStatus = {};
  if (!source) {
    return fc;
  }
  if (typeof source.installPassed === "boolean") {
    fc.installPassed = source.installPassed;
  }
  if (typeof source.buildPassed === "boolean") {
    fc.buildPassed = source.buildPassed;
  }
  if (typeof source.testsPassed === "boolean") {
    fc.testsPassed = source.testsPassed;
  }
  if (typeof source.hasTests === "boolean") {
    fc.hasTests = source.hasTests;
  }
  if ("install" in source) {
    fc.install = source.install;
  }
  if ("build" in source) {
    fc.build = source.build;
  }
  if ("test" in source) {
    fc.test = source.test;
  }
  if ("tests" in source) {
    fc.tests = source.tests;
  }
  return fc;
}

/**
 * Extracts final_check verification inputs from the latest final_check.result
 * event, falling back to the run metadata.
 */
export function extractFinalCheck(
  events: readonly EventEnvelope[],
  run: RunRecord
): FinalCheckStatus {
  let source: Record<string, unknown> | null = null;
  for (const ev of events) {
    if (ev.kind === "final_check.result") {
      source = (ev.data ?? {}) as Record<string, unknown>;
    }
  }
  if (!source) {
    const meta = run.metadata as Record<string, unknown> | null;
    const fromMeta = meta?.finalCheck;
    if (fromMeta && typeof fromMeta === "object") {
      source = fromMeta as Record<string, unknown>;
    }
  }
  return coerceFinalCheck(source);
}

/**
 * Default Scribe runner aligned with the Scribe template. It writes a short
 * reading that cites recorded events so it passes the evidence check.
 */
export function defaultScribeRunner(context: ScribeRunnerContext): string {
  const { run, events } = context;
  const lines: string[] = [];
  if (events.length > 0) {
    const lastSeq = events[events.length - 1].seq;
    lines.push(`The run recorded ${events.length} events in total (ev:${lastSeq}).`);
  } else {
    lines.push("The run recorded no events.");
  }
  lines.push(`The run reached the ${run.phase} phase.`);
  return lines.join(" ");
}

/**
 * ScribeService is raised strictly after final_check completes. Findings are
 * rendered deterministically from RunStore and EventStore; the injectable Scribe
 * runner drafts only the reading, which is verified with strict citations.
 */
export class ScribeService {
  private readonly deps: ScribeServiceDeps;

  constructor(deps: ScribeServiceDeps) {
    if (!deps || !deps.runStore || !deps.eventStore) {
      throw new ScribeServiceError(
        "invalid_deps",
        "ScribeService requires a runStore and an eventStore"
      );
    }
    this.deps = deps;
  }

  canRun(runId: string): { ok: boolean; phase: RunPhase | null; reason?: string } {
    const run = this.deps.runStore.getRun(runId);
    if (!run) {
      return { ok: false, phase: null, reason: "run_not_found" };
    }
    const events = this.deps.eventStore.getEvents(runId);
    if (!isFinalCheckComplete(run, events)) {
      return { ok: false, phase: run.phase, reason: "final_check_incomplete" };
    }
    return { ok: true, phase: run.phase };
  }

  async run(input: ScribeServiceInput): Promise<ScribeServiceResult> {
    const run = this.deps.runStore.getRun(input.runId);
    if (!run) {
      throw new ScribeServiceError(
        "run_not_found",
        `Run "${input.runId}" not found`
      );
    }

    const events = this.deps.eventStore.getEvents(input.runId);
    if (!isFinalCheckComplete(run, events)) {
      throw new ScribeServiceError(
        "final_check_incomplete",
        "ScribeService may only run after final_check completes"
      );
    }

    const findingsMarkdown = renderFindingsMarkdown(run, events);

    const index = buildEvidenceIndex({
      events,
      files: input.files,
      github: input.githubRefs,
      commandResults: input.commands,
      markers: this.deps.markers,
    });

    const runner = this.deps.scribeRunner ?? defaultScribeRunner;
    const retryRunner = this.deps.retryScribeRunner ?? runner;
    const baseContext: ScribeRunnerContext = {
      runId: input.runId,
      run,
      events,
      findingsMarkdown,
    };

    let draft = "";
    try {
      draft = (await runner(baseContext)) ?? "";
    } catch {
      draft = "";
    }

    const checkResult = await runReportCheckWithRetry({
      reading: draft,
      index,
      retry: (unbackedClaims) =>
        retryRunner({ ...baseContext, unbackedClaims }),
      eventStore: this.deps.eventStore,
      runId: input.runId,
      actor: input.actor ?? "ScribeService",
      redactionOptions: this.deps.redactionOptions,
    });

    const finalCheck = input.finalCheck ?? extractFinalCheck(events, run);
    const tasks = input.taskStates ?? deriveTaskStates(events);

    const assignment = assignRunOutcomeWithInstallComparison({
      finalCheck,
      tasks: tasks.map((t) => ({ id: t.id, state: t.state })),
      baselineInstallError: input.baselineInstallError,
      newInstallError: input.newInstallError,
    });

    return {
      runId: input.runId,
      findingsMarkdown,
      scribeReading: checkResult.reading,
      narrativeDropped: checkResult.narrativeDropped,
      fallbackNotice: checkResult.fallbackNotice,
      reportCheck: checkResult.reportCheck,
      outcome: assignment.outcome,
      installComparison: assignment.installComparison,
    };
  }
}

export function createScribeService(deps: ScribeServiceDeps): ScribeService {
  return new ScribeService(deps);
}
