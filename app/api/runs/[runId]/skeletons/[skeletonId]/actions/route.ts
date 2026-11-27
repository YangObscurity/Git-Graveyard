import { z } from "zod";
import { authorizeMutatingRunRequest } from "@/lib/pact/pact-mutation";
import {
  isSafeRunId,
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
} from "@/lib/runtime/store-context";
import { redactEvent } from "@/lib/security/redactor";
import type { EventEnvelope, EventStore } from "@/lib/events/event-store";

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

/** Outcome of forwarding one action to the active dispatcher/warden. */
interface DispatchOutcome {
  dispatched: boolean;
  hadActiveHandle: boolean;
}

const SKELETON_EVENT_KINDS: readonly string[] = [
  "skeleton.raised",
  "skeleton.state",
  "skeleton.interrupted",
  "skeleton.reraised",
  "skeleton.laid_to_rest",
  "skeleton.instruction",
  "skeleton.tool_call",
  "skeleton.tool_result",
  "skeleton.log",
  "skeleton.usage",
];

/** True when an event names this Skeleton at either the envelope or data level. */
function eventNamesSkeleton(event: EventEnvelope, skeletonId: string): boolean {
  if (event.skeletonId === skeletonId) return true;
  const data = event.data as Record<string, unknown> | undefined;
  return data?.skeletonId === skeletonId;
}

/** True when this run's own log already attributes the Skeleton to it. */
function skeletonOwnedByRun(
  eventStore: EventStore,
  runId: string,
  skeletonId: string
): boolean {
  try {
    const events = eventStore.getEvents(runId, {
      kind: [...SKELETON_EVENT_KINDS],
    });
    return events.some((event) => eventNamesSkeleton(event, skeletonId));
  } catch {
    return false;
  }
}

/** True when another run's log attributes the Skeleton to that other run. */
function skeletonOwnedByAnotherRun(
  eventStore: EventStore,
  runId: string,
  skeletonId: string
): boolean {
  try {
    const runIds =
      typeof eventStore.getRunIds === "function" ? eventStore.getRunIds() : [];
    for (const other of runIds) {
      if (other === runId) continue;
      const events = eventStore.getEvents(other, {
        kind: [...SKELETON_EVENT_KINDS],
      });
      if (events.some((event) => eventNamesSkeleton(event, skeletonId))) {
        return true;
      }
    }
  } catch {
    // An unreadable run index means ownership cannot be disproven.
  }
  return false;
}

/** Best-effort positive check of an active handle's exposed Skeleton state. */
function handleKnowsSkeleton(handle: unknown, skeletonId: string): boolean {
  if (!handle || typeof handle !== "object") return false;
  const source = handle as Record<string, unknown>;
  const dispatcher = source.dispatcher as Record<string, unknown> | undefined;
  const scheduler = source.scheduler as Record<string, unknown> | undefined;
  const containers = [
    source.skeletons,
    source.tasks,
    dispatcher?.skeletons,
    dispatcher?.tasks,
    scheduler?.skeletons,
  ];
  for (const container of containers) {
    if (container instanceof Map && container.has(skeletonId)) return true;
    if (container instanceof Set && container.has(skeletonId)) return true;
    if (Array.isArray(container)) {
      const found = container.some((entry) => {
        if (entry === skeletonId) return true;
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Record<string, unknown>;
        return record.id === skeletonId || record.skeletonId === skeletonId;
      });
      if (found) return true;
    }
    if (container && typeof container === "object" && !Array.isArray(container)) {
      if (Object.prototype.hasOwnProperty.call(container, skeletonId)) {
        return true;
      }
    }
  }
  return false;
}

type SkeletonOwnership = "ok" | "mismatch" | "unknown";

/**
 * Verifies that a Skeleton belongs to the run in the URL. An active handle's
 * own Skeleton state or this run's `skeleton.*` events prove ownership; the same
 * Skeleton appearing under a different run's log is a cross-run mismatch.
 */
function verifySkeletonOwnership(
  eventStore: EventStore,
  runId: string,
  skeletonId: string,
  handle: unknown
): SkeletonOwnership {
  if (handleKnowsSkeleton(handle, skeletonId)) return "ok";
  if (skeletonOwnedByRun(eventStore, runId, skeletonId)) return "ok";
  if (skeletonOwnedByAnotherRun(eventStore, runId, skeletonId)) return "mismatch";
  return "unknown";
}

/**
 * Forwards the action to the active dispatcher/warden. Only Skeleton-scoped
 * methods are ever invoked: a per-Skeleton interrupt or re-raise must never
 * cascade into a global pause/resume of the whole run. A dispatched call that
 * throws or rejects propagates to the caller so the route can answer with an
 * error instead of recording a false success.
 */
async function forwardToDispatcher(
  handle: { dispatcher?: unknown; warden?: unknown } | undefined,
  action: CanonicalAction,
  skeletonId: string,
  body: z.infer<typeof skeletonActionSchema>
): Promise<DispatchOutcome> {
  if (!handle) return { dispatched: false, hadActiveHandle: false };
  const dispatcher = handle.dispatcher;
  let dispatched = false;
  switch (action) {
    case "interrupt":
      dispatched = await callFirst(dispatcher, ["interruptSkeleton"], skeletonId);
      break;
    case "reraise":
      dispatched = await callFirst(dispatcher, ["reraiseSkeleton"], skeletonId);
      break;
    case "lay_to_rest":
      dispatched = await callFirst(dispatcher, ["layToRest"], skeletonId, body.choice);
      break;
    case "send_instruction":
      dispatched =
        (await callFirst(dispatcher, ["sendInstruction"], skeletonId, body.instruction)) ||
        (await callFirst(dispatcher, ["instruct"], skeletonId, body.instruction));
      break;
    case "add_review_focus":
      dispatched =
        (await callFirst(handle.warden, ["addReviewFocus"], skeletonId, body.focus)) ||
        (await callFirst(handle.warden, ["addFocus"], skeletonId, body.focus)) ||
        (await callFirst(dispatcher, ["addReviewFocus"], skeletonId, body.focus));
      break;
  }
  return { dispatched, hadActiveHandle: true };
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

  // Ownership: a Skeleton raised by one run may only be controlled through that
  // run. A Skeleton known to belong to a different run fails closed.
  const ownership = verifySkeletonOwnership(eventStore, runId, skeletonId, handle);
  if (ownership === "mismatch") {
    return Response.json(
      {
        ok: false,
        error: "Skeleton does not belong to this run",
        code: "SKELETON_RUN_MISMATCH",
      },
      { status: 403 }
    );
  }

  let outcome: DispatchOutcome;
  try {
    outcome = await forwardToDispatcher(handle, action, skeletonId, body);
  } catch {
    // A dispatcher that throws or rejects is surfaced as a failure; the run
    // must not record a success audit event for an action that never landed.
    return Response.json(
      { ok: false, error: "Failed to dispatch the skeleton action" },
      { status: 502 }
    );
  }

  // An attached dispatcher that never accepted the action means it did not
  // land: fail closed rather than recording a false success event.
  if (outcome.hadActiveHandle && !outcome.dispatched) {
    return Response.json(
      {
        ok: false,
        error: "The active dispatcher did not accept this skeleton action",
        code: "SKELETON_ACTION_NOT_DISPATCHED",
      },
      { status: 409 }
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

