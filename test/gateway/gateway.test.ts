// Task 10.3 / 10.4 / 10.5 / 10.6 / 10.7 Tests
// Requirements: 19.1-19.19, 20.1-20.14, 29.10-29.12

import test from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fc from "fast-check";
import {
  McpGateway,
  classifyCommand,
  commandPolicyClassifier,
  classifyArgv,
  checkHardBlocks,
  checkAllowedRules,
  checkDisallowedHosts,
  getCommittedPolicy,
  formatPolicyForAdmin,
  isInsideWorktree,
  ApprovalManager,
  sha256Argv,
  handleSandboxExec,
  handleSandboxLog,
  handleReportTaskResult,
  handleWardenVerdict,
  handleAsk,
  handleReportBlocker,
  handleProposeTask,
  handleAckMessage,
  isRoleAuthorizedForTool,
  normalizeRole,
  ALLOWED_MCP_TOOLS_BY_ROLE,
} from "../../lib/gateway/index";
import { LogStore } from "../../lib/events/log-store";
import { RunStore } from "../../lib/runs/run-store";

test("Command Policy: committed policy file and admin view (Requirements 20.1, 20.2)", () => {
  const policy = getCommittedPolicy();
  assert.equal(policy.version, "1.0.0");
  assert.ok(policy.allowedCommands.length > 0);
  assert.ok(policy.hardBlockRules.length > 0);
  assert.ok(policy.egressAllowlist.includes("registry.npmjs.org"));
  assert.ok(policy.egressAllowlist.includes("pypi.org"));
  assert.ok(policy.egressAllowlist.includes("github.com"));

  const adminView = formatPolicyForAdmin();
  assert.equal(adminView.version, "1.0.0");
  assert.ok(adminView.summary.includes("allowed command rules"));
  assert.equal(adminView.allowedCount, policy.allowedCommands.length);
  assert.equal(adminView.hardBlockCount, policy.hardBlockRules.length);
});

test("Command Policy: allowed inside-worktree commands (Requirement 20.3)", () => {
  const allowedCommands: string[][] = [
    ["git", "status"],
    ["git", "status", "-s"],
    ["git", "diff"],
    ["git", "diff", "HEAD"],
    ["git", "log"],
    ["git", "log", "-n", "5"],
    ["git", "add", "."],
    ["git", "add", "-A"],
    ["git", "commit", "-m", "fix bug"],
    ["git", "checkout", "-b", "feature-1"],
    ["npm", "ci"],
    ["npm", "ci", "--ignore-scripts"],
    ["npm", "install"],
    ["npm", "install", "--ignore-scripts"],
    ["npm", "i"],
    ["pip", "install", "-r", "requirements.txt"],
    ["pip3", "install", "-r", "requirements.txt"],
    ["poetry", "install"],
    ["npm", "run", "build"],
    ["npm", "run", "test"],
    ["npm", "test"],
    ["npm", "run", "lint"],
    ["npm", "run", "typecheck"],
    ["pytest"],
    ["pytest", "-v"],
    ["python", "-m", "pytest"],
    ["python3", "-m", "pytest"],
    ["python", "-m", "unittest", "discover"],
    ["python3", "-m", "unittest"],
    ["node", "-v"],
    ["node", "--version"],
    ["npm", "-v"],
    ["python", "--version"],
    ["git", "--version"],
  ];

  for (const argv of allowedCommands) {
    const res = classifyCommand(argv);
    assert.equal(
      res.classification,
      "allowed",
      `Expected allowed for: ${argv.join(" ")}, got ${res.classification} (${res.reason})`
    );
  }
});

