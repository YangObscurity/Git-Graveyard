import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleSandboxExec,
  scanWorktreeFilesBounded,
  PathEscapeError,
} from "../../lib/gateway/execution-tools";
import { LogStore } from "../../lib/events/log-store";
import type {
  SandboxExecCompletedResult,
  SandboxExecRefusedResult,
  ToolExecutionContext,
} from "../../lib/gateway/types";

test("R5A2: a secret in a file larger than 1 MB is still refused", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5a2-large-file-"));
  try {
    const largeFilePath = path.join(worktreeDir, "large-dataset.txt");
    const prefix = Buffer.alloc(1024 * 1024 + 4096, 0x61); // ~1 MB + 4 KB
    const secret = Buffer.from("\nghp_LargeFileSecretKey1234567890123456\n");
    const suffix = Buffer.alloc(16 * 1024, 0x62); // 16 KB
    fs.writeFileSync(largeFilePath, Buffer.concat([prefix, secret, suffix]));

    const context: ToolExecutionContext = {
      skeletonId: "skel-r5a2-large",
      role: "Soul-stitcher",
      bearerToken: "token-r5a2-1",
      worktreeRoot: worktreeDir,
      runId: "run-r5a2-large",
    };

    let runnerExecuted = false;
    const res = (await handleSandboxExec(
      {
        argv: ["git", "status"],
      },
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
    assert.equal(res.code, "SECRET_DETECTED");
    assert.equal(runnerExecuted, false, "Runner must not execute when secret exists in large file");
    assert.ok(res.findings && res.findings.length > 0);
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R5A2: a worktree with several clean files passes", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5a2-clean-wt-"));
  try {
    fs.writeFileSync(path.join(worktreeDir, "index.ts"), "export const value = 123;\n");
    fs.writeFileSync(path.join(worktreeDir, "README.md"), "# Project Overview\nClean repository.\n");
    const subDir = path.join(worktreeDir, "src", "nested");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "util.ts"), "export function add(a: number, b: number) { return a + b; }\n");

    const context: ToolExecutionContext = {
      skeletonId: "skel-r5a2-clean",
      role: "Soul-stitcher",
      bearerToken: "token-r5a2-2",
      worktreeRoot: worktreeDir,
      runId: "run-r5a2-clean",
    };

    let runnerExecuted = false;
    const res = (await handleSandboxExec(
      {
        argv: ["git", "status"],
      },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          runnerExecuted = true;
          return { exitCode: 0, stdout: "on branch main\n", stderr: "" };
        }) as any,
      }
    )) as SandboxExecCompletedResult;

    assert.equal(res.status, "completed");
    assert.equal(res.exit_code, 0);
    assert.equal(runnerExecuted, true, "Runner must execute when all worktree files are clean");
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R5A2: a secret in the last of many files is refused", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5a2-last-file-"));
  try {
    const totalFiles = 25;
    for (let i = 0; i < totalFiles - 1; i++) {
      const fileName = `module_${String(i).padStart(2, "0")}.txt`;
      fs.writeFileSync(path.join(worktreeDir, fileName), `Clean module content line ${i}\n`);
    }

    const lastFileName = `module_${String(totalFiles - 1).padStart(2, "0")}.txt`;
    fs.writeFileSync(
      path.join(worktreeDir, lastFileName),
      "GITHUB_TOKEN=ghp_LastFileSecretToken12345678901234\n"
    );

    const context: ToolExecutionContext = {
      skeletonId: "skel-r5a2-last",
      role: "Soul-stitcher",
      bearerToken: "token-r5a2-3",
      worktreeRoot: worktreeDir,
      runId: "run-r5a2-last",
    };

    let runnerExecuted = false;
    const res = (await handleSandboxExec(
      {
        argv: ["git", "status"],
      },
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
    assert.equal(res.code, "SECRET_DETECTED");
    assert.equal(runnerExecuted, false, "Runner must not execute when last file has secret");
    assert.ok(res.findings && res.findings.length > 0);
    assert.ok(
      res.findings.some((f) => f.path.includes(lastFileName)),
      "Findings must report the last file containing the secret"
    );
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R5A2: scanWorktreeFilesBounded merges per-file results and concatenates violations", () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5a2-merge-scan-"));
  try {
    fs.writeFileSync(
      path.join(worktreeDir, "first.env"),
      "GITHUB_TOKEN=ghp_FirstSecretToken1234567890123456\n"
    );
    fs.writeFileSync(
      path.join(worktreeDir, "second.env"),
      "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLESK2\n"
    );
    fs.writeFileSync(path.join(worktreeDir, "clean.txt"), "This file is clean.\n");

    const scan = scanWorktreeFilesBounded(worktreeDir);
    assert.equal(scan.passed, false);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.shouldQuarantine, true);
    assert.equal(scan.violations.length, 2);
    assert.equal(scan.flaggedFiles.length, 2);
    assert.ok(scan.flaggedFiles.includes("first.env"));
    assert.ok(scan.flaggedFiles.includes("second.env"));
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R5A2: path escape check in scanWorktreeFilesBounded throws PathEscapeError without reading", () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5a2-escape-check-"));
  try {
    assert.throws(
      () => {
        scanWorktreeFilesBounded(worktreeDir, undefined, undefined, {
          argv: ["git", "status"],
          files: ["../outside-escape.txt"],
        });
      },
      (err: any) => err instanceof PathEscapeError && err.code === "PATH_ESCAPE"
    );
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});
