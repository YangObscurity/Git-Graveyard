// Work package SB2: skeleton supervisor hardening.
// Audit N-B1: a gateway fatal event quarantines only its own Skeleton; the
// listener is removed when the Skeleton finishes or is terminated.
// Audit N-6: no quarantine from session updates.
// Audit N-B7: quarantineDir outside the worktree; a failed write terminates
// the Skeleton and the error is not swallowed.
// Audit M-3: no numeric defaults; limits come from required settings.

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
import { RequiredSettingError } from "../../lib/supervisor/acp-client";
import { CLAUDE_OPUS_5_5_MODEL_ID } from "../../lib/supervisor/model-allowlist";
import type {
  ChildProcessLike,
  GatewayEventSource,
  GatewayFatalEventPayload,
  SkeletonFailedEvent,
  SkeletonSupervisorEvent,
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
        sessionId: "sess-sb2-planner",
        modeId: "planner",
        configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
      };
    } else {
      result = { ok: true };
    }
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}

/**
 * Fake gateway event source recording on/off calls so listener removal is
 * observable. It emulates the real gateway contract: a "fatal" event carries
 * a { skeletonId, runId, result } payload naming the target Skeleton.
 */
class FakeGateway implements GatewayEventSource {
  public fatalHandlers: Array<(payload: GatewayFatalEventPayload) => void> = [];
  public offCalls: Array<{
    event: string;
    handler: (payload: GatewayFatalEventPayload) => void;
  }> = [];

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
    this.offCalls.push({ event, handler });
    this.fatalHandlers = this.fatalHandlers.filter((h) => h !== handler);
  }

  public emitFatal(payload: GatewayFatalEventPayload): void {
    for (const handler of [...this.fatalHandlers]) {
      handler(payload);
    }
  }
}

interface SB2Fixture {
  supervisor: SkeletonSupervisor;
  child: MockChildProcess;
  gateway: FakeGateway;
  events: SkeletonSupervisorEvent[];
  worktreeDir: string;
  quarantineDir: string;
  baseDir: string;
}

/**
 * Builds a raised supervisor with a real temp worktree, a quarantine
 * directory outside that worktree (both under a temp base directory), and a
 * fake gateway wired through the typed gateway option.
 */
function buildRaisedSupervisor(): SB2Fixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-sup-"));
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
    runId: "run-sb2-sup",
    skeletonId: "skel-sb2-planner",
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
  run: (fixture: SB2Fixture) => Promise<void>
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

function failedEventsOf(events: SkeletonSupervisorEvent[]): SkeletonFailedEvent[] {
  return events.filter((e): e is SkeletonFailedEvent => e.kind === "skeleton.failed");
}

