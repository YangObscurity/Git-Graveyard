// Task RB3: Second-round B-audit mandatory redaction in ApprovalManager and CollaborationTools (N-B12)
// Requirements: N-B12, 20.6, 20.7, 19.13, 19.17

import test from "node:test";
import * as assert from "node:assert/strict";
import {
  ApprovalManager,
  type ApprovalRecord,
  type EventEmitCallback,
} from "../../lib/gateway/approval-manager";
import {
  handleProgressReport,
  handleClaimPatch,
  handleRequestRuling,
  handleProposeTask,
  emitEvent,
  CollaborationStore,
  type ToolExecutionContext,
} from "../../lib/gateway/collaboration-tools";
import { EventStore } from "../../lib/events/event-store";

const SECRETS = {
  ghp: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
  akia: "AKIAIOSFODNN7EXAMPLE",
  asia: "ASIAIOSFODNN7EXAMPLE",
  skLive: "sk_live_1234567890abcdefghijklmnopqrstuv",
  bearer: "Bearer token_super_secret_credentials_12345",
};

test("ApprovalManager: requestApproval redacts secrets from reason, summary, and detail in stored record and emitted event", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const eventStore = new EventStore(":memory:");

  const mgr = new ApprovalManager({
    defaultWaitMs: 60000,
    eventStore,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const secretReason = `Need access for deployment using ${SECRETS.ghp} and ${SECRETS.bearer}`;
  const secretSummary = `Build update with AWS key ${SECRETS.akia}`;
  const secretDetail = `Stripe config requires ${SECRETS.skLive}`;

  const record: ApprovalRecord = await mgr.requestApproval({
    runId: "run-rb3-req-1",
    skeletonId: "skel-soul",
    argv: ["npm", "run", "deploy"],
    cwd: "/workspace/repo",
    ttlMs: 30000,
    reason: secretReason,
    summary: secretSummary,
    detail: secretDetail,
  });

  // Verify stored record
  assert.ok(record);
  assert.equal(record.status, "approval_pending");

  // Reason must not contain raw secrets
  assert.ok(!record.reason?.includes(SECRETS.ghp), "Stored record reason must not contain ghp token");
  assert.ok(!record.reason?.includes("token_super_secret_credentials_12345"), "Stored record reason must not contain bearer token");
  assert.ok(record.reason?.includes("[REDACTED]"), "Stored record reason must include [REDACTED]");

  // Summary and detail must not contain raw secrets
  assert.ok(!record.summary?.includes(SECRETS.akia), "Stored record summary must not contain AKIA key");
  assert.ok(record.summary?.includes("[REDACTED]"), "Stored record summary must include [REDACTED]");
  assert.ok(!record.detail?.includes(SECRETS.skLive), "Stored record detail must not contain sk_live key");
  assert.ok(record.detail?.includes("[REDACTED]"), "Stored record detail must include [REDACTED]");

  // Verify retrieved stored record from manager
  const retrieved = mgr.getApprovalRecord(record.approvalId);
  assert.ok(retrieved);
  assert.equal(retrieved.reason, record.reason);
  assert.equal(retrieved.summary, record.summary);
  assert.equal(retrieved.detail, record.detail);

  // Verify emitted event via onEmitEvent
  const requestedEvents = emittedEvents.filter((e) => e.kind === "approval.requested");
  assert.equal(requestedEvents.length, 1);
  const eventData = requestedEvents[0].data;

  assert.ok(!String(eventData.reason).includes(SECRETS.ghp), "Emitted event reason must not contain ghp token");
  assert.ok(!String(eventData.reason).includes("token_super_secret_credentials_12345"), "Emitted event reason must not contain bearer token");
  assert.ok(String(eventData.reason).includes("[REDACTED]"), "Emitted event reason must include [REDACTED]");
  assert.ok(!String(eventData.summary).includes(SECRETS.akia), "Emitted event summary must not contain AKIA key");
  assert.ok(!String(eventData.detail).includes(SECRETS.skLive), "Emitted event detail must not contain sk_live key");

  // Verify EventStore storage
  const storedEvents = eventStore.getEvents("run-rb3-req-1");
  const storedReq = storedEvents.find((e) => e.kind === "approval.requested");
  assert.ok(storedReq);
  const storedData = storedReq.data as Record<string, unknown>;
  assert.ok(!String(storedData.reason).includes(SECRETS.ghp), "EventStore record must not contain ghp token");
  assert.ok(String(storedData.reason).includes("[REDACTED]"), "EventStore record must include [REDACTED]");
});

test("ApprovalManager: resolveApproval redacts secrets from resolution.reason in stored record and emitted event (approved)", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const eventStore = new EventStore(":memory:");

  const mgr = new ApprovalManager({
    defaultWaitMs: 60000,
    eventStore,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const req = await mgr.requestApproval({
    runId: "run-rb3-res-1",
    skeletonId: "skel-soul",
    argv: ["make", "build"],
    cwd: "/workspace/repo",
  });

  const secretResolutionReason = `Approved using temporary credentials ${SECRETS.asia} and ${SECRETS.skLive}`;

  const resolved = await mgr.resolveApproval(req.approvalId, {
    decision: "approved",
    reason: secretResolutionReason,
    resolvedBy: "admin",
  });

  assert.ok(resolved);
  assert.equal(resolved.status, "approved");

  // Stored record.resolutionReason must not contain raw secrets
  assert.ok(!resolved.resolutionReason?.includes(SECRETS.asia), "Stored resolutionReason must not contain ASIA key");
  assert.ok(!resolved.resolutionReason?.includes(SECRETS.skLive), "Stored resolutionReason must not contain sk_live key");
  assert.ok(resolved.resolutionReason?.includes("[REDACTED]"), "Stored resolutionReason must include [REDACTED]");

  // Stored record retrieved from manager
  const stored = mgr.getApprovalRecord(req.approvalId);
  assert.ok(stored);
  assert.equal(stored.resolutionReason, resolved.resolutionReason);

  // Emitted event check
  const resolvedEvents = emittedEvents.filter((e) => e.kind === "approval.resolved");
  assert.equal(resolvedEvents.length, 1);
  const eventData = resolvedEvents[0].data;
  assert.ok(!String(eventData.reason).includes(SECRETS.asia), "Emitted event reason must not contain ASIA key");
  assert.ok(!String(eventData.reason).includes(SECRETS.skLive), "Emitted event reason must not contain sk_live key");
  assert.ok(String(eventData.reason).includes("[REDACTED]"), "Emitted event reason must include [REDACTED]");

  // EventStore check
  const storedEvents = eventStore.getEvents("run-rb3-res-1");
  const storedResolved = storedEvents.find((e) => e.kind === "approval.resolved");
  assert.ok(storedResolved);
  const storedData = storedResolved.data as Record<string, unknown>;
  assert.ok(!String(storedData.reason).includes(SECRETS.asia), "EventStore resolved reason must not contain ASIA key");
  assert.ok(String(storedData.reason).includes("[REDACTED]"), "EventStore resolved reason must include [REDACTED]");
});

test("ApprovalManager: resolveApproval redacts secrets from resolution.reason in stored record and emitted event (denied)", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const mgr = new ApprovalManager({
    defaultWaitMs: 60000,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const req = await mgr.requestApproval({
    runId: "run-rb3-deny-1",
    skeletonId: "skel-soul",
    argv: ["cat", "/etc/passwd"],
    cwd: "/workspace/repo",
  });

  const secretDenyReason = `Denied because token ${SECRETS.ghp} was detected`;

  const resolved = await mgr.resolveApproval(req.approvalId, {
    decision: "denied",
    reason: secretDenyReason,
    resolvedBy: "security_auditor",
  });

  assert.ok(resolved);
  assert.equal(resolved.status, "denied");

  // Stored record.resolutionReason and deniedReason
  assert.ok(!resolved.resolutionReason?.includes(SECRETS.ghp), "resolutionReason must not contain ghp token");
  assert.ok(resolved.resolutionReason?.includes("[REDACTED]"), "resolutionReason must include [REDACTED]");
  assert.ok(!resolved.deniedReason?.includes(SECRETS.ghp), "deniedReason must not contain ghp token");
  assert.ok(resolved.deniedReason?.includes("[REDACTED]"), "deniedReason must include [REDACTED]");

  // Emitted event
  const resolvedEvents = emittedEvents.filter((e) => e.kind === "approval.resolved");
  assert.equal(resolvedEvents.length, 1);
  assert.ok(!String(resolvedEvents[0].data.reason).includes(SECRETS.ghp));
  assert.ok(String(resolvedEvents[0].data.reason).includes("[REDACTED]"));
});

test("ApprovalManager: emitEvent redacts sensitive tokens before appending to eventStore and invoking onEmitEvent", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const eventStore = new EventStore(":memory:");

  const mgr = new ApprovalManager({
    defaultWaitMs: 60000,
    eventStore,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  await mgr.emitEvent({
    kind: "custom.diagnostic",
    runId: "run-rb3-emit-1",
    actor: "system",
    data: {
      diagnosticMessage: `Found key ${SECRETS.akia} and bearer ${SECRETS.bearer}`,
      nested: {
        token: SECRETS.skLive,
      },
    },
  });

  assert.equal(emittedEvents.length, 1);
  const data = emittedEvents[0].data;
  assert.ok(!String(data.diagnosticMessage).includes(SECRETS.akia));
  assert.ok(String(data.diagnosticMessage).includes("[REDACTED]"));
  assert.equal((data.nested as Record<string, unknown>).token, "[REDACTED]");

  const stored = eventStore.getEvents("run-rb3-emit-1");
  assert.equal(stored.length, 1);
  const storedData = stored[0].data as Record<string, unknown>;
  assert.ok(!String(storedData.diagnosticMessage).includes(SECRETS.akia));
  assert.equal((storedData.nested as Record<string, unknown>).token, "[REDACTED]");
});

test("CollaborationTools: handleProgressReport redacts summary in stored record, emitted event, and response", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const store = new CollaborationStore();

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
    runId: "run-rb3-progress",
  };

  const secretSummary = `Finished migration; GitHub PAT is ${SECRETS.ghp} with AWS ID ${SECRETS.akia}`;

  const res = await handleProgressReport(
    {
      taskId: "task-prog-1",
      status: "completed",
      summary: secretSummary,
      refs: ["file:package.json"],
    },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt) => {
        emittedEvents.push(evt as any);
      },
    }
  );

  assert.ok(res);
  assert.equal(res.status, "completed");

  // Returned summary must be redacted
  assert.ok(!res.summary.includes(SECRETS.ghp), "Response summary must not contain ghp token");
  assert.ok(!res.summary.includes(SECRETS.akia), "Response summary must not contain AKIA key");
  assert.ok(res.summary.includes("[REDACTED]"), "Response summary must contain [REDACTED]");

  // Stored record in CollaborationStore
  const storedReports = store.getProgressReports("run-rb3-progress");
  assert.equal(storedReports.length, 1);
  assert.ok(!storedReports[0].summary.includes(SECRETS.ghp), "Stored progress report must not contain ghp token");
  assert.ok(!storedReports[0].summary.includes(SECRETS.akia), "Stored progress report must not contain AKIA key");
  assert.ok(storedReports[0].summary.includes("[REDACTED]"), "Stored progress report must contain [REDACTED]");

  // Emitted event
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "progress.report");
  assert.ok(!String(emittedEvents[0].data.summary).includes(SECRETS.ghp), "Emitted event summary must not contain ghp token");
  assert.ok(!String(emittedEvents[0].data.summary).includes(SECRETS.akia), "Emitted event summary must not contain AKIA key");
  assert.ok(String(emittedEvents[0].data.summary).includes("[REDACTED]"), "Emitted event summary must contain [REDACTED]");
});

