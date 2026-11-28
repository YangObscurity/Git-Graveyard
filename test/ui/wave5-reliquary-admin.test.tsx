/**
 * Wave 5: Reliquary, History, Replay, Built with Kiro and Admin page states
 * (Tasks 24.8-24.10). Every state is rendered with renderToStaticMarkup (no
 * DOM, no network) or asserted through the exported pure helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReliquaryView } from "@/components/ReliquaryView";
import type { BeforeAfterRowData } from "@/components/ReliquaryBeforeAfterTable";
import { HistoryList, type HistoryRunItem } from "@/components/HistoryList";
import { ReplayPlayer } from "@/components/ReplayPlayer";
import { BuiltWithKiroView } from "@/components/BuiltWithKiroView";
import { AdminDashboard } from "@/components/AdminDashboard";
import {
  KillSwitchModal,
  killSwitchAffectedSummary,
  killSwitchConfirmationPhrase,
} from "@/components/KillSwitchModal";
import { routes } from "@/lib/ui/run-routes";
import type { EventEnvelope } from "@/lib/events/types";
import type { EvidenceBundle, KiroEvidenceDoc } from "@/lib/evidence/evidence-service";

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

// ---------------------------------------------------------------------------
// Task 24.8: Reliquary states
// ---------------------------------------------------------------------------

const partialRows: BeforeAfterRowData[] = [
  { label: "Build", key: "build", before: { status: "failed" }, after: { status: "passed" } },
  {
    label: "Tests",
    key: "tests_repo",
    before: { status: "failed" },
    after: { status: "failed" },
  },
];

describe("Task 24.8 ReliquaryView: partial outcome lists what works and what does not", () => {
  const html = render(
    <ReliquaryView runId="run-partial" outcome="partial" beforeAfterRows={partialRows} />
  );

  it("renders the partial breakdown with both lists", () => {
    assert.ok(html.includes('data-testid="partial-breakdown"'));
    assert.ok(html.includes('data-testid="partial-works-list"'));
    assert.ok(html.includes('data-testid="partial-does-not-work-list"'));
    assert.ok(html.includes("Build passed"));
    assert.ok(html.includes("Tests failed"));
  });
});

describe("Task 24.8 ReliquaryView: no task merged suppresses the diff", () => {
  const html = render(
    <ReliquaryView
      runId="run-no-merge"
      outcome="not_resurrected"
      diff="diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new"
      tasks={[{ id: "T1", title: "Nothing merged", state: "pending", attempts: 1 }]}
      artifacts={[
        { id: "patch", name: "Patch", fileName: "all.patch", kind: "patch" },
        { id: "certificate", name: "Death Certificate", fileName: "certificate.json", kind: "certificate" },
        { id: "report", name: "Run report", fileName: "report.md", kind: "report" },
      ]}
    />
  );

  it("states there is no diff and offers only the certificate and report", () => {
    assert.ok(html.includes('data-testid="reliquary-no-tasks-merged"'));
    assert.ok(html.includes("There is no diff"));
    assert.ok(html.includes('data-testid="reliquary-no-diff"'));
    assert.ok(html.includes('data-testid="artifact-card-certificate"'));
    assert.ok(html.includes('data-testid="artifact-card-report"'));
    assert.ok(!html.includes('data-testid="artifact-card-patch"'));
    assert.ok(!html.includes('data-testid="reliquary-diff-viewer"'));
  });
});

describe("Task 24.8 ReliquaryView: missing deliverable, hidden run, push flag and failed reading", () => {
  it("explains a missing deliverable and points at the event log", () => {
    const html = render(
      <ReliquaryView
        runId="run-missing"
        outcome="resurrected"
        artifacts={[
          { id: "report", name: "Run report", fileName: "report.md", kind: "report", missing: true },
        ]}
      />
    );
    assert.ok(
      html.includes("This file could not be built. The event log is still available.")
    );
  });

  it("renders 'Removed by the owner' when the run is hidden", () => {
    const html = render(<ReliquaryView runId="run-hidden" outcome="resurrected" hidden />);
    assert.ok(html.includes("Removed by the owner"));
    assert.ok(html.includes('data-testid="reliquary-hidden"'));
  });

  it("names the fork and branch and states the source repository is not touched", () => {
    const html = render(
      <ReliquaryView
        runId="run-push"
        outcome="resurrected"
        push={{ enabled: true, targetFork: "owner/fork", branch: "graveyard/run-push" }}
      />
    );
    assert.ok(html.includes('data-testid="reliquary-push-notice"'));
    assert.ok(html.includes("owner/fork"));
    assert.ok(html.includes("graveyard/run-push"));
    assert.ok(html.includes("The source repository is not touched."));
  });

  it("states plainly that the model reading failed verification", () => {
    const html = render(
      <ReliquaryView
        runId="run-report-check"
        outcome="resurrected"
        reportCheck={{ passed: false, failed: true, reading: null }}
      />
    );
    assert.ok(html.includes('data-testid="reliquary-report-check-failed"'));
    assert.ok(html.includes("The model reading failed verification."));
  });
});

// ---------------------------------------------------------------------------
// Task 24.9: History and Replay states
// ---------------------------------------------------------------------------

describe("Task 24.9 HistoryList: loading, error, empty and hidden states", () => {
  it("shows a loading state before any run is loaded", () => {
    const html = render(<HistoryList />);
    assert.ok(html.includes('data-testid="history-loading"'));
    assert.ok(html.includes('data-ui-state="loading"'));
  });

  it("shows a plain error message when the history cannot be read", () => {
    const html = render(<HistoryList initialRuns={[]} initialError="Unable to load recorded runs." />);
    assert.ok(html.includes('data-testid="history-error"'));
    assert.ok(html.includes("Unable to load recorded runs."));
  });

  it("shows the empty state when nothing has been published", () => {
    const html = render(<HistoryList initialRuns={[]} />);
    assert.ok(html.includes('data-testid="history-empty"'));
    assert.ok(html.includes("No recorded runs have been published yet"));
  });

  it("shows 'Removed by the owner' for a hidden run", () => {
    const html = render(
      <HistoryList
        initialRuns={[
          {
            runId: "run-hidden-row",
            repository: "owner/hidden",
            isPublished: true,
            isRemoved: true,
            outcome: "resurrected",
          },
        ]}
      />
    );
    assert.ok(html.includes("Removed by the owner"));
    assert.ok(html.includes('data-ui-state="hidden"'));
  });
});

describe("Task 24.9 HistoryList: every row carries the recorded facts", () => {
  const run: HistoryRunItem = {
    runId: "run-facts",
    repository: "owner/repo",
    sha: "abcdef1234567",
    isPublished: true,
    outcome: "resurrected",
    createdAt: 1700000000000,
    startedAt: 1700000000000,
    endedAt: 1700000065000,
    rolesUsed: ["planner", "builder"],
    engineVersion: "7f5f8996",
    mode: "live",
    beforeBuildStatus: "failed",
    afterBuildStatus: "passed",
  };
  const html = render(<HistoryList initialRuns={[run]} />);

  it("renders repository, short SHA, date, outcome, wall time and label", () => {
    assert.ok(html.includes('data-testid="history-run-repo"'));
    assert.ok(html.includes("owner/repo"));
    assert.ok(html.includes("@abcdef1"));
    assert.ok(html.includes('data-testid="history-run-date"'));
    assert.ok(html.includes("Resurrected"));
    assert.ok(html.includes('data-testid="history-run-duration"'));
    assert.ok(html.includes("1m 5s"));
    assert.ok(html.includes("Recorded live run"));
  });

  it("renders roles, build status, mode and engine version", () => {
    assert.ok(html.includes('data-testid="history-run-roles"'));
    assert.ok(html.includes("planner, builder"));
    assert.ok(html.includes('data-testid="history-run-build-status"'));
    assert.ok(html.includes("before failed -&gt; after passed"));
    assert.ok(html.includes('data-testid="history-run-mode"'));
    assert.ok(html.includes('data-testid="history-run-engine"'));
    assert.ok(html.includes("7f5f8996"));
  });
});

function ev(seq: number, ts: number, kind: string, data: Record<string, unknown> = {}): EventEnvelope {
  return {
    runId: "run-replay",
    seq,
    ts,
    kind: kind as EventEnvelope["kind"],
    actor: "system",
    data: { refs: [], ...data },
  };
}

describe("Task 24.9 ReplayPlayer: clocks, shortened waits, redaction, ended and killed states", () => {
  it("shows both replay time and original time", () => {
    const html = render(
      <ReplayPlayer runId="run-clocks" initialEvents={[ev(1, 1700000001000, "skeleton.tool_call")]} />
    );
    assert.ok(html.includes('data-testid="replay-time"'));
    assert.ok(html.includes("Replay time:"));
    assert.ok(html.includes('data-testid="original-time"'));
    assert.ok(html.includes("Original time:"));
  });

  it("labels every shortened wait interval", () => {
    const html = render(
      <ReplayPlayer
        runId="run-wait"
        initialEvents={[ev(1, 1700000000000, "skeleton.tool_call"), ev(2, 1700000060000, "skeleton.tool_call")]}
      />
    );
    assert.ok(html.includes('data-testid="shortened-wait-label"'));
    assert.ok(html.includes("Shortened wait"));
  });

  it("renders 'Redacted by the owner' at an admin.redaction event", () => {
    const html = render(
      <ReplayPlayer
        runId="run-redact"
        initialEvents={[ev(1, 1700000001000, "skeleton.tool_call"), ev(2, 1700000002000, "admin.redaction")]}
      />
    );
    assert.ok(html.includes('data-testid="redaction-label"'));
    assert.ok(html.includes("Redacted by the owner"));
  });

  it("shows the ended state with a link to the Reliquary", () => {
    const html = render(
      <ReplayPlayer
        runId="run-ended"
        initialEvents={[ev(1, 1700000001000, "skeleton.tool_call"), ev(2, 1700000002000, "run.done")]}
      />
    );
    assert.ok(html.includes('data-testid="replay-ended-state"'));
    assert.ok(html.includes("Run ended"));
    assert.ok(html.includes('data-testid="replay-reliquary-link"'));
    assert.ok(html.includes("/runs/run-ended/relic"));
  });

  it("labels the last stored event as the point where a killed run was stopped", () => {
    const html = render(
      <ReplayPlayer
        runId="run-killed"
        initialEvents={[ev(1, 1700000001000, "skeleton.tool_call"), ev(2, 1700000002000, "admin.kill")]}
      />
    );
    assert.ok(html.includes('data-testid="run-stopped-label"'));
    assert.ok(html.includes("Point where the run was stopped"));
  });

  it("renders a plain-English error state when the event log cannot be read", () => {
    const html = render(
      <ReplayPlayer runId="run-broken" initialEvents={[]} initialError="Unable to read event log." />
    );
    assert.ok(html.includes('data-testid="replay-error"'));
    assert.ok(html.includes("Unable to read event log."));
  });
});
// ---------------------------------------------------------------------------
// Task 24.10: Built with Kiro page
// ---------------------------------------------------------------------------

const emptyBuild: KiroEvidenceDoc = {
  schemaVersion: "v1",
  generatedFromSha: "",
  specs: [],
  steering: [],
  hooks: [],
  agents: [],
  commitLinks: [],
};

describe("Task 24.10 BuiltWithKiroView: evidence and 'None found' fallbacks", () => {
  it("renders the evidence sections when the bundle carries them", () => {
    const bundle: EvidenceBundle = {
      build: {
        ...emptyBuild,
        generatedFromSha: "abc1234",
        specs: [{ path: ".kiro/specs/resurrection/design.md", name: "resurrection" }],
        agents: [
          {
            path: "lib/agents/templates/planner.md",
            name: "planner",
            description: "Planner Skeleton",
            tools: ["read"],
            excludedTools: ["shell"],
            permissions: [],
          },
        ],
      },
      recentRuns: [
        {
          runId: "run-1",
          repository: "owner/repo",
          outcome: "resurrected",
          date: "2026-01-01T00:00:00.000Z",
          skeletons: [
            {
              role: "builder",
              agentName: "soul-stitcher",
              modelId: "claude-sonnet-5.5",
              kiroCliVersion: "3.1.0",
              sessionId: "sess-1",
              timestamp: 1700000000000,
            },
          ],
        },
      ],
    };
    const html = render(<BuiltWithKiroView bundle={bundle} />);
    assert.ok(html.includes('data-testid="built-with-kiro-view"'));
    assert.ok(html.includes('data-testid="built-with-kiro-evidence"'));
    assert.ok(html.includes("resurrection"));
    assert.ok(html.includes("soul-stitcher"));
  });

  it("shows 'None found' for every section whose source file is missing", () => {
    const html = render(<BuiltWithKiroView bundle={{ build: emptyBuild, recentRuns: [] }} />);
    assert.ok(html.includes("None found"));
    assert.ok(html.includes('data-testid="built-with-kiro-missing-sources"'));
  });
});

// ---------------------------------------------------------------------------
// Task 24.10: Admin page states
// ---------------------------------------------------------------------------

describe("Task 24.10 AdminDashboard: unauthenticated renders only the sign-in state", () => {
  const html = render(<AdminDashboard authenticated={false} />);

  it("shows the sign-in state and nothing else", () => {
    assert.ok(html.includes('data-testid="admin-signin"'));
    assert.ok(html.includes("Admin sign-in"));
    assert.ok(!html.includes('data-testid="admin-invite-codes"'));
    assert.ok(!html.includes('data-testid="admin-runs"'));
    assert.ok(!html.includes('data-testid="admin-kill-switch"'));
    assert.ok(!html.includes('data-testid="admin-production-mode"'));
    assert.ok(!html.includes("Removed by the owner"));
  });
});
describe("Task 24.10 AdminDashboard: authenticated states", () => {
  it("shows the empty invite-code state and the production lock (Req 44.14)", () => {
    const html = render(
      <AdminDashboard
        authenticated
        actor={{ id: "owner", role: "owner" }}
        inviteCodes={[]}
        runs={[]}
        promotionAudit={{ present: false, verified: false }}
      />
    );
    assert.ok(html.includes('data-testid="admin-dashboard"'));
    assert.ok(html.includes('data-testid="admin-invite-empty"'));
    assert.ok(html.includes("No invite codes have been created yet."));
    assert.ok(html.includes('data-testid="admin-production-lock"'));
    assert.ok(html.includes("Production mode is locked"));
    assert.ok(html.includes("signed pre-promotion audit record"));
    assert.ok(!html.includes('data-testid="admin-production-unlocked"'));
  });

  it("unlocks production mode once a signed pre-promotion audit record exists", () => {
    const html = render(
      <AdminDashboard
        authenticated
        actor={{ id: "owner", role: "owner" }}
        inviteCodes={[]}
        runs={[]}
        promotionAudit={{ present: true, verified: true, actor: "owner", signedAt: 1700000000000 }}
      />
    );
    assert.ok(html.includes('data-testid="admin-production-unlocked"'));
    assert.ok(!html.includes('data-testid="admin-production-lock"'));
    const toggle = html.match(/<button[^>]*data-testid="admin-production-toggle"[^>]*>/);
    assert.ok(toggle, "production toggle must render");
    assert.ok(!/\sdisabled(=|\s|>)/.test(toggle[0]), "production toggle must be enabled");
  });

  it("directs the Owner to the Kiro portal when probe P15 is unavailable", () => {
    const html = render(
      <AdminDashboard
        authenticated
        actor={{ id: "owner", role: "owner" }}
        inviteCodes={[]}
        runs={[]}
        probeP15={{ getUsageAdvertised: false }}
      />
    );
    assert.ok(html.includes('data-testid="admin-p15-credit-note"'));
    assert.ok(html.includes("_kiro/account/getUsage"));
    assert.ok(html.includes("Kiro portal"));
  });

  it("gates History publish behind an explicit review confirmation and offers hide", () => {
    const html = render(
      <AdminDashboard
        authenticated
        actor={{ id: "owner", role: "owner" }}
        inviteCodes={[{ codeHash: "abc12345", allowedRunCount: 3, usedRunCount: 1 }]}
        runs={[
          {
            runId: "run-done",
            repository: "owner/repo",
            phase: "done",
            outcome: "resurrected",
            isPublished: false,
            isRemoved: false,
          },
        ]}
      />
    );
    assert.ok(html.includes('data-testid="admin-invite-code-item"'));
    assert.ok(html.includes('data-testid="admin-publish-gate"'));
    assert.ok(html.includes("explicit Admin review and redaction confirmation"));
    const publish = html.match(/<button[^>]*data-testid="admin-publish-run-done"[^>]*>/);
    assert.ok(publish, "publish button must render");
    assert.ok(/\sdisabled(=|\s|>)/.test(publish[0]), "publish must be gated behind review");
    assert.ok(html.includes('data-testid="admin-redact-run-done"'));
    assert.ok(html.includes('data-testid="admin-hide-run-done"'));
    assert.ok(html.includes("Removed by the owner"));
  });
});
// ---------------------------------------------------------------------------
// Task 24.10: Kill switch modal
// ---------------------------------------------------------------------------

describe("Task 24.10 KillSwitchModal: three levels with typed confirmation counts", () => {
  const html = render(<KillSwitchModal open activeRunCount={2} queuedRunCount={3} />);

  it("renders all three levels with their blast radius", () => {
    assert.ok(html.includes('data-testid="kill-switch-level-pause_new_runs"'));
    assert.ok(html.includes('data-testid="kill-switch-level-stop_gracefully"'));
    assert.ok(html.includes('data-testid="kill-switch-level-hard_kill"'));
    assert.ok(html.includes("New runs are not admitted"));
    assert.ok(html.includes("end at their next tool boundary"));
    assert.ok(html.includes("worktrees are kept"));
    assert.ok(html.includes("terminated immediately"));
    assert.ok(html.includes("Affects 3 queued runs"));
    assert.ok(html.includes("Affects 2 running runs; 3 queued runs stay queued."));
    assert.ok(html.includes("Affects 2 active and 3 queued runs."));
  });

  it("requires the exact typed phrase and disables confirmation until it matches", () => {
    assert.ok(html.includes('data-testid="kill-switch-confirmation-input"'));
    const confirm = html.match(/<button[^>]*data-testid="kill-switch-confirm"[^>]*>/);
    assert.ok(confirm, "confirm button must render");
    assert.ok(/disabled/.test(confirm[0]), "confirm must be disabled until the phrase is typed");
    assert.equal(killSwitchConfirmationPhrase("pause_new_runs", 2, 3), "PAUSE 3 QUEUED");
    assert.equal(killSwitchConfirmationPhrase("stop_gracefully", 2, 3), "STOP 2 RUNNING");
    assert.equal(killSwitchConfirmationPhrase("hard_kill", 2, 3), "KILL 2 ACTIVE 3 QUEUED");
    assert.match(killSwitchAffectedSummary("hard_kill", 1, 1), /1 active and 1 queued run/);
  });

  it("renders nothing when closed", () => {
    assert.equal(render(<KillSwitchModal open={false} />), "");
  });
});

// ---------------------------------------------------------------------------
// Task 24.10: route helpers
// ---------------------------------------------------------------------------

describe("Task 24.10 run-routes: Built with Kiro and Admin helpers", () => {
  it("returns the real page paths", () => {
    assert.equal(routes.builtWithKiro(), "/built-with-kiro");
    assert.equal(routes.admin(), "/admin");
  });
});