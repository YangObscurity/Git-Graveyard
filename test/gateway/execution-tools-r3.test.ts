import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleSandboxExec } from "../../lib/gateway/execution-tools";
import type { ToolExecutionContext } from "../../lib/gateway/types";
import { LogStore } from "../../lib/events/log-store";

test("a params.files entry cannot hide a secret in an enumerated file", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-hide-secret-"));
  try {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(configPath, '{"apiKey": "ghp_WorktreeDiskSecret1234567890123456"}\n');

    const context: ToolExecutionContext = {
      skeletonId: "skel-r3-soul",
      role: "Soul-stitcher",
      bearerToken: "token-r3-1",
      worktreeRoot: tmpDir,
      runId: "run-r3-h1",
    };

    let runnerRan = false;
    const res = await handleSandboxExec(
      {
        argv: ["git", "status"],
        files: [
          {
            path: "config.json",
            content: '{"apiKey": "clean-no-secret"}',
          },
        ],
      },
      context,
      {
        defaultTimeoutMs: 60000,
        runbox: (async () => {
          runnerRan = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    );

    assert.equal(res.status, "refused");
    assert.equal((res as { code: string }).code, "SECRET_DETECTED");
    assert.equal(runnerRan, false, "Runner must not execute when secret exists on disk");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a secret inside node_modules is not reported because node_modules is not scanned", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-nm-secret-"));
  try {
    const depDir = path.join(tmpDir, "node_modules", "vendor-pkg");
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(
      path.join(depDir, "auth.js"),
      'const token = "ghp_NodeModulesSecret1234567890123456";\n'
    );

    const context: ToolExecutionContext = {
      skeletonId: "skel-r3-nm",
      role: "Soul-stitcher",
      bearerToken: "token-r3-2",
      worktreeRoot: tmpDir,
      runId: "run-r3-l4-nm",
    };

    let runnerRan = false;
    const mockRunner = (async () => {
      runnerRan = true;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    }) as any;

    // node_modules is skipped at any depth by the worktree scan, so the secret
    // inside it is not reported and the command runs normally.
    const resNm = await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: mockRunner,
      }
    );
    assert.equal(resNm.status, "completed");
    assert.equal(runnerRan, true, "Runner must run when the only secret is inside node_modules");

    // The same kind of secret in a normal file under the same worktree is reported.
    runnerRan = false;
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      '{"apiKey": "ghp_NormalFileSecret1234567890123456"}\n'
    );
    const resFile = await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: mockRunner,
      }
    );
    assert.equal(resFile.status, "refused");
    assert.equal((resFile as { code: string }).code, "SECRET_DETECTED");
    assert.equal(runnerRan, false, "Runner must not execute when secret is in a normal worktree file");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a secret inside a file larger than 1 MB is found", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-large-file-"));
  try {
    const filePath = path.join(tmpDir, "large-dataset.txt");
    const prefix = Buffer.alloc(1024 * 1024 + 1024, 0x61); // ~1 MB + 1 KB of 'a'
    const secret = Buffer.from("\nghp_LargeFileSecret1234567890123456\n");
    const suffix = Buffer.alloc(64 * 1024, 0x62); // 64 KB of 'b'
    fs.writeFileSync(filePath, Buffer.concat([prefix, secret, suffix]));

    const context: ToolExecutionContext = {
      skeletonId: "skel-r3-large",
      role: "Soul-stitcher",
      bearerToken: "token-r3-3",
      worktreeRoot: tmpDir,
      runId: "run-r3-l4-large",
    };

    let runnerRan = false;
    const res = await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        runbox: (async () => {
          runnerRan = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    );

    assert.equal(res.status, "refused");
    assert.equal((res as { code: string }).code, "SECRET_DETECTED");
    assert.equal(runnerRan, false, "Runner must not execute when secret is inside file larger than 1 MB");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a missing timeout setting rejects", async () => {
  const context: ToolExecutionContext = {
    skeletonId: "skel-r3-timeout",
    role: "Soul-stitcher",
    bearerToken: "token-r3-4",
    worktreeRoot: "/workspace/project",
    runId: "run-r3-m3-timeout",
  };

  const mockRunner = (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any;

  // Options without defaultTimeoutMs rejects with MISSING_TIMEOUT_SETTING
  const resNoSetting = await handleSandboxExec(
    { argv: ["git", "status"] },
    context,
    { runbox: mockRunner }
  );
  assert.equal(resNoSetting.status, "refused");
  assert.equal((resNoSetting as { code: string }).code, "MISSING_TIMEOUT_SETTING");

  // Options omitted entirely with sandbox in context rejects
  const resNoOpts = await handleSandboxExec(
    { argv: ["git", "status"] },
    { ...context, runbox: mockRunner }
  );
  assert.equal(resNoOpts.status, "refused");
  assert.equal((resNoOpts as { code: string }).code, "MISSING_TIMEOUT_SETTING");

  // Invalid defaultTimeoutMs (zero or negative) rejects
  const resZero = await handleSandboxExec(
    { argv: ["git", "status"] },
    context,
    { defaultTimeoutMs: 0, runbox: mockRunner }
  );
  assert.equal(resZero.status, "refused");
  assert.equal((resZero as { code: string }).code, "MISSING_TIMEOUT_SETTING");
});

test("null params gives a named validation error", async () => {
  const context: ToolExecutionContext = {
    skeletonId: "skel-r3-null",
    role: "Soul-stitcher",
    bearerToken: "token-r3-5",
    worktreeRoot: "/workspace/project",
    runId: "run-r3-l5-null",
  };

  const resNull = await handleSandboxExec(null as any, context, { defaultTimeoutMs: 60000 });
  assert.equal(resNull.status, "refused");
  assert.equal((resNull as { code: string }).code, "INVALID_PARAMS");
  assert.ok((resNull as { error: string }).error.length > 0);

  const resUndef = await handleSandboxExec(undefined as any, context, { defaultTimeoutMs: 60000 });
  assert.equal(resUndef.status, "refused");
  assert.equal((resUndef as { code: string }).code, "INVALID_PARAMS");
});

test("a non-integer timeoutMs is rejected", async () => {
  const context: ToolExecutionContext = {
    skeletonId: "skel-r3-nonint",
    role: "Soul-stitcher",
    bearerToken: "token-r3-6",
    worktreeRoot: "/workspace/project",
    runId: "run-r3-l5-nonint",
  };

  const mockRunner = (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any;

  // Float timeoutMs
  const resFloat = await handleSandboxExec(
    { argv: ["git", "status"], timeoutMs: 12.5 },
    context,
    { defaultTimeoutMs: 60000, runbox: mockRunner }
  );
  assert.equal(resFloat.status, "refused");
  assert.equal((resFloat as { code: string }).code, "INVALID_TIMEOUT");

  // NaN timeoutMs
  const resNaN = await handleSandboxExec(
    { argv: ["git", "status"], timeoutMs: NaN },
    context,
    { defaultTimeoutMs: 60000, runbox: mockRunner }
  );
  assert.equal(resNaN.status, "refused");
  assert.equal((resNaN as { code: string }).code, "INVALID_TIMEOUT");

  // Infinity timeoutMs
  const resInf = await handleSandboxExec(
    { argv: ["git", "status"], timeoutMs: Infinity },
    context,
    { defaultTimeoutMs: 60000, runbox: mockRunner }
  );
  assert.equal(resInf.status, "refused");
  assert.equal((resInf as { code: string }).code, "INVALID_TIMEOUT");
});
