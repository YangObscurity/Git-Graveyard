// Task 10.6 Tests: MCP execution tools and backend dispatch
// Requirements: 19.5, 19.6, 19.7, 19.8, 19.9, 19.10, 19.19, 20.4, 20.6, 20.7, 20.8, 20.10, 20.11, 20.12

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleSandboxExec,
  handleSandboxLog,
  cleanupProcesses,
  type ExecutionToolsOptions,
  type SweepableSandbox,
  type SweepableBackend,
} from "../../lib/gateway/execution-tools";
import { McpGateway } from "../../lib/gateway/mcp-gateway";
import { LogStore } from "../../lib/events/log-store";
import { ApprovalManager } from "../../lib/gateway/approval-manager";
import type {
  ExecutionBackend,
  ExecProcess,
  ExecRequest,
  ExecResult,
  Sandbox,
  SandboxSpec,
} from "../../lib/backend/types";
import type { ToolExecutionContext } from "../../lib/gateway/types";

test("sandbox_exec: validates that cwd lies within caller worktree (Requirement 19.5)", async () => {
  const context: ToolExecutionContext = {
    skeletonId: "skel-builder",
    role: "Soul-stitcher",
    bearerToken: "token-123",
    worktreeRoot: "/workspace/project",
    runId: "run-test-cwd",
  };

  // 1. cwd outside worktree root is refused with CWD_OUTSIDE_WORKTREE
  const outsideRes = await handleSandboxExec(
    {
      argv: ["git", "status"],
      cwd: "/etc/passwd",
    },
    context
  );
  assert.equal(outsideRes.status, "refused");
  assert.equal((outsideRes as { code: string }).code, "CWD_OUTSIDE_WORKTREE");
  assert.ok((outsideRes as { error: string }).error.includes("outside worktree root"));
  assert.ok(!(outsideRes as { error: string }).error.includes("/workspace/project"));
  assert.ok(!(outsideRes as { error: string }).error.includes("/etc/passwd"));

  // Relative traversal escaping worktree
  const traversalRes = await handleSandboxExec(
    {
      argv: ["git", "status"],
      cwd: "/workspace/project/../../secret",
    },
    context
  );
  assert.equal(traversalRes.status, "refused");
  assert.equal((traversalRes as { code: string }).code, "CWD_OUTSIDE_WORKTREE");

  // 2. cwd inside worktree root is accepted
  const insideRes = await handleSandboxExec(
    {
      argv: ["git", "status"],
      cwd: "/workspace/project/subdir",
    },
    context,
    {
      defaultTimeoutMs: 60000,
      logStore: new LogStore({ inMemory: true }),
      runbox: (async () => ({
        exitCode: 0,
        stdout: "clean",
        stderr: "",
      })) as any,
    }
  );
  assert.equal(insideRes.status, "completed");
  assert.equal((insideRes as { exit_code: number }).exit_code, 0);
});

test("sandbox_exec: validates that argv is strictly a non-empty array of strings (Requirement 20.12)", async () => {
  const context: ToolExecutionContext = {
    skeletonId: "skel-builder",
    role: "Exhumer",
    bearerToken: "token-argv",
    worktreeRoot: "/workspace/project",
  };

  // Empty argv array
  const emptyRes = await handleSandboxExec(
    { argv: [] },
    context
  );
  assert.equal(emptyRes.status, "refused");
  assert.equal((emptyRes as { code: string }).code, "INVALID_ARGV");

  // Non-array argv
  const nonArrayRes = await handleSandboxExec(
    { argv: "git status" as unknown as string[] },
    context
  );
  assert.equal(nonArrayRes.status, "refused");
  assert.equal((nonArrayRes as { code: string }).code, "INVALID_ARGV");

  // Non-string elements in argv
  const nonStringRes = await handleSandboxExec(
    { argv: ["git", 123 as unknown as string] },
    context
  );
  assert.equal(nonStringRes.status, "refused");
  assert.equal((nonStringRes as { code: string }).code, "INVALID_ARGV");
});

