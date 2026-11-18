// Unit tests for lib/security/untrusted-content.ts
// Requirements: 22.10, 22.11, 45.17

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import {
  isKiroPath,
  isAgentsFilePath,
  isSkillPath,
  classifyUntrustedPath,
  isUntrustedContent,
  scanUntrustedPaths,
  scanClonedRepository,
  shouldNeutralizeUntrustedContent,
  planUntrustedContentNeutralization,
  neutralizeUntrustedContent,
  normalizeRepoRelativePath,
} from "../../lib/security/untrusted-content";

describe("untrusted-content: path normalization and classification", () => {
  it("normalizes path slashes, prefixes, and relative segments", () => {
    assert.equal(normalizeRepoRelativePath(".\\.kiro\\specs"), ".kiro/specs");
    assert.equal(normalizeRepoRelativePath("./.kiro/agents.md"), ".kiro/agents.md");
    assert.equal(normalizeRepoRelativePath("/AGENTS.md"), "AGENTS.md");
    assert.equal(normalizeRepoRelativePath(""), "");
    assert.equal(normalizeRepoRelativePath("."), "");
  });

  it("detects .kiro directories and files within .kiro", () => {
    assert.equal(isKiroPath(".kiro"), true);
    assert.equal(isKiroPath(".kiro/steering/tech.md"), true);
    assert.equal(isKiroPath("subproject/.kiro/specs/resurrection.md"), true);
    assert.equal(isKiroPath(".kiro/hooks/build-hooks.json"), true);
    assert.equal(isKiroPath(".kiro/settings/mcp.json"), true);

    // Dotted names that are not .kiro must not match
    assert.equal(isKiroPath(".kiro-runs/2026-11-07/log.txt"), false);
    assert.equal(isKiroPath(".kiro_backup/config.json"), false);
    assert.equal(isKiroPath("src/app.ts"), false);
    assert.equal(isKiroPath("README.md"), false);
  });

  it("detects AGENTS.md files (case-insensitive across directories)", () => {
    assert.equal(isAgentsFilePath("AGENTS.md"), true);
    assert.equal(isAgentsFilePath("agents.md"), true);
    assert.equal(isAgentsFilePath("Agents.md"), true);
    assert.equal(isAgentsFilePath("nested/docs/AGENTS.md"), true);
    assert.equal(isAgentsFilePath("deep/sub/dir/agents.md"), true);

    assert.equal(isAgentsFilePath("AGENTS.txt"), false);
    assert.equal(isAgentsFilePath("AGENTS.md.bak"), false);
    assert.equal(isAgentsFilePath("my-agents.md"), false);
  });

  it("detects skills and skill files", () => {
    assert.equal(isSkillPath(".agents/skills/review/SKILL.md"), true);
    assert.equal(isSkillPath("skills/code-fix/SKILL.md"), true);
    assert.equal(isSkillPath(".skills/custom/index.js"), true);
    assert.equal(isSkillPath(".kiro/skills/helper"), true);
    assert.equal(isSkillPath("SKILL.md"), true);
    assert.equal(isSkillPath("skill.md"), true);
    assert.equal(isSkillPath("some/dir/SKILL.md"), true);

    assert.equal(isSkillPath("src/components/SkillBadge.tsx"), false);
    assert.equal(isSkillPath("lib/utils.ts"), false);
  });

  it("classifies untrusted paths into correct categories", () => {
    assert.equal(classifyUntrustedPath(".kiro"), "kiro_directory");
    assert.equal(classifyUntrustedPath(".kiro/agents.md"), "kiro_file");
    assert.equal(classifyUntrustedPath("AGENTS.md"), "agents_file");
    assert.equal(classifyUntrustedPath("skills/test/SKILL.md"), "skill");
    assert.equal(classifyUntrustedPath("package.json"), null);
    assert.equal(classifyUntrustedPath("src/index.ts"), null);
  });

  it("checks isUntrustedContent boolean", () => {
    assert.equal(isUntrustedContent(".kiro/config.json"), true);
    assert.equal(isUntrustedContent("AGENTS.md"), true);
    assert.equal(isUntrustedContent("skills/helper/SKILL.md"), true);
    assert.equal(isUntrustedContent("src/main.py"), false);
  });
});

