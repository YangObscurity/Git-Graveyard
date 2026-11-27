// Task 19.8: Property test for tasks equal steps (Property 7: P7).
// Validates: Requirements 10.4, 10.5 (design R3-18 P7).
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  BUNDLE_RULE_IDS,
  buildBundleTasks,
  generateBundle,
  normalizePatchSteps,
  parseBundleTasks,
  type BundleInput,
} from "../../lib/grimoire/bundle";

const ruleArb = fc.constantFrom(...BUNDLE_RULE_IDS);
const fileArb = fc.constantFrom(
  "index.js",
  "lib/util.cjs",
  "tools/build.py",
  "setup.py",
  "webpack.config.js"
);

/**
 * A distinct `(ruleId, file)` patch step. `reverted` decides the `[x]` marking
 * and the Outcome line; `acceptedEdits`/`diff` make the step patch-worthy.
 */
const stepArb: fc.Arbitrary<{ ruleId: string; file: string; reverted: boolean }> = fc.record({
  ruleId: ruleArb,
  file: fileArb,
  reverted: fc.boolean(),
});

const uniqueStepsArb = fc
  .array(stepArb, { maxLength: 8 })
  .map((steps) => {
    const seen = new Set<string>();
    const unique: typeof steps = [];
    for (const step of steps) {
      const key = `${step.ruleId}:${step.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(step);
    }
    return unique.map((step) => ({
      ...step,
      diff: "--- a\n+++ b\n",
      hunks: 1,
      acceptedEdits: step.reverted ? 0 : 1,
    }));
  });

const inputArb: fc.Arbitrary<BundleInput> = fc
  .record({
    steps: uniqueStepsArb,
    preset: fc.boolean(),
    signals: fc.array(
      fc.record({
        ruleId: fc.constant("M6" as const),
        file: fc.constant("package.json"),
        line: fc.constant(1),
        column: fc.constant(1),
        matched: fc.constant("missing lock file"),
        confidence: fc.constant("high" as const),
        manifestDir: fc.constantFrom(".", "packages/a"),
      }),
      { maxLength: 2 }
    ),
  })
  .map((fields) => ({
    owner: "graveyard-fixtures",
    repo: "F-props",
    asOf: "2026-11-08T00:00:00Z",
    targetRuntime: { kind: "node" as const, value: ">=22" },
    ...fields,
  }));

describe("Property 7: tasks equal steps (Requirements 10.4, 10.5)", () => {
  it("keeps T = S between patch tasks and patch steps", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const bundle = generateBundle(input);
        const parsed = parseBundleTasks(bundle.tasks);

        const stepKeys = new Set(bundle.patchSteps.map((step) => `${step.ruleId}:${step.file}`));
        const taskKeys = new Set(parsed.patch.map((task) => `${task.ruleId}:${task.file}`));
        assert.deepEqual([...taskKeys].sort(), [...stepKeys].sort());
        assert.equal(parsed.patch.length, stepKeys.size, "one patch task per patch step");
        assert.equal(stepKeys.size, normalizePatchSteps(input.steps).length);
      }),
      { numRuns: 150 }
    );
  });

  it("checks a patch task if and only if its patch step is not reverted", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const bundle = generateBundle(input);
        const parsed = parseBundleTasks(bundle.tasks);
        const revertedKeys = new Set(
          bundle.patchSteps
            .filter((step) => step.reverted)
            .map((step) => `${step.ruleId}:${step.file}`)
        );
        for (const task of parsed.patch) {
          const key = `${task.ruleId}:${task.file}`;
          assert.equal(
            task.checked,
            !revertedKeys.has(key),
            `${key} must be [x] iff its step is not reverted`
          );
          if (revertedKeys.has(key)) {
            assert.equal(
              task.outcome,
              `reverted (all_edits_rejected)`,
              `${key} must carry the revert reason`
            );
          }
        }
        assert.equal(
          parsed.patch.filter((task) => !task.checked).length,
          revertedKeys.size
        );
      }),
      { numRuns: 150 }
    );
  });

  it("excludes manual tasks from T and leaves them unchecked except the preset M6 task", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const built = buildBundleTasks(input);
        for (const task of built.manualTasks) {
          if (task.ruleId === "M6" && input.preset !== false) {
            assert.equal(task.checked, true);
          } else {
            assert.equal(task.checked, false);
          }
        }
        const stepKeys = new Set(built.steps.map((step) => `${step.ruleId}:${step.file}`));
        for (const task of built.manualTasks) {
          assert.equal(
            stepKeys.has(`${task.ruleId}:${task.target}`),
            false,
            "manual tasks never enter the patch bijection"
          );
        }
      }),
      { numRuns: 120 }
    );
  });
});
