// Task 19.7: Property test for mapping rows (Property 5: P5).
// Validates: Requirement 6.2 (design R3-10, R3-18 P5).
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  BUNDLE_RULE_IDS,
  buildMappingRows,
  extractMappingRows,
  generateBundle,
  normalizePatchSteps,
  type BundleInput,
} from "../../lib/grimoire/bundle";
import type { Signal, UnknownRecord } from "../../lib/grimoire/types";

const ruleArb = fc.constantFrom(...BUNDLE_RULE_IDS);
const fileArb = fc.constantFrom(
  "index.js",
  "lib/util.cjs",
  "tools/build.py",
  "package.json",
  "webpack.config.js"
);

const signalArb: fc.Arbitrary<Signal> = fc.record({
  ruleId: ruleArb,
  file: fileArb,
  line: fc.integer({ min: 1, max: 200 }),
  column: fc.integer({ min: 0, max: 80 }),
  matched: fc.constantFrom("require('request')", "print", "module.exports", "missing lock file"),
  confidence: fc.constantFrom("high" as const, "medium" as const),
  manifestDir: fc.constantFrom(".", "packages/a"),
});

const stepArb = fc.record({
  ruleId: ruleArb,
  file: fileArb,
  reverted: fc.boolean(),
  diff: fc.constant("--- a\n+++ b\n"),
  hunks: fc.constant(1),
  compat: fc.boolean(),
  behavior: fc.constantFrom("preserved", "unknown", "changed"),
});

const unknownArb: fc.Arbitrary<UnknownRecord> = fc.record({
  ruleId: ruleArb,
  reason: fc.constantFrom("py2_residue", "edit_conflict", "registry_unavailable"),
  file: fileArb,
  line: fc.integer({ min: 1, max: 100 }),
});

const bundleInputArb: fc.Arbitrary<BundleInput> = fc
  .record({
    signals: fc.array(signalArb, { maxLength: 6 }),
    steps: fc.array(stepArb, { maxLength: 6 }),
    unknowns: fc.array(unknownArb, { maxLength: 4 }),
    m2Fired: fc.boolean(),
    removedDependencies: fc.subarray(["request", "request-promise"]),
    driftedDependencies: fc.array(
      fc.record({
        name: fc.constantFrom("lodash", "webpack", "react"),
        declaredVersion: fc.constant("^1.0.0"),
        latestVersion: fc.constant("9.0.0"),
        manifestDir: fc.constantFrom(".", "packages/a"),
      }),
      { maxLength: 3 }
    ),
    pythonFileLabels: fc.dictionary(fileArb, fc.constantFrom("m1-clean" as const, "m1-partial" as const)),
  })
  .map((fields) => ({
    owner: "graveyard-fixtures",
    repo: "F-props",
    asOf: "2026-11-08T00:00:00Z",
    targetRuntime: { kind: "node", value: ">=22" },
    preset: true,
    ...fields,
  }));

describe("Property 5: mapping rows (Requirement 6.2)", () => {
  it("cites a rule ID from M1 to M6 on every mapping row of design.md", () => {
    fc.assert(
      fc.property(bundleInputArb, (input) => {
        const bundle = generateBundle(input);
        const rows = extractMappingRows(bundle.design);
        assert.ok(rows.length > 0, "design.md must contain at least one mapping row");
        for (const row of rows) {
          assert.ok(
            (BUNDLE_RULE_IDS as readonly string[]).includes(row.ruleId),
            `mapping row must cite M1 to M6, got ${row.ruleId}`
          );
        }
        // Every row in the Mapping table has a rule ID, so the number of rows is
        // exactly the six rules.
        assert.equal(rows.length, BUNDLE_RULE_IDS.length);
        assert.deepEqual(
          rows.map((row) => row.ruleId),
          [...BUNDLE_RULE_IDS]
        );
      }),
      { numRuns: 150 }
    );
  });

  it("keeps the rendered rows identical to the computed mapping rows", () => {
    fc.assert(
      fc.property(bundleInputArb, (input) => {
        const steps = normalizePatchSteps(input.steps);
        const computed = buildMappingRows(input, steps);
        const rendered = extractMappingRows(generateBundle(input).design);
        for (const row of rendered) {
          const match = computed.find((candidate) => candidate.ruleId === row.ruleId);
          assert.ok(match, `no computed row for ${row.ruleId}`);
          assert.equal(row.finding, match!.finding);
          assert.equal(row.target, match!.target);
          assert.equal(row.fired, match!.fired);
          assert.deepEqual([...row.files].sort(), [...match!.files].sort());
        }
      }),
      { numRuns: 100 }
    );
  });

  it("round-trips a backtick path that contains a comma (Requirement 6.2)", () => {
    const input: BundleInput = {
      owner: "graveyard-fixtures",
      repo: "F-props",
      asOf: "2026-11-08T00:00:00Z",
      targetRuntime: { kind: "node", value: ">=22" },
      m2Fired: false,
      preset: true,
      steps: [],
      signals: [
        {
          ruleId: "M2",
          file: "a,b.js",
          line: 1,
          column: 1,
          matched: "require('request')",
          confidence: "high",
          manifestDir: ".",
        },
      ],
    };
    const rendered = extractMappingRows(generateBundle(input).design);
    const m2 = rendered.find((row) => row.ruleId === "M2");
    assert.ok(m2, "the M2 mapping row must be rendered");
    assert.deepEqual(m2!.files, ["a,b.js"]);
  });
});
