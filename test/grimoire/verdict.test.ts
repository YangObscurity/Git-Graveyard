import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeVerdict,
  roundToOneDecimal,
  subtract24CalendarMonths,
  hasDeprecationSignal,
  STILL_BREATHING,
} from "../../lib/grimoire/verdict";
import type { Signal } from "../../lib/grimoire/types";

describe("verdict: computeVerdict", () => {
  const PINNED_AS_OF = "2026-11-01T00:00:00.000Z";

  describe("Dead or alive status and reasons (Requirement 4.1 to 4.6)", () => {
    it("returns status alive with 'still breathing' when no dead reasons apply", () => {
      const result = computeVerdict({
        archived: false,
        createdAt: "2025-01-01T00:00:00.000Z",
        lastCommitAt: "2026-10-01T00:00:00.000Z",
        signals: [],
        asOf: PINNED_AS_OF,
      });

      assert.equal(result.status, "alive");
      assert.deepEqual(result.deadReasons, []);
      assert.deepEqual(result.reasons, []);
      assert.equal(result.label, STILL_BREATHING);
    });

    it("adds archived reason when archived is true (Requirement 4.1)", () => {
      const result = computeVerdict({
        archived: true,
        createdAt: "2025-01-01T00:00:00.000Z",
        lastCommitAt: "2026-10-01T00:00:00.000Z",
        asOf: PINNED_AS_OF,
      });

      assert.equal(result.status, "dead");
      assert.deepEqual(result.deadReasons, ["archived"]);
      assert.equal(result.label, undefined);
    });

    it("adds dormant_24m reason when lastCommitAt is older than asOf minus 24 months (Requirement 4.2)", () => {
      // 24 months before 2026-11-01 is 2024-11-01
      const dormantResult = computeVerdict({
        archived: false,
        createdAt: "2020-01-01T00:00:00.000Z",
        lastCommitAt: "2024-10-31T23:59:59.000Z", // Older than 24 months
        asOf: PINNED_AS_OF,
      });

      assert.equal(dormantResult.status, "dead");
      assert.ok(dormantResult.deadReasons.includes("dormant_24m"));

      const activeResult = computeVerdict({
        archived: false,
        createdAt: "2020-01-01T00:00:00.000Z",
        lastCommitAt: "2024-11-02T00:00:00.000Z", // Within 24 months
        asOf: PINNED_AS_OF,
      });

      assert.equal(activeResult.status, "alive");
      assert.equal(activeResult.deadReasons.includes("dormant_24m"), false);
    });

    it("adds deprecation_signal for high-confidence M1 to M4 signals (Requirement 4.3)", () => {
      const rules = ["M1", "M2", "M3", "M4"] as const;

      for (const ruleId of rules) {
        const signal: Signal = {
          ruleId,
          file: "src/index.js",
          line: 1,
          column: 0,
          matched: "legacy",
          confidence: "high",
          manifestDir: ".",
        };

        const result = computeVerdict({
          archived: false,
          createdAt: "2025-01-01T00:00:00.000Z",
          lastCommitAt: "2026-10-01T00:00:00.000Z",
          signals: [signal],
          asOf: PINNED_AS_OF,
        });

        assert.equal(
          result.status,
          "dead",
          `Expected status dead for high-confidence ${ruleId}`
        );
        assert.ok(
          result.deadReasons.includes("deprecation_signal"),
          `Expected deprecation_signal for ${ruleId}`
        );
      }
    });

    it("excludes M5 and M6 signals from deprecation_signal reason (Requirement 4.4)", () => {
      const excludedRules = ["M5", "M6"] as const;

      for (const ruleId of excludedRules) {
        const signal: Signal = {
          ruleId,
          file: "package.json",
          line: 1,
          column: 0,
          matched: "drift",
          confidence: "high",
          manifestDir: ".",
        };

        const result = computeVerdict({
          archived: false,
          createdAt: "2025-01-01T00:00:00.000Z",
          lastCommitAt: "2026-10-01T00:00:00.000Z",
          signals: [signal],
          asOf: PINNED_AS_OF,
        });

        assert.equal(
          result.status,
          "alive",
          `Expected status alive when only ${ruleId} is present`
        );
        assert.equal(result.deadReasons.includes("deprecation_signal"), false);
      }
    });

    it("does not trigger deprecation_signal for medium or low confidence signals", () => {
      const mediumSignal: Signal = {
        ruleId: "M2",
        file: "src/index.js",
        line: 1,
        column: 0,
        matched: "require",
        confidence: "medium",
        manifestDir: ".",
      };

      const result = computeVerdict({
        archived: false,
        createdAt: "2025-01-01T00:00:00.000Z",
        lastCommitAt: "2026-10-01T00:00:00.000Z",
        signals: [mediumSignal],
        asOf: PINNED_AS_OF,
      });

      assert.equal(result.status, "alive");
      assert.equal(result.deadReasons.includes("deprecation_signal"), false);
    });

    it("accumulates multiple dead reasons when applicable", () => {
      const signal: Signal = {
        ruleId: "M2",
        file: "src/index.js",
        line: 1,
        column: 0,
        matched: "require('request')",
        confidence: "high",
        manifestDir: ".",
      };

      const result = computeVerdict({
        archived: true,
        createdAt: "2020-01-01T00:00:00.000Z",
        lastCommitAt: "2022-01-01T00:00:00.000Z",
        signals: [signal],
        asOf: PINNED_AS_OF,
      });

      assert.equal(result.status, "dead");
      assert.deepEqual(result.deadReasons.sort(), [
        "archived",
        "deprecation_signal",
        "dormant_24m",
      ]);
    });
  });

  describe("Lifespan calculation and negative lifespan (Requirement 4.7, 4.8)", () => {
    it("computes lifespanYears as (lastCommitAt - createdAt) / 365.25 rounded to 1 decimal", () => {
      // Exactly 730.5 days = 2.0 years
      const createdAt = new Date("2020-01-01T00:00:00.000Z");
      const lastCommitAt = new Date(
        createdAt.getTime() + 730.5 * 86_400_000
      );

      const result = computeVerdict({
        archived: false,
        createdAt,
        lastCommitAt,
        asOf: PINNED_AS_OF,
      });

      assert.equal(result.lifespanYears, 2);
    });

    it("reports lifespanYears as 'unknown' when computed lifespan is negative (Requirement 4.8)", () => {
      // lastCommitAt is earlier than createdAt
      const result = computeVerdict({
        archived: false,
        createdAt: "2025-01-01T00:00:00.000Z",
        lastCommitAt: "2024-01-01T00:00:00.000Z",
        asOf: PINNED_AS_OF,
      });

      assert.equal(result.lifespanYears, "unknown");
    });

    it("reports lifespanYears as 'unknown' when createdAt or lastCommitAt is missing", () => {
      const noCreated = computeVerdict({
        archived: false,
        lastCommitAt: "2025-01-01T00:00:00.000Z",
        asOf: PINNED_AS_OF,
      });
      assert.equal(noCreated.lifespanYears, "unknown");

      const noCommit = computeVerdict({
        archived: false,
        createdAt: "2025-01-01T00:00:00.000Z",
        asOf: PINNED_AS_OF,
      });
      assert.equal(noCommit.lifespanYears, "unknown");
    });
  });

  describe("Years dead calculation (Requirement 4.9)", () => {
    it("computes yearsDead as (asOf - lastCommitAt) / 365.25 rounded to 1 decimal", () => {
      const asOf = new Date("2026-01-01T00:00:00.000Z");
      // 365.25 days earlier = 1.0 year dead
      const lastCommitAt = new Date(asOf.getTime() - 365.25 * 86_400_000);

      const result = computeVerdict({
        archived: false,
        createdAt: "2020-01-01T00:00:00.000Z",
        lastCommitAt,
        asOf,
      });

      assert.equal(result.yearsDead, 1);
    });

    it("returns yearsDead = 0 when lastCommitAt is missing", () => {
      const result = computeVerdict({
        archived: false,
        asOf: PINNED_AS_OF,
      });
      assert.equal(result.yearsDead, 0);
    });
  });

  describe("asOf timestamp handling (Requirement 4.10, 4.11)", () => {
    it("uses provided asOf timestamp formatted as ISO string", () => {
      const result = computeVerdict({
        asOf: "2025-06-15T12:30:00.000Z",
      });
      assert.equal(result.asOf, "2025-06-15T12:30:00.000Z");
    });

    it("defaults to current time when asOf is omitted", () => {
      const before = new Date().getTime();
      const result = computeVerdict({});
      const after = new Date().getTime();

      const asOfTime = new Date(result.asOf).getTime();
      assert.ok(asOfTime >= before && asOfTime <= after);
    });
  });

  describe("Positional arguments and nested metadata options", () => {
    it("accepts positional arguments computeVerdict(archived, lastCommitAt, createdAt, signals, asOf)", () => {
      const result = computeVerdict(
        true,
        "2026-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
        [],
        PINNED_AS_OF
      );

      assert.equal(result.status, "dead");
      assert.deepEqual(result.deadReasons, ["archived"]);
      assert.equal(typeof result.lifespanYears, "number");
    });

    it("reads properties from nested meta and headCommit objects", () => {
      const result = computeVerdict({
        meta: {
          archived: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          asOf: PINNED_AS_OF,
        },
        headCommit: {
          committerDate: "2025-01-01T00:00:00.000Z",
        },
      });

      assert.equal(result.status, "dead");
      assert.deepEqual(result.deadReasons, ["archived"]);
      assert.equal(typeof result.lifespanYears, "number");
    });
  });

  describe("Helper functions", () => {
    it("roundToOneDecimal rounds correctly and handles negative zero", () => {
      assert.equal(roundToOneDecimal(1.234), 1.2);
      assert.equal(roundToOneDecimal(1.25), 1.3);
      assert.equal(roundToOneDecimal(0), 0);
      assert.equal(Object.is(roundToOneDecimal(-0.01), 0), true);
      assert.equal(roundToOneDecimal(Infinity), 0);
    });

    it("subtract24CalendarMonths subtracts exactly 2 years with calendar clamping", () => {
      const date = new Date("2026-03-31T00:00:00.000Z");
      const subtracted = subtract24CalendarMonths(date);
      assert.equal(subtracted.getUTCFullYear(), 2024);
      assert.equal(subtracted.getUTCMonth(), 2); // March
      assert.equal(subtracted.getUTCDate(), 31);
    });

    it("hasDeprecationSignal validates signal collections", () => {
      assert.equal(hasDeprecationSignal(null), false);
      assert.equal(hasDeprecationSignal([]), false);
      assert.equal(
        hasDeprecationSignal([
          {
            ruleId: "M2",
            file: "f",
            line: 1,
            column: 0,
            matched: "m",
            confidence: "high",
            manifestDir: ".",
          },
        ]),
        true
      );
      assert.equal(
        hasDeprecationSignal([
          {
            ruleId: "M6",
            file: "f",
            line: 1,
            column: 0,
            matched: "m",
            confidence: "high",
            manifestDir: ".",
          },
        ]),
        false
      );
    });
  });
});
