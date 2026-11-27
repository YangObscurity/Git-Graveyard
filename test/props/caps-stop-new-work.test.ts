// Task 22.4 — Property 20: Caps stop new work (P20).
// Validates: Requirement 30.7 (design R4-18 P20).
//
// After `budget.exceeded` for a run on any capped dimension, the Necromancer sends no new
// session/prompt and starts no new sandbox_exec in that run unless a later event raises the cap
// within the invite-code ceiling.
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { DatabaseSync } from "node:sqlite";

import { EventStore } from "../../lib/events/event-store";
import {
  BudgetGovernor,
  type BudgetCaps,
  type BudgetDimension,
} from "../../lib/governor/budget-governor";

type Action =
  | { kind: "prompt"; ms: number }
  | { kind: "tool"; n: number }
  | { kind: "wait"; ms: number }
  | { kind: "pact"; ms: number }
  | { kind: "credits"; n: number }
  | { kind: "context"; n: number };

function applyExceeding(governor: BudgetGovernor, dim: BudgetDimension, amount: number): void {
  switch (dim) {
    case "toolCallsPerRun":
    case "toolCallsPerTurn":
      governor.beginTurn("s1");
      for (let i = 0; i < amount; i += 1) {
        governor.recordToolCall("s1");
      }
      break;
    case "promptsPerSkeleton":
      for (let i = 0; i < amount; i += 1) {
        governor.recordPromptStart("s1");
      }
      break;
    case "creditsPerRun":
    case "creditsPerDay":
      governor.recordCredits(amount);
      break;
    case "contextPressurePercent":
      governor.recordContextPressure(amount);
      break;
    default:
      break;
  }
}

describe("Property 20: Caps stop new work (P20) (Requirement 30.7)", () => {
  it("stops prompts and sandbox exec once budget.exceeded is emitted on any capped dimension", () => {
    const actionArb: fc.Arbitrary<Action> = fc.oneof(
      fc.record({ kind: fc.constant("prompt" as const), ms: fc.integer({ min: 0, max: 1000 }) }),
      fc.record({ kind: fc.constant("tool" as const), n: fc.integer({ min: 1, max: 5 }) }),
      fc.record({ kind: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 2000 }) }),
      fc.record({ kind: fc.constant("pact" as const), ms: fc.integer({ min: 0, max: 2000 }) }),
      fc.record({ kind: fc.constant("credits" as const), n: fc.integer({ min: 1, max: 50 }) }),
      fc.record({ kind: fc.constant("context" as const), n: fc.integer({ min: 0, max: 100 }) })
    );

    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 25 }), (actions: Action[]) => {
        let clock = 0;
        const db = new DatabaseSync(":memory:");
        const eventStore = new EventStore(db);
        const governor = new BudgetGovernor({
          runId: "prop-run",
          eventStore,
          caps: {
            toolCallsPerRun: 3,
            promptsPerSkeleton: 2,
            toolCallsPerTurn: 2,
            runWallClockMs: 50,
            contextPressurePercent: 40,
            creditsPerRun: 10,
          },
          codeCeiling: {
            toolCallsPerRun: 100,
            promptsPerSkeleton: 100,
            toolCallsPerTurn: 100,
            runWallClockMs: 100000,
            contextPressurePercent: 100,
            creditsPerRun: 1000,
          },
          now: () => clock,
        });

        try {
          // Latched exceedance tracked independently of the governor's own state: once any
          // `budget.exceeded` is observed it must remain in effect for the rest of the run because
          // this property test never issues a `grantCapIncrease` to clear it.
          const latched = new Set<BudgetDimension>();
          for (const action of actions) {
            switch (action.kind) {
              case "prompt":
                governor.recordPromptStart("s1");
                clock += action.ms;
                governor.recordPromptEnd("s1");
                break;
              case "tool":
                governor.beginTurn("s1");
                for (let i = 0; i < action.n; i += 1) {
                  governor.recordToolCall("s1");
                }
                break;
              case "wait":
                clock += action.ms;
                break;
              case "pact":
                governor.pauseClockForPact();
                clock += action.ms;
                governor.resumeClockFromPact();
                break;
              case "credits":
                governor.recordCredits(action.n);
                break;
              case "context":
                governor.recordContextPressure(action.n);
                break;
            }

            governor.evaluate();
            const promptGate = governor.canDispatchPrompt("s1");
            const execGate = governor.canDispatchSandboxExec();
            // Fold in any newly signalled dimension; the latch is monotonic across beginTurn().
            for (const dim of governor.getExceededDimensions()) {
              latched.add(dim);
            }
            if (latched.size > 0) {
              // After any budget.exceeded, zero dispatches pass in this run.
              assert.equal(promptGate.allowed, false);
              assert.equal(execGate.allowed, false);
            } else {
              // Nothing has exceeded yet, so new work is still permitted.
              assert.equal(promptGate.allowed, true);
              assert.equal(execGate.allowed, true);
            }
          }
          const exceededEvents = eventStore.getEvents("prop-run", { kind: "budget.exceeded" });
          if (latched.size > 0) {
            // Every latched dimension must have produced a corresponding budget.exceeded event.
            assert.ok(exceededEvents.length >= 1);
            const signalled = new Set(exceededEvents.map((event) => event.data.dimension));
            for (const dim of latched) {
              assert.ok(signalled.has(dim), `missing budget.exceeded for ${dim}`);
            }
          } else {
            assert.equal(exceededEvents.length, 0);
          }
        } finally {
          db.close();
        }
      }),
      { numRuns: 80 }
    );
  });
});