test("Command Policy: Hard_Block classification (Requirements 20.4, 29.10, 29.11, 29.12)", () => {
  const blockedCommands: Array<{ argv: string[]; label: string }> = [
    { argv: ["sudo", "apt", "install", "curl"], label: "sudo binary" },
    { argv: ["doas", "sh"], label: "doas privilege escalation" },
    { argv: ["su", "-"], label: "su privilege escalation" },
    { argv: ["sh", "-c", "sudo whoami"], label: "sudo in arguments" },
    { argv: ["echo", "KIRO_API_KEY=secret"], label: "Kiro API key" },
    { argv: ["cat", "kiro-api-key.txt"], label: "kiro-api-key filename" },
    { argv: ["echo", "ksk_abcdef1234567890"], label: "ksk canary token" },
    { argv: ["echo", "GITHUB_TOKEN=ghp_token"], label: "GITHUB_TOKEN env" },
    { argv: ["echo", "ghp_123456789012345678901234567890"], label: "ghp token string" },
    { argv: ["echo", "github_pat_12345678901234567890_abcdef"], label: "github_pat token string" },
    { argv: ["env"], label: "standalone env command" },
    { argv: ["printenv"], label: "standalone printenv command" },
    { argv: ["cat", "/proc/self/environ"], label: "proc self environ" },
    { argv: ["cat", "/proc/1/environ"], label: "proc 1 environ" },
    { argv: ["cat", "~/.ssh/id_rsa"], label: "ssh id_rsa" },
    { argv: ["cat", "/root/.ssh/authorized_keys"], label: "ssh authorized_keys" },
    { argv: ["ls", "~/.ssh"], label: "dot ssh directory" },
    { argv: ["curl", "http://169.254.169.254/latest/meta-data"], label: "cloud metadata IP" },
    { argv: ["curl", "http://metadata.google.internal/computeMetadata/v1/"], label: "metadata dns" },
    { argv: ["cat", "/var/run/docker.sock"], label: "docker socket" },
    { argv: ["cat", "/run/containerd/containerd.sock"], label: "containerd socket" },
    { argv: ["ls", "/host"], label: "host mount path" },
    { argv: ["cat", "/proc/cpuinfo"], label: "proc filesystem" },
    { argv: ["cat", "/sys/class"], label: "sys filesystem" },
    { argv: ["cat", "/dev/sda"], label: "dev filesystem" },
  ];

  for (const item of blockedCommands) {
    const res = classifyCommand(item.argv);
    assert.equal(
      res.classification,
      "blocked",
      `Expected blocked for ${item.label} (${item.argv.join(" ")}), got: ${res.classification}`
    );
    assert.ok(res.reason, `Missing reason for ${item.label}`);
  }
});

test("Command Policy: commands naming hosts outside egress allowlist classify as needs_approval (Requirement 20.5)", () => {
  const externalCommands: string[][] = [
    ["curl", "https://unauthorized-domain.com/setup.sh"],
    ["wget", "http://random-server.net/archive.tar.gz"],
    ["npm", "install", "--registry", "https://custom-registry.org"],
  ];

  for (const argv of externalCommands) {
    const res = classifyCommand(argv);
    assert.equal(
      res.classification,
      "needs_approval",
      `Expected needs_approval for external host: ${argv.join(" ")}`
    );
  }
});

test("Command Policy: unclassified commands and outside-worktree commands default to needs_approval (Requirement 20.5)", () => {
  const genericCommands: string[][] = [
    ["make"],
    ["bash", "build.sh"],
    ["gcc", "main.c"],
    ["python", "script.py"],
  ];

  for (const argv of genericCommands) {
    const res = classifyCommand(argv);
    assert.equal(
      res.classification,
      "needs_approval",
      `Expected needs_approval for generic command: ${argv.join(" ")}`
    );
  }

  // Outside worktree
  const outsideRes = classifyCommand(["git", "status"], {
    cwd: "/some/other/path",
    worktreeRoot: "/workspace/repo",
  });
  assert.equal(outsideRes.classification, "needs_approval");
});

test("ApprovalManager: one-time grant binding, expiration, and pattern approvals (Requirements 20.6-20.9, 20.14)", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const mgr = new ApprovalManager({
    defaultWaitMs: 1000,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const runId = "run-appr-1";
  const skeletonId = "skel-soul-1";
  const argv = ["bash", "build.sh"];
  const cwd = "/workspace/repo";

  // Request approval emits approval.requested
  const req = await mgr.requestApproval(runId, skeletonId, argv, cwd, 500);
  assert.ok(req.approvalId.startsWith("appr-"));
  assert.equal(req.status, "approval_pending");
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "approval.requested");

  // One-time grant creation
  const grant = mgr.grantOnce(skeletonId, argv, cwd, 500);
  assert.equal(grant.skeletonId, skeletonId);
  assert.equal(grant.argvSha256, sha256Argv(argv));

  // First check consumes the grant
  const consumedFirst = mgr.consumeGrant(skeletonId, argv, cwd);
  assert.equal(consumedFirst, true);

  // Second check fails (grant used at most once)
  const consumedSecond = mgr.consumeGrant(skeletonId, argv, cwd);
  assert.equal(consumedSecond, false);

  // Expired grant is void
  const expiredGrant = mgr.grantOnce(skeletonId, ["make"], cwd, -10);
  assert.equal(mgr.consumeGrant(skeletonId, ["make"], cwd), false);

  // Pattern approvals for the run
  mgr.addPatternApproval(runId, "npm run extra-task");
  assert.equal(mgr.isPatternApproved(runId, ["npm", "run", "extra-task"]), true);
  assert.equal(mgr.isPatternApproved("other-run", ["npm", "run", "extra-task"]), false);
});

