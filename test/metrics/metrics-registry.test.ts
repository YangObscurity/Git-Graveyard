import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  METRIC_REGISTRY,
  METRIC_IDS,
  getMetric,
  type MetricId,
} from "../../lib/metrics/registry";
import {
  formatM1,
  formatM2,
  formatM3,
  formatM4,
  formatM5,
  formatM6,
  formatM7,
  formatM8,
  formatM9,
  formatM10,
  formatM11,
  formatM12,
  formatM13,
  formatM14,
  formatM15,
  formatM16,
  formatM17,
  formatM18,
  formatM19,
  formatM20,
  formatM21,
  formatM22,
  formatM23,
  formatM24,
  formatM25,
  formatM26,
  formatM27,
  formatM28,
  formatM29,
  formatM30,
  formatM31,
  formatMetric,
  formatDuration,
  firstLine,
  commandStatus,
  NOT_AVAILABLE,
  NOT_REPORTED,
  COUNTS_NOT_AVAILABLE,
  NOT_RUN,
  NO_ESTIMATE_YET,
  type MetricValue,
} from "../../lib/metrics/formatters";

const ALL_IDS: MetricId[] = [
  "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10",
  "M11", "M12", "M13", "M14", "M15", "M16", "M17", "M18", "M19", "M20",
  "M21", "M22", "M23", "M24", "M25", "M26", "M27", "M28", "M29", "M30",
  "M31",
];

function assertFallback(value: MetricValue, expectedText: string) {
  assert.equal(value.available, false, `expected fallback, got ${value.text}`);
  assert.equal(value.text, expectedText);
  assert.ok(value.reason && value.reason.length > 0, "fallback must carry a reason");
  assert.deepEqual(value.numbers, []);
}

describe("Metric Registry: M1–M31 rows (R4-13)", () => {
  it("defines exactly the 31 rows M1 through M31 in order", () => {
    assert.equal(METRIC_REGISTRY.length, 31);
    assert.deepEqual(METRIC_IDS, ALL_IDS);
  });

  it("gives every row a non-empty shown label and source", () => {
    for (const row of METRIC_REGISTRY) {
      assert.ok(row.shown.length > 0, `${row.id} shown`);
      assert.ok(row.source.length > 0, `${row.id} source`);
    }
  });

  it("looks up each row by id", () => {
    for (const id of ALL_IDS) {
      assert.equal(getMetric(id).id, id);
    }
  });

  it("throws on an unknown metric id", () => {
    assert.throws(() => getMetric("M99" as MetricId), RangeError);
  });
});

describe("formatDuration and firstLine helpers", () => {
  it("formats sub-second, seconds, minutes and hours from ms", () => {
    assert.equal(formatDuration(500), "500ms");
    assert.equal(formatDuration(1500), "1.5s");
    assert.equal(formatDuration(65_000), "1m 5s");
    assert.equal(formatDuration(3_900_000), "1h 5m");
  });

  it("caps Last Words at 120 characters on the first line", () => {
    const long = "x".repeat(200);
    assert.equal(firstLine(long).length, 120);
    assert.equal(firstLine("first line\nsecond line"), "first line");
  });
});

