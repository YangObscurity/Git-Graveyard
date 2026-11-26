import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore, getDefaultEventStore } from "../events/event-store";
import { EventTap } from "../events/event-tap";
import { getRunOrchestrator } from "../orchestrator/run-orchestrator";
import {
  isSafeRecordedRunId,
  resolveRecordedArtifactDir,
  seedRecordedRunsIntoStores,
} from "../runs/recorded-runs-loader";
import { getDefaultRunStore, RunStore, type RunRecord } from "../runs/run-store";

interface InjectedStoreCarrier {
  runStore?: RunStore;
  eventStore?: EventStore;
  eventTap?: EventTap;
}

interface GlobalStoreSlots {
  __runStore?: RunStore;
  __sharedRunStore?: RunStore;
  __eventStore?: EventStore;
  __sharedEventStore?: EventStore;
  __eventTap?: EventTap;
  __sharedEventTap?: EventTap;
  __runOrchestrator?: unknown;
}

const seededStorePairs = new WeakMap<object, WeakSet<object>>();

function seedDefaultStoresOnce(runStore: RunStore, eventStore: EventStore): void {
  let pairedEvents = seededStorePairs.get(runStore);
  if (pairedEvents?.has(eventStore)) {
    return;
  }
  try {
    seedRecordedRunsIntoStores(runStore, eventStore);
  } catch {
    // Non-fatal: seeding recorded runs must never crash request handling
  }
  if (!pairedEvents) {
    pairedEvents = new WeakSet<object>();
    seededStorePairs.set(runStore, pairedEvents);
  }
  pairedEvents.add(eventStore);
}

function getInjectedCarrier(value: unknown): InjectedStoreCarrier | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as InjectedStoreCarrier;
}

export function isSafeRunId(runId: unknown): runId is string {
  return typeof runId === "string" && isSafeRecordedRunId(runId);
}

export function resolveRunStore(request?: Request, context?: unknown): RunStore {
  const req = getInjectedCarrier(request);
  if (req?.runStore) {
    return req.runStore;
  }
  const ctx = getInjectedCarrier(context);
  if (ctx?.runStore) {
    return ctx.runStore;
  }

  const g = globalThis as unknown as GlobalStoreSlots;
  if (g.__runStore) {
    return g.__runStore;
  }

  const runStore = g.__sharedRunStore ?? getDefaultRunStore();

  // Only trigger recorded-run seeding when resolving default file-backed stores.
  if (
    !req?.eventStore &&
    !ctx?.eventStore &&
    !g.__eventStore &&
    runStore.getStorageMode?.() !== "memory"
  ) {
    const eventStore = g.__sharedEventStore ?? getDefaultEventStore();
    seedDefaultStoresOnce(runStore, eventStore);
  }

  return runStore;
}

export function resolveEventStore(
  request?: Request,
  context?: unknown,
  runStore?: RunStore
): EventStore {
  const req = getInjectedCarrier(request);
  if (req?.eventStore) {
    return req.eventStore;
  }
  const ctx = getInjectedCarrier(context);
  if (ctx?.eventStore) {
    return ctx.eventStore;
  }

  const g = globalThis as unknown as GlobalStoreSlots;
  if (g.__eventStore) {
    return g.__eventStore;
  }

  // If a test injected a custom RunStore (e.g. shared in-memory DatabaseSync) without an
  // explicit EventStore, wrap its DB instead of leaking the global file-backed EventStore.
  const hasInjectedRunStore = Boolean(req?.runStore || ctx?.runStore || g.__runStore);
  if (hasInjectedRunStore) {
    const db = (runStore as unknown as { db?: unknown } | undefined)?.db;
    if (db) {
      try {
        return new EventStore(db as ConstructorParameters<typeof EventStore>[0]);
      } catch {
        // Fallback below if wrapping fails
      }
    }
  }

  const eventStore = g.__sharedEventStore ?? getDefaultEventStore();

  if (!hasInjectedRunStore && eventStore.getStorageMode?.() !== "memory") {
    const resolvedRunStore = runStore ?? g.__sharedRunStore ?? getDefaultRunStore();
    seedDefaultStoresOnce(resolvedRunStore, eventStore);
  }

  return eventStore;
}

