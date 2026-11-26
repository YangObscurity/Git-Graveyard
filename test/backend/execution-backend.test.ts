// Work package F06c: Execution backend real docker exec and run, required Sandbox members, no default bridge network
// Requirements: 21.1 to 21.9, 43.1, 43.4, 43.8, 43.11

import test, { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createExecutionBackend,
  DockerCloudSandboxBackend,
  DockerCloudSandboxStub,
  InstaboxDockerBackend,
  InstaboxDockerSandbox,
  NetworkPolicyRequiredError,
  NotInV1Error,
} from "../../lib/backend/execution-backend";
import {
  buildRunNetworkPolicy,
  registerRunNetworkPolicy,
  releaseRunNetworkPolicy,
} from "../../lib/backend/network-policy";
import {
  MountSecurityError,
  validateMountPath,
  validateMountAt,
  resolveDiskLimit,
  type DockerRunner,
  type DockerRunnerOptions,
  type DockerRunnerResult,
} from "../../lib/backend/instabox-docker-backend";
import {
  buildExecArgv,
  COMMAND_GROUP_SCRIPT,
  getMinimalDockerEnv,
  isForbiddenEnvName,
  isForbiddenEnvValue,
  isRootUser,
  RunnerExitCodeError,
  FORBIDDEN_ENV_VALUE_PREFIXES,
  type DockerExecProcess,
} from "../../lib/backend/docker-exec-stream";
import { SpecValidationError } from "../../lib/backend/spec-validator";
import type {
  HardenedExecResult,
  Sandbox,
  SandboxSpec,
  ExecRequest,
} from "../../lib/backend/types";

const PINNED_TEST_IMAGE =
  "docker.io/library/node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const testFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "graveyard-backend-test-"));
const testBuildersP = path.join(testFixtureDir, "builders", "p");
fs.mkdirSync(testBuildersP, { recursive: true });
const TEST_BUILDERS_P = fs.realpathSync(testBuildersP);

const testBuildersProject = path.join(testFixtureDir, "builders", "project");
fs.mkdirSync(testBuildersProject, { recursive: true });
const TEST_BUILDERS_PROJECT = fs.realpathSync(testBuildersProject);

const testBuildersTest = path.join(testFixtureDir, "builders", "test");
fs.mkdirSync(testBuildersTest, { recursive: true });
const TEST_BUILDERS_TEST = fs.realpathSync(testBuildersTest);

const testBuildersMyRepo = path.join(testFixtureDir, "builders", "my-repo");
fs.mkdirSync(testBuildersMyRepo, { recursive: true });
const TEST_BUILDERS_MY_REPO = fs.realpathSync(testBuildersMyRepo);

interface RecordedCall {
  argv: string[];
  options?: DockerRunnerOptions;
}

