"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CryptOrnament } from "./CryptOrnament";
import { fetchRunSummary } from "@/lib/ui/api";
import { onRunPhase } from "@/lib/ui/run-phase-bus";
import {
  canOpenStage,
  repoFromUrl,
  routes,
  runIdFromPath,
  stageLockedReason,
  type RunStage,
} from "@/lib/ui/run-routes";

export interface CryptNavProps {
  currentPath?: string;
  runId?: string;
  /** Run phase when the caller already knows it (tests, debug lab). */
  runPhase?: string;
}

type NavStage =
  | "gate"
  | "tomb"
  | "pact"
  | "legion"
  | "relic"
  | "history"
  | "replay"
  | "debug";

type PipelineKey = "gate" | "tomb" | "pact" | "legion" | "relic";

const PIPELINE_STAGES: readonly { key: PipelineKey; label: string }[] = [
  { key: "gate", label: "I. GATE" },
  { key: "tomb", label: "II. TOMB" },
  { key: "pact", label: "III. PACT" },
  { key: "legion", label: "IV. LEGION" },
  { key: "relic", label: "V. RELIQUARY" },
];

function resolveActiveStage(pathname: string): NavStage {
  if (pathname.startsWith("/tomb")) return "tomb";
  if (pathname.startsWith("/runs/") && pathname.includes("/pact")) return "pact";
  if (pathname.startsWith("/runs/") && pathname.includes("/legion")) return "legion";
  if (pathname.startsWith("/runs/") && pathname.includes("/relic")) return "relic";
  if (pathname.startsWith("/history")) return "history";
  if (pathname.startsWith("/replay")) return "replay";
  if (pathname.startsWith("/debug")) return "debug";
  return "gate";
}

function getStageIndex(stage: NavStage): number {
  return PIPELINE_STAGES.findIndex((s) => s.key === stage);
}

interface StageLink {
  href: string | null;
  lockedReason: string | null;
}

