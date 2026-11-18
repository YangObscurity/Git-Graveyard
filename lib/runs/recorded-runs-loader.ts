import * as fs from "node:fs";
import * as path from "node:path";
import type { EventEnvelope, EventInput } from "../events/event-store";
import { EventStore } from "../events/event-store";
import type { RunPhase } from "../events/types";
import { parseRepoInput } from "../grimoire/normalize";
import { redactEvent, redactText, redactValue } from "../security/redactor";
import type { RunOutcome, RunRecord, RunStore } from "./run-store";

const SAFE_RUN_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

const KNOWN_ARTIFACT_FILES = [
  "all.patch",
  "spec.json",
  "report.md",
  "events.ndjson",
  "death-certificate.json",
] as const;

export interface RecordedRunBundleSummary {
  runId: string;
  repository: string;
  url: string;
  sha: string;
  phase: RunPhase;
  outcome: RunOutcome | null;
  isPublished: boolean;
  isRemoved: boolean;
  eventCount: number;
  artifacts: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface SeedRecordedRunsOptions {
  force?: boolean;
  baseDir?: string;
}

export interface SeedRecordedRunsResult {
  skipped: boolean;
  reason?: string;
  seededRunIds: string[];
  alreadySeededRunIds: string[];
}

const seededRunIdsByStore = new WeakMap<object, Set<string>>();

export function isSafeRecordedRunId(runId: string): boolean {
  return (
    typeof runId === "string" &&
    runId.length > 0 &&
    runId !== "." &&
    runId !== ".." &&
    SAFE_RUN_ID_REGEX.test(runId)
  );
}

export function getRecordedRunsRoot(baseDir?: string): string {
  return path.resolve(baseDir ?? path.join(process.cwd(), "output", "recorded-runs"));
}

export function resolveRecordedRunDir(runId: string, baseDir?: string): string | null {
  if (!isSafeRecordedRunId(runId)) {
    return null;
  }
  const rootDir = getRecordedRunsRoot(baseDir);
  const runDir = path.resolve(rootDir, runId);
  if (!runDir.startsWith(rootDir + path.sep)) {
    return null;
  }
  return runDir;
}

export function resolveRecordedArtifactDir(runId: string, baseDir?: string): string | null {
  const runDir = resolveRecordedRunDir(runId, baseDir);
  if (!runDir) {
    return null;
  }
  const artDir = path.resolve(runDir, "artifacts");
  if (!artDir.startsWith(runDir + path.sep)) {
    return null;
  }
  return artDir;
}

function formatRepository(url: string): string {
  try {
    const parsed = parseRepoInput(url);
    if (parsed.ok) {
      return `${parsed.owner}/${parsed.repo}`;
    }
  } catch {
    // fallback below
  }
  return redactText(url);
}

function sanitizeMetadata(rawMeta: unknown): Record<string, unknown> | null {
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    return null;
  }
  const copy = redactValue({ ...(rawMeta as Record<string, unknown>) });
  // Do not carry host-specific directory pointers from recorded bundle metadata
  delete copy.artifactsDir;
  delete copy.runDir;
  return copy;
}

interface ParsedBundle {
  runId: string;
  url: string;
  sha: string;
  phase: RunPhase;
  outcome: RunOutcome | null;
  caps: Record<string, unknown> | null;
  pushTargetFork: string | null;
  pushBranch: string | null;
  pushFlag: boolean;
  isPublished: boolean;
  isRemoved: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  events: EventInput[];
  artifacts: string[];
}

function listAvailableArtifactNames(runDir: string): string[] {
  const found = new Set<string>();
  const artDir = path.resolve(runDir, "artifacts");
  if (fs.existsSync(artDir)) {
    try {
      const entries = fs.readdirSync(artDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && !entry.name.startsWith(".")) {
          found.add(entry.name);
        }
      }
    } catch {
      // ignore unreadable artifacts dir
    }
  }
  for (const name of KNOWN_ARTIFACT_FILES) {
    const direct = path.resolve(runDir, name);
    if (direct.startsWith(runDir + path.sep) && fs.existsSync(direct)) {
      try {
        if (fs.statSync(direct).isFile()) {
          found.add(name);
        }
      } catch {
        // ignore stat errors
      }
    }
  }
  return Array.from(found).sort();
}