test("sandbox_exec: dispatches builder commands to Runbox and Warden commands to Auditbox (Requirement 19.6)", async () => {
  const recordedBoxes: string[] = [];

  const runner = async (argv: string[], opts: { box: "runbox" | "auditbox" }) => {
    recordedBoxes.push(opts.box);
    return {
      exitCode: 0,
      stdout: `executed in ${opts.box}`,
      stderr: "",
    };
  };

  // Builder roles (Exhumer, Bonesetter, Soul-stitcher) dispatch to Runbox
  const builderRoles = ["Exhumer", "Bonesetter", "Soul-stitcher"];
  for (const role of builderRoles) {
    recordedBoxes.length = 0;
    const ctx: ToolExecutionContext = {
      skeletonId: `skel-${role.toLowerCase()}`,
      role,
      bearerToken: "token-b",
      worktreeRoot: "/workspace/repo",
      runId: `run-${role.toLowerCase()}`,
    };
    const res = await handleSandboxExec(
      { argv: ["git", "status"], cwd: "/workspace/repo" },
      ctx,
      { defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }), runbox: runner as any, auditbox: runner as any }
    );
    assert.equal(res.status, "completed");
    assert.equal(recordedBoxes[0], "runbox", `Expected runbox for ${role}`);
  }

  // Warden role dispatches to Auditbox
  recordedBoxes.length = 0;
  const wardenCtx: ToolExecutionContext = {
    skeletonId: "skel-warden",
    role: "Warden",
    bearerToken: "token-w",
    worktreeRoot: "/workspace/repo",
    runId: "run-warden",
  };
  const wardenRes = await handleSandboxExec(
    { argv: ["git", "status"], cwd: "/workspace/repo" },
    wardenCtx,
    { defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }), runbox: runner as any, auditbox: runner as any }
  );
  assert.equal(wardenRes.status, "completed");
  assert.equal(recordedBoxes[0], "auditbox", "Expected auditbox for Warden");
});

test("sandbox_exec: emits command.started and command.result events (Requirement 19.19)", async () => {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-events",
    worktreeRoot: "/workspace/repo",
    runId: "run-events-01",
  };

  const res = await handleSandboxExec(
    {
      argv: ["git", "status"],
      cwd: "/workspace/repo",
      timeoutMs: 45000,
    },
    context,
    {
      defaultTimeoutMs: 60000,
      logStore: new LogStore({ inMemory: true }),
      onEmitEvent: (evt) => {
        events.push(evt as { kind: string; data: Record<string, unknown> });
      },
      runbox: (async () => ({
        exitCode: 0,
        stdout: "On branch main\nnothing to commit",
        stderr: "",
      })) as any,
    }
  );

  assert.equal(res.status, "completed");

  const startEvt = events.find((e) => e.kind === "command.started");
  assert.ok(startEvt, "Must emit command.started");
  assert.deepEqual(startEvt?.data.argv, ["git", "status"]);
  assert.equal(startEvt?.data.box, "runbox");
  assert.equal(startEvt?.data.cwd, "/workspace/repo");
  assert.equal(startEvt?.data.timeoutMs, 45000);
  assert.ok(startEvt?.data.logRef);

  const resEvt = events.find((e) => e.kind === "command.result");
  assert.ok(resEvt, "Must emit command.result");
  assert.deepEqual(resEvt?.data.argv, ["git", "status"]);
  assert.equal(resEvt?.data.box, "runbox");
  assert.equal(resEvt?.data.exitCode, 0);
  assert.equal(resEvt?.data.timedOut, false);
  assert.equal(resEvt?.data.logRef, startEvt?.data.logRef);
});

test("sandbox_exec: returns exit_code, stdout_tail, stderr_tail, truncated, and log_ref on bounded completion (Requirement 19.8)", async () => {
  const logStore = new LogStore({ inMemory: true });

  const context: ToolExecutionContext = {
    skeletonId: "skel-bones",
    role: "Bonesetter",
    bearerToken: "token-out",
    worktreeRoot: "/workspace/repo",
    runId: "run-test-bounded",
  };

  const res = await handleSandboxExec(
    {
      argv: ["npm", "run", "build"],
      cwd: "/workspace/repo",
    },
    context,
    {
      defaultTimeoutMs: 60000,
      logStore,
      runbox: (async () => ({
        exitCode: 0,
        stdout: "compiled successfully in 120ms\n",
        stderr: "warning: deprecated dependency\n",
      })) as any,
    }
  );

  assert.equal(res.status, "completed");
  const completed = res as {
    status: string;
    exit_code: number;
    stdout_tail: string;
    stderr_tail: string;
    truncated: boolean;
    log_ref: string;
  };
  assert.equal(completed.exit_code, 0);
  assert.ok(completed.stdout_tail.includes("compiled successfully"));
  assert.ok(completed.stderr_tail.includes("deprecated dependency"));
  assert.equal(completed.truncated, false);
  assert.ok(completed.log_ref.startsWith("log-"));

  // Verify logStore recorded the entry
  const record = logStore.getLogRecord(completed.log_ref);
  assert.ok(record);
  assert.equal(record?.exitCode, 0);
});

