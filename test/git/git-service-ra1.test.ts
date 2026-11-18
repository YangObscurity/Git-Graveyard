import test from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GitService,
  GitServiceError,
  VerifiedMerge,
  isVerifiedMerge,
  isGraveyardRef,
  assertNoGraveyardRefMutation,
} from "../../lib/git/git-service";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

interface Ra1RepoContext {
  tmpDir: string;
  gitDir: string;
  runId: string;
  taskId: string;
  baseSha: string;
  candidateSha: string;
  candidateTree: string;
  candidateSha256: string;
  cleanup: () => void;
}

function createRa1Repo(runId = "run-ra1-01", taskId = "task-ra1-01"): Ra1RepoContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ra1-test-"));
  const gitDir = path.join(tmpDir, "git");
  fs.mkdirSync(gitDir, { recursive: true });

  const runGit = (args: string[], cwd = gitDir): string => {
    return childProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        HOME: tmpDir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      } as unknown as NodeJS.ProcessEnv,
    }).trim();
  };

  runGit(["init", "--initial-branch=main", "."]);
  runGit(["config", "user.name", "Test Runner"]);
  runGit(["config", "user.email", "runner@example.test"]);

  fs.writeFileSync(path.join(gitDir, "base.txt"), "line 1: base\n", "utf8");
  runGit(["add", "base.txt"]);
  runGit(["commit", "-m", "initial base commit"]);
  const baseSha = runGit(["rev-parse", "HEAD"]);

  const integrationBranch = `graveyard/${runId}`;
  runGit(["branch", integrationBranch, baseSha]);

  const taskBranch = `task/${taskId}`;
  runGit(["checkout", "-b", taskBranch, integrationBranch]);
  fs.writeFileSync(path.join(gitDir, "base.txt"), "line 1: base\nline 2: ra1 candidate\n", "utf8");
  fs.writeFileSync(path.join(gitDir, "ra1-file.txt"), "ra1 candidate file\n", "utf8");
  runGit(["add", "."]);
  runGit(["commit", "-m", "ra1 candidate commit"]);
  const candidateSha = runGit(["rev-parse", "HEAD"]);
  const candidateTree = runGit(["rev-parse", `${candidateSha}^{tree}`]);

  runGit(["checkout", "main"]);

  const diffText = childProcess.execFileSync(
    "git",
    ["diff", "--binary", "--no-color", `${baseSha}..${candidateSha}`],
    { cwd: gitDir, encoding: "utf8" }
  );
  const candidateSha256 = candidateSha256FromDiff(diffText);

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  };

  return {
    tmpDir,
    gitDir,
    runId,
    taskId,
    baseSha,
    candidateSha,
    candidateTree,
    candidateSha256,
    cleanup,
  };
}

