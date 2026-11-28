import { type RunRecord } from "@/lib/runs/run-store";
import { EventStore, type EventEnvelope } from "@/lib/events/event-store";
import { parseRepoInput } from "@/lib/grimoire/normalize";
import { resolveEventStore, resolveRunStore } from "@/lib/runtime/store-context";
import { hasAdminPublishEvent, isRunRemoved } from "@/lib/history/run-visibility";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

interface SkeletonInfo {
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

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
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
  const limitParam = searchParams.get("limit");
  if (limitParam !== null && limitParam.trim().length > 0) {
    const parsedLimit = parseInt(limitParam.trim(), 10);
    if (!Number.isNaN(parsedLimit) && parsedLimit >= 0) {
      limitedRuns = publishedRuns.slice(0, parsedLimit);
    }
  }

  const isKiro = searchParams.get("fields") === "kiro";

  const result = limitedRuns.map((run) => {
    const removed = isRunRemoved(run, eventStore, db);
    const repository = formatRepository(run.url);
    const date = new Date(run.createdAt).toISOString();
    const outcome = removed ? "Removed by the owner" : (run.outcome ?? null);

    const baseRecord = {
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

  return Response.json(result, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
