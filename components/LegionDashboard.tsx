"use client";

import React, { useEffect, useState } from "react";
import {
  postApproval,
  postAskAnswer,
  postControl,
  postSkeletonAction,
  type ApiResult,
  type ApprovalDecision,
} from "@/lib/ui/api";
import {
  elapsedSeconds as runElapsedSeconds,
  mergedTaskCount,
  openAsks,
  pendingApprovals as selectPendingApprovals,
  reconnectBannerText,
} from "@/lib/ui/run-model";
import { announceRunPhase } from "@/lib/ui/run-phase-bus";
import { rememberInviteCode } from "@/lib/ui/invite-session";
import { describeOutcome, routes } from "@/lib/ui/run-routes";
import { useRunStream } from "@/lib/ui/use-run-stream";
import { LegionWaitingRoomCard } from "./LegionWaitingRoomCard";
import { LegionSkeletonCard, type SkeletonData } from "./LegionSkeletonCard";
import { LegionApprovalCard } from "./LegionApprovalCard";
import { LegionAskCard } from "./LegionAskCard";
import { LegionRunHeader } from "./LegionRunHeader";
import { LegionNecromancerChannel } from "./LegionNecromancerChannel";
import { LegionRunControls } from "./LegionRunControls";
import { TaskGraph, type TaskNode } from "./TaskGraph";
import { TaskTable } from "./TaskTable";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";

export interface LegionDashboardHandlers {
  handlePauseRun: () => Promise<void>;
  handleResumeRun: () => Promise<void>;
  handleStopRun: () => Promise<void>;
  handleCancelQueuedRun: () => Promise<void>;
  handleKillRun: () => Promise<void>;
  handleApprovalDecision: (
    approvalId: string,
    decision: "approve_once" | "approve_pattern" | "deny" | "deny_and_lay_to_rest"
  ) => Promise<void>;
  handleInterrupt: (skeletonId: string) => Promise<void>;
  handleReraise: (skeletonId: string) => Promise<void>;
  handleLayToRest: (skeletonId: string, choice?: "keep" | "discard") => Promise<void>;
  handleSendInstruction: (skeletonId: string, instruction?: string) => Promise<void>;
  handleAddReviewFocus: (skeletonId: string, focus?: string) => Promise<void>;
  handleAnswerAsk: (askId: string, answer: string) => Promise<boolean>;
}

export interface LegionDashboardProps {
  runId: string;
  isAdmin?: boolean;
  initialEvents?: unknown[];
  handlersRef?: { current: LegionDashboardHandlers | null };
}

/** A Skeleton that has reported nothing for this long is shown as silent. */
const SILENT_AFTER_SECONDS = 120;

function capNumber(
  caps: Record<string, unknown> | null,
  key: string
): number | null {
  const value = caps?.[key];
  return typeof value === "number" && value > 0 ? value : null;
}

