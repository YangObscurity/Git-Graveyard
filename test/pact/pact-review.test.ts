// Task 12.3 unit tests: Pact review step - edit, approve and budget checks
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.8, 13.10, 36.8, 36.9, 36.10, 36.11, 36.12, 36.13

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PactTask } from "../../lib/pact/pact-parser";
import {
  BUDGET_CHECK_TERMS_NOTE,
  BUDGET_CREDITS_UNREPORTED_NOTE,
  checkBudgetUsage,
  checkPactBudget,
  formatBudgetTerms,
  isNonRemovableTask,
  isPactApproved,
  NON_REMOVABLE_REQUIREMENTS,
  recordApproval,
  recordPactApproval,
  validateBudget,
  validateEdit,
  validatePactEdit,
  type BudgetCeiling,
  type BudgetUsage,
  type PactBudget,
} from "../../lib/pact/pact-review";

function createValidTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Update dependencies in package.json",
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
      ruleIds: ["M1", "M2"],
      rules: ["M1", "M2"],
      line: 1,
    },
    {
      id: "T2",
      title: "Migrate request calls to fetch adapter",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/request.js"],
      filesInScope: ["lib/request.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      ruleIds: ["M2"],
      rules: ["M2"],
      line: 8,
    },
    {
      id: "T3",
      title: "Fix webpack build config",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["webpack.config.js"],
      filesInScope: ["webpack.config.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      ruleIds: ["M3"],
      rules: ["M3"],
      line: 15,
    },
    {
      id: "T4",
      title: "Integration verification and tests",
      role: "soul-stitcher",
      dependencies: ["T2", "T3"],
      depends: ["T2", "T3"],
      dependsOn: ["T2", "T3"],
      files: ["index.js"],
      filesInScope: ["index.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      ruleIds: ["M1", "M2"],
      rules: ["M1", "M2"],
      line: 22,
    },
  ];
}

function createDefaultBudget(): PactBudget {
  return {
    maxMinutes: 45,
    maxParallel: 2,
    maxCredits: 50,
    maxToolCalls: 120,
  };
}

describe("Pact Review: validateEdit (Requirements 13.2, 13.5, 36.8, 36.9, 36.10)", () => {
  it("validates valid task list with no errors", () => {
    const tasks = createValidTasks();
    const result = validateEdit(tasks);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.tasks.length, 4);
  });

  it("rejects empty task list", () => {
    const result = validateEdit([]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "EMPTY_PACT"));
  });

  it("rejects invalid task ID format", () => {
    const tasks = createValidTasks();
    tasks[0].id = "INVALID_ID";
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "INVALID_TASK_ID"));
  });

  it("rejects duplicate task IDs", () => {
    const tasks = createValidTasks();
    tasks[1].id = "T1";
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "DUPLICATE_TASK_ID"));
  });

  it("rejects missing title", () => {
    const tasks = createValidTasks();
    tasks[0].title = "   ";
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "INVALID_SYNTAX"));
  });

  it("rejects invalid role outside bonesetter and soul-stitcher", () => {
    const tasks = createValidTasks();
    (tasks[0] as unknown as { role: string }).role = "exhumer";
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "INVALID_ROLE"));
  });

  it("rejects empty files list", () => {
    const tasks = createValidTasks();
    tasks[0].files = [];
    tasks[0].filesInScope = [];
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "EMPTY_FILES"));
  });

  it("rejects file paths outside repository bounds", () => {
    const tasks = createValidTasks();
    tasks[0].files = ["../secret.txt"];
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "PATH_OUTSIDE_REPO"));
  });

  it("rejects empty acceptance command", () => {
    const tasks = createValidTasks();
    tasks[0].acceptanceCommand = "";
    tasks[0].accept = "";
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "EMPTY_ACCEPT_COMMAND"));
  });

  it("rejects blocked acceptance commands under CommandPolicy", () => {
    const tasks = createValidTasks();
    tasks[0].acceptanceCommand = "sudo rm -rf /";
    tasks[0].accept = "sudo rm -rf /";
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "BLOCKED_COMMAND"));
  });

  it("rejects invalid hard flag", () => {
    const tasks = createValidTasks();
    (tasks[0] as unknown as { hard: string }).hard = "maybe";
    (tasks[0] as unknown as { hardRaw: string }).hardRaw = "maybe";
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "INVALID_HARD_FLAG"));
  });

  it("rejects invalid rule outside M1-M6", () => {
    const tasks = createValidTasks();
    (tasks[0] as unknown as { rules: string[] }).rules = ["M99"];
    (tasks[0] as unknown as { ruleIds: string[] }).ruleIds = ["M99"];
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "INVALID_RULE"));
  });

  it("rejects missing dependency ID", () => {
    const tasks = createValidTasks();
    tasks[1].dependencies = ["T999"];
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "MISSING_DEPENDENCY"));
  });

  it("rejects dependency cycles and names the cycle (Requirement 36.9)", () => {
    const tasks = createValidTasks();
    // T1 -> T2 -> T1 cycle
    tasks[0].dependencies = ["T2"];
    tasks[1].dependencies = ["T1"];
    const result = validateEdit(tasks);
    assert.equal(result.ok, false);
    const cycleErr = result.errors.find((e) => e.code === "DEPENDENCY_CYCLE");
    assert.ok(cycleErr);
    assert.ok(cycleErr.message.includes("cycle"));
  });

  it("rejects removal of non-removable requirements (Requirement 13.5, 36.8)", () => {
    const originalTasks = createValidTasks();
    // Add locked non-removable tasks
    originalTasks.push({
      id: "T5",
      title: "Warden final check and whole-repo verification",
      role: "bonesetter",
      dependencies: ["T4"],
      depends: ["T4"],
      dependsOn: ["T4"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      ruleIds: ["M1"],
      rules: ["M1"],
      line: 30,
    });

    // User removes T5
    const editedTasks = createValidTasks();
    const result = validateEdit(originalTasks, editedTasks);
    assert.equal(result.ok, false);
    const nonRemErr = result.errors.find(
      (e) => e.code === "NON_REMOVABLE_REQUIREMENT"
    );
    assert.ok(nonRemErr);
    assert.ok(nonRemErr.message.includes("warden_final_check"));
  });

  it("rejects explicit removal of non-removable requirements via options", () => {
    const tasks = createValidTasks();
    const result = validateEdit(tasks, {
      removedRequirementIds: ["grimoire_gate"],
    });
    assert.equal(result.ok, false);
    const nonRemErr = result.errors.find(
      (e) => e.code === "NON_REMOVABLE_REQUIREMENT"
    );
    assert.ok(nonRemErr);
    assert.ok(nonRemErr.message.includes("grimoire_gate"));
  });

  it("flags tasks that depend on disabled tasks (Requirement 36.10)", () => {
    const tasks = createValidTasks();
    // T2 is disabled; T4 depends on T2
    const result = validateEdit(tasks, {
      disabledTaskIds: ["T2"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.flaggedTasks.length, 1);
    assert.equal(result.flaggedTasks[0].taskId, "T4");
    assert.equal(result.flaggedTasks[0].dependsOnDisabled, "T2");
    assert.equal(
      result.flaggedTasks[0].message,
      "Task T4 depends on T2, which is off."
    );
  });

  it("detects added, removed, and modified tasks in diff summary", () => {
    const originalTasks = createValidTasks();
    const editedTasks = createValidTasks();
    // Modify T1 title
    editedTasks[0].title = "Modified title for T1";
    // Remove T4
    editedTasks.pop();
    // Add T5
    editedTasks.push({
      id: "T5",
      title: "New added task",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/new.js"],
      filesInScope: ["lib/new.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      ruleIds: ["M1"],
      rules: ["M1"],
      line: 35,
    });

    const result = validateEdit(originalTasks, editedTasks);
    assert.equal(result.ok, true);
    assert.deepEqual(result.modifiedTaskIds, ["T1"]);
    assert.deepEqual(result.removedTaskIds, ["T4"]);
    assert.deepEqual(result.addedTaskIds, ["T5"]);
  });

  it("alias validatePactEdit behaves identically", () => {
    const tasks = createValidTasks();
    const res1 = validateEdit(tasks);
    const res2 = validatePactEdit(tasks);
    assert.deepEqual(res1, res2);
  });
});

describe("Pact Review: recordApproval (Requirements 13.4, 13.8)", () => {
  it("records approval for valid tasks and budget", () => {
    const tasks = createValidTasks();
    const budget = createDefaultBudget();
    const record = recordApproval(tasks, {
      approvedTaskIds: ["T1", "T2", "T3", "T4"],
      pactVersion: 1,
      budget,
      actor: "judge-user",
      runId: "run-42",
      now: 1700000000000,
    });

    assert.equal(record.ok, true);
    assert.equal(record.pactVersion, 1);
    assert.deepEqual(record.approvedTaskIds, ["T1", "T2", "T3", "T4"]);
    assert.deepEqual(record.disabledTaskIds, []);
    assert.equal(record.approvedBy, "judge-user");
    assert.equal(record.event.kind, "pact.approved");
    assert.equal(record.event.runId, "run-42");
    assert.equal(record.event.data.pactVersion, 1);
    assert.deepEqual(record.event.data.approvedTaskIds, [
      "T1",
      "T2",
      "T3",
      "T4",
    ]);
    assert.deepEqual(record.event.data.budget, budget);
    assert.equal(isPactApproved(record), true);
  });

  it("handles unapproved/disabled tasks and flags dependents", () => {
    const tasks = createValidTasks();
    const budget = createDefaultBudget();
    // T2 is unapproved; T4 depends on T2
    const record = recordApproval(tasks, {
      approvedTaskIds: ["T1", "T3", "T4"],
      pactVersion: 2,
      budget,
    });

    assert.equal(record.ok, true);
    assert.deepEqual(record.approvedTaskIds, ["T1", "T3", "T4"]);
    assert.deepEqual(record.disabledTaskIds, ["T2"]);
    assert.equal(record.flaggedTasks.length, 1);
    assert.equal(record.flaggedTasks[0].taskId, "T4");
    assert.equal(record.flaggedTasks[0].dependsOnDisabled, "T2");
  });

  it("rejects invalid pactVersion", () => {
    const tasks = createValidTasks();
    const budget = createDefaultBudget();
    const record = recordApproval(tasks, {
      approvedTaskIds: ["T1"],
      pactVersion: 0,
      budget,
    });

    assert.equal(record.ok, false);
    assert.ok(record.errors.some((e) => e.includes("pactVersion")));
    assert.equal(isPactApproved(record), false);
  });

  it("rejects approved tasks not defined in the Pact", () => {
    const tasks = createValidTasks();
    const budget = createDefaultBudget();
    const record = recordApproval(tasks, {
      approvedTaskIds: ["T1", "T999"],
      pactVersion: 1,
      budget,
    });

    assert.equal(record.ok, false);
    assert.ok(record.errors.some((e) => e.includes("T999")));
  });

  it("rejects approval when non-removable requirement is disabled", () => {
    const tasks = createValidTasks();
    tasks.push({
      id: "T5",
      title: "Grimoire syntax gate verification",
      role: "bonesetter",
      dependencies: ["T4"],
      depends: ["T4"],
      dependsOn: ["T4"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      ruleIds: ["M1"],
      rules: ["M1"],
      line: 30,
    });

    const record = recordApproval(tasks, {
      approvedTaskIds: ["T1", "T2", "T3", "T4"], // omitted T5
      pactVersion: 1,
      budget: createDefaultBudget(),
    });

    assert.equal(record.ok, false);
    assert.ok(record.errors.some((e) => e.includes("grimoire_gate")));
  });

  it("accepts Set as approvedTaskIds and single options object", () => {
    const tasks = createValidTasks();
    const record = recordPactApproval({
      originalTasks: tasks,
      approvedTaskIds: new Set(["T1", "T2"]),
      pactVersion: 1,
      budget: createDefaultBudget(),
    });

    assert.equal(record.ok, true);
    assert.deepEqual(record.approvedTaskIds, ["T1", "T2"]);
  });
});

describe("Pact Review: Budget validation and checks (Requirements 30.5, 30.6, 36.11, 36.12, 36.13)", () => {
  it("validates a standard budget successfully", () => {
    const budget = createDefaultBudget();
    const result = validateBudget(budget);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.normalizedBudget, budget);
  });

  it("rejects non-positive maxMinutes", () => {
    const result = validateBudget({
      maxMinutes: 0,
      maxParallel: 1,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("maxMinutes")));
  });

  it("rejects non-integer or zero maxParallel", () => {
    const result = validateBudget({
      maxMinutes: 10,
      maxParallel: 0,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("maxParallel")));
  });

  it("rejects budget exceeding ceiling (Requirement 36.11)", () => {
    const ceiling: BudgetCeiling = {
      maxMinutes: 30,
      maxParallel: 2,
      maxCredits: 40,
    };

    const budget: PactBudget = {
      maxMinutes: 45, // exceeds ceiling
      maxParallel: 1,
      maxCredits: 50, // exceeds ceiling
    };

    const result = validateBudget(budget, ceiling);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("maxMinutes")));
    assert.ok(result.errors.some((e) => e.includes("maxCredits")));
  });

  it("allows user to lower caps below ceiling (Requirement 36.11)", () => {
    const ceiling: BudgetCeiling = {
      maxMinutes: 60,
      maxParallel: 4,
      maxCredits: 100,
    };

    const budget: PactBudget = {
      maxMinutes: 30,
      maxParallel: 2,
      maxCredits: 50,
    };

    const result = validateBudget(budget, ceiling);
    assert.equal(result.ok, true);
  });

  it("evaluates budget usage and warning at 80% (Requirement 30.5)", () => {
    const budget: PactBudget = {
      maxMinutes: 50,
      maxParallel: 2,
      maxCredits: 100,
    };

    const usage: BudgetUsage = {
      minutes: 40, // 40/50 = 80%
      runningParallel: 1,
      credits: 50,
    };

    const result = checkBudgetUsage(budget, usage);
    assert.equal(result.ok, true);
    assert.equal(result.exceeded, false);
    assert.equal(result.warning, true);
    assert.deepEqual(result.warningDimensions, ["minutes"]);
    assert.equal(result.percent, 80);
    assert.equal(result.cappedDimension, "minutes");
  });

  it("evaluates budget usage and exceeded at 100% (Requirement 30.6)", () => {
    const budget: PactBudget = {
      maxMinutes: 50,
      maxParallel: 2,
      maxCredits: 100,
      maxToolCalls: 100,
    };

    const usage: BudgetUsage = {
      minutes: 50, // 100%
      runningParallel: 1,
      credits: 20,
      toolCalls: 105, // 105%
    };

    const result = checkBudgetUsage(budget, usage);
    assert.equal(result.ok, false);
    assert.equal(result.exceeded, true);
    assert.ok(result.exceededDimensions.includes("minutes"));
    assert.ok(result.exceededDimensions.includes("toolCalls"));
  });

  it("ignores credits when credit field is null or not reported (Requirement 30.10)", () => {
    const budget: PactBudget = {
      maxMinutes: 45,
      maxParallel: 2,
      maxCredits: null, // credits not reported
    };

    const usage: BudgetUsage = {
      minutes: 10,
      runningParallel: 1,
      credits: 9999, // should be ignored
    };

    const result = checkBudgetUsage(budget, usage);
    assert.equal(result.ok, true);
    assert.equal(result.exceeded, false);
    assert.equal(result.dimensions.credits.cap, null);
  });

  it("checkPactBudget entry point validates and checks usage", () => {
    const budget = createDefaultBudget();
    const ceiling: BudgetCeiling = { maxMinutes: 60, maxParallel: 4 };

    // Valid with no usage
    const res1 = checkPactBudget(budget, ceiling);
    assert.equal(res1.ok, true);
    assert.equal(res1.valid, true);

    // Valid with usage
    const res2 = checkPactBudget(budget, {
      ceiling,
      usage: { minutes: 10, runningParallel: 1 },
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.valid, true);
    assert.ok(res2.usageResult);
  });

  it("formatBudgetTerms outputs required terms text and credits notes (Requirements 36.12, 36.13)", () => {
    // With credits reported
    const display1 = formatBudgetTerms({
      maxMinutes: 45,
      maxParallel: 2,
      maxCredits: 100,
    });
    assert.equal(display1.termsNote, BUDGET_CHECK_TERMS_NOTE);
    assert.equal(display1.creditsNote, undefined);

    // Without credits reported
    const display2 = formatBudgetTerms(
      {
        maxMinutes: 45,
        maxParallel: 2,
        maxCredits: null,
      },
      { creditsReported: false }
    );
    assert.equal(display2.termsNote, BUDGET_CHECK_TERMS_NOTE);
    assert.equal(display2.creditsNote, BUDGET_CREDITS_UNREPORTED_NOTE);
  });
});
