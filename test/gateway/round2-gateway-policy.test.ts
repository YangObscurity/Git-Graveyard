// Round 2 Tests: MCP gateway and command policy fixes
// Rules 1 to 7: One test per rule with fake sandboxes only

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpGateway } from "../../lib/gateway/mcp-gateway";
import { ApprovalManager, ConfigurationError } from "../../lib/gateway/approval-manager";
import { EventStore } from "../../lib/events/event-store";
import { LogStore } from "../../lib/events/log-store";
import { checkHardBlocks } from "../../lib/gateway/command-policy";
import type {
  ExecutionBackend,
  ExecRequest,
  ExecResult,
  Sandbox,
} from "../../lib/backend/types";
import type {
  SandboxExecFatalResult,
  SandboxExecRefusedResult,
  SandboxExecCompletedResult,
} from "../../lib/gateway/types";

/**
 * Creates a fake sandbox for testing without real execution.
 */
function createFakeSandbox(boxName: "runbox" | "auditbox", onRun?: (req: ExecRequest) => void): {
  sandbox: Sandbox;
  getExecCount: () => number;
  getLastRequest: () => ExecRequest | null;
} {
  let execCount = 0;
  let lastRequest: ExecRequest | null = null;

  const sandbox: Sandbox = {
    id: `fake-${boxName}-${Date.now()}`,
    run: async (req: ExecRequest): Promise<ExecResult> => {
      execCount++;
      lastRequest = req;
      if (onRun) {
        onRun(req);
      }
      return {
        logRef: `log-${boxName}-${execCount}`,
        oomKilled: false,
        exitCode: 0,
        stdoutTail: `Executed in fake ${boxName}: ${req.argv.join(" ")}`,
        stderrTail: "",
        truncated: false,
        timedOut: false,
      };
    },
    exec: async (req: ExecRequest) => {
      execCount++;
      lastRequest = req;
      if (onRun) {
        onRun(req);
      }
      return {
        output: (async function* () {
          yield { seq: 1, stream: "stdout" as const, data: `Fake exec in ${boxName}` };
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
    getLastRequest: () => lastRequest,
  };
}

function createFakeBackend(runboxMock: Sandbox, auditboxMock: Sandbox): ExecutionBackend {
  return {
    kind: "instabox-docker",
    create: async (spec) => (spec.role === "Warden" ? auditboxMock : runboxMock),
    get: async () => runboxMock,
    destroy: async () => {},
  };
}

// Rule 1: Remove commandRunner injection path; sandbox_exec runs only through sandbox
test("Rule 1: sandbox_exec runs only through the sandbox and commandRunner injection is removed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rule1-"));
  try {
    const runboxMock = createFakeSandbox("runbox");
    const auditboxMock = createFakeSandbox("auditbox");
    const backend = createFakeBackend(runboxMock.sandbox, auditboxMock.sandbox);

    const gw = new McpGateway({
      defaultTimeoutMs: 60000,
      approvalWaitMs: 300000,
      logStore: new LogStore({ inMemory: true }),
      backend,
      runbox: runboxMock.sandbox,
      auditbox: auditboxMock.sandbox,
    });

    const skel = gw.registerSkeleton({
      skeletonId: "skel-rule1",
      role: "Soul-stitcher",
      worktreeRoot: tmpDir,
      runId: "run-rule1",
    });

    const res = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: tmpDir,
    })) as SandboxExecCompletedResult;

    assert.equal(res.status, "completed");
    assert.equal(runboxMock.getExecCount(), 1);
    assert.ok(runboxMock.getLastRequest()?.argv.includes("git"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Rule 2: NO_SANDBOX_AVAILABLE is returned before command.started is emitted
test("Rule 2: NO_SANDBOX_AVAILABLE is returned before command.started is emitted", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rule2-"));
  try {
    const eventStore = new EventStore(":memory:");
    // Gateway with no backend or sandboxes configured
    const gw = new McpGateway({
      defaultTimeoutMs: 60000,
      approvalWaitMs: 300000,
      logStore: new LogStore({ inMemory: true }),
      eventStore,
    });

    const skel = gw.registerSkeleton({
      skeletonId: "skel-rule2",
      role: "Soul-stitcher",
      worktreeRoot: tmpDir,
      runId: "run-rule2",
    });

    const res = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: tmpDir,
    })) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "NO_SANDBOX_AVAILABLE");

    // Verify command.started was NEVER emitted
    const startedEvents = eventStore.getEvents("run-rule2", { kind: "command.started" });
    assert.equal(startedEvents.length, 0, "command.started must not be emitted when no sandbox is available");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Rule 3: Secret scan enumerates worktree files itself; empty params.files never skips scan; params.files can add files
test("Rule 3: secret scan does not depend on caller; empty files never skips scan, and files adds files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rule3-"));
  try {
    const runboxMock = createFakeSandbox("runbox");
    const auditboxMock = createFakeSandbox("auditbox");
    const gw = new McpGateway({
      defaultTimeoutMs: 60000,
      approvalWaitMs: 300000,
      logStore: new LogStore({ inMemory: true }),
      runbox: runboxMock.sandbox,
      auditbox: auditboxMock.sandbox,
    });

    const skel = gw.registerSkeleton({
      skeletonId: "skel-rule3",
      role: "Soul-stitcher",
      worktreeRoot: tmpDir,
      runId: "run-rule3",
    });

    // Subcase 3a: Write a secret directly on disk in worktreeRoot. Pass files: [] (empty array).
    const secretOnDisk = path.join(tmpDir, "secret.env");
    fs.writeFileSync(secretOnDisk, "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE123\n");

    const res1 = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: tmpDir,
      files: [], // Empty array must NOT bypass secret scan
    })) as SandboxExecRefusedResult;

    assert.equal(res1.status, "refused");
    assert.equal(res1.code, "SECRET_DETECTED");
    assert.equal(runboxMock.getExecCount(), 0, "No process started when secret scan fails");

    // Clean up disk secret
    fs.unlinkSync(secretOnDisk);

    // Subcase 3b: Worktree disk is clean, but params.files includes a path outside with secret
    const externalSecret = path.join(os.tmpdir(), `external-secret-${Date.now()}.txt`);
    fs.writeFileSync(externalSecret, "GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n");

    try {
      const res2 = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
        argv: ["git", "status"],
        cwd: tmpDir,
        files: [externalSecret], // external path refused with PATH_ESCAPE
      })) as SandboxExecRefusedResult;

      assert.equal(res2.status, "refused");
      assert.equal(res2.code, "PATH_ESCAPE");
    } finally {
      if (fs.existsSync(externalSecret)) {
        fs.unlinkSync(externalSecret);
      }
    }

    // Subcase 3c: a secret inside a params.files entry within the worktree is refused with SECRET_DETECTED
    const internalSecret = path.join(tmpDir, "internal-secret.txt");
    fs.writeFileSync(internalSecret, "GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n");

    try {
      const res3 = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
        argv: ["git", "status"],
        cwd: tmpDir,
        files: [internalSecret],
      })) as SandboxExecRefusedResult;

      assert.equal(res3.status, "refused");
      assert.equal(res3.code, "SECRET_DETECTED");
    } finally {
      if (fs.existsSync(internalSecret)) {
        fs.unlinkSync(internalSecret);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Rule 4: timeoutMs below 1 is refused; above Admin max is clamped; zero/negative never disable timeout
test("Rule 4: timeoutMs below 1 is refused, and above Admin max is refused", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rule4-"));
  try {
    const runboxMock = createFakeSandbox("runbox");
    const auditboxMock = createFakeSandbox("auditbox");
    const adminMax = 45000;

    const gw = new McpGateway({
      defaultTimeoutMs: adminMax,
      approvalWaitMs: 300000,
      logStore: new LogStore({ inMemory: true }),
      runbox: runboxMock.sandbox,
      auditbox: auditboxMock.sandbox,
    });

    const skel = gw.registerSkeleton({
      skeletonId: "skel-rule4",
      role: "Soul-stitcher",
      worktreeRoot: tmpDir,
      runId: "run-rule4",
    });

    // 4a. Zero timeoutMs is refused
    const resZero = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: tmpDir,
      timeoutMs: 0,
    })) as SandboxExecRefusedResult;
    assert.equal(resZero.status, "refused");
    assert.equal(resZero.code, "INVALID_TIMEOUT");

    // 4b. Negative timeoutMs is refused
    const resNegative = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: tmpDir,
      timeoutMs: -500,
    })) as SandboxExecRefusedResult;
    assert.equal(resNegative.status, "refused");
    assert.equal(resNegative.code, "INVALID_TIMEOUT");

    // 4c. timeoutMs exceeding Admin max is refused
    const resClamped = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: tmpDir,
      timeoutMs: 999999,
    })) as SandboxExecRefusedResult;
    assert.equal(resClamped.status, "refused");
    assert.equal(resClamped.code, "INVALID_TIMEOUT");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Rule 5: Post-exec scan quarantines worktree, terminates skeleton, fails run, and returns fatal result
