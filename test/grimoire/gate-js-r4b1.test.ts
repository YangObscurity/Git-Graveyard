// Work package R4-B1 (Remediation: gate-js accepts only an array of path and content (audit H-7))
// Tests covering:
// 1. A Record and a Map as files are rejected with ok false, gate syntax,
//    reason 'invalid files shape: expected array of {path, content}'.
// 2. An entry without a path and an entry without a string content are rejected.
// 3. Content without a path in the object form is rejected with reason 'missing path'.
// 4. A valid array of {path, content} is accepted as before.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCandidate, gateJs } from "../../lib/grimoire/gate-js";

describe("Work package R4-B1: Grimoire JS gate accepts only an array of path and content (audit H-7)", () => {
  const invalidFilesShapeReason =
    "invalid files shape: expected array of {path, content}";

  describe("1. A Record and a Map as files are rejected", () => {
    it("rejects checkCandidate when files is a Record (plain object)", () => {
      const result = checkCandidate({
        files: {
          "src/index.js": "const greeting = 'hello';\n",
        } as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects checkCandidate when files is an empty Record", () => {
      const result = checkCandidate({
        files: {} as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects checkCandidate when files is a Map", () => {
      const filesMap = new Map<string, string>();
      filesMap.set("src/index.js", "const greeting = 'hello';\n");

      const result = checkCandidate({
        files: filesMap as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects checkCandidate when files is an empty Map", () => {
      const result = checkCandidate({
        files: new Map() as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects gateJs when candidate files is a Record", () => {
      const result = gateJs({
        files: {
          "src/app.js": "const app = 1;\n",
        } as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects gateJs when candidate files is a Map", () => {
      const filesMap = new Map<string, string>();
      filesMap.set("src/app.js", "const app = 1;\n");

      const result = gateJs({
        files: filesMap as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects checkCandidate when files is a string", () => {
      const result = checkCandidate({
        files: "not-an-array" as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects checkCandidate when files is a number", () => {
      const result = checkCandidate({
        files: 42 as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects checkCandidate when files is a boolean", () => {
      const result = checkCandidate({
        files: true as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects checkCandidate when files is null", () => {
      const result = checkCandidate({
        files: null as any,
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });
  });

  describe("2. An entry without a path and an entry without a string content are rejected", () => {
    it("rejects when candidate.files entry lacks path property", () => {
      const result = checkCandidate({
        files: [
          { content: "const a = 1;\n" } as any,
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate array entry lacks path property", () => {
      const result = checkCandidate([
        { content: "const a = 1;\n" } as any,
      ]);

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate.files entry has non-string path", () => {
      const result = checkCandidate({
        files: [
          { path: 12345, content: "const a = 1;\n" } as any,
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate.files entry uses file property instead of path", () => {
      const result = checkCandidate({
        files: [
          { file: "src/helper.js", content: "const x = 1;\n" } as any,
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate array entry uses file property instead of path", () => {
      const result = checkCandidate([
        { file: "src/helper.js", content: "const x = 1;\n" } as any,
      ]);

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate.files entry lacks content property", () => {
      const result = checkCandidate({
        files: [
          { path: "src/unprovided.js" } as any,
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate array entry lacks content property", () => {
      const result = checkCandidate([
        { path: "src/unprovided.js" } as any,
      ]);

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate.files entry has non-string content (number)", () => {
      const result = checkCandidate({
        files: [
          { path: "src/num.js", content: 12345 as any },
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate.files entry has null content", () => {
      const result = checkCandidate({
        files: [
          { path: "src/null.js", content: null as any },
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate.files entry has boolean content", () => {
      const result = checkCandidate({
        files: [
          { path: "src/bool.js", content: true as any },
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate.files entry has object content", () => {
      const result = checkCandidate({
        files: [
          { path: "src/obj.js", content: { code: "const x = 1;" } as any },
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate array contains non-object item (string)", () => {
      const result = checkCandidate([
        "src/raw-string.js" as any,
      ]);

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate array contains null item", () => {
      const result = checkCandidate([
        null as any,
      ]);

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when candidate array contains nested array", () => {
      const result = checkCandidate([
        [{ path: "src/nested.js", content: "const n = 1;\n" }] as any,
      ]);

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when one entry is valid but another entry lacks path", () => {
      const result = checkCandidate({
        files: [
          { path: "src/good.js", content: "const a = 1;\n" },
          { content: "const b = 2;\n" } as any,
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });

    it("rejects when one entry is valid but another entry lacks content", () => {
      const result = checkCandidate({
        files: [
          { path: "src/good.js", content: "const a = 1;\n" },
          { path: "src/no-content.js" } as any,
        ],
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, [invalidFilesShapeReason]);
    });
  });

  describe("3. Content without a path in the object form is rejected", () => {
    it("returns ok false with reason 'missing path' when content is present without path", () => {
      const result = gateJs({
        content: "const greeting = 'hello';\n",
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, ["missing path"]);
    });

    it("returns ok false with reason 'missing path' when originalContent is present without path", () => {
      const result = gateJs({
        originalContent: "function test() { return 1; }\n",
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, ["missing path"]);
    });

    it("returns ok false with reason 'missing path' when source is present without path", () => {
      const result = gateJs({
        source: "const x = 100;\n",
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, ["missing path"]);
    });

    it("returns ok false with reason 'missing path' when originalSource is present without path", () => {
      const result = gateJs({
        originalSource: "let y = 200;\n",
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, ["missing path"]);
    });

    it("returns ok false with reason 'missing path' when path is empty string", () => {
      const result = gateJs({
        path: "",
        content: "const a = 1;\n",
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, ["missing path"]);
    });

    it("returns ok false with reason 'missing path' when filePath is empty string", () => {
      const result = gateJs({
        filePath: "   ",
        content: "const a = 1;\n",
      });

      assert.equal(result.ok, false);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, ["missing path"]);
    });

    it("does not default file name to file.js when path is omitted", () => {
      const result = gateJs({
        content: "const x = 1;\n",
      });

      assert.equal(result.ok, false);
      assert.notEqual(result.file, "file.js");
      assert.ok(!result.files.includes("file.js"));
      assert.deepEqual(result.reasons, ["missing path"]);
    });

    it("emits gate.result event with reason 'missing path' when eventStore option is passed", () => {
      const emittedEvents: any[] = [];
      const mockEventStore = {
        append: (input: any) => {
          emittedEvents.push(input);
          return input;
        },
      };

      const result = gateJs({
        content: "const x = 1;\n",
        eventStore: mockEventStore as any,
        runId: "run-missing-path",
      });

      assert.equal(result.ok, false);
      assert.equal(emittedEvents.length, 1);
      assert.equal(emittedEvents[0].kind, "gate.result");
      assert.equal(emittedEvents[0].data.ok, false);
      assert.deepEqual(emittedEvents[0].data.reasons, ["missing path"]);
    });

    it("calls emit callback with reason 'missing path' when emit option is passed", () => {
      const emitted: any[] = [];
      const result = gateJs({
        content: "const x = 1;\n",
        emit: (e: any) => emitted.push(e),
      });

      assert.equal(result.ok, false);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].ok, false);
      assert.deepEqual(emitted[0].reasons, ["missing path"]);
    });
  });

  describe("4. A valid array of {path, content} is accepted as before", () => {
    it("accepts checkCandidate with array of {path, content} directly", () => {
      const result = checkCandidate([
        {
          path: "src/valid.js",
          content: "const message = 'ok';\nfunction getMessage() { return message; }\n",
        },
      ]);

      assert.equal(result.ok, true);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/valid.js"));
    });

    it("accepts checkCandidate with candidate object having files array of {path, content}", () => {
      const result = checkCandidate({
        files: [
          {
            path: "src/service.js",
            content: "const run = () => true;\nmodule.exports = { run };\n",
          },
        ],
      });

      assert.equal(result.ok, true);
      assert.equal(result.gate, "syntax");
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/service.js"));
    });

    it("accepts checkCandidate with multiple valid file objects", () => {
      const result = checkCandidate({
        files: [
          { path: "src/first.js", content: "const a = 1;\n" },
          { path: "src/second.js", content: "const b = 2;\n" },
          { path: "src/third.js", content: "const c = 3;\n" },
        ],
      });

      assert.equal(result.ok, true);
      assert.equal(result.files.length, 3);
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/first.js"));
      assert.ok(result.files.includes("src/second.js"));
      assert.ok(result.files.includes("src/third.js"));
    });

    it("accepts gateJs called with array of {path, content}", () => {
      const result = gateJs([
        {
          path: "lib/core.js",
          content: "module.exports = { name: 'core' };\n",
        },
      ]);

      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("lib/core.js"));
    });

    it("accepts gateJs single-file object form when filePath and content are given", () => {
      const result = gateJs({
        filePath: "src/single.js",
        content: "const ready = true;\n",
      });

      assert.equal(result.ok, true);
      assert.equal(result.file, "src/single.js");
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/single.js"));
    });

    it("accepts gateJs single-file object form when file and content are given", () => {
      const result = gateJs({
        file: "src/single-file.js",
        content: "const status = 200;\n",
      });

      assert.equal(result.ok, true);
      assert.equal(result.file, "src/single-file.js");
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/single-file.js"));
    });

    it("accepts gateJs single-file object form when path and content are given", () => {
      const result = gateJs({
        path: "src/single-path.js",
        content: "const version = '2.0.0';\n",
      });

      assert.equal(result.ok, true);
      assert.equal(result.file, "src/single-path.js");
      assert.deepEqual(result.reasons, []);
      assert.ok(result.files.includes("src/single-path.js"));
    });

    it("accepts checkCandidate with empty files array when candidate is stated empty", () => {
      const result = checkCandidate({
        files: [],
        empty: true,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, []);
    });
  });
});
