// Work package R3-D tests: Instabox Docker backend mount validation, exit codes, uid (H-2, M-5, L-2)
// Requirements: 21.3, 21.6, 43.7, 43.10, H-2, M-5, L-2

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  InstaboxDockerBackend,
  MountSecurityError,
  validateMountAt,
  validateMountPath,
  validateUserSpec,
  type DockerRunner,
  type DockerRunnerOptions,
  type DockerRunnerResult,
} from "../../lib/backend/instabox-docker-backend";
import {
  buildRunNetworkPolicy,
  registerRunNetworkPolicy,
  releaseRunNetworkPolicy,
} from "../../lib/backend/network-policy";
import { SpecValidationError } from "../../lib/backend/spec-validator";
import type { SandboxSpec } from "../../lib/backend/types";

const PINNED_TEST_IMAGE =
  "docker.io/library/node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Work package R3-D: Instabox Docker backend hardening (H-2, M-5, L-2)", () => {
  let tmpRoot: string;
  let buildersDir1: string;
  let buildersDir2: string;
  let buildersDir3: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graveyard-r3d-test-"));
    buildersDir1 = path.join(tmpRoot, "builders", "box1");
    buildersDir2 = path.join(tmpRoot, "builders", "box2");
    buildersDir3 = path.join(tmpRoot, "builders", "box3");
    fs.mkdirSync(buildersDir1, { recursive: true });
    fs.mkdirSync(buildersDir2, { recursive: true });
    fs.mkdirSync(buildersDir3, { recursive: true });
  });

  after(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function createTestRunner(
    handler?: (argv: string[], options?: DockerRunnerOptions) => DockerRunnerResult | string | Promise<DockerRunnerResult | string>
  ): { runner: DockerRunner; calls: Array<{ argv: string[]; options?: DockerRunnerOptions }> } {
    const calls: Array<{ argv: string[]; options?: DockerRunnerOptions }> = [];
    const runner: DockerRunner = async (argv, options) => {
      calls.push({ argv: [...argv], options });
      if (handler) {
        return handler(argv, options);
      }
      const cmd = argv[0];
      if (cmd === "create") {
        return { exitCode: 0, stdout: "c-sandbox-r3d-12345\n", stderr: "" };
      }
      if (cmd === "wait") {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { runner, calls };
  }

  // 1. A comma in the container path is rejected
  it("(H-2) a comma in the container path is rejected", async () => {
    const runId = `run-r3d-comma-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      // Direct validation
      assert.throws(
        () => validateMountAt("/workspace,readonly"),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.equal((err as MountSecurityError).code, "MOUNT_SECURITY_ERROR");
          return true;
        }
      );

      assert.throws(
        () => validateMountAt("/workspace,bind-propagation=rshared"),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );

      // Box creation with comma in workspace mountAt
      const { runner } = createTestRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { housekeepingTimeoutMs: 5000 } });

      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-comma-1-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace,injected",
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );

      // Box creation with comma in additional mounts
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-comma-2-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            mounts: [
              {
                hostPath: buildersDir2,
                mountAt: "/workspace/sub,extra_opt",
              },
            ],
          } as SandboxSpec);
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  // 2. A colon is rejected
  it("(H-2) a colon is rejected", async () => {
    const runId = `run-r3d-colon-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      // Direct validation
      assert.throws(
        () => validateMountAt("/workspace:ro"),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );

      assert.throws(
        () => validateMountAt("/workspace:rw"),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );

      // Box creation with colon in workspace mountAt
      const { runner } = createTestRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { housekeepingTimeoutMs: 5000 } });

      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-colon-1-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace:ro",
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );

      // Box creation with colon in additional mounts
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-colon-2-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            mounts: [
              {
                hostPath: buildersDir2,
                mountAt: "/workspace:extra",
              },
            ],
          } as SandboxSpec);
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  // 3. A realpath failure is rejected
  it("(H-2) a realpath failure is rejected (never falls back to path.resolve)", async () => {
    const runId = `run-r3d-realpath-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const nonExistentPath = path.join(tmpRoot, "builders", "does_not_exist_at_all");

      // Direct validation
      assert.throws(
        () => validateMountPath(nonExistentPath, "runbox"),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.ok((err as Error).message.includes("realpath"));
          return true;
        }
      );

      // Box creation with non-existent host path
      const { runner } = createTestRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { housekeepingTimeoutMs: 5000 } });

      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-realpath-1-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: nonExistentPath,
              mountAt: "/workspace",
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  // 4. Duplicate targets are rejected
  it("(H-2) duplicate targets are rejected", async () => {
    const runId = `run-r3d-dup-targets-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createTestRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { housekeepingTimeoutMs: 5000 } });

      // Workspace and additional mount targeting the same container target
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-dup-target-1-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            mounts: [
              {
                hostPath: buildersDir2,
                mountAt: "/workspace",
              },
            ],
          } as SandboxSpec);
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.ok((err as Error).message.includes("same container target"));
          return true;
        }
      );

      // Two mounts targeting the same subpath
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-dup-target-2-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            mounts: [
              {
                hostPath: buildersDir2,
                mountAt: "/workspace/pkg",
              },
              {
                hostPath: buildersDir3,
                mountAt: "/workspace/pkg",
              },
            ],
          } as SandboxSpec);
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.ok((err as Error).message.includes("same container target"));
          return true;
        }
      );

      // Normalization collision: /workspace/data/ vs /workspace/data
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-dup-target-3-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            mounts: [
              {
                hostPath: buildersDir2,
                mountAt: "/workspace/data/",
              },
              {
                hostPath: buildersDir3,
                mountAt: "/workspace/data",
              },
            ],
          } as SandboxSpec);
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  // 4b. Duplicate key inside one mount specification is rejected
  it("(H-2) reject duplicate key inside one mount specification", async () => {
    const runId = `run-r3d-dup-keys-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createTestRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { housekeepingTimeoutMs: 5000 } });

      // Duplicate source keys (hostPath and source)
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-dup-key-1-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              source: buildersDir2,
              mountAt: "/workspace",
            } as unknown as SandboxSpec["workspace"],
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.ok((err as Error).message.includes("Duplicate key"));
          return true;
        }
      );

      // Duplicate target keys (mountAt and target)
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-dup-key-2-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
              target: "/workspace",
            } as unknown as SandboxSpec["workspace"],
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.ok((err as Error).message.includes("Duplicate key"));
          return true;
        }
      );

      // String mount specification with duplicate target key
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-dup-key-3-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            mounts: [
              `type=bind,source=${buildersDir2},target=/workspace/sub,target=/workspace/sub2`,
            ] as unknown as SandboxSpec["mounts"],
          } as SandboxSpec);
        },
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.ok((err as Error).message.includes("Duplicate key"));
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  // 5. A string exit code is rejected
  it("(M-5) a string exit code is rejected", async () => {
    // Runner returning raw string instead of an object
    const backendStringReturn = new InstaboxDockerBackend({
      runner: async () => "0" as unknown as DockerRunnerResult,
      settings: { housekeepingTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await backendStringReturn.runDocker(["create"]);
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes("returned a string instead of an integer exit code"));
        return true;
      }
    );

    // Runner returning object with string exitCode
    const backendStringCode = new InstaboxDockerBackend({
      runner: async () => ({
        exitCode: "0" as unknown as number,
        stdout: "box-str-code\n",
        stderr: "",
      }),
      settings: { housekeepingTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await backendStringCode.runDocker(["create"]);
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes("exit code must be an integer, received string"));
        return true;
      }
    );

    // Runner returning object with non-numeric string code
    const backendErrorCode = new InstaboxDockerBackend({
      runner: async () => ({
        exitCode: "error" as unknown as number,
        stdout: "",
        stderr: "failed",
      }),
      settings: { housekeepingTimeoutMs: 5000 },
    });

    await assert.rejects(
      async () => {
        await backendErrorCode.runDocker(["create"]);
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes("exit code must be an integer"));
        return true;
      }
    );
  });

  // 6. Unparseable wait output is rejected
  it("(M-5) unparseable wait output is rejected (docker CLI exit code is never a substitute)", async () => {
    const runId = `run-r3d-wait-unparseable-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createTestRunner((argv) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-wait-test-box\n", stderr: "" };
        }
        if (argv[0] === "wait") {
          // Docker CLI exited with code 0, but output is non-integer string
          return { exitCode: 0, stdout: "unparseable_output\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-wait-unparseable-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: {
          mode: "bind",
          hostPath: buildersDir1,
          mountAt: "/workspace",
        },
      });

      // wait() must reject because stdout cannot be parsed as integer,
      // and docker CLI exit code 0 must NOT be substituted.
      await assert.rejects(
        async () => {
          await sandbox.wait();
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes("Failed to parse container exit code"));
          return true;
        }
      );

      // Also test empty wait output
      const { runner: emptyWaitRunner } = createTestRunner((argv) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-wait-empty-box\n", stderr: "" };
        }
        if (argv[0] === "wait") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backendEmpty = new InstaboxDockerBackend({ runner: emptyWaitRunner, settings: { housekeepingTimeoutMs: 5000 } });
      const sandboxEmpty = await backendEmpty.create({
        idempotencyKey: `idemp-wait-empty-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: {
          mode: "bind",
          hostPath: buildersDir1,
          mountAt: "/workspace",
        },
      });

      await assert.rejects(
        async () => {
          await sandboxEmpty.wait();
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes("Failed to parse container exit code"));
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  // 7. A user spec without a numeric uid must be an error and must never produce '-u undefined'
  it("(L-2) a user spec without a numeric uid must be an error and must never produce '-u undefined'", async () => {
    const runId = `run-r3d-user-uid-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      // Direct validation
      assert.throws(
        () => validateUserSpec({ user: {} as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      assert.throws(
        () => validateUserSpec({ user: { name: "nobody" } as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      assert.throws(
        () => validateUserSpec({ user: { gid: 1000 } as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      assert.throws(
        () => validateUserSpec({ user: "nobody" as unknown as SandboxSpec["user"] }),
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      const { runner, calls } = createTestRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { housekeepingTimeoutMs: 5000 } });

      // Box creation with empty user object
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-user-empty-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            user: {} as unknown as SandboxSpec["user"],
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      // Box creation with user object lacking uid
      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-user-nouid-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: { diskMiB: 512 },
            workspace: {
              mode: "bind",
              hostPath: buildersDir1,
              mountAt: "/workspace",
            },
            user: { gid: 1000 } as unknown as SandboxSpec["user"],
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          return true;
        }
      );

      // Verify that a valid user spec produces clean numeric user flags and never '-u undefined'
      calls.length = 0;
      const validSandbox = await backend.create({
        idempotencyKey: `idemp-user-valid-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: {
          mode: "bind",
          hostPath: buildersDir1,
          mountAt: "/workspace",
        },
        user: { uid: 1001, gid: 1001 },
      });

      assert.ok(validSandbox);
      const createCall = calls.find((c) => c.argv[0] === "create");
      assert.ok(createCall);
      const userIdx = createCall.argv.indexOf("--user");
      assert.notEqual(userIdx, -1);
      assert.equal(createCall.argv[userIdx + 1], "1001:1001");
      assert.equal(createCall.argv.includes("undefined"), false, "Must never produce undefined in create argv");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });
});
