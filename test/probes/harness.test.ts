import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  PROBE_TABLE,
  RUN_ORDER,
  OPERATOR_CHECK_IDS,
  getProbeMap,
  getProbesInRunOrder,
  findRepoRoot,
  writeEvidenceFileExclusive,
  appendRunRecord,
  promptOperatorConfirmation,
  executeCommand,
  runProbe,
  verify,
  main,
  type ProbeEntry,
} from "../../scripts/phase0/runner";

describe("Phase 0 Harness: Runner Table", () => {
  it("defines exactly 22 probes and spikes in RUN_ORDER", () => {
    assert.equal(RUN_ORDER.length, 22);
    const expectedOrder = [
      "P1",
      "P4",
      "P15",
      "P3",
      "P6",
      "P7",
      "P2",
      "P5",
      "P12",
      "P9",
      "P8",
      "S4",
      "P13",
      "S5",
      "P14",
      "S1",
      "S2",
      "S3",
      "P11",
      "P10",
      "P16",
      "P17",
    ];
    assert.deepEqual(Array.from(RUN_ORDER), expectedOrder);
  });

  it("defines 22 entries in PROBE_TABLE matching RUN_ORDER IDs", () => {
    assert.equal(PROBE_TABLE.length, 22);
    const tableIds = new Set(PROBE_TABLE.map((e) => e.id));
    for (const id of RUN_ORDER) {
      assert.ok(tableIds.has(id), `Missing probe ID in table: ${id}`);
    }
  });

  it("identifies operator checks for P13 and S5 only", () => {
    assert.equal(OPERATOR_CHECK_IDS.size, 2);
    assert.ok(OPERATOR_CHECK_IDS.has("P13"));
    assert.ok(OPERATOR_CHECK_IDS.has("S5"));

    for (const entry of PROBE_TABLE) {
      if (entry.id === "P13" || entry.id === "S5") {
        assert.equal(entry.isOperatorCheck, true);
      } else {
        assert.notEqual(entry.isOperatorCheck, true);
      }
    }
  });

  it("getProbeMap returns entries keyed by ID", () => {
    const map = getProbeMap(PROBE_TABLE);
    assert.equal(map.size, 22);
    for (const entry of PROBE_TABLE) {
      assert.equal(map.get(entry.id), entry);
    }
  });

  it("getProbesInRunOrder returns entries strictly in RUN_ORDER sequence", () => {
    const ordered = getProbesInRunOrder(PROBE_TABLE, RUN_ORDER);
    assert.equal(ordered.length, RUN_ORDER.length);
    for (let i = 0; i < RUN_ORDER.length; i++) {
      assert.equal(ordered[i].id, RUN_ORDER[i]);
    }
  });

  it("getProbesInRunOrder throws when an ID is not in table", () => {
    assert.throws(
      () => getProbesInRunOrder([], ["P1"]),
      /Probe entry not found for ID: P1/
    );
  });
});

describe("Phase 0 Harness: Empty-Command Refusal", () => {
  it("refuses to run a probe when command is empty string", async () => {
    const entry: ProbeEntry = {
      id: "P1",
      title: "Test probe",
      command: "",
    };

    await assert.rejects(
      async () => {
        await runProbe(entry, { skipOperatorCheck: true });
      },
      (err: Error) => {
        assert.match(err.message, /Refusing to run P1: command is empty\./);
        return true;
      }
    );
  });

  it("refuses to run a probe when command contains only whitespace", async () => {
    const entry: ProbeEntry = {
      id: "P2",
      title: "Test probe with spaces",
      command: "   \t\n  ",
    };

    await assert.rejects(
      async () => {
        await runProbe(entry, { skipOperatorCheck: true });
      },
      (err: Error) => {
        assert.match(err.message, /Refusing to run P2: command is empty\./);
        return true;
      }
    );
  });
});

describe("Phase 0 Harness: Verify Path", () => {
  it("prints table and summary without running commands", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      verify(PROBE_TABLE, RUN_ORDER);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    assert.ok(output.includes("Phase 0 Probe and Spike Table (R4-19)"));
    assert.ok(output.includes("Empty Entries (0 of 22):"));
    assert.ok(output.includes("Total probes & spikes: 22"));
    assert.ok(output.includes("Configured commands:   22"));
    assert.ok(output.includes("Empty entries:         0"));
    assert.ok(output.includes("Operator checks:       2 (P13, S5)"));
    assert.ok(
      output.includes("Verification complete: all checks passed. No commands executed.")
    );
  });

  it("main with --verify runs verification and returns cleanly", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await main(["--verify"]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    assert.ok(output.includes("Phase 0 Probe and Spike Table (R4-19)"));
    assert.ok(
      output.includes("Verification complete: all checks passed. No commands executed.")
    );
  });

  it("main with --help shows usage", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await main(["--help"]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    assert.ok(output.includes("Usage: tsx scripts/phase0/runner.ts [options] [probe-ids...]"));
    assert.ok(output.includes("--verify"));
  });
});

