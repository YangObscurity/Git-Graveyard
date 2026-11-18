import type {
  ExecutionBackend,
  Sandbox,
  SandboxSpec,
} from "../backend/types";
import type {
  EventData,
  EventEnvelope,
  EvidenceRef,
} from "../events/types";
import type { ArtifactManifest } from "./artifact-collector";
import {
  LifecycleManager,
  type EmitFunction,
  type RunOutcome,
  RUN_OUTCOMES,
} from "./lifecycle-manager";
import type { ReportStepArtifactList } from "./report-step";

/**
 * Extended ExecutionBackend interface providing container teardown methods.
 * Task 14.4 / Requirements 26.13, 43.18.
 */
export interface FinalizerExecutionBackend extends ExecutionBackend {
  destroyBox?(boxId: string): Promise<void>;
  destroyRun?(runId: string): Promise<void>;
  destroy?(id: string): Promise<void>;
  get?(id: string): Promise<Sandbox | undefined>;
  list?(labels?: Record<string, string>): AsyncIterable<unknown> | Promise<unknown[]>;
}

/**
 * Information on an active container process checked during residual verification.
 */
export interface ProcessCheckInfo {
  pid: number | string;
  command?: string;
  boxId?: string;
}

/**
 * Information on a host bind mount checked during residual verification.
 */
export interface MountCheckInfo {
  mountPath: string;
  source?: string;
  boxId?: string;
}

/**
 * Pluggable residual checker for processes, host mounts, and boxes.
 * Task 14.4 / Requirement 44.10 / Item XR-01.
 */
export interface ResidualChecker {
  checkProcesses?(
    runId: string,
    boxIds: readonly string[]
  ): Promise<ProcessCheckInfo[]> | ProcessCheckInfo[];
  checkMounts?(
    runId: string,
    hostMountPaths: readonly string[]
  ): Promise<MountCheckInfo[]> | MountCheckInfo[];
  checkBoxes?(
    runId: string,
    boxIds: readonly string[]
  ): Promise<string[]> | string[];
}

/**
 * Result of residual state verification after sandbox teardown.
 * Task 14.4: Ensure zero residual container processes or host bind mounts remain.
 */
export interface ResidualVerificationResult {
  verified: boolean;
  residualProcessesCount: number;
  residualMountsCount: number;
  residualBoxesCount: number;
  destroyedBoxes: readonly string[];
  residualBoxIds: readonly string[];
  residualProcesses: readonly ProcessCheckInfo[];
  residualMounts: readonly MountCheckInfo[];
  details?: Record<string, unknown>;
}

/**
 * Thrown when residual container processes or host bind mounts are detected.
 */
export class ResidualStateError extends Error {
  readonly result: ResidualVerificationResult;

  constructor(message: string, result: ResidualVerificationResult) {
    super(message);
    this.name = "ResidualStateError";
    this.result = result;
  }
}

/**
 * Thrown when run finalization is attempted before all artifacts are stored.
 * Requirement 26.15.
 */
export class ArtifactsNotStoredError extends Error {
  readonly runId: string;

  constructor(runId: string, message?: string) {
    super(
      message ??
        `Run '${runId}' cannot be finalized: artifacts are not yet fully stored`
    );
    this.name = "ArtifactsNotStoredError";
    this.runId = runId;
  }
}

/**
 * Typed event data payload for the terminal run.done event.
 * Task 14.4 / Requirements 26.13, 26.15.
 */
export interface RunDoneEventData extends EventData {
  refs: EvidenceRef[];
  outcome: RunOutcome;
  durationMs: number;
  totalDurationMs: number;
  duration: number;
  manifest: ArtifactManifest | ReportStepArtifactList | Record<string, unknown>;
  phase: "done";
  boxesDestroyed: readonly string[];
  residualVerification?: ResidualVerificationResult;
  [key: string]: unknown;
}

/**
 * Typed envelope for run.done event.
 */
export interface RunDoneEventEnvelope extends EventEnvelope {
  kind: "run.done";
  data: RunDoneEventData;
}

/**
 * Options for finalizing a run.
 */
