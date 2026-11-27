import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";

import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";

import { POST as postMessage, GET as getMessages } from "@/app/api/runs/[runId]/messages/route";
import { POST as resolveApproval } from "@/app/api/runs/[runId]/approvals/[approvalId]/route";
import { POST as answerAsk } from "@/app/api/runs/[runId]/asks/[askId]/route";
import { POST as skeletonAction } from "@/app/api/runs/[runId]/skeletons/[skeletonId]/actions/route";
import { POST as controlRun } from "@/app/api/runs/[runId]/control/route";
import { POST as pushFork } from "@/app/api/runs/[runId]/push-fork/route";

import {
  postMessage as apiPostMessage,
  postApprovalById,
  postAskAnswerById,
  postSkeletonActionV2,
  postPushFork,
  postControl,
} from "@/lib/ui/api";

const OWNER_INVITE = "invite-owner-secret";
const OWNER_INVITE_HASH = crypto
  .createHash("sha256")
  .update(OWNER_INVITE)
  .digest("hex");

function makeStores(): { runStore: RunStore; eventStore: EventStore } {
  const runStore = new RunStore(":memory:");
  const eventStore = new EventStore(":memory:");
  const g = globalThis as Record<string, unknown>;
  g.__runStore = runStore;
  g.__eventStore = eventStore;
  return { runStore, eventStore };
}

function makeRun(
  runStore: RunStore,
  runId: string,
  overrides: Record<string, unknown> = {}
): void {
  runStore.createRun({
    runId,
    url: "https://github.com/source-owner/source-repo",
    sha: "1234567890abcdef1234567890abcdef12345678",
    phase: "done",
    ...overrides,
  } as never);
}

