"use client";

import React, { useEffect, useState } from "react";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";
import { CommandRow, type CommandRowItem } from "./CommandRow";

export interface SkeletonData {
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
  commands?: CommandRowItem[];
  lastEvent: {
    seq?: number;
    kind?: string;
    ts?: number;
    actor?: string;
    data?: unknown;
  } | null;
  silentSeconds?: number;
  isSilent?: boolean;
}

export interface LegionSkeletonCardProps {
  skeleton: SkeletonData;
  runDone?: boolean;
  onSendInstruction?: (skeletonId: string, instruction?: string) => void;
  onInterrupt?: (skeletonId: string) => void;
  onReraise?: (skeletonId: string) => void;
  onLayToRest?: (skeletonId: string, choice: "keep" | "discard") => void;
  onAddReviewFocus?: (skeletonId: string, focus?: string) => void;
}

type CanonicalSkeletonUiState =
  | "queued"
  | "working"
  | "auditing"
  | "awaiting_approval"
  | "merged"
  | "failed"
  | "rejected";

function formatClock(seconds: number): string {
  const safeSec = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safeSec / 60);
  const secs = safeSec % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function resolveUiState(state: string): CanonicalSkeletonUiState {
  if (state === "auditing") return "auditing";
  if (state === "awaiting_approval" || state === "blocked") return "awaiting_approval";
  if (state === "merged" || state === "completed" || state === "done") return "merged";
  if (state === "rejected") return "rejected";
  if (state === "failed" || state === "error" || state === "laid_to_rest" || state === "abandoned") {
    return "failed";
  }
  if (state === "queued") return "queued";
  return "working";
}