function makePassingVerdict(candidateSha256: string): Record<string, unknown> {
  return {
    verdict: "approve",
    status: "approve",
    candidateSha256,
    evidenceRefs: ["cmd:git status", "file:base.txt"],
    reasons: ["all checks passed (cmd:git status)"],
    checks: {
      install: { ok: true, exitCode: 0 },
      build: { ok: true, exitCode: 0 },
      accept: { ok: true, exitCode: 0 },
      tests: { ok: true, exitCode: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// N-A10: VerifiedMerge WeakSet branding and isVerifiedMerge
// ---------------------------------------------------------------------------

test("N-A10: Object.create forge and plain objects fail isVerifiedMerge", async (t) => {
  const forgedPrototype = Object.create(VerifiedMerge.prototype);
  assert.equal(isVerifiedMerge(forgedPrototype), false);

  const fakeObject = {
    ok: true,
    merged: true,
    runId: "run-forge",
    branch: "graveyard/run-forge",
    candidateSha: "a".repeat(40),
    candidateSha256: "b".repeat(64),
    newHeadSha: "a".repeat(40),
    previousHeadSha: "c".repeat(40),
  };
  assert.equal(isVerifiedMerge(fakeObject), false);

  assert.equal(isVerifiedMerge(null), false);
  assert.equal(isVerifiedMerge(undefined), false);
  assert.equal(isVerifiedMerge("string"), false);
  assert.equal(isVerifiedMerge(123), false);
  assert.equal(isVerifiedMerge({}), false);
});

test("N-A10: Real VerifiedMerge from mergeCandidate passes isVerifiedMerge and is frozen", async (t) => {
  const ctx = createRa1Repo("run-na10-real", "task-na10-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const verdict = makePassingVerdict(ctx.candidateSha256);

  const res = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict,
    gateResult: { ok: true, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });

  assert.ok(res instanceof VerifiedMerge);
  assert.equal(isVerifiedMerge(res), true);
  assert.equal(Object.isFrozen(res), true);

  // Attempting to mutate a frozen VerifiedMerge throws in strict mode
  assert.throws(
    () => {
      (res as any).newHeadSha = "0".repeat(40);
    },
    (err: unknown) => err instanceof TypeError
  );

  // A shallow copy of a real proof lacks WeakSet membership and fails isVerifiedMerge
  const shallowCopy = { ...res };
  assert.equal(isVerifiedMerge(shallowCopy), false);
});

// ---------------------------------------------------------------------------
// N-A11: Constructor guards and private backing fields
// ---------------------------------------------------------------------------

test("N-A11: GitService constructor rejects options.execFileFn with SECURITY_VIOLATION", () => {
  assert.throws(
    () => {
      new GitService({ execFileFn: () => {} } as any);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.ok((err as Error).message.includes("Custom execFileFn is not allowed"));
      return true;
    }
  );
});

test("N-A11: GitService constructor rejects custom gitBinary with SECURITY_VIOLATION", () => {
  assert.throws(
    () => {
      new GitService({ gitBinary: "/usr/local/bin/evil-git" } as any);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.ok((err as Error).message.includes("Custom gitBinary is not allowed"));
      return true;
    }
  );

  // gitBinary: "git" is permitted
  const validService = new GitService({ gitBinary: "git" });
  assert.equal(validService.gitBinary, "git");
});

test("N-A11: runsDir and gitBinary are exposed via read-only getters", () => {
  const service = new GitService({ runsDir: "/tmp/custom-runs" });
  assert.equal(service.runsDir, "/tmp/custom-runs");
  assert.equal(service.gitBinary, "git");
});

// ---------------------------------------------------------------------------
// N-A11: mergeCandidate strict gateResult and verdict validation
// ---------------------------------------------------------------------------

test("N-A11: mergeCandidate rejects bare boolean gateResult", async (t) => {
  const ctx = createRa1Repo("run-na11-gate-bool", "task-na11-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const verdict = makePassingVerdict(ctx.candidateSha256);

  // Bare boolean true
  const resTrue = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict,
    gateResult: true,
    gitDir: ctx.gitDir,
  });
  assert.equal(resTrue.ok, false);
  assert.equal(resTrue.merged, false);

  // Bare boolean false
  const resFalse = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict,
    gateResult: false,
    gitDir: ctx.gitDir,
  });
  assert.equal(resFalse.ok, false);
  assert.equal(resFalse.merged, false);
});

test("N-A11: mergeCandidate rejects gateResult with missing or empty tree", async (t) => {
  const ctx = createRa1Repo("run-na11-gate-tree", "task-na11-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const verdict = makePassingVerdict(ctx.candidateSha256);

  // Missing tree
  const resMissingTree = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict,
    gateResult: { ok: true },
    gitDir: ctx.gitDir,
  });
  assert.equal(resMissingTree.ok, false);
  assert.equal(resMissingTree.merged, false);

  // Empty string tree
  const resEmptyTree = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict,
    gateResult: { ok: true, tree: "   " },
    gitDir: ctx.gitDir,
  });
  assert.equal(resEmptyTree.ok, false);
  assert.equal(resEmptyTree.merged, false);
});

