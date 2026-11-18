import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gateJs, checkCandidate } from "../../lib/grimoire/gate-js";

describe("Finding H-7: Grimoire JS gate single-file content and object-argument shape", () => {
  describe("Single-file call without content returns ok false", () => {
    it("returns ok false when positional call omits content", () => {
      const result = gateJs("src/missing-content.js");
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/missing-content.js");
      assert.deepEqual(result.files, ["src/missing-content.js"]);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.ok(result.reasons.length > 0);
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/missing-content.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
      assert.equal(result.details?.["src/missing-content.js"]?.ok, false);
    });

    it("returns ok false when options object omits content with filePath", () => {
      const result = gateJs({ filePath: "src/options-no-content.js" });
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/options-no-content.js");
      assert.deepEqual(result.files, ["src/options-no-content.js"]);
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/options-no-content.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when options object omits content with file", () => {
      const result = gateJs({ file: "src/file-prop-no-content.js" });
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/file-prop-no-content.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/file-prop-no-content.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when options object omits content with path", () => {
      const result = gateJs({ path: "src/path-prop-no-content.js" });
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/path-prop-no-content.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/path-prop-no-content.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("accepts empty string content as normal input in positional call", () => {
      const result = gateJs("src/empty.js", "");
      assert.equal(result.ok, true);
      assert.equal(result.file, "src/empty.js");
      assert.deepEqual(result.reasons, []);
    });

    it("accepts empty string content as normal input in options object call", () => {
      const result = gateJs({ filePath: "src/empty-opts.js", content: "" });
      assert.equal(result.ok, true);
      assert.equal(result.file, "src/empty-opts.js");
      assert.deepEqual(result.reasons, []);
    });

    it("accepts empty string originalContent as normal input in options object call", () => {
      const result = gateJs({
        filePath: "src/empty-original.js",
        originalContent: "",
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
    });
  });

  describe("Single-file call with non-string content returns ok false", () => {
    it("returns ok false when positional call passes numeric content", () => {
      const result = gateJs("src/numeric.js", 12345 as any);
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/numeric.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/numeric.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when positional call passes null content", () => {
      const result = gateJs("src/null.js", null as any);
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/null.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/null.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when positional call passes boolean content", () => {
      const result = gateJs("src/bool.js", true as any);
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/bool.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/bool.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when positional call passes object as content", () => {
      const result = gateJs("src/obj.js", { raw: "const x = 1;" } as any);
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/obj.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/obj.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when options object has non-string content", () => {
      const result = gateJs({
        filePath: "src/bad-content.js",
        content: 999 as any,
      });
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/bad-content.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/bad-content.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when options object has null originalContent", () => {
      const result = gateJs({
        filePath: "src/null-original.js",
        originalContent: null as any,
      });
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/null-original.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/null-original.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });

    it("returns ok false when options object has non-string source", () => {
      const result = gateJs({
        filePath: "src/bad-source.js",
        source: false as any,
      });
      assert.equal(result.ok, false);
      assert.equal(result.file, "src/bad-source.js");
      assert.ok(
        result.reasons.some(
          (r) =>
            r.includes("src/bad-source.js") &&
            r.toLowerCase().includes("content is missing")
        )
      );
    });
  });

  describe("The object-argument form with arbitrary keys returns ok false", () => {
    it("returns ok false for gateJs with arbitrary string keys", () => {
      const result = gateJs({
        arbitraryKey1: "const a = 1;\n",
        arbitraryKey2: "const b = 2;\n",
      } as any);
      assert.equal(result.ok, false);
      assert.ok(result.reasons.length > 0);
    });

    it("returns ok false for checkCandidate with arbitrary keys", () => {
      const result = checkCandidate({
        foo: "const x = 1;\n",
        bar: "const y = 2;\n",
      } as any);
      assert.equal(result.ok, false);
      assert.ok(result.reasons.length > 0);
    });

    it("returns ok false when gateJs is called with direct file paths as keys", () => {
      const result = gateJs({
        "src/a.js": "const a = 1;\n",
        "src/b.js": "const b = 2;\n",
      } as any);
      assert.equal(result.ok, false);
      assert.ok(result.reasons.length > 0);
    });

    it("returns ok false when checkCandidate is called with direct file paths as keys", () => {
      const result = checkCandidate({
        "src/main.js": "const app = 1;\n",
      } as any);
      assert.equal(result.ok, false);
      assert.ok(result.reasons.length > 0);
    });

    it("returns ok false when candidate files property has invalid shape", () => {
      const result = checkCandidate({
        files: "not-an-array-or-object" as any,
      });
      assert.equal(result.ok, false);
      assert.ok(result.reasons.length > 0);
    });
  });

  describe("A valid array call with valid JavaScript still returns ok true", () => {
    it("returns ok true for gateJs called with array of file objects", () => {
      const result = gateJs([
        {
          path: "src/valid1.js",
          content: "const greeting = 'hello';\nfunction getGreeting() { return greeting; }\n",
        },
      ] as any);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/valid1.js"));
    });

    it("returns ok true for checkCandidate called with array of file objects", () => {
      const result = checkCandidate([
        {
          path: "src/valid2.js",
          content: "function add(a, b) { return a + b; }\nvar total = add(1, 2);\n",
        },
      ]);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/valid2.js"));
    });

    it("returns ok false for array items using file property instead of path", () => {
      const result = gateJs([
        {
          file: "src/helper.js",
          content: "const x = 10;\nmodule.exports = { x };\n",
        },
      ] as any);
      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [
        "invalid files shape: expected array of {path, content}",
      ]);
    });

    it("returns ok true for multiple valid JavaScript files in array", () => {
      const result = gateJs([
        {
          path: "src/modA.js",
          content: "var a = 'alpha';\n",
        },
        {
          path: "src/modB.js",
          content: "var b = 'beta';\n",
        },
      ] as any);
      assert.equal(result.ok, true);
      assert.equal(result.files.length, 2);
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/modA.js"));
      assert.ok(result.files.includes("src/modB.js"));
    });

    it("returns ok true for valid JavaScript in .mjs module file", () => {
      const result = gateJs([
        {
          path: "src/types.mjs",
          content: "export const config = { timeout: 1000 };\nexport default config;\n",
        },
      ] as any);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/types.mjs"));
    });

    it("returns ok true for candidate object with documented files array", () => {
      const result = checkCandidate({
        files: [
          {
            path: "src/candidate-array.js",
            content: "var version = '1.0.0';\n",
          },
        ],
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/candidate-array.js"));
    });
  });
});
