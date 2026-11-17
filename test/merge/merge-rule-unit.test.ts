// Unit and property tests for Merge Rule (Task 13.4)
// Requirements: 9.12, 25.6, 25.7, 25.8

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

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

function makeEventStore(items: any[], rId = "run-01"): any {
  const store = new EventStore(":memory:");
  for (const item of items) {
    store.append({
      runId: item.runId ?? rId,
      kind: item.kind,
      actor: item.actor ?? (item.kind === "verdict" ? "warden" : item.kind === "gate.result" ? "grimoire" : "system"),
      taskId: item.taskId ?? null,
      data: item.data ?? {},
    });
  }
  return store;
}

const sampleDiff = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
const sampleTree = "tree-alpha-01";
const sampleCandidateSha = "1234567890abcdef1234567890abcdef12345678";
const sampleTaskId = "task-01";
const validEvents = makeEventStore([
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
]);

test("Merge rule: accepts candidate when verdict is approve, candidateSha256 matches recomputed diff, and gate result is ok (Requirements 25.6, 25.7)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const task: TaskInput = {
    id: "task-01",
    runId: "run-01",
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
    events: validEvents,
  };

  const verdict: VerdictInput = {
    verdict: "approve",
    target: "task-01",
    candidateSha256,
    tree: sampleTree,
  };

  const gateResult: GateResultInput = {
    ok: true,
    gate: "syntax",
    kind: "gate.result",
    tree: sampleTree,
  };

  const res = mergeRule(task, verdict, gateResult);

  assert.equal(res.merged, true);
  assert.equal(res.status, "merged");
  assert.equal(res.ok, true);
  assert.equal(res.accepted, true);
  assert.equal(res.verdictApproved, true);
  assert.equal(res.candidateShaMatches, true);
  assert.equal(res.gatePassed, true);
  assert.equal(res.treeMatches, true);
  assert.equal(res.reason, undefined);
  assert.deepEqual(res.reasons, []);

  // Check aliases and helper functions
  assert.equal(isMergeAllowed(task, verdict, gateResult), true);
  assert.equal(canMerge(task, verdict, gateResult), true);
  assert.equal(checkMergeRule(task, verdict, gateResult).merged, true);
  assert.equal(evaluateMergeRule(task, verdict, gateResult).merged, true);
});

test("Merge rule: accepts candidate when tree matches between task, verdict, and gateResult", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const task: TaskInput = {
    id: "task-01",
    runId: "run-01",
    candidateSha,
    diff: sampleDiff,
    tree: "tree-abc-123",
    events: makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId: "task-01",
        data: { ok: true, tree: "tree-abc-123", taskId: "task-01" },
      },
      {
        seq: 2,
        kind: "verdict",
        taskId: "task-01",
        data: {
          verdict: "approve",
          candidateSha256,
          target: "task-01",
          tree: "tree-abc-123",
          taskId: "task-01",
        },
      },
    ]),
  };

  const verdict: VerdictInput = {
    verdict: "approve",
    target: "task-01",
    candidateSha256,
    tree: "tree-abc-123",
  };

  const gateResult: GateResultInput = {
    ok: true,
    tree: "tree-abc-123",
  };

  const res = mergeRule(task, verdict, gateResult);

  assert.equal(res.merged, true);
  assert.equal(res.status, "merged");
  assert.equal(res.treeMatches, true);
  assert.equal(res.reason, undefined);
});

test("Merge rule: rejects when gate result is for a different tree (Requirement 9.12, 25.7)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const task: TaskInput = {
    id: "task-01",
    candidateSha,
    diff: sampleDiff,
    tree: "tree-candidate-sha",
  };

  const verdict: VerdictInput = {
    verdict: "approve",
    candidateSha256,
    tree: "tree-candidate-sha",
  };

  const gateResult: GateResultInput = {
    ok: true,
    tree: "tree-different-sha",
  };

  const res = mergeRule(task, verdict, gateResult);

  assert.equal(res.merged, false);
  assert.equal(res.status, "not_merged");
  assert.equal(res.treeMatches, false);
  assert.ok(res.reason?.includes("tree"));
  assert.equal(isMergeAllowed(task, verdict, gateResult), false);
});

test("Merge rule: rejects when verdict is reject (Requirement 25.6)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const task: TaskInput = {
    id: "task-01",
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
  };

  const verdict: VerdictInput = {
    verdict: "reject",
    target: "task-01",
    candidateSha256,
    tree: sampleTree,
    reasons: [{ text: "Tests failed on Integration_Head", refs: ["cmd:test"] }],
  };

  const gateResult: GateResultInput = { ok: true, tree: sampleTree };

  const res = mergeRule(task, verdict, gateResult);

  assert.equal(res.merged, false);
  assert.equal(res.status, "not_merged");
  assert.equal(res.verdictApproved, false);
  assert.ok(res.reason?.includes("not 'approve'"));
  assert.equal(isMergeAllowed(task, verdict, gateResult), false);
});

