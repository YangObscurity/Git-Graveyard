import {
  resolveEventStore,
  resolveRunStore,
  resolveSettingsStore,
} from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import { resolveFifoQueue } from "@/lib/admission/fifo-queue";

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

function buildQueue(request: Request) {
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

export async function GET(request: Request): Promise<Response> {
  const auth = requireAdminAuth(request);
  if (!auth.ok) {
    return auth.response;
  }
  const queue = buildQueue(request);
  queue.evictIdle();
  return Response.json({ ok: true, queue: queue.snapshot() });
}

export async function POST(request: Request): Promise<Response> {
  const auth = requireAdminAuth(request);
  if (!auth.ok) {
    return auth.response;
  }
  const body = await readBody(request);
  const action = typeof body.action === "string" ? body.action : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (!runId) {
    return Response.json({ ok: false, error: "runId_required" }, { status: 400 });
  }

  const queue = buildQueue(request);
  const previousPosition = queue.getPosition(runId);

  switch (action) {
    case "remove": {
      const removed = queue.remove(runId);
      if (!removed) {
        return Response.json({ ok: false, error: "not_queued" }, { status: 404 });
      }
      return Response.json({ ok: true, removed, queue: queue.snapshot() });
    }
    case "move": {
      const position =
        typeof body.position === "number" && Number.isFinite(body.position)
          ? Math.floor(body.position)
          : previousPosition ?? 1;
      const moved = queue.move(runId, position);
      if (!moved) {
        return Response.json({ ok: false, error: "not_queued" }, { status: 404 });
      }
      return Response.json({ ok: true, moved, queue: queue.snapshot() });
    }
    case "cancel": {
      const cancelled = queue.cancel(runId);
      if (!cancelled) {
        return Response.json({ ok: false, error: "not_queued" }, { status: 404 });
      }
      return Response.json({ ok: true, cancelled, queue: queue.snapshot() });
    }
    default:
      return Response.json({ ok: false, error: "unknown_action" }, { status: 400 });
  }
}
