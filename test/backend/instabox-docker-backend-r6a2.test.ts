// Work package R6-A2 tests: no silent timeout defaults and no user-wide process
// sweep in the Instabox Docker backend (audit items H-3, N-2, M-6, N-4).
// A command's timeoutMs must come from the caller as a positive integer,
// maxTimeoutMs must come from the settings, and sweepProcesses signals only the
// command's own process group.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  InstaboxDockerBackend,
  InstaboxDockerSandbox,
  type DockerRunner,
  type DockerRunnerOptions,
  type DockerRunnerResult,
} from "../../lib/backend/instabox-docker-backend";
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
    if (cmd === "create") {
      return { exitCode: 0, stdout: "c-r6a2-test-0001\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function assertRequiredSettingError(err: unknown): void {
  assert.ok(err instanceof SpecValidationError, `expected SpecValidationError, got ${String(err)}`);
  assert.match(
    (err as Error).message,
    /Missing required timeout setting/,
    "a missing or invalid timeout value must be reported as a required-setting error"
  );
}

// The sandbox is built directly so the test stays independent of the host path
// shape; the timeout checks under test happen in exec()/run(), not in create().
function buildSandbox(
  backend: InstaboxDockerBackend,
  id: string
): InstaboxDockerSandbox {
  const spec: SandboxSpec = {
    idempotencyKey: `idemp-${id}`,
    image: PINNED_TEST_IMAGE,
    labels: { "git-graveyard.run-id": "run-r6a2" },
    user: { uid: 1001, gid: 1001 },
  };
  return new InstaboxDockerSandbox(id, spec, backend);
}

describe("Work package R6-A2: Instabox Docker backend timeout and sweep remediation", () => {
  it("(R6-A2) a missing timeoutMs is a required-setting error before the command starts", async () => {
    const { runner, calls } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000 },
    });
    const sandbox = buildSandbox(backend, "c-r6a2-missing-timeout");

    await assert.rejects(
      async () => {
        await sandbox.exec({
          argv: ["echo", "hi"],
          cwd: "/workspace",
          logRef: "log-r6a2-missing-timeout",
        });
      },
      (err: unknown) => {
        assertRequiredSettingError(err);
        assert.match(
          (err as Error).message,
          /timeoutMs must be given by the caller as a positive integer/,
          "the error must name the missing caller timeoutMs"
        );
        return true;
      }
    );

    // The refusal happens before the command starts: no docker call was made
    assert.equal(
      calls.length,
      0,
      "a command without a caller timeoutMs must not start"
    );

    await assert.rejects(
      async () => {
        await sandbox.run({
          argv: ["echo", "hi"],
          cwd: "/workspace",
          logRef: "log-r6a2-missing-timeout-run",
        });
      },
      (err: unknown) => {
        assertRequiredSettingError(err);
        return true;
      }
    );
  });

  it("(R6-A2) a missing maxTimeoutMs is a required-setting error", async () => {
    const variants: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { maxTimeoutMs: "60000" },
      { maxTimeoutMs: 0 },
    ];
    for (const [index, settings] of variants.entries()) {
      const { runner, calls } = createRecordingRunner();
      const backend = new InstaboxDockerBackend({
        runner,
        settings: settings as Record<string, unknown> | undefined,
      });
      const sandbox = buildSandbox(backend, `c-r6a2-missing-max-${index}`);

      await assert.rejects(
        async () => {
          await sandbox.exec({
            argv: ["echo", "hi"],
            cwd: "/workspace",
            timeoutMs: 5000,
            logRef: `log-r6a2-missing-max-${index}`,
          });
        },
        (err: unknown) => {
          assertRequiredSettingError(err);
          assert.match(
            (err as Error).message,
            /maxTimeoutMs must be configured in the backend settings/,
            "the error must name the missing settings maxTimeoutMs"
          );
          return true;
        }
      );

      assert.equal(
        calls.filter((c) => c.argv[0] === "exec").length,
        0,
        "a command without a configured maxTimeoutMs must not start"
      );
    }
  });

  it("(R6-A2) the command timeout reaches the runner as given, never a 120000 default", async () => {
    const { runner, calls } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });
    const sandbox = buildSandbox(backend, "c-r6a2-timeout-passthrough");

    const result = await sandbox.run({
      argv: ["echo", "ok"],
      cwd: "/workspace",
      timeoutMs: 5000,
      logRef: "log-r6a2-timeout-passthrough",
    });
    assert.equal(result.exitCode, 0);

    const execCalls = calls.filter(
      (c) => c.argv[0] === "exec" && !c.argv.includes("kill")
    );
    assert.ok(execCalls.length >= 1, "the command must have run via docker exec");
    for (const call of execCalls) {
      assert.equal(
        call.options?.timeoutMs,
        5000,
        "the runner must receive the caller timeoutMs, not a silent default"
      );
    }
  });

  it("(R6-A2) sweepProcesses without a pgid throws and never runs docker", async () => {
    const { runner, calls } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({ runner });

    const invalid: Array<number | string | undefined> = [
      undefined,
      1,
      0,
      -5,
      "abc",
      "",
    ];
    for (const pgid of invalid) {
      await assert.rejects(
        async () => {
          await backend.sweepProcesses("c-r6a2-sweep-nopgid", pgid);
        },
        (err: unknown) => {
          assert.ok(
            err instanceof SpecValidationError,
            `pgid ${String(pgid)} must be refused with SpecValidationError`
          );
          assert.match(
            (err as Error).message,
            /numeric pgid greater than 1/,
            "the error must name the required pgid"
          );
          return true;
        }
      );
    }

    assert.equal(
      calls.length,
      0,
      "a sweep without a valid pgid must not signal anything"
    );
  });

  it("(R6-A2) sweepProcesses with a pgid signals only that group", async () => {
    const { runner, calls } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { housekeepingTimeoutMs: 5000 },
    });

    await backend.sweepProcesses("c-r6a2-sweep-1", 4242);

    assert.equal(calls.length, 1, "only the process-group kill must be signalled");
    assert.deepEqual(
      calls[0].argv,
      ["exec", "c-r6a2-sweep-1", "kill", "--", "-4242"],
      "the kill must target exactly the command's own process group"
    );

    calls.length = 0;
    await backend.sweepProcesses("c-r6a2-sweep-2", "4243");
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].argv,
      ["exec", "c-r6a2-sweep-2", "kill", "--", "-4243"],
      "a numeric pgid string must be accepted and signalled as that group"
    );

    for (const call of calls) {
      const joined = call.argv.join(" ");
      assert.equal(joined.includes("pkill"), false, "no user-wide pkill may be issued");
      assert.equal(joined.includes("-u"), false, "no user argument may be passed");
    }
  });

  it("(R6-A2) sweepProcesses propagates cleanup errors instead of swallowing them", async () => {
    const failingRunner: DockerRunner = async () => {
      throw new Error("docker daemon unreachable");
    };
    const backend = new InstaboxDockerBackend({
      runner: failingRunner,
      settings: { housekeepingTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await backend.sweepProcesses("c-r6a2-sweep-fail", 4244);
      },
      /docker daemon unreachable/,
      "a cleanup failure must propagate to the caller"
    );
  });
});
