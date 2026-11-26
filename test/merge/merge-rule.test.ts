// Task 13.4 / 13.5: Unit and property tests for Merge Rule and candidateSha256 mismatch
// Requirements: 9.12, 25.6, 25.7, 25.8 (Property 16: Merge gate)

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import defaultMergeRule, {
  mergeRule,
  checkMergeRule,
  evaluateMergeRule,
  isMergeAllowed,
  canMerge,
  computeCandidateSha256,
  isCandidateShaMatching,
  isGateResultPassing,
} from "../../lib/merge/merge-rule";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type {
  GateResultInput,
  MergeRuleOptions,
  TaskInput,
  VerdictInput,
} from "../../lib/merge/types";
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

describe("test/merge: Merge rule acceptance (Requirements 25.6, 25.7)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  it("accepts candidate when verdict is approve, candidateSha256 matches, and gate passed (Requirement 25.6)", () => {
    const task: TaskInput = {
      id: "task-01",
      runId: "run-01",
      candidateSha,
      diff: sampleDiff,
      candidateSha256,
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
    assert.equal(res.headUnchanged, true);
    assert.equal(res.reason, undefined);
    assert.deepEqual(res.reasons, []);

    // Check aliases and helper functions
    assert.equal(isMergeAllowed(task, verdict, gateResult), true);
    assert.equal(canMerge(task, verdict, gateResult), true);
    assert.equal(checkMergeRule(task, verdict, gateResult).merged, true);
    assert.equal(evaluateMergeRule(task, verdict, gateResult).merged, true);
    assert.equal(defaultMergeRule(task, verdict, gateResult).merged, true);
  });

  it("accepts candidate when invoked with unified options object", () => {
    const opts: MergeRuleOptions = {
      runId: "run-01",
      task: { id: "task-01", runId: "run-01", candidateSha, diff: sampleDiff, tree: sampleTree },
      candidateSha,
      candidateSha256,
      diff: sampleDiff,
      tree: sampleTree,
      verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
      gateResult: { ok: true, tree: sampleTree },
      events: validEvents,
      expectedHeadSha: "head-sha-v1",
      currentHeadSha: "head-sha-v1",
    };

    const res = mergeRule(opts);
    assert.equal(res.merged, true);
    assert.equal(res.status, "merged");
  });

  it("accepts candidate when candidate diff is hashed automatically", () => {
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
      candidateSha256,
      tree: sampleTree,
    };

    const res = mergeRule(task, verdict, { ok: true, tree: sampleTree });
    assert.equal(res.merged, true);
    assert.equal(res.candidateShaMatches, true);
  });

  it("accepts candidate when matching tree is provided in task and gateResult", () => {
    const matchingTreeEvents = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId: "task-01",
        data: { ok: true, tree: "tree-sha-abc-123", taskId: "task-01" },
      },
      {
        seq: 2,
        kind: "verdict",
        taskId: "task-01",
        data: {
          verdict: "approve",
          candidateSha256,
          target: "task-01",
          tree: "tree-sha-abc-123",
          taskId: "task-01",
        },
      },
    ]);

    const task: TaskInput = {
      id: "task-01",
      runId: "run-01",
      candidateSha,
      diff: sampleDiff,
      candidateSha256,
      tree: "tree-sha-abc-123",
      events: matchingTreeEvents,
    };

    const verdict: VerdictInput = {
      verdict: "approve",
      candidateSha256,
      tree: "tree-sha-abc-123",
    };

    const gateResult: GateResultInput = {
      ok: true,
      tree: "tree-sha-abc-123",
    };

    const res = mergeRule(task, verdict, gateResult);
    assert.equal(res.merged, true);
    assert.equal(res.treeMatches, true);
  });
});

