import * as fs from "node:fs";
import { type RunRecord } from "@/lib/runs/run-store";
import { type EventEnvelope } from "@/lib/events/event-store";
import {
  findRunArtifactOnDisk,
  isSafeRunId,
  resolveEventStore,
  resolveRunStore,
} from "@/lib/runtime/store-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ runId: string }> | { runId: string };
}

const ARTIFACT_DEFINITIONS = [
  { id: "patch", name: "all.patch", fileName: "all.patch", kind: "patch" },
  { id: "spec", name: "spec bundle", fileName: "spec.json", kind: "spec" },
  { id: "report", name: "report", fileName: "report.md", kind: "report" },
  { id: "events", name: "events.ndjson", fileName: "events.ndjson", kind: "events" },
  { id: "certificate", name: "Death_Certificate", fileName: "death-certificate.json", kind: "certificate" },
];

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  let runId = resolvedParams?.runId;

  if (!runId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)/);
      if (match) {
        runId = decodeURIComponent(match[1]);
      }
    } catch {}
  }

  if (!isSafeRunId(runId)) {
    return Response.json(
      { ok: false, error: "Invalid or missing runId" },
      { status: 400 }
    );
  }

  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);

  const run: RunRecord | null = runStore.getRun(runId) ?? null;
  const events: EventEnvelope[] = eventStore.getEvents(runId);

  if (!run && events.length === 0) {
    return Response.json(
      { ok: false, error: "Run not found" },
      { status: 404 }
    );
  }

  // Derive phase and outcome
  let phase: string = run?.phase ?? "done";
  let outcome: string | null = run?.outcome ?? null;
  let isHidden = Boolean(run?.isRemoved);
  let reportCheck: { passed: boolean; failed?: boolean; reading?: string | null } | null = null;

  // Process events
  const tasksMap = new Map<
    string,
    {
      id: string;
      title?: string;
      state: string;
      attempts: number;
      verdict?: string;
      reasons?: string[];
    }
  >();

  // Prepopulate from metadata.pactTasks if available
  if (run?.metadata && Array.isArray((run.metadata as any).pactTasks)) {
    for (const pt of (run.metadata as any).pactTasks) {
      if (pt && typeof pt.id === "string") {
        tasksMap.set(pt.id, {
          id: pt.id,
          title: pt.title,
          state: "pending",
          attempts: 0,
        });
      }
    }
  }

  for (const ev of events) {
    if (ev.kind === "admin.hide") {
      isHidden = true;
    }
    if (ev.kind === "run.phase") {
      const ph = (ev.data as Record<string, unknown>)?.phase ?? (ev.data as Record<string, unknown>)?.to;
      if (typeof ph === "string") {
        phase = ph;
      }
    }
    if (ev.kind === "run.done") {
      const oc = (ev.data as Record<string, unknown>)?.outcome;
      if (typeof oc === "string") {
        outcome = oc;
      }
      phase = "done";
    }
    if (ev.kind === "task.state") {
      const tid = ev.taskId || String(ev.data?.taskId || `task-${tasksMap.size + 1}`);
      const st = String(ev.data?.state || "pending");
      const existing = tasksMap.get(tid);
      if (existing) {
        existing.state = st;
        if (typeof ev.attempt === "number") existing.attempts = ev.attempt;
        if (typeof ev.data?.title === "string") existing.title = ev.data.title;
      } else {
        tasksMap.set(tid, {
          id: tid,
          title: typeof ev.data?.title === "string" ? ev.data.title : undefined,
          state: st,
          attempts: typeof ev.attempt === "number" ? ev.attempt : 1,
        });
      }
    }
    if (ev.kind === "verdict") {
      const tid = String(ev.data?.target || ev.data?.taskId || ev.taskId || "");
      if (tid && tasksMap.has(tid)) {
        const item = tasksMap.get(tid)!;
        item.verdict = String(ev.data?.verdict || "");
        if (Array.isArray(ev.data?.reasons)) {
          item.reasons = ev.data.reasons as string[];
        }
      }
    }
    if (ev.kind === "report.checked") {
      const ok = Boolean(ev.data?.ok || ev.data?.passed);
      reportCheck = {
        passed: ok,
        failed: !ok,
        reading: ok ? (typeof ev.data?.reading === "string" ? ev.data.reading : null) : null,
      };
    }
  }

  const tasks = Array.from(tasksMap.values());
  const noTasksMerged = !tasks.some((t) => t.state === "merged");

  // Push info
  const push = {
    enabled: Boolean(run?.pushFlag),
    targetFork: run?.pushTargetFork ?? undefined,
    branch: run?.pushBranch ?? undefined,
  };

  // Locate artifacts on disk
  let diff: string | null = null;
  const artifacts = ARTIFACT_DEFINITIONS.map((def) => {
    const found = findRunArtifactOnDisk(runId, def.fileName, run);
    const downloadUrl = `/runs/${runId}/relic/download?artifact=${def.id}`;
    if (found) {
      if (def.fileName === "all.patch") {
        try {
          diff = fs.readFileSync(found.filePath, "utf8");
        } catch {}
      }
      return {
        id: def.id,
        name: def.name,
        fileName: def.fileName,
        kind: def.kind,
        size: found.size,
        sha256: found.sha256,
        downloadUrl,
      };
    } else {
      return {
        id: def.id,
        name: def.name,
        fileName: def.fileName,
        kind: def.kind,
        missing: true,
        downloadUrl,
      };
    }
  });

  if (diff === null && run?.metadata && typeof (run.metadata as any).diff === "string") {
    diff = (run.metadata as any).diff;
  }

  const beforeAfterRows = (run?.metadata && Array.isArray((run.metadata as any).beforeAfterRows))
    ? (run.metadata as any).beforeAfterRows
    : [];

  return Response.json(
    {
      ok: true,
      run,
      runId,
      phase,
      outcome,
      hidden: isHidden,
      push,
      reportCheck,
      beforeAfterRows,
      diff,
      tasks,
      artifacts,
      noTasksMerged,
    },
    { status: 200 }
  );
}
