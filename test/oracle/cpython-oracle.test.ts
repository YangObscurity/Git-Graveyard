// Task 19.3: CPython oracle harness for verified Python outputs.
// Runs `scripts/test-oracle.py` (CPython `ast.parse` with `feature_version=(3, 13)`)
// against every Python file the M1 rewrite pass labels `m1-clean`, and asserts
// that unmigrated Python 2 syntax still fails with explicit SyntaxError details.
// Validates: Requirements 9.3, 10.7 (design R3-9 "CI-only oracle").
import test, { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePython, initPythonParser } from "../../lib/rules/m1-python";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../..");
const oracleScript = path.join(repoRoot, "scripts", "test-oracle.py");
const fixturesDir = path.join(repoRoot, "test", "fixtures", "pinned");
const PYTHON = process.env.PYTHON ?? "python3";
const FEATURE_VERSION = "3.13";

interface OracleError {
  message: string;
  line: number;
  column: number;
  text?: string;
}

interface OracleRecord {
  ok: boolean;
  file: string;
  featureVersion: string;
  errors: OracleError[];
}

interface OracleRun {
  status: number;
  stdout: string;
  stderr: string;
  records: OracleRecord[];
}

function pythonAvailable(): boolean {
  try {
    const probe = spawnSync(PYTHON, ["-c", "print(1)"], { encoding: "utf8" });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

const hasPython = pythonAvailable();

/**
 * `it` options so that a missing CPython is reported as an explicit skip rather
 * than a silent pass that hides an untested oracle.
 */
const skipWhenNoPython: { skip?: boolean | string } = hasPython
  ? {}
  : { skip: "python3 interpreter unavailable" };

function runOracle(args: string[], stdin?: string, parseJson = true): OracleRun {
  const res = spawnSync(PYTHON, [oracleScript, ...args], {
    input: stdin,
    encoding: "utf8",
  });
  if (res.error) {
    throw new Error(`failed to run ${PYTHON}: ${res.error.message}`);
  }
  const stdout = res.stdout ?? "";
  const records: OracleRecord[] = [];
  if (parseJson) {
    for (const line of stdout.split("\n")) {
      if (line.trim().length === 0) continue;
      records.push(JSON.parse(line) as OracleRecord);
    }
  }
  return { status: res.status ?? -1, stdout, stderr: res.stderr ?? "", records };
}

function runOracleOnSource(source: string, filename: string): OracleRun {
  return runOracle(
    ["--stdin", "--filename", filename, "--json", "--feature-version", FEATURE_VERSION],
    source
  );
}

function listPythonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile() && entry.name.endsWith(".py")) found.push(relPath);
    }
  };
  walk(root, "");
  return found.sort();
}

function pythonFixtureDir(): string {
  const repos = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, "repos.json"), "utf8")
  ) as Array<{ repo: string; path: string }>;
  const entry = repos.find((item) => item.repo === "F-python2");
  assert.ok(entry, "the pinned F-python2 fixture must exist in repos.json");
  return path.join(fixturesDir, entry!.path);
}

