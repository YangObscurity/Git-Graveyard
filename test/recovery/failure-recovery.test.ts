import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EventStore } from "../../lib/events/event-store";
import { RunStore } from "../../lib/runs/run-store";
import {
  FailureRecoveryHandler,
  SECURITY_CONTAINMENT_EVENT_KIND,
} from "../../lib/supervisor/failure-recovery";
import {
  BootReconciliationService,
  DEFAULT_SANDBOX_MANAGED_BY,
  SANDBOX_OWNERSHIP_LABEL,
  SANDBOX_TENANT_LABEL,
  SANDBOX_WORKER_LABEL,
} from "../../lib/recovery/boot-reconciliation";
import { Redactor } from "../../lib/security/redactor";
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
  assert.equal(q.isolated, false);
  assert.equal(handler.isWorktreeQuarantined("/tmp/worktrees/sk-9"), true);
  assert.equal(handler.isMergeBlocked("run-sec"), true);

  const events = eventStore.getEvents("run-sec", {
    kind: SECURITY_CONTAINMENT_EVENT_KIND,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.reason, "secret_detected");
  assert.equal(events[0].data.mergeBlocked, true);
  assert.equal(events[0].data.isolated, false);

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
        {
          sandboxId: "box-a",
          runId: "run-a",
          labels: { [SANDBOX_OWNERSHIP_LABEL]: DEFAULT_SANDBOX_MANAGED_BY },
        },
        {
          sandboxId: "box-orphan",
          labels: { [SANDBOX_OWNERSHIP_LABEL]: DEFAULT_SANDBOX_MANAGED_BY },
        },
      ],
      destroy: (id) => {
        destroyed.push(id);
      },
    },
    pidFiles: [
      { pid: 100, command: "kiro-cli --acp", expectedOwner: "root" },
      { pid: 200, command: "node unrelated.js", expectedOwner: "root" },
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
  assert.deepEqual(result.unownedBoxes, []);
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

test("failure-recovery: skips unowned/cross-tenant boxes and never reaps substring or unverifiable pids", async () => {
  const runStore = new RunStore(":memory:");
  const eventStore = new EventStore(":memory:");

  const listedFilters: Record<string, string>[] = [];
  const destroyed: string[] = [];
  const killed: number[] = [];

  const service = new BootReconciliationService();
  const result = await service.reconcileOnBoot({
    runStore,
    eventStore,
    managedBy: DEFAULT_SANDBOX_MANAGED_BY,
    workerId: "worker-1",
    tenantId: "tenant-1",
    backend: {
      list: (labels) => {
        listedFilters.push(labels ?? {});
        return [
          {
            sandboxId: "box-ours",
            labels: {
              [SANDBOX_OWNERSHIP_LABEL]: DEFAULT_SANDBOX_MANAGED_BY,
              [SANDBOX_WORKER_LABEL]: "worker-1",
              [SANDBOX_TENANT_LABEL]: "tenant-1",
            },
          },
          {
            sandboxId: "box-cross-tenant",
            labels: {
              [SANDBOX_OWNERSHIP_LABEL]: DEFAULT_SANDBOX_MANAGED_BY,
              [SANDBOX_WORKER_LABEL]: "worker-1",
              [SANDBOX_TENANT_LABEL]: "tenant-2",
            },
          },
          {
            sandboxId: "box-foreign-owner",
            labels: { [SANDBOX_OWNERSHIP_LABEL]: "someone-else" },
          },
          { sandboxId: "box-no-labels" },
        ];
      },
      destroy: (id) => {
        destroyed.push(id);
      },
    },
    pidFiles: [
      { pid: 11, command: "vim kiro-cli.md", expectedOwner: "root" },
      { pid: 12, command: "kiro-cli --acp", expectedOwner: "root" },
      { pid: 13, command: "kiro-cli --acp", expectedOwner: "root" },
      { pid: 14, command: "kiro-cli --acp" },
    ],
    processOps: {
      isAlive: () => true,
      readCommand: (pid) =>
        ({
          11: "vim kiro-cli.md",
          12: "kiro-cli --acp",
          13: "kiro-cli --acp",
          14: "kiro-cli --acp",
        }[pid] ?? null),
      readOwner: (pid) => {
        if (pid === 12) {
          return undefined;
        }
        if (pid === 13) {
          return "user";
        }
        return "root";
      },
      kill: (pid) => {
        killed.push(pid);
      },
    },
  });

  assert.equal(listedFilters.length, 1);
  assert.deepEqual(listedFilters[0], {
    [SANDBOX_OWNERSHIP_LABEL]: DEFAULT_SANDBOX_MANAGED_BY,
    [SANDBOX_WORKER_LABEL]: "worker-1",
    [SANDBOX_TENANT_LABEL]: "tenant-1",
  });

  assert.deepEqual(destroyed, ["box-ours"]);
  assert.ok(result.destroyedBoxes.includes("box-ours"));
  assert.ok(result.unownedBoxes.includes("box-cross-tenant"));
  assert.ok(result.unownedBoxes.includes("box-foreign-owner"));
  assert.ok(result.unownedBoxes.includes("box-no-labels"));
  assert.ok(!result.destroyedBoxes.includes("box-cross-tenant"));
  assert.ok(!result.destroyedBoxes.includes("box-foreign-owner"));

  assert.deepEqual(result.reapedPids, []);
  assert.deepEqual(killed, []);
  assert.deepEqual([...result.skippedPids].sort((a, b) => a - b), [11, 12, 13, 14]);
});


test("failure-recovery: omitting checkGateway fails closed with gateway_missing", async () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const result = await handler.verifyPrePromptInvariants({
    role: "scribe",
    activeModel: CLAUDE_HAIKU_5_5_MODEL_ID,
  });

  assert.equal(result.ok, false);
  assert.equal(result.canPrompt, false);
  assert.equal(result.reason, "gateway_missing");
  assert.equal(result.gatewayConnected, false);
});

