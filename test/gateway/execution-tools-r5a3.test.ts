import test from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  handleSandboxExec,
  handleSandboxLog,
} from "../../lib/gateway/execution-tools";
import { LogStore } from "../../lib/events/log-store";
import { ApprovalManager } from "../../lib/gateway/approval-manager";
import type {
  ToolExecutionContext,
  SandboxExecRefusedResult,
  SandboxExecCompletedResult,
  SandboxExecApprovalPendingResult,
} from "../../lib/gateway/types";

function createValidContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    skeletonId: "skel-r5a3",
    role: "Soul-stitcher",
    bearerToken: "token-r5a3",
    worktreeRoot: "/workspace/project",
    runId: "run-r5a3-test",
    ...overrides,
  };
}

test("R5-A3 Item 1: timeoutMs above admin maximum is refused with structured refusal, not clamped with Math.min", async () => {
  const context = createValidContext();
  const logStore = new LogStore({ inMemory: true });
  const adminTimeoutLimit = 30000;

  // 1a. timeoutMs strictly greater than defaultTimeoutMs is refused
  const refusedRes = (await handleSandboxExec(
    {
      argv: ["git", "status"],
      timeoutMs: 45000,
    },
    context,
    {
      defaultTimeoutMs: adminTimeoutLimit,
      logStore,
      runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
    }
  )) as SandboxExecRefusedResult;

  assert.equal(refusedRes.status, "refused");
  assert.equal(refusedRes.code, "INVALID_TIMEOUT");
  assert.ok(refusedRes.error.includes("exceeds maximum allowed timeout setting"));
  assert.ok(refusedRes.error.includes("45000"));
  assert.ok(refusedRes.error.includes("30000"));

  // 1b. timeoutMs equal to or below defaultTimeoutMs is accepted
  const acceptedRes = (await handleSandboxExec(
    {
      argv: ["git", "status"],
      timeoutMs: 25000,
    },
    context,
    {
      defaultTimeoutMs: adminTimeoutLimit,
      logStore,
      runbox: (async (_argv: string[], opts: any) => {
        assert.equal(opts.timeoutMs, 25000);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) as any,
    }
  )) as SandboxExecCompletedResult;

  assert.equal(acceptedRes.status, "completed");
  assert.equal(acceptedRes.exit_code, 0);
});

test("R5-A3 Item 2: non-string cwd is refused with structured refusal without throwing TypeError", async () => {
  const context = createValidContext();
  const logStore = new LogStore({ inMemory: true });

  const nonStringCwds: unknown[] = [
    12345,
    true,
    false,
    {},
    ["/workspace/project"],
  ];

  for (const badCwd of nonStringCwds) {
    let thrownError: unknown = null;
    let res: unknown = null;

    try {
      res = await handleSandboxExec(
        {
          argv: ["git", "status"],
          cwd: badCwd as any,
        },
        context,
        {
          defaultTimeoutMs: 60000,
          logStore,
          runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
        }
      );
    } catch (err) {
      thrownError = err;
    }

    assert.equal(thrownError, null, "Must not throw TypeError on non-string cwd");
    assert.ok(res !== null && typeof res === "object");
    const refused = res as SandboxExecRefusedResult;
    assert.equal(refused.status, "refused");
    assert.equal(refused.code, "INVALID_CWD");
    assert.ok(refused.error.includes("cwd must be a string"));
  }
});

test("R5-A3 Item 3: NaN, negative, zero, or non-finite approvalTtlMs is refused; valid approvalTtlMs keeps clamp to admin limit", async () => {
  const context = createValidContext();
  const logStore = new LogStore({ inMemory: true });
  const adminApprovalLimit = 20000;
  const approvalMgr = new ApprovalManager({ defaultWaitMs: adminApprovalLimit });

  const invalidTtls: unknown[] = [
    NaN,
    -1,
    -500,
    0,
    Infinity,
    -Infinity,
    "1000",
  ];

  for (const badTtl of invalidTtls) {
    const res = (await handleSandboxExec(
      {
        argv: ["cargo", "build"],
        approvalTtlMs: badTtl as any,
      },
      context,
      {
        defaultTimeoutMs: 60000,
        approvalManager: approvalMgr,
        logStore,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "INVALID_APPROVAL_TTL");
    assert.ok(res.error.includes("approvalTtlMs must be a finite positive number"));
  }

  // Valid approvalTtlMs above admin limit is clamped to admin limit by design
  const clampedRes = (await handleSandboxExec(
    {
      argv: ["cargo", "build"],
      approvalTtlMs: 50000,
    },
    context,
    {
      defaultTimeoutMs: 60000,
      approvalManager: approvalMgr,
      logStore,
    }
  )) as SandboxExecApprovalPendingResult;

  assert.equal(clampedRes.status, "approval_pending");
  const reqClamped = approvalMgr.getPendingRequest(clampedRes.approvalId);
  assert.ok(reqClamped);
  assert.ok(reqClamped.expiresAt <= Date.now() + adminApprovalLimit + 50);

  // Valid approvalTtlMs below admin limit is preserved
  const preservedRes = (await handleSandboxExec(
    {
      argv: ["cargo", "build"],
      approvalTtlMs: 5000,
    },
    context,
    {
      defaultTimeoutMs: 60000,
      approvalManager: approvalMgr,
      logStore,
    }
  )) as SandboxExecApprovalPendingResult;

  assert.equal(preservedRes.status, "approval_pending");
  const reqPreserved = approvalMgr.getPendingRequest(preservedRes.approvalId);
  assert.ok(reqPreserved);
  assert.ok(reqPreserved.expiresAt <= Date.now() + 5000 + 50);
});

test("R5-A3 Item 4: missing role returns structured refusal without throwing TypeError", async () => {
  const logStore = new LogStore({ inMemory: true });

  const invalidRoleContexts: ToolExecutionContext[] = [
    {
      skeletonId: "skel-no-role",
      bearerToken: "token-no-role",
      worktreeRoot: "/workspace/project",
      runId: "run-no-role",
    } as any,
    createValidContext({ role: "" }),
    createValidContext({ role: "   " }),
    createValidContext({ role: undefined }),
    createValidContext({ role: null as any }),
    createValidContext({ role: 123 as any }),
  ];

  for (const ctx of invalidRoleContexts) {
    let thrownError: unknown = null;
    let res: unknown = null;

    try {
      res = await handleSandboxExec(
        { argv: ["git", "status"] },
        ctx,
        {
          defaultTimeoutMs: 60000,
          logStore,
          runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
        }
      );
    } catch (err) {
      thrownError = err;
    }

    assert.equal(thrownError, null, "Must not throw TypeError when role is missing or invalid");
    assert.ok(res !== null && typeof res === "object");
    const refused = res as SandboxExecRefusedResult;
    assert.equal(refused.status, "refused");
    assert.equal(refused.code, "ROLE_REQUIRED");
    assert.ok(refused.error.includes("role is required"));
  }
});

test("R5-A3 Item 5: sandbox_log without limit is refused with required-setting error (default 100 removed)", async () => {
  const logStore = new LogStore({ inMemory: true });
  const logRef = "log-r5a3-limit-test";
  logStore.storeCommandOutput({
    logRef,
    runId: "run-r5a3-test",
    metadata: { skeletonId: "skel-r5a3", runId: "run-r5a3-test" },
    stdout: "line 1\nline 2\nline 3\n",
    stderr: "",
    exitCode: 0,
  });

  const context = createValidContext();

  // 5a. Call without params.limit and without options.defaultLogLimit is refused
  const refusedNoLimit = await handleSandboxLog(
    { log_ref: logRef },
    context,
    { logStore }
  );
  assert.equal(refusedNoLimit.status, "refused");
  assert.equal(refusedNoLimit.code, "MISSING_LOG_LIMIT_SETTING");
  assert.ok(refusedNoLimit.error?.includes("defaultLogLimit"));

  // 5b. Invalid params.limit (zero, negative, non-integer) is refused
  const invalidLimits = [0, -10, 1.5, NaN, "10"];
  for (const badLimit of invalidLimits) {
    const res = await handleSandboxLog(
      { log_ref: logRef, limit: badLimit as any },
      context,
      { logStore }
    );
    assert.equal(res.status, "refused");
    assert.equal(res.code, "INVALID_LIMIT");
  }

  // 5c. Call with explicit params.limit succeeds
  const callWithLimit = await handleSandboxLog(
    { log_ref: logRef, limit: 2 },
    context,
    { logStore }
  );
  assert.equal(callWithLimit.status, "finished");
  assert.equal(callWithLimit.limit, 2);
  assert.equal(callWithLimit.exit_code, 0);

  // 5d. Call without params.limit but with options.defaultLogLimit succeeds using admin setting
  const callWithAdminLimit = await handleSandboxLog(
    { log_ref: logRef },
    context,
    { logStore, defaultLogLimit: 15 }
  );
  assert.equal(callWithAdminLimit.status, "finished");
  assert.equal(callWithAdminLimit.limit, 15);
  assert.equal(callWithAdminLimit.exit_code, 0);
});

test("R5-A3 Item 6: missing LogStore configuration is refused with CONFIGURATION_ERROR (in-memory fallback removed)", async () => {
  const context = createValidContext();

  // 6a. handleSandboxExec without logStore is refused with CONFIGURATION_ERROR
  const execNoStore = (await handleSandboxExec(
    { argv: ["git", "status"] },
    context,
    {
      defaultTimeoutMs: 60000,
      runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
    }
  )) as SandboxExecRefusedResult;

  assert.equal(execNoStore.status, "refused");
  assert.equal(execNoStore.code, "CONFIGURATION_ERROR");
  assert.ok(execNoStore.error.includes("LogStore"));

  // 6b. handleSandboxLog without logStore is refused with CONFIGURATION_ERROR
  const logNoStore = await handleSandboxLog(
    { log_ref: "log-dummy-ref", limit: 10 },
    context,
    { defaultLogLimit: 10 }
  );

  assert.equal(logNoStore.status, "refused");
  assert.equal(logNoStore.code, "CONFIGURATION_ERROR");
  assert.ok(logNoStore.error?.includes("LogStore"));
});
