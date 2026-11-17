// Unit and Property tests for lib/security/kiro-key-containment.ts
// Property 11: Kiro key containment (P11)
// Validates: Requirements 21.5, 42.6, 42.7, 42.8

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  type BoxContainmentTarget,
  type BoxFileEntry,
  type BoxArtifactEntry,
  type KiroKeyContainmentOptions,
  type KeyContainmentViolation,
  extractSecretTokens,
  scanTextForKeyLeaks,
  verifyBoxEnvironmentContainment,
  verifyBoxFilesContainment,
  verifyStoredEventsContainment,
  verifyCommandLogsContainment,
  verifyArtifactsContainment,
  verifyHostKeyPlacement,
  verifyBoxContainment,
  verifyBoxesContainment,
  verifyKiroKeyContainment,
  simulateBoxCreation,
  createProperty11Report,
  assertKiroKeyContainment,
  KeyContainmentError,
} from "../../lib/security/kiro-key-containment";

import {
  createCanaryToken,
  createDefaultCanaryTokens,
  KSK_CANARY_PREFIX,
  GHP_CANARY_PREFIX,
  AKIA_CANARY_PREFIX,
  GITHUB_PAT_CANARY_PREFIX,
  DCKR_PAT_CANARY_PREFIX,
  PEM_CANARY_HEADER,
} from "../../lib/security/canary";

describe("kiro-key-containment: token extraction and leak scanning", () => {
  it("extracts and deduplicates Kiro keys, canary tokens, and extra secrets", () => {
    const canarySet = createDefaultCanaryTokens("TEST_EXTRACTION");
    const options: KiroKeyContainmentOptions = {
      kiroApiKey: "ksk_mock_key_live_01",
      devKey: "ksk_mock_key_dev_01",
      prodKey: "ksk_mock_key_prod_01",
      canaryTokens: canarySet,
      extraSecrets: ["custom_secret_token_123", "ksk_mock_key_dev_01"],
    };

    const tokens = extractSecretTokens(options);
    assert.equal(tokens.kiroKeys.length, 3);
    assert.ok(tokens.kiroKeys.includes("ksk_mock_key_live_01"));
    assert.ok(tokens.kiroKeys.includes("ksk_mock_key_dev_01"));
    assert.ok(tokens.kiroKeys.includes("ksk_mock_key_prod_01"));

    assert.ok(tokens.canaryKeys.length >= 6);
    assert.ok(tokens.allSecrets.includes("custom_secret_token_123"));
    // Deduplication check: devKey appears only once in allSecrets
    const occurrences = tokens.allSecrets.filter((s) => s === "ksk_mock_key_dev_01");
    assert.equal(occurrences.length, 1);
  });

  it("handles empty or undefined options safely", () => {
    const empty1 = extractSecretTokens(undefined);
    assert.deepEqual(empty1, { kiroKeys: [], canaryKeys: [], allSecrets: [] });

    const empty2 = extractSecretTokens({});
    assert.deepEqual(empty2, { kiroKeys: [], canaryKeys: [], allSecrets: [] });
  });

  it("scans text and returns structured violation records with masked snippets", () => {
    const kiroKey = "ksk_mock_live_secret_4455";
    const text = `Error: Authentication failed with token ${kiroKey} on request`;

    const violations = scanTextForKeyLeaks(text, { kiroApiKey: kiroKey }, {
      scope: "command_logs",
      target: "stderr",
      backend: "instabox-docker",
      requirement: "42.8",
    });

    assert.equal(violations.length, 1);
    assert.equal(violations[0].scope, "command_logs");
    assert.equal(violations[0].target, "stderr");
    assert.equal(violations[0].secretKind, "kiro_api_key");
    assert.equal(violations[0].backend, "instabox-docker");
    assert.equal(violations[0].requirement, "42.8");
    assert.ok(violations[0].snippet.includes("[MASKED]"));
    assert.ok(!violations[0].snippet.includes("4455"));
  });
});

