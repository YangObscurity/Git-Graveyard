import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  createNoTestsFoundRecord,
  detectPythonPackageManager,
  evaluatePytestCollect,
  extractFileContent,
  extractFilePaths,
  findNodeTestFiles,
  findPythonTestFiles,
  inspectNodeManifest,
  inspectPythonManifests,
  inspectRepositoryManifests,
  isDefaultPlaceholderTest,
  isPytestCollectExitCode5,
  isPythonTestFile,
  markStepsNotRunOnInstallFailure,
  normalizeFilePath,
  parsePackageJson,
} from "../../lib/exhume/script-detector";
import {
  NO_TESTS_FOUND_LABEL,
  NO_TESTS_FOUND_RULE_ID,
} from "../../lib/exhume/types";

describe("script-detector: path and manifest normalization", () => {
  test("normalizeFilePath handles backslashes and slashes", () => {
    assert.equal(normalizeFilePath("foo\\bar\\baz.py"), "foo/bar/baz.py");
    assert.equal(normalizeFilePath("./src/index.js"), "src/index.js");
    assert.equal(normalizeFilePath("/root/package.json"), "root/package.json");
    assert.equal(normalizeFilePath("  test/  "), "test");
  });

  test("extractFilePaths handles various input formats", () => {
    const listA = ["./package.json", "src\\app.ts"];
    assert.deepEqual(extractFilePaths(listA), ["package.json", "src/app.ts"]);

    const listB = [
      { path: "setup.py", content: "..." },
      { path: "tests/test_main.py" },
    ];
    assert.deepEqual(extractFilePaths(listB), [
      "setup.py",
      "tests/test_main.py",
    ]);

    const mapC = new Map([
      ["package.json", "{}"],
      ["index.js", "console.log(1)"],
    ]);
    assert.deepEqual(extractFilePaths(mapC), ["package.json", "index.js"]);

    const recordD = {
      "pyproject.toml": "[tool.poetry]",
      "README.md": "# Doc",
    };
    assert.deepEqual(extractFilePaths(recordD), [
      "pyproject.toml",
      "README.md",
    ]);
  });

  test("extractFileContent extracts file content when provided", () => {
    const files = [
      { path: "package.json", content: '{"name":"test"}' },
      { path: "setup.py", content: "from setuptools import setup" },
    ];
    assert.equal(
      extractFileContent(files, "package.json"),
      '{"name":"test"}'
    );
    assert.equal(
      extractFileContent(files, "./setup.py"),
      "from setuptools import setup"
    );
    assert.equal(extractFileContent(files, "missing.txt"), undefined);
  });

  test("parsePackageJson parses valid JSON and handles malformed gracefully", () => {
    assert.deepEqual(parsePackageJson('{"name":"abc"}'), { name: "abc" });
    assert.deepEqual(parsePackageJson({ name: "abc" }), { name: "abc" });
    assert.equal(parsePackageJson("not-json"), null);
    assert.equal(parsePackageJson(null), null);
  });
});

describe("script-detector: placeholder test detection (Requirement 11.10, Task 8.2)", () => {
  test("identifies standard npm placeholder commands", () => {
    assert.equal(
      isDefaultPlaceholderTest('echo "Error: no test specified" && exit 1'),
      true
    );
    assert.equal(
      isDefaultPlaceholderTest('echo \\"Error: no test specified\\" && exit 1'),
      true
    );
    assert.equal(
      isDefaultPlaceholderTest("echo 'Error: no test specified' && exit 1"),
      true
    );
    assert.equal(isDefaultPlaceholderTest("echo no test specified"), true);
    assert.equal(
      isDefaultPlaceholderTest("echo 'Error: no tests found' && exit 1"),
      true
    );
  });

  test("identifies empty, exit, and no-op placeholder commands", () => {
    assert.equal(isDefaultPlaceholderTest(""), true);
    assert.equal(isDefaultPlaceholderTest("   "), true);
    assert.equal(isDefaultPlaceholderTest("exit 1"), true);
    assert.equal(isDefaultPlaceholderTest("exit 0"), true);
    assert.equal(isDefaultPlaceholderTest(":"), true);
    assert.equal(isDefaultPlaceholderTest("true"), true);
  });

  test("does not flag real test runner commands as placeholders", () => {
    assert.equal(isDefaultPlaceholderTest("jest"), false);
    assert.equal(isDefaultPlaceholderTest("mocha tests/**/*.js"), false);
    assert.equal(isDefaultPlaceholderTest("vitest run"), false);
    assert.equal(isDefaultPlaceholderTest("node --test"), false);
    assert.equal(isDefaultPlaceholderTest("pytest"), false);
    assert.equal(isDefaultPlaceholderTest("npm run test:unit"), false);
  });
});

