import test from "node:test";
import assert from "node:assert/strict";

import { EventStore } from "../../lib/events/event-store";
import { RunStore } from "../../lib/runs/run-store";
import {
  FailureRecoveryHandler,
  SECURITY_CONTAINMENT_EVENT_KIND,
} from "../../lib/supervisor/failure-recovery";
import { BootReconciliationService } from "../../lib/recovery/boot-reconciliation";
import {
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
} from "../../lib/supervisor/model-allowlist";

test("failure-recovery: blocks prompts on model_mismatch and gateway_missing", async () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const mismatch = await handler.verifyPrePromptInvariants({
    role: "scribe",
    activeModel: CLAUDE_OPUS_5_5_MODEL_ID,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "model_mismatch");
  assert.equal(mismatch.canPrompt, false);

  const auto = await handler.verifyPrePromptInvariants({
    role: "scribe",
    activeModel: "auto",
  });
  assert.equal(auto.reason, "model_mismatch");

  const gateway = await handler.verifyPrePromptInvariants({
    role: "scribe",
    activeModel: CLAUDE_HAIKU_5_5_MODEL_ID,
    checkGateway: () => false,
  });
  assert.equal(gateway.ok, false);
  assert.equal(gateway.reason, "gateway_missing");
  assert.equal(gateway.canPrompt, false);

  const good = await handler.verifyPrePromptInvariants({
    role: "scribe",
    activeModel: CLAUDE_HAIKU_5_5_MODEL_ID,
    checkGateway: async () => true,
  });
  assert.equal(good.ok, true);
  assert.equal(good.canPrompt, true);
  assert.equal(good.gatewayConnected, true);
});

test("failure-recovery: crash/broken pipe respawns once via session/load without prompt re-send", async () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  let loadCalls = 0;
  let receivedPrompt: unknown = undefined;
  const result = await handler.handleProcessCrash({
    runId: "run-crash",
    skeletonId: "sk-1",
    reason: "broken_pipe",
    worktreeDir: "/tmp/worktrees/sk-1",
    logRef: "cmd:log-sk-1",
    loadSession: (params) => {
      loadCalls++;
      receivedPrompt = (params as { prompt?: unknown }).prompt;
      return true;
    },
  });

  assert.equal(loadCalls, 1);
  assert.equal(receivedPrompt, undefined);
  assert.equal(result.status, "recovering");
  assert.equal(result.respawned, true);
  assert.equal(result.respawnMessage, "Resumed the same session");
  assert.equal(result.promptResent, false);
  assert.equal(result.preservedWorktree, "/tmp/worktrees/sk-1");
  assert.equal(result.logRef, "cmd:log-sk-1");

  const states = eventStore.getEvents("run-crash", { kind: "skeleton.state" });
  assert.equal(states.length, 1);
  assert.equal(states[0].data.state, "recovering");

  let repeatedCalls = 0;
  const repeated = await handler.handleProcessCrash({
    runId: "run-crash",
    skeletonId: "sk-1",
    crashCount: 1,
    loadSession: () => {
      repeatedCalls++;
      return true;
    },
  });
  assert.equal(repeatedCalls, 0);
  assert.equal(repeated.status, "failed");
  assert.equal(repeated.respawned, false);
  assert.equal(repeated.respawnMessage, "Restarted from its last commit");

  let failCalls = 0;
  const loadFail = await handler.handleProcessCrash({
    runId: "run-crash-2",
    skeletonId: "sk-2",
    loadSession: () => {
      failCalls++;
      return false;
    },
  });
  assert.equal(failCalls, 1);
  assert.equal(loadFail.status, "failed");
  assert.equal(loadFail.respawned, false);
});

test("failure-recovery: max Warden rejections skip a task and continue open Pact tasks", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const result = handler.handleMaxWardenRejections({
    runId: "run-pact",
    taskId: "task-3",
    rejectionRounds: 3,
    maxRounds: 3,
    pactTasks: [
      { id: "task-1", state: "merged" },
      { id: "task-2", state: "pending", blockedBy: ["task-3"] },
      { id: "task-3", state: "rejected" },
      { id: "task-4", state: "pending", blocked: true },
      { id: "task-5", state: "pending" },
    ],
  });

  assert.equal(result.skipped, true);
  assert.equal(result.state, "skipped");
  assert.ok(result.dispatched.includes("task-2"));
  assert.ok(result.dispatched.includes("task-5"));
  assert.ok(result.remaining.includes("task-4"));
  assert.ok(!result.dispatched.includes("task-3"));
});