test("CollaborationTools: handleClaimPatch redacts reason in stored record, emitted event, and response", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const store = new CollaborationStore();

  const context: ToolExecutionContext = {
    skeletonId: "skel-bone",
    role: "Bonesetter",
    bearerToken: "token-bone",
    runId: "run-rb3-claim",
  };

  const secretReason = `Claiming files using ASIA key ${SECRETS.asia} and Stripe ${SECRETS.skLive}`;

  const res = await handleClaimPatch(
    {
      paths: ["src/auth.ts", "src/client.ts"],
      reason: secretReason,
    },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt) => {
        emittedEvents.push(evt as any);
      },
    }
  );

  assert.ok(res);
  assert.equal("reason" in res, true);
  const claimRes = res as import("../../lib/gateway/collaboration-tools").ClaimPatchResult;
  assert.equal(claimRes.success, true);

  // Returned reason must be redacted
  assert.ok(!claimRes.reason.includes(SECRETS.asia), "Response reason must not contain ASIA key");
  assert.ok(!claimRes.reason.includes(SECRETS.skLive), "Response reason must not contain sk_live key");
  assert.ok(claimRes.reason.includes("[REDACTED]"), "Response reason must contain [REDACTED]");

  // Stored record in CollaborationStore
  const storedClaims = store.getClaims("run-rb3-claim");
  assert.equal(storedClaims.length, 1);
  assert.ok(!storedClaims[0].reason.includes(SECRETS.asia), "Stored claim reason must not contain ASIA key");
  assert.ok(!storedClaims[0].reason.includes(SECRETS.skLive), "Stored claim reason must not contain sk_live key");
  assert.ok(storedClaims[0].reason.includes("[REDACTED]"), "Stored claim reason must contain [REDACTED]");

  // Emitted event
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "claim.patch");
  assert.ok(!String(emittedEvents[0].data.reason).includes(SECRETS.asia));
  assert.ok(!String(emittedEvents[0].data.reason).includes(SECRETS.skLive));
  assert.ok(String(emittedEvents[0].data.reason).includes("[REDACTED]"));
});

