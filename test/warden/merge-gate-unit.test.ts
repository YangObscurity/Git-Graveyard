// Unit and property tests for Merge Gate
// Requirements: 9.12, 25.6, 25.7, 25.8 (Property 16: Merge gate)

import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fc from "fast-check";

import {
  checkMergeGate,
  evaluateMergeGate,
  isMergeAllowed,
  checkMergeGateFromEvents,
} from "../../lib/warden/merge-gate";
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type { GateResultInput, WardenVerdictRecord, MergeGateEventItem } from "../../lib/warden/types";
import { EventStore } from "../../lib/events/event-store";

function createEventStore(events: MergeGateEventItem[], runId = "run-01"): EventStore {
  const store = new EventStore(":memory:");
  for (const ev of events) {
    const actor =
      ev.kind === "gate.result"
        ? "grimoire"
        : ev.kind === "verdict"
        ? "warden"
        : "orchestrator";
    store.append({
      runId,
      kind: ev.kind,
      actor,
      ...(ev.taskId ? { taskId: ev.taskId } : {}),
      data: (ev.data as any) ?? {},
    });
  }
  return store;
}

const sampleDiff = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
const sampleTree = "tree-alpha-01";
const sampleCandidateSha = "1234567890abcdef1234567890abcdef12345678";
const sampleTaskId = "task-01";

const validEvents: MergeGateEventItem[] = [
  {
    seq: 1,
    kind: "gate.result",
    taskId: sampleTaskId,
    data: { ok: true, tree: sampleTree, taskId: sampleTaskId },
  },
  {
    seq: 2,
    kind: "verdict",
    taskId: sampleTaskId,
    data: {
      verdict: "approve",
      candidateSha256: candidateSha256FromDiff(sampleDiff),
      target: sampleTaskId,
      tree: sampleTree,
      taskId: sampleTaskId,
    },
  },
];

test("Merge gate: accepts candidate when verdict is approve, candidateSha256 matches, and gate passed (Requirements 25.6, 25.7)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-01",
    verdict: "approve",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  const gateResult: GateResultInput = {
    ok: true,
    gate: "syntax",
    kind: "gate.result",
    tree: sampleTree,
    files: ["lib/foo.ts"],
    reasons: [],
  };

  const store = createEventStore(validEvents);

  const res = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: sampleTaskId,
    eventSource: store,
    candidateSha256,
    gateResult,
    runId: "run-01",
    expectedHeadSha: "head-sha-100",
    currentHeadSha: "head-sha-100",
  });

  assert.equal(res.accepted, true);
  assert.equal(res.ok, true);
  assert.equal(res.merged, true);
  assert.equal(res.verdictApproved, true);
  assert.equal(res.candidateShaMatches, true);
  assert.equal(res.gatePassed, true);
  assert.equal(res.treeMatches, true);
  assert.equal(res.headUnchanged, true);
  assert.equal(res.reason, undefined);

  // Convenience predicate
  assert.equal(isMergeAllowed({ verdict, candidateSha, diff: sampleDiff, tree: sampleTree, gateResult, taskId: sampleTaskId, eventSource: store, runId: "run-01" }), true);
});

test("Merge gate: rejects when verdict is reject (Requirement 25.6)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-01",
    verdict: "reject",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
    reasons: [{ text: "Failed build", refs: ["cmd:build"] }],
  });

  const rejectEvents: MergeGateEventItem[] = [
    {
      seq: 1,
      kind: "gate.result",
      taskId: sampleTaskId,
      data: { ok: true, tree: sampleTree, taskId: sampleTaskId },
    },
    {
      seq: 2,
      kind: "verdict",
      taskId: sampleTaskId,
      data: {
        verdict: "reject",
        candidateSha256,
        target: sampleTaskId,
        tree: sampleTree,
        taskId: sampleTaskId,
      },
    },
  ];

  const gateResult: GateResultInput = { ok: true, tree: sampleTree };
  const store = createEventStore(rejectEvents);

  const res = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: sampleTaskId,
    eventSource: store,
    candidateSha256,
    gateResult,
    runId: "run-01",
  });

  assert.equal(res.accepted, false);
  assert.equal(res.verdictApproved, false);
  assert.ok(res.reason?.includes("not 'approve'"));
  assert.equal(isMergeAllowed({ verdict, candidateSha, diff: sampleDiff, tree: sampleTree, gateResult, taskId: sampleTaskId, eventSource: store, runId: "run-01" }), false);
});

