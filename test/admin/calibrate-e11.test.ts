/**
 * Task 17.3 — unit and integration tests for the E11 SettingsStore and calibration script.
 *
 * Covers Requirements 30.1, 30.2, 30.3, 30.18 and 30.20.
 */
import assert from "node:assert/strict";
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
  assertRequiredSettingsConfigured,
  getDefaultSettingsStore,
  resetDefaultSettingsStore,
} from "../../lib/admin/settings-store";
import { EventStore, type EventEnvelope } from "../../lib/events/event-store";
import { RunStore } from "../../lib/runs/run-store";
import {
  analyzeRecordedRunsForCalibration,
  formatCalibrationMarkdown,
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
    // The naive sum of the two intervals is 120_000, but they overlap and must be merged to
    // 90_000 (1_010_000..1_100_000).
    assert.equal(detailA.pausedMs, 90_000);
    assert.notEqual(detailA.pausedMs, 120_000);
    assert.equal(detailA.activeMs, 810_000);
    assert.equal(detailA.pauseIntervals.length, 2);
    assert.deepEqual(
      detailA.pauseIntervals.map((p) => p.source).sort(),
      ["pact_review", "run.clock"]
    );
    assert.ok(detailA.pauseIntervals.every((p) => p.startCitation.startsWith("ev:")));

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
    assert.deepEqual([...metric.samples].sort((a, b) => a - b), [470_000, 600_000, 810_000]);
    assert.equal(metric.max, 810_000);
  });

  it("measures approval request -> resolve wait times", () => {
    const metric = analysis.approvalWaitTimesMs;
    assert.equal(metric.status, "available");
    assert.deepEqual(metric.samples, [300_000]);
    assert.ok(metric.citations.includes("ev:9..ev:10"));
  });

  it("measures the maximum skeleton silence gap per run", () => {
    const metric = analysis.silenceDurationsMs;
    assert.equal(metric.status, "available");
    assert.deepEqual([...metric.samples].sort((a, b) => a - b), [100_000, 200_000, 488_000]);
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
});

