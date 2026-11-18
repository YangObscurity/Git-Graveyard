// Work package RC2b tests:
// N-C12: Anchored PINNED_DIGEST_REGEX, trimming, newlines, unanchored tails
// N-C16: Strict containerId validation across get/destroy/sandbox,
//        mandatory housekeepingTimeoutMs even with injected runner.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  InstaboxDockerBackend,
  InstaboxDockerSandbox,
  PINNED_DIGEST_REGEX,
  isPinnedDigestImage,
  isPinnedDigest,
  SAFE_CONTAINER_ID_REGEX,
  assertValidContainerId,
  requireHousekeepingTimeoutSettings,
  defaultChildProcessRunner,
  DEFAULT_RUNNER_MAX_BUFFER_BYTES,
  type DockerRunner,
  type DockerRunnerOptions,
  type DockerRunnerResult,
} from "../../lib/backend/instabox-docker-backend";
import { SpecValidationError } from "../../lib/backend/spec-validator";
import {
  buildRunNetworkPolicy,
  registerRunNetworkPolicy,
  releaseRunNetworkPolicy,
} from "../../lib/backend/network-policy";
import type { Sandbox, SandboxSpec } from "../../lib/backend/types";

const VALID_DIGEST_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const VALID_PINNED_IMAGE = `docker.io/library/node@sha256:${VALID_DIGEST_HEX}`;

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
      return { exitCode: 0, stdout: "c-rc2-test-0001\n", stderr: "" };
    }
    if (cmd === "inspect") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ Id: "c-rc2-test-0001", State: { Status: "running" } }]),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function buildSandbox(
  backend: InstaboxDockerBackend,
  id: string
): InstaboxDockerSandbox {
  const spec: SandboxSpec = {
    idempotencyKey: `idemp-${id}`,
    image: VALID_PINNED_IMAGE,
    labels: {},
    user: { uid: 1001, gid: 1001 },
  };
  return new InstaboxDockerSandbox(id, spec, backend);
}

