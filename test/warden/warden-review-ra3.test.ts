// Second-round A-audit finding N-A15:
// Strict Warden check object validation and mandatory evidence refs on approve.

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  isCheckPassing,
  isValidEvidenceRef,
  buildVerdictRecord,
  validateWardenVerdict,
  EVIDENCE_REF_PATTERNS,
} from "../../lib/warden/warden-review";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

describe("N-A15: Strict check object validation in isCheckPassing and buildVerdictRecord", () => {
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const diffText = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

  it("isCheckPassing rejects bare boolean true and false", () => {
    assert.equal(isCheckPassing(true), false);
    assert.equal(isCheckPassing(false), false);
    assert.equal(isCheckPassing(null), false);
    assert.equal(isCheckPassing(undefined), false);
    assert.equal(isCheckPassing("true"), false);
    assert.equal(isCheckPassing(1), false);
    assert.equal(isCheckPassing([true]), false);
  });

  it("isCheckPassing accepts only valid non-array plain objects with ok === true and no failure markers", () => {
    assert.equal(isCheckPassing({ ok: true }), true);
    assert.equal(isCheckPassing({ ok: true, exitCode: 0 }), true);
    assert.equal(isCheckPassing({ ok: true, passed: true }), true);
    assert.equal(isCheckPassing({ ok: true, status: "passed" }), true);

    // Failures
    assert.equal(isCheckPassing({ ok: false }), false);
    assert.equal(isCheckPassing({ ok: true, passed: false }), false);
    assert.equal(isCheckPassing({ ok: true, exitCode: 1 }), false);
    assert.equal(isCheckPassing({ ok: true, status: "failed" }), false);
    assert.equal(isCheckPassing({ ok: true, status: "error" }), false);
    assert.equal(isCheckPassing({ exitCode: 0 }), false);
  });

  it("buildVerdictRecord downgrades approve to reject when install is bare boolean true", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: true as unknown as Record<string, unknown>,
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.status, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.approved, false);
    assert.equal(
      (verdict.checks?.install as Record<string, unknown>).ok,
      false
    );
    assert.ok(
      verdict.reasons.some((r) => r.text.includes("install check"))
    );
  });

  it("buildVerdictRecord downgrades approve to reject when build is bare boolean true", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: { ok: true },
      build: true as unknown as Record<string, unknown>,
      accept: { ok: true },
      tests: { ok: true },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(
      (verdict.checks?.build as Record<string, unknown>).ok,
      false
    );
    assert.ok(
      verdict.reasons.some((r) => r.text.includes("build check"))
    );
  });

  it("buildVerdictRecord downgrades approve to reject when accept is bare boolean true", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: { ok: true },
      build: { ok: true },
      accept: true as unknown as Record<string, unknown>,
      tests: { ok: true },
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(
      (verdict.checks?.accept as Record<string, unknown>).ok,
      false
    );
    assert.ok(
      verdict.reasons.some((r) => r.text.includes("accept check"))
    );
  });

  it("buildVerdictRecord downgrades approve to reject when tests is bare boolean true", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: true as unknown as Record<string, unknown>,
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(
      (verdict.checks?.tests as Record<string, unknown>).ok,
      false
    );
    assert.ok(
      verdict.reasons.some((r) => r.text.includes("tests check"))
    );
  });

  it("buildVerdictRecord downgrades approve to reject when all checks are bare boolean true", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: true as unknown as Record<string, unknown>,
      build: true as unknown as Record<string, unknown>,
      accept: true as unknown as Record<string, unknown>,
      tests: true as unknown as Record<string, unknown>,
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.approved, false);
    assert.equal((verdict.checks?.install as Record<string, unknown>).ok, false);
    assert.equal((verdict.checks?.build as Record<string, unknown>).ok, false);
    assert.equal((verdict.checks?.accept as Record<string, unknown>).ok, false);
    assert.equal((verdict.checks?.tests as Record<string, unknown>).ok, false);
  });
});

describe("N-A15: Strict evidence ref syntax in isValidEvidenceRef", () => {
  it("rejects arbitrary foo:bar evidence refs and unsupported schemes", () => {
    assert.equal(isValidEvidenceRef("foo:bar"), false);
    assert.equal(isValidEvidenceRef("custom:ref123"), false);
    assert.equal(isValidEvidenceRef("arbitrary:something"), false);
    assert.equal(isValidEvidenceRef("http://example.com"), false);
    assert.equal(isValidEvidenceRef("git:commit-hash"), false);
    assert.equal(isValidEvidenceRef("log:12345"), false);
  });

  it("rejects empty bodies for supported schemes", () => {
    assert.equal(isValidEvidenceRef("cmd:"), false);
    assert.equal(isValidEvidenceRef("file:"), false);
    assert.equal(isValidEvidenceRef("gh:"), false);
    assert.equal(isValidEvidenceRef("ev:"), false);
  });

  it("rejects whitespace-only bodies or references containing internal whitespace", () => {
    assert.equal(isValidEvidenceRef("cmd: "), false);
    assert.equal(isValidEvidenceRef("file: "), false);
    assert.equal(isValidEvidenceRef("cmd:npm test"), false);
    assert.equal(isValidEvidenceRef("file:src/app.ts 42"), false);
  });

  it("accepts only valid cmd:, file:, gh:, and ev: evidence refs with non-empty bodies", () => {
    assert.equal(isValidEvidenceRef("cmd:npm-test-1"), true);
    assert.equal(isValidEvidenceRef("cmd:build-prod"), true);
    assert.equal(isValidEvidenceRef("file:lib/warden/warden-review.ts:42"), true);
    assert.equal(isValidEvidenceRef("file:src/index.ts"), true);
    assert.equal(isValidEvidenceRef("gh:issue/101"), true);
    assert.equal(isValidEvidenceRef("gh:pr/42"), true);
    assert.equal(isValidEvidenceRef("ev:signal-m2"), true);
    assert.equal(isValidEvidenceRef("ev:1"), true);
    assert.equal(isValidEvidenceRef("gh:1"), true);
  });

  it("exports EVIDENCE_REF_PATTERNS matching the supported schemes", () => {
    assert.ok(EVIDENCE_REF_PATTERNS);
    assert.ok(EVIDENCE_REF_PATTERNS.cmd.test("cmd:test"));
    assert.ok(EVIDENCE_REF_PATTERNS.file.test("file:path.ts"));
    assert.ok(EVIDENCE_REF_PATTERNS.gh.test("gh:123"));
    assert.ok(EVIDENCE_REF_PATTERNS.ev.test("ev:sig"));
    assert.equal(EVIDENCE_REF_PATTERNS.cmd.test("foo:bar"), false);
  });
});