describe("Property 20: Cap grants within the Code_Ceiling (Requirement 30.7, 30.8)", () => {
  it("keeps work blocked after an over-ceiling grant and unblocks only for a within-ceiling grant", () => {
    const dimArb = fc.constantFrom<BudgetDimension>(
      "toolCallsPerRun",
      "promptsPerSkeleton",
      "toolCallsPerTurn",
      "contextPressurePercent"
    );

    fc.assert(
      fc.property(dimArb, fc.integer({ min: 3, max: 5 }), (dim, amount) => {
        const cap = 3;
        const ceiling = 8;
        const caps: BudgetCaps = {};
        caps[dim] = cap;
        const codeCeiling: BudgetCaps = {};
        codeCeiling[dim] = ceiling;

        const db = new DatabaseSync(":memory:");
        const eventStore = new EventStore(db);
        const governor = new BudgetGovernor({
          runId: "grant-run",
          eventStore,
          caps,
          codeCeiling,
          now: () => 0,
        });
        try {
          applyExceeding(governor, dim, amount);
          governor.evaluate();

          assert.ok(governor.getExceededDimensions().includes(dim));
          assert.equal(governor.canDispatchPrompt("s1").allowed, false);
          assert.equal(governor.canDispatchSandboxExec().allowed, false);
          assert.ok(
            eventStore.getEvents("grant-run", { kind: "budget.exceeded" }).length >= 1
          );

          // A grant above the Code_Ceiling is rejected and work stays blocked.
          const over = governor.grantCapIncrease(dim, ceiling + 1, { actor: "owner" });
          assert.equal(over.ok, false);
          assert.equal(over.ok === false ? over.code : "", "CODE_CEILING_EXCEEDED");
          assert.equal(governor.canDispatchPrompt("s1").allowed, false);
          assert.equal(governor.canDispatchSandboxExec().allowed, false);

          // A grant within the Code_Ceiling and above current usage unblocks dispatch.
          const usage = governor.usageFor(dim);
          assert.ok(usage !== null);
          const newCap = Math.min(ceiling, (usage ?? amount) + 1);
          const grant = governor.grantCapIncrease(dim, newCap, { actor: "owner" });
          assert.equal(grant.ok, true);
          assert.equal(governor.getExceededDimensions().length, 0);
          assert.equal(governor.canDispatchPrompt("s1").allowed, true);
          assert.equal(governor.canDispatchSandboxExec().allowed, true);
          assert.ok(eventStore.getEvents("grant-run", { kind: "budget.update" }).length >= 1);
        } finally {
          db.close();
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe("Property 20: Pact wait never advances the run wall clock (Requirement 30.12)", () => {
  it("excludes arbitrary Pact review waits from the run wall clock", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 100000 }),
        (activeBefore, pactWait, activeAfter) => {
          let clock = 0;
          const governor = new BudgetGovernor({
            runId: "pact-run",
            caps: { runWallClockMs: 10_000_000 },
            now: () => clock,
          });

          clock += activeBefore;
          const before = governor.runWallClockMs(clock);
          governor.pauseClockForPact();
          clock += pactWait;
          assert.equal(governor.runWallClockMs(clock), before);
          governor.resumeClockFromPact();
          assert.equal(governor.runWallClockMs(clock), before);
          clock += activeAfter;
          assert.equal(governor.runWallClockMs(clock), before + activeAfter);
          assert.equal(governor.pactWaitMs(clock), pactWait);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("does not fire budget.exceeded for the run wall clock while only the Pact wait elapses", () => {
    let clock = 0;
    const governor = new BudgetGovernor({
      runId: "pact-caps",
      caps: { runWallClockMs: 100 },
      now: () => clock,
    });

    clock += 50;
    governor.pauseClockForPact();
    clock += 1_000_000;
    governor.resumeClockFromPact();
    governor.evaluate();
    assert.equal(governor.getExceededDimensions().length, 0);
    assert.equal(governor.canDispatchSandboxExec().allowed, true);

    clock += 60;
    governor.evaluate();
    assert.deepEqual(governor.getExceededDimensions(), ["runWallClockMs"]);
    assert.equal(governor.canDispatchPrompt("s1").allowed, false);
  });
});

describe("Property 20: Latched exceedance survives beginTurn and usage drops (Requirement 30.7)", () => {
  it("keeps a run blocked after budget.exceeded even when the instantaneous usage falls", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "latch-run",
      eventStore,
      caps: { contextPressurePercent: 40 },
      codeCeiling: { contextPressurePercent: 100 },
      now: () => 0,
    });
    try {
      governor.recordContextPressure(60);
      governor.evaluate();
      assert.ok(governor.getExceededDimensions().includes("contextPressurePercent"));
      assert.equal(governor.canDispatchPrompt("s1").allowed, false);
      assert.equal(governor.canDispatchSandboxExec().allowed, false);

      // The measured pressure drops well below the cap; the latch must keep the run blocked.
      governor.recordContextPressure(5);
      governor.evaluate();
      assert.equal(governor.canDispatchPrompt("s1").allowed, false);
      assert.equal(governor.canDispatchSandboxExec().allowed, false);

      // An over-ceiling grant does not clear the latch.
      const over = governor.grantCapIncrease("contextPressurePercent", 200, { actor: "owner" });
      assert.equal(over.ok, false);
      assert.equal(governor.canDispatchSandboxExec().allowed, false);

      // A within-ceiling grant above current usage clears it and re-opens dispatch.
      const grant = governor.grantCapIncrease("contextPressurePercent", 50, { actor: "owner" });
      assert.equal(grant.ok, true);
      assert.equal(governor.getExceededDimensions().length, 0);
      assert.equal(governor.canDispatchPrompt("s1").allowed, true);
      assert.equal(governor.canDispatchSandboxExec().allowed, true);
      assert.ok(eventStore.getEvents("latch-run", { kind: "budget.update" }).length >= 1);
    } finally {
      db.close();
    }
  });

  it("latches a per-turn exceedance across beginTurn() until a within-ceiling grant", () => {
    let clock = 0;
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "turn-latch-run",
      eventStore,
      caps: { toolCallsPerTurn: 2 },
      codeCeiling: { toolCallsPerTurn: 10 },
      now: () => clock,
    });
    try {
      governor.beginTurn("s1");
      governor.recordToolCall("s1");
      governor.recordToolCall("s1");
      governor.evaluate();
      assert.ok(governor.getExceededDimensions().includes("toolCallsPerTurn"));
      assert.equal(governor.canDispatchPrompt("s1").allowed, false);

      // A fresh turn starts with zero tool calls, but the run stays latched.
      governor.beginTurn("s1");
      clock += 1000;
      governor.evaluate();
      assert.equal(governor.canDispatchPrompt("s1").allowed, false);
      assert.equal(governor.canDispatchSandboxExec().allowed, false);

      // Only a within-ceiling grant above usage clears the latch.
      const over = governor.grantCapIncrease("toolCallsPerTurn", 11, { actor: "owner" });
      assert.equal(over.ok, false);
      assert.equal(governor.canDispatchSandboxExec().allowed, false);

      const grant = governor.grantCapIncrease("toolCallsPerTurn", 5, { actor: "owner" });
      assert.equal(grant.ok, true);
      assert.equal(governor.getExceededDimensions().length, 0);
      assert.equal(governor.canDispatchPrompt("s1").allowed, true);
      assert.equal(governor.canDispatchSandboxExec().allowed, true);
    } finally {
      db.close();
    }
  });
});

describe("Property 20: Credit exhaustion finalizes the run (Requirements 30.19, 41.16)", () => {
  it("emits run.phase and run.done with outcome budget_stopped on credit exhaustion", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "credit-run",
      eventStore,
      caps: { creditsPerRun: 1 },
      codeCeiling: { creditsPerRun: 100 },
      now: () => 1234,
    });
    try {
      governor.recordCredits(5);
      governor.evaluate();

      const phaseEvents = eventStore.getEvents("credit-run", { kind: "run.phase" });
      assert.ok(phaseEvents.length >= 1);
      assert.equal(phaseEvents[0].data.to, "done");

      const doneEvents = eventStore.getEvents("credit-run", { kind: "run.done" });
      assert.ok(doneEvents.length >= 1);
      assert.equal(doneEvents[0].data.outcome, "budget_stopped");
      assert.equal(doneEvents[0].data.endedAt, 1234);

      assert.ok(eventStore.getEvents("credit-run", { kind: "system.worker_state" }).length >= 1);
      assert.equal(governor.getRunOutcome(), "budget_stopped");
    } finally {
      db.close();
    }
  });

  it("refuses every cap grant and keeps dispatch blocked once the run is terminal", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "terminal-run",
      eventStore,
      caps: { creditsPerRun: 1, toolCallsPerRun: 2 },
      codeCeiling: { creditsPerRun: 100, toolCallsPerRun: 100 },
      now: () => 500,
    });
    try {
      governor.recordCredits(5);
      governor.evaluate();
      assert.equal(governor.getRunOutcome(), "budget_stopped");

      // The credit dimension cannot be raised once the run has ended.
      const refusedCredit = governor.grantCapIncrease("creditsPerRun", 50, { actor: "owner" });
      assert.equal(refusedCredit.ok, false);
      assert.equal(refusedCredit.ok === false ? refusedCredit.code : "", "RUN_TERMINAL");
      assert.equal(refusedCredit.ok === false ? refusedCredit.reason : "", "run_terminal");

      // Nor can an unrelated dimension be raised to re-open a terminal run.
      const refusedTool = governor.grantCapIncrease("toolCallsPerRun", 50, { actor: "owner" });
      assert.equal(refusedTool.ok, false);
      assert.equal(refusedTool.ok === false ? refusedTool.code : "", "RUN_TERMINAL");

      assert.equal(governor.canDispatchPrompt("s1").allowed, false);
      assert.equal(governor.canDispatchSandboxExec().allowed, false);
    } finally {
      db.close();
    }
  });

  it("keeps dispatch blocked when the run is terminal with no exceeded dimension latched", () => {
    const governor = new BudgetGovernor({
      runId: "terminal-direct",
      caps: { toolCallsPerRun: 10 },
      now: () => 0,
    });
    governor.markCreditExhausted();
    assert.equal(governor.getRunOutcome(), "budget_stopped");
    // No dimension was measured as exceeded, yet the terminal run must still refuse new work.
    assert.equal(governor.getExceededDimensions().length, 0);
    assert.equal(governor.canDispatchPrompt("s1").allowed, false);
    assert.equal(governor.canDispatchSandboxExec().allowed, false);

    const refused = governor.grantCapIncrease("toolCallsPerRun", 20, { actor: "owner" });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false ? refused.code : "", "RUN_TERMINAL");
  });

  it("clears the credit exceedance latch and pendingAsk when credits become unreported", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "unreported-run",
      eventStore,
      caps: { creditsPerDay: 5 },
      now: () => 0,
    });
    try {
      governor.recordCredits(9);
      governor.evaluate();
      assert.ok(governor.getExceededDimensions().includes("creditsPerDay"));
      assert.equal(governor.snapshot().pendingAsk, "exceed_budget");

      governor.setCreditsReported(false);
      assert.equal(governor.getExceededDimensions().length, 0);
      assert.equal(governor.snapshot().pendingAsk, null);
    } finally {
      db.close();
    }
  });

  it("emits no budget.exceeded after the terminal run.done when credits are exhausted", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "order-run",
      eventStore,
      caps: { creditsPerRun: 1, creditsPerDay: 1 },
      now: () => 100,
    });
    try {
      governor.recordCredits(2);
      governor.evaluate();

      const events = eventStore.getEvents("order-run");
      const doneIndex = events.findIndex((event) => event.kind === "run.done");
      assert.ok(doneIndex >= 0);
      // The credit dimension that exceeded is reported before the terminal event ...
      assert.ok(
        events.slice(0, doneIndex).some((event) => event.kind === "budget.exceeded")
      );
      // ... and nothing is emitted after run.done (a later dimension must not append behind it).
      assert.equal(
        events
          .slice(doneIndex + 1)
          .filter((event) => event.kind === "budget.exceeded").length,
        0
      );
    } finally {
      db.close();
    }
  });
});

