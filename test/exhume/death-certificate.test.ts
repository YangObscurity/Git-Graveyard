import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";
import {
  classifyFailures,
  computeDeathCertificateSha256,
  createDeathCertificate,
  deserializeDeathCertificate,
  extractFailureExcerpt,
  formatDeathCertificateTable,
  isRepositoryHealthy,
  loadDeathCertificate,
  saveDeathCertificate,
  serializeDeathCertificate,
  type BaselineCommandRow,
} from "../../lib/exhume/death-certificate";
import { NO_TESTS_FOUND_LABEL, NO_TESTS_FOUND_RULE_ID } from "../../lib/exhume/types";

describe("death-certificate: creation and serialization", () => {
  test("creates a valid DeathCertificate with sha256 hash", () => {
    const installRow: BaselineCommandRow = {
      step: "install",
      command: "npm ci --ignore-scripts",
      status: "passed",
      exitCode: 0,
      durationMs: 1200,
    };
    const buildRow: BaselineCommandRow = {
      step: "build",
      command: "npm run build",
      status: "passed",
      exitCode: 0,
      durationMs: 3400,
    };
    const testRow: BaselineCommandRow = {
      step: "test",
      command: "npm test",
      status: "passed",
      exitCode: 0,
      durationMs: 2100,
    };

    const cert = createDeathCertificate({
      baseSha: "abc1234def5678",
      runId: "run-001",
      primaryLanguage: "node",
      packageManager: "npm",
      install: installRow,
      build: buildRow,
      test: testRow,
    });

    assert.equal(cert.schemaVersion, "v1");
    assert.equal(cert.baseSha, "abc1234def5678");
    assert.equal(cert.runId, "run-001");
    assert.equal(cert.primaryLanguage, "node");
    assert.equal(cert.packageManager, "npm");
    assert.equal(cert.healthy, true);
    assert.equal(typeof cert.sha256, "string");
    assert.equal(cert.sha256.length, 64);
    assert.deepEqual(cert.failureClasses, []);
  });

  test("serializes and deserializes cleanly", () => {
    const cert = createDeathCertificate({
      baseSha: "deadbeef1234",
      runId: "run-002",
      primaryLanguage: "python",
      packageManager: "poetry",
      install: {
        step: "install",
        command: "poetry install",
        status: "passed",
        exitCode: 0,
      },
      build: {
        step: "build",
        command: "build",
        status: "not run",
        reason: "no build script",
      },
      test: {
        step: "test",
        command: "pytest",
        status: "passed",
        exitCode: 0,
      },
    });

    const json = serializeDeathCertificate(cert);
    const parsed = deserializeDeathCertificate(json);

    assert.equal(parsed.baseSha, cert.baseSha);
    assert.equal(parsed.healthy, true);
    assert.equal(parsed.sha256, cert.sha256);
    assert.equal(parsed.primaryLanguage, "python");
    assert.equal(parsed.packageManager, "poetry");
  });

  test("computes deterministic SHA-256 independent of key ordering", () => {
    const objA = { a: 1, b: "two", c: [1, 2] };
    const objB = { c: [1, 2], b: "two", a: 1 };
    const hashA = computeDeathCertificateSha256(objA);
    const hashB = computeDeathCertificateSha256(objB);
    assert.equal(hashA, hashB);
  });
});

describe("death-certificate: failure classification", () => {
  test("classifies install failure with missing dependency", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "install",
        command: "npm ci --ignore-scripts",
        status: "failed",
        exitCode: 1,
        errorExcerpt: "npm ERR! Cannot find module 'left-pad'",
      },
      {
        step: "build",
        command: "npm run build",
        status: "not run",
        reason: "install failed and install retry failed",
      },
      {
        step: "test",
        command: "npm test",
        status: "not run",
        reason: "install failed and install retry failed",
      },
    ];

    const result = classifyFailures(rows);
    assert.ok(result.failureClasses.includes("install_failed"));
    assert.ok(result.failureClasses.includes("missing_dependency"));
  });

  test("classifies peer dependency conflict", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "install",
        command: "npm install --ignore-scripts",
        status: "failed",
        exitCode: 1,
        errorExcerpt: "npm ERR! ERESOLVE unable to resolve dependency tree",
      },
    ];

    const result = classifyFailures(rows);
    assert.ok(result.failureClasses.includes("install_failed"));
    assert.ok(result.failureClasses.includes("peer_dependency_conflict"));
  });

  test("classifies syntax error and type error during build", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "install",
        command: "npm ci --ignore-scripts",
        status: "passed",
        exitCode: 0,
      },
      {
        step: "build",
        command: "npm run build",
        status: "failed",
        exitCode: 2,
        errorExcerpt: "SyntaxError: Unexpected token '<' at line 4\nTS2304: Cannot find name 'foo'",
      },
      {
        step: "test",
        command: "npm test",
        status: "passed",
        exitCode: 0,
      },
    ];

    const result = classifyFailures(rows);
    assert.ok(result.failureClasses.includes("build_failed"));
    assert.ok(result.failureClasses.includes("syntax_error"));
    assert.ok(result.failureClasses.includes("type_error"));
  });

  test("classifies test failure and assertion error", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "test",
        command: "pytest",
        status: "failed",
        exitCode: 1,
        errorExcerpt: "AssertionError: assert 1 == 2",
      },
    ];

    const result = classifyFailures(rows);
    assert.ok(result.failureClasses.includes("test_failed"));
    assert.ok(result.failureClasses.includes("assertion_error"));
  });

  test("classifies No tests found with M13", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "test",
        command: "npm test",
        status: NO_TESTS_FOUND_LABEL,
        ruleId: NO_TESTS_FOUND_RULE_ID,
        noTestsFound: true,
        reason: "package.json has no test script",
      },
    ];

    const result = classifyFailures(rows);
    assert.ok(result.failureClasses.includes("no_tests"));
    const noTestItem = result.failures.find((f) => f.class === "no_tests");
    assert.equal(noTestItem?.ruleId, NO_TESTS_FOUND_RULE_ID);
  });

  test("classifies timeout and oom killed", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "build",
        command: "npm run build",
        status: "failed",
        timedOut: true,
        reason: "time limit",
      },
      {
        step: "test",
        command: "npm test",
        status: "failed",
        oomKilled: true,
      },
    ];

    const result = classifyFailures(rows);
    assert.ok(result.failureClasses.includes("time_limit"));
    assert.ok(result.failureClasses.includes("oom_killed"));
  });
});