test("Merge rule: rejects when verdict candidateSha256 does not match candidate (Requirement 25.8)", () => {
  const candidateSha = sampleCandidateSha;
  const differentDiff = "--- a/other\n+++ b/other\n@@ -1 +1 @@\n+other\n";

  const task: TaskInput = {
    id: "task-01",
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
  };

  const verdict: VerdictInput = {
    verdict: "approve",
    target: "task-01",
    candidateSha256: candidateSha256FromDiff(differentDiff),
    tree: sampleTree,
  };

  const gateResult: GateResultInput = { ok: true, tree: sampleTree };

  const res = mergeRule(task, verdict, gateResult);

  assert.equal(res.merged, false);
  assert.equal(res.status, "not_merged");
  assert.equal(res.candidateShaMatches, false);
  assert.ok(res.reason?.includes("candidateSha256 does not match"));
});

test("Merge rule: rejects when Grimoire gate result is ok: false (Requirement 9.12, 25.7)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const task: TaskInput = {
    id: "task-01",
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
  };

  const verdict: VerdictInput = {
    verdict: "approve",
    candidateSha256,
    tree: sampleTree,
  };

  const gateResult: GateResultInput = {
    ok: false,
    tree: sampleTree,
    reasons: ["Syntax error at line 42"],
  };

  const res = mergeRule(task, verdict, gateResult);

  assert.equal(res.merged, false);
  assert.equal(res.status, "not_merged");
  assert.equal(res.gatePassed, false);
  assert.ok(res.reason?.includes("gate result is not ok"));
});

test("Merge rule: rejects when gate result is missing (Requirement 9.12)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const task: TaskInput = {
    id: "task-01",
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
  };

  const verdict: VerdictInput = {
    verdict: "approve",
    candidateSha256,
    tree: sampleTree,
  };

  const res = mergeRule(task, verdict, undefined);

  assert.equal(res.merged, false);
  assert.equal(res.gatePassed, false);
  assert.ok(res.reason?.includes("gate result is missing"));
});

test("Merge rule: rejects when verdict is missing (Requirement 25.6)", () => {
  const candidateSha = sampleCandidateSha;

  const task: TaskInput = {
    id: "task-01",
    candidateSha,
    diff: sampleDiff,
    tree: sampleTree,
  };

  const gateResult: GateResultInput = { ok: true, tree: sampleTree };

  const res = mergeRule(task, undefined, gateResult);

  assert.equal(res.merged, false);
  assert.equal(res.verdictApproved, false);
  assert.ok(res.reason?.includes("Verdict is missing"));
});

test("Merge rule: accepts when invoked with an options object", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const res = mergeRule({
    runId: "run-01",
    task: { id: "T1", runId: "run-01", candidateSha, diff: sampleDiff, tree: sampleTree },
    verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
    gateResult: { ok: true, tree: sampleTree },
    events: makeEventStore([
      { seq: 1, kind: "gate.result", taskId: "T1", data: { ok: true, tree: sampleTree, taskId: "T1" } },
      { seq: 2, kind: "verdict", taskId: "T1", data: { verdict: "approve", candidateSha256, target: "T1", tree: sampleTree, taskId: "T1" } },
    ]),
  });

  assert.equal(res.merged, true);
  assert.equal(res.status, "merged");
  assert.equal(res.ok, true);
});

test("Merge rule: rejects when Integration_Head moved during review (Requirement 25.8)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const res = mergeRule({
    task: { id: "T1", candidateSha, diff: sampleDiff, tree: sampleTree },
    verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
    gateResult: { ok: true, tree: sampleTree },
    expectedHeadSha: "head-sha-v1",
    currentHeadSha: "head-sha-v2",
  });

  assert.equal(res.merged, false);
  assert.equal(res.headUnchanged, false);
  assert.ok(res.reason?.includes("Integration_Head moved"));
});

test("Rule (1) Candidate hash: caller-supplied hash is only compared, never used as expected value", () => {
  const candidateSha = sampleCandidateSha;
  const realSha256 = candidateSha256FromDiff(sampleDiff);
  const fakeCallerSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  // Caller attempts to supply fakeCallerSha256 in options
  const res = mergeRule({
    task: { id: "T1", candidateSha, diff: sampleDiff, tree: sampleTree },
    candidateSha256: fakeCallerSha256,
    verdict: { verdict: "approve", candidateSha256: fakeCallerSha256, tree: sampleTree },
    gateResult: { ok: true, tree: sampleTree },
  });

  assert.equal(res.merged, false);
  assert.equal(res.candidateShaMatches, false);
  assert.ok(res.reasons.some((r) => r.includes("Caller-supplied candidateSha256")));
});

test("Rule (2) No aliasing: missing candidateSha is rejected", () => {
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const res = mergeRule({
    task: { id: "T1", diff: sampleDiff, tree: sampleTree }, // no candidateSha
    verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
    gateResult: { ok: true, tree: sampleTree },
  });

  assert.equal(res.merged, false);
  assert.equal(res.candidateShaMatches, false);
  assert.ok(res.reasons.some((r) => r.includes("Candidate SHA is missing")));
});

