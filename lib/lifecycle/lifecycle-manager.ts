import type {
  EventData,
  EventEnvelope,
  EventKind,
  EvidenceRef,
  RunPhase,
} from "../events/types";

export type { RunPhase };

/**
 * Requirement 26.2 / Requirement 27.2 / Requirements Glossary (Run Outcome)
 * Terminal outcomes:
 * resurrected, resurrected_build_only, partial, not_resurrected, healthy_already,
 * cancelled, killed, budget_stopped, error.
 */
export type RunOutcome =
  | "resurrected"
  | "resurrected_build_only"
  | "partial"
  | "not_resurrected"
  | "healthy_already"
  | "cancelled"
  | "killed"
  | "budget_stopped"
  | "error";

export const RUN_PHASES: readonly RunPhase[] = [
  "queued",
  "exhume",
  "plan",
  "pact_review",
  "legion",
  "final_check",
  "report",
  "done",
] as const;

export const RUN_OUTCOMES: readonly RunOutcome[] = [
  "resurrected",
  "resurrected_build_only",
  "partial",
  "not_resurrected",
  "healthy_already",
  "cancelled",
  "killed",
  "budget_stopped",
  "error",
] as const;

export type EarlyExitReason =
  | "user_stop"
  | "cancelled"
  | "killed"
  | "admin_kill"
  | "budget_stopped"
  | "budget_stop"
  | "budget_exceeded"
  | "healthy_already"
  | "error"
  | "unrecoverable_error";

export class IllegalTransitionError extends Error {
  readonly fromPhase: RunPhase;
  readonly toPhase: RunPhase;
  readonly reason?: string;

  constructor(fromPhase: RunPhase, toPhase: RunPhase, message?: string) {
    super(
      message ?? `Illegal phase transition from '${fromPhase}' to '${toPhase}'`
    );
    this.name = "IllegalTransitionError";
    this.fromPhase = fromPhase;
    this.toPhase = toPhase;
  }
}

export interface TransitionOptions {
  reason?: EarlyExitReason | string;
  outcome?: RunOutcome;
  isEarlyExit?: boolean;
  actor?: string;
  skeletonId?: string;
  taskId?: string;
  attempt?: number;
  data?: Record<string, unknown>;
  ts?: number;
}

export interface AdvanceOptions {
  actor?: string;
  skeletonId?: string;
  taskId?: string;
  attempt?: number;
  data?: Record<string, unknown>;
  ts?: number;
}

export interface EarlyExitOptions {
  reason: EarlyExitReason | string;
  outcome?: RunOutcome;
  targetPhase?: RunPhase;
  actor?: string;
  data?: Record<string, unknown>;
  ts?: number;
}

export type EmitFunction = (
  event: EventEnvelope
) => void | Promise<void>;

export interface LifecycleManagerOptions {
  runId: string;
  emit: EmitFunction;
  initialPhase?: RunPhase;
  actor?: string;
  seq?: number;
  now?: () => number;
}

export interface PhaseTransitionRecord {
  phase: RunPhase;
  previousPhase: RunPhase;
  ts: number;
  reason?: string;
  outcome?: RunOutcome;
}

export function isLegalTransition(
  fromPhase: RunPhase,
  toPhase: RunPhase,
  options?: { isEarlyExit?: boolean; reason?: string }
): boolean {
  if (fromPhase === "done") {
    return false;
  }
  if (fromPhase === toPhase) {
    return false;
  }

  const fromIdx = RUN_PHASES.indexOf(fromPhase);
  const toIdx = RUN_PHASES.indexOf(toPhase);
  if (fromIdx === -1 || toIdx === -1) {
    return false;
  }

  // Backward transitions are strictly forbidden
  if (toIdx < fromIdx) {
    return false;
  }

  // Next sequential phase
  if (toIdx === fromIdx + 1) {
    return true;
  }

  // Early exit to done is allowed from any non-done phase
  if (toPhase === "done") {
    return true;
  }

  // Early exit to report (e.g. to draft report on early termination)
  if (toPhase === "report" && (options?.isEarlyExit || options?.reason)) {
    return true;
  }

  return false;
}

