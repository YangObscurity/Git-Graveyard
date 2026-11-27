/**
 * Property 14: Metric provenance (P14).
 *
 * Every number the UI renders maps to a row of the R4-13 Metric Registry and
 * equals the value computed from that row's source. A number whose source is
 * missing renders "not available" / "not reported" / "Counts not available" /
 * "not run" / "No estimate yet", never an estimate. No score, health percentage,
 * confidence percentage or queue ETA is ever produced.
 *
 * Validates: Requirements 30.10, 30.11, 40.1, 40.2.
 */
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { METRIC_IDS } from "../../lib/metrics/registry";
import {
  formatMetric,
  NOT_AVAILABLE,
  NOT_REPORTED,
  COUNTS_NOT_AVAILABLE,
  NOT_RUN,
  NO_ESTIMATE_YET,
  type MetricValue,
} from "../../lib/metrics/formatters";

const FALLBACKS = new Set<string>([
  NOT_AVAILABLE,
  NOT_REPORTED,
  COUNTS_NOT_AVAILABLE,
  NOT_RUN,
  NO_ESTIMATE_YET,
]);

/** Forbidden claim / fabrication shapes that must never appear in any value. */
const FORBIDDEN_IN_VALUE = [
  /\b\d+%\s*faster\b/i,
  /\bhours?\s+saved\b/i,
  /\bproduction[\s-]+ready\b/i,
  /\bsafe\b/i,
  /\b(?:skeleton|model|agent|ai)\s+understood\b/i,
  /\bkiro\s+product\b/i,
  /\bconfidence\b/i,
  /\bhealth score\b/i,
  /\beta\b/i,
  /\bestimate\b/i,
];

// ---- arbitraries: arbitrary runs, missing fields, command results ----

const maybe = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.oneof(fc.constant(undefined), arb);

const intArb = fc.integer({ min: 0, max: 1_000_000 });
const finiteNumberArb = fc.oneof(intArb, fc.integer({ min: -1000, max: -1 }));
// Vowel-free alphabet: generated free text cannot itself form any forbidden word
// ("safe", "eta", "confidence", ...), so a forbidden match always means the
// formatter fabricated it rather than echoing the input.
const TEXT_CHARS = "bcdfghjklmnpqrstvwxz0123456789";
const textArb = fc
  .array(fc.constantFrom(...TEXT_CHARS.split("")), { maxLength: 20 })
  .map((chars) => chars.join(""));
const isoArb = fc.constantFrom(
  "2010-01-01T00:00:00Z",
  "2018-06-06T00:00:00Z",
  "2026-11-07T00:00:00Z"
);

const commandResultArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    step: maybe(fc.constantFrom("install", "build", "test")),
    exitCode: maybe(fc.oneof(fc.constant(null), finiteNumberArb)),
    timedOut: maybe(fc.boolean()),
    oomKilled: maybe(fc.boolean()),
    durationMs: maybe(intArb),
    notRun: maybe(fc.boolean()),
  },
  {}
);

const repoMetaArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    stars: maybe(intArb),
    forks: maybe(intArb),
    archived: maybe(fc.boolean()),
    defaultBranch: maybe(textArb),
    asOf: maybe(isoArb),
  },
  {}
);

function assertNoFabrication(value: MetricValue, id: string): void {
  if (value.available) {
    for (const pattern of FORBIDDEN_IN_VALUE) {
      assert.ok(
        !pattern.test(value.text),
        `${id} rendered forbidden text "${value.text}" matching ${pattern}`
      );
    }
    assert.ok(value.text.length > 0, `${id} available value is empty`);
  } else {
    assert.ok(FALLBACKS.has(value.text), `${id} missing source rendered "${value.text}"`);
    assert.equal(value.numbers.length, 0, `${id} fallback carried numbers`);
    assert.ok(value.reason && value.reason.length > 0, `${id} fallback missing reason`);
  }
}

const stateArb = fc.constantFrom("pending", "ready", "running", "merged", "failed");
const ruleArb = fc.constantFrom("M1", "M2", "M3");
const dictArb = fc.dictionary(ruleArb, fc.integer({ min: 0, max: 9 }));

/**
 * One arbitrary "run" of sources, keyed by metric id. Each metric's source is an
 * arbitrary record with deleted keys, so missing-field cases are generated.
 */
const runArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    M1: repoMetaArb,
    M2: fc.record({ createdAt: maybe(isoArb), lastCommitAt: maybe(isoArb) }),
    M3: fc.record(
      { createdAt: maybe(isoArb), lastCommitAt: maybe(isoArb), asOf: maybe(isoArb) },
      {}
    ),
    M4: fc.record(
      {
        status: maybe(fc.constantFrom("dead" as const, "alive" as const)),
        deadReasons: maybe(fc.array(fc.constantFrom("archived", "dormant_24m"), { maxLength: 3 })),
      },
      {}
    ),
    M5: fc.record({ lastCommitMessage: maybe(textArb) }),
    M6: fc.record({ base: maybe(dictArb), final: maybe(dictArb) }),
    M7: fc.record(
      { ruleId: maybe(textArb), file: maybe(textArb), line: maybe(intArb) },
      {}
    ),
    M8: commandResultArb,
    M9: commandResultArb,
    M10: commandResultArb,
    M11: fc.record(
      { passed: maybe(intArb), failed: maybe(intArb), skipped: maybe(intArb), total: maybe(intArb) },
      {}
    ),
    M12: fc.record({ logRef: maybe(textArb) }),
    M13: fc.record(
      { detected: maybe(fc.boolean()), language: maybe(textArb), reason: maybe(textArb) },
      {}
    ),
    M14: fc.record(
      { formatRecorded: maybe(fc.boolean()), count: maybe(intArb) },
      {}
    ),
    M15: fc.record(
      { node: maybe(textArb), npm: maybe(textArb), python: maybe(textArb) },
      {}
    ),
    M16: fc.record(
      { present: maybe(fc.boolean()), sha: maybe(textArb), name: maybe(textArb) },
      {}
    ),
    M17: fc.record(
      { filesChanged: maybe(intArb), insertions: maybe(intArb), deletions: maybe(intArb) },
      {}
    ),
    M18: maybe(fc.array(fc.record({ taskId: textArb, state: stateArb }), { maxLength: 5 })),
    M19: fc.record({ approve: maybe(intArb), reject: maybe(intArb) }),
    M20: fc.record(
      {
        skeletons: maybe(
          fc.array(fc.record({ skeletonId: textArb, raisedAt: intArb }), { maxLength: 4 })
        ),
        now: maybe(intArb),
      },
      {}
    ),
    M21: fc.record({ elapsedMs: maybe(intArb), pausedMs: maybe(intArb) }),
    M22: fc.record(
      {
        reported: maybe(fc.boolean()),
        perRun: maybe(intArb),
        perSkeleton: maybe(fc.dictionary(fc.constantFrom("s1", "s2"), intArb)),
      },
      {}
    ),
    M23: fc.record({ count: maybe(intArb) }),
    M24: fc.record({ dimension: maybe(textArb), percent: maybe(intArb) }),
    M25: fc.record(
      { wallTimesMs: maybe(fc.array(intArb, { maxLength: 6 })) },
      {}
    ),
    M26: fc.record({ position: maybe(intArb) }),
    M27: fc.record(
      { files: maybe(fc.array(textArb, { maxLength: 4 })), count: maybe(intArb) },
      {}
    ),
    M28: fc.record(
      { checked: maybe(fc.boolean()), passed: maybe(fc.boolean()), note: maybe(textArb) },
      {}
    ),
    M29: fc.record(
      { kind: maybe(textArb), byteSize: maybe(intArb), sha256: maybe(textArb) },
      {}
    ),
    M30: fc.record(
      {
        kiroCliVersion: maybe(textArb),
        agents: maybe(fc.array(textArb, { maxLength: 3 })),
        verifiedModels: maybe(fc.array(textArb, { maxLength: 3 })),
        sessionIds: maybe(fc.array(textArb, { maxLength: 3 })),
      },
      {}
    ),
    M31: fc.record(
      {
        total: maybe(intArb),
        byOutcome: maybe(fc.dictionary(fc.constantFrom("resurrected", "partial"), intArb)),
      },
      {}
    ),
  },
  {}
);

