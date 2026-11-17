// Task 12.5: Pact mutating operations - edit, approve, revise, and stop
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 36.14

import * as crypto from "node:crypto";
import {
  parsePact,
  type PactTask,
  type PactParseResult,
} from "./pact-parser";
import { renderPact } from "./pact-renderer";
import {
  validateEdit,
  recordApproval,
  NON_REMOVABLE_REQUIREMENTS,
  BUDGET_CHECK_TERMS_NOTE,
  BUDGET_CREDITS_UNREPORTED_NOTE,
  type PactBudget,
  type BudgetCeiling,
  type FlaggedTaskDependency,
  type PactEditError,
} from "./pact-review";
import type { RunStore, RunRecord } from "../runs/run-store";
import type { EventStore, EventEnvelope } from "../events/event-store";
import type { RunPhase } from "../events/types";
import { redactEvent } from "../security/redactor";

// ---------------------------------------------------------------------------
// Action & Mutation Types
// ---------------------------------------------------------------------------

export type PactAction = "edit" | "approve" | "revise" | "stop";

export interface CallerCredentials {
  inviteCode?: string;
  isAdmin: boolean;
}

export interface AuthCheckResult {
  authorized: boolean;
  status: number;
  reason?: string;
}

export interface ExtractedPactState {
  latestVersion: number;
  currentTasks: PactTask[];
  currentMarkdown: string;
  isApproved: boolean;
  approvedRecord: {
    pactVersion: number;
    approvedTaskIds: string[];
    disabledTaskIds?: string[];
    budget: PactBudget;
    approvedAt: number;
  } | null;
  history: Map<
    number,
    {
      version: number;
      tasks: PactTask[];
      markdown: string;
      eventKind: string;
      ts: number;
    }
  >;
  hasPact: boolean;
  pendingRevision: string | null;
}

export interface PactMutationPayload {
  action?: PactAction | string;
  inviteCode?: string;
  // For edit
  tasks?: Array<Partial<PactTask>> | PactTask[];
  markdown?: string;
  tasksMd?: string;
  disabledTaskIds?: string[];
  removedRequirementIds?: string[];
  acceptMissingCheckResponsibility?: boolean;
  // For approve
  pactVersion?: number;
  approvedTaskIds?: string[];
  budget?: PactBudget;
  // For revise
  prompt?: string;
  feedback?: string;
  message?: string;
  // For stop
  reason?: string;
  // Admin credentials in body
  adminToken?: string;
  adminKey?: string;
  adminSession?: string;
  [key: string]: unknown;
}

export interface PactMutationResult {
  ok: boolean;
  status: number;
  data?: Record<string, unknown>;
  error?: string;
  code?: string;
  details?: unknown;
  errors?: unknown[];
  warnings?: string[];
  flaggedTasks?: FlaggedTaskDependency[];
  pactVersion?: number;
  tasks?: PactTask[];
  markdown?: string;
  diff?: {
    added: string[];
    removed: string[];
    modified: string[];
  };
  approvedTaskIds?: string[];
  disabledTaskIds?: string[];
  budget?: PactBudget;
  phase?: string;
  feedback?: string;
  outcome?: string;
}

// ---------------------------------------------------------------------------
// State Extraction Helper
// ---------------------------------------------------------------------------

