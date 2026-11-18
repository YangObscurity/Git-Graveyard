import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RunStore,
  getDefaultRunStore,
  resetDefaultRunStore,
} from "@/lib/runs/run-store";
import {
  EventStore,
  getDefaultEventStore,
  resetDefaultEventStore,
} from "@/lib/events/event-store";
import {
  getSeededRecordedRunIds,
  listRecordedRunsOnDisk,
  resolveRecordedArtifactDir,
  seedRecordedRunsIntoStores,
} from "@/lib/runs/recorded-runs-loader";
import { GET as historyRoute } from "@/app/api/history/route";
import { GET as runDetailRoute } from "@/app/api/runs/[runId]/route";
import { GET as eventsRoute } from "@/app/api/runs/[runId]/events/route";
import { GET as relicDownloadRoute } from "@/app/runs/[runId]/relic/download/route";

function writeSampleRecordedBundle(
  rootDir: string,
  runId: string,
  options?: { omitAdminPublish?: boolean; withSecrets?: boolean; withSeqGap?: boolean }
) {
  const bundleDir = path.join(rootDir, "output", "recorded-runs", runId);
  const artDir = path.join(bundleDir, "artifacts");
  fs.mkdirSync(artDir, { recursive: true });

  const fakeCanary = ["ghp_", "CANARYSECRET1234567890abcdefghij"].join("");
  const secretSuffix = options?.withSecrets ? ` ${fakeCanary} /home/alice/secret` : "";
  const patchContent = `diff --git a/index.js b/index.js\nindex 111..222 100644\n--- a/index.js\n+++ b/index.js\n@@ -1,2 +1,2 @@ Task: T1 Rule: M1\n-module.exports = 1;\n+module.exports = 2;\n`;
  const specContent = JSON.stringify({ schemaVersion: "v1", runId, tasks: [] }, null, 2);
  const reportContent = `# Recorded Report for ${runId}\n`;
  const certContent = JSON.stringify({ schemaVersion: "v1", runId, healthy: false }, null, 2);

  fs.writeFileSync(path.join(artDir, "all.patch"), patchContent, "utf8");
  fs.writeFileSync(path.join(artDir, "spec.json"), specContent, "utf8");
  fs.writeFileSync(path.join(artDir, "report.md"), reportContent, "utf8");
  fs.writeFileSync(path.join(artDir, "death-certificate.json"), certContent, "utf8");

  const runJson = {
    runId,
    url: "https://github.com/octocat/legacy-node-app",
    sha: "deadbeef1234567890abcdef1234567890abcdef",
    phase: "done",
    outcome: "resurrected",
    pushFlag: false,
    isPublished: true,
    isRemoved: false,
    metadata: {
      artifactsDir: options?.withSecrets ? "C:\\Users\\Alice\\temp\\artifacts" : undefined,
      note: `Recorded bundle${secretSuffix}`,
    },
    createdAt: 1731672000000,
    updatedAt: 1731672060000,
    startedAt: 1731672001000,
    endedAt: 1731672060000,
  };
  fs.writeFileSync(path.join(bundleDir, "run.json"), JSON.stringify(runJson, null, 2), "utf8");

  const patchSha = crypto.createHash("sha256").update(patchContent).digest("hex");
  const events: Array<Record<string, unknown>> = [
    {
      runId,
      seq: 1,
      ts: 1731672001000,
      kind: "run.started",
      actor: "necromancer",
      data: {
        kiroCliVersion: "3.1.0",
        note: `Start${secretSuffix}`,
        refs: [],
      },
    },
    {
      runId,
      seq: options?.withSeqGap ? 3 : 2,
      ts: 1731672010000,
      kind: "skeleton.raised",
      actor: "bonesetter",
      skeletonId: "skel-bonesetter-1",
      data: {
        role: "Bonesetter",
        agentName: "bonesetter",
        modelId: "claude-sonnet-5.5",
        sessionId: "sess-rec-1",
        refs: [],
      },
    },
    {
      runId,
      seq: options?.withSeqGap ? 4 : 3,
      ts: 1731672020000,
      kind: "task.state",
      actor: "warden",
      taskId: "T1",
      data: { state: "merged", title: "Fix package build", refs: [] },
    },
    {
      runId,
      seq: options?.withSeqGap ? 5 : 4,
      ts: 1731672055000,
      kind: "artifact.ready",
      actor: "necromancer",
      data: {
        kind: "patch",
        path: "artifacts/all.patch",
        sha256: patchSha,
        byteSize: Buffer.byteLength(patchContent),
        refs: [],
      },
    },
    {
      runId,
      seq: options?.withSeqGap ? 6 : 5,
      ts: 1731672060000,
      kind: "run.done",
      actor: "necromancer",
      data: { phase: "done", outcome: "resurrected", refs: [] },
    },
  ];
  if (!options?.omitAdminPublish) {
    events.push({
      runId,
      seq: options?.withSeqGap ? 7 : 6,
      ts: 1731672061000,
      kind: "admin.publish",
      actor: "admin",
      data: { refs: [] },
    });
  }

  const ndjson = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(path.join(bundleDir, "events.ndjson"), ndjson, "utf8");
  fs.writeFileSync(path.join(artDir, "events.ndjson"), ndjson, "utf8");

  return { bundleDir, artDir, patchContent, patchSha };
}

