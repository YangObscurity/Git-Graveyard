// Task 20.3: Parallel Soul-stitcher dispatch and concurrency scheduling
// Requirements: 23.5, 23.6, 23.14
//
// ParallelScheduler composes the deterministic Scheduler (dependency readiness,
// state machine, model tier resolution) with GitService (isolated branch +
// worktree provisioning) to run up to `effectiveCap` Soul-stitcher slots
// concurrently. It never re-implements task state transitions or model
// resolution: every dispatch goes through Scheduler.dispatchTask, every completion
// through Scheduler.markInReview / failTask / rejectTask.
//
// Concurrency is bounded simultaneously by `effectiveCap =
// min(parallelCap, globalCap, runningMax)` (each specified bound clamped to
// `>= 1`). Ready tasks are selected strictly in approved tasks.md priority order
// and a task is skipped while an active or in-review task already owns an
// overlapping `filesInScope`, so two concurrent workers never collide on the same
// files. Completed candidate branches are queued into a SERIALIZED Warden review
// queue (maxConcurrentWarden defaults to 1) so the Warden reviews candidate SHAs
// one at a time while the other slots keep working in their own worktrees.

import * as childProcess from "node:child_process";
import * as path from "node:path";

import type { AllowedModelId } from "../agents/model-allowlist";
import {
  GIT_ISOLATION_FLAGS,
  GitService,
  type TaskWorktreeResult,
} from "../git/git-service";
import { Scheduler } from "./scheduler";
import type { ScheduledTask, SchedulerOptions, TaskState } from "./types";

/** The default concurrency slot for a single run. */
export const DEFAULT_PARALLEL_CAP = 1;

/**
 * A provisioned, isolated slot handed to an injected runner. The runner executes
 * inside `worktreeDir` (checked out on the task-specific `branch`) and MUST NOT
 * touch the integration worktree or any sibling slot's worktree.
 */
export interface ParallelSlotContext {
  readonly taskId: string;
  readonly title: string;
  readonly slot: number;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly gitDir: string;
  readonly modelId: AllowedModelId;
  readonly hard: boolean;
  readonly task: ScheduledTask;
  readonly signal: AbortSignal;
}

/** The runner's verdict for one slot. */
export interface ParallelWorkerResult {
  ok: boolean;
  /** Committed candidate SHA. When omitted the slot HEAD is read from git. */
  candidateSha?: string;
  candidateSha256?: string;
  reason?: string;
}

/** Executes one Soul-stitcher slot inside its isolated worktree. */
export type ParallelSchedulerRunner = (
  context: ParallelSlotContext
) => Promise<ParallelWorkerResult> | ParallelWorkerResult;

/** One completed candidate placed on the serialized Warden review queue. */
export interface ParallelSchedulerCandidate {
  readonly taskId: string;
  readonly title: string;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly gitDir: string;
  readonly candidateSha: string;
  readonly candidateSha256?: string;
  readonly modelId: AllowedModelId;
  readonly hard: boolean;
  readonly attempt: number;
  readonly filesInScope: string[];
}

/** The Warden's decision for one candidate. */
export interface ParallelWardenDecision {
  approved: boolean;
  reason?: string;
  /**
   * When present and `approved` is true, the reviewed candidate hash. It is
   * verified (case-insensitive, trimmed) against the candidate's
   * `candidateSha256`; a mismatch rejects the candidate fail-closed.
   */
  candidateSha256?: string;
}

/** A candidate plus the Warden decision recorded for it. */
export interface ParallelReviewRecord extends ParallelSchedulerCandidate {
  readonly approved: boolean;
  readonly reason?: string;
  readonly reviewedAt: number;
}

/** Injected Warden review. Invoked serially (see `maxConcurrentWarden`). */
export type ParallelSchedulerWardenReview = (
  candidate: ParallelSchedulerCandidate
) => Promise<ParallelWardenDecision> | ParallelWardenDecision;