export function extractPactState(
  runId: string,
  eventStore: EventStore
): ExtractedPactState {
  const events = eventStore.getEvents(runId, {
    kinds: [
      "pact.drafted",
      "pact.edited",
      "pact.revision",
      "pact.approved",
    ],
  });

  const history = new Map<
    number,
    {
      version: number;
      tasks: PactTask[];
      markdown: string;
      eventKind: string;
      ts: number;
    }
  >();

  let latestVersion = 0;
  let currentTasks: PactTask[] = [];
  let currentMarkdown = "";
  let isApproved = false;
  let approvedRecord: ExtractedPactState["approvedRecord"] = null;
  let pendingRevision: string | null = null;

  for (const ev of events) {
    const d = (ev.data ?? {}) as Record<string, unknown>;

    if (ev.kind === "pact.drafted" || ev.kind === "pact.edited") {
      const v =
        typeof d.pactVersion === "number"
          ? d.pactVersion
          : latestVersion + 1;
      const tasks = Array.isArray(d.tasks)
        ? (d.tasks as PactTask[])
        : currentTasks;
      const md =
        typeof d.markdown === "string" ? d.markdown : renderPact(tasks);

      if (v >= latestVersion) {
        latestVersion = v;
        currentTasks = tasks;
        currentMarkdown = md;
      }

      history.set(v, {
        version: v,
        tasks,
        markdown: md,
        eventKind: ev.kind,
        ts: ev.ts,
      });

      pendingRevision = null;
    } else if (ev.kind === "pact.revision") {
      pendingRevision = typeof d.feedback === "string" ? d.feedback : "";
    } else if (ev.kind === "pact.approved") {
      isApproved = true;
      const v =
        typeof d.pactVersion === "number" ? d.pactVersion : latestVersion;
      const approvedTaskIds = Array.isArray(d.approvedTaskIds)
        ? (d.approvedTaskIds as string[])
        : [];
      const disabledTaskIds = Array.isArray(d.disabledTaskIds)
        ? (d.disabledTaskIds as string[])
        : [];
      const budget = (d.budget ?? {
        maxMinutes: 60,
        maxParallel: 2,
      }) as PactBudget;

      approvedRecord = {
        pactVersion: v,
        approvedTaskIds,
        disabledTaskIds,
        budget,
        approvedAt: ev.ts,
      };
    }
  }

  return {
    latestVersion,
    currentTasks,
    currentMarkdown,
    isApproved,
    approvedRecord,
    history,
    hasPact: latestVersion > 0 || currentTasks.length > 0,
    pendingRevision,
  };
}

// ---------------------------------------------------------------------------
// Caller Credentials Extraction
// ---------------------------------------------------------------------------

