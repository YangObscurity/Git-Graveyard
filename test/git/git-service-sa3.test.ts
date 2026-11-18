import test from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GitService,
  GitServiceError,
  WorktreeNotFoundError,
  VerifiedMerge,
  getHostGitDirForWorktree,
} from "../../lib/git/git-service";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

interface Sa3RepoContext {
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

function createSa3Repo(runId = "run-sa3-01", taskId = "task-sa3-01"): Sa3RepoContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-sa3-test-"));
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
  fs.writeFileSync(path.join(gitDir, "base.txt"), "line 1: base\nline 2: candidate addition\n", "utf8");
  fs.writeFileSync(path.join(gitDir, "sa3-file.txt"), "sa3 candidate file\n", "utf8");
  runGit(["add", "."]);
  runGit(["commit", "-m", "sa3 candidate work"]);
  const candidateSha = runGit(["rev-parse", "HEAD"]);
  const candidateTree = runGit(["rev-parse", `${candidateSha}^{tree}`]);

  runGit(["checkout", integrationBranch]);

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

test("SA3: the old public merge methods are not reachable from outside the module", async (t) => {
  const ctx = createSa3Repo("run-sa3-reach", "task-sa3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // fastForwardMerge left the public surface: the alias is gone and calling
  // it throws at runtime.
  assert.equal((service as any).fastForwardMerge, undefined);
  assert.throws(
    () =>
      (service as any).fastForwardMerge({
        runId: ctx.runId,
        candidateSha: ctx.candidateSha,
        expectedIntegrationHeadSha: ctx.baseSha,
      }),
    (err: unknown) => err instanceof TypeError
  );

  // The ref-moving static wrappers are removed from the class as well.
  assert.equal((GitService as any).mergeCandidate, undefined);
  assert.equal((GitService as any).createIntegrationHead, undefined);
  assert.throws(
    () => (GitService as any).mergeCandidate({ runId: ctx.runId }),
    (err: unknown) => err instanceof TypeError
  );
  assert.throws(
    () => (GitService as any).createIntegrationHead({ runId: ctx.runId }),
    (err: unknown) => err instanceof TypeError
  );

  // mergeCandidate and createIntegrationHead are private now: a typed call
  // from outside lib/git/git-service.ts is a compile-time type error. The
  // ts-expect-error directives fail the build if the methods are ever
  // re-exposed. The block is never executed.
  if (false) {
    // @ts-expect-error mergeCandidate is private; external callers cannot move the integration ref
    void service.mergeCandidate({
      runId: ctx.runId,
      candidateSha: ctx.candidateSha,
      expectedIntegrationHeadSha: ctx.baseSha,
    });
    // @ts-expect-error createIntegrationHead is private; external callers cannot move the integration ref
    void service.createIntegrationHead({ runId: ctx.runId });
    // @ts-expect-error fastForwardMerge no longer exists on GitService
    void service.fastForwardMerge;
  }
});

test("SA3: VerifiedMerge cannot be constructed outside the git-service module", () => {
  const proof = {
    runId: "run-sa3-forge",
    branch: "graveyard/run-sa3-forge",
    candidateSha: "a".repeat(40),
    candidateSha256: "c".repeat(64),
    newHeadSha: "a".repeat(40),
    previousHeadSha: "b".repeat(40),
  };

  // A foreign symbol is not the module-private construction token.
  assert.throws(
    () => {
      new (VerifiedMerge as any)(Symbol("forged-token"), proof);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(
        (err as GitServiceError).code,
        "VERIFIED_MERGE_CONSTRUCTION_PROHIBITED"
      );
      assert.ok(
        (err as Error).message.includes("VerifiedMerge cannot be constructed")
      );
      return true;
    }
  );

  // Any non-token value, or no value at all, is rejected the same way.
  assert.throws(
    () => new (VerifiedMerge as any)(undefined, proof),
    (err: unknown) => err instanceof GitServiceError
  );
  assert.throws(
    () => new (VerifiedMerge as any)(proof as any),
    (err: unknown) => err instanceof GitServiceError
  );

  // No forged instance can exist: construction throws before any field is
  // assigned.
  let forged: unknown = null;
  try {
    forged = new (VerifiedMerge as any)(Symbol("forged-token"), proof);
  } catch {
    forged = null;
  }
  assert.equal(forged, null);

  if (false) {
    // @ts-expect-error the VerifiedMerge construction token is module-private; a foreign symbol is a type error
    void new VerifiedMerge(Symbol("forged-token"), proof);
  }
});

test("SA3: mergeCandidate returns a VerifiedMerge only after the ref has moved to the checked sha", async (t) => {
  const ctx = createSa3Repo("run-sa3-proof", "task-sa3-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Refusal path: a verdict hash mismatch returns a plain refusal, never a
  // VerifiedMerge, and the integration ref does not move.
  const resBad = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "approve",
      candidateSha256: "a".repeat(64),
      evidenceRefs: ["cmd:git status"],
      reasons: ["approved (cmd:git status)"],
      checks: {
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      },
    },
    gateResult: { ok: true, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });
  assert.equal(resBad.ok, false);
  assert.equal(resBad.merged, false);
  assert.equal(resBad instanceof VerifiedMerge, false);
  const headAfterRefusal = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterRefusal, ctx.baseSha);

  // Happy path: the ref moved and the stored sha was re-checked before the
  // proof was issued.
  const res = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "approve",
      candidateSha256: ctx.candidateSha256,
      evidenceRefs: ["cmd:git status"],
      reasons: ["approved (cmd:git status)"],
      checks: {
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      },
    },
    gateResult: { ok: true, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });
  assert.ok(res instanceof VerifiedMerge);
  assert.equal(res.ok, true);
  assert.equal(res.merged, true);
  assert.equal(res.runId, ctx.runId);
  assert.equal(res.branch, `graveyard/${ctx.runId}`);
  assert.equal(res.newHeadSha, ctx.candidateSha);
  assert.equal(res.previousHeadSha, ctx.baseSha);
  assert.equal(res.candidateSha, ctx.candidateSha);
  assert.equal(res.candidateSha256, ctx.candidateSha256);

  const headAfterMerge = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterMerge, ctx.candidateSha);
});

