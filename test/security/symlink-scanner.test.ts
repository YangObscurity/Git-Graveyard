// Unit tests for lib/security/symlink-scanner.ts
// Requirements: 22.8, 22.9, 45.10
// Task 11.3: Worktree symlink scanner and escape quarantine

import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  scanForEscapingSymlinks,
  shouldQuarantineWorktree,
  isPathOutsideRoot,
  SymlinkScanReport,
  type SymlinkFinding,
} from "../../lib/security/symlink-scanner";
import { symlinkScanRequired } from "../../lib/probes/probe-fallbacks";

describe("lib/security/symlink-scanner: worktree symlink scanner (Task 11.3)", () => {
  let tempBaseDir: string;
  let worktreeRoot: string;
  let outsideFile: string;
  let outsideDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-scanner-test-"));
    worktreeRoot = path.join(tempBaseDir, "worktree");
    fs.mkdirSync(worktreeRoot, { recursive: true });

    outsideFile = path.join(tempBaseDir, "outside_file.txt");
    fs.writeFileSync(outsideFile, "outside content\n", "utf8");

    outsideDir = path.join(tempBaseDir, "outside_dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "nested.txt"), "nested outside\n", "utf8");
  });

  afterEach(() => {
    try {
      if (tempBaseDir && fs.existsSync(tempBaseDir)) {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("creates a temporary tree with an inside link, an outside link, a directory link and a hard link, and asserts findings", () => {
    // 1. Inside file and inside directory
    const insideFile = path.join(worktreeRoot, "inside_file.txt");
    fs.writeFileSync(insideFile, "inside content\n", "utf8");

    const insideDir = path.join(worktreeRoot, "inside_dir");
    fs.mkdirSync(insideDir, { recursive: true });
    fs.writeFileSync(path.join(insideDir, "sub.txt"), "sub content\n", "utf8");

    // 2. Inside link (symbolic link to a file inside root)
    const insideLink = path.join(worktreeRoot, "inside_link.txt");
    fs.symlinkSync("inside_file.txt", insideLink);

    // 3. Outside link (symbolic link resolving outside root)
    const outsideLink = path.join(worktreeRoot, "outside_link.txt");
    fs.symlinkSync(outsideFile, outsideLink);

    // 4. Directory link (symbolic link to a directory - refused outright)
    const dirLink = path.join(worktreeRoot, "dir_link");
    fs.symlinkSync(insideDir, dirLink);

    // 5. Hard link (hard link to a file outside root)
    const hardLink = path.join(worktreeRoot, "hard_link.txt");
    fs.linkSync(outsideFile, hardLink);

    // Perform scan
    const findings = scanForEscapingSymlinks(worktreeRoot);

    // Verification of findings structure
    assert.equal(Array.isArray(findings), true);
    assert.equal(findings.hasEscapingSymlinks, true);
    assert.equal(findings.clean, false);
    assert.equal(findings.passed, false);
    assert.equal(findings.shouldQuarantine, true);
    assert.equal(shouldQuarantineWorktree(findings), true);

    // Exactly 3 violations flagged: outside link, directory link, and hard link
    // The inside link must NOT be flagged
    assert.equal(findings.length, 3);

    // Verify inside link was NOT flagged
    const insideFinding = findings.find((f) => f.relativePath === "inside_link.txt");
    assert.equal(insideFinding, undefined, "inside_link.txt must not be flagged");

    // Verify outside link was flagged
    const outsideFinding = findings.find((f) => f.relativePath === "outside_link.txt");
    assert.notEqual(outsideFinding, undefined, "outside_link.txt must be flagged");
    assert.equal(outsideFinding?.relativePath, "outside_link.txt");
    assert.equal(outsideFinding?.type, "escaping_symlink");
    assert.equal(outsideFinding?.target, outsideFile);
    assert.equal(outsideFinding?.resolvedTarget, outsideFile);

    // Verify directory link was flagged (refused outright)
    const dirFinding = findings.find((f) => f.relativePath === "dir_link");
    assert.notEqual(dirFinding, undefined, "dir_link must be flagged");
    assert.equal(dirFinding?.relativePath, "dir_link");
    assert.equal(dirFinding?.type, "directory_symlink");
    assert.equal(dirFinding?.target, insideDir);
    assert.equal(dirFinding?.resolvedTarget, insideDir);

    // Verify hard link to outside file was flagged
    const hardlinkFinding = findings.find((f) => f.relativePath === "hard_link.txt");
    assert.notEqual(hardlinkFinding, undefined, "hard_link.txt must be flagged");
    assert.equal(hardlinkFinding?.relativePath, "hard_link.txt");
    assert.equal(hardlinkFinding?.type, "outside_hardlink");
    assert.equal(hardlinkFinding?.target, outsideFile);
    assert.equal(hardlinkFinding?.resolvedTarget, outsideFile);
  });

  it("passes cleanly on a worktree with only safe files and inside symlinks", () => {
    const file1 = path.join(worktreeRoot, "file1.txt");
    const file2 = path.join(worktreeRoot, "file2.txt");
    fs.writeFileSync(file1, "hello\n", "utf8");
    fs.writeFileSync(file2, "world\n", "utf8");

    // Safe inside symlink (relative)
    const relLink = path.join(worktreeRoot, "rel_link.txt");
    fs.symlinkSync("file1.txt", relLink);

    // Safe inside symlink (absolute)
    const absLink = path.join(worktreeRoot, "abs_link.txt");
    fs.symlinkSync(file2, absLink);

    // Safe inside hard link (two files inside root pointing to same inode)
    const insideHardLink = path.join(worktreeRoot, "hard_inside.txt");
    fs.linkSync(file1, insideHardLink);

    const findings = scanForEscapingSymlinks(worktreeRoot);

    assert.equal(findings.length, 0);
    assert.equal(findings.clean, true);
    assert.equal(findings.passed, true);
    assert.equal(findings.hasEscapes, false);
    assert.equal(findings.hasEscapingSymlinks, false);
    assert.equal(findings.shouldQuarantine, false);
    assert.equal(shouldQuarantineWorktree(findings), false);
  });

  it("flags relative symlinks that use '..' to escape the root", () => {
    const subDir = path.join(worktreeRoot, "subdir");
    fs.mkdirSync(subDir, { recursive: true });

    // Link in subdir escaping to outsideFile: "../../outside_file.txt"
    const relEscapeLink = path.join(subDir, "escape.txt");
    fs.symlinkSync("../../outside_file.txt", relEscapeLink);

    const findings = scanForEscapingSymlinks(worktreeRoot);
    assert.equal(findings.length, 1);

    const finding = findings[0];
    assert.equal(finding.relativePath, "subdir/escape.txt");
    assert.equal(finding.type, "escaping_symlink");
    assert.equal(finding.target, outsideFile);
    assert.equal(finding.linkTarget, "../../outside_file.txt");
  });

  it("flags directory symlinks pointing to an outside directory", () => {
    const outsideDirLink = path.join(worktreeRoot, "out_dir_link");
    fs.symlinkSync(outsideDir, outsideDirLink);

    const findings = scanForEscapingSymlinks(worktreeRoot);
    assert.equal(findings.length, 1);

    const finding = findings[0];
    assert.equal(finding.relativePath, "out_dir_link");
    assert.equal(finding.type, "directory_symlink");
    assert.equal(finding.target, outsideDir);
  });

  it("never follows symlinks during directory traversal", () => {
    // Create an outside directory with forbidden files
    const secretDir = path.join(tempBaseDir, "secret_dir");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "sensitive.txt"), "secret", "utf8");

    // Create a symlink to that directory inside the worktree
    const dirLink = path.join(worktreeRoot, "symlink_dir");
    fs.symlinkSync(secretDir, dirLink);

    const findings = scanForEscapingSymlinks(worktreeRoot);

    // The symlink to the directory itself is flagged, but sensitive.txt is NOT walked or reported
    assert.equal(findings.length, 1);
    assert.equal(findings[0].relativePath, "symlink_dir");
    assert.equal(
      findings.some((f) => f.relativePath.includes("sensitive.txt")),
      false,
      "scanner must never follow directory symlinks"
    );
  });

  it("identifies outside hard links when explicitly provided in options.outsideFiles", () => {
    const hardLink = path.join(worktreeRoot, "hl.txt");
    fs.linkSync(outsideFile, hardLink);

    const findings = scanForEscapingSymlinks(worktreeRoot, {
      outsideFiles: [outsideFile],
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].relativePath, "hl.txt");
    assert.equal(findings[0].type, "outside_hardlink");
    assert.equal(findings[0].target, outsideFile);
  });

  it("handles non-existent or invalid roots gracefully", () => {
    const nonExistent = path.join(tempBaseDir, "does_not_exist");
    const findings1 = scanForEscapingSymlinks(nonExistent);
    assert.equal(findings1.length, 1);
    assert.equal(findings1.clean, false);
    assert.equal(findings1.passed, false);
    assert.equal(findings1[0].type, "read_error");

    const findings2 = scanForEscapingSymlinks("");
    assert.equal(findings2.length, 0);
  });

  it("supports report properties, array destructuring, and iterations", () => {
    const outsideLink = path.join(worktreeRoot, "outside.txt");
    fs.symlinkSync(outsideFile, outsideLink);

    const report: SymlinkScanReport = scanForEscapingSymlinks(worktreeRoot);

    assert.equal(report.length, 1);
    assert.equal(report.findings.length, 1);
    assert.equal(report.relativePaths.length, 1);
    assert.equal(report.relativePaths[0], "outside.txt");
    assert.notEqual(report.reason, undefined);

    // Destructuring support: const { findings } = ...
    const { findings } = report;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].relativePath, "outside.txt");

    // for..of loop support
    let count = 0;
    for (const item of report) {
      assert.equal(item.relativePath, "outside.txt");
      count++;
    }
    assert.equal(count, 1);
  });

  it("isPathOutsideRoot correctly checks path bounds", () => {
    assert.equal(isPathOutsideRoot("/etc/passwd", worktreeRoot), true);
    assert.equal(isPathOutsideRoot(path.join(worktreeRoot, "a.txt"), worktreeRoot), false);
    assert.equal(isPathOutsideRoot(path.join(worktreeRoot, "sub/b.txt"), worktreeRoot), false);
    assert.equal(isPathOutsideRoot(path.join(worktreeRoot, "../outside.txt"), worktreeRoot), true);
  });
});

