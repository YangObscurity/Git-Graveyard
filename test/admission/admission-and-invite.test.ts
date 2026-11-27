// Task 22.1 / 22.2 tests: invite codes, FIFO queue and the admission controller.
// Validates: Requirements 29.4, 31.1-31.9, 31.14-31.16, 41.11, 41.13, 41.15, 45.8.
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { RunStore } from "../../lib/runs/run-store";
import { EventStore } from "../../lib/events/event-store";
import {
  ALWAYS_REQUIRED_SETTING_KEYS,
  SettingsStore,
} from "../../lib/admin/settings-store";
import {
  InviteCodeAuthorizationError,
  InviteCodeService,
} from "../../lib/admission/invite-code";
import { FifoQueue } from "../../lib/admission/fifo-queue";
import { AdmissionController } from "../../lib/admission/admission-controller";
import { BudgetGovernor } from "../../lib/governor/budget-governor";

function makeHarness() {
  const db = new DatabaseSync(":memory:");
  const runStore = new RunStore(db);
  const eventStore = new EventStore(db);
  return { db, runStore, eventStore };
}

function satisfyRequiredSettings(store: SettingsStore): void {
  const updates: Record<string, number> = {};
  for (const key of ALWAYS_REQUIRED_SETTING_KEYS) {
    updates[key] = 1;
  }
  store.setSettingsBatch(updates, { actor: "test" });
}

