// Work package R3-C: Environment-dump bypasses and npm script allowance
// Requirements: 20.1, 20.3, 20.4, 29.11

import test from "node:test";
import * as assert from "node:assert/strict";
import {
  classifyCommand,
  checkHardBlocks,
  checkAllowedRules,
  isEnvironmentDump,
  removeQuotes,
  splitShellListAndPipelines,
  unwrapWrappers,
} from "../../lib/gateway/command-policy";

test("R3-C environment-dump bypass forms are all denied (blocked)", () => {
  const options = { worktreeRoot: "/workspace/repo", cwd: "/workspace/repo" };

  // Form 1: sh -c 'exec env'
  const res1 = classifyCommand(["sh", "-c", "exec env"], options);
  assert.equal(res1.classification, "blocked", "sh -c 'exec env' must be blocked");
  assert.equal(res1.matchedRule, "hard-block-env-dump");

  // Form 2: command env
  const res2 = classifyCommand(["command", "env"], options);
  assert.equal(res2.classification, "blocked", "command env must be blocked");
  assert.equal(res2.matchedRule, "hard-block-env-dump");

  // Form 3: quote-split name such as e''nv
  const res3 = classifyCommand(["e''nv"], options);
  assert.equal(res3.classification, "blocked", "quote-split e''nv must be blocked");
  assert.equal(res3.matchedRule, "hard-block-env-dump");

  // Form 4: node -p with require('process').env
  const res4 = classifyCommand(["node", "-p", "require('process').env"], options);
  assert.equal(res4.classification, "blocked", "node -p with require('process').env must be blocked");
  assert.equal(res4.matchedRule, "hard-block-env-dump");

  // Form 5: ruby -e ENV
  const res5 = classifyCommand(["ruby", "-e", "ENV"], options);
  assert.equal(res5.classification, "blocked", "ruby -e ENV must be blocked");
  assert.equal(res5.matchedRule, "hard-block-env-dump");

  // Form 6: python3 -c with os.environ
  const res6 = classifyCommand(
    ["python3", "-c", "import os; print(os.environ)"],
    options
  );
  assert.equal(res6.classification, "blocked", "python3 -c with os.environ must be blocked");
  assert.equal(res6.matchedRule, "hard-block-env-dump");

  // Form 7: perl -e with %ENV
  const res7 = classifyCommand(["perl", "-e", "print %ENV"], options);
  assert.equal(res7.classification, "blocked", "perl -e with %ENV must be blocked");
  assert.equal(res7.matchedRule, "hard-block-env-dump");

  // Form 8: declare -x
  const res8 = classifyCommand(["declare", "-x"], options);
  assert.equal(res8.classification, "blocked", "declare -x must be blocked");
  assert.equal(res8.matchedRule, "hard-block-env-dump");

  // Form 9: printenv
  const res9 = classifyCommand(["printenv"], options);
  assert.equal(res9.classification, "blocked", "printenv must be blocked");
  assert.equal(res9.matchedRule, "hard-block-env-dump");
});

