"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StatusPill, type StatusPillProps } from "@/components/ui/StatusPill";
import { routes } from "@/lib/ui/run-routes";
import { openAsks, pendingApprovals } from "@/lib/ui/run-model";
import { useRunStream } from "@/lib/ui/use-run-stream";
import {
  fetchBackendDiagnostics,
  getLiveClientState,
  subscribeUiDebugState,
  type BackendDebugDiagnostics,
  type BackendDebugRunResponse,
  type HealthDetailPayload,
  type LiveClientState,
  type UiDebugElementSnapshot,
} from "@/lib/ui-debug";

const SIM_STEPS = [
  "exhume",
  "certificate",
  "plan",
  "pact",
  "legion",
  "approval",
  "ask",
  "done_resurrected",
  "done_partial",
  "publish",
] as const;

type SimStep = (typeof SIM_STEPS)[number];

interface ProbeRecord {
  key: string;
  url: string;
  status: number | null;
  ok: boolean;
  latencyMs: number;
  payload: unknown;
  error: string | null;
  probedAt: string;
}

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

function formatCompact(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `${value.length} item(s)`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[object]";
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function boolTone(val: boolean | undefined, invert = false): StatusPillProps["tone"] {
  if (val === undefined) return "neutral";
  const good = invert ? !val : val;
  return good ? "emerald" : "crimson";
}

function phaseTone(phase: string | null | undefined, outcome?: string | null): StatusPillProps["tone"] {
  if (outcome === "resurrected" || outcome === "healthy_already") return "emerald";
  if (outcome === "partial" || outcome === "budget_stopped") return "amber";
  if (outcome === "error" || outcome === "killed" || outcome === "not_resurrected") return "crimson";
  if (phase === "done") return "emerald";
  if (phase === "pact_review") return "violet";
  if (phase === "legion" || phase === "exhume" || phase === "plan") return "amber";
  return "neutral";
}

function normalizeArtifacts(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, val]) =>
      val && typeof val === "object"
        ? { name: key, ...(val as Record<string, unknown>) }
        : { name: key, value: val }
    );
  }
  return [];
}

