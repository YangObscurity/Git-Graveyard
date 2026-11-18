import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  collectSystemDiagnostics,
  evaluateProbeGateFromFile,
  inspectRunDiagnostics,
} from "@/lib/runtime/diagnostics";
import { resetRuntimeHost } from "@/lib/runtime/runtime-host";

import { GET as healthRoute } from "@/app/api/health/route";
import { GET as debugStatusRoute } from "@/app/api/debug/status/route";
import { GET as debugRunRoute } from "@/app/api/debug/runs/[runId]/route";
import { POST as debugSimRoute } from "@/app/api/debug/sim/route";
import { POST as startRunRoute, clearAdmissionQueue } from "@/app/api/start-run/route";
import { GET as historyRoute } from "@/app/api/history/route";
import { GET as runDetailRoute } from "@/app/api/runs/[runId]/route";
import { GET as relicDownloadRoute } from "@/app/runs/[runId]/relic/download/route";

describe("Live Backend Diagnostics, Health, and Debug Sim Routes", () => {
  let tempDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-debug-status-test-"));
    process.env.RUN_STORE_PATH = path.join(tempDir, "runs.db");
    process.env.EVENT_STORE_PATH = path.join(tempDir, "events.db");
    process.env.RUNS_DIR = path.join(tempDir, "runs");
    process.env.DISABLE_RECORDED_RUNS_SEED = "1";
    process.env.DISABLE_AUTO_ORCHESTRATOR = "1";
    process.env.ADMIN_TOKEN = "admin-secret-token-xyz";

    clearAdmissionQueue();
    await resetRuntimeHost({ closeStores: true });
    resetDefaultRunStore();
    resetDefaultEventStore();

    const g = globalThis as Record<string, unknown>;
    delete g.__sharedRunStore;
    delete g.__sharedEventStore;
    delete g.__runStore;
    delete g.__eventStore;
    delete g.__sharedEventTap;
    delete g.__eventTap;
    delete g.__runOrchestrator;
    delete g.__backend;
    delete g.__admission;
  });

  afterEach(async () => {
    clearAdmissionQueue();
    await resetRuntimeHost({ closeStores: true });
    resetDefaultRunStore();
    resetDefaultEventStore();

    const g = globalThis as Record<string, unknown>;
    delete g.__sharedRunStore;
    delete g.__sharedEventStore;
    delete g.__runStore;
    delete g.__eventStore;
    delete g.__sharedEventTap;
    delete g.__eventTap;
    delete g.__runOrchestrator;
    delete g.__backend;
    delete g.__admission;

    process.env = savedEnv;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("RunStore and EventStore defaults & storage mode", () => {
    it("keeps new RunStore() and new EventStore() defaulting to :memory: while getDefault* use files", () => {
      const isolatedRun = new RunStore();
      const isolatedEvent = new EventStore();
      assert.equal(isolatedRun.getStorageMode(), "memory");
      assert.equal(isolatedEvent.getStorageMode(), "memory");
      isolatedRun.close();
      isolatedEvent.close();

      const defRun = getDefaultRunStore();
      const defEvent = getDefaultEventStore();
      assert.equal(defRun.getStorageMode(), "file");
      assert.equal(defEvent.getStorageMode(), "file");
      assert.equal((globalThis as Record<string, unknown>).__sharedRunStore, defRun);
      assert.equal((globalThis as Record<string, unknown>).__sharedEventStore, defEvent);

      resetDefaultRunStore();
      resetDefaultEventStore();
      assert.equal((globalThis as Record<string, unknown>).__sharedRunStore, undefined);
      assert.equal((globalThis as Record<string, unknown>).__sharedEventStore, undefined);
    });
  });

  describe("GET /api/health and ?detail=1", () => {
    it("preserves legacy fields without ?detail=1 and attaches diagnostics summary with ?detail=1", async () => {
      const plainRes = await healthRoute(new Request("http://test/api/health"));
      assert.equal(plainRes.status, 200);
      const plain = await plainRes.json();
      assert.equal(plain.ok, true);
      assert.equal(plain.status, "open");
      assert.equal(plain.liveRunStatus, "open");
      assert.equal(plain.queueLength, 0);
      assert.ok(plain.engineVersion);
      assert.equal(plain.diagnostics, undefined);

      const detailRes = await healthRoute(new Request("http://test/api/health?detail=1"));
      assert.equal(detailRes.status, 200);
      const detail = await detailRes.json();
      assert.equal(detail.ok, true);
      assert.equal(detail.status, "open");
      assert.ok(detail.diagnostics);
      assert.equal(detail.diagnostics.stores.runStore.storageMode, "file");
      assert.equal(detail.diagnostics.stores.eventStore.storageMode, "file");
      assert.equal(detail.diagnostics.runtimeHost.initialized, true);
      assert.ok("probes" in detail.diagnostics);
      assert.ok("orchestrator" in detail.diagnostics);
    });
  });

  describe("GET /api/debug/status access control, redaction, and telemetry", () => {
    it("enforces production lock unless ?uiDebug=1, x-ui-debug: 1, or valid ADMIN_TOKEN", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      const lockedRes = await debugStatusRoute(
        new Request("http://test/api/debug/status")
      );
      assert.equal(lockedRes.status, 403);
      const lockedBody = await lockedRes.json();
      assert.equal(lockedBody.ok, false);
      assert.equal(lockedBody.code, "DEBUG_LOCKED");

      const wrongTokenRes = await debugStatusRoute(
        new Request("http://test/api/debug/status", {
          headers: { "x-admin-token": "wrong-token" },
        })
      );
      assert.equal(wrongTokenRes.status, 403);

      const queryUnlockedRes = await debugStatusRoute(
        new Request("http://test/api/debug/status?uiDebug=1")
      );
      assert.equal(queryUnlockedRes.status, 200);

      const headerUnlockedRes = await debugStatusRoute(
        new Request("http://test/api/debug/status", {
          headers: { "x-ui-debug": "1" },
        })
      );
      assert.equal(headerUnlockedRes.status, 200);

      const adminUnlockedRes = await debugStatusRoute(
        new Request("http://test/api/debug/status", {
          headers: { "x-admin-token": "admin-secret-token-xyz" },
        })
      );
      assert.equal(adminUnlockedRes.status, 200);
    });

    it("returns full redacted diagnostics including toolchains and never leaks secrets or host paths", async () => {
      const ghReadCanary = ["ghp_", "TESTCANARY1234567890abcdefghij"].join("");
      const ghWriteCanary = ["ghp_", "WRITECANARY1234567890abcdefg"].join("");
      process.env.GITHUB_TOKEN = ghReadCanary;
      process.env.GITHUB_WRITE_TOKEN = ghWriteCanary;

      const runStore = getDefaultRunStore();
      const invite = runStore.createInviteCode({
        code: "secret-invite-code-99",
        allowedRunCount: 3,
      });

      const g = globalThis as Record<string, unknown>;
      g.__admissionQueue = [
        {
          runId: "run-queued-secret",
          url: "https://github.com/octocat/hello-world",
          sha: "abcdef1234567890",
          inviteCode: "secret-invite-code-99",
          inviteCodeHash: invite.codeHash,
          queuePosition: 1,
          queuedAt: Date.now(),
        },
      ];

      const res = await debugStatusRoute(
        new Request("http://test/api/debug/status?probeToolchains=1")
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);

      const diag = body.diagnostics;
      assert.ok(diag.timestamp);
      assert.ok(diag.engineVersion);
      assert.equal(diag.stores.runStore.inviteCodesSummary.total, 1);
      assert.equal(diag.stores.runStore.inviteCodesSummary.active, 1);
      assert.equal(diag.stores.runStore.inviteCodesSummary.totalRemainingRuns, 3);
      assert.equal(diag.envPresence.hasGithubToken, true);
      assert.equal(diag.envPresence.hasGithubWriteToken, true);
      assert.equal(diag.envPresence.hasAdminToken, true);
      assert.ok(diag.toolchains);
      assert.ok("git" in diag.toolchains);
      assert.ok("docker" in diag.toolchains);
      assert.ok("kiroCli" in diag.toolchains);
      assert.ok("wasmTreeSitter" in diag.toolchains);
      assert.ok("monacoAssets" in diag.toolchains);

      // Ensure zero secrets, invite codes, or host home paths leak
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes(ghReadCanary));
      assert.ok(!serialized.includes(ghWriteCanary));
      assert.ok(!serialized.includes("admin-secret-token-xyz"));
      assert.ok(!serialized.includes("secret-invite-code-99"));
      assert.ok(!serialized.includes(invite.codeHash));
      assert.ok(!serialized.includes(os.homedir()));
      assert.ok(!serialized.includes(tempDir));
    });

    it("evaluates probe gate gracefully when memory/RUNS.md is missing vs present", () => {
      const missing = evaluateProbeGateFromFile(path.join(tempDir, "missing-RUNS.md"));
      assert.equal(missing.sourcePresent, false);
      assert.equal(missing.devAllowed, false);
      assert.equal(missing.prodAllowed, false);
      assert.ok(missing.blocking.includes("P1"));

      const runsMdPath = path.join(tempDir, "RUNS.md");
      const devIds = [
        "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9",
        "P12", "P13", "P14", "P15", "S1", "S2", "S3", "S4", "S5",
      ];
      const rows = devIds.map((id) =>
        id === "P7" ? `| ${id} | failed (exit code 1) |` : `| ${id} | passed |`
      );
      rows.push("| P10 | passed |", "| P11 | passed |", "| P16 | passed |", "| P17 | passed |");
      fs.writeFileSync(runsMdPath, rows.join("\n"), "utf8");

      const passed = evaluateProbeGateFromFile(runsMdPath);
      assert.equal(passed.sourcePresent, true);
      assert.equal(passed.devAllowed, true);
      assert.equal(passed.prodAllowed, true);
      assert.deepEqual(passed.settledByFallback, ["P7"]);
      assert.deepEqual(passed.blocking, []);

      // Verify collectSystemDiagnostics uses custom runsMdPath cleanly
      const sys = collectSystemDiagnostics({ runsMdPath, probeToolchains: false });
      assert.equal(sys.probes.sourcePresent, true);
      assert.equal(sys.probes.devAllowed, true);
    });
  });

  describe("GET /api/debug/runs/[runId]", () => {
    it("enforces access guard, runId validation, and 404 on missing runs", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const locked = await debugRunRoute(
        new Request("http://test/api/debug/runs/run-1"),
        { params: Promise.resolve({ runId: "run-1" }) }
      );
      assert.equal(locked.status, 403);

      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      const badId = await debugRunRoute(
        new Request("http://test/api/debug/runs/.."),
        { params: Promise.resolve({ runId: ".." }) }
      );
      assert.equal(badId.status, 400);

      const missing = await debugRunRoute(
        new Request("http://test/api/debug/runs/does-not-exist"),
        { params: Promise.resolve({ runId: "does-not-exist" }) }
      );
      assert.equal(missing.status, 404);
    });

    it("computes sequenceIntegrity gaps, phaseParity, artifact SHA-256 verification, and redaction", async () => {
      const runId = "run-diag-inspect-1";
      const runStore = getDefaultRunStore();
      const eventStore = getDefaultEventStore();

      runStore.createRun({
        runId,
        url: "https://github.com/owner/legacy-pkg",
        sha: "1111222233334444555566667777888899990000",
        phase: "done",
        outcome: "resurrected",
      });

      const artDir = path.join(process.env.RUNS_DIR!, runId, "artifacts");
      fs.mkdirSync(artDir, { recursive: true });
      const patchBytes = "diff --git a/a.js b/a.js\n+const ok = true;\n";
      fs.writeFileSync(path.join(artDir, "all.patch"), patchBytes, "utf8");
      const patchSha = crypto.createHash("sha256").update(patchBytes).digest("hex");

      const fakeCanary = ["ghp_", "FAKECANARY1234567890abcdef12"].join("");
      eventStore.appendRecordedBatch([
        {
          runId,
          seq: 1,
          ts: 1700000001000,
          kind: "run.started",
          actor: "necromancer",
          data: { note: `token ${fakeCanary}`, refs: [] },
        },
        {
          runId,
          seq: 3,
          ts: 1700000003000,
          kind: "artifact.ready",
          actor: "necromancer",
          data: {
            kind: "patch",
            path: "artifacts/all.patch",
            sha256: patchSha,
            byteSize: Buffer.byteLength(patchBytes),
            refs: [],
          },
        },
        {
          runId,
          seq: 4,
          ts: 1700000004000,
          kind: "run.done",
          actor: "necromancer",
          data: { phase: "done", outcome: "resurrected", refs: [] },
        },
      ]);

      const res = await debugRunRoute(
        new Request(`http://test/api/debug/runs/${runId}`),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.runId, runId);
      assert.equal(body.sequenceIntegrity.eventCount, 3);
      assert.equal(body.sequenceIntegrity.firstSeq, 1);
      assert.equal(body.sequenceIntegrity.lastSeq, 4);
      assert.deepEqual(body.sequenceIntegrity.missingSeqGaps, [{ fromSeq: 2, toSeq: 2 }]);
      assert.equal(body.phaseParity.runStorePhase, "done");
      assert.equal(body.phaseParity.reducedViewPhase, "done");
      assert.equal(body.phaseParity.parityOk, true);
      assert.equal(body.countsByKind["run.done"], 1);
      assert.equal(body.countsByActor.necromancer, 3);

      const patchArt = body.artifacts.find((a: { id: string }) => a.id === "patch");
      assert.ok(patchArt);
      assert.equal(patchArt.presentOnDisk, true);
      assert.equal(patchArt.sha256, patchSha);
      assert.equal(patchArt.shaMatch, true);

      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes(fakeCanary));
      assert.ok(!serialized.includes(tempDir));
    });
  });

  describe("POST /api/debug/sim", () => {
    it("is locked in production unless ALLOW_DEBUG_SIM=1 and valid ADMIN_TOKEN", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      const deniedDefault = await debugSimRoute(
        new Request("http://test/api/debug/sim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-token": "admin-secret-token-xyz",
          },
          body: JSON.stringify({ action: "create_invite", code: "prod-try" }),
        })
      );
      assert.equal(deniedDefault.status, 403);
      assert.equal((await deniedDefault.json()).code, "SIM_DISABLED_IN_PRODUCTION");

      process.env.ALLOW_DEBUG_SIM = "1";
      const deniedBadToken = await debugSimRoute(
        new Request("http://test/api/debug/sim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-token": "wrong",
          },
          body: JSON.stringify({ action: "create_invite", code: "prod-try" }),
        })
      );
      assert.equal(deniedBadToken.status, 403);

      const allowedProd = await debugSimRoute(
        new Request("http://test/api/debug/sim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-token": "admin-secret-token-xyz",
          },
          body: JSON.stringify({ action: "create_invite", code: "prod-ok" }),
        })
      );
      assert.equal(allowedProd.status, 200);
      assert.equal((await allowedProd.json()).code, "prod-ok");
    });

    it("creates invite usable by start-run, steps a run end-to-end, writes real SHA-256 artifacts, and publishes to history", async () => {
      const inviteRes = await debugSimRoute(
        new Request("http://test/api/debug/sim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create_invite",
            code: "sim-invite-1",
            allowedRunCount: 2,
          }),
        })
      );
      assert.equal(inviteRes.status, 200);
      const inviteData = await inviteRes.json();
      assert.equal(inviteData.ok, true);
      assert.equal(inviteData.code, "sim-invite-1");

      const runId = "run-sim-e2e-1";
      const startRes = await startRunRoute(
        new Request("http://test/api/start-run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://github.com/octocat/legacy-sample",
            sha: "abcdef1234567890abcdef1234567890abcdef12",
            inviteCode: "sim-invite-1",
            runId,
          }),
        })
      );
      assert.equal(startRes.status, 202);

      const steps = [
        "exhume",
        "certificate",
        "plan",
        "pact",
        "legion",
        "approval",
        "ask",
        "done_resurrected",
        "publish",
      ];
      for (const step of steps) {
        const stepRes = await debugSimRoute(
          new Request("http://test/api/debug/sim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "step_run", runId, step }),
          })
        );
        assert.equal(stepRes.status, 200, `step ${step} should succeed`);
      }

      // Inspect debug run diagnostics -> parityOk and shaMatch across all 5 artifacts
      const diagRes = await debugRunRoute(
        new Request(`http://test/api/debug/runs/${runId}`),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(diagRes.status, 200);
      const diag = await diagRes.json();
      assert.equal(diag.phaseParity.parityOk, true);
      assert.equal(diag.phaseParity.runStorePhase, "done");
      assert.equal(diag.reducedView.outcome, "resurrected");
      assert.equal(diag.reducedView.approvals.length, 1);
      assert.equal(diag.reducedView.asks.length, 1);
      for (const art of diag.artifacts) {
        assert.equal(art.presentOnDisk, true, `${art.fileName} must be written on disk`);
        assert.equal(art.shaMatch, true, `${art.fileName} SHA-256 must match artifact.ready`);
      }

      // Check Reliquary detail route + download route
      const runDetailRes = await runDetailRoute(
        new Request(`http://test/api/runs/${runId}`),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(runDetailRes.status, 200);
      const detailJson = await runDetailRes.json();
      assert.equal(detailJson.outcome, "resurrected");
      assert.equal(detailJson.noTasksMerged, false);
      assert.ok(detailJson.diff && detailJson.diff.includes("diff --git"));

      const dlRes = await relicDownloadRoute(
        new Request(`http://test/runs/${runId}/relic/download?artifact=patch`),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(dlRes.status, 200);
      assert.equal(await dlRes.text(), detailJson.diff);

      // Check History route exposes the published run
      const histRes = await historyRoute(new Request("http://test/api/history"));
      assert.equal(histRes.status, 200);
      const hist = await histRes.json();
      assert.ok(hist.some((r: { runId: string; isPublished: boolean }) => r.runId === runId && r.isPublished));
    });
  });
});