describe("Recorded Runs Loader & /api/history Seeding", () => {
  let tempDir: string;
  let origCwd: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    origCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-recorded-runs-test-"));
    process.env.RUN_STORE_PATH = path.join(tempDir, "runs.db");
    process.env.EVENT_STORE_PATH = path.join(tempDir, "events.db");
    process.env.RUNS_DIR = path.join(tempDir, "runs");
    delete process.env.DISABLE_RECORDED_RUNS_SEED;

    resetDefaultRunStore();
    resetDefaultEventStore();

    const g = globalThis as Record<string, unknown>;
    delete g.__sharedRunStore;
    delete g.__sharedEventStore;
    delete g.__runStore;
    delete g.__eventStore;
    delete g.__sharedEventTap;
    delete g.__eventTap;
  });

  afterEach(() => {
    process.chdir(origCwd);
    resetDefaultRunStore();
    resetDefaultEventStore();

    const g = globalThis as Record<string, unknown>;
    delete g.__sharedRunStore;
    delete g.__sharedEventStore;
    delete g.__runStore;
    delete g.__eventStore;
    delete g.__sharedEventTap;
    delete g.__eventTap;

    process.env = savedEnv;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("handles missing output/recorded-runs directory gracefully", () => {
    const emptyList = listRecordedRunsOnDisk({
      baseDir: path.join(tempDir, "does-not-exist"),
    });
    assert.deepEqual(emptyList, []);

    const runStore = getDefaultRunStore();
    const eventStore = getDefaultEventStore();
    const res = seedRecordedRunsIntoStores(runStore, eventStore, {
      baseDir: path.join(tempDir, "does-not-exist"),
    });
    assert.equal(res.skipped, false);
    assert.deepEqual(res.seededRunIds, []);
  });

  it("validates runId and prevents path traversal in resolveRecordedArtifactDir", () => {
    assert.equal(resolveRecordedArtifactDir(""), null);
    assert.equal(resolveRecordedArtifactDir("."), null);
    assert.equal(resolveRecordedArtifactDir(".."), null);
    assert.equal(resolveRecordedArtifactDir("../secret"), null);
    assert.equal(resolveRecordedArtifactDir("a/b"), null);
    assert.equal(resolveRecordedArtifactDir("a\\b"), null);
    assert.equal(resolveRecordedArtifactDir("run?x=1"), null);

    const safe = resolveRecordedArtifactDir("run-t40-valid_1.0", path.join(tempDir, "output", "recorded-runs"));
    assert.ok(safe);
    assert.ok(safe.endsWith(path.join("output", "recorded-runs", "run-t40-valid_1.0", "artifacts")));
  });

  it("respects memory-mode skip, DISABLE_RECORDED_RUNS_SEED, redaction, seq preservation, and idempotency", () => {
    writeSampleRecordedBundle(tempDir, "run-rec-01", {
      omitAdminPublish: true,
      withSecrets: true,
      withSeqGap: true,
    });
    const baseDir = path.join(tempDir, "output", "recorded-runs");

    // Memory store skips unless force: true
    const memRunStore = new RunStore(":memory:");
    const memEventStore = new EventStore(":memory:");
    const skippedMem = seedRecordedRunsIntoStores(memRunStore, memEventStore, { baseDir });
    assert.equal(skippedMem.skipped, true);
    assert.equal(skippedMem.reason, "memory_store");
    assert.equal(memRunStore.countRuns(), 0);
    memRunStore.close();
    memEventStore.close();

    // DISABLE_RECORDED_RUNS_SEED skips even on file store
    process.env.DISABLE_RECORDED_RUNS_SEED = "1";
    const fileRunStore = getDefaultRunStore();
    const fileEventStore = getDefaultEventStore();
    const skippedEnv = seedRecordedRunsIntoStores(fileRunStore, fileEventStore, { baseDir });
    assert.equal(skippedEnv.skipped, true);
    assert.equal(fileRunStore.countRuns(), 0);
    delete process.env.DISABLE_RECORDED_RUNS_SEED;

    // Seed into file store
    const first = seedRecordedRunsIntoStores(fileRunStore, fileEventStore, { baseDir });
    assert.equal(first.skipped, false);
    assert.deepEqual(first.seededRunIds, ["run-rec-01"]);
    assert.deepEqual(getSeededRecordedRunIds(fileRunStore), ["run-rec-01"]);

    // Verify run metadata & redaction
    const seededRun = fileRunStore.getRun("run-rec-01");
    assert.ok(seededRun);
    assert.equal(seededRun.isPublished, true);
    assert.equal(seededRun.outcome, "resurrected");
    const serializedRun = JSON.stringify(seededRun);
    assert.ok(!serializedRun.includes("CANARYSECRET"));
    assert.ok(!serializedRun.includes("/home/alice"));
    assert.ok(!serializedRun.includes("C:\\Users\\Alice"));

    // Verify original seq numbers preserved (1, 3, 4, 5, 6) + synthesized admin.publish at seq 7
    const events = fileEventStore.getEvents("run-rec-01");
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 3, 4, 5, 6, 7]
    );
    assert.equal(events[events.length - 1].kind, "admin.publish");
    const serializedEvents = JSON.stringify(events);
    assert.ok(!serializedEvents.includes("CANARYSECRET"));
    assert.ok(!serializedEvents.includes("/home/alice"));

    // Second call is idempotent and does not throw or duplicate
    const second = seedRecordedRunsIntoStores(fileRunStore, fileEventStore, { baseDir });
    assert.equal(second.skipped, false);
    assert.deepEqual(second.seededRunIds, []);
    assert.deepEqual(second.alreadySeededRunIds, ["run-rec-01"]);
    assert.equal(fileRunStore.countRuns(), 1);
    assert.equal(fileEventStore.countEvents("run-rec-01"), 6);
  });

  it("seeds automatically via store-context for GET /api/history, /api/runs/[runId], /events, and relic download", async () => {
    const { patchContent, patchSha } = writeSampleRecordedBundle(tempDir, "run-t40-live-bundle");
    process.chdir(tempDir);

    // 1. GET /api/history?fields=kiro seeds file stores automatically on first hit
    const histRes = await historyRoute(new Request("http://test/api/history?fields=kiro"));
    assert.equal(histRes.status, 200);
    const histBody = await histRes.json();
    assert.equal(histBody.length, 1);
    assert.equal(histBody[0].runId, "run-t40-live-bundle");
    assert.equal(histBody[0].repository, "octocat/legacy-node-app");
    assert.equal(histBody[0].isPublished, true);
    assert.equal(histBody[0].outcome, "resurrected");
    assert.ok(Array.isArray(histBody[0].skeletons));
    assert.equal(histBody[0].skeletons.length, 1);
    assert.equal(histBody[0].skeletons[0].modelId, "claude-sonnet-5.5");

    // 2. GET /api/runs/[runId] resolves recorded artifacts from output/recorded-runs/<runId>/artifacts
    const detailRes = await runDetailRoute(
      new Request("http://test/api/runs/run-t40-live-bundle"),
      { params: Promise.resolve({ runId: "run-t40-live-bundle" }) }
    );
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json();
    assert.equal(detailBody.ok, true);
    assert.equal(detailBody.noTasksMerged, false);
    assert.equal(detailBody.diff, patchContent);
    const patchArt = detailBody.artifacts.find((a: { id: string }) => a.id === "patch");
    assert.ok(patchArt);
    assert.equal(patchArt.sha256, patchSha);
    assert.equal(patchArt.missing, undefined);

    // 3. GET /api/runs/[runId]/events?from=1 replays recorded events
    const eventsRes = await eventsRoute(
      new Request("http://test/api/runs/run-t40-live-bundle/events?from=1"),
      { params: Promise.resolve({ runId: "run-t40-live-bundle" }) }
    );
    assert.equal(eventsRes.status, 200);
    const eventsBody = await eventsRes.json();
    assert.equal(eventsBody.length, 6);
    assert.equal(eventsBody[0].kind, "run.started");

    // 4. GET /runs/[runId]/relic/download?artifact=patch serves exact artifact bytes
    const dlRes = await relicDownloadRoute(
      new Request("http://test/runs/run-t40-live-bundle/relic/download?artifact=patch"),
      { params: Promise.resolve({ runId: "run-t40-live-bundle" }) }
    );
    assert.equal(dlRes.status, 200);
    assert.equal(await dlRes.text(), patchContent);

    // 5. Injected request.runStore remains isolated without disk seeding
    const memDb = new DatabaseSync(":memory:");
    const injectedReq = new Request("http://test/api/history") as Request & {
      runStore?: RunStore;
      eventStore?: EventStore;
    };
    injectedReq.runStore = new RunStore(memDb);
    injectedReq.eventStore = new EventStore(memDb);
    const isolatedRes = await historyRoute(injectedReq);
    assert.equal(isolatedRes.status, 200);
    const isolatedHist = await isolatedRes.json();
    assert.deepEqual(isolatedHist, []);
    memDb.close();
  });
});