describe("kiro-key-containment: Box environment validation (Requirements 21.5, 42.8)", () => {
  const kiroKey = "ksk_mock_active_key_9988";
  const canarySet = createDefaultCanaryTokens("BOX_ENV_TEST");

  it("passes clean environment containing no secrets or secret variable names", () => {
    const cleanEnv = {
      NODE_ENV: "test",
      PORT: "3000",
      BUILD_ID: "run-42",
      PATH: "/usr/bin:/bin",
    };

    const result = verifyBoxEnvironmentContainment(cleanEnv, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, true);
    assert.equal(result.contained, true);
    assert.equal(result.violations.length, 0);
  });

  it("flags forbidden secret environment variable names even if empty (Requirement 21.5)", () => {
    const badEnv = {
      KIRO_API_KEY: "",
      NODE_ENV: "production",
    };

    const result = verifyBoxEnvironmentContainment(badEnv, { kiroApiKey: kiroKey });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.target.includes("KIRO_API_KEY")));
  });

  it("flags Kiro key value leak inside any environment variable value (Requirements 21.5, 42.8)", () => {
    const leakingEnv = {
      CONFIG_JSON: JSON.stringify({ key: kiroKey }),
      SAFE_VAR: "true",
    };

    const result = verifyBoxEnvironmentContainment(leakingEnv, { kiroApiKey: kiroKey });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.secretKind === "kiro_api_key"));
  });

  it("flags canary tokens placed into Box environment (Requirements 42.6, 42.8)", () => {
    const leakingEnv = {
      DEBUG_TOKEN: canarySet.ksk,
    };

    const result = verifyBoxEnvironmentContainment(leakingEnv, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.secretKind === "canary_key"));
  });
});

describe("kiro-key-containment: Box files validation (Requirements 21.5, 42.8)", () => {
  const kiroKey = "ksk_mock_file_key_5566";
  const canarySet = createDefaultCanaryTokens("FILES_TEST");

  it("passes clean files without secrets", () => {
    const files: BoxFileEntry[] = [
      { path: "src/index.ts", content: "export const answer = 42;\n" },
      { path: "package.json", content: JSON.stringify({ name: "safe-pkg" }) },
    ];

    const result = verifyBoxFilesContainment(files, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("flags Kiro API key present in string file content (Requirements 21.5, 42.8)", () => {
    const files: BoxFileEntry[] = [
      { path: "config.json", content: `{ "token": "${kiroKey}" }` },
    ];

    const result = verifyBoxFilesContainment(files, { kiroApiKey: kiroKey });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.target === "file:config.json"));
  });

  it("flags Kiro API key present in Buffer file content (Requirements 21.5, 42.8)", () => {
    const files: BoxFileEntry[] = [
      {
        path: "credentials.bin",
        content: Buffer.from(`KIRO_KEY=${kiroKey}\n`, "utf-8"),
      },
    ];

    const result = verifyBoxFilesContainment(files, { kiroApiKey: kiroKey });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.target === "file:credentials.bin"));
  });

  it("flags canary tokens present in file content (Requirements 42.6, 42.8)", () => {
    const files: BoxFileEntry[] = [
      { path: "canary.env", content: `CANARY_LINE=${canarySet.ghp}` },
    ];

    const result = verifyBoxFilesContainment(files, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.secretKind === "canary_key"));
  });
});

