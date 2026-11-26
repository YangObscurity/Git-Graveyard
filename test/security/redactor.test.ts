// Unit tests for lib/security/redactor.ts
// Requirements: 22.14, 22.15, 42.1, 42.2, 42.3, 42.4, 42.5

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  DEFAULT_REDACTION_MASK,
  SENSITIVE_PATTERNS,
  HOST_DETAIL_PATTERNS,
  SECRET_ENV_VARS,
  escapeRegExp,
  getEnvSecrets,
  redactText,
  redactValue,
  redactObject,
  redactEventData,
  redactEvent,
  redactLog,
  scanTextForSecrets,
  scanCandidateDiff,
  scanWorktreeFiles,
  shouldQuarantineWorktree,
  Redactor,
  createRedactor,
} from "../../lib/security/redactor";

describe("redactor: constants and helper utilities", () => {
  it("exports default redaction mask matching [REDACTED]", () => {
    assert.equal(DEFAULT_REDACTION_MASK, "[REDACTED]");
  });

  it("exports sensitive pattern definitions", () => {
    assert.ok(Array.isArray(SENSITIVE_PATTERNS));
    assert.ok(SENSITIVE_PATTERNS.length >= 7);
  });

  it("exports host detail pattern definitions", () => {
    assert.ok(Array.isArray(HOST_DETAIL_PATTERNS));
    assert.ok(HOST_DETAIL_PATTERNS.length >= 5);
  });

  it("exports expected secret environment variable names", () => {
    assert.deepEqual([...SECRET_ENV_VARS], [
      "ADMIN_KEY",
      "ADMIN_TOKEN",
      "ADMIN_SECRET",
      "GITHUB_WRITE_TOKEN",
      "GITHUB_TOKEN",
      "KIRO_KEY",
      "KIRO_API_KEY",
      "P12_SECRET",
      "INVITE_CODES",
    ]);
  });

  it("escapes regex special characters safely", () => {
    const raw = "test.*+?^${}()|[]\\string";
    const escaped = escapeRegExp(raw);
    const regex = new RegExp(escaped);
    assert.ok(regex.test(raw));
  });

  it("retrieves environment secrets cleanly", () => {
    const origEnv = process.env.KIRO_API_KEY;
    try {
      process.env.KIRO_API_KEY = "dummy-test-key-12345";
      const secrets = getEnvSecrets();
      assert.ok(secrets.includes("dummy-test-key-12345"));
    } finally {
      if (origEnv !== undefined) {
        process.env.KIRO_API_KEY = origEnv;
      } else {
        delete process.env.KIRO_API_KEY;
      }
    }
  });
});

describe("redactor: redactText (Requirements 42.2, 42.3, 42.4)", () => {
  it("handles non-string or empty input safely", () => {
    assert.equal(redactText(""), "");
    assert.equal(redactText(null as unknown as string), null);
    assert.equal(redactText(undefined as unknown as string), undefined);
  });

  it("replaces exact secrets specified in options (Requirement 42.2)", () => {
    const secretA = "custom-secret-alpha";
    const secretB = "custom-secret-beta";
    const input = `Authorization: Bearer ${secretA} and token=${secretB}`;
    const result = redactText(input, {
      secrets: [secretA, secretB],
      autoRegisterEnvSecrets: false,
    });
    assert.equal(result, "Authorization: Bearer [REDACTED] and token=[REDACTED]");
  });

  it("replaces longer secrets before prefix substrings", () => {
    const shortSecret = "secret";
    const longSecret = "secret-super-long-token";
    const input = `Key: ${longSecret} and ${shortSecret}`;
    const result = redactText(input, {
      secrets: [shortSecret, longSecret],
      autoRegisterEnvSecrets: false,
    });
    assert.equal(result, "Key: [REDACTED] and [REDACTED]");
  });

  it("supports custom redaction mask", () => {
    const secret = "my-secret-vault-key";
    const input = `Access: ${secret}`;
    const result = redactText(input, {
      secrets: [secret],
      mask: "***MASKED***",
      autoRegisterEnvSecrets: false,
    });
    assert.equal(result, "Access: ***MASKED***");
  });

  it("replaces sensitive token patterns (Requirement 42.3)", () => {
    const dummyKsk = ["ksk", "test_canary_001_12345"].join("_");
    const dummyGhp = ["ghp", "test_canary_002_12345"].join("_");
    const dummyPat = ["github", "pat", "test_canary_003_12345"].join("_");
    const dummyDckr = ["dckr", "pat", "test_canary_004_12345"].join("_");
    const dummyAkia = "AKIA1234567890SAMPLE";
    const dummyPem = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

    const input = `Keys: ${dummyKsk}, ${dummyGhp}, ${dummyPat}, ${dummyDckr}, ${dummyAkia}, and cert:\n${dummyPem}`;
    const result = redactText(input, { autoRegisterEnvSecrets: false });

    assert.ok(!result.includes(dummyKsk));
    assert.ok(!result.includes(dummyGhp));
    assert.ok(!result.includes(dummyPat));
    assert.ok(!result.includes(dummyDckr));
    assert.ok(!result.includes(dummyAkia));
    assert.ok(!result.includes("PRIVATE KEY"));
    assert.ok(result.includes("[REDACTED]"));
  });

  it("replaces single-line or unclosed PEM header (Requirement 42.3)", () => {
    const header = "-----BEGIN RSA PRIVATE KEY-----";
    const input = `Found cert header: ${header}`;
    const result = redactText(input, { autoRegisterEnvSecrets: false });
    assert.equal(result, "Found cert header: [REDACTED]");
  });

  it("replaces host filesystem paths and network addresses (Requirement 42.4)", () => {
    const pathA = ["", "data", "home", "developer", "project"].join("/");
    const pathB = ["C:", "Users", "operator", "app"].join("\\");
    const pathC = ["", "home", "service", "daemon"].join("/");
    const sampleIpv4 = ["192", "168", "0", "42"].join(".");
    const sampleIpv4WithPort = ["10", "1", "2", "3"].join(".") + ":8080";
    const sampleIpv6 = [":", ":", "1"].join("");

    const input = `Log from ${pathA} on ${sampleIpv4} and ${pathB} on ${sampleIpv4WithPort} or ${sampleIpv6} and ${pathC}`;
    const result = redactText(input, { autoRegisterEnvSecrets: false });

    assert.ok(!result.includes(pathA));
    assert.ok(!result.includes(pathB));
    assert.ok(!result.includes(pathC));
    assert.ok(!result.includes(sampleIpv4));
    assert.ok(!result.includes(sampleIpv4WithPort));
    assert.ok(!result.includes(sampleIpv6));
  });

  it("replaces caller-provided custom host paths and details", () => {
    const customHost = "box-runner-node-99";
    const input = `Connecting to ${customHost}/endpoint`;
    const result = redactText(input, {
      hostPaths: [customHost],
      autoRegisterEnvSecrets: false,
    });
    assert.equal(result, "Connecting to [REDACTED]/endpoint");
  });
});

