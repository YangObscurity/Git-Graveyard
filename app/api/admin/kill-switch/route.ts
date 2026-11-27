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
  type KillSwitchState,
} from "@/lib/admin/kill-switch";
import type { SettingsStore } from "@/lib/admin/settings-store";

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

/** SettingsStore keys that persist kill-switch state across requests. */
const KILL_SWITCH_PAUSE_KEY = "killSwitch.pauseNewRuns";
const KILL_SWITCH_STOP_KEY = "killSwitch.stopGracefully";
const KILL_SWITCH_LAST_LEVEL_KEY = "killSwitch.lastLevel";

const killSwitchRegistry = globalThis as unknown as {
  __killSwitchServices?: WeakMap<object, KillSwitchService>;
};

/**
 * Returns the shared {@link KillSwitchService} bound to a particular `RunStore`, so successive Admin
 * calls observe the same pause/stop state while distinct stores (tests, other processes) stay
 * isolated. A shared instance is required because the service mutates in-memory state on `execute`.
 */
function buildService(request: Request): { service: KillSwitchService; settings: SettingsStore } {
  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
  const settings = resolveSettingsStore(request);

  if (!killSwitchRegistry.__killSwitchServices) {
    killSwitchRegistry.__killSwitchServices = new WeakMap<object, KillSwitchService>();
  }
  const key = runStore as unknown as object;
  let service = killSwitchRegistry.__killSwitchServices.get(key);
  if (!service) {
    const queue = resolveFifoQueue({
      eventStore,
      runStore,
      queueDepth: numberSetting(settings.getSetting("queueDepth")),
      queueIdleLimitMs: numberSetting(settings.getSetting("queueIdleLimitMs")),
    });
    service = new KillSwitchService({
      runStore,
      eventStore,
      queue: {
        cancel: (runId) => queue.cancel(runId),
        remove: (runId) => queue.remove(runId),
      },
    });
    killSwitchRegistry.__killSwitchServices.set(key, service);
  }
  // Rehydrate on EVERY request (not only on cold start) so the enforced flags stay synchronized
  // with the persisted SettingsStore values at all times.
  service.rehydrateState({
    pausedNewRuns: readBooleanSetting(settings, KILL_SWITCH_PAUSE_KEY),
    stoppingGracefully: readBooleanSetting(settings, KILL_SWITCH_STOP_KEY),
    lastLevel: readLastLevel(settings),
  });
  return { service, settings };
}

/** Clears the shared kill-switch registry (used by tests between fixtures). */
export function resetKillSwitchRegistry(): void {
  killSwitchRegistry.__killSwitchServices = new WeakMap<object, KillSwitchService>();
}

function readBooleanSetting(settings: SettingsStore, key: string): boolean {
  return settings.getSetting(key) === true;
}

function readLastLevel(settings: SettingsStore): KillSwitchLevel | null {
  const value = settings.getSetting(KILL_SWITCH_LAST_LEVEL_KEY);
  return isLevel(value) ? value : null;
}

/** Merges the live service state with any persisted state so a fresh process still observes it. */
function mergedState(service: KillSwitchService, settings: SettingsStore): KillSwitchState {
  const base = service.getState();
  return {
    pausedNewRuns: base.pausedNewRuns || readBooleanSetting(settings, KILL_SWITCH_PAUSE_KEY),
    stoppingGracefully:
      base.stoppingGracefully || readBooleanSetting(settings, KILL_SWITCH_STOP_KEY),
    lastLevel: base.lastLevel ?? readLastLevel(settings),
    lastExecutedAt: base.lastExecutedAt,
  };
}

function persistState(settings: SettingsStore, actor: string, service: KillSwitchService): void {
  const state = service.getState();
  // Persistence errors are NOT swallowed: the caller must know when the kill-switch state could not
  // be written so it can report the failure instead of pretending the state is durable.
  settings.setSettingsBatch(
    {
      [KILL_SWITCH_PAUSE_KEY]: state.pausedNewRuns,
      [KILL_SWITCH_STOP_KEY]: state.stoppingGracefully,
      [KILL_SWITCH_LAST_LEVEL_KEY]: state.lastLevel,
    },
    { actor, reason: "kill switch state" }
  );
}

export async function GET(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const { service, settings } = buildService(request);
  const previews = KILL_SWITCH_LEVELS.map((level) => service.preview(level));
  return Response.json({ ok: true, previews, state: mergedState(service, settings) });
}

export async function POST(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const body = await readBody(request);
  if (!isLevel(body.level)) {
    return Response.json({ ok: false, error: "invalid_level" }, { status: 400 });
  }

  const { service, settings } = buildService(request);
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
  try {
    persistState(settings, auth.actor.id, service);
  } catch {
    // The kill switch ran, but its state could not be persisted; report the failure so the caller
    // does not assume the state survived.
    return Response.json({ ok: false, error: "kill_switch_persist_failed" }, { status: 500 });
  }
  return Response.json({ ok: true, result, state: mergedState(service, settings) });
}
