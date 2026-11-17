// candidate-submission-sa1.test.ts
// Work package SA1 (candidate side): validated reviewer verdict, real GitService
// only, no fallback refs, strict ref and sha checks, real diff binding,
// required runId, candidate tree must be a string.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitService } from "../../lib/git/git-service";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-sa1-"));
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
      } catch {
        // best effort cleanup
      }
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

// Base commit on graveyard/<runId>, candidate commit on refs/heads/task/<taskId>
function setupCandidate(repo: TestRepo, runId: string, taskId: string): {
  baseSha: string;
  candidateSha: string;
  tree: string;
  diff: string;
  candidateSha256: string;
} {
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

  runGit(["checkout", "-b", `task/${taskId}`]);
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

function createScheduler(runId?: string): Scheduler {
  return new Scheduler([
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
  ], runId ? { runId } : undefined);
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

function evidenceEvents(
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

describe("candidate-submission-sa1 (validated verdict, real GitService, strict refs, real diff binding, runId, string tree)", () => {
  it("a bare approve is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-bare-approve";
      const s = setupCandidate(repo, runId, "T1");
      const scheduler = createScheduler();
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: evidenceEvents("T1", s.candidateSha256, s.tree),
        wardenReviewer: async () => ({ verdict: "approve" }),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        res.reasons.some(
          (r) => r.includes("candidateSha256") || r.includes("reasons")
        ),
        `Expected validateWardenVerdict failure reasons, got: ${res.reasons.join(", ")}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a fake gitService object is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-fake-git-service";
      const s = setupCandidate(repo, runId, "T1");
      const scheduler = createScheduler();
      scheduler.dispatchTask("T1");

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: evidenceEvents("T1", s.candidateSha256, s.tree),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
        // Duck-typed git service object (old gitMerger style) must be rejected
        gitService: {
          mergeCandidate: async () => ({
            ok: true,
            merged: true,
            candidateSha: s.candidateSha,
            integrationHeadSha: s.candidateSha,
          }),
        } as any,
      });

      assert.equal(res.ok, false);
      assert.equal(res.state, "rejected");
      assert.ok(
        res.reason?.includes("instance of GitService"),
        `Expected gitService instance rejection, got: ${res.reason}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a missing task ref is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-missing-task-ref";
      // Base commit and integration branch exist, but no task/<id> ref
      const { dir } = repo;
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "src", "index.js"),
        "const initial = 0;\nmodule.exports = { initial };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Initial commit"]);
      repo.runGit(["branch", `graveyard/${runId}`]);

      const scheduler = createScheduler();
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: "",
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        wardenReviewer: async () => ({ verdict: "approve" }),
      });

      assert.equal(res.ok, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        res.reason?.includes("missing task ref"),
        `Expected missing task ref error, got: ${res.reason}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a ref segment starting with a dash is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-dash-segment";
      const { dir } = repo;
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "src", "index.js"),
        "const initial = 0;\nmodule.exports = { initial };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Initial commit"]);
      repo.runGit(["branch", `graveyard/${runId}`]);

      // No scheduler: the invalid taskId has no task to reject
      const res = await onSubmit({
        taskId: "-bad",
        runId,
        diff: "",
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        wardenReviewer: async () => ({ verdict: "approve" }),
      });

      assert.equal(res.ok, false);
      assert.equal(res.state, "rejected");
      assert.ok(
        res.reason?.includes("refs/heads/task/-bad"),
        `Expected invalid candidate ref error, got: ${res.reason}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a caller diff that differs from the real diff is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-diff-binding";
      const s = setupCandidate(repo, runId, "T1");
      const scheduler = createScheduler();
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      // Tamper with the caller diff content; the real git diff is untouched
      const tamperedDiff = s.diff.replace(
        "const valid = 1;",
        "const tampered = 42;"
      );
      assert.notEqual(tamperedDiff, s.diff);

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: tamperedDiff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: evidenceEvents("T1", s.candidateSha256, s.tree),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        res.reason?.includes("does not match the real git diff"),
        `Expected real diff binding rejection, got: ${res.reason}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a missing runId is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-missing-runid";
      const s = setupCandidate(repo, runId, "T1");
      const scheduler = createScheduler();
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        // no runId and no run.id
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: evidenceEvents("T1", s.candidateSha256, s.tree),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        res.reason?.includes("runId is required"),
        `Expected required runId rejection, got: ${res.reason}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a non-zero ancestor exit is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-ancestor-nonzero";
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

      // Candidate commit on task branch
      runGit(["checkout", "-b", "task/T1", `graveyard/${runId}`]);
      fs.writeFileSync(
        path.join(dir, "src", "index.js"),
        "const valid = 2;\nmodule.exports = { valid };\n"
      );
      runGit(["add", "src/index.js"]);
      runGit(["commit", "-m", "Candidate commit"]);
      const candidateSha = runGit(["rev-parse", "HEAD"]);
      const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
      runGit(["checkout", `graveyard/${runId}`]);

      const diff = gitDiff(repo, baseSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = createScheduler(runId);
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
        eventStore: new EventStore(),
        events: evidenceEvents("T1", candidateSha256, tree),
        wardenReviewer: passingReviewer(candidateSha, candidateSha256, tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.equal(
        res.reason,
        "merge not verified in integration head"
      );
      assert.equal(t1.state, "in_review");
      assert.equal(t2.state, "pending");

      // Integration ref unchanged
      const finalHead = runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(finalHead, baseSha);
    } finally {
      repo.cleanup();
    }
  });

  it("a Map tree is rejected", async () => {
    const repo = createRepo();
    try {
      const runId = "sa1-map-tree";
      const s = setupCandidate(repo, runId, "T1");
      const scheduler = createScheduler();
      scheduler.dispatchTask("T1");

      const baseReport: Record<string, unknown> = {
        scheduler,
        taskId: "T1",
        runId,
        diff: s.diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: new EventStore(),
        events: evidenceEvents("T1", s.candidateSha256, s.tree),
        wardenReviewer: passingReviewer(s.candidateSha, s.candidateSha256, s.tree),
      };

      const mapReport = { ...baseReport, candidateTree: new Map() };
      const resMap = await onSubmit(mapReport as any);
      assert.equal(resMap.ok, false);
      assert.equal(resMap.state, "rejected");
      assert.ok(
        resMap.reason?.includes("candidate.tree must be a string"),
        `Expected Map tree rejection, got: ${resMap.reason}`
      );

      scheduler.dispatchTask("T1");
      const recordReport = { ...baseReport, candidateTree: { sha: s.tree } };
      const resRecord = await onSubmit(recordReport as any);
      assert.equal(resRecord.ok, false);
      assert.equal(resRecord.state, "rejected");
      assert.ok(
        resRecord.reason?.includes("candidate.tree must be a string"),
        `Expected Record tree rejection, got: ${resRecord.reason}`
      );
    } finally {
      repo.cleanup();
    }
  });
});