describe("InviteCodeService (Task 22.1)", () => {
  it("requires a verified Admin session to create or revoke codes", () => {
    const { runStore } = makeHarness();
    const service = new InviteCodeService({ runStore });

    assert.throws(() => service.createCode({}), InviteCodeAuthorizationError);
    assert.throws(
      () => service.revokeCode("anything", undefined),
      InviteCodeAuthorizationError
    );

    const created = service.createCode({ allowedRunCount: 1 }, { adminSession: true });
    assert.equal(typeof created.code, "string");
    assert.ok(created.code.length > 10);
  });

  it("rejects a bare actor string but accepts a verified session object", () => {
    const { runStore } = makeHarness();
    const service = new InviteCodeService({ runStore });

    assert.throws(
      () => service.createCode({ allowedRunCount: 1 }, { actor: "owner" }),
      InviteCodeAuthorizationError
    );
    assert.throws(
      () => service.revokeCode("anything", { actor: "owner" }),
      InviteCodeAuthorizationError
    );
    assert.throws(
      () => service.createCode({ allowedRunCount: 1 }, { adminSession: { verified: false } }),
      InviteCodeAuthorizationError
    );

    const created = service.createCode(
      { allowedRunCount: 1 },
      { adminSession: { verified: true } }
    );
    assert.ok(created.code.startsWith("gg_"));
  });

  it("revokes a plaintext code through its resolved hash", () => {
    const { runStore } = makeHarness();
    const service = new InviteCodeService({ runStore });
    const created = service.createCode({ allowedRunCount: 1 }, { adminSession: true });

    const result = service.revokeCode(created.code, { adminSession: true });
    assert.equal(result.ok, true);
    assert.equal(result.codeHash, created.record.codeHash);
    assert.equal(service.getCode(created.record.codeHash)?.revoked, true);

    const verified = service.verifyCode(created.code, "2.2.2.2");
    assert.equal(verified.ok, false);
    assert.equal(verified.ok === false ? verified.reason : "", "revoked");
  });

  it("returns the plaintext code exactly once and never leaks it or the salt afterwards", () => {
    const { runStore } = makeHarness();
    const service = new InviteCodeService({ runStore });
    const created = service.createCode(
      { allowedRunCount: 2, label: "friend" },
      { adminSession: true, actor: "owner" }
    );

    // createCode is the only place the plaintext is exposed.
    assert.ok(created.code.startsWith("gg_"));
    assert.ok(!Object.prototype.hasOwnProperty.call(created.record, "salt"));
    assert.ok(!JSON.stringify(created.record).includes(created.code));

    const list = service.listCodes();
    assert.equal(list.length, 1);
    for (const record of list) {
      assert.ok(!Object.prototype.hasOwnProperty.call(record, "salt"));
      assert.ok(!JSON.stringify(record).includes(created.code));
    }

    const byHash = service.getCode(created.record.codeHash);
    assert.ok(byHash);
    assert.ok(!Object.prototype.hasOwnProperty.call(byHash, "salt"));
  });

  it("defaults the push flag off and only enables it explicitly", () => {
    const { runStore } = makeHarness();
    const service = new InviteCodeService({ runStore });
    const off = service.createCode({ allowedRunCount: 1 }, { adminSession: true });
    const on = service.createCode(
      { allowedRunCount: 1, pushFlag: true },
      { adminSession: true }
    );
    assert.equal(off.record.pushFlag, false);
    assert.equal(on.record.pushFlag, true);
  });

  it("rejects expired, used_up, revoked and not_found codes distinctly", () => {
    const { runStore } = makeHarness();
    const now = 1_000_000;
    const service = new InviteCodeService({ runStore, now: () => now });

    const expired = service.createCode(
      { allowedRunCount: 1, expiresAt: now - 1 },
      { adminSession: true }
    );
    const expiredResult = service.verifyCode(expired.code, "1.1.1.1");
    assert.equal(expiredResult.ok, false);
    assert.equal(expiredResult.ok === false ? expiredResult.reason : "", "expired");

    const quota = service.createCode({ allowedRunCount: 1 }, { adminSession: true });
    assert.equal(service.consumeRun(quota.code), true);
    const usedUp = service.verifyCode(quota.code, "1.1.1.2");
    assert.equal(usedUp.ok, false);
    assert.equal(usedUp.ok === false ? usedUp.reason : "", "used_up");

    const revoked = service.createCode({ allowedRunCount: 1 }, { adminSession: true });
    assert.equal(service.revokeCode(revoked.code, { adminSession: true }).ok, true);
    const revokedResult = service.verifyCode(revoked.code, "1.1.1.3");
    assert.equal(revokedResult.ok, false);
    assert.equal(revokedResult.ok === false ? revokedResult.reason : "", "revoked");

    const missing = service.verifyCode("gg_not-a-real-code", "1.1.1.4");
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false ? missing.reason : "", "not_found");

    const valid = service.createCode(
      { allowedRunCount: 3, caps: { maxMinutes: 30 } },
      { adminSession: true }
    );
    const ok = service.verifyCode(valid.code, "1.1.1.5");
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.remainingRunCount, 3);
      assert.deepEqual(ok.caps, { maxMinutes: 30 });
    }
  });

  it("limits verification attempts per IP with a sliding window", () => {
    const { runStore } = makeHarness();
    let now = 5_000_000;
    const service = new InviteCodeService({
      runStore,
      now: () => now,
      maxAttemptsPerIp: 3,
      attemptWindowMs: 60_000,
    });

    for (let i = 0; i < 3; i += 1) {
      const result = service.verifyCode("gg_wrong", "9.9.9.9");
      assert.equal(result.ok === false ? result.reason : "", "not_found");
    }
    const limited = service.verifyCode("gg_wrong", "9.9.9.9");
    assert.equal(limited.ok, false);
    assert.equal(limited.ok === false ? limited.reason : "", "rate_limited");
    assert.ok(limited.ok === false ? (limited.retryAfterMs ?? 0) > 0 : false);

    const otherIp = service.verifyCode("gg_wrong", "8.8.8.8");
    assert.equal(otherIp.ok === false ? otherIp.reason : "", "not_found");

    now += 60_001;
    const afterWindow = service.verifyCode("gg_wrong", "9.9.9.9");
    assert.equal(afterWindow.ok === false ? afterWindow.reason : "", "not_found");
  });
});

