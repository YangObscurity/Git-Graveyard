import * as crypto from "node:crypto";
import { z } from "zod";
import { extractCallerCredentials, matchesRunInviteCode } from "@/lib/pact/pact-mutation";
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

/**
 * Constant-time string comparison over SHA-256 digests: equal-length digests
 * keep `timingSafeEqual` well-defined and leak no information about length or
 * prefix of either token.
 */
function timingSafeTokenEqual(
  provided: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  if (provided.length === 0 || expected.length === 0) {
    return false;
  }
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}


const controlBodySchema = z.object({
  action: z.enum(["pause", "resume", "stop", "kill"]),
  reason: z.string().optional(),
  adminToken: z.string().optional(),
  inviteCode: z.string().optional(),
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
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/control/);
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

  const parsed = controlBodySchema.safeParse(rawBody);
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

  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : null;
  const providedAdminToken =
    request.headers.get("x-admin-token") ??
    request.headers.get("x-admin-key") ??
    body.adminToken ??
    bearer;
  const expectedAdminToken = process.env.ADMIN_TOKEN ?? process.env.ADMIN_KEY;
  const isVerifiedAdmin = Boolean(
    expectedAdminToken && timingSafeTokenEqual(providedAdminToken, expectedAdminToken)
  );

  // Admin token check for kill action
  if (body.action === "kill" && process.env.ADMIN_TOKEN) {
    if (!timingSafeTokenEqual(providedAdminToken, process.env.ADMIN_TOKEN)) {
      return Response.json(
        { ok: false, error: "Admin token required for kill action" },
        { status: 403 }
      );
    }
  }

  // Invite code check for runs protected by an inviteCodeHash (unless verified admin)
  if (!isVerifiedAdmin && run?.inviteCodeHash) {
    const { inviteCode } = extractCallerCredentials(request, body);
    if (!inviteCode) {
      return Response.json(
        {
          ok: false,
          error: "Invite code is required to control this run",
          code: "MISSING_INVITE_CODE",
        },
        { status: 401 }
      );
    }
    if (!matchesRunInviteCode(run, inviteCode, runStore)) {
      return Response.json(
        {
          ok: false,
          error: "Invite code does not match this run owner",
          code: "INVALID_INVITE_CODE",
        },
        { status: 403 }
      );
    }
  }

  const reason =
    body.reason ??
    (body.action === "kill" ? "Admin killed run" : `User ${body.action} action`);

  // Forward to active orchestrator
  const orchestrator = resolveActiveOrchestrator(request);
  if (orchestrator) {
    try {
      if (body.action === "pause" && typeof orchestrator.pauseRun === "function") {
        orchestrator.pauseRun(runId);
      } else if (body.action === "resume" && typeof orchestrator.resumeRun === "function") {
        orchestrator.resumeRun(runId);
      } else if (body.action === "stop" && typeof orchestrator.stopRun === "function") {
        await orchestrator.stopRun(runId, reason);
      } else if (body.action === "kill" && typeof orchestrator.killRun === "function") {
        await orchestrator.killRun(runId, reason);
      }
    } catch {
      // fire safely if not currently active
    }
  }

  // Update stores and append events
  const now = Date.now();
  if (body.action === "pause") {
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.clock",
        actor: "user",
        data: { action: "pause", reason },
      }) as any
    );
  } else if (body.action === "resume") {
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.clock",
        actor: "user",
        data: { action: "resume", reason },
      }) as any
    );
  } else if (body.action === "stop") {
    if (run) {
      runStore.updateRun(runId, {
        phase: "done",
        outcome: "cancelled",
        endedAt: now,
      });
    }
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.done",
        actor: "user",
        data: { phase: "done", outcome: "cancelled", reason },
      }) as any
    );
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: run?.phase ?? "unknown", to: "done", outcome: "cancelled", reason },
      }) as any
    );
  } else if (body.action === "kill") {
    if (run) {
      runStore.updateRun(runId, {
        phase: "done",
        outcome: "killed",
        endedAt: now,
      });
    }
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.done",
        actor: "admin",
        data: { phase: "done", outcome: "killed", reason },
      }) as any
    );
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: run?.phase ?? "unknown", to: "done", outcome: "killed", reason },
      }) as any
    );
  }

  return Response.json(
    {
      ok: true,
      runId,
      action: body.action,
      reason,
    },
    { status: 200 }
  );
}