describe("script-detector: Python test file detection (Requirement 11.10)", () => {
  test("detects python test files by name patterns", () => {
    assert.equal(isPythonTestFile("test_sample.py"), true);
    assert.equal(isPythonTestFile("src/test_sample.py"), true);
    assert.equal(isPythonTestFile("sample_test.py"), true);
    assert.equal(isPythonTestFile("tests.py"), true);
    assert.equal(isPythonTestFile("test.py"), true);
    assert.equal(isPythonTestFile("conftest.py"), true);
  });

  test("detects python files within test directories", () => {
    assert.equal(isPythonTestFile("tests/helper.py"), true);
    assert.equal(isPythonTestFile("test/unit/foo.py"), true);
    assert.equal(isPythonTestFile("testing/integration.py"), true);
  });

  test("does not detect non-test python files", () => {
    assert.equal(isPythonTestFile("setup.py"), false);
    assert.equal(isPythonTestFile("main.py"), false);
    assert.equal(isPythonTestFile("src/app.py"), false);
    assert.equal(isPythonTestFile("test_notes.md"), false);
    assert.equal(isPythonTestFile("tests/test.txt"), false);
  });

  test("findPythonTestFiles filters list correctly", () => {
    const files = [
      "setup.py",
      "my_pkg/__init__.py",
      "my_pkg/core.py",
      "tests/test_core.py",
      "tests/test_cli.py",
    ];
    assert.deepEqual(findPythonTestFiles(files), [
      "tests/test_core.py",
      "tests/test_cli.py",
    ]);
  });
});

describe("script-detector: pytest collect exit code 5 (Requirement 11.10)", () => {
  test("isPytestCollectExitCode5 returns true for 5, false otherwise", () => {
    assert.equal(isPytestCollectExitCode5(5), true);
    assert.equal(isPytestCollectExitCode5(0), false);
    assert.equal(isPytestCollectExitCode5(1), false);
  });

  test("evaluatePytestCollect returns M13 finding on exit code 5", () => {
    const res = evaluatePytestCollect(5);
    assert.equal(res.noTestsFound, true);
    assert.equal(res.ruleId, NO_TESTS_FOUND_RULE_ID);
    assert.equal(res.label, NO_TESTS_FOUND_LABEL);
    assert.ok(res.record);
    assert.equal(res.record.ruleId, "M13");
    assert.equal(res.record.title, "No tests found");
    assert.equal(res.record.status, "No tests found");
    assert.match(res.reason ?? "", /pytest --collect-only exit code 5/);
  });

  test("evaluatePytestCollect returns noTestsFound: false on other exit codes", () => {
    const res = evaluatePytestCollect(0);
    assert.equal(res.noTestsFound, false);
    assert.equal(res.ruleId, undefined);
  });
});

