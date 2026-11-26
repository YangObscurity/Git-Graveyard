import {
  authorizeDebugRequest,
  collectSystemDiagnostics,
} from "@/lib/runtime/diagnostics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeDebugRequest(request);
  if (!auth.allowed) {
    return auth.response;
  }

  let probeToolchains = false;
  try {
    const url = new URL(request.url);
    probeToolchains = url.searchParams.get("probeToolchains") === "1";
  } catch {
    probeToolchains = false;
  }

  const diagnostics = collectSystemDiagnostics({
    request,
    probeToolchains,
  });

  return Response.json(
    {
      ok: true,
      diagnostics,
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
