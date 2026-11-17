import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePact,
  parseTasks,
  parseTasksMd,
  parsePactOrThrow,
  isCommandBlocked,
  isPathOutsideRepo,
  PactErrorCodes,
  type PactTask,
} from "../../lib/pact/pact-parser";

describe("Pact Parser: Grammar Acceptance (Requirement 12.4)", () => {
  it("parses valid standard tasks markdown with bonesetter and soul-stitcher roles", () => {
    const markdown = `# Tasks
- [ ] T1. Update dependencies
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Migrate deprecated APIs
  - role: soul-stitcher
  - depends: T1
  - files: lib/api.js, lib/utils.js
  - accept: npm test
  - hard: yes
  - rules: M2, M3
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].id, "T1");
    assert.equal(result.tasks[0].role, "bonesetter");
    assert.equal(result.tasks[0].hard, false);
    assert.deepEqual(result.tasks[0].rules, ["M1"]);

    assert.equal(result.tasks[1].id, "T2");
    assert.equal(result.tasks[1].role, "soul-stitcher");
    assert.deepEqual(result.tasks[1].dependencies, ["T1"]);
    assert.equal(result.tasks[1].hard, true);
    assert.deepEqual(result.tasks[1].rules, ["M2", "M3"]);
  });

  it("handles parseTasks and parseTasksMd aliases", () => {
    const markdown = `- [ ] T1. Solo task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const res1 = parseTasks(markdown);
    const res2 = parseTasksMd(markdown);
    assert.equal(res1.ok, true);
    assert.equal(res2.ok, true);
  });

  it("parses checked tasks with [x] and [X]", () => {
    const markdown = `- [x] T1. Completed task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [X] T2. Another completed task
  - role: soul-stitcher
  - depends: T1
  - files: index.js
  - accept: npm test
  - hard: no
  - rules: M2
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tasks.length, 2);
  });

  it("rejects non-string input with INVALID_SYNTAX", () => {
    // @ts-expect-error test non-string input
    const result = parsePact(12345);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0].code, PactErrorCodes.INVALID_SYNTAX);
  });

  it("rejects empty markdown with EMPTY_PACT", () => {
    const result = parsePact("");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0].code, PactErrorCodes.EMPTY_PACT);
  });

  it("rejects markdown with only comments and headers", () => {
    const markdown = `# Tasks Document
## Overview
Some notes here.
---
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0].code, PactErrorCodes.EMPTY_PACT);
  });

  it("rejects task missing title with INVALID_SYNTAX", () => {
    const markdown = `- [ ] T1.
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.INVALID_SYNTAX));
  });

  it("rejects task missing required metadata bullets (Requirement 12.4)", () => {
    const requiredKeys = ["role", "depends", "files", "accept", "hard", "rules"];
    for (const missingKey of requiredKeys) {
      const bullets = [
        "  - role: bonesetter",
        "  - depends:",
        "  - files: package.json",
        "  - accept: npm test",
        "  - hard: no",
        "  - rules: M1",
      ].filter((line) => !line.includes(`- ${missingKey}:`));

      const markdown = `- [ ] T1. Incomplete task\n${bullets.join("\n")}\n`;
      const result = parsePact(markdown);
      assert.equal(result.ok, false);
      if (result.ok) return;
      const missingError = result.errors.find(
        (e) => e.code === PactErrorCodes.MISSING_METADATA && e.message.includes(missingKey)
      );
      assert.ok(missingError, `Expected MISSING_METADATA error for ${missingKey}`);
      assert.equal(missingError?.task, "T1");
    }
  });

  it("rejects duplicate metadata bullets", () => {
    const markdown = `- [ ] T1. Duplicate bullet task
  - role: bonesetter
  - role: soul-stitcher
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.DUPLICATE_METADATA));
  });

  it("rejects unknown metadata bullets", () => {
    const markdown = `- [ ] T1. Unknown bullet task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
  - priority: high
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.UNKNOWN_METADATA));
  });

  it("rejects unexpected lines inside a task block", () => {
    const markdown = `- [ ] T1. Unexpected content task
  - role: bonesetter
  random garbage line inside task
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.INVALID_SYNTAX));
  });
});