test("N-A11: mergeCandidate rejects gateResult with mismatched tree", async (t) => {
  const ctx = createRa1Repo("run-na11-tree-mismatch", "task-na11-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const verdict = makePassingVerdict(ctx.candidateSha256);

  const resWrongTree = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict,
    gateResult: { ok: true, tree: "0".repeat(40) },
    gitDir: ctx.gitDir,
  });
  assert.equal(resWrongTree.ok, false);
  assert.equal(resWrongTree.merged, false);
  assert.ok(resWrongTree.reason?.includes("Candidate tree mismatch"));
});

test("N-A11: mergeCandidate rejects bare string verdict", async (t) => {
  const ctx = createRa1Repo("run-na11-verdict-str", "task-na11-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  const res = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: "approve",
    gateResult: { ok: true, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });
  assert.equal(res.ok, false);
  assert.equal(res.merged, false);
});

test("N-A11: mergeCandidate rejects verdict missing evidenceRefs", async (t) => {
  const ctx = createRa1Repo("run-na11-no-evidence", "task-na11-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const verdictWithoutEvidence = {
    verdict: "approve",
    candidateSha256: ctx.candidateSha256,
    reasons: ["approved without evidence"],
    checks: {
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    },
  };

  const res = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: verdictWithoutEvidence,
    gateResult: { ok: true, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });
  assert.equal(res.ok, false);
  assert.equal(res.merged, false);
});

test("N-A11: mergeCandidate rejects verdict with failing check", async (t) => {
  const ctx = createRa1Repo("run-na11-check-fail", "task-na11-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  for (const failedCheck of ["install", "build", "accept", "tests"] as const) {
    const verdict = makePassingVerdict(ctx.candidateSha256);
    (verdict.checks as any)[failedCheck] = { ok: false, exitCode: 1 };

    const res = await (service as any).mergeCandidate({
      runId: ctx.runId,
      candidateSha: ctx.candidateSha,
      expectedIntegrationHeadSha: ctx.baseSha,
      verdict,
      gateResult: { ok: true, tree: ctx.candidateTree },
      gitDir: ctx.gitDir,
    });
    assert.equal(res.ok, false);
    assert.equal(res.merged, false);
  }
});

// ---------------------------------------------------------------------------
// N-A12: assertNoGraveyardRefMutation guards and rollbackIntegrationRef
// ---------------------------------------------------------------------------

test("N-A12: isGraveyardRef identifies graveyard refs accurately", () => {
  assert.equal(isGraveyardRef("refs/heads/graveyard/run-01"), true);
  assert.equal(isGraveyardRef("graveyard/run-01"), true);
  assert.equal(isGraveyardRef("+refs/heads/graveyard/run-01:refs/heads/graveyard/run-01"), true);
  assert.equal(isGraveyardRef("HEAD:refs/heads/graveyard/run-01"), true);
  assert.equal(isGraveyardRef(":refs/heads/graveyard/run-01"), true);
  assert.equal(isGraveyardRef("-bgraveyard/run-01"), true);
  assert.equal(isGraveyardRef("--branch=graveyard/run-01"), true);
  assert.equal(isGraveyardRef("--create=graveyard/run-01"), true);

  assert.equal(isGraveyardRef("refs/heads/main"), false);
  assert.equal(isGraveyardRef("main"), false);
  assert.equal(isGraveyardRef("task/task-01"), false);
  assert.equal(isGraveyardRef("refs/heads/task/task-01"), false);
  assert.equal(isGraveyardRef(""), false);
});

