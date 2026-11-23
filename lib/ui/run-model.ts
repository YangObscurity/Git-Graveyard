// Shared run view-model for the UI.
//
// Every screen that shows a live or recorded run (Tomb exhume panel, Pact,
// Legion, nav) derives its state from the run's event log through this one
// reducer, so the screens cannot disagree about phase, queue position,
// approvals or commands.
//
// The field names read here are the ones the backend writes (see the emitters
// in lib/exhume, lib/lifecycle, lib/gateway, lib/supervisor, lib/orchestrator
// and app/api). Nothing in this module invents a value: a field that no event
// reported stays null or empty.

export interface RunEvent {
  seq: number;
  ts?: number;
  kind: string;
  actor?: string;
  data?: Record<string, unknown> | null;
  skeletonId?: string | null;
  taskId?: string | null;
  attempt?: number | null;
}

export type RunPhaseView =
  | "unknown"
  | "queued"
  | "exhume"
  | "plan"
  | "pact_review"
  | "legion"
  | "final_check"
  | "report"
  | "done";

const KNOWN_PHASES: readonly RunPhaseView[] = [
  "queued",
  "exhume",
  "plan",
  "pact_review",
  "legion",
  "final_check",
  "report",
  "done",
];

export interface RunCommand {
  id: string;
  seq: number;
  step?: string;
  command: string;
  status: "running" | "passed" | "failed" | string;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  errorExcerpt?: string;
  logRef?: string;
  timedOut?: boolean;
  oomKilled?: boolean;
  reason?: string;
  ruleId?: string;
}

export interface RunCertificateMeta {
  baseSha: string | null;
  healthy: boolean;
  failureClasses: string[];
  sha256: string | null;
  /** Event timestamp of the certificate; null if the event carried none. */
  recordedAt: number | null;
}

export interface RunSkeleton {
  skeletonId: string;
  role: string;
  state: string;
  taskIds: string[];
  attempt: number;
  currentToolCall: {
    tool: string;
    toolCallId?: string;
    startedAt: number;
    args?: unknown;
  } | null;
  toolCallsCount: number;
  logs: string[];
  elapsedSeconds: number;
  credits: number | null;
  worktree: string;
  candidateSha256?: string | null;
  verdict?: string | null;
  lastEvent: {
    seq?: number;
    kind?: string;
    ts?: number;
    actor?: string;
    data?: unknown;
  } | null;
}

export interface RunApproval {
  approvalId: string;
  seq: number;
  command: string;
  cwd?: string;
  reason?: string;
  skeletonId?: string;
  expiresAt?: number;
  candidateSha256?: string;
  grimoireSummary?: string;
  status: "pending" | "resolved";
  resolution?: string;
}

export interface RunAsk {
  askId: string;
  seq: number;
  question: string;
  options?: string[];
  skeletonId?: string;
  taskId?: string;
  status: "open" | "answered";
  answer?: string;
}

export interface RunTask {
  taskId: string;
  state: string;
  attempt?: number;
  summary?: string;
}

export interface RunChannelEntry {
  id: string;
  seq: number;
  ts: number;
  kind: string;
  type: "decision" | "ask" | "approval" | "message";
  title?: string;
  text: string;
  actor?: string;
  skeletonId?: string;
  refs?: string[];
  options?: string[];
  answered?: boolean;
  askId?: string;
}

export interface RunArtifact {
  kind: string;
  path: string;
  sha256?: string;
  byteSize?: number;
}

export interface RunView {
  /** Sequence numbers already applied. Makes the reducer idempotent. */
  seen: ReadonlySet<number>;
  lastSeq: number;
  phase: RunPhaseView;
  outcome: string | null;
  outcomeReason: string | null;
  paused: boolean;
  queuePosition: number | null;
  /** Timestamp of the first event that showed the run had left the queue. */
  startedAt: number | null;
  endedAt: number | null;
  commands: RunCommand[];
  certificate: RunCertificateMeta | null;
  pact: { version: number | null; approved: boolean };
  /** Budget ceilings recorded with the approved Pact; null until approved. */
  caps: Record<string, unknown> | null;
  skeletons: RunSkeleton[];
  tasks: RunTask[];
  approvals: RunApproval[];
  asks: RunAsk[];
  channel: RunChannelEntry[];
  toolCalls: number;
  latestToolCall: { tool: string; skeletonId?: string; args?: unknown } | null;
  recovering: boolean;
  error: string | null;
  finalCheck: {
    passed: boolean;
    installPassed?: boolean;
    buildPassed?: boolean;
    testsPassed?: boolean;
    hasTests?: boolean;
  } | null;
  artifacts: RunArtifact[];
}

