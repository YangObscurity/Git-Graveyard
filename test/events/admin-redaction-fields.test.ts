// End-to-end cover for read-time redaction enforcement: the admin redact action records the
// requested logical fields, and every event served afterwards (replay route and EventTap) has the
// matching fields scrubbed while the `admin.redaction` audit record stays intact.
import test, { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";
import { SettingsStore } from "@/lib/admin/settings-store";
import { EventTap } from "@/lib/events/event-tap";
import { resetAdminSessionState } from "@/lib/admin/admin-session";

import { POST as runActionPost } from "@/app/api/admin/runs/[runId]/route";
import { GET as eventsRoute } from "@/app/api/runs/[runId]/events/route";

const ADMIN_SECRET = "test-admin-secret-value";

// Every key the "logs" redaction field governs.
const LOG_DATA_KEYS = [
  "log",
  "logs",
  "stdout",
  "stderr",
  "output",
  "tail",
  "lines",
  "chunk",
] as const;

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

function runAction(
  runId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = adminHeaders()
): Promise<Response> {
  return runActionPost(
    attach(
      jsonRequest(`http://test/api/admin/runs/${runId}`, body, {
        method: "POST",
        headers,
      })
    ),
    { params: { runId } }
  );
}

function replay(runId: string): Promise<Response> {
  return eventsRoute(
    attach(new Request(`http://test/api/runs/${runId}/events?from=0&to=100`), {
      eventStore: stores.eventStore,
    }),
    { params: Promise.resolve({ runId }) }
  );
}

interface ReplayEvent {
  seq: number;
  kind: string;
  data: Record<string, unknown>;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  delete process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_KEY;
  delete process.env.ADMIN_ACTOR_ID;
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

describe("Read-time field redaction across admin redact and event reads", () => {
  it("scrubs log/stdout/stderr/output on replay while keeping admin.redaction intact and allowing publish", async () => {
    const runId = "run-redaction-fields";
    stores.runStore.createRun({
      runId,
      url: "https://example.test/owner/repo",
      sha: "a".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });

    // Stored events carrying log-like payloads that the "logs" field must govern.
    stores.eventStore.append({
      runId,
      kind: "cmd.output",
      actor: "necromancer",
      data: {
        refs: [],
        command: "echo hello",
        output: "command output payload",
        stdout: "standard out payload",
        stderr: "standard error payload",
        log: "generic log payload",
        tail: "tail payload",
        lines: ["first line", "second line"],
        chunk: "chunk payload",
      },
    });
    stores.eventStore.append({
      runId,
      kind: "exhume.log",
      actor: "necromancer",
      data: {
        refs: [],
        output: "exhume output payload",
        message: "exhume finished cleanly",
      },
    });
    stores.eventStore.append({
      runId,
      kind: "skeleton.log",
      actor: "bonesetter",
      data: {
        refs: [],
        log: "skeleton log payload",
        stdout: "skeleton stdout payload",
      },
    });
    // An unrelated event must not be scrubbed or marked redacted.
    stores.eventStore.append({
      runId,
      kind: "run.queued",
      actor: "necromancer",
      data: { refs: [], queuePosition: 3 },
    });

    const redact = await runAction(runId, { action: "redact", fields: ["logs"] });
    assert.equal(redact.status, 200);
    assert.equal(((await redact.json()) as { ok: boolean }).ok, true);

    // The audit record was written once, with the requested fields.
    const redactionEvents = stores.eventStore.getEvents(runId, { kind: "admin.redaction" });
    assert.equal(redactionEvents.length, 1);
    assert.deepEqual(redactionEvents[0].data.fields, ["logs"]);

    // --- Replay route applies read-time redaction ---
    const replayRes = await replay(runId);
    assert.equal(replayRes.status, 200);
    const events = (await replayRes.json()) as ReplayEvent[];
    assert.ok(events.length >= 5);

    for (const event of events) {
      if (event.kind === "admin.redaction") continue;
      let touched = false;
      for (const key of LOG_DATA_KEYS) {
        if (key in event.data) {
          assert.equal(
            event.data[key],
            "[REDACTED]",
            `${event.kind}.${key} must be scrubbed in the replay response`
          );
          touched = true;
        }
      }
      if (touched) {
        assert.equal(event.data.redacted, true, `${event.kind} must be marked redacted`);
        assert.equal(
          event.data.redactedByOwner,
          true,
          `${event.kind} must be marked redactedByOwner`
        );
      }
    }

    // The unrelated event keeps its payload and is not marked redacted.
    const queued = events.find((event) => event.kind === "run.queued");
    assert.ok(queued);
    assert.equal(queued!.data.queuePosition, 3);
    assert.equal(queued!.data.redacted, undefined);

    // The admin.redaction audit event is served intact (not replaced by the field scrub).
    const audit = events.find((event) => event.kind === "admin.redaction");
    assert.ok(audit);
    assert.deepEqual(audit!.data.fields, ["logs"]);
    assert.equal(audit!.data.reviewed, true);
    assert.equal(audit!.data.redactedByOwner, undefined);

    // --- EventTap.getEvents applies the same enforcement ---
    const tap = new EventTap(stores.eventStore);
    const tapEvents = tap.getEvents(runId, { from: 0, to: 100 });
    const tapCmd = tapEvents.find((event) => event.kind === "cmd.output");
    assert.ok(tapCmd);
    assert.equal(tapCmd!.data.output, "[REDACTED]");
    assert.equal(tapCmd!.data.stdout, "[REDACTED]");
    assert.equal(tapCmd!.data.stderr, "[REDACTED]");
    assert.equal(tapCmd!.data.log, "[REDACTED]");
    assert.equal(tapCmd!.data.redacted, true);
    const tapAudit = tapEvents.find((event) => event.kind === "admin.redaction");
    assert.ok(tapAudit);
    assert.deepEqual(tapAudit!.data.fields, ["logs"]);

    // --- Publish succeeds after the redaction recorded the review ---
    const publish = await runAction(runId, { action: "publish" });
    assert.equal(publish.status, 200);
    assert.equal(((await publish.json()) as { ok: boolean }).ok, true);
    assert.equal(stores.runStore.getRun(runId)?.isPublished, true);
  });

  it("rejects a redaction field that has no enforceable scrub rule", async () => {
    const runId = "run-redaction-unknown-field";
    stores.runStore.createRun({
      runId,
      url: "https://example.test/owner/repo",
      sha: "b".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });

    const res = await runAction(runId, {
      action: "redact",
      fields: ["not-an-enforceable-field"],
    });
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_redaction_fields"
    );
    assert.equal(stores.eventStore.getEvents(runId, { kind: "admin.redaction" }).length, 0);
  });

  it("forwards targetSeqs alongside the requested fields in the admin.redaction record", async () => {
    const runId = "run-redaction-targets";
    stores.runStore.createRun({
      runId,
      url: "https://example.test/owner/repo",
      sha: "c".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });

    stores.eventStore.append({
      runId,
      kind: "cmd.output",
      actor: "necromancer",
      data: { refs: [], output: "command output payload" },
    });

    const res = await runAction(runId, {
      action: "redact",
      fields: ["logs"],
      targetSeqs: [1, 2],
    });
    assert.equal(res.status, 200);

    const redactionEvents = stores.eventStore.getEvents(runId, { kind: "admin.redaction" });
    assert.equal(redactionEvents.length, 1);
    assert.deepEqual(redactionEvents[0].data.fields, ["logs"]);
    assert.deepEqual(redactionEvents[0].data.targetSeqs, [1, 2]);
  });
});

