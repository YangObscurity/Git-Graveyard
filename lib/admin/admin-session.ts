// Task 22.5 (V20): Admin authentication — HMAC-signed session cookie plus timing-safe header auth.
// Requirements: 28.3, 39.10, 39.11.
//
// The admin secret is read strictly on the server (`ADMIN_SECRET ?? ADMIN_TOKEN ?? ADMIN_KEY`) and is
// never embedded in a response body or a bundle. Every credential comparison runs in constant time
// on SHA-256 digests, so a wrong token cannot be found byte by byte. When the secret is unconfigured
// the module fails closed with `503`.

import * as crypto from "node:crypto";
import type { SettingsStore } from "./settings-store";

export const ADMIN_SESSION_COOKIE = "gg_admin_session";
export const DEFAULT_ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_ADMIN_LOGIN_MAX_ATTEMPTS = 8;
export const DEFAULT_ADMIN_LOGIN_WINDOW_MS = 60_000;

export type AdminAuthMethod = "cookie" | "token" | "bearer";

export interface AdminActor {
  id: string;
  role: string;
}

export type AdminAuthResult =
  | { ok: true; actor: AdminActor; method: AdminAuthMethod }
  | { ok: false; response: Response };

export interface AdminSessionPayload {
  sub: string;
  sid: string;
  role: string;
  iat: number;
  exp: number;
}

export interface AdminSessionVerification {
  ok: boolean;
  payload?: AdminSessionPayload;
  reason?: "malformed" | "bad_signature" | "expired";
}

/**
 * Reads the server-only admin secret; returns null when unconfigured (fail closed). Each candidate
 * is trimmed, so a blank `ADMIN_SECRET=""` falls through to `ADMIN_TOKEN` and then `ADMIN_KEY`.
 */
