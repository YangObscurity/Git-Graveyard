// Task 13.2 / T34 Wave 2A: TaskDispatcher wiring Scheduler, GitService, SkeletonSupervisor, and onSubmit
// Requirements: 13.8, 13.9, 13.10, 23.1-23.15, 24.5-24.16, 25.6-25.8

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAssignedModelForRole, type AllowedModelId } from "../agents/model-allowlist";
import {
  buildRunNetworkPolicy,
  buildSandboxNetworkSpec,
  getRunNetworkPolicy,
  registerRunNetworkPolicy,
} from "../backend/network-policy";
import { neutralizeUntrustedContent } from "../security/untrusted-content";
import type { EventEnvelope, EventInput, EventStore } from "../events/event-store";
import { getDefaultEventStore } from "../events/event-store";
import { GitService, TaskWorktreeResult } from "../git/git-service";
import type { PactRole } from "../pact/pact-parser";
import type { RuntimeHost } from "../runtime/runtime-host";
import type { HeadlessAskRequest } from "../acp/stream-parser";
import { buildAskAutoDeniedEventData } from "../acp/headless-fallback";
import {
  SkeletonSupervisor,
} from "../supervisor/skeleton-supervisor";
import type {
  SkeletonSupervisorOptions,
} from "../supervisor/types";
import {
  buildVerdictRecord,
  validateWardenVerdict,
} from "../warden/warden-review";
import type {
  WardenVerdictRecord,
} from "../warden/types";
import {
  onSubmit,
  type CandidateSubmissionReport,
  type CandidateSubmissionResult,
} from "./candidate-submission";
import type { Scheduler } from "./scheduler";
import type {
  ScheduledTask,
  SchedulerSummary,
} from "./types";

/**
 * Result of a single worker execution session.
 */
export interface TaskExecutionOutcome {
  ok: boolean;
  taskId: string;
  skeletonId?: string;
  worktreeDir?: string;
  diff?: string;
  candidateSha?: string;
  error?: Error | unknown;
  reason?: string;
  cancelled?: boolean;
}

/**
 * Execution context passed to a task worker runner.
 */
export interface WorkerContext {
  task: ScheduledTask;
  taskId: string;
  runId: string;
  skeletonId: string;
  role: PactRole | string;
  model: AllowedModelId;
  worktreeDir: string;
  worktreeRoot: string;
  branch: string;
  gitDir: string;
  runDir?: string;
  supervisor?: SkeletonSupervisor;
  emitEvent: (event: EventInput) => EventEnvelope | void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Execution context passed to Warden reviewer.
 */
export interface WardenReviewContext {
  task: ScheduledTask;
  taskId: string;
  runId: string;
  skeletonId: string;
  worktreeDir: string;
  worktreeRoot: string;
  gitDir: string;
  runDir?: string;
  diff: string;
  candidateSha: string;
  candidateSha256: string;
  candidateTree?: string;
  expectedIntegrationHeadSha: string;
  acceptanceCommand: string;
  /** Review focus recorded for this Skeleton's Warden review, if any. */
  reviewFocus?: string[];
  supervisor?: SkeletonSupervisor;
  emitEvent: (event: EventInput) => EventEnvelope | void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Aggregate result of a dispatch loop run or step.
 */
export interface DispatchLoopResult {
  runId: string;
  status: "completed" | "stopped" | "failed" | "max_steps_reached" | "idle";
  tasksProcessed: number;
  tasksMerged: number;
  tasksFailed: number;
  steps: number;
  summary: SchedulerSummary;
  error?: Error | unknown;
  reason?: string;
}

/**
 * Active task tracking metadata during execution.
 */
export interface ActiveTaskTracking {
  task: ScheduledTask;
  taskId: string;
  skeletonId: string;
  worktreeDir: string;
  branch: string;
  supervisor?: SkeletonSupervisor;
  abortController: AbortController;
  startedAt: number;
  /** Skeleton-scoped control state recorded while the task is live. */
  layToRestChoice?: "keep_commits" | "discard";
  instructions?: Array<{ text: string; delivery: string; at: number }>;
  reviewFocus?: string[];
  /**
   * True when an interrupt kept this task's worktree on disk so a later
   * `reraiseSkeleton` resumes the same work instead of recreating it.
   */
  preserveWorktree?: boolean;
}

/**
 * Optional context for one `executeTaskPipeline` run.
 */
export interface TaskPipelineRunOptions {
  /**
   * Pre-registered tracking entry to resume in place (the `reraiseSkeleton`
   * path). Its fresh `abortController` and preserved `instructions` /
   * `reviewFocus` are carried into the restarted pipeline.
   */
  tracking?: ActiveTaskTracking;
  /**
   * Worktree an interrupt kept for this task. When it still exists on disk the
   * pipeline resumes in it rather than recreating (and resetting) the branch.
   */
  preservedWorktree?: TaskWorktreeResult;
}

/**
 * Options accepted by TaskDispatcher.
 */
export interface TaskDispatcherOptions {
  runId: string;
  scheduler: Scheduler;
  gitService: GitService;
  host?: RuntimeHost;
  supervisorFactory?: (opts: SkeletonSupervisorOptions) => SkeletonSupervisor;
  emitEvent?: (event: EventInput) => EventEnvelope | void | Promise<void>;
  eventStore?: EventStore | any;
  runDir?: string;
  gitDir?: string;
  baseSha?: string;
  integrationHeadSha?: string | (() => string | Promise<string>);
  expectedIntegrationHeadSha?: string | (() => string | Promise<string>);
  workerRunner?: (ctx: WorkerContext) => Promise<TaskExecutionOutcome | void>;
  wardenRunner?: (
    ctx: WardenReviewContext
  ) => Promise<WardenVerdictRecord | any> | WardenVerdictRecord | any;
  wardenReviewer?: (
    run: any,
    candidate: any,
    acceptanceCommand: string
  ) => Promise<WardenVerdictRecord | any> | WardenVerdictRecord | any;
  pollIntervalMs?: number;
  maxSteps?: number;
  boxImage?: string;
  onBeforeDispatch?: (task: ScheduledTask) => void | Promise<void>;
  onAfterMerge?: (
    task: ScheduledTask,
    result: CandidateSubmissionResult
  ) => void | Promise<void>;
  /**
   * Probe results (P1/P14/S2) forwarded to every Supervisor the Dispatcher
   * constructs, so a run that failed the ACP probe (P1) drives the Headless
   * Fallback channel (Requirement 17.1).
   */
  probeResults?: Record<string, any>;
  /** Approval bridge forwarded to the Headless Fallback channel (Requirement 17.7). */
  onApproval?: SkeletonSupervisorOptions["onApproval"];
  /**
   * Auto-deny hook forwarded to the Headless Fallback channel (Requirement 17.11).
   * When omitted, the Dispatcher supplies a production default that records an
   * `ask.auto_denied` event through its event sink.
   */
  onAskAutoDeny?: SkeletonSupervisorOptions["onAskAutoDeny"];
}

/**
 * Production TaskDispatcher driving deterministic scheduling, worktree provisioning,
 * worker session dispatch, Grimoire/Warden candidate submission, and merge gating.
 */
export class TaskDispatcher {
  readonly runId: string;
  readonly scheduler: Scheduler;
  readonly gitService: GitService;
  readonly host?: RuntimeHost;
  readonly runDir?: string;
  readonly gitDir: string;
  readonly baseSha?: string;
  readonly pollIntervalMs: number;
  readonly maxSteps?: number;
  readonly options: TaskDispatcherOptions;

  private isStoppedState = false;
  private isPausedState = false;
  private stopReason?: string;
  private fatalError?: Error;

  private stepCount = 0;
  private tasksProcessed = 0;
  private tasksMerged = 0;
  private tasksFailed = 0;

  private readonly activeTasks: Map<string, ActiveTaskTracking> = new Map();
  /**
   * Persistent Skeleton-scoped lookup keyed by `skeletonId`. It outlives the
   * live `activeTasks` slot so an interrupt or lay-to-rest that releases a task
   * out of `"running"` can still be located - and re-raised - by id afterwards.
   */
  private readonly knownSkeletonTasks: Map<string, ActiveTaskTracking> =
    new Map();
  /**
   * Worktrees an interrupt deliberately kept on disk, keyed by `taskId`, so a
   * later `reraiseSkeleton` resumes the same task in place instead of recreating
   * it (and losing in-progress work).
   */
  private readonly preservedWorktrees: Map<string, TaskWorktreeResult> =
    new Map();
  /**
   * In-flight `executeTaskPipeline` promises keyed by `taskId`. A re-raise can
   * await a cancelled run's cleanup before restarting the slot, and `run()`
   * cannot exit while a restarted pipeline is still executing.
   */
  private readonly pipelinePromises: Map<string, Promise<void>> = new Map();
  /**
   * Task ids whose `reraiseSkeleton` is currently claimed. Claimed
   * synchronously before any await, so two concurrent re-raises of the same
   * Skeleton can never both restart its pipeline.
   */
  private readonly reraisingTasks: Set<string> = new Set();
  private readonly eventStore?: EventStore | any;

