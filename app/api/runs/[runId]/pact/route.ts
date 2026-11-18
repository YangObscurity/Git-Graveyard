import { z } from "zod";
import {
  parsePact,
  type PactTask,
} from "@/lib/pact/pact-parser";
import {
  renderPact,
} from "@/lib/pact/pact-renderer";
import {
  validateEdit,
  recordApproval,
  NON_REMOVABLE_REQUIREMENTS,
  BUDGET_CHECK_TERMS_NOTE,
  BUDGET_CREDITS_UNREPORTED_NOTE,
  type PactBudget,
  type BudgetCeiling,
} from "@/lib/pact/pact-review";
import {
  checkRunAuthorization,
  extractPactState,
} from "@/lib/pact/pact-mutation";
import {
  resolveActiveOrchestrator,
  resolveEventStore,
  resolveRunStore,
} from "@/lib/runtime/store-context";
import { redactEvent } from "@/lib/security/redactor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Route Context Interface
// ---------------------------------------------------------------------------

export interface RouteContext {
  params?: Promise<{ runId?: string }> | { runId?: string };
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const baseTaskSchema = z
  .object({
    id: z.string().min(1, "Task ID is required"),
    title: z.string().min(1, "Task title is required"),
    role: z.enum(["bonesetter", "soul-stitcher"]),
    depends: z.array(z.string()).optional(),
    dependencies: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    filesInScope: z.array(z.string()).optional(),
    accept: z.string().optional(),
    acceptanceCommand: z.string().optional(),
    hard: z.union([z.boolean(), z.enum(["yes", "no"])]).optional(),
    hardRaw: z.string().optional(),
    hardFlag: z.boolean().optional(),
    rules: z.array(z.string()).optional(),
    ruleIds: z.array(z.string()).optional(),
    line: z.number().optional(),
  })
  .passthrough();

const budgetSchema = z
  .object({
    maxMinutes: z.number().positive("maxMinutes must be a positive number"),
    maxParallel: z
      .number()
      .int()
      .positive("maxParallel must be a positive integer"),
    maxCredits: z.number().nullable().optional(),
    maxToolCalls: z
      .number()
      .int()
      .positive("maxToolCalls must be a positive integer")
      .optional(),
  })
  .passthrough();

const getQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

const postActionSchema = z
  .object({
    action: z.enum(["edit", "approve", "revise", "stop"]).optional(),
    inviteCode: z.string().optional(),
    // For edit
    tasks: z.array(baseTaskSchema).optional(),
    markdown: z.string().optional(),
    tasksMd: z.string().optional(),
    disabledTaskIds: z.array(z.string()).optional(),
    removedRequirementIds: z.array(z.string()).optional(),
    acceptMissingCheckResponsibility: z.boolean().optional(),
    // For approve
    pactVersion: z.number().int().positive().optional(),
    approvedTaskIds: z.array(z.string()).optional(),
    budget: budgetSchema.optional(),
    // For revise
    prompt: z.string().optional(),
    feedback: z.string().optional(),
    message: z.string().optional(),
    // For stop
    reason: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Helper: Extract RunId
// ---------------------------------------------------------------------------

async function extractRunId(
  request: Request,
  context?: RouteContext
): Promise<string | null> {
  if (context?.params) {
    const resolved = await Promise.resolve(context.params);
    if (
      resolved?.runId &&
      typeof resolved.runId === "string" &&
      resolved.runId.trim().length > 0
    ) {
      return resolved.runId.trim();
    }
  }
  try {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/api\/runs\/([^/]+)\/pact/i);
    if (match && match[1]) {
      return decodeURIComponent(match[1]).trim();
    }
  } catch {
    // Ignore invalid url
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET Handler (Read Pact)
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  const runId = await extractRunId(request, context);
  if (!runId) {
    return Response.json(
      { ok: false, error: "runId is required", code: "MISSING_RUN_ID" },
      { status: 400 }
    );
  }

  // Parse and validate query params
  const url = new URL(request.url);
  const rawQuery = Object.fromEntries(url.searchParams.entries());
  const queryResult = getQuerySchema.safeParse(rawQuery);
  if (!queryResult.success) {
    return Response.json(
      {
        ok: false,
        error: "Invalid query parameters",
        details: queryResult.error.issues,
        code: "INVALID_QUERY",
      },
      { status: 400 }
    );
  }
  const query = queryResult.data;

  const runStore = resolveRunStore(request, context);
  const eventStore = resolveEventStore(request, context, runStore);

  const run = runStore.getRun(runId);
  const pactState = extractPactState(runId, eventStore);

  // If run record not found and no events for runId exist in eventStore
  if (!run && !pactState.hasPact && !pactState.isApproved) {
    const existingEvents = eventStore.getEvents(runId, { limit: 1 });
    if (existingEvents.length === 0) {
      return Response.json(
        { ok: false, error: "Run not found", code: "RUN_NOT_FOUND" },
        { status: 404 }
      );
    }
  }

  // If specific version is requested
  if (query.version !== undefined) {
    const target = pactState.history.get(query.version);
    if (!target) {
      return Response.json(
        {
          ok: false,
          error: `Pact version ${query.version} not found`,
          code: "VERSION_NOT_FOUND",
        },
        { status: 404 }
      );
    }

    return Response.json(
      {
        ok: true,
        runId,
        phase: run?.phase ?? null,
        pactVersion: target.version,
        tasks: target.tasks,
        markdown: target.markdown,
        isApproved:
          pactState.isApproved &&
          pactState.approvedRecord?.pactVersion === target.version,
        approval: pactState.approvedRecord,
        pendingRevision: pactState.pendingRevision,
        nonRemovableRequirements: NON_REMOVABLE_REQUIREMENTS,
        budgetTermsNote: BUDGET_CHECK_TERMS_NOTE,
        creditsNote: BUDGET_CREDITS_UNREPORTED_NOTE,
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

  // If no pact events exist yet
  if (!pactState.hasPact) {
    return Response.json(
      {
        ok: true,
        runId,
        status: "drafting",
        phase: run?.phase ?? "plan",
        pact: null,
        pactVersion: 0,
        tasks: [],
        markdown: "",
        isApproved: false,
        approval: null,
        pendingRevision: null,
        nonRemovableRequirements: NON_REMOVABLE_REQUIREMENTS,
        budgetTermsNote: BUDGET_CHECK_TERMS_NOTE,
        creditsNote: BUDGET_CREDITS_UNREPORTED_NOTE,
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

  return Response.json(
    {
      ok: true,
      runId,
      phase: run?.phase ?? null,
      pactVersion: pactState.latestVersion,
      tasks: pactState.currentTasks,
      markdown: pactState.currentMarkdown,
      isApproved: pactState.isApproved,
      approval: pactState.approvedRecord,
      pendingRevision: pactState.pendingRevision,
      nonRemovableRequirements: NON_REMOVABLE_REQUIREMENTS,
      budgetTermsNote: BUDGET_CHECK_TERMS_NOTE,
      creditsNote: BUDGET_CREDITS_UNREPORTED_NOTE,
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

// ---------------------------------------------------------------------------
// POST Handler (Edit, Approve, Revise, Stop)
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  const runId = await extractRunId(request, context);
  if (!runId) {
    return Response.json(
      { ok: false, error: "runId is required", code: "MISSING_RUN_ID" },
      { status: 400 }
    );
  }

  // Parse JSON body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Invalid JSON body", code: "BAD_JSON" },
      { status: 400 }
    );
  }

  if (!rawBody || typeof rawBody !== "object") {
    return Response.json(
      {
        ok: false,
        error: "Request body must be a JSON object",
        code: "BAD_REQUEST",
      },
      { status: 400 }
    );
  }

  // Validate body against Zod schema
  const parsed = postActionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error: "Validation failed for request body",
        errors: parsed.error.issues,
        code: "VALIDATION_ERROR",
      },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // Infer action if omitted
  let action = body.action;
  if (!action) {
    if (body.approvedTaskIds !== undefined) {
      action = "approve";
    } else if (
      body.tasks !== undefined ||
      body.markdown !== undefined ||
      body.tasksMd !== undefined
    ) {
      action = "edit";
    } else if (
      body.prompt !== undefined ||
      body.feedback !== undefined ||
      body.message !== undefined
    ) {
      action = "revise";
    } else if (body.reason !== undefined) {
      action = "stop";
    } else {
      return Response.json(
        {
          ok: false,
          error:
            "Could not determine action. Please supply action (edit, approve, revise, or stop)",
          code: "MISSING_ACTION",
        },
        { status: 400 }
      );
    }
  }

  const runStore = resolveRunStore(request, context);
  const eventStore = resolveEventStore(request, context, runStore);

  const run = runStore.getRun(runId);
  const pactState = extractPactState(runId, eventStore);

  // If run record not found and no events exist for runId
  if (!run && !pactState.hasPact && !pactState.isApproved) {
    const existingEvents = eventStore.getEvents(runId, { limit: 1 });
    if (existingEvents.length === 0) {
      return Response.json(
        { ok: false, error: "Run not found", code: "RUN_NOT_FOUND" },
        { status: 404 }
      );
    }
  }

  // Check caller authorization (Requirement 13 line 781)
  if (run) {
    const authCheck = checkRunAuthorization(
      run,
      request,
      rawBody as Record<string, unknown>,
      runStore
    );
    if (!authCheck.authorized) {
      return Response.json(
        {
          ok: false,
          error: authCheck.reason ?? "Caller unauthorized",
          code: "UNAUTHORIZED",
        },
        { status: authCheck.status }
      );
    }
  }

  // Enforce run phase constraints
  const currentPhase = run?.phase;
  if (currentPhase === "done") {
    if (action === "stop") {
      return Response.json(
        {
          ok: true,
          runId,
          status: "stopped",
          phase: "done",
          outcome: run?.outcome ?? "cancelled",
        },
        { status: 200 }
      );
    }
    return Response.json(
      {
        ok: false,
        error: "Run has already completed and cannot be modified",
        code: "RUN_COMPLETED",
      },
      { status: 409 }
    );
  }

  if (
    (currentPhase === "queued" || currentPhase === "exhume") &&
    (action === "edit" || action === "approve")
  ) {
    return Response.json(
      {
        ok: false,
        error: `Pact is not ready for review in phase '${currentPhase}'`,
        code: "INVALID_RUN_PHASE",
      },
      { status: 409 }
    );
  }

  // -------------------------------------------------------------------------
  // ACTION: EDIT (Requirement 13.2, 13.5, 36.14, Task 12.5)
  // -------------------------------------------------------------------------
  if (action === "edit") {
    let candidateTasks: PactTask[] | undefined;

    const rawMarkdown = body.markdown ?? body.tasksMd;
    if (typeof rawMarkdown === "string") {
      const parseResult = parsePact(rawMarkdown);
      if (!parseResult.ok) {
        return Response.json(
          {
            ok: false,
            error: "Pact markdown parsing failed",
            errors: parseResult.errors,
            code: "PARSE_ERROR",
          },
          { status: 400 }
        );
      }
      candidateTasks = parseResult.tasks;
    } else if (Array.isArray(body.tasks)) {
      candidateTasks = body.tasks as unknown as PactTask[];
    } else {
      return Response.json(
        {
          ok: false,
          error: "Either tasks or markdown must be provided for edit action",
          code: "MISSING_TASKS",
        },
        { status: 400 }
      );
    }

    const validation = validateEdit(pactState.currentTasks, candidateTasks, {
      disabledTaskIds: body.disabledTaskIds,
      removedRequirementIds: body.removedRequirementIds,
      acceptMissingCheckResponsibility: body.acceptMissingCheckResponsibility,
    });

    if (!validation.ok) {
      return Response.json(
        {
          ok: false,
          error: "Pact validation failed",
          errors: validation.errors,
          warnings: validation.warnings,
          flaggedTasks: validation.flaggedTasks,
          code: "VALIDATION_FAILED",
        },
        { status: 400 }
      );
    }

    const nextVersion =
      pactState.latestVersion > 0 ? pactState.latestVersion + 1 : 1;
    const rendered = renderPact(candidateTasks);

    // If run was in plan phase, advance to pact_review and pause clock
    if (run && run.phase === "plan") {
      runStore.updateRun(runId, { phase: "pact_review" });
      eventStore.append(
        redactEvent({
          runId,
          kind: "run.phase",
          actor: "necromancer",
          data: { from: "plan", to: "pact_review", refs: [] },
        }) as any
      );
      // Requirement 13.1: pause run clock
      eventStore.append(
        redactEvent({
          runId,
          kind: "run.clock",
          actor: "necromancer",
          data: { action: "pause", phase: "pact_review", refs: [] },
        }) as any
      );
    }

    // Emit pact.edited event (Requirement 13.2)
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
      }) as any
    );

    return Response.json(
      {
        ok: true,
        runId,
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
      },
      { status: 200 }
    );
  }

  // -------------------------------------------------------------------------
  // ACTION: APPROVE (Requirement 13.4, 13.8, 36.7, Task 12.5)
  // -------------------------------------------------------------------------
  if (action === "approve") {
    if (!body.approvedTaskIds || body.approvedTaskIds.length === 0) {
      return Response.json(
        {
          ok: false,
          error: "approvedTaskIds is required and cannot be empty",
          code: "MISSING_APPROVED_TASKS",
        },
        { status: 400 }
      );
    }

    if (!body.budget) {
      return Response.json(
        {
          ok: false,
          error: "budget is required for approve action",
          code: "MISSING_BUDGET",
        },
        { status: 400 }
      );
    }

    const tasksToApprove = pactState.currentTasks;
    if (tasksToApprove.length === 0) {
      return Response.json(
        {
          ok: false,
          error: "Cannot approve: current Pact has no tasks",
          code: "NO_TASKS",
        },
        { status: 400 }
      );
    }

    const versionToApprove =
      body.pactVersion ?? (pactState.latestVersion || 1);
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
      return Response.json(
        {
          ok: false,
          error: "Approval rejected",
          errors: approval.errors,
          flaggedTasks: approval.flaggedTasks,
          code: "APPROVAL_REJECTED",
        },
        { status: 400 }
      );
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
      }) as any
    );

    // Advance phase to legion (Requirement 13.8, 36.7)
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
      }) as any
    );
    eventStore.append(
      redactEvent({
        runId,
        kind: "run.clock",
        actor: "necromancer",
        data: { action: "resume", phase: "legion", refs: [] },
      }) as any
    );

