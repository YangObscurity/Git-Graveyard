import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("build-hooks.json: schema and configuration (Requirements 48.1, 48.2, 48.3, Task 3.4, 3.6)", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const hooksConfigPath = path.resolve(repoRoot, ".kiro/hooks/build-hooks.json");

  it("exists on disk and is valid JSON (Requirement 48.1)", () => {
    assert.ok(fs.existsSync(hooksConfigPath), "build-hooks.json should exist");
    const content = fs.readFileSync(hooksConfigPath, "utf8");
    assert.doesNotThrow(() => JSON.parse(content), "build-hooks.json must be valid JSON");
  });

  it("conforms to the v1 schema with version 'v1' and a hooks array (Requirement 48.1)", () => {
    const raw = fs.readFileSync(hooksConfigPath, "utf8");
    const data = JSON.parse(raw);

    assert.equal(typeof data, "object");
    assert.notEqual(data, null);
    assert.equal(data.version, "v1");
    assert.ok(Array.isArray(data.hooks), "hooks must be an array");
    assert.equal(data.hooks.length, 3, "hooks array should contain exactly 3 hooks");
  });

  it("registers rules-props hook with trigger PostFileSave and correct matcher (Requirement 48.2)", () => {
    const raw = fs.readFileSync(hooksConfigPath, "utf8");
    const data = JSON.parse(raw);

    const hook = data.hooks.find((h: { name: string }) => h.name === "rules-props");
    assert.ok(hook, "rules-props hook must exist");
    assert.equal(hook.trigger, "PostFileSave");
    assert.equal(hook.matcher, "lib/rules/.*\\.ts$");
    assert.deepEqual(hook.action, {
      type: "command",
      command: "npm run test:props",
    });

    const regex = new RegExp(hook.matcher);
    assert.ok(regex.test("lib/rules/m1-python.ts"));
    assert.ok(regex.test("lib/rules/m2-request.ts"));
    assert.ok(regex.test("lib/rules/nested/rule.ts"));
    assert.equal(regex.test("lib/grimoire/verdict.ts"), false);
    assert.equal(regex.test("lib/rules/m1-python.js"), false);
    assert.equal(regex.test("lib/rules/README.md"), false);
  });

  it("registers task-golden hook with trigger PostTaskExec (Requirement 48.3)", () => {
    const raw = fs.readFileSync(hooksConfigPath, "utf8");
    const data = JSON.parse(raw);

    const hook = data.hooks.find((h: { name: string }) => h.name === "task-golden");
    assert.ok(hook, "task-golden hook must exist");
    assert.equal(hook.trigger, "PostTaskExec");
    assert.deepEqual(hook.action, {
      type: "command",
      command: "npm run test:golden",
    });
  });

  it("registers guard-paths hook with trigger PreToolUse (Requirement 48.4, 48.13)", () => {
    const raw = fs.readFileSync(hooksConfigPath, "utf8");
    const data = JSON.parse(raw);

    const hook = data.hooks.find((h: { name: string }) => h.name === "guard-paths");
    assert.ok(hook, "guard-paths hook must exist");
    assert.equal(hook.trigger, "PreToolUse");
    assert.deepEqual(hook.action, {
      type: "command",
      command: "node scripts/hooks/guard-paths.mjs",
    });
  });
});