test("MCP Gateway: per-Skeleton bearer tokens and role validation (Requirements 19.1-19.4)", async () => {
  const gw = new McpGateway({ defaultTimeoutMs: 60000, approvalWaitMs: 300000, logStore: new LogStore({ inMemory: true }) });

  // Register Skeletons of different roles
  const exhumer = gw.registerSkeleton({
    skeletonId: "skel-exhumer",
    role: "Exhumer",
    worktreeRoot: "/worktree/root",
  });
  const bonesetter = gw.registerSkeleton({
    skeletonId: "skel-bonesetter",
    role: "Bonesetter",
    worktreeRoot: "/worktree/root",
  });
  const soulStitcher = gw.registerSkeleton({
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    worktreeRoot: "/worktree/root",
  });
  const warden = gw.registerSkeleton({
    skeletonId: "skel-warden",
    role: "Warden",
    worktreeRoot: "/worktree/root",
  });
  const planner = gw.registerSkeleton({
    skeletonId: "skel-planner",
    role: "Planner",
    worktreeRoot: "/worktree/root",
  });
  const scribe = gw.registerSkeleton({
    skeletonId: "skel-scribe",
    role: "Scribe",
    worktreeRoot: "/worktree/root",
  });

  // Verify connection tracking
  assert.equal(gw.isSkeletonConnected("skel-exhumer"), true);
  assert.equal(gw.isSkeletonConnected("unknown-skel"), false);

  // Bearer token lookup
  assert.equal(gw.getSkeletonByToken(exhumer.bearerToken)?.skeletonId, "skel-exhumer");
  assert.equal(gw.getSkeletonByToken("Bearer " + exhumer.bearerToken)?.skeletonId, "skel-exhumer");
  assert.equal(gw.getSkeletonByToken("invalid-token"), undefined);

  // Refusal on invalid bearer token
  const invalidAuthRes = (await gw.handleToolCall("bad-token", "sandbox_log", { log_ref: "abc" })) as {
    status: string;
    code: string;
  };
  assert.equal(invalidAuthRes.status, "refused");
  assert.equal(invalidAuthRes.code, "UNAUTHORIZED");

  // Role permissions: sandbox_exec allowed for Exhumer, Bonesetter, Soul-stitcher, Warden; forbidden for Planner, Scribe
  assert.equal(isRoleAuthorizedForTool("Exhumer", "sandbox_exec"), true);
  assert.equal(isRoleAuthorizedForTool("Bonesetter", "sandbox_exec"), true);
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "sandbox_exec"), true);
  assert.equal(isRoleAuthorizedForTool("Warden", "sandbox_exec"), true);
  assert.equal(isRoleAuthorizedForTool("Planner", "sandbox_exec"), false);
  assert.equal(isRoleAuthorizedForTool("Scribe", "sandbox_exec"), false);

  // Role permissions: warden_verdict strictly for Warden
  assert.equal(isRoleAuthorizedForTool("Warden", "warden_verdict"), true);
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "warden_verdict"), false);
  assert.equal(isRoleAuthorizedForTool("Planner", "warden_verdict"), false);

  // Role permissions: propose_task strictly for Soul-stitcher
  assert.equal(isRoleAuthorizedForTool("Soul-stitcher", "propose_task"), true);
  assert.equal(isRoleAuthorizedForTool("Bonesetter", "propose_task"), false);
  assert.equal(isRoleAuthorizedForTool("Warden", "propose_task"), false);

  // Refusal on forbidden role tool call
  const forbiddenCall = (await gw.handleToolCall(planner.bearerToken, "sandbox_exec", {
    argv: ["git", "status"],
  })) as { status: string; code: string };
  assert.equal(forbiddenCall.status, "refused");
  assert.equal(forbiddenCall.code, "FORBIDDEN_ROLE");
});

