import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCandidate,
  gateJs,
  tryParseJsOrTs,
  type PatchStep,
} from "../../lib/grimoire/gate-js";

// Work package SA4 (Audit item N-A6):
// The JS gate must not fall back to the typescript plugin for .js, .cjs and .mjs
// files, must use the jsx plugin only when the file contains JSX, and must not
// apply the loose allow* parser options to plain JavaScript files.
describe("grimoire/gate-js SA4: strict parser plugins and options for plain JavaScript", () => {
  describe("no typescript plugin fallback for plain JavaScript", () => {
    it("fails the gate for TypeScript-only syntax in a .js file", () => {
      const tsInJs =
        "interface User { id: number }\nconst u: User = { id: 1 };\n";
      const result = gateJs("src/app.js", tsInJs);
      assert.equal(result.ok, false);
      assert.equal(result.reasons.length, 1);
      assert(result.reasons[0].includes("original_unparseable"));
    });

    it("fails the gate for a TypeScript annotation in a .js candidate file", () => {
      const candidate = {
        files: [
          { path: "src/annotated.js", content: "const n: number = 1;\n" },
        ],
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, false);
      assert.equal(result.details?.["src/annotated.js"]?.ok, false);
    });

    it("fails parsing for TypeScript enum syntax in a .cjs file", () => {
      const res = tryParseJsOrTs(
        "enum Color { Red, Green }\n",
        "src/kinds.cjs",
        "script"
      );
      assert.equal(res.ok, false);
    });

    it("fails parsing for a TypeScript type alias in a .mjs file", () => {
      const res = tryParseJsOrTs(
        "type Pair = [string, number];\n",
        "src/pairs.mjs",
        "module"
      );
      assert.equal(res.ok, false);
    });

    it("still parses TypeScript syntax in .ts and .tsx files", () => {
      const tsCode =
        "interface User { id: number; name: string }\nconst u: User = { id: 1, name: 'A' };\n";
      assert.equal(tryParseJsOrTs(tsCode, "src/user.ts", "module").ok, true);

      const tsxCode = "export const App = () => <div>Hello</div>;\n";
      assert.equal(tryParseJsOrTs(tsxCode, "src/App.tsx", "module").ok, true);
    });
  });

  describe("jsx plugin only when the file contains JSX", () => {
    it("parses a .js file that contains JSX", () => {
      const res = tryParseJsOrTs(
        "export const App = () => <div className='ok'>hi</div>;\n",
        "src/comp.js",
        "module"
      );
      assert.equal(res.ok, true);
    });

    it("parses a .jsx file that contains JSX", () => {
      const res = tryParseJsOrTs(
        "export const App = () => <span>text</span>;\n",
        "src/comp.jsx",
        "module"
      );
      assert.equal(res.ok, true);
    });

    it("parses a .js file with comparison operators and no JSX", () => {
      const res = tryParseJsOrTs(
        "const a = x < y && m > n;\nif (a) { console.log(a); }\n",
        "src/plain.js",
        "script"
      );
      assert.equal(res.ok, true);
    });

    it("passes the gate when a patch step introduces JSX into a .js file", () => {
      const step: PatchStep = {
        id: "step-jsx",
        ruleId: "M2",
        file: "src/ui.js",
        edits: [{ start: 11, end: 15, text: "<div>ok</div>" }],
        reverted: false,
      };
      const result = gateJs("src/ui.js", "const el = null;\n", [step]);
      assert.equal(result.ok, true);
      assert.equal(result.code, "const el = <div>ok</div>;\n");
      assert.equal(result.steps?.[0].reverted, false);
    });
  });

  describe("loose allow* options removed for plain JavaScript", () => {
    it("fails the gate for top-level await in a .cjs file", () => {
      const result = gateJs("src/worker.cjs", "const data = await load();\n");
      assert.equal(result.ok, false);
      assert.equal(result.reasons.length, 1);
      assert(result.reasons[0].includes("original_unparseable"));
    });

    it("fails parsing for top-level await in a .js script file", () => {
      const res = tryParseJsOrTs(
        "const v = await load();\n",
        "src/boot.js",
        "script"
      );
      assert.equal(res.ok, false);
    });

    it("still parses top-level await in a .mjs module", () => {
      const res = tryParseJsOrTs(
        "export const data = await load();\n",
        "src/boot.mjs",
        "module"
      );
      assert.equal(res.ok, true);
    });

    it("fails the gate for a top-level return in a .js script file", () => {
      const result = gateJs(
        "src/legacy.js",
        "function f() {\n  return 1;\n}\nreturn 2;\n"
      );
      assert.equal(result.ok, false);
    });

    it("fails the gate for bare super outside a method in a .js file", () => {
      const result = gateJs("src/misplaced.js", "super.g();\n");
      assert.equal(result.ok, false);
    });

    it("fails parsing for an export of an undeclared binding in a .mjs file", () => {
      const res = tryParseJsOrTs(
        "export { missing };\n",
        "src/exports.mjs",
        "module"
      );
      assert.equal(res.ok, false);
    });

    it("still parses an export of a declared binding in a .mjs module", () => {
      const res = tryParseJsOrTs(
        "const v = 1;\nexport { v };\n",
        "src/exports.mjs",
        "module"
      );
      assert.equal(res.ok, true);
    });
  });

  describe("valid ESM and CJS still pass", () => {
    it("passes the gate for valid ESM in .mjs and valid CJS in .cjs", () => {
      const candidate = {
        files: [
          {
            path: "src/esm.mjs",
            content:
              "import fs from 'node:fs';\nexport const read = fs.readFileSync;\n",
          },
          {
            path: "src/cjs.cjs",
            content:
              "const path = require('node:path');\nmodule.exports.sep = path.sep;\n",
          },
        ],
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.equal(result.details?.["src/esm.mjs"]?.ok, true);
      assert.equal(result.details?.["src/esm.mjs"]?.mode, "module");
      assert.equal(result.details?.["src/cjs.cjs"]?.ok, true);
      assert.equal(result.details?.["src/cjs.cjs"]?.mode, "script");
    });

    it("passes the gate for ESM in a .js file under a type module package", () => {
      const candidate = {
        packageJson: { type: "module" },
        files: [
          {
            path: "src/mod.js",
            content: "import fs from 'node:fs';\nexport const x = 1;\n",
          },
        ],
        changedFiles: ["src/mod.js"],
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, true);
      assert.equal(result.details?.["src/mod.js"]?.mode, "module");
    });

    it("passes the gate for CommonJS in a plain .js script file", () => {
      const result = gateJs(
        "src/legacy.js",
        "const path = require('node:path');\nmodule.exports = { join: path.join };\n"
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
    });
  });

  describe("step rollback still works under strict parsing", () => {
    it("reverts a step whose code fails strict parsing and keeps the original", () => {
      const badStep: PatchStep = {
        id: "step-bad-sa4",
        ruleId: "M2",
        file: "file.js",
        code: "const a = ;;;",
        reverted: false,
      };
      const result = gateJs("file.js", "const a = 1;\n", [badStep]);
      assert.equal(result.ok, true);
      assert.equal(result.code, "const a = 1;\n");
      assert.equal(result.steps?.[0].reverted, true);
      assert.equal(result.steps?.[0].revertReason, "parse_failed");
    });

    it("accepts a step whose code is valid strict JavaScript", () => {
      const goodStep: PatchStep = {
        id: "step-good-sa4",
        ruleId: "M2",
        file: "file.js",
        code: "const a = 1;\nmodule.exports = { a };\n",
        reverted: false,
      };
      const result = gateJs("file.js", "const a = 1;\n", [goodStep]);
      assert.equal(result.ok, true);
      assert.equal(result.code, "const a = 1;\nmodule.exports = { a };\n");
      assert.equal(result.steps?.[0].reverted, false);
    });
  });
});
