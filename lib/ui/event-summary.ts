/**
 * One-line, plain-English summaries of recorded run events for the Replay screen.
 *
 * Rules (product.md copy rules):
 * - Only fields already present in the event are used. Recorded events are already
 *   redacted; nothing is looked up elsewhere.
 * - Nothing is invented: a missing value is left out or shown as "not reported".
 * - Unknown kinds fall back to "<kind> event from <actor>" and never throw.
 */
import type { EventEnvelope } from "@/lib/events/types";

type EventFields = Readonly<Record<string, unknown>>;
type Summarizer = (data: EventFields, event: EventEnvelope) => string;

const MAX_SUMMARY_LENGTH = 200;
const MAX_TEXT_LENGTH = 160;
const ELLIPSIS = "…";
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

// ---------- value readers (never throw, never coerce) ----------

function isRecord(value: unknown): value is EventFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
}

/** First non-empty line of a string, whitespace collapsed and length capped. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  return line ? clip(line, MAX_TEXT_LENGTH) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((item): item is string => item !== undefined);
}

function firstText(...values: unknown[]): string | undefined {
  return values.map(text).find((item) => item !== undefined);
}

// ---------- formatting ----------

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || ms < 0) return undefined;
  if (ms < MS_PER_SECOND) return `${Math.round(ms)}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  const minutes = Math.floor(ms / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes < 0) return undefined;
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/** "base (a, b)" with the missing parts dropped; just "base" when none remain. */
function withParts(base: string, parts: ReadonlyArray<string | undefined | false>): string {
  const present = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return present.length > 0 ? `${base} (${present.join(", ")})` : base;
}

function labelled(label: string, value: string | undefined, fallback: string): string {
  return value ? `${label}: ${value}` : fallback;
}

function commandOf(data: EventFields): string | undefined {
  const line = firstText(data.commandLine, data.command, data.cmd);
  if (line) return line;
  const argv = Array.isArray(data.argv) ? data.argv : Array.isArray(data.command) ? data.command : [];
  const parts = argv.filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? text(parts.join(" ")) : undefined;
}

function taskIdOf(data: EventFields, event: EventEnvelope): string | undefined {
  return firstText(event.taskId, data.taskId);
}

function taskHead(data: EventFields, event: EventEnvelope): string {
  const id = taskIdOf(data, event);
  return id ? `Task ${id}` : "Task";
}

// ---------- run lifecycle ----------

const summarizeRunPhase: Summarizer = (data) => {
  const phase = firstText(data.phase, data.to);
  if (!phase) return "Phase changed (phase not reported)";
  const previous = firstText(data.previousPhase, data.from);
  const base = previous ? `Phase: ${previous} → ${phase}` : `Phase: ${phase}`;
  const outcome = text(data.outcome);
  return withParts(base, [outcome && `outcome: ${outcome}`]);
};

const summarizeRunQueued: Summarizer = (data) => {
  const position = num(data.queuePosition) ?? num(data.position);
  return withParts("Run queued", [position !== undefined && `position ${position}`]);
};

const summarizeQueuePosition: Summarizer = (data) => {
  const position = num(data.queuePosition) ?? num(data.position);
  return position !== undefined ? `Queue position: ${position}` : "Queue position updated";
};

const summarizeRunClock: Summarizer = (data) => {
  if (data.action === "pause") return "Run clock paused";
  if (data.action === "resume") return "Run clock resumed";
  return "Run clock updated";
};

const summarizeRunDone: Summarizer = (data) => {
  const outcome = text(data.outcome);
  const duration = formatDuration(num(data.durationMs) ?? num(data.totalDurationMs));
  return withParts(outcome ? `Run finished: ${outcome}` : "Run finished", [duration]);
};

// ---------- commands ----------

const summarizeCommandStarted: Summarizer = (data) =>
  `Started: ${commandOf(data) ?? "command not reported"}`;

function commandVerb(data: EventFields): string {
  if (data.timedOut === true) return "timed out";
  if (data.oomKilled === true) return "ran out of memory";
  return text(data.status) ?? "finished";
}

const summarizeCommandResult: Summarizer = (data) => {
  const verb = commandVerb(data);
  const exitCode = num(data.exitCode);
  const exitPart =
    exitCode !== undefined
      ? `exit ${exitCode}`
      : verb === "finished"
      ? "exit code not reported"
      : undefined;
  const duration = formatDuration(num(data.durationMs));
  return withParts(`${commandOf(data) ?? "Command"} ${verb}`, [exitPart, duration]);
};

const summarizeCommandRefused: Summarizer = (data) =>
  withParts(`Refused: ${commandOf(data) ?? "command"}`, [text(data.reason)]);

// ---------- Tomb ----------

const summarizeGrimoireSummary: Summarizer = (data) => {
  const summary = text(data.summary);
  if (summary) return summary;
  const count = num(data.signalsCount);
  if (count !== undefined) return `Grimoire found ${count} ${plural(count, "signal")}`;
  return "Grimoire summary recorded";
};

