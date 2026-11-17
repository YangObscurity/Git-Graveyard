// Task 13.4 / 13.5: Unit and property tests for Warden review and verdict record
// Requirements: 14.7, 24.5, 24.6, 24.7, 24.8, 24.14, 24.15, 24.16, 25.6, 25.8

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import {
  computeCandidateSha256,
  isValidEvidenceRef,
  extractEvidenceRefs,
  normalizeReason,
  checkNoTestWeakening,
  buildVerdictRecord,
  buildWardenVerdict,
  createWardenVerdict,
  validateWardenVerdict,
  checkWardenIsolation,
  WARDEN_ALLOWED_TOOLS,
  FORBIDDEN_WARDEN_TOOLS,
} from "../../lib/warden/warden-review";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type {
  BuilderEnvironment,
  TestCountBaseline,
  WardenEnvironment,
  WardenVerdictRecord,
} from "../../lib/warden/types";

describe("test/warden: Candidate SHA-256 determinism (Requirements 24.5, 25.6)", () => {
  it("computes deterministic SHA-256 digest matching crypto sha256", () => {
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const expected = crypto.createHash("sha256").update(diff).digest("hex").toLowerCase();

    assert.equal(computeCandidateSha256(diff), expected);
    assert.equal(computeCandidateSha256(""), "");
    assert.equal(computeCandidateSha256(null as unknown as string), "");

    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(computeCandidateSha256(commitSha), "");
    assert.equal(computeCandidateSha256("  " + commitSha + " \n"), "");
  });

  it("produces identical SHA-256 for identical inputs", () => {
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const h1 = computeCandidateSha256(diff);
    const h2 = computeCandidateSha256(diff);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });
});

describe("test/warden: Evidence reference extraction and validation (Requirements 24.7, 24.16)", () => {
  it("validates evidence refs with supported prefixes: cmd, file, gh, ev", () => {
    assert.equal(isValidEvidenceRef("cmd:npm-test-1"), true);
    assert.equal(isValidEvidenceRef("file:lib/scheduler.ts:42"), true);
    assert.equal(isValidEvidenceRef("gh:issue/101"), true);
    assert.equal(isValidEvidenceRef("ev:m2-signal"), true);

    // Invalid formats
    assert.equal(isValidEvidenceRef("plain-text-without-prefix"), false);
    assert.equal(isValidEvidenceRef(""), false);
    assert.equal(isValidEvidenceRef("cmd:"), false);
  });

  it("extracts multiple evidence references from raw reason strings", () => {
    const text = "Failure in file:src/app.ts:25 during cmd:build-prod and gh:issue/42 with ev:signal-1";
    const refs = extractEvidenceRefs(text);
    assert.deepEqual(refs, [
      "file:src/app.ts:25",
      "cmd:build-prod",
      "gh:issue/42",
      "ev:signal-1",
    ]);
  });

  it("normalizes string reasons and object reasons into structured ReasonWithRefs", () => {
    const r1 = normalizeReason("Syntax error in file:lib/index.ts:10");
    assert.equal(r1.text, "Syntax error in file:lib/index.ts:10");
    assert.deepEqual(r1.refs, ["file:lib/index.ts:10"]);

    const r2 = normalizeReason({
      text: "Build failed",
      ref: "cmd:build",
    });
    assert.equal(r2.text, "Build failed");
    assert.deepEqual(r2.refs, ["cmd:build"]);

    const r3 = normalizeReason({
      message: "Test failure",
      refs: ["cmd:test", "file:test/a.ts"],
    });
    assert.equal(r3.text, "Test failure");
    assert.deepEqual(r3.refs, ["cmd:test", "file:test/a.ts"]);
  });
});