test("Merge gate: rejects when candidateSha256 differs (Requirement 25.8)", () => {
  const candidateSha = sampleCandidateSha;
  const differentDiff = "--- a/other\n+++ b/other\n@@ -1 +1 @@\n+other\n";

  // Verdict was generated for a different candidate diff
  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-01",
    verdict: "approve",
    diff: differentDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  const mismatchEvents: MergeGateEventItem[] = [
    {
      seq: 1,
      kind: "gate.result",
      taskId: sampleTaskId,
      data: { ok: true, tree: sampleTree, taskId: sampleTaskId },
    },
    {
      seq: 2,
      kind: "verdict",
      taskId: sampleTaskId,
      data: {
        verdict: "approve",
        candidateSha256: candidateSha256FromDiff(differentDiff),
        target: sampleTaskId,
        tree: sampleTree,
        taskId: sampleTaskId,
      },
    },
  ];

  const gateResult: GateResultInput = { ok: true, tree: sampleTree };
  const store = createEventStore(mismatchEvents);

  const res = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: sampleTaskId,
    eventSource: store,
    gateResult,
    runId: "run-01",
  });

  assert.equal(res.accepted, false);
  assert.equal(res.candidateShaMatches, false);
  assert.ok(res.reason?.includes("candidateSha256 does not match"));
});

test("Merge gate: rejects when Grimoire gate failed or missing (Requirement 25.7)", () => {
  const candidateSha = sampleCandidateSha;

  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-01",
    verdict: "approve",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  // 1. Gate result ok: false
  const failedGate: GateResultInput = {
    ok: false,
    gate: "syntax",
    tree: sampleTree,
    reasons: ["SyntaxError: Unexpected token at file:src/app.ts:15"],
  };

  const failedGateEvents: MergeGateEventItem[] = [
    {
      seq: 1,
      kind: "gate.result",
      taskId: sampleTaskId,
      data: { ok: false, tree: sampleTree, taskId: sampleTaskId },
    },
    {
      seq: 2,
      kind: "verdict",
      taskId: sampleTaskId,
      data: {
        verdict: "approve",
        candidateSha256: candidateSha256FromDiff(sampleDiff),
        target: sampleTaskId,
        tree: sampleTree,
        taskId: sampleTaskId,
      },
    },
  ];

  const store1 = createEventStore(failedGateEvents);
  const res1 = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: sampleTaskId,
    eventSource: store1,
    gateResult: failedGate,
    runId: "run-01",
  });
  assert.equal(res1.accepted, false);
  assert.equal(res1.gatePassed, false);
  assert.ok(res1.reason?.includes("syntax gate failed"));

  // 2. Gate result missing
  const store2 = createEventStore(validEvents);
  const res2 = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: sampleTaskId,
    eventSource: store2,
    gateResult: undefined,
    runId: "run-01",
  });
  assert.equal(res2.accepted, false);
  assert.equal(res2.gatePassed, false);
});

test("Merge gate: rejects when Integration_Head moved during review (Requirement 25.8)", () => {
  const candidateSha = sampleCandidateSha;

  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-01",
    verdict: "approve",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  const gateResult: GateResultInput = { ok: true, tree: sampleTree };
  const store = createEventStore(validEvents);

  const res = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: sampleTaskId,
    eventSource: store,
    gateResult,
    runId: "run-01",
    expectedHeadSha: "head-sha-v1",
    currentHeadSha: "head-sha-v2", // Integration_Head moved
  });

  assert.equal(res.accepted, false);
  assert.equal(res.headUnchanged, false);
  assert.ok(res.reason?.includes("Integration_Head moved during review"));
});