function parseStepSuccess(val: unknown): boolean | null {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "number") {
    return val === 0;
  }
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (s === "passed" || s === "success" || s === "ok" || s === "true") {
      return true;
    }
    if (s === "failed" || s === "error" || s === "false") {
      return false;
    }
    return null;
  }
  if (typeof val === "object" && val !== null) {
    const rec = val as Record<string, unknown>;
    if (typeof rec.passed === "boolean") {
      return rec.passed;
    }
    if (typeof rec.ok === "boolean") {
      return rec.ok;
    }
    if (typeof rec.exitCode === "number") {
      return rec.exitCode === 0;
    }
    if (typeof rec.status === "string") {
      const s = rec.status.trim().toLowerCase();
      if (s === "passed" || s === "success" || s === "ok") {
        return true;
      }
      if (s === "failed" || s === "error") {
        return false;
      }
    }
  }
  return null;
}

export interface OutcomeEvaluationInput {
  outcome?: RunOutcome | string | null;
  reason?: EarlyExitReason | string | null;
  exitReason?: EarlyExitReason | string | null;
  stopReason?: string | null;
  cancelled?: boolean | null;
  userStop?: boolean | null;
  killed?: boolean | null;
  budgetStopped?: boolean | null;
  budgetExceeded?: boolean | null;
  unrecoverableError?: boolean | null;
  error?: boolean | Error | string | null;
  healthyAlready?: boolean | null;
  noInitialFailures?: boolean | null;
  initialFailuresCount?: number | null;
  hasInitialFailures?: boolean | null;

  installPassed?: boolean | null;
  buildPassed?: boolean | null;
  testsPassed?: boolean | null;
  hasTests?: boolean | null;
  repoHasTests?: boolean | null;

  install?:
    | boolean
    | number
    | string
    | { exitCode?: number; status?: string; passed?: boolean; ok?: boolean }
    | null;
  build?:
    | boolean
    | number
    | string
    | { exitCode?: number; status?: string; passed?: boolean; ok?: boolean }
    | null;
  test?:
    | boolean
    | number
    | string
    | {
        exitCode?: number;
        status?: string;
        passed?: boolean;
        ok?: boolean;
        testCounts?: unknown;
      }
    | null;
  tests?:
    | boolean
    | number
    | string
    | {
        exitCode?: number;
        status?: string;
        passed?: boolean;
        ok?: boolean;
        testCounts?: unknown;
      }
    | null;

  finalCheck?: {
    installPassed?: boolean | null;
    buildPassed?: boolean | null;
    testsPassed?: boolean | null;
    hasTests?: boolean | null;
    install?:
      | boolean
      | number
      | string
      | { exitCode?: number; status?: string; passed?: boolean; ok?: boolean }
      | null;
    build?:
      | boolean
      | number
      | string
      | { exitCode?: number; status?: string; passed?: boolean; ok?: boolean }
      | null;
    test?:
      | boolean
      | number
      | string
      | {
          exitCode?: number;
          status?: string;
          passed?: boolean;
          ok?: boolean;
          testCounts?: unknown;
        }
      | null;
    tests?:
      | boolean
      | number
      | string
      | {
          exitCode?: number;
          status?: string;
          passed?: boolean;
          ok?: boolean;
          testCounts?: unknown;
        }
      | null;
  } | null;

  tasks?: Array<{
    id?: string;
    state?: string;
    merged?: boolean;
    failed?: boolean;
    abandoned?: boolean;
    skipped?: boolean;
  }> | null;
  mergedTasksCount?: number | null;
  failedTasksCount?: number | null;
  totalTasksCount?: number | null;
}