describe("test/warden: No test weakening check (Requirement 24.6)", () => {
  it("passes when test counts are maintained and all test files remain intact", () => {
    const before: TestCountBaseline = {
      total: 10,
      passed: 10,
      testFiles: ["test/a.test.ts", "test/b.test.ts"],
    };
    const after: TestCountBaseline = {
      total: 12,
      passed: 12,
      testFiles: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    };

    const result = checkNoTestWeakening(before, after);
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it("fails when test files are removed (Requirement 24.6)", () => {
    const before: TestCountBaseline = {
      total: 10,
      passed: 10,
      testFiles: ["test/a.test.ts", "test/b.test.ts"],
    };
    const after: TestCountBaseline = {
      total: 10,
      passed: 10,
      testFiles: ["test/a.test.ts"],
    };

    const result = checkNoTestWeakening(before, after);
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("test file(s) removed"));
    assert.equal(result.ref, "file:test/b.test.ts");
    assert.deepEqual(result.deletedFiles, ["test/b.test.ts"]);
  });

  it("fails when total test count decreases (Requirement 24.6)", () => {
    const before: TestCountBaseline = {
      total: 20,
      passed: 20,
      testFiles: ["test/all.test.ts"],
    };
    const after: TestCountBaseline = {
      total: 18,
      passed: 18,
      testFiles: ["test/all.test.ts"],
    };

    const result = checkNoTestWeakening(before, after);
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("total tests decreased from 20 to 18"));
    assert.equal(result.ref, "cmd:test-weakening");
  });

  it("fails when passed test count decreases (Requirement 24.6)", () => {
    const before: TestCountBaseline = {
      total: 20,
      passed: 20,
    };
    const after: TestCountBaseline = {
      total: 20,
      passed: 17,
    };

    const result = checkNoTestWeakening(before, after);
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("passed tests decreased from 20 to 17"));
    assert.equal(result.ref, "cmd:test-weakening");
  });
});

describe("test/warden: Warden verdict record generation (Requirements 24.5, 24.7, 24.8, 24.16, 25.6)", () => {
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const candidateDiff = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const expectedSha256 = candidateSha256FromDiff(candidateDiff);

  it("builds approve verdict record when all checks pass", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      verdict: "approve",
      diff: candidateDiff,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    assert.equal(verdict.verdict, "approve");
    assert.equal(verdict.status, "approve");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.approved, true);
    assert.equal(verdict.target, "task-01");
    assert.equal(verdict.candidateSha, commitSha);
    assert.equal(verdict.candidateSha256, expectedSha256);
    assert.equal(verdict.noTestWeakening, true);
    assert.equal(verdict.requiresRerun, false);
    assert.ok(verdict.reasons.length > 0);
    assert.ok(verdict.reasons[0].refs.length > 0);
  });

  it("aliases buildWardenVerdict and createWardenVerdict produce equivalent record", () => {
    const v1 = buildVerdictRecord(commitSha, { verdict: "approve", target: "task-01", diff: candidateDiff, install: { ok: true }, build: { ok: true }, tests: { ok: true } });
    const v2 = buildWardenVerdict(commitSha, { verdict: "approve", target: "task-01", diff: candidateDiff, install: { ok: true }, build: { ok: true }, tests: { ok: true } });
    const v3 = createWardenVerdict(commitSha, { verdict: "approve", target: "task-01", diff: candidateDiff, install: { ok: true }, build: { ok: true }, tests: { ok: true } });

    assert.equal(v1.verdict, v2.verdict);
    assert.equal(v2.verdict, v3.verdict);
    assert.equal(v1.candidateSha256, v2.candidateSha256);
    assert.equal(v2.candidateSha256, v3.candidateSha256);
  });

  it("builds reject verdict record on auditbox install failure", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      install: { ok: false, exitCode: 1, logRef: "install-err" },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.approved, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("Installation failed")));
    assert.ok(verdict.refs.includes("cmd:install-err"));
  });

  it("builds reject verdict record on build failure", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      build: { ok: false, exitCode: 2 },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("Build failed")));
    assert.ok(verdict.refs.includes("cmd:build"));
  });

  it("builds reject verdict record on accept command failure", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      accept: { ok: false, exitCode: 1 },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("acceptance command failed")));
    assert.ok(verdict.refs.includes("cmd:accept"));
  });

  it("builds reject verdict record on repository tests failure", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      tests: { ok: false, exitCode: 1 },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("Repository tests failed")));
    assert.ok(verdict.refs.includes("cmd:tests"));
  });

  it("builds reject verdict record when test weakening is detected", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      testBaselineBefore: { total: 10, passed: 10, testFiles: ["a.ts", "b.ts"] },
      testBaselineAfter: { total: 9, passed: 9, testFiles: ["a.ts"] },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.noTestWeakening, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("Test weakening detected")));
  });

  it("requires rerun when reject verdict reasons lack all evidence refs (Requirements 24.7, 24.16)", () => {
    const verdictNoRef = buildVerdictRecord(commitSha, {
      target: "task-01",
      verdict: "reject",
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      reasons: ["Something failed without any reference pointer"],
    });

    assert.equal(verdictNoRef.verdict, "reject");
    assert.equal(verdictNoRef.atLeastOneReasonHasRef, false);
    assert.equal(verdictNoRef.requiresRerun, true);

    const verdictWithRef = buildVerdictRecord(commitSha, {
      target: "task-01",
      verdict: "reject",
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      reasons: ["Build failed with error in file:src/index.ts:12"],
    });

    assert.equal(verdictWithRef.verdict, "reject");
    assert.equal(verdictWithRef.atLeastOneReasonHasRef, true);
    assert.equal(verdictWithRef.requiresRerun, false);
  });

  it("rejects candidate when check object lacks boolean ok (Requirement 24.5)", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      verdict: "approve",
      install: { ok: true },
      build: { exitCode: 0 } as any,
      tests: { ok: true },
    });
    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("Missing build check")));
  });

  it("an explicit approve cannot override a failed check (Requirement 24.5)", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      verdict: "approve",
      install: { ok: true },
      build: { ok: false },
      tests: { ok: true },
    });
    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
  });

  it("a check that is omitted is a rejection (Requirement 24.5)", () => {
    const verdict = buildVerdictRecord(commitSha, {
      target: "task-01",
      verdict: "approve",
      install: { ok: true },
      tests: { ok: true },
    });
    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("Missing build check")));
  });

  it("empty findings is a rejection (Requirement 24.5)", () => {
    const verdict = buildVerdictRecord(commitSha, {});
    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.text.includes("Empty findings")));
  });
});

