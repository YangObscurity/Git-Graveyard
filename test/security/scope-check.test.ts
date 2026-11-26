// Unit tests for lib/security/scope-check.ts
// Requirements: 22.12, 640.3, 732.13, 616.3

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isForbiddenPath,
  isLockFile,
  normalizeDiffPath,
  extractTouchedFilesFromDiff,
  extractTouchedFiles,
  validateCandidateFiles,
  validateCandidateDiff,
  checkCandidateScope,
} from "../../lib/security/scope-check";

describe("scope-check: path normalization and forbidden paths", () => {
  it("normalizes git diff paths, prefixes, and separators", () => {
    assert.equal(normalizeDiffPath("a/src/index.ts"), "src/index.ts");
    assert.equal(normalizeDiffPath("b/.kiro/agents.md"), ".kiro/agents.md");
    assert.equal(normalizeDiffPath("a\\.git\\config"), ".git/config");
    assert.equal(normalizeDiffPath("/dev/null"), "");
    assert.equal(normalizeDiffPath(""), "");
    assert.equal(normalizeDiffPath("./src/lib.ts"), "src/lib.ts");
  });

  it("strictly forbids any path touching .kiro/ or .git/", () => {
    // .kiro paths
    assert.equal(isForbiddenPath(".kiro"), true);
    assert.equal(isForbiddenPath(".kiro/settings.json"), true);
    assert.equal(isForbiddenPath(".kiro/steering/tech.md"), true);
    assert.equal(isForbiddenPath("submodule/.kiro/hooks.json"), true);
    assert.equal(isForbiddenPath("deep/nested/path/.kiro/agents.md"), true);

    // .git paths
    assert.equal(isForbiddenPath(".git"), true);
    assert.equal(isForbiddenPath(".git/config"), true);
    assert.equal(isForbiddenPath(".git/hooks/pre-commit"), true);
    assert.equal(isForbiddenPath("nested/.git/HEAD"), true);

    // Allowed paths with similar names must NOT be flagged
    assert.equal(isForbiddenPath(".gitignore"), false);
    assert.equal(isForbiddenPath(".gitattributes"), false);
    assert.equal(isForbiddenPath(".github/workflows/ci.yml"), false);
    assert.equal(isForbiddenPath(".kiro-runs/2026-11-07/run.json"), false);
    assert.equal(isForbiddenPath("src/kiro-helper.ts"), false);
    assert.equal(isForbiddenPath("src/git-client.ts"), false);
    assert.equal(isForbiddenPath("package.json"), false);
    assert.equal(isForbiddenPath("README.md"), false);
  });

  it("identifies supported dependency lock files", () => {
    assert.equal(isLockFile("package-lock.json"), true);
    assert.equal(isLockFile("npm-shrinkwrap.json"), true);
    assert.equal(isLockFile("yarn.lock"), true);
    assert.equal(isLockFile("pnpm-lock.yaml"), true);
    assert.equal(isLockFile("poetry.lock"), true);
    assert.equal(isLockFile("Pipfile.lock"), true);
    assert.equal(isLockFile("nested/frontend/package-lock.json"), true);
    assert.equal(isLockFile("api/poetry.lock"), true);

    assert.equal(isLockFile("package.json"), false);
    assert.equal(isLockFile("requirements.txt"), false);
    assert.equal(isLockFile("src/index.ts"), false);
  });
});

describe("scope-check: diff parsing and file extraction", () => {
  it("extracts touched files from unified diff with additions, modifications, and deletions", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
index e69de29..d95f3ad 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
-old code
+new code
diff --git a/new-file.txt b/new-file.txt
new file mode 100644
--- /dev/null
+++ b/new-file.txt
@@ -0,0 +1 @@
+hello
diff --git a/deleted.txt b/deleted.txt
deleted file mode 100644
--- a/deleted.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

    const touched = extractTouchedFilesFromDiff(diff);
    assert.deepEqual(touched, ["deleted.txt", "new-file.txt", "src/app.ts"]);
  });

  it("handles CandidateInput objects with various file formats", () => {
    const candidateWithDiff = {
      diff: `--- a/lib/test.ts\n+++ b/lib/test.ts\n@@ -1 +1 @@\n-a\n+b\n`,
    };
    assert.deepEqual(extractTouchedFiles(candidateWithDiff), ["lib/test.ts"]);

    const candidateWithFiles = {
      files: ["src/a.ts", "src/b.ts"],
    };
    assert.deepEqual(extractTouchedFiles(candidateWithFiles), ["src/a.ts", "src/b.ts"]);

    const candidateWithRecord = {
      files: {
        "src/main.ts": "content",
        "README.md": "content",
      },
    };
    assert.deepEqual(extractTouchedFiles(candidateWithRecord), ["README.md", "src/main.ts"]);

    const candidateWithSteps = {
      steps: [{ file: "step1.ts" }, { file: "step2.ts" }],
    };
    assert.deepEqual(extractTouchedFiles(candidateWithSteps), ["step1.ts", "step2.ts"]);
  });
});