describe("redactor: redactValue and redactObject (pure deep cloning)", () => {
  it("redacts nested objects without mutating source", () => {
    const secret = "secret-sample-token";
    const original = {
      user: "worker-01",
      token: secret,
      meta: {
        nestedSecret: secret,
        count: 42,
        active: true,
      },
      tags: ["alpha", secret, "gamma"],
    };

    const redacted = redactValue(original, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    // Check immutability
    assert.notEqual(redacted, original);
    assert.equal(original.token, secret);
    assert.equal(original.meta.nestedSecret, secret);
    assert.equal(original.tags[1], secret);

    // Check redacted outputs
    assert.equal(redacted.user, "worker-01");
    assert.equal(redacted.token, "[REDACTED]");
    assert.equal(redacted.meta.nestedSecret, "[REDACTED]");
    assert.equal(redacted.meta.count, 42);
    assert.equal(redacted.meta.active, true);
    assert.deepEqual(redacted.tags, ["alpha", "[REDACTED]", "gamma"]);
  });

  it("handles Maps and Sets safely", () => {
    const secret = "map-set-secret-val";
    const mySet = new Set(["public", secret]);
    const myMap = new Map([
      ["key1", secret],
      [secret, "value2"],
    ]);

    const redactedSet = redactValue(mySet, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });
    const redactedMap = redactValue(myMap, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.ok(redactedSet.has("public"));
    assert.ok(redactedSet.has("[REDACTED]"));
    assert.ok(!redactedSet.has(secret));

    assert.equal(redactedMap.get("key1"), "[REDACTED]");
    assert.equal(redactedMap.get("[REDACTED]"), "value2");
  });

  it("handles circular references without infinite recursion", () => {
    const secret = "circular-secret-val";
    const node: Record<string, unknown> = {
      name: "nodeA",
      secret,
    };
    node.self = node;

    const redacted = redactValue(node, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.equal(redacted.name, "nodeA");
    assert.equal(redacted.secret, "[REDACTED]");
    assert.ok(redacted.self !== undefined);
  });

  it("handles Error instances and preserves stack", () => {
    const secret = "err-secret-payload";
    const err = new Error(`Failed with ${secret}`);
    const redactedErr = redactValue(err, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.ok(redactedErr instanceof Error);
    assert.equal(redactedErr.message, "Failed with [REDACTED]");
    if (redactedErr.stack) {
      assert.ok(!redactedErr.stack.includes(secret));
    }
  });

  it("redactObject delegates cleanly to redactValue", () => {
    const secret = "obj-secret-payload";
    const obj = { secret, count: 10 };
    const res = redactObject(obj, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });
    assert.deepEqual(res, { secret: "[REDACTED]", count: 10 });
  });
});

describe("redactor: redactEvent and redactEventData (Requirement 42.1)", () => {
  it("redacts event data while preserving evidence references", () => {
    const secret = "evt-data-secret-123";
    const data = {
      command: `git checkout ${secret}`,
      refs: ["01_evidence/phase0/out.log", "01_evidence/diag.json"],
      status: "success",
    };

    const redacted = redactEventData(data, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.equal(redacted.command, "git checkout [REDACTED]");
    assert.equal(redacted.status, "success");
    assert.deepEqual(redacted.refs, [
      "01_evidence/phase0/out.log",
      "01_evidence/diag.json",
    ]);
  });

  it("redacts event envelope string properties and preserves event identifiers", () => {
    const secret = "actor-secret-token";
    const event = {
      seq: 14,
      runId: "run-2026-11-08-001",
      kind: "command.executed",
      phase: "legion",
      actor: `skeleton-agent-${secret}`,
      taskId: `T11.3-${secret}`,
      data: {
        rawOutput: `token is ${secret}`,
      },
    };

    const redacted = redactEvent(event, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.equal(redacted.seq, 14);
    assert.equal(redacted.runId, "run-2026-11-08-001");
    assert.equal(redacted.kind, "command.executed");
    assert.equal(redacted.phase, "legion");
    assert.equal(redacted.actor, "skeleton-agent-[REDACTED]");
    assert.equal(redacted.taskId, "T11.3-[REDACTED]");
    assert.equal((redacted.data as Record<string, unknown>).rawOutput, "token is [REDACTED]");
  });
});

describe("redactor: redactLog (Requirement 42.1)", () => {
  it("redacts log string directly", () => {
    const secret = "log-secret-val";
    const logStr = `[2026-11-08T00:00:00Z] error with ${secret}`;
    const result = redactLog(logStr, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });
    assert.equal(result, "[2026-11-08T00:00:00Z] error with [REDACTED]");
  });

  it("redacts command execution log object with stdout and stderr", () => {
    const secret = "cmd-secret-val";
    const logObj = {
      command: `npm run build --token=${secret}`,
      stdout: `Compiling with ${secret}... done`,
      stderr: `Warn: secret ${secret} exposed`,
      exitCode: 0,
    };

    const redacted = redactLog(logObj, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.equal(redacted.command, "npm run build --token=[REDACTED]");
    assert.equal(redacted.stdout, "Compiling with [REDACTED]... done");
    assert.equal(redacted.stderr, "Warn: secret [REDACTED] exposed");
    assert.equal(redacted.exitCode, 0);
  });
});

describe("redactor: secret scanning and quarantine (Requirement 42.5, 22.14, 22.15)", () => {
  it("returns passed=true when text contains no secrets or sensitive patterns", () => {
    const cleanText = "function add(a: number, b: number): number {\n  return a + b;\n}";
    const result = scanTextForSecrets(cleanText, { autoRegisterEnvSecrets: false });
    assert.equal(result.passed, true);
    assert.equal(result.hasSecrets, false);
    assert.equal(result.shouldQuarantine, false);
    assert.equal(result.violations.length, 0);
  });

  it("detects sensitive pattern and flags quarantine (Requirement 42.5)", () => {
    const canary = ["ksk", "canary_scanner_test_123"].join("_");
    const textWithSecret = `const token = "${canary}";`;
    const result = scanTextForSecrets(textWithSecret, { autoRegisterEnvSecrets: false });

    assert.equal(result.passed, false);
    assert.equal(result.hasSecrets, true);
    assert.equal(result.shouldQuarantine, true);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].type, "sensitive_pattern");
    assert.equal(result.violations[0].match, canary);
    assert.equal(result.violations[0].line, 1);
  });

  it("scans candidate git diff and flags added lines with secrets", () => {
    const canary = ["ghp", "canary_diff_token_12345"].join("_");
    const diff = [
      "diff --git a/src/api.ts b/src/api.ts",
      "index 1111111..2222222 100644",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -1,3 +1,4 @@",
      " import express from 'express';",
      "-const oldKey = null;",
      `+const auth = '${canary}';`,
      " export default auth;",
    ].join("\n");

    const result = scanCandidateDiff(diff, { autoRegisterEnvSecrets: false });

    assert.equal(result.passed, false);
    assert.equal(result.hasSecrets, true);
    assert.equal(result.shouldQuarantine, true);
    assert.deepEqual(result.flaggedFiles, ["src/api.ts"]);
    assert.equal(result.violations[0].match, canary);
  });

  it("scans candidate git diff without triggering on unchanged or removed lines", () => {
    const canary = ["ghp", "old_removed_token_1234"].join("_");
    const diff = [
      "diff --git a/src/api.ts b/src/api.ts",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -1,3 +1,3 @@",
      `-const auth = '${canary}';`,
      "+const auth = process.env.TOKEN;",
      " export default auth;",
    ].join("\n");

    const result = scanCandidateDiff(diff, { autoRegisterEnvSecrets: false });
    assert.equal(result.passed, true);
    assert.equal(result.shouldQuarantine, false);
  });

  it("scans worktree files collection and quarantines on secret hit (Requirements 22.14, 22.15)", () => {
    const canaryA = ["github", "pat", "canary_worktree_12345"].join("_");
    const files = [
      { path: "src/utils.ts", content: "export const ok = true;" },
      { path: "config/secrets.env", content: `API_KEY=${canaryA}` },
    ];

    const result = scanWorktreeFiles(files, { autoRegisterEnvSecrets: false });

    assert.equal(result.passed, false);
    assert.equal(result.shouldQuarantine, true);
    assert.deepEqual(result.flaggedFiles, ["config/secrets.env"]);
    assert.equal(shouldQuarantineWorktree(result), true);
  });

  it("scans worktree files passed as record map", () => {
    const filesMap = {
      "README.md": "# Clean project",
      "src/index.ts": "console.log('hello world');",
    };
    const result = scanWorktreeFiles(filesMap, { autoRegisterEnvSecrets: false });
    assert.equal(result.passed, true);
    assert.equal(result.shouldQuarantine, false);
  });
});

describe("redactor: Redactor class and createRedactor factory", () => {
  it("encapsulates options and provides consistent API", () => {
    const secret = "encapsulated-secret";
    const redactor = createRedactor({
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.ok(redactor instanceof Redactor);
    assert.equal(redactor.redactText(`val=${secret}`), "val=[REDACTED]");
    assert.deepEqual(redactor.redactObject({ secret }), { secret: "[REDACTED]" });
    assert.equal(redactor.redactLog(`error: ${secret}`), "error: [REDACTED]");

    const scan = redactor.scanText(`key=${secret}`);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.shouldQuarantine, true);
  });
});

describe("redactor: extended coverage and pure function edge cases", () => {
  it("retrieves comma-separated invite codes and extra secret env vars cleanly", () => {
    const origInvite = process.env.INVITE_CODES;
    try {
      process.env.INVITE_CODES = "invite-alpha-1234, invite-beta-5678";
      const secrets = getEnvSecrets();
      assert.ok(secrets.includes("invite-alpha-1234"));
      assert.ok(secrets.includes("invite-beta-5678"));
    } finally {
      if (origInvite !== undefined) {
        process.env.INVITE_CODES = origInvite;
      } else {
        delete process.env.INVITE_CODES;
      }
    }
  });

  it("redacts Buffer instances and returns a clean Buffer copy", () => {
    const secret = "buffer-secret-data";
    const rawBuf = Buffer.from(`Log payload with ${secret}`);
    const redactedBuf = redactValue(rawBuf, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.ok(Buffer.isBuffer(redactedBuf));
    assert.equal(redactedBuf.toString("utf-8"), "Log payload with [REDACTED]");
  });

  it("redacts event payload structure with refs preservation", () => {
    const secret = "payload-secret-val";
    const event = {
      seq: 20,
      runId: "run-2026-11-08-002",
      kind: "command.executed",
      phase: "legion",
      payload: {
        command: `echo ${secret}`,
        refs: ["cmd:echo", "file:package.json"],
      },
    };

    const redacted = redactEvent(event, {
      secrets: [secret],
      autoRegisterEnvSecrets: false,
    });

    assert.equal((redacted.payload as Record<string, unknown>).command, "echo [REDACTED]");
    assert.deepEqual((redacted.payload as Record<string, unknown>).refs, [
      "cmd:echo",
      "file:package.json",
    ]);
  });

  it("scans text against caller-provided hostPaths and hostDetails", () => {
    const customHost = "test-node-instance-77";
    const text = `Connecting to host ${customHost} now`;
    const scan = scanTextForSecrets(text, {
      hostPaths: [customHost],
      autoRegisterEnvSecrets: false,
    });

    assert.equal(scan.passed, false);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.shouldQuarantine, true);
    assert.equal(scan.violations.length, 1);
    assert.equal(scan.violations[0].type, "host_detail");
    assert.equal(scan.violations[0].match, customHost);
  });

  it("scans worktree files with Buffer content safely", () => {
    const canary = ["ghp", "worktree_buf_canary_1"].join("_");
    const files = [
      {
        path: "src/main.ts",
        content: Buffer.from(`const token = "${canary}";`),
      },
    ];

    const result = scanWorktreeFiles(files as any, { autoRegisterEnvSecrets: false });
    assert.equal(result.passed, false);
    assert.equal(result.shouldQuarantine, true);
    assert.deepEqual(result.flaggedFiles, ["src/main.ts"]);
  });
});

describe("F12 Rule 1: One shared secret list and process.env source audit", () => {
  it("uses the identical shared SECRET_ENV_VARS across redactor, event tap and LogStore", async () => {
    const { SECRET_ENV_VARS: EVENT_TAP_SECRET_ENV_VARS } = await import("../../lib/events/event-tap");
    const { SECRET_ENV_VARS: LOG_STORE_SECRET_ENV_VARS } = await import("../../lib/events/log-store");

    assert.deepEqual(SECRET_ENV_VARS, EVENT_TAP_SECRET_ENV_VARS);
    assert.deepEqual(SECRET_ENV_VARS, LOG_STORE_SECRET_ENV_VARS);
    assert.deepEqual(
      [...SECRET_ENV_VARS].sort(),
      [
        "ADMIN_KEY",
        "ADMIN_TOKEN",
        "ADMIN_SECRET",
        "GITHUB_WRITE_TOKEN",
        "GITHUB_TOKEN",
        "KIRO_KEY",
        "KIRO_API_KEY",
        "P12_SECRET",
        "INVITE_CODES",
      ].sort()
    );
  });

  it("splits INVITE_CODES on commas and treats each code as an individual secret", () => {
    const orig = process.env.INVITE_CODES;
    try {
      process.env.INVITE_CODES = "code-alpha, code-beta , code-gamma";
      const secrets = getEnvSecrets();
      assert.ok(secrets.includes("code-alpha"));
      assert.ok(secrets.includes("code-beta"));
      assert.ok(secrets.includes("code-gamma"));

      const redacted = redactText("testing code-beta inside output", { autoRegisterEnvSecrets: true });
      assert.equal(redacted, "testing [REDACTED] inside output");
    } finally {
      if (orig !== undefined) {
        process.env.INVITE_CODES = orig;
      } else {
        delete process.env.INVITE_CODES;
      }
    }
  });

  it("searches source for process.env reads ending in KEY, TOKEN, SECRET, PASSWORD or CODE and fails if missing from shared list", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    function findSourceProcessEnvReads(rootDir: string): string[] {
      const results = new Set<string>();
      const envPattern = /process\.env(?:\??\.([A-Za-z0-9_]+)|\[["']([A-Za-z0-9_]+)["']\])/g;

      function walk(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === ".next" ||
            entry.name === "test"
          ) {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, "utf-8");
            let match: RegExpExecArray | null;
            while ((match = envPattern.exec(content)) !== null) {
              const varName = match[1] || match[2];
              if (varName) {
                results.add(varName);
              }
            }
          }
        }
      }

      walk(rootDir);
      return Array.from(results);
    }

    const sourceEnvVars = findSourceProcessEnvReads(path.resolve(process.cwd()));
    const secretSuffixes = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CODE"];
    const secretReads = sourceEnvVars.filter((name) =>
      secretSuffixes.some((suffix) => name.endsWith(suffix))
    );

    assert.ok(secretReads.length > 0, "Expected at least one secret env var read in source");

    const missingFromSharedList: string[] = [];
    for (const name of secretReads) {
      if (!SECRET_ENV_VARS.includes(name)) {
        missingFromSharedList.push(name);
      }
    }

    assert.deepEqual(
      missingFromSharedList,
      [],
      `Found source process.env reads missing from SECRET_ENV_VARS: ${missingFromSharedList.join(", ")}`
    );

    // Verify that the test logic fails if an unlisted secret variable is tested
    const simulatedSourceReads = ["UNREGISTERED_API_KEY", "LEAKED_APP_SECRET"];
    const simulatedMissing = simulatedSourceReads.filter(
      (name) => !SECRET_ENV_VARS.includes(name)
    );
    assert.equal(simulatedMissing.length, 2);
  });
});

describe("F12 Rule 2: Token and key formats and boundary removal", () => {
  it("redacts gho_ GitHub OAuth tokens", () => {
    const input = "OAuth token is gho_1234567890abcdefghijklmnopqrstuvwxyz";
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.equal(res, "OAuth token is [REDACTED]");
  });

  it("redacts ghu_ GitHub user tokens", () => {
    const input = "User token: ghu_abcdef12345678901234";
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.equal(res, "User token: [REDACTED]");
  });

  it("redacts ghs_ GitHub server session tokens", () => {
    const input = "Server token: ghs_sessionToken12345678";
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.equal(res, "Server token: [REDACTED]");
  });

  it("redacts ghr_ GitHub refresh tokens", () => {
    const input = "Refresh token: ghr_refreshToken12345678";
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.equal(res, "Refresh token: [REDACTED]");
  });

  it("redacts github_pat_ fine-grained tokens", () => {
    const input = "PAT: github_pat_11ABCDEF_1234567890_extra";
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.equal(res, "PAT: [REDACTED]");
  });

  it("redacts sk- style keys (OpenAI / Anthropic style)", () => {
    const key1 = "sk-proj-abc1234567890abcdef";
    const key2 = "sk-ant-api03-abcdef123456789";
    const key3 = "sk-1234567890abcdef123456";
    const input = `Keys: ${key1}, ${key2}, ${key3}`;
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.ok(!res.includes(key1));
    assert.ok(!res.includes(key2));
    assert.ok(!res.includes(key3));
    assert.equal(res, "Keys: [REDACTED], [REDACTED], [REDACTED]");

    // Verify no false positive on normal words like task-runner
    assert.equal(redactText("task-runner", { autoRegisterEnvSecrets: false }), "task-runner");
    assert.equal(redactText("flask-app", { autoRegisterEnvSecrets: false }), "flask-app");
  });

  it("redacts AIza Google API keys", () => {
    // Real Google API keys carry exactly 35 characters after the AIza prefix
    const googleKey = "AIzaSyDUMMYKEY1234567890ABCDEFGHIJKLMNO";
    const input = `googleApiKey = "${googleKey}"`;
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.ok(!res.includes(googleKey));
    assert.equal(res, 'googleApiKey = "[REDACTED]"');
  });

  it("redacts xox Slack tokens", () => {
    const bot = "xoxb-1234567890-abcdef";
    const user = "xoxp-9876543210-fedcba";
    const app = "xoxa-1234567890-abcdef";
    const refresh = "xoxr-1234567890-abcdef";
    const input = `Slack: ${bot}, ${user}, ${app}, ${refresh}`;
    const res = redactText(input, { autoRegisterEnvSecrets: false });
    assert.ok(!res.includes(bot));
    assert.ok(!res.includes(user));
    assert.ok(!res.includes(app));
    assert.ok(!res.includes(refresh));
    assert.equal(res, "Slack: [REDACTED], [REDACTED], [REDACTED], [REDACTED]");
  });

  it("redacts Bearer tokens while preserving Bearer keyword", () => {
    // Real-shaped Bearer tokens (20+ token characters) are still redacted
    const input1 = "Authorization: Bearer mySecretToken1234567890";
    const res1 = redactText(input1, { autoRegisterEnvSecrets: false });
    assert.equal(res1, "Authorization: Bearer [REDACTED]");

    // The Bearer scheme is case-insensitive (RFC 7235): lowercase "bearer" with a real-shaped token is redacted
    const input2 = "authorization: bearer eyJhbGciOiJIUzI1NiJ9.test.sig";
    const res2 = redactText(input2, { autoRegisterEnvSecrets: false });
    assert.equal(res2, "authorization: bearer [REDACTED]");

    // Prose such as "bearer token" (fewer than 20 token characters after the scheme) is not redacted
    const input3 = "the bearer token is sent in the header";
    const res3 = redactText(input3, { autoRegisterEnvSecrets: false });
    assert.equal(res3, input3);
  });

  it("removes leading word boundary so _ghp_ and xghp_ match and are redacted", () => {
    const tokenA = "ghp_alpha123456789012345";
    const input1 = `prefix_${tokenA}`;
    const input2 = `x${tokenA}`;
    const res1 = redactText(input1, { autoRegisterEnvSecrets: false });
    const res2 = redactText(input2, { autoRegisterEnvSecrets: false });
    assert.ok(!res1.includes(tokenA));
    assert.ok(!res2.includes(tokenA));
    assert.equal(res1, "prefix_[REDACTED]");
    assert.equal(res2, "x[REDACTED]");

    const scan1 = scanTextForSecrets(input1, { autoRegisterEnvSecrets: false });
    const scan2 = scanTextForSecrets(input2, { autoRegisterEnvSecrets: false });
    assert.equal(scan1.hasSecrets, true);
    assert.equal(scan2.hasSecrets, true);
  });
});

describe("F12 Rule 3: Paths, /root, ~, and runner registered secrets", () => {
  it("matches Windows home directories with spaces up to next separator or end of token", () => {
    const pathA = "C:\\Users\\John Doe\\AppData\\Local\\Temp";
    const pathB = '"C:\\Users\\Jane Doe"';
    const pathC = "C:\\Users\\Jane Doe\\file.txt";
    const pathD = "/Users/Alice Smith/Desktop";

    const resA = redactText(`Path: ${pathA}`, { autoRegisterEnvSecrets: false });
    const resB = redactText(`Profile: ${pathB}`, { autoRegisterEnvSecrets: false });
    const resC = redactText(`Log: ${pathC}`, { autoRegisterEnvSecrets: false });
    const resD = redactText(`Mac home: ${pathD}`, { autoRegisterEnvSecrets: false });

    assert.ok(!resA.includes("John Doe"));
    assert.ok(!resB.includes("Jane Doe"));
    assert.ok(!resC.includes("Jane Doe"));
    assert.ok(!resD.includes("Alice Smith"));
    assert.equal(resA, "Path: [REDACTED]");
    assert.equal(resB, 'Profile: "[REDACTED]"');
    assert.equal(resC, "Log: [REDACTED]");
    assert.equal(resD, "Mac home: [REDACTED]");
  });

  it("matches /root and subpaths", () => {
    const input1 = "/root";
    const input2 = "/root/.ssh/id_rsa";
    const input3 = "Saved to /root/scripts/build.sh";

    const res1 = redactText(input1, { autoRegisterEnvSecrets: false });
    const res2 = redactText(input2, { autoRegisterEnvSecrets: false });
    const res3 = redactText(input3, { autoRegisterEnvSecrets: false });

    assert.equal(res1, "[REDACTED]");
    assert.equal(res2, "[REDACTED]");
    assert.equal(res3, "Saved to [REDACTED]");
  });

  it("matches ~ forms of home directory (~, ~/, ~root, ~user/subpath)", () => {
    const resTilde = redactText("cd ~", { autoRegisterEnvSecrets: false });
    const resSlash = redactText("Config in ~/.bashrc", { autoRegisterEnvSecrets: false });
    const resUser = redactText("Check ~root/.ssh", { autoRegisterEnvSecrets: false });
    const resSub = redactText("Path: ~user/projects", { autoRegisterEnvSecrets: false });

    assert.equal(resTilde, "cd [REDACTED]");
    assert.equal(resSlash, "Config in [REDACTED]");
    assert.equal(resUser, "Check [REDACTED]");
    assert.equal(resSub, "Path: [REDACTED]");

    // Verify ~1.2.3 version range is not falsely matched
    assert.equal(redactText("version ~1.2.3", { autoRegisterEnvSecrets: false }), "version ~1.2.3");
  });

  it("preserves ~ in ~A~ and ~~ and maintains tilde redaction idempotency", () => {
    // Regression cases from T36 gate fix
    assert.equal(redactText("~A~ ", { autoRegisterEnvSecrets: false }), "~A~ ");
    assert.equal(
      redactText(redactText("~A~ ", { autoRegisterEnvSecrets: false }), { autoRegisterEnvSecrets: false }),
      "~A~ "
    );

    assert.equal(redactText("~~", { autoRegisterEnvSecrets: false }), "~~");
    assert.equal(
      redactText(redactText("~~", { autoRegisterEnvSecrets: false }), { autoRegisterEnvSecrets: false }),
      "~~"
    );

    // Discrete test cases for idempotency
    const cases = [
      "~A~ ",
      "~~",
      "~A~",
      "~~~",
      "~~strike~~",
      "cd ~",
      "Config in ~/.bashrc",
      "Check ~root/.ssh",
      "Path: ~user/projects",
      "version ~1.2.3",
      "~user",
      "~user/subpath/to/file",
      "prefix ~user suffix",
      "path/to/~file",
    ];

    for (const text of cases) {
      const once = redactText(text, { autoRegisterEnvSecrets: false });
      const twice = redactText(once, { autoRegisterEnvSecrets: false });
      assert.equal(twice, once, `redactText must be idempotent for case: ${JSON.stringify(text)}`);
    }

    // Property-based idempotency via fast-check
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 200 }),
          fc.array(
            fc.constantFrom("~", "A", "/", " ", "root", "user", "_", "-", ".", "[", "]", "R", "E", "D", "A", "C", "T"),
            { minLength: 1, maxLength: 80 }
          ).map((arr) => arr.join(""))
        ),
        (s) => {
          const once = redactText(s, { autoRegisterEnvSecrets: false });
          const twice = redactText(once, { autoRegisterEnvSecrets: false });
          assert.equal(twice, once, `redactText must be idempotent for generated string: ${JSON.stringify(s)}`);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("redacts host names and non-loopback IPv6 addresses registered as secrets by runner", async () => {
    const { LogStore: DynamicLogStore } = await import("../../lib/events/log-store");
    const hostName = "runner-instance-node-42.internal";
    const nonLoopbackIpv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";

    // 1. In pure redactText via options.secrets
    const text = `Connecting to ${hostName} on [${nonLoopbackIpv6}]:8080`;
    const res = redactText(text, {
      secrets: [hostName, nonLoopbackIpv6],
      autoRegisterEnvSecrets: false,
    });
    assert.ok(!res.includes(hostName));
    assert.ok(!res.includes(nonLoopbackIpv6));
    assert.equal(res, "Connecting to [REDACTED] on [[REDACTED]]:8080");

    // 2. On Redactor instance via registerSecret
    const redactor = new Redactor({ autoRegisterEnvSecrets: false });
    redactor.registerSecret(hostName);
    redactor.registerSecret(nonLoopbackIpv6);
    const redactorRes = redactor.redactText(text);
    assert.ok(!redactorRes.includes(hostName));
    assert.ok(!redactorRes.includes(nonLoopbackIpv6));

    // 3. On LogStore instance via registerSecret
    const logStore = new DynamicLogStore({ inMemory: true });
    logStore.registerSecret(hostName);
    logStore.registerSecret(nonLoopbackIpv6);
    const stored = logStore.storeCommandOutput({
      stdout: `Host: ${hostName}`,
      stderr: `Address: ${nonLoopbackIpv6}`,
    });
    assert.ok(!stored.stdoutTail.includes(hostName));
    assert.ok(!stored.stderrTail.includes(nonLoopbackIpv6));
  });
});

describe("F12 Rule 4: Multi-line and encoded values scanning", () => {
  it("scans whole text directly and detects multi-line PEM blocks", () => {
    const multiLinePem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Yxyz1234567890abcdef...",
      "moreBase64PayloadLine2...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const scan = scanTextForSecrets(multiLinePem, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, false);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.shouldQuarantine, true);
    assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));
  });

  it("scans whole text directly and detects multi-line exact secrets", () => {
    const multiLineSecret = "SECRET_START\nline2_secret_payload\nSECRET_END";
    const input = `Header\n${multiLineSecret}\nFooter`;

    const scan = scanTextForSecrets(input, {
      secrets: [multiLineSecret],
      autoRegisterEnvSecrets: false,
    });
    assert.equal(scan.passed, false);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.shouldQuarantine, true);
    assert.equal(scan.violations[0].match, multiLineSecret);
  });

  it("scans one level of percent-decoding", () => {
    // Percent-encoded "ghp_1234567890abcdef1234"
    const encoded = "%67%68%70%5f%31%32%33%34%35%36%37%38%39%30%61%62%63%64%65%66%31%32%33%34";
    const text = `const token = "${encoded}";`;

    const scan = scanTextForSecrets(text, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, false);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.shouldQuarantine, true);
  });

  it("scans one level of base64 decoding (both whole text and embedded tokens)", () => {
    // 1. Whole text base64
    const rawSecret = "ghp_fullBase64SecretToken12345";
    const b64Whole = Buffer.from(rawSecret).toString("base64");
    const scanWhole = scanTextForSecrets(b64Whole, { autoRegisterEnvSecrets: false });
    assert.equal(scanWhole.passed, false);
    assert.equal(scanWhole.hasSecrets, true);
    assert.equal(scanWhole.shouldQuarantine, true);

    // 2. Embedded base64 token
    const rawEmbedded = "ghp_embeddedB64Token12345";
    const b64Token = Buffer.from(rawEmbedded).toString("base64");
    const text = `const authHeader = "Basic ${b64Token}";`;
    const scanEmbedded = scanTextForSecrets(text, { autoRegisterEnvSecrets: false });
    assert.equal(scanEmbedded.passed, false);
    assert.equal(scanEmbedded.hasSecrets, true);
    assert.equal(scanEmbedded.shouldQuarantine, true);
  });

  it("scans one level of backslash-u escape decoding", () => {
    // \u0067\u0068\u0070\u005f -> ghp_
    const text = 'const key = "\\u0067\\u0068\\u0070\\u005f12345678901234567890";';
    const scan = scanTextForSecrets(text, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, false);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.shouldQuarantine, true);
  });
});

