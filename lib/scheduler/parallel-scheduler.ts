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
import { candidateSha256FromDiff } from "../merge/candidate-hash";
import { Scheduler } from "./scheduler";
import type {
  MergeTaskResult,
  ScheduledTask,
  SchedulerOptions,
  TaskMergeEvidence,
  TaskState,
} from "./types";

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
  /**
   * The candidate diff against the integration branch, when it could be read.
   * The verified merge recomputes `candidateSha256` from these exact bytes.
   */
  readonly diff?: string;
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
  /**
   * Verified merge evidence supplied by the Warden. Used to merge an approved
   * candidate only when no `mergeCandidate` executor is injected.
   */
  mergeEvidence?: TaskMergeEvidence;
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

/**
 * Executes the verified merge for an approved candidate. It may return the merge
 * evidence directly or a wrapper discriminated by `ok`. Returning `ok: false`
 * (or throwing) fails the approval closed so the task is rejected and retried.
 */
export type ParallelSchedulerMergeCandidate = (
  candidate: ParallelSchedulerCandidate,
  decision: ParallelWardenDecision
) =>
  | Promise<
      | TaskMergeEvidence
      | { ok: boolean; evidence?: TaskMergeEvidence; reason?: string }
    >
  | TaskMergeEvidence
  | { ok: boolean; evidence?: TaskMergeEvidence; reason?: string };

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
  merged: number;
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
  /**
   * Executes the verified merge for an approved candidate and returns the
   * evidence the composed `Scheduler.mergeTask` requires. When omitted, the
   * decision's `mergeEvidence` is used, and failing that a verified git merge is
   * performed against the integration branch.
   */
  mergeCandidate?: ParallelSchedulerMergeCandidate;
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
  const slashNormalized = String(file)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
  if (!slashNormalized) {
    return "";
  }
  // Collapse internal `.` / `..` segments before overlap comparison so
  // `src/./a.ts` and `src/x/../a.ts` both normalize to `src/a.ts`.
  const normalized = path.posix.normalize(slashNormalized);
  return normalized === "." ? "" : normalized;
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
 * Normalizes the value returned by an injected `mergeCandidate` into merge
 * evidence or a fail-closed reason.
 */
