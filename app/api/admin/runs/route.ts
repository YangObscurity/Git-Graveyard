import { resolveEventStore, resolveRunStore, resolveSettingsStore } from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import { hasAdminPublishEvent, isRunRemoved } from "@/lib/history/run-visibility";
import { parseRepoInput } from "@/lib/grimoire/normalize";
import { type RunRecord } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AdminRunListItem {
  runId: string;
  repository: string;
  outcome: string | null;
  phase: string;
  createdAt: number;
  isPublished: boolean;
  isRemoved: boolean;
  reviewed: boolean;
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

/** A run is finished once it reached the `done` phase or recorded a final outcome. */
function isFinishedRun(run: RunRecord): boolean {
  if (run.phase === "done") {
    return true;
  }
  return typeof run.outcome === "string" && run.outcome.trim().length > 0;
}

/**
 * A run counts as reviewed once an `admin.review` event exists for it (or the store row already
 * carries the review marker). Read failures are ignored so a missing events table cannot make a
 * reviewed run look unreviewed.
 */
function isReviewedRun(run: RunRecord, eventStore: EventStore | null, db: unknown): boolean {
  const metadata =
    run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
      ? (run.metadata as Record<string, unknown>)
      : {};
  if (metadata.reviewed === true) {
    return true;
  }
  if (eventStore) {
    try {
      const events = eventStore.getEvents(run.runId, { kind: "admin.review", limit: 1 });
      if (events && events.length > 0) {
        return true;
      }
    } catch {
      // Ignore
    }
  }
  if (db && typeof (db as { prepare?: (s: string) => { get: (id: string) => unknown } }).prepare === "function") {
    try {
      const stmt = (db as { prepare: (s: string) => { get: (id: string) => unknown } }).prepare(
        "SELECT 1 FROM events WHERE runId = ? AND kind = 'admin.review' LIMIT 1"
      );
      const row = stmt.get(run.runId);
      if (row) {
        return true;
      }
    } catch {
      // Table might not exist in db
    }
  }
  return false;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim().length === 0) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

export async function GET(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));

  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
  const db = (runStore as unknown as { db?: unknown }).db;

  const finishedRuns = runStore
    .listRuns()
    .filter((run) => isFinishedRun(run))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  const runs: AdminRunListItem[] = finishedRuns.map((run) => ({
    runId: run.runId,
    repository: formatRepository(run.url),
    outcome: run.outcome ?? null,
    phase: run.phase,
    createdAt: run.createdAt,
    isPublished: hasAdminPublishEvent(run, eventStore, db),
    isRemoved: isRunRemoved(run, eventStore, db),
    reviewed: isReviewedRun(run, eventStore, db),
  }));

  return Response.json({ ok: true, runs });
}