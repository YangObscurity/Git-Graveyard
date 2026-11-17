// Task 10.7 Tests: MCP collaboration tools
// Requirements: 19.2, 19.11, 19.12, 19.13, 19.15, 19.16, 19.17, 19.18

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  McpGateway,
  handleReportTaskResult,
  handleWardenVerdict,
  handleAsk,
  handleReportBlocker,
  handleProposeTask,
  handleAckMessage,
  deliverAskAnswer,
  handleClaimPatch,
  handleProgressReport,
  CollaborationStore,
  defaultCollaborationStore,
  isRoleAuthorizedForTool,
  ALLOWED_MCP_TOOLS_BY_ROLE,
  type ToolExecutionContext,
} from "../../lib/gateway";
import { LogStore } from "../../lib/events/log-store";
import { redactText } from "../../lib/security/redactor";

test("report_task_result: records typed task results and emits task.state event (Requirement 19.17)", async () => {
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];
  const store = new CollaborationStore();

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
    runId: "run-task-1",
  };

  const res = await handleReportTaskResult(
    {
      taskId: "task-build-1",
      status: "completed",
      summary: "Modernized package.json and built successfully",
      refs: ["file:package.json", "cmd:npm run build"],
    },
    context,
    {
      onEmitEvent: async (evt) => {
        emittedEvents.push(evt as any);
      },
      collaborationStore: store,
    }
  );

  assert.notEqual((res as any).status, "refused");
  assert.equal((res as any).success, true);
  assert.equal((res as any).taskId, "task-build-1");
  assert.equal((res as any).status, "completed");
  assert.equal((res as any).summary, "Modernized package.json and built successfully");
  assert.deepEqual((res as any).refs, ["file:package.json", "cmd:npm run build"]);

  // Stored in CollaborationStore
  const stored = store.getTaskResult("task-build-1", "run-task-1");
  assert.ok(stored);
  assert.equal(stored.taskId, "task-build-1");
  assert.equal(stored.status, "completed");
  assert.equal(stored.skeletonId, "skel-soul");
  assert.equal(stored.role, "Soul-stitcher");

  // Emitted event check
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "task.state");
  assert.equal(emittedEvents[0].actor, "soul-stitcher");
  assert.equal(emittedEvents[0].runId, "run-task-1");
  assert.equal(emittedEvents[0].data.taskId, "task-build-1");
});

test("report_task_result: refuses calls with missing or invalid fields", async () => {
  const store = new CollaborationStore();
  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
  };

  // Missing taskId
  const missingTask = await handleReportTaskResult(
    { taskId: "", status: "completed", summary: "done" },
    context,
    { collaborationStore: store }
  );
  assert.equal(missingTask.status, "refused");
  assert.equal((missingTask as any).code, "INVALID_TASK_ID");

  // Missing status
  const missingStatus = await handleReportTaskResult(
    { taskId: "T1", status: "", summary: "done" },
    context,
    { collaborationStore: store }
  );
  assert.equal(missingStatus.status, "refused");
  assert.equal((missingStatus as any).code, "INVALID_STATUS");

  // Missing summary
  const missingSummary = await handleReportTaskResult(
    { taskId: "T1", status: "completed", summary: "" },
    context,
    { collaborationStore: store }
  );
  assert.equal(missingSummary.status, "refused");
  assert.equal((missingSummary as any).code, "INVALID_SUMMARY");
});

