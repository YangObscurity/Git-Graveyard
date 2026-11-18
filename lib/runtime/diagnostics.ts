import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engineVersion } from "../engine/engine-version";
import type { EventEnvelope } from "../events/event-store";
import { EventTap } from "../events/event-tap";
import { parseRepoInput } from "../grimoire/normalize";
import {
  DEV_REQUIRED_PROBES,
  PROD_REQUIRED_PROBES,
  devLiveRunsAllowed,
  prodLiveRunsAllowed,
} from "../probes/gate";
import { parseRunsContent } from "../probes/runs-parser";
import {
  getSeededRecordedRunIds,
  listRecordedRunsOnDisk,
  type RecordedRunBundleSummary,
} from "../runs/recorded-runs-loader";
import type { RunRecord } from "../runs/run-store";
import { redactEvent, redactText, redactValue } from "../security/redactor";
import { applyRunEvents, createRunView, type RunView } from "../ui/run-model";
import type { RuntimeHost } from "./runtime-host";
import {
  findRunArtifactOnDisk,
  isSafeRunId,
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
} from "./store-context";

export type LiveRunStatus =
  | "open"
  | "queue length"
  | "paused by owner"
  | "unavailable";

export interface AdmissionLike {
  isPaused?: () => boolean;
  paused?: boolean;
  killSwitch?: boolean;
  state?: string;
  isUnavailable?: () => boolean;
  unavailable?: boolean;
  isStopped?: () => boolean;
  isHealthy?: () => boolean;
  getReason?: () => string;
  reason?: string;
  getQueueLength?: () => number;
  queueLength?: number;
  queue?: unknown[];
  queueDepthCap?: number;
}

export interface BackendLike {
  isAvailable?: () => boolean;
  isHealthy?: () => boolean;
  isPaused?: () => boolean;
  getReason?: () => string;
  reason?: string;
  backend?: { kind?: string };
}

export interface HealthSnapshot {
  status: LiveRunStatus;
  liveRunStatus: LiveRunStatus;
  reason: string;
  queueLength: number;
  badgeText: string;
  ok: boolean;
}

export interface ToolchainEntry {
  available: boolean;
  version?: string | null;
  source?: "PATH" | "local-bin" | "missing" | "module" | "public";
  present?: boolean;
  error?: string;
}

export interface ToolchainsReport {
  git: ToolchainEntry;
  docker: ToolchainEntry;
  kiroCli: ToolchainEntry;
  wasmTreeSitter: ToolchainEntry;
  monacoAssets: ToolchainEntry;
}

export interface ProbeGateReport {
  sourcePresent: boolean;
  devAllowed: boolean;
  prodAllowed: boolean;
  settledByFallback: string[];
  blocking: string[];
  devMissing: string[];
  prodMissing: string[];
}

export interface SystemDiagnostics {
  timestamp: string;
  engineVersion: string;
  nodeVersion: string;
  platform: string;
  nodeEnv: string;
  health: HealthSnapshot;
  stores: {
    runStore: {
      storageMode: "memory" | "file" | "unknown";
      totalRuns: number;
      livingRunsCount: number;
      publishedRunsCount: number;
      activeLiveRunsCount: number;
      inviteCodesSummary: {
        total: number;
        active: number;
        revoked: number;
        expired: number;
        usedUp: number;
        totalRemainingRuns: number;
      };
    };
    eventStore: {
      storageMode: "memory" | "file" | "unknown";
      totalEvents: number;
      distinctRunCount: number;
    };
    recordedRuns: {
      availableOnDisk: RecordedRunBundleSummary[];
      seededRunIds: string[];
    };
  };
  admission: {
    paused: boolean;
    unavailable: boolean;
    healthy: boolean;
    reason: string;
    queueLength: number;
    queueDepthCap: number;
    liveCapacity: number;
    activeLiveRunIds: string[];
    queuedRuns: Array<{
      runId: string;
      url: string;
      repository: string;
      sha: string;
      queuePosition: number | null;
      queuedAt: number | null;
      pushFlag: boolean;
    }>;
  };
  runtimeHost: {
    initialized: boolean;
    stopped: boolean;
    paused: boolean;
    gatewayServerListening: boolean;
    gatewayPort: number | null;
    backendKind: string;
    supervisorsCount: number;
    pendingApprovalsCount: number;
  };
  orchestrator: {
    initialized: boolean;
    activeRunIds: string[];
    queuedRunIds: string[];
    activeHandles: Array<{
      runId: string;
      phase: string | null;
      hasScheduler: boolean;
      hasDispatcher: boolean;
      hasDeathCertificate: boolean;
      hasPactDraft: boolean;
    }>;
  };
  probes: ProbeGateReport;
  toolchains?: ToolchainsReport;
  envPresence: {
    hasGithubToken: boolean;
    hasGithubWriteToken: boolean;
    hasAdminToken: boolean;
    executionBackend: string;
  };
  recentRuns: Array<{
    runId: string;
    repository: string;
    phase: string;
    outcome: string | null;
    isPublished: boolean;
    isRemoved: boolean;
    eventCount: number;
    lastSeq: number;
    lastEventKind: string | null;
    updatedAt: number;
  }>;
}

