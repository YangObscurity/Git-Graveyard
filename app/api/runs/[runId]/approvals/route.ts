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
  params: Promise<{ runId: string }> | { runId: string };
}

const approvalBodySchema = z.object({
  approvalId: z.string().min(1, "approvalId is required"),
  decision: z.enum([
    "approve_once",
    "approve_pattern",
    "deny",
    "deny_and_lay_to_rest",
  ]),
  reason: z.string().optional(),
  inviteCode: z.string().optional(),
  adminToken: z.string().optional(),
});

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  let runId = resolvedParams?.runId;

  if (!runId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/approvals/);
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const parsed = approvalBodySchema.safeParse(rawBody);
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
  };

  // 1. Try orchestrator
  let resolved = false;
  const orchestrator = resolveActiveOrchestrator(request);
  if (orchestrator && typeof orchestrator.resolveApproval === "function") {
    try {
      const res = await orchestrator.resolveApproval(runId, body.approvalId, resolution);
      if (res !== null && res !== undefined) {
        resolved = true;
      }
    } catch {}
  }

  // 2. Try gateway approvalManager
  if (!resolved) {
    try {
      const host = getRuntimeHost();
      if (host?.gateway?.approvalManager && typeof host.gateway.approvalManager.resolveApproval === "function") {
        await host.gateway.approvalManager.resolveApproval(body.approvalId, resolution);
        resolved = true;
      }
    } catch {}
  }

  // 3. Append redacted resolution event
  eventStore.append(
    redactEvent({
      runId,
      kind: "approval.resolved",
      actor: "user",
      data: {
        approvalId: body.approvalId,
        decision: body.decision,
        reason: body.reason,
        resolved,
      },
    }) as any
  );

  return Response.json(
    {
      ok: true,
      runId,
      approvalId: body.approvalId,
      decision: body.decision,
      resolved,
    },
    { status: 200 }
  );
}