describe("Pact Parser: Task ID Validation (Requirement 12.5)", () => {
  it("accepts valid T<n> task IDs", () => {
    const markdown = `- [ ] T1. Task One
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T42. Task Forty Two
  - role: soul-stitcher
  - depends: T1
  - files: index.js
  - accept: npm test
  - hard: no
  - rules: M2
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
  });

  it("rejects invalid task ID formats naming the task", () => {
    const invalidIds = ["TASK-1", "t1", "1", "T", "T_1", "T-99", "abc"];
    for (const invalidId of invalidIds) {
      const markdown = `- [ ] ${invalidId}. Invalid ID task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
      const result = parsePact(markdown);
      assert.equal(result.ok, false);
      if (result.ok) return;
      const err = result.errors.find((e) => e.code === PactErrorCodes.INVALID_TASK_ID);
      assert.ok(err, `Expected INVALID_TASK_ID for ${invalidId}`);
      assert.equal(err?.task, invalidId);
    }
  });

  it("rejects duplicate task IDs naming the task", () => {
    const markdown = `- [ ] T1. First task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T1. Duplicate first task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.DUPLICATE_TASK_ID);
    assert.ok(err);
    assert.equal(err?.task, "T1");
  });
});

describe("Pact Parser: Role Validation (Requirement 12.6)", () => {
  it("accepts bonesetter and soul-stitcher roles", () => {
    const markdown = `- [ ] T1. Bonesetter task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Soul-stitcher task
  - role: soul-stitcher
  - depends: T1
  - files: index.js
  - accept: npm test
  - hard: no
  - rules: M2
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tasks[0].role, "bonesetter");
    assert.equal(result.tasks[1].role, "soul-stitcher");
  });

  it("rejects unauthorized roles naming the task", () => {
    const badRoles = ["necromancer", "warden", "builder", "planner", "scribe", "user"];
    for (const badRole of badRoles) {
      const markdown = `- [ ] T1. Bad role task
  - role: ${badRole}
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
      const result = parsePact(markdown);
      assert.equal(result.ok, false);
      if (result.ok) return;
      const err = result.errors.find((e) => e.code === PactErrorCodes.INVALID_ROLE);
      assert.ok(err, `Expected INVALID_ROLE for ${badRole}`);
      assert.equal(err?.task, "T1");
    }
  });
});

describe("Pact Parser: Dependency Validation and Cycle Detection (Requirement 12.7)", () => {
  it("accepts multiple valid dependencies", () => {
    const markdown = `- [ ] T1. Base A
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Base B
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T3. Derived C
  - role: soul-stitcher
  - depends: T1, T2
  - files: lib/c.js
  - accept: npm test
  - hard: no
  - rules: M2
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.tasks[2].dependencies, ["T1", "T2"]);
  });

  it("rejects missing dependency IDs naming the missing ID and task", () => {
    const markdown = `- [ ] T1. Task depending on ghost
  - role: bonesetter
  - depends: T99
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.MISSING_DEPENDENCY);
    assert.ok(err);
    assert.equal(err?.task, "T1");
    assert.match(err?.message ?? "", /T99/);
  });

  it("rejects direct dependency cycle (T1 -> T2 -> T1)", () => {
    const markdown = `- [ ] T1. Task One
  - role: bonesetter
  - depends: T2
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Task Two
  - role: soul-stitcher
  - depends: T1
  - files: lib/api.js
  - accept: npm test
  - hard: no
  - rules: M2
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.DEPENDENCY_CYCLE);
    assert.ok(err);
    assert.match(err?.message ?? "", /cycle/i);
  });

  it("rejects self-referencing cycle (T1 -> T1)", () => {
    const markdown = `- [ ] T1. Self dependent task
  - role: bonesetter
  - depends: T1
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.DEPENDENCY_CYCLE);
    assert.ok(err);
  });

  it("rejects 3-task dependency cycle (T1 -> T2 -> T3 -> T1)", () => {
    const markdown = `- [ ] T1. Task One
  - role: bonesetter
  - depends: T3
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Task Two
  - role: soul-stitcher
  - depends: T1
  - files: lib/two.js
  - accept: npm test
  - hard: no
  - rules: M2
- [ ] T3. Task Three
  - role: soul-stitcher
  - depends: T2
  - files: lib/three.js
  - accept: npm test
  - hard: no
  - rules: M3
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.DEPENDENCY_CYCLE);
    assert.ok(err);
  });
});