test("sandbox_exec: returns status running with log_ref for continuing executions (Requirement 19.9)", async () => {
  const logStore = new LogStore({ inMemory: true });

  const context: ToolExecutionContext = {
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    bearerToken: "token-running",
    worktreeRoot: "/workspace/repo",
    runId: "run-test-running",
  };

  const res = await handleSandboxExec(
    {
      argv: ["npm", "run", "test"],
      cwd: "/workspace/repo",
    },
    context,
    {
      defaultTimeoutMs: 60000,
      logStore,
      runbox: (async () => ({
        exitCode: 0,
        stdout: "running tests...\n",
        stderr: "",
        running: true,
      })) as any,
    }
  );

  assert.equal(res.status, "running");
  const runningRes = res as { status: string; log_ref: string };
  assert.ok(runningRes.log_ref);

  // Check log record is preserved in running state
  const logSlice = await handleSandboxLog(
    { log_ref: runningRes.log_ref, limit: 100 },
    context,
    { logStore }
  );
  assert.equal(logSlice.status, "running");
  assert.equal(logSlice.exit_code, null);
  assert.ok(logSlice.slice.includes("running tests"));
});

test("sandbox_log: returns log output slices by offset and limit, returning exit status once finished (Requirement 19.10)", async () => {
  const logStore = new LogStore({ inMemory: true });
  const logRef = "log-test-slice-42";

  // Store 50 lines of logs
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++) {
    lines.push(`Line ${i}: output data block`);
  }
  logStore.storeCommandOutput({
    logRef,
    runId: "run-test",
    metadata: { skeletonId: "skel-w", runId: "run-test" },
    stdout: lines.join("\n"),
    stderr: "",
    exitCode: 0,
  });

  const context: ToolExecutionContext = {
    skeletonId: "skel-w",
    role: "Warden",
    bearerToken: "token-w",
    runId: "run-test",
  };

  // Slice lines 10 to 20
  const slice1 = await handleSandboxLog(
    {
      log_ref: logRef,
      offset: 10,
      limit: 10,
    },
    context,
    { logStore }
  );

  assert.equal(slice1.status, "finished");
  assert.equal(slice1.exit_code, 0);
  assert.equal(slice1.offset, 10);
  assert.equal(slice1.limit, 10);
  assert.equal(slice1.total, 50);
  assert.equal(slice1.hasMore, true);
  assert.ok(slice1.slice.includes("Line 11"));
  assert.ok(slice1.slice.includes("Line 20"));

  // Slice final chunk
  const slice2 = await handleSandboxLog(
    {
      log_ref: logRef,
      offset: 45,
      limit: 10,
    },
    context,
    { logStore }
  );

  assert.equal(slice2.hasMore, false);
  assert.ok(slice2.slice.includes("Line 50"));
});

test("ExecutionBackend dispatch: dispatches via typed Sandbox run() and claims no cleanup without a recorded pgid (Requirements 19.6, 20.11, H-3)", async () => {
  let runCalledWith: ExecRequest | null = null;
  let sandboxKillArgs: unknown[] | null = null;
  let backendSweepArgs: unknown[] | null = null;

  const mockRunbox: SweepableSandbox = {
    id: "runbox-test-01",
    async run(req: ExecRequest): Promise<ExecResult> {
      runCalledWith = req;
      return {
        logRef: "log-mock-01",
        exitCode: 0,
        stdoutTail: "mock runbox stdout",
        stderrTail: "",
        timedOut: false,
        oomKilled: false,
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
    async killProcessGroup(...args: unknown[]): Promise<void> {
      sandboxKillArgs = args;
    },
  };

  const mockBackend: SweepableBackend = {
    kind: "instabox-docker",
    runbox: mockRunbox,
    async create(spec: SandboxSpec): Promise<Sandbox> {
      return mockRunbox;
    },
    async sweepProcesses(...args: unknown[]): Promise<void> {
      backendSweepArgs = args;
    },
  };

  const context: ToolExecutionContext = {
    skeletonId: "skel-builder",
    role: "Soul-stitcher",
    bearerToken: "token-sb",
    worktreeRoot: "/workspace/repo",
    runId: "run-test-backend",
    backend: mockBackend,
  };

  const res = await handleSandboxExec(
    {
      argv: ["npm", "test"],
      cwd: "/workspace/repo",
    },
    context,
    { defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }) }
  );

  assert.equal(res.status, "completed");
  assert.equal((res as { exit_code: number }).exit_code, 0);
  assert.ok((res as { stdout_tail: string }).stdout_tail.includes("mock runbox stdout"));

  // Verify argv array dispatch strictly preserved (Requirement 20.12)
  const capturedRun = runCalledWith as ExecRequest | null;
  assert.deepEqual(capturedRun?.argv, ["npm", "test"]);

  // H-3 (R6-A2): the run() path records no command pgid, so cleanup must not claim
  // a process-group kill or a backend sweep, and no user name is ever swept
  assert.equal(sandboxKillArgs, null, "Must not claim a process-group kill without a recorded pgid");
  assert.equal(backendSweepArgs, null, "Must not claim a backend sweep without a recorded pgid");
});

