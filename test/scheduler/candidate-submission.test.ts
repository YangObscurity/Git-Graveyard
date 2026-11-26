// Task 13.5 / WP F15 Tests: Candidate submission scan wiring
// Requirements: 22.8, 22.14, 22.15, 42.5

import test, { describe, it } from "node:test";
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
import type { PactTask } from "../../lib/pact/pact-parser";

function createMockPactTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Task 1",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["package.json", "src/index.js"],
      filesInScope: ["package.json", "src/index.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 1,
    },
  ];
}

describe("candidate-submission: scan wiring before gate (WP F15)", () => {
  it("A diff that contains a token is rejected before the gate runs", async () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.dispatchTask("T1");
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "running");

    let gateCalled = false;
    const diffWithSecret = [
      "diff --git a/src/index.js b/src/index.js",
      "--- a/src/index.js",
      "+++ b/src/index.js",
      "@@ -1,1 +1,2 @@",
      " const hello = 'world';",
      '+const token = "ghp_123456789012345678901234567890123456";',
    ].join("\n");

    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      diff: diffWithSecret,
      allowList: ["package.json", "src/index.js"],
      // A mock gate that would set gateCalled to true if invoked
      gateResult: undefined,
      wardenReview: async () => {
        gateCalled = true;
        return { verdict: "approve" };
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.state, "rejected");
    assert.equal(t1.state, "rejected");
    assert.equal(gateCalled, false, "Warden/Gate must not run when secret scan fails");
    assert.ok(res.redactorResult, "redactorResult must be populated");
    assert.equal(res.redactorResult?.hasSecrets, true);
    assert.equal(res.redactorResult?.passed, false);
    assert.ok(
      res.reasons.some((r) => r.includes("Secret violation") || r.includes("ghp_")),
      `Expected reasons to mention secret violation, got: ${res.reasons.join(", ")}`
    );
    assert.equal(res.gateResult, undefined, "gateResult must be undefined before gate runs");
  });

  it("A worktree with an escaping link rejects the candidate before the gate runs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f15-cand-symlink-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "f15-cand-outside-"));

    try {
      const outsideFile = path.join(outsideDir, "escape.txt");
      fs.writeFileSync(outsideFile, "outside content");

      const linkPath = path.join(tmpDir, "symlink-to-escape");
      fs.symlinkSync(outsideFile, linkPath);

      const scheduler = new Scheduler(createMockPactTasks());
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      assert.equal(t1.state, "running");

      const cleanDiff = [
        "diff --git a/src/index.js b/src/index.js",
        "--- a/src/index.js",
        "+++ b/src/index.js",
        "@@ -1,1 +1,2 @@",
        " const hello = 'world';",
        "+const clean = true;",
      ].join("\n");

      let gateCalled = false;
      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        diff: cleanDiff,
        allowList: ["package.json", "src/index.js"],
        candidateWorktree: tmpDir,
        wardenReview: async () => {
          gateCalled = true;
          return { verdict: "approve" };
        },
      });

      assert.equal(res.ok, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.equal(gateCalled, false, "Gate/Warden must not run when symlink scan fails");
      assert.ok(res.symlinkReport, "symlinkReport must be present");
      assert.equal(res.symlinkReport?.passed, false);
      assert.ok(
        res.reasons.some((r) => r.toLowerCase().includes("symlink") || r.toLowerCase().includes("escaping")),
        `Expected reasons to mention symlink escape, got: ${res.reasons.join(", ")}`
      );
      assert.equal(res.gateResult, undefined, "gateResult must be undefined before gate runs");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("A clean diff passes the scan step", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f15-cand-clean-"));
    const gitDir = path.join(tmpDir, "git");
    fs.mkdirSync(gitDir, { recursive: true });

    const runGit = (args: string[]) =>
      childProcess
        .execFileSync("git", args, {
          cwd: gitDir,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        })
        .trim();

    try {
      runGit(["init", "--initial-branch=main", "."]);
      runGit(["config", "user.name", "Test Runner"]);
      runGit(["config", "user.email", "runner@example.test"]);

      fs.writeFileSync(path.join(gitDir, "package.json"), '{\n  "name": "test"\n}\n');
      runGit(["add", "package.json"]);
      runGit(["commit", "-m", "init"]);
      const baseSha = runGit(["rev-parse", "HEAD"]);

      const runId = "run-f15-clean";
      runGit(["branch", `graveyard/${runId}`, baseSha]);

      fs.writeFileSync(path.join(gitDir, "package.json"), '{\n  "name": "test-updated"\n}\n');
      runGit(["add", "package.json"]);
      runGit(["commit", "-m", "candidate"]);
      const candidateSha = runGit(["rev-parse", "HEAD"]);
      const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
      runGit(["branch", "task/T1", candidateSha]);

      const cleanDiff = childProcess.execFileSync(
        "git",
        ["diff", "--binary", "--no-color", baseSha, candidateSha],
        {
          cwd: gitDir,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        }
      );

      const scheduler = new Scheduler(createMockPactTasks(), { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      assert.equal(t1.state, "running");

      const candidateSha256 = candidateSha256FromDiff(cleanDiff);

      // SA1b: a real GitService with its real mergeCandidate; the merge proof
      // handed to the scheduler must be the VerifiedMerge the real merge
      // returns, so the previous mergeCandidate override is removed.
      const gitService = new GitService();

      const events = [
        {
          kind: "verdict",
          taskId: "T1",
          data: {
            taskId: "T1",
            verdict: "approve",
            candidateSha256,
            tree,
          },
        },
        {
          kind: "gate.result",
          taskId: "T1",
          data: {
            taskId: "T1",
            ok: true,
            tree,
          },
        },
      ];

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff: cleanDiff,
        allowList: ["package.json", "src/index.js"],
        candidateSha,
        candidateSha256,
        tree,
        gitDir,
        expectedIntegrationHeadSha: baseSha,
        currentHeadSha: baseSha,
        eventStore: new EventStore(),
        gateResult: { ok: true, tree, reasons: [] },
        wardenReview: async () => ({
          verdict: "approve",
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
        verdict: {
          verdict: "approve",
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
        },
        gitService,
      });

      assert.equal(res.ok, true);
      assert.equal(res.merged, true);
      assert.equal(res.state, "merged");
      assert.equal(t1.state, "merged");
      // Verify scans passed
      assert.ok(res.redactorResult, "redactorResult must exist");
      assert.equal(res.redactorResult.passed, true);
      assert.equal(res.redactorResult.hasSecrets, false);
      if (res.symlinkReport) {
        assert.equal(res.symlinkReport.clean, true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("A candidate diff containing raw tokens without diff prefixes is also rejected", async () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.dispatchTask("T1");

    const rawTokenDiff = "ghp_123456789012345678901234567890123456";
    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      diff: rawTokenDiff,
      allowList: ["package.json", "src/index.js"],
    });

    assert.equal(res.ok, false);
    assert.equal(res.state, "rejected");
    assert.equal(res.redactorResult?.hasSecrets, true);
  });
});
describe("candidate-submission: renamed Python baseline mapping", () => {
  function setupRenameRepo(
    originalPath: string,
    originalContent: string,
    renamedPath: string,
    candidateContent: string
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-rename-sub-"));
    const gitDir = path.join(tmpDir, "git");
    fs.mkdirSync(gitDir, { recursive: true });
    const runGit = (args: string[]) =>
      childProcess
        .execFileSync("git", args, {
          cwd: gitDir,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        })
        .trim();

    runGit(["init", "--initial-branch=main", "."]);
    runGit(["config", "user.name", "Test Runner"]);
    runGit(["config", "user.email", "runner@example.test"]);

    fs.writeFileSync(path.join(gitDir, originalPath), originalContent);
    runGit(["add", originalPath]);
    runGit(["commit", "-m", "init"]);
    const baseSha = runGit(["rev-parse", "HEAD"]);

    const runId = "run-py-rename";
    runGit(["branch", `graveyard/${runId}`, baseSha]);

    runGit(["mv", originalPath, renamedPath]);
    fs.writeFileSync(path.join(gitDir, renamedPath), candidateContent);
    runGit(["add", renamedPath]);
    runGit(["commit", "-m", "candidate"]);
    const candidateSha = runGit(["rev-parse", "HEAD"]);
    const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
    runGit(["branch", "task/T1", candidateSha]);

    const diff = childProcess.execFileSync(
      "git",
      ["diff", "--binary", "--no-color", baseSha, candidateSha],
      {
        cwd: gitDir,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      }
    );

    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Py Rename Task",
        role: "bonesetter",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: [originalPath, renamedPath],
        filesInScope: [originalPath, renamedPath],
        acceptanceCommand: "pytest",
        accept: "pytest",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M1"],
        ruleIds: ["M1"],
        line: 1,
      },
    ];

    return {
      tmpDir,
      gitDir,
      baseSha,
      candidateSha,
      tree,
      runId,
      diff,
      tasks,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  function approveWarden(
    repo: ReturnType<typeof setupRenameRepo>,
    candidateSha256: string
  ) {
    return async () => ({
      verdict: "approve" as const,
      candidateSha: repo.candidateSha,
      candidateSha256,
      tree: repo.tree,
      reasons: [{ text: "ok", refs: ["cmd:test"] }],
      checks: {
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
        noTestWeakening: { ok: true },
      },
    });
  }

  it("accepts a rename of a legacy Python 2 file whose residue is unchanged", async () => {
    const repo = setupRenameRepo(
      "legacy_a.py",
      'print "hi"\n',
      "legacy_b.py",
      'print "hi"\n'
    );
    try {
      const scheduler = new Scheduler(repo.tasks, { runId: repo.runId });
      scheduler.dispatchTask("T1");
      const candidateSha256 = candidateSha256FromDiff(repo.diff);
      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId: repo.runId,
        diff: repo.diff,
        allowList: ["legacy_a.py", "legacy_b.py"],
        candidateSha: repo.candidateSha,
        candidateSha256,
        tree: repo.tree,
        gitDir: repo.gitDir,
        expectedIntegrationHeadSha: repo.baseSha,
        currentHeadSha: repo.baseSha,
        eventStore: new EventStore(),
        gitService: new GitService(),
        wardenReview: approveWarden(repo, candidateSha256),
      });
      assert.ok(
        !res.reasons.some((r) => r.includes("gate_residue_not_reduced")),
        `rename baseline should not be treated as new residue: ${res.reasons.join(", ")}`
      );
      assert.equal(res.ok, true);
      assert.equal(res.merged, true);
    } finally {
      repo.cleanup();
    }
  });

  it("rejects a rename that adds new Python 2 residue to the renamed file", async () => {
    const repo = setupRenameRepo(
      "legacy_a.py",
      'print "hi"\n',
      "legacy_b.py",
      'print "hi"\nprint "yo"\n'
    );
    try {
      const scheduler = new Scheduler(repo.tasks, { runId: repo.runId });
      scheduler.dispatchTask("T1");
      const candidateSha256 = candidateSha256FromDiff(repo.diff);
      let wardenCalled = false;
      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId: repo.runId,
        diff: repo.diff,
        allowList: ["legacy_a.py", "legacy_b.py"],
        candidateSha: repo.candidateSha,
        candidateSha256,
        tree: repo.tree,
        gitDir: repo.gitDir,
        expectedIntegrationHeadSha: repo.baseSha,
        currentHeadSha: repo.baseSha,
        eventStore: new EventStore(),
        gitService: new GitService(),
        wardenReview: async () => {
          wardenCalled = true;
          return { verdict: "approve" };
        },
      });
      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "rejected");
      assert.equal(wardenCalled, false, "gate must reject before Warden review");
      assert.ok(
        res.reasons.some((r) => r.includes("gate_residue_not_reduced")),
        `expected residue rejection: ${res.reasons.join(", ")}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("keeps an empty Python baseline when a non-Python file is renamed to .py", async () => {
    const repo = setupRenameRepo(
      "notes.txt",
      'print "hi"\n',
      "legacy.py",
      'print "hi"\n'
    );
    try {
      const scheduler = new Scheduler(repo.tasks, { runId: repo.runId });
      scheduler.dispatchTask("T1");
      const candidateSha256 = candidateSha256FromDiff(repo.diff);
      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId: repo.runId,
        diff: repo.diff,
        allowList: ["notes.txt", "legacy.py"],
        candidateSha: repo.candidateSha,
        candidateSha256,
        tree: repo.tree,
        gitDir: repo.gitDir,
        expectedIntegrationHeadSha: repo.baseSha,
        currentHeadSha: repo.baseSha,
        eventStore: new EventStore(),
        gitService: new GitService(),
        wardenReview: async () => ({ verdict: "approve" }),
      });
      assert.equal(res.ok, false);
      assert.ok(
        res.reasons.some((r) => r.includes("gate_residue_not_reduced")),
        `non-Python rename must not supply a Python baseline: ${res.reasons.join(", ")}`
      );
    } finally {
      repo.cleanup();
    }
  });
});