test("CollaborationTools: handleRequestRuling redacts question in stored record, emitted event, and response", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const store = new CollaborationStore();

  const context: ToolExecutionContext = {
    skeletonId: "skel-planner",
    role: "Planner",
    bearerToken: "token-planner",
    runId: "run-rb3-ruling",
  };

  const secretQuestion = `Should we permit ${SECRETS.bearer} authentication header in tests?`;

  const res = await handleRequestRuling(
    {
      question: secretQuestion,
    },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt) => {
        emittedEvents.push(evt as any);
      },
    }
  );

  assert.ok(res);
  assert.equal("question" in res, true);
  const rulingRes = res as import("../../lib/gateway/collaboration-tools").RequestRulingResult;
  assert.equal(rulingRes.recorded, true);

  // Returned question must be redacted
  assert.ok(!rulingRes.question.includes("token_super_secret_credentials_12345"), "Response question must not contain bearer secret");
  assert.ok(rulingRes.question.includes("[REDACTED]"), "Response question must contain [REDACTED]");

  // Stored record in CollaborationStore
  const storedRulings = store.getRulingRequests("run-rb3-ruling");
  assert.equal(storedRulings.length, 1);
  assert.ok(!storedRulings[0].question.includes("token_super_secret_credentials_12345"), "Stored ruling question must not contain bearer secret");
  assert.ok(storedRulings[0].question.includes("[REDACTED]"), "Stored ruling question must contain [REDACTED]");

  // Emitted event
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "request.ruling");
  assert.ok(!String(emittedEvents[0].data.question).includes("token_super_secret_credentials_12345"));
  assert.ok(String(emittedEvents[0].data.question).includes("[REDACTED]"));
});