describe("scope-check: Candidate diff validation", () => {
  it("accepts candidate diff modifying legitimate repository files", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+// patched
`;

    const result = validateCandidateDiff(diff);
    assert.equal(result.valid, true);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.forbiddenPaths.length, 0);
    assert.equal(result.reason, undefined);
  });

  it("rejects candidate diff touching .kiro/ (Requirement 22.12)", () => {
    const diff = `diff --git a/.kiro/agents/necro.md b/.kiro/agents/necro.md
--- a/.kiro/agents/necro.md
+++ b/.kiro/agents/necro.md
@@ -1,1 +1,2 @@
+// hostile edit
`;

    const result = validateCandidateDiff(diff);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
    assert.equal(result.forbiddenPaths.length, 1);
    assert.equal(result.forbiddenPaths[0], ".kiro/agents/necro.md");
    assert.ok(result.violations[0].includes(".kiro/"));
    assert.equal(result.structuredViolations[0].rule, "forbidden_directory");
  });

  it("rejects candidate diff touching .git/ (Requirement 22.12)", () => {
    const diff = `diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit
--- a/.git/hooks/pre-commit
+++ b/.git/hooks/pre-commit
@@ -0,0 +1,2 @@
+#!/bin/sh
+echo malicious
`;

    const result = validateCandidateDiff(diff);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
    assert.equal(result.forbiddenPaths.length, 1);
    assert.equal(result.forbiddenPaths[0], ".git/hooks/pre-commit");
    assert.ok(result.violations[0].includes(".git/"));
  });

  it("permits .gitignore and .gitattributes in candidate diff", () => {
    const diff = `diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1,1 +1,2 @@
+node_modules/
diff --git a/.gitattributes b/.gitattributes
--- a/.gitattributes
+++ b/.gitattributes
@@ -1,1 +1,2 @@
+* text=auto
`;

    const result = validateCandidateDiff(diff);
    assert.equal(result.valid, true);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("enforces task scope check and permits lock files (Requirement 640.3)", () => {
    // Diff touching file in scope + lock file
    const diff = `diff --git a/src/feature.ts b/src/feature.ts
--- a/src/feature.ts
+++ b/src/feature.ts
@@ -1 +1 @@
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
`;

    // Only src/feature.ts is in explicit scope, but package-lock.json is an install lock file
    const result = validateCandidateDiff(diff, {
      filesInScope: ["src/feature.ts"],
    });

    assert.equal(result.valid, true);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.outOfScopePaths.length, 0);
  });

  it("rejects diff modifying files outside task scope (Requirement 640.3)", () => {
    const diff = `diff --git a/src/feature.ts b/src/feature.ts
--- a/src/feature.ts
+++ b/src/feature.ts
@@ -1 +1 @@
diff --git a/other/unrelated.ts b/other/unrelated.ts
--- a/other/unrelated.ts
+++ b/other/unrelated.ts
@@ -1 +1 @@
`;

    const result = validateCandidateDiff(diff, {
      filesInScope: ["src/feature.ts"],
    });

    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
    assert.equal(result.outOfScopePaths.length, 1);
    assert.equal(result.outOfScopePaths[0], "other/unrelated.ts");
    assert.equal(result.structuredViolations[0].rule, "out_of_scope");
    assert.ok(result.violations[0].includes("outside task scope"));
  });

  it("handles both forbidden directory and out-of-scope violations in one diff", () => {
    const files = ["src/feature.ts", "other/secret.ts", ".kiro/config.json"];

    const result = validateCandidateFiles(files, {
      filesInScope: ["src/feature.ts"],
    });

    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
    assert.deepEqual(result.forbiddenPaths, [".kiro/config.json"]);
    assert.deepEqual(result.outOfScopePaths, ["other/secret.ts"]);
    assert.equal(result.structuredViolations.length, 2);
    assert.equal(result.structuredViolations[0].rule, "forbidden_directory");
    assert.equal(result.structuredViolations[1].rule, "out_of_scope");
  });

  it("supports checkCandidateScope alias", () => {
    const diff = `diff --git a/.git/evil b/.git/evil\n--- a/.git/evil\n+++ b/.git/evil\n@@ -1 +1 @@\n`;
    const res = checkCandidateScope(diff);
    assert.equal(res.valid, false);
    assert.equal(res.passed, false);
  });
});