export interface RunArtifactDiagnostic {
  id: string;
  name: string;
  fileName: string;
  kind: string;
  presentOnDisk: boolean;
  size: number | null;
  sha256: string | null;
  eventRecordedSha256: string | null;
  eventRecordedSize: number | null;
  shaMatch: boolean | null;
  downloadUrl: string;
}

export interface RunDiagnostics {
  runId: string;
  run: Record<string, unknown> | null;
  sequenceIntegrity: {
    eventCount: number;
    firstSeq: number | null;
    lastSeq: number | null;
    missingSeqGaps: Array<{ fromSeq: number; toSeq: number }>;
  };
  countsByKind: Record<string, number>;
  countsByActor: Record<string, number>;
  phaseParity: {
    runStorePhase: string | null;
    reducedViewPhase: string;
    parityOk: boolean;
  };
  reducedView: Omit<RunView, "seen"> & { seenCount: number };
  activeHandle: {
    active: boolean;
    phase: string | null;
    hasScheduler: boolean;
    hasDispatcher: boolean;
    hasDeathCertificate: boolean;
    hasPactDraft: boolean;
    hasFinalCheckResult: boolean;
  } | null;
  artifacts: RunArtifactDiagnostic[];
  latestEvents: EventEnvelope[];
}

const ARTIFACT_DEFINITIONS = [
  { id: "patch", name: "all.patch", fileName: "all.patch", kind: "patch" },
  { id: "spec", name: "spec bundle", fileName: "spec.json", kind: "spec" },
  { id: "report", name: "report", fileName: "report.md", kind: "report" },
  { id: "events", name: "events.ndjson", fileName: "events.ndjson", kind: "events" },
  {
    id: "certificate",
    name: "Death_Certificate",
    fileName: "death-certificate.json",
    kind: "certificate",
  },
] as const;

export function formatRepositoryLabel(url: string): string {
  try {
    const parsed = parseRepoInput(url);
    if (parsed.ok) {
      return `${parsed.owner}/${parsed.repo}`;
    }
  } catch {
    // fallback
  }
  return redactText(url);
}

export function formatHealthBadgeText(
  status: LiveRunStatus,
  queueLength: number
): string {
  switch (status) {
    case "open":
      return "Live runs: open";
    case "queue length":
      return `Live runs: queue is ${queueLength} long`;
    case "paused by owner":
      return "Live runs: paused by the owner";
    case "unavailable":
    default:
      return "Live runs: unavailable";
  }
}

export function resolveAdmissionFromGlobals(request?: Request): AdmissionLike | null {
  const reqAny = request as unknown as { admission?: AdmissionLike } | undefined;
  if (reqAny?.admission) {
    return reqAny.admission;
  }
  const g = globalThis as unknown as {
    __admission?: AdmissionLike;
    admission?: AdmissionLike;
  };
  return g.__admission ?? g.admission ?? null;
}

export function resolveBackendFromGlobals(
  request?: Request,
  runtimeHost?: RuntimeHost | null
): BackendLike | null {
  const reqAny = request as unknown as { backend?: BackendLike } | undefined;
  if (reqAny?.backend) {
    return reqAny.backend;
  }
  const g = globalThis as unknown as {
    __backend?: BackendLike;
    backend?: BackendLike;
  };
  if (g.__backend) {
    return g.__backend;
  }
  if (g.backend) {
    return g.backend;
  }
  if (runtimeHost?.backendAdapter) {
    return runtimeHost.backendAdapter;
  }
  return null;
}

