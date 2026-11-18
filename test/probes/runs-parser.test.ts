import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEV_PROBES,
  PROD_PROBES,
  ALL_PROBE_IDS,
  parseRunsContent,
  parseRuns,
} from "../../lib/probes/runs-parser";

describe("Phase 0 Runs Parser: Constants", () => {
  it("defines 18 dev probes and 4 prod probes", () => {
    assert.equal(DEV_PROBES.length, 18);
    assert.equal(PROD_PROBES.length, 4);
    assert.equal(ALL_PROBE_IDS.length, 22);

    for (const id of DEV_PROBES) {
      assert.ok(ALL_PROBE_IDS.includes(id));
    }
    for (const id of PROD_PROBES) {
      assert.ok(ALL_PROBE_IDS.includes(id));
    }
  });
});

describe("Phase 0 Runs Parser: Missing Probes Handling", () => {
  it("marks all probes as not passed for empty content", () => {
    const results = parseRunsContent("");
    assert.equal(Object.keys(results).length, 22);

    for (const id of ALL_PROBE_IDS) {
      assert.equal(results[id].id, id);
      assert.equal(results[id].passed, false);
      assert.equal(results[id].outcome, "not_passed");
    }
  });

  it("marks unrecorded probes as not passed when only a subset is recorded", () => {
    const content = [
      "| P1 | pass |",
      "| S1 | ok |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, true);
    assert.equal(results.S1.passed, true);

    // Other probes must be not passed
    assert.equal(results.P2.passed, false);
    assert.equal(results.P2.outcome, "not_passed");
    assert.equal(results.P15.passed, false);
    assert.equal(results.S5.passed, false);
  });

  it("returns not passed for all probes when reading a non-existent file", () => {
    const results = parseRuns("path/does/not/exist/RUNS.md");
    assert.equal(Object.keys(results).length, 22);
    for (const id of ALL_PROBE_IDS) {
      assert.equal(results[id].passed, false);
      assert.equal(results[id].outcome, "not_passed");
    }
  });
});

describe("Phase 0 Runs Parser: Passing Tokens Recognition", () => {
  it("recognizes pass, passed, ok, success, and true tokens", () => {
    const content = [
      "| P1 | pass |",
      "| P2 | passed |",
      "| P3 | ok |",
      "| P4 | success |",
      "| P5 | true |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, true);
    assert.equal(results.P2.passed, true);
    assert.equal(results.P3.passed, true);
    assert.equal(results.P4.passed, true);
    assert.equal(results.P5.passed, true);
  });

  it("recognizes case-insensitive probe IDs and outcome tokens", () => {
    const content = [
      "| p1 | PASSED |",
      "| p12 | Ok |",
      "| s4 | SUCCESS |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, true);
    assert.equal(results.P12.passed, true);
    assert.equal(results.S4.passed, true);
  });

  it("handles multi-column table cells", () => {
    const content = [
      "| P1 | phase0-runner | Does kiro-cli work | passed | `01_evidence/P1/` |",
      "| S5 | phase0-runner | Box wake status | ok | `01_evidence/S5/` |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, true);
    assert.equal(results.P1.outcome, "passed");
    assert.equal(results.S5.passed, true);
    assert.equal(results.S5.outcome, "ok");
  });
});

describe("Phase 0 Runs Parser: Failing and Negated Outcomes", () => {
  it("recognizes fail, failed, not passed, not pass, error, and false", () => {
    const content = [
      "| P1 | fail |",
      "| P2 | failed |",
      "| P3 | failed (exit code 1) |",
      "| P4 | not passed |",
      "| P5 | not pass |",
      "| P6 | error: connection timeout |",
      "| P7 | false |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, false);
    assert.equal(results.P2.passed, false);
    assert.equal(results.P3.passed, false);
    assert.equal(results.P4.passed, false);
    assert.equal(results.P5.passed, false);
    assert.equal(results.P6.passed, false);
    assert.equal(results.P7.passed, false);
  });

  it("gives failure tokens precedence over pass tokens in the same row", () => {
    const content = [
      "| P1 | pass then failed |",
      "| P2 | ok | failed |",
      "| P3 | success | error |",
      "| P4 | passed | false |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, false);
    assert.equal(results.P2.passed, false);
    assert.equal(results.P3.passed, false);
    assert.equal(results.P4.passed, false);
  });
});

describe("Phase 0 Runs Parser: Parenthesised detail", () => {
  it("lets the leading status decide, not words inside the parentheses", () => {
    const content = [
      "| 2026-11-11T05:32:00Z | phase0-runner | P6: Do `ask` and `deny` behave as designed? | passed (2 permission requests; deny: no request and the write failed) | `01_evidence/P6/` |",
      "| 2026-11-11T05:33:00Z | phase0-runner | P7: x | failed (exit code 2; earlier attempt passed) | `01_evidence/P7/` |",
    ].join("\n");
    const results = parseRunsContent(content);
    assert.equal(results.P6.passed, true);
    assert.equal(results.P7.passed, false);
  });

  it("skips markdown separator rows", () => {
    const results = parseRunsContent("|---|---|---|\n| P1 | passed |");
    assert.equal(results["---"], undefined);
    assert.equal(results.P1.passed, true);
  });
});

describe("Phase 0 Runs Parser: Non-Table Lines and File Reading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-parser-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores headers, markdown prose and non-probe table rows", () => {
    const content = [
      "# Probe Results",
      "",
      "> Notes about probe run.",
      "",
      "| ID | Performer | Status |",
      "|---|---|---|",
      "| P1 | agent | pass |",
      "| UNKNOWN_CUSTOM | agent | pass |",
      "Some trailing text",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, true);
    assert.equal(results.P2.passed, false);
    assert.ok(results.UNKNOWN_CUSTOM);
    assert.equal(results.UNKNOWN_CUSTOM.passed, true);
  });

  it("reads and parses from an actual file on disk via parseRuns", () => {
    const runsFilePath = path.join(tmpDir, "RUNS.md");
    const fileContent = [
      "| P1 | pass |",
      "| P4 | failed |",
      "| P15 | ok |",
    ].join("\n");
    fs.writeFileSync(runsFilePath, fileContent, "utf-8");

    const results = parseRuns(runsFilePath);
    assert.equal(results.P1.passed, true);
    assert.equal(results.P4.passed, false);
    assert.equal(results.P15.passed, true);
    assert.equal(results.P2.passed, false);
  });
});

describe("Phase 0 Runs Parser: Runner Line Format", () => {
  it("reads the runner's own lines, where the action cell starts with the probe id", () => {
    const content = [
      "| 2026-11-11T06:00:00.000Z | phase0-runner | P1: Does kiro-cli work headless | passed | `01_evidence/phase0-2026-11-11/P1/` |",
      "| 2026-11-11T06:00:05.000Z | phase0-runner | P6: Permission options | failed (exit code 1) | `01_evidence/phase0-2026-11-11/P6/` |",
      "| 2026-11-11T06:00:09.000Z | phase0-runner | S5: Box wake | INCONCLUSIVE: needs-owner-run | `01_evidence/phase0-2026-11-11/S5/` |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P1.passed, true);
    assert.equal(results.P6.passed, false);
    assert.equal(results.S5.passed, false);
  });

  it("lets a later line override an earlier one for the same probe", () => {
    const content = [
      "| P13 | armed, inconclusive |",
      "| 2026-11-11T07:00:00.000Z | phase0-runner | P13: Auto-pause | PASS (observed gap 300s) | `01_evidence/phase0-2026-11-11/P13/` |",
    ].join("\n");

    const results = parseRunsContent(content);
    assert.equal(results.P13.passed, true);
  });
});


describe("Phase 0 Runs Parser: Journal Rows", () => {
  it("ignores a journal row whose first cell is only a timestamp", () => {
    const content =
      "| 2026-11-09T12:46Z | main-windows | merged three packages | passed | `x` |";

    const results = parseRunsContent(content);
    assert.equal(results["2026-11-09T12:46Z"], undefined);
    assert.equal(results.P1.passed, false);
  });
});