describe("guard-paths.mjs: protected path enforcement (Requirement 48.4, 48.13, Task 3.5, 3.6)", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const scriptPath = path.resolve(repoRoot, "scripts/hooks/guard-paths.mjs");

  function runGuard(payload: unknown): { status: number | null; stdout: string; stderr: string } {
    const input = typeof payload === "string" ? payload : JSON.stringify(payload);
    const res = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      input,
      encoding: "utf8",
    });
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  it("exists on disk and is accessible", () => {
    assert.ok(fs.existsSync(scriptPath), "guard-paths.mjs must exist");
  });

  describe("blocks protected paths with exit code 2 (Requirement 48.4)", () => {
    const PROTECTED_TARGETS = [
      "test/golden",
      "test/golden/fixtures.json",
      "test/golden/sub/deep/case.ts",
      ".kiro/specs/resurrection",
      ".kiro/specs/resurrection/owner-repo/pact.json",
      "test/fixtures/pinned",
      "test/fixtures/pinned/repo.tar.gz",
      ".cache",
      ".cache/build-cache.json",
      ".cache/tmp/file.txt",
    ];

    for (const target of PROTECTED_TARGETS) {
      it(`blocks write to ${target} with exit code 2`, () => {
        const res = runGuard({ tool_input: { path: target } });
        assert.equal(res.status, 2, `Expected exit code 2 for ${target}`);
        assert.ok(
          res.stderr.includes("Blocked write to protected path:"),
          `Expected stderr to report blocked path for ${target}`
        );
      });
    }

    it("blocks protected paths with leading ./ notation", () => {
      const res = runGuard({ tool_input: { path: "./test/golden/fixtures.json" } });
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("Blocked write to protected path:"));
    });

    it("blocks protected paths using Windows-style backslashes", () => {
      const res = runGuard({ tool_input: { path: "test\\golden\\sample.json" } });
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("Blocked write to protected path:"));
    });

    it("blocks protected paths when given as absolute paths", () => {
      const absPath = path.resolve(repoRoot, "test/golden/foo.txt");
      const res = runGuard({ tool_input: { path: absPath } });
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("Blocked write to protected path:"));
    });
  });

  describe("permits allowed output and workspace directories with exit code 0 (Requirement 48.13)", () => {
    const ALLOWED_TARGETS = [
      ".agent-ws",
      ".agent-ws/task-1/patch.diff",
      ".agent-ws/subtask/run.log",
      "output",
      "output/reliquary.json",
      "output/report.md",
      "lib/copy/glossary.ts",
      "test/hooks/kiro-hooks.test.ts",
      "package.json",
    ];

    for (const target of ALLOWED_TARGETS) {
      it(`permits write to ${target} with exit code 0`, () => {
        const res = runGuard({ tool_input: { path: target } });
        assert.equal(res.status, 0, `Expected exit code 0 for ${target}`);
        assert.equal(res.stderr, "");
      });
    }
  });

  describe("supports various tool invocation payload shapes", () => {
    it("extracts path from tool_input.path", () => {
      const res = runGuard({ tool_input: { path: "test/golden/a.ts" } });
      assert.equal(res.status, 2);
    });

    it("extracts path from tool_input.file_path", () => {
      const res = runGuard({ tool_input: { file_path: "test/golden/b.ts" } });
      assert.equal(res.status, 2);
    });

    it("extracts path from tool_input.target", () => {
      const res = runGuard({ tool_input: { target: "test/golden/c.ts" } });
      assert.equal(res.status, 2);
    });

    it("extracts path from toolInput object", () => {
      const res = runGuard({ toolInput: { path: "test/golden/d.ts" } });
      assert.equal(res.status, 2);
    });

    it("extracts path from input object", () => {
      const res = runGuard({ input: { path: "test/golden/e.ts" } });
      assert.equal(res.status, 2);
    });

    it("extracts path from arguments object", () => {
      const res = runGuard({ arguments: { path: "test/golden/f.ts" } });
      assert.equal(res.status, 2);
    });

    it("extracts path from params object", () => {
      const res = runGuard({ params: { path: "test/golden/g.ts" } });
      assert.equal(res.status, 2);
    });

    it("extracts top-level path", () => {
      const res = runGuard({ path: "test/golden/h.ts" });
      assert.equal(res.status, 2);
    });

    it("extracts top-level file_path", () => {
      const res = runGuard({ file_path: "test/golden/i.ts" });
      assert.equal(res.status, 2);
    });

    it("extracts top-level target", () => {
      const res = runGuard({ target: "test/golden/j.ts" });
      assert.equal(res.status, 2);
    });
  });

  describe("gracefully handles missing, empty, or non-JSON payloads with exit code 0", () => {
    it("exits 0 for empty string input", () => {
      const res = runGuard("");
      assert.equal(res.status, 0);
    });

    it("exits 0 for whitespace-only input", () => {
      const res = runGuard("   \n\t  ");
      assert.equal(res.status, 0);
    });

    it("exits 0 for malformed JSON input", () => {
      const res = runGuard("{malformed-json");
      assert.equal(res.status, 0);
    });

    it("exits 0 for empty JSON object", () => {
      const res = runGuard({});
      assert.equal(res.status, 0);
    });

    it("exits 0 when tool_input has no path property", () => {
      const res = runGuard({ tool_input: { query: "search text" } });
      assert.equal(res.status, 0);
    });

    it("exits 0 for primitive non-object JSON values", () => {
      const res = runGuard(12345);
      assert.equal(res.status, 0);
    });
  });
});