export function computeHealthFromGlobals(
  request?: Request,
  runtimeHost?: RuntimeHost | null
): HealthSnapshot {
  const backend = resolveBackendFromGlobals(request, runtimeHost);
  const admission = resolveAdmissionFromGlobals(request);

  if (!admission) {
    const status: LiveRunStatus = "unavailable";
    return {
      status,
      liveRunStatus: status,
      reason: "Admission does not exist",
      queueLength: 0,
      badgeText: formatHealthBadgeText(status, 0),
      ok: false,
    };
  }

  const queueLength =
    typeof admission.getQueueLength === "function"
      ? admission.getQueueLength()
      : typeof admission.queueLength === "number"
      ? admission.queueLength
      : Array.isArray(admission.queue)
      ? admission.queue.length
      : 0;

  const isPaused = Boolean(
    (typeof admission.isPaused === "function" && admission.isPaused()) ||
      admission.paused === true ||
      admission.killSwitch === true ||
      admission.state === "paused" ||
      (backend && typeof backend.isPaused === "function" && backend.isPaused())
  );

  if (isPaused) {
    const status: LiveRunStatus = "paused by owner";
    return {
      status,
      liveRunStatus: status,
      reason: "Paused by owner",
      queueLength,
      badgeText: formatHealthBadgeText(status, queueLength),
      ok: false,
    };
  }

  const isAdmissionUnavailable = Boolean(
    (typeof admission.isUnavailable === "function" && admission.isUnavailable()) ||
      admission.unavailable === true ||
      admission.state === "unavailable" ||
      (typeof admission.isStopped === "function" && admission.isStopped()) ||
      (typeof admission.isHealthy === "function" && !admission.isHealthy())
  );

  const isBackendUnavailable = Boolean(
    backend &&
      ((typeof backend.isAvailable === "function" && !backend.isAvailable()) ||
        (typeof backend.isHealthy === "function" && !backend.isHealthy()))
  );

  if (isAdmissionUnavailable || isBackendUnavailable) {
    const status: LiveRunStatus = "unavailable";
    const reason =
      (typeof admission.getReason === "function" && admission.getReason()) ||
      admission.reason ||
      (backend && typeof backend.getReason === "function" && backend.getReason()) ||
      backend?.reason ||
      "Admission or backend unavailable";
    return {
      status,
      liveRunStatus: status,
      reason: redactText(String(reason)),
      queueLength: 0,
      badgeText: formatHealthBadgeText(status, 0),
      ok: false,
    };
  }

  if (queueLength > 0) {
    const status: LiveRunStatus = "queue length";
    return {
      status,
      liveRunStatus: status,
      reason: "OK",
      queueLength,
      badgeText: formatHealthBadgeText(status, queueLength),
      ok: true,
    };
  }

  const status: LiveRunStatus = "open";
  return {
    status,
    liveRunStatus: status,
    reason: "OK",
    queueLength: 0,
    badgeText: formatHealthBadgeText(status, 0),
    ok: true,
  };
}

export function evaluateProbeGateFromFile(runsMdPath?: string): ProbeGateReport {
  const targetPath = path.resolve(
    runsMdPath ?? path.join(process.cwd(), "memory", "RUNS.md")
  );
  if (!fs.existsSync(targetPath)) {
    return {
      sourcePresent: false,
      devAllowed: false,
      prodAllowed: false,
      settledByFallback: [],
      blocking: Array.from(DEV_REQUIRED_PROBES),
      devMissing: Array.from(DEV_REQUIRED_PROBES),
      prodMissing: Array.from(PROD_REQUIRED_PROBES),
    };
  }

  try {
    const content = fs.readFileSync(targetPath, "utf8");
    const parsed = parseRunsContent(content);
    const dev = devLiveRunsAllowed(parsed);
    const prod = prodLiveRunsAllowed(parsed);
    const settled = Array.from(
      new Set([...dev.settledByFallback, ...prod.settledByFallback])
    );
    const blocking = [...dev.missing];
    for (const id of prod.missing) {
      if (!blocking.includes(id)) {
        blocking.push(id);
      }
    }

    return {
      sourcePresent: true,
      devAllowed: dev.allowed,
      prodAllowed: prod.allowed,
      settledByFallback: settled,
      blocking,
      devMissing: dev.missing,
      prodMissing: prod.missing,
    };
  } catch {
    return {
      sourcePresent: false,
      devAllowed: false,
      prodAllowed: false,
      settledByFallback: [],
      blocking: Array.from(DEV_REQUIRED_PROBES),
      devMissing: Array.from(DEV_REQUIRED_PROBES),
      prodMissing: Array.from(PROD_REQUIRED_PROBES),
    };
  }
}

