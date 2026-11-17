// Review findings test suite: B-1, B-2, B-3, H-5, H-6, M-13
// Work package R3-A / R4-A1 remediation; SA1b follow-up: every test runs
// against a real GitService on a real git repository (git init in a temp dir)
// and every approve verdict passes validateWardenVerdict with all checks.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { onSubmit, NO_REVIEWER_INJECTED } from "../../lib/scheduler/candidate-submission";
import { GitService } from "../../lib/git/git-service";
import { EventStore } from "../../lib/events/event-store";
import { Scheduler } from "../../lib/scheduler/scheduler";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type { PactTask } from "../../lib/pact/pact-parser";

interface TestGitRepo {
  dir: string;
  runGit: (args: string[]) => string;
  getDiffBinary: (from: string, to: string) => string;
  cleanup: () => void;
}

function createRepo(): TestGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-r3-"));
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

  // Same flags the pipeline uses for the real diff binding (Step 4b).
  // No trim: the verdict candidateSha256 must be hashed over the exact raw
  // diff bytes, matching GitService.mergeCandidate's untrimmed diff stdout.
  const getDiffBinary = (from: string, to: string) =>
    childProcess.execFileSync(
      "git",
      ["diff", "--binary", "--no-color", from, to],
      {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      }
    );

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Worker"]);
  runGit(["config", "user.email", "worker@graveyard"]);

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-pkg" }, null, 2)
  );
  runGit(["add", "package.json"]);
  runGit(["commit", "-m", "Initial commit"]);

  return {
    dir,
    runGit,
    getDiffBinary,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function createPactTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Task 1",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["package.json", "src/index.js", "src/deprecated.js"],
      filesInScope: ["package.json", "src/index.js", "src/deprecated.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 1,
    },
    {
      id: "T2",
      title: "Task 2 (dependent)",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["src/index.js"],
      filesInScope: ["src/index.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M2"],
      ruleIds: ["M2"],
      line: 10,
    },
  ];
}

// A reviewer result that passes validateWardenVerdict and carries install,
// build, accept and tests all passing (audit N-A1, N-A4).
function approveVerdict(
  candidateSha: string,
  candidateSha256: string,
  tree: string
) {
  return {
    verdict: "approve",
    status: "approve",
    candidateSha,
    candidateSha256,
    tree,
    reasons: [
      {
        text: "Install, build, accept and tests all passed (Requirement 24.5)",
        refs: ["cmd:test"],
      },
    ],
    evidenceRefs: ["cmd:test"],
    checks: {
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      noTestWeakening: { ok: true },
    },
  };
}

function addValidIndexJs(repo: TestGitRepo, content: string): void {
  fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, "src", "index.js"), content);
  repo.runGit(["add", "src/index.js"]);
  repo.runGit(["commit", "-m", "Add src/index.js"]);
}

