/**
 * Work package SC3: exhume harness.
 * N-C5 (exhume part): dispatchCommand never treats a missing exit code as 0 (passed);
 * it throws RunnerExitCodeError instead.
 * L-7 (residual): a failing realpath for the allowed root throws; there is no
 * path.resolve fallback.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RunnerExitCodeError } from "../../lib/backend/docker-exec-stream";
import type { ExecProcess } from "../../lib/backend/types";
import {
  BindPathNotFoundError,
  ExhumerHarness,
  validateBindPath,
} from "../../lib/exhume/exhume-harness";

test("SC3: dispatchCommand throws RunnerExitCodeError when the exit code is missing", async () => {
  const runHarness = new ExhumerHarness({
    runId: "sc3-run-no-exit-code",
    baseSha: "sc3-base",
    runner: {
      run: async () => ({ logRef: "sc3-log", oomKilled: false, timedOut: false }),
    },
    wallClockTimeoutMs: 60000,
  });

  await assert.rejects(
    () => (runHarness as any).dispatchCommand(["node", "--version"], "sc3-log", 1000),
    RunnerExitCodeError
  );

  const nullCodeHarness = new ExhumerHarness({
    runId: "sc3-run-null-exit-code",
    baseSha: "sc3-base",
    runner: {
      run: async () => ({
        logRef: "sc3-log",
        exitCode: null,
        oomKilled: false,
        timedOut: false,
      }),
    },
    wallClockTimeoutMs: 60000,
  });

  await assert.rejects(
    () => (nullCodeHarness as any).dispatchCommand(["node", "--version"], "sc3-log", 1000),
    RunnerExitCodeError
  );

  const nullWaitHarness = new ExhumerHarness({
    runId: "sc3-exec-null-wait",
    baseSha: "sc3-base",
    runner: {
      exec: async () => ({ wait: async () => ({ exitCode: null }) }),
    },
    wallClockTimeoutMs: 60000,
  });

  await assert.rejects(
    () => (nullWaitHarness as any).dispatchCommand(["node", "--version"], "sc3-log", 1000),
    RunnerExitCodeError
  );

  const noWaitHarness = new ExhumerHarness({
    runId: "sc3-exec-no-wait",
    baseSha: "sc3-base",
    runner: {
      exec: async () => ({}) as ExecProcess,
    },
    wallClockTimeoutMs: 60000,
  });

  await assert.rejects(
    () => (noWaitHarness as any).dispatchCommand(["node", "--version"], "sc3-log", 1000),
    RunnerExitCodeError
  );
});

test("SC3: validateBindPath throws when the allowed root does not exist", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc3-allowed-root-"));
  try {
    const bindDir = path.join(baseDir, "builders");
    fs.mkdirSync(bindDir);

    const missingRoot = path.join(baseDir, "missing-root");
    assert.equal(fs.existsSync(missingRoot), false);

    assert.throws(
      () =>
        validateBindPath(bindDir, {
          expectedSegment: "builders",
          allowedRoot: missingRoot,
        }),
      BindPathNotFoundError
    );

    const resolved = validateBindPath(bindDir, {
      expectedSegment: "builders",
      allowedRoot: baseDir,
    });
    assert.equal(path.basename(resolved), "builders");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("SC3: harness constructor throws when the allowed root does not exist", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc3-constructor-root-"));
  try {
    const bindDir = path.join(baseDir, "builders");
    fs.mkdirSync(bindDir);
    const missingRoot = path.join(baseDir, "missing-root");

    assert.throws(
      () =>
        new ExhumerHarness({
          runId: "sc3-constructor-missing-root",
          baseSha: "sc3-base",
          runner: async () => ({ exitCode: 0, logRef: "sc3-log" }),
          bindPath: bindDir,
          allowedRoot: missingRoot,
          wallClockTimeoutMs: 60000,
        }),
      BindPathNotFoundError
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
