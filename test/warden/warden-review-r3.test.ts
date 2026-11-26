// Work package R3-G2b (Warden verdict: accept checks fail closed and findings.ok false always rejects (H-8))
// Requirements: 24.5, 24.7, 24.8, 24.16, 25.6, 25.8

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVerdictRecord,
  buildWardenVerdict,
  createWardenVerdict,
  validateWardenVerdict,
} from "../../lib/warden/warden-review";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

describe("R3-G2b / Finding H-8: Warden accept checks fail closed and findings.ok false always rejects", () => {
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const candidateDiff =
    "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const expectedSha256 = candidateSha256FromDiff(candidateDiff);

  describe("1. An omitted accept check is rejected", () => {
    it("rejects verdict when accept check is omitted even if other checks pass", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        // accept check is completely omitted
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.status, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) =>
          r.text.toLowerCase().includes("missing accept check")
        ),
        "Expected reasons to include 'missing accept check'"
      );
      assert.ok(
        verdict.reasons.some((r) => r.text.toLowerCase().includes("accept")),
        "Expected finding that names the accept check"
      );
      assert.equal(
        verdict.checks?.accept && (verdict.checks.accept as Record<string, unknown>).ok,
        false
      );
    });

    it("rejects verdict when accept check is null or undefined via aliases", () => {
      const v1 = buildWardenVerdict(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: undefined,
      });
      assert.equal(v1.verdict, "reject");
      assert.equal(v1.ok, false);
      assert.ok(v1.reasons.some((r) => r.text.toLowerCase().includes("accept")));

      const v2 = createWardenVerdict(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: null as unknown as boolean,
      });
      assert.equal(v2.verdict, "reject");
      assert.equal(v2.ok, false);
      assert.ok(v2.reasons.some((r) => r.text.toLowerCase().includes("accept")));
    });
  });

  describe("2. An empty check object is rejected", () => {
    it("rejects verdict when accept check is an empty object", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: {},
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.status, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) =>
          r.text.toLowerCase().includes("accept")
        ),
        "Expected finding that names the accept check"
      );
      assert.equal(
        verdict.checks?.accept && (verdict.checks.accept as Record<string, unknown>).ok,
        false
      );
    });

    it("rejects verdict when accept check object lacks boolean ok", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { exitCode: 0, stdout: "done" } as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(verdict.reasons.some((r) => r.text.toLowerCase().includes("accept")));
    });

    it("rejects verdict when install or build or tests is an empty check object", () => {
      const vInstall = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: {},
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vInstall.verdict, "reject");
      assert.equal(vInstall.ok, false);
      assert.ok(vInstall.reasons.some((r) => r.text.toLowerCase().includes("install")));

      const vBuild = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: {},
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vBuild.verdict, "reject");
      assert.equal(vBuild.ok, false);
      assert.ok(vBuild.reasons.some((r) => r.text.toLowerCase().includes("build")));

      const vTests = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: {},
      });
      assert.equal(vTests.verdict, "reject");
      assert.equal(vTests.ok, false);
      assert.ok(vTests.reasons.some((r) => r.text.toLowerCase().includes("tests") || r.text.toLowerCase().includes("test")));
    });

    it("rejects verdict when accept check is false", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: false,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) =>
          r.text.toLowerCase().includes("accept") ||
          r.text.toLowerCase().includes("acceptance")
        ),
        "Expected finding that names the accept check on false"
      );
    });
  });

  describe("3. findings.ok false with reasons is rejected", () => {
    it("rejects verdict when findings.ok is false even with explicit approve verdict and non-empty reasons", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        ok: false,
        reasons: ["Build succeeded but diagnostic gate failed in file:src/check.ts:15"],
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.status, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) =>
          r.text.includes("Build succeeded but diagnostic gate failed")
        )
      );
    });

    it("preserves requiresRerun semantics when ok is false with reasons lacking refs", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        ok: false,
        reasons: ["Something failed without refs"],
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.atLeastOneReasonHasRef, false);
      assert.equal(verdict.requiresRerun, true);
    });

    it("rejects verdict when findings.passed is false with reasons", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        passed: false,
        reasons: [
          { text: "Security check failed", refs: ["cmd:audit-sec"] },
        ],
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(verdict.reasons.some((r) => r.text.includes("Security check failed")));
      assert.equal(verdict.atLeastOneReasonHasRef, true);
      assert.equal(verdict.requiresRerun, false);
    });

    it("rejects verdict when ok is false in single-object invocation", () => {
      const verdict = buildVerdictRecord({
        candidateSha: commitSha,
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        ok: false,
        reasons: ["Failure in file:lib/index.ts:1"],
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
    });
  });

  describe("4. A complete valid verdict is still accepted", () => {
    it("accepts candidate when install, build, accept, and tests all pass with boolean ok true", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true, exitCode: 0, logRef: "install-log" },
        build: { ok: true, exitCode: 0, logRef: "build-log" },
        accept: { ok: true, exitCode: 0, logRef: "accept-log" },
        tests: { ok: true, exitCode: 0, logRef: "tests-log" },
      });

      assert.equal(verdict.verdict, "approve");
      assert.equal(verdict.status, "approve");
      assert.equal(verdict.ok, true);
      assert.equal(verdict.approved, true);
      assert.equal(verdict.candidateSha, commitSha);
      assert.equal(verdict.candidateSha256, expectedSha256);
      assert.equal(verdict.requiresRerun, false);
      assert.ok(verdict.reasons.length > 0);
      assert.ok(verdict.reasons[0].refs.length > 0);

      assert.equal(
        (verdict.checks?.install as Record<string, unknown>).ok,
        true
      );
      assert.equal(
        (verdict.checks?.build as Record<string, unknown>).ok,
        true
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        true
      );
      assert.equal(
        (verdict.checks?.tests as Record<string, unknown>).ok,
        true
      );

      const validation = validateWardenVerdict(verdict);
      assert.equal(validation.valid, true);
      assert.equal(validation.verdict, "approve");
      assert.equal(validation.requiresRerun, false);
    });

    it("accepts candidate when alternative accept check names (taskAccept, acceptCommand) are used", () => {
      const vTaskAccept = buildVerdictRecord(commitSha, {
        target: "task-02",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        taskAccept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vTaskAccept.verdict, "approve");
      assert.equal(vTaskAccept.ok, true);

      const vAcceptCmd = buildVerdictRecord(commitSha, {
        target: "task-03",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        acceptCommand: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vAcceptCmd.verdict, "approve");
      assert.equal(vAcceptCmd.ok, true);
    });
  });
});