test("Rule (1) Candidate hash: caller-supplied hash in merge gate is only compared, never used as expected value", () => {
  const candidateSha = sampleCandidateSha;
  const fakeCallerSha256 = "1111111111111111111111111111111111111111111111111111111111111111";

  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-01",
    verdict: "approve",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  const res = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    candidateSha256: fakeCallerSha256, // Fake hash supplied by caller
    gateResult: { ok: true, tree: sampleTree },
  });

  assert.equal(res.accepted, false);
  assert.equal(res.candidateShaMatches, false);
  assert.ok(res.reasons?.some((r) => r.includes("Caller-supplied candidateSha256")));
});

test("Rule (2) No aliasing: verdict must not supply its own candidateSha as the value to compare against", () => {
  const verdict = buildVerdictRecord(sampleCandidateSha, {
    target: "task-01",
    verdict: "approve",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  // Caller omits candidateSha; verdict contains candidateSha
  const res = checkMergeGate({
    verdict,
    // candidateSha omitted!
    diff: sampleDiff,
    tree: sampleTree,
    gateResult: { ok: true, tree: sampleTree },
  });

  assert.equal(res.accepted, false);
  assert.equal(res.candidateShaMatches, false);
  assert.ok(res.reasons?.some((r) => r.includes("Candidate SHA is missing")));
});

test("Rule (3) Tree binding: missing tree on candidate, gateResult or verdict rejects", () => {
  const verdictWithoutTree = buildVerdictRecord(sampleCandidateSha, {
    target: "task-01",
    verdict: "approve",
    diff: sampleDiff,
    // tree omitted
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  const res = checkMergeGate({
    verdict: verdictWithoutTree,
    candidateSha: sampleCandidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    gateResult: { ok: true, tree: sampleTree },
  });

  assert.equal(res.accepted, false);
  assert.equal(res.treeMatches, false);
  assert.ok(res.reasons?.some((r) => r.includes("Verdict tree is missing")));
});

test("Rule (4) Event replay: only latest verdict and latest gate.result count; later reject invalidates earlier approve", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const events: MergeGateEventItem[] = [
    { kind: "gate.result", seq: 1, taskId: "task-1", data: { ok: true, tree: sampleTree } },
    {
      kind: "verdict",
      seq: 2,
      taskId: "task-1",
      data: { verdict: "approve", candidateSha256, tree: sampleTree, taskId: "task-1" },
    },
    // Later rejection arrives!
    {
      kind: "verdict",
      seq: 3,
      taskId: "task-1",
      data: { verdict: "reject", candidateSha256, tree: sampleTree, taskId: "task-1" },
    },
    { kind: "task.state", seq: 4, taskId: "task-1", data: { state: "merged", taskId: "task-1" } },
  ];

  const res = checkMergeGateFromEvents(events, {
    candidateSha,
    candidateSha256,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: "task-1",
  });

  assert.equal(res.ok, false);
  assert.equal(res.verdictApproved, false);
  assert.ok(res.reasons.some((r) => r.includes("Missing preceding 'approve' verdict")));
});

test("Rule (4) Event replay: later failed gate invalidates earlier passing gate", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const events: MergeGateEventItem[] = [
    { kind: "gate.result", seq: 1, taskId: "task-1", data: { ok: true, tree: sampleTree } },
    {
      kind: "verdict",
      seq: 2,
      taskId: "task-1",
      data: { verdict: "approve", candidateSha256, tree: sampleTree, taskId: "task-1" },
    },
    // Later failed gate arrives!
    { kind: "gate.result", seq: 3, taskId: "task-1", data: { ok: false, tree: sampleTree } },
    { kind: "task.state", seq: 4, taskId: "task-1", data: { state: "merged", taskId: "task-1" } },
  ];

  const res = checkMergeGateFromEvents(events, {
    candidateSha,
    candidateSha256,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: "task-1",
  });

  assert.equal(res.ok, false);
  assert.equal(res.gatePassed, false);
  assert.ok(res.reasons.some((r) => r.includes("Missing preceding 'gate.result' event with ok = true")));
});

test("Rule (4) Event replay: events without a taskId are ignored", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const events: MergeGateEventItem[] = [
    // Event without taskId!
    { kind: "gate.result", seq: 1, data: { ok: true, tree: sampleTree } },
    {
      kind: "verdict",
      seq: 2,
      taskId: "task-1",
      data: { verdict: "approve", candidateSha256, tree: sampleTree, taskId: "task-1" },
    },
    { kind: "task.state", seq: 3, taskId: "task-1", data: { state: "merged", taskId: "task-1" } },
  ];

  const res = checkMergeGateFromEvents(events, {
    candidateSha,
    candidateSha256,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: "task-1",
  });

  // Since gate.result event had no taskId, it was ignored -> missing gate.result
  assert.equal(res.ok, false);
  assert.equal(res.gatePassed, false);
  assert.ok(res.reasons.some((r) => r.includes("Missing preceding 'gate.result' event")));
});

test("Rule (6) No backfill: checkMergeGate does not take a gateResult from the event stream when caller did not pass one", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-1",
    verdict: "approve",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });

  // Events contain passing gate result
  const events: MergeGateEventItem[] = [
    { kind: "gate.result", seq: 1, taskId: "task-1", data: { ok: true, tree: sampleTree } },
    {
      kind: "verdict",
      seq: 2,
      taskId: "task-1",
      data: { verdict: "approve", candidateSha256, tree: sampleTree, taskId: "task-1" },
    },
    { kind: "task.state", seq: 3, taskId: "task-1", data: { state: "merged", taskId: "task-1" } },
  ];

  const store = createEventStore(events);

  // Caller did NOT pass gateResult
  const res = checkMergeGate({
    verdict,
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: "task-1",
    // gateResult is NOT passed
    eventSource: store,
  });

  assert.equal(res.accepted, false);
  assert.equal(res.gatePassed, false);
  assert.ok(res.reasons?.some((r) => r.includes("Grimoire syntax gate failed or missing")));
});

