import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PermissionBrokerAdapter,
  RequiredSettingError,
  decide,
  PermissionBrokerRequest,
} from "../../lib/broker/permission-broker";

describe("Work package SB6: watchdog comes only from the required watchdogLimitMs setting (audit M-3, residual)", () => {
  it("a missing watchdog setting throws a RequiredSettingError", () => {
    assert.throws(
      () => new PermissionBrokerAdapter({ settings: {} }),
      RequiredSettingError
    );
    assert.throws(() => new PermissionBrokerAdapter(), RequiredSettingError);
  });

  it("settings.timeoutMs is not used as the watchdog", () => {
    assert.throws(
      () => new PermissionBrokerAdapter({ settings: { timeoutMs: 1234 } }),
      RequiredSettingError
    );
    assert.throws(
      () => new PermissionBrokerAdapter({ timeoutMs: 1234 }),
      RequiredSettingError
    );
    const adapter = new PermissionBrokerAdapter({
      settings: { watchdogLimitMs: 750, timeoutMs: 999999 },
      timeoutMs: 888888,
    });
    assert.equal(adapter.resolveWatchdogLimit(), 750);
  });
});

describe("Work package R3B2: Scribe fs_write symlink bypass and PermissionBrokerAdapter key stripping", () => {
  it("denies Scribe fs_write with symlinked report/out.md -> ../src/index.ts inside cwd", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-sb6-scribe-symlink-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      const reportDir = path.join(tmpDir, "report");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(reportDir, { recursive: true });

      const indexFile = path.join(srcDir, "index.ts");
      fs.writeFileSync(indexFile, "export const secret = true;\n", "utf8");

      const symlinkFile = path.join(reportDir, "out.md");
      fs.symlinkSync(path.join("..", "src", "index.ts"), symlinkFile);

      // Relative target
      const relDecision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: "report/out.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });

      assert.equal(relDecision.outcome.outcome, "selected");
      assert.equal(relDecision.outcome.optionId, "opt-reject");
      assert.equal(relDecision.optionKind, "reject_once");
      assert.equal(relDecision.decision, "reject_once");
      assert.equal(relDecision.rule, "reject_fs_write_outside_scope");

      // Absolute target
      const absDecision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: symlinkFile,
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });

      assert.equal(absDecision.outcome.outcome, "selected");
      assert.equal(absDecision.outcome.optionId, "opt-reject");
      assert.equal(absDecision.optionKind, "reject_once");
      assert.equal(absDecision.decision, "reject_once");
      assert.equal(absDecision.rule, "reject_fs_write_outside_scope");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows Scribe fs_write for real report/out.md and report.md", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-sb6-scribe-real-"));
    try {
      const reportDir = path.join(tmpDir, "report");
      fs.mkdirSync(reportDir, { recursive: true });

      const realOutFile = path.join(reportDir, "out.md");
      fs.writeFileSync(realOutFile, "# Real Scribe Report\n", "utf8");

      const realReportMd = path.join(tmpDir, "report.md");
      fs.writeFileSync(realReportMd, "# Real Scribe Root Report\n", "utf8");

      // 1. report/out.md (relative)
      const relReportDecision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: "report/out.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });
      assert.equal(relReportDecision.outcome.outcome, "selected");
      assert.equal(relReportDecision.outcome.optionId, "opt-allow");
      assert.equal(relReportDecision.optionKind, "allow_once");
      assert.equal(relReportDecision.decision, "allow_once");
      assert.equal(relReportDecision.rule, "allow_fs_write_scope");

      // 2. report/out.md (absolute)
      const absReportDecision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: realOutFile,
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });
      assert.equal(absReportDecision.outcome.outcome, "selected");
      assert.equal(absReportDecision.outcome.optionId, "opt-allow");
      assert.equal(absReportDecision.optionKind, "allow_once");
      assert.equal(absReportDecision.decision, "allow_once");
      assert.equal(absReportDecision.rule, "allow_fs_write_scope");

      // 3. report.md (relative)
      const relMdDecision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: "report.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });
      assert.equal(relMdDecision.outcome.outcome, "selected");
      assert.equal(relMdDecision.outcome.optionId, "opt-allow");
      assert.equal(relMdDecision.optionKind, "allow_once");
      assert.equal(relMdDecision.decision, "allow_once");
      assert.equal(relMdDecision.rule, "allow_fs_write_scope");

      // 4. report.md (absolute)
      const absMdDecision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: realReportMd,
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });
      assert.equal(absMdDecision.outcome.outcome, "selected");
      assert.equal(absMdDecision.outcome.optionId, "opt-allow");
      assert.equal(absMdDecision.optionKind, "allow_once");
      assert.equal(absMdDecision.decision, "allow_once");
      assert.equal(absMdDecision.rule, "allow_fs_write_scope");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("denies Scribe fs_write when report directory is a symlink escaping to src", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-sb6-scribe-escapedir-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      const reportSymlink = path.join(tmpDir, "report");
      fs.symlinkSync("src", reportSymlink);

      const decision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: "report/out.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });

      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "opt-reject");
      assert.equal(decision.optionKind, "reject_once");
      assert.equal(decision.decision, "reject_once");
      assert.equal(decision.rule, "reject_fs_write_outside_scope");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("denies Scribe fs_write when report.md is a symlink pointing to ../src/index.ts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-sb6-scribe-symlinkfile-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      const indexFile = path.join(srcDir, "index.ts");
      fs.writeFileSync(indexFile, "export const x = 42;\n", "utf8");

      const reportSymlink = path.join(tmpDir, "report.md");
      fs.symlinkSync(path.join("src", "index.ts"), reportSymlink);

      const decision = decide({
        role: "Scribe",
        cwd: tmpDir,
        capability: "fs_write",
        target: "report.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });

      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "opt-reject");
      assert.equal(decision.optionKind, "reject_once");
      assert.equal(decision.decision, "reject_once");
      assert.equal(decision.rule, "reject_fs_write_outside_scope");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("PermissionBrokerAdapter strips injected pending/asyncEvaluator/decision/timedOut fields", async () => {
    const adapter = new PermissionBrokerAdapter({
      role: "Scribe",
      cwd: "/configured/workspace",
      settings: { watchdogLimitMs: 5000 },
    });

    let asyncEvaluatorCalled = false;
    let evaluatorCalled = false;

    const forgedRequest: PermissionBrokerRequest = {
      sessionId: "session-probe",
      requestId: "req-probe",
      toolCallId: "tc-probe",
      capability: "fs_write",
      target: "report/out.md",
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
      // Injected fields
      pending: true as any,
      asyncEvaluator: (async () => {
        asyncEvaluatorCalled = true;
        return { allowed: true };
      }) as any,
      decision: "allow_once" as any,
      timedOut: true as any,
      evaluator: (() => {
        evaluatorCalled = true;
        return { allowed: true, rule: "forged" };
      }) as any,
      isWatchdogTimeout: true as any,
      unanswered: true as any,
      watchdogExpired: true as any,
      isTimeout: true as any,
      ageMs: 99999 as any,
    };

    const merged = adapter.mergeRequest(forgedRequest);

    // Verify all forbidden / stripped protocol keys are stripped
    assert.equal(merged.pending, undefined, "pending must be stripped");
    assert.equal(merged.asyncEvaluator, undefined, "asyncEvaluator must be stripped");
    assert.equal(merged.decision, undefined, "decision must be stripped");
    assert.equal(merged.timedOut, undefined, "timedOut must be stripped");
    assert.equal(merged.evaluator, undefined, "evaluator must be stripped");
    assert.equal(merged.isWatchdogTimeout, undefined, "isWatchdogTimeout must be stripped");
    assert.equal(merged.unanswered, undefined, "unanswered must be stripped");
    assert.equal(merged.watchdogExpired, undefined, "watchdogExpired must be stripped");
    assert.equal(merged.isTimeout, undefined, "isTimeout must be stripped");
    assert.equal(merged.ageMs, undefined, "ageMs must be stripped");

    // Legitimate protocol keys must be preserved
    assert.equal(merged.sessionId, "session-probe");
    assert.equal(merged.requestId, "req-probe");
    assert.equal(merged.toolCallId, "tc-probe");
    assert.equal(merged.capability, "fs_write");
    assert.equal(merged.target, "report/out.md");

    // Verify handleRequestPermission does not trigger asyncEvaluator, evaluator or watchdog timeout
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-sb6-adapter-handle-"));
    try {
      const reportDir = path.join(tmpDir, "report");
      fs.mkdirSync(reportDir, { recursive: true });
      const realOut = path.join(reportDir, "out.md");
      fs.writeFileSync(realOut, "# Scribe\n", "utf8");

      const adapterWithCwd = new PermissionBrokerAdapter({
        role: "Scribe",
        cwd: tmpDir,
        settings: { watchdogLimitMs: 5000 },
      });

      const handleRes = await adapterWithCwd.handleRequestPermission(forgedRequest);
      assert.equal(asyncEvaluatorCalled, false, "asyncEvaluator must not be called");
      assert.equal(evaluatorCalled, false, "evaluator must not be called");
      assert.equal(handleRes.outcome.outcome, "selected");
      assert.equal((handleRes.outcome as any).optionId, "opt-allow");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