export function LegionSkeletonCard({
  skeleton,
  runDone = false,
  onSendInstruction,
  onInterrupt,
  onReraise,
  onLayToRest,
  onAddReviewFocus,
}: LegionSkeletonCardProps) {
  const [showLayToRestConfirm, setShowLayToRestConfirm] = useState(false);
  // The user writes the instruction or review focus; nothing is sent without text.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [focusedDisabledReason, setFocusedDisabledReason] = useState<string | null>(null);

  const role = skeleton.role || "unknown";
  const isWarden = role.toLowerCase() === "warden";
  const state = (skeleton.state || "unknown").toLowerCase();

  const isRunning = state === "running" || state === "starting" || state === "working";
  const isAuditing = state === "auditing";
  const isAwaitingApproval = state === "awaiting_approval" || state === "blocked";
  const isLaidToRest = state === "laid_to_rest" || state === "abandoned";
  const isCompleted = state === "completed" || state === "done" || state === "merged";
  const isRejected = state === "rejected";
  const isFailed = state === "failed" || state === "error";
  const isRecovering = state === "recovering";

  const uiState = resolveUiState(state);

  // Silent state check (Requirement 37.17)
  const silentSeconds = skeleton.silentSeconds ?? 0;
  const isSilent = skeleton.isSilent || silentSeconds >= 120;
  const silentDisplay = isSilent ? `Silent for ${formatClock(silentSeconds)}` : null;

  // State text, icon, and card aura
  let stateIcon = "[IDLE]";
  let stateTone: "emerald" | "amber" | "crimson" | "violet" | "neutral" = "neutral";
  let cardAuraClass = "border-white/[0.09] border-t-neutral-600";
  let skullClass = "text-ash";

  if (isRecovering) {
    stateIcon = "[RECV]";
    stateTone = "violet";
    cardAuraClass =
      "border-violet-500/45 border-t-violet-400 shadow-[0_0_20px_-8px_rgba(167,139,250,0.28)]";
    skullClass = "text-violet-400 crypt-pulse-emerald";
  } else if (isRunning || isAuditing) {
    stateIcon = isAuditing ? "[AUDIT]" : "[RUN]";
    stateTone = "emerald";
    cardAuraClass =
      "border-emerald-500/40 border-t-emerald-400 shadow-[0_0_20px_-8px_rgba(16,185,129,0.3)]";
    skullClass = "text-emerald-400 crypt-pulse-emerald";
  } else if (isAwaitingApproval || state === "queued") {
    stateIcon = isAwaitingApproval ? "[WAIT]" : "[QUEUE]";
    stateTone = "amber";
    cardAuraClass =
      "border-amber-500/45 border-t-amber-400 shadow-[0_0_20px_-8px_rgba(245,158,11,0.22)]";
    skullClass = "text-amber-400";
  } else if (isFailed || isRejected) {
    stateIcon = isRejected ? "[REJ]" : "[FAIL]";
    stateTone = "crimson";
    cardAuraClass =
      "border-rose-500/45 border-t-rose-400 shadow-[0_0_20px_-8px_rgba(244,63,94,0.22)]";
    skullClass = "text-rose-400";
  } else if (isCompleted) {
    stateIcon = "[DONE]";
    stateTone = "emerald";
    cardAuraClass = "border-emerald-500/25 border-t-emerald-300 bg-emerald-950/10";
    skullClass = "text-emerald-300";
  } else if (isLaidToRest) {
    stateIcon = "[REST]";
    stateTone = "crimson";
    cardAuraClass = "border-rose-500/30 border-t-rose-500/60";
    skullClass = "text-rose-400/80";
  }

  // Current tool call running time — compute only after mount to avoid SSR hydration clock drift.
  const activeToolStartedAt = skeleton.currentToolCall?.startedAt ?? null;
  const [clientNowMs, setClientNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (activeToolStartedAt === null) {
      setClientNowMs(null);
      return;
    }
    setClientNowMs(Date.now());
    const timer = setInterval(() => {
      setClientNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [activeToolStartedAt]);

  const toolRunningSeconds =
    activeToolStartedAt !== null && clientNowMs !== null
      ? Math.max(0, Math.floor((clientNowMs - activeToolStartedAt) / 1000))
      : 0;

  // Credits text: "credits or not reported" (Requirement 37.10)
  const creditsText =
    skeleton.credits !== null && skeleton.credits !== undefined
      ? `${skeleton.credits} credits`
      : "not reported";

  // Disabled reasons for buttons (Requirement 37.12)
  const sendInstructionDisabled = runDone || (!isRunning && !isAuditing) || isRecovering;
  const sendInstructionDisabledReason = sendInstructionDisabled
    ? runDone
      ? "Run has concluded"
      : isRecovering
      ? "Worker is recovering after restart"
      : "Skeleton is not actively running"
    : "";

  const interruptDisabled = runDone || !skeleton.currentToolCall || (!isRunning && !isAuditing);
  const interruptDisabledReason = interruptDisabled
    ? runDone
      ? "Run has concluded"
      : !isRunning && !isAuditing
      ? "Skeleton is not running"
      : "No active tool call to interrupt"
    : "";

  const reraiseDisabled = runDone || isCompleted || ((isRunning || isAuditing) && !isFailed);
  const reraiseDisabledReason = reraiseDisabled
    ? runDone
      ? "Run has concluded"
      : isCompleted
      ? "Skeleton has already finished"
      : "Skeleton is already running"
    : "";

  const layToRestDisabled = runDone || isLaidToRest || isCompleted;
  const layToRestDisabledReason = layToRestDisabled
    ? runDone
      ? "Run has concluded"
      : isCompleted
      ? "Skeleton has already finished"
      : "Skeleton has already been laid to rest"
    : "";

  const shortSha = skeleton.candidateSha256
    ? skeleton.candidateSha256.slice(0, 12)
    : null;

  const verdictLabel =
    skeleton.verdict ||
    (isCompleted
      ? "approved"
      : isRejected
      ? "rejected"
      : isFailed
      ? "failed"
      : "awaiting review");

  const verdictTone: "emerald" | "amber" | "crimson" | "neutral" =
    verdictLabel === "approved" || verdictLabel === "pass"
      ? "emerald"
      : verdictLabel === "rejected" || verdictLabel === "failed"
      ? "crimson"
      : verdictLabel === "awaiting review"
      ? "amber"
      : "neutral";

  return (
    <article
      data-ui-element="legion-skeleton-card"
      data-ui-state={uiState}
      data-skeleton-id={skeleton.skeletonId}
      className={`crypt-panel border-t-2 p-5 space-y-4 font-mono text-bone ${cardAuraClass}`}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-white/[0.08] pb-3 gap-2">
        <div className="flex items-center gap-2.5 flex-wrap">
          <CryptOrnament kind="skeleton-skull" className={`w-4 h-4 ${skullClass}`} />
          <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded border border-[var(--border-engraved)] bg-recessed text-parchment font-semibold">
            {role}
          </span>
          <span className="text-xs text-ash font-medium">
            {skeleton.skeletonId}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {silentDisplay && (
            <StatusPill tone="amber" label={silentDisplay} uiState="silent" />
          )}
          <StatusPill
            tone={stateTone}
            pulse={isRunning || isAuditing || isRecovering}
            label={`${stateIcon} ${skeleton.state || "unknown"}`}
            uiState={uiState}
          />
        </div>
      </div>

      {/* Meta Grid */}
      <div className="crypt-well grid grid-cols-2 md:grid-cols-4 gap-3 text-xs p-3">
        <div>
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Task IDs
          </span>
          <span className="text-bone mt-0.5 block">
            {skeleton.taskIds && skeleton.taskIds.length > 0
              ? skeleton.taskIds.join(", ")
              : "None"}
          </span>
        </div>

        <div>
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Attempt
          </span>
          <span className="text-bone mt-0.5 block tabular-nums">
            Attempt {skeleton.attempt || 1}
          </span>
        </div>

        <div>
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Elapsed Time
          </span>
          <span className="text-bone mt-0.5 block tabular-nums">
            {formatClock(skeleton.elapsedSeconds || 0)}
          </span>
        </div>

        <div>
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Worktree
          </span>
          <span className="text-bone truncate block mt-0.5">
            {skeleton.worktree || "default"}
          </span>
        </div>

        <div>
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Tool Calls
          </span>
          <span className="text-bone mt-0.5 block tabular-nums">
            {skeleton.toolCallsCount || 0}
          </span>
        </div>

        <div>
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Credits
          </span>
          <span className="text-bone mt-0.5 block">{creditsText}</span>
        </div>

        <div className="col-span-2">
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Last Event
          </span>
          <span className="text-parchment truncate block mt-0.5">
            {skeleton.lastEvent
              ? `${skeleton.lastEvent.kind || "event"} (#${skeleton.lastEvent.seq ?? 0})`
              : "No events recorded yet"}
          </span>
        </div>
      </div>

      {/* Current Tool Call */}
      <div className="space-y-1.5">
        <span className="text-[11px] uppercase tracking-wider text-dust block">
          Current Tool Call
        </span>
        {skeleton.currentToolCall ? (
          <div className="crypt-well border-emerald-500/30 p-3 text-xs text-amber-300 flex items-center justify-between gap-2">
            <span className="font-semibold truncate">
              Tool: {skeleton.currentToolCall.tool}
            </span>
            <span className="text-ash shrink-0 tabular-nums">
              Running for {formatClock(toolRunningSeconds)}
            </span>
          </div>
        ) : (
          <div className="crypt-well text-xs text-dust p-3">
            No active tool call
          </div>
        )}
      </div>

      {/* Optional Command Rows */}
      {skeleton.commands && skeleton.commands.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[11px] uppercase tracking-wider text-dust block">
            Executed Commands
          </span>
          <div className="space-y-2">
            {skeleton.commands.map((cmd, idx) => (
              <CommandRow key={cmd.id || `${cmd.command}-${idx}`} row={cmd} />
            ))}
          </div>
        </div>
      )}

      {/* Log Tail / Terminal Stream */}
      <div className="space-y-1.5">
        <span className="text-[11px] uppercase tracking-wider text-dust block">
          Log Tail
        </span>
        {skeleton.logs && skeleton.logs.length > 0 ? (
          <pre className="crypt-well text-xs p-3 overflow-x-auto overflow-y-auto text-parchment max-h-64 whitespace-pre-wrap leading-relaxed">
            {skeleton.logs.slice(-50).join("\n")}
          </pre>
        ) : (
          <div className="crypt-well text-xs text-dust p-3">
            No logs yet
          </div>
        )}
      </div>

      {/* Bottom Candidate SHA & Warden Verdict Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] pt-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-recessed border border-white/[0.08] text-ash">
            <span className="text-dust">candidateSha256:</span>
            <code className={shortSha ? "text-emerald-300" : "text-dust"}>
              {shortSha ? shortSha : "pending"}
            </code>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-dust uppercase tracking-wider">Warden:</span>
          <StatusPill
            tone={verdictTone}
            label={verdictLabel}
            className="text-[10px] px-2 py-0"
          />
        </div>
      </div>

      {/* Focus Reason for Disabled Buttons (Requirement 37.12) */}
      {focusedDisabledReason && (
        <div className="crypt-well text-xs text-amber-300 border-amber-500/40 bg-amber-950/30 p-2.5">
          Notice: {focusedDisabledReason}
        </div>
      )}

      {/* Instruction / review-focus composer (Requirement 37.11) */}
      {composerOpen && !showLayToRestConfirm && (
        <form
          data-testid={`skeleton-composer-${skeleton.skeletonId}`}
          onSubmit={(e) => {
            e.preventDefault();
            const text = composerText.trim();
            if (!text) return;
            if (isWarden) {
              onAddReviewFocus?.(skeleton.skeletonId, text);
            } else {
              onSendInstruction?.(skeleton.skeletonId, text);
            }
            setComposerText("");
            setComposerOpen(false);
          }}
          className="crypt-well p-3 space-y-2"
        >
          <label
            htmlFor={`skeleton-composer-input-${skeleton.skeletonId}`}
            className="block text-[11px] uppercase tracking-wider text-dust"
          >
            {isWarden ? "Review focus for the Warden" : "Instruction for this Skeleton"}
          </label>
          <textarea
            id={`skeleton-composer-input-${skeleton.skeletonId}`}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            rows={2}
            placeholder={
              isWarden
                ? "What should the Warden look at?"
                : "What should this Skeleton do next?"
            }
            className="w-full px-3 py-2 bg-transparent text-bone placeholder-neutral-500 text-xs focus:outline-none border border-white/10 rounded"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={!composerText.trim()}
              className="crypt-btn-primary px-3 py-1.5 text-xs rounded"
            >
              {isWarden ? "Add review focus" : "Send instruction"}
            </button>
            <button
              type="button"
              onClick={() => {
                setComposerOpen(false);
                setComposerText("");
              }}
              className="crypt-btn-ghost px-3 py-1.5 text-xs rounded text-ash"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Lay to Rest Confirmation (Requirement 37.13) */}
      {showLayToRestConfirm ? (
        <div className="crypt-well border-rose-500/45 bg-rose-950/30 p-3.5 space-y-2.5">
          <p className="text-xs text-rose-200">
            Lay this Skeleton to rest? Its task will become abandoned. Choose what to do with its work:
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setShowLayToRestConfirm(false);
                onLayToRest?.(skeleton.skeletonId, "keep");
              }}
              className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
            >
              Keep its commits
            </button>
            <button
              type="button"
              onClick={() => {
                setShowLayToRestConfirm(false);
                onLayToRest?.(skeleton.skeletonId, "discard");
              }}
              className="crypt-btn-danger px-3 py-1.5 text-xs rounded"
            >
              Discard its work
            </button>
            <button
              type="button"
              onClick={() => setShowLayToRestConfirm(false)}
              className="crypt-btn-ghost px-3 py-1.5 text-xs rounded text-ash"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        /* Action Buttons (Requirement 37.11) */
        <div className="flex flex-wrap gap-2 pt-2 border-t border-white/[0.08]">
          {isWarden ? (
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              disabled={sendInstructionDisabled}
              title={sendInstructionDisabledReason}
              onFocus={() => {
                if (sendInstructionDisabled) {
                  setFocusedDisabledReason(sendInstructionDisabledReason);
                }
              }}
              onBlur={() => setFocusedDisabledReason(null)}
              className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
            >
              Add review focus
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              disabled={sendInstructionDisabled}
              title={sendInstructionDisabledReason}
              onFocus={() => {
                if (sendInstructionDisabled) {
                  setFocusedDisabledReason(sendInstructionDisabledReason);
                }
              }}
              onBlur={() => setFocusedDisabledReason(null)}
              className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
            >
              Send instruction
            </button>
          )}

          <button
            type="button"
            onClick={() => onInterrupt?.(skeleton.skeletonId)}
            disabled={interruptDisabled}
            title={interruptDisabledReason}
            onFocus={() => {
              if (interruptDisabled) {
                setFocusedDisabledReason(interruptDisabledReason);
              }
            }}
            onBlur={() => setFocusedDisabledReason(null)}
            className="crypt-btn-ghost px-3 py-1.5 text-xs rounded text-amber-300 border-amber-500/30 hover:border-amber-400/50"
          >
            Interrupt
          </button>

          <button
            type="button"
            onClick={() => onReraise?.(skeleton.skeletonId)}
            disabled={reraiseDisabled}
            title={reraiseDisabledReason}
            onFocus={() => {
              if (reraiseDisabled) {
                setFocusedDisabledReason(reraiseDisabledReason);
              }
            }}
            onBlur={() => setFocusedDisabledReason(null)}
            className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
          >
            Re-raise
          </button>

          <button
            type="button"
            onClick={() => setShowLayToRestConfirm(true)}
            disabled={layToRestDisabled}
            title={layToRestDisabledReason}
            onFocus={() => {
              if (layToRestDisabled) {
                setFocusedDisabledReason(layToRestDisabledReason);
              }
            }}
            onBlur={() => setFocusedDisabledReason(null)}
            className="crypt-btn-danger px-3 py-1.5 text-xs rounded"
          >
            Lay to rest
          </button>
        </div>
      )}
    </article>
  );
}

export { LegionSkeletonCard as LegionCard };
export default LegionSkeletonCard;
