import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReportStepArtifacts,
  buildArtifactList,
  buildDiffsArtifact,
  buildSpecBundleArtifact,
  buildVerifyResultArtifact,
  buildReportArtifact,
  verifyScribeReading,
  stripScribeNarrative,
  SCRIBE_NARRATIVE_FALLBACK_NOTICE,
  EVIDENCE_MARKER_PREFIXES,
  type ReportStepInput,
} from "../../lib/lifecycle/report-step";
import { computeArtifactSha256 } from "../../lib/lifecycle/artifact-collector";

test("report-step: pure function artifact generation", async (t) => {
  await t.test(
    "builds the artifact list (diffs, spec bundle, report, verify result) as data from injected inputs",
    () => {
      const input: ReportStepInput = {
        runId: "run-test-100",
        owner: "test-owner",
        repo: "test-repo",
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        headSha: "abcdef0123456789abcdef0123456789abcdef01",
        engineVersion: "v1.0.0",
        diffs: {
          "package.json": "@@ -1,3 +1,3 @@\n- old\n+ new\n",
          "src/index.js": "@@ -10,2 +10,3 @@\n+ const x = 1;\n",
        },
        specBundle: {
          requirements: "# Requirements: test-repo\n\n1. Target runtime Node 20.\n",
          design: "# Design: test-repo\n\nArchitecture details.\n",
          tasks: "# Tasks: test-repo\n\n- [ ] 1. Task 1\n",
        },
        verifyResult: {
          ok: true,
          passed: true,
          installPassed: true,
          buildPassed: true,
          testsPassed: true,
          hasTests: true,
          gates: {
            "src/index.js": { ok: true, ruleId: "M2" },
          },
        },
        tasks: [
          { id: "task-1", state: "merged" },
          { id: "task-2", state: "merged" },
        ],
      };

      const result = buildReportStepArtifacts(input);

      assert.equal(result.runId, "run-test-100");
      assert.equal(result.outcome, "resurrected");
      assert.equal(result.allReady, true);
      assert.ok(result.totalByteSize > 0);
      assert.ok(result.sha256.length === 64);

      // Verify diffs artifact data
      assert.ok(result.diffs);
      assert.ok(result.diffs.files["package.json"]);
      assert.ok(result.diffs.files["src/index.js"]);
      assert.ok(result.diffs.allPatch.includes("package.json"));
      assert.ok(result.diffs.allPatch.includes("src/index.js"));

      // Verify spec bundle artifact data
      assert.ok(result.specBundle);
      assert.equal(
        result.specBundle.requirements,
        "# Requirements: test-repo\n\n1. Target runtime Node 20.\n"
      );
      assert.equal(
        result.specBundle.files["design.md"],
        "# Design: test-repo\n\nArchitecture details.\n"
      );

      // Verify verifyResult artifact data
      assert.ok(result.verifyResult);
      assert.equal(result.verifyResult.ok, true);
      assert.equal(result.verifyResult.passed, true);

      // Verify report artifact data
      assert.ok(result.report);
      assert.equal(result.report.withoutScribeNarrative, true);
      assert.equal(result.report.narrativeExcluded, true);

      // Verify flat artifact list contains all four groups
      const artifactPaths = result.artifacts.map((a) => a.path);
      assert.ok(artifactPaths.includes("all.patch"));
      assert.ok(artifactPaths.includes("diffs/package.json.patch"));
      assert.ok(artifactPaths.includes("diffs/src/index.js.patch"));
      assert.ok(artifactPaths.includes("spec/requirements.md"));
      assert.ok(artifactPaths.includes("spec/design.md"));
      assert.ok(artifactPaths.includes("spec/tasks.md"));
      assert.ok(artifactPaths.includes("spec.json"));
      assert.ok(artifactPaths.includes("report.json"));
      assert.ok(artifactPaths.includes("report.md"));
      assert.ok(artifactPaths.includes("verify-result.json"));

      // Verify manifest maps paths correctly
      assert.equal(result.manifest["report.json"].kind, "report");
      assert.equal(result.manifest["verify-result.json"].kind, "verify_result");
      assert.equal(result.manifest["all.patch"].kind, "patch");
      assert.equal(result.manifest["spec.json"].kind, "spec");

      // Verify all artifacts have valid sha256 and byteSize
      for (const art of result.artifacts) {
        assert.equal(typeof art.content, "string");
        assert.equal(art.sha256.length, 64);
        assert.equal(art.sha256, computeArtifactSha256(art.content));
        assert.equal(art.byteSize, Buffer.byteLength(art.content, "utf8"));
      }
    }
  );

  await t.test("purity: does not mutate inputs and returns identical outputs for identical inputs", () => {
    const input: ReportStepInput = {
      runId: "run-purity",
      diffs: { "file.js": "+ const a = 1;\n" },
      verifyResult: { ok: true, installPassed: true, buildPassed: true, testsPassed: true, hasTests: false },
      tasks: [{ id: "t1", state: "merged" }],
    };

    const inputCopy = JSON.parse(JSON.stringify(input));
    const result1 = buildReportStepArtifacts(input);
    const result2 = buildReportStepArtifacts(input);

    assert.deepEqual(input, inputCopy);
    assert.deepEqual(result1, result2);
    assert.equal(result1.sha256, result2.sha256);
  });
});

