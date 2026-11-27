import { resolveSettingsStore } from "@/lib/runtime/store-context";
import { requireAdminAuth } from "@/lib/admin/admin-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SettingsBody {
  settings?: unknown;
  key?: unknown;
  value?: unknown;
  reason?: unknown;
}

async function readBody(request: Request): Promise<SettingsBody> {
  try {
    const parsed = (await request.json()) as SettingsBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function collectUpdates(body: SettingsBody): {
  updates: Record<string, unknown>;
  reason: string | undefined;
} {
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  if (body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) {
    return { updates: { ...(body.settings as Record<string, unknown>) }, reason };
  }
  if (typeof body.key === "string" && body.key.trim().length > 0) {
    return { updates: { [body.key.trim()]: body.value }, reason };
  }
  return { updates: {}, reason };
}

export async function GET(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const store = resolveSettingsStore(request);
  const validation = store.validateRequiredSettings();
  return Response.json({
    ok: true,
    settings: store.getAllSettings(),
    required: validation,
    missingRequiredSettings: validation.missing,
    auditLog: store.getAuditLog({ limit: 100 }),
  });
}

async function update(request: Request): Promise<Response> {
  const settingsStore = resolveSettingsStore(request);
  const auth = requireAdminAuth(request, process.env, { settingsStore });
  if (!auth.ok) {
    return auth.response;
  }
  const body = await readBody(request);
  const { updates, reason } = collectUpdates(body);
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return Response.json({ ok: false, error: "no_settings_provided" }, { status: 400 });
  }

  const store = resolveSettingsStore(request);
  try {
    const entries = store.setSettingsBatch(updates, { actor: auth.actor.id, reason });
    return Response.json({ ok: true, updated: entries, settings: store.getAllSettings() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_setting";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request): Promise<Response> {
  return update(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return update(request);
}
