// Task 13.2: Deterministic Scheduler dependency evaluation and slot controller
// Requirements: 13.8, 13.9, 13.10, 23.1, 23.2, 23.3, 23.4, 23.5, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14, 23.15

import {
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
  MODEL_TIER_OPUS,
  MODEL_TIER_SONNET,
  type AllowedModelId,
  type ModelTier,
} from "../agents/model-allowlist";
import type { EventEnvelope } from "../events/types";
import {
  parsePact,
  parsePactOrThrow,
  type PactTask,
} from "../pact/pact-parser";
import {
  OPEN_TASK_STATES,
  TERMINAL_TASK_STATES,
  VALID_TASK_TRANSITIONS,
  type ConcurrencyCaps,
  type EmitFunction,
  type MergeTaskResult,
  type RejectTaskOptions,
  type ScheduledTask,
  type SchedulerAsk,
  type SchedulerOptions,
  type SchedulerSummary,
  type SlotStatus,
  type TaskMergeEvidence,
  type TaskState,
} from "./types";
import { checkMergeGate } from "../warden/merge-gate";
import { isVerifiedMerge, type VerifiedMerge } from "../git/git-service";
import { candidateSha256FromDiff } from "../merge/candidate-hash";

/**
 * Deterministic Scheduler dependency evaluator and slot controller.
 * Operates purely in memory without I/O, Git calls, or LLM / model invocations.
 */
export class Scheduler {
  private readonly _runId: string;
  private readonly _actor: string;
  private readonly _emit?: EmitFunction;
  private readonly _now: () => number;

  private _tasks: ScheduledTask[] = [];
  private _taskMap: Map<string, ScheduledTask> = new Map();
  private _asks: SchedulerAsk[] = [];

  private _approvedTaskIds?: Set<string>;
  private _pactApproved: boolean = true;
  private _pactVersion?: number;

  private _runParallelCap: number = 1;
  private _globalSkeletonLimit?: number;
  private _runningMax?: number;
  private _maxAttempts: number = 3;

  private _stopRequested: boolean = false;
  private _stopReason?: string;
  private _budgetExceeded: boolean = false;
  private _budgetReason?: string;

  private _inCompensationRollback: boolean = false;

  private _seq: number = 1;

  constructor(
    pactOrOptions?: string | PactTask[] | { tasks: PactTask[] } | SchedulerOptions,
    maybeOptions?: SchedulerOptions
  ) {
    let options: SchedulerOptions = {};

    if (typeof pactOrOptions === "string") {
      options = { pact: pactOrOptions, ...(maybeOptions ?? {}) };
    } else if (Array.isArray(pactOrOptions)) {
      options = { tasks: pactOrOptions, ...(maybeOptions ?? {}) };
    } else if (pactOrOptions && typeof pactOrOptions === "object") {
      if ("tasks" in pactOrOptions && Array.isArray((pactOrOptions as { tasks: unknown }).tasks)) {
        options = { ...(pactOrOptions as SchedulerOptions), ...(maybeOptions ?? {}) };
      } else {
        options = { ...(pactOrOptions as SchedulerOptions), ...(maybeOptions ?? {}) };
      }
    } else if (maybeOptions) {
      options = { ...maybeOptions };
    }

    this._runId = options.runId ?? `run-${Date.now()}`;
    this._actor = options.actor ?? "scheduler";
    this._emit = options.emit;
    this._now = options.now ?? Date.now;

    this._runParallelCap =
      typeof options.runParallelCap === "number" && options.runParallelCap >= 0
        ? options.runParallelCap
        : 1;
    this._globalSkeletonLimit = options.globalSkeletonLimit;
    this._runningMax = options.runningMax;
    this._maxAttempts =
      typeof options.maxAttempts === "number" && options.maxAttempts > 0
        ? options.maxAttempts
        : 3;

    if (options.pactApproved !== undefined) {
      this._pactApproved = options.pactApproved;
    } else if (options.approvedTaskIds !== undefined) {
      this._pactApproved = true;
    } else {
      this._pactApproved = true;
    }

    this._pactVersion = options.pactVersion;

    if (options.approvedTaskIds) {
      this._approvedTaskIds = new Set(options.approvedTaskIds);
    }

    // Load tasks
    let rawTasks: PactTask[] = [];
    if (typeof options.pact === "string") {
      rawTasks = parsePactOrThrow(options.pact);
    } else if (options.tasks && Array.isArray(options.tasks)) {
      rawTasks = options.tasks;
    } else if (
      options.pact &&
      typeof options.pact === "object" &&
      "tasks" in options.pact &&
      Array.isArray(options.pact.tasks)
    ) {
      rawTasks = options.pact.tasks;
    }

    this.initializeTasks(rawTasks);
  }

  // ---------------------------------------------------------------------------
  // Initialization & Dependency Graph Construction
  // ---------------------------------------------------------------------------