test("CollaborationTools: handleProposeTask redacts title, description, and reasons in stored record, emitted event, and response", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const store = new CollaborationStore();

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-soul",
    runId: "run-rb3-prop",
  };

  const secretTitle = `Configure PAT ${SECRETS.ghp} integration`;
  const secretDescription = `Set up AWS credentials with ${SECRETS.akia} and Stripe ${SECRETS.skLive}`;
  const secretReasons = [
    `Primary reason: Authorization ${SECRETS.bearer}`,
    `Secondary reason: Temporary access with ${SECRETS.asia}`,
  ];

  const res = await handleProposeTask(
    {
      title: secretTitle,
      description: secretDescription,
      reasons: secretReasons,
    },
    context,
    {
      collaborationStore: store,
      onEmitEvent: async (evt) => {
        emittedEvents.push(evt as any);
      },
    }
  );

  assert.ok(res);
  assert.equal(res.recorded, true);

  // Returned response redactions
  assert.ok(!res.title.includes(SECRETS.ghp), "Response title must not contain ghp token");
  assert.ok(res.title.includes("[REDACTED]"), "Response title must contain [REDACTED]");

  assert.ok(!res.description?.includes(SECRETS.akia), "Response description must not contain AKIA key");
  assert.ok(!res.description?.includes(SECRETS.skLive), "Response description must not contain sk_live key");
  assert.ok(res.description?.includes("[REDACTED]"), "Response description must contain [REDACTED]");

  assert.ok(res.reasons && res.reasons.length === 2);
  assert.ok(!res.reasons[0].includes("token_super_secret_credentials_12345"), "Response reasons[0] must not contain bearer secret");
  assert.ok(res.reasons[0].includes("[REDACTED]"), "Response reasons[0] must contain [REDACTED]");
  assert.ok(!res.reasons[1].includes(SECRETS.asia), "Response reasons[1] must not contain ASIA key");
  assert.ok(res.reasons[1].includes("[REDACTED]"), "Response reasons[1] must contain [REDACTED]");

  // Stored record in CollaborationStore
  const storedProposals = store.getProposals("run-rb3-prop");
  assert.equal(storedProposals.length, 1);
  const storedProp = storedProposals[0];
  assert.ok(!storedProp.title.includes(SECRETS.ghp), "Stored proposal title must not contain ghp token");
  assert.ok(storedProp.title.includes("[REDACTED]"), "Stored proposal title must contain [REDACTED]");
  assert.ok(!storedProp.description?.includes(SECRETS.akia), "Stored proposal description must not contain AKIA key");
  assert.ok(!storedProp.description?.includes(SECRETS.skLive), "Stored proposal description must not contain sk_live key");
  assert.ok(storedProp.description?.includes("[REDACTED]"), "Stored proposal description must contain [REDACTED]");
  assert.ok(storedProp.reasons && storedProp.reasons.length === 2);
  assert.ok(!storedProp.reasons[0].includes("token_super_secret_credentials_12345"), "Stored reasons[0] must not contain bearer secret");
  assert.ok(storedProp.reasons[0].includes("[REDACTED]"), "Stored reasons[0] must contain [REDACTED]");
  assert.ok(!storedProp.reasons[1].includes(SECRETS.asia), "Stored reasons[1] must not contain ASIA key");
  assert.ok(storedProp.reasons[1].includes("[REDACTED]"), "Stored reasons[1] must contain [REDACTED]");

  // Emitted event
  assert.equal(emittedEvents.length, 1);
  const evtData = emittedEvents[0].data;
  assert.ok(!String(evtData.title).includes(SECRETS.ghp));
  assert.ok(String(evtData.title).includes("[REDACTED]"));
  assert.ok(!String(evtData.description).includes(SECRETS.akia));
  assert.ok(!String(evtData.description).includes(SECRETS.skLive));
  assert.ok(String(evtData.description).includes("[REDACTED]"));
  const evtReasons = evtData.reasons as string[];
  assert.ok(Array.isArray(evtReasons) && evtReasons.length === 2);
  assert.ok(!evtReasons[0].includes("token_super_secret_credentials_12345"));
  assert.ok(evtReasons[0].includes("[REDACTED]"));
  assert.ok(!evtReasons[1].includes(SECRETS.asia));
  assert.ok(evtReasons[1].includes("[REDACTED]"));
});