test("warden_verdict: validates presence of target, verdict, reasons with refs, and candidateSha256 (Requirement 19.12)", async () => {
  const store = new CollaborationStore();
  const context: ToolExecutionContext = {
    skeletonId: "skel-warden",
    role: "Warden",
    bearerToken: "token-warden",
    runId: "run-verdict-1",
  };

  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];
  const options = {
    collaborationStore: store,
    onEmitEvent: async (evt: any) => {
      emittedEvents.push(evt);
    },
  };

  // 1. Missing target
  const noTarget: any = await handleWardenVerdict(
    {
      target: "",
      verdict: "approve",
      reasons: [{ text: "Passed", refs: ["test:1"] }],
      candidateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    context,
    options
  );
  assert.equal(noTarget.status, "refused");
  assert.equal(noTarget.code, "INVALID_TARGET");

  // 2. Invalid verdict (neither approve nor reject)
  const badVerdict: any = await handleWardenVerdict(
    {
      target: "task-1",
      verdict: "pass" as any,
      reasons: [{ text: "Passed", refs: ["test:1"] }],
      candidateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    context,
    options
  );
  assert.equal(badVerdict.status, "refused");
  assert.equal(badVerdict.code, "INVALID_VERDICT");

  // 3. Missing reasons array or empty reasons
  const emptyReasons: any = await handleWardenVerdict(
    {
      target: "task-1",
      verdict: "approve",
      reasons: [],
      candidateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    context,
    options
  );
  assert.equal(emptyReasons.status, "refused");
  assert.equal(emptyReasons.code, "MISSING_REASONS");

  // 4. Reason item without text
  const reasonNoText: any = await handleWardenVerdict(
    {
      target: "task-1",
      verdict: "approve",
      reasons: [{ text: "", refs: ["test:1"] }],
      candidateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    context,
    options
  );
  assert.equal(reasonNoText.status, "refused");
  assert.equal(reasonNoText.code, "INVALID_REASONS_FORMAT");

  // 5. Reason item without refs or empty refs
  const reasonNoRefs: any = await handleWardenVerdict(
    {
      target: "task-1",
      verdict: "approve",
      reasons: [{ text: "Checks passed", refs: [] }],
      candidateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    context,
    options
  );
  assert.equal(reasonNoRefs.status, "refused");
  assert.equal(reasonNoRefs.code, "INVALID_REASONS_FORMAT");

  // 6. Missing candidateSha256
  const noSha: any = await handleWardenVerdict(
    {
      target: "task-1",
      verdict: "approve",
      reasons: [{ text: "Checks passed", refs: ["test:1"] }],
      candidateSha256: "",
    },
    context,
    options
  );
  assert.equal(noSha.status, "refused");
  assert.equal(noSha.code, "MISSING_CANDIDATE_SHA256");

  // 7. Valid approve verdict
  const validApprove = await handleWardenVerdict(
    {
      target: "task-1",
      verdict: "approve",
      reasons: [
        { text: "Syntax gate passed", refs: ["file:src/app.py", "cmd:python -m py_compile"] },
        { text: "Tests passed in Auditbox", refs: ["cmd:pytest -v"] },
      ],
      candidateSha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    },
    context,
    options
  );
  assert.equal((validApprove as any).success, true);
  assert.equal((validApprove as any).verdict, "approve");
  assert.equal((validApprove as any).target, "task-1");

  // Check stored verdict
  const storedVerdict = store.getVerdict("task-1", "run-verdict-1");
  assert.ok(storedVerdict);
  assert.equal(storedVerdict.verdict, "approve");
  assert.equal(storedVerdict.candidateSha256, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
  assert.equal(storedVerdict.reasons.length, 2);

  // Check emitted event
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "verdict");
  assert.equal(emittedEvents[0].actor, "warden");
  assert.equal(emittedEvents[0].data.verdict, "approve");

  // 8. Valid reject verdict
  const validReject = await handleWardenVerdict(
    {
      target: "task-2",
      verdict: "reject",
      reasons: [{ text: "Tests failed on line 42", refs: ["test:run-fail-42"] }],
      candidateSha256: "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
    },
    context,
    options
  );
  assert.equal((validReject as any).success, true);
  assert.equal((validReject as any).verdict, "reject");
});

test("ask: returns immediately with 'recorded; end your turn' and queues question (Requirements 19.11, 19.18)", async () => {
  const store = new CollaborationStore();
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];

  const context: ToolExecutionContext = {
    skeletonId: "skel-planner",
    role: "Planner",
    bearerToken: "token-planner",
    runId: "run-ask-1",
  };

  const res = await handleAsk(
    { question: "Should we migrate Python 2 print statements to functions?" },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt: any) => {
        emittedEvents.push(evt);
      },
    }
  );

  // Exact phrase required by Requirement 19.11
  assert.equal(res.message, "recorded; end your turn");
  assert.equal(res.recorded, true);
  assert.equal(res.question, "Should we migrate Python 2 print statements to functions?");
  assert.ok(res.askId);

  // Event emission check
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "ask.raised");
  assert.equal(emittedEvents[0].actor, "planner");
  assert.equal(emittedEvents[0].runId, "run-ask-1");
  assert.equal(emittedEvents[0].data.question, "Should we migrate Python 2 print statements to functions?");

  // Queued in store
  const queued = store.getQueuedAsks("run-ask-1");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].askId, res.askId);
  assert.equal(queued[0].status, "queued");
  assert.equal(queued[0].role, "Planner");
});

test("ask answer delivery: delivers answer via steer or prompt (Requirement 19.18)", async () => {
  const store = new CollaborationStore();
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
    runId: "run-steer-test",
  };

  const askRes = await handleAsk(
    { question: "Which packaging tool to prefer?" },
    context,
    { collaborationStore: store }
  );
  assert.ok(askRes.askId);

  // 1. Deliver answer via steer
  let steerCalledWith = "";
  const steerRes = await deliverAskAnswer(
    askRes.askId,
    "Use pyproject.toml with flit",
    {
      deliveryMethod: "steer",
      steerHandler: async (text) => {
        steerCalledWith = text;
      },
      onEmitEvent: async (evt: any) => {
        emittedEvents.push(evt);
      },
    },
    { collaborationStore: store }
  );

  assert.equal(steerRes.success, true);
  assert.equal(steerRes.deliveryMethod, "steer");
  assert.equal(steerCalledWith, "Use pyproject.toml with flit");

  // Check store updated
  const askEntry = store.getAsk(askRes.askId);
  assert.ok(askEntry);
  assert.equal(askEntry.status, "answered");
  assert.equal(askEntry.answer, "Use pyproject.toml with flit");
  assert.equal(askEntry.deliveryMethod, "steer");

  // Check ask.answered event
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "ask.answered");
  assert.equal(emittedEvents[0].actor, "necromancer");
  assert.equal(emittedEvents[0].data.answer, "Use pyproject.toml with flit");

  // 2. Deliver another answer via prompt
  const askRes2 = await handleAsk(
    { question: "Should tests be run in parallel?" },
    context,
    { collaborationStore: store }
  );
  assert.ok(askRes2.askId);

  const promptRes = await deliverAskAnswer(
    askRes2.askId,
    "Run tests sequentially with -n 1",
    {
      deliveryMethod: "prompt",
      onEmitEvent: async (evt: any) => {
        emittedEvents.push(evt);
      },
    },
    { collaborationStore: store }
  );

  assert.equal(promptRes.success, true);
  assert.equal(promptRes.deliveryMethod, "prompt");
  const askEntry2 = store.getAsk(askRes2.askId);
  assert.equal(askEntry2?.status, "answered");
  assert.equal(askEntry2?.deliveryMethod, "prompt");
});

