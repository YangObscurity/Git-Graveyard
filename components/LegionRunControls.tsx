"use client";

import React, { useState } from "react";
import { StatusPill } from "./ui/StatusPill";

export interface LegionRunControlsProps {
  runId: string;
  isPaused: boolean;
  isAdmin?: boolean;
  phase?: string;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onKill?: () => void;
  disabled?: boolean;
}

export function LegionRunControls({
  runId,
  isPaused,
  isAdmin = false,
  phase,
  onPause,
  onResume,
  onStop,
  onKill,
  disabled = false,
}: LegionRunControlsProps) {
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showKillConfirm, setShowKillConfirm] = useState(false);

  const normalizedPhase = (phase || "").toLowerCase();
  const uiState =
    normalizedPhase === "done"
      ? "terminal"
      : isPaused
      ? "paused"
      : normalizedPhase === "queued"
      ? "queued"
      : "running";
  const controlsDisabled = disabled || uiState === "terminal";

  return (
    <div
      data-ui-element="legion-controls"
      data-ui-state={uiState}
      data-ui-variant={isAdmin ? "admin" : "standard"}
      data-run-id={runId}
      className="crypt-panel p-4 font-mono text-bone"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <span className="text-[11px] uppercase tracking-wider text-dust block">
              Command Controls
            </span>
            <span className="text-sm font-semibold text-bone">
              Run State: {isPaused ? "Paused" : uiState === "terminal" ? "Terminal" : "Active"}
            </span>
          </div>
          <StatusPill
            tone={isPaused ? "amber" : uiState === "terminal" ? "neutral" : "emerald"}
            pulse={!isPaused && uiState !== "terminal"}
            label={isPaused ? "Paused" : uiState === "terminal" ? "Concluded" : "Active"}
            uiState={uiState}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Pause / Resume (Requirement 37.15) */}
          {isPaused ? (
            <button
              type="button"
              onClick={onResume}
              disabled={controlsDisabled}
              className="crypt-btn-primary px-3 py-1.5 text-xs rounded"
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              onClick={onPause}
              disabled={controlsDisabled}
              className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
            >
              Pause run
            </button>
          )}

          {/* Stop run behind confirmation (Requirement 37.15) */}
          {showStopConfirm ? (
            <div className="crypt-well flex items-center space-x-1.5 border-rose-500/40 px-2.5 py-1">
              <span className="text-xs text-rose-200">Stop run?</span>
              <button
                type="button"
                onClick={() => {
                  setShowStopConfirm(false);
                  onStop?.();
                }}
                disabled={controlsDisabled}
                className="crypt-btn-danger px-2.5 py-0.5 text-xs rounded"
              >
                Confirm stop
              </button>
              <button
                type="button"
                onClick={() => setShowStopConfirm(false)}
                className="crypt-btn-ghost px-2 py-0.5 text-xs rounded"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowStopConfirm(true)}
              disabled={controlsDisabled}
              className="crypt-btn-danger px-3 py-1.5 text-xs rounded"
            >
              Stop run
            </button>
          )}

          {/* Kill shown ONLY to Admin (Requirement 37.15) */}
          {isAdmin &&
            (showKillConfirm ? (
              <div className="crypt-well flex items-center space-x-1.5 border-rose-500/60 bg-rose-950/60 px-2.5 py-1">
                <span className="text-xs text-rose-200 font-semibold">Force kill run?</span>
                <button
                  type="button"
                  onClick={() => {
                    setShowKillConfirm(false);
                    onKill?.();
                  }}
                  disabled={controlsDisabled}
                  className="crypt-btn-danger px-2.5 py-0.5 text-xs rounded font-semibold"
                >
                  Confirm kill
                </button>
                <button
                  type="button"
                  onClick={() => setShowKillConfirm(false)}
                  className="crypt-btn-ghost px-2 py-0.5 text-xs rounded"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowKillConfirm(true)}
                disabled={controlsDisabled}
                className="crypt-btn-danger px-3 py-1.5 text-xs rounded"
                title="Admin only command"
              >
                Kill
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

export default LegionRunControls;
