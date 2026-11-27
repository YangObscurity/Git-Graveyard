// Task 21.2: HITL tier orchestration and AskManager.
// Validates: Requirements 28.1-28.10.

import test from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "../../lib/events/event-store";
import {
  AskManager,
  AskManagerError,
  ASK_OPTIONS,
  ASK_DEFAULTS,
} from "../../lib/hitl/ask-manager";

function createManager(options?: { now?: () => number; approvalWaitMs?: number }) {
  const store = new EventStore(":memory:");
  const manager = new AskManager({
    eventStore: store,
    now: options?.now,
    approvalWaitMs: options?.approvalWaitMs,
  });
  return { store, manager };
}

test("AskManager: Tier 1 approval cards carry command, cwd, risk class and expiry", () => {
  let clock = 5_000;
  const { store, manager } = createManager({ now: () => clock, approvalWaitMs: 1000 });

  const card = manager.requestApproval({
    runId: "run-hitl-1",
    commandText: "npm install left-pad",
    cwd: "/runs/run-hitl-1/builders/bonesetter",
    riskClass: "network-install",
    skeletonId: "sk-b1",
    reason: "needs approval",
  });

  assert.equal(card.commandText, "npm install left-pad");
  assert.equal(card.cwd, "/runs/run-hitl-1/builders/bonesetter");
  assert.equal(card.riskClass, "network-install");
  assert.equal(card.skeletonId, "sk-b1");
  assert.equal(card.expiresAt, 6_000);
  assert.deepEqual([...card.options], [...ASK_OPTIONS.approve_command]);

  const requested = store.getEvents("run-hitl-1", { kind: "approval.requested" });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].data.commandText, "npm install left-pad");
  assert.equal(requested[0].data.cwd, "/runs/run-hitl-1/builders/bonesetter");
  assert.equal(requested[0].data.riskClass, "network-install");

  clock = 5_100;
  const resolved = manager.resolveApproval(card.approvalId, "Approve once");
  assert.equal(resolved.status, "answered");
  assert.equal(resolved.effect, "run_once");
  assert.equal(store.getEvents("run-hitl-1", { kind: "approval.resolved" }).length, 1);

  // An off-design decision is refused.
  assert.throws(
    () => manager.resolveApproval(card.approvalId, "maybe later"),
    (err: unknown) => err instanceof AskManagerError && err.code === "APPROVAL_ALREADY_RESOLVED"
  );
});

test("AskManager: Tier 2 decisions emit necromancer.decision with evidence refs", () => {
  const { store, manager } = createManager();

  const cited = manager.decide({
    runId: "run-hitl-2",
    action: "re_dispatch",
    summary: "re-dispatch after rejection",
    refs: ["file:.kiro/specs/resurrection-engine/design.md"],
  });
  assert.equal(cited.evidenceTag, "cited");
  assert.deepEqual(cited.refs, ["file:.kiro/specs/resurrection-engine/design.md"]);

  const bare = manager.decide({ runId: "run-hitl-2", action: "abandon_task" });
  assert.equal(bare.evidenceTag, "no evidence cited");

  const events = store.getEvents("run-hitl-2", { kind: "necromancer.decision" });
  assert.equal(events.length, 2);
  assert.equal(events[1].data.evidenceTag, "no evidence cited");
});

test("AskManager: routes asks, splits and Pact revisions to the active Planner in Legion", () => {
  const { store, manager } = createManager();
  manager.setActivePlannerSession("run-hitl-3", "planner-session-1");

  const routed = manager.routeToPlanner({
    runId: "run-hitl-3",
    phase: "legion",
    subject: "task split",
    refs: ["file:pact.md"],
  });
  assert.equal(routed.routed, true);
  assert.equal(routed.plannerSessionId, "planner-session-1");
  assert.equal(
    store.getEvents("run-hitl-3", { kind: "necromancer.decision" })[0].data.action,
    "route_to_planner"
  );

  // Outside the Legion phase there is no routing.
  assert.equal(
    manager.routeToPlanner({ runId: "run-hitl-3", phase: "report", subject: "x" }).routed,
    false
  );

  // No active Planner session: refused.
  manager.clearActivePlannerSession("run-hitl-3");
  assert.equal(
    manager.routeToPlanner({ runId: "run-hitl-3", phase: "legion", subject: "x" }).routed,
    false
  );
});

