// Task 12.4 & 12.5: Pact review, approval, parking, resume lifecycle, and mutating service
// Requirements: 12.14, 12.16, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11, 36.14

import type { RunStore, RunRecord } from "../runs/run-store";
import type { EventStore, EventEnvelope } from "../events/event-store";
import type { RunPhase } from "../events/types";
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
  type NonRemovableRequirement,
} from "./pact-review";
import {
  executePactMutation,
  executePactEdit,
  executePactApprove,
  executePactRevise,
  executePactStop,
  extractPactState,
  extractCallerCredentials,
  checkRunAuthorization,
  checkPhaseConstraints,
  inferPactAction,
  type PactAction,
  type PactMutationPayload,
  type PactMutationResult,
  type ExtractedPactState,
  type AuthCheckResult,
} from "./pact-mutation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PACT_IDLE_LIMIT_MS = 30 * 60 * 1000; // 30 minutes (Requirement 13.6)

export interface DeathCertificateFailure {
  ruleId?: string;
  id?: string;
  file?: string;
  line?: number;
  description?: string;
  message?: string;
  stage?: string;
}

export interface DeathCertificateLike {
  failures?: DeathCertificateFailure[];
  certificateHash?: string;
  [key: string]: unknown;
}

export interface CoverageVerificationResult {
  ok: boolean;
  coveredFailures: DeathCertificateFailure[];
  uncoveredFailures: DeathCertificateFailure[];
}

export interface SkeletonRaiseGuardResult {
  allowed: boolean;
  reason?: string;
}

export interface ParkRunResult {
  ok: boolean;
  parked: boolean;
  pactPreserved: boolean;
  runboxReleased: boolean;
  reason?: string;
}

export interface ResumeRunResult {
  ok: boolean;
  resumed: boolean;
  requiresReclone: boolean;
  pactPreserved: boolean;
  phase: RunPhase;
}

export interface PactServiceOptions {
  runStore: RunStore;
  eventStore: EventStore;
  pactIdleLimitMs?: number;
}

// ---------------------------------------------------------------------------
// PactService Implementation
// ---------------------------------------------------------------------------

export class PactService {
  public readonly runStore: RunStore;
  public readonly eventStore: EventStore;
  public readonly pactIdleLimitMs: number;

  constructor(options: PactServiceOptions) {
    this.runStore = options.runStore;
    this.eventStore = options.eventStore;
    this.pactIdleLimitMs = options.pactIdleLimitMs ?? DEFAULT_PACT_IDLE_LIMIT_MS;
  }

  /**
   * Extract extracted Pact state (latest version, history, current tasks)
   */
  public getState(runId: string): ExtractedPactState {
    return extractPactState(runId, this.eventStore);
  }

  /**
   * Process a mutating action (edit, approve, revise, stop)
   */
  public handleMutation(
    runId: string,
    payload: unknown,
    requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>
  ): PactMutationResult {
    return executePactMutation(
      runId,
      payload,
      this.runStore,
      this.eventStore,
      requestOrHeaders
    );
  }

  /**
   * Process edit action
   */
  public edit(
    runId: string,
    payload: PactMutationPayload,
    requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>
  ): PactMutationResult {
    return this.handleMutation(
      runId,
      { ...payload, action: "edit" },
      requestOrHeaders
    );
  }

  /**
   * Process approve action
   */
  public approve(
    runId: string,
    payload: PactMutationPayload,
    requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>
  ): PactMutationResult {
    return this.handleMutation(
      runId,
      { ...payload, action: "approve" },
      requestOrHeaders
    );
  }

  /**
   * Process revise action
   */
  public revise(
    runId: string,
    payload: PactMutationPayload,
    requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>
  ): PactMutationResult {
    return this.handleMutation(
      runId,
      { ...payload, action: "revise" },
      requestOrHeaders
    );
  }

  /**
   * Process stop action
   */
  public stop(
    runId: string,
    payload?: PactMutationPayload,
    requestOrHeaders?: Request | Headers | Record<string, string | string[] | undefined>
  ): PactMutationResult {
    return this.handleMutation(
      runId,
      { ...(payload ?? {}), action: "stop" },
      requestOrHeaders
    );
  }

