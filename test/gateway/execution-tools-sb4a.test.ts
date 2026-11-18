// Work package SB4a tests: gateway execution tools
// - N-B3: every event is redacted (argv and cwd) before it reaches EventStore or onEmitEvent
// - N-B5: post-exec scans always run, cleanup runs in a finally block, and a cleanup
//   error is recorded as an event without hiding the scan results
// - N-B8: the process sweeper never receives a user name, only the command's pgid

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleSandboxExec,
  type SweepableBackend,
  type SweepableSandbox,
} from "../../lib/gateway/execution-tools";
import { EventStore } from "../../lib/events/event-store";
import { LogStore } from "../../lib/events/log-store";
import type { ExecProcess, ExecRequest, Sandbox, SandboxSpec } from "../../lib/backend/types";
import type { ToolExecutionContext } from "../../lib/gateway/types";

interface RecordedEvent {
  kind: string;
  data: Record<string, unknown>;
}

function eventKinds(events: RecordedEvent[]): string[] {
  return events.map((e) => e.kind).sort();
}

test("SB4a N-B3: an argv carrying a bearer token is redacted in the stored and emitted events", async () => {
  const bearerToken = "Bearer sb4a_bearer_token_value_1234567890";
  const rawArgv = ["git", "commit", "-m", `release: Authorization: ${bearerToken}`];
  const redactedArgv = ["git", "commit", "-m", "release: Authorization: Bearer [REDACTED]"];

  const eventStore = new EventStore(":memory:");
  const emitted: RecordedEvent[] = [];
  let dispatchedArgv: string[] | null = null;

  const context: ToolExecutionContext = {
    skeletonId: "skel-sb4a-redact",
    role: "Soul-stitcher",
    bearerToken: "token-sb4a-redact",
    worktreeRoot: "/workspace/sb4a-redact",
    runId: "run-sb4a-redact",
  };

  const res = await handleSandboxExec(
    { argv: rawArgv },
    context,
    {
      defaultTimeoutMs: 60000,
      logStore: new LogStore({ inMemory: true }),
      eventStore,
      onEmitEvent: (evt) => {
        emitted.push(evt as unknown as RecordedEvent);
      },
      runbox: (async (argv: string[]) => {
        dispatchedArgv = argv;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) as any,
    }
  );

  assert.equal(res.status, "completed");

  // The sandbox still receives the real argv: redaction applies to events only
  assert.deepEqual(dispatchedArgv, rawArgv);

  // Events stored via EventStore.append carry the redacted argv
  const stored = eventStore.getEvents("run-sb4a-redact");
  assert.deepEqual(eventKinds(stored as unknown as RecordedEvent[]), ["command.result", "command.started"]);
  for (const evt of stored) {
    assert.equal(
      JSON.stringify(evt).includes(bearerToken),
      false,
      `stored ${evt.kind} event must not carry the raw bearer token`
    );
    assert.deepEqual((evt.data as Record<string, unknown>).argv, redactedArgv);
  }

  // Events emitted via onEmitEvent carry the redacted argv
  assert.deepEqual(eventKinds(emitted), ["command.result", "command.started"]);
  for (const evt of emitted) {
    assert.equal(
      JSON.stringify(evt).includes(bearerToken),
      false,
      `emitted ${evt.kind} event must not carry the raw bearer token`
    );
    assert.deepEqual(evt.data.argv, redactedArgv);
  }
});

test("SB4a N-B5: a cleanup that throws does not skip the post-exec scans and is recorded as an event", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb4a-cleanup-wt-"));
  const secretFile = path.join(worktreeDir, "leaked-during-run.env");
  try {
    let sweepAttempts = 0;
    const emitted: RecordedEvent[] = [];
    const appended: RecordedEvent[] = [];

    // exec()-only sandbox: the exec() process records the command's pgid, and the
    // command writes a secret into the worktree while it runs.
    const execBox = {
      id: "sb4a-cleanup-box",
      containerId: "c-sb4a-cleanup",
      async exec(_req: ExecRequest): Promise<ExecProcess & { pgid?: number }> {
        fs.writeFileSync(secretFile, "TOKEN=ghp_SB4aCleanupScanToken123456\n");
        return {
          pgid: 7791,
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
    } as unknown as SweepableSandbox;

    const backend: SweepableBackend = {
      kind: "instabox-docker",
      runbox: execBox,
      async create(_spec: SandboxSpec): Promise<Sandbox> {
        return execBox;
      },
      async sweepProcesses(): Promise<void> {
        sweepAttempts += 1;
        throw new Error("sb4a backend sweep exploded");
      },
    };

    const context: ToolExecutionContext = {
      skeletonId: "skel-sb4a-cleanup",
      role: "Soul-stitcher",
      bearerToken: "token-sb4a-cleanup",
      worktreeRoot: worktreeDir,
      runId: "run-sb4a-cleanup",
      backend,
    };

    const res = await handleSandboxExec(
      { argv: ["npm", "test"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        eventStore: {
          append: (evt: unknown) => {
            appended.push(evt as RecordedEvent);
          },
        } as unknown as EventStore,
        onEmitEvent: (evt) => {
          emitted.push(evt as unknown as RecordedEvent);
        },
      }
    );

    // The scan results win: the run is quarantined with SECRET_DETECTED, and the
    // cleanup error neither replaced nor hid them
    assert.equal((res as { status: string }).status, "fatal");
    const fatal = res as { status: string; code?: string; reason?: string };
    assert.equal(fatal.code, "SECRET_DETECTED");
    assert.ok(fatal.reason?.includes("leaked-during-run.env"), "the scan finding names the leaked file");

    // Cleanup was attempted despite the fatal scan outcome
    assert.ok(sweepAttempts >= 1, "cleanup must have been attempted");

    // The cleanup error is recorded as an event on both channels
    const emittedCleanupFailures = emitted.filter((e) => e.kind === "command.cleanup_failed");
    assert.equal(emittedCleanupFailures.length, 1, "the cleanup error is recorded as an event (onEmitEvent)");
    const cleanupData = emittedCleanupFailures[0].data;
    assert.equal(
      String(cleanupData.reason).includes("sb4a backend sweep exploded"),
      true,
      "the cleanup event records the cleanup error"
    );
    assert.deepEqual(cleanupData.argv, ["npm", "test"]);
    const appendedCleanupFailures = appended.filter((e) => e.kind === "command.cleanup_failed");
    assert.equal(appendedCleanupFailures.length, 1, "the cleanup error is recorded as an event (EventStore)");

    // The scans ran after the cleanup failure and their results were recorded:
    // the secret-scan refusal and the quarantine events are all present
    const refusals = emitted.filter((e) => e.kind === "command.refused");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].data.ruleId, "SECRET_DETECTED");
    assert.deepEqual(
      eventKinds(emitted),
      ["command.cleanup_failed", "command.refused", "command.result", "command.started", "run.done", "skeleton.state"]
    );
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("SB4a N-B8: the sweeper call carries no user name, only the command's pgid", async () => {
  // Scenario A: the command recorded a pgid - the sweeper receives exactly that pgid
  const sweeperArgsA: Array<number | string | undefined> = [];
  const killArgs: unknown[] = [];
  const backendSweepArgs: unknown[] = [];

  const execBox = {
    id: "sb4a-sweep-box",
    containerId: "c-sb4a-sweep",
    async exec(_req: ExecRequest): Promise<ExecProcess & { pgid?: number }> {
      return {
        pgid: 7791,
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
    killProcessGroup(...args: unknown[]): void {
      killArgs.push(...args);
    },
  } as unknown as SweepableSandbox;

  const backend: SweepableBackend = {
    kind: "instabox-docker",
    runbox: execBox,
    async create(_spec: SandboxSpec): Promise<Sandbox> {
      return execBox;
    },
    async sweepProcesses(...args: unknown[]): Promise<void> {
      backendSweepArgs.push(...args);
    },
  };

  const contextA: ToolExecutionContext = {
    skeletonId: "skel-sb4a-sweep",
    role: "Soul-stitcher",
    bearerToken: "token-sb4a-sweep",
    worktreeRoot: "/workspace/sb4a-sweep",
    runId: "run-sb4a-sweep-a",
    backend,
  };

  const resA = await handleSandboxExec(
    { argv: ["npm", "test"] },
    contextA,
    {
      defaultTimeoutMs: 60000,
      logStore: new LogStore({ inMemory: true }),
      processSweeper: (pgid) => {
        sweeperArgsA.push(pgid);
      },
    }
  );

  assert.equal((resA as { status: string }).status, "completed");
  assert.deepEqual(sweeperArgsA, [7791], "the sweeper receives only the command's pgid");
  for (const arg of sweeperArgsA) {
    assert.notEqual(arg, "builder", "the sweeper must not receive the builder user name");
    assert.notEqual(arg, "warden", "the sweeper must not receive the warden user name");
  }
  assert.deepEqual(killArgs, [7791], "the sandbox kill is scoped to the command's pgid");
  assert.deepEqual(backendSweepArgs, ["c-sb4a-sweep", 7791], "the backend sweep is scoped to the command's pgid");

  // Scenario B: no pgid recorded - the sweeper still runs, receiving no pgid and
  // no user name, and no process-group kill or backend sweep is claimed
  const sweeperArgsB: Array<number | string | undefined> = [];
  const noPgidKillArgs: unknown[] = [];
  const noPgidSweepArgs: unknown[] = [];

  const noPgidBox = {
    id: "sb4a-sweep-nopgid-box",
    async exec(_req: ExecRequest): Promise<ExecProcess & { pgid?: number }> {
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
    killProcessGroup(...args: unknown[]): void {
      noPgidKillArgs.push(...args);
    },
  } as unknown as SweepableSandbox;

  const noPgidBackend: SweepableBackend = {
    kind: "instabox-docker",
    runbox: noPgidBox,
    async create(_spec: SandboxSpec): Promise<Sandbox> {
      return noPgidBox;
    },
    async sweepProcesses(...args: unknown[]): Promise<void> {
      noPgidSweepArgs.push(...args);
    },
  };

  const contextB: ToolExecutionContext = {
    skeletonId: "skel-sb4a-sweep",
    role: "Soul-stitcher",
    bearerToken: "token-sb4a-sweep",
    worktreeRoot: "/workspace/sb4a-sweep",
    runId: "run-sb4a-sweep-b",
    backend: noPgidBackend,
  };

  const resB = await handleSandboxExec(
    { argv: ["npm", "test"] },
    contextB,
    {
      defaultTimeoutMs: 60000,
      logStore: new LogStore({ inMemory: true }),
      processSweeper: (pgid) => {
        sweeperArgsB.push(pgid);
      },
    }
  );

  assert.equal((resB as { status: string }).status, "completed");
  assert.deepEqual(sweeperArgsB, [undefined], "the sweeper runs without a pgid and without a user name");
  for (const arg of sweeperArgsB) {
    assert.notEqual(arg, "builder", "the sweeper must not receive the builder user name");
    assert.notEqual(arg, "warden", "the sweeper must not receive the warden user name");
  }
  assert.equal(noPgidKillArgs.length, 0, "no process-group kill is claimed without a recorded pgid");
  assert.equal(noPgidSweepArgs.length, 0, "no backend sweep is claimed without a recorded pgid");
});
