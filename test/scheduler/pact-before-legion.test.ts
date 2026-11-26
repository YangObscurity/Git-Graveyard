// Task 13.6: Property test for Pact before Legion (Property 10: P10)
// Validates: Requirements 13.8, 13.9, 13.10, 23.7

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import type { EventEnvelope } from "../../lib/events/types";
import type { PactRole, PactTask, RuleId } from "../../lib/pact/pact-parser";
import { Scheduler } from "../../lib/scheduler/scheduler";
import type { ScheduledTask } from "../../lib/scheduler/types";

function makePactTask(
  id: string,
  deps: string[] = [],
  role: PactRole = "soul-stitcher",
  hard = false,
  order = 0
): PactTask {
  return {
    id,
    title: `Task ${id}`,
    role,
    dependencies: deps,
    depends: deps,
    dependsOn: deps,
    files: [`src/${id}.ts`],
    filesInScope: [`src/${id}.ts`],
    acceptanceCommand: "npm test",
    accept: "npm test",
    hard,
    hardFlag: hard,
    hardRaw: hard ? "yes" : "no",
    rules: ["M1"] as RuleId[],
    ruleIds: ["M1"] as RuleId[],
    line: order * 10 + 1,
  };
}

describe("Task 13.6 (Property 10: Pact before Legion) - Unit verification", () => {
  it("blocks dispatching when pactApproved is false (Requirement 13.8)", () => {
    const tasks: PactTask[] = [
      makePactTask("T1", [], "bonesetter", false, 0),
      makePactTask("T2", ["T1"], "soul-stitcher", true, 1),
    ];

    const scheduler = new Scheduler(tasks, {
      pactApproved: false,
      runParallelCap: 4,
    });

    assert.equal(scheduler.isPactApproved, false);
    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);
    assert.equal(scheduler.dispatchTask("T1"), null);
    assert.equal(scheduler.getRunningTasks().length, 0);
  });

  it("approves Pact with approvedTaskIds and enables dispatching (Requirements 13.8, 13.9, 23.7)", () => {
    const tasks: PactTask[] = [
      makePactTask("T1", [], "bonesetter", false, 0),
      makePactTask("T2", ["T1"], "soul-stitcher", true, 1),
      makePactTask("T3", [], "soul-stitcher", false, 2),
    ];

    const emittedEvents: EventEnvelope[] = [];
    const scheduler = new Scheduler(tasks, {
      pactApproved: false,
      runParallelCap: 2,
      runId: "run-p10-test",
      emit: (e) => {
        emittedEvents.push(e);
      },
    });

    assert.equal(scheduler.canDispatch(), false);

    // Approve pact with T1 and T2 only (T3 unapproved)
    scheduler.approvePact(["T1", "T2"], 1);

    assert.equal(scheduler.isPactApproved, true);
    assert.equal(scheduler.canDispatch(), true);

    // T3 was not in approvedTaskIds -> skipped
    assert.equal(scheduler.getTask("T3")?.state, "skipped");

    // T1 was approved and ready -> dispatchable
    assert.equal(scheduler.getTask("T1")?.state, "ready");

    const dispatched = scheduler.dispatchNext();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].id, "T1");
    assert.equal(scheduler.getTask("T1")?.state, "running");

    // Verify task.state event was emitted
    const runningEvents = emittedEvents.filter(
      (e) => e.kind === "task.state" && (e.data as Record<string, unknown>).state === "running"
    );
    assert.equal(runningEvents.length, 1);
    assert.equal(runningEvents[0].taskId, "T1");
  });

  it("marks unapproved tasks skipped and blocks their dependents (Requirements 13.10, 23.3, 23.7, 23.11)", () => {
    const tasks: PactTask[] = [
      makePactTask("T1", [], "bonesetter", false, 0),
      makePactTask("T2", ["T1"], "soul-stitcher", false, 1),
    ];

    const scheduler = new Scheduler(tasks, {
      pactApproved: true,
      approvedTaskIds: ["T2"], // T1 turned off in Pact
    });

    assert.equal(scheduler.getTask("T1")?.state, "skipped");
    // T2 depends on skipped T1 -> blocked
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.canDispatch(), false);

    // An ask should have been raised for T2
    const asks = scheduler.getPendingAsks();
    assert.equal(asks.length, 1);
    assert.equal(asks[0].taskId, "T2");
    assert.equal(asks[0].blockedByTaskId, "T1");
  });
});

