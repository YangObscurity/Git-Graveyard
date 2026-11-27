"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { RunOutcome } from "@/lib/lifecycle/lifecycle-manager";
import type { TaskState, EventEnvelope } from "@/lib/events/types";
import { GATE_FOOTER } from "@/lib/copy/glossary";
import { announceRunPhase } from "@/lib/ui/run-phase-bus";
import { repoFromUrl, routes } from "@/lib/ui/run-routes";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  ReliquaryBeforeAfterTable,
  type BeforeAfterRowData,
  type BeforeAfterCellData,
} from "./ReliquaryBeforeAfterTable";
import {
  ReliquaryDiffViewer,
  type DiffHunk,
} from "./ReliquaryDiffViewer";
import {
  ReliquaryTaskLedger,
  type TaskLedgerItem,
} from "./ReliquaryTaskLedger";
import {
  ReliquaryArtifactDownloads,
  type ReliquaryArtifactItem,
} from "./ReliquaryArtifactDownloads";
import { OpenInKiroHandoff } from "./OpenInKiroHandoff";

export interface ReliquaryPushInfo {
  enabled: boolean;
  targetFork?: string;
  branch?: string;
}

export interface ReliquaryReportCheckInfo {
  passed: boolean;
  failed?: boolean;
  reading?: string | null;
}

export interface ReliquaryViewProps {
  runId: string;
  outcome?: RunOutcome | string;
  owner?: string;
  repo?: string;
  baseSha?: string;
  headSha?: string;
  packing?: boolean;
  hidden?: boolean;
  push?: ReliquaryPushInfo;
  reportCheck?: ReliquaryReportCheckInfo;
  beforeAfterRows?: BeforeAfterRowData[];
  diff?: string | null;
  hunks?: DiffHunk[];
  tasks?: TaskLedgerItem[];
  artifacts?: ReliquaryArtifactItem[];
  initialEvents?: EventEnvelope[];
}

export function formatOutcomeBannerText(
  outcome?: RunOutcome | string | null,
  buildPassed?: boolean,
  testsPassed?: boolean
): string {
  const o = (outcome || "").toLowerCase();

  // Requirement 38.2: show "Resurrected" only when both final-check build and repo tests passed
  if (o === "resurrected") {
    if (buildPassed === false || testsPassed === false) {
      if (buildPassed === true && testsPassed === false) {
        return "Resurrected (build only)";
      }
      return "Partially Resurrected";
    }
    return "Resurrected";
  }

  if (o === "resurrected_build_only") {
    return "Resurrected (build only)";
  }
  if (o === "partial") {
    return "Partially Resurrected";
  }
  if (o === "not_resurrected") {
    return "Not Resurrected";
  }
  if (o === "healthy_already") {
    return "Healthy Already";
  }
  if (o === "cancelled") {
    return "Cancelled";
  }
  if (o === "killed") {
    return "Killed";
  }
  if (o === "budget_stopped") {
    return "Budget Exceeded";
  }
  if (o === "error") {
    return "Error";
  }

  return outcome ? String(outcome) : "Run Complete";
}

