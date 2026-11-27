import { z } from "zod";
import { authorizeMutatingRunRequest } from "@/lib/pact/pact-mutation";
import {
  MessageError,
  MessageService,
  type MessageEventSink,
  type MessageRecord,
} from "@/lib/messaging/message-service";
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
  params: Promise<{ runId: string }> | { runId: string };
}

const RECIPIENT_ROLES = [
  "necromancer",
  "planner",
  "exhumer",
  "bonesetter",
  "soul-stitcher",
  "warden",
  "scribe",
] as const;

const messageBodySchema = z.object({
  to: z.string().min(1, "to is required"),
  intent: z.string().min(1, "intent is required"),
  text: z.string().optional(),
  delivery: z.enum(["after_command", "interrupt_now"]).optional(),
  recipientRole: z.enum(RECIPIENT_ROLES).optional(),
  refs: z.array(z.string()).optional(),
  skeletonId: z.string().optional(),
  inviteCode: z.string().optional(),
  adminToken: z.string().optional(),
});

/** Status code for a refused message: hard blocks and forbidden targets are 403. */
function statusForMessageError(err: MessageError): number {
  switch (err.code) {
    case "HARD_BLOCK":
    case "FORBIDDEN_TARGET":
    case "FORBIDDEN_WARDEN_INSTRUCTION":
      return 403;
    default:
      return 400;
  }
}

/**
 * Reuses an injected/active MessageService when the request, context or active
 * orchestrator carries one. Otherwise builds a service whose event sink redacts
 * every appended event before it reaches the EventStore.
 */
function resolveMessageService(
  request: Request,
  context: RouteContext | undefined,
  eventStore: EventStore
): MessageService {
  const req = request as unknown as { messageService?: unknown };
  const ctx = context as unknown as { messageService?: unknown } | undefined;
  const orchestrator = resolveActiveOrchestrator(request, context) as
    | { messageService?: unknown }
    | null;
  const candidate =
    req?.messageService ?? ctx?.messageService ?? orchestrator?.messageService;
  if (candidate && typeof (candidate as MessageService).send === "function") {
    return candidate as MessageService;
  }

  const sink: MessageEventSink = {
    append: (input) =>
      eventStore.append(
        redactEvent(input as unknown as Record<string, unknown>) as never
      ),
  };
  return new MessageService({ eventStore: sink });
}

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  let runId = resolvedParams?.runId;

  if (!runId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/messages/);
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

  const parsed = messageBodySchema.safeParse(rawBody);
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
    "send messages for this run"
  );
  if (authError) {
    return authError;
  }

  const service = resolveMessageService(request, context, eventStore);

  let message: MessageRecord;
  try {
    message = service.send({
      runId,
      from: "user",
      to: body.to,
      intent: body.intent as never,
      text: body.text,
      delivery: body.delivery,
      refs: body.refs,
      skeletonId: body.skeletonId,
      recipientRole: body.recipientRole,
    });
  } catch (err) {
    if (err instanceof MessageError) {
      return Response.json(
        { ok: false, error: err.message, code: err.code },
        { status: statusForMessageError(err) }
      );
    }
    return Response.json(
      { ok: false, error: "Message was refused" },
      { status: 400 }
    );
  }

  return Response.json({ ok: true, runId, message }, { status: 200 });
}



function readMessages(
  events: ReturnType<EventStore["getEvents"]>
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.kind !== "message.sent") continue;
    const data = (event.data ?? {}) as Record<string, unknown>;
    messages.push({
      id: data.msgId,
      seq: event.seq,
      ts: event.ts,
      from: data.from,
      to: data.to,
      intent: data.intent,
      text: data.text,
      state: data.state,
      delivery: data.delivery,
      cc: data.cc,
      skeletonId: data.skeletonId,
      refs: Array.isArray(data.refs) ? data.refs : [],
    });
  }
  return messages;
}

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  let runId = resolvedParams?.runId;

  if (!runId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/messages/);
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

  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);

  const run = runStore.getRun(runId);
  const events = eventStore.getEvents(runId);

  if (!run && events.length === 0) {
    return Response.json(
      { ok: false, error: "Run not found" },
      { status: 404 }
    );
  }

  const authError = authorizeMutatingRunRequest(
    run,
    request,
    undefined,
    runStore,
    "read messages for this run"
  );
  if (authError) {
    return authError;
  }

  return Response.json(
    { ok: true, runId, messages: readMessages(events) },
    { status: 200 }
  );
}