export interface ParallelSchedulerStatus {
  runId: string;
  parallelCap: number;
  globalCap: number | undefined;
  runningMax: number | undefined;
  effectiveCap: number;
  activeSlots: number;
  availableSlots: number;
  pendingReviews: number;
  activeReviews: number;
  maxConcurrentWarden: number;
  paused: boolean;
  stopRequested: boolean;
  aborted: boolean;
}

export interface ParallelSchedulerRunSummary {
  runId: string;
  effectiveCap: number;
  dispatched: number;
  candidatesProduced: number;
  approved: number;
  rejected: number;
  retried: number;
  maxObservedConcurrency: number;
  maxObservedWardenConcurrency: number;
  paused: boolean;
  stopRequested: boolean;
  aborted: boolean;
  durationMs: number;
  taskStates: Record<string, TaskState>;
}

export interface ParallelSchedulerOptions extends SchedulerOptions {
  /** Run-level parallel Soul-stitcher cap. Falls back to `runParallelCap`. */
  parallelCap?: number;
  /** Global Skeleton limit. Falls back to `globalSkeletonLimit`. */
  globalCap?: number;
  /** Base directory holding `<runId>/git` and `<runId>/builders/<taskId>`. */
  runsDir?: string;
  /** Explicit run git directory override. */
  gitDir?: string;
  /** Integration branch the task branches are cut from. */
  integrationBranch?: string;
  /** Base directory for per-task worktrees (defaults to `<runRoot>/builders`). */
  worktreeBaseDir?: string;
  /** Injected GitService (tests / custom runsDir). */
  gitService?: GitService;
  /** Executes each dispatched slot inside its isolated worktree. */
  runner: ParallelSchedulerRunner;
  /** Serialized Warden review of completed candidates. */
  wardenReview?: ParallelSchedulerWardenReview;
  /** Warden review concurrency. Defaults to 1 (strictly serialized). */
  maxConcurrentWarden?: number;
  /** When false, per-task worktrees are left in place after a slot settles. */
  cleanupWorktrees?: boolean;
  onDispatch?: (context: ParallelSlotContext) => void;
  onCandidate?: (candidate: ParallelSchedulerCandidate) => void;
  onReview?: (record: ParallelReviewRecord) => void;
  onRetry?: (taskId: string, attempt: number, reason: string) => void;
  onCleanup?: (taskId: string, worktreeDir: string) => void;
}

interface ActiveSlot {
  taskId: string;
  slot: number;
  controller: AbortController;
  promise: Promise<void>;
}

