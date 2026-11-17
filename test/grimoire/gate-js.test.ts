import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Diff from "diff";
import requestCompat from "../../lib/grimoire/request-compat.cjs";

const { UnsupportedOption } = requestCompat as any;
import {
  gateJs,
  checkCandidate,
  resolveOriginalParseMode,
  resolvePatchedParseMode,
  resolveParseMode,
  tryParseJsOrTs,
  isZeroAcceptedEditsStep,
  applyStepsToFile,
  emitGateResultEvent,
  type PatchStep,
  type GateResult,
} from "../../lib/grimoire/gate-js";

function createMockResponse(options: { status?: number; text?: string } = {}) {
  const status = options.status ?? 200;
  const bodyText = options.text ?? "";
  return {
    status,
    text: async () => bodyText,
  };
}

async function withInjectedFetch<T>(
  mockFetch: (url: string | URL | Request, init?: RequestInit) => Promise<any>,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as any;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function invokeRequestCompat(
  options: Record<string, unknown>
): Promise<{ err: any; res: any; body: any }> {
  return new Promise((resolve) => {
    requestCompat(options, (err: any, res: any, body: any) => {
      resolve({ err, res, body });
    });
  });
}

describe("grimoire/gate-js: request-compat and gateJs verification", () => {
  describe("request-compat adapter unit tests (Task 5.7 bullet 1, Req 7.11-7.14)", () => {
    it("calls callback exactly once on successful response", async () => {
      let callCount = 0;
      await withInjectedFetch(
        async () => createMockResponse({ status: 200, text: "payload" }),
        async () => {
          await new Promise<void>((resolve, reject) => {
            requestCompat({ url: "/resource" }, (err: any, res: any, body: any) => {
              callCount++;
              try {
                assert.equal(err, null);
                assert.equal(res.statusCode, 200);
                assert.equal(body, "payload");
              } catch (e) {
                reject(e);
                return;
              }
              setTimeout(() => {
                try {
                  assert.equal(callCount, 1);
                  resolve();
                } catch (e) {
                  reject(e);
                }
              }, 15);
            });
          });
        }
      );
    });

    it("propagates statusCode and sets err = null on 4xx and 5xx responses", async () => {
      const errorStatuses = [400, 401, 403, 404, 500, 502, 503];

      for (const status of errorStatuses) {
        await withInjectedFetch(
          async () => createMockResponse({ status, text: `error-${status}` }),
          async () => {
            const { err, res, body } = await invokeRequestCompat({ url: `/err-${status}` });
            assert.equal(err, null, `Expected err = null for HTTP ${status}`);
            assert.equal(res.statusCode, status);
            assert.equal(res.status, status);
            assert.equal(body, `error-${status}`);
          }
        );
      }
    });

    it("parses JSON when json is true and passes raw text when JSON parsing fails", async () => {
      // Valid JSON
      await withInjectedFetch(
        async () => createMockResponse({ status: 200, text: '{"key":"value"}' }),
        async () => {
          const { err, body } = await invokeRequestCompat({ url: "/valid-json", json: true });
          assert.equal(err, null);
          assert.deepEqual(body, { key: "value" });
        }
      );

      // Invalid JSON
      await withInjectedFetch(
        async () => createMockResponse({ status: 500, text: "Internal Error" }),
        async () => {
          const { err, body } = await invokeRequestCompat({ url: "/invalid-json", json: true });
          assert.equal(err, null);
          assert.equal(body, "Internal Error");
        }
      );
    });

    it("handles network error and calls callback with error and null response", async () => {
      const networkError = new Error("Socket closed prematurely");
      await withInjectedFetch(
        async () => {
          throw networkError;
        },
        async () => {
          const { err, res, body } = await invokeRequestCompat({ url: "/fail" });
          assert.equal(err, networkError);
          assert.equal(res, null);
          assert.equal(body, null);
        }
      );
    });

    it("throws UnsupportedOption synchronously when unsupported options are passed", () => {
      assert.throws(
        () => {
          requestCompat({ url: "/test", cert: "dummy-cert" }, () => {});
        },
        (err: any) => {
          assert(err instanceof UnsupportedOption);
          assert.equal(err.name, "UnsupportedOption");
          assert.equal(err.key, "cert");
          return true;
        }
      );
    });
  });

  describe("gate-js parsing modes (Requirement 9.5, 9.7)", () => {
    it("resolves original mode as module for .mjs files", () => {
      assert.equal(resolveOriginalParseMode("src/index.mjs"), "module");
      assert.equal(resolveOriginalParseMode("tools/cli.MJS"), "module");
    });

    it("resolves original mode as module when package.json contains type: 'module'", () => {
      const esmPkg = { type: "module" };
      assert.equal(resolveOriginalParseMode("src/index.js", esmPkg), "module");
      assert.equal(resolveOriginalParseMode("app.js", JSON.stringify(esmPkg)), "module");
    });

    it("resolves original mode as script when package.json is CommonJS or absent", () => {
      assert.equal(resolveOriginalParseMode("src/index.js", {}), "script");
      assert.equal(resolveOriginalParseMode("index.js", undefined), "script");
      assert.equal(resolveOriginalParseMode("lib/util.js", { name: "my-pkg" }), "script");
    });

    it("resolves patched mode as module when file has an unreverted M3 step (Requirement 9.7)", () => {
      const stepM3: PatchStep = {
        id: "step-m3",
        ruleId: "M3",
        file: "src/app.js",
        reverted: false,
      };

      assert.equal(resolvePatchedParseMode("src/app.js", [stepM3], {}), "module");
    });

    it("resolves patched mode in original mode when M3 step is reverted", () => {
      const stepM3Reverted: PatchStep = {
        id: "step-m3-rev",
        ruleId: "M3",
        file: "src/app.js",
        reverted: true,
        revertReason: "parse_failed",
      };

      // In CommonJS package, reverts to script mode
      assert.equal(resolvePatchedParseMode("src/app.js", [stepM3Reverted], {}), "script");
    });

    it("resolves patched mode in original mode when step is non-M3 rule (e.g. M2)", () => {
      const stepM2: PatchStep = {
        id: "step-m2",
        ruleId: "M2",
        file: "src/app.js",
        reverted: false,
      };

      assert.equal(resolvePatchedParseMode("src/app.js", [stepM2], {}), "script");
    });

    it("supports resolveParseMode helper function", () => {
      assert.equal(resolveParseMode("main.mjs"), "module");
      assert.equal(resolveParseMode("main.js", {}), "script");
    });
  });

  describe("Syntax parsing with tryParseJsOrTs across modes and extensions", () => {
    it("parses valid script and module syntax correctly", () => {
      const scriptCode = "const x = 1;\n";
      const resScript = tryParseJsOrTs(scriptCode, "test.js", "script");
      assert.equal(resScript.ok, true);

      const moduleCode = "import fs from 'node:fs';\nexport const a = 1;\n";
      const resModule = tryParseJsOrTs(moduleCode, "test.mjs", "module");
      assert.equal(resModule.ok, true);
    });

    it("parses TypeScript and JSX syntax", () => {
      const tsCode = "interface User { id: number; name: string; }\nconst u: User = { id: 1, name: 'Alice' };\n";
      const resTs = tryParseJsOrTs(tsCode, "user.ts", "module");
      assert.equal(resTs.ok, true);

      const tsxCode = "export const App = () => <div>Hello World</div>;\n";
      const resTsx = tryParseJsOrTs(tsxCode, "App.tsx", "module");
      assert.equal(resTsx.ok, true);
    });

    it("returns ok: false with error on invalid syntax", () => {
      const invalidCode = "function broken( { let = ;";
      const res = tryParseJsOrTs(invalidCode, "broken.js", "script");
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert(res.error instanceof Error);
      }
    });
  });

  describe("Zero accepted edits marking (Requirement 9.4)", () => {
    it("marks steps with zero accepted edits as reverted with all_edits_rejected", () => {
      const zeroAcceptedStep: PatchStep = {
        id: "step-zero",
        ruleId: "M2",
        file: "src/test.js",
        acceptedEdits: 0,
        reverted: false,
      };

      assert.equal(isZeroAcceptedEditsStep(zeroAcceptedStep), true);

      const origContent = "const a = 1;\n";
      const result = gateJs("src/test.js", origContent, [zeroAcceptedStep]);

      assert.equal(result.ok, true);
      assert(result.steps);
      assert.equal(result.steps[0].reverted, true);
      assert.equal(result.steps[0].revertReason, "all_edits_rejected");
    });

    it("marks steps with empty edits array as reverted with all_edits_rejected", () => {
      const emptyEditsStep: PatchStep = {
        id: "step-empty",
        ruleId: "M2",
        file: "src/test.js",
        edits: [],
        reverted: false,
      };

      assert.equal(isZeroAcceptedEditsStep(emptyEditsStep), true);
    });
  });

  describe("Original unparseable handling (Requirement 9.6)", () => {
    it("leaves original file unchanged and records original_unparseable when original fails to parse", () => {
      const badOriginal = "function syntaxError( {";
      const result = gateJs("src/bad.js", badOriginal, []);

      assert.equal(result.ok, false);
      assert.equal(result.code, badOriginal);
      assert.equal(result.reasons.length, 1);
      assert(result.reasons[0].includes("original_unparseable"));
      assert(result.unknowns);
      assert.equal(result.unknowns.length, 1);
      assert.equal(result.unknowns[0].reason, "original_unparseable");
      assert.equal(result.unknowns[0].file, "src/bad.js");
    });
  });

  describe("Iterative step rollback on parse failure (Requirement 9.7, 9.8)", () => {
    it("accepts all patch steps when patched syntax is valid", () => {
      const orig = "const a = 1;\n";
      const patch = Diff.createPatch("file.js", orig, "const a = 2;\n", "", "");
      const step: PatchStep = {
        id: "step-valid",
        ruleId: "M2",
        file: "file.js",
        diff: patch,
        reverted: false,
      };

      const result = gateJs("file.js", orig, [step]);
      assert.equal(result.ok, true);
      assert(result.code);
      assert.equal(result.code.trim(), "const a = 2;");
      assert.equal(result.revertedSteps?.length, 0);
      assert.equal(result.steps?.[0].reverted, false);
    });

    it("reverts failing step with parse_failed and restores previous valid syntax", () => {
      const orig = "const a = 1;\n";
      const badPatch = Diff.createPatch("file.js", orig, "const a = 1;\nfunction bad( {\n", "", "");
      const stepBad: PatchStep = {
        id: "step-bad",
        ruleId: "M2",
        file: "file.js",
        diff: badPatch,
        reverted: false,
      };

      const result = gateJs("file.js", orig, [stepBad]);
      assert.equal(result.ok, true);
      assert(result.code);
      assert.equal(result.code.trim(), "const a = 1;");
      assert.equal(result.steps?.[0].reverted, true);
      assert.equal(result.steps?.[0].revertReason, "parse_failed");
      assert.equal(result.revertedSteps?.length, 1);
    });

    it("iteratively rolls back last unreverted step in reverse order until valid", () => {
      const orig = "const x = 1;\n";
      const patch1 = Diff.createPatch("file.js", orig, "const x = 2;\n", "", "");
      const patch2 = Diff.createPatch("file.js", "const x = 2;\n", "const x = 2;\nconst y = 3;\n", "", "");
      const patch3Bad = Diff.createPatch("file.js", "const x = 2;\nconst y = 3;\n", "const x = 2;\nconst y = 3;\nerr {{{", "", "");

      const step1: PatchStep = { id: "s1", ruleId: "M2", file: "file.js", diff: patch1, reverted: false };
      const step2: PatchStep = { id: "s2", ruleId: "M2", file: "file.js", diff: patch2, reverted: false };
      const step3Bad: PatchStep = { id: "s3-bad", ruleId: "M2", file: "file.js", diff: patch3Bad, reverted: false };

      const result = gateJs("file.js", orig, [step1, step2, step3Bad]);
      assert.equal(result.ok, true);
      assert(result.code);
      assert(result.code.includes("const x = 2;"));
      assert(result.code.includes("const y = 3;"));
      assert(!result.code.includes("err {{{"));

      assert.equal(result.steps?.[0].reverted, false);
      assert.equal(result.steps?.[1].reverted, false);
      assert.equal(result.steps?.[2].reverted, true);
      assert.equal(result.steps?.[2].revertReason, "parse_failed");
    });

    it("rolls back multiple consecutive failing steps until valid", () => {
      const orig = "const x = 1;\n";
      const patch1 = Diff.createPatch("file.js", orig, "const x = 100;\n", "", "");
      const patch2Bad = Diff.createPatch("file.js", "const x = 100;\n", "bad syntax 1 {{{", "", "");
      const patch3Bad = Diff.createPatch("file.js", "bad syntax 1 {{{", "bad syntax 2 }}}", "", "");

      const step1: PatchStep = { id: "s1", ruleId: "M2", file: "file.js", diff: patch1, reverted: false };
      const step2: PatchStep = { id: "s2-bad", ruleId: "M2", file: "file.js", diff: patch2Bad, reverted: false };
      const step3: PatchStep = { id: "s3-bad", ruleId: "M2", file: "file.js", diff: patch3Bad, reverted: false };

      const result = gateJs("file.js", orig, [step1, step2, step3]);
      assert.equal(result.ok, true);
      assert(result.code);
      assert.equal(result.code.trim(), "const x = 100;");

      assert.equal(result.steps?.[0].reverted, false);
      assert.equal(result.steps?.[1].reverted, true);
      assert.equal(result.steps?.[1].revertReason, "parse_failed");
      assert.equal(result.steps?.[2].reverted, true);
      assert.equal(result.steps?.[2].revertReason, "parse_failed");
    });
  });

  describe("Candidate gate verification and gate.result event emission (Requirement 9.9, 9.11-9.13)", () => {
    it("verifies all changed JS and TS files parse successfully in Candidate", () => {
      const candidate = {
        packageJson: { type: "module" },
        files: [
          { path: "src/index.js", content: "const greeting = 'hello';\n" },
          { path: "src/utils.ts", content: "export function add(a: number, b: number): number { return a + b; }\n" },
          { path: "README.md", content: "# Readme\n" }, // non-JS/TS file ignored
        ],
        changedFiles: ["src/index.js", "src/utils.ts", "README.md"],
      };

      const result = checkCandidate(candidate);
      assert.equal(result.ok, true);
      assert.equal(result.files.length, 2);
      assert(result.files.includes("src/index.js"));
      assert(result.files.includes("src/utils.ts"));
      assert(!result.files.includes("README.md"));
      assert.equal(result.reasons.length, 0);
      assert.equal(result.gate, "syntax");
      assert.equal(result.kind, "gate.result");
    });

    it("returns reasons when any changed file in Candidate fails syntax check", () => {
      const candidate = {
        files: [
          { path: "src/ok.js", content: "const a = 1;\n" },
          { path: "src/broken.js", content: "function missingParens { let x = 1; }\n" },
        ],
        changedFiles: ["src/ok.js", "src/broken.js"],
      };

      const result = checkCandidate(candidate);
      assert.equal(result.ok, false);
      assert.equal(result.reasons.length, 1);
      assert(result.reasons[0].includes("src/broken.js"));
      assert.equal(result.details?.["src/broken.js"]?.ok, false);
      assert.equal(result.details?.["src/ok.js"]?.ok, true);
    });

    it("emits gate.result event into EventStore (Requirement 9.11)", () => {
      const emittedEvents: any[] = [];
      const mockEventStore = {
        append: (input: any) => {
          const envelope = {
            runId: input.runId,
            seq: emittedEvents.length + 1,
            ts: Date.now(),
            kind: input.kind,
            actor: input.actor,
            data: input.data,
            taskId: input.taskId,
          };
          emittedEvents.push(envelope);
          return envelope;
        },
      };

      const candidate = {
        files: [
          { path: "src/app.js", content: "const valid = true;\n" },
        ],
      };

      const result = checkCandidate(candidate, {
        eventStore: mockEventStore as any,
        runId: "run-gate-test",
        taskId: "task-verify",
      });

      assert.equal(result.ok, true);
      assert.equal(emittedEvents.length, 1);

      const event = emittedEvents[0];
      assert.equal(event.kind, "gate.result");
      assert.equal(event.actor, "Grimoire_Gate");
      assert.equal(event.runId, "run-gate-test");
      assert.equal(event.taskId, "task-verify");
      assert.equal(event.data.gate, "syntax");
      assert.equal(event.data.ok, true);
      assert.deepEqual(event.data.files, ["src/app.js"]);
      assert.deepEqual(event.data.reasons, []);
    });

    it("supports emit callback option when EventStore is not used", () => {
      const emitted: any[] = [];
      const candidate = {
        files: [{ path: "app.js", content: "const x = 1;\n" }],
      };

      checkCandidate(candidate, {
        emit: (ev: any) => emitted.push(ev),
      });

      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].kind, "gate.result");
      assert.equal(emitted[0].ok, true);
    });

    it("supports emitGateResultEvent helper directly", () => {
      const appended: any[] = [];
      const store = { append: (ev: any) => { appended.push(ev); return ev; } };
      const gateResult: GateResult = {
        ok: true,
        files: ["test.js"],
        reasons: [],
        gate: "syntax",
        kind: "gate.result",
      };

      emitGateResultEvent(store as any, gateResult, {
        runId: "run-direct",
        actor: "Grimoire_Gate",
      });

      assert.equal(appended.length, 1);
      assert.equal(appended[0].kind, "gate.result");
      assert.equal(appended[0].data.ok, true);
    });
  });

  describe("F11 Grimoire JS gate enhancements (Work package F11)", () => {
    describe("Rule 1: Empty content fails gate without parsing empty string", () => {
      it("fails with ok: false when changed JS file content is not supplied", () => {
        const candidate = {
          changedFiles: ["src/missing.js"],
          files: [],
        };

        const result = checkCandidate(candidate);
        assert.equal(result.ok, false);
        assert.equal(result.files.length, 1);
        assert.equal(result.files[0], "src/missing.js");
        assert.equal(result.reasons.length, 1);
        assert(result.reasons[0].includes("content not supplied"));
        assert.equal(result.details?.["src/missing.js"]?.ok, false);
      });

      it("fails with ok: false when file has empty string content", () => {
        const candidate = {
          files: [
            { path: "src/empty.ts", content: "" },
          ],
          changedFiles: ["src/empty.ts"],
        };

        const result = checkCandidate(candidate);
        assert.equal(result.ok, false);
        assert.equal(result.reasons.length, 1);
        assert(result.reasons[0].includes("content not supplied"));
        assert.equal(result.details?.["src/empty.ts"]?.ok, false);
      });

      it("fails with ok: false when candidate diff mentions a JS file but no content is supplied", () => {
        const diffText = [
          "diff --git a/lib/feature.js b/lib/feature.js",
          "index 0000000..1111111 100644",
          "--- a/lib/feature.js",
          "+++ b/lib/feature.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n");

        const candidate = {
          diff: diffText,
        };

        const result = checkCandidate(candidate);
        assert.equal(result.ok, false);
        assert(result.files.includes("lib/feature.js"));
        assert.equal(result.reasons.length, 1);
        assert(result.reasons[0].includes("lib/feature.js"));
        assert(result.reasons[0].includes("content not supplied"));
      });

      it("fails with ok: false when files array item has no content property", () => {
        const candidate = {
          files: [{ path: "src/unprovided.js" } as any],
        };

        const result = checkCandidate(candidate);
        assert.equal(result.ok, false);
        assert.equal(result.gate, "syntax");
        assert(result.reasons.some((r) => r.includes("invalid files shape: expected array of {path, content}")));
      });
    });

    describe("Rule 2: Unknown arguments return ok: false", () => {
      it("returns ok: false for null argument", () => {
        const result = gateJs(null as any);
        assert.equal(result.ok, false);
        assert.equal(result.gate, "syntax");
        assert.equal(result.kind, "gate.result");
        assert.deepEqual(result.files, []);
        assert.deepEqual(result.reasons, ["unknown argument"]);
      });

      it("returns ok: false for undefined argument", () => {
        const result = gateJs(undefined as any);
        assert.equal(result.ok, false);
        assert.equal(result.gate, "syntax");
        assert.equal(result.kind, "gate.result");
        assert.deepEqual(result.reasons, ["unknown argument"]);
      });

      it("returns ok: false for numeric argument", () => {
        const result = gateJs(42 as any);
        assert.equal(result.ok, false);
        assert.deepEqual(result.reasons, ["unknown argument"]);
      });

      it("returns ok: false for boolean argument", () => {
        const result = gateJs(true as any);
        assert.equal(result.ok, false);
        assert.deepEqual(result.reasons, ["unknown argument"]);
      });
    });

    describe("Rule 3: Empty candidate passes only when caller states candidate is empty", () => {
      it("fails with ok: false when candidate has no changed files and caller does not state empty", () => {
        const result1 = checkCandidate({});
        assert.equal(result1.ok, false);
        assert(result1.reasons.some((r) => r.includes("no changed files")));

        const result2 = checkCandidate({ changedFiles: [] });
        assert.equal(result2.ok, false);
        assert(result2.reasons.some((r) => r.includes("no changed files")));

        const result3 = gateJs({});
        assert.equal(result3.ok, false);
      });

      it("passes with ok: true when caller explicitly states candidate is empty", () => {
        const resultWithEmptyOption = checkCandidate({}, { empty: true });
        assert.equal(resultWithEmptyOption.ok, true);
        assert.deepEqual(resultWithEmptyOption.reasons, []);

        const resultWithCandidateEmpty = checkCandidate({ empty: true, changedFiles: [] });
        assert.equal(resultWithCandidateEmpty.ok, true);
        assert.deepEqual(resultWithCandidateEmpty.reasons, []);

        const resultWithAllowEmpty = checkCandidate({}, { allowEmpty: true });
        assert.equal(resultWithAllowEmpty.ok, true);

        const resultWithIsEmpty = checkCandidate({ isEmpty: true });
        assert.equal(resultWithIsEmpty.ok, true);
      });
    });

    describe("Rule 4: Tree on the gate.result event", () => {
      it("includes candidate tree next to refs, gate, ok, files and reasons in EventStore event", () => {
        const emittedEvents: any[] = [];
        const mockStore = {
          append: (input: any) => {
            emittedEvents.push(input);
            return input;
          },
        };

        const candidate = {
          tree: "tree-sha-deadbeef1234",
          files: [
            { path: "src/valid.js", content: "const ok = true;\n" },
          ],
        };

        const result = checkCandidate(candidate, {
          eventStore: mockStore as any,
          runId: "run-tree-test",
          refs: ["file:src/valid.js" as any],
        });

        assert.equal(result.ok, true);
        assert.equal(emittedEvents.length, 1);
        const ev = emittedEvents[0];
        assert.equal(ev.kind, "gate.result");
        assert.equal(ev.data.gate, "syntax");
        assert.equal(ev.data.ok, true);
        assert.deepEqual(ev.data.files, ["src/valid.js"]);
        assert.deepEqual(ev.data.reasons, []);
        assert.deepEqual(ev.data.refs, ["file:src/valid.js"]);
        assert.equal(ev.data.tree, "tree-sha-deadbeef1234");
      });

      it("includes tree on result object and in emit callback", () => {
        const emitted: any[] = [];
        const candidate = {
          files: [{ path: "index.js", content: "const val = 10;\n" }],
        };

        const result = checkCandidate(candidate, {
          tree: "tree-from-options-5678",
          emit: (e: any) => emitted.push(e),
        });

        assert.equal(result.ok, true);
        assert.equal(result.tree, "tree-from-options-5678");
        assert.equal(emitted.length, 1);
        assert.equal(emitted[0].tree, "tree-from-options-5678");
        assert.equal(emitted[0].gate, "syntax");
        assert.equal(emitted[0].ok, true);
      });

      it("includes tree in emitGateResultEvent helper directly", () => {
        const appended: any[] = [];
        const store = { append: (ev: any) => { appended.push(ev); return ev; } };
        const gateResult: GateResult = {
          ok: true,
          files: ["test.js"],
          reasons: [],
          gate: "syntax",
          kind: "gate.result",
          tree: "tree-sha-direct",
        };

        emitGateResultEvent(store as any, gateResult);

        assert.equal(appended.length, 1);
        assert.equal(appended[0].data.tree, "tree-sha-direct");
      });
    });

    describe("Rule 5: Python fails closed with PYTHON_GATE_NOT_IN_V1", () => {
      it("fails closed when candidate changes any .py file", () => {
        const candidate = {
          files: [
            { path: "main.py", content: "print('hello world')" },
          ],
        };

        const result = checkCandidate(candidate);
        assert.equal(result.ok, false);
        assert.deepEqual(result.reasons, ["PYTHON_GATE_NOT_IN_V1"]);
        assert.equal(result.details?.["main.py"]?.ok, false);
        assert.equal(result.details?.["main.py"]?.error, "PYTHON_GATE_NOT_IN_V1");
      });

      it("fails closed before JS parsing when candidate contains both JS and Python changes", () => {
        const candidate = {
          files: [
            { path: "invalid.js", content: "const broken syntax = ;;;" },
            { path: "app.py", content: "x = 1" },
          ],
          changedFiles: ["invalid.js", "app.py"],
        };

        const result = checkCandidate(candidate);
        assert.equal(result.ok, false);
        assert.deepEqual(result.reasons, ["PYTHON_GATE_NOT_IN_V1"]);
        // Does not reach JS parsing, reasons does not include JS syntax error
        assert(!result.reasons.some((r) => r.includes("invalid.js")));
      });

      it("fails closed in positional single-file gateJs for Python files", () => {
        const result = gateJs("module.py", "def fn(): pass");
        assert.equal(result.ok, false);
        assert.equal(result.file, "module.py");
        assert.deepEqual(result.reasons, ["PYTHON_GATE_NOT_IN_V1"]);
        assert.equal(result.details?.["module.py"]?.ok, false);
      });

      it("fails closed in options single-file gateJs for Python files", () => {
        const result = gateJs({ filePath: "tools/script.py", originalContent: "x = 1" });
        assert.equal(result.ok, false);
        assert.equal(result.file, "tools/script.py");
        assert.deepEqual(result.reasons, ["PYTHON_GATE_NOT_IN_V1"]);
      });

      it("emits gate.result event with ok: false, PYTHON_GATE_NOT_IN_V1, and candidate tree", () => {
        const emittedEvents: any[] = [];
        const mockStore = {
          append: (input: any) => {
            emittedEvents.push(input);
            return input;
          },
        };

        const candidate = {
          tree: "tree-python-candidate",
          changedFiles: ["worker.py"],
          files: [
            { path: "worker.py", content: "pass" },
          ],
        };

        const result = checkCandidate(candidate, {
          eventStore: mockStore as any,
          runId: "run-py-test",
        });

        assert.equal(result.ok, false);
        assert.equal(emittedEvents.length, 1);
        const ev = emittedEvents[0];
        assert.equal(ev.data.ok, false);
        assert.deepEqual(ev.data.reasons, ["PYTHON_GATE_NOT_IN_V1"]);
        assert.equal(ev.data.tree, "tree-python-candidate");
      });
    });
  });
});