describe("Work package SB2: skeleton-scoped gateway fatal quarantine", () => {
  it("does not quarantine this Skeleton when a fatal event names another Skeleton", async () => {
    await withRaisedFixture(async ({ supervisor, child, gateway, events, quarantineDir }) => {
      assert.equal(supervisor.getState(), "raised");

      gateway.emitFatal({
        skeletonId: "skel-someone-else",
        runId: "run-sb2-sup",
        result: {
          status: "fatal",
          fatal: true,
          code: "SECRET_DETECTED",
          reason: "secret pattern matched in another worktree",
        },
      });
      await sleep(50);

      assert.equal(supervisor.isWorktreeQuarantined(), false, "Another Skeleton's fatal event must not quarantine this one");
      assert.equal(supervisor.getState(), "raised", "This Skeleton must stay raised");
      assert.equal(supervisor.getFailureReason(), null);
      assert.ok(child.signalsSent.length === 0, "This Skeleton's process must not be terminated");
      assert.deepEqual(fs.readdirSync(quarantineDir), [], "No quarantine record may be written");
      assert.equal(failedEventsOf(events).length, 0, "No skeleton.failed event may be emitted");
    });
  });

  it("quarantines this Skeleton when the gateway emits a fatal event naming it", async () => {
    await withRaisedFixture(async ({ supervisor, child, gateway, quarantineDir, worktreeDir }) => {
      gateway.emitFatal({
        skeletonId: "skel-sb2-planner",
        runId: "run-sb2-sup",
        result: {
          status: "fatal",
          fatal: true,
          code: "SECRET_DETECTED",
          reason: "secret pattern matched in worktree",
        },
      });
      await sleep(50);

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
      assert.equal(record.runId, "run-sb2-sup");
      assert.equal(record.skeletonId, "skel-sb2-planner");
      assert.equal(record.reason, "secret pattern matched in worktree");
      assert.equal(record.code, "SECRET_DETECTED");
      assert.equal(fs.existsSync(path.join(worktreeDir, ".quarantined")), false);

      // The listener is removed on termination: a later fatal event for this
      // Skeleton must not quarantine again.
      assert.equal(gateway.fatalHandlers.length, 0, "The fatal listener must be removed once terminated");
      gateway.emitFatal({
        skeletonId: "skel-sb2-planner",
        runId: "run-sb2-sup",
        result: { status: "fatal", fatal: true, code: "SECOND_HIT" },
      });
      await sleep(50);
      assert.equal(fs.readdirSync(quarantineDir).length, 1, "No second quarantine record may be written");
    });
  });

  it("removes the gateway fatal listener when the Skeleton finishes", async () => {
    await withRaisedFixture(async ({ supervisor, gateway }) => {
      assert.equal(gateway.fatalHandlers.length, 1, "The supervisor must subscribe once");
      const attached = gateway.fatalHandlers[0];

      await supervisor.finish();

      assert.equal(gateway.fatalHandlers.length, 0, "The fatal listener must be removed after finish");
      assert.equal(gateway.offCalls.length, 1);
      assert.equal(gateway.offCalls[0].event, "fatal");
      assert.equal(gateway.offCalls[0].handler, attached, "The exact attached handler must be removed");

      // A fatal event naming this Skeleton after finish must do nothing.
      gateway.emitFatal({
        skeletonId: "skel-sb2-planner",
        runId: "run-sb2-sup",
        result: { status: "fatal", fatal: true, code: "LATE_HIT" },
      });
      await sleep(50);
      assert.equal(supervisor.isWorktreeQuarantined(), false);
      assert.equal(supervisor.getFailureReason(), null);
    });
  });

  it("does not quarantine when a session update carries fatal true", async () => {
    await withRaisedFixture(async ({ supervisor, child, events, worktreeDir, quarantineDir }) => {
      assert.equal(supervisor.getState(), "raised");

      await (supervisor as any).handleUpdate({
        sessionUpdate: "tool_result",
        toolCall: { name: "sandbox_exec", status: "completed" },
        toolResult: {
          status: "fatal",
          fatal: true,
          quarantine: true,
          code: "ESCAPING_SYMLINK",
          error: "Symlink escape outside root",
        },
      });
      await (supervisor as any).handleUpdate({ result: { fatal: true, code: "AGENT_FLAG" } });
      await (supervisor as any).handleUpdate({ data: { fatal: true } });
      await (supervisor as any).handleUpdate({ toolCall: { result: { fatal: true } } });
      await sleep(50);

      assert.equal(supervisor.isWorktreeQuarantined(), false, "Agent-supplied fatal flags in session updates must not quarantine");
      assert.equal(supervisor.getState(), "raised", "Skeleton must stay raised after session updates");
      assert.equal(supervisor.getFailureReason(), null);
      assert.ok(child.signalsSent.length === 0, "Session process must not be terminated");
      assert.deepEqual(fs.readdirSync(quarantineDir), [], "No quarantine record may be written");
      assert.equal(failedEventsOf(events).length, 0, "No skeleton.failed event may be emitted");
      assert.equal(fs.existsSync(path.join(worktreeDir, ".quarantined")), false);
    });
  });

  it("throws RequiredSettingError when quarantineDir is inside the worktree or an additionalDirectory", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-qinside-"));
    try {
      const worktreeDir = path.join(baseDir, "wt");
      const extraDir = path.join(baseDir, "extra");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.mkdirSync(extraDir, { recursive: true });

      // Inside cwd is rejected
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-sb2-qinside",
            skeletonId: "skel-sb2-qinside",
            role: "planner",
            cwd: worktreeDir,
            quarantineDir: path.join(worktreeDir, "quarantine"),
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
            brokerOptions: getRequiredBrokerSettings(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.match((err as Error).message, /quarantineDir/i);
          return true;
        }
      );

      // Equal to cwd is inside as well
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-sb2-qequal",
            skeletonId: "skel-sb2-qequal",
            role: "planner",
            cwd: worktreeDir,
            quarantineDir: worktreeDir,
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
            brokerOptions: getRequiredBrokerSettings(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          return true;
        }
      );

      // Inside an additionalDirectory is rejected
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-sb2-qextra",
            skeletonId: "skel-sb2-qextra",
            role: "planner",
            cwd: worktreeDir,
            additionalDirectories: [extraDir],
            quarantineDir: path.join(extraDir, "quarantine"),
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
            brokerOptions: getRequiredBrokerSettings(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          assert.match((err as Error).message, /quarantineDir/i);
          return true;
        }
      );

      // A sibling directory outside the worktree is still accepted
      const supervisor = createSkeletonSupervisor({
        runId: "run-sb2-qoutside",
        skeletonId: "skel-sb2-qoutside",
        role: "planner",
        cwd: worktreeDir,
        additionalDirectories: [extraDir],
        quarantineDir: path.join(baseDir, "quarantine"),
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        brokerOptions: getRequiredBrokerSettings(),
      });
      assert.equal(supervisor.getState(), "uninitialized");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("terminates the Skeleton and emits an event when the quarantine write fails", async () => {
    await withRaisedFixture(async ({ supervisor, child, gateway, events, quarantineDir }) => {
      // Occupy the record path with a directory so the record write fails
      const recordPath = path.join(
        quarantineDir,
        "run-sb2-sup-skel-sb2-planner.quarantine.json"
      );
      fs.mkdirSync(recordPath, { recursive: true });

      const errorEvents: unknown[] = [];
      supervisor.on("error", (err) => {
        errorEvents.push(err);
      });

      gateway.emitFatal({
        skeletonId: "skel-sb2-planner",
        runId: "run-sb2-sup",
        result: {
          status: "fatal",
          fatal: true,
          code: "SECRET_DETECTED",
          reason: "write should fail",
        },
      });
      await sleep(50);

      assert.equal(supervisor.getState(), "terminated", "A failed quarantine write must terminate the Skeleton");
      assert.equal(supervisor.getFailureReason(), "quarantine_write_failed");
      assert.ok(child.signalsSent.includes("SIGTERM"), "Session process must be terminated");

      const failed = failedEventsOf(events);
      assert.equal(failed.length, 1, "Exactly one skeleton.failed event must be emitted");
      assert.equal(failed[0].reason, "quarantine_write_failed");

      assert.ok(errorEvents.length >= 1, "The write error must be surfaced, not swallowed");
      assert.ok(errorEvents[0] instanceof Error);

      // The listener is removed on termination as well
      assert.equal(gateway.fatalHandlers.length, 0);
    });
  });

  it("keeps cancelPromptTimeoutMs a required setting with no numeric default", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-m3-"));
    try {
      const worktreeDir = path.join(baseDir, "wt");
      fs.mkdirSync(worktreeDir, { recursive: true });

      // No cancelPromptTimeoutMs in options or settings: cancel with a pending
      // prompt must fail closed instead of waiting on a built-in default.
      const supervisor = createSkeletonSupervisor({
        runId: "run-sb2-m3-missing",
        skeletonId: "skel-sb2-m3-missing",
        role: "planner",
        cwd: worktreeDir,
        quarantineDir: path.join(baseDir, "quarantine"),
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 10,
        brokerOptions: getRequiredBrokerSettings(),
      });
      (supervisor as any).promptPending = true;
      await assert.rejects(
        () => supervisor.cancel("user_cancelled"),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.match((err as Error).message, /cancelPromptTimeoutMs/i);
          return true;
        }
      );

      // A positive integer from settings is accepted
      const supervisorWithSettings = createSkeletonSupervisor({
        runId: "run-sb2-m3-settings",
        skeletonId: "skel-sb2-m3-settings",
        role: "planner",
        cwd: worktreeDir,
        quarantineDir: path.join(baseDir, "quarantine"),
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 10,
        settings: { cancelPromptTimeoutMs: 25 },
        brokerOptions: getRequiredBrokerSettings(),
      });
      (supervisorWithSettings as any).promptPending = true;
      await supervisorWithSettings.cancel("user_cancelled");
      assert.equal(supervisorWithSettings.getState(), "terminated");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
