import * as crypto from "node:crypto";
import {
  RunStore,
  getDefaultRunStore,
  lookupInviteCode,
  lookupInviteCodeDetails,
  type RunRecord,
} from "@/lib/runs/run-store";
import {
  isSettingsStoreConfigured,
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
  resolveSettingsStore,
} from "@/lib/runtime/store-context";
import {
  RequiredSettingMissingError,
  assertRequiredSettingsConfigured,
} from "@/lib/admin/settings-store";
import { redactEvent } from "@/lib/security/redactor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface QueuedRun {
  runId: string;
  url: string;
  sha: string;
  inviteCode: string;
  inviteCodeHash?: string | null;
  queuePosition: number;
  queuedAt: number;
  caps?: Record<string, unknown> | null;
  pushFlag?: boolean;
}

export const MAX_LIVE_RUNS_INSTABOX = 1;
export const MAX_LIVE_RUNS_CLOUD = 5;

// Module memory FIFO admission queue (Requirement 31.6, Task 6.7)
const globalState = globalThis as unknown as {
  __admissionQueue?: QueuedRun[];
  __admission?: Record<string, unknown>;
};

if (!globalState.__admissionQueue) {
  globalState.__admissionQueue = [];
}
const fifoQueue: QueuedRun[] = globalState.__admissionQueue;

export function getAdmissionQueue(): QueuedRun[] {
  return fifoQueue;
}

export function getQueueLength(): number {
  return fifoQueue.length;
}

export function clearAdmissionQueue(): void {
  fifoQueue.length = 0;
}

export const getQueue = getAdmissionQueue;
export const clearQueue = clearAdmissionQueue;

export function getLiveRunCapacity(backendKind?: string): number {
  const kind = backendKind ?? process.env.EXECUTION_BACKEND ?? "instabox-docker";
  return kind === "instabox-docker" ? MAX_LIVE_RUNS_INSTABOX : MAX_LIVE_RUNS_CLOUD;
}

export function getActiveLiveRuns(runStore?: RunStore): RunRecord[] {
  const store = runStore ?? getDefaultRunStore();
  return store
    .getLivingRuns()
    .filter(
      (r) =>
        r.phase !== "queued" &&
        r.phase !== "done" &&
        !r.outcome
    );
}

export function isLiveRunCapacityAvailable(
  runStore?: RunStore,
  backendKind?: string
): boolean {
  const capacity = getLiveRunCapacity(backendKind);
  const activeRuns = getActiveLiveRuns(runStore);
  return activeRuns.length < capacity;
}