function runCommandVersionCheck(
  command: string,
  args: string[]
): { ok: boolean; version: string | null; error?: string; notFound?: boolean } {
  try {
    const res = spawnSync(command, args, {
      shell: false,
      timeout: 2000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.error) {
      const errCode = (res.error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        version: null,
        notFound: errCode === "ENOENT",
        error: redactText(res.error.message),
      };
    }
    const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    const firstLine = output.split(/\r?\n/)[0]?.trim() ?? "";
    if (res.status === 0) {
      return {
        ok: true,
        version: firstLine ? redactText(firstLine) : "available",
      };
    }
    return {
      ok: false,
      version: firstLine ? redactText(firstLine) : null,
      error: `exit code ${res.status ?? "unknown"}`,
    };
  } catch (err) {
    return {
      ok: false,
      version: null,
      error: redactText(err instanceof Error ? err.message : String(err)),
    };
  }
}

export function probeToolchains(): ToolchainsReport {
  const gitRes = runCommandVersionCheck("git", ["--version"]);
  const dockerRes = runCommandVersionCheck("docker", ["--version"]);

  let kiroEntry: ToolchainEntry;
  const kiroPathRes = runCommandVersionCheck("kiro-cli", ["--version"]);
  if (kiroPathRes.ok) {
    kiroEntry = {
      available: true,
      version: kiroPathRes.version,
      source: "PATH",
    };
  } else {
    const candidates = [
      path.join(os.homedir(), ".local", "bin", "kiro-cli"),
      ...(process.platform === "win32"
        ? [path.join(os.homedir(), ".local", "bin", "kiro-cli.exe")]
        : []),
    ];
    let localRes: ReturnType<typeof runCommandVersionCheck> | null = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        localRes = runCommandVersionCheck(candidate, ["--version"]);
        if (localRes.ok) {
          break;
        }
      }
    }
    if (localRes?.ok) {
      kiroEntry = {
        available: true,
        version: localRes.version,
        source: "local-bin",
      };
    } else {
      kiroEntry = {
        available: false,
        version: localRes?.version ?? kiroPathRes.version ?? null,
        source: localRes ? "local-bin" : "missing",
        error: localRes?.error ?? kiroPathRes.error ?? "not found",
      };
    }
  }

  let wasmPresent = false;
  let searchDir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const candidateWasm = path.join(
      searchDir,
      "node_modules",
      "tree-sitter-python",
      "tree-sitter-python.wasm"
    );
    if (fs.existsSync(candidateWasm)) {
      wasmPresent = true;
      break;
    }
    const parentDir = path.dirname(searchDir);
    if (parentDir === searchDir) {
      break;
    }
    searchDir = parentDir;
  }

  const monacoVsDir = path.resolve(process.cwd(), "public", "monaco", "vs");
  const monacoPresent =
    fs.existsSync(monacoVsDir) &&
    (fs.existsSync(path.join(monacoVsDir, "loader.js")) ||
      fs.existsSync(path.join(monacoVsDir, "editor", "editor.main.js")));

  return {
    git: {
      available: gitRes.ok,
      version: gitRes.version,
      source: gitRes.ok ? "PATH" : "missing",
      ...(gitRes.error ? { error: gitRes.error } : {}),
    },
    docker: {
      available: dockerRes.ok,
      version: dockerRes.version,
      source: dockerRes.ok ? "PATH" : "missing",
      ...(dockerRes.error ? { error: dockerRes.error } : {}),
    },
    kiroCli: kiroEntry,
    wasmTreeSitter: {
      available: wasmPresent,
      present: wasmPresent,
      source: "module",
    },
    monacoAssets: {
      available: monacoPresent,
      present: monacoPresent,
      source: "public",
    },
  };
}

