import assert from "node:assert/strict";
import test, { describe } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExecutionBackend,
  ExecProcess,
  ExecRequest,
  ExecResult,
  Sandbox,
  SandboxSpec,
} from "../../lib/backend/types";
import type { EventInput } from "../../lib/events/event-store";
import {
  ExhumerHarness,
  RunnerRequiredError,
  runExhumerHarness,
  type CommandExecutionResult,
} from "../../lib/exhume/exhume-harness";
import { NO_TESTS_FOUND_LABEL, NO_TESTS_FOUND_RULE_ID } from "../../lib/exhume/types";
import { resolveDiskLimit } from "../../lib/backend/instabox-docker-backend";
import {
  getRunNetworkPolicy,
  releaseRunNetworkPolicy,
} from "../../lib/backend/network-policy";

/**
 * Creates a mock ExecutionBackend for testing Box provisioning (Requirement 11.4).
 */
function createMockExecutionBackend(): {
  backend: ExecutionBackend;
  createdSpecs: SandboxSpec[];
  sandboxes: Map<string, Sandbox>;
} {
  const createdSpecs: SandboxSpec[] = [];
  const sandboxes = new Map<string, Sandbox>();

  const backend: ExecutionBackend = {
    async create(spec: SandboxSpec): Promise<Sandbox> {
      createdSpecs.push(spec);
      const sandbox: Sandbox = {
        id: spec.idempotencyKey,
        async run(req: ExecRequest): Promise<ExecResult> {
          return {
            logRef:
              typeof req.logRef === "string"
                ? req.logRef
                : `log-${spec.idempotencyKey}`,
            exitCode: 0,
            oomKilled: false,
            timedOut: false,
            stdoutTail: "ok",
            stderrTail: "",
          };
        },
        async exec(req: ExecRequest): Promise<ExecProcess> {
          return {
            async wait() {
              return { exitCode: 0, timedOut: false, oomKilled: false };
            },
          };
        },
        async wait() {
          return { exitCode: 0, timedOut: false, oomKilled: false };
        },
        async stop() {},
        async destroy() {},
      };
      sandboxes.set(spec.idempotencyKey, sandbox);
      return sandbox;
    },
  };

  return { backend, createdSpecs, sandboxes };
}