test("ExecutionBackend dispatch: dispatches via typed Sandbox exec() stream and cleans up with the command's group id (Requirements 19.6, 20.11, H-3)", async () => {
  let execCalledWith: ExecRequest | null = null;
  let sandboxKillArgs: unknown[] | null = null;
  let backendSweepArgs: unknown[] | null = null;

  // The gateway dispatches through exec() when the sandbox exposes no run():
  // only that path returns the live process whose pgid the gateway records.
  const mockAuditbox = {
    id: "auditbox-test-01",
    containerId: "c-auditbox-test-01",
    async exec(req: ExecRequest): Promise<ExecProcess & { pgid?: number }> {
      execCalledWith = req;
      return {
        pgid: 4242,
        output: (async function* () {
          yield { seq: 1, stream: "stdout", data: "audit checking diff\n" };
          yield { seq: 2, stream: "stderr", data: "no syntax issues\n" };
        })(),
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
    async killProcessGroup(...args: unknown[]): Promise<void> {
      sandboxKillArgs = args;
    },
  } as unknown as SweepableSandbox;

  const mockBackend: SweepableBackend = {
    kind: "instabox-docker",
    auditbox: mockAuditbox,
    async create(spec: SandboxSpec): Promise<Sandbox> {
      return mockAuditbox;
    },
    async sweepProcesses(...args: unknown[]): Promise<void> {
      backendSweepArgs = args;
    },
  };

  const context: ToolExecutionContext = {
    skeletonId: "skel-w",
    role: "Warden",
    bearerToken: "token-warden-exec",
    worktreeRoot: "/workspace/repo",
    runId: "run-test-audit",
    backend: mockBackend,
  };

  const res = await handleSandboxExec(
    {
      argv: ["git", "diff"],
      cwd: "/workspace/repo",
    },
    context,
    { defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }) }
  );

  assert.equal(res.status, "completed");
  const completed = res as { exit_code: number; stdout_tail: string; stderr_tail: string };
  assert.equal(completed.exit_code, 0);
  assert.ok(completed.stdout_tail.includes("audit checking diff"));
  assert.ok(completed.stderr_tail.includes("no syntax issues"));
  const capturedExec = execCalledWith as ExecRequest | null;
  assert.deepEqual(capturedExec?.argv, ["git", "diff"]);

  // H-3 (R6-A2): cleanup is scoped to the command's own process group. The exec()
  // process records pgid 4242, so the sandbox kill and the backend cleanup receive
  // that group id and nothing else; no user name is ever swept.
  const capturedKillArgs = (sandboxKillArgs ?? []) as unknown[];
  assert.deepEqual(capturedKillArgs, [4242], "Must kill only the command's own process group");
  const capturedSweepArgs = (backendSweepArgs ?? []) as unknown[];
  assert.deepEqual(
    capturedSweepArgs,
    ["c-auditbox-test-01", 4242],
    "Backend cleanup must receive the command's container id and group id, never a user name"
  );
});

test("cleanupProcesses: injected sweeper still runs after a failed command, no kill claimed without a pgid (Requirement 20.11, H-3)", async () => {
  let sweeperCalls = 0;
  let sweptPgid: number | string | undefined;
  let sandboxKillCalled = false;

  const failingSandbox: SweepableSandbox = {
    id: "failing-box",
    async run(): Promise<ExecResult> {
      throw new Error("Container process crashed unexpectedly");
    },
    async exec(): Promise<ExecProcess> {
      throw new Error("Container process crashed unexpectedly");
    },
    async wait() {
      return { exitCode: 1, timedOut: false, oomKilled: false };
    },
    async stop() {},
    async destroy() {},
    async killProcessGroup(): Promise<void> {
      sandboxKillCalled = true;
    },
  };

  const context: ToolExecutionContext = {
    skeletonId: "skel-builder",
    role: "Soul-stitcher",
    bearerToken: "token-failing",
    worktreeRoot: "/workspace/repo",
    runId: "run-test-failing",
    runbox: failingSandbox,
  };

  const res = await handleSandboxExec(
    {
      argv: ["npm", "run", "lint"],
      cwd: "/workspace/repo",
    },
    context,
    {
      defaultTimeoutMs: 60000,
      logStore: new LogStore({ inMemory: true }),
      processSweeper: (pgid) => {
        sweeperCalls += 1;
        sweptPgid = pgid;
      },
    }
  );

  assert.equal(res.status, "completed");
  assert.equal((res as { exit_code: number }).exit_code, 1);
  assert.ok((res as { stderr_tail: string }).stderr_tail.includes("crashed unexpectedly"));

  // The injected sweeper still ran for the failed command; the command recorded
  // no pgid, so no process-group kill is claimed and no user-wide sweep is invoked.
  // SB4a (Audit N-B8): the sweeper receives only the command's pgid, never a user name.
  assert.equal(sweeperCalls, 1, "The injected sweeper still runs after a failed command");
  assert.equal(sweptPgid, undefined, "The sweeper receives the command's pgid (none recorded), never a user name");
  assert.equal(sandboxKillCalled, false, "Must not claim a process-group kill without a recorded pgid");
});