export function collectSystemDiagnostics(options?: {
  request?: Request;
  probeToolchains?: boolean;
  runtimeHost?: RuntimeHost | null;
  runsMdPath?: string;
}): SystemDiagnostics {
  const runStore = resolveRunStore(options?.request);
  const eventStore = resolveEventStore(options?.request, undefined, runStore);

  const g = globalThis as unknown as {
    __backend?: BackendLike;
    __admission?: AdmissionLike;
    __admissionQueue?: Array<Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __runOrchestrator?: any;
  };

  const orchestratorObj = g.__runOrchestrator ?? null;
  const hostObj =
    options?.runtimeHost ??
    ((orchestratorObj?.host as RuntimeHost | undefined) ?? null);

  const health = computeHealthFromGlobals(options?.request, hostObj);
  const admission = resolveAdmissionFromGlobals(options?.request);
  const backend = resolveBackendFromGlobals(options?.request, hostObj);

  const allRuns = runStore.listRuns();
  const livingRuns = runStore.getLivingRuns();
  const activeLiveRuns = livingRuns.filter(
    (r) => r.phase !== "queued" && r.phase !== "done" && !r.outcome
  );

  // Invite codes summary (counts only, never expose hashes/salts/codes)
  const now = Date.now();
  const inviteCodes = runStore.listInviteCodes();
  let activeInvites = 0;
  let revokedInvites = 0;
  let expiredInvites = 0;
  let usedUpInvites = 0;
  let totalRemainingRuns = 0;
  for (const inv of inviteCodes) {
    const isExpired = inv.expiresAt !== null && now > inv.expiresAt;
    if (inv.revoked) {
      revokedInvites += 1;
    } else if (isExpired) {
      expiredInvites += 1;
    } else if (inv.remainingRunCount <= 0) {
      usedUpInvites += 1;
    } else {
      activeInvites += 1;
      totalRemainingRuns += inv.remainingRunCount;
    }
  }

  // Published count & recentRuns
  let publishedRunsCount = 0;
  const runSummaries = allRuns.map((run) => {
    const events = eventStore.getEvents(run.runId);
    const hasPublishEvent =
      run.isPublished || events.some((ev) => ev.kind === "admin.publish");
    const hasHideEvent =
      run.isRemoved || events.some((ev) => ev.kind === "admin.hide");
    if (hasPublishEvent) {
      publishedRunsCount += 1;
    }
    const lastEv = events.length > 0 ? events[events.length - 1] : null;
    return {
      runId: run.runId,
      repository: formatRepositoryLabel(run.url),
      phase: run.phase,
      outcome: run.outcome,
      isPublished: hasPublishEvent,
      isRemoved: hasHideEvent,
      eventCount: events.length,
      lastSeq: lastEv ? lastEv.seq : 0,
      lastEventKind: lastEv ? lastEv.kind : null,
      updatedAt: run.updatedAt,
    };
  });

  runSummaries.sort((a, b) => b.updatedAt - a.updatedAt);
  const recentRuns = runSummaries.slice(0, 20);

  // Recorded runs on disk & seeded IDs
  const availableOnDisk = listRecordedRunsOnDisk();
  const seededSet = new Set<string>(getSeededRecordedRunIds(runStore));
  const runIdSet = new Set(allRuns.map((r) => r.runId));
  for (const bundle of availableOnDisk) {
    if (runIdSet.has(bundle.runId)) {
      seededSet.add(bundle.runId);
    }
  }

  // Admission state
  const backendKind = String(
    backend?.backend?.kind ??
      hostObj?.backend?.kind ??
      process.env.EXECUTION_BACKEND ??
      "instabox-docker"
  );
  const liveCapacity = backendKind === "instabox-docker" ? 1 : 5;
  const queueDepthCap = Number(
    process.env.QUEUE_DEPTH_CAP || admission?.queueDepthCap || 5
  );
  const rawQueue = Array.isArray(g.__admissionQueue)
    ? g.__admissionQueue
    : Array.isArray(admission?.queue)
    ? (admission.queue as Array<Record<string, unknown>>)
    : [];

  const queuedRuns = rawQueue.map((item, idx) => {
    const urlStr = typeof item.url === "string" ? item.url : "";
    return {
      runId: typeof item.runId === "string" ? item.runId : `queued-${idx + 1}`,
      url: redactText(urlStr),
      repository: urlStr ? formatRepositoryLabel(urlStr) : "unknown",
      sha: typeof item.sha === "string" ? redactText(item.sha) : "",
      queuePosition:
        typeof item.queuePosition === "number" ? item.queuePosition : idx + 1,
      queuedAt: typeof item.queuedAt === "number" ? item.queuedAt : null,
      pushFlag: Boolean(item.pushFlag),
    };
  });

  // RuntimeHost state
  const hostInitialized = Boolean(hostObj || g.__backend);
  const hostStopped = hostObj
    ? Boolean(hostObj.stopped)
    : Boolean(backend && typeof backend.isHealthy === "function" && !backend.isHealthy());
  const hostPaused = hostObj
    ? Boolean(hostObj.isPaused())
    : Boolean(backend && typeof backend.isPaused === "function" && backend.isPaused());
  const gatewayPort =
    hostObj && typeof hostObj.port === "number" ? hostObj.port : null;
  const gatewayServerListening = Boolean(
    hostObj?.server?.listening || gatewayPort !== null
  );
  const supervisorsObj = (hostObj as unknown as { supervisors?: Set<unknown> } | null)
    ?.supervisors;
  const supervisorsCount = supervisorsObj instanceof Set ? supervisorsObj.size : 0;
  const pendingApprovalsCount =
    hostObj?.gateway?.approvalManager?.getPendingRequests?.().length ?? 0;

  // Orchestrator state
  let activeRunIds: string[] = [];
  let queuedRunIds: string[] = [];
  const activeHandles: SystemDiagnostics["orchestrator"]["activeHandles"] = [];
  if (orchestratorObj) {
    try {
      if (typeof orchestratorObj.getQueueSnapshot === "function") {
        const snap = orchestratorObj.getQueueSnapshot();
        activeRunIds = Array.isArray(snap?.active) ? [...snap.active] : [];
        queuedRunIds = Array.isArray(snap?.queued) ? [...snap.queued] : [];
      }
    } catch {
      // ignore snapshot error
    }
    if (typeof orchestratorObj.getActiveRun === "function") {
      for (const id of activeRunIds) {
        try {
          const handle = orchestratorObj.getActiveRun(id);
          if (handle) {
            activeHandles.push({
              runId: id,
              phase:
                typeof handle.getPhase === "function" ? handle.getPhase() : null,
              hasScheduler: Boolean(handle.scheduler),
              hasDispatcher: Boolean(handle.dispatcher),
              hasDeathCertificate: Boolean(handle.deathCertificate),
              hasPactDraft: Boolean(handle.pactDraft),
            });
          }
        } catch {
          // ignore handle read errors
        }
      }
    }
  }

  const runStorageMode =
    typeof (runStore as unknown as { getStorageMode?: () => "memory" | "file" })
      .getStorageMode === "function"
      ? (runStore as unknown as { getStorageMode: () => "memory" | "file" }).getStorageMode()
      : "unknown";
  const eventStorageMode =
    typeof (eventStore as unknown as { getStorageMode?: () => "memory" | "file" })
      .getStorageMode === "function"
      ? (eventStore as unknown as { getStorageMode: () => "memory" | "file" }).getStorageMode()
      : "unknown";

  const diagnostics: SystemDiagnostics = {
    timestamp: new Date().toISOString(),
    engineVersion,
    nodeVersion: process.version,
    platform: process.platform,
    nodeEnv: process.env.NODE_ENV ?? "development",
    health,
    stores: {
      runStore: {
        storageMode: runStorageMode,
        totalRuns: allRuns.length,
        livingRunsCount: livingRuns.length,
        publishedRunsCount,
        activeLiveRunsCount: activeLiveRuns.length,
        inviteCodesSummary: {
          total: inviteCodes.length,
          active: activeInvites,
          revoked: revokedInvites,
          expired: expiredInvites,
          usedUp: usedUpInvites,
          totalRemainingRuns,
        },
      },
      eventStore: {
        storageMode: eventStorageMode,
        totalEvents: eventStore.countEvents(),
        distinctRunCount: eventStore.getRunIds().length,
      },
      recordedRuns: {
        availableOnDisk,
        seededRunIds: Array.from(seededSet).sort(),
      },
    },
    admission: {
      paused: health.status === "paused by owner",
      unavailable: health.status === "unavailable",
      healthy: health.ok,
      reason: health.reason,
      queueLength: health.queueLength,
      queueDepthCap,
      liveCapacity,
      activeLiveRunIds: activeLiveRuns.map((r) => r.runId),
      queuedRuns,
    },
    runtimeHost: {
      initialized: hostInitialized,
      stopped: hostStopped,
      paused: hostPaused,
      gatewayServerListening,
      gatewayPort,
      backendKind,
      supervisorsCount,
      pendingApprovalsCount,
    },
    orchestrator: {
      initialized: Boolean(orchestratorObj),
      activeRunIds,
      queuedRunIds,
      activeHandles,
    },
    probes: evaluateProbeGateFromFile(options?.runsMdPath),
    ...(options?.probeToolchains ? { toolchains: probeToolchains() } : {}),
    envPresence: {
      hasGithubToken: Boolean(
        process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim().length > 0
      ),
      hasGithubWriteToken: Boolean(
        process.env.GITHUB_WRITE_TOKEN &&
          process.env.GITHUB_WRITE_TOKEN.trim().length > 0
      ),
      hasAdminToken: Boolean(
        (process.env.ADMIN_TOKEN ?? process.env.ADMIN_KEY)?.trim().length
      ),
      executionBackend: process.env.EXECUTION_BACKEND ?? "instabox-docker",
    },
    recentRuns,
  };

  return diagnostics;
}