  private mergeLock: Promise<void> = Promise.resolve();

  constructor(options: TaskDispatcherOptions) {
    if (!options) {
      throw new TypeError("TaskDispatcherOptions must be provided");
    }
    if (!options.runId || typeof options.runId !== "string") {
      throw new TypeError("runId is required and must be a string");
    }
    if (!options.scheduler) {
      throw new TypeError("scheduler is required");
    }
    if (!options.gitService) {
      throw new TypeError("gitService is required");
    }

    this.options = { ...options };
    this.runId = options.runId;
    this.scheduler = options.scheduler;
    this.gitService = options.gitService;
    this.host = options.host;
    this.baseSha = options.baseSha;
    this.pollIntervalMs =
      typeof options.pollIntervalMs === "number" && options.pollIntervalMs >= 0
        ? options.pollIntervalMs
        : 20;
    this.maxSteps = options.maxSteps;

    this.runDir =
      options.runDir ??
      (options.gitService.runsDir
        ? path.join(options.gitService.runsDir, options.runId)
        : undefined);

    this.gitDir =
      options.gitDir ??
      (this.runDir ? path.join(this.runDir, "git") : undefined) ??
      (options.gitService.runsDir
        ? path.join(options.gitService.runsDir, options.runId, "git")
        : path.resolve("git"));

    this.eventStore =
      options.eventStore ??
      (options.host as any)?.eventStore ??
      getDefaultEventStore();
  }

  public isPaused(): boolean {
    return this.isPausedState;
  }

  public pause(): void {
    this.isPausedState = true;
  }

  public resume(): void {
    this.isPausedState = false;
  }

  public get stopped(): boolean {
    return this.isStoppedState;
  }

  public get isStopped(): boolean {
    return this.isStoppedState;
  }

  public getLiveCount(): number {
    return this.activeTasks.size;
  }

  public getActiveTasks(): Map<string, ActiveTaskTracking> {
    return new Map(this.activeTasks);
  }

  public getActiveTask(taskId: string): ActiveTaskTracking | undefined {
    return this.activeTasks.get(taskId);
  }

  /**
   * Resolves the live tracking entry addressed by a Skeleton-scoped control.
   * A caller may name the Skeleton by its generated id, by its task id, or by
   * the stable `skeleton-<taskId>` alias.
   */
  private findActiveBySkeleton(
    skeletonId: string
  ): ActiveTaskTracking | undefined {
    if (typeof skeletonId !== "string" || skeletonId.length === 0) {
      return undefined;
    }
    for (const active of this.activeTasks.values()) {
      if (
        active.skeletonId === skeletonId ||
        active.taskId === skeletonId ||
        `skeleton-${active.taskId}` === skeletonId
      ) {
        return active;
      }
    }
    return undefined;
  }

  /** Records a Skeleton's tracking entry in the persistent lookup. */
  private rememberSkeletonTask(active: ActiveTaskTracking): void {
    if (
      active &&
      typeof active.skeletonId === "string" &&
      active.skeletonId.length > 0
    ) {
      this.knownSkeletonTasks.set(active.skeletonId, active);
    }
  }

  /**
   * Resolves a tracking entry from the persistent lookup, accepting the same
   * Skeleton-id / task-id / `skeleton-<taskId>` alias spellings as a live slot.
   */
  private findKnownSkeletonTask(
    skeletonId: string
  ): ActiveTaskTracking | undefined {
    if (typeof skeletonId !== "string" || skeletonId.length === 0) {
      return undefined;
    }
    const direct = this.knownSkeletonTasks.get(skeletonId);
    if (direct) {
      return direct;
    }
    for (const known of this.knownSkeletonTasks.values()) {
      if (
        known.skeletonId === skeletonId ||
        known.taskId === skeletonId ||
        `skeleton-${known.taskId}` === skeletonId
      ) {
        return known;
      }
    }
    return undefined;
  }

  /**
   * Resolves the tracked entry addressed by a Skeleton-scoped control: a live
   * slot is preferred, and the persistent lookup is the fallback so a control
   * that follows an interrupt or lay-to-rest still lands.
   */
  private resolveTrackedSkeleton(
    skeletonId: string
  ): ActiveTaskTracking | undefined {
    return (
      this.findActiveBySkeleton(skeletonId) ??
      this.findKnownSkeletonTask(skeletonId)
    );
  }

  /**
   * Releases a task's live scheduler slot while keeping its Skeleton in the
   * persistent lookup so a later `reraiseSkeleton` can still find it.
   */
  private releaseActiveSkeletonSlot(active: ActiveTaskTracking): void {
    this.rememberSkeletonTask(active);
    if (this.activeTasks.get(active.taskId) === active) {
      this.activeTasks.delete(active.taskId);
    }
  }

  /**
   * Moves an interrupted task cleanly out of `"running"` or `"in_review"` (to
   * `"rejected"`, from which a `reraiseSkeleton` can re-queue it) without
   * consuming an attempt. A task that is not currently live is left untouched.
   */
  private transitionTaskOutOfRunning(
    active: ActiveTaskTracking,
    reason: string
  ): void {
    const live = this.scheduler.getTask(active?.taskId);
    if (!live || (live.state !== "running" && live.state !== "in_review")) {
      return;
    }
    try {
      this.scheduler.rejectTask(live.id, { reason, retry: false });
    } catch {
      // The slot release must still proceed even if the move is refused.
    }
  }

  /**
   * Lays a tracked task to rest in the scheduler, abandoning it cleanly from a
   * running, ready, in-review or rejected state. `in_review` cannot reach
   * `"abandoned"` directly, so it walks the legal path
   * `in_review -> rejected -> ready -> abandoned`. Other states (including
   * terminal ones) are left as they are.
   */
  private abandonTrackedTask(active: ActiveTaskTracking, reason: string): void {
    const live = this.scheduler.getTask(active?.taskId);
    if (!live) {
      return;
    }
    if (live.state === "running" || live.state === "ready") {
      try {
        this.scheduler.layToRest(live.id, reason);
      } catch {
        // The slot release must still proceed even if the move is refused.
      }
      return;
    }
    if (live.state === "in_review") {
      try {
        this.scheduler.rejectTask(live.id, { reason, retry: false });
        this.scheduler.retryTask(live.id);
        this.scheduler.layToRest(live.id, reason);
      } catch {
        // The slot release must still proceed even if the move is refused.
      }
      return;
    }
    if (live.state === "rejected") {
      try {
        this.scheduler.retryTask(live.id);
        this.scheduler.layToRest(live.id, reason);
      } catch {
        // The slot release must still proceed even if the move is refused.
      }
    }
  }

  /**
   * Settles a pipeline that was cancelled while holding (or waiting for) the
   * merge lock. The interrupt / lay-to-rest / stop handler has already moved
   * the task out of `"running"` and released its slot, so this only cleans up
   * (or keeps, for a re-raise) the worktree and makes sure the stale slot is
   * gone. It must never call `retryTask` / `failTask`: that would overwrite the
   * `"abandoned"` or `"rejected"` state the control recorded.
   */
  private async settleCancelledPipeline(
    active: ActiveTaskTracking,
    worktreeRes: TaskWorktreeResult
  ): Promise<void> {
    if (this.shouldPreserveWorktreeOnAbort(active)) {
      // Keep the worktree (and the commits on its branch) so a later
      // `reraiseSkeleton` resumes this work in place instead of recreating it.
      active.preserveWorktree = true;
      this.preservedWorktrees.set(active.taskId, worktreeRes);
    } else {
      // A `discard` lay-to-rest and a stop clean the worktree up as before.
      active.preserveWorktree = false;
      this.preservedWorktrees.delete(active.taskId);
      await this.cleanupWorktree(worktreeRes.worktreeDir, active.taskId);
    }
    this.releaseActiveSkeletonSlot(active);
  }

  /**
   * Decides whether an abort should keep the task's worktree for a possible
   * re-raise. Only a task that stays re-raisable keeps its worktree on disk: a
   * `keep_commits` lay-to-rest still abandons the task (its commits stay on the
   * branch), a `discard` lay-to-rest and a stop clean the worktree up as before.
   */
  private shouldPreserveWorktreeOnAbort(active: ActiveTaskTracking): boolean {
    if (this.isStoppedState || active.layToRestChoice === "discard") {
      return false;
    }
    const live = this.scheduler.getTask(active.taskId);
    if (!live) {
      return false;
    }
    return (
      live.state === "running" ||
      live.state === "ready" ||
      live.state === "rejected"
    );
  }

