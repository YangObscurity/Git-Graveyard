"use client";

import React, { useState } from "react";

export interface CommandRowItem {
  id?: string;
  step?: string;
  command: string;
  status:
    | "running"
    | "passed"
    | "failed"
    | "not run"
    | "No tests found"
    | string;
  exitCode?: number | null;
  durationMs?: number;
  duration?: number | string;
  output?: string;
  logRef?: string;
  ruleId?: string;
  reason?: string;
  errorExcerpt?: string;
  timedOut?: boolean;
  oomKilled?: boolean;
  errorMessage?: string;
}

export interface CommandRowProps {
  row: CommandRowItem;
  onViewOutput?: (row: CommandRowItem) => void;
}

export function CommandRow({ row, onViewOutput }: CommandRowProps) {
  const [outputOpen, setOutputOpen] = useState(false);

  const statusLower = String(row.status || "").toLowerCase();
  const isRunning = statusLower === "running";
  const isPassed = statusLower === "passed";
  const isFailed = statusLower === "failed";
  const isNoTests =
    statusLower === "no tests found" || row.status === "No tests found";
  const isNotRun =
    statusLower.startsWith("not run") || statusLower === "not run";

  const uiState = isRunning
    ? "running"
    : isPassed
    ? "passed"
    : isFailed || row.timedOut || row.oomKilled
    ? "failed"
    : isNoTests
    ? "no-tests"
    : "not-run";

  function handleToggleOutput() {
    setOutputOpen((prev) => !prev);
    if (onViewOutput) {
      onViewOutput(row);
    }
  }

  // Format duration
  let durationStr = "-";
  if (typeof row.durationMs === "number" && row.durationMs >= 0) {
    if (row.durationMs < 1000) {
      durationStr = `${row.durationMs}ms`;
    } else {
      durationStr = `${(row.durationMs / 1000).toFixed(1)}s`;
    }
  } else if (typeof row.duration === "number") {
    durationStr = `${(row.duration / 1000).toFixed(1)}s`;
  } else if (typeof row.duration === "string") {
    durationStr = row.duration;
  }

  // Format exit code
  const hasExitCode = row.exitCode !== undefined && row.exitCode !== null;
  const exitCodeStr = hasExitCode ? `exit ${row.exitCode}` : "-";
  const exitCodePillStyle = !hasExitCode
    ? "border-white/10 bg-neutral-900/80 text-ash"
    : row.exitCode === 0
    ? "border-emerald-500/35 bg-emerald-950/40 text-emerald-300"
    : "border-rose-500/35 bg-rose-950/40 text-rose-300";

  // Label text for status badge
  let statusBadgeText = row.status;
  if (isNoTests) {
    statusBadgeText = row.ruleId
      ? `No tests found (${row.ruleId})`
      : "No tests found";
  } else if (row.timedOut) {
    statusBadgeText = "timedOut";
  } else if (row.oomKilled) {
    statusBadgeText = "oomKilled";
  } else if (isNotRun && row.reason) {
    statusBadgeText = `Not run: ${row.reason}`;
  }

  // Error message for plain-English explanation
  const plainErrorMessage =
    row.errorMessage ||
    (isFailed && row.errorExcerpt
      ? row.errorExcerpt
      : isFailed && row.exitCode !== undefined && row.exitCode !== 0
      ? `Command exited with non-zero status code ${row.exitCode}.`
      : null);

  return (
    <div
      data-testid="command-row"
      data-ui-element="command-row"
      data-ui-state={uiState}
      data-ui-variant={outputOpen ? "expanded" : "collapsed"}
      data-step={row.step}
      data-status={row.status}
      className="crypt-well p-3 font-mono text-xs space-y-2 border-white/10"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        {/* Command line and Step label */}
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {row.step && (
            <span className="px-1.5 py-0.5 rounded bg-neutral-900 text-ash text-[10px] uppercase font-semibold border border-white/10">
              {row.step}
            </span>
          )}
          <code
            data-testid="command-row-cmd"
            className="text-bone font-semibold truncate max-w-md"
            title={row.command}
          >
            {row.command}
          </code>
        </div>

        {/* Status, Exit code, Duration & Actions */}
        <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
          {/* Status Badge */}
          <span
            data-testid="command-row-status"
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium border ${
              isRunning
                ? "bg-amber-950/45 border-[var(--arcane-amber-border)] text-amber-300 crypt-pulse-emerald"
                : isPassed
                ? "bg-emerald-950/45 border-[var(--necromancy-emerald-border)] text-emerald-300"
                : isFailed || row.timedOut || row.oomKilled
                ? "bg-rose-950/45 border-[var(--crimson-seal-border)] text-rose-300"
                : isNoTests
                ? "bg-amber-950/35 border-amber-500/30 text-amber-300"
                : "bg-neutral-900/90 border-white/15 text-ash"
            }`}
          >
            {statusBadgeText}
          </span>

          {/* Exit Code Pill */}
          <span
            data-testid="command-row-exit-code"
            className={`px-1.5 py-0.5 rounded border text-[11px] min-w-12 text-center ${exitCodePillStyle}`}
          >
            {exitCodeStr}
          </span>

          {/* Duration */}
          <span
            data-testid="command-row-duration"
            className="text-ash text-[11px] min-w-12 text-right tabular-nums"
          >
            {durationStr}
          </span>

          {/* View output button */}
          <button
            type="button"
            onClick={handleToggleOutput}
            data-testid="command-row-view-output"
            className="crypt-btn-ghost px-2 py-0.5 rounded text-[11px]"
          >
            {outputOpen ? "Hide output" : "View output"}
          </button>
        </div>
      </div>

      {/* Special status tags: oomKilled, timedOut */}
      {(row.oomKilled || row.timedOut) && (
        <div className="text-[11px] text-rose-400">
          {row.timedOut && (
            <span className="mr-2">
              Reason: Command exceeded maximum execution time limit.
            </span>
          )}
          {row.oomKilled && (
            <span>
              Reason: Process was terminated due to memory exhaustion (out of memory).
            </span>
          )}
        </div>
      )}

      {/* Plain English error notice */}
      {isFailed && plainErrorMessage && (
        <div
          data-testid="command-row-plain-error"
          className="p-2 rounded bg-rose-950/30 border border-rose-500/35 border-l-2 border-l-rose-500 text-rose-300 text-[11px]"
        >
          <span className="font-semibold block mb-0.5">Execution Finding:</span>
          <span>{plainErrorMessage}</span>
        </div>
      )}

      {/* Collapsible output display */}
      {outputOpen && (
        <div
          data-testid="command-row-output-box"
          className="pt-2 border-t border-white/10 space-y-1.5"
        >
          <div className="text-[10px] uppercase tracking-wider text-dust font-semibold">
            Command Output / Log
          </div>
          <pre
            data-testid="command-row-output-text"
            className="p-3 rounded bg-[#030406] border border-white/10 text-[11px] text-parchment overflow-x-auto overflow-y-auto whitespace-pre-wrap max-h-60"
          >
            {row.output || row.errorExcerpt || "No output recorded for this command."}
          </pre>
        </div>
      )}
    </div>
  );
}
