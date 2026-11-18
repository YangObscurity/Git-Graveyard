"use client";

import React from "react";
import { StatusPill } from "./ui/StatusPill";

export interface LegionRunHeaderProps {
  runId: string;
  phase: string;
  repoTarget?: string;
  isReconnecting?: boolean;
  isOffline?: boolean;
  tasksMerged?: number;
  tasksTotal?: number;
  latestToolCall?: {
    tool: string;
    skeletonId?: string;
    args?: unknown;
  } | null;
  pendingActionsCount?: number;
  pendingActionDescription?: string | null;
  elapsedSeconds?: number;
  toolCallsUsed?: number;
  /** Recorded ceiling; omit when the run has none recorded. */
  toolCallsCap?: number | null;
  wallClockMinutes?: number;
  /** Recorded ceiling; omit when the run has none recorded. */
  wallClockCapMinutes?: number | null;
  creditsUsed?: number | null;
  creditsCap?: number | null;
}

const PHASES: readonly string[] = [
  "queued",
  "exhume",
  "plan",
  "pact_review",
  "legion",
  "final_check",
  "report",
  "done",
] as const;

function formatClock(seconds: number): string {
  const safeSec = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safeSec / 60);
  const secs = safeSec % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function getBurnBarColor(ratio: number): string {
  if (ratio > 0.9) {
    return "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.45)]";
  }
  if (ratio >= 0.75) {
    return "bg-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.35)]";
  }
  return "bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.35)]";
}

function getPhaseTone(
  phaseLower: string
): "emerald" | "amber" | "crimson" | "violet" | "neutral" {
  if (phaseLower === "done") return "emerald";
  if (phaseLower === "queued" || phaseLower === "pact_review") return "amber";
  if (phaseLower === "final_check" || phaseLower === "report") return "violet";
  if (phaseLower === "legion" || phaseLower === "exhume" || phaseLower === "plan") {
    return "emerald";
  }
  return "neutral";
}