describe("script-detector: Node manifest inspection (Requirements 11.5, 11.6, 11.8, 11.9, 11.10)", () => {
  test("Requirement 11.6: npm install passes --ignore-scripts", () => {
    const pkg = { name: "sample" };
    const res = inspectNodeManifest(pkg);
    assert.deepEqual(res.installCommand, [
      "npm",
      "install",
      "--ignore-scripts",
    ]);
    assert.ok(res.installCommand.includes("--ignore-scripts"));
  });

  test("Requirement 11.8: lockfile aware install and retry", () => {
    const pkg = { name: "sample" };
    const res = inspectNodeManifest(pkg, [
      "package.json",
      "package-lock.json",
    ]);
    assert.equal(res.lockFile, "package-lock.json");
    assert.deepEqual(res.installCommand, ["npm", "ci", "--ignore-scripts"]);
    assert.deepEqual(res.installRetryCommand, [
      "npm",
      "install",
      "--ignore-scripts",
    ]);
  });

  test("Requirement 11.9: marks build not run when no build script exists", () => {
    const pkgWithoutBuild = {
      name: "sample",
      scripts: { test: "jest" },
    };
    const res = inspectNodeManifest(pkgWithoutBuild);
    assert.equal(res.build.hasBuildScript, false);
    assert.equal(res.build.status, "not run");
    assert.equal(res.build.reason, "no build script");
    assert.equal(res.build.command, undefined);
  });

  test("Requirement 11.9: detects build script when present", () => {
    const pkgWithBuild = {
      name: "sample",
      scripts: { build: "tsc -p tsconfig.json" },
    };
    const res = inspectNodeManifest(pkgWithBuild);
    assert.equal(res.build.hasBuildScript, true);
    assert.equal(res.build.status, undefined);
    assert.deepEqual(res.build.command, ["npm", "run", "build"]);
    assert.equal(res.build.commandLine, "npm run build");
  });

  test("Requirement 11.10: records No tests found with M13 when scripts.test is missing", () => {
    const pkgNoTest = {
      name: "sample",
      scripts: {},
    };
    const res = inspectNodeManifest(pkgNoTest);
    assert.equal(res.test.hasTests, false);
    assert.equal(res.test.noTestsFound, true);
    assert.equal(res.test.ruleId, "M13");
    assert.ok(res.test.record);
    assert.equal(res.test.record.ruleId, "M13");
    assert.equal(res.test.record.title, "No tests found");
    assert.equal(res.test.record.reason, "package.json has no test script");
  });

  test("Requirement 11.10: records No tests found with M13 when scripts.test is default placeholder", () => {
    const pkgPlaceholder = {
      name: "sample",
      scripts: {
        test: 'echo "Error: no test specified" && exit 1',
      },
    };
    const res = inspectNodeManifest(pkgPlaceholder);
    assert.equal(res.test.hasTests, false);
    assert.equal(res.test.noTestsFound, true);
    assert.equal(res.test.isPlaceholder, true);
    assert.equal(res.test.ruleId, "M13");
    assert.ok(res.test.record);
    assert.equal(res.test.record.ruleId, "M13");
    assert.equal(res.test.record.title, "No tests found");
    assert.equal(
      res.test.record.reason,
      "package.json test script is default placeholder"
    );
  });

  test("detects valid test script in Node", () => {
    const pkgValidTest = {
      name: "sample",
      scripts: {
        test: "vitest run",
      },
    };
    const res = inspectNodeManifest(pkgValidTest);
    assert.equal(res.test.hasTests, true);
    assert.equal(res.test.noTestsFound, false);
    assert.equal(res.test.ruleId, undefined);
    assert.deepEqual(res.test.testCommand, ["npm", "test"]);
  });
});