export function getAdminSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ["ADMIN_SECRET", "ADMIN_TOKEN", "ADMIN_KEY"] as const) {
    const raw = env[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

/** Constant-time comparison of two strings by way of their SHA-256 digests. */
export function timingSafeTokenEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
    return false;
  }
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/** Verifies a supplied credential against the configured admin secret without leaking its value. */
export function verifyAdminCredentials(
  credential: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const secret = getAdminSecret(env);
  if (!secret || typeof credential !== "string" || credential.trim().length === 0) {
    return false;
  }
  return timingSafeTokenEqual(credential.trim(), secret);
}

function signBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64url");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Creates a compact `payload.signature` session token. */
export function signAdminSession(payload: AdminSessionPayload, secret: string): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${body}.${signBody(body, secret)}`;
}

export function verifyAdminSessionToken(
  token: string,
  secret: string,
  now: number = Date.now()
): AdminSessionVerification {
  if (typeof token !== "string" || token.length === 0 || typeof secret !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!timingSafeTokenEqual(signature, signBody(body, secret))) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: AdminSessionPayload;
  try {
    payload = JSON.parse(base64UrlDecode(body)) as AdminSessionPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !payload ||
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (now >= payload.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

export interface IssueAdminSessionInput {
  actor: string;
  role?: string;
  secret: string;
  now?: number;
  ttlMs?: number;
  sessionId?: string;
}

export interface IssuedAdminSession {
  token: string;
  sessionId: string;
  expiresAt: number;
  setCookie: string;
}

export function issueAdminSession(input: IssueAdminSessionInput): IssuedAdminSession {
  const now = typeof input.now === "number" ? input.now : Date.now();
  const ttl =
    typeof input.ttlMs === "number" && input.ttlMs > 0 ? input.ttlMs : DEFAULT_ADMIN_SESSION_TTL_MS;
  const sessionId = input.sessionId ?? crypto.randomBytes(16).toString("hex");
  const payload: AdminSessionPayload = {
    sub: input.actor,
    sid: sessionId,
    role: input.role ?? "owner",
    iat: now,
    exp: now + ttl,
  };
  const token = signAdminSession(payload, input.secret);
  return {
    token,
    sessionId,
    expiresAt: payload.exp,
    setCookie: buildAdminSessionCookie(token, { maxAgeSeconds: Math.floor(ttl / 1000) }),
  };
}

export interface BuildCookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

export function buildAdminSessionCookie(
  token: string,
  options: BuildCookieOptions = {}
): string {
  const secure = options.secure ?? isProductionEnv();
  const maxAge = typeof options.maxAgeSeconds === "number" ? options.maxAgeSeconds : 0;
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
  ];
  if (secure) {
    parts.push("Secure");
  }
  if (maxAge > 0) {
    parts.push(`Max-Age=${maxAge}`);
  }
  return parts.join("; ");
}

export function clearAdminSessionCookie(options: BuildCookieOptions = {}): string {
  return `${buildAdminSessionCookie("", { ...options, maxAgeSeconds: 0 })}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader || typeof cookieHeader !== "string") {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const value = trimmed.slice(name.length + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function bearerTokenFromAuthorization(authorization: string | null): string | null {
  if (!authorization || typeof authorization !== "string") {
    return null;
  }
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = authorization.slice(7).trim();
  return token.length > 0 ? token : null;
}


// ---------------------------------------------------------------------------------------------
// Revoked sessions, failed-login throttling and client identity (process-wide, resettable)
// ---------------------------------------------------------------------------------------------

/** Key under which revoked admin session ids are persisted for cross-request visibility. */
export const ADMIN_REVOKED_SESSIONS_SETTING_KEY = "admin.revokedSessions";
/** SettingsStore key holding the signed pre-promotion Security_Access_Audit record. */
export const PROMOTION_AUDIT_SETTING_KEY = "promotionAudit";
/** A non-spoofable client key used when no trusted proxy is configured. */
export const DIRECT_CLIENT_IP_KEY = "direct";
/** Process-wide ceiling on failed admin logins within the window, independent of the client key. */
export const DEFAULT_ADMIN_GLOBAL_LOGIN_MAX_ATTEMPTS = 50;
/** Sliding window for the process-wide failed-login throttle. */
export const DEFAULT_ADMIN_GLOBAL_LOGIN_WINDOW_MS = 60_000;
/** Upper bound on distinct per-client login buckets so spoofed keys cannot exhaust memory. */
export const MAX_TRACKED_ADMIN_LOGIN_KEYS = 10_000;

interface RevokedSessionEntry {
  revokedAt: number;
  /** Absolute expiry (ms) after which the revocation no longer needs to be remembered. */
  expiresAt: number | null;
}

interface PersistedRevocation {
  sessionId: string;
  revokedAt: number;
  expiresAt: number | null;
}

/**
 * Thrown when the persisted admin revocation payload is present but malformed (not an object, or an
 * object without an array `sessions`). It is deliberately an error rather than an empty list so a
 * corrupted store fails closed instead of silently un-revoking sessions.
 */
export class AdminRevocationStoreError extends Error {
  readonly code = "ADMIN_REVOCATION_STORE_INVALID";

  constructor(message = "Persisted admin revocation state is malformed") {
    super(message);
    this.name = "AdminRevocationStoreError";
  }
}

interface AdminSessionState {
  revokedSessions?: Map<string, RevokedSessionEntry>;
  loginAttempts?: Map<string, number[]>;
  globalLoginAttempts?: number[];
}

export interface RevokeAdminSessionOptions {
  now?: number;
  expiresAt?: number | null;
  settingsStore?: SettingsStore;
}

export interface AdminSessionLookupOptions {
  now?: number;
  settingsStore?: SettingsStore;
}

function state(): AdminSessionState {
  return globalThis as unknown as AdminSessionState;
}

function normalizeLoginKey(ip: string): string {
  return ip && ip.trim().length > 0 ? ip.trim() : "unknown";
}

function resolveEntryExpiry(entry: PersistedRevocation): number {
  return entry.expiresAt ?? entry.revokedAt + DEFAULT_ADMIN_SESSION_TTL_MS;
}

function pruneRevokedSessions(now: number): void {
  const map = state().revokedSessions;
  if (!map || map.size === 0) {
    return;
  }
  for (const [sessionId, entry] of map) {
    const expiresAt = entry.expiresAt ?? entry.revokedAt + DEFAULT_ADMIN_SESSION_TTL_MS;
    if (now >= expiresAt) {
      map.delete(sessionId);
    }
  }
}

function readPersistedRevocations(
  store: SettingsStore | undefined,
  now: number
): PersistedRevocation[] {
  if (!store) {
    return [];
  }
  // A read error must propagate so the caller can fail closed: it must never be mistaken for "no
  // persisted revocations" (which would let a revoked cookie through). A malformed payload is also
  // treated as an error rather than being discarded as an empty list.
  const raw = store.getSetting<unknown>(ADMIN_REVOKED_SESSIONS_SETTING_KEY);
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdminRevocationStoreError();
  }
  const sessions = (raw as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) {
    throw new AdminRevocationStoreError();
  }
  const out: PersistedRevocation[] = [];
  for (const item of sessions) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const sessionId = record.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      continue;
    }
    const revokedAt = typeof record.revokedAt === "number" ? record.revokedAt : now;
    const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : null;
    const entry: PersistedRevocation = { sessionId, revokedAt, expiresAt };
    if (now < resolveEntryExpiry(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Synchronously appends `sessionId` to the persisted revocation list. `SettingsStore` is backed by
 * a `node:sqlite` `DatabaseSync`, which is strictly synchronous, so this read-modify-write runs to
 * completion before returning and no promise chaining is needed to serialize concurrent revocations.
 */
function persistRevokedSession(
  store: SettingsStore | undefined,
  sessionId: string,
  revokedAt: number,
  expiresAt: number | null
): void {
  if (!store) {
    return;
  }
  // Persistence errors are NOT swallowed: a revocation that cannot be written must surface so the
  // caller can report the failure instead of silently leaving a session un-revoked across requests.
  const kept = readPersistedRevocations(store, revokedAt).filter(
    (entry) => entry.sessionId !== sessionId
  );
  kept.push({ sessionId, revokedAt, expiresAt });
  store.setSetting(
    ADMIN_REVOKED_SESSIONS_SETTING_KEY,
    { sessions: kept },
    { actor: "admin-session", reason: "admin session revocation" }
  );
}

export function revokeAdminSession(
  sessionId: string,
  options: RevokeAdminSessionOptions = {}
): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return;
  }
  const now = typeof options.now === "number" ? options.now : Date.now();
  const s = state();
  if (!s.revokedSessions) {
    s.revokedSessions = new Map<string, RevokedSessionEntry>();
  }
  const expiresAt = typeof options.expiresAt === "number" ? options.expiresAt : null;
  s.revokedSessions.set(sessionId, { revokedAt: now, expiresAt });
  pruneRevokedSessions(now);
  persistRevokedSession(options.settingsStore, sessionId, now, expiresAt);
}

export function isAdminSessionRevoked(
  sessionId: string,
  options: AdminSessionLookupOptions = {}
): boolean {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return false;
  }
  const now = typeof options.now === "number" ? options.now : Date.now();
  pruneRevokedSessions(now);
  if (state().revokedSessions?.has(sessionId)) {
    return true;
  }
  // Throws when the persisted revocation list cannot be read; callers on the request path must
  // treat that as a fail-closed deny.
  return readPersistedRevocations(options.settingsStore, now).some(
    (entry) => entry.sessionId === sessionId
  );
}