test("McpGateway integration: registers Skeleton with backend/sandbox and dispatches sandbox_exec end-to-end", async () => {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let runnerCalled = false;

  const mockRunbox: Sandbox = {
    id: "gateway-runbox",
    async run(req: ExecRequest): Promise<ExecResult> {
      runnerCalled = true;
      return {
        logRef: "log-gw-01",
        exitCode: 0,
        stdoutTail: "npm test passed (12 suites)\n",
        stderrTail: "",
        timedOut: false,
        oomKilled: false,
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

  const mockBackend: ExecutionBackend = {
    async create(): Promise<Sandbox> {
      return mockRunbox;
    },
  };

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    backend: mockBackend,
    runbox: mockRunbox,
    onEmitEvent: (evt) => {
      events.push(evt);
    },
  });

  const skel = gw.registerSkeleton({
    skeletonId: "skel-e2e",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-e2e-01",
  });

  const res = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
    argv: ["npm", "test"],
    cwd: "/workspace/repo",
  })) as { status: string; exit_code: number; stdout_tail: string; log_ref: string };

  assert.equal(res.status, "completed");
  assert.equal(res.exit_code, 0);
  assert.ok(res.stdout_tail.includes("npm test passed"));
  assert.equal(runnerCalled, true);

  // Events emitted
  assert.ok(events.some((e) => e.kind === "command.started"));
  assert.ok(events.some((e) => e.kind === "command.result"));

  // Check log retrieval
  const logSlice = (await gw.handleToolCall(skel.bearerToken, "sandbox_log", {
    log_ref: res.log_ref,
    limit: 100,
  })) as { status: string; exit_code: number; slice: string };
  assert.equal(logSlice.status, "finished");
  assert.equal(logSlice.exit_code, 0);
  assert.ok(logSlice.slice.includes("npm test passed"));
});

test("sandbox_exec: never runs command on host and refuses when no sandbox is available (WP F05)", async () => {
  const context: ToolExecutionContext = {
    skeletonId: "skel-builder",
    role: "Soul-stitcher",
    bearerToken: "token-123",
    worktreeRoot: "/workspace/project",
    runId: "run-no-sandbox",
  };

  // When no commandRunner, no targetSandbox, and no backend are provided
  const res = await handleSandboxExec(
    {
      argv: ["git", "status"],
      cwd: "/workspace/project",
    },
    context
  );

  assert.equal(res.status, "refused");
  assert.equal((res as { code: string }).code, "NO_SANDBOX_AVAILABLE");
  assert.ok((res as { error: string }).error.includes("No sandbox is available"));
});