describe("Phase 0 Harness: Transcript Path Layout and Appending", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-harness-"));
    fs.mkdirSync(path.join(tmpDir, "memory"), { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs command, captures stdout/stderr into evidence files, and appends to RUNS.md", async () => {
    const entry: ProbeEntry = {
      id: "P1",
      title: "Test probe execution",
      command: 'node -e "process.stdout.write(\'harness-out\'); process.stderr.write(\'harness-err\'); process.exit(0);"',
    };

    const dateStr = "2026-11-07";
    const res = await runProbe(entry, {
      rootDir: tmpDir,
      dateStr,
      skipOperatorCheck: true,
    });

    assert.equal(res.status, "passed");
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, "harness-out");
    assert.equal(res.stderr, "harness-err");

    const expectedEvidenceDir = path.resolve(tmpDir, "01_evidence", `phase0-${dateStr}`, "P1");
    assert.equal(res.evidenceDir, expectedEvidenceDir);
    assert.ok(fs.existsSync(path.join(expectedEvidenceDir, "stdout.txt")));
    assert.ok(fs.existsSync(path.join(expectedEvidenceDir, "stderr.txt")));

    const stdoutContent = fs.readFileSync(path.join(expectedEvidenceDir, "stdout.txt"), "utf-8");
    const stderrContent = fs.readFileSync(path.join(expectedEvidenceDir, "stderr.txt"), "utf-8");
    assert.equal(stdoutContent, "harness-out");
    assert.equal(stderrContent, "harness-err");

    const runsFile = path.resolve(tmpDir, "memory", "RUNS.md");
    assert.ok(fs.existsSync(runsFile));
    const runsContent = fs.readFileSync(runsFile, "utf-8");
    const lines = runsContent.trim().split("\n");
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.match(
      line,
      /^\| \d{4}-\d{2}-\d{2}T.* \| phase0-runner \| P1: Test probe execution \| passed \| `01_evidence\/phase0-2026-11-07\/P1\/` \|$/
    );
  });

  it("records failed status and exit code on non-zero command termination", async () => {
    const entry: ProbeEntry = {
      id: "P2",
      title: "Failing probe execution",
      command: 'node -e "process.stderr.write(\'fatal-failure\'); process.exit(7);"',
    };

    const dateStr = "2026-11-07";
    const res = await runProbe(entry, {
      rootDir: tmpDir,
      dateStr,
      skipOperatorCheck: true,
    });

    assert.equal(res.status, "failed");
    assert.equal(res.exitCode, 7);
    assert.equal(res.stderr, "fatal-failure");

    const runsFile = path.resolve(tmpDir, "memory", "RUNS.md");
    const runsContent = fs.readFileSync(runsFile, "utf-8");
    const lines = runsContent.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /failed \(exit code 7\)/);
  });

  it("appends multiple single lines consecutively without overwriting previous runs", async () => {
    const entry1: ProbeEntry = {
      id: "P1",
      title: "First probe",
      command: 'node -e "process.exit(0);"',
    };
    const entry2: ProbeEntry = {
      id: "P4",
      title: "Second probe",
      command: 'node -e "process.exit(0);"',
    };

    const dateStr = "2026-11-07";
    await runProbe(entry1, { rootDir: tmpDir, dateStr, skipOperatorCheck: true });
    await runProbe(entry2, { rootDir: tmpDir, dateStr, skipOperatorCheck: true });

    const runsFile = path.resolve(tmpDir, "memory", "RUNS.md");
    const lines = fs.readFileSync(runsFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /P1: First probe/);
    assert.match(lines[1], /P4: Second probe/);
  });

  it("writeEvidenceFileExclusive refuses to overwrite existing file", () => {
    const filePath = path.join(tmpDir, "test-exclusive.txt");
    writeEvidenceFileExclusive(filePath, "initial-content");
    assert.equal(fs.readFileSync(filePath, "utf-8"), "initial-content");

    assert.throws(
      () => writeEvidenceFileExclusive(filePath, "second-content"),
      /Refusing to overwrite existing file/
    );
  });

  it("appendRunRecord adds prefix newline if existing file lacks trailing newline", () => {
    const runsFile = path.join(tmpDir, "RUNS-custom.md");
    fs.writeFileSync(runsFile, "| header |", "utf-8");

    const entry: ProbeEntry = {
      id: "P1",
      title: "Sample title",
      command: "echo test",
    };

    appendRunRecord(runsFile, entry, "passed", "01_evidence/sample/", "2026-11-07T00:00:00.000Z");
    const content = fs.readFileSync(runsFile, "utf-8");
    assert.equal(
      content,
      "| header |\n| 2026-11-07T00:00:00.000Z | phase0-runner | P1: Sample title | passed | `01_evidence/sample/` |\n"
    );
  });

  it("promptOperatorConfirmation auto-confirms when stdin is non-interactive", async () => {
    const entry: ProbeEntry = {
      id: "P13",
      title: "Auto-pause kill",
      command: "",
      isOperatorCheck: true,
    };

    // Stdin is not a tty during tests, so this completes without blocking
    await promptOperatorConfirmation(entry);
    assert.ok(true);
  });

  it("executeCommand executes command and collects stdout, stderr, exitCode", async () => {
    const res = await executeCommand(
      'node -e "console.log(\'cmd-out\'); console.error(\'cmd-err\');"',
      tmpDir
    );
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout.trim(), "cmd-out");
    assert.equal(res.stderr.trim(), "cmd-err");
  });

  it("findRepoRoot locates package.json and .kiro", () => {
    const root = findRepoRoot(__dirname);
    assert.ok(fs.existsSync(path.join(root, "package.json")));
    assert.ok(fs.existsSync(path.join(root, ".kiro")));
  });
});
