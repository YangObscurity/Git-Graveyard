import * as crypto from "node:crypto";
import { resolveSettingsStore } from "@/lib/runtime/store-context";
import { getAdminSecret, requireAdminAuth } from "@/lib/admin/admin-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const PROMOTION_AUDIT_SETTING_KEY = "promotionAudit";

interface PromotionAuditBody {
  status?: unknown;
  actor?: unknown;
  items?: unknown;
  signature?: unknown;
}

interface PromotionAuditRecord {
  actor: string;
  signedAt: number;
  status: string;
  signature: string;
}

async function readBody(request: Request): Promise<PromotionAuditBody> {
  try {
    const parsed = (await request.json()) as PromotionAuditBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalize(record: Omit<PromotionAuditRecord, "signature">): string {
  return JSON.stringify({
    actor: record.actor,
    signedAt: record.signedAt,
    status: record.status,
  });
}

function sign(secret: string, canonical: string): string {
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

function asRecord(value: unknown): PromotionAuditRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.actor !== "string" ||
    typeof record.signedAt !== "number" ||
    typeof record.status !== "string" ||
    typeof record.signature !== "string"
  ) {
    return null;
  }
  return {
    actor: record.actor,
    signedAt: record.signedAt,
    status: record.status,
    signature: record.signature,
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = requireAdminAuth(request);
  if (!auth.ok) {
    return auth.response;
  }
  const store = resolveSettingsStore(request);
  const record = asRecord(store.getSetting(PROMOTION_AUDIT_SETTING_KEY));
  const secret = getAdminSecret();
  let verified = false;
  if (record && secret) {
    const expected = sign(secret, canonicalize(record));
    verified = expected.length === record.signature.length && crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(record.signature, "utf8")
    );
  }
  return Response.json({ ok: true, record, verified, present: record !== null });
}

export async function POST(request: Request): Promise<Response> {
  const auth = requireAdminAuth(request);
  if (!auth.ok) {
    return auth.response;
  }
  const secret = getAdminSecret();
  if (!secret) {
    return Response.json({ ok: false, error: "admin_auth_unconfigured" }, { status: 503 });
  }

  const body = await readBody(request);
  const status = typeof body.status === "string" && body.status.trim().length > 0
    ? body.status.trim()
    : "signed";
  const actor = auth.actor.id;
  const signedAt = Date.now();
  const canonical = canonicalize({ actor, signedAt, status });
  const signature = sign(secret, canonical);

  const store = resolveSettingsStore(request);
  store.setSetting(
    PROMOTION_AUDIT_SETTING_KEY,
    { actor, signedAt, status, signature, items: body.items ?? null },
    { actor, reason: "pre-promotion Security_Access_Audit sign-off" }
  );

  return Response.json(
    {
      ok: true,
      record: { actor, signedAt, status, signature },
      verified: true,
    },
    { status: 201 }
  );
}