test("AskManager: applies design timeout defaults on deadline", () => {
  let clock = 100_000;
  const { store, manager } = createManager({ now: () => clock, approvalWaitMs: 500 });

  const card = manager.requestApproval({
    runId: "run-hitl-4",
    commandText: "pip install requests",
    cwd: "/w",
    riskClass: "network-install",
    skeletonId: "sk-b2",
  });
  const budget = manager.raiseAsk({
    runId: "run-hitl-4",
    kind: "exceed_budget",
    question: "raise the cap?",
    refs: ["ev:budget.exceeded"],
  });
  const planChange = manager.raiseAsk({
    runId: "run-hitl-4",
    kind: "plan_change",
    question: "add a task?",
  });

  clock += 600;
  const outcomes = manager.expireAsks();
  assert.equal(outcomes.length, 3);

  const approvals = outcomes.find((o) => o.askId === card.approvalId);
  assert.equal(approvals?.defaultAction, "Deny");
  assert.equal(approvals?.effect, "denied");
  const approvalEvents = store.getEvents("run-hitl-4", { kind: "approval.resolved" });
  assert.equal(approvalEvents[0].data.decision, "Deny");
  assert.equal(approvalEvents[0].data.reason, "deadline");

  const budgetOutcome = outcomes.find((o) => o.askId === budget.askId);
  assert.equal(budgetOutcome?.defaultAction, "Finish current tasks only");
  assert.equal(budgetOutcome?.effect, "finish_current_tasks_then_budget_stopped");
  const necro = store.getEvents("run-hitl-4", { kind: "necromancer.decision" });
  assert.equal(necro[0].data.action, "finish_current_tasks_then_budget_stopped");

  assert.equal(planChange.status, "expired");
  assert.equal(manager.getAsk(planChange.askId)?.effect, "skipped_unaddressed");

  // A pending ask that has not expired is untouched.
  const nonExpiring = manager.raiseAsk({
    runId: "run-hitl-4",
    kind: "push_confirm",
    question: "push?",
    expiresAt: clock + 10_000,
  });
  assert.equal(manager.expireAsks().length, 0);
  assert.equal(manager.getAsk(nonExpiring.askId)?.status, "pending");
});

test("AskManager: only design-defined options are accepted", () => {
  const { store, manager } = createManager();
  const ask = manager.raiseAsk({
    runId: "run-hitl-5",
    kind: "conflict_choice",
    question: "prefer A or B?",
  });

  assert.throws(
    () => manager.answerAsk(ask.askId, "pick whichever"),
    (err: unknown) => err instanceof AskManagerError && err.code === "INVALID_ANSWER"
  );

  const answered = manager.answerAsk(ask.askId, "Prefer B");
  assert.equal(answered.status, "answered");
  assert.equal(answered.effect, "re_plan");
  assert.equal(store.getEvents("run-hitl-5", { kind: "ask.answered" }).length, 1);
});

test("AskManager: budget ceiling increases are refused in code", () => {
  const { manager } = createManager();
  const ask = manager.raiseAsk({
    runId: "run-hitl-6",
    kind: "exceed_budget",
    question: "raise the cap?",
  });

  assert.throws(
    () =>
      manager.resolveBudgetAsk({
        askId: ask.askId,
        answer: "Raise the cap",
        currentCap: 10,
        requestedCap: 90,
        codeCeiling: 50,
        globalCeiling: 100,
      }),
    (err: unknown) =>
      err instanceof AskManagerError && err.code === "HARD_BLOCK_BUDGET_CEILING"
  );

  // Within the ceiling the cap increase is accepted.
  const accepted = manager.resolveBudgetAsk({
    askId: ask.askId,
    answer: "Raise the cap",
    currentCap: 10,
    requestedCap: 40,
    codeCeiling: 50,
    globalCeiling: 100,
  });
  assert.equal(accepted.status, "answered");
});

test("AskManager: design options and defaults are stable", () => {
  assert.deepEqual([...ASK_OPTIONS.approve_command], [
    "Approve once",
    "Approve this pattern for the run",
    "Deny",
    "Deny and lay to rest",
  ]);
  assert.deepEqual([...ASK_OPTIONS.exceed_budget], [
    "Raise the cap",
    "Finish current tasks only",
    "Stop now",
  ]);
  assert.equal(ASK_DEFAULTS.push_confirm, "Do not push");
  assert.equal(ASK_DEFAULTS.nothing_to_do, "Stop");
});