/** Normalizes a repository-relative path for file-ownership comparison. */
function normalizeScopePath(file: string): string {
  return String(file)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

/** True when two paths are equal or one is a directory ancestor of the other. */
function scopePathsOverlap(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** True when any file owned by the two sets overlaps. */
export function parallelScopesConflict(
  left: readonly string[],
  right: readonly string[]
): boolean {
  for (const a of left) {
    const na = normalizeScopePath(a);
    if (!na) continue;
    for (const b of right) {
      const nb = normalizeScopePath(b);
      if (!nb) continue;
      if (scopePathsOverlap(na, nb)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Clamps a specified concurrency bound to `>= 1`. Returns `undefined` for a
 * bound that was not specified so it is excluded from the min.
 */
export function normalizeConcurrencyCap(
  value: number | undefined
): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

/**
 * Parallel Soul-stitcher dispatcher. Composes `Scheduler` + `GitService` and runs
 * injected workers concurrently up to `effectiveCap`, feeding completed candidate
 * branches into a serialized Warden review queue.
 */
export class ParallelScheduler {
  private readonly scheduler: Scheduler;
  private readonly gitService: GitService;
  private readonly runner: ParallelSchedulerRunner;
  private readonly wardenReview: ParallelSchedulerWardenReview;
  private readonly options: ParallelSchedulerOptions;

  private readonly _runId: string;
  private readonly _runsDir: string;
  private readonly _gitDir: string;
  private readonly _worktreeBaseDir: string;
  private readonly _integrationBranch: string;
  private readonly _parallelCap: number;
  private readonly _globalCap?: number;
  private readonly _runningMax?: number;
  private readonly _effectiveCap: number;
  private readonly _maxConcurrentWarden: number;
  private readonly _cleanupWorktrees: boolean;
  private readonly _now: () => number;

  private readonly _active: Map<string, ActiveSlot> = new Map();
  private readonly _inFlight: Set<Promise<void>> = new Set();
  private readonly _slotContexts: Map<string, ParallelSlotContext> = new Map();
  private readonly _worktrees: Map<string, TaskWorktreeResult> = new Map();
  /**
   * Worktrees retained for candidates that are queued/undergoing the serialized
   * Warden review. They are cleaned up only AFTER `wardenReview(candidate)`
   * returns, so `candidate.worktreeDir` stays intact and inspectable throughout
   * review.
   */
  private readonly _reviewWorktrees: Map<string, TaskWorktreeResult> = new Map();
  private readonly _freeSlots: Set<number> = new Set();
  private _slotCounter = 0;

  private _reviewQueue: ParallelSchedulerCandidate[] = [];
  private readonly _reviewRecords: ParallelReviewRecord[] = [];
  private readonly _candidates: ParallelSchedulerCandidate[] = [];
  private readonly _dispatchSequence: string[] = [];
  private _wardenActive = 0;

  private _dispatched = 0;
  private _retried = 0;
  private _maxObservedConcurrency = 0;
  private _maxObservedWardenConcurrency = 0;

  private _paused = false;
  private _stopRequested = false;
  private _stopReason?: string;
  private _aborted = false;
  private _abortReason?: string;
  private _started = false;

  private _activityPromise: Promise<void> | null = null;
  private _activityResolve: (() => void) | null = null;

  constructor(options: ParallelSchedulerOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("ParallelScheduler requires options");
    }
    if (typeof options.runner !== "function") {
      throw new Error("ParallelScheduler requires a runner function");
    }
    this.options = options;
    this.runner = options.runner;
    // Fail-closed default: a run without an injected Warden reviewer must never
    // approve a candidate, so the loop simply rejects (and eventually fails)
    // every candidate it produces.
    this.wardenReview =
      options.wardenReview ??
      (() => ({ approved: false, reason: "warden_review_missing" }));

    this._now = options.now ?? Date.now;
    this._runId = options.runId ?? `run-${this._now()}`;

    const rawParallel = normalizeConcurrencyCap(
      options.parallelCap ?? options.runParallelCap
    );
    const rawGlobal = normalizeConcurrencyCap(
      options.globalCap ?? options.globalSkeletonLimit
    );
    const rawRunning = normalizeConcurrencyCap(options.runningMax);
    // effectiveCap = min(each SPECIFIED bound clamped to >= 1); 1 when none is.
    const specified = [rawParallel, rawGlobal, rawRunning].filter(
      (value): value is number => value !== undefined
    );
    this._effectiveCap =
      specified.length > 0 ? Math.min(...specified) : DEFAULT_PARALLEL_CAP;
    this._parallelCap = rawParallel ?? this._effectiveCap;
    this._globalCap = rawGlobal;
    this._runningMax = rawRunning;

    this.gitService =
      options.gitService ?? new GitService({ runsDir: options.runsDir });
    this._runsDir = options.runsDir ?? this.gitService.runsDir;
    const runRoot = path.join(this._runsDir, this._runId);
    this._gitDir = options.gitDir ?? path.join(runRoot, "git");
    this._worktreeBaseDir =
      options.worktreeBaseDir ?? path.join(runRoot, "builders");
    this._integrationBranch =
      options.integrationBranch ?? `graveyard/${this._runId}`;

    this._maxConcurrentWarden = Math.max(
      1,
      Math.floor(options.maxConcurrentWarden ?? 1)
    );
    this._cleanupWorktrees = options.cleanupWorktrees !== false;

    const schedulerOptions: SchedulerOptions = {
      tasks: options.tasks,
      pact: options.pact,
      approvedTaskIds: options.approvedTaskIds,
      pactApproved: options.pactApproved,
      pactVersion: options.pactVersion,
      // The composed Scheduler's effective limit mirrors this dispatcher's
      // `effectiveCap`, so the two slot controllers never disagree.
      runParallelCap: this._effectiveCap,
      globalSkeletonLimit: this._globalCap,
      runningMax: this._runningMax,
      maxAttempts: options.maxAttempts,
      runId: this._runId,
      actor: options.actor,
      emit: options.emit,
      now: options.now,
    };
    this.scheduler = new Scheduler(schedulerOptions);
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  public get runId(): string {
    return this._runId;
  }

  public get integrationBranch(): string {
    return this._integrationBranch;
  }

  public get runsDir(): string {
    return this._runsDir;
  }

  public getEffectiveCap(): number {
    return this._effectiveCap;
  }

  public getMaxObservedConcurrency(): number {
    return this._maxObservedConcurrency;
  }

  public getMaxObservedWardenConcurrency(): number {
    return this._maxObservedWardenConcurrency;
  }

  public get maxConcurrentWarden(): number {
    return this._maxConcurrentWarden;
  }

  public getScheduler(): Scheduler {
    return this.scheduler;
  }

  public getGitService(): GitService {
    return this.gitService;
  }

  public getActiveSlots(): ParallelSlotContext[] {
    return [...this._slotContexts.values()];
  }

  public getCandidates(): ParallelSchedulerCandidate[] {
    return [...this._candidates];
  }

  /**
   * The task IDs in the exact order they were dispatched (priority order), pushed
   * synchronously at dispatch time so it is independent of async worktree setup.
   */
  public getDispatchSequence(): string[] {
    return [...this._dispatchSequence];
  }

  public getReviewQueue(): ParallelSchedulerCandidate[] {
    return [...this._reviewQueue];
  }

  public getReviewRecords(): ParallelReviewRecord[] {
    return [...this._reviewRecords];
  }

  public getStatus(): ParallelSchedulerStatus {
    return {
      runId: this._runId,
      parallelCap: this._parallelCap,
      globalCap: this._globalCap,
      runningMax: this._runningMax,
      effectiveCap: this._effectiveCap,
      activeSlots: this._active.size,
      availableSlots: Math.max(0, this._effectiveCap - this._active.size),
      pendingReviews: this._reviewQueue.length,
      activeReviews: this._wardenActive,
      maxConcurrentWarden: this._maxConcurrentWarden,
      paused: this._paused,
      stopRequested: this._stopRequested,
      aborted: this._aborted,
    };
  }

  // ---------------------------------------------------------------------------
  // Control: pause / stop / abort (Requirement 23.9)
  // ---------------------------------------------------------------------------

  public pause(): void {
    if (this._aborted) return;
    this._paused = true;
    this.notify();
  }

  public resume(): void {
    if (this._aborted) return;
    this._paused = false;
    this.notify();
  }

  public get isPaused(): boolean {
    return this._paused;
  }

  /** Soft stop: no new dispatch, but active slots and reviews drain to completion. */
  public stop(reason = "stopped"): void {
    if (this._aborted) return;
    this._stopRequested = true;
    this._stopReason = reason;
    this.scheduler.requestStop(reason);
    this.notify();
  }

  public get isStopRequested(): boolean {
    return this._stopRequested;
  }

  public get stopReason(): string | undefined {
    return this._stopReason;
  }

  /** Hard abort: signals every active slot, clears the queue and tears down. */
  public abort(reason = "aborted"): void {
    if (this._aborted) return;
    this._aborted = true;
    this._abortReason = reason;
    // Tear down any candidate worktrees still awaiting review so an abort never
    // leaks them (their reviews will never run).
    this.discardQueuedReviews();
    for (const slot of this._active.values()) {
      try {
        slot.controller.abort();
      } catch {
        // Ignore a failing abort() on an already-settled controller.
      }
    }
    this.notify();
  }

  public get isAborted(): boolean {
    return this._aborted;
  }

  public get abortReason(): string | undefined {
    return this._abortReason;
  }

  // ---------------------------------------------------------------------------
  // Ready-task selection with exclusive file ownership
  // ---------------------------------------------------------------------------

  /**
   * Returns the files currently claimed by dispatched (running) and in-review
   * tasks, so a new slot never overlaps an active owner.
   */
  private claimedFiles(): string[] {
    const claimed: string[] = [];
    for (const task of this.scheduler.getRunningTasks()) {
      claimed.push(...task.filesInScope);
    }
    for (const task of this.scheduler.getInReviewTasks()) {
      claimed.push(...task.filesInScope);
    }
    return claimed;
  }

  /**
   * Selects up to `capacity` ready tasks in approved tasks.md priority order,
   * skipping any task whose `filesInScope` overlaps an already-active owner or an
   * earlier selection in the same pass. Requirement 23.5, 23.14.
   */
  public selectReadyTasks(capacity: number): ScheduledTask[] {
    if (capacity <= 0) {
      return [];
    }
    const claimed = this.claimedFiles();
    const selected: ScheduledTask[] = [];
    for (const task of this.scheduler.getReadyTasks()) {
      if (selected.length >= capacity) break;
      const files = task.filesInScope ?? [];
      if (parallelScopesConflict(files, claimed)) {
        continue;
      }
      selected.push(task);
      claimed.push(...files);
    }
    return selected;
  }

  // ---------------------------------------------------------------------------
  // Run loop
  // ---------------------------------------------------------------------------

  /**
   * Runs until every dispatchable slot has settled and the review queue has
   * drained, or until `stop()` / `abort()` halts it.
   */
  public async run(): Promise<ParallelSchedulerRunSummary> {
    if (this._started) {
      throw new Error("ParallelScheduler.run() may only be called once");
    }
    this._started = true;
    const startedAt = this._now();

    while (!this._aborted) {
      if (!this._paused && !this._stopRequested) {
        this.dispatchReady();
      }
      this.pumpReviewQueue();

      if (!this.isBusy()) {
        // Idle: nothing active and no queued work. Try one more dispatch pass to
        // avoid an idle loop, then stop when no slot can make progress.
        const canDispatch =
          !this._paused && !this._stopRequested && !this._aborted;
        if (canDispatch) {
          this.dispatchReady();
          if (this.isBusy()) {
            continue;
          }
        }
        // Paused while non-terminal tasks remain (pending / ready / blocked):
        // never exit the loop, or `resume()` would have nothing left to resume.
        // Wait cleanly so `resume()`, `stop()`, or `abort()` wakes the loop and
        // it either resumes dispatch or exits.
        const pausedWithWork =
          this._paused &&
          !this._stopRequested &&
          !this._aborted &&
          this.hasNonTerminalWork();
        if (!pausedWithWork) {
          break;
        }
        await this.waitForActivity();
        continue;
      }

      await this.waitForActivity();
    }

    await this.settle();

    return {
      runId: this._runId,
      effectiveCap: this._effectiveCap,
      dispatched: this._dispatched,
      candidatesProduced: this._candidates.length,
      approved: this._reviewRecords.filter((r) => r.approved).length,
      rejected: this._reviewRecords.filter((r) => !r.approved).length,
      retried: this._retried,
      maxObservedConcurrency: this._maxObservedConcurrency,
      maxObservedWardenConcurrency: this._maxObservedWardenConcurrency,
      paused: this._paused,
      stopRequested: this._stopRequested,
      aborted: this._aborted,
      durationMs: Math.max(0, this._now() - startedAt),
      taskStates: this.taskStates(),
    };
  }

  private taskStates(): Record<string, TaskState> {
    const states: Record<string, TaskState> = {};
    for (const task of this.scheduler.getTasks()) {
      states[task.id] = task.state;
    }
    return states;
  }

  private isBusy(): boolean {
    return (
      this._active.size > 0 ||
      this._wardenActive > 0 ||
      this._reviewQueue.length > 0
    );
  }

  /**
   * True when the composed Scheduler still owns non-terminal tasks the run loop
   * could still act on (pending / ready / blocked). Used to keep the loop alive
   * while paused so `resume()` can continue dispatching instead of the loop
   * exiting early.
   */
  private hasNonTerminalWork(): boolean {
    return this.scheduler
      .getTasks()
      .some(
        (task) =>
          task.state === "pending" ||
          task.state === "ready" ||
          task.state === "blocked"
      );
  }

  private notify(): void {
    if (this._activityResolve) {
      const resolve = this._activityResolve;
      this._activityResolve = null;
      this._activityPromise = null;
      resolve();
    }
  }

  private waitForActivity(): Promise<void> {
    if (!this._activityPromise) {
      this._activityPromise = new Promise<void>((resolve) => {
        this._activityResolve = resolve;
      });
    }
    return this._activityPromise;
  }

  private async settle(): Promise<void> {
    while (this._inFlight.size > 0 || this._reviewQueue.length > 0) {
      if (this._reviewQueue.length > 0 && !this._aborted) {
        this.pumpReviewQueue();
      }
      const pending = [...this._inFlight];
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatching
  // ---------------------------------------------------------------------------

  private dispatchReady(): void {
    if (this._aborted || this._paused || this._stopRequested) {
      return;
    }
    const capacity = this._effectiveCap - this._active.size;
    if (capacity <= 0) {
      return;
    }
    const selected = this.selectReadyTasks(capacity);
    for (const task of selected) {
      this.dispatchTask(task);
    }
  }

  private dispatchTask(task: ScheduledTask): void {
    const dispatched = this.scheduler.dispatchTask(task.id);
    if (!dispatched) {
      return;
    }
    this._dispatchSequence.push(task.id);
    const slotIndex = this.acquireSlot();
    const controller = new AbortController();
    const record: ActiveSlot = {
      taskId: task.id,
      slot: slotIndex,
      controller,
      promise: Promise.resolve(),
    };
    const promise = this.workerLoop(dispatched, slotIndex, controller, record);
    record.promise = promise;
    this._active.set(task.id, record);
    this._inFlight.add(promise);
    this._dispatched += 1;
    this._maxObservedConcurrency = Math.max(
      this._maxObservedConcurrency,
      this._active.size
    );
  }

  private acquireSlot(): number {
    if (this._freeSlots.size > 0) {
      const value = Math.min(...this._freeSlots);
      this._freeSlots.delete(value);
      return value;
    }
    const value = this._slotCounter;
    this._slotCounter += 1;
    return value;
  }

  private releaseSlot(slot: number): void {
    this._freeSlots.add(slot);
  }

  private async workerLoop(
    task: ScheduledTask,
    slotIndex: number,
    controller: AbortController,
    record: ActiveSlot
  ): Promise<void> {
    let worktree: TaskWorktreeResult | null = null;
    // When a candidate is enqueued for Warden review, ownership of the worktree
    // cleanup handle moves to the serialized review so `candidate.worktreeDir`
    // stays intact and inspectable throughout review.
    let retainedForReview = false;
    const modelId = task.modelTier;
    try {
      worktree = await this.gitService.createTaskWorktree({
        runId: this._runId,
        taskId: task.id,
        gitDir: this._gitDir,
        worktreeDir: path.join(this._worktreeBaseDir, task.id),
        baseBranch: this._integrationBranch,
      });
      this._worktrees.set(task.id, worktree);

      const context: ParallelSlotContext = {
        taskId: task.id,
        title: task.title,
        slot: slotIndex,
        branch: worktree.branch,
        worktreeDir: worktree.worktreeDir,
        gitDir: worktree.gitDir,
        modelId,
        hard: task.hard,
        task,
        signal: controller.signal,
      };
      this._slotContexts.set(task.id, context);
      this.options.onDispatch?.(context);

      const result = await this.runner(context);

      if (controller.signal.aborted || this._aborted) {
        this.abandonSafe(task.id, "aborted");
        return;
      }

      if (!result || !result.ok) {
        this.failSafe(task.id, result?.reason ?? "worker_failed");
        return;
      }

      const candidateSha =
        result.candidateSha ??
        (await this.resolveHeadSha(worktree.worktreeDir));
      if (!candidateSha || candidateSha.trim().length === 0) {
        this.failSafe(task.id, "missing_candidate_sha");
        return;
      }

      // Requirement 23.5: a completed slot -> in_review and its candidate branch
      // is queued for the serialized Warden review.
      this.scheduler.markInReview(task.id);
      const candidate: ParallelSchedulerCandidate = {
        taskId: task.id,
        title: task.title,
        branch: worktree.branch,
        worktreeDir: worktree.worktreeDir,
        gitDir: worktree.gitDir,
        candidateSha: candidateSha.trim(),
        candidateSha256: result.candidateSha256,
        modelId,
        hard: task.hard,
        attempt: task.attempts,
        filesInScope: [...(task.filesInScope ?? [])],
      };
      this._candidates.push(candidate);
      this._reviewQueue.push(candidate);
      // Hand the worktree cleanup handle to the serialized Warden review instead
      // of tearing it down here; the worker slot still frees immediately below so
      // parallel workers continue on other tasks.
      this._reviewWorktrees.set(task.id, worktree);
      this._worktrees.delete(task.id);
      retainedForReview = true;
      this.options.onCandidate?.(candidate);
    } catch (err) {
      if (controller.signal.aborted || this._aborted || isAbortError(err)) {
        this.abandonSafe(task.id, "aborted");
      } else {
        this.failSafe(task.id, err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (worktree && !retainedForReview) {
        // The worker failed/errored before enqueuing a candidate (or was
        // abandoned): no review will own this worktree, so tear it down here.
        await this.cleanupWorktree(task.id, worktree);
      }
      this.releaseSlot(slotIndex);
      this._slotContexts.delete(task.id);
      this._active.delete(task.id);
      this._inFlight.delete(record.promise);
      this.notify();
    }
  }

  /**
   * Deterministically tears down a task worktree (when `cleanupWorktrees` is
   * enabled) and drops its tracking entry. A teardown failure never surfaces as
   * a run failure.
   */
  private async cleanupWorktree(
    taskId: string,
    worktree: TaskWorktreeResult
  ): Promise<void> {
    this._worktrees.delete(taskId);
    if (this._cleanupWorktrees) {
      try {
        await worktree.cleanup();
      } catch {
        // Deterministic teardown must never surface as a run failure.
      }
    }
    this.options.onCleanup?.(taskId, worktree.worktreeDir);
  }

  private resolveHeadSha(worktreeDir: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      childProcess.execFile(
        this.gitService.gitBinary,
        [...GIT_ISOLATION_FLAGS, "rev-parse", "HEAD"],
        { cwd: worktreeDir, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(String(stdout).trim());
        }
      );
    });
  }

  private failSafe(taskId: string, reason: string): void {
    const task = this.scheduler.getTask(taskId);
    if (!task || task.state !== "running") {
      return;
    }
    this.scheduler.failTask(taskId, reason);
  }

  private abandonSafe(taskId: string, reason: string): void {
    const task = this.scheduler.getTask(taskId);
    if (!task || task.state !== "running") {
      return;
    }
    this.scheduler.abandonTask(taskId, reason);
  }

  // ---------------------------------------------------------------------------
  // Serialized Warden review queue
  // ---------------------------------------------------------------------------

  /**
   * Drops every candidate still waiting on the review queue (used by `abort()`),
   * tearing down their retained worktrees so an aborted run never leaks them.
   * The teardowns are tracked in `_inFlight` so `settle()` awaits them.
   */
  private discardQueuedReviews(): void {
    const queued = this._reviewQueue;
    if (queued.length === 0) {
      return;
    }
    this._reviewQueue = [];
    for (const candidate of queued) {
      const worktree = this._reviewWorktrees.get(candidate.taskId);
      if (!worktree) {
        continue;
      }
      this._reviewWorktrees.delete(candidate.taskId);
      const base = (async () => {
        if (this._cleanupWorktrees) {
          try {
            await worktree.cleanup();
          } catch {
            // Deterministic teardown must never surface as a run failure.
          }
        }
        this.options.onCleanup?.(candidate.taskId, worktree.worktreeDir);
      })();
      let tracked!: Promise<void>;
      tracked = base.finally(() => {
        this._inFlight.delete(tracked);
      });
      this._inFlight.add(tracked);
    }
  }

  private pumpReviewQueue(): void {
    if (this._aborted) {
      return;
    }
    while (
      this._reviewQueue.length > 0 &&
      this._wardenActive < this._maxConcurrentWarden
    ) {
      const candidate = this._reviewQueue.shift() as ParallelSchedulerCandidate;
      this._wardenActive += 1;
      this._maxObservedWardenConcurrency = Math.max(
        this._maxObservedWardenConcurrency,
        this._wardenActive
      );
      const base = this.reviewLoop(candidate);
      let tracked!: Promise<void>;
      tracked = base.finally(() => {
        this._inFlight.delete(tracked);
      });
      this._inFlight.add(tracked);
    }
  }

  private async reviewLoop(
    candidate: ParallelSchedulerCandidate
  ): Promise<void> {
    let decision: ParallelWardenDecision;
    try {
      decision = (await this.wardenReview(candidate)) ?? {
        approved: false,
        reason: "no_decision",
      };
    } catch (err) {
      decision = {
        approved: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      // When an approval carries a candidate hash, verify it against the
      // candidate (case-insensitive, trimmed). A mismatch rejects fail-closed.
      if (
        decision.approved === true &&
        typeof decision.candidateSha256 === "string"
      ) {
        const expected = (candidate.candidateSha256 ?? "").trim().toLowerCase();
        const provided = decision.candidateSha256.trim().toLowerCase();
        if (expected.length === 0 || provided !== expected) {
          decision = { approved: false, reason: "candidateSha256_mismatch" };
        }
      }
      // The Warden review has finished, so the retained worktree may be torn
      // down. Do this BEFORE recordDecision re-queues the task for a retry, so
      // the retry never races the teardown for the same worktree path.
      await this.cleanupReviewedWorktree(candidate.taskId);
      this.recordDecision(candidate, decision);
    } finally {
      this._wardenActive -= 1;
      this.notify();
      this.pumpReviewQueue();
    }
  }

  /**
   * Tears down the worktree retained for a reviewed candidate, if any. Called
   * only after `wardenReview(candidate)` has returned so `candidate.worktreeDir`
   * stayed intact and inspectable throughout review.
   */
  private async cleanupReviewedWorktree(taskId: string): Promise<void> {
    const worktree = this._reviewWorktrees.get(taskId);
    if (!worktree) {
      return;
    }
    this._reviewWorktrees.delete(taskId);
    if (this._cleanupWorktrees) {
      try {
        await worktree.cleanup();
      } catch {
        // Deterministic teardown must never surface as a run failure.
      }
    }
    this.options.onCleanup?.(taskId, worktree.worktreeDir);
  }

  private recordDecision(
    candidate: ParallelSchedulerCandidate,
    decision: ParallelWardenDecision
  ): void {
    const task = this.scheduler.getTask(candidate.taskId);
    const record: ParallelReviewRecord = {
      ...candidate,
      approved: decision.approved === true,
      reason: decision.reason,
      reviewedAt: this._now(),
    };
    this._reviewRecords.push(record);
    this.options.onReview?.(record);

    if (!task) {
      return;
    }

    if (decision.approved === true) {
      // Approved candidates remain in_review for the Warden's merge gate; the
      // ParallelScheduler owns dispatch + the serialized review queue only.
      return;
    }

    // Rejected: re-queue for retry while attempts remain (tracked by the
    // composed Scheduler), otherwise the task is failed. Count a retry only when
    // the task actually became ready again, so exhausting `maxAttempts` never
    // over-counts `summary.retried` / fires `onRetry` for a failing task.
    this.scheduler.rejectTask(candidate.taskId, {
      reason: decision.reason ?? "warden_rejected",
      retry: true,
    });
    const rejectedTask = this.scheduler.getTask(candidate.taskId);
    if (rejectedTask?.state === "ready") {
      this._retried += 1;
      this.options.onRetry?.(
        candidate.taskId,
        rejectedTask.attempts,
        decision.reason ?? "warden_rejected"
      );
    }
    this.notify();
  }
}



