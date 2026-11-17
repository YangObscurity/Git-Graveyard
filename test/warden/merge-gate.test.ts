// Task 13.5: Unit tests for Warden candidate submission and merge gate
// Requirements: 9.12, 25.6, 25.7, 25.8 (Property 16: Merge gate)

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import {
  checkMergeGate,
  evaluateMergeGate,
  isMergeAllowed,
  checkMergeGateFromEvents,
} from "../../lib/warden/merge-gate";
import { buildVerdictRecord, computeCandidateSha256 } from "../../lib/warden/warden-review";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type { GateResultInput, MergeGateEventItem } from "../../lib/warden/types";
import { EventStore } from "../../lib/events/event-store";

function makeEventStore(items: MergeGateEventItem[], rId = "run-01"): any {
  const store = new EventStore(":memory:");
  for (const item of items) {
    store.append({
      runId: (item as any).runId ?? rId,
      kind: item.kind as any,
      actor: "system",
      taskId: item.taskId ?? null,
      data: item.data ?? {},
    });
  }
  return store;
}

describe("test/warden/merge-gate: checkMergeGate candidate evaluation (Requirements 25.6, 25.8)", () => {
  const candidateSha = "1234567890abcdef1234567890abcdef12345678";
  const candidateDiff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const candidateSha256 = candidateSha256FromDiff(candidateDiff);
  const tree = "tree-01";
  const taskId = "task-01";

  const validEvents = makeEventStore([
    {
      seq: 1,
      kind: "gate.result",
      taskId,
      data: { ok: true, tree, taskId },
    },
    {
      seq: 2,
      kind: "verdict",
      taskId,
      data: {
        verdict: "approve",
        candidateSha256,
        target: taskId,
        tree,
        taskId,
      },
    },
  ]);

  it("accepts candidate when verdict is approve, candidateSha256 matches, and gate passed", () => {
    const verdict = buildVerdictRecord(candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: candidateDiff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    const gateResult: GateResultInput = {
      ok: true,
      gate: "syntax",
      kind: "gate.result",
      tree,
    };

    const res = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      gateResult,
      events: validEvents,
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
    assert.equal(res.headUnchanged, true);
    assert.equal(res.reason, undefined);

    // Convenience functions
    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha,
        candidateSha256,
        diff: candidateDiff,
        tree,
        taskId,
        gateResult,
        events: validEvents,
        runId: "run-01",
      }),
      true
    );
    assert.equal(
      evaluateMergeGate({
        verdict,
        candidateSha,
        candidateSha256,
        diff: candidateDiff,
        tree,
        taskId,
        gateResult,
        events: validEvents,
        runId: "run-01",
      }).accepted,
      true
    );
  });

  it("rejects candidate when verdict is reject (Requirement 25.6)", () => {
    const verdict = buildVerdictRecord(candidateSha, {
      target: taskId,
      taskId,
      verdict: "reject",
      diff: candidateDiff,
      tree,
      reasons: [{ text: "Build failed", refs: ["cmd:build"] }],
    });

    const rejectEvents = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        seq: 2,
        kind: "verdict",
        taskId,
        data: {
          verdict: "reject",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
    ]);

    const gateResult: GateResultInput = { ok: true, tree };

    const res = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      gateResult,
      events: rejectEvents,
      runId: "run-01",
    });

    assert.equal(res.accepted, false);
    assert.equal(res.verdictApproved, false);
    assert.ok(res.reason?.includes("not 'approve'"));
    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha,
        candidateSha256,
        diff: candidateDiff,
        tree,
        taskId,
        gateResult,
        events: rejectEvents,
        runId: "run-01",
      }),
      false
    );
  });

  it("rejects candidate when candidateSha256 mismatch occurs (Requirement 25.8)", () => {
    const differentDiff = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+diff\n";
    const differentSha = "fedcba9876543210fedcba9876543210fedcba98";
    const verdict = buildVerdictRecord(differentSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: differentDiff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    const mismatchEvents = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        seq: 2,
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256: candidateSha256FromDiff(differentDiff),
          target: taskId,
          tree,
          taskId,
        },
      },
    ]);

    const gateResult: GateResultInput = { ok: true, tree };

    const res = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      gateResult,
      events: mismatchEvents,
      runId: "run-01",
    });

    assert.equal(res.accepted, false);
    assert.equal(res.candidateShaMatches, false);
    assert.ok(res.reason?.includes("candidateSha256 does not match"));
  });

  it("rejects candidate when Grimoire syntax gate failed or missing (Requirement 25.7)", () => {
    const verdict = buildVerdictRecord(candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: candidateDiff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    // Failing gate
    const failEvents = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: false, tree, taskId },
      },
      {
        seq: 2,
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
    ]);

    const failRes = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      gateResult: { ok: false, tree },
      events: failEvents,
      runId: "run-01",
    });
    assert.equal(failRes.accepted, false);
    assert.equal(failRes.gatePassed, false);
    assert.ok(failRes.reason?.includes("syntax gate failed"));

    // Missing gate
    const missingRes = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      gateResult: undefined,
      events: validEvents,
      runId: "run-01",
    });
    assert.equal(missingRes.accepted, false);
    assert.equal(missingRes.gatePassed, false);
  });

  it("rejects candidate when Integration_Head moved during review (Requirement 25.8)", () => {
    const verdict = buildVerdictRecord(candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: candidateDiff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    const res = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      gateResult: { ok: true, tree },
      events: validEvents,
      runId: "run-01",
      expectedHeadSha: "head-sha-v1",
      currentHeadSha: "head-sha-v2",
    });

    assert.equal(res.accepted, false);
    assert.equal(res.headUnchanged, false);
    assert.ok(res.reason?.includes("Integration_Head moved"));
  });

  it("refuses an empty taskId (Requirement 25.6, 25.7)", () => {
    const verdict = buildVerdictRecord(candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: candidateDiff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    const gateResult: GateResultInput = { ok: true, tree };

    const res = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId: "   ",
      gateResult,
      events: validEvents,
      runId: "run-01",
    });

    assert.equal(res.accepted, false);
    assert.ok(res.reasons?.some((r) => r.includes("empty taskId is refused")));
  });

  it("does not fall back to a caller or verdict hash when diff is missing (Requirement 25.8)", () => {
    const verdict = buildVerdictRecord(candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      candidateSha256,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    const gateResult: GateResultInput = { ok: true, tree };

    const res = checkMergeGate({
      verdict,
      candidateSha,
      candidateSha256,
      tree,
      taskId,
      gateResult,
      events: validEvents,
      runId: "run-01",
    });

    assert.equal(res.accepted, false);
    assert.equal(res.candidateShaMatches, false);
    assert.ok(res.reasons?.some((r) => r.includes("Candidate diff is missing")));
  });
});

