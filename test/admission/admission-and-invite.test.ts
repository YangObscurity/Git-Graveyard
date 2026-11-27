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
    assert.equal(service.getCode(created.record.codeHash, { adminSession: true })?.revoked, true);

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

    // listCodes and getCode are Admin-only and never echo the plaintext.
    assert.throws(() => service.listCodes(), InviteCodeAuthorizationError);
    assert.throws(
      () => service.getCode(created.record.codeHash),
      InviteCodeAuthorizationError
    );

    const list = service.listCodes({ adminSession: true });
    assert.equal(list.length, 1);
    for (const record of list) {
      assert.ok(!Object.prototype.hasOwnProperty.call(record, "salt"));
      assert.ok(!JSON.stringify(record).includes(created.code));
    }

    const byHash = service.getCode(created.record.codeHash, { adminSession: true });
    assert.ok(byHash);
    assert.ok(!Object.prototype.hasOwnProperty.call(byHash, "salt"));
    assert.ok(!JSON.stringify(byHash).includes(created.code));

    // A disclosed raw hash cannot be consumed without a verified Admin context.
    assert.throws(
      () => service.consumeRun(created.record.codeHash),
      InviteCodeAuthorizationError
    );
    assert.equal(
      service.consumeRun(created.record.codeHash, { adminSession: true }),
      true
    );
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

  it("bounds the per-IP attempt bucket so a rate-limited flood cannot grow it without bound", () => {
    const { runStore } = makeHarness();
    let now = 2_000_000;
    const service = new InviteCodeService({
      runStore,
      now: () => now,
      maxAttemptsPerIp: 3,
      attemptWindowMs: 60_000,
    });

    for (let i = 0; i < 50; i += 1) {
      now += 1;
      const result = service.verifyCode("gg_wrong", "7.7.7.7");
      if (i >= 3) {
        assert.equal(result.ok === false ? result.reason : "", "rate_limited");
      }
    }
    // Despite 50 requests inside the window the bucket never retains more than the cap.
    assert.equal(service.attemptWindowSizeForIp("7.7.7.7"), 3);
  });

  it("clamps a fractional maxAttemptsPerIp / attemptWindowMs / allowedRunCount up to at least one", () => {
    const { runStore } = makeHarness();
    let now = 1_000_000;
    const service = new InviteCodeService({
      runStore,
      now: () => now,
      maxAttemptsPerIp: 0.5,
      attemptWindowMs: 0.5,
    });

    // A fractional positive run count must not floor down to zero.
    const created = service.createCode({ allowedRunCount: 0.5 }, { adminSession: true });
    assert.equal(created.record.allowedRunCount, 1);

    // The per-IP attempt ceiling is at least 1: the second attempt is already rate-limited.
    const first = service.verifyCode("gg_wrong", "5.5.5.5");
    assert.equal(first.ok === false ? first.reason : "", "not_found");
    const second = service.verifyCode("gg_wrong", "5.5.5.5");
    assert.equal(second.ok, false);
    assert.equal(second.ok === false ? second.reason : "", "rate_limited");

    // The attempt window is at least 1ms, so the earlier attempt ages out one tick later.
    now += 1;
    const after = service.verifyCode("gg_wrong", "5.5.5.5");
    assert.equal(after.ok === false ? after.reason : "", "not_found");
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

  it("finalizes evicted idle runs as done/cancelled with terminal events", () => {
    let now = 0;
    const { runStore, eventStore } = makeHarness();
    const queue = new FifoQueue({
      eventStore,
      runStore,
      queueIdleLimitMs: 1000,
      now: () => now,
    });

    runStore.createRun({
      runId: "expired",
      url: "https://example.test/a/b",
      sha: "e".repeat(40),
      phase: "queued",
      queuePosition: 1,
    });
    queue.enqueue({ runId: "expired" });
    now = 5000;

    const evicted = queue.evictIdle();
    assert.deepEqual(evicted.map((entry) => entry.runId), ["expired"]);

    const run = runStore.getRun("expired");
    assert.equal(run?.phase, "done");
    assert.equal(run?.outcome, "cancelled");
    assert.equal(run?.queuePosition, null);
    assert.equal(run?.endedAt, 5000);
    assert.equal(runStore.getLivingRuns().some((r) => r.runId === "expired"), false);

    assert.ok(eventStore.getEvents("expired", { kind: "run.phase" }).length >= 1);
    const doneEvents = eventStore.getEvents("expired", { kind: "run.done" });
    assert.ok(doneEvents.length >= 1);
    assert.equal(doneEvents[0].data.outcome, "cancelled");
  });

  it("finalizes a cancelled run as done/cancelled with terminal events and a null position", () => {
    let now = 0;
    const { runStore, eventStore } = makeHarness();
    const queue = new FifoQueue({ eventStore, runStore, now: () => now });
    runStore.createRun({
      runId: "cancel-terminal",
      url: "https://example.test/a/b",
      sha: "c".repeat(40),
      phase: "queued",
      queuePosition: 1,
    });
    queue.enqueue({ runId: "cancel-terminal" });
    now = 4321;

    const cancelled = queue.cancel("cancel-terminal");
    assert.equal(cancelled?.runId, "cancel-terminal");
    assert.equal(queue.depth, 0);
    assert.equal(queue.getPosition("cancel-terminal"), null);

    const run = runStore.getRun("cancel-terminal");
    assert.equal(run?.phase, "done");
    assert.equal(run?.outcome, "cancelled");
    assert.equal(run?.queuePosition, null);
    assert.equal(run?.endedAt, 4321);

    assert.ok(eventStore.getEvents("cancel-terminal", { kind: "run.phase" }).length >= 1);
    const doneEvents = eventStore.getEvents("cancel-terminal", { kind: "run.done" });
    assert.ok(doneEvents.length >= 1);
    assert.equal(doneEvents[0].data.outcome, "cancelled");
    assert.equal(doneEvents[0].data.endedAt, 4321);
  });

  it("clamps a fractional queueDepth / queueIdleLimitMs up to at least one", () => {
    const { eventStore } = makeHarness();
    const queue = new FifoQueue({ eventStore, queueDepth: 0.5, queueIdleLimitMs: 0.5 });

    // A fractional positive cap / window must not floor down to zero (a zero cap would reject all).
    assert.equal(queue.cap, 1);
    assert.equal(queue.idleLimitMs, 1);
    assert.equal(queue.enqueue({ runId: "frac-1" }).ok, true);
    const full = queue.enqueue({ runId: "frac-2" });
    assert.equal(full.ok, false);
    assert.equal(full.ok === false ? full.code : "", "QUEUE_FULL");
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

    // Requirement 41.11: the run is retained in the FIFO queue (never admitted) rather than lost.
    const queue = new FifoQueue({ eventStore, runStore, queueDepth: 5 });
    const retained = queue.enqueue({ runId: "capacity-queued", reason: decision.queueReason });
    assert.equal(retained.ok, true);
    const snapshot = queue.snapshot();
    assert.equal(snapshot.depth, 1);
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.runId),
      ["capacity-queued"]
    );
    assert.equal(snapshot.entries[0].position, 1);
    assert.equal(snapshot.entries[0].reason, "capacity");
    assert.equal(queue.getPosition("capacity-queued"), 1);
  });

  it("enforces a single-Skeleton fallback when probe P8 / spike S4 shows capacity limits", () => {
    const { runStore } = makeHarness();
    const settings = new SettingsStore(":memory:");
    satisfyRequiredSettings(settings);
    // A non-1 default so the clamp to 1 below is actually exercised.
    settings.setSetting("parallelSoulStitchers", 4, { actor: "owner" });
    const controller = new AdmissionController({ settingsStore: settings, runStore });
    assert.equal(controller.maxParallelSoulStitchers(), 4);
    controller.noteCapacityLimit("probe_p8");
    assert.equal(controller.isCapacityLimited(), true);
    assert.equal(controller.maxParallelSoulStitchers(), 1);
    controller.clearCapacityLimit();
    assert.equal(controller.isCapacityLimited(), false);
    assert.equal(controller.maxParallelSoulStitchers(), 4);
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

  it("caps reserved live-run slots at the ceiling across sequential admissions and is idempotent", () => {
    const { runStore, eventStore } = makeHarness();
    // concurrentLiveRuns is capped at the hard ceiling (5); the stub offers 99 to prove clamping.
    const settings = {
      getSetting: (key: string) => (key === "concurrentLiveRuns" ? 99 : undefined),
      validateRequiredSettings: () => ({ ok: true, missing: [] }),
    } as unknown as SettingsStore;
    // The controller's default backend is cloud, so `effectiveConcurrentLiveRuns()` resolves to the
    // clamped ceiling (5) — the exact bound `reserveSlot` clamps every caller-supplied limit against.
    const controller = new AdmissionController({
      settingsStore: settings,
      runStore,
      eventStore,
      backend: { kind: "docker-cloud" },
    });

    assert.equal(controller.effectiveConcurrentLiveRuns(), 5);
    assert.equal(controller.effectiveConcurrentLiveRuns("docker-cloud"), 5);

    // Sequential admissions claim slots synchronously; no more than the ceiling may be admitted.
    const decisions = Array.from({ length: 8 }, (_, i) =>
      controller.checkAdmission({ runId: `live-${i}` })
    );
    assert.equal(decisions.filter((decision) => decision.admitted).length, 5);
    assert.equal(controller.getReservedCount(), 5);
    assert.ok(decisions.some((decision) => decision.code === "QUEUE"));

    // Re-admitting an already-reserved run is idempotent and never double-counts.
    const reAdmit = controller.checkAdmission({ runId: "live-0" });
    assert.equal(reAdmit.admitted, true);
    assert.equal(controller.getReservedCount(), 5);

    // Releasing a slot frees exactly one admission.
    assert.equal(controller.releaseSlot("live-2"), true);
    assert.equal(controller.releaseSlot("live-2"), false);
    assert.equal(controller.getReservedCount(), 4);
    assert.equal(controller.admitRun("live-8").admitted, true);
    assert.equal(controller.getReservedCount(), 5);
  });

  it("ignores a non-finite reserveSlot limit and requires finite backend capacity", () => {
    const { runStore, eventStore } = makeHarness();
    const settings = {
      getSetting: (key: string) => (key === "concurrentLiveRuns" ? 99 : undefined),
      validateRequiredSettings: () => ({ ok: true, missing: [] }),
    } as unknown as SettingsStore;
    const controller = new AdmissionController({
      settingsStore: settings,
      runStore,
      eventStore,
      backend: { kind: "docker-cloud" },
    });
    assert.equal(controller.effectiveConcurrentLiveRuns(), 5);

    // A NaN / Infinity limit must not bypass the ceiling check: it falls back to the effective limit.
    for (let i = 0; i < 20; i += 1) {
      controller.reserveSlot(`nan-${i}`, Number.NaN);
    }
    assert.equal(controller.getReservedCount(), 5);
    for (let i = 0; i < 20; i += 1) {
      controller.reserveSlot(`inf-${i}`, Number.POSITIVE_INFINITY);
    }
    assert.equal(controller.getReservedCount(), 5);

    // A non-finite backend capacity is treated as unreported, never as free capacity.
    const nanBackend = new AdmissionController({
      settingsStore: settings,
      runStore,
      eventStore,
      backend: { kind: "docker-cloud", capacity: () => Number.NaN },
    });
    assert.deepEqual(nanBackend.resolveBackendCapacity(), { reported: false, available: null });

    const infiniteBackend = new AdmissionController({
      settingsStore: settings,
      runStore,
      eventStore,
      backend: { kind: "docker-cloud", capacity: Number.POSITIVE_INFINITY },
    });
    assert.deepEqual(infiniteBackend.resolveBackendCapacity(), {
      reported: false,
      available: null,
    });

    const finiteBackend = new AdmissionController({
      settingsStore: settings,
      runStore,
      eventStore,
      backend: { kind: "docker-cloud", capacity: 3 },
    });
    assert.deepEqual(finiteBackend.resolveBackendCapacity(), { reported: true, available: 3 });
  });

  it("never floors a fractional concurrency setting down to zero", () => {
    const { runStore, eventStore } = makeHarness();
    const settings = {
      getSetting: (key: string) =>
        key === "parallelSoulStitchers" || key === "concurrentLiveRuns" ? 0.5 : undefined,
      validateRequiredSettings: () => ({ ok: true, missing: [] }),
    } as unknown as SettingsStore;
    const controller = new AdmissionController({ settingsStore: settings, runStore, eventStore });

    assert.equal(controller.maxParallelSoulStitchers(), 1);
    assert.equal(controller.effectiveConcurrentLiveRuns("docker-cloud"), 1);
    assert.equal(controller.effectiveConcurrentLiveRuns("instabox-docker"), 1);
    assert.equal(
      controller.checkAdmission({ backendKind: "instabox-docker", runId: "frac-1" }).admitted,
      true
    );
  });

  it("clamps a caller-supplied reserveSlot limit to the live-run ceiling", () => {
    const { runStore, eventStore } = makeHarness();
    const settings = {
      getSetting: (key: string) => (key === "concurrentLiveRuns" ? 99 : undefined),
      validateRequiredSettings: () => ({ ok: true, missing: [] }),
    } as unknown as SettingsStore;
    const controller = new AdmissionController({
      settingsStore: settings,
      runStore,
      eventStore,
      backend: { kind: "docker-cloud" },
    });
    assert.equal(controller.effectiveConcurrentLiveRuns(), 5);

    // A caller passing an over-large limit cannot reserve past the ceiling (5).
    for (let i = 0; i < 20; i += 1) {
      controller.reserveSlot(`clamp-${i}`, Number.MAX_SAFE_INTEGER);
    }
    assert.equal(controller.getReservedCount(), 5);
    assert.equal(controller.reserveSlot("clamp-overflow", 99), false);
  });

  it("fails closed when reading repoSizeCapKb throws, but admits when it is genuinely unset", () => {
    const { runStore, eventStore } = makeHarness();
    const throwing = {
      getSetting: (key: string) => {
        if (key === "repoSizeCapKb") {
          throw new Error("settings store unavailable");
        }
        return undefined;
      },
      validateRequiredSettings: () => ({ ok: true, missing: [] }),
    } as unknown as SettingsStore;
    const errorController = new AdmissionController({
      settingsStore: throwing,
      runStore,
      eventStore,
    });
    const denied = errorController.checkRepoSize(1);
    assert.equal(denied.admitted, false);
    assert.equal(denied.code, "SETTINGS_UNAVAILABLE");

    const unset = {
      getSetting: () => undefined,
      validateRequiredSettings: () => ({ ok: true, missing: [] }),
    } as unknown as SettingsStore;
    const unsetController = new AdmissionController({
      settingsStore: unset,
      runStore,
      eventStore,
    });
    assert.equal(unsetController.checkRepoSize(1_000_000).admitted, true);
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

  it("clamps every initial cap down to the code and global ceilings", () => {
    const { eventStore } = makeHarness();
    const governor = new BudgetGovernor({
      runId: "clamp-run",
      eventStore,
      caps: {
        toolCallsPerRun: 1000,
        promptsPerSkeleton: 1000,
        runWallClockMs: 1_000_000,
        contextPressurePercent: 500,
      },
      codeCeiling: {
        toolCallsPerRun: 10,
        promptsPerSkeleton: 8,
        runWallClockMs: 100_000,
        // contextPressurePercent intentionally has no code ceiling
      },
      globalCeiling: {
        toolCallsPerRun: 5,
        runWallClockMs: 50_000,
        contextPressurePercent: 90,
      },
    });

    // min(codeCeiling, globalCeiling): toolCallsPerRun -> min(10, 5) = 5.
    assert.equal(governor.getCap("toolCallsPerRun"), 5);
    // codeCeiling only: promptsPerSkeleton -> 8.
    assert.equal(governor.getCap("promptsPerSkeleton"), 8);
    // globalCeiling only: runWallClockMs -> min(1_000_000, 50_000) = 50_000.
    assert.equal(governor.getCap("runWallClockMs"), 50_000);
    // globalCeiling only: contextPressurePercent -> min(500, 90) = 90.
    assert.equal(governor.getCap("contextPressurePercent"), 90);
    assert.deepEqual(governor.getCaps(), {
      toolCallsPerRun: 5,
      promptsPerSkeleton: 8,
      runWallClockMs: 50_000,
      contextPressurePercent: 90,
    });
  });

  it("leaves an initial cap below both ceilings untouched", () => {
    const { eventStore } = makeHarness();
    const governor = new BudgetGovernor({
      runId: "under-ceiling-run",
      eventStore,
      caps: { toolCallsPerRun: 3 },
      codeCeiling: { toolCallsPerRun: 100 },
      globalCeiling: { toolCallsPerRun: 50 },
    });
    assert.equal(governor.getCap("toolCallsPerRun"), 3);
  });
});

