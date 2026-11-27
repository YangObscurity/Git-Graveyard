import * as crypto from "node:crypto";
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
 * In-flight claim set for confirmed pushes, keyed by `runId:askId`. Two
 * concurrent callers for the same pending confirmation must never both pass
 * the pending-ask lookup and run `pushToFork` twice, so the first caller to
 * claim the key wins and any other is refused with a conflict until the claim
 * is released in `finally`.
 */
const inFlightPushAsks = new Set<string>();

/**
 * View of the push wiring an orchestrator exposes for a run. Only the fields
 * the route forwards to a push are read; the values come from the active
 * orchestrator's configured credentials and run directories.
 */
interface PushForkConfigView {
  gitService: unknown;
  gitDir?: string;
  runDir?: string;
  ownerLogin?: string;
  forkChecker?: unknown;
  token?: string;
}

/**
 * Resolves the GitService injected directly on the request/context. An isolated
 * route test injects a mock here; when present it wins over the orchestrator so
 * the test can observe the push without a live git remote.
 */
function readInjectedGitService(
  request: Request,
  context: RouteContext | undefined
): GitPusher | undefined {
  const req = request as unknown as { gitService?: unknown };
  const ctx = context as unknown as { gitService?: unknown } | undefined;
  const candidate = req?.gitService ?? ctx?.gitService;
  if (candidate && typeof (candidate as GitPusher).pushToFork === "function") {
    return candidate as GitPusher;
  }
  return undefined;
}

/**
 * Reads a GitService directly off an orchestrator that does not expose the
 * dedicated push wiring. Preserves the legacy "orchestrator.gitService" path.
 */
function readOrchestratorGitService(
  orchestrator: unknown
): GitPusher | undefined {
  const orch = orchestrator as { gitService?: unknown } | null | undefined;
  const candidate = orch?.gitService;
  if (candidate && typeof (candidate as GitPusher).pushToFork === "function") {
    return candidate as GitPusher;
  }
  return undefined;
}

/**
 * Reads the active orchestrator's push config (git service, run directories,
 * owner login, fork checker and token). Returns `null` when no orchestrator (or
 * no config accessor) is available so the route can fall back safely.
 */
function readPushForkConfig(
  orchestrator: unknown,
  runId: string
): PushForkConfigView | null {
  const orch = orchestrator as
    | { getPushForkConfig?: (id: string) => unknown }
    | null
    | undefined;
  if (!orch || typeof orch.getPushForkConfig !== "function") {
    return null;
  }
  try {
    const cfg = orch.getPushForkConfig(runId);
    if (!cfg || typeof cfg !== "object") {
      return null;
    }
    return cfg as PushForkConfigView;
  } catch {
    return null;
  }
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
 * True when a repository URL is a recognized GitHub spelling that carries no
 * embedded credentials in its authority (`https://user:pass@host/...`). The
 * standard `git` SSH user (`ssh://git@github.com/<owner>/<repo>`) is accepted;
 * `canonicalRepoSlug` already rejects any other SSH user and any credential
 * embedded in an SSH URL. An scp-style `git@github.com:<owner>/<repo>` spelling
 * has no URL authority and is accepted.
 */
function isCanonicalSourceUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (!canonicalRepoSlug(trimmed)) return false;

  // The `ssh://git@github.com/...` spelling is the only URL form allowed to
  // carry a username: the standard `git` user. `canonicalRepoSlug` guarantees
  // that exact user/host/repo shape before we get here.
  if (/^ssh:\/\/git@github\.com\//i.test(trimmed)) {
    return true;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password) return false;
    } catch {
      return false;
    }
  }
  return true;
}

type AuthoritativeSourceResult =
  | { sourceUrl: string }
  | { status: number; error: string; code: string };

/**
 * Resolves the one authoritative source repository for a push strictly from the
 * run record. The caller-supplied `sourceRepoUrl` is never trusted: it is only
 * accepted when it canonicalizes to the same repository as `run.url`, so it can
 * never retarget a push onto the upstream source. A `run.url` that is not a
 * canonical, credential-free GitHub repository is refused outright.
 */