describe("M1–M7 formatters", () => {
  it("M1 renders stars/forks/archived/branch with asOf", () => {
    const v = formatM1({
      stars: 12,
      forks: 3,
      archived: true,
      defaultBranch: "main",
      asOf: "2026-11-07",
    });
    assert.equal(v.available, true);
    assert.match(v.text, /12 stars, 3 forks, archived, default branch main \(as of 2026-11-07\)/);
    assert.deepEqual(v.numbers, [12, 3]);
  });

  it("M1 is not available without asOf or counts", () => {
    assertFallback(formatM1({ stars: 1, forks: 1 }), NOT_AVAILABLE);
    assertFallback(formatM1({ asOf: "2026-11-07" }), NOT_AVAILABLE);
  });

  it("M2 renders created and last commit dates", () => {
    const v = formatM2({ createdAt: "2010-01-01", lastCommitAt: "2018-05-05" });
    assert.equal(v.text, "Created 2010-01-01; last commit 2018-05-05");
    assertFallback(formatM2({ createdAt: "2010-01-01" }), NOT_AVAILABLE);
  });

  it("M3 computes years dead and lifespan, unknown for negative lifespan", () => {
    const v = formatM3({
      createdAt: "2010-01-01T00:00:00Z",
      lastCommitAt: "2018-01-01T00:00:00Z",
      asOf: "2026-01-01T00:00:00Z",
    });
    assert.equal(v.available, true);
    assert.match(v.text, /Lifespan 8 years; years dead 8 \(as of 2026-01-01T00:00:00Z\)/);
    const neg = formatM3({
      createdAt: "2020-01-01T00:00:00Z",
      lastCommitAt: "2018-01-01T00:00:00Z",
      asOf: "2026-01-01T00:00:00Z",
    });
    assert.match(neg.text, /Lifespan unknown/);
    assertFallback(formatM3({ createdAt: "2010-01-01T00:00:00Z" }), NOT_AVAILABLE);
  });

  it("M4 renders still breathing or dead with reasons", () => {
    assert.equal(formatM4({ status: "alive" }).text, "Still breathing");
    const dead = formatM4({ status: "dead", deadReasons: ["archived", "dormant_24m"] });
    assert.equal(dead.text, "Dead: archived, dormant_24m");
    assertFallback(formatM4({}), NOT_AVAILABLE);
  });

  it("M5 renders the first line capped at 120 chars", () => {
    const v = formatM5({ lastCommitMessage: "Fix the thing\n\nbody" });
    assert.equal(v.text, "Fix the thing");
    assert.ok(formatM5({ lastCommitMessage: "y".repeat(300) }).text.length <= 120);
    assertFallback(formatM5({}), NOT_AVAILABLE);
    assertFallback(formatM5({ lastCommitMessage: "" }), NOT_AVAILABLE);
  });

  it("M6 renders per-rule base/final counts and a clean message", () => {
    const v = formatM6({ base: { M1: 2, M2: 1 }, final: { M1: 0, M2: 1 } });
    assert.match(v.text, /M1: base 2, final 0/);
    assert.match(v.text, /M2: base 1, final 1/);
    assert.equal(formatM6({ base: {}, final: {} }).text, "No Grimoire signals on base or final tree");
    assertFallback(formatM6({ base: { M1: 1 } }), NOT_AVAILABLE);
  });

  it("M7 renders file:line with optional rule prefix", () => {
    const v = formatM7({ ruleId: "M1", file: "lib/index.js", line: 42 });
    assert.equal(v.text, "M1 lib/index.js:42");
    assertFallback(formatM7({ file: "lib/index.js" }), NOT_AVAILABLE);
  });
});

describe("M8–M10 command step formatters", () => {
  it("derives status strictly from exitCode/timedOut/oomKilled", () => {
    assert.equal(commandStatus({ exitCode: 0 }), "passed");
    assert.equal(commandStatus({ exitCode: 3 }), "failed (exit 3)");
    assert.equal(commandStatus({ timedOut: true }), "timed out");
    assert.equal(commandStatus({ oomKilled: true }), "killed (out of memory)");
  });

  it("M8/M9/M10 render status, exit code and duration", () => {
    const v = formatM8({ step: "install", exitCode: 0, durationMs: 12_910 });
    assert.match(v.text, /Install: passed, exit 0, 12.9s/);
    assert.equal(formatM9({ exitCode: 1 }).text, "Build: failed (exit 1), exit 1");
    assert.match(formatM10({ exitCode: 0, durationMs: 2000 }).text, /Test: passed, exit 0, 2s/);
  });

  it("M8–M10 render not run when an earlier step failed or no script", () => {
    assertFallback(formatM8({ notRun: true, notRunReason: "install failed" }), NOT_RUN);
    assertFallback(formatM9({ notRun: true }), NOT_RUN);
    assertFallback(formatM10({ notRun: true }), NOT_RUN);
  });

  it("M8–M10 are not available without any recorded result", () => {
    assertFallback(formatM8({}), NOT_AVAILABLE);
    assertFallback(formatM9(null), NOT_AVAILABLE);
    assertFallback(formatM10(undefined), NOT_AVAILABLE);
  });
});

