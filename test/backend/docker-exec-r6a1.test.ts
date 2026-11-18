// Work package R6-A1 tests: a real process group per command taken from the
// container marker, no global process sweep, strict exit codes.
// Audit items: H-3, N-1, N-2 (the sweep part), N-3, M-5.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  COMMAND_GROUP_SCRIPT,
  DockerExecStream,
  PGID_MARKER,
  RunnerExitCodeError,
  sweepProcesses,
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
  handler?: (argv: string[], options?: DockerRunnerOptions) => DockerRunnerResult | string | Promise<DockerRunnerResult | string>
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

describe("Work package R6-A1: real process group per command, no user sweep, strict exit codes", () => {
  it("gives two commands different real group ids taken from the marker, with no counter", async () => {
    // Real group ids reported by the container via the marker line; no group
    // id is invented by the stream.
    const markerValues = [4242, 9173];
    let execCount = 0;
    const { runner, calls } = createFakeRunner((argv, options) => {
      if (argv[0] === "exec" && argv.includes("echo")) {
        const markerValue = markerValues[execCount] ?? 4242;
        execCount += 1;
        options?.onStderr?.(`${PGID_MARKER} ${markerValue}\n`);
        return { exitCode: 0, stdout: "cmd ok\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const stream = new DockerExecStream({
      containerId: "box-r6a1-pgid",
      runner,
      settings: { maxTimeoutMs: 10000 },
    });

    const proc1 = await stream.exec({ argv: ["echo", "cmd1"] });
    const status1 = await proc1.wait();
    assert.equal(status1.exitCode, 0);

    const proc2 = await stream.exec({ argv: ["echo", "cmd2"] });
    const status2 = await proc2.wait();
    assert.equal(status2.exitCode, 0);

    assert.equal(proc1.groupKnown, true, "Group 1 is known once its marker arrived");
    assert.equal(proc2.groupKnown, true, "Group 2 is known once its marker arrived");
    assert.equal(proc1.pgid, 4242, "Group 1 id is the real value from the marker");
    assert.equal(proc2.pgid, 9173, "Group 2 id is the real value from the marker");
    assert.notEqual(proc1.pgid, proc2.pgid, "Each command has its own process group");

    // The marker line is removed from the stderr callers receive
    for (const proc of [proc1, proc2]) {
      for await (const chunk of proc.output) {
        const text = Buffer.from((chunk.data as Uint8Array) ?? Buffer.alloc(0)).toString("utf8");
        assert.ok(!text.includes(PGID_MARKER), "The marker line never reaches callers");
      }
    }
    assert.equal((await proc1.getResult()).stderrTail, "", "Marker-only stderr is removed entirely");
    assert.ok(((await proc2.getResult()).stdoutTail ?? "").includes("cmd ok"));

    // Each command argv is wrapped as ['setsid', '-w', 'sh', '-c', SCRIPT, ...argv],
    // so the real group comes from setsid, not from a counter.
    const execCalls = calls.filter((c) => c.argv[0] === "exec" && c.argv.includes("setsid"));
    assert.equal(execCalls.length, 2, "Exactly one exec per command");
    for (let i = 0; i < execCalls.length; i++) {
      const containerIdx = execCalls[i].argv.indexOf("box-r6a1-pgid");
      assert.ok(containerIdx !== -1, "Exec call targets the container");
      assert.deepEqual(execCalls[i].argv.slice(containerIdx + 1), [
        "setsid",
        "-w",
        "sh",
        "-c",
        COMMAND_GROUP_SCRIPT,
        "echo",
        i === 0 ? "cmd1" : "cmd2",
      ]);
    }
  });

  it("records kill with -- and -PGID only for the command group and never pkill", async () => {
    const { runner, calls } = createFakeRunner((argv, options) => {
      if (argv[0] === "exec" && argv.includes("echo")) {
        options?.onStderr?.(`${PGID_MARKER} 5150\n`);
        return { exitCode: 0, stdout: "done\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const stream = new DockerExecStream({
      containerId: "box-r6a1-kill",
      runner,
      settings: { maxTimeoutMs: 10000 },
    });

    const proc = await stream.exec({ argv: ["echo", "work"] });
    const status = await proc.wait();
    assert.equal(status.exitCode, 0);

    const killCalls = calls.filter((c) => c.argv.includes("kill"));
    assert.equal(killCalls.length, 1, "Exactly one group kill per finished command");
    assert.deepEqual(killCalls[0].argv, [
      "exec",
      "box-r6a1-kill",
      "kill",
      "-KILL",
      "--",
      "-5150",
    ]);

    const pkillCalls = calls.filter((c) => c.argv.includes("pkill"));
    assert.equal(pkillCalls.length, 0, "No pkill against a user's processes");
    const psCalls = calls.filter((c) => c.argv.includes("ps"));
    assert.equal(psCalls.length, 0, "No ps discovery of user processes");
  });

  it("throws the infrastructure error when the exec result has no exit code", async () => {
    const { runner } = createFakeRunner(() => {
      // A result without an exit code is an infrastructure failure; it is
      // never mapped to exit 0 or exit 1.
      return { stdout: "orphan output\n", stderr: "" } as unknown as DockerRunnerResult;
    });

    const stream = new DockerExecStream({
      containerId: "box-r6a1-nocode",
      runner,
      settings: { maxTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await stream.run({ argv: ["echo", "test"] });
      },
      (err: unknown) => {
        assert.ok(err instanceof RunnerExitCodeError, "Missing exit code throws RunnerExitCodeError");
        assert.ok((err as Error).message.includes("integer exit code"));
        return true;
      }
    );
  });

  it("propagates a runner error that carries no exit code and never reports exit 1", async () => {
    const { runner } = createFakeRunner(() => {
      throw new Error("docker daemon unreachable");
    });

    const stream = new DockerExecStream({
      containerId: "box-r6a1-err",
      runner,
      settings: { maxTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await stream.run({ argv: ["echo", "test"] });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).message, "docker daemon unreachable");
        assert.ok(!(err instanceof RunnerExitCodeError), "The original runner error propagates unchanged");
        return true;
      }
    );

    // A runner error whose code is not an integer exit code also propagates.
    const { runner: runner2 } = createFakeRunner(() => {
      const err = new Error("connection refused") as Error & { code?: string };
      err.code = "ECONNREFUSED";
      throw err;
    });

    const stream2 = new DockerExecStream({
      containerId: "box-r6a1-err2",
      runner: runner2,
      settings: { maxTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await stream2.run({ argv: ["echo", "test"] });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).message, "connection refused");
        return true;
      }
    );
  });

  it("reports a timeout with exit code 124 and kills only the command's group", async () => {
    const { runner, calls } = createFakeRunner(async (argv, options) => {
      if (argv[0] === "exec" && argv.includes("sleep")) {
        // The wrapper shell reports the real group id, then the command hangs
        options?.onStderr?.(`${PGID_MARKER} 6021\n`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { exitCode: 137, stdout: "", stderr: "killed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const stream = new DockerExecStream({
      containerId: "box-r6a1-timeout",
      runner,
      settings: { maxTimeoutMs: 1000 },
    });

    const proc = await stream.exec({ argv: ["sleep", "10"], timeoutMs: 10 });
    const status = await proc.wait();
    assert.equal(status.timedOut, true, "The command is reported as timed out");
    assert.equal(status.exitCode, 124, "A timed out command reports exit code 124");

    assert.equal(proc.groupKnown, true);
    assert.equal(proc.pgid, 6021, "Recorded pgid is the real group id from the marker");

    // Every kill targets exactly the command's own group with kill -KILL -- -PGID
    const killCalls = calls.filter((c) => c.argv.includes("kill"));
    assert.ok(killCalls.length >= 1, "The command's group is signalled on timeout");
    for (const call of killCalls) {
      assert.deepEqual(call.argv, [
        "exec",
        "box-r6a1-timeout",
        "kill",
        "-KILL",
        "--",
        "-6021",
      ]);
    }

    const pkillCalls = calls.filter((c) => c.argv.includes("pkill"));
    assert.equal(pkillCalls.length, 0, "No pkill against a user's processes on timeout");
    const psCalls = calls.filter((c) => c.argv.includes("ps"));
    assert.equal(psCalls.length, 0, "No ps discovery of user processes on timeout");
  });

  it("leaves the group unknown and never claims a group kill when the marker never arrives", async () => {
    const { runner, calls } = createFakeRunner((argv, options) => {
      if (argv[0] === "exec" && argv.includes("echo")) {
        // The command writes stderr but the marker line never arrives
        options?.onStderr?.("warning: no marker here\n");
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const stream = new DockerExecStream({
      containerId: "box-r6a1-nomarker",
      runner,
      settings: { maxTimeoutMs: 10000 },
    });

    const proc = await stream.exec({ argv: ["echo", "quiet"] });
    const status = await proc.wait();
    assert.equal(status.exitCode, 0);

    assert.equal(proc.groupKnown, false, "The group is unknown without the marker");
    assert.equal(proc.pgid, undefined, "No group id is invented when the marker is missing");

    const killCalls = calls.filter((c) => c.argv.includes("kill"));
    assert.equal(killCalls.length, 0, "No group kill is claimed or signalled without a marker");
    const pkillCalls = calls.filter((c) => c.argv.includes("pkill"));
    assert.equal(pkillCalls.length, 0, "No pkill against a user's processes without a marker");
  });

  it("sweepProcesses requires a real pgid and never signals a user's processes", async () => {
    const { runner, calls } = createFakeRunner();

    await assert.rejects(
      async () => {
        await sweepProcesses(runner, "box-r6a1-sweep", undefined);
      },
      /integer pgid greater than 1/
    );
    await assert.rejects(
      async () => {
        await sweepProcesses(runner, "box-r6a1-sweep", 1);
      },
      /integer pgid greater than 1/
    );
    await assert.rejects(
      async () => {
        await sweepProcesses(runner, "box-r6a1-sweep", "4242");
      },
      /integer pgid greater than 1/
    );
    await assert.rejects(
      async () => {
        await sweepProcesses(runner, "box-r6a1-sweep", 12.5);
      },
      /integer pgid greater than 1/
    );
    assert.equal(calls.length, 0, "A refused sweep executes no docker command");

    await sweepProcesses(runner, "box-r6a1-sweep", 4242);
    assert.equal(calls.length, 1, "A valid sweep signals only the command's group");
    assert.deepEqual(calls[0].argv, [
      "exec",
      "box-r6a1-sweep",
      "kill",
      "-KILL",
      "--",
      "-4242",
    ]);

    const pkillCalls = calls.filter((c) => c.argv.includes("pkill"));
    assert.equal(pkillCalls.length, 0, "sweepProcesses never signals a user's processes");
  });
});