const MAX_SKELETON_LOG_LINES = 50;

// Written by the skeleton action route when the user steers a Skeleton. They
// update an existing card; they never create one.
const USER_SKELETON_ACTIONS: ReadonlySet<string> = new Set([
  "skeleton.interrupted",
  "skeleton.reraised",
  "skeleton.laid_to_rest",
  "skeleton.instruction",
  "warden.focus_added",
]);

export function createRunView(): RunView {
  return {
    seen: new Set<number>(),
    lastSeq: 0,
    phase: "unknown",
    outcome: null,
    outcomeReason: null,
    paused: false,
    queuePosition: null,
    startedAt: null,
    endedAt: null,
    commands: [],
    certificate: null,
    pact: { version: null, approved: false },
    caps: null,
    skeletons: [],
    tasks: [],
    approvals: [],
    asks: [],
    channel: [],
    toolCalls: 0,
    latestToolCall: null,
    recovering: false,
    error: null,
    finalCheck: null,
    artifacts: [],
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

function asPhase(value: unknown): RunPhaseView | undefined {
  return typeof value === "string" &&
    (KNOWN_PHASES as readonly string[]).includes(value)
    ? (value as RunPhaseView)
    : undefined;
}

function commandLineOf(data: Record<string, unknown>): string | undefined {
  const line = str(data.commandLine) ?? str(data.command) ?? str(data.cmd);
  if (line) return line;
  const argv = Array.isArray(data.argv) ? data.argv : data.command;
  if (Array.isArray(argv) && argv.length > 0) {
    return argv.map((part) => String(part)).join(" ");
  }
  return undefined;
}

function answerText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Working copy: fresh containers, so applying events never mutates `view`. */
type Draft = Omit<RunView, "seen"> & { seen: Set<number> };

function toDraft(view: RunView): Draft {
  return {
    ...view,
    seen: new Set(view.seen),
    commands: view.commands.map((c) => ({ ...c })),
    pact: { ...view.pact },
    skeletons: view.skeletons.map((s) => ({ ...s })),
    tasks: view.tasks.map((t) => ({ ...t })),
    approvals: view.approvals.map((a) => ({ ...a })),
    asks: view.asks.map((a) => ({ ...a })),
    channel: view.channel.map((c) => ({ ...c })),
    artifacts: view.artifacts.slice(),
  };
}

function setPhase(draft: Draft, phase: RunPhaseView, ts: number | undefined) {
  draft.phase = phase;
  if (phase !== "queued" && phase !== "unknown" && draft.startedAt === null) {
    draft.startedAt = ts ?? null;
  }
  if (phase === "done" && draft.endedAt === null) {
    draft.endedAt = ts ?? null;
  }
  if (phase === "done") {
    settleActiveSkeletons(draft);
  }
}

/** Skeleton states that mean "still working"; failed and laid-to-rest states are kept. */
const ACTIVE_SKELETON_STATES = new Set([
  "starting",
  "running",
  "working",
  "auditing",
  "recovering",
]);

/** A concluded run has no live Skeletons: mark the ones still active as completed. */
function settleActiveSkeletons(draft: Draft) {
  for (const skeleton of draft.skeletons) {
    if (ACTIVE_SKELETON_STATES.has(skeleton.state.toLowerCase())) {
      skeleton.state = "completed";
      skeleton.currentToolCall = null;
    }
  }
}

function setOutcome(draft: Draft, data: Record<string, unknown>) {
  const outcome = str(data.outcome);
  if (!outcome) return;
  draft.outcome = outcome;
  const reason = str(data.reason);
  if (reason) draft.outcomeReason = reason;
  if (outcome === "error") {
    draft.error =
      str(data.error) ??
      str(data.message) ??
      reason ??
      "The run ended with an error.";
  }
}

function upsertTask(
  draft: Draft,
  taskId: string,
  patch: Partial<Omit<RunTask, "taskId">>
) {
  const existing = draft.tasks.find((t) => t.taskId === taskId);
  if (existing) {
    Object.assign(existing, patch);
  } else {
    draft.tasks.push({ taskId, state: "pending", ...patch });
  }
}

function touchSkeleton(
  draft: Draft,
  skeletonId: string,
  event: RunEvent,
  data: Record<string, unknown>
): RunSkeleton {
  let skeleton = draft.skeletons.find((s) => s.skeletonId === skeletonId);
  if (!skeleton) {
    skeleton = {
      skeletonId,
      role: str(data.role) ?? str(data.agent) ?? "skeleton",
      state: "starting",
      taskIds: [],
      attempt: 1,
      currentToolCall: null,
      toolCallsCount: 0,
      logs: [],
      elapsedSeconds: 0,
      credits: null,
      worktree: str(data.worktreeRoot) ?? str(data.worktree) ?? skeletonId,
      lastEvent: null,
    };
    draft.skeletons.push(skeleton);
  }

  skeleton.lastEvent = {
    seq: event.seq,
    kind: event.kind,
    ts: event.ts,
    actor: event.actor,
    data: event.data ?? undefined,
  };

  const taskId = str(event.taskId) ?? str(data.taskId);
  if (taskId && !skeleton.taskIds.includes(taskId)) {
    skeleton.taskIds = [...skeleton.taskIds, taskId];
  }
  const attempt = num(event.attempt) ?? num(data.attempt);
  if (attempt !== undefined) skeleton.attempt = attempt;

  const candidate = str(data.candidateSha256);
  if (candidate) skeleton.candidateSha256 = candidate;
  const verdict = str(data.verdict);
  if (verdict) skeleton.verdict = verdict;

  return skeleton;
}

function applyOne(draft: Draft, event: RunEvent) {
  const kind = event.kind;
  const data: Record<string, unknown> =
    event.data && typeof event.data === "object" ? event.data : {};
  const ts = num(event.ts);
  const skeletonId = str(event.skeletonId) ?? str(data.skeletonId);

  switch (kind) {
    case "run.queued":
    case "run.queue_position": {
      const position = num(data.queuePosition) ?? num(data.position);
      if (position !== undefined) draft.queuePosition = position;
      // A late queue update must not pull a started run back into the queue.
      if (draft.phase === "unknown") setPhase(draft, "queued", ts);
      break;
    }

    case "run.started": {
      if (draft.phase === "unknown" || draft.phase === "queued") {
        setPhase(draft, "exhume", ts);
      }
      break;
    }

    case "run.phase": {
      const phase = asPhase(data.phase) ?? asPhase(data.to);
      if (phase) setPhase(draft, phase, ts);
      setOutcome(draft, data);
      break;
    }

    case "run.clock": {
      // Pause and resume are recorded as run.clock with an action.
      if (data.action === "pause") draft.paused = true;
      if (data.action === "resume") draft.paused = false;
      break;
    }

    case "run.done": {
      setPhase(draft, "done", ts);
      setOutcome(draft, data);
      draft.paused = false;
      break;
    }

    case "admin.kill": {
      setPhase(draft, "done", ts);
      draft.outcome = "killed";
      break;
    }

    case "system.worker_restart": {
      draft.recovering = true;
      break;
    }

    case "command.started": {
      const command = commandLineOf(data);
      if (!command) break;
      if (draft.phase === "unknown" || draft.phase === "queued") {
        setPhase(draft, "exhume", ts);
      }
      // logRef is unique per command run; the same start recorded twice is one row.
      const logRef = str(data.logRef);
      if (logRef && draft.commands.some((row) => row.logRef === logRef)) break;
      draft.commands.push({
        id: `cmd-${event.seq}`,
        seq: event.seq,
        step: str(data.step),
        command,
        status: "running",
        ...(logRef ? { logRef } : {}),
      });
      break;
    }

    case "command.result": {
      const command = commandLineOf(data);
      if (!command) break;
      const step = str(data.step);
      const exitCode = num(data.exitCode);
      const reported = str(data.status);
      const status =
        reported ??
        (exitCode === undefined ? "failed" : exitCode === 0 ? "passed" : "failed");
      const result: Omit<RunCommand, "id" | "seq"> = {
        step,
        command,
        status,
        exitCode: exitCode ?? null,
        durationMs: num(data.durationMs),
        output: str(data.stdoutTail) ?? str(data.output) ?? str(data.stdout),
        errorExcerpt:
          str(data.stderrTail) ?? str(data.errorExcerpt) ?? str(data.stderr),
        logRef: str(data.logRef),
        timedOut: data.timedOut === true,
        oomKilled: data.oomKilled === true,
        reason: str(data.reason),
        ruleId: str(data.ruleId),
      };
      // Pair by logRef first: it identifies one command run. A second result for
      // a row that already finished is a duplicate record and is ignored.
      if (result.logRef) {
        const sameRun = draft.commands.find((row) => row.logRef === result.logRef);
        if (sameRun && sameRun.status !== "running") break;
        if (sameRun) {
          Object.assign(sameRun, result);
          break;
        }
      }
      // Otherwise pair with the most recent still-running row for the same command.
      let open: RunCommand | undefined;
      for (let i = draft.commands.length - 1; i >= 0; i--) {
        const row = draft.commands[i];
        if (row.status === "running" && row.command === command) {
          open = row;
          break;
        }
      }
      if (open) {
        Object.assign(open, result);
      } else {
        draft.commands.push({ id: `cmd-${event.seq}`, seq: event.seq, ...result });
      }
      break;
    }

    case "command.refused": {
      const command = commandLineOf(data) ?? "command";
      const reason = str(data.reason);
      draft.channel.push({
        id: `chan-${event.seq}`,
        seq: event.seq,
        ts: ts ?? 0,
        kind,
        type: "message",
        title: "Command refused",
        text: reason ? `${command} (${reason})` : command,
        actor: event.actor,
        skeletonId,
      });
      break;
    }

    case "exhume.certificate": {
      draft.certificate = {
        baseSha: str(data.baseSha) ?? null,
        healthy: data.healthy === true,
        failureClasses: strList(data.failureClasses) ?? [],
        sha256: str(data.sha256) ?? null,
        recordedAt: ts ?? null,
      };
      break;
    }

    case "pact.revision":
    case "pact.edited": {
      const version = num(data.pactVersion) ?? num(data.version);
      if (version !== undefined) draft.pact.version = version;
      break;
    }

    case "pact.approved": {
      const version = num(data.pactVersion);
      if (version !== undefined) draft.pact.version = version;
      draft.pact.approved = true;
      if (data.caps && typeof data.caps === "object") {
        draft.caps = data.caps as Record<string, unknown>;
      } else if (data.budget && typeof data.budget === "object") {
        draft.caps = data.budget as Record<string, unknown>;
      }
      break;
    }

    case "task.state": {
      const taskId = str(event.taskId) ?? str(data.taskId);
      if (!taskId) break;
      upsertTask(draft, taskId, {
        state: str(data.state) ?? str(data.status) ?? "pending",
        ...(num(event.attempt) !== undefined ? { attempt: num(event.attempt) } : {}),
        ...(str(data.summary) ? { summary: str(data.summary) } : {}),
      });
      break;
    }

    case "task.merged": {
      const taskId = str(event.taskId) ?? str(data.taskId);
      if (!taskId) break;
      upsertTask(draft, taskId, {
        state: "merged",
        ...(num(event.attempt) !== undefined ? { attempt: num(event.attempt) } : {}),
      });
      break;
    }

    case "approval.requested": {
      const approvalId = str(data.approvalId);
      if (!approvalId) break;
      const approval: RunApproval = {
        approvalId,
        seq: event.seq,
        command: commandLineOf(data) ?? "(command not recorded)",
        cwd: str(data.cwd),
        reason: str(data.reason) ?? str(data.summary) ?? str(data.detail),
        skeletonId,
        expiresAt: num(data.expiresAt),
        candidateSha256: str(data.candidateSha256),
        grimoireSummary: str(data.grimoireSummary),
        status: "pending",
      };
      // approvalId is unique per request; a second record of the same request
      // refreshes the approval but must not add a second channel entry.
      const alreadyKnown = draft.approvals.some((a) => a.approvalId === approvalId);
      draft.approvals = [
        ...draft.approvals.filter((a) => a.approvalId !== approvalId),
        approval,
      ];
      if (alreadyKnown) break;
      draft.channel.push({
        id: `chan-${event.seq}`,
        seq: event.seq,
        ts: ts ?? 0,
        kind,
        type: "approval",
        title: "Approval Requested",
        text: `Command needs approval: ${approval.command}`,
        actor: event.actor,
        skeletonId,
      });
      break;
    }

    case "approval.resolved": {
      const approvalId = str(data.approvalId);
      if (!approvalId) break;
      const decision = str(data.decision) ?? "resolved";
      const approval = draft.approvals.find((a) => a.approvalId === approvalId);
      if (approval) {
        approval.status = "resolved";
        approval.resolution = decision;
      }
      draft.channel.push({
        id: `chan-${event.seq}`,
        seq: event.seq,
        ts: ts ?? 0,
        kind,
        type: "approval",
        title: "Approval Resolved",
        text: `${approval?.command ?? approvalId}: ${decision}`,
        actor: event.actor,
        skeletonId,
      });
      break;
    }

    case "ask.raised": {
      const askId = str(data.askId);
      const question =
        str(data.question) ?? str(data.text) ?? str(data.prompt);
      if (!askId || !question) break;
      const options = strList(data.options);
      draft.asks = [
        ...draft.asks.filter((a) => a.askId !== askId),
        {
          askId,
          seq: event.seq,
          question,
          options,
          skeletonId,
          taskId: str(event.taskId) ?? str(data.taskId),
          status: "open",
        },
      ];
      draft.channel.push({
        id: `chan-${event.seq}`,
        seq: event.seq,
        ts: ts ?? 0,
        kind,
        type: "ask",
        title: "Question Asked",
        text: question,
        actor: event.actor,
        skeletonId,
        options,
        askId,
        answered: false,
      });
      break;
    }

    case "ask.answered": {
      const askId = str(data.askId);
      if (!askId) break;
      const answer = answerText(data.answer);
      const ask = draft.asks.find((a) => a.askId === askId);
      if (ask) {
        ask.status = "answered";
        ask.answer = answer;
      }
      for (const entry of draft.channel) {
        if (entry.askId === askId) entry.answered = true;
      }
      draft.channel.push({
        id: `chan-${event.seq}`,
        seq: event.seq,
        ts: ts ?? 0,
        kind,
        type: "ask",
        title: "Question Answered",
        text: answer ?? "(answer not recorded)",
        actor: event.actor,
        skeletonId,
        askId,
        answered: true,
      });
      break;
    }

    case "necromancer.decision": {
      const action =
        str(data.decision) ?? str(data.text) ?? str(data.action);
      if (!action) break;
      const reason = str(data.reason);
      draft.channel.push({
        id: `chan-${event.seq}`,
        seq: event.seq,
        ts: ts ?? 0,
        kind,
        type: "decision",
        title: "Necromancer Decision",
        text: reason && reason !== action ? `${action}: ${reason}` : action,
        actor: "Necromancer",
        refs: strList(data.refs),
      });
      break;
    }

    case "progress.report":
    case "message.sent":
    case "message.delivered": {
      const text =
        str(data.summary) ?? str(data.text) ?? str(data.message);
      if (!text) break;
      const status = kind === "progress.report" ? str(data.status) : undefined;
      draft.channel.push({
        id: `chan-${event.seq}`,
        seq: event.seq,
        ts: ts ?? 0,
        kind,
        type: "message",
        text: status ? `${status}: ${text}` : text,
        actor: str(data.sender) ?? event.actor,
        skeletonId,
      });
      break;
    }

    case "final_check.result": {
      draft.finalCheck = {
        passed: data.passed === true,
        installPassed:
          typeof data.installPassed === "boolean" ? data.installPassed : undefined,
        buildPassed:
          typeof data.buildPassed === "boolean" ? data.buildPassed : undefined,
        testsPassed:
          typeof data.testsPassed === "boolean" ? data.testsPassed : undefined,
        hasTests: typeof data.hasTests === "boolean" ? data.hasTests : undefined,
      };
      break;
    }

    case "artifact.ready": {
      const path = str(data.path);
      if (!path) break;
      draft.artifacts.push({
        kind: str(data.kind) ?? "artifact",
        path,
        sha256: str(data.sha256),
        byteSize: num(data.byteSize),
      });
      break;
    }

    default:
      break;
  }

  // Skeleton cards. Only skeleton.* events create a card; other events that
  // name an existing skeleton (approvals, task state, gate results) keep its
  // last-event line, candidate hash and verdict current.
  const skeletonExists =
    skeletonId !== undefined &&
    draft.skeletons.some((s) => s.skeletonId === skeletonId);

  if (skeletonId && USER_SKELETON_ACTIONS.has(kind)) {
    if (skeletonExists) {
      const skeleton = touchSkeleton(draft, skeletonId, event, data);
      let note: string | null = null;
      if (kind === "skeleton.interrupted") {
        skeleton.currentToolCall = null;
        note = "Tool call interrupted by user.";
      } else if (kind === "skeleton.reraised") {
        skeleton.state = "running";
        note = "Skeleton re-raised by user.";
      } else if (kind === "skeleton.laid_to_rest") {
        skeleton.state = "laid_to_rest";
        skeleton.currentToolCall = null;
        note = "Skeleton laid to rest by user.";
      } else if (kind === "skeleton.instruction") {
        const instruction = str(data.instruction);
        note = instruction ? `Instruction sent: ${instruction}` : "Instruction sent.";
      } else if (kind === "warden.focus_added") {
        const focus = str(data.focus);
        note = focus ? `Review focus added: ${focus}` : "Review focus added.";
      }
      if (note) {
        skeleton.logs = [...skeleton.logs, note].slice(-MAX_SKELETON_LOG_LINES);
      }
    }
  } else if (skeletonId && !kind.startsWith("skeleton.") && skeletonExists) {
    touchSkeleton(draft, skeletonId, event, data);
  } else if (skeletonId && kind.startsWith("skeleton.")) {
    const skeleton = touchSkeleton(draft, skeletonId, event, data);

    if (kind === "skeleton.raised") {
      skeleton.role = str(data.role) ?? str(data.agent) ?? skeleton.role;
      skeleton.state = "running";
      const worktree = str(data.worktreeRoot) ?? str(data.worktree);
      if (worktree) skeleton.worktree = worktree;
    } else if (kind === "skeleton.state") {
      skeleton.state = str(data.state) ?? str(data.status) ?? skeleton.state;
    } else if (kind === "skeleton.tool_call") {
      const tool = str(data.tool) ?? str(data.name) ?? str(data.toolName) ?? "tool";
      skeleton.currentToolCall = {
        tool,
        toolCallId: str(data.toolCallId),
        startedAt: ts ?? 0,
        args: data.arguments,
      };
      skeleton.toolCallsCount += 1;
      skeleton.state = "running";
      draft.toolCalls += 1;
      draft.latestToolCall = { tool, skeletonId, args: data.arguments };
    } else if (kind === "skeleton.tool_result") {
      skeleton.currentToolCall = null;
    } else if (kind === "skeleton.log") {
      const text = str(data.text) ?? str(data.message) ?? str(data.content);
      if (text && text.trim().length > 0) {
        skeleton.logs = [...skeleton.logs, text].slice(-MAX_SKELETON_LOG_LINES);
      }
    } else if (kind === "skeleton.usage") {
      const credits = num(data.credits);
      if (credits !== undefined) skeleton.credits = credits;
    } else if (kind === "skeleton.failed") {
      skeleton.state = "failed";
      skeleton.currentToolCall = null;
      const reason = str(data.reason) ?? str(data.error);
      if (reason) {
        skeleton.logs = [...skeleton.logs, `Failed: ${reason}`].slice(
          -MAX_SKELETON_LOG_LINES
        );
      }
    }
  }
}

function isRunEvent(value: unknown): value is RunEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RunEvent).seq === "number" &&
    typeof (value as RunEvent).kind === "string"
  );
}

