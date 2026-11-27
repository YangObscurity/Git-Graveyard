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
import { ApprovalManager } from "../../lib/gateway/approval-manager";
import {
  removeQuotes,
  tokenizeSimpleCommand,
} from "../../lib/gateway/command-policy";

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
  assert.equal(answered.effect, "prefer_b");
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

test("AskManager: the chosen action determines the recorded effect", () => {
  const { manager } = createManager();

  const pushAsk = manager.raiseAsk({
    runId: "run-hitl-7",
    kind: "push_confirm",
    question: "push the branch?",
  });
  assert.equal(manager.answerAsk(pushAsk.askId, "Push").effect, "push");

  const noPushAsk = manager.raiseAsk({
    runId: "run-hitl-7",
    kind: "push_confirm",
    question: "push the branch?",
  });
  assert.equal(manager.answerAsk(noPushAsk.askId, "Do not push").effect, "no_push");

  const planAsk = manager.raiseAsk({
    runId: "run-hitl-7",
    kind: "plan_change",
    question: "add the task?",
  });
  assert.equal(manager.answerAsk(planAsk.askId, "Add it").effect, "added");

  const preferAAsk = manager.raiseAsk({
    runId: "run-hitl-7",
    kind: "conflict_choice",
    question: "prefer A or B?",
  });
  assert.equal(manager.answerAsk(preferAAsk.askId, "Prefer A").effect, "prefer_a");

  const preferBAsk = manager.raiseAsk({
    runId: "run-hitl-7",
    kind: "conflict_choice",
    question: "prefer A or B?",
  });
  assert.equal(manager.answerAsk(preferBAsk.askId, "Prefer B").effect, "prefer_b");

  const budgetAsk = manager.raiseAsk({
    runId: "run-hitl-7",
    kind: "exceed_budget",
    question: "raise the cap?",
  });
  const raised = manager.resolveBudgetAsk({
    askId: budgetAsk.askId,
    answer: "Raise the cap",
    currentCap: 10,
    requestedCap: 40,
    codeCeiling: 100,
    globalCeiling: 200,
  });
  assert.equal(raised.effect, "cap_raised");
});

test("AskManager: Raise the cap without an explicit requestedCap is refused", () => {
  const { manager } = createManager();
  const ask = manager.raiseAsk({
    runId: "run-hitl-8",
    kind: "exceed_budget",
    question: "raise the cap?",
  });

  assert.throws(
    () =>
      manager.resolveBudgetAsk({
        askId: ask.askId,
        answer: "Raise the cap",
        currentCap: 10,
        codeCeiling: 100,
        globalCeiling: 200,
      }),
    (err: unknown) =>
      err instanceof AskManagerError &&
      err.code === "HARD_BLOCK_BUDGET_CEILING" &&
      err.message.includes("requestedCap")
  );
});


test("AskManager: answerAsk refuses to raise the budget cap directly", () => {
  const { manager } = createManager();
  const ask = manager.raiseAsk({
    runId: "run-hitl-budget-bypass",
    kind: "exceed_budget",
    question: "raise the cap?",
  });
  assert.throws(
    () => manager.answerAsk(ask.askId, "Raise the cap"),
    (err: unknown) =>
      err instanceof AskManagerError && err.code === "HARD_BLOCK_BUDGET_CEILING"
  );
  // The ask remains pending and is still resolvable through resolveBudgetAsk.
  assert.equal(manager.getAsk(ask.askId)?.status, "pending");
  const accepted = manager.resolveBudgetAsk({
    askId: ask.askId,
    answer: "Raise the cap",
    currentCap: 10,
    requestedCap: 20,
    codeCeiling: 50,
    globalCeiling: 100,
  });
  assert.equal(accepted.status, "answered");
  assert.equal(accepted.effect, "cap_raised");
});