test("worktreeRoot: registration without worktreeRoot is refused, and cwd defaults to worktreeRoot (WP F05)", async () => {
  const gw = new McpGateway({ defaultTimeoutMs: 60000, approvalWaitMs: 300000, logStore: new LogStore({ inMemory: true }) });

  // Registration without worktreeRoot throws
  assert.throws(
    () => {
      gw.registerSkeleton({
        skeletonId: "skel-no-worktree",
        role: "Soul-stitcher",
        runId: "run-no-wt",
      });
    },
    (err: Error) => err.message.includes("worktreeRoot is required")
  );

  // Registration with empty worktreeRoot throws
  assert.throws(
    () => {
      gw.registerSkeleton({
        skeletonId: "skel-empty-wt",
        role: "Soul-stitcher",
        worktreeRoot: "   ",
        runId: "run-no-wt",
      });
    },
    (err: Error) => err.message.includes("worktreeRoot is required")
  );

  // handleSandboxExec without context.worktreeRoot is refused
  const noWtContext: ToolExecutionContext = {
    skeletonId: "skel-no-wt",
    role: "Soul-stitcher",
    bearerToken: "token-no-wt",
  };
  const refusedNoWt = await handleSandboxExec(
    { argv: ["git", "status"] },
    noWtContext,
    {
      runbox: (async () => ({ exitCode: 0, stdout: "", stderr: "" })) as any,
    }
  );
  assert.equal(refusedNoWt.status, "refused");
  assert.equal((refusedNoWt as { code: string }).code, "WORKTREE_ROOT_REQUIRED");

  // cwd defaults to worktreeRoot when omitted
  let executedCwd = "";
  const validContext: ToolExecutionContext = {
    skeletonId: "skel-default-cwd",
    role: "Soul-stitcher",
    bearerToken: "token-default-cwd",
    worktreeRoot: "/workspace/project",
    runId: "run-default-cwd",
  };
  const execRes = await handleSandboxExec(
    { argv: ["git", "status"] },
    validContext,
    {
      defaultTimeoutMs: 60000,
      logStore: new LogStore({ inMemory: true }),
      runbox: (async (_argv: string[], opts: any) => {
        executedCwd = opts.cwd;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) as any,
    }
  );
  assert.equal(execRes.status, "completed");
  assert.equal(executedCwd, path.resolve("/workspace/project"));
});

test("caps: timeoutMs and approvalTtlMs supplied by agent are clamped to Admin config limits (WP F05)", async () => {
  let executedTimeoutMs = 0;
  const context: ToolExecutionContext = {
    skeletonId: "skel-caps",
    role: "Soul-stitcher",
    bearerToken: "token-caps",
    worktreeRoot: "/workspace/project",
    runId: "run-caps",
  };

  const adminTimeoutLimit = 15000;
  const adminApprovalLimit = 20000;
  const approvalMgr = new ApprovalManager({ defaultWaitMs: adminApprovalLimit });

  // 1. Agent supplies timeoutMs higher than Admin limit -> refused
  const highTimeoutRes = await handleSandboxExec(
    {
      argv: ["git", "status"],
      timeoutMs: 999999, // higher than Admin limit of 15000
    },
    context,
    {
      defaultTimeoutMs: adminTimeoutLimit,
      approvalManager: approvalMgr,
      logStore: new LogStore({ inMemory: true }),
      runbox: (async (_argv: string[], opts: any) => {
        executedTimeoutMs = opts.timeoutMs;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) as any,
    }
  );
  assert.equal(highTimeoutRes.status, "refused");
  assert.equal((highTimeoutRes as any).code, "INVALID_TIMEOUT");

  // 2. Agent supplies timeoutMs lower than Admin limit -> preserved
  await handleSandboxExec(
    {
      argv: ["git", "status"],
      timeoutMs: 5000, // lower than Admin limit of 15000
    },
    context,
    {
      defaultTimeoutMs: adminTimeoutLimit,
      approvalManager: approvalMgr,
      logStore: new LogStore({ inMemory: true }),
      runbox: (async (_argv: string[], opts: any) => {
        executedTimeoutMs = opts.timeoutMs;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) as any,
    }
  );
  assert.equal(executedTimeoutMs, 5000);

  // 3. Agent supplies approvalTtlMs higher than Admin limit -> clamped down
  const pendingHigh = await handleSandboxExec(
    {
      argv: ["mvn", "compile"],
      approvalTtlMs: 999999, // higher than Admin limit of 20000
    },
    context,
    {
      defaultTimeoutMs: adminTimeoutLimit,
      approvalManager: approvalMgr,
    }
  );
  assert.equal(pendingHigh.status, "approval_pending");
  const reqHigh = approvalMgr.getPendingRequest((pendingHigh as { approvalId: string }).approvalId);
  assert.ok(reqHigh);
  assert.ok(reqHigh.expiresAt <= Date.now() + adminApprovalLimit + 50);

  // 4. Agent supplies approvalTtlMs lower than Admin limit -> preserved
  const pendingLow = await handleSandboxExec(
    {
      argv: ["gradle", "build"],
      approvalTtlMs: 3000, // lower than Admin limit of 20000
    },
    context,
    {
      defaultTimeoutMs: adminTimeoutLimit,
      approvalManager: approvalMgr,
    }
  );
  assert.equal(pendingLow.status, "approval_pending");
  const reqLow = approvalMgr.getPendingRequest((pendingLow as { approvalId: string }).approvalId);
  assert.ok(reqLow);
  assert.ok(reqLow.expiresAt <= Date.now() + 3050);
});

test("approval state: repeat call with approvalId after approval consumes grant and runs without reporting expired (WP F05)", async () => {
  const approvalMgr = new ApprovalManager({ defaultWaitMs: 60000 });
  const context: ToolExecutionContext = {
    skeletonId: "skel-approval-test",
    role: "Soul-stitcher",
    bearerToken: "token-appr",
    worktreeRoot: "/workspace/project",
    runId: "run-appr-test",
  };

  let runCount = 0;
  const runner = async () => {
    runCount++;
    return { exitCode: 0, stdout: "executed", stderr: "" };
  };

  // 1. Initial invocation requires approval -> status approval_pending
  const firstRes = await handleSandboxExec(
    { argv: ["cargo", "build"] },
    context,
    { approvalManager: approvalMgr, defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }), runbox: runner as any }
  );
  assert.equal(firstRes.status, "approval_pending");
  const approvalId = (firstRes as { approvalId: string }).approvalId;
  assert.ok(approvalId);

  // 2. User approves the request
  const grant = await approvalMgr.approveRequest(approvalId);
  assert.ok(grant);

  // 3. Repeat call with approvalId after approval consumes grant and runs; MUST NOT report expired
  const repeatRes = await handleSandboxExec(
    {
      argv: ["cargo", "build"],
      approvalId,
    },
    context,
    { approvalManager: approvalMgr, defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }), runbox: runner as any }
  );
  assert.equal(repeatRes.status, "completed");
  assert.equal(runCount, 1);

  // 4. Second repeat call with already consumed approvalId reports expired/blocked
  const thirdRes = await handleSandboxExec(
    {
      argv: ["cargo", "build"],
      approvalId,
    },
    context,
    { approvalManager: approvalMgr, defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }), runbox: runner as any }
  );
  assert.equal(thirdRes.status, "blocked");
  assert.ok(
    (thirdRes as { reason: string }).reason.includes("expired") ||
    (thirdRes as { reason: string }).reason.includes("denied")
  );

  // 5. Unknown approvalId is reported as expired/blocked
  const unknownRes = await handleSandboxExec(
    {
      argv: ["cargo", "build"],
      approvalId: "appr-unknown-id-xyz",
    },
    context,
    { approvalManager: approvalMgr, defaultTimeoutMs: 60000, logStore: new LogStore({ inMemory: true }), runbox: runner as any }
  );
  assert.equal(unknownRes.status, "blocked");
  assert.ok(
    (unknownRes as { reason: string }).reason.includes("expired") ||
    (unknownRes as { reason: string }).reason.includes("denied")
  );
});

