import {
  resolveEventStore,
  resolveRunStore,
  resolveSettingsStore,
} from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import { resolveFifoQueue } from "@/lib/admission/fifo-queue";
import {
  KILL_SWITCH_LEVELS,
  KillSwitchService,
  type KillSwitchLevel,
} from "@/lib/admin/kill-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface KillSwitchBody {
  level?: unknown;
  confirm?: unknown;
  confirmed?: unknown;
  reason?: unknown;
}

async function readBody(request: Request): Promise<KillSwitchBody> {
  try {
    const parsed = (await request.json()) as KillSwitchBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isLevel(value: unknown): value is KillSwitchLevel {
  return typeof value === "string" && (KILL_SWITCH_LEVELS as readonly string[]).includes(value);
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildService(request: Request): KillSwitchService {
  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
  const settings = resolveSettingsStore(request);
  const queue = resolveFifoQueue({
    eventStore,
    runStore,
    queueDepth: numberSetting(settings.getSetting("queueDepth")),
    queueIdleLimitMs: numberSetting(settings.getSetting("queueIdleLimitMs")),
  });
  return new KillSwitchService({
    runStore,
    eventStore,
    queue: {
      cancel: (runId) => queue.cancel(runId),
      remove: (runId) => queue.remove(runId),
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const auth = requireAdminAuth(request);
  if (!auth.ok) {
    return auth.response;
  }
  const service = buildService(request);
  const previews = KILL_SWITCH_LEVELS.map((level) => service.preview(level));
  return Response.json({ ok: true, previews, state: service.getState() });
}

export async function POST(request: Request): Promise<Response> {
  const auth = requireAdminAuth(request);
  if (!auth.ok) {
    return auth.response;
  }
  const body = await readBody(request);
  if (!isLevel(body.level)) {
    return Response.json({ ok: false, error: "invalid_level" }, { status: 400 });
  }

  const service = buildService(request);
  const preview = service.preview(body.level);

  const confirmed = body.confirmed === true || body.confirm === true;
  if (!confirmed) {
    return Response.json({
      ok: true,
      requiresConfirmation: true,
      preview,
    });
  }

  const result = service.execute(body.level, {
    actor: auth.actor.id,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  });
  return Response.json({ ok: true, result, state: service.getState() });
}
