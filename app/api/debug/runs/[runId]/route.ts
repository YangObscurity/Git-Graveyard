import {
  authorizeDebugRequest,
  inspectRunDiagnostics,
} from "@/lib/runtime/diagnostics";
import { isSafeRunId } from "@/lib/runtime/store-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ runId: string }> | { runId: string };
}

export async function GET(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  const auth = authorizeDebugRequest(request);
  if (!auth.allowed) {
    return auth.response;
  }

  const resolvedParams = context?.params
    ? await Promise.resolve(context.params)
    : undefined;
  let runId = resolvedParams?.runId;

  if (!runId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/debug\/runs\/([^/?#]+)/);
      if (match) {
        runId = decodeURIComponent(match[1]);
      }
    } catch {
      // ignore malformed URL
    }
  }

  if (!isSafeRunId(runId)) {
    return Response.json(
      {
        ok: false,
        code: "INVALID_RUN_ID",
        error: "Invalid or missing runId",
      },
      { status: 400 }
    );
  }

  const report = inspectRunDiagnostics(runId, { request });
  if (!report) {
    return Response.json(
      {
        ok: false,
        code: "RUN_NOT_FOUND",
        error: "Run not found",
      },
      { status: 404 }
    );
  }

  return Response.json(
    {
      ok: true,
      ...report,
    },
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    }
  );
}