test("log ownership: sandbox_log checks that log_ref belongs to calling runId and skeletonId, otherwise returns not-found (WP F05)", async () => {
  const logStore = new LogStore({ inMemory: true });
  const ownerContext: ToolExecutionContext = {
    skeletonId: "skel-owner",
    role: "Soul-stitcher",
    bearerToken: "token-owner",
    worktreeRoot: "/workspace/project",
    runId: "run-owner",
  };

  // Execute a command to generate a stored log
  const execRes = await handleSandboxExec(
    { argv: ["git", "status"] },
    ownerContext,
    {
      defaultTimeoutMs: 60000,
      logStore,
      runbox: (async () => ({
        exitCode: 0,
        stdout: "owner log content line 1\nowner log content line 2\n",
        stderr: "",
      })) as any,
    }
  );
  assert.equal(execRes.status, "completed");
  const logRef = (execRes as { log_ref: string }).log_ref;
  assert.ok(logRef);

  // 1. Calling with matching runId and skeletonId succeeds
  const ownerLog = await handleSandboxLog({ log_ref: logRef, limit: 100 }, ownerContext, { logStore });
  assert.equal(ownerLog.status, "finished");
  assert.ok(ownerLog.slice.includes("owner log content"));

  // 2. Calling with different skeletonId returns not-found
  const diffSkeletonContext: ToolExecutionContext = {
    skeletonId: "skel-intruder",
    role: "Soul-stitcher",
    bearerToken: "token-intruder",
    worktreeRoot: "/workspace/project",
    runId: "run-owner",
  };
  const intruderLog = await handleSandboxLog({ log_ref: logRef, limit: 100 }, diffSkeletonContext, { logStore });
  assert.equal(intruderLog.status, "not-found");
  assert.equal(intruderLog.slice, "");

  // 3. Calling with different runId returns not-found
  const diffRunContext: ToolExecutionContext = {
    skeletonId: "skel-owner",
    role: "Soul-stitcher",
    bearerToken: "token-owner",
    worktreeRoot: "/workspace/project",
    runId: "run-other",
  };
  const diffRunLog = await handleSandboxLog({ log_ref: logRef, limit: 100 }, diffRunContext, { logStore });
  assert.equal(diffRunLog.status, "not-found");
  assert.equal(diffRunLog.slice, "");

  // 4. Calling with non-existent log_ref returns not-found
  const nonExistentLog = await handleSandboxLog({ log_ref: "log-nonexistent-12345", limit: 100 }, ownerContext, { logStore });
  assert.equal(nonExistentLog.status, "not-found");
  assert.equal(nonExistentLog.slice, "");
});

