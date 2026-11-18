"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import { StatusPill, type StatusPillProps } from "@/components/ui/StatusPill";
import {
  fetchBackendDiagnostics,
  getLiveClientState,
  subscribeUiDebugState,
  type BackendDiagnosticsResult,
  type HealthDetailPayload,
  type LiveClientState,
} from "@/lib/ui-debug";

const DEFAULT_CLIENT_STATE: LiveClientState = {
  isBrowser: false,
  pathname: "/",
  search: "",
  uiDebugActive: false,
  outlineOverlay: false,
  reducedMotionPreview: false,
  activeRuns: [],
  updatedAt: null,
};

function healthTone(health: HealthDetailPayload | null, locked: boolean, error: string | null): StatusPillProps["tone"] {
  if (locked) return "amber";
  if (error && !health) return "crimson";
  if (!health) return "neutral";
  if (health.status === "open" && health.ok !== false) return "emerald";
  if (health.status === "queue length" || health.status === "paused by owner") return "amber";
  return "crimson";
}

function streamStatusTone(run: LiveClientState["activeRuns"][number]): {
  tone: StatusPillProps["tone"];
  label: string;
  pulse: boolean;
} {
  if (run.loadError) return { tone: "crimson", label: "error", pulse: false };
  if (run.reconnecting) return { tone: "amber", label: "reconnecting", pulse: true };
  if (run.loading) return { tone: "neutral", label: "loading", pulse: true };
  return { tone: "emerald", label: "live", pulse: true };
}