test("Execution Tools: sandbox_exec routes through command policy and emits events (Requirements 19.5-19.9, 19.19, 20.4, 20.6-20.12)", async () => {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const logStore = new LogStore({ inMemory: true });
  let sweeperCalls = 0;
  let sweptPgid: number | string | undefined;

  const fakeRunbox = {
    run: async (req: { argv: string[]; cwd: string }) => ({
      exitCode: 0,
      stdoutTail: `executed ${req.argv.join(" ")} in runbox`,
      stderrTail: "",
      timedOut: false,
    }),
  };
  const fakeAuditbox = {
    run: async (req: { argv: string[]; cwd: string }) => ({
      exitCode: 0,
      stdoutTail: `executed ${req.argv.join(" ")} in auditbox`,
      stderrTail: "",
      timedOut: false,
    }),
  };

  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore,
    runbox: fakeRunbox as any,
    auditbox: fakeAuditbox as any,
    onEmitEvent: (evt) => {
      events.push(evt);
    },
    processSweeper: (pgid) => {
      sweeperCalls += 1;
      sweptPgid = pgid;
    },
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-soul",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-test-exec",
  });

  const warden = gw.registerSkeleton({
    skeletonId: "skel-warden",
    role: "Warden",
    worktreeRoot: "/workspace/repo",
    runId: "run-test-exec",
  });

  // 1. Refuse call if cwd is outside worktree (Requirement 19.5)
  const outsideRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv: ["git", "status"],
    cwd: "/etc",
  })) as { status: string; code: string };
  assert.equal(outsideRes.status, "refused");
  assert.equal(outsideRes.code, "CWD_OUTSIDE_WORKTREE");

  // 2. Hard-blocked command starts no process, emits command.refused, returns status blocked (Requirement 20.10)
  events.length = 0;
  const blockedRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv: ["sudo", "rm", "-rf", "/"],
    cwd: "/workspace/repo",
  })) as { status: string; reason: string };
  assert.equal(blockedRes.status, "blocked");
  assert.ok(blockedRes.reason.includes("sudo"));
  assert.equal(events.some((e) => e.kind === "command.refused"), true);

  // 3. Needs-approval command returns approval_pending and emits approval.requested (Requirement 20.6)
  events.length = 0;
  const apprRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv: ["bash", "compile.sh"],
    cwd: "/workspace/repo",
  })) as { status: string; approvalId: string };
  assert.equal(apprRes.status, "approval_pending");
  assert.ok(apprRes.approvalId);
  assert.equal(events.some((e) => e.kind === "approval.requested"), true);

  // 4. Once approved, command executes and emits command.started, command.result (Requirement 19.19, 20.7)
  gw.approvalManager.grantOnce("skel-soul", ["bash", "compile.sh"], "/workspace/repo");
  events.length = 0;
  const execApprRes = (await gw.handleToolCall(soul.bearerToken, "sandbox_exec", {
    argv: ["bash", "compile.sh"],
    cwd: "/workspace/repo",
  })) as { status: string; exit_code: number; log_ref: string; stdout_tail: string };
  assert.equal(execApprRes.status, "completed");
  assert.equal(execApprRes.exit_code, 0);
  assert.ok(execApprRes.stdout_tail.includes("executed bash compile.sh in runbox"));
  // SB4a (Audit N-B8): the sweeper receives only the command's pgid, never a user name
  assert.equal(sweeperCalls, 1);
  assert.equal(sweptPgid, undefined);
  assert.equal(events.some((e) => e.kind === "command.started"), true);
  assert.equal(events.some((e) => e.kind === "command.result"), true);

  // 5. Allowed command runs in runbox for builder, auditbox for Warden (Requirement 19.6)
  const wardenRes = (await gw.handleToolCall(warden.bearerToken, "sandbox_exec", {
    argv: ["git", "status"],
    cwd: "/workspace/repo",
  })) as { status: string; stdout_tail: string; log_ref: string };
  assert.equal(wardenRes.status, "completed");
  assert.ok(wardenRes.stdout_tail.includes("in auditbox"));
  assert.equal(sweeperCalls, 2);
  assert.equal(sweptPgid, undefined);

  // 6. Test sandbox_log reading slices from logStore (Requirement 19.10)
  const logSliceRes = (await gw.handleToolCall(warden.bearerToken, "sandbox_log", {
    log_ref: wardenRes.log_ref,
    offset: 0,
    limit: 10,
  })) as { status: string; slice: string; exit_code: number };
  assert.equal(logSliceRes.status, "finished");
  assert.equal(logSliceRes.exit_code, 0);
  assert.ok(logSliceRes.slice.includes("in auditbox"));
});