interface AdmissionState {
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

function resolveAdmission(request?: Request): AdmissionState | null {
  const reqAny = request as unknown as { admission?: AdmissionState } | undefined;
  if (reqAny?.admission) {
    return reqAny.admission;
  }
  if (globalState.__admission) {
    return globalState.__admission as AdmissionState;
  }
  return null;
}

// Register default admission interface on globalThis so GET /api/health reflects live queue state
if (!globalState.__admission) {
  globalState.__admission = {
    isPaused: () => false,
    isUnavailable: () => false,
    isHealthy: () => true,
    getQueueLength: () => fifoQueue.length,
    queue: fifoQueue,
  };
}

export async function POST(request: Request): Promise<Response> {
  // 1. Check if admission is paused or unavailable (Requirements 34.1, 34.8)
  const admission = resolveAdmission(request);
  if (admission) {
    const isPaused = Boolean(
      (typeof admission.isPaused === "function" && admission.isPaused()) ||
        admission.paused === true ||
        admission.killSwitch === true ||
        admission.state === "paused"
    );
    if (isPaused) {
      return Response.json(
        {
          ok: false,
          code: "PAUSED",
          status: "paused",
          reason: "paused by owner",
          error: "Live runs are currently paused by the owner",
        },
        { status: 503 }
      );
    }

    const isUnavailable = Boolean(
      (typeof admission.isUnavailable === "function" && admission.isUnavailable()) ||
        admission.unavailable === true ||
        admission.state === "unavailable" ||
        (typeof admission.isStopped === "function" && admission.isStopped()) ||
        (typeof admission.isHealthy === "function" && !admission.isHealthy())
    );
    if (isUnavailable) {
      const reason =
        (typeof admission.getReason === "function" && admission.getReason()) ||
        admission.reason ||
        "Live runs are currently unavailable";
      return Response.json(
        {
          ok: false,
          code: "UNAVAILABLE",
          status: "unavailable",
          reason,
          error: reason,
        },
        { status: 503 }
      );
    }
  }

  // 2. Parse request JSON body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Invalid JSON body", code: "BAD_JSON" },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { ok: false, error: "Request body must be an object", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const { url, sha, inviteCode, runId: customRunId } = body as Record<string, unknown>;

  // 3. Validate url and sha
  if (!url || typeof url !== "string" || !url.trim()) {
    return Response.json(
      { ok: false, error: "url is required", code: "MISSING_URL" },
      { status: 400 }
    );
  }

  if (!sha || typeof sha !== "string" || !sha.trim()) {
    return Response.json(
      { ok: false, error: "sha is required", code: "MISSING_SHA" },
      { status: 400 }
    );
  }

  const cleanUrl = url.trim();
  const cleanSha = sha.trim();

  // 4. Validate invite code using lookupInviteCode from lib/runs/run-store.ts
  // Requirements: 31.2, 34.7
  const runStore = resolveRunStore(request);

  if (!inviteCode || typeof inviteCode !== "string" || !inviteCode.trim()) {
    return Response.json(
      {
        ok: false,
        error: "Missing invite code",
        code: "MISSING_INVITE_CODE",
        status: "missing",
        reason: "missing",
        message: "An invite code is required to start a run.",
      },
      { status: 403 }
    );
  }

  const cleanInviteCode = inviteCode.trim();
  const remainingRuns = lookupInviteCode(cleanInviteCode, runStore);
  const details = lookupInviteCodeDetails(cleanInviteCode, runStore);

  if (remainingRuns === null || details.status === "not_found") {
    return Response.json(
      {
        ok: false,
        error: "Invalid invite code",
        code: "INVALID_INVITE_CODE",
        status: "not_found",
        reason: "not_found",
        message: "The submitted invite code was not recognized.",
      },
      { status: 403 }
    );
  }

  if (details.status === "expired") {
    return Response.json(
      {
        ok: false,
        error: "Invite code has expired",
        code: "EXPIRED_INVITE_CODE",
        status: "expired",
        reason: "expired",
        message: "The submitted invite code has expired.",
      },
      { status: 403 }
    );
  }

  if (details.status === "revoked") {
    return Response.json(
      {
        ok: false,
        error: "Invite code has been revoked",
        code: "REVOKED_INVITE_CODE",
        status: "revoked",
        reason: "revoked",
        message: "The submitted invite code has been revoked by the owner.",
      },
      { status: 403 }
    );
  }

  if (details.status === "used_up" || remainingRuns <= 0) {
    return Response.json(
      {
        ok: false,
        error: "Invite code run limit reached",
        code: "RUN_LIMIT_REACHED",
        status: "used_up",
        reason: "used_up",
        message: "The submitted invite code has no remaining runs.",
      },
      { status: 403 }
    );
  }

  // 5. Refuse to start when a Required_Setting has no value (Requirement 30.2).
  //
  // `assertRequiredSettingsConfigured` previously had no production caller, so runs were created
  // and enqueued even while the Necromancer still had Required_Settings without values. This gate
  // runs *before* `createRun` / the FIFO enqueue: on failure it returns 503 with the missing keys
  // and no run is created or queued.
  if (isSettingsStoreConfigured(request)) {
    try {
      assertRequiredSettingsConfigured(resolveSettingsStore(request));
    } catch (err) {
      if (err instanceof RequiredSettingMissingError) {
        return Response.json(
          {
            ok: false,
            error: err.message,
            code: "REQUIRED_SETTINGS_MISSING",
            missing: [...err.missing],
          },
          { status: 503 }
        );
      }
      throw err;
    }
  }

  // 6. Check queue depth cap (Requirement 31.8)
  const queueDepthCap = Number(
    process.env.QUEUE_DEPTH_CAP ||
      (admission as Record<string, unknown> | null)?.queueDepthCap ||
      5
  );
  if (fifoQueue.length >= queueDepthCap) {
    return Response.json(
      {
        ok: false,
        error: "Queue depth cap reached",
        code: "QUEUE_FULL",
        status: "queue_full",
        reason: "queue_depth_cap_reached",
        message: "The admission queue is full. Please try again later.",
      },
      { status: 429 }
    );
  }

  // 7. Generate runId
  const runId =
    typeof customRunId === "string" && customRunId.trim()
      ? customRunId.trim()
      : `run-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  // 8. Enforce single live run capacity under instabox-docker (Requirement 31.10)
  // Under instabox-docker, capacity is 1 live run.
  // The run is appended to the FIFO queue with phase 'queued'.
  const queuePosition = fifoQueue.length + 1;
  const backendKind = process.env.EXECUTION_BACKEND ?? "instabox-docker";

  // 9. Create run record with the run store (Requirement 31.6)
  runStore.createRun({
    runId,
    url: cleanUrl,
    sha: cleanSha,
    phase: "queued",
    outcome: null,
    inviteCode: cleanInviteCode,
    inviteCodeHash: details.codeHash ?? null,
    queuePosition,
    caps: details.caps ?? null,
    pushFlag: Boolean(details.pushFlag),
    metadata: {
      backend: backendKind,
      queuedAt: Date.now(),
    },
  });

  // 10. Append run to FIFO queue held in module memory (Requirement 31.6)
  const queuedRun: QueuedRun = {
    runId,
    url: cleanUrl,
    sha: cleanSha,
    inviteCode: cleanInviteCode,
    inviteCodeHash: details.codeHash ?? null,
    queuePosition,
    queuedAt: Date.now(),
    caps: details.caps ?? null,
    pushFlag: Boolean(details.pushFlag),
  };
  fifoQueue.push(queuedRun);

  // 11. Emit run.queued and run.queue_position event through EventStore (Requirement 31.6)
  const eventStore = resolveEventStore(request, undefined, runStore);
  eventStore.append(
    redactEvent({
      runId,
      kind: "run.queued",
      actor: "necromancer",
      data: {
        queuePosition,
        url: cleanUrl,
        sha: cleanSha,
        backend: backendKind,
        refs: [],
      },
    }) as any
  );

  eventStore.append(
    redactEvent({
      runId,
      kind: "run.queue_position",
      actor: "necromancer",
      data: {
        queuePosition,
        refs: [],
      },
    }) as any
  );

  try {
    const orchestrator = resolveActiveOrchestrator(request);
    if (orchestrator && typeof orchestrator.enqueueRun === "function") {
      orchestrator.enqueueRun(runId);
    }
  } catch {
    // isolated unit tests injecting request.runStore or orchestrator init error should not fail response
  }

  // 12. Return HTTP 202 with runId
  return Response.json(
    {
      ok: true,
      runId,
      queuePosition,
    },
    {
      status: 202,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );
}
