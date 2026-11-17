import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectSignals, type DetectSignalsInputFile } from "../../lib/grimoire/signals";
import type { Signal } from "../../lib/grimoire/types";

function assertSignalsSorted(signals: readonly Signal[]): void {
  for (let i = 0; i < signals.length - 1; i++) {
    const a = signals[i];
    const b = signals[i + 1];

    if (a.file !== b.file) {
      assert(
        a.file < b.file,
        `Expected file ${a.file} < ${b.file} at index ${i}`
      );
      continue;
    }
    if (a.line !== b.line) {
      assert(
        a.line < b.line,
        `Expected line ${a.line} < ${b.line} in ${a.file} at index ${i}`
      );
      continue;
    }
    if (a.column !== b.column) {
      assert(
        a.column < b.column,
        `Expected column ${a.column} < ${b.column} in ${a.file}:${a.line} at index ${i}`
      );
      continue;
    }
    if (a.ruleId !== b.ruleId) {
      assert(
        a.ruleId < b.ruleId,
        `Expected ruleId ${a.ruleId} < ${b.ruleId} in ${a.file}:${a.line}:${a.column} at index ${i}`
      );
    }
  }
}

describe("signals: detectSignals", () => {
  describe("Deterministic sorting (Requirement 3.12)", () => {
    it("sorts signals deterministically by (file, line, column, ruleId)", () => {
      const files: DetectSignalsInputFile[] = [
        {
          path: "src/z_last.js",
          content: "const a = require('alpha');\nmodule.exports = a;\n",
          manifestDir: ".",
        },
        {
          path: "src/a_first.js",
          content: [
            "// line 1",
            "const req = require('request');", // line 2: emits M2 and M3 at same line:col
            "const b = require('beta'); const c = require('gamma');", // line 3: two calls on same line
            "module.exports = { req, b, c };", // line 4
          ].join("\n"),
          manifestDir: ".",
        },
        {
          path: "src/m_middle.js",
          content: "new webpack.optimize.CommonsChunkPlugin();\n",
          manifestDir: ".",
        },
      ];

      const result = detectSignals(files);

      assert.ok(result.length > 0);
      assertSignalsSorted(result);

      // Verify file order
      const fileNames = result.map((s) => s.file);
      const uniqueFiles = Array.from(new Set(fileNames));
      assert.deepEqual(uniqueFiles, [
        "src/a_first.js",
        "src/m_middle.js",
        "src/z_last.js",
      ]);

      // Check same line, different columns in src/a_first.js line 3
      const line3Signals = result.filter(
        (s) => s.file === "src/a_first.js" && s.line === 3
      );
      assert.ok(line3Signals.length >= 2);
      assert.ok(line3Signals[0].column < line3Signals[1].column);

      // Check same line and column, different ruleId: M2 before M3 for require('request')
      const line2Signals = result.filter(
        (s) => s.file === "src/a_first.js" && s.line === 2
      );
      assert.equal(line2Signals.length, 2);
      assert.equal(line2Signals[0].ruleId, "M2");
      assert.equal(line2Signals[1].ruleId, "M3");
      assert.equal(line2Signals[0].column, line2Signals[1].column);
    });

    it("maintains sorting for single file with unordered calls", () => {
      const content = [
        "module.exports = 1;", // line 1: M3
        "const x = require('x');", // line 2: M3
        "const r = require('request');", // line 3: M2 & M3
        "const p = CommonsChunkPlugin;", // line 4: M4
      ].join("\n");

      const result = detectSignals({ path: "app.js", content });
      assertSignalsSorted(result);
    });
  });

  describe("Comment suppression (Requirement 3.10)", () => {
    it("suppresses signals for patterns in single-line comments", () => {
      const content = [
        "// require('request')",
        "// const r = require('request');",
        "// CommonsChunkPlugin",
        "// module.exports = {};",
        "// import r from 'request';",
        "const valid = 123;",
      ].join("\n");

      const result = detectSignals({ path: "test.js", content });
      assert.equal(result.length, 0);
    });

    it("suppresses signals for patterns in block comments and JSDoc", () => {
      const content = [
        "/*",
        " * const req = require('request');",
        " * webpack.optimize.CommonsChunkPlugin",
        " * module.exports = req;",
        " */",
        "/**",
        " * @see require('request')",
        " * @typedef {CommonsChunkPlugin} Plugin",
        " */",
        "function run() { return 1; }",
      ].join("\n");

      const result = detectSignals({ path: "test.js", content });
      assert.equal(result.length, 0);
    });

    it("suppresses signals for trailing comments on active code lines", () => {
      const content = "const port = 3000; // require('request') CommonsChunkPlugin\n";
      const result = detectSignals({ path: "test.js", content });
      assert.equal(result.length, 0);
    });
  });

  describe("String literal suppression (Requirement 3.10)", () => {
    it("suppresses signals for patterns inside double-quoted strings", () => {
      const content = [
        'const a = "require(\'request\')";',
        'const b = "CommonsChunkPlugin";',
        'const c = "module.exports";',
        'console.log("import from \'request\'");',
      ].join("\n");

      const result = detectSignals({ path: "test.js", content });
      assert.equal(result.length, 0);
    });

    it("suppresses signals for patterns inside single-quoted strings", () => {
      const content = [
        "const a = 'require(\"request\")';",
        "const b = 'CommonsChunkPlugin';",
        "const c = 'module.exports';",
      ].join("\n");

      const result = detectSignals({ path: "test.js", content });
      assert.equal(result.length, 0);
    });

    it("suppresses signals for patterns inside template literals", () => {
      const content = [
        "const a = `require('request')`;",
        "const b = `prefix ${1 + 2} CommonsChunkPlugin suffix`;",
        "const c = `module.exports = {};`;",
      ].join("\n");

      const result = detectSignals({ path: "test.js", content });
      assert.equal(result.length, 0);
    });

    it("suppresses signals for patterns in object property key strings", () => {
      const content = 'const config = { "require(\'request\')": 42 };\n';
      const result = detectSignals({ path: "test.js", content });
      assert.equal(result.length, 0);
    });
  });

  describe("Signal generation and rule identification (Requirement 3.11)", () => {
    it("detects M2 rule for require('request') with high confidence", () => {
      const content = "const req = require('request');\n";
      const result = detectSignals({ path: "src/client.js", content, manifestDir: "src" });

      const m2Signals = result.filter((s) => s.ruleId === "M2");
      assert.equal(m2Signals.length, 1);
      assert.equal(m2Signals[0].ruleId, "M2");
      assert.equal(m2Signals[0].file, "src/client.js");
      assert.equal(m2Signals[0].line, 1);
      assert.equal(m2Signals[0].confidence, "high");
      assert.equal(m2Signals[0].matched, "require('request')");
      assert.equal(m2Signals[0].manifestDir, "src");
    });

    it("detects M2 for import statements and dynamic import", () => {
      const content = [
        "import req from 'request';",
        "import('request');",
        "export * from 'request';",
      ].join("\n");

      const result = detectSignals({ path: "app.ts", content });
      const m2Signals = result.filter((s) => s.ruleId === "M2");
      assert.equal(m2Signals.length, 3);
      for (const s of m2Signals) {
        assert.equal(s.confidence, "high");
      }
    });

    it("records unknown for request-promise unsupported variants", () => {
      const content = "const rp = require('request-promise');\n";
      const unknowns: any[] = [];
      const result = detectSignals({ path: "index.js", content }, { unknowns });

      assert.equal(result.length, 2); // M2 and M3
      const rpUnknown = unknowns.find((u) => u.reason === "request_promise_unsupported");
      assert.ok(rpUnknown);
      assert.equal(rpUnknown.ruleId, "M2");
      assert.equal(rpUnknown.file, "index.js");
      assert.equal(rpUnknown.line, 1);
    });

    it("detects M3 rule for CommonJS require and module.exports", () => {
      const content = [
        "const fs = require('fs');",
        "const dynamic = require(dynamicMod);",
        "module.exports = { fs };",
      ].join("\n");

      const result = detectSignals({ path: "lib/util.js", content });
      const m3Signals = result.filter((s) => s.ruleId === "M3");
      assert.equal(m3Signals.length, 3);

      // String arg require -> high confidence
      assert.equal(m3Signals[0].confidence, "high");
      // Dynamic non-string require -> medium confidence
      assert.equal(m3Signals[1].confidence, "medium");
      // module.exports -> high confidence
      assert.equal(m3Signals[2].confidence, "high");
    });

    it("detects M4 rule for CommonsChunkPlugin", () => {
      const content = "const plugin = new webpack.optimize.CommonsChunkPlugin({ name: 'v' });\n";
      const result = detectSignals({ path: "webpack.config.js", content });

      const m4Signals = result.filter((s) => s.ruleId === "M4");
      assert.equal(m4Signals.length, 1);
      assert.equal(m4Signals[0].ruleId, "M4");
      assert.equal(m4Signals[0].confidence, "high");
      assert.equal(m4Signals[0].matched, "CommonsChunkPlugin");
    });
  });

  describe("Parse error resilience (Requirement 3.13)", () => {
    it("records parse_error on unparseable files and continues scanning others", () => {
      const files: DetectSignalsInputFile[] = [
        {
          path: "bad.js",
          content: "const = invalid syntax +++ ;;;",
        },
        {
          path: "good.js",
          content: "const req = require('request');",
        },
      ];

      const result = detectSignals(files);

      // Verify parse error was captured in unknowns and parseErrors
      assert.equal(result.parseErrors.length, 1);
      assert.equal(result.parseErrors[0].reason, "parse_error");
      assert.equal(result.parseErrors[0].file, "bad.js");

      // Verify good file was still parsed and signals were detected
      const m2Signals = result.filter((s) => s.ruleId === "M2");
      assert.equal(m2Signals.length, 1);
      assert.equal(m2Signals[0].file, "good.js");
    });
  });

  describe("Input shapes and file filtering", () => {
    it("accepts object with files array", () => {
      const result = detectSignals({
        files: [
          { path: "src/a.js", content: "module.exports = {};" },
        ],
      });
      assert.equal(result.length, 1);
      assert.equal(result[0].ruleId, "M3");
    });

    it("accepts object with scannedFiles array", () => {
      const result = detectSignals({
        scannedFiles: [
          { path: "src/b.ts", content: "import req from 'request';" },
        ],
      });
      assert.equal(result.length, 1);
      assert.equal(result[0].ruleId, "M2");
    });

    it("ignores non-parseable file types without error", () => {
      const result = detectSignals([
        { path: "README.md", content: "require('request')" },
        { path: "style.css", content: ".cls { color: red; }" },
      ]);
      assert.equal(result.length, 0);
      assert.equal(result.parseErrors.length, 0);
    });
  });
});
