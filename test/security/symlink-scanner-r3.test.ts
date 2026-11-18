import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  scanForEscapingSymlinks,
  scanDiffForSymlinks,
  hasSymlinkInDiff,
  shouldQuarantineWorktree,
} from "../../lib/security/symlink-scanner";

describe("lib/security/symlink-scanner-r3: M-7 symlink scanner enhancements", () => {
  let tempBaseDir: string;
  let worktreeRoot: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-scanner-r3-"));
    worktreeRoot = path.join(tempBaseDir, "worktree");
    fs.mkdirSync(worktreeRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      if (tempBaseDir && fs.existsSync(tempBaseDir)) {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  });

  it("fails the scan with a finding when root itself is a symbolic link", () => {
    const realDir = path.join(tempBaseDir, "real_dir");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, "file.txt"), "hello", "utf8");

    const symlinkRoot = path.join(tempBaseDir, "symlink_root");
    fs.symlinkSync(realDir, symlinkRoot);

    const report = scanForEscapingSymlinks(symlinkRoot);

    assert.equal(report.clean, false);
    assert.equal(report.passed, false);
    assert.equal(report.shouldQuarantine, true);
    assert.ok(report.length >= 1);
    assert.ok(shouldQuarantineWorktree(report));

    const rootFinding = report.find(
      (f) => f.type === "symlink_root" || f.reason.includes("root") || f.reason.includes("symbolic link")
    );
    assert.ok(rootFinding !== undefined, "Expected finding for symbolic link root");
    assert.ok(rootFinding.reason.toLowerCase().includes("symbolic link") || rootFinding.reason.toLowerCase().includes("root"));
  });

  it("fails the scan with a finding when a directory read error occurs during traversal", () => {
    const unreadableDir = path.join(worktreeRoot, "unreadable_dir");
    fs.mkdirSync(unreadableDir, { recursive: true });
    fs.writeFileSync(path.join(unreadableDir, "file.txt"), "secret", "utf8");

    // Make directory unreadable (mode 0000)
    try {
      fs.chmodSync(unreadableDir, 0o000);
    } catch {
      // Skip if permissions cannot be altered in this environment
      return;
    }

    try {
      const report = scanForEscapingSymlinks(worktreeRoot);
      assert.equal(report.clean, false);
      assert.equal(report.passed, false);
      assert.ok(report.length >= 1);

      const errFinding = report.find((f) => f.type === "read_error" || f.reason.toLowerCase().includes("read error"));
      assert.ok(errFinding !== undefined, "Expected read error finding");
    } finally {
      // Restore permissions for cleanup
      try {
        fs.chmodSync(unreadableDir, 0o755);
      } catch {}
    }
  });

  it("fails the scan with a finding when directory depth limit is exceeded", () => {
    // Create nested directory structure of depth 5
    let currentDir = worktreeRoot;
    for (let i = 1; i <= 5; i++) {
      currentDir = path.join(currentDir, `level_${i}`);
      fs.mkdirSync(currentDir, { recursive: true });
      fs.writeFileSync(path.join(currentDir, "dummy.txt"), `level ${i}`, "utf8");
    }

    // Set maxDepth to 2
    const report = scanForEscapingSymlinks(worktreeRoot, { maxDepth: 2 });

    assert.equal(report.clean, false);
    assert.equal(report.passed, false);
    assert.ok(report.length >= 1);

    const depthFinding = report.find(
      (f) => f.type === "depth_limit_exceeded" || f.reason.toLowerCase().includes("depth")
    );
    assert.ok(depthFinding !== undefined, "Expected depth limit exceeded finding");
  });

  it("uses lstat only and never follows symbolic links", () => {
    const outsideTargetDir = path.join(tempBaseDir, "outside_dir");
    fs.mkdirSync(outsideTargetDir, { recursive: true });
    fs.writeFileSync(path.join(outsideTargetDir, "forbidden.txt"), "forbidden content", "utf8");

    const linkInside = path.join(worktreeRoot, "link_to_outside");
    fs.symlinkSync(outsideTargetDir, linkInside);

    const report = scanForEscapingSymlinks(worktreeRoot);

    assert.equal(report.clean, false);
    assert.equal(report.passed, false);
    // Link itself is flagged
    assert.ok(report.some((f) => f.relativePath === "link_to_outside"));
    // Target contents must NEVER be walked
    assert.equal(
      report.some((f) => f.relativePath.includes("forbidden.txt")),
      false,
      "Forbidden content inside symlink target must not be traversed"
    );
  });

  it("reads the mode field of diff headers rather than matching diff text", () => {
    // 1. Genuine symlink diff with mode 120000 in diff header
    const symlinkHeaderDiff = [
      "diff --git a/mylink b/mylink",
      "new file mode 120000",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/mylink",
      "@@ -0,0 +1 @@",
      "+target_path",
    ].join("\n");

    const reportHeader = scanDiffForSymlinks(symlinkHeaderDiff);
    assert.equal(reportHeader.clean, false);
    assert.equal(reportHeader.passed, false);
    assert.equal(reportHeader.length, 1);
    assert.equal(hasSymlinkInDiff(symlinkHeaderDiff), true);
    assert.equal(reportHeader[0].relativePath, "mylink");

    // 2. Diff text containing 'new file mode 120000' in patch hunk content (not in diff header)
    const textOnlyDiff = [
      "diff --git a/docs/modes.txt b/docs/modes.txt",
      "index 1111111..2222222 100644",
      "--- a/docs/modes.txt",
      "+++ b/docs/modes.txt",
      "@@ -1,3 +1,4 @@",
      " Git mode notes:",
      "+new file mode 120000",
      "+old mode 120000",
      " End notes",
    ].join("\n");

    const reportText = scanDiffForSymlinks(textOnlyDiff);
    assert.equal(reportText.clean, true, "Diff text mentioning mode 120000 in hunk body must NOT be flagged");
    assert.equal(reportText.passed, true);
    assert.equal(reportText.length, 0);
    assert.equal(hasSymlinkInDiff(textOnlyDiff), false);

    // 3. Diff changing mode from symlink (old mode 120000)
    const modeChangeDiff = [
      "diff --git a/converted b/converted",
      "old mode 120000",
      "new mode 100644",
      "index 1111111..2222222",
    ].join("\n");

    const reportChange = scanDiffForSymlinks(modeChangeDiff);
    assert.equal(reportChange.clean, false);
    assert.equal(reportChange.passed, false);
    assert.equal(hasSymlinkInDiff(modeChangeDiff), true);
  });
});
