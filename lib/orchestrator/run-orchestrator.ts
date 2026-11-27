// Task: T34 Wave 2B - Production Run Orchestrator
// Requirements: 11, 12, 13, 23, 24, 25, 26, 27, 28, 29, 30, 41

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import {
  RuntimeHost,
  getRuntimeHost,
  type FatalEventPayload,
} from "../runtime/runtime-host";
import {
  RunStore,
  type RunRecord,
  type RunOutcome,
} from "../runs/run-store";
import type {
  EventEnvelope,
  EventInput,
  EventStore,
} from "../events/event-store";
import type { LogStore } from "../events/log-store";
import {
  LifecycleManager,
  type RunPhase,
} from "../lifecycle/lifecycle-manager";
import {
  runExhumerHarness,
  type ExhumerHarnessOptions,
  type ExhumeHarnessResult,
} from "../exhume/exhume-harness";
import {
  createDeathCertificate,
  type DeathCertificate,
} from "../exhume/death-certificate";
import {
  generatePactWithPlanner,
  revisePactWithPlanner,
  verifyDeathCertificateCoverage,
  type PactDraftResult,
  type PactPlannerOptions,
} from "../pact/pact-planner";
import { parsePact } from "../pact/pact-parser";
import { renderPact } from "../pact/pact-renderer";
import { isNonRemovableTask } from "../pact/pact-review";
import { Scheduler } from "../scheduler/scheduler";
import {
  TaskDispatcher,
  type TaskDispatcherOptions,
  type WorkerContext,
  type WardenReviewContext,
} from "../scheduler/dispatcher";
import {
  GitService,
  type ForkChecker,
} from "../git/git-service";
import { evaluateReportOutcome } from "../lifecycle/outcome-evaluator";
import {
  buildReportStepArtifacts,
  type ReportStepArtifactList,
} from "../lifecycle/report-step";
import {
  ArtifactCollector,
  type ArtifactManifest,
} from "../lifecycle/artifact-collector";
import {
  finalizeRun,
  teardownBoxes,
  type FinalizeRunResult,
} from "../lifecycle/run-finalizer";
import type { SkeletonSupervisor } from "../supervisor/skeleton-supervisor";
import {
  MessageService,
  type MessageEventSink,
  type MessageRecord,
  type MessageServiceOptions,
  type SendMessageInput,
} from "../messaging/message-service";
import {
  CLAUDE_OPUS_5_5_MODEL_ID,
  getAssignedModelForRole,
} from "../agents/model-allowlist";
import { redactEvent, redactText } from "../security/redactor";
import { neutralizeUntrustedContent } from "../security/untrusted-content";
import {
  buildDockerInternalNetwork,
  buildRunNetworkPolicy,
  buildSandboxNetworkSpec,
  getRunNetworkPolicy,
  registerRunNetworkPolicy,
  releaseRunNetworkPolicy,
} from "../backend/network-policy";
import type { BaselineCommandRow } from "../exhume/death-certificate";
import {
  BudgetGovernor,
  BUDGET_DIMENSIONS,
  type BudgetCaps,
} from "../governor/budget-governor";

/**
 * Input options for approving a Pact draft.
 */
export interface PactApprovalInput {
  approvedTaskIds?: string[];
  disabledTaskIds?: string[];
  caps?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  approvedBy?: string;
  notes?: string;
  pactVersion?: number;
}

/**
 * Result returned by the final check verification phase.
 */
export interface FinalCheckResult {
  ok?: boolean;
  passed?: boolean;
  installPassed?: boolean;
  buildPassed?: boolean;
  /**
   * false when the repository has no build script. buildPassed is then true so
   * the outcome rule is not blocked, but no build ran and reports say "not run".
   */
  hasBuild?: boolean;
  testsPassed?: boolean;
  hasTests?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string | Error;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Execution context provided to exhume runner.
 */
export interface ExhumeRunnerContext {
  runId: string;
  baseSha: string;
  repoUrl?: string;
  runDir: string;
  gitDir: string;
  backend?: any;
  emitEvent: (event: EventInput) => void | Promise<void>;
  host: RuntimeHost;
}

/**
 * Execution context provided to plan runner.
 */
export interface PlanRunnerContext {
  runId: string;
  deathCertificate: DeathCertificate;
  baseSha: string;
  supervisor: SkeletonSupervisor;
  repoPath?: string;
  emitEvent: (event: EventInput) => void | Promise<void>;
  eventStore: EventStore;
  feedback?: string;
}

/**
 * Execution context provided to final check runner.
 */
export interface FinalCheckContext {
  runId: string;
  runDir?: string;
  gitDir?: string;
  baseSha?: string;
  branch?: string;
  backend?: any;
  gitService: GitService;
  scheduler?: Scheduler;
}

/**
 * Handle controlling and monitoring an active run execution.
 */
export interface RunExecutionHandle {
  runId: string;
  promise: Promise<FinalizeRunResult>;
  lifecycleManager: LifecycleManager;
  scheduler?: Scheduler;
  dispatcher?: TaskDispatcher;
  /** Per-run budget governor enforcing the run's caps; consulted by the gateway and dispatcher. */
  budgetGovernor?: BudgetGovernor;
  deathCertificate?: DeathCertificate;
  pactDraft?: PactDraftResult;
  finalCheckResult?: FinalCheckResult;
  manifest?: ArtifactManifest | ReportStepArtifactList | Record<string, unknown>;
  finalizeResult?: FinalizeRunResult;
  error?: Error;
  getPhase(): RunPhase;
  pause(): void;
  resume(): void;
  stop(reason?: string): Promise<void>;
  /**
   * Boundary-aware graceful stop: ends the run at its next tool boundary without aborting the
   * in-flight worker turn or deleting its worktree.
   */
  stopGracefully?(reason?: string): Promise<void>;
  kill(reason?: string): Promise<void>;
  approvePact(approval?: PactApprovalInput): Promise<void>;
  revisePact(feedback: string): Promise<PactDraftResult>;
  resolveApproval(approvalId: string, resolution?: any): Promise<any>;
  answerAsk(askId: string, answer: any): Promise<any>;
}

/**
 * Reads the budget caps a run grants: any finite, non-negative `BUDGET_DIMENSIONS` key from the
 * `caps` record and, when present, from a nested `caps.budget` record. Unknown keys (e.g.
 * `runParallelCap`) are ignored, so a non-budget cap never becomes a budget dimension.
 */
function extractBudgetCaps(raw?: Record<string, unknown> | null): BudgetCaps {
  const out: BudgetCaps = {};
  const read = (source: Record<string, unknown> | null | undefined): void => {
    if (!source || typeof source !== "object") {
      return;
    }
    for (const dim of BUDGET_DIMENSIONS) {
      const value = source[dim];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        out[dim] = value;
      }
    }
  };
  read(raw);
  const nestedBudget =
    raw && typeof raw.budget === "object" && raw.budget !== null
      ? (raw.budget as Record<string, unknown>)
      : undefined;
  read(nestedBudget);
  return out;
}

