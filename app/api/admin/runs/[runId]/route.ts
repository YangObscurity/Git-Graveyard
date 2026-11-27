import { resolveEventStore, resolveRunStore, resolveSettingsStore } from "@/lib/runtime/store-context";
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
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
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

  // Snapshot the mutable run fields so an audit-append failure can be rolled back; the run row and
  // the audit log must never diverge (a persisted change with no matching admin.* event).
  const priorState = {
    isPublished: run.isPublished,
    isRemoved: run.isRemoved,
    metadata: run.metadata,
  };
  const rollback = (): void => {
    try {
      runStore.updateRun(runId, {
        isPublished: priorState.isPublished,
        isRemoved: priorState.isRemoved,
        metadata: priorState.metadata,
      });
    } catch {
      // Best effort: the response already reports the failure.
    }
  };
  const commit = (
    events: Array<{ kind: string; data: Record<string, unknown> }>,
    success: () => Response
  ): Response => {
    try {
      for (const event of events) {
        appendAdmin(event.kind, event.data);
      }
    } catch {
      rollback();
      return Response.json({ ok: false, error: "audit_append_failed" }, { status: 500 });
    }
    return success();
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
      return commit([{ kind: "admin.review", data: { actor: auth.actor.id, reason } }], () =>
        Response.json({ ok: true, action, run: updated })
      );
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
      // Redaction marks the run reviewed, so record the matching review audit entry too.
      return commit(
        [
          { kind: "admin.review", data: { actor: auth.actor.id, reason } },
          { kind: "admin.redaction", data: { actor: auth.actor.id, reason, fields } },
        ],
        () => Response.json({ ok: true, action, run: updated })
      );
    }
    case "publish": {
      if (!alreadyReviewed) {
        return Response.json(
          { ok: false, error: "review_required_before_publish" },
          { status: 409 }
        );
      }
      const updated = runStore.updateRun(runId, { isPublished: true });
      return commit([{ kind: "admin.publish", data: { actor: auth.actor.id, reason } }], () =>
        Response.json({ ok: true, action, run: updated })
      );
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
      return commit([{ kind: "admin.hide", data: { actor: auth.actor.id, reason, marker } }], () =>
        Response.json({ ok: true, action, run: updated, marker })
      );
    }
    default:
      return Response.json({ ok: false, error: "unknown_action" }, { status: 400 });
  }
}