function pruneLoginAttempts(cutoff: number): void {
  const s = state();
  const map = s.loginAttempts;
  if (map) {
    for (const [key, timestamps] of map) {
      const live = timestamps.filter((ts) => ts > cutoff);
      if (live.length === 0) {
        map.delete(key);
      } else if (live.length !== timestamps.length) {
        map.set(key, live);
      }
    }
    if (map.size > MAX_TRACKED_ADMIN_LOGIN_KEYS) {
      const overflow = map.size - MAX_TRACKED_ADMIN_LOGIN_KEYS;
      const evicted: string[] = [];
      for (const key of map.keys()) {
        if (evicted.length >= overflow) {
          break;
        }
        evicted.push(key);
      }
      for (const key of evicted) {
        map.delete(key);
      }
    }
  }
  if (s.globalLoginAttempts) {
    s.globalLoginAttempts = s.globalLoginAttempts.filter((ts) => ts > cutoff);
  }
}

export function recordFailedAdminLogin(
  ip: string,
  now: number = Date.now(),
  windowMs: number = DEFAULT_ADMIN_LOGIN_WINDOW_MS
): void {
  const s = state();
  if (!s.loginAttempts) {
    s.loginAttempts = new Map<string, number[]>();
  }
  const key = normalizeLoginKey(ip);
  const cutoff = now - windowMs;
  const existing = (s.loginAttempts.get(key) ?? []).filter((ts) => ts > cutoff);
  existing.push(now);
  s.loginAttempts.set(key, existing);

  if (!s.globalLoginAttempts) {
    s.globalLoginAttempts = [];
  }
  const globalCutoff = now - Math.max(windowMs, DEFAULT_ADMIN_GLOBAL_LOGIN_WINDOW_MS);
  const global = s.globalLoginAttempts.filter((ts) => ts > globalCutoff);
  global.push(now);
  s.globalLoginAttempts = global;

  pruneLoginAttempts(now - Math.max(windowMs, DEFAULT_ADMIN_GLOBAL_LOGIN_WINDOW_MS));
}

export function isAdminLoginRateLimited(
  ip: string,
  now: number = Date.now(),
  windowMs: number = DEFAULT_ADMIN_LOGIN_WINDOW_MS,
  maxAttempts: number = DEFAULT_ADMIN_LOGIN_MAX_ATTEMPTS,
  globalMaxAttempts: number = DEFAULT_ADMIN_GLOBAL_LOGIN_MAX_ATTEMPTS
): boolean {
  const s = state();
  const globalCutoff = now - Math.max(windowMs, DEFAULT_ADMIN_GLOBAL_LOGIN_WINDOW_MS);
  const globalRecent = (s.globalLoginAttempts ?? []).filter((ts) => ts > globalCutoff);
  if (globalRecent.length >= globalMaxAttempts) {
    return true;
  }

  const key = normalizeLoginKey(ip);
  // When no trusted proxy / peer IP is configured every client shares the constant `direct` key, so
  // a low per-key limit would lock out unrelated valid logins after only a handful of failures. The
  // process-wide global limit checked above is the meaningful bound for that shared key; per-client
  // windowing applies only to genuine, non-spoofable client keys.
  if (key === DIRECT_CLIENT_IP_KEY) {
    return false;
  }
  const list = s.loginAttempts?.get(key);
  if (!list) {
    return false;
  }
  const cutoff = now - windowMs;
  return list.filter((ts) => ts > cutoff).length >= maxAttempts;
}