export function parseEventsData(events: EventEnvelope[]): {
  outcome?: string;
  packing?: boolean;
  hidden?: boolean;
  baseSha?: string;
  buildPassed?: boolean;
  testsPassed?: boolean;
  tasks?: Record<string, TaskLedgerItem>;
  artifacts?: ReliquaryArtifactItem[];
  reportCheck?: ReliquaryReportCheckInfo;
} {
  let runOutcome: string | undefined = undefined;
  let isPacking: boolean | undefined = undefined;
  let isHidden: boolean | undefined = undefined;
  let certBaseSha: string | undefined = undefined;
  let finalBuildPassed: boolean | undefined = undefined;
  let finalTestsPassed: boolean | undefined = undefined;
  let repCheck: ReliquaryReportCheckInfo | undefined = undefined;
  const discoveredTasks: Record<string, TaskLedgerItem> = {};
  const discoveredArtifacts: ReliquaryArtifactItem[] = [];

  for (const ev of events) {
    if (ev.kind === "admin.hide") {
      isHidden = true;
    }

    if (ev.kind === "exhume.certificate") {
      const bs = (ev.data as Record<string, unknown>)?.baseSha;
      if (typeof bs === "string" && bs.length > 0) {
        certBaseSha = bs;
      }
    }

    if (ev.kind === "final_check.result") {
      const d = ev.data as Record<string, unknown>;
      if (typeof d?.buildPassed === "boolean") finalBuildPassed = d.buildPassed;
      if (typeof d?.testsPassed === "boolean") finalTestsPassed = d.testsPassed;
    }

    if (ev.kind === "run.phase") {
      const ph = (ev.data as Record<string, unknown>)?.phase ?? (ev.data as Record<string, unknown>)?.to;
      if (ph === "report" || ph === "final_check") {
        isPacking = true;
      } else if (ph === "done") {
        isPacking = false;
      }
    }

    if (ev.kind === "run.done") {
      isPacking = false;
      const data = ev.data as Record<string, unknown>;
      if (typeof data?.outcome === "string") {
        runOutcome = data.outcome;
      }
      if (data?.manifest && typeof data.manifest === "object") {
        const man = data.manifest as Record<string, unknown>;
        const rawArtifacts = (man.artifacts ?? {}) as Record<string, unknown>;
        for (const [k, item] of Object.entries(rawArtifacts)) {
          if (item && typeof item === "object") {
            const artObj = item as Record<string, unknown>;
            discoveredArtifacts.push({
              id: k,
              name: String(artObj.fileName || artObj.name || k),
              fileName: String(artObj.fileName || k),
              kind: String(artObj.kind || k),
              size: typeof artObj.byteSize === "number" ? artObj.byteSize : undefined,
              sha256: typeof artObj.sha256 === "string" ? artObj.sha256 : undefined,
            });
          }
        }
      }
    }

    if (ev.kind === "artifact.ready") {
      const data = ev.data as Record<string, unknown>;
      discoveredArtifacts.push({
        id: String(data?.kind || `art-${discoveredArtifacts.length}`),
        name: String(data?.fileName || data?.name || data?.kind),
        fileName: String(data?.fileName || "artifact"),
        kind: String(data?.kind || "patch"),
        size: typeof data?.byteSize === "number" ? data.byteSize : undefined,
        sha256: typeof data?.sha256 === "string" ? data.sha256 : undefined,
      });
    }

    if (ev.kind === "task.state") {
      const tid = ev.taskId || String(ev.data?.taskId || `task-${Object.keys(discoveredTasks).length + 1}`);
      const state = String(ev.data?.state || "pending") as TaskState;
      if (!discoveredTasks[tid]) {
        discoveredTasks[tid] = {
          id: tid,
          title: typeof ev.data?.title === "string" ? ev.data.title : undefined,
          state,
          attempts: typeof ev.attempt === "number" ? ev.attempt : 1,
        };
      } else {
        discoveredTasks[tid].state = state;
        if (typeof ev.attempt === "number") {
          discoveredTasks[tid].attempts = ev.attempt;
        }
      }
    }

    if (ev.kind === "task.merged") {
      const tid = ev.taskId || String(ev.data?.taskId || "");
      if (tid) {
        if (!discoveredTasks[tid]) {
          discoveredTasks[tid] = {
            id: tid,
            title: typeof ev.data?.title === "string" ? ev.data.title : undefined,
            state: "merged",
            attempts: typeof ev.attempt === "number" ? ev.attempt : 1,
          };
        } else {
          discoveredTasks[tid].state = "merged";
          if (typeof ev.attempt === "number") {
            discoveredTasks[tid].attempts = ev.attempt;
          }
        }
      }
    }

    if (ev.kind === "verdict") {
      const tid = String(ev.data?.target || ev.data?.taskId || ev.taskId || "");
      if (tid && discoveredTasks[tid]) {
        discoveredTasks[tid].verdict = String(ev.data?.verdict || "");
        if (Array.isArray(ev.data?.reasons)) {
          discoveredTasks[tid].reasons = ev.data.reasons as string[];
        }
      }
    }

    if (ev.kind === "report.checked") {
      const ok = Boolean(ev.data?.ok || ev.data?.passed);
      repCheck = {
        passed: ok,
        failed: !ok,
        reading: ok ? String(ev.data?.reading || "") : null,
      };
    }
  }

  return {
    outcome: runOutcome,
    packing: isPacking,
    hidden: isHidden,
    baseSha: certBaseSha,
    buildPassed: finalBuildPassed,
    testsPassed: finalTestsPassed,
    tasks: Object.keys(discoveredTasks).length > 0 ? discoveredTasks : undefined,
    artifacts: discoveredArtifacts.length > 0 ? discoveredArtifacts : undefined,
    reportCheck: repCheck,
  };
}