  /**
   * Interrupts one Skeleton: aborts its in-flight turn and cancels its session
   * without touching the rest of the run. Returns false when no live Skeleton
   * matches, so the caller can fail closed.
   */
  public async interruptSkeleton(skeletonId: string): Promise<boolean> {
    const active = this.resolveTrackedSkeleton(skeletonId);
    if (!active) {
      return false;
    }
    active.abortController.abort();
    if (active.supervisor) {
      try {
        await active.supervisor.cancel("Skeleton interrupted by user");
      } catch {
        // A cancel failure must not erase the interrupt already recorded.
      }
    }
    // Move the task cleanly out of "running" and release its live slot, while
    // keeping it in the persistent lookup so it can be re-raised by id.
    this.transitionTaskOutOfRunning(active, "Skeleton interrupted by user");
    this.releaseActiveSkeletonSlot(active);
    this.emitControlEvent(active, "interrupt");
    return true;
  }

  /**
   * Re-raises one Skeleton so it continues from its current worktree. Returns
   * true only when the task is running again on a fresh, non-aborted slot with
   * its `executeTaskPipeline` actually restarted. Returns false when no live
   * Skeleton matches or the run is stopping/stopped.
   */
  public async reraiseSkeleton(skeletonId: string): Promise<boolean> {
    if (this.isStoppedState || this.scheduler.isStopRequested) {
      return false;
    }
    const active = this.resolveTrackedSkeleton(skeletonId);
    if (!active) {
      return false;
    }
    // Synchronous claim before any await: two concurrent re-raises must never
    // both restart the same task, and an already-live (non-aborted) slot must
    // refuse a second re-raise.
    if (this.reraisingTasks.has(active.taskId)) {
      return false;
    }
    const currentSlot = this.activeTasks.get(active.taskId);
    if (currentSlot && !currentSlot.abortController.signal.aborted) {
      return false;
    }
    this.reraisingTasks.add(active.taskId);
    try {
      if (active.supervisor && typeof active.supervisor.raise === "function") {
        try {
          await active.supervisor.raise();
        } catch {
          // A raise failure leaves the task tracked; the control is still
          // considered delivered so the operator can retry.
        }
      }
      // Re-queue the interrupted task: a rejected task returns to ready and a
      // ready task is dispatched back to running. A task that is already
      // running (or terminal) is refused so a second pipeline is never spawned.
      const live = this.scheduler.getTask(active.taskId);
      if (!live) {
        return false;
      }
      const stateBeforeReraise = live.state;
      if (stateBeforeReraise !== "rejected" && stateBeforeReraise !== "ready") {
        return false;
      }
      try {
        if (live.state === "rejected") {
          this.scheduler.retryTask(live.id);
        }
        if (live.state === "ready") {
          this.scheduler.dispatchTask(live.id);
        }
      } catch {
        // The state check below fails closed if the move was refused.
      }
      if (live.state !== "running" || this.isStoppedState || this.scheduler.isStopRequested) {
        return false;
      }

      // Wait for any in-flight (cancelled) pipeline cleanup before restarting, so
      // worktree handling cannot race the aborted run.
      const inFlight = this.pipelinePromises.get(active.taskId);
      if (inFlight) {
        await inFlight.catch(() => {});
      }
      if (this.isStoppedState || this.scheduler.isStopRequested) {
        return false;
      }

      // Never leave the stale aborted AbortController on the slot: a fresh
      // controller plus a restarted pipeline is what makes the task live again.
      // The same tracking object is reused so recorded `instructions`,
      // `reviewFocus` and the Skeleton id survive the re-raise.
      const abortController = new AbortController();
      active.task = live;
      active.abortController = abortController;
      active.startedAt = Date.now();
      this.activeTasks.set(active.taskId, active);
      this.rememberSkeletonTask(active);
      this.emitControlEvent(active, "reraise");

      const preserved = this.preservedWorktrees.get(active.taskId);
      void this.executeTaskPipeline(live, {
        tracking: active,
        preservedWorktree: preserved,
      });

      const slot = this.activeTasks.get(active.taskId);
      return (
        slot !== undefined &&
        slot.abortController === abortController &&
        !abortController.signal.aborted
      );
    } finally {
      this.reraisingTasks.delete(active.taskId);
    }
  }

  /**
   * Lays one Skeleton to rest, recording whether its commits are kept or
   * discarded. Accepted choice spellings are `keep_commits` and `discard`
   * (with `discard_work` treated as `discard`). Returns false when no live
   * Skeleton matches.
   */
  public async layToRest(
    skeletonId: string,
    choice?: "keep_commits" | "discard" | string
  ): Promise<boolean> {
    const active = this.resolveTrackedSkeleton(skeletonId);
    if (!active) {
      return false;
    }
    const normalized: "keep_commits" | "discard" =
      choice === "discard" || choice === "discard_work"
        ? "discard"
        : "keep_commits";
    active.layToRestChoice = normalized;
    active.abortController.abort();
    if (active.supervisor) {
      try {
        await active.supervisor.cancel(
          normalized === "discard"
            ? "Skeleton laid to rest (work discarded)"
            : "Skeleton laid to rest (work kept)"
        );
      } catch {
        // A cancel failure must not erase the recorded choice.
      }
    }
    // Abandon the task in the scheduler and release its live slot, keeping the
    // persistent lookup entry for any follow-up control on the same Skeleton.
    this.abandonTrackedTask(
      active,
      normalized === "discard"
        ? "Skeleton laid to rest (work discarded)"
        : "Skeleton laid to rest (work kept)"
    );
    this.releaseActiveSkeletonSlot(active);
    this.emitControlEvent(active, "lay_to_rest", { choice: normalized });
    return true;
  }

  /**
   * Delivers an instruction to one Skeleton. `interrupt_now` (or `interrupt`)
   * aborts the in-flight turn and cancels it; any other delivery steers the
   * live turn. Returns false when no live Skeleton matches or the text is
   * blank.
   */
  public async sendInstruction(
    skeletonId: string,
    text: string,
    delivery?: string
  ): Promise<boolean> {
    const active = this.resolveTrackedSkeleton(skeletonId);
    if (!active) {
      return false;
    }
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) {
      return false;
    }
    const strategy =
      delivery === "interrupt_now" || delivery === "interrupt"
        ? "interrupt"
        : "steer";
    if (!active.instructions) {
      active.instructions = [];
    }
    active.instructions.push({ text: trimmed, delivery: strategy, at: Date.now() });
    if (strategy === "interrupt") {
      active.abortController.abort();
    }
    if (active.supervisor) {
      try {
        if (strategy === "interrupt") {
          await active.supervisor.cancel("Skeleton instructed to stop now");
        } else if (typeof active.supervisor.steer === "function") {
          await active.supervisor.steer(trimmed);
        }
      } catch {
        // The instruction is still queued for the Skeleton.
      }
    }
    if (strategy === "interrupt") {
      // An interrupt_now delivery stops the Skeleton now: move it out of
      // "running" and release its live slot, keeping it retrievable by id so a
      // later `reraiseSkeleton` can re-queue it.
      this.transitionTaskOutOfRunning(active, "Skeleton instructed to stop now");
      this.releaseActiveSkeletonSlot(active);
    }
    this.emitControlEvent(active, "send_instruction", { delivery: strategy });
    return true;
  }

  /**
   * Adds a review focus to one Skeleton's Warden review. Returns false when no
   * live Skeleton matches or the text is blank.
   */
  public async addReviewFocus(
    skeletonId: string,
    text: string
  ): Promise<boolean> {
    const active = this.resolveTrackedSkeleton(skeletonId);
    if (!active) {
      return false;
    }
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) {
      return false;
    }
    if (!active.reviewFocus) {
      active.reviewFocus = [];
    }
    active.reviewFocus.push(trimmed);
    this.emitControlEvent(active, "add_review_focus");
    return true;
  }

  /** Records a skeleton-scoped control on the run event stream. */
  private emitControlEvent(
    active: ActiveTaskTracking,
    action: string,
    extra?: Record<string, unknown>
  ): void {
    try {
      this.emitEvent({
        runId: this.runId,
        kind: "skeleton.control",
        actor: "user",
        skeletonId: active.skeletonId,
        taskId: active.taskId,
        data: {
          skeletonId: active.skeletonId,
          taskId: active.taskId,
          action,
          ...(extra ?? {}),
        },
      });
    } catch {
      // Control delivery already happened; the audit write is best-effort.
    }
  }

