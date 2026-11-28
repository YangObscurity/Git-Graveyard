"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { StatusPill, type StatusPillProps } from "@/components/ui/StatusPill";

export interface HistoryRunItem {
  runId: string;
  url?: string;
  repository?: string;
  repo?: string;
  sha?: string;
  phase?: string;
  outcome?: string | null;
  sandboxId?: string | null;
  inviteCodeHash?: string | null;
  queuePosition?: number | null;
  caps?: Record<string, unknown> | null;
  pushTargetFork?: string | null;
  pushBranch?: string | null;
  pushFlag?: boolean;
  isPublished?: boolean;
  isRemoved?: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number | null;
  endedAt?: number | null;
  date?: string;
  /** Roles that took part in the run, when the record carries them. */
  rolesUsed?: string[] | null;
  /** Engine version that produced the run, when the record carries it. */
  engineVersion?: string | null;
  /** How the run was recorded (for example "live"). */
  mode?: string | null;
  /** Build status before the run, when the record carries it. */
  beforeBuildStatus?: string | null;
  /** Build status after the run, when the record carries it. */
  afterBuildStatus?: string | null;
}

export interface HistoryRunMetadataView {
  roles: string[];
  engineVersion: string | null;
  mode: string;
  beforeBuild: string | null;
  afterBuild: string | null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry.trim());
    }
  }
  return out;
}

/**
 * Derives the extra per-row facts (roles, engine version, recorded-on mode and
 * before/after build status) from the run record. Only values the record
 * actually carries are returned; anything absent stays null or "not recorded".
 */
export function describeRunMetadata(run: HistoryRunItem): HistoryRunMetadataView {
  const meta =
    run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : {};

  const roles = (() => {
    const direct = stringList(run.rolesUsed);
    if (direct.length > 0) return direct;
    const fromMeta = stringList(meta.rolesUsed ?? meta.roles);
    if (fromMeta.length > 0) return fromMeta;
    const skeletons = meta.skeletons;
    if (Array.isArray(skeletons)) {
      const fromSkeletons: string[] = [];
      for (const entry of skeletons) {
        if (entry && typeof entry === "object") {
          const role = (entry as Record<string, unknown>).role;
          if (typeof role === "string" && role.trim().length > 0) {
            fromSkeletons.push(role.trim());
          }
        }
      }
      if (fromSkeletons.length > 0) return fromSkeletons;
    }
    return [] as string[];
  })();

  const engineVersion = firstString(
    run.engineVersion,
    meta.engineVersion,
    meta.engine,
    meta.engineSha
  );

  const rawMode = firstString(run.mode, meta.mode, meta.recordedOn, meta.recordedMode);
  const mode = rawMode ? rawMode.toLowerCase() : "live";

  const beforeBuild = firstString(
    run.beforeBuildStatus,
    meta.beforeBuildStatus,
    meta.beforeBuild,
    meta.buildBefore
  );
  const afterBuild = firstString(
    run.afterBuildStatus,
    meta.afterBuildStatus,
    meta.afterBuild,
    meta.buildAfter
  );

  return { roles, engineVersion, mode, beforeBuild, afterBuild };
}

export interface HistoryListProps {
  initialRuns?: HistoryRunItem[];
  limit?: number;
  /** Explicit error message (tests and SSR); when omitted the list fetches. */
  initialError?: string | null;
}

export function formatOutcome(outcome?: string | null, isRemoved?: boolean): string {
  if (isRemoved || outcome === "Removed by the owner") {
    return "Removed by the owner";
  }
  if (!outcome) {
    return "Unknown";
  }
  const o = outcome.toLowerCase();
  switch (o) {
    case "resurrected":
      return "Resurrected";
    case "resurrected_build_only":
      return "Resurrected (build only)";
    case "partial":
      return "Partially Resurrected";
    case "not_resurrected":
      return "Not Resurrected";
    case "healthy_already":
      return "Healthy Already";
    case "cancelled":
      return "Cancelled";
    case "killed":
      return "Killed";
    case "budget_stopped":
      return "Budget Exceeded";
    case "error":
      return "Error";
    default:
      return outcome;
  }
}

