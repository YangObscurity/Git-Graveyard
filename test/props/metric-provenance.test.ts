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
  });
});