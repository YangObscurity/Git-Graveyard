import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReportOutcome,
  evaluateReportOutcomeWithDetails,
  evaluateOutcomeFromTaskStates,
  evaluateTaskOutcome,
  summarizeTaskStates,
  normalizeTaskList,
} from "../../lib/lifecycle/outcome-evaluator";
import type { TaskState } from "../../lib/lifecycle/outcome-evaluator";

test("outcome-evaluator: normalizeTaskList", async (t) => {
  await t.test("normalizes empty or null input", () => {
    assert.deepEqual(normalizeTaskList(null), []);
    assert.deepEqual(normalizeTaskList(undefined), []);
    assert.deepEqual(normalizeTaskList([]), []);
  });

  await t.test("normalizes array of task objects", () => {
    const input = [
      { id: "task-a", state: "merged" },
      { id: "task-b", state: "failed" },
    ];
    const res = normalizeTaskList(input);
    assert.equal(res.length, 2);
    assert.equal(res[0].id, "task-a");
    assert.equal(res[0].state, "merged");
    assert.equal(res[1].id, "task-b");
    assert.equal(res[1].state, "failed");
  });

  await t.test("normalizes array of state strings", () => {
    const input: TaskState[] = ["merged", "skipped"];
    const res = normalizeTaskList(input);
    assert.equal(res.length, 2);
    assert.equal(res[0].state, "merged");
    assert.equal(res[1].state, "skipped");
  });

  await t.test("normalizes task state map", () => {
    const input = {
      "task-1": "merged",
      "task-2": "abandoned",
    };
    const res = normalizeTaskList(input);
    assert.equal(res.length, 2);
    assert.ok(res.some((t) => t.id === "task-1" && t.state === "merged"));
    assert.ok(res.some((t) => t.id === "task-2" && t.state === "abandoned"));
  });
});

test("outcome-evaluator: summarizeTaskStates", async (t) => {
  await t.test("summarizes mixed task states correctly", () => {
    const tasks = [
      { id: "1", state: "merged" },
      { id: "2", state: "merged" },
      { id: "3", state: "failed" },
      { id: "4", state: "abandoned" },
      { id: "5", state: "skipped" },
      { id: "6", state: "blocked" },
      { id: "7", state: "running" },
      { id: "8", state: "in_review" },
    ];

    const s = summarizeTaskStates(tasks);
    assert.equal(s.total, 8);
    assert.equal(s.merged, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.abandoned, 1);
    assert.equal(s.skipped, 1);
    assert.equal(s.blocked, 1);
    assert.equal(s.running, 1);
    assert.equal(s.inReview, 1);
    assert.equal(s.open, 3); // blocked + running + in_review
    assert.equal(s.allTerminal, false);
    assert.equal(s.allMerged, false);
    assert.equal(s.noneMerged, false);
    assert.equal(s.hasFailures, true);
    assert.equal(s.hasUnfinished, true);
  });

  await t.test("detects allMerged and allTerminal", () => {
    const tasks = [
      { id: "1", state: "merged" },
      { id: "2", state: "merged" },
    ];
    const s = summarizeTaskStates(tasks);
    assert.equal(s.total, 2);
    assert.equal(s.merged, 2);
    assert.equal(s.allMerged, true);
    assert.equal(s.allTerminal, true);
    assert.equal(s.noneMerged, false);
    assert.equal(s.hasFailures, false);
    assert.equal(s.hasUnfinished, false);
  });

  await t.test("detects noneMerged when all failed", () => {
    const tasks = [
      { id: "1", state: "failed" },
      { id: "2", state: "abandoned" },
    ];
    const s = summarizeTaskStates(tasks);
    assert.equal(s.total, 2);
    assert.equal(s.merged, 0);
    assert.equal(s.noneMerged, true);
    assert.equal(s.allMerged, false);
    assert.equal(s.allTerminal, true);
    assert.equal(s.hasFailures, true);
  });
});