function parseEventsNdjson(runId: string, eventsPath: string): EventInput[] {
  let raw = "";
  try {
    raw = fs.readFileSync(eventsPath, "utf8");
  } catch {
    return [];
  }

  const parsed: EventInput[] = [];
  const usedSeqs = new Set<number>();
  let fallbackSeq = 1;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let item: Record<string, unknown>;
    try {
      const json = JSON.parse(trimmed);
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        continue;
      }
      item = json as Record<string, unknown>;
    } catch {
      continue;
    }

    const kind = typeof item.kind === "string" && item.kind.trim() ? item.kind.trim() : null;
    if (!kind) {
      continue;
    }

    const actor =
      typeof item.actor === "string" && item.actor.trim() ? item.actor.trim() : "system";
    const rawSeq =
      typeof item.seq === "number" && Number.isInteger(item.seq) && item.seq > 0
        ? item.seq
        : null;
    let seq = rawSeq ?? fallbackSeq;
    while (usedSeqs.has(seq)) {
      seq += 1;
    }
    usedSeqs.add(seq);
    fallbackSeq = Math.max(fallbackSeq, seq + 1);

    const ts =
      typeof item.ts === "number" && Number.isFinite(item.ts) ? item.ts : Date.now();
    const rawData =
      item.data && typeof item.data === "object" && !Array.isArray(item.data)
        ? (item.data as Record<string, unknown>)
        : {};

    const redacted = redactEvent({
      runId,
      seq,
      ts,
      kind,
      actor,
      data: rawData,
      ...(typeof item.skeletonId === "string" ? { skeletonId: item.skeletonId } : {}),
      ...(typeof item.taskId === "string" ? { taskId: item.taskId } : {}),
      ...(typeof item.attempt === "number" && Number.isFinite(item.attempt)
        ? { attempt: item.attempt }
        : {}),
    });

    const input: EventInput = {
      runId,
      seq,
      ts: typeof redacted.ts === "number" ? redacted.ts : ts,
      kind: String(redacted.kind),
      actor: String(redacted.actor),
      data: (redacted.data as Record<string, unknown>) ?? { refs: [] },
    };
    if (typeof redacted.skeletonId === "string") {
      input.skeletonId = redacted.skeletonId;
    }
    if (typeof redacted.taskId === "string") {
      input.taskId = redacted.taskId;
    }
    if (typeof redacted.attempt === "number") {
      input.attempt = redacted.attempt;
    }
    parsed.push(input);
  }

  parsed.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return parsed;
}

