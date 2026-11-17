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
  params: Promise<{ runId: string }> | { runId: string };
}

const askBodySchema = z.object({
  askId: z.string().min(1, "askId is required"),
  answer: z.unknown(),
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
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/asks/);
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
  const orchestrator = resolveActiveOrchestrator(request);
  if (orchestrator && typeof orchestrator.answerAsk === "function") {
    try {
      handled = Boolean(await orchestrator.answerAsk(runId, body.askId, body.answer));
    } catch {}
  }

  eventStore.append(
    redactEvent({
      runId,
      kind: "ask.answered",
      actor: "user",
      data: {
        askId: body.askId,
        answer: body.answer,
        handled,
      },
    }) as any
  );

  return Response.json(
    {
      ok: true,
      runId,
      askId: body.askId,
      answer: body.answer,
      handled,
    },
    { status: 200 }
  );
}
