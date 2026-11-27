// Task 22.5 (V20): Admin authentication — HMAC-signed session cookie plus timing-safe header auth.
// Requirements: 28.3, 39.10, 39.11.
//
// The admin secret is read strictly on the server (`ADMIN_SECRET ?? ADMIN_TOKEN ?? ADMIN_KEY`) and is
// never embedded in a response body or a bundle. Every credential comparison runs in constant time
// on SHA-256 digests, so a wrong token cannot be found byte by byte. When the secret is unconfigured
// the module fails closed with `503`.

import * as crypto from "node:crypto";

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

/** Reads the server-only admin secret; returns null when unconfigured (fail closed). */
export function getAdminSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ADMIN_SECRET ?? env.ADMIN_TOKEN ?? env.ADMIN_KEY;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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
// Revoked sessions and failed-login rate limiting (process-wide, resettable for tests)
// ---------------------------------------------------------------------------------------------

interface AdminSessionState {
  revokedSessions?: Set<string>;
  loginAttempts?: Map<string, number[]>;
}

function state(): AdminSessionState {
  return globalThis as unknown as AdminSessionState;
}

export function revokeAdminSession(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return;
  }
  const s = state();
  if (!s.revokedSessions) {
    s.revokedSessions = new Set<string>();
  }
  s.revokedSessions.add(sessionId);
}

export function isAdminSessionRevoked(sessionId: string): boolean {
  return Boolean(state().revokedSessions?.has(sessionId));
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
  const key = ip && ip.trim().length > 0 ? ip.trim() : "unknown";
  const cutoff = now - windowMs;
  const existing = (s.loginAttempts.get(key) ?? []).filter((ts) => ts > cutoff);
  existing.push(now);
  s.loginAttempts.set(key, existing);
}

export function isAdminLoginRateLimited(
  ip: string,
  now: number = Date.now(),
  windowMs: number = DEFAULT_ADMIN_LOGIN_WINDOW_MS,
  maxAttempts: number = DEFAULT_ADMIN_LOGIN_MAX_ATTEMPTS
): boolean {
  const s = state();
  const key = ip && ip.trim().length > 0 ? ip.trim() : "unknown";
  const list = s.loginAttempts?.get(key);
  if (!list) {
    return false;
  }
  const cutoff = now - windowMs;
  return list.filter((ts) => ts > cutoff).length >= maxAttempts;
}

export function clearAdminLoginAttempts(ip: string): void {
  const s = state();
  const key = ip && ip.trim().length > 0 ? ip.trim() : "unknown";
  s.loginAttempts?.delete(key);
}

export function resetAdminSessionState(): void {
  const s = state();
  s.revokedSessions = new Set<string>();
  s.loginAttempts = new Map<string, number[]>();
}

export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded && forwarded.trim().length > 0) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }
  return "unknown";
}

function denied(status: number, error: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: Response.json({ ok: false, error }, { status }),
  };
}

/**
 * Requirement 39.11 / 28.3: refuses any Admin request without a valid session. Order of checks:
 *   1. an unconfigured secret fails closed (`503`),
 *   2. a constant-time `x-admin-token` / `Authorization: Bearer` match (`token` / `bearer`),
 *   3. a valid HMAC session cookie that is neither expired nor revoked (`cookie`).
 */
export function requireAdminAuth(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
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
      if (isAdminSessionRevoked(verified.payload.sid)) {
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