test("SA3: a worktree whose .git file points into the worktree is rejected", async (t) => {
  const ctx = createSa3Repo("run-sa3-wt", "task-sa3-ok");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // A legitimately registered worktree still resolves to its admin directory
  // under hostMain/worktrees.
  const worktreeResult = await service.createTaskWorktree({
    runId: ctx.runId,
    taskId: ctx.taskId,
    gitDir: ctx.gitDir,
    runDir: ctx.tmpDir,
  });
  const legitGitDir = getHostGitDirForWorktree(ctx.gitDir, worktreeResult.worktreeDir);
  assert.equal(
    path.resolve(legitGitDir),
    path.resolve(path.join(ctx.gitDir, ".git", "worktrees", ctx.taskId))
  );

  // Forged worktree: an unregistered directory whose .git file points at an
  // existing directory inside the worktree is rejected, not followed.
  const forgedAbs = path.join(ctx.tmpDir, "builders", "forged-abs");
  fs.mkdirSync(path.join(forgedAbs, "planted-git"), { recursive: true });
  fs.writeFileSync(
    path.join(forgedAbs, ".git"),
    `gitdir: ${path.join(forgedAbs, "planted-git")}\n`,
    "utf8"
  );
  assert.throws(
    () => getHostGitDirForWorktree(ctx.gitDir, forgedAbs),
    (err: unknown) => {
      assert.ok(err instanceof WorktreeNotFoundError);
      return true;
    }
  );

  // Relative pointer variant: the target exists inside the worktree and must
  // still be rejected.
  const forgedRel = path.join(ctx.tmpDir, "builders", "forged-rel");
  fs.mkdirSync(path.join(forgedRel, "planted-git"), { recursive: true });
  fs.writeFileSync(path.join(forgedRel, ".git"), "gitdir: ./planted-git\n", "utf8");
  assert.throws(
    () => getHostGitDirForWorktree(ctx.gitDir, forgedRel),
    (err: unknown) => {
      assert.ok(err instanceof WorktreeNotFoundError);
      return true;
    }
  );

  await worktreeResult.cleanup();
});