describe("Work package RC2b: N-C12 pinned digest anchoring and validation", () => {
  it("PINNED_DIGEST_REGEX is anchored at start and end", () => {
    assert.ok(PINNED_DIGEST_REGEX.source.startsWith("^"));
    assert.ok(PINNED_DIGEST_REGEX.source.endsWith("$"));
  });

  it("rejects image references starting with an option-like leading dash", () => {
    const dashFlag = `--flag@sha256:${VALID_DIGEST_HEX}`;
    const singleDash = `-img@sha256:${VALID_DIGEST_HEX}`;

    assert.equal(PINNED_DIGEST_REGEX.test(dashFlag), false);
    assert.equal(PINNED_DIGEST_REGEX.test(singleDash), false);
    assert.equal(isPinnedDigestImage(dashFlag), false);
    assert.equal(isPinnedDigestImage(singleDash), false);
    assert.equal(isPinnedDigest(dashFlag), false);
  });

  it("rejects image references with trailing unanchored text or non-sha256 unanchored tails", () => {
    const trailingSpace = `img@sha256:${VALID_DIGEST_HEX} trailing`;
    const trailingExtra = `img@sha256:${VALID_DIGEST_HEX}extra`;
    const trailingChars = `docker.io/node@sha256:${VALID_DIGEST_HEX}::something`;

    assert.equal(PINNED_DIGEST_REGEX.test(trailingSpace), false);
    assert.equal(PINNED_DIGEST_REGEX.test(trailingExtra), false);
    assert.equal(PINNED_DIGEST_REGEX.test(trailingChars), false);
    assert.equal(isPinnedDigestImage(trailingSpace), false);
    assert.equal(isPinnedDigestImage(trailingExtra), false);
    assert.equal(isPinnedDigestImage(trailingChars), false);
  });

  it("rejects image references with embedded newlines", () => {
    const newlineInName = `img\n@sha256:${VALID_DIGEST_HEX}`;
    const newlineInDigest = `img@sha256:${VALID_DIGEST_HEX.slice(0, 32)}\n${VALID_DIGEST_HEX.slice(32)}`;
    const newlineWithTail = `img@sha256:${VALID_DIGEST_HEX}\nmalicious-tail`;

    assert.equal(PINNED_DIGEST_REGEX.test(newlineInName), false);
    assert.equal(PINNED_DIGEST_REGEX.test(newlineInDigest), false);
    assert.equal(PINNED_DIGEST_REGEX.test(newlineWithTail), false);
    assert.equal(isPinnedDigestImage(newlineInName), false);
    assert.equal(isPinnedDigestImage(newlineInDigest), false);
    assert.equal(isPinnedDigestImage(newlineWithTail), false);
  });

  it("rejects non-sha256 algorithms or invalid digest lengths", () => {
    const sha512 = `img@sha512:${"a".repeat(128)}`;
    const md5 = `img@md5:${"a".repeat(32)}`;
    const tooShort = `img@sha256:${"a".repeat(63)}`;
    const tooLong = `img@sha256:${"a".repeat(65)}`;
    const invalidHex = `img@sha256:${"g".repeat(64)}`;

    assert.equal(PINNED_DIGEST_REGEX.test(sha512), false);
    assert.equal(PINNED_DIGEST_REGEX.test(md5), false);
    assert.equal(PINNED_DIGEST_REGEX.test(tooShort), false);
    assert.equal(PINNED_DIGEST_REGEX.test(tooLong), false);
    assert.equal(PINNED_DIGEST_REGEX.test(invalidHex), false);
    assert.equal(isPinnedDigestImage(sha512), false);
    assert.equal(isPinnedDigestImage(tooShort), false);
    assert.equal(isPinnedDigestImage(invalidHex), false);
  });

  it("rejects references with multiple @ characters", () => {
    const doubleAt = `img@sha256:${VALID_DIGEST_HEX}@sha256:${VALID_DIGEST_HEX}`;
    const atInName = `user@host/img@sha256:${VALID_DIGEST_HEX}`;

    assert.equal(PINNED_DIGEST_REGEX.test(doubleAt), false);
    assert.equal(PINNED_DIGEST_REGEX.test(atInName), false);
    assert.equal(isPinnedDigestImage(doubleAt), false);
    assert.equal(isPinnedDigestImage(atInName), false);
  });

  it("accepts valid pinned digest references and trims outer whitespace", () => {
    assert.equal(isPinnedDigestImage(VALID_PINNED_IMAGE), true);
    assert.equal(isPinnedDigest(VALID_PINNED_IMAGE), true);

    const withPadding = `   ${VALID_PINNED_IMAGE}  \n`;
    assert.equal(isPinnedDigestImage(withPadding), true);
    assert.equal(isPinnedDigest(withPadding), true);

    const uppercaseDigest = `ubuntu@sha256:${VALID_DIGEST_HEX.toUpperCase()}`;
    assert.equal(isPinnedDigestImage(uppercaseDigest), true);

    const withPortAndTag = `my-registry.corp.net:5000/app/worker:v1.2@sha256:${VALID_DIGEST_HEX}`;
    assert.equal(isPinnedDigestImage(withPortAndTag), true);
  });
});

