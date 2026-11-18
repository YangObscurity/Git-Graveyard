import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
  SAFE_IDENTIFIER_REGEX,
  isPathInside,
  RequiredSettingError,
} from "../../lib/supervisor/skeleton-supervisor";
import { CLAUDE_OPUS_5_5_MODEL_ID } from "../../lib/supervisor/model-allowlist";
import type {
  ChildProcessLike,
  GatewayEventSource,
  GatewayFatalEventPayload,
  SkeletonSupervisorEvent,
  SpawnFunction,
} from "../../lib/supervisor/types";
import { getRequiredBrokerSettings } from "./fixtures";
import { MalformedRequestError } from "../../lib/broker/permission-broker";

class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 9999;
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalsSent: string[] = [];

  public kill(signal?: NodeJS.Signals | number | string): boolean {
    this.killed = true;
    this.signalsSent.push(String(signal ?? "SIGTERM"));
    return true;
  }
}

class FakeGateway implements GatewayEventSource {
  public fatalHandlers: Array<(payload: GatewayFatalEventPayload) => void> = [];

  public on(
    event: string,
    handler: (payload: GatewayFatalEventPayload) => void
  ): void {
    if (event === "fatal") {
      this.fatalHandlers.push(handler);
    }
  }

  public off(
    event: string,
    handler: (payload: GatewayFatalEventPayload) => void
  ): void {
    this.fatalHandlers = this.fatalHandlers.filter((h) => h !== handler);
  }

  public emitFatal(payload: GatewayFatalEventPayload): void {
    for (const handler of [...this.fatalHandlers]) {
      handler(payload);
    }
  }
}

function attachMockAcpAgent(child: MockChildProcess): void {
  let stdinBuffer = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    stdinBuffer += chunk.toString("utf-8");
    let newlineIndex = stdinBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            child.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  agentCapabilities: {
                    streaming: true,
                    _meta: { kiro: { extensionMethods: ["_session/steer"] } },
                  },
                  extensionMethods: ["_session/steer"],
                  mcpCapabilities: { http: true },
                },
              }) + "\n"
            );
          } else if (msg.method === "session/new") {
            child.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  sessionId: "sess-rb4-planner",
                  modeId: "planner",
                  configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
                },
              }) + "\n"
            );
          } else {
            child.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n"
            );
          }
        } catch {}
      }
      newlineIndex = stdinBuffer.indexOf("\n");
    }
  });
}

interface RB4Fixture {
  supervisor: SkeletonSupervisor;
  child: MockChildProcess;
  gateway: FakeGateway;
  events: SkeletonSupervisorEvent[];
  worktreeDir: string;
  quarantineDir: string;
  baseDir: string;
}

function buildRaisedSupervisor(): RB4Fixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-sup-"));
  const worktreeDir = path.join(baseDir, "wt");
  const quarantineDir = path.join(baseDir, "quarantine");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "task.md"), "sample task", "utf-8");

  const child = new MockChildProcess();
  attachMockAcpAgent(child);
  const mockSpawn: SpawnFunction = () => child;
  const gateway = new FakeGateway();
  const events: SkeletonSupervisorEvent[] = [];

  const supervisor = createSkeletonSupervisor({
    runId: "run-rb4",
    skeletonId: "skel-rb4-planner",
    role: "planner",
    cwd: worktreeDir,
    quarantineDir,
    watchdogLimitMs: 5000,
    cancelGracePeriodMs: 5000,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: mockSpawn,
    gateway,
    onEvent: (event) => {
      events.push(event);
    },
  });

  return {
    supervisor,
    child,
    gateway,
    events,
    worktreeDir,
    quarantineDir,
    baseDir,
  };
}