  /**
   * Check if run is idle in pact_review past the Pact idle limit
   * Requirement 13.6
   */
  public checkIdle(runId: string, now = Date.now()): { idle: boolean; elapsedMs: number } {
    const run = this.runStore.getRun(runId);
    if (!run || run.phase !== "pact_review") {
      return { idle: false, elapsedMs: 0 };
    }

    const events = this.eventStore.getEvents(runId, {
      kinds: ["run.phase", "pact.drafted", "pact.edited", "pact.revision"],
    });

    let lastActivityTs = run.updatedAt || run.createdAt;
    for (const ev of events) {
      if (ev.ts > lastActivityTs) {
        lastActivityTs = ev.ts;
      }
    }

    const elapsedMs = Math.max(0, now - lastActivityTs);
    return {
      idle: elapsedMs >= this.pactIdleLimitMs,
      elapsedMs,
    };
  }

  /**
   * Park run exceeding Pact idle limit: preserve Pact, release Runbox
   * Requirement 13.6
   */
  public parkRun(runId: string, reason = "pact_review_idle_timeout"): ParkRunResult {
    const run = this.runStore.getRun(runId);
    if (!run) {
      return {
        ok: false,
        parked: false,
        pactPreserved: false,
        runboxReleased: false,
        reason: "Run not found",
      };
    }

    // Capture latest Pact state to verify it is preserved
    const pactState = this.getState(runId);

    // Release Runbox (clear sandboxId and release container)
    this.runStore.updateRun(runId, {
      sandboxId: null,
      metadata: {
        ...(run.metadata ?? {}),
        isParked: true,
        parkedAt: Date.now(),
        parkReason: reason,
        parkedPactVersion: pactState.latestVersion,
      },
    });

    // Pause clock if not already paused
    this.eventStore.append({
      runId,
      kind: "run.clock",
      actor: "necromancer",
      data: { action: "pause", phase: run.phase, reason: "run_parked", refs: [] },
    });

    // Emit run.parked / necromancer decision
    this.eventStore.append({
      runId,
      kind: "necromancer.decision",
      actor: "necromancer",
      data: {
        action: "park_run",
        reason,
        pactVersion: pactState.latestVersion,
        runboxReleased: true,
        refs: [],
      },
    });

    return {
      ok: true,
      parked: true,
      pactPreserved: pactState.hasPact,
      runboxReleased: true,
    };
  }

  /**
   * Resume parked run: re-queue run with same Pact and flag re-clone
   * Requirement 13.7
   */
  public resumeRun(runId: string): ResumeRunResult {
    const run = this.runStore.getRun(runId);
    if (!run) {
      return {
        ok: false,
        resumed: false,
        requiresReclone: false,
        pactPreserved: false,
        phase: "queued",
      };
    }

    const pactState = this.getState(runId);

    // Re-queue the run with the same Pact, flag re-clone
    this.runStore.updateRun(runId, {
      phase: "queued",
      metadata: {
        ...(run.metadata ?? {}),
        isParked: false,
        resumedAt: Date.now(),
        requiresReclone: true,
      },
    });

    this.eventStore.append({
      runId,
      kind: "run.phase",
      actor: "necromancer",
      data: { from: run.phase, to: "queued", reason: "resume_parked", refs: [] },
    });

    this.eventStore.append({
      runId,
      kind: "run.queued",
      actor: "user",
      data: {
        runId,
        requeued: true,
        reclone: true,
        pactVersion: pactState.latestVersion,
        refs: [],
      },
    });

    return {
      ok: true,
      resumed: true,
      requiresReclone: true,
      pactPreserved: pactState.hasPact,
      phase: "queued",
    };
  }

