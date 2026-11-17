// The invite code a user typed, kept for the browser tab so the Pact and
// Exhume screens can authorise their requests without the code travelling in
// a URL (where it would land in history, logs and the Referer header).
//
// sessionStorage only: it is gone when the tab closes. Every call is a no-op
// on the server and when storage is unavailable.

const RUN_KEY_PREFIX = "git-graveyard:invite:";
const LAST_KEY = "git-graveyard:invite:last";

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Remember the code used to start `runId`. */
export function rememberInviteCode(runId: string, code: string): void {
  const store = storage();
  const clean = code.trim();
  if (!store || !runId || !clean) return;
  try {
    store.setItem(RUN_KEY_PREFIX + runId, clean);
    store.setItem(LAST_KEY, clean);
  } catch {
    // Storage full or blocked: the user can type the code again.
  }
}

/**
 * The code for `runId`, or the last code typed in this tab (a run opened from
 * History in the same tab was most likely started with it), or "".
 */
export function recallInviteCode(runId: string): string {
  const store = storage();
  if (!store) return "";
  try {
    return (
      store.getItem(RUN_KEY_PREFIX + runId) ?? store.getItem(LAST_KEY) ?? ""
    );
  } catch {
    return "";
  }
}

export function forgetInviteCode(runId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(RUN_KEY_PREFIX + runId);
  } catch {
    // Nothing to do.
  }
}
