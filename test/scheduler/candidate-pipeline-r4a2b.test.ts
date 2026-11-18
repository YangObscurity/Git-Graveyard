// candidate-pipeline-r4a2b.test.ts
// Verification of R4-A2b2 remediation (audit B-3, N-3, N-5)

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { GitService, VerifiedMerge } from "../../lib/git/git-service";
import { onSubmit } from "../../lib/scheduler/candidate-submission";
import { EventStore } from "../../lib/events/event-store";
import { Scheduler } from "../../lib/scheduler/scheduler";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

interface TestGitRepo {
  dir: string;
  runGit: (args: string[]) => string;
  getDiff: (from: string, to: string) => string;
  cleanup: () => void;
}

function createRepo(): TestGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-r4a2b-"));
  const runGit = (args: string[]) =>
    childProcess
      .execFileSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      })
      .trim();

  const getDiff = (from: string, to: string) =>
    childProcess.execFileSync("git", ["diff", from, to], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Worker"]);
  runGit(["config", "user.email", "worker@graveyard"]);

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

  return {
    dir,
    runGit,
    getDiff,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function createEvidenceEvents(
  taskId: string,
  candidateSha256: string,
  tree: string
) {
  return [
    {
      kind: "verdict",
      taskId,
      data: {
        taskId,
        verdict: "approve",
        candidateSha256,
        tree,
      },
    },
    {
      kind: "gate.result",
      taskId,
      data: {
        taskId,
        ok: true,
        tree,
      },
    },
  ];
}

describe("candidate-pipeline-r4a2b: git merge proof, ancestor verification, and guarded rollback (B-3, N-3, N-5)", () => {
  it("a successful merge reaches merged only after the proof", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2b-proof-success";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const baseHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 1;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Implement T1"]);

      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(baseHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
        {
          id: "T2",
          title: "Task 2",
          role: "bonesetter",
          dependencies: ["T1"],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      const t2 = scheduler.getTask("T2")!;

      let evidenceReceivedByScheduler: any = null;
      const originalMergeTask = scheduler.mergeTask.bind(scheduler);
      scheduler.mergeTask = (taskId: string, evidence?: any) => {
        evidenceReceivedByScheduler = evidence;
        return originalMergeTask(taskId, evidence);
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: createEvidenceEvents("T1", candidateSha256, tree),
        wardenReviewer: async () => ({
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
        }),
      });

      assert.equal(res.ok, true);
      assert.equal(res.merged, true);
      assert.equal(res.state, "merged");
      assert.equal(t1.state, "merged");
      // Dependent task T2 is released to ready
      assert.equal(t2.state, "ready");

      // Verify that proof was attached and verified
      assert.ok(evidenceReceivedByScheduler !== null);
      assert.ok(evidenceReceivedByScheduler.gitMerge !== undefined);
      assert.equal(evidenceReceivedByScheduler.gitMerge.candidateSha, candidateSha);
      assert.ok(evidenceReceivedByScheduler.gitMerge instanceof VerifiedMerge);
      assert.equal(evidenceReceivedByScheduler.gitMerge.newHeadSha, candidateSha);

      // Verify integration ref in git
      const finalHeadSha = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(finalHeadSha, candidateSha);
    } finally {
      repo.cleanup();
    }
  });

  it("a candidate that is not in the head is refused with no state change", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2b-not-ancestor";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const initialHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      // Create task branch directly from graveyard head
      repo.runGit(["checkout", "-b", "task/T1", `graveyard/${runId}`]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 2;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Valid candidate commit"]);
      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);

      // Switch back to graveyard branch
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(initialHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
        {
          id: "T2",
          title: "Task 2",
          role: "bonesetter",
          dependencies: ["T1"],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      const t2 = scheduler.getTask("T2")!;

      // Use real GitService mergeCandidate (VerifiedMerge), but simulate non-zero exit for merge-base --is-ancestor
      const gitService = new GitService();
      const originalExecGit = gitService.execGit.bind(gitService);
      gitService.execGit = async (args: string[], options?: any) => {
        if (args.includes("merge-base")) {
          return { exitCode: 1, stdout: "", stderr: "not ancestor" };
        }
        return originalExecGit(args, options);
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        candidateSha,
        eventStore: new EventStore(),
        events: createEvidenceEvents("T1", candidateSha256, tree),
        wardenReviewer: async () => ({
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
        }),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.equal(res.reason, "merge not verified in integration head");

      // Task state remains in_review; NO transition to merged
      assert.equal(t1.state, "in_review");
      // Dependent task T2 remains pending, NOT released
      assert.equal(t2.state, "pending");

      // Integration branch was not moved or was rolled back
      const finalHead = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(finalHead, initialHeadSha);
    } finally {
      repo.cleanup();
    }
  });

  it("a failed scheduler merge rolls the ref back and leaves the task in_review", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2b-sched-fail";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const initialHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 3;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Implement T1"]);

      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(initialHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
        {
          id: "T2",
          title: "Task 2",
          role: "bonesetter",
          dependencies: ["T1"],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      const t2 = scheduler.getTask("T2")!;

      // Simulate scheduler mergeTask failure
      scheduler.mergeTask = () => {
        throw new Error("Simulated scheduler state store write error");
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: createEvidenceEvents("T1", candidateSha256, tree),
        wardenReviewer: async () => ({
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
        }),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.ok(
        res.reason?.includes("Failed to apply task merged state"),
        `Expected error message about state apply, got: ${res.reason}`
      );

      // Task remains in_review
      assert.equal(t1.state, "in_review");
      // Dependent remains pending
      assert.equal(t2.state, "pending");

      // Verify ref was rolled back to initialHeadSha
      const currentHead = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(currentHead, initialHeadSha);
    } finally {
      repo.cleanup();
    }
  });

  it("a failed rollback returns merge_rollback_failed", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2b-rollback-fail";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const initialHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 4;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Implement T1"]);

      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(initialHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
        {
          id: "T2",
          title: "Task 2",
          role: "bonesetter",
          dependencies: ["T1"],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      const t2 = scheduler.getTask("T2")!;

      // Fail scheduler merge
      scheduler.mergeTask = () => {
        throw new Error("Simulated scheduler merge failure");
      };

      // Wrap gitService so that update-ref fails only during rollback (after mergeCandidate)
      const gitService = new GitService();
      let mergeCandidateDone = false;
      const originalMergeCandidate = (gitService as any).mergeCandidate.bind(
        gitService
      );
      (gitService as any).mergeCandidate = async (opts: any) => {
        const res = await originalMergeCandidate(opts);
        mergeCandidateDone = true;
        return res;
      };

      (gitService as any).rollbackIntegrationRef = async () => ({
        ok: false,
        reason: "fatal: update_ref failed: lock table full",
      });

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        gitService,
        eventStore: new EventStore(),
        events: createEvidenceEvents("T1", candidateSha256, tree),
        wardenReviewer: async () => ({
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
        }),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "merge_rollback_failed");
      assert.ok(
        res.reason?.includes("Rollback update-ref failed") ||
          res.reason?.includes("lock table full"),
        `Expected rollback error reason, got: ${res.reason}`
      );

      // Dependent remains pending (release no dependent)
      assert.equal(t2.state, "pending");
    } finally {
      repo.cleanup();
    }
  });

  it("guarded rollback fails with merge_rollback_failed if ref was concurrently modified", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2b-concurrent-rollback";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const initialHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 5;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Implement T1"]);

      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(initialHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
        {
          id: "T2",
          title: "Task 2",
          role: "bonesetter",
          dependencies: ["T1"],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      const t2 = scheduler.getTask("T2")!;

      // Fail scheduler merge AND advance the branch concurrently to break expected old value
      scheduler.mergeTask = () => {
        // Concurrently advance the graveyard branch so guarded update-ref expected value mismatches
        repo.runGit(["commit", "--allow-empty", "-m", "Concurrent commit on integration branch"]);
        throw new Error("Simulated scheduler merge failure");
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: createEvidenceEvents("T1", candidateSha256, tree),
        wardenReviewer: async () => ({
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
        }),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "merge_rollback_failed");
      assert.ok(
        res.reason?.includes("update-ref") || res.reason?.includes("Rollback"),
        `Expected rollback error reason, got: ${res.reason}`
      );

      // Dependent remains pending (release no dependent)
      assert.equal(t2.state, "pending");
    } finally {
      repo.cleanup();
    }
  });
});
