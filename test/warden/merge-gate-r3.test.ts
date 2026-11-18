// test/warden/merge-gate-r3.test.ts
// Unit tests for Finding M-11 and M-12 fixes in Merge Gate
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
import type { GateResultInput, MergeGateEventItem } from "../../lib/warden/types";
import { EventStore } from "../../lib/events/event-store";

describe("Merge Gate R3: Findings M-11 and M-12", () => {
  const commitSha = "1234567890abcdef1234567890abcdef12345678";
  const diffText = "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const diffSha256 = candidateSha256FromDiff(diffText);
  const tree = "tree-alpha-01";
  const taskId = "task-r3-01";

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

  function createValidVerdict(tId = taskId, tTree = tree, diff = diffText) {
    return buildVerdictRecord(commitSha, {
      target: tId,
      taskId: tId,
      verdict: "approve",
      diff,
      tree: tTree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });
  }

  const validGateResult: GateResultInput = {
    ok: true,
    gate: "syntax",
    kind: "gate.result",
    tree,
  };

  it("missing taskId rejects with a finding (Finding M-12)", () => {
    const verdict = createValidVerdict();
    const events = createValidEvents();

    // 1. undefined taskId
    const resUndefined = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree,
      gateResult: validGateResult,
      events,
    });

    assert.equal(resUndefined.accepted, false);
    assert.equal(resUndefined.ok, false);
    assert.ok(
      resUndefined.reasons?.some((r) => r.includes("Task ID is missing") || r.includes("taskId must be a non-empty string"))
    );
    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha: commitSha,
        diff: diffText,
        tree,
        gateResult: validGateResult,
        events,
      }),
      false
    );

    // 2. empty string taskId
    const resEmpty = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree,
      taskId: "",
      gateResult: validGateResult,
      events,
    });
    assert.equal(resEmpty.accepted, false);
    assert.ok(
      resEmpty.reasons?.some((r) => r.includes("empty taskId is refused"))
    );

    // 3. whitespace-only taskId
    const resWhitespace = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree,
      taskId: "   \t  ",
      gateResult: validGateResult,
      events,
    });
    assert.equal(resWhitespace.accepted, false);
    assert.ok(
      resWhitespace.reasons?.some((r) => r.includes("empty taskId is refused"))
    );

    // 4. task object with missing or empty id
    const resTaskEmpty = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree,
      task: { id: "   " },
      gateResult: validGateResult,
      events,
    });
    assert.equal(resTaskEmpty.accepted, false);
    assert.ok(
      resTaskEmpty.reasons?.some((r) => r.includes("empty taskId is refused"))
    );
  });

  it("missing diff rejects and cannot recompute candidateSha256 (Finding M-12)", () => {
    const verdict = createValidVerdict();
    const events = createValidEvents();

    const resMissingDiff = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      tree,
      taskId,
      gateResult: validGateResult,
      events,
    });

    assert.equal(resMissingDiff.accepted, false);
    assert.equal(resMissingDiff.candidateShaMatches, false);
    assert.ok(
      resMissingDiff.reasons?.some((r) => r.includes("Candidate diff is missing"))
    );

    // Empty string diff
    const resEmptyDiff = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: "",
      tree,
      taskId,
      gateResult: validGateResult,
      events,
    });
    assert.equal(resEmptyDiff.accepted, false);
    assert.equal(resEmptyDiff.candidateShaMatches, false);
    assert.ok(
      resEmptyDiff.reasons?.some((r) => r.includes("Candidate diff is missing"))
    );
  });

  it("caller-supplied hash is not used as a fallback when diff is missing (Finding M-12)", () => {
    const verdict = createValidVerdict();
    const events = createValidEvents();

    // Caller provides candidateSha256 and expectedCandidateSha256, but diff is omitted
    const res = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      candidateSha256: diffSha256,
      expectedCandidateSha256: diffSha256,
      tree,
      taskId,
      gateResult: validGateResult,
      events,
    });

    assert.equal(res.accepted, false);
    assert.equal(res.candidateShaMatches, false);
    assert.ok(
      res.reasons?.some((r) => r.includes("Candidate diff is missing"))
    );
    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha: commitSha,
        candidateSha256: diffSha256,
        expectedCandidateSha256: diffSha256,
        tree,
        taskId,
        gateResult: validGateResult,
        events,
      }),
      false
    );
  });

  it("no event source rejects the merge gate check (Finding M-11)", () => {
    const verdict = createValidVerdict();

    // All parameters valid, but no event source (no events, no eventStore)
    const resNoEvents = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree,
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

    // evaluateMergeGate alias behaves identically
    const evalRes = evaluateMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree,
      taskId,
      gateResult: validGateResult,
    });
    assert.equal(evalRes.accepted, false);

    // isMergeAllowed returns false
    assert.equal(
      isMergeAllowed({
        verdict,
        candidateSha: commitSha,
        diff: diffText,
        tree,
        taskId,
        gateResult: validGateResult,
      }),
      false
    );
  });

  it("replays events from EventStore when eventStore instance is passed (Finding M-11)", () => {
    const store = new EventStore(":memory:");
    const runId = "run-r3-test";

    // Append gate.result then approve verdict
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

    const verdict = createValidVerdict();

    const res = checkMergeGate({
      verdict,
      candidateSha: commitSha,
      diff: diffText,
      tree,
      taskId,
      gateResult: validGateResult,
      eventStore: store,
      runId,
    });

    assert.equal(res.accepted, true);
    assert.equal(res.ok, true);
    assert.equal(res.eventsPreceded, true);
  });
});
