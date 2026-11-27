import test from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitService, GitServiceError } from "../../lib/git/git-service";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import { EventStore } from "../../lib/events/event-store";

interface TestRepoContext {
  tmpDir: string;
  gitDir: string;
  runId: string;
  taskId: string;
  baseSha: string;
  candidateSha: string;
  candidateTree: string;
  diffText: string;
  candidateSha256: string;
  cleanup: () => void;
}

const REAL_GIT = (() => {
  try {
    return childProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  } catch {
    return "/usr/bin/git";
  }
})();

async function withFakeGitInPath(
  scriptBody: string,
  fn: (tmpDir: string) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-git-"));
  const gitPath = path.join(dir, "git");
  fs.writeFileSync(gitPath, scriptBody, { encoding: "utf8" });
  fs.chmodSync(gitPath, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = dir + (origPath ? `:${origPath}` : "");
  try {
    await fn(dir);
  } finally {
    process.env.PATH = origPath;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

function createTestRepoContext(runId = "run-test-01", taskId = "task-01"): TestRepoContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-svc-test-"));
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
  fs.writeFileSync(path.join(gitDir, "new-file.txt"), "new file content\n", "utf8");
  runGit(["add", "."]);
  runGit(["commit", "-m", "candidate work"]);
  const candidateSha = runGit(["rev-parse", "HEAD"]);
  const candidateTree = runGit(["rev-parse", `${candidateSha}^{tree}`]);

  runGit(["checkout", integrationBranch]);

  const diffText = childProcess.execFileSync("git", ["diff", "--binary", "--no-color", `${baseSha}..${candidateSha}`], {
    cwd: gitDir,
    encoding: "utf8",
  });
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
    diffText,
    candidateSha256,
    cleanup,
  };
}

test("mergeCandidate: refused without a verdict", async (t) => {
  const ctx = createTestRepoContext("run-no-verdict", "task-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Missing verdict
  const resMissing = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdictCandidateSha256: ctx.candidateSha256,
    gateResult: { ok: true, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.merged, false);
  const headAfterMissing = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterMissing, ctx.baseSha);

  // Verdict is reject
  const resReject = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "reject",
      candidateSha256: ctx.candidateSha256,
      evidenceRefs: ["cmd:git status"],
      reasons: ["rejected (cmd:git status)"],
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
  assert.equal(resReject.ok, false);
  assert.equal(resReject.merged, false);
  const headAfterReject = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterReject, ctx.baseSha);

  // Missing verdictCandidateSha256
  const resNoHash = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "approve",
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
  assert.equal(resNoHash.ok, false);
  assert.equal(resNoHash.merged, false);
  const headAfterNoHash = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterNoHash, ctx.baseSha);

  // Missing gateResult
  const resNoGate = await (service as any).mergeCandidate({
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
    gitDir: ctx.gitDir,
  });
  assert.equal(resNoGate.ok, false);
  assert.equal(resNoGate.merged, false);
  const headAfterNoGate = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterNoGate, ctx.baseSha);

  // Gate result not ok
  const resGateFailed = await (service as any).mergeCandidate({
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
    gateResult: { ok: false, tree: ctx.candidateTree },
    gitDir: ctx.gitDir,
  });
  assert.equal(resGateFailed.ok, false);
  assert.equal(resGateFailed.merged, false);
  const headAfterGateFailed = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(headAfterGateFailed, ctx.baseSha);
});

