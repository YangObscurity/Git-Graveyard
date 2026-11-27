import * as crypto from "node:crypto";
import { resolveSettingsStore } from "@/lib/runtime/store-context";
import {
  PROMOTION_AUDIT_SETTING_KEY,
  getAdminSecret,
  requireAdminAuth,
} from "@/lib/admin/admin-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  items: unknown;
}

async function readBody(request: Request): Promise<PromotionAuditBody> {
  try {
    const parsed = (await request.json()) as PromotionAuditBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Recursively sorts object keys so the signed payload is stable regardless of key insertion order. */
function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    // A null-prototype accumulator so assigning a `__proto__` key can never reach `Object.prototype`.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      // Skip prototype-pollution keys entirely: they are never legitimate signed payload members.
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      out[key] = canonicalizeValue(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Returns a plain-object copy of `items` with prototype-pollution keys removed. Unlike
 * {@link canonicalizeValue} this preserves insertion order and a normal `Object.prototype`, so the
 * persisted record deep-equals the caller-supplied items while never carrying `__proto__` /
 * `constructor` / `prototype`.
 */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      out[key] = sanitizeValue(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * True when `value` contains a reserved prototype-pollution key (`__proto__`, `constructor`,
 * `prototype`) as an own property anywhere in its nested structure. `canonicalizeValue` strips these
 * keys before signing, so a record whose stored `items` carry one would otherwise verify against a
 * payload that never actually covered the unsigned nested key.
 */
function containsReservedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsReservedKey);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return true;
      }
      if (containsReservedKey(source[key])) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Canonical signed payload. `items` is part of the HMAC-covered content, so altering the stored
 * `items` (audit checkbox set) invalidates `verified`.
 */
function canonicalize(record: Omit<PromotionAuditRecord, "signature">): string {
  return JSON.stringify(
    canonicalizeValue({
      actor: record.actor,
      signedAt: record.signedAt,
      status: record.status,
      items: record.items ?? null,
    })
  );
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
    items: record.items ?? null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const store = resolveSettingsStore(request);
  const record = asRecord(store.getSetting(PROMOTION_AUDIT_SETTING_KEY));
  const secret = getAdminSecret();
  let verified = false;
  if (record && secret) {
    // A nested reserved key would have been stripped from the signed payload, so the record cannot
    // be proven authentic: report it as unverified rather than accepting the stripped signature.
    if (!containsReservedKey(record.items)) {
      const expected = sign(secret, canonicalize(record));
      const expectedBuf = Buffer.from(expected, "utf8");
      const actualBuf = Buffer.from(record.signature, "utf8");
      try {
        verified =
          expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
      } catch {
        verified = false;
      }
    }
  }
  return Response.json({ ok: true, record, verified, present: record !== null });
}

export async function POST(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
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
  // Strip prototype-pollution keys before the items are signed AND stored, so neither the signature
  // nor the persisted record can carry `__proto__` / `constructor` / `prototype`.
  const items = sanitizeValue(body.items ?? null);
  const canonical = canonicalize({ actor, signedAt, status, items });
  const signature = sign(secret, canonical);

  const store = resolveSettingsStore(request);
  store.setSetting(
    PROMOTION_AUDIT_SETTING_KEY,
    { actor, signedAt, status, signature, items },
    { actor, reason: "pre-promotion Security_Access_Audit sign-off" }
  );

  return Response.json(
    {
      ok: true,
      record: { actor, signedAt, status, signature, items },
      verified: true,
    },
    { status: 201 }
  );
}
