// candidate-submission-ra4.test.ts
// Tests for Work Package RA4: candidate-submission VerifiedMerge proof verification
// and rollbackIntegrationRef (findings N-A12 and N-A13).

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitService, VerifiedMerge, isVerifiedMerge } from "../../lib/git/git-service";
import { onSubmit } from "../../lib/scheduler/candidate-submission";
import { EventStore } from "../../lib/events/event-store";
import { Scheduler } from "../../lib/scheduler/scheduler";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

interface TestRepo {
  dir: string;
  runGit: (args: string[]) => string;
  cleanup: () => void;
}

function createRepo(): TestRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-ra4-"));
  const runGit = (args: string[]) =>
    childProcess
      .execFileSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: GIT_ENV,
      })
      .trim();

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Worker"]);
  runGit(["config", "user.email", "worker@graveyard"]);

  return {
    dir,
    runGit,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function gitDiff(repo: TestRepo, from: string, to: string): string {
  return childProcess.execFileSync(
    "git",
    ["diff", "--binary", "--no-color", from, to],
    {
      cwd: repo.dir,
      encoding: "utf-8",
      env: GIT_ENV,
    }
  );
}

function setupCandidateRepo(repo: TestRepo, runId: string, taskId: string) {
  const { runGit, dir } = repo;
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-pkg" }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "src", "index.js"),
    "const initial = 0;\nmodule.exports = { initial };\n"
  );
  runGit(["add", "package.json", "src/index.js"]);
  runGit(["commit", "-m", "Initial commit"]);
  const baseSha = runGit(["rev-parse", "HEAD"]);
  runGit(["branch", `graveyard/${runId}`, baseSha]);

  runGit(["checkout", "-b", `task/${taskId}`, `graveyard/${runId}`]);
  fs.writeFileSync(
    path.join(dir, "src", "index.js"),
    "const valid = 1;\nmodule.exports = { valid };\n"
  );
  runGit(["add", "src/index.js"]);
  runGit(["commit", "-m", `Implement ${taskId}`]);
  const candidateSha = runGit(["rev-parse", "HEAD"]);
  const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
  runGit(["checkout", `graveyard/${runId}`]);

  const diff = gitDiff(repo, baseSha, candidateSha);
  const candidateSha256 = candidateSha256FromDiff(diff);
  return { baseSha, candidateSha, tree, diff, candidateSha256 };
}

function passingReviewer(
  candidateSha: string,
  candidateSha256: string,
  tree: string
) {
  return async () => ({
    verdict: "approve",
    status: "approve",
    candidateSha,
    candidateSha256,
    tree,
    reasons: [{ text: "All checks passed", refs: ["cmd:test"] }],
    checks: {
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      noTestWeakening: { ok: true },
    },
  });
}