test("Merge gate: checkMergeGateFromEvents validates event sequence (Requirement 25.7)", () => {
  const candidateSha = "c0ffee0123456789c0ffee0123456789c0ffee01";
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  // 1. Valid event sequence: verdict and gate.result precede task.state merged
  const validEvents = [
    { kind: "gate.result", seq: 1, taskId: "task-1", data: { ok: true, tree: sampleTree } },
    {
      kind: "verdict",
      seq: 2,
      taskId: "task-1",
      data: { verdict: "approve", candidateSha256, tree: sampleTree, target: "task-1" },
    },
    { kind: "task.state", seq: 3, taskId: "task-1", data: { state: "merged", taskId: "task-1" } },
  ];

  const resValid = checkMergeGateFromEvents(validEvents, {
    candidateSha,
    candidateSha256,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: "task-1",
  });
  assert.equal(resValid.ok, true);
  assert.equal(resValid.verdictApproved, true);
  assert.equal(resValid.gatePassed, true);
  assert.equal(resValid.eventsPreceded, true);

  // 2. Invalid event sequence: merged event before verdict
  const invalidEvents = [
    { kind: "gate.result", seq: 1, taskId: "task-1", data: { ok: true, tree: sampleTree } },
    { kind: "task.state", seq: 2, taskId: "task-1", data: { state: "merged", taskId: "task-1" } },
    {
      kind: "verdict",
      seq: 3,
      taskId: "task-1",
      data: { verdict: "approve", candidateSha256, tree: sampleTree, target: "task-1" },
    },
  ];

  const resInvalid = checkMergeGateFromEvents(invalidEvents, {
    candidateSha,
    candidateSha256,
    diff: sampleDiff,
    tree: sampleTree,
    taskId: "task-1",
  });
  assert.equal(resInvalid.ok, false);
  assert.equal(resInvalid.eventsPreceded, false);
  assert.ok(
    resInvalid.reasons.some((r) => r.includes("Approve verdict event does not precede"))
  );
});