test("propose_task: records proposals for user confirmation prior to scope changes (Requirement 19.13)", async () => {
  const store = new CollaborationStore();
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
    runId: "run-prop-1",
  };

  const propRes = await handleProposeTask(
    {
      title: "Add compatibility shim for urllib3",
      description: "urllib3 v2 removed urllib3.util.ssl_.DEFAULT_CIPHERS",
    },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt: any) => {
        emittedEvents.push(evt);
      },
    }
  );

  assert.equal(propRes.recorded, true);
  assert.ok(propRes.proposalId);
  assert.equal(propRes.title, "Add compatibility shim for urllib3");
  assert.equal(propRes.status, "pending_confirmation");

  // Stored with pending_confirmation status
  const proposals = store.getProposals("run-prop-1");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].proposalId, propRes.proposalId);
  assert.equal(proposals[0].status, "pending_confirmation");

  // Confirm proposal
  const confirmed = store.confirmProposal(propRes.proposalId);
  assert.equal(confirmed, true);
  assert.equal(store.getProposal(propRes.proposalId)?.status, "confirmed");

  // Event emission check
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "skeleton.tool_result");
  assert.equal(emittedEvents[0].data.tool, "propose_task");
  assert.equal(emittedEvents[0].data.status, "pending_confirmation");
});

test("report_blocker: records blocker text and kind for mitigation (Requirement 19.15)", async () => {
  const store = new CollaborationStore();
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];

  const context: ToolExecutionContext = {
    skeletonId: "skel-bone",
    role: "Bonesetter",
    bearerToken: "token-bone",
    runId: "run-blk-1",
  };

  const res: any = await handleReportBlocker(
    {
      text: "npm registry 404 for removed dependency left-pad",
      kind: "missing_package",
    },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt: any) => {
        emittedEvents.push(evt);
      },
    }
  );

  assert.equal(res.recorded, true);
  assert.equal(res.text, "npm registry 404 for removed dependency left-pad");
  assert.equal(res.kind, "missing_package");
  assert.ok(res.blockerId);

  // Check store
  const blockers = store.getBlockers("run-blk-1");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].status, "reported");

  // Mitigate blocker
  const mitigated = store.mitigateBlocker(res.blockerId, "Substituted inline implementation");
  assert.equal(mitigated, true);
  assert.equal(store.getBlocker(res.blockerId)?.status, "mitigated");

  // Invalid blocker inputs refused
  const invalidText: any = await handleReportBlocker({ text: "", kind: "kind" }, context, { collaborationStore: store });
  assert.equal(invalidText.status, "refused");
  assert.equal(invalidText.code, "INVALID_BLOCKER_TEXT");

  const invalidKind: any = await handleReportBlocker({ text: "text", kind: "" }, context, { collaborationStore: store });
  assert.equal(invalidKind.status, "refused");
  assert.equal(invalidKind.code, "INVALID_BLOCKER_KIND");
});

test("ack_message: marks message as Acknowledged (Requirement 19.16)", async () => {
  const store = new CollaborationStore();
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];

  const context: ToolExecutionContext = {
    skeletonId: "skel-scribe",
    role: "Scribe",
    bearerToken: "token-scribe",
    runId: "run-ack-1",
  };

  assert.equal(store.isMessageAcknowledged("msg-100", "run-ack-1"), false);

  const res: any = await handleAckMessage(
    { msgId: "msg-100" },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt: any) => {
        emittedEvents.push(evt);
      },
    }
  );

  assert.equal(res.acknowledged, true);
  assert.equal(res.msgId, "msg-100");

  // Check store
  assert.equal(store.isMessageAcknowledged("msg-100", "run-ack-1"), true);
  const acks = store.getAcks("run-ack-1");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].msgId, "msg-100");

  // Event emission check
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "message.acked");
  assert.equal(emittedEvents[0].data.msgId, "msg-100");

  // Invalid msgId refused
  const invalid: any = await handleAckMessage({ msgId: "" }, context, { collaborationStore: store });
  assert.equal(invalid.status, "refused");
  assert.equal(invalid.code, "INVALID_MSG_ID");
});

