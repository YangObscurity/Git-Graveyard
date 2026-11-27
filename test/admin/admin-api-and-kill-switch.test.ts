// Task 22.5 tests: Admin session (V20), /api/admin/* routes and the kill switch.
// Validates: Requirements 28.3, 30.18, 31.1, 31.14, 32.3, 33.4, 39.10, 39.11.
import test, { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";
import { SettingsStore, ALWAYS_REQUIRED_SETTING_KEYS } from "@/lib/admin/settings-store";
import {
  ADMIN_REVOKED_SESSIONS_SETTING_KEY,
  AdminRevocationStoreError,
  DIRECT_CLIENT_IP_KEY,
  PROMOTION_AUDIT_SETTING_KEY,
  clientIpFromRequest,
  isAdminSessionRevoked,
  resetAdminSessionState,
  revokeAdminSession,
} from "@/lib/admin/admin-session";
import { resetFifoQueueRegistry, resolveFifoQueue } from "@/lib/admission/fifo-queue";
import {
  KillSwitchService,
  resetKillSwitchRegistry,
  type KillSwitchLevel,
} from "@/lib/admin/kill-switch";

import {
  GET as sessionGet,
  POST as sessionPost,
  DELETE as sessionDelete,
} from "@/app/api/admin/session/route";
import { GET as inviteGet, POST as invitePost } from "@/app/api/admin/invite-codes/route";
import { GET as settingsGet, PATCH as settingsPatch } from "@/app/api/admin/settings/route";
import { GET as queueGet, POST as queuePost } from "@/app/api/admin/queue/route";
import { POST as startRunPost } from "@/app/api/start-run/route";
import { POST as runActionPost } from "@/app/api/admin/runs/[runId]/route";
import { GET as killGet, POST as killPost } from "@/app/api/admin/kill-switch/route";
import { GET as promoGet, POST as promoPost } from "@/app/api/admin/promotion-audit/route";

const ADMIN_SECRET = "test-admin-secret-value";

interface Stores {
  db: DatabaseSync;
  runStore: RunStore;
  eventStore: EventStore;
  settingsStore: SettingsStore;
}

let stores: Stores;
let savedEnv: NodeJS.ProcessEnv;

function makeStores(): Stores {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    runStore: new RunStore(db),
    eventStore: new EventStore(db),
    settingsStore: new SettingsStore(":memory:"),
  };
}

function attach<T extends Request>(
  request: T,
  overrides: Partial<Pick<Stores, "runStore" | "eventStore" | "settingsStore">> = {}
): T {
  const target = request as unknown as Record<string, unknown>;
  target.runStore = overrides.runStore ?? stores.runStore;
  target.eventStore = overrides.eventStore ?? stores.eventStore;
  target.settingsStore = overrides.settingsStore ?? stores.settingsStore;
  return request;
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-admin-token": ADMIN_SECRET, ...extra };
}

function jsonRequest(
  url: string,
  body: unknown,
  init: { method: string; headers?: Record<string, string> }
): Request {
  return new Request(url, {
    method: init.method,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0].trim();
}

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  delete process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_KEY;
  delete process.env.ADMIN_ACTOR_ID;
  resetAdminSessionState();
  resetFifoQueueRegistry();
  resetKillSwitchRegistry();
  stores = makeStores();

  // Reset the process-wide live wiring so start-run / queue / kill-switch tests stay isolated.
  const g = globalThis as unknown as {
    __admissionQueue?: unknown[];
    __admission?: unknown;
    __runOrchestrator?: unknown;
  };
  if (Array.isArray(g.__admissionQueue)) {
    g.__admissionQueue.length = 0;
  }
  g.__admission = {
    isPaused: () => false,
    isUnavailable: () => false,
    isHealthy: () => true,
    getQueueLength: () => 0,
  };
  delete g.__runOrchestrator;
});

afterEach(() => {
  process.env = savedEnv;
  resetAdminSessionState();
  resetFifoQueueRegistry();
  resetKillSwitchRegistry();
  const g = globalThis as unknown as { __runOrchestrator?: unknown };
  delete g.__runOrchestrator;
  try {
    stores.db.close();
  } catch {
    // ignore
  }
});

describe("Admin session and /api/admin/* authentication (Task 22.5)", () => {
  it("fails closed (503) on guarded routes when the admin secret is unconfigured", async () => {
    delete process.env.ADMIN_SECRET;
    const invite = await inviteGet(attach(new Request("http://test/api/admin/invite-codes")));
    assert.equal(invite.status, 503);
    const settings = await settingsGet(attach(new Request("http://test/api/admin/settings")));
    assert.equal(settings.status, 503);
    const queue = await queueGet(attach(new Request("http://test/api/admin/queue")));
    assert.equal(queue.status, 503);
    const kill = await killGet(attach(new Request("http://test/api/admin/kill-switch")));
    assert.equal(kill.status, 503);
  });

  it("refuses every guarded route without a valid credential (401)", async () => {
    const checks: Array<Promise<Response>> = [
      inviteGet(attach(new Request("http://test/api/admin/invite-codes"))),
      settingsGet(attach(new Request("http://test/api/admin/settings"))),
      queueGet(attach(new Request("http://test/api/admin/queue"))),
      killGet(attach(new Request("http://test/api/admin/kill-switch"))),
      promoGet(attach(new Request("http://test/api/admin/promotion-audit"))),
      runActionPost(
        attach(
          jsonRequest("http://test/api/admin/runs/run-x", { action: "review" }, { method: "POST" })
        ),
        { params: { runId: "run-x" } }
      ),
    ];
    for (const response of await Promise.all(checks)) {
      assert.equal(response.status, 401);
    }

    const wrong = await inviteGet(
      attach(
        new Request("http://test/api/admin/invite-codes", {
          headers: { "x-admin-token": "nope" },
        })
      )
    );
    assert.equal(wrong.status, 401);
  });

  it("refuses every guarded mutating route without a credential (401)", async () => {
    const postJson = (url: string, method: string): Request =>
      new Request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

    const checks: Array<Promise<Response>> = [
      invitePost(attach(postJson("http://test/api/admin/invite-codes", "POST"))),
      settingsPatch(attach(postJson("http://test/api/admin/settings", "PATCH"))),
      queuePost(attach(postJson("http://test/api/admin/queue", "POST"))),
      killPost(attach(postJson("http://test/api/admin/kill-switch", "POST"))),
      promoPost(attach(postJson("http://test/api/admin/promotion-audit", "POST"))),
      sessionDelete(
        attach(new Request("http://test/api/admin/session", { method: "DELETE" }))
      ),
    ];

    for (const response of await Promise.all(checks)) {
      assert.equal(response.status, 401);
    }
  });

  it("accepts a timing-safe x-admin-token and issues an HMAC session cookie", async () => {
    const listRes = await inviteGet(
      attach(new Request("http://test/api/admin/invite-codes", { headers: adminHeaders() }))
    );
    assert.equal(listRes.status, 200);

    const signIn = await sessionPost(
      new Request("http://test/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ADMIN_SECRET }),
      })
    );
    assert.equal(signIn.status, 200);
    const setCookie = signIn.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("gg_admin_session="));
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("SameSite=Strict"));
    assert.ok(setCookie.includes("Path=/"));

    const cookie = cookieFrom(signIn);
    const withCookie = await inviteGet(
      attach(new Request("http://test/api/admin/invite-codes", { headers: { cookie } }))
    );
    assert.equal(withCookie.status, 200);

    const badLogin = await sessionPost(
      new Request("http://test/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong" }),
      })
    );
    assert.equal(badLogin.status, 401);

    const signOut = await sessionDelete(
      new Request("http://test/api/admin/session", { method: "DELETE", headers: { cookie } })
    );
    assert.equal(signOut.status, 200);
    const afterSignOut = await inviteGet(
      attach(new Request("http://test/api/admin/invite-codes", { headers: { cookie } }))
    );
    assert.equal(afterSignOut.status, 403);

    const status = await sessionGet(attach(new Request("http://test/api/admin/session")));
    assert.equal(status.status, 200);
    const statusBody = (await status.json()) as { authenticated: boolean };
    assert.equal(statusBody.authenticated, false);
  });

  it("persists admin session revocation through the SettingsStore across a cold start", async () => {
    const signIn = await sessionPost(
      new Request("http://test/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ADMIN_SECRET }),
      })
    );
    assert.equal(signIn.status, 200);
    const cookie = cookieFrom(signIn);

    const signOut = await sessionDelete(
      attach(
        new Request("http://test/api/admin/session", { method: "DELETE", headers: { cookie } })
      )
    );
    assert.equal(signOut.status, 200);
    const { revokedSessionId } = (await signOut.json()) as { revokedSessionId: string | null };
    assert.ok(revokedSessionId);

    // The revocation was written to the shared SettingsStore.
    const persisted = stores.settingsStore.getSetting<{
      sessions?: Array<{ sessionId: string }>;
    }>(ADMIN_REVOKED_SESSIONS_SETTING_KEY);
    assert.ok(
      persisted?.sessions?.some((session) => session.sessionId === revokedSessionId)
    );

    // A fresh instance (in-memory revocations cleared) still rejects the cookie.
    resetAdminSessionState();
    const afterRestart = await inviteGet(
      attach(new Request("http://test/api/admin/invite-codes", { headers: { cookie } }))
    );
    assert.equal(afterRestart.status, 403);
  });

  it("fails closed when the persisted revocation payload is malformed", () => {
    // A non-object payload is malformed rather than "no revocations".
    stores.settingsStore.setSetting(ADMIN_REVOKED_SESSIONS_SETTING_KEY, "not-an-object", {
      actor: "owner",
    });
    assert.throws(
      () => isAdminSessionRevoked("sid-1", { settingsStore: stores.settingsStore }),
      AdminRevocationStoreError
    );

    // An object whose `sessions` is not an array is malformed as well.
    stores.settingsStore.setSetting(ADMIN_REVOKED_SESSIONS_SETTING_KEY, { sessions: "nope" }, {
      actor: "owner",
    });
    assert.throws(
      () => isAdminSessionRevoked("sid-2", { settingsStore: stores.settingsStore }),
      AdminRevocationStoreError
    );

    // An absent payload is simply "no revocations" and must not throw.
    stores.settingsStore.setSetting(ADMIN_REVOKED_SESSIONS_SETTING_KEY, null, { actor: "owner" });
    assert.equal(
      isAdminSessionRevoked("sid-3", { settingsStore: stores.settingsStore }),
      false
    );
  });

  it("persists several revocations without losing any to a read-modify-write race", () => {
    const settingsStore = stores.settingsStore;
    revokeAdminSession("session-a", { settingsStore, now: 1000, expiresAt: 9_999_999_999_999 });
    revokeAdminSession("session-b", { settingsStore, now: 1000, expiresAt: 9_999_999_999_999 });
    revokeAdminSession("session-c", { settingsStore, now: 1000, expiresAt: 9_999_999_999_999 });

    const persisted = settingsStore.getSetting<{ sessions?: Array<{ sessionId: string }> }>(
      ADMIN_REVOKED_SESSIONS_SETTING_KEY
    );
    const ids = (persisted?.sessions ?? []).map((session) => session.sessionId);
    assert.ok(ids.includes("session-a"));
    assert.ok(ids.includes("session-b"));
    assert.ok(ids.includes("session-c"));
  });

  it("derives the session actor from a server-trusted principal, ignoring body.actor", async () => {
    const spoof = await sessionPost(
      new Request("http://test/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ADMIN_SECRET, actor: "attacker" }),
      })
    );
    assert.equal(spoof.status, 200);
    const spoofBody = (await spoof.json()) as { actor: { id: string } };
    assert.equal(spoofBody.actor.id, "owner");

    const cookie = cookieFrom(spoof);
    const status = await sessionGet(
      attach(new Request("http://test/api/admin/session", { headers: { cookie } }))
    );
    const statusBody = (await status.json()) as { actor: { id: string } | null };
    assert.equal(statusBody.actor?.id, "owner");

    // A configured server principal wins over both the caller body and the default.
    process.env.ADMIN_ACTOR_ID = "principal-7";
    try {
      const bound = await sessionPost(
        new Request("http://test/api/admin/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: ADMIN_SECRET, actor: "attacker" }),
        })
      );
      const boundBody = (await bound.json()) as { actor: { id: string } };
      assert.equal(boundBody.actor.id, "principal-7");
    } finally {
      delete process.env.ADMIN_ACTOR_ID;
    }
  });

  it("falls through a blank ADMIN_SECRET to ADMIN_TOKEN / ADMIN_KEY and fails closed when all blank", async () => {
    // An empty ADMIN_SECRET must not shadow a configured ADMIN_TOKEN.
    process.env.ADMIN_SECRET = "";
    process.env.ADMIN_TOKEN = "token-secret-value";
    try {
      const viaToken = await inviteGet(
        attach(
          new Request("http://test/api/admin/invite-codes", {
            headers: { "x-admin-token": "token-secret-value" },
          })
        )
      );
      assert.equal(viaToken.status, 200);
    } finally {
      delete process.env.ADMIN_TOKEN;
    }

    // A whitespace-only ADMIN_SECRET also falls through, this time to ADMIN_KEY.
    process.env.ADMIN_SECRET = "   ";
    process.env.ADMIN_KEY = "key-secret-value";
    try {
      const viaKey = await inviteGet(
        attach(
          new Request("http://test/api/admin/invite-codes", {
            headers: { "x-admin-token": "key-secret-value" },
          })
        )
      );
      assert.equal(viaKey.status, 200);
    } finally {
      delete process.env.ADMIN_KEY;
    }

    // With every candidate blank/whitespace the module fails closed (503).
    process.env.ADMIN_SECRET = "   ";
    const unconfigured = await inviteGet(
      attach(
        new Request("http://test/api/admin/invite-codes", {
          headers: { "x-admin-token": "anything" },
        })
      )
    );
    assert.equal(unconfigured.status, 503);
  });
});