function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, "utf8");
  const bufB = Buffer.from(expected, "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function extractCallerCredentials(
  requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>,
  body?: Record<string, unknown>
): CallerCredentials {
  let inviteCode: string | undefined;

  const getHeader = (name: string): string | undefined => {
    if (!requestOrHeaders) return undefined;
    const lowerName = name.toLowerCase();

    if ("headers" in requestOrHeaders && requestOrHeaders.headers) {
      const reqHeaders = requestOrHeaders.headers;
      if (typeof (reqHeaders as Headers).get === "function") {
        return (reqHeaders as Headers).get(lowerName) ?? undefined;
      }
    }
    if (typeof (requestOrHeaders as Headers).get === "function") {
      return (requestOrHeaders as Headers).get(lowerName) ?? undefined;
    }
    const raw = (requestOrHeaders as Record<string, unknown>)[lowerName] ??
      (requestOrHeaders as Record<string, unknown>)[name];
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
    return undefined;
  };

  const headerCode = getHeader("x-invite-code") ?? getHeader("x-invite");
  if (headerCode && headerCode.trim().length > 0) {
    inviteCode = headerCode.trim();
  }

  const authHeader = getHeader("authorization");
  const bearerToken =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : undefined;
  if (!inviteCode && bearerToken && bearerToken.length > 0) {
    inviteCode = bearerToken;
  }

  if (
    !inviteCode &&
    body &&
    typeof body.inviteCode === "string" &&
    body.inviteCode.trim().length > 0
  ) {
    inviteCode = body.inviteCode.trim();
  }

  if (!inviteCode && requestOrHeaders && "url" in requestOrHeaders && typeof (requestOrHeaders as Request).url === "string") {
    try {
      const url = new URL((requestOrHeaders as Request).url);
      const qCode = url.searchParams.get("inviteCode") ?? url.searchParams.get("code");
      if (qCode && qCode.trim().length > 0) {
        inviteCode = qCode.trim();
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  const expectedAdminToken = (
    process.env.ADMIN_TOKEN ?? process.env.ADMIN_KEY
  )?.trim();

  let isAdmin = false;
  if (expectedAdminToken) {
    const adminCandidates: string[] = [];
    for (const hName of [
      "x-admin-token",
      "x-admin-key",
      "admin-session",
      "x-admin-session",
    ]) {
      const hv = getHeader(hName);
      if (hv && hv.trim().length > 0) {
        adminCandidates.push(hv.trim());
      }
    }
    if (bearerToken && bearerToken.length > 0) {
      adminCandidates.push(bearerToken);
    }
    const cookieHeader = getHeader("cookie");
    const adminCookie = cookieHeader
      ?.split(";")
      .find((c) => c.trim().startsWith("admin_session="))
      ?.trim()
      .slice("admin_session=".length)
      .trim();
    if (adminCookie) {
      adminCandidates.push(adminCookie);
    }
    if (body) {
      for (const field of ["adminToken", "adminKey", "adminSession"] as const) {
        const bv = body[field];
        if (typeof bv === "string" && bv.trim().length > 0) {
          adminCandidates.push(bv.trim());
        }
      }
    }
    isAdmin = adminCandidates.some((candidate) =>
      timingSafeTokenEqual(candidate, expectedAdminToken)
    );
  }

  return { inviteCode, isAdmin };
}

// ---------------------------------------------------------------------------
// Run Authorization Check
// ---------------------------------------------------------------------------

export function matchesRunInviteCode(
  run: Pick<RunRecord, "inviteCodeHash">,
  inviteCode: string,
  runStore?: RunStore
): boolean {
  if (!run.inviteCodeHash) {
    return true;
  }
  const clean = inviteCode.trim();
  if (!clean) {
    return false;
  }
  if (runStore) {
    const details = runStore.lookupInviteCodeDetails(clean);
    if (details.codeHash && details.codeHash === run.inviteCodeHash) {
      return true;
    }
  }
  const directHash = crypto.createHash("sha256").update(clean).digest("hex");
  return directHash === run.inviteCodeHash;
}

export function checkRunAuthorization(
  run: RunRecord,
  requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>,
  body?: Record<string, unknown>,
  runStore?: RunStore
): AuthCheckResult {
  const creds = extractCallerCredentials(requestOrHeaders, body);

  if (creds.isAdmin) {
    return { authorized: true, status: 200 };
  }

  // If the run has no inviteCodeHash set, allow access
  if (!run.inviteCodeHash) {
    return { authorized: true, status: 200 };
  }

  if (!creds.inviteCode) {
    return {
      authorized: false,
      reason: "Missing invite code for mutating route",
      status: 401,
    };
  }

  if (
    matchesRunInviteCode(run, creds.inviteCode, runStore) ||
    creds.inviteCode === run.inviteCodeHash
  ) {
    return { authorized: true, status: 200 };
  }

  return {
    authorized: false,
    reason: "Invite code does not match this run owner",
    status: 403,
  };
}

/**
 * Shared invite-code / verified-admin gate for mutating `/api/runs/[runId]/*`
 * routes when `run?.inviteCodeHash` is present. Returns a 401/403 `Response`
 * on failure, or `null` when authorized.
 */
export function authorizeMutatingRunRequest(
  run: RunRecord | null | undefined,
  requestOrHeaders: Request | Headers | Record<string, string | string[] | undefined>,
  body: Record<string, unknown> | undefined,
  runStore: RunStore,
  actionLabel = "modify this run"
): Response | null {
  if (!run?.inviteCodeHash) {
    return null;
  }
  const creds = extractCallerCredentials(requestOrHeaders, body);
  if (creds.isAdmin) {
    return null;
  }
  if (!creds.inviteCode) {
    return Response.json(
      {
        ok: false,
        error: `Invite code is required to ${actionLabel}`,
        code: "MISSING_INVITE_CODE",
      },
      { status: 401 }
    );
  }
  if (!matchesRunInviteCode(run, creds.inviteCode, runStore)) {
    return Response.json(
      {
        ok: false,
        error: "Invite code does not match this run owner",
        code: "INVALID_INVITE_CODE",
      },
      { status: 403 }
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase Constraints Check
// ---------------------------------------------------------------------------

export function checkPhaseConstraints(
  currentPhase: RunPhase | string | undefined | null,
  action: PactAction
): { ok: boolean; status: number; error?: string; code?: string } {
  if (currentPhase === "done") {
    if (action === "stop") {
      return { ok: true, status: 200 };
    }
    return {
      ok: false,
      status: 409,
      error: "Run has already completed and cannot be modified",
      code: "RUN_COMPLETED",
    };
  }

  if (
    (currentPhase === "queued" || currentPhase === "exhume") &&
    (action === "edit" || action === "approve")
  ) {
    return {
      ok: false,
      status: 409,
      error: `Pact is not ready for review in phase '${currentPhase}'`,
      code: "INVALID_RUN_PHASE",
    };
  }

  return { ok: true, status: 200 };
}

// ---------------------------------------------------------------------------
// Action Inference Helper
// ---------------------------------------------------------------------------

export function inferPactAction(
  body: Record<string, unknown>
): PactAction | null {
  if (
    body.action === "edit" ||
    body.action === "approve" ||
    body.action === "revise" ||
    body.action === "stop"
  ) {
    return body.action as PactAction;
  }
  if (body.approvedTaskIds !== undefined) {
    return "approve";
  }
  if (
    body.tasks !== undefined ||
    body.markdown !== undefined ||
    body.tasksMd !== undefined
  ) {
    return "edit";
  }
  if (
    body.prompt !== undefined ||
    body.feedback !== undefined ||
    body.message !== undefined
  ) {
    return "revise";
  }
  if (body.reason !== undefined) {
    return "stop";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

export function executePactEdit(
  runId: string,
  body: PactMutationPayload,
  runStore: RunStore,
  eventStore: EventStore,
  run?: RunRecord | null,
  pactState?: ExtractedPactState
): PactMutationResult {
  const state = pactState ?? extractPactState(runId, eventStore);
  let candidateTasks: PactTask[] | undefined;

  const rawMarkdown = body.markdown ?? body.tasksMd;
  if (typeof rawMarkdown === "string") {
    const parseResult = parsePact(rawMarkdown);
    if (!parseResult.ok) {
      return {
        ok: false,
        status: 400,
        error: "Pact markdown parsing failed",
        errors: parseResult.errors,
        code: "PARSE_ERROR",
      };
    }
    candidateTasks = parseResult.tasks;
  } else if (Array.isArray(body.tasks)) {
    candidateTasks = body.tasks as unknown as PactTask[];
  } else {
    return {
      ok: false,
      status: 400,
      error: "Either tasks or markdown must be provided for edit action",
      code: "MISSING_TASKS",
    };
  }

  const validation = validateEdit(state.currentTasks, candidateTasks, {
    disabledTaskIds: body.disabledTaskIds,
    removedRequirementIds: body.removedRequirementIds,
    acceptMissingCheckResponsibility: body.acceptMissingCheckResponsibility,
  });

  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      error: "Pact validation failed",
      errors: validation.errors,
      warnings: validation.warnings,
      flaggedTasks: validation.flaggedTasks,
      code: "VALIDATION_FAILED",
    };
  }

  const nextVersion = state.latestVersion > 0 ? state.latestVersion + 1 : 1;
  const rendered = renderPact(candidateTasks);

  // If run was in plan phase, advance to pact_review and pause clock (Requirement 13.1)
  if (run && run.phase === "plan") {
    runStore.updateRun(runId, { phase: "pact_review" });
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: "plan", to: "pact_review", refs: [] },
      }) as Parameters<EventStore["append"]>[0]
    );
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.clock",
        actor: "necromancer",
        data: { action: "pause", phase: "pact_review", refs: [] },
      }) as Parameters<EventStore["append"]>[0]
    );
  }

  // Emit pact.edited event (Requirement 13.2, 36.14)
  eventStore.append(
    redactEvent({
      runId,
      kind: "pact.edited",
      actor: "user",
      data: {
        pactVersion: nextVersion,
        tasks: candidateTasks,
        markdown: rendered,
        diff: {
          added: validation.addedTaskIds,
          removed: validation.removedTaskIds,
          modified: validation.modifiedTaskIds,
        },
        flaggedTasks: validation.flaggedTasks,
        warnings: validation.warnings,
        refs: [],
      },
    }) as Parameters<EventStore["append"]>[0]
  );

  return {
    ok: true,
    status: 200,
    pactVersion: nextVersion,
    tasks: candidateTasks,
    markdown: rendered,
    diff: {
      added: validation.addedTaskIds,
      removed: validation.removedTaskIds,
      modified: validation.modifiedTaskIds,
    },
    flaggedTasks: validation.flaggedTasks,
    warnings: validation.warnings,
  };
}