test("report-step: Scribe narrative omission (Requirements 26.6, 26.7, 26.8, 26.17)", async (t) => {
  await t.test(
    "unconditionally excludes model-written Scribe narrative from report artifact",
    () => {
      const input: ReportStepInput = {
        runId: "run-no-narrative",
        scribeNarrative: "This is a hallucinated model narrative with no evidence.",
        scribeReading: "Another model paragraph that should be completely dropped.",
        diffs: { "index.js": "+ patch\n" },
        verifyResult: { ok: true, installPassed: true, buildPassed: true },
      };

      const result = buildReportStepArtifacts(input);

      assert.equal(result.report.withoutScribeNarrative, true);
      assert.equal(result.report.narrativeExcluded, true);
      assert.equal(result.report.fallbackNotice, SCRIBE_NARRATIVE_FALLBACK_NOTICE);

      // JSON report must have scribeReading: null and narrativeExcluded: true
      assert.equal(result.report.data.scribeReading, null);
      assert.equal(result.report.data.narrativeExcluded, true);
      assert.equal(
        result.report.data.narrativeNotice,
        SCRIBE_NARRATIVE_FALLBACK_NOTICE
      );
      assert.ok(!result.report.json.includes("hallucinated model narrative"));
      assert.ok(!result.report.json.includes("Another model paragraph"));

      // Markdown report must show the fallback notice under Scribe's reading
      assert.ok(
        result.report.markdown.includes(
          "The Scribe's narrative did not pass the evidence check and was left out."
        )
      );
      assert.ok(!result.report.markdown.includes("hallucinated model narrative"));
    }
  );

  await t.test("stripScribeNarrative replaces Scribe narrative section with fallback notice", () => {
    const textWithNarrative = [
      "# Run Report",
      "",
      "## Findings",
      "All checks passed.",
      "",
      "## Scribe's reading",
      "Model hallucinated narrative here without evidence.",
      "",
      "## Verification",
      "cmd:verify passed.",
    ].join("\n");

    const stripped = stripScribeNarrative(textWithNarrative);
    assert.ok(!stripped.includes("Model hallucinated narrative"));
    assert.ok(stripped.includes(SCRIBE_NARRATIVE_FALLBACK_NOTICE));
    assert.ok(stripped.includes("## Verification"));
  });

  await t.test("verifyScribeReading: verifies numerals and claim words against evidence markers", () => {
    // Valid case: claims and numerals cite valid evidence markers
    const validNarrative =
      "Build passed cmd:build-log-1. All 5 tests passed cmd:test-log-1 in file:src/index.ts.";
    const validRes = verifyScribeReading(validNarrative);
    assert.equal(validRes.passed, true);
    assert.equal(validRes.unbackedItems.length, 0);
    assert.ok(validRes.checkedCount > 0);

    // Invalid case: unbacked numeral without evidence marker
    const unbackedNumeral = "We fixed 12 security issues.";
    const numRes = verifyScribeReading(unbackedNumeral);
    assert.equal(numRes.passed, false);
    assert.ok(numRes.unbackedItems.length > 0);
    assert.equal(numRes.unbackedItems[0].claim, "fixed");

    // Invalid case: unbacked claim word without evidence marker
    const unbackedClaim = "The candidate passed smoothly without issues.";
    const claimRes = verifyScribeReading(unbackedClaim);
    assert.equal(claimRes.passed, false);
    assert.ok(claimRes.unbackedItems.some((item) => item.claim === "passed"));

    // Evidence store validation: marker missing from store
    const store = {
      "cmd:build-log-1": { ok: true },
    };
    const missingMarkerNarrative =
      "Test failed cmd:nonexistent-ref.";
    const storeRes = verifyScribeReading(missingMarkerNarrative, store);
    assert.equal(storeRes.passed, false);
    assert.ok(
      storeRes.unbackedItems.some((item) =>
        item.reason.includes("not found in stored evidence")
      )
    );
  });
});

