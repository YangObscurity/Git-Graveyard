"use client";

import React, { useState } from "react";

/** The three kill-switch levels, named exactly as the Admin API expects them. */
export type KillSwitchModalLevel = "pause_new_runs" | "stop_gracefully" | "hard_kill";

export const KILL_SWITCH_LEVELS: readonly KillSwitchModalLevel[] = [
  "pause_new_runs",
  "stop_gracefully",
  "hard_kill",
];

export interface KillSwitchLevelCopy {
  title: string;
  detail: string;
}

export const KILL_SWITCH_LEVEL_COPY: Record<KillSwitchModalLevel, KillSwitchLevelCopy> = {
  pause_new_runs: {
    title: "Pause new runs",
    detail: "New runs are not admitted. Queued runs stay queued and keep their place.",
  },
  stop_gracefully: {
    title: "Stop gracefully",
    detail:
      "Running Skeletons end at their next tool boundary. Their worktrees are kept.",
  },
  hard_kill: {
    title: "Hard kill",
    detail: "Active and queued runs are terminated immediately with outcome killed.",
  },
};

function safeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Plain-English summary of exactly how many runs a level affects. */
export function killSwitchAffectedSummary(
  level: KillSwitchModalLevel,
  activeRunCount: number | undefined,
  queuedRunCount: number | undefined
): string {
  const active = safeCount(activeRunCount);
  const queued = safeCount(queuedRunCount);
  switch (level) {
    case "pause_new_runs":
      return `Affects ${queued} queued run${queued === 1 ? "" : "s"}; no running run is stopped.`;
    case "stop_gracefully":
      return `Affects ${active} running run${active === 1 ? "" : "s"}; ${queued} queued run${
        queued === 1 ? "" : "s"
      } stay queued.`;
    case "hard_kill":
      return `Affects ${active} active and ${queued} queued run${queued === 1 ? "" : "s"}.`;
    default:
      return "Affects no runs.";
  }
}

/**
 * The exact phrase the operator must type before a level can be executed. It
 * states the number of active and queued runs the action affects, so the
 * confirmation cannot be given without reading the blast radius.
 */
export function killSwitchConfirmationPhrase(
  level: KillSwitchModalLevel,
  activeRunCount: number | undefined,
  queuedRunCount: number | undefined
): string {
  const active = safeCount(activeRunCount);
  const queued = safeCount(queuedRunCount);
  switch (level) {
    case "pause_new_runs":
      return `PAUSE ${queued} QUEUED`;
    case "stop_gracefully":
      return `STOP ${active} RUNNING`;
    case "hard_kill":
      return `KILL ${active} ACTIVE ${queued} QUEUED`;
    default:
      return "KILL 0 ACTIVE 0 QUEUED";
  }
}

export interface KillSwitchModalProps {
  open?: boolean;
  activeRunCount?: number;
  queuedRunCount?: number;
  onClose?: () => void;
  onConfirm?: (level: KillSwitchModalLevel, phrase: string) => void;
}

export function KillSwitchModal({
  open = true,
  activeRunCount = 0,
  queuedRunCount = 0,
  onClose,
  onConfirm,
}: KillSwitchModalProps) {
  const [selected, setSelected] = useState<KillSwitchModalLevel>("pause_new_runs");
  const [typed, setTyped] = useState<string>("");

  if (!open) {
    return null;
  }

  const phrase = killSwitchConfirmationPhrase(selected, activeRunCount, queuedRunCount);
  const armed = typed.trim() === phrase;

  return (
    <div
      data-testid="kill-switch-modal"
      data-ui-element="kill-switch-modal"
      data-ui-state="open"
      role="dialog"
      aria-modal="true"
      aria-label="Kill switch"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 font-mono"
    >
      <div className="crypt-panel-engraved w-full max-w-2xl p-5 space-y-4 max-h-[90vh] overflow-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-bone">Kill switch</h2>
            <p className="text-xs text-ash mt-1">
              Every level halts new admission. Each level states how many active and
              queued runs it affects before it acts.
            </p>
          </div>
          {onClose ? (
            <button
              type="button"
              data-testid="kill-switch-close"
              onClick={onClose}
              className="crypt-btn-ghost px-3 py-1 rounded text-xs"
            >
              Close
            </button>
          ) : null}
        </div>

        <div className="space-y-3">
          {KILL_SWITCH_LEVELS.map((level) => {
            const copy = KILL_SWITCH_LEVEL_COPY[level];
            const levelPhrase = killSwitchConfirmationPhrase(
              level,
              activeRunCount,
              queuedRunCount
            );
            const isSelected = selected === level;
            return (
              <div
                key={level}
                data-testid={`kill-switch-level-${level}`}
                data-ui-state={isSelected ? "selected" : "idle"}
                className={`crypt-well p-3.5 space-y-2 border ${
                  isSelected ? "border-[var(--crimson-seal-border)]" : "border-white/10"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-bone">{copy.title}</span>
                  <button
                    type="button"
                    data-testid={`kill-switch-select-${level}`}
                    onClick={() => {
                      setSelected(level);
                      setTyped("");
                    }}
                    className="crypt-btn-ghost px-2.5 py-1 rounded text-[11px]"
                  >
                    {isSelected ? "Selected" : "Select"}
                  </button>
                </div>
                <p className="text-xs text-ash">{copy.detail}</p>
                <p
                  data-testid={`kill-switch-affected-${level}`}
                  className="text-xs text-parchment"
                >
                  {killSwitchAffectedSummary(level, activeRunCount, queuedRunCount)}
                </p>
                <p className="text-[11px] text-dust">
                  Type <span className="text-amber-200">{levelPhrase}</span> to confirm.
                </p>
              </div>
            );
          })}
        </div>

        <div className="space-y-2 border-t border-white/10 pt-3">
          <label htmlFor="kill-switch-confirmation" className="text-xs text-ash block">
            Confirmation phrase for {KILL_SWITCH_LEVEL_COPY[selected].title}
          </label>
          <input
            id="kill-switch-confirmation"
            data-testid="kill-switch-confirmation-input"
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={phrase}
            className="w-full crypt-well px-3 py-1.5 text-xs text-bone placeholder:text-dust focus:outline-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span data-testid="kill-switch-required-phrase" className="text-[11px] text-dust">
              Required phrase: <span className="text-amber-200">{phrase}</span>
            </span>
            <button
              type="button"
              data-testid="kill-switch-confirm"
              disabled={!armed}
              onClick={() => {
                if (!armed) return;
                if (onConfirm) onConfirm(selected, phrase);
              }}
              className="crypt-btn-primary px-3 py-1.5 rounded text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Execute {KILL_SWITCH_LEVEL_COPY[selected].title}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default KillSwitchModal;