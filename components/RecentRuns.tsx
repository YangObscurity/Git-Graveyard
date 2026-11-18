"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { describeOutcome } from "@/lib/ui/run-routes";
import { StatusPill, type StatusPillProps } from "./ui/StatusPill";

export interface RecentRunItem {
  runId: string;
  repository?: string;
  repo?: string;
  url?: string;
  date?: string;
  outcome?: string | null;
  sha?: string;
  createdAt?: number;
}

export interface RecentRunsProps {
  limit?: number;
  initialRuns?: RecentRunItem[];
}

function getOutcomeTone(outcome: string): StatusPillProps["tone"] {
  const normalized = outcome.trim().toLowerCase();
  if (
    normalized === "resurrected" ||
    normalized === "passed" ||
    normalized === "completed"
  ) {
    return "emerald";
  }
  if (
    normalized === "partial" ||
    normalized === "in progress" ||
    normalized === "running" ||
    normalized === "queued" ||
    normalized === "paused"
  ) {
    return "amber";
  }
  if (
    normalized === "unresurrectable" ||
    normalized === "failed" ||
    normalized === "stopped" ||
    normalized === "cancelled"
  ) {
    return "crimson";
  }
  return "neutral";
}

export function RecentRuns({ limit = 5, initialRuns }: RecentRunsProps) {
  const [runs, setRuns] = useState<RecentRunItem[]>(initialRuns ?? []);
  const [loading, setLoading] = useState<boolean>(!initialRuns);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialRuns) {
      return;
    }
    let cancelled = false;

    async function fetchRuns() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/history?limit=${encodeURIComponent(limit)}`);
        if (!res.ok) {
          if (!cancelled) {
            setError("Unable to load recent runs.");
            setLoading(false);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          if (Array.isArray(data)) {
            setRuns(data);
          } else {
            setRuns([]);
          }
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("Unable to load recent runs.");
          setLoading(false);
        }
      }
    }

    fetchRuns();
    return () => {
      cancelled = true;
    };
  }, [limit, initialRuns]);

  if (loading) {
    return (
      <div
        data-testid="recent-runs-loading"
        data-ui-element="recent-runs"
        data-ui-state="loading"
        className="crypt-panel p-5 text-ash text-xs font-mono flex items-center gap-3"
      >
        <span
          aria-hidden="true"
          className="w-2 h-2 rounded-full bg-emerald-400/80 crypt-pulse-emerald shrink-0"
        />
        <span>Loading recent runs...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="recent-runs-error"
        data-ui-element="recent-runs"
        data-ui-state="error"
        className="crypt-panel p-5 border-l-2 border-l-rose-500 border-rose-500/35 bg-rose-950/20 text-rose-300 text-xs font-mono"
      >
        {error}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div
        data-testid="recent-runs-empty"
        data-ui-element="recent-runs"
        data-ui-state="empty"
        className="crypt-panel p-6 text-ash text-xs font-mono text-center"
      >
        No recorded runs yet.
      </div>
    );
  }

  return (
    <div
      data-testid="recent-runs-list"
      data-ui-element="recent-runs"
      data-ui-state="populated"
      className="crypt-panel divide-y divide-white/[0.06] overflow-hidden font-mono"
    >
      {runs.map((run) => {
        const repoDisplay =
          run.repository || run.repo || run.url || "unknown repository";
        const dateDisplay =
          run.date ||
          (run.createdAt ? new Date(run.createdAt).toISOString() : "unknown date");
        const outcomeInfo = run.outcome ? describeOutcome(run.outcome) : null;
        const outcomeDisplay = outcomeInfo ? outcomeInfo.label : "in progress";
        const tone: StatusPillProps["tone"] = outcomeInfo
          ? outcomeInfo.tone
          : getOutcomeTone(outcomeDisplay);
        const isLivePulse = !run.outcome;

        return (
          <div
            key={run.runId}
            data-testid={`recent-run-${run.runId}`}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-slab-hover/80 transition-colors"
          >
            <div className="flex flex-wrap items-center gap-2.5 min-w-0">
              <span
                data-testid="recorded-run-label"
                className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-recessed text-ash border border-white/10 shrink-0"
              >
                Recorded run
              </span>
              <span
                data-testid="recent-run-repo"
                className="font-semibold text-sm text-bone truncate"
              >
                {repoDisplay}
              </span>
              <StatusPill
                testId="recent-run-outcome"
                tone={tone}
                pulse={isLivePulse}
                label={outcomeDisplay}
              />
            </div>
            <div className="flex items-center gap-3 text-xs text-ash shrink-0">
              <span data-testid="recent-run-date" className="text-dust tabular-nums">
                {dateDisplay}
              </span>
              <div className="flex items-center gap-2">
                <Link
                  href={`/replay/${encodeURIComponent(run.runId)}`}
                  className="crypt-btn-ghost px-2.5 py-1 rounded text-[11px]"
                >
                  Replay
                </Link>
                <Link
                  href={`/runs/${encodeURIComponent(run.runId)}/relic`}
                  className="px-2 py-1 rounded text-[11px] text-ash hover:text-emerald-300 border border-transparent hover:border-emerald-500/30 transition-colors"
                >
                  Relics
                </Link>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