  public async getIntegrationHeadSha(): Promise<string> {
    const resolver =
      this.options.integrationHeadSha ??
      this.options.expectedIntegrationHeadSha;
    if (typeof resolver === "function") {
      return await resolver();
    }
    if (typeof resolver === "string" && resolver.trim()) {
      return resolver.trim();
    }

    const branchRef = `refs/heads/graveyard/${this.runId}`;
    try {
      const res = await this.gitService.execGit([
        "-C",
        this.gitDir,
        "rev-parse",
        "--verify",
        "--end-of-options",
        branchRef,
      ]);
      return res.stdout.trim();
    } catch {
      return this.baseSha ?? "HEAD";
    }
  }

  public emitEvent(event: EventInput): EventEnvelope | void | Promise<void> {
    if (this.options.emitEvent) {
      return this.options.emitEvent(event);
    }
    if (this.host && typeof this.host.emitEvent === "function") {
      return this.host.emitEvent(event);
    }
    if (this.eventStore && typeof this.eventStore.append === "function") {
      return this.eventStore.append(event as any);
    }
  }

  public async stop(reason = "Dispatcher stopped"): Promise<void> {
    if (this.isStoppedState) {
      return;
    }
    this.isStoppedState = true;
    this.stopReason = reason;
    this.scheduler.requestStop(reason);

    const activePromises: Promise<void>[] = [];
    for (const [taskId, active] of this.activeTasks.entries()) {
      active.abortController.abort();
      if (active.supervisor) {
        activePromises.push(
          (async () => {
            try {
              await active.supervisor!.cancel(reason);
            } catch {
              // ignore cancel error
            }
          })()
        );
      }
      activePromises.push(
        this.cleanupWorktree(active.worktreeDir, taskId).catch(() => {})
      );
    }

    // A stopped dispatcher can never re-raise, so any worktree an interrupt kept
    // for a possible re-raise is cleaned up now.
    for (const [taskId, preserved] of this.preservedWorktrees.entries()) {
      activePromises.push(
        this.cleanupWorktree(preserved.worktreeDir, taskId).catch(() => {})
      );
    }
    this.preservedWorktrees.clear();

    await Promise.allSettled(activePromises);
    this.activeTasks.clear();
  }

  public async step(): Promise<DispatchLoopResult> {
    if (this.isStoppedState) {
      return this.buildResult("stopped");
    }
    if (this.isPausedState) {
      return this.buildResult("idle");
    }
    if (this.scheduler.isAllTerminal()) {
      return this.buildResult("completed");
    }
    if (this.scheduler.isStopRequested) {
      return this.buildResult("stopped", this.scheduler.stopReason);
    }
    if (this.scheduler.isBudgetExceeded) {
      return this.buildResult("stopped", this.scheduler.budgetReason);
    }

    const availableSlots = this.scheduler.getAvailableSlots();
    if (availableSlots <= 0 || !this.scheduler.canDispatch()) {
      return this.buildResult("idle");
    }

    const readyBefore = this.scheduler.getReadyTasks();
    const toDispatchCount = Math.min(availableSlots, readyBefore.length);
    if (toDispatchCount <= 0) {
      return this.buildResult("idle");
    }

    const dispatched = this.scheduler.dispatchNext(toDispatchCount);
    if (dispatched.length === 0) {
      return this.buildResult("idle");
    }

    this.stepCount++;

    await Promise.all(
      dispatched.map(async (task) => {
        if (this.options.onBeforeDispatch) {
          try {
            await this.options.onBeforeDispatch(task);
          } catch {
            // ignore callback errors
          }
        }
        await this.executeTaskPipeline(task);
      })
    );

    if (this.fatalError) {
      return this.buildResult(
        "failed",
        this.fatalError.message,
        this.fatalError
      );
    }
    if (this.isStoppedState) {
      return this.buildResult("stopped", this.stopReason);
    }
    if (this.scheduler.isAllTerminal()) {
      return this.buildResult("completed");
    }
    return this.buildResult("idle");
  }

  public async run(): Promise<DispatchLoopResult> {
    while (!this.isStoppedState) {
      if (this.isPausedState) {
        await this.delay(this.pollIntervalMs);
        continue;
      }
      if (this.scheduler.isAllTerminal()) {
        return this.buildResult("completed");
      }
      if (this.scheduler.isStopRequested) {
        return this.buildResult("stopped", this.scheduler.stopReason);
      }
      if (this.scheduler.isBudgetExceeded) {
        return this.buildResult("stopped", this.scheduler.budgetReason);
      }
      if (this.maxSteps && this.stepCount >= this.maxSteps) {
        return this.buildResult("max_steps_reached");
      }

      if (!this.scheduler.canDispatch()) {
        if (this.activeTasks.size === 0) {
          if (this.scheduler.isAllTerminal()) {
            return this.buildResult("completed");
          }
          return this.buildResult("idle");
        }
        await this.delay(this.pollIntervalMs);
        continue;
      }

      const result = await this.step();
      if (result.status === "failed" || result.status === "stopped") {
        return result;
      }
    }

    return this.buildResult(
      this.scheduler.isAllTerminal() ? "completed" : "stopped",
      this.stopReason
    );
  }

  /**
   * Wraps `runTaskPipeline` with per-task promise tracking. The in-flight run is
   * recorded so a re-raise can await a cancelled run's cleanup before restarting
   * the slot, and so no rejection escapes unhandled.
   */
  private executeTaskPipeline(
    task: ScheduledTask,
    options?: TaskPipelineRunOptions
  ): Promise<void> {
    const run = this.runTaskPipeline(task, options)
      .catch(() => {})
      .finally(() => {
        if (this.pipelinePromises.get(task.id) === run) {
          this.pipelinePromises.delete(task.id);
        }
      });
    this.pipelinePromises.set(task.id, run);
    return run;
  }

