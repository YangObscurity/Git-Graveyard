// Task 19.6: Property test for the syntax gate (Property 4: P4, amended in R3-18).
// Validates: Requirements 9.5, 9.7, 9.8.
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  gateJs,
  isJsOrTsFile,
  resolveOriginalParseMode,
  resolvePatchedParseMode,
  tryParseJsOrTs,
  type GateResult,
} from "../../lib/grimoire/gate-js";

interface JsCase {
  path: string;
  content: string;
}

const caseArb: fc.Arbitrary<JsCase> = fc.constantFrom<JsCase>(
  { path: "index.js", content: "module.exports = { a: 1 };\n" },
  { path: "lib/util.cjs", content: "const x = 1;\nmodule.exports = { x };\n" },
  { path: "index.mjs", content: "export const a = 1;\n" },
  { path: "app.ts", content: "const a: number = 1;\nexport default a;\n" },
  { path: "src/view.jsx", content: "const el = <div className=\"x\" />;\n" },
  { path: "broken-script.js", content: "const a: number = 1;\n" }
);

const MUTATIONS = ["", "%%%", "(", ")", "}", "const z = 1;", "x =", "=>", "return"];

function editArb(length: number): fc.Arbitrary<{ start: number; end: number; replacement: string }> {
  return fc
    .record({
      a: fc.integer({ min: 0, max: length }),
      b: fc.integer({ min: 0, max: length }),
      replacement: fc.constantFrom(...MUTATIONS),
    })
    .map(({ a, b, replacement }) => {
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      return { start, end, replacement };
    });
}

function stepsArb(item: JsCase): fc.Arbitrary<Array<Record<string, unknown>>> {
  return fc.array(
    fc.record({
      ruleId: fc.constantFrom("M2", "M3"),
      file: fc.constant(item.path),
      reverted: fc.constant(false),
      compat: fc.boolean(),
      edits: fc.array(editArb(item.content.length), { minLength: 1, maxLength: 2 }),
    }),
    { minLength: 1, maxLength: 2 }
  );
}

function changedFileSteps(result: GateResult, file: string): Array<Record<string, unknown>> {
  return ((result.steps ?? []) as unknown as Array<Record<string, unknown>>).filter(
    (step) => step.file === file
  );
}

describe("Property 4: syntax gate (Requirements 9.5, 9.7, 9.8)", () => {
  it("parses the patched file under mode(f), or reverts every step for the file", () => {
    fc.assert(
      fc.property(
        caseArb.chain((item) => fc.tuple(fc.constant(item), stepsArb(item))),
        ([item, steps]) => {
          assert.ok(isJsOrTsFile(item.path));
          const result = gateJs(item.path, item.content, steps as never);

          const originalMode = resolveOriginalParseMode(item.path);
          assert.equal(result.originalMode, originalMode);

          if (result.ok) {
            const mode = resolvePatchedParseMode(item.path, result.steps ?? []);
            assert.equal(result.mode, mode);
            const parsed = tryParseJsOrTs(result.code ?? "", item.path, mode);
            assert.equal(
              parsed.ok,
              true,
              `patched ${item.path} must parse under mode ${mode}: ${
                parsed.ok ? "" : parsed.error.message
              }\n${result.code}`
            );
            // No step may be reverted and applied at the same time.
            for (const step of result.revertedSteps ?? []) {
              assert.equal(step.reverted, true);
            }
            return;
          }

          const originalParsed = tryParseJsOrTs(
            item.content,
            item.path,
            originalMode
          ).ok;
          const reasons = (result.reasons ?? []).join(" ");
          if (!originalParsed) {
            assert.match(reasons, /original_unparseable/);
            assert.equal(result.code, item.content, "an unparseable original is unchanged");
            return;
          }
          // Requirement 9.8: the failing step is reverted with reason parse_failed.
          assert.match(reasons, /parse_failed/);
          assert.equal(result.code, item.content);
          const fileSteps = changedFileSteps(result, item.path);
          assert.ok(fileSteps.length > 0);
          for (const step of fileSteps) {
            assert.equal(step.reverted, true, "every step that changed the file must be reverted");
          }
        }
      ),
      { numRuns: 120 }
    );
  });

  it("keeps an unmodified file parseable in its original mode", () => {
    fc.assert(
      fc.property(caseArb, (item) => {
        const result = gateJs(item.path, item.content, []);
        const originalMode = resolveOriginalParseMode(item.path);
        const parsed = tryParseJsOrTs(item.content, item.path, originalMode);
        assert.equal(result.originalMode, originalMode);
        if (parsed.ok) {
          assert.equal(result.ok, true, result.reasons.join(" "));
          assert.equal(result.code, item.content);
        } else {
          assert.equal(result.ok, false);
          assert.match(result.reasons.join(" "), /original_unparseable/);
        }
      }),
      { numRuns: 60 }
    );
  });

  it("parses a patched .mjs file as a module and a patched .js file as script", () => {
    const moduleCase = gateJs("index.mjs", "export const a = 1;\n", [
      {
        ruleId: "M3",
        file: "index.mjs",
        reverted: false,
        code: "export const a = 2;\n",
      } as never,
    ]);
    assert.equal(moduleCase.ok, true, moduleCase.reasons.join(" "));
    assert.equal(moduleCase.mode, "module");

    const scriptCase = gateJs("index.js", "module.exports = 1;\n", [
      {
        ruleId: "M2",
        file: "index.js",
        reverted: false,
        code: "module.exports = 2;\n",
      } as never,
    ]);
    assert.equal(scriptCase.ok, true, scriptCase.reasons.join(" "));
    assert.equal(scriptCase.originalMode, "script");
  });
});
