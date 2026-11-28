// One place that knows which URL a run lives at for each phase, and which
// stages of the journey a run has actually reached. Navigation (CryptNav, the
// /runs/[runId] entry page, in-page CTAs) asks this module instead of building
// paths by hand.

export type RunStage = "pact" | "legion" | "relic";

const enc = encodeURIComponent;

export const routes = {
  gate: () => "/",
  history: () => "/history",
  builtWithKiro: () => "/built-with-kiro",
  admin: () => "/admin",
  tomb: (owner: string, repo: string) => `/tomb/${enc(owner)}/${enc(repo)}`,
  run: (runId: string) => `/runs/${enc(runId)}`,
  pact: (runId: string) => `/runs/${enc(runId)}/pact`,
  legion: (runId: string) => `/runs/${enc(runId)}/legion`,
  relic: (runId: string) => `/runs/${enc(runId)}/relic`,
  replay: (runId: string) => `/replay/${enc(runId)}`,
  eventLog: (runId: string) => `/api/runs/${enc(runId)}/events?from=1`,
} as const;

export function stageHref(runId: string, stage: RunStage): string {
  return routes[stage](runId);
}

/**
 * The screen a run belongs on right now.
 *
 * Queue, exhume and planning are shown by the Legion screen (waiting room and
 * the Exhumer card); Pact review needs the user on the Pact screen; a finished
 * run is read in the Reliquary.
 */
export function stageForPhase(phase: string | null | undefined): RunStage {
  switch (phase) {
    case "pact_review":
      return "pact";
    case "done":
      return "relic";
    default:
      return "legion";
  }
}

export function hrefForRun(
  runId: string,
  phase: string | null | undefined
): string {
  return stageHref(runId, stageForPhase(phase));
}

const PHASE_ORDER: readonly string[] = [
  "queued",
  "exhume",
  "plan",
  "pact_review",
  "legion",
  "final_check",
  "report",
  "done",
];

function phaseIndex(phase: string | null | undefined): number {
  return phase ? PHASE_ORDER.indexOf(phase) : -1;
}

/**
 * Whether a stage has anything to show for a run in the given phase.
 *
 * - Legion always does (it renders the queue and sandbox preparation too).
 * - Pact exists from planning onward.
 * - The Reliquary exists once the run is checking, reporting or done.
 *
 * An unknown phase (run not loaded yet) allows only Legion, which loads the
 * event log itself and can say where the run is.
 */
export function canOpenStage(
  stage: RunStage,
  phase: string | null | undefined
): boolean {
  const idx = phaseIndex(phase);
  if (stage === "legion") return true;
  if (idx < 0) return false;
  if (stage === "pact") return idx >= PHASE_ORDER.indexOf("plan");
  return idx >= PHASE_ORDER.indexOf("final_check");
}

/** Why a stage is not open yet, in plain words for a tooltip. */
export function stageLockedReason(
  stage: RunStage,
  phase: string | null | undefined
): string | null {
  if (canOpenStage(stage, phase)) return null;
  if (phaseIndex(phase) < 0) return "Run state is not loaded yet.";
  if (stage === "pact") return "The Pact is written after the Exhume finishes.";
  return "The Reliquary opens when the run reaches its final check.";
}

/** owner/repo from a GitHub URL as stored on a run; null if it is not one. */
export function repoFromUrl(
  url: string | null | undefined
): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = url
    .trim()
    .match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export function runIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/(?:runs|replay)\/([^/]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// Outcome vocabulary (lib/lifecycle RUN_OUTCOMES) -> label and tone, shared by
// every screen that names an outcome.
export type OutcomeTone = "emerald" | "amber" | "crimson" | "neutral";

export function describeOutcome(outcome: string | null | undefined): {
  label: string;
  tone: OutcomeTone;
} {
  switch (outcome) {
    case "resurrected":
      return { label: "Resurrected", tone: "emerald" };
    case "resurrected_build_only":
      return { label: "Resurrected (build only)", tone: "emerald" };
    case "healthy_already":
      return { label: "Already healthy", tone: "emerald" };
    case "partial":
      return { label: "Partial", tone: "amber" };
    case "budget_stopped":
      return { label: "Stopped at budget", tone: "amber" };
    case "not_resurrected":
      return { label: "Not resurrected", tone: "crimson" };
    case "error":
      return { label: "Error", tone: "crimson" };
    case "killed":
      return { label: "Killed", tone: "crimson" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    default:
      return {
        label: outcome && outcome.length > 0 ? outcome : "not reported",
        tone: "neutral",
      };
  }
}