export function evaluateOutcome(
  input: OutcomeEvaluationInput | RunOutcome | string,
  options?: Partial<OutcomeEvaluationInput>
): RunOutcome {
  if (typeof input === "string") {
    if ((RUN_OUTCOMES as readonly string[]).includes(input)) {
      return input as RunOutcome;
    }
    if (input === "build-only" || input === "resurrected_build_only") {
      return "resurrected_build_only";
    }
  }

  const inp: OutcomeEvaluationInput =
    typeof input === "object" && input !== null
      ? { ...input, ...(options ?? {}) }
      : { ...(options ?? {}) };

  // 1. Direct outcome override
  if (inp.outcome && typeof inp.outcome === "string") {
    const norm = inp.outcome.trim();
    if ((RUN_OUTCOMES as readonly string[]).includes(norm)) {
      return norm as RunOutcome;
    }
    if (norm === "build-only") {
      return "resurrected_build_only";
    }
  }

  const reason = (
    inp.reason ??
    inp.exitReason ??
    inp.stopReason ??
    ""
  ).toLowerCase().trim();

  // 2. Early exit outcomes
  // 2a. Healthy already: when no initial failures exist (Requirement 11.15)
  if (
    inp.healthyAlready === true ||
    inp.noInitialFailures === true ||
    reason === "healthy_already" ||
    (inp.hasInitialFailures === false && (inp.userStop || reason)) ||
    (inp.initialFailuresCount === 0 && (inp.userStop || reason))
  ) {
    return "healthy_already";
  }

  // 2b. Cancelled: user stop
  if (
    inp.userStop === true ||
    inp.cancelled === true ||
    reason === "user_stop" ||
    reason === "cancelled" ||
    reason === "stop_run" ||
    reason === "user_action"
  ) {
    return "cancelled";
  }

  // 2c. Killed: admin kill
  if (
    inp.killed === true ||
    reason === "killed" ||
    reason === "admin_kill" ||
    reason === "admin.kill"
  ) {
    return "killed";
  }

  // 2d. Budget stopped (Requirement 30 / Task 14.1)
  if (
    inp.budgetStopped === true ||
    inp.budgetExceeded === true ||
    reason === "budget_stopped" ||
    reason === "budget_stop" ||
    reason === "budget_exceeded" ||
    reason === "budget.exceeded"
  ) {
    return "budget_stopped";
  }

  // 2e. Error: unrecoverable errors
  if (
    inp.unrecoverableError === true ||
    Boolean(inp.error) ||
    reason === "error" ||
    reason === "unrecoverable_error" ||
    reason === "fatal" ||
    reason === "box_lost"
  ) {
    return "error";
  }

  // 3. Resolve final check / step execution results
  let installPassed =
    inp.installPassed ??
    inp.finalCheck?.installPassed ??
    parseStepSuccess(inp.install) ??
    parseStepSuccess(inp.finalCheck?.install);

  const buildPassed =
    inp.buildPassed ??
    inp.finalCheck?.buildPassed ??
    parseStepSuccess(inp.build) ??
    parseStepSuccess(inp.finalCheck?.build);

  const testVal =
    inp.test ??
    inp.tests ??
    inp.finalCheck?.test ??
    inp.finalCheck?.tests;

  let hasTests: boolean | null = null;
  if (typeof inp.hasTests === "boolean") {
    hasTests = inp.hasTests;
  } else if (typeof inp.repoHasTests === "boolean") {
    hasTests = inp.repoHasTests;
  } else if (typeof inp.finalCheck?.hasTests === "boolean") {
    hasTests = inp.finalCheck.hasTests;
  } else if (
    testVal === "no_tests_found" ||
    (typeof testVal === "object" &&
      testVal !== null &&
      "status" in testVal &&
      (testVal as Record<string, unknown>).status === "no_tests_found")
  ) {
    hasTests = false;
  } else if (inp.testsPassed !== undefined && inp.testsPassed !== null) {
    hasTests = true;
  } else if (testVal !== undefined && testVal !== null) {
    hasTests = true;
  }

  const testsPassed =
    inp.testsPassed ??
    inp.finalCheck?.testsPassed ??
    parseStepSuccess(testVal);

  // 4. Evaluate per criteria:
  // Requirement 41.1: If repository installation still fails after the Legion phase,
  // THE Necromancer SHALL end the run with outcome not_resurrected.
  if (installPassed === false) {
    return "not_resurrected";
  }

  // If installPassed was not explicitly set:
  // If build or tests passed, installation must have succeeded
  if (installPassed === null || installPassed === undefined) {
    if (buildPassed === true || testsPassed === true) {
      installPassed = true;
    }
  }

  // Requirements 26.14 & 41.3: When the repository has no tests and the final_check
  // build passes, assign resurrected_build_only.
  if (hasTests === false) {
    if (buildPassed === true) {
      return "resurrected_build_only";
    }
    if (installPassed === true && buildPassed === false) {
      return "partial";
    }
    if (buildPassed === false) {
      return "not_resurrected";
    }
  }

  // Requirement 26.3: When evaluating for resurrected, assign resurrected only
  // when final_check build and repository tests have passed.
  if (buildPassed === true && testsPassed === true) {
    return "resurrected";
  }

  // If install passed, but build or tests failed -> partial
  if (installPassed === true) {
    if (buildPassed === false || testsPassed === false) {
      return "partial";
    }
  }

  // Check tasks state if provided
  if (Array.isArray(inp.tasks) && inp.tasks.length > 0) {
    const mergedCount = inp.tasks.filter(
      (t) => t.merged === true || t.state === "merged"
    ).length;
    const failedCount = inp.tasks.filter(
      (t) =>
        t.failed === true ||
        t.abandoned === true ||
        t.skipped === true ||
        t.state === "failed" ||
        t.state === "abandoned" ||
        t.state === "skipped"
    ).length;

    if (mergedCount > 0 && failedCount > 0) {
      return "partial";
    }
    if (mergedCount > 0) {
      return "partial";
    }
    if (failedCount > 0 && mergedCount === 0) {
      return "not_resurrected";
    }
  }

  if (typeof inp.mergedTasksCount === "number" && inp.mergedTasksCount > 0) {
    return "partial";
  }

  if (installPassed === true) {
    return "partial";
  }

  return "not_resurrected";
}

