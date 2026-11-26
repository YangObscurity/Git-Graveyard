import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ReliquaryBeforeAfterTable,
  formatDuration,
  formatExitCode,
} from "@/components/ReliquaryBeforeAfterTable";
import {
  ReliquaryDiffViewer,
  parseDiffIntoHunks,
} from "@/components/ReliquaryDiffViewer";
import { ReliquaryTaskLedger } from "@/components/ReliquaryTaskLedger";
import {
  ReliquaryArtifactDownloads,
  formatByteSize,
  type ReliquaryArtifactItem,
} from "@/components/ReliquaryArtifactDownloads";
import {
  ReliquaryView,
  formatOutcomeBannerText,
} from "@/components/ReliquaryView";
import { GET as downloadRoute } from "@/app/runs/[runId]/relic/download/route";

describe("Task 15.5 / Requirement 38: Reliquary results page (slice)", () => {
  describe("Requirement 38.1 & 38.2: Outcome banner in plain words", () => {
    it("shows 'Resurrected' only when both final-check build and repository tests passed", () => {
      // Both passed
      assert.equal(formatOutcomeBannerText("resurrected", true, true), "Resurrected");

      // Build failed or tests failed -> must not show "Resurrected"
      assert.notEqual(formatOutcomeBannerText("resurrected", false, true), "Resurrected");
      assert.notEqual(formatOutcomeBannerText("resurrected", true, false), "Resurrected");
      assert.notEqual(formatOutcomeBannerText("resurrected", false, false), "Resurrected");
    });

    it("formats all outcomes into plain English words without jargon", () => {
      assert.equal(formatOutcomeBannerText("resurrected_build_only"), "Resurrected (build only)");
      assert.equal(formatOutcomeBannerText("partial"), "Partially Resurrected");
      assert.equal(formatOutcomeBannerText("not_resurrected"), "Not Resurrected");
      assert.equal(formatOutcomeBannerText("healthy_already"), "Healthy Already");
      assert.equal(formatOutcomeBannerText("cancelled"), "Cancelled");
      assert.equal(formatOutcomeBannerText("killed"), "Killed");
      assert.equal(formatOutcomeBannerText("budget_stopped"), "Budget Exceeded");
      assert.equal(formatOutcomeBannerText("error"), "Error");
    });

    it("renders outcome banner in ReliquaryView", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-test-01",
          outcome: "resurrected",
        })
      );
      assert.ok(html.includes("Resurrected"));
      assert.ok(html.includes("Run: run-test-01"));
    });
  });

  describe("Requirement 38.3: Partial outcome breakdown", () => {
    it("lists what works and what does not from the before and after table", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-test-partial",
          outcome: "partial",
          beforeAfterRows: [
            {
              label: "Install",
              key: "install",
              before: { status: "failed", exitCode: 1 },
              after: { status: "passed", exitCode: 0 },
            },
            {
              label: "Build",
              key: "build",
              before: { status: "failed", exitCode: 1 },
              after: { status: "passed", exitCode: 0 },
            },
            {
              label: "Tests (repository's own)",
              key: "tests_repo",
              before: { status: "failed", exitCode: 1 },
              after: { status: "failed", exitCode: 1 },
            },
          ],
        })
      );

      assert.ok(html.includes("Partial Resurrection Breakdown"));
      assert.ok(html.includes("What works:"));
      assert.ok(html.includes("Install passed"));
      assert.ok(html.includes("Build passed"));
      assert.ok(html.includes("What does not:"));
      assert.ok(html.includes("Tests (repository&#x27;s own) failed") || html.includes("Tests (repository's own) failed"));
    });
  });

  describe("Requirement 38.4 & 38.5: Before and After verification table", () => {
    it("includes the 6 required rows plus 'Tests added by skeletons' in a separate row", () => {
      const html = renderToStaticMarkup(React.createElement(ReliquaryBeforeAfterTable, {}));

      // Required rows per Requirement 38.4
      assert.ok(html.includes("Install"), "must have Install row");
      assert.ok(html.includes("Build"), "must have Build row");
      assert.ok(html.includes("Tests (repository&#x27;s own)") || html.includes("Tests (repository's own)"), "must have repository tests row");
      assert.ok(html.includes("Grimoire signals"), "must have Grimoire signals row");
      assert.ok(html.includes("Lockfile"), "must have Lockfile row");
      assert.ok(html.includes("Runtime used"), "must have Runtime used row");

      // Separate row per Requirement 38.5
      assert.ok(html.includes("Tests added by skeletons"), "must have Tests added by skeletons row");
    });

    it("renders status, exit code, duration, and 'View output' in every cell", () => {
      const html = renderToStaticMarkup(React.createElement(ReliquaryBeforeAfterTable, {}));

      // Exit code and time markers
      assert.ok(html.includes("exit:"));
      assert.ok(html.includes("time:"));

      // Clickable View output button in cells
      assert.ok(html.includes("View output"));
    });

    it("formats duration and exit codes cleanly", () => {
      assert.equal(formatDuration(null), "-");
      assert.equal(formatDuration(undefined), "-");
      assert.equal(formatDuration(450), "450ms");
      assert.equal(formatDuration(2500), "2.5s");

      assert.equal(formatExitCode(null), "-");
      assert.equal(formatExitCode(undefined), "-");
      assert.equal(formatExitCode(0), "0");
      assert.equal(formatExitCode(1), "1");
    });
  });

  describe("Requirement 38.6 & 38.11: Diff browser with tagged hunks", () => {
    const samplePatch = `diff --git a/src/index.js b/src/index.js
index 1111111..2222222 100644
--- a/src/index.js
+++ b/src/index.js
@@ -10,3 +10,4 @@ Task: 12.1 Rule: M2
- const req = require("request");
+ const fetch = globalThis.fetch;
`;

    it("parses and tags hunks with task ID and Grimoire rule", () => {
      const hunks = parseDiffIntoHunks(samplePatch);
      assert.equal(hunks.length, 1);
      assert.equal(hunks[0].taskId, "12.1");
      assert.equal(hunks[0].ruleId, "M2");
    });

    it("renders fallback <pre> view with task and rule tags", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryDiffViewer, {
          diff: samplePatch,
        })
      );

      assert.ok(html.includes("Task: 12.1"));
      assert.ok(html.includes("Rule: M2"));
      assert.ok(html.includes("const fetch = globalThis.fetch;"));
    });

    it("displays 'There is no diff' when no tasks merged", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryDiffViewer, {
          noTasksMerged: true,
        })
      );

      assert.ok(html.includes("There is no diff"));
    });
  });

  describe("Requirement 38.7: Task ledger", () => {
    it("renders each task with final state, attempts, Warden Verdict and reasons", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryTaskLedger, {
          tasks: [
            {
              id: "task-01",
              title: "Migrate request to native fetch",
              state: "merged",
              attempts: 1,
              verdict: "approve",
              reasons: [
                {
                  message: "All auditbox checks passed cleanly",
                  ref: "file:src/index.js:12",
                },
              ],
            },
            {
              id: "task-02",
              title: "Update node engine",
              state: "failed",
              attempts: 3,
              verdict: "reject",
              reasons: ["Build failed with exit 1"],
            },
          ],
        })
      );

      assert.ok(html.includes("task-01"));
      assert.ok(html.includes("merged"));
      assert.ok(html.includes("approve"));
      assert.ok(html.includes("All auditbox checks passed cleanly"));
      assert.ok(html.includes("file:src/index.js:12"));

      assert.ok(html.includes("task-02"));
      assert.ok(html.includes("failed"));
      assert.ok(html.includes("reject"));
    });

    it("renders empty message in plain words when tasks list is empty", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryTaskLedger, {
          tasks: [],
        })
      );
      assert.ok(html.includes("No tasks recorded."));
    });
  });

  describe("Requirement 38.8, 38.10, 38.11, 38.12: Artifact downloads", () => {
    const realisticArtifacts: ReliquaryArtifactItem[] = [
      {
        id: "patch",
        name: "all.patch",
        fileName: "all.patch",
        kind: "patch",
        size: 4096,
        sha256: "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
        downloadUrl: `/runs/run-art-01/relic/download?artifact=patch`,
      },
      {
        id: "spec",
        name: "spec bundle",
        fileName: "spec.json",
        kind: "spec",
        size: 8192,
        sha256: "222233334444555566667777888899990000aaaabbbbccccddddeeeeffff1111",
        downloadUrl: `/runs/run-art-01/relic/download?artifact=spec`,
      },
      {
        id: "report",
        name: "report",
        fileName: "report.md",
        kind: "report",
        size: 2048,
        sha256: "33334444555566667777888899990000aaaabbbbccccddddeeeeffff11112222",
        downloadUrl: `/runs/run-art-01/relic/download?artifact=report`,
      },
      {
        id: "events",
        name: "events.ndjson",
        fileName: "events.ndjson",
        kind: "events",
        size: 16384,
        sha256: "4444555566667777888899990000aaaabbbbccccddddeeeeffff111122223333",
        downloadUrl: `/runs/run-art-01/relic/download?artifact=events`,
      },
      {
        id: "certificate",
        name: "Death_Certificate",
        fileName: "death-certificate.json",
        kind: "certificate",
        size: 3072,
        sha256: "555566667777888899990000aaaabbbbccccddddeeeeffff1111222233334444",
        downloadUrl: `/runs/run-art-01/relic/download?artifact=certificate`,
      },
    ];

    it("offers downloads of all.patch, spec bundle, report, events.ndjson, and Death_Certificate with size and sha256", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-art-01",
          artifacts: realisticArtifacts,
        })
      );

      assert.ok(html.includes("all.patch"));
      assert.ok(html.includes("spec bundle"));
      assert.ok(html.includes("report"));
      assert.ok(html.includes("events.ndjson"));
      assert.ok(html.includes("Death_Certificate"));

      // sha256 label and size formatting
      assert.ok(html.includes("sha256:"));
      assert.ok(html.includes("KB") || html.includes("B"));
    });

    it("shows 'Packing the relics' while artifacts are assembled", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-art-packing",
          packing: true,
        })
      );

      assert.ok(html.includes("Packing the relics"));
    });

    it("offers only Death_Certificate and report when no task merged", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-no-merge",
          artifacts: realisticArtifacts,
          noTasksMerged: true,
        })
      );

      assert.ok(html.includes("Death_Certificate"));
      assert.ok(html.includes("report"));
      assert.ok(!html.includes("all.patch"));
      assert.ok(!html.includes("spec bundle"));
      assert.ok(html.includes("No task merged during this run"));
    });

    it("shows missing artifact message when file could not be built", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-missing-art",
          artifacts: [
            {
              id: "patch",
              name: "all.patch",
              fileName: "all.patch",
              kind: "patch",
              missing: true,
            },
          ],
        })
      );

      assert.ok(
        html.includes(
          "This file could not be built. The event log is still available."
        )
      );
    });

    it("formats byte sizes correctly", () => {
      assert.equal(formatByteSize(500), "500 B");
      assert.equal(formatByteSize(4096), "4.0 KB");
      assert.equal(formatByteSize(1048576), "1.00 MB");
    });
  });

  describe("Requirement 38.13, 38.14, 38.15 & 38.9: Special states & Handoff", () => {
    it("shows 'Removed by the owner' when run is hidden", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-hidden",
          hidden: true,
        })
      );

      assert.ok(html.includes("Removed by the owner"));
    });

    it("shows push target Fork, branch graveyard/<runId>, and 'The source repository is not touched.'", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-push",
          push: {
            enabled: true,
            targetFork: "graveyard-user/my-repo-fork",
          },
        })
      );

      assert.ok(html.includes("Fork Push Target: graveyard-user/my-repo-fork"));
      assert.ok(html.includes("graveyard/run-push"));
      assert.ok(html.includes("The source repository is not touched."));
    });

    it("drops unverified reading and states 'The model reading failed verification.'", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-report-fail",
          reportCheck: {
            passed: false,
            failed: true,
            reading: "Some unverified model narrative",
          },
        })
      );

      assert.ok(html.includes("The model reading failed verification."));
      assert.ok(!html.includes("Some unverified model narrative"));
    });

    it("displays Open in Kiro handoff instructions", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-kiro-handoff",
          owner: "test-owner",
          repo: "test-repo",
        })
      );

      assert.ok(html.includes("Open in Kiro Handoff Instructions"));
      assert.ok(html.includes("git apply -p1 all.patch"));
      assert.ok(html.includes(".kiro/specs/resurrection/test-owner-test-repo/"));
    });
  });

  describe("Reliquary download route handler", () => {
    const testRunId = "run-relic-dl-test";
    const testArtifactDir = path.join(
      os.tmpdir(),
      "git-graveyard-data",
      "runs",
      testRunId,
      "artifacts"
    );
    const testFileContent = "diff --git a/file b/file\n+test patch content";

    it("downloads real artifact file returning 200 with exact bytes and Content-Disposition", async () => {
      fs.mkdirSync(testArtifactDir, { recursive: true });
      fs.writeFileSync(path.join(testArtifactDir, "all.patch"), testFileContent, "utf8");

      try {
        const req = new Request(`http://test/runs/${testRunId}/relic/download?artifact=patch`);
        const res = await downloadRoute(req, { params: Promise.resolve({ runId: testRunId }) });

        assert.equal(res.status, 200);
        assert.ok(res.headers.get("Content-Disposition")?.includes('filename="all.patch"'));
        const body = await res.text();
        assert.equal(body, testFileContent);
      } finally {
        try {
          fs.rmSync(path.join(os.tmpdir(), "git-graveyard-data", "runs", testRunId), {
            recursive: true,
            force: true,
          });
        } catch {}
      }
    });

    it("returns 404 JSON when artifact is missing", async () => {
      const req = new Request("http://test/runs/run-missing-xyz/relic/download?artifact=patch");
      const res = await downloadRoute(req, { params: Promise.resolve({ runId: "run-missing-xyz" }) });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.deepEqual(data, { error: "Artifact not found" });
    });

    it("returns 400 JSON when artifact is unknown or attempts path traversal", async () => {
      // Unknown artifact
      const reqUnknown = new Request("http://test/runs/run-test/relic/download?artifact=unknown_art");
      const resUnknown = await downloadRoute(reqUnknown, { params: Promise.resolve({ runId: "run-test" }) });
      assert.equal(resUnknown.status, 400);

      // Path traversal artifact
      const reqTraversal = new Request("http://test/runs/run-test/relic/download?artifact=../../etc/passwd");
      const resTraversal = await downloadRoute(reqTraversal, { params: Promise.resolve({ runId: "run-test" }) });
      assert.equal(resTraversal.status, 400);

      // Invalid runId
      const reqBadRunId = new Request("http://test/runs/../relic/download?artifact=patch");
      const resBadRunId = await downloadRoute(reqBadRunId, { params: Promise.resolve({ runId: "../bad" }) });
      assert.equal(resBadRunId.status, 400);
    });
  });
});
