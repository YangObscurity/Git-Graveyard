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
  params: Promise<{ runId: string; askId: string }> | { runId: string; askId: string };
}

const askBodySchema = z.object({
  answer: z.unknown(),
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

interface AskResolver {
  answerAsk: (askId: string, answer: unknown) => unknown;
  getAsk?: (askId: string) => { runId?: unknown } | undefined;
}

type AskOwnership = "ok" | "mismatch" | "unknown";

/**
 * Verifies that an ask belongs to the run in the URL before anything is
 * answered. Ownership is proven either by the AskManager's own record or by a
 * matching `ask.raised` event in this run's event log; anything else fails
 * closed. An ask bound to a different run is reported as a mismatch.
 */
function verifyAskOwnership(
  askManager: AskResolver | null,
  eventStore: EventStore,
  runId: string,
  askId: string
): AskOwnership {
  if (askManager && typeof askManager.getAsk === "function") {
    try {
      const ask = askManager.getAsk(askId);
      if (ask && typeof ask === "object") {
        const owner = (ask as { runId?: unknown }).runId;
        if (typeof owner === "string") {
          return owner === runId ? "ok" : "mismatch";
        }
      }
    } catch {
      // Fall through to the event log.
    }
  }

  try {
    const raised = eventStore.getEvents(runId, { kind: "ask.raised" });
    const owned = raised.some((event) => {
      const data = event.data as Record<string, unknown> | undefined;
      return data?.askId === askId;
    });
    if (owned) {
      return "ok";
    }
  } catch {
    // Unreadable event log means ownership cannot be verified.
  }

  return "unknown";
}

/**
 * Resolves an active AskManager from the request, context or orchestrator;
 * falls back to the RuntimeHost gateway only when no orchestrator is present.
 */
function resolveAskManager(
  request: Request,
  context: RouteContext | undefined,
  orchestrator: unknown
): AskResolver | null {
  const req = request as unknown as { askManager?: unknown };
  const ctx = context as unknown as { askManager?: unknown } | undefined;
  const orch = orchestrator as { askManager?: unknown } | null | undefined;
  const direct = req?.askManager ?? ctx?.askManager ?? orch?.askManager;
  if (direct && typeof (direct as AskResolver).answerAsk === "function") {
    return direct as AskResolver;
  }
  if (!orchestrator) {
    try {
      const manager = (getRuntimeHost()?.gateway as unknown as {
        askManager?: unknown;
      })?.askManager;
      if (manager && typeof (manager as AskResolver).answerAsk === "function") {
        return manager as AskResolver;
      }
    } catch {}
  }
  return null;
}

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  let runId = resolvedParams?.runId;
  let askId = resolvedParams?.askId;

  if (!runId || !askId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/asks\/([^/?#]+)/);
      if (match) {
        runId = decodeURIComponent(match[1]);
        askId = decodeURIComponent(match[2]);
      }
    } catch {}
  }

  if (!isSafeRunId(runId) || !isSafePathSegment(askId)) {
    return Response.json(
      { ok: false, error: "Invalid runId or askId" },
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

  const parsed = askBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "Validation error", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const body = parsed.data;
  if (body.answer === undefined) {
    return Response.json(
      { ok: false, error: "answer is required" },
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
    "answer questions for this run"
  );
  if (authError) {
    return authError;
  }

  let handled = false;
  const orchestrator = resolveActiveOrchestrator(request, context);
  const askManager = resolveAskManager(request, context, orchestrator);

  // Ownership: an ask raised by one run may only be answered through that run.
  const ownership = verifyAskOwnership(askManager, eventStore, runId, askId);
  if (ownership === "mismatch") {
    return Response.json(
      { ok: false, error: "Ask does not belong to this run", code: "ASK_RUN_MISMATCH" },
      { status: 403 }
    );
  }
  if (ownership === "unknown") {
    return Response.json(
      {
        ok: false,
        error: "Ask ownership could not be verified for this run",
        code: "ASK_NOT_FOUND",
      },
      { status: 404 }
    );
  }

  if (askManager) {
    try {
      if (await askManager.answerAsk(askId, body.answer)) {
        handled = true;
      }
    } catch {}
  }

  // Dispatch to the orchestrator only when the AskManager did not already
  // handle the answer, so a single POST never answers an ask twice.
  if (!handled && orchestrator && typeof orchestrator.answerAsk === "function") {
    try {
      if (await orchestrator.answerAsk(runId, askId, body.answer)) {
        handled = true;
      }
    } catch {}
  }

  eventStore.append(
    redactEvent({
      runId,
      kind: "ask.answered",
      actor: "user",
      data: {
        askId,
        answer: body.answer,
        handled,
      },
    }) as never
  );

  return Response.json(
    {
      ok: true,
      runId,
      askId,
      answer: body.answer,
      handled,
    },
    { status: 200 }
  );
}