describe("FifoQueue (Task 22.2)", () => {
  it("enforces FIFO ordering, contiguous positions and QUEUE_FULL", () => {
    const { runStore, eventStore } = makeHarness();
    const queue = new FifoQueue({ eventStore, runStore, queueDepth: 2 });

    assert.equal(queue.enqueue({ runId: "a" }).ok, true);
    assert.equal(queue.enqueue({ runId: "b" }).ok, true);
    const full = queue.enqueue({ runId: "c" });
    assert.equal(full.ok, false);
    assert.equal(full.ok === false ? full.code : "", "QUEUE_FULL");

    assert.deepEqual(
      queue.list().map((entry) => entry.runId),
      ["a", "b"]
    );
    assert.equal(queue.getPosition("b"), 2);

    const head = queue.dequeue();
    assert.equal(head?.runId, "a");
    assert.equal(queue.getPosition("b"), 1);
    assert.equal(queue.depth, 1);
  });

  it("appends run.queued and run.queue_position events on enqueue and shift", () => {
    const { eventStore } = makeHarness();
    const queue = new FifoQueue({ eventStore });

    queue.enqueue({ runId: "r1" });
    queue.enqueue({ runId: "r2" });
    assert.ok(eventStore.getEvents("r2").some((ev) => ev.kind === "run.queued"));

    const moved = queue.move("r2", 1);
    assert.equal(moved?.position, 1);
    assert.ok(eventStore.getEvents("r1", { kind: "run.queue_position" }).length >= 2);
    assert.ok(eventStore.getEvents("r2", { kind: "run.queue_position" }).length >= 2);
  });

  it("emits zero spurious run.queue_position events for unchanged entries on enqueue", () => {
    const { eventStore } = makeHarness();
    const queue = new FifoQueue({ eventStore });

    queue.enqueue({ runId: "first" });
    const before = eventStore.getEvents("first", { kind: "run.queue_position" }).length;

    queue.enqueue({ runId: "second" });
    queue.enqueue({ runId: "third" });

    const after = eventStore.getEvents("first", { kind: "run.queue_position" }).length;
    assert.equal(after, before);
    assert.equal(queue.getPosition("first"), 1);
    assert.equal(queue.getPosition("second"), 2);
    assert.equal(queue.getPosition("third"), 3);
  });

  it("evicts idle entries and supports move/remove/cancel", () => {
    let now = 0;
    const { runStore, eventStore } = makeHarness();
    const queue = new FifoQueue({
      eventStore,
      runStore,
      queueIdleLimitMs: 1000,
      now: () => now,
    });

    runStore.createRun({
      runId: "idle",
      url: "https://example.test/a/b",
      sha: "0".repeat(40),
      phase: "queued",
    });
    queue.enqueue({ runId: "idle" });
    now = 2000;
    const evicted = queue.evictIdle();
    assert.deepEqual(
      evicted.map((entry) => entry.runId),
      ["idle"]
    );
    assert.equal(queue.depth, 0);

    queue.enqueue({ runId: "keep-1" });
    queue.enqueue({ runId: "keep-2" });
    const removed = queue.remove("keep-1");
    assert.equal(removed?.runId, "keep-1");
    assert.equal(queue.getPosition("keep-2"), 1);

    runStore.createRun({
      runId: "cancel-me",
      url: "https://example.test/a/b",
      sha: "1".repeat(40),
      phase: "queued",
    });
    queue.enqueue({ runId: "cancel-me" });
    assert.equal(queue.cancel("cancel-me")?.runId, "cancel-me");
    assert.equal(runStore.getRun("cancel-me")?.outcome, "cancelled");
  });
});