  private initializeTasks(rawTasks: PactTask[]): void {
    this._tasks = [];
    this._taskMap.clear();
    this._asks = [];

    // First pass: create ScheduledTask instances preserving order
    for (let index = 0; index < rawTasks.length; index++) {
      const raw = rawTasks[index];
      const deps = Array.from(
        new Set(raw.dependencies ?? raw.depends ?? raw.dependsOn ?? [])
      );

      const isHard = Boolean(raw.hard || raw.hardFlag || raw.hardRaw === "yes");
      const modelTier: AllowedModelId = isHard
        ? CLAUDE_OPUS_5_5_MODEL_ID
        : CLAUDE_SONNET_5_5_MODEL_ID;
      const modelTierName: ModelTier = isHard
        ? MODEL_TIER_OPUS
        : MODEL_TIER_SONNET;

      // Requirement 23.7, 23.11: Turn off in Pact -> set to skipped
      let initialState: TaskState = "pending";
      if (this._approvedTaskIds && !this._approvedTaskIds.has(raw.id)) {
        initialState = "skipped";
      }

      const scheduledTask: ScheduledTask = {
        id: raw.id,
        title: raw.title,
        role: raw.role,
        state: initialState,
        dependencies: deps,
        dependents: [],
        files: raw.files ?? raw.filesInScope ?? [],
        filesInScope: raw.filesInScope ?? raw.files ?? [],
        acceptanceCommand: raw.acceptanceCommand ?? raw.accept ?? "",
        accept: raw.accept ?? raw.acceptanceCommand ?? "",
        hard: isHard,
        hardRaw: isHard ? "yes" : "no",
        rules: raw.rules ?? raw.ruleIds ?? [],
        ruleIds: raw.ruleIds ?? raw.rules ?? [],
        attempts: 0,
        maxAttempts: this._maxAttempts,
        order: index,
        line: raw.line ?? index + 1,
        modelTier,
        modelTierName,
        raw,
      };

      this._tasks.push(scheduledTask);
      this._taskMap.set(scheduledTask.id, scheduledTask);
    }

    // Second pass: wire reverse dependents
    for (const task of this._tasks) {
      for (const depId of task.dependencies) {
        const depTask = this._taskMap.get(depId);
        if (depTask && !depTask.dependents.includes(task.id)) {
          depTask.dependents.push(task.id);
        }
      }
    }

    // Evaluate initial dependency readiness
    this.evaluateAllDependencies();
  }

  // ---------------------------------------------------------------------------
  // Concurrency & Slot Controller (Requirement 23.5)
  // ---------------------------------------------------------------------------

  /**
   * Calculates the live Skeleton concurrency limit as the minimum of the run parallel cap,
   * global Skeleton limit, and ExecutionBackend runningMax.
   * Requirement 23.5.
   */
  public getEffectiveLimit(): number {
    const limits: number[] = [];

    if (
      typeof this._runParallelCap === "number" &&
      !Number.isNaN(this._runParallelCap) &&
      this._runParallelCap >= 0
    ) {
      limits.push(this._runParallelCap);
    }

    if (
      typeof this._globalSkeletonLimit === "number" &&
      !Number.isNaN(this._globalSkeletonLimit) &&
      this._globalSkeletonLimit >= 0
    ) {
      limits.push(this._globalSkeletonLimit);
    }

    if (
      typeof this._runningMax === "number" &&
      !Number.isNaN(this._runningMax) &&
      this._runningMax >= 0
    ) {
      limits.push(this._runningMax);
    }

    if (limits.length === 0) {
      return 1;
    }

    return Math.min(...limits);
  }

  public getConcurrencyLimit(): number {
    return this.getEffectiveLimit();
  }

  /**
   * Returns the count of live Skeletons (currently running tasks).
   */
  public getLiveSkeletonsCount(): number {
    return this.getRunningTasks().length;
  }

  /**
   * Returns available dispatch slots.
   */
  public getAvailableSlots(): number {
    const limit = this.getEffectiveLimit();
    const live = this.getLiveSkeletonsCount();
    return Math.max(0, limit - live);
  }

  public getSlotStatus(): SlotStatus {
    return {
      runParallelCap: this._runParallelCap,
      globalSkeletonLimit: this._globalSkeletonLimit ?? Infinity,
      runningMax: this._runningMax ?? Infinity,
      effectiveLimit: this.getEffectiveLimit(),
      liveCount: this.getLiveSkeletonsCount(),
      availableSlots: this.getAvailableSlots(),
    };
  }

  public setParallelCap(cap: number): void {
    if (typeof cap === "number" && cap >= 0) {
      this._runParallelCap = cap;
    }
  }

  public setRunParallelCap(cap: number): void {
    this.setParallelCap(cap);
  }

  public setGlobalSkeletonLimit(limit?: number): void {
    this._globalSkeletonLimit = limit;
  }

  public setRunningMax(max?: number): void {
    this._runningMax = max;
  }

  // ---------------------------------------------------------------------------
  // Stop & Budget Controls (Requirement 23.9)
  // ---------------------------------------------------------------------------

  public requestStop(reason = "User requested stop"): void {
    this._stopRequested = true;
    this._stopReason = reason;
  }

  public setBudgetExceeded(exceeded = true, reason = "Budget cap exceeded"): void {
    this._budgetExceeded = exceeded;
    this._budgetReason = reason;
  }

  public get isStopRequested(): boolean {
    return this._stopRequested;
  }

  public get stopReason(): string | undefined {
    return this._stopReason;
  }

  public get isBudgetExceeded(): boolean {
    return this._budgetExceeded;
  }

  public get budgetReason(): string | undefined {
    return this._budgetReason;
  }

  /**
   * Returns true when every task is in a terminal state (merged, failed, abandoned, skipped).
   * Requirement 23.9.
   */
  public isAllTerminal(): boolean {
    if (this._tasks.length === 0) {
      return true;
    }
    return this._tasks.every((task) =>
      (TERMINAL_TASK_STATES as readonly string[]).includes(task.state)
    );
  }

  // ---------------------------------------------------------------------------
  // Pact Approval & Task Inclusion (Requirements 13.8, 23.7, 23.11)
  // ---------------------------------------------------------------------------