describe("test/warden/merge-gate: EventStore precedence check (Requirement 25.7)", () => {
  const candidateSha = "1234567890abcdef1234567890abcdef12345678";
  const candidateDiff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const candidateSha256 = candidateSha256FromDiff(candidateDiff);
  const tree = "tree-01";
  const taskId = "task-01";

  it("passes when approve verdict and passing gate.result precede task.state merged event", () => {
    const events = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        seq: 2,
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
      {
        seq: 3,
        kind: "task.state",
        taskId,
        data: { state: "merged", taskId },
      },
    ]);

    const res = checkMergeGateFromEvents(events, {
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      runId: "run-01",
    });

    assert.equal(res.ok, true);
    assert.equal(res.verdictApproved, true);
    assert.equal(res.gatePassed, true);
    assert.equal(res.eventsPreceded, true);
    assert.deepEqual(res.reasons, []);
  });

  it("fails when approve verdict event does not precede task.state merged event", () => {
    const events = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        seq: 2,
        kind: "task.state",
        taskId,
        data: { state: "merged", taskId },
      },
      {
        seq: 3,
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
    ]);

    const res = checkMergeGateFromEvents(events, {
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      runId: "run-01",
    });

    assert.equal(res.ok, false);
    assert.equal(res.eventsPreceded, false);
    assert.ok(res.reasons.some((r) => r.includes("does not precede task.state merged")));
  });

  it("fails when approve verdict event is completely missing from EventStore", () => {
    const events = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        seq: 2,
        kind: "task.state",
        taskId,
        data: { state: "merged", taskId },
      },
    ]);

    const res = checkMergeGateFromEvents(events, {
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      runId: "run-01",
    });

    assert.equal(res.ok, false);
    assert.equal(res.verdictApproved, false);
    assert.ok(res.reasons.some((r) => r.includes("Missing preceding 'approve' verdict")));
  });

  it("fails when gate.result event is completely missing from EventStore", () => {
    const events = makeEventStore([
      {
        seq: 1,
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
      {
        seq: 2,
        kind: "task.state",
        taskId,
        data: { state: "merged", taskId },
      },
    ]);

    const res = checkMergeGateFromEvents(events, {
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      runId: "run-01",
    });

    assert.equal(res.ok, false);
    assert.equal(res.gatePassed, false);
    assert.ok(res.reasons.some((r) => r.includes("Missing preceding 'gate.result'")));
  });

  it("a later reject or failed gate invalidates an earlier approve (Requirement 25.7)", () => {
    // 1. Later reject invalidates earlier approve
    const eventsWithLaterReject = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        seq: 2,
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
      {
        seq: 3,
        kind: "verdict",
        taskId,
        data: {
          verdict: "reject",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
      {
        seq: 4,
        kind: "task.state",
        taskId,
        data: { state: "merged", taskId },
      },
    ]);

    const resReject = checkMergeGateFromEvents(eventsWithLaterReject, {
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      runId: "run-01",
    });

    assert.equal(resReject.ok, false);
    assert.equal(resReject.verdictApproved, false);

    // 2. Later failed gate invalidates earlier passing gate
    const eventsWithLaterFailedGate = makeEventStore([
      {
        seq: 1,
        kind: "gate.result",
        taskId,
        data: { ok: true, tree, taskId },
      },
      {
        seq: 2,
        kind: "gate.result",
        taskId,
        data: { ok: false, tree, taskId },
      },
      {
        seq: 3,
        kind: "verdict",
        taskId,
        data: {
          verdict: "approve",
          candidateSha256,
          target: taskId,
          tree,
          taskId,
        },
      },
      {
        seq: 4,
        kind: "task.state",
        taskId,
        data: { state: "merged", taskId },
      },
    ]);

    const resGate = checkMergeGateFromEvents(eventsWithLaterFailedGate, {
      candidateSha,
      candidateSha256,
      diff: candidateDiff,
      tree,
      taskId,
      runId: "run-01",
    });

    assert.equal(resGate.ok, false);
    assert.equal(resGate.gatePassed, false);
  });
});