function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function runParams(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

async function readJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

/**
 * Raises the pending `push_confirm` ask for a run the way the two-step route
 * expects, returning the ask id the confirmation must echo back.
 */
async function raisePushConfirmAsk(
  runId: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<string> {
  const res = await pushFork(
    jsonRequest(
      `http://test/api/runs/${runId}/push-fork`,
      { confirmed: false, ...body },
      headers
    ),
    runParams(runId)
  );
  assert.equal(res.status, 202, "the unconfirmed step should raise an ask");
  const data = await readJson(res);
  assert.equal(typeof data.askId, "string");
  return data.askId as string;
}

describe("mutating run API routes", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.DISABLE_AUTO_ORCHESTRATOR = "1";
    delete process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_KEY;

    const g = globalThis as Record<string, unknown>;
    delete g.__runStore;
    delete g.__eventStore;
    delete g.__runOrchestrator;
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.__runStore;
    delete g.__eventStore;
    delete g.__runOrchestrator;
    process.env = savedEnv;
  });

  // -------------------------------------------------------------------------
  // POST /api/runs/[runId]/messages
  // -------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/messages", () => {
    it("records message.sent with cc: necromancer when a user targets a Skeleton", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-msg-ok";
      makeRun(runStore, runId);

      const req = jsonRequest(`http://test/api/runs/${runId}/messages`, {
        to: "exhumer",
        intent: "instruct",
        text: "keep going",
        delivery: "after_command",
      });
      const res = await postMessage(req, runParams(runId));
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.ok, true);
      assert.equal(data.runId, runId);
      assert.equal(data.message.to, "exhumer");
      assert.equal(data.message.cc, "necromancer");

      const sent = eventStore.getEvents(runId, { kind: "message.sent" });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].data.cc, "necromancer");
      assert.equal(sent[0].data.to, "exhumer");
    });

    it("enforces caller ownership: 401 without a code, 403 with a wrong code, 200 with the owner code", async () => {
      const { runStore } = makeStores();
      const runId = "run-msg-auth";
      makeRun(runStore, runId, { inviteCodeHash: OWNER_INVITE_HASH });

      const noCode = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "exhumer",
          intent: "instruct",
        }),
        runParams(runId)
      );
      assert.equal(noCode.status, 401);

      const wrongCode = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "exhumer",
          intent: "instruct",
          inviteCode: "nope",
        }),
        runParams(runId)
      );
      assert.equal(wrongCode.status, 403);

      const okCode = await postMessage(
        jsonRequest(
          `http://test/api/runs/${runId}/messages`,
          { to: "exhumer", intent: "instruct" },
          { "x-invite-code": OWNER_INVITE }
        ),
        runParams(runId)
      );
      assert.equal(okCode.status, 200);
    });

    it("returns 400 for an invalid runId, invalid JSON and schema errors", async () => {
      makeStores();

      const badId = await postMessage(
        jsonRequest("http://test/api/runs/..%2Fbad/messages", {
          to: "exhumer",
          intent: "instruct",
        }),
        runParams(".." )
      );
      assert.equal(badId.status, 400);

      const runId = "run-msg-bad-json";
      const badJson = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, "not-json"),
        runParams(runId)
      );
      assert.equal(badJson.status, 400);

      const missingTo = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, { intent: "instruct" }),
        runParams(runId)
      );
      assert.equal(missingTo.status, 400);
    });

    it("rejects intents that would steer a Warden or Scribe", async () => {
      const { runStore } = makeStores();
      const runId = "run-msg-roles";
      makeRun(runStore, runId);

      const warden = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "warden",
          intent: "instruct",
        }),
        runParams(runId)
      );
      assert.equal(warden.status, 403);

      const scribe = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "scribe",
          intent: "instruct_now",
        }),
        runParams(runId)
      );
      assert.equal(scribe.status, 403);

      const wrongRoleIntent = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "planner",
          intent: "add_review_focus",
        }),
        runParams(runId)
      );
      assert.equal(wrongRoleIntent.status, 400);
    });

    it("hard-blocks destructive user instructions", async () => {
      const { runStore } = makeStores();
      const runId = "run-msg-hardblock";
      makeRun(runStore, runId);

      const res = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "planner",
          intent: "instruct",
          text: "sudo rm -rf /",
        }),
        runParams(runId)
      );
      assert.equal(res.status, 403);
    });

    it("returns 404 when the run does not exist", async () => {
      makeStores();
      const res = await postMessage(
        jsonRequest("http://test/api/runs/run-missing/messages", {
          to: "planner",
          intent: "instruct",
        }),
        runParams("run-missing")
      );
      assert.equal(res.status, 404);
    });

    it("rejects a skeletonId raised by another run (403/404)", async () => {
      const { runStore, eventStore } = makeStores();
      const ownerRun = "run-msg-skel-owner";
      const targetRun = "run-msg-skel-other";
      makeRun(runStore, ownerRun);
      makeRun(runStore, targetRun);

      eventStore.append({
        runId: ownerRun,
        kind: "skeleton.raised",
        actor: "necromancer",
        skeletonId: "skel-msg-cross",
        data: { skeletonId: "skel-msg-cross" },
      });

      const res = await postMessage(
        jsonRequest(`http://test/api/runs/${targetRun}/messages`, {
          to: "exhumer",
          intent: "instruct",
          skeletonId: "skel-msg-cross",
        }),
        runParams(targetRun)
      );
      assert.ok(
        res.status === 403 || res.status === 404,
        `cross-run skeletonId should fail closed, got ${res.status}`
      );
      assert.equal(
        eventStore.getEvents(targetRun, { kind: "message.sent" }).length,
        0
      );
    });

    it("accepts a message whose skeletonId belongs to this run", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-msg-skel-own";
      makeRun(runStore, runId);

      eventStore.append({
        runId,
        kind: "skeleton.raised",
        actor: "necromancer",
        skeletonId: "skel-msg-own",
        data: { skeletonId: "skel-msg-own" },
      });

      const res = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "exhumer",
          intent: "instruct",
          text: "stay on it",
          skeletonId: "skel-msg-own",
        }),
        runParams(runId)
      );
      assert.equal(res.status, 200);
    });

    it("rejects an unsafe skeletonId with 400", async () => {
      const { runStore } = makeStores();
      const runId = "run-msg-skel-unsafe";
      makeRun(runStore, runId);

      const res = await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "exhumer",
          intent: "instruct",
          skeletonId: "../escape",
        }),
        runParams(runId)
      );
      assert.equal(res.status, 400);
    });
  });


  // -------------------------------------------------------------------------
  // GET /api/runs/[runId]/messages
  // -------------------------------------------------------------------------
  describe("GET /api/runs/[runId]/messages", () => {
    it("lists messages from the event log", async () => {
      const { runStore } = makeStores();
      const runId = "run-msg-get";
      makeRun(runStore, runId);

      await postMessage(
        jsonRequest(`http://test/api/runs/${runId}/messages`, {
          to: "exhumer",
          intent: "instruct",
          text: "one",
        }),
        runParams(runId)
      );

      const res = await getMessages(
        new Request(`http://test/api/runs/${runId}/messages`),
        runParams(runId)
      );
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.ok, true);
      assert.equal(data.messages.length, 1);
      assert.equal(data.messages[0].to, "exhumer");
    });

    it("returns 404 for a missing run and 401/403 for callers", async () => {
      const { runStore } = makeStores();
      const missing = await getMessages(
        new Request("http://test/api/runs/run-none/messages"),
        runParams("run-none")
      );
      assert.equal(missing.status, 404);

      const runId = "run-msg-get-auth";
      makeRun(runStore, runId, { inviteCodeHash: OWNER_INVITE_HASH });

      const noCode = await getMessages(
        new Request(`http://test/api/runs/${runId}/messages`),
        runParams(runId)
      );
      assert.equal(noCode.status, 401);

      const wrong = await getMessages(
        new Request(`http://test/api/runs/${runId}/messages`, {
          headers: { "x-invite-code": "wrong" },
        }),
        runParams(runId)
      );
      assert.equal(wrong.status, 403);

      const ok = await getMessages(
        new Request(`http://test/api/runs/${runId}/messages`, {
          headers: { "x-invite-code": OWNER_INVITE },
        }),
        runParams(runId)
      );
      assert.equal(ok.status, 200);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/runs/[runId]/approvals/[approvalId]
  // -------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/approvals/[approvalId]", () => {
    it("forwards to the orchestrator and records approval.resolved", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-appr-ok";
      makeRun(runStore, runId);

      const calls: Array<{ id: string; decision: string }> = [];
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        resolveApproval: async (_runId: string, approvalId: string, resolution: any) => {
          calls.push({ id: approvalId, decision: resolution.decision });
          return { ok: true };
        },
      };

      const res = await resolveApproval(
        jsonRequest(`http://test/api/runs/${runId}/approvals/appr-1`, {
          decision: "approve_once",
          reason: "looks fine",
        }),
        { params: Promise.resolve({ runId, approvalId: "appr-1" }) }
      );
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.ok, true);
      assert.equal(data.approvalId, "appr-1");
      assert.equal(data.decision, "approve_once");
      assert.equal(data.resolved, true);
      assert.deepEqual(calls, [{ id: "appr-1", decision: "approve_once" }]);

      const events = eventStore.getEvents(runId, { kind: "approval.resolved" });
      assert.equal(events.length, 1);
      assert.equal(events[0].data.decision, "approve_once");
    });

    it("persists an approved pattern for approve_pattern once it resolves", async () => {
      const { runStore } = makeStores();
      const runId = "run-appr-pattern";
      makeRun(runStore, runId);

      (globalThis as Record<string, unknown>).__runOrchestrator = {
        resolveApproval: async () => ({ ok: true }),
      };

      const res = await resolveApproval(
        jsonRequest(`http://test/api/runs/${runId}/approvals/appr-2`, {
          decision: "approve_pattern",
          pattern: "npm test -- --watch=false",
        }),
        { params: Promise.resolve({ runId, approvalId: "appr-2" }) }
      );
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.resolved, true);

      const patterns = runStore.getApprovedPatterns(runId);
      assert.equal(patterns.length, 1);
      assert.equal(patterns[0].pattern, "npm test -- --watch=false");
    });

    it("does not persist an approved pattern when the approval does not resolve", async () => {
      const { runStore } = makeStores();
      const runId = "run-appr-pattern-unresolved";
      makeRun(runStore, runId);

      (globalThis as Record<string, unknown>).__runOrchestrator = {
        resolveApproval: async () => null,
      };

      const res = await resolveApproval(
        jsonRequest(`http://test/api/runs/${runId}/approvals/appr-unresolved`, {
          decision: "approve_pattern",
          pattern: "rm -rf /",
        }),
        { params: Promise.resolve({ runId, approvalId: "appr-unresolved" }) }
      );
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.resolved, false);
      assert.equal(runStore.getApprovedPatterns(runId).length, 0);
    });

    it("rejects an unsafe approvalId with 400", async () => {
      const { runStore } = makeStores();
      const runId = "run-appr-bad";
      makeRun(runStore, runId);

      const res = await resolveApproval(
        jsonRequest(`http://test/api/runs/${runId}/approvals/x`, {
          decision: "deny",
        }),
        { params: Promise.resolve({ runId, approvalId: "../escape" }) }
      );
      assert.equal(res.status, 400);
    });

    it("enforces caller ownership and returns 404 for a missing run", async () => {
      const { runStore } = makeStores();
      const runId = "run-appr-auth";
      makeRun(runStore, runId, { inviteCodeHash: OWNER_INVITE_HASH });

      const noCode = await resolveApproval(
        jsonRequest(`http://test/api/runs/${runId}/approvals/appr-3`, {
          decision: "deny",
        }),
        { params: Promise.resolve({ runId, approvalId: "appr-3" }) }
      );
      assert.equal(noCode.status, 401);

      const missing = await resolveApproval(
        jsonRequest("http://test/api/runs/run-none/approvals/appr-9", {
          decision: "deny",
        }),
        { params: Promise.resolve({ runId: "run-none", approvalId: "appr-9" }) }
      );
      assert.equal(missing.status, 404);
    });

    it("rejects a cross-run approvalId before calling the orchestrator (403)", async () => {
      const { runStore, eventStore } = makeStores();
      const ownerRun = "run-appr-owner";
      const targetRun = "run-appr-other";
      makeRun(runStore, ownerRun);
      makeRun(runStore, targetRun);

      eventStore.append({
        runId: ownerRun,
        kind: "approval.requested",
        actor: "warden",
        data: { approvalId: "appr-cross", runId: ownerRun },
      });

      let orchestratorCalls = 0;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        resolveApproval: async () => {
          orchestratorCalls += 1;
          return { ok: true };
        },
      };

      const res = await resolveApproval(
        jsonRequest(`http://test/api/runs/${targetRun}/approvals/appr-cross`, {
          decision: "deny",
        }),
        {
          params: Promise.resolve({ runId: targetRun, approvalId: "appr-cross" }),
        }
      );
      assert.ok(
        res.status === 403 || res.status === 404,
        `cross-run approvalId should fail closed, got ${res.status}`
      );
      assert.equal(orchestratorCalls, 0);
      assert.equal(
        eventStore.getEvents(targetRun, { kind: "approval.resolved" }).length,
        0
      );
    });

    it("rejects a cross-run approvalId reported by the approval manager before resolving (403)", async () => {
      const { runStore } = makeStores();
      const ownerRun = "run-appr-mgr-owner";
      const targetRun = "run-appr-mgr-other";
      makeRun(runStore, ownerRun);
      makeRun(runStore, targetRun);

      let orchestratorCalls = 0;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        approvalManager: {
          getApprovalRecord: (id: string) => ({ approvalId: id, runId: ownerRun }),
        },
        resolveApproval: async () => {
          orchestratorCalls += 1;
          return { ok: true };
        },
      };

      const res = await resolveApproval(
        jsonRequest(
          `http://test/api/runs/${targetRun}/approvals/appr-mgr-cross`,
          { decision: "approve_once" }
        ),
        {
          params: Promise.resolve({
            runId: targetRun,
            approvalId: "appr-mgr-cross",
          }),
        }
      );
      assert.equal(res.status, 403);
      assert.equal(orchestratorCalls, 0);
    });
  });


  // -------------------------------------------------------------------------
  // POST /api/runs/[runId]/asks/[askId]
  // -------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/asks/[askId]", () => {
    it("forwards the answer and records ask.answered", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-ask-ok";
      makeRun(runStore, runId);

      eventStore.append({
        runId,
        kind: "ask.raised",
        actor: "necromancer",
        data: { askId: "ask-1", kind: "push_confirm" },
      });

      let answered: { id: string; answer: unknown } | null = null;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        answerAsk: async (_runId: string, askId: string, answer: unknown) => {
          answered = { id: askId, answer };
          return true;
        },
      };

      const res = await answerAsk(
        jsonRequest(`http://test/api/runs/${runId}/asks/ask-1`, { answer: "yes" }),
        { params: Promise.resolve({ runId, askId: "ask-1" }) }
      );
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.ok, true);
      assert.equal(data.askId, "ask-1");
      assert.equal(data.answer, "yes");
      assert.equal(data.handled, true);
      assert.deepEqual(answered, { id: "ask-1", answer: "yes" });

      const events = eventStore.getEvents(runId, { kind: "ask.answered" });
      assert.equal(events.length, 1);
      assert.equal(events[0].data.answer, "yes");
    });

    it("fails closed (403/404) for an askId raised by a different run", async () => {
      const { runStore, eventStore } = makeStores();
      const runA = "run-ask-owner-a";
      const runB = "run-ask-owner-b";
      makeRun(runStore, runA);
      makeRun(runStore, runB);

      eventStore.append({
        runId: runA,
        kind: "ask.raised",
        actor: "necromancer",
        data: { askId: "ask-cross", kind: "push_confirm" },
      });

      let answered = false;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        answerAsk: async () => {
          answered = true;
          return true;
        },
      };

      const res = await answerAsk(
        jsonRequest(`http://test/api/runs/${runB}/asks/ask-cross`, { answer: "yes" }),
        { params: Promise.resolve({ runId: runB, askId: "ask-cross" }) }
      );
      assert.ok(
        res.status === 403 || res.status === 404,
        `cross-run askId should fail closed, got ${res.status}`
      );
      assert.equal(answered, false);
      assert.equal(
        eventStore.getEvents(runB, { kind: "ask.answered" }).length,
        0
      );
    });

    it("only dispatches to the orchestrator when the AskManager has not handled the ask", async () => {
      const { runStore } = makeStores();
      const runId = "run-ask-single-dispatch";
      makeRun(runStore, runId);

      let askManagerAnswers = 0;
      let orchestratorAnswers = 0;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        askManager: {
          getAsk: (askId: string) => ({ askId, runId }),
          answerAsk: async () => {
            askManagerAnswers += 1;
            return true;
          },
        },
        answerAsk: async () => {
          orchestratorAnswers += 1;
          return true;
        },
      };

      const res = await answerAsk(
        jsonRequest(`http://test/api/runs/${runId}/asks/ask-dup`, { answer: "yes" }),
        { params: Promise.resolve({ runId, askId: "ask-dup" }) }
      );
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.handled, true);
      assert.equal(askManagerAnswers, 1);
      assert.equal(orchestratorAnswers, 0);
    });

    it("rejects a missing answer with 400", async () => {
      const { runStore } = makeStores();
      const runId = "run-ask-missing-answer";
      makeRun(runStore, runId);

      const res = await answerAsk(
        jsonRequest(`http://test/api/runs/${runId}/asks/ask-2`, {}),
        { params: Promise.resolve({ runId, askId: "ask-2" }) }
      );
      assert.equal(res.status, 400);
    });

    it("rejects an unsafe askId with 400", async () => {
      const { runStore } = makeStores();
      const runId = "run-ask-bad-id";
      makeRun(runStore, runId);

      const res = await answerAsk(
        jsonRequest(`http://test/api/runs/${runId}/asks/x`, { answer: "y" }),
        { params: Promise.resolve({ runId, askId: "a/b" }) }
      );
      assert.equal(res.status, 400);
    });

    it("enforces ownership and returns 404 for a missing run", async () => {
      const { runStore } = makeStores();
      const runId = "run-ask-auth";
      makeRun(runStore, runId, { inviteCodeHash: OWNER_INVITE_HASH });

      const noCode = await answerAsk(
        jsonRequest(`http://test/api/runs/${runId}/asks/ask-3`, { answer: "y" }),
        { params: Promise.resolve({ runId, askId: "ask-3" }) }
      );
      assert.equal(noCode.status, 401);

      const missing = await answerAsk(
        jsonRequest("http://test/api/runs/run-none/asks/ask-9", { answer: "y" }),
        { params: Promise.resolve({ runId: "run-none", askId: "ask-9" }) }
      );
      assert.equal(missing.status, 404);
    });

    it("fails closed and records nothing when an active orchestrator does not handle the answer", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-ask-unhandled";
      makeRun(runStore, runId);

      eventStore.append({
        runId,
        kind: "ask.raised",
        actor: "necromancer",
        data: { askId: "ask-unhandled", kind: "approve_command" },
      });

      let orchestratorAnswers = 0;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        answerAsk: async () => {
          orchestratorAnswers += 1;
          return false;
        },
      };

      const res = await answerAsk(
        jsonRequest(`http://test/api/runs/${runId}/asks/ask-unhandled`, {
          answer: "Approve once",
        }),
        { params: Promise.resolve({ runId, askId: "ask-unhandled" }) }
      );
      assert.ok(res.status >= 400, `expected a non-2xx status, got ${res.status}`);
      assert.equal(orchestratorAnswers, 1);
      assert.equal(
        eventStore.getEvents(runId, { kind: "ask.answered" }).length,
        0
      );
    });

    it("does not consume a pending push_confirm ask when no handler processes the answer", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-ask-push-unconsumed";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: "https://github.com/owner-user/source-repo-fork",
      });

      const askId = await raisePushConfirmAsk(runId);

      // No orchestrator or askManager is attached: a store-only answer must not
      // consume a confirmation that only the push route may act on.
      const res = await answerAsk(
        jsonRequest(`http://test/api/runs/${runId}/asks/${askId}`, {
          answer: "Push",
        }),
        { params: Promise.resolve({ runId, askId }) }
      );
      assert.ok(res.status >= 400, `expected a non-2xx status, got ${res.status}`);
      assert.equal(
        eventStore.getEvents(runId, { kind: "ask.answered" }).length,
        0
      );

      // The confirmation is still pending, so a confirmed push still works.
      let pushed = false;
      const push = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
      });
      (push as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return { commitSha: "abc123", branch: `graveyard/${runId}` };
        },
      };
      const pushRes = await pushFork(push, runParams(runId));
      assert.equal(pushRes.status, 200);
      assert.equal(pushed, true);
    });
  });


  // -------------------------------------------------------------------------
  // POST /api/runs/[runId]/skeletons/[skeletonId]/actions
  // -------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/skeletons/[skeletonId]/actions", () => {
    it("accepts hyphenated and underscore actions and emits the matching event", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-skel-actions";
      makeRun(runStore, runId);

      const cases: Array<{ action: string; body: Record<string, unknown>; kind: string }> = [
        { action: "interrupt", body: {}, kind: "skeleton.interrupted" },
        { action: "re-raise", body: {}, kind: "skeleton.reraised" },
        { action: "lay_to_rest", body: { choice: "keep_commits" }, kind: "skeleton.laid_to_rest" },
        {
          action: "send-instruction",
          body: { instruction: "do the thing" },
          kind: "skeleton.instruction",
        },
        {
          action: "add_review_focus",
          body: { focus: "auth edge cases" },
          kind: "warden.focus_added",
        },
      ];

      for (const c of cases) {
        const res = await skeletonAction(
          jsonRequest(`http://test/api/runs/${runId}/skeletons/skel-1/actions`, {
            action: c.action,
            ...c.body,
          }),
          { params: Promise.resolve({ runId, skeletonId: "skel-1" }) }
        );
        assert.equal(res.status, 200, `action ${c.action} should succeed`);
        const data = await readJson(res);
        assert.equal(data.eventKind, c.kind);
      }

      const kinds = eventStore
        .getEvents(runId)
        .filter((e) => e.skeletonId === "skel-1")
        .map((e) => e.kind);
      assert.ok(kinds.includes("skeleton.interrupted"));
      assert.ok(kinds.includes("skeleton.reraised"));
      assert.ok(kinds.includes("skeleton.laid_to_rest"));
      assert.ok(kinds.includes("skeleton.instruction"));
      assert.ok(kinds.includes("warden.focus_added"));
    });

    it("requires instruction for send-instruction and focus for add-review-focus", async () => {
      const { runStore } = makeStores();
      const runId = "run-skel-required";
      makeRun(runStore, runId);

      const missingInstruction = await skeletonAction(
        jsonRequest(`http://test/api/runs/${runId}/skeletons/skel-2/actions`, {
          action: "send_instruction",
        }),
        { params: Promise.resolve({ runId, skeletonId: "skel-2" }) }
      );
      assert.equal(missingInstruction.status, 400);

      const missingFocus = await skeletonAction(
        jsonRequest(`http://test/api/runs/${runId}/skeletons/skel-2/actions`, {
          action: "add_review_focus",
        }),
        { params: Promise.resolve({ runId, skeletonId: "skel-2" }) }
      );
      assert.equal(missingFocus.status, 400);
    });

    it("rejects an unknown action with 400 and a missing run with 404", async () => {
      const { runStore } = makeStores();
      const runId = "run-skel-unknown";
      makeRun(runStore, runId);

      const unknown = await skeletonAction(
        jsonRequest(`http://test/api/runs/${runId}/skeletons/skel-3/actions`, {
          action: "explode",
        }),
        { params: Promise.resolve({ runId, skeletonId: "skel-3" }) }
      );
      assert.equal(unknown.status, 400);

      const missing = await skeletonAction(
        jsonRequest("http://test/api/runs/run-none/skeletons/skel-9/actions", {
          action: "interrupt",
        }),
        { params: Promise.resolve({ runId: "run-none", skeletonId: "skel-9" }) }
      );
      assert.equal(missing.status, 404);
    });

    it("forwards to the active dispatcher", async () => {
      const { runStore } = makeStores();
      const runId = "run-skel-forward";
      makeRun(runStore, runId);

      const forwarded: string[] = [];
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        getActiveRun: (id: string) =>
          id === runId
            ? {
                dispatcher: {
                  interruptSkeleton: (sid: string) => forwarded.push(`interrupt:${sid}`),
                  layToRest: (sid: string) => forwarded.push(`rest:${sid}`),
                },
              }
            : undefined,
      };

      const interrupted = await skeletonAction(
        jsonRequest(`http://test/api/runs/${runId}/skeletons/skel-4/actions`, {
          action: "interrupt",
        }),
        { params: Promise.resolve({ runId, skeletonId: "skel-4" }) }
      );
      assert.equal(interrupted.status, 200);

      const rested = await skeletonAction(
        jsonRequest(`http://test/api/runs/${runId}/skeletons/skel-4/actions`, {
          action: "lay-to-rest",
          choice: "discard_work",
        }),
        { params: Promise.resolve({ runId, skeletonId: "skel-4" }) }
      );
      assert.equal(rested.status, 200);

      assert.deepEqual(forwarded, ["interrupt:skel-4", "rest:skel-4"]);
    });

    it("returns a non-2xx and no success audit event when the dispatcher rejects", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-skel-dispatch-fails";
      makeRun(runStore, runId);

      (globalThis as Record<string, unknown>).__runOrchestrator = {
        getActiveRun: (id: string) =>
          id === runId
            ? {
                dispatcher: {
                  interruptSkeleton: async () => {
                    throw new Error("dispatcher offline");
                  },
                },
              }
            : undefined,
      };

      const res = await skeletonAction(
        jsonRequest(`http://test/api/runs/${runId}/skeletons/skel-5/actions`, {
          action: "interrupt",
        }),
        { params: Promise.resolve({ runId, skeletonId: "skel-5" }) }
      );
      assert.ok(res.status >= 400, `expected a non-2xx status, got ${res.status}`);
      assert.equal(
        eventStore.getEvents(runId, { kind: "skeleton.interrupted" }).length,
        0
      );
    });

    it("never falls back to a global pause/resume for a per-skeleton interrupt or re-raise", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-skel-no-global-fallback";
      makeRun(runStore, runId);

      const globalCalls: string[] = [];
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        getActiveRun: (id: string) =>
          id === runId
            ? {
                dispatcher: {
                  pause: () => globalCalls.push("pause"),
                  resume: () => globalCalls.push("resume"),
                },
              }
            : undefined,
      };

      const interrupted = await skeletonAction(
        jsonRequest(
          `http://test/api/runs/${runId}/skeletons/skel-scoped/actions`,
          { action: "interrupt" }
        ),
        { params: Promise.resolve({ runId, skeletonId: "skel-scoped" }) }
      );
      const reraised = await skeletonAction(
        jsonRequest(
          `http://test/api/runs/${runId}/skeletons/skel-scoped/actions`,
          { action: "re-raise" }
        ),
        { params: Promise.resolve({ runId, skeletonId: "skel-scoped" }) }
      );

      assert.deepEqual(globalCalls, []);
      assert.ok(interrupted.status >= 400, `got ${interrupted.status}`);
      assert.ok(reraised.status >= 400, `got ${reraised.status}`);
      assert.equal(
        eventStore.getEvents(runId, { kind: "skeleton.interrupted" }).length,
        0
      );
      assert.equal(
        eventStore.getEvents(runId, { kind: "skeleton.reraised" }).length,
        0
      );
    });

    it("rejects a skeletonId raised by another run (403/404)", async () => {
      const { runStore, eventStore } = makeStores();
      const ownerRun = "run-skel-owner";
      const targetRun = "run-skel-other";
      makeRun(runStore, ownerRun);
      makeRun(runStore, targetRun);

      eventStore.append({
        runId: ownerRun,
        kind: "skeleton.raised",
        actor: "necromancer",
        skeletonId: "skel-cross-run",
        data: { skeletonId: "skel-cross-run" },
      });

      let forwarded = false;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        getActiveRun: (id: string) =>
          id === targetRun
            ? {
                dispatcher: {
                  interruptSkeleton: () => {
                    forwarded = true;
                  },
                },
              }
            : undefined,
      };

      const res = await skeletonAction(
        jsonRequest(
          `http://test/api/runs/${targetRun}/skeletons/skel-cross-run/actions`,
          { action: "interrupt" }
        ),
        {
          params: Promise.resolve({
            runId: targetRun,
            skeletonId: "skel-cross-run",
          }),
        }
      );
      assert.ok(
        res.status === 403 || res.status === 404,
        `cross-run skeletonId should fail closed, got ${res.status}`
      );
      assert.equal(forwarded, false);
      assert.equal(
        eventStore.getEvents(targetRun, { kind: "skeleton.interrupted" }).length,
        0
      );
    });
  });


  // -------------------------------------------------------------------------
  // POST /api/runs/[runId]/control
  // -------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/control", () => {
    it("checks the kill admin token in constant time and fails closed", async () => {
      process.env.ADMIN_TOKEN = "super-secret-admin";
      const { runStore } = makeStores();
      const runId = "run-ctrl-kill";
      makeRun(runStore, runId, { phase: "legion" });

      let killed = false;
      (globalThis as Record<string, unknown>).__runOrchestrator = {
        killRun: async () => {
          killed = true;
        },
      };

      const noToken = await controlRun(
        jsonRequest(`http://test/api/runs/${runId}/control`, { action: "kill" }),
        runParams(runId)
      );
      assert.equal(noToken.status, 403);

      const wrongToken = await controlRun(
        jsonRequest(
          `http://test/api/runs/${runId}/control`,
          { action: "kill" },
          { "x-admin-token": "wrong" }
        ),
        runParams(runId)
      );
      assert.equal(wrongToken.status, 403);
      assert.equal(killed, false);

      const goodToken = await controlRun(
        jsonRequest(
          `http://test/api/runs/${runId}/control`,
          { action: "kill" },
          { "x-admin-token": "super-secret-admin" }
        ),
        runParams(runId)
      );
      assert.equal(goodToken.status, 200);
      assert.equal(killed, true);
      assert.equal(runStore.getRun(runId)?.outcome, "killed");
    });

    it("does not let an invite code alone perform an admin kill", async () => {
      process.env.ADMIN_TOKEN = "super-secret-admin";
      const { runStore } = makeStores();
      const runId = "run-ctrl-invite-kill";
      makeRun(runStore, runId, {
        phase: "legion",
        inviteCodeHash: OWNER_INVITE_HASH,
      });

      const res = await controlRun(
        jsonRequest(
          `http://test/api/runs/${runId}/control`,
          { action: "kill", inviteCode: OWNER_INVITE },
          { "x-invite-code": OWNER_INVITE }
        ),
        runParams(runId)
      );
      assert.equal(res.status, 403);
    });

    it("still pauses a run when the owner presents the invite code", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-ctrl-pause";
      makeRun(runStore, runId, {
        phase: "legion",
        inviteCodeHash: OWNER_INVITE_HASH,
      });

      const res = await controlRun(
        jsonRequest(
          `http://test/api/runs/${runId}/control`,
          { action: "pause", reason: "hold on" },
          { "x-invite-code": OWNER_INVITE }
        ),
        runParams(runId)
      );
      assert.equal(res.status, 200);

      const clock = eventStore.getEvents(runId, { kind: "run.clock" });
      assert.equal(clock.length, 1);
      assert.equal(clock[0].data.action, "pause");
      assert.equal(clock[0].data.reason, "hold on");
    });
  });


  // -------------------------------------------------------------------------
  // POST /api/runs/[runId]/push-fork
  // -------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/push-fork", () => {
    const SOURCE = "https://github.com/source-owner/source-repo";
    const FORK = "https://github.com/owner-user/source-repo-fork";

    it("returns 404 for a missing run", async () => {
      makeStores();
      const res = await pushFork(
        jsonRequest("http://test/api/runs/run-none/push-fork", { confirmed: false }),
        runParams("run-none")
      );
      assert.equal(res.status, 404);
    });

    it("refuses a run that is not done (409) or has pushing disabled (403)", async () => {
      const { runStore } = makeStores();
      const notDone = "run-push-notdone";
      makeRun(runStore, notDone, { phase: "legion", pushFlag: true });
      const notDoneRes = await pushFork(
        jsonRequest(`http://test/api/runs/${notDone}/push-fork`, {}),
        runParams(notDone)
      );
      assert.equal(notDoneRes.status, 409);

      const noFlag = "run-push-noflag";
      makeRun(runStore, noFlag, { phase: "done", pushFlag: false });
      const noFlagRes = await pushFork(
        jsonRequest(`http://test/api/runs/${noFlag}/push-fork`, {}),
        runParams(noFlag)
      );
      assert.equal(noFlagRes.status, 403);
    });

    it("raises a push_confirm ask and never pushes when unconfirmed", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-push-confirm";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: false,
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return {};
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 202);
      const data = await readJson(res);
      assert.equal(data.status, "confirmation_required");
      assert.equal(data.targetFork, FORK);
      assert.equal(data.branch, `graveyard/${runId}`);
      assert.equal(data.sourceUntouched, true);
      assert.equal(typeof data.askId, "string");
      assert.equal(pushed, false);

      const asks = eventStore.getEvents(runId, { kind: "ask.raised" });
      assert.equal(asks.length, 1);
      assert.equal(asks[0].data.kind, "push_confirm");
      assert.deepEqual(asks[0].data.options, ["Push", "Do not push"]);
      assert.equal(asks[0].data.default, "Do not push");
    });

    it("refuses an unconfirmed push with no target fork (400)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-notarget";
      makeRun(runStore, runId, { phase: "done", pushFlag: true });

      const res = await pushFork(
        jsonRequest(`http://test/api/runs/${runId}/push-fork`, { confirmed: false }),
        runParams(runId)
      );
      assert.equal(res.status, 400);
    });


    it("pushes to the fork when confirmed and never targets the source repo", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-push-ok";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
        inviteCodeHash: OWNER_INVITE_HASH,
      });

      const askId = await raisePushConfirmAsk(
        runId,
        {},
        { "x-invite-code": OWNER_INVITE }
      );

      const calls: Array<Record<string, unknown>> = [];
      const req = jsonRequest(
        `http://test/api/runs/${runId}/push-fork`,
        { confirmed: true, askId },
        { "x-invite-code": OWNER_INVITE }
      );
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async (_id: string, options: Record<string, unknown>) => {
          calls.push(options);
          return { ok: true, commitSha: "deadbeef", branch: `graveyard/${runId}` };
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 200);
      const data = await readJson(res);
      assert.equal(data.ok, true);
      assert.equal(data.commitSha, "deadbeef");
      assert.equal(data.sourceUntouched, true);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].targetRepoUrl, FORK);
      assert.equal(calls[0].sourceRepoUrl, SOURCE);
      assert.notEqual(calls[0].targetRepoUrl, calls[0].sourceRepoUrl);
      assert.equal(calls[0].pushConfirm, true);
      assert.equal(calls[0].invitePushFlag, true);
      assert.equal(calls[0].runPhase, "done");

      const answered = eventStore.getEvents(runId, { kind: "ask.answered" });
      assert.equal(answered.length, 1);
      assert.equal(answered[0].data.askId, askId);
      assert.equal(answered[0].data.kind, "push_confirm");
      assert.equal(answered[0].data.answer, "Push");
    });

    it("refuses to push to the source repository (403)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-source";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: SOURCE,
      });

      const askId = await raisePushConfirmAsk(runId);

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
        targetFork: SOURCE,
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return {};
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 403);
      assert.equal(pushed, false);
    });

    it("surfaces a sanitized 403 when the git service refuses the push", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-refused";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      const askId = await raisePushConfirmAsk(runId);

      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          const err = new Error("push refused") as Error & { code: string };
          err.code = "SOURCE_WRITE_FORBIDDEN";
          throw err;
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 403);
      const data = await readJson(res);
      assert.equal(data.ok, false);
      const serialized = JSON.stringify(data);
      assert.ok(!serialized.includes("push refused"), "must not leak the raw error message");
      assert.ok(!serialized.includes("SOURCE_WRITE_FORBIDDEN"), "must not leak the raw error code");
    });

    it("rejects a confirmed push when no push_confirm ask is pending (409)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-no-ask";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return {};
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 409);
      assert.equal(pushed, false);
    });

    it("rejects a target-swap confirmation that differs from the raised ask (409)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-swap";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      const askId = await raisePushConfirmAsk(runId);

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
        targetFork: "https://github.com/attacker-user/other-repo",
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return {};
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 409);
      assert.equal(pushed, false);
    });

    it("rejects replaying a consumed push_confirm ask (409)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-replay";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      const askId = await raisePushConfirmAsk(runId);

      const first = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
      });
      (first as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => ({
          ok: true,
          commitSha: "abc123",
          branch: `graveyard/${runId}`,
        }),
      };
      const firstRes = await pushFork(first, runParams(runId));
      assert.equal(firstRes.status, 200);

      let secondPushed = false;
      const second = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
      });
      (second as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          secondPushed = true;
          return {};
        },
      };
      const secondRes = await pushFork(second, runParams(runId));
      assert.equal(secondRes.status, 409);
      assert.equal(secondPushed, false);
    });

    it("blocks an SSH-form source repository variant (403)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-ssh-source";
      makeRun(runStore, runId, {
        url: "git@github.com:source-owner/source-repo.git",
        phase: "done",
        pushFlag: true,
        pushTargetFork: SOURCE,
      });

      const askId = await raisePushConfirmAsk(runId);

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return {};
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 403);
      assert.equal(pushed, false);
    });

    it("rejects a non-https://github.com target fork before calling GitService", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-bad-target";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
      });

      const askId = await raisePushConfirmAsk(runId, {
        targetFork: "git@github.com:owner-user/source-repo-fork.git",
      });

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return {};
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.ok(
        res.status === 400 || res.status === 403,
        `expected 400/403, got ${res.status}`
      );
      assert.equal(pushed, false);
    });

    it("ignores a caller-supplied sourceRepoUrl that would retarget the push onto the source repo (403)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-source-override";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: SOURCE,
      });

      const askId = await raisePushConfirmAsk(runId);

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
        sourceRepoUrl: "https://github.com/attacker-user/other-repo",
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return {};
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.ok(
        res.status === 400 || res.status === 403,
        `expected 400/403 for a source override, got ${res.status}`
      );
      assert.equal(pushed, false);
    });

    it("accepts a matching sourceRepoUrl but still pushes using run.url", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-source-same";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      const askId = await raisePushConfirmAsk(runId);

      const calls: Array<Record<string, unknown>> = [];
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
        sourceRepoUrl: "git@github.com:source-owner/source-repo.git",
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async (_id: string, options: Record<string, unknown>) => {
          calls.push(options);
          return { commitSha: "cafe", branch: `graveyard/${runId}` };
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].sourceRepoUrl, SOURCE);
      assert.notEqual(calls[0].targetRepoUrl, SOURCE);
    });

    it("does not treat an unhandled ask.answered as consuming the push_confirm", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-push-handled-false";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      const askId = await raisePushConfirmAsk(runId);

      // A recorded, unhandled answer for the same ask must not consume the
      // confirmation.
      eventStore.append({
        runId,
        kind: "ask.answered",
        actor: "user",
        data: { askId, answer: "not yet", handled: false },
      });

      let pushed = false;
      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
        askId,
      });
      (req as unknown as Record<string, unknown>).gitService = {
        pushToFork: async () => {
          pushed = true;
          return { commitSha: "beef", branch: `graveyard/${runId}` };
        },
      };

      const res = await pushFork(req, runParams(runId));
      assert.equal(res.status, 200);
      assert.equal(pushed, true);
    });
  });


  // -------------------------------------------------------------------------
  // lib/ui/api.ts wrappers
  // -------------------------------------------------------------------------
  describe("lib/ui/api.ts wrappers", () => {
    let originalFetch: typeof globalThis.fetch;
    let calls: Array<{ url: string; init: RequestInit }>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      calls = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true, runId: "run-x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function headersOf(call: { init: RequestInit }): Record<string, string> {
      return (call.init.headers ?? {}) as Record<string, string>;
    }

    it("postMessage targets the messages route with the invite header", async () => {
      const res = await apiPostMessage(
        "run-x",
        { to: "exhumer", intent: "instruct", text: "hi" },
        "failed",
        "code-123"
      );
      assert.equal(res.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/runs/run-x/messages");
      assert.equal(calls[0].init.method, "POST");
      assert.equal(headersOf(calls[0])["x-invite-code"], "code-123");
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        to: "exhumer",
        intent: "instruct",
        text: "hi",
      });
    });

    it("postApprovalById targets the per-approval route", async () => {
      await postApprovalById("run-x", "appr-1", "approve_pattern", {
        pattern: "npm test",
        inviteCode: "code-123",
      });
      assert.equal(calls[0].url, "/api/runs/run-x/approvals/appr-1");
      assert.equal(headersOf(calls[0])["x-invite-code"], "code-123");
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        decision: "approve_pattern",
        pattern: "npm test",
      });
    });

    it("postAskAnswerById targets the per-ask route", async () => {
      await postAskAnswerById("run-x", "ask-1", "yes", "code-123");
      assert.equal(calls[0].url, "/api/runs/run-x/asks/ask-1");
      assert.equal(headersOf(calls[0])["x-invite-code"], "code-123");
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { answer: "yes" });
    });

    it("postSkeletonActionV2 targets the actions route", async () => {
      await postSkeletonActionV2(
        "run-x",
        "skel-1",
        { action: "send-instruction", instruction: "go" },
        "failed",
        "code-123"
      );
      assert.equal(calls[0].url, "/api/runs/run-x/skeletons/skel-1/actions");
      assert.equal(headersOf(calls[0])["x-invite-code"], "code-123");
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        action: "send-instruction",
        instruction: "go",
      });
    });

    it("postPushFork targets the push-fork route", async () => {
      await postPushFork("run-x", { confirmed: false }, "code-123");
      assert.equal(calls[0].url, "/api/runs/run-x/push-fork");
      assert.equal(headersOf(calls[0])["x-invite-code"], "code-123");
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { confirmed: false });
    });

    it("postControl still targets the existing control route", async () => {
      await postControl("run-x", "pause", "failed", "code-123");
      assert.equal(calls[0].url, "/api/runs/run-x/control");
      assert.equal(headersOf(calls[0])["x-invite-code"], "code-123");
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { action: "pause" });
    });
  });
});