describe("lib/probes/probe-fallbacks: mandatory symlink scan policy (Task 11.3)", () => {
  it("enforces mandatory symlink scan policy in every case when P12 is present", () => {
    // When P12 passes and reports safe (tools do not follow symlinks), scan is still mandatory
    const safeProbe = { id: "P12", passed: true, outcome: "safe: does not follow symlinks" };
    const resSafe = symlinkScanRequired(safeProbe);
    assert.notEqual(resSafe, "not passed");
    if (resSafe !== "not passed") {
      assert.equal(resSafe.required, true);
      assert.equal(resSafe.mandatory, true);
      assert.equal(resSafe.scanTiming, "before_every_prompt_and_after_every_sandbox_exec");
      assert.equal(resSafe.timing, "before_every_prompt_and_after_every_sandbox_exec");
      assert.equal(resSafe.scanBeforePrompt, true);
      assert.equal(resSafe.scanAfterSandboxExec, true);
      assert.equal(resSafe.enforceMandatoryScan, true);
      assert.equal(
        resSafe.policy,
        "mandatory symlink scan before every prompt and after every sandbox_exec"
      );
      assert.equal(Boolean(resSafe.valueOf()), true);
    }

    // When P12 fails, scan is mandatory
    const failProbe = { id: "P12", passed: false, outcome: "fail" };
    const resFail = symlinkScanRequired(failProbe);
    assert.notEqual(resFail, "not passed");
    if (resFail !== "not passed") {
      assert.equal(resFail.required, true);
      assert.equal(resFail.mandatory, true);
      assert.equal(
        resFail.policy,
        "mandatory symlink scan before every prompt and after every sandbox_exec"
      );
    }
  });

  it("returns 'not passed' when P12 probe is missing", () => {
    assert.equal(symlinkScanRequired(undefined), "not passed");
    assert.equal(symlinkScanRequired(null), "not passed");
    assert.equal(symlinkScanRequired({}), "not passed");
    assert.equal(
      symlinkScanRequired({ P12: { id: "P12", passed: false, outcome: "not_passed" } }),
      "not passed"
    );
  });
});