test("failure-recovery: threads the injected custom Redactor through event data", () => {
  const eventStore = new EventStore(":memory:");
  const redactor = new Redactor({ autoRegisterEnvSecrets: false });
  const secret = "topsecretvalue-abc123";
  redactor.registerSecret(secret);

  const handler = new FailureRecoveryHandler({ eventStore, redactor });
  handler.handleBrokerWatchdogTimeout({
    runId: "run-redact",
    skeletonId: "sk-redact",
    requestId: secret,
    timeoutMs: 1000,
    watchdogLimitMs: 1000,
  });

  const anomalies = eventStore.getEvents("run-redact", { kind: "permission.anomaly" });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].data.requestId, "[REDACTED]");
  assert.ok(!String(anomalies[0].data.requestId).includes(secret));
});


test("failure-recovery: quarantineWorktree writes real .QUARANTINED containment on a temp worktree", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-quarantine-"));
  const nested = path.join(tmp, "nested");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(tmp, "file.txt"), "secret");
  fs.writeFileSync(path.join(nested, "deep.txt"), "deep");

  try {
    const result = handler.quarantineWorktree({
      runId: "run-real",
      skeletonId: "sk-real",
      worktreeDir: tmp,
      reason: "secret_detected",
    });

    assert.equal(result.isolated, true);
    assert.equal(result.mergeBlocked, true);

    const markerPath = path.join(tmp, ".QUARANTINED");
    assert.equal(fs.existsSync(markerPath), true);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
    assert.equal(marker.runId, "run-real");
    assert.equal(marker.reason, "secret_detected");

    assert.equal(fs.statSync(path.join(tmp, "file.txt")).mode & 0o222, 0);
    assert.equal(fs.statSync(path.join(nested, "deep.txt")).mode & 0o222, 0);
    assert.equal(fs.statSync(tmp).mode & 0o222, 0);

    const events = eventStore.getEvents("run-real", {
      kind: SECURITY_CONTAINMENT_EVENT_KIND,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.isolated, true);
  } finally {
    const restore = (target: string, mode: number) => {
      try {
        fs.chmodSync(target, mode);
      } catch {
        // ignore
      }
    };
    restore(nested, 0o755);
    restore(tmp, 0o755);
    restore(path.join(tmp, "file.txt"), 0o644);
    restore(path.join(nested, "deep.txt"), 0o644);
    restore(path.join(tmp, ".QUARANTINED"), 0o644);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("failure-recovery: quarantineWorktree invokes the stopProcess hook for containment", () => {
  const eventStore = new EventStore(":memory:");
  const stopped: string[] = [];
  const handler = new FailureRecoveryHandler({
    eventStore,
    stopProcess: (params) => {
      stopped.push(params.runId);
      return true;
    },
  });

  const result = handler.quarantineWorktree({
    runId: "run-stop",
    reason: "secret_detected",
  });

  assert.deepEqual(stopped, ["run-stop"]);
  assert.equal(result.isolated, true);
  assert.equal(result.mergeBlocked, true);
});


test("failure-recovery: handleProcessCrash records a terminal failed skeleton.state on every failure branch", async () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const recovered = await handler.handleProcessCrash({
    runId: "run-ok",
    skeletonId: "sk-ok",
    loadSession: () => true,
  });
  assert.equal(recovered.status, "recovering");
  assert.equal(recovered.failedEvent, null);
  assert.equal(eventStore.getEvents("run-ok", { kind: "skeleton.state" }).length, 1);

  const exhausted = await handler.handleProcessCrash({
    runId: "run-exhausted",
    skeletonId: "sk-ex",
    crashCount: 1,
  });
  assert.equal(exhausted.status, "failed");
  assert.ok(exhausted.failedEvent);
  const exhaustedStates = eventStore.getEvents("run-exhausted", {
    kind: "skeleton.state",
  });
  assert.equal(exhaustedStates.length, 2);
  assert.equal(exhaustedStates[0].data.state, "recovering");
  assert.equal(exhaustedStates[1].data.state, "failed");
  assert.equal(exhaustedStates[1].data.terminal, true);

  const loadFailure = await handler.handleProcessCrash({
    runId: "run-loadfail",
    skeletonId: "sk-lf",
    loadSession: () => false,
  });
  assert.equal(loadFailure.status, "failed");
  const loadStates = eventStore.getEvents("run-loadfail", { kind: "skeleton.state" });
  assert.equal(loadStates.length, 2);
  assert.equal(loadStates[1].data.state, "failed");

  const throwing = await handler.handleProcessCrash({
    runId: "run-throws",
    skeletonId: "sk-th",
    loadSession: () => {
      throw new Error("load exploded");
    },
  });
  assert.equal(throwing.status, "failed");
  const throwStates = eventStore.getEvents("run-throws", { kind: "skeleton.state" });
  assert.equal(throwStates.length, 2);
  assert.equal(throwStates[1].data.state, "failed");
});

test("failure-recovery: handleBoxFailure advances attempts and rejects an empty recreation sandboxId", async () => {
  const service = new BootReconciliationService();

  let recreateCalls = 0;
  const first = await service.handleBoxFailure({
    runId: "run-cap",
    sandboxId: "box-1",
    kind: "exit",
    recreateBox: () => {
      recreateCalls++;
      return { sandboxId: "box-2" };
    },
  });
  assert.equal(recreateCalls, 1);
  assert.equal(first.recreated, true);
  assert.equal(first.attempts, 1);

  // Persisting the advanced attempts enforces the 1-recreation cap.
  recreateCalls = 0;
  const second = await service.handleBoxFailure({
    runId: "run-cap",
    sandboxId: "box-1",
    kind: "exit",
    priorRecreations: first.attempts,
    recreateBox: () => {
      recreateCalls++;
      return { sandboxId: "box-3" };
    },
  });
  assert.equal(recreateCalls, 0);
  assert.equal(second.recreated, false);
  assert.equal(second.attempts, 1);

  // Empty sandboxId is a failed recreation and the command must not rerun.
  let rerunCalls = 0;
  const empty = await service.handleBoxFailure({
    runId: "run-cap",
    sandboxId: "box-1",
    kind: "exit",
    recreateBox: () => ({ sandboxId: "" }),
    rerunCommand: () => {
      rerunCalls++;
      return { exitCode: 0 };
    },
  });
  assert.equal(empty.recreated, false);
  assert.equal(empty.newSandboxId, null);
  assert.equal(empty.attempts, 1);
  assert.equal(rerunCalls, 0);

  // Missing sandboxId is likewise a failed recreation.
  let missingRerun = 0;
  const missing = await service.handleBoxFailure({
    runId: "run-cap",
    sandboxId: "box-1",
    kind: "exit",
    recreateBox: () => ({}),
    rerunCommand: () => {
      missingRerun++;
      return { exitCode: 0 };
    },
  });
  assert.equal(missing.recreated, false);
  assert.equal(missing.newSandboxId, null);
  assert.equal(missing.attempts, 1);
  assert.equal(missingRerun, 0);
});

test("failure-recovery: missing or throwing kill/destroy never records reaped pids or destroyed boxes", async () => {
  const runStore = new RunStore(":memory:");
  const eventStore = new EventStore(":memory:");
  runStore.createRun({
    runId: "run-x",
    url: "https://github.com/owner/repo",
    sha: "abc",
    phase: "legion",
    sandboxId: "box-live",
  });

  const service = new BootReconciliationService();

  // processOps present but kill missing -> cannot reap, pid is skipped.
  const noKill = await service.reconcileOnBoot({
    runStore,
    eventStore,
    pidFiles: [{ pid: 501, command: "kiro-cli --acp", expectedOwner: "root" }],
    processOps: {
      isAlive: () => true,
      readCommand: () => "kiro-cli --acp",
      readOwner: () => "root",
    },
  });
  assert.deepEqual(noKill.reapedPids, []);
  assert.deepEqual(noKill.skippedPids, [501]);

  // kill throws -> not reaped, tracked as a failure.
  const throwingKill = await service.reconcileOnBoot({
    runStore,
    eventStore,
    pidFiles: [{ pid: 502, command: "kiro-cli --acp", expectedOwner: "root" }],
    processOps: {
      isAlive: () => true,
      readCommand: () => "kiro-cli --acp",
      readOwner: () => "root",
      kill: () => {
        throw new Error("kill failed");
      },
    },
  });
  assert.deepEqual(throwingKill.reapedPids, []);
  assert.ok(throwingKill.failedPids.includes(502));

  // destroy throws -> not recorded as destroyed, tracked as a failure.
  const destroyFailed = await service.reconcileOnBoot({
    runStore,
    eventStore,
    backend: {
      list: () => [
        {
          sandboxId: "box-orphan",
          labels: { [SANDBOX_OWNERSHIP_LABEL]: DEFAULT_SANDBOX_MANAGED_BY },
        },
      ],
      destroy: () => {
        throw new Error("destroy failed");
      },
    },
  });
  assert.ok(!destroyFailed.destroyedBoxes.includes("box-orphan"));
  assert.ok(destroyFailed.failedDestroys.includes("box-orphan"));
});

test("failure-recovery: Kiro credit exhaustion records preservedWork=false when no work was merged", () => {
  const runStore = new RunStore(":memory:");
  const eventStore = new EventStore(":memory:");
  runStore.createRun({
    runId: "run-budget-zero",
    url: "https://github.com/owner/repo",
    sha: "abc",
    phase: "legion",
    metadata: { mergedTasksCount: 0 },
  });

  const service = new BootReconciliationService({ runStore, eventStore });
  const result = service.handleKiroCreditExhaustion({ runId: "run-budget-zero" });

  assert.equal(result.preservedMergedWork, false);
  const events = eventStore.getEvents("run-budget-zero", { kind: "budget.exceeded" });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.preservedWork, false);
});