test("Collaboration Tools: report_task_result, warden_verdict, ask, report_blocker, propose_task, ack_message (Requirements 19.11-19.18)", async () => {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    onEmitEvent: (evt) => {
      events.push(evt);
    },
  });

  const warden = gw.registerSkeleton({
    skeletonId: "skel-w",
    role: "Warden",
    runId: "run-collab",
    worktreeRoot: "/workspace/repo",
  });

  const soul = gw.registerSkeleton({
    skeletonId: "skel-s",
    role: "Soul-stitcher",
    runId: "run-collab",
    worktreeRoot: "/workspace/repo",
  });

  // ask: returns immediately with "recorded; end your turn" (Requirement 19.11)
  const askRes = (await gw.handleToolCall(soul.bearerToken, "ask", {
    question: "Should I update package-lock.json?",
  })) as { message: string; recorded: boolean };
  assert.equal(askRes.message, "recorded; end your turn");
  assert.equal(askRes.recorded, true);

  // warden_verdict: validates presence of target, verdict, reasons with refs, and candidateSha256 (Requirement 19.12)
  const invalidVerdict = (await gw.handleToolCall(warden.bearerToken, "warden_verdict", {
    target: "task-1",
    verdict: "approve",
    // missing reasons and candidateSha256
  })) as { status: string; code: string };
  assert.equal(invalidVerdict.status, "refused");

  const validVerdict = (await gw.handleToolCall(warden.bearerToken, "warden_verdict", {
    target: "task-1",
    verdict: "approve",
    reasons: [{ text: "All tests pass", refs: ["test:12"] }],
    candidateSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  })) as { success: boolean; verdict: string };
  assert.equal(validVerdict.success, true);
  assert.equal(validVerdict.verdict, "approve");

  // report_task_result (Requirement 19.17)
  const taskRes = (await gw.handleToolCall(soul.bearerToken, "report_task_result", {
    taskId: "T10.3",
    status: "completed",
    summary: "MCP gateway handlers implemented",
    refs: ["lib/gateway/mcp-gateway.ts"],
  })) as { success: boolean; taskId: string };
  assert.equal(taskRes.success, true);
  assert.equal(taskRes.taskId, "T10.3");

  // report_blocker (Requirement 19.15)
  const blockerRes = (await gw.handleToolCall(soul.bearerToken, "report_blocker", {
    text: "Dependency not found",
    kind: "missing_dependency",
  })) as { recorded: boolean };
  assert.equal(blockerRes.recorded, true);

  // propose_task (Requirement 19.13)
  const propRes = (await gw.handleToolCall(soul.bearerToken, "propose_task", {
    title: "Add extra tests",
  })) as { recorded: boolean; proposalId: string };
  assert.equal(propRes.recorded, true);
  assert.ok(propRes.proposalId);

  // ack_message (Requirement 19.16)
  const ackRes = (await gw.handleToolCall(soul.bearerToken, "ack_message", {
    msgId: "msg-123",
  })) as { acknowledged: boolean; msgId: string };
  assert.equal(ackRes.acknowledged, true);
  assert.equal(ackRes.msgId, "msg-123");
});

test("ApprovalManager: approveRequest and denyRequest resolution workflow (Requirements 20.6, 20.7, 20.14)", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const mgr = new ApprovalManager({
    defaultWaitMs: 5000,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const runId = "run-flow-1";
  const skeletonId = "skel-soul-1";
  const argv = ["gcc", "-O3", "main.c"];
  const cwd = "/workspace/repo";

  // 1. Request approval -> status approval_pending, emits approval.requested
  const req1 = await mgr.requestApproval(runId, skeletonId, argv, cwd);
  assert.equal(req1.status, "approval_pending");
  assert.ok(req1.approvalId.startsWith("appr-"));
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "approval.requested");

  // 2. approveRequest creates a one-time grant, marks status approved, emits approval.resolved
  const grant = await mgr.approveRequest(req1.approvalId, { resolvedBy: "user" });
  assert.ok(grant);
  assert.equal(grant.skeletonId, skeletonId);
  assert.equal(grant.argvSha256, sha256Argv(argv));
  assert.equal(emittedEvents.length, 2);
  assert.equal(emittedEvents[1].kind, "approval.resolved");
  assert.equal(emittedEvents[1].data.decision, "approved");

  // Grant can be consumed exactly once
  assert.equal(mgr.consumeGrant(skeletonId, argv, cwd), true);
  assert.equal(mgr.consumeGrant(skeletonId, argv, cwd), false);

  // 3. Second request: denyRequest marks status denied, emits approval.resolved with instruction
  emittedEvents.length = 0;
  const req2 = await mgr.requestApproval(runId, skeletonId, ["rm", "-rf", "/tmp/build"], cwd);
  const deniedReq = await mgr.denyRequest(req2.approvalId, "Unsafe directory removal");
  assert.ok(deniedReq);
  assert.equal(deniedReq.status, "denied");
  assert.ok(deniedReq.instruction?.includes("re-plan"));
  assert.equal(emittedEvents.some((e) => e.kind === "approval.resolved" && e.data.decision === "denied"), true);

  // Denied command cannot be consumed
  assert.equal(mgr.consumeGrant(skeletonId, ["rm", "-rf", "/tmp/build"], cwd), false);
});

