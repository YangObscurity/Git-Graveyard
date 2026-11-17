// Unit and property tests for Warden review
// Requirements: 14.7, 24.5, 24.6, 24.7, 24.8, 24.14, 24.15, 24.16, 25.6, 25.8

import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fc from "fast-check";

import {
  computeCandidateSha256,
  isValidEvidenceRef,
  extractEvidenceRefs,
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
  WardenEnvironment,
  BuilderEnvironment,
  TestCountBaseline,
} from "../../lib/warden/types";

const sampleDiff = "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n";
const sampleTree = "tree-warden-01";
const sampleCandidateSha = "0123456789abcdef0123456789abcdef01234567";

test("Warden review: computeCandidateSha256 must not hash commit sha string and hashes diff text", () => {
  const commitSha = "0123456789abcdef0123456789abcdef01234567";

  // Must not hash commit SHA string
  assert.equal(computeCandidateSha256(commitSha), "");
  assert.equal(computeCandidateSha256(""), "");

  // Produces deterministic SHA-256 for diff text
  const expectedDiffHash = candidateSha256FromDiff(sampleDiff);
  assert.equal(computeCandidateSha256(sampleDiff), expectedDiffHash);
  assert.equal(expectedDiffHash.length, 64);
});

test("Warden review: evidence ref detection and extraction", () => {
  assert.equal(isValidEvidenceRef("cmd:install-step-1"), true);
  assert.equal(isValidEvidenceRef("file:lib/foo.ts:42"), true);
  assert.equal(isValidEvidenceRef("gh:issue/102"), true);
  assert.equal(isValidEvidenceRef("ev:signal-m2"), true);
  assert.equal(isValidEvidenceRef("invalid-ref-without-prefix"), false);
  assert.equal(isValidEvidenceRef(""), false);

  const text = "Error in file:src/index.ts:12 and run log cmd:build-log-99 check gh:pr/55";
  const refs = extractEvidenceRefs(text);
  assert.deepEqual(refs, ["file:src/index.ts:12", "cmd:build-log-99", "gh:pr/55"]);
});

test("Warden review: no_test_weakening check (Requirement 24.6)", () => {
  const beforeBaseline: TestCountBaseline = {
    total: 10,
    passed: 10,
    testFiles: ["test/a.test.ts", "test/b.test.ts"],
  };

  // 1. Equal counts and files pass
  const passingAfter: TestCountBaseline = {
    total: 10,
    passed: 10,
    testFiles: ["test/a.test.ts", "test/b.test.ts"],
  };
  assert.equal(checkNoTestWeakening(beforeBaseline, passingAfter).ok, true);

  // 2. Increased counts and new files pass
  const improvedAfter: TestCountBaseline = {
    total: 12,
    passed: 12,
    testFiles: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
  };
  assert.equal(checkNoTestWeakening(beforeBaseline, improvedAfter).ok, true);

  // 3. Decreased total count fails
  const decreasedTotal: TestCountBaseline = {
    total: 9,
    passed: 9,
    testFiles: ["test/a.test.ts", "test/b.test.ts"],
  };
  const decTotalRes = checkNoTestWeakening(beforeBaseline, decreasedTotal);
  assert.equal(decTotalRes.ok, false);
  assert.ok(decTotalRes.reason?.includes("total tests decreased"));

  // 4. Decreased passed count fails
  const decreasedPassed: TestCountBaseline = {
    total: 10,
    passed: 8,
    testFiles: ["test/a.test.ts", "test/b.test.ts"],
  };
  const decPassedRes = checkNoTestWeakening(beforeBaseline, decreasedPassed);
  assert.equal(decPassedRes.ok, false);
  assert.ok(decPassedRes.reason?.includes("passed tests decreased"));

  // 5. Removed test file fails
  const missingFileAfter: TestCountBaseline = {
    total: 10,
    passed: 10,
    testFiles: ["test/a.test.ts"],
  };
  const missingFileRes = checkNoTestWeakening(beforeBaseline, missingFileAfter);
  assert.equal(missingFileRes.ok, false);
  assert.ok(missingFileRes.reason?.includes("test file(s) removed"));
  assert.equal(missingFileRes.ref, "file:test/b.test.ts");
});