describe("Admin invite codes, settings and queue routes (Task 22.5)", () => {
  it("creates an invite code once and lists it without salt or plaintext", async () => {
    const createRes = await invitePost(
      attach(
        jsonRequest(
          "http://test/api/admin/invite-codes",
          { allowedRunCount: 2, caps: { maxMinutes: 15 } },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { code: string; record: Record<string, unknown> };
    assert.ok(created.code.startsWith("gg_"));
    assert.ok(!Object.prototype.hasOwnProperty.call(created.record, "salt"));

    const listRes = await inviteGet(
      attach(new Request("http://test/api/admin/invite-codes", { headers: adminHeaders() }))
    );
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as { inviteCodes: Array<Record<string, unknown>> };
    assert.equal(list.inviteCodes.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(list.inviteCodes[0], "salt"));
    assert.ok(!JSON.stringify(list).includes(created.code));
  });

  it("rejects non-finite, non-integer and non-positive allowedRunCount with 400", async () => {
    const postRaw = async (rawBody: string): Promise<Response> =>
      invitePost(
        attach(
          new Request("http://test/api/admin/invite-codes", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...adminHeaders() },
            body: rawBody,
          })
        )
      );

    // 1e999 overflows JSON.parse to Infinity; the rest cover zero, negative, fractional and string.
    for (const raw of [
      '{"allowedRunCount":1e999}',
      '{"allowedRunCount":0}',
      '{"allowedRunCount":-2}',
      '{"allowedRunCount":2.5}',
      '{"allowedRunCount":"3"}',
    ]) {
      const res = await postRaw(raw);
      assert.equal(res.status, 400, `expected 400 for body ${raw}`);
    }

    const ok = await invitePost(
      attach(
        jsonRequest(
          "http://test/api/admin/invite-codes",
          { allowedRunCount: 3 },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(ok.status, 201);
  });

  it("records a mandatory audit entry on every budget setting update", async () => {
    const patchRes = await settingsPatch(
      attach(
        jsonRequest(
          "http://test/api/admin/settings",
          { settings: { runWallClockMs: 12345, toolCallsPerRun: 300 }, reason: "budget tune" },
          { method: "PATCH", headers: adminHeaders() }
        )
      )
    );
    assert.equal(patchRes.status, 200);

    const getRes = await settingsGet(
      attach(new Request("http://test/api/admin/settings", { headers: adminHeaders() }))
    );
    const body = (await getRes.json()) as {
      settings: Record<string, unknown>;
      auditLog: Array<{ key: string; actor: string; reason: string | null }>;
    };
    assert.equal(body.settings.runWallClockMs, 12345);
    assert.equal(body.settings.toolCallsPerRun, 300);
    // Both updated keys must each carry a mandatory audit entry with the actor and reason.
    for (const key of ["runWallClockMs", "toolCallsPerRun"]) {
      const entry = body.auditLog.find((item) => item.key === key);
      assert.ok(entry, `expected an audit entry for ${key}`);
      assert.equal(entry.actor, "owner");
      assert.equal(entry.reason, "budget tune");
    }
    assert.ok(body.auditLog.every((entry) => entry.actor.length > 0));
  });

  it("exposes the queue snapshot and applies move/remove", async () => {
    const queue = resolveFifoQueue({ eventStore: stores.eventStore, runStore: stores.runStore });
    queue.enqueue({ runId: "q1" });
    queue.enqueue({ runId: "q2" });

    const snapshotRes = await queueGet(
      attach(new Request("http://test/api/admin/queue", { headers: adminHeaders() }))
    );
    const snapshot = (await snapshotRes.json()) as { queue: { depth: number } };
    assert.equal(snapshot.queue.depth, 2);

    const moveRes = await queuePost(
      attach(
        jsonRequest(
          "http://test/api/admin/queue",
          { action: "move", runId: "q2", position: 1 },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(moveRes.status, 200);
    const moved = (await moveRes.json()) as { queue: { entries: Array<{ runId: string }> } };
    assert.equal(moved.queue.entries[0].runId, "q2");

    const removeRes = await queuePost(
      attach(
        jsonRequest(
          "http://test/api/admin/queue",
          { action: "remove", runId: "q1" },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(removeRes.status, 200);
    const removed = (await removeRes.json()) as { queue: { depth: number } };
    assert.equal(removed.queue.depth, 1);
  });
});


describe("Admin run actions: review, redact, publish, hide (Task 22.5)", () => {
  it("refuses publish until the run has been reviewed", async () => {
    stores.runStore.createRun({
      runId: "run-a",
      url: "https://example.test/a/b",
      sha: "a".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });

    const earlyPublish = await runActionPost(
      attach(
        jsonRequest(
          "http://test/api/admin/runs/run-a",
          { action: "publish" },
          { method: "POST", headers: adminHeaders() }
        )
      ),
      { params: { runId: "run-a" } }
    );
    assert.equal(earlyPublish.status, 409);

    const review = await runActionPost(
      attach(
        jsonRequest(
          "http://test/api/admin/runs/run-a",
          { action: "review" },
          { method: "POST", headers: adminHeaders() }
        )
      ),
      { params: { runId: "run-a" } }
    );
    assert.equal(review.status, 200);

    const publish = await runActionPost(
      attach(
        jsonRequest(
          "http://test/api/admin/runs/run-a",
          { action: "publish" },
          { method: "POST", headers: adminHeaders() }
        )
      ),
      { params: { runId: "run-a" } }
    );
    assert.equal(publish.status, 200);
    assert.equal(stores.runStore.getRun("run-a")?.isPublished, true);
    assert.ok(stores.eventStore.getEvents("run-a", { kind: "admin.publish" }).length >= 1);
  });

  it("redacts with a single inline-reviewed event then hides with the owner removal marker", async () => {
    stores.runStore.createRun({
      runId: "run-b",
      url: "https://example.test/a/b",
      sha: "b".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });

    const sensitive = `ghp_${"a".repeat(32)}`;
    const redact = await runActionPost(
      attach(
        jsonRequest(
          "http://test/api/admin/runs/run-b",
          { action: "redact", fields: ["logs"], reason: `redact ${sensitive}` },
          { method: "POST", headers: adminHeaders() }
        )
      ),
      { params: { runId: "run-b" } }
    );
    assert.equal(redact.status, 200);
    // A single redaction event records the review inline; no separate admin.review append is made.
    const redactionEvents = stores.eventStore.getEvents("run-b", { kind: "admin.redaction" });
    assert.equal(redactionEvents.length, 1);
    assert.equal(redactionEvents[0].data.reviewed, true);
    assert.deepEqual(redactionEvents[0].data.fields, ["logs"]);
    assert.equal(stores.eventStore.getEvents("run-b", { kind: "admin.review" }).length, 0);
    // The run is marked reviewed and records the requested redaction fields.
    const redacted = stores.runStore.getRun("run-b");
    assert.equal((redacted?.metadata as Record<string, unknown>).reviewed, true);
    assert.deepEqual(
      (redacted?.metadata as Record<string, unknown>).redactionFields,
      ["logs"]
    );
    // The sensitive token in the recorded event data is actually masked by the redactor.
    const serialized = JSON.stringify(redactionEvents[0].data);
    assert.ok(!serialized.includes(sensitive));
    assert.ok(serialized.includes("[REDACTED]"));

    const hide = await runActionPost(
      attach(
        jsonRequest(
          "http://test/api/admin/runs/run-b",
          { action: "hide" },
          { method: "POST", headers: adminHeaders() }
        )
      ),
      { params: { runId: "run-b" } }
    );
    assert.equal(hide.status, 200);
    const hidden = stores.runStore.getRun("run-b");
    assert.equal(hidden?.isRemoved, true);
    assert.equal(
      (hidden?.metadata as Record<string, unknown>).removalReason,
      "Removed by the owner"
    );
    assert.ok(stores.eventStore.getEvents("run-b", { kind: "admin.hide" }).length >= 1);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await runActionPost(
      attach(
        jsonRequest(
          "http://test/api/admin/runs/missing",
          { action: "review" },
          { method: "POST", headers: adminHeaders() }
        )
      ),
      { params: { runId: "missing" } }
    );
    assert.equal(res.status, 404);
  });

  it("rolls back the run mutation and returns 500 when the audit event cannot be appended", async () => {
    stores.runStore.createRun({
      runId: "rollback-run",
      url: "https://example.test/a/b",
      sha: "c".repeat(40),
      phase: "done",
      outcome: "resurrected",
      metadata: { reviewed: true },
    });
    assert.equal(stores.runStore.getRun("rollback-run")?.isPublished, false);

    const originalAppend = stores.eventStore.append.bind(stores.eventStore);
    (stores.eventStore as unknown as { append: unknown }).append = () => {
      throw new Error("audit store unavailable");
    };
    try {
      const res = await runActionPost(
        attach(
          jsonRequest(
            "http://test/api/admin/runs/rollback-run",
            { action: "publish" },
            { method: "POST", headers: adminHeaders() }
          )
        ),
        { params: { runId: "rollback-run" } }
      );
      assert.equal(res.status, 500);
    } finally {
      (stores.eventStore as unknown as { append: unknown }).append = originalAppend;
    }

    // The mutation was rolled back so the run row and the audit log never diverge.
    const run = stores.runStore.getRun("rollback-run");
    assert.equal(run?.isPublished, false);
    assert.equal(run?.isRemoved, false);
    assert.equal(stores.eventStore.getEvents("rollback-run", { kind: "admin.publish" }).length, 0);
  });

  it("reports a distinct 500 when both the audit append and the rollback fail", async () => {
    stores.runStore.createRun({
      runId: "rollback-fail",
      url: "https://example.test/a/b",
      sha: "d".repeat(40),
      phase: "done",
      outcome: "resurrected",
      metadata: { reviewed: true },
    });

    const originalAppend = stores.eventStore.append.bind(stores.eventStore);
    const originalUpdate = stores.runStore.updateRun.bind(stores.runStore);
    (stores.eventStore as unknown as { append: unknown }).append = () => {
      throw new Error("audit store unavailable");
    };
    let updateCalls = 0;
    (stores.runStore as unknown as { updateRun: unknown }).updateRun = (...args: unknown[]) => {
      updateCalls += 1;
      // The first updateRun is the publish mutation; the second is the rollback, which must fail.
      if (updateCalls >= 2) {
        throw new Error("rollback store unavailable");
      }
      return (originalUpdate as (...a: unknown[]) => unknown)(...args);
    };
    try {
      const res = await runActionPost(
        attach(
          jsonRequest(
            "http://test/api/admin/runs/rollback-fail",
            { action: "publish" },
            { method: "POST", headers: adminHeaders() }
          )
        ),
        { params: { runId: "rollback-fail" } }
      );
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "audit_rollback_failed");
    } finally {
      (stores.eventStore as unknown as { append: unknown }).append = originalAppend;
      (stores.runStore as unknown as { updateRun: unknown }).updateRun = originalUpdate;
    }
  });
});


describe("Kill switch (Task 22.5)", () => {
  it("previews the exact affected runs for all three levels", async () => {
    stores.runStore.createRun({
      runId: "active-1",
      url: "https://example.test/a/b",
      sha: "1".repeat(40),
      phase: "legion",
      createdAt: 1,
    });
    stores.runStore.createRun({
      runId: "queued-1",
      url: "https://example.test/a/b",
      sha: "2".repeat(40),
      phase: "queued",
      createdAt: 2,
    });

    const res = await killGet(
      attach(new Request("http://test/api/admin/kill-switch", { headers: adminHeaders() }))
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      previews: Array<{ level: string; affectedRunCount: number; affectedRunIds: string[] }>;
    };
    const byLevel = new Map(body.previews.map((preview) => [preview.level, preview]));
    assert.equal(byLevel.get("pause_new_runs")?.affectedRunCount, 1);
    assert.deepEqual(byLevel.get("pause_new_runs")?.affectedRunIds, ["queued-1"]);
    assert.equal(byLevel.get("stop_gracefully")?.affectedRunCount, 1);
    assert.deepEqual(byLevel.get("stop_gracefully")?.affectedRunIds, ["active-1"]);
    assert.equal(byLevel.get("hard_kill")?.affectedRunCount, 2);
    assert.deepEqual(byLevel.get("hard_kill")?.affectedRunIds, ["active-1", "queued-1"]);
  });

  it("requires confirmation before acting, then hard-kills and records admin.kill events", async () => {
    stores.runStore.createRun({
      runId: "active-2",
      url: "https://example.test/a/b",
      sha: "3".repeat(40),
      phase: "legion",
    });
    stores.runStore.createRun({
      runId: "queued-2",
      url: "https://example.test/a/b",
      sha: "4".repeat(40),
      phase: "queued",
    });

    const previewOnly = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "hard_kill" },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(previewOnly.status, 200);
    const previewBody = (await previewOnly.json()) as { requiresConfirmation?: boolean };
    assert.equal(previewBody.requiresConfirmation, true);
    assert.equal(stores.runStore.getRun("active-2")?.outcome, null);

    const executed = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "hard_kill", confirmed: true, reason: "test" },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(executed.status, 200);
    const execBody = (await executed.json()) as { result: { executed: boolean } };
    assert.equal(execBody.result.executed, true);
    assert.equal(stores.runStore.getRun("active-2")?.outcome, "killed");
    assert.equal(stores.runStore.getRun("active-2")?.phase, "done");
    assert.equal(stores.runStore.getRun("queued-2")?.outcome, "killed");
    assert.ok(stores.eventStore.getEvents("active-2", { kind: "admin.kill" }).length >= 1);
    assert.ok(stores.eventStore.getEvents("queued-2", { kind: "admin.kill" }).length >= 1);
  });

  it("pauses new runs while preserving the queue", async () => {
    const queue = resolveFifoQueue({ eventStore: stores.eventStore, runStore: stores.runStore });
    queue.enqueue({ runId: "queued-keep" });
    const initial = queue.snapshot();
    assert.equal(initial.depth, 1);

    const res = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "pause_new_runs", confirmed: true },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { state: { pausedNewRuns: boolean } };
    assert.equal(body.state.pausedNewRuns, true);

    const preserved = queue.snapshot();
    assert.equal(preserved.depth, initial.depth);
    assert.deepEqual(preserved.entries.map((entry) => entry.runId), ["queued-keep"]);
    assert.equal(queue.getPosition("queued-keep"), 1);
  });

  it("persists pause_new_runs across POST -> GET and the SettingsStore", async () => {
    const pause = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "pause_new_runs", confirmed: true },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(pause.status, 200);

    const get = await killGet(
      attach(new Request("http://test/api/admin/kill-switch", { headers: adminHeaders() }))
    );
    assert.equal(get.status, 200);
    const body = (await get.json()) as { state: { pausedNewRuns: boolean; lastLevel: string } };
    assert.equal(body.state.pausedNewRuns, true);
    assert.equal(body.state.lastLevel, "pause_new_runs");
    assert.equal(stores.settingsStore.getSetting("killSwitch.pauseNewRuns"), true);
    assert.equal(stores.settingsStore.getSetting("killSwitch.lastLevel"), "pause_new_runs");
  });

  it("rehydrates enforcement flags from the SettingsStore on a cold start", () => {
    stores.settingsStore.setSetting("killSwitch.pauseNewRuns", true, { actor: "owner" });
    stores.settingsStore.setSetting("killSwitch.stopGracefully", true, { actor: "owner" });
    stores.settingsStore.setSetting("killSwitch.lastLevel", "stop_gracefully", { actor: "owner" });

    const service = new KillSwitchService({
      runStore: stores.runStore,
      eventStore: stores.eventStore,
    });
    // A freshly constructed service enforces nothing until it is rehydrated.
    assert.equal(service.isPausedNewRuns(), false);
    assert.equal(service.isStoppingGracefully(), false);

    service.rehydrateState({
      pausedNewRuns: stores.settingsStore.getSetting("killSwitch.pauseNewRuns") === true,
      stoppingGracefully: stores.settingsStore.getSetting("killSwitch.stopGracefully") === true,
      lastLevel:
        (stores.settingsStore.getSetting("killSwitch.lastLevel") as KillSwitchLevel | undefined) ??
        null,
    });

    assert.equal(service.isPausedNewRuns(), true);
    assert.equal(service.isStoppingGracefully(), true);
    assert.equal(service.getState().lastLevel, "stop_gracefully");
  });

  it("keeps pause enforcement after the shared service is discarded (cold start via GET)", async () => {
    const pause = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "pause_new_runs", confirmed: true },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(pause.status, 200);

    // Simulate a new process: drop the cached service so buildService must rebuild it.
    resetKillSwitchRegistry();

    const get = await killGet(
      attach(new Request("http://test/api/admin/kill-switch", { headers: adminHeaders() }))
    );
    assert.equal(get.status, 200);
    const body = (await get.json()) as { state: { pausedNewRuns: boolean; lastLevel: string } };
    assert.equal(body.state.pausedNewRuns, true);
    assert.equal(body.state.lastLevel, "pause_new_runs");
  });

  it("rehydrates enforcement flags from the SettingsStore on every request", async () => {
    const pause = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "pause_new_runs", confirmed: true },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(pause.status, 200);

    // Simulate an out-of-band persisted change (another worker) while the cached service stays warm.
    stores.settingsStore.setSetting("killSwitch.pauseNewRuns", false, { actor: "owner" });

    const get = await killGet(
      attach(new Request("http://test/api/admin/kill-switch", { headers: adminHeaders() }))
    );
    assert.equal(get.status, 200);
    const body = (await get.json()) as { state: { pausedNewRuns: boolean } };
    // buildService rehydrates every request, so the persisted `false` wins over the cached `true`.
    assert.equal(body.state.pausedNewRuns, false);
  });

  it("reports a 500 when the kill-switch state cannot be persisted", async () => {
    const original = stores.settingsStore.setSettingsBatch.bind(stores.settingsStore);
    (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch = () => {
      throw new Error("settings store unavailable");
    };
    try {
      const res = await killPost(
        attach(
          jsonRequest(
            "http://test/api/admin/kill-switch",
            { level: "pause_new_runs", confirmed: true },
            { method: "POST", headers: adminHeaders() }
          )
        )
      );
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "kill_switch_persist_failed");
    } finally {
      (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch = original;
    }
  });

  it("records the operator as the top-level actor of the admin.kill event", () => {
    const service = new KillSwitchService({
      runStore: stores.runStore,
      eventStore: stores.eventStore,
    });
    service.execute("pause_new_runs", { actor: "ops-7", reason: "drill" });

    const events = stores.eventStore.getEvents("system", { kind: "admin.kill" });
    assert.ok(events.length >= 1);
    assert.equal(events[events.length - 1].actor, "ops-7");
  });

  it("keeps an active pause authoritative when the kill-switch state cannot be persisted", async () => {
    const original = stores.settingsStore.setSettingsBatch.bind(stores.settingsStore);
    (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch = () => {
      throw new Error("settings store unavailable");
    };
    try {
      const res = await killPost(
        attach(
          jsonRequest(
            "http://test/api/admin/kill-switch",
            { level: "pause_new_runs", confirmed: true },
            { method: "POST", headers: adminHeaders() }
          )
        )
      );
      assert.equal(res.status, 500);
    } finally {
      (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch = original;
    }

    // The write failed, so nothing was persisted — but the in-memory pause must survive the next
    // request's rehydrate instead of being silently reverted from the (stale) empty store.
    assert.equal(stores.settingsStore.getSetting("killSwitch.pauseNewRuns"), undefined);
    const get = await killGet(
      attach(new Request("http://test/api/admin/kill-switch", { headers: adminHeaders() }))
    );
    assert.equal(get.status, 200);
    const body = (await get.json()) as { state: { pausedNewRuns: boolean } };
    assert.equal(body.state.pausedNewRuns, true);
  });

  it("clears unpersisted authority after a later successful persist so rehydration resumes", async () => {
    // First persist attempt fails: the in-memory pause becomes authoritative for this store.
    const original = stores.settingsStore.setSettingsBatch.bind(stores.settingsStore);
    (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch = () => {
      throw new Error("settings store unavailable");
    };
    try {
      const failed = await killPost(
        attach(
          jsonRequest(
            "http://test/api/admin/kill-switch",
            { level: "pause_new_runs", confirmed: true },
            { method: "POST", headers: adminHeaders() }
          )
        )
      );
      assert.equal(failed.status, 500);
      assert.equal(
        (await failed.json() as { error?: string }).error,
        "kill_switch_persist_failed"
      );
    } finally {
      (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch = original;
    }
    // Nothing was persisted, so the store still has no pause value.
    assert.equal(stores.settingsStore.getSetting("killSwitch.pauseNewRuns"), undefined);

    // A later request whose persist SUCCEEDS must clear the unpersisted-authority mark.
    const recovered = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "pause_new_runs", confirmed: true },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(recovered.status, 200);
    assert.equal(stores.settingsStore.getSetting("killSwitch.pauseNewRuns"), true);

    // With the mark cleared, a later out-of-band SettingsStore change wins on GET...
    stores.settingsStore.setSetting("killSwitch.pauseNewRuns", false, { actor: "owner" });
    const get = await killGet(
      attach(new Request("http://test/api/admin/kill-switch", { headers: adminHeaders() }))
    );
    assert.equal(get.status, 200);
    const getBody = (await get.json()) as { state: { pausedNewRuns: boolean } };
    assert.equal(getBody.state.pausedNewRuns, false);

    // ...and on a subsequent POST, which rehydrates the persisted `false` before it acts. Every
    // kill-switch level now persists `pauseNewRuns = true`, so the response must report `true` — the
    // rehydrated `false` was replaced by `execute`, and the stale in-memory `true` no longer leaks.
    const post = await killPost(
      attach(
        jsonRequest(
          "http://test/api/admin/kill-switch",
          { level: "hard_kill", confirmed: true },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(post.status, 200);
    const postBody = (await post.json()) as { state: { pausedNewRuns: boolean } };
    assert.equal(postBody.state.pausedNewRuns, true);
    assert.equal(stores.settingsStore.getSetting("killSwitch.pauseNewRuns"), true);
  });

  it("excludes finished (done) runs from stop_gracefully preview and execute", () => {
    const runs = [
      { runId: "running-1", phase: "legion", outcome: null, createdAt: 1 },
      { runId: "done-1", phase: "done", outcome: "resurrected", createdAt: 2 },
      { runId: "queued-1", phase: "queued", outcome: null, createdAt: 3 },
    ];
    const fakeRunStore = {
      getLivingRuns: () => runs,
      getRun: (runId: string) => runs.find((run) => run.runId === runId) ?? null,
      updateRun: () => undefined,
    };
    const service = new KillSwitchService({
      runStore: fakeRunStore as unknown as RunStore,
      eventStore: stores.eventStore,
    });

    const preview = service.preview("stop_gracefully");
    assert.equal(preview.affectedRunCount, 1);
    assert.deepEqual(preview.affectedRunIds, ["running-1"]);

    const result = service.execute("stop_gracefully", { actor: "ops-1" });
    assert.equal(result.affectedRunCount, 1);
    assert.deepEqual(result.affectedRunIds, ["running-1"]);
    // The finished run received no stop request.
    assert.equal(stores.eventStore.getEvents("done-1", { kind: "system.worker_state" }).length, 0);
    assert.ok(stores.eventStore.getEvents("running-1", { kind: "system.worker_state" }).length >= 1);
  });
});

describe("Promotion audit sign-off (Task 22.5)", () => {
  it("stores a signed record and verifies it on read", async () => {
    const post = await promoPost(
      attach(
        jsonRequest(
          "http://test/api/admin/promotion-audit",
          { status: "passed" },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(post.status, 201);
    const posted = (await post.json()) as {
      verified: boolean;
      record: { actor: string; status: string; signature: string };
    };
    assert.equal(posted.verified, true);
    assert.equal(posted.record.status, "passed");
    assert.equal(posted.record.actor, "owner");
    assert.ok(posted.record.signature.length > 0);

    const get = await promoGet(
      attach(new Request("http://test/api/admin/promotion-audit", { headers: adminHeaders() }))
    );
    assert.equal(get.status, 200);
    const body = (await get.json()) as {
      present: boolean;
      verified: boolean;
      record: { signature: string };
    };
    assert.equal(body.present, true);
    assert.equal(body.verified, true);
    assert.equal(body.record.signature, posted.record.signature);
  });

  it("returns verified:false without throwing for a non-ASCII signature", async () => {
    stores.settingsStore.setSetting(
      PROMOTION_AUDIT_SETTING_KEY,
      {
        actor: "owner",
        signedAt: Date.now(),
        status: "passed",
        signature: "→".repeat(64),
      },
      { actor: "owner" }
    );

    const res = await promoGet(
      attach(new Request("http://test/api/admin/promotion-audit", { headers: adminHeaders() }))
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { present: boolean; verified: boolean };
    assert.equal(body.present, true);
    assert.equal(body.verified, false);
  });

  it("invalidates verified when the stored promotion-audit items are modified", async () => {
    const post = await promoPost(
      attach(
        jsonRequest(
          "http://test/api/admin/promotion-audit",
          { status: "passed", items: { checks: ["a", "b"], score: 7 } },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(post.status, 201);
    const posted = (await post.json()) as { verified: boolean; record: { items: unknown } };
    assert.equal(posted.verified, true);
    assert.deepEqual(posted.record.items, { checks: ["a", "b"], score: 7 });

    // The untampered record verifies and exposes its items.
    const untampered = await promoGet(
      attach(new Request("http://test/api/admin/promotion-audit", { headers: adminHeaders() }))
    );
    const untamperedBody = (await untampered.json()) as {
      verified: boolean;
      record: { items: unknown };
    };
    assert.equal(untamperedBody.verified, true);
    assert.deepEqual(untamperedBody.record.items, { checks: ["a", "b"], score: 7 });

    // Tamper the stored items; the HMAC (which now covers items) no longer matches.
    const stored = stores.settingsStore.getSetting<Record<string, unknown>>(PROMOTION_AUDIT_SETTING_KEY);
    assert.ok(stored);
    stores.settingsStore.setSetting(
      PROMOTION_AUDIT_SETTING_KEY,
      { ...stored, items: { checks: ["a", "b", "evil"], score: 7 } },
      { actor: "attacker" }
    );

    const tampered = await promoGet(
      attach(new Request("http://test/api/admin/promotion-audit", { headers: adminHeaders() }))
    );
    assert.equal(tampered.status, 200);
    const tamperedBody = (await tampered.json()) as {
      present: boolean;
      verified: boolean;
      record: { items: unknown };
    };
    assert.equal(tamperedBody.present, true);
    assert.equal(tamperedBody.verified, false);
    assert.deepEqual(tamperedBody.record.items, { checks: ["a", "b", "evil"], score: 7 });
  });

  it("rejects prototype-pollution keys in the signed items without mutating Object.prototype", async () => {
    // A `__proto__` own property (as produced by JSON.parse) must never reach a prototype.
    const items = JSON.parse(
      '{"checks":["a"],"__proto__":{"polluted":"yes"},"constructor":{"x":1}}'
    ) as Record<string, unknown>;
    const post = await promoPost(
      attach(
        jsonRequest(
          "http://test/api/admin/promotion-audit",
          { status: "passed", items },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(post.status, 201);
    const posted = (await post.json()) as { verified: boolean; record: { items: unknown } };
    assert.equal(posted.verified, true);

    // The persisted items are stripped of the prototype-pollution keys.
    const stored = stores.settingsStore.getSetting<{ items: Record<string, unknown> }>(
      PROMOTION_AUDIT_SETTING_KEY
    );
    assert.ok(stored);
    assert.ok(!Object.prototype.hasOwnProperty.call(stored.items, "__proto__"));
    assert.ok(!Object.prototype.hasOwnProperty.call(stored.items, "constructor"));
    assert.deepEqual(Object.keys(stored.items), ["checks"]);
    const postedItems = posted.record.items as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(postedItems, "__proto__"));
    assert.ok(!Object.prototype.hasOwnProperty.call(postedItems, "constructor"));

    // The record still verifies on read and no global prototype was polluted.
    const get = await promoGet(
      attach(new Request("http://test/api/admin/promotion-audit", { headers: adminHeaders() }))
    );
    const body = (await get.json()) as { verified: boolean };
    assert.equal(body.verified, true);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  });
});

describe("Admin client identity (Task 22.5)", () => {
  it("ignores X-Forwarded-For / X-Real-IP unless the proxy is explicitly trusted", () => {
    const previous = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      const spoofed = new Request("http://test/api/admin/session", {
        headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-real-ip": "203.0.113.8" },
      });

      assert.equal(DIRECT_CLIENT_IP_KEY, "direct");
      assert.equal(clientIpFromRequest(spoofed), "direct");
      // The trusted proxy overwrites X-Real-IP with the single client IP, so it wins.
      assert.equal(clientIpFromRequest(spoofed, { trustProxy: true }), "203.0.113.8");

      const env = { ...process.env, TRUST_PROXY: "true" };
      assert.equal(clientIpFromRequest(spoofed, { env }), "203.0.113.8");
      assert.equal(clientIpFromRequest(spoofed, { trustProxy: false }), "direct");
    } finally {
      if (previous === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = previous;
      }
    }
  });

  it("prefers the rightmost non-empty X-Forwarded-For hop when X-Real-IP is absent", () => {
    const withoutRealIp = new Request("http://test/api/admin/session", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    // The rightmost entry is appended by the trusted proxy; the leftmost is client-spoofable.
    assert.equal(clientIpFromRequest(withoutRealIp, { trustProxy: true }), "10.0.0.1");

    const trailingEmpty = new Request("http://test/api/admin/session", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1, " },
    });
    assert.equal(clientIpFromRequest(trailingEmpty, { trustProxy: true }), "10.0.0.1");

    const blankRealIp = new Request("http://test/api/admin/session", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-real-ip": "   " },
    });
    assert.equal(clientIpFromRequest(blankRealIp, { trustProxy: true }), "10.0.0.1");

    const single = new Request("http://test/api/admin/session", {
      headers: { "x-forwarded-for": "198.51.100.4" },
    });
    assert.equal(clientIpFromRequest(single, { trustProxy: true }), "198.51.100.4");
  });
});


describe("Admin session GET hardening (Task 22.5)", () => {
  it("marks both authenticated and unauthenticated session reads with Cache-Control: no-store", async () => {
    const unauthenticated = await sessionGet(attach(new Request("http://test/api/admin/session")));
    assert.equal(unauthenticated.status, 200);
    assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
    const unauthBody = (await unauthenticated.json()) as { authenticated: boolean };
    assert.equal(unauthBody.authenticated, false);

    const signIn = await sessionPost(
      new Request("http://test/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ADMIN_SECRET }),
      })
    );
    const cookie = cookieFrom(signIn);
    const authenticated = await sessionGet(
      attach(new Request("http://test/api/admin/session", { headers: { cookie } }))
    );
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get("cache-control"), "no-store");
    const authBody = (await authenticated.json()) as { authenticated: boolean };
    assert.equal(authBody.authenticated, true);
  });

  it("reports a configured authorization outage distinctly from an unconfigured deployment", async () => {
    const signIn = await sessionPost(
      new Request("http://test/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ADMIN_SECRET }),
      })
    );
    const cookie = cookieFrom(signIn);

    // The admin secret is configured, but reading the revocation store fails: this is a transient
    // authorization outage, not an unconfigured deployment.
    const brokenStore = {
      getSetting: (key: string) => {
        if (key === ADMIN_REVOKED_SESSIONS_SETTING_KEY) {
          throw new Error("revocation store unavailable");
        }
        return undefined;
      },
    } as unknown as SettingsStore;

    const outage = await sessionGet(
      attach(new Request("http://test/api/admin/session", { headers: { cookie } }), {
        settingsStore: brokenStore,
      })
    );
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get("cache-control"), "no-store");
    const outageBody = (await outage.json()) as { error: string; configured: boolean };
    assert.equal(outageBody.error, "admin_authorization_unavailable");
    assert.equal(outageBody.configured, true);

    // With no secret configured at all the module stays on the unconfigured path.
    delete process.env.ADMIN_SECRET;
    delete process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_KEY;
    const unconfigured = await sessionGet(attach(new Request("http://test/api/admin/session")));
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.headers.get("cache-control"), "no-store");
    const unconfiguredBody = (await unconfigured.json()) as {
      error: string;
      configured: boolean;
    };
    assert.equal(unconfiguredBody.error, "admin_auth_unconfigured");
    assert.equal(unconfiguredBody.configured, false);
  });
});


describe("Admin redaction field validation (Task 22.5)", () => {
  it("rejects non-string / empty redaction fields with 400 while keeping valid names working", async () => {
    stores.runStore.createRun({
      runId: "redact-fields",
      url: "https://example.test/a/b",
      sha: "f".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });

    const post = (fields: unknown): Promise<Response> =>
      runActionPost(
        attach(
          jsonRequest(
            "http://test/api/admin/runs/redact-fields",
            { action: "redact", fields },
            { method: "POST", headers: adminHeaders() }
          )
        ),
        { params: { runId: "redact-fields" } }
      );

    const invalid = await post([{ object: true }]);
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { error: string }).error,
      "invalid_redaction_fields"
    );

    assert.equal((await post([123])).status, 400);
    assert.equal((await post([""])).status, 400);
    assert.equal((await post(["   "])).status, 400);
    assert.equal((await post("logs")).status, 400);

    // No run metadata or audit event was written for any rejected request.
    assert.equal(
      stores.eventStore.getEvents("redact-fields", { kind: "admin.redaction" }).length,
      0
    );

    const ok = await post(["logs"]);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { ok: boolean }).ok, true);
    assert.deepEqual(
      (stores.runStore.getRun("redact-fields")?.metadata as Record<string, unknown>)
        .redactionFields,
      ["logs"]
    );
  });
});


describe("Admin invite-code body validation (Task 22.5)", () => {
  it("rejects malformed JSON with 400 without minting a code, but keeps empty/{} bodies working", async () => {
    const postRaw = (rawBody: string): Promise<Response> =>
      invitePost(
        attach(
          new Request("http://test/api/admin/invite-codes", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...adminHeaders() },
            body: rawBody,
          })
        )
      );

    const malformed = await postRaw("{not-json");
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: string }).error, "invalid_json_body");

    assert.equal((await postRaw("[1,2,3]")).status, 400);

    // Nothing was created by the rejected requests.
    const listAfterReject = await inviteGet(
      attach(new Request("http://test/api/admin/invite-codes", { headers: adminHeaders() }))
    );
    assert.equal(
      ((await listAfterReject.json()) as { inviteCodes: unknown[] }).inviteCodes.length,
      0
    );

    // A genuinely empty body and a valid `{}` both fall back to the default creation behaviour.
    const empty = await invitePost(
      attach(
        new Request("http://test/api/admin/invite-codes", { method: "POST", headers: adminHeaders() })
      )
    );
    assert.equal(empty.status, 201);

    const emptyObject = await invitePost(
      attach(
        jsonRequest(
          "http://test/api/admin/invite-codes",
          {},
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(emptyObject.status, 201);

    const listAfterOk = await inviteGet(
      attach(new Request("http://test/api/admin/invite-codes", { headers: adminHeaders() }))
    );
    assert.equal(
      ((await listAfterOk.json()) as { inviteCodes: unknown[] }).inviteCodes.length,
      2
    );
  });
});


describe("Admin settings error separation (Task 22.5)", () => {
  it("returns 400 for rejected values, 500 for storage failures and a distinct post-commit readback 500", async () => {
    const patch = (body: unknown): Promise<Response> =>
      settingsPatch(
        attach(
          jsonRequest("http://test/api/admin/settings", body, {
            method: "PATCH",
            headers: adminHeaders(),
          })
        )
      );

    // A known input-validation rejection is a caller error (400) with a stable code.
    const invalid = await patch({ settings: { runWallClockMs: -1 } });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { error: string }).error, "invalid_setting");

    // A storage write failure is a 500 with a stable code and no raw driver message.
    const originalBatch = stores.settingsStore.setSettingsBatch.bind(stores.settingsStore);
    (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch = () => {
      throw new Error("disk exploded at /secret/path");
    };
    try {
      const writeFail = await patch({ settings: { runWallClockMs: 500 } });
      assert.equal(writeFail.status, 500);
      const writeBody = (await writeFail.json()) as { error: string };
      assert.equal(writeBody.error, "settings_write_failed");
      assert.ok(!JSON.stringify(writeBody).includes("disk exploded"));
    } finally {
      (stores.settingsStore as unknown as { setSettingsBatch: unknown }).setSettingsBatch =
        originalBatch;
    }

    // A readback failure after a successful commit is distinct and flags the batch as committed.
    const originalGetAll = stores.settingsStore.getAllSettings.bind(stores.settingsStore);
    (stores.settingsStore as unknown as { getAllSettings: unknown }).getAllSettings = () => {
      throw new Error("readback failed");
    };
    try {
      const readbackFail = await patch({ settings: { runWallClockMs: 600 } });
      assert.equal(readbackFail.status, 500);
      const readBody = (await readbackFail.json()) as { error: string; committed: boolean };
      assert.equal(readBody.error, "settings_committed_readback_failed");
      assert.equal(readBody.committed, true);
    } finally {
      (stores.settingsStore as unknown as { getAllSettings: unknown }).getAllSettings =
        originalGetAll;
    }

    // The committed batch survived the readback failure.
    assert.equal(stores.settingsStore.getSetting("runWallClockMs"), 600);
  });
});


describe("Promotion audit nested reserved keys (Task 22.5)", () => {
  it("forces verified:false when stored items carry a nested reserved key", async () => {
    const post = await promoPost(
      attach(
        jsonRequest(
          "http://test/api/admin/promotion-audit",
          { status: "passed", items: { checks: ["a"] } },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(post.status, 201);
    const posted = (await post.json()) as { record: { signature: string } };
    assert.ok(posted.record.signature.length > 0);

    // The signature covers the reserved-key-stripped payload, so injecting an own `__proto__` key
    // into the stored items keeps the signature valid yet must NOT be reported as verified.
    const stored = stores.settingsStore.getSetting<Record<string, unknown>>(
      PROMOTION_AUDIT_SETTING_KEY
    );
    assert.ok(stored);
    const poisonedItems = JSON.parse(
      '{"checks":["a"],"__proto__":{"polluted":"yes"}}'
    ) as Record<string, unknown>;
    stores.settingsStore.setSetting(
      PROMOTION_AUDIT_SETTING_KEY,
      { ...stored, items: poisonedItems, signature: posted.record.signature },
      { actor: "attacker" }
    );

    const res = await promoGet(
      attach(new Request("http://test/api/admin/promotion-audit", { headers: adminHeaders() }))
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { present: boolean; verified: boolean };
    assert.equal(body.present, true);
    assert.equal(body.verified, false);
  });
});

// ---------------------------------------------------------------------------------------------
// Real wiring: start-run -> Admin queue -> live orchestrator admission queue
// ---------------------------------------------------------------------------------------------

function satisfyRequiredSettings(store: SettingsStore): void {
  const updates: Record<string, number> = {};
  for (const key of ALWAYS_REQUIRED_SETTING_KEYS) {
    updates[key] = 1;
  }
  // Keep queued runs from being idle-evicted during the test.
  updates.queueIdleLimitMs = 3_600_000;
  store.setSettingsBatch(updates, { actor: "test" });
}

interface MockOrchestrator {
  snapshotQueued: string[];
  moveCalls: Array<[string, number]>;
  removeCalls: string[];
  cancelCalls: string[];
  paused: boolean;
}

function installMockOrchestrator(): MockOrchestrator {
  const state: MockOrchestrator = {
    snapshotQueued: [],
    moveCalls: [],
    removeCalls: [],
    cancelCalls: [],
    paused: false,
  };
  (globalThis as unknown as { __runOrchestrator?: unknown }).__runOrchestrator = {
    pauseAdmission: () => {
      state.paused = true;
    },
    resumeAdmission: () => {
      state.paused = false;
    },
    killRun: async () => undefined,
    stopRun: async () => undefined,
    getQueueSnapshot: () => ({
      queued: [...state.snapshotQueued],
      active: [],
      paused: state.paused,
      maxConcurrentRuns: 1,
      total: state.snapshotQueued.length,
    }),
    moveQueuedRun: (runId: string, position: number) => {
      state.moveCalls.push([runId, position]);
      const index = state.snapshotQueued.indexOf(runId);
      if (index >= 0) {
        state.snapshotQueued.splice(index, 1);
      }
      state.snapshotQueued.splice(Math.max(0, position - 1), 0, runId);
      return true;
    },
    removeQueuedRun: (runId: string) => {
      state.removeCalls.push(runId);
      const index = state.snapshotQueued.indexOf(runId);
      if (index >= 0) {
        state.snapshotQueued.splice(index, 1);
      }
      return true;
    },
    cancelQueuedRun: (runId: string) => {
      state.cancelCalls.push(runId);
      const index = state.snapshotQueued.indexOf(runId);
      if (index >= 0) {
        state.snapshotQueued.splice(index, 1);
      }
      return true;
    },
  };
  return state;
}

function startRunRequest(body: Record<string, unknown>): Request {
  return jsonRequest("http://test/api/start-run", body, { method: "POST" });
}


describe("Admin queue <-> start-run real wiring (Task 22.5)", () => {
  it("surfaces a run submitted through POST /api/start-run in GET /api/admin/queue", async () => {
    satisfyRequiredSettings(stores.settingsStore);
    stores.runStore.createInviteCode({ code: "queue-live-invite", allowedRunCount: 5 });

    const res = await startRunPost(
      attach(
        startRunRequest({
          url: "https://github.com/a/b",
          sha: "a".repeat(40),
          inviteCode: "queue-live-invite",
          runId: "run-live-queue",
        })
      )
    );
    assert.equal(res.status, 202);

    const admissionQueue = (
      globalThis as unknown as { __admissionQueue?: Array<{ runId: string }> }
    ).__admissionQueue;
    assert.ok(admissionQueue?.some((entry) => entry.runId === "run-live-queue"));

    const snapshotRes = await queueGet(
      attach(new Request("http://test/api/admin/queue", { headers: adminHeaders() }))
    );
    assert.equal(snapshotRes.status, 200);
    const snapshot = (await snapshotRes.json()) as {
      queue: { entries: Array<{ runId: string }> };
    };
    assert.ok(snapshot.queue.entries.some((entry) => entry.runId === "run-live-queue"));
  });

  it("moves, removes and cancels a real queued run across the FIFO queue, admission queue and orchestrator", async () => {
    satisfyRequiredSettings(stores.settingsStore);
    stores.runStore.createInviteCode({ code: "queue-live-ops", allowedRunCount: 5 });
    const orchestrator = installMockOrchestrator();

    for (const runId of ["run-op-a", "run-op-b"]) {
      const res = await startRunPost(
        attach(
          startRunRequest({
            url: "https://github.com/a/b",
            sha: "b".repeat(40),
            inviteCode: "queue-live-ops",
            runId,
          })
        )
      );
      assert.equal(res.status, 202);
    }
    // Mirror them into the mocked live orchestrator queue (as a live process would hold them).
    orchestrator.snapshotQueued.push("run-op-a", "run-op-b");

    const admit = (): Array<{ runId: string; queuePosition: number }> =>
      (
        globalThis as unknown as {
          __admissionQueue?: Array<{ runId: string; queuePosition: number }>;
        }
      ).__admissionQueue ?? [];

    // move run-op-b to position 1
    const moveRes = await queuePost(
      attach(
        jsonRequest(
          "http://test/api/admin/queue",
          { action: "move", runId: "run-op-b", position: 1 },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(moveRes.status, 200);
    const moved = (await moveRes.json()) as { queue: { entries: Array<{ runId: string }> } };
    assert.equal(moved.queue.entries[0].runId, "run-op-b");
    assert.deepEqual(orchestrator.moveCalls[0], ["run-op-b", 1]);
    assert.deepEqual(
      admit().map((entry) => entry.runId),
      ["run-op-b", "run-op-a"]
    );

    // cancel run-op-a
    const cancelRes = await queuePost(
      attach(
        jsonRequest(
          "http://test/api/admin/queue",
          { action: "cancel", runId: "run-op-a" },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(cancelRes.status, 200);
    assert.ok(orchestrator.cancelCalls.includes("run-op-a"));
    assert.ok(!admit().some((entry) => entry.runId === "run-op-a"));
    assert.equal(stores.runStore.getRun("run-op-a")?.outcome, "cancelled");

    // remove run-op-b
    const removeRes = await queuePost(
      attach(
        jsonRequest(
          "http://test/api/admin/queue",
          { action: "remove", runId: "run-op-b" },
          { method: "POST", headers: adminHeaders() }
        )
      )
    );
    assert.equal(removeRes.status, 200);
    assert.ok(orchestrator.removeCalls.includes("run-op-b"));
    assert.ok(!admit().some((entry) => entry.runId === "run-op-b"));

    // A later snapshot no longer re-hydrates the removed / cancelled runs.
    const afterRes = await queueGet(
      attach(new Request("http://test/api/admin/queue", { headers: adminHeaders() }))
    );
    const after = (await afterRes.json()) as { queue: { entries: Array<{ runId: string }> } };
    assert.ok(!after.queue.entries.some((entry) => entry.runId === "run-op-a"));
    assert.ok(!after.queue.entries.some((entry) => entry.runId === "run-op-b"));
  });
});


describe("Kill switch live runtime wiring (Task 22.5)", () => {
  it("drives pauseAdmission / pauseHost / stopRun / killRun across all three levels and blocks new runs", async () => {
    satisfyRequiredSettings(stores.settingsStore);
    stores.runStore.createInviteCode({ code: "kill-live-invite", allowedRunCount: 5 });

    let hostPaused = false;
    let admissionPaused = false;
    const stopped: string[] = [];
    const killed: string[] = [];
    const cancelledQueued: string[] = [];

    (globalThis as unknown as { __admission?: unknown }).__admission = {
      isPaused: () => hostPaused || admissionPaused,
      isUnavailable: () => false,
      isHealthy: () => true,
      getQueueLength: () => 0,
      pause: () => {
        hostPaused = true;
      },
    };
    (globalThis as unknown as { __runOrchestrator?: unknown }).__runOrchestrator = {
      pauseAdmission: () => {
        admissionPaused = true;
      },
      resumeAdmission: () => {
        admissionPaused = false;
      },
      stopRun: async (runId: string) => {
        stopped.push(runId);
      },
      killRun: async (runId: string) => {
        killed.push(runId);
      },
      cancelQueuedRun: (runId: string) => {
        cancelledQueued.push(runId);
        return true;
      },
    };

    stores.runStore.createRun({
      runId: "kill-active",
      url: "https://x/y",
      sha: "1".repeat(40),
      phase: "legion",
    });
    stores.runStore.createRun({
      runId: "kill-queued",
      url: "https://x/y",
      sha: "2".repeat(40),
      phase: "queued",
      queuePosition: 1,
    });
    const admissionQueue = (globalThis as unknown as { __admissionQueue?: unknown[] })
      .__admissionQueue;
    admissionQueue?.push({
      runId: "kill-queued",
      url: "https://x/y",
      sha: "2".repeat(40),
      queuePosition: 1,
      queuedAt: Date.now(),
    });

    const killPostJson = (level: string): Promise<Response> =>
      killPost(
        attach(
          jsonRequest(
            "http://test/api/admin/kill-switch",
            { level, confirmed: true, reason: "drill" },
            { method: "POST", headers: adminHeaders() }
          )
        )
      );

    // 1. pause_new_runs -> pauseAdmission + pauseHost
    const pause = await killPostJson("pause_new_runs");
    assert.equal(pause.status, 200);
    assert.equal(admissionPaused, true);
    assert.equal(hostPaused, true);

    // The pause blocks subsequent live runs with 503.
    const blocked = await startRunPost(
      attach(
        startRunRequest({
          url: "https://github.com/a/b",
          sha: "c".repeat(40),
          inviteCode: "kill-live-invite",
          runId: "run-after-pause",
        })
      )
    );
    assert.equal(blocked.status, 503);

    // 2. stop_gracefully -> pauseAdmission + pauseHost + stopRun(active)
    hostPaused = false;
    admissionPaused = false;
    const stop = await killPostJson("stop_gracefully");
    assert.equal(stop.status, 200);
    assert.deepEqual(stopped, ["kill-active"]);
    assert.equal(admissionPaused, true);
    assert.equal(hostPaused, true);

    // 3. hard_kill -> pauseAdmission + pauseHost + cancelQueuedRun(queued) + killRun(active)
    hostPaused = false;
    admissionPaused = false;
    const hard = await killPostJson("hard_kill");
    assert.equal(hard.status, 200);
    assert.ok(killed.includes("kill-active"));
    assert.ok(cancelledQueued.includes("kill-queued"));
    assert.ok(
      !admissionQueue?.some((entry) => (entry as { runId?: string }).runId === "kill-queued")
    );
    assert.equal(admissionPaused, true);
    assert.equal(hostPaused, true);
  });

  it("rehydrates persisted pause onto the live admission control", async () => {
    satisfyRequiredSettings(stores.settingsStore);
    stores.settingsStore.setSetting("killSwitch.pauseNewRuns", true, { actor: "owner" });

    let admissionPaused = false;
    (globalThis as unknown as { __runOrchestrator?: unknown }).__runOrchestrator = {
      pauseAdmission: () => {
        admissionPaused = true;
      },
    };

    const res = await killGet(
      attach(new Request("http://test/api/admin/kill-switch", { headers: adminHeaders() }))
    );
    assert.equal(res.status, 200);
    assert.equal(admissionPaused, true);
  });
});

// ---------------------------------------------------------------------------------------------
// Regressions: atomic kill-switch persistence, runtime-control failures, queue sync & parity
// ---------------------------------------------------------------------------------------------

const KILL_SWITCH_URL = "http://test/api/admin/kill-switch";
const QUEUE_URL = "http://test/api/admin/queue";

function killPostLevel(level: string): Promise<Response> {
  return killPost(
    attach(
      jsonRequest(
        KILL_SWITCH_URL,
        { level, confirmed: true },
        { method: "POST", headers: adminHeaders() }
      )
    )
  );
}

function queuePostAction(body: Record<string, unknown>): Promise<Response> {
  return queuePost(
    attach(jsonRequest(QUEUE_URL, body, { method: "POST", headers: adminHeaders() }))
  );
}

function queueGetSnapshot(): Promise<Response> {
  return queueGet(attach(new Request(QUEUE_URL, { headers: adminHeaders() })));
}

describe("Kill-switch atomic persistence (regressions)", () => {
  for (const level of ["stop_gracefully", "hard_kill"] as const) {
    it(`persists pausedNewRuns=true when executing ${level} directly`, async () => {
      const res = await killPostLevel(level);
      assert.equal(res.status, 200);
      assert.equal(stores.settingsStore.getSetting("killSwitch.pauseNewRuns"), true);
      assert.equal(stores.settingsStore.getSetting("killSwitch.lastLevel"), level);
    });
  }

  it("surfaces failedRunIds and keeps a run retryable when killRun rejects", async () => {
    stores.runStore.createRun({
      runId: "hard-fail",
      url: "https://x/y",
      sha: "e".repeat(40),
      phase: "legion",
    });
    let attempts = 0;
    (globalThis as unknown as { __runOrchestrator?: unknown }).__runOrchestrator = {
      pauseAdmission: () => undefined,
      killRun: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("kill transport down");
        }
      },
    };

    const first = await killPostLevel("hard_kill");
    assert.equal(first.status, 500);
    const firstBody = (await first.json()) as { error?: string; failedRunIds?: string[] };
    assert.equal(firstBody.error, "kill_switch_runtime_control_failed");
    assert.deepEqual(firstBody.failedRunIds, ["hard-fail"]);

    // The rejected kill must NOT finalize the run as killed — it stays retryable.
    const afterFail = stores.runStore.getRun("hard-fail");
    assert.notEqual(afterFail?.outcome, "killed");
    assert.equal(afterFail?.phase, "legion");

    // A follow-up hard_kill still targets the same run and now succeeds.
    const second = await killPostLevel("hard_kill");
    assert.equal(second.status, 200);
    assert.equal(attempts, 2);
    assert.equal(stores.runStore.getRun("hard-fail")?.outcome, "killed");
    assert.equal(stores.runStore.getRun("hard-fail")?.phase, "done");
  });

  it("surfaces failedRunIds when stopRun rejects without finalizing the run", async () => {
    stores.runStore.createRun({
      runId: "stop-fail",
      url: "https://x/y",
      sha: "f".repeat(40),
      phase: "legion",
    });
    (globalThis as unknown as { __runOrchestrator?: unknown }).__runOrchestrator = {
      pauseAdmission: () => undefined,
      stopRun: async () => {
        throw new Error("stop transport down");
      },
    };

    const res = await killPostLevel("stop_gracefully");
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; failedRunIds?: string[] };
    assert.equal(body.error, "kill_switch_runtime_control_failed");
    assert.deepEqual(body.failedRunIds, ["stop-fail"]);
    // The stop still took effect durably and never finalized the run.
    assert.equal(stores.settingsStore.getSetting("killSwitch.stopGracefully"), true);
    assert.equal(stores.runStore.getRun("stop-fail")?.phase, "legion");
  });

  it("keeps stoppingGracefully true for a concurrent GET while stop_gracefully awaits runtime stops", async () => {
    let releaseStop: () => void = () => undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopStarted = false;
    (globalThis as unknown as { __runOrchestrator?: unknown }).__runOrchestrator = {
      pauseAdmission: () => undefined,
      stopRun: async () => {
        stopStarted = true;
        await stopGate;
      },
    };
    stores.runStore.createRun({
      runId: "stop-concurrent",
      url: "https://x/y",
      sha: "a".repeat(40),
      phase: "legion",
    });

    const postPromise = killPostLevel("stop_gracefully");
    // Let the POST run through execute + persist, then park on the awaited stopRun.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopStarted, true);
    assert.equal(stores.settingsStore.getSetting("killSwitch.stopGracefully"), true);

    const getRes = await killGet(attach(new Request(KILL_SWITCH_URL, { headers: adminHeaders() })));
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as { state: { stoppingGracefully: boolean } };
    assert.equal(body.state.stoppingGracefully, true);

    releaseStop();
    const postRes = await postPromise;
    assert.equal(postRes.status, 200);
  });
});

describe("Admin queue synchronization (regressions)", () => {
  it("purges runs that left the queued phase even when still present in the FIFO queue", async () => {
    satisfyRequiredSettings(stores.settingsStore);
    stores.runStore.createInviteCode({ code: "q-purge-invite", allowedRunCount: 5 });
    const started = await startRunPost(
      attach(
        startRunRequest({
          url: "https://github.com/a/b",
          sha: "a".repeat(40),
          inviteCode: "q-purge-invite",
          runId: "q-purge-run",
        })
      )
    );
    assert.equal(started.status, 202);

    const queue = resolveFifoQueue({ eventStore: stores.eventStore, runStore: stores.runStore });
    assert.equal(queue.has("q-purge-run"), true);

    // The run starts: its RunStore phase leaves `queued` while the FIFO queue still lists it.
    stores.runStore.updateRun("q-purge-run", { phase: "legion", queuePosition: null });
    assert.equal(queue.has("q-purge-run"), true);

    const res = await queueGetSnapshot();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { queue: { entries: Array<{ runId: string }> } };
    assert.equal(
      body.queue.entries.some((entry) => entry.runId === "q-purge-run"),
      false
    );
    assert.equal(queue.has("q-purge-run"), false);
  });

  it("fails closed (500) without stale success when runStore.updateRun throws", async () => {
    satisfyRequiredSettings(stores.settingsStore);
    stores.runStore.createInviteCode({ code: "q-fail-invite", allowedRunCount: 5 });
    const started = await startRunPost(
      attach(
        startRunRequest({
          url: "https://github.com/a/b",
          sha: "b".repeat(40),
          inviteCode: "q-fail-invite",
          runId: "q-fail-run",
        })
      )
    );
    assert.equal(started.status, 202);

    const originalUpdateRun = stores.runStore.updateRun.bind(stores.runStore);
    (stores.runStore as unknown as { updateRun: unknown }).updateRun = () => {
      throw new Error("store write failed");
    };
    try {
      for (const action of ["move", "remove", "cancel"] as const) {
        const res = await queuePostAction({ action, runId: "q-fail-run", position: 1 });
        assert.equal(res.status, 500, `expected a retryable 500 for action ${action}`);
        const body = (await res.json()) as { ok: boolean; error?: string };
        assert.equal(body.ok, false);
        assert.equal(body.error, "queue_store_update_failed");
      }
      // Memory never diverged: the run is still queued with its position and no terminal outcome.
      const run = stores.runStore.getRun("q-fail-run");
      assert.equal(run?.phase, "queued");
      assert.equal(run?.queuePosition, 1);
      assert.equal(run?.outcome, null);
    } finally {
      (stores.runStore as unknown as { updateRun: unknown }).updateRun = originalUpdateRun;
    }
  });

  it("surfaces every run admitted at queueDepthCap > 5 through /api/start-run", async () => {
    satisfyRequiredSettings(stores.settingsStore);
    stores.runStore.createInviteCode({ code: "q-depth-invite", allowedRunCount: 50 });
    const admission = (globalThis as unknown as { __admission?: { queueDepthCap?: number } })
      .__admission;
    assert.ok(admission);
    admission.queueDepthCap = 7;

    const runIds = Array.from({ length: 7 }, (_, index) => `q-depth-${index + 1}`);
    for (const runId of runIds) {
      const res = await startRunPost(
        attach(
          startRunRequest({
            url: "https://github.com/a/b",
            sha: "c".repeat(40),
            inviteCode: "q-depth-invite",
            runId,
          })
        )
      );
      assert.equal(res.status, 202, `expected ${runId} to be admitted`);
    }

    const res = await queueGetSnapshot();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { queue: { entries: Array<{ runId: string }> } };
    const visible = new Set(body.queue.entries.map((entry) => entry.runId));
    for (const runId of runIds) {
      assert.equal(visible.has(runId), true, `expected ${runId} to be visible in the admin queue`);
    }
  });
});

