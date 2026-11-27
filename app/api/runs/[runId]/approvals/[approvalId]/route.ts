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

  let resolved = false;
  const orchestrator = resolveActiveOrchestrator(request, context);
  if (orchestrator && typeof orchestrator.resolveApproval === "function") {
    try {
      const res = await orchestrator.resolveApproval(
        runId,
        approvalId,
        resolution
      );
      if (res !== null && res !== undefined) {
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
        if (res !== null && res !== undefined) {
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