export function executePactApprove(
  runId: string,
  body: PactMutationPayload,
  runStore: RunStore,
  eventStore: EventStore,
  run?: RunRecord | null,
  pactState?: ExtractedPactState
): PactMutationResult {
  const state = pactState ?? extractPactState(runId, eventStore);

  if (!body.approvedTaskIds || body.approvedTaskIds.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "approvedTaskIds is required and cannot be empty",
      code: "MISSING_APPROVED_TASKS",
    };
  }

  if (!body.budget) {
    return {
      ok: false,
      status: 400,
      error: "budget is required for approve action",
      code: "MISSING_BUDGET",
    };
  }

  const tasksToApprove = state.currentTasks;
  if (tasksToApprove.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Cannot approve: current Pact has no tasks",
      code: "NO_TASKS",
    };
  }

  const versionToApprove = body.pactVersion ?? (state.latestVersion || 1);
  const ceiling = (run?.caps as BudgetCeiling) ?? undefined;

  const approval = recordApproval(tasksToApprove, {
    approvedTaskIds: body.approvedTaskIds,
    pactVersion: versionToApprove,
    budget: body.budget as PactBudget,
    actor: "user",
    runId,
    ceiling,
  });

  if (!approval.ok) {
    return {
      ok: false,
      status: 400,
      error: "Approval rejected",
      errors: approval.errors,
      flaggedTasks: approval.flaggedTasks,
      code: "APPROVAL_REJECTED",
    };
  }

  // Emit pact.approved event (Requirement 13.4)
  eventStore.append(
    redactEvent({
      runId,
      kind: "pact.approved",
      actor: "user",
      data: {
        pactVersion: approval.pactVersion,
        approvedTaskIds: approval.approvedTaskIds,
        disabledTaskIds: approval.disabledTaskIds,
        budget: approval.budget,
        refs: [],
      },
    }) as Parameters<EventStore["append"]>[0]
  );

  // Advance phase to legion and resume clock (Requirement 13.8, 36.7)
  const oldPhase = run?.phase ?? "pact_review";
  if (run) {
    runStore.updateRun(runId, { phase: "legion" });
  }
  eventStore.append(
    redactEvent({
      runId,
      kind: "run.phase",
      actor: "necromancer",
      data: { from: oldPhase, to: "legion", refs: [] },
    }) as Parameters<EventStore["append"]>[0]
  );
  eventStore.append(
    redactEvent({
      runId,
      kind: "run.clock",
      actor: "necromancer",
      data: { action: "resume", phase: "legion", refs: [] },
    }) as Parameters<EventStore["append"]>[0]
  );

  return {
    ok: true,
    status: 200,
    pactVersion: approval.pactVersion,
    approvedTaskIds: approval.approvedTaskIds,
    disabledTaskIds: approval.disabledTaskIds,
    budget: approval.budget,
    flaggedTasks: approval.flaggedTasks,
    phase: "legion",
  };
}