export function UiDebugLiveHud() {
  const [expanded, setExpanded] = useState(false);
  const [clientState, setClientState] = useState<LiveClientState>(DEFAULT_CLIENT_STATE);
  const [domCount, setDomCount] = useState<number>(0);
  const [health, setHealth] = useState<HealthDetailPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [backendResult, setBackendResult] = useState<BackendDiagnosticsResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const scanDomAndClient = useCallback(() => {
    setClientState(getLiveClientState());
    if (typeof document !== "undefined") {
      setDomCount(document.querySelectorAll("[data-ui-element]").length);
    }
  }, []);

  const refreshTelemetry = useCallback(async () => {
    scanDomAndClient();
    if (typeof fetch !== "function") return;
    setRefreshing(true);
    try {
      const [healthOutcome, diagOutcome] = await Promise.allSettled([
        fetch("/api/health?detail=1", { cache: "no-store" }),
        fetchBackendDiagnostics({ probeToolchains: false }),
      ]);

      if (healthOutcome.status === "fulfilled") {
        const res = healthOutcome.value;
        try {
          const json = (await res.json()) as HealthDetailPayload;
          setHealth(json);
          setHealthError(res.ok ? null : `HTTP ${res.status}`);
        } catch {
          setHealthError(`HTTP ${res.status}`);
        }
      } else {
        setHealthError("Health unreachable");
      }

      if (diagOutcome.status === "fulfilled") {
        setBackendResult(diagOutcome.value);
      }
    } finally {
      scanDomAndClient();
      setRefreshing(false);
    }
  }, [scanDomAndClient]);

  useEffect(() => {
    const unsubscribe = subscribeUiDebugState((nextState) => {
      setClientState(nextState);
      if (typeof document !== "undefined") {
        setDomCount(document.querySelectorAll("[data-ui-element]").length);
      }
    });
    void refreshTelemetry();
    return () => {
      unsubscribe();
    };
  }, [refreshTelemetry]);

  function handleToggleOutline() {
    if (typeof window === "undefined") return;
    const next = !clientState.outlineOverlay;
    window.__GIT_GRAVEYARD_UI_DEBUG__?.setOutlineOverlay(next);
    scanDomAndClient();
  }

  function handleToggleReducedMotion() {
    if (typeof window === "undefined") return;
    const next = !clientState.reducedMotionPreview;
    window.__GIT_GRAVEYARD_UI_DEBUG__?.setReducedMotionPreview(next);
    scanDomAndClient();
  }

  const diag = backendResult?.status?.diagnostics ?? null;
  const diagLocked = Boolean(backendResult?.locked);
  const statusPillLabel = diagLocked
    ? "debug locked"
    : health?.status ?? (healthError ? "offline" : "probing");

  return (
    <aside
      data-testid="ui-debug-live-hud"
      data-ui-element="ui-debug-live-hud"
      data-ui-state={expanded ? "expanded" : "collapsed"}
      className="fixed bottom-4 right-4 z-50 font-mono text-xs text-bone flex flex-col items-end gap-2 max-w-[calc(100vw-2rem)]"
    >
      {expanded && (
        <div
          data-testid="ui-debug-hud-drawer"
          className="crypt-panel-engraved w-[360px] max-w-full max-h-[78vh] overflow-y-auto p-3.5 space-y-3 shadow-2xl"
        >
          {/* Drawer Header */}
          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <CryptOrnament kind="arch-sigil" className="w-4 h-4 text-emerald-400" />
              <span className="font-semibold text-bone truncate">Live State HUD</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="ui-debug-hud-refresh"
                onClick={() => void refreshTelemetry()}
                disabled={refreshing}
                className="crypt-btn-ghost px-2 py-0.5 rounded text-[11px]"
              >
                {refreshing ? "..." : "Refresh"}
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="Collapse debug HUD"
                className="crypt-btn-ghost px-2 py-0.5 rounded text-[11px]"
              >
                ×
              </button>
            </div>
          </div>

          {/* Client Route & DOM Count */}
          <div className="crypt-well p-2.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-dust">
              <span>Client Route</span>
              <span>DOM Elements: {domCount}</span>
            </div>
            <div className="text-[11px] text-emerald-300 break-all">
              {clientState.pathname}
              {clientState.search}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button"
                onClick={handleToggleOutline}
                className={
                  clientState.outlineOverlay
                    ? "crypt-btn-primary px-2 py-0.5 rounded text-[10px]"
                    : "crypt-btn-ghost px-2 py-0.5 rounded text-[10px]"
                }
              >
                Outline: {clientState.outlineOverlay ? "ON" : "OFF"}
              </button>
              <button
                type="button"
                onClick={handleToggleReducedMotion}
                className={
                  clientState.reducedMotionPreview
                    ? "crypt-btn-primary px-2 py-0.5 rounded text-[10px]"
                    : "crypt-btn-ghost px-2 py-0.5 rounded text-[10px]"
                }
              >
                Reduced Motion: {clientState.reducedMotionPreview ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          {/* Active useRunStream Snapshots */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-dust">
              <span>Active Streams ({clientState.activeRuns.length})</span>
            </div>
            {clientState.activeRuns.length === 0 ? (
              <div className="crypt-well p-2 text-[11px] text-ash">
                No active useRunStream hooks on this view.
              </div>
            ) : (
              <div className="space-y-1.5">
                {clientState.activeRuns.map((run) => {
                  const st = streamStatusTone(run);
                  return (
                    <div
                      key={run.runId}
                      className="crypt-well p-2 space-y-1 border border-white/10"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-bone truncate">
                          {run.runId}
                        </span>
                        <StatusPill tone={st.tone} label={st.label} pulse={st.pulse} />
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ash">
                        <span>phase: {run.phase}</span>
                        <span>seq: {run.lastSeq}</span>
                        <span>sk: {run.skeletonCount}</span>
                        <span>appr: {run.pendingApprovalsCount}</span>
                        <span>asks: {run.openAsksCount}</span>
                      </div>
                      {run.loadError && (
                        <div className="text-[10px] text-rose-300 break-words">
                          {run.loadError}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Real Backend Snapshot */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-dust">
              <span>Backend Diagnostics</span>
              <StatusPill
                tone={healthTone(health, diagLocked, backendResult?.error ?? healthError)}
                label={statusPillLabel}
              />
            </div>
            <div className="crypt-well p-2.5 space-y-1 text-[11px]">
              {health ? (
                <div className="flex items-center justify-between gap-2 text-parchment">
                  <span className="truncate">{health.badgeText ?? health.status}</span>
                  <span className="text-[10px] text-dust shrink-0">
                    q:{health.queueLength ?? 0}
                  </span>
                </div>
              ) : (
                <div className="text-ash">
                  {healthError ?? "Health not fetched yet."}
                </div>
              )}

              {diag ? (
                <div className="pt-1 border-t border-white/10 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-ash">
                  <span>
                    RunStore: {diag.stores.runStore.storageMode} ({diag.stores.runStore.totalRuns})
                  </span>
                  <span>
                    Events: {diag.stores.eventStore.totalEvents}
                  </span>
                  <span>
                    Host: {diag.runtimeHost.backendKind || "none"}
                  </span>
                  <span>
                    Probes: {diag.probes.devAllowed ? "dev-ok" : "blocked"}
                  </span>
                </div>
              ) : backendResult?.error ? (
                <div className="pt-1 border-t border-white/10 text-[10px] text-amber-300 break-words">
                  {backendResult.locked
                    ? "Debug status locked (403). Use ?uiDebug=1 or admin auth."
                    : backendResult.error}
                </div>
              ) : null}
            </div>
          </div>

          {/* Direct link to Live Inspector */}
          <Link
            href="/debug/ui?uiDebug=1&mode=live"
            data-testid="ui-debug-hud-open-inspector"
            className="crypt-btn-primary w-full py-1.5 px-3 rounded text-xs"
          >
            Open Live Inspector
          </Link>
        </div>
      )}

      {/* Compact Collapsible Trigger Pill */}
      <button
        type="button"
        data-testid="ui-debug-hud-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        className="crypt-panel-engraved px-3 py-1.5 flex items-center gap-2 hover:border-emerald-400/45 transition-colors cursor-pointer shadow-xl"
      >
        <span
          aria-hidden="true"
          className={`w-2 h-2 rounded-full ${
            diagLocked
              ? "bg-amber-400"
              : health?.ok
              ? "bg-emerald-400 crypt-pulse-emerald"
              : healthError
              ? "bg-rose-400"
              : "bg-neutral-400"
          }`}
        />
        <span className="font-semibold tracking-wider text-bone">UI-DEBUG HUD</span>
        <span className="text-[10px] text-ash">
          streams:{clientState.activeRuns.length} · dom:{domCount}
        </span>
        <span className="text-[10px] text-emerald-300">
          {expanded ? "▼" : "▲"}
        </span>
      </button>
    </aside>
  );
}