test("ApprovalManager: deadline expiration and treating unanswered requests as denied (Requirement 20.14)", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const mgr = new ApprovalManager({
    defaultWaitMs: 10,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const runId = "run-timeout-1";
  const skeletonId = "skel-soul-2";
  const argv = ["cargo", "build"];
  const cwd = "/workspace/repo";

  // Request approval with expired ttl
  const req = await mgr.requestApproval(runId, skeletonId, argv, cwd, -10);
  assert.equal(mgr.isRequestExpired(req.approvalId), true);

  // handleExpiredRequest treats unanswered request as denied and returns instruction
  const expired = await mgr.handleExpiredRequest(req.approvalId);
  assert.ok(expired);
  assert.equal(expired.status, "denied");
  assert.ok(expired.instruction.includes("re-plan"));
  assert.equal(emittedEvents.some((e) => e.kind === "approval.resolved" && e.data.decision === "denied"), true);

  // Cannot approve an already expired request
  const lateGrant = await mgr.approveRequest(req.approvalId);
  assert.equal(lateGrant, null);

  // expireUnansweredRequests sweeps multiple expired requests
  const req2 = await mgr.requestApproval(runId, skeletonId, ["make", "clean"], cwd, -5);
  const req3 = await mgr.requestApproval(runId, skeletonId, ["make", "all"], cwd, -5);
  const swept = await mgr.expireUnansweredRequests(runId);
  assert.equal(swept.length, 2);
  assert.equal(swept[0].status, "denied");
  assert.equal(swept[1].status, "denied");
});

test("ApprovalManager: RunStore integration for run-scoped pattern approvals (Requirement 20.9)", async () => {
  const runStore = new RunStore(":memory:");
  const runId = "run-store-test-1";
  runStore.createRun({
    runId,
    url: "https://github.com/test-owner/test-repo",
    sha: "0123456789abcdef",
  });

  const mgr = new ApprovalManager({
    defaultWaitMs: 300000,
    runStore,
  });

  // Add pattern approval for the run
  mgr.addPatternApproval(runId, "python -m unittest *");

  // Checks pattern approval using RunStore
  assert.equal(
    mgr.isPatternApproved(runId, ["python", "-m", "unittest", "discover"]),
    true
  );
  assert.equal(
    mgr.isPatternApproved(runId, ["python", "-m", "unittest", "test_foo.py"]),
    true
  );
  assert.equal(
    mgr.isPatternApproved("other-run", ["python", "-m", "unittest", "discover"]),
    false
  );
  assert.equal(
    mgr.isPatternApproved(runId, ["rm", "-rf", "dist"]),
    false
  );

  // Pattern is persisted in RunStore
  const patternsInDb = runStore.getApprovedPatterns(runId);
  assert.equal(patternsInDb.length, 1);
  assert.equal(patternsInDb[0].pattern, "python -m unittest *");
});

test("ApprovalManager: multiple one-time grants for the same command (Requirement 20.7)", () => {
  const mgr = new ApprovalManager({ defaultWaitMs: 300000 });
  const skeletonId = "skel-soul-3";
  const argv = ["npm", "run", "custom-script"];
  const cwd = "/workspace/repo";

  // User grants approval twice for the same command
  mgr.grantOnce(skeletonId, argv, cwd, 5000);
  mgr.grantOnce(skeletonId, argv, cwd, 5000);

  // First execution: consumed
  assert.equal(mgr.consumeGrant(skeletonId, argv, cwd), true);
  // Second execution: consumed
  assert.equal(mgr.consumeGrant(skeletonId, argv, cwd), true);
  // Third execution: fails (no remaining grants)
  assert.equal(mgr.consumeGrant(skeletonId, argv, cwd), false);
});

test("ApprovalManager: refuseBlockedCommand helper emits command.refused and returns blocked (Requirement 20.10)", async () => {
  const emittedEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const mgr = new ApprovalManager({
    defaultWaitMs: 300000,
    onEmitEvent: (evt) => {
      emittedEvents.push(evt);
    },
  });

  const res = await mgr.refuseBlockedCommand(
    "run-refuse-1",
    "skel-1",
    "Soul-stitcher",
    ["sudo", "su"],
    "Privilege escalation disallowed",
    "hard_block_sudo"
  );

  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "Privilege escalation disallowed");
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].kind, "command.refused");
  assert.equal(emittedEvents[0].data.ruleId, "hard_block_sudo");
});