test("outcome-evaluator: evaluateReportOutcome pure function behavior", async (t) => {
  await t.test("pure function: does not mutate input array or objects", () => {
    const original = Object.freeze([
      Object.freeze({ id: "1", state: "merged" }),
      Object.freeze({ id: "2", state: "failed" }),
    ]);

    const res1 = evaluateReportOutcome(original);
    const res2 = evaluateReportOutcome(original);

    assert.equal(res1, "partial");
    assert.equal(res2, "partial");
    assert.equal(original.length, 2);
    assert.equal(original[0].state, "merged");
    assert.equal(original[1].state, "failed");
  });

  await t.test("all tasks merged with passing build and tests -> resurrected (Requirement 26.3)", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "merged" },
    ];
    const outcome = evaluateReportOutcome({
      tasks,
      buildPassed: true,
      testsPassed: true,
      hasTests: true,
    });
    assert.equal(outcome, "resurrected");
  });

  await t.test("all tasks merged with no tests and passing build -> resurrected_build_only (Requirements 26.14, 41.3)", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "merged" },
    ];
    const outcome = evaluateReportOutcome({
      tasks,
      buildPassed: true,
      hasTests: false,
    });
    assert.equal(outcome, "resurrected_build_only");
  });

  await t.test("repo installation failure -> not_resurrected (Requirement 41.1)", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "merged" },
    ];
    const outcome = evaluateReportOutcome({
      tasks,
      installPassed: false,
      buildPassed: true,
      testsPassed: true,
    });
    assert.equal(outcome, "not_resurrected");
  });

  await t.test("some tasks merged, some failed -> partial (Requirement 26.2, 26.16)", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "failed" },
    ];
    const outcome = evaluateReportOutcome({
      tasks,
      buildPassed: true,
      testsPassed: true,
    });
    assert.equal(outcome, "partial");
  });

  await t.test("some tasks merged, some skipped -> partial", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "skipped" },
    ];
    const outcome = evaluateReportOutcome(tasks);
    assert.equal(outcome, "partial");
  });

  await t.test("all tasks merged, but final_check tests failed -> partial", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "merged" },
    ];
    const outcome = evaluateReportOutcome({
      tasks,
      installPassed: true,
      buildPassed: true,
      testsPassed: false,
      hasTests: true,
    });
    assert.equal(outcome, "partial");
  });

  await t.test("all tasks merged, install passed, but build failed -> partial", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "merged" },
    ];
    const outcome = evaluateReportOutcome({
      tasks,
      installPassed: true,
      buildPassed: false,
    });
    assert.equal(outcome, "partial");
  });

  await t.test("zero tasks merged and failures exist -> not_resurrected", () => {
    const tasks = [
      { id: "t1", state: "failed" },
      { id: "t2", state: "abandoned" },
    ];
    const outcome = evaluateReportOutcome(tasks);
    assert.equal(outcome, "not_resurrected");
  });

  await t.test("early exits take precedence", () => {
    const tasks = [{ id: "t1", state: "merged" }];

    assert.equal(
      evaluateReportOutcome({ tasks, userStop: true }),
      "cancelled"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, reason: "cancelled" }),
      "cancelled"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, killed: true }),
      "killed"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, reason: "admin_kill" }),
      "killed"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, budgetStopped: true }),
      "budget_stopped"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, reason: "budget_exceeded" }),
      "budget_stopped"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, healthyAlready: true }),
      "healthy_already"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, error: new Error("fatal") }),
      "error"
    );
    assert.equal(
      evaluateReportOutcome({ tasks, reason: "box_lost" }),
      "error"
    );
  });

  await t.test("aliases evaluateOutcomeFromTaskStates and evaluateTaskOutcome produce same result", () => {
    const tasks = [{ id: "t1", state: "merged" }];
    const res1 = evaluateReportOutcome(tasks);
    const res2 = evaluateOutcomeFromTaskStates(tasks);
    const res3 = evaluateTaskOutcome(tasks);
    assert.equal(res1, res2);
    assert.equal(res2, res3);
  });

  await t.test("evaluateReportOutcomeWithDetails provides full breakdown and evidence", () => {
    const tasks = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "failed" },
    ];
    const res = evaluateReportOutcomeWithDetails({ tasks });
    assert.equal(res.outcome, "partial");
    assert.equal(res.summary.merged, 1);
    assert.equal(res.summary.failed, 1);
    assert.ok(res.evidence.includes("tasks.total:2"));
    assert.ok(res.evidence.includes("tasks.merged:1"));
    assert.ok(res.evidence.includes("tasks.failed:1"));
    assert.ok(typeof res.reason === "string" && res.reason.length > 0);
  });
});