describe("AdmissionController (Task 22.2)", () => {
  it("rejects when a Required_Setting is missing", () => {
    const { runStore, eventStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    const controller = new AdmissionController({ settingsStore: settings, runStore, eventStore });
    const decision = controller.checkAdmission();
    assert.equal(decision.admitted, false);
    assert.equal(decision.code, "REQUIRED_SETTINGS_MISSING");
    assert.ok((decision.missing ?? []).includes("toolCallsPerRun"));
  });

  it("rejects a repository larger than repoSizeCapKb with TOO_LARGE", () => {
    const { runStore, eventStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    satisfyRequiredSettings(settings);
    settings.setSetting("repoSizeCapKb", 1024, { actor: "owner" });
    const controller = new AdmissionController({ settingsStore: settings, runStore, eventStore });
    const decision = controller.checkAdmission({ repoSizeKb: 2048 });
    assert.equal(decision.admitted, false);
    assert.equal(decision.code, "TOO_LARGE");
  });

  it("retains runs queued with reason capacity when the cloud backend reports zero capacity", () => {
    const { runStore, eventStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    satisfyRequiredSettings(settings);
    const controller = new AdmissionController({
      settingsStore: settings,
      runStore,
      eventStore,
      backend: { kind: "docker-cloud", capacity: () => 0 },
    });
    const decision = controller.checkAdmission();
    assert.equal(decision.admitted, false);
    assert.equal(decision.code, "QUEUE");
    assert.equal(decision.queueReason, "capacity");
  });

  it("enforces a single-Skeleton fallback when probe P8 / spike S4 shows capacity limits", () => {
    const { runStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    satisfyRequiredSettings(settings);
    const controller = new AdmissionController({ settingsStore: settings, runStore });
    assert.equal(controller.maxParallelSoulStitchers(), 1);
    controller.noteCapacityLimit("probe_p8");
    assert.equal(controller.isCapacityLimited(), true);
    assert.equal(controller.maxParallelSoulStitchers(), 1);
    controller.clearCapacityLimit();
    assert.equal(controller.isCapacityLimited(), false);
  });

  it("pauses admission until the rate-limit backoff expires", () => {
    let now = 0;
    const { runStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    satisfyRequiredSettings(settings);
    const controller = new AdmissionController({
      settingsStore: settings,
      runStore,
      now: () => now,
    });
    controller.triggerRateLimitBackoff(5000);
    const decision = controller.checkAdmission();
    assert.equal(decision.admitted, false);
    assert.equal(decision.code, "RATE_LIMITED");
    assert.equal(decision.retryAfterMs, 5000);

    now = 6000;
    const after = controller.checkAdmission();
    assert.equal(after.admitted, true);
  });

  it("applies a positive default backoff when the retry hint is missing or non-positive", () => {
    let now = 0;
    const { runStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    satisfyRequiredSettings(settings);
    const controller = new AdmissionController({
      settingsStore: settings,
      runStore,
      now: () => now,
    });

    controller.triggerRateLimitBackoff(0);
    assert.equal(controller.isBackingOff(), true);
    assert.ok(controller.backoffRetryAfterMs() > 0);

    controller.clearBackoff();
    controller.triggerRateLimitBackoff(Number.NaN);
    assert.equal(controller.isBackingOff(), true);
    assert.ok(controller.backoffRetryAfterMs() >= 30_000);
    assert.equal(controller.checkAdmission().code, "RATE_LIMITED");

    now = 30_001;
    assert.equal(controller.checkAdmission().admitted, true);
  });

  it("halts on ACP auth failure without retries, preserving the queue and alerting the Owner", () => {
    const { runStore, eventStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    satisfyRequiredSettings(settings);
    const queue = new FifoQueue({ eventStore, runStore });
    queue.enqueue({ runId: "queued-1" });

    const controller = new AdmissionController({ settingsStore: settings, runStore, eventStore });
    controller.haltOnAuthFailure("kiro auth error");

    const decision = controller.checkAdmission();
    assert.equal(decision.admitted, false);
    assert.equal(decision.code, "AUTH_FAILED");
    assert.equal(controller.isAuthHalted(), true);

    assert.equal(queue.depth, 1);
    assert.equal(queue.getPosition("queued-1"), 1);

    const alerts = eventStore.getEvents("system", { kind: "system.worker_state" });
    assert.ok(alerts.length >= 1);
    assert.equal(alerts[0].data.ownerAlert, true);
  });
});

describe("BudgetGovernor (Task 22.3)", () => {
  it("re-arms the warning after a cap increase drops usage below the threshold", () => {
    const { eventStore } = makeHarness();
    const governor = new BudgetGovernor({
      runId: "warn-run",
      eventStore,
      caps: { toolCallsPerRun: 10 },
      warningPercent: 80,
    });

    governor.beginTurn("s1");
    for (let i = 0; i < 8; i += 1) {
      governor.recordToolCall("s1");
    }
    governor.evaluate();
    assert.equal(eventStore.getEvents("warn-run", { kind: "budget.warning" }).length, 1);
    assert.deepEqual(governor.getWarnings(), ["toolCallsPerRun"]);

    // Raising the cap moves usage (8) strictly below the new 80% threshold (16) and re-arms it.
    const grant = governor.grantCapIncrease("toolCallsPerRun", 20, { actor: "owner" });
    assert.equal(grant.ok, true);
    assert.deepEqual(governor.getWarnings(), []);

    // Crossing the new threshold emits a fresh budget.warning.
    for (let i = 0; i < 8; i += 1) {
      governor.recordToolCall("s1");
    }
    governor.evaluate();
    assert.equal(eventStore.getEvents("warn-run", { kind: "budget.warning" }).length, 2);
  });
});