test("CollaborationTools: emitEvent redacts payload and event data before invoking onEmitEvent", async () => {
  const emittedEvents: Array<Record<string, unknown>> = [];
  const options = {
    onEmitEvent: async (evt: any) => {
      emittedEvents.push(evt);
    },
  };

  await emitEvent(options, {
    kind: "custom.event",
    runId: "run-rb3-collab-emit",
    actor: "system",
    data: {
      key: SECRETS.akia,
    },
    payload: {
      nestedToken: SECRETS.ghp,
      auth: SECRETS.bearer,
    },
  });

  assert.equal(emittedEvents.length, 1);
  const evt = emittedEvents[0];
  const data = evt.data as Record<string, unknown>;
  const payload = evt.payload as Record<string, unknown>;

  assert.equal(data.key, "[REDACTED]");
  assert.equal(payload.nestedToken, "[REDACTED]");
  assert.ok(!String(payload.auth).includes("token_super_secret_credentials_12345"));
  assert.ok(String(payload.auth).includes("[REDACTED]"));
});

test("ApprovalManager: strict fail-closed decision parsing rejects invalid/empty resolutions and treats unknown/rejected strings as denied", async () => {
  const mgr = new ApprovalManager({ defaultWaitMs: 60000 });

  const req1 = await mgr.requestApproval({
    runId: "run-fc-1",
    skeletonId: "skel-soul",
    argv: ["echo", "test1"],
    cwd: "/workspace/repo",
  });

  // 1. undefined throws 'Resolution decision is required'
  await assert.rejects(
    async () => {
      await mgr.resolveApproval(req1.approvalId, undefined);
    },
    {
      name: "Error",
      message: "Resolution decision is required",
    }
  );

  // 2. null throws 'Resolution decision is required'
  await assert.rejects(
    async () => {
      await mgr.resolveApproval(req1.approvalId, null as any);
    },
    {
      name: "Error",
      message: "Resolution decision is required",
    }
  );

  // 3. {} throws 'Invalid approval decision: expected approved or denied'
  await assert.rejects(
    async () => {
      await mgr.resolveApproval(req1.approvalId, {});
    },
    {
      name: "Error",
      message: "Invalid approval decision: expected approved or denied",
    }
  );

  // 4. Object with unknown decision throws 'Invalid approval decision: expected approved or denied'
  await assert.rejects(
    async () => {
      await mgr.resolveApproval(req1.approvalId, { decision: "maybe" });
    },
    {
      name: "Error",
      message: "Invalid approval decision: expected approved or denied",
    }
  );

  // 5. String 'rejected' -> decision = 'denied', rawReason = 'rejected'
  const rejReq = await mgr.requestApproval({
    runId: "run-fc-2",
    skeletonId: "skel-soul",
    argv: ["echo", "test2"],
    cwd: "/workspace/repo",
  });
  const rejRes = await mgr.resolveApproval(rejReq.approvalId, "rejected");
  assert.ok(rejRes);
  assert.equal(rejRes.status, "denied");
  assert.equal(rejRes.deniedReason, "rejected");
  assert.equal(mgr.consumeGrant("skel-soul", ["echo", "test2"], "/workspace/repo", rejReq.approvalId), false);

  // 6. String 'cancelled' -> decision = 'denied'
  const canReq = await mgr.requestApproval({
    runId: "run-fc-3",
    skeletonId: "skel-soul",
    argv: ["echo", "test3"],
    cwd: "/workspace/repo",
  });
  const canRes = await mgr.resolveApproval(canReq.approvalId, "cancelled");
  assert.ok(canRes);
  assert.equal(canRes.status, "denied");
  assert.equal(mgr.consumeGrant("skel-soul", ["echo", "test3"], "/workspace/repo", canReq.approvalId), false);

  // 7. String 'timeout' -> decision = 'denied'
  const timeReq = await mgr.requestApproval({
    runId: "run-fc-4",
    skeletonId: "skel-soul",
    argv: ["echo", "test4"],
    cwd: "/workspace/repo",
  });
  const timeRes = await mgr.resolveApproval(timeReq.approvalId, "timeout");
  assert.ok(timeRes);
  assert.equal(timeRes.status, "denied");
  assert.equal(mgr.consumeGrant("skel-soul", ["echo", "test4"], "/workspace/repo", timeReq.approvalId), false);

  // 8. Arbitrary unknown string -> decision = 'denied', rawReason = resolution
  const unkReq = await mgr.requestApproval({
    runId: "run-fc-5",
    skeletonId: "skel-soul",
    argv: ["echo", "test5"],
    cwd: "/workspace/repo",
  });
  const unkRes = await mgr.resolveApproval(unkReq.approvalId, "Custom denial reason: untrusted script");
  assert.ok(unkRes);
  assert.equal(unkRes.status, "denied");
  assert.equal(unkRes.deniedReason, "Custom denial reason: untrusted script");
  assert.equal(mgr.consumeGrant("skel-soul", ["echo", "test5"], "/workspace/repo", unkReq.approvalId), false);

  // 9. Object with 'rejected', 'cancelled', 'timeout', 'expired', 'deny' all resolve to denied
  for (const decisionValue of ["rejected", "cancelled", "timeout", "expired", "deny"] as const) {
    const objReq = await mgr.requestApproval({
      runId: `run-obj-${decisionValue}`,
      skeletonId: "skel-soul",
      argv: ["echo", decisionValue],
      cwd: "/workspace/repo",
    });
    const objRes = await mgr.resolveApproval(objReq.approvalId, { decision: decisionValue });
    assert.ok(objRes);
    assert.equal(objRes.status, "denied");
    assert.equal(mgr.consumeGrant("skel-soul", ["echo", decisionValue], "/workspace/repo", objReq.approvalId), false);
  }
});