test("N-A12: public execGit and execGitSync refuse graveyard ref mutations with SECURITY_VIOLATION", async (t) => {
  const ctx = createRa1Repo("run-na12-mutation", "task-na12-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const gyBranch = `graveyard/${ctx.runId}`;
  const gyRef = `refs/heads/${gyBranch}`;

  const mutatingCommands: string[][] = [
    ["update-ref", gyRef, ctx.baseSha],
    ["update-ref", "--end-of-options", gyRef, ctx.baseSha],
    ["branch", gyBranch],
    ["branch", "-D", gyBranch],
    ["branch", "-f", gyBranch, ctx.baseSha],
    ["checkout", "-b", gyBranch],
    ["checkout", "-B", gyBranch],
    ["checkout", `-b${gyBranch}`],
    ["switch", "-c", gyBranch],
    ["switch", "-C", gyBranch],
    ["switch", `-c${gyBranch}`],
    ["reset", gyRef],
    ["reset", "--hard", gyBranch],
    ["push", "origin", gyBranch],
    ["push", "origin", `HEAD:${gyRef}`],
    ["fetch", "origin", gyRef],
    ["symbolic-ref", gyRef, "refs/heads/main"],
    ["symbolic-ref", "HEAD", gyRef],
    ["symbolic-ref", "-d", gyRef],
    ["tag", gyBranch],
    ["receive-pack", gyBranch],
  ];

  for (const cmd of mutatingCommands) {
    // Test async public execGit
    await assert.rejects(
      async () => {
        await service.execGit(cmd, { cwd: ctx.gitDir });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
        return true;
      }
    );

    // Test sync public execGitSync
    assert.throws(
      () => {
        service.execGitSync(cmd, { cwd: ctx.gitDir });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
        return true;
      }
    );
  }
});

test("N-A12: public execGit allows non-mutating inspection on graveyard refs", async (t) => {
  const ctx = createRa1Repo("run-na12-read", "task-na12-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Read-only rev-parse is allowed
  const revParseRes = await service.execGit(
    ["rev-parse", `refs/heads/graveyard/${ctx.runId}`],
    { cwd: ctx.gitDir }
  );
  assert.equal(revParseRes.stdout.trim(), ctx.baseSha);

  // Read-only diff is allowed
  const diffRes = await service.execGit(
    ["diff", `graveyard/${ctx.runId}..main`],
    { cwd: ctx.gitDir }
  );
  assert.equal(diffRes.exitCode, 0);

  // Non-mutating checkout (with --detach) is allowed
  const checkoutRes = await service.execGit(
    ["checkout", "--detach", "graveyard/" + ctx.runId],
    { cwd: ctx.gitDir }
  );
  assert.equal(checkoutRes.exitCode, 0);
});

test("N-A12: rollbackIntegrationRef rolls back ref with real VerifiedMerge and rejects forged proof", async (t) => {
  const ctx = createRa1Repo("run-na12-rollback", "task-na12-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const verdict = makePassingVerdict(ctx.candidateSha256);

  // 1. Perform successful mergeCandidate to produce legitimate VerifiedMerge
  const proof = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict,
    gateResult: { ok: true, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });

  assert.ok(isVerifiedMerge(proof));
  assert.equal(proof.newHeadSha, ctx.candidateSha);
  assert.equal(proof.previousHeadSha, ctx.baseSha);

  const headAfterMerge = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterMerge, ctx.candidateSha);

  // 2. Rollback rejected when given forged proof
  const forgedProof = Object.create(VerifiedMerge.prototype);
  Object.assign(forgedProof, proof);
  await assert.rejects(
    async () => {
      await service.rollbackIntegrationRef(forgedProof, {
        gitDir: ctx.gitDir,
        runDir: ctx.tmpDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Ref did not move on rejected rollback
  assert.equal(
    await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir),
    ctx.candidateSha
  );

  // 3. Rollback succeeds with real VerifiedMerge proof via CAS update-ref
  const rollbackResult = await service.rollbackIntegrationRef(proof, {
    gitDir: ctx.gitDir,
    runDir: ctx.tmpDir,
  });
  assert.equal(rollbackResult.ok, true);

  // Integration ref is restored to previousHeadSha
  const headAfterRollback = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterRollback, ctx.baseSha);
});

// ---------------------------------------------------------------------------
// N-A17: cloneAndCreateBaseWorktree error propagation
// ---------------------------------------------------------------------------

test("N-A17: cloneAndCreateBaseWorktree propagates createIntegrationHead failure", async (t) => {
  const ctx = createRa1Repo("run-na17-propagate", "task-na17-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // When runId starts with a dash, createIntegrationHead throws INVALID_ARGUMENT
  await assert.rejects(
    async () => {
      await service.cloneAndCreateBaseWorktree({
        repoUrl: ctx.gitDir,
        baseSha: ctx.baseSha,
        runId: "-invalid-dash-runId",
        gitDir: ctx.gitDir,
        worktreeDir: path.join(ctx.tmpDir, "clone-wt"),
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "INVALID_ARGUMENT");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Path A Round-3: NEW-1, NEW-3, N-A12 regression and hardening tests
// ---------------------------------------------------------------------------

test("NEW-1 / N-A12: non-detached checkout on graveyard ref is rejected with SECURITY_VIOLATION", async (t) => {
  const ctx = createRa1Repo("run-r3-chk", "task-r3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Non-detached checkout must be rejected
  await assert.rejects(
    async () => {
      await service.execGit(["checkout", `graveyard/${ctx.runId}`], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Non-detached switch must be rejected
  await assert.rejects(
    async () => {
      await service.execGit(["switch", `graveyard/${ctx.runId}`], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("NEW-1 / N-A12: worktree add -B on graveyard ref is rejected with SECURITY_VIOLATION", async (t) => {
  const ctx = createRa1Repo("run-r3-wt", "task-r3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const evilWorktreeDir = path.join(ctx.tmpDir, "evil-wt");

  await assert.rejects(
    async () => {
      await service.execGit(
        ["worktree", "add", "-B", `graveyard/${ctx.runId}`, evilWorktreeDir],
        { cwd: ctx.gitDir }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("NEW-1 / N-A12: --namespace ns update-ref targeting graveyard ref is rejected with SECURITY_VIOLATION", async (t) => {
  const ctx = createRa1Repo("run-r3-ns", "task-r3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  await assert.rejects(
    async () => {
      await service.execGit(
        ["--namespace", "ns", "update-ref", `refs/heads/graveyard/${ctx.runId}`, ctx.baseSha],
        { cwd: ctx.gitDir }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("NEW-1 / N-A12: -c core.hooksPath=/tmp/evil is rejected with SECURITY_VIOLATION", async (t) => {
  const ctx = createRa1Repo("run-r3-cfg", "task-r3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Separate value form
  await assert.rejects(
    async () => {
      await service.execGit(["-c", "core.hooksPath=/tmp/evil", "status"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Attached form -c<k>=<v>
  await assert.rejects(
    async () => {
      await service.execGit(["-ccore.hooksPath=/tmp/evil", "status"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // --config-env form
  await assert.rejects(
    async () => {
      await service.execGit(["--config-env", "core.editor=EVIL_EDITOR", "status"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Unknown git global option is rejected
  await assert.rejects(
    async () => {
      await service.execGit(["--prohibited-unknown-flag", "status"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("NEW-1 / N-A12: rebaseCandidate on graveyard/* and missing taskWorktree/taskBranch rejected", async (t) => {
  const ctx = createRa1Repo("run-r3-reb", "task-r3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Reject taskBranch as a graveyard ref
  await assert.rejects(
    async () => {
      await service.rebaseCandidate({
        runId: ctx.runId,
        taskId: ctx.taskId,
        taskBranch: `graveyard/${ctx.runId}`,
        gitDir: ctx.gitDir,
        runDir: ctx.tmpDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Reject targetDir === gitDir && !taskId && !options.taskBranch
  await assert.rejects(
    async () => {
      await service.rebaseCandidate({
        runId: ctx.runId,
        gitDir: ctx.gitDir,
        runDir: ctx.tmpDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("NEW-3 / N-A12: shadowed verdictCandidateSha256 is rejected", async (t) => {
  const ctx = createRa1Repo("run-r3-shadow", "task-r3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // verdict.candidateSha256 is mismatched, but options.verdictCandidateSha256 has the matching hash
  const res = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    gitDir: ctx.gitDir,
    verdictCandidateSha256: ctx.candidateSha256,
    verdict: {
      verdict: "approve",
      candidateSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      evidenceRefs: ["cmd:git status"],
      reasons: ["approved (cmd:git status)"],
      checks: {
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      },
    },
    gateResult: {
      ok: true,
      tree: ctx.candidateTree,
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.merged, false);
  assert.ok(res.reason?.includes("diff hash") || res.reason?.includes("candidateSha256"));
});

test("NEW-1 / N-A12: mutating commands rejected while HEAD points to a graveyard ref", async (t) => {
  const ctx = createRa1Repo("run-r3-head", "task-r3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Point repository HEAD to refs/heads/graveyard/...
  fs.writeFileSync(
    path.join(ctx.gitDir, ".git", "HEAD"),
    `ref: refs/heads/graveyard/${ctx.runId}\n`,
    "utf8"
  );

  // execGit with mutating command must be rejected
  await assert.rejects(
    async () => {
      await service.execGit(["reset", "--hard", ctx.baseSha], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.equal(
        (err as GitServiceError).message,
        "Mutation prohibited while HEAD points to a graveyard ref"
      );
      return true;
    }
  );

  // execGitSync with mutating command must also be rejected
  assert.throws(
    () => {
      service.execGitSync(["commit", "--allow-empty", "-m", "evil commit"], {
        cwd: ctx.gitDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.equal(
        (err as GitServiceError).message,
        "Mutation prohibited while HEAD points to a graveyard ref"
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Path A Round-4: R4A1 focused tests
// ---------------------------------------------------------------------------

test("R4A1: execGit with -C repoDir rejects mutation when repoDir HEAD points to graveyard ref", async (t) => {
  const ctx = createRa1Repo("run-r4a1-c", "task-r4a1-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Point repoDir HEAD to graveyard ref
  fs.writeFileSync(
    path.join(ctx.gitDir, ".git", "HEAD"),
    `ref: refs/heads/graveyard/${ctx.runId}\n`,
    "utf8"
  );

  // execGit(['-C', repoDir, 'reset', '--hard', 'HEAD']) without options.cwd pointing to repoDir
  await assert.rejects(
    async () => {
      await service.execGit(["-C", ctx.gitDir, "reset", "--hard", "HEAD"]);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.equal(
        (err as GitServiceError).message,
        "Mutation prohibited while HEAD points to a graveyard ref"
      );
      return true;
    }
  );

  // Also verify execGitSync
  assert.throws(
    () => {
      service.execGitSync(["-C", ctx.gitDir, "reset", "--hard", "HEAD"]);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("R4A1: chained -C flags update effectiveCwd and reject mutation on graveyard HEAD", async (t) => {
  const ctx = createRa1Repo("run-r4a1-chain", "task-r4a1-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  fs.writeFileSync(
    path.join(ctx.gitDir, ".git", "HEAD"),
    `ref: refs/heads/graveyard/${ctx.runId}\n`,
    "utf8"
  );

  const parentDir = path.dirname(ctx.gitDir);
  const repoName = path.basename(ctx.gitDir);

  await assert.rejects(
    async () => {
      await service.execGit(["-C", parentDir, "-C", repoName, "reset", "--hard", "HEAD"]);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.equal(
        (err as GitServiceError).message,
        "Mutation prohibited while HEAD points to a graveyard ref"
      );
      return true;
    }
  );

  // Also test attached -C form: -C<dir>
  await assert.rejects(
    async () => {
      await service.execGit(["-C" + parentDir, "-C" + repoName, "reset", "--hard", "HEAD"]);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("R4A1: relative --git-dir=.git combined with -C is resolved against effectiveCwd", async (t) => {
  const ctx = createRa1Repo("run-r4a1-reldir", "task-r4a1-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  fs.writeFileSync(
    path.join(ctx.gitDir, ".git", "HEAD"),
    `ref: refs/heads/graveyard/${ctx.runId}\n`,
    "utf8"
  );

  // -C repoDir followed by --git-dir=.git
  await assert.rejects(
    async () => {
      await service.execGit(["-C", ctx.gitDir, "--git-dir=.git", "reset", "--hard", "HEAD"]);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.equal(
        (err as GitServiceError).message,
        "Mutation prohibited while HEAD points to a graveyard ref"
      );
      return true;
    }
  );

  // -C repoDir followed by --git-dir .git (space-separated)
  await assert.rejects(
    async () => {
      await service.execGit(["-C", ctx.gitDir, "--git-dir", ".git", "reset", "--hard", "HEAD"]);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // --git-dir=.git followed by -C repoDir
  await assert.rejects(
    async () => {
      await service.execGit(["--git-dir=.git", "-C", ctx.gitDir, "reset", "--hard", "HEAD"]);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("R4A1: custom exec-path is rejected in both equals and separate forms", async (t) => {
  const ctx = createRa1Repo("run-r4a1-execpath", "task-r4a1-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Equals form: --exec-path=/tmp/evil
  await assert.rejects(
    async () => {
      await service.execGit(["--exec-path=/tmp/evil", "status"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Separate form: ['--exec-path', '/tmp/evil']
  await assert.rejects(
    async () => {
      await service.execGit(["--exec-path", "/tmp/evil", "status"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // execGitSync with --exec-path
  assert.throws(
    () => {
      service.execGitSync(["--exec-path=/tmp/evil", "status"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );
});

test("R4A1: execGit rejects prohibited git config keys while allowing user.name/email", async (t) => {
  const ctx = createRa1Repo("run-r4a1-cfg", "task-r4a1-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Rejection of execGit(['config', 'core.hooksPath', '/tmp/hooks'])
  await assert.rejects(
    async () => {
      await service.execGit(["config", "core.hooksPath", "/tmp/hooks"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      assert.ok((err as GitServiceError).message.includes("core.hooksPath"));
      return true;
    }
  );

  // Flags before key: --local
  await assert.rejects(
    async () => {
      await service.execGit(["config", "--local", "core.hooksPath", "/tmp/hooks"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Other forbidden config prefixes
  await assert.rejects(
    async () => {
      await service.execGit(["config", "alias.co", "checkout"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal((err as GitServiceError).code, "SECURITY_VIOLATION");
      return true;
    }
  );

  // Allowed configs work normally
  const nameRes = await service.execGit(["config", "user.name", "Allowed Runner"], { cwd: ctx.gitDir });
  assert.equal(nameRes.exitCode, 0);

  const emailRes = await service.execGit(["config", "user.email", "allowed@example.test"], { cwd: ctx.gitDir });
  assert.equal(emailRes.exitCode, 0);

  const checkRes = await service.execGit(["config", "--get", "user.name"], { cwd: ctx.gitDir });
  assert.equal(checkRes.stdout.trim(), "Allowed Runner");
});

test("R4A1: assertValidSegmentId rejects invalid runId in getIntegrationHeadSha and exportAllPatch", async (t) => {
  const ctx = createRa1Repo("run-r4a1-seg", "task-r4a1-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  const invalidRunIds = [
    "../escape",
    "-dashprefix",
    ".dotprefix",
    "bad segment!",
    "run/slash",
    "",
    "   ",
  ];

  for (const badRunId of invalidRunIds) {
    await assert.rejects(
      async () => {
        await service.getIntegrationHeadSha(badRunId, ctx.gitDir);
      },
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        assert.equal((err as GitServiceError).code, "INVALID_ARGUMENT");
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await service.exportAllPatch({
          runId: badRunId,
          baseSha: ctx.baseSha,
          gitDir: ctx.gitDir,
          runDir: ctx.tmpDir,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        assert.equal((err as GitServiceError).code, "INVALID_ARGUMENT");
        return true;
      }
    );
  }
});
