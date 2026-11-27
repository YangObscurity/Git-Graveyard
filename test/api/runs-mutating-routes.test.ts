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

    it("persists an approved pattern for approve_pattern", async () => {
      const { runStore } = makeStores();
      const runId = "run-appr-pattern";
      makeRun(runStore, runId);

      const res = await resolveApproval(
        jsonRequest(`http://test/api/runs/${runId}/approvals/appr-2`, {
          decision: "approve_pattern",
          pattern: "npm test -- --watch=false",
        }),
        { params: Promise.resolve({ runId, approvalId: "appr-2" }) }
      );
      assert.equal(res.status, 200);

      const patterns = runStore.getApprovedPatterns(runId);
      assert.equal(patterns.length, 1);
      assert.equal(patterns[0].pattern, "npm test -- --watch=false");
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
  });


  // -------------------------------------------------------------------------
  // POST /api/runs/[runId]/asks/[askId]
  // -------------------------------------------------------------------------
  describe("POST /api/runs/[runId]/asks/[askId]", () => {
    it("forwards the answer and records ask.answered", async () => {
      const { runStore, eventStore } = makeStores();
      const runId = "run-ask-ok";
      makeRun(runStore, runId);

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
      const { runStore } = makeStores();
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

      const calls: Array<Record<string, unknown>> = [];
      const req = jsonRequest(
        `http://test/api/runs/${runId}/push-fork`,
        { confirmed: true },
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
      assert.equal(answered[0].data.kind, "push_confirm");
      assert.equal(answered[0].data.answer, "Push");
    });

    it("refuses to push to the source repository (403)", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-source";
      makeRun(runStore, runId, { phase: "done", pushFlag: true });

      const res = await pushFork(
        jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
          confirmed: true,
          targetFork: SOURCE,
        }),
        runParams(runId)
      );
      assert.equal(res.status, 403);
    });

    it("surfaces a sanitized 403 when the git service refuses the push", async () => {
      const { runStore } = makeStores();
      const runId = "run-push-refused";
      makeRun(runStore, runId, {
        phase: "done",
        pushFlag: true,
        pushTargetFork: FORK,
      });

      const req = jsonRequest(`http://test/api/runs/${runId}/push-fork`, {
        confirmed: true,
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
    });
  });
});