test("Warden review: buildVerdictRecord generates approve verdict when all checks pass", () => {
  const candidateSha = sampleCandidateSha;
  const expectedSha256 = candidateSha256FromDiff(sampleDiff);

  const verdict = buildVerdictRecord(candidateSha, {
    target: "task-01",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true, exitCode: 0, logRef: "install-01" },
    build: { ok: true, exitCode: 0, logRef: "build-01" },
    accept: { ok: true, exitCode: 0, logRef: "accept-01" },
    tests: { ok: true, exitCode: 0, logRef: "tests-01" },
    noTestWeakening: true,
  });

  assert.equal(verdict.verdict, "approve");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.approved, true);
  assert.equal(verdict.candidateSha, candidateSha);
  assert.equal(verdict.candidateSha256, expectedSha256);
  assert.equal(verdict.target, "task-01");
  assert.equal(verdict.tree, sampleTree);
  assert.equal(verdict.requiresRerun, false);
  assert.ok(verdict.reasons.length > 0);
  assert.ok(verdict.reasons[0].refs.length > 0);

  // Aliases produce equivalent record
  assert.equal(buildWardenVerdict(candidateSha, { diff: sampleDiff, install: { ok: true }, build: { ok: true }, accept: { ok: true, exitCode: 0, logRef: "accept-01" }, tests: { ok: true }, noTestWeakening: true }).verdict, "approve");
  assert.equal(createWardenVerdict(candidateSha, { diff: sampleDiff, install: { ok: true }, build: { ok: true }, accept: { ok: true, exitCode: 0, logRef: "accept-01" }, tests: { ok: true }, noTestWeakening: true }).verdict, "approve");
});

test("Warden review: buildVerdictRecord generates reject verdict when checks fail", () => {
  const candidateSha = sampleCandidateSha;
  const expectedSha256 = candidateSha256FromDiff(sampleDiff);

  // Install failed
  const failInstall = buildVerdictRecord(candidateSha, {
    target: "task-02",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: false, exitCode: 1, logRef: "install-err-01" },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
  });
  assert.equal(failInstall.verdict, "reject");
  assert.equal(failInstall.ok, false);
  assert.equal(failInstall.approved, false);
  assert.equal(failInstall.candidateSha256, expectedSha256);
  assert.ok(failInstall.reasons.some((r) => r.text.includes("Installation failed")));
  assert.ok(failInstall.reasons.some((r) => r.refs.includes("cmd:install-err-01")));
  assert.equal(failInstall.atLeastOneReasonHasRef, true);
  assert.equal(failInstall.requiresRerun, false);

  // Test weakening detected
  const failWeakening = buildVerdictRecord(candidateSha, {
    target: "task-03",
    diff: sampleDiff,
    tree: sampleTree,
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
    testBaselineBefore: { total: 50, passed: 50, testFiles: ["test/all.test.ts"] },
    testBaselineAfter: { total: 40, passed: 40, testFiles: ["test/all.test.ts"] },
  });
  assert.equal(failWeakening.verdict, "reject");
  assert.equal(failWeakening.noTestWeakening, false);
  assert.ok(failWeakening.reasons.some((r) => r.text.includes("Test weakening detected")));
  assert.ok(failWeakening.refs.includes("cmd:test-weakening"));
});

test("Rule (5) Warden fails closed: empty findings mean reject", () => {
  const candidateSha = sampleCandidateSha;

  // Empty findings passed
  const verdict = buildVerdictRecord(candidateSha, {});

  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.approved, false);
  assert.ok(verdict.reasons.some((r) => r.text.includes("Empty findings") || r.text.includes("Missing")));
});