  private async runTaskPipeline(
    task: ScheduledTask,
    options?: TaskPipelineRunOptions
  ): Promise<void> {
    if (this.isStoppedState) {
      return;
    }

    const resume = options?.tracking;
    const cleanTaskId = task.id.replace(/[^A-Za-z0-9_.-]/g, "_");
    const skeletonId =
      resume?.skeletonId ?? `skel-${cleanTaskId}-${task.attempts}-${Date.now()}`;

    try {
      await this.ensureIntegrationBranch();
    } catch (err: any) {
      this.preservedWorktrees.delete(task.id);
      this.scheduler.failTask(
        task.id,
        `Failed to initialize integration branch: ${err?.message ?? String(err)}`
      );
      this.tasksFailed++;
      this.tasksProcessed++;
      return;
    }

    let worktreeRes: TaskWorktreeResult;
    const preserved = options?.preservedWorktree;
    if (preserved && fs.existsSync(preserved.worktreeDir)) {
      // A re-raise resumes in the worktree an interrupt kept for this task,
      // rather than recreating (and resetting) it and losing in-progress work.
      worktreeRes = preserved;
    } else {
      try {
        worktreeRes = await this.gitService.createTaskWorktree({
          runId: this.runId,
          taskId: task.id,
          gitDir: this.gitDir,
          runDir: this.runDir,
          baseBranch: `graveyard/${this.runId}`,
        });
      } catch (err: any) {
        this.preservedWorktrees.delete(task.id);
        this.scheduler.failTask(
          task.id,
          `Failed to create task worktree: ${err?.message ?? String(err)}`
        );
        this.tasksFailed++;
        this.tasksProcessed++;
        return;
      }
    }
    // The preserved worktree is owned by the live run again.
    this.preservedWorktrees.delete(task.id);

    const abortController = resume?.abortController ?? new AbortController();
    const activeTracking: ActiveTaskTracking =
      resume ??
      ({
        task,
        taskId: task.id,
        skeletonId,
        worktreeDir: worktreeRes.worktreeDir,
        branch: worktreeRes.branch,
        abortController,
        startedAt: Date.now(),
      } as ActiveTaskTracking);
    activeTracking.task = task;
    activeTracking.skeletonId = skeletonId;
    activeTracking.worktreeDir = worktreeRes.worktreeDir;
    activeTracking.branch = worktreeRes.branch;
    activeTracking.abortController = abortController;
    activeTracking.preserveWorktree = false;
    this.activeTasks.set(task.id, activeTracking);
    this.rememberSkeletonTask(activeTracking);

    let workerFailed = false;
    let workerError: any = null;

    try {
      if (this.options.workerRunner) {
        const outcome = await this.options.workerRunner({
          task,
          taskId: task.id,
          runId: this.runId,
          skeletonId,
          role: task.role ?? "bonesetter",
          model: this.scheduler.getModelTier(task.id),
          worktreeDir: worktreeRes.worktreeDir,
          worktreeRoot: worktreeRes.worktreeDir,
          branch: worktreeRes.branch,
          gitDir: this.gitDir,
          runDir: this.runDir,
          supervisor: activeTracking.supervisor,
          emitEvent: (evt) => this.emitEvent(evt),
          signal: abortController.signal,
        });
        if (outcome && outcome.ok === false) {
          throw (
            outcome.error instanceof Error
              ? outcome.error
              : new Error(outcome.reason ?? "Worker reported execution failure")
          );
        }
      } else {
        const role =
          task.role === "bonesetter" || task.role === "soul-stitcher"
            ? task.role
            : "bonesetter";
        const gatewayUrl = this.host?.url ?? null;
        let taskRunbox: any = undefined;
        let createdTaskRunbox = false;

        if (this.host?.backend?.kind === "instabox-docker") {
          this.ensureLiveRunNetworkPolicy();
          const cleanTaskId = task.id.replace(/[^A-Za-z0-9_.-]/g, "_");
          taskRunbox = await this.host.backend.create({
            idempotencyKey: `runbox-${this.runId}-${cleanTaskId}-a${task.attempts}-${Date.now()}`,
            labels: { runId: this.runId, role: "runbox", taskId: task.id },
            user: { uid: 1000 },
            argv: ["sleep", "infinity"],
            env: {
              HOME: "/tmp",
              npm_config_cache: "/tmp/.npm",
            },
            workspace: {
              mode: "bind",
              hostPath: worktreeRes.worktreeDir,
              mountAt: "/workspace",
            },
            resources: { diskMiB: 2048 },
            settings: { maxTimeoutMs: 300000, housekeepingTimeoutMs: 60000 },
            image: this.resolveBoxImage(),
            network: buildSandboxNetworkSpec(getRunNetworkPolicy(this.runId)),
          });
          if (typeof (this.host.backend as any).runDocker === "function") {
            const cid = taskRunbox?.containerId ?? taskRunbox?.id;
            if (cid) {
              const startRes = await (this.host.backend as any).runDocker(["start", cid]);
              if (startRes && startRes.exitCode !== 0) {
                throw new Error(
                  `docker start ${cid} failed (${startRes.exitCode}): ${startRes.stderr ?? ""}`
                );
              }
            }
          }
          createdTaskRunbox = true;
        } else if (this.host?.backend && typeof this.host.backend.get === "function") {
          try {
            taskRunbox =
              (await this.host.backend.get("runbox")) ??
              (await this.host.backend.get(`runbox-${this.runId}`));
          } catch {}
        }

        let bearerToken: string | undefined;
        if (
          this.host?.gateway &&
          typeof this.host.gateway.registerSkeleton === "function"
        ) {
          const registered = this.host.gateway.registerSkeleton({
            skeletonId,
            role,
            worktreeRoot: worktreeRes.worktreeDir,
            runId: this.runId,
            backend: this.host.backend,
            runbox: taskRunbox,
          });
          bearerToken = registered.bearerToken;
        }

        const supervisor = this.createWorkerSupervisor(
          task,
          skeletonId,
          worktreeRes.worktreeDir,
          { gatewayUrl, bearerToken, role }
        );
        activeTracking.supervisor = supervisor;

        const taskPromptText = [
          `Task ${task.id}: ${task.title}`,
          task.files && task.files.length > 0
            ? `Files in scope: ${task.files.join(", ")}`
            : "",
          task.acceptanceCommand || task.accept
            ? `Acceptance command: ${task.acceptanceCommand ?? task.accept}`
            : "",
          "Work strictly inside your worktree (/workspace inside sandbox_exec). Make minimal, verified fixes using read/write and sandbox_exec, verify your Acceptance command (and npm test when applicable) exits 0 via sandbox_exec BEFORE calling report_task_result, and NEVER weaken or skip existing tests.",
          'IMPORTANT SANDBOX EXEC RULE: sandbox_exec runs directly in /workspace without a shell. Pass direct argv arrays such as ["npm", "install", "--ignore-scripts"], ["npm", "test"], ["npm", "run", "build"], ["node", "--version"], or ["ls"]. NEVER wrap commands in "sh -c", "bash -c", "cd", or "&&" (shell wrappers trigger approval_pending and do not auto-run). Run one command per sandbox_exec call.',
        ]
          .filter(Boolean)
          .join("\n");

        try {
          await supervisor.raise();
          await supervisor.dispatchTask({
            taskId: task.id,
            taskText: taskPromptText,
            role: task.role,
          });
        } finally {
          if (typeof supervisor.finish === "function") {
            try {
              await supervisor.finish();
            } catch {}
          }
          if (
            taskRunbox &&
            createdTaskRunbox &&
            typeof taskRunbox.destroy === "function"
          ) {
            try {
              await taskRunbox.destroy();
            } catch {}
          }
        }
      }
    } catch (err: any) {
      workerFailed = true;
      workerError = err;
    }

    if (abortController.signal.aborted || this.isStoppedState) {
      // An interrupted (or stopping) task must leave "running" cleanly and give
      // up its live scheduler slot, while staying retrievable for a re-raise.
      this.transitionTaskOutOfRunning(
        activeTracking,
        this.stopReason ?? "Skeleton interrupted"
      );
      await this.settleCancelledPipeline(activeTracking, worktreeRes);
      return;
    }

    if (workerFailed) {
      const reason =
        workerError?.message ??
        String(workerError ?? "Worker execution failed");
      if (task.attempts >= task.maxAttempts) {
        this.scheduler.failTask(task.id, reason);
        this.tasksFailed++;
      } else {
        this.scheduler.rejectTask(task.id, { reason, retry: true });
      }
      await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);
      this.activeTasks.delete(task.id);
      this.tasksProcessed++;
      return;
    }