describe("test/warden: Warden isolation checks (Requirements 14.7, 24.14, 24.15)", () => {
  const validWardenEnv: WardenEnvironment = {
    role: "warden",
    sessionId: "warden-session-01",
    processId: 1001,
    kiroHome: "/tmp/warden-home",
    checkoutDir: "/tmp/warden/checkout",
    boxId: "auditbox-01",
    boxType: "auditbox",
    tools: ["read", "sandbox_exec", "sandbox_log", "warden_verdict"],
  };

  const validBuilderEnv: BuilderEnvironment = {
    role: "soul-stitcher",
    sessionId: "builder-session-01",
    processId: 2002,
    kiroHome: "/tmp/builder-home",
    checkoutDir: "/tmp/builder/checkout",
    worktreeDir: "/tmp/builder/worktree",
    boxId: "runbox-01",
    boxType: "runbox",
    tools: ["read", "write", "sandbox_exec", "sandbox_log", "report_task_result"],
  };

  it("confirms isolation when Warden and Builder environments are completely disjoint", () => {
    const result = checkWardenIsolation(validWardenEnv, validBuilderEnv);
    assert.equal(result.isolated, true);
    assert.deepEqual(result.violations, []);
  });

  it("detects violation if Warden shares sessionId, processId, KIRO_HOME, or boxId with Builder", () => {
    const sharingSession: WardenEnvironment = {
      ...validWardenEnv,
      sessionId: validBuilderEnv.sessionId,
    };
    const r1 = checkWardenIsolation(sharingSession, validBuilderEnv);
    assert.equal(r1.isolated, false);
    assert.ok(r1.violations.some((v) => v.toLowerCase().includes("shares sessionid")));

    const sharingBox: WardenEnvironment = {
      ...validWardenEnv,
      boxId: validBuilderEnv.boxId,
    };
    const r2 = checkWardenIsolation(sharingBox, validBuilderEnv);
    assert.equal(r2.isolated, false);
    assert.ok(r2.violations.some((v) => v.toLowerCase().includes("shares container box id")));
  });

  it("detects violation if Warden is granted forbidden write tools", () => {
    const forbiddenTools = ["write", "shell", "web", "propose_task"];
    for (const tool of forbiddenTools) {
      const toolViolatingWarden: WardenEnvironment = {
        ...validWardenEnv,
        tools: ["read", "sandbox_exec", tool],
      };
      const result = checkWardenIsolation(toolViolatingWarden, validBuilderEnv);
      assert.equal(result.isolated, false);
      assert.ok(result.violations.some((v) => v.includes(tool)));
    }
  });

  it("verifies committed WARDEN_ALLOWED_TOOLS and FORBIDDEN_WARDEN_TOOLS sets", () => {
    assert.equal(WARDEN_ALLOWED_TOOLS.has("read"), true);
    assert.equal(WARDEN_ALLOWED_TOOLS.has("sandbox_exec"), true);
    assert.equal(WARDEN_ALLOWED_TOOLS.has("sandbox_log"), true);
    assert.equal(WARDEN_ALLOWED_TOOLS.has("warden_verdict"), true);
    assert.equal(WARDEN_ALLOWED_TOOLS.has("write"), false);

    assert.equal(FORBIDDEN_WARDEN_TOOLS.has("write"), true);
    assert.equal(FORBIDDEN_WARDEN_TOOLS.has("shell"), true);
    assert.equal(FORBIDDEN_WARDEN_TOOLS.has("web"), true);
    assert.equal(FORBIDDEN_WARDEN_TOOLS.has("subagent"), true);
  });
});