function sanitizeRunForDiagnostics(run: RunRecord | null): Record<string, unknown> | null {
  if (!run) {
    return null;
  }
  const sanitizedMeta = run.metadata ? redactValue(run.metadata) : null;
  if (sanitizedMeta && typeof sanitizedMeta === "object") {
    delete (sanitizedMeta as Record<string, unknown>).artifactsDir;
    delete (sanitizedMeta as Record<string, unknown>).runDir;
  }
  return {
    runId: run.runId,
    url: redactText(run.url),
    repository: formatRepositoryLabel(run.url),
    sha: redactText(run.sha),
    phase: run.phase,
    outcome: run.outcome,
    sandboxId: run.sandboxId,
    hasInviteCodeHash: Boolean(run.inviteCodeHash),
    queuePosition: run.queuePosition,
    caps: run.caps ? redactValue(run.caps) : null,
    pushTargetFork: run.pushTargetFork ? redactText(run.pushTargetFork) : null,
    pushBranch: run.pushBranch ? redactText(run.pushBranch) : null,
    pushFlag: run.pushFlag,
    isPublished: run.isPublished,
    isRemoved: run.isRemoved,
    metadata: sanitizedMeta,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

export function inspectRunDiagnostics(
  runId: string,
  options?: { request?: Request }
): RunDiagnostics | null {
  if (!isSafeRunId(runId)) {
    return null;
  }

  const runStore = resolveRunStore(options?.request);
  const eventStore = resolveEventStore(options?.request, undefined, runStore);

  const run = runStore.getRun(runId);
  const tap = new EventTap(eventStore);
  const events = tap
    .getEvents(runId)
    .map((ev) => redactEvent(ev as unknown as Record<string, unknown>) as unknown as EventEnvelope);

  if (!run && events.length === 0) {
    return null;
  }

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const missingSeqGaps: Array<{ fromSeq: number; toSeq: number }> = [];
  if (sorted.length > 0) {
    let expected = 1;
    for (const ev of sorted) {
      if (ev.seq > expected) {
        missingSeqGaps.push({ fromSeq: expected, toSeq: ev.seq - 1 });
      }
      expected = Math.max(expected, ev.seq + 1);
    }
  }

  const countsByKind: Record<string, number> = {};
  const countsByActor: Record<string, number> = {};
  for (const ev of sorted) {
    countsByKind[ev.kind] = (countsByKind[ev.kind] ?? 0) + 1;
    countsByActor[ev.actor] = (countsByActor[ev.actor] ?? 0) + 1;
  }

  const rawView = applyRunEvents(createRunView(), sorted);
  const { seen, ...serializableView } = rawView;
  const reducedView = redactValue({
    ...serializableView,
    seenCount: seen.size,
  });

  const runStorePhase = run?.phase ?? null;
  const reducedViewPhase = rawView.phase;
  const parityOk = run ? run.phase === reducedViewPhase : true;

  const orch = resolveActiveOrchestrator(options?.request);
  const handle = orch?.getActiveRun?.(runId) ?? null;
  const activeHandle = handle
    ? {
        active: true,
        phase: typeof handle.getPhase === "function" ? handle.getPhase() : null,
        hasScheduler: Boolean(handle.scheduler),
        hasDispatcher: Boolean(handle.dispatcher),
        hasDeathCertificate: Boolean(handle.deathCertificate),
        hasPactDraft: Boolean(handle.pactDraft),
        hasFinalCheckResult: Boolean(handle.finalCheckResult),
      }
    : null;

  const artifactReadyEvents = sorted.filter((ev) => ev.kind === "artifact.ready");
  const artifacts: RunArtifactDiagnostic[] = ARTIFACT_DEFINITIONS.map((def) => {
    const found = findRunArtifactOnDisk(runId, def.fileName, run);
    let readyEvent: EventEnvelope | undefined;
    for (let i = artifactReadyEvents.length - 1; i >= 0; i--) {
      const ev = artifactReadyEvents[i];
      const d = (ev.data ?? {}) as Record<string, unknown>;
      const evKind = typeof d.kind === "string" ? d.kind : "";
      const evPath = typeof d.path === "string" ? d.path : "";
      if (evKind === def.kind || evPath.endsWith(def.fileName)) {
        readyEvent = ev;
        break;
      }
    }
    const readyData = (readyEvent?.data ?? {}) as Record<string, unknown>;
    const eventRecordedSha256 =
      typeof readyData.sha256 === "string" ? readyData.sha256 : null;
    const eventRecordedSize =
      typeof readyData.byteSize === "number" ? readyData.byteSize : null;
    const shaMatch =
      found && eventRecordedSha256
        ? found.sha256.toLowerCase() === eventRecordedSha256.toLowerCase()
        : null;

    return {
      id: def.id,
      name: def.name,
      fileName: def.fileName,
      kind: def.kind,
      presentOnDisk: Boolean(found),
      size: found ? found.size : null,
      sha256: found ? found.sha256 : null,
      eventRecordedSha256,
      eventRecordedSize,
      shaMatch,
      downloadUrl: `/runs/${encodeURIComponent(runId)}/relic/download?artifact=${def.id}`,
    };
  });

  return {
    runId,
    run: sanitizeRunForDiagnostics(run),
    sequenceIntegrity: {
      eventCount: sorted.length,
      firstSeq: sorted.length > 0 ? sorted[0].seq : null,
      lastSeq: sorted.length > 0 ? sorted[sorted.length - 1].seq : null,
      missingSeqGaps,
    },
    countsByKind,
    countsByActor,
    phaseParity: {
      runStorePhase,
      reducedViewPhase,
      parityOk,
    },
    reducedView,
    activeHandle,
    artifacts,
    latestEvents: sorted.slice(-50),
  };
}

function timingSafeMatchString(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, "utf8");
  const bufB = Buffer.from(expected, "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isVerifiedAdminToken(
  request: Request,
  body?: Record<string, unknown>
): boolean {
  const expected = (process.env.ADMIN_TOKEN ?? process.env.ADMIN_KEY)?.trim();
  if (!expected) {
    return false;
  }

  const headers = request.headers;
  const candidates: string[] = [];

  for (const name of ["x-admin-token", "x-admin-key", "admin-session", "x-admin-session"]) {
    const v = headers.get(name);
    if (v && v.trim()) {
      candidates.push(v.trim());
    }
  }

  const auth = headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const bearer = auth.slice(7).trim();
    if (bearer) {
      candidates.push(bearer);
    }
  }

  const cookie = headers.get("cookie");
  if (cookie) {
    const sessionPart = cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("admin_session="));
    if (sessionPart) {
      const val = sessionPart.slice("admin_session=".length).trim();
      if (val) {
        candidates.push(val);
      }
    }
  }

  if (body) {
    for (const key of ["adminToken", "adminKey", "adminSession"]) {
      const v = body[key];
      if (typeof v === "string" && v.trim()) {
        candidates.push(v.trim());
      }
    }
  }

  return candidates.some((candidate) => timingSafeMatchString(candidate, expected));
}

