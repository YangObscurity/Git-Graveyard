import { z } from "zod";
import { authorizeMutatingRunRequest } from "@/lib/pact/pact-mutation";
import { getRuntimeHost } from "@/lib/runtime/runtime-host";
import {
  isSafeRunId,
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
} from "@/lib/runtime/store-context";
import { redactEvent } from "@/lib/security/redactor";
import type { EventStore } from "@/lib/events/event-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params:
    | Promise<{ runId: string; approvalId: string }>
    | { runId: string; approvalId: string };
}

const resolutionBodySchema = z.object({
  decision: z.enum([
    "approve_once",
    "approve_pattern",
    "deny",
    "deny_and_lay_to_rest",
  ]),
  scope: z.string().optional(),
  pattern: z.string().optional(),
  reason: z.string().optional(),
  inviteCode: z.string().optional(),
  adminToken: z.string().optional(),
});

/** True for a non-empty path segment that cannot escape its single URL slot. */
function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("-")) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("..")) return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  return true;
}

type ApprovalOwnership = "ok" | "mismatch" | "unknown";

/** Reads an approval record from any accessor an approval manager exposes. */
function readApprovalRecord(
  manager: unknown,
  approvalId: string
): { runId?: unknown } | undefined {
  if (!manager || typeof manager !== "object") return undefined;
  const accessors = ["getApproval", "getApprovalRecord"] as const;
  for (const name of accessors) {
    const fn = (manager as Record<string, unknown>)[name] as
      | ((id: string) => unknown)
      | undefined;
    if (typeof fn !== "function") continue;
    try {
      const record = fn.call(manager, approvalId);
      if (record && typeof record === "object") {
        return record as { runId?: unknown };
      }
    } catch {
      // A throwing accessor means the manager cannot vouch for the request.
    }
  }
  return undefined;
}

/** Approval managers reachable from the active orchestrator or runtime host. */
function collectApprovalManagers(orchestrator: unknown): unknown[] {
  const managers: unknown[] = [];
  const orch = orchestrator as
    | {
        approvalManager?: unknown;
        host?: { gateway?: { approvalManager?: unknown } };
      }
    | null
    | undefined;
  if (orch?.approvalManager) managers.push(orch.approvalManager);
  const hostManager = orch?.host?.gateway?.approvalManager;
  if (hostManager) managers.push(hostManager);
  try {
    const gatewayManager = getRuntimeHost()?.gateway?.approvalManager;
    if (gatewayManager && gatewayManager !== hostManager) {
      managers.push(gatewayManager);
    }
  } catch {
    // No runtime host configured; ownership falls back to the event log.
  }
  return managers;
}

/**
 * Verifies that an approval belongs to the run in the URL before it is resolved.
 * A manager record or this run's own `approval.requested` events prove
 * ownership; a record or request event bound to another run is a mismatch, so a
 * cross-run approval fails closed before any resolver is invoked.
 */
