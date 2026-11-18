// Typed wrappers around the app's own HTTP API, with one copy of each error
// message. URLs, methods and bodies match app/api/** exactly; nothing here
// adds a field the routes do not read.

import type { RunEvent } from "./run-model";
import { recallInviteCode } from "./invite-session";

const enc = encodeURIComponent;

export type ApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; code?: string; message: string };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = await res.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// --- start-run ---------------------------------------------------------------

/**
 * Plain-words message for a refused POST /api/start-run. The codes are the
 * ones the route returns; each message says what to do next.
 */
export function describeStartRunError(
  status: number,
  data: Record<string, unknown>
): string {
  const code = text(data.code);
  const reason = text(data.status) ?? text(data.reason);

  if (code === "MISSING_INVITE_CODE" || reason === "missing") {
    return "An invite code is required to start a live run. Enter your code and try again.";
  }
  if (code === "INVALID_INVITE_CODE" || reason === "not_found") {
    return "The submitted invite code was not recognized. Check the code and try again.";
  }
  if (code === "EXPIRED_INVITE_CODE" || reason === "expired") {
    return "The submitted invite code has expired. Ask the owner for a new code.";
  }
  if (code === "REVOKED_INVITE_CODE" || reason === "revoked") {
    return "The submitted invite code has been revoked by the owner. Ask the owner for a new code.";
  }
  if (code === "RUN_LIMIT_REACHED" || reason === "used_up") {
    return "The submitted invite code has no remaining runs. Ask the owner for a new code.";
  }
  if (code === "PAUSED" || reason === "paused") {
    return "Live runs are currently paused by the owner. Exhume is disabled; the autopsy and recorded runs are still available.";
  }
  if (code === "UNAVAILABLE" || reason === "unavailable") {
    return "Live runs are currently unavailable. Exhume is disabled; the autopsy and recorded runs are still available.";
  }
  if (code === "QUEUE_FULL" || reason === "queue_full") {
    return "The admission queue is full. Try again in a few minutes.";
  }
  if (code === "RATE_LIMITED") {
    const reset = text(data.resetTime) ?? text(data.resetAt) ?? "not reported";
    return `GitHub rate limit exceeded. Reset time: ${reset}. Try again after it resets.`;
  }
  return (
    text(data.message) ??
    text(data.error) ??
    `The run could not be started (status ${status}). Try again.`
  );
}

export async function startRun(input: {
  url: string;
  sha?: string;
  inviteCode: string;
}): Promise<ApiResult<{ runId: string; queuePosition: number | null }>> {
  let res: Response;
  try {
    res = await fetch("/api/start-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: input.url.trim(),
        sha: input.sha?.trim() || "HEAD",
        inviteCode: input.inviteCode.trim(),
      }),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      message:
        "The request did not reach the server. Check your connection and try again.",
    };
  }

  const data = await readJson(res);
  const runId = text(data.runId);
  if (res.ok && data.ok === true && runId) {
    return {
      ok: true,
      runId,
      queuePosition:
        typeof data.queuePosition === "number" ? data.queuePosition : null,
    };
  }
  return {
    ok: false,
    status: res.status,
    code: text(data.code),
    message: describeStartRunError(res.status, data),
  };
}

// --- run reads ---------------------------------------------------------------

export interface RunSummary {
  runId: string;
  phase: string | null;
  outcome: string | null;
  url: string | null;
  sha: string | null;
  caps: Record<string, unknown> | null;
}

export async function fetchRunSummary(
  runId: string
): Promise<ApiResult<{ summary: RunSummary }>> {
  let res: Response;
  try {
    res = await fetch(`/api/runs/${enc(runId)}`);
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server." };
  }
  const data = await readJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message:
        res.status === 404
          ? "Run not found."
          : text(data.error) ?? `Could not load the run (status ${res.status}).`,
    };
  }
  const run =
    data.run && typeof data.run === "object"
      ? (data.run as Record<string, unknown>)
      : {};
  return {
    ok: true,
    summary: {
      runId,
      phase: text(data.phase) ?? text(run.phase) ?? null,
      outcome: text(data.outcome) ?? text(run.outcome) ?? null,
      url: text(run.url) ?? null,
      sha: text(run.sha) ?? null,
      caps:
        run.caps && typeof run.caps === "object"
          ? (run.caps as Record<string, unknown>)
          : null,
    },
  };
}

/** Stored events from `from` (inclusive), as the JSON array the route returns. */
export async function fetchRunEvents(
  runId: string,
  from = 1
): Promise<ApiResult<{ events: RunEvent[] }>> {
  let res: Response;
  try {
    res = await fetch(`/api/runs/${enc(runId)}/events?from=${enc(String(from))}`);
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server." };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `Could not read the event log (status ${res.status}).`,
    };
  }
  try {
    const data: unknown = await res.json();
    return { ok: true, events: Array.isArray(data) ? (data as RunEvent[]) : [] };
  } catch {
    return { ok: false, status: res.status, message: "The event log was not readable." };
  }
}

/** URL for the live stream, resuming after `lastSeq` so nothing is replayed. */
export function eventStreamUrl(runId: string, lastSeq: number): string {
  const base = `/api/runs/${enc(runId)}/events`;
  return lastSeq > 0 ? `${base}?lastEventId=${enc(String(lastSeq))}` : base;
}

// --- run actions -------------------------------------------------------------

async function postJson(
  url: string,
  body: Record<string, unknown>,
  failure: string,
  extraHeaders?: Record<string, string>
): Promise<ApiResult<{ data: Record<string, unknown> }>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, message: `${failure}.` };
  }
  const data = await readJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: text(data.error) ?? `${failure} (status ${res.status}).`,
    };
  }
  return { ok: true, data };
}

export type ControlAction = "pause" | "resume" | "stop" | "kill";

export function postControl(
  runId: string,
  action: ControlAction,
  failure: string,
  inviteCode?: string
) {
  const code = inviteCode?.trim() || recallInviteCode(runId);
  return postJson(
    `/api/runs/${enc(runId)}/control`,
    { action },
    failure,
    code ? { "x-invite-code": code } : undefined
  );
}

export type ApprovalDecision =
  | "approve_once"
  | "approve_pattern"
  | "deny"
  | "deny_and_lay_to_rest";

export function postApproval(
  runId: string,
  approvalId: string,
  decision: ApprovalDecision,
  inviteCode?: string
) {
  const code = inviteCode?.trim() || recallInviteCode(runId);
  return postJson(
    `/api/runs/${enc(runId)}/approvals`,
    { approvalId, decision },
    "Failed to submit approval decision",
    code ? { "x-invite-code": code } : undefined
  );
}

export function postAskAnswer(
  runId: string,
  askId: string,
  answer: string,
  inviteCode?: string
) {
  const code = inviteCode?.trim() || recallInviteCode(runId);
  return postJson(
    `/api/runs/${enc(runId)}/asks`,
    { askId, answer },
    "Failed to send the answer",
    code ? { "x-invite-code": code } : undefined
  );
}

export function postSkeletonAction(
  runId: string,
  skeletonId: string,
  body: Record<string, unknown>,
  failure: string,
  inviteCode?: string
) {
  const code = inviteCode?.trim() || recallInviteCode(runId);
  return postJson(
    `/api/runs/${enc(runId)}/skeletons/${enc(skeletonId)}`,
    body,
    failure,
    code ? { "x-invite-code": code } : undefined
  );
}