test("AskManager: expired asks are refused and expired with a deadline outcome", () => {
  // Approval deadline.
  let clock = 1_000;
  const apprEnv = createManager({ now: () => clock, approvalWaitMs: 100 });
  clock = 1_000;
  const card = apprEnv.manager.requestApproval({
    runId: "run-exp-approval",
    commandText: "ls",
    cwd: "/w",
    riskClass: "safe",
    skeletonId: "sk-1",
  });
  clock = 1_100;
  assert.throws(
    () => apprEnv.manager.resolveApproval(card.approvalId, "Approve once"),
    (err: unknown) => err instanceof AskManagerError && err.code === "APPROVAL_EXPIRED"
  );
  assert.equal(apprEnv.manager.getAsk(card.approvalId)?.status, "expired");
  const apprEvents = apprEnv.store.getEvents("run-exp-approval", { kind: "approval.resolved" });
  assert.equal(apprEvents.length, 1);
  assert.equal(apprEvents[0].data.reason, "deadline");

  // Generic ask deadline.
  let clock2 = 0;
  const askEnv = createManager({ now: () => clock2, approvalWaitMs: 50 });
  const ask = askEnv.manager.raiseAsk({
    runId: "run-exp-ask",
    kind: "plan_change",
    question: "q?",
  });
  clock2 = 50;
  assert.throws(
    () => askEnv.manager.answerAsk(ask.askId, "Skip it"),
    (err: unknown) => err instanceof AskManagerError && err.code === "ASK_EXPIRED"
  );
  assert.equal(ask.status, "expired");

  // Budget ask deadline (checked before ceiling validation).
  let clock3 = 0;
  const budgetEnv = createManager({ now: () => clock3, approvalWaitMs: 25 });
  const budget = budgetEnv.manager.raiseAsk({
    runId: "run-exp-budget",
    kind: "exceed_budget",
    question: "q?",
  });
  clock3 = 25;
  assert.throws(
    () =>
      budgetEnv.manager.resolveBudgetAsk({
        askId: budget.askId,
        answer: "Raise the cap",
        currentCap: 10,
        requestedCap: 40,
        codeCeiling: 50,
        globalCeiling: 100,
      }),
    (err: unknown) => err instanceof AskManagerError && err.code === "ASK_EXPIRED"
  );
});

test("AskManager: ambiguity asks default to an answerable option", () => {
  const { manager } = createManager();
  const ask = manager.raiseAsk({
    runId: "run-ambiguity",
    kind: "ambiguity",
    question: "which candidate?",
  });
  assert.deepEqual([...ask.options], [ASK_DEFAULTS.ambiguity]);
  const answered = manager.answerAsk(ask.askId, ASK_DEFAULTS.ambiguity);
  assert.equal(answered.status, "answered");
  assert.equal(answered.effect, "evidence_backed_candidate");

  // An explicit custom option for an open-ended kind is honoured.
  const custom = manager.raiseAsk({
    runId: "run-ambiguity",
    kind: "ambiguity",
    question: "pick?",
    options: ["candidate-x"],
  });
  assert.deepEqual([...custom.options], ["candidate-x"]);
});

test("AskManager: fixed-option kinds reject custom options that differ from the design", () => {
  const { manager } = createManager();
  assert.throws(
    () =>
      manager.raiseAsk({
        runId: "run-fixed-options",
        kind: "conflict_choice",
        question: "prefer?",
        options: ["A", "B"],
      }),
    (err: unknown) => err instanceof AskManagerError && err.code === "INVALID_OPTIONS"
  );
  const ok = manager.raiseAsk({
    runId: "run-fixed-options",
    kind: "conflict_choice",
    question: "prefer?",
    options: [...ASK_OPTIONS.conflict_choice],
  });
  assert.deepEqual([...ok.options], [...ASK_OPTIONS.conflict_choice]);
});



test("AskManager: approval fields and ask questions are redacted before storing and emitting", () => {
  const { store, manager } = createManager();
  const card = manager.requestApproval({
    runId: "run-redact",
    commandText: "cat /root/notes.txt",
    cwd: "/home/alice/work",
    riskClass: "read",
    skeletonId: "sk-1",
    reason: "read /root/notes.txt",
  });
  assert.ok(card.commandText.includes("[REDACTED]"));
  assert.ok(card.cwd.includes("[REDACTED]"));
  assert.ok(card.reason.includes("[REDACTED]"));

  const requested = store.getEvents("run-redact", { kind: "approval.requested" })[0];
  assert.ok((requested.data.commandText as string).includes("[REDACTED]"));
  assert.ok((requested.data.cwd as string).includes("[REDACTED]"));

  const ask = manager.raiseAsk({
    runId: "run-redact",
    kind: "plan_change",
    question: "the plan references /root/secret.md",
  });
  assert.ok(ask.question.includes("[REDACTED]"));
});