describe("Work package RC2b: N-C16 strict containerId validation", () => {
  const invalidContainerIds = [
    "",
    "   ",
    "-leading-dash",
    "--option-flag",
    "has space",
    "has\nnewline",
    "has\rcarriage",
    "has\ttab",
    "has\x00null",
    "has\x1fcontrol",
    "c;rm -rf",
    "c|pipe",
    "c&bg",
    "c$var",
    "c>out",
    "c<in",
    "c@name",
    "c#hash",
    "c/slash",
    "c\\backslash",
  ];

  it("assertValidContainerId rejects invalid, empty, or dash-prefixed container IDs", () => {
    for (const id of invalidContainerIds) {
      assert.throws(
        () => assertValidContainerId(id),
        (err: unknown) => err instanceof SpecValidationError,
        `Expected ${JSON.stringify(id)} to be rejected by assertValidContainerId`
      );
    }
  });

  it("assertValidContainerId accepts valid alphanumeric container IDs matching SAFE_CONTAINER_ID_REGEX", () => {
    const validIds = [
      "c-12345",
      "box.456",
      "sandbox_789",
      "A-1.2_3-abc",
      "0123456789abcdef",
    ];
    for (const id of validIds) {
      assert.doesNotThrow(() => assertValidContainerId(id));
      assert.ok(SAFE_CONTAINER_ID_REGEX.test(id));
    }
  });

  it("InstaboxDockerSandbox constructor rejects invalid or dash-prefixed containerId", () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });
    const spec: SandboxSpec = {
      idempotencyKey: "idemp-rc2",
      image: VALID_PINNED_IMAGE,
      labels: {},
      user: { uid: 1001, gid: 1001 },
    };

    assert.throws(
      () => new InstaboxDockerSandbox("-dash-id", spec, backend),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.throws(
      () => new InstaboxDockerSandbox("", spec, backend),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.throws(
      () => new InstaboxDockerSandbox("has space", spec, backend),
      (err: unknown) => err instanceof SpecValidationError
    );
  });

  it("InstaboxDockerBackend.get(containerId) rejects invalid or dash-prefixed containerId", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });

    for (const id of ["--flag", "-dash", "", "c with spaces"]) {
      await assert.rejects(
        async () => {
          await backend.get(id);
        },
        (err: unknown) => err instanceof SpecValidationError,
        `backend.get(${JSON.stringify(id)}) must throw SpecValidationError`
      );
    }
  });

  it("InstaboxDockerBackend.destroy(sandbox) rejects invalid or dash-prefixed containerId", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });

    for (const id of ["--flag", "-dash", "", "c with spaces"]) {
      await assert.rejects(
        async () => {
          await backend.destroy(id);
        },
        (err: unknown) => err instanceof SpecValidationError,
        `backend.destroy(${JSON.stringify(id)}) must throw SpecValidationError`
      );
    }

    await assert.rejects(
      async () => {
        await backend.destroy({ id: "--flag-in-sandbox" } as unknown as Sandbox);
      },
      (err: unknown) => err instanceof SpecValidationError
    );
  });

  it("InstaboxDockerSandbox.destroy, status, sweepProcesses reject invalid containerId", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });
    const sandbox = buildSandbox(backend, "valid-initial-id");

    // Mutate containerId to test runtime assertion in lifecycle methods
    (sandbox as { containerId: string }).containerId = "--flagged-id";

    await assert.rejects(
      async () => {
        await sandbox.destroy();
      },
      (err: unknown) => err instanceof SpecValidationError
    );

    await assert.rejects(
      async () => {
        await sandbox.status();
      },
      (err: unknown) => err instanceof SpecValidationError
    );

    await assert.rejects(
      async () => {
        await sandbox.sweepProcesses(4242);
      },
      (err: unknown) => err instanceof SpecValidationError
    );
  });

  it("InstaboxDockerBackend.sweepProcesses rejects invalid containerId", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { housekeepingTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await backend.sweepProcesses("-dash-container", 4242);
      },
      (err: unknown) => err instanceof SpecValidationError
    );
    await assert.rejects(
      async () => {
        await backend.sweepProcesses("bad container id", 4242);
      },
      (err: unknown) => err instanceof SpecValidationError
    );
  });

  it("InstaboxDockerSandbox.status returns state string when containerId is valid", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
    });
    const sandbox = buildSandbox(backend, "c-rc2-status-ok");
    const st = await sandbox.status();
    assert.equal(typeof st, "string");
    assert.equal(st, "running");
  });
});