test("Command Policy: classifier is a pure function over argv arrays (Task 10.5)", () => {
  // Aliases verify equivalence
  assert.equal(commandPolicyClassifier, classifyCommand);
  assert.equal(classifyArgv, classifyCommand);

  const argvSamples: string[][] = [
    ["git", "status"],
    ["npm", "test"],
    ["pytest", "-v"],
    ["curl", "https://example.com"],
    ["sudo", "id"],
    ["printenv"],
    ["python", "-m", "unittest"],
    ["node", "--version"],
  ];

  for (const sample of argvSamples) {
    const originalArgv = [...sample];
    const frozenArgv = Object.freeze([...sample]);

    // Pure function: invocation does not mutate input array
    const res1 = classifyCommand(frozenArgv as string[]);
    assert.deepEqual(sample, originalArgv, "Input argv array must not be mutated");

    // Pure function: repeated invocations produce identical results
    const res2 = classifyCommand(sample);
    const res3 = commandPolicyClassifier(sample);
    assert.deepEqual(res1, res2);
    assert.deepEqual(res1, res3);

    // Classification result carries cloned argv
    assert.deepEqual(res1.argv, originalArgv);
  }
});

test("Command Policy: Hard blocks cannot be overridden by any input or option (Task 10.5, Requirements 20.4, 29.10, 29.11, 29.12)", () => {
  const hardBlockedArgvs: Array<{ argv: string[]; label: string }> = [
    { argv: ["sudo", "whoami"], label: "sudo" },
    { argv: ["SUDO", "apt", "update"], label: "SUDO uppercase" },
    { argv: ["doas", "cat", "/etc/shadow"], label: "doas" },
    { argv: ["su", "root"], label: "su" },
    { argv: ["git", "commit", "-m", "leaked KIRO_API_KEY value"], label: "Kiro API key in git commit" },
    { argv: ["git", "diff", "kiro-api-key.txt"], label: "kiro-api-key in git diff" },
    { argv: ["npm", "run", "test", "ksk_canary_token_1234"], label: "ksk token in npm run test" },
    { argv: ["npm", "install", "GITHUB_TOKEN=secret"], label: "GITHUB_TOKEN in npm install" },
    { argv: ["git", "log", "ghp_123456789012345678901234567890"], label: "ghp token in git log" },
    { argv: ["printenv"], label: "printenv" },
    { argv: ["env"], label: "env" },
    { argv: ["/usr/bin/env"], label: "/usr/bin/env" },
    { argv: ["export"], label: "export" },
    { argv: ["set"], label: "set" },
    { argv: ["cat", "/proc/self/environ"], label: "/proc/self/environ" },
    { argv: ["cat", "/proc/123/environ"], label: "/proc/123/environ" },
    { argv: ["cat", "~/.ssh/id_rsa"], label: "~/.ssh/id_rsa" },
    { argv: ["ls", ".ssh"], label: ".ssh directory" },
    { argv: ["cat", "id_ed25519"], label: "id_ed25519" },
    { argv: ["cat", "authorized_keys"], label: "authorized_keys" },
    { argv: ["cat", "known_hosts"], label: "known_hosts" },
    { argv: ["curl", "http://169.254.169.254/latest/meta-data"], label: "169.254.169.254" },
    { argv: ["curl", "http://metadata.google.internal/"], label: "metadata.google.internal" },
    { argv: ["curl", "http://fd00:ec2::254/"], label: "fd00:ec2::254" },
    { argv: ["cat", "/var/run/docker.sock"], label: "docker.sock" },
    { argv: ["cat", "/run/containerd/containerd.sock"], label: "containerd.sock" },
    { argv: ["cat", "/run/podman.sock"], label: "podman.sock" },
    { argv: ["ls", "/host/root"], label: "/host mount" },
    { argv: ["cat", "/proc/version"], label: "/proc mount" },
    { argv: ["cat", "/sys/kernel"], label: "/sys mount" },
    { argv: ["cat", "/dev/zero"], label: "/dev mount" },
    { argv: ["docker", "run", "--mount", "type=bind,src=/,dst=/mnt"], label: "--mount" },
    { argv: ["docker", "run", "--volume", "/:/host"], label: "--volume" },
    { argv: ["docker", "run", "-v", "/:/host"], label: "-v /" },
  ];

  // Try various options to attempt override
  const overrideAttempts = [
    undefined,
    {},
    { cwd: "/workspace/repo", worktreeRoot: "/workspace/repo" },
    { cwd: "/tmp", worktreeRoot: "/workspace/repo" },
    { egressAllowlist: ["*"] },
    { egressAllowlist: ["169.254.169.254", "metadata.google.internal"] },
    {
      policy: {
        version: "9.9.9",
        name: "permissive-policy",
        description: "Attempted override policy",
        egressAllowlist: ["*"],
        allowedCommands: [],
        hardBlockRules: [],
        defaultClassification: "needs_approval" as const,
      },
    },
  ];

  for (const item of hardBlockedArgvs) {
    for (const opts of overrideAttempts) {
      const res = classifyCommand(item.argv, opts);
      assert.equal(
        res.classification,
        "blocked",
        `Hard block violated for ${item.label} with options ${JSON.stringify(opts)}: got ${res.classification}`
      );
      assert.ok(res.reason, `Missing reason for hard block ${item.label}`);
      assert.ok(res.matchedRule?.startsWith("hard-block-") || res.matchedRule === "invalid-argv", `Matched rule must be hard block`);
    }
  }
});

