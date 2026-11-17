/**
 * Work package RC3: Second-round C-audit residual N-C5 / M-5.
 * Tests that thrown runner/infrastructure errors record status: 'failed',
 * exitCode: null, and reason starting with 'infrastructure error:',
 * whereas normal non-zero command execution returning exitCode: 1 still
 * records exitCode: 1.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe, it } from "node:test";
import { RunnerExitCodeError } from "../../lib/backend/docker-exec-stream";
import type { EventInput } from "../../lib/events/event-store";
import {
  ExhumerHarness,
  RunnerRequiredError,
  runExhumerHarness,
  type CommandExecutionResult,
} from "../../lib/exhume/exhume-harness";
import { scanBaseTreeFiles, runGrimoireBaseAnalysis } from "../../lib/exhume/triage";

describe("RC3: Infrastructure error exitCode null distinction (N-C5 / M-5)", () => {
  it("records status: 'failed', exitCode: null, and infrastructure error reason when runner throws", async () => {
    const harness = new ExhumerHarness({
      runId: "rc3-infra-error-fn",
      baseSha: "sha-rc3-01",
      runner: async (): Promise<CommandExecutionResult> => {
        throw new Error("container spawn failed: out of memory on host");
      },
      wallClockTimeoutMs: 60000,
    });

    const result = await harness.executeInRunbox(["npm", "test"], "test");

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, null);
    assert.ok(
      result.reason?.startsWith("infrastructure error:"),
      `Expected reason to start with 'infrastructure error:', got: ${result.reason}`
    );
    assert.equal(
      result.reason,
      "infrastructure error: container spawn failed: out of memory on host"
    );
    assert.equal(
      result.error,
      "container spawn failed: out of memory on host"
    );
  });

  it("works identically via runCommandStep alias", async () => {
    const harness = new ExhumerHarness({
      runId: "rc3-infra-error-alias",
      baseSha: "sha-rc3-02",
      runner: async (): Promise<CommandExecutionResult> => {
        throw new Error("docker daemon connection refused");
      },
      wallClockTimeoutMs: 60000,
    });

    const result = await harness.runCommandStep(["npm", "test"], "test");

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, null);
    assert.ok(result.reason?.startsWith("infrastructure error:"));
    assert.equal(
      result.reason,
      "infrastructure error: docker daemon connection refused"
    );
    assert.equal(result.error, "docker daemon connection refused");
  });

  it("still records exitCode: 1 for normal non-zero command execution", async () => {
    const harness = new ExhumerHarness({
      runId: "rc3-normal-exit-1",
      baseSha: "sha-rc3-03",
      runner: async (): Promise<CommandExecutionResult> => {
        return {
          exitCode: 1,
          stderr: "npm ERR! Test failed. See above for more details.",
        };
      },
      wallClockTimeoutMs: 60000,
    });

    const result = await harness.executeInRunbox(["npm", "test"], "test");

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.reason, undefined);
    assert.equal(result.error, undefined);
  });

  it("records exitCode: 0 and status: 'passed' for successful command", async () => {
    const harness = new ExhumerHarness({
      runId: "rc3-normal-exit-0",
      baseSha: "sha-rc3-04",
      runner: async (): Promise<CommandExecutionResult> => {
        return {
          exitCode: 0,
          stdout: "tests passed: 42 passed, 0 failed",
        };
      },
      wallClockTimeoutMs: 60000,
    });

    const result = await harness.executeInRunbox(["npm", "test"], "test");

    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, undefined);
    assert.equal(result.error, undefined);
  });

  it("handles object runner throwing RunnerExitCodeError on null exitCode with exitCode: null", async () => {
    const harness = new ExhumerHarness({
      runId: "rc3-runner-null-code",
      baseSha: "sha-rc3-05",
      runner: {
        run: async () => ({
          exitCode: null,
          logRef: "rc3-log",
        }),
      },
      wallClockTimeoutMs: 60000,
    });

    const result = await harness.executeInRunbox(["npm", "test"], "test");

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, null);
    assert.ok(result.reason?.startsWith("infrastructure error:"));
    assert.match(result.reason!, /no exit code/i);
  });

  it("handles non-Error thrown values cleanly as infrastructure errors", async () => {
    const harness = new ExhumerHarness({
      runId: "rc3-string-throw",
      baseSha: "sha-rc3-06",
      runner: async (): Promise<CommandExecutionResult> => {
        throw "network socket reset by peer";
      },
      wallClockTimeoutMs: 60000,
    });

    const result = await harness.executeInRunbox(["npm", "test"], "test");

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, null);
    assert.equal(
      result.reason,
      "infrastructure error: network socket reset by peer"
    );
    assert.equal(result.error, "network socket reset by peer");
  });

  it("re-throws RunnerRequiredError without converting to infrastructure error", async () => {
    const harness = new ExhumerHarness({
      runId: "rc3-no-runner",
      baseSha: "sha-rc3-07",
      wallClockTimeoutMs: 60000,
      backend: {
        create: async () => undefined as any,
      },
    });

    await assert.rejects(
      async () => harness.executeInRunbox(["npm", "test"], "test"),
      RunnerRequiredError
    );
  });

  it("emits command.result event with exitCode: null on infrastructure error", async () => {
    const emittedEvents: EventInput[] = [];
    const harness = new ExhumerHarness({
      runId: "rc3-event-infra",
      baseSha: "sha-rc3-08",
      runner: async (): Promise<CommandExecutionResult> => {
        throw new Error("infrastructure container crash");
      },
      wallClockTimeoutMs: 60000,
      emitEvent: (event: EventInput) => {
        emittedEvents.push(event);
      },
    });

    await harness.executeInRunbox(["npm", "test"], "test");

    const resultEvent = emittedEvents.find((e) => e.kind === "command.result");
    assert.ok(resultEvent);
    assert.equal(resultEvent.data?.exitCode, null);
    assert.equal(resultEvent.data?.status, "failed");
    assert.equal(resultEvent.data?.error, "infrastructure container crash");
  });

  it("propagates exitCode: null and infrastructure error reason into DeathCertificate without crashing", async () => {
    const result = await runExhumerHarness({
      runId: "rc3-full-harness",
      baseSha: "sha-rc3-09",
      runner: async (argv: string[]): Promise<CommandExecutionResult> => {
        if (argv.includes("install") || argv.includes("ci")) {
          throw new Error("failed to launch container runner");
        }
        return { exitCode: 0, stdout: "1.0.0" };
      },
      wallClockTimeoutMs: 60000,
      packageJson: {
        name: "rc3-pkg",
        scripts: {
          build: "echo build",
          test: "echo test",
        },
      },
      files: ["package.json"],
    });

    const cert = result.deathCertificate;
    assert.equal(cert.healthy, false);
    assert.equal(cert.install.status, "failed");
    assert.equal(cert.install.exitCode, null);
    assert.ok(
      cert.install.reason?.startsWith("infrastructure error:"),
      `Expected install.reason to start with 'infrastructure error:', got: ${cert.install.reason}`
    );
    assert.equal((cert.install as any).error, "failed to launch container runner");

    // Downstream build and test steps are marked not run without crashing
    assert.equal(cert.build.status, "not run");
    assert.equal(cert.test.status, "not run");
  });

  describe("Path C: Number.isInteger exitCode check and runner env sanitization", () => {
    it("throws RunnerExitCodeError on NaN exitCode via function runner in dispatchCommand", async () => {
      const harness = new ExhumerHarness({
        runId: "rc3-nan-exitcode-fn",
        baseSha: "sha-rc3-nan",
        wallClockTimeoutMs: 60000,
        runner: async () => ({
          exitCode: NaN as any,
          logRef: "nan-log",
        }),
      });

      await assert.rejects(
        async () => harness.dispatchCommand(["npm", "test"], "ref"),
        RunnerExitCodeError
      );
    });

    it("throws RunnerExitCodeError on float exitCode via function runner in dispatchCommand", async () => {
      const harness = new ExhumerHarness({
        runId: "rc3-float-exitcode-fn",
        baseSha: "sha-rc3-float",
        wallClockTimeoutMs: 60000,
        runner: async () => ({
          exitCode: 1.5 as any,
          logRef: "float-log",
        }),
      });

      await assert.rejects(
        async () => harness.dispatchCommand(["npm", "test"], "ref"),
        RunnerExitCodeError
      );
    });

    it("throws RunnerExitCodeError on NaN or float exitCode via object runner (run)", async () => {
      const harnessNan = new ExhumerHarness({
        runId: "rc3-nan-obj",
        baseSha: "sha-rc3-nan-obj",
        wallClockTimeoutMs: 60000,
        runner: {
          run: async () => ({
            exitCode: NaN as any,
            logRef: "nan-obj-log",
          }),
        },
      });

      await assert.rejects(
        async () => harnessNan.dispatchCommand(["npm", "test"], "ref"),
        RunnerExitCodeError
      );

      const harnessFloat = new ExhumerHarness({
        runId: "rc3-float-obj",
        baseSha: "sha-rc3-float-obj",
        wallClockTimeoutMs: 60000,
        runner: {
          run: async () => ({
            exitCode: 2.718 as any,
            logRef: "float-obj-log",
          }),
        },
      });

      await assert.rejects(
        async () => harnessFloat.dispatchCommand(["npm", "test"], "ref"),
        RunnerExitCodeError
      );
    });

    it("throws RunnerExitCodeError on NaN or float exitCode via exec runner (proc.wait)", async () => {
      const harnessExecNan = new ExhumerHarness({
        runId: "rc3-nan-exec",
        baseSha: "sha-rc3-nan-exec",
        wallClockTimeoutMs: 60000,
        runner: {
          exec: async () => ({
            wait: async () => ({
              exitCode: NaN as any,
              timedOut: false,
              oomKilled: false,
            }),
          }),
        },
      });

      await assert.rejects(
        async () => harnessExecNan.dispatchCommand(["npm", "test"], "ref"),
        RunnerExitCodeError
      );

      const harnessExecFloat = new ExhumerHarness({
        runId: "rc3-float-exec",
        baseSha: "sha-rc3-float-exec",
        wallClockTimeoutMs: 60000,
        runner: {
          exec: async () => ({
            wait: async () => ({
              exitCode: 3.14 as any,
              timedOut: false,
              oomKilled: false,
            }),
          }),
        },
      });

      await assert.rejects(
        async () => harnessExecFloat.dispatchCommand(["npm", "test"], "ref"),
        RunnerExitCodeError
      );
    });

    it("catches NaN and float exitCodes in executeInRunbox and fails with exitCode: null", async () => {
      const harness = new ExhumerHarness({
        runId: "rc3-nan-execute",
        baseSha: "sha-rc3-nan-exec-runbox",
        wallClockTimeoutMs: 60000,
        runner: async () => ({
          exitCode: NaN as any,
        }),
      });

      const resNan = await harness.executeInRunbox(["npm", "test"], "test");
      assert.equal(resNan.status, "failed");
      assert.equal(resNan.exitCode, null);
      assert.ok(resNan.reason?.startsWith("infrastructure error:"));
      assert.match(resNan.reason!, /no exit code/i);

      const harnessFloat = new ExhumerHarness({
        runId: "rc3-float-execute",
        baseSha: "sha-rc3-float-exec-runbox",
        wallClockTimeoutMs: 60000,
        runner: async () => ({
          exitCode: 0.5 as any,
        }),
      });

      const resFloat = await harnessFloat.executeInRunbox(["npm", "test"], "test");
      assert.equal(resFloat.status, "failed");
      assert.equal(resFloat.exitCode, null);
      assert.ok(resFloat.reason?.startsWith("infrastructure error:"));
      assert.match(resFloat.reason!, /no exit code/i);
    });

    it("strips untrusted host environment variables when building runner env", async () => {
      let capturedEnv: Record<string, string> | undefined;
      const harness = new ExhumerHarness({
        runId: "rc3-strip-env",
        baseSha: "sha-rc3-strip",
        wallClockTimeoutMs: 60000,
        env: {
          PATH: "/usr/bin:/bin",
          SAFE_HOST_VAR: "allowed",
          NODE_OPTIONS: "--require /tmp/malicious.js",
          LD_PRELOAD: "/tmp/evil.so",
          KIRO_API_KEY: "secret123",
          GITHUB_TOKEN: "ghp_secrettoken",
        },
        runner: async (_argv, opts) => {
          capturedEnv = opts?.env;
          return { exitCode: 0, stdout: "ok" };
        },
      });

      await harness.dispatchCommand(["npm", "test"], "ref");
      assert.ok(capturedEnv);
      assert.equal(capturedEnv.PATH, "/usr/bin:/bin");
      assert.equal(capturedEnv.SAFE_HOST_VAR, "allowed");
      assert.equal(capturedEnv.NODE_OPTIONS, undefined);
      assert.equal(capturedEnv.LD_PRELOAD, undefined);
      assert.equal(capturedEnv.KIRO_API_KEY, undefined);
      assert.equal(capturedEnv.GITHUB_TOKEN, undefined);
    });
  });

  describe("Path C: Symlink escape scan in ExhumerHarness and triage", () => {
    it("scanBaseTreeFiles throws error when .gitmodules is a symlink", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-symlink-gitmodules-"));
      try {
        const dummyTarget = path.join(tempDir, "target.txt");
        fs.writeFileSync(dummyTarget, "evil", "utf-8");
        fs.symlinkSync(dummyTarget, path.join(tempDir, ".gitmodules"));

        assert.throws(
          () => scanBaseTreeFiles(tempDir),
          /symlink.*\.gitmodules|\.gitmodules.*symlink|Symlink escape detected/i
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("scanBaseTreeFiles throws error when .gitmodules is a directory", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-dir-gitmodules-"));
      try {
        fs.mkdirSync(path.join(tempDir, ".gitmodules"));

        assert.throws(
          () => scanBaseTreeFiles(tempDir),
          /symlink.*\.gitmodules|\.gitmodules.*symlink|Symlink escape detected/i
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("scanBaseTreeFiles throws error when base tree contains escaping symlink", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-escaping-base-"));
      try {
        fs.symlinkSync("/etc/passwd", path.join(tempDir, "escape-link"));

        assert.throws(
          () => scanBaseTreeFiles(tempDir),
          /symlink escape detected/i
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("runGrimoireBaseAnalysis throws error when treeDir contains escaping symlink", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-escaping-grimoire-"));
      try {
        fs.symlinkSync("/etc/passwd", path.join(tempDir, "escape-link"));

        await assert.rejects(
          async () =>
            runGrimoireBaseAnalysis({
              runId: "rc3-grimoire-symlink",
              treeDir: tempDir,
            }),
          /symlink escape detected in treeDir/i
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("ExhumerHarness.executeInRunbox fails closed when worktreeDir contains an escaping symlink", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-escaping-runbox-"));
      try {
        const buildersDir = path.join(tempDir, "builders", "repo");
        fs.mkdirSync(buildersDir, { recursive: true });
        fs.symlinkSync("/etc/passwd", path.join(buildersDir, "escape-link"));

        const harness = new ExhumerHarness({
          runId: "rc3-harness-escape",
          baseSha: "sha-rc3-escape",
          wallClockTimeoutMs: 60000,
          bindPath: buildersDir,
          allowedRoot: tempDir,
          runner: async () => ({ exitCode: 0 }),
        });

        await assert.rejects(
          async () => harness.executeInRunbox(["npm", "test"], "test"),
          /Symlink escape detected in worktreeDir:/i
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("runExhumerHarness fails closed before grimoire or command execution when worktreeDir has symlink escape", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-escaping-full-"));
      try {
        const buildersDir = path.join(tempDir, "builders", "repo");
        fs.mkdirSync(buildersDir, { recursive: true });
        fs.symlinkSync("/etc/passwd", path.join(buildersDir, "escape-link"));
        fs.writeFileSync(
          path.join(buildersDir, "package.json"),
          JSON.stringify({ name: "escaped-pkg", scripts: { test: "echo test" } }),
          "utf-8"
        );

        let runnerCalled = false;
        await assert.rejects(
          async () =>
            runExhumerHarness({
              runId: "rc3-full-escape",
              baseSha: "sha-rc3-full-escape",
              wallClockTimeoutMs: 60000,
              bindPath: buildersDir,
              allowedRoot: tempDir,
              enableGrimoire: true,
              runner: async () => {
                runnerCalled = true;
                return { exitCode: 0 };
              },
            }),
          /Symlink escape detected in worktreeDir:/i
        );

        assert.equal(runnerCalled, false, "Runner must never be called when worktree has escaping symlinks");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