describe("CPython oracle (Requirements 9.3, 10.7)", () => {
  before(async () => {
    if (hasPython) await initPythonParser();
  });

  it("ships a scripts/test-oracle.py that passes its own --self-test", skipWhenNoPython, () => {
    assert.ok(fs.existsSync(oracleScript), "scripts/test-oracle.py must exist");
    const run = runOracle(["--self-test"], undefined, false);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /self-test ok/);
  });

  it("reports featureVersion 3.13 on a CPython that supports it", skipWhenNoPython, () => {
    const run = runOracleOnSource("def f(x):\n    return x\n", "clean.py");
    assert.equal(run.records.length, 1);
    const record = run.records[0];
    assert.equal(record.ok, true);
    assert.deepEqual(record.errors, []);
    assert.match(record.featureVersion, /^3\.\d+$/);
    const minor = spawnSync(PYTHON, ["-c", "import sys; print(sys.version_info[1])"], {
      encoding: "utf8",
    }).stdout.trim();
    if (Number(minor) >= 13) {
      assert.equal(record.featureVersion, FEATURE_VERSION);
    }
  });

  it("accepts every Python file labelled m1-clean after the M1 rewrite pass", skipWhenNoPython, () => {
    const fixtureDir = pythonFixtureDir();
    const files = listPythonFiles(fixtureDir);
    assert.ok(files.length > 0, "the F-python2 fixture must ship Python files");

    const clean: Array<{ file: string; output: string }> = [];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(fixtureDir, rel), "utf8");
      const result = analyzePython(source, rel);
      if (result.label === "m1-clean") clean.push({ file: rel, output: result.output });
    }

    assert.ok(
      clean.length > 0,
      "at least one F-python2 file must be labelled m1-clean after the M1 rewrite pass"
    );

    for (const item of clean) {
      const run = runOracleOnSource(item.output, item.file);
      assert.equal(
        run.records.length,
        1,
        `oracle must report exactly one record for ${item.file}`
      );
      const record = run.records[0];
      assert.deepEqual(
        record.errors,
        [],
        `m1-clean output for ${item.file} must contain no SyntaxError`
      );
      assert.equal(record.ok, true, `m1-clean output for ${item.file} must pass the oracle`);
      assert.equal(run.status, 0);
    }
  });

  it("fails unmigrated Python 2 syntax with explicit SyntaxError details", skipWhenNoPython, () => {
    const cases: Array<{ name: string; source: string }> = [
      { name: "print-statement.py", source: 'print "hi"\n' },
      { name: "except-comma.py", source: "try:\n    pass\nexcept E, e:\n    pass\n" },
      { name: "octal.py", source: "x = 0755\n" },
      { name: "backtick.py", source: "x = `a`\n" },
      { name: "long-suffix.py", source: "x = 1L\n" },
      { name: "not-equal.py", source: "x = 1 <> 2\n" },
    ];

    for (const item of cases) {
      const run = runOracleOnSource(item.source, item.name);
      assert.equal(run.records.length, 1, `oracle must report one record for ${item.name}`);
      const record = run.records[0];
      assert.equal(record.ok, false, `${item.name} must fail the oracle`);
      assert.ok(
        record.errors.length >= 1,
        `${item.name} must report at least one SyntaxError`
      );
      const error = record.errors[0];
      assert.equal(typeof error.message, "string");
      assert.ok(error.message.length > 0, `${item.name} error must carry a message`);
      assert.ok(error.line >= 1, `${item.name} error must carry a 1-based line`);
      assert.equal(run.status, 1, `the oracle must exit non-zero when ${item.name} fails`);
    }
  });

  it("checks --file and --dir inputs and aggregates the JSON records", skipWhenNoPython, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"));
    try {
      const cleanPath = path.join(tmpDir, "clean.py");
      const brokenPath = path.join(tmpDir, "broken.py");
      fs.writeFileSync(cleanPath, "def f(x):\n    return x\n", "utf8");
      fs.writeFileSync(brokenPath, 'print "hi"\n', "utf8");

      const byFile = runOracle(["--file", cleanPath, "--file", brokenPath, "--json"]);
      assert.equal(byFile.records.length, 2);
      assert.equal(byFile.records[0].ok, true);
      assert.equal(byFile.records[1].ok, false);
      assert.equal(byFile.status, 1);

      const byDir = runOracle(["--dir", tmpDir, "--json", "--feature-version", FEATURE_VERSION]);
      assert.equal(byDir.records.length, 2);
      assert.deepEqual(
        byDir.records.map((record) => record.ok),
        [false, true]
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails an invalid UTF-8 file instead of silently replacing the bytes", skipWhenNoPython, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utf8-"));
    try {
      const badPath = path.join(tmpDir, "invalid-utf8.py");
      // `x = "\xff"` reads fine when invalid bytes are replaced with U+FFFD,
      // but must fail when the raw bytes are parsed as strict UTF-8.
      fs.writeFileSync(
        badPath,
        Buffer.from([0x78, 0x20, 0x3d, 0x20, 0x22, 0xff, 0x22, 0x0a])
      );
      const run = runOracle(["--file", badPath, "--json", "--feature-version", FEATURE_VERSION]);
      assert.equal(run.records.length, 1);
      const record = run.records[0];
      assert.equal(record.ok, false, "invalid UTF-8 must fail the oracle");
      assert.ok(record.errors.length >= 1, "the failure must carry an explicit error");
      assert.match(record.errors[0].message, /decode|invalid|utf-8/i);
      assert.equal(run.status, 1, "an invalid UTF-8 file exits with code 1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits with code 2 when a file target cannot be read", skipWhenNoPython, () => {
    const missing = path.join(
      os.tmpdir(),
      `oracle-missing-${process.pid}-${Date.now()}.py`
    );
    assert.equal(fs.existsSync(missing), false, "the probe path must not exist");
    const run = runOracle(["--file", missing, "--json"]);
    assert.equal(run.records.length, 1);
    assert.equal(run.records[0].ok, false);
    assert.match(run.records[0].errors[0].message, /unreadable/);
    assert.equal(run.status, 2, "an unreadable file target exits with code 2");
  });

  it("rejects a malformed --feature-version with a usage error", skipWhenNoPython, () => {
    const run = runOracle(
      ["--stdin", "--filename", "f.py", "--json", "--feature-version", "not-a-version"],
      "pass\n"
    );
    assert.equal(run.status, 2);
    assert.match(run.stderr, /feature version/);
  });
});
