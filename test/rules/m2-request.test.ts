import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  transformM2Request,
  scanM2Imports,
  scanCallSites,
  isEligibleCallSite,
  ALLOWED_KEYS,
  ALLOWED_VERBS,
} from "../../lib/rules/m2-request";

describe("rules/m2-request: transformM2Request", () => {
  describe("Eligible call site transformation (Requirement 7.1, 7.5, 7.6)", () => {
    it("rewrites CommonJS require('request') to request-compat adapter", () => {
      const source = [
        "const request = require('request');",
        "request({ url: '/api/data' }, (err, res, body) => {",
        "  console.log(body);",
        "});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "src/worker.js" });

      assert.equal(result.changed, true);
      assert.equal(result.eligible, true);
      assert.equal(result.unknowns.length, 0);
      assert.equal(result.plannedEdits.length, 1);
      assert(result.code.includes("require('../request-compat.cjs')"));
      assert(!result.code.includes("require('request')"));

      assert(result.step);
      assert.equal(result.step.ruleId, "M2");
      assert.equal(result.step.compat, true);
      assert.equal(result.step.behavior, "unknown");
      assert.equal(result.step.confidence, "high");
      assert.equal(result.step.reverted, false);
      assert(result.step.hunks > 0);
    });

    it("rewrites ESM import request from 'request'", () => {
      const source = [
        "import request from 'request';",
        "request.get({ url: '/status' }, (err, res) => {",
        "  console.log(res.statusCode);",
        "});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "index.mjs" });

      assert.equal(result.changed, true);
      assert.equal(result.eligible, true);
      assert.equal(result.unknowns.length, 0);
      assert(result.code.includes("import request from './request-compat.cjs'"));
      assert(result.step);
      assert.equal(result.step.compat, true);
    });

    it("supports all eligible HTTP verb methods: get, post, put, patch, del, head", () => {
      assert.deepEqual(ALLOWED_VERBS, [
        "get",
        "post",
        "put",
        "patch",
        "del",
        "head",
      ]);

      for (const verb of ALLOWED_VERBS) {
        const source = [
          "const request = require('request');",
          `request.${verb}({ url: '/items' }, (err, res) => {});`,
        ].join("\n");

        const result = transformM2Request(source, { filePath: "client.js" });
        assert.equal(
          result.changed,
          true,
          `Expected request.${verb} to be transformed`
        );
        assert.equal(
          result.eligible,
          true,
          `Expected request.${verb} to be eligible`
        );
        assert.equal(result.unknowns.length, 0);
      }
    });

    it("allows void operator preceding eligible call site in expression statement", () => {
      const source = [
        "const request = require('request');",
        "void request({ url: '/ping' }, (err) => {});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "ping.js" });
      assert.equal(result.changed, true);
      assert.equal(result.eligible, true);
      assert.equal(result.unknowns.length, 0);
    });
  });

  describe("Call site ineligibility checks (Requirement 7.4, 7.5, 7.6)", () => {
    it("flags call site when return value is assigned to a variable", () => {
      const source = [
        "const request = require('request');",
        "const req = request({ url: '/stream' }, (err, res) => {});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "stream.js" });
      assert.equal(result.changed, false);
      assert.equal(result.eligible, false);
      assert(result.unknowns.length > 0);
      assert(
        result.unknowns.some((u) => u.reason === "request_unsupported_call")
      );
      assert.equal(result.code, source);
    });

    it("flags call site when return value is returned from a function", () => {
      const source = [
        "const request = require('request');",
        "function makeCall() {",
        "  return request({ url: '/test' }, (err) => {});",
        "}",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "call.js" });
      assert.equal(result.changed, false);
      assert.equal(result.eligible, false);
      assert(
        result.unknowns.some((u) => u.reason === "request_unsupported_call")
      );
    });

    it("flags call site when callback argument is omitted", () => {
      const source = [
        "const request = require('request');",
        "request({ url: '/no-cb' });",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "nocb.js" });
      assert.equal(result.changed, false);
      assert.equal(result.eligible, false);
      assert(
        result.unknowns.some((u) => u.reason === "request_unsupported_call")
      );
    });

    it("flags call site when options argument contains unsupported key", () => {
      const source = [
        "const request = require('request');",
        "request({ url: '/test', proxy: 'socks5://localhost' }, (err, res) => {});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "proxy.js" });
      assert.equal(result.changed, false);
      assert.equal(result.eligible, false);
      assert(
        result.unknowns.some((u) => u.reason === "request_unsupported_call")
      );
    });

    it("flags call site when options argument is not an object literal", () => {
      const source = [
        "const request = require('request');",
        "const myOpts = { url: '/test' };",
        "request(myOpts, (err, res) => {});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "opts.js" });
      assert.equal(result.changed, false);
      assert.equal(result.eligible, false);
      assert(
        result.unknowns.some((u) => u.reason === "request_unsupported_call")
      );
    });

    it("flags unsupported methods on request object like cookie, jar, defaults", () => {
      const unsupportedMethods = ["cookie", "jar", "defaults", "forever", "initParams"];

      for (const meth of unsupportedMethods) {
        const source = [
          "const request = require('request');",
          `request.${meth}('/test', (err) => {});`,
        ].join("\n");

        const result = transformM2Request(source, { filePath: "meth.js" });
        assert.equal(result.changed, false);
        assert.equal(result.eligible, false);
        assert(
          result.unknowns.some((u) => u.reason === "request_unsupported_call"),
          `Expected request.${meth} to produce request_unsupported_call`
        );
      }
    });

    it("flags destructuring of request require or import", () => {
      const sourceRequire = [
        "const { get } = require('request');",
        "get({ url: '/test' }, (err, res) => {});",
      ].join("\n");

      const resRequire = transformM2Request(sourceRequire, { filePath: "destruct.js" });
      assert.equal(resRequire.changed, false);
      assert.equal(resRequire.eligible, false);
      assert(
        resRequire.unknowns.some((u) => u.reason === "request_unsupported_call")
      );

      const sourceImport = [
        "import { get } from 'request';",
        "get({ url: '/test' }, (err, res) => {});",
      ].join("\n");

      const resImport = transformM2Request(sourceImport, { filePath: "destruct.mjs" });
      assert.equal(resImport.changed, false);
      assert.equal(resImport.eligible, false);
      assert(
        resImport.unknowns.some((u) => u.reason === "request_unsupported_call")
      );
    });

    it("flags non-call usages of request binding", () => {
      const source = [
        "const request = require('request');",
        "function passAlong(fn) { fn(request); }",
        "request({ url: '/test' }, (err) => {});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "pass.js" });
      assert.equal(result.changed, false);
      assert.equal(result.eligible, false);
      assert(
        result.unknowns.some((u) => u.reason === "request_unsupported_call")
      );
    });
  });

  describe("request-promise unsupported packages (Requirement 7.2)", () => {
    const promisePackages = [
      "request-promise",
      "request-promise-native",
      "request-promise-any",
    ];

    for (const pkg of promisePackages) {
      it(`flags ${pkg} with reason request_promise_unsupported and does not edit`, () => {
        const source = [
          `const rp = require('${pkg}');`,
          "rp({ url: '/async' }).then((body) => console.log(body));",
        ].join("\n");

        const result = transformM2Request(source, { filePath: "promise.js" });
        assert.equal(result.changed, false);
        assert.equal(result.code, source);
        assert(
          result.unknowns.some((u) => u.reason === "request_promise_unsupported")
        );
      });
    }
  });

  describe("Syntax error resilience (Requirement 7.16)", () => {
    it("handles unparseable JavaScript and records original_unparseable", () => {
      const badSource = "function invalidSyntax( { let 123 = ;";
      const result = transformM2Request(badSource, { filePath: "bad.js" });

      assert.equal(result.changed, false);
      assert.equal(result.code, badSource);
      assert.equal(result.unknowns.length, 1);
      assert.equal(result.unknowns[0].ruleId, "M2");
      assert.equal(result.unknowns[0].reason, "original_unparseable");
      assert.equal(result.unknowns[0].file, "bad.js");
      assert(typeof result.unknowns[0].line === "number");
    });
  });

  describe("Variable shadowing in inner scopes", () => {
    it("ignores local variable named request shadowing the module import", () => {
      const source = [
        "const request = require('request');",
        "function localScope() {",
        "  const request = () => 123;",
        "  const x = request();", // inner request call should not invalidate outer
        "}",
        "request({ url: '/test' }, (err) => {});",
      ].join("\n");

      const result = transformM2Request(source, { filePath: "scope.js" });
      assert.equal(result.changed, true);
      assert.equal(result.eligible, true);
      assert.equal(result.unknowns.length, 0);
    });
  });

  describe("Helper query functions: scanM2Imports, scanCallSites, isEligibleCallSite", () => {
    it("scans tagged imports with scanM2Imports", () => {
      const source = [
        "const r1 = require('request');",
        "const r2 = require('request-promise');",
      ].join("\n");

      const tags = scanM2Imports(source, { filePath: "tags.js" });
      assert.equal(tags.length, 2);
      assert.equal(tags[0].name, "request");
      assert.equal(tags[0].isPromise, false);
      assert.equal(tags[1].name, "request-promise");
      assert.equal(tags[1].isPromise, true);
    });

    it("scans call sites and returns call site diagnostics", () => {
      const source = [
        "const request = require('request');",
        "request.get({ url: '/api' }, (err) => {});",
      ].join("\n");

      const { callSites, unknowns } = scanCallSites(source, { filePath: "sites.js" });
      assert.equal(callSites.length, 1);
      assert.equal(callSites[0].callee, "request.get");
      assert.equal(callSites[0].verb, "get");
      assert.equal(callSites[0].eligible, true);
      assert.equal(unknowns.length, 0);
    });

    it("evaluates call site eligibility with isEligibleCallSite helper", () => {
      const valid = "const request = require('request'); request({ url: '/ok' }, cb);";
      assert.equal(isEligibleCallSite(valid, valid), true);

      const invalid = "const request = require('request'); const x = request({ url: '/bad' }, cb);";
      assert.equal(isEligibleCallSite(invalid, invalid), false);
    });
  });
});
