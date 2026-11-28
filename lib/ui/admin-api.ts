/**
 * Typed `fetch` wrappers for the Admin API. Every wrapper checks `res.ok` and
 * returns a discriminated result, so a failed response is never reported as a
 * success. The request and response shapes mirror the route handlers exactly.
 */

export type AdminApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

export interface AdminActor {
  id: string;
  role: string;
}

export interface AdminSessionData {
  authenticated: boolean;
  actor: AdminActor | null;
  configured?: boolean;
}

export interface AdminInviteCodeData {
  codeHash: string;
  allowedRunCount?: number;
  usedRunCount?: number;
  expiresAt?: number | null;
  label?: string | null;
}

export interface AdminInviteCodesResponse {
  inviteCodes: AdminInviteCodeData[];
}

export interface AdminRunData {
  runId: string;
  repository?: string | null;
  outcome?: string | null;
  phase?: string | null;
  isPublished?: boolean;
  isRemoved?: boolean;
  reviewed?: boolean;
  [key: string]: unknown;
}

export interface AdminPromotionAuditData {
  present: boolean;
  verified: boolean;
  actor?: string | null;
  signedAt?: number | null;
  record?: unknown;
}

export interface AdminKillSwitchState {
  pausedNewRuns?: boolean;
  stoppingGracefully?: boolean;
  lastLevel?: string | null;
  lastExecutedAt?: number | null;
}

export interface AdminKillSwitchData {
  previews?: unknown[];
  state?: AdminKillSwitchState;
  requiresConfirmation?: boolean;
  result?: unknown;
}

export interface AdminQueueData {
  queue: {
    depth: number;
    entries: Array<{ runId: string; position?: number }>;
  };
}

export interface AdminSettingsData {
  settings: Record<string, unknown>;
  missingRequiredSettings?: string[];
  auditLog?: unknown[];
}

export type AdminRunAction = "review" | "redact" | "publish" | "hide";

export interface AdminRunActionBody {
  action: AdminRunAction;
  reason?: string;
  fields?: string[];
}

export interface AdminRunActionData {
  action: string;
  run?: AdminRunData;
  marker?: string;
}

function messageFromBody(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim().length > 0) {
      return record.error;
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }
  }
  return `The admin request failed with status ${status}.`;
}

async function request<T>(
  url: string,
  init?: RequestInit
): Promise<AdminApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, status: 0, message: "The admin request could not be sent." };
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: false, status: res.status, message: messageFromBody(body, res.status) };
  }
  try {
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, status: res.status, message: "The admin response could not be read." };
  }
}

function postJson(url: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** GET /api/admin/session — read the current session state. */
export function getAdminSession(): Promise<AdminApiResult<AdminSessionData>> {
  return request<AdminSessionData>("/api/admin/session");
}

/** POST /api/admin/session — exchange the admin token for a session cookie. */
export function signInAdmin(token: string): Promise<AdminApiResult<AdminSessionData>> {
  return request<AdminSessionData>(
    "/api/admin/session",
    postJson("/api/admin/session", { token })
  );
}

/** GET /api/admin/invite-codes — list the invite codes. */
export function listInviteCodes(): Promise<AdminApiResult<AdminInviteCodesResponse>> {
  return request<AdminInviteCodesResponse>("/api/admin/invite-codes");
}

/** GET /api/history — the runs the Admin dashboard reviews and publishes. */
export function listAdminRuns(): Promise<AdminApiResult<AdminRunData[]>> {
  return request<AdminRunData[]>("/api/history");
}

/** GET /api/admin/promotion-audit — the signed pre-promotion audit record. */
export function getPromotionAudit(): Promise<AdminApiResult<AdminPromotionAuditData>> {
  return request<AdminPromotionAuditData>("/api/admin/promotion-audit");
}

/** GET /api/admin/kill-switch — previews and current kill-switch state. */
export function getKillSwitch(): Promise<AdminApiResult<AdminKillSwitchData>> {
  return request<AdminKillSwitchData>("/api/admin/kill-switch");
}

/** GET /api/admin/queue — the admission queue snapshot. */
export function getQueue(): Promise<AdminApiResult<AdminQueueData>> {
  return request<AdminQueueData>("/api/admin/queue");
}

/** GET /api/admin/settings — the settings snapshot. */
export function getSettings(): Promise<AdminApiResult<AdminSettingsData>> {
  return request<AdminSettingsData>("/api/admin/settings");
}

/** POST /api/admin/runs/[runId] — review, redact, publish or hide a run. */
export function runAdminAction(
  runId: string,
  body: AdminRunActionBody
): Promise<AdminApiResult<AdminRunActionData>> {
  return request<AdminRunActionData>(
    `/api/admin/runs/${encodeURIComponent(runId)}`,
    postJson(`/api/admin/runs/${encodeURIComponent(runId)}`, body)
  );
}

/**
 * POST /api/admin/kill-switch — execute a level once the operator has typed the
 * confirmation phrase. The route requires `level` and a truthy `confirmed`; the
 * typed phrase is forwarded as `confirm` for the record.
 */
export function executeKillSwitch(
  level: string,
  phrase: string
): Promise<AdminApiResult<AdminKillSwitchData>> {
  return request<AdminKillSwitchData>(
    "/api/admin/kill-switch",
    postJson("/api/admin/kill-switch", { level, confirmed: true, confirm: phrase })
  );
}

/**
 * Build an absolute base URL for the current request from its headers. Uses
 * `x-forwarded-proto` (defaulting to `http`) and `host`. Returns null when the
 * host header is unavailable so callers keep their existing behaviour.
 */
export function buildRequestBaseUrl(headersList: {
  get(name: string): string | null;
}): string | null {
  const host = headersList.get("host");
  if (!host || host.trim().length === 0) {
    return null;
  }
  const rawProto = headersList.get("x-forwarded-proto");
  const proto =
    rawProto && rawProto.trim().length > 0
      ? rawProto.split(",")[0].trim()
      : "http";
  return `${proto}://${host.trim()}`;
}