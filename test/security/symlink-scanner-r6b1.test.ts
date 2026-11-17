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

describe("lib/security/symlink-scanner-r6b1: M-7 and N-5 fixes", () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-scanner-r6b1-"));
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

  it("a missing root gives a read_error entry, not an empty pass", () => {
    const missingRoot = path.join(tempBaseDir, "does_not_exist_at_all");
    const report = scanForEscapingSymlinks(missingRoot);

    assert.equal(report.clean, false);
    assert.equal(report.passed, false);
    assert.equal(report.shouldQuarantine, true);
    assert.equal(report.length, 1);

    const finding = report[0];
    assert.equal(finding.type, "read_error");
    assert.equal(finding.kind, "read_error");
    assert.equal(finding.path, path.resolve(missingRoot));
    assert.equal(finding.relativePath, ".");
    assert.ok(finding.reason.toLowerCase().includes("read error"));
    assert.equal(shouldQuarantineWorktree(report), true);
  });

  it("a regular file as the root gives a read_error entry", () => {
    const regularFileRoot = path.join(tempBaseDir, "not_a_directory.txt");
    fs.writeFileSync(regularFileRoot, "regular file content\n", "utf8");

    const report = scanForEscapingSymlinks(regularFileRoot);

    assert.equal(report.clean, false);
    assert.equal(report.passed, false);
    assert.equal(report.shouldQuarantine, true);
    assert.equal(report.length, 1);

    const finding = report[0];
    assert.equal(finding.type, "read_error");
    assert.equal(finding.kind, "read_error");
    assert.equal(finding.path, path.resolve(regularFileRoot));
    assert.equal(finding.relativePath, ".");
    assert.ok(
      finding.reason.toLowerCase().includes("read error") ||
      finding.reason.toLowerCase().includes("not a directory")
    );
    assert.equal(shouldQuarantineWorktree(report), true);
  });

  it("an index line with mode 120000 is reported", () => {
    // 1. Symlink modified with index line showing mode 120000 (standard git format)
    const diffWithIndexSymlink = [
      "diff --git a/link b/link",
      "index 1111111..2222222 120000",
      "--- a/link",
      "+++ b/link",
      "@@ -1 +1 @@",
      "-old_target",
      "+new_target",
    ].join("\n");

    const report1 = scanDiffForSymlinks(diffWithIndexSymlink);
    assert.equal(report1.clean, false);
    assert.equal(report1.passed, false);
    assert.equal(report1.shouldQuarantine, true);
    assert.equal(report1.length, 1);
    assert.equal(report1[0].relativePath, "link");
    assert.equal(report1[0].type, "escaping_symlink");
    assert.equal(report1[0].kind, "escaping_symlink");
    assert.equal(hasSymlinkInDiff(diffWithIndexSymlink), true);

    // 2. Symbolic link recorded in index line of the form 'index <a>..<b> 120000'
    const diffWithPlaceholderIndex = [
      "diff --git a/nested/link b/nested/link",
      "index a..b 120000",
      "--- a/nested/link",
      "+++ b/nested/link",
    ].join("\n");

    const report2 = scanDiffForSymlinks(diffWithPlaceholderIndex);
    assert.equal(report2.clean, false);
    assert.equal(report2.passed, false);
    assert.equal(report2.length, 1);
    assert.equal(report2[0].relativePath, "nested/link");
    assert.equal(hasSymlinkInDiff(diffWithPlaceholderIndex), true);

    // 3. Regular files with mode 100644 in index line are handled as before (not reported)
    const regularDiff = [
      "diff --git a/file.txt b/file.txt",
      "index 1111111..2222222 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const regularReport = scanDiffForSymlinks(regularDiff);
    assert.equal(regularReport.clean, true);
    assert.equal(regularReport.passed, true);
    assert.equal(regularReport.length, 0);
    assert.equal(hasSymlinkInDiff(regularDiff), false);
  });

  it("a clean directory still passes", () => {
    const cleanDir = path.join(tempBaseDir, "clean_worktree");
    fs.mkdirSync(cleanDir, { recursive: true });
    fs.writeFileSync(path.join(cleanDir, "README.md"), "clean content\n", "utf8");
    fs.writeFileSync(path.join(cleanDir, "code.ts"), "export const x = 1;\n", "utf8");

    const report = scanForEscapingSymlinks(cleanDir);
    assert.equal(report.clean, true);
    assert.equal(report.passed, true);
    assert.equal(report.shouldQuarantine, false);
    assert.equal(report.length, 0);
    assert.equal(shouldQuarantineWorktree(report), false);
  });
});