test("mergeCandidate: refused on a hash mismatch", async (t) => {
  const ctx = createTestRepoContext("run-mismatch", "task-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Wrong random sha256
  const wrongHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const resWrong = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "approve",
      candidateSha256: wrongHash,
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
  assert.equal(resWrong.ok, false);
  assert.equal(resWrong.merged, false);
  let head = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(head, ctx.baseSha);

  // Raw commit SHA provided as verdictCandidateSha256
  const resRawSha = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "approve",
      candidateSha256: ctx.candidateSha,
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
  assert.equal(resRawSha.ok, false);
  assert.equal(resRawSha.merged, false);
  head = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(head, ctx.baseSha);

  // Hash of commit SHA string provided as verdictCandidateSha256
  const commitShaHash = crypto.createHash("sha256").update(ctx.candidateSha).digest("hex");
  const resShaOfCommit = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "approve",
      candidateSha256: commitShaHash,
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
  assert.equal(resShaOfCommit.ok, false);
  assert.equal(resShaOfCommit.merged, false);
  head = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(head, ctx.baseSha);

  // Caller candidateSha256 matching verdictCandidateSha256 but differing from server diff hash
  const callerSha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const resCallerMatch = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    candidateSha256: callerSha256,
    verdict: {
      verdict: "approve",
      candidateSha256: callerSha256,
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
  assert.equal(resCallerMatch.ok, false);
  assert.equal(resCallerMatch.merged, false);
  head = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(head, ctx.baseSha);
});

test("mergeCandidate: merged on the happy path", async (t) => {
  const ctx = createTestRepoContext("run-happy", "task-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

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

  assert.equal(res.ok, true);
  assert.equal(res.merged, true);
  assert.equal(res.newHeadSha, ctx.candidateSha);
  assert.equal(res.previousHeadSha, ctx.baseSha);

  const newHead = await service.getIntegrationHeadSha(ctx.runId, ctx.gitDir);
  assert.equal(newHead, ctx.candidateSha);
});

test("the hash used equals candidateSha256FromDiff of the diff", async (t) => {
  const ctx = createTestRepoContext("run-diff-hash", "task-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Compute exact diff directly via git diff --binary --no-color
  const diffRes = await service.execGit([
    "-C",
    ctx.gitDir,
    "diff",
    "--binary",
    "--no-color",
    `${ctx.baseSha}..${ctx.candidateSha}`,
  ]);
  const expectedHash = candidateSha256FromDiff(diffRes.stdout);
  assert.equal(expectedHash, ctx.candidateSha256);

  // Successful merge when providing the exact diff hash
  const res = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    verdict: {
      verdict: "approve",
      candidateSha256: expectedHash,
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
  assert.equal(res.ok, true);
  assert.equal(res.merged, true);
});

test("clone refuses a file URL", async (t) => {
  const ctx = createTestRepoContext("run-clone-refuse", "task-01");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });
  const targetDir = path.join(ctx.tmpDir, "clone-dest");

  // Attempting to clone with file:// protocol URL must be rejected
  const fileUrl = `file://${ctx.gitDir}`;
  await assert.rejects(
    async () => {
      await service.cloneRepo(fileUrl, targetDir);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError || err instanceof Error);
      const gitErr = err as GitServiceError;
      const msg = String(gitErr.message || "") + String(gitErr.stderr || "");
      return msg.includes("transport 'file' not allowed") || msg.includes("protocol.allow");
    }
  );

  // Attempting to clone with local filesystem path must also be rejected
  const targetDir2 = path.join(ctx.tmpDir, "clone-dest-2");
  await assert.rejects(
    async () => {
      await service.cloneRepo(ctx.gitDir, targetDir2);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError || err instanceof Error);
      const gitErr = err as GitServiceError;
      const msg = String(gitErr.message || "") + String(gitErr.stderr || "");
      return msg.includes("transport 'file' not allowed") || msg.includes("protocol.allow");
    }
  );
});

test("git hardening: child process minimal environment and worktree flags", async (t) => {
  const secretKey = "SECRET_DISPATCH_TOKEN";
  process.env[secretKey] = "super-confidential-token";

  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const record = {
    args: process.argv.slice(2),
    env: process.env,
  };
  fs.writeFileSync(path.join(dir, "call.json"), JSON.stringify(record));
' "$SCRIPT_DIR" -- "$@"
exit 0
`;

  try {
    await withFakeGitInPath(script, async (dir) => {
      const service = new GitService();
      await service.execGit(["status"]);

      const callData = JSON.parse(fs.readFileSync(path.join(dir, "call.json"), "utf8"));
      const capturedEnv: NodeJS.ProcessEnv = callData.env;
      const capturedArgs: string[] = callData.args;

      assert.ok(capturedEnv, "Environment must be passed to execFile");
      assert.equal(capturedEnv[secretKey], undefined, "Secrets in process.env must not leak to git");
      assert.equal(capturedEnv.GIT_CONFIG_NOSYSTEM, "1", "GIT_CONFIG_NOSYSTEM must be 1");
      assert.equal(capturedEnv.GIT_TERMINAL_PROMPT, "0", "GIT_TERMINAL_PROMPT must be 0");
      assert.ok(capturedEnv.PATH, "PATH must be present");
      assert.ok(capturedEnv.LANG, "LANG must be present");
      assert.ok(capturedEnv.HOME, "HOME must be present");
      assert.notEqual(capturedEnv.HOME, process.env.HOME, "HOME must be a fresh temporary directory");

      assert.ok(capturedArgs?.includes("protocol.allow=never"), "Must include protocol.allow=never");
    });
  } finally {
    delete process.env[secretKey];
  }
});

test("rebaseCandidate computes candidateSha256 from diff and uses explicit --git-dir and --work-tree", async (t) => {
  const ctx = createTestRepoContext("run-rebase", "task-rebase");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Create task worktree
  const worktreeResult = await service.createTaskWorktree({
    runId: ctx.runId,
    taskId: ctx.taskId,
    gitDir: ctx.gitDir,
    runDir: ctx.tmpDir,
  });

  // Make an additional commit inside the worktree
  const worktreeFile = path.join(worktreeResult.worktreeDir, "worktree-change.txt");
  fs.writeFileSync(worktreeFile, "worktree change\n", "utf8");

  childProcess.execFileSync("git", [
    "--git-dir",
    path.join(worktreeResult.worktreeDir, ".git"),
    "--work-tree",
    worktreeResult.worktreeDir,
    "add",
    "worktree-change.txt",
  ], { encoding: "utf8" });

  childProcess.execFileSync("git", [
    "--git-dir",
    path.join(worktreeResult.worktreeDir, ".git"),
    "--work-tree",
    worktreeResult.worktreeDir,
    "-c",
    "user.name=Test Runner",
    "-c",
    "user.email=runner@example.test",
    "commit",
    "-m",
    "commit in worktree",
  ], { encoding: "utf8" });

  // Rebase candidate
  const rebaseRes = await service.rebaseCandidate({
    runId: ctx.runId,
    taskId: ctx.taskId,
    gitDir: ctx.gitDir,
    runDir: ctx.tmpDir,
    worktreeDir: worktreeResult.worktreeDir,
  });

  assert.equal(rebaseRes.ok, true);
  assert.equal(rebaseRes.conflict, false);
  assert.ok(rebaseRes.candidateSha);
  assert.ok(rebaseRes.candidateSha256);

  // Compute diff against integration branch to verify candidateSha256
  const rebaseDiff = childProcess.execFileSync("git", [
    "-C",
    ctx.gitDir,
    "diff",
    "--binary",
    "--no-color",
    `graveyard/${ctx.runId}..${rebaseRes.candidateSha}`,
  ], { encoding: "utf8" });

  const expectedSha256 = candidateSha256FromDiff(rebaseDiff);
  assert.equal(rebaseRes.candidateSha256, expectedSha256);

  // Verify that candidateSha256 is NOT the hash of the commit sha string
  const commitShaHash = crypto.createHash("sha256").update(rebaseRes.candidateSha!).digest("hex");
  assert.notEqual(rebaseRes.candidateSha256, commitShaHash);

  await worktreeResult.cleanup();
});

test("pushToFork: refuses when runId is missing or invalid", async () => {
  const service = new GitService();
  await assert.rejects(
    async () => {
      await service.pushToFork("", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_RUN_ID");
      return true;
    }
  );
});

test("pushToFork: target URL validation before any other check", async () => {
  const service = new GitService({
    ownerLogin: "fork-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  // Missing target URL
  await assert.rejects(
    async () => {
      await service.pushToFork("run-target-1", {
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "MISSING_FORK_URL");
      return true;
    }
  );

  // Target URL with trailing slash
  await assert.rejects(
    async () => {
      await service.pushToFork("run-target-2", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo/",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      assert.ok(err.message.includes("trailing slash"));
      return true;
    }
  );

  // Target URL with embedded user/password credentials
  const secretCred = "secret-credential-password";
  await assert.rejects(
    async () => {
      await service.pushToFork("run-target-3", {
        targetRepoUrl: `https://user:${secretCred}@github.com/fork-owner/fork-repo`,
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      assert.ok(err.message.includes("embedded credentials"));
      assert.equal(err.message.includes(secretCred), false);
      return true;
    }
  );

  // Target URL with embedded token credentials
  const secretToken = "secret-token-cred";
  await assert.rejects(
    async () => {
      await service.pushToFork("run-target-4", {
        targetRepoUrl: `https://${secretToken}@github.com/fork-owner/fork-repo`,
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      assert.equal(err.message.includes(secretToken), false);
      return true;
    }
  );

  // Unparsable target URL (not a URL)
  await assert.rejects(
    async () => {
      await service.pushToFork("run-target-5", {
        targetRepoUrl: "not-a-valid-git-url",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      assert.ok(err.message.includes("unparsable"));
      return true;
    }
  );

  // Unparsable target URL (missing repo path)
  await assert.rejects(
    async () => {
      await service.pushToFork("run-target-6", {
        targetRepoUrl: "https://github.com",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      return true;
    }
  );
});

test("pushToFork: refuses source repository target or missing source repository URL", async () => {
  const service = new GitService({
    ownerLogin: "source-owner",
  });

  // Missing source URL
  await assert.rejects(
    async () => {
      await service.pushToFork("run-src-1", {
        targetRepoUrl: "https://github.com/source-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "MISSING_SOURCE_URL");
      return true;
    }
  );

  // Target equals source repository
  await assert.rejects(
    async () => {
      await service.pushToFork("run-src-2", {
        targetRepoUrl: "https://github.com/source-owner/source-repo",
        sourceRepoUrl: "https://github.com/source-owner/source-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "SOURCE_WRITE_FORBIDDEN");
      return true;
    }
  );

  // Target equals source repository with .git suffix
  await assert.rejects(
    async () => {
      await service.pushToFork("run-src-3", {
        targetRepoUrl: "https://github.com/source-owner/source-repo.git",
        sourceRepoUrl: "https://github.com/source-owner/source-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "SOURCE_WRITE_FORBIDDEN");
      return true;
    }
  );
});

test("pushToFork: default deny for runPhase", async () => {
  const service = new GitService({
    ownerLogin: "fork-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  // Missing runPhase (undefined)
  await assert.rejects(
    async () => {
      await service.pushToFork("run-phase-1", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_RUN_PHASE");
      return true;
    }
  );

  // runPhase is not 'done'
  for (const invalidPhase of ["queued", "plan", "running", "failed", "autopsy"]) {
    await assert.rejects(
      async () => {
        await service.pushToFork("run-phase-2", {
          targetRepoUrl: "https://github.com/fork-owner/fork-repo",
          runPhase: invalidPhase,
          invitePushFlag: true,
          forkChecker: async () => "source-owner/source-repo",
          token: "test-token",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        assert.equal(err.code, "INVALID_RUN_PHASE");
        return true;
      }
    );
  }

  // Legacy optional phase property without runPhase is refused
  await assert.rejects(
    async () => {
      await service.pushToFork("run-phase-3", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        phase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      } as any);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_RUN_PHASE");
      return true;
    }
  );
});

test("pushToFork: default deny for invitePushFlag", async () => {
  const service = new GitService({
    ownerLogin: "fork-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  // Missing invitePushFlag (undefined)
  await assert.rejects(
    async () => {
      await service.pushToFork("run-flag-1", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "PUSH_FLAG_DISABLED");
      return true;
    }
  );

  // invitePushFlag is false
  await assert.rejects(
    async () => {
      await service.pushToFork("run-flag-2", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: false,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "PUSH_FLAG_DISABLED");
      return true;
    }
  );

  // Legacy optional hasPushFlag without invitePushFlag is refused
  await assert.rejects(
    async () => {
      await service.pushToFork("run-flag-3", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        hasPushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      } as any);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "PUSH_FLAG_DISABLED");
      return true;
    }
  );
});

test("pushToFork: target owner must equal configured owner login case-insensitively", async () => {
  // Missing configured owner login
  const serviceNoOwner = new GitService({
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });
  await assert.rejects(
    async () => {
      await serviceNoOwner.pushToFork("run-owner-1", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "MISSING_OWNER_LOGIN");
      return true;
    }
  );

  // Owner mismatch
  const serviceOwnerMismatch = new GitService({
    ownerLogin: "different-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });
  await assert.rejects(
    async () => {
      await serviceOwnerMismatch.pushToFork("run-owner-2", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "TARGET_NOT_OWNER_FORK");
      return true;
    }
  );

  // Case-insensitive match succeeds owner check
  const serviceCaseMatch = new GitService({
    ownerLogin: "FORK-OWNER",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });
  // Will proceed past owner check and fail at rev-parse
  await assert.rejects(
    async () => {
      await serviceCaseMatch.pushToFork("run-owner-3", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
        gitDir: "/tmp/non-existent-git-dir-for-owner-test",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.notEqual(err.code, "TARGET_NOT_OWNER_FORK");
      assert.notEqual(err.code, "MISSING_OWNER_LOGIN");
      return true;
    }
  );
});

test("pushToFork: fork checker validation and default deny", async () => {
  const service = new GitService({
    ownerLogin: "fork-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  // Missing forkChecker
  await assert.rejects(
    async () => {
      await service.pushToFork("run-fork-1", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "MISSING_FORK_CHECKER");
      return true;
    }
  );

  // Legacy optional isFork without forkChecker is refused
  await assert.rejects(
    async () => {
      await service.pushToFork("run-fork-2", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        isFork: true,
        token: "test-token",
      } as any);
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "MISSING_FORK_CHECKER");
      return true;
    }
  );

  // Checker returns null
  await assert.rejects(
    async () => {
      await service.pushToFork("run-fork-3", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => null,
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "NOT_A_FORK");
      return true;
    }
  );

  // Checker returns parent of different repository
  await assert.rejects(
    async () => {
      await service.pushToFork("run-fork-4", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "other-owner/other-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "NOT_A_FORK");
      return true;
    }
  );

  // Checker throws
  await assert.rejects(
    async () => {
      await service.pushToFork("run-fork-5", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => {
          throw new Error("GitHub API rate limited");
        },
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "NOT_A_FORK");
      return true;
    }
  );
});

test("pushToFork: write token validation (refusal on missing token)", async () => {
  const service = new GitService({
    ownerLogin: "fork-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  await assert.rejects(
    async () => {
      await service.pushToFork("run-token-1", {
        pushConfirm: true,
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "MISSING_WRITE_TOKEN");
      return true;
    }
  );
});

test("pushToFork: write token never in argv, passed via GIT_ASKPASS mode 0700 and deleted afterwards", async () => {
  const secretToken = "ghp_VERY_SECRET_TOKEN_XYZ_987654321";

  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const cp = require("node:child_process");
  const dir = process.argv[1];
  const args = process.argv.slice(2);
  const record = { file: "git", args, env: process.env };
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(record) + "\\n");

  if (args.includes("rev-parse")) {
    process.stdout.write("1111222233334444555566667777888899990000\\n");
    process.exit(0);
  }

  if (args.includes("push")) {
    const askpass = process.env.GIT_ASKPASS;
    if (askpass) {
      const askpassDir = path.dirname(askpass);
      const dirMode = fs.statSync(askpassDir).mode & 0o777;
      const fileMode = fs.statSync(askpass).mode & 0o777;
      const userOut = cp.execFileSync(askpass, ["Username for https://github.com:"], {
        env: process.env,
        encoding: "utf8",
      }).trim();
      const passOut = cp.execFileSync(askpass, ["Password for https://github.com:"], {
        env: process.env,
        encoding: "utf8",
      }).trim();
      fs.writeFileSync(path.join(dir, "askpass.json"), JSON.stringify({
        capturedAskpassPath: askpass,
        askpassDirMode: dirMode,
        askpassFileMode: fileMode,
        askpassPromptOutputUser: userOut,
        askpassPromptOutputPass: passOut,
      }));
    }
    process.stdout.write("Push successful\\n");
    process.exit(0);
  }
  process.exit(0);
' "$SCRIPT_DIR" -- "$@"
`;

  await withFakeGitInPath(script, async (dir) => {
    const service = new GitService({
      ownerLogin: "fork-owner",
      sourceRepoUrl: "https://github.com/source-owner/source-repo",
    });

    const res = await service.pushToFork("run-askpass-01", {
      pushConfirm: true,
      targetRepoUrl: "https://github.com/fork-owner/fork-repo",
      runPhase: "done",
      invitePushFlag: true,
      forkChecker: async () => "source-owner/source-repo",
      token: secretToken,
    });

    assert.equal(res.ok, true);
    assert.equal(res.branch, "graveyard/run-askpass-01");
    assert.equal(res.commitSha, "1111222233334444555566667777888899990000");

    const lines = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    const capturedCalls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = lines.map((l) => JSON.parse(l));

    // Verify write token NEVER appeared in argv of any command
    for (const call of capturedCalls) {
      for (const arg of call.args) {
        assert.equal(
          arg.includes(secretToken),
          false,
          `Token must not appear in argv argument: ${arg}`
        );
      }
    }

    // Verify the push command args contain clean target URL without credentials
    const pushCall = capturedCalls.find((c) => c.args.includes("push"));
    assert.ok(pushCall, "push command must be executed");
    assert.ok(
      pushCall.args.includes("https://github.com/fork-owner/fork-repo"),
      "push command must use plain targetRepoUrl"
    );

    const askpassInfo = JSON.parse(fs.readFileSync(path.join(dir, "askpass.json"), "utf8"));
    const { capturedAskpassPath, askpassDirMode, askpassFileMode, askpassPromptOutputUser, askpassPromptOutputPass } = askpassInfo;

    // Verify GIT_ASKPASS environment setup
    assert.ok(capturedAskpassPath, "GIT_ASKPASS path must be captured");
    assert.equal(askpassDirMode, 0o700, "Helper directory must have mode 0700");
    assert.equal(askpassFileMode, 0o700, "Helper script must have mode 0700");
    assert.equal(askpassPromptOutputUser, "x-access-token");
    assert.equal(askpassPromptOutputPass, secretToken);

    // Verify helper script and directory are deleted afterwards
    assert.equal(fs.existsSync(capturedAskpassPath!), false, "Helper script must be deleted after push");
    assert.equal(
      fs.existsSync(path.dirname(capturedAskpassPath!)),
      false,
      "Helper directory must be deleted after push"
    );
  });
});

test("pushToFork: error text is built without the token or URL credentials", async () => {
  const secretToken = "ghp_SENSITIVE_SECRET_TOKEN_EMBEDDED_999";
  const secretPassword = "sensitive_password_123";

  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const args = process.argv.slice(1);
  if (args.includes("rev-parse")) {
    process.stdout.write("abcdef1234567890\\n");
    process.exit(0);
  }
  if (args.includes("push")) {
    process.stderr.write("remote: Invalid token ${secretToken} for https://user:${secretPassword}@github.com/fork-owner/fork-repo\\n");
    process.exit(128);
  }
  process.exit(0);
' -- "$@"
`;

  await withFakeGitInPath(script, async () => {
    const service = new GitService({
      ownerLogin: "fork-owner",
      sourceRepoUrl: "https://github.com/source-owner/source-repo",
    });

    await assert.rejects(
      async () => {
        await service.pushToFork("run-err-redact-01", {
          pushConfirm: true,
          targetRepoUrl: "https://github.com/fork-owner/fork-repo",
          runPhase: "done",
          invitePushFlag: true,
          forkChecker: async () => "source-owner/source-repo",
          token: secretToken,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        // The secret token must NOT appear in message or stderr
        assert.equal(err.message.includes(secretToken), false, "Error message must not contain secret token");
        assert.equal(err.stderr?.includes(secretToken), false, "Error stderr must not contain secret token");
        // The embedded URL password must NOT appear in message or stderr
        assert.equal(err.message.includes(secretPassword), false, "Error message must not contain URL password");
        assert.equal(err.stderr?.includes(secretPassword), false, "Error stderr must not contain URL password");
        // Must contain [REDACTED]
        assert.ok(err.message.includes("[REDACTED]"), "Message must redact sensitive values");
        assert.ok(err.stderr?.includes("[REDACTED]"), "Stderr must redact sensitive values");
        return true;
      }
    );
  });
});

test("pushToFork: happy path with TestRepoContext integration head", async (t) => {
  const ctx = createTestRepoContext("run-push-happy", "task-push");
  t.after(() => ctx.cleanup());

  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args }) + "\\n");

  if (args.includes("rev-parse")) {
    process.stdout.write("${ctx.candidateSha}\\n");
    process.exit(0);
  }
  if (args.includes("push")) {
    process.stdout.write("Everything up-to-date\\n");
    process.exit(0);
  }
  process.exit(0);
' "$SCRIPT_DIR" -- "$@"
`;

  await withFakeGitInPath(script, async (dir) => {
    const service = new GitService({
      runsDir: ctx.tmpDir,
      ownerLogin: "target-owner",
      sourceRepoUrl: "https://github.com/source-owner/source-repo",
    });

    const res = await service.pushToFork(ctx.runId, {
      pushConfirm: true,
      targetRepoUrl: "https://github.com/target-owner/source-repo",
      runPhase: "done",
      invitePushFlag: true,
      forkChecker: async () => "source-owner/source-repo",
      token: "valid-write-token-12345",
      gitDir: ctx.gitDir,
    });

    assert.equal(res.ok, true);
    assert.equal(res.runId, ctx.runId);
    assert.equal(res.branch, `graveyard/${ctx.runId}`);
    assert.equal(res.targetRepoUrl, "https://github.com/target-owner/source-repo");
    assert.equal(res.commitSha, ctx.candidateSha);

    const lines = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    const capturedCalls = lines.map((l) => JSON.parse(l));
    const pushCall = capturedCalls.find((c) => c.args.includes("push"));
    const capturedArgs = pushCall ? pushCall.args : capturedCalls[capturedCalls.length - 1]?.args;

    assert.ok(capturedArgs?.includes(`refs/heads/graveyard/${ctx.runId}:refs/heads/graveyard/${ctx.runId}`));
    assert.equal(capturedArgs?.some((a: string) => a.includes("valid-write-token-12345")), false);
  });
});

test("rule 1: explicit paths - every git command uses explicit --git-dir and --work-tree, ignoring malicious .git in worktree", async (t) => {
  const ctx = createTestRepoContext("run-r1", "task-r1");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Create task worktree
  const worktreeResult = await service.createTaskWorktree({
    runId: ctx.runId,
    taskId: ctx.taskId,
    gitDir: ctx.gitDir,
    runDir: ctx.tmpDir,
  });

  // Tamper with container worktree's .git file to point outside
  const dotGitPath = path.join(worktreeResult.worktreeDir, ".git");
  fs.writeFileSync(dotGitPath, "gitdir: /tmp/untrusted-container-escape\n", "utf8");

  // Rebase candidate must still work because GitService resolves the host-side git directory
  const rebaseRes = await service.rebaseCandidate({
    runId: ctx.runId,
    taskId: ctx.taskId,
    gitDir: ctx.gitDir,
    runDir: ctx.tmpDir,
    worktreeDir: worktreeResult.worktreeDir,
  });

  assert.equal(rebaseRes.ok, true);
  assert.equal(rebaseRes.conflict, false);
  assert.ok(rebaseRes.candidateSha);
  assert.ok(rebaseRes.candidateSha256);

  await worktreeResult.cleanup();
});

test("rule 2: protocol isolation - protocol.allow=never on all commands; only network commands add protocol.https.allow=always for https", async () => {
  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args }) + "\\n");

  if (args.includes("rev-parse")) {
    process.stdout.write("1111222233334444555566667777888899990000\\n");
    process.exit(0);
  }
  process.exit(0);
' "$SCRIPT_DIR" -- "$@"
`;

  await withFakeGitInPath(script, async (dir) => {
    const service = new GitService({
      ownerLogin: "target-owner",
      sourceRepoUrl: "https://github.com/source-owner/source-repo",
    });

    // Non-network command (rev-parse via getCandidateFiles)
    await service.getCandidateFiles("HEAD~1", "HEAD", "/tmp/mock-git");
    let lines = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    let capturedCommands: Array<{ args: string[] }> = lines.map((l) => JSON.parse(l));
    const diffCmd = capturedCommands[capturedCommands.length - 1];
    assert.ok(diffCmd.args.includes("protocol.allow=never"), "Non-network command must include protocol.allow=never");
    assert.equal(
      diffCmd.args.includes("protocol.https.allow=always"),
      false,
      "Non-network command must NOT include protocol.https.allow=always"
    );

    // Network command: pushToFork
    await service.pushToFork("run-proto-01", {
      pushConfirm: true,
      targetRepoUrl: "https://github.com/target-owner/source-repo",
      runPhase: "done",
      invitePushFlag: true,
      forkChecker: async () => "source-owner/source-repo",
      token: "test-write-token",
      gitDir: "/tmp/mock-git",
    });

    lines = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    capturedCommands = lines.map((l) => JSON.parse(l));

    const pushCmd = capturedCommands.find((c) => c.args.includes("push"));
    assert.ok(pushCmd, "push command must be captured");
    assert.ok(pushCmd.args.includes("protocol.allow=never"), "push command must include protocol.allow=never");
    assert.ok(pushCmd.args.includes("protocol.https.allow=always"), "push command must include protocol.https.allow=always");
  });
});

test("rule 3: environment sanitization - options.env cannot override protected variables, non-allowlisted variables discarded", async () => {
  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const record = {
    args: process.argv.slice(2),
    env: process.env,
  };
  fs.writeFileSync(path.join(dir, "call.json"), JSON.stringify(record));
' "$SCRIPT_DIR" -- "$@"
exit 0
`;

  await withFakeGitInPath(script, async (dir) => {
    const service = new GitService();

    await service.execGit(["status"], {
      env: {
        PATH: "/malicious/bin",
        HOME: "/malicious/home",
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_CONFIG_GLOBAL: "/malicious/global",
        GIT_DIR: "/malicious/git",
        GIT_WORK_TREE: "/malicious/wt",
        GIT_ASKPASS: "/malicious/askpass",
        DANGEROUS_SECRET: "leak-attempt",
        GIT_AUTHOR_NAME: "Allowed Author",
      },
    });

    const callData = JSON.parse(fs.readFileSync(path.join(dir, "call.json"), "utf8"));
    const capturedEnv: NodeJS.ProcessEnv = callData.env;

    assert.ok(capturedEnv);
    assert.notEqual(capturedEnv.PATH, "/malicious/bin", "PATH cannot be overridden");
    assert.notEqual(capturedEnv.HOME, "/malicious/home", "HOME cannot be overridden");
    assert.equal(capturedEnv.GIT_CONFIG_NOSYSTEM, "1", "GIT_CONFIG_NOSYSTEM cannot be overridden");
    assert.equal(capturedEnv.GIT_CONFIG_GLOBAL, "/dev/null", "GIT_CONFIG_GLOBAL cannot be overridden");
    assert.equal(capturedEnv.GIT_DIR, undefined, "GIT_DIR cannot be set via options.env");
    assert.equal(capturedEnv.GIT_WORK_TREE, undefined, "GIT_WORK_TREE cannot be set via options.env");
    assert.equal(capturedEnv.GIT_ASKPASS, undefined, "GIT_ASKPASS cannot be set when not an authorized fork push");
    assert.equal(capturedEnv.DANGEROUS_SECRET, undefined, "Non-allowlisted variables must be discarded");
    assert.equal(capturedEnv.GIT_AUTHOR_NAME, "Allowed Author", "Allowlisted variables must be preserved");
  });
});

test("rule 4: pushToFork - strict https://github.com/<owner>/<repo> target URL and GITHUB_WRITE_TOKEN only", async () => {
  const service = new GitService({
    ownerLogin: "owner-login",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  // Rejects http
  await assert.rejects(
    async () => {
      await service.pushToFork("run-r4-1", {
        targetRepoUrl: "http://github.com/owner-login/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "write-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      return true;
    }
  );

  // Rejects other hosts
  await assert.rejects(
    async () => {
      await service.pushToFork("run-r4-2", {
        targetRepoUrl: "https://gitlab.com/owner-login/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "write-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      return true;
    }
  );

  // Rejects extra path segments
  await assert.rejects(
    async () => {
      await service.pushToFork("run-r4-3", {
        targetRepoUrl: "https://github.com/extra/owner-login/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "write-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      return true;
    }
  );

  // Rejects embedded credentials
  await assert.rejects(
    async () => {
      await service.pushToFork("run-r4-4", {
        targetRepoUrl: "https://user:pass@github.com/owner-login/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker: async () => "source-owner/source-repo",
        token: "write-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "INVALID_TARGET_URL");
      return true;
    }
  );

  // Write token fallback removal: GITHUB_TOKEN present but GITHUB_WRITE_TOKEN absent must fail
  const savedToken = process.env.GITHUB_TOKEN;
  const savedWriteToken = process.env.GITHUB_WRITE_TOKEN;
  process.env.GITHUB_TOKEN = "readonly-github-token-12345";
  delete process.env.GITHUB_WRITE_TOKEN;

  try {
    const noWriteTokenService = new GitService({
      ownerLogin: "owner-login",
      sourceRepoUrl: "https://github.com/source-owner/source-repo",
    });

    await assert.rejects(
      async () => {
        await noWriteTokenService.pushToFork("run-r4-5", {
          pushConfirm: true,
          targetRepoUrl: "https://github.com/owner-login/fork-repo",
          runPhase: "done",
          invitePushFlag: true,
          forkChecker: async () => "source-owner/source-repo",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        assert.equal(err.code, "MISSING_WRITE_TOKEN");
        return true;
      }
    );
  } finally {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
    if (savedWriteToken !== undefined) process.env.GITHUB_WRITE_TOKEN = savedWriteToken;
    else delete process.env.GITHUB_WRITE_TOKEN;
  }
});

test("rule 5: mergeCandidate - integrationBase equals head, revisions match ^[0-9a-f]{40}$, and --end-of-options prevents option injection", async (t) => {
  const ctx = createTestRepoContext("run-r5", "task-r5");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // 1. integrationBase does not equal current head of integration branch
  const resBaseMismatch = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    integrationBase: "0000000000000000000000000000000000000000",
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
  assert.equal(resBaseMismatch.ok, false);
  assert.equal(resBaseMismatch.merged, false);
  assert.ok(resBaseMismatch.reason?.includes("integrationBase"));

  // 2. candidateSha does not match ^[0-9a-f]{40}$ (e.g. option injection attempt)
  const resOptionInjection = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: "--output=/tmp/evil",
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
  assert.equal(resOptionInjection.ok, false);
  assert.equal(resOptionInjection.merged, false);
  assert.ok(resOptionInjection.reason?.includes("candidateSha"));

  // 3. candidateSha uppercase (not matching ^[0-9a-f]{40}$)
  const resUppercase = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha.toUpperCase(),
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
  assert.equal(resUppercase.ok, false);
  assert.equal(resUppercase.merged, false);

  // 4. integrationBase invalid format
  const resBadBaseFormat = await (service as any).mergeCandidate({
    runId: ctx.runId,
    candidateSha: ctx.candidateSha,
    expectedIntegrationHeadSha: ctx.baseSha,
    integrationBase: "--end-of-options",
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
  assert.equal(resBadBaseFormat.ok, false);
  assert.equal(resBadBaseFormat.merged, false);
});

test("rule 6: mergeCandidate keeps server-computed candidateSha256 and compare-and-swap update", async (t) => {
  const ctx = createTestRepoContext("run-r6", "task-r6");
  t.after(() => ctx.cleanup());

  const service = new GitService({ runsDir: ctx.tmpDir });

  // Compute diff and its candidateSha256
  const diffRes = await service.getCandidateDiff({
    fromRef: ctx.baseSha,
    toRef: ctx.candidateSha,
    gitDir: ctx.gitDir,
  });
  assert.equal(diffRes.sha256, ctx.candidateSha256);

  // Happy path merge with server-computed candidateSha256
  const mergeRes = await (service as any).mergeCandidate({
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

  assert.equal(mergeRes.ok, true);
  assert.equal(mergeRes.merged, true);
  assert.equal(mergeRes.newHeadSha, ctx.candidateSha);
  assert.equal(mergeRes.previousHeadSha, ctx.baseSha);

  // Verify compare-and-swap: attempting to merge again with old expected head fails
  const casRes = await (service as any).mergeCandidate({
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
  assert.equal(casRes.ok, false);
  assert.equal(casRes.merged, false);
});

test("pushToFork: refuses an explicit negative push confirmation", async () => {
  const service = new GitService({
    ownerLogin: "fork-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  await assert.rejects(
    async () => {
      await service.pushToFork("run-confirm-1", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        pushConfirm: false,
        forkChecker: async () => "source-owner/source-repo",
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "PUSH_NOT_CONFIRMED");
      return true;
    }
  );
});
test("pushToFork: omitted or undefined push confirmation is refused fail-closed", async () => {
  const service = new GitService({
    ownerLogin: "fork-owner",
    sourceRepoUrl: "https://github.com/source-owner/source-repo",
  });

  let checkerCalls = 0;
  const forkChecker = async () => {
    checkerCalls += 1;
    return "source-owner/source-repo";
  };

  // Omitted pushConfirm (undefined) is refused.
  await assert.rejects(
    async () => {
      await service.pushToFork("run-confirm-omit", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        forkChecker,
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "PUSH_NOT_CONFIRMED");
      return true;
    }
  );

  // An explicit undefined pushConfirm is refused too.
  await assert.rejects(
    async () => {
      await service.pushToFork("run-confirm-undefined", {
        targetRepoUrl: "https://github.com/fork-owner/fork-repo",
        runPhase: "done",
        invitePushFlag: true,
        pushConfirm: undefined,
        forkChecker,
        token: "test-token",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GitServiceError);
      assert.equal(err.code, "PUSH_NOT_CONFIRMED");
      return true;
    }
  );

  // Fail-closed: the refusal happens before any fork verification or remote work.
  assert.equal(checkerCalls, 0);
});



test("pushToFork: emits push.requested and push.result without leaking the token", async () => {
  const secretToken = ["gh", "p_", "event", "secret", "token", "9876"].join("");
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const args = process.argv.slice(1);
  if (args.includes("rev-parse")) {
    process.stdout.write("${sha}\\n");
    process.exit(0);
  }
  if (args.includes("push")) {
    process.stdout.write("Everything up-to-date\\n");
    process.exit(0);
  }
  process.exit(0);
' -- "$@"
`;

  await withFakeGitInPath(script, async () => {
    const eventStore = new EventStore(":memory:");
    const service = new GitService({
      ownerLogin: "fork-owner",
      sourceRepoUrl: "https://github.com/source-owner/source-repo",
    });

    const res = await service.pushToFork("run-push-events", {
      pushConfirm: true,
      targetRepoUrl: "https://github.com/fork-owner/fork-repo",
      runPhase: "done",
      invitePushFlag: true,
      forkChecker: async () => "source-owner/source-repo",
      token: secretToken,
      eventStore,
    });
    assert.equal(res.ok, true);

    const requested = eventStore.getEvents("run-push-events", { kind: "push.requested" });
    assert.equal(requested.length, 1);
    assert.equal(requested[0].data.branch, "graveyard/run-push-events");

    const result = eventStore.getEvents("run-push-events", { kind: "push.result" });
    assert.equal(result.length, 1);
    assert.equal(result[0].data.ok, true);
    assert.equal(result[0].data.commitSha, sha);

    const serialized = JSON.stringify(
      eventStore.getEvents("run-push-events", {
        kinds: ["push.requested", "push.result"],
      })
    );
    assert.equal(serialized.includes(secretToken), false, "token must never appear in events");
  });
});

test("pushToFork: holds an exclusive write lock per run", async () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const args = process.argv.slice(1);
  if (args.includes("rev-parse")) {
    setTimeout(() => { process.stdout.write("${sha}\\n"); process.exit(0); }, 400);
  } else {
    process.exit(0);
  }
' -- "$@"
`;

  await withFakeGitInPath(script, async () => {
    const service = new GitService({
      ownerLogin: "fork-owner",
      sourceRepoUrl: "https://github.com/source-owner/source-repo",
    });
    const options = {
      targetRepoUrl: "https://github.com/fork-owner/fork-repo",
      runPhase: "done" as const,
      invitePushFlag: true,
      pushConfirm: true,
      forkChecker: async () => "source-owner/source-repo",
      token: "test-token",
    };

    const first = service.pushToFork("run-lock-1", options);
    await new Promise((resolve) => setTimeout(resolve, 120));

    await assert.rejects(
      service.pushToFork("run-lock-1", options),
      (err: unknown) => {
        assert.ok(err instanceof GitServiceError);
        assert.equal(err.code, "PUSH_LOCK_HELD");
        return true;
      }
    );

    const res = await first;
    assert.equal(res.ok, true);
  });
});