export class LifecycleManager {
  readonly runId: string;
  private _phase: RunPhase;
  private _outcome: RunOutcome | null = null;
  private _emit: EmitFunction;
  private _actor: string;
  private _seq: number;
  private _now: () => number;
  private _history: PhaseTransitionRecord[] = [];

  constructor(
    runIdOrOptions: string | LifecycleManagerOptions,
    maybeEmit?: EmitFunction,
    initialPhase?: RunPhase
  ) {
    if (typeof runIdOrOptions === "object" && runIdOrOptions !== null) {
      this.runId = runIdOrOptions.runId;
      this._emit = runIdOrOptions.emit ?? (() => {});
      this._phase = runIdOrOptions.initialPhase ?? "queued";
      this._actor = runIdOrOptions.actor ?? "necromancer";
      this._seq = typeof runIdOrOptions.seq === "number" ? runIdOrOptions.seq : 1;
      this._now = runIdOrOptions.now ?? Date.now;
    } else {
      this.runId = runIdOrOptions;
      this._emit = maybeEmit ?? (() => {});
      this._phase = initialPhase ?? "queued";
      this._actor = "necromancer";
      this._seq = 1;
      this._now = Date.now;
    }

    if (!RUN_PHASES.includes(this._phase)) {
      throw new Error(`Invalid initial phase: '${this._phase}'`);
    }
  }

  get phase(): RunPhase {
    return this._phase;
  }

  get currentPhase(): RunPhase {
    return this._phase;
  }

  getPhase(): RunPhase {
    return this._phase;
  }

  get outcome(): RunOutcome | null {
    return this._outcome;
  }

  getOutcome(): RunOutcome | null {
    return this._outcome;
  }

