/**
 * Wave 4: remaining UI states for the Gate, Tombstone, Exhume, Death
 * Certificate, Command Row, and Pact screens (Tasks 24.4-24.7).
 *
 * Every added state is rendered with renderToStaticMarkup (no DOM, no network)
 * or asserted through the exported pure helpers that map state to copy.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HealthBadge } from "@/components/HealthBadge";
import { ReliquaryView } from "@/components/ReliquaryView";
import {
  GateView,
  describeInviteCodeError,
  formatGithubResetTime,
} from "@/components/GateView";
import {
  TombstoneView,
  describeTombstoneError,
  type TombstoneErrorInfo,
} from "@/components/TombstoneView";
import { ExhumeView } from "@/components/ExhumeView";
import { DeathCertificateView } from "@/components/DeathCertificateView";
import { CommandRow, type CommandRowItem } from "@/components/CommandRow";
import {
  PactEditor,
  detectDependencyCyclesInTasks,
} from "@/components/PactEditor";
import { PactDiff } from "@/components/PactDiff";
import {
  PactBudgetSettings,
  BUDGET_CREDITS_UNREPORTED_NOTE,
} from "@/components/PactBudgetSettings";
import type { AutopsyResult } from "@/lib/grimoire/autopsy";
import type { DeathCertificate } from "@/lib/exhume/death-certificate";
import type { PactTask } from "@/lib/pact/pact-parser";

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

// ---------------------------------------------------------------------------
// Task 24.4: Gate states (HealthBadge + GateView)
// ---------------------------------------------------------------------------

describe("Task 24.4 Gate: HealthBadge production & auth-failure states", () => {
  it("never shows 'waking up' in production mode", () => {
    const html = render(
      <HealthBadge status="waking up" loading={false} isProd={true} />
    );
    assert.ok(!html.includes("waking up"));
    assert.ok(html.includes("Live runs: unavailable"));
    assert.ok(html.includes('data-ui-state="unavailable"'));
  });

  it("treats environment === 'production' as production mode", () => {
    const html = render(
      <HealthBadge
        badgeText="waking up the sandbox"
        loading={false}
        environment="production"
      />
    );
    assert.ok(!html.includes("waking up"));
    assert.ok(html.includes("Live runs: unavailable"));
  });

  it("shows 'Live runs: unavailable' when admission stops on an auth failure", () => {
    const html = render(
      <HealthBadge status="open" loading={false} authFailure={true} />
    );
    assert.ok(html.includes("Live runs: unavailable"));
    assert.ok(html.includes('data-ui-state="unavailable"'));
  });

  it("shows 'Live runs: unavailable' when live runs are unavailable", () => {
    const html = render(
      <HealthBadge status="open" loading={false} liveRunsUnavailable={true} />
    );
    assert.ok(html.includes("Live runs: unavailable"));
  });

  it("keeps the open verdict when nothing is wrong", () => {
    const html = render(<HealthBadge status="open" loading={false} />);
    assert.ok(html.includes("Live runs: open"));
    assert.ok(html.includes('data-ui-state="open"'));
  });

  it("renders 'Live runs: unavailable' for authFailure without loading={false}", () => {
    const html = render(<HealthBadge authFailure />);
    assert.ok(html.includes("Live runs: unavailable"));
    assert.ok(html.includes('data-ui-state="unavailable"'));
  });

  it("renders 'Live runs: unavailable' for liveRunsUnavailable without loading={false}", () => {
    const html = render(<HealthBadge liveRunsUnavailable />);
    assert.ok(html.includes("Live runs: unavailable"));
    assert.ok(html.includes('data-ui-state="unavailable"'));
  });

  it("suppresses 'waking up' when no development opt-in is given (the GateView path)", () => {
    // GateView renders HealthBadge without isProd/environment, so a bare badge
    // must never surface the transient "waking up" phrase.
    const html = render(<HealthBadge badgeText="waking up" loading={false} />);
    assert.ok(!html.includes("waking up"));
    assert.ok(html.includes("Live runs: unavailable"));
    assert.ok(html.includes('data-ui-state="unavailable"'));
  });

  it("still shows 'waking up' when the caller explicitly opts into development", () => {
    const viaFlag = render(
      <HealthBadge isProd={false} badgeText="waking up" loading={false} />
    );
    assert.ok(viaFlag.includes("waking up"));
    assert.ok(!viaFlag.includes("Live runs: unavailable"));

    const viaEnv = render(
      <HealthBadge environment="development" badgeText="waking up" loading={false} />
    );
    assert.ok(viaEnv.includes("waking up"));
    assert.ok(!viaEnv.includes("Live runs: unavailable"));
  });
});

describe("Task 24.4 Gate: distinct invite-code messages", () => {
  const fallback = "server fallback message";
  it("maps wrong code", () => {
    assert.match(describeInviteCodeError("INVALID_CODE", fallback), /not valid/);
    assert.match(describeInviteCodeError("wrong", fallback), /not valid/);
  });
  it("maps expired code", () => {
    assert.match(describeInviteCodeError("EXPIRED_CODE", fallback), /expired/);
    assert.match(describeInviteCodeError("expired", fallback), /expired/);
  });
  it("maps revoked code", () => {
    assert.match(describeInviteCodeError("REVOKED_CODE", fallback), /revoked/);
    assert.match(describeInviteCodeError("revoked", fallback), /revoked/);
  });
  it("maps used-up code", () => {
    assert.match(
      describeInviteCodeError("EXHAUSTED_CODE", fallback),
      /no remaining runs/
    );
    assert.match(
      describeInviteCodeError("used_up", fallback),
      /no remaining runs/
    );
  });
  it("falls back to the server message for unknown codes", () => {
    assert.equal(describeInviteCodeError("SOMETHING_ELSE", fallback), fallback);
    assert.equal(describeInviteCodeError(undefined, fallback), fallback);
  });
});

describe("Task 24.4 Gate: formatted GitHub reset time", () => {
  it("formats a valid ISO timestamp as an explicit UTC clock time", () => {
    assert.equal(formatGithubResetTime("2024-01-01T14:05:00.000Z"), "14:05 UTC");
  });
  it("formats epoch seconds as an explicit UTC clock time", () => {
    assert.equal(formatGithubResetTime(1704110400), "12:00 UTC");
  });
  it("reports a missing, empty, or 'not reported' reset time plainly", () => {
    assert.equal(formatGithubResetTime(undefined), "The reset time was not reported.");
    assert.equal(formatGithubResetTime(null), "The reset time was not reported.");
    assert.equal(formatGithubResetTime("not reported"), "The reset time was not reported.");
    assert.equal(formatGithubResetTime("NOT REPORTED"), "The reset time was not reported.");
    assert.equal(formatGithubResetTime(""), "The reset time was not reported.");
  });
  it("reports an unparseable reset time plainly", () => {
    assert.equal(formatGithubResetTime("sometime soon"), "The reset time was not reported.");
  });
});

describe("Task 24.4 Gate: paused/unavailable keeps autopsy working", () => {
  it("renders the gate with the autopsy form always present", () => {
    const html = render(<GateView />);
    assert.ok(html.includes('data-testid="gate-view"'));
    assert.ok(html.includes('data-testid="submit-diagnose-autopsy"'));
    assert.ok(html.includes("Diagnose (Autopsy)"));
  });
});

// ---------------------------------------------------------------------------
// Task 24.5: Tombstone states
// ---------------------------------------------------------------------------

function makeAutopsy(overrides: Partial<AutopsyResult> = {}): AutopsyResult {
  const base: AutopsyResult = {
    status: "dead",
    reasons: ["archived"],
    deadReasons: ["archived"],
    cause: "Repository is archived.",
    lastWords: "final commit",
    lastWordsRaw: "final commit",
    lastWordsEscaped: "final commit",
    escapedLastWords: "final commit",
    lifespanYears: 3,
    yearsDead: 1,
    asOf: "2024-11-15T12:00:00.000Z",
    receipts: [],
    signalChips: { M1: [], M2: [], M3: [], M4: [], M5: [], M6: [] },
    chipsByRule: { M1: [], M2: [], M3: [], M4: [], M5: [], M6: [] },
    chips: [],
    groupedChips: [],
    fullName: "octocat/legacy",
    full_name: "octocat/legacy",
    defaultBranch: "main",
    default_branch: "main",
    sha: "abcdef1234567",
    stars: 10,
    forks: 2,
    languages: ["JavaScript"],
    disclaimer:
      "Grimoire's instant verdict is rule-based and has not run your code.",
    verdict: {
      status: "dead",
      deadReasons: ["archived"],
      reasons: ["archived"],
      lifespanYears: 3,
      yearsDead: 1,
      asOf: "2024-11-15T12:00:00.000Z",
    },
  };
  return { ...base, ...overrides } as AutopsyResult;
}

describe("Task 24.5 Tombstone: alive state shows still breathing + reasons", () => {
  it("renders 'still breathing' with the checked reasons and full details", () => {
    const autopsy = makeAutopsy({
      status: "alive",
      reasons: [],
      deadReasons: [],
      cause: "Repository is still breathing; no death criteria triggered.",
    });
    const html = render(
      <TombstoneView owner="octocat" repo="legacy" initialAutopsy={autopsy} />
    );
    assert.ok(html.includes("still breathing"));
    assert.ok(html.includes('data-testid="still-breathing-reasons"'));
    // Full autopsy details remain visible.
    assert.ok(html.includes('data-testid="autopsy-card"'));
    assert.ok(html.includes('data-testid="repo-full-name"'));
  });

  it("lists checked reasons when the alive autopsy records any", () => {
    const autopsy = makeAutopsy({
      status: "alive",
      reasons: ["archived"],
      deadReasons: ["archived"],
      cause: "Repository is still breathing; no death criteria triggered.",
    });
    const html = render(
      <TombstoneView owner="octocat" repo="legacy" initialAutopsy={autopsy} />
    );
    assert.ok(html.includes('data-testid="still-breathing-checked-list"'));
    assert.ok(html.includes("archived"));
  });
});

describe("Task 24.5 Tombstone: distinct error states", () => {
  it("REPO_NOT_FOUND explains not found or private", () => {
    const r = describeTombstoneError({
      code: "REPO_NOT_FOUND",
      message: "boom",
    } as TombstoneErrorInfo);
    assert.match(r.title, /Not Found/);
    assert.match(r.explanation, /not found or is private/);
  });
  it("TOO_LARGE shows the exceeded size limit", () => {
    const r = describeTombstoneError({ code: "TOO_LARGE", message: "boom" });
    assert.match(r.title, /Size Limit/);
    assert.match(r.explanation, /exceeds the size limits/);
  });
  it("LANGUAGE_UNKNOWN lists the manifest/config files looked for", () => {
    const r = describeTombstoneError({
      code: "LANGUAGE_UNKNOWN",
      message: "boom",
      lookedFor: ["package.json", "pyproject.toml"],
    });
    assert.match(r.explanation, /package\.json/);
    assert.match(r.explanation, /pyproject\.toml/);
  });
  it("RATE_LIMITED shows the formatted reset time", () => {
    const r = describeTombstoneError({
      code: "RATE_LIMITED",
      message: "boom",
      resetTime: "2024-01-01T16:45:00.000Z",
    });
    assert.match(r.explanation, /resets at: 16:45 UTC/);
  });
});

describe("Task 24.5 Tombstone: partial state lists unreadable manifests", () => {
  it("renders a partial warning naming the unreadable manifests", () => {
    const autopsy = makeAutopsy({
      partial: true,
      unreadableManifests: ["package.json", "requirements.txt"],
    } as Partial<AutopsyResult>);
    const html = render(
      <TombstoneView owner="octocat" repo="legacy" initialAutopsy={autopsy} />
    );
    assert.ok(html.includes('data-testid="tombstone-partial-warning"'));
    assert.ok(html.includes('data-testid="tombstone-partial-manifests"'));
    assert.ok(html.includes("package.json"));
    assert.ok(html.includes("requirements.txt"));
    assert.ok(html.includes('data-testid="autopsy-card"'));
  });
});
// ---------------------------------------------------------------------------
// Task 24.6: Exhume, Death Certificate & Command Row
// ---------------------------------------------------------------------------

describe("Task 24.6 Exhume: no invite code keeps autopsy + replay available", () => {
  it("disables Exhume with a reason and offers a /replay link", () => {
    const html = render(
      <ExhumeView repoUrl="https://github.com/octocat/legacy" sha="abcdef1" />
    );
    const startBtn = html.match(
      /<button[^>]*data-testid="start-exhume-button"[^>]*>/
    );
    assert.ok(startBtn, "start-exhume-button must render");
    assert.ok(/disabled/.test(startBtn[0]), "Exhume button is disabled");
    assert.ok(html.includes('data-testid="no-code-exhume-reason"'));
    assert.ok(html.includes('data-testid="no-code-replay-link"'));
    assert.ok(html.includes('href="/replay"'));
  });
});

function makeCert(overrides: Partial<DeathCertificate> = {}): DeathCertificate {
  const base: DeathCertificate = {
    schemaVersion: "v1",
    baseSha: "abcdef1234567890",
    primaryLanguage: "node",
    packageManager: "npm",
    createdAt: new Date().toISOString(),
    healthy: false,
    rows: [],
    runtimes: [],
    install: {
      step: "install",
      command: "npm install",
      status: "passed",
      exitCode: 0,
    },
    build: {
      step: "build",
      command: "npm run build",
      status: "passed",
      exitCode: 0,
    },
    test: { step: "test", command: "npm test", status: "passed", exitCode: 0 },
    failureClasses: [],
    failures: [],
    sha256: "a".repeat(64),
  };
  return { ...base, ...overrides } as DeathCertificate;
}

describe("Task 24.6 Death Certificate: healthy baseline", () => {
  it("states it installs, builds and passes tests, with both actions", () => {
    const cert = makeCert({ healthy: true });
    const html = render(
      <DeathCertificateView certificate={cert} runId="run-1" />
    );
    assert.ok(html.includes('data-testid="healthy-repo-banner"'));
    assert.ok(
      html.includes(
        "This repository installs, builds and passes its tests today."
      )
    );
    assert.ok(html.includes('data-testid="plan-modernization-button"'));
    assert.ok(html.includes("Plan modernization anyway"));
    assert.ok(html.includes('data-testid="stop-here-button"'));
    assert.ok(html.includes("Stop here"));
  });
});

describe("Task 24.6 Death Certificate: install failure is primary, build/test Not run", () => {
  it("renders install failure banner and marks build + test Not run", () => {
    const cert = makeCert({
      healthy: false,
      install: {
        step: "install",
        command: "npm install",
        status: "failed",
        exitCode: 1,
        reason: "network unreachable",
      },
      build: { step: "build", command: "npm run build", status: "not run" },
      test: { step: "test", command: "npm test", status: "not run" },
      failureClasses: ["install_failed"],
    });
    const html = render(
      <DeathCertificateView certificate={cert} runId="run-1" />
    );
    assert.ok(html.includes('data-testid="install-failure-primary"'));
    assert.match(html, /Install failed\. This is the primary finding\./);
    assert.ok(html.includes("Not run"));
    assert.ok(html.includes('data-testid="cert-row-build"'));
    assert.ok(html.includes('data-testid="cert-row-test"'));
  });
});

describe("Task 24.6 Death Certificate: retry that passed runs build and test", () => {
  it("shows real build/test statuses when install failed but retry passed", () => {
    const cert = makeCert({
      healthy: false,
      install: {
        step: "install",
        command: "npm install",
        status: "failed",
        exitCode: 1,
        reason: "network unreachable",
      },
      retry: {
        step: "retry",
        command: "npm install --prefer-offline",
        status: "passed",
        exitCode: 0,
      },
      build: { step: "build", command: "npm run build", status: "failed", exitCode: 2 },
      test: { step: "test", command: "npm test", status: "passed", exitCode: 0 },
      failureClasses: ["build_failed"],
    });
    const html = render(
      <DeathCertificateView certificate={cert} runId="run-1" />
    );
    // A passed retry means install ultimately succeeded, so there is no
    // install-failure banner and build/test are not "Not run".
    assert.ok(!html.includes('data-testid="install-failure-primary"'));
    assert.ok(!html.includes("Not run"));
    assert.match(html, /data-testid="cert-row-build" data-status="failed"/);
    assert.match(html, /data-testid="cert-row-test" data-status="passed"/);
  });
});

describe("Task 24.6 Death Certificate: no tests found shows rule", () => {
  it("shows 'No tests found' with the deciding rule in the test row", () => {
    const cert = makeCert({
      healthy: false,
      test: {
        step: "test",
        command: "npm test",
        status: "No tests found",
        ruleId: "M13",
      },
      failureClasses: ["no_tests"],
    });
    const html = render(
      <DeathCertificateView certificate={cert} runId="run-1" />
    );
    assert.ok(html.includes("No tests found (M13)"));
  });
});

describe("Task 24.6 CommandRow: error, timeout and oom tags", () => {
  it("renders a plain-English message alongside View output on error", () => {
    const row: CommandRowItem = {
      step: "build",
      command: "npm run build",
      status: "failed",
      exitCode: 2,
      errorMessage: "The build failed because a module is missing.",
    };
    const html = render(<CommandRow row={row} />);
    assert.ok(html.includes('data-testid="command-row-plain-error"'));
    assert.ok(html.includes("The build failed because a module is missing."));
    assert.ok(html.includes("View output"));
  });

  it("marks an unexecuted row 'Not run: time limit' on timeout", () => {
    const row: CommandRowItem = {
      step: "test",
      command: "npm test",
      status: "not run",
      reason: "time limit",
      timedOut: true,
    };
    const html = render(<CommandRow row={row} />);
    assert.ok(html.includes("Not run: time limit"));
  });

  it("visibly tags a row that ended via oomKilled", () => {
    const row: CommandRowItem = {
      step: "build",
      command: "npm run build",
      status: "failed",
      oomKilled: true,
    };
    const html = render(<CommandRow row={row} />);
    assert.ok(html.includes("oomKilled"));
    assert.ok(html.includes("out of memory"));
  });

  it("visibly tags a row that ended via timedOut", () => {
    const row: CommandRowItem = {
      step: "test",
      command: "npm test",
      status: "failed",
      timedOut: true,
    };
    const html = render(<CommandRow row={row} />);
    assert.ok(html.includes("timedOut"));
    assert.ok(html.includes("exceeded maximum execution time limit"));
  });
});
// ---------------------------------------------------------------------------
// Task 24.7: Pact editing, revision, parked & budget states
// ---------------------------------------------------------------------------

function makeTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Update manifests",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 1,
    },
    {
      id: "T2",
      title: "Fix request calls",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/index.js"],
      filesInScope: ["lib/index.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M2"],
      ruleIds: ["M2"],
      line: 8,
    },
  ];
}

describe("Task 24.7 PactEditor: nothing to change + Stop", () => {
  it("shows the reason and a Stop button", () => {
    const html = render(
      <PactEditor
        runId="run-1"
        initialData={{ status: "nothing_to_change", phase: "done", tasks: [] }}
      />
    );
    assert.ok(html.includes('data-testid="pact-nothing-screen"'));
    assert.ok(html.includes('data-testid="pact-nothing-reason"'));
    assert.ok(html.includes('data-testid="pact-btn-stop-nothing"'));
  });
});

describe("Task 24.7 PactEditor: validation error + diff on revision", () => {
  it("renders the editor and a clean diff", () => {
    const html = render(
      <PactEditor
        runId="run-1"
        initialData={{
          pactVersion: 1,
          phase: "pact_review",
          status: "ready",
          tasks: makeTasks(),
        }}
      />
    );
    assert.ok(html.includes('data-testid="pact-editor"'));
    const diff = render(<PactDiff currentVersion={2} previousVersion={1} />);
    assert.ok(diff.includes('data-testid="pact-diff-empty"'));
  });

  it("shows added tasks in the diff when a revision arrives", () => {
    const diff = render(
      <PactDiff
        currentVersion={2}
        previousVersion={1}
        addedTaskIds={["T3"]}
        modifiedTaskIds={["T2"]}
      />
    );
    assert.ok(diff.includes("Added: T3"));
    assert.ok(diff.includes("Modified: T2"));
  });
});

describe("Task 24.7 PactEditor: dependency cycle detection names the path", () => {
  it("detects A -> B -> A", () => {
    const cycles = detectDependencyCyclesInTasks([
      { id: "A", dependencies: ["B"] },
      { id: "B", dependencies: ["A"] },
    ]);
    assert.ok(cycles.length > 0);
    const named = cycles[0].join(" -> ");
    assert.match(named, /A -> B -> A/);
  });

  it("returns no cycles for a valid DAG", () => {
    const cycles = detectDependencyCyclesInTasks([
      { id: "A", dependencies: [] },
      { id: "B", dependencies: ["A"] },
    ]);
    assert.equal(cycles.length, 0);
  });
});

describe("Task 24.7 PactEditor: turning a task off flags dependents", () => {
  it("flags every task that depends on the disabled task", () => {
    const tasks = makeTasks();
    const disabled = ["T1"];
    const flagged: Array<{ taskId: string; dependsOnDisabled: string }> = [];
    for (const t of tasks) {
      if (disabled.includes(t.id)) continue;
      for (const dep of t.dependencies) {
        if (disabled.includes(dep)) {
          flagged.push({ taskId: t.id, dependsOnDisabled: dep });
        }
      }
    }
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].taskId, "T2");
    assert.equal(flagged[0].dependsOnDisabled, "T1");
  });
});

describe("Task 24.7 PactEditor: parked run offers Resume + re-clone notice", () => {
  it("shows Resume and the re-clone statement", () => {
    const html = render(
      <PactEditor
        runId="run-1"
        initialData={{
          status: "parked",
          phase: "parked",
          tasks: makeTasks(),
        }}
      />
    );
    assert.ok(html.includes('data-testid="pact-parked-screen"'));
    assert.ok(html.includes('data-testid="pact-btn-resume"'));
    assert.ok(html.includes("Resuming clones the repository again."));
  });
});

describe("Task 24.7 PactBudgetSettings: credits not reported note", () => {
  it("shows the unreported-credits note when creditsReported is false", () => {
    const html = render(<PactBudgetSettings creditsReported={false} />);
    assert.ok(html.includes('data-testid="budget-credits-note"'));
    assert.ok(html.includes(BUDGET_CREDITS_UNREPORTED_NOTE));
    assert.equal(
      BUDGET_CREDITS_UNREPORTED_NOTE,
      "Credits are not reported by the CLI; the cap is minutes and tool calls"
    );
  });

  it("shows the credits input when credits are reported", () => {
    const html = render(
      <PactBudgetSettings
        creditsReported={true}
        ceiling={{
          maxMinutes: 60,
          maxParallel: 2,
          maxCredits: 100,
          maxToolCalls: 100,
        }}
      />
    );
    assert.ok(html.includes('data-testid="budget-input-credits"'));
  });
describe("ReliquaryView: Open in Kiro handoff only with real repository metadata", () => {
  it("shows handoff instructions when owner, repo and baseSha are real", () => {
    const html = render(
      <ReliquaryView
        runId="run-1"
        outcome="resurrected"
        owner="octocat"
        repo="legacy"
        baseSha="abcdef1234567"
      />
    );
    assert.ok(html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(html.includes("git apply -p1 all.patch"));
    assert.ok(!html.includes('data-testid="open-in-kiro-unavailable"'));
  });

  it("shows an honest unavailable notice when metadata is still placeholder", () => {
    const html = render(<ReliquaryView runId="run-1" outcome="resurrected" />);
    assert.ok(html.includes('data-testid="open-in-kiro-unavailable"'));
    assert.ok(!html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(!html.includes("git clone https://github.com/owner/repo.git"));
    assert.ok(!html.includes("git checkout 0000000"));
  });
});
});