describe("M11–M14 formatters", () => {
  it("M11 renders parsed counts or Counts not available", () => {
    const v = formatM11({ passed: 10, failed: 1, skipped: 2, total: 13 });
    assert.match(v.text, /10 passed, 1 failed, 2 skipped, 13 total/);
    assertFallback(formatM11({}), COUNTS_NOT_AVAILABLE);
    assertFallback(formatM11(null), COUNTS_NOT_AVAILABLE);
  });

  it("M12 renders the logRef verbatim or not available", () => {
    assert.equal(formatM12({ logRef: "exhume-run-install-123" }).text, "exhume-run-install-123");
    assertFallback(formatM12({}), NOT_AVAILABLE);
  });

  it("M13 renders No tests found metadata", () => {
    const v = formatM13({ detected: true, language: "python", reason: "pytest exit 5" });
    assert.match(v.text, /No tests found \(python\) — pytest exit 5/);
    assertFallback(formatM13({ detected: false }), NOT_AVAILABLE);
  });

  it("M14 is not available until S3 records the format, then counts", () => {
    assertFallback(formatM14({ count: 5 }), NOT_AVAILABLE);
    assert.match(formatM14({ formatRecorded: true, count: 5 }).text, /5 deprecation warnings/);
    assertFallback(formatM14({ formatRecorded: true }), NOT_AVAILABLE);
  });
});

describe("M15–M23 formatters", () => {
  it("M15 renders recorded runtime versions", () => {
    assert.equal(formatM15({ node: "v22.23.5", npm: "10.9.9" }).text, "node v22.23.5, npm 10.9.9");
    assertFallback(formatM15({}), NOT_AVAILABLE);
  });

  it("M16 renders lock file presence at a sha", () => {
    const v = formatM16({ present: true, name: "package-lock.json", sha: "abc123" });
    assert.equal(v.text, "package-lock.json present at abc123");
    assertFallback(formatM16({}), NOT_AVAILABLE);
  });

  it("M17 renders numstat diff size", () => {
    const v = formatM17({ filesChanged: 2, insertions: 10, deletions: 3 });
    assert.equal(v.text, "2 files changed, +10, -3");
    assert.deepEqual(v.numbers, [2, 10, 3]);
    assertFallback(formatM17({}), NOT_AVAILABLE);
  });

  it("M18 renders latest task states per task", () => {
    const v = formatM18([
      { taskId: "T1", state: "merged" },
      { taskId: "T1", state: "merged" },
      { taskId: "T2", state: "running" },
    ]);
    assert.match(v.text, /1 merged, 1 running/);
    assertFallback(formatM18([]), NOT_AVAILABLE);
  });

  it("M19 renders verdict counts", () => {
    const v = formatM19({ approve: 3, reject: 1 });
    assert.equal(v.text, "3 approved, 1 rejected");
    assert.deepEqual(v.numbers, [3, 1]);
    assertFallback(formatM19({}), NOT_AVAILABLE);
  });

  it("M20 renders elapsed per skeleton against the clock now", () => {
    const v = formatM20([{ skeletonId: "s1", raisedAt: 1000 }], 4000);
    assert.equal(v.text, "s1: 3s");
    assertFallback(formatM20([], 4000), NOT_AVAILABLE);
    assertFallback(formatM20([{ skeletonId: "s1", raisedAt: 1000 }], Number.NaN), NOT_AVAILABLE);
  });

  it("M21 renders run elapsed and paused time", () => {
    const v = formatM21({ elapsedMs: 149_382, pausedMs: 5000 });
    assert.match(v.text, /elapsed 2m 29s/);
    assert.match(v.text, /paused 5s/);
    assertFallback(formatM21({}), NOT_AVAILABLE);
  });

  it("M22 is not reported unless P5 reported credits, never estimated", () => {
    assertFallback(formatM22({ perRun: 5 }), NOT_REPORTED);
    const v = formatM22({ reported: true, perRun: 5, perSkeleton: { s1: 2 } });
    assert.match(v.text, /5 credits this run/);
    assert.match(v.text, /s1: 2/);
    assertFallback(formatM22({ reported: true }), NOT_REPORTED);
  });

  it("M23 renders tool-call count", () => {
    assert.equal(formatM23({ count: 7 }).text, "7 tool calls");
    assert.deepEqual(formatM23({ count: 7 }).numbers, [7]);
    assertFallback(formatM23({}), NOT_AVAILABLE);
  });
});

