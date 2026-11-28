import {
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
  resolveSettingsStore,
} from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import { resolveFifoQueue } from "@/lib/admission/fifo-queue";
import { getRuntimeHost } from "@/lib/runtime/runtime-host";
import {
  KILL_SWITCH_LEVELS,
  KillSwitchService,
  clearKillSwitchUnpersistedAuthority,
  isKillSwitchUnpersistedAuthority,
  killSwitchConfirmationPhrase,
  killSwitchServiceRegistry,
  markKillSwitchUnpersistedAuthority,
  type KillSwitchLevel,
  type KillSwitchRuntimeControls,
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

/**
 * Resolves the active live `RunOrchestrator`. A request carrying injected stores (an isolated test
 * harness) makes `resolveActiveOrchestrator` return null, so the process-global orchestrator is
 * checked first and again as a fallback — the kill switch must still reach the live process handle.
 */
function resolveLiveOrchestrator(request?: Request): unknown {
  const g = globalThis as unknown as { __runOrchestrator?: unknown };
  if (g.__runOrchestrator) {
    return g.__runOrchestrator;
  }
  try {
    const orchestrator = resolveActiveOrchestrator(request);
    if (orchestrator) {
      return orchestrator;
    }
  } catch {
    // No live orchestrator reachable.
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Pauses the live RuntimeHost admission surface (adapter on `globalThis` or the shared host). */
function pauseLiveHost(): void {
  const g = globalThis as unknown as {
    __runtimeHost?: { pause?: () => void };
    __admission?: { pause?: () => void };
  };
  let paused = false;
  const runtimeHost = asRecord(g.__runtimeHost);
  if (runtimeHost && typeof runtimeHost.pause === "function") {
    try {
      (runtimeHost.pause as () => void).call(g.__runtimeHost);
      paused = true;
    } catch {
      // A failing host pause must not abort the kill switch.
    }
  }
  const admission = asRecord(g.__admission);
  if (admission && typeof admission.pause === "function") {
    try {
      (admission.pause as () => void).call(g.__admission);
      paused = true;
    } catch {
      // A failing admission pause must not abort the kill switch.
    }
  }
  if (!paused) {
    try {
      getRuntimeHost().pause();
    } catch {
      // A missing/unstartable host must not abort the kill switch.
    }
  }
}

/** Removes a run from the in-memory admission queue, reindexing the remaining positions. */
function removeFromAdmissionQueue(runId: string): boolean {
  const g = globalThis as unknown as { __admissionQueue?: unknown };
  const queue = g.__admissionQueue;
  if (!Array.isArray(queue)) {
    return false;
  }
  const index = queue.findIndex((entry) => asRecord(entry)?.runId === runId);
  if (index < 0) {
    return false;
  }
  queue.splice(index, 1);
  queue.forEach((entry, position) => {
    const record = asRecord(entry);
    if (record) {
      record.queuePosition = position + 1;
    }
  });
  return true;
}

/** Builds the live runtime-control hooks the kill switch drives for this process. */
function buildRuntimeControls(request: Request): KillSwitchRuntimeControls {
  return {
    pauseAdmission: () => {
      const orchestrator = asRecord(resolveLiveOrchestrator(request));
      if (orchestrator && typeof orchestrator.pauseAdmission === "function") {
        try {
          (orchestrator.pauseAdmission as () => void).call(orchestrator);
        } catch {
          // A failing orchestrator pause must not abort the kill switch.
        }
      }
    },
    resumeAdmission: () => {
      const orchestrator = asRecord(resolveLiveOrchestrator(request));
      if (orchestrator && typeof orchestrator.resumeAdmission === "function") {
        try {
          (orchestrator.resumeAdmission as () => void).call(orchestrator);
        } catch {
          // ignore
        }
      }
    },
    pauseHost: () => pauseLiveHost(),
    stopRun: (runId: string, reason?: string) => {
      const orchestrator = asRecord(resolveLiveOrchestrator(request));
      if (orchestrator && typeof orchestrator.stopRun === "function") {
        return (orchestrator.stopRun as (id: string, why?: string) => void | Promise<void>).call(
          orchestrator,
          runId,
          reason
        );
      }
      return undefined;
    },
    // Preferred for `stop_gracefully`: ends the run at its next tool boundary without aborting the
    // in-flight worker turn or deleting its worktree. Falls back to the aborting `stopRun` only when
    // the resolved orchestrator (e.g. a test double) does not expose the graceful control.
    stopRunGracefully: (runId: string, reason?: string) => {
      const orchestrator = asRecord(resolveLiveOrchestrator(request));
      if (orchestrator && typeof orchestrator.stopRunGracefully === "function") {
        return (
          orchestrator.stopRunGracefully as (id: string, why?: string) => void | Promise<void>
        ).call(orchestrator, runId, reason);
      }
      if (orchestrator && typeof orchestrator.stopRun === "function") {
        return (orchestrator.stopRun as (id: string, why?: string) => void | Promise<void>).call(
          orchestrator,
          runId,
          reason
        );
      }
      return undefined;
    },
    killRun: (runId: string, reason?: string) => {
      const orchestrator = asRecord(resolveLiveOrchestrator(request));
      if (orchestrator && typeof orchestrator.killRun === "function") {
        return (orchestrator.killRun as (id: string, why?: string) => void | Promise<void>).call(
          orchestrator,
          runId,
          reason
        );
      }
      return undefined;
    },
    cancelQueuedRun: (runId: string) => {
      let cancelled = false;
      const orchestrator = asRecord(resolveLiveOrchestrator(request));
      if (orchestrator && typeof orchestrator.cancelQueuedRun === "function") {
        try {
          if ((orchestrator.cancelQueuedRun as (id: string) => boolean).call(orchestrator, runId) !== false) {
            cancelled = true;
          }
        } catch {
          // ignore
        }
      }
      if (removeFromAdmissionQueue(runId)) {
        cancelled = true;
      }
      return cancelled;
    },
    // Preferred over `cancelQueuedRun` for `hard_kill`: `orchestrator.removeQueuedRun` drops the run
    // from the live queue WITHOUT rewriting its terminal outcome to `"cancelled"`, so the kill's
    // `outcome: "killed"` survives. It also clears the run from `globalThis.__admissionQueue`.
    removeQueuedRun: (runId: string) => {
      let removed = false;
      const orchestrator = asRecord(resolveLiveOrchestrator(request));
      if (orchestrator && typeof orchestrator.removeQueuedRun === "function") {
        try {
          if (
            (orchestrator.removeQueuedRun as (id: string) => boolean).call(orchestrator, runId) !== false
          ) {
            removed = true;
          }
        } catch {
          // ignore
        }
      }
      if (removeFromAdmissionQueue(runId)) {
        removed = true;
      }
      return removed;
    },
  };
}

/**
 * Returns the shared {@link KillSwitchService} bound to a particular `RunStore`, so successive Admin
 * calls observe the same pause/stop state while distinct stores (tests, other processes) stay
 * isolated. A shared instance is required because the service mutates in-memory state on `execute`.
 */
function buildService(request: Request): {
  service: KillSwitchService;
  settings: SettingsStore;
  storeKey: object;
} {
  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
  const settings = resolveSettingsStore(request);
  const storeKey = runStore as unknown as object;

  const services = killSwitchServiceRegistry();
  let service = services.get(storeKey);
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
      runtimeControls: buildRuntimeControls(request),
    });
    services.set(storeKey, service);
  }
  // Rehydrate on EVERY request (not only on cold start) so the enforced flags stay synchronized
  // with the persisted SettingsStore values at all times — unless a prior `persistState` failure
  // made the in-memory state authoritative, in which case rehydrating would silently revert the
  // active pause/stop.
  if (!isKillSwitchUnpersistedAuthority(storeKey)) {
    service.rehydrateState({
      pausedNewRuns: readBooleanSetting(settings, KILL_SWITCH_PAUSE_KEY),
      stoppingGracefully: readBooleanSetting(settings, KILL_SWITCH_STOP_KEY),
      lastLevel: readLastLevel(settings),
    });
  }
  return { service, settings, storeKey };
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

  const { service, settings, storeKey } = buildService(request);
  const preview = service.preview(body.level);

  const confirmed = body.confirmed === true || body.confirm === true;
  if (!confirmed) {
    return Response.json({
      ok: true,
      requiresConfirmation: true,
      preview,
    });
  }

  // Recompute the confirmation phrase from the CURRENT preview (the same wording the modal
  // shows) and require the request's `confirm` string to match it exactly. The affected runs
  // can change between the moment the Admin read the count and the moment they confirm, so a
  // stale phrase must never execute a larger kill than the one the Admin actually reviewed.
  const activeRunCount = service.preview("stop_gracefully").affectedRunCount;
  const queuedRunCount = service.preview("pause_new_runs").affectedRunCount;
  const expected = killSwitchConfirmationPhrase(body.level, activeRunCount, queuedRunCount);
  if (body.confirm !== expected) {
    return Response.json(
      { ok: false, error: "confirmation_mismatch", expected },
      { status: 409 }
    );
  }

  // Run the synchronous state mutation first, then persist the kill-switch flags BEFORE awaiting any
  // asynchronous `stopRun` / `killRun`. `execute` and `persistState` run in the same synchronous tick,
  // so a concurrent `GET /api/admin/kill-switch` can never rehydrate a stale
  // `stoppingGracefully: false` over the in-flight execution.
  const result = service.execute(body.level, {
    actor: auth.actor.id,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  });

  let persistFailed = false;
  try {
    persistState(settings, auth.actor.id, service);
  } catch {
    // The kill switch ran, but its state could not be persisted. Keep the in-memory state
    // authoritative for this store so a later request's rehydrate cannot silently revert the active
    // pause/stop, and report the failure so the caller does not assume the state survived.
    markKillSwitchUnpersistedAuthority(storeKey);
    persistFailed = true;
  }

  // The durable state is already written, so it is safe to await the live runtime controls now.
  if (typeof result.waitForRuntime === "function") {
    await result.waitForRuntime();
  }

  if (persistFailed) {
    return Response.json({ ok: false, error: "kill_switch_persist_failed" }, { status: 500 });
  }
  // The write succeeded, so the persisted SettingsStore now matches the in-memory state: drop any
  // unpersisted-authority mark left by an earlier transient failure so future requests rehydrate
  // from the store again.
  clearKillSwitchUnpersistedAuthority(storeKey);

  if (result.failedRunIds.length > 0) {
    // A live `stopRun` / `killRun` rejected: the level did not fully take effect for these runs, so
    // return a retryable failure naming them instead of a misleading success.
    return Response.json(
      {
        ok: false,
        error: "kill_switch_runtime_control_failed",
        failedRunIds: result.failedRunIds,
        result,
        state: mergedState(service, settings),
      },
      { status: 500 }
    );
  }
  return Response.json({ ok: true, result, state: mergedState(service, settings) });
}
