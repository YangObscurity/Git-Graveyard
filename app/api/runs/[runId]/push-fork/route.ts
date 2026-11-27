import { z } from "zod";
import {
  authorizeMutatingRunRequest,
  extractCallerCredentials,
} from "@/lib/pact/pact-mutation";
import { GitService, hasEmbeddedCredentials } from "@/lib/git/git-service";
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

/**
 * Canonicalizes GitHub HTTPS, SSH and `ssh://` URL spellings (case-insensitively)
 * to `owner/repo`, so two spellings of the same repository compare equal. Any
 * URL that is not a GitHub repository or that carries embedded credentials
 * returns `null`.
 */
function canonicalRepoSlug(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const patterns: RegExp[] = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) return null;
    if (owner === "." || owner === ".." || repo === "." || repo === "..") {
      return null;
    }
    return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }
  return null;
}

/** True when the push target is the same repository as the source. */
function targetsSourceRepo(targetFork: string, sourceUrl: string): boolean {
  const target = canonicalRepoSlug(targetFork);
  const source = canonicalRepoSlug(sourceUrl);
  if (target && source) {
    return target === source;
  }
  return targetFork.trim() === sourceUrl.trim();
}

/**
 * Defense-in-depth: the fork target must be exactly
 * `https://github.com/<owner>/<repo>` with an optional `.git` suffix, carrying
 * no embedded credentials and no HTTP / file / SSH / alternate-host endpoint.
 * This runs before any git operation touches the network.
 */
function isValidForkTarget(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (hasEmbeddedCredentials(trimmed)) return false;
  if (!/^https:\/\//.test(trimmed)) return false;

  const match = trimmed.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (!match) return false;

  const owner = match[1];
  const repo = match[2];
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return false;
  }
  return true;
}

interface PendingPushAsk {
  askId: string;
  targetFork: string;
  branch: string | null;
}

interface PendingPushAskFailure {
  status: number;
  error: string;
  code: string;
}

/**
 * Finds the pending (unanswered) `push_confirm` ask that a run actually raised,
 * reading only that run's own event log. When `requestedAskId` is supplied it
 * must name that exact ask; otherwise the most recent unanswered `push_confirm`
 * ask wins. A missing or already-consumed ask is a hard failure so a confirmed
 * push can never be invented or replayed.
 */
function findPendingPushConfirmAsk(
  eventStore: EventStore,
  runId: string,
  requestedAskId?: string
): PendingPushAsk | PendingPushAskFailure {
  let events: EventEnvelope[];
  try {
    events = eventStore.getEvents(runId);
  } catch {
    return {
      status: 500,
      error: "Could not read the run event log",
      code: "EVENT_LOG_UNAVAILABLE",
    };
  }

  const raised = new Map<string, { targetFork?: string; branch?: string }>();
  const order: string[] = [];
  const answered = new Set<string>();

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data) continue;
    const askId = typeof data.askId === "string" ? data.askId : undefined;
    if (!askId) continue;

    if (event.kind === "ask.raised" && data.kind === "push_confirm") {
      raised.set(askId, {
        targetFork: typeof data.targetFork === "string" ? data.targetFork : undefined,
        branch: typeof data.branch === "string" ? data.branch : undefined,
      });
      order.push(askId);
    } else if (event.kind === "ask.answered") {
      answered.add(askId);
    }
  }

  const toResult = (
    askId: string
  ): PendingPushAsk | PendingPushAskFailure => {
    const record = raised.get(askId);
    if (!record?.targetFork) {
      return {
        status: 409,
        error: "The raised push confirmation has no target fork",
        code: "PUSH_ASK_INVALID",
      };
    }
    return { askId, targetFork: record.targetFork, branch: record.branch ?? null };
  };

  if (requestedAskId) {
    if (!raised.has(requestedAskId)) {
      return {
        status: 409,
        error: "No matching push confirmation was raised for this run",
        code: "PUSH_ASK_NOT_FOUND",
      };
    }
    if (answered.has(requestedAskId)) {
      return {
        status: 409,
        error: "That push confirmation was already answered",
        code: "PUSH_ASK_ALREADY_ANSWERED",
      };
    }
    return toResult(requestedAskId);
  }

  for (let i = order.length - 1; i >= 0; i -= 1) {
    const askId = order[i];
    if (answered.has(askId)) continue;
    const result = toResult(askId);
    if (!("status" in result)) {
      return result;
    }
  }

  return {
    status: 409,
    error: "No pending push confirmation was found for this run",
    code: "PUSH_ASK_MISSING",
  };
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

  // Step 2: confirmed push. The confirmation is bound to the pending
  // `push_confirm` ask this run actually raised: the caller can neither invent
  // one, retarget it, nor replay a consumed one.
  const pendingAsk = findPendingPushConfirmAsk(eventStore, runId, body.askId);
  if ("status" in pendingAsk) {
    return Response.json(
      { ok: false, error: pendingAsk.error, code: pendingAsk.code },
      { status: pendingAsk.status }
    );
  }

  const targetFork = pendingAsk.targetFork;
  const pushedBranch = pendingAsk.branch ?? branch;

  // A caller-supplied target must spell the same repository as the raised ask.
  if (body.targetFork !== undefined) {
    const provided = canonicalRepoSlug(body.targetFork);
    const raisedTarget = canonicalRepoSlug(targetFork);
    if (!provided || !raisedTarget || provided !== raisedTarget) {
      return Response.json(
        {
          ok: false,
          error: "The confirmation target does not match the raised push ask",
          code: "PUSH_TARGET_MISMATCH",
        },
        { status: 409 }
      );
    }
  }

  // Defense-in-depth allowlist: the raised target must be a plain
  // https://github.com/<owner>/<repo> URL before any git operation runs.
  if (!isValidForkTarget(targetFork)) {
    return Response.json(
      {
        ok: false,
        error:
          "The fork target must be an https://github.com/<owner>/<repo> repository",
        code: "INVALID_FORK_TARGET",
      },
      { status: 403 }
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
        askId: pendingAsk.askId,
        kind: "push_confirm",
        answer: "Push",
        targetFork,
        branch: pushedBranch,
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
      branchName: pushedBranch,
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
        branch: result?.branch ?? pushedBranch,
        commitSha: result?.commitSha ?? null,
        sourceUntouched: true,
      },
      { status: 200 }
    );
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    return Response.json(
      { ok: false, error: "Unable to complete the fork push" },
      { status: statusForPushError(code) }
    );
  }
}

