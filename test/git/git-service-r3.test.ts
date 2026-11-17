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
  MissingWorktreeError,
  assertValidRevision,
  isValidRevision,
  getHostGitDirForWorktree,
} from "../../lib/git/git-service";

interface TestRepoContext {
  tmpDir: string;
  gitDir: string;
  runId: string;
  taskId: string;
  baseSha: string;
  cleanup: () => void;
}

function createRealRepo(runId = "run-r3-test", taskId = "task-r3-01"): TestRepoContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-r3-test-"));
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

  fs.writeFileSync(path.join(gitDir, "init.txt"), "hello world\n", "utf8");
  runGit(["add", "init.txt"]);
  runGit(["commit", "-m", "init commit"]);
  const baseSha = runGit(["rev-parse", "HEAD"]);

  const integrationBranch = `graveyard/${runId}`;
  runGit(["branch", integrationBranch, baseSha]);

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
    cleanup,
  };
}

test("R3-F check 1: no caller can enable push through the public API", async (t) => {
  const ctx = createRealRepo();
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // 1. Direct call to execGit with push
  await assert.rejects(
    async () => {
      await service.execGit(["push", "origin", "main"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "WRITE_PROHIBITED");
      return true;
    }
  );

  // 2. Caller attempting to pass isAuthorizedForkPush via options on execGit
  await assert.rejects(
    async () => {
      await (service as any).execGit(["push", "origin", "main"], {
        cwd: ctx.gitDir,
        isAuthorizedForkPush: true,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "WRITE_PROHIBITED");
      return true;
    }
  );

  // 3. Caller attempting to pass isAuthorizedForkPush via options on execGitSync
  assert.throws(
    () => {
      (service as any).execGitSync(["push", "origin", "main"], {
        cwd: ctx.gitDir,
        isAuthorizedForkPush: true,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "WRITE_PROHIBITED");
      return true;
    }
  );

  // 4. Caller attempting to inject GIT_ASKPASS through isAuthorizedForkPush option
  await assert.rejects(
    async () => {
      await (service as any).execGit(["push", "origin", "main"], {
        cwd: ctx.gitDir,
        isAuthorizedForkPush: true,
        env: {
          GIT_ASKPASS: "/tmp/injected-askpass.sh",
        },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "WRITE_PROHIBITED");
      return true;
    }
  );
});

test("R3-F check 2: a missing worktree directory throws named error WorktreeNotFoundError", async (t) => {
  const ctx = createRealRepo();
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const missingWorktreePath = path.join(ctx.tmpDir, "builders", "missing-worktree-dir");

  // 1. Direct getHostGitDirForWorktree call with missing directory throws WorktreeNotFoundError
  assert.throws(
    () => {
      getHostGitDirForWorktree(ctx.gitDir, missingWorktreePath);
    },
    (err: unknown) => {
      assert.ok(err instanceof WorktreeNotFoundError);
      assert.ok(err instanceof MissingWorktreeError);
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.name, "WorktreeNotFoundError");
      assert.equal(err.code, "WORKTREE_NOT_FOUND");
      return true;
    }
  );

  // 2. Direct getHostGitDirForWorktree call with empty string or undefined throws WorktreeNotFoundError
  assert.throws(
    () => {
      getHostGitDirForWorktree(ctx.gitDir, "");
    },
    (err: unknown) => {
      assert.ok(err instanceof WorktreeNotFoundError);
      assert.equal(err.name, "WorktreeNotFoundError");
      return true;
    }
  );

  assert.throws(
    () => {
      getHostGitDirForWorktree(ctx.gitDir, undefined);
    },
    (err: unknown) => {
      assert.ok(err instanceof WorktreeNotFoundError);
      assert.equal(err.name, "WorktreeNotFoundError");
      return true;
    }
  );

  // 3. rebaseCandidate fails closed with WorktreeNotFoundError when worktree is missing
  await assert.rejects(
    async () => {
      await service.rebaseCandidate({
        runId: ctx.runId,
        taskId: "non-existent-task",
        gitDir: ctx.gitDir,
        worktreeDir: missingWorktreePath,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof WorktreeNotFoundError);
      assert.equal(err.name, "WorktreeNotFoundError");
      assert.equal(err.code, "WORKTREE_NOT_FOUND");
      return true;
    }
  );
});

test("R3-F check 3: a revision beginning with a dash is rejected", async (t) => {
  const ctx = createRealRepo();
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // 1. assertValidRevision rejects arguments starting with dash
  assert.throws(
    () => {
      assertValidRevision("-malicious");
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      assert.ok(err.message.includes("must not begin with a dash"));
      return true;
    }
  );

  assert.throws(
    () => {
      assertValidRevision("--output=/tmp/evil");
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      assert.ok(err.message.includes("must not begin with a dash"));
      return true;
    }
  );

  assert.throws(
    () => {
      assertValidRevision("-b");
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      assert.ok(err.message.includes("must not begin with a dash"));
      return true;
    }
  );

  // 2. isValidRevision returns false for dash revisions
  assert.equal(isValidRevision("-malicious"), false);
  assert.equal(isValidRevision("--upload-pack=evil"), false);

  // 3. cloneRepo rejects baseSha beginning with a dash
  await assert.rejects(
    async () => {
      await service.cloneRepo(
        "https://github.com/example/repo",
        path.join(ctx.tmpDir, "clone-target"),
        "-malicious-base"
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      return true;
    }
  );

  // 4. createBaseWorktree rejects baseSha beginning with a dash
  await assert.rejects(
    async () => {
      await service.createBaseWorktree(
        ctx.gitDir,
        path.join(ctx.tmpDir, "wt-target"),
        "-malicious-base"
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      return true;
    }
  );

  // 5. getCandidateDiff rejects fromRef or toRef beginning with a dash
  await assert.rejects(
    async () => {
      await service.getCandidateDiff({
        fromRef: "-malicious-ref",
        toRef: "HEAD",
        gitDir: ctx.gitDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      return true;
    }
  );

  // 6. getCandidateFiles rejects fromRef beginning with a dash
  await assert.rejects(
    async () => {
      await service.getCandidateFiles("-malicious-ref", "HEAD", ctx.gitDir);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      return true;
    }
  );

  // 7. exportAllPatch rejects baseSha beginning with a dash
  await assert.rejects(
    async () => {
      await service.exportAllPatch({
        runId: ctx.runId,
        baseSha: "-malicious-sha",
        gitDir: ctx.gitDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      return true;
    }
  );

  // 8. createIntegrationHead rejects baseSha beginning with a dash
  await assert.rejects(
    async () => {
      await (service as any).createIntegrationHead({
        runId: ctx.runId,
        baseSha: "-malicious-sha",
        gitDir: ctx.gitDir,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_REVISION");
      return true;
    }
  );
});

test("R3-F check 4: a push without the internal flag is refused", async (t) => {
  const ctx = createRealRepo();
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // 1. execGit push without internal flag is refused
  await assert.rejects(
    async () => {
      await service.execGit(["push"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "WRITE_PROHIBITED");
      return true;
    }
  );

  // 2. execGitSync push without internal flag is refused
  assert.throws(
    () => {
      service.execGitSync(["push"], { cwd: ctx.gitDir });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "WRITE_PROHIBITED");
      return true;
    }
  );

  // 3. execGit push with options object still refused
  await assert.rejects(
    async () => {
      await service.execGit(["push", "origin", "graveyard/branch"], {
        cwd: ctx.gitDir,
        env: { LANG: "C.UTF-8" },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.ok(
        (err as GitServiceError).code === "WRITE_PROHIBITED" ||
        (err as GitServiceError).code === "SECURITY_VIOLATION"
      );
      return true;
    }
  );
});

test("R3-F check 5: token fields are not exposed publicly on GitService instances", async () => {
  const service = new GitService({
    githubToken: "token-secret-123",
    githubWriteToken: "write-secret-456",
  });

  // Verify fields are not exposed as public properties
  assert.equal((service as any).githubToken, undefined);
  assert.equal((service as any).githubWriteToken, undefined);
  assert.equal("githubToken" in service, false);
  assert.equal("githubWriteToken" in service, false);

  // Verify Object.keys does not include tokens
  const keys = Object.keys(service);
  assert.equal(keys.includes("githubToken"), false);
  assert.equal(keys.includes("githubWriteToken"), false);
});