describe("Property 14: Metric provenance (P14)", () => {
  it("every displayed value maps to a source or a fixed fallback, with no fabrication", () => {
    fc.assert(
      fc.property(runArb, (run) => {
        for (const id of METRIC_IDS) {
          assertNoFabrication(formatMetric(id, run[id]), id);
        }
      }),
      { numRuns: 500 }
    );
  });

  it("M25 shows No estimate yet below 3 runs and a range at 3+", () => {
    fc.assert(
      fc.property(fc.array(finiteNumberArb, { maxLength: 8 }), (wallTimes) => {
        const value = formatMetric("M25", { wallTimesMs: wallTimes });
        const comparable = wallTimes.filter((t) => Number.isFinite(t) && t >= 0);
        if (comparable.length < 3) {
          assert.equal(value.available, false);
          assert.equal(value.text, NO_ESTIMATE_YET);
        } else {
          assert.equal(value.available, true);
          assert.match(value.text, /^Runs like this took between .+ and .+$/);
          assert.deepEqual(value.numbers, [Math.min(...comparable), Math.max(...comparable)]);
        }
      }),
      { numRuns: 500 }
    );
  });

  it("M22 never reports or estimates credits unless P5 reported them", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(finiteNumberArb, { nil: undefined }),
        (reported, perRun) => {
          const value = formatMetric("M22", { reported, perRun });
          if (reported !== true || perRun === undefined) {
            assert.equal(value.available, false);
            assert.equal(value.text, NOT_REPORTED);
          } else {
            assert.equal(value.available, true);
            assert.deepEqual(value.numbers, [perRun]);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("M8–M10 derive status only from exitCode/timedOut/oomKilled, else not run", () => {
    fc.assert(
      fc.property(commandResultArb, (source) => {
        for (const id of ["M8", "M9", "M10"] as const) {
          const value = formatMetric(id, source);
          if (source.notRun === true) {
            assert.equal(value.text, NOT_RUN);
          } else if (
            source.exitCode === undefined &&
            source.timedOut !== true &&
            source.oomKilled !== true
          ) {
            assert.equal(value.text, NOT_AVAILABLE);
          } else {
            assert.equal(value.available, true, `${id} ${JSON.stringify(source)}`);
            if (typeof source.exitCode === "number") {
              assert.ok(value.numbers.includes(source.exitCode));
            }
          }
        }
      }),
      { numRuns: 500 }
    );
  });

  it("missing sources always format as one of the fixed fallback strings", () => {
    fc.assert(
      fc.property(fc.constantFrom(...METRIC_IDS), (id) => {
        const value = formatMetric(id, undefined);
        if (id === "M11") {
          assert.equal(value.text, COUNTS_NOT_AVAILABLE);
        } else if (id === "M25") {
          assert.equal(value.text, NO_ESTIMATE_YET);
        } else {
          assert.ok(FALLBACKS.has(value.text), `${id} rendered "${value.text}"`);
          assert.equal(value.available, false);
        }
      }),
      { numRuns: 200 }
    );
// ---- independent expectations for numeric metrics (P14) ----

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asRecord(value: unknown): Record<string, unknown> {
  return isRecordValue(value) ? value : {};
}
function asNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function asTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
/**
 * Independent duration formatter for the M20/M21 property checks. Computes
 * seconds/minutes/hours directly from the millisecond value instead of importing
 * the production formatter under test, so the assertions stay honest.
 */
function expectedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return NOT_AVAILABLE;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${round1(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}
function assertFallbackValue(value: MetricValue, expected: string, id: string): void {
  assert.equal(value.available, false, `${id} expected a fallback, got ${value.text}`);
  assert.equal(value.text, expected, `${id} fallback text`);
  assert.ok(value.reason && value.reason.length > 0, `${id} fallback missing reason`);
  assert.deepEqual(value.numbers, [], `${id} fallback carried numbers`);
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

it("numeric metrics equal independently computed values and exact fallbacks", () => {
  fc.assert(
    fc.property(runArb, (run) => {
      // M1: stars/forks/archived/branch
      {
        const src = asRecord(run.M1);
        const v = formatMetric("M1", src);
        const stars = asNum(src.stars);
        const forks = asNum(src.forks);
        const asOf = asStr(src.asOf);
        if (stars === undefined || forks === undefined || asOf === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M1");
        } else {
          const archived =
            src.archived === true
              ? "archived"
              : src.archived === false
              ? "not archived"
              : "archived status not available";
          const branch = asStr(src.defaultBranch) ?? NOT_AVAILABLE;
          assert.equal(v.available, true, "M1 available");
          assert.equal(
            v.text,
            `${stars} stars, ${forks} forks, ${archived}, default branch ${branch} (as of ${asOf})`
          );
          assert.deepEqual(v.numbers, [stars, forks]);
        }
      }

      // M2: created/last commit dates
      {
        const src = asRecord(run.M2);
        const v = formatMetric("M2", src);
        const createdAt = asStr(src.createdAt);
        const lastCommitAt = asStr(src.lastCommitAt);
        if (createdAt === undefined || lastCommitAt === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M2");
        } else {
          assert.equal(v.text, `Created ${createdAt}; last commit ${lastCommitAt}`);
          assert.deepEqual(v.numbers, []);
        }
      }

      // M3: years dead / lifespan
      {
        const src = asRecord(run.M3);
        const v = formatMetric("M3", src);
        const createdAt = asTime(src.createdAt);
        const lastCommitAt = asTime(src.lastCommitAt);
        const asOf = asTime(src.asOf);
        if (createdAt === undefined || lastCommitAt === undefined || asOf === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M3");
        } else {
          const yearsDead = round1((asOf - lastCommitAt) / MS_PER_DAY / DAYS_PER_YEAR);
          const lifespanMs = lastCommitAt - createdAt;
          const lifespanText =
            lifespanMs < 0
              ? "unknown"
              : `${round1(lifespanMs / MS_PER_DAY / DAYS_PER_YEAR)} years`;
          assert.equal(
            v.text,
            `Lifespan ${lifespanText}; years dead ${yearsDead} (as of ${src.asOf})`
          );
          assert.deepEqual(v.numbers, [yearsDead]);
        }
      }

      // M6: per-rule base/final counts
      {
        const src = asRecord(run.M6);
        const v = formatMetric("M6", src);
        const base = isRecordValue(src.base) ? src.base : undefined;
        const finalTree = isRecordValue(src.final) ? src.final : undefined;
        if (base === undefined || finalTree === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M6");
        } else {
          const rules = Array.from(
            new Set([...Object.keys(base), ...Object.keys(finalTree)])
          ).sort();
          if (rules.length === 0) {
            assert.equal(v.text, "No Grimoire signals on base or final tree");
          } else {
            const parts = rules.map((rule) => {
              const b = asNum(base[rule]) ?? 0;
              const f = asNum(finalTree[rule]) ?? 0;
              return `${rule}: base ${b}, final ${f}`;
            });
            assert.equal(v.text, parts.join("; "));
          }
          assert.deepEqual(v.numbers, []);
        }
      }
      // M11: parsed test counts
      {
        const src = asRecord(run.M11);
        const v = formatMetric("M11", src);
        const passed = asNum(src.passed);
        const failed = asNum(src.failed);
        const skipped = asNum(src.skipped);
        const total = asNum(src.total);
        if (
          passed === undefined &&
          failed === undefined &&
          skipped === undefined &&
          total === undefined
        ) {
          assertFallbackValue(v, COUNTS_NOT_AVAILABLE, "M11");
        } else {
          const parts: string[] = [];
          const numbers: number[] = [];
          if (passed !== undefined) {
            parts.push(`${passed} passed`);
            numbers.push(passed);
          }
          if (failed !== undefined) {
            parts.push(`${failed} failed`);
            numbers.push(failed);
          }
          if (skipped !== undefined) {
            parts.push(`${skipped} skipped`);
            numbers.push(skipped);
          }
          if (total !== undefined) {
            parts.push(`${total} total`);
            numbers.push(total);
          }
          assert.equal(v.text, parts.join(", "));
          assert.deepEqual(v.numbers, numbers);
        }
      }

      // M14: deprecation warnings
      {
        const src = asRecord(run.M14);
        const v = formatMetric("M14", src);
        const count = asNum(src.count);
        if (src.formatRecorded !== true || count === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M14");
        } else {
          assert.equal(v.text, `${count} deprecation warnings`);
          assert.deepEqual(v.numbers, [count]);
        }
      }

      // M17: numstat diff size
      {
        const src = asRecord(run.M17);
        const v = formatMetric("M17", src);
        const files = asNum(src.filesChanged);
        const insertions = asNum(src.insertions);
        const deletions = asNum(src.deletions);
        if (files === undefined && insertions === undefined && deletions === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M17");
        } else {
          const parts: string[] = [];
          const numbers: number[] = [];
          if (files !== undefined) {
            parts.push(`${files} files changed`);
            numbers.push(files);
          }
          if (insertions !== undefined) {
            parts.push(`+${insertions}`);
            numbers.push(insertions);
          }
          if (deletions !== undefined) {
            parts.push(`-${deletions}`);
            numbers.push(deletions);
          }
          assert.equal(v.text, parts.join(", "));
          assert.deepEqual(v.numbers, numbers);
        }
      }

      // M18: latest task states per task
      {
        const raw = run.M18;
        const v = formatMetric("M18", raw);
        if (!Array.isArray(raw) || raw.length === 0) {
          assertFallbackValue(v, NOT_AVAILABLE, "M18");
        } else {
          const latest = new Map<string, string>();
          for (const row of raw) {
            const r = asRecord(row);
            if (typeof r.taskId === "string") {
              latest.set(r.taskId, String(r.state));
            }
          }
          if (latest.size === 0) {
            assertFallbackValue(v, NOT_AVAILABLE, "M18");
          } else {
            const counts = new Map<string, number>();
            for (const state of latest.values()) {
              counts.set(state, (counts.get(state) ?? 0) + 1);
            }
            const parts = Array.from(counts.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([state, count]) => `${count} ${state}`);
            assert.equal(v.text, parts.join(", "));
            assert.deepEqual(v.numbers, []);
          }
        }
      }
      // M19: verdict counts
      {
        const src = asRecord(run.M19);
        const v = formatMetric("M19", src);
        const approve = asNum(src.approve);
        const reject = asNum(src.reject);
        if (approve === undefined && reject === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M19");
        } else {
          const parts: string[] = [];
          const numbers: number[] = [];
          if (approve !== undefined) {
            parts.push(`${approve} approved`);
            numbers.push(approve);
          }
          if (reject !== undefined) {
            parts.push(`${reject} rejected`);
            numbers.push(reject);
          }
          assert.equal(v.text, parts.join(", "));
          assert.deepEqual(v.numbers, numbers);
        }
      }

      // M20: elapsed per skeleton against the clock now
      {
        const src = asRecord(run.M20);
        const v = formatMetric("M20", src);
        const skeletons = src.skeletons;
        const now = asNum(src.now);
        if (!Array.isArray(skeletons) || skeletons.length === 0) {
          assertFallbackValue(v, NOT_AVAILABLE, "M20");
        } else if (now === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M20");
        } else {
          const malformed = skeletons.some((row) => {
            const r = asRecord(row);
            return (
              !isRecordValue(row) ||
              typeof r.skeletonId !== "string" ||
              r.skeletonId.length === 0 ||
              asNum(r.raisedAt) === undefined
            );
          });
          if (malformed) {
            assertFallbackValue(v, NOT_AVAILABLE, "M20");
          } else {
            const parts = skeletons.map((row) => {
              const r = asRecord(row);
              const id = String(r.skeletonId);
              const raisedAt = asNum(r.raisedAt) ?? 0;
              return `${id}: ${expectedDuration(Math.max(0, now - raisedAt))}`;
            });
            assert.equal(v.text, parts.join("; "));
            assert.deepEqual(v.numbers, []);
          }
        }
      }

      // M21: run elapsed and paused clock durations
      {
        const src = asRecord(run.M21);
        const v = formatMetric("M21", src);
        const elapsed = asNum(src.elapsedMs);
        const paused = asNum(src.pausedMs);
        if (elapsed === undefined && paused === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M21");
        } else {
          const parts: string[] = [];
          if (elapsed !== undefined) parts.push(`elapsed ${expectedDuration(elapsed)}`);
          if (paused !== undefined) parts.push(`paused ${expectedDuration(paused)}`);
          assert.equal(v.text, parts.join(", "));
          assert.deepEqual(v.numbers, []);
        }
      }

      // M22: reported credits only
      {
        const src = asRecord(run.M22);
        const v = formatMetric("M22", src);
        if (src.reported !== true) {
          assertFallbackValue(v, NOT_REPORTED, "M22");
        } else {
          const perRun = asNum(src.perRun);
          const perSkeleton = isRecordValue(src.perSkeleton) ? src.perSkeleton : undefined;
          const parts: string[] = [];
          const numbers: number[] = [];
          if (perRun !== undefined) {
            parts.push(`${perRun} credits this run`);
            numbers.push(perRun);
          }
          if (perSkeleton) {
            const entries = Object.entries(perSkeleton)
              .map(([id, value]) => [id, asNum(value)] as const)
              .filter((entry): entry is readonly [string, number] => entry[1] !== undefined);
            for (const [id, value] of entries) {
              parts.push(`${id}: ${value}`);
              numbers.push(value);
            }
          }
          if (parts.length === 0) {
            assertFallbackValue(v, NOT_REPORTED, "M22");
          } else {
            assert.equal(v.text, parts.join("; "));
            assert.deepEqual(v.numbers, numbers);
          }
        }
      }

      // M23: tool-call count
      {
        const src = asRecord(run.M23);
        const v = formatMetric("M23", src);
        const count = asNum(src.count);
        if (count === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M23");
        } else {
          assert.equal(v.text, `${count} tool calls`);
          assert.deepEqual(v.numbers, [count]);
        }
      }
      // M26: queue position
      {
        const src = asRecord(run.M26);
        const v = formatMetric("M26", src);
        const position = asNum(src.position);
        if (position === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M26");
        } else {
          assert.equal(v.text, `Queue position ${position}`);
          assert.deepEqual(v.numbers, [position]);
        }
      }

      // M27: tests added
      {
        const src = asRecord(run.M27);
        const v = formatMetric("M27", src);
        const files = Array.isArray(src.files)
          ? src.files.filter((f): f is string => typeof f === "string")
          : [];
        const count = asNum(src.count);
        if (files.length === 0 && count === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M27");
        } else {
          const parts: string[] = [];
          const numbers: number[] = [];
          if (count !== undefined) {
            parts.push(`${count} test files added`);
            numbers.push(count);
          } else {
            parts.push(`${files.length} test files added`);
            numbers.push(files.length);
          }
          if (files.length > 0) {
            parts.push(`(${files.join(", ")})`);
          }
          assert.equal(v.text, parts.join(" "));
          assert.deepEqual(v.numbers, numbers);
        }
      }

      // M29: artifact size and hash
      {
        const src = asRecord(run.M29);
        const v = formatMetric("M29", src);
        const byteSize = asNum(src.byteSize);
        const sha256 = asStr(src.sha256);
        const kind = asStr(src.kind);
        if (byteSize === undefined && sha256 === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M29");
        } else {
          const parts: string[] = [];
          const numbers: number[] = [];
          if (kind !== undefined) parts.push(kind);
          if (byteSize !== undefined) {
            parts.push(`${byteSize} bytes`);
            numbers.push(byteSize);
          }
          if (sha256 !== undefined) parts.push(`sha256 ${sha256}`);
          assert.equal(v.text, parts.join(", "));
          assert.deepEqual(v.numbers, numbers);
        }
      }

      // M31: history counts
      {
        const src = asRecord(run.M31);
        const v = formatMetric("M31", src);
        const total = asNum(src.total);
        const byOutcome = isRecordValue(src.byOutcome) ? src.byOutcome : undefined;
        if (total === undefined && byOutcome === undefined) {
          assertFallbackValue(v, NOT_AVAILABLE, "M31");
        } else {
          const parts: string[] = [];
          const numbers: number[] = [];
          if (total !== undefined) {
            parts.push(`${total} runs`);
            numbers.push(total);
          }
          if (byOutcome) {
            const outcomes = Object.entries(byOutcome)
              .map(([key, value]) => [key, asNum(value)] as const)
              .filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
              .sort(([a], [b]) => a.localeCompare(b));
            for (const [key, value] of outcomes) {
              parts.push(`${key}: ${value}`);
              numbers.push(value);
            }
          }
          if (parts.length === 0) {
            assertFallbackValue(v, NOT_AVAILABLE, "M31");
          } else {
            assert.equal(v.text, parts.join(", "));
            assert.deepEqual(v.numbers, numbers);
          }
        }
      }
    }),
    { numRuns: 500 }
  );
});
  });
it("M20 and M21 duration formatting matches fixed golden values", () => {
  // Guards against silent regressions such as 61000ms rendering as "1m 2s".
  assert.equal(
    formatMetric("M20", { skeletons: [{ skeletonId: "s1", raisedAt: 1000 }], now: 62000 })
      .text,
    "s1: 1m 1s"
  );
  assert.equal(
    formatMetric("M21", { elapsedMs: 61000, pausedMs: 500 }).text,
    "elapsed 1m 1s, paused 500ms"
  );
});
});