function readBundleFromDir(dirName: string, runDir: string): ParsedBundle | null {
  if (!isSafeRecordedRunId(dirName)) {
    return null;
  }
  const runJsonPath = path.resolve(runDir, "run.json");
  if (!runJsonPath.startsWith(runDir + path.sep) || !fs.existsSync(runJsonPath)) {
    return null;
  }

  const directEventsPath = path.resolve(runDir, "events.ndjson");
  const artEventsPath = path.resolve(runDir, "artifacts", "events.ndjson");
  const eventsPath = fs.existsSync(directEventsPath)
    ? directEventsPath
    : fs.existsSync(artEventsPath)
    ? artEventsPath
    : null;
  if (!eventsPath) {
    return null;
  }

  let rawRun: Record<string, unknown>;
  try {
    const text = fs.readFileSync(runJsonPath, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    rawRun = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const runId =
    typeof rawRun.runId === "string" && isSafeRecordedRunId(rawRun.runId)
      ? rawRun.runId
      : dirName;

  let url =
    typeof rawRun.url === "string" && rawRun.url.trim() ? rawRun.url.trim() : "";
  if (!url && typeof rawRun.repository === "string" && rawRun.repository.trim()) {
    url = `https://github.com/${rawRun.repository.trim()}`;
  }
  if (!url) {
    url = `https://github.com/git-graveyard/${runId}`;
  }
  url = redactText(url);

  const sha =
    typeof rawRun.sha === "string" && rawRun.sha.trim()
      ? redactText(rawRun.sha.trim())
      : "HEAD";

  const phase = (
    typeof rawRun.phase === "string" && rawRun.phase.trim() ? rawRun.phase.trim() : "done"
  ) as RunPhase;
  const outcome =
    typeof rawRun.outcome === "string" && rawRun.outcome.trim()
      ? (rawRun.outcome.trim() as RunOutcome)
      : null;

  const now = Date.now();
  const createdAt =
    typeof rawRun.createdAt === "number" && Number.isFinite(rawRun.createdAt)
      ? rawRun.createdAt
      : now;
  const updatedAt =
    typeof rawRun.updatedAt === "number" && Number.isFinite(rawRun.updatedAt)
      ? rawRun.updatedAt
      : createdAt;
  const startedAt =
    typeof rawRun.startedAt === "number" && Number.isFinite(rawRun.startedAt)
      ? rawRun.startedAt
      : null;
  const endedAt =
    typeof rawRun.endedAt === "number" && Number.isFinite(rawRun.endedAt)
      ? rawRun.endedAt
      : null;

  const events = parseEventsNdjson(runId, eventsPath);
  const hasPublishEvent = events.some((ev) => ev.kind === "admin.publish");
  if (!hasPublishEvent) {
    const maxSeq = events.reduce((max, ev) => Math.max(max, ev.seq ?? 0), 0);
    events.push({
      runId,
      seq: maxSeq + 1,
      ts: endedAt ?? updatedAt,
      kind: "admin.publish",
      actor: "admin",
      data: {
        source: "recorded-run",
        refs: [],
      },
    });
  }

  return {
    runId,
    url,
    sha,
    phase,
    outcome,
    caps:
      rawRun.caps && typeof rawRun.caps === "object" && !Array.isArray(rawRun.caps)
        ? redactValue(rawRun.caps as Record<string, unknown>)
        : null,
    pushTargetFork:
      typeof rawRun.pushTargetFork === "string"
        ? redactText(rawRun.pushTargetFork)
        : null,
    pushBranch:
      typeof rawRun.pushBranch === "string" ? redactText(rawRun.pushBranch) : null,
    pushFlag: Boolean(rawRun.pushFlag),
    isPublished: true,
    isRemoved: Boolean(rawRun.isRemoved),
    metadata: sanitizeMetadata(rawRun.metadata),
    createdAt,
    updatedAt,
    startedAt,
    endedAt,
    events,
    artifacts: listAvailableArtifactNames(runDir),
  };
}

function scanBundlesOnDisk(baseDir?: string): ParsedBundle[] {
  const rootDir = getRecordedRunsRoot(baseDir);
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const bundles: ParsedBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeRecordedRunId(entry.name)) {
      continue;
    }
    const runDir = path.resolve(rootDir, entry.name);
    if (!runDir.startsWith(rootDir + path.sep)) {
      continue;
    }
    const bundle = readBundleFromDir(entry.name, runDir);
    if (bundle) {
      bundles.push(bundle);
    }
  }

  bundles.sort((a, b) => b.createdAt - a.createdAt || a.runId.localeCompare(b.runId));
  return bundles;
}

export function listRecordedRunsOnDisk(options?: {
  baseDir?: string;
}): RecordedRunBundleSummary[] {
  const bundles = scanBundlesOnDisk(options?.baseDir);
  return bundles.map((b) => ({
    runId: b.runId,
    repository: formatRepository(b.url),
    url: b.url,
    sha: b.sha,
    phase: b.phase,
    outcome: b.outcome,
    isPublished: b.isPublished,
    isRemoved: b.isRemoved,
    eventCount: b.events.length,
    artifacts: b.artifacts,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
  }));
}