describe("untrusted-content: scanUntrustedPaths", () => {
  it("scans path list and categorizes entries deterministically", () => {
    const paths = [
      "src/index.ts",
      ".kiro/steering/tech.md",
      "README.md",
      "AGENTS.md",
      "skills/custom/SKILL.md",
      "package.json",
      "nested/.kiro/agents.md",
      "docs/agents.md",
    ];

    const result = scanUntrustedPaths(paths);
    assert.equal(result.hasUntrustedContent, true);
    assert.equal(result.entries.length, 5);
    assert.deepEqual(result.kiroPaths, [".kiro/steering/tech.md", "nested/.kiro/agents.md"]);
    assert.deepEqual(result.agentsPaths, ["AGENTS.md", "docs/agents.md"]);
    assert.deepEqual(result.skillPaths, ["skills/custom/SKILL.md"]);
    assert.equal(result.untrustedPaths.length, 5);
  });

  it("returns hasUntrustedContent = false when no untrusted content exists", () => {
    const paths = ["src/app.ts", "package.json", "tsconfig.json", "README.md"];
    const result = scanUntrustedPaths(paths);
    assert.equal(result.hasUntrustedContent, false);
    assert.equal(result.entries.length, 0);
    assert.equal(result.untrustedPaths.length, 0);
  });
});

describe("untrusted-content: probe P7 evaluation and neutralization planning", () => {
  it("shouldNeutralizeUntrustedContent evaluates probe P7 outcomes correctly", () => {
    // Missing probe -> neutralize
    assert.equal(shouldNeutralizeUntrustedContent(undefined), true);
    assert.equal(shouldNeutralizeUntrustedContent(null), true);

    // Failed probe -> neutralize
    assert.equal(shouldNeutralizeUntrustedContent({ id: "P7", passed: false }), true);

    // Warning / loading outcome -> neutralize
    assert.equal(
      shouldNeutralizeUntrustedContent({
        id: "P7",
        passed: true,
        outcome: "warning: session loads repo steering files",
      }),
      true
    );

    // Safe outcome -> keep (do not neutralize)
    assert.equal(
      shouldNeutralizeUntrustedContent({
        id: "P7",
        passed: true,
        outcome: "safe: does not load repo files",
      }),
      false
    );

    // Direct boolean
    assert.equal(shouldNeutralizeUntrustedContent(true), true);
    assert.equal(shouldNeutralizeUntrustedContent(false), false);
  });

  it("planUntrustedContentNeutralization plans keep when P7 confirms safe", () => {
    const scan = scanUntrustedPaths([".kiro/config.json", "AGENTS.md"]);
    const safeP7 = { id: "P7", passed: true, outcome: "safe: does not load repo files" };

    const plan = planUntrustedContentNeutralization(scan, safeP7);
    assert.equal(plan.action, "keep");
    assert.equal(plan.shouldNeutralize, false);
    assert.equal(plan.pathsToSkipWorktree.length, 0);
    assert.equal(plan.pathsToRemove.length, 0);
    assert.equal(plan.gitCommands.length, 0);
  });

  it("planUntrustedContentNeutralization plans remove_and_skip_worktree when P7 indicates loading", () => {
    const scan = scanUntrustedPaths([".kiro/config.json", "AGENTS.md", "src/main.ts"]);
    const unsafeP7 = { id: "P7", passed: false, outcome: "ACP session loads repository files" };

    const plan = planUntrustedContentNeutralization(scan, unsafeP7);
    assert.equal(plan.action, "remove_and_skip_worktree");
    assert.equal(plan.shouldNeutralize, true);
    assert.deepEqual(plan.pathsToSkipWorktree, [".kiro/config.json", "AGENTS.md"]);
    assert.deepEqual(plan.pathsToRemove, [".kiro/config.json", "AGENTS.md"]);
    assert.equal(plan.gitCommands.length, 1);
    assert.equal(plan.gitCommands[0].command, "git");
    assert.ok(plan.gitCommands[0].args.includes("--skip-worktree"));
  });
});

