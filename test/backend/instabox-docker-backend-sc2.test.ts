// Work package SC2 tests: the Instabox Docker backend streams stderr so the
// process group is known during a run, the group is killed on timeout, the
// housekeeping timeout is a required setting on every non-command docker call,
// and the sandbox run path maps a missing or non-integer exit code to
// RunnerExitCodeError instead of exit 1.
// Audit items: N-C1, N-C3, N-C5 (sandbox path).

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  InstaboxDockerBackend,
  InstaboxDockerSandbox,
  type DockerRunner,
  type DockerRunnerOptions,
  type DockerRunnerResult,
} from "../../lib/backend/instabox-docker-backend";
import { RunnerExitCodeError, PGID_MARKER } from "../../lib/backend/docker-exec-stream";
import { SpecValidationError } from "../../lib/backend/spec-validator";
import type { SandboxSpec } from "../../lib/backend/types";

const PINNED_TEST_IMAGE =
  "docker.io/library/node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface RecordedCall {
  argv: string[];
  options?: DockerRunnerOptions;
}

function createRecordingRunner(
  handler?: (argv: string[], options?: DockerRunnerOptions) => DockerRunnerResult | Promise<DockerRunnerResult>
): { runner: DockerRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: DockerRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    if (handler) {
      return handler(argv, options);
    }
    const cmd = argv[0];
    if (cmd === "wait") {
      return { exitCode: 0, stdout: "0\n", stderr: "" };
    }
    if (cmd === "create") {
      return { exitCode: 0, stdout: "c-sc2-test-0001\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

// The sandbox is built directly so the test stays independent of the host path
// shape and of network policy registration; the behaviour under test happens in
// exec()/run()/stop(), not in create().
function buildSandbox(
  backend: InstaboxDockerBackend,
  id: string
): InstaboxDockerSandbox {
  const spec: SandboxSpec = {
    idempotencyKey: `idemp-${id}`,
    image: PINNED_TEST_IMAGE,
    labels: {},
    user: { uid: 1001, gid: 1001 },
  };
  return new InstaboxDockerSandbox(id, spec, backend);
}

describe("Work package SC2: streamed stderr, group kill on timeout, housekeeping timeout, strict sandbox exit codes", () => {
  it("(SC2) a timeout kills the group by pgid and reports timedOut with exit code 124", async () => {
    const { runner, calls } = createRecordingRunner(async (argv, options) => {
      if (argv[0] === "exec" && argv.includes("sleep")) {
        // The wrapper shell reports the real group id on stderr, then the
        // command hangs; the marker must reach the stream before the timeout.
        options?.onStderr?.(`${PGID_MARKER} 7042\n`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { exitCode: 137, stdout: "", stderr: "killed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });
    const sandbox = buildSandbox(backend, "c-sc2-timeout");

    // Streaming path: the exec process records the real pgid from the marker,
    // which is only possible because stderr is streamed while the command runs.
    const proc = await sandbox.exec({
      argv: ["sleep", "10"],
      cwd: "/workspace",
      timeoutMs: 10,
      logRef: "log-sc2-timeout-exec",
    });
    const status = await proc.wait();
    assert.equal(status.timedOut, true, "The command is reported as timed out");
    assert.equal(status.exitCode, 124, "A timed out command reports exit code 124");
    assert.equal(
      proc.groupKnown,
      true,
      "The group is known during the run because stderr is streamed"
    );
    assert.equal(proc.pgid, 7042, "The recorded pgid is the real value from the marker");

    // Every kill targets exactly the command's own group, taken from the
    // marker, with the separate docker exec kill call.
    const killCalls = calls.filter((c) => c.argv.includes("kill"));
    assert.ok(killCalls.length >= 1, "The command's group is signalled on timeout");
    for (const call of killCalls) {
      assert.deepEqual(
        call.argv,
        ["exec", "c-sc2-timeout", "kill", "-KILL", "--", "-7042"],
        "The timeout kill targets the command's own process group"
      );
      assert.equal(
        call.options?.timeoutMs,
        5000,
        "The group kill is a non-command docker call and carries the housekeeping timeout"
      );
    }

    const pkillCalls = calls.filter((c) => c.argv.includes("pkill"));
    assert.equal(pkillCalls.length, 0, "No pkill against a user's processes on timeout");
    const psCalls = calls.filter((c) => c.argv.includes("ps"));
    assert.equal(psCalls.length, 0, "No ps discovery of user processes on timeout");

    // Sandboxed run path: the hardened result keeps timedOut and exit code 124.
    calls.length = 0;
    const result = await sandbox.run({
      argv: ["sleep", "10"],
      cwd: "/workspace",
      timeoutMs: 10,
      logRef: "log-sc2-timeout-run",
    });
    assert.equal(result.timedOut, true, "The sandbox run reports timedOut");
    assert.equal(result.exitCode, 124, "The sandbox run reports exit code 124");
    const runKillCalls = calls.filter((c) => c.argv.includes("kill"));
    assert.ok(runKillCalls.length >= 1, "The group kill also happens on the run path");
    for (const call of runKillCalls) {
      assert.deepEqual(
        call.argv,
        ["exec", "c-sc2-timeout", "kill", "-KILL", "--", "-7042"],
        "The run path kill targets the command's own process group"
      );
    }
  });

  it("(SC2) a missing housekeeping setting throws before any docker call", async () => {
    const variants: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { maxTimeoutMs: 60000 },
      { housekeepingTimeoutMs: 0 },
      { housekeepingTimeoutMs: -1 },
      { housekeepingTimeoutMs: "5000" },
    ];
    for (const [index, settings] of variants.entries()) {
      // No runner is injected, so the backend uses the default child process
      // runner, which refuses a call without a timeout; the backend must then
      // raise the required-setting error instead of making a doomed call.
      const backend = new InstaboxDockerBackend({
        settings: settings as Record<string, unknown> | undefined,
      });
      const sandbox = buildSandbox(backend, `c-sc2-hk-missing-${index}`);

      await assert.rejects(
        async () => {
          await sandbox.stop();
        },
        (err: unknown) => {
          assert.ok(
            err instanceof SpecValidationError,
            `a missing housekeeping setting must throw SpecValidationError, got ${String(err)}`
          );
          assert.match(
            (err as Error).message,
            /Missing required timeout setting/,
            "the error is reported as a required-setting error"
          );
          assert.match(
            (err as Error).message,
            /housekeepingTimeoutMs must be configured in the backend settings/,
            "the error names the missing housekeepingTimeoutMs setting"
          );
          return true;
        }
      );
    }
  });

  it("(SC2) a missing or non-integer exit code throws, never mapped to exit 1", async () => {
    // A runner result without an exit code is an infrastructure failure.
    const { runner: runnerMissing } = createRecordingRunner((argv) => {
      if (argv[0] === "exec") {
        return { stdout: "orphan output\n", stderr: "" } as DockerRunnerResult;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backendMissing = new InstaboxDockerBackend({
      runner: runnerMissing,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });
    const sandboxMissing = buildSandbox(backendMissing, "c-sc2-nocode");

    await assert.rejects(
      async () => {
        await sandboxMissing.run({
          argv: ["echo", "test"],
          cwd: "/workspace",
          timeoutMs: 5000,
          logRef: "log-sc2-nocode",
        });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof RunnerExitCodeError,
          "A missing exit code throws RunnerExitCodeError"
        );
        assert.ok(
          (err as Error).message.includes("integer exit code"),
          "the error names the missing integer exit code"
        );
        return true;
      }
    );

    // A non-integer exit code is the same infrastructure failure.
    const { runner: runnerFloat } = createRecordingRunner((argv) => {
      if (argv[0] === "exec") {
        return { exitCode: 1.5, stdout: "out", stderr: "err" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backendFloat = new InstaboxDockerBackend({
      runner: runnerFloat,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });
    const sandboxFloat = buildSandbox(backendFloat, "c-sc2-float");

    await assert.rejects(
      async () => {
        await sandboxFloat.run({
          argv: ["echo", "test"],
          cwd: "/workspace",
          timeoutMs: 5000,
          logRef: "log-sc2-float",
        });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof RunnerExitCodeError,
          "A non-integer exit code throws RunnerExitCodeError"
        );
        assert.ok((err as Error).message.includes("integer exit code"));
        return true;
      }
    );
  });

  it("(SC2) every non-command docker call passes the housekeeping timeout; docker wait is exempt", async () => {
    const { runner, calls } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { housekeepingTimeoutMs: 4500 },
    });
    const sandbox = buildSandbox(backend, "c-sc2-hk");

    await sandbox.stop();
    await backend.list();
    await backend.sweepProcesses("c-sc2-hk", 4242);
    await sandbox.wait();

    const waitCalls = calls.filter((c) => c.argv[0] === "wait");
    assert.equal(waitCalls.length, 1, "docker wait is the only exempt call");
    assert.equal(
      waitCalls[0].options?.timeoutMs,
      undefined,
      "docker wait blocks until the container exits and carries no housekeeping timeout"
    );

    const nonCommandCalls = calls.filter((c) => c.argv[0] !== "wait");
    assert.ok(
      nonCommandCalls.length >= 3,
      "stop, ps and the group kill all went through the runner"
    );
    for (const call of nonCommandCalls) {
      assert.equal(
        call.options?.timeoutMs,
        4500,
        `the ${call.argv[0]} call is a non-command docker call and carries the housekeeping timeout`
      );
    }

    const sweepCalls = calls.filter(
      (c) => c.argv[0] === "exec" && c.argv.includes("kill")
    );
    assert.equal(sweepCalls.length, 1, "The sweep signals exactly once");
    assert.deepEqual(
      sweepCalls[0].argv,
      ["exec", "c-sc2-hk", "kill", "--", "-4242"],
      "The housekeeping timeout is added without changing the kill argv"
    );
  });

  it("(SC2) the default runner refuses a call without a timeout; only docker wait is exempt", async () => {
    const backend = new InstaboxDockerBackend({ settings: {} });
    const sandbox = buildSandbox(backend, "c-sc2-refuse");

    // The group kill goes out without its own timeout and without a configured
    // housekeeping timeout: the runner refuses it before any process starts.
    await assert.rejects(
      async () => {
        await backend.sweepProcesses("c-sc2-refuse", 4242);
      },
      (err: unknown) => {
        assert.ok(
          err instanceof SpecValidationError,
          `a timeout-less call must be refused with SpecValidationError, got ${String(err)}`
        );
        assert.match(
          (err as Error).message,
          /Missing required timeout setting/,
          "the refusal is a required-setting error"
        );
        return true;
      }
    );
  });

  it("(SC2) a rejected default runner keeps the collected stdout and stderr on the error", async () => {
    // PATH is emptied so the docker binary cannot spawn: the runner then
    // rejects with the spawn error, and the collected stdout and stderr stay
    // on the error instead of being lost.
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const backend = new InstaboxDockerBackend({
        settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
      });
      const sandbox = buildSandbox(backend, "c-sc2-reject");

      await assert.rejects(
        async () => {
          await sandbox.stop();
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(
            typeof (err as { stdout?: unknown }).stdout,
            "string",
            "the collected stdout is kept on the rejected runner error"
          );
          assert.equal(
            typeof (err as { stderr?: unknown }).stderr,
            "string",
            "the collected stderr is kept on the rejected runner error"
          );
          return true;
        }
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
