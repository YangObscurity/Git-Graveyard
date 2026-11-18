// Work package SA2: scheduler merge gate hardening (audit B-3, N-A4, N-A1)
// - mergeTask accepts only a VerifiedMerge instance; a plain object is rejected
// - applyMerged computes every state change first, then emits events in order;
//   a failed dependency release leaves a compensating task.state event back to
//   in_review
// - checkMergeGate validates the Warden verdict and requires install, build,
//   accept and tests to pass; a bare approve and a failing check are rejected
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import { GitService, VerifiedMerge } from "../../lib/git/git-service";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import { Scheduler } from "../../lib/scheduler/scheduler";
import type { PactTask } from "../../lib/pact/pact-parser";
import type { TaskMergeEvidence } from "../../lib/scheduler/types";
import type { EventEnvelope } from "../../lib/events/types";
import { EventStore } from "../../lib/events/event-store";
import { checkMergeGate } from "../../lib/warden/merge-gate";
import { buildVerdictRecord } from "../../lib/warden/warden-review";

interface Sa2MergeProof {
  verifiedMerge: VerifiedMerge;
  runId: string;
  baseSha: string;
  candidateSha: string;
  candidateSha256: string;
  diff: string;
  tree: string;
}

// Builds a real repository and merges the candidate through the real
// GitService.mergeCandidate path so the tests hold a genuine VerifiedMerge
// proof. The temp repository is removed once the proof has been issued; the
// proof object stands on its own afterwards.
async function createRealMergeProof(
  runId: string,
  taskId: string
): Promise<Sa2MergeProof> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-sa2-"));
  try {
    const gitDir = path.join(tmpDir, "git");
    fs.mkdirSync(gitDir, { recursive: true });

    const runGit = (args: string[]): string =>
      childProcess
        .execFileSync("git", args, {
          cwd: gitDir,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            HOME: tmpDir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          } as unknown as NodeJS.ProcessEnv,
        })
        .trim();

    runGit(["init", "--initial-branch=main", "."]);
    runGit(["config", "user.name", "Test Runner"]);
    runGit(["config", "user.email", "runner@example.test"]);

    fs.writeFileSync(path.join(gitDir, "base.txt"), "line 1: base\n", "utf8");
    runGit(["add", "base.txt"]);
    runGit(["commit", "-m", "initial base commit"]);
    const baseSha = runGit(["rev-parse", "HEAD"]);

    const integrationBranch = `graveyard/${runId}`;
    runGit(["branch", integrationBranch, baseSha]);
    runGit(["checkout", "-b", `task/${taskId}`, integrationBranch]);
    fs.writeFileSync(
      path.join(gitDir, "base.txt"),
      "line 1: base\nline 2: candidate addition\n",
      "utf8"
    );
    fs.writeFileSync(path.join(gitDir, "sa2-candidate.txt"), "sa2 candidate file\n", "utf8");
    runGit(["add", "."]);
    runGit(["commit", "-m", "sa2 candidate work"]);
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

    assert.ok(mergeResult instanceof VerifiedMerge);

    return {
      verifiedMerge: mergeResult as VerifiedMerge,
      runId,
      baseSha,
      candidateSha,
      candidateSha256,
      diff,
      tree,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

let sa2Proof: Sa2MergeProof;

before(async () => {
  sa2Proof = await createRealMergeProof("run-sa2-01", "task-sa2-01");
});

function createSa2Tasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Task 1",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["lib/a.js"],
      filesInScope: ["lib/a.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: [],
      ruleIds: [],
      line: 1,
    },
    {
      id: "T2",
      title: "Task 2",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/b.js"],
      filesInScope: ["lib/b.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: [],
      ruleIds: [],
      line: 2,
    },
  ];
}

function createSa2Evidence(
  taskId: string,
  overrides?: { gitMerge?: unknown }
): TaskMergeEvidence {
  const proof = sa2Proof;
  const eventSource = new EventStore(":memory:");
  eventSource.append({
    runId: proof.runId,
    kind: "task.state",
    actor: "scheduler",
    taskId,
    data: {
      taskId,
      state: "in_review",
    },
  });
  eventSource.append({
    runId: proof.runId,
    kind: "gate.result",
    actor: "grimoire",
    taskId,
    data: {
      taskId,
      ok: true,
      tree: proof.tree,
    },
  });
  eventSource.append({
    runId: proof.runId,
    kind: "verdict",
    actor: "warden",
    taskId,
    data: {
      taskId,
      verdict: "approve",
      candidateSha256: proof.candidateSha256,
      target: taskId,
      tree: proof.tree,
      refs: ["cmd:test"],
    },
  });

  const evidence: TaskMergeEvidence = {
    taskId,
    runId: proof.runId,
    diff: proof.diff,
    tree: proof.tree,
    candidateSha: proof.candidateSha,
    candidateSha256: proof.candidateSha256,
    eventSource,
    verdict: buildVerdictRecord(proof.candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff: proof.diff,
      tree: proof.tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    }),
    gateResult: {
      ok: true,
      gate: "syntax",
      kind: "gate.result",
      tree: proof.tree,
    },
  };

  if (overrides && "gitMerge" in overrides) {
    (evidence as any).gitMerge = overrides.gitMerge;
  } else {
    (evidence as any).gitMerge = proof.verifiedMerge;
  }

  return evidence;
}