test("McpGateway: role authorization matrix for collaboration tools (Requirements 19.3, 19.4)", async () => {
  const gw = new McpGateway({ defaultTimeoutMs: 60000, approvalWaitMs: 300000, logStore: new LogStore({ inMemory: true }) });

  const planner = gw.registerSkeleton({ skeletonId: "skel-p", role: "Planner", runId: "run-matrix", worktreeRoot: "/workspace/repo" });
  const exhumer = gw.registerSkeleton({ skeletonId: "skel-e", role: "Exhumer", runId: "run-matrix", worktreeRoot: "/workspace/repo" });
  const bonesetter = gw.registerSkeleton({ skeletonId: "skel-b", role: "Bonesetter", runId: "run-matrix", worktreeRoot: "/workspace/repo" });
  const soul = gw.registerSkeleton({ skeletonId: "skel-s", role: "Soul-stitcher", runId: "run-matrix", worktreeRoot: "/workspace/repo" });
  const warden = gw.registerSkeleton({ skeletonId: "skel-w", role: "Warden", runId: "run-matrix", worktreeRoot: "/workspace/repo" });
  const scribe = gw.registerSkeleton({ skeletonId: "skel-c", role: "Scribe", runId: "run-matrix", worktreeRoot: "/workspace/repo" });

  // 1. report_task_result: Planner, Exhumer, Bonesetter, Soul-stitcher, Scribe allowed; Warden forbidden
  assert.equal(isRoleAuthorizedForTool("Planner", "report_task_result"), true);
  assert.equal(isRoleAuthorizedForTool("Exhumer", "report_task_result"), true);
  assert.equal(isRoleAuthorizedForTool("Bonesetter", "report_task_result"), true);
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "report_task_result"), true);
  assert.equal(isRoleAuthorizedForTool("Scribe", "report_task_result"), true);
  assert.equal(isRoleAuthorizedForTool("Warden", "report_task_result"), false);

  const wardenTaskResult = await gw.handleToolCall(warden.bearerToken, "report_task_result", {
    taskId: "T1",
    status: "done",
    summary: "done",
  });
  assert.equal((wardenTaskResult as any).status, "refused");
  assert.equal((wardenTaskResult as any).code, "FORBIDDEN_ROLE");

  // 2. warden_verdict: Warden strictly allowed; others forbidden
  assert.equal(isRoleAuthorizedForTool("Warden", "warden_verdict"), true);
  assert.equal(isRoleAuthorizedForTool("Planner", "warden_verdict"), false);
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "warden_verdict"), false);

  const soulVerdict = await gw.handleToolCall(soul.bearerToken, "warden_verdict", {
    target: "T1",
    verdict: "approve",
  });
  assert.equal((soulVerdict as any).status, "refused");
  assert.equal((soulVerdict as any).code, "FORBIDDEN_ROLE");

  // 3. ask: Planner, Bonesetter, Soul-stitcher allowed; Exhumer, Warden, Scribe forbidden
  assert.equal(isRoleAuthorizedForTool("Planner", "ask"), true);
  assert.equal(isRoleAuthorizedForTool("Bonesetter", "ask"), true);
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "ask"), true);
  assert.equal(isRoleAuthorizedForTool("Exhumer", "ask"), false);
  assert.equal(isRoleAuthorizedForTool("Warden", "ask"), false);
  assert.equal(isRoleAuthorizedForTool("Scribe", "ask"), false);

  const exhumerAsk = await gw.handleToolCall(exhumer.bearerToken, "ask", { question: "Help?" });
  assert.equal((exhumerAsk as any).status, "refused");
  assert.equal((exhumerAsk as any).code, "FORBIDDEN_ROLE");

  // 4. propose_task: strictly Soul-stitcher allowed; Bonesetter, Warden, Scribe, Planner forbidden
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "propose_task"), true);
  assert.equal(isRoleAuthorizedForTool("Bonesetter", "propose_task"), false);
  assert.equal(isRoleAuthorizedForTool("Warden", "propose_task"), false);
  assert.equal(isRoleAuthorizedForTool("Planner", "propose_task"), false);

  const bonesetterProp = await gw.handleToolCall(bonesetter.bearerToken, "propose_task", { title: "Extra" });
  assert.equal((bonesetterProp as any).status, "refused");
  assert.equal((bonesetterProp as any).code, "FORBIDDEN_ROLE");

  // 5. report_blocker: Bonesetter and Soul-stitcher allowed; Planner, Warden, Scribe forbidden
  assert.equal(isRoleAuthorizedForTool("Bonesetter", "report_blocker"), true);
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "report_blocker"), true);
  assert.equal(isRoleAuthorizedForTool("Planner", "report_blocker"), false);
  assert.equal(isRoleAuthorizedForTool("Warden", "report_blocker"), false);
  assert.equal(isRoleAuthorizedForTool("Scribe", "report_blocker"), false);

  const plannerBlocker = await gw.handleToolCall(planner.bearerToken, "report_blocker", { text: "err", kind: "k" });
  assert.equal((plannerBlocker as any).status, "refused");
  assert.equal((plannerBlocker as any).code, "FORBIDDEN_ROLE");

  // 6. ack_message: Bonesetter, Soul-stitcher, Scribe allowed; Planner, Exhumer, Warden forbidden
  assert.equal(isRoleAuthorizedForTool("Bonesetter", "ack_message"), true);
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "ack_message"), true);
  assert.equal(isRoleAuthorizedForTool("Scribe", "ack_message"), true);
  assert.equal(isRoleAuthorizedForTool("Planner", "ack_message"), false);
  assert.equal(isRoleAuthorizedForTool("Exhumer", "ack_message"), false);
  assert.equal(isRoleAuthorizedForTool("Warden", "ack_message"), false);

  const plannerAck = await gw.handleToolCall(planner.bearerToken, "ack_message", { msgId: "m1" });
  assert.equal((plannerAck as any).status, "refused");
  assert.equal((plannerAck as any).code, "FORBIDDEN_ROLE");
});

test("McpGateway: bearer token authentication for collaboration tools (Requirement 19.2)", async () => {
  const gw = new McpGateway({ defaultTimeoutMs: 60000, approvalWaitMs: 300000, logStore: new LogStore({ inMemory: true }) });

  // Missing or unknown token
  const badAuth = await gw.handleToolCall("token-invalid", "ask", { question: "q" });
  assert.equal((badAuth as any).status, "refused");
  assert.equal((badAuth as any).code, "UNAUTHORIZED");

  const emptyAuth = await gw.handleToolCall("", "report_task_result", { taskId: "T1", status: "ok", summary: "ok" });
  assert.equal((emptyAuth as any).status, "refused");
  assert.equal((emptyAuth as any).code, "UNAUTHORIZED");
});

