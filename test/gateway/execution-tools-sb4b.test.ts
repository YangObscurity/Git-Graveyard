// Work package SB4b tests: gateway execution tools
// - N-B4 (scan part): the worktree scan skips node_modules, .git, .next and dist
//   folders at any depth, and enforces a file count limit and a total byte limit;
//   above a limit it reports a finding and fails closed
// - N-2 / N-B9: the escape check and the later read share one O_NOFOLLOW file
//   descriptor verified against the expected root, so a symlink swapped in after
//   the check is rejected instead of followed

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectWorktreeFiles,
  checkPathEscape,
  scanWorktreeFilesBounded,
  handleSandboxExec,
  PathEscapeError,
  ScanLimitExceededError,
  MAX_WORKTREE_SCAN_FILES,
  type ExecutionToolsOptions,
} from "../../lib/gateway/execution-tools";
import { LogStore } from "../../lib/events/log-store";
import type { SandboxExecRefusedResult, ToolExecutionContext } from "../../lib/gateway/types";

const SKIPPED_DIR_NAMES = ["node_modules", ".git", ".next", "dist"];

test("SB4b N-B4 / RB2 N-B11: only root node_modules and .git folders are skipped, nested folders are scanned", () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb4b-skip-dirs-"));
  try {
    // Root-level node_modules and .git are skipped: secrets inside them never reach the scan
    fs.mkdirSync(path.join(worktreeDir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, "node_modules", "left-pad", "leaked.env"),
      "GITHUB_TOKEN=ghp_SB4bNodeModulesLeak00001\n"
    );
    fs.mkdirSync(path.join(worktreeDir, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, ".git", "hooks", "pre-commit"),
      "GITHUB_TOKEN=ghp_SB4bGitHooksLeak000001\n"
    );

    // Normal files are still scanned and collected
    fs.mkdirSync(path.join(worktreeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, "src", "index.ts"), "export const value = 123;\n");
    fs.writeFileSync(path.join(worktreeDir, "README.md"), "# Clean project\n");

    const scan = scanWorktreeFilesBounded(worktreeDir);
    assert.equal(scan.passed, true, "secrets inside root node_modules and .git must not fail the scan");
    assert.equal(scan.hasSecrets, false);
    assert.deepEqual(scan.flaggedFiles, []);

    const collected = collectWorktreeFiles(worktreeDir);
    const collectedPaths = collected.map((f) => f.path);
    assert.ok(collectedPaths.includes("src/index.ts"), "normal files are still collected");
    assert.ok(collectedPaths.includes("README.md"));
    for (const collectedPath of collectedPaths) {
      assert.equal(
        collectedPath.startsWith("node_modules") || collectedPath.startsWith(".git"),
        false,
        `collected path '${collectedPath}' must not traverse root node_modules or .git`
      );
    }
    const joinedContent = collected.map((f) => f.content).join("\n");
    assert.equal(
      joinedContent.includes("ghp_SB4bNodeModulesLeak00001"),
      false,
      "root node_modules content must not be collected"
    );
    assert.equal(
      joinedContent.includes("ghp_SB4bGitHooksLeak000001"),
      false,
      "git hooks content must not be collected"
    );

    // N-B11: Nested folders (packages/app/node_modules, .next, dist) ARE scanned and collected
    fs.mkdirSync(path.join(worktreeDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, "dist", "bundle.env"),
      "GITHUB_TOKEN=ghp_SB4bDistBundleLeak000001\n"
    );
    fs.mkdirSync(path.join(worktreeDir, ".next", "cache"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, ".next", "cache", "build.env"),
      "GITHUB_TOKEN=ghp_SB4bNextBuildLeak0000001\n"
    );
    fs.mkdirSync(path.join(worktreeDir, "packages", "app", "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, "packages", "app", "node_modules", "deep.env"),
      "GITHUB_TOKEN=ghp_SB4bNestedNodeModulesLeak1\n"
    );

    const nestedScan = scanWorktreeFilesBounded(worktreeDir);
    assert.equal(nestedScan.passed, false, "secrets inside nested folders must be detected");
    assert.equal(nestedScan.hasSecrets, true);
    assert.ok(nestedScan.flaggedFiles.includes("dist/bundle.env"));
    assert.ok(nestedScan.flaggedFiles.includes(".next/cache/build.env"));
    assert.ok(nestedScan.flaggedFiles.includes("packages/app/node_modules/deep.env"));

    const nestedCollected = collectWorktreeFiles(worktreeDir);
    const nestedPaths = nestedCollected.map((f) => f.path);
    assert.ok(nestedPaths.includes("dist/bundle.env"), "dist must be collected");
    assert.ok(nestedPaths.includes(".next/cache/build.env"), ".next must be collected");
    assert.ok(nestedPaths.includes("packages/app/node_modules/deep.env"), "nested node_modules must be collected");
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("SB4b N-B4: a file count over the limit fails closed", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb4b-limit-"));
  try {
    const totalFiles = MAX_WORKTREE_SCAN_FILES + 1;
    for (let i = 0; i < totalFiles; i++) {
      fs.writeFileSync(
        path.join(worktreeDir, `pad_${String(i).padStart(4, "0")}.txt`),
        `clean line ${i}\n`
      );
    }

    // collectWorktreeFiles refuses with a finding instead of returning an unbounded list
    assert.throws(
      () => collectWorktreeFiles(worktreeDir),
      (err: unknown) =>
        err instanceof ScanLimitExceededError &&
        err.code === "SCAN_LIMIT_EXCEEDED" &&
        Array.isArray(err.findings) &&
        err.findings.length > 0 &&
        typeof err.findings[0].fingerprint === "string"
    );

    // the bounded scan fails closed the same way
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir),
      (err: unknown) => err instanceof ScanLimitExceededError && err.code === "SCAN_LIMIT_EXCEEDED"
    );

    // end to end the gateway refuses before any command is dispatched
    let runnerExecuted = false;
    const context: ToolExecutionContext = {
      skeletonId: "skel-sb4b-limit",
      role: "Soul-stitcher",
      bearerToken: "token-sb4b-limit",
      worktreeRoot: worktreeDir,
      runId: "run-sb4b-limit",
    };
    const res = (await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          runnerExecuted = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "SCAN_LIMIT_EXCEEDED");
    assert.equal(runnerExecuted, false, "no command may run when the scan limit is exceeded");
    assert.ok(res.findings && res.findings.length > 0, "the refusal reports a finding");
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("SB4b N-2: a symlink swapped in after the check is rejected, not followed", () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb4b-swap-wt-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb4b-swap-out-"));
  try {
    const checkedPath = path.join(worktreeDir, "checked.txt");
    fs.writeFileSync(checkedPath, "clean content before the swap\n");
    const outsideEnv = path.join(outsideDir, "outside.env");
    fs.writeFileSync(outsideEnv, "GITHUB_TOKEN=ghp_SB4bSwappedSymlinkLeak1\n");
    fs.writeFileSync(path.join(worktreeDir, "other.txt"), "inside target content\n");

    const realWorktreeRoot = fs.realpathSync(worktreeDir);
    const callerOptions = { worktreeFiles: ["checked.txt"] } as unknown as ExecutionToolsOptions;
    const callerParams = { argv: ["git", "status"], files: ["checked.txt"] };

    // 1. The check passes while checked.txt is still a regular file
    assert.equal(checkPathEscape("checked.txt", worktreeDir, realWorktreeRoot), false);

    // 2. Swap it for a symlink pointing outside the worktree, after the check
    fs.unlinkSync(checkedPath);
    fs.symlinkSync(outsideEnv, checkedPath);

    // 3. The later read refuses the swapped file instead of following it
    assert.throws(
      () => collectWorktreeFiles(worktreeDir, undefined, callerOptions),
      (err: unknown) => err instanceof PathEscapeError && err.code === "PATH_ESCAPE"
    );
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir, undefined, callerOptions, callerParams),
      (err: unknown) => err instanceof PathEscapeError && err.code === "PATH_ESCAPE"
    );

    // 4. A symlink that stays inside the worktree is rejected the same way: the
    // escape check still passes, but the O_NOFOLLOW descriptor refuses to read
    // through any symlink swapped in after the check
    fs.unlinkSync(checkedPath);
    fs.symlinkSync(path.join(worktreeDir, "other.txt"), checkedPath);
    assert.equal(checkPathEscape("checked.txt", worktreeDir, realWorktreeRoot), false);
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir, undefined, callerOptions, callerParams),
      (err: unknown) => err instanceof PathEscapeError && err.code === "PATH_ESCAPE"
    );
    assert.throws(
      () => collectWorktreeFiles(worktreeDir, undefined, callerOptions),
      (err: unknown) => err instanceof PathEscapeError && err.code === "PATH_ESCAPE"
    );

    // The refusal is targeted, not a general breakage: after the swap the clean
    // file is still collected and the swapped symlink contributed nothing
    const okOptions = { worktreeFiles: ["other.txt"] } as unknown as ExecutionToolsOptions;
    const collected = collectWorktreeFiles(worktreeDir, undefined, okOptions);
    assert.ok(collected.length > 0, "a clean caller file is still collected after the swap");
    for (const entry of collected) {
      assert.equal(entry.path, "other.txt");
      assert.equal(
        entry.content.includes("ghp_SB4bSwappedSymlinkLeak1"),
        false,
        "the outside secret must never appear in collected content"
      );
    }
    assert.ok(
      collected.some((entry) => entry.content === "inside target content\n"),
      "the clean inside file content is still collected"
    );
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
