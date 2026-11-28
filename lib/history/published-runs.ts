import { type RunRecord, type RunStore } from "@/lib/runs/run-store";
import { EventStore, type EventEnvelope } from "@/lib/events/event-store";
import { parseRepoInput } from "@/lib/grimoire/normalize";
import { hasAdminPublishEvent, isRunRemoved } from "@/lib/history/run-visibility";

export interface SkeletonInfo {
  role: string;
  agentName: string;
  agent: string;
  modelId: string;
  model: string;
  kiroCliVersion: string;
  version: string;
  sessionId: string;
  timestamp: number;
  ts: number;
  skeletonId: string | null;
}

/** One published run as served by `GET /api/history`, optionally with Kiro evidence. */
export interface PublishedRunRecord {
  runId: string;
  url: string;
  repository: string;
  repo: string;
  sha: string;
  phase: string;
  outcome: string | null;
  sandboxId: string | null;
  inviteCodeHash: string | null;
  queuePosition: number | null;
  caps: Record<string, unknown> | null;
  pushTargetFork: string | null;
  pushBranch: string | null;
  pushFlag: boolean;
  isPublished: true;
  isRemoved: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  date: string;
  skeletons?: SkeletonInfo[];
  events?: EventEnvelope[];
}

export interface PublishedRunsOptions {
  /** Maximum number of runs to return; `null`/`undefined` returns every published run. */
  limit?: number | null;
  /** When `"kiro"`, each record carries its Skeleton evidence and source events. */
  fields?: string | null;
}

function formatRepository(url: string): string {
  try {
    const parsed = parseRepoInput(url);
    if (parsed.ok) {
      return `${parsed.owner}/${parsed.repo}`;
    }
  } catch {
    // Fallback
  }
  return url;
}

function extractKiroEvidence(
  run: RunRecord,
  eventStore: EventStore | null
): { skeletons: SkeletonInfo[]; events: EventEnvelope[] } {
  let events: EventEnvelope[] = [];
  if (eventStore) {
    try {
      events = eventStore.getEvents(run.runId, {
        kinds: ["run.started", "skeleton.raised"],
      });
    } catch {
      events = [];
    }
  }

  if (events.length === 0 && run.metadata && Array.isArray(run.metadata.events)) {
    events = run.metadata.events as EventEnvelope[];
  }

  const runStarted = events.find((e) => e.kind === "run.started");
  const runStartedData = (runStarted?.data ?? {}) as Record<string, unknown>;
  const runKiroVersion =
    typeof runStartedData.kiroCliVersion === "string"
      ? runStartedData.kiroCliVersion
      : typeof runStartedData.version === "string"
      ? runStartedData.version
      : typeof runStartedData.kiroVersion === "string"
      ? runStartedData.kiroVersion
      : "";

  const skeletonEvents = events.filter((e) => e.kind === "skeleton.raised");
  const skeletons: SkeletonInfo[] = [];

  for (const ev of skeletonEvents) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const role = String(d.role ?? ev.actor ?? "");
    const agentName = String(d.agentName ?? d.agent ?? "");
    const modelId = String(d.modelId ?? d.model ?? "");
    const sessionId = String(d.sessionId ?? d.session_id ?? "");
    const kiroCliVersion = String(
      d.kiroCliVersion ?? d.version ?? d.kiroVersion ?? runKiroVersion ?? ""
    );
    const ts = typeof ev.ts === "number" ? ev.ts : run.createdAt;

    skeletons.push({
      role,
      agentName,
      agent: agentName,
      modelId,
      model: modelId,
      kiroCliVersion,
      version: kiroCliVersion,
      sessionId,
      timestamp: ts,
      ts,
      skeletonId: ev.skeletonId ?? ev.actor ?? null,
    });
  }

  if (skeletons.length === 0 && run.metadata && Array.isArray(run.metadata.skeletons)) {
    for (const item of run.metadata.skeletons as Array<Record<string, unknown>>) {
      const role = String(item.role ?? "");
      const agentName = String(item.agentName ?? item.agent ?? "");
      const modelId = String(item.modelId ?? item.model ?? "");
      const sessionId = String(item.sessionId ?? item.session_id ?? "");
      const kiroCliVersion = String(item.kiroCliVersion ?? item.version ?? "");
      const ts =
        typeof item.ts === "number"
          ? item.ts
          : typeof item.timestamp === "number"
          ? item.timestamp
          : run.createdAt;
      skeletons.push({
        role,
        agentName,
        agent: agentName,
        modelId,
        model: modelId,
        kiroCliVersion,
        version: kiroCliVersion,
        sessionId,
        timestamp: ts,
        ts,
        skeletonId: typeof item.skeletonId === "string" ? item.skeletonId : null,
      });
    }
  }

  return { skeletons, events };
}

/**
 * Lists the published runs served by `GET /api/history`, newest first, optionally
 * limited and optionally enriched with Kiro Skeleton evidence (`fields=kiro`).
 * This is the single in-process source shared by the route handler and the
 * server-rendered Built with Kiro page, so neither has to fetch over HTTP.
 */
export function listPublishedRuns(
  runStore: RunStore,
  eventStore: EventStore | null,
  options: PublishedRunsOptions = {}
): PublishedRunRecord[] {
  const db = (runStore as unknown as { db?: unknown }).db;

  const allRuns = runStore.listRuns();

  const publishedRuns: RunRecord[] = [];
  for (const run of allRuns) {
    if (hasAdminPublishEvent(run, eventStore, db)) {
      publishedRuns.push(run);
    }
  }

  // Order by createdAt descending (most recent first)
  publishedRuns.sort((a, b) => b.createdAt - a.createdAt);

  let limitedRuns = publishedRuns;
  const limit = options.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
    limitedRuns = publishedRuns.slice(0, limit);
  }

  const isKiro = options.fields === "kiro";

  return limitedRuns.map((run) => {
    const removed = isRunRemoved(run, eventStore, db);
    const repository = formatRepository(run.url);
    const date = new Date(run.createdAt).toISOString();
    const outcome = removed ? "Removed by the owner" : (run.outcome ?? null);

    const baseRecord: PublishedRunRecord = {
      runId: run.runId,
      url: run.url,
      repository,
      repo: repository,
      sha: run.sha,
      phase: run.phase,
      outcome,
      sandboxId: run.sandboxId,
      inviteCodeHash: run.inviteCodeHash,
      queuePosition: run.queuePosition,
      caps: run.caps,
      pushTargetFork: run.pushTargetFork,
      pushBranch: run.pushBranch,
      pushFlag: run.pushFlag,
      isPublished: true,
      isRemoved: removed,
      metadata: run.metadata,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      date,
    };

    if (isKiro) {
      const { skeletons, events } = extractKiroEvidence(run, eventStore);
      return {
        ...baseRecord,
        skeletons,
        events,
      };
    }

    return baseRecord;
  });
}