describe("Work package RC2b: N-C16 mandatory housekeepingTimeoutMs", () => {
  it("requireHousekeepingTimeoutSettings throws when missing or non-positive integer", () => {
    assert.throws(
      () => requireHousekeepingTimeoutSettings(undefined),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.throws(
      () => requireHousekeepingTimeoutSettings({}),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.throws(
      () => requireHousekeepingTimeoutSettings({ housekeepingTimeoutMs: 0 }),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.throws(
      () => requireHousekeepingTimeoutSettings({ housekeepingTimeoutMs: -100 }),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.throws(
      () => requireHousekeepingTimeoutSettings({ housekeepingTimeoutMs: "5000" as unknown as number }),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.equal(
      requireHousekeepingTimeoutSettings({ housekeepingTimeoutMs: 5000 }),
      5000
    );
  });

  it("withHousekeepingTimeout requires housekeepingTimeoutMs when timeoutMs is omitted", () => {
    const { runner } = createRecordingRunner();
    const backendWithoutHk = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000 },
    });

    assert.throws(
      () => backendWithoutHk.withHousekeepingTimeout(["inspect", "c-1"]),
      (err: unknown) => err instanceof SpecValidationError
    );

    const backendWithHk = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 4200 },
    });
    const opts = backendWithHk.withHousekeepingTimeout(["inspect", "c-1"]);
    assert.equal(opts?.timeoutMs, 4200);

    // docker wait is exempt
    const waitOpts = backendWithoutHk.withHousekeepingTimeout(["wait", "c-1"]);
    assert.equal(waitOpts?.timeoutMs, undefined);
  });

  it("sandbox.exec rejects missing housekeepingTimeoutMs even with an injected runner", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000 }, // missing housekeepingTimeoutMs
    });
    const sandbox = buildSandbox(backend, "c-rc2-exec-no-hk");

    await assert.rejects(
      async () => {
        await sandbox.exec({
          argv: ["echo", "test"],
          cwd: "/workspace",
          timeoutMs: 5000,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecValidationError);
        assert.match((err as Error).message, /housekeepingTimeoutMs/);
        return true;
      }
    );
  });

  it("sandbox.run rejects missing housekeepingTimeoutMs even with an injected runner", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000 }, // missing housekeepingTimeoutMs
    });
    const sandbox = buildSandbox(backend, "c-rc2-run-no-hk");

    await assert.rejects(
      async () => {
        await sandbox.run({
          argv: ["echo", "test"],
          cwd: "/workspace",
          timeoutMs: 5000,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecValidationError);
        assert.match((err as Error).message, /housekeepingTimeoutMs/);
        return true;
      }
    );
  });

  it("runDocker (non-wait) requires housekeepingTimeoutMs even with an injected runner", async () => {
    const { runner } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000 }, // missing housekeepingTimeoutMs
    });

    await assert.rejects(
      async () => {
        await backend.runDocker(["ps"]);
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecValidationError);
        assert.match((err as Error).message, /housekeepingTimeoutMs/);
        return true;
      }
    );

    // wait call is exempt
    const res = await backend.runDocker(["wait", "c-rc2-exempt"]);
    assert.equal(res.exitCode, 0);
  });

  it("runDocker passes housekeepingTimeoutMs to injected runner when configured", async () => {
    const { runner, calls } = createRecordingRunner();
    const backend = new InstaboxDockerBackend({
      runner,
      settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 3500 },
    });

    await backend.runDocker(["inspect", "c-rc2-ok"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.timeoutMs, 3500);
  });
});

