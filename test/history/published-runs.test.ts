import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";
import { listPublishedRuns } from "@/lib/history/published-runs";
import { GET as historyRoute } from "@/app/api/history/route";

interface Stores {
  db: DatabaseSync;
  runStore: RunStore;
  eventStore: EventStore;
}

function makeStores(): Stores {
  const db = new DatabaseSync(":memory:");
  return { db, runStore: new RunStore(db), eventStore: new EventStore(db) };
}

function attach<T extends Request>(request: T, stores: Stores): T {
  const target = request as unknown as Record<string, unknown>;
  target.runStore = stores.runStore;
  target.eventStore = stores.eventStore;
  return request;
}

function createRun(
  stores: Stores,
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

function publish(stores: Stores, runId: string): void {
  stores.eventStore.append({ runId, kind: "admin.publish", actor: "owner", data: { refs: [] } });
}

describe("listPublishedRuns", () => {
  it("returns only published runs, newest first", () => {
    const stores = makeStores();
    createRun(stores, "run-old", { createdAt: 1_000 });
    createRun(stores, "run-new", { createdAt: 3_000 });
    createRun(stores, "run-unpublished", { createdAt: 2_000 });
    publish(stores, "run-old");
    publish(stores, "run-new");

    const runs = listPublishedRuns(stores.runStore, stores.eventStore);
    assert.deepEqual(
      runs.map((r) => r.runId),
      ["run-new", "run-old"]
    );
    assert.equal(runs[0].isPublished, true);
    assert.equal(typeof runs[0].date, "string");
  });

  it("applies the limit", () => {
    const stores = makeStores();
    for (let i = 0; i < 5; i += 1) {
      createRun(stores, `run-${i}`, { createdAt: i + 1 });
      publish(stores, `run-${i}`);
    }
    const runs = listPublishedRuns(stores.runStore, stores.eventStore, { limit: 2 });
    assert.equal(runs.length, 2);
    assert.deepEqual(
      runs.map((r) => r.runId),
      ["run-4", "run-3"]
    );
  });

  it("adds skeletons and events when fields=kiro", () => {
    const stores = makeStores();
    createRun(stores, "run-kiro");
    publish(stores, "run-kiro");
    stores.eventStore.append({
      runId: "run-kiro",
      kind: "skeleton.raised",
      actor: "builder",
      data: { role: "builder", agentName: "soul-stitcher", modelId: "claude-sonnet-5.5" },
    });

    const runs = listPublishedRuns(stores.runStore, stores.eventStore, { fields: "kiro" });
    assert.equal(runs.length, 1);
    assert.ok(Array.isArray(runs[0].skeletons));
    assert.equal(runs[0].skeletons?.length, 1);
    assert.equal(runs[0].skeletons?.[0].modelId, "claude-sonnet-5.5");
    assert.ok(Array.isArray(runs[0].events));
  });

  it("omits skeletons/events without fields=kiro", () => {
    const stores = makeStores();
    createRun(stores, "run-plain");
    publish(stores, "run-plain");
    const runs = listPublishedRuns(stores.runStore, stores.eventStore);
    assert.equal(runs[0].skeletons, undefined);
    assert.equal(runs[0].events, undefined);
  });
});

describe("GET /api/history uses listPublishedRuns without changing its response", () => {
  it("returns the same shape as the shared helper", async () => {
    const stores = makeStores();
    createRun(stores, "run-route", { createdAt: 10 });
    publish(stores, "run-route");
    stores.eventStore.append({
      runId: "run-route",
      kind: "skeleton.raised",
      actor: "builder",
      data: { role: "builder", modelId: "claude-sonnet-5.5" },
    });

    const response = await historyRoute(
      attach(new Request("http://test/api/history?fields=kiro"), stores)
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    assert.equal(body[0].runId, "run-route");
    assert.equal(body[0].repository, "owner/run-route");
    assert.equal(body[0].isPublished, true);
    assert.ok(Array.isArray(body[0].skeletons));
    assert.equal((body[0].skeletons as unknown[]).length, 1);
  });

  it("returns [] when nothing is published", async () => {
    const stores = makeStores();
    createRun(stores, "run-hidden");
    const response = await historyRoute(
      attach(new Request("http://test/api/history"), stores)
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });
});
