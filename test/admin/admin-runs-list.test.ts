import test, { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";
import { SettingsStore } from "@/lib/admin/settings-store";
import { resetAdminSessionState } from "@/lib/admin/admin-session";
import { GET as adminRunsGet } from "@/app/api/admin/runs/route";
import { POST as runActionPost } from "@/app/api/admin/runs/[runId]/route";

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

function attach<T extends Request>(request: T): T {
  const target = request as unknown as Record<string, unknown>;
  target.runStore = stores.runStore;
  target.eventStore = stores.eventStore;
  target.settingsStore = stores.settingsStore;
  return request;
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-admin-token": ADMIN_SECRET, ...extra };
}

function createRun(
  runId: string,
  overrides: Partial<Parameters<RunStore["createRun"]>[0]> = {}
): void {
  stores.runStore.createRun({
    runId,
    url: `https://github.com/owner/${runId}`,
    sha: "a".repeat(40),
    phase: "done",
    outcome: "resurrected",
    ...overrides,
  });
}

function appendEvent(runId: string, kind: string, data: Record<string, unknown> = {}): void {
  stores.eventStore.append({ runId, kind, actor: "owner", data: { refs: [], ...data } });
}

interface AdminRunListItem {
  runId: string;
  repository: string;
  outcome: string | null;
  phase: string;
  createdAt: number;
  isPublished: boolean;
  isRemoved: boolean;
  reviewed: boolean;
}

async function listRuns(
  query = ""
): Promise<{ status: number; body: { ok: boolean; runs: AdminRunListItem[] } }> {
  const response = await adminRunsGet(
    attach(new Request(`http://test/api/admin/runs${query}`, { headers: adminHeaders() }))
  );
  return {
    status: response.status,
    body: (await response.json()) as { ok: boolean; runs: AdminRunListItem[] },
  };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  delete process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_KEY;
  resetAdminSessionState();
  stores = makeStores();
});

afterEach(() => {
  process.env = savedEnv;
  resetAdminSessionState();
  try {
    stores.db.close();
  } catch {
    // ignore
  }
});

describe("GET /api/admin/runs authentication", () => {
  it("refuses the run list without an admin credential (401)", async () => {
    const response = await adminRunsGet(attach(new Request("http://test/api/admin/runs")));
    assert.equal(response.status, 401);
    const body = (await response.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "admin_auth_required");
  });

  it("fails closed (503) when the admin secret is unconfigured", async () => {
    delete process.env.ADMIN_SECRET;
    const response = await adminRunsGet(attach(new Request("http://test/api/admin/runs")));
    assert.equal(response.status, 503);
  });
});