async function withRaisedFixture(
  run: (fixture: RB4Fixture) => Promise<void>
): Promise<void> {
  const fixture = buildRaisedSupervisor();
  try {
    await fixture.supervisor.raise();
    await run(fixture);
  } finally {
    await fixture.supervisor.finish();
    fs.rmSync(fixture.baseDir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Work package RB4: second-round B-audit fixes", () => {
  describe("N-B16: SAFE_IDENTIFIER_REGEX", () => {
    it("matches valid identifiers", () => {
      assert.equal(SAFE_IDENTIFIER_REGEX.test("planner"), true);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("skel-1"), true);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("run_2026.01-01"), true);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("a"), true);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("A123_.-"), true);
    });

    it("rejects path traversal, slashes, null bytes, and leading dashes", () => {
      assert.equal(SAFE_IDENTIFIER_REGEX.test(".."), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("../escape"), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("/abs/path"), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("foo/bar"), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("foo\\bar"), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("foo\0bar"), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("-leading-dash"), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test(".hidden"), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test(""), false);
      assert.equal(SAFE_IDENTIFIER_REGEX.test("   "), false);
    });
  });

  describe("N-B16: skeletonId and runId constructor validation", () => {
    it("rejects invalid skeletonId with RequiredSettingError", () => {
      const badIds = ["..", "../etc", "/root", "a/b", "a\\b", "a\0b", "-dash", ".dot", ""];
      for (const badId of badIds) {
        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: "run-valid",
              skeletonId: badId,
              role: "planner",
              cwd: "/tmp",
              quarantineDir: "/tmp/quarantine-test",
              watchdogLimitMs: 5000,
              cancelGracePeriodMs: 5000,
              brokerOptions: getRequiredBrokerSettings(),
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            return true;
          },
          `Expected bad skeletonId "${badId}" to throw RequiredSettingError`
        );
      }
    });

    it("rejects invalid non-empty runId with RequiredSettingError", () => {
      const badRuns = ["..", "../run", "/run", "run/sub", "run\\sub", "run\0x", "-run", ".run"];
      for (const badRun of badRuns) {
        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: badRun,
              skeletonId: "skel-valid",
              role: "planner",
              cwd: "/tmp",
              quarantineDir: "/tmp/quarantine-test",
              watchdogLimitMs: 5000,
              cancelGracePeriodMs: 5000,
              brokerOptions: getRequiredBrokerSettings(),
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            return true;
          },
          `Expected bad runId "${badRun}" to throw RequiredSettingError`
        );
      }
    });

    it("rejects empty string runId with RequiredSettingError", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "",
            skeletonId: "skel-valid",
            role: "planner",
            cwd: "/tmp/worktree",
            quarantineDir: "/tmp/quarantine-test",
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
            brokerOptions: getRequiredBrokerSettings(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          assert.match((err as Error).message, /runId must match SAFE_IDENTIFIER_REGEX/i);
          return true;
        }
      );

      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "   ",
            skeletonId: "skel-valid",
            role: "planner",
            cwd: "/tmp/worktree",
            quarantineDir: "/tmp/quarantine-test",
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
            brokerOptions: getRequiredBrokerSettings(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          return true;
        }
      );
    });
  });

  describe("N-B16: handleFatalGatewayResult path traversal defense", () => {
    it("rejects corrupted skeletonId or runId before writing quarantine file", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-fatal-"));
      const worktreeDir = path.join(tmpBase, "wt");
      const quarantineDir = path.join(tmpBase, "quarantine");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.mkdirSync(quarantineDir, { recursive: true });
      try {
        const supervisor = createSkeletonSupervisor({
          runId: "run-ok",
          skeletonId: "skel-ok",
          role: "planner",
          cwd: worktreeDir,
          quarantineDir,
          watchdogLimitMs: 5000,
          cancelGracePeriodMs: 5000,
          brokerOptions: getRequiredBrokerSettings(),
        });

        (supervisor as any).skeletonId = "../../../escape";
        await assert.rejects(
          async () => supervisor.handleFatalGatewayResult({ status: "fatal" }),
          RequiredSettingError
        );

        (supervisor as any).skeletonId = "skel-ok";
        (supervisor as any).runId = "../../../escape-run";
        await assert.rejects(
          async () => supervisor.handleFatalGatewayResult({ status: "fatal" }),
          RequiredSettingError
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("N-B16: isPathInside and symlink quarantine defense", () => {
    it("detects and rejects symlink escaping allowedRoot", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-symlink-"));
      try {
        const allowedRoot = path.join(tmpBase, "allowed");
        const outsideDir = path.join(tmpBase, "outside");
        fs.mkdirSync(allowedRoot, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });

        const symlinkInRoot = path.join(allowedRoot, "quarantine-link");
        fs.symlinkSync(outsideDir, symlinkInRoot);

        assert.equal(
          isPathInside(allowedRoot, symlinkInRoot),
          false,
          "Symlink pointing outside allowedRoot must be rejected"
        );

        const nestedEscaping = path.join(symlinkInRoot, "leaf", "file.json");
        assert.equal(
          isPathInside(allowedRoot, nestedEscaping),
          false,
          "Non-existent leaf through escaping symlink must be rejected"
        );

        const brokenLink = path.join(allowedRoot, "broken-link");
        fs.symlinkSync(path.join(outsideDir, "nonexistent"), brokenLink);
        assert.equal(
          isPathInside(allowedRoot, brokenLink),
          false,
          "Broken symlink pointing outside allowedRoot must be rejected"
        );

        const normalFile = path.join(allowedRoot, "normal.json");
        fs.writeFileSync(normalFile, "{}");
        assert.equal(
          isPathInside(allowedRoot, normalFile),
          true,
          "Normal file inside allowedRoot must be accepted"
        );

        const normalNonExistent = path.join(allowedRoot, "deep", "nonexistent.json");
        assert.equal(
          isPathInside(allowedRoot, normalNonExistent),
          true,
          "Normal non-existent leaf inside allowedRoot must be accepted"
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("rejects symlinked quarantineDir escaping allowedRoot in constructor", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-cfg-"));
      try {
        const allowedRoot = path.join(tmpBase, "allowed");
        const outsideDir = path.join(tmpBase, "outside");
        const worktreeDir = path.join(allowedRoot, "worktree");
        fs.mkdirSync(worktreeDir, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });

        const symlinkedQuarantine = path.join(allowedRoot, "quarantine-symlink");
        fs.symlinkSync(outsideDir, symlinkedQuarantine);

        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: "run-cfg",
              skeletonId: "skel-cfg",
              role: "planner",
              cwd: worktreeDir,
              quarantineDir: symlinkedQuarantine,
              allowedRoot: allowedRoot,
              watchdogLimitMs: 5000,
              cancelGracePeriodMs: 5000,
              brokerOptions: getRequiredBrokerSettings(),
            } as any),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("rejects quarantineDir that symlinks into cwd", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-cwd-sym-"));
      try {
        const worktreeDir = path.join(tmpBase, "wt");
        const outsideDir = path.join(tmpBase, "outside");
        fs.mkdirSync(worktreeDir, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });

        const symlinkToCwd = path.join(outsideDir, "quarantine-symlink");
        fs.symlinkSync(worktreeDir, symlinkToCwd);

        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: "run-cwd-sym",
              skeletonId: "skel-cwd-sym",
              role: "planner",
              cwd: worktreeDir,
              quarantineDir: symlinkToCwd,
              watchdogLimitMs: 5000,
              cancelGracePeriodMs: 5000,
              brokerOptions: getRequiredBrokerSettings(),
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            assert.match((err as Error).message, /quarantineDir must be outside cwd/i);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("N-B10: strict skeletonId and runId scoping in handleGatewayFatalEvent", () => {
    it("does not quarantine when fatal event is for another skeletonId", async () => {
      await withRaisedFixture(async ({ supervisor, child, gateway, quarantineDir }) => {
        gateway.emitFatal({
          skeletonId: "skel-other",
          runId: "run-rb4",
          result: { status: "fatal", fatal: true, code: "SECRET_DETECTED" },
        });
        await sleep(50);
        assert.equal(supervisor.isWorktreeQuarantined(), false);
        assert.equal(supervisor.getState(), "raised");
        assert.deepEqual(fs.readdirSync(quarantineDir), []);
      });
    });

    it("does not quarantine when fatal event is missing skeletonId", async () => {
      await withRaisedFixture(async ({ supervisor, child, gateway, quarantineDir }) => {
        (supervisor as any).activeToolCalls = 2;
        gateway.emitFatal({
          runId: "run-rb4",
          result: { status: "fatal", fatal: true, code: "SECRET_DETECTED" },
        } as any);
        await sleep(50);
        assert.equal(supervisor.isWorktreeQuarantined(), false);
        assert.equal(supervisor.getState(), "raised");
        assert.deepEqual(fs.readdirSync(quarantineDir), []);
      });
    });

    it("does not quarantine when fatal event has mismatching runId", async () => {
      await withRaisedFixture(async ({ supervisor, child, gateway, quarantineDir }) => {
        gateway.emitFatal({
          skeletonId: "skel-rb4-planner",
          runId: "run-other",
          result: { status: "fatal", fatal: true, code: "SECRET_DETECTED" },
        });
        await sleep(50);
        assert.equal(supervisor.isWorktreeQuarantined(), false);
        assert.equal(supervisor.getState(), "raised");
        assert.deepEqual(fs.readdirSync(quarantineDir), []);
      });
    });

    it("does not quarantine when supervisor has runId but fatal event omits runId", async () => {
      await withRaisedFixture(async ({ supervisor, child, gateway, quarantineDir }) => {
        gateway.emitFatal({
          skeletonId: "skel-rb4-planner",
          result: { status: "fatal", fatal: true, code: "SECRET_DETECTED" },
        } as any);
        await sleep(50);
        assert.equal(supervisor.isWorktreeQuarantined(), false);
        assert.equal(supervisor.getState(), "raised");
        assert.deepEqual(fs.readdirSync(quarantineDir), []);
      });
    });

    it("quarantines when fatal event matches both skeletonId and runId", async () => {
      await withRaisedFixture(async ({ supervisor, child, gateway, quarantineDir }) => {
        gateway.emitFatal({
          skeletonId: "skel-rb4-planner",
          runId: "run-rb4",
          result: { status: "fatal", fatal: true, code: "SECRET_DETECTED" },
        });
        await sleep(50);
        assert.equal(supervisor.isWorktreeQuarantined(), true);
        assert.equal(supervisor.getState(), "terminated");
        assert.equal(supervisor.getFailureReason(), "quarantined");
        const files = fs.readdirSync(quarantineDir);
        assert.equal(files.length, 1);
      });
    });
  });

  describe("M-3 residual: timeoutMs alias removal and steer deadline", () => {
    it("rejects timeoutMs in options when cancelGracePeriodMs is omitted", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-m3",
            skeletonId: "skel-m3",
            role: "planner",
            cwd: "/tmp",
            quarantineDir: "/tmp/quarantine-m3",
            watchdogLimitMs: 5000,
            timeoutMs: 5000,
            brokerOptions: getRequiredBrokerSettings(),
          } as any),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          assert.match((err as Error).message, /cancelGracePeriodMs is required/i);
          return true;
        }
      );
    });

    it("rejects timeoutMs in settings when cancelGracePeriodMs is omitted", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-m3",
            skeletonId: "skel-m3",
            role: "planner",
            cwd: "/tmp",
            quarantineDir: "/tmp/quarantine-m3",
            watchdogLimitMs: 5000,
            settings: { timeoutMs: 5000 },
            brokerOptions: getRequiredBrokerSettings(),
          } as any),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          assert.match((err as Error).message, /cancelGracePeriodMs is required/i);
          return true;
        }
      );
    });

    it("steer uses requireCancelPromptTimeoutMs for tool wait deadline when fallback runs", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-steer-"));
      const worktreeDir = path.join(tmpBase, "wt");
      const quarantineDir = path.join(tmpBase, "quarantine");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.mkdirSync(quarantineDir, { recursive: true });

      const child = new MockChildProcess();
      let stdinBuffer = "";
      child.stdin.on("data", (chunk: Buffer | string) => {
        stdinBuffer += chunk.toString("utf-8");
        let newlineIndex = stdinBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = stdinBuffer.slice(0, newlineIndex).trim();
          stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            try {
              const msg = JSON.parse(line);
              if (msg.method === "initialize") {
                child.stdout.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                      agentCapabilities: { streaming: true },
                      extensionMethods: [],
                      mcpCapabilities: { http: true },
                    },
                  }) + "\n"
                );
              } else if (msg.method === "session/new") {
                child.stdout.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                      sessionId: "sess-no-steer",
                      modeId: "planner",
                      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
                    },
                  }) + "\n"
                );
              } else {
                child.stdout.write(
                  JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n"
                );
              }
            } catch {}
          }
          newlineIndex = stdinBuffer.indexOf("\n");
        }
      });

      const supervisor = createSkeletonSupervisor({
        runId: "run-steer-test",
        skeletonId: "skel-steer-test",
        role: "planner",
        cwd: worktreeDir,
        quarantineDir,
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        brokerOptions: getRequiredBrokerSettings(),
        spawnFn: () => child,
      });

      try {
        await supervisor.raise();
        (supervisor as any).activeToolCalls = 1;

        await assert.rejects(
          async () => supervisor.steer("fix issue"),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            assert.match((err as Error).message, /cancelPromptTimeoutMs is required/i);
            return true;
          }
        );
      } finally {
        await supervisor.finish();
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("Path B Round-3: process error listener and respawn error handling", () => {
    it("fails skeleton when process emits error event", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-proc-err-"));
      const worktreeDir = path.join(tmpBase, "wt");
      const quarantineDir = path.join(tmpBase, "quarantine");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.mkdirSync(quarantineDir, { recursive: true });

      const child = new MockChildProcess();
      attachMockAcpAgent(child);

      const supervisor = createSkeletonSupervisor({
        runId: "run-proc-err",
        skeletonId: "skel-proc-err",
        role: "planner",
        cwd: worktreeDir,
        quarantineDir,
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        brokerOptions: getRequiredBrokerSettings(),
        spawnFn: () => child,
      });

      try {
        await supervisor.raise();
        assert.equal(supervisor.getState(), "raised");

        // Transport forwards child error as an EventEmitter error; ignore transport error in test
        (supervisor as any).transport.on("error", () => {});

        child.emit("error", new Error("spawn ENOENT failure"));

        assert.equal(supervisor.getState(), "failed");
        assert.equal(supervisor.getFailureReason(), "unexpected_exit");
        assert.match(
          (supervisor as any).failureError ?? "",
          /Skeleton process error: spawn ENOENT failure/i
        );
      } finally {
        await supervisor.finish();
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("attaches client error listener on respawn and fails on MalformedRequestError", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-respawn-err-"));
      const worktreeDir = path.join(tmpBase, "wt");
      const quarantineDir = path.join(tmpBase, "quarantine");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.mkdirSync(quarantineDir, { recursive: true });

      const child1 = new MockChildProcess();
      attachMockAcpAgent(child1);
      const child2 = new MockChildProcess();
      attachMockAcpAgent(child2);

      let spawnCount = 0;
      const supervisor = createSkeletonSupervisor({
        runId: "run-respawn-err",
        skeletonId: "skel-respawn-err",
        role: "planner",
        cwd: worktreeDir,
        quarantineDir,
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        brokerOptions: getRequiredBrokerSettings(),
        spawnFn: () => {
          spawnCount++;
          return spawnCount === 1 ? child1 : child2;
        },
      });

      try {
        await supervisor.raise();
        assert.equal(supervisor.getState(), "raised");
        assert.equal(spawnCount, 1);

        // Crash the first child process to trigger unexpected exit respawn
        child1.emit("exit", 1, null);

        // Wait for respawn to complete
        await sleep(100);

        assert.equal(spawnCount, 2);
        assert.equal(supervisor.getState(), "raised");

        // Emit MalformedRequestError on the post-respawn client
        const client = (supervisor as any).client;
        assert.ok(client, "Client must exist after respawn");

        client.emit(
          "error",
          new MalformedRequestError("malformed permission after respawn")
        );

        assert.equal(supervisor.getState(), "failed");
        assert.equal(supervisor.getFailureReason(), "malformed_permission_request");
        assert.match(
          (supervisor as any).failureError ?? "",
          /malformed permission after respawn/
        );
      } finally {
        await supervisor.finish();
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("preserves additionalDirectories and snapshotDir across respawn", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rb4-respawn-dirs-"));
      const worktreeDir = path.join(tmpBase, "wt");
      const quarantineDir = path.join(tmpBase, "quarantine");
      const extraDir = path.join(tmpBase, "extra-dir");
      const snapshotDir = path.join(tmpBase, "snapshot-dir");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.mkdirSync(quarantineDir, { recursive: true });
      fs.mkdirSync(extraDir, { recursive: true });
      fs.mkdirSync(snapshotDir, { recursive: true });

      const child1 = new MockChildProcess();
      attachMockAcpAgent(child1);
      const child2 = new MockChildProcess();

      let sessionLoadReceived: any = null;
      let stdinBuffer = "";
      child2.stdin.on("data", (chunk: Buffer | string) => {
        stdinBuffer += chunk.toString("utf-8");
        let newlineIndex = stdinBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = stdinBuffer.slice(0, newlineIndex).trim();
          stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            try {
              const msg = JSON.parse(line);
              if (msg.method === "initialize") {
                child2.stdout.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                      agentCapabilities: { streaming: true },
                      extensionMethods: [],
                      mcpCapabilities: { http: true },
                    },
                  }) + "\n"
                );
              } else if (msg.method === "session/load") {
                sessionLoadReceived = msg.params;
                child2.stdout.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { sessionId: msg.params.sessionId, status: "loaded" },
                  }) + "\n"
                );
              } else {
                child2.stdout.write(
                  JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n"
                );
              }
            } catch {}
          }
          newlineIndex = stdinBuffer.indexOf("\n");
        }
      });

      let spawnCount = 0;
      const supervisor = createSkeletonSupervisor({
        runId: "run-respawn-dirs",
        skeletonId: "skel-respawn-dirs",
        role: "planner",
        cwd: worktreeDir,
        quarantineDir,
        additionalDirectories: [extraDir],
        snapshotDir: snapshotDir,
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        brokerOptions: getRequiredBrokerSettings(),
        spawnFn: () => {
          spawnCount++;
          return spawnCount === 1 ? child1 : child2;
        },
      });

      try {
        await supervisor.raise();
        assert.equal(supervisor.getState(), "raised");

        // Crash child1
        child1.emit("exit", 1, null);

        // Wait for respawn
        await sleep(100);

        assert.equal(spawnCount, 2);
        assert.equal(supervisor.getState(), "raised");
        assert.ok(sessionLoadReceived, "session/load must be received by child2");
        assert.ok(
          Array.isArray(sessionLoadReceived.additionalDirectories),
          "additionalDirectories must be present in session/load"
        );
        assert.ok(
          sessionLoadReceived.additionalDirectories.includes(extraDir),
          "extraDir must be preserved in additionalDirectories"
        );
        assert.ok(
          sessionLoadReceived.additionalDirectories.includes(snapshotDir),
          "snapshotDir must be preserved in additionalDirectories for planner"
        );
      } finally {
        await supervisor.finish();
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });
});
