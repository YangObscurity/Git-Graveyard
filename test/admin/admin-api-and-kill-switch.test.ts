// Task 22.5 tests: Admin session (V20), /api/admin/* routes and the kill switch.
// Validates: Requirements 28.3, 30.18, 31.1, 31.14, 32.3, 33.4, 39.10, 39.11.
import test, { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";
import { SettingsStore } from "@/lib/admin/settings-store";
import {
  DIRECT_CLIENT_IP_KEY,
  clientIpFromRequest,
  resetAdminSessionState,
} from "@/lib/admin/admin-session";
import { resetFifoQueueRegistry, resolveFifoQueue } from "@/lib/admission/fifo-queue";

import {
  GET as sessionGet,
  POST as sessionPost,
  DELETE as sessionDelete,
} from "@/app/api/admin/session/route";
import { GET as inviteGet, POST as invitePost } from "@/app/api/admin/invite-codes/route";
import { GET as settingsGet, PATCH as settingsPatch } from "@/app/api/admin/settings/route";
import { GET as queueGet, POST as queuePost } from "@/app/api/admin/queue/route";
import { POST as runActionPost } from "@/app/api/admin/runs/[runId]/route";
import {
  GET as killGet,
  POST as killPost,
  resetKillSwitchRegistry,
} from "@/app/api/admin/kill-switch/route";
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
  resetAdminSessionState();
  resetFifoQueueRegistry();
  resetKillSwitchRegistry();
  stores = makeStores();
});

afterEach(() => {
  process.env = savedEnv;
  resetAdminSessionState();
  resetFifoQueueRegistry();
  resetKillSwitchRegistry();
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
      auditLog: Array<{ key: string; actor: string }>;
    };
    assert.equal(body.settings.runWallClockMs, 12345);
    assert.ok(body.auditLog.some((entry) => entry.key === "runWallClockMs"));
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

  it("redacts (marking the run reviewed) and hides with the owner removal marker", async () => {
    stores.runStore.createRun({
      runId: "run-b",
      url: "https://example.test/a/b",
      sha: "b".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });

    const redact = await runActionPost(
      attach(
        jsonRequest(
          "http://test/api/admin/runs/run-b",
          { action: "redact", fields: ["logs"], reason: "secret" },
          { method: "POST", headers: adminHeaders() }
        )
      ),
      { params: { runId: "run-b" } }
    );
    assert.equal(redact.status, 200);
    assert.ok(stores.eventStore.getEvents("run-b", { kind: "admin.redaction" }).length >= 1);

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
});


describe("Kill switch (Task 22.5)", () => {
  it("previews the exact affected runs for all three levels", async () => {
    stores.runStore.createRun({
      runId: "active-1",
      url: "https://example.test/a/b",
      sha: "1".repeat(40),
      phase: "legion",
    });
    stores.runStore.createRun({
      runId: "queued-1",
      url: "https://example.test/a/b",
      sha: "2".repeat(40),
      phase: "queued",
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
      "promotionAudit",
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
      assert.equal(clientIpFromRequest(spoofed, { trustProxy: true }), "203.0.113.7");

      const env = { ...process.env, TRUST_PROXY: "true" };
      assert.equal(clientIpFromRequest(spoofed, { env }), "203.0.113.7");
      assert.equal(clientIpFromRequest(spoofed, { trustProxy: false }), "direct");
    } finally {
      if (previous === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = previous;
      }
    }
  });
});

