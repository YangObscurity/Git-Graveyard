import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPackage,
  classifyPackageJson,
  getPackageKind,
  classifyPackageKind,
  isApplication,
  isLibrary,
  isMonorepo,
  isEsm,
  inspectFileForM3,
  convertCommonJsToEsm,
  findCommonsChunkPlugin,
  getM4Guidance,
  lookupStableViteVersion,
  getStableViteVersion,
} from "../../lib/rules/m3-m4-guidance";

describe("rules/m3-m4-guidance: Package classifier and guidance rules", () => {
  describe("Package classification truth table (Requirement 8.1, 8.2)", () => {
    it("1. classifies as already ESM when type is module", () => {
      const pkg = { type: "module", name: "esm-pkg" };
      const res = classifyPackage(pkg);

      assert.equal(res.kind, "esm");
      assert.equal(res.requirement81Kind, "already ESM");
      assert.equal(res.isEsm, true);
      assert.equal(res.leaveInCommonJS, false);
      assert.equal(res.canConvert, false);
      assert.equal(res.unknowns.length, 0);
      assert.equal(isEsm(pkg), true);
    });

    it("2. classifies as unknown (monorepo) when workspaces is set and records U4", () => {
      const pkgWithArray = {
        name: "monorepo-array",
        workspaces: ["packages/*"],
      };
      const res1 = classifyPackage(pkgWithArray, { filePath: "root/package.json" });

      assert.equal(res1.kind, "monorepo");
      assert.equal(res1.requirement81Kind, "unknown");
      assert.equal(res1.isMonorepo, true);
      assert.equal(res1.isUnknown, true);
      assert.equal(res1.leaveInCommonJS, true);
      assert.equal(res1.canConvert, false);
      assert.equal(res1.reference, "U4");
      assert.equal(res1.unknowns.length, 1);
      assert.equal(res1.unknowns[0].ruleId, "M3");
      assert.equal(res1.unknowns[0].reason, "U4");
      assert.equal(res1.unknowns[0].file, "root/package.json");
      assert.equal(isMonorepo(pkgWithArray), true);

      const pkgWithObject = {
        name: "monorepo-obj",
        workspaces: { packages: ["apps/*"] },
      };
      const res2 = classifyPackage(pkgWithObject);
      assert.equal(res2.kind, "monorepo");
      assert.equal(res2.reference, "U4");
    });

    it("3. classifies as application when private is true", () => {
      const pkgPrivate = {
        name: "my-app",
        private: true,
        // even if main or exports is present, private: true makes it application
        main: "index.js",
      };
      const res = classifyPackage(pkgPrivate);

      assert.equal(res.kind, "application");
      assert.equal(res.requirement81Kind, "application");
      assert.equal(res.isApplication, true);
      assert.equal(res.leaveInCommonJS, false);
      assert.equal(res.canConvert, true);
      assert.equal(res.unknowns.length, 0);
      assert.equal(isApplication(pkgPrivate), true);
    });

    it("4. classifies as library when private is not true, has exports/main/module, and scripts.start is not string", () => {
      const pkgWithMain = {
        name: "my-lib",
        main: "./lib/index.js",
        scripts: { test: "mocha" },
      };
      const resMain = classifyPackage(pkgWithMain, { filePath: "lib/package.json" });
      assert.equal(resMain.kind, "library");
      assert.equal(resMain.requirement81Kind, "library");
      assert.equal(resMain.isLibrary, true);
      assert.equal(resMain.leaveInCommonJS, true);
      assert.equal(resMain.reference, "U4");
      assert.equal(resMain.unknowns.length, 1);
      assert.equal(resMain.unknowns[0].ruleId, "M3");
      assert.equal(resMain.unknowns[0].reason, "U4");
      assert.equal(isLibrary(pkgWithMain), true);

      const pkgWithExports = {
        name: "modern-lib",
        exports: { ".": "./index.js" },
      };
      const resExports = classifyPackage(pkgWithExports);
      assert.equal(resExports.kind, "library");

      const pkgWithModule = {
        name: "dual-lib",
        module: "./dist/index.mjs",
      };
      const resModule = classifyPackage(pkgWithModule);
      assert.equal(resModule.kind, "library");
    });

    it("5. classifies as application when private is not true, no exports/main/module, and scripts.start is string or bin is set", () => {
      const pkgWithStart = {
        name: "public-service",
        scripts: { start: "node server.js" },
      };
      const resStart = classifyPackage(pkgWithStart);
      assert.equal(resStart.kind, "application");
      assert.equal(resStart.requirement81Kind, "application");
      assert.equal(resStart.isApplication, true);
      assert.equal(resStart.leaveInCommonJS, false);
      assert.equal(resStart.canConvert, true);
      assert.equal(resStart.unknowns.length, 0);
      assert.equal(isApplication(pkgWithStart), true);

      const pkgWithBin = {
        name: "cli-tool",
        bin: "./bin/cli.js",
      };
      const resBin = classifyPackage(pkgWithBin);
      assert.equal(resBin.kind, "application");

      const pkgWithBinMap = {
        name: "multi-cli",
        bin: { tool: "./bin/run.js" },
      };
      const resBinMap = classifyPackage(pkgWithBinMap);
      assert.equal(resBinMap.kind, "application");
    });

    it("6. classifies as unknown otherwise and records U4", () => {
      const pkgEmpty = {};
      const resEmpty = classifyPackage(pkgEmpty, { filePath: "empty/package.json" });
      assert.equal(resEmpty.kind, "unknown");
      assert.equal(resEmpty.requirement81Kind, "unknown");
      assert.equal(resEmpty.isUnknown, true);
      assert.equal(resEmpty.leaveInCommonJS, true);
      assert.equal(resEmpty.canConvert, false);
      assert.equal(resEmpty.reference, "U4");
      assert.equal(resEmpty.unknowns.length, 1);
      assert.equal(resEmpty.unknowns[0].reason, "U4");

      const pkgWithOtherScripts = {
        name: "build-only",
        scripts: { build: "tsc", test: "vitest" },
      };
      const resOther = classifyPackage(pkgWithOtherScripts);
      assert.equal(resOther.kind, "unknown");
      assert.equal(resOther.reference, "U4");
    });
  });

  describe("Input shape resilience for package classifier", () => {
    it("accepts valid JSON string input", () => {
      const jsonStr = JSON.stringify({ type: "module" });
      const res = classifyPackage(jsonStr);
      assert.equal(res.kind, "esm");
    });

    it("handles unparseable or null input by classifying as unknown with U4", () => {
      const resBadJson = classifyPackage("invalid-json-text{{{");
      assert.equal(resBadJson.kind, "unknown");
      assert.equal(resBadJson.reference, "U4");
      assert.equal(resBadJson.unknowns.length, 1);

      const resNull = classifyPackage(null);
      assert.equal(resNull.kind, "unknown");
      assert.equal(resNull.reference, "U4");

      const resUndef = classifyPackage(undefined);
      assert.equal(resUndef.kind, "unknown");
      assert.equal(resUndef.reference, "U4");
    });

    it("supports helper aliases: classifyPackageJson, getPackageKind, classifyPackageKind", () => {
      const pkg = { private: true };
      assert.equal(classifyPackageJson(pkg).kind, "application");
      assert.equal(getPackageKind(pkg), "application");
      assert.equal(classifyPackageKind(pkg), "application");
    });
  });

  describe("inspectFileForM3 file checks (Requirement 8.4)", () => {
    it("flags files using __dirname as ineligible for M3", () => {
      const code = [
        "const path = require('path');",
        "const configPath = path.join(__dirname, 'config.json');",
      ].join("\n");

      const result = inspectFileForM3(code, "config.js");
      assert.equal(result.eligible, false);
      assert.equal(result.featuresFound.dirname, true);
    });

    it("flags files using __filename as ineligible for M3", () => {
      const code = [
        "console.log('Running from', __filename);",
      ].join("\n");

      const result = inspectFileForM3(code, "runner.js");
      assert.equal(result.eligible, false);
      assert.equal(result.featuresFound.filename, true);
    });

    it("flags files using require.resolve as ineligible for M3", () => {
      const code = [
        "const entry = require.resolve('some-module');",
      ].join("\n");

      const result = inspectFileForM3(code, "entry.js");
      assert.equal(result.eligible, false);
      assert.equal(result.featuresFound.requireResolve, true);
    });

    it("flags files using conditional require inside if-statement", () => {
      const code = [
        "if (process.env.NODE_ENV === 'development') {",
        "  const devTool = require('dev-tool');",
        "}",
      ].join("\n");

      const result = inspectFileForM3(code, "cond.js");
      assert.equal(result.eligible, false);
      assert.equal(result.featuresFound.conditionalRequire, true);
    });

    it("considers clean CommonJS without special globals eligible for M3", () => {
      const code = [
        "const a = require('alpha');",
        "const b = require('beta');",
        "module.exports = { a, b };",
      ].join("\n");

      const result = inspectFileForM3(code, "clean.js");
      assert.equal(result.eligible, true);
      assert.equal(result.featuresFound.dirname, false);
      assert.equal(result.featuresFound.filename, false);
      assert.equal(result.featuresFound.requireResolve, false);
      assert.equal(result.featuresFound.conditionalRequire, false);
      assert.equal(result.unknowns.length, 0);
    });
  });

  describe("convertCommonJsToEsm basic transform", () => {
    it("converts simple require and module.exports to import and export", () => {
      const source = [
        "const path = require('path');",
        "module.exports = path;",
      ].join("\n");

      const res = convertCommonJsToEsm(source, "utils.js");
      assert.equal(res.changed, true);
      assert(res.code.includes("import path from 'path'"));
      assert(res.code.includes("export default path"));
    });
  });

  describe("M4 guidance: CommonsChunkPlugin and Vite guidance (Requirement 8.5)", () => {
    it("identifies CommonsChunkPlugin in webpack config source", () => {
      const webpackConfig = [
        "const webpack = require('webpack');",
        "module.exports = {",
        "  plugins: [",
        "    new webpack.optimize.CommonsChunkPlugin({ name: 'vendor' }),",
        "  ],",
        "};",
      ].join("\n");

      const found = findCommonsChunkPlugin(webpackConfig);
      assert(found);
      assert.equal(found.ruleId, "M4");
      assert.equal(found.reason, "CommonsChunkPlugin");
    });

    it("returns null when CommonsChunkPlugin is not present", () => {
      const config = "module.exports = { entry: './index.js' };";
      const found = findCommonsChunkPlugin(config);
      assert.equal(found, null);
    });

    it("provides stable Vite version and M4 guidance result", () => {
      const overriddenVersion = lookupStableViteVersion("6.1.0");
      assert.equal(overriddenVersion, "6.1.0");
      assert.equal(getStableViteVersion("6.1.0"), "6.1.0");

      const guidance = getM4Guidance({
        configContent: "new webpack.optimize.CommonsChunkPlugin({ name: 'common' });",
        viteVersion: "6.1.0",
      });
      assert.equal(guidance.ruleId, "M4");
      assert(typeof guidance.notes === "string" || Array.isArray(guidance.notes));
    });
  });
});