export function formatDuration(startedAt?: number | null, endedAt?: number | null): string | null {
  if (typeof startedAt !== "number" || typeof endedAt !== "number" || endedAt < startedAt) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function getOutcomeTone(
  outcome?: string | null,
  isRemoved?: boolean
): StatusPillProps["tone"] {
  if (isRemoved || outcome === "Removed by the owner") {
    return "crimson";
  }
  const o = (outcome || "").toLowerCase();
  if (o === "resurrected" || o === "resurrected_build_only" || o === "healthy_already") {
    return "emerald";
  }
  if (o === "partial") {
    return "amber";
  }
  if (o === "not_resurrected" || o === "error" || o === "killed" || o === "budget_stopped" || o === "failed") {
    return "crimson";
  }
  return "neutral";
}

type OutcomeFilter = "all" | "resurrected" | "partial" | "other";

export function HistoryList({ initialRuns, limit, initialError }: HistoryListProps) {
  const [runs, setRuns] = useState<HistoryRunItem[]>(initialRuns ?? []);
  const [loading, setLoading] = useState<boolean>(initialRuns === undefined);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");

  useEffect(() => {
    if (initialRuns !== undefined) {
      return;
    }
    let cancelled = false;

    async function fetchHistory() {
      try {
        setLoading(true);
        setError(null);
        const query = typeof limit === "number" ? `?limit=${encodeURIComponent(limit)}` : "";
        const res = await fetch(`/api/history${query}`);
        if (!res.ok) {
          if (!cancelled) {
            setError("Unable to load recorded runs.");
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
          setError("Unable to load recorded runs.");
          setLoading(false);
        }
      }
    }

    fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [initialRuns, limit]);

  // Filter to show only runs with an admin.publish event (Requirement 33.3)
  const publishedRuns = useMemo(
    () => runs.filter((r) => r.isPublished !== false),
    [runs]
  );

  const filteredRuns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return publishedRuns.filter((run) => {
      const o = (run.outcome || "").toLowerCase();
      if (outcomeFilter === "resurrected") {
        if (o !== "resurrected" && o !== "resurrected_build_only" && o !== "healthy_already") {
          return false;
        }
      } else if (outcomeFilter === "partial") {
        if (o !== "partial") {
          return false;
        }
      } else if (outcomeFilter === "other") {
        if (
          o === "resurrected" ||
          o === "resurrected_build_only" ||
          o === "healthy_already" ||
          o === "partial"
        ) {
          return false;
        }
      }

      if (!q) {
        return true;
      }
      const repoText = (run.repository || run.repo || run.url || "").toLowerCase();
      const shaText = (run.sha || "").toLowerCase();
      const idText = (run.runId || "").toLowerCase();
      return repoText.includes(q) || shaText.includes(q) || idText.includes(q);
    });
  }, [publishedRuns, searchQuery, outcomeFilter]);

  if (loading) {
    return (
      <div
        data-testid="history-loading"
        data-ui-element="history-list"
        data-ui-state="loading"
        className="crypt-panel p-5 text-ash text-sm font-mono flex items-center gap-3"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400 crypt-pulse-emerald" aria-hidden="true" />
        <span>Loading recorded runs...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="history-error"
        data-ui-element="history-list"
        data-ui-state="error"
        className="crypt-panel p-5 border-rose-500/40 bg-rose-950/20 text-rose-300 text-sm font-mono border-l-2 border-l-rose-500"
      >
        {error}
      </div>
    );
  }

  if (publishedRuns.length === 0) {
    return (
      <div
        data-testid="history-empty"
        data-ui-element="history-list"
        data-ui-state="empty"
        className="crypt-panel p-8 text-ash text-sm font-mono text-center"
      >
        No recorded runs have been published yet.
      </div>
    );
  }

  const filterButtons: { key: OutcomeFilter; label: string }[] = [
    { key: "all", label: `All (${publishedRuns.length})` },
    { key: "resurrected", label: "Resurrected" },
    { key: "partial", label: "Partial" },
    { key: "other", label: "Other Outcomes" },
  ];

  // Display failed, partial and cancelled runs with the same weight as successful ones (Requirement 33.5)
  return (
    <div
      data-testid="history-list"
      data-ui-element="history-list"
      data-ui-state="populated"
      className="space-y-4 font-mono"
    >
      {/* Vault Filter & Search Bar */}
      <div className="crypt-panel p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="crypt-well flex items-center gap-2 px-3 py-1.5 flex-1 max-w-md focus-within:border-emerald-400/50">
          <span className="text-[11px] text-dust select-none">vault://</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by owner/repo, runId, or SHA..."
            aria-label="Filter recorded history"
            className="w-full bg-transparent text-xs text-bone placeholder:text-dust focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by outcome">
          {filterButtons.map((btn) => {
            const active = outcomeFilter === btn.key;
            return (
              <button
                key={btn.key}
                type="button"
                onClick={() => setOutcomeFilter(btn.key)}
                className={`px-2.5 py-1 rounded text-[11px] border transition-colors cursor-pointer ${
                  active
                    ? "bg-emerald-950/60 border-[var(--necromancy-emerald-border)] text-emerald-300 font-semibold"
                    : "bg-neutral-900/70 border-white/10 text-ash hover:text-bone hover:border-white/25"
                }`}
              >
                {btn.label}
              </button>
            );
          })}
        </div>
      </div>

      {filteredRuns.length === 0 ? (
        <div className="crypt-panel p-6 text-center text-xs text-ash">
          No published entries match the current vault filter.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredRuns.map((run) => {
            const repoDisplay =
              run.repository || run.repo || run.url || "unknown repository";
            const dateDisplay =
              run.date ||
              (run.createdAt ? new Date(run.createdAt).toISOString() : "unknown date");
            const isRemoved = Boolean(run.isRemoved || run.outcome === "Removed by the owner");
            const outcomeDisplay = formatOutcome(run.outcome, isRemoved);
            const outcomeTone = getOutcomeTone(run.outcome, isRemoved);
            const shortSha = run.sha ? run.sha.slice(0, 7) : null;
            const durationDisplay = formatDuration(run.startedAt, run.endedAt);
            const meta = describeRunMetadata(run);
            const modeLabel =
              meta.mode === "live" ? "Recorded live run" : `Recorded ${meta.mode} run`;
            const buildLabel =
              meta.beforeBuild || meta.afterBuild
                ? `before ${meta.beforeBuild ?? "not recorded"} -> after ${
                    meta.afterBuild ?? "not recorded"
                  }`
                : "not recorded";

            return (
              <article
                key={run.runId}
                data-testid={`history-run-${run.runId}`}
                data-ui-element="history-list-row"
                data-ui-state={isRemoved ? "hidden" : "populated"}
                className="crypt-panel p-4 hover:border-emerald-500/35 hover:bg-slab-hover transition-all flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      data-testid="recorded-run-label"
                      className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-neutral-900/90 text-parchment border border-white/15"
                    >
                      Recorded run
                    </span>
                    {isRemoved ? (
                      <span
                        data-testid="removed-run-label"
                        className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-rose-950/50 text-rose-300 border border-[var(--crimson-seal-border)]"
                      >
                        Removed by the owner
                      </span>
                    ) : null}
                    <StatusPill
                      tone={outcomeTone}
                      label={outcomeDisplay}
                      testId="history-run-outcome"
                      uiState={isRemoved ? "removed" : (run.outcome || "unknown").toLowerCase()}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <span
                      data-testid="history-run-repo"
                      className="text-sm font-semibold text-bone break-all"
                    >
                      {repoDisplay}
                    </span>
                    {shortSha ? (
                      <span
                        data-testid="history-run-sha"
                        className="crypt-well text-[11px] px-2 py-0.5 text-ash border-white/10"
                      >
                        @{shortSha}
                      </span>
                    ) : null}
                    <span className="text-[11px] text-dust">
                      id:{run.runId}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-ash">
                    <span
                      data-testid="history-run-mode"
                      className="crypt-well px-2 py-0.5 text-[10px] uppercase tracking-wider text-parchment border border-white/15"
                    >
                      {modeLabel}
                    </span>
                    <span data-testid="history-run-roles" className="text-dust">
                      Roles:{" "}
                      <span className="text-parchment">
                        {meta.roles.length > 0 ? meta.roles.join(", ") : "not recorded"}
                      </span>
                    </span>
                    <span data-testid="history-run-build-status" className="text-dust">
                      Build: <span className="text-parchment">{buildLabel}</span>
                    </span>
                    <span data-testid="history-run-engine" className="text-dust">
                      Engine:{" "}
                      <span className="text-parchment">
                        {meta.engineVersion ?? "not recorded"}
                      </span>
                    </span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-3 lg:shrink-0">
                  <div className="flex flex-wrap items-center gap-3 text-xs text-ash">
                    {durationDisplay ? (
                      <span
                        data-testid="history-run-duration"
                        className="crypt-well px-2 py-0.5 text-[11px] text-parchment tabular-nums"
                      >
                        {durationDisplay}
                      </span>
                    ) : null}
                    <span data-testid="history-run-date" className="text-[11px] text-dust tabular-nums">
                      {dateDisplay}
                    </span>
                  </div>

                  {!isRemoved ? (
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/replay/${encodeURIComponent(run.runId)}`}
                        data-testid={`history-replay-link-${run.runId}`}
                        className="crypt-btn-primary px-3 py-1.5 rounded text-xs whitespace-nowrap"
                      >
                        <span aria-hidden="true">▶</span>
                        <span>Replay Run</span>
                      </Link>
                      <Link
                        href={`/runs/${encodeURIComponent(run.runId)}/relic`}
                        data-testid={`history-relic-link-${run.runId}`}
                        className="crypt-btn-ghost px-3 py-1.5 rounded text-xs whitespace-nowrap"
                      >
                        Inspect Relics
                      </Link>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