test("ApprovalManager: runId mismatch guard in resolveApproval and expectedRunId in consumeGrant", async () => {
  const mgr = new ApprovalManager({ defaultWaitMs: 60000 });

  const req = await mgr.requestApproval({
    runId: "run-expected-1",
    skeletonId: "skel-soul",
    argv: ["git", "fetch", "--all"],
    cwd: "/workspace/repo",
  });

  // Mismatched runId throws error
  await assert.rejects(
    async () => {
      await mgr.resolveApproval(req.approvalId, {
        decision: "approved",
        runId: "wrong-run-id",
      });
    },
    /runId mismatch: expected run-expected-1, got wrong-run-id/
  );

  // Matching runId succeeds
  const resolved = await mgr.resolveApproval(req.approvalId, {
    decision: "approved",
    runId: "run-expected-1",
  });
  assert.ok(resolved);
  assert.equal(resolved.status, "approved");

  // 4-arg consumeGrant works
  const req4 = await mgr.requestApproval({
    runId: "run-4arg",
    skeletonId: "skel-soul",
    argv: ["git", "status"],
    cwd: "/workspace/repo",
  });
  await mgr.resolveApproval(req4.approvalId, { decision: "approved" });
  assert.equal(mgr.consumeGrant("skel-soul", ["git", "status"], "/workspace/repo", req4.approvalId), true);

  // consumeGrant with mismatched expectedRunId fails
  const consumedWrong = mgr.consumeGrant(
    "skel-soul",
    ["git", "fetch", "--all"],
    "/workspace/repo",
    req.approvalId,
    "wrong-run-id"
  );
  assert.equal(consumedWrong, false);

  // consumeGrant with matching expectedRunId succeeds
  const consumedRight = mgr.consumeGrant(
    "skel-soul",
    ["git", "fetch", "--all"],
    "/workspace/repo",
    req.approvalId,
    "run-expected-1"
  );
  assert.equal(consumedRight, true);

  // One-time grant consumed; second call fails
  const consumedAgain = mgr.consumeGrant(
    "skel-soul",
    ["git", "fetch", "--all"],
    "/workspace/repo",
    req.approvalId,
    "run-expected-1"
  );
  assert.equal(consumedAgain, false);
});