describe("GET /api/admin/runs lists finished runs for review", () => {
  it("lists an unpublished finished run with isPublished false", async () => {
    createRun("run-unpublished");

    const { status, body } = await listRuns();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.runs.length, 1);

    const run = body.runs[0];
    assert.equal(run.runId, "run-unpublished");
    assert.equal(run.repository, "owner/run-unpublished");
    assert.equal(run.outcome, "resurrected");
    assert.equal(run.phase, "done");
    assert.equal(run.isPublished, false);
    assert.equal(run.isRemoved, false);
    assert.equal(run.reviewed, false);
    assert.equal(typeof run.createdAt, "number");
  });

  it("reports isPublished true for a published run", async () => {
    createRun("run-published", { isPublished: true });

    const { body } = await listRuns();
    const run = body.runs.find((item) => item.runId === "run-published");
    assert.ok(run);
    assert.equal(run.isPublished, true);
  });

  it("reports isPublished true when only an admin.publish event exists", async () => {
    createRun("run-published-event");
    appendEvent("run-published-event", "admin.publish");

    const { body } = await listRuns();
    const run = body.runs.find((item) => item.runId === "run-published-event");
    assert.ok(run);
    assert.equal(run.isPublished, true);
  });

  it("reports isRemoved true for a hidden run", async () => {
    createRun("run-hidden", { isRemoved: true });
    createRun("run-hidden-event");
    appendEvent("run-hidden-event", "admin.hide");

    const { body } = await listRuns();
    const hidden = body.runs.find((item) => item.runId === "run-hidden");
    const hiddenEvent = body.runs.find((item) => item.runId === "run-hidden-event");
    assert.ok(hidden);
    assert.ok(hiddenEvent);
    assert.equal(hidden.isRemoved, true);
    assert.equal(hiddenEvent.isRemoved, true);
  });

  it("reports reviewed true once an admin.review event exists", async () => {
    createRun("run-reviewed");
    appendEvent("run-reviewed", "admin.review");

    const { body } = await listRuns();
    const run = body.runs.find((item) => item.runId === "run-reviewed");
    assert.ok(run);
    assert.equal(run.reviewed, true);
  });

  it("excludes running (unfinished) runs", async () => {
    createRun("run-running", { phase: "legion", outcome: null });
    createRun("run-queued", { phase: "queued", outcome: null });
    createRun("run-finished");

    const { body } = await listRuns();
    const ids = body.runs.map((item) => item.runId);
    assert.deepEqual(ids, ["run-finished"]);
  });

  it("returns the newest finished runs first", async () => {
    createRun("run-old", { createdAt: 1_000 });
    createRun("run-new", { createdAt: 3_000 });
    createRun("run-middle", { createdAt: 2_000 });

    const { body } = await listRuns();
    assert.deepEqual(
      body.runs.map((item) => item.runId),
      ["run-new", "run-middle", "run-old"]
    );
  });

  it("respects the limit query parameter", async () => {
    createRun("run-1", { createdAt: 1 });
    createRun("run-2", { createdAt: 2 });
    createRun("run-3", { createdAt: 3 });

    const limited = await listRuns("?limit=2");
    assert.equal(limited.body.runs.length, 2);
    assert.deepEqual(
      limited.body.runs.map((item) => item.runId),
      ["run-3", "run-2"]
    );
  });

  it("caps the limit at 200", async () => {
    for (let index = 0; index < 205; index += 1) {
      createRun(`run-${index}`, { createdAt: index + 1 });
    }

    const capped = await listRuns("?limit=1000");
    assert.equal(capped.body.runs.length, 200);
    assert.equal(capped.body.runs[0].runId, "run-204");
    assert.equal(capped.body.runs[199].runId, "run-5");
  });

  it("never returns event payloads, secrets or invite codes", async () => {
    const secret = `ghp_${"z".repeat(32)}`;
    createRun("run-secret", {
      inviteCodeHash: "invite-hash-value",
      metadata: { note: secret },
    });
    appendEvent("run-secret", "admin.review", { reason: `reviewed ${secret}` });

    const { body } = await listRuns();
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes("invite-hash-value"));
    assert.ok(!serialized.includes("admin.review"));
    const run = body.runs[0];
    assert.deepEqual(Object.keys(run).sort(), [
      "createdAt",
      "isPublished",
      "isRemoved",
      "outcome",
      "phase",
      "repository",
      "reviewed",
      "runId",
    ]);
  });
});
describe("GET /api/admin/runs trusts the server phase filter", () => {
  it("includes a killed run whose phase is not done", async () => {
    createRun("run-killed", { phase: "legion", outcome: "killed" });
    createRun("run-done", { phase: "done", outcome: "resurrected" });

    const { status, body } = await listRuns();
    assert.equal(status, 200);
    const ids = body.runs.map((item) => item.runId);
    assert.ok(ids.includes("run-killed"));
    const killed = body.runs.find((item) => item.runId === "run-killed");
    assert.ok(killed);
    assert.equal(killed.phase, "legion");
    assert.equal(killed.outcome, "killed");
  });
});

describe("POST /api/admin/runs/[runId] redact requires a target", () => {
  function post(runId: string, body: unknown): Promise<Response> {
    return runActionPost(
      attach(
        new Request(`http://test/api/admin/runs/${runId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(body),
        })
      ),
      { params: { runId } }
    );
  }

  it("rejects an empty target list with 400 and writes nothing", async () => {
    createRun("run-redact-empty", { phase: "done", outcome: "resurrected" });

    const response = await post("run-redact-empty", { action: "redact" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "redaction_targets_required");

    // No review marker and no audit event were written.
    const run = stores.runStore.getRun("run-redact-empty");
    const metadata = (run?.metadata ?? {}) as Record<string, unknown>;
    assert.notEqual(metadata.reviewed, true);
    assert.equal(
      stores.eventStore.getEvents("run-redact-empty", { kind: "admin.redaction" }).length,
      0
    );
    assert.equal(
      stores.eventStore.getEvents("run-redact-empty", { kind: "admin.review" }).length,
      0
    );
  });

  it("rejects an explicitly empty fields array with 400", async () => {
    createRun("run-redact-empty-array", { phase: "done", outcome: "resurrected" });

    const response = await post("run-redact-empty-array", {
      action: "redact",
      fields: [],
    });
    assert.equal(response.status, 400);
    assert.equal(
      stores.eventStore.getEvents("run-redact-empty-array", { kind: "admin.redaction" })
        .length,
      0
    );
  });

  it("still redacts when a valid field is supplied", async () => {
    createRun("run-redact-ok", { phase: "done", outcome: "resurrected" });

    const response = await post("run-redact-ok", { action: "redact", fields: ["logs"] });
    assert.equal(response.status, 200);
    assert.equal(
      stores.eventStore.getEvents("run-redact-ok", { kind: "admin.redaction" }).length,
      1
    );
  });
});