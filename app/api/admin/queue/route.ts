import {
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
  resolveSettingsStore,
} from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import {
  resolveFifoQueue,
  type EnqueueInput,
  type FifoQueue,
  type QueueEntry,
} from "@/lib/admission/fifo-queue";
import type { RunRecord, RunStore } from "@/lib/runs/run-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface QueueBody {
  action?: unknown;
  runId?: unknown;
  position?: unknown;
  reason?: unknown;
}

async function readBody(request: Request): Promise<QueueBody> {
  try {
    const parsed = (await request.json()) as QueueBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildQueue(request: Request): FifoQueue {
  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
  const settings = resolveSettingsStore(request);
  return resolveFifoQueue({
    eventStore,
    runStore,
    queueDepth: numberSetting(settings.getSetting("queueDepth")),
    queueIdleLimitMs: numberSetting(settings.getSetting("queueIdleLimitMs")),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Resolves the active live `RunOrchestrator`. A request carrying injected stores (an isolated test
 * harness) makes `resolveActiveOrchestrator` return null, so the process-global orchestrator is
 * checked first and again as a fallback.
 */
function resolveLiveOrchestrator(request: Request): Record<string, unknown> | null {
  const g = globalThis as unknown as { __runOrchestrator?: unknown };
  if (g.__runOrchestrator) {
    return asRecord(g.__runOrchestrator);
  }
  try {
    return asRecord(resolveActiveOrchestrator(request));
  } catch {
    return null;
  }
}

function readAdmissionQueue(): unknown[] {
  const g = globalThis as unknown as { __admissionQueue?: unknown };
  return Array.isArray(g.__admissionQueue) ? g.__admissionQueue : [];
}

function queuedRunRows(runStore: RunStore): RunRecord[] {
  try {
    return runStore.listRuns({ phase: "queued" });
  } catch {
    try {
      return runStore.getLivingRuns().filter((run) => run.phase === "queued");
    } catch {
      return [];
    }
  }
}

function safeGetRun(runStore: RunStore, runId: string): RunRecord | null {
  try {
    return runStore.getRun(runId);
  } catch {
    return null;
  }
}

/**
 * Hydrates the resolved {@link FifoQueue} with every queued entry currently held by a live surface
 * (`globalThis.__admissionQueue`, the active orchestrator, or queued `RunStore` rows) without
 * duplicating entries already present. This is what makes a run submitted through
 * `POST /api/start-run` always visible to `GET /api/admin/queue` and to the move/remove/cancel
 * actions, regardless of which surface recorded it first.
 */
function hydrateQueue(request: Request, queue: FifoQueue, runStore: RunStore): void {
  const orchestrator = resolveLiveOrchestrator(request);
  const admission = readAdmissionQueue();

  const orchestratorQueued: string[] = [];
  if (orchestrator && typeof orchestrator.getQueueSnapshot === "function") {
    try {
      const snapshot = (orchestrator.getQueueSnapshot as (this: unknown) => unknown).call(
        orchestrator
      );
      const record = asRecord(snapshot);
      const queued =
        record && Array.isArray(record.queued)
          ? record.queued
          : Array.isArray(snapshot)
            ? snapshot
            : [];
      for (const id of queued) {
        if (typeof id === "string" && id.length > 0) {
          orchestratorQueued.push(id);
        }
      }
    } catch {
      // A failing snapshot must not hide already-queued RunStore rows.
    }
  }

  const admissionIds: string[] = [];
  for (const entry of admission) {
    const runId = asRecord(entry)?.runId;
    if (typeof runId === "string" && runId.length > 0) {
      admissionIds.push(runId);
    }
  }

  const rows = queuedRunRows(runStore)
    .slice()
    .sort((a, b) => {
      const pa = a.queuePosition ?? Number.POSITIVE_INFINITY;
      const pb = b.queuePosition ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: unknown): void => {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };

  for (const id of orchestratorQueued) push(id);
  for (const id of admissionIds) push(id);
  for (const row of rows) push(row.runId);

  for (const runId of ordered) {
    if (queue.has(runId)) {
      continue;
    }
    const row = safeGetRun(runStore, runId);
    if (row) {
      // A run the store already finalized (done/cancelled) or explicitly marked as no longer
      // positioned is not re-admitted, even if a live surface still lists it.
      if (row.phase !== "queued") {
        continue;
      }
      if (row.queuePosition === null || row.queuePosition === undefined) {
        continue;
      }
    }
    try {
      queue.enqueue(buildEnqueueInput(runId, row, admission));
    } catch {
      // A single un-hydratable entry must not break the whole snapshot.
    }
  }
}

function buildEnqueueInput(
  runId: string,
  row: RunRecord | null,
  admission: unknown[]
): EnqueueInput {
  if (row) {
    return {
      runId,
      url: row.url ?? null,
      sha: row.sha ?? null,
      inviteCodeHash: row.inviteCodeHash ?? null,
      caps: row.caps ?? null,
      pushFlag: row.pushFlag === true,
      queuedAt: typeof row.createdAt === "number" ? row.createdAt : undefined,
    };
  }
  for (const entry of admission) {
    const record = asRecord(entry);
    if (!record || record.runId !== runId) {
      continue;
    }
    return {
      runId,
      url: typeof record.url === "string" ? record.url : null,
      sha: typeof record.sha === "string" ? record.sha : null,
      inviteCodeHash: typeof record.inviteCodeHash === "string" ? record.inviteCodeHash : null,
      caps: asRecord(record.caps) ?? null,
      pushFlag: record.pushFlag === true,
      queuedAt: typeof record.queuedAt === "number" ? record.queuedAt : undefined,
    };
  }
  return { runId };
}


function removeFromAdmissionQueue(runId: string): boolean {
  const admission = readAdmissionQueue();
  const index = admission.findIndex((entry) => asRecord(entry)?.runId === runId);
  if (index < 0) {
    return false;
  }
  admission.splice(index, 1);
  reindexAdmissionQueue(admission);
  return true;
}

function moveInAdmissionQueue(runId: string, position: number): boolean {
  const admission = readAdmissionQueue();
  const index = admission.findIndex((entry) => asRecord(entry)?.runId === runId);
  if (index < 0) {
    return false;
  }
  const [entry] = admission.splice(index, 1);
  const target = Math.max(1, Math.min(Math.floor(position) || 1, admission.length + 1));
  admission.splice(target - 1, 0, entry);
  reindexAdmissionQueue(admission);
  return true;
}

function reindexAdmissionQueue(admission: unknown[]): void {
  admission.forEach((entry, index) => {
    const record = asRecord(entry);
    if (record) {
      record.queuePosition = index + 1;
    }
  });
}

/**
 * Removes a run from the active orchestrator's queue through its optional `removeQueuedRun` hook.
 * The RunStore `queuePosition` fallback is applied by the caller so a queue without that hook still
 * stops reporting the run as queued.
 */
function removeFromOrchestrator(orchestrator: Record<string, unknown> | null, runId: string): void {
  if (orchestrator && typeof orchestrator.removeQueuedRun === "function") {
    try {
      (orchestrator.removeQueuedRun as (id: string) => unknown).call(orchestrator, runId);
    } catch {
      // The RunStore fallback applied by the caller still removes the run from the visible queue.
    }
  }
}


export async function GET(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const runStore = resolveRunStore(request);
  const queue = buildQueue(request);
  hydrateQueue(request, queue, runStore);
  queue.evictIdle();
  return Response.json({ ok: true, queue: queue.snapshot() });
}

export async function POST(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const body = await readBody(request);
  const action = typeof body.action === "string" ? body.action : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (!runId) {
    return Response.json({ ok: false, error: "runId_required" }, { status: 400 });
  }

  const runStore = resolveRunStore(request);
  const orchestrator = resolveLiveOrchestrator(request);
  const queue = buildQueue(request);
  hydrateQueue(request, queue, runStore);
  const previousPosition = queue.getPosition(runId);

  switch (action) {
    case "remove": {
      const removed: QueueEntry | null = queue.remove(runId);
      if (!removed) {
        return Response.json({ ok: false, error: "not_queued" }, { status: 404 });
      }
      removeFromAdmissionQueue(runId);
      removeFromOrchestrator(orchestrator, runId);
      // Persist the removal so a later snapshot does not re-hydrate the run from its queued row.
      try {
        if (safeGetRun(runStore, runId)) {
          runStore.updateRun(runId, { queuePosition: null });
        }
      } catch {
        // The queue mutation already succeeded; a missing run row must not fail the response.
      }
      return Response.json({ ok: true, removed, queue: queue.snapshot() });
    }
    case "move": {
      const position =
        typeof body.position === "number" && Number.isFinite(body.position)
          ? Math.floor(body.position)
          : previousPosition ?? 1;
      const moved: QueueEntry | null = queue.move(runId, position);
      if (!moved) {
        return Response.json({ ok: false, error: "not_queued" }, { status: 404 });
      }
      moveInAdmissionQueue(runId, position);
      if (orchestrator && typeof orchestrator.moveQueuedRun === "function") {
        try {
          (orchestrator.moveQueuedRun as (id: string, pos: number) => unknown).call(
            orchestrator,
            runId,
            position
          );
        } catch {
          // The FifoQueue already applied and persisted the new position.
        }
      }
      return Response.json({ ok: true, moved, queue: queue.snapshot() });
    }
    case "cancel": {
      const cancelled: QueueEntry | null = queue.cancel(runId);
      if (!cancelled) {
        return Response.json({ ok: false, error: "not_queued" }, { status: 404 });
      }
      removeFromAdmissionQueue(runId);
      if (orchestrator && typeof orchestrator.cancelQueuedRun === "function") {
        try {
          (orchestrator.cancelQueuedRun as (id: string) => unknown).call(orchestrator, runId);
        } catch {
          // The FifoQueue already cancelled the run in the RunStore.
        }
      }
      return Response.json({ ok: true, cancelled, queue: queue.snapshot() });
    }
    default:
      return Response.json({ ok: false, error: "unknown_action" }, { status: 400 });
  }
}