test("ApprovalManager: requestApproval stores redacted argv and cwd while consumeGrant matches canonical raw inputs", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const mgr = new ApprovalManager({
    defaultWaitMs: 60000,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const secretArgv = ["curl", "-H", `Authorization: Bearer ${SECRETS.bearer}`, `https://api.github.com/?token=${SECRETS.ghp}`];
  const secretCwd = `/workspace/${SECRETS.skLive}/build`;

  const record = await mgr.requestApproval({
    runId: "run-redact-argv-cwd",
    skeletonId: "skel-bone",
    argv: secretArgv,
    cwd: secretCwd,
  });

  // Stored record has redacted argv and cwd
  assert.ok(record.argv);
  assert.ok(!record.argv.some((a) => a.includes("token_super_secret_credentials_12345")));
  assert.ok(!record.argv.some((a) => a.includes(SECRETS.ghp)));
  assert.ok(record.argv.some((a) => a.includes("[REDACTED]")));

  assert.ok(record.cwd);
  assert.ok(!record.cwd.includes(SECRETS.skLive));
  assert.ok(record.cwd.includes("[REDACTED]"));

  // Emitted event has redacted argv and cwd
  const reqEvents = emittedEvents.filter((e) => e.kind === "approval.requested");
  assert.equal(reqEvents.length, 1);
  const evtArgv = reqEvents[0].data.argv as string[];
  const evtCwd = reqEvents[0].data.cwd as string;
  assert.ok(!evtArgv.some((a) => a.includes(SECRETS.ghp)));
  assert.ok(evtArgv.some((a) => a.includes("[REDACTED]")));
  assert.ok(!evtCwd.includes(SECRETS.skLive));
  assert.ok(evtCwd.includes("[REDACTED]"));

  // Resolve approval
  const approvedRecord = await mgr.resolveApproval(record.approvalId, { decision: "approved" });
  assert.ok(approvedRecord);
  assert.equal(approvedRecord.status, "approved");

  // Canonical raw argv and cwd can successfully consume the grant!
  const consumed = mgr.consumeGrant("skel-bone", secretArgv, secretCwd, record.approvalId);
  assert.equal(consumed, true, "consumeGrant must match canonical caller argv and cwd");

  // Second consume must return false
  const consumedAgain = mgr.consumeGrant("skel-bone", secretArgv, secretCwd, record.approvalId);
  assert.equal(consumedAgain, false);
});
