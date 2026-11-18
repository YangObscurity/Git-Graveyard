import { engineVersion } from "@/lib/engine/engine-version";
import {
  collectSystemDiagnostics,
  formatHealthBadgeText,
  resolveAdmissionFromGlobals,
  resolveBackendFromGlobals,
  type LiveRunStatus,
} from "@/lib/runtime/diagnostics";
import { getRuntimeHost, type RuntimeHost } from "@/lib/runtime/runtime-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cachedBootedHost: RuntimeHost | null = null;

function resolveHealthRuntime(request?: Request): {
  host: RuntimeHost | null;
} {
  const reqAny = request as unknown as { backend?: unknown } | undefined;
  const g = globalThis as unknown as { __backend?: unknown; backend?: unknown };
  if (reqAny?.backend) {
    return { host: null };
  }
  if (g.__backend || g.backend) {
    if (
      cachedBootedHost &&
      !cachedBootedHost.stopped &&
      g.__backend === cachedBootedHost.backendAdapter
    ) {
      return { host: cachedBootedHost };
    }
    return { host: null };
  }
  try {
    cachedBootedHost = getRuntimeHost();
    return { host: cachedBootedHost };
  } catch {
    return { host: null };
  }
}

export async function GET(request: Request): Promise<Response> {
  // Resolve backend first so RuntimeHost initializes global admission/backend on cold boot.
  const { host } = resolveHealthRuntime(request);
  const backend = resolveBackendFromGlobals(request, host);
  const admission = resolveAdmissionFromGlobals(request);

  let wantDetail = false;
  try {
    const url = new URL(request.url);
    wantDetail = url.searchParams.get("detail") === "1";
  } catch {
    wantDetail = false;
  }

  const withDetail = <T extends Record<string, unknown>>(payload: T): T & {
    diagnostics?: Record<string, unknown>;
  } => {
    if (!wantDetail) {
      return payload;
    }
    const diag = collectSystemDiagnostics({
      request,
      probeToolchains: false,
      runtimeHost: host,
    });
    return {
      ...payload,
      diagnostics: {
        stores: diag.stores,
        runtimeHost: diag.runtimeHost,
        orchestrator: diag.orchestrator,
        probes: diag.probes,
      },
    };
  };

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  };

  if (!admission) {
    const status: LiveRunStatus = "unavailable";
    const reason = "Admission does not exist";
    const queueLength = 0;
    return Response.json(
      withDetail({
        status,
        liveRunStatus: status,
        reason,
        queueLength,
        badgeText: formatHealthBadgeText(status, queueLength),
        ok: false,
        engineVersion,
      }),
      { status: 200, headers }
    );
  }

  // 1. Check if paused by owner
  const isPaused = Boolean(
    (typeof admission.isPaused === "function" && admission.isPaused()) ||
      admission.paused === true ||
      admission.killSwitch === true ||
      admission.state === "paused" ||
      (backend && typeof backend.isPaused === "function" && backend.isPaused())
  );

  if (isPaused) {
    const status: LiveRunStatus = "paused by owner";
    const queueLength =
      typeof admission.getQueueLength === "function"
        ? admission.getQueueLength()
        : typeof admission.queueLength === "number"
        ? admission.queueLength
        : Array.isArray(admission.queue)
        ? admission.queue.length
        : 0;

    return Response.json(
      withDetail({
        status,
        liveRunStatus: status,
        reason: "Paused by owner",
        queueLength,
        badgeText: formatHealthBadgeText(status, queueLength),
        ok: false,
        engineVersion,
      }),
      { status: 200, headers }
    );
  }

  // 2. Check if unavailable
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

    return Response.json(
      withDetail({
        status,
        liveRunStatus: status,
        reason,
        queueLength: 0,
        badgeText: formatHealthBadgeText(status, 0),
        ok: false,
        engineVersion,
      }),
      { status: 200, headers }
    );
  }

  // 3. Check queue length
  const queueLength =
    typeof admission.getQueueLength === "function"
      ? admission.getQueueLength()
      : typeof admission.queueLength === "number"
      ? admission.queueLength
      : Array.isArray(admission.queue)
      ? admission.queue.length
      : 0;

  if (queueLength > 0) {
    const status: LiveRunStatus = "queue length";
    return Response.json(
      withDetail({
        status,
        liveRunStatus: status,
        queueLength,
        badgeText: formatHealthBadgeText(status, queueLength),
        ok: true,
        engineVersion,
      }),
      { status: 200, headers }
    );
  }

  // 4. Open
  const status: LiveRunStatus = "open";
  return Response.json(
    withDetail({
      status,
      liveRunStatus: status,
      queueLength: 0,
      badgeText: formatHealthBadgeText(status, 0),
      ok: true,
      engineVersion,
    }),
    { status: 200, headers }
  );
}