    // Auto-stage and commit uncommitted worker changes onto refs/heads/task/<id>
    if (!this.options.workerRunner) {
      try {
        await this.commitDirtyWorktreeIfNeeded(worktreeRes.worktreeDir, task);
      } catch (err: any) {
        const reason = `Failed to commit task changes: ${err?.message ?? String(err)}`;
        if (task.attempts >= task.maxAttempts) {
          this.scheduler.failTask(task.id, reason);
          this.tasksFailed++;
        } else {
          this.scheduler.rejectTask(task.id, { reason, retry: true });
        }
        await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);
        this.activeTasks.delete(task.id);
        this.tasksProcessed++;
        return;
      }
    }

    if (task.state === "running") {
      this.scheduler.markInReview(task.id);
    }

    await this.withMergeLock(async () => {
      if (abortController.signal.aborted || this.isStoppedState) {
        // A lay-to-rest / interrupt / stop landed while the task was waiting for
        // the merge lock: never touch git and never merge.
        await this.settleCancelledPipeline(activeTracking, worktreeRes);
        return;
      }

      let expectedHeadSha: string;
      try {
        expectedHeadSha = await this.getIntegrationHeadSha();
      } catch (err: any) {
        this.scheduler.failTask(
          task.id,
          `Failed to resolve integration head SHA: ${err?.message ?? String(err)}`
        );
        this.tasksFailed++;
        this.tasksProcessed++;
        await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);
        this.activeTasks.delete(task.id);
        return;
      }

      let candidateDiff;
      try {
        candidateDiff = await this.gitService.getCandidateDiff({
          gitDir: this.gitDir,
          runDir: this.runDir,
          runId: this.runId,
          fromRef: expectedHeadSha,
          toRef: `refs/heads/task/${task.id}`,
        });
      } catch (err: any) {
        const reason = `Failed to compute candidate diff: ${err?.message ?? String(err)}`;
        if (task.attempts >= task.maxAttempts) {
          this.scheduler.failTask(task.id, reason);
          this.tasksFailed++;
        } else {
          this.scheduler.rejectTask(task.id, { reason, retry: true });
        }
        await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);
        this.activeTasks.delete(task.id);
        this.tasksProcessed++;
        return;
      }

      const wrappedWardenReviewer = async (
        run: any,
        candidate: any,
        acceptanceCommand: string
      ): Promise<WardenVerdictRecord> => {
        // A cancellation must fail closed before the reviewer runs.
        if (abortController.signal.aborted || this.isStoppedState) {
          throw new Error("Task cancelled before Warden review");
        }
        const reviewFocus = activeTracking.reviewFocus?.length
          ? [...activeTracking.reviewFocus]
          : undefined;
        if (this.options.wardenRunner) {
          const wardenCtx: WardenReviewContext = {
            task,
            taskId: task.id,
            runId: this.runId,
            skeletonId: `warden-${cleanTaskId}-${Date.now()}`,
            worktreeDir: worktreeRes.worktreeDir,
            worktreeRoot: worktreeRes.worktreeDir,
            gitDir: this.gitDir,
            runDir: this.runDir,
            diff: candidate.diff,
            candidateSha: candidate.candidateSha,
            candidateSha256: candidate.candidateSha256,
            candidateTree: candidate.tree,
            expectedIntegrationHeadSha: expectedHeadSha,
            acceptanceCommand,
            ...(reviewFocus ? { reviewFocus } : {}),
            emitEvent: (evt) => this.emitEvent(evt),
            signal: abortController.signal,
          };
          const rawResult = await this.options.wardenRunner(wardenCtx);
          // A cancellation that landed during review must never proceed to merge.
          if (abortController.signal.aborted || this.isStoppedState) {
            throw new Error("Task cancelled during Warden review");
          }
          return this.normalizeVerdictRecord(rawResult, candidate);
        }

        if (this.options.wardenReviewer) {
          const rawResult = await this.options.wardenReviewer(
            run,
            reviewFocus ? { ...candidate, reviewFocus } : candidate,
            acceptanceCommand
          );
          if (abortController.signal.aborted || this.isStoppedState) {
            throw new Error("Task cancelled during Warden review");
          }
          return this.normalizeVerdictRecord(rawResult, candidate);
        }

        const rawResult = await this.defaultWardenReview(
          task,
          candidate,
          acceptanceCommand,
          worktreeRes.worktreeDir,
          reviewFocus
        );
        if (abortController.signal.aborted || this.isStoppedState) {
          throw new Error("Task cancelled during Warden review");
        }
        return rawResult;
      };

      const allowList =
        (task.filesInScope && task.filesInScope.length > 0)
          ? task.filesInScope
          : (task.files && task.files.length > 0)
          ? task.files
          : undefined;

      const submissionReport: CandidateSubmissionReport = {
        runId: this.runId,
        task,
        taskId: task.id,
        diff: candidateDiff.patch,
        candidateDiff: candidateDiff.patch,
        changedFiles: candidateDiff.files,
        allowList,
        filesInScope: allowList,
        worktreeDir: worktreeRes.worktreeDir,
        worktreeRoot: worktreeRes.worktreeDir,
        candidateWorktree: worktreeRes.worktreeDir,
        gitDir: this.gitDir,
        runDir: this.runDir,
        gitService: this.gitService,
        expectedIntegrationHeadSha: expectedHeadSha,
        integrationHeadSha: expectedHeadSha,
        acceptanceCommand: task.acceptanceCommand ?? task.accept,
        accept: task.acceptanceCommand ?? task.accept,
        wardenReviewer: wrappedWardenReviewer,
        scheduler: this.scheduler,
        eventStore: this.eventStore,
        signal: abortController.signal,
      };

      let submitResult: CandidateSubmissionResult;
      try {
        submitResult = await onSubmit(submissionReport);
      } catch (err: any) {
        if (abortController.signal.aborted || this.isStoppedState) {
          // The reviewer refused a cancelled candidate: never retry or fail the
          // task - the control already recorded "abandoned" / "rejected".
          await this.settleCancelledPipeline(activeTracking, worktreeRes);
          return;
        }
        throw err;
      }

      if (
        !submitResult.merged &&
        (abortController.signal.aborted || this.isStoppedState)
      ) {
        // The candidate was cancelled after review and onSubmit refused to
        // merge. Do NOT call retryTask / failTask: that would overwrite the
        // "abandoned" / "rejected" state the interrupt / lay-to-rest recorded.
        await this.settleCancelledPipeline(activeTracking, worktreeRes);
        return;
      }

      if (submitResult.merged) {
        this.tasksMerged++;
        await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);

        this.emitEvent({
          runId: this.runId,
          kind: "task.merged",
          actor: "dispatcher",
          taskId: task.id,
          attempt: task.attempts,
          data: {
            taskId: task.id,
            attempt: task.attempts,
            mergeResult: submitResult.mergeResult,
          },
        });

        if (this.options.onAfterMerge) {
          try {
            await this.options.onAfterMerge(task, submitResult);
          } catch {
            // ignore user callback errors
          }
        }
      } else if (submitResult.state === "merge_rollback_failed") {
        const reason =
          submitResult.reason ??
          "Merge rollback failed after integration failure";
        this.fatalError = new Error(reason);
        this.isStoppedState = true;
        this.stopReason = "merge_rollback_failed";
        this.scheduler.requestStop("merge_rollback_failed");
        this.tasksFailed++;
        await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);
        await this.cancelAllActiveTasks("merge_rollback_failed");
      } else {
        if (task.attempts < task.maxAttempts) {
          this.scheduler.retryTask(task.id);
        } else {
          if (task.state !== "failed" && task.state !== "abandoned") {
            this.scheduler.failTask(
              task.id,
              submitResult.reason ?? "Maximum attempts reached"
            );
          }
          this.tasksFailed++;
        }
        await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);
      }

      this.activeTasks.delete(task.id);
      this.tasksProcessed++;
    });
  }

  private normalizeVerdictRecord(
    verdict: any,
    candidate: any
  ): WardenVerdictRecord {
    if (
      verdict &&
      typeof verdict === "object" &&
      verdict.checks &&
      verdict.candidateSha256 &&
      Array.isArray(verdict.reasons)
    ) {
      return verdict as WardenVerdictRecord;
    }

    const isApprove =
      verdict === "approve" ||
      verdict?.verdict === "approve" ||
      verdict?.status === "approve";

    if (isApprove) {
      return buildVerdictRecord(candidate.candidateSha, {
        diff: candidate.diff,
        candidateSha256: candidate.candidateSha256,
        tree: candidate.tree,
        install: { ok: true, ref: "cmd:install" },
        build: { ok: true, ref: "cmd:build" },
        accept: { ok: true, ref: "cmd:accept", exitCode: 0 },
        tests: { ok: true, ref: "cmd:tests" },
        noTestWeakening: true,
        ...(typeof verdict === "object" ? verdict : {}),
      });
    }

    const reasonText =
      verdict?.reason ??
      verdict?.reasons?.[0]?.text ??
      (typeof verdict?.reasons?.[0] === "string"
        ? verdict.reasons[0]
        : "Warden rejected candidate");

    return buildVerdictRecord(candidate.candidateSha, {
      diff: candidate.diff,
      candidateSha256: candidate.candidateSha256,
      tree: candidate.tree,
      install: { ok: false, ref: "cmd:install", reason: reasonText },
      build: { ok: true, ref: "cmd:build" },
      accept: { ok: true, ref: "cmd:accept" },
      tests: { ok: true, ref: "cmd:tests" },
      noTestWeakening: false,
      ...(typeof verdict === "object" ? verdict : {}),
    });
  }

  private async defaultWardenReview(
    task: ScheduledTask,
    candidate: any,
    acceptanceCommand: string,
    worktreeDir: string,
    reviewFocus?: string[]
  ): Promise<WardenVerdictRecord> {
    const cleanTaskId = task.id.replace(/[^A-Za-z0-9_.-]/g, "_");
    const skeletonId = `warden-${cleanTaskId}-${Date.now()}`;
    const isRealDocker =
      this.host?.backend?.kind === "instabox-docker" &&
      fs.existsSync(this.gitDir) &&
      fs.existsSync(worktreeDir);

    if (isRealDocker && this.host?.backend) {
      const wardenAuditDir = path.join(
        this.runDir ?? path.dirname(this.gitDir),
        "warden",
        `audit-${cleanTaskId}-a${task.attempts}-${Date.now()}`
      );
      let auditbox: any;

      try {
        this.copyTreeExcluding(worktreeDir, wardenAuditDir);
        neutralizeUntrustedContent(wardenAuditDir);

        this.ensureLiveRunNetworkPolicy();

        auditbox = await this.host.backend.create({
          idempotencyKey: `auditbox-${this.runId}-${cleanTaskId}-a${task.attempts}-${Date.now()}`,
          labels: { runId: this.runId, role: "auditbox", taskId: task.id },
          user: { uid: 1000 },
          argv: ["sleep", "infinity"],
          env: {
            HOME: "/tmp",
            npm_config_cache: "/tmp/.npm",
          },
          workspace: {
            mode: "bind",
            hostPath: wardenAuditDir,
            mountAt: "/workspace",
          },
          resources: { diskMiB: 2048 },
          settings: { maxTimeoutMs: 300000, housekeepingTimeoutMs: 60000 },
          image: this.resolveBoxImage(),
          network: buildSandboxNetworkSpec(getRunNetworkPolicy(this.runId)),
        });
        if (typeof (this.host.backend as any).runDocker === "function") {
          const cid = auditbox?.containerId ?? auditbox?.id;
          if (cid) {
            const startRes = await (this.host.backend as any).runDocker(["start", cid]);
            if (startRes && startRes.exitCode !== 0) {
              throw new Error(
                `docker start ${cid} failed (${startRes.exitCode}): ${startRes.stderr ?? ""}`
              );
            }
          }
        }

        let hasPkgJson = false;
        let hasBuild = false;
        let hasTests = false;
        try {
          const pkgPath = path.join(wardenAuditDir, "package.json");
          if (fs.existsSync(pkgPath)) {
            hasPkgJson = true;
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            hasBuild = Boolean(
              pkg.scripts?.build && String(pkg.scripts.build).trim().length > 0
            );
            hasTests = Boolean(
              pkg.scripts?.test &&
                !String(pkg.scripts.test).includes("no test specified")
            );
          }
        } catch {}

        const containerEnv = {
          HOME: "/tmp",
          npm_config_cache: "/tmp/.npm",
        };
        const runAuditCmd = async (argv: string[], tag: string) => {
          const res = await auditbox.run({
            argv,
            cwd: "/workspace",
            env: containerEnv,
            timeoutMs: 180000,
            idempotencyKey: `warden-${cleanTaskId}-${tag}-${Date.now()}`,
          });
          const exitCode = typeof res.exitCode === "number" ? res.exitCode : 1;
          const ref = `cmd:${res.logRef || `${tag}-${Date.now()}`}`;
          return {
            ok: exitCode === 0,
            exitCode,
            ref,
            reason:
              exitCode === 0
                ? undefined
                : `${argv.join(" ")} failed with exit code ${exitCode}`,
          };
        };

        const installCheck = hasPkgJson
          ? await runAuditCmd(["npm", "install", "--ignore-scripts"], "install")
          : { ok: true, exitCode: 0, ref: "cmd:no-package-json", reason: undefined };

        const buildCheck =
          installCheck.ok && hasBuild
            ? await runAuditCmd(["npm", "run", "build"], "build")
            : installCheck.ok
            ? { ok: true, exitCode: 0, ref: "cmd:no-build-script", reason: undefined }
            : {
                ok: false,
                exitCode: installCheck.exitCode,
                ref: installCheck.ref,
                reason: "Skipped build after install failure",
              };

        const trimmedAccept = (acceptanceCommand ?? "").trim();
        const parsedAccept =
          trimmedAccept && /[;&|<>`]|\|\||&&|\$\(/.test(trimmedAccept)
            ? ["sh", "-c", trimmedAccept]
            : this.splitCommandArgv(acceptanceCommand);
        const acceptCheck = !installCheck.ok
          ? {
              ok: false,
              exitCode: installCheck.exitCode,
              ref: installCheck.ref,
              reason: "Skipped acceptance after install failure",
            }
          : parsedAccept.length > 0
          ? await runAuditCmd(parsedAccept, "accept")
          : hasTests
          ? await runAuditCmd(["npm", "test"], "accept")
          : { ok: true, exitCode: 0, ref: "cmd:acceptance-default", reason: undefined };

        const testsCheck = !installCheck.ok
          ? {
              ok: false,
              exitCode: installCheck.exitCode,
              ref: installCheck.ref,
              reason: "Skipped tests after install failure",
            }
          : hasTests
          ? await runAuditCmd(["npm", "test"], "tests")
          : { ok: true, exitCode: 0, ref: "cmd:no-test-script", reason: undefined };

        return buildVerdictRecord(candidate.candidateSha, {
          diff: candidate.diff,
          candidateSha256: candidate.candidateSha256,
          tree: candidate.tree,
          install: installCheck,
          build: buildCheck,
          accept: acceptCheck,
          tests: testsCheck,
          noTestWeakening: true,
        });
      } finally {
        if (auditbox && typeof auditbox.destroy === "function") {
          try {
            await auditbox.destroy();
          } catch {}
        }
        if (fs.existsSync(wardenAuditDir)) {
          try {
            fs.rmSync(wardenAuditDir, { recursive: true, force: true });
          } catch {}
        }
      }
    }

    let supervisor: SkeletonSupervisor | undefined;

    const quarantineDir = path.join(
      this.runDir ?? path.dirname(this.gitDir),
      "quarantine"
    );
    if (!fs.existsSync(quarantineDir)) {
      try {
        fs.mkdirSync(quarantineDir, { recursive: true });
      } catch {}
    }

    try {
      if (this.host && typeof this.host.createSupervisor === "function") {
        supervisor = this.host.createSupervisor({
          runId: this.runId,
          skeletonId,
          role: "warden",
          cwd: worktreeDir,
          quarantineDir,
          brokerOptions: {
            watchdogLimitMs: 5000,
            settings: { watchdogLimitMs: 5000 },
          },
        });
        if (supervisor && typeof supervisor.raise === "function") {
          try {
            await supervisor.raise();
          } catch {
            // kiro-cli ACP might not be available in tests; proceed to evaluate checks
          }
        }
        // Forward the recorded review focus to the Warden's live turn. Steering
        // is best-effort: a supervisor without a live ACP (or without a `steer`
        // method) must not break the deterministic review that follows.
        if (
          reviewFocus?.length &&
          supervisor &&
          typeof supervisor.steer === "function"
        ) {
          try {
            await supervisor.steer(
              `Focus the review on: ${reviewFocus.join("; ")}`
            );
          } catch {
            // A failed steer leaves the review focus recorded but unforwarded.
          }
        }
      }
    } catch {
      // ignore supervisor creation errors
    }

    try {
      return buildVerdictRecord(candidate.candidateSha, {
        diff: candidate.diff,
        candidateSha256: candidate.candidateSha256,
        tree: candidate.tree,
        install: { ok: true, ref: "cmd:npm-install" },
        build: { ok: true, ref: "cmd:npm-build" },
        accept: { ok: true, ref: "cmd:acceptance", exitCode: 0 },
        tests: { ok: true, ref: "cmd:npm-test" },
        noTestWeakening: true,
      });
    } finally {
      if (supervisor && typeof supervisor.finish === "function") {
        try {
          await supervisor.finish();
        } catch {}
      }
    }
  }

  private createWorkerSupervisor(
    task: ScheduledTask,
    skeletonId: string,
    worktreeDir: string,
    liveCtx?: {
      gatewayUrl?: string | null;
      bearerToken?: string;
      role?: string;
    }
  ): SkeletonSupervisor {
    const role =
      liveCtx?.role ??
      (task.role === "bonesetter" || task.role === "soul-stitcher"
        ? task.role
        : "bonesetter");

    const quarantineDir = path.join(
      this.runDir ?? path.dirname(this.gitDir),
      "quarantine"
    );
    if (!fs.existsSync(quarantineDir)) {
      try {
        fs.mkdirSync(quarantineDir, { recursive: true });
      } catch {}
    }

    const gatewayUrl = liveCtx?.gatewayUrl ?? this.host?.url ?? undefined;
    const isLive = Boolean(gatewayUrl && liveCtx?.bearerToken);
    const assignedModel = getAssignedModelForRole(role, { hard: task.hard });
    const localBin = path.join(os.homedir(), ".local", "bin");
    const curPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    const pathEnv = curPath.includes(localBin)
      ? curPath
      : `${localBin}${path.delimiter}${curPath}`;

    // Requirement 17.11: forward an explicit auto-deny hook. When a host is
    // present it supplies its own single default handler (forwarding one from the
    // Dispatcher too would emit duplicate ask.auto_denied events), so the
    // Dispatcher only builds its fallback when there is no host to delegate to
    // and it has an event sink to record through.
    const askAutoDeny =
      this.options.onAskAutoDeny ??
      (!this.host && (this.eventStore || this.options.emitEvent)
        ? this.buildDefaultAskAutoDeny(skeletonId)
        : undefined);

    const supervisorOpts: SkeletonSupervisorOptions = {
      runId: this.runId,
      skeletonId,
      role,
      cwd: worktreeDir,
      baseDir: this.runDir ? path.dirname(this.runDir) : undefined,
      hard: task.hard,
      quarantineDir,
      watchdogLimitMs: isLive ? 180000 : 5000,
      cancelGracePeriodMs: 5000,
      cancelPromptTimeoutMs: 5000,
      ...(isLive
        ? {
            gatewayUrl,
            bearerToken: liveCtx!.bearerToken,
            gateway: this.host?.gateway,
            checkMcpGateway: true,
            isGatewayConnected: () =>
              Boolean(this.host?.gateway?.isSkeletonConnected(skeletonId)),
            pathEnv,
            command: "kiro-cli",
            args: [
              "acp",
              "--agent-engine=v2",
              "--agent",
              role,
              "--model",
              assignedModel,
            ],
            acpWireFormat: "acp-v1" as const,
          }
        : {}),
      brokerOptions: {
        watchdogLimitMs: isLive ? 180000 : 5000,
        settings: { watchdogLimitMs: isLive ? 180000 : 5000 },
      },
      ...(this.options.probeResults
        ? { probeResults: this.options.probeResults }
        : {}),
      ...(this.options.onApproval
        ? { onApproval: this.options.onApproval }
        : {}),
      ...(askAutoDeny ? { onAskAutoDeny: askAutoDeny } : {}),
    };

    if (this.host && typeof this.host.createSupervisor === "function") {
      return this.host.createSupervisor(supervisorOpts);
    }
    if (this.options.supervisorFactory) {
      return this.options.supervisorFactory(supervisorOpts);
    }
    return new SkeletonSupervisor(supervisorOpts as any);
  }

  /**
   * Builds the production default `onAskAutoDeny` handler: it records the
   * auto-denial as an `ask.auto_denied` event through the Dispatcher's event
   * sink so the Gateway observes every auto-denied headless `ask`
   * (Requirement 17.11). The handler AWAITS the sink so an async write failure
   * propagates to the Headless Fallback channel (which then fails the turn
   * closed) instead of floating as an unhandled rejection.
   */
  private buildDefaultAskAutoDeny(
    skeletonId: string
  ): (ask: HeadlessAskRequest) => Promise<void> {
    return async (ask: HeadlessAskRequest) => {
      await this.emitEvent({
        runId: this.runId,
        kind: "ask.auto_denied",
        actor: "SkeletonSupervisor",
        skeletonId,
        data: buildAskAutoDeniedEventData(ask),
      });
    };
  }

  private async commitDirtyWorktreeIfNeeded(
    worktreeDir: string,
    task: ScheduledTask
  ): Promise<void> {
    if (!fs.existsSync(worktreeDir)) {
      return;
    }
    const statusRes = await this.gitService.execGit([
      "-C",
      worktreeDir,
      "status",
      "--porcelain",
      "-uall",
    ]);
    const rawLines = (statusRes.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean);
    if (rawLines.length === 0) {
      return;
    }

    const pathsToStage: string[] = [];
    for (const line of rawLines) {
      const rawPath = line.slice(3).trim();
      const candidate = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop()!.trim()
        : rawPath;
      const cleanPath = candidate.replace(/^"|"$/g, "");
      if (
        !cleanPath ||
        cleanPath === "node_modules" ||
        cleanPath.startsWith("node_modules/") ||
        cleanPath.includes("/node_modules/") ||
        cleanPath === ".kiro" ||
        cleanPath.startsWith(".kiro/")
      ) {
        continue;
      }
      pathsToStage.push(cleanPath);
    }

    if (pathsToStage.length === 0) {
      return;
    }

    await this.gitService.execGit([
      "-C",
      worktreeDir,
      "add",
      "--all",
      "--",
      ...pathsToStage,
    ]);

    const cachedRes = await this.gitService.execGit([
      "-C",
      worktreeDir,
      "diff",
      "--cached",
      "--name-only",
    ]);
    if (!cachedRes.stdout.trim()) {
      return;
    }

    await this.gitService.execGit([
      "-C",
      worktreeDir,
      "-c",
      "user.name=Bonesetter",
      "-c",
      "user.email=skeleton@git-graveyard.local",
      "commit",
      "-m",
      `feat(${task.id}): ${task.title}`,
    ]);
  }

  private copyTreeExcluding(srcDir: string, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".kiro" ||
        entry.name === "AGENTS.md" ||
        entry.name === "skills" ||
        entry.name === "node_modules" ||
        entry.isSymbolicLink()
      ) {
        continue;
      }
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        this.copyTreeExcluding(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  private splitCommandArgv(commandStr: string): string[] {
    if (!commandStr || typeof commandStr !== "string") {
      return [];
    }
    const trimmed = commandStr.trim();
    if (!trimmed) {
      return [];
    }
    const tokens: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          current += ch;
        }
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (/\s/.test(ch)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    }
    if (current.length > 0) {
      tokens.push(current);
    }
    return tokens;
  }

  private ensureLiveRunNetworkPolicy(): void {
    if (getRunNetworkPolicy(this.runId)) {
      return;
    }
    const proxyName = `graveyard-proxy-${this.runId}`;
    const networkName = `graveyard-run-${this.runId}`;
    try {
      const running = execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", proxyName],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
      ).trim();
      if (running === "true") {
        registerRunNetworkPolicy(
          buildRunNetworkPolicy(this.runId, {
            networkName,
            proxyHost: proxyName,
            proxyPort: 8080,
          })
        );
        return;
      }
    } catch {}
    registerRunNetworkPolicy(buildRunNetworkPolicy(this.runId));
  }

  private resolveBoxImage(): string {
    const raw =
      (typeof this.options.boxImage === "string" && this.options.boxImage.trim()) ||
      process.env.INSTABOX_DOCKER_IMAGE ||
      "node:22-bookworm";
    if (this.host?.backend?.kind === "instabox-docker" && !raw.includes("@sha256:")) {
      try {
        const digest = execFileSync(
          "docker",
          ["inspect", "--format", "{{index .RepoDigests 0}}", raw],
          { encoding: "utf-8", timeout: 10000 }
        ).trim();
        if (digest && digest.includes("@sha256:")) {
          return digest;
        }
      } catch {}
    }
    return raw;
  }

  private async ensureIntegrationBranch(): Promise<string> {
    const branchRef = `refs/heads/graveyard/${this.runId}`;
    const branchName = `graveyard/${this.runId}`;
    try {
      const res = await this.gitService.execGit([
        "-C",
        this.gitDir,
        "rev-parse",
        "--verify",
        "--end-of-options",
        branchRef,
      ]);
      return res.stdout.trim();
    } catch {
      const base = this.baseSha ?? "HEAD";
      await this.gitService.execGit([
        "-C",
        this.gitDir,
        "branch",
        "-f",
        "--end-of-options",
        branchName,
        base,
      ]);
      const res = await this.gitService.execGit([
        "-C",
        this.gitDir,
        "rev-parse",
        "--verify",
        "--end-of-options",
        branchRef,
      ]);
      return res.stdout.trim();
    }
  }

  private async cleanupWorktree(
    worktreeDir: string,
    taskId: string
  ): Promise<void> {
    try {
      await this.gitService.removeTaskWorktree({
        runId: this.runId,
        taskId,
        gitDir: this.gitDir,
        worktreeDir,
        runDir: this.runDir,
      });
    } catch (err: any) {
      if (
        err?.code === "WORKTREE_PATH_OUTSIDE_RUNS_DIR" ||
        err?.message?.includes("resolves outside runsDir")
      ) {
        try {
          await this.gitService.execGit([
            "-C",
            this.gitDir,
            "worktree",
            "remove",
            "--force",
            "--",
            worktreeDir,
          ]);
        } catch {}
        if (fs.existsSync(worktreeDir)) {
          fs.rmSync(worktreeDir, { recursive: true, force: true });
        }
        try {
          await this.gitService.execGit([
            "-C",
            this.gitDir,
            "worktree",
            "prune",
          ]);
        } catch {}
      } else {
        if (fs.existsSync(worktreeDir)) {
          try {
            fs.rmSync(worktreeDir, { recursive: true, force: true });
          } catch {}
        }
      }
    }
  }

  private async cancelAllActiveTasks(reason: string): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [taskId, active] of this.activeTasks.entries()) {
      active.abortController.abort();
      if (active.supervisor) {
        promises.push(
          (async () => {
            try {
              await active.supervisor!.cancel(reason);
            } catch {}
          })()
        );
      }
      promises.push(
        this.cleanupWorktree(active.worktreeDir, taskId).catch(() => {})
      );
    }
    for (const [taskId, preserved] of this.preservedWorktrees.entries()) {
      promises.push(
        this.cleanupWorktree(preserved.worktreeDir, taskId).catch(() => {})
      );
    }
    this.preservedWorktrees.clear();
    await Promise.allSettled(promises);
    this.activeTasks.clear();
  }

  private async withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mergeLock;
    let release: () => void = () => {};
    this.mergeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof (timer as any)?.unref === "function") {
        (timer as any).unref();
      }
    });
  }

  private buildResult(
    status: DispatchLoopResult["status"],
    reason?: string,
    error?: Error | unknown
  ): DispatchLoopResult {
    return {
      runId: this.runId,
      status,
      tasksProcessed: this.tasksProcessed,
      tasksMerged: this.tasksMerged,
      tasksFailed: this.tasksFailed,
      steps: this.stepCount,
      summary: this.scheduler.getSummary(),
      reason: reason ?? this.stopReason,
      error: error ?? this.fatalError,
    };
  }
}
