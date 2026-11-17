"use client";

import React from "react";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";

export interface LegionWaitingRoomCardProps {
  position?: number | null;
  ahead?: number | null;
  runId?: string;
  estimatedWait?: string | null;
  status?: "queued" | "starting";
  onCancel?: () => void;
  cancelling?: boolean;
  cancelError?: string | null;
}

export function LegionWaitingRoomCard({
  position,
  ahead,
  runId,
  estimatedWait,
  status = "queued",
  onCancel,
  cancelling = false,
  cancelError,
}: LegionWaitingRoomCardProps) {
  const displayPosition =
    typeof position === "number" && position >= 0
      ? `#${position}`
      : "in queue";

  const displayAhead =
    typeof ahead === "number" && ahead >= 0
      ? `${ahead} run${ahead === 1 ? "" : "s"} ahead`
      : "calculating queue position";

  return (
    <div
      data-ui-element="legion-waiting-room"
      data-ui-state={status}
      data-run-id={runId}
      className="crypt-panel-engraved p-6 space-y-5 font-mono text-bone border-amber-500/35"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-white/[0.08] pb-4 gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded border border-amber-500/30 bg-amber-950/30 text-amber-400 shrink-0">
            <CryptOrnament kind="arch-sigil" className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-bone">Waiting Room</h2>
              <StatusPill
                tone="amber"
                pulse
                label={status === "starting" ? "Starting" : "Queued"}
                uiState={status}
              />
            </div>
            <p className="text-sm text-ash mt-1">Your place is kept</p>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <span className="text-[11px] uppercase tracking-wider text-dust block">
            Queue Status
          </span>
          <span className="text-lg font-bold text-amber-300 tabular-nums">
            {displayPosition}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-1">
        <div className="crypt-well p-4 space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider text-dust">
            Catacomb Slot Position
          </div>
          <div className="text-2xl font-bold text-bone tabular-nums">
            {displayPosition}
          </div>
          <div className="text-xs text-ash">{displayAhead}</div>
          {estimatedWait && (
            <div className="text-[11px] text-amber-300/90 pt-1">
              Est. wait: {estimatedWait}
            </div>
          )}
        </div>

        <div className="crypt-well p-4 flex flex-col justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-dust">
              Notice
            </div>
            <div className="text-sm text-parchment mt-1">
              Your place is kept while sandboxes are provisioned and execution slots become available.
            </div>
          </div>
          <div>
            <a
              href="/history"
              className="text-xs text-emerald-400 hover:text-emerald-300 underline underline-offset-4 transition-colors"
            >
              Watch the Replay of a recorded run while waiting →
            </a>
          </div>
        </div>
      </div>

      {cancelError && (
        <div className="crypt-well border-l-2 border-l-rose-500 border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-300">
          Error cancelling run: {cancelError}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-white/[0.06]">
        <span className="text-xs text-ash">
          You can leave this page. The run keeps going.
        </span>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="crypt-btn-danger px-4 py-2 text-xs rounded"
        >
          {cancelling ? "Cancelling..." : "Cancel"}
        </button>
      </div>
    </div>
  );
}

export default LegionWaitingRoomCard;