describe("death-certificate: healthy repository checks", () => {
  test("returns healthy: true when install, build, and tests pass (Requirement 11.15)", () => {
    const install: BaselineCommandRow = { step: "install", command: "install", status: "passed" };
    const build: BaselineCommandRow = { step: "build", command: "build", status: "passed" };
    const testRow: BaselineCommandRow = { step: "test", command: "test", status: "passed" };

    assert.equal(isRepositoryHealthy(install, build, testRow), true);
  });

  test("returns healthy: true when build has no script but install and tests pass", () => {
    const install: BaselineCommandRow = { step: "install", command: "install", status: "passed" };
    const build: BaselineCommandRow = {
      step: "build",
      command: "build",
      status: "not run",
      reason: "no build script",
    };
    const testRow: BaselineCommandRow = { step: "test", command: "test", status: "passed" };

    assert.equal(isRepositoryHealthy(install, build, testRow), true);
  });

  test("returns healthy: false when any step failed", () => {
    const install: BaselineCommandRow = { step: "install", command: "install", status: "failed" };
    const build: BaselineCommandRow = { step: "build", command: "build", status: "passed" };
    const testRow: BaselineCommandRow = { step: "test", command: "test", status: "passed" };

    assert.equal(isRepositoryHealthy(install, build, testRow), false);
  });
});

describe("death-certificate: table formatting and persistence", () => {
  test("formats ASCII/Markdown table with all baseline rows", () => {
    const cert = createDeathCertificate({
      baseSha: "11223344",
      install: {
        step: "install",
        command: "npm ci --ignore-scripts",
        status: "passed",
        exitCode: 0,
      },
      build: {
        step: "build",
        command: "npm run build",
        status: "passed",
        exitCode: 0,
      },
      test: {
        step: "test",
        command: "npm test",
        status: NO_TESTS_FOUND_LABEL,
        ruleId: NO_TESTS_FOUND_RULE_ID,
        reason: "placeholder",
      },
    });

    const table = formatDeathCertificateTable(cert);
    assert.ok(table.includes("| Step"));
    assert.ok(table.includes("npm ci --ignore-scripts"));
    assert.ok(table.includes("No tests found"));
    assert.ok(table.includes("Rule: M13"));
  });

  test("saves and loads death-certificate.json to disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-test-"));
    try {
      const cert = createDeathCertificate({
        baseSha: "ffeedd0011",
        runId: "run-persist-01",
        primaryLanguage: "node",
        packageManager: "npm",
        install: {
          step: "install",
          command: "npm ci --ignore-scripts",
          status: "passed",
          exitCode: 0,
        },
        build: {
          step: "build",
          command: "build",
          status: "not run",
          reason: "no build script",
        },
        test: {
          step: "test",
          command: "npm test",
          status: "passed",
          exitCode: 0,
        },
      });

      const savedPath = await saveDeathCertificate(cert, tmpDir);
      assert.ok(fs.existsSync(savedPath));

      const loaded = await loadDeathCertificate(tmpDir);
      assert.equal(loaded.baseSha, "ffeedd0011");
      assert.equal(loaded.sha256, cert.sha256);
      assert.equal(loaded.healthy, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("extractFailureExcerpt limits lines and characters safely", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const excerpt = extractFailureExcerpt(longText, 3, 50);
    assert.equal(excerpt.split("\n").length, 3);
    assert.ok(excerpt.length <= 53); // max 50 plus ellipsis
  });
});