test("Collaboration Tools: property test for ask immediate return and queue invariant", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 200 }), async (question) => {
      const store = new CollaborationStore();
      const context: ToolExecutionContext = {
        skeletonId: "skel-p",
        role: "Planner",
        bearerToken: "token-p",
        runId: "run-prop-ask",
      };

      const res = await handleAsk({ question }, context, { collaborationStore: store });

      // Verification of immediate response shape
      assert.ok(res);
      assert.equal(res.message, "recorded; end your turn");
      assert.equal(res.recorded, true);
      const expectedQuestion = redactText(question.trim());
      assert.equal(res.question, expectedQuestion);

      const queued = store.getQueuedAsks("run-prop-ask");
      assert.equal(queued.length, 1);
      assert.equal(queued[0].question, expectedQuestion);
      assert.equal(queued[0].status, "queued");
    })
  );
});

test("Collaboration Tools: property test for warden_verdict validation invariant", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        target: fc.string({ minLength: 1, maxLength: 50 }),
        verdict: fc.constantFrom("approve" as const, "reject" as const),
        reasonText: fc.string({ minLength: 1, maxLength: 100 }),
        ref: fc.string({ minLength: 1, maxLength: 50 }),
        candidateSha256: fc.string({ minLength: 1, maxLength: 64 }),
      }),
      async (input) => {
        const store = new CollaborationStore();
        const context: ToolExecutionContext = {
          skeletonId: "skel-w",
          role: "Warden",
          bearerToken: "token-w",
          runId: "run-prop-warden",
        };

        const res: any = await handleWardenVerdict(
          {
            target: input.target,
            verdict: input.verdict,
            reasons: [{ text: input.reasonText, refs: [input.ref] }],
            candidateSha256: input.candidateSha256,
          },
          context,
          { collaborationStore: store }
        );

        // Target must not be all-whitespace
        const targetValid = input.target.trim().length > 0;
        const textValid = input.reasonText.trim().length > 0;
        const refValid = input.ref.trim().length > 0;
        const shaValid = input.candidateSha256.trim().length > 0;

        if (targetValid && textValid && refValid && shaValid) {
          assert.equal(res.success, true);
          assert.equal(res.verdict, input.verdict);
        } else {
          assert.equal(res.status, "refused");
        }
      }
    )
  );
});

const SECRETS = {
  ghp: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
  akia: "AKIAIOSFODNN7EXAMPLE",
  asia: "ASIAIOSFODNN7EXAMPLE",
  skLive: "sk_live_1234567890abcdefghijklmnopqrstuv",
  bearer: "Bearer token_super_secret_credentials_12345",
};

