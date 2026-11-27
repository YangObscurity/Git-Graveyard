import { resolveRunStore, resolveSettingsStore } from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";
import {
  InviteCodeAuthorizationError,
  InviteCodeService,
} from "@/lib/admission/invite-code";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface InviteCodeBody {
  expiresAt?: unknown;
  allowedRunCount?: unknown;
  caps?: unknown;
  pushFlag?: unknown;
  label?: unknown;
  code?: unknown;
  codeHash?: unknown;
}

type BodyReadResult =
  | { ok: true; body: InviteCodeBody }
  | { ok: false };

/**
 * Distinguishes a genuinely empty body (treated as `{}`, keeping default invite-code creation) from
 * a malformed/invalid JSON body (rejected so an unparseable request never silently mints a code).
 */
async function readBody(request: Request): Promise<BodyReadResult> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: true, body: {} };
  }
  if (text.trim().length === 0) {
    return { ok: true, body: {} };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, body: parsed as InviteCodeBody };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function GET(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const service = new InviteCodeService({ runStore: resolveRunStore(request) });
  return Response.json({
    ok: true,
    inviteCodes: service.listCodes({ actor: auth.actor.id, adminSession: true }),
  });
}

export async function POST(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const parsedBody = await readBody(request);
  if (!parsedBody.ok) {
    return Response.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }
  const body = parsedBody.body;
  const rawAllowedRunCount = body.allowedRunCount;
  if (rawAllowedRunCount !== undefined) {
    if (
      typeof rawAllowedRunCount !== "number" ||
      !Number.isFinite(rawAllowedRunCount) ||
      !Number.isInteger(rawAllowedRunCount) ||
      rawAllowedRunCount < 1
    ) {
      return Response.json({ ok: false, error: "invalid_allowed_run_count" }, { status: 400 });
    }
  }

  const runStore = resolveRunStore(request);
  const service = new InviteCodeService({ runStore });

  try {
    const result = service.createCode(
      {
        expiresAt:
          typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
            ? body.expiresAt
            : null,
        allowedRunCount:
          typeof rawAllowedRunCount === "number" ? rawAllowedRunCount : undefined,
        caps:
          body.caps && typeof body.caps === "object"
            ? (body.caps as Record<string, unknown>)
            : null,
        pushFlag: body.pushFlag === true,
        label: typeof body.label === "string" ? body.label : null,
      },
      { actor: auth.actor.id, adminSession: true }
    );

    return Response.json(
      {
        ok: true,
        code: result.code,
        record: result.record,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof InviteCodeAuthorizationError) {
      return Response.json({ ok: false, error: err.code }, { status: 403 });
    }
    throw err;
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const parsedBody = await readBody(request);
  const body = parsedBody.ok ? parsedBody.body : {};
  const target =
    typeof body.codeHash === "string" && body.codeHash.trim().length > 0
      ? body.codeHash.trim()
      : typeof body.code === "string" && body.code.trim().length > 0
        ? body.code.trim()
        : "";
  if (!target) {
    return Response.json({ ok: false, error: "code_or_hash_required" }, { status: 400 });
  }

  const service = new InviteCodeService({ runStore: resolveRunStore(request) });
  try {
    const result = service.revokeCode(target, { actor: auth.actor.id, adminSession: true });
    return Response.json({ ok: result.ok, codeHash: result.codeHash ?? null });
  } catch (err) {
    if (err instanceof InviteCodeAuthorizationError) {
      return Response.json({ ok: false, error: err.code }, { status: 403 });
    }
    throw err;
  }
}
