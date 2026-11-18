import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PROBE_TABLE, getProbeMap } from "../../scripts/phase0/runner";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHECKS_DIR = path.resolve(REPO_ROOT, "scripts/phase0/checks");
const PROBE_IDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"] as const;

describe("Phase 0 Probe Check Scripts (P1 to P9)", () => {
  it("verifies each script from P1.sh to P9.sh exists in scripts/phase0/checks/", () => {
    for (const id of PROBE_IDS) {
      const scriptPath = path.join(CHECKS_DIR, `${id}.sh`);
      assert.ok(
        fs.existsSync(scriptPath),
        `Expected check script to exist: scripts/phase0/checks/${id}.sh`
      );
      const stat = fs.statSync(scriptPath);
      assert.ok(stat.isFile(), `Expected ${id}.sh to be a file`);
    }
  });

  it("verifies each script from P1.sh to P9.sh passes bash -n syntax check", () => {
    for (const id of PROBE_IDS) {
      const scriptPath = path.join(CHECKS_DIR, `${id}.sh`);
      assert.doesNotThrow(() => {
        execFileSync("bash", ["-n", scriptPath], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }, `bash -n failed on scripts/phase0/checks/${id}.sh`);
    }
  });

  it("verifies runner.ts PROBE_TABLE references each check script for P1 to P9", () => {
    const probeMap = getProbeMap(PROBE_TABLE);
    for (const id of PROBE_IDS) {
      const entry = probeMap.get(id);
      assert.ok(entry, `Entry not found in PROBE_TABLE for ${id}`);
      const expectedCommand = `bash scripts/phase0/checks/${id}.sh`;
      assert.equal(
        entry.command.trim(),
        expectedCommand,
        `Expected ${id} command in runner.ts to be "${expectedCommand}"`
      );
    }
  });

  it("verifies P13 and S5 are configured with their own check scripts", () => {
    const probeMap = getProbeMap(PROBE_TABLE);
    const p13 = probeMap.get("P13");
    const s5 = probeMap.get("S5");

    assert.ok(p13, "P13 entry must exist in PROBE_TABLE");
    assert.equal(p13.command, "bash scripts/phase0/checks/P13.sh");
    assert.equal(p13.isOperatorCheck, true);

    assert.ok(s5, "S5 entry must exist in PROBE_TABLE");
    assert.equal(s5.command, "bash scripts/phase0/checks/S5.sh");
    assert.equal(s5.isOperatorCheck, true);

    for (const script of ["P13.sh", "S5.sh"]) {
      const scriptPath = path.join(CHECKS_DIR, script);
      assert.ok(fs.existsSync(scriptPath), `Expected check script to exist: ${script}`);
      assert.doesNotThrow(() => {
        execFileSync("bash", ["-n", scriptPath], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }, `bash -n failed on scripts/phase0/checks/${script}`);
    }
  });

  it("verifies commands are distinct and not reused across P1 to P9", () => {
    const probeMap = getProbeMap(PROBE_TABLE);
    const commands = new Set<string>();

    for (const id of PROBE_IDS) {
      const entry = probeMap.get(id);
      assert.ok(entry, `Entry not found for ${id}`);
      assert.ok(!commands.has(entry.command), `Command reused: ${entry.command}`);
      commands.add(entry.command);
    }

    assert.equal(commands.size, PROBE_IDS.length);
  });

  it("verifies each script exits INCONCLUSIVE with needs-owner-run when preconditions are missing", () => {
    const tmpEvidence = fs.mkdtempSync(path.join(REPO_ROOT, ".tmp-evidence-"));
    try {
      for (const id of PROBE_IDS) {
        const scriptPath = path.join(CHECKS_DIR, `${id}.sh`);
        let exitCode: number | null = null;
        let stdout = "";
        let stderr = "";

        try {
          stdout = execFileSync("bash", [scriptPath], {
            cwd: REPO_ROOT,
            env: {
              NODE_ENV: "test",
              PATH: "/usr/local/bin:/usr/bin:/bin",
              HOME: path.join(tmpEvidence, "home"),
              EVIDENCE_DIR: path.join(tmpEvidence, id),
              EVIDENCE_PATH: path.join(tmpEvidence, id, "transcript.txt"),
              // Explicitly unset binary and key variables
              KIRO_CLI_BIN: "",
              KIRO_API_KEY: "",
            } as NodeJS.ProcessEnv,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          exitCode = 0;
        } catch (err: any) {
          exitCode = err.status;
          stdout = err.stdout?.toString() || "";
          stderr = err.stderr?.toString() || "";
        }

        assert.notEqual(
          exitCode,
          0,
          `Expected ${id}.sh to exit non-zero when preconditions are missing, got ${exitCode}`
        );
        assert.match(
          stdout,
          /^INCONCLUSIVE: needs-owner-run/m,
          `Expected ${id}.sh stdout to print INCONCLUSIVE: needs-owner-run`
        );
      }
    } finally {
      fs.rmSync(tmpEvidence, { recursive: true, force: true });
    }
  });
});

const PROBE_IDS_P10_P17 = ["P10", "P11", "P12", "P13", "P14", "P15", "P16", "P17"] as const;
const CONFIGURED_PROBE_IDS_P10_P17 = ["P10", "P11", "P12", "P14", "P15", "P16", "P17"] as const;
const SPIKE_IDS_S1_S4 = ["S1", "S2", "S3", "S4"] as const;

describe("Phase 0 Probe Check Scripts (P10 to P17) and Spikes (S1 to S4)", () => {
  it("verifies each script from P10.sh to P17.sh exists in scripts/phase0/checks/", () => {
    for (const id of PROBE_IDS_P10_P17) {
      const scriptPath = path.join(CHECKS_DIR, `${id}.sh`);
      assert.ok(
        fs.existsSync(scriptPath),
        `Expected check script to exist: scripts/phase0/checks/${id}.sh`
      );
      const stat = fs.statSync(scriptPath);
      assert.ok(stat.isFile(), `Expected ${id}.sh to be a file`);
    }
  });

  it("verifies each spike script from S1.ts to S4.ts exists in scripts/phase0/checks/", () => {
    for (const id of SPIKE_IDS_S1_S4) {
      const scriptPath = path.join(CHECKS_DIR, `${id}.ts`);
      assert.ok(
        fs.existsSync(scriptPath),
        `Expected spike script to exist: scripts/phase0/checks/${id}.ts`
      );
      const stat = fs.statSync(scriptPath);
      assert.ok(stat.isFile(), `Expected ${id}.ts to be a file`);
    }
  });

  it("verifies each script from P10.sh to P17.sh passes bash -n syntax check", () => {
    for (const id of PROBE_IDS_P10_P17) {
      const scriptPath = path.join(CHECKS_DIR, `${id}.sh`);
      assert.doesNotThrow(() => {
        execFileSync("bash", ["-n", scriptPath], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }, `bash -n failed on scripts/phase0/checks/${id}.sh`);
    }
  });

  it("verifies runner.ts PROBE_TABLE references each check script for P10 to P12, P14 to P17", () => {
    const probeMap = getProbeMap(PROBE_TABLE);
    for (const id of CONFIGURED_PROBE_IDS_P10_P17) {
      const entry = probeMap.get(id);
      assert.ok(entry, `Entry not found in PROBE_TABLE for ${id}`);
      const expectedCommand = `bash scripts/phase0/checks/${id}.sh`;
      assert.equal(
        entry.command.trim(),
        expectedCommand,
        `Expected ${id} command in runner.ts to be "${expectedCommand}"`
      );
    }
  });

  it("verifies runner.ts PROBE_TABLE references each spike script for S1 to S4", () => {
    const probeMap = getProbeMap(PROBE_TABLE);
    for (const id of SPIKE_IDS_S1_S4) {
      const entry = probeMap.get(id);
      assert.ok(entry, `Entry not found in PROBE_TABLE for ${id}`);
      const expectedCommand = `tsx scripts/phase0/checks/${id}.ts`;
      assert.equal(
        entry.command.trim(),
        expectedCommand,
        `Expected ${id} command in runner.ts to be "${expectedCommand}"`
      );
    }
  });

  it("verifies P13 and S5 are configured with their own check scripts", () => {
    const probeMap = getProbeMap(PROBE_TABLE);
    const p13 = probeMap.get("P13");
    const s5 = probeMap.get("S5");

    assert.ok(p13, "P13 entry must exist in PROBE_TABLE");
    assert.equal(p13.command, "bash scripts/phase0/checks/P13.sh");
    assert.equal(p13.isOperatorCheck, true);

    assert.ok(s5, "S5 entry must exist in PROBE_TABLE");
    assert.equal(s5.command, "bash scripts/phase0/checks/S5.sh");
    assert.equal(s5.isOperatorCheck, true);
  });

  it("verifies commands are distinct and not reused across all configured probes and spikes", () => {
    const probeMap = getProbeMap(PROBE_TABLE);
    const commands = new Set<string>();

    const allConfigured = [
      ...PROBE_IDS,
      ...CONFIGURED_PROBE_IDS_P10_P17,
      ...SPIKE_IDS_S1_S4,
    ];

    for (const id of allConfigured) {
      const entry = probeMap.get(id);
      assert.ok(entry, `Entry not found for ${id}`);
      assert.ok(!commands.has(entry.command), `Command reused: ${entry.command}`);
      commands.add(entry.command);
    }

    assert.equal(commands.size, allConfigured.length);
  });

  it("verifies each probe script (P10 to P17, P13 excluded) exits INCONCLUSIVE with needs-owner-run when preconditions are missing", () => {
    const tmpEvidence = fs.mkdtempSync(path.join(REPO_ROOT, ".tmp-evidence-"));
    try {
      for (const id of CONFIGURED_PROBE_IDS_P10_P17) {
        const scriptPath = path.join(CHECKS_DIR, `${id}.sh`);
        let exitCode: number | null = null;
        let stdout = "";
        let stderr = "";

        try {
          stdout = execFileSync("bash", [scriptPath], {
            cwd: REPO_ROOT,
            env: {
              NODE_ENV: "test",
              PATH: "/usr/local/bin:/usr/bin:/bin",
              HOME: path.join(tmpEvidence, "home"),
              EVIDENCE_DIR: path.join(tmpEvidence, id),
              EVIDENCE_PATH: path.join(tmpEvidence, id, "transcript.txt"),
              // Explicitly unset binary and key variables
              KIRO_CLI_BIN: "",
              KIRO_API_KEY: "",
            } as NodeJS.ProcessEnv,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          exitCode = 0;
        } catch (err: any) {
          exitCode = err.status;
          stdout = err.stdout?.toString() || "";
          stderr = err.stderr?.toString() || "";
        }

        assert.notEqual(
          exitCode,
          0,
          `Expected ${id}.sh to exit non-zero when preconditions are missing, got ${exitCode}`
        );
        assert.match(
          stdout,
          /^INCONCLUSIVE: needs-owner-run/m,
          `Expected ${id}.sh stdout to print INCONCLUSIVE: needs-owner-run`
        );
      }
    } finally {
      fs.rmSync(tmpEvidence, { recursive: true, force: true });
    }
  });

  it("keeps S3 and S4 as live spikes: they must measure, not read a fixture or os.totalmem()", () => {
    // They run on the dev box (network, /proc, a real Kiro session); a local run
    // cannot execute them, so this guards against sliding back to the vacuous
    // versions that printed PASS without exhuming or measuring anything.
    const s3 = fs.readFileSync(path.join(CHECKS_DIR, "S3.ts"), "utf-8");
    assert.ok(s3.includes('"clone"') && s3.includes("npm"), "S3 must clone and install a candidate repo");
    assert.ok(!s3.includes("repos.json"), "S3 must not just parse the pinned fixture");
    const s4 = fs.readFileSync(path.join(CHECKS_DIR, "S4.ts"), "utf-8");
    assert.ok(s4.includes("/proc/meminfo") && s4.includes("AcpSession"), "S4 must sample memory while a real session runs");
    assert.ok(!/os\.totalmem\(\) <= 0/.test(s4), "S4 must not decide from os.totalmem()");
  });

  it("verifies spikes S1 and S2 report INCONCLUSIVE when no Kiro CLI or login is available", () => {
    const tmpEvidence = fs.mkdtempSync(path.join(REPO_ROOT, ".tmp-evidence-"));
    try {
      for (const id of ["S1", "S2"] as const) {
        const scriptPath = path.join(CHECKS_DIR, `${id}.ts`);
        let exitCode: number | null = null;
        let stdout = "";

        try {
          stdout = execFileSync("npx", ["tsx", scriptPath], {
            cwd: REPO_ROOT,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              NODE_ENV: "test",
              PATH: "/usr/local/bin:/usr/bin:/bin",
              HOME: path.join(tmpEvidence, "home"),
              EVIDENCE_DIR: path.join(tmpEvidence, id),
              EVIDENCE_PATH: path.join(tmpEvidence, id, "transcript.txt"),
              KIRO_CLI_BIN: "",
              KIRO_API_KEY: "",
            } as NodeJS.ProcessEnv,
          });
          exitCode = 0;
        } catch (err: any) {
          exitCode = err.status;
          stdout = err.stdout?.toString() || "";
        }

        assert.notEqual(
          exitCode,
          0,
          `Expected ${id}.ts to exit non-zero when Kiro is unavailable, got ${exitCode}`
        );
        assert.match(
          stdout,
          /^INCONCLUSIVE: needs-owner-run/m,
          `Expected ${id}.ts stdout to print INCONCLUSIVE: needs-owner-run`
        );
      }
    } finally {
      fs.rmSync(tmpEvidence, { recursive: true, force: true });
    }
  });

  it("verifies P13 exits INCONCLUSIVE when asked to assess without being armed", () => {
    const tmpEvidence = fs.mkdtempSync(path.join(REPO_ROOT, ".tmp-evidence-"));
    try {
      const scriptPath = path.join(CHECKS_DIR, "P13.sh");
      let exitCode: number | null = null;
      let stdout = "";

      try {
        stdout = execFileSync("bash", [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            NODE_ENV: "test",
            PATH: "/usr/bin:/bin",
            HOME: path.join(tmpEvidence, "home"),
            EVIDENCE_DIR: path.join(tmpEvidence, "P13"),
            EVIDENCE_PATH: path.join(tmpEvidence, "P13", "transcript.txt"),
            PHASE0_P13_MODE: "assess",
            PHASE0_P13_STATE_DIR: path.join(tmpEvidence, "state"),
            KIRO_API_KEY: "",
          } as NodeJS.ProcessEnv,
        });
        exitCode = 0;
      } catch (err: any) {
        exitCode = err.status;
        stdout = err.stdout?.toString() || "";
      }

      assert.notEqual(exitCode, 0, "P13 assess without a state file must not pass");
      assert.match(stdout, /^INCONCLUSIVE: needs-owner-run/m);
    } finally {
      fs.rmSync(tmpEvidence, { recursive: true, force: true });
    }
  });
});
