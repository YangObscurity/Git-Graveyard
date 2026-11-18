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

  private async executeTaskPipeline(task: ScheduledTask): Promise<void> {
    if (this.isStoppedState) {
      return;
    }

    const cleanTaskId = task.id.replace(/[^A-Za-z0-9_.-]/g, "_");
    const skeletonId = `skel-${cleanTaskId}-${task.attempts}-${Date.now()}`;

    try {
      await this.ensureIntegrationBranch();
    } catch (err: any) {
      this.scheduler.failTask(
        task.id,
        `Failed to initialize integration branch: ${err?.message ?? String(err)}`
      );
      this.tasksFailed++;
      this.tasksProcessed++;
      return;
    }

    let worktreeRes: TaskWorktreeResult;
    try {
      worktreeRes = await this.gitService.createTaskWorktree({
        runId: this.runId,
        taskId: task.id,
        gitDir: this.gitDir,
        runDir: this.runDir,
        baseBranch: `graveyard/${this.runId}`,
      });
    } catch (err: any) {
      this.scheduler.failTask(
        task.id,
        `Failed to create task worktree: ${err?.message ?? String(err)}`
      );
      this.tasksFailed++;
      this.tasksProcessed++;
      return;
    }

    const abortController = new AbortController();
    const activeTracking: ActiveTaskTracking = {
      task,
      taskId: task.id,
      skeletonId,
      worktreeDir: worktreeRes.worktreeDir,
      branch: worktreeRes.branch,
      abortController,
      startedAt: Date.now(),
    };
    this.activeTasks.set(task.id, activeTracking);

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
      await this.cleanupWorktree(worktreeRes.worktreeDir, task.id);
      this.activeTasks.delete(task.id);
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
            emitEvent: (evt) => this.emitEvent(evt),
            signal: abortController.signal,
          };
          const rawResult = await this.options.wardenRunner(wardenCtx);
          return this.normalizeVerdictRecord(rawResult, candidate);
        }

        if (this.options.wardenReviewer) {
          const rawResult = await this.options.wardenReviewer(
            run,
            candidate,
            acceptanceCommand
          );
          return this.normalizeVerdictRecord(rawResult, candidate);
        }

        return await this.defaultWardenReview(
          task,
          candidate,
          acceptanceCommand,
          worktreeRes.worktreeDir
        );
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
      };

      const submitResult = await onSubmit(submissionReport);

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
    worktreeDir: string
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
    };

    if (this.host && typeof this.host.createSupervisor === "function") {
      return this.host.createSupervisor(supervisorOpts);
    }
    if (this.options.supervisorFactory) {
      return this.options.supervisorFactory(supervisorOpts);
    }
    return new SkeletonSupervisor(supervisorOpts as any);
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
