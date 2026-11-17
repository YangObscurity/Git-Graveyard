import {
  type GetEventsOptions,
  type EventEnvelope,
} from "@/lib/events/event-store";
import { resolveEventTap } from "@/lib/runtime/store-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ runId: string }> | { runId: string };
}

function formatSseEvent(event: EventEnvelope): string {
  const data = JSON.stringify(event);
  return `id: ${event.seq}\ndata: ${data}\n\n`;
}

function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
  isClosed?: () => boolean
): Promise<void> {
  if (signal?.aborted || isClosed?.()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = () => {
      cleanup();
      resolve();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  const runId = resolvedParams?.runId;

  if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
    return new Response(JSON.stringify({ error: "runId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const hasFrom = searchParams.has("from");
  const hasTo = searchParams.has("to");

  // Replay mode: query string with from and to returns stored events as JSON in seq order
  if (hasFrom || hasTo) {
    const options: GetEventsOptions = {};

    if (hasFrom) {
      const rawFrom = searchParams.get("from");
      if (rawFrom !== null && rawFrom !== "") {
        const parsedFrom = parseInt(rawFrom, 10);
        if (Number.isNaN(parsedFrom)) {
          return new Response(JSON.stringify({ error: "Invalid from parameter" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        options.from = parsedFrom;
      }
    }

    if (hasTo) {
      const rawTo = searchParams.get("to");
      if (rawTo !== null && rawTo !== "") {
        const parsedTo = parseInt(rawTo, 10);
        if (Number.isNaN(parsedTo)) {
          return new Response(JSON.stringify({ error: "Invalid to parameter" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        options.to = parsedTo;
      }
    }

    const eventTap = resolveEventTap(request, context);
    const events = eventTap.getEvents(runId, options);

    return new Response(JSON.stringify(events), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  // Live SSE streaming mode
  const lastEventIdHeader =
    request.headers.get("last-event-id") ??
    request.headers.get("Last-Event-ID") ??
    searchParams.get("lastEventId") ??
    searchParams.get("last_event_id");

  let startSeq = 1;
  if (lastEventIdHeader !== null && lastEventIdHeader.trim().length > 0) {
    const parsedLastId = parseInt(lastEventIdHeader.trim(), 10);
    if (!Number.isNaN(parsedLastId)) {
      startSeq = parsedLastId >= 0 ? parsedLastId + 1 : 1;
    }
  }

  const eventTap = resolveEventTap(request, context);
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      let nextSeq = startSeq;

      const onAbort = () => {
        closed = true;
      };

      if (request.signal) {
        if (request.signal.aborted) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed
          }
          return;
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
      }

      let lastPingTime = Date.now();

      try {
        // Query stored events from Last-Event-ID + 1 (or 1) before tailing live events
        const initialEvents = eventTap.getEvents(runId, { from: nextSeq });
        for (const event of initialEvents) {
          if (closed || request.signal?.aborted) {
            break;
          }
          const chunk = formatSseEvent(event);
          try {
            controller.enqueue(encoder.encode(chunk));
            nextSeq = event.seq + 1;
            lastPingTime = Date.now();
          } catch {
            closed = true;
            break;
          }
        }

        // Live tailing loop
        while (!closed && !request.signal?.aborted) {
          const newEvents = eventTap.getEvents(runId, { from: nextSeq });
          if (newEvents.length > 0) {
            for (const event of newEvents) {
              if (closed || request.signal?.aborted) {
                break;
              }
              const chunk = formatSseEvent(event);
              try {
                controller.enqueue(encoder.encode(chunk));
                nextSeq = event.seq + 1;
                lastPingTime = Date.now();
              } catch {
                closed = true;
                break;
              }
            }
          } else {
            const now = Date.now();
            if (now - lastPingTime >= 15000) {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
                lastPingTime = now;
              } catch {
                closed = true;
                break;
              }
            }
          }

          await sleepWithAbort(100, request.signal, () => closed);
        }
      } catch {
        // Client disconnect or network error
      } finally {
        closed = true;
        if (request.signal) {
          request.signal.removeEventListener("abort", onAbort);
        }
        try {
          controller.close();
        } catch {
          // Controller already closed or cancelled
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