describe("test/warden/merge-gate: Fast-check property test for Merge gate (Property 16: P16) (Requirements 9.12, 25.6, 25.7, 25.8)", () => {
  it("Property 16.1: checkMergeGate accepts candidate if and only if approve, sha matches, gate passed, and head unchanged", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]{40}$/),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (commitSha, isApprove, shaMatches, gateOk, headUnchanged) => {
          const candidateDiff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${commitSha}\n`;
          const otherDiff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n+other\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);
          const verdictDiff = shaMatches ? candidateDiff : otherDiff;
          const verdictSha256 = shaMatches
            ? candidateSha256
            : candidateSha256FromDiff(otherDiff);

          const verdict = buildVerdictRecord(commitSha, {
            target: "task-01",
            taskId: "task-01",
            verdict: isApprove ? "approve" : "reject",
            candidateSha256: verdictSha256,
            diff: verdictDiff,
            tree: "tree-01",
            install: { ok: isApprove },
            build: { ok: isApprove },
            accept: { ok: isApprove },
            tests: { ok: isApprove },
          });

          const gateResult: GateResultInput = {
            ok: gateOk,
            gate: "syntax",
            tree: "tree-01",
          };

          const expectedHeadSha = "head-v1";
          const currentHeadSha = headUnchanged ? "head-v1" : "head-v2";

          const verdictEvents = makeEventStore([
            {
              seq: 1,
              kind: "gate.result",
              taskId: "task-01",
              data: { ok: gateOk, tree: "tree-01", taskId: "task-01" },
            },
            {
              seq: 2,
              kind: "verdict",
              taskId: "task-01",
              data: {
                verdict: isApprove ? "approve" : "reject",
                candidateSha256: verdictSha256,
                target: "task-01",
                tree: "tree-01",
                taskId: "task-01",
              },
            },
          ]);

          const res = checkMergeGate({
            verdict,
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: "tree-01",
            taskId: "task-01",
            gateResult,
            events: verdictEvents,
            runId: "run-01",
            expectedHeadSha,
            currentHeadSha,
          });

          const expectedAccept = isApprove && shaMatches && gateOk && headUnchanged;

          assert.equal(
            res.accepted,
            expectedAccept,
            `Expected accepted=${expectedAccept}, got ${res.accepted}; reasons: ${JSON.stringify(res.reasons)}`
          );
          assert.equal(res.ok, expectedAccept);
          assert.equal(res.merged, expectedAccept);

          if (!shaMatches) {
            assert.equal(res.candidateShaMatches, false);
          }
          if (!isApprove) {
            assert.equal(res.verdictApproved, false);
          }
          if (!gateOk) {
            assert.equal(res.gatePassed, false);
          }
          if (!headUnchanged) {
            assert.equal(res.headUnchanged, false);
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  it("Property 16.2: checkMergeGateFromEvents requires approve verdict and passing gate to precede merged event", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]{40}$/),
        fc.constantFrom(
          "correct-order",
          "verdict-after-merged",
          "gate-after-merged",
          "missing-verdict",
          "missing-gate",
          "reject-verdict"
        ),
        (commitSha, scenario) => {
          const candidateDiff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${commitSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);

          const events: MergeGateEventItem[] = [];
          let seq = 1;

          if (scenario === "correct-order") {
            events.push({ seq: seq++, kind: "gate.result", taskId: "task-01", data: { ok: true, tree: "tree-1", taskId: "task-01" } });
            events.push({ seq: seq++, kind: "verdict", taskId: "task-01", data: { verdict: "approve", candidateSha256, tree: "tree-1", target: "task-01" } });
            events.push({ seq: seq++, kind: "task.state", taskId: "task-01", data: { state: "merged", taskId: "task-01" } });
          } else if (scenario === "verdict-after-merged") {
            events.push({ seq: seq++, kind: "gate.result", taskId: "task-01", data: { ok: true, tree: "tree-1", taskId: "task-01" } });
            events.push({ seq: seq++, kind: "task.state", taskId: "task-01", data: { state: "merged", taskId: "task-01" } });
            events.push({ seq: seq++, kind: "verdict", taskId: "task-01", data: { verdict: "approve", candidateSha256, tree: "tree-1", target: "task-01" } });
          } else if (scenario === "gate-after-merged") {
            events.push({ seq: seq++, kind: "verdict", taskId: "task-01", data: { verdict: "approve", candidateSha256, tree: "tree-1", target: "task-01" } });
            events.push({ seq: seq++, kind: "task.state", taskId: "task-01", data: { state: "merged", taskId: "task-01" } });
            events.push({ seq: seq++, kind: "gate.result", taskId: "task-01", data: { ok: true, tree: "tree-1", taskId: "task-01" } });
          } else if (scenario === "missing-verdict") {
            events.push({ seq: seq++, kind: "gate.result", taskId: "task-01", data: { ok: true, tree: "tree-1", taskId: "task-01" } });
            events.push({ seq: seq++, kind: "task.state", taskId: "task-01", data: { state: "merged", taskId: "task-01" } });
          } else if (scenario === "missing-gate") {
            events.push({ seq: seq++, kind: "verdict", taskId: "task-01", data: { verdict: "approve", candidateSha256, tree: "tree-1", target: "task-01" } });
            events.push({ seq: seq++, kind: "task.state", taskId: "task-01", data: { state: "merged", taskId: "task-01" } });
          } else if (scenario === "reject-verdict") {
            events.push({ seq: seq++, kind: "gate.result", taskId: "task-01", data: { ok: true, tree: "tree-1", taskId: "task-01" } });
            events.push({ seq: seq++, kind: "verdict", taskId: "task-01", data: { verdict: "reject", candidateSha256, tree: "tree-1", target: "task-01" } });
            events.push({ seq: seq++, kind: "task.state", taskId: "task-01", data: { state: "merged", taskId: "task-01" } });
          }

          const store = makeEventStore(events);
          const res = checkMergeGateFromEvents(store, {
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: "tree-1",
            taskId: "task-01",
            runId: "run-01",
          });

          if (scenario === "correct-order") {
            assert.equal(res.ok, true);
            assert.equal(res.verdictApproved, true);
            assert.equal(res.gatePassed, true);
            assert.equal(res.eventsPreceded, true);
          } else {
            assert.equal(res.ok, false);
            assert.ok(res.reasons.length >= 1);
          }
        }
      ),
      { numRuns: 60 }
    );
  });
});