const summarizeGrimoireSignal: Summarizer = (data) =>
  labelled("Grimoire signal", firstText(data.summary, data.message, data.ruleId), "Grimoire signal recorded");

const summarizeCertificate: Summarizer = (data) => {
  const healthy = bool(data.healthy);
  if (healthy === true) return "Death Certificate issued: baseline healthy";
  if (healthy === false) {
    const classes = textList(data.failureClasses);
    return withParts("Death Certificate issued: baseline not healthy", [classes.join(", ")]);
  }
  return "Death Certificate issued";
};

// ---------- Pact ----------

function pactLabel(data: EventFields): string {
  const version = num(data.pactVersion) ?? num(data.version);
  return version !== undefined ? `Pact v${version}` : "Pact";
}

const summarizePactDrafted: Summarizer = (data) => {
  const base = `${pactLabel(data)} drafted`;
  if (!Array.isArray(data.tasks)) return base;
  const count = data.tasks.length;
  return `${base} with ${count} ${plural(count, "task")}`;
};

const summarizePactApproved: Summarizer = (data) => {
  const tasks = textList(data.approvedTaskIds);
  return withParts(`${pactLabel(data)} approved`, [tasks.length > 0 && `tasks: ${tasks.join(", ")}`]);
};

// ---------- Legion: tasks, approvals, asks, messages ----------

const summarizeTaskState: Summarizer = (data, event) => {
  const head = taskHead(data, event);
  const state = firstText(data.state, data.status);
  if (!state) return head === "Task" ? "Task state changed" : `${head} state changed`;
  const previous = text(data.previousState);
  const base = withParts(`${head}: ${previous ? `${previous} → ${state}` : state}`, [text(data.reason)]);
  const summary = text(data.summary);
  return summary ? `${base} — ${summary}` : base;
};

const summarizeTaskMerged: Summarizer = (data, event) => {
  const head = taskHead(data, event);
  const result = isRecord(data.mergeResult) ? data.mergeResult : {};
  if (result.ok === false || result.merged === false) return `${head} not merged`;
  const branch = text(result.branch);
  return branch ? `${head} merged into ${branch}` : `${head} merged`;
};

const summarizeApprovalRequested: Summarizer = (data) =>
  labelled("Approval requested", commandOf(data), "Approval requested");

const summarizeApprovalResolved: Summarizer = (data) => {
  const decision = text(data.decision) ?? "resolved";
  const id = text(data.approvalId);
  return id ? `Approval ${id}: ${decision}` : `Approval ${decision}`;
};

const summarizeAskRaised: Summarizer = (data) =>
  labelled("Question", firstText(data.question, data.text, data.prompt), "Question asked");

const summarizeAskAnswered: Summarizer = (data) =>
  labelled("Answer", text(data.answer), "Question answered");

function messageSummarizer(label: string, fallback: string): Summarizer {
  return (data) => labelled(label, firstText(data.summary, data.text, data.message), fallback);
}

const summarizeNecromancerDecision: Summarizer = (data) => {
  const decision = firstText(data.decision, data.text, data.action);
  if (!decision) return "Necromancer decision recorded";
  return withParts(`Necromancer decision: ${decision}`, [text(data.reason)]);
};

// ---------- Legion: Skeletons ----------

const summarizeSkeletonRaised: Summarizer = (data) => {
  const role = firstText(data.role, data.agent);
  const model = text(data.modelId);
  return withParts(role ? `Skeleton raised: ${role}` : "Skeleton raised", [model && `model ${model}`]);
};

const summarizeSkeletonUsage: Summarizer = (data) => {
  const credits = num(data.credits);
  return credits !== undefined
    ? `Usage reported: ${credits} ${plural(credits, "credit")}`
    : "Usage reported";
};

function toolOf(data: EventFields): string | undefined {
  return firstText(data.tool, data.name, data.toolName);
}

// ---------- checks and results ----------

const summarizeGateResult: Summarizer = (data, event) => {
  const ok = bool(data.ok);
  const id = taskIdOf(data, event);
  if (ok === undefined) return withParts("Gate check finished", [id]);
  const base = withParts(`Gate check ${ok ? "passed" : "failed"}`, [id]);
  const reasons = textList(data.reasons);
  return !ok && reasons.length > 0 ? `${base}: ${reasons.join(", ")}` : base;
};

const summarizeVerdict: Summarizer = (data, event) => {
  const verdict = text(data.verdict);
  return verdict ? withParts(`Verdict: ${verdict}`, [taskIdOf(data, event)]) : "Verdict recorded";
};

function checkPart(name: string, value: unknown): string | undefined {
  const passed = bool(value);
  return passed === undefined ? undefined : `${name} ${passed ? "passed" : "failed"}`;
}

