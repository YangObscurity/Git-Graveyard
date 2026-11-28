import { resolveEventStore, resolveRunStore } from "@/lib/runtime/store-context";
import { listPublishedRuns } from "@/lib/history/published-runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);

  let limit: number | null = null;
  const limitParam = searchParams.get("limit");
  if (limitParam !== null && limitParam.trim().length > 0) {
    const parsedLimit = parseInt(limitParam.trim(), 10);
    if (!Number.isNaN(parsedLimit) && parsedLimit >= 0) {
      limit = parsedLimit;
    }
  }

  const result = listPublishedRuns(runStore, eventStore, {
    limit,
    fields: searchParams.get("fields"),
  });

  return Response.json(result, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