    const orchApprove = resolveActiveOrchestrator(request, context);
    if (orchApprove && typeof orchApprove.approvePact === "function") {
      try {
        await orchApprove.approvePact(runId, {
          approvedTaskIds: approval.approvedTaskIds,
          caps: (run?.caps as Record<string, unknown>) ?? {},
          approvedBy: "user",
        });
      } catch {
        // fire safely without breaking route response
      }
    }

    return Response.json(
      {
        ok: true,
        runId,
        pactVersion: approval.pactVersion,
        approvedTaskIds: approval.approvedTaskIds,
        disabledTaskIds: approval.disabledTaskIds,
        budget: approval.budget,
        flaggedTasks: approval.flaggedTasks,
        phase: "legion",
      },
      { status: 200 }
    );
  }

  // -------------------------------------------------------------------------
  // ACTION: REVISE (Requirement 13.3, Task 12.5)
  // -------------------------------------------------------------------------
  if (action === "revise") {
    const feedback = body.prompt ?? body.feedback ?? body.message ?? "";
    const version = pactState.latestVersion || 1;

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
      }) as any
    );

    const orchRevise = resolveActiveOrchestrator(request, context);
    if (orchRevise && typeof orchRevise.revisePact === "function") {
      try {
        await orchRevise.revisePact(runId, feedback);
      } catch {
        // fire safely if run is not actively executing
      }
    }

    return Response.json(
      {
        ok: true,
        runId,
        status: "revision_requested",
        pactVersion: version,
        feedback,
      },
      { status: 200 }
    );
  }

  // -------------------------------------------------------------------------
  // ACTION: STOP (Task 12.5)
  // -------------------------------------------------------------------------
  if (action === "stop") {
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
      }) as any
    );

    if (oldPhase !== "done") {
      eventStore.append(
        redactEvent({
          runId,
          kind: "run.phase",
          actor: "necromancer",
          data: { from: oldPhase, to: "done", refs: [] },
        }) as any
      );
    }

    const orchStop = resolveActiveOrchestrator(request, context);
    if (orchStop && typeof orchStop.stopRun === "function") {
      try {
        await orchStop.stopRun(runId, body.reason ?? "stopped_by_user");
      } catch {
        // fire safely
      }
    }

    return Response.json(
      {
        ok: true,
        runId,
        status: "stopped",
        phase: "done",
        outcome: "cancelled",
      },
      { status: 200 }
    );
  }

  return Response.json(
    { ok: false, error: "Unrecognized action", code: "UNKNOWN_ACTION" },
    { status: 400 }
  );
}

// ---------------------------------------------------------------------------
// PUT and PATCH Aliases
// ---------------------------------------------------------------------------

export async function PUT(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  return POST(request, context);
}

export async function PATCH(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  return POST(request, context);
}