describe("SA2: scheduler mergeTask requires a VerifiedMerge proof (audit B-3)", () => {
  it("a plain proof object is rejected and the task stays in_review", () => {
    const scheduler = new Scheduler(createSa2Tasks(), { runId: "run-sa2-01" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "in_review");

    // A plain object carrying every field the old proof shape had is still a
    // plain object: only a VerifiedMerge instance is accepted.
    const evidence = createSa2Evidence("T1", {
      gitMerge: {
        candidateSha: sa2Proof.candidateSha,
        integrationHeadSha: sa2Proof.candidateSha,
        ancestorVerified: true,
      },
    });
    const result = scheduler.mergeTask("T1", evidence);

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(result.reason, "git merge proof missing");
    assert.deepEqual(result.reasons, ["git merge proof missing"]);
    assert.equal(t1.state, "in_review");
    assert.equal(scheduler.getTask("T2")?.state, "pending");
  });

  it("a real VerifiedMerge proof merges and releases the dependent", () => {
    const events: EventEnvelope[] = [];
    const scheduler = new Scheduler(createSa2Tasks(), {
      runId: "run-sa2-01",
      emit: (e) => {
        events.push(e);
      },
    });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");

    const countBefore = events.length;
    const result = scheduler.mergeTask("T1", createSa2Evidence("T1"));

    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
    assert.equal(scheduler.getTask("T1")?.state, "merged");
    assert.equal(scheduler.getTask("T2")?.state, "ready");

    // Events are emitted in order: merged for T1 first, then ready for T2.
    const emitted = events.slice(countBefore);
    const states = emitted
      .filter((e) => e.kind === "task.state")
      .map((e) => `${e.taskId}:${(e.data as Record<string, unknown>).state}`);
    assert.ok(states.includes("T1:merged"));
    assert.ok(states.includes("T2:ready"));
    assert.ok(states.indexOf("T1:merged") < states.indexOf("T2:ready"));
  });
});

describe("SA2: applyMerged compensation on a failed dependency release (audit B-3, N-4)", () => {
  it("a failed dependency release leaves a compensating task.state event back to in_review", () => {
    const events: EventEnvelope[] = [];
    const scheduler = new Scheduler(createSa2Tasks(), {
      runId: "run-sa2-01",
      emit: (e) => {
        events.push(e);
      },
    });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;
    const t2 = scheduler.getTask("T2")!;
    assert.equal(t1.state, "in_review");
    assert.equal(t2.state, "pending");

    const originalAreAllDependenciesMerged = (
      scheduler as any
    ).areAllDependenciesMerged.bind(scheduler);
    (scheduler as any).areAllDependenciesMerged = (task: any) => {
      if (task.id === "T2") {
        throw new Error("Simulated dependency release failure");
      }
      return originalAreAllDependenciesMerged(task);
    };

    const countBefore = events.length;
    const result = scheduler.mergeTask("T1", createSa2Evidence("T1"));

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(result.reason, "Simulated dependency release failure");
    assert.equal(t1.state, "in_review");
    assert.equal(t2.state, "pending");

    const emitted = events.slice(countBefore);
    const stateEvents = emitted.filter((e) => e.kind === "task.state");

    // No merged event for T1 and no ready event for T2 was emitted.
    assert.equal(
      stateEvents.some(
        (e) => e.taskId === "T1" && (e.data as Record<string, unknown>).state === "merged"
      ),
      false
    );
    assert.equal(
      stateEvents.some(
        (e) => e.taskId === "T2" && (e.data as Record<string, unknown>).state === "ready"
      ),
      false
    );

    // Exactly one compensating task.state event for T1 back to in_review,
    // appended after everything else.
    const compensating = stateEvents.filter(
      (e) => e.taskId === "T1" && (e.data as Record<string, unknown>).state === "in_review"
    );
    assert.equal(compensating.length, 1);
    const last = emitted[emitted.length - 1];
    assert.equal(last.kind, "task.state");
    assert.equal(last.taskId, "T1");
    assert.equal((last.data as Record<string, unknown>).state, "in_review");
    assert.ok(
      String((last.data as Record<string, unknown>).reason).includes(
        "Simulated dependency release failure"
      )
    );
  });
});

describe("SA2: merge gate validates the Warden verdict (audit N-A1, N-A4)", () => {
  it("a bare approve is rejected by the merge gate", () => {
    // 1. A bare approve string.
    const bareString = checkMergeGate({
      verdict: "approve",
      candidateSha: sa2Proof.candidateSha,
      candidateSha256: sa2Proof.candidateSha256,
      diff: sa2Proof.diff,
      tree: sa2Proof.tree,
      taskId: "T1",
      gateResult: { ok: true, tree: sa2Proof.tree },
      eventSource: new EventStore(":memory:"),
    });
    assert.equal(bareString.accepted, false);
    assert.ok(
      (bareString.reasons ?? []).some((r) => r.includes("Verdict is not an object"))
    );

    // 2. A bare approve record without reasons and without checks.
    const bareRecord = checkMergeGate({
      verdict: {
        verdict: "approve",
        status: "approve",
        target: "T1",
        taskId: "T1",
        candidateSha: sa2Proof.candidateSha,
        candidateSha256: sa2Proof.candidateSha256,
        diff: sa2Proof.diff,
        tree: sa2Proof.tree,
      },
      candidateSha: sa2Proof.candidateSha,
      candidateSha256: sa2Proof.candidateSha256,
      diff: sa2Proof.diff,
      tree: sa2Proof.tree,
      taskId: "T1",
      gateResult: { ok: true, tree: sa2Proof.tree },
      eventSource: new EventStore(":memory:"),
    });
    assert.equal(bareRecord.accepted, false);
    assert.ok(
      (bareRecord.reasons ?? []).some((r) =>
        r.includes("Verdict must include reasons array")
      )
    );
    assert.ok(
      ["install", "build", "accept", "tests"].every((name) =>
        (bareRecord.reasons ?? []).some((r) => r.includes(`'${name}' is not passing`))
      )
    );
  });

  it("a failing check is rejected by the merge gate", () => {
    const store = new EventStore(":memory:");
    store.append({
      runId: "run-sa2-gate",
      kind: "gate.result",
      actor: "grimoire",
      taskId: "T1",
      data: { ok: true, tree: sa2Proof.tree, taskId: "T1" },
    });
    store.append({
      runId: "run-sa2-gate",
      kind: "verdict",
      actor: "warden",
      taskId: "T1",
      data: {
        verdict: "approve",
        candidateSha256: sa2Proof.candidateSha256,
        target: "T1",
        tree: sa2Proof.tree,
        taskId: "T1",
      },
    });

    const failingVerdict = {
      verdict: "approve",
      status: "approve",
      target: "T1",
      taskId: "T1",
      candidateSha: sa2Proof.candidateSha,
      candidateSha256: sa2Proof.candidateSha256,
      diff: sa2Proof.diff,
      tree: sa2Proof.tree,
      reasons: [{ text: "All checks passed", refs: ["cmd:all-checks-passed"] }],
      checks: {
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: false },
        noTestWeakening: { ok: true },
      },
    };

    const failing = checkMergeGate({
      verdict: failingVerdict,
      candidateSha: sa2Proof.candidateSha,
      candidateSha256: sa2Proof.candidateSha256,
      diff: sa2Proof.diff,
      tree: sa2Proof.tree,
      taskId: "T1",
      gateResult: { ok: true, tree: sa2Proof.tree },
      eventSource: store,
      runId: "run-sa2-gate",
    });
    assert.equal(failing.accepted, false);
    assert.equal(failing.verdictApproved, true);
    assert.ok(
      (failing.reasons ?? []).some(
        (r) => r.includes("'tests' is not passing") && r.includes("Requirement 24.5")
      )
    );

    // The same record with every check passing is accepted: the real path
    // still goes through the gate.
    const passingVerdict = {
      ...failingVerdict,
      checks: {
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
        noTestWeakening: { ok: true },
      },
    };
    const passing = checkMergeGate({
      verdict: passingVerdict,
      candidateSha: sa2Proof.candidateSha,
      candidateSha256: sa2Proof.candidateSha256,
      diff: sa2Proof.diff,
      tree: sa2Proof.tree,
      taskId: "T1",
      gateResult: { ok: true, tree: sa2Proof.tree },
      eventSource: store,
      runId: "run-sa2-gate",
    });
    assert.equal(passing.accepted, true);
    assert.equal(passing.ok, true);
    assert.equal(passing.reason, undefined);
  });
});