test("Rule 5: post-exec scan failure quarantines worktree, fails run, and reports fatal result", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rule5-"));
  try {
    const eventStore = new EventStore(":memory:");
    // Sandbox simulates a command that drops a secret into the worktree
    const runboxMock = createFakeSandbox("runbox", () => {
      fs.writeFileSync(
        path.join(tmpDir, "leaked_secret.txt"),
        "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE456\n"
      );
    });
    const auditboxMock = createFakeSandbox("auditbox");

    const gw = new McpGateway({
      defaultTimeoutMs: 60000,
      approvalWaitMs: 300000,
      logStore: new LogStore({ inMemory: true }),
      eventStore,
      runbox: runboxMock.sandbox,
      auditbox: auditboxMock.sandbox,
    });

    const skel = gw.registerSkeleton({
      skeletonId: "skel-rule5",
      role: "Soul-stitcher",
      worktreeRoot: tmpDir,
      runId: "run-rule5",
    });

    const fatalRes = (await gw.handleToolCall(skel.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: tmpDir,
    })) as SandboxExecFatalResult;

    assert.equal(fatalRes.status, "fatal");
    assert.equal(fatalRes.fatal, true);
    assert.equal(fatalRes.quarantine, true);
    assert.equal(fatalRes.code, "SECRET_DETECTED");

    // Events emitted: skeleton.state (failed, quarantined) and run.done (failed, quarantined)
    const skelEvents = eventStore.getEvents("run-rule5", { kind: "skeleton.state" });
    assert.ok(skelEvents.length > 0);
    const lastSkelEvent = skelEvents[skelEvents.length - 1];
    assert.equal((lastSkelEvent.data as any).state, "failed");
    assert.equal((lastSkelEvent.data as any).quarantine, true);

    const doneEvents = eventStore.getEvents("run-rule5", { kind: "run.done" });
    assert.ok(doneEvents.length > 0);
    assert.equal((doneEvents[0].data as any).outcome, "quarantined");
    assert.equal((doneEvents[0].data as any).quarantine, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Rule 6: Environment-dump detection blocks wrappers and interpreter flags
test("Rule 6: environment-dump detection blocks bash -lc, wrapped sh -c, node -p, python -c, perl -e, declare -x", () => {
  const envDumpCommands: string[][] = [
    ["bash", "-lc", "echo test"],
    ["bash", "-l", "-c", "echo test"],
    ["timeout", "10", "sh", "-c", "env"],
    ["env", "FOO=1", "sh", "-c", "printenv"],
    ["nice", "-n", "5", "sh", "-c", "printenv"],
    ["node", "-p", "process.env"],
    ["node", "-e", "console.log(process.env)"],
    ["python", "-c", "import os; print(os.environ)"],
    ["python3", "-c", "print(environ)"],
    ["perl", "-e", "print $ENV{PATH}"],
    ["declare", "-x"],
    ["declare", "-x", "FOO=bar"],
  ];

  for (const argv of envDumpCommands) {
    const check = checkHardBlocks(argv);
    assert.equal(
      check.blocked,
      true,
      `Expected argv to be blocked as env dump: ${argv.join(" ")}`
    );
    assert.equal(check.ruleId, "hard-block-env-dump");
  }
});

// Rule 7: McpGateway and ApprovalManager require settings without hard-coded production defaults
test("Rule 7: McpGateway and ApprovalManager throw ConfigurationError when required settings are missing", () => {
  // 7a. ApprovalManager throws when defaultWaitMs is missing or invalid
  assert.throws(
    () => new ApprovalManager({} as any),
    (err: any) => err instanceof ConfigurationError && err.message.includes("defaultWaitMs")
  );
  assert.throws(
    () => new ApprovalManager({ defaultWaitMs: 0 }),
    (err: any) => err instanceof ConfigurationError && err.message.includes("defaultWaitMs")
  );
  assert.throws(
    () => new ApprovalManager({ defaultWaitMs: -1 }),
    (err: any) => err instanceof ConfigurationError && err.message.includes("defaultWaitMs")
  );

  // 7b. McpGateway throws when defaultTimeoutMs is missing or invalid
  assert.throws(
    () => new McpGateway({ approvalWaitMs: 300000 } as any),
    (err: any) => err instanceof ConfigurationError && err.message.includes("defaultTimeoutMs")
  );
  assert.throws(
    () => new McpGateway({ defaultTimeoutMs: 0, approvalWaitMs: 300000 } as any),
    (err: any) => err instanceof ConfigurationError && err.message.includes("defaultTimeoutMs")
  );

  // 7c. McpGateway throws when approvalWaitMs is missing or invalid
  assert.throws(
    () => new McpGateway({ defaultTimeoutMs: 60000 } as any),
    (err: any) => err instanceof ConfigurationError && err.message.includes("approvalWaitMs")
  );
  assert.throws(
    () => new McpGateway({ defaultTimeoutMs: 60000, approvalWaitMs: 0 } as any),
    (err: any) => err instanceof ConfigurationError && err.message.includes("approvalWaitMs")
  );

  // 7d. Valid settings construct successfully
  const validMgr = new ApprovalManager({ defaultWaitMs: 300000 });
  assert.ok(validMgr);

  const validGw = new McpGateway({ defaultTimeoutMs: 60000, approvalWaitMs: 300000, logStore: new LogStore({ inMemory: true }) });
  assert.ok(validGw);
});