describe("M24–M31 formatters", () => {
  it("M24 renders the budget meter on the capped dimension", () => {
    const v = formatM24({ dimension: "creditsPerRun", percent: 80 });
    assert.equal(v.text, "creditsPerRun budget 80% used");
    assert.deepEqual(v.numbers, [80]);
    assertFallback(formatM24({ dimension: "creditsPerRun" }), NOT_AVAILABLE);
  });

  it("M25 gives No estimate yet below 3 runs and a range at 3+", () => {
    assertFallback(formatM25({ wallTimesMs: [1000, 2000] }), NO_ESTIMATE_YET);
    assertFallback(formatM25({}), NO_ESTIMATE_YET);
    const v = formatM25({ wallTimesMs: [60_000, 120_000, 200_000] });
    assert.match(v.text, /Runs like this took between 1m 0s and 3m 20s/);
  });

  it("M26 renders queue position with no time estimate", () => {
    const v = formatM26({ position: 4 });
    assert.equal(v.text, "Queue position 4");
    assert.ok(!/estimate|minute|second|eta/i.test(v.text));
    assertFallback(formatM26({}), NOT_AVAILABLE);
  });

  it("M27 renders tests added by skeletons from files or a parsed count", () => {
    const fromCount = formatM27({ count: 2 });
    assert.match(fromCount.text, /2 test files added/);
    const fromFiles = formatM27({ files: ["test/a.test.ts", "test/b.test.ts"] });
    assert.match(fromFiles.text, /2 test files added/);
    assertFallback(formatM27({}), NOT_AVAILABLE);
  });

  it("M28 renders the report check result", () => {
    assert.equal(formatM28({ checked: true, passed: true }).text, "Report check passed");
    assert.match(formatM28({ checked: true, passed: false, note: "missing" }).text, /Report check failed — missing/);
    assert.equal(formatM28({ checked: false }).text, "Report not checked");
    assertFallback(formatM28({}), NOT_AVAILABLE);
  });

  it("M29 renders artifact size and hash", () => {
    const v = formatM29({ kind: "patch", byteSize: 318962, sha256: "b847" });
    assert.match(v.text, /patch, 318962 bytes, sha256 b847/);
    assert.deepEqual(v.numbers, [318962]);
    assertFallback(formatM29({ kind: "patch" }), NOT_AVAILABLE);
  });

  it("M30 renders Kiro CLI version, agents, models and sessions", () => {
    const v = formatM30({
      kiroCliVersion: "1.2.3",
      agents: ["planner"],
      verifiedModels: ["claude-opus-5.5"],
      sessionIds: ["s-1"],
    });
    assert.match(v.text, /Kiro CLI 1.2.3/);
    assert.match(v.text, /agents: planner/);
    assert.match(v.text, /verified models: claude-opus-5.5/);
    assert.match(v.text, /sessions: s-1/);
    assertFallback(formatM30({}), NOT_AVAILABLE);
  });

  it("M31 renders history counts", () => {
    const v = formatM31({ total: 12, byOutcome: { resurrected: 8, partial: 4 } });
    assert.match(v.text, /12 runs/);
    assert.match(v.text, /resurrected: 8/);
    assertFallback(formatM31({}), NOT_AVAILABLE);
  });
});

describe("formatMetric dispatcher", () => {
  it("routes each id to its formatter", () => {
    assert.equal(formatMetric("M23", { count: 7 }).text, "7 tool calls");
    assert.equal(formatMetric("M26", { position: 2 }).text, "Queue position 2");
  });

  it("M20 dispatcher reads skeletons and now from the source", () => {
    const v = formatMetric("M20", { skeletons: [{ skeletonId: "s1", raisedAt: 1000 }], now: 3000 });
    assert.equal(v.text, "s1: 2s");
  });

  it("M20 dispatcher returns not available when clock now is omitted", () => {
    const v = formatMetric("M20", { skeletons: [{ skeletonId: "s1", raisedAt: 1000 }] });
    assertFallback(v, NOT_AVAILABLE);
  });

  it("every id returns a MetricValue with a numbers array", () => {
    for (const id of ALL_IDS) {
      const v = formatMetric(id, {});
      assert.equal(typeof v.available, "boolean", id);
      assert.ok(Array.isArray(v.numbers), id);
    }
  });
});