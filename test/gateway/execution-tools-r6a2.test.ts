// Work package R6-A2 tests: the gateway execution tools never trigger a
// user-wide process sweep (audit items H-3, N-2, N-4). Cleanup for a command is
// scoped to that command's own process group (pgid); when no group id is known,
// no cleanup is claimed; cleanup errors are surfaced, not swallowed.

import test from "node:test";
import * as assert from "node:assert/strict";
import {
  handleSandboxExec,
  cleanupProcesses,
  type SweepableSandbox,
  type SweepableBackend,
} from "../../lib/gateway/execution-tools";
import { LogStore } from "../../lib/events/log-store";
import type {
  ExecProcess,
  ExecRequest,
  ExecResult,
  Sandbox,
  SandboxSpec,
} from "../../lib/backend/types";
import type { ToolExecutionContext } from "../../lib/gateway/types";

interface CleanupCall {
  entry: "sandbox-kill" | "backend-sweep" | "backend-kill";
  args: unknown[];
}

function assertNoUserNameInArgs(calls: CleanupCall[]): void {
  for (const call of calls) {
    for (const arg of call.args) {
      assert.notEqual(arg, "builder", "no cleanup call may receive the builder user name");
      assert.notEqual(arg, "warden", "no cleanup call may receive the warden user name");
      if (arg && typeof arg === "object") {
        assert.equal(
          "user" in (arg as Record<string, unknown>),
          false,
          "no cleanup call may receive a user option"
        );
      }
    }
  }
}

function buildContext(
  overrides: Partial<ToolExecutionContext>
): ToolExecutionContext {
  return {
    skeletonId: "skel-r6a2",
    role: "Soul-stitcher",
    bearerToken: "token-r6a2",
    worktreeRoot: "/workspace/repo",
    runId: "run-r6a2",
    ...overrides,
  };
}

function makeRunbox(options: {
  id: string;
  containerId?: string;
  processPgid?: number;
  killRecorder?: (args: unknown[]) => void;
}): SweepableSandbox {
  const runViaExec = async (req: ExecRequest): Promise<ExecResult> => {
    const proc = await mockExec(req);
    const waitRes = await proc.wait();
    return {
      logRef: `log-${options.id}`,
      exitCode: waitRes.exitCode ?? 0,
      stdoutTail: "",
      stderrTail: "",
      timedOut: Boolean(waitRes.timedOut),
      oomKilled: Boolean(waitRes.oomKilled),
    };
  };

  async function mockExec(req: ExecRequest): Promise<ExecProcess> {
    const proc: ExecProcess & { pgid?: number } = {
      async wait() {
        return { exitCode: 0, timedOut: false, oomKilled: false };
      },
    };
    if (options.processPgid !== undefined) {
      proc.pgid = options.processPgid;
    }
    return proc;
  }

  const sandbox: SweepableSandbox = {
    id: options.id,
    containerId: options.containerId,
    exec: mockExec,
    run: runViaExec,
    async wait() {
      return { exitCode: 0, timedOut: false, oomKilled: false };
    },
    async stop() {},
    async destroy() {},
  };
  if (options.killRecorder) {
    sandbox.killProcessGroup = (...args: unknown[]): Promise<void> => {
      options.killRecorder!(args);
      return Promise.resolve();
    };
  }
  return sandbox;
}

// The gateway dispatches through exec() for sandboxes that expose no run(): only
// that path returns the live process object whose pgid the gateway can record.
function makeExecOnlyRunbox(options: {
  id: string;
  containerId?: string;
  processPgid?: number;
  killRecorder?: (args: unknown[]) => void;
}): SweepableSandbox {
  const box = makeRunbox(options) as unknown as Record<string, unknown>;
  delete box.run;
  return box as unknown as SweepableSandbox;
}

test("R6-A2: a sandbox_exec command never triggers a user-wide sweep", async () => {
  const cleanupCalls: CleanupCall[] = [];

  const mockRunbox = makeRunbox({
    id: "r6a2-runbox",
    containerId: "c-r6a2-runbox",
    killRecorder: (args) => cleanupCalls.push({ entry: "sandbox-kill", args }),
  });

  const mockBackend: SweepableBackend = {
    kind: "instabox-docker",
    runbox: mockRunbox,
    async create(spec: SandboxSpec): Promise<Sandbox> {
      return mockRunbox;
    },
    async sweepProcesses(...args: unknown[]): Promise<void> {
      cleanupCalls.push({ entry: "backend-sweep", args });
    },
  };

  const res = await handleSandboxExec(
    {
      argv: ["npm", "test"],
      cwd: "/workspace/repo",
    },
    buildContext({ backend: mockBackend, runbox: mockRunbox }),
    { defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }) }
  );

  assert.equal(res.status, "completed");

  // The exec() process recorded no pgid, so no cleanup is claimed at all:
  // no process-group kill and no sweep, and never a user-wide sweep.
  assert.deepEqual(
    cleanupCalls,
    [],
    "without a recorded pgid no cleanup entry point may be invoked"
  );
  assertNoUserNameInArgs(cleanupCalls);
});