describe("F12 Rule 5: LogStore floor and injected redactor", () => {
  it("enforces that built-in redactor always runs first even with a no-op injected redactor", async () => {
    const { LogStore: DynamicLogStore } = await import("../../lib/events/log-store");
    const noOpRedactor = (text: string) => text;
    const logStore = new DynamicLogStore({
      inMemory: true,
      redactor: noOpRedactor,
    });

    const token = "ghp_testCanaryTokenForLogStoreFloor12345";
    const stored = logStore.storeCommandOutput({
      stdout: `Compiling with ${token}`,
      stderr: "No errors",
    });

    assert.ok(!stored.stdoutTail.includes(token));
    assert.ok(stored.stdoutTail.includes("[REDACTED]"));
  });

  it("allows injected redactor to add rules on top of built-in redactor", async () => {
    const { LogStore: DynamicLogStore } = await import("../../lib/events/log-store");
    const customSecret = "INTERNAL_SERVER_CODENAME_XYZ";
    const customMask = "***MASKED_BY_CUSTOM***";
    const customRedactor = (text: string) =>
      text.replace(new RegExp(customSecret, "g"), customMask);

    const logStore = new DynamicLogStore({
      inMemory: true,
      redactor: customRedactor,
    });

    const builtInToken = "ghp_builtInToken1234567890";
    const raw = `BuiltIn: ${builtInToken}, Custom: ${customSecret}`;
    const stored = logStore.storeCommandOutput({
      stdout: raw,
    });

    // Both built-in and injected rules are applied
    assert.ok(!stored.stdoutTail.includes(builtInToken));
    assert.ok(!stored.stdoutTail.includes(customSecret));
    assert.ok(stored.stdoutTail.includes("[REDACTED]"));
    assert.ok(stored.stdoutTail.includes(customMask));
  });

  it("prevents injected redactor from restoring built-in secrets", async () => {
    const { LogStore: DynamicLogStore } = await import("../../lib/events/log-store");
    // Malicious or broken redactor attempting to restore a secret
    const token = "ghp_secretTokenThatMustStayRedacted";
    const undoRedactor = (text: string) => text.replace(/\[REDACTED\]/g, token);

    const logStore = new DynamicLogStore({
      inMemory: true,
      redactor: undoRedactor,
    });

    const stored = logStore.storeCommandOutput({
      stdout: `Token: ${token}`,
    });

    // Floor preservation ensures builtIn runs again and token is still redacted
    assert.ok(!stored.stdoutTail.includes(token));
  });

  it("redacts runner registered secrets through LogStore.registerSecret", async () => {
    const { LogStore: DynamicLogStore } = await import("../../lib/events/log-store");
    const logStore = new DynamicLogStore({ inMemory: true });
    const dynamicSecret = "custom-dynamic-runner-secret-999";
    logStore.registerSecret(dynamicSecret);

    const stored = logStore.storeCommandOutput({
      stdout: `Execution output: ${dynamicSecret}`,
    });

    assert.ok(!stored.stdoutTail.includes(dynamicSecret));
    assert.ok(stored.stdoutTail.includes("[REDACTED]"));
  });
});