describe("script-detector: Python manifest inspection (Requirements 11.7, 11.9, 11.10)", () => {
  test("Requirement 11.7: selects poetry when poetry.lock is present", () => {
    const files = ["pyproject.toml", "poetry.lock", "tests/test_core.py"];
    const res = inspectPythonManifests(files);
    assert.equal(res.packageManager, "poetry");
    assert.deepEqual(res.installCommand, ["poetry", "install"]);
    assert.deepEqual(res.versionCommands, [
      ["python3", "--version"],
      ["poetry", "--version"],
    ]);
  });

  test("Requirement 11.7: selects poetry when pyproject.toml contains [tool.poetry]", () => {
    const files = [
      {
        path: "pyproject.toml",
        content: "[tool.poetry]\nname = 'demo'\nversion = '0.1.0'",
      },
      { path: "tests/test_demo.py", content: "def test_ok(): pass" },
    ];
    const res = inspectPythonManifests(files);
    assert.equal(res.packageManager, "poetry");
    assert.deepEqual(res.installCommand, ["poetry", "install"]);
  });

  test("Requirement 11.7: selects pip when requirements.txt is present", () => {
    const files = ["requirements.txt", "setup.py", "tests/test_pkg.py"];
    const res = inspectPythonManifests(files);
    assert.equal(res.packageManager, "pip");
    assert.deepEqual(res.installCommand, [
      "pip",
      "install",
      "-r",
      "requirements.txt",
    ]);
    assert.deepEqual(res.versionCommands, [
      ["python3", "--version"],
      ["pip", "--version"],
    ]);
  });

  test("Requirement 11.9: marks build not run when no build script exists", () => {
    const files = ["requirements.txt", "tests/test_pkg.py"];
    const res = inspectPythonManifests(files);
    assert.equal(res.build.hasBuildScript, false);
    assert.equal(res.build.status, "not run");
    assert.equal(res.build.reason, "no build script");
  });

  test("Requirement 11.10: records No tests found with M13 when no test files exist", () => {
    const files = ["setup.py", "pkg/__init__.py", "pkg/main.py"];
    const res = inspectPythonManifests(files);
    assert.equal(res.test.hasTests, false);
    assert.equal(res.test.noTestsFound, true);
    assert.equal(res.test.ruleId, "M13");
    assert.ok(res.test.record);
    assert.equal(res.test.record.ruleId, "M13");
    assert.equal(res.test.record.title, "No tests found");
    assert.equal(res.test.record.reason, "no test files found");
  });

  test("Requirement 11.10: test command set to pytest when test files exist", () => {
    const files = ["setup.py", "tests/test_feature.py"];
    const res = inspectPythonManifests(files);
    assert.equal(res.test.hasTests, true);
    assert.equal(res.test.noTestsFound, false);
    assert.equal(res.test.ruleId, undefined);
    assert.deepEqual(res.test.testCommand, ["pytest"]);
    assert.equal(res.test.testCommandLine, "pytest");
  });
});

describe("script-detector: repository-level inspection", () => {
  test("inspects Node repository with package.json string", () => {
    const res = inspectRepositoryManifests({
      packageJson: JSON.stringify({
        name: "test-node",
        scripts: { build: "next build", test: "jest" },
      }),
      files: ["package.json", "package-lock.json", "src/index.ts"],
    });

    assert.deepEqual(res.languages, ["node"]);
    assert.equal(res.primaryLanguage, "node");
    assert.equal(res.packageManager, "npm");
    assert.equal(res.build.hasBuildScript, true);
    assert.equal(res.test.hasTests, true);
    assert.equal(res.test.noTestsFound, false);
  });

  test("inspects Python repository with files map", () => {
    const files = new Map([
      ["requirements.txt", "pytest>=7.0"],
      ["app.py", "print(1)"],
    ]);

    const res = inspectRepositoryManifests(files);
    assert.deepEqual(res.languages, ["python"]);
    assert.equal(res.primaryLanguage, "python");
    assert.equal(res.packageManager, "pip");
    assert.equal(res.build.hasBuildScript, false);
    assert.equal(res.build.status, "not run");
    assert.equal(res.test.hasTests, false);
    assert.equal(res.test.noTestsFound, true);
    assert.equal(res.test.ruleId, "M13");
  });

  test("handles empty repository gracefully", () => {
    const res = inspectRepositoryManifests([]);
    assert.deepEqual(res.languages, []);
    assert.equal(res.primaryLanguage, "unknown");
    assert.equal(res.build.hasBuildScript, false);
    assert.equal(res.build.status, "not run");
    assert.equal(res.test.noTestsFound, true);
    assert.equal(res.test.ruleId, "M13");
  });
});

describe("script-detector: Requirement 11.8 helper", () => {
  test("markStepsNotRunOnInstallFailure marks build and tests not run when both fail", () => {
    const res = markStepsNotRunOnInstallFailure(true, true);
    assert.ok(res);
    assert.equal(res.buildStatus, "not run");
    assert.equal(res.testStatus, "not run");
  });

  test("returns null if install or retry succeeded", () => {
    assert.equal(markStepsNotRunOnInstallFailure(false, false), null);
    assert.equal(markStepsNotRunOnInstallFailure(true, false), null);
  });
});