function verifyApprovalOwnership(
  orchestrator: unknown,
  eventStore: EventStore,
  runId: string,
  approvalId: string
): ApprovalOwnership {
  for (const manager of collectApprovalManagers(orchestrator)) {
    const record = readApprovalRecord(manager, approvalId);
    if (record && typeof record.runId === "string") {
      return record.runId === runId ? "ok" : "mismatch";
    }
  }

  const owns = (owner: string): boolean => {
    try {
      const events = eventStore.getEvents(owner, { kind: "approval.requested" });
      return events.some(
        (event) =>
          (event.data as Record<string, unknown> | undefined)?.approvalId ===
          approvalId
      );
    } catch {
      return false;
    }
  };

  if (owns(runId)) return "ok";

  try {
    const runIds =
      typeof eventStore.getRunIds === "function" ? eventStore.getRunIds() : [];
    for (const other of runIds) {
      if (other === runId) continue;
      if (owns(other)) return "mismatch";
    }
  } catch {
    // An unreadable run index means ownership cannot be disproven.
  }

  return "unknown";
}

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  let runId = resolvedParams?.runId;
  let approvalId = resolvedParams?.approvalId;

  if (!runId || !approvalId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(
        /\/api\/runs\/([^/?#]+)\/approvals\/([^/?#]+)/
      );
      if (match) {
        runId = decodeURIComponent(match[1]);
        approvalId = decodeURIComponent(match[2]);
      }
    } catch {}
  }

  if (!isSafeRunId(runId) || !isSafePathSegment(approvalId)) {
    return Response.json(
      { ok: false, error: "Invalid runId or approvalId" },
      { status: 400 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const parsed = resolutionBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "Validation error", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const body = parsed.data;
  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);

  const run = runStore.getRun(runId);
  const events = eventStore.getEvents(runId, { limit: 1 });

  if (!run && events.length === 0) {
    return Response.json(
      { ok: false, error: "Run not found" },
      { status: 404 }
    );
  }

  const authError = authorizeMutatingRunRequest(
    run,
    request,
    rawBody as Record<string, unknown>,
    runStore,
    "resolve approvals for this run"
  );
  if (authError) {
    return authError;
  }

  const resolution = {
    decision: body.decision,
    reason: body.reason,
    scope: body.scope,
    pattern: body.pattern,
  };

  const orchestrator = resolveActiveOrchestrator(request, context);

  // Ownership is proven before any resolver runs: an approval bound to another
  // run fails closed here rather than being resolved against this run, and an
  // approval whose ownership cannot be positively established fails closed too.
  const ownership = verifyApprovalOwnership(
    orchestrator,
    eventStore,
    runId,
    approvalId
  );
  if (ownership === "mismatch") {
    return Response.json(
      {
        ok: false,
        error: "Approval does not belong to this run",
        code: "APPROVAL_RUN_MISMATCH",
      },
      { status: 403 }
    );
  }
  if (ownership !== "ok") {
    return Response.json(
      {
        ok: false,
        error: "Approval ownership could not be verified for this run",
        code: "APPROVAL_NOT_OWNED",
      },
      { status: 403 }
    );
  }

  let resolved = false;
  if (orchestrator && typeof orchestrator.resolveApproval === "function") {
    try {
      const res = await orchestrator.resolveApproval(
        runId,
        approvalId,
        resolution
      );
      // Truthiness, not null/undefined: a resolver that explicitly returns
      // `false` (or any falsy value) refused the approval, so it must not be
      // recorded as resolved nor widen the run's approved patterns.
      if (res) {
        resolved = true;
      }
    } catch {}
  }

  if (!resolved) {
    try {
      const host = getRuntimeHost();
      const approvalManager = host?.gateway?.approvalManager;
      if (
        approvalManager &&
        typeof approvalManager.resolveApproval === "function"
      ) {
        // Scope the fallback to this run: when the manager exposes its record,
        // reject an approval bound to a different run before resolving.
        const getApproval = (
          approvalManager as unknown as {
            getApproval?: (id: string) => { runId?: unknown } | undefined;
          }
        ).getApproval;
        if (typeof getApproval === "function") {
          const existing = getApproval.call(approvalManager, approvalId);
          if (
            existing &&
            typeof existing.runId === "string" &&
            existing.runId !== runId
          ) {
            return Response.json(
              {
                ok: false,
                error: "Approval does not belong to this run",
                code: "APPROVAL_RUN_MISMATCH",
              },
              { status: 403 }
            );
          }
        }

        const res = await approvalManager.resolveApproval(approvalId, {
          ...resolution,
          runId,
        });
        // A falsy resolver result (including `false`) is a refusal.
        if (res) {
          resolved = true;
        }
      }
    } catch (err) {
      // The manager's own run binding is authoritative: a mismatch is
      // fail-closed rather than silently recorded against this run.
      if (err instanceof Error && /runId mismatch/i.test(err.message)) {
        return Response.json(
          {
            ok: false,
            error: "Approval does not belong to this run",
            code: "APPROVAL_RUN_MISMATCH",
          },
          { status: 403 }
        );
      }
    }
  }

  // Persist an approved command pattern only when the approval actually
  // resolved; a failed resolution must never widen what the run may execute.
  if (resolved && body.decision === "approve_pattern") {
    const patternValue = (body.pattern ?? body.scope)?.trim();
    if (patternValue && typeof runStore.addApprovedPattern === "function") {
      try {
        runStore.addApprovedPattern(runId, patternValue);
      } catch {}
    }
  }

  try {
    eventStore.append(
      redactEvent({
        runId,
        kind: "approval.resolved",
        actor: "user",
        data: {
          approvalId,
          decision: body.decision,
          scope: body.scope,
          pattern: body.pattern,
          reason: body.reason,
          resolved,
        },
      }) as never
    );
  } catch {
    return Response.json(
      {
        ok: false,
        // The audit failure must not overstate the outcome: only claim the
        // approval was resolved when a resolver actually accepted it.
        error: resolved
          ? "The approval was resolved but its audit event could not be recorded"
          : "The approval was not resolved and its audit event could not be recorded",
        code: "APPROVAL_AUDIT_FAILED",
        runId,
        approvalId,
        decision: body.decision,
        resolved,
      },
      { status: 500 }
    );
  }

  // No resolver accepted the approval: this is a conflict, not a success. The
  // caller must not interpret a 200 as the approval having been resolved.
  if (!resolved) {
    return Response.json(
      {
        ok: false,
        error: "Approval could not be resolved",
        runId,
        approvalId,
        decision: body.decision,
        resolved: false,
      },
      { status: 409 }
    );
  }

  return Response.json(
    {
      ok: true,
      runId,
      approvalId,
      decision: body.decision,
      resolved,
    },
    { status: 200 }
  );
}