export function CryptNav({ currentPath, runId, runPhase }: CryptNavProps = {}) {
  let hookPathname: string | null = null;
  try {
    hookPathname = usePathname();
  } catch {
    hookPathname = null;
  }

  const pathname = currentPath ?? hookPathname ?? "/";
  const activeStage = resolveActiveStage(pathname);
  const activeIndex = getStageIndex(activeStage);
  const pathRunId = runId || runIdFromPath(pathname) || undefined;

  const [uiDebugParam, setUiDebugParam] = useState(false);
  // A run announced by the screen itself (the Tombstone follows a run that is
  // named in its query string, not its path). Cleared on navigation.
  const [announced, setAnnounced] = useState<{
    path: string;
    runId: string;
    phase: string;
  } | null>(null);
  // What the server says about the run: phase and source repository.
  const [runInfo, setRunInfo] = useState<{
    runId: string;
    phase: string | null;
    repoUrl: string | null;
  } | null>(null);

  const announcedHere = announced && announced.path === pathname ? announced : null;
  const resolvedRunId = pathRunId ?? announcedHere?.runId;

  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const pathRunIdRef = useRef(pathRunId);
  pathRunIdRef.current = pathRunId;

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("uiDebug") === "1") {
        setUiDebugParam(true);
      }
    } catch {
      // Ignore query parsing errors
    }
  }, []);

  // Screens that follow a run live report its phase as it changes. Subscribed
  // once on mount via refs so client navigations never open a re-subscribe gap.
  useEffect(() => {
    return onRunPhase((notice) => {
      const activePathRunId = pathRunIdRef.current;
      if (activePathRunId && notice.runId !== activePathRunId) return;
      setAnnounced({
        path: pathnameRef.current,
        runId: notice.runId,
        phase: notice.phase,
      });
    });
  }, []);

  useEffect(() => {
    if (!resolvedRunId) {
      setRunInfo(null);
      return;
    }
    let cancelled = false;
    fetchRunSummary(resolvedRunId).then((result) => {
      if (cancelled || !result.ok) return;
      setRunInfo({
        runId: resolvedRunId,
        phase: result.summary.phase,
        repoUrl: result.summary.url,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [resolvedRunId]);

  // The live announcement is newer than the one-off fetch.
  const knownPhase =
    runPhase ??
    (announcedHere?.runId === resolvedRunId ? announcedHere?.phase : null) ??
    (runInfo?.runId === resolvedRunId ? runInfo?.phase : null) ??
    null;
  const repo =
    runInfo?.runId === resolvedRunId ? repoFromUrl(runInfo?.repoUrl) : null;
  const showUiLab = process.env.NODE_ENV !== "production" || uiDebugParam;

  function resolveStage(key: PipelineKey): StageLink {
    if (key === "gate") return { href: routes.gate(), lockedReason: null };
    if (key === "tomb") {
      if (!repo) return { href: null, lockedReason: null };
      const baseTomb = routes.tomb(repo.owner, repo.repo);
      return {
        href: resolvedRunId
          ? `${baseTomb}?run=${encodeURIComponent(resolvedRunId)}`
          : baseTomb,
        lockedReason: null,
      };
    }
    if (!resolvedRunId) return { href: null, lockedReason: null };
    const stage: RunStage = key;
    if (!canOpenStage(stage, knownPhase)) {
      return { href: null, lockedReason: stageLockedReason(stage, knownPhase) };
    }
    return { href: routes[stage](resolvedRunId), lockedReason: null };
  }

  return (
    <header
      data-ui-element="crypt-nav"
      data-ui-state={activeStage}
      data-ui-variant={resolvedRunId ? "with-run" : "global"}
      data-run-phase={knownPhase ?? undefined}
      className="sticky top-0 z-40 border-b border-white/10 bg-[#0b0d11]/85 backdrop-blur-md"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        {/* Left Cluster: Brand Sigil */}
        <Link
          href="/"
          className="flex items-center gap-2.5 group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 rounded"
        >
          <CryptOrnament
            kind="arch-sigil"
            className="w-5 h-5 text-emerald-400 group-hover:text-emerald-300 transition-colors"
          />
          <span className="text-sm font-bold tracking-wider text-bone group-hover:text-emerald-200 transition-colors">
            GIT-GRAVEYARD
          </span>
          <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.03] text-[10px] tracking-widest text-dust uppercase">
            v0.1 · CRYPT
          </span>
        </Link>

        {/* Center Cluster: 5-Stage Ritual Stepper */}
        <nav
          aria-label="Ritual pipeline stages"
          className="hidden lg:flex items-center gap-1 text-[11px] font-mono"
        >
          {PIPELINE_STAGES.map((stage, idx) => {
            const isActive = activeStage === stage.key;
            const isCompleted = activeIndex > idx;
            const { href, lockedReason } = resolveStage(stage.key);

            const stageClasses = isActive
              ? "px-2.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-semibold shadow-[0_0_14px_-6px_rgba(16,185,129,0.5)]"
              : href && isCompleted
              ? "px-2.5 py-1 rounded border border-transparent text-neutral-300 hover:text-bone hover:border-white/10"
              : href
              ? "px-2.5 py-1 rounded border border-transparent text-neutral-400 hover:text-neutral-200 hover:border-white/10"
              : "px-2.5 py-1 rounded border border-transparent text-neutral-600";

            return (
              <React.Fragment key={stage.key}>
                {idx > 0 && (
                  <span aria-hidden="true" className="text-neutral-700 px-0.5">
                    →
                  </span>
                )}
                {href && !isActive ? (
                  <Link
                    href={href}
                    data-nav-stage={stage.key}
                    className={`${stageClasses} transition-colors`}
                  >
                    {stage.label}
                  </Link>
                ) : (
                  <span
                    data-nav-stage={stage.key}
                    aria-current={isActive ? "step" : undefined}
                    aria-disabled={!isActive && !href ? true : undefined}
                    title={lockedReason ?? undefined}
                    className={stageClasses}
                  >
                    {stage.label}
                  </span>
                )}
              </React.Fragment>
            );
          })}

          {activeStage === "replay" && (
            <>
              <span aria-hidden="true" className="text-neutral-700 px-1">
                ·
              </span>
              <span
                aria-current="page"
                className="px-2.5 py-1 rounded border border-violet-500/40 bg-violet-500/10 text-violet-300 font-semibold"
              >
                REPLAY
              </span>
            </>
          )}
        </nav>

        {/* Right Cluster: Utility Links */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <Link
            href={routes.builtWithKiro()}
            data-nav-link="built-with-kiro"
            className={`px-2.5 py-1 rounded border transition-colors ${
              pathname.startsWith("/built-with-kiro")
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-white/[0.03] text-neutral-300 hover:text-bone hover:border-white/20"
            }`}
          >
            Built with Kiro
          </Link>

          <Link
            href={routes.admin()}
            data-nav-link="admin"
            className={`px-2.5 py-1 rounded border transition-colors ${
              pathname.startsWith("/admin")
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-white/[0.03] text-neutral-300 hover:text-bone hover:border-white/20"
            }`}
          >
            Admin
          </Link>

          <Link
            href={routes.history()}
            data-nav-link="history"
            className={`px-2.5 py-1 rounded border transition-colors ${
              activeStage === "history"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-white/[0.03] text-neutral-300 hover:text-bone hover:border-white/20"
            }`}
          >
            History Vault
          </Link>

          {showUiLab && (
            <Link
              href="/debug/ui"
              className={`px-2 py-1 rounded border text-[11px] transition-colors ${
                activeStage === "debug"
                  ? "border-emerald-500/45 bg-emerald-500/15 text-emerald-300"
                  : "border-emerald-500/25 bg-emerald-950/30 text-emerald-400/90 hover:text-emerald-300 hover:border-emerald-400/45"
              }`}
            >
              UI Lab
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