describe("exhume-harness: box provisioning (Requirement 11.4)", () => {
  test("provisions one Runbox and one Auditbox via ExecutionBackend", async () => {
    const { backend, createdSpecs } = createMockExecutionBackend();
    const recordedEvents: EventInput[] = [];

    const executedCommands: string[][] = [];
    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      executedCommands.push(argv);
      return { exitCode: 0, stdout: "1.0.0" };
    };

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-box-"));
    const buildersDir = path.join(tmpBase, "builders", "base");
    const wardenDir = path.join(tmpBase, "warden");
    fs.mkdirSync(buildersDir, { recursive: true });
    fs.mkdirSync(wardenDir, { recursive: true });

    try {
      const result = await runExhumerHarness({
        runId: "run-box-01",
        baseSha: "sha123456",
        backend,
        runner: mockRunner,
        events: recordedEvents,
        bindPath: buildersDir,
        wardenBindPath: wardenDir,
        wallClockTimeoutMs: 60000,
        packageJson: {
          name: "test-pkg",
          scripts: {
            build: "echo build",
            test: "echo test",
          },
        },
        files: ["package.json", "package-lock.json"],
      });

      assert.equal(createdSpecs.length, 2);
      const runboxSpec = createdSpecs.find((s) => s.labels?.role === "runbox");
      const auditboxSpec = createdSpecs.find((s) => s.labels?.role === "auditbox");

      assert.ok(runboxSpec);
      assert.ok(auditboxSpec);
      assert.equal(runboxSpec?.idempotencyKey, "runbox-run-box-01");
      assert.equal(auditboxSpec?.idempotencyKey, "auditbox-run-box-01");
      assert.ok(result.runbox);
      assert.ok(result.auditbox);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("exhume-harness: baseline execution and npm rules (Requirements 11.5, 11.6, 20.13)", () => {
  test("runs version commands, install, build, and test without model calls", async () => {
    const executedCommands: string[][] = [];
    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      executedCommands.push(argv);
      return { exitCode: 0, stdout: "ok" };
    };

    const recordedEvents: EventInput[] = [];

    const result = await runExhumerHarness({
      runId: "run-node-01",
      baseSha: "sha-node-01",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      events: recordedEvents,
      packageJson: {
        name: "node-repo",
        scripts: {
          build: "webpack --mode production",
          test: "jest",
        },
      },
      files: ["package.json", "package-lock.json"],
    });

    assert.equal(result.healthy, true);
    assert.equal(result.deathCertificate.healthy, true);
    assert.equal(result.deathCertificate.primaryLanguage, "node");

    // Check version commands were run
    assert.ok(executedCommands.some((c) => c[0] === "node" && c[1] === "--version"));
    assert.ok(executedCommands.some((c) => c[0] === "npm" && c[1] === "--version"));

    // Check npm install passed --ignore-scripts (Requirement 11.6, 20.13)
    const installCall = executedCommands.find(
      (c) => c[0] === "npm" && (c[1] === "ci" || c[1] === "install")
    );
    assert.ok(installCall);
    assert.ok(installCall.includes("--ignore-scripts"));

    // Check build and test commands
    assert.ok(executedCommands.some((c) => c[0] === "npm" && c[1] === "run" && c[2] === "build"));
    assert.ok(executedCommands.some((c) => c[0] === "npm" && c[1] === "test"));

    // Verify events were emitted (Requirement 11.16)
    const startedEvents = recordedEvents.filter((e) => e.kind === "command.started");
    const resultEvents = recordedEvents.filter((e) => e.kind === "command.result");
    assert.ok(startedEvents.length >= 4);
    assert.ok(resultEvents.length >= 4);

    // Verify exhume.certificate event (Requirement 11.13)
    const certEvent = recordedEvents.find((e) => e.kind === "exhume.certificate");
    assert.ok(certEvent);
  });

  test("forces --ignore-scripts onto npm install even if omitted from custom config (Requirement 11.6)", async () => {
    const executedCommands: string[][] = [];
    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      executedCommands.push(argv);
      return { exitCode: 0 };
    };

    const harness = new ExhumerHarness({
      runId: "run-ignore-scripts",
      baseSha: "sha-is-01",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
    });

    await harness.executeInRunbox(["npm", "install", "lodash"], "install");

    assert.equal(executedCommands.length, 1);
    assert.ok(executedCommands[0].includes("--ignore-scripts"));
  });
});

describe("exhume-harness: Python package manager selection (Requirement 11.7)", () => {
  test("executes poetry install when poetry.lock is detected", async () => {
    const executedCommands: string[][] = [];
    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      executedCommands.push(argv);
      return { exitCode: 0 };
    };

    const result = await runExhumerHarness({
      runId: "run-py-poetry",
      baseSha: "sha-py-01",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      files: ["pyproject.toml", "poetry.lock", "tests/test_basic.py"],
      pyprojectToml: "[tool.poetry]\nname = 'py-app'",
    });

    assert.equal(result.manifestInspection.packageManager, "poetry");
    assert.ok(executedCommands.some((c) => c[0] === "poetry" && c[1] === "install"));
  });

  test("executes pip install when requirements.txt is detected", async () => {
    const executedCommands: string[][] = [];
    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      executedCommands.push(argv);
      return { exitCode: 0 };
    };

    const result = await runExhumerHarness({
      runId: "run-py-pip",
      baseSha: "sha-py-02",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      files: ["requirements.txt", "setup.py", "tests/test_main.py"],
      setupPy: "from setuptools import setup\nsetup(name='sample')",
    });

    assert.equal(result.manifestInspection.packageManager, "pip");
    assert.ok(executedCommands.some((c) => c[0] === "pip" && c[1] === "install"));
  });
});