test("CollaborationTools: stores and returns redacted text across ask, answer, report_blocker, warden_verdict, claim_patch.paths, and report_task_result.refs", async () => {
  const store = new CollaborationStore();
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];
  const options = {
    collaborationStore: store,
    onEmitEvent: async (evt: any) => {
      emittedEvents.push(evt);
    },
  };

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
    runId: "run-collab-redaction",
  };

  // 1. handleAsk redacts question
  const askRes = await handleAsk(
    { question: `How to configure token ${SECRETS.ghp} and stripe ${SECRETS.skLive}?` },
    context,
    options
  );
  assert.equal(askRes.recorded, true);
  assert.ok(askRes.askId);
  assert.ok(!askRes.question.includes(SECRETS.ghp));
  assert.ok(!askRes.question.includes(SECRETS.skLive));
  assert.ok(askRes.question.includes("[REDACTED]"));

  const storedAsk = store.getAsk(askRes.askId!);
  assert.ok(storedAsk);
  assert.ok(!storedAsk.question.includes(SECRETS.ghp));
  assert.ok(storedAsk.question.includes("[REDACTED]"));

  const askEvt = emittedEvents.find((e) => e.kind === "ask.raised");
  assert.ok(askEvt);
  assert.ok(!String(askEvt.data.question).includes(SECRETS.ghp));
  assert.ok(String(askEvt.data.question).includes("[REDACTED]"));

  // 2. deliverAskAnswer redacts answer
  let steerDelivered = "";
  const deliverRes = await deliverAskAnswer(
    askRes.askId!,
    `Use credential ${SECRETS.bearer} and AWS ${SECRETS.asia}`,
    {
      deliveryMethod: "steer",
      steerHandler: async (text) => {
        steerDelivered = text;
      },
    },
    options
  );
  assert.equal(deliverRes.success, true);
  assert.ok(!deliverRes.answer?.includes("token_super_secret_credentials_12345"));
  assert.ok(!deliverRes.answer?.includes(SECRETS.asia));
  assert.ok(deliverRes.answer?.includes("[REDACTED]"));

  const answeredAsk = store.getAsk(askRes.askId!);
  assert.ok(answeredAsk);
  assert.ok(!answeredAsk.answer?.includes("token_super_secret_credentials_12345"));
  assert.ok(answeredAsk.answer?.includes("[REDACTED]"));

  assert.ok(!steerDelivered.includes("token_super_secret_credentials_12345"));
  assert.ok(steerDelivered.includes("[REDACTED]"));

  const answerEvt = emittedEvents.find((e) => e.kind === "ask.answered");
  assert.ok(answerEvt);
  assert.ok(!String(answerEvt.data.answer).includes("token_super_secret_credentials_12345"));
  assert.ok(String(answerEvt.data.answer).includes("[REDACTED]"));

  // 3. handleReportBlocker redacts text and kind
  const blockerRes = await handleReportBlocker(
    {
      text: `Auth failed for AWS key ${SECRETS.akia}`,
      kind: `bad_token_${SECRETS.ghp}`,
    },
    context,
    options
  );
  assert.equal((blockerRes as any).recorded, true);
  const bRes = blockerRes as import("../../lib/gateway").ReportBlockerResult;
  assert.ok(!bRes.text.includes(SECRETS.akia));
  assert.ok(bRes.text.includes("[REDACTED]"));
  assert.ok(!bRes.kind.includes(SECRETS.ghp));
  assert.ok(bRes.kind.includes("[REDACTED]"));

  const storedBlockers = store.getBlockers("run-collab-redaction");
  assert.equal(storedBlockers.length, 1);
  assert.ok(!storedBlockers[0].text.includes(SECRETS.akia));
  assert.ok(storedBlockers[0].text.includes("[REDACTED]"));
  assert.ok(!storedBlockers[0].kind.includes(SECRETS.ghp));
  assert.ok(storedBlockers[0].kind.includes("[REDACTED]"));

  const blockerEvt = emittedEvents.find((e) => e.kind === "skeleton.tool_result" && e.data.tool === "report_blocker");
  assert.ok(blockerEvt);
  assert.ok(!String(blockerEvt.data.text).includes(SECRETS.akia));
  assert.ok(String(blockerEvt.data.text).includes("[REDACTED]"));
  assert.ok(!String(blockerEvt.data.blockerKind).includes(SECRETS.ghp));
  assert.ok(String(blockerEvt.data.blockerKind).includes("[REDACTED]"));

  // 4. handleWardenVerdict redacts reasons text and refs
  const wardenContext: ToolExecutionContext = {
    skeletonId: "skel-warden",
    role: "Warden",
    bearerToken: "token-warden",
    runId: "run-collab-redaction",
  };
  const verdictRes = await handleWardenVerdict(
    {
      target: "task-wv-1",
      verdict: "reject",
      reasons: [
        {
          text: `Found exposed token ${SECRETS.ghp} in build`,
          refs: [`file:secret_${SECRETS.skLive}.py`, "cmd:test"],
        },
      ],
      candidateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    wardenContext,
    options
  );
  assert.equal((verdictRes as any).success, true);
  const vRes = verdictRes as import("../../lib/gateway").WardenVerdictResultWithReasons;
  assert.ok(vRes.reasons && vRes.reasons.length === 1);
  assert.ok(!vRes.reasons[0].text.includes(SECRETS.ghp));
  assert.ok(vRes.reasons[0].text.includes("[REDACTED]"));
  assert.ok(!vRes.reasons[0].refs[0].includes(SECRETS.skLive));
  assert.ok(vRes.reasons[0].refs[0].includes("[REDACTED]"));

  const storedVerdict = store.getVerdict("task-wv-1", "run-collab-redaction");
  assert.ok(storedVerdict);
  assert.ok(!storedVerdict.reasons[0].text.includes(SECRETS.ghp));
  assert.ok(storedVerdict.reasons[0].text.includes("[REDACTED]"));
  assert.ok(!storedVerdict.reasons[0].refs[0].includes(SECRETS.skLive));
  assert.ok(storedVerdict.reasons[0].refs[0].includes("[REDACTED]"));

  const verdictEvt = emittedEvents.find((e) => e.kind === "verdict");
  assert.ok(verdictEvt);
  const evtReasons = verdictEvt.data.reasons as Array<{ text: string; refs: string[] }>;
  assert.ok(!evtReasons[0].text.includes(SECRETS.ghp));
  assert.ok(!evtReasons[0].refs[0].includes(SECRETS.skLive));

  // 5. handleClaimPatch redacts paths
  const claimRes = await handleClaimPatch(
    {
      paths: [`src/config_${SECRETS.ghp}.ts`, `keys/${SECRETS.akia}.pem`],
      reason: "Updating sensitive credentials",
    },
    context,
    options
  );
  assert.equal((claimRes as any).success, true);
  const cRes = claimRes as import("../../lib/gateway").ClaimPatchResult;
  assert.ok(!cRes.paths.some((p) => p.includes(SECRETS.ghp)));
  assert.ok(!cRes.paths.some((p) => p.includes(SECRETS.akia)));
  assert.ok(cRes.paths.some((p) => p.includes("[REDACTED]")));

  const storedClaims = store.getClaims("run-collab-redaction");
  assert.equal(storedClaims.length, 1);
  assert.ok(!storedClaims[0].paths.some((p) => p.includes(SECRETS.ghp)));
  assert.ok(!storedClaims[0].paths.some((p) => p.includes(SECRETS.akia)));
  assert.ok(storedClaims[0].paths.some((p) => p.includes("[REDACTED]")));

  const claimEvt = emittedEvents.find((e) => e.kind === "claim.patch");
  assert.ok(claimEvt);
  const evtPaths = claimEvt.data.paths as string[];
  assert.ok(!evtPaths.some((p) => p.includes(SECRETS.ghp)));
  assert.ok(evtPaths.some((p) => p.includes("[REDACTED]")));

  // 6. handleReportTaskResult redacts refs
  const taskRes = await handleReportTaskResult(
    {
      taskId: "task-redact-refs",
      status: "completed",
      summary: "Completed migration safely",
      refs: [`cmd:push --auth ${SECRETS.bearer}`, `file:${SECRETS.skLive}.json`],
    },
    context,
    options
  );
  assert.equal((taskRes as any).success, true);
  const tRes = taskRes as import("../../lib/gateway").ReportTaskResultResult;
  assert.ok(!tRes.refs?.some((r) => r.includes("token_super_secret_credentials_12345")));
  assert.ok(!tRes.refs?.some((r) => r.includes(SECRETS.skLive)));
  assert.ok(tRes.refs?.some((r) => r.includes("[REDACTED]")));

  const storedResult = store.getTaskResult("task-redact-refs", "run-collab-redaction");
  assert.ok(storedResult);
  assert.ok(!storedResult.refs.some((r) => r.includes("token_super_secret_credentials_12345")));
  assert.ok(!storedResult.refs.some((r) => r.includes(SECRETS.skLive)));
  assert.ok(storedResult.refs.some((r) => r.includes("[REDACTED]")));

  const taskEvt = emittedEvents.find((e) => e.kind === "task.state" && e.data.taskId === "task-redact-refs");
  assert.ok(taskEvt);
  const evtTaskRefs = taskEvt.data.refs as string[];
  assert.ok(!evtTaskRefs.some((r) => r.includes("token_super_secret_credentials_12345")));
  assert.ok(evtTaskRefs.some((r) => r.includes("[REDACTED]")));
});

