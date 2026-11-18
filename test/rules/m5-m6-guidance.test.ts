import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCK_FILE_NAMES,
  REGISTRY_UNAVAILABLE_REASON,
  isSupportedLockFile,
  hasSupportedLockFile,
  parseMajorVersion,
  isMajorDrifted,
  isDrifted,
  evaluateM5Dependencies,
  evaluateM5DependenciesAsync,
  getM5Guidance,
  evaluatePythonM5,
  recordPythonM5Unknown,
  formatM5Report,
  evaluateM6,
  detectM6Signals,
  getM6Guidance,
} from "../../lib/rules/m5-m6-guidance";

describe("rules/m5-m6-guidance: M5 and M6 guidance rules with offline registry stub", () => {
  describe("Lock file detection (Requirement 8.10)", () => {
    it("identifies all six supported lock file formats in LOCK_FILE_NAMES", () => {
      assert.deepEqual(LOCK_FILE_NAMES, [
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "Pipfile.lock",
      ]);

      for (const name of LOCK_FILE_NAMES) {
        assert.equal(
          isSupportedLockFile(name),
          true,
          `Expected ${name} to be supported lock file`
        );
        assert.equal(
          hasSupportedLockFile([name, "other.txt"]),
          true,
          `Expected list with ${name} to have supported lock file`
        );
      }
    });

    it("returns false for unsupported or foreign lock file names", () => {
      const unsupported = [
        "Cargo.lock",
        "composer.lock",
        "packages.lock.json",
        "gems.locked",
        "random.json",
      ];

      for (const name of unsupported) {
        assert.equal(isSupportedLockFile(name), false);
      }
      assert.equal(hasSupportedLockFile(unsupported), false);
    });
  });

  describe("Major version parsing and drift calculation (Requirement 8.6)", () => {
    it("parses major version across standard and prefixed semver formats", () => {
      assert.equal(parseMajorVersion("1.0.0"), 1);
      assert.equal(parseMajorVersion("^2.4.1"), 2);
      assert.equal(parseMajorVersion("~3.8.0"), 3);
      assert.equal(parseMajorVersion(">=4.0.0"), 4);
      assert.equal(parseMajorVersion("v5.1.2"), 5);
      assert.equal(parseMajorVersion("6.x"), 6);
      assert.equal(parseMajorVersion("*"), null);
      assert.equal(parseMajorVersion("git+file://repo"), null);
      assert.equal(parseMajorVersion(null), null);
    });

    it("computes major drift where 2 or more major versions behind is drifted", () => {
      // 2 major versions behind -> drifted
      const drift2 = isMajorDrifted("^1.0.0", "3.0.0");
      assert.equal(drift2.isDrifted, true);
      assert.equal(drift2.majorDrift, 2);
      assert.equal(isDrifted("^1.0.0", "3.0.0"), true);

      // 3 major versions behind -> drifted
      const drift3 = isMajorDrifted("1.2.0", "4.17.21");
      assert.equal(drift3.isDrifted, true);
      assert.equal(drift3.majorDrift, 3);

      // 1 major version behind -> not drifted (minDrift is 2)
      const drift1 = isMajorDrifted("^2.0.0", "3.1.0");
      assert.equal(drift1.isDrifted, false);
      assert.equal(drift1.majorDrift, 1);
      assert.equal(isDrifted("^2.0.0", "3.1.0"), false);

      // Same major version -> not drifted
      const drift0 = isMajorDrifted("4.1.0", "4.18.2");
      assert.equal(drift0.isDrifted, false);
      assert.equal(drift0.majorDrift, 0);

      // Unparseable version -> not drifted
      const driftUnparseable = isMajorDrifted("latest", "1.0.0");
      assert.equal(driftUnparseable.isDrifted, false);
      assert.equal(driftUnparseable.majorDrift, null);
    });
  });

  describe("M5 guidance evaluation with offline registry stub (Requirement 8.6, 8.7)", () => {
    it("detects drifted dependencies using injected offline registry stub", () => {
      const manifest = {
        name: "drifted-pkg",
        dependencies: {
          alpha: "^1.0.0", // latest is 3.0.0 -> drift 2 (drifted)
          beta: "^2.0.0", // latest is 5.0.0 -> drift 3 (drifted)
          gamma: "^3.0.0", // latest is 3.5.0 -> drift 0 (not drifted)
          delta: "^4.0.0", // latest is 5.0.0 -> drift 1 (not drifted)
        },
      };

      const offlineRegistryStub = (pkgName: string) => {
        const table: Record<string, string> = {
          alpha: "3.0.0",
          beta: "5.0.0",
          gamma: "3.5.0",
          delta: "5.0.0",
        };
        return table[pkgName] ? { version: table[pkgName] } : null;
      };

      const result = evaluateM5Dependencies(manifest, {
        registryLookup: offlineRegistryStub,
      });

      assert.equal(result.ruleId, "M5");
      assert.equal(result.drifted.length, 2);

      const alphaDrift = result.drifted.find((d) => d.name === "alpha");
      assert(alphaDrift);
      assert.equal(alphaDrift.declaredMajor, 1);
      assert.equal(alphaDrift.latestMajor, 3);
      assert.equal(alphaDrift.majorDrift, 2);
      assert.equal(alphaDrift.forced, false);
      // Without forced bump, targetVersion is preserved as declaredVersion
      assert.equal(alphaDrift.targetVersion, "^1.0.0");

      const betaDrift = result.drifted.find((d) => d.name === "beta");
      assert(betaDrift);
      assert.equal(betaDrift.declaredMajor, 2);
      assert.equal(betaDrift.latestMajor, 5);
      assert.equal(betaDrift.majorDrift, 3);

      // Unforced drift does not change manifest
      assert.equal(result.manifestChanged, false);
      assert.equal(result.unknowns.length, 0);
    });

    it("applies version bump only when another rule forces the bump (Requirement 8.7)", () => {
      const manifest = {
        name: "forced-bump-pkg",
        dependencies: {
          vite: "^2.0.0", // latest 6.0.0, forced by M4
          lodash: "^1.0.0", // latest 4.0.0, unforced
        },
      };

      const offlineRegistryStub = (pkgName: string) => {
        if (pkgName === "vite") return { version: "6.0.0" };
        if (pkgName === "lodash") return { version: "4.17.21" };
        return null;
      };

      const result = evaluateM5Dependencies(manifest, {
        registryLookup: offlineRegistryStub,
        forcedBumps: {
          vite: "^6.0.0",
        },
      });

      assert.equal(result.drifted.length, 2);

      const viteItem = result.drifted.find((d) => d.name === "vite");
      assert(viteItem);
      assert.equal(viteItem.forced, true);
      assert.equal(viteItem.targetVersion, "^6.0.0");

      const lodashItem = result.drifted.find((d) => d.name === "lodash");
      assert(lodashItem);
      assert.equal(lodashItem.forced, false);
      assert.equal(lodashItem.targetVersion, "^1.0.0");

      // Manifest changed due to forced bump on vite
      assert.equal(result.manifestChanged, true);
      assert(result.packageJson);
      const updatedDeps = result.packageJson.dependencies as Record<string, string>;
      assert.equal(updatedDeps.vite, "^6.0.0");
      assert.equal(updatedDeps.lodash, "^1.0.0");
    });

    it("evaluates devDependencies for drift when includeDevDependencies is true", () => {
      const manifest = {
        name: "dev-drift-pkg",
        dependencies: {},
        devDependencies: {
          mocha: "^5.0.0",
        },
      };

      const result = evaluateM5Dependencies(manifest, {
        registry: {
          mocha: { version: "10.0.0" },
        },
        includeDevDependencies: true,
      });

      assert.equal(result.drifted.length, 1);
      assert.equal(result.drifted[0].name, "mocha");
      assert.equal(result.drifted[0].majorDrift, 5);
    });

    it("supports asynchronous registry lookup with evaluateM5DependenciesAsync", async () => {
      const manifest = {
        dependencies: {
          asyncLib: "^1.0.0",
        },
      };

      const asyncStub = async (name: string) => {
        if (name === "asyncLib") {
          return { version: "4.0.0" };
        }
        return null;
      };

      const result = await evaluateM5DependenciesAsync(manifest, {
        registryLookup: asyncStub,
      });

      assert.equal(result.drifted.length, 1);
      assert.equal(result.drifted[0].name, "asyncLib");
      assert.equal(result.drifted[0].majorDrift, 3);
    });
  });

  describe("M5 registry failure handling (Requirement 8.9)", () => {
    it("records unknown with reason registry_unavailable on failed lookup and keeps old version", () => {
      const manifest = {
        name: "pkg-with-failed-lookup",
        dependencies: {
          privateInternal: "^1.0.0",
          corrupted: "^2.0.0",
        },
      };

      const failingRegistryStub = (pkgName: string) => {
        if (pkgName === "privateInternal") return null;
        if (pkgName === "corrupted") throw new Error("Registry network timeout");
        return null;
      };

      const result = evaluateM5Dependencies(manifest, {
        registryLookup: failingRegistryStub,
        filePath: "custom/package.json",
      });

      assert.equal(result.drifted.length, 0);
      assert.equal(result.unknowns.length, 2);

      for (const u of result.unknowns) {
        assert.equal(u.ruleId, "M5");
        assert.equal(u.reason, REGISTRY_UNAVAILABLE_REASON);
        assert.equal(u.file, "custom/package.json");
      }

      // Dependencies kept as declared
      assert.equal(result.manifestChanged, false);
      assert(result.packageJson);
      const deps = result.packageJson.dependencies as Record<string, string>;
      assert.equal(deps.privateInternal, "^1.0.0");
      assert.equal(deps.corrupted, "^2.0.0");
    });
  });

  describe("Python M5 guidance (Requirement 8.8)", () => {
    it("records unknown with reason 'unknown' when language is python", () => {
      const result = evaluatePythonM5({ filePath: "requirements.txt" });

      assert.equal(result.ruleId, "M5");
      assert.equal(result.drifted.length, 0);
      assert.equal(result.unknowns.length, 1);
      assert.equal(result.unknowns[0].ruleId, "M5");
      assert.equal(result.unknowns[0].reason, "unknown");
      assert.equal(result.unknowns[0].file, "requirements.txt");

      const singleRec = recordPythonM5Unknown({ filePath: "requirements.txt" });
      assert.equal(singleRec.ruleId, "M5");
      assert.equal(singleRec.reason, "unknown");
    });
  });

  describe("M5 report formatting", () => {
    it("formats drift report with from, to, and major drift counts", () => {
      const driftedItems = [
        {
          name: "old-lib",
          declaredVersion: "^1.0.0",
          latestVersion: "3.2.0",
          declaredMajor: 1,
          latestMajor: 3,
          majorDrift: 2,
          majorDiff: 2,
          manifestDir: ".",
          file: "package.json",
          forced: false,
          targetVersion: "^1.0.0",
        },
      ];

      const reportLines = formatM5Report(driftedItems);
      assert(reportLines.length > 0);
      assert(reportLines.some((l) => l.includes("old-lib")));
      assert(reportLines.some((l) => l.includes("1") && l.includes("3")));
    });
  });

  describe("M6 guidance: Missing lock file detection (Requirement 8.10)", () => {
    it("emits an M6 Signal when manifest directory has no lock file", () => {
      const signal = evaluateM6("packages/app", []);

      assert(signal);
      assert.equal(signal.ruleId, "M6");
      assert.equal(signal.manifestDir, "packages/app");
      assert.equal(signal.file, "packages/app/package.json");
      assert.equal(signal.confidence, "high");
      assert.equal(signal.matched, "missing lock file");
    });

    it("returns null when directory contains a supported lock file", () => {
      // Testing with package-lock.json
      const withNpm = evaluateM6(".", ["package-lock.json"]);
      assert.equal(withNpm, null);

      // Testing with yarn.lock
      const withYarn = evaluateM6("client", ["yarn.lock"]);
      assert.equal(withYarn, null);

      // Testing with pnpm-lock.yaml
      const withPnpm = evaluateM6("server", ["pnpm-lock.yaml"]);
      assert.equal(withPnpm, null);

      // Testing with poetry.lock
      const withPoetry = evaluateM6("python-pkg", ["poetry.lock"]);
      assert.equal(withPoetry, null);

      // Testing with Pipfile.lock
      const withPipfile = evaluateM6("py-service", ["Pipfile.lock"]);
      assert.equal(withPipfile, null);

      // Testing with npm-shrinkwrap.json
      const withShrinkwrap = evaluateM6("legacy", ["npm-shrinkwrap.json"]);
      assert.equal(withShrinkwrap, null);
    });

    it("detects M6 signals across multiple manifest directories with detectM6Signals", () => {
      const manifestDirs = [
        {
          path: "apps/web",
          lockFiles: [], // lacks lock file -> emits signal
        },
        {
          path: "apps/api",
          lockFiles: ["package-lock.json"], // has lock file -> no signal
        },
        {
          path: "packages/shared",
          lockFiles: [], // lacks lock file -> emits signal
        },
      ];

      const signals = detectM6Signals(manifestDirs);
      assert.equal(signals.length, 2);

      const dirsWithSignals = signals.map((s) => s.manifestDir);
      assert(dirsWithSignals.includes("apps/web"));
      assert(dirsWithSignals.includes("packages/shared"));
      assert(!dirsWithSignals.includes("apps/api"));
    });

    it("supports getM6Guidance convenience helper", () => {
      const manifestDirs = [
        {
          path: "lib/pkg",
          lockFiles: [],
        },
      ];
      const guidance = getM6Guidance(manifestDirs);
      assert.equal(guidance.ruleId, "M6");
      assert.equal(guidance.signals.length, 1);
      assert.equal(guidance.signals[0].ruleId, "M6");
      assert.deepEqual(guidance.missingLockDirs, ["lib/pkg"]);
    });
  });
});
