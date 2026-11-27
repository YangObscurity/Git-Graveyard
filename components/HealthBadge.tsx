"use client";

import React, { useEffect, useState } from "react";

export type LiveRunBadgeStatus =
  | "open"
  | "queue length"
  | "paused by owner"
  | "unavailable"
  | "loading";

export interface HealthBadgeProps {
  status?: string;
  queueLength?: number;
  badgeText?: string;
  loading?: boolean;
  /**
   * Production mode. In production the badge never says "waking up"; an
   * unreadable admission state is reported as "Live runs: unavailable".
   */
  isProd?: boolean;
  environment?: string;
  /** Admission is stopped because the invite code was rejected. */
  authFailure?: boolean;
  /** Live runs could not be read at all. */
  liveRunsUnavailable?: boolean;
}

const STATUS_STYLE_MAP: Record<string, string> = {
  loading:
    "bg-[#0b0d11]/90 border-white/15 text-neutral-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
  open:
    "bg-emerald-950/35 border-[var(--necromancy-emerald-border)] text-emerald-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_18px_-6px_rgba(16,185,129,0.45)]",
  queue:
    "bg-amber-950/35 border-[var(--arcane-amber-border)] text-amber-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_18px_-6px_rgba(245,158,11,0.4)]",
  paused:
    "bg-amber-950/35 border-[var(--arcane-amber-border)] text-amber-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_18px_-6px_rgba(245,158,11,0.35)]",
  unavailable:
    "bg-rose-950/35 border-[var(--crimson-seal-border)] text-rose-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_18px_-6px_rgba(244,63,94,0.4)]",
};

export function HealthBadge({
  status: propStatus,
  queueLength: propQueueLength,
  badgeText: propBadgeText,
  loading: propLoading,
  isProd: propIsProd,
  environment,
  authFailure = false,
  liveRunsUnavailable = false,
}: HealthBadgeProps = {}) {
  const [internalStatus, setInternalStatus] = useState<string | null>(null);
  const [internalQueueLength, setInternalQueueLength] = useState<number>(0);
  const [internalBadgeText, setInternalBadgeText] = useState<string | null>(null);
  const [internalLoading, setInternalLoading] = useState<boolean>(true);

  const isControlled =
    propStatus !== undefined ||
    propBadgeText !== undefined ||
    propLoading !== undefined ||
    authFailure ||
    liveRunsUnavailable;

  useEffect(() => {
    if (isControlled) {
      return;
    }
    let cancelled = false;

    async function checkHealth() {
      try {
        setInternalLoading(true);
        const res = await fetch("/api/health");
        if (!res.ok) {
          if (!cancelled) {
            setInternalStatus("unavailable");
            setInternalBadgeText("Live runs: unavailable");
            setInternalLoading(false);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          const status = data.status || data.liveRunStatus || "unavailable";
          const qLength =
            typeof data.queueLength === "number" ? data.queueLength : 0;
          const text =
            data.badgeText ||
            (status === "open"
              ? "Live runs: open"
              : status === "queue length" || qLength > 0
              ? `Live runs: queue is ${qLength} long`
              : status === "paused by owner" || status === "paused"
              ? "Live runs: paused by the owner"
              : "Live runs: unavailable");
          setInternalStatus(status);
          setInternalQueueLength(qLength);
          setInternalBadgeText(text);
          setInternalLoading(false);
        }
      } catch {
        if (!cancelled) {
          setInternalStatus("unavailable");
          setInternalBadgeText("Live runs: unavailable");
          setInternalLoading(false);
        }
      }
    }

    checkHealth();
    return () => {
      cancelled = true;
    };
  }, [isControlled]);

  const loading = isControlled ? Boolean(propLoading) : internalLoading;
  const status = isControlled ? propStatus : internalStatus;
  const queueLength = isControlled ? propQueueLength ?? 0 : internalQueueLength;
  const badgeText = isControlled ? propBadgeText : internalBadgeText;

  let displayText = "Checking the crypt...";
  let statusKey = "loading";

  if (!loading) {
    if (badgeText) {
      displayText = badgeText;
      if (displayText === "Live runs: open") {
        statusKey = "open";
      } else if (displayText.startsWith("Live runs: queue is")) {
        statusKey = "queue";
      } else if (displayText === "Live runs: paused by the owner") {
        statusKey = "paused";
      } else {
        statusKey = "unavailable";
      }
    } else if (status === "open") {
      displayText = "Live runs: open";
      statusKey = "open";
    } else if (status === "queue length" || queueLength > 0) {
      displayText = `Live runs: queue is ${queueLength} long`;
      statusKey = "queue";
    } else if (status === "paused by owner" || status === "paused") {
      displayText = "Live runs: paused by the owner";
      statusKey = "paused";
    } else {
      displayText = "Live runs: unavailable";
      statusKey = "unavailable";
    }
  }

  // Ensure "waking up" is never displayed in production mode (Requirement 34.2).
  // Outside production the phrase may be shown, but never in production.
  const isProd =
    typeof propIsProd === "boolean"
      ? propIsProd
      : (environment ?? "").toLowerCase() === "production";
  if (isProd && displayText.toLowerCase().includes("waking up")) {
    displayText = "Live runs: unavailable";
    statusKey = "unavailable";
  }

  // Admission stopped by an auth failure, or live runs that cannot be read at
  // all, are both reported plainly as unavailable.
  if (!loading && (authFailure || liveRunsUnavailable)) {
    displayText = "Live runs: unavailable";
    statusKey = "unavailable";
  }

  const toneClasses = STATUS_STYLE_MAP[statusKey] ?? STATUS_STYLE_MAP.unavailable;

  return (
    <div
      data-testid="health-badge"
      data-ui-element="health-badge"
      data-ui-state={statusKey}
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono border backdrop-blur-xs transition-colors ${toneClasses}`}
      role="status"
      aria-live="polite"
    >
      {statusKey === "loading" && (
        <svg
          data-testid="health-badge-icon-loading"
          className="w-3.5 h-3.5 animate-spin text-neutral-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
      )}

      {statusKey === "open" && (
        <svg
          data-testid="health-badge-icon-open"
          className="w-3.5 h-3.5 text-emerald-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M9 12l2 2 4-4"
          />
        </svg>
      )}

      {statusKey === "queue" && (
        <svg
          data-testid="health-badge-icon-queue"
          className="w-3.5 h-3.5 text-amber-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M12 7v5l3 3"
          />
        </svg>
      )}

      {statusKey === "paused" && (
        <svg
          data-testid="health-badge-icon-paused"
          className="w-3.5 h-3.5 text-amber-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M10 9v6m4-6v6"
          />
        </svg>
      )}

      {statusKey === "unavailable" && (
        <svg
          data-testid="health-badge-icon-unavailable"
          className="w-3.5 h-3.5 text-rose-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      )}

      <span data-testid="health-badge-text">{displayText}</span>
    </div>
  );
}
