import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after, before, describe, it } from "node:test";

import { Scheduler } from "../../lib/scheduler/scheduler";
import { GitService, VerifiedMerge, isVerifiedMerge } from "../../lib/git/git-service";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import { EventStore } from "../../lib/events/event-store";
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import { checkMergeGate, checkMergeGateFromEvents } from "../../lib/warden/merge-gate";
import type { PactRole, PactTask } from "../../lib/pact/pact-parser";

function runGitCmd(gitDir: string, args: string[]): string {
  return childProcess
    .execFileSync("git", args, { cwd: gitDir, encoding: "utf8" })
    .trim();
}

function makePactTask(
  id: string,
  deps: string[] = [],
  role: PactRole = "soul-stitcher",
  hard = false,
  line = 1
): PactTask {
  return {
    id,
    title: `Task ${id}`,
    role,
    depends: deps,
    dependsOn: deps,
    dependencies: deps,
    files: ["file.txt"],
    filesInScope: ["file.txt"],
    acceptanceCommand: "npm test",
    accept: "npm test",
    hard,
    hardFlag: hard,
    hardRaw: hard ? "yes" : "no",
    rules: ["M1"],
    ruleIds: ["M1"],
    line,
  };
}

interface RealMergeProof {
  verifiedMerge: VerifiedMerge;
  candidateSha: string;
  candidateSha256: string;
  diff: string;
  tree: string;
  tmpDir: string;
}

async function createRealMergeProof(runId: string = "run-ra2-01"): Promise<RealMergeProof> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra2-proof-"));
  const gitDir = path.join(tmpDir, "repo");
  fs.mkdirSync(gitDir, { recursive: true });

  const runGit = (args: string[]) => runGitCmd(gitDir, args);

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "RA2 Runner"]);
  runGit(["config", "user.email", "ra2@example.com"]);
  fs.writeFileSync(path.join(gitDir, "file.txt"), "initial content\n");
  runGit(["add", "."]);
  runGit(["commit", "-m", "initial commit"]);

  const baseSha = runGit(["rev-parse", "HEAD"]);
  const integrationBranch = `graveyard/${runId}`;
  runGit(["checkout", "-b", integrationBranch]);

  const candidateBranch = "task/T1";
  runGit(["checkout", "-b", candidateBranch]);
  fs.writeFileSync(path.join(gitDir, "file.txt"), "candidate change\n");
  runGit(["add", "."]);
  runGit(["commit", "-m", "candidate work"]);
  const candidateSha = runGit(["rev-parse", "HEAD"]);
  const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
  runGit(["checkout", integrationBranch]);

  const diff = childProcess.execFileSync(
    "git",
    ["diff", "--binary", "--no-color", `${baseSha}..${candidateSha}`],
    { cwd: gitDir, encoding: "utf8" }
  );
  const candidateSha256 = candidateSha256FromDiff(diff);

  const service = new GitService({ runsDir: tmpDir });
  const verdict = buildVerdictRecord(candidateSha, {
    verdict: "approve",
    diff,
    tree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });
  const mergeResult = await (service as any).mergeCandidate({
    runId,
    candidateSha,
    expectedIntegrationHeadSha: baseSha,
    verdict,
    verdictCandidateSha256: candidateSha256,
    gateResult: { ok: true, tree },
    gitDir,
  });

  assert.ok(isVerifiedMerge(mergeResult));

  return {
    verifiedMerge: mergeResult as VerifiedMerge,
    candidateSha,
    candidateSha256,
    diff,
    tree,
    tmpDir,
  };
}

function createValidEvidence(
  proof: RealMergeProof,
  taskId: string = "T1",
  runId: string = "run-ra2-01"
) {
  const store = new EventStore(":memory:");
  store.append({
    runId,
    kind: "task.state",
    actor: "scheduler",
    taskId,
    data: { taskId, state: "in_review" },
  });
  store.append({
    runId,
    kind: "gate.result",
    actor: "grimoire",
    taskId,
    data: { ok: true, tree: proof.tree, taskId },
  });
  store.append({
    runId,
    kind: "verdict",
    actor: "warden",
    taskId,
    data: {
      verdict: "approve",
      candidateSha256: proof.candidateSha256,
      target: taskId,
      tree: proof.tree,
      taskId,
      refs: ["cmd:test"],
    },
  });

  return {
    runId,
    taskId,
    candidateSha: proof.candidateSha,
    candidateSha256: proof.candidateSha256,
    diff: proof.diff,
    tree: proof.tree,
    gateTree: proof.tree,
    gateResult: { ok: true, tree: proof.tree, gate: "syntax" },
    verdict: buildVerdictRecord(proof.candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: proof.diff,
      candidateSha256: proof.candidateSha256,
      tree: proof.tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    }),
    events: store,
    gitMerge: proof.verifiedMerge,
  };
}