describe("Property 20: context cap steering escalates to cancellation (Requirement 30.7)", () => {
  it("still emits cancel_turn after the context cap already latched steer_wrap_up", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "ctx-escalate",
      eventStore,
      caps: { contextPressurePercent: 40 },
      codeCeiling: { contextPressurePercent: 100 },
      contextCancelMarginPercent: 10,
      now: () => 0,
    });
    try {
      // Cross the context cap but stay below the cancel boundary: steer_wrap_up.
      governor.recordContextPressure(45);
      governor.evaluate();
      assert.ok(governor.getExceededDimensions().includes("contextPressurePercent"));
      assert.equal(governor.canDispatchPrompt("s1").allowed, false);

      // The dimension is already latched, yet crossing cap + margin must still escalate.
      governor.recordContextPressure(60);
      governor.evaluate();

      const exceeded = eventStore.getEvents("ctx-escalate", { kind: "budget.exceeded" });
      assert.deepEqual(
        exceeded.map((event) => event.data.action),
        ["steer_wrap_up", "cancel_turn"]
      );
      assert.equal(governor.canDispatchSandboxExec().allowed, false);

      // A later identical evaluation does not re-emit the escalation.
      governor.evaluate();
      assert.equal(eventStore.getEvents("ctx-escalate", { kind: "budget.exceeded" }).length, 2);
    } finally {
      db.close();
    }
  });

  it("escalates directly to cancel_turn when the first breach is already past the margin", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const governor = new BudgetGovernor({
      runId: "ctx-direct",
      eventStore,
      caps: { contextPressurePercent: 40 },
      codeCeiling: { contextPressurePercent: 100 },
      contextCancelMarginPercent: 10,
      now: () => 0,
    });
    try {
      governor.recordContextPressure(80);
      governor.evaluate();
      const exceeded = eventStore.getEvents("ctx-direct", { kind: "budget.exceeded" });
      assert.equal(exceeded.length, 1);
      assert.equal(exceeded[0].data.action, "cancel_turn");
    } finally {
      db.close();
    }
  });

  it("retries cancel_turn once eventStore.append recovers after a transient failure", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    // The first append fails, every append afterwards is delegated to the real store.
    let appendAttempts = 0;
    const flakyStore = {
      append: (input: Parameters<EventStore["append"]>[0]) => {
        appendAttempts += 1;
        if (appendAttempts === 1) {
          throw new Error("event store unavailable");
        }
        return eventStore.append(input);
      },
    } as unknown as EventStore;
    const governor = new BudgetGovernor({
      runId: "ctx-retry",
      eventStore: flakyStore,
      caps: { contextPressurePercent: 40 },
      codeCeiling: { contextPressurePercent: 100 },
      contextCancelMarginPercent: 10,
      now: () => 0,
    });
    try {
      // First breach is already past the cancel boundary, but the escalation append fails.
      governor.recordContextPressure(80);
      governor.evaluate();
      assert.equal(eventStore.getEvents("ctx-retry", { kind: "budget.exceeded" }).length, 0);

      // The failed append did not latch the escalation, so the next evaluation retries and succeeds.
      governor.evaluate();
      const exceeded = eventStore.getEvents("ctx-retry", { kind: "budget.exceeded" });
      assert.equal(exceeded.length, 1);
      assert.equal(exceeded[0].data.action, "cancel_turn");
      assert.equal(governor.canDispatchSandboxExec().allowed, false);

      // The escalation is now latched, so a further evaluation does not re-emit it.
      governor.evaluate();
      assert.equal(eventStore.getEvents("ctx-retry", { kind: "budget.exceeded" }).length, 1);
    } finally {
      db.close();
    }
  });
});