test("Rule (2) No aliasing: taskId must never be used as candidateSha", () => {
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  // Passing a string task "task-99" must not treat "task-99" as candidateSha
  const res = mergeRule(
    "task-99",
    { verdict: "approve", candidateSha256, tree: sampleTree },
    { ok: true, tree: sampleTree }
  );

  assert.equal(res.merged, false);
  assert.equal(res.candidateShaMatches, false);
  assert.ok(res.reasons.some((r) => r.includes("Candidate SHA is missing")));
});

test("Rule (3) Tree binding: missing candidate tree is rejected", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const res = mergeRule({
    task: { id: "T1", candidateSha, diff: sampleDiff }, // tree missing
    verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
    gateResult: { ok: true, tree: sampleTree },
  });

  assert.equal(res.merged, false);
  assert.equal(res.treeMatches, false);
  assert.ok(res.reasons.some((r) => r.includes("Candidate tree is missing")));
});

test("Rule (3) Tree binding: missing gate result tree is rejected", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const res = mergeRule({
    task: { id: "T1", candidateSha, diff: sampleDiff, tree: sampleTree },
    verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
    gateResult: { ok: true }, // gate tree missing
  });

  assert.equal(res.merged, false);
  assert.equal(res.treeMatches, false);
  assert.ok(res.reasons.some((r) => r.includes("Gate result tree is missing")));
});

test("Rule (3) Tree binding: missing verdict tree is rejected", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const res = mergeRule({
    task: { id: "T1", candidateSha, diff: sampleDiff, tree: sampleTree },
    verdict: { verdict: "approve", candidateSha256 }, // verdict tree missing
    gateResult: { ok: true, tree: sampleTree },
  });

  assert.equal(res.merged, false);
  assert.equal(res.treeMatches, false);
  assert.ok(res.reasons.some((r) => r.includes("Verdict tree is missing")));
});

test("Rule (3) Tree binding: head comparison fails closed when one side is missing", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const res = mergeRule({
    task: { id: "T1", candidateSha, diff: sampleDiff, tree: sampleTree },
    verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
    gateResult: { ok: true, tree: sampleTree },
    expectedHeadSha: "head-sha-v1",
    // currentHeadSha missing
  });

  assert.equal(res.merged, false);
  assert.equal(res.headUnchanged, false);
  assert.ok(res.reasons.some((r) => r.includes("head SHA missing")));
});

test("Property test: Merge rule invariant (Requirements 9.12, 25.6, 25.7, 25.8)", () => {
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
        diffBody: string,
        verdictIsApprove: boolean,
        shaMatches: boolean,
        gateOk: boolean,
        treeMatches: boolean,
        verdictTreeMatches: boolean
      ) => {
        const candidateDiff = `diff --git a/${diffBody} b/${diffBody}\n+${diffBody}\n`;
        const otherDiff = `diff --git a/other b/other\n+other-${diffBody}\n`;

        const candidateSha256 = candidateSha256FromDiff(candidateDiff);
        const verdictDiff = shaMatches ? candidateDiff : otherDiff;
        const verdictSha256 = candidateSha256FromDiff(verdictDiff);

        const candidateTree = "tree-alpha";
        const gateTree = treeMatches ? "tree-alpha" : "tree-beta";
        const vTree = verdictTreeMatches ? "tree-alpha" : "tree-gamma";

        const events = makeEventStore([
          { seq: 1, kind: "gate.result", taskId: "T-PROP", data: { ok: gateOk, tree: gateTree, taskId: "T-PROP" } },
          { seq: 2, kind: "verdict", taskId: "T-PROP", data: { verdict: verdictIsApprove ? "approve" : "reject", candidateSha256: verdictSha256, target: "T-PROP", tree: vTree, taskId: "T-PROP" } },
        ]);

        const task: TaskInput = {
          id: "T-PROP",
          runId: "run-01",
          candidateSha,
          diff: candidateDiff,
          tree: candidateTree,
          events,
        };

        const verdict: VerdictInput = {
          verdict: verdictIsApprove ? "approve" : "reject",
          candidateSha256: verdictSha256,
          tree: vTree,
        };

        const gateResult: GateResultInput = {
          ok: gateOk,
          tree: gateTree,
        };

        const res = mergeRule(task, verdict, gateResult);

        const expectedShaMatch = shaMatches;
        const expectedTreeMatch = treeMatches && verdictTreeMatches;

        const shouldMerge =
          verdictIsApprove && expectedShaMatch && gateOk && expectedTreeMatch;

        assert.equal(
          res.merged,
          shouldMerge,
          `Expected merged=${shouldMerge} for verdictApprove=${verdictIsApprove}, shaMatches=${expectedShaMatch}, gateOk=${gateOk}, treeMatches=${expectedTreeMatch}`
        );

        if (!shouldMerge) {
          assert.equal(res.status, "not_merged");
          assert.equal(res.ok, false);
          assert.ok(res.reason !== undefined);
          assert.ok(res.reasons.length > 0);
        } else {
          assert.equal(res.status, "merged");
          assert.equal(res.ok, true);
          assert.equal(res.reason, undefined);
          assert.equal(res.reasons.length, 0);
        }
      }
    ),
    { numRuns: 100 }
  );
});
