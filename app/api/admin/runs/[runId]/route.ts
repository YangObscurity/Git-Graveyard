import { resolveEventStore, resolveRunStore, resolveSettingsStore } from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import { redactEvent } from "@/lib/security/redactor";
import { ALLOWED_REDACTION_FIELDS } from "@/lib/events/event-tap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ runId: string }> | { runId: string };
}

interface RunActionBody {
  action?: unknown;
  reason?: unknown;
  fields?: unknown;
  targetSeqs?: unknown;
  secrets?: unknown;
  patterns?: unknown;
  note?: unknown;
}

// Single source of truth shared with the read path (lib/events/event-tap.ts): a requested field is
// only accepted when it maps to a real scrub rule, so an admin redaction can never name a field the
// read path would be unable to enforce.
const ALLOWED_REDACTION_FIELD_SET = new Set(ALLOWED_REDACTION_FIELDS);

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

/**
 * Validates the caller-supplied redaction field list. Every entry must be a non-empty string field
 * name (never a coerced arbitrary JSON value); anything else is rejected so an object/array/number
 * cannot be silently flattened into `"[object Object]"` and recorded as an audit redaction target.
 */
function parseRedactionFields(
  value: unknown
): { ok: true; fields: string[] } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, fields: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false };
  }
  const fields: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false };
    }
    const name = entry.trim();
    if (name.length === 0) {
      return { ok: false };
    }
    if (!ALLOWED_REDACTION_FIELD_SET.has(name)) {
      return { ok: false };
    }
    fields.push(name);
  }
  return { ok: true, fields };
}

/**
 * Parses an optional list of sequence numbers (e.g. `targetSeqs`) from a redact body. Malformed
 * entries are dropped; a value that is not a list is ignored entirely so the redaction itself still
 * proceeds on the requested fields.
 */
function parseSeqList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seqs: number[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      seqs.push(entry);
    }
  }
  return seqs.length > 0 ? seqs : undefined;
}

/**
 * Parses an optional list of non-empty strings (e.g. `secrets` / `patterns`) from a redact body.
 * Malformed entries are dropped; a value that is not a list is ignored.
 */
function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      items.push(entry);
    }
  }
  return items.length > 0 ? items : undefined;
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
    // The caller decides how to surface a rollback failure; it must not be swallowed so the run row
    // and the audit log can never silently diverge.
    runStore.updateRun(runId, {
      isPublished: priorState.isPublished,
      isRemoved: priorState.isRemoved,
      metadata: priorState.metadata,
    });
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
      try {
        rollback();
      } catch {
        // The rollback itself failed, so the run row may have diverged from the audit log; report
        // that distinctly instead of masking it as an ordinary append failure.
        return Response.json({ ok: false, error: "audit_rollback_failed" }, { status: 500 });
      }
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
      const parsedFields = parseRedactionFields(body.fields);
      if (!parsedFields.ok) {
        return Response.json({ ok: false, error: "invalid_redaction_fields" }, { status: 400 });
      }
      const fields = parsedFields.fields;
      const targetSeqs = parseSeqList(body.targetSeqs);
      const secrets = parseStringList(body.secrets);
      const patterns = parseStringList(body.patterns);
      const updated = runStore.updateRun(runId, {
        metadata: {
          ...metadata,
          reviewed: true,
          reviewedBy: auth.actor.id,
          reviewedAt: Date.now(),
          redactionFields: fields,
        },
      });
      // A single redaction event records the review inline (`reviewed: true`) so a partially-applied
      // pair of appends can never leave the run row and the audit log out of sync. Any optional
      // targetSeqs/secrets/patterns supplied alongside the fields are forwarded so the read path can
      // scope and extend the redaction beyond the logical field map.
      const redactionData: Record<string, unknown> = {
        actor: auth.actor.id,
        reason,
        fields,
        reviewed: true,
      };
      if (targetSeqs) redactionData.targetSeqs = targetSeqs;
      if (secrets) redactionData.secrets = secrets;
      if (patterns) redactionData.patterns = patterns;
      return commit(
        [
          {
            kind: "admin.redaction",
            data: redactionData,
          },
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