describe("kiro-key-containment: Stored events validation (Requirements 42.8, 42.6)", () => {
  const kiroKey = "ksk_mock_evt_key_7788";
  const canarySet = createDefaultCanaryTokens("EVENTS_TEST");

  it("passes clean event sequence", () => {
    const events = [
      { type: "run.started", runId: "r-01", ts: 100 },
      { type: "pact.approved", pactVersion: 1, budget: 100 },
      { type: "task.completed", taskId: "T1" },
    ];

    const result = verifyStoredEventsContainment(events, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("flags Kiro API key leaked inside event data payload (Requirement 42.8)", () => {
    const events = [
      {
        type: "tool.result",
        data: {
          output: `Command executed with auth: ${kiroKey}`,
        },
      },
    ];

    const result = verifyStoredEventsContainment(events, { kiroApiKey: kiroKey });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.scope === "stored_events"));
  });

  it("flags canary tokens leaked inside event payload (Requirements 42.6, 42.8)", () => {
    const events = [
      {
        type: "command.executed",
        data: {
          stdout: `Exported canary: ${canarySet.akia}`,
        },
      },
    ];

    const result = verifyStoredEventsContainment(events, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.secretKind === "canary_key"));
  });
});

describe("kiro-key-containment: Command logs validation (Requirement 42.8)", () => {
  const kiroKey = "ksk_mock_log_key_1122";
  const canarySet = createDefaultCanaryTokens("LOGS_TEST");

  it("passes clean command logs", () => {
    const logs = [
      "npm test -- --coverage",
      "Tests passed: 42/42",
      "Process exited with code 0",
    ];

    const result = verifyCommandLogsContainment(logs, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("flags Kiro key in stdout or stderr strings (Requirement 42.8)", () => {
    const logs = `fatal: could not read from remote. key used: ${kiroKey}`;

    const result = verifyCommandLogsContainment(logs, { kiroApiKey: kiroKey });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.scope === "command_logs"));
  });

  it("flags canary tokens in command log objects (Requirement 42.8)", () => {
    const logObj = {
      cmd: ["run", "build"],
      stdout: `Output contains ${canarySet.githubPat}`,
      stderr: "",
    };

    const result = verifyCommandLogsContainment([logObj], {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.secretKind === "canary_key"));
  });
});

describe("kiro-key-containment: Artifacts validation (Requirements 42.8, 42.6)", () => {
  const kiroKey = "ksk_mock_art_key_3344";
  const canarySet = createDefaultCanaryTokens("ARTIFACTS_TEST");

  it("passes clean artifacts", () => {
    const artifacts: BoxArtifactEntry[] = [
      { name: "coverage.lcov", content: "TN:\nSF:src/index.ts\nend_of_record\n" },
      { name: "patch.diff", content: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n+fixed\n" },
    ];

    const result = verifyArtifactsContainment(artifacts, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("flags Kiro API key present in artifact content (Requirement 42.8)", () => {
    const artifacts: BoxArtifactEntry[] = [
      { name: "run-summary.json", content: JSON.stringify({ token: kiroKey }) },
    ];

    const result = verifyArtifactsContainment(artifacts, { kiroApiKey: kiroKey });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.target === "artifact:run-summary.json"));
  });

  it("flags canary tokens present in artifact Buffer content (Requirements 42.6, 42.8)", () => {
    const artifacts: BoxArtifactEntry[] = [
      {
        name: "bundle.tar",
        content: Buffer.from(`CANARY_ENTRY=${canarySet.dckrPat}\n`, "utf-8"),
      },
    ];

    const result = verifyArtifactsContainment(artifacts, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.secretKind === "canary_key"));
  });
});

describe("kiro-key-containment: Host key placement validation (Requirement 42.7)", () => {
  it("passes development necro-owned secret file with mode 0o600 and key in child env", () => {
    const result = verifyHostKeyPlacement(
      {
        storageType: "file",
        filePath: "/data/runs/secrets/kiro_key.txt",
        fileOwner: "necro",
        fileMode: 0o600,
      },
      "development",
      { keyInChildEnv: true }
    );

    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("passes production host secret store with key in child env", () => {
    const result = verifyHostKeyPlacement(
      {
        storageType: "host_secret_store",
      },
      "production",
      { keyInChildEnv: true }
    );

    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("rejects non-file or world-readable storage in development (Requirement 42.7)", () => {
    const result = verifyHostKeyPlacement(
      {
        storageType: "file",
        filePath: "/tmp/leaked_key.txt",
        fileOwner: "root",
        fileMode: 0o666,
      },
      "development"
    );

    assert.equal(result.passed, false);
    assert.ok(result.violations.length >= 2);
  });

  it("rejects when key is missing from kiro-cli child process environment (Requirement 42.7)", () => {
    const result = verifyHostKeyPlacement(
      {
        storageType: "host_secret_store",
      },
      "production",
      { keyInChildEnv: false }
    );

    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.scope === "child_env"));
  });
});

describe("kiro-key-containment: Box simulation and Property 11 reporting across backends", () => {
  const kiroKey = "ksk_mock_simulation_key_9999";
  const canarySet = createDefaultCanaryTokens("SIM_TEST");

  it("simulates box creation cleanly for instabox-docker backend", () => {
    const box = simulateBoxCreation("instabox-docker", { idempotencyKey: "box-instabox-1" }, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
      commandStdout: "Instabox execution stdout",
      emittedEvents: [{ type: "test.passed" }],
    });

    assert.equal(box.backend, "instabox-docker");
    const check = verifyBoxContainment(box, { kiroApiKey: kiroKey, canaryTokens: canarySet });
    assert.equal(check.passed, true);
  });

  it("simulates box creation cleanly for docker-cloud-sandbox backend", () => {
    const box = simulateBoxCreation("docker-cloud-sandbox", { idempotencyKey: "box-cloud-1" }, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
      commandStdout: "Cloud sandbox stdout",
      emittedEvents: [{ type: "build.complete" }],
    });

    assert.equal(box.backend, "docker-cloud-sandbox");
    const check = verifyBoxContainment(box, { kiroApiKey: kiroKey, canaryTokens: canarySet });
    assert.equal(check.passed, true);
  });

  it("generates a complete Property 11 report for multi-box execution across both backends", () => {
    const box1 = simulateBoxCreation("instabox-docker", { idempotencyKey: "box-1" }, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });
    const box2 = simulateBoxCreation("docker-cloud-sandbox", { idempotencyKey: "box-2" }, {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    const report = createProperty11Report([box1, box2], {
      kiroApiKey: kiroKey,
      canaryTokens: canarySet,
    });

    assert.equal(report.passed, true);
    assert.equal(report.property, "P11");
    assert.equal(report.totalBoxesChecked, 2);
    assert.ok(report.backendsChecked.includes("instabox-docker"));
    assert.ok(report.backendsChecked.includes("docker-cloud-sandbox"));
    assert.ok(report.summary.includes("Property 11 verified"));
  });

  it("assertKiroKeyContainment throws KeyContainmentError on violation", () => {
    const leakyBox: BoxContainmentTarget = {
      id: "leaky-01",
      backend: "instabox-docker",
      env: { LEAK: kiroKey },
    };

    assert.throws(
      () => assertKiroKeyContainment(leakyBox, { kiroApiKey: kiroKey }),
      (err: unknown) => {
        assert.ok(err instanceof KeyContainmentError);
        assert.ok(err.violations.length > 0);
        return true;
      }
    );
  });
});

describe("Property Checks: Property 11 Kiro key containment (P11) across arbitrary boxes", () => {
  const safeIdentifierArb = fc
    .stringMatching(/^[a-zA-Z0-9_-]{3,20}$/)
    .filter((s) => s.trim().length > 0);

  const safeContentArb = fc
    .stringMatching(/^[a-zA-Z0-9 \n\t.,;:_+=/*-]{5,80}$/)
    .filter((s) => !s.includes("ksk_") && !s.includes("ghp_") && !s.includes("AKIA"));

  const backendArb = fc.constantFrom(
    "instabox-docker" as const,
    "docker-cloud-sandbox" as const
  );

  const keySuffixArb = fc
    .stringMatching(/^[A-Za-z0-9]{8,16}$/)
    .map((s) => `ksk_mock_test_key_${s}`);

  it("Property 11.A: Sanitized boxes from either backend contain zero Kiro API keys across all scopes", () => {
    fc.assert(
      fc.property(
        backendArb,
        safeIdentifierArb,
        keySuffixArb,
        safeContentArb,
        safeContentArb,
        (backend, boxId, kiroKey, stdoutContent, fileContent) => {
          const canarySet = createDefaultCanaryTokens(`FC_${boxId}`);

          // Simulate box created by backend
          const box = simulateBoxCreation(
            backend,
            { idempotencyKey: boxId },
            {
              kiroApiKey: kiroKey,
              canaryTokens: canarySet,
              commandStdout: stdoutContent,
              files: [{ path: "src/main.ts", content: fileContent }],
              emittedEvents: [{ type: "test.run", payload: { out: stdoutContent } }],
              collectedArtifacts: [{ name: "summary.txt", content: fileContent }],
            }
          );

          const result = verifyBoxContainment(box, {
            kiroApiKey: kiroKey,
            canaryTokens: canarySet,
          });

          // Property 11 invariant: zero leaks
          assert.equal(result.passed, true);
          assert.equal(result.violations.length, 0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 11.B: Any unredacted Kiro key injected into ANY scope is deterministically detected", () => {
    const scopeTargetArb = fc.constantFrom(
      "env" as const,
      "files" as const,
      "commandLogs" as const,
      "events" as const,
      "artifacts" as const
    );

    fc.assert(
      fc.property(
        backendArb,
        safeIdentifierArb,
        keySuffixArb,
        scopeTargetArb,
        (backend, boxId, kiroKey, injectScope) => {
          const canarySet = createDefaultCanaryTokens(`INJ_${boxId}`);

          const box: BoxContainmentTarget = {
            id: boxId,
            backend,
            env: injectScope === "env" ? { LEAKED_KEY: kiroKey } : { NODE_ENV: "test" },
            files:
              injectScope === "files"
                ? [{ path: "secret.txt", content: kiroKey }]
                : [{ path: "readme.txt", content: "Safe readme" }],
            commandLogs:
              injectScope === "commandLogs"
                ? `Process failed: ${kiroKey}`
                : "Safe process log",
            events:
              injectScope === "events"
                ? [{ type: "leak", leakedToken: kiroKey }]
                : [{ type: "safe" }],
            artifacts:
              injectScope === "artifacts"
                ? [{ name: "leaked.diff", content: kiroKey }]
                : [{ name: "safe.diff", content: "Safe diff" }],
          };

          const result = verifyBoxContainment(box, {
            kiroApiKey: kiroKey,
            canaryTokens: canarySet,
          });

          // Property 11 invariant: MUST fail when key is present
          assert.equal(result.passed, false);
          assert.ok(result.violations.length >= 1);
          assert.ok(
            result.violations.some((v) => v.secretKind === "kiro_api_key")
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 11.C: Any canary token injected into ANY scope is deterministically detected", () => {
    const canaryKindArb = fc.constantFrom(
      "ksk" as const,
      "ghp" as const,
      "akia" as const,
      "github_pat" as const,
      "dckr_pat" as const
    );

    fc.assert(
      fc.property(
        backendArb,
        safeIdentifierArb,
        canaryKindArb,
        (backend, boxId, kind) => {
          const canaryToken = createCanaryToken(kind, `CANARY_${boxId}`);
          const kiroKey = `ksk_mock_kiro_key_${boxId}`;

          const box: BoxContainmentTarget = {
            id: boxId,
            backend,
            files: [{ path: "test.canary", content: `canary data: ${canaryToken}` }],
          };

          const result = verifyBoxContainment(box, {
            kiroApiKey: kiroKey,
            canaryTokens: [canaryToken],
          });

          assert.equal(result.passed, false);
          assert.ok(
            result.violations.some(
              (v) => v.secretKind === "canary_key" || v.secretKind === "sensitive_pattern"
            )
          );
        }
      ),
      { numRuns: 50 }
    );
  });
});