test("failure-recovery: quarantines a worktree and blocks its merge", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const q = handler.quarantineWorktree({
    runId: "run-sec",
    skeletonId: "sk-9",
    worktreeDir: "/tmp/worktrees/sk-9",
    reason: "secret_detected",
    detail: "redacted secret found in diff",
  });
  assert.equal(q.quarantined, true);
  assert.equal(q.mergeBlocked, true);
  assert.equal(q.isolated, true);
  assert.equal(handler.isWorktreeQuarantined("/tmp/worktrees/sk-9"), true);
  assert.equal(handler.isMergeBlocked("run-sec"), true);

  const events = eventStore.getEvents("run-sec", {
    kind: SECURITY_CONTAINMENT_EVENT_KIND,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.reason, "secret_detected");
  assert.equal(events[0].data.mergeBlocked, true);

  const q2 = handler.quarantineWorktree({
    runId: "run-sec-2",
    worktreeDir: "/tmp/worktrees/sk-10",
    reason: "symlink_escape",
  });
  assert.equal(q2.reason, "symlink_escape");
  assert.equal(handler.isMergeBlocked("run-sec-2"), true);
});

test("failure-recovery: logs a permission.anomaly when the broker watchdog times out", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const result = handler.handleBrokerWatchdogTimeout({
    runId: "run-wd",
    skeletonId: "sk-1",
    toolCallId: "tc-1",
    timeoutMs: 30000,
    watchdogLimitMs: 30000,
  });
  assert.equal(result.logged, true);

  const anomalies = eventStore.getEvents("run-wd", { kind: "permission.anomaly" });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].actor, "PermissionBroker");
  assert.equal(anomalies[0].data.reason, "watchdog_timeout");
  assert.equal(anomalies[0].data.toolCallId, "tc-1");
});

test("failure-recovery: nudges only when the silence threshold is reached", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const quiet = handler.handleSilenceNudge({
    runId: "run-silent",
    silentDurationMs: 1000,
    thresholdMs: 5000,
  });
  assert.equal(quiet.nudged, false);
  assert.equal(eventStore.getEvents("run-silent", { kind: "message.sent" }).length, 0);

  const nudged = handler.handleSilenceNudge({
    runId: "run-silent",
    skeletonId: "sk-1",
    silentDurationMs: 6000,
    thresholdMs: 5000,
  });
  assert.equal(nudged.nudged, true);
  const sent = eventStore.getEvents("run-silent", { kind: "message.sent" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.nudge, true);
});

test("failure-recovery: boot reconciliation reaps safe pids, destroys orphan boxes and preserves evidence", async () => {
  const runStore = new RunStore(":memory:");
  const eventStore = new EventStore(":memory:");

  runStore.createRun({
    runId: "run-a",
    url: "https://github.com/owner/repo",
    sha: "abc",
    phase: "legion",
    sandboxId: "box-a",
  });
  runStore.createRun({
    runId: "run-b",
    url: "https://github.com/owner/repo",
    sha: "abc",
    phase: "legion",
    sandboxId: "box-lost",
  });
  runStore.createRun({
    runId: "run-c",
    url: "https://github.com/owner/repo",
    sha: "abc",
    phase: "queued",
  });
  eventStore.append({
    runId: "run-b",
    kind: "command.result",
    actor: "test",
    data: { id: "build", refs: ["cmd:build"] },
  });

  const destroyed: string[] = [];
  const killed: number[] = [];
  const service = new BootReconciliationService();
  const result = await service.reconcileOnBoot({
    runStore,
    eventStore,
    backend: {
      list: () => [
        { sandboxId: "box-a", runId: "run-a" },
        { sandboxId: "box-orphan" },
      ],
      destroy: (id) => {
        destroyed.push(id);
      },
    },
    pidFiles: [
      { pid: 100, command: "kiro-cli --acp" },
      { pid: 200, command: "node unrelated.js" },
      { pid: 300, command: "kiro-cli --acp", expectedOwner: "root" },
    ],
    processOps: {
      isAlive: () => true,
      readCommand: (pid) => (pid === 200 ? "node unrelated.js" : "kiro-cli --acp"),
      readOwner: (pid) => (pid === 300 ? "user" : "root"),
      kill: (pid) => {
        killed.push(pid);
      },
    },
  });

  assert.deepEqual(result.reapedPids, [100]);
  assert.deepEqual([...result.skippedPids].sort((a, b) => a - b), [200, 300]);
  assert.deepEqual(killed, [100]);
  assert.ok(result.destroyedBoxes.includes("box-orphan"));
  assert.ok(result.errored.includes("run-b"));
  assert.ok(result.recovered.includes("run-a"));
  assert.ok(result.recovered.includes("run-c"));
  assert.equal(result.workerRestarted, true);

  const runB = runStore.getRun("run-b")!;
  assert.equal(runB.phase, "done");
  assert.equal(runB.outcome, "error");
  assert.equal(
    runStore.getRunSandboxes("run-b").some((s) => s.status === "lost"),
    true
  );
  assert.ok(
    eventStore.getEvents("run-b").some((e) => e.kind === "command.result")
  );
  assert.equal(
    eventStore.getEvents("run-a", { kind: "system.worker_restart" }).length,
    1
  );
  assert.equal(eventStore.getEvents("run-a", { kind: "run.clock" }).length, 1);
});