describe("test/merge: Candidate SHA-256 mismatch (Requirement 25.8)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  const differentSha = "fedcba9876543210fedcba9876543210fedcba98";
  const differentDiff = "--- a/other\n+++ b/other\n@@ -1 +1 @@\n+other\n";
  const differentSha256 = candidateSha256FromDiff(differentDiff);

  it("leaves task unmerged when verdict candidateSha256 differs from candidate sha256 (Requirement 25.8)", () => {
    const task: TaskInput = {
      id: "task-01",
      candidateSha,
      diff: sampleDiff,
      tree: sampleTree,
      candidateSha256,
    };

    const verdict: VerdictInput = {
      verdict: "approve",
      target: "task-01",
      candidateSha256: differentSha256,
      tree: sampleTree,
    };

    const gateResult: GateResultInput = { ok: true, tree: sampleTree };

    const res = mergeRule(task, verdict, gateResult);

    assert.equal(res.merged, false);
    assert.equal(res.status, "not_merged");
    assert.equal(res.ok, false);
    assert.equal(res.accepted, false);
    assert.equal(res.verdictApproved, true);
    assert.equal(res.candidateShaMatches, false);
    assert.ok(res.reason?.includes("candidateSha256 does not match candidate"));
    assert.equal(isMergeAllowed(task, verdict, gateResult), false);
  });

  it("leaves task unmerged when verdict names a different raw commit SHA (Requirement 25.8)", () => {
    const task: TaskInput = {
      id: "task-01",
      candidateSha,
      diff: sampleDiff,
      tree: sampleTree,
    };

    const verdict: VerdictInput = {
      verdict: "approve",
      candidateSha: differentSha,
      tree: sampleTree,
    };

    const res = mergeRule(task, verdict, { ok: true, tree: sampleTree });
    assert.equal(res.merged, false);
    assert.equal(res.candidateShaMatches, false);
    assert.ok(res.reasons.some((r) => r.includes("candidateSha256 does not match candidate")));
  });

  it("leaves task unmerged when candidateSha is empty or missing", () => {
    const task: TaskInput = {
      id: "task-01",
      diff: sampleDiff,
      tree: sampleTree,
    };

    const verdict: VerdictInput = {
      verdict: "approve",
      candidateSha256,
      tree: sampleTree,
    };

    const res = mergeRule(task, verdict, { ok: true, tree: sampleTree });
    assert.equal(res.merged, false);
    assert.equal(res.candidateShaMatches, false);
  });

  it("matches hex digests case-insensitively", () => {
    const upperSha256 = candidateSha256.toUpperCase();
    const task: TaskInput = {
      id: "task-01",
      runId: "run-01",
      candidateSha,
      diff: sampleDiff,
      tree: sampleTree,
      candidateSha256: upperSha256,
      events: validEvents,
    };

    const verdict: VerdictInput = {
      verdict: "approve",
      candidateSha256: candidateSha256.toLowerCase(),
      tree: sampleTree,
    };

    const res = mergeRule(task, verdict, { ok: true, tree: sampleTree });
    assert.equal(res.merged, true);
    assert.equal(res.candidateShaMatches, true);
  });

  it("helper isCandidateShaMatching correctly compares all variations", () => {
    assert.equal(isCandidateShaMatching(candidateSha256, candidateSha, candidateSha256), true);
    assert.equal(isCandidateShaMatching(candidateSha256.toUpperCase(), candidateSha, candidateSha256.toLowerCase()), true);
    assert.equal(isCandidateShaMatching(candidateSha256, candidateSha, candidateSha256, undefined, candidateSha256), true);

    assert.equal(isCandidateShaMatching(candidateSha256, differentSha, differentSha256), false);
    assert.equal(isCandidateShaMatching(candidateSha256, candidateSha, differentSha256), false);
    assert.equal(isCandidateShaMatching(undefined, undefined, undefined), false);
  });
});

describe("test/merge: Non-approve verdicts (Requirement 25.6)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  it("leaves task unmerged when verdict is reject (Requirement 25.6)", () => {
    const task: TaskInput = { id: "task-01", candidateSha, diff: sampleDiff, tree: sampleTree, candidateSha256 };
    const verdict: VerdictInput = {
      verdict: "reject",
      candidateSha256,
      tree: sampleTree,
      reasons: ["Build failed"],
    };

    const res = mergeRule(task, verdict, { ok: true, tree: sampleTree });
    assert.equal(res.merged, false);
    assert.equal(res.status, "not_merged");
    assert.equal(res.verdictApproved, false);
    assert.ok(res.reason?.includes("not 'approve'"));
  });

  it("leaves task unmerged when verdict is missing", () => {
    const task: TaskInput = { id: "task-01", candidateSha, diff: sampleDiff, tree: sampleTree, candidateSha256 };
    const res = mergeRule(task, undefined, { ok: true, tree: sampleTree });

    assert.equal(res.merged, false);
    assert.equal(res.verdictApproved, false);
    assert.ok(res.reason?.includes("Verdict is missing"));
  });

  it("leaves task unmerged when verdict has ok = false or approved = false", () => {
    const task: TaskInput = { id: "task-01", candidateSha, diff: sampleDiff, tree: sampleTree, candidateSha256 };
    const verdict: VerdictInput = {
      verdict: "approve",
      ok: false,
      candidateSha256,
      tree: sampleTree,
    };

    const res = mergeRule(task, verdict, { ok: true, tree: sampleTree });
    assert.equal(res.merged, false);
    assert.equal(res.verdictApproved, false);
  });
});