test("AskManager: approval effects are consistent for every design decision", () => {
  const { manager } = createManager();
  const raise = (runId: string) =>
    manager.requestApproval({
      runId,
      commandText: "npm ci",
      cwd: "/w",
      riskClass: "safe",
      skeletonId: "sk-eff",
    });

  assert.equal(
    manager.resolveApproval(raise("run-eff-1").approvalId, "Approve once").effect,
    "run_once"
  );
  assert.equal(
    manager.resolveApproval(
      raise("run-eff-2").approvalId,
      "Approve this pattern for the run"
    ).effect,
    "pattern_approved"
  );
  assert.equal(
    manager.resolveApproval(raise("run-eff-3").approvalId, "Deny and lay to rest").effect,
    "denied_lay_to_rest"
  );
  assert.equal(manager.resolveApproval(raise("run-eff-4").approvalId, "Deny").effect, "denied");
});

test("AskManager: delegates grant tracking to a supplied ApprovalManager", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  const once = manager.requestApproval({
    runId: "run-deleg",
    commandText: "npm ci",
    cwd: "/w",
    riskClass: "safe",
    skeletonId: "sk-d",
  });
  manager.resolveApproval(once.approvalId, "Approve once");
  assert.equal(approvalManager.consumeGrant("sk-d", ["npm", "ci"], "/w"), true);

  const pattern = manager.requestApproval({
    runId: "run-deleg",
    commandText: "npm test",
    cwd: "/w",
    riskClass: "safe",
    skeletonId: "sk-d",
  });
  manager.resolveApproval(pattern.approvalId, "Approve this pattern for the run");
  assert.equal(
    approvalManager.isPatternApproved("run-deleg", ["npm", "test"]),
    true
  );
});

test("AskManager: grant tracking preserves unredacted multi-token argv and raw cwd", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  // A home-directory cwd is altered by redactText, so the stored card is
  // redacted while grant tracking must match on the raw cwd.
  const rawCwd = "/home/alice/work";

  const explicitArgv = manager.requestApproval({
    runId: "run-deleg-argv",
    commandText: "npm ci",
    argv: ["npm", "ci"],
    cwd: rawCwd,
    riskClass: "safe",
    skeletonId: "sk-deleg-a",
  });
  assert.ok(explicitArgv.cwd.includes("[REDACTED]"));
  manager.resolveApproval(explicitArgv.approvalId, "Approve once");
  assert.equal(
    approvalManager.consumeGrant("sk-deleg-a", ["npm", "ci"], rawCwd),
    true
  );

  // Without an explicit argv the raw commandText is tokenized into multi-token
  // argv so the same multi-token consumeGrant succeeds.
  const parsedArgv = manager.requestApproval({
    runId: "run-deleg-parsed",
    commandText: "npm ci",
    cwd: rawCwd,
    riskClass: "safe",
    skeletonId: "sk-deleg-b",
  });
  manager.resolveApproval(parsedArgv.approvalId, "Approve once");
  assert.equal(
    approvalManager.consumeGrant("sk-deleg-b", ["npm", "ci"], rawCwd),
    true
  );

  // Pattern approvals register the raw command text for the run.
  const pattern = manager.requestApproval({
    runId: "run-deleg-pattern",
    commandText: "npm run build",
    cwd: rawCwd,
    riskClass: "safe",
    skeletonId: "sk-deleg-c",
  });
  manager.resolveApproval(pattern.approvalId, "Approve this pattern for the run");
  assert.equal(
    approvalManager.isPatternApproved("run-deleg-pattern", ["npm", "run", "build"]),
    true
  );
});

test("AskManager: requestApproval rejects argv that disagrees with commandText before any card or grant", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  assert.throws(
    () =>
      manager.requestApproval({
        runId: "run-canonical-mismatch",
        commandText: "echo ok",
        argv: ["rm", "-rf", "/"],
        cwd: "/w",
        riskClass: "safe",
        skeletonId: "sk-canon",
      }),
    (err: unknown) => err instanceof AskManagerError && err.code === "INVALID_INPUT"
  );

  // The disagreement is refused before any approval card, ask or grant exists.
  assert.equal(
    store.getEvents("run-canonical-mismatch", { kind: "approval.requested" }).length,
    0
  );
  assert.equal(manager.pendingAsks("run-canonical-mismatch").length, 0);
  assert.equal(approvalManager.consumeGrant("sk-canon", ["rm", "-rf", "/"], "/w"), false);
});

test("AskManager: requestApproval derives commandText canonically from argv when omitted", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  const card = manager.requestApproval({
    runId: "run-canonical-derived",
    argv: ["npm", "ci"],
    cwd: "/w",
    riskClass: "safe",
    skeletonId: "sk-canon",
  });
  assert.equal(card.commandText, "npm ci");

  manager.resolveApproval(card.approvalId, "Approve once");
  assert.equal(approvalManager.consumeGrant("sk-canon", ["npm", "ci"], "/w"), true);
});

