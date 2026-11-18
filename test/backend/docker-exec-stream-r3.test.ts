// Work package R3-E/R3-Eb tests: Docker exec stream process-group kill, exit codes, timeout bound, uid rules (H-3, M-5, M-6, L-2)
// Requirements: 20.11, 20.12, 21.3, 43.6, 43.7, H-3, M-5, M-6, L-2

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  DockerExecStream,
  DockerExecProcess,
  buildExecArgv,
  isRootUser,
  resolveNonRootUser,
  resolveTimeoutMs,
  killProcessGroup,
  RunnerExitCodeError,
  PGID_MARKER,
} from "../../lib/backend/docker-exec-stream";
import { SpecValidationError } from "../../lib/backend/spec-validator";
import type {
  DockerRunner,
  DockerRunnerOptions,
  DockerRunnerResult,
} from "../../lib/backend/instabox-docker-backend";
import type { SandboxSpec } from "../../lib/backend/types";

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
    const cmd = argv[0];
    if (cmd === "exec") {
      return { exitCode: 0, stdout: "output\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("Work package R3-Eb: Docker exec stream hardening (H-3, M-5, M-6, L-2)", () => {
  // 1. Each command must run in its own process group inside the container,
  // and only that group is signalled with kill -- -PGID (H-3)
  describe("(H-3) each command gets its own group id and only that group is signalled", () => {
    it("each command gets a distinct process group ID recorded and only that group is signalled on exit", async () => {
      // Real group ids reported by the container via the marker line; no
      // counter is involved (R6-A1).
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
        containerId: "box-h3-test",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      // Execute command 1
      const proc1 = await stream.exec({ argv: ["echo", "cmd1"] });
      const status1 = await proc1.wait();
      assert.equal(status1.exitCode, 0);

      // Verify command 1 has a positive integer group ID taken from the marker
      const pgid1 = proc1.pgid;
      assert.ok(typeof pgid1 === "number" && pgid1 > 1, "Command 1 must have a recorded positive pgid");
      assert.equal(pgid1, 4242, "Command 1 pgid must be the real group id from the marker");

      // Execute command 2
      const proc2 = await stream.exec({ argv: ["echo", "cmd2"] });
      const status2 = await proc2.wait();
      assert.equal(status2.exitCode, 0);

      // Verify command 2 has its own distinct group ID taken from the marker
      const pgid2 = proc2.pgid;
      assert.ok(typeof pgid2 === "number" && pgid2 > 1, "Command 2 must have a recorded positive pgid");
      assert.equal(pgid2, 9173, "Command 2 pgid must be the real group id from the marker");
      assert.notEqual(pgid1, pgid2, "Each command must receive its own distinct process group ID");

      // Verify the kill calls made by DockerExecStream
      const killCalls = calls.filter((c) => c.argv.includes("kill"));
      assert.equal(killCalls.length, 2, "Must execute exactly one kill call per command");

      // Command 1 kill call must target only pgid1 with kill -KILL -- -PGID
      assert.deepEqual(killCalls[0].argv, [
        "exec",
        "box-h3-test",
        "kill",
        "-KILL",
        "--",
        `-${pgid1}`,
      ]);

      // Command 2 kill call must target only pgid2 with kill -KILL -- -PGID
      assert.deepEqual(killCalls[1].argv, [
        "exec",
        "box-h3-test",
        "kill",
        "-KILL",
        "--",
        `-${pgid2}`,
      ]);

      // Verify NO broad signals were executed: no ps discovery, no pkill, no kill -1
      const psCalls = calls.filter((c) => c.argv.includes("ps"));
      assert.equal(psCalls.length, 0, "Must not execute ps to discover and signal all container processes");

      const pkillCalls = calls.filter((c) => c.argv.includes("pkill"));
      assert.equal(pkillCalls.length, 0, "Must not execute pkill broad signal");
    });

    it("times out signalling only the command process group with kill -- -PGID", async () => {
      const { runner, calls } = createFakeRunner(async (argv, options) => {
        if (argv[0] === "exec" && argv.includes("sleep")) {
          // The wrapper shell reports the real group id, then the command hangs
          options?.onStderr?.(`${PGID_MARKER} 6021\n`);
          // Simulate hanging command until killed
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { exitCode: 137, stdout: "", stderr: "killed" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-timeout-h3",
        runner,
        settings: { maxTimeoutMs: 1000 },
      });

      const proc = await stream.exec({ argv: ["sleep", "10"], timeoutMs: 10 });
      const status = await proc.wait();
      assert.equal(status.timedOut, true);
      assert.equal(status.exitCode, 124, "A timed out command must report exit code 124");

      const pgid = proc.pgid;
      assert.ok(typeof pgid === "number" && pgid > 1);
      assert.equal(pgid, 6021, "Recorded pgid must be the real group id from the marker");

      // Verify kill calls on timeout target only that process group
      const killCalls = calls.filter((c) => c.argv.includes("kill"));
      assert.ok(killCalls.length >= 1, "Must signal on timeout");

      for (const call of killCalls) {
        assert.ok(
          call.argv.includes(`-${pgid}`),
          `Kill call must target command group -${pgid}`
        );
        assert.ok(
          call.argv.includes("--"),
          "Kill call must use '--' before process group argument"
        );
      }
    });

    it("delivers manual signal only to the command process group with kill -SIG -- -PGID", async () => {
      // The real group id is known only once the marker arrives; a command
      // whose marker never arrived is never signalled (R6-A1).
      const { runner, calls } = createFakeRunner((argv, options) => {
        options?.onStderr?.(`${PGID_MARKER} 7311\n`);
        return { exitCode: 0, stdout: "running\n", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-sig-h3",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const proc = await stream.exec({ argv: ["sleep", "60"] });
      await proc.signal("SIGTERM");

      const sigCalls = calls.filter((c) => c.argv.includes("kill") && c.argv.includes("-TERM"));
      assert.equal(sigCalls.length, 1, "Must execute signal delivery via kill");

      const pgid = proc.pgid;
      assert.equal(pgid, 7311, "Recorded pgid must be the real group id from the marker");
      assert.deepEqual(sigCalls[0].argv, [
        "exec",
        "box-sig-h3",
        "kill",
        "-TERM",
        "--",
        `-${pgid}`,
      ]);
    });

    it("killProcessGroup does not broad-signal when pgid is unspecified or invalid", async () => {
      const { runner, calls } = createFakeRunner();

      // Undefined pgid
      await killProcessGroup(runner, "box-noop", undefined);
      assert.equal(calls.length, 0, "Must not execute any docker command when pgid is undefined");

      // Null pgid
      await killProcessGroup(runner, "box-noop", null as unknown as string);
      assert.equal(calls.length, 0, "Must not execute any docker command when pgid is null");

      // Group 0
      await killProcessGroup(runner, "box-noop", 0);
      assert.equal(calls.length, 0, "Must not signal group 0");

      // Group 1
      await killProcessGroup(runner, "box-noop", 1);
      assert.equal(calls.length, 0, "Must not signal group 1 (init)");
    });
  });

  // 2. A string exit code is rejected (M-5)
  describe("(M-5) a string exit code is rejected", () => {
    it("rejects when runner returns a raw string instead of an object", async () => {
      const { runner } = createFakeRunner(async () => "0" as unknown as DockerRunnerResult);

      const stream = new DockerExecStream({
        containerId: "box-str-return",
        runner,
        settings: { maxTimeoutMs: 5000 },
      });

      await assert.rejects(
        async () => {
          await stream.run({ argv: ["echo", "test"] });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes("returned a string instead of an integer exit code"));
          return true;
        }
      );
    });

    it("rejects when runner returns an object with string exitCode '0'", async () => {
      const { runner } = createFakeRunner(async () => ({
        exitCode: "0" as unknown as number,
        stdout: "str code output\n",
        stderr: "",
      }));

      const stream = new DockerExecStream({
        containerId: "box-str-code-0",
        runner,
        settings: { maxTimeoutMs: 5000 },
      });

      await assert.rejects(
        async () => {
          await stream.run({ argv: ["echo", "test"] });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes("exit code must be an integer, received string"));
          return true;
        }
      );
    });

    it("rejects when runner returns an object with non-numeric string exitCode 'error'", async () => {
      const { runner } = createFakeRunner(async () => ({
        exitCode: "error" as unknown as number,
        stdout: "",
        stderr: "fail",
      }));

      const stream = new DockerExecStream({
        containerId: "box-str-code-err",
        runner,
        settings: { maxTimeoutMs: 5000 },
      });

      await assert.rejects(
        async () => {
          await stream.run({ argv: ["echo", "test"] });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes("exit code must be an integer, received string"));
          return true;
        }
      );
    });
  });

  // 3. timeoutMs upper bound and settings validation (M-6)
  describe("(M-6) timeoutMs has no upper bound / configured maximum from settings", () => {
    it("rejects a timeout above the configured maximum in settings", async () => {
      const { runner } = createFakeRunner();
      const stream = new DockerExecStream({
        containerId: "box-timeout-bound",
        runner,
        settings: { maxTimeoutMs: 5000 },
      });

      // Above maximum
      await assert.rejects(
        async () => {
          await stream.run({ argv: ["echo", "hi"], timeoutMs: 6000 });
        },
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          assert.ok((err as Error).message.includes("exceeds maximum allowed"));
          return true;
        }
      );

      // Equal to maximum succeeds
      const res = await stream.run({ argv: ["echo", "hi"], timeoutMs: 5000 });
      assert.equal(res.exitCode, 0);
    });

    it("rejects when timeout maximum setting is missing and no spec maximum is configured", async () => {
      const { runner } = createFakeRunner();
      // Neither settings nor spec lifetime provided
      const stream = new DockerExecStream({
        containerId: "box-missing-setting",
        runner,
      });

      await assert.rejects(
        async () => {
          await stream.run({ argv: ["echo", "hi"], timeoutMs: 1000 });
        },
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          assert.ok((err as Error).message.includes("Missing required timeout setting"));
          return true;
        }
      );
    });

    it("requires timeoutMs to be a positive safe integer", () => {
      // Direct resolveTimeoutMs validation
      assert.throws(
        () => resolveTimeoutMs(0, undefined, null, { maxTimeoutMs: 5000 }),
        (err: unknown) => err instanceof SpecValidationError
      );
      assert.throws(
        () => resolveTimeoutMs(-50, undefined, null, { maxTimeoutMs: 5000 }),
        (err: unknown) => err instanceof SpecValidationError
      );
      assert.throws(
        () => resolveTimeoutMs(NaN, undefined, null, { maxTimeoutMs: 5000 }),
        (err: unknown) => err instanceof SpecValidationError
      );
      assert.throws(
        () => resolveTimeoutMs(Infinity, undefined, null, { maxTimeoutMs: 5000 }),
        (err: unknown) => err instanceof SpecValidationError
      );
      assert.throws(
        () => resolveTimeoutMs(12.34, undefined, null, { maxTimeoutMs: 5000 }),
        (err: unknown) => err instanceof SpecValidationError
      );
      assert.throws(
        () => resolveTimeoutMs(Number.MAX_SAFE_INTEGER + 1000, undefined, null, { maxTimeoutMs: 5000 }),
        (err: unknown) => err instanceof SpecValidationError
      );

      // Valid call within limit succeeds
      const valid = resolveTimeoutMs(3000, undefined, null, { maxTimeoutMs: 5000 });
      assert.equal(valid, 3000);
    });
  });

  // 4. '00' is recognised as root (L-2)
  describe("(L-2) '00' is root", () => {
    it("recognises '00' and numeric uids with leading zeros as root in isRootUser", () => {
      assert.equal(isRootUser("00"), true, "'00' must be recognized as root");
      assert.equal(isRootUser("00:00"), true, "'00:00' must be recognized as root");
      assert.equal(isRootUser("00:1000"), true, "'00:1000' must be recognized as root");
      assert.equal(isRootUser("000"), true, "'000' must be recognized as root");
      assert.equal(isRootUser("0000"), true, "'0000' must be recognized as root");
      assert.equal(isRootUser({ uid: "00" }), true, "{ uid: '00' } must be root");
      assert.equal(isRootUser({ uid: "000" }), true, "{ uid: '000' } must be root");
      assert.equal(isRootUser({ user: "00" }), true, "{ user: '00' } must be root");
      assert.equal(isRootUser({ userId: "00" }), true, "{ userId: '00' } must be root");

      // Valid non-zero uids with or without zeros
      assert.equal(isRootUser("1000"), false);
      assert.equal(isRootUser("1000:1000"), false);
      assert.equal(isRootUser("0100"), false); // uid 100 is not root
      assert.equal(isRootUser({ uid: 1000 }), false);
    });

    it("rejects user '00' in resolveNonRootUser and DockerExecStream", () => {
      assert.throws(
        () => resolveNonRootUser({ user: "00" as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          assert.ok((err as Error).message.includes("User ID 0 (root) is forbidden"));
          return true;
        }
      );

      assert.throws(
        () => resolveNonRootUser(null, "00"),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      const { runner } = createFakeRunner();
      assert.throws(
        () => new DockerExecStream({ containerId: "box", user: "00", runner }),
        (err: unknown) => err instanceof SpecValidationError
      );

      assert.throws(
        () => new DockerExecStream({ containerId: "box", spec: { user: "00" as unknown as SandboxSpec["user"] }, runner }),
        (err: unknown) => err instanceof SpecValidationError
      );
    });
  });

  // 5. A spec without a uid produces an error and never produces '-u undefined' (L-2)
  describe("(L-2) a missing uid is rejected", () => {
    it("rejects user spec without numeric uid in resolveNonRootUser", () => {
      // Empty user object
      assert.throws(
        () => resolveNonRootUser({ user: {} as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          assert.ok((err as Error).message.includes("without a numeric uid"));
          return true;
        }
      );

      // User object with only name
      assert.throws(
        () => resolveNonRootUser({ user: { name: "nobody" } as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      // User object with only gid
      assert.throws(
        () => resolveNonRootUser({ user: { gid: 1000 } as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      // Non-numeric user string
      assert.throws(
        () => resolveNonRootUser({ user: "nobody" as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );
    });

    it("rejects user spec without numeric uid in DockerExecStream and never outputs '-u undefined'", () => {
      const { runner } = createFakeRunner();

      assert.throws(
        () =>
          new DockerExecStream({
            containerId: "box",
            spec: { user: {} as unknown as SandboxSpec["user"] },
            runner,
          }),
        (err: unknown) => err instanceof SpecValidationError
      );

      assert.throws(
        () =>
          new DockerExecStream({
            containerId: "box",
            spec: { user: { name: "nobody" } as unknown as SandboxSpec["user"] },
            runner,
          }),
        (err: unknown) => err instanceof SpecValidationError
      );

      // Verify buildExecArgv with valid spec never outputs 'undefined'
      const argv = buildExecArgv("box-valid", { argv: ["echo", "test"] }, {
        spec: { user: { uid: 1001, gid: 1001 } },
      });
      const uIdx = argv.indexOf("-u");
      assert.notEqual(uIdx, -1);
      assert.equal(argv[uIdx + 1], "1001:1001");
      assert.equal(argv.includes("undefined"), false, "Must never produce '-u undefined'");
    });
  });
});