describe("untrusted-content: scanClonedRepository and neutralization on disk", () => {
  it("scans repository directory on disk and neutralizes untrusted content with skip-worktree", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-test-untrusted-"));

    try {
      // Initialize a real git repo in tempDir
      childProcess.execSync("git init -q", { cwd: tempDir });
      childProcess.execSync('git config user.name "Test Runner"', { cwd: tempDir });
      childProcess.execSync('git config user.email "ci@local"', { cwd: tempDir });

      // Create files: valid repo files + untrusted files
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), 'console.log("hello");\n');
      fs.writeFileSync(path.join(tempDir, "package.json"), '{"name":"test"}\n');

      fs.mkdirSync(path.join(tempDir, ".kiro"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".kiro/settings.json"), '{"telemetry":true}\n');
      fs.writeFileSync(path.join(tempDir, "AGENTS.md"), "# Hostile Agents\n");
      fs.mkdirSync(path.join(tempDir, "skills/evil"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "skills/evil/SKILL.md"), "name: evil\n");

      // Commit them all into git
      childProcess.execSync("git add .", { cwd: tempDir });
      childProcess.execSync('git commit -q -m "initial commit"', { cwd: tempDir });

      // Scan directory
      const scan = scanClonedRepository(tempDir);
      assert.equal(scan.hasUntrustedContent, true);
      assert.ok(scan.kiroPaths.some((p) => p.includes(".kiro")));
      assert.ok(scan.agentsPaths.includes("AGENTS.md"));
      assert.ok(scan.skillPaths.some((p) => p.includes("SKILL.md")));

      // Neutralize with P7 indicating ACP loads repo configuration
      const result = neutralizeUntrustedContent(tempDir, {
        p7: { id: "P7", passed: false, outcome: "loads untrusted files" },
        scanResult: scan,
      });

      assert.equal(result.success, true);
      assert.equal(result.action, "remove_and_skip_worktree");
      assert.ok(result.removedPaths.length > 0);
      assert.ok(result.skippedWorktreePaths.length > 0);

      // Verify files were removed from worktree
      assert.equal(fs.existsSync(path.join(tempDir, ".kiro")), false);
      assert.equal(fs.existsSync(path.join(tempDir, "AGENTS.md")), false);
      assert.equal(fs.existsSync(path.join(tempDir, "skills/evil")), false);

      // Verify valid repo files are still intact
      assert.equal(fs.existsSync(path.join(tempDir, "src/index.ts")), true);
      assert.equal(fs.existsSync(path.join(tempDir, "package.json")), true);

      // Verify git status does NOT show them as deleted because skip-worktree was set!
      const statusOutput = childProcess
        .execSync("git status --porcelain", { cwd: tempDir, encoding: "utf-8" })
        .trim();
      assert.equal(
        statusOutput,
        "",
        "git status must be completely clean with no deleted files due to skip-worktree"
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps untrusted content when P7 confirms safe", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-test-untrusted-safe-"));

    try {
      fs.mkdirSync(path.join(tempDir, ".kiro"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".kiro/settings.json"), "{}\n");

      const result = neutralizeUntrustedContent(tempDir, {
        p7: { id: "P7", passed: true, outcome: "safe: does not load repo files" },
      });

      assert.equal(result.success, true);
      assert.equal(result.action, "keep");
      assert.equal(result.removedPaths.length, 0);
      assert.equal(fs.existsSync(path.join(tempDir, ".kiro/settings.json")), true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