function resolveAuthoritativeSourceUrl(
  runUrl: unknown,
  providedSourceUrl: unknown
): AuthoritativeSourceResult {
  const authoritative =
    typeof runUrl === "string" && runUrl.trim().length > 0 ? runUrl.trim() : null;
  if (!authoritative) {
    return {
      status: 400,
      error: "The source repository is unknown",
      code: "MISSING_SOURCE_URL",
    };
  }

  if (!isCanonicalSourceUrl(authoritative)) {
    return {
      status: 403,
      error: "The run source repository URL is not canonical",
      code: "INVALID_SOURCE_URL",
    };
  }

  if (
    providedSourceUrl !== undefined &&
    providedSourceUrl !== null &&
    String(providedSourceUrl).trim().length > 0
  ) {
    const provided = canonicalRepoSlug(String(providedSourceUrl));
    const expected = canonicalRepoSlug(authoritative);
    if (!provided || !expected || provided !== expected) {
      return {
        status: 403,
        error: "The supplied source repository does not match this run",
        code: "SOURCE_REPO_MISMATCH",
      };
    }
  }

  return { sourceUrl: authoritative };
}

/**
 * Defense-in-depth: the fork target must be exactly
 * `https://github.com/<owner>/<repo>` with an optional `.git` suffix and an
 * optional trailing slash, carrying no embedded credentials and no HTTP /
 * file / SSH / alternate-host endpoint. The host match is case-insensitive to
 * stay aligned with {@link canonicalRepoSlug}. This runs before any git
 * operation touches the network.
 */