test("R3-C POSIX shell normalization blocks pipelines, lists, quote variations, and wrapper chains", () => {
  const options = { worktreeRoot: "/workspace/repo", cwd: "/workspace/repo" };

  const variations: Array<{ argv: string[]; label: string }> = [
    // Pipelines and lists in sh -c
    { argv: ["sh", "-c", "echo hello && command env"], label: "sh -c list with command env" },
    { argv: ["sh", "-c", "echo test | printenv"], label: "sh -c pipeline with printenv" },
    { argv: ["sh", "-c", "false || e''nv"], label: "sh -c conditional with quote-split env" },
    { argv: ["sh", "-c", "exec printenv"], label: "sh -c exec printenv" },
    { argv: ["sh", "-c", "echo safe; ruby -e ENV"], label: "sh -c list with ruby -e ENV" },
    { argv: ["sh", "-c", "python3 -c 'import os; print(os.environ)' | cat"], label: "sh -c pipeline with python3 os.environ" },
    { argv: ["sh", "-c", "perl -e 'print %ENV'"], label: "sh -c perl %ENV" },
    { argv: ["sh", "-c", "declare -x"], label: "sh -c declare -x" },
    // Quote-split variations
    { argv: ["e\"\"nv"], label: "double quote-split e\"\"nv" },
    { argv: ["p''rintenv"], label: "quote-split p''rintenv" },
    { argv: ["d''eclare", "-x"], label: "quote-split d''eclare -x" },
    { argv: ["c'omm'and", "e''nv"], label: "quote-split command and env" },
    // Nested wrappers
    { argv: ["command", "exec", "env"], label: "command exec env" },
    { argv: ["env", "FOO=1", "command", "printenv"], label: "env with assignment wrapping command printenv" },
    { argv: ["command", "ruby", "-e", "ENV"], label: "command ruby -e ENV" },
    { argv: ["exec", "python3", "-c", "import os; print(os.environ)"], label: "exec python3 -c os.environ" },
    { argv: ["command", "perl", "-e", "print %ENV"], label: "command perl -e %ENV" },
    { argv: ["command", "node", "-p", "require('process').env"], label: "command node -p require('process').env" },
  ];

  for (const item of variations) {
    const res = classifyCommand(item.argv, options);
    assert.equal(
      res.classification,
      "blocked",
      `Expected blocked for ${item.label}, got ${res.classification}`
    );
    assert.equal(res.matchedRule, "hard-block-env-dump");
  }
});

test("R3-X2 / Requirement 20.3: npm scripts allowed inside worktree (npm test, npm t, npm run test, npm run build, lint, typecheck)", () => {
  const options = { worktreeRoot: "/workspace/repo", cwd: "/workspace/repo" };

  const allowedNpmCommands = [
    ["npm", "test"],
    ["npm", "t"],
    ["npm", "run", "test"],
    ["npm", "run", "build"],
    ["npm", "run", "lint"],
    ["npm", "run", "typecheck"],
  ];

  for (const argv of allowedNpmCommands) {
    const res = classifyCommand(argv, options);
    assert.equal(
      res.classification,
      "allowed",
      `Expected allowed for ${argv.join(" ")}, got ${res.classification}`
    );
  }
});

test("R3-C harmless commands stay allowed", () => {
  const options = { worktreeRoot: "/workspace/repo", cwd: "/workspace/repo" };

  const harmlessCommands = [
    ["ls"],
    ["ls", "-la"],
    ["git", "status"],
    ["git", "diff"],
    ["git", "log"],
    ["npm", "run", "lint"],
    ["npm", "run", "typecheck"],
    ["npm", "ci"],
    ["npm", "install"],
  ];

  for (const argv of harmlessCommands) {
    const res = classifyCommand(argv, options);
    assert.equal(
      res.classification,
      "allowed",
      `Expected allowed for ${argv.join(" ")}, got ${res.classification}`
    );
  }
});

test("R3-C unit tests for POSIX normalization helpers", () => {
  // removeQuotes
  assert.equal(removeQuotes("e''nv"), "env");
  assert.equal(removeQuotes('e""nv'), "env");
  assert.equal(removeQuotes("'command'"), "command");
  assert.equal(removeQuotes('"exec"'), "exec");
  assert.equal(removeQuotes("p''rintenv"), "printenv");

  // splitShellListAndPipelines
  const splits = splitShellListAndPipelines("echo 1; ruby -e 'ENV' | grep foo && exit 0");
  assert.deepEqual(splits, ["echo 1", "ruby -e 'ENV'", "grep foo", "exit 0"]);

  // unwrapWrappers
  const unwrapped1 = unwrapWrappers(["command", "exec", "env"]);
  assert.equal(unwrapped1.isEnvDump, true);

  const unwrapped2 = unwrapWrappers(["command", "ls"]);
  assert.equal(unwrapped2.isEnvDump, false);
  assert.deepEqual(unwrapped2.words, ["ls"]);
});