describe("exhume-harness: install retry and failure behavior (Requirement 11.8)", () => {
  test("executes retry when initial install fails, and continues if retry succeeds", async () => {
    const executedCommands: string[][] = [];
    let callCount = 0;

    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      executedCommands.push(argv);
      const isInstall = argv[0] === "npm" && (argv[1] === "ci" || argv[1] === "install");
      if (isInstall) {
        callCount++;
        if (callCount === 1) {
          // First attempt (npm ci) fails
          return { exitCode: 1, stderr: "npm ci failed due to missing package-lock" };
        }
        // Second attempt (npm install retry) succeeds
        return { exitCode: 0, stdout: "install succeeded" };
      }
      return { exitCode: 0 };
    };

    const result = await runExhumerHarness({
      runId: "run-retry-ok",
      baseSha: "sha-retry-01",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      packageJson: {
        name: "retry-repo",
        scripts: {
          build: "tsc",
          test: "vitest run",
        },
      },
      files: ["package.json", "package-lock.json"],
    });

    assert.equal(result.deathCertificate.install.status, "failed");
    assert.equal(result.deathCertificate.retry?.status, "passed");
    assert.equal(result.deathCertificate.build.status, "passed");
    assert.equal(result.deathCertificate.test.status, "passed");
  });

  test("marks build and tests as not run when install and retry both fail (Requirement 11.8)", async () => {
    const executedCommands: string[][] = [];
    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      executedCommands.push(argv);
      const isInstall = argv[0] === "npm" && (argv[1] === "ci" || argv[1] === "install");
      if (isInstall) {
        return { exitCode: 1, stderr: "npm ERR! ERESOLVE unable to resolve dependency tree" };
      }
      return { exitCode: 0 };
    };

    const result = await runExhumerHarness({
      runId: "run-retry-fail",
      baseSha: "sha-retry-02",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      packageJson: {
        name: "broken-deps-repo",
        scripts: {
          build: "npm run build-all",
          test: "jest",
        },
      },
      files: ["package.json", "package-lock.json"],
    });

    assert.equal(result.deathCertificate.install.status, "failed");
    assert.equal(result.deathCertificate.retry?.status, "failed");
    assert.equal(result.deathCertificate.build.status, "not run");
    assert.equal(
      result.deathCertificate.build.reason,
      "install failed and install retry failed"
    );
    assert.equal(result.deathCertificate.test.status, "not run");
    assert.equal(
      result.deathCertificate.test.reason,
      "install failed and install retry failed"
    );

    // Build and test commands should NOT have been executed
    assert.ok(!executedCommands.some((c) => c[0] === "npm" && c[2] === "build-all"));
    assert.ok(!executedCommands.some((c) => c[0] === "npm" && c[1] === "test"));
  });
});

describe("exhume-harness: build script absence (Requirement 11.9)", () => {
  test("marks build not run with reason when no build script exists", async () => {
    const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });

    const result = await runExhumerHarness({
      runId: "run-no-build",
      baseSha: "sha-nb-01",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      packageJson: {
        name: "no-build-script",
        scripts: {
          test: "mocha",
        },
      },
      files: ["package.json"],
    });

    assert.equal(result.deathCertificate.build.status, "not run");
    assert.equal(result.deathCertificate.build.reason, "no build script");
    assert.equal(result.deathCertificate.test.status, "passed");
  });
});

describe("exhume-harness: no tests found rule M13 (Requirement 11.10)", () => {
  test("records No tests found with M13 when scripts.test is missing in Node", async () => {
    const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });

    const result = await runExhumerHarness({
      runId: "run-no-test-node",
      baseSha: "sha-nt-01",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      packageJson: {
        name: "untested-node",
        scripts: {
          build: "tsc",
        },
      },
      files: ["package.json"],
    });

    assert.equal(result.deathCertificate.test.status, NO_TESTS_FOUND_LABEL);
    assert.equal(result.deathCertificate.test.ruleId, NO_TESTS_FOUND_RULE_ID);
    assert.equal(result.deathCertificate.test.noTestsFound, true);
    assert.ok(result.deathCertificate.failureClasses.includes("no_tests"));
  });

  test("records No tests found with M13 when scripts.test is default placeholder", async () => {
    const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });

    const result = await runExhumerHarness({
      runId: "run-placeholder-test",
      baseSha: "sha-nt-02",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      packageJson: {
        name: "placeholder-repo",
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
        },
      },
      files: ["package.json"],
    });

    assert.equal(result.deathCertificate.test.status, NO_TESTS_FOUND_LABEL);
    assert.equal(result.deathCertificate.test.ruleId, NO_TESTS_FOUND_RULE_ID);
    assert.equal(result.deathCertificate.test.noTestsFound, true);
  });

  test("records No tests found with M13 when Python pytest returns exit code 5", async () => {
    const mockRunner = async (argv: string[]): Promise<CommandExecutionResult> => {
      if (argv[0] === "pytest") {
        return { exitCode: 5, stdout: "collected 0 items" };
      }
      return { exitCode: 0 };
    };

    const result = await runExhumerHarness({
      runId: "run-py-collect-5",
      baseSha: "sha-py-5",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      files: ["setup.py", "tests/test_empty.py"],
      setupPy: "from setuptools import setup\nsetup(name='test')",
    });

    assert.equal(result.deathCertificate.test.status, NO_TESTS_FOUND_LABEL);
    assert.equal(result.deathCertificate.test.ruleId, NO_TESTS_FOUND_RULE_ID);
    assert.equal(result.deathCertificate.test.noTestsFound, true);
    assert.ok(result.deathCertificate.failureClasses.includes("no_tests"));
  });
});

