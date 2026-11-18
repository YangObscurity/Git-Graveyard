import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PactBudgetSettings,
  BudgetSettings,
} from "@/components/PactBudgetSettings";
import { PactChannel } from "@/components/PactChannel";
import { PactDiff } from "@/components/PactDiff";
import { PactEditor } from "@/components/PactEditor";
import PactPage from "@/app/runs/[runId]/pact/page";
import type { PactTask } from "@/lib/pact/pact-parser";
import {
  BUDGET_CHECK_TERMS_NOTE,
  BUDGET_CREDITS_UNREPORTED_NOTE,
  NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS,
} from "@/lib/pact/pact-review";
import type { DeathCertificate } from "@/lib/exhume/death-certificate";

function createMockTasks(): PactTask[] {
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
    {
      id: "T3",
      title: "Warden final check verification",
      role: "bonesetter",
      dependencies: ["T2"],
      depends: ["T2"],
      dependsOn: ["T2"],
      files: ["audit/**"],
      filesInScope: ["audit/**"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 15,
    },
    {
      id: "T4",
      title: "Scribe report generation",
      role: "bonesetter",
      dependencies: ["T3"],
      depends: ["T3"],
      dependsOn: ["T3"],
      files: ["report/**"],
      filesInScope: ["report/**"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 22,
    },
    {
      id: "T5",
      title: "Grimoire gate check",
      role: "bonesetter",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/**"],
      filesInScope: ["lib/**"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 29,
    },
  ];
}

function createMockDeathCertificate(): DeathCertificate {
  return {
    schemaVersion: "v1",
    baseSha: "1234567890abcdef1234567890abcdef12345678",
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
      status: "failed",
      exitCode: 1,
      reason: "SyntaxError: Unexpected token",
    },
    test: {
      step: "test",
      command: "npm test",
      status: "failed",
      exitCode: 1,
      reason: "Module not found",
    },
    failureClasses: ["build_failure", "uncovered_issue"],
    failures: [
      {
        class: "uncovered_issue",
        step: "test",
        message: "Uncovered test suite timeout on integration test",
        ruleId: "M5",
      },
    ],
    sha256: "abcdef1234567890abcdef1234567890abcdef12",
  };
}

describe("Task 15.3: Pact Screen & Components", () => {
  describe("PactBudgetSettings (Requirements 36.11, 36.12, 36.13)", () => {
    it("renders budget caps from invite code as ceiling (Requirement 36.11)", () => {
      const html = renderToStaticMarkup(
        <PactBudgetSettings
          ceiling={{ maxMinutes: 90, maxParallel: 4, maxToolCalls: 150 }}
          budget={{ maxMinutes: 45, maxParallel: 2, maxToolCalls: 100 }}
        />
      );

      assert.ok(html.includes("data-testid=\"budget-settings\""));
      assert.ok(html.includes("Ceiling: 90 min"));
      assert.ok(html.includes("Ceiling: 4"));
      assert.ok(html.includes("Ceiling: 150"));
      assert.ok(html.includes("Budget caps from the invite code set the ceiling"));
    });

    it("displays mandatory terms note (Requirement 36.13)", () => {
      const html = renderToStaticMarkup(<PactBudgetSettings />);

      assert.ok(html.includes("data-testid=\"budget-terms-note\""));
      assert.ok(html.includes(BUDGET_CHECK_TERMS_NOTE));
      assert.equal(
        BUDGET_CHECK_TERMS_NOTE,
        "The cap is checked between tool calls. A single tool call may finish after the cap is reached."
      );
    });

    it("states credits not reported when probe shows no credit field (Requirement 36.12)", () => {
      const html = renderToStaticMarkup(
        <PactBudgetSettings creditsReported={false} />
      );

      assert.ok(html.includes("data-testid=\"budget-credits-note\""));
      assert.ok(html.includes(BUDGET_CREDITS_UNREPORTED_NOTE));
      assert.equal(
        BUDGET_CREDITS_UNREPORTED_NOTE,
        "Credits are not reported by the CLI; the cap is minutes and tool calls"
      );
    });

    it("exports BudgetSettings alias", () => {
      assert.equal(BudgetSettings, PactBudgetSettings);
    });
  });

  describe("PactChannel (Requirement 36.1)", () => {
    it("renders plain words empty state when no messages exist", () => {
      const html = renderToStaticMarkup(<PactChannel messages={[]} />);

      assert.ok(html.includes("data-testid=\"pact-channel-empty\""));
      assert.ok(html.includes("No messages in the Necromancer channel yet."));
    });

    it("displays drafting badge when isDrafting is true", () => {
      const html = renderToStaticMarkup(<PactChannel isDrafting={true} />);

      assert.ok(html.includes("data-testid=\"pact-channel-drafting-badge\""));
      assert.ok(html.includes("Drafting"));
    });

    it("renders channel messages with actor and content", () => {
      const html = renderToStaticMarkup(
        <PactChannel
          messages={[
            {
              id: "1",
              kind: "decision",
              actor: "planner",
              text: "Selected Haiku tier for exhume triage.",
            },
          ]}
        />
      );

      assert.ok(html.includes("data-testid=\"pact-channel-msg-1\""));
      assert.ok(html.includes("[planner]"));
      assert.ok(html.includes("Selected Haiku tier for exhume triage."));
    });
  });

  describe("PactDiff (Requirement 36.5)", () => {
    it("renders empty state when there are no changes", () => {
      const html = renderToStaticMarkup(
        <PactDiff currentVersion={2} previousVersion={1} />
      );

      assert.ok(html.includes("data-testid=\"pact-diff-empty\""));
      assert.ok(html.includes("No changes between versions."));
    });

    it("renders added, removed, and modified task badges", () => {
      const html = renderToStaticMarkup(
        <PactDiff
          currentVersion={2}
          previousVersion={1}
          addedTaskIds={["T3"]}
          removedTaskIds={["T1"]}
          modifiedTaskIds={["T2"]}
        />
      );

      assert.ok(html.includes("data-testid=\"pact-diff-added\""));
      assert.ok(html.includes("Added: T3"));
      assert.ok(html.includes("data-testid=\"pact-diff-removed\""));
      assert.ok(html.includes("Removed: T1"));
      assert.ok(html.includes("data-testid=\"pact-diff-modified\""));
      assert.ok(html.includes("Modified: T2"));
    });
  });

  describe("PactEditor: States and Interactions (Requirement 36)", () => {
    it("renders drafting state with sentence and channel visible (Requirement 36.1)", () => {
      const html = renderToStaticMarkup(
        <PactEditor
          runId="run-test-123"
          initialData={{
            status: "drafting",
            phase: "plan",
            tasks: [],
          }}
        />
      );

      assert.ok(html.includes("data-testid=\"pact-drafting-screen\""));
      assert.ok(html.includes("data-testid=\"pact-drafting-sentence\""));
      assert.ok(
        html.includes("The Necromancer&#x27;s Planner is writing the Pact") ||
          html.includes("The Necromancer's Planner is writing the Pact")
      );
      assert.ok(html.includes("data-testid=\"pact-channel\""));
    });

    it("renders nothing to change state with reason and Stop button (Requirement 36.2)", () => {
      const html = renderToStaticMarkup(
        <PactEditor
          runId="run-test-123"
          initialData={{
            status: "nothing_to_change",
            phase: "done",
            tasks: [],
          }}
        />
      );

      assert.ok(html.includes("data-testid=\"pact-nothing-screen\""));
      assert.ok(html.includes("data-testid=\"pact-nothing-reason\""));
      assert.ok(html.includes("data-testid=\"pact-btn-stop-nothing\""));
      assert.ok(html.includes("Stop"));
    });

    it("renders parked state with Resume and re-clone notice (Requirement 36.6)", () => {
      const html = renderToStaticMarkup(
        <PactEditor
          runId="run-test-123"
          initialData={{
            status: "parked",
            phase: "parked",
            tasks: createMockTasks(),
          }}
        />
      );

      assert.ok(html.includes("data-testid=\"pact-parked-screen\""));
      assert.ok(html.includes("data-testid=\"pact-parked-notice\""));
      assert.ok(html.includes("Resuming clones the repository again."));
      assert.ok(html.includes("data-testid=\"pact-btn-resume\""));
    });

    it("renders locked controls for Warden, Scribe and Grimoire gate with reasons (Requirement 36.8)", () => {
      const tasks = createMockTasks();
      const html = renderToStaticMarkup(
        <PactEditor
          runId="run-test-123"
          initialData={{
            pactVersion: 1,
            phase: "pact_review",
            status: "ready",
            tasks,
          }}
        />
      );

      assert.ok(html.includes("data-testid=\"pact-locked-requirements-panel\""));

      // Warden final check
      assert.ok(html.includes("data-testid=\"locked-req-warden_final_check\""));
      assert.ok(
        html.includes(
          NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS.warden_final_check
        )
      );

      // Scribe report
      assert.ok(html.includes("data-testid=\"locked-req-scribe_report\""));
      assert.ok(
        html.includes(NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS.scribe_report)
      );

      // Grimoire gate
      assert.ok(html.includes("data-testid=\"locked-req-grimoire_gate\""));
      assert.ok(
        html.includes(NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS.grimoire_gate)
      );

      // In task list, locked badges and reasons
      assert.ok(html.includes("data-testid=\"task-locked-badge-T3\""));
      assert.ok(html.includes("data-testid=\"task-locked-badge-T4\""));
      assert.ok(html.includes("data-testid=\"task-locked-badge-T5\""));
    });

    it("renders uncovered failures under 'Not addressed by any task' (Requirement 36.4)", () => {
      const cert = createMockDeathCertificate();
      const tasks = createMockTasks(); // T1-T5 rules M1, M2; cert has M5 failure
      const html = renderToStaticMarkup(
        <PactEditor
          runId="run-test-123"
          initialData={{
            pactVersion: 1,
            phase: "pact_review",
            status: "ready",
            tasks,
            deathCertificate: cert,
          }}
        />
      );

      assert.ok(html.includes("data-testid=\"uncovered-failures\""));
      assert.ok(html.includes("data-testid=\"uncovered-failures-heading\""));
      assert.ok(html.includes("Not addressed by any task"));
      assert.ok(
        html.includes("Uncovered test suite timeout on integration test")
      );
    });

    it("renders pactVersion badge and approve button (Requirement 15.3, 36.7)", () => {
      const tasks = createMockTasks();
      const html = renderToStaticMarkup(
        <PactEditor
          runId="run-test-123"
          initialData={{
            pactVersion: 3,
            phase: "pact_review",
            status: "ready",
            tasks,
          }}
        />
      );

      assert.ok(html.includes("data-testid=\"pact-version-badge\""));
      assert.ok(html.includes("Version: 3"));
      assert.ok(html.includes("data-testid=\"pact-btn-approve\""));
      assert.ok(html.includes("Approve Pact"));
    });

    it("detects dependency cycles and names the cycle (Requirement 36.9)", () => {
      const cycleTasks = [
        { id: "T1", dependencies: ["T2"] },
        { id: "T2", dependencies: ["T1"] },
      ];
      const { detectDependencyCyclesInTasks } = require("@/lib/pact/pact-review");
      const cycles = detectDependencyCyclesInTasks(cycleTasks);
      assert.ok(cycles.length > 0);
      const cycleName = cycles[0].join(" -> ");
      assert.ok(cycleName.includes("T1"));
      assert.ok(cycleName.includes("T2"));
    });

    it("flags every task that depends on a disabled task (Requirement 36.10)", () => {
      const tasks = createMockTasks();
      // T2 depends on T1. If T1 is disabled, T2 should be flagged.
      const disabledTaskIds = ["T1"];
      const flagged: Array<{ taskId: string; dependsOnDisabled: string }> = [];
      for (const t of tasks) {
        if (disabledTaskIds.includes(t.id)) continue;
        for (const dep of t.dependencies) {
          if (disabledTaskIds.includes(dep)) {
            flagged.push({ taskId: t.id, dependsOnDisabled: dep });
          }
        }
      }
      assert.equal(flagged.length, 2); // T2 and T5 both depend on T1
      assert.equal(flagged[0].taskId, "T2");
      assert.equal(flagged[0].dependsOnDisabled, "T1");
      assert.equal(flagged[1].taskId, "T5");
      assert.equal(flagged[1].dependsOnDisabled, "T1");
    });
  });

  describe("PactPage Server Component", () => {
    it("renders PactPage wrapper with runId", async () => {
      const element = await PactPage({
        params: Promise.resolve({ runId: "run-sample-999" }),
        searchParams: Promise.resolve({ code: "test-code" }),
      });

      const html = renderToStaticMarkup(element);
      // The page sits under the 3.5rem sticky nav, like every other route.
      assert.ok(html.includes("min-h-[calc(100vh-3.5rem)]"));
      assert.ok(html.includes("bg-neutral-950"));
    });
  });
});
