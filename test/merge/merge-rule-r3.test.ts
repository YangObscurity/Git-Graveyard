// test/merge/merge-rule-r3.test.ts
// Unit tests for Finding M-11 event replay in Merge Rule
// Requirements: 9.12, 25.6, 25.7, 25.8

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  mergeRule,
  checkMergeRule,
  evaluateMergeRule,
  isMergeAllowed,
  canMerge,
} from "../../lib/merge/merge-rule";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type { TaskInput, VerdictInput, GateResultInput } from "../../lib/merge/types";
import { EventStore } from "../../lib/events/event-store";
import type { MergeGateEventItem } from "../../lib/warden/types";

describe("Merge Rule R3: Event Replay (Finding M-11)", () => {
  const commitSha = "1234567890abcdef1234567890abcdef12345678";
  const diffText = "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const diffSha256 = candidateSha256FromDiff(diffText);
  const tree = "tree-alpha-01";
  const taskId = "task-rule-r3-01";

  function createValidEvents(tId = taskId, tTree = tree, hash = diffSha256): any {
    const store = new EventStore(":memory:");
    const runId = "run-r3-test";
    store.append({
      runId,
      kind: "gate.result",
      actor: "grimoire",
      taskId: tId,
      data: { ok: true, tree: tTree, taskId: tId },
    });
    store.append({
      runId,
      kind: "verdict",
      actor: "warden",
      taskId: tId,
      data: {
        verdict: "approve",
        candidateSha256: hash,
        target: tId,
        tree: tTree,
        taskId: tId,
      },
    });
    return store;
  }

  function makeEventStore(
    items: { kind: string; taskId?: string; data?: Record<string, unknown> }[],
    rId = "run-r3-test"
  ): EventStore {
    const store = new EventStore(":memory:");
    for (const item of items) {
      store.append({
        runId: rId,
        kind: item.kind as any,
        actor: item.kind === "verdict" ? "warden" : item.kind === "gate.result" ? "grimoire" : "system",
        taskId: item.taskId ?? null,
        data: item.data ?? {},
      });
    }
    return store;
  }

  const validTask: TaskInput = {
    id: taskId,
    runId: "run-r3-test",
    candidateSha: commitSha,
    diff: diffText,
    tree,
  };

  const validVerdict: VerdictInput = {
    verdict: "approve",
    target: taskId,
    candidateSha256: diffSha256,
    tree,
  };

  const validGateResult: GateResultInput = {
    ok: true,
    gate: "syntax",
    kind: "gate.result",
    tree,
  };

  it("mergeRule rejects when no event source is available (Finding M-11)", () => {
    // Calling mergeRule with task, verdict, gateResult but no events/eventStore
    const res = mergeRule(validTask, validVerdict, validGateResult);

    assert.equal(res.merged, false);
    assert.equal(res.status, "not_merged");
    assert.equal(res.ok, false);
    assert.equal(res.accepted, false);
    assert.ok(
      res.reasons.some((r) => r.includes("No event source available"))
    );

    // isMergeAllowed and canMerge return false
    assert.equal(isMergeAllowed(validTask, validVerdict, validGateResult), false);
    assert.equal(canMerge(validTask, validVerdict, validGateResult), false);
  });

  it("mergeRule accepts when valid event source is passed via options (Finding M-11)", () => {
    const events = createValidEvents();

    const res = mergeRule({
      runId: "run-r3-test",
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree,
      taskId,
      events,
    });

    assert.equal(res.merged, true);
    assert.equal(res.status, "merged");
    assert.equal(res.ok, true);
    assert.equal(res.accepted, true);
    assert.equal(res.verdictApproved, true);
    assert.equal(res.candidateShaMatches, true);
    assert.equal(res.gatePassed, true);
    assert.equal(res.treeMatches, true);
    assert.equal(res.headUnchanged, true);

    // Aliases
    assert.equal(
      isMergeAllowed({
        runId: "run-r3-test",
        task: validTask,
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        tree,
        taskId,
        events,
      }),
      true
    );
    assert.equal(
      checkMergeRule({
        runId: "run-r3-test",
        task: validTask,
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        tree,
        taskId,
        events,
      }).merged,
      true
    );
    assert.equal(
      evaluateMergeRule({
        runId: "run-r3-test",
        task: validTask,
        verdict: validVerdict,
        gateResult: validGateResult,
        diff: diffText,
        candidateSha: commitSha,
        tree,
        taskId,
        events,
      }).merged,
      true
    );
  });

  it("mergeRule rejects when event replay finds missing approve verdict (Finding M-11)", () => {
    const eventsWithoutVerdict = makeEventStore([
      {
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
    ]);

    const res = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree,
      taskId,
      events: eventsWithoutVerdict,
    });

    assert.equal(res.merged, false);
    assert.ok(
      res.reasons.some((r) => r.includes("Missing preceding 'approve' verdict"))
    );
  });

  it("mergeRule rejects when event replay finds missing gate.result (Finding M-11)", () => {
    const eventsWithoutGate = makeEventStore([
      {
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256: diffSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
    ]);

    const res = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree,
      taskId,
      events: eventsWithoutGate,
    });

    assert.equal(res.merged, false);
    assert.ok(
      res.reasons.some((r) => r.includes("Missing preceding 'gate.result'"))
    );
  });

  it("mergeRule rejects when approve verdict does not precede task.state merged (Finding M-11)", () => {
    const eventsWrongOrder = makeEventStore([
      {
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        kind: "task.state",
        taskId,
        data: { state: "merged", taskId },
      },
      {
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256: diffSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
    ]);

    const res = mergeRule({
      runId: "run-r3-test",
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree,
      taskId,
      events: eventsWrongOrder,
    });

    assert.equal(res.merged, false);
    assert.ok(
      res.reasons.some((r) => r.includes("does not precede task.state merged"))
    );
  });

  it("mergeRule accepts when eventStore instance is passed (Finding M-11)", () => {
    const store = new EventStore(":memory:");
    const runId = "run-rule-test";

    store.append({
      runId,
      kind: "gate.result",
      actor: "grimoire",
      taskId,
      data: { ok: true, tree, taskId },
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
        tree,
        taskId,
      },
    });

    const res = mergeRule({
      task: validTask,
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree,
      taskId,
      eventStore: store,
      runId,
    });

    assert.equal(res.merged, true);
    assert.equal(res.status, "merged");
  });

  it("mergeRule rejects when taskId or diff is missing (Finding M-12)", () => {
    const events = createValidEvents();

    // Missing taskId
    const resNoTask = mergeRule({
      verdict: validVerdict,
      gateResult: validGateResult,
      diff: diffText,
      candidateSha: commitSha,
      tree,
      events,
    });
    assert.equal(resNoTask.merged, false);
    assert.ok(
      resNoTask.reasons.some((r) => r.includes("Task ID is missing") || r.includes("taskId must be a non-empty string"))
    );

    // Missing diff
    const resNoDiff = mergeRule({
      task: { id: taskId, candidateSha: commitSha, tree },
      verdict: validVerdict,
      gateResult: validGateResult,
      candidateSha: commitSha,
      tree,
      taskId,
      events,
    });
    assert.equal(resNoDiff.merged, false);
    assert.ok(
      resNoDiff.reasons.some((r) => r.includes("Candidate diff is missing"))
    );
  });
});