/**
 * Apply events to a view. Events are applied in seq order; an event whose seq
 * was already applied is skipped, so replaying the stored log and then a live
 * stream that starts from seq 1 gives the same view as applying each event
 * once.
 */
export function applyRunEvents(
  view: RunView,
  events: readonly unknown[]
): RunView {
  const fresh = events
    .filter(isRunEvent)
    .filter((e) => !view.seen.has(e.seq))
    .sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return view;

  const draft = toDraft(view);
  for (const event of fresh) {
    if (draft.seen.has(event.seq)) continue;
    draft.seen.add(event.seq);
    if (event.seq > draft.lastSeq) draft.lastSeq = event.seq;
    applyOne(draft, event);
  }
  return draft;
}

export function buildRunView(events: readonly unknown[]): RunView {
  return applyRunEvents(createRunView(), events);
}

/** Nothing can be answered once the run has concluded, so nothing is pending. */
export function pendingApprovals(view: RunView): RunApproval[] {
  if (view.phase === "done") return [];
  return view.approvals.filter((a) => a.status === "pending");
}

export function openAsks(view: RunView): RunAsk[] {
  if (view.phase === "done") return [];
  return view.asks.filter((a) => a.status === "open");
}

/** Seconds since the run left the queue; 0 while queued or when unknown. */
export function elapsedSeconds(view: RunView, now: number): number {
  if (view.startedAt === null) return 0;
  const end = view.endedAt ?? now;
  return Math.max(0, Math.floor((end - view.startedAt) / 1000));
}

export function mergedTaskCount(view: RunView): number {
  return view.tasks.filter((t) => t.state === "merged").length;
}