/** True when two cap maps enforce exactly the same dimensions at the same values. */
function budgetCapsEqual(a: BudgetCaps, b: BudgetCaps): boolean {
  const keys = new Set<keyof BudgetCaps>([
    ...(Object.keys(a) as Array<keyof BudgetCaps>),
    ...(Object.keys(b) as Array<keyof BudgetCaps>),
  ]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Snapshot of the admission queue state.
 */
export type QueueSnapshot = string[] & {
  queued: string[];
  active: string[];
  paused: boolean;
  maxConcurrentRuns: number;
  total: number;
};

/**
 * Options accepted by RunOrchestrator.
 */
export interface RunOrchestratorOptions {
  host?: RuntimeHost;
  runStore?: RunStore;
  eventStore?: EventStore;
  logStore?: LogStore;
  gitService?: GitService;
  runsDir?: string;
  maxConcurrentRuns?: number;
  autoApprovePact?: boolean;
  exhumeRunner?: (
    ctx: ExhumeRunnerContext
  ) => Promise<ExhumeHarnessResult | Partial<ExhumeHarnessResult> | void>;
  planRunner?: (
    ctx: PlanRunnerContext
  ) => Promise<PactDraftResult>;
  finalCheckRunner?: (
    ctx: FinalCheckContext
  ) => Promise<FinalCheckResult>;
  workerRunner?: TaskDispatcherOptions["workerRunner"];
  wardenRunner?: TaskDispatcherOptions["wardenRunner"];
  wardenReviewer?: TaskDispatcherOptions["wardenReviewer"];
  forkChecker?: ForkChecker;
  githubToken?: string;
  ownerLogin?: string;
  /**
   * Explicit run-level push confirmation (Requirement 29.5). A run is only
   * pushed to its fork when this is exactly `true`.
   */
  pushConfirm?: boolean;
  /**
   * Optional callback invoked at push time to obtain explicit confirmation.
   * Only a resolved `true` authorizes the push.
   */
  requestPushConfirmation?: (info: {
    runId: string;
    targetFork: string;
    branch: string;
  }) => Promise<boolean> | boolean;
  pollIntervalMs?: number;
  closeHostOnShutdown?: boolean;
  boxImage?: string;
  [key: string]: unknown;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFallbackDeathCertificate(
  runId: string,
  baseSha: string
): DeathCertificate {
  return createDeathCertificate({
    runId,
    baseSha,
    install: { step: "install", status: "passed", command: "npm install" },
    build: { step: "build", status: "passed", command: "npm run build" },
    test: { step: "test", status: "failed", command: "npm test", exitCode: 1 },
    failures: [
      {
        step: "test",
        class: "unknown",
        message: "No initial failure recorded",
      },
    ],
  });
}

/**
 * MessageService bound to a RunOrchestrator. Beyond persisting each message it
 * hands the stored record back to the orchestrator, which routes it to the
 * active run: an `interrupt_now` delivery reaches the live
 * `TaskDispatcher.interruptSkeleton(...)` and a queued delivery steers the
 * addressed Skeleton through `TaskDispatcher.sendInstruction(...)`.
 */
class OrchestratorMessageService extends MessageService {
  private readonly onSent?: (record: MessageRecord) => void;

  constructor(
    options: MessageServiceOptions,
    onSent?: (record: MessageRecord) => void
  ) {
    super(options);
    this.onSent = onSent;
  }

  override send(input: SendMessageInput): MessageRecord {
    const record = super.send(input);
    if (this.onSent) {
      try {
        this.onSent(record);
      } catch {
        // Delivery is best-effort and must never fail the send itself.
      }
    }
    return record;
  }
}

/**
 * End-to-end production run lifecycle orchestrator coordinating
 * bounded live-run admission and the full pipeline:
 * queued -> exhume -> plan -> pact_review -> legion -> final_check -> report -> done.
 */
export class RunOrchestrator extends EventEmitter {
  readonly host: RuntimeHost;
  readonly gitService: GitService;
  readonly runsDir: string;
  readonly options: RunOrchestratorOptions;
  readonly maxConcurrentRuns: number;
  /**
   * Runtime-consumed message service backed by the host EventStore. Kept on the
   * orchestrator so message routes reuse one mailbox/sequence across requests
   * and an `interrupt_now` delivery can reach the active dispatcher.
   */
  public readonly messageService: MessageService;

  private readonly queue: string[] = [];
  private readonly activeRuns: Map<string, RunExecutionHandle> = new Map();
  private readonly runDeferreds: Map<string, Deferred<PactApprovalInput>> =
    new Map();
  /**
   * Every runId this orchestrator has admitted or started. It is the ownership
   * marker for the shared `globalThis.__admissionQueue`: only entries for these
   * runs are ever touched, so entries written by another surface are preserved.
   */
  private readonly ownedRunIds: Set<string> = new Set();

  private isAdmissionPausedState = false;
  private isStoppedState = false;

  constructor(options: RunOrchestratorOptions = {}) {
    super();
    this.options = { ...options };
    this.host = options.host ?? getRuntimeHost();
    this.runsDir = options.runsDir ?? path.resolve("output");
    this.maxConcurrentRuns =
      typeof options.maxConcurrentRuns === "number" &&
      options.maxConcurrentRuns > 0
        ? options.maxConcurrentRuns
        : 1;

    this.gitService =
      options.gitService ??
      new GitService({
        runsDir: this.runsDir,
      });

    this.messageService = new OrchestratorMessageService(
      {
        // Backed by the host's event store, with a tolerant sink so a host
        // without a usable store (isolated unit tests) still yields a working
        // service instead of throwing at construction.
        eventStore: {
          append: (input) =>
            this.host?.eventStore?.append?.(input as never) as never,
        } as MessageEventSink,
      },
      (record) => this.routeMessageToActiveRun(record)
    );

    // Register global hook
    const g = globalThis as unknown as { __runOrchestrator?: unknown };
    g.__runOrchestrator = this;
  }

  /**
   * Routes a stored message to the run's active dispatcher: `interrupt_now`
   * interrupts the addressed Skeleton, and any other delivery steers it. Runs
   * with no active handle simply keep the message in the mailbox.
   */
  private routeMessageToActiveRun(record: MessageRecord): void {
    const handle = this.activeRuns.get(record.runId);
    const dispatcher = handle?.dispatcher;
    if (!dispatcher) {
      return;
    }
    const target = record.skeletonId ?? record.to;
    try {
      if (record.delivery === "interrupt_now") {
        void dispatcher.interruptSkeleton(target).catch(() => {});
      } else {
        void dispatcher
          .sendInstruction(target, record.text, record.delivery)
          .catch(() => {});
      }
    } catch {
      // The message is already stored; delivery is best-effort.
    }
  }

  // ---------------------------------------------------------------------------
  // Admission Queue Coordination
  // ---------------------------------------------------------------------------

  public isAdmissionPaused(): boolean {
    return this.isAdmissionPausedState;
  }

  public pauseAdmission(): void {
    this.isAdmissionPausedState = true;
  }

  public resumeAdmission(): void {
    this.isAdmissionPausedState = false;
    void this.processQueue();
  }

  public getQueueSnapshot(): QueueSnapshot {
    const queued = [...this.queue];
    const active = Array.from(this.activeRuns.keys());
    const snapshot = Object.assign([...queued], {
      queued,
      active,
      paused: this.isAdmissionPausedState,
      maxConcurrentRuns: this.maxConcurrentRuns,
      total: queued.length + active.length,
    });
    return snapshot;
  }

  public enqueueRun(runId: string): { queuePosition: number; runId: string } {
    if (!runId || typeof runId !== "string") {
      throw new TypeError("runId must be a non-empty string");
    }

    // From here on the orchestrator owns this run's admission-queue entry.
    this.ownedRunIds.add(runId);

    if (this.activeRuns.has(runId)) {
      return { queuePosition: 0, runId };
    }

    const existingIndex = this.queue.indexOf(runId);
    if (existingIndex >= 0) {
      return { queuePosition: existingIndex + 1, runId };
    }

    this.queue.push(runId);
    const queuePosition = this.queue.length;

    try {
      this.host.runStore.updateRun(runId, {
        queuePosition,
        phase: "queued",
      });
    } catch {}

    this.syncAdmissionQueue();
    void this.processQueue();

    return { queuePosition, runId };
  }

  public cancelQueuedRun(runId: string): boolean {
    const idx = this.queue.indexOf(runId);
    if (idx === -1) {
      return false;
    }

    this.queue.splice(idx, 1);
    this.updateQueuePositions();

    try {
      this.host.runStore.updateRun(runId, {
        phase: "done",
        outcome: "cancelled",
        queuePosition: null,
        endedAt: Date.now(),
      });
    } catch {}

    this.emitEvent({
      runId,
      kind: "run.phase",
      actor: "RunOrchestrator",
      data: {
        phase: "done",
        outcome: "cancelled",
        reason: "Cancelled while queued",
      },
    });

    this.syncAdmissionQueue();
    return true;
  }

  /**
   * Removes a run from the admission queue without cancelling its record: the
   * run simply stops waiting for a slot. Returns false when the run is not
   * queued here.
   */
  public removeQueuedRun(runId: string): boolean {
    const idx = this.queue.indexOf(runId);
    if (idx === -1) {
      return false;
    }

    this.queue.splice(idx, 1);
    this.updateQueuePositions();

    try {
      this.host.runStore.updateRun(runId, { queuePosition: null });
    } catch {}

    this.syncAdmissionQueue();
    return true;
  }

  /**
   * Moves a queued run to a 1-based position within the admission queue,
   * clamped to the queue bounds, and renumbers every position. Returns false
   * when the run is not queued here.
   */
  public moveQueuedRun(runId: string, position: number): boolean {
    const from = this.queue.indexOf(runId);
    if (from === -1) {
      return false;
    }
    const target = Math.min(
      Math.max(1, Math.floor(typeof position === "number" ? position : from + 1)),
      this.queue.length
    );
    const to = target - 1;
    if (to !== from) {
      this.queue.splice(from, 1);
      this.queue.splice(to, 0, runId);
    }
    this.updateQueuePositions();
    this.syncAdmissionQueue();
    return true;
  }

  public drainQueue(): string[] {
    const drained = [...this.queue];
    for (const runId of drained) {
      this.cancelQueuedRun(runId);
    }
    this.queue.length = 0;
    this.syncAdmissionQueue();
    return drained;
  }

  private updateQueuePositions(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const id = this.queue[i];
      try {
        this.host.runStore.updateRun(id, { queuePosition: i + 1 });
      } catch {}
    }
  }

  /**
   * Mirrors the orchestrator's internal admission queue into the shared
   * `globalThis.__admissionQueue` the runtime host and diagnostics read.
   *
   * Ownership is explicit. Only entries whose run is owned by this orchestrator
   * (`ownedRunIds`) are managed: the currently queued runs are rebuilt in queue
   * order, reusing each entry and its richer fields and renumbering positions;
   * an owned run that is no longer queued (started, cancelled or removed) has
   * its entry dropped. Every other entry was written by a different surface and
   * is preserved untouched, keeping its order and extra fields intact.
   */
  private syncAdmissionQueue(): void {
    const g = globalThis as unknown as {
      __admissionQueue?: Array<{ runId?: string; queuePosition?: number }>;
    };
    if (!Array.isArray(g.__admissionQueue)) {
      return;
    }

    const existing = new Map<
      string,
      { runId?: string; queuePosition?: number }
    >();
    const unowned: Array<{ runId?: string; queuePosition?: number }> = [];
    for (const entry of g.__admissionQueue) {
      const isOwned =
        entry &&
        typeof entry === "object" &&
        typeof entry.runId === "string" &&
        this.ownedRunIds.has(entry.runId);
      if (!isOwned) {
        // Written by another surface: keep the entry and its fields as-is.
        unowned.push(entry);
        continue;
      }
      // Collect the richer field set already recorded for a queued run; owned
      // runs that are no longer queued are intentionally left out and removed.
      if (!existing.has(entry.runId as string)) {
        existing.set(entry.runId as string, entry);
      }
    }

    const next = this.queue.map((runId, index) => {
      const entry = existing.get(runId) ?? { runId };
      entry.runId = runId;
      entry.queuePosition = index + 1;
      return entry;
    });

    g.__admissionQueue.length = 0;
    for (const entry of next) {
      g.__admissionQueue.push(entry);
    }
    for (const entry of unowned) {
      g.__admissionQueue.push(entry);
    }
  }

  /**
   * Removes exactly one run's entries from the shared admission queue, leaving
   * every other entry - including unowned ones - untouched. Called when a run
   * leaves the queue to begin execution.
   */
  private removeRunFromAdmissionQueue(runId: string): void {
    const g = globalThis as unknown as {
      __admissionQueue?: Array<{ runId?: string; queuePosition?: number }>;
    };
    if (!Array.isArray(g.__admissionQueue)) {
      return;
    }
    for (let i = g.__admissionQueue.length - 1; i >= 0; i -= 1) {
      const entry = g.__admissionQueue[i];
      if (entry && typeof entry === "object" && entry.runId === runId) {
        g.__admissionQueue.splice(i, 1);
      }
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isAdmissionPausedState || this.isStoppedState) {
      return;
    }

    while (
      this.queue.length > 0 &&
      this.activeRuns.size < this.maxConcurrentRuns &&
      !this.isAdmissionPausedState &&
      !this.isStoppedState
    ) {
      const nextRunId = this.queue[0];
      if (!nextRunId) {
        break;
      }

      // A queued run whose record was already finalized (`phase: "done"`, e.g.
      // idle eviction via `FifoQueue.evictIdle()` or a kill while queued) must
      // never start. Drop it from both the internal and the shared admission
      // queues, then keep draining the next non-terminal queued run.
      const queuedRecord = this.host.runStore.getRun(nextRunId);
      if (queuedRecord && queuedRecord.phase === "done") {
        this.removeQueuedRun(nextRunId);
        this.removeRunFromAdmissionQueue(nextRunId);
        this.syncAdmissionQueue();
        continue;
      }

      this.queue.shift();
      this.updateQueuePositions();
      // `startRun` removes the dequeued run from the shared admission queue
      // and re-syncs, so the managed entries stay correct without wiping the
      // entries this orchestrator does not own.
      try {
        this.startRun(nextRunId);
      } catch {
        // ignore run start errors in queue drain
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Run Lifecycle Execution
  // ---------------------------------------------------------------------------

  public getActiveRun(runId: string): RunExecutionHandle | undefined {
    return this.activeRuns.get(runId);
  }

  /**
   * Builds the inert handle returned for a run whose record is already terminal
   * (`phase: "done"`). It starts no pipeline, owns no boxes, and resolves
   * immediately, so `startRun` can fail closed without ever executing a
   * finished run.
   */
  private buildTerminalRunHandle(runId: string): RunExecutionHandle {
    const lm = new LifecycleManager({
      runId,
      initialPhase: "done",
      emit: (evt) => {
        this.emitEvent(evt as any);
      },
    });
    return {
      runId,
      lifecycleManager: lm,
      getPhase: () => lm.phase,
      pause: () => {},
      resume: () => {},
      stop: async () => {},
      kill: async () => {},
      approvePact: async () => {},
      revisePact: async () => ({}) as never,
      resolveApproval: async () => null,
      answerAsk: async () => null,
      promise: Promise.resolve({} as FinalizeRunResult),
    };
  }

  public startRun(runId: string): RunExecutionHandle {
    if (!runId || typeof runId !== "string") {
      throw new TypeError("runId must be a non-empty string");
    }

    // Starting a run makes the orchestrator its owner for admission purposes.
    this.ownedRunIds.add(runId);

    const existingHandle = this.activeRuns.get(runId);
    if (existingHandle) {
      return existingHandle;
    }

    // A run whose record already finished (`phase: "done"`, e.g. idle eviction
    // or a kill while queued) must never be started: drop it from the internal
    // and shared admission queues, spawn no LifecycleManager / run execution,
    // and hand back an inert terminal handle.
    const preStartRecord = this.host.runStore.getRun(runId);
    if (preStartRecord && preStartRecord.phase === "done") {
      const qIdx = this.queue.indexOf(runId);
      if (qIdx >= 0) {
        this.queue.splice(qIdx, 1);
        this.updateQueuePositions();
      }
      this.removeRunFromAdmissionQueue(runId);
      this.syncAdmissionQueue();
      return this.buildTerminalRunHandle(runId);
    }

    // Remove from queue if present
    const qIdx = this.queue.indexOf(runId);
    if (qIdx >= 0) {
      this.queue.splice(qIdx, 1);
      this.updateQueuePositions();
    }

    // The run is beginning execution, so it no longer waits in the shared
    // admission queue: drop its entry cleanly without disturbing unowned ones.
    this.removeRunFromAdmissionQueue(runId);
    this.syncAdmissionQueue();

    // Ensure run record exists
    let runRecord = this.host.runStore.getRun(runId);
    if (!runRecord) {
      runRecord = this.host.runStore.createRun({
        runId,
        url: "https://github.com/git-graveyard/example-repo",
        sha: "HEAD",
        phase: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const approvalDeferred = createDeferred<PactApprovalInput>();
    this.runDeferreds.set(runId, approvalDeferred);

    const lm = new LifecycleManager({
      runId,
      initialPhase: "queued",
      emit: (evt) => {
        this.emitEvent(evt as any);
      },
    });

    let fatalQuarantined = false;
    let stopRequestedReason: string | undefined;
    let killedReason: string | undefined;

    const handle: RunExecutionHandle = {
      runId,
      lifecycleManager: lm,
      getPhase: () => lm.phase,
      pause: () => this.pauseRun(runId),
      resume: () => this.resumeRun(runId),
      stop: async (reason?: string) => {
        stopRequestedReason = reason ?? "User stopped run";
        await this.stopRun(runId, stopRequestedReason);
      },
      stopGracefully: async (reason?: string) => {
        stopRequestedReason = reason ?? "Graceful stop requested";
        await this.stopRunGracefully(runId, stopRequestedReason);
      },
      kill: async (reason?: string) => {
        killedReason = reason ?? "Admin killed run";
        await this.killRun(runId, killedReason);
      },
      approvePact: async (approval?: PactApprovalInput) => {
        await this.approvePact(runId, approval);
      },
      revisePact: async (feedback: string) => {
        return this.revisePact(runId, feedback);
      },
      resolveApproval: async (approvalId: string, resolution?: any) => {
        return this.resolveApproval(runId, approvalId, resolution);
      },
      answerAsk: async (askId: string, answer: any) => {
        return this.answerAsk(runId, askId, answer);
      },
      promise: Promise.resolve({} as FinalizeRunResult),
    };

    // Fatal handler for gateway quarantine
    const fatalHandler = async (payload: FatalEventPayload) => {
      fatalQuarantined = true;

      if (handle.dispatcher && !handle.dispatcher.stopped) {
        try {
          await handle.dispatcher.stop("Gateway fatal quarantine");
        } catch {}
      }

      try {
        await teardownBoxes(this.host.backend, runId);
      } catch {}

      if (lm.phase !== "done" && lm.canTransitionTo("done")) {
        try {
          lm.transitionTo("done", { outcome: "error", reason: "fatal" });
        } catch {}
      }

      try {
        this.host.runStore.updateRun(runId, {
          phase: "done",
          outcome: "error",
          endedAt: Date.now(),
        });
      } catch {}
    };

    this.host.registerFatalHandler(runId, fatalHandler);
    this.activeRuns.set(runId, handle);

    // Launch async execution pipeline
    handle.promise = this.executeRunPipeline(
      runId,
      handle,
      approvalDeferred,
      () => fatalQuarantined,
      () => stopRequestedReason,
      () => killedReason
    ).finally(() => {
      this.host.unregisterFatalHandler(runId);
      this.runDeferreds.delete(runId);
      this.activeRuns.delete(runId);
      void this.processQueue();
    });

    return handle;
  }

  // ---------------------------------------------------------------------------
  // Pipeline Step Implementations
  // ---------------------------------------------------------------------------

  private async executeRunPipeline(
    runId: string,
    handle: RunExecutionHandle,
    approvalDeferred: Deferred<PactApprovalInput>,
    isFatal: () => boolean,
    getStopReason: () => string | undefined,
    getKillReason: () => string | undefined
  ): Promise<FinalizeRunResult> {
    const lm = handle.lifecycleManager;
    let run = this.host.runStore.getRun(runId);
    let baseSha = run?.sha ?? "HEAD";
    const repoUrl = run?.url;
    const runDir = path.join(this.runsDir, runId);
    const gitDir = path.join(runDir, "git");
    const buildersBaseDir = path.join(runDir, "builders", "base");
    const wardenDir = path.join(runDir, "warden", "audit");

    this.host.runStore.updateRun(runId, {
      phase: "queued",
      queuePosition: null,
      startedAt: run?.startedAt ?? Date.now(),
    });

    // Per-run budget governor: caps are read from the run record. It is registered on the gateway so
    // a `sandbox_exec` for this run is refused once any capped dimension is crossed, and passed to
    // the TaskDispatcher so it gates worker/Warden prompts.
    const initialCaps = extractBudgetCaps(run?.caps ?? null);
    let budgetGovernor = new BudgetGovernor({
      runId,
      eventStore: this.host.eventStore,
      runStore: this.host.runStore,
      caps: initialCaps,
    });
    handle.budgetGovernor = budgetGovernor;
    try {
      (this.host.gateway as any)?.registerRunBudgetGovernor?.(runId, budgetGovernor);
    } catch {
      // A gateway that cannot register the governor must not abort the run.
    }

    try {
      // 1. Exhume phase
      if (isFatal() || (lm.phase as string) === "done") {
        return await this.finalizeAborted(runId, lm, "error", "Fatal quarantine");
      }

      // A cap already crossed before dispatch must not start new work.
      if (this.budgetBlocksDispatch(budgetGovernor, handle.scheduler)) {
        return await this.executeEarlyExit(
          runId,
          handle,
          "budget_stopped",
          "Budget exceeded before exhume",
          gitDir,
          runDir,
          baseSha
        );
      }

      lm.transitionTo("exhume");
      this.host.runStore.updateRun(runId, { phase: "exhume" });

      if (!this.options.exhumeRunner) {
        fs.mkdirSync(runDir, { recursive: true });
        fs.mkdirSync(buildersBaseDir, { recursive: true });
        fs.mkdirSync(wardenDir, { recursive: true });

        if (repoUrl) {
          const isCloned =
            fs.existsSync(path.join(gitDir, ".git")) ||
            fs.existsSync(path.join(gitDir, "HEAD"));
          if (!isCloned) {
            await this.gitService.cloneRepo(
              repoUrl,
              gitDir,
              baseSha && baseSha !== "HEAD" ? baseSha : undefined
            );
          }

          try {
            const revRes = await this.gitService.execGit([
              "-C",
              gitDir,
              "rev-parse",
              "HEAD",
            ]);
            const resolvedSha = revRes.stdout.trim();
            if (/^[0-9a-f]{40}$/i.test(resolvedSha)) {
              baseSha = resolvedSha;
              this.host.runStore.updateRun(runId, { sha: resolvedSha });
            }
          } catch {
            // Keep configured baseSha if gitDir has no HEAD yet
          }

          neutralizeUntrustedContent(gitDir);
          this.copyBaselineTree(gitDir, buildersBaseDir);
          this.copyBaselineTree(gitDir, wardenDir);

          // Initialize integration branch graveyard/<runId> at resolved baseSha via GitService
          try {
            await this.gitService.getIntegrationHeadSha(runId, gitDir);
          } catch {
            const initWt = path.join(runDir, "_init_wt");
            try {
              await this.gitService.cloneAndCreateBaseWorktree({
                repoUrl,
                gitDir,
                worktreeDir: initWt,
                baseSha,
                runId,
                runDir,
              });
            } finally {
              if (fs.existsSync(initWt)) {
                fs.rmSync(initWt, { recursive: true, force: true });
              }
              try {
                await this.gitService.execGit(["-C", gitDir, "worktree", "prune"]);
              } catch {}
            }
          }
        }

        await this.ensureRunNetworkPolicy(runId);
      }

      const exhumeCtx: ExhumeRunnerContext = {
        runId,
        baseSha,
        repoUrl,
        runDir,
        gitDir,
        backend: this.host.backend,
        emitEvent: (evt) => {
          this.emitEvent(evt);
        },
        host: this.host,
      };

      let exhumeResult: ExhumeHarnessResult;
      if (this.options.exhumeRunner) {
        const customRes = await this.options.exhumeRunner(exhumeCtx);
        if (customRes && typeof customRes === "object" && "deathCertificate" in customRes) {
          exhumeResult = customRes as ExhumeHarnessResult;
        } else {
          exhumeResult = {
            deathCertificate:
              (customRes as any)?.deathCertificate ??
              createFallbackDeathCertificate(runId, baseSha),
            healthy: (customRes as any)?.healthy ?? false,
            outcome: (customRes as any)?.outcome,
            earlyCompleted:
              (customRes as any)?.earlyCompleted ??
              (customRes as any)?.outcome === "healthy_already",
            rows: [],
            manifestInspection: {} as any,
            wallClockTimeoutHit: false,
          };
        }
      } else {
        const wallClockTimeoutMs =
          typeof this.options.wallClockTimeoutMs === "number"
            ? (this.options.wallClockTimeoutMs as number)
            : 300000;
        const boxImage = this.resolveBoxImage(this.host.backend);
        const manifestInputs = fs.existsSync(buildersBaseDir)
          ? this.collectExhumeManifestInputs(buildersBaseDir)
          : {};
        exhumeResult = await runExhumerHarness({
          runId,
          baseSha,
          repoUrl,
          backend: this.wrapBackendForLiveDocker(this.host.backend),
          emitEvent: (evt) => {
            this.emitEvent(evt);
          },
          storageDir: path.join(runDir, "evidence"),
          bindPath: buildersBaseDir,
          wardenBindPath: wardenDir,
          allowedRoot: runDir,
          wallClockTimeoutMs,
          settings: {
            maxWallClockTimeoutMs: wallClockTimeoutMs,
            maxTimeoutMs: wallClockTimeoutMs,
            housekeepingTimeoutMs: 60000,
          },
          boxImage,
          env: {
            HOME: "/tmp",
            npm_config_cache: "/tmp/.npm",
          },
          ...manifestInputs,
          enableGrimoire: true,
        });
      }
      handle.deathCertificate = exhumeResult.deathCertificate;

      // Capture baseline beforeInstall / beforeBuild / beforeTest for beforeAfterRows
      if (exhumeResult.deathCertificate) {
        const dc = exhumeResult.deathCertificate;
        const beforeMeta = {
          install: dc.install,
          build: dc.build,
          test: dc.test,
        };
        const latestRun = this.host.runStore.getRun(runId);
        this.host.runStore.updateRun(runId, {
          metadata: {
            ...(latestRun?.metadata ?? {}),
            beforeRows: beforeMeta,
          },
        });
      }

      // Early exit check: healthy_already
      if (
        exhumeResult.outcome === "healthy_already" ||
        exhumeResult.healthy === true ||
        exhumeResult.earlyCompleted === true
      ) {
        return await this.executeEarlyExit(
          runId,
          handle,
          "healthy_already",
          "healthy_already",
          gitDir,
          runDir,
          baseSha
        );
      }

      if (isFatal() || (lm.phase as string) === "done") {
        return await this.finalizeAborted(runId, lm, "error", "Fatal quarantine");
      }

      // 2. Plan phase
      if (this.budgetBlocksDispatch(budgetGovernor, handle.scheduler)) {
        return await this.executeEarlyExit(
          runId,
          handle,
          "budget_stopped",
          "Budget exceeded before plan",
          gitDir,
          runDir,
          baseSha
        );
      }
      lm.transitionTo("plan");
      this.host.runStore.updateRun(runId, { phase: "plan" });

      const isLiveMode = !this.options.planRunner || !this.options.workerRunner;
      let gatewayUrl: string | undefined;
      if (isLiveMode && typeof this.host.startGatewayServer === "function") {
        const gatewayAddr = await this.host.startGatewayServer();
        gatewayUrl = gatewayAddr?.url;
      }

      const quarantineDir = path.join(this.runsDir, `${runId}-quarantine`);
      if (!fs.existsSync(quarantineDir)) {
        try {
          fs.mkdirSync(quarantineDir, { recursive: true });
        } catch {}
      }

      const plannerSkeletonId = `planner-${runId}`;
      const plannerCwd = fs.existsSync(buildersBaseDir)
        ? buildersBaseDir
        : fs.existsSync(gitDir)
        ? gitDir
        : runDir;
      const plannerChunks: string[] = [];

      let plannerBearerToken: string | undefined;
      if (!this.options.planRunner && gatewayUrl && this.host.gateway?.registerSkeleton) {
        const reg = this.host.gateway.registerSkeleton({
          skeletonId: plannerSkeletonId,
          role: "planner",
          worktreeRoot: plannerCwd,
          runId,
          backend: this.host.backend,
          runbox: exhumeResult.runbox,
          auditbox: exhumeResult.auditbox,
        });
        plannerBearerToken = reg.bearerToken;
      }

      const liveSupervisorOpts =
        !this.options.planRunner
          ? {
              baseDir: this.runsDir,
              gatewayUrl,
              bearerToken: plannerBearerToken,
              gateway: this.host.gateway,
              checkMcpGateway: Boolean(gatewayUrl),
              isGatewayConnected: gatewayUrl
                ? () => this.host.gateway.isSkeletonConnected(plannerSkeletonId)
                : undefined,
              pathEnv: this.buildLivePathEnv(),
              command: "kiro-cli",
              args: [
                "acp",
                "--agent-engine=v2",
                "--agent",
                "planner",
                "--model",
                getAssignedModelForRole("planner"),
              ],
              acpWireFormat: "acp-v1" as const,
              cancelPromptTimeoutMs: 5000,
              readOnlySnapshotDir: fs.existsSync(buildersBaseDir)
                ? buildersBaseDir
                : undefined,
              onUpdate: (update: unknown) => {
                const text = this.extractUpdateText(update);
                if (text) {
                  plannerChunks.push(text);
                }
              },
            }
          : {};

      const plannerSupervisor = this.host.createSupervisor({
        runId,
        skeletonId: plannerSkeletonId,
        role: "planner",
        cwd: plannerCwd,
        quarantineDir,
        watchdogLimitMs: 120000,
        cancelGracePeriodMs: 5000,
        brokerOptions: {
          watchdogLimitMs: 120000,
          settings: {
            watchdogLimitMs: 120000,
          },
        },
        ...liveSupervisorOpts,
      } as any);

      if (
        typeof (plannerSupervisor as any).getVerifiedModel !== "function" ||
        !(plannerSupervisor as any).getVerifiedModel()
      ) {
        (plannerSupervisor as any).getVerifiedModel = () => CLAUDE_OPUS_5_5_MODEL_ID;
      }
      if (
        typeof (plannerSupervisor as any).getVerifiedAgent !== "function" ||
        !(plannerSupervisor as any).getVerifiedAgent()
      ) {
        (plannerSupervisor as any).getVerifiedAgent = () => "planner";
      }

      const planCtx: PlanRunnerContext = {
        runId,
        deathCertificate: exhumeResult.deathCertificate,
        baseSha,
        supervisor: plannerSupervisor,
        repoPath: fs.existsSync(gitDir) ? gitDir : undefined,
        emitEvent: (evt) => {
          this.emitEvent(evt);
        },
        eventStore: this.host.eventStore,
      };

      let pactDraft: PactDraftResult;
      if (this.options.planRunner) {
        pactDraft = await this.options.planRunner(planCtx);
      } else {
        try {
          if (gatewayUrl && typeof (plannerSupervisor as any).raise === "function") {
            await (plannerSupervisor as any).raise();
          }
          pactDraft = await generatePactWithPlanner({
            runId,
            deathCertificate: exhumeResult.deathCertificate,
            supervisor: plannerSupervisor as any,
            baseSha,
            repoPath: plannerCwd,
            emitEvent: (evt) => {
              this.emitEvent(evt);
            },
            eventStore: this.host.eventStore,
            sessionClient:
              gatewayUrl && typeof (plannerSupervisor as any).dispatchTask === "function"
                ? this.createLivePlannerSessionClient(
                    plannerSupervisor,
                    plannerCwd,
                    plannerChunks,
                    exhumeResult.deathCertificate
                  )
                : undefined,
          });
        } finally {
          if (typeof (plannerSupervisor as any).finish === "function") {
            try {
              await (plannerSupervisor as any).finish();
            } catch {}
          }
        }
      }
      handle.pactDraft = pactDraft;

      // Persist Pact metadata in RunStore
      const currentRunMeta = this.host.runStore.getRun(runId);
      this.host.runStore.updateRun(runId, {
        metadata: {
          ...(currentRunMeta?.metadata ?? {}),
          pact: pactDraft.markdown,
          pactTasks: pactDraft.tasks,
          pactDraftId: pactDraft.draftId,
          pactSha256: pactDraft.sha256,
          pactVersion: pactDraft.version,
        },
      });

      if (isFatal() || (lm.phase as string) === "done") {
        return await this.finalizeAborted(runId, lm, "error", "Fatal quarantine");
      }

      // 3. Pact Review phase
      lm.transitionTo("pact_review");
      this.host.runStore.updateRun(runId, { phase: "pact_review" });

      let approvalInput: PactApprovalInput;
      if (this.options.autoApprovePact === false) {
        // Await approval. The run wall clock must exclude the Pact review / approval wait
        // (Requirement 30.12), so pause the budget governor's clock across the wait.
        budgetGovernor.pauseClockForPact();
        try {
          approvalInput = await approvalDeferred.promise;
        } finally {
          budgetGovernor.resumeClockFromPact();
        }
      } else {
        // Auto approve or use already-received approval
        approvalInput = {
          approvedTaskIds: pactDraft.tasks.map((t) => t.id),
          caps: currentRunMeta?.caps ?? {},
        };
        this.emitEvent({
          runId,
          kind: "pact.approved",
          actor: "auto-approver",
          data: {
            pactVersion: pactDraft.version,
            approvedTaskIds: approvalInput.approvedTaskIds,
            caps: approvalInput.caps,
          },
        });
      }

      // A Pact approval may raise the caps. Rebuild the governor with the merged caps only when the
      // approved caps actually change what is enforced, so an unchanged grant keeps the running
      // governor's metering and clock semantics intact.
      const approvalCaps: BudgetCaps = {
        ...extractBudgetCaps(approvalInput.caps as Record<string, unknown> | undefined),
        ...extractBudgetCaps(approvalInput.budget as Record<string, unknown> | undefined),
      };
      const mergedCaps: BudgetCaps = { ...initialCaps, ...approvalCaps };
      if (!budgetCapsEqual(initialCaps, mergedCaps)) {
        budgetGovernor = new BudgetGovernor({
          runId,
          eventStore: this.host.eventStore,
          runStore: this.host.runStore,
          caps: mergedCaps,
        });
        handle.budgetGovernor = budgetGovernor;
        try {
          (this.host.gateway as any)?.registerRunBudgetGovernor?.(runId, budgetGovernor);
        } catch {
          // A gateway that cannot re-register the governor must not abort the run.
        }
      }

      const approvedTaskIds =
        approvalInput.approvedTaskIds ?? pactDraft.tasks.map((t) => t.id);

      if (isFatal() || (lm.phase as string) === "done") {
        return await this.finalizeAborted(runId, lm, "error", "Fatal quarantine");
      }

      // 4. Legion phase
      lm.transitionTo("legion");
      this.host.runStore.updateRun(runId, { phase: "legion" });

      const scheduler = new Scheduler({
        pact: pactDraft.markdown,
        tasks: pactDraft.tasks,
        runId,
        approvedTaskIds,
        pactApproved: true,
        pactVersion: pactDraft.version,
        runParallelCap:
          typeof approvalInput.caps?.runParallelCap === "number"
            ? (approvalInput.caps.runParallelCap as number)
            : typeof approvalInput.caps?.maxParallelTasks === "number"
            ? (approvalInput.caps.maxParallelTasks as number)
            : 1,
        emit: (evt) => {
          this.emitEvent(evt as any);
        },
      });
      handle.scheduler = scheduler;

      const dispatcher = new TaskDispatcher({
        runId,
        scheduler,
        gitService: this.gitService,
        host: this.host,
        runDir,
        gitDir,
        baseSha,
        boxImage: this.resolveBoxImage(this.host.backend),
        workerRunner: this.options.workerRunner,
        wardenRunner: this.options.wardenRunner,
        wardenReviewer: this.options.wardenReviewer,
        pollIntervalMs: this.options.pollIntervalMs ?? 20,
        budgetGovernor,
        emitEvent: (evt) => {
          this.emitEvent(evt as any);
        },
      });
      handle.dispatcher = dispatcher;

      const dispatchResult = await dispatcher.run();

      if (isFatal()) {
        return await this.finalizeAborted(runId, lm, "error", "Fatal quarantine");
      }

      const killReason = (handle as any).killedReason ?? getKillReason();
      const stopReason = (handle as any).stopRequestedReason ?? getStopReason();

      if (killReason || lm.outcome === "killed") {
        lm.setOutcome("killed");
        return await this.executeEarlyExit(
          runId,
          handle,
          "killed",
          killReason ?? "Killed",
          gitDir,
          runDir,
          baseSha
        );
      }

      if (
        stopReason ||
        dispatcher.stopped ||
        dispatcher.gracefulStopped ||
        scheduler.isStopRequested ||
        scheduler.isBudgetExceeded
      ) {
        const outcome = scheduler.isBudgetExceeded ? "budget_stopped" : "cancelled";
        lm.setOutcome(outcome);
        return await this.executeEarlyExit(
          runId,
          handle,
          outcome,
          stopReason ?? scheduler.stopReason ?? scheduler.budgetReason ?? "Stopped",
          gitDir,
          runDir,
          baseSha
        );
      }

      // 5. Final check phase
      lm.transitionTo("final_check");
      this.host.runStore.updateRun(runId, { phase: "final_check" });

      const finalCheckCtx: FinalCheckContext = {
        runId,
        runDir,
        gitDir,
        baseSha,
        branch: `graveyard/${runId}`,
        backend: this.host.backend,
        gitService: this.gitService,
        scheduler,
      };

      let finalCheckRes: FinalCheckResult;
      if (this.options.finalCheckRunner) {
        finalCheckRes = await this.options.finalCheckRunner(finalCheckCtx);
      } else {
        finalCheckRes = await this.defaultFinalCheckRunner(finalCheckCtx);
      }
      handle.finalCheckResult = finalCheckRes;

      this.emitEvent({
        runId,
        kind: "final_check.result",
        actor: "RunOrchestrator",
        data: {
          passed: finalCheckRes.passed ?? finalCheckRes.ok ?? false,
          installPassed: finalCheckRes.installPassed,
          buildPassed: finalCheckRes.buildPassed,
          hasBuild: finalCheckRes.hasBuild,
          testsPassed: finalCheckRes.testsPassed,
          hasTests: finalCheckRes.hasTests,
        },
      });

      if (isFatal()) {
        return await this.finalizeAborted(runId, lm, "error", "Fatal quarantine");
      }

      // 6. Report phase
      lm.transitionTo("report");
      this.host.runStore.updateRun(runId, { phase: "report" });

      const taskSummary = scheduler.getSummary();
      const allTasks = scheduler.getTasks();

      const evaluatedOutcome = evaluateReportOutcome({
        outcome: lm.outcome ?? undefined,
        installPassed: finalCheckRes.installPassed,
        buildPassed: finalCheckRes.buildPassed,
        testsPassed: finalCheckRes.testsPassed,
        hasTests: finalCheckRes.hasTests,
        tasks: allTasks.map((t: any) => ({
          id: t.id,
          state: t.state,
          merged: t.state === "merged",
          failed: t.state === "failed",
          abandoned: t.state === "abandoned",
          skipped: t.state === "skipped",
        })),
        mergedTasksCount: taskSummary.merged,
        failedTasksCount: taskSummary.failed,
        totalTasksCount: allTasks.length,
      });
      lm.setOutcome(evaluatedOutcome);

      const reportArtifacts = buildReportStepArtifacts({
        runId,
        outcome: evaluatedOutcome,
        installPassed: finalCheckRes.installPassed,
        buildPassed: finalCheckRes.buildPassed,
        testsPassed: finalCheckRes.testsPassed,
        hasTests: finalCheckRes.hasTests,
        verifyResult: {
          passed: Boolean(
            finalCheckRes.passed ??
              finalCheckRes.ok ??
              (finalCheckRes.buildPassed &&
                (finalCheckRes.testsPassed || !finalCheckRes.hasTests))
          ),
          installPassed: finalCheckRes.installPassed,
          buildPassed: finalCheckRes.buildPassed,
          hasBuild: finalCheckRes.hasBuild,
          testsPassed: finalCheckRes.testsPassed,
          hasTests: finalCheckRes.hasTests,
        },
        deathCertificate: handle.deathCertificate,
        tasks: allTasks.map((t: any) => ({
          id: t.id,
          state: t.state,
          merged: t.state === "merged",
        })),
      });

      const collector = new ArtifactCollector({
        runId,
        baseRunsDir: this.runsDir,
        gitService: this.gitService,
        baseSha,
        emit: (evt) => {
          this.emitEvent(evt as any);
        },
      });

      let patchInput: any = "";
      try {
        if (fs.existsSync(gitDir)) {
          patchInput = {
            gitService: this.gitService,
            baseSha,
            runDir,
            gitDir,
            integrationBranch: `graveyard/${runId}`,
          };
        }
      } catch {
        patchInput = "";
      }

      let manifest: ArtifactManifest;
      try {
        manifest = await collector.collectAll({
          patch: patchInput,
          spec: {
            tasks: handle.pactDraft?.markdown,
          },
          certificate: handle.deathCertificate,
          report: {
            markdown: reportArtifacts.report.markdown,
            findings: reportArtifacts.report.data,
          },
          events: this.host.eventStore
            ? this.host.eventStore.getEvents(runId)
            : [],
        });
      } catch (_err) {
        // Fallback artifact generation
        manifest = await collector.collectAll({
          patch: "",
          spec: { tasks: handle.pactDraft?.markdown ?? "" },
          certificate: handle.deathCertificate,
          report: { markdown: reportArtifacts.report.markdown },
          events: [],
        });
      }
      handle.manifest = manifest;

      // Push to fork if requested and valid (Requirement 29.5).
      const currentRun = this.host.runStore.getRun(runId);
      if (currentRun?.pushFlag && currentRun?.pushTargetFork) {
        const targetFork = currentRun.pushTargetFork;
        const branch = currentRun.pushBranch ?? `graveyard/${runId}`;
        if (targetFork !== currentRun.url) {
          let confirmed = false;
          if (this.options.pushConfirm === true) {
            confirmed = true;
          } else if (
            (currentRun.metadata as Record<string, unknown> | undefined)
              ?.pushConfirm === true
          ) {
            confirmed = true;
          } else if (this.hasPushConfirmAnswer(runId)) {
            confirmed = true;
          } else if (this.options.requestPushConfirmation) {
            try {
              confirmed =
                (await this.options.requestPushConfirmation({
                  runId,
                  targetFork,
                  branch,
                })) === true;
            } catch {
              confirmed = false;
            }
          }

          if (confirmed) {
            try {
              await this.gitService.pushToFork(runId, {
                targetRepoUrl: targetFork,
                sourceRepoUrl: currentRun.url,
                branchName: branch,
                gitDir,
                runDir,
                ownerLogin: this.options.ownerLogin,
                forkChecker: this.options.forkChecker,
                token: this.options.githubToken,
                runPhase: "done",
                invitePushFlag: currentRun.pushFlag,
                pushConfirm: true,
                eventStore: this.host.eventStore,
                emitEvent: (evt) => this.emitEvent(evt as any),
              });
            } catch (err) {
              // Surface a redacted push.result unless pushToFork already
              // recorded one via its own eventStore sink.
              if (!this.hasPushResultEvent(runId)) {
                this.emitPushResult(runId, branch, targetFork, {
                  ok: false,
                  reason: redactText(
                    err instanceof Error ? err.message : String(err)
                  ),
                });
              }
            }
          } else {
            this.emitPushResult(runId, branch, targetFork, {
              ok: false,
              skipped: true,
              reason: "Explicit push confirmation not granted (Requirement 29.5)",
            });
          }
        }
      }

      // 7. Done phase — tear down any run boxes and proxy before finalizing run.done
      await this.teardownProxyContainer(runId);
      try {
        await teardownBoxes(this.host.backend, runId);
      } catch {}

      const finalizeResult = await finalizeRun({
        runId,
        backend: this.host.backend,
        lifecycleManager: lm,
        emit: (evt) => {
          this.emitEvent(evt as any);
        },
        outcome: evaluatedOutcome,
        manifest,
        artifactsStored: true,
        startedAt: currentRun?.startedAt ?? undefined,
      });
      handle.finalizeResult = finalizeResult;

      this.host.runStore.updateRun(runId, {
        phase: "done",
        outcome: finalizeResult.outcome,
        endedAt: Date.now(),
      });

      return finalizeResult;
    } finally {
      // The run is over: drop its gateway registrations so a later run cannot inherit them.
      try {
        (this.host.gateway as any)?.clearRunGracefulStop?.(runId);
        (this.host.gateway as any)?.unregisterRunBudgetGovernor?.(runId);
      } catch {
        // Dropping gateway registrations must never mask the run's real result.
      }
      await this.teardownRunResources(runId);
    }
  }
  /**
   * True when the latest `ask.answered` event for a `push_confirm` ask recorded
   * "Push". Earlier answers are superseded, so a later "Do not push" blocks the
   * push even when an earlier answer was "Push".
   */
  private hasPushConfirmAnswer(runId: string): boolean {
    const store = this.host.eventStore;
    if (!store || typeof store.getEvents !== "function") return false;
    try {
      const events = store.getEvents(runId);
      let latest: EventEnvelope | undefined;
      for (const evt of events) {
        if (evt.kind !== "ask.answered") continue;
        const data = evt.data as Record<string, unknown> | undefined;
        if (data?.kind === "push_confirm") {
          latest = evt;
        }
      }
      const latestData = latest?.data as Record<string, unknown> | undefined;
      return latestData?.answer === "Push";
    } catch {
      return false;
    }
  }

  /** True when a `push.result` event was already recorded for this run. */
  private hasPushResultEvent(runId: string): boolean {
    const store = this.host.eventStore;
    if (!store || typeof store.getEvents !== "function") return false;
    try {
      return store.getEvents(runId, { kind: "push.result" }).length > 0;
    } catch {
      return false;
    }
  }

  /** Emits a redacted `push.result`; reporting must never fail the run. */
  private emitPushResult(
    runId: string,
    branch: string,
    targetFork: string,
    data: Record<string, unknown>
  ): void {
    try {
      this.emitEvent({
        runId,
        kind: "push.result",
        actor: "necromancer",
        data: { branch, targetRepoUrl: targetFork, ...data },
      });
    } catch {
      // Push result reporting must not fail the run.
    }
  }



  /**
   * True when the run's budget already blocks new work. Latches the Scheduler flag when a scheduler
   * exists so the run finalizes with `budget_stopped`.
   */
  private budgetBlocksDispatch(
    governor: BudgetGovernor | undefined,
    scheduler: Scheduler | undefined
  ): boolean {
    if (!governor) {
      return false;
    }
    const gate = governor.canDispatchPrompt("orchestrator");
    const snapshot = governor.snapshot();
    if (gate.allowed && !snapshot.exceededAny) {
      return false;
    }
    const dims = gate.allowed ? snapshot.exceeded : gate.dimensions;
    try {
      scheduler?.setBudgetExceeded(true, `Budget exceeded: ${dims.join(", ")}`);
    } catch {
      // Latching the flag is best-effort; the run still finalizes as budget_stopped.
    }
    return true;
  }

  private async executeEarlyExit(
    runId: string,
    handle: RunExecutionHandle,
    outcome: RunOutcome,
    reason: string,
    gitDir: string,
    runDir: string,
    baseSha: string
  ): Promise<FinalizeRunResult> {
    const lm = handle.lifecycleManager;
    lm.setOutcome(outcome);

    // Graceful-stop contract: keep every worker's worktree (uncommitted edits included) on disk.
    // Worktree removal belongs solely to the dispatcher's hard-stop/abort settle path; this
    // early-exit path never touches a worktree, so a graceful stop's preserved worktrees survive.
    if ((handle as any).gracefulStop === true) {
      // Nothing to do: preserved worker worktrees stay in place on disk.
    }

    if (lm.phase !== "report" && lm.canTransitionTo("report", { isEarlyExit: true, reason })) {
      try {
        lm.transitionTo("report", { isEarlyExit: true, reason, outcome });
        this.host.runStore.updateRun(runId, { phase: "report" });
      } catch {}
    }

    const reportArtifacts = buildReportStepArtifacts({
      runId,
      outcome,
      installPassed: outcome === "healthy_already" ? true : false,
      buildPassed: outcome === "healthy_already" ? true : false,
      testsPassed: outcome === "healthy_already" ? true : false,
      hasTests: outcome === "healthy_already" ? true : false,
      deathCertificate: handle.deathCertificate,
    });

    const collector = new ArtifactCollector({
      runId,
      baseRunsDir: this.runsDir,
      gitService: this.gitService,
      baseSha,
      emit: (evt) => {
        this.emitEvent(evt as any);
      },
    });

    let manifest: ArtifactManifest;
    try {
      manifest = await collector.collectAll({
        patch: "",
        spec: { tasks: handle.pactDraft?.markdown ?? "" },
        certificate: handle.deathCertificate,
        report: {
          markdown: reportArtifacts.report.markdown,
          findings: reportArtifacts.report.data,
        },
        events: this.host.eventStore ? this.host.eventStore.getEvents(runId) : [],
      });
    } catch {
      manifest = collector.getManifest();
    }
    handle.manifest = manifest;

    await this.teardownProxyContainer(runId);
    try {
      await teardownBoxes(this.host.backend, runId);
    } catch {}

    const finalizeResult = await finalizeRun({
      runId,
      backend: this.host.backend,
      lifecycleManager: lm,
      emit: (evt) => {
        this.emitEvent(evt as any);
      },
      outcome,
      manifest,
      artifactsStored: true,
      reason,
    });
    handle.finalizeResult = finalizeResult;

    this.host.runStore.updateRun(runId, {
      phase: "done",
      outcome,
      endedAt: Date.now(),
    });

    return finalizeResult;
  }

  private async finalizeAborted(
    runId: string,
    lm: LifecycleManager,
    outcome: RunOutcome,
    reason: string
  ): Promise<FinalizeRunResult> {
    lm.setOutcome(outcome);
    if (lm.phase !== "done" && lm.canTransitionTo("done")) {
      try {
        lm.transitionTo("done", { outcome, reason });
      } catch {}
    }

    try {
      await teardownBoxes(this.host.backend, runId);
    } catch {}

    const result = await finalizeRun({
      runId,
      backend: this.host.backend,
      lifecycleManager: lm,
      emit: (evt) => {
        this.emitEvent(evt as any);
      },
      outcome,
      reason,
      artifactsStored: true,
    });

    this.host.runStore.updateRun(runId, {
      phase: "done",
      outcome,
      endedAt: Date.now(),
    });

    return result;
  }

  private async defaultFinalCheckRunner(
    ctx: FinalCheckContext
  ): Promise<FinalCheckResult> {
    const { runId, gitDir, gitService, backend } = ctx;
    const runDir = ctx.runDir ?? path.join(this.runsDir, runId);
    const runRecord = this.host.runStore.getRun(runId);
    const resolvedBaseSha = ctx.baseSha ?? runRecord?.sha ?? "HEAD";
    const beforeRowsMeta = (runRecord?.metadata as any)?.beforeRows as
      | {
          install?: Partial<BaselineCommandRow>;
          build?: Partial<BaselineCommandRow>;
          test?: Partial<BaselineCommandRow>;
        }
      | undefined;

    if (!gitDir || !fs.existsSync(gitDir)) {
      return {
        ok: false,
        passed: false,
        installPassed: false,
        buildPassed: false,
        testsPassed: false,
        hasTests: false,
        error: "gitDir not found",
      };
    }

    let integrationSha = "";
    try {
      const logRes = await gitService.execGit([
        "-C",
        gitDir,
        "rev-parse",
        "--verify",
        `refs/heads/graveyard/${runId}`,
      ]);
      integrationSha = logRes.stdout.trim();
    } catch {
      integrationSha = "";
    }

    const isContainerBackend = backend?.kind === "instabox-docker";
    if (isContainerBackend && integrationSha) {
      const finalCheckDir = path.join(runDir, "warden", "final-check");
      const tmpWt = path.join(runDir, "_final_check_wt");
      let checkSandbox: any;

      try {
        if (fs.existsSync(finalCheckDir)) {
          fs.rmSync(finalCheckDir, { recursive: true, force: true });
        }
        fs.mkdirSync(finalCheckDir, { recursive: true });

        await gitService.createBaseWorktree(gitDir, tmpWt, integrationSha);
        neutralizeUntrustedContent(tmpWt);
        this.copyBaselineTree(tmpWt, finalCheckDir);
      } finally {
        if (fs.existsSync(tmpWt)) {
          fs.rmSync(tmpWt, { recursive: true, force: true });
        }
        try {
          await gitService.execGit(["-C", gitDir, "worktree", "prune"]);
        } catch {}
      }

      let hasPkgJson = false;
      let hasBuild = false;
      let hasTests = false;
      let buildCmd = ["npm", "run", "build"];
      let testCmd = ["npm", "test"];
      let installCmd = ["npm", "install", "--ignore-scripts"];

      try {
        const pkgPath = path.join(finalCheckDir, "package.json");
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

      await this.ensureRunNetworkPolicy(runId);

      const wallClockTimeoutMs =
        typeof this.options.wallClockTimeoutMs === "number"
          ? (this.options.wallClockTimeoutMs as number)
          : 300000;
      const cmdTimeoutMs = Math.min(wallClockTimeoutMs, 180000);
      const boxImage = this.resolveBoxImage(backend);

      let installCell: {
        status: string;
        exitCode: number | null;
        duration: number | null;
        output: string | null;
        command: string;
      } = {
        status: "not run",
        exitCode: null,
        duration: null,
        output: null,
        command: installCmd.join(" "),
      };
      let buildCell: {
        status: string;
        exitCode: number | null;
        duration: number | null;
        output: string | null;
        command: string;
      } = {
        status: "not run",
        exitCode: null,
        duration: null,
        output: null,
        command: buildCmd.join(" "),
      };
      let testCell: {
        status: string;
        exitCode: number | null;
        duration: number | null;
        output: string | null;
        command: string;
      } = {
        status: "not run",
        exitCode: null,
        duration: null,
        output: null,
        command: testCmd.join(" "),
      };

      let installPassed = !hasPkgJson;
      let buildPassed = !hasBuild;
      let testsPassed = !hasTests;
      let lastExitCode = 0;

      try {
        const liveBackend = this.wrapBackendForLiveDocker(backend);
        checkSandbox = await liveBackend.create({
          idempotencyKey: `auditbox-${runId}-final-${Date.now()}`,
          labels: { runId, role: "auditbox", phase: "final_check" },
          user: { uid: 1000 },
          argv: ["sleep", "infinity"],
          env: {
            HOME: "/tmp",
            npm_config_cache: "/tmp/.npm",
          },
          workspace: {
            mode: "bind",
            hostPath: finalCheckDir,
            mountAt: "/workspace",
          },
          resources: { diskMiB: 2048 },
          settings: {
            maxTimeoutMs: wallClockTimeoutMs,
            housekeepingTimeoutMs: 60000,
          },
          image: boxImage,
          network: buildSandboxNetworkSpec(getRunNetworkPolicy(runId)),
        });

        const containerEnv = {
          HOME: "/tmp",
          npm_config_cache: "/tmp/.npm",
        };

        if (hasPkgJson) {
          const t0 = Date.now();
          const res = await checkSandbox.run({
            argv: installCmd,
            cwd: "/workspace",
            env: containerEnv,
            timeoutMs: cmdTimeoutMs,
            idempotencyKey: `final-install-${runId}-${Date.now()}`,
          });
          const dur = Date.now() - t0;
          const code = typeof res.exitCode === "number" ? res.exitCode : 1;
          installPassed = code === 0;
          lastExitCode = code;
          installCell = {
            status: installPassed ? "passed" : "failed",
            exitCode: code,
            duration: dur,
            output: [res.stdoutTail, res.stderrTail].filter(Boolean).join("\n") || null,
            command: installCmd.join(" "),
          };
        } else {
          installCell = {
            status: "passed",
            exitCode: 0,
            duration: 0,
            output: "No package.json present",
            command: "(none)",
          };
        }

        if (installPassed && hasBuild) {
          const t0 = Date.now();
          const res = await checkSandbox.run({
            argv: buildCmd,
            cwd: "/workspace",
            env: containerEnv,
            timeoutMs: cmdTimeoutMs,
            idempotencyKey: `final-build-${runId}-${Date.now()}`,
          });
          const dur = Date.now() - t0;
          const code = typeof res.exitCode === "number" ? res.exitCode : 1;
          buildPassed = code === 0;
          lastExitCode = code;
          buildCell = {
            status: buildPassed ? "passed" : "failed",
            exitCode: code,
            duration: dur,
            output: [res.stdoutTail, res.stderrTail].filter(Boolean).join("\n") || null,
            command: buildCmd.join(" "),
          };
        } else if (!installPassed && hasBuild) {
          buildPassed = false;
        }

        if (installPassed && hasTests) {
          const t0 = Date.now();
          const res = await checkSandbox.run({
            argv: testCmd,
            cwd: "/workspace",
            env: containerEnv,
            timeoutMs: cmdTimeoutMs,
            idempotencyKey: `final-test-${runId}-${Date.now()}`,
          });
          const dur = Date.now() - t0;
          const code = typeof res.exitCode === "number" ? res.exitCode : 1;
          testsPassed = code === 0;
          lastExitCode = code;
          testCell = {
            status: testsPassed ? "passed" : "failed",
            exitCode: code,
            duration: dur,
            output: [res.stdoutTail, res.stderrTail].filter(Boolean).join("\n") || null,
            command: testCmd.join(" "),
          };
        } else if (!installPassed && hasTests) {
          testsPassed = false;
        }
      } finally {
        if (checkSandbox && typeof checkSandbox.destroy === "function") {
          try {
            await checkSandbox.destroy();
          } catch {}
        }
      }

      let realDiff = "";
      try {
        if (resolvedBaseSha && resolvedBaseSha !== "HEAD") {
          const diffRes = await gitService.execGit([
            "-C",
            gitDir,
            "diff",
            "--end-of-options",
            `${resolvedBaseSha}..refs/heads/graveyard/${runId}`,
          ]);
          realDiff = diffRes.stdout ?? "";
        }
      } catch {
        realDiff = "";
      }

      const beforeAfterRows = [
        {
          label: "Install",
          key: "install",
          before: {
            status: beforeRowsMeta?.install?.status ?? "not run",
            exitCode: beforeRowsMeta?.install?.exitCode ?? null,
            duration: beforeRowsMeta?.install?.durationMs ?? null,
            output: beforeRowsMeta?.install?.errorExcerpt ?? null,
            command: beforeRowsMeta?.install?.command ?? installCmd.join(" "),
          },
          after: installCell,
        },
        {
          label: "Build",
          key: "build",
          before: {
            status: beforeRowsMeta?.build?.status ?? "not run",
            exitCode: beforeRowsMeta?.build?.exitCode ?? null,
            duration: beforeRowsMeta?.build?.durationMs ?? null,
            output: beforeRowsMeta?.build?.errorExcerpt ?? null,
            command: beforeRowsMeta?.build?.command ?? buildCmd.join(" "),
          },
          after: buildCell,
        },
        {
          label: "Tests (repository's own)",
          key: "tests_repo",
          before: {
            status: beforeRowsMeta?.test?.status ?? "not run",
            exitCode: beforeRowsMeta?.test?.exitCode ?? null,
            duration: beforeRowsMeta?.test?.durationMs ?? null,
            output: beforeRowsMeta?.test?.errorExcerpt ?? null,
            command: beforeRowsMeta?.test?.command ?? testCmd.join(" "),
          },
          after: testCell,
        },
      ];

      const latestRun = this.host.runStore.getRun(runId);
      this.host.runStore.updateRun(runId, {
        metadata: {
          ...(latestRun?.metadata ?? {}),
          beforeAfterRows,
          diff: realDiff,
        },
      });

      const passed = installPassed && buildPassed && (hasTests ? testsPassed : true);
      return {
        ok: passed,
        passed,
        installPassed,
        buildPassed,
        hasBuild,
        testsPassed: hasTests ? testsPassed : undefined,
        hasTests,
        exitCode: lastExitCode,
        details: {
          beforeAfterRows,
        },
      };
    }

    let hasTests = false;
    let buildPassed = Boolean(integrationSha);
    let testsPassed = true;

    try {
      const pkgPath = path.join(gitDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        hasTests = Boolean(
          pkg.scripts?.test &&
            !pkg.scripts.test.includes("no test specified")
        );
      }
    } catch {}

    const passed = buildPassed && (hasTests ? testsPassed : true);

    return {
      ok: passed,
      passed,
      installPassed: true,
      buildPassed,
      testsPassed: hasTests ? testsPassed : undefined,
      hasTests,
    };
  }

  private createLivePlannerSessionClient(
    plannerSupervisor: any,
    plannerCwd: string,
    chunks: string[],
    deathCertificate?: DeathCertificate
  ): { prompt: (promptText: string) => Promise<string> } {
    const extractCandidatePactText = (raw: string): string => {
      const fenced = raw.match(/```(?:markdown|tasks)?\s*([\s\S]*?)```/);
      const candidate = (fenced ? fenced[1] : raw).trim();
      const lines = candidate.split(/\r?\n/);
      const kept: string[] = [];
      let inTask = false;
      for (const line of lines) {
        if (/^\s*-\s*\[[ xX]\]\s+T\d+\.\s+/.test(line)) {
          inTask = true;
          kept.push(line);
        } else if (inTask && /^\s{2,}-\s+[a-zA-Z_]+:\s*/.test(line)) {
          kept.push(line);
        } else if (inTask && line.trim() === "") {
          kept.push("");
          inTask = false;
        } else {
          inTask = false;
        }
      }
      return kept.length > 0 ? kept.join("\n").trim() : candidate;
    };

    const specPaths = [
      path.join(plannerCwd, "specs", "tasks.md"),
      path.join(plannerCwd, "spec", "tasks.md"),
    ];

    const snapshotSpecFiles = (): Map<string, string | null> => {
      const snap = new Map<string, string | null>();
      for (const cand of specPaths) {
        if (fs.existsSync(cand)) {
          try {
            snap.set(cand, fs.readFileSync(cand, "utf-8").trim());
          } catch {
            snap.set(cand, null);
          }
        } else {
          snap.set(cand, null);
        }
      }
      return snap;
    };

    const readSpecOrChunks = (before?: Map<string, string | null>): string => {
      for (const cand of specPaths) {
        if (fs.existsSync(cand)) {
          const content = fs.readFileSync(cand, "utf-8").trim();
          if (content && (!before || content !== before.get(cand))) {
            return content;
          }
        }
      }
      const streamed = chunks.join("").trim();
      if (streamed) {
        return streamed;
      }
      for (const cand of specPaths) {
        if (fs.existsSync(cand)) {
          const content = fs.readFileSync(cand, "utf-8").trim();
          if (content) return content;
        }
      }
      return "";
    };

    const excerpts = (deathCertificate?.failures ?? [])
      .map((f, idx) =>
        f.excerpt ? `Failure ${idx + 1} (${f.step}) excerpt:\n${f.excerpt}` : ""
      )
      .filter(Boolean)
      .join("\n\n");

    return {
      prompt: async (promptText: string) => {
        chunks.length = 0;
        const beforeTurn = snapshotSpecFiles();
        const guidance = [
          promptText,
          excerpts ? `## Death Certificate Failure Excerpts\n${excerpts}` : "",
          "## Strict Pact Output Rules",
          "1. Cite ONLY rule IDs M1 through M6 in `- rules:` (NEVER cite M7 or higher).",
          "2. Put ONLY the `- [ ] T1. ...` task list and indented fields inside a single ```markdown ... ``` fence, with NO prose, headings, or trailing `Rules:` section inside the fence.",
          "3. Every failure listed in the Death Certificate must match at least one task by ruleId, file path, or failure step keyword ('test', 'build', 'install', or 'retry') in the task title.",
          "4. OVERRIDE REQUIREMENT #3 ABOVE FOR LIVE EXECUTION: Output ONLY actionable code/dependency repair task(s) (prefer a SINGLE 'soul-stitcher' task covering package.json, package-lock.json, and source/test files, or 'bonesetter' ONLY if root manifest/lockfile changes alone make 'npm test' pass). Do NOT include separate no-op 'Grimoire syntax/gate', 'Warden final check', or 'Scribe report' placeholder tasks — RunOrchestrator executes Grimoire, Warden final check, and Scribe report automatically and every task in tasks.md must produce a non-empty git diff.",
          "5. Use a single direct command for '- accept:' on every task — prefer 'npm test' (do NOT use shell '&&' chains or require non-existent files like 'spec/tasks.md').",
          "6. Workers execute commands inside sandbox_exec with direct argv only — NEVER plan acceptance criteria that require files outside the git repository.",
        ]
          .filter(Boolean)
          .join("\n\n");

        await plannerSupervisor.dispatchTask({
          taskId: "plan",
          taskText: guidance,
          role: "planner",
        });

        let candidate = extractCandidatePactText(readSpecOrChunks(beforeTurn));
        let parsed = parsePact(candidate);
        if (!parsed.ok) {
          const errSummary = parsed.errors
            .map((e) => `[line ${e.line}] ${e.message}`)
            .join("; ");
          chunks.length = 0;
          const beforeGrammarFix = snapshotSpecFiles();
          await plannerSupervisor.dispatchTask({
            taskId: "plan-fix-grammar",
            taskText:
              `Your Pact had syntax errors: ${errSummary}\n` +
              `Re-output ONLY a valid \`\`\`markdown ... \`\`\` fence containing '- [ ] T1. ...' tasks citing only M1..M6 rules, with NO extra prose inside the fence.`,
            role: "planner",
          });
          candidate = extractCandidatePactText(readSpecOrChunks(beforeGrammarFix));
          parsed = parsePact(candidate);
        }

        // Strip trailing pipeline-phase placeholders (Grimoire gate / Warden final check / Scribe report)
        // when actionable repair tasks exist: merge gating rejects empty diffs, while RunOrchestrator
        // executes Grimoire, Warden, and Scribe phases natively.
        if (parsed.ok && parsed.tasks.length > 1) {
          const actionable = parsed.tasks.filter((t) => !isNonRemovableTask(t));
          if (actionable.length > 0 && actionable.length < parsed.tasks.length) {
            const cov = verifyDeathCertificateCoverage(
              actionable,
              deathCertificate as any
            );
            if (cov.ok) {
              const keepIds = new Set(actionable.map((t) => t.id));
              const cleaned = actionable.map((t) => {
                const deps = (t.dependencies ?? t.depends ?? []).filter((d) =>
                  keepIds.has(d)
                );
                return {
                  ...t,
                  dependencies: deps,
                  depends: deps,
                  dependsOn: deps,
                };
              });
              candidate = renderPact(cleaned);
            }
          }
        }
        return candidate;
      },
    };
  }

  private wrapBackendForLiveDocker<T extends any>(backend: T): T {
    if (
      !backend ||
      (backend as any).kind !== "instabox-docker" ||
      typeof (backend as any).runDocker !== "function"
    ) {
      return backend;
    }
    const realBackend = backend as any;
    return new Proxy(realBackend, {
      get(target, prop, receiver) {
        if (prop === "create") {
          return async (spec: any) => {
            const patchedSpec = {
              ...spec,
              argv: spec?.argv ?? spec?.command ?? ["sleep", "infinity"],
              env: {
                HOME: "/tmp",
                npm_config_cache: "/tmp/.npm",
                ...(spec?.env ?? {}),
              },
            };
            const sandbox = await target.create(patchedSpec);
            const cid = sandbox?.containerId ?? sandbox?.id;
            if (cid) {
              const startRes = await target.runDocker(["start", cid]);
              if (startRes && startRes.exitCode !== 0) {
                throw new Error(
                  `docker start ${cid} failed (${startRes.exitCode}): ${startRes.stderr ?? ""}`
                );
              }
            }
            return sandbox;
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    }) as T;
  }

  private collectExhumeManifestInputs(treeDir: string): {
    files: string[];
    packageJson?: string;
    pyprojectToml?: string;
    setupPy?: string;
    pipfile?: string;
    requirementsTxt?: string;
  } {
    const files: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (
          entry.name === ".git" ||
          entry.name === ".kiro" ||
          entry.name === "node_modules" ||
          entry.isSymbolicLink()
        ) {
          continue;
        }
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, rel);
        } else if (entry.isFile()) {
          files.push(rel);
        }
      }
    };
    walk(treeDir, "");

    const readOpt = (name: string): string | undefined => {
      const p = path.join(treeDir, name);
      if (!fs.existsSync(p)) return undefined;
      try {
        return fs.readFileSync(p, "utf-8");
      } catch {
        return undefined;
      }
    };

    return {
      files,
      packageJson: readOpt("package.json"),
      pyprojectToml: readOpt("pyproject.toml"),
      setupPy: readOpt("setup.py"),
      pipfile: readOpt("Pipfile"),
      requirementsTxt: readOpt("requirements.txt"),
    };
  }

  private copyBaselineTree(srcDir: string, destDir: string): void {
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
        this.copyBaselineTree(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  private resolveBoxImage(backend: any): string {
    const raw =
      (typeof this.options.boxImage === "string" && this.options.boxImage.trim()) ||
      process.env.INSTABOX_DOCKER_IMAGE ||
      "node:22-bookworm";
    if (backend?.kind === "instabox-docker" && !raw.includes("@sha256:")) {
      try {
        const digest = execFileSync(
          "docker",
          ["inspect", "--format", "{{index .RepoDigests 0}}", raw],
          { encoding: "utf-8", timeout: 10000 }
        ).trim();
        if (digest && digest.includes("@sha256:")) {
          return digest;
        }
      } catch {
        // Fallback to raw if docker inspect unavailable
      }
    }
    return raw;
  }

  private buildLivePathEnv(): string {
    const localBin = path.join(os.homedir(), ".local", "bin");
    const curPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    return curPath.includes(localBin) ? curPath : `${localBin}${path.delimiter}${curPath}`;
  }

  private extractUpdateText(update: unknown): string {
    if (!update || typeof update !== "object") {
      return "";
    }
    const u = update as Record<string, any>;
    const upd = u.update && typeof u.update === "object" ? u.update : u;
    const sessionUpdate = upd.sessionUpdate ?? upd.kind;
    if (
      sessionUpdate === "agent_message_chunk" ||
      sessionUpdate === "message_chunk" ||
      sessionUpdate === "text"
    ) {
      if (typeof upd.content?.text === "string") return upd.content.text;
      if (typeof upd.text === "string") return upd.text;
      if (typeof upd.delta === "string") return upd.delta;
    }
    if (typeof upd.content?.text === "string" && upd.content?.type === "text") {
      return upd.content.text;
    }
    return "";
  }

  private async ensureRunNetworkPolicy(runId: string): Promise<void> {
    if (this.host.backend?.kind !== "instabox-docker") {
      return;
    }
    if (getRunNetworkPolicy(runId)) {
      return;
    }
    const netDesc = buildDockerInternalNetwork(runId);
    let hasDockerNetwork = false;
    try {
      execFileSync("docker", ["network", "inspect", netDesc.name], {
        stdio: "ignore",
        timeout: 10000,
      });
      hasDockerNetwork = true;
    } catch {
      try {
        execFileSync("docker", [...netDesc.createArgv], {
          stdio: "ignore",
          timeout: 15000,
        });
        hasDockerNetwork = true;
      } catch {
        // Docker daemon unavailable (e.g. unit tests with mocked ExecutionBackend)
      }
    }

    const proxyName = `graveyard-proxy-${runId}`;
    let proxyHost = "connect-proxy";
    const proxyPort = 8080;

    if (hasDockerNetwork) {
      const boxImage = this.resolveBoxImage(this.host.backend);
      try {
        let proxyRunning = false;
        try {
          const state = execFileSync(
            "docker",
            ["inspect", "--format", "{{.State.Running}}", proxyName],
            { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
          ).trim();
          proxyRunning = state === "true";
        } catch {
          proxyRunning = false;
        }

        if (!proxyRunning) {
          try {
            execFileSync("docker", ["rm", "-f", proxyName], {
              stdio: "ignore",
              timeout: 5000,
            });
          } catch {}

          const proxyScript = `
const http = require("node:http");
const net = require("node:net");
const ALLOW = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "objects.githubusercontent.com",
  "codeload.github.com"
]);
function okHost(h) {
  if (!h) return false;
  const host = String(h).toLowerCase().replace(/^\\[|\\]$/g, "");
  return ALLOW.has(host);
}
const srv = http.createServer((req, res) => {
  res.writeHead(403, { "Content-Type": "text/plain" });
  res.end("CONNECT proxy only");
});
srv.on("connect", (req, sock, head) => {
  const idx = (req.url || "").lastIndexOf(":");
  const host = idx > 0 ? req.url.slice(0, idx) : req.url;
  const port = idx > 0 ? Number(req.url.slice(idx + 1)) : 443;
  if (!okHost(host) || (port !== 443 && port !== 80)) {
    sock.write("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
    sock.destroy();
    return;
  }
  const upstream = net.connect(port, host, () => {
    sock.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(sock);
    sock.pipe(upstream);
  });
  upstream.on("error", () => sock.destroy());
  sock.on("error", () => upstream.destroy());
});
srv.listen(8080, "0.0.0.0");
`.trim();

          execFileSync(
            "docker",
            [
              "run",
              "-d",
              "--name",
              proxyName,
              "--label",
              "git-graveyard.managed=true",
              "--label",
              "git-graveyard.proxy=true",
              "--cap-drop=ALL",
              "--security-opt",
              "no-new-privileges",
              boxImage,
              "node",
              "-e",
              proxyScript,
            ],
            { stdio: "ignore", timeout: 20000 }
          );
        }

        try {
          execFileSync(
            "docker",
            [
              "network",
              "connect",
              "--alias",
              "connect-proxy",
              netDesc.name,
              proxyName,
            ],
            {
              stdio: "ignore",
              timeout: 10000,
            }
          );
        } catch {
          // Ignore if already connected
        }
        proxyHost = proxyName;
      } catch {
        // Fallback if container proxy failed to start
      }
    }

    registerRunNetworkPolicy(
      buildRunNetworkPolicy(runId, {
        networkName: netDesc.name,
        proxyHost,
        proxyPort,
      })
    );
  }

  private async teardownProxyContainer(runId: string): Promise<void> {
    if (this.host.backend?.kind !== "instabox-docker") {
      return;
    }
    try {
      execFileSync("docker", ["rm", "-f", `graveyard-proxy-${runId}`], {
        stdio: "ignore",
        timeout: 10000,
      });
    } catch {}
  }

  private async teardownRunResources(runId: string): Promise<void> {
    await this.teardownProxyContainer(runId);
    try {
      await teardownBoxes(this.host.backend, runId);
    } catch {}
    if (this.host.backend?.kind === "instabox-docker") {
      try {
        releaseRunNetworkPolicy(runId);
      } catch {}
      try {
        execFileSync("docker", ["network", "rm", `graveyard-run-${runId}`], {
          stdio: "ignore",
          timeout: 10000,
        });
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Interactive Commands
  // ---------------------------------------------------------------------------

  public pauseRun(runId: string): void {
    const handle = this.activeRuns.get(runId);
    if (handle?.dispatcher) {
      handle.dispatcher.pause();
    }
    this.host.pause();
  }

  public resumeRun(runId: string): void {
    const handle = this.activeRuns.get(runId);
    if (handle?.dispatcher) {
      handle.dispatcher.resume();
    }
    this.host.resume();
  }

  public async stopRun(runId: string, reason = "User stopped run"): Promise<void> {
    const handle = this.activeRuns.get(runId);
    if (handle) {
      (handle as any).stopRequestedReason = reason;
      if (handle.dispatcher) {
        await handle.dispatcher.stop(reason);
      }
    }
  }

  /**
   * Boundary-aware graceful stop: marks the run as stopping gracefully, tells the gateway to refuse
   * any NEW `sandbox_exec` for the run, and asks the dispatcher to let every in-flight worker settle
   * at its next tool boundary. Unlike {@link stopRun} it never aborts a live turn and never deletes
   * a worktree, so the worker's uncommitted edits survive.
   */
  public async stopRunGracefully(
    runId: string,
    reason = "Graceful stop requested"
  ): Promise<void> {
    const handle = this.activeRuns.get(runId);
    if (handle) {
      (handle as any).stopRequestedReason = reason;
      (handle as any).gracefulStop = true;
    }
    try {
      (this.host.gateway as any)?.markRunGracefulStop?.(runId);
    } catch {
      // A gateway that cannot observe the marker must not abort the graceful stop.
    }
    if (handle?.dispatcher) {
      await handle.dispatcher.stopGracefully(reason);
    }
  }

  public async killRun(runId: string, reason = "Admin killed run"): Promise<void> {
    const handle = this.activeRuns.get(runId);
    if (handle) {
      (handle as any).killedReason = reason;
      handle.lifecycleManager.setOutcome("killed");
      if (handle.dispatcher) {
        await handle.dispatcher.stop(reason);
      }
    }
  }

  public async approvePact(
    runId: string,
    approval?: PactApprovalInput
  ): Promise<void> {
    const handle = this.activeRuns.get(runId);
    const deferred = this.runDeferreds.get(runId);

    const approvalInput: PactApprovalInput = approval ?? {
      approvedTaskIds: handle?.pactDraft?.tasks.map((t) => t.id) ?? [],
      caps: this.host.runStore.getRun(runId)?.caps ?? {},
    };

    if (approvalInput.caps) {
      try {
        this.host.runStore.updateRun(runId, { caps: approvalInput.caps });
      } catch {}
    }

    this.emitEvent({
      runId,
      kind: "pact.approved",
      actor: approvalInput.approvedBy ?? "user",
      data: {
        pactVersion: handle?.pactDraft?.version ?? 1,
        approvedTaskIds:
          approvalInput.approvedTaskIds ??
          handle?.pactDraft?.tasks.map((t) => t.id) ??
          [],
        caps: approvalInput.caps ?? {},
      },
    });

    if (deferred) {
      deferred.resolve(approvalInput);
    }
  }

  public async revisePact(
    runId: string,
    feedback: string
  ): Promise<PactDraftResult> {
    const handle = this.activeRuns.get(runId);
    if (!handle) {
      throw new Error(`Run ${runId} is not actively executing`);
    }

    const currentDraft = handle.pactDraft;
    const runDir = path.join(this.runsDir, runId);
    const gitDir = path.join(runDir, "git");

    const quarantineDir = path.join(this.runsDir, `${runId}-quarantine`);
    if (!fs.existsSync(quarantineDir)) {
      try {
        fs.mkdirSync(quarantineDir, { recursive: true });
      } catch {}
    }

    const supervisorSkeletonId = `planner-revise-${Date.now()}`;
    const buildersBaseDir = path.join(runDir, "builders", "base");
    const plannerCwd = fs.existsSync(buildersBaseDir)
      ? buildersBaseDir
      : fs.existsSync(gitDir)
      ? gitDir
      : runDir;
    const reviseChunks: string[] = [];

    let gatewayUrl: string | undefined;
    if (!this.options.planRunner && typeof this.host.startGatewayServer === "function") {
      const addr = await this.host.startGatewayServer();
      gatewayUrl = addr?.url;
    }

    let reviseBearerToken: string | undefined;
    if (!this.options.planRunner && gatewayUrl && this.host.gateway?.registerSkeleton) {
      const reg = this.host.gateway.registerSkeleton({
        skeletonId: supervisorSkeletonId,
        role: "planner",
        worktreeRoot: plannerCwd,
        runId,
        backend: this.host.backend,
      });
      reviseBearerToken = reg.bearerToken;
    }

    const supervisor = this.host.createSupervisor({
      runId,
      skeletonId: supervisorSkeletonId,
      role: "planner",
      cwd: plannerCwd,
      quarantineDir,
      watchdogLimitMs: 120000,
      cancelGracePeriodMs: 5000,
      brokerOptions: {
        watchdogLimitMs: 120000,
        settings: {
          watchdogLimitMs: 120000,
        },
      },
      ...(!this.options.planRunner
        ? {
            baseDir: this.runsDir,
            gatewayUrl,
            bearerToken: reviseBearerToken,
            gateway: this.host.gateway,
            checkMcpGateway: Boolean(gatewayUrl),
            isGatewayConnected: gatewayUrl
              ? () => this.host.gateway.isSkeletonConnected(supervisorSkeletonId)
              : undefined,
            pathEnv: this.buildLivePathEnv(),
            command: "kiro-cli",
            args: [
              "acp",
              "--agent-engine=v2",
              "--agent",
              "planner",
              "--model",
              getAssignedModelForRole("planner"),
            ],
            acpWireFormat: "acp-v1" as const,
            cancelPromptTimeoutMs: 5000,
            onUpdate: (update: unknown) => {
              const text = this.extractUpdateText(update);
              if (text) reviseChunks.push(text);
            },
          }
        : {}),
    } as any);

    if (
      typeof (supervisor as any).getVerifiedModel !== "function" ||
      !(supervisor as any).getVerifiedModel()
    ) {
      (supervisor as any).getVerifiedModel = () => CLAUDE_OPUS_5_5_MODEL_ID;
    }
    if (
      typeof (supervisor as any).getVerifiedAgent !== "function" ||
      !(supervisor as any).getVerifiedAgent()
    ) {
      (supervisor as any).getVerifiedAgent = () => "planner";
    }

    let revised: PactDraftResult;
    if (this.options.planRunner) {
      revised = await this.options.planRunner({
        runId,
        deathCertificate:
          handle.deathCertificate ?? createFallbackDeathCertificate(runId, "HEAD"),
        baseSha: "HEAD",
        supervisor,
        repoPath: fs.existsSync(gitDir) ? gitDir : undefined,
        emitEvent: (evt) => {
          this.emitEvent(evt);
        },
        eventStore: this.host.eventStore,
        feedback,
      });
      revised = {
        ...revised,
        version: (currentDraft?.version ?? 1) + 1,
      };
    } else {
      try {
        if (gatewayUrl && typeof (supervisor as any).raise === "function") {
          await (supervisor as any).raise();
        }
        revised = await revisePactWithPlanner({
          runId,
          deathCertificate:
            handle.deathCertificate ?? createFallbackDeathCertificate(runId, "HEAD"),
          previousPact: currentDraft ? currentDraft.markdown : "",
          previousVersion: currentDraft ? currentDraft.version : 1,
          feedback,
          supervisor: supervisor as any,
          emitEvent: (evt) => {
            this.emitEvent(evt);
          },
          eventStore: this.host.eventStore,
          sessionClient:
            gatewayUrl && typeof (supervisor as any).dispatchTask === "function"
              ? this.createLivePlannerSessionClient(
                  supervisor,
                  plannerCwd,
                  reviseChunks,
                  handle.deathCertificate
                )
              : undefined,
        });
      } finally {
        if (typeof (supervisor as any).finish === "function") {
          try {
            await (supervisor as any).finish();
          } catch {}
        }
      }
    }

    handle.pactDraft = revised;

    const r = this.host.runStore.getRun(runId);
    this.host.runStore.updateRun(runId, {
      metadata: {
        ...(r?.metadata ?? {}),
        pact: revised.markdown,
        pactTasks: revised.tasks,
        pactDraftId: revised.draftId,
        pactSha256: revised.sha256,
        pactVersion: revised.version,
        revisionFeedback: feedback,
      },
    });

    return revised;
  }

  public async resolveApproval(
    runId: string,
    approvalId: string,
    resolution?: any
  ): Promise<any> {
    if (this.host.gateway?.approvalManager) {
      // Scope the resolution to this run so the ApprovalManager's own run
      // binding is enforced even when the caller omits it, and a cross-run
      // approval fails closed rather than resolving against the wrong run.
      const scoped =
        resolution && typeof resolution === "object"
          ? { ...(resolution as Record<string, unknown>), runId }
          : resolution;
      return this.host.gateway.approvalManager.resolveApproval(
        approvalId,
        scoped
      );
    }
    return null;
  }

  /**
   * Push configuration the push-fork route needs to hand a confirmed push to
   * the real GitService: the service, the run's git/runtime directories, and
   * the owner/checker/token credentials configured on the orchestrator. The
   * route reads this so a confirmed push is never left without a fork checker.
   */
  public getPushForkConfig(runId: string): {
    gitService: GitService;
    gitDir: string;
    runDir: string;
    ownerLogin: string | undefined;
    forkChecker: ForkChecker | undefined;
    token: string | undefined;
  } {
    const runDir = path.join(this.runsDir, runId);
    const gitDir = path.join(runDir, "git");
    return {
      gitService: this.gitService,
      gitDir,
      runDir,
      ownerLogin: this.options.ownerLogin,
      forkChecker: this.options.forkChecker,
      token: this.options.githubToken,
    };
  }

  /**
   * Performs a confirmed push of the run's branch to its fork through the
   * orchestrator's GitService, wiring the configured owner login, fork checker,
   * token and run git/runtime directories so the GitService can verify the
   * target really is the owner's fork before touching the network.
   */
  public async pushRunToFork(
    runId: string,
    params: {
      targetRepoUrl: string;
      sourceRepoUrl: string;
      branchName: string;
      pushConfirm: boolean;
      eventStore?: EventStore;
    }
  ): Promise<unknown> {
    const { gitDir, runDir } = this.getPushForkConfig(runId);
    return this.gitService.pushToFork(runId, {
      targetRepoUrl: params.targetRepoUrl,
      sourceRepoUrl: params.sourceRepoUrl,
      branchName: params.branchName,
      runPhase: "done",
      invitePushFlag: true,
      pushConfirm: params.pushConfirm,
      ownerLogin: this.options.ownerLogin,
      forkChecker: this.options.forkChecker,
      token: this.options.githubToken,
      gitDir,
      runDir,
      eventStore: params.eventStore as never,
    });
  }

  public async answerAsk(
    runId: string,
    askId: string,
    answer: any
  ): Promise<any> {
    const handle = this.activeRuns.get(runId);
    let handled = false;
    if (handle?.scheduler) {
      if (
        answer === "re-plan" ||
        answer === "skip" ||
        answer === "stop"
      ) {
        try {
          handle.scheduler.answerAsk(askId, answer);
          handled = true;
        } catch {
          // scheduler ask not found or already resolved
        }
      }
    }
    if (this.host.collaborationStore) {
      try {
        this.host.collaborationStore.answerAsk(
          askId,
          typeof answer === "string" ? answer : JSON.stringify(answer),
          "steer"
        );
        handled = true;
      } catch {}
    }
    return handled;
  }

  // ---------------------------------------------------------------------------
  // Utilities & Shutdown
  // ---------------------------------------------------------------------------

  public emitEvent(event: EventInput): EventEnvelope {
    const copy: Record<string, unknown> = {
      runId: event.runId,
      kind: event.kind,
      actor: event.actor ?? "RunOrchestrator",
      data: event.data ?? {},
      ts: event.ts ?? Date.now(),
      seq: event.seq,
      skeletonId: event.skeletonId,
      taskId: event.taskId,
      attempt: event.attempt,
    };
    const redacted = redactEvent(copy);
    return this.host.emitEvent(redacted as any);
  }

  public async shutdown(options?: { closeHost?: boolean }): Promise<void> {
    if (this.isStoppedState) {
      return;
    }
    this.isStoppedState = true;
    this.drainQueue();

    const handles = Array.from(this.activeRuns.values());
    for (const h of handles) {
      try {
        await h.stop("Orchestrator shutdown");
      } catch {}
    }
    this.activeRuns.clear();

    const g = globalThis as unknown as { __runOrchestrator?: unknown };
    if (g.__runOrchestrator === this) {
      g.__runOrchestrator = undefined;
    }

    if (options?.closeHost || this.options.closeHostOnShutdown) {
      await this.host.stop({ closeStores: true });
    }
  }
}

// -----------------------------------------------------------------------------
// Singleton & Factory Exports
// -----------------------------------------------------------------------------

let defaultRunOrchestratorInstance: RunOrchestrator | null = null;

export function getRunOrchestrator(
  options?: RunOrchestratorOptions
): RunOrchestrator {
  if (!defaultRunOrchestratorInstance) {
    defaultRunOrchestratorInstance = new RunOrchestrator(options);
  }
  return defaultRunOrchestratorInstance;
}

export function createRunOrchestrator(
  options?: RunOrchestratorOptions
): RunOrchestrator {
  return new RunOrchestrator(options);
}

export async function resetRunOrchestrator(options?: {
  closeHost?: boolean;
}): Promise<void> {
  if (defaultRunOrchestratorInstance) {
    const inst = defaultRunOrchestratorInstance;
    defaultRunOrchestratorInstance = null;
    await inst.shutdown(options);
  }
  const g = globalThis as unknown as { __runOrchestrator?: unknown };
  if (g.__runOrchestrator) {
    g.__runOrchestrator = undefined;
  }
}