test("handleProgressReport: redacts secrets in refs across returned result and store.getProgressReports()", async () => {
  const store = new CollaborationStore();
  const emittedEvents: Array<{ kind: string; runId: string; actor: string; data: Record<string, unknown> }> = [];
  const options = {
    collaborationStore: store,
    onEmitEvent: async (evt: any) => {
      emittedEvents.push(evt);
    },
  };

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
    runId: "run-prog-redaction",
  };

  const res = await handleProgressReport(
    {
      taskId: "task-prog-redact-1",
      status: "in_progress",
      summary: `Working with ${SECRETS.ghp} on backend`,
      refs: [
        `file:/data/home/repo/secrets/${SECRETS.skLive}.json`,
        `cmd:auth --token ${SECRETS.bearer}`,
        `aws:${SECRETS.akia}`,
      ],
    },
    context,
    options
  );

  assert.equal((res as any).success, true);
  const pRes = res as import("../../lib/gateway").ProgressReportResult;
  assert.equal(pRes.taskId, "task-prog-redact-1");
  assert.equal(pRes.status, "in_progress");

  // Summary must be redacted
  assert.ok(!pRes.summary.includes(SECRETS.ghp));
  assert.ok(pRes.summary.includes("[REDACTED]"));

  // Returned refs must be redacted
  assert.equal(pRes.refs.length, 3);
  for (const ref of pRes.refs) {
    assert.ok(!ref.includes(SECRETS.skLive));
    assert.ok(!ref.includes(SECRETS.bearer));
    assert.ok(!ref.includes(SECRETS.akia));
    assert.ok(!ref.includes("/data/home"));
    assert.ok(ref.includes("[REDACTED]"));
  }

  // store.getProgressReports() must be redacted
  const reports = store.getProgressReports("run-prog-redaction");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].taskId, "task-prog-redact-1");
  assert.ok(!reports[0].summary.includes(SECRETS.ghp));
  assert.ok(reports[0].summary.includes("[REDACTED]"));
  for (const ref of reports[0].refs) {
    assert.ok(!ref.includes(SECRETS.skLive));
    assert.ok(!ref.includes(SECRETS.bearer));
    assert.ok(!ref.includes(SECRETS.akia));
    assert.ok(!ref.includes("/data/home"));
    assert.ok(ref.includes("[REDACTED]"));
  }

  // Emitted event refs must be redacted
  const progEvt = emittedEvents.find((e) => e.kind === "progress.report");
  assert.ok(progEvt);
  const evtRefs = progEvt.data.refs as string[];
  for (const ref of evtRefs) {
    assert.ok(!ref.includes(SECRETS.skLive));
    assert.ok(!ref.includes(SECRETS.bearer));
    assert.ok(!ref.includes(SECRETS.akia));
    assert.ok(!ref.includes("/data/home"));
    assert.ok(ref.includes("[REDACTED]"));
  }
});

