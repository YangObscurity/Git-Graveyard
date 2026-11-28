"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

/** Selector matching every control that can receive keyboard focus inside a dialog. */
export const KILL_SWITCH_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Returns the focusable controls inside a container, in DOM order. */
export function getKillSwitchFocusableElements(
  container: HTMLElement | null
): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(KILL_SWITCH_FOCUSABLE_SELECTOR)
  ).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true"
  );
}

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
  error?: string | null;
}

export function KillSwitchModal({
  open = true,
  activeRunCount = 0,
  queuedRunCount = 0,
  onClose,
  onConfirm,
  error,
}: KillSwitchModalProps) {
  const [selected, setSelected] = useState<KillSwitchModalLevel>("pause_new_runs");
  const [typed, setTyped] = useState<string>("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Reset the selected level and typed phrase every time the modal opens so a
  // previously armed confirmation never survives a close and reopen.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSelected("pause_new_runs");
      setTyped("");
    }
    wasOpenRef.current = open;
  }, [open]);

  // W3C dialog pattern: move focus into the dialog on open, trap Tab/Shift+Tab,
  // and return focus to the previously focused element when it closes.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const first = getKillSwitchFocusableElements(dialogRef.current)[0];
    if (first) first.focus();
    return () => {
      const previous = restoreFocusRef.current;
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (onCloseRef.current) onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getKillSwitchFocusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) {
    return null;
  }

  const phrase = killSwitchConfirmationPhrase(selected, activeRunCount, queuedRunCount);
  const armed = typed.trim() === phrase;

  const handleConfirm = () => {
    if (!armed) return;
    if (onConfirm) onConfirm(selected, phrase);
    // Reset after a successful execute so the modal cannot stay armed.
    setSelected("pause_new_runs");
    setTyped("");
  };

  return (
    <div
      ref={dialogRef}
      onKeyDown={handleKeyDown}
      data-testid="kill-switch-modal"
      data-ui-element="kill-switch-modal"
      data-ui-state="open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kill-switch-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 font-mono"
    >
      <div className="crypt-panel-engraved w-full max-w-2xl p-5 space-y-4 max-h-[90vh] overflow-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="kill-switch-title" className="text-lg font-bold text-bone">Kill switch</h2>
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
              onClick={handleConfirm}
              className="crypt-btn-primary px-3 py-1.5 rounded text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Execute {KILL_SWITCH_LEVEL_COPY[selected].title}
            </button>
          </div>
          {error ? (
            <p data-testid="kill-switch-error" className="text-xs text-red-300">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default KillSwitchModal;