describe("exhume-harness: wall-clock timeout cap (Requirement 11.14)", () => {
  test("retains completed rows and marks unreached rows as not run with reason time limit", async () => {
    let call = 0;
    const mockRunner = async (): Promise<CommandExecutionResult> => {
      call++;
      if (call <= 2) {
        // version commands succeed quickly
        return { exitCode: 0, stdout: "1.0.0" };
      }
      // install takes longer and exceeds wall clock timeout
      await new Promise((r) => setTimeout(r, 60));
      return { exitCode: 0, stdout: "done" };
    };

    const result = await runExhumerHarness({
      runId: "run-timeout-01",
      baseSha: "sha-time-01",
      runner: mockRunner,
      wallClockTimeoutMs: 30, // 30ms wall-clock cap
      packageJson: {
        name: "slow-repo",
        scripts: {
          build: "echo build",
          test: "echo test",
        },
      },
      files: ["package.json"],
    });

    assert.equal(result.wallClockTimeoutHit, true);

    // Version commands completed
    assert.ok(result.deathCertificate.runtimes.length >= 1);

    // Build and test rows were not reached and are marked "not run" with "time limit"
    assert.equal(result.deathCertificate.build.status, "not run");
    assert.equal(result.deathCertificate.build.reason, "time limit");
    assert.equal(result.deathCertificate.test.status, "not run");
    assert.equal(result.deathCertificate.test.reason, "time limit");

    // Failure classification notes time limit
    assert.ok(result.deathCertificate.failureClasses.includes("time_limit"));
  });
});

describe("exhume-harness: host execution prohibition (Requirements 19.6, 42.1)", () => {
  test("refuses construction without an injected runner or execution backend", () => {
    assert.throws(
      () =>
        new ExhumerHarness({
          runId: "run-no-runner",
          baseSha: "sha-no-runner",
        }),
      (err: unknown) => {
        assert.ok(err instanceof RunnerRequiredError);
        assert.match((err as Error).message, /runner/i);
        assert.match((err as Error).message, /prohibited/i);
        return true;
      }
    );
  });

  test("refuses a run without an injected runner or execution backend", async () => {
    await assert.rejects(
      async () =>
        runExhumerHarness({
          runId: "run-no-runner-run",
          baseSha: "sha-no-runner-run",
        }),
      (err: unknown) => {
        assert.ok(err instanceof RunnerRequiredError);
        assert.match((err as Error).message, /runner/i);
        assert.match((err as Error).message, /prohibited/i);
        return true;
      }
    );
  });

  test("refuses direct executeInRunbox call without a runner", async () => {
    const dummyBackend: ExecutionBackend = {
      async create() {
        return undefined as unknown as Sandbox;
      },
    };
    const harness = new ExhumerHarness({
      runId: "run-no-box",
      baseSha: "sha-no-box",
      backend: dummyBackend,
      wallClockTimeoutMs: 60000,
    });
    await assert.rejects(
      async () => harness.executeInRunbox(["npm", "test"], "test"),
      (err: unknown) => {
        assert.ok(err instanceof RunnerRequiredError);
        assert.match((err as Error).message, /runner/i);
        return true;
      }
    );
  });
});