describe("candidate-submission-ra4 (N-A12: rollbackIntegrationRef, N-A13: VerifiedMerge proof verification)", () => {
  it("N-A12: rollback uses GitService.rollbackIntegrationRef and succeeds without touching public execGit update-ref", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-na12-rollback";
      const s = setupCandidateRepo(repo, runId, "T1");

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");

      // Trigger rollback by having scheduler.mergeTask throw
      scheduler.mergeTask = () => {
        throw new Error("Simulated scheduler merge failure");
      };

      const gitService = new GitService();
      let execGitUpdateRefCalled = false;
      let rollbackIntegrationRefCalled = false;

      const originalExecGit = gitService.execGit.bind(gitService);
      gitService.execGit = async (args: string[], options?: any) => {
        if (args.includes("update-ref")) {
          execGitUpdateRefCalled = true;
        }
        return originalExecGit(args, options);
      };

      const originalRollback = (gitService as any).rollbackIntegrationRef.bind(gitService);
      (gitService as any).rollbackIntegrationRef = async (proof: any, opts: any) => {
        rollbackIntegrationRefCalled = true;
        assert.ok(isVerifiedMerge(proof), "rollbackIntegrationRef must receive a verified proof");
        return originalRollback(proof, opts);
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.equal(rollbackIntegrationRefCalled, true, "rollbackIntegrationRef must be called on rollback");
      assert.equal(execGitUpdateRefCalled, false, "public execGit update-ref must NOT be called on rollback");

      // Ref must be successfully rolled back to baseSha in git
      const currentHead = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(currentHead, s.baseSha);
    } finally {
      repo.cleanup();
    }
  });

  it("N-A13: forged / non-VerifiedMerge return value from mergeCandidate is rejected without merge", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-na13-forged-proof";
      const s = setupCandidateRepo(repo, runId, "T1");

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      const gitService = new GitService();
      let rollbackCalled = false;
      (gitService as any).rollbackIntegrationRef = async () => {
        rollbackCalled = true;
        return { ok: true };
      };

      // Mock mergeCandidate to return a forged object that passes duck typing
      (gitService as any).mergeCandidate = async () => {
        const forged = Object.create(VerifiedMerge.prototype);
        Object.assign(forged, {
          ok: true,
          merged: true,
          runId,
          branch: `graveyard/${runId}`,
          candidateSha: s.candidateSha,
          candidateSha256: s.candidateSha256,
          newHeadSha: s.candidateSha,
          previousHeadSha: s.baseSha,
        });
        return forged;
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.ok(
        res.reason?.includes("VerifiedMerge"),
        `Expected VerifiedMerge rejection reason, got: ${res.reason}`
      );
      assert.equal(rollbackCalled, false, "rollback should not be called with an unverified forged proof");
      assert.equal(t1.state, "in_review");
    } finally {
      repo.cleanup();
    }
  });

  it("N-A13: mismatched runId on VerifiedMerge proof is rejected and rolled back", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-na13-runid-mismatch";
      const s = setupCandidateRepo(repo, runId, "T1");

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");

      // Obtain a real VerifiedMerge proof with a different runId
      const realGitService = new GitService();
      const otherRunId = "other-run-id";
      repo.runGit(["branch", `graveyard/${otherRunId}`, s.baseSha]);
      const proofWithOtherRunId = await (realGitService as any).mergeCandidate({
        runId: otherRunId,
        candidateSha: s.candidateSha,
        expectedIntegrationHeadSha: s.baseSha,
        verdict: {
          verdict: "approve",
          status: "approve",
          candidateSha: s.candidateSha,
          candidateSha256: s.candidateSha256,
          tree: s.tree,
          reasons: [{ text: "Checks pass", refs: ["cmd:test"] }],
          checks: {
            install: { ok: true },
            build: { ok: true },
            accept: { ok: true },
            tests: { ok: true },
            noTestWeakening: { ok: true },
          },
        },
        gateResult: { ok: true, tree: s.tree },
        gitDir: repo.dir,
      });

      assert.ok(isVerifiedMerge(proofWithOtherRunId));
      assert.equal(proofWithOtherRunId.runId, otherRunId);

      const gitService = new GitService();
      let rollbackCalled = false;
      const originalRollback = (gitService as any).rollbackIntegrationRef.bind(gitService);
      (gitService as any).rollbackIntegrationRef = async (proof: any, opts: any) => {
        rollbackCalled = true;
        return originalRollback(proof, opts);
      };

      // mergeCandidate returns the real VerifiedMerge that has otherRunId
      (gitService as any).mergeCandidate = async () => proofWithOtherRunId;

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.ok(
        res.reason?.includes("proof fields mismatch") || res.reason?.includes("VerifiedMerge"),
        `Expected field mismatch error, got: ${res.reason}`
      );
      assert.equal(rollbackCalled, true, "rollbackIntegrationRef must be called on field mismatch");
    } finally {
      repo.cleanup();
    }
  });

  it("N-A13: mismatched candidateSha on VerifiedMerge proof is rejected and rolled back", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-na13-sha-mismatch";
      const s = setupCandidateRepo(repo, runId, "T1");

      // Create a second candidate commit
      repo.runGit(["checkout", "-b", "candidate-2", s.baseSha]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 99;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Candidate 2 commit"]);
      const candidate2Sha = repo.runGit(["rev-parse", "HEAD"]);
      const tree2 = repo.runGit(["rev-parse", `${candidate2Sha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff2 = gitDiff(repo, s.baseSha, candidate2Sha);
      const candidate2Sha256 = candidateSha256FromDiff(diff2);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");

      // Produce real VerifiedMerge for candidate 2
      const realGitService = new GitService();
      const proof2 = await (realGitService as any).mergeCandidate({
        runId,
        candidateSha: candidate2Sha,
        expectedIntegrationHeadSha: s.baseSha,
        verdict: {
          verdict: "approve",
          status: "approve",
          candidateSha: candidate2Sha,
          candidateSha256: candidate2Sha256,
          tree: tree2,
          reasons: [{ text: "Checks pass", refs: ["cmd:test"] }],
          checks: {
            install: { ok: true },
            build: { ok: true },
            accept: { ok: true },
            tests: { ok: true },
            noTestWeakening: { ok: true },
          },
        },
        gateResult: { ok: true, tree: tree2 },
        gitDir: repo.dir,
      });

      assert.ok(isVerifiedMerge(proof2));
      assert.equal(proof2.candidateSha, candidate2Sha);

      // Rollback branch back to baseSha so Step 7 passes with expectedHeadSha === baseSha
      await (realGitService as any).rollbackIntegrationRef(proof2, { gitDir: repo.dir });

      const gitService = new GitService();
      let rollbackCalled = false;
      const originalRollback = (gitService as any).rollbackIntegrationRef.bind(gitService);
      (gitService as any).rollbackIntegrationRef = async (proof: any, opts: any) => {
        rollbackCalled = true;
        return originalRollback(proof, opts);
      };

      // mergeCandidate simulates moving the integration ref to candidate2Sha and returning proof2
      (gitService as any).mergeCandidate = async () => {
        repo.runGit(["update-ref", `refs/heads/graveyard/${runId}`, candidate2Sha, s.baseSha]);
        return proof2;
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.ok(
        res.reason?.includes("proof fields mismatch") || res.reason?.includes("VerifiedMerge"),
        `Expected candidateSha mismatch error, got: ${res.reason}`
      );
      assert.equal(rollbackCalled, true, "rollbackIntegrationRef must be called on candidateSha mismatch");
    } finally {
      repo.cleanup();
    }
  });

  it("N-A13: mismatched candidateSha256 on VerifiedMerge proof is rejected and rolled back", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-na13-sha256-mismatch";
      const { runGit, dir } = repo;

      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "test-pkg" }, null, 2)
      );
      fs.writeFileSync(
        path.join(dir, "src", "index.js"),
        "const v = 0;\nmodule.exports = { v };\n"
      );
      runGit(["add", "package.json", "src/index.js"]);
      runGit(["commit", "-m", "Commit 0"]);
      const commit0 = runGit(["rev-parse", "HEAD"]);

      // Commit 1 (baseSha for task T1)
      fs.writeFileSync(
        path.join(dir, "src", "index.js"),
        "const v = 1;\nmodule.exports = { v };\n"
      );
      runGit(["add", "src/index.js"]);
      runGit(["commit", "-m", "Commit 1 (base)"]);
      const baseSha = runGit(["rev-parse", "HEAD"]);

      // Commit 2 (candidateSha for task T1)
      runGit(["checkout", "-b", "task/T1", baseSha]);
      fs.writeFileSync(
        path.join(dir, "src", "index.js"),
        "const v = 2;\nmodule.exports = { v };\n"
      );
      runGit(["add", "src/index.js"]);
      runGit(["commit", "-m", "Commit 2 (candidate)"]);
      const candidateSha = runGit(["rev-parse", "HEAD"]);
      const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);

      // First create graveyard/${runId} at commit0 to produce real VerifiedMerge for commit0..candidateSha
      runGit(["branch", `graveyard/${runId}`, commit0]);
      runGit(["checkout", `graveyard/${runId}`]);
      const diffFromCommit0 = gitDiff(repo, commit0, candidateSha);
      const sha256FromCommit0 = candidateSha256FromDiff(diffFromCommit0);

      const realGitService = new GitService();
      const proofWithAltSha256 = await (realGitService as any).mergeCandidate({
        runId,
        candidateSha,
        expectedIntegrationHeadSha: commit0,
        verdict: {
          verdict: "approve",
          status: "approve",
          candidateSha,
          candidateSha256: sha256FromCommit0,
          tree,
          reasons: [{ text: "Checks pass", refs: ["cmd:test"] }],
          checks: {
            install: { ok: true },
            build: { ok: true },
            accept: { ok: true },
            tests: { ok: true },
            noTestWeakening: { ok: true },
          },
        },
        gateResult: { ok: true, tree },
        gitDir: repo.dir,
      });

      assert.ok(isVerifiedMerge(proofWithAltSha256));
      assert.equal(proofWithAltSha256.runId, runId);
      assert.equal(proofWithAltSha256.candidateSha, candidateSha);
      assert.equal(proofWithAltSha256.candidateSha256, sha256FromCommit0);

      // Now reset graveyard/${runId} to baseSha for task T1
      runGit(["update-ref", `refs/heads/graveyard/${runId}`, baseSha]);
      const diffFromBase = gitDiff(repo, baseSha, candidateSha);
      const sha256FromBase = candidateSha256FromDiff(diffFromBase);
      assert.notEqual(sha256FromBase, sha256FromCommit0, "Diff hashes must differ");

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");

      const gitService = new GitService();
      let rollbackCalled = false;
      const originalRollback = (gitService as any).rollbackIntegrationRef.bind(gitService);
      (gitService as any).rollbackIntegrationRef = async (proof: any, opts: any) => {
        rollbackCalled = true;
        return originalRollback(proof, opts);
      };

      // Mock mergeCandidate to return proofWithAltSha256 and move integration ref to candidateSha
      (gitService as any).mergeCandidate = async () => {
        repo.runGit(["update-ref", `refs/heads/graveyard/${runId}`, candidateSha, baseSha]);
        return proofWithAltSha256;
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: diffFromBase,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        wardenReviewer: passingReviewer(candidateSha, sha256FromBase, tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.ok(
        res.reason?.includes("proof fields mismatch") || res.reason?.includes("VerifiedMerge"),
        `Expected candidateSha256 mismatch error, got: ${res.reason}`
      );
      assert.equal(rollbackCalled, true, "rollbackIntegrationRef must be called on candidateSha256 mismatch");

      // Ref must be successfully rolled back to proof.previousHeadSha (commit0) in git
      const currentHead = repo.runGit(["rev-parse", `refs/heads/graveyard/${runId}`]);
      assert.equal(currentHead, commit0);
    } finally {
      repo.cleanup();
    }
  });

  it("N-A13: structured gateResult is passed to mergeCandidate and runId passed in schedulerEvidence", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-na13-structured-gate";
      const s = setupCandidateRepo(repo, runId, "T1");

      let receivedGateResult: any = null;
      let evidenceReceivedByScheduler: any = null;

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");

      const originalMergeTask = scheduler.mergeTask.bind(scheduler);
      scheduler.mergeTask = (taskId: string, evidence?: any) => {
        evidenceReceivedByScheduler = evidence;
        return originalMergeTask(taskId, evidence);
      };

      const gitService = new GitService();
      const originalMergeCandidate = (gitService as any).mergeCandidate.bind(gitService);
      (gitService as any).mergeCandidate = async (opts: any) => {
        receivedGateResult = opts.gateResult;
        return originalMergeCandidate(opts);
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, true);
      assert.equal(res.merged, true);
      assert.equal(res.state, "merged");

      // Verify gateResult passed to mergeCandidate is a structured object, never bare boolean
      assert.ok(receivedGateResult !== null && typeof receivedGateResult === "object");
      assert.equal(typeof receivedGateResult, "object");
      assert.notEqual(typeof receivedGateResult, "boolean");
      assert.equal(receivedGateResult.ok, true);
      assert.equal(typeof receivedGateResult.tree, "string");
      assert.equal(receivedGateResult.tree, s.tree);

      // Verify runId is passed inside schedulerEvidence
      assert.ok(evidenceReceivedByScheduler !== null && typeof evidenceReceivedByScheduler === "object");
      assert.equal(evidenceReceivedByScheduler.runId, runId);
      assert.ok(isVerifiedMerge(evidenceReceivedByScheduler.gitMerge));
    } finally {
      repo.cleanup();
    }
  });

  it("NEW-2: async _emit rejection in scheduler causes Git ref rollback in onSubmit and does not leave split-brain", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandledRejections.push(err);
    };
    process.on("unhandledRejection", onUnhandled);

    const repo = createRepo();
    try {
      const runId = "ra4-new2-async-emit-rollback";
      const s = setupCandidateRepo(repo, runId, "T1");

      const scheduler = new Scheduler(
        [
          {
            id: "T1",
            title: "Task 1",
            role: "bonesetter",
            dependencies: [],
            files: ["src/index.js"],
            acceptanceCommand: "npm test",
          } as any,
        ],
        {
          runId,
          emit: async (envelope) => {
            if (
              envelope.kind === "task.state" &&
              (envelope.data as Record<string, unknown>)?.state === "merged"
            ) {
              throw new Error("Simulated async network failure during emit in onSubmit");
            }
          },
        }
      );
      scheduler.dispatchTask("T1");

      const gitService = new GitService();
      let rollbackIntegrationRefCalled = false;
      const originalRollback = (gitService as any).rollbackIntegrationRef.bind(gitService);
      (gitService as any).rollbackIntegrationRef = async (proof: any, opts: any) => {
        rollbackIntegrationRefCalled = true;
        return originalRollback(proof, opts);
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.equal(rollbackIntegrationRefCalled, true, "rollbackIntegrationRef must be called on async emit rejection");

      // Verify Git ref rolled back to baseSha
      const currentHead = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(currentHead, s.baseSha, "Git ref must be rolled back to baseSha");

      // Verify scheduler task rolled back to in_review
      const task = scheduler.getTask("T1");
      assert.equal(task?.state, "in_review", "Scheduler task state must be in_review");

      // Verify no unhandled promise rejections
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(unhandledRejections.length, 0, "No unhandledRejection must occur");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      repo.cleanup();
    }
  });

  it("NEW-4: invalid approve verdict is rejected and not appended to eventStore", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-new4-verdict-ordering";
      const s = setupCandidateRepo(repo, runId, "T1");

      const scheduler = new Scheduler(
        [
          {
            id: "T1",
            title: "Task 1",
            role: "bonesetter",
            dependencies: [],
            files: ["src/index.js"],
            acceptanceCommand: "npm test",
          } as any,
        ],
        { runId }
      );
      scheduler.dispatchTask("T1");

      const eventStore = new EventStore();
      const gitService = new GitService();

      // Reviewer returns an invalid approve (fails check passing: checks.install.ok = false)
      const invalidReviewer = async () => ({
        verdict: "approve",
        status: "approve",
        candidateSha: s.candidateSha,
        candidateSha256: s.candidateSha256,
        tree: s.tree,
        reasons: [{ text: "Checks run", refs: ["cmd:test"] }],
        checks: {
          install: { ok: false },
          build: { ok: true },
          accept: { ok: true },
          tests: { ok: true },
          noTestWeakening: { ok: true },
        },
      });

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore,
        wardenReviewer: invalidReviewer,
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "rejected");

      // Verify eventStore does NOT contain any verdict event
      const verdictEvents = eventStore.getEvents(runId).filter((e) => e.kind === "verdict");
      assert.equal(verdictEvents.length, 0, "Rejected approve verdict must never be written to eventStore");
    } finally {
      repo.cleanup();
    }
  });

  it("NEW-4: merge_rollback_failed appends task.state event with state 'merge_rollback_failed' to eventStore", async () => {
    const repo = createRepo();
    try {
      const runId = "ra4-new4-rollback-failed-event";
      const s = setupCandidateRepo(repo, runId, "T1");

      const scheduler = new Scheduler(
        [
          {
            id: "T1",
            title: "Task 1",
            role: "bonesetter",
            dependencies: [],
            files: ["src/index.js"],
            acceptanceCommand: "npm test",
          } as any,
        ],
        { runId }
      );
      scheduler.dispatchTask("T1");

      // Cause scheduler.mergeTask to fail, triggering rollback
      scheduler.mergeTask = () => {
        throw new Error("Simulated scheduler merge failure");
      };

      const gitService = new GitService();
      // Cause rollbackIntegrationRef to fail
      (gitService as any).rollbackIntegrationRef = async () => ({
        ok: false,
        reason: "Simulated lock failure during rollback",
      });

      const eventStore = new EventStore();
      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore,
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "merge_rollback_failed");

      // Verify task.state event with merge_rollback_failed was appended to eventStore
      const failedEvents = eventStore.getEvents(runId).filter(
        (e) => e.kind === "task.state" && (e.data as any)?.state === "merge_rollback_failed"
      );
      assert.equal(failedEvents.length, 1, "Exactly one task.state merge_rollback_failed event must be appended");
      assert.equal(failedEvents[0].taskId, "T1");
      assert.ok(
        String((failedEvents[0].data as any)?.reason).includes("Simulated lock failure during rollback"),
        `Expected failure reason in event data, got: ${JSON.stringify(failedEvents[0].data)}`
      );
    } finally {
      repo.cleanup();
    }
  });
});