  /**
   * Verify whether a Skeleton can be raised according to approval gates
   * Requirements 13.8, 13.9, 13.10
   */
  public canRaiseSkeleton(
    runId: string,
    role: string,
    options?: { taskId?: string; isRevision?: boolean }
  ): SkeletonRaiseGuardResult {
    const normalizedRole = role.toLowerCase().trim();

    // Roles Bonesetter, Soul-stitcher, Warden, Scribe: require pact.approved (Requirement 13.8)
    if (
      normalizedRole === "bonesetter" ||
      normalizedRole === "soul-stitcher" ||
      normalizedRole === "warden" ||
      normalizedRole === "scribe"
    ) {
      const approvalEvents = this.eventStore.getEvents(runId, {
        kinds: ["pact.approved"],
      });
      if (approvalEvents.length === 0) {
        return {
          allowed: false,
          reason: `Skeleton role '${role}' cannot be raised before pact.approved event is emitted (Requirement 13.8)`,
        };
      }

      // Check revision approval during legion (Requirement 13.10)
      if (options?.isRevision) {
        const lastApproval = approvalEvents[approvalEvents.length - 1];
        const revisionEvents = this.eventStore.getEvents(runId, {
          kinds: ["pact.revision"],
        });
        if (revisionEvents.length > 0) {
          const lastRevision = revisionEvents[revisionEvents.length - 1];
          const isAfterApproval =
            lastRevision.seq !== undefined && lastApproval.seq !== undefined
              ? lastRevision.seq > lastApproval.seq
              : lastRevision.ts >= lastApproval.ts;
          if (isAfterApproval) {
            return {
              allowed: false,
              reason: `Revision drafted during legion requires user approval before raising Skeleton (Requirement 13.10)`,
            };
          }
        }
      }

      return { allowed: true };
    }

    // Role Exhumer: requires run.started before pact approval (Requirement 13.9)
    if (normalizedRole === "exhumer") {
      const startEvents = this.eventStore.getEvents(runId, {
        kinds: ["run.started"],
      });
      if (startEvents.length === 0) {
        return {
          allowed: false,
          reason: `Exhumer cannot be raised before run.started event (Requirement 13.9)`,
        };
      }
      return { allowed: true };
    }

    // Role Planner: requires exhume.certificate before pact approval (Requirement 13.9)
    if (normalizedRole === "planner") {
      const certEvents = this.eventStore.getEvents(runId, {
        kinds: ["exhume.certificate"],
      });
      if (certEvents.length === 0) {
        return {
          allowed: false,
          reason: `Planner cannot be raised before exhume.certificate event (Requirement 13.9)`,
        };
      }
      return { allowed: true };
    }

    return { allowed: true };
  }

  /**
   * Verify failure coverage mapping every failure to at least one task
   * Requirements 12.14, 12.16
   */
  public verifyFailureCoverage(
    tasks: PactTask[],
    deathCertificate?: DeathCertificateLike | null
  ): CoverageVerificationResult {
    const failures = deathCertificate?.failures ?? [];
    if (failures.length === 0) {
      return { ok: true, coveredFailures: [], uncoveredFailures: [] };
    }

    const coveredFailures: DeathCertificateFailure[] = [];
    const uncoveredFailures: DeathCertificateFailure[] = [];

    for (const failure of failures) {
      let covered = false;

      for (const task of tasks) {
        // Match by rule ID (e.g. M1, M2)
        if (
          failure.ruleId &&
          (task.rules?.includes(failure.ruleId as any) ||
            task.ruleIds?.includes(failure.ruleId as any))
        ) {
          covered = true;
          break;
        }

        // Match by file name/path
        if (failure.file) {
          const normFailFile = failure.file.toLowerCase();
          const matchesFile = (task.files ?? task.filesInScope ?? []).some((f) =>
            normFailFile.includes(f.toLowerCase()) || f.toLowerCase().includes(normFailFile)
          );
          if (matchesFile) {
            covered = true;
            break;
          }
        }

        // Match by failure description / stage in title
        if (failure.stage && task.title.toLowerCase().includes(failure.stage.toLowerCase())) {
          covered = true;
          break;
        }
      }

      if (covered) {
        coveredFailures.push(failure);
      } else {
        uncoveredFailures.push(failure);
      }
    }

    return {
      ok: uncoveredFailures.length === 0,
      coveredFailures,
      uncoveredFailures,
    };
  }

  /**
   * Retain non-removable requirements check (Requirement 13.5)
   */
  public verifyNonRemovableRequirements(tasks: PactTask[]): {
    ok: boolean;
    missing: NonRemovableRequirement[];
  } {
    const missing: NonRemovableRequirement[] = [];

    for (const req of NON_REMOVABLE_REQUIREMENTS) {
      let found = false;
      for (const t of tasks) {
        const titleLower = t.title.toLowerCase();
        if (
          req === "warden_final_check" &&
          (titleLower.includes("warden") || titleLower.includes("final check"))
        ) {
          found = true;
          break;
        }
        if (
          req === "scribe_report" &&
          (titleLower.includes("scribe") || titleLower.includes("report"))
        ) {
          found = true;
          break;
        }
        if (
          req === "grimoire_gate" &&
          (titleLower.includes("grimoire") || titleLower.includes("gate") || titleLower.includes("syntax"))
        ) {
          found = true;
          break;
        }
      }
      if (!found) {
        missing.push(req);
      }
    }

    return {
      ok: missing.length === 0,
      missing,
    };
  }
}