function KeyValueGrid({
  rows,
}: {
  rows: Array<{ label: string; value: unknown; tone?: StatusPillProps["tone"] }>;
}) {
  return (
    <dl className="grid grid-cols-1 gap-1 text-[11px]">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-2 py-0.5 border-b border-white/[0.05] last:border-b-0"
        >
          <dt className="text-ash shrink-0">{row.label}</dt>
          <dd className="text-right text-parchment break-all">
            {row.tone ? (
              <StatusPill tone={row.tone} label={formatCompact(row.value)} />
            ) : (
              formatCompact(row.value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

async function runHttpProbe(key: string, url: string, init?: RequestInit): Promise<ProbeRecord> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text payload when response is not JSON
    }
    return {
      key,
      url,
      status: res.status,
      ok: res.ok,
      latencyMs: Math.max(0, Math.round(ended - started)),
      payload,
      error: res.ok ? null : `HTTP ${res.status}`,
      probedAt: new Date().toISOString(),
    };
  } catch (err) {
    const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      key,
      url,
      status: null,
      ok: false,
      latencyMs: Math.max(0, Math.round(ended - started)),
      payload: null,
      error: err instanceof Error ? err.message : "Network error",
      probedAt: new Date().toISOString(),
    };
  }
}

function SelectedRunStreamParityCard({
  runId,
  runDiag,
}: {
  runId: string;
  runDiag: BackendDebugRunResponse | null;
}) {
  const liveStream = useRunStream(runId, { live: true });

  return (
    <div className="crypt-well p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-dust">
        Backend vs Reducer Parity
      </div>
      <KeyValueGrid
        rows={[
          { label: "runStorePhase", value: runDiag?.phaseParity?.runStorePhase },
          { label: "reducedViewPhase", value: runDiag?.phaseParity?.reducedViewPhase },
          {
            label: "parityOk",
            value: runDiag?.phaseParity?.parityOk,
            tone: boolTone(runDiag?.phaseParity?.parityOk),
          },
          { label: "liveStream.phase", value: liveStream.view.phase },
          { label: "liveStream.lastSeq", value: liveStream.view.lastSeq },
          {
            label: "liveStream.sse",
            value: liveStream.loadError
              ? liveStream.loadError
              : liveStream.reconnecting
              ? "reconnecting"
              : liveStream.loading
              ? "loading"
              : "connected",
          },
          {
            label: "liveStream.counts",
            value: `sk:${liveStream.view.skeletons.length} appr:${pendingApprovals(liveStream.view).length} asks:${openAsks(liveStream.view).length}`,
          },
        ]}
      />
    </div>
  );
}

export function LiveStateInspector() {
  const [statusLoading, setStatusLoading] = useState(false);
  const [autoPoll, setAutoPoll] = useState(false);
  const [diagnostics, setDiagnostics] = useState<BackendDebugDiagnostics | null>(null);
  const [healthDetail, setHealthDetail] = useState<HealthDetailPayload | null>(null);
  const [statusCode, setStatusCode] = useState<number | null>(null);
  const [statusLocked, setStatusLocked] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [runInput, setRunInput] = useState<string>("");
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runDiag, setRunDiag] = useState<BackendDebugRunResponse | null>(null);

  const [probeRunId, setProbeRunId] = useState<string>("");
  const [probingKey, setProbingKey] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeRecord>>({});
  const [activeProbeKey, setActiveProbeKey] = useState<string | null>(null);

  const [inviteCodeDraft, setInviteCodeDraft] = useState("dev-diag-01");
  const [inviteLimitDraft, setInviteLimitDraft] = useState("5");
  const [simRunIdDraft, setSimRunIdDraft] = useState("sim-diag-01");
  const [simStepDraft, setSimStepDraft] = useState<SimStep>("exhume");
  const [simBusy, setSimBusy] = useState(false);
  const [simResult, setSimResult] = useState<ProbeRecord | null>(null);

  const [clientState, setClientState] = useState<LiveClientState>(DEFAULT_CLIENT_STATE);
  const [domElements, setDomElements] = useState<UiDebugElementSnapshot[]>([]);
  const [themeTokenCount, setThemeTokenCount] = useState(0);

  const scanDomRegistry = useCallback(() => {
    setClientState(getLiveClientState());
    if (typeof window === "undefined") return;
    const api = window.__GIT_GRAVEYARD_UI_DEBUG__;
    if (api) {
      setDomElements(api.listElements());
      setThemeTokenCount(Object.keys(api.getThemeTokens()).length);
    } else if (typeof document !== "undefined") {
      const nodes = Array.from(document.querySelectorAll("[data-ui-element]"));
      setDomElements(
        nodes.map((el) => ({
          element: el.getAttribute("data-ui-element") ?? "",
          state: el.getAttribute("data-ui-state"),
          variant: el.getAttribute("data-ui-variant"),
          testId: el.getAttribute("data-testid"),
          rect: { x: 0, y: 0, width: 0, height: 0 },
          visible: true,
        }))
      );
    }
  }, []);

  const refreshSystemStatus = useCallback(async (targetRunId?: string) => {
    if (typeof fetch !== "function") return;
    setStatusLoading(true);
    try {
      const [diagResult, healthProbe] = await Promise.all([
        fetchBackendDiagnostics({
          runId: targetRunId || undefined,
          probeToolchains: true,
        }),
        runHttpProbe("health", "/api/health?detail=1"),
      ]);

      setStatusCode(diagResult.statusCode);
      setStatusLocked(diagResult.locked);
      setStatusError(diagResult.error);
      setDiagnostics(diagResult.status?.diagnostics ?? null);
      setLastFetchedAt(diagResult.fetchedAt);

      if (healthProbe.payload && typeof healthProbe.payload === "object") {
        setHealthDetail(healthProbe.payload as HealthDetailPayload);
      }

      if (targetRunId) {
        if (diagResult.run && diagResult.run.ok) {
          setRunDiag(diagResult.run);
          setRunError(null);
        } else if (diagResult.run) {
          setRunDiag(diagResult.run);
          setRunError(diagResult.run.error ?? "Failed to inspect run");
        }
      }
    } finally {
      setStatusLoading(false);
      scanDomRegistry();
    }
  }, [scanDomRegistry]);

  const fetchSelectedRun = useCallback(async (runId: string) => {
    const trimmed = runId.trim();
    if (!trimmed || typeof fetch !== "function") {
      setRunDiag(null);
      setRunError(null);
      return;
    }
    setRunLoading(true);
    setRunError(null);
    try {
      const res = await fetch(
        `/api/debug/runs/${encodeURIComponent(trimmed)}?uiDebug=1`,
        { cache: "no-store" }
      );
      let body: BackendDebugRunResponse | null = null;
      try {
        body = (await res.json()) as BackendDebugRunResponse;
      } catch {
        body = null;
      }
      if (!res.ok || !body?.ok) {
        setRunDiag(body);
        setRunError(
          body?.error ??
            (res.status === 403
              ? "Run debug endpoint locked (403)"
              : res.status === 404
              ? `Run ${trimmed} not found (404)`
              : `HTTP ${res.status}`)
        );
      } else {
        setRunDiag(body);
        setRunError(null);
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Network error loading run");
    } finally {
      setRunLoading(false);
    }
  }, []);

  // Initial client load + live client store subscription (never during SSR)
  useEffect(() => {
    const unsub = subscribeUiDebugState((next) => setClientState(next));
    scanDomRegistry();
    void refreshSystemStatus();
    return () => {
      unsub();
    };
  }, [refreshSystemStatus, scanDomRegistry]);

  // Fetch deep diagnostics when selectedRunId changes
  useEffect(() => {
    if (!selectedRunId) return;
    setProbeRunId((prev) => prev || selectedRunId);
    void fetchSelectedRun(selectedRunId);
  }, [selectedRunId, fetchSelectedRun]);

  // 3s auto-poll loop
  useEffect(() => {
    if (!autoPoll) return;
    const timer = setInterval(() => {
      void refreshSystemStatus(selectedRunId || undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [autoPoll, selectedRunId, refreshSystemStatus]);

  function handleInspectRunSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = runInput.trim();
    if (!next) return;
    setProbeRunId(next);
    if (next === selectedRunId) {
      void fetchSelectedRun(next);
    } else {
      setSelectedRunId(next);
    }
  }

  async function handleProbe(key: string, url: string) {
    setProbingKey(key);
    const result = await runHttpProbe(key, url);
    setProbeResults((prev) => ({ ...prev, [key]: result }));
    setActiveProbeKey(key);
    setProbingKey(null);
  }

  const effectiveProbeRunId = (probeRunId || selectedRunId || "").trim();
  const probeEndpoints = [
    { key: "health", label: "GET /api/health?detail=1", url: "/api/health?detail=1" },
    {
      key: "debug_status",
      label: "GET /api/debug/status?uiDebug=1",
      url: "/api/debug/status?uiDebug=1",
    },
    { key: "history", label: "GET /api/history", url: "/api/history" },
    {
      key: "run_detail",
      label: `GET /api/runs/${effectiveProbeRunId || "<id>"}`,
      url: effectiveProbeRunId ? `/api/runs/${encodeURIComponent(effectiveProbeRunId)}` : "",
    },
    {
      key: "run_events",
      label: `GET /api/runs/${effectiveProbeRunId || "<id>"}/events?from=1&to=20`,
      url: effectiveProbeRunId
        ? `/api/runs/${encodeURIComponent(effectiveProbeRunId)}/events?from=1&to=20`
        : "",
    },
  ];

  async function handleProbeAll() {
    for (const ep of probeEndpoints) {
      if (!ep.url) continue;
      await handleProbe(ep.key, ep.url);
    }
  }

  async function handleSimRequest(payload: Record<string, unknown>, followRunId?: string) {
    setSimBusy(true);
    try {
      const record = await runHttpProbe("sim", "/api/debug/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSimResult(record);
      if (followRunId) {
        setSelectedRunId(followRunId);
        setRunInput(followRunId);
        setProbeRunId(followRunId);
      }
      await refreshSystemStatus(followRunId || selectedRunId || undefined);
    } finally {
      setSimBusy(false);
    }
  }

  const showDevSimPanel = (diagnostics?.nodeEnv ?? process.env.NODE_ENV) !== "production";
  const artifacts = normalizeArtifacts(runDiag?.artifacts);
  const toolchainEntries = diagnostics?.toolchains
    ? Object.entries(diagnostics.toolchains)
    : [];
  const envEntries = diagnostics?.envPresence
    ? Object.entries(diagnostics.envPresence)
    : [];

  return (
    <div
      data-testid="ui-debug-live-inspector"
      data-ui-element="ui-debug-live-inspector"
      data-ui-state={
        statusLoading
          ? "loading"
          : statusLocked
          ? "locked"
          : statusError
          ? "error"
          : "ready"
      }
      className="space-y-6 font-mono text-bone"
    >
      {/* Top Toolbar */}
      <section className="crypt-panel p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider font-semibold text-emerald-300">
              Live Runtime State Inspector
            </span>
            <StatusPill
              tone={
                statusLocked
                  ? "amber"
                  : statusError && !diagnostics
                  ? "crimson"
                  : diagnostics?.health.ok
                  ? "emerald"
                  : "neutral"
              }
              label={
                statusLocked
                  ? "locked (403)"
                  : statusError && !diagnostics
                  ? `error (${statusCode ?? "net"})`
                  : diagnostics?.health.status ?? (statusLoading ? "loading" : "idle")
              }
              pulse={autoPoll}
            />
            {lastFetchedAt ? (
              <span className="text-[11px] text-dust">
                Updated {new Date(lastFetchedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-ash">
            Reads live backend stores, admission queue, RuntimeHost, RunOrchestrator, Phase 0 probes, and SSE reducer parity.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="live-inspector-refresh"
            onClick={() => void refreshSystemStatus(selectedRunId || undefined)}
            disabled={statusLoading}
            className="crypt-btn-primary px-3 py-1.5 rounded text-xs"
          >
            {statusLoading ? "Refreshing..." : "Refresh All"}
          </button>
          <button
            type="button"
            data-testid="live-inspector-autopoll"
            onClick={() => setAutoPoll((prev) => !prev)}
            className={
              autoPoll
                ? "crypt-btn-primary px-3 py-1.5 rounded text-xs"
                : "crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            }
          >
            {autoPoll ? "Auto-Poll (3s): ON" : "Auto-Poll (3s): OFF"}
          </button>
        </div>
      </section>

      {/* Graceful Status / Lock / Missing Route Banner */}
      {statusError && (
        <div
          data-testid="live-inspector-status-notice"
          className={`crypt-panel p-4 text-xs border-l-2 ${
            statusLocked
              ? "border-l-amber-400 bg-amber-950/20 text-amber-200"
              : "border-l-rose-400 bg-rose-950/20 text-rose-200"
          }`}
        >
          <div className="font-semibold">
            {statusLocked
              ? "Backend Debug Status Locked (403)"
              : statusCode === 404
              ? "Debug Status Endpoint Not Found (404)"
              : "Backend Diagnostics Notice"}
          </div>
          <div className="mt-1 text-parchment/90">
            {statusLocked
              ? "Access requires non-production NODE_ENV, ?uiDebug=1, or a valid ADMIN_TOKEN."
              : statusError}
          </div>
        </div>
      )}

      {/* 1. System & Runtime Telemetry Grid */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-ash font-semibold">
          1. Live System, Stores, Admission, RuntimeHost, Orchestrator &amp; Probes
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {/* Health & Environment */}
          <div className="crypt-panel p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-bone uppercase">Live Health</h3>
              <StatusPill
                tone={
                  (diagnostics?.health.ok ?? healthDetail?.ok) ? "emerald" : "amber"
                }
                label={
                  diagnostics?.health.badgeText ??
                  healthDetail?.badgeText ??
                  healthDetail?.status ??
                  "unprobed"
                }
              />
            </div>
            <KeyValueGrid
              rows={[
                { label: "status", value: diagnostics?.health.status ?? healthDetail?.status },
                { label: "reason", value: diagnostics?.health.reason ?? healthDetail?.reason },
                { label: "queueLength", value: diagnostics?.health.queueLength ?? healthDetail?.queueLength },
                { label: "engineVersion", value: diagnostics?.engineVersion ?? healthDetail?.engineVersion },
                { label: "nodeVersion", value: diagnostics?.nodeVersion },
                { label: "platform / env", value: diagnostics ? `${diagnostics.platform} · ${diagnostics.nodeEnv}` : "-" },
              ]}
            />
          </div>

          {/* Admission Queue */}
          <div className="crypt-panel p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-bone uppercase">Admission Queue</h3>
              <StatusPill
                tone={boolTone(diagnostics?.admission.healthy)}
                label={diagnostics?.admission.healthy ? "healthy" : "unhealthy"}
              />
            </div>
            <KeyValueGrid
              rows={[
                { label: "paused", value: diagnostics?.admission.paused, tone: boolTone(diagnostics?.admission.paused, true) },
                { label: "unavailable", value: diagnostics?.admission.unavailable, tone: boolTone(diagnostics?.admission.unavailable, true) },
                { label: "reason", value: diagnostics?.admission.reason },
                {
                  label: "queueLength / cap",
                  value: diagnostics
                    ? `${diagnostics.admission.queueLength} / ${diagnostics.admission.queueDepthCap}`
                    : "-",
                },
                { label: "liveCapacity", value: diagnostics?.admission.liveCapacity },
                { label: "activeLiveRunIds", value: diagnostics?.admission.activeLiveRunIds },
                { label: "queuedRuns", value: diagnostics?.admission.queuedRuns },
              ]}
            />
          </div>

          {/* RuntimeHost */}
          <div className="crypt-panel p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-bone uppercase">RuntimeHost</h3>
              <StatusPill
                tone={boolTone(diagnostics?.runtimeHost.initialized)}
                label={diagnostics?.runtimeHost.initialized ? "initialized" : "cold"}
              />
            </div>
            <KeyValueGrid
              rows={[
                { label: "backendKind", value: diagnostics?.runtimeHost.backendKind },
                { label: "stopped / paused", value: diagnostics ? `${diagnostics.runtimeHost.stopped} / ${diagnostics.runtimeHost.paused}` : "-" },
                {
                  label: "gatewayListening",
                  value: diagnostics?.runtimeHost.gatewayServerListening,
                  tone: boolTone(diagnostics?.runtimeHost.gatewayServerListening),
                },
                { label: "gatewayPort", value: diagnostics?.runtimeHost.gatewayPort },
                { label: "supervisorsCount", value: diagnostics?.runtimeHost.supervisorsCount },
                { label: "pendingApprovals", value: diagnostics?.runtimeHost.pendingApprovalsCount },
              ]}
            />
          </div>

          {/* RunOrchestrator */}
          <div className="crypt-panel p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-bone uppercase">RunOrchestrator</h3>
              <StatusPill
                tone={boolTone(diagnostics?.orchestrator.initialized)}
                label={diagnostics?.orchestrator.initialized ? "initialized" : "idle"}
              />
            </div>
            <KeyValueGrid
              rows={[
                { label: "activeRunIds", value: diagnostics?.orchestrator.activeRunIds },
                { label: "queuedRunIds", value: diagnostics?.orchestrator.queuedRunIds },
                { label: "activeHandles", value: diagnostics?.orchestrator.activeHandles },
              ]}
            />
          </div>

          {/* Stores & Recorded Runs */}
          <div className="crypt-panel p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-bone uppercase">Stores &amp; Recorded Runs</h3>
              <StatusPill
                tone="neutral"
                label={diagnostics?.stores.runStore.storageMode ?? "unknown"}
              />
            </div>
            <KeyValueGrid
              rows={[
                {
                  label: "RunStore",
                  value: diagnostics
                    ? `${diagnostics.stores.runStore.storageMode} · total:${diagnostics.stores.runStore.totalRuns} pub:${diagnostics.stores.runStore.publishedRunsCount} live:${diagnostics.stores.runStore.activeLiveRunsCount}`
                    : "-",
                },
                { label: "livingRunsCount", value: diagnostics?.stores.runStore.livingRunsCount },
                { label: "inviteCodesSummary", value: diagnostics?.stores.runStore.inviteCodesSummary },
                {
                  label: "EventStore",
                  value: diagnostics
                    ? `${diagnostics.stores.eventStore.storageMode} · ${diagnostics.stores.eventStore.totalEvents} ev / ${diagnostics.stores.eventStore.distinctRunCount} runs`
                    : "-",
                },
                { label: "recordedOnDisk", value: diagnostics?.stores.recordedRuns.availableOnDisk },
                { label: "seededRunIds", value: diagnostics?.stores.recordedRuns.seededRunIds },
              ]}
            />
          </div>

          {/* Phase 0 Probes & Env Presence */}
          <div className="crypt-panel p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-bone uppercase">Phase 0 Probes &amp; Env</h3>
              <StatusPill
                tone={diagnostics?.probes.devAllowed ? "emerald" : "amber"}
                label={diagnostics?.probes.devAllowed ? "devAllowed" : "gated"}
              />
            </div>
            <KeyValueGrid
              rows={[
                { label: "sourcePresent", value: diagnostics?.probes.sourcePresent },
                { label: "devAllowed", value: diagnostics?.probes.devAllowed, tone: boolTone(diagnostics?.probes.devAllowed) },
                { label: "prodAllowed", value: diagnostics?.probes.prodAllowed, tone: boolTone(diagnostics?.probes.prodAllowed) },
                { label: "settledByFallback", value: diagnostics?.probes.settledByFallback },
                { label: "blocking", value: diagnostics?.probes.blocking },
                ...envEntries.map(([k, v]) => ({
                  label: k,
                  value: v,
                  tone: typeof v === "boolean" ? boolTone(v) : undefined,
                })),
              ]}
            />
          </div>
        </div>

        {/* Toolchains Card */}
        <div className="crypt-panel p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-bone uppercase">
              Toolchain Probes (git, docker, kiroCli, wasmTreeSitter, monacoAssets)
            </h3>
            <span className="text-[11px] text-dust">
              {toolchainEntries.length} reported
            </span>
          </div>
          {toolchainEntries.length === 0 ? (
            <div className="crypt-well p-3 text-xs text-ash">
              No toolchain telemetry returned yet. Click Refresh All to run bounded probes.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
              {toolchainEntries.map(([name, info]) => {
                const obj = info && typeof info === "object" ? (info as Record<string, unknown>) : null;
                const available = obj ? Boolean(obj.available ?? obj.ok ?? obj.present) : Boolean(info);
                const detail = obj
                  ? String(obj.version ?? obj.detail ?? obj.status ?? obj.error ?? (available ? "ready" : "missing"))
                  : String(info);
                return (
                  <div key={name} className="crypt-well p-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-bone">{name}</span>
                      <StatusPill
                        tone={available ? "emerald" : "crimson"}
                        label={available ? "ok" : "missing"}
                      />
                    </div>
                    <div className="text-[10px] text-ash break-words">{detail}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* 2. Real Runs Selector & Run Deep Inspector */}
      <section className="crypt-panel p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div>
            <h2 className="text-xs uppercase tracking-wider text-bone font-semibold">
              2. Real Runs Selector &amp; Deep Parity Inspector
            </h2>
            <p className="text-[11px] text-ash mt-0.5">
              Select a recorded/live run or enter any runId to inspect sequence integrity, reducer parity, artifacts, and live SSE stream.
            </p>
          </div>

          <form onSubmit={handleInspectRunSubmit} className="flex items-center gap-2">
            <input
              type="text"
              data-testid="live-inspector-run-input"
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder="Enter runId..."
              className="crypt-well px-2.5 py-1.5 text-xs text-bone placeholder:text-dust focus:outline-none focus:border-emerald-400/50"
            />
            <button
              type="submit"
              data-testid="live-inspector-run-submit"
              className="crypt-btn-primary px-3 py-1.5 rounded text-xs"
            >
              Inspect Run
            </button>
          </form>
        </div>

        {/* Recent Runs Chips */}
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-dust">
            Recent Runs ({diagnostics?.recentRuns.length ?? 0})
          </div>
          {!diagnostics || diagnostics.recentRuns.length === 0 ? (
            <div className="crypt-well p-3 text-xs text-ash">
              No recent runs recorded in RunStore yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {diagnostics.recentRuns.map((run) => {
                const isSelected = selectedRunId === run.runId;
                return (
                  <button
                    key={run.runId}
                    type="button"
                    data-testid={`live-inspector-run-${run.runId}`}
                    onClick={() => {
                      setSelectedRunId(run.runId);
                      setRunInput(run.runId);
                      setProbeRunId(run.runId);
                    }}
                    className={`text-left p-2.5 rounded border transition-colors cursor-pointer space-y-1 ${
                      isSelected
                        ? "bg-emerald-950/45 border-[var(--necromancy-emerald-border)]"
                        : "crypt-well hover:border-white/25"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-bone truncate">
                        {run.runId}
                      </span>
                      <StatusPill
                        tone={phaseTone(run.phase, run.outcome)}
                        label={run.outcome || run.phase || "unknown"}
                      />
                    </div>
                    <div className="text-[10px] text-ash truncate">
                      {run.repository || "unknown repository"}
                    </div>
                    <div className="flex flex-wrap gap-x-2.5 text-[10px] text-dust">
                      <span>phase:{run.phase ?? "-"}</span>
                      <span>ev:{run.eventCount ?? 0}</span>
                      <span>seq:{run.lastSeq ?? 0}</span>
                      <span>{run.isPublished ? "published" : "unpublished"}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Run Deep Detail */}
        {selectedRunId && (
          <div
            data-testid="live-inspector-run-detail"
            className="pt-3 border-t border-white/10 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-emerald-300">
                  Inspecting: {selectedRunId}
                </span>
                {runLoading && <StatusPill tone="neutral" label="loading" pulse />}
                {runDiag?.phaseParity && (
                  <StatusPill
                    tone={runDiag.phaseParity.parityOk ? "emerald" : "crimson"}
                    label={
                      runDiag.phaseParity.parityOk
                        ? "parity ok"
                        : `parity mismatch (${runDiag.phaseParity.runStorePhase} vs ${runDiag.phaseParity.reducedViewPhase})`
                    }
                  />
                )}
              </div>

              {/* Clickable Stage Routes */}
              <div className="flex flex-wrap items-center gap-2">
                <Link href={routes.pact(selectedRunId)} className="crypt-btn-ghost px-2.5 py-1 rounded text-[11px]">
                  Pact
                </Link>
                <Link href={routes.legion(selectedRunId)} className="crypt-btn-ghost px-2.5 py-1 rounded text-[11px]">
                  Legion
                </Link>
                <Link href={routes.relic(selectedRunId)} className="crypt-btn-ghost px-2.5 py-1 rounded text-[11px]">
                  Reliquary
                </Link>
                <Link href={routes.replay(selectedRunId)} className="crypt-btn-primary px-2.5 py-1 rounded text-[11px]">
                  Replay
                </Link>
              </div>
            </div>

            {runError && (
              <div className="crypt-well p-3 border-l-2 border-l-rose-400 text-xs text-rose-300">
                {runError}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Backend vs Reducer Parity */}
              <SelectedRunStreamParityCard
                key={selectedRunId}
                runId={selectedRunId}
                runDiag={runDiag}
              />

              {/* Sequence Integrity */}
              <div className="crypt-well p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-dust">
                  Sequence Integrity &amp; Counts
                </div>
                <KeyValueGrid
                  rows={[
                    { label: "eventCount", value: runDiag?.sequenceIntegrity?.eventCount },
                    {
                      label: "seqRange",
                      value: runDiag?.sequenceIntegrity
                        ? `${runDiag.sequenceIntegrity.firstSeq ?? "-"}..${runDiag.sequenceIntegrity.lastSeq ?? "-"}`
                        : "-",
                    },
                    {
                      label: "missingSeqGaps",
                      value: runDiag?.sequenceIntegrity?.missingSeqGaps,
                      tone:
                        runDiag?.sequenceIntegrity &&
                        runDiag.sequenceIntegrity.missingSeqGaps.length === 0
                          ? "emerald"
                          : "amber",
                    },
                    { label: "countsByActor", value: runDiag?.countsByActor },
                    { label: "countsByKind", value: runDiag?.countsByKind },
                    { label: "activeHandle", value: runDiag?.activeHandle },
                  ]}
                />
              </div>

              {/* Artifact SHA-256 Status */}
              <div className="crypt-well p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-dust">
                  Artifact SHA-256 Status ({artifacts.length})
                </div>
                {artifacts.length === 0 ? (
                  <div className="text-[11px] text-ash">
                    No artifact entries reported for this run.
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {artifacts.map((art, idx) => {
                      const label = String(art.fileName ?? art.name ?? art.kind ?? `artifact-${idx}`);
                      const sha = typeof art.sha256 === "string" ? art.sha256 : null;
                      const recordedSha =
                        typeof (art.eventRecordedSha256 ?? art.recordedSha256 ?? art.expectedSha256) === "string"
                          ? String(art.eventRecordedSha256 ?? art.recordedSha256 ?? art.expectedSha256)
                          : null;
                      const rawMatches = art.shaMatch ?? art.sha256Match ?? art.matches;
                      const matches = typeof rawMatches === "boolean" ? rawMatches : undefined;
                      const exists =
                        typeof (art.presentOnDisk ?? art.exists) === "boolean"
                          ? Boolean(art.presentOnDisk ?? art.exists)
                          : undefined;
                      const byteSize = typeof (art.byteSize ?? art.size) === "number" ? Number(art.byteSize ?? art.size) : null;
                      return (
                        <div key={`${label}-${idx}`} className="p-2 rounded bg-black/30 border border-white/10 space-y-0.5 text-[10px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-bone truncate">{label}</span>
                            <StatusPill
                              tone={
                                matches !== undefined
                                  ? boolTone(matches)
                                  : exists !== undefined
                                  ? boolTone(exists)
                                  : "neutral"
                              }
                              label={
                                matches !== undefined
                                  ? matches
                                    ? "sha-match"
                                    : "sha-mismatch"
                                  : exists !== undefined
                                  ? exists
                                    ? "present"
                                    : "missing"
                                  : "recorded"
                              }
                            />
                          </div>
                          {byteSize !== null && (
                            <div className="text-dust">bytes: {byteSize}</div>
                          )}
                          {sha && (
                            <div className="text-ash break-all">sha256: {sha}</div>
                          )}
                          {recordedSha && recordedSha !== sha && (
                            <div className="text-amber-300 break-all">event: {recordedSha}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Latest Events */}
            {runDiag?.latestEvents && runDiag.latestEvents.length > 0 && (
              <div className="crypt-well p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-dust">
                  Latest Events ({runDiag.latestEvents.length})
                </div>
                <div className="max-h-52 overflow-y-auto space-y-1 text-[11px]">
                  {runDiag.latestEvents.map((ev, i) => (
                    <div
                      key={`${String(ev.seq ?? i)}-${i}`}
                      className="flex items-start justify-between gap-3 py-1 border-b border-white/[0.05] last:border-b-0"
                    >
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-emerald-300">#{String(ev.seq ?? "?")}</span>
                        <span className="text-bone font-semibold">{String(ev.kind ?? "")}</span>
                        {ev.actor ? <span className="text-dust">[{String(ev.actor)}]</span> : null}
                      </div>
                      <span className="text-ash truncate max-w-xl">
                        {formatCompact(ev.data)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 3. API Endpoint Probe Matrix */}
      <section className="crypt-panel p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div>
            <h2 className="text-xs uppercase tracking-wider text-bone font-semibold">
              3. API Endpoint Probe Matrix
            </h2>
            <p className="text-[11px] text-ash">
              One-click live HTTP probes reporting status code, latency (ms), and raw JSON output.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={probeRunId}
              onChange={(e) => setProbeRunId(e.target.value)}
              placeholder="runId for /api/runs/<id>"
              className="crypt-well px-2.5 py-1 text-xs text-bone placeholder:text-dust focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleProbeAll()}
              className="crypt-btn-primary px-3 py-1 rounded text-xs"
            >
              Probe All
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {probeEndpoints.map((ep) => {
            const rec = probeResults[ep.key];
            const disabled = !ep.url || probingKey === ep.key;
            return (
              <button
                key={ep.key}
                type="button"
                data-testid={`live-probe-btn-${ep.key}`}
                disabled={disabled}
                onClick={() => void handleProbe(ep.key, ep.url)}
                className="crypt-btn-ghost px-3 py-1.5 rounded text-[11px] flex items-center gap-2"
              >
                <span>{ep.label}</span>
                {rec && (
                  <StatusPill
                    tone={rec.ok ? "emerald" : "crimson"}
                    label={`${rec.status ?? "err"} · ${rec.latencyMs}ms`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {activeProbeKey && probeResults[activeProbeKey] && (
          <div className="crypt-well p-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-emerald-300 font-semibold">
                {probeResults[activeProbeKey].url}
              </span>
              <span className="text-ash">
                status: {probeResults[activeProbeKey].status ?? "network-error"} ·{" "}
                {probeResults[activeProbeKey].latencyMs}ms
              </span>
            </div>
            <pre className="text-[11px] text-parchment max-h-60 overflow-auto whitespace-pre-wrap break-words">
              {formatJson(probeResults[activeProbeKey].payload ?? probeResults[activeProbeKey].error)}
            </pre>
          </div>
        )}
      </section>

      {/* 4. Dev Sandbox Driver Panel */}
      {showDevSimPanel && (
        <section
          data-testid="live-inspector-sim-panel"
          className="crypt-panel p-4 space-y-3"
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div>
              <h2 className="text-xs uppercase tracking-wider text-bone font-semibold">
                4. Dev Sandbox Driver Panel (POST /api/debug/sim)
              </h2>
              <p className="text-[11px] text-ash">
                Mint dev invite codes, step simulated runs, or seed recorded runs into the local store.
              </p>
            </div>
            <button
              type="button"
              disabled={simBusy}
              onClick={() => void handleSimRequest({ action: "seed_recorded_runs" })}
              className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            >
              Seed Recorded Runs
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Mint Invite Code */}
            <div className="crypt-well p-3 space-y-2">
              <div className="text-[11px] font-semibold text-parchment">
                Mint Dev Invite Code
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={inviteCodeDraft}
                  onChange={(e) => setInviteCodeDraft(e.target.value)}
                  placeholder="Invite code"
                  className="crypt-well px-2.5 py-1 text-xs text-bone flex-1 min-w-[120px]"
                />
                <input
                  type="number"
                  min={1}
                  value={inviteLimitDraft}
                  onChange={(e) => setInviteLimitDraft(e.target.value)}
                  placeholder="Runs"
                  className="crypt-well px-2.5 py-1 text-xs text-bone w-20"
                />
                <button
                  type="button"
                  disabled={simBusy || !inviteCodeDraft.trim()}
                  onClick={() =>
                    void handleSimRequest({
                      action: "create_invite",
                      code: inviteCodeDraft.trim(),
                      allowedRunCount: Number(inviteLimitDraft) || 5,
                      caps: { maxMinutes: 30, maxParallel: 2, maxToolCalls: 80 },
                    })
                  }
                  className="crypt-btn-primary px-3 py-1 rounded text-xs"
                >
                  Create Invite
                </button>
              </div>
            </div>

            {/* Step Simulated Run */}
            <div className="crypt-well p-3 space-y-2">
              <div className="text-[11px] font-semibold text-parchment">
                Step Simulated Run
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={simRunIdDraft}
                  onChange={(e) => setSimRunIdDraft(e.target.value)}
                  placeholder="runId"
                  className="crypt-well px-2.5 py-1 text-xs text-bone flex-1 min-w-[120px]"
                />
                <select
                  value={simStepDraft}
                  onChange={(e) => setSimStepDraft(e.target.value as SimStep)}
                  className="crypt-well px-2 py-1 text-xs text-bone"
                >
                  {SIM_STEPS.map((step) => (
                    <option key={step} value={step}>
                      {step}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={simBusy || !simRunIdDraft.trim()}
                  onClick={() =>
                    void handleSimRequest(
                      {
                        action: "step_run",
                        runId: simRunIdDraft.trim(),
                        step: simStepDraft,
                      },
                      simRunIdDraft.trim()
                    )
                  }
                  className="crypt-btn-primary px-3 py-1 rounded text-xs"
                >
                  Step Run
                </button>
              </div>
            </div>
          </div>

          {simResult && (
            <div className="crypt-well p-3 space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-emerald-300 font-semibold">
                  Last Sim Result
                </span>
                <StatusPill
                  tone={simResult.ok ? "emerald" : "crimson"}
                  label={`${simResult.status ?? "err"} · ${simResult.latencyMs}ms`}
                />
              </div>
              <pre className="text-[11px] text-parchment max-h-40 overflow-auto whitespace-pre-wrap break-words">
                {formatJson(simResult.payload ?? simResult.error)}
              </pre>
            </div>
          )}
        </section>
      )}

      {/* 5. Live DOM [data-ui-element] Registry Table */}
      <section className="crypt-panel p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
          <div>
            <h2 className="text-xs uppercase tracking-wider text-bone font-semibold">
              5. Live DOM [data-ui-element] Registry &amp; Client State
            </h2>
            <p className="text-[11px] text-ash">
              Route: {clientState.pathname}
              {clientState.search} · Active Streams: {clientState.activeRuns.length} · Theme Tokens: {themeTokenCount}
            </p>
          </div>
          <button
            type="button"
            onClick={scanDomRegistry}
            className="crypt-btn-ghost px-3 py-1 rounded text-xs"
          >
            Scan DOM ({domElements.length})
          </button>
        </div>

        <div className="crypt-well overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="border-b border-white/10 text-dust uppercase text-[10px]">
              <tr>
                <th className="p-2">data-ui-element</th>
                <th className="p-2">state</th>
                <th className="p-2">variant</th>
                <th className="p-2">testId</th>
                <th className="p-2">rect</th>
                <th className="p-2">visible</th>
              </tr>
            </thead>
            <tbody>
              {domElements.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-3 text-ash text-center">
                    Click Scan DOM to inspect mounted [data-ui-element] nodes.
                  </td>
                </tr>
              ) : (
                domElements.map((el, idx) => (
                  <tr
                    key={`${el.element}-${el.testId ?? idx}-${idx}`}
                    className="border-b border-white/[0.05] last:border-b-0"
                  >
                    <td className="p-2 text-emerald-300 font-semibold">{el.element}</td>
                    <td className="p-2 text-parchment">{el.state ?? "-"}</td>
                    <td className="p-2 text-ash">{el.variant ?? "-"}</td>
                    <td className="p-2 text-ash">{el.testId ?? "-"}</td>
                    <td className="p-2 text-dust tabular-nums">
                      {el.rect.width}×{el.rect.height} @ ({el.rect.x},{el.rect.y})
                    </td>
                    <td className="p-2">
                      <StatusPill
                        tone={el.visible ? "emerald" : "neutral"}
                        label={el.visible ? "yes" : "hidden"}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