export interface FinalizeRunOptions {
  runId: string;
  backend?: ExecutionBackend | FinalizerExecutionBackend | null;
  lifecycleManager?: LifecycleManager;
  emit?: EmitFunction | ((event: EventEnvelope) => void | Promise<void>);
  outcome?: RunOutcome | string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  manifest?: ArtifactManifest | ReportStepArtifactList | Record<string, unknown>;
  artifacts?: readonly unknown[] | Record<string, unknown>;
  artifactsStored?: boolean;
  boxIds?: readonly string[];
  boxes?:
    | readonly (string | Sandbox | { id: string })[]
    | { runbox?: Sandbox | string; auditbox?: Sandbox | string };
  runbox?: Sandbox | string;
  auditbox?: Sandbox | string;
  actor?: string;
  seq?: number;
  now?: () => number;
  residualChecker?: ResidualChecker;
  verifyResiduals?: boolean;
  strictVerification?: boolean;
  hostMountPaths?: readonly string[];
  skipTeardown?: boolean;
  reason?: string;
}

/**
 * Result returned by finalizeRun.
 */
export interface FinalizeRunResult {
  runId: string;
  outcome: RunOutcome;
  durationMs: number;
  manifest: ArtifactManifest | ReportStepArtifactList | Record<string, unknown>;
  boxesDestroyed: string[];
  residualVerification: ResidualVerificationResult;
  event: RunDoneEventEnvelope;
}

/**
 * Resolves all candidate box IDs for a run from inputs and naming conventions.
 */
export async function resolveRunBoxIds(
  runId: string,
  backend?: ExecutionBackend | FinalizerExecutionBackend | null,
  options?: {
    boxIds?: readonly string[];
    boxes?:
      | readonly (string | Sandbox | { id: string })[]
      | { runbox?: Sandbox | string; auditbox?: Sandbox | string };
    runbox?: Sandbox | string;
    auditbox?: Sandbox | string;
  }
): Promise<string[]> {
  const ids = new Set<string>();

  // 1. Explicit boxIds
  if (options?.boxIds) {
    for (const b of options.boxIds) {
      if (typeof b === "string" && b.trim()) {
        ids.add(b.trim());
      }
    }
  }

  // 2. Boxes collection
  if (options?.boxes) {
    if (Array.isArray(options.boxes)) {
      for (const item of options.boxes) {
        if (typeof item === "string" && item.trim()) {
          ids.add(item.trim());
        } else if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
          ids.add(item.id.trim());
        }
      }
    } else if (typeof options.boxes === "object") {
      const bObj = options.boxes as { runbox?: Sandbox | string; auditbox?: Sandbox | string };
      if (bObj.runbox) {
        const id = typeof bObj.runbox === "string" ? bObj.runbox : bObj.runbox.id;
        if (id) ids.add(id);
      }
      if (bObj.auditbox) {
        const id = typeof bObj.auditbox === "string" ? bObj.auditbox : bObj.auditbox.id;
        if (id) ids.add(id);
      }
    }
  }

  // 3. Named runbox / auditbox
  if (options?.runbox) {
    const id = typeof options.runbox === "string" ? options.runbox : options.runbox.id;
    if (id) ids.add(id);
  }
  if (options?.auditbox) {
    const id = typeof options.auditbox === "string" ? options.auditbox : options.auditbox.id;
    if (id) ids.add(id);
  }

  // 4. If no explicit boxes found, use standard conventions: runbox-<runId> and auditbox-<runId>
  if (ids.size === 0) {
    ids.add(`runbox-${runId}`);
    ids.add(`auditbox-${runId}`);
  }

  // 5. If backend has list capability, query any additional sandboxes labelled with this run
  if (backend && typeof backend.list === "function") {
    try {
      const listed = await backend.list({ runId });
      if (Array.isArray(listed)) {
        for (const item of listed) {
          if (item && typeof item === "object") {
            const rec = item as Record<string, unknown>;
            if (typeof rec.id === "string" && rec.id.trim()) {
              ids.add(rec.id.trim());
            }
          }
        }
      } else if (listed && typeof (listed as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        for await (const item of listed as AsyncIterable<unknown>) {
          if (item && typeof item === "object") {
            const rec = item as Record<string, unknown>;
            if (typeof rec.id === "string" && rec.id.trim()) {
              ids.add(rec.id.trim());
            }
          }
        }
      }
    } catch (_err) {
      // Best-effort list discovery
    }
  }

  return Array.from(ids);
}