export function clearAdminLoginAttempts(ip: string): void {
  const s = state();
  const key = normalizeLoginKey(ip);
  s.loginAttempts?.delete(key);
}

export function resetAdminSessionState(): void {
  const s = state();
  s.revokedSessions = new Map<string, RevokedSessionEntry>();
  s.loginAttempts = new Map<string, number[]>();
  s.globalLoginAttempts = [];
}

export interface ClientIpOptions {
  /** Explicitly trust `X-Forwarded-For` / `X-Real-IP`; defaults to the `TRUST_PROXY` env flag. */
  trustProxy?: boolean;
  env?: NodeJS.ProcessEnv;
}

function isProxyTrustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.TRUST_PROXY;
  return value === "1" || value === "true";
}

/**
 * Derives the client key for rate limiting. Forwarded headers are attacker-controlled, so they are
 * only honored when an operator has explicitly opted in via `TRUST_PROXY=1|true` (or the
 * `{ trustProxy: true }` option). Otherwise a constant, non-spoofable `direct` key is returned so a
 * caller cannot mint fresh buckets by rotating headers.
 *
 * Proxy header contract: the trusted reverse proxy must overwrite `X-Real-IP` with the single client
 * IP and *append* the peer it observed to the right of `X-Forwarded-For`. Resolution therefore
 * prefers `X-Real-IP`, then the rightmost non-empty `X-Forwarded-For` entry — the leftmost entry is
 * appended by the client itself and is trivially spoofable.
 */
export function clientIpFromRequest(request: Request, options: ClientIpOptions = {}): string {
  const trustProxy = options.trustProxy ?? isProxyTrustEnabled(options.env);
  if (trustProxy) {
    const realIp = request.headers.get("x-real-ip");
    if (realIp && realIp.trim().length > 0) {
      return realIp.trim();
    }
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded && forwarded.trim().length > 0) {
      const hops = forwarded.split(",");
      for (let i = hops.length - 1; i >= 0; i -= 1) {
        const candidate = hops[i].trim();
        if (candidate.length > 0) {
          return candidate;
        }
      }
    }
  }
  return DIRECT_CLIENT_IP_KEY;
}

function denied(status: number, error: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: Response.json({ ok: false, error }, { status }),
  };
}

export interface RequireAdminAuthOptions {
  /** Optional SettingsStore used to observe cross-request session revocations. */
  settingsStore?: SettingsStore;
}

/**
 * Requirement 39.11 / 28.3: refuses any Admin request without a valid session. Order of checks:
 *   1. an unconfigured secret fails closed (`503`),
 *   2. a constant-time `x-admin-token` / `Authorization: Bearer` match (`token` / `bearer`),
 *   3. a valid HMAC session cookie that is neither expired nor revoked (`cookie`).
 */
export function requireAdminAuth(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  options: RequireAdminAuthOptions = {}
): AdminAuthResult {
  const secret = getAdminSecret(env);
  if (!secret) {
    return denied(503, "admin_auth_unconfigured");
  }

  const headerToken = request.headers.get("x-admin-token");
  if (headerToken && timingSafeTokenEqual(headerToken.trim(), secret)) {
    return { ok: true, actor: { id: "owner", role: "owner" }, method: "token" };
  }

  const bearer = bearerTokenFromAuthorization(request.headers.get("authorization"));
  if (bearer && timingSafeTokenEqual(bearer, secret)) {
    return { ok: true, actor: { id: "owner", role: "owner" }, method: "bearer" };
  }

  const cookieToken = parseCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (cookieToken) {
    const verified = verifyAdminSessionToken(cookieToken, secret);
    if (verified.ok && verified.payload) {
      let revoked: boolean;
      try {
        revoked = isAdminSessionRevoked(verified.payload.sid, {
          settingsStore: options.settingsStore,
        });
      } catch {
        // If the persisted revocation list cannot be read we cannot prove the session is live, so
        // deny the request instead of failing open (Requirement 39.11).
        return denied(503, "admin_authorization_unavailable");
      }
      if (revoked) {
        return denied(403, "admin_session_revoked");
      }
      return {
        ok: true,
        actor: { id: verified.payload.sub, role: verified.payload.role },
        method: "cookie",
      };
    }
  }

  return denied(401, "admin_auth_required");
}