describe("Work package RC2c: Path C container name and env validation, defaultChildProcessRunner fixes", () => {
  describe("validate spec.name/containerName and env keys in backend.create", () => {
    it("backend.create throws SpecValidationError when spec.name is invalid or starts with dash", async () => {
      const { runner } = createRecordingRunner();
      const backend = new InstaboxDockerBackend({
        runner,
        settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
      });

      for (const badName of ["--privileged", "-dash", "-eFOO=1", "has space", "bad;cmd", ""]) {
        await assert.rejects(
          async () => {
            await backend.create({
              idempotencyKey: `idemp-name-${Date.now()}-${Math.random()}`,
              image: VALID_PINNED_IMAGE,
              name: badName,
            });
          },
          (err: unknown) => err instanceof SpecValidationError,
          `Expected spec.name ${JSON.stringify(badName)} to throw SpecValidationError`
        );
      }
    });

    it("backend.create throws SpecValidationError when spec.containerName is invalid or starts with dash", async () => {
      const { runner } = createRecordingRunner();
      const backend = new InstaboxDockerBackend({
        runner,
        settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
      });

      for (const badName of ["--privileged", "-dash", "-eFOO=1", "has space", "bad;cmd", ""]) {
        await assert.rejects(
          async () => {
            await backend.create({
              idempotencyKey: `idemp-cname-${Date.now()}-${Math.random()}`,
              image: VALID_PINNED_IMAGE,
              containerName: badName,
            });
          },
          (err: unknown) => err instanceof SpecValidationError,
          `Expected spec.containerName ${JSON.stringify(badName)} to throw SpecValidationError`
        );
      }
    });

    it("backend.create throws SpecValidationError when env key does not match /^[a-zA-Z_][a-zA-Z0-9_]*$/", async () => {
      const { runner } = createRecordingRunner();
      const backend = new InstaboxDockerBackend({
        runner,
        settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
      });

      const invalidEnvKeys = [
        "-eFOO=1",
        "--flag",
        "-dash",
        "123NUM",
        "HAS SPACE",
        "FOO-BAR",
        "KEY=VAL",
        "KEY;CMD",
        "",
      ];

      for (const key of invalidEnvKeys) {
        await assert.rejects(
          async () => {
            await backend.create({
              idempotencyKey: `idemp-env-${Date.now()}-${Math.random()}`,
              image: VALID_PINNED_IMAGE,
              env: { [key]: "test-val" },
            });
          },
          (err: unknown) => err instanceof SpecValidationError,
          `Expected invalid env key ${JSON.stringify(key)} to throw SpecValidationError`
        );
      }
    });

    it("backend.create accepts valid spec.name and valid env keys", async () => {
      const runId = `run-valid-create-${Date.now()}`;
      const policy = buildRunNetworkPolicy(runId);
      registerRunNetworkPolicy(policy);

      try {
        const { runner, calls } = createRecordingRunner();
        const backend = new InstaboxDockerBackend({
          runner,
          settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 },
        });

        const sandbox = await backend.create({
          idempotencyKey: "idemp-valid-spec-001",
          image: VALID_PINNED_IMAGE,
          name: "my-valid-box.01",
          labels: { "git-graveyard.run-id": runId },
          resources: { diskMiB: 512 },
          env: {
            VALID_VAR_1: "val1",
            _PRIVATE_VAR: "val2",
            lowercase_var: "val3",
          },
        });

        assert.ok(sandbox);
        const createCall = calls.find((c) => c.argv[0] === "create");
        assert.ok(createCall, "docker create call must have been made");
        const nameIdx = createCall.argv.indexOf("--name");
        assert.ok(nameIdx !== -1, "--name flag must be present");
        assert.equal(createCall.argv[nameIdx + 1], "my-valid-box.01");
        assert.ok(createCall.argv.includes("--env"));
        assert.ok(createCall.argv.includes("VALID_VAR_1=val1"));
        assert.ok(createCall.argv.includes("_PRIVATE_VAR=val2"));
        assert.ok(createCall.argv.includes("lowercase_var=val3"));
      } finally {
        releaseRunNetworkPolicy(runId);
      }
    });
  });

  describe("defaultChildProcessRunner timedOut order and callbacks", () => {
    it("defaultChildProcessRunner rejects with timedOut = true and code 124 on timeout", async () => {
      await assert.rejects(
        async () => {
          // A short timeout against a hanging/slow command causes runner timeout
          await defaultChildProcessRunner(["ps"], { timeoutMs: 20 });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          const e = err as Error & { timedOut?: boolean; code?: number | null; exitCode?: number | null };
          assert.equal(e.timedOut, true, "timedOut must be true");
          assert.equal(e.code, 124, "code must be 124");
          return true;
        }
      );
    });

    it("defaultChildProcessRunner invokes streaming onStdout callback for normal output", async () => {
      let chunksReceived = 0;
      const res = await defaultChildProcessRunner(["--version"], {
        timeoutMs: 5000,
        onStdout: (chunk) => {
          assert.equal(typeof chunk, "string");
          chunksReceived++;
        },
      });
      assert.equal(res.exitCode, 0);
      assert.ok(chunksReceived > 0, "onStdout callback must have been invoked");
      assert.ok(res.stdout.includes("Docker version"));
    });
  });
});