test("AskManager: requestApproval formats argv into a boundary-preserving commandText", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  const argv = ["printf", "%s", "a b", ""];
  const card = manager.requestApproval({
    runId: "run-argv-boundary",
    argv,
    cwd: "/w",
    riskClass: "safe",
    skeletonId: "sk-boundary",
  });

  // The displayed command must preserve argument boundaries rather than
  // collapsing argv into "printf %s a b ".
  assert.notEqual(card.commandText, "printf %s a b ");
  assert.equal(card.commandText, `printf %s 'a b' ""`);

  // The formatted command round-trips back to the exact argv.
  assert.deepEqual(
    tokenizeSimpleCommand(card.commandText).map((w) => removeQuotes(w)),
    argv
  );

  manager.resolveApproval(card.approvalId, "Approve once");
  assert.equal(
    approvalManager.consumeGrant("sk-boundary", ["printf", "%s", "a b", ""], "/w"),
    true
  );
});

test("AskManager: argv quoting round-trips embedded quotes, metacharacters and empty tokens", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  const argv = ["sh", "-c", "echo 'hi there' \"$HOME\"", "a\\b", "", "-"];
  const card = manager.requestApproval({
    runId: "run-argv-roundtrip",
    argv,
    cwd: "/w",
    riskClass: "safe",
    skeletonId: "sk-roundtrip",
  });

  assert.deepEqual(
    tokenizeSimpleCommand(card.commandText).map((w) => removeQuotes(w)),
    argv
  );

  manager.resolveApproval(card.approvalId, "Approve once");
  assert.equal(approvalManager.consumeGrant("sk-roundtrip", [...argv], "/w"), true);

  const requested = store.getEvents("run-argv-roundtrip", {
    kind: "approval.requested",
  });
  assert.equal(requested.length, 1);
});


test("AskManager: redacts each argv token before shell quoting so a secret containing a single quote is not leaked", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  // Runtime-assembled secret containing a single quote; never commit a literal.
  const secret = ["canary", String.fromCharCode(39), "seg", "9f31"].join("");
  // The exact shell form formatArgvToken would emit when the token is NOT
  // redacted first: a single quote split into `'\''`.
  const shellQuoted = `'${secret.replace(/'/g, "'\\''")}'`;

  // Register the secret with the redactor through a recognized secret env var,
  // the same channel the module-level redactText reads, so requestApproval
  // picks it up without a per-call options argument.
  const envVar = "GITHUB_TOKEN";
  const original = process.env[envVar];
  process.env[envVar] = secret;
  try {
    const argv = ["printf", "%s", secret];
    const card = manager.requestApproval({
      runId: "run-secret-argv",
      argv,
      cwd: "/w",
      riskClass: "safe",
      skeletonId: "sk-secret",
    });

    const ask = manager.getAsk(card.approvalId);
    assert.ok(ask);
    const requested = store.getEvents("run-secret-argv", { kind: "approval.requested" });
    assert.equal(requested.length, 1);

    const haystack = [
      card.commandText,
      card.reason,
      ask.question,
      ...ask.refs,
      JSON.stringify(requested.map((e) => e.data)),
    ].join("\n");

    assert.ok(!haystack.includes(secret), `raw secret leaked: ${haystack}`);
    assert.ok(
      !haystack.includes(shellQuoted),
      `shell-quoted secret leaked: ${haystack}`
    );
    assert.ok(card.commandText.includes("[REDACTED]"));

    // Grant tracking still works with the unredacted argv.
    manager.resolveApproval(card.approvalId, "Approve once");
    assert.equal(approvalManager.consumeGrant("sk-secret", [...argv], "/w"), true);
  } finally {
    if (original === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = original;
    }
  }
});

test("AskManager: pattern approvals register argv.join(\" \") so multi-token argv matches isPatternApproved", () => {
  const approvalManager = new ApprovalManager({ defaultWaitMs: 60_000 });
  const store = new EventStore(":memory:");
  const manager = new AskManager({ eventStore: store, approvalManager });

  const argv = ["printf", "%s", "a b", ""];
  const card = manager.requestApproval({
    runId: "run-pattern-argv",
    argv,
    cwd: "/w",
    riskClass: "safe",
    skeletonId: "sk-pattern",
  });
  manager.resolveApproval(card.approvalId, "Approve this pattern for the run");
  assert.equal(
    approvalManager.isPatternApproved("run-pattern-argv", ["printf", "%s", "a b", ""]),
    true
  );
});