export function ReliquaryView({
  runId,
  outcome: initialOutcome,
  owner: propOwner,
  repo: propRepo,
  baseSha: propBaseSha,
  headSha: propHeadSha,
  packing: propPacking,
  hidden: propHidden,
  push: propPush,
  reportCheck: propReportCheck,
  beforeAfterRows: propBeforeAfterRows,
  diff: propDiff,
  hunks: propHunks,
  tasks: propTasks,
  artifacts: propArtifacts,
  initialEvents,
}: ReliquaryViewProps) {
  const initialParsed = initialEvents ? parseEventsData(initialEvents) : null;

  const hasInitialProps = Boolean(
    initialOutcome !== undefined ||
    propBeforeAfterRows !== undefined ||
    initialEvents !== undefined ||
    propHidden !== undefined ||
    propPush !== undefined ||
    propReportCheck !== undefined ||
    propDiff !== undefined ||
    propHunks !== undefined ||
    propTasks !== undefined ||
    propArtifacts !== undefined ||
    propOwner !== undefined ||
    propRepo !== undefined ||
    propBaseSha !== undefined
  );

  const [loading, setLoading] = useState<boolean>(!hasInitialProps);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Phase reported by /api/runs/[runId]; null when not loaded from the server.
  const [runPhase, setRunPhase] = useState<string | null>(null);

  // Run outcome and lifecycle state: do NOT pre-seed 'resurrected' when initialOutcome is absent!
  const [outcome, setOutcome] = useState<string | undefined>(
    initialOutcome ?? initialParsed?.outcome
  );
  const [packing, setPacking] = useState<boolean>(
    propPacking !== undefined ? Boolean(propPacking) : Boolean(initialParsed?.packing)
  );
  const [hidden, setHidden] = useState<boolean>(
    propHidden !== undefined ? Boolean(propHidden) : Boolean(initialParsed?.hidden)
  );
  const [owner, setOwner] = useState<string>(propOwner ?? "owner");
  const [repo, setRepo] = useState<string>(propRepo ?? "repo");
  const [baseSha, setBaseSha] = useState<string>(propBaseSha ?? initialParsed?.baseSha ?? "0000000");
  const [headSha, setHeadSha] = useState<string>(propHeadSha ?? "0000000");
  const [eventBuildPassed, setEventBuildPassed] = useState<boolean | undefined>(
    initialParsed?.buildPassed
  );
  const [eventTestsPassed, setEventTestsPassed] = useState<boolean | undefined>(
    initialParsed?.testsPassed
  );

  const [pushInfo, setPushInfo] = useState<ReliquaryPushInfo | undefined>(propPush);
  const [reportCheckInfo, setReportCheckInfo] = useState<ReliquaryReportCheckInfo | undefined>(
    propReportCheck ?? initialParsed?.reportCheck
  );

  const [beforeAfterRows, setBeforeAfterRows] = useState<BeforeAfterRowData[] | undefined>(
    propBeforeAfterRows
  );
  const [diff, setDiff] = useState<string | null | undefined>(propDiff);
  const [hunks, setHunks] = useState<DiffHunk[] | undefined>(propHunks);
  const [tasks, setTasks] = useState<TaskLedgerItem[] | undefined>(
    propTasks ?? (initialParsed?.tasks ? Object.values(initialParsed.tasks) : undefined)
  );
  const [artifacts, setArtifacts] = useState<ReliquaryArtifactItem[] | undefined>(
    propArtifacts ?? initialParsed?.artifacts
  );

  // Sync prop changes
  useEffect(() => {
    if (initialOutcome !== undefined) setOutcome(initialOutcome);
  }, [initialOutcome]);

  useEffect(() => {
    if (propPacking !== undefined) setPacking(propPacking);
  }, [propPacking]);

  useEffect(() => {
    if (propHidden !== undefined) setHidden(propHidden);
  }, [propHidden]);

  useEffect(() => {
    if (propPush !== undefined) setPushInfo(propPush);
  }, [propPush]);

  useEffect(() => {
    if (propReportCheck !== undefined) setReportCheckInfo(propReportCheck);
  }, [propReportCheck]);

  useEffect(() => {
    if (propBeforeAfterRows !== undefined) setBeforeAfterRows(propBeforeAfterRows);
  }, [propBeforeAfterRows]);

  useEffect(() => {
    if (propDiff !== undefined) setDiff(propDiff);
  }, [propDiff]);

  useEffect(() => {
    if (propHunks !== undefined) setHunks(propHunks);
  }, [propHunks]);

  useEffect(() => {
    if (propTasks !== undefined) setTasks(propTasks);
  }, [propTasks]);

  useEffect(() => {
    if (propArtifacts !== undefined) setArtifacts(propArtifacts);
  }, [propArtifacts]);

  // If initial props are omitted, fetch BOTH /api/runs/[runId] (authoritative) AND /api/runs/[runId]/events?from=1 (supplement/fallback)
  useEffect(() => {
    if (initialOutcome || propBeforeAfterRows || initialEvents) {
      if (initialEvents) {
        const parsed = parseEventsData(initialEvents);
        if (parsed.outcome !== undefined) setOutcome(parsed.outcome);
        if (parsed.packing !== undefined) setPacking(parsed.packing);
        if (parsed.hidden !== undefined) setHidden(parsed.hidden);
        if (parsed.tasks) setTasks(Object.values(parsed.tasks));
        if (parsed.artifacts) setArtifacts(parsed.artifacts);
        if (parsed.reportCheck) setReportCheckInfo(parsed.reportCheck);
      }
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchRunData() {
      try {
        setLoading(true);
        setErrorMessage(null);

        // Fetch BOTH /api/runs/[runId] (authoritative) and /api/runs/[runId]/events?from=1 (supplement/fallback)
        const [runRes, eventsRes] = await Promise.allSettled([
          fetch(`/api/runs/${encodeURIComponent(runId)}`),
          fetch(`/api/runs/${encodeURIComponent(runId)}/events?from=1`),
        ]);

        if (cancelled) return;

        let runData: any = null;
        let eventsData: EventEnvelope[] | null = null;

        if (runRes.status === "fulfilled" && runRes.value.ok) {
          try {
            runData = await runRes.value.json();
          } catch {}
        }

        if (eventsRes.status === "fulfilled" && eventsRes.value.ok) {
          try {
            const parsed = await eventsRes.value.json();
            if (Array.isArray(parsed)) {
              eventsData = parsed;
            }
          } catch {}
        }

        if (!runData && !eventsData) {
          const run404 = runRes.status === "fulfilled" && runRes.value.status === 404;
          const events404 = eventsRes.status === "fulfilled" && eventsRes.value.status === 404;
          if (run404 || events404) {
            setErrorMessage("Run not found.");
          } else {
            setErrorMessage("Failed to load relics from event store.");
          }
          setLoading(false);
          return;
        }

        // Authoritative data from /api/runs/[runId]
        if (runData) {
          if (typeof runData.phase === "string") {
            setRunPhase(runData.phase);
            announceRunPhase({
              runId,
              phase: runData.phase,
              outcome: typeof runData.outcome === "string" ? runData.outcome : null,
            });
          }
          if (runData.outcome) setOutcome(runData.outcome);
          if (typeof runData.hidden === "boolean") setHidden(runData.hidden);
          if (runData.push) setPushInfo(runData.push);
          if (runData.reportCheck) setReportCheckInfo(runData.reportCheck);
          if (Array.isArray(runData.beforeAfterRows) && runData.beforeAfterRows.length > 0) {
            setBeforeAfterRows(runData.beforeAfterRows);
          }
          if (runData.diff !== undefined) setDiff(runData.diff);
          if (Array.isArray(runData.tasks) && runData.tasks.length > 0) {
            setTasks(runData.tasks);
          }
          if (Array.isArray(runData.artifacts) && runData.artifacts.length > 0) {
            setArtifacts(runData.artifacts);
          }
          if (runData.run) {
            const parsedRepo = repoFromUrl(runData.run.url);
            if (runData.run.owner) setOwner(runData.run.owner);
            else if (parsedRepo) setOwner(parsedRepo.owner);
            if (runData.run.repo) setRepo(runData.run.repo);
            else if (parsedRepo) setRepo(parsedRepo.repo);
            if (runData.run.baseSha) setBaseSha(runData.run.baseSha);
            else if (typeof runData.run.sha === "string" && runData.run.sha && runData.run.sha !== "HEAD") {
              setBaseSha(runData.run.sha);
            }
            if (runData.run.headSha) setHeadSha(runData.run.headSha);
          }
          if (runData.phase === "report" || runData.phase === "final_check") {
            setPacking(true);
          } else if (runData.phase === "done") {
            setPacking(false);
          }
        }

        // Supplement/fallback from events
        if (eventsData && eventsData.length > 0) {
          const parsed = parseEventsData(eventsData);
          if (!runData?.outcome && parsed.outcome !== undefined) {
            setOutcome(parsed.outcome);
          }
          if (runData?.hidden === undefined && parsed.hidden !== undefined) {
            setHidden(parsed.hidden);
          }
          if (!runData?.reportCheck && parsed.reportCheck) {
            setReportCheckInfo(parsed.reportCheck);
          }
          if (parsed.baseSha && !runData?.run?.baseSha) {
            setBaseSha((prev) => (prev === "0000000" ? parsed.baseSha! : prev));
          }
          if (parsed.buildPassed !== undefined) {
            setEventBuildPassed(parsed.buildPassed);
          }
          if (parsed.testsPassed !== undefined) {
            setEventTestsPassed(parsed.testsPassed);
          }
          if ((!runData?.tasks || runData.tasks.length === 0) && parsed.tasks) {
            setTasks(Object.values(parsed.tasks));
          }
          if ((!runData?.artifacts || runData.artifacts.length === 0) && parsed.artifacts) {
            setArtifacts(parsed.artifacts);
          }
          if (runData?.phase === undefined && parsed.packing !== undefined) {
            setPacking(parsed.packing);
          }
        }

        setLoading(false);
      } catch (err: unknown) {
        if (!cancelled) {
          setErrorMessage(
            err instanceof Error ? err.message : "Network error occurred while fetching run events."
          );
          setLoading(false);
        }
      }
    }

    fetchRunData();

    return () => {
      cancelled = true;
    };
  }, [runId, initialOutcome, propBeforeAfterRows, initialEvents]);

  // Plain words for loading state
  if (loading) {
    return (
      <div
        className="crypt-panel p-12 text-center font-mono space-y-3"
        data-testid="reliquary-loading"
        data-ui-element="reliquary-view"
        data-ui-state="loading"
      >
        <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm text-parchment">
          Loading relics for run {runId}...
        </p>
      </div>
    );
  }

  // Requirement 38.13: When the Admin has hidden the run, show "Removed by the owner"
  if (hidden) {
    return (
      <div
        className="crypt-panel p-12 text-center font-mono space-y-3"
        data-testid="reliquary-hidden"
        data-ui-element="reliquary-view"
        data-ui-state="error"
      >
        <CryptOrnament kind="wax-seal" className="w-8 h-8 text-dust mx-auto" />
        <h2 className="text-lg font-semibold text-bone">
          Removed by the owner
        </h2>
        <p className="text-xs text-dust">
          This run record has been marked hidden by the administrator.
        </p>
      </div>
    );
  }

  // Plain words for error state
  if (errorMessage) {
    return (
      <div
        className="crypt-panel border-[var(--crimson-seal-border)] p-12 text-center font-mono space-y-4"
        data-testid="reliquary-error"
        data-ui-element="reliquary-view"
        data-ui-state="error"
      >
        <CryptOrnament kind="wax-seal" className="w-8 h-8 text-rose-400 mx-auto" />
        <h2 className="text-lg font-semibold text-rose-400">
          {errorMessage}
        </h2>
        <p className="text-xs text-ash">
          Unable to display run artifacts. Plain words: verify the run ID and try again.
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-1">
          <Link href={routes.history()} className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Open History
          </Link>
          <Link href={routes.gate()} className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Return to Gate
          </Link>
        </div>
      </div>
    );
  }

  // Determine merged tasks count
  const effectiveTasks = tasks ?? [];
  const mergedTasks = effectiveTasks.filter((t) => t.state === "merged");
  const noTasksMerged = effectiveTasks.length > 0 && mergedTasks.length === 0;

  // Derive pass/fail status for outcome banner calculation
  const buildRow = beforeAfterRows?.find((r) => r.key === "build");
  const testsRow = beforeAfterRows?.find((r) => r.key === "tests_repo");

  const buildStatus = buildRow?.after?.status?.toLowerCase();
  const buildPassed =
    buildStatus && buildStatus !== "not run"
      ? buildStatus.includes("pass")
      : eventBuildPassed ?? true;
  const testsStatus = testsRow?.after?.status?.toLowerCase();
  const testsPassed =
    testsStatus && testsStatus !== "not run"
      ? testsStatus.includes("pass")
      : eventTestsPassed ?? true;

  const outcomeBannerText = formatOutcomeBannerText(outcome, buildPassed, testsPassed);

  // Requirement 38.3: When outcome is partial, list what works and what does not from before/after table
  const isPartial =
    (outcome || "").toLowerCase() === "partial" ||
    outcomeBannerText.toLowerCase().includes("partial");

  const normalizedOutcome = (outcome || "").toLowerCase();
  const isResurrectedTone =
    outcomeBannerText === "Resurrected" || normalizedOutcome === "healthy_already";
  const isAmberTone =
    isPartial || normalizedOutcome === "resurrected_build_only";

  const reliquaryUiState:
    | "loading"
    | "resurrected"
    | "partial"
    | "unresurrectable"
    | "failed"
    | "error" = !outcome
    ? "loading"
    : isResurrectedTone
    ? "resurrected"
    : isAmberTone
    ? "partial"
    : normalizedOutcome === "not_resurrected" || normalizedOutcome === "unresurrectable"
    ? "unresurrectable"
    : normalizedOutcome === "error"
    ? "error"
    : "failed";

  const worksList: string[] = [];
  const doesNotWorkList: string[] = [];

  if (beforeAfterRows && beforeAfterRows.length > 0) {
    for (const r of beforeAfterRows) {
      const aft = r.after;
      const s = aft.status.toLowerCase();
      if (s.includes("pass") || s === "clean" || s === "present" || s === "modern") {
        worksList.push(`${r.label} passed`);
      } else if (s.includes("fail") || s === "error" || s === "missing") {
        doesNotWorkList.push(`${r.label} failed`);
      } else {
        doesNotWorkList.push(`${r.label}: ${aft.status}`);
      }
    }
  }
  // With no before/after rows recorded, both lists stay empty and the
  // breakdown says so; no step is assumed to have passed or failed.

  return (
    <div
      className="space-y-8 font-mono"
      data-testid="reliquary-view"
      data-ui-element="reliquary-view"
      data-ui-state={reliquaryUiState}
    >
      {/* 1. Header & Outcome Banner */}
      <section className="space-y-4" data-testid="reliquary-header-section">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div className="space-y-1">
            <div className="text-[11px] text-emerald-400/90 uppercase tracking-[0.18em]">
              Stage V · Git-Graveyard Reliquary
            </div>
            <h1 className="text-xl md:text-2xl font-bold text-bone font-mono tracking-tight">
              Run: {runId}
            </h1>
            {(owner !== "owner" || repo !== "repo") && (
              <div className="text-xs text-ash">
                Target: <span className="text-parchment">{owner}/{repo}</span>
                {baseSha !== "0000000" && (
                  <span className="ml-2 text-dust">base {baseSha.slice(0, 7)}</span>
                )}
                {headSha !== "0000000" && (
                  <span className="ml-1 text-dust">→ head {headSha.slice(0, 7)}</span>
                )}
              </div>
            )}
          </div>
          {packing && (
            <StatusPill
              tone="amber"
              pulse
              label="Packing the relics"
              testId="packing-badge"
            />
          )}
        </div>

        {/* Outcome Banner (Requirements 38.1 & 38.2) - wait until loaded or explicit initialOutcome */}
        {outcome && (
          <div
            className={`crypt-panel-engraved p-6 ${
              isResurrectedTone
                ? "border-[var(--necromancy-emerald-border)] shadow-[var(--glow-emerald)] bg-[radial-gradient(ellipse_at_top_left,rgba(16,185,129,0.16),transparent_65%)] text-emerald-300"
                : isAmberTone
                ? "border-[var(--arcane-amber-border)] shadow-[var(--glow-amber)] bg-[radial-gradient(ellipse_at_top_left,rgba(245,158,11,0.14),transparent_65%)] text-amber-300"
                : "border-[var(--crimson-seal-border)] shadow-[var(--glow-crimson)] bg-[radial-gradient(ellipse_at_top_left,rgba(244,63,94,0.14),transparent_65%)] text-rose-300"
            }`}
            data-testid="reliquary-outcome-banner"
          >
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="crypt-well p-2.5 shrink-0">
                  <CryptOrnament
                    kind="wax-seal"
                    className={`w-8 h-8 ${
                      isResurrectedTone
                        ? "text-emerald-400"
                        : isAmberTone
                        ? "text-amber-400"
                        : "text-rose-400"
                    }`}
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-ash">
                      Outcome
                    </span>
                    <StatusPill
                      tone={isResurrectedTone ? "emerald" : isAmberTone ? "amber" : "crimson"}
                      label={isResurrectedTone ? "Seal Verified" : isAmberTone ? "Partial Seal" : "Forensic Seal"}
                      className="text-[10px] px-2 py-0.5"
                    />
                  </div>
                  <h2
                    className="font-serif-ritual text-2xl md:text-3xl font-bold tracking-tight text-bone"
                    data-testid="outcome-text"
                  >
                    {outcomeBannerText}
                  </h2>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="crypt-well px-2.5 py-1 text-xs text-emerald-300 font-mono">
                  graveyard/{runId}
                </span>
                <Link
                  href={`/replay/${encodeURIComponent(runId)}`}
                  className="crypt-btn-primary px-3 py-1.5 text-xs rounded"
                >
                  ▶ Replay Run
                </Link>
                <Link
                  href="/history"
                  className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
                >
                  History Vault
                </Link>
              </div>
            </div>

            {/* Requirement 38.3: What works and what does not for partial outcome */}
            {isPartial && (
              <div className="mt-5 pt-4 border-t border-amber-500/30 space-y-3" data-testid="partial-breakdown">
                <div className="text-xs font-semibold uppercase tracking-wider text-amber-200">
                  Partial Resurrection Breakdown
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                  <div className="crypt-well space-y-1.5 p-3.5">
                    <div className="font-semibold text-emerald-400">What works:</div>
                    <ul className="list-disc list-inside space-y-1 text-parchment">
                      {worksList.length === 0 && <li>not recorded</li>}
                      {worksList.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="crypt-well space-y-1.5 p-3.5">
                    <div className="font-semibold text-rose-400">What does not:</div>
                    <ul className="list-disc list-inside space-y-1 text-parchment">
                      {doesNotWorkList.length === 0 && <li>not recorded</li>}
                      {doesNotWorkList.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* The run has not ended: say so and point at the screen that follows it */}
        {!outcome && (
          <div
            data-testid="reliquary-in-progress"
            className="crypt-panel p-5 border-l-2 border-l-amber-400 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs"
          >
            <div className="space-y-1">
              <h2 className="text-sm font-bold text-bone">
                {packing ? "The run is finishing" : "This run has no outcome yet"}
              </h2>
              <p className="text-ash">
                {packing
                  ? "The final check and report are being written. The outcome appears here when the run ends."
                  : `The outcome, diff and downloads appear here when the run ends.${
                      runPhase ? ` Current phase: ${runPhase}.` : ""
                    }`}
              </p>
            </div>
            <Link
              href={routes.run(runId)}
              className="crypt-btn-primary px-4 py-2 rounded text-xs shrink-0"
            >
              Go to the run
            </Link>
          </div>
        )}

        {/* Push status notice (Requirement 38.14) */}
        {pushInfo?.enabled && (
          <div
            className="crypt-panel border-l-2 border-l-emerald-400/70 p-4 text-xs font-mono space-y-1.5 text-parchment"
            data-testid="reliquary-push-notice"
          >
            <div className="font-semibold text-bone">
              Fork Push Target: {pushInfo.targetFork || "Owner Fork"}
            </div>
            <div>
              Branch: <span className="crypt-well px-1.5 py-0.5 text-emerald-300">graveyard/{runId}</span>
            </div>
            <div className="text-ash">
              The source repository is not touched.
            </div>
          </div>
        )}

        {/* Model reading verification status (Requirement 38.15) */}
        {reportCheckInfo?.failed && (
          <div
            className="crypt-panel border-l-2 border-l-rose-500 border-[var(--crimson-seal-border)] p-3.5 text-xs font-mono text-rose-300"
            data-testid="reliquary-report-check-failed"
          >
            The model reading failed verification.
          </div>
        )}
      </section>

      {/* 2. Before and After Table (Requirements 38.4 & 38.5) */}
      <section className="space-y-3" data-testid="section-verification">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-bone uppercase tracking-[0.16em]">
            01 · Verification (Before &amp; After)
          </h3>
        </div>
        <ReliquaryBeforeAfterTable rows={beforeAfterRows} />
      </section>

      <CryptOrnament kind="divider" />

      {/* 3. Diff Browser (Requirement 38.6 & 38.11) */}
      <section className="space-y-3" data-testid="section-diff">
        <h3 className="text-xs font-semibold text-bone uppercase tracking-[0.16em]">
          02 · Diff Browser
        </h3>
        <ReliquaryDiffViewer
          diff={diff}
          hunks={hunks}
          noTasksMerged={noTasksMerged}
        />
      </section>

      <CryptOrnament kind="divider" />

      {/* 4. Task Ledger (Requirement 38.7) */}
      <section className="space-y-3" data-testid="section-task-ledger">
        <h3 className="text-xs font-semibold text-bone uppercase tracking-[0.16em]">
          03 · Task Ledger
        </h3>
        <ReliquaryTaskLedger tasks={tasks} />
      </section>

      <CryptOrnament kind="divider" />

      {/* 5. Artifact Downloads (Requirements 38.8, 38.10, 38.11, 38.12) */}
      <section className="space-y-3" data-testid="section-downloads">
        <h3 className="text-xs font-semibold text-bone uppercase tracking-[0.16em]">
          04 · Artifact Downloads
        </h3>
        <ReliquaryArtifactDownloads
          runId={runId}
          artifacts={artifacts}
          packing={packing}
          noTasksMerged={noTasksMerged}
        />
      </section>

      {/* 6. Open in Kiro handoff instructions (Requirement 38.9) */}
      <OpenInKiroHandoff
        owner={owner}
        repo={repo}
        baseSha={baseSha}
        runId={runId}
      />

      <CryptOrnament kind="divider" />

      {/* Footer */}
      <footer className="pt-2 pb-4 text-center text-xs text-dust font-mono">
        {GATE_FOOTER}
      </footer>
    </div>
  );
}

export default ReliquaryView;
