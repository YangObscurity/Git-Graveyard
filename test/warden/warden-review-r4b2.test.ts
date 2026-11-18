// Work package R4-B2 (Remediation: Warden check values must be boolean true (audit H-8))
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

describe("R4-B2 / Audit H-8: Warden check values must be boolean true", () => {
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const candidateDiff =
    "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const expectedSha256 = candidateSha256FromDiff(candidateDiff);

  const missingAcceptReason =
    "Missing accept check in auditbox environment (Requirement 24.5)";
  const failedAcceptReason = "Task acceptance command failed";

  describe("1. accept as the empty string is rejected with the missing-accept reason", () => {
    it("rejects when accept is the empty string", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: "" as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason)),
        `Expected reasons to include '${missingAcceptReason}'`
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        false
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).missing,
        true
      );
    });

    it("rejects when taskAccept alias is the empty string", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        taskAccept: "" as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason))
      );
    });

    it("rejects when acceptCommand alias is the empty string", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        acceptCommand: "" as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason))
      );
    });
  });

  describe("2. accept as zero is rejected with the missing-accept reason", () => {
    it("rejects when accept is zero", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: 0 as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason)),
        `Expected reasons to include '${missingAcceptReason}'`
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        false
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).missing,
        true
      );
    });

    it("rejects when taskAccept alias is zero", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        taskAccept: 0 as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason))
      );
    });

    it("rejects when acceptCommand alias is zero", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        acceptCommand: 0 as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason))
      );
    });
  });

  describe("3. accept as the string ok is rejected with the missing-accept reason", () => {
    it("rejects when accept is the string ok", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: "ok" as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason)),
        `Expected reasons to include '${missingAcceptReason}'`
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        false
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).missing,
        true
      );
    });

    it("rejects when accept is other strings like 'true' or 'passed'", () => {
      const vStrTrue = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: "true" as unknown as boolean,
      });
      assert.equal(vStrTrue.verdict, "reject");
      assert.equal(vStrTrue.ok, false);
      assert.ok(
        vStrTrue.reasons.some((r) => r.text.includes(missingAcceptReason))
      );

      const vStrPassed = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: "passed" as unknown as boolean,
      });
      assert.equal(vStrPassed.verdict, "reject");
      assert.equal(vStrPassed.ok, false);
      assert.ok(
        vStrPassed.reasons.some((r) => r.text.includes(missingAcceptReason))
      );
    });

    it("rejects when accept is an array", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: [] as unknown as boolean,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(missingAcceptReason))
      );
    });
  });

  describe("4. accept as object with ok true passes", () => {
    it("passes when accept is an object with ok boolean true", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        evidenceRefs: ["cmd:accept"],
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: true },
      });

      assert.equal(verdict.verdict, "approve");
      assert.equal(verdict.ok, true);
      assert.equal(verdict.approved, true);
      assert.equal(verdict.candidateSha, commitSha);
      assert.equal(verdict.candidateSha256, expectedSha256);
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        true
      );

      const val = validateWardenVerdict(verdict);
      assert.equal(val.valid, true);
      assert.equal(val.verdict, "approve");
    });

    it("passes when taskAccept alias is an object with ok true", () => {
      const verdict = buildWardenVerdict(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        evidenceRefs: ["cmd:task-accept"],
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        taskAccept: { ok: true },
      });

      assert.equal(verdict.verdict, "approve");
      assert.equal(verdict.ok, true);
      assert.equal(verdict.approved, true);
    });

    it("passes when acceptCommand alias is an object with ok true", () => {
      const verdict = createWardenVerdict(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        evidenceRefs: ["cmd:accept-cmd"],
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        acceptCommand: { ok: true },
      });

      assert.equal(verdict.verdict, "approve");
      assert.equal(verdict.ok, true);
      assert.equal(verdict.approved, true);
    });
  });

  describe("5. accept as an object with ok true passes", () => {
    it("passes when accept is an object with ok boolean true", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: true },
      });

      assert.equal(verdict.verdict, "approve");
      assert.equal(verdict.ok, true);
      assert.equal(verdict.approved, true);
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        true
      );
    });

    it("passes when accept object has ok true with exitCode 0 and logRef", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true, exitCode: 0 },
        build: { ok: true, exitCode: 0 },
        tests: { ok: true, exitCode: 0 },
        accept: { ok: true, exitCode: 0, logRef: "accept-run" },
      });

      assert.equal(verdict.verdict, "approve");
      assert.equal(verdict.ok, true);
      assert.equal(verdict.approved, true);
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        true
      );
    });
  });

  describe("6. accept as false is rejected", () => {
    it("rejects when accept is the boolean false", () => {
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
        verdict.reasons.some((r) => r.text.includes(failedAcceptReason)),
        `Expected reasons to include '${failedAcceptReason}'`
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        false
      );
    });

    it("rejects when taskAccept alias is false", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        taskAccept: false,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(failedAcceptReason))
      );
    });

    it("rejects when acceptCommand alias is false", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        acceptCommand: false,
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(failedAcceptReason))
      );
    });
  });

  describe("7. accept as an object with ok false is rejected", () => {
    it("rejects when accept is an object with ok false", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: false },
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.equal(verdict.approved, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(failedAcceptReason)),
        `Expected reasons to include '${failedAcceptReason}'`
      );
      assert.equal(
        (verdict.checks?.accept as Record<string, unknown>).ok,
        false
      );
    });

    it("rejects when accept is an object with ok false and exitCode 1", () => {
      const verdict = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: false, exitCode: 1, logRef: "accept-fail" },
      });

      assert.equal(verdict.verdict, "reject");
      assert.equal(verdict.ok, false);
      assert.ok(
        verdict.reasons.some((r) => r.text.includes(failedAcceptReason))
      );
      assert.ok(verdict.refs.includes("cmd:accept-fail"));
    });

    it("rejects when accept is an object with ok true but failure markers", () => {
      // Nonzero exit code
      const vExit = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: true, exitCode: 1 },
      });
      assert.equal(vExit.verdict, "reject");
      assert.equal(vExit.ok, false);
      assert.ok(vExit.reasons.some((r) => r.text.includes(failedAcceptReason)));

      // passed false
      const vPassed = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: true, passed: false },
      });
      assert.equal(vPassed.verdict, "reject");
      assert.equal(vPassed.ok, false);
      assert.ok(vPassed.reasons.some((r) => r.text.includes(failedAcceptReason)));

      // status failed
      const vStatusFailed = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: true, status: "failed" },
      });
      assert.equal(vStatusFailed.verdict, "reject");
      assert.equal(vStatusFailed.ok, false);
      assert.ok(vStatusFailed.reasons.some((r) => r.text.includes(failedAcceptReason)));

      // status error
      const vStatusError = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        tests: { ok: true },
        accept: { ok: true, status: "error" },
      });
      assert.equal(vStatusError.verdict, "reject");
      assert.equal(vStatusError.ok, false);
      assert.ok(vStatusError.reasons.some((r) => r.text.includes(failedAcceptReason)));
    });
  });

  describe("8. build and tests checks use the same rule", () => {
    it("rejects build as empty string, zero, or string ok with missing-build reason", () => {
      const vEmpty = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: "" as unknown as boolean,
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vEmpty.verdict, "reject");
      assert.ok(
        vEmpty.reasons.some((r) =>
          r.text.includes("Missing build check in auditbox environment")
        )
      );

      const vZero = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: 0 as unknown as boolean,
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vZero.verdict, "reject");
      assert.ok(
        vZero.reasons.some((r) =>
          r.text.includes("Missing build check in auditbox environment")
        )
      );

      const vOkStr = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: "ok" as unknown as boolean,
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vOkStr.verdict, "reject");
      assert.ok(
        vOkStr.reasons.some((r) =>
          r.text.includes("Missing build check in auditbox environment")
        )
      );
    });

    it("passes build as object with ok true and rejects as object with ok false", () => {
      const vPass = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        evidenceRefs: ["cmd:build"],
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vPass.verdict, "approve");
      assert.equal(vPass.ok, true);

      const vFail = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: false },
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vFail.verdict, "reject");
      assert.ok(
        vFail.reasons.some((r) =>
          r.text.includes("Build failed in auditbox environment")
        )
      );
    });

    it("rejects tests as empty string, zero, or string ok with missing-tests reason", () => {
      const vEmpty = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: "" as unknown as boolean,
      });
      assert.equal(vEmpty.verdict, "reject");
      assert.ok(
        vEmpty.reasons.some((r) =>
          r.text.includes("Missing tests check in auditbox environment")
        )
      );

      const vZero = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: 0 as unknown as boolean,
      });
      assert.equal(vZero.verdict, "reject");
      assert.ok(
        vZero.reasons.some((r) =>
          r.text.includes("Missing tests check in auditbox environment")
        )
      );

      const vOkStr = buildVerdictRecord(commitSha, {
        target: "task-01",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: "ok" as unknown as boolean,
      });
      assert.equal(vOkStr.verdict, "reject");
      assert.ok(
        vOkStr.reasons.some((r) =>
          r.text.includes("Missing tests check in auditbox environment")
        )
      );
    });

    it("passes tests as object with ok true and rejects as object with ok false", () => {
      const vPass = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        evidenceRefs: ["cmd:test"],
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
      });
      assert.equal(vPass.verdict, "approve");
      assert.equal(vPass.ok, true);

      const vFail = buildVerdictRecord(commitSha, {
        target: "task-01",
        verdict: "approve",
        diff: candidateDiff,
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: false },
      });
      assert.equal(vFail.verdict, "reject");
      assert.ok(
        vFail.reasons.some((r) =>
          r.text.includes("Repository tests failed in auditbox")
        )
      );
    });
  });
});