export function getSeededRecordedRunIds(runStore: object | null | undefined): string[] {
  if (!runStore || typeof runStore !== "object") {
    return [];
  }
  const tracked = seededRunIdsByStore.get(runStore);
  return tracked ? Array.from(tracked).sort() : [];
}

function getOrCreateSeededSet(runStore: object): Set<string> {
  let set = seededRunIdsByStore.get(runStore);
  if (!set) {
    set = new Set<string>();
    seededRunIdsByStore.set(runStore, set);
  }
  return set;
}

function appendEventsToStore(eventStore: EventStore, events: EventInput[]): void {
  if (events.length === 0) {
    return;
  }
  const storeAny = eventStore as unknown as {
    appendRecordedBatch?: (inputs: EventInput[]) => EventEnvelope[];
  };
  if (typeof storeAny.appendRecordedBatch === "function") {
    storeAny.appendRecordedBatch(events);
    return;
  }
  for (const ev of events) {
    eventStore.append(ev);
  }
}

export function seedRecordedRunsIntoStores(
  runStore: RunStore,
  eventStore: EventStore,
  options?: SeedRecordedRunsOptions
): SeedRecordedRunsResult {
  if (process.env.DISABLE_RECORDED_RUNS_SEED === "1") {
    return {
      skipped: true,
      reason: "DISABLE_RECORDED_RUNS_SEED=1",
      seededRunIds: [],
      alreadySeededRunIds: getSeededRecordedRunIds(runStore),
    };
  }

  const storageMode =
    typeof (runStore as unknown as { getStorageMode?: () => string }).getStorageMode ===
    "function"
      ? (runStore as unknown as { getStorageMode: () => string }).getStorageMode()
      : undefined;

  if (!options?.force && storageMode === "memory") {
    return {
      skipped: true,
      reason: "memory_store",
      seededRunIds: [],
      alreadySeededRunIds: getSeededRecordedRunIds(runStore),
    };
  }

  const bundles = scanBundlesOnDisk(options?.baseDir);
  if (bundles.length === 0) {
    return {
      skipped: false,
      seededRunIds: [],
      alreadySeededRunIds: getSeededRecordedRunIds(runStore),
    };
  }

  const seededSet = getOrCreateSeededSet(runStore);
  const seededNow: string[] = [];
  const alreadySeeded: string[] = [];

  for (const bundle of bundles) {
    if (!options?.force && seededSet.has(bundle.runId)) {
      alreadySeeded.push(bundle.runId);
      continue;
    }

    const existing = runStore.getRun(bundle.runId);
    if (existing) {
      seededSet.add(bundle.runId);
      alreadySeeded.push(bundle.runId);
      // If run record existed without events (e.g., separate events.db wiped), populate events safely.
      if (eventStore.countEvents(bundle.runId) === 0 && bundle.events.length > 0) {
        appendEventsToStore(eventStore, bundle.events);
      }
      continue;
    }

    runStore.createRun({
      runId: bundle.runId,
      url: bundle.url,
      sha: bundle.sha,
      phase: bundle.phase,
      outcome: bundle.outcome,
      inviteCodeHash: null,
      caps: bundle.caps,
      pushTargetFork: bundle.pushTargetFork,
      pushBranch: bundle.pushBranch,
      pushFlag: bundle.pushFlag,
      isPublished: true,
      isRemoved: bundle.isRemoved,
      metadata: bundle.metadata,
      createdAt: bundle.createdAt,
      updatedAt: bundle.updatedAt,
      startedAt: bundle.startedAt,
      endedAt: bundle.endedAt,
    });

    if (eventStore.countEvents(bundle.runId) === 0 && bundle.events.length > 0) {
      appendEventsToStore(eventStore, bundle.events);
    }

    seededSet.add(bundle.runId);
    seededNow.push(bundle.runId);
  }

  return {
    skipped: false,
    seededRunIds: seededNow,
    alreadySeededRunIds: alreadySeeded,
  };
}
