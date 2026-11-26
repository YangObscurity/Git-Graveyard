// test/merge/merge-rule-r4b3.test.ts
// Unit tests for R4-B3e: Merge rule event replay from EventStore (audit M-11)
// Requirements: 9.12, 25.6, 25.7, 25.8

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  mergeRule,
  checkMergeRule,
  evaluateMergeRule,
  isMergeAllowed,
  canMerge,
  isGateResultPassing,
} from "../../lib/merge/merge-rule";
import { isGatePassing } from "../../lib/warden/merge-gate";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type { TaskInput, VerdictInput, GateResultInput } from "../../lib/merge/types";
import { EventStore } from "../../lib/events/event-store";

describe("Merge Rule R4-B3: EventStore replay and strict source enforcement (M-11)", () => {
  const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
  const diffText = "--- a/lib/test.ts\n+++ b/lib/test.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const diffSha256 = candidateSha256FromDiff(diffText);
  const taskTree = "tree-r4b3-01";
  const taskId = "task-r4b3-01";
  const runId = "run-r4b3-01";

  const validTask: TaskInput = {
    id: taskId,
    candidateSha: commitSha,
    diff: diffText,
    tree: taskTree,
  };

  const validVerdict: VerdictInput = {
    verdict: "approve",
    target: taskId,
    candidateSha256: diffSha256,
    tree: taskTree,
  };

  const validGateResult: GateResultInput = {
    ok: true,
    gate: "syntax",
    kind: "gate.result",
    tree: taskTree,
  };

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
    store.append({
      runId,
      kind: "task.state",
      actor: "system",
      taskId,
      data: { state: "merged", taskId },
    });
    return store;
  }

  it("an array is refused", () => {
    // 1. Array as eventSource standalone
    const resStandalone = mergeRule({
      eventSource: [] as any,
    });
    assert.equal(resStandalone.accepted, false);
    assert.equal(resStandalone.ok, false);
    assert.equal(resStandalone.merged, false);
    assert.equal((resStandalone as any).eventsPreceded, false);
    assert.equal(resStandalone.reason, "event source must be an EventStore");
    assert.ok(resStandalone.reasons?.includes("event source must be an EventStore"));

    // 2. Array as eventSource with all other parameters valid
    const resWithOpts = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
      eventSource: [
        {
          seq: 1,
          kind: "gate.result",
          taskId,
          data: { ok: true, tree: taskTree, taskId },
        },
      ] as any,
    });

    assert.equal(resWithOpts.accepted, false);
    assert.equal(resWithOpts.ok, false);
    assert.equal(resWithOpts.merged, false);
    assert.equal((resWithOpts as any).eventsPreceded, false);
    assert.equal(resWithOpts.reason, "event source must be an EventStore");
    assert.ok(resWithOpts.reasons?.includes("event source must be an EventStore"));
    assert.equal(
      isMergeAllowed({
        task: validTask,
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        tree: taskTree,
        taskId,
        eventSource: [] as any,
      }),
      false
    );

    // 3. Array under events
    const resEventsArray = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree: taskTree,
      taskId,
      events: [] as any,
    });
    assert.equal(resEventsArray.accepted, false);
    assert.equal(resEventsArray.ok, false);
    assert.equal(resEventsArray.merged, false);
    assert.equal((resEventsArray as any).eventsPreceded, false);
    assert.equal(resEventsArray.reason, "event source must be an EventStore");
    assert.ok(resEventsArray.reasons?.includes("event source must be an EventStore"));

    // 4. Array under task.events
    const resTaskEventsArray = mergeRule({
      task: { ...validTask, events: [] as any },
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree: taskTree,
      taskId,
    });
    assert.equal(resTaskEventsArray.accepted, false);
    assert.equal(resTaskEventsArray.ok, false);
    assert.equal(resTaskEventsArray.merged, false);
    assert.equal(resTaskEventsArray.reason, "event source must be an EventStore");

    // 5. Array under task in 3-argument call
    const resTask3Arg = mergeRule(
      { ...validTask, events: [] as any },
      validVerdict,
      validGateResult
    );
    assert.equal(resTask3Arg.accepted, false);
    assert.equal(resTask3Arg.ok, false);
    assert.equal(resTask3Arg.merged, false);
    assert.equal(resTask3Arg.reason, "event source must be an EventStore");
  });

  it("a plain object is refused", () => {
    // 1. Plain object as eventSource standalone
    const resStandalone = mergeRule({
      eventSource: {} as any,
    });
    assert.equal(resStandalone.accepted, false);
    assert.equal(resStandalone.ok, false);
    assert.equal(resStandalone.merged, false);
    assert.equal((resStandalone as any).eventsPreceded, false);
    assert.equal(resStandalone.reason, "event source must be an EventStore");
    assert.ok(resStandalone.reasons?.includes("event source must be an EventStore"));

    // 2. Plain object mock as eventStore with other parameters valid
    const resMockStore = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
      eventStore: {
        getEvents: () => [],
        getRunIds: () => ["run-1"],
      } as any,
    });

    assert.equal(resMockStore.accepted, false);
    assert.equal(resMockStore.ok, false);
    assert.equal(resMockStore.merged, false);
    assert.equal((resMockStore as any).eventsPreceded, false);
    assert.equal(resMockStore.reason, "event source must be an EventStore");
    assert.ok(resMockStore.reasons?.includes("event source must be an EventStore"));

    // 3. Plain object under task.eventSource
    const resTaskObj = mergeRule({
      task: { ...validTask, eventSource: { foo: "bar" } as any },
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree: taskTree,
      taskId,
    });
    assert.equal(resTaskObj.accepted, false);
    assert.equal(resTaskObj.ok, false);
    assert.equal(resTaskObj.merged, false);
    assert.equal(resTaskObj.reason, "event source must be an EventStore");

    // 4. Plain object under task.events
    const resTaskEventsObj = mergeRule({
      task: { ...validTask, events: { foo: "bar" } as any },
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree: taskTree,
      taskId,
    });
    assert.equal(resTaskEventsObj.accepted, false);
    assert.equal(resTaskEventsObj.ok, false);
    assert.equal(resTaskEventsObj.merged, false);
    assert.equal(resTaskEventsObj.reason, "event source must be an EventStore");
  });

  it("an EventStore holding an approve verdict, a passing gate.result and the task.state merged event is accepted when the rest matches", () => {
    const store = createValidStore();

    const res = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
      eventStore: store,
      runId,
    });

    assert.equal(res.accepted, true);
    assert.equal(res.ok, true);
    assert.equal(res.merged, true);
    assert.equal(res.status, "merged");
    assert.equal((res as any).eventsPreceded, true);
    assert.equal(res.verdictApproved, true);
    assert.equal(res.candidateShaMatches, true);
    assert.equal(res.gatePassed, true);
    assert.equal(res.treeMatches, true);
    assert.equal(res.headUnchanged, true);
    assert.equal(res.reason, undefined);
    assert.deepEqual(res.reasons, []);

    // Aliases and helpers
    assert.equal(
      isMergeAllowed({
        task: validTask,
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        eventStore: store,
        runId,
      }),
      true
    );
    assert.equal(
      canMerge({
        task: validTask,
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        eventStore: store,
        runId,
      }),
      true
    );

    const evalRes = evaluateMergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      eventStore: store,
      runId,
    });
    assert.equal(evalRes.accepted, true);
    assert.equal(evalRes.ok, true);
    assert.equal(evalRes.merged, true);
    assert.equal((evalRes as any).eventsPreceded, true);

    const checkRes = checkMergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      eventSource: store,
      runId,
    });
    assert.equal(checkRes.accepted, true);
    assert.equal(checkRes.ok, true);
    assert.equal(checkRes.merged, true);

    store.close();
  });

  it("no event source keeps the existing reason", () => {
    // 1. Calling mergeRule with task, verdict, gateResult but no event source
    const resNoEvents = mergeRule(validTask, validVerdict, validGateResult);

    assert.equal(resNoEvents.accepted, false);
    assert.equal(resNoEvents.ok, false);
    assert.equal(resNoEvents.merged, false);
    assert.equal((resNoEvents as any).eventsPreceded, false);
    assert.ok(
      resNoEvents.reasons?.some((r) => r.includes("No event source available"))
    );
    assert.ok(resNoEvents.reason?.includes("No event source available"));
    assert.equal(isMergeAllowed(validTask, validVerdict, validGateResult), false);
    assert.equal(canMerge(validTask, validVerdict, validGateResult), false);

    // 2. Calling mergeRule with options object without event source
    const resOptsNoEvents = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      tree: taskTree,
      gateTree: taskTree,
      taskId,
      expectedHeadSha: "head-1",
      currentHeadSha: "head-1",
    });

    assert.equal(resOptsNoEvents.accepted, false);
    assert.equal(resOptsNoEvents.ok, false);
    assert.equal(resOptsNoEvents.merged, false);
    assert.equal((resOptsNoEvents as any).eventsPreceded, false);
    assert.ok(
      resOptsNoEvents.reasons?.some((r) => r.includes("No event source available"))
    );
    assert.ok(resOptsNoEvents.reason?.includes("No event source available"));
  });

  describe("Merge Rule R3A3: strict gateResult boolean rejection, bare string verdict rejection, checks enforcement, and EventStore runId requirement", () => {
    it("isGatePassing rejects boolean and non-plain-object values", () => {
      assert.equal(isGatePassing(true as any), false);
      assert.equal(isGatePassing(false as any), false);
      assert.equal(isGatePassing(null as any), false);
      assert.equal(isGatePassing(undefined as any), false);
      assert.equal(isGatePassing([] as any), false);
      assert.equal(isGatePassing({ ok: true }), true);
      assert.equal(isGatePassing({ ok: false }), false);
      assert.equal(isGatePassing({ passed: true } as any), false);
      assert.equal(isGatePassing({ status: "passed" } as any), false);
    });

    it("isGateResultPassing rejects boolean and non-plain-object values", () => {
      assert.equal(isGateResultPassing(true as any), false);
      assert.equal(isGateResultPassing(false as any), false);
      assert.equal(isGateResultPassing(null as any), false);
      assert.equal(isGateResultPassing(undefined as any), false);
      assert.equal(isGateResultPassing([] as any), false);
      assert.equal(isGateResultPassing({ ok: true }), true);
      assert.equal(isGateResultPassing({ ok: false }), false);
      assert.equal(isGateResultPassing({ passed: true } as any), false);
      assert.equal(isGateResultPassing({ status: "passed" } as any), false);
    });

    it("mergeRule rejects bare string 'approve' in positional arguments form", () => {
      const store = createValidStore();
      const res = mergeRule(
        { ...validTask, runId, events: store },
        "approve" as any,
        validGateResult
      );
      assert.equal(res.merged, false);
      assert.equal(res.verdictApproved, false);
      assert.ok(
        res.reasons.includes(
          "Verdict must be a structured verdict object, not a bare string"
        )
      );
      assert.equal(
        res.reason,
        "Verdict must be a structured verdict object, not a bare string"
      );
      store.close();
    });

    it("mergeRule rejects bare string 'approve' in options form", () => {
      const store = createValidStore();
      const res = mergeRule({
        task: validTask,
        verdict: "approve" as any,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        eventStore: store,
        runId,
      });
      assert.equal(res.merged, false);
      assert.equal(res.verdictApproved, false);
      assert.ok(
        res.reasons.includes(
          "Verdict must be a structured verdict object, not a bare string"
        )
      );
      store.close();
    });

    it("mergeRule rejects when EventStore replay is used without explicit non-empty runId", () => {
      const store = createValidStore();
      // 1. runId omitted
      const resNoRunId = mergeRule({
        task: { id: taskId, candidateSha: commitSha, diff: diffText, tree: taskTree },
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        eventStore: store,
      });
      assert.equal(resNoRunId.merged, false);
      assert.ok(
        resNoRunId.reasons.includes(
          "EventStore replay requires an explicit non-empty runId"
        )
      );

      // 2. empty string runId
      const resEmptyRunId = mergeRule({
        task: validTask,
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        eventStore: store,
        runId: "   ",
      });
      assert.equal(resEmptyRunId.merged, false);
      assert.ok(
        resEmptyRunId.reasons.includes(
          "EventStore replay requires an explicit non-empty runId"
        )
      );

      store.close();
    });

    it("mergeRule enforces isCheckPassing on verdict.checks when checks is defined", () => {
      const store = createValidStore();

      // Failing install check
      const verdictWithFailingCheck = {
        ...validVerdict,
        checks: {
          install: { ok: false },
          build: { ok: true },
          accept: { ok: true },
          tests: { ok: true },
        },
      };

      const res = mergeRule({
        task: validTask,
        verdict: verdictWithFailingCheck,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        eventStore: store,
        runId,
      });

      assert.equal(res.merged, false);
      assert.equal(res.verdictApproved, false);
      assert.ok(
        res.reasons.some((r) =>
          r.includes("Warden verdict check 'install' is not passing (Requirement 24.5)")
        )
      );

      // Passing checks
      const verdictWithPassingChecks = {
        ...validVerdict,
        checks: {
          install: { ok: true },
          build: { ok: true },
          accept: { ok: true },
          tests: { ok: true },
        },
      };

      const resPass = mergeRule({
        task: validTask,
        verdict: verdictWithPassingChecks,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        tree: taskTree,
        gateTree: taskTree,
        taskId,
        eventStore: store,
        runId,
      });

      assert.equal(resPass.merged, true);
      assert.equal(resPass.verdictApproved, true);

      store.close();
    });
  });
});