  setOutcome(outcome: RunOutcome): void {
    this._outcome = outcome;
  }

  get isTerminal(): boolean {
    return this._phase === "done";
  }

  get history(): ReadonlyArray<PhaseTransitionRecord> {
    return [...this._history];
  }

  getNextPhase(): RunPhase | null {
    const idx = RUN_PHASES.indexOf(this._phase);
    if (idx === -1 || idx >= RUN_PHASES.length - 1) {
      return null;
    }
    return RUN_PHASES[idx + 1];
  }

  canTransitionTo(
    targetPhase: RunPhase,
    options?: TransitionOptions
  ): boolean {
    return isLegalTransition(this._phase, targetPhase, options);
  }

  canTransition(
    targetPhase: RunPhase,
    options?: TransitionOptions
  ): boolean {
    return this.canTransitionTo(targetPhase, options);
  }

  advance(options?: AdvanceOptions): RunPhase {
    const next = this.getNextPhase();
    if (!next) {
      throw new IllegalTransitionError(
        this._phase,
        "done",
        `Cannot advance from terminal phase '${this._phase}'`
      );
    }
    return this.transitionTo(next, options);
  }

  async advanceAsync(options?: AdvanceOptions): Promise<RunPhase> {
    const next = this.getNextPhase();
    if (!next) {
      throw new IllegalTransitionError(
        this._phase,
        "done",
        `Cannot advance from terminal phase '${this._phase}'`
      );
    }
    return this.transitionToAsync(next, options);
  }

  transitionTo(
    targetPhase: RunPhase,
    options?: TransitionOptions
  ): RunPhase {
    if (!this.canTransitionTo(targetPhase, options)) {
      if (this._phase === "done") {
        throw new IllegalTransitionError(
          this._phase,
          targetPhase,
          `Cannot transition from terminal phase '${this._phase}'`
        );
      }
      if (this._phase === targetPhase) {
        throw new IllegalTransitionError(
          this._phase,
          targetPhase,
          `Illegal phase transition from '${this._phase}' to '${targetPhase}': cannot transition to the same phase`
        );
      }
      const fromIdx = RUN_PHASES.indexOf(this._phase);
      const toIdx = RUN_PHASES.indexOf(targetPhase);
      if (toIdx < fromIdx) {
        throw new IllegalTransitionError(
          this._phase,
          targetPhase,
          `Illegal phase transition from '${this._phase}' to '${targetPhase}': backward transitions are not allowed`
        );
      }
      throw new IllegalTransitionError(
        this._phase,
        targetPhase,
        `Illegal phase transition from '${this._phase}' to '${targetPhase}'`
      );
    }

    const previousPhase = this._phase;
    this._phase = targetPhase;

    if (options?.outcome) {
      this._outcome = options.outcome;
    } else if (targetPhase === "done" && options?.reason && !this._outcome) {
      this._outcome = evaluateOutcome({ reason: options.reason });
    }

    const ts = typeof options?.ts === "number" ? options.ts : this._now();
    const eventData: EventData = {
      phase: targetPhase,
      previousPhase,
      entered: ts,
      refs: [],
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(this._outcome ? { outcome: this._outcome } : {}),
      ...(options?.data ?? {}),
    };

    const envelope: EventEnvelope = {
      runId: this.runId,
      seq: this._seq++,
      ts,
      kind: "run.phase",
      actor: options?.actor ?? this._actor,
      data: eventData,
      ...(options?.skeletonId ? { skeletonId: options.skeletonId } : {}),
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      ...(typeof options?.attempt === "number" ? { attempt: options.attempt } : {}),
    };

    this._history.push({
      phase: targetPhase,
      previousPhase,
      ts,
      reason: options?.reason,
      outcome: this._outcome ?? undefined,
    });

    const res = this._emit(envelope);
    if (res && typeof (res as Promise<unknown>).catch === "function") {
      (res as Promise<unknown>).catch(() => {});
    }

    return this._phase;
  }