describe("exhume-harness: InstaboxDockerBackend wiring and SandboxSpec validation", () => {
  test("populates InstaboxDockerBackend-compatible SandboxSpec with valid resolveDiskLimit", async () => {
    const createdSpecs: SandboxSpec[] = [];
    const instaboxBackend: ExecutionBackend = {
      kind: "instabox-docker",
      async create(spec: SandboxSpec): Promise<Sandbox> {
        createdSpecs.push(spec);
        return {
          id: spec.idempotencyKey,
          run: async () => ({ exitCode: 0, oomKilled: false, timedOut: false, logRef: "test-log" }),
          exec: async () => ({ wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }) }),
          wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }),
          stop: async () => {},
          destroy: async () => {},
        };
      },
    };

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-instabox-"));
    const buildersDir = path.join(tmpBase, "builders", "base");
    const wardenDir = path.join(tmpBase, "warden");
    fs.mkdirSync(buildersDir, { recursive: true });
    fs.mkdirSync(wardenDir, { recursive: true });

    try {
      const harness = new ExhumerHarness({
        runId: "run-instabox-01",
        baseSha: "sha-instabox-01",
        backend: instaboxBackend,
        bindPath: buildersDir,
        wardenBindPath: wardenDir,
        wallClockTimeoutMs: 45000,
        boxImage: "test-image@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });

      await harness.provisionBoxes();

      assert.equal(createdSpecs.length, 2);
      const runboxSpec = createdSpecs.find((s) => s.labels?.role === "runbox");
      const auditboxSpec = createdSpecs.find((s) => s.labels?.role === "auditbox");

      assert.ok(runboxSpec);
      assert.ok(auditboxSpec);

      // Verify resolveDiskLimit succeeds
      const runboxDisk = resolveDiskLimit(runboxSpec);
      const auditboxDisk = resolveDiskLimit(auditboxSpec);
      assert.equal(runboxDisk, "2048m");
      assert.equal(auditboxDisk, "2048m");

      // Verify settings and image
      assert.equal((runboxSpec.settings as any)?.maxTimeoutMs, 45000);
      assert.equal((runboxSpec.settings as any)?.housekeepingTimeoutMs, 60000);
      assert.equal(runboxSpec.image, "test-image@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("supports custom diskMiB and settings overrides", async () => {
    const createdSpecs: SandboxSpec[] = [];
    const instaboxBackend: ExecutionBackend = {
      kind: "instabox-docker",
      async create(spec: SandboxSpec): Promise<Sandbox> {
        createdSpecs.push(spec);
        return {
          id: spec.idempotencyKey,
          run: async () => ({ exitCode: 0, oomKilled: false, timedOut: false, logRef: "test-log" }),
          exec: async () => ({ wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }) }),
          wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }),
          stop: async () => {},
          destroy: async () => {},
        };
      },
    };

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-custom-disk-"));
    const buildersDir = path.join(tmpBase, "builders", "base");
    const wardenDir = path.join(tmpBase, "warden");
    fs.mkdirSync(buildersDir, { recursive: true });
    fs.mkdirSync(wardenDir, { recursive: true });

    try {
      const harness = new ExhumerHarness({
        runId: "run-custom-01",
        baseSha: "sha-custom-01",
        backend: instaboxBackend,
        bindPath: buildersDir,
        wardenBindPath: wardenDir,
        wallClockTimeoutMs: 30000,
        diskMiB: 4096,
        settings: {
          maxTimeoutMs: 30000,
          housekeepingTimeoutMs: 45000,
          customFlag: true,
        },
      });

      await harness.provisionBoxes();

      const runboxSpec = createdSpecs.find((s) => s.labels?.role === "runbox");
      assert.ok(runboxSpec);
      assert.equal(resolveDiskLimit(runboxSpec), "4096m");
      assert.equal((runboxSpec.settings as any)?.customFlag, true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("exhume-harness: Per-run network policy registration for instabox-docker", () => {
  test("registers immutable run network policy idempotently when backend.kind is instabox-docker", async () => {
    const runId = "run-netpol-test-01";
    releaseRunNetworkPolicy(runId);

    const instaboxBackend: ExecutionBackend = {
      kind: "instabox-docker",
      async create(spec: SandboxSpec): Promise<Sandbox> {
        return {
          id: spec.idempotencyKey,
          run: async () => ({ exitCode: 0, oomKilled: false, timedOut: false, logRef: "test-log" }),
          exec: async () => ({ wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }) }),
          wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }),
          stop: async () => {},
          destroy: async () => {},
        };
      },
    };

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-netpol-"));
    const buildersDir = path.join(tmpBase, "builders", "base");
    const wardenDir = path.join(tmpBase, "warden");
    fs.mkdirSync(buildersDir, { recursive: true });
    fs.mkdirSync(wardenDir, { recursive: true });

    try {
      assert.equal(getRunNetworkPolicy(runId), undefined);

      const harness = new ExhumerHarness({
        runId,
        baseSha: "sha-netpol-01",
        backend: instaboxBackend,
        bindPath: buildersDir,
        wardenBindPath: wardenDir,
        wallClockTimeoutMs: 60000,
      });

      await harness.provisionBoxes();

      const pol1 = getRunNetworkPolicy(runId);
      assert.ok(pol1);
      assert.equal(pol1.runId, runId);
      assert.equal(pol1.defaultEgress, "deny");

      // Idempotent call
      await harness.provisionBoxes();
      const pol2 = getRunNetworkPolicy(runId);
      assert.equal(pol1, pol2);
    } finally {
      releaseRunNetworkPolicy(runId);
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("does not register network policy when ensureNetworkPolicy is false", async () => {
    const runId = "run-no-netpol-01";
    releaseRunNetworkPolicy(runId);

    const instaboxBackend: ExecutionBackend = {
      kind: "instabox-docker",
      async create(spec: SandboxSpec): Promise<Sandbox> {
        return {
          id: spec.idempotencyKey,
          run: async () => ({ exitCode: 0, oomKilled: false, timedOut: false, logRef: "test-log" }),
          exec: async () => ({ wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }) }),
          wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }),
          stop: async () => {},
          destroy: async () => {},
        };
      },
    };

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-no-netpol-"));
    const buildersDir = path.join(tmpBase, "builders", "base");
    const wardenDir = path.join(tmpBase, "warden");
    fs.mkdirSync(buildersDir, { recursive: true });
    fs.mkdirSync(wardenDir, { recursive: true });

    try {
      const harness = new ExhumerHarness({
        runId,
        baseSha: "sha-no-netpol-01",
        backend: instaboxBackend,
        bindPath: buildersDir,
        wardenBindPath: wardenDir,
        wallClockTimeoutMs: 60000,
        ensureNetworkPolicy: false,
      });

      await harness.provisionBoxes();
      assert.equal(getRunNetworkPolicy(runId), undefined);
    } finally {
      releaseRunNetworkPolicy(runId);
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("exhume-harness: Triage session forwarding (supervisor, sessionClient, synthesizer, logs)", () => {
  test("forwards supervisor, synthesizer, sessionClient, and logs into triage session", async () => {
    let synthesizerCalled = false;
    let receivedPrompt = "";

    const mockRunner = async (): Promise<CommandExecutionResult> => ({
      exitCode: 1,
      stderr: "Error: Cannot find module 'express'",
    });

    const result = await runExhumerHarness({
      runId: "run-triage-forward",
      baseSha: "sha-triage-forward",
      runner: mockRunner,
      wallClockTimeoutMs: 60000,
      enableTriageSession: true,
      logs: {
        "step:install": "npm ERR! 404 Not Found express",
      },
      supervisor: {
        getVerifiedModel: () => "claude-haiku-5.5",
        getVerifiedAgent: () => "exhumer",
      },
      synthesizer: async (prompt) => {
        synthesizerCalled = true;
        receivedPrompt = prompt;
        return {
          failureClasses: ["dependency_not_found"],
          summary: "Custom synthesized death certificate summary",
        };
      },
      packageJson: {
        name: "test-pkg",
        scripts: { test: "exit 1" },
      },
      files: ["package.json"],
    });

    assert.equal(synthesizerCalled, true);
    assert.ok(receivedPrompt.length > 0);
    assert.ok(result.deathCertificate.failureClasses.includes("dependency_not_found"));
    assert.equal(result.deathCertificate.summary, "Custom synthesized death certificate summary");
  });
});