test("Rule (5) Warden fails closed: missing install check means reject", () => {
  const verdict = buildVerdictRecord(sampleCandidateSha, {
    diff: sampleDiff,
    // install is missing
    build: { ok: true },
    tests: { ok: true },
  });

  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.text.includes("Missing install check")));
});

test("Rule (5) Warden fails closed: missing build check means reject", () => {
  const verdict = buildVerdictRecord(sampleCandidateSha, {
    diff: sampleDiff,
    install: { ok: true },
    // build is missing
    tests: { ok: true },
  });

  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.text.includes("Missing build check")));
});

test("Rule (5) Warden fails closed: missing tests check means reject", () => {
  const verdict = buildVerdictRecord(sampleCandidateSha, {
    diff: sampleDiff,
    install: { ok: true },
    build: { ok: true },
    // tests is missing
  });

  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.text.includes("Missing tests check")));
});

test("Rule (5) Warden fails closed: explicit approve cannot override a failed check", () => {
  const verdict = buildVerdictRecord(sampleCandidateSha, {
    verdict: "approve", // Explicit approve
    diff: sampleDiff,
    install: { ok: true },
    build: { ok: false, exitCode: 1, logRef: "bld-fail" }, // Failed check
    tests: { ok: true },
  });

  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.approved, false);
});

test("Rule (5) Warden fails closed: missing checks never default to ok true", () => {
  const verdict = buildVerdictRecord(sampleCandidateSha, {
    diff: sampleDiff,
  });

  assert.equal(verdict.checks?.install && (verdict.checks.install as Record<string, unknown>).ok, false);
  assert.equal(verdict.checks?.build && (verdict.checks.build as Record<string, unknown>).ok, false);
  assert.equal(verdict.checks?.tests && (verdict.checks.tests as Record<string, unknown>).ok, false);
});

test("Warden review: reject reasons without refs flag requiresRerun (Requirement 24.7, 24.16)", () => {
  const candidateSha = sampleCandidateSha;

  // Rejection with NO evidence refs across all reasons
  const noRefsVerdict = buildVerdictRecord(candidateSha, {
    verdict: "reject",
    target: "task-04",
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
    reasons: ["Something went wrong without evidence"],
    refs: [],
  });

  assert.equal(noRefsVerdict.verdict, "reject");
  assert.equal(noRefsVerdict.atLeastOneReasonHasRef, false);
  assert.equal(noRefsVerdict.requiresRerun, true);

  const valRes = validateWardenVerdict(noRefsVerdict);
  assert.equal(valRes.requiresRerun, true);
  assert.equal(valRes.allLackRefs, true);
  assert.ok(valRes.reasons.some((r) => r.includes("requires rerun with evidence")));

  // Rejection with evidence ref passes validation
  const withRefVerdict = buildVerdictRecord(candidateSha, {
    verdict: "reject",
    target: "task-04",
    install: { ok: true },
    build: { ok: true },
    accept: { ok: true },
    tests: { ok: true },
    reasons: [{ text: "Assertion failure in tests", refs: ["cmd:test-log-42"] }],
  });

  assert.equal(withRefVerdict.verdict, "reject");
  assert.equal(withRefVerdict.atLeastOneReasonHasRef, true);
  assert.equal(withRefVerdict.requiresRerun, false);

  const valRes2 = validateWardenVerdict(withRefVerdict);
  assert.equal(valRes2.requiresRerun, false);
  assert.equal(valRes2.allLackRefs, false);
});