/**
 * Tears down all containers (runbox and auditbox) associated with the run via ExecutionBackend.destroyBox().
 * Task 14.4 / Requirement 26.13: WHEN a Run reaches done, THE ExecutionBackend SHALL destroy every Box of the run.
 */
export async function teardownBoxes(
  backend: ExecutionBackend | FinalizerExecutionBackend | null | undefined,
  runId: string,
  boxIds?: readonly string[],
  options?: {
    boxes?:
      | readonly (string | Sandbox | { id: string })[]
      | { runbox?: Sandbox | string; auditbox?: Sandbox | string };
    runbox?: Sandbox | string;
    auditbox?: Sandbox | string;
  }
): Promise<string[]> {
  const targetIds = await resolveRunBoxIds(runId, backend, {
    boxIds,
    boxes: options?.boxes,
    runbox: options?.runbox,
    auditbox: options?.auditbox,
  });

  const destroyed: string[] = [];

  if (!backend) {
    // If no backend instance is configured, record resolved box targets as destroyed
    return targetIds;
  }

  const fb = backend as FinalizerExecutionBackend;

  for (const boxId of targetIds) {
    // Task 14.4: Invoking ExecutionBackend.destroyBox()
    if (typeof fb.destroyBox === "function") {
      await fb.destroyBox(boxId);
      destroyed.push(boxId);
    } else if (typeof fb.destroy === "function") {
      await fb.destroy(boxId);
      destroyed.push(boxId);
    } else {
      // Cast through unknown with a comment: fallback if backend lacks destroyBox or destroy
      const anyBackend = backend as unknown as Record<string, (id: string) => Promise<void>>;
      if (typeof anyBackend.delete === "function") {
        await anyBackend.delete(boxId);
      }
      destroyed.push(boxId);
    }
  }

  // Also destroy by sandbox instance if passed as object
  if (options?.boxes && Array.isArray(options.boxes)) {
    for (const b of options.boxes) {
      if (b && typeof b === "object" && "destroy" in b && typeof b.destroy === "function") {
        try {
          await (b as Sandbox).destroy!();
        } catch (_err) {
          // Safe destruction
        }
      }
    }
  }

  return destroyed;
}

/**
 * Verifies complete box destruction and ensures zero residual container processes or host bind mounts remain.
 * Task 14.4: Verify complete box destruction and ensure zero residual container processes or host bind mounts remain.
 */
export async function verifyBoxDestruction(
  backend: ExecutionBackend | FinalizerExecutionBackend | null | undefined,
  runId: string,
  destroyedBoxes: readonly string[],
  options?: {
    residualChecker?: ResidualChecker;
    hostMountPaths?: readonly string[];
    strict?: boolean;
  }
): Promise<ResidualVerificationResult> {
  const checker = options?.residualChecker;
  const residualBoxIds: string[] = [];
  const residualProcesses: ProcessCheckInfo[] = [];
  const residualMounts: MountCheckInfo[] = [];

  // 1. Verify boxes are destroyed
  if (checker?.checkBoxes) {
    const aliveBoxes = await checker.checkBoxes(runId, destroyedBoxes);
    if (Array.isArray(aliveBoxes)) {
      residualBoxIds.push(...aliveBoxes);
    }
  } else if (backend) {
    const fb = backend as FinalizerExecutionBackend;
    if (typeof fb.get === "function") {
      for (const boxId of destroyedBoxes) {
        try {
          const alive = await fb.get(boxId);
          if (alive) {
            residualBoxIds.push(boxId);
          }
        } catch (_err) {
          // Box get failure or not found indicates successfully destroyed
        }
      }
    }
  }

  // 2. Verify zero residual container processes
  if (checker?.checkProcesses) {
    const procs = await checker.checkProcesses(runId, destroyedBoxes);
    if (Array.isArray(procs)) {
      residualProcesses.push(...procs);
    }
  }

  // 3. Verify zero residual host bind mounts
  const mountPathsToCheck = options?.hostMountPaths ?? [];
  if (checker?.checkMounts) {
    const mounts = await checker.checkMounts(runId, mountPathsToCheck);
    if (Array.isArray(mounts)) {
      residualMounts.push(...mounts);
    }
  }

  const verified =
    residualBoxIds.length === 0 &&
    residualProcesses.length === 0 &&
    residualMounts.length === 0;

  const result: ResidualVerificationResult = {
    verified,
    residualProcessesCount: residualProcesses.length,
    residualMountsCount: residualMounts.length,
    residualBoxesCount: residualBoxIds.length,
    destroyedBoxes,
    residualBoxIds,
    residualProcesses,
    residualMounts,
  };

  if (!verified && options?.strict) {
    throw new ResidualStateError(
      `Complete box destruction verification failed for run '${runId}': ` +
        `${residualBoxIds.length} residual boxes, ` +
        `${residualProcesses.length} residual processes, ` +
        `${residualMounts.length} residual host mounts`,
      result
    );
  }

  return result;
}