describe("test/warden: Fast-check property tests for Warden verdict", () => {
  it("always computes valid 64-char lowercase hex digest for arbitrary non-empty candidate diffs", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^diff --git a\/[a-z0-9_.-]+ b\/[a-z0-9_.-]+\n@@ -1 \+1 @@\n[-+][a-z0-9 ]+$/),
        (diff) => {
          const digest = computeCandidateSha256(diff);
          assert.equal(digest.length, 64);
          assert.match(digest, /^[0-9a-f]{64}$/);
          assert.equal(digest, digest.toLowerCase());
        }
      ),
      { numRuns: 50 }
    );
  });

  it("returns empty string for 40-character commit sha strings", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-fA-F]{40}$/),
        (sha) => {
          const digest = computeCandidateSha256(sha);
          assert.equal(digest, "");
        }
      ),
      { numRuns: 50 }
    );
  });

  it("satisfies rerun requirement logic: requiresRerun is true if and only if verdict is reject and no reason has a ref", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        (isApprove, hasRef) => {
          const sha = "0123456789abcdef0123456789abcdef01234567";
          const reasonText = isApprove
            ? "Passed verification in file:src/index.ts:1"
            : hasRef
            ? "Failed build in file:src/index.ts:1"
            : "Generic failure without pointer";

          const verdict = buildVerdictRecord(sha, {
            verdict: isApprove ? "approve" : "reject",
            reasons: [reasonText],
            install: { ok: true },
            build: { ok: true },
            accept: { ok: true },
            tests: { ok: true },
          });

          if (isApprove) {
            assert.equal(verdict.requiresRerun, false);
          } else {
            assert.equal(verdict.requiresRerun, !hasRef);
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it("Property 13: Warden isolation (Requirements 14.7, 21.7, 21.8, 24.14, 24.15)", () => {
    fc.assert(
      fc.property(
        fc.record({
          sessionId: fc.stringMatching(/^[a-z0-9-]{8,16}$/),
          processId: fc.integer({ min: 100, max: 9999 }),
          kiroHome: fc.constant("/tmp/warden/kiro-home"),
          checkoutDir: fc.constant("/tmp/warden/checkout"),
          boxId: fc.stringMatching(/^[a-z0-9-]{8,16}$/),
        }),
        fc.record({
          sessionId: fc.stringMatching(/^[a-z0-9-]{8,16}$/),
          processId: fc.integer({ min: 10000, max: 19999 }),
          kiroHome: fc.constant("/tmp/builder/kiro-home"),
          checkoutDir: fc.constant("/tmp/builder/checkout"),
          boxId: fc.stringMatching(/^[a-z0-9-]{8,16}$/),
        }),
        fc.constantFrom(
          "none",
          "share-session",
          "share-pid",
          "share-home",
          "share-checkout",
          "share-box",
          "forbidden-write",
          "forbidden-shell",
          "bad-checkout-dir",
          "bad-box-type"
        ),
        (wBase, bBase, violationMode) => {
          const builderSession = `builder-${bBase.sessionId}`;
          const builderBox = `runbox-${bBase.boxId}`;

          const wardenEnv: WardenEnvironment = {
            role: "warden",
            sessionId:
              violationMode === "share-session" ? builderSession : `warden-${wBase.sessionId}`,
            processId:
              violationMode === "share-pid" ? bBase.processId : wBase.processId,
            kiroHome:
              violationMode === "share-home" ? bBase.kiroHome : wBase.kiroHome,
            checkoutDir:
              violationMode === "bad-checkout-dir"
                ? "/tmp/builder/checkout"
                : violationMode === "share-checkout"
                ? bBase.checkoutDir
                : wBase.checkoutDir,
            boxId:
              violationMode === "share-box" ? builderBox : `auditbox-${wBase.boxId}`,
            boxType: violationMode === "bad-box-type" ? "runbox" : "auditbox",
            tools:
              violationMode === "forbidden-write"
                ? ["read", "sandbox_exec", "sandbox_log", "warden_verdict", "write"]
                : violationMode === "forbidden-shell"
                ? ["read", "sandbox_exec", "sandbox_log", "warden_verdict", "shell"]
                : ["read", "sandbox_exec", "sandbox_log", "warden_verdict"],
          };

          const builderEnv: BuilderEnvironment = {
            role: "soul-stitcher",
            sessionId: builderSession,
            processId: bBase.processId,
            kiroHome: bBase.kiroHome,
            checkoutDir: bBase.checkoutDir,
            boxId: builderBox,
            boxType: "runbox",
            tools: ["read", "write", "sandbox_exec", "sandbox_log", "report_task_result"],
          };

          const isolation = checkWardenIsolation(wardenEnv, builderEnv);

          if (violationMode === "none") {
            assert.equal(
              isolation.isolated,
              true,
              `Disjoint environments should pass isolation, got violations: ${isolation.violations.join("; ")}`
            );
            assert.equal(isolation.violations.length, 0);
          } else {
            assert.equal(
              isolation.isolated,
              false,
              `Violation mode '${violationMode}' must cause isolation to fail`
            );
            assert.ok(isolation.violations.length >= 1);
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  it("Property: checkNoTestWeakening detects any file deletion or count drop (Requirement 24.6)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 50 }),
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        (baselineTotal, totalDiff, removeFile) => {
          const filesBefore = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
          const filesAfter = removeFile ? ["test/a.test.ts", "test/b.test.ts"] : [...filesBefore];

          const before: TestCountBaseline = {
            total: baselineTotal,
            passed: baselineTotal,
            testFiles: filesBefore,
          };

          const afterTotal = baselineTotal - totalDiff;
          const after: TestCountBaseline = {
            total: afterTotal,
            passed: afterTotal,
            testFiles: filesAfter,
          };

          const res = checkNoTestWeakening(before, after);

          if (totalDiff > 0 || removeFile) {
            assert.equal(res.ok, false, "Must detect weakening on count drop or file removal");
            assert.ok(res.reason?.includes("weakening"));
          } else {
            assert.equal(res.ok, true);
          }
        }
      ),
      { numRuns: 40 }
    );
  });
});
