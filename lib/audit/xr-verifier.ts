// WP-29 Task 29.3: Extension item verifiers XR-01, XR-02 and XR-03.
//
// Each verifier is a pure, data-in function returning a structured result so it can be
// driven by the offline runner, the CLI and the test-suite alike:
//   - XR-01: every Box/sandbox of a finished run is destroyed and no residual
//            worktree/sandbox state carries over to subsequent runs.
//   - XR-02: the Kill Switch operates correctly across all three design levels
//            (`pause_new_runs`, `stop_gracefully`, `hard_kill`).
//   - XR-03: pushes to any non-fork repository and any write targeting the source
//            repository are deterministically refused.

import type { KillSwitchLevel } from "../admin/kill-switch";
import { KILL_SWITCH_LEVELS } from "../admin/kill-switch";

export type XRItemId = "XR-01" | "XR-02" | "XR-03";

export interface XRVerdict {
  id: XRItemId;
  ok: boolean;
  summary: string;
  failures: string[];
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// XR-01 — Box/sandbox teardown
// ---------------------------------------------------------------------------------------------

export interface XRSandboxObservation {
  runId: string;
  sandboxId: string;
  /** True only once the Box/sandbox backing this run has been destroyed. */
  destroyed: boolean;
}

export interface XR01Input {
  sandboxes: readonly XRSandboxObservation[];
  /** Worktree paths still present after the run finished (must be empty). */
  residualWorktrees?: readonly string[];
  /** Sandbox ids still alive after the run finished (must be empty). */
  residualSandboxes?: readonly string[];
}

export function verifyXR01(input: XR01Input): XRVerdict {
  const failures: string[] = [];
  const sandboxes = Array.isArray(input?.sandboxes) ? input.sandboxes : [];
  const residualWorktrees = Array.isArray(input?.residualWorktrees)
    ? input.residualWorktrees
    : [];
  const residualSandboxes = Array.isArray(input?.residualSandboxes)
    ? input.residualSandboxes
    : [];

  for (const sandbox of sandboxes) {
    if (!sandbox || typeof sandbox.sandboxId !== "string" || sandbox.sandboxId.length === 0) {
      failures.push("Encountered a sandbox observation without a sandbox id.");
      continue;
    }
    if (!sandbox.destroyed) {
      failures.push(
        `Sandbox '${sandbox.sandboxId}' of run '${sandbox.runId}' was not destroyed.`
      );
    }
  }

  for (const worktree of residualWorktrees) {
    failures.push(`Residual worktree state carried over: ${worktree}`);
  }
  for (const sandboxId of residualSandboxes) {
    failures.push(`Residual sandbox state carried over: ${sandboxId}`);
  }

  const ok = failures.length === 0;
  return {
    id: "XR-01",
    ok,
    summary: ok
      ? `All ${sandboxes.length} sandbox(es) destroyed with zero residual state.`
      : `XR-01 failed: ${failures.length} teardown problem(s) detected.`,
    failures,
    details: {
      sandboxCount: sandboxes.length,
      residualWorktreeCount: residualWorktrees.length,
      residualSandboxCount: residualSandboxes.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// XR-02 — Kill switch across all three design levels
// ---------------------------------------------------------------------------------------------

export interface XR02LevelObservation {
  level: KillSwitchLevel;
  /** True when the level actually executed (not just previewed). */
  executed: boolean;
  /** New-run admission halted. */
  pausedNewRuns: boolean;
  /** Graceful stop requested on running runs. */
  stoppingGracefully: boolean;
  /** Number of runs the level reported as affected. */
  affectedCount: number;
  /** Number of affected runs actually killed (hard kill). */
  killedCount: number;
  /** Queue preserved for `pause_new_runs`. */
  queuedPreserved: boolean;
}

export interface XR02Input {
  observations: readonly XR02LevelObservation[];
}

export function verifyXR02(input: XR02Input): XRVerdict {
  const failures: string[] = [];
  const observations = Array.isArray(input?.observations) ? input.observations : [];

  const byLevel = new Map<KillSwitchLevel, XR02LevelObservation>();
  for (const observation of observations) {
    if (!observation || !KILL_SWITCH_LEVELS.includes(observation.level)) {
      continue;
    }
    byLevel.set(observation.level, observation);
  }

  for (const level of KILL_SWITCH_LEVELS) {
    const observation = byLevel.get(level);
    if (!observation) {
      failures.push(`Kill-switch level '${level}' was not exercised.`);
      continue;
    }
    if (!observation.executed) {
      failures.push(`Kill-switch level '${level}' was only previewed, not executed.`);
      continue;
    }

    switch (level) {
      case "pause_new_runs":
        if (!observation.pausedNewRuns) {
          failures.push("pause_new_runs did not halt new-run admission.");
        }
        if (!observation.queuedPreserved) {
          failures.push("pause_new_runs did not preserve the existing queue.");
        }
        break;
      case "stop_gracefully":
        if (!observation.stoppingGracefully) {
          failures.push("stop_gracefully did not request a graceful stop.");
        }
        if (!observation.pausedNewRuns) {
          failures.push("stop_gracefully did not halt new-run admission.");
        }
        break;
      case "hard_kill":
        if (!observation.pausedNewRuns) {
          failures.push("hard_kill did not halt new-run admission.");
        }
        if (observation.killedCount !== observation.affectedCount) {
          failures.push(
            `hard_kill killed ${observation.killedCount} of ${observation.affectedCount} affected run(s).`
          );
        }
        break;
      default:
        break;
    }
  }

  const ok = failures.length === 0;
  return {
    id: "XR-02",
    ok,
    summary: ok
      ? `Kill switch verified across all ${KILL_SWITCH_LEVELS.length} levels.`
      : `XR-02 failed: ${failures.length} kill-switch problem(s) detected.`,
    failures,
    details: {
      levelsExercised: Array.from(byLevel.keys()),
      requiredLevels: [...KILL_SWITCH_LEVELS],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// XR-03 — Non-fork push / source write refusal
// ---------------------------------------------------------------------------------------------

export interface XR03Attempt {
  kind: "push" | "write";
  /** Target repository URL (push) or path (write). */
  target: string;
  /** True when the push target is the Owner's fork. */
  isFork: boolean;
  /** True when the write targets the source repository. */
  isSource: boolean;
  /** True when the operation was deterministically refused. */
  refused: boolean;
  /** Optional structured refusal code. */
  code?: string;
}

export interface XR03Input {
  attempts: readonly XR03Attempt[];
}

export function verifyXR03(input: XR03Input): XRVerdict {
  const failures: string[] = [];
  const attempts = Array.isArray(input?.attempts) ? input.attempts : [];

  let nonForkPushSeen = 0;
  let sourceWriteSeen = 0;

  for (const attempt of attempts) {
    if (!attempt || typeof attempt.target !== "string") {
      continue;
    }
    if (attempt.kind === "push" && !attempt.isFork) {
      nonForkPushSeen += 1;
      if (!attempt.refused) {
        failures.push(`Push to non-fork repository was not refused: ${attempt.target}`);
      }
    }
    if (attempt.kind === "write" && attempt.isSource) {
      sourceWriteSeen += 1;
      if (!attempt.refused) {
        failures.push(`Write targeting the source repository was not refused: ${attempt.target}`);
      }
    }
  }

  // Coverage: the verifier must actually observe both refusal categories, otherwise a
  // vacuously-empty input would wrongly pass.
  if (nonForkPushSeen === 0) {
    failures.push("No non-fork push attempt was observed, so refusal cannot be verified.");
  }
  if (sourceWriteSeen === 0) {
    failures.push("No source-repository write attempt was observed, so refusal cannot be verified.");
  }

  const ok = failures.length === 0;
  return {
    id: "XR-03",
    ok,
    summary: ok
      ? `All ${nonForkPushSeen} non-fork push(es) and ${sourceWriteSeen} source write(s) refused.`
      : `XR-03 failed: ${failures.length} refusal problem(s) detected.`,
    failures,
    details: {
      nonForkPushSeen,
      sourceWriteSeen,
      attemptCount: attempts.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Combined runner
// ---------------------------------------------------------------------------------------------

export interface XRVerificationInput {
  xr01: XR01Input;
  xr02: XR02Input;
  xr03: XR03Input;
}

export interface XRVerificationResult {
  ok: boolean;
  verdicts: XRVerdict[];
}

/** Runs all three extension verifiers and aggregates their verdicts. */
export function runXRVerifiers(input: XRVerificationInput): XRVerificationResult {
  const verdicts = [
    verifyXR01(input.xr01),
    verifyXR02(input.xr02),
    verifyXR03(input.xr03),
  ];
  return { ok: verdicts.every((verdict) => verdict.ok), verdicts };
}