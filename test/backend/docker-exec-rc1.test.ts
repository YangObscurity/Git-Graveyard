// Task: Second-round C-audit (RC1b) tests
// Findings: N-C10, N-C11, N-C14
// Requirements: 20.11, 43.6, H-3, M-5, M-6, N-C10, N-C11, N-C14

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  DockerExecStream,
  DockerExecProcess,
  PGID_MARKER,
  SAFE_CONTAINER_ID_REGEX,
  assertValidStreamContainerId,
  buildExecArgv,
  killProcessGroup,
  checkOomStatus,
  STREAM_ACCUM_MAX_BYTES,
  appendWithCap,
} from "../../lib/backend/docker-exec-stream";
import { SpecValidationError } from "../../lib/backend/spec-validator";
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
  handler?: (
    argv: string[],
    options?: DockerRunnerOptions
  ) => DockerRunnerResult | Promise<DockerRunnerResult>
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

describe("Work package RC1b: second-round C-audit fixes (N-C10, N-C11, N-C14)", () => {
  describe("N-C10: Treat runner rejections with timedOut === true as command timeout", () => {
    it("treats runner rejection with timedOut === true as timeout result with exitCode 124", async () => {
      const { runner, calls } = createFakeRunner(async (argv, options) => {
        if (argv[0] === "exec" && argv.includes("sleep")) {
          const timeoutErr = new Error("Command timed out after execution") as Error & {
            timedOut: boolean;
            stdout: string;
            stderr: string;
          };
          timeoutErr.timedOut = true;
          timeoutErr.stdout = "partial stdout before timeout\n";
          timeoutErr.stderr = `${PGID_MARKER} 9921\npartial stderr before timeout\n`;
          throw timeoutErr;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-timeout",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["sleep", "10"], timeoutMs: 5000 });

      assert.equal(result.timedOut, true, "timedOut must be true on runner timeout rejection");
      assert.equal(result.exitCode, 124, "exitCode must be 124 on runner timeout rejection");
      assert.ok(
        (result.stdoutTail ?? "").includes("partial stdout before timeout"),
        "stdout on error must be captured"
      );
      assert.ok(
        (result.stderrTail ?? "").includes("partial stderr before timeout"),
        "stderr on error must be captured"
      );
      assert.ok(
        !(result.stderrTail ?? "").includes(PGID_MARKER),
        "PGID marker must be stripped from stderr"
      );

      // Verify that process group was killed using the captured PGID
      const killCalls = calls.filter((c) => c.argv.includes("kill"));
      assert.ok(killCalls.length >= 1, "Process group kill must be executed in finally block");
      const targetGroup = killCalls.some((c) => c.argv.includes("-9921"));
      assert.ok(targetGroup, "Kill call must target command group -9921");
    });

    it("handles runner rejection with timedOut === true in streaming exec/wait", async () => {
      const { runner, calls } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec" && argv.includes("sleep")) {
          const timeoutErr = new Error("Timed out") as Error & {
            timedOut: boolean;
            stderr: string;
          };
          timeoutErr.timedOut = true;
          timeoutErr.stderr = `${PGID_MARKER} 7712\n`;
          throw timeoutErr;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-stream-timeout",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const proc = await stream.exec({ argv: ["sleep", "10"], timeoutMs: 5000 });
      const status = await proc.wait();

      assert.equal(status.timedOut, true, "Streaming wait reports timedOut === true");
      assert.equal(status.exitCode, 124, "Streaming wait reports exitCode === 124");
      assert.equal(proc.pgid, 7712, "Process group id must be parsed from marker");

      // Verify iterator does not throw
      const chunks = [];
      for await (const chunk of proc.output) {
        chunks.push(chunk);
      }
      assert.ok(Array.isArray(chunks));

      const killCalls = calls.filter((c) => c.argv.includes("kill"));
      assert.ok(killCalls.some((c) => c.argv.includes("-7712")));
    });

    it("treats runner rejection after stream timer fires as timeout result", async () => {
      const { runner, calls } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec" && argv.includes("hang")) {
          // Wait longer than timeoutMs so stream timer fires
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new Error("Runner killed hanging process");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-timer-fired",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["hang"], timeoutMs: 20 });
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, 124);
    });

    it("propagates true non-timeout runner errors and re-throws", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          throw new Error("Docker daemon connection lost");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-error",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      await assert.rejects(
        async () => {
          await stream.run({ argv: ["echo", "test"] });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as Error).message, "Docker daemon connection lost");
          return true;
        }
      );
    });

    it("propagates runner error with integer exitCode without treating as timeout", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          const err = new Error("Command failed with 42") as Error & {
            exitCode: number;
            stderr: string;
          };
          err.exitCode = 42;
          err.stderr = "custom error 42\n";
          throw err;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-err-exitcode",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["test-exit"] });
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 42);
      assert.ok((result.stderrTail ?? "").includes("custom error 42"));
    });
  });

  describe("N-C11: Fail closed when no runner is injected (defaultChildProcessRunner removed)", () => {
    it("throws SpecValidationError when no runner is injected", () => {
      assert.throws(
        () =>
          new DockerExecStream({
            containerId: "box-rc1-no-runner",
            settings: { maxTimeoutMs: 10000 },
          }),
        (err: unknown) => {
          assert.ok(
            err instanceof SpecValidationError,
            "Must throw SpecValidationError when no runner is provided"
          );
          assert.ok(
            (err as Error).message.includes("explicit injected runner"),
            "Error message must require an explicit injected runner"
          );
          return true;
        }
      );
    });

    it("throws SpecValidationError when runner is not a function", () => {
      assert.throws(
        () =>
          new DockerExecStream({
            containerId: "box-rc1-invalid-runner-string",
            runner: "not-a-function" as unknown as DockerRunner,
            settings: { maxTimeoutMs: 10000 },
          }),
        (err: unknown) => err instanceof SpecValidationError
      );

      assert.throws(
        () =>
          new DockerExecStream({
            containerId: "box-rc1-invalid-runner-number",
            runner: 42 as unknown as DockerRunner,
            settings: { maxTimeoutMs: 10000 },
          }),
        (err: unknown) => err instanceof SpecValidationError
      );

      assert.throws(
        () =>
          new DockerExecStream({
            containerId: "box-rc1-invalid-runner-object",
            runner: {} as unknown as DockerRunner,
            settings: { maxTimeoutMs: 10000 },
          }),
        (err: unknown) => err instanceof SpecValidationError
      );
    });

    it("resolves runner successfully from options.runner", () => {
      const { runner } = createFakeRunner();
      const stream = new DockerExecStream({
        containerId: "box-runner-direct",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });
      assert.equal(stream.runner, runner);
    });

    it("resolves runner successfully from options.dockerRunner", () => {
      const { runner } = createFakeRunner();
      const stream = new DockerExecStream({
        containerId: "box-runner-docker",
        dockerRunner: runner,
        settings: { maxTimeoutMs: 10000 },
      });
      assert.equal(stream.runner, runner);
    });

    it("resolves runner successfully from options.sandbox.backend.runner", () => {
      const { runner } = createFakeRunner();
      const stream = new DockerExecStream({
        containerId: "box-runner-sandbox",
        sandbox: {
          backend: {
            runner,
          },
        },
        settings: { maxTimeoutMs: 10000 },
      });
      assert.equal(stream.runner, runner);
    });
  });

  describe("N-C14: Never classify exitCode === 0 via stdout/stderr text as OOM or timeout", () => {
    it("never classifies exitCode 0 as timedOut even if stderr contains timeout phrases", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          return {
            exitCode: 0,
            stdout: "Command succeeded normally\n",
            stderr: "Connection timed out after 3000ms\nError: ETIMEDOUT\noperation timed out\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-exit0-timeout-text",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["check", "network"] });

      assert.equal(result.exitCode, 0, "Exit code must remain 0");
      assert.equal(result.timedOut, false, "Must NEVER be marked timedOut on exitCode 0 due to text matching");
      assert.equal(result.oomKilled, false, "Must not be marked oomKilled");
      assert.ok((result.stdoutTail ?? "").includes("Command succeeded normally"));
      assert.ok((result.stderrTail ?? "").includes("Connection timed out"));
      assert.ok((result.stderrTail ?? "").includes("ETIMEDOUT"));
    });

    it("never classifies exitCode 0 as oomKilled even if stdout/stderr contains OOM phrases", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          return {
            exitCode: 0,
            stdout: "Log analysis complete: 0 out of memory events found\nCannot allocate memory check: passed\n",
            stderr: "Warning: previous run had javascript heap out of memory, but this run succeeded\nmemory limit exceeded check: ok\noom-killer status: inactive\noomkilled: false\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-exit0-oom-text",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["grep", "memory"] });

      assert.equal(result.exitCode, 0, "Exit code must remain 0");
      assert.equal(result.oomKilled, false, "Must NEVER be marked oomKilled on exitCode 0 due to text matching");
      assert.equal(result.timedOut, false, "Must not be marked timedOut");
      assert.ok((result.stdoutTail ?? "").includes("out of memory"));
      assert.ok((result.stdoutTail ?? "").includes("Cannot allocate memory"));
      assert.ok((result.stderrTail ?? "").includes("javascript heap out of memory"));
    });

    it("still marks oomKilled === true when runnerResult.oomKilled === true with exitCode 0", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          return {
            exitCode: 0,
            oomKilled: true,
            stdout: "",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-runner-oom",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["stress"] });
      assert.equal(result.oomKilled, true, "Must be marked oomKilled when runnerResult.oomKilled === true");
    });

    it("still marks oomKilled === true when docker inspect reports OOMKilled === true", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        }
        if (argv[0] === "inspect" && argv.includes("{{.State.OOMKilled}}")) {
          return {
            exitCode: 0,
            stdout: "true\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-inspect-oom",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["stress"] });
      assert.equal(result.oomKilled, true, "Must be marked oomKilled when docker inspect OOMKilled is true");
    });

    it("detects oomKilled for non-zero exit codes with OOM stderr patterns", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          return {
            exitCode: 137,
            stdout: "",
            stderr: "FATAL ERROR: JavaScript heap out of memory\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-nonzero-oom",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["node", "leak.js"] });
      assert.equal(result.exitCode, 137);
      assert.equal(result.oomKilled, true, "Non-zero exit with OOM stderr must be classified as oomKilled");
    });

    it("detects exitCode 124 as timeout", async () => {
      const { runner } = createFakeRunner(async (argv) => {
        if (argv[0] === "exec") {
          return {
            exitCode: 124,
            stdout: "",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const stream = new DockerExecStream({
        containerId: "box-rc1-code-124",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["sleep", "100"] });
      assert.equal(result.exitCode, 124);
      assert.equal(result.timedOut, true);
    });
  });

  describe("Round-3 Path C (N-C16 residual): containerId validation across all entry points and env keys", () => {
    const invalidContainerIds = [
      "",
      "--privileged",
      "-eFOO=1",
      "-leading-dash",
      "--option-flag",
      "has space",
      "has\nnewline",
      "has\rcarriage",
      "has\ttab",
      "c;rm -rf",
      "c|pipe",
      "c&bg",
      "c/slash",
      "a".repeat(129),
    ];

    it("assertValidStreamContainerId rejects invalid, dash-prefixed, or oversized IDs", () => {
      for (const id of invalidContainerIds) {
        assert.throws(
          () => assertValidStreamContainerId(id),
          (err: unknown) => err instanceof SpecValidationError,
          `Expected ${JSON.stringify(id)} to be rejected by assertValidStreamContainerId`
        );
      }
    });

    it("assertValidStreamContainerId accepts valid alphanumeric IDs matching SAFE_CONTAINER_ID_REGEX", () => {
      const validIds = [
        "c-12345",
        "box.456",
        "sandbox_789",
        "A-1.2_3-abc",
        "0123456789abcdef",
        "a".repeat(128),
      ];
      for (const id of validIds) {
        const returned = assertValidStreamContainerId(id);
        assert.equal(returned, id);
        assert.ok(SAFE_CONTAINER_ID_REGEX.test(id));
      }
    });

    it("buildExecArgv rejects invalid containerId ('--privileged', '-eFOO=1')", () => {
      for (const id of ["--privileged", "-eFOO=1", "-dash", ""]) {
        assert.throws(
          () => buildExecArgv(id, { argv: ["echo", "test"] }),
          (err: unknown) => err instanceof SpecValidationError,
          `buildExecArgv must reject ${id}`
        );
      }
    });

    it("killProcessGroup rejects invalid containerId ('--privileged', '-eFOO=1')", async () => {
      const { runner } = createFakeRunner();
      for (const id of ["--privileged", "-eFOO=1", "-dash", ""]) {
        await assert.rejects(
          async () => killProcessGroup(runner, id, 100),
          (err: unknown) => err instanceof SpecValidationError,
          `killProcessGroup must reject ${id}`
        );
      }
    });

    it("checkOomStatus rejects invalid containerId ('--privileged', '-eFOO=1')", async () => {
      const { runner } = createFakeRunner();
      for (const id of ["--privileged", "-eFOO=1", "-dash", ""]) {
        await assert.rejects(
          async () => checkOomStatus(runner, id, 0, "", ""),
          (err: unknown) => err instanceof SpecValidationError,
          `checkOomStatus must reject ${id}`
        );
      }
    });

    it("DockerExecProcess.signal rejects invalid containerId ('--privileged', '-eFOO=1')", async () => {
      const { runner } = createFakeRunner();
      for (const id of ["--privileged", "-eFOO=1", "-dash", ""]) {
        const proc = new DockerExecProcess(
          id,
          runner,
          Promise.resolve({ exitCode: 0, logRef: "", oomKilled: false, timedOut: false })
        );
        proc.setPgid(1234);
        await assert.rejects(
          async () => proc.signal("SIGTERM"),
          (err: unknown) => err instanceof SpecValidationError,
          `proc.signal must reject invalid containerId ${id}`
        );
      }
    });

    it("DockerExecStream constructor rejects invalid containerId ('--privileged', '-eFOO=1')", () => {
      const { runner } = createFakeRunner();
      for (const id of ["--privileged", "-eFOO=1", "-dash", ""]) {
        assert.throws(
          () => new DockerExecStream({ containerId: id, runner, settings: { maxTimeoutMs: 10000 } }),
          (err: unknown) => err instanceof SpecValidationError,
          `constructor must reject ${id}`
        );
      }
    });

    it("DockerExecStream.exec rejects invalid containerId ('--privileged', '-eFOO=1')", async () => {
      const { runner } = createFakeRunner();
      const stream = new DockerExecStream({
        containerId: "valid-box-id",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });
      for (const id of ["--privileged", "-eFOO=1", "-dash", ""]) {
        (stream as unknown as { containerId: string }).containerId = id;
        await assert.rejects(
          async () => stream.exec({ argv: ["echo", "test"] }),
          (err: unknown) => err instanceof SpecValidationError,
          `stream.exec must reject ${id}`
        );
      }
    });

    it("buildExecArgv validates env keys against /^[a-zA-Z_][a-zA-Z0-9_]*$/", () => {
      const invalidKeys = [
        "-eFOO=1",
        "--flag",
        "-leading-dash",
        "123NUM_START",
        "HAS SPACE",
        "FOO-BAR",
        "KEY=VAL",
        "KEY;CMD",
        "",
      ];
      for (const key of invalidKeys) {
        assert.throws(
          () =>
            buildExecArgv(
              "valid-box",
              { argv: ["echo", "test"], env: { [key]: "val" } },
              { envAllowlist: [key] }
            ),
          (err: unknown) => err instanceof SpecValidationError,
          `buildExecArgv must reject invalid env key ${JSON.stringify(key)}`
        );
      }

      // Valid keys are accepted
      const validArgv = buildExecArgv(
        "valid-box",
        { argv: ["echo", "test"], env: { VALID_VAR_1: "val", _INTERNAL: "ok" } },
        { envAllowlist: ["VALID_VAR_1", "_INTERNAL"] }
      );
      assert.ok(validArgv.includes("-e"));
      assert.ok(validArgv.includes("VALID_VAR_1=val"));
      assert.ok(validArgv.includes("_INTERNAL=ok"));
    });
  });

  describe("Round-3 Path C (LOW fixes): addChunk after close, accumulator cap, timeout catch stderr", () => {
    it("addChunk after finish or fail is ignored and returns undefined", () => {
      const { runner } = createFakeRunner();
      const proc = new DockerExecProcess(
        "valid-box-chunks",
        runner,
        Promise.resolve({ exitCode: 0, logRef: "", oomKilled: false, timedOut: false })
      );

      const chunk1 = proc.addChunk("stdout", "first chunk");
      assert.ok(chunk1);
      assert.equal(proc.seq, 1);

      proc.finish({ exitCode: 0, timedOut: false, oomKilled: false });
      const chunkAfterFinish = proc.addChunk("stdout", "after finish");
      assert.equal(chunkAfterFinish, undefined);
      assert.equal(proc.seq, 1);

      const proc2 = new DockerExecProcess(
        "valid-box-chunks-fail",
        runner,
        Promise.resolve({ exitCode: 1, logRef: "", oomKilled: false, timedOut: false })
      );
      proc2.fail(new Error("failed"));
      const chunkAfterFail = proc2.addChunk("stderr", "after fail");
      assert.equal(chunkAfterFail, undefined);
      assert.equal(proc2.seq, 0);
    });

    it("timeout catch does not inject err.message into stderrAccum", async () => {
      const { runner } = createFakeRunner(async () => {
        const timeoutErr = new Error("Host-side runner killed child after timeout") as Error & {
          timedOut: boolean;
          stderr?: string;
        };
        timeoutErr.timedOut = true;
        // Host error message is present, but container stderr is absent
        throw timeoutErr;
      });

      const stream = new DockerExecStream({
        containerId: "box-timeout-nomessage",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["sleep", "10"], timeoutMs: 5000 });
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, 124);
      assert.ok(
        !(result.stderrTail ?? "").includes("Host-side runner killed child"),
        "Host err.message must NOT be injected into container stderr"
      );
      assert.equal(result.stderrTail, "");
    });

    it("timeout catch appends non-empty err.stderr when not already present", async () => {
      const { runner } = createFakeRunner(async () => {
        const timeoutErr = new Error("Host timeout message") as Error & {
          timedOut: boolean;
          stderr: string;
        };
        timeoutErr.timedOut = true;
        timeoutErr.stderr = "real container stderr from error\n";
        throw timeoutErr;
      });

      const stream = new DockerExecStream({
        containerId: "box-timeout-real-stderr",
        runner,
        settings: { maxTimeoutMs: 10000 },
      });

      const result = await stream.run({ argv: ["sleep", "10"], timeoutMs: 5000 });
      assert.equal(result.timedOut, true);
      assert.ok(
        (result.stderrTail ?? "").includes("real container stderr from error"),
        "Container stderr must be captured"
      );
      assert.ok(
        !(result.stderrTail ?? "").includes("Host timeout message"),
        "Host err.message must NOT be present"
      );
    });

    it("enforces 20 MiB byte cap on stdoutAccum and stderrAccum", () => {
      assert.equal(STREAM_ACCUM_MAX_BYTES, 20 * 1024 * 1024);

      let res = appendWithCap("", 0, "a".repeat(100));
      assert.equal(res.bytes, 100);

      // Attempt to exceed cap
      const maxBytes = 1000;
      res = appendWithCap("x".repeat(950), 950, "y".repeat(100), maxBytes);
      assert.equal(res.bytes, maxBytes);
      assert.equal(res.text.length, maxBytes);
      assert.equal(res.text.slice(950), "y".repeat(50));

      // Attempt adding when already at cap
      const resAtCap = appendWithCap(res.text, res.bytes, "extra", maxBytes);
      assert.equal(resAtCap.bytes, maxBytes);
      assert.equal(resAtCap.text.length, maxBytes);
    });
  });
});