test("sandbox_exec: a worktree with an escaping link refuses sandbox_exec (F15)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f15-esc-symlink-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "f15-outside-"));
  try {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "outside content");

    // Create escaping symlink inside worktree pointing outside
    const linkPath = path.join(tmpDir, "escape-link");
    fs.symlinkSync(outsideFile, linkPath);

    const emittedEvents: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];
    const context: ToolExecutionContext = {
      skeletonId: "skel-symlink-test",
      role: "Soul-stitcher",
      bearerToken: "token-symlink",
      worktreeRoot: tmpDir,
      runId: "run-f15-symlink",
    };

    let runnerExecuted = false;
    const res = await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        onEmitEvent: (e) => {
          emittedEvents.push(e as any);
        },
        runbox: (async () => {
          runnerExecuted = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    );

    assert.equal(res.status, "refused");
    assert.equal((res as { code: string }).code, "ESCAPING_SYMLINK");
    assert.ok((res as { error: string }).error.toLowerCase().includes("escaping symlink"));
    assert.equal(runnerExecuted, false, "Sandbox command must not run when escaping symlink is found");

    // Check security event recorded
    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0].kind, "command.refused");
    assert.equal(emittedEvents[0].data.ruleId, "ESCAPING_SYMLINK");
    assert.equal(emittedEvents[0].data.securityEvent, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("sandbox_exec: a worktree with sensitive secrets refuses sandbox_exec (F15)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f15-secret-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "credentials.env"),
      "GH_KEY=ghp_123456789012345678901234567890123456\n"
    );

    const emittedEvents: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];
    const context: ToolExecutionContext = {
      skeletonId: "skel-secret-test",
      role: "Soul-stitcher",
      bearerToken: "token-secret",
      worktreeRoot: tmpDir,
      runId: "run-f15-secret",
    };

    let runnerExecuted = false;
    const res = await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        onEmitEvent: (e) => {
          emittedEvents.push(e as any);
        },
        runbox: (async () => {
          runnerExecuted = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    );

    assert.equal(res.status, "refused");
    assert.equal((res as { code: string }).code, "SECRET_DETECTED");
    assert.ok((res as { error: string }).error.toLowerCase().includes("secret"));
    assert.equal(runnerExecuted, false, "Sandbox command must not run when secret is found");

    // Check security event recorded
    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0].kind, "command.refused");
    assert.equal(emittedEvents[0].data.ruleId, "SECRET_DETECTED");
    assert.equal(emittedEvents[0].data.securityEvent, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox_exec: runs redactor text scan on captured output and stores only redacted text (F15)", async () => {
  const logStore = new LogStore({ inMemory: true });
  const rawToken = "ghp_superSecretTokenForOutputRedaction1234";
  const rawPath = "/data/home/necro/secrets";

  const context: ToolExecutionContext = {
    skeletonId: "skel-redact-test",
    role: "Soul-stitcher",
    bearerToken: "token-redact",
    worktreeRoot: "/workspace/project",
    runId: "run-f15-redact",
  };

  const res = await handleSandboxExec(
    { argv: ["git", "status"] },
    context,
    {
      defaultTimeoutMs: 60000,
      logStore,
      runbox: (async () => ({
        exitCode: 0,
        stdout: `Connected using ${rawToken}\nDone.\n`,
        stderr: `Failed reading from ${rawPath}\n`,
      })) as any,
    }
  );

  assert.equal(res.status, "completed");
  const comp = res as { stdout_tail: string; stderr_tail: string; log_ref: string };
  assert.ok(!comp.stdout_tail.includes(rawToken), "stdout_tail must not contain raw token");
  assert.ok(comp.stdout_tail.includes("[REDACTED]"), "stdout_tail must be redacted");
  assert.ok(!comp.stderr_tail.includes("/data/home"), "stderr_tail must not contain host path");
  assert.ok(comp.stderr_tail.includes("[REDACTED]"), "stderr_tail must be redacted");

  // Verify stored log in LogStore
  const record = logStore.getLogRecord(comp.log_ref);
  assert.ok(record, "Log record must exist");
  assert.ok(record.stdout !== undefined && !record.stdout.includes(rawToken), "stored stdout must not contain raw token");
  assert.ok(record.stdout !== undefined && record.stdout.includes("[REDACTED]"));
  assert.ok(record.stderr !== undefined && !record.stderr.includes("/data/home"), "stored stderr must not contain host path");
  assert.ok(record.stderr !== undefined && record.stderr.includes("[REDACTED]"));
});