test("Property 16: Merge gate invariant (Requirements 9.12, 25.6, 25.7, 25.8)", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[0-9a-f]{40}$/),
      fc.stringMatching(/^[a-z0-9_-]{4,20}$/),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (
        candidateSha: string,
        diffWord: string,
        verdictIsApprove: boolean,
        shaMatches: boolean,
        gateOk: boolean,
        treeMatches: boolean,
        verdictTreeMatches: boolean
      ) => {
        const candidateDiff = `diff --git a/${diffWord} b/${diffWord}\n+${diffWord}\n`;
        const otherDiff = `diff --git a/other b/other\n+other-${diffWord}\n`;

        const verdictDiff = shaMatches ? candidateDiff : otherDiff;
        const candidateTree = "tree-alpha";
        const gateTree = treeMatches ? "tree-alpha" : "tree-beta";
        const vTree = verdictTreeMatches ? "tree-alpha" : "tree-gamma";

        const verdict: WardenVerdictRecord = buildVerdictRecord(candidateSha, {
          verdict: verdictIsApprove ? "approve" : "reject",
          diff: verdictDiff,
          tree: vTree,
          install: { ok: true },
          build: { ok: true },
          accept: { ok: verdictIsApprove },
          tests: { ok: true },
          reasons: verdictIsApprove
            ? [{ text: "Checks pass", refs: ["cmd:ok"] }]
            : [{ text: "Checks fail", refs: ["cmd:fail"] }],
        });

        const gateResult: GateResultInput = { ok: gateOk, tree: gateTree };

        const store = new EventStore(":memory:");
        store.append({
          runId: "run-p16",
          kind: "gate.result",
          actor: "grimoire",
          taskId: "task-01",
          data: { ok: gateOk, tree: gateTree, taskId: "task-01" },
        });
        store.append({
          runId: "run-p16",
          kind: "verdict",
          actor: "warden",
          taskId: "task-01",
          data: {
            verdict: verdictIsApprove ? "approve" : "reject",
            candidateSha256: candidateSha256FromDiff(verdictDiff),
            target: "task-01",
            tree: vTree,
            taskId: "task-01",
          },
        });

        const result = checkMergeGate({
          verdict,
          candidateSha,
          diff: candidateDiff,
          tree: candidateTree,
          taskId: "task-01",
          eventSource: store,
          gateResult,
          runId: "run-p16",
        });

        const shouldAccept =
          verdictIsApprove &&
          shaMatches &&
          gateOk &&
          treeMatches &&
          verdictTreeMatches;

        assert.equal(
          result.accepted,
          shouldAccept,
          `Expected accepted=${shouldAccept} for verdictApprove=${verdictIsApprove}, shaMatch=${shaMatches}, gateOk=${gateOk}, treeMatch=${treeMatches}, vTreeMatch=${verdictTreeMatches}`
        );

        if (!shouldAccept) {
          assert.equal(result.accepted, false);
          assert.ok(result.reason !== undefined);
        } else {
          assert.equal(result.accepted, true);
          assert.equal(result.verdictApproved, true);
          assert.equal(result.candidateShaMatches, true);
          assert.equal(result.gatePassed, true);
          assert.equal(result.treeMatches, true);
        }
        store.close();
      }
    ),
    { numRuns: 100 }
  );
});