function isValidForkTarget(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (hasEmbeddedCredentials(trimmed)) return false;
  if (!/^https:\/\//i.test(trimmed)) return false;

  // Reuse the exact canonicalization the rest of the route trusts: it accepts
  // an optional `.git` suffix and an optional trailing slash and is
  // case-insensitive on the `github.com` host, while rejecting every other
  // host spelling and any embedded credential.
  return canonicalRepoSlug(trimmed) !== null;
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
      // Only an answer an active handler actually processed consumes the ask. A
      // recorded refusal (`handled: false`) must leave the confirmation pending.
      if (data.handled !== false) {
        answered.add(askId);
      }
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

  // No explicit ask was requested: the newest unanswered `push_confirm` ask is
  // authoritative. If that newest ask is invalid (e.g. it carries no target
  // fork), return its error instead of falling back to an older ask.
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const askId = order[i];
    if (answered.has(askId)) continue;
    return toResult(askId);
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

  // An empty or whitespace-only askId is not the same as an omitted one: left
  // as-is it would raise or confirm an ask under a blank identifier, so it is
  // refused before either the preview or the confirm branch runs.
  if (body.askId !== undefined && body.askId.trim().length === 0) {
    return Response.json(
      {
        ok: false,
        error: "askId must not be empty or whitespace",
        code: "INVALID_ASK_ID",
      },
      { status: 400 }
    );
  }

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

  // The run record is the only authority for the source repository: a
  // caller-supplied sourceRepoUrl can never retarget a push onto the upstream
  // source. A mismatch is refused before any confirmation or git operation.
  const sourceResolution = resolveAuthoritativeSourceUrl(
    run.url,
    body.sourceRepoUrl
  );
  if ("status" in sourceResolution) {
    return Response.json(
      { ok: false, error: sourceResolution.error, code: sourceResolution.code },
      { status: sourceResolution.status }
    );
  }
  const authoritativeSourceUrl = sourceResolution.sourceUrl;

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

    // The random suffix keeps two confirmations raised in the same
    // millisecond distinct, so auto-generated ask ids never collide.
    const askId =
      body.askId ??
      `push_confirm:${runId}:${Date.now().toString(36)}:${crypto.randomUUID()}`;

    // A caller-supplied askId must not retarget an existing confirmation: it may
    // only be used when nothing in this run's log has raised or answered it.
    if (body.askId) {
      let existing: EventEnvelope[];
      try {
        existing = eventStore.getEvents(runId);
      } catch {
        return Response.json(
          {
            ok: false,
            error: "Could not read the run event log",
            code: "EVENT_LOG_UNAVAILABLE",
          },
          { status: 500 }
        );
      }
      const alreadyUsed = existing.some((event) => {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data || data.askId !== body.askId) return false;
        return event.kind === "ask.raised" || event.kind === "ask.answered";
      });
      if (alreadyUsed) {
        return Response.json(
          {
            ok: false,
            error:
              "That push confirmation id has already been raised or answered",
            code: "PUSH_ASK_ALREADY_EXISTS",
          },
          { status: 409 }
        );
      }
    }

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

  const sourceUrl = authoritativeSourceUrl;

  if (targetsSourceRepo(targetFork, sourceUrl)) {
    return Response.json(
      { ok: false, error: "Refusing to push to the source repository" },
      { status: 403 }
    );
  }

  // Claim the confirmation for this request before the first await that
  // performs the push. A second concurrent caller for the same pending ask is
  // refused with a conflict rather than running a duplicate push.
  const claimKey = `${runId}:${pendingAsk.askId}`;
  if (inFlightPushAsks.has(claimKey)) {
    return Response.json(
      {
        ok: false,
        error: "A push for this confirmation is already in progress",
        code: "PUSH_ALREADY_IN_FLIGHT",
      },
      { status: 409 }
    );
  }
  inFlightPushAsks.add(claimKey);

  try {
    const orchestrator = resolveActiveOrchestrator(request, context);
    const pushConfig = readPushForkConfig(orchestrator, runId);
    const injectedGitService = readInjectedGitService(request, context);

    const sink: Pick<EventStore, "append"> = {
      append: (input) =>
        eventStore.append(
          redactEvent(input as unknown as Record<string, unknown>) as never
        ),
    };

    let result: { commitSha?: string; branch?: string } | null;
    if (
      !injectedGitService &&
      orchestrator &&
      typeof orchestrator.pushRunToFork === "function"
    ) {
      // A real orchestrator owns the confirmed push: it supplies the configured
      // fork checker, owner login, write token and run directories to its
      // GitService so the target is verified as the owner's fork first.
      result = (await orchestrator.pushRunToFork(runId, {
        targetRepoUrl: targetFork,
        sourceRepoUrl: sourceUrl,
        branchName: pushedBranch,
        pushConfirm: true,
        eventStore: sink as unknown as EventStore,
      })) as { commitSha?: string; branch?: string } | null;
    } else {
      // An injected mock GitService (isolated route tests) is called directly,
      // while still receiving the orchestrator's fork-checker/owner/token/dir
      // wiring whenever one is present.
      const gitService =
        injectedGitService ??
        (pushConfig?.gitService as GitPusher | undefined) ??
        readOrchestratorGitService(orchestrator) ??
        (new GitService({ sourceRepoUrl: sourceUrl }) as unknown as GitPusher);

      result = (await gitService.pushToFork(runId, {
        targetRepoUrl: targetFork,
        sourceRepoUrl: sourceUrl,
        branchName: pushedBranch,
        runPhase: "done",
        invitePushFlag: true,
        pushConfirm: true,
        eventStore: sink,
        ...(pushConfig
          ? {
              forkChecker: pushConfig.forkChecker,
              ownerLogin: pushConfig.ownerLogin,
              token: pushConfig.token,
              gitDir: pushConfig.gitDir,
              runDir: pushConfig.runDir,
            }
          : {}),
      })) as { commitSha?: string; branch?: string } | null;
    }

    // Consume the confirmation only after the push actually succeeded: a
    // transient git/network error must not burn a still-valid pending ask. The
    // audit append is a separate step so a storage failure can be reported
    // distinctly from a failed push, without inviting a duplicate retry.
    try {
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
    } catch {
      return Response.json(
        {
          ok: false,
          error: "The push succeeded but its confirmation could not be recorded",
          code: "PUSH_AUDIT_FAILED",
          runId,
          targetFork,
          branch: result?.branch ?? pushedBranch,
          commitSha: result?.commitSha ?? null,
          sourceUntouched: true,
          pushed: true,
        },
        { status: 500 }
      );
    }

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
  } finally {
    inFlightPushAsks.delete(claimKey);
  }
}