test("Warden isolation: checkWardenIsolation validates strict environment isolation (Requirements 14.7, 24.14, 24.15)", () => {
  const validWarden: WardenEnvironment = {
    role: "warden",
    sessionId: "sess-warden-01",
    processId: 1001,
    kiroHome: "/var/run/graveyard/warden/kiro",
    checkoutDir: "/var/run/graveyard/warden/checkout",
    boxId: "box-audit-01",
    boxType: "auditbox",
    tools: ["read", "sandbox_exec", "sandbox_log", "warden_verdict"],
    writableHostPaths: ["/var/run/graveyard/warden/data"],
  };

  const validBuilder: BuilderEnvironment = {
    role: "soul-stitcher",
    sessionId: "sess-builder-01",
    processId: 1002,
    kiroHome: "/var/run/graveyard/builders/task-1/kiro",
    checkoutDir: "/var/run/graveyard/builders/task-1/worktree",
    boxId: "box-run-01",
    boxType: "runbox",
    tools: ["read", "write", "sandbox_exec", "sandbox_log", "report_task_result"],
    writableHostPaths: ["/var/run/graveyard/builders/task-1/data"],
  };

  // Completely disjoint passes
  const checkPass = checkWardenIsolation(validWarden, [validBuilder]);
  assert.equal(checkPass.isolated, true);
  assert.deepEqual(checkPass.violations, []);

  // Violation 1: Warden has write tool (Requirement 14.7)
  const forbiddenToolWarden: WardenEnvironment = {
    ...validWarden,
    tools: ["read", "write", "sandbox_exec", "sandbox_log", "warden_verdict"],
  };
  const toolCheck = checkWardenIsolation(forbiddenToolWarden, [validBuilder]);
  assert.equal(toolCheck.isolated, false);
  assert.ok(toolCheck.violations.some((v) => v.includes("zero write tools permitted")));

  // Violation 2: Warden shares checkout directory (Requirement 24.14)
  const sharedCheckoutWarden: WardenEnvironment = {
    ...validWarden,
    checkoutDir: validBuilder.checkoutDir,
  };
  const checkoutCheck = checkWardenIsolation(sharedCheckoutWarden, [validBuilder]);
  assert.equal(checkoutCheck.isolated, false);
  assert.ok(checkoutCheck.violations.some((v) => v.includes("shares checkout directory")));

  // Violation 3: Warden shares writable host path (Requirement 24.15)
  const sharedPathWarden: WardenEnvironment = {
    ...validWarden,
    writableHostPaths: ["/shared/workspace/data"],
  };
  const sharedPathBuilder: BuilderEnvironment = {
    ...validBuilder,
    writableHostPaths: ["/shared/workspace/data"],
  };
  const pathCheck = checkWardenIsolation(sharedPathWarden, [sharedPathBuilder]);
  assert.equal(pathCheck.isolated, false);
  assert.ok(pathCheck.violations.some((v) => v.includes("is reachable by builder")));
});

test("Property test: buildVerdictRecord candidateSha256 and verdict invariants", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[0-9a-f]{40}$/),
      fc.stringMatching(/^[a-z0-9_-]{4,20}$/),
      fc.boolean(),
      (candidateSha: string, diffWord: string, passChecks: boolean) => {
        const diffText = `--- a/${diffWord}\n+++ b/${diffWord}\n+${diffWord}\n`;
        const expectedSha256 = candidateSha256FromDiff(diffText);

        const verdict = buildVerdictRecord(candidateSha, {
          diff: diffText,
          tree: sampleTree,
          install: { ok: passChecks, logRef: "inst" },
          build: { ok: passChecks, logRef: "bld" },
          accept: { ok: passChecks, logRef: "acc" },
          tests: { ok: passChecks, logRef: "tst" },
          noTestWeakening: passChecks,
        });

        assert.equal(verdict.candidateSha, candidateSha);
        assert.equal(verdict.candidateSha256, expectedSha256);
        assert.equal(verdict.verdict, passChecks ? "approve" : "reject");
        assert.equal(verdict.ok, passChecks);
        assert.equal(verdict.approved, passChecks);
        assert.ok(Array.isArray(verdict.reasons));
        assert.ok(Array.isArray(verdict.refs));
      }
    ),
    { numRuns: 100 }
  );
});
