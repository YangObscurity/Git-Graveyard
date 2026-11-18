import { z } from "zod";
import { authorizeMutatingRunRequest } from "@/lib/pact/pact-mutation";
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
  params: Promise<{ runId: string; skeletonId: string }> | { runId: string; skeletonId: string };
}

const skeletonActionSchema = z.object({
  action: z.enum([
    "interrupt",
    "reraise",
    "lay_to_rest",
    "send_instruction",
    "add_review_focus",
  ]),
  choice: z.string().optional(),
  instruction: z.string().optional(),
  focus: z.string().optional(),
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
  let skeletonId = resolvedParams?.skeletonId;

  if (!runId || !skeletonId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/skeletons\/([^/?#]+)/);
      if (match) {
        runId = decodeURIComponent(match[1]);
        skeletonId = decodeURIComponent(match[2]);
      }
    } catch {}
  }

  if (!isSafeRunId(runId) || !isSafeRunId(skeletonId)) {
    return Response.json(
      { ok: false, error: "Invalid runId or skeletonId" },
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

  const parsed = skeletonActionSchema.safeParse(rawBody);
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
    "control skeletons in this run"
  );
  if (authError) {
    return authError;
  }

  // Forward to active orchestrator / dispatcher / supervisor
  const orchestrator = resolveActiveOrchestrator(request);
  const handle = orchestrator?.getActiveRun?.(runId);
  if (handle) {
    try {
      if (body.action === "interrupt") {
        if (handle.dispatcher && typeof handle.dispatcher.interruptSkeleton === "function") {
          handle.dispatcher.interruptSkeleton(skeletonId);
        } else if (handle.dispatcher && typeof handle.dispatcher.pause === "function") {
          handle.dispatcher.pause();
        }
      } else if (body.action === "lay_to_rest") {
        if (handle.dispatcher && typeof handle.dispatcher.layToRest === "function") {
          handle.dispatcher.layToRest(skeletonId);
        }
      } else if (body.action === "reraise") {
        if (handle.dispatcher && typeof handle.dispatcher.resume === "function") {
          handle.dispatcher.resume();
        }
      }
    } catch {}
  }

  // Map to event kind and payload
  let eventKind: string;
  let eventData: Record<string, unknown>;

  switch (body.action) {
    case "interrupt":
      eventKind = "skeleton.interrupted";
      eventData = {
        skeletonId,
        reason: body.reason,
        choice: body.choice,
      };
      break;
    case "reraise":
      eventKind = "skeleton.reraised";
      eventData = {
        skeletonId,
        reason: body.reason,
        choice: body.choice,
      };
      break;
    case "lay_to_rest":
      eventKind = "skeleton.laid_to_rest";
      eventData = {
        skeletonId,
        reason: body.reason,
      };
      break;
    case "send_instruction":
      eventKind = "skeleton.instruction";
      eventData = {
        skeletonId,
        instruction: body.instruction,
      };
      break;
    case "add_review_focus":
      eventKind = "warden.focus_added";
      eventData = {
        skeletonId,
        focus: body.focus,
      };
      break;
  }

  eventStore.append(
    redactEvent({
      runId,
      kind: eventKind,
      actor: "user",
      skeletonId,
      data: eventData,
    }) as any
  );

  return Response.json(
    {
      ok: true,
      runId,
      skeletonId,
      action: body.action,
    },
    { status: 200 }
  );
}