export function LegionRunHeader({
  runId,
  phase,
  repoTarget,
  isReconnecting = false,
  isOffline = false,
  tasksMerged,
  tasksTotal,
  latestToolCall,
  pendingActionsCount = 0,
  pendingActionDescription,
  elapsedSeconds = 0,
  toolCallsUsed = 0,
  toolCallsCap = null,
  wallClockMinutes = 0,
  wallClockCapMinutes = null,
  creditsUsed = null,
  creditsCap = null,
}: LegionRunHeaderProps) {
  const phaseLower = (phase || "queued").toLowerCase();
  const currentPhaseIndex = PHASES.indexOf(phaseLower);

  const headerUiState: "connected" | "reconnecting" | "offline" | "completed" =
    phaseLower === "done"
      ? "completed"
      : isOffline
      ? "offline"
      : isReconnecting
      ? "reconnecting"
      : "connected";

  // Format "Now" sentence from latest skeleton.tool_call (Requirement 37.1)
  let nowSentence = "Now: Waiting for next tool call";
  if (latestToolCall) {
    const skelPrefix = latestToolCall.skeletonId ? `${latestToolCall.skeletonId}: ` : "";
    nowSentence = `Now: ${skelPrefix}running ${latestToolCall.tool}`;
  }

  // Credits display: "credits or not reported" (Requirement 37.10)
  const creditsText =
    creditsUsed !== null && creditsUsed !== undefined
      ? `${creditsUsed}${creditsCap ? ` / ${creditsCap}` : ""} credits`
      : "not reported";

  const toolCallRatio =
    toolCallsCap && toolCallsCap > 0 ? Math.min(1, toolCallsUsed / toolCallsCap) : 0;
  const wallClockRatio =
    wallClockCapMinutes && wallClockCapMinutes > 0
      ? Math.min(1, wallClockMinutes / wallClockCapMinutes)
      : 0;
  const creditsRatio =
    creditsUsed !== null && creditsCap && creditsCap > 0
      ? Math.min(1, creditsUsed / creditsCap)
      : null;

  const hasTaskProgress = typeof tasksTotal === "number" && tasksTotal > 0;
  const totalSegments = hasTaskProgress ? Math.min(tasksTotal!, 12) : PHASES.length;
  const completedSegments = hasTaskProgress
    ? Math.round(((tasksMerged ?? 0) / tasksTotal!) * totalSegments)
    : Math.max(0, currentPhaseIndex + 1);

  return (
    <header
      data-ui-element="legion-header"
      data-ui-state={headerUiState}
      className="crypt-panel-engraved p-4 md:p-5 space-y-4 font-mono text-bone"
    >
      {/* Top Banner: Run ID, Repo Target, Phase Pill, SSE Live Indicator & Leave Notice */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between border-b border-white/[0.08] pb-3 gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[11px] uppercase tracking-wider bg-recessed text-ash px-2 py-0.5 rounded border border-[var(--border-engraved)]">
            Run
          </span>
          <span className="text-sm font-bold text-bone tracking-tight">{runId}</span>
          {repoTarget && (
            <span className="text-xs text-parchment bg-recessed border border-white/[0.08] px-2 py-0.5 rounded truncate max-w-[220px]">
              {repoTarget}
            </span>
          )}
          <StatusPill
            tone={getPhaseTone(phaseLower)}
            pulse={phaseLower !== "done"}
            label={phase.replace("_", " ")}
            uiState={phaseLower}
          />
          {/* SSE Live Stream Indicator */}
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider ${
              headerUiState === "reconnecting"
                ? "border-[var(--arcane-amber-border)] bg-amber-950/40 text-amber-300"
                : headerUiState === "offline"
                ? "border-[var(--crimson-seal-border)] bg-rose-950/40 text-rose-300"
                : "border-[var(--necromancy-emerald-border)] bg-emerald-950/35 text-emerald-300"
            }`}
          >
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${
                headerUiState === "reconnecting"
                  ? "bg-amber-400 crypt-pulse-emerald"
                  : headerUiState === "offline"
                  ? "bg-rose-400"
                  : headerUiState === "completed"
                  ? "bg-emerald-400"
                  : "bg-emerald-400 crypt-pulse-emerald"
              }`}
            />
            {headerUiState === "reconnecting"
              ? "RECONNECTING"
              : headerUiState === "offline"
              ? "OFFLINE"
              : headerUiState === "completed"
              ? "STREAM CLOSED"
              : "CONNECTED"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 justify-between lg:justify-end">
          {/* Segmented Progress Bar */}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-dust uppercase tracking-wider">
              {hasTaskProgress
                ? `Tasks ${tasksMerged ?? 0}/${tasksTotal}`
                : `Stage ${Math.max(1, currentPhaseIndex + 1)}/${PHASES.length}`}
            </span>
            <div className="flex items-center gap-0.5" aria-hidden="true">
              {Array.from({ length: totalSegments }).map((_, idx) => {
                const filled = idx < completedSegments;
                return (
                  <span
                    key={idx}
                    className={`h-2 w-2.5 rounded-[2px] border ${
                      filled
                        ? "bg-emerald-400/85 border-emerald-300/60"
                        : "bg-recessed border-white/10"
                    }`}
                  />
                );
              })}
            </div>
          </div>

          <div className="text-xs text-ash">
            You can leave this page. The run keeps going.
          </div>
        </div>
      </div>

      {/* Stage Ribbon (Requirement 37.1) */}
      <nav aria-label="Run Phase Progression">
        <ol className="grid grid-cols-4 md:grid-cols-8 gap-1.5 text-center text-xs">
          {PHASES.map((p, idx) => {
            const isActive = p.toLowerCase() === phaseLower;
            const isPast = currentPhaseIndex !== -1 && idx < currentPhaseIndex;

            let stageClass =
              "border-white/[0.06] bg-recessed text-dust";
            if (isActive) {
              stageClass =
                "border-[var(--necromancy-emerald-border)] bg-emerald-950/50 text-emerald-300 font-bold shadow-[0_0_16px_-6px_rgba(16,185,129,0.55)]";
            } else if (isPast) {
              stageClass =
                "border-[var(--border-engraved)] bg-slab text-parchment";
            }

            return (
              <li
                key={p}
                className={`py-1.5 px-1 rounded border uppercase text-[11px] truncate transition-colors ${stageClass}`}
                title={`Phase: ${p}`}
              >
                {p.replace("_", " ")}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* "Now" sentence and "You" slot (Requirement 37.1, 37.4) */}
      <div className="crypt-well grid grid-cols-1 md:grid-cols-2 gap-3 text-xs p-3">
        <div className="flex items-center space-x-2 min-w-0">
          <span className="text-dust font-semibold shrink-0">[Now]</span>
          <span className="text-amber-300 truncate" title={nowSentence}>
            {nowSentence}
          </span>
        </div>

        <div className="flex items-center space-x-2 min-w-0">
          <span className="text-dust font-semibold shrink-0">[You]</span>
          {pendingActionsCount > 0 ? (
            <div className="flex items-center space-x-2 truncate">
              <span className="px-1.5 py-0.5 rounded bg-amber-950/80 text-amber-200 border border-[var(--arcane-amber-border)] font-bold shrink-0">
                [!] {pendingActionsCount} action{pendingActionsCount === 1 ? "" : "s"}
              </span>
              <span className="text-bone truncate">
                {pendingActionDescription || "Action required"}
              </span>
            </div>
          ) : (
            <span className="text-ash">No actions needed right now</span>
          )}
        </div>
      </div>

      {/* Clocks & Dual Budget Burn Meters (Requirement 37.1) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="crypt-well p-2.5">
          <span className="text-dust text-[11px] uppercase tracking-wider block">
            Run Clock
          </span>
          <span className="text-bone text-sm font-bold tabular-nums mt-0.5 block">
            {formatClock(elapsedSeconds)}
          </span>
        </div>

        <div className="crypt-well p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-dust text-[11px] uppercase tracking-wider">
              Tool Calls Meter
            </span>
            <span className="text-bone tabular-nums font-medium">
              {toolCallsUsed}
              {toolCallsCap ? ` / ${toolCallsCap}` : " (cap not reported)"}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-neutral-900 overflow-hidden border border-white/[0.06]">
            <div
              className={`h-full rounded-full transition-all duration-300 ${getBurnBarColor(
                toolCallRatio
              )}`}
              style={{ width: `${Math.round(toolCallRatio * 100)}%` }}
            />
          </div>
        </div>

        <div className="crypt-well p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-dust text-[11px] uppercase tracking-wider">
              Wall Clock Meter
            </span>
            <span className="text-bone tabular-nums font-medium">
              {wallClockMinutes}m
              {wallClockCapMinutes ? ` / ${wallClockCapMinutes}m` : " (cap not reported)"}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-neutral-900 overflow-hidden border border-white/[0.06]">
            <div
              className={`h-full rounded-full transition-all duration-300 ${getBurnBarColor(
                wallClockRatio
              )}`}
              style={{ width: `${Math.round(wallClockRatio * 100)}%` }}
            />
          </div>
        </div>

        <div className="crypt-well p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-dust text-[11px] uppercase tracking-wider">
              Credits Meter
            </span>
            <span className="text-bone tabular-nums font-medium">{creditsText}</span>
          </div>
          {creditsRatio !== null ? (
            <div className="h-1.5 w-full rounded-full bg-neutral-900 overflow-hidden border border-white/[0.06]">
              <div
                className={`h-full rounded-full transition-all duration-300 ${getBurnBarColor(
                  creditsRatio
                )}`}
                style={{ width: `${Math.round(creditsRatio * 100)}%` }}
              />
            </div>
          ) : (
            <div className="h-1.5 w-full rounded-full bg-neutral-900/60 border border-white/[0.04]" />
          )}
        </div>
      </div>
    </header>
  );
}

export default LegionRunHeader;
