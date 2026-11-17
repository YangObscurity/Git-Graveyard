// Work package R5-B4: gateway-emitted fatal results reach the supervisor.
// Audit item "fatal result, PARTIAL" (after R5-B2b): the supervisor subscribes
// to gw.on("fatal") but nothing in lib/gateway emitted it, so a fatal gateway
// result never reached handleFatalGatewayResult in production. These tests use
// a real McpGateway wired into the supervisor options and drive the real
// handleToolCall path end to end.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
} from "../../lib/supervisor/skeleton-supervisor";
import type { SkeletonSupervisorOptions } from "../../lib/supervisor/types";
import { LogStore } from "../../lib/events/log-store";
import { McpGateway } from "../../lib/gateway/mcp-gateway";
import { CLAUDE_OPUS_5_5_MODEL_ID } from "../../lib/supervisor/model-allowlist";
import type {
  ChildProcessLike,
  SpawnFunction,
} from "../../lib/supervisor/types";
import { getRequiredBrokerSettings } from "./fixtures";

/**
 * Mock ChildProcess for tests so real OS processes are never spawned.
 */
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

/**
 * Simulates an ACP agent speaking JSON-RPC over stdio with a valid planner
 * session so the supervisor raises cleanly.
 */
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
          respond(JSON.parse(line)).catch(() => {});
        } catch {
          // Ignore malformed lines
        }
      }
      newlineIndex = stdinBuffer.indexOf("\n");
    }
  });

  async function respond(msg: any): Promise<void> {
    if (!msg || typeof msg !== "object" || !("id" in msg)) {
      return;
    }
    const { id, method } = msg;
    let result: unknown;
    if (method === "initialize") {
      result = {
        agentCapabilities: {
          streaming: true,
          _meta: {
            kiro: {
              extensionMethods: ["_session/steer"],
            },
          },
        },
        extensionMethods: ["_session/steer"],
        mcpCapabilities: { http: true },
      };
    } else if (method === "session/new") {
      result = {
        sessionId: "sess-r5b4-planner",
        modeId: "planner",
        configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
      };
    } else {
      result = { ok: true };
    }
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}

interface GatewaySupervisorFixture {
  supervisor: SkeletonSupervisor;
  gateway: McpGateway;
  gatewayBearerToken: string;
  child: MockChildProcess;
  worktreeDir: string;
  quarantineDir: string;
  baseDir: string;
}

/**
 * Builds a raised supervisor with a real McpGateway wired through the
 * supervisor options (the same gateway object the supervisor subscribes to).
 * The gateway's fake runbox optionally drops a file with a secret pattern
 * into the worktree on run, so the post-exec secret scan reports the
 * sandbox_exec result as fatal and the gateway emits "fatal".
 */
function buildRaisedSupervisor(dropSecretOnRun: boolean): GatewaySupervisorFixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b4-sup-"));
  const worktreeDir = path.join(baseDir, "wt");
  const quarantineDir = path.join(baseDir, "quarantine");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "task.md"), "sample task", "utf-8");

  const secretFile = path.join(worktreeDir, "leaked.txt");
  const fakeRunbox = {
    run: async () => {
      if (dropSecretOnRun) {
        // AWS access key pattern (AKIA followed by 16 uppercase/digits)
        fs.writeFileSync(secretFile, 'aws_key = "AKIAABCDEFGHIJKLMNOP"\n', "utf-8");
      }
      return {
        exitCode: 0,
        stdoutTail: "executed git status in runbox",
        stderrTail: "",
        timedOut: false,
      };
    },
  };

  const gateway = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    // The gateway constructor requires a logStore; in-memory keeps the fixture off disk.
    logStore: new LogStore({ inMemory: true }),
    runbox: fakeRunbox as any,
  });
  const skeleton = gateway.registerSkeleton({
    skeletonId: "skel-r5b4-planner",
    role: "Soul-stitcher",
    worktreeRoot: worktreeDir,
    runId: "run-r5b4-sup",
  });

  const child = new MockChildProcess();
  attachMockAcpAgent(child);
  const mockSpawn: SpawnFunction = () => child;

  const options: SkeletonSupervisorOptions & { gateway?: McpGateway } = {
    runId: "run-r5b4-sup",
    skeletonId: "skel-r5b4-planner",
    role: "planner",
    cwd: worktreeDir,
    quarantineDir,
    watchdogLimitMs: 5000,
    cancelGracePeriodMs: 5000,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: mockSpawn,
    gateway,
  };
  const supervisor = createSkeletonSupervisor(options);

  return {
    supervisor,
    gateway,
    gatewayBearerToken: skeleton.bearerToken,
    child,
    worktreeDir,
    quarantineDir,
    baseDir,
  };
}