test("Command Policy: version commands precision (Task 10.5, Requirement 20.3)", () => {
  // Allowed toolchain binaries with standard version flags
  const validVersionCommands: string[][] = [
    ["node", "-v"],
    ["node", "--version"],
    ["npm", "-v"],
    ["npm", "--version"],
    ["python", "-V"],
    ["python", "--version"],
    ["python3", "-V"],
    ["python3", "--version"],
    ["pip", "-v"],
    ["pip", "--version"],
    ["pip3", "-V"],
    ["pip3", "--version"],
    ["poetry", "--version"],
    ["git", "--version"],
    ["npx", "--version"],
    ["tsc", "--version"],
    ["tsc", "-v"],
  ];

  for (const argv of validVersionCommands) {
    const res = classifyCommand(argv);
    assert.equal(
      res.classification,
      "allowed",
      `Expected allowed version command for ${argv.join(" ")}, got ${res.classification}`
    );
    assert.equal(res.matchedRule, "version-commands");
  }

  // Non-toolchain binaries with -v or --version must NOT be classified as allowed version commands
  const nonToolchainBinariesWithFlag: string[][] = [
    ["rm", "-v"],
    ["chmod", "-v"],
    ["curl", "-v"],
    ["curl", "--version"],
    ["tar", "-v"],
    ["make", "-v"],
    ["bash", "--version"],
    ["sh", "-v"],
    ["kill", "-v"],
  ];

  for (const argv of nonToolchainBinariesWithFlag) {
    const res = classifyCommand(argv);
    assert.notEqual(
      res.classification,
      "allowed",
      `Non-toolchain command ${argv.join(" ")} must NOT be classified as allowed`
    );
    assert.equal(res.classification, "needs_approval");
  }

  // Toolchain binaries with unexpected trailing arguments must NOT be allowed as version commands
  const toolchainWithExtraArgs: string[][] = [
    ["node", "--version", "script.js"],
    ["python", "--version", "app.py"],
    ["git", "--version", "status"],
  ];

  for (const argv of toolchainWithExtraArgs) {
    const res = classifyCommand(argv);
    assert.notEqual(
      res.classification,
      "allowed",
      `Toolchain command with unexpected args ${argv.join(" ")} must not be allowed`
    );
  }
});

test("Command Policy: fast-check property test for hard block invariability and classifier purity (Task 10.5)", () => {
  const hardBlockTokens = [
    "sudo",
    "doas",
    "su",
    "KIRO_API_KEY",
    "kiro_api_key",
    "ksk_canary_0123",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ghp_01234567890123456789",
    "169.254.169.254",
    "metadata.google.internal",
    "docker.sock",
    "containerd.sock",
    "podman.sock",
    "~/.ssh/id_rsa",
    "/proc/self/environ",
    "/host/file",
    "/proc/version",
  ];

  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 4 }),
      fc.constantFrom(...hardBlockTokens),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 4 }),
      (prefix, token, suffix) => {
        const argv = [...prefix, token, ...suffix];
        const res = classifyCommand(argv);
        assert.equal(
          res.classification,
          "blocked",
          `Expected blocked for argv containing '${token}', got ${res.classification}`
        );
      }
    ),
    { numRuns: 100 }
  );

  // Purity property: for any string array, classifyCommand is pure and idempotent
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 25 }), { minLength: 1, maxLength: 6 }),
      (argv) => {
        const copy1 = [...argv];
        const res1 = classifyCommand(copy1);
        const copy2 = [...argv];
        const res2 = classifyCommand(copy2);

        assert.deepEqual(res1, res2);
        assert.deepEqual(copy1, argv, "classifyCommand must not mutate argument");
        assert.ok(["allowed", "needs_approval", "blocked"].includes(res1.classification));
      }
    ),
    { numRuns: 100 }
  );
});

