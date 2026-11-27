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
            if (governor.getExceededDimensions().length > 0) {
              assert.equal(promptGate.allowed, false);
              assert.equal(execGate.allowed, false);
            } else {
              assert.equal(promptGate.allowed, true);
              assert.equal(execGate.allowed, true);
            }
          }
          assert.ok(eventStore.countEvents("prop-run") >= 0);
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
      "creditsPerRun",
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