async function withRaisedFixture(
  dropSecretOnRun: boolean,
  run: (fixture: GatewaySupervisorFixture) => Promise<void>
): Promise<void> {
  const fixture = buildRaisedSupervisor(dropSecretOnRun);
  try {
    await fixture.supervisor.raise();
    await run(fixture);
  } finally {
    await fixture.supervisor.finish();
    fs.rmSync(fixture.baseDir, { recursive: true, force: true });
  }
}

/**
 * Polls until the predicate holds or the timeout elapses. The supervisor's
 * gateway subscription dispatches asynchronously (gwHandler catches its own
 * errors), so quarantine state becomes observable on a later tick.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs: number = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Work package R5-B4: gateway-emitted fatal results reach the supervisor", () => {
  it("quarantines the Skeleton through handleFatalGatewayResult when the gateway emits a fatal tool result", async () => {
    await withRaisedFixture(true, async (fixture) => {
      const { supervisor, gateway, gatewayBearerToken, child, quarantineDir } = fixture;
      assert.equal(supervisor.getState(), "raised");
      assert.equal(supervisor.isWorktreeQuarantined(), false);

      // Spy on the public handleFatalGatewayResult to prove the gateway
      // emission reaches the supervisor through that path.
      const fatalCalls: unknown[] = [];
      const originalHandleFatal = supervisor.handleFatalGatewayResult.bind(supervisor);
      supervisor.handleFatalGatewayResult = async (result?: unknown) => {
        fatalCalls.push(result);
        await originalHandleFatal(result);
      };

      // Real production path: a fatal tool result flows through
      // gateway.handleToolCall, which must emit "fatal" on the gateway object
      // the supervisor subscribed to in its constructor.
      const returned = (await gateway.handleToolCall(
        gatewayBearerToken,
        "sandbox_exec",
        { argv: ["git", "status"], cwd: fixture.worktreeDir }
      )) as { status: string; fatal?: boolean; code?: string };

      assert.equal(returned.status, "fatal", "The tool result must be fatal");
      assert.equal(returned.fatal, true);
      assert.equal(returned.code, "SECRET_DETECTED");

      await waitFor(
        () => supervisor.isWorktreeQuarantined(),
        "the Skeleton to be quarantined by the gateway-emitted fatal result"
      );

      assert.equal(
        fatalCalls.length,
        1,
        "handleFatalGatewayResult must be called exactly once with the gateway result"
      );
      assert.equal(
        fatalCalls[0],
        returned,
        "The result reaching handleFatalGatewayResult must be the same object the gateway emitted"
      );
      assert.equal(supervisor.isWorktreeQuarantined(), true);
      assert.equal(supervisor.getState(), "terminated");
      assert.equal(supervisor.getFailureReason(), "quarantined");
      assert.ok(child.signalsSent.includes("SIGTERM"), "Session process must be terminated");

      const recordFiles = fs.readdirSync(quarantineDir).sort();
      assert.equal(recordFiles.length, 1, "Exactly one quarantine record must exist under quarantineDir");
      const record = JSON.parse(
        fs.readFileSync(path.join(quarantineDir, recordFiles[0]), "utf-8")
      );
      assert.equal(record.quarantined, true);
      assert.equal(record.runId, "run-r5b4-sup");
      assert.equal(record.skeletonId, "skel-r5b4-planner");
      assert.equal(record.code, "SECRET_DETECTED");
    });
  });

  it("does not quarantine the Skeleton for non-fatal gateway results", async () => {
    await withRaisedFixture(false, async (fixture) => {
      const { supervisor, gateway, gatewayBearerToken, quarantineDir } = fixture;
      assert.equal(supervisor.getState(), "raised");

      // Real production path: a clean command completes; nothing emits, so
      // nothing quarantines.
      const returned = (await gateway.handleToolCall(
        gatewayBearerToken,
        "sandbox_exec",
        { argv: ["git", "status"], cwd: fixture.worktreeDir }
      )) as { status: string };
      assert.equal(returned.status, "completed");

      // Non-fatal payloads delivered over the subscribed events (as a gateway
      // emitting them would): the supervisor must not quarantine any of them.
      gateway.emit("result", { status: "completed", exit_code: 0 });
      gateway.emit("fatal", { status: "completed", exit_code: 0 });
      gateway.emit("fatal", { quarantine: true, reason: "bare quarantine flag is not fatal" });

      await sleep(150);

      assert.equal(supervisor.isWorktreeQuarantined(), false, "Non-fatal results must not quarantine the Skeleton");
      assert.equal(supervisor.getState(), "raised", "Skeleton must stay raised after non-fatal results");
      assert.equal(supervisor.getFailureReason(), null);
      assert.deepEqual(fs.readdirSync(quarantineDir), [], "No quarantine record may be written");
    });
  });
});