test("report-step: failure and recovery handling (Requirements 41.5, 41.6, 41.7)", async (t) => {
  await t.test(
    "preserves crashed skeleton records, worktrees, log refs, and Legion recovery statuses",
    () => {
      const input: ReportStepInput = {
        runId: "run-crash-test",
        diffs: {},
        tasks: [{ id: "t1", state: "merged" }],
        verifyResult: { ok: false, installPassed: true, buildPassed: false },
        crashedSkeletons: [
          {
            skeletonId: "sk-builder-1",
            role: "Soul-stitcher",
            worktree: "worktrees/sk-builder-1",
            logRef: "log-builder-1",
            state: "failed",
            statusText: "Recovering",
            respawnMessage: "Resumed the same session",
          },
        ],
        workerRestart: {
          restarted: true,
          pausedDurationMs: 4500,
          affectedRuns: ["run-crash-test"],
        },
      };

      const result = buildReportStepArtifacts(input);

      assert.equal(result.outcome, "partial");

      // Verify findings in report JSON
      const findings = result.report.data.findings as Record<string, unknown>;
      assert.ok(findings.crashedSkeletons);
      const skeletons = findings.crashedSkeletons as Array<Record<string, unknown>>;
      assert.equal(skeletons.length, 1);
      assert.equal(skeletons[0].skeletonId, "sk-builder-1");
      assert.equal(skeletons[0].state, "failed");
      assert.equal(skeletons[0].worktree, "worktrees/sk-builder-1");
      assert.equal(skeletons[0].logRef, "cmd:log-builder-1");
      assert.equal(skeletons[0].statusText, "Recovering");
      assert.equal(skeletons[0].respawnMessage, "Resumed the same session");

      // Verify worker restart details
      assert.ok(findings.workerRestart);
      const restart = findings.workerRestart as Record<string, unknown>;
      assert.equal(restart.restarted, true);
      assert.equal(restart.eventKind, "system.worker_restart");
      assert.equal(restart.pausedDurationMs, 4500);

      // Verify markdown report contains recovery and restart notices
      assert.ok(
        result.report.markdown.includes(
          "Skeleton `sk-builder-1`: Recovering, Resumed the same session"
        )
      );
      assert.ok(result.report.markdown.includes("system.worker_restart"));
    }
  );
});

test("report-step: input format flexibility", async (t) => {
  await t.test("parses unified diff string into individual diff files", () => {
    const rawDiff = [
      "diff --git a/file1.txt b/file1.txt",
      "--- a/file1.txt",
      "+++ b/file1.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/dir/file2.txt b/dir/file2.txt",
      "--- a/dir/file2.txt",
      "+++ b/dir/file2.txt",
      "@@ -1 +1 @@",
      "-foo",
      "+bar",
    ].join("\n");

    const diffsArtifact = buildDiffsArtifact(rawDiff);
    assert.ok(diffsArtifact.files["file1.txt"]);
    assert.ok(diffsArtifact.files["dir/file2.txt"]);
    assert.equal(diffsArtifact.allPatch, rawDiff);

    const paths = diffsArtifact.artifacts.map((a) => a.path);
    assert.ok(paths.includes("all.patch"));
    assert.ok(paths.includes("diffs/file1.txt.patch"));
    assert.ok(paths.includes("diffs/dir/file2.txt.patch"));
  });

  await t.test("handles array of diff items", () => {
    const diffsList = [
      { path: "src/app.ts", diff: "@@ -1 +1 @@\n+export const x = 1;\n" },
    ];
    const diffsArtifact = buildDiffsArtifact(diffsList);
    assert.ok(diffsArtifact.files["src/app.ts"]);
    assert.ok(
      diffsArtifact.artifacts.some((a) => a.path === "diffs/src/app.ts.patch")
    );
  });

  await t.test("buildSpecBundleArtifact provides default templates when empty", () => {
    const spec = buildSpecBundleArtifact("run-defaults");
    assert.ok(spec.requirements.includes("run-defaults"));
    assert.ok(spec.design.includes("run-defaults"));
    assert.ok(spec.tasks.includes("run-defaults"));
    assert.ok(spec.artifacts.some((a) => a.path === "spec/requirements.md"));
    assert.ok(spec.artifacts.some((a) => a.path === "spec.json"));
  });

  await t.test("buildVerifyResultArtifact supports boolean and structured input", () => {
    const boolTrue = buildVerifyResultArtifact("run-1", true);
    assert.equal(boolTrue.ok, true);
    assert.equal(boolTrue.passed, true);

    const boolFalse = buildVerifyResultArtifact("run-2", false);
    assert.equal(boolFalse.ok, false);
    assert.equal(boolFalse.passed, false);

    const structured = buildVerifyResultArtifact("run-3", {
      installPassed: true,
      buildPassed: true,
      testsPassed: true,
      hasTests: false,
    });
    assert.equal(structured.ok, true);
    assert.equal(structured.passed, true);
  });

  await t.test("buildArtifactList convenience export returns flat artifact list", () => {
    const artifacts = buildArtifactList({
      runId: "run-convenience",
      diffs: { "foo.txt": "+ bar\n" },
      verifyResult: true,
    });
    assert.ok(Array.isArray(artifacts));
    assert.ok(artifacts.length >= 4);
    assert.ok(artifacts.some((a) => a.path === "all.patch"));
    assert.ok(artifacts.some((a) => a.path === "report.json"));
    assert.ok(artifacts.some((a) => a.path === "verify-result.json"));
    assert.ok(artifacts.some((a) => a.path === "spec.json"));
  });
});