describe("test/merge: Grimoire syntax gate failures and tree mismatches (Requirements 9.12, 25.7)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);
  const verdict: VerdictInput = { verdict: "approve", candidateSha256, tree: sampleTree };

  it("leaves task unmerged when Grimoire gate result is missing (Requirement 9.12, 25.7)", () => {
    const task: TaskInput = { id: "task-01", candidateSha, diff: sampleDiff, tree: sampleTree, candidateSha256 };
    const res = mergeRule(task, verdict, undefined);

    assert.equal(res.merged, false);
    assert.equal(res.gatePassed, false);
    assert.ok(res.reason?.includes("Grimoire gate result is missing"));
  });

  it("leaves task unmerged when Grimoire gate result is not ok (Requirement 9.12, 25.7)", () => {
    const task: TaskInput = { id: "task-01", candidateSha, diff: sampleDiff, tree: sampleTree, candidateSha256 };
    const res = mergeRule(task, verdict, { ok: false, tree: sampleTree, reasons: ["Syntax error in patched file"] });

    assert.equal(res.merged, false);
    assert.equal(res.gatePassed, false);
    assert.ok(res.reason?.includes("Grimoire syntax gate result is not ok"));
  });

  it("leaves task unmerged when tree does not match between candidate and gate result (Requirement 9.12, 25.7)", () => {
    const task: TaskInput = {
      id: "task-01",
      candidateSha,
      diff: sampleDiff,
      candidateSha256,
      tree: "tree-candidate-sha",
    };

    const verdictWithTree: VerdictInput = {
      verdict: "approve",
      candidateSha256,
      tree: "tree-candidate-sha",
    };

    const gateResult: GateResultInput = {
      ok: true,
      tree: "tree-different-sha",
    };

    const res = mergeRule(task, verdictWithTree, gateResult);
    assert.equal(res.merged, false);
    assert.equal(res.treeMatches, false);
    assert.ok(res.reason?.includes("Gate result is for tree"));
  });

  it("helper isGateResultPassing inspects various formats", () => {
    assert.equal(isGateResultPassing(true), false);
    assert.equal(isGateResultPassing(false), false);
    assert.equal(isGateResultPassing({ ok: true }), true);
    assert.equal(isGateResultPassing({ ok: false }), false);
    assert.equal(isGateResultPassing({ passed: true } as any), false);
    assert.equal(isGateResultPassing({ passed: false } as any), false);
    assert.equal(isGateResultPassing({ status: "passed" } as any), false);
    assert.equal(isGateResultPassing({ status: "ok" } as any), false);
    assert.equal(isGateResultPassing({ status: "failed" } as any), false);
    assert.equal(isGateResultPassing(null), false);
    assert.equal(isGateResultPassing(undefined), false);
  });
});

describe("test/merge: Integration_Head movement during review (Requirement 25.8)", () => {
  const candidateSha = sampleCandidateSha;
  const candidateSha256 = candidateSha256FromDiff(sampleDiff);

  it("leaves task unmerged when Integration_Head moved during review (Requirement 25.8)", () => {
    const opts: MergeRuleOptions = {
      task: { id: "T1", candidateSha, diff: sampleDiff, tree: sampleTree },
      candidateSha,
      diff: sampleDiff,
      tree: sampleTree,
      candidateSha256,
      verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
      gateResult: { ok: true, tree: sampleTree },
      expectedHeadSha: "head-commit-aaa",
      currentHeadSha: "head-commit-bbb",
    };

    const res = mergeRule(opts);
    assert.equal(res.merged, false);
    assert.equal(res.headUnchanged, false);
    assert.ok(res.reason?.includes("Integration_Head moved during review"));
  });

  it("accepts task when Integration_Head is unchanged (Requirement 25.6, 25.8)", () => {
    const opts: MergeRuleOptions = {
      runId: "run-01",
      task: { id: "task-01", runId: "run-01", candidateSha, diff: sampleDiff, tree: sampleTree },
      candidateSha,
      diff: sampleDiff,
      tree: sampleTree,
      candidateSha256,
      verdict: { verdict: "approve", candidateSha256, tree: sampleTree },
      gateResult: { ok: true, tree: sampleTree },
      events: validEvents,
      expectedHeadSha: "head-commit-aaa",
      currentHeadSha: "head-commit-aaa",
    };

    const res = mergeRule(opts);
    assert.equal(res.merged, true);
    assert.equal(res.headUnchanged, true);
  });
});