  async transitionToAsync(
    targetPhase: RunPhase,
    options?: TransitionOptions
  ): Promise<RunPhase> {
    if (!this.canTransitionTo(targetPhase, options)) {
      if (this._phase === "done") {
        throw new IllegalTransitionError(
          this._phase,
          targetPhase,
          `Cannot transition from terminal phase '${this._phase}'`
        );
      }
      if (this._phase === targetPhase) {
        throw new IllegalTransitionError(
          this._phase,
          targetPhase,
          `Illegal phase transition from '${this._phase}' to '${targetPhase}': cannot transition to the same phase`
        );
      }
      const fromIdx = RUN_PHASES.indexOf(this._phase);
      const toIdx = RUN_PHASES.indexOf(targetPhase);
      if (toIdx < fromIdx) {
        throw new IllegalTransitionError(
          this._phase,
          targetPhase,
          `Illegal phase transition from '${this._phase}' to '${targetPhase}': backward transitions are not allowed`
        );
      }
      throw new IllegalTransitionError(
        this._phase,
        targetPhase,
        `Illegal phase transition from '${this._phase}' to '${targetPhase}'`
      );
    }

    const previousPhase = this._phase;
    this._phase = targetPhase;

    if (options?.outcome) {
      this._outcome = options.outcome;
    } else if (targetPhase === "done" && options?.reason && !this._outcome) {
      this._outcome = evaluateOutcome({ reason: options.reason });
    }

    const ts = typeof options?.ts === "number" ? options.ts : this._now();
    const eventData: EventData = {
      phase: targetPhase,
      previousPhase,
      entered: ts,
      refs: [],
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(this._outcome ? { outcome: this._outcome } : {}),
      ...(options?.data ?? {}),
    };

    const envelope: EventEnvelope = {
      runId: this.runId,
      seq: this._seq++,
      ts,
      kind: "run.phase",
      actor: options?.actor ?? this._actor,
      data: eventData,
      ...(options?.skeletonId ? { skeletonId: options.skeletonId } : {}),
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      ...(typeof options?.attempt === "number" ? { attempt: options.attempt } : {}),
    };

    this._history.push({
      phase: targetPhase,
      previousPhase,
      ts,
      reason: options?.reason,
      outcome: this._outcome ?? undefined,
    });

    await this._emit(envelope);
    return this._phase;
  }

  exitEarly(
    reasonOrOptions: EarlyExitReason | EarlyExitOptions | string
  ): RunPhase {
    const opts: EarlyExitOptions =
      typeof reasonOrOptions === "string"
        ? { reason: reasonOrOptions as EarlyExitReason }
        : reasonOrOptions;

    const targetPhase: RunPhase = opts.targetPhase ?? "done";
    const outcome = opts.outcome ?? evaluateOutcome({ reason: opts.reason });

    return this.transitionTo(targetPhase, {
      reason: opts.reason,
      outcome,
      isEarlyExit: true,
      actor: opts.actor,
      data: opts.data,
      ts: opts.ts,
    });
  }

  async exitEarlyAsync(
    reasonOrOptions: EarlyExitReason | EarlyExitOptions | string
  ): Promise<RunPhase> {
    const opts: EarlyExitOptions =
      typeof reasonOrOptions === "string"
        ? { reason: reasonOrOptions as EarlyExitReason }
        : reasonOrOptions;

    const targetPhase: RunPhase = opts.targetPhase ?? "done";
    const outcome = opts.outcome ?? evaluateOutcome({ reason: opts.reason });

    return this.transitionToAsync(targetPhase, {
      reason: opts.reason,
      outcome,
      isEarlyExit: true,
      actor: opts.actor,
      data: opts.data,
      ts: opts.ts,
    });
  }

  evaluateOutcome(input: OutcomeEvaluationInput): RunOutcome {
    const result = evaluateOutcome(input);
    if (this._phase === "done" && !this._outcome) {
      this._outcome = result;
    }
    return result;
  }
}
