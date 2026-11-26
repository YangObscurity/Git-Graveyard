/**
 * Task 17.3 — unit and integration tests for the E11 SettingsStore and calibration script.
 *
 * Covers Requirements 30.1, 30.2, 30.3, 30.18 and 30.20.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import {
  ALWAYS_REQUIRED_SETTING_KEYS,
  CONDITIONAL_REQUIRED_SETTING_KEYS,
  E11_DEFAULT_SETTINGS,
  RequiredSettingMissingError,
  REQUIRED_SETTING_KEYS,
  SettingsStore,
  UNSET_VALUE_SENTINEL,
  assertRequiredSettingsConfigured,
  getDefaultSettingsStore,
  resetDefaultSettingsStore,
} from "../../lib/admin/settings-store";
import { EventStore, type EventEnvelope } from "../../lib/events/event-store";
import { RunStore } from "../../lib/runs/run-store";
import {
  APPLY_REQUIRES_STORE_MESSAGE,
  DEFAULT_CALIBRATION_ACTOR,
  analyzeRecordedRunsForCalibration,
  formatCalibrationMarkdown,
  loadCompletedRunsFromEventStore,
  loadRecordedRunsFromDir,
  parseCalibrationArgs,
  runCalibration,
  type CalibrationSourceRun,
} from "../../scripts/calibrate-e11";

const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface EvSpec {
  seq: number;
  ts: number;
  kind: string;
  actor?: string;
  data?: Record<string, unknown>;
  skeletonId?: string;
  taskId?: string;
}

function mkRun(runId: string, specs: EvSpec[]): CalibrationSourceRun {
  return {
    runId,
    events: specs.map((spec) => {
      const envelope: EventEnvelope = {
        runId,
        seq: spec.seq,
        ts: spec.ts,
        kind: spec.kind,
        actor: spec.actor ?? "necromancer",
        data: { refs: [], ...(spec.data ?? {}) },
      };
      if (spec.skeletonId) {
        envelope.skeletonId = spec.skeletonId;
      }
      if (spec.taskId) {
        envelope.taskId = spec.taskId;
      }
      return envelope;
    }),
  };
}

// --- Synthetic recorded-run fixtures -----------------------------------------
//
// Run A exercises: a prompt boundary, a Warden reject and approve, one approval wait, a silence
// gap, and overlapping run.clock pause + pact_review intervals (1100..1105 covered by both).
const runA = mkRun("calib-run-a", [
  { seq: 1, ts: 1_000_000, kind: "run.phase", data: { from: "queued", to: "exhume" } },
  { seq: 2, ts: 1_010_000, kind: "run.phase", data: { from: "plan", to: "pact_review" } },
  { seq: 3, ts: 1_020_000, kind: "run.clock", data: { action: "pause", phase: "pact_review" } },
  { seq: 4, ts: 1_050_000, kind: "run.phase", data: { from: "pact_review", to: "legion" } },
  { seq: 5, ts: 1_100_000, kind: "run.clock", data: { action: "resume", phase: "legion" } },
  { seq: 6, ts: 1_110_000, kind: "skeleton.raised", skeletonId: "sk-a" },
  { seq: 7, ts: 1_112_000, kind: "skeleton.tool_call", skeletonId: "sk-a" },
  { seq: 8, ts: 1_120_000, kind: "skeleton.usage", skeletonId: "sk-a" },
  { seq: 9, ts: 1_200_000, kind: "approval.requested", data: { approvalId: "appr-a-1" } },
  {
    seq: 10,
    ts: 1_500_000,
    kind: "approval.resolved",
    data: { approvalId: "appr-a-1", decision: "approved" },
  },
  { seq: 11, ts: 1_510_000, kind: "verdict", taskId: "t1", data: { verdict: "reject" } },
  { seq: 12, ts: 1_520_000, kind: "verdict", taskId: "t2", data: { verdict: "approve" } },
  { seq: 13, ts: 1_600_000, kind: "command.started", actor: "soulstitcher" },
  { seq: 14, ts: 1_650_000, kind: "command.result", actor: "soulstitcher" },
  { seq: 15, ts: 1_900_000, kind: "run.done", data: { outcome: "resurrected" } },
]);

// Run B exercises: a run.started start, four rejects on one task, and a large silence gap.
const runB = mkRun("calib-run-b", [
  { seq: 1, ts: 2_000_000, kind: "run.started" },
  { seq: 2, ts: 2_010_000, kind: "skeleton.tool_call", skeletonId: "sk-b" },
  { seq: 3, ts: 2_015_000, kind: "skeleton.usage", skeletonId: "sk-b" },
  { seq: 4, ts: 2_020_000, kind: "verdict", taskId: "t1", data: { verdict: "reject" } },
  { seq: 5, ts: 2_030_000, kind: "verdict", taskId: "t1", data: { verdict: "reject" } },
  { seq: 6, ts: 2_040_000, kind: "verdict", taskId: "t1", data: { verdict: "reject" } },
  { seq: 7, ts: 2_050_000, kind: "verdict", taskId: "t1", data: { verdict: "reject" } },
  { seq: 8, ts: 2_100_000, kind: "command.started", actor: "soulstitcher" },
  { seq: 9, ts: 2_300_000, kind: "command.result", actor: "soulstitcher" },
  { seq: 10, ts: 2_600_000, kind: "run.done", data: { outcome: "partial" } },
]);

// Run C exercises: a standalone run.clock pause, one reject, and no prompt boundary.
const runC = mkRun("calib-run-c", [
  { seq: 1, ts: 3_000_000, kind: "run.phase", data: { from: "queued", to: "exhume" } },
  { seq: 2, ts: 3_010_000, kind: "run.clock", data: { action: "pause", phase: "exhume" } },
  { seq: 3, ts: 3_040_000, kind: "run.clock", data: { action: "resume", phase: "plan" } },
  { seq: 4, ts: 3_050_000, kind: "verdict", taskId: "t1", data: { verdict: "reject" } },
  { seq: 5, ts: 3_060_000, kind: "skeleton.log", skeletonId: "sk-c" },
  { seq: 6, ts: 3_160_000, kind: "skeleton.tool_result", skeletonId: "sk-c" },
  { seq: 7, ts: 3_500_000, kind: "run.done", data: { outcome: "not_resurrected" } },
]);

// Minimal run: only a start and a run.done so every optional dimension is "not available".
const runD = mkRun("calib-run-d", [
  { seq: 1, ts: 4_000_000, kind: "run.phase", data: { from: "queued", to: "exhume" } },
  { seq: 2, ts: 4_100_000, kind: "run.done", data: { outcome: "resurrected" } },
]);

const threeRuns = [runA, runB, runC];


describe("SettingsStore — E11 defaults and required settings", () => {
  it("seeds the E11 starting values on init", () => {
    const store = new SettingsStore();
    for (const [key, value] of Object.entries(E11_DEFAULT_SETTINGS)) {
      assert.equal(store.getSetting(key), value, `${key} should default to ${value}`);
    }
    assert.equal(store.getSetting("wardenRounds"), 3);
    assert.equal(store.getSetting("silentSkeletonMs"), 120_000);
    assert.equal(store.getSetting("runWallClockMs"), 2_700_000);
    assert.equal(store.getSetting("temp"), undefined);
    store.close();
  });

  it("enumerates Required_Settings as unset (no starting value)", () => {
    const store = new SettingsStore();
    for (const key of REQUIRED_SETTING_KEYS) {
      assert.equal(store.getSetting(key), undefined, `${key} must ship unset`);
    }
    assert.ok(ALWAYS_REQUIRED_SETTING_KEYS.includes("toolCallsPerRun"));
    assert.ok(ALWAYS_REQUIRED_SETTING_KEYS.includes("brokerWatchdogMs"));
    assert.deepEqual([...CONDITIONAL_REQUIRED_SETTING_KEYS], ["creditsPerRun", "creditsPerDay"]);
    store.close();
  });

  it("does not overwrite existing database values when re-opened", () => {
    const dir = makeTmpDir("gg-settings-");
    const dbPath = path.join(dir, "settings.db");

    const first = new SettingsStore(dbPath);
    first.setSetting("wardenRounds", 7, { actor: "owner" });
    first.close();

    const second = new SettingsStore(dbPath);
    assert.equal(second.getSetting("wardenRounds"), 7);
    // A key that was never touched still receives the shipped default.
    assert.equal(second.getSetting("queueDepth"), 5);
    second.close();
  });

  it("rejects missing Required_Settings and refuses run startup", () => {
    const store = new SettingsStore();

    let result = store.validateRequiredSettings();
    assert.equal(result.ok, false);
    assert.equal(result.code, "REQUIRED_SETTING_MISSING");
    assert.ok(result.missing.includes("toolCallsPerRun"));
    assert.ok(result.missing.includes("approvalWaitMs"));
    assert.ok(result.missing.includes("queueIdleLimitMs"));
    assert.ok(!result.missing.includes("creditsPerRun"));

    assert.throws(
      () => assertRequiredSettingsConfigured(store),
      (err: unknown) => {
        assert.ok(err instanceof RequiredSettingMissingError);
        assert.ok(err.missing.includes("toolCallsPerRun"));
        assert.equal(err.code, "REQUIRED_SETTING_MISSING");
        return true;
      }
    );

    for (const key of ALWAYS_REQUIRED_SETTING_KEYS) {
      store.setSetting(key, 1000, { actor: "owner" });
    }
    result = store.validateRequiredSettings();
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
    assert.doesNotThrow(() => assertRequiredSettingsConfigured(store));

    store.close();
  });

  it("treats creditsPerRun / creditsPerDay as conditionally required", () => {
    const store = new SettingsStore();
    for (const key of ALWAYS_REQUIRED_SETTING_KEYS) {
      store.setSetting(key, 1, { actor: "owner" });
    }

    assert.equal(store.validateRequiredSettings().ok, true);

    const withCredits = store.validateRequiredSettings({ creditsReported: true });
    assert.equal(withCredits.ok, false);
    assert.deepEqual(withCredits.missing, ["creditsPerRun", "creditsPerDay"]);

    store.setSettingsBatch({ creditsPerRun: 60, creditsPerDay: 300 }, { actor: "owner" });
    assert.equal(store.validateRequiredSettings({ creditsReported: true }).ok, true);
    store.close();
  });

  it("rejects NaN, Infinity, negative numbers, arrays and undefined", () => {
    const store = new SettingsStore();
    assert.throws(
      () => store.setSetting("wardenRounds", Number.NaN, { actor: "owner" }),
      RangeError
    );
    assert.throws(() => store.setSetting("wardenRounds", Infinity, { actor: "owner" }), RangeError);
    assert.throws(() => store.setSetting("wardenRounds", -5, { actor: "owner" }), RangeError);
    assert.throws(() => store.setSetting("wardenRounds", [1, 2], { actor: "owner" }), TypeError);
    assert.throws(() => store.setSetting("wardenRounds", undefined, { actor: "owner" }), TypeError);
    assert.throws(() => store.setSetting("wardenRounds", 4, { actor: "  " }), TypeError);
    // Nothing was written by the rejected calls.
    assert.equal(store.getSetting("wardenRounds"), 3);
    store.close();
  });
});

describe("SettingsStore — audit trail", () => {
  it("records before/after values with actor and reason", () => {
    const store = new SettingsStore();
    const entry = store.setSetting("wardenRounds", 5, {
      actor: "owner",
      reason: "E11 tuning",
      ts: 1000,
    });

    assert.equal(entry.beforeValue, 3);
    assert.equal(entry.afterValue, 5);
    assert.equal(entry.ts, 1000);
    assert.equal(entry.actor, "owner");
    assert.equal(entry.reason, "E11 tuning");

    const log = store.getAuditLog({ key: "wardenRounds" });
    assert.equal(log.length, 1);
    assert.equal(log[0].beforeValue, 3);
    assert.equal(log[0].afterValue, 5);

    const batch = store.setSettingsBatch(
      { wardenRounds: 6, silentSkeletonMs: 130_000 },
      { actor: "admin", reason: "batch", ts: 2000 }
    );
    assert.equal(batch.length, 2);

    const recent = store.getAuditLog({ limit: 2 });
    assert.equal(recent.length, 2);
    assert.equal(recent[recent.length - 1].key, "silentSkeletonMs");
    assert.equal(store.getSetting("wardenRounds"), 6);
    store.close();
  });
});


describe("SettingsStore — explicit null vs unset sentinel (FIND-003 regression)", () => {
  it("round-trips an explicit null and never collapses it to unset", () => {
    const store = new SettingsStore();
    const entry = store.setSetting("customNote", null, {
      actor: "owner",
      reason: "explicit null",
    });

    // First write: the key did not exist, so the audit "before" is unset (undefined).
    assert.equal(entry.beforeValue, undefined);
    assert.equal(entry.afterValue, null);
    assert.equal(store.getSetting("customNote"), null);

    const all = store.getAllSettings();
    assert.ok(Object.prototype.hasOwnProperty.call(all, "customNote"));
    assert.equal(all.customNote, null);

    const log = store.getAuditLog({ key: "customNote" });
    assert.equal(log.length, 1);
    assert.equal(log[0].beforeValue, undefined);
    assert.equal(log[0].afterValue, null);

    // A second explicit null is still distinguishable from unset in the audit trail.
    store.setSetting("customNote", null, { actor: "owner", reason: "again" });
    const log2 = store.getAuditLog({ key: "customNote" });
    assert.equal(log2.length, 2);
    assert.equal(log2[1].beforeValue, null);
    assert.equal(log2[1].afterValue, null);
    store.close();
  });

  it("seeds Required_Settings with the non-JSON sentinel, not a literal null", () => {
    const store = new SettingsStore();
    const row = store.db
      .prepare("SELECT valueJson, updatedBy FROM admin_settings WHERE key = ?")
      .get("toolCallsPerRun") as { valueJson: string; updatedBy: string };

    assert.equal(row.valueJson, UNSET_VALUE_SENTINEL);
    assert.equal(row.updatedBy, "system:required");

    assert.equal(store.getSetting("toolCallsPerRun"), undefined);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(store.getAllSettings(), "toolCallsPerRun")
    );

    const validation = store.validateRequiredSettings();
    assert.equal(validation.ok, false);
    assert.ok(validation.missing.includes("toolCallsPerRun"));
    store.close();
  });

  it("treats legacy \"null\" + system:required rows as unset but honours explicit null", () => {
    const dir = makeTmpDir("gg-settings-legacy-");
    const dbPath = path.join(dir, "settings.db");

    // Simulate a database written before the sentinel existed.
    const first = new SettingsStore(dbPath);
    first.db.exec(
      "UPDATE admin_settings SET valueJson = 'null', updatedBy = 'system:required' " +
        "WHERE key = 'brokerWatchdogMs'"
    );
    first.close();

    const reopened = new SettingsStore(dbPath);
    assert.equal(reopened.getSetting("brokerWatchdogMs"), undefined);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(reopened.getAllSettings(), "brokerWatchdogMs")
    );
    assert.ok(reopened.validateRequiredSettings().missing.includes("brokerWatchdogMs"));

    // An explicit null set by a real actor must survive as a genuine null...
    reopened.setSetting("brokerWatchdogMs", null, { actor: "owner" });
    assert.equal(reopened.getSetting("brokerWatchdogMs"), null);
    assert.equal(reopened.getAllSettings().brokerWatchdogMs, null);
    // ...while still counting as missing for the Required_Settings gate.
    assert.ok(reopened.validateRequiredSettings().missing.includes("brokerWatchdogMs"));

    const audit = reopened.getAuditLog({ key: "brokerWatchdogMs" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].beforeValue, undefined);
    assert.equal(audit[0].afterValue, null);
    reopened.close();
  });
});


describe("SettingsStore — recalibrationRequired (Requirement 30.20)", () => {
  function addCompletedRun(eventStore: EventStore, runStore: RunStore, runId: string): void {
    runStore.createRun({
      runId,
      url: `https://github.com/example/${runId}`,
      sha: "0".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });
    eventStore.append({
      runId,
      kind: "run.done",
      actor: "necromancer",
      data: { outcome: "resurrected" },
    });
  }

  it("toggles true exactly when the third completed recorded run concludes", () => {
    const store = new SettingsStore();
    const eventStore = new EventStore(":memory:");
    const runStore = new RunStore(":memory:");

    addCompletedRun(eventStore, runStore, "r1");
    addCompletedRun(eventStore, runStore, "r2");
    let sync = store.syncRecordedRunCount({ eventStore, runStore });
    assert.equal(sync.completedRecordedRuns, 2);
    assert.equal(sync.recalibrationRequired, false);
    assert.equal(store.isRecalibrationRequired(), false);

    addCompletedRun(eventStore, runStore, "r3");
    sync = store.syncRecordedRunCount({ eventStore, runStore });
    assert.equal(sync.completedRecordedRuns, 3);
    assert.equal(sync.recalibrationRequired, true);
    assert.equal(store.isRecalibrationRequired(), true);
    assert.equal(store.getCalibrationState().completedRecordedRuns, 3);

    store.markCalibrated({ actor: "owner", runIds: ["r1", "r2", "r3"], ts: 5555 });
    assert.equal(store.isRecalibrationRequired(), false);
    const state = store.getCalibrationState();
    assert.equal(state.lastCalibratedAt, 5555);
    assert.deepEqual(state.lastCalibratedRunIds, ["r1", "r2", "r3"]);

    // A later run re-arms recalibration.
    addCompletedRun(eventStore, runStore, "r4");
    sync = store.syncRecordedRunCount({ eventStore, runStore });
    assert.equal(sync.completedRecordedRuns, 4);
    assert.equal(sync.recalibrationRequired, true);

    // Explicit recordedRunIds count unique IDs, ignoring store contents.
    sync = store.syncRecordedRunCount({ recordedRunIds: ["r1", "r2", "r3", "r3"] });
    assert.equal(sync.completedRecordedRuns, 3);

    store.close();
    eventStore.close();
    runStore.close();
  });

  it("resolves the default store path from SETTINGS_STORE_PATH", () => {
    const dir = makeTmpDir("gg-settings-default-");
    const dbPath = path.join(dir, "settings.db");
    const prev = process.env.SETTINGS_STORE_PATH;
    process.env.SETTINGS_STORE_PATH = dbPath;
    try {
      const store = getDefaultSettingsStore();
      store.setSetting("wardenRounds", 9, { actor: "owner" });
      assert.equal(getDefaultSettingsStore().getSetting("wardenRounds"), 9);
    } finally {
      resetDefaultSettingsStore();
      if (prev === undefined) {
        delete process.env.SETTINGS_STORE_PATH;
      } else {
        process.env.SETTINGS_STORE_PATH = prev;
      }
    }
    assert.ok(fs.existsSync(dbPath));
  });
});


describe("analyzeRecordedRunsForCalibration — metrics from recorded events", () => {
  const analysis = analyzeRecordedRunsForCalibration(threeRuns);

  it("counts Warden rejection rounds per (run, task)", () => {
    const metric = analysis.wardenRejectionRoundsPerTask;
    assert.equal(metric.status, "available");
    assert.deepEqual([...metric.samples].sort((a, b) => a - b), [0, 1, 1, 4]);
    assert.equal(metric.min, 0);
    assert.equal(metric.median, 1);
    assert.equal(metric.max, 4);
    assert.equal(metric.p90, 4);
    assert.ok(metric.citations.includes("ev:11"));
    assert.ok(metric.citations.includes("ev:4"));
  });

  it("pairs prompt boundaries into durations", () => {
    const metric = analysis.promptDurationsMs;
    assert.equal(metric.status, "available");
    assert.deepEqual([...metric.samples].sort((a, b) => a - b), [5_000, 10_000]);
    assert.ok(metric.citations.includes("ev:6..ev:8"));
    assert.ok(metric.citations.includes("ev:2..ev:3"));
  });

  it("subtracts overlapping run.clock and Pact pauses exactly once", () => {
    assert.equal(analysis.runWallClockDetails.length, 3);
    const detailA = analysis.runWallClockDetails.find((d) => d.runId === "calib-run-a");
    assert.ok(detailA);
    assert.equal(detailA.startCitation, "ev:1");
    assert.equal(detailA.endCitation, "ev:15");
    assert.equal(detailA.totalMs, 900_000);
    // The run.clock (80_000) and Pact (40_000) intervals overlap, so they must be merged to
    // 90_000 (1_010_000..1_100_000). The approval wait (300_000) is a disjoint span, and run A's
    // merged paused total is 90_000 + 300_000 = 390_000 (WP-17-fix2: approval waits are excluded).
    assert.equal(detailA.pausedMs, 390_000);
    assert.equal(detailA.activeMs, 510_000);
    assert.equal(detailA.pauseIntervals.length, 3);
    assert.deepEqual(
      detailA.pauseIntervals.map((p) => p.source).sort(),
      ["approval_wait", "pact_review", "run.clock"]
    );
    assert.ok(detailA.pauseIntervals.every((p) => p.startCitation.startsWith("ev:")));

    // The overlapping clock/Pact pair still merges exactly once: the naive sum of the two clamped
    // (pre-merge) durations is 120_000, but only 90_000 of merged time is subtracted.
    const clockAndPact = detailA.pauseIntervals.filter((p) => p.source !== "approval_wait");
    assert.equal(clockAndPact.reduce((acc, p) => acc + p.durationMs, 0), 120_000);
    assert.equal(detailA.pausedMs - 300_000, 90_000);

    const detailB = analysis.runWallClockDetails.find((d) => d.runId === "calib-run-b");
    assert.ok(detailB);
    assert.equal(detailB.startCitation, "ev:1");
    assert.equal(detailB.activeMs, 600_000);
    assert.equal(detailB.pausedMs, 0);

    const detailC = analysis.runWallClockDetails.find((d) => d.runId === "calib-run-c");
    assert.ok(detailC);
    assert.equal(detailC.pausedMs, 30_000);
    assert.equal(detailC.activeMs, 470_000);

    const metric = analysis.runWallClockExcludingPactMs;
    assert.equal(metric.status, "available");
    assert.deepEqual([...metric.samples].sort((a, b) => a - b), [470_000, 510_000, 600_000]);
    assert.equal(metric.max, 600_000);
  });

  it("measures approval request -> resolve wait times", () => {
    const metric = analysis.approvalWaitTimesMs;
    assert.equal(metric.status, "available");
    assert.deepEqual(metric.samples, [300_000]);
    assert.ok(metric.citations.includes("ev:9..ev:10"));
  });

  it("measures the maximum skeleton silence gap per run (excluding in-flight spans)", () => {
    const metric = analysis.silenceDurationsMs;
    assert.equal(metric.status, "available");
    // Run A keeps its 488_000 gap (its lone skeleton.tool_call has no result, so it is not an
    // in-flight span); run C keeps 100_000. Run B's 200_000 command.started -> command.result span
    // is in-flight work, not silence, so its maximum gap drops to 90_000 (Requirement 41.12).
    assert.deepEqual([...metric.samples].sort((a, b) => a - b), [90_000, 100_000, 488_000]);
    assert.equal(metric.max, 488_000);
    assert.ok(metric.citations.includes("ev:7..ev:13"));
  });

  it("proposes calibrated settings with citations", () => {
    const warden = analysis.proposals.find((p) => p.key === "wardenRounds");
    assert.ok(warden);
    assert.equal(warden.currentDefault, 3);
    assert.equal(warden.proposedValue, 5); // ceil(4 * 1.25)
    assert.ok(warden.citations.includes("ev:11"));

    const silence = analysis.proposals.find((p) => p.key === "silentSkeletonMs");
    assert.ok(silence);
    assert.equal(silence.currentDefault, 120_000);
    assert.equal(silence.proposedValue, 610_000); // ceil(488_000 * 1.25)

    const approval = analysis.proposals.find((p) => p.key === "approvalWaitMs");
    assert.ok(approval);
    assert.equal(approval.currentDefault, null);
    assert.equal(approval.proposedValue, 375_000);

    const prompt = analysis.proposals.find((p) => p.key === "promptWallClockMs");
    assert.ok(prompt);
    assert.equal(prompt.proposedValue, 12_500);

    const queueIdle = analysis.proposals.find((p) => p.key === "queueIdleLimitMs");
    assert.ok(queueIdle);
    assert.equal(queueIdle.proposedValue, null);
    assert.deepEqual(queueIdle.observedSamples, []);
  });

  it("reports dimensions without recorded data as not available (never 0)", () => {
    const missing = analyzeRecordedRunsForCalibration([runB, runC]);
    assert.equal(missing.approvalWaitTimesMs.status, "not available");
    assert.equal(missing.approvalWaitTimesMs.max, null);
    assert.equal(missing.approvalWaitTimesMs.samples.length, 0);

    const minimal = analyzeRecordedRunsForCalibration([runD]);
    assert.equal(minimal.promptDurationsMs.status, "not available");
    assert.equal(minimal.promptDurationsMs.max, null);
    assert.equal(minimal.silenceDurationsMs.status, "not available");
    assert.equal(minimal.wardenRejectionRoundsPerTask.status, "not available");
    // The run clock is still available because a start and a run.done were recorded.
    assert.equal(minimal.runWallClockExcludingPactMs.status, "available");
    assert.equal(minimal.runWallClockExcludingPactMs.samples[0], 100_000);
  });

  it("renders a Markdown comparison table", () => {
    const md = formatCalibrationMarkdown(analysis);
    assert.ok(md.includes("# E11 Calibration Summary"));
    assert.ok(md.includes("wardenRounds"));
    assert.ok(md.includes("silentSkeletonMs"));
    assert.ok(md.includes("## Proposed settings"));
    assert.ok(md.includes("ev:11"));
  });
});


describe("proposeValue — cap floors (FIND-002 regression)", () => {
  // Three clean runs: every task approved (0 rejections) and an instant prompt boundary
  // (skeleton.raised and skeleton.usage share a timestamp) so the deltas are 0 ms.
  function cleanRun(runId: string, baseTs: number): CalibrationSourceRun {
    return mkRun(runId, [
      { seq: 1, ts: baseTs, kind: "run.phase", data: { from: "queued", to: "exhume" } },
      { seq: 2, ts: baseTs + 5, kind: "skeleton.raised", skeletonId: "sk-clean" },
      { seq: 3, ts: baseTs + 5, kind: "skeleton.usage", skeletonId: "sk-clean" },
      { seq: 4, ts: baseTs + 10, kind: "verdict", taskId: "t1", data: { verdict: "approve" } },
      { seq: 5, ts: baseTs + 20, kind: "run.done", data: { outcome: "resurrected" } },
    ]);
  }

  it("never proposes 0 wardenRounds for a run set with no rejections", () => {
    const runs = [
      cleanRun("clean-1", 1_000_000),
      cleanRun("clean-2", 2_000_000),
      cleanRun("clean-3", 3_000_000),
    ];
    const analysis = analyzeRecordedRunsForCalibration(runs);

    // The Warden dimension is "available" with an observed maximum of 0 rejections.
    assert.equal(analysis.wardenRejectionRoundsPerTask.status, "available");
    assert.equal(analysis.wardenRejectionRoundsPerTask.max, 0);

    const warden = analysis.proposals.find((p) => p.key === "wardenRounds");
    assert.ok(warden);
    assert.notEqual(warden.proposedValue, 0);
    assert.ok(
      (warden.proposedValue ?? 0) >= 1,
      `wardenRounds must stay >= 1 (got ${String(warden.proposedValue)})`
    );
  });

  it("never proposes a 0 ms timeout for instant/synthetic runs", () => {
    const runs = [
      cleanRun("clean-1", 1_000_000),
      cleanRun("clean-2", 2_000_000),
      cleanRun("clean-3", 3_000_000),
    ];
    const analysis = analyzeRecordedRunsForCalibration(runs);

    // A paired prompt boundary exists, but its duration is 0 ms.
    assert.equal(analysis.promptDurationsMs.status, "available");
    assert.equal(analysis.promptDurationsMs.max, 0);

    const prompt = analysis.proposals.find((p) => p.key === "promptWallClockMs");
    assert.ok(prompt);
    assert.notEqual(prompt.proposedValue, 0);
    assert.ok(
      (prompt.proposedValue ?? 0) >= 1000,
      `promptWallClockMs must keep a positive >= 1000 ms floor (got ${String(
        prompt.proposedValue
      )})`
    );

    // Every timeout-like proposal keeps a positive floor too.
    for (const key of ["promptWallClockMs", "runWallClockMs", "silentSkeletonMs"]) {
      const proposal = analysis.proposals.find((p) => p.key === key);
      if (proposal && proposal.proposedValue !== null) {
        assert.ok(proposal.proposedValue > 0, `${key} must never propose 0`);
      }
    }
  });
});


describe("runCalibration — recorded runs directory and --apply", () => {
  function writeRunDir(root: string, run: CalibrationSourceRun): void {
    const runDir = path.join(root, run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const ndjson = `${run.events.map((ev) => JSON.stringify(ev)).join("\n")}\n`;
    fs.writeFileSync(path.join(runDir, "events.ndjson"), ndjson, "utf8");
  }

  function writeThreeRuns(): string {
    const root = makeTmpDir("gg-calib-runs-");
    writeRunDir(root, runA);
    writeRunDir(root, runB);
    writeRunDir(root, runC);
    writeRunDir(root, runD); // a fourth run that must be ignored (only the first three are read)
    return root;
  }

  it("loads the first three recorded runs from a directory", () => {
    const root = writeThreeRuns();
    const loaded = loadRecordedRunsFromDir(root, 3);
    assert.deepEqual(
      loaded.map((r) => r.runId),
      ["calib-run-a", "calib-run-b", "calib-run-c"]
    );
    assert.equal(loaded[0].events.length, runA.events.length);
    assert.equal(loaded[0].events[0].kind, "run.phase");
  });

  it("reports recalibration as required without applying", () => {
    const root = writeThreeRuns();
    const settingsStore = new SettingsStore();
    const result = runCalibration({ runsDir: root, settingsStore });

    assert.deepEqual(result.runIds, ["calib-run-a", "calib-run-b", "calib-run-c"]);
    assert.equal(result.applied.length, 0);
    assert.equal(result.recalibrationRequired, true);
    assert.ok(result.markdown.includes("E11 Calibration Summary"));
    const json = JSON.parse(result.json) as { analysis: { runIds: string[] } };
    assert.deepEqual(json.analysis.runIds, ["calib-run-a", "calib-run-b", "calib-run-c"]);

    settingsStore.close();
  });

  it("commits calibrated settings with audit entries and ev citations on --apply", () => {
    const root = writeThreeRuns();
    const settingsStore = new SettingsStore();
    const result = runCalibration({
      runsDir: root,
      settingsStore,
      apply: true,
      actor: "owner",
      ts: 12_345,
    });

    assert.equal(result.applied.length, 5);
    assert.equal(settingsStore.getSetting("wardenRounds"), 5);
    assert.equal(settingsStore.getSetting("silentSkeletonMs"), 610_000);
    assert.equal(settingsStore.getSetting("approvalWaitMs"), 375_000);

    const audit = settingsStore.getAuditLog({ key: "wardenRounds" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].beforeValue, 3);
    assert.equal(audit[0].afterValue, 5);
    assert.equal(audit[0].actor, "owner");
    assert.ok(audit[0].reason && audit[0].reason.includes("ev:11"));

    const state = settingsStore.getCalibrationState();
    assert.equal(state.recalibrationRequired, false);
    assert.equal(state.lastCalibratedAt, 12_345);
    assert.deepEqual(
      [...state.lastCalibratedRunIds].sort(),
      ["calib-run-a", "calib-run-b", "calib-run-c"]
    );
    assert.equal(result.recalibrationRequired, false);

    settingsStore.close();
  });

  it("reads completed runs from an EventStore", () => {
    const eventStore = new EventStore(":memory:");
    for (const run of threeRuns) {
      eventStore.appendBatch(
        run.events.map((ev) => ({
          runId: ev.runId,
          kind: ev.kind,
          actor: ev.actor,
          ts: ev.ts,
          data: ev.data,
          skeletonId: ev.skeletonId ?? null,
          taskId: ev.taskId ?? null,
        }))
      );
    }
    const result = runCalibration({ eventStore, limit: 3 });
    assert.deepEqual(result.runIds, ["calib-run-a", "calib-run-b", "calib-run-c"]);
    assert.equal(result.analysis.wardenRejectionRoundsPerTask.max, 4);
    eventStore.close();
  });

  it("parses CLI flags for the calibration script", () => {
    const options = parseCalibrationArgs([
      "--runs-dir",
      "/tmp/runs",
      "--settings-db",
      "/tmp/settings.db",
      "--json",
      "--apply",
      "--actor",
      "owner",
      "--out",
      "/tmp/out.json",
    ]);
    assert.equal(options.runsDir, "/tmp/runs");
    assert.equal(options.settingsDb, "/tmp/settings.db");
    assert.equal(options.json, true);
    assert.equal(options.apply, true);
    assert.equal(options.actor, "owner");
    assert.equal(options.out, "/tmp/out.json");
    assert.equal(options.markdown, false);
  });

  it("throws when --apply is requested without a SettingsStore or settings-db path", () => {
    assert.throws(
      () => runCalibration({ apply: true }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, APPLY_REQUIRES_STORE_MESSAGE);
        return true;
      }
    );
    // A runs dir cannot rescue an apply with no store to persist into.
    assert.throws(
      () => runCalibration({ apply: true, runsDir: makeTmpDir("gg-calib-noop-") }),
      /--apply requires a SettingsStore instance or settings-db path/
    );
  });

  it("attributes an --apply without an explicit actor to the documented owner default", () => {
    assert.equal(DEFAULT_CALIBRATION_ACTOR, "owner");
    const root = writeThreeRuns();
    const settingsStore = new SettingsStore();
    runCalibration({ runsDir: root, settingsStore, apply: true });

    const audit = settingsStore.getAuditLog({ key: "wardenRounds" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, DEFAULT_CALIBRATION_ACTOR);
    settingsStore.close();
  });

  it("commits settings via the CLI when --settings-db is omitted (SETTINGS_STORE_PATH)", () => {
    const root = writeThreeRuns();
    const dbDir = makeTmpDir("gg-calib-cli-");
    const dbPath = path.join(dbDir, "settings.db");

    const tsxCli = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = path.resolve(process.cwd(), "scripts", "calibrate-e11.ts");
    const proc = spawnSync(
      process.execPath,
      [tsxCli, scriptPath, "--runs-dir", root, "--apply", "--actor", "owner", "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, SETTINGS_STORE_PATH: dbPath },
        encoding: "utf8",
      }
    );

    assert.equal(proc.status, 0, `CLI exited with ${String(proc.status)}: ${proc.stderr ?? ""}`);
    assert.ok(fs.existsSync(dbPath), "the settings DB should have been created");

    const store = new SettingsStore(dbPath);
    assert.equal(store.getSetting("wardenRounds"), 5);
    assert.equal(store.getSetting("silentSkeletonMs"), 610_000);
    assert.equal(store.isRecalibrationRequired(), false);

    const audit = store.getAuditLog({ key: "wardenRounds" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, "owner");
    store.close();
  });
});


describe("completed-run filtering — errored runs (FIND-004 regression)", () => {
  // Sorts before "calib-run-a" so a broken filter would wrongly occupy the first slot.
  const erroredRun = mkRun("0-calib-run-error", [
    { seq: 1, ts: 500_000, kind: "run.started" },
    { seq: 2, ts: 600_000, kind: "run.done", data: { outcome: "error" } },
  ]);

  function writeRunDir(root: string, run: CalibrationSourceRun): void {
    const runDir = path.join(root, run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const ndjson = `${run.events.map((ev) => JSON.stringify(ev)).join("\n")}\n`;
    fs.writeFileSync(path.join(runDir, "events.ndjson"), ndjson, "utf8");
  }

  it("excludes an errored run when loading from --runs-dir", () => {
    const root = makeTmpDir("gg-calib-runs-err-");
    writeRunDir(root, runA);
    writeRunDir(root, runB);
    writeRunDir(root, runC);
    writeRunDir(root, erroredRun);

    const loaded = loadRecordedRunsFromDir(root, 4);
    assert.ok(!loaded.some((r) => r.runId === "0-calib-run-error"));
    assert.deepEqual(
      loaded.map((r) => r.runId),
      ["calib-run-a", "calib-run-b", "calib-run-c"]
    );

    const result = runCalibration({ runsDir: root, limit: 3 });
    assert.ok(!result.runIds.includes("0-calib-run-error"));
    assert.deepEqual(result.runIds, ["calib-run-a", "calib-run-b", "calib-run-c"]);
  });

  it("excludes an errored run when loading from an EventStore", () => {
    const eventStore = new EventStore(":memory:");
    for (const run of [erroredRun, runA, runB, runC]) {
      eventStore.appendBatch(
        run.events.map((ev) => ({
          runId: ev.runId,
          kind: ev.kind,
          actor: ev.actor,
          ts: ev.ts,
          data: ev.data,
          skeletonId: ev.skeletonId ?? null,
          taskId: ev.taskId ?? null,
        }))
      );
    }

    const loaded = loadCompletedRunsFromEventStore(eventStore, 4);
    assert.ok(!loaded.some((r) => r.runId === "0-calib-run-error"));
    assert.deepEqual(
      loaded.map((r) => r.runId),
      ["calib-run-a", "calib-run-b", "calib-run-c"]
    );

    const result = runCalibration({ eventStore, limit: 3 });
    assert.ok(!result.runIds.includes("0-calib-run-error"));
    assert.equal(result.analysis.wardenRejectionRoundsPerTask.max, 4);
    eventStore.close();
  });

  it("syncRecordedRunCount rejects an errored run.done from both stores", () => {
    const store = new SettingsStore();
    const eventStore = new EventStore(":memory:");
    const runStore = new RunStore(":memory:");

    for (const runId of ["r1", "r2", "r3"]) {
      runStore.createRun({
        runId,
        url: `https://github.com/example/${runId}`,
        sha: "0".repeat(40),
        phase: "done",
        outcome: "resurrected",
      });
      eventStore.append({
        runId,
        kind: "run.done",
        actor: "necromancer",
        data: { outcome: "resurrected" },
      });
    }

    runStore.createRun({
      runId: "r-err",
      url: "https://github.com/example/r-err",
      sha: "0".repeat(40),
      phase: "done",
      outcome: "error",
    });
    eventStore.append({
      runId: "r-err",
      kind: "run.done",
      actor: "necromancer",
      data: { outcome: "error" },
    });

    const both = store.syncRecordedRunCount({ eventStore, runStore });
    assert.equal(both.completedRecordedRuns, 3);

    // The eventStore-only path must agree (FIND-004: it used to count the errored run).
    const eventsOnly = store.syncRecordedRunCount({ eventStore });
    assert.equal(eventsOnly.completedRecordedRuns, 3);

    // The runStore-only path must agree too.
    const runsOnly = store.syncRecordedRunCount({ runStore });
    assert.equal(runsOnly.completedRecordedRuns, 3);

    store.close();
    eventStore.close();
    runStore.close();
  });
});


describe("WP-17-fix2 regressions — Cubic & PR-Agent findings", () => {
  function writeRunDir(root: string, run: CalibrationSourceRun): void {
    const runDir = path.join(root, run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const ndjson = `${run.events.map((ev) => JSON.stringify(ev)).join("\n")}\n`;
    fs.writeFileSync(path.join(runDir, "events.ndjson"), ndjson, "utf8");
  }

  // --- Item 1: isPlainObject / prototype-pollution hardening -----------------

  it("rejects Map/Set/Date/RegExp setting values with a TypeError (item 1)", () => {
    const store = new SettingsStore();
    for (const value of [new Map(), new Set(), new Date(), /re/]) {
      assert.throws(
        () => store.setSetting("customStructured", value, { actor: "owner" }),
        TypeError
      );
    }
    assert.equal(store.getSetting("customStructured"), undefined);
    // A genuine plain object is still accepted.
    store.setSetting("customStructured", { note: "ok" }, { actor: "owner" });
    assert.deepEqual(store.getSetting("customStructured"), { note: "ok" });
    store.close();
  });

  it("rejects reserved prototype-pollution setting keys (item 1)", () => {
    const store = new SettingsStore();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      assert.throws(() => store.setSetting(key, 1, { actor: "owner" }), TypeError);
    }

    // An own, enumerable `__proto__` property must also be rejected by the batch API.
    const malicious: Record<string, unknown> = {};
    Object.defineProperty(malicious, "__proto__", {
      value: 1,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    assert.throws(() => store.setSettingsBatch(malicious, { actor: "owner" }), TypeError);

    // Nothing leaked onto the global Object prototype.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    store.close();
  });

  it("getAllSettings assigns via defineProperty so a __proto__ row cannot pollute (item 1)", () => {
    const store = new SettingsStore();
    store.db
      .prepare(
        "INSERT INTO admin_settings (key, valueJson, isRequired, updatedAt, updatedBy) " +
          "VALUES (?, ?, 0, 0, 'system:test')"
      )
      .run("__proto__", JSON.stringify({ polluted: true }));

    const all = store.getAllSettings();
    assert.ok(Object.prototype.hasOwnProperty.call(all, "__proto__"));
    assert.equal(Object.getPrototypeOf(all), Object.prototype);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    store.close();
  });

  // --- Item 2: concurrentLiveRuns -------------------------------------------

  it("seeds an editable concurrentLiveRuns default of 1 and validates it (item 2)", () => {
    const store = new SettingsStore();
    assert.equal(E11_DEFAULT_SETTINGS.concurrentLiveRuns, 1);
    assert.equal(store.getSetting("concurrentLiveRuns"), 1);

    store.setSetting("concurrentLiveRuns", 5, { actor: "owner" });
    assert.equal(store.getSetting("concurrentLiveRuns"), 5);

    assert.throws(() => store.setSetting("concurrentLiveRuns", -1, { actor: "owner" }), RangeError);
    assert.throws(() => store.setSetting("concurrentLiveRuns", 1.5, { actor: "owner" }), RangeError);
    store.close();
  });

  // --- Item 3: EventStore run.done override & seq ordering -------------------

  it("lets an errored eventStore run.done override a completed runStore row (item 3)", () => {
    const store = new SettingsStore();
    const eventStore = new EventStore(":memory:");
    const runStore = new RunStore(":memory:");

    for (const runId of ["e1", "e2", "e3"]) {
      runStore.createRun({
        runId,
        url: `https://github.com/example/${runId}`,
        sha: "0".repeat(40),
        phase: "done",
        outcome: "resurrected",
      });
      eventStore.append({
        runId,
        kind: "run.done",
        actor: "necromancer",
        data: { outcome: "resurrected" },
      });
    }

    // The RunStore records run e4 as complete, but its latest run.done reports an error.
    runStore.createRun({
      runId: "e4",
      url: "https://github.com/example/e4",
      sha: "0".repeat(40),
      phase: "done",
      outcome: "resurrected",
    });
    eventStore.append({
      runId: "e4",
      kind: "run.done",
      actor: "necromancer",
      data: { outcome: "resurrected" },
    });
    eventStore.append({
      runId: "e4",
      kind: "run.done",
      actor: "necromancer",
      data: { outcome: "error" },
    });

    const sync = store.syncRecordedRunCount({ eventStore, runStore });
    assert.equal(sync.completedRecordedRuns, 3);

    store.close();
    eventStore.close();
    runStore.close();
  });

  it("picks the latest run.done by seq, tie-breaking on the later index (item 3)", () => {
    const store = new SettingsStore();
    const eventStore = new EventStore(":memory:");

    for (const runId of ["s1", "s2", "s3"]) {
      eventStore.append({
        runId,
        kind: "run.done",
        actor: "necromancer",
        data: { outcome: "resurrected" },
      });
    }
    // error first, then resurrected -> the latest (by seq) outcome wins, so the run is completed.
    eventStore.append({
      runId: "s4",
      kind: "run.done",
      actor: "necromancer",
      data: { outcome: "error" },
    });
    eventStore.append({
      runId: "s4",
      kind: "run.done",
      actor: "necromancer",
      data: { outcome: "resurrected" },
    });

    assert.equal(store.syncRecordedRunCount({ eventStore }).completedRecordedRuns, 4);
    store.close();
    eventStore.close();
  });

  // --- Item 4: directory loader completeness ---------------------------------

  it("skips a run lacking run.done when loading from --runs-dir (item 4)", () => {
    const root = makeTmpDir("gg-calib-incomplete-");
    writeRunDir(root, runA);
    writeRunDir(root, runB);
    writeRunDir(root, runC);
    // Sorts before the completed runs, so a broken filter would wrongly take the first slot.
    writeRunDir(
      root,
      mkRun("0-calib-run-incomplete", [
        { seq: 1, ts: 100, kind: "run.started" },
        { seq: 2, ts: 200, kind: "skeleton.log", skeletonId: "sk-x" },
      ])
    );

    const loaded = loadRecordedRunsFromDir(root, 4);
    assert.ok(!loaded.some((r) => r.runId === "0-calib-run-incomplete"));
    assert.deepEqual(
      loaded.map((r) => r.runId),
      ["calib-run-a", "calib-run-b", "calib-run-c"]
    );

    const result = runCalibration({ runsDir: root, limit: 3 });
    assert.ok(!result.runIds.includes("0-calib-run-incomplete"));
  });

  // --- Item 5: refs normalization --------------------------------------------

  it("normalizes non-string refs to strings and never lets data.refs win (item 5)", () => {
    const root = makeTmpDir("gg-calib-refs-");
    const runId = "calib-run-refs";
    const dir = path.join(root, runId);
    fs.mkdirSync(dir, { recursive: true });
    const events = [
      {
        runId,
        seq: 1,
        ts: 1,
        kind: "run.phase",
        actor: "necromancer",
        data: { refs: [1, null, "ev:9"], from: "queued", to: "exhume" },
      },
      {
        runId,
        seq: 2,
        ts: 2,
        kind: "run.done",
        actor: "necromancer",
        data: { refs: [], outcome: "resurrected" },
      },
    ];
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      `${events.map((ev) => JSON.stringify(ev)).join("\n")}\n`,
      "utf8"
    );

    const loaded = loadRecordedRunsFromDir(root, 1);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].events[0].data.refs, ["1", "null", "ev:9"]);
    // The rest of `data` is preserved; `refs` sits *after* the spread so it is always normalized.
    assert.equal(loaded[0].events[0].data.to, "exhume");
  });

  // --- Item 6: approval wait exclusion ---------------------------------------

  it("subtracts approval.requested -> approval.resolved waits exactly once (item 6)", () => {
    const detail = analyzeRecordedRunsForCalibration([runA]).runWallClockDetails[0];
    const approval = detail.pauseIntervals.filter((p) => p.source === "approval_wait");
    assert.equal(approval.length, 1);
    assert.equal(approval[0].durationMs, 300_000);
    assert.equal(approval[0].startCitation, "ev:9");
    assert.equal(approval[0].endCitation, "ev:10");
    // 90_000 merged clock/pact + 300_000 disjoint approval -> 390_000, never double-counted.
    assert.equal(detail.pausedMs, 390_000);

    // An approval that overlaps a run.clock pause is merged once, not summed.
    const overlapping = mkRun("calib-run-approval-overlap", [
      { seq: 1, ts: 0, kind: "run.phase", data: { from: "queued", to: "exhume" } },
      { seq: 2, ts: 100, kind: "run.clock", data: { action: "pause" } },
      { seq: 3, ts: 200, kind: "approval.requested", data: { approvalId: "a1" } },
      { seq: 4, ts: 500, kind: "approval.resolved", data: { approvalId: "a1" } },
      { seq: 5, ts: 600, kind: "run.clock", data: { action: "resume" } },
      { seq: 6, ts: 1000, kind: "run.done", data: { outcome: "resurrected" } },
    ]);
    const merged = analyzeRecordedRunsForCalibration([overlapping]).runWallClockDetails[0];
    assert.equal(merged.totalMs, 1000);
    // run.clock 100..600 and approval 200..500 overlap -> one merged 500 ms span, not 800 ms.
    assert.equal(merged.pausedMs, 500);
    assert.equal(merged.activeMs, 500);
  });

  // --- Item 7: silence excludes in-flight spans ------------------------------

  it("excludes an in-flight command.started -> command.result from silence (item 7)", () => {
    const inflight = mkRun("calib-run-inflight", [
      { seq: 1, ts: 0, kind: "run.phase", data: { from: "queued", to: "exhume" } },
      { seq: 2, ts: 10_000, kind: "command.started", actor: "soulstitcher" },
      { seq: 3, ts: 510_000, kind: "command.result", actor: "soulstitcher" },
      { seq: 4, ts: 520_000, kind: "run.done", data: { outcome: "resurrected" } },
    ]);
    const metric = analyzeRecordedRunsForCalibration([inflight]).silenceDurationsMs;
    assert.equal(metric.status, "available");
    // Naively the 500_000 command span looks like a gap; it is in-flight work, so silence is 0.
    assert.equal(metric.max, 0);
    assert.deepEqual(metric.samples, [0]);
  });

  // --- Item 8: run 4+ re-arms recalibration ----------------------------------

  it("re-arms recalibrationRequired when a fourth completed run concludes (item 8)", () => {
    const root = makeTmpDir("gg-calib-run4-");
    writeRunDir(root, runA);
    writeRunDir(root, runB);
    writeRunDir(root, runC);
    const settingsStore = new SettingsStore();

    const first = runCalibration({
      runsDir: root,
      settingsStore,
      apply: true,
      actor: "owner",
      ts: 1000,
    });
    assert.equal(first.recalibrationRequired, false);
    assert.deepEqual(
      [...settingsStore.getCalibrationState().lastCalibratedRunIds].sort(),
      ["calib-run-a", "calib-run-b", "calib-run-c"]
    );

    // A fourth completed run concludes after the calibration.
    writeRunDir(root, runD);
    const second = runCalibration({ runsDir: root, settingsStore, limit: 3 });
    // Only the first three runs feed the distributions...
    assert.deepEqual(second.runIds, ["calib-run-a", "calib-run-b", "calib-run-c"]);
    // ...but run 4 still re-arms recalibration.
    assert.equal(second.recalibrationRequired, true);
    assert.equal(settingsStore.getCalibrationState().completedRecordedRuns, 4);

    settingsStore.close();
  });

  // --- Item 9: CLI flag validation -------------------------------------------

  it("rejects value flags whose value is missing or another flag (item 9)", () => {
    assert.throws(() => parseCalibrationArgs(["--db", "--json"]), /--db requires a path argument/);
    assert.throws(() => parseCalibrationArgs(["--db"]), /--db requires a path argument/);
    assert.throws(
      () => parseCalibrationArgs(["--settings-db", "--json"]),
      /--settings-db requires a path argument/
    );
    assert.throws(
      () => parseCalibrationArgs(["--runs-dir", "--json"]),
      /--runs-dir requires a path argument/
    );
    assert.throws(
      () => parseCalibrationArgs(["--out", "--json"]),
      /--out requires a path argument/
    );
    assert.throws(
      () => parseCalibrationArgs(["--actor", "--json"]),
      /--actor requires a value argument/
    );

    // A real value is still accepted and the following flag survives.
    const ok = parseCalibrationArgs(["--db", "/tmp/events.db", "--json"]);
    assert.equal(ok.db, "/tmp/events.db");
    assert.equal(ok.json, true);
  });
});