const summarizeFinalCheck: Summarizer = (data) => {
  const passed = bool(data.passed);
  const base =
    passed === undefined ? "Final check finished" : `Final check ${passed ? "passed" : "failed"}`;
  return withParts(base, [
    checkPart("install", data.installPassed),
    checkPart("build", data.buildPassed),
    checkPart("tests", data.testsPassed),
    data.hasTests === false && "no tests found",
  ]);
};

const summarizeArtifactReady: Summarizer = (data) => {
  const kind = text(data.kind);
  const size = formatBytes(num(data.byteSize));
  return withParts(kind ? `Artifact ready: ${kind}` : "Artifact ready", [size]);
};

// ---------- admin ----------

const summarizeAdminPublish: Summarizer = (data) => {
  const outcome = text(data.outcome);
  const base = data.published === false ? "Run unpublished" : "Run published";
  return withParts(base, [outcome && `outcome: ${outcome}`]);
};

function fixed(summary: string): Summarizer {
  return () => summary;
}

function withReason(base: string, ...fields: string[]): Summarizer {
  return (data) => withParts(base, [firstText(...fields.map((field) => data[field]))]);
}

const SUMMARIZERS: ReadonlyMap<string, Summarizer> = new Map<string, Summarizer>([
  ["run.queued", summarizeRunQueued],
  ["run.queue_position", summarizeQueuePosition],
  ["run.started", fixed("Run started")],
  ["run.phase", summarizeRunPhase],
  ["run.clock", summarizeRunClock],
  ["run.done", summarizeRunDone],
  ["command.started", summarizeCommandStarted],
  ["command.result", summarizeCommandResult],
  ["command.refused", summarizeCommandRefused],
  ["grimoire.summary", summarizeGrimoireSummary],
  ["grimoire.signal", summarizeGrimoireSignal],
  ["exhume.certificate", summarizeCertificate],
  ["pact.drafted", summarizePactDrafted],
  ["pact.revision", (data) => `${pactLabel(data)} revised`],
  ["pact.edited", (data) => `${pactLabel(data)} edited`],
  ["pact.approved", summarizePactApproved],
  ["task.state", summarizeTaskState],
  ["task.merged", summarizeTaskMerged],
  ["approval.requested", summarizeApprovalRequested],
  ["approval.resolved", summarizeApprovalResolved],
  ["ask.raised", summarizeAskRaised],
  ["ask.answered", summarizeAskAnswered],
  ["message.sent", messageSummarizer("Message sent", "Message sent")],
  ["message.delivered", messageSummarizer("Message delivered", "Message delivered")],
  ["message.acked", messageSummarizer("Message acknowledged", "Message acknowledged")],
  ["progress.report", messageSummarizer("Progress", "Progress reported")],
  ["necromancer.decision", summarizeNecromancerDecision],
  ["skeleton.raised", summarizeSkeletonRaised],
  ["skeleton.state", (data) => labelled("Skeleton state", firstText(data.state, data.status), "Skeleton state changed")],
  ["skeleton.tool_call", (data) => labelled("Tool call", toolOf(data), "Tool call")],
  ["skeleton.tool_result", (data) => labelled("Tool result", toolOf(data), "Tool result received")],
  ["skeleton.log", (data) => labelled("Log", firstText(data.text, data.message, data.content), "Log line recorded")],
  ["skeleton.usage", summarizeSkeletonUsage],
  ["skeleton.failed", withReason("Skeleton failed", "reason", "error")],
  ["skeleton.interrupted", fixed("Tool call interrupted by user")],
  ["skeleton.reraised", fixed("Skeleton re-raised by user")],
  ["skeleton.laid_to_rest", fixed("Skeleton laid to rest by user")],
  ["skeleton.instruction", (data) => labelled("Instruction sent", text(data.instruction), "Instruction sent")],
  ["warden.focus_added", (data) => labelled("Review focus added", text(data.focus), "Review focus added")],
  ["gate.result", summarizeGateResult],
  ["verdict", summarizeVerdict],
  ["final_check.result", summarizeFinalCheck],
  ["artifact.ready", summarizeArtifactReady],
  ["system.worker_restart", withReason("Worker restarted", "reason")],
  ["admin.kill", withReason("Run stopped by admin", "reason")],
  ["admin.redaction", fixed("Redacted by the owner")],
  ["admin.publish", summarizeAdminPublish],
]);

function fallbackSummary(event: EventEnvelope): string {
  const kind = text(event.kind);
  const actor = text(event.actor);
  if (kind && actor) return `${kind} event from ${actor}`;
  if (kind) return `${kind} event`;
  return actor ? `Event from ${actor}` : "Event";
}

/** A single plain-English line describing one recorded event. Pure; never throws. */
export function summarizeEvent(event: EventEnvelope): string {
  const data: EventFields = isRecord(event.data) ? event.data : {};
  const summarizer = typeof event.kind === "string" ? SUMMARIZERS.get(event.kind) : undefined;
  const summary = summarizer ? summarizer(data, event) : fallbackSummary(event);
  return clip(summary.replace(/\s+/g, " ").trim(), MAX_SUMMARY_LENGTH) || fallbackSummary(event);
}