describe("G04 Round 2: Redaction and scanning fixes", () => {
  it("Rule 1: redactEventData returns redacted refs and raw refs are never copied back over", () => {
    const secretRefToken = ["ghp", "token_inside_evidence_ref_987654321"].join("_");
    const exactSecret = ["custom", "evidence", "secret", "abc"].join("_");
    const data = {
      command: "npm test",
      status: "completed",
      refs: [
        `01_evidence/log-${secretRefToken}.txt`,
        `01_evidence/cert-${exactSecret}.json`,
        "01_evidence/normal.txt",
      ],
    };

    const redacted = redactEventData(data, {
      secrets: [exactSecret],
      autoRegisterEnvSecrets: false,
    });

    assert.ok(Array.isArray(redacted.refs));
    assert.equal(redacted.refs.length, 3);
    assert.ok(!redacted.refs[0].includes(secretRefToken));
    assert.ok(redacted.refs[0].includes("[REDACTED]"));
    assert.ok(!redacted.refs[1].includes(exactSecret));
    assert.ok(redacted.refs[1].includes("[REDACTED]"));
    assert.equal(redacted.refs[2], "01_evidence/normal.txt");

    // Verify original input was not mutated
    assert.ok(String(data.refs[0]).includes(secretRefToken));
  });

  it("Rule 2: worktree scan and candidate submission scan for secrets only and do not flag host details", () => {
    const loopback = ["127", "0", "0", "1"].join(".");
    const homeDir = ["", "home", "developer"].join("/");
    const cleanRepoFiles = [
      {
        path: "src/server.ts",
        content: `export const host = "${loopback}";\nexport const userPath = "${homeDir}";\n`,
      },
    ];

    // Worktree scan passes cleanly despite loopback IP and home dir in repository files
    const worktreeResult = scanWorktreeFiles(cleanRepoFiles, { autoRegisterEnvSecrets: false });
    assert.equal(worktreeResult.passed, true);
    assert.equal(worktreeResult.hasSecrets, false);
    assert.equal(worktreeResult.shouldQuarantine, false);
    assert.equal(worktreeResult.violations.length, 0);

    // Candidate diff scan passes cleanly with host details
    const cleanDiff = [
      "diff --git a/src/server.ts b/src/server.ts",
      "--- a/src/server.ts",
      "+++ b/src/server.ts",
      "@@ -1,2 +1,3 @@",
      `+const defaultHost = "${loopback}";`,
      `+const home = "${homeDir}";`,
    ].join("\n");

    const diffResult = scanCandidateDiff(cleanDiff, { autoRegisterEnvSecrets: false });
    assert.equal(diffResult.passed, true);
    assert.equal(diffResult.hasSecrets, false);
    assert.equal(diffResult.shouldQuarantine, false);
    assert.equal(diffResult.violations.length, 0);

    // Secrets (tokens and PEM blocks) are still detected and flagged
    const secretToken = ["ghp", "candidate_diff_secret_token_456"].join("_");
    const dirtyFiles = [
      {
        path: "src/keys.ts",
        content: `const pat = "${secretToken}";`,
      },
    ];
    const dirtyScan = scanWorktreeFiles(dirtyFiles, { autoRegisterEnvSecrets: false });
    assert.equal(dirtyScan.passed, false);
    assert.equal(dirtyScan.hasSecrets, true);
    assert.equal(dirtyScan.shouldQuarantine, true);

    // Host details remain in HOST_DETAIL_PATTERNS and are redacted in outputs and events
    const outputLog = `Service bound to ${loopback} in ${homeDir}`;
    const redactedOutput = redactText(outputLog, { autoRegisterEnvSecrets: false });
    assert.ok(!redactedOutput.includes(loopback));
    assert.ok(!redactedOutput.includes(homeDir));
    assert.ok(redactedOutput.includes("[REDACTED]"));
  });

  it("Rule 3: symlink scanner reads link type and target with fs.lstat and fs.readlink only, never calling statSync or realpathSync", async () => {
    const { scanForEscapingSymlinks } = await import("../../lib/security/symlink-scanner");
    const fsMod = await import("node:fs");
    const osMod = await import("node:os");
    const pathMod = await import("node:path");

    // 1. Audit scanner source: verify statSync and realpathSync are never called
    const scannerSourcePath = pathMod.resolve(process.cwd(), "lib/security/symlink-scanner.ts");
    const scannerSource = fsMod.readFileSync(scannerSourcePath, "utf8");
    assert.equal(
      /fs\.(?:statSync|realpathSync)\b/.test(scannerSource),
      false,
      "lib/security/symlink-scanner.ts must never call fs.statSync or fs.realpathSync"
    );

    // 2. Behavioral verification: scanning dangling outside symlink works without reading target
    const tempRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "g04-scanner-test-"));
    const worktree = pathMod.join(tempRoot, "worktree");
    fsMod.mkdirSync(worktree, { recursive: true });

    const safeFile = pathMod.join(worktree, "safe.txt");
    fsMod.writeFileSync(safeFile, "safe content", "utf8");

    // Inside symlink: path.resolve is inside root
    const safeLink = pathMod.join(worktree, "safe_link.txt");
    fsMod.symlinkSync("safe.txt", safeLink);

    // Escaping relative symlink: path.resolve is outside root
    const escapeLink = pathMod.join(worktree, "escape_link.txt");
    fsMod.symlinkSync(pathMod.join("..", "outside.txt"), escapeLink);

    // Dangling escaping symlink: target does not exist, but path.resolve is outside root
    const danglingLink = pathMod.join(worktree, "dangling_outside.txt");
    fsMod.symlinkSync(pathMod.join("..", "does_not_exist_anywhere.txt"), danglingLink);

    try {
      const findings = scanForEscapingSymlinks(worktree);
      assert.equal(findings.hasEscapingSymlinks, true);
      // Safe inside link is not flagged
      assert.ok(!findings.some((f) => f.relativePath === "safe_link.txt"));
      // Escaping links are flagged based on path.resolve without needing target to exist
      assert.ok(findings.some((f) => f.relativePath === "escape_link.txt"));
      assert.ok(findings.some((f) => f.relativePath === "dangling_outside.txt"));
      const danglingFinding = findings.find((f) => f.relativePath === "dangling_outside.txt");
      assert.equal(danglingFinding?.type, "escaping_symlink");
    } finally {
      try {
        fsMod.rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it("Rule 4: EventTap and LogStore read registered secret env values on every redaction call, not once at construction", async () => {
    const { EventTap: TapClass } = await import("../../lib/events/event-tap");
    const { LogStore: StoreClass } = await import("../../lib/events/log-store");

    const dynamicAdminSecret = ["dyn", "live", "admin", "key", "9012"].join("_");
    const dynamicInviteSecret = ["dyn", "live", "invite", "code", "3456"].join("_");

    // Clean initial env
    delete process.env.ADMIN_KEY;
    delete process.env.INVITE_CODES;

    // Instantiate before secrets exist in process.env
    const tap = new TapClass();
    const store = new StoreClass({ inMemory: true });

    // Set environment values dynamically after construction
    process.env.ADMIN_KEY = dynamicAdminSecret;
    process.env.INVITE_CODES = dynamicInviteSecret;

    try {
      // EventTap redaction picks up live env secrets on call
      const textToRedact = `Admin: ${dynamicAdminSecret}, invite: ${dynamicInviteSecret}`;
      const tapResult = tap.redactText(textToRedact);
      assert.ok(!tapResult.includes(dynamicAdminSecret));
      assert.ok(!tapResult.includes(dynamicInviteSecret));
      assert.ok(tapResult.includes("[REDACTED]"));

      // EventTap append redacts live secrets
      const appended = tap.append({
        kind: "test.event",
        runId: "run-dyn-1",
        seq: 1,
        ts: Date.now(),
        actor: "test-actor",
        data: {
          token: dynamicAdminSecret,
          refs: [`01_evidence/${dynamicInviteSecret}.txt`],
        },
      });
      assert.ok(!JSON.stringify(appended.data).includes(dynamicAdminSecret));
      assert.ok(!JSON.stringify(appended.data).includes(dynamicInviteSecret));

      // LogStore redaction picks up live env secrets on call
      const logResult = store.storeCommandOutput({
        stdout: `Execution output with ${dynamicAdminSecret}`,
        stderr: `Warning code ${dynamicInviteSecret}`,
      });
      assert.ok(!logResult.stdoutTail.includes(dynamicAdminSecret));
      assert.ok(!logResult.stderrTail.includes(dynamicInviteSecret));
      assert.ok(logResult.stdoutTail.includes("[REDACTED]"));
    } finally {
      delete process.env.ADMIN_KEY;
      delete process.env.INVITE_CODES;
    }
  });
});
