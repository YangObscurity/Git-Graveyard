import { z } from "zod";
import {
  authorizeMutatingRunRequest,
  extractCallerCredentials,
} from "@/lib/pact/pact-mutation";
import { GitService } from "@/lib/git/git-service";
import {
  isSafeRunId,
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
} from "@/lib/runtime/store-context";
import { redactEvent, redactText } from "@/lib/security/redactor";
import type { EventStore } from "@/lib/events/event-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ runId: string }> | { runId: string };
}

const pushForkBodySchema = z.object({
  confirmed: z.boolean().optional(),
  targetFork: z.string().optional(),
  sourceRepoUrl: z.string().optional(),
  askId: z.string().optional(),
  inviteCode: z.string().optional(),
  adminToken: z.string().optional(),
});

interface GitPusher {
  pushToFork: (runId: string, options: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Resolves the GitService that performs the fork push: an explicit injection on
 * the request/context or the active orchestrator's service, else a fresh one
 * bound to this run's source repository.
 */
function resolveGitService(
  request: Request,
  context: RouteContext | undefined,
  orchestrator: unknown,
  sourceUrl: string | undefined
): GitPusher {
  const req = request as unknown as { gitService?: unknown };
  const ctx = context as unknown as { gitService?: unknown } | undefined;
  const orch = orchestrator as { gitService?: unknown } | null | undefined;
  const candidate = req?.gitService ?? ctx?.gitService ?? orch?.gitService;
  if (candidate && typeof (candidate as GitPusher).pushToFork === "function") {
    return candidate as GitPusher;
  }
  return new GitService({ sourceRepoUrl: sourceUrl }) as unknown as GitPusher;
}

/** Maps a GitServiceError code onto the HTTP status the route returns. */
function statusForPushError(code: unknown): number {
  switch (code) {
    case "SOURCE_WRITE_FORBIDDEN":
    case "TARGET_NOT_OWNER_FORK":
    case "NOT_A_FORK":
      return 403;
    case "INVALID_RUN_PHASE":
    case "PUSH_FLAG_DISABLED":
    case "PUSH_NOT_CONFIRMED":
      return 409;
    case "MISSING_FORK_URL":
    case "MISSING_SOURCE_URL":
    case "INVALID_SOURCE_URL":
    case "INVALID_RUN_ID":
      return 400;
    default:
      return 500;
  }
}

function normalizeRepoUrl(raw: string): string | null {
  const match = raw
    .trim()
    .match(/^[a-zA-Z]+:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?$/);
  if (!match) return null;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

/** True when the push target is the same repository as the source. */
function targetsSourceRepo(targetFork: string, sourceUrl: string): boolean {
  if (targetFork.trim() === sourceUrl.trim()) return true;
  const target = normalizeRepoUrl(targetFork);
  const source = normalizeRepoUrl(sourceUrl);
  return Boolean(target && source && target === source);
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
      const match = url.pathname.match(/\/api\/runs\/([^/?#]+)\/push-fork/);
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

  const parsed = pushForkBodySchema.safeParse(rawBody);
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
  if (!run) {
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
    "push to a fork for this run"
  );
  if (authError) {
    return authError;
  }

  if (run.phase !== "done") {
    return Response.json(
      { ok: false, error: "Run must be finished before it can be pushed" },
      { status: 409 }
    );
  }

  if (run.pushFlag !== true) {
    return Response.json(
      { ok: false, error: "Pushing is not enabled for this run" },
      { status: 403 }
    );
  }

  // When the caller presents an invite code that resolves, its push flag must
  // also be enabled.
  const creds = extractCallerCredentials(request, rawBody as Record<string, unknown>);
  if (creds.inviteCode && typeof runStore.lookupInviteCodeDetails === "function") {
    const details = runStore.lookupInviteCodeDetails(creds.inviteCode);
    if (details.valid && details.pushFlag !== true) {
      return Response.json(
        { ok: false, error: "This invite code cannot push to a fork" },
        { status: 403 }
      );
    }
  }

  const branch = run.pushBranch ?? `graveyard/${runId}`;

  // Step 1: confirmation gate. Without an explicit confirmation the route only
  // raises the ask; it never touches the fork.
  if (body.confirmed !== true) {
    const targetFork = body.targetFork ?? run.pushTargetFork ?? null;
    if (!targetFork) {
      return Response.json(
        { ok: false, error: "A target fork is required before pushing" },
        { status: 400 }
      );
    }

    const askId =
      body.askId ??
      `push_confirm:${runId}:${Date.now().toString(36)}`;

    eventStore.append(
      redactEvent({
        runId,
        kind: "ask.raised",
        actor: "user",
        data: {
          askId,
          kind: "push_confirm",
          question: `Push ${branch} to ${targetFork}?`,
          options: ["Push", "Do not push"],
          default: "Do not push",
          targetFork,
          branch,
        },
      }) as never
    );

    return Response.json(
      {
        ok: true,
        status: "confirmation_required",
        runId,
        askId,
        targetFork,
        branch,
        sourceUntouched: true,
      },
      { status: 202 }
    );
  }

  // Step 2: confirmed push.
  const targetFork = body.targetFork ?? run.pushTargetFork ?? null;
  if (!targetFork) {
    return Response.json(
      { ok: false, error: "A target fork is required before pushing" },
      { status: 400 }
    );
  }

  const sourceUrl = body.sourceRepoUrl ?? run.url ?? null;
  if (!sourceUrl) {
    return Response.json(
      { ok: false, error: "The source repository is unknown" },
      { status: 400 }
    );
  }

  if (targetsSourceRepo(targetFork, sourceUrl)) {
    return Response.json(
      { ok: false, error: "Refusing to push to the source repository" },
      { status: 403 }
    );
  }

  eventStore.append(
    redactEvent({
      runId,
      kind: "ask.answered",
      actor: "user",
      data: {
        askId: body.askId,
        kind: "push_confirm",
        answer: "Push",
        targetFork,
        branch,
      },
    }) as never
  );

  const orchestrator = resolveActiveOrchestrator(request, context);
  const gitService = resolveGitService(request, context, orchestrator, sourceUrl);

  const sink: Pick<EventStore, "append"> = {
    append: (input) =>
      eventStore.append(
        redactEvent(input as unknown as Record<string, unknown>) as never
      ),
  };

  try {
    const result = (await gitService.pushToFork(runId, {
      targetRepoUrl: targetFork,
      sourceRepoUrl: sourceUrl,
      branchName: branch,
      runPhase: "done",
      invitePushFlag: true,
      pushConfirm: true,
      eventStore: sink,
    })) as { commitSha?: string; branch?: string } | null;

    return Response.json(
      {
        ok: true,
        runId,
        targetFork,
        branch: result?.branch ?? branch,
        commitSha: result?.commitSha ?? null,
        sourceUntouched: true,
      },
      { status: 200 }
    );
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        ok: false,
        error: redactText(message),
        code: typeof code === "string" ? code : undefined,
      },
      { status: statusForPushError(code) }
    );
  }
}