describe("candidate-pipeline-r3 (B-1, B-2, B-3, H-5, H-6, M-13)", () => {
  it("a caller-supplied gateResult or verdict has no effect", async () => {
    // Case 1 repo: candidate contains broken JavaScript so the real gate fails
    const brokenRepo = createRepo();
    // Case 2 & 3 repo: candidate contains valid JavaScript
    const validRepo = createRepo();

    try {
      const runIdBroken = "run-r3-caller-gate";
      brokenRepo.runGit(["checkout", "-b", `graveyard/${runIdBroken}`]);
      const brokenBase = brokenRepo.runGit(["rev-parse", "HEAD"]);
      brokenRepo.runGit(["checkout", "-b", "task/T1"]);
      addValidIndexJs(brokenRepo, "const broken = {{{ syntax error here;\n");
      const brokenCandidateSha = brokenRepo.runGit(["rev-parse", "HEAD"]);
      const brokenTree = brokenRepo.runGit([
        "rev-parse",
        `${brokenCandidateSha}^{tree}`,
      ]);
      brokenRepo.runGit(["checkout", `graveyard/${runIdBroken}`]);

      const brokenDiff = brokenRepo.getDiffBinary(brokenBase, brokenCandidateSha);

      // Case 1: Caller supplies gateResult: { ok: true }, but real gate syntax check fails
      const scheduler1 = new Scheduler(createPactTasks());
      scheduler1.dispatchTask("T1");
      const res1 = await onSubmit({
        scheduler: scheduler1,
        taskId: "T1",
        runId: runIdBroken,
        candidateSha: brokenCandidateSha,
        diff: brokenDiff,
        allowList: ["src/index.js"],
        gitService: new GitService(),
        gitDir: brokenRepo.dir,
        eventStore: new EventStore(),
        // Caller-supplied gateResult should have NO effect
        gateResult: { ok: true, tree: brokenTree, reasons: [] },
        wardenReviewer: async () =>
          approveVerdict(
            brokenCandidateSha,
            candidateSha256FromDiff(brokenDiff),
            brokenTree
          ),
      });

      assert.equal(res1.ok, false);
      assert.equal(res1.state, "rejected");
      assert.ok(
        res1.reasons.some((r) => r.includes("Unexpected token") || r.includes("syntax")),
        "Real gate syntax failure must be used, not caller-supplied gateResult"
      );

      const runIdValid = "run-r3-caller-verdict";
      validRepo.runGit(["checkout", "-b", `graveyard/${runIdValid}`]);
      const validBase = validRepo.runGit(["rev-parse", "HEAD"]);
      validRepo.runGit(["checkout", "-b", "task/T1"]);
      addValidIndexJs(validRepo, "const x = 1;\nmodule.exports = { x };\n");
      const validCandidateSha = validRepo.runGit(["rev-parse", "HEAD"]);
      const validTree = validRepo.runGit([
        "rev-parse",
        `${validCandidateSha}^{tree}`,
      ]);
      validRepo.runGit(["checkout", `graveyard/${runIdValid}`]);

      const validDiff = validRepo.getDiffBinary(validBase, validCandidateSha);
      const validSha256 = candidateSha256FromDiff(validDiff);

      // Case 2: Caller supplies verdict: { verdict: 'approve' }, but injected wardenReviewer rejects
      const scheduler2 = new Scheduler(createPactTasks());
      scheduler2.dispatchTask("T1");
      const res2 = await onSubmit({
        scheduler: scheduler2,
        taskId: "T1",
        runId: runIdValid,
        candidateSha: validCandidateSha,
        diff: validDiff,
        allowList: ["src/index.js"],
        gitService: new GitService(),
        gitDir: validRepo.dir,
        eventStore: new EventStore(),
        // Caller-supplied verdict should have NO effect
        verdict: {
          verdict: "approve",
          candidateSha: validCandidateSha,
          candidateSha256: validSha256,
          tree: validTree,
        },
        wardenReviewer: async () => ({
          verdict: "reject",
          status: "reject",
          candidateSha: validCandidateSha,
          candidateSha256: validSha256,
          tree: validTree,
          reasons: ["Real reviewer rejection reason"],
        }),
      });

      assert.equal(res2.ok, false);
      assert.equal(res2.state, "rejected");
      assert.ok(
        res2.reasons.some((r) => r.includes("Real reviewer rejection")),
        "Injected reviewer verdict must be used, not caller-supplied verdict"
      );

      // Case 3: Caller supplies verdict: { verdict: 'approve' } with NO reviewer injected
      const scheduler3 = new Scheduler(createPactTasks());
      scheduler3.dispatchTask("T1");
      const res3 = await onSubmit({
        scheduler: scheduler3,
        taskId: "T1",
        runId: runIdValid,
        candidateSha: validCandidateSha,
        diff: validDiff,
        allowList: ["src/index.js"],
        gitService: new GitService(),
        gitDir: validRepo.dir,
        eventStore: new EventStore(),
        verdict: {
          verdict: "approve",
          candidateSha: validCandidateSha,
          candidateSha256: validSha256,
          tree: validTree,
        },
      });

      assert.equal(res3.ok, false);
      assert.equal(res3.state, "rejected");
      assert.ok(
        res3.reasons.some((r) => r.includes(NO_REVIEWER_INJECTED)),
        "Must reject with NO_REVIEWER_INJECTED even when caller supplies verdict"
      );
    } finally {
      brokenRepo.cleanup();
      validRepo.cleanup();
    }
  });

  it("a missing reviewer rejects", async () => {
    const repo = createRepo();
    try {
      const runId = "run-r3-no-reviewer";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const baseSha = repo.runGit(["rev-parse", "HEAD"]);
      repo.runGit(["checkout", "-b", "task/T1"]);
      addValidIndexJs(repo, "const x = 1;\nmodule.exports = { x };\n");
      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiffBinary(baseSha, candidateSha);

      const scheduler = new Scheduler(createPactTasks());
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      assert.equal(t1.state, "running");

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        candidateSha,
        diff,
        allowList: ["src/index.js"],
        gitService: new GitService(),
        gitDir: repo.dir,
        eventStore: new EventStore(),
        // No reviewer passed
      });

      assert.equal(res.ok, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        res.reasons.some((r) => r.includes(NO_REVIEWER_INJECTED)),
        `Expected reasons to mention ${NO_REVIEWER_INJECTED}, got: ${res.reasons.join(", ")}`
      );
      assert.ok(
        res.reason?.includes(NO_REVIEWER_INJECTED),
        `Expected reason to mention ${NO_REVIEWER_INJECTED}, got: ${res.reason}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a git merge failure leaves the task in_review and releases nothing", async () => {
    const repo = createRepo();
    try {
      const scheduler = new Scheduler(createPactTasks());
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      const t2 = scheduler.getTask("T2")!;

      assert.equal(t1.state, "running");
      assert.equal(t2.state, "pending");

      const runId = "run-r3-merge-failure";
      const initialSha = repo.runGit(["rev-parse", "HEAD"]);

      // Integration branch moves to its own commit on src/index.js
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      addValidIndexJs(repo, "const integration = 'A';\nmodule.exports = { integration };\n");
      const headSha = repo.runGit(["rev-parse", "HEAD"]);

      // Candidate branches from the initial commit: a real, divergent commit
      // that is NOT a descendant of the integration head, so the real
      // GitService merge (fast-forward) fails on the ancestor check.
      repo.runGit(["checkout", "-b", "task/T1", initialSha]);
      addValidIndexJs(repo, "const candidate = 'B';\nmodule.exports = { candidate };\n");
      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiffBinary(headSha, candidateSha);

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        candidateSha,
        diff,
        allowList: ["src/index.js"],
        gitService: new GitService(),
        gitDir: repo.dir,
        eventStore: new EventStore(),
        wardenReviewer: async () =>
          approveVerdict(candidateSha, candidateSha256FromDiff(diff), tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.ok(
        res.reason?.includes("not a direct descendant"),
        `Expected the real GitService merge to fail the ancestor check, got: ${res.reason}`
      );
      const realMergeResult = res.mergeResult as { merged?: boolean; reason?: string };
      assert.equal(realMergeResult.merged, false);

      // Task T1 must remain in_review, not merged
      assert.equal(t1.state, "in_review");

      // Dependent task T2 must remain pending, NOT released to ready
      assert.equal(t2.state, "pending");

      // No tasks should be ready to dispatch
      assert.deepEqual(scheduler.getReadyTasks(), []);
    } finally {
      repo.cleanup();
    }
  });

  it("a failure after a successful merge resets the ref", async () => {
    const repo = createRepo();
    try {
      const scheduler = new Scheduler(createPactTasks());
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      const runId = "run-r3-rollback";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const previousHeadSha = repo.runGit(["rev-parse", "HEAD"]);
      repo.runGit(["checkout", "-b", "task/T1"]);
      addValidIndexJs(repo, "const x = 1;\nmodule.exports = { x };\n");
      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiffBinary(previousHeadSha, candidateSha);

      // Real GitService with a recording wrapper around rollbackIntegrationRef
      const gitService = new GitService();
      const rollbackCalls: any[] = [];
      const realRollback = gitService.rollbackIntegrationRef.bind(gitService);
      (gitService as any).rollbackIntegrationRef = async (
        proof: any,
        options: any
      ) => {
        const callArgs = [proof, options];
        (callArgs as any).proof = proof;
        (callArgs as any).runId = proof?.runId;
        (callArgs as any).previousHeadSha = proof?.previousHeadSha;
        (callArgs as any).candidateSha = proof?.candidateSha;
        rollbackCalls.push(callArgs);
        return realRollback(proof, options);
      };

      // Simulate scheduler failing to apply state after git merge has succeeded
      scheduler.mergeTask = () => {
        throw new Error("Simulated state store transaction crash");
      };

      const res = await onSubmit({
        scheduler,
        runId,
        taskId: "T1",
        candidateSha,
        diff,
        allowList: ["src/index.js"],
        gitService,
        gitDir: repo.dir,
        expectedIntegrationHeadSha: previousHeadSha,
        eventStore: new EventStore(),
        wardenReviewer: async () =>
          approveVerdict(candidateSha, candidateSha256FromDiff(diff), tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "in_review");
      assert.ok(
        res.reason?.includes("Failed to apply task merged state"),
        `Expected reason to note post-merge failure, got: ${res.reason}`
      );

      // Verify rollbackIntegrationRef was invoked with runId, previousHeadSha, candidateSha
      assert.equal(rollbackCalls.length, 1);
      const [rollbackProof] = rollbackCalls[0];
      assert.equal(rollbackProof.runId, runId);
      assert.equal(rollbackProof.previousHeadSha, previousHeadSha);
      assert.equal(rollbackProof.candidateSha, candidateSha);

      // The real integration branch must point back at the previous head
      assert.equal(
        repo.runGit(["rev-parse", "refs/heads/graveyard/" + runId]),
        previousHeadSha
      );
      assert.equal(t1.state, "in_review");
    } finally {
      repo.cleanup();
    }
  });

  it("a deletion-only candidate merges", async () => {
    const repo = createRepo();
    try {
      const runId = "run-r3-deletion";
      const scheduler = new Scheduler(createPactTasks(), { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);

      // Base contains the file that the candidate deletes
      fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(repo.dir, "src", "deprecated.js"),
        "export const deprecated = true;\n"
      );
      repo.runGit(["add", "src/deprecated.js"]);
      repo.runGit(["commit", "-m", "Add src/deprecated.js"]);
      const headSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      repo.runGit(["rm", "src/deprecated.js"]);
      repo.runGit(["commit", "-m", "Delete src/deprecated.js"]);
      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const deletionDiff = repo.getDiffBinary(headSha, candidateSha);

      // Real GitService with a recording wrapper around the real execGit
      const gitService = new GitService();
      const gitShowCalls: string[] = [];
      const realExecGit = gitService.execGit.bind(gitService);
      (gitService as any).execGit = async (args: string[]) => {
        if (args.includes("show")) {
          const showTarget = args[args.indexOf("show") + 1] || "";
          gitShowCalls.push(showTarget);
        }
        return realExecGit(args);
      };

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        candidateSha,
        diff: deletionDiff,
        allowList: ["src/deprecated.js"],
        gitService,
        gitDir: repo.dir,
        expectedIntegrationHeadSha: headSha,
        eventStore: new EventStore(),
        wardenReviewer: async () =>
          approveVerdict(
            candidateSha,
            candidateSha256FromDiff(deletionDiff),
            tree
          ),
      });

      assert.equal(res.ok, true);
      assert.equal(res.merged, true);
      assert.equal(res.state, "merged");
      assert.equal(t1.state, "merged");

      const gatePassedDeletions = (res.gateResult as any)?.deletions || [];
      const gatePassedFilesCount = (res.gateResult as any)?.files?.length ?? -1;

      // H-6: deleted paths are passed to gate as deletions
      assert.ok(
        gatePassedDeletions.includes("src/deprecated.js"),
        "Deleted file must be passed in deletions array"
      );
      assert.equal(gatePassedFilesCount, 0, "No content files should be passed for deletion-only candidate");

      // H-6: deleted paths content is NOT read via git show
      assert.ok(
        !gitShowCalls.some((c) => c.includes("src/deprecated.js")),
        `execGitShow must not be called for deleted file, called shows: ${gitShowCalls.join(", ")}`
      );
    } finally {
      repo.cleanup();
    }
  });

  it("a tree mismatch rejects", async () => {
    const repo = createRepo();
    try {
      const scheduler = new Scheduler(createPactTasks());
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      const runId = "run-r3-tree-mismatch";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const baseSha = repo.runGit(["rev-parse", "HEAD"]);
      repo.runGit(["checkout", "-b", "task/T1"]);
      addValidIndexJs(repo, "const x = 1;\nmodule.exports = { x };\n");
      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const candidateTree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      const wrongVerdictTree = "b222222222222222222222222222222222222222";
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiffBinary(baseSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      // Case 1: Verdict specifies a mismatched tree SHA
      const resMismatch = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        candidateSha,
        diff,
        allowList: ["src/index.js"],
        gitService: new GitService(),
        gitDir: repo.dir,
        expectedIntegrationHeadSha: baseSha,
        eventStore: new EventStore(),
        wardenReviewer: async () =>
          approveVerdict(candidateSha, candidateSha256, wrongVerdictTree), // tree mismatch
      });

      assert.equal(resMismatch.ok, false);
      assert.equal(resMismatch.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        resMismatch.reasons.some((r) => r.includes("does not match candidate tree")),
        `Expected tree mismatch reason, got: ${resMismatch.reasons.join(", ")}`
      );

      // Case 2: Verdict omits tree entirely (H-5: no self-comparison pass)
      scheduler.dispatchTask("T1");
      const resMissing = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        candidateSha,
        diff,
        allowList: ["src/index.js"],
        gitService: new GitService(),
        gitDir: repo.dir,
        expectedIntegrationHeadSha: baseSha,
        eventStore: new EventStore(),
        wardenReviewer: async () => {
          const verdict = approveVerdict(
            candidateSha,
            candidateSha256,
            candidateTree
          ) as Record<string, unknown>;
          delete verdict.tree;
          return verdict;
          // tree is omitted
        },
      });

      assert.equal(resMissing.ok, false);
      assert.equal(resMissing.state, "rejected");
      assert.ok(
        resMissing.reasons.some((r) => r.includes("Verdict tree is missing")),
        `Expected tree missing reason, got: ${resMissing.reasons.join(", ")}`
      );
    } finally {
      repo.cleanup();
    }
  });
});