function createFakeRunner(
  handler?: (argv: string[], options?: DockerRunnerOptions) => DockerRunnerResult | string | Promise<DockerRunnerResult | string>
) {
  const calls: RecordedCall[] = [];
  const runner: DockerRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    if (handler) {
      return handler(argv, options);
    }
    const cmd = argv[0];
    if (cmd === "create") {
      return { exitCode: 0, stdout: "c-sandbox-test-12345\n", stderr: "" };
    }
    if (cmd === "exec") {
      return { exitCode: 0, stdout: "fake exec stdout\n", stderr: "" };
    }
    if (cmd === "wait") {
      return { exitCode: 0, stdout: "0\n", stderr: "" };
    }
    if (cmd === "stop" || cmd === "rm") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("F06c: createExecutionBackend factory and class exports", () => {
  it("returns hardened InstaboxDockerBackend from instabox-docker-backend.ts by default", () => {
    const backend = createExecutionBackend();
    assert.ok(backend instanceof InstaboxDockerBackend);
    assert.equal(backend.kind, "instabox-docker");
  });

  it("returns hardened InstaboxDockerBackend when explicit instabox-docker backendKind is provided", () => {
    const { runner } = createFakeRunner();
    const backend = createExecutionBackend("instabox-docker", { runner });
    assert.ok(backend instanceof InstaboxDockerBackend);
    assert.equal(backend.kind, "instabox-docker");
  });

  it("returns hardened InstaboxDockerBackend when options object is passed directly", () => {
    const { runner } = createFakeRunner();
    const backend = createExecutionBackend({ runner });
    assert.ok(backend instanceof InstaboxDockerBackend);
    assert.equal(backend.kind, "instabox-docker");
  });

  it("returns DockerCloudSandboxStub when docker-cloud-sandbox is requested", () => {
    const backend = createExecutionBackend("docker-cloud-sandbox");
    assert.ok(backend instanceof DockerCloudSandboxStub);
    assert.equal(backend.kind, "docker-cloud-sandbox");
  });

  it("throws NotInV1Error with code NOT_IN_V1 when unsupported backend kind is requested", () => {
    assert.throws(
      () => createExecutionBackend("unsupported-backend-xyz"),
      (err: unknown) => {
        assert.ok(err instanceof NotInV1Error);
        assert.equal((err as NotInV1Error).code, "NOT_IN_V1");
        assert.equal((err as NotInV1Error).ok, false);
        return true;
      }
    );
  });
});

describe("F06c: Refusal without registered network policy (Requirement 21.9, 43.11)", () => {
  it("refuses create when no network policy is registered and spec has no runId", async () => {
    const { runner, calls } = createFakeRunner();
    const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

    const spec: SandboxSpec = {
      idempotencyKey: "box-nopolicy-1",
      image: PINNED_TEST_IMAGE,
      workspace: {
        mode: "bind",
        hostPath: TEST_BUILDERS_TEST,
        mountAt: "/workspace",
      },
    };

    await assert.rejects(
      async () => {
        await backend.create(spec);
      },
      (err: unknown) => {
        assert.ok(err instanceof NetworkPolicyRequiredError);
        assert.equal((err as NetworkPolicyRequiredError).code, "NETWORK_POLICY_REQUIRED");
        assert.ok(err.message.includes("No network policy registered"));
        return true;
      }
    );

    // Assert that no docker create command was executed
    assert.equal(calls.length, 0, "No docker command should be executed when policy is missing");
  });

  it("refuses create when spec has a runId without a registered policy", async () => {
    const { runner, calls } = createFakeRunner();
    const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

    const spec: SandboxSpec = {
      idempotencyKey: "box-unregistered-run-1",
      image: PINNED_TEST_IMAGE,
      labels: {
        "git-graveyard.run-id": "run-unregistered-999",
      },
      workspace: {
        mode: "bind",
        hostPath: TEST_BUILDERS_TEST,
        mountAt: "/workspace",
      },
    };

    await assert.rejects(
      async () => {
        await backend.create(spec);
      },
      (err: unknown) => {
        assert.ok(err instanceof NetworkPolicyRequiredError);
        assert.equal((err as NetworkPolicyRequiredError).code, "NETWORK_POLICY_REQUIRED");
        assert.equal((err as NetworkPolicyRequiredError).runId, "run-unregistered-999");
        assert.ok(err.message.includes("run-unregistered-999"));
        return true;
      }
    );

    assert.equal(calls.length, 0, "Docker create must not run without registered policy");
  });

  it("refuses create when backend options has networkPolicy with a different runId", async () => {
    const { runner, calls } = createFakeRunner();
    const policyA = buildRunNetworkPolicy("run-A");
    const backend = new InstaboxDockerBackend({ runner, networkPolicy: policyA, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

    const spec: SandboxSpec = {
      idempotencyKey: "box-mismatched-run-1",
      image: PINNED_TEST_IMAGE,
      labels: {
        "git-graveyard.run-id": "run-B",
      },
      workspace: {
        mode: "bind",
        hostPath: TEST_BUILDERS_TEST,
        mountAt: "/workspace",
      },
    };

    await assert.rejects(
      async () => {
        await backend.create(spec);
      },
      (err: unknown) => {
        assert.ok(err instanceof NetworkPolicyRequiredError);
        assert.equal((err as NetworkPolicyRequiredError).runId, "run-B");
        return true;
      }
    );

    assert.equal(calls.length, 0);
  });
});

describe("F06c: Argv of create with registered policy (Requirement 21.1 to 21.9, 43.8, 43.11)", () => {
  it("provisions container with exact hardening flags, internal network and proxy args", async () => {
    const runId = `run-create-test-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

      const spec: SandboxSpec = {
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: {
          "git-graveyard.run-id": runId,
          "git-graveyard.box-role": "runbox",
        },
        resources: {
          cpus: 2,
          memoryMiB: 2048,
          pids: 256,
          diskMiB: 1024,
        },
        workspace: {
          mode: "bind",
          hostPath: TEST_BUILDERS_PROJECT,
          mountAt: "/workspace",
        },
      };

      const sandbox: InstaboxDockerSandbox = await backend.create(spec);
      assert.ok(sandbox);
      assert.equal(sandbox.id, "c-sandbox-test-12345");

      assert.equal(calls.length, 1);
      const createArgv = calls[0].argv;

      // Assert docker create command
      assert.equal(createArgv[0], "create");

      // Hardening requirements
      assert.ok(createArgv.includes("--cap-drop=ALL"), "Must drop all capabilities (Req 21.2)");
      assert.ok(createArgv.includes("--read-only"), "Must enforce read-only root (Req 21.4)");
      assert.ok(createArgv.includes("--security-opt"), "Must configure security options");
      const secOptIdx = createArgv.indexOf("--security-opt");
      assert.equal(createArgv[secOptIdx + 1], "no-new-privileges", "Must set no-new-privileges (Req 21.2)");

      // Scratch space tmpfs with disk limit
      assert.ok(createArgv.includes("--tmpfs"), "Must configure tmpfs (Req 21.4)");
      const tmpfsIdx = createArgv.indexOf("--tmpfs");
      assert.equal(createArgv[tmpfsIdx + 1], "/tmp:size=1024m");

      // Non-root user
      assert.ok(createArgv.includes("--user"), "Must specify non-root user (Req 21.3)");
      const userIdx = createArgv.indexOf("--user");
      assert.equal(createArgv[userIdx + 1], "1000:1000");

      // Resource limits
      assert.ok(createArgv.includes("--cpus"));
      assert.ok(createArgv.includes("--memory"));
      assert.ok(createArgv.includes("--pids-limit"));

      // Network: must attach to dedicated internal network, never default bridge
      assert.ok(createArgv.includes("--network"), "Must attach to internal network");
      const netIdx = createArgv.indexOf("--network");
      assert.equal(createArgv[netIdx + 1], policy.networkName, "Network must match policy network name");
      assert.notEqual(createArgv[netIdx + 1], "bridge", "Must never attach to default bridge network");

      // Proxy environment
      assert.ok(createArgv.includes(`HTTP_PROXY=${policy.proxyUrl}`));
      assert.ok(createArgv.includes(`HTTPS_PROXY=${policy.proxyUrl}`));

      // Bind mount with --mount type=bind (no -v)
      assert.ok(createArgv.includes("--mount"), "Must use --mount for bind mounts");
      const mountIdx = createArgv.indexOf("--mount");
      assert.equal(
        createArgv[mountIdx + 1],
        `type=bind,source=${TEST_BUILDERS_PROJECT},target=/workspace`
      );
      assert.ok(!createArgv.includes("-v"), "Must not use -v for bind mount");

      // Image must be pinned digest
      assert.ok(createArgv.includes(PINNED_TEST_IMAGE), "Must use pinned digest image (Req 21.1)");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });
});

describe("F06c: Real docker exec and run execution (no stubs, no fake success)", () => {
  it("Sandbox.run calls DockerExecStream with request argv, cwd and returns real exitCode 0", async () => {
    const runId = `run-exec-0-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-real-box-1\n" };
        }
        if (argv[0] === "exec" && argv.includes("echo")) {
          return {
            exitCode: 0,
            stdout: "hello real world\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: InstaboxDockerSandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      const result: HardenedExecResult = await sandbox.run({
        argv: ["echo", "hello"],
        cwd: "/workspace",
        timeoutMs: 60000,
        logRef: "log-test-run-0",
      });

      // Verify real exit code and outputs
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.oomKilled, false);
      assert.equal(result.logRef, "log-test-run-0");
      assert.ok(result.stdoutTail.includes("hello real world"));
      assert.equal(result.stderrTail, "");

      // Assert the argv sent to docker runner
      const execCall = calls.find(
        (c) => c.argv[0] === "exec" && c.argv.includes("echo")
      );
      assert.ok(execCall, "Must execute docker exec for run");
      // Every command is wrapped as ['setsid', '-w', 'sh', '-c', SCRIPT, ...argv]
      // so it runs in its own real process group (R6-A1).
      assert.deepEqual(execCall?.argv, [
        "exec",
        "-w",
        "/workspace",
        "-u",
        "1000:1000",
        "c-real-box-1",
        "setsid",
        "-w",
        "sh",
        "-c",
        COMMAND_GROUP_SCRIPT,
        "echo",
        "hello",
      ]);
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Sandbox.run propagates non-zero exit code (exitCode 42) and stderr without fake success", async () => {
    const runId = `run-exec-err-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-fail-box-2\n" };
        }
        if (argv[0] === "exec" && argv.includes("pytest")) {
          return {
            exitCode: 42,
            stdout: "1 passed, 3 failed\n",
            stderr: "AssertionError: expected true but got false\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: InstaboxDockerSandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      const result: HardenedExecResult = await sandbox.run({
        argv: ["pytest", "-v"],
        cwd: "/workspace",
        timeoutMs: 60000,
      });

      // Assert exit code 42 is preserved (NEVER fake exit code 0)
      assert.equal(result.exitCode, 42, "Must propagate real exit code 42");
      assert.equal(result.timedOut, false);
      assert.equal(result.oomKilled, false);
      assert.ok(result.stdoutTail.includes("1 passed, 3 failed"));
      assert.ok(result.stderrTail.includes("AssertionError"));

      const execCall = calls.find(
        (c) => c.argv[0] === "exec" && c.argv.includes("pytest")
      );
      assert.ok(execCall);
      assert.deepEqual(execCall?.argv, [
        "exec",
        "-w",
        "/workspace",
        "-u",
        "1000:1000",
        "c-fail-box-2",
        "setsid",
        "-w",
        "sh",
        "-c",
        COMMAND_GROUP_SCRIPT,
        "pytest",
        "-v",
      ]);
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Sandbox.exec returns streaming ExecProcess with real exit code and chunks", async () => {
    const runId = `run-stream-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv, options) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-stream-box-3\n" };
        }
        if (argv[0] === "exec" && argv.includes("npm")) {
          // Stream output via callbacks if provided
          options?.onStdout?.("line 1\n");
          options?.onStdout?.("line 2\n");
          options?.onStderr?.("warning text\n");
          return {
            exitCode: 1,
            stdout: "line 1\nline 2\n",
            stderr: "warning text\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: InstaboxDockerSandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      const proc: DockerExecProcess = await sandbox.exec({
        argv: ["npm", "test"],
        cwd: "/workspace",
        timeoutMs: 60000,
      });

      assert.ok(proc);
      assert.ok(proc.output);

      const status = await proc.wait();
      assert.equal(status.exitCode, 1, "Exit code must propagate through wait()");
      assert.equal(status.timedOut, false);
      assert.equal(status.oomKilled, false);

      const execCall = calls.find(
        (c) => c.argv[0] === "exec" && c.argv.includes("npm")
      );
      assert.ok(execCall);
      assert.deepEqual(execCall?.argv, [
        "exec",
        "-w",
        "/workspace",
        "-u",
        "1000:1000",
        "c-stream-box-3",
        "setsid",
        "-w",
        "sh",
        "-c",
        COMMAND_GROUP_SCRIPT,
        "npm",
        "test",
      ]);
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Sandbox required lifecycle members wait, stop, destroy execute expected commands", async () => {
    const runId = `run-lifecycle-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-lifecycle-box\n" };
        }
        if (argv[0] === "wait") {
          return { exitCode: 0, stdout: "0\n" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: Sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      // Sandbox wait
      const waitResult = await sandbox.wait();
      assert.equal(waitResult.exitCode, 0);
      assert.equal(waitResult.timedOut, false);
      assert.equal(waitResult.oomKilled, false);

      // Sandbox stop
      await sandbox.stop();
      const stopCall = calls.find((c) => c.argv[0] === "stop");
      assert.ok(stopCall);
      assert.equal(stopCall?.argv[1], "c-lifecycle-box");

      // Sandbox destroy
      await sandbox.destroy();
      const rmCall = calls.find((c) => c.argv[0] === "rm");
      assert.ok(rmCall);
      assert.ok(rmCall?.argv.includes("c-lifecycle-box"));
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });
});

describe("F06c: Timeout and OOM handling in exec and run", () => {
  it("detects timeout and propagates timedOut: true with exitCode 124", async () => {
    const runId = `run-timeout-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner((argv) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-timeout-box\n" };
        }
        if (argv[0] === "exec" && argv.includes("sleep")) {
          return {
            exitCode: 124,
            timedOut: true,
            stdout: "",
            stderr: "command timed out after 50ms\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: InstaboxDockerSandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      const result: HardenedExecResult = await sandbox.run({
        argv: ["sleep", "10"],
        timeoutMs: 50,
      });

      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, 124);
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("detects oomKilled from runner result or output pattern", async () => {
    const runId = `run-oom-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner((argv) => {
        if (argv[0] === "create") {
          return { exitCode: 0, stdout: "c-oom-box\n" };
        }
        if (argv[0] === "exec" && argv.includes("stress")) {
          return {
            exitCode: 137,
            oomKilled: true,
            stdout: "",
            stderr: "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: InstaboxDockerSandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      const result: HardenedExecResult = await sandbox.run({
        argv: ["stress", "mem"],
        timeoutMs: 60000,
      });

      assert.equal(result.oomKilled, true);
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });
});

describe("F06c: Unsupported v1 operations throw NotInV1Error (code NOT_IN_V1)", () => {
  it("throws NotInV1Error when snapshot is called on Sandbox", async () => {
    const runId = `run-unsupp-1-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: InstaboxDockerSandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      await assert.rejects(
        async () => {
          await (sandbox as unknown as { snapshot: () => Promise<unknown> }).snapshot();
        },
        (err: unknown) => {
          assert.ok(err instanceof NotInV1Error);
          assert.equal((err as NotInV1Error).code, "NOT_IN_V1");
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("throws NotInV1Error when syncIn or syncOut is called on Sandbox", async () => {
    const runId = `run-unsupp-2-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: InstaboxDockerSandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      await assert.rejects(
        async () => {
          await (sandbox as unknown as { syncIn: () => Promise<unknown> }).syncIn();
        },
        (err: unknown) => {
          assert.ok(err instanceof NotInV1Error);
          assert.equal((err as NotInV1Error).code, "NOT_IN_V1");
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await (sandbox as unknown as { syncOut: () => Promise<unknown> }).syncOut();
        },
        (err: unknown) => {
          assert.ok(err instanceof NotInV1Error);
          assert.equal((err as NotInV1Error).code, "NOT_IN_V1");
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("throws NotInV1Error when snapshot is called on InstaboxDockerBackend", async () => {
    const { runner } = createFakeRunner();
    const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

    await assert.rejects(
      async () => {
        await (backend as unknown as { snapshot: () => Promise<unknown> }).snapshot();
      },
      (err: unknown) => {
        assert.ok(err instanceof NotInV1Error);
        assert.equal((err as NotInV1Error).code, "NOT_IN_V1");
        return true;
      }
    );
  });

  it("throws NotInV1Error when create is called with workspace mode sync", async () => {
    const runId = `run-sync-mode-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            workspace: { mode: "sync", mountAt: "/workspace" },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof NotInV1Error);
          assert.equal((err as NotInV1Error).code, "NOT_IN_V1");
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("DockerCloudSandboxStub throws NotInV1Error for all operations", async () => {
    const stub = new DockerCloudSandboxStub();
    assert.equal(stub.kind, "docker-cloud-sandbox");

    await assert.rejects(
      async () => stub.create({ idempotencyKey: "k" }),
      (err: unknown) => (err as NotInV1Error).code === "NOT_IN_V1"
    );
    await assert.rejects(
      async () => stub.get("box-1"),
      (err: unknown) => (err as NotInV1Error).code === "NOT_IN_V1"
    );
    await assert.rejects(
      async () => stub.list(),
      (err: unknown) => (err as NotInV1Error).code === "NOT_IN_V1"
    );
    await assert.rejects(
      async () => stub.destroy("box-1"),
      (err: unknown) => (err as NotInV1Error).code === "NOT_IN_V1"
    );
    await assert.rejects(
      async () => stub.snapshot("box-1"),
      (err: unknown) => (err as NotInV1Error).code === "NOT_IN_V1"
    );
    await assert.rejects(
      async () => stub.syncIn(),
      (err: unknown) => (err as NotInV1Error).code === "NOT_IN_V1"
    );
    await assert.rejects(
      async () => stub.syncOut(),
      (err: unknown) => (err as NotInV1Error).code === "NOT_IN_V1"
    );
  });
});

describe("F07: Rule 1 - User hardening in docker exec (Requirements 21.3, 43.7)", () => {
  it("docker exec always runs as non-root user from the sandbox spec", async () => {
    const runId = `run-user-spec-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv) => {
        if (argv[0] === "create") return { exitCode: 0, stdout: "c-user-box\n" };
        if (argv[0] === "exec") return { exitCode: 0, stdout: "ok\n" };
        return { exitCode: 0, stdout: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        user: { uid: 1050, gid: 1050 },
        resources: { diskMiB: 512 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      await sandbox.run({ argv: ["id"], timeoutMs: 60000 });

      const execCall = calls.find((c) => c.argv[0] === "exec" && c.argv.includes("id"));
      assert.ok(execCall, "Exec call must be recorded");
      const uIdx = execCall.argv.indexOf("-u");
      assert.notEqual(uIdx, -1, "-u flag must be present in docker exec");
      assert.equal(execCall.argv[uIdx + 1], "1050:1050", "Must use non-root user from spec");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("refuses caller-supplied user of 0 or root in exec request", async () => {
    const runId = `run-user-refuse-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      // User 0 in request
      await assert.rejects(
        async () => {
          await sandbox.run({
            argv: ["whoami"],
            timeoutMs: 60000,
            user: 0,
          } as ExecRequest);
        },
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          assert.equal((err as SpecValidationError).code, "SPEC_VALIDATION_ERROR");
          return true;
        }
      );

      // User "root" in request
      await assert.rejects(
        async () => {
          await sandbox.run({
            argv: ["whoami"],
            timeoutMs: 60000,
            user: "root",
          } as ExecRequest);
        },
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          assert.equal((err as SpecValidationError).code, "SPEC_VALIDATION_ERROR");
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("removes path that sets -u from request (caller non-root user ignored in favor of spec user)", async () => {
    const runId = `run-user-ignore-req-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv) => {
        if (argv[0] === "create") return { exitCode: 0, stdout: "c-user-ign-box\n" };
        if (argv[0] === "exec") return { exitCode: 0, stdout: "ok\n" };
        return { exitCode: 0, stdout: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        user: { uid: 1234, gid: 1234 },
        resources: { diskMiB: 512 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      // Caller attempts to pass non-root user 9999 in request
      await sandbox.run({
        argv: ["id"],
        timeoutMs: 60000,
        user: 9999,
      } as ExecRequest);

      const execCall = calls.find((c) => c.argv[0] === "exec" && c.argv.includes("id"));
      assert.ok(execCall);
      const uIdx = execCall.argv.indexOf("-u");
      assert.notEqual(uIdx, -1);
      assert.equal(execCall.argv[uIdx + 1], "1234:1234", "Must use spec user 1234:1234, never request user 9999");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("refuses caller-supplied user of 0 or root in sandbox spec", async () => {
    const { runner } = createFakeRunner();
    const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

    await assert.rejects(
      async () => {
        await backend.create({
          idempotencyKey: "box-root-user",
          image: PINNED_TEST_IMAGE,
          user: { uid: 0, gid: 0 },
          resources: { diskMiB: 512 },
          workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecValidationError);
        return true;
      }
    );
  });
});

describe("F07: Rule 2 - Environment allow-list and secret denylist (Requirements 21.5, 43.4)", () => {
  it("only names listed in the sandbox spec env allow-list are passed with -e", async () => {
    const runId = `run-env-allow-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv) => {
        if (argv[0] === "create") return { exitCode: 0, stdout: "c-env-box\n" };
        if (argv[0] === "exec") return { exitCode: 0, stdout: "ok\n" };
        return { exitCode: 0, stdout: "" };
      });

      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
        env: {
          ALLOWED_VAR_A: "default_a",
          ALLOWED_VAR_B: "default_b",
        },
      });

      // Request passes ALLOWED_VAR_A (in allow-list) and UNLISTED_VAR (not in allow-list)
      await sandbox.run({
        argv: ["env"],
        timeoutMs: 60000,
        env: {
          ALLOWED_VAR_A: "custom_a",
          UNLISTED_VAR: "should_be_dropped",
        },
      });

      const execCall = calls.find((c) => c.argv[0] === "exec" && c.argv.includes("env"));
      assert.ok(execCall);

      // Verify ALLOWED_VAR_A is passed with -e
      assert.ok(execCall.argv.includes("-e"), "Must have -e flag");
      assert.ok(execCall.argv.includes("ALLOWED_VAR_A=custom_a"), "ALLOWED_VAR_A must be passed");
      // Verify UNLISTED_VAR is NOT passed with -e
      assert.ok(!execCall.argv.includes("UNLISTED_VAR=should_be_dropped"), "Unlisted variable must not be passed");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("refuses any env name containing KIRO, GITHUB, TOKEN, SECRET, KEY, PASSWORD or CREDENTIAL", async () => {
    const runId = `run-env-forbidden-names-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      const forbiddenNames = [
        "MY_KIRO_CONFIG",
        "GITHUB_REPO",
        "APP_TOKEN_VALUE",
        "SHARED_SECRET_VAR",
        "AUTH_KEY_DATA",
        "USER_PASSWORD",
        "AWS_CREDENTIAL_STORE",
      ];

      for (const name of forbiddenNames) {
        await assert.rejects(
          async () => {
            await sandbox.run({
              argv: ["echo", "test"],
              timeoutMs: 60000,
              env: { [name]: "some_value" },
            });
          },
          (err: unknown) => {
            assert.ok(err instanceof SpecValidationError, `Expected SpecValidationError for env name ${name}`);
            assert.equal((err as SpecValidationError).code, "SPEC_VALIDATION_ERROR");
            return true;
          }
        );
      }
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("refuses any env value starting with ksk_, ghp_ or ghs_", async () => {
    const runId = `run-env-forbidden-values-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      const forbiddenValues = [
        "ksk_live_token_12345",
        "ghp_personal_access_token",
        "ghs_server_session_key",
      ];

      for (const val of forbiddenValues) {
        await assert.rejects(
          async () => {
            await sandbox.run({
              argv: ["echo", "test"],
              timeoutMs: 60000,
              env: { TEST_VAR: val },
            });
          },
          (err: unknown) => {
            assert.ok(err instanceof SpecValidationError, `Expected SpecValidationError for env value ${val}`);
            assert.equal((err as SpecValidationError).code, "SPEC_VALIDATION_ERROR");
            return true;
          }
        );
      }
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("refuses forbidden names or values in spec.env during box creation", async () => {
    const { runner } = createFakeRunner();
    const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

    await assert.rejects(
      async () => {
        await backend.create({
          idempotencyKey: "box-secret-env-name",
          image: PINNED_TEST_IMAGE,
          resources: { diskMiB: 512 },
          workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
          env: { GITHUB_API_URL: "https://api.github.com" },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecValidationError);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await backend.create({
          idempotencyKey: "box-secret-env-val",
          image: PINNED_TEST_IMAGE,
          resources: { diskMiB: 512 },
          workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
          env: { FOO: "ghs_session_123" },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecValidationError);
        return true;
      }
    );
  });
});

describe("F07: Rule 3 - Host paths realpath, no colons, --mount type=bind, mountAt prefix (Requirements 21.6, 43.10)", () => {
  it("resolves hostPath with fs.realpathSync before checking builders/warden boundary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f07-realpath-"));
    try {
      const buildersDir = path.join(tmpDir, "builders", "proj");
      fs.mkdirSync(buildersDir, { recursive: true });

      const outsideDir = path.join(tmpDir, "forbidden_escape");
      fs.mkdirSync(outsideDir, { recursive: true });

      // Create a symlink inside builders that points to forbidden outsideDir
      const symlinkEscape = path.join(buildersDir, "symlink_escape");
      fs.symlinkSync(outsideDir, symlinkEscape);

      // Attempting to mount symlink_escape resolves to outsideDir (not under builders) -> MUST throw
      assert.throws(
        () => validateMountPath(symlinkEscape, "runbox"),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.equal((err as MountSecurityError).code, "MOUNT_SECURITY_ERROR");
          return true;
        }
      );

      // Create a symlink inside builders that points to a real directory inside builders
      const validTarget = path.join(buildersDir, "real_code");
      fs.mkdirSync(validTarget, { recursive: true });
      const validSymlink = path.join(buildersDir, "symlink_valid");
      fs.symlinkSync(validTarget, validSymlink);

      // Valid symlink inside builders should pass
      assert.doesNotThrow(() => validateMountPath(validSymlink, "runbox"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses any hostPath that contains a colon", () => {
    assert.throws(
      () => validateMountPath("/work/builders/proj:ro", "runbox"),
      (err: unknown) => {
        assert.ok(err instanceof MountSecurityError);
        assert.equal((err as MountSecurityError).code, "MOUNT_SECURITY_ERROR");
        assert.ok(err.message.includes("colon"));
        return true;
      }
    );

    assert.throws(
      () => validateMountPath("/work/builders/test:evil", "runbox"),
      (err: unknown) => {
        assert.ok(err instanceof MountSecurityError);
        assert.ok(err.message.includes("colon"));
        return true;
      }
    );
  });

  it("refuses any mountAt that contains a colon", () => {
    assert.throws(
      () => validateMountAt("/workspace:ro"),
      (err: unknown) => {
        assert.ok(err instanceof MountSecurityError);
        assert.ok(err.message.includes("colon"));
        return true;
      }
    );
  });

  it("refuses a mountAt outside the allowed container prefix /workspace", () => {
    const invalidMountAts = [
      "/etc",
      "/root",
      "/home",
      "/tmp",
      "/var/run",
      "/workspaces",
      "/workspace_escaped",
      "/workspace/../etc",
    ];

    for (const target of invalidMountAts) {
      assert.throws(
        () => validateMountAt(target),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError, `Expected MountSecurityError for mountAt ${target}`);
          assert.equal((err as MountSecurityError).code, "MOUNT_SECURITY_ERROR");
          return true;
        }
      );
    }

    // Valid mount targets
    assert.doesNotThrow(() => validateMountAt("/workspace"));
    assert.doesNotThrow(() => validateMountAt("/workspace/"));
    assert.doesNotThrow(() => validateMountAt("/workspace/repo"));
  });

  it("uses --mount type=bind instead of -v with exact source, target, and readonly", async () => {
    const runId = `run-mount-bind-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

      await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 512 },
        workspace: {
          mode: "bind",
          hostPath: TEST_BUILDERS_MY_REPO,
          mountAt: "/workspace",
          readOnly: true,
        },
      });

      assert.equal(calls.length, 1);
      const argv = calls[0].argv;

      assert.ok(!argv.includes("-v"), "Must not use -v flag");
      assert.ok(argv.includes("--mount"), "Must use --mount flag");
      const idx = argv.indexOf("--mount");
      assert.equal(
        argv[idx + 1],
        `type=bind,source=${TEST_BUILDERS_MY_REPO},target=/workspace,readonly`
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });
});

describe("F07: Rule 4 - tmpfs size limit from spec disk limit (Requirement 21.4)", () => {
  it("creates tmpfs mount with exact size limit from spec disk limit", async () => {
    const runId = `run-tmpfs-limit-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

      await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: {
          diskMiB: 2048,
        },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      assert.equal(calls.length, 1);
      const argv = calls[0].argv;
      const tmpfsIdx = argv.indexOf("--tmpfs");
      assert.notEqual(tmpfsIdx, -1, "--tmpfs must be present");
      assert.equal(argv[tmpfsIdx + 1], "/tmp:size=2048m", "tmpfs size must match spec diskMiB");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("refuses creation when spec disk limit is missing", async () => {
    const runId = `run-tmpfs-missing-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

      await assert.rejects(
        async () => {
          await backend.create({
            idempotencyKey: `idemp-${runId}`,
            image: PINNED_TEST_IMAGE,
            labels: { "git-graveyard.run-id": runId },
            resources: {
              cpus: 2,
              memoryMiB: 1024,
            },
            workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof SpecValidationError);
          assert.equal((err as SpecValidationError).code, "SPEC_VALIDATION_ERROR");
          assert.ok(err.message.includes("Disk limit is required"));
          return true;
        }
      );

      assert.equal(calls.length, 0, "No docker command executed when disk limit missing");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });
});

describe("F07: Rule 5 - Docker CLI explicit minimal environment", () => {
  it("provides explicit minimal environment with only PATH and LANG, never inheriting process.env", () => {
    // Set simulated sensitive host variables in process.env
    const oldSecret = process.env.KIRO_API_KEY;
    const oldGithub = process.env.GITHUB_TOKEN;
    const oldDockerHost = process.env.DOCKER_HOST;

    try {
      process.env.KIRO_API_KEY = "ksk_host_leak_attempt";
      process.env.GITHUB_TOKEN = "ghp_host_leak_attempt";
      process.env.DOCKER_HOST = "tcp://unauthorized-host:2375";

      const minimalEnv = getMinimalDockerEnv();

      // Explicit minimal environment
      assert.ok(typeof minimalEnv.PATH === "string" && minimalEnv.PATH.length > 0, "PATH must be present");
      assert.ok(typeof minimalEnv.LANG === "string" && minimalEnv.LANG.length > 0, "LANG must be present");

      // Must NOT inherit process.env
      assert.equal(minimalEnv.KIRO_API_KEY, undefined, "Must not inherit KIRO_API_KEY");
      assert.equal(minimalEnv.GITHUB_TOKEN, undefined, "Must not inherit GITHUB_TOKEN");

      // DOCKER_HOST must not be inherited from host process.env when spec does not name it
      assert.equal(minimalEnv.DOCKER_HOST, undefined, "Must not inherit DOCKER_HOST when spec does not name it");
    } finally {
      if (oldSecret !== undefined) process.env.KIRO_API_KEY = oldSecret; else delete process.env.KIRO_API_KEY;
      if (oldGithub !== undefined) process.env.GITHUB_TOKEN = oldGithub; else delete process.env.GITHUB_TOKEN;
      if (oldDockerHost !== undefined) process.env.DOCKER_HOST = oldDockerHost; else delete process.env.DOCKER_HOST;
    }
  });

  it("includes DOCKER_HOST only when the spec names it", () => {
    const envWithNamedHost = getMinimalDockerEnv({
      spec: {
        dockerHost: "tcp://spec-named-host:2375",
      },
    });

    assert.equal(envWithNamedHost.DOCKER_HOST, "tcp://spec-named-host:2375");

    const envWithSpecEnvHost = getMinimalDockerEnv({
      spec: {
        env: { DOCKER_HOST: "unix:///var/run/custom.sock" },
      },
    });

    assert.equal(envWithSpecEnvHost.DOCKER_HOST, "unix:///var/run/custom.sock");

    const envWithoutNamedHost = getMinimalDockerEnv({
      spec: {},
    });

    assert.equal(envWithoutNamedHost.DOCKER_HOST, undefined);
  });
});

describe("G02c: Execution backend rework - rules 1 through 8", () => {
  it("Rule 1: Sandbox members exec, run, wait, stop, destroy are required, create returns required Sandbox", async () => {
    const runId = `run-g02c-r1-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox: Sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      assert.equal(typeof sandbox.exec, "function");
      assert.equal(typeof sandbox.run, "function");
      assert.equal(typeof sandbox.wait, "function");
      assert.equal(typeof sandbox.stop, "function");
      assert.equal(typeof sandbox.destroy, "function");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Rule 2: process exit code that is null, missing or non-integer is an error result, never 0", async () => {
    const runId = `run-g02c-r2-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      // 1. Runner returning null exitCode
      const { runner: runnerNull } = createFakeRunner((argv) => {
        if (argv[0] === "exec") {
          return { exitCode: null as unknown as number, stdout: "out", stderr: "err" };
        }
        return { exitCode: 0, stdout: "c-null\n" };
      });
      const backendNull = new InstaboxDockerBackend({ runner: runnerNull, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandboxNull = await backendNull.create({
        idempotencyKey: `idemp-null-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });
      // A null exit code throws the infrastructure error; it is never mapped
      // to exit 0 or exit 1 (R6-A1).
      await assert.rejects(
        async () => {
          await sandboxNull.run({ argv: ["test"], timeoutMs: 60000 });
        },
        (err: unknown) => {
          assert.ok(err instanceof RunnerExitCodeError, "Null exit code throws RunnerExitCodeError");
          assert.ok((err as Error).message.includes("integer exit code"));
          return true;
        }
      );

      // 2. Runner returning missing/undefined exitCode
      const { runner: runnerUndefined } = createFakeRunner((argv) => {
        if (argv[0] === "exec") {
          return { stdout: "out", stderr: "err" } as DockerRunnerResult;
        }
        return { exitCode: 0, stdout: "c-undef\n" };
      });
      const backendUndef = new InstaboxDockerBackend({ runner: runnerUndefined, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandboxUndef = await backendUndef.create({
        idempotencyKey: `idemp-undef-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });
      // A missing exit code throws the infrastructure error; it is never
      // mapped to exit 0 or exit 1 (R6-A1).
      await assert.rejects(
        async () => {
          await sandboxUndef.run({ argv: ["test"], timeoutMs: 60000 });
        },
        (err: unknown) => {
          assert.ok(err instanceof RunnerExitCodeError, "Missing exit code throws RunnerExitCodeError");
          assert.ok((err as Error).message.includes("integer exit code"));
          return true;
        }
      );

      // 3. Runner returning non-integer exit code
      const { runner: runnerFloat } = createFakeRunner((argv) => {
        if (argv[0] === "exec") {
          return { exitCode: 1.5, stdout: "out", stderr: "err" };
        }
        return { exitCode: 0, stdout: "c-float\n" };
      });
      const backendFloat = new InstaboxDockerBackend({ runner: runnerFloat, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandboxFloat = await backendFloat.create({
        idempotencyKey: `idemp-float-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });
      // A non-integer exit code throws the infrastructure error; it is never
      // mapped to exit 0 or exit 1 (R6-A1).
      await assert.rejects(
        async () => {
          await sandboxFloat.run({ argv: ["test"], timeoutMs: 60000 });
        },
        (err: unknown) => {
          assert.ok(err instanceof RunnerExitCodeError, "Non-integer exit code throws RunnerExitCodeError");
          assert.ok((err as Error).message.includes("integer exit code"));
          return true;
        }
      );
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Rule 3: timeoutMs must be positive integer not above spec maximum, zero/neg/non-finite refused, timer always set", async () => {
    const runId = `run-g02c-r3-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      let passedTimeout: number | undefined;
      const { runner } = createFakeRunner((argv, options) => {
        if (argv[0] === "exec" && argv.includes("echo")) {
          passedTimeout = options?.timeoutMs;
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "c-timeout\n" };
      });
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        lifetime: { ttlMs: 15000 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      // Refuse zero
      await assert.rejects(
        () => sandbox.run({ argv: ["echo", "hi"], timeoutMs: 0 }),
        (err: unknown) => err instanceof SpecValidationError
      );

      // Refuse negative
      await assert.rejects(
        () => sandbox.run({ argv: ["echo", "hi"], timeoutMs: -100 }),
        (err: unknown) => err instanceof SpecValidationError
      );

      // Refuse non-finite
      await assert.rejects(
        () => sandbox.run({ argv: ["echo", "hi"], timeoutMs: Infinity }),
        (err: unknown) => err instanceof SpecValidationError
      );
      await assert.rejects(
        () => sandbox.run({ argv: ["echo", "hi"], timeoutMs: NaN }),
        (err: unknown) => err instanceof SpecValidationError
      );

      // Refuse non-integer
      await assert.rejects(
        () => sandbox.run({ argv: ["echo", "hi"], timeoutMs: 12.34 }),
        (err: unknown) => err instanceof SpecValidationError
      );

      // Refuse above spec maximum
      await assert.rejects(
        () => sandbox.run({ argv: ["echo", "hi"], timeoutMs: 20000 }),
        (err: unknown) => err instanceof SpecValidationError
      );

      // Valid timeout within limit sets the timer and passes timeout to runner
      const res = await sandbox.run({ argv: ["echo", "hi"], timeoutMs: 5000 });
      assert.equal(res.exitCode, 0);
      assert.equal(passedTimeout, 5000, "Timer options timeoutMs must be set");

      // Default timeout within spec limit is set
      await sandbox.run({ argv: ["echo", "hi"], timeoutMs: 5000 });
      assert.ok(typeof passedTimeout === "number" && passedTimeout > 0, "Timer is always set even when omitted");
      assert.ok(passedTimeout <= 15000, "Default timeout respects spec max");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Rule 4: when command ends, kills only command process group, never container user processes", async () => {
    const runId = `run-g02c-r4-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner((argv) => {
        if (argv[0] === "exec" && argv.includes("ps")) {
          return { exitCode: 0, stdout: "10 100 1000 node\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      });
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      await sandbox.run({ argv: ["node", "-v"], timeoutMs: 60000 });

      // Check all docker commands executed
      const pkillCalls = calls.filter((c) => c.argv.includes("pkill"));
      assert.equal(pkillCalls.length, 0, "Must not execute pkill on container user when command ends");

      const killAllUserCalls = calls.filter(
        (c) => c.argv.includes("kill") && c.argv.includes("-1")
      );
      assert.equal(killAllUserCalls.length, 0, "Must not execute kill -9 -1 on container user");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Rule 5: docker exec -w receives container path (mountAt), host execFile cwd is host path", async () => {
    const runId = `run-g02c-r5-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    try {
      const { runner, calls } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });
      const sandbox = await backend.create({
        idempotencyKey: `idemp-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: TEST_BUILDERS_P, mountAt: "/workspace" },
      });

      // 1. Request with container path /workspace
      await sandbox.run({ argv: ["pwd"], cwd: "/workspace", timeoutMs: 60000 });
      const execCall1 = calls.find((c) => c.argv[0] === "exec" && c.argv.includes("pwd"));
      assert.ok(execCall1);
      const wIdx1 = execCall1.argv.indexOf("-w");
      assert.equal(execCall1.argv[wIdx1 + 1], "/workspace", "docker exec -w receives container path /workspace");
      assert.equal(execCall1.options?.cwd, TEST_BUILDERS_P, "host execFile cwd is host path");

      // 2. Request without explicit cwd (defaults to workspace)
      calls.length = 0;
      await sandbox.run({ argv: ["git", "status"], timeoutMs: 60000 });
      const execCall2 = calls.find((c) => c.argv[0] === "exec" && c.argv.includes("status"));
      assert.ok(execCall2);
      const wIdx2 = execCall2.argv.indexOf("-w");
      assert.equal(execCall2.argv[wIdx2 + 1], "/workspace", "docker exec -w receives mountAt /workspace");
      assert.equal(execCall2.options?.cwd, TEST_BUILDERS_P, "host execFile cwd is host path");
    } finally {
      releaseRunNetworkPolicy(runId);
    }
  });

  it("Rule 6: mount argument uses realpath result, realpath failure refused, commas/colons refused", async () => {
    const runId = `run-g02c-r6-${Date.now()}`;
    const policy = buildRunNetworkPolicy(runId);
    registerRunNetworkPolicy(policy);

    const tmpSuite = fs.mkdtempSync(path.join(os.tmpdir(), "graveyard-rule6-"));
    const realDir = path.join(tmpSuite, "builders", "real_repo");
    fs.mkdirSync(realDir, { recursive: true });
    const canonicalRealDir = fs.realpathSync(realDir);

    const symlinkDir = path.join(tmpSuite, "builders", "symlink_repo");
    fs.symlinkSync(canonicalRealDir, symlinkDir);

    try {
      const { runner, calls } = createFakeRunner();
      const backend = new InstaboxDockerBackend({ runner, settings: { maxTimeoutMs: 60000, housekeepingTimeoutMs: 5000 } });

      // 1. Mount uses realpath result, not raw hostPath (symlink)
      await backend.create({
        idempotencyKey: `idemp-r6-${runId}`,
        image: PINNED_TEST_IMAGE,
        labels: { "git-graveyard.run-id": runId },
        resources: { diskMiB: 1024 },
        workspace: { mode: "bind", hostPath: symlinkDir, mountAt: "/workspace" },
      });

      const createCall = calls.find((c) => c.argv[0] === "create");
      assert.ok(createCall);
      const mountIdx = createCall.argv.indexOf("--mount");
      assert.equal(
        createCall.argv[mountIdx + 1],
        `type=bind,source=${canonicalRealDir},target=/workspace`
      );

      // 2. Realpath failure refused (no path.resolve fallback)
      assert.throws(
        () => validateMountPath("/nonexistent/builders/does_not_exist", "runbox"),
        (err: unknown) => {
          assert.ok(err instanceof MountSecurityError);
          assert.equal((err as MountSecurityError).code, "MOUNT_SECURITY_ERROR");
          return true;
        }
      );

      // 3. Colons and commas refused in host path
      assert.throws(
        () => validateMountPath("/tmp/builders/has,comma", "runbox"),
        (err: unknown) => err instanceof MountSecurityError
      );
      assert.throws(
        () => validateMountPath("/tmp/builders/has:colon", "runbox"),
        (err: unknown) => err instanceof MountSecurityError
      );
    } finally {
      releaseRunNetworkPolicy(runId);
      fs.rmSync(tmpSuite, { recursive: true, force: true });
    }
  });

  it("Rule 7: isRootUser refuses root:root, any uid 0, and the name root", () => {
    // String forms
    assert.equal(isRootUser("root:root"), true, "root:root must be refused");
    assert.equal(isRootUser("root"), true, "root must be refused");
    assert.equal(isRootUser("root:1000"), true, "root:1000 must be refused");
    assert.equal(isRootUser("0"), true, "0 must be refused");
    assert.equal(isRootUser("0:0"), true, "0:0 must be refused");
    assert.equal(isRootUser("0:1000"), true, "0:1000 must be refused");

    // Number forms
    assert.equal(isRootUser(0), true, "number 0 must be refused");

    // Object forms
    assert.equal(isRootUser({ uid: 0 }), true, "{ uid: 0 } must be refused");
    assert.equal(isRootUser({ uid: "0" }), true, "{ uid: '0' } must be refused");
    assert.equal(isRootUser({ name: "root" }), true, "{ name: 'root' } must be refused");
    assert.equal(isRootUser({ user: "root" }), true, "{ user: 'root' } must be refused");
    assert.equal(isRootUser({ user: 0 }), true, "{ user: 0 } must be refused");

    // Valid non-root users
    assert.equal(isRootUser("1000:1000"), false);
    assert.equal(isRootUser(1000), false);
    assert.equal(isRootUser({ uid: 1000, gid: 1000 }), false);
    assert.equal(isRootUser("node:node"), false);
  });

  it("Rule 8: secret value prefixes include gho_, ghu_, ghr_, github_pat_ alongside ksk_, ghp_, ghs_", () => {
    // Array export checks
    assert.ok(FORBIDDEN_ENV_VALUE_PREFIXES.includes("gho_" as any));
    assert.ok(FORBIDDEN_ENV_VALUE_PREFIXES.includes("ghu_" as any));
    assert.ok(FORBIDDEN_ENV_VALUE_PREFIXES.includes("ghr_" as any));
    assert.ok(FORBIDDEN_ENV_VALUE_PREFIXES.includes("github_pat_" as any));
    assert.ok(FORBIDDEN_ENV_VALUE_PREFIXES.includes("ksk_" as any));
    assert.ok(FORBIDDEN_ENV_VALUE_PREFIXES.includes("ghp_" as any));
    assert.ok(FORBIDDEN_ENV_VALUE_PREFIXES.includes("ghs_" as any));

    // Function checks
    assert.equal(isForbiddenEnvValue("gho_oauth_token_123"), true);
    assert.equal(isForbiddenEnvValue("ghu_user_token_456"), true);
    assert.equal(isForbiddenEnvValue("ghr_refresh_token_789"), true);
    assert.equal(isForbiddenEnvValue("github_pat_personal_access_token"), true);
    assert.equal(isForbiddenEnvValue("ksk_kiro_secret"), true);
    assert.equal(isForbiddenEnvValue("ghp_github_personal"), true);
    assert.equal(isForbiddenEnvValue("ghs_github_server"), true);

    // Non-secret values
    assert.equal(isForbiddenEnvValue("production"), false);
    assert.equal(isForbiddenEnvValue("allowed_custom_value"), false);
  });
});
