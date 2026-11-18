import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  updateM2Manifest,
  removeRequestDependency,
  updateNodeEngines,
  evaluateNodeEngine,
  REQUIRED_NODE_ENGINE,
  NODE_22_NOTE,
  ENGINES_UNPARSEABLE_REASON,
  REQUEST_STILL_IMPORTED_REASON,
} from "../../lib/rules/m2-manifest";

describe("rules/m2-manifest: updateM2Manifest and manifest update functions", () => {
  describe("removeRequestDependency (Requirement 7.7, 7.8)", () => {
    it("removes request from dependencies when stillImportsRequest is false", () => {
      const manifest = {
        name: "test-pkg",
        dependencies: {
          request: "^2.88.2",
          express: "^4.18.2",
        },
      };

      const result = removeRequestDependency(manifest, {
        stillImportsRequest: false,
      });

      assert.equal(result.changed, true);
      assert.equal(result.removed, true);
      assert.equal("request" in (result.manifest.dependencies as Record<string, unknown>), false);
      assert.equal(
        (result.manifest.dependencies as Record<string, unknown>).express,
        "^4.18.2"
      );
      assert.equal(result.unknowns.length, 0);

      // Verify original object is not mutated
      assert.equal("request" in manifest.dependencies, true);
    });

    it("keeps request in dependencies and records unknown when stillImportsRequest is true", () => {
      const manifest = {
        name: "test-pkg",
        dependencies: {
          request: "^2.88.2",
        },
      };

      const result = removeRequestDependency(manifest, {
        stillImportsRequest: true,
        filePath: "pkg/package.json",
      });

      assert.equal(result.changed, false);
      assert.equal(result.removed, false);
      assert.equal("request" in (result.manifest.dependencies as Record<string, unknown>), true);
      assert.equal(result.unknowns.length, 1);
      assert.equal(result.unknowns[0].ruleId, "M2");
      assert.equal(result.unknowns[0].reason, REQUEST_STILL_IMPORTED_REASON);
      assert.equal(result.unknowns[0].file, "pkg/package.json");
    });

    it("supports allFilesMigrated complement option", () => {
      const manifest = {
        dependencies: { request: "2.88.0" },
      };

      const migrated = removeRequestDependency(manifest, { allFilesMigrated: true });
      assert.equal(migrated.removed, true);
      assert.equal(migrated.unknowns.length, 0);

      const notMigrated = removeRequestDependency(manifest, { allFilesMigrated: false });
      assert.equal(notMigrated.removed, false);
      assert.equal(notMigrated.unknowns.length, 1);
    });

    it("supports remainingImports array and number count options", () => {
      const manifest = {
        dependencies: { request: "2.88.0" },
      };

      const withRemainingArray = removeRequestDependency(manifest, {
        remainingImports: ["src/legacy.js"],
      });
      assert.equal(withRemainingArray.removed, false);
      assert.equal(withRemainingArray.unknowns.length, 1);

      const withEmptyArray = removeRequestDependency(manifest, {
        remainingImports: [],
      });
      assert.equal(withEmptyArray.removed, true);
      assert.equal(withEmptyArray.unknowns.length, 0);

      const withCount = removeRequestDependency(manifest, {
        remainingImports: 2,
      });
      assert.equal(withCount.removed, false);

      const withZeroCount = removeRequestDependency(manifest, {
        remainingImports: 0,
      });
      assert.equal(withZeroCount.removed, true);
    });

    it("handles manifest without dependencies or without request gracefully", () => {
      const manifestNoDeps = { name: "no-deps" };
      const res1 = removeRequestDependency(manifestNoDeps, { stillImportsRequest: false });
      assert.equal(res1.changed, false);
      assert.equal(res1.removed, false);

      const manifestOtherDeps = {
        dependencies: { lodash: "^4.17.21" },
      };
      const res2 = removeRequestDependency(manifestOtherDeps, { stillImportsRequest: false });
      assert.equal(res2.changed, false);
      assert.equal(res2.removed, false);
      assert.deepEqual(res2.manifest.dependencies, { lodash: "^4.17.21" });
    });
  });

  describe("evaluateNodeEngine range parsing (Requirement 7.9, 7.10)", () => {
    it("evaluates absent engines.node as absent: true and below22: true", () => {
      const evalUndef = evaluateNodeEngine(undefined);
      assert.equal(evalUndef.absent, true);
      assert.equal(evalUndef.below22, true);
      assert.equal(evalUndef.unparseable, false);

      const evalNull = evaluateNodeEngine(null);
      assert.equal(evalNull.absent, true);
      assert.equal(evalNull.below22, true);

      const evalEmpty = evaluateNodeEngine("");
      assert.equal(evalEmpty.absent, false);
      assert.equal(evalEmpty.below22, true);
    });

    it("evaluates ranges with minimum below 22 as below22: true", () => {
      const below22Ranges = [
        ">=14.0.0",
        "^16.0.0",
        "~18.12.0",
        "12 - 16",
        "<22",
        ">=18.0.0 <22.0.0",
        "14.x",
        "8.9.1",
        "0.10.x",
      ];

      for (const range of below22Ranges) {
        const res = evaluateNodeEngine(range);
        assert.equal(
          res.below22,
          true,
          `Expected range '${range}' to evaluate below22: true`
        );
        assert.equal(
          res.unparseable,
          false,
          `Expected range '${range}' to be parseable`
        );
      }
    });

    it("evaluates ranges with minimum at or above 22 as below22: false", () => {
      const above22Ranges = [
        ">=22",
        ">=22.0.0",
        ">=22.6.0",
        "^22.0.0",
        "~22.1.0",
        "22 - 24",
        ">=23.0.0",
      ];

      for (const range of above22Ranges) {
        const res = evaluateNodeEngine(range);
        assert.equal(
          res.below22,
          false,
          `Expected range '${range}' to evaluate below22: false`
        );
        assert.equal(
          res.unparseable,
          false,
          `Expected range '${range}' to be parseable`
        );
      }
    });

    it("evaluates invalid or non-string engine values as unparseable: true", () => {
      const invalidRanges = [
        "not-a-valid-range!#$%",
        "abc.def",
        "latest",
        12345,
        {},
        true,
      ];

      for (const invalid of invalidRanges) {
        const res = evaluateNodeEngine(invalid);
        assert.equal(
          res.unparseable,
          true,
          `Expected value ${JSON.stringify(invalid)} to evaluate unparseable: true`
        );
        assert.equal(res.below22, false);
      }
    });
  });

  describe("updateNodeEngines (Requirement 7.9, 7.10)", () => {
    it("sets engines.node to >=22 and adds note when engines is absent", () => {
      const manifest = { name: "test-pkg" };
      const result = updateNodeEngines(manifest, { m2Fired: true });

      assert.equal(result.changed, true);
      const engines = result.manifest.engines as Record<string, unknown>;
      assert(engines);
      assert.equal(engines.node, REQUIRED_NODE_ENGINE);
      assert.deepEqual(result.notes, [NODE_22_NOTE]);
      assert.equal(result.unknowns.length, 0);
    });

    it("updates engines.node to >=22 and preserves other engines when node is below 22", () => {
      const manifest = {
        name: "test-pkg",
        engines: {
          node: ">=16.0.0",
          npm: ">=8.0.0",
        },
      };

      const result = updateNodeEngines(manifest, { m2Fired: true });

      assert.equal(result.changed, true);
      const engines = result.manifest.engines as Record<string, unknown>;
      assert.equal(engines.node, REQUIRED_NODE_ENGINE);
      assert.equal(engines.npm, ">=8.0.0");
      assert.deepEqual(result.notes, [NODE_22_NOTE]);
      assert.equal(result.unknowns.length, 0);
    });

    it("leaves engines.node unchanged and adds no note when node is already >= 22", () => {
      const manifest = {
        name: "test-pkg",
        engines: {
          node: ">=22.0.0",
        },
      };

      const result = updateNodeEngines(manifest, { m2Fired: true });

      assert.equal(result.changed, false);
      const engines = result.manifest.engines as Record<string, unknown>;
      assert.equal(engines.node, ">=22.0.0");
      assert.deepEqual(result.notes, []);
      assert.equal(result.unknowns.length, 0);
    });

    it("leaves engines unchanged and records unknown engines_unparseable when range is unparseable", () => {
      const manifest = {
        name: "test-pkg",
        engines: {
          node: "invalid-version-spec!#",
        },
      };

      const result = updateNodeEngines(manifest, {
        m2Fired: true,
        filePath: "app/package.json",
      });

      assert.equal(result.changed, false);
      const engines = result.manifest.engines as Record<string, unknown>;
      assert.equal(engines.node, "invalid-version-spec!#");
      assert.deepEqual(result.notes, []);
      assert.equal(result.unknowns.length, 1);
      assert.equal(result.unknowns[0].ruleId, "M2");
      assert.equal(result.unknowns[0].reason, ENGINES_UNPARSEABLE_REASON);
      assert.equal(result.unknowns[0].file, "app/package.json");
    });

    it("does not update engines when m2Fired is false", () => {
      const manifest = {
        name: "test-pkg",
        engines: {
          node: ">=14.0.0",
        },
      };

      const result = updateNodeEngines(manifest, { m2Fired: false });

      assert.equal(result.changed, false);
      const engines = result.manifest.engines as Record<string, unknown>;
      assert.equal(engines.node, ">=14.0.0");
      assert.deepEqual(result.notes, []);
      assert.equal(result.unknowns.length, 0);
    });
  });

  describe("updateM2Manifest combined transform", () => {
    it("removes request dependency and bumps engines in a single pure transform", () => {
      const manifest = {
        name: "full-package",
        dependencies: {
          request: "^2.88.2",
          debug: "^4.3.0",
        },
        engines: {
          node: ">=18.0.0",
        },
      };

      const result = updateM2Manifest(manifest, {
        stillImportsRequest: false,
        m2Fired: true,
      });

      assert.equal(result.changed, true);
      assert.equal(result.dependenciesChanged, true);
      assert.equal(result.enginesChanged, true);

      const deps = result.manifest.dependencies as Record<string, unknown>;
      assert.equal("request" in deps, false);
      assert.equal(deps.debug, "^4.3.0");

      const engines = result.manifest.engines as Record<string, unknown>;
      assert.equal(engines.node, REQUIRED_NODE_ENGINE);
      assert.deepEqual(result.notes, [NODE_22_NOTE]);
      assert.equal(result.unknowns.length, 0);

      // Verify original object was untouched
      assert.equal("request" in manifest.dependencies, true);
      assert.equal(manifest.engines.node, ">=18.0.0");
    });

    it("supports iterator protocol to unpack [pkg, unknowns]", () => {
      const manifest = {
        dependencies: { request: "2.88.0" },
      };

      const [newPkg, unknowns] = updateM2Manifest(manifest, {
        stillImportsRequest: false,
      });

      assert(newPkg && typeof newPkg === "object");
      assert(Array.isArray(unknowns));
      assert.equal("request" in ((newPkg as any).dependencies || {}), false);
    });
  });
});