test("R6-A2: cleanup for a command uses that command's group id", async () => {
  const cleanupCalls: CleanupCall[] = [];

  const mockRunbox = makeExecOnlyRunbox({
    id: "r6a2-runbox-pgid",
    containerId: "c-r6a2-pgid",
    processPgid: 7788,
    killRecorder: (args) => cleanupCalls.push({ entry: "sandbox-kill", args }),
  });

  const mockBackend: SweepableBackend = {
    kind: "instabox-docker",
    runbox: mockRunbox,
    async create(spec: SandboxSpec): Promise<Sandbox> {
      return mockRunbox;
    },
    async sweepProcesses(...args: unknown[]): Promise<void> {
      cleanupCalls.push({ entry: "backend-sweep", args });
    },
  };

  const res = await handleSandboxExec(
    {
      argv: ["npm", "test"],
      cwd: "/workspace/repo",
    },
    buildContext({ backend: mockBackend, runbox: mockRunbox }),
    { defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }) }
  );

  assert.equal(res.status, "completed");

  // The exec() process recorded pgid 7788: the sandbox kill and the backend
  // cleanup receive exactly that group id, never a user name.
  assert.deepEqual(
    cleanupCalls,
    [
      { entry: "sandbox-kill", args: [7788] },
      { entry: "backend-sweep", args: ["c-r6a2-pgid", 7788] },
    ],
    "cleanup must be scoped to the command's own process group only"
  );
  assertNoUserNameInArgs(cleanupCalls);

  // Direct cleanup with a recorded group id passes it through unchanged.
  const directCalls: CleanupCall[] = [];
  const directSandbox: SweepableSandbox = {
    id: "r6a2-direct",
    exec: async () => {
      throw new Error("not used in this test");
    },
    run: async () => {
      throw new Error("not used in this test");
    },
    async wait() {
      return { exitCode: 0, timedOut: false, oomKilled: false };
    },
    async stop() {},
    async destroy() {},
    killProcessGroup: (...args: unknown[]) => {
      directCalls.push({ entry: "sandbox-kill", args });
      return Promise.resolve();
    },
  };
  const directBackend: SweepableBackend = {
    kind: "instabox-docker",
    async create(): Promise<Sandbox> {
      return directSandbox;
    },
    async sweepProcesses(...args: unknown[]): Promise<void> {
      directCalls.push({ entry: "backend-sweep", args });
    },
  };
  await cleanupProcesses(directBackend, directSandbox, "runbox", undefined, "7789");
  assert.deepEqual(
    directCalls,
    [
      { entry: "sandbox-kill", args: ["7789"] },
      { entry: "backend-sweep", args: [directSandbox, "7789"] },
    ],
    "cleanupProcesses must pass the recorded group id through to the kill and sweep"
  );
});

test("R6-A2: a cleanup error is surfaced, not swallowed", async () => {
  // 1. cleanupProcesses propagates a sandbox-level kill failure
  const throwingKillSandbox: SweepableSandbox = {
    id: "r6a2-kill-fails",
    exec: async () => {
      throw new Error("not used in this test");
    },
    run: async () => {
      throw new Error("not used in this test");
    },
    async wait() {
      return { exitCode: 0, timedOut: false, oomKilled: false };
    },
    async stop() {},
    async destroy() {},
    async killProcessGroup(): Promise<void> {
      throw new Error("process group kill failed");
    },
  };
  await assert.rejects(
    async () => {
      await cleanupProcesses(undefined, throwingKillSandbox, "runbox", undefined, 4242);
    },
    /process group kill failed/,
    "a sandbox kill failure must propagate from cleanupProcesses"
  );

  // 2. cleanupProcesses propagates a backend-level sweep failure
  const throwingBackend: SweepableBackend = {
    kind: "instabox-docker",
    async create(): Promise<Sandbox> {
      throw new Error("not used in this test");
    },
    async sweepProcesses(): Promise<void> {
      throw new Error("backend sweep failed");
    },
  };
  await assert.rejects(
    async () => {
      await cleanupProcesses(throwingBackend, undefined, "runbox", undefined, 4243);
    },
    /backend sweep failed/,
    "a backend sweep failure must propagate from cleanupProcesses"
  );

  // 3. handleSandboxExec surfaces the cleanup failure instead of reporting success
  let sweepAttempts = 0;
  const sandboxWithPgid = makeExecOnlyRunbox({
    id: "r6a2-exec-fail",
    containerId: "c-r6a2-exec-fail",
    processPgid: 7790,
  });
  const backendWithFailingSweep: SweepableBackend = {
    kind: "instabox-docker",
    runbox: sandboxWithPgid,
    async create(): Promise<Sandbox> {
      return sandboxWithPgid;
    },
    async sweepProcesses(): Promise<void> {
      sweepAttempts += 1;
      throw new Error("backend sweep exploded");
    },
  };

  await assert.rejects(
    async () => {
      await handleSandboxExec(
        {
          argv: ["npm", "test"],
          cwd: "/workspace/repo",
        },
        buildContext({
          backend: backendWithFailingSweep,
          runbox: sandboxWithPgid,
        }),
        { defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }) }
      );
    },
    /backend sweep exploded/,
    "the cleanup failure must surface to the caller of sandbox_exec"
  );
  assert.ok(sweepAttempts >= 1, "the backend sweep must have been attempted");
});