export function resolveEventTap(request?: Request, context?: unknown): EventTap {
  const req = getInjectedCarrier(request);
  if (req?.eventTap) {
    return req.eventTap;
  }
  if (req?.eventStore) {
    return new EventTap(req.eventStore);
  }

  const ctx = getInjectedCarrier(context);
  if (ctx?.eventTap) {
    return ctx.eventTap;
  }
  if (ctx?.eventStore) {
    return new EventTap(ctx.eventStore);
  }

  const g = globalThis as unknown as GlobalStoreSlots;
  if (g.__eventTap) {
    return g.__eventTap;
  }
  if (g.__eventStore) {
    return new EventTap(g.__eventStore);
  }

  const eventStore = resolveEventStore(request, context);
  if (g.__sharedEventTap && g.__sharedEventTap.eventStore === eventStore) {
    return g.__sharedEventTap;
  }

  const tap = new EventTap(eventStore);
  g.__sharedEventTap = tap;
  return tap;
}

export function resolveActiveOrchestrator(
  request?: Request,
  context?: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const req = getInjectedCarrier(request);
  const ctx = getInjectedCarrier(context);
  if (
    req?.runStore ||
    req?.eventStore ||
    req?.eventTap ||
    ctx?.runStore ||
    ctx?.eventStore ||
    ctx?.eventTap
  ) {
    return null;
  }

  const g = globalThis as unknown as GlobalStoreSlots;
  if (g.__runOrchestrator) {
    return g.__runOrchestrator;
  }

  if (process.env.DISABLE_AUTO_ORCHESTRATOR !== "1") {
    try {
      return getRunOrchestrator();
    } catch {
      return null;
    }
  }

  return null;
}

export function resolveRunArtifactDirs(
  runId: string,
  run?: RunRecord | null
): string[] {
  if (!isSafeRunId(runId)) {
    return [];
  }

  const candidates: string[] = [];
  const meta =
    run?.metadata && typeof run.metadata === "object"
      ? (run.metadata as Record<string, unknown>)
      : null;

  if (meta) {
    if (
      typeof meta.artifactsDir === "string" &&
      meta.artifactsDir.trim().length > 0 &&
      !meta.artifactsDir.includes("[REDACTED]")
    ) {
      candidates.push(path.resolve(meta.artifactsDir));
    }
    if (
      typeof meta.runDir === "string" &&
      meta.runDir.trim().length > 0 &&
      !meta.runDir.includes("[REDACTED]")
    ) {
      candidates.push(path.resolve(meta.runDir, "artifacts"));
      candidates.push(path.resolve(meta.runDir));
    }
  }

  if (process.env.RUNS_DIR && process.env.RUNS_DIR.trim().length > 0) {
    candidates.push(path.resolve(process.env.RUNS_DIR, runId, "artifacts"));
    candidates.push(path.resolve(process.env.RUNS_DIR, runId));
  }

  const recordedArtDir = resolveRecordedArtifactDir(runId);
  if (recordedArtDir) {
    candidates.push(recordedArtDir);
    candidates.push(path.dirname(recordedArtDir));
  }

  candidates.push(path.resolve("/data/runs", runId, "artifacts"));
  candidates.push(path.resolve("/data/runs", runId));
  candidates.push(
    path.resolve(os.tmpdir(), "git-graveyard-data", "runs", runId, "artifacts")
  );
  candidates.push(path.resolve(os.tmpdir(), "git-graveyard-data", "runs", runId));
  candidates.push(path.resolve(process.cwd(), ".agent-ws", runId, "artifacts"));
  candidates.push(path.resolve(process.cwd(), ".agent-ws", runId));
  candidates.push(path.resolve(process.cwd(), "output", runId, "artifacts"));
  candidates.push(path.resolve(process.cwd(), "output", runId));
  candidates.push(path.resolve(process.cwd(), "output"));

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      deduped.push(resolved);
    }
  }
  return deduped;
}

export interface DiskArtifactMatch {
  filePath: string;
  size: number;
  sha256: string;
}

export function findRunArtifactOnDisk(
  runId: string,
  fileName: string,
  run?: RunRecord | null
): DiskArtifactMatch | null {
  if (!isSafeRunId(runId) || !fileName || fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }
  const baseDirs = resolveRunArtifactDirs(runId, run);
  for (const dir of baseDirs) {
    const resolvedDir = path.resolve(dir);
    const resolvedTarget = path.resolve(resolvedDir, fileName);
    if (!resolvedTarget.startsWith(resolvedDir + path.sep)) {
      continue;
    }
    if (!fs.existsSync(resolvedTarget)) {
      continue;
    }
    try {
      const stat = fs.statSync(resolvedTarget);
      if (stat.isFile()) {
        const buf = fs.readFileSync(resolvedTarget);
        const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
        return { filePath: resolvedTarget, size: stat.size, sha256 };
      }
    } catch {
      // Fall through to next candidate directory
    }
  }
  return null;
}
