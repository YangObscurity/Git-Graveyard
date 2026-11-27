import { resolveEventStore, resolveRunStore } from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import { redactEvent } from "@/lib/security/redactor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ runId: string }> | { runId: string };
}

interface RunActionBody {
  action?: unknown;
  reason?: unknown;
  fields?: unknown;
  note?: unknown;
}

async function readBody(request: Request): Promise<RunActionBody> {
  try {
    const parsed = (await request.json()) as RunActionBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const auth = requireAdminAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const resolved = await Promise.resolve(context?.params);
  const runId = resolved?.runId;
  if (!runId || typeof runId !== "string") {
    return Response.json({ ok: false, error: "runId_required" }, { status: 400 });
  }

  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
  const run = runStore.getRun(runId);
  if (!run) {
    return Response.json({ ok: false, error: "run_not_found" }, { status: 404 });
  }

  const body = await readBody(request);
  const action = typeof body.action === "string" ? body.action : "";
  const reason = typeof body.reason === "string" ? body.reason : null;
  const metadata = toMetadata(run.metadata);
  const priorEvents = eventStore.getEvents(runId, {
    kinds: ["admin.review", "admin.redaction"],
  });
  const alreadyReviewed = metadata.reviewed === true || priorEvents.length > 0;

  const appendAdmin = (kind: string, data: Record<string, unknown>): void => {
    eventStore.append(
      redactEvent({
        runId,
        kind,
        actor: auth.actor.id,
        data: { refs: [], ...data },
      })
    );
  };

  switch (action) {
    case "review": {
      const updated = runStore.updateRun(runId, {
        metadata: {
          ...metadata,
          reviewed: true,
          reviewedBy: auth.actor.id,
          reviewedAt: Date.now(),
        },
      });
      appendAdmin("admin.review", { actor: auth.actor.id, reason });
      return Response.json({ ok: true, action, run: updated });
    }
    case "redact": {
      const fields = Array.isArray(body.fields) ? body.fields.map((f) => String(f)) : [];
      const updated = runStore.updateRun(runId, {
        metadata: {
          ...metadata,
          reviewed: true,
          reviewedBy: auth.actor.id,
          reviewedAt: Date.now(),
          redactionFields: fields,
        },
      });
      appendAdmin("admin.redaction", { actor: auth.actor.id, reason, fields });
      return Response.json({ ok: true, action, run: updated });
    }
    case "publish": {
      if (!alreadyReviewed) {
        return Response.json(
          { ok: false, error: "review_required_before_publish" },
          { status: 409 }
        );
      }
      const updated = runStore.updateRun(runId, { isPublished: true });
      appendAdmin("admin.publish", { actor: auth.actor.id, reason });
      return Response.json({ ok: true, action, run: updated });
    }
    case "hide": {
      const marker = "Removed by the owner";
      const updated = runStore.updateRun(runId, {
        isRemoved: true,
        metadata: {
          ...metadata,
          removalReason: marker,
          removalMarker: marker,
          removedBy: auth.actor.id,
          removedAt: Date.now(),
        },
      });
      appendAdmin("admin.hide", { actor: auth.actor.id, reason, marker });
      return Response.json({ ok: true, action, run: updated, marker });
    }
    default:
      return Response.json({ ok: false, error: "unknown_action" }, { status: 400 });
  }
}