describe("Task 13.6 (Property 10: Pact before Legion) - Fast-check property verification", () => {
  it("Property 10.1: No builder skeleton is raised before pact.approved (Requirements 13.8, 23.7)", () => {
    // Generate arbitrary lists of tasks (1 to 15 tasks)
    const taskArb = fc
      .integer({ min: 1, max: 15 })
      .chain((count) => {
        const items = [];
        for (let i = 1; i <= count; i++) {
          const earlierIds = Array.from({ length: i - 1 }, (_, idx) => `task-${idx + 1}`);
          items.push(
            fc.record({
              id: fc.constant(`task-${i}`),
              deps: fc.subarray(earlierIds),
              role: fc.constantFrom("bonesetter" as const, "soul-stitcher" as const),
              hard: fc.boolean(),
            })
          );
        }
        return fc.tuple(...items);
      });

    fc.assert(
      fc.property(
        taskArb,
        fc.integer({ min: 1, max: 10 }),
        (generatedTasks, parallelCap) => {
          const tasks: PactTask[] = generatedTasks.map((g, idx) =>
            makePactTask(g.id, g.deps, g.role, g.hard, idx)
          );

          const emittedEvents: EventEnvelope[] = [];
          const scheduler = new Scheduler(tasks, {
            pactApproved: false,
            runParallelCap: parallelCap,
            emit: (e) => {
              emittedEvents.push(e);
            },
          });

          // Invariant 1: canDispatch() is false
          assert.equal(
            scheduler.canDispatch(),
            false,
            "canDispatch() must be false when pactApproved is false"
          );

          // Invariant 2: dispatchNext() returns empty array
          const dispatched = scheduler.dispatchNext();
          assert.deepEqual(
            dispatched,
            [],
            "dispatchNext() must return empty array when pactApproved is false"
          );

          // Invariant 3: dispatchTask() returns null for all tasks
          for (const t of tasks) {
            const res = scheduler.dispatchTask(t.id);
            assert.equal(
              res,
              null,
              `dispatchTask('${t.id}') must return null when pactApproved is false`
            );
          }

          // Invariant 4: Zero tasks are running
          assert.equal(
            scheduler.getRunningTasks().length,
            0,
            "No task should be in running state before pact approval"
          );

          // Invariant 5: Zero 'task.state' running events emitted
          const runningEvents = emittedEvents.filter(
            (e) => e.kind === "task.state" && (e.data as Record<string, unknown>).state === "running"
          );
          assert.equal(
            runningEvents.length,
            0,
            "No running state event may be emitted before pact approval"
          );
        }
      ),
      { numRuns: 60 }
    );
  });

  it("Property 10.2: Only approved tasks ever run after pact.approved (Requirements 13.9, 13.10, 23.7)", () => {
    const taskCountArb = fc.integer({ min: 1, max: 12 });

    fc.assert(
      fc.property(
        taskCountArb,
        fc.integer({ min: 1, max: 6 }),
        (taskCount, parallelCap) => {
          const allTaskIds = Array.from({ length: taskCount }, (_, i) => `T${i + 1}`);

          // Linear dependency chain T1 -> T2 -> ... -> Tn or independent tasks
          const tasks: PactTask[] = allTaskIds.map((id, idx) =>
            makePactTask(id, [], "soul-stitcher", false, idx)
          );

          // Choose arbitrary subset of approved tasks
          const approvedSubset = allTaskIds.filter((_, idx) => idx % 2 === 0);
          const approvedSet = new Set(approvedSubset);

          const scheduler = new Scheduler(tasks, {
            pactApproved: false,
            runParallelCap: parallelCap,
          });

          // Pre-approval check
          assert.equal(scheduler.canDispatch(), false);

          // Approve pact with the subset
          scheduler.approvePact(approvedSubset, 1);

          // Dispatch all available ready tasks
          const allDispatchedTasks: ScheduledTask[] = [];
          while (scheduler.canDispatch()) {
            const batch = scheduler.dispatchNext();
            if (batch.length === 0) break;
            allDispatchedTasks.push(...batch);

            // Move dispatched tasks to review to free slots
            for (const t of batch) {
              scheduler.submitForReview(t.id);
              scheduler.mergeTask(t.id);
            }
          }

          // Invariant: every task that was dispatched was in approvedSet
          for (const dispatched of allDispatchedTasks) {
            assert.ok(
              approvedSet.has(dispatched.id),
              `Dispatched task ${dispatched.id} was not in approvedTaskIds: ${Array.from(approvedSet).join(", ")}`
            );
          }

          // Invariant: unapproved tasks were marked skipped and never dispatched
          for (const t of scheduler.getTasks()) {
            if (!approvedSet.has(t.id)) {
              assert.equal(
                t.state,
                "skipped",
                `Unapproved task ${t.id} must be skipped, but got: ${t.state}`
              );
              assert.equal(
                t.attempts,
                0,
                `Unapproved task ${t.id} must have 0 attempts, got: ${t.attempts}`
              );
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property 10.3: Live skeleton concurrency slot invariant (Requirement 23.5)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 5, max: 15 }),
        (runParallelCap, globalSkeletonLimit, runningMax, taskCount) => {
          const effectiveCap = Math.min(runParallelCap, globalSkeletonLimit, runningMax);
          const tasks: PactTask[] = Array.from({ length: taskCount }, (_, i) =>
            makePactTask(`task-${i + 1}`, [], "soul-stitcher", false, i)
          );

          const scheduler = new Scheduler(tasks, {
            pactApproved: true,
            runParallelCap,
            globalSkeletonLimit,
            runningMax,
          });

          assert.equal(scheduler.getEffectiveLimit(), effectiveCap);
          assert.equal(scheduler.getConcurrencyLimit(), effectiveCap);

          // Dispatch initial batch
          const batch = scheduler.dispatchNext();
          assert.ok(
            batch.length <= effectiveCap,
            `Dispatched batch ${batch.length} exceeded effective cap ${effectiveCap}`
          );
          assert.equal(scheduler.getLiveSkeletonsCount(), batch.length);

          const status = scheduler.getSlotStatus();
          assert.equal(status.effectiveLimit, effectiveCap);
          assert.equal(status.liveCount, batch.length);
          assert.equal(status.availableSlots, Math.max(0, effectiveCap - batch.length));
        }
      ),
      { numRuns: 40 }
    );
  });
});