export function authorizeDebugRequest(
  request: Request
): { allowed: true } | { allowed: false; response: Response } {
  if (process.env.NODE_ENV !== "production") {
    return { allowed: true };
  }
  let uiDebugQuery = false;
  try {
    const url = new URL(request.url);
    uiDebugQuery = url.searchParams.get("uiDebug") === "1";
  } catch {
    // ignore malformed URL
  }
  const uiDebugHeader = request.headers.get("x-ui-debug") === "1";

  if (uiDebugQuery || uiDebugHeader || isVerifiedAdminToken(request)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    response: Response.json(
      {
        ok: false,
        code: "DEBUG_LOCKED",
        error: "Debug status endpoint is locked",
      },
      { status: 403 }
    ),
  };
}

export function authorizeSimRequest(
  request: Request,
  body?: Record<string, unknown>
): { allowed: true } | { allowed: false; response: Response } {
  if (process.env.NODE_ENV !== "production") {
    return { allowed: true };
  }

  const allowSim = process.env.ALLOW_DEBUG_SIM === "1";
  if (allowSim && isVerifiedAdminToken(request, body)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    response: Response.json(
      {
        ok: false,
        code: "SIM_DISABLED_IN_PRODUCTION",
        error: "Debug simulation endpoint is disabled in production",
      },
      { status: 403 }
    ),
  };
}

