import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
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
  RunOrchestrator,
  getRunOrchestrator,
  resetRunOrchestrator,
} from "@/lib/orchestrator/run-orchestrator";
import {
  RuntimeHost,
  getRuntimeHost,
  resetRuntimeHost,
} from "@/lib/runtime/runtime-host";

import { POST as startRunRoute } from "@/app/api/start-run/route";
import { GET as eventsRoute } from "@/app/api/runs/[runId]/events/route";
import { GET as getRunRoute } from "@/app/api/runs/[runId]/route";
import { POST as controlRoute } from "@/app/api/runs/[runId]/control/route";
import { POST as approvalsRoute } from "@/app/api/runs/[runId]/approvals/route";
import { POST as asksRoute } from "@/app/api/runs/[runId]/asks/route";
import { POST as skeletonsRoute } from "@/app/api/runs/[runId]/skeletons/[skeletonId]/route";
import { POST as pactRoute } from "@/app/api/runs/[runId]/pact/route";
import { GET as relicDownloadRoute } from "@/app/runs/[runId]/relic/download/route";
import { GET as healthRoute } from "@/app/api/health/route";

describe("T34D: API routes to RuntimeHost/RunOrchestrator wiring", () => {
  let tempDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t34d-wiring-test-"));
    process.env.RUN_STORE_PATH = path.join(tempDir, "runs.db");
    process.env.EVENT_STORE_PATH = path.join(tempDir, "events.db");
    process.env.RUNS_DIR = path.join(tempDir, "runs");
    process.env.ADMIN_TOKEN = "secret-admin-123";

    resetDefaultRunStore();
    resetDefaultEventStore();

    const g = globalThis as any;
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
    await resetRunOrchestrator({ closeHost: true });
    await resetRuntimeHost({ closeStores: true });
    resetDefaultRunStore();
    resetDefaultEventStore();

    const g = globalThis as any;
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
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // 1. start-run route wiring & orchestrator enqueue
  // ---------------------------------------------------------------------------
  describe("start-run route wiring", () => {
    it("creates run, emits run.queued & run.queue_position, and enqueues to orchestrator", async () => {
      const runStore = getDefaultRunStore();
      const invite = runStore.createInviteCode({
        code: "valid-invite-code",
        allowedRunCount: 5,
      });

      let enqueuedRunId: string | null = null;
      (globalThis as any).__runOrchestrator = {
        enqueueRun: (id: string) => {
          enqueuedRunId = id;
          return { queuePosition: 1, runId: id };
        },
      };

      const req = new Request("http://test/api/start-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/test-owner/test-repo",
          sha: "abcdef1234567890abcdef1234567890abcdef12",
          inviteCode: "valid-invite-code",
          runId: "run-wiring-01",
        }),
      });

      const res = await startRunRoute(req);
      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.runId, "run-wiring-01");
      assert.equal(enqueuedRunId, "run-wiring-01");

      // Verify RunStore record
      const record = runStore.getRun("run-wiring-01");
      assert.ok(record);
      assert.equal(record.phase, "queued");

      // Verify EventStore records
      const eventStore = getDefaultEventStore();
      const events = eventStore.getEvents("run-wiring-01");
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes("run.queued"));
      assert.ok(kinds.includes("run.queue_position"));
    });

    it("does not call global orchestrator when mock runStore is injected", async () => {
      const memDb = new DatabaseSync(":memory:");
      const mockRunStore = new RunStore(memDb);
      const mockEventStore = new EventStore(memDb);
      mockRunStore.createInviteCode({
        code: "mock-invite",
        allowedRunCount: 5,
      });

      let enqueued = false;
      (globalThis as any).__runOrchestrator = {
        enqueueRun: () => {
          enqueued = true;
        },
      };

      const req = new Request("http://test/api/start-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/test/repo",
          sha: "1234567890abcdef1234567890abcdef12345678",
          inviteCode: "mock-invite",
          runId: "run-isolated-test",
        }),
      });
      (req as any).runStore = mockRunStore;
      (req as any).eventStore = mockEventStore;

      const res = await startRunRoute(req);
      assert.equal(res.status, 202);
      assert.equal(enqueued, false, "injected mock-store request must not invoke global orchestrator");

      memDb.close();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. events route persistent shared EventStore
  // ---------------------------------------------------------------------------
  describe("events route persistent EventStore", () => {
    it("persists across getDefaultEventStore without silent :memory: fallback", async () => {
      const store = getDefaultEventStore();
      store.append({
        runId: "run-events-persistent",
        kind: "run.queued",
        actor: "necromancer",
        data: { queuePosition: 1 },
      });
      store.append({
        runId: "run-events-persistent",
        kind: "task.state",
        actor: "necromancer",
        taskId: "T1",
        data: { state: "in_progress", title: "Task 1" },
      });

      const req = new Request("http://test/api/runs/run-events-persistent/events?from=1");
      const res = await eventsRoute(req, {
        params: Promise.resolve({ runId: "run-events-persistent" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.equal(data.length, 2);
      assert.equal(data[0].kind, "run.queued");
      assert.equal(data[1].kind, "task.state");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. GET /api/runs/[runId] details & artifacts
  // ---------------------------------------------------------------------------
  describe("GET /api/runs/[runId] route", () => {
    it("returns 404 when run does not exist and has no events", async () => {
      const req = new Request("http://test/api/runs/nonexistent-run");
      const res = await getRunRoute(req, {
        params: Promise.resolve({ runId: "nonexistent-run" }),
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.ok, false);
    });

    it("returns real size & sha256 for on-disk artifacts and missing:true when absent", async () => {
      const runId = "run-detail-artifacts";
      const runStore = getDefaultRunStore();
      const eventStore = getDefaultEventStore();

      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "done",
        outcome: "resurrected",
      });

      eventStore.append({
        runId,
        kind: "task.state",
        actor: "warden",
        taskId: "T1",
        data: { state: "merged", title: "Fix dependency" },
      });

      // Create on-disk artifact all.patch
      const artDir = path.join(process.env.RUNS_DIR!, runId, "artifacts");
      fs.mkdirSync(artDir, { recursive: true });
      const patchContent = "diff --git a/index.js b/index.js\n+console.log('fixed');\n";
      fs.writeFileSync(path.join(artDir, "all.patch"), patchContent, "utf8");

      const expectedSha = crypto.createHash("sha256").update(patchContent).digest("hex");
      const expectedSize = Buffer.byteLength(patchContent);

      const req = new Request(`http://test/api/runs/${runId}`);
      const res = await getRunRoute(req, {
        params: Promise.resolve({ runId }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.runId, runId);
      assert.equal(body.phase, "done");
      assert.equal(body.outcome, "resurrected");
      assert.equal(body.noTasksMerged, false, "T1 was merged, so noTasksMerged should be false");
      assert.equal(body.diff, patchContent);

      // Verify all.patch has real size and real sha256
      const patchArt = body.artifacts.find((a: any) => a.id === "patch");
      assert.ok(patchArt);
      assert.equal(patchArt.size, expectedSize);
      assert.equal(patchArt.sha256, expectedSha);
      assert.equal(patchArt.missing, undefined);

      // Verify absent artifacts have missing: true and no sha256
      const specArt = body.artifacts.find((a: any) => a.id === "spec");
      assert.ok(specArt);
      assert.equal(specArt.missing, true);
      assert.equal(specArt.sha256, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. POST /api/runs/[runId]/control
  // ---------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/control route", () => {
    it("returns 404 if run is missing", async () => {
      const req = new Request("http://test/api/runs/missing-run/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      });
      const res = await controlRoute(req, {
        params: Promise.resolve({ runId: "missing-run" }),
      });
      assert.equal(res.status, 404);
    });

    it("rejects invalid action with 400", async () => {
      const req = new Request("http://test/api/runs/run-test/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invalid_action" }),
      });
      const res = await controlRoute(req, {
        params: Promise.resolve({ runId: "run-test" }),
      });
      assert.equal(res.status, 400);
    });

    it("executes pause and resume actions, updating stores and active orchestrator", async () => {
      const runId = "run-ctrl-pause-resume";
      const runStore = getDefaultRunStore();
      const eventStore = getDefaultEventStore();

      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
      });

      let paused = false;
      let resumed = false;
      (globalThis as any).__runOrchestrator = {
        pauseRun: (id: string) => {
          if (id === runId) paused = true;
        },
        resumeRun: (id: string) => {
          if (id === runId) resumed = true;
        },
      };

      // Pause
      const pauseReq = new Request(`http://test/api/runs/${runId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause", reason: "testing pause" }),
      });
      const pauseRes = await controlRoute(pauseReq, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(pauseRes.status, 200);
      assert.equal(paused, true);

      // Resume
      const resumeReq = new Request(`http://test/api/runs/${runId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      });
      const resumeRes = await controlRoute(resumeReq, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(resumeRes.status, 200);
      assert.equal(resumed, true);

      const events = eventStore.getEvents(runId);
      const clockEvents = events.filter((e) => e.kind === "run.clock");
      assert.equal(clockEvents.length, 2);
    });

    it("enforces admin token for kill action when ADMIN_TOKEN is set", async () => {
      const runId = "run-ctrl-kill";
      const runStore = getDefaultRunStore();
      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
      });

      // Without token -> 403
      const reqNoAuth = new Request(`http://test/api/runs/${runId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kill", reason: "bad attempt" }),
      });
      const resNoAuth = await controlRoute(reqNoAuth, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(resNoAuth.status, 403);

      // With wrong token -> 403
      const reqWrongAuth = new Request(`http://test/api/runs/${runId}/control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": "wrong-token",
        },
        body: JSON.stringify({ action: "kill" }),
      });
      const resWrongAuth = await controlRoute(reqWrongAuth, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(resWrongAuth.status, 403);

      // With correct token in header -> 200
      let killed = false;
      (globalThis as any).__runOrchestrator = {
        killRun: async (id: string) => {
          if (id === runId) killed = true;
        },
      };

      const reqAuth = new Request(`http://test/api/runs/${runId}/control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": "secret-admin-123",
        },
        body: JSON.stringify({ action: "kill", reason: "kill authorized" }),
      });
      const resAuth = await controlRoute(reqAuth, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(resAuth.status, 200);
      assert.equal(killed, true);

      // Check run record updated to outcome killed
      const updatedRun = runStore.getRun(runId);
      assert.equal(updatedRun?.phase, "done");
      assert.equal(updatedRun?.outcome, "killed");
    });

    it("enforces invite code verification when run has inviteCodeHash", async () => {
      const runId = "run-ctrl-invite";
      const runStore = getDefaultRunStore();
      const invite = runStore.createInviteCode({
        code: "ctrl-secret-invite",
        allowedRunCount: 5,
      });
      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
        inviteCodeHash: invite.codeHash,
      });

      // Missing invite code -> 401
      const resMissing = await controlRoute(
        new Request(`http://test/api/runs/${runId}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pause" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resMissing.status, 401);

      // Spoofed x-admin: true header without ADMIN_TOKEN -> still 401
      const resSpoof = await controlRoute(
        new Request(`http://test/api/runs/${runId}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin": "true" },
          body: JSON.stringify({ action: "pause" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resSpoof.status, 401);

      // Wrong invite code -> 403
      const resWrong = await controlRoute(
        new Request(`http://test/api/runs/${runId}/control`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "wrong-invite",
          },
          body: JSON.stringify({ action: "pause" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resWrong.status, 403);

      // Matching invite code header -> 200
      const resValidHeader = await controlRoute(
        new Request(`http://test/api/runs/${runId}/control`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "ctrl-secret-invite",
          },
          body: JSON.stringify({ action: "pause" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resValidHeader.status, 200);

      // Matching invite code in JSON body -> 200
      const resValidBody = await controlRoute(
        new Request(`http://test/api/runs/${runId}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "resume",
            inviteCode: "ctrl-secret-invite",
          }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resValidBody.status, 200);

      // Invite code alone cannot perform admin kill when ADMIN_TOKEN is set -> 403
      const resKillUser = await controlRoute(
        new Request(`http://test/api/runs/${runId}/control`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "ctrl-secret-invite",
          },
          body: JSON.stringify({ action: "kill" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resKillUser.status, 403);

      // Admin token can kill even without user invite code -> 200
      const resKillAdmin = await controlRoute(
        new Request(`http://test/api/runs/${runId}/control`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-token": "secret-admin-123",
          },
          body: JSON.stringify({ action: "kill" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resKillAdmin.status, 200);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. POST /api/runs/[runId]/approvals
  // ---------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/approvals route", () => {
    it("validates decision, resolves approval in orchestrator and emits approval.resolved", async () => {
      const runId = "run-approval-test";
      const runStore = getDefaultRunStore();
      const eventStore = getDefaultEventStore();

      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
      });

      let resolvedApprovalId: string | null = null;
      let resolvedDecision: string | null = null;
      (globalThis as any).__runOrchestrator = {
        resolveApproval: async (rId: string, aId: string, resolution: any) => {
          resolvedApprovalId = aId;
          resolvedDecision = resolution.decision;
          return { resolved: true };
        },
      };

      const req = new Request(`http://test/api/runs/${runId}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: "appr-01",
          decision: "approve_once",
          reason: "Approved command run",
        }),
      });

      const res = await approvalsRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.approvalId, "appr-01");
      assert.equal(data.decision, "approve_once");
      assert.equal(resolvedApprovalId, "appr-01");
      assert.equal(resolvedDecision, "approve_once");

      // Verify event in store
      const events = eventStore.getEvents(runId);
      const resolvedEvent = events.find((e) => e.kind === "approval.resolved");
      assert.ok(resolvedEvent);
      assert.equal((resolvedEvent.data as any).approvalId, "appr-01");
      assert.equal((resolvedEvent.data as any).decision, "approve_once");
    });

    it("rejects invalid decision enum with 400", async () => {
      const runId = "run-approval-invalid";
      getDefaultRunStore().createRun({
        runId,
        url: "https://test",
        sha: "123",
      });

      const req = new Request(`http://test/api/runs/${runId}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: "appr-01",
          decision: "unrecognized_decision",
        }),
      });

      const res = await approvalsRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(res.status, 400);
    });

    it("enforces invite code verification when run has inviteCodeHash", async () => {
      const runId = "run-approval-invite";
      const runStore = getDefaultRunStore();
      const invite = runStore.createInviteCode({
        code: "appr-secret-invite",
        allowedRunCount: 5,
      });
      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
        inviteCodeHash: invite.codeHash,
      });

      const resMissing = await approvalsRoute(
        new Request(`http://test/api/runs/${runId}/approvals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: "appr-1", decision: "approve_once" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resMissing.status, 401);
      assert.equal((await resMissing.json()).code, "MISSING_INVITE_CODE");

      const resWrong = await approvalsRoute(
        new Request(`http://test/api/runs/${runId}/approvals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "wrong-invite",
          },
          body: JSON.stringify({ approvalId: "appr-1", decision: "approve_once" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resWrong.status, 403);
      assert.equal((await resWrong.json()).code, "INVALID_INVITE_CODE");

      const resValid = await approvalsRoute(
        new Request(`http://test/api/runs/${runId}/approvals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "appr-secret-invite",
          },
          body: JSON.stringify({ approvalId: "appr-1", decision: "approve_once" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resValid.status, 200);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. POST /api/runs/[runId]/asks
  // ---------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/asks route", () => {
    it("enforces invite code verification when run has inviteCodeHash", async () => {
      const runId = "run-asks-invite";
      const runStore = getDefaultRunStore();
      const invite = runStore.createInviteCode({
        code: "asks-secret-invite",
        allowedRunCount: 5,
      });
      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
        inviteCodeHash: invite.codeHash,
      });

      const resMissing = await asksRoute(
        new Request(`http://test/api/runs/${runId}/asks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ askId: "ask-1", answer: "yes" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resMissing.status, 401);
      assert.equal((await resMissing.json()).code, "MISSING_INVITE_CODE");

      const resWrong = await asksRoute(
        new Request(`http://test/api/runs/${runId}/asks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "wrong-invite",
          },
          body: JSON.stringify({ askId: "ask-1", answer: "yes" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resWrong.status, 403);
      assert.equal((await resWrong.json()).code, "INVALID_INVITE_CODE");

      const resValid = await asksRoute(
        new Request(`http://test/api/runs/${runId}/asks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "asks-secret-invite",
          },
          body: JSON.stringify({ askId: "ask-1", answer: "yes" }),
        }),
        { params: Promise.resolve({ runId }) }
      );
      assert.equal(resValid.status, 200);
    });
    it("validates body, forwards to orchestrator answerAsk, and appends ask.answered event", async () => {
      const runId = "run-asks-test";
      const runStore = getDefaultRunStore();
      const eventStore = getDefaultEventStore();

      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
      });

      let answeredAskId: string | null = null;
      let receivedAnswer: any = null;
      (globalThis as any).__runOrchestrator = {
        answerAsk: async (rId: string, askId: string, answer: any) => {
          answeredAskId = askId;
          receivedAnswer = answer;
          return true;
        },
      };

      const req = new Request(`http://test/api/runs/${runId}/asks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          askId: "ask-step-3",
          answer: "skip",
        }),
      });

      const res = await asksRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.askId, "ask-step-3");
      assert.equal(answeredAskId, "ask-step-3");
      assert.equal(receivedAnswer, "skip");

      // Verify event
      const events = eventStore.getEvents(runId);
      const askEvent = events.find((e) => e.kind === "ask.answered");
      assert.ok(askEvent);
      assert.equal((askEvent.data as any).askId, "ask-step-3");
      assert.equal((askEvent.data as any).answer, "skip");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. POST /api/runs/[runId]/skeletons/[skeletonId]
  // ---------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/skeletons/[skeletonId] route", () => {
    it("handles skeleton actions (interrupt, reraise, lay_to_rest, send_instruction, add_review_focus) and emits events", async () => {
      const runId = "run-skeleton-test";
      const skeletonId = "skel-bonesetter-1";
      const runStore = getDefaultRunStore();
      const eventStore = getDefaultEventStore();

      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
      });

      const actions = [
        { action: "interrupt", expectedKind: "skeleton.interrupted" },
        { action: "reraise", expectedKind: "skeleton.reraised" },
        { action: "lay_to_rest", expectedKind: "skeleton.laid_to_rest" },
        { action: "send_instruction", instruction: "Do not touch lib/legacy", expectedKind: "skeleton.instruction" },
        { action: "add_review_focus", focus: "check security constraints", expectedKind: "warden.focus_added" },
      ];

      for (const item of actions) {
        const req = new Request(`http://test/api/runs/${runId}/skeletons/${skeletonId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        });

        const res = await skeletonsRoute(req, {
          params: Promise.resolve({ runId, skeletonId }),
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.equal(data.action, item.action);
      }

      const events = eventStore.getEvents(runId);
      for (const item of actions) {
        const found = events.find((e) => e.kind === item.expectedKind);
        assert.ok(found, `Event ${item.expectedKind} should be present in EventStore`);
      }
    });

    it("rejects path traversal or unsafe characters in runId or skeletonId", async () => {
      const req = new Request("http://test/api/runs/bad%2Fid/skeletons/skel/1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "interrupt" }),
      });
      const res = await skeletonsRoute(req, {
        params: Promise.resolve({ runId: "bad/id", skeletonId: "skel/1" }),
      });
      assert.equal(res.status, 400);
    });

    it("enforces invite code verification when run has inviteCodeHash", async () => {
      const runId = "run-skel-invite";
      const skeletonId = "skel-bonesetter-1";
      const runStore = getDefaultRunStore();
      const invite = runStore.createInviteCode({
        code: "skel-secret-invite",
        allowedRunCount: 5,
      });
      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "legion",
        inviteCodeHash: invite.codeHash,
      });

      const resMissing = await skeletonsRoute(
        new Request(`http://test/api/runs/${runId}/skeletons/${skeletonId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin": "true" },
          body: JSON.stringify({ action: "interrupt" }),
        }),
        { params: Promise.resolve({ runId, skeletonId }) }
      );
      assert.equal(resMissing.status, 401);
      assert.equal((await resMissing.json()).code, "MISSING_INVITE_CODE");

      const resWrong = await skeletonsRoute(
        new Request(`http://test/api/runs/${runId}/skeletons/${skeletonId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "wrong-invite",
          },
          body: JSON.stringify({ action: "interrupt" }),
        }),
        { params: Promise.resolve({ runId, skeletonId }) }
      );
      assert.equal(resWrong.status, 403);
      assert.equal((await resWrong.json()).code, "INVALID_INVITE_CODE");

      const resValid = await skeletonsRoute(
        new Request(`http://test/api/runs/${runId}/skeletons/${skeletonId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": "skel-secret-invite",
          },
          body: JSON.stringify({ action: "interrupt" }),
        }),
        { params: Promise.resolve({ runId, skeletonId }) }
      );
      assert.equal(resValid.status, 200);

      const resAdmin = await skeletonsRoute(
        new Request(`http://test/api/runs/${runId}/skeletons/${skeletonId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-token": "secret-admin-123",
          },
          body: JSON.stringify({ action: "reraise" }),
        }),
        { params: Promise.resolve({ runId, skeletonId }) }
      );
      assert.equal(resAdmin.status, 200);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. relic/download route (200, 404, 400)
  // ---------------------------------------------------------------------------
  describe("relic/download route", () => {
    it("returns 200 with exact bytes and Content-Disposition for existing file", async () => {
      const runId = "run-relic-dl-ok";
      const artDir = path.join(process.env.RUNS_DIR!, runId, "artifacts");
      fs.mkdirSync(artDir, { recursive: true });
      const testDiff = "diff --git a/test b/test\n+line\n";
      fs.writeFileSync(path.join(artDir, "all.patch"), testDiff, "utf8");

      const req = new Request(`http://test/runs/${runId}/relic/download?artifact=patch`);
      const res = await relicDownloadRoute(req, {
        params: Promise.resolve({ runId }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("Content-Disposition")?.includes('filename="all.patch"'));
      const text = await res.text();
      assert.equal(text, testDiff);
    });

    it("returns 404 JSON when artifact is missing (never fake 200 placeholder)", async () => {
      const req = new Request("http://test/runs/run-relic-missing/relic/download?artifact=spec");
      const res = await relicDownloadRoute(req, {
        params: Promise.resolve({ runId: "run-relic-missing" }),
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.deepEqual(data, { error: "Artifact not found" });
    });

    it("returns 400 JSON when artifact is invalid or path traversal is attempted", async () => {
      const req1 = new Request("http://test/runs/run-test/relic/download?artifact=../../etc/passwd");
      const res1 = await relicDownloadRoute(req1, {
        params: Promise.resolve({ runId: "run-test" }),
      });
      assert.equal(res1.status, 400);

      const req2 = new Request("http://test/runs/run-test/relic/download?artifact=unknown_art");
      const res2 = await relicDownloadRoute(req2, {
        params: Promise.resolve({ runId: "run-test" }),
      });
      assert.equal(res2.status, 400);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. pact/route orchestrator wiring
  // ---------------------------------------------------------------------------
  describe("pact/route orchestrator wiring", () => {
    it("forwards approve, revise, and stop to active RunOrchestrator", async () => {
      const runId = "run-pact-wiring";
      const runStore = getDefaultRunStore();
      const eventStore = getDefaultEventStore();

      runStore.createRun({
        runId,
        url: "https://github.com/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase: "pact_review",
        caps: { maxMinutes: 60, maxParallel: 2 },
      });

      // Populate draft event
      eventStore.append({
        runId,
        kind: "pact.drafted",
        actor: "planner",
        data: {
          draftId: "draft-1",
          version: 1,
          tasks: [
            {
              id: "T1",
              title: "Task 1",
              role: "bonesetter",
              hard: true,
              rules: ["M1"],
            },
          ],
          markdown: "## The Pact\n- Task 1",
          sha256: "draft-sha",
        },
      });

      let approved = false;
      let revised = false;
      let stopped = false;

      (globalThis as any).__runOrchestrator = {
        approvePact: async (id: string) => {
          if (id === runId) approved = true;
        },
        revisePact: async (id: string, fb: string) => {
          if (id === runId && fb === "revise this") revised = true;
          return {} as any;
        },
        stopRun: async (id: string) => {
          if (id === runId) stopped = true;
        },
      };

      // 1. Revise
      const revReq = new Request(`http://test/api/runs/${runId}/pact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revise", feedback: "revise this" }),
      });
      const revRes = await pactRoute(revReq, { params: Promise.resolve({ runId }) });
      assert.equal(revRes.status, 200);
      assert.equal(revised, true);

      // 2. Approve
      const appReq = new Request(`http://test/api/runs/${runId}/pact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          approvedTaskIds: ["T1"],
          budget: { maxMinutes: 60, maxParallel: 2 },
        }),
      });
      const appRes = await pactRoute(appReq, { params: Promise.resolve({ runId }) });
      assert.equal(appRes.status, 200);
      assert.equal(approved, true);

      // 3. Stop
      const stopReq = new Request(`http://test/api/runs/${runId}/pact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", reason: "testing stop" }),
      });
      const stopRes = await pactRoute(stopReq, { params: Promise.resolve({ runId }) });
      assert.equal(stopRes.status, 200);
      assert.equal(stopped, true);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. health route RuntimeHost availability
  // ---------------------------------------------------------------------------
  describe("health route RuntimeHost availability", () => {
    it("respects RuntimeHost backend adapter when neither request.backend nor globalThis.__backend was set", async () => {
      const g = globalThis as any;
      delete g.__backend;
      g.__admission = {
        isPaused: () => false,
        isUnavailable: () => false,
        isHealthy: () => true,
        getQueueLength: () => 0,
      };

      const host = getRuntimeHost();
      assert.ok(host.backendAdapter);

      const req = new Request("http://test/api/health");
      const res = await healthRoute(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "open");
      assert.equal(data.ok, true);
    });

    it("initializes admission and backend on cold-boot first request before start-run loads", async () => {
      const g = globalThis as any;
      delete g.__backend;
      delete g.__admission;
      if (Array.isArray(g.__admissionQueue)) {
        g.__admissionQueue.length = 0;
      }
      await resetRuntimeHost({ closeStores: true });

      const req = new Request("http://test/api/health");
      const res = await healthRoute(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, "open");
      assert.equal(data.ok, true);
      assert.ok(g.__admission);
      assert.ok(g.__backend);
    });
  });
});