test("failure-recovery: quarantineWorktree never follows or chmods a symlink inside the worktree", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-quarantine-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gg-outside-"));
  const outsideFile = path.join(outside, "keep-writable.txt");
  fs.writeFileSync(outsideFile, "untouched");
  fs.chmodSync(outsideFile, 0o644);
  const beforeMode = fs.statSync(outsideFile).mode;

  const linkPath = path.join(tmp, "escape");
  fs.symlinkSync(outsideFile, linkPath);

  try {
    const result = handler.quarantineWorktree({
      runId: "run-symlink",
      worktreeDir: tmp,
      reason: "symlink_escape",
    });

    assert.equal(result.isolated, true);
    // The symlink target outside the worktree is neither followed nor chmodded.
    assert.equal(fs.statSync(outsideFile).mode, beforeMode);
    assert.equal(fs.readFileSync(outsideFile, "utf-8"), "untouched");
    // The symlink entry itself is skipped, staying a symlink.
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  } finally {
    const restore = (target: string, mode: number) => {
      try {
        fs.chmodSync(target, mode);
      } catch {
        // ignore
      }
    };
    restore(tmp, 0o755);
    restore(path.join(tmp, ".QUARANTINED"), 0o644);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("failure-recovery: quarantineWorktree records the moved quarantine path accurately", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-move-src-"));
  const quarantineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gg-move-root-"));
  fs.writeFileSync(path.join(tmp, "file.txt"), "secret");

  const makeWritableAndRemove = (root: string) => {
    const walk = (dir: string) => {
      try {
        fs.chmodSync(dir, 0o755);
      } catch {
        // ignore
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          try {
            fs.chmodSync(full, 0o644);
          } catch {
            // ignore
          }
        }
      }
    };
    if (fs.existsSync(root)) {
      walk(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  try {
    const result = handler.quarantineWorktree({
      runId: "run-move",
      skeletonId: "sk-move",
      worktreeDir: tmp,
      reason: "secret_detected",
      quarantineRoot,
    });

    assert.equal(result.isolated, true);
    assert.equal(typeof result.worktreeDir, "string");
    const finalPath = result.worktreeDir as string;
    assert.notEqual(finalPath, tmp);
    assert.ok(finalPath.startsWith(quarantineRoot));
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.existsSync(path.join(finalPath, ".QUARANTINED")), true);
    assert.equal(handler.isWorktreeQuarantined(finalPath), true);

    const events = eventStore.getEvents("run-move", {
      kind: SECURITY_CONTAINMENT_EVENT_KIND,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.worktree, finalPath);
  } finally {
    makeWritableAndRemove(tmp);
    makeWritableAndRemove(quarantineRoot);
  }
});

test("failure-recovery: failed and abandoned dependencies stay blocked in handleMaxWardenRejections", () => {
  const eventStore = new EventStore(":memory:");
  const handler = new FailureRecoveryHandler({ eventStore });

  const result = handler.handleMaxWardenRejections({
    runId: "run-deps",
    taskId: "task-9",
    rejectionRounds: 0,
    maxRounds: 3,
    pactTasks: [
      { id: "task-failed", state: "failed" },
      { id: "task-abandoned", state: "abandoned" },
      { id: "task-merged", state: "merged" },
      { id: "task-2", state: "pending", blockedBy: ["task-failed"] },
      { id: "task-3", state: "pending", blockedBy: ["task-abandoned"] },
      { id: "task-4", state: "pending", blockedBy: ["task-merged"] },
    ],
  });

  assert.ok(!result.dispatched.includes("task-2"));
  assert.ok(!result.dispatched.includes("task-3"));
  assert.ok(result.remaining.includes("task-2"));
  assert.ok(result.remaining.includes("task-3"));
  assert.ok(result.dispatched.includes("task-4"));
});

test("failure-recovery: a throwing custom redactor fails closed and redacts every string leaf", () => {
  const eventStore = new EventStore(":memory:");
  const throwingRedactor = {
    redactEventData: () => {
      throw new Error("redactor exploded");
    },
  } as unknown as Redactor;

  const handler = new FailureRecoveryHandler({
    eventStore,
    redactor: throwingRedactor,
  });
  handler.handleBrokerWatchdogTimeout({
    runId: "run-redact-fail",
    skeletonId: "sk-redact-fail",
    requestId: "super-secret-request-id",
    timeoutMs: 1000,
    watchdogLimitMs: 1000,
  });

  const anomalies = eventStore.getEvents("run-redact-fail", {
    kind: "permission.anomaly",
  });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].data.requestId, "[REDACTED]");
  assert.equal(anomalies[0].data.reason, "[REDACTED]");
  assert.equal(anomalies[0].data.timeoutMs, 1000);
});