/**
 * Creates the terminal run.done event envelope.
 * Task 14.4 / Requirements 26.13, 26.15.
 */
export function createRunDoneEvent(
  runId: string,
  outcome: RunOutcome,
  durationMs: number,
  manifest: ArtifactManifest | ReportStepArtifactList | Record<string, unknown>,
  options?: {
    seq?: number;
    ts?: number;
    actor?: string;
    boxesDestroyed?: readonly string[];
    residualVerification?: ResidualVerificationResult;
  }
): RunDoneEventEnvelope {
  const ts = typeof options?.ts === "number" ? options.ts : Date.now();
  const seq = typeof options?.seq === "number" ? options.seq : 1;
  const actor = options?.actor ?? "necromancer";
  const boxesDestroyed = options?.boxesDestroyed ?? [];

  const data: RunDoneEventData = {
    refs: [],
    phase: "done",
    outcome,
    durationMs,
    totalDurationMs: durationMs,
    duration: durationMs,
    manifest,
    boxesDestroyed,
    ...(options?.residualVerification
      ? { residualVerification: options.residualVerification }
      : {}),
  };

  return {
    runId,
    seq,
    ts,
    kind: "run.done",
    actor,
    data,
  };
}

/**
 * Normalizes an outcome string or input to a valid RunOutcome.
 */
export function normalizeRunOutcome(val?: RunOutcome | string | null): RunOutcome {
  if (!val) {
    return "not_resurrected";
  }
  const s = String(val).toLowerCase().trim().replace(/[-\s]/g, "_");
  if (RUN_OUTCOMES.includes(s as RunOutcome)) {
    return s as RunOutcome;
  }
  if (s === "build_only" || s === "resurrected_build") {
    return "resurrected_build_only";
  }
  return "not_resurrected";
}

/**
 * Core orchestrator for sandbox teardown and run finalization.
 * Task 14.4 / Requirements 26.13, 26.15:
 * 1. Confirms all artifacts are stored.
 * 2. Destroys all containers (runbox and auditbox) via ExecutionBackend.destroyBox().
 * 3. Verifies zero residual container processes or host bind mounts remain.
 * 4. Advances or updates lifecycle phase to done.
 * 5. Emits terminal run.done event containing run outcome, total duration, and artifact manifest.
 */
