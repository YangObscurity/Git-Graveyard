// A screen that follows a run live (Legion, Pact, Exhume) tells the rest of
// the page which phase the run is in, so the nav stepper unlocks stages as the
// run reaches them without polling.

const EVENT_NAME = "git-graveyard:run-phase";

export interface RunPhaseNotice {
  runId: string;
  phase: string;
  outcome?: string | null;
}

export function announceRunPhase(notice: RunPhaseNotice): void {
  if (typeof window === "undefined" || !notice.runId || !notice.phase) return;
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: notice }));
  } catch {
    // CustomEvent unavailable: the nav falls back to its own fetch.
  }
}

export function onRunPhase(
  listener: (notice: RunPhaseNotice) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<RunPhaseNotice>).detail;
    if (detail && typeof detail.runId === "string" && typeof detail.phase === "string") {
      listener(detail);
    }
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
