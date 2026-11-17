import * as fs from "node:fs";
import * as path from "node:path";
import type { RunRecord } from "@/lib/runs/run-store";
import {
  isSafeRunId,
  resolveRunArtifactDirs,
  resolveRunStore,
} from "@/lib/runtime/store-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ runId: string }> | { runId: string };
}

const ARTIFACT_FILE_MAP: Record<string, string> = {
  patch: "all.patch",
  "all.patch": "all.patch",
  spec: "spec.json",
  "spec.json": "spec.json",
  report: "report.md",
  "report.md": "report.md",
  events: "events.ndjson",
  "events.ndjson": "events.ndjson",
  certificate: "death-certificate.json",
  "death-certificate.json": "death-certificate.json",
};

const CONTENT_TYPES: Record<string, string> = {
  "all.patch": "text/x-diff; charset=utf-8",
  "spec.json": "application/json; charset=utf-8",
  "report.md": "text/markdown; charset=utf-8",
  "events.ndjson": "application/x-ndjson; charset=utf-8",
  "death-certificate.json": "application/json; charset=utf-8",
};

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const resolvedParams = await Promise.resolve(context?.params);
  let runId = resolvedParams?.runId;

  if (!runId) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/runs\/([^/?#]+)\/relic\/download/);
      if (match) {
        runId = decodeURIComponent(match[1]);
      }
    } catch {}
  }

  if (!isSafeRunId(runId)) {
    return Response.json({ error: "Invalid runId" }, { status: 400 });
  }

  const url = new URL(request.url);
  const artifactParam = url.searchParams.get("artifact");

  if (!artifactParam || !(artifactParam in ARTIFACT_FILE_MAP)) {
    return Response.json(
      { error: "Invalid or unknown artifact parameter" },
      { status: 400 }
    );
  }

  const fileName = ARTIFACT_FILE_MAP[artifactParam];

  // Lookup RunRecord from store if available
  let run: RunRecord | null = null;
  try {
    const runStore = resolveRunStore(request);
    run = runStore.getRun(runId);
  } catch {}

  const baseDirs = resolveRunArtifactDirs(runId, run);

  for (const dir of baseDirs) {
    const resolvedDir = path.resolve(dir);
    const resolvedTarget = path.resolve(dir, fileName);
    if (!resolvedTarget.startsWith(resolvedDir + path.sep)) {
      continue;
    }
    if (fs.existsSync(resolvedTarget)) {
      try {
        const stat = fs.statSync(resolvedTarget);
        if (stat.isFile()) {
          const fileContent = fs.readFileSync(resolvedTarget);
          const contentType =
            CONTENT_TYPES[fileName] ?? "text/plain; charset=utf-8";
          return new Response(fileContent, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="${fileName}"`,
              "Content-Length": String(stat.size),
            },
          });
        }
      } catch {
        // Fall through
      }
    }
  }

  return Response.json({ error: "Artifact not found" }, { status: 404 });
}