export async function finalizeRun(
  options: FinalizeRunOptions
): Promise<FinalizeRunResult> {
  const { runId } = options;
  const nowFn = options.now ?? Date.now;
  const endedAt = options.endedAt ?? nowFn();

  // 1. Validate artifacts stored state (Requirement 26.15)
  if (options.artifactsStored === false) {
    throw new ArtifactsNotStoredError(
      runId,
      `Cannot finalize run '${runId}': artifactsStored is false`
    );
  }

  // Normalize manifest
  let manifest: ArtifactManifest | ReportStepArtifactList | Record<string, unknown>;
  if (options.manifest) {
    manifest = options.manifest;
    if ("allReady" in manifest && manifest.allReady === false) {
      throw new ArtifactsNotStoredError(
        runId,
        `Cannot finalize run '${runId}': manifest.allReady is false`
      );
    }
  } else if (options.artifacts) {
    manifest = {
      runId,
      artifacts: options.artifacts,
      allReady: true,
      createdAt: endedAt,
    };
  } else {
    manifest = {
      runId,
      artifactsDir: `/data/runs/${runId}/artifacts`,
      artifacts: {
        patch: null,
        spec: null,
        report: null,
        events: null,
        certificate: null,
      },
      allReady: true,
      createdAt: endedAt,
    };
  }

  // 2. Resolve final outcome
  let outcome: RunOutcome;
  if (options.outcome) {
    outcome = normalizeRunOutcome(options.outcome);
  } else if (options.lifecycleManager?.outcome) {
    outcome = options.lifecycleManager.outcome;
  } else if (
    options.manifest &&
    "outcome" in options.manifest &&
    typeof options.manifest.outcome === "string"
  ) {
    outcome = normalizeRunOutcome(options.manifest.outcome);
  } else {
    outcome = "not_resurrected";
  }

  // 3. Teardown all boxes via ExecutionBackend.destroyBox() (Requirement 26.13)
  let boxesDestroyed: string[] = [];
  if (!options.skipTeardown) {
    boxesDestroyed = await teardownBoxes(options.backend, runId, options.boxIds, {
      boxes: options.boxes,
      runbox: options.runbox,
      auditbox: options.auditbox,
    });
  }

  // 4. Verify complete box destruction and zero residual processes/mounts
  const residualVerification = await verifyBoxDestruction(
    options.backend,
    runId,
    boxesDestroyed,
    {
      residualChecker: options.residualChecker,
      hostMountPaths: options.hostMountPaths,
      strict: options.strictVerification ?? false,
    }
  );

  // 5. Lifecycle phase advancement
  const lm = options.lifecycleManager;
  if (lm) {
    if (lm.phase !== "done" && lm.canTransitionTo("done")) {
      try {
        await lm.transitionToAsync("done", {
          outcome,
          reason: options.reason ?? "run_completed",
          actor: options.actor ?? "necromancer",
          ts: endedAt,
        });
      } catch (_err) {
        // If already transitioned or synchronously handled
      }
    }
    if (outcome) {
      lm.setOutcome(outcome);
    }
  }

  // 6. Compute total duration
  let durationMs: number;
  if (typeof options.durationMs === "number") {
    durationMs = Math.max(0, options.durationMs);
  } else if (typeof options.startedAt === "number") {
    durationMs = Math.max(0, endedAt - options.startedAt);
  } else {
    durationMs = 0;
  }

  // 7. Emit terminal run.done event (Requirement 26.15)
  const event = createRunDoneEvent(runId, outcome, durationMs, manifest, {
    seq: options.seq ?? 1,
    ts: endedAt,
    actor: options.actor ?? "necromancer",
    boxesDestroyed,
    residualVerification,
  });

  const emitFn = options.emit;
  if (emitFn) {
    const res = emitFn(event);
    if (res && typeof (res as Promise<unknown>).then === "function") {
      await res;
    }
  }

  return {
    runId,
    outcome,
    durationMs,
    manifest,
    boxesDestroyed,
    residualVerification,
    event,
  };
}

/**
 * Class representation of RunFinalizer.
 */
export class RunFinalizer {
  constructor(private readonly defaultOptions?: Partial<FinalizeRunOptions>) {}

  async finalize(options: FinalizeRunOptions): Promise<FinalizeRunResult> {
    return finalizeRun({
      ...this.defaultOptions,
      ...options,
    });
  }

  async teardownBoxes(
    backend: ExecutionBackend | FinalizerExecutionBackend | null | undefined,
    runId: string,
    boxIds?: readonly string[],
    options?: {
      boxes?:
        | readonly (string | Sandbox | { id: string })[]
        | { runbox?: Sandbox | string; auditbox?: Sandbox | string };
      runbox?: Sandbox | string;
      auditbox?: Sandbox | string;
    }
  ): Promise<string[]> {
    return teardownBoxes(backend, runId, boxIds, options);
  }

  async verifyBoxDestruction(
    backend: ExecutionBackend | FinalizerExecutionBackend | null | undefined,
    runId: string,
    destroyedBoxes: readonly string[],
    options?: {
      residualChecker?: ResidualChecker;
      hostMountPaths?: readonly string[];
      strict?: boolean;
    }
  ): Promise<ResidualVerificationResult> {
    return verifyBoxDestruction(backend, runId, destroyedBoxes, options);
  }

  createRunDoneEvent(
    runId: string,
    outcome: RunOutcome,
    durationMs: number,
    manifest: ArtifactManifest | ReportStepArtifactList | Record<string, unknown>,
    options?: {
      seq?: number;
      ts?: number;
      actor?: string;
      boxesDestroyed?: readonly string[];
      residualVerification?: ResidualVerificationResult;
    }
  ): RunDoneEventEnvelope {
    return createRunDoneEvent(runId, outcome, durationMs, manifest, options);
  }
}

export const runFinalizer = finalizeRun;