test("SA3: removeTaskWorktree with a traversal id throws and deletes nothing", async (t) => {
  const ctx = createSa3Repo("run-sa3-rm", "task-sa3-ok");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  const worktreeResult = await service.createTaskWorktree({
    runId: ctx.runId,
    taskId: ctx.taskId,
    gitDir: ctx.gitDir,
    runDir: ctx.tmpDir,
  });

  // The canary sits exactly where the default worktree path for the
  // traversal id would resolve: <runRoot>/builders/../sa3-canary.
  const canaryDir = path.join(ctx.tmpDir, "sa3-canary");
  fs.mkdirSync(canaryDir, { recursive: true });
  const canaryFile = path.join(canaryDir, "canary.txt");
  fs.writeFileSync(canaryFile, "must survive\n", "utf8");

  // Traversal taskId: rejected with the same revision checks as
  // createTaskWorktree; nothing is deleted.
  await assert.rejects(
    async () => {
      await service.removeTaskWorktree({
        runId: ctx.runId,
        taskId: "../sa3-canary",
        gitDir: ctx.gitDir,
        runDir: ctx.tmpDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.ok(
        (err as GitServiceError).code === "INVALID_ARGUMENT" ||
        (err as GitServiceError).code === "INVALID_REVISION"
      );
      return true;
    }
  );

  // Traversal runId: same rejection.
  await assert.rejects(
    async () => {
      await service.removeTaskWorktree({
        runId: "../sa3-canary",
        taskId: ctx.taskId,
        gitDir: ctx.gitDir,
        runDir: ctx.tmpDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.ok(
        (err as GitServiceError).code === "INVALID_ARGUMENT" ||
        (err as GitServiceError).code === "INVALID_REVISION"
      );
      return true;
    }
  );

  // Dash-leading id: rejected exactly like createTaskWorktree.
  await assert.rejects(
    async () => {
      await service.removeTaskWorktree({
        runId: ctx.runId,
        taskId: "-sa3-evil",
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

  // Missing id: rejected exactly like createTaskWorktree.
  await assert.rejects(
    async () => {
      await service.removeTaskWorktree({
        runId: ctx.runId,
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

  // A target outside runsDir is refused before any recursive removal.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-sa3-outside-"));
  t.after(() => {
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });
  const outsideKeep = path.join(outsideDir, "keep.txt");
  fs.writeFileSync(outsideKeep, "must survive\n", "utf8");
  await assert.rejects(
    async () => {
      await service.removeTaskWorktree({
        runId: ctx.runId,
        taskId: ctx.taskId,
        gitDir: ctx.gitDir,
        runDir: ctx.tmpDir,
        worktreeDir: path.join(outsideDir, "wt"),
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(
        (err as GitServiceError).code,
        "WORKTREE_PATH_OUTSIDE_RUNS_DIR"
      );
      return true;
    }
  );
  assert.equal(fs.existsSync(outsideKeep), true);

  // Nothing was deleted anywhere.
  assert.equal(fs.existsSync(canaryDir), true);
  assert.equal(fs.existsSync(canaryFile), true);
  assert.equal(fs.existsSync(worktreeResult.worktreeDir), true);
  assert.equal(
    fs.existsSync(path.join(worktreeResult.worktreeDir, ".git")),
    true
  );
  const headAfter = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfter, ctx.baseSha);

  await worktreeResult.cleanup();
});
