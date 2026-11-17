// Work package SC1 tests: exit codes propagate through the setsid wrapper, the
// wrapper is never skipped, missing or non-integer exit codes from the default
// runner throw, and the user-wide sweep is deleted.
// Audit items: N-C2, N-C4, N-C5 (stream part), N-C9.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  COMMAND_GROUP_SCRIPT,
  DockerExecStream,
  PGID_MARKER,
  RunnerExitCodeError,
  wrapWithSetsid,
} from "../../lib/backend/docker-exec-stream";
import type {
  DockerRunner,
  DockerRunnerOptions,
  DockerRunnerResult,
} from "../../lib/backend/instabox-docker-backend";

interface RecordedCall {
  argv: string[];
  options?: DockerRunnerOptions;
}

function createFakeRunner(
  handler?: (argv: string[], options?: DockerRunnerOptions) => DockerRunnerResult | Promise<DockerRunnerResult>
): { runner: DockerRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: DockerRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    if (handler) {
      return handler(argv, options);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("Work package SC1: setsid -w wrapper, no skipped wrap, strict default runner exit codes", () => {
  it("wraps every command as ['setsid', '-w', 'sh', '-c', SCRIPT, ...argv] carrying the marker, and the command's exit code propagates", async () => {
    // Unit level: the wrapper argv contains setsid -w and the marker script.
    const wrapped = wrapWithSetsid(["echo", "payload"]);
    assert.equal(wrapped[0], "setsid");
    assert.equal(wrapped[1], "-w", "setsid runs with -w so it waits and returns the child's status");
    assert.equal(wrapped[2], "sh");
    assert.equal(wrapped[3], "-c");
    assert.ok(wrapped.includes(COMMAND_GROUP_SCRIPT), "The wrapper carries the group marker script");
    assert.ok(COMMAND_GROUP_SCRIPT.includes(PGID_MARKER), "The marker line is kept from R6-A1");

    // Through the stream: the docker exec argv carries the same wrapper, the
    // real group id still comes from the marker, and a non-zero exit code from
    // the wrapped command propagates (setsid -w waits and returns its status).
    const { runner, calls } = createFakeRunner((argv, options) => {
      if (argv[0] === "exec" && argv.includes("echo")) {
        options?.onStderr?.(`${PGID_MARKER} 4311\n`);
        return { exitCode: 7, stdout: "payload\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const stream = new DockerExecStream({
      containerId: "box-sc1-wrap",
      runner,
      settings: { maxTimeoutMs: 10000 },
    });

    const proc = await stream.exec({ argv: ["echo", "payload"] });
    const status = await proc.wait();
    assert.equal(status.exitCode, 7, "The command's own exit code propagates through the wrapper");
    assert.equal(proc.groupKnown, true, "The group is known once the marker arrived");
    assert.equal(proc.pgid, 4311, "The recorded pgid is the real value from the marker");

    const execCall = calls.find((c) => c.argv[0] === "exec" && c.argv.includes("echo"));
    assert.ok(execCall, "The exec call carries the setsid wrapper");
    const containerIdx = execCall!.argv.indexOf("box-sc1-wrap");
    assert.ok(containerIdx !== -1, "Exec call targets the container");
    assert.deepEqual(execCall!.argv.slice(containerIdx + 1), [
      "setsid",
      "-w",
      "sh",
      "-c",
      COMMAND_GROUP_SCRIPT,
      "echo",
      "payload",
    ]);
  });

  it("still wraps a command whose argv[0] is setsid; the wrapper is never skipped", async () => {
    const wrapped = wrapWithSetsid(["setsid", "echo", "nested"]);
    assert.deepEqual(wrapped, [
      "setsid",
      "-w",
      "sh",
      "-c",
      COMMAND_GROUP_SCRIPT,
      "setsid",
      "echo",
      "nested",
    ]);

    const { runner, calls } = createFakeRunner((argv, options) => {
      if (argv[0] === "exec" && argv.includes("echo")) {
        options?.onStderr?.(`${PGID_MARKER} 4312\n`);
        return { exitCode: 0, stdout: "nested ok\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const stream = new DockerExecStream({
      containerId: "box-sc1-noskip",
      runner,
      settings: { maxTimeoutMs: 10000 },
    });

    const proc = await stream.exec({ argv: ["setsid", "echo", "nested"] });
    const status = await proc.wait();
    assert.equal(status.exitCode, 0);

    const execCall = calls.find((c) => c.argv[0] === "exec" && c.argv.includes("echo"));
    assert.ok(execCall, "A command starting with setsid is wrapped anyway");
    const containerIdx = execCall!.argv.indexOf("box-sc1-noskip");
    assert.ok(containerIdx !== -1, "Exec call targets the container");
    assert.deepEqual(execCall!.argv.slice(containerIdx + 1), [
      "setsid",
      "-w",
      "sh",
      "-c",
      COMMAND_GROUP_SCRIPT,
      "setsid",
      "echo",
      "nested",
    ]);
  });

  it("maps a missing or non-integer exit code from the runner to RunnerExitCodeError, never to exit 1", async () => {
    const { runner } = createFakeRunner(() => {
      return { exitCode: undefined as unknown as number, stdout: "", stderr: "" };
    });
    const stream = new DockerExecStream({
      containerId: "box-sc1-default-runner",
      runner,
      settings: { maxTimeoutMs: 10000 },
    });

    await assert.rejects(
      async () => {
        await stream.run({ argv: ["echo", "test"] });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof RunnerExitCodeError,
          "A missing or non-integer exit code from the runner throws RunnerExitCodeError"
        );
        assert.ok((err as Error).message.includes("integer exit code"));
        return true;
      }
    );
  });
});