describe("hook failure delivery: non-blocking execution (Requirement 48.14, Task 3.6)", () => {
  interface HookDispatchResult {
    blocked: boolean;
    deliveredStderr: string;
    exitCode: number;
  }

  function simulateHookDispatch(
    trigger: "PreToolUse" | "PostFileSave" | "PostTaskExec",
    command: string
  ): HookDispatchResult {
    const res = spawnSync(command, { shell: true, encoding: "utf8" });
    const exitCode = res.status ?? 0;
    const stderr = res.stderr || "";

    const blocked = trigger === "PreToolUse" && exitCode === 2;

    return {
      blocked,
      deliveredStderr: stderr,
      exitCode,
    };
  }

  it("delivers stderr without blocking when PostFileSave hook command fails (Requirement 48.14)", () => {
    const failingCommand = `${process.execPath} -e "console.error('Property test failure in lib/rules'); process.exit(1)"`;
    const result = simulateHookDispatch("PostFileSave", failingCommand);

    assert.equal(result.exitCode, 1);
    assert.equal(result.blocked, false, "PostFileSave hook failure must not block agent execution");
    assert.ok(
      result.deliveredStderr.includes("Property test failure in lib/rules"),
      "Stderr must be delivered to agent"
    );
  });

  it("delivers stderr without blocking when PostTaskExec hook command fails (Requirement 48.14)", () => {
    const failingCommand = `${process.execPath} -e "console.error('Golden test snapshot mismatch'); process.exit(1)"`;
    const result = simulateHookDispatch("PostTaskExec", failingCommand);

    assert.equal(result.exitCode, 1);
    assert.equal(result.blocked, false, "PostTaskExec hook failure must not block agent execution");
    assert.ok(
      result.deliveredStderr.includes("Golden test snapshot mismatch"),
      "Stderr must be delivered to agent"
    );
  });

  it("blocks agent execution when PreToolUse guard exits with code 2 (Requirement 48.4)", () => {
    const blockingCommand = `${process.execPath} -e "console.error('Blocked write to protected path: test/golden'); process.exit(2)"`;
    const result = simulateHookDispatch("PreToolUse", blockingCommand);

    assert.equal(result.exitCode, 2);
    assert.equal(result.blocked, true, "PreToolUse exit 2 must block agent execution");
    assert.ok(result.deliveredStderr.includes("Blocked write to protected path: test/golden"));
  });

  it("does not block agent execution when PreToolUse guard exits with code 0 (Requirement 48.13)", () => {
    const successCommand = `${process.execPath} -e "process.exit(0)"`;
    const result = simulateHookDispatch("PreToolUse", successCommand);

    assert.equal(result.exitCode, 0);
    assert.equal(result.blocked, false);
    assert.equal(result.deliveredStderr, "");
  });
});
