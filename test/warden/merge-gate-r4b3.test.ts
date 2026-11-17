// test/warden/merge-gate-r4b3.test.ts
// Unit tests for R4-B3d: Merge gate event replay from EventStore (audit M-11, N-2)
// Requirements: 9.12, 25.6, 25.7, 25.8

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  checkMergeGate,
  evaluateMergeGate,
  isMergeAllowed,
} from "../../lib/warden/merge-gate";
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type { GateResultInput } from "../../lib/warden/types";
import { EventStore } from "../../lib/events/event-store";

describe("Merge Gate R4-B3: EventStore replay and strict source enforcement (M-11, N-2)", () => {
  const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
  const diffText = "--- a/lib/test.ts\n+++ b/lib/test.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const diffSha256 = candidateSha256FromDiff(diffText);
  const taskTree = "tree-r4b3-01";
  const taskId = "task-r4b3-01";
  const runId = "run-r4b3-01";

  const validGateResult: GateResultInput = {
    ok: true,
    gate: "syntax",
    kind: "gate.result",
    tree: taskTree,
  };

  function createValidVerdict() {
    return buildVerdictRecord(commitSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: diffText,
      tree: taskTree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });
  }

  function createValidStore(): EventStore {
    const store = new EventStore(":memory:");
    store.append({
      runId,
      kind: "gate.result",
      actor: "grimoire",
      taskId,
      data: { ok: true, tree: taskTree, taskId },
    });
    store.append({
      runId,
      kind: "verdict",
      actor: "warden",
      taskId,
      data: {
        verdict: "approve",
        candidateSha256: diffSha256,
        target: taskId,
        tree: taskTree,
        taskId,
      },
    });
    return store;
  }

  it("an array as eventSource is refused with the EventStore reason", () => {
    // 1. Array as eventSource standalone
    const resStandalone = checkMergeGate({
      eventSource: [],
    });
    assert.equal(resStandalone.accepted, false);
    assert.equal(resStandalone.ok, false);
    assert.equal(resStandalone.eventsPreceded, false);
    assert.equal(resStandalone.reason, "event source must be an EventStore");
    assert.ok(resStandalone.reasons?.includes("event source must be an EventStore"));

    // 2. Array as eventSource with all other parameters valid
    const verdict = createValidVerdict();
    const resWithOpts = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      diff: diffText,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      gateResult: validGateResult,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
      eventSource: [
        {
          seq: 1,
          kind: "gate.result",
          taskId,
          data: { ok: true, tree: taskTree, taskId },
        },
        {
          seq: 2,
          kind: "verdict",
          taskId,
          data: {
            verdict: "approve",
            candidateSha256: diffSha256,
            target: taskId,
            tree: taskTree,
            taskId,
          },
        },
      ],
    });

    assert.equal(resWithOpts.accepted, false);
    assert.equal(resWithOpts.ok, false);
    assert.equal(resWithOpts.eventsPreceded, false);
    assert.equal(resWithOpts.reason, "event source must be an EventStore");
    assert.ok(resWithOpts.reasons?.includes("event source must be an EventStore"));
    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        diff: diffText,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        gateResult: validGateResult,
        eventSource: [],
      }),
      false
    );

    // 3. Array under events
    const resEventsArray = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree: taskTree,
      taskId,
      gateResult: validGateResult,
      events: [] as any,
    });
    assert.equal(resEventsArray.accepted, false);
    assert.equal(resEventsArray.ok, false);
    assert.equal(resEventsArray.eventsPreceded, false);
    assert.equal(resEventsArray.reason, "event source must be an EventStore");

    // 4. Array under task.events
    const resTaskEventsArray = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree: taskTree,
      taskId,
      gateResult: validGateResult,
      task: { id: taskId, events: [] as any },
    });
    assert.equal(resTaskEventsArray.accepted, false);
    assert.equal(resTaskEventsArray.reason, "event source must be an EventStore");
  });

  it("a plain object is refused", () => {
    // 1. Plain object as eventSource standalone
    const resStandalone = checkMergeGate({
      eventSource: {},
    });
    assert.equal(resStandalone.accepted, false);
    assert.equal(resStandalone.ok, false);
    assert.equal(resStandalone.eventsPreceded, false);
    assert.equal(resStandalone.reason, "event source must be an EventStore");
    assert.ok(resStandalone.reasons?.includes("event source must be an EventStore"));

    // 2. Plain object mock as eventStore with all other parameters valid
    const verdict = createValidVerdict();
    const resMockStore = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      diff: diffText,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      gateResult: validGateResult,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
      eventStore: {
        getEvents: () => [],
        getRunIds: () => ["run-1"],
      } as any,
    });

    assert.equal(resMockStore.accepted, false);
    assert.equal(resMockStore.ok, false);
    assert.equal(resMockStore.eventsPreceded, false);
    assert.equal(resMockStore.reason, "event source must be an EventStore");
    assert.ok(resMockStore.reasons?.includes("event source must be an EventStore"));

    // 3. Plain object under task.eventSource
    const resTaskObj = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree: taskTree,
      taskId,
      gateResult: validGateResult,
      task: { id: taskId, eventSource: { foo: "bar" } as any },
    });
    assert.equal(resTaskObj.accepted, false);
    assert.equal(resTaskObj.reason, "event source must be an EventStore");
  });

  it("an EventStore holding a passing verdict and a passing gate.result with the task tree allows the check", () => {
    const store = createValidStore();
    const verdict = createValidVerdict();

    const res = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      diff: diffText,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      gateResult: validGateResult,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
      eventSource: store,
      runId,
    });

    assert.equal(res.accepted, true);
    assert.equal(res.ok, true);
    assert.equal(res.merged, true);
    assert.equal(res.eventsPreceded, true);
    assert.equal(res.verdictApproved, true);
    assert.equal(res.gatePassed, true);
    assert.equal(res.candidateShaMatches, true);
    assert.equal(res.treeMatches, true);
    assert.equal(res.headUnchanged, true);
    assert.equal(res.reason, undefined);

    // evaluateMergeGate and isMergeAllowed behave identically
    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        diff: diffText,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        gateResult: validGateResult,
        eventSource: store,
        runId,
      }),
      true
    );

    const evalRes = evaluateMergeGate({
      verdict,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      diff: diffText,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      gateResult: validGateResult,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
      eventStore: store,
      runId,
    });
    assert.equal(evalRes.accepted, true);
    assert.equal(evalRes.ok, true);
    assert.equal(evalRes.eventsPreceded, true);

    store.close();
  });

  it("no event source keeps the No event source available reason", () => {
    const verdict = createValidVerdict();

    const resNoEvents = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      diff: diffText,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      gateResult: validGateResult,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
    });

    assert.equal(resNoEvents.accepted, false);
    assert.equal(resNoEvents.ok, false);
    assert.equal(resNoEvents.eventsPreceded, false);
    assert.ok(
      resNoEvents.reasons?.some((r) => r.includes("No event source available"))
    );
    assert.ok(resNoEvents.reason?.includes("No event source available"));

    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        diff: diffText,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        gateResult: validGateResult,
      }),
      false
    );
  });
});