export function LegionDashboard({
  runId,
  isAdmin = false,
  initialEvents,
  handlersRef,
}: LegionDashboardProps) {
  // The run's event log is the single source of state for this screen: stored
  // events first, then the live stream, de-duplicated by seq.
  const { view, loading, reconnecting, loadError, refresh } = useRunStream(runId, {
    initialEvents,
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const [controlAuthRequired, setControlAuthRequired] = useState<boolean>(false);
  const [unlockDraft, setUnlockDraft] = useState<string>("");
  const [now, setNow] = useState<number>(() => Date.now());
  // Synchronized task views: the same tasks render as a graph or a table, and
  // the selected task is preserved when the user toggles between them.
  const [taskView, setTaskView] = useState<"graph" | "table">("graph");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // A run with no events yet is shown as queued (its first event is run.queued).
  const phase: string = view.phase === "unknown" ? "queued" : view.phase;
  const isDone = phase === "done";
  const outcome = describeOutcome(view.outcome);

  const pendingApprovals = selectPendingApprovals(view);
  const asksOpen = openAsks(view);
  const needsUserCount = pendingApprovals.length + asksOpen.length;

  // One-second tick for the run clock and silence detection.
  useEffect(() => {
    if (isDone) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isDone]);

  // Tab title when something needs the user (Requirement 37.4). The previous
  // title is restored on unmount or when the needs-user state clears.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previous = document.title;
    document.title =
      needsUserCount > 0
        ? `[Action Needed] Legion - Git-Graveyard`
        : `Git-Graveyard: Legion - ${runId}`;
    return () => {
      document.title = previous;
    };
  }, [needsUserCount, runId]);

  // Let the nav stepper follow the run.
  useEffect(() => {
    if (view.phase !== "unknown") {
      announceRunPhase({ runId, phase: view.phase, outcome: view.outcome });
    }
  }, [runId, view.phase, view.outcome]);

  // Every action posts to the backend; the recorded event then arrives on the
  // stream (or through refresh) and updates the view. Nothing is assumed to
  // have happened until the log says so.
  async function act(request: Promise<ApiResult<unknown>>): Promise<boolean> {
    setActionError(null);
    const result = await request;
    if (!result.ok) {
      setActionError(result.message);
      if (result.status === 401 || result.status === 403) {
        setControlAuthRequired(true);
      }
      return false;
    }
    setControlAuthRequired(false);
    await refresh();
    return true;
  }

  const handleUnlockControls = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = unlockDraft.trim();
    if (!clean) return;
    rememberInviteCode(runId, clean);
    setUnlockDraft("");
    setControlAuthRequired(false);
    setActionError(null);
  };

  const handleCancelQueuedRun = async () => {
    await act(postControl(runId, "stop", "Failed to cancel queued run"));
  };

  const handleApprovalDecision = async (
    approvalId: string,
    decision: ApprovalDecision
  ) => {
    await act(postApproval(runId, approvalId, decision));
  };

  const handlePauseRun = async () => {
    await act(postControl(runId, "pause", "Failed to pause run"));
  };

  const handleResumeRun = async () => {
    await act(postControl(runId, "resume", "Failed to resume run"));
  };

  const handleStopRun = async () => {
    await act(postControl(runId, "stop", "Failed to stop run"));
  };

  const handleKillRun = async () => {
    await act(postControl(runId, "kill", "Failed to kill run"));
  };

  const handleLayToRest = async (
    skeletonId: string,
    choice: "keep" | "discard" = "keep"
  ) => {
    await act(
      postSkeletonAction(
        runId,
        skeletonId,
        { action: "lay_to_rest", choice },
        "Failed to lay skeleton to rest"
      )
    );
  };

  const handleReraise = async (skeletonId: string) => {
    await act(
      postSkeletonAction(runId, skeletonId, { action: "reraise" }, "Failed to reraise skeleton")
    );
  };

  const handleInterrupt = async (skeletonId: string) => {
    await act(
      postSkeletonAction(runId, skeletonId, { action: "interrupt" }, "Failed to interrupt skeleton")
    );
  };

  const handleSendInstruction = async (skeletonId: string, instruction?: string) => {
    const text = instruction?.trim();
    if (!text) {
      setActionError("Write the instruction before sending it.");
      return;
    }
    await act(
      postSkeletonAction(
        runId,
        skeletonId,
        { action: "send_instruction", instruction: text },
        "Failed to send instruction"
      )
    );
  };

  const handleAddReviewFocus = async (skeletonId: string, focus?: string) => {
    const text = focus?.trim();
    if (!text) {
      setActionError("Write the review focus before adding it.");
      return;
    }
    await act(
      postSkeletonAction(
        runId,
        skeletonId,
        { action: "add_review_focus", focus: text },
        "Failed to add review focus"
      )
    );
  };

  const handleAnswerAsk = async (askId: string, answer: string): Promise<boolean> => {
    const text = answer.trim();
    if (!text) {
      setActionError("Write an answer before sending it.");
      return false;
    }
    return act(postAskAnswer(runId, askId, text));
  };

  if (handlersRef) {
    handlersRef.current = {
      handlePauseRun,
      handleResumeRun,
      handleStopRun,
      handleCancelQueuedRun,
      handleKillRun,
      handleApprovalDecision,
      handleInterrupt,
      handleReraise,
      handleLayToRest,
      handleSendInstruction,
      handleAddReviewFocus,
      handleAnswerAsk,
    };
  }

  const elapsedSeconds = runElapsedSeconds(view, now);

  // Skeleton cards, Exhumer first (Requirement 37.3)
  const isStarting = phase === "exhume" || phase === "plan";
  const skeletonList: SkeletonData[] = view.skeletons
    .map((skel): SkeletonData => {
      const lastTs = skel.lastEvent?.ts;
      const silentSeconds =
        skel.state === "running" && typeof lastTs === "number" && !isDone
          ? Math.max(0, Math.floor((now - lastTs) / 1000))
          : 0;
      return {
        ...skel,
        silentSeconds,
        isSilent: silentSeconds >= SILENT_AFTER_SECONDS,
      };
    })
    .sort((a, b) => {
      if (a.role.toLowerCase() === "exhumer") return -1;
      if (b.role.toLowerCase() === "exhumer") return 1;
      return a.skeletonId.localeCompare(b.skeletonId);
    });

  // While the sandbox is being prepared the Exhumer has not been raised as a
  // Skeleton yet; its card shows the baseline commands the log has recorded.
  if (isStarting && !skeletonList.some((s) => s.role.toLowerCase() === "exhumer")) {
    skeletonList.unshift({
      skeletonId: "exhumer",
      role: "exhumer",
      state: "starting",
      taskIds: [],
      attempt: 1,
      currentToolCall: null,
      toolCallsCount: 0,
      logs: [],
      commands: view.commands,
      elapsedSeconds,
      credits: null,
      worktree: "exhume",
      lastEvent: null,
      silentSeconds: 0,
      isSilent: false,
    });
  }

  const youActionDescription =
    pendingApprovals.length > 0
      ? `Approval required: ${pendingApprovals[0].command}`
      : asksOpen.length > 0
      ? `Question waiting: ${asksOpen[0].question}`
      : null;

  const dashboardUiState:
    | "loading"
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "stopped" =
    loading && view.lastSeq === 0
      ? "loading"
      : isDone
      ? view.outcome === "cancelled" || view.outcome === "killed"
        ? "stopped"
        : outcome.tone === "crimson"
        ? "failed"
        : "completed"
      : view.paused
      ? "paused"
      : phase === "queued"
      ? "queued"
      : "running";

  // The run does not exist: nothing to steer.
  if (!loading && view.lastSeq === 0 && loadError === "Run not found.") {
    return (
      <div
        data-testid="legion-run-not-found"
        data-ui-element="legion-dashboard"
        data-ui-state="failed"
        data-run-id={runId}
        className="crypt-panel-engraved p-8 border-l-2 border-l-rose-500 space-y-4 font-mono"
      >
        <h1 className="text-base font-bold text-bone">Run not found</h1>
        <p className="text-xs text-rose-200/90 leading-relaxed">
          No run with the ID {runId} is recorded here. Check the link, or pick a
          run from History.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href={routes.history()} className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Open History
          </a>
          <a href={routes.gate()} className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Return to Gate
          </a>
        </div>
      </div>
    );
  }

  const doneAccent =
    outcome.tone === "emerald"
      ? { border: "border-emerald-500/40", seal: "text-emerald-400" }
      : outcome.tone === "amber"
      ? { border: "border-amber-500/40", seal: "text-amber-400" }
      : outcome.tone === "crimson"
      ? { border: "border-rose-500/45", seal: "text-rose-400" }
      : { border: "border-white/15", seal: "text-ash" };

  const tasksTotal = view.tasks.length > 0 ? view.tasks.length : undefined;

  // The graph and table render this exact list, so they always agree.
  const taskNodes: TaskNode[] = view.tasks.map((t) => ({
    taskId: t.taskId,
    state: t.state,
    attempt: t.attempt,
    verdict: t.verdict ?? null,
    dependencies: t.dependencies ?? [],
  }));

  return (
    <div
      data-ui-element="legion-dashboard"
      data-ui-state={dashboardUiState}
      data-ui-variant={isAdmin ? "admin" : "viewer"}
      data-run-id={runId}
      data-run-phase={phase}
      className="space-y-6 font-mono text-bone"
    >
      {/* Run Header (Requirement 37.1) */}
      <LegionRunHeader
        runId={runId}
        phase={phase}
        isReconnecting={reconnecting}
        latestToolCall={view.latestToolCall}
        pendingActionsCount={needsUserCount}
        pendingActionDescription={youActionDescription}
        elapsedSeconds={elapsedSeconds}
        tasksMerged={tasksTotal ? mergedTaskCount(view) : undefined}
        tasksTotal={tasksTotal}
        toolCallsUsed={view.toolCalls}
        toolCallsCap={capNumber(view.caps, "maxToolCalls")}
        wallClockMinutes={Math.floor(elapsedSeconds / 60)}
        wallClockCapMinutes={capNumber(view.caps, "maxMinutes")}
        creditsUsed={null}
        creditsCap={capNumber(view.caps, "maxCredits")}
      />

      {/* Run Controls (Requirement 37.15) */}
      <LegionRunControls
        runId={runId}
        isPaused={view.paused}
        isAdmin={isAdmin}
        phase={phase}
        disabled={isDone}
        onPause={handlePauseRun}
        onResume={handleResumeRun}
        onStop={handleStopRun}
        onKill={handleKillRun}
      />

      {/* Inbox attention badge (Task 24.1) */}
      {needsUserCount > 0 && (
        <div
          data-testid="legion-inbox-badge"
          className="crypt-panel border-amber-500/45 bg-amber-950/25 p-3 text-xs text-amber-200 flex items-center gap-2"
        >
          <StatusPill tone="amber" pulse label={`Inbox: ${needsUserCount}`} uiState="needs-user" />
          <span>
            {needsUserCount} item{needsUserCount === 1 ? "" : "s"} need your attention.
          </span>
        </div>
      )}

      {/* SSE Down / Reconnecting Indicator (Requirement 37.5) */}
      {reconnecting && (
        <div className="crypt-panel border-amber-500/45 bg-amber-950/20 p-3 text-xs text-amber-300 flex items-center justify-between gap-2">
          <span>{reconnectBannerText(view.lastSeq)}</span>
          <StatusPill tone="amber" pulse label="Offline" uiState="reconnecting" />
        </div>
      )}

      {/* Load or action error, in plain words */}
      {(loadError || actionError) && (
        <div
          data-testid="legion-error-notice"
          role="alert"
          className="crypt-panel border-l-2 border-l-rose-500 border-rose-500/40 bg-rose-950/25 p-3 text-xs text-rose-300 space-y-2"
        >
          {loadError && <p>{loadError}</p>}
          {actionError && <p>{actionError}</p>}
          {controlAuthRequired && (
            <form
              data-testid="legion-unlock-form"
              onSubmit={handleUnlockControls}
              className="flex flex-wrap items-center gap-2 pt-1"
            >
              <input
                type="password"
                value={unlockDraft}
                onChange={(e) => setUnlockDraft(e.target.value)}
                placeholder="Enter invite code for this run"
                data-testid="legion-unlock-code-input"
                aria-label="Invite code for run controls"
                className="crypt-input px-2.5 py-1.5 text-xs text-bone min-w-[220px]"
              />
              <button
                type="submit"
                data-testid="legion-unlock-submit"
                disabled={!unlockDraft.trim()}
                className="crypt-btn-primary text-xs py-1.5 px-3 disabled:opacity-50"
              >
                Save invite code
              </button>
            </form>
          )}
        </div>
      )}

      {/* Run Recovering Banner (Requirement 37.6) */}
      {view.recovering && !isDone && (
        <div className="crypt-panel border-violet-500/40 bg-violet-950/20 p-3 text-xs text-violet-200">
          The Necromancer is recovering after a restart. Recovering state is indicated on affected cards.
        </div>
      )}

      {/* The Pact needs the user before any builder starts */}
      {(phase === "plan" || phase === "pact_review") && (
        <div
          data-testid="legion-pact-cta"
          className="crypt-panel-engraved border-amber-500/45 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
        >
          <div>
            <h2 className="text-base font-bold text-bone">
              {phase === "pact_review"
                ? "The Pact is waiting for your approval"
                : "The Planner is writing the Pact"}
            </h2>
            <p className="text-xs text-ash mt-1">
              {phase === "pact_review"
                ? "No Skeleton starts until you approve the Pact. Read it, edit it, then approve or stop."
                : "You can open the Pact now and watch it being drafted."}
            </p>
          </div>
          <a
            href={routes.pact(runId)}
            className={`${
              phase === "pact_review" ? "crypt-btn-primary" : "crypt-btn-ghost"
            } px-4 py-2 text-xs rounded shrink-0`}
          >
            Open the Pact
          </a>
        </div>
      )}

      {/* Run concluded: offer "Open the Reliquary" (Requirement 37.7) */}
      {isDone && (
        <div
          data-testid="legion-done-banner"
          className={`crypt-panel-engraved ${doneAccent.border} p-5 space-y-3`}
        >
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-start gap-3">
              <CryptOrnament kind="wax-seal" className={`w-7 h-7 ${doneAccent.seal} mt-0.5`} />
              <div>
                <h2 className="text-lg font-bold text-bone">
                  Run Concluded ({outcome.label})
                </h2>
                <p className="text-xs text-ash mt-1">
                  The run has ended. The cards below remain readable.
                </p>
              </div>
            </div>
            <div>
              <a
                href={routes.relic(runId)}
                className="crypt-btn-primary px-4 py-2 text-xs rounded"
              >
                Open the Reliquary
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Partial State Banner (Requirement 37.9) */}
      {view.outcome === "partial" && (
        <div className="crypt-panel border-l-2 border-l-amber-500 border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-200">
          Run status: partial. Some tasks merged successfully, while other tasks failed or were abandoned.
        </div>
      )}

      {/* Run-level Error Banner (Requirement 37.8) */}
      {view.error && (
        <div className="crypt-panel border-l-2 border-l-rose-500 border-rose-500/45 bg-rose-950/25 p-4 space-y-2 text-xs">
          <div className="font-bold text-rose-200">Run-level error occurred:</div>
          <div className="text-parchment">{view.error}</div>
          <div className="pt-1 flex flex-wrap gap-4">
            <a
              href={routes.eventLog(runId)}
              className="text-emerald-400 hover:text-emerald-300 underline underline-offset-4"
            >
              View kept event evidence log
            </a>
            <a
              href={routes.relic(runId)}
              className="text-emerald-400 hover:text-emerald-300 underline underline-offset-4"
            >
              View kept artifacts and commit state
            </a>
          </div>
        </div>
      )}

      {/* Waiting Room: when queued, ONE waiting-room card and NO Skeleton cards (Requirement 37.2) */}
      {phase === "queued" ? (
        <LegionWaitingRoomCard
          position={view.queuePosition}
          ahead={
            typeof view.queuePosition === "number"
              ? Math.max(0, view.queuePosition - 1)
              : null
          }
          runId={runId}
          onCancel={handleCancelQueuedRun}
        />
      ) : (
        <>
          {/* Starting / Sandbox Preparing State (Requirement 37.3) */}
          {phase === "exhume" && (
            <div className="crypt-panel border-amber-500/35 p-3 text-xs text-amber-300 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 crypt-pulse-emerald shrink-0" />
              <span>
                Preparing the sandbox... The Exhumer is establishing the baseline environment.
              </span>
            </div>
          )}

          {/* Pending Approval Cards (Requirement 28.8) */}
          {pendingApprovals.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-amber-300 uppercase tracking-wider">
                  Pending Approvals ({pendingApprovals.length})
                </h2>
              </div>
              {pendingApprovals.map((appr) => (
                <LegionApprovalCard
                  key={appr.approvalId}
                  approval={appr}
                  onDecision={handleApprovalDecision}
                />
              ))}
            </div>
          )}

          {/* Open questions for the user (Requirement 28) */}
          {asksOpen.length > 0 && (
            <div className="space-y-4" data-testid="legion-open-asks">
              <h2 className="text-sm font-bold text-amber-300 uppercase tracking-wider">
                Questions for You ({asksOpen.length})
              </h2>
              {asksOpen.map((ask) => (
                <LegionAskCard key={ask.askId} ask={ask} onAnswer={handleAnswerAsk} />
              ))}
            </div>
          )}

          {/* Skeleton Cards Grid (Requirement 37.10) */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-parchment uppercase tracking-wider">
                Skeleton Cards ({skeletonList.length})
              </h2>
            </div>

            {skeletonList.length === 0 ? (
              <div className="crypt-panel text-xs text-ash p-8 text-center">
                {phase === "pact_review"
                  ? "No Skeleton has been raised yet. Builders start after the Pact is approved."
                  : "No active Skeletons in the Legion right now."}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {skeletonList.map((skel) => (
                  <LegionSkeletonCard
                    key={skel.skeletonId}
                    skeleton={skel}
                    runDone={isDone}
                    recovering={view.recovering}
                    onInterrupt={handleInterrupt}
                    onReraise={handleReraise}
                    onLayToRest={handleLayToRest}
                    onSendInstruction={handleSendInstruction}
                    onAddReviewFocus={handleAddReviewFocus}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Synchronized Task Graph / Table (Task 24.3) */}
          {taskNodes.length > 0 && (
            <section className="space-y-3" data-testid="legion-task-views">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-parchment uppercase tracking-wider">
                  Tasks ({taskNodes.length})
                </h2>
                <div
                  role="group"
                  aria-label="Task view"
                  className="inline-flex rounded border border-white/10 overflow-hidden"
                >
                  <button
                    type="button"
                    data-testid="task-view-graph"
                    aria-pressed={taskView === "graph"}
                    onClick={() => setTaskView("graph")}
                    className={`px-3 py-1 text-xs ${
                      taskView === "graph"
                        ? "bg-emerald-950/50 text-emerald-300"
                        : "text-ash hover:text-bone"
                    }`}
                  >
                    Graph
                  </button>
                  <button
                    type="button"
                    data-testid="task-view-table"
                    aria-pressed={taskView === "table"}
                    onClick={() => setTaskView("table")}
                    className={`px-3 py-1 text-xs ${
                      taskView === "table"
                        ? "bg-emerald-950/50 text-emerald-300"
                        : "text-ash hover:text-bone"
                    }`}
                  >
                    Table
                  </button>
                </div>
              </div>
              {taskView === "graph" ? (
                <TaskGraph
                  tasks={taskNodes}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={setSelectedTaskId}
                />
              ) : (
                <TaskTable
                  tasks={taskNodes}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={setSelectedTaskId}
                />
              )}
            </section>
          )}

          {/* Necromancer Channel (Requirement 37.14) */}
          <LegionNecromancerChannel entries={view.channel} />
        </>
      )}
    </div>
  );
}

export default LegionDashboard;