export function executePactRevise(
  runId: string,
  body: PactMutationPayload,
  eventStore: EventStore,
  pactState?: ExtractedPactState
): PactMutationResult {
  const state = pactState ?? extractPactState(runId, eventStore);
  const feedback = body.prompt ?? body.feedback ?? body.message ?? "";
  const version = state.latestVersion || 1;

  // Emit pact.revision event (Requirement 13.3)
  eventStore.append(
    redactEvent({
      runId,
      kind: "pact.revision",
      actor: "user",
      data: {
        pactVersion: version,
        feedback,
        refs: [],
      },
    }) as Parameters<EventStore["append"]>[0]
  );

  return {
    ok: true,
    status: 200,
    pactVersion: version,
    feedback,
    data: { status: "revision_requested" },
  };
}

export function executePactStop(
  runId: string,
  body: PactMutationPayload,
  runStore: RunStore,
  eventStore: EventStore,
  run?: RunRecord | null
): PactMutationResult {
  const now = Date.now();
  const oldPhase = run?.phase ?? "pact_review";

  if (run) {
    runStore.updateRun(runId, {
      phase: "done",
      outcome: "cancelled",
      endedAt: now,
    });
  }

  eventStore.append(
    redactEvent({
      runId,
      kind: "run.done",
      actor: "user",
      data: {
        phase: "done",
        outcome: "cancelled",
        reason: body.reason ?? "stopped_by_user",
        refs: [],
      },
    }) as Parameters<EventStore["append"]>[0]
  );

  if (oldPhase !== "done") {
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: oldPhase, to: "done", refs: [] },
      }) as Parameters<EventStore["append"]>[0]
    );
  }

  return {
    ok: true,
    status: 200,
    phase: "done",
    outcome: "cancelled",
    data: { status: "stopped" },
  };
}

