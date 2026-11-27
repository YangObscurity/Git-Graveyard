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
  params:
    | Promise<{ runId: string; skeletonId: string }>
    | { runId: string; skeletonId: string };
}

const skeletonActionSchema = z.object({
  action: z.enum([
    "interrupt",
    "re-raise",
    "lay-to-rest",
    "send-instruction",
    "add-review-focus",
    "reraise",
    "lay_to_rest",
    "send_instruction",
    "add_review_focus",
  ]),
  choice: z.enum(["keep_commits", "discard_work"]).optional(),
  instruction: z.string().optional(),
  focus: z.string().optional(),
  delivery: z.string().optional(),
  reason: z.string().optional(),
  inviteCode: z.string().optional(),
  adminToken: z.string().optional(),
});

type CanonicalAction =
  | "interrupt"
  | "reraise"
  | "lay_to_rest"
  | "send_instruction"
  | "add_review_focus";

type RawAction = z.infer<typeof skeletonActionSchema>["action"];

/** Maps R4-10 hyphenated actions and underscore aliases onto one vocabulary. */
function normalizeAction(action: RawAction): CanonicalAction {
  switch (action) {
    case "re-raise":
    case "reraise":
      return "reraise";
    case "lay-to-rest":
    case "lay_to_rest":
      return "lay_to_rest";
    case "send-instruction":
    case "send_instruction":
      return "send_instruction";
    case "add-review-focus":
    case "add_review_focus":
      return "add_review_focus";
    default:
      return "interrupt";
  }
}

const EVENT_KIND: Record<CanonicalAction, string> = {
  interrupt: "skeleton.interrupted",
  reraise: "skeleton.reraised",
  lay_to_rest: "skeleton.laid_to_rest",
  send_instruction: "skeleton.instruction",
  add_review_focus: "warden.focus_added",
};

/**
 * Awaits the first method that exists on `target`, returning whether one ran.
 * A dispatched call that throws or rejects propagates to the caller so the
 * route can answer with an error instead of recording a false success.
 */
async function callFirst(
  target: unknown,
  names: readonly string[],
  ...args: unknown[]
): Promise<boolean> {
  if (!target || typeof target !== "object") return false;
  for (const name of names) {
    const fn = (target as Record<string, unknown>)[name];
    if (typeof fn === "function") {
      await (fn as (...a: unknown[]) => unknown).apply(target, args);
      return true;
    }
  }
  return false;
}

/** Forwards the action to the active dispatcher/warden when one is attached. */
async function forwardToDispatcher(
  handle: { dispatcher?: unknown; warden?: unknown } | undefined,
  action: CanonicalAction,
  skeletonId: string,
  body: z.infer<typeof skeletonActionSchema>
): Promise<void> {
  if (!handle) return;
  const dispatcher = handle.dispatcher;
  switch (action) {
    case "interrupt":
      (await callFirst(dispatcher, ["interruptSkeleton"], skeletonId)) ||
        (await callFirst(dispatcher, ["pause"]));
      break;
    case "reraise":
      (await callFirst(dispatcher, ["resume"])) ||
        (await callFirst(dispatcher, ["reraiseSkeleton"], skeletonId));
      break;
    case "lay_to_rest":
      await callFirst(dispatcher, ["layToRest"], skeletonId, body.choice);
      break;
    case "send_instruction":
      (await callFirst(dispatcher, ["sendInstruction"], skeletonId, body.instruction)) ||
        (await callFirst(dispatcher, ["instruct"], skeletonId, body.instruction));
      break;
    case "add_review_focus":
      (await callFirst(handle.warden, ["addReviewFocus"], skeletonId, body.focus)) ||
        (await callFirst(handle.warden, ["addFocus"], skeletonId, body.focus)) ||
        (await callFirst(dispatcher, ["addReviewFocus"], skeletonId, body.focus));
      break;
  }
}

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
      const match = url.pathname.match(
        /\/api\/runs\/([^/?#]+)\/skeletons\/([^/?#]+)\/actions/
      );
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
  const action = normalizeAction(body.action);

  if (action === "send_instruction" && !body.instruction?.trim()) {
    return Response.json(
      { ok: false, error: "instruction is required for send-instruction" },
      { status: 400 }
    );
  }
  if (action === "add_review_focus" && !body.focus?.trim()) {
    return Response.json(
      { ok: false, error: "focus is required for add-review-focus" },
      { status: 400 }
    );
  }

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

  const orchestrator = resolveActiveOrchestrator(request, context);
  const handle = orchestrator?.getActiveRun?.(runId);
  try {
    await forwardToDispatcher(handle, action, skeletonId, body);
  } catch {
    // A dispatcher that throws or rejects is surfaced as a failure; the run
    // must not record a success audit event for an action that never landed.
    return Response.json(
      { ok: false, error: "Failed to dispatch the skeleton action" },
      { status: 502 }
    );
  }

  const eventKind = EVENT_KIND[action];
  const eventData: Record<string, unknown> = {
    skeletonId,
    action,
    reason: body.reason,
  };
  if (action === "interrupt" || action === "reraise") {
    eventData.choice = body.choice;
  }
  if (action === "lay_to_rest") {
    eventData.choice = body.choice;
  }
  if (action === "send_instruction") {
    eventData.instruction = body.instruction;
    eventData.delivery = body.delivery;
  }
  if (action === "add_review_focus") {
    eventData.focus = body.focus;
  }

  eventStore.append(
    redactEvent({
      runId,
      kind: eventKind,
      actor: "user",
      skeletonId,
      data: eventData,
    }) as never
  );

  return Response.json(
    {
      ok: true,
      runId,
      skeletonId,
      action,
      eventKind,
    },
    { status: 200 }
  );
}