  public get isPactApproved(): boolean {
    return this._pactApproved;
  }

  public approvePact(
    approvedTaskIds?: string[] | Set<string> | readonly string[],
    pactVersion?: number
  ): void {
    this._pactApproved = true;
    if (typeof pactVersion === "number") {
      this._pactVersion = pactVersion;
    }

    if (approvedTaskIds) {
      this._approvedTaskIds = new Set(approvedTaskIds);

      // Disable tasks not in approvedTaskIds
      for (const task of this._tasks) {
        if (!this._approvedTaskIds.has(task.id) && !this.isTerminalState(task.state)) {
          this.transitionTask(task, "skipped", {
            reason: "Not in approvedTaskIds of approved Pact",
          });
          this.handleDependencyTerminalFailure(task.id, "skipped");
        }
      }
    }

    this.evaluateAllDependencies();
  }

  public getApprovedTaskIds(): Set<string> | undefined {
    return this._approvedTaskIds ? new Set(this._approvedTaskIds) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Queue Queries & Ordering (Requirement 23.14)
  // ---------------------------------------------------------------------------

  public getTasks(): ScheduledTask[] {
    return [...this._tasks];
  }

  public getTask(taskId: string): ScheduledTask | undefined {
    return this._taskMap.get(taskId);
  }

  public getTasksByState(state: TaskState): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === state);
  }

  /**
   * Returns ready tasks ordered strictly by their original position in tasks.md.
   * Requirement 23.14.
   */
  public getReadyTasks(): ScheduledTask[] {
    return this._tasks
      .filter((t) => t.state === "ready")
      .sort((a, b) => a.order - b.order);
  }

  public getRunningTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "running");
  }

  public getPendingTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "pending");
  }

  public getBlockedTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "blocked");
  }

  public getInReviewTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "in_review");
  }

  public getRejectedTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "rejected");
  }

  public getMergedTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "merged");
  }

  public getFailedTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "failed");
  }

  public getAbandonedTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "abandoned");
  }

  public getSkippedTasks(): ScheduledTask[] {
    return this._tasks.filter((t) => t.state === "skipped");
  }

  public getTerminalTasks(): ScheduledTask[] {
    return this._tasks.filter((t) =>
      (TERMINAL_TASK_STATES as readonly string[]).includes(t.state)
    );
  }

  public getOpenTasks(): ScheduledTask[] {
    return this._tasks.filter((t) =>
      (OPEN_TASK_STATES as readonly string[]).includes(t.state)
    );
  }

  // ---------------------------------------------------------------------------
  // Dispatching (Requirements 13.8, 23.5, 23.7, 23.8, 23.9, 23.14, 23.15)
  // ---------------------------------------------------------------------------

  /**
   * Checks whether new tasks can be dispatched.
   * Requirements: 13.8, 23.5, 23.9.
   */
  public canDispatch(): boolean {
    if (!this._pactApproved) {
      return false;
    }
    if (this._stopRequested) {
      return false;
    }
    if (this._budgetExceeded) {
      return false;
    }
    if (this.isAllTerminal()) {
      return false;
    }
    if (this.getAvailableSlots() <= 0) {
      return false;
    }
    return this.getReadyTasks().length > 0;
  }

  /**
   * Dispatches ready tasks in tasks.md priority order up to the available slots.
   * Pure deterministic decision without any model call (Requirement 23.8).
   * Requirements: 23.5, 23.7, 23.8, 23.9, 23.14, 23.15.
   */
  public dispatchNext(count?: number): ScheduledTask[] {
    if (!this.canDispatch()) {
      return [];
    }

    const availableSlots = this.getAvailableSlots();
    const limit = Math.min(
      typeof count === "number" && count > 0 ? count : availableSlots,
      availableSlots
    );

    if (limit <= 0) {
      return [];
    }

    const readyQueue = this.getReadyTasks();
    const toDispatch = readyQueue.slice(0, limit);
    const dispatched: ScheduledTask[] = [];

    for (const task of toDispatch) {
      // Requirement 23.7: only tasks in approvedTaskIds
      if (this._approvedTaskIds && !this._approvedTaskIds.has(task.id)) {
        continue;
      }

      task.attempts += 1;
      this.transitionTask(task, "running", { actor: this._actor });
      dispatched.push(task);
    }

    return dispatched;
  }

  /**
   * Dispatches a specific task by ID if ready and slots are available.
   */
  public dispatchTask(taskId: string): ScheduledTask | null {
    if (!this.canDispatch()) {
      return null;
    }

    const task = this._taskMap.get(taskId);
    if (!task || task.state !== "ready") {
      return null;
    }

    if (this._approvedTaskIds && !this._approvedTaskIds.has(task.id)) {
      return null;
    }

    task.attempts += 1;
    this.transitionTask(task, "running", { actor: this._actor });
    return task;
  }

  // ---------------------------------------------------------------------------
  // Task State Transitions & Lifecycle
  // ---------------------------------------------------------------------------

  public markInReview(taskId: string): ScheduledTask {
    const task = this.requireTask(taskId);
    this.transitionTask(task, "in_review", { actor: this._actor });
    return task;
  }

  public submitForReview(taskId: string): ScheduledTask {
    return this.markInReview(taskId);
  }

  /**
   * Checks whether a task is allowed to transition to merged without changing state.
   * Requirement 25.6, 25.7, 25.8 (B-3)
   */
  public canMergeTask(
    taskId: string,
    evidence?: TaskMergeEvidence
  ): { ok: boolean; reason?: string; reasons: string[]; task: ScheduledTask } {
    const task = this.requireTask(taskId);

    // Only tasks in in_review can merge (Requirement 25.6, 25.7)
    if (task.state !== "in_review") {
      const reason = `Task '${taskId}' is in state '${task.state}', but can only merge from 'in_review'`;
      return {
        ok: false,
        task,
        reasons: [reason],
        reason,
      };
    }

    // Evidence is required: verdict and gate result (Requirement 25.6, 25.7, 25.8)
    if (!evidence) {
      const reason = `Task '${taskId}' requires evidence (verdict and gate result) to merge`;
      return {
        ok: false,
        task,
        reasons: [reason],
        reason,
      };
    }

    // Call checkMergeGate from lib/warden/merge-gate.ts
    const gateCheck = checkMergeGate({
      ...(evidence as any),
      taskId: taskId ?? (evidence as any).taskId,
      runId:
        (evidence as any)?.runId ??
        (typeof this._runId === "string" && this._runId.trim() !== ""
          ? this._runId
          : undefined),
    });

    if (!gateCheck.ok) {
      // Task stays in_review and reasons are returned
      const reasons =
        gateCheck.reasons && gateCheck.reasons.length > 0
          ? [...gateCheck.reasons]
          : gateCheck.reason
          ? [gateCheck.reason]
          : ["Merge gate check failed"];
      return {
        ok: false,
        task,
        reasons,
        reason: reasons[0],
      };
    }

    return {
      ok: true,
      task,
      reasons: [],
    };
  }

  /**
   * Applies the merged state to a task and releases ready dependents.
   * Only called after merge transition check and git merge have succeeded.
   * Ordered state and events (B-3, N-A4): the merge state change and the
   * dependent state changes are all applied before any task.state event is
   * emitted, and the events are then emitted in order.
   * If releasing a dependency fails, every recorded state is rolled back, a
   * compensating task.state event back to in_review is appended, and the
   * merge fails. A rollback failure appends an event and fails the task.
   * Requirement 25.6, 25.7, 25.8 (B-3, N-4)
   */
  private applyMerged(
    taskId: string,
    evidence?: TaskMergeEvidence
  ): MergeTaskResult & ScheduledTask {
    const task = this.requireTask(taskId);

    // Atomicity: record states of the task and each dependent before any change (B-3, N-4)
    const originalTaskState = task.state;
    const originalTaskPreviousState = task.previousState;
    const recordedDependentStates = new Map<
      string,
      { state: TaskState; previousState?: TaskState }
    >();

    for (const depTaskId of task.dependents) {
      const depTask = this._taskMap.get(depTaskId);
      if (depTask) {
        recordedDependentStates.set(depTaskId, {
          state: depTask.state,
          previousState: depTask.previousState,
        });
      }
    }

    // Ordered state and events: every state change is applied before any
    // task.state event is emitted, and the events are then emitted in order
    // (merged first, then the released dependents). (B-3, N-A4)
    const planned: Array<{
      target: ScheduledTask;
      from: TaskState;
      to: TaskState;
      reason?: string;
    }> = [];

    let releaseError: unknown = undefined;
    try {
      // Phase 1: apply the merge state change first. The transition
      // (in_review -> merged) was already validated by canMergeTask. No event
      // is emitted yet.
      task.previousState = task.state;
      task.state = "merged";

      // Phase 2: compute the dependent releases, then apply them. Still no
      // event is emitted.
      for (const depTaskId of task.dependents) {
        const depTask = this._taskMap.get(depTaskId);
        if (depTask && depTask.state === "pending") {
          if (this.areAllDependenciesMerged(depTask)) {
            planned.push({
              target: depTask,
              from: depTask.state,
              to: "ready",
              reason: `All dependencies merged after ${taskId} merged`,
            });
          }
        }
      }

      for (const change of planned) {
        change.target.previousState = change.from;
        change.target.state = change.to;
      }
    } catch (err) {
      releaseError = err;
    }

    if (releaseError !== undefined) {
      return this.compensateMergedFailure(
        task,
        originalTaskState,
        originalTaskPreviousState,
        recordedDependentStates,
        releaseError
      );
    }

    // Phase 3: emit the task.state events in order: merged for the task
    // first, then one ready event per released dependent.
    let compensationInvoked = false;
    const doAsyncCompensation = (err: unknown) => {
      if (compensationInvoked || this._inCompensationRollback) {
        return;
      }
      compensationInvoked = true;
      this._inCompensationRollback = true;
      try {
        this.compensateMergedFailure(
          task,
          originalTaskState,
          originalTaskPreviousState,
          recordedDependentStates,
          err
        );
      } finally {
        this._inCompensationRollback = false;
      }
    };

    const pendingEmissions: Promise<void>[] = [];
    try {
      const p1 = this.emitTaskStateEvent(
        task,
        "merged",
        originalTaskState,
        {
          actor: this._actor,
        },
        doAsyncCompensation
      );
      if (p1) {
        pendingEmissions.push(p1);
      }
      for (const change of planned) {
        const p2 = this.emitTaskStateEvent(
          change.target,
          change.to,
          change.from,
          {
            actor: this._actor,
            reason: change.reason,
          },
          doAsyncCompensation
        );
        if (p2) {
          pendingEmissions.push(p2);
        }
      }
    } catch (err) {
      return this.compensateMergedFailure(
        task,
        originalTaskState,
        originalTaskPreviousState,
        recordedDependentStates,
        err
      );
    }

    let emissionPromise: Promise<void> | undefined;
    let emissionSettledPromise:
      | Promise<{ ok: boolean; error?: unknown }>
      | undefined;
    if (pendingEmissions.length > 0) {
      emissionPromise = Promise.all(pendingEmissions).then(() => undefined);
      emissionPromise.catch(() => {});
      emissionSettledPromise = emissionPromise.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
    }

    return Object.assign(Object.create(task), task, {
      ok: true,
      merged: true,
      task,
      reasons: [],
      reason: undefined,
      emissionPromise,
      emissionSettledPromise,
    });
  }

  /**
   * Rolls back every recorded state after a failed merge apply, appends a
   * compensating task.state event back to in_review, and returns the failed
   * result for the task. If the rollback itself fails, an event is appended
   * and the task is failed. (B-3, N-4)
   */
  private compensateMergedFailure(
    task: ScheduledTask,
    originalTaskState: TaskState,
    originalTaskPreviousState: TaskState | undefined,
    recordedDependentStates: Map<
      string,
      { state: TaskState; previousState?: TaskState }
    >,
    err: unknown
  ): MergeTaskResult & ScheduledTask {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stateAtFailure = task.state;

    try {
      // Rollback: restore every recorded state.
      task.state = originalTaskState;
      task.previousState = originalTaskPreviousState;
      for (const [depTaskId, saved] of recordedDependentStates.entries()) {
        const depTask = this._taskMap.get(depTaskId);
        if (depTask) {
          depTask.state = saved.state;
          depTask.previousState = saved.previousState;
        }
      }

      // Append the compensating task.state event back to in_review.
      this.emitTaskStateEvent(task, originalTaskState, stateAtFailure, {
        actor: this._actor,
        reason: `Merge compensation: dependency release failed: ${errMsg}`,
      });
    } catch (rollbackErr) {
      // A rollback failure appends an event and fails the task.
      const rollbackMsg =
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      try {
        this.emitTaskStateEvent(task, task.state, stateAtFailure, {
          actor: this._actor,
          reason: `Merge compensation rollback failed: ${rollbackMsg}`,
        });
      } catch {
        // Nothing further can be emitted; the task still fails below.
      }

      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: [errMsg, rollbackMsg],
        reason: errMsg,
      });
    }

    return Object.assign(Object.create(task), task, {
      ok: false,
      merged: false,
      task,
      reasons: [errMsg],
      reason: errMsg,
    });
  }

  private applyMergedState = this.applyMerged;

  /**
   * Merges a task upon Warden approval, passing the merge gate, and valid git merge proof.
   * Requires evidence (verdict, gate result, and gitMerge proof).
   * Only tasks in 'in_review' can merge.
   * Evaluates pending dependents to ready when all dependencies are merged.
   * Atomic: restores states if releasing a dependent throws.
   * Requirements: 9.12, 23.2, 25.6, 25.7, 25.8 (B-3, N-4).
   */
  public mergeTask(
    taskId: string,
    evidence?: TaskMergeEvidence
  ): MergeTaskResult & ScheduledTask {
    const check = this.canMergeTask(taskId, evidence);
    const task = check.task;

    if (!check.ok) {
      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: check.reasons,
        reason: check.reason,
      });
    }

    const gitMerge = evidence?.gitMerge;

    // N-A10: Must be a verified merge proof (isVerifiedMerge)
    if (!isVerifiedMerge(gitMerge)) {
      const reason = "git merge proof missing";
      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: [reason],
        reason,
      });
    }

    // Cross-validate gitMerge.runId:
    // if this._runId is non-empty and gitMerge.runId !== this._runId, reject merge;
    // if typeof (evidence as any)?.runId === 'string' && (evidence as any).runId.trim() !== '' && gitMerge.runId !== (evidence as any).runId, reject merge.
    if (
      typeof this._runId === "string" &&
      this._runId.trim() !== "" &&
      gitMerge.runId !== this._runId
    ) {
      const reason = "git merge proof missing";
      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: [reason],
        reason,
      });
    }

    const evidenceRunId = (evidence as any)?.runId;
    if (
      typeof evidenceRunId === "string" &&
      evidenceRunId.trim() !== "" &&
      gitMerge.runId !== evidenceRunId
    ) {
      const reason = "git merge proof missing";
      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: [reason],
        reason,
      });
    }

    // Extract evidenceCandidateSha ONLY from evidence?.candidateSha ?? (evidence as any)?.candidate?.candidateSha
    // (REMOVE the fallback to evidence?.verdict?.candidateSha at lines 834-836),
    // and require non-empty gitMerge.candidateSha === evidenceCandidateSha.
    const evidenceCandidateSha =
      evidence?.candidateSha ??
      (typeof (evidence as any)?.candidate === "object" && (evidence as any)?.candidate !== null
        ? (evidence as any)?.candidate?.candidateSha
        : undefined);

    if (
      !gitMerge.candidateSha ||
      typeof gitMerge.candidateSha !== "string" ||
      gitMerge.candidateSha.trim() === "" ||
      !evidenceCandidateSha ||
      typeof evidenceCandidateSha !== "string" ||
      evidenceCandidateSha.trim() === "" ||
      gitMerge.candidateSha !== evidenceCandidateSha
    ) {
      const reason = "git merge proof missing";
      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: [reason],
        reason,
      });
    }

    // Recompute expectedSha256 using candidateSha256FromDiff from (evidence as any)?.diff ?? (evidence as any)?.candidate?.diff
    // and require non-empty gitMerge.candidateSha256 === expectedSha256
    // (if raw diff is missing or does not match gitMerge.candidateSha256, reject merge).
    const rawDiff =
      typeof (evidence as any)?.diff === "string"
        ? (evidence as any).diff
        : typeof (evidence as any)?.candidate?.diff === "string"
          ? (evidence as any).candidate.diff
          : undefined;

    if (!rawDiff || typeof rawDiff !== "string" || rawDiff.trim() === "") {
      const reason = "git merge proof missing";
      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: [reason],
        reason,
      });
    }

    const expectedSha256 = candidateSha256FromDiff(rawDiff);
    if (
      !gitMerge.candidateSha256 ||
      typeof gitMerge.candidateSha256 !== "string" ||
      gitMerge.candidateSha256.trim() === "" ||
      !expectedSha256 ||
      gitMerge.candidateSha256 !== expectedSha256
    ) {
      const reason = "git merge proof missing";
      return Object.assign(Object.create(task), task, {
        ok: false,
        merged: false,
        task,
        reasons: [reason],
        reason,
      });
    }

    return this.applyMerged(taskId, evidence);
  }

  private markMerged(
    taskId: string,
    evidence?: TaskMergeEvidence
  ): MergeTaskResult & ScheduledTask {
    return this.mergeTask(taskId, evidence);
  }

  /**
   * Rejects a Candidate upon Warden rejection.
   * Transitions task to failed if attempts reach maximum (Requirement 23.12),
   * or rejected / ready based on options.
   */
  public rejectTask(taskId: string, options?: RejectTaskOptions): ScheduledTask {
    const task = this.requireTask(taskId);
    task.rejectionReason = options?.reason;

    if (task.state === "running") {
      this.transitionTask(task, "in_review", {
        reason: options?.reason ?? "Submitted for review",
      });
    }

    if (task.state === "in_review") {
      this.transitionTask(task, "rejected", {
        reason: options?.reason ?? "Rejected by Warden",
      });
    } else if (task.state !== "rejected") {
      this.transitionTask(task, "rejected", {
        reason: options?.reason ?? "Rejected by Warden",
      });
    }

    if (task.attempts >= task.maxAttempts) {
      // Requirement 23.12: When task's Skeleton used all attempts, set to failed
      return this.failTask(taskId, options?.reason ?? "Maximum attempts reached");
    }

    if (options?.retry) {
      this.transitionTask(task, "ready", {
        reason: options?.reason ?? "Re-queued for retry",
      });
    }

    return task;
  }

  /**
   * Re-queues a rejected task back to ready.
   */
  public retryTask(taskId: string): ScheduledTask {
    const task = this.requireTask(taskId);
    if (task.state === "rejected") {
      this.transitionTask(task, "ready", { reason: "Retrying rejected task" });
    }
    return task;
  }

  /**
   * Marks a task failed. Transitions open dependents to blocked.
   * Requirements: 23.3, 23.4, 23.12.
   */
  public failTask(taskId: string, reason?: string): ScheduledTask {
    const task = this.requireTask(taskId);
    this.transitionTask(task, "failed", { reason });
    this.handleDependencyTerminalFailure(taskId, "failed", reason);
    return task;
  }

  public markFailed(taskId: string, reason?: string): ScheduledTask {
    return this.failTask(taskId, reason);
  }

  /**
   * Records an attempt and fails task if attempts reach maxAttempts.
   * Requirement 23.12.
   */
  public recordAttempt(taskId: string): ScheduledTask {
    const task = this.requireTask(taskId);
    task.attempts += 1;
    if (task.attempts >= task.maxAttempts) {
      return this.failTask(taskId, "Maximum attempts reached");
    }
    return task;
  }

  /**
   * Lays task's Skeleton to rest, setting task abandoned.
   * Transitions open dependents to blocked.
   * Requirements: 23.3, 23.4, 23.13.
   */
  public abandonTask(taskId: string, reason = "Skeleton laid to rest"): ScheduledTask {
    const task = this.requireTask(taskId);
    this.transitionTask(task, "abandoned", { reason });
    this.handleDependencyTerminalFailure(taskId, "abandoned", reason);
    return task;
  }

  public layToRest(taskId: string, reason = "Skeleton laid to rest"): ScheduledTask {
    return this.abandonTask(taskId, reason);
  }

  /**
   * Turns off / skips a task in the Pact.
   * Transitions open dependents to blocked.
   * Requirements: 23.3, 23.4, 23.11.
   */
  public skipTask(taskId: string, reason = "Task turned off in Pact"): ScheduledTask {
    const task = this.requireTask(taskId);
    this.transitionTask(task, "skipped", { reason });
    this.handleDependencyTerminalFailure(taskId, "skipped", reason);
    return task;
  }

  /**
   * Re-plans the dependency of a blocked task, setting the task ready.
   * Requirement 23.10.
   */
  public replanDependency(taskId: string, newDependencies?: string[]): ScheduledTask {
    const task = this.requireTask(taskId);

    if (newDependencies) {
      // Remove task from old dependencies' dependents
      for (const oldDepId of task.dependencies) {
        const oldDep = this._taskMap.get(oldDepId);
        if (oldDep) {
          oldDep.dependents = oldDep.dependents.filter((id) => id !== taskId);
        }
      }

      // Set new dependencies
      task.dependencies = [...newDependencies];

      // Add task to new dependencies' dependents
      for (const newDepId of task.dependencies) {
        const newDep = this._taskMap.get(newDepId);
        if (newDep && !newDep.dependents.includes(taskId)) {
          newDep.dependents.push(taskId);
        }
      }
    }

    // Clear blocked status
    task.blockedBy = undefined;
    this.resolveAsksForTask(taskId, "re-plan");

    // Check if new dependencies contain a failed dependency
    if (newDependencies && newDependencies.length > 0) {
      let hasFailedDep = false;
      let allMerged = true;

      for (const depId of task.dependencies) {
        const depTask = this._taskMap.get(depId);
        if (
          depTask &&
          (depTask.state === "failed" ||
            depTask.state === "abandoned" ||
            depTask.state === "skipped")
        ) {
          hasFailedDep = true;
          task.blockedBy = [depId];
          break;
        }
        if (!depTask || depTask.state !== "merged") {
          allMerged = false;
        }
      }

      if (hasFailedDep) {
        this.transitionTask(task, "blocked", {
          reason: "Re-planned dependency is in failed/abandoned/skipped state",
        });
        return task;
      }

      if (!allMerged) {
        this.transitionTask(task, "pending", {
          reason: "Re-planned dependency is pending",
        });
        return task;
      }
    }

    // Requirement 23.10: WHEN the user re-plans the dependency of a blocked task,
    // THE Scheduler SHALL set the task ready.
    this.transitionTask(task, "ready", { reason: "Dependency re-planned" });
    return task;
  }

  public unblockTask(taskId: string): ScheduledTask {
    return this.replanDependency(taskId);
  }

  // ---------------------------------------------------------------------------
  // Dependency Evaluation Engine (Requirements 23.1, 23.2, 23.3, 23.4)
  // ---------------------------------------------------------------------------

  private areAllDependenciesMerged(task: ScheduledTask): boolean {
    if (task.dependencies.length === 0) {
      return true;
    }
    return task.dependencies.every((depId) => {
      const depTask = this._taskMap.get(depId);
      return depTask !== undefined && depTask.state === "merged";
    });
  }

  private hasFailedOrSkippedDependency(task: ScheduledTask): string | null {
    for (const depId of task.dependencies) {
      const dep = this._taskMap.get(depId);
      if (
        dep &&
        (dep.state === "failed" ||
          dep.state === "abandoned" ||
          dep.state === "skipped")
      ) {
        return depId;
      }
    }
    return null;
  }

  /**
   * When a dependency becomes failed, abandoned, or skipped,
   * transition open dependent tasks to blocked and raise a user ask.
   * Requirements: 23.3, 23.4.
   */
  private handleDependencyTerminalFailure(
    terminalTaskId: string,
    state: TaskState,
    reason?: string
  ): void {
    const termTask = this._taskMap.get(terminalTaskId);
    if (!termTask) return;

    for (const depTaskId of termTask.dependents) {
      const depTask = this._taskMap.get(depTaskId);
      if (!depTask) continue;

      // Only open tasks transition to blocked (Requirement 23.3)
      if (this.isOpenState(depTask.state)) {
        depTask.blockedBy = depTask.blockedBy ?? [];
        if (!depTask.blockedBy.includes(terminalTaskId)) {
          depTask.blockedBy.push(terminalTaskId);
        }

        this.transitionTask(depTask, "blocked", {
          reason: `Dependency ${terminalTaskId} became ${state}${
            reason ? `: ${reason}` : ""
          }`,
        });

        // Requirement 23.4: WHEN a task becomes blocked, THE Necromancer SHALL ask the user how to proceed.
        this.raiseAskForBlockedTask(depTask, terminalTaskId, state);
      }
    }
  }

  private evaluateAllDependencies(): void {
    for (const task of this._tasks) {
      if (this.isTerminalState(task.state)) {
        continue;
      }

      const failingDepId = this.hasFailedOrSkippedDependency(task);
      if (failingDepId) {
        task.blockedBy = [failingDepId];
        this.transitionTask(task, "blocked", {
          reason: `Dependency ${failingDepId} is failed, abandoned, or skipped`,
        });
        const depState = this._taskMap.get(failingDepId)?.state ?? "failed";
        this.raiseAskForBlockedTask(task, failingDepId, depState);
      } else if (this.areAllDependenciesMerged(task)) {
        this.transitionTask(task, "ready", {
          reason: "All dependencies merged",
        });
      } else {
        this.transitionTask(task, "pending", {
          reason: "Waiting for dependencies to merge",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // User Asks (Requirement 23.4)
  // ---------------------------------------------------------------------------

  private raiseAskForBlockedTask(
    task: ScheduledTask,
    blockedByTaskId: string,
    depState: TaskState = "failed"
  ): SchedulerAsk {
    const askId = `ask-blocked-${task.id}-${this.nextSeq()}`;
    const question = `Task ${task.id} is blocked because dependency ${blockedByTaskId} became ${depState}. How to proceed?`;
    const options = ["re-plan", "skip", "stop"];

    const ask: SchedulerAsk = {
      askId,
      taskId: task.id,
      blockedByTaskId,
      question,
      options,
      ts: this._now(),
      resolved: false,
    };

    this._asks.push(ask);

    if (this._emit) {
      const envelope: EventEnvelope = {
        runId: this._runId,
        seq: this.nextSeq(),
        ts: this._now(),
        kind: "ask.raised",
        actor: this._actor,
        taskId: task.id,
        data: {
          askId,
          taskId: task.id,
          blockedByTaskId,
          question,
          options,
          refs: [],
        },
      };
      try {
        const res = this._emit(envelope);
        if (res && typeof (res as any).then === "function") {
          (res as Promise<unknown>).catch(() => {
            // Rejection handler attached so an async _emit rejection never triggers unhandledRejection
          });
        }
      } catch {
        // Synchronous throw ignored for ask.raised
      }
    }

    return ask;
  }

  private resolveAsksForTask(taskId: string, resolution: string): void {
    for (const ask of this._asks) {
      if (ask.taskId === taskId && !ask.resolved) {
        ask.resolved = true;
        ask.resolution = resolution;
      }
    }
  }

  public getAsks(): SchedulerAsk[] {
    return [...this._asks];
  }

  public getPendingAsks(): SchedulerAsk[] {
    return this._asks.filter((a) => !a.resolved);
  }

  /**
   * Responds to an ask raised for a blocked task.
   * Options: "re-plan" (unblock task to ready), "skip" (skip task), "stop" (halt run).
   */
  public answerAsk(askId: string, answer: "re-plan" | "skip" | "stop"): void {
    const ask = this._asks.find((a) => a.askId === askId);
    if (!ask) {
      throw new Error(`Ask not found: ${askId}`);
    }

    ask.resolved = true;
    ask.resolution = answer;

    if (answer === "re-plan") {
      this.replanDependency(ask.taskId);
    } else if (answer === "skip") {
      this.skipTask(ask.taskId, "User elected to skip blocked task");
    } else if (answer === "stop") {
      this.requestStop("User requested stop in response to blocked task ask");
    }
  }

  // ---------------------------------------------------------------------------
  // Model Tier Helpers (Requirement 23.15)
  // ---------------------------------------------------------------------------

  /**
   * Returns assigned model tier ID per Requirement 23.15:
   * Claude Opus 5.5 if task marked hard: yes, Sonnet 5.5 otherwise.
   */
  public getModelTier(taskId: string): AllowedModelId {
    const task = this.requireTask(taskId);
    return task.modelTier;
  }

  public getModelTierName(taskId: string): ModelTier {
    const task = this.requireTask(taskId);
    return task.modelTierName;
  }

  // ---------------------------------------------------------------------------
  // Summary & Utilities
  // ---------------------------------------------------------------------------

  public getSummary(): SchedulerSummary {
    const counts: Record<TaskState, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      in_review: 0,
      rejected: 0,
      merged: 0,
      failed: 0,
      abandoned: 0,
      skipped: 0,
      blocked: 0,
    };

    for (const t of this._tasks) {
      counts[t.state] = (counts[t.state] ?? 0) + 1;
    }

    return {
      total: this._tasks.length,
      pending: counts.pending,
      ready: counts.ready,
      running: counts.running,
      inReview: counts.in_review,
      rejected: counts.rejected,
      merged: counts.merged,
      failed: counts.failed,
      abandoned: counts.abandoned,
      skipped: counts.skipped,
      blocked: counts.blocked,
      allTerminal: this.isAllTerminal(),
      stopRequested: this._stopRequested,
      budgetExceeded: this._budgetExceeded,
      liveCount: this.getLiveSkeletonsCount(),
      availableSlots: this.getAvailableSlots(),
      concurrencyLimit: this.getEffectiveLimit(),
    };
  }

  private isTerminalState(state: TaskState): boolean {
    return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
  }

  private isOpenState(state: TaskState): boolean {
    return (OPEN_TASK_STATES as readonly string[]).includes(state);
  }

  private requireTask(taskId: string): ScheduledTask {
    const task = this._taskMap.get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found in scheduler`);
    }
    return task;
  }

  private nextSeq(): number {
    return this._seq++;
  }

  private transitionTask(
    task: ScheduledTask,
    newState: TaskState,
    metadata?: { reason?: string; actor?: string }
  ): void {
    if (task.state === newState) {
      return;
    }

    const previousState = task.state;

    // Transition whitelist from design.md state machine
    const allowed = VALID_TASK_TRANSITIONS[previousState];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(
        `Invalid task state transition from '${previousState}' to '${newState}'`
      );
    }

    task.previousState = previousState;
    task.state = newState;

    this.emitTaskStateEvent(task, newState, previousState, metadata);
  }

  /**
   * Emits a task.state event envelope for the given task. Used by
   * transitionTask and by the ordered apply/compensate paths in applyMerged.
   */
  private emitTaskStateEvent(
    task: ScheduledTask,
    state: TaskState,
    previousState: TaskState | undefined,
    metadata?: { reason?: string; actor?: string },
    onAsyncReject?: (err: unknown) => void
  ): Promise<void> | undefined {
    if (!this._emit) {
      return undefined;
    }

    const envelope: EventEnvelope = {
      runId: this._runId,
      seq: this.nextSeq(),
      ts: this._now(),
      kind: "task.state",
      actor: metadata?.actor ?? this._actor,
      taskId: task.id,
      attempt: task.attempts,
      data: {
        taskId: task.id,
        state,
        previousState,
        reason: metadata?.reason,
        refs: [],
      },
    };
    try {
      const res = this._emit(envelope);
      if (res && typeof (res as any).then === "function") {
        const p = Promise.resolve(res).then(
          () => undefined,
          (err: unknown) => {
            if (onAsyncReject) {
              try {
                onAsyncReject(err);
              } catch {
                // Ignore secondary rejection error
              }
            }
            throw err;
          }
        );
        p.catch(() => {});
        return p;
      }
      return undefined;
    } catch (err) {
      throw err;
    }
  }
}