describe("RA2 Second-round Audit: Scheduler & Merge-gate fixes (N-A10, N-A13, N-A16, N-A17)", () => {
  let proof: RealMergeProof;
  let proofOther: RealMergeProof;

  before(async () => {
    proof = await createRealMergeProof("run-ra2-01");
    proofOther = await createRealMergeProof("run-ra2-other");
  });

  after(() => {
    try {
      fs.rmSync(proof.tmpDir, { recursive: true, force: true });
      fs.rmSync(proofOther.tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // 1. Forged Object.create(VerifiedMerge.prototype) rejected (N-A10)
  it("rejects forged Object.create(VerifiedMerge.prototype) with 'git merge proof missing'", () => {
    const tasks: PactTask[] = [makePactTask("T1")];
    const scheduler = new Scheduler(tasks, {
      pactApproved: true,
      runId: "run-ra2-01",
    });

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");

    // Construct forged object that passes instanceof VerifiedMerge but lacks internal verification
    const forged = Object.create(VerifiedMerge.prototype);
    Object.assign(forged, {
      runId: "run-ra2-01",
      candidateSha: proof.candidateSha,
      candidateSha256: proof.candidateSha256,
      baseSha: "1111111111111111111111111111111111111111",
      mergeCommitSha: "2222222222222222222222222222222222222222",
    });

    assert.equal(forged instanceof VerifiedMerge, true);
    assert.equal(isVerifiedMerge(forged), false);

    const evidence = {
      ...createValidEvidence(proof, "T1", "run-ra2-01"),
      gitMerge: forged as unknown as VerifiedMerge,
    };

    const res = scheduler.mergeTask("T1", evidence as any);
    assert.equal(res.ok, false);
    assert.equal(res.merged, false);
    assert.equal(res.reason, "git merge proof missing");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
  });

  // 2. Mismatched gitMerge.runId rejected (N-A10 / N-A13)
  it("rejects mismatched gitMerge.runId vs scheduler._runId and evidence.runId", () => {
    const tasks: PactTask[] = [makePactTask("T1")];
    const scheduler = new Scheduler(tasks, {
      pactApproved: true,
      runId: "run-ra2-01",
    });

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");

    // Case A: gitMerge.runId ("run-ra2-other") !== scheduler._runId ("run-ra2-01")
    const evidenceOtherRun = {
      ...createValidEvidence(proofOther, "T1", "run-ra2-01"),
      candidateSha: proofOther.candidateSha,
      candidateSha256: proofOther.candidateSha256,
      diff: proofOther.diff,
      gitMerge: proofOther.verifiedMerge,
    };

    const resA = scheduler.mergeTask("T1", evidenceOtherRun as any);
    assert.equal(resA.ok, false);
    assert.equal(resA.merged, false);
    assert.equal(resA.reason, "git merge proof missing");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");

    // Case B: evidence.runId mismatch vs gitMerge.runId
    const storeMismatch = new EventStore(":memory:");
    storeMismatch.append({
      runId: "run-ra2-evidence-mismatch",
      kind: "task.state",
      actor: "scheduler",
      taskId: "T1",
      data: { taskId: "T1", state: "in_review" },
    });
    storeMismatch.append({
      runId: "run-ra2-evidence-mismatch",
      kind: "gate.result",
      actor: "grimoire",
      taskId: "T1",
      data: { ok: true, tree: proof.tree, taskId: "T1" },
    });
    storeMismatch.append({
      runId: "run-ra2-evidence-mismatch",
      kind: "verdict",
      actor: "warden",
      taskId: "T1",
      data: {
        verdict: "approve",
        candidateSha256: proof.candidateSha256,
        target: "T1",
        tree: proof.tree,
        taskId: "T1",
        refs: ["cmd:test"],
      },
    });

    const evidenceMismatch = {
      ...createValidEvidence(proof, "T1", "run-ra2-01"),
      runId: "run-ra2-evidence-mismatch",
      events: storeMismatch,
    };

    const resB = scheduler.mergeTask("T1", evidenceMismatch as any);
    assert.equal(resB.ok, false);
    assert.equal(resB.merged, false);
    assert.equal(resB.reason, "git merge proof missing");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
  });

  // 3. Fallback to verdict.candidateSha without candidateSha rejected (N-A10 / N-A13)
  it("rejects fallback to verdict.candidateSha without candidateSha in evidence", () => {
    const tasks: PactTask[] = [makePactTask("T1")];
    const scheduler = new Scheduler(tasks, {
      pactApproved: true,
      runId: "run-ra2-01",
    });

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");

    // Omit candidateSha from evidence root and candidate sub-object, leaving only verdict.candidateSha
    const evidenceWithoutCandidateSha = {
      ...createValidEvidence(proof, "T1", "run-ra2-01"),
    };
    delete (evidenceWithoutCandidateSha as any).candidateSha;
    delete (evidenceWithoutCandidateSha as any).candidate;
    assert.equal((evidenceWithoutCandidateSha as any).candidateSha, undefined);
    assert.ok(evidenceWithoutCandidateSha.verdict?.candidateSha);

    const res = scheduler.mergeTask("T1", evidenceWithoutCandidateSha as any);
    assert.equal(res.ok, false);
    assert.equal(res.merged, false);
    assert.ok(res.reason);
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
  });

  // 4. Mismatched diff vs gitMerge.candidateSha256 rejected (N-A10 / N-A13)
  it("rejects missing diff or mismatched diff vs gitMerge.candidateSha256", () => {
    const tasks: PactTask[] = [makePactTask("T1")];
    const scheduler = new Scheduler(tasks, {
      pactApproved: true,
      runId: "run-ra2-01",
    });

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");

    // Case A: diff is missing
    const evidenceMissingDiff = {
      ...createValidEvidence(proof, "T1", "run-ra2-01"),
    };
    delete (evidenceMissingDiff as any).diff;
    delete (evidenceMissingDiff as any).candidate;

    const resA = scheduler.mergeTask("T1", evidenceMissingDiff as any);
    assert.equal(resA.ok, false);
    assert.equal(resA.merged, false);
    assert.ok(resA.reason);
    assert.equal(scheduler.getTask("T1")?.state, "in_review");

    // Case B: diff does not match gitMerge.candidateSha256
    const tamperedDiff = "diff --git a/file.txt b/file.txt\n+tampered content\n";
    const tamperedSha256 = candidateSha256FromDiff(tamperedDiff);
    const storeTampered = new EventStore(":memory:");
    storeTampered.append({
      runId: "run-ra2-01",
      kind: "task.state",
      actor: "scheduler",
      taskId: "T1",
      data: { taskId: "T1", state: "in_review" },
    });
    storeTampered.append({
      runId: "run-ra2-01",
      kind: "gate.result",
      actor: "grimoire",
      taskId: "T1",
      data: { ok: true, tree: proof.tree, taskId: "T1" },
    });
    storeTampered.append({
      runId: "run-ra2-01",
      kind: "verdict",
      actor: "warden",
      taskId: "T1",
      data: {
        verdict: "approve",
        candidateSha256: tamperedSha256,
        target: "T1",
        tree: proof.tree,
        taskId: "T1",
        refs: ["cmd:test"],
      },
    });

    const evidenceTamperedDiff = {
      runId: "run-ra2-01",
      taskId: "T1",
      candidateSha: proof.candidateSha,
      candidateSha256: tamperedSha256,
      diff: tamperedDiff,
      tree: proof.tree,
      gateTree: proof.tree,
      gateResult: { ok: true, tree: proof.tree, gate: "syntax" },
      verdict: buildVerdictRecord(proof.candidateSha, {
        target: "T1",
        taskId: "T1",
        verdict: "approve",
        diff: tamperedDiff,
        candidateSha256: tamperedSha256,
        tree: proof.tree,
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      }),
      events: storeTampered,
      gitMerge: proof.verifiedMerge, // has original proof.candidateSha256 !== tamperedSha256
    };

    const resB = scheduler.mergeTask("T1", evidenceTamperedDiff as any);
    assert.equal(resB.ok, false);
    assert.equal(resB.merged, false);
    assert.equal(resB.reason, "git merge proof missing");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
  });

  // 5. Async rejected Promise from emit does not cause unhandledRejection and triggers compensation (N-A16)
  it("attaches rejection handler to async emit Promise preventing unhandledRejection and rolling back state", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandledRejections.push(err);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tasks: PactTask[] = [
        makePactTask("T1", [], "soul-stitcher", false, 0),
        makePactTask("T2", ["T1"], "soul-stitcher", false, 1),
      ];

      const scheduler = new Scheduler(tasks, {
        pactApproved: true,
        runId: "run-ra2-01",
        emit: async (envelope) => {
          // Reject asynchronously when task.state transition is emitted
          if (
            envelope.kind === "task.state" &&
            (envelope.data as Record<string, unknown>)?.state === "merged"
          ) {
            throw new Error("Simulated async network failure during emit");
          }
        },
      });

      scheduler.dispatchTask("T1");
      scheduler.submitForReview("T1");
      assert.equal(scheduler.getTask("T1")?.state, "in_review");
      assert.equal(scheduler.getTask("T2")?.state, "pending");

      const evidence = createValidEvidence(proof, "T1", "run-ra2-01");

      // mergeTask is synchronous; should not throw
      const mergeRes = scheduler.mergeTask("T1", evidence as any);
      assert.ok(mergeRes);
      assert.ok(mergeRes.emissionPromise !== undefined, "emissionPromise must be attached");
      assert.ok(mergeRes.emissionSettledPromise !== undefined, "emissionSettledPromise must be attached");
      const settled = await mergeRes.emissionSettledPromise;
      assert.equal(settled.ok, false);
      assert.ok(settled.error);

      // Wait a tick for the async emit Promise rejection to settle and trigger rollback
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No unhandledRejection must occur
      assert.equal(
        unhandledRejections.length,
        0,
        "Async emit rejection must not cause unhandledRejection"
      );

      // State must roll back to in_review and pending so state does not stay silently inconsistent
      assert.equal(scheduler.getTask("T1")?.state, "in_review");
      assert.equal(scheduler.getTask("T2")?.state, "pending");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // 6. Merge-gate rejects EventStore when runId is missing even if another runId exists in store (N-A17)
  it("rejects EventStore replay when runId is missing even if other runIds exist in the store", () => {
    const store = new EventStore(":memory:");
    store.append({
      runId: "existing-run-999",
      kind: "gate.result",
      actor: "grimoire",
      taskId: "T1",
      data: { ok: true, tree: proof.tree, taskId: "T1" },
    });
    store.append({
      runId: "existing-run-999",
      kind: "verdict",
      actor: "warden",
      taskId: "T1",
      data: {
        verdict: "approve",
        candidateSha256: proof.candidateSha256,
        target: "T1",
        tree: proof.tree,
        taskId: "T1",
        refs: ["cmd:test"],
      },
    });

    // Ensure store has runIds
    const existingRunIds = store.getRunIds();
    assert.ok(existingRunIds.length > 0);
    assert.ok(existingRunIds.includes("existing-run-999"));

    // checkMergeGateFromEvents with omitted runId
    const resFromEvents = checkMergeGateFromEvents(store, {
      candidateSha: proof.candidateSha,
      candidateSha256: proof.candidateSha256,
      diff: proof.diff,
      tree: proof.tree,
      taskId: "T1",
      // runId is deliberately omitted
    });

    assert.equal(resFromEvents.ok, false);
    assert.ok(
      resFromEvents.reasons.includes(
        "EventStore replay requires an explicit non-empty runId"
      ),
      `Expected 'EventStore replay requires an explicit non-empty runId' but got: ${JSON.stringify(resFromEvents.reasons)}`
    );

    // checkMergeGate with omitted runId
    const resGate = checkMergeGate({
      verdict: buildVerdictRecord(proof.candidateSha, {
        target: "T1",
        taskId: "T1",
        verdict: "approve",
        diff: proof.diff,
        candidateSha256: proof.candidateSha256,
        tree: proof.tree,
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      }),
      gateResult: { ok: true, tree: proof.tree, gate: "syntax" },
      events: store as any,
      candidateSha: proof.candidateSha,
      candidateSha256: proof.candidateSha256,
      diff: proof.diff,
      tree: proof.tree,
      taskId: "T1",
      // runId is deliberately omitted
    });

    assert.equal(resGate.ok, false);
    assert.equal(resGate.accepted, false);
    assert.ok(
      resGate.reasons?.includes(
        "EventStore replay requires an explicit non-empty runId"
      ),
      `Expected 'EventStore replay requires an explicit non-empty runId' but got: ${JSON.stringify(resGate.reasons)}`
    );
  });

  // 7. Successful async emit exposes emissionPromise and emissionSettledPromise settling ok: true (NEW-2, N-A16)
  it("exposes emissionPromise and emissionSettledPromise that resolve to ok: true on successful async emit", async () => {
    const emittedEvents: any[] = [];
    const tasks: PactTask[] = [
      makePactTask("T1", [], "soul-stitcher", false, 0),
      makePactTask("T2", ["T1"], "soul-stitcher", false, 1),
    ];

    const scheduler = new Scheduler(tasks, {
      pactApproved: true,
      runId: "run-ra2-01",
      emit: async (envelope) => {
        emittedEvents.push(envelope);
      },
    });

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");

    const evidence = createValidEvidence(proof, "T1", "run-ra2-01");
    const mergeRes = scheduler.mergeTask("T1", evidence as any);
    assert.equal(mergeRes.ok, true);
    assert.equal(mergeRes.merged, true);

    assert.ok(mergeRes.emissionPromise !== undefined, "emissionPromise should be attached");
    assert.ok(mergeRes.emissionSettledPromise !== undefined, "emissionSettledPromise should be attached");

    const emissionRes = await mergeRes.emissionPromise;
    assert.equal(emissionRes, undefined);

    const settledRes = await mergeRes.emissionSettledPromise;
    assert.deepEqual(settledRes, { ok: true });

    assert.equal(scheduler.getTask("T1")?.state, "merged");
    assert.equal(scheduler.getTask("T2")?.state, "ready");
  });
});