describe("test/merge: Fast-check property test for merge rule", () => {
  it("merges if and only if verdict is approve, candidateSha matches, gate passed, tree matches, and head unchanged", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]{40}$/),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (commitSha, verdictApproved, shaMatches, gateOk, treeMatches, headUnchanged) => {
          const candidateDiff = `diff --git a/f b/f\n+${commitSha}\n`;
          const otherDiff = `diff --git a/f b/f\n+other-${commitSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);
          const verdictSha256 = shaMatches
            ? candidateSha256
            : candidateSha256FromDiff(otherDiff);

          const taskTree = "tree-alpha";
          const gateTree = treeMatches ? "tree-alpha" : "tree-beta";
          const verdictTree = treeMatches ? "tree-alpha" : "tree-gamma";

          const expectedHead = "head-sha-1";
          const currentHead = headUnchanged ? "head-sha-1" : "head-sha-2";

          const events = makeEventStore([
            {
              seq: 1,
              kind: "gate.result",
              taskId: "T1",
              data: { ok: gateOk, tree: gateTree, taskId: "T1" },
            },
            {
              seq: 2,
              kind: "verdict",
              taskId: "T1",
              data: {
                verdict: verdictApproved ? "approve" : "reject",
                candidateSha256: verdictSha256,
                target: "T1",
                tree: verdictTree,
                taskId: "T1",
              },
            },
          ]);

          const opts: MergeRuleOptions = {
            runId: "run-01",
            task: { id: "T1", runId: "run-01", candidateSha: commitSha, diff: candidateDiff, tree: taskTree },
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: taskTree,
            verdict: {
              verdict: verdictApproved ? "approve" : "reject",
              candidateSha256: verdictSha256,
              tree: verdictTree,
            },
            gateResult: {
              ok: gateOk,
              tree: gateTree,
            },
            events,
            expectedHeadSha: expectedHead,
            currentHeadSha: currentHead,
          };

          const res = mergeRule(opts);

          const expectedMerged =
            verdictApproved && shaMatches && gateOk && treeMatches && headUnchanged;

          assert.equal(
            res.merged,
            expectedMerged,
            `Merge expectation failed: expected ${expectedMerged}, got ${res.merged} with reasons: ${JSON.stringify(res.reasons)}`
          );

          if (!shaMatches) {
            assert.equal(
              res.candidateShaMatches,
              false,
              "When sha does not match, candidateShaMatches must be false"
            );
            assert.equal(res.merged, false, "Candidate SHA mismatch must never merge");
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property: tree mismatch between candidate and gate result always prevents merge (Requirement 9.12, 25.7)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9_-]{4,12}$/),
        fc.stringMatching(/^[a-z0-9_-]{4,12}$/),
        (treeA, treeB) => {
          const sha = "0123456789abcdef0123456789abcdef01234567";
          const diff = sampleDiff;
          const sha256 = candidateSha256FromDiff(diff);

          const treesMatch = treeA === treeB;

          const res = mergeRule({
            runId: "run-01",
            task: { id: "task-01", runId: "run-01", candidateSha: sha, diff, tree: treeA },
            candidateSha: sha,
            diff,
            tree: treeA,
            candidateSha256: sha256,
            verdict: { verdict: "approve", candidateSha256: sha256, tree: treeA },
            gateResult: { ok: true, tree: treeB },
            events: makeEventStore([
              { seq: 1, kind: "gate.result", taskId: "task-01", data: { ok: true, tree: treeB, taskId: "task-01" } },
              { seq: 2, kind: "verdict", taskId: "task-01", data: { verdict: "approve", candidateSha256: sha256, target: "task-01", tree: treeA, taskId: "task-01" } },
            ]),
          });

          if (treesMatch) {
            assert.equal(res.merged, true);
            assert.equal(res.treeMatches, true);
          } else {
            assert.equal(res.merged, false);
            assert.equal(res.treeMatches, false);
            assert.ok(res.reason?.includes("Gate result is for tree"));
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property: isCandidateShaMatching handles case-insensitivity and sha256 computation", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]{40}$/),
        fc.boolean(),
        (commitSha, uppercaseVerdict) => {
          const diff = `diff --git a/f b/f\n+${commitSha}\n`;
          const computed256 = candidateSha256FromDiff(diff);
          const verdict256 = uppercaseVerdict ? computed256.toUpperCase() : computed256;

          // Direct matching against commit SHA and sha256
          assert.equal(isCandidateShaMatching(verdict256, commitSha, computed256), true);
          assert.equal(isCandidateShaMatching(verdict256, commitSha.toUpperCase(), computed256), true);
          assert.equal(isCandidateShaMatching(verdict256, commitSha, computed256.toUpperCase()), true);

          // Mismatched SHA
          const invertedDiff = `diff --git a/f b/f\n+inverted-${commitSha}\n`;
          const inverted256 = candidateSha256FromDiff(invertedDiff);
          assert.equal(isCandidateShaMatching(inverted256, commitSha, computed256), false);
          assert.equal(isCandidateShaMatching(verdict256, "", computed256), false);
          assert.equal(isCandidateShaMatching(verdict256, commitSha, undefined), false);
          assert.equal(isCandidateShaMatching(undefined, commitSha, computed256), false);
        }
      ),
      { numRuns: 40 }
    );
  });
});