test("failure-recovery: recreates a failed box at most once and tags outcome flags", async () => {
  const service = new BootReconciliationService();

  let recreateCalls = 0;
  const oom = await service.handleBoxFailure({
    runId: "run-box",
    sandboxId: "box-1",
    kind: "oom",
    failedCommand: "npm test",
    recreateBox: () => {
      recreateCalls++;
      return { sandboxId: "box-2" };
    },
    rerunCommand: () => ({ exitCode: 1 }),
  });
  assert.equal(recreateCalls, 1);
  assert.equal(oom.recreated, true);
  assert.equal(oom.newSandboxId, "box-2");
  assert.equal(oom.flags.oomKilled, true);
  assert.equal(oom.commandOutcome.oomKilled, true);

  recreateCalls = 0;
  const again = await service.handleBoxFailure({
    runId: "run-box",
    sandboxId: "box-1",
    kind: "oom",
    priorRecreations: 1,
    recreateBox: () => {
      recreateCalls++;
      return "box-3";
    },
  });
  assert.equal(recreateCalls, 0);
  assert.equal(again.recreated, false);

  const ttl = await service.handleBoxFailure({
    runId: "run-box",
    sandboxId: "box-1",
    kind: "ttl_expired",
    rerunCommand: () => ({ exitCode: null }),
  });
  assert.equal(ttl.flags.timedOut, true);
  assert.equal(ttl.commandOutcome.timedOut, true);

  const exited = await service.handleBoxFailure({
    runId: "run-box",
    sandboxId: "box-1",
    kind: "exit",
  });
  assert.equal(exited.flags.oomKilled, false);
  assert.equal(exited.flags.timedOut, false);
});

test("failure-recovery: computes a GitHub 403/429 cooldown window", () => {
  const eventStore = new EventStore(":memory:");
  const now = 1_000_000;
  const service = new BootReconciliationService({ eventStore, now: () => now });

  const forbidden = service.handleGitHubRateLimit({
    runId: "run-gh",
    statusCode: 403,
    resetAtMs: now + 60000,
  });
  assert.equal(forbidden.resetAtMs, now + 60000);
  assert.equal(forbidden.cooldownMs, 60000);
  const events = eventStore.getEvents("run-gh", { kind: "system.github_rate_limit" });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.statusCode, 403);
  assert.equal(events[0].data.resetAtMs, now + 60000);

  const tooMany = service.handleGitHubRateLimit({
    runId: "run-gh",
    statusCode: 429,
    retryAfterSec: 30,
  });
  assert.equal(tooMany.retryAfterSec, 30);
  assert.equal(tooMany.resetAtMs, now + 30000);
  assert.equal(tooMany.cooldownMs, 30000);
});

test("failure-recovery: transitions a run to budget_stopped on Kiro credit exhaustion", () => {
  const runStore = new RunStore(":memory:");
  const eventStore = new EventStore(":memory:");
  runStore.createRun({
    runId: "run-budget",
    url: "https://github.com/owner/repo",
    sha: "abc",
    phase: "legion",
    metadata: { mergedTasksCount: 2 },
  });
  eventStore.append({
    runId: "run-budget",
    kind: "task.state",
    actor: "test",
    data: { taskId: "task-1", state: "merged", refs: [] },
  });

  const service = new BootReconciliationService({ runStore, eventStore });
  const result = service.handleKiroCreditExhaustion({ runId: "run-budget" });

  assert.equal(result.phase, "done");
  assert.equal(result.outcome, "budget_stopped");
  assert.equal(result.preservedMergedWork, true);
  const run = runStore.getRun("run-budget")!;
  assert.equal(run.phase, "done");
  assert.equal(run.outcome, "budget_stopped");
  assert.ok(eventStore.getEvents("run-budget").some((e) => e.kind === "task.state"));
  assert.equal(
    eventStore.getEvents("run-budget", { kind: "budget.exceeded" }).length,
    1
  );
});