describe("Pact Parser: File Path Bounds Validation (Requirement 12.8)", () => {
  it("accepts valid repository-relative paths", () => {
    const markdown = `- [ ] T1. Valid paths task
  - role: bonesetter
  - depends:
  - files: package.json, src/index.ts, lib/pact/pact-parser.ts, deeply/nested/dir/file.txt
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tasks[0].files.length, 4);
  });

  it("rejects empty files list naming the task", () => {
    const markdown = `- [ ] T1. No files task
  - role: bonesetter
  - depends:
  - files:
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.EMPTY_FILES);
    assert.ok(err);
    assert.equal(err?.task, "T1");
  });

  it("rejects file paths escaping repository via traversal (Requirement 12.8)", () => {
    const markdown = `- [ ] T1. Traversal escape
  - role: bonesetter
  - depends:
  - files: ../../../etc/passwd
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.PATH_OUTSIDE_REPO);
    assert.ok(err);
    assert.equal(err?.task, "T1");
  });

  it("rejects absolute file paths naming the task", () => {
    const markdown = `- [ ] T1. Absolute path task
  - role: bonesetter
  - depends:
  - files: /etc/shadow
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.PATH_OUTSIDE_REPO);
    assert.ok(err);
    assert.equal(err?.task, "T1");
  });

  it("rejects home directory paths", () => {
    const markdown = `- [ ] T1. Home directory task
  - role: bonesetter
  - depends:
  - files: ~/.ssh/id_rsa
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.PATH_OUTSIDE_REPO));
  });

  it("isPathOutsideRepo correctly classifies various paths", () => {
    assert.equal(isPathOutsideRepo("src/index.ts"), false);
    assert.equal(isPathOutsideRepo("package.json"), false);
    assert.equal(isPathOutsideRepo("a/b/c/d.js"), false);
    assert.equal(isPathOutsideRepo("a/../b.js"), false);

    assert.equal(isPathOutsideRepo("../secret.txt"), true);
    assert.equal(isPathOutsideRepo("a/../../secret.txt"), true);
    assert.equal(isPathOutsideRepo("/root/file.txt"), true);
    assert.equal(isPathOutsideRepo("~/file.txt"), true);
    assert.equal(isPathOutsideRepo("C:/Windows/System32"), true);
    assert.equal(isPathOutsideRepo(""), false);
  });
});

describe("Pact Parser: Command Policy and Blocked Commands (Requirement 12.9)", () => {
  it("accepts safe acceptance commands", () => {
    const markdown = `- [ ] T1. Safe command task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test -- --coverage
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tasks[0].acceptanceCommand, "npm test -- --coverage");
  });

  it("rejects empty accept command naming the task", () => {
    const markdown = `- [ ] T1. Empty accept task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept:
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.EMPTY_ACCEPT_COMMAND);
    assert.ok(err);
    assert.equal(err?.task, "T1");
  });

  it("rejects sudo commands under CommandPolicy", () => {
    const markdown = `- [ ] T1. Sudo task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: sudo rm -rf /
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const err = result.errors.find((e) => e.code === PactErrorCodes.BLOCKED_COMMAND);
    assert.ok(err);
    assert.equal(err?.task, "T1");
  });

  it("rejects cloud metadata IP access", () => {
    const markdown = `- [ ] T1. Metadata probe
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: curl http://169.254.169.254/latest/meta-data/
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.BLOCKED_COMMAND));
  });

  it("rejects container sockets access", () => {
    const markdown = `- [ ] T1. Socket escape
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: nc -U /var/run/docker.sock
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.BLOCKED_COMMAND));
  });

  it("rejects host mounts and proc system directories", () => {
    const markdown = `- [ ] T1. Mount escape
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: cat /proc/version
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.BLOCKED_COMMAND));
  });

  it("rejects SSH key and credentials directory access", () => {
    const markdown = `- [ ] T1. Key probe
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: cat ~/.ssh/id_rsa
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.BLOCKED_COMMAND));
  });

  it("rejects environment dumps (printenv, env, export)", () => {
    const markdown = `- [ ] T1. Env dump
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: printenv
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.BLOCKED_COMMAND));
  });

  it("rejects secret tokens and keys in accept command", () => {
    const markdown = `- [ ] T1. Token leak
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: echo $KIRO_API_KEY
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.BLOCKED_COMMAND));
  });

  it("respects custom commandPolicy option", () => {
    const markdown = `- [ ] T1. Custom blocked command
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: custom-tool --run
  - hard: no
  - rules: M1
`;
    const result = parsePact(markdown, {
      commandPolicy: (cmd) => (cmd.includes("custom-tool") ? "blocked" : "allowed"),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.code === PactErrorCodes.BLOCKED_COMMAND));
  });

  it("isCommandBlocked helper identifies blocked commands accurately", () => {
    assert.equal(isCommandBlocked("npm test").blocked, false);
    assert.equal(isCommandBlocked("node build.js").blocked, false);
    assert.equal(isCommandBlocked("sudo npm test").blocked, true);
    assert.equal(isCommandBlocked("curl 169.254.169.254").blocked, true);
    assert.equal(isCommandBlocked("cat docker.sock").blocked, true);
    assert.equal(isCommandBlocked("").blocked, true);
  });
});

