import { resolveSettingsStore } from "@/lib/runtime/store-context";
import {
  ADMIN_SESSION_COOKIE,
  bearerTokenFromAuthorization,
  clearAdminLoginAttempts,
  clearAdminSessionCookie,
  clientIpFromRequest,
  getAdminSecret,
  isAdminLoginRateLimited,
  issueAdminSession,
  parseCookie,
  recordFailedAdminLogin,
  requireAdminAuth,
  revokeAdminSession,
  verifyAdminCredentials,
  verifyAdminSessionToken,
} from "@/lib/admin/admin-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SessionBody {
  token?: unknown;
  adminToken?: unknown;
  adminKey?: unknown;
  actor?: unknown;
}

async function readBody(request: Request): Promise<SessionBody> {
  try {
    const parsed = (await request.json()) as SessionBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function providedCredential(request: Request, body: SessionBody): string | null {
  for (const candidate of [body.token, body.adminToken, body.adminKey]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  const headerToken = request.headers.get("x-admin-token");
  if (headerToken && headerToken.trim().length > 0) {
    return headerToken.trim();
  }
  return bearerTokenFromAuthorization(request.headers.get("authorization"));
}

export async function GET(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (auth.ok) {
    return Response.json({
      ok: true,
      authenticated: true,
      configured: true,
      actor: auth.actor,
      method: auth.method,
    });
  }
  // Fail closed when the admin secret is unconfigured; otherwise report an unauthenticated status.
  if (auth.response.status === 503) {
    return Response.json(
      { ok: false, authenticated: false, configured: false, error: "admin_auth_unconfigured" },
      { status: 503 }
    );
  }
  return Response.json({ ok: true, authenticated: false, configured: true, actor: null });
}

export async function POST(request: Request): Promise<Response> {
  const secret = getAdminSecret();
  if (!secret) {
    return Response.json({ ok: false, error: "admin_auth_unconfigured" }, { status: 503 });
  }

  const ip = clientIpFromRequest(request);
  if (isAdminLoginRateLimited(ip)) {
    return Response.json(
      { ok: false, error: "too_many_attempts", retryAfterMs: 60_000 },
      { status: 429 }
    );
  }

  const body = await readBody(request);
  const credential = providedCredential(request, body);
  if (!verifyAdminCredentials(credential)) {
    recordFailedAdminLogin(ip);
    return Response.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }

  clearAdminLoginAttempts(ip);
  // Requirement 39.11: the actor is derived from a server-trusted principal, never from the
  // caller-supplied body, so audit attribution cannot be spoofed.
  const actor = process.env.ADMIN_ACTOR_ID?.trim() || "owner";
  const issued = issueAdminSession({ actor, role: "owner", secret });

  return Response.json(
    {
      ok: true,
      authenticated: true,
      actor: { id: actor, role: "owner" },
      method: "cookie",
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt,
    },
    { status: 200, headers: { "Set-Cookie": issued.setCookie } }
  );
}

export async function DELETE(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const cookieToken = parseCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  let revokedSessionId: string | null = null;
  const secret = getAdminSecret();
  if (cookieToken && secret) {
    const verified = verifyAdminSessionToken(cookieToken, secret);
    if (verified.ok && verified.payload) {
      // Persist the revocation so it holds across requests and instances.
      revokeAdminSession(verified.payload.sid, {
        settingsStore,
        expiresAt: verified.payload.exp,
      });
      revokedSessionId = verified.payload.sid;
    }
  }
  return Response.json(
    { ok: true, signedOut: true, revokedSessionId },
    { status: 200, headers: { "Set-Cookie": clearAdminSessionCookie() } }
  );
}