describe("N-A15: Mandatory evidence refs for approve verdicts", () => {
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const diffText = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const expectedSha256 = candidateSha256FromDiff(diffText);

  it("validateWardenVerdict fails when approve verdict has no valid evidence refs", () => {
    const verdictWithoutRefs = {
      verdict: "approve" as const,
      status: "approve" as const,
      ok: true,
      approved: true,
      target: "task-01",
      candidateSha: commitSha,
      candidateSha256: expectedSha256,
      reasons: ["All checks passed cleanly without pointers"],
      refs: [],
      ts: Date.now(),
    };

    const res = validateWardenVerdict(verdictWithoutRefs);
    assert.equal(res.valid, false);
    assert.equal(res.verdict, "approve");
    assert.equal(res.allLackRefs, true);
    assert.ok(
      res.reasons.some((r) =>
        r.includes("Approve verdict requires at least one valid evidence reference")
      )
    );
  });

  it("validateWardenVerdict fails when approve verdict has only arbitrary foo:bar refs", () => {
    const verdictWithArbitraryRef = {
      verdict: "approve" as const,
      status: "approve" as const,
      ok: true,
      approved: true,
      target: "task-01",
      candidateSha: commitSha,
      candidateSha256: expectedSha256,
      reasons: [{ text: "Checks passed", refs: ["foo:bar"] }],
      refs: ["foo:bar"],
      ts: Date.now(),
    };

    const res = validateWardenVerdict(verdictWithArbitraryRef);
    assert.equal(res.valid, false);
    assert.equal(res.allLackRefs, true);
    assert.ok(
      res.reasons.some((r) =>
        r.includes("Approve verdict requires at least one valid evidence reference")
      )
    );
  });

  it("validateWardenVerdict passes when approve verdict has valid evidence refs", () => {
    const verdictWithValidRef = {
      verdict: "approve" as const,
      status: "approve" as const,
      ok: true,
      approved: true,
      target: "task-01",
      candidateSha: commitSha,
      candidateSha256: expectedSha256,
      reasons: [{ text: "Passed in file:src/app.ts:10", refs: ["file:src/app.ts:10"] }],
      refs: ["file:src/app.ts:10"],
      ts: Date.now(),
    };

    const res = validateWardenVerdict(verdictWithValidRef);
    assert.equal(res.valid, true);
    assert.equal(res.verdict, "approve");
    assert.equal(res.allLackRefs, false);
    assert.equal(res.reasons.length, 0);
  });

  it("buildVerdictRecord downgrades approve to reject when reasons lack valid evidence refs", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      reasons: ["Verification succeeded without any ref link"],
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.status, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.approved, false);
    assert.ok(
      verdict.reasons.some((r) =>
        r.text.includes("Approve verdict requires at least one valid evidence reference")
      )
    );
  });

  it("buildVerdictRecord downgrades approve to reject when only arbitrary foo:bar refs are given", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      reasons: [{ text: "Checks passed", refs: ["foo:bar"] }],
      refs: ["foo:bar"],
    });

    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.approved, false);
    assert.ok(
      verdict.reasons.some((r) =>
        r.text.includes("Approve verdict requires at least one valid evidence reference")
      )
    );
  });

  it("buildVerdictRecord keeps approve verdict when valid evidence ref is present in reasons or refs", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      reasons: [{ text: "Checks passed", refs: ["cmd:verify"] }],
    });

    assert.equal(verdict.verdict, "approve");
    assert.equal(verdict.status, "approve");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.approved, true);
  });

  it("buildVerdictRecord default approve reasons supply valid cmd:all-checks-passed ref", () => {
    const verdict = buildVerdictRecord(commitSha, {
      verdict: "approve",
      diff: diffText,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });

    assert.equal(verdict.verdict, "approve");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.approved, true);
    assert.ok(verdict.refs.includes("cmd:all-checks-passed"));

    const val = validateWardenVerdict(verdict);
    assert.equal(val.valid, true);
    assert.equal(val.verdict, "approve");
  });
});