describe("Pact Parser: Hard Flag Validation (Requirement 12.10)", () => {
  it("accepts hard: yes as true and hard: no as false", () => {
    const markdown = `- [ ] T1. Soft task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Hard task
  - role: soul-stitcher
  - depends: T1
  - files: index.js
  - accept: npm test
  - hard: yes
  - rules: M2
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tasks[0].hard, false);
    assert.equal(result.tasks[0].hardRaw, "no");
    assert.equal(result.tasks[1].hard, true);
    assert.equal(result.tasks[1].hardRaw, "yes");
  });

  it("rejects non-yes/no hard values naming the task", () => {
    const badHardValues = ["true", "false", "maybe", "1", "0", "YES_PLEASE"];
    for (const badVal of badHardValues) {
      const markdown = `- [ ] T1. Bad hard task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: ${badVal}
  - rules: M1
`;
      const result = parsePact(markdown);
      assert.equal(result.ok, false);
      if (result.ok) return;
      const err = result.errors.find((e) => e.code === PactErrorCodes.INVALID_HARD_FLAG);
      assert.ok(err, `Expected INVALID_HARD_FLAG for ${badVal}`);
      assert.equal(err?.task, "T1");
    }
  });
});

describe("Pact Parser: Rules Validation (Requirement 12.11)", () => {
  it("accepts all valid rules M1 through M6", () => {
    const markdown = `- [ ] T1. All rules task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1, M2, M3, M4, M5, M6
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.tasks[0].rules, ["M1", "M2", "M3", "M4", "M5", "M6"]);
  });

  it("accepts empty rules bullet", () => {
    const markdown = `- [ ] T1. No rules task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules:
`;
    const result = parsePact(markdown);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.tasks[0].rules, []);
  });

  it("rejects rules outside M1 through M6 naming the task and rule", () => {
    const badRules = ["M0", "M7", "M99", "R1", "RULE1"];
    for (const badRule of badRules) {
      const markdown = `- [ ] T1. Bad rule task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: ${badRule}
`;
      const result = parsePact(markdown);
      assert.equal(result.ok, false);
      if (result.ok) return;
      const err = result.errors.find((e) => e.code === PactErrorCodes.INVALID_RULE);
      assert.ok(err, `Expected INVALID_RULE for ${badRule}`);
      assert.equal(err?.task, "T1");
      assert.match(err?.message ?? "", new RegExp(badRule));
    }
  });
});

describe("Pact Parser: parsePactOrThrow Helper", () => {
  it("returns tasks when input is valid", () => {
    const markdown = `- [ ] T1. Good task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const tasks = parsePactOrThrow(markdown);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "T1");
  });

  it("throws error with formatted messages when input is invalid", () => {
    const markdown = `- [ ] T1. Bad task
  - role: necromancer
  - depends:
  - files: package.json
  - accept: sudo rm -rf /
  - hard: maybe
  - rules: M99
`;
    assert.throws(
      () => parsePactOrThrow(markdown),
      (err: Error) => {
        assert.match(err.message, /Pact parsing failed/);
        assert.match(err.message, /INVALID_ROLE/);
        assert.match(err.message, /BLOCKED_COMMAND/);
        assert.match(err.message, /INVALID_HARD_FLAG/);
        assert.match(err.message, /INVALID_RULE/);
        return true;
      }
    );
  });
});