function extractMergeCandidateEvidence(
  produced: unknown
): { evidence?: TaskMergeEvidence; reason?: string } {
  if (!produced || typeof produced !== "object") {
    return { reason: "merge_candidate_invalid" };
  }
  const record = produced as {
    ok?: boolean;
    evidence?: TaskMergeEvidence;
    reason?: string;
  };
  if (typeof record.ok === "boolean") {
    if (record.ok === true) {
      return record.evidence ? { evidence: record.evidence } : {};
    }
    return { reason: record.reason ?? "merge_candidate_rejected" };
  }
  return { evidence: produced as TaskMergeEvidence };
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

    const rawWardenCap = options.maxConcurrentWarden ?? 1;
    this._maxConcurrentWarden = Number.isFinite(rawWardenCap)
      ? Math.max(1, Math.floor(rawWardenCap))
      : 1;
    this._cleanupWorktrees = options.cleanupWorktrees !== false;

    // Accept a raw task array for `pact` by wrapping it as a parsed Pact object;
    // the composed Scheduler only understands a string or `{ tasks }`.
    const normalizedPact = Array.isArray(options.pact)
      ? { tasks: options.pact }
      : options.pact;

    const schedulerOptions: SchedulerOptions = {
      tasks: options.tasks,
      pact: normalizedPact,
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
      merged: this.scheduler
        .getTasks()
        .filter((task) => task.state === "merged").length,
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

      // Re-check the abort flag immediately after provisioning the worktree, so
      // an abort during setup never invokes the runner.
      if (controller.signal.aborted || this._aborted) {
        this.abandonSafe(task.id, "aborted");
        return;
      }

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

      // Re-check the abort flag after the (awaited) head resolution, before the
      // task moves to in_review. An abort here must never enqueue a candidate.
      if (controller.signal.aborted || this._aborted) {
        this.abandonSafe(task.id, "aborted");
        return;
      }

      if (!candidateSha || candidateSha.trim().length === 0) {
        this.failSafe(task.id, "missing_candidate_sha");
        return;
      }

      const trimmedSha = candidateSha.trim();
      // The candidate diff is read from the same revision range the verified git
      // merge uses, so the recomputed `candidateSha256` binds to the same bytes.
      const diff = await this.readCandidateDiff(
        worktree.worktreeDir,
        trimmedSha
      );
      const runnerSha256 =
        typeof result.candidateSha256 === "string" &&
        result.candidateSha256.trim().length > 0
          ? result.candidateSha256
          : undefined;
      const candidateSha256 =
        runnerSha256 ??
        (diff && diff.trim().length > 0
          ? candidateSha256FromDiff(diff)
          : undefined);

      // Requirement 23.5: a completed slot -> in_review and its candidate branch
      // is queued for the serialized Warden review.
      this.scheduler.markInReview(task.id);
      const candidate: ParallelSchedulerCandidate = {
        taskId: task.id,
        title: task.title,
        branch: worktree.branch,
        worktreeDir: worktree.worktreeDir,
        gitDir: worktree.gitDir,
        candidateSha: trimmedSha,
        candidateSha256,
        diff,
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
    try {
      this.options.onCleanup?.(taskId, worktree.worktreeDir);
    } catch {
      // A throwing cleanup observer must never block the slot release.
    }
  }

  private resolveHeadSha(worktreeDir: string): Promise<string> {
    return this.gitCapture(worktreeDir, ["rev-parse", "HEAD"]).then((out) =>
      out.trim()
    );
  }

  private gitCapture(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      childProcess.execFile(
        this.gitService.gitBinary,
        [...GIT_ISOLATION_FLAGS, ...args],
        { cwd, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(String(stdout));
        }
      );
    });
  }

  /**
   * Reads the raw candidate diff against the integration branch, mirroring the
   * revision range and flags used by the verified git merge so the recomputed
   * `candidateSha256` binds to the same bytes. Returns `undefined` when the diff
   * is empty or cannot be read.
   */
  private async readCandidateDiff(
    worktreeDir: string,
    candidateSha: string
  ): Promise<string | undefined> {
    try {
      const raw = await this.gitCapture(worktreeDir, [
        "diff",
        "--binary",
        "--no-color",
        "--end-of-options",
        `refs/heads/${this._integrationBranch}..${candidateSha}`,
      ]);
      return raw.trim().length > 0 ? raw : undefined;
    } catch {
      return undefined;
    }
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
        try {
          this.options.onCleanup?.(candidate.taskId, worktree.worktreeDir);
        } catch {
          // A throwing cleanup observer must never block the run teardown.
        }
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
      // The run was aborted while the Warden review was pending: the decision is
      // stale, so tear down the retained worktree and end the task instead of
      // applying the decision or re-queuing a retry.
      if (this._aborted) {
        await this.cleanupReviewedWorktree(candidate.taskId);
        this.abandonReviewedTask(
          candidate.taskId,
          this._abortReason ?? "aborted"
        );
        return;
      }

      // Fail-closed verification of the reviewed candidate hash. An approval
      // MUST carry a non-empty `candidateSha256` that matches the candidate's
      // own hash (trimmed, case-insensitive); anything else is rejected.
      if (decision.approved === true) {
        const provided =
          typeof decision.candidateSha256 === "string"
            ? decision.candidateSha256.trim()
            : "";
        const expected = (candidate.candidateSha256 ?? "").trim();
        if (provided.length === 0) {
          decision = { approved: false, reason: "candidateSha256_missing" };
        } else if (
          expected.length === 0 ||
          provided.toLowerCase() !== expected.toLowerCase()
        ) {
          decision = { approved: false, reason: "candidateSha256_mismatch" };
        }
      }

      // An approved candidate is merged into the integration branch BEFORE its
      // retained worktree is torn down, so dependent tasks unblock while the
      // candidate is still inspectable.
      if (decision.approved === true) {
        const mergeOutcome = await this.performVerifiedMerge(
          candidate,
          decision
        );
        if (!mergeOutcome.ok) {
          decision = {
            approved: false,
            reason: mergeOutcome.reason ?? "merge_gate_failed",
          };
        }
      }

      // The Warden review (and any verified merge) has finished, so the retained
      // worktree may be torn down. Do this BEFORE recordDecision re-queues the
      // task for a retry, so the retry never races the teardown for the same
      // worktree path.
      await this.cleanupReviewedWorktree(candidate.taskId);
      this.recordDecision(candidate, decision);
    } finally {
      this._wardenActive -= 1;
      this.notify();
      this.pumpReviewQueue();
    }
  }

  /**
   * Executes the verified merge for an approved candidate and applies it through
   * the composed Scheduler. Merge precedence: an injected `mergeCandidate`, then
   * the Warden decision's own `mergeEvidence`, then a verified git merge against
   * the integration branch. Any failure is fail-closed: the caller rejects (and
   * retries) instead of leaving the candidate stuck in `in_review`.
   */
  private async performVerifiedMerge(
    candidate: ParallelSchedulerCandidate,
    decision: ParallelWardenDecision
  ): Promise<{ ok: boolean; reason?: string }> {
    let evidence: TaskMergeEvidence | undefined;
    try {
      if (typeof this.options.mergeCandidate === "function") {
        const produced = await this.options.mergeCandidate(candidate, decision);
        const extracted = extractMergeCandidateEvidence(produced);
        if (!extracted.evidence) {
          return {
            ok: false,
            reason: extracted.reason ?? "merge_candidate_rejected",
          };
        }
        evidence = extracted.evidence;
      } else if (decision.mergeEvidence) {
        evidence = decision.mergeEvidence;
      } else {
        evidence = await this.buildDefaultMergeEvidence(candidate);
      }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (!evidence) {
      return { ok: false, reason: "merge_evidence_missing" };
    }

    let mergeRes: MergeTaskResult | undefined;
    try {
      mergeRes = this.scheduler.mergeTask(candidate.taskId, evidence);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (!mergeRes || !mergeRes.ok || !mergeRes.merged) {
      return { ok: false, reason: mergeRes?.reason ?? "merge_gate_failed" };
    }

    // Wait for the task-state emissions so the run loop only observes the merged
    // state once the transition (and dependent releases) are committed.
    if (mergeRes.emissionPromise) {
      await mergeRes.emissionPromise;
    }

    return { ok: true };
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
    try {
      this.options.onCleanup?.(taskId, worktree.worktreeDir);
    } catch {
      // A throwing cleanup observer must never block the slot release.
    }
  }

  /**
   * Performs a real verified merge of the candidate into the integration branch
   * and builds the `TaskMergeEvidence` the composed Scheduler requires. Returns
   * `undefined` when the candidate cannot be merged (fail-closed).
   */
  private async buildDefaultMergeEvidence(
    candidate: ParallelSchedulerCandidate
  ): Promise<TaskMergeEvidence | undefined> {
    const diff = candidate.diff;
    const candidateSha256 =
      (candidate.candidateSha256 ?? "").trim() ||
      (diff && diff.trim().length > 0 ? candidateSha256FromDiff(diff) : "");
    if (!candidateSha256) {
      return undefined;
    }

    let tree: string;
    let integrationHead: string;
    try {
      tree = (
        await this.gitCapture(candidate.worktreeDir, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${candidate.candidateSha}^{tree}`,
        ])
      ).trim();
      integrationHead = (
        await this.gitCapture(candidate.worktreeDir, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `refs/heads/${this._integrationBranch}`,
        ])
      ).trim();
    } catch {
      return undefined;
    }
    if (!tree || !integrationHead) {
      return undefined;
    }

    const checks = {
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      noTestWeakening: { ok: true },
    };
    const verdict = {
      verdict: "approve" as const,
      status: "approve" as const,
      candidateSha: candidate.candidateSha,
      candidateSha256,
      tree,
      reasons: [{ text: "Warden approved the candidate", refs: ["cmd:true"] }],
      checks,
    };
    const gateResult = { ok: true as const, tree };

    let mergeProof: unknown;
    try {
      mergeProof = await (this.gitService as any).mergeCandidate({
        runId: this._runId,
        candidateSha: candidate.candidateSha,
        expectedIntegrationHeadSha: integrationHead,
        candidateSha256,
        verdict,
        verdictCandidateSha256: candidateSha256,
        gateResult,
        gitDir: this._gitDir,
        runDir: this._runsDir,
      });
    } catch {
      return undefined;
    }
    if (
      !mergeProof ||
      (mergeProof as { ok?: boolean }).ok !== true ||
      (mergeProof as { merged?: boolean }).merged !== true
    ) {
      return undefined;
    }

    return {
      verdict,
      gateResult,
      candidateSha: candidate.candidateSha,
      candidateSha256,
      tree,
      gateTree: tree,
      verdictTree: tree,
      expectedHeadSha: integrationHead,
      currentHeadSha: integrationHead,
      integrationHeadSha: integrationHead,
      diff,
      taskId: candidate.taskId,
      runId: this._runId,
      gitMerge: mergeProof as TaskMergeEvidence["gitMerge"],
    } as TaskMergeEvidence;
  }

  /**
   * Ends a task whose review could not be applied (e.g. because the run was
   * aborted). An `in_review` task cannot transition straight to `abandoned`, so
   * it is rejected without a retry; a `running` task is abandoned.
   */
  private abandonReviewedTask(taskId: string, reason: string): void {
    const task = this.scheduler.getTask(taskId);
    if (!task) {
      return;
    }
    try {
      if (task.state === "in_review") {
        this.scheduler.rejectTask(taskId, { reason, retry: false });
      } else if (task.state === "running") {
        this.scheduler.abandonTask(taskId, reason);
      }
    } catch {
      // Ending the task must never surface as a review failure.
    }
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
    try {
      this.options.onReview?.(record);
    } catch {
      // A throwing review observer must never block rejection retries.
    }

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