// ---------------------------------------------------------------------------
// Unified Mutation Dispatcher
// ---------------------------------------------------------------------------

export function executePactMutation(
  runId: string,
  rawBody: unknown,
  runStore: RunStore,
  eventStore: EventStore,
  requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>
): PactMutationResult {
  if (!runId || typeof runId !== "string" || runId.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      error: "runId is required",
      code: "MISSING_RUN_ID",
    };
  }

  if (!rawBody || typeof rawBody !== "object") {
    return {
      ok: false,
      status: 400,
      error: "Request body must be a JSON object",
      code: "BAD_REQUEST",
    };
  }

  const body = rawBody as PactMutationPayload;
  const action = inferPactAction(body as Record<string, unknown>);

  if (!action) {
    return {
      ok: false,
      status: 400,
      error:
        "Could not determine action. Please supply action (edit, approve, revise, or stop)",
      code: "MISSING_ACTION",
    };
  }

  const run = runStore.getRun(runId);
  const pactState = extractPactState(runId, eventStore);

  // If run record not found and no events exist for runId
  if (!run && !pactState.hasPact && !pactState.isApproved) {
    const existingEvents = eventStore.getEvents(runId, { limit: 1 });
    if (existingEvents.length === 0) {
      return {
        ok: false,
        status: 404,
        error: "Run not found",
        code: "RUN_NOT_FOUND",
      };
    }
  }

  // Caller authentication check
  if (run) {
    const authCheck = checkRunAuthorization(
      run,
      requestOrHeaders,
      body as Record<string, unknown>,
      runStore
    );
    if (!authCheck.authorized) {
      return {
        ok: false,
        status: authCheck.status,
        error: authCheck.reason ?? "Caller unauthorized",
        code: "UNAUTHORIZED",
      };
    }
  }

  // Phase constraint checks
  const phaseCheck = checkPhaseConstraints(run?.phase, action);
  if (!phaseCheck.ok) {
    return {
      ok: false,
      status: phaseCheck.status,
      error: phaseCheck.error,
      code: phaseCheck.code,
    };
  }

  if (run?.phase === "done" && action === "stop") {
    return {
      ok: true,
      status: 200,
      phase: "done",
      outcome: run?.outcome ?? "cancelled",
      data: { status: "stopped" },
    };
  }

  switch (action) {
    case "edit":
      return executePactEdit(runId, body, runStore, eventStore, run, pactState);
    case "approve":
      return executePactApprove(runId, body, runStore, eventStore, run, pactState);
    case "revise":
      return executePactRevise(runId, body, eventStore, pactState);
    case "stop":
      return executePactStop(runId, body, runStore, eventStore, run);
    default:
      return {
        ok: false,
        status: 400,
        error: "Unrecognized action",
        code: "UNKNOWN_ACTION",
      };
  }
}