test("CollaborationStore: direct calls persist redacted strings (recordProgressReport, recordProposal, rejectProposal, mitigateBlocker, recordRulingRequest)", async () => {
  const store = new CollaborationStore();

  // 1. Direct recordProgressReport redacts summary and refs
  const report = store.recordProgressReport({
    taskId: "task-direct-prog",
    status: "running",
    summary: `Progress using key ${SECRETS.ghp}`,
    refs: [`file:/data/home/config_${SECRETS.asia}.ts`, `token:${SECRETS.bearer}`],
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    runId: "run-direct-store",
    recordedAt: Date.now(),
  });
  assert.ok(!report.summary.includes(SECRETS.ghp));
  assert.ok(report.summary.includes("[REDACTED]"));
  for (const ref of report.refs) {
    assert.ok(!ref.includes(SECRETS.asia));
    assert.ok(!ref.includes(SECRETS.bearer));
    assert.ok(!ref.includes("/data/home"));
    assert.ok(ref.includes("[REDACTED]"));
  }

  const storedReports = store.getProgressReports("run-direct-store");
  assert.equal(storedReports.length, 1);
  assert.ok(!storedReports[0].summary.includes(SECRETS.ghp));
  assert.ok(storedReports[0].summary.includes("[REDACTED]"));
  for (const ref of storedReports[0].refs) {
    assert.ok(!ref.includes(SECRETS.asia));
    assert.ok(!ref.includes(SECRETS.bearer));
    assert.ok(!ref.includes("/data/home"));
    assert.ok(ref.includes("[REDACTED]"));
  }

  const storedReport = store.getProgressReport("task-direct-prog", "run-direct-store");
  assert.ok(storedReport);
  assert.ok(!storedReport.summary.includes(SECRETS.ghp));
  assert.ok(storedReport.summary.includes("[REDACTED]"));
  for (const ref of storedReport.refs) {
    assert.ok(!ref.includes(SECRETS.asia));
    assert.ok(!ref.includes(SECRETS.bearer));
    assert.ok(!ref.includes("/data/home"));
    assert.ok(ref.includes("[REDACTED]"));
  }

  // 2. Direct recordProposal redacts title, reason, and reasons entries
  const proposal = store.recordProposal({
    proposalId: "prop-direct-1",
    title: `Add OAuth for ${SECRETS.ghp}`,
    reason: `Need secret ${SECRETS.akia} for integration`,
    reasons: [
      `Primary reason with ${SECRETS.asia}`,
      `Secondary reason with ${SECRETS.skLive}`,
    ],
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    runId: "run-direct-store",
    status: "pending_confirmation",
    createdAt: Date.now(),
  });
  assert.ok(!proposal.title.includes(SECRETS.ghp));
  assert.ok(proposal.title.includes("[REDACTED]"));
  const storedProp = store.getProposal("prop-direct-1");
  assert.ok(storedProp);
  assert.ok(!storedProp.title.includes(SECRETS.ghp));
  assert.ok(storedProp.title.includes("[REDACTED]"));
  assert.ok(storedProp.reason);
  assert.ok(!storedProp.reason.includes(SECRETS.akia));
  assert.ok(storedProp.reason.includes("[REDACTED]"));
  assert.ok(storedProp.reasons);
  assert.equal(storedProp.reasons.length, 2);
  assert.ok(!storedProp.reasons[0].includes(SECRETS.asia));
  assert.ok(storedProp.reasons[0].includes("[REDACTED]"));
  assert.ok(!storedProp.reasons[1].includes(SECRETS.skLive));
  assert.ok(storedProp.reasons[1].includes("[REDACTED]"));

  // 3. Direct rejectProposal redacts resolutionReason when provided
  const rejected = store.rejectProposal("prop-direct-1", `Rejected due to exposed credential ${SECRETS.bearer}`);
  assert.equal(rejected, true);
  const rejectedProp = store.getProposal("prop-direct-1");
  assert.ok(rejectedProp);
  assert.equal(rejectedProp.status, "rejected");
  assert.ok(rejectedProp.resolutionReason);
  assert.ok(!rejectedProp.resolutionReason.includes(SECRETS.bearer));
  assert.ok(rejectedProp.resolutionReason.includes("[REDACTED]"));

  // 4. Direct mitigateBlocker redacts mitigationAction when provided
  store.recordBlocker({
    blockerId: "blk-direct-1",
    text: "Blocked on external service",
    kind: "dependency",
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    runId: "run-direct-store",
    status: "reported",
    createdAt: Date.now(),
  });
  const mitigated = store.mitigateBlocker("blk-direct-1", `Mitigated by rotating ${SECRETS.skLive} and token ${SECRETS.ghp}`);
  assert.equal(mitigated, true);
  const blk = store.getBlocker("blk-direct-1");
  assert.ok(blk);
  assert.equal(blk.status, "mitigated");
  assert.ok(blk.mitigationAction);
  assert.ok(!blk.mitigationAction.includes(SECRETS.skLive));
  assert.ok(!blk.mitigationAction.includes(SECRETS.ghp));
  assert.ok(blk.mitigationAction.includes("[REDACTED]"));

  // 5. Direct recordRulingRequest redacts question
  const rulingString = store.recordRulingRequest(`Should we deploy with key ${SECRETS.asia}?`, {
    runId: "run-direct-store",
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
  });
  assert.ok(!rulingString.question.includes(SECRETS.asia));
  assert.ok(rulingString.question.includes("[REDACTED]"));
  const storedRuling = store.getRulingRequest(rulingString.rulingId, "run-direct-store");
  assert.ok(storedRuling);
  assert.ok(!storedRuling.question.includes(SECRETS.asia));
  assert.ok(storedRuling.question.includes("[REDACTED]"));

  // Direct recordRulingRequest with object parameter
  const rulingObj = store.recordRulingRequest({
    question: `Ruling question with secret ${SECRETS.akia}`,
    runId: "run-direct-store",
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
  });
  assert.ok(!rulingObj.question.includes(SECRETS.akia));
  assert.ok(rulingObj.question.includes("[REDACTED]"));
  const storedRulingObj = store.getRulingRequest(rulingObj.rulingId, "run-direct-store");
  assert.ok(storedRulingObj);
  assert.ok(!storedRulingObj.question.includes(SECRETS.akia));
  assert.ok(storedRulingObj.question.includes("[REDACTED]"));
});
