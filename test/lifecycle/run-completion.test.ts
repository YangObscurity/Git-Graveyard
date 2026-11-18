import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import type { ExecutionBackend, Sandbox } from "../../lib/backend/types";
import type { EventEnvelope } from "../../lib/events/types";
import {
  LifecycleManager,
  IllegalTransitionError,
  isLegalTransition,
  evaluateOutcome,
  RUN_PHASES,
  RUN_OUTCOMES,
  type RunPhase,
  type RunOutcome,
  type OutcomeEvaluationInput,
} from "../../lib/lifecycle/lifecycle-manager";
import {
  evaluateReportOutcome,
  evaluateReportOutcomeWithDetails,
  summarizeTaskStates,
  normalizeTaskList,
  type TaskItemInput,
} from "../../lib/lifecycle/outcome-evaluator";
import {
  finalizeRun,
  type FinalizerExecutionBackend,
  ArtifactsNotStoredError,
  ResidualStateError,
  type RunDoneEventData,
} from "../../lib/lifecycle/run-finalizer";
import type { ArtifactManifest } from "../../lib/lifecycle/artifact-collector";

function createMockSandbox(id: string): Sandbox {
  return {
    id,
    async exec() {
      return {
        async wait() {
          return { exitCode: 0, timedOut: false, oomKilled: false };
        },
      };
    },
    async run() {
      return {
        logRef: `log-${id}`,
        exitCode: 0,
        timedOut: false,
        oomKilled: false,
        stdoutTail: "",
        stderrTail: "",
      };
    },
    async wait() {
      return { exitCode: 0, timedOut: false, oomKilled: false };
    },
    async stop() {},
    async destroy() {},
  };
}

/**
 * Creates a mock ExecutionBackend for run completion integration tests.
 */
function createMockExecutionBackend(): FinalizerExecutionBackend & {
  destroyedBoxIds: string[];
} {
  const destroyedBoxIds: string[] = [];
  return {
    kind: "instabox-docker",
    destroyedBoxIds,
    async create() {
      return createMockSandbox("box-mock");
    },
    async get(id: string) {
      if (destroyedBoxIds.includes(id)) {
        return undefined;
      }
      return createMockSandbox(id);
    },
    async list() {
      return [];
    },
    async destroy(id: string) {
      if (!destroyedBoxIds.includes(id)) {
        destroyedBoxIds.push(id);
      }
    },
    async destroyBox(boxId: string) {
      if (!destroyedBoxIds.includes(boxId)) {
        destroyedBoxIds.push(boxId);
      }
    },
  };
}

/**
 * Creates a complete mock ArtifactManifest.
 */
function createMockManifest(allReady: boolean = true): ArtifactManifest {
  return {
    runId: "run-test",
    artifactsDir: "/data/runs/run-test/artifacts",
    allReady,
    createdAt: 1000,
    artifacts: {
      patch: {
        kind: "patch",
        fileName: "all.patch",
        path: "/data/runs/run-test/artifacts/all.patch",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        byteSize: 1024,
        createdAt: 1000,
      },
      spec: {
        kind: "spec",
        fileName: "spec-bundle.json",
        path: "/data/runs/run-test/artifacts/spec-bundle.json",
        sha256: "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3",
        byteSize: 2048,
        createdAt: 1000,
      },
      report: {
        kind: "report",
        fileName: "report.json",
        path: "/data/runs/run-test/artifacts/report.json",
        sha256: "b5a2c9b115d35fbc0e46eccf61e0467ac9e774404c9b582126782489e0000000",
        byteSize: 4096,
        createdAt: 1000,
      },
      events: {
        kind: "events",
        fileName: "events.ndjson",
        path: "/data/runs/run-test/artifacts/events.ndjson",
        sha256: "c4ca4238a0b923820dcc509a6f75849bca37a1c97a29654131557088b9000000",
        byteSize: 8192,
        createdAt: 1000,
      },
      certificate: {
        kind: "certificate",
        fileName: "death-certificate.json",
        path: "/data/runs/run-test/artifacts/death-certificate.json",
        sha256: "eccbc87e4b5ce2fe28308fd9f2a7baf3a8c4c794300000000000000000000000",
        byteSize: 512,
        createdAt: 1000,
      },
    },
  };
}

describe("Task 14.5: Run lifecycle phase state machine (Requirement 26.1)", () => {
  it("defines exactly eight lifecycle phases in canonical order", () => {
    assert.deepEqual(RUN_PHASES, [
      "queued",
      "exhume",
      "plan",
      "pact_review",
      "legion",
      "final_check",
      "report",
      "done",
    ]);
    assert.equal(RUN_PHASES.length, 8);
  });

  it("advances sequentially through all eight phases and emits run.phase on each transition", () => {
    const emitted: EventEnvelope[] = [];
    const timestamps = [1000, 1100, 1200, 1300, 1400, 1500, 1600];
    let timeIndex = 0;

    const manager = new LifecycleManager({
      runId: "run-seq-test",
      emit: (event) => {
        emitted.push(event);
      },
      now: () => timestamps[timeIndex++],
    });

    assert.equal(manager.phase, "queued");
    assert.equal(manager.currentPhase, "queued");
    assert.equal(manager.getPhase(), "queued");
    assert.equal(manager.isTerminal, false);
    assert.equal(manager.getNextPhase(), "exhume");

    // 1. queued -> exhume
    const p1 = manager.advance();
    assert.equal(p1, "exhume");
    assert.equal(manager.phase, "exhume");
    assert.equal(manager.isTerminal, false);
    assert.equal(manager.getNextPhase(), "plan");

    // 2. exhume -> plan
    const p2 = manager.advance();
    assert.equal(p2, "plan");
    assert.equal(manager.phase, "plan");
    assert.equal(manager.getNextPhase(), "pact_review");

    // 3. plan -> pact_review
    const p3 = manager.advance();
    assert.equal(p3, "pact_review");
    assert.equal(manager.phase, "pact_review");
    assert.equal(manager.getNextPhase(), "legion");

    // 4. pact_review -> legion
    const p4 = manager.advance();
    assert.equal(p4, "legion");
    assert.equal(manager.phase, "legion");
    assert.equal(manager.getNextPhase(), "final_check");

    // 5. legion -> final_check
    const p5 = manager.advance();
    assert.equal(p5, "final_check");
    assert.equal(manager.phase, "final_check");
    assert.equal(manager.getNextPhase(), "report");

    // 6. final_check -> report
    const p6 = manager.advance();
    assert.equal(p6, "report");
    assert.equal(manager.phase, "report");
    assert.equal(manager.getNextPhase(), "done");

    // 7. report -> done
    const p7 = manager.advance({ data: { note: "completed" } });
    assert.equal(p7, "done");
    assert.equal(manager.phase, "done");
    assert.equal(manager.isTerminal, true);
    assert.equal(manager.getNextPhase(), null);

    // Verify emitted run.phase events
    assert.equal(emitted.length, 7);
    const expectedTransitions: Array<[RunPhase, RunPhase]> = [
      ["queued", "exhume"],
      ["exhume", "plan"],
      ["plan", "pact_review"],
      ["pact_review", "legion"],
      ["legion", "final_check"],
      ["final_check", "report"],
      ["report", "done"],
    ];

    for (let i = 0; i < emitted.length; i++) {
      const event = emitted[i];
      const [from, to] = expectedTransitions[i];
      assert.equal(event.kind, "run.phase");
      assert.equal(event.runId, "run-seq-test");
      assert.equal(event.actor, "necromancer");
      assert.equal(event.seq, i + 1);
      assert.equal(event.ts, timestamps[i]);

      const data = event.data as Record<string, unknown>;
      assert.equal(data.previousPhase, from);
      assert.equal(data.phase, to);
      assert.equal(data.entered, timestamps[i]);
      assert.deepEqual(data.refs, []);
    }

    // Verify history records
    const hist = manager.history;
    assert.equal(hist.length, 7);
    for (let i = 0; i < hist.length; i++) {
      const [from, to] = expectedTransitions[i];
      assert.equal(hist[i].previousPhase, from);
      assert.equal(hist[i].phase, to);
      assert.equal(hist[i].ts, timestamps[i]);
    }
  });

  it("supports asynchronous sequential phase advancement via advanceAsync", async () => {
    const emitted: EventEnvelope[] = [];
    const manager = new LifecycleManager({
      runId: "run-async-test",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    const phases: RunPhase[] = [
      "exhume",
      "plan",
      "pact_review",
      "legion",
      "final_check",
      "report",
      "done",
    ];

    for (const expected of phases) {
      const next = await manager.advanceAsync();
      assert.equal(next, expected);
      assert.equal(manager.phase, expected);
    }

    assert.equal(emitted.length, 7);
    assert.equal(manager.isTerminal, true);
  });

  it("forwards actor, skeletonId, taskId, attempt and custom data in transition options", () => {
    const emitted: EventEnvelope[] = [];
    const manager = new LifecycleManager({
      runId: "run-opts-test",
      emit: (e) => {
        emitted.push(e);
      },
    });

    manager.transitionTo("exhume", {
      actor: "supervisor",
      skeletonId: "sk-exhume-1",
      taskId: "task-0",
      attempt: 1,
      data: { customKey: "customVal" },
      ts: 4200,
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0];
    assert.equal(ev.actor, "supervisor");
    assert.equal(ev.skeletonId, "sk-exhume-1");
    assert.equal(ev.taskId, "task-0");
    assert.equal(ev.attempt, 1);
    assert.equal(ev.ts, 4200);

    const data = ev.data as Record<string, unknown>;
    assert.equal(data.phase, "exhume");
    assert.equal(data.previousPhase, "queued");
    assert.equal(data.customKey, "customVal");
  });

  it("rejects invalid initial phase during construction", () => {
    assert.throws(
      () =>
        new LifecycleManager({
          runId: "run-bad-init",
          initialPhase: "nonexistent_phase" as RunPhase,
          emit: () => {},
        }),
      /Invalid initial phase/
    );
  });
});

describe("Task 14.5: Transition guards and illegal transitions", () => {
  it("rejects transition from terminal phase done", () => {
    const manager = new LifecycleManager({
      runId: "run-terminal-test",
      initialPhase: "done",
      emit: () => {},
    });

    assert.equal(manager.isTerminal, true);
    assert.equal(manager.canTransitionTo("queued"), false);
    assert.equal(manager.canTransitionTo("report"), false);
    assert.equal(manager.canTransitionTo("done"), false);

    assert.throws(
      () => manager.advance(),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError);
        assert.equal(err.fromPhase, "done");
        assert.equal(err.toPhase, "done");
        return true;
      }
    );

    assert.throws(
      () => manager.transitionTo("queued"),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError);
        assert.equal(err.fromPhase, "done");
        assert.equal(err.toPhase, "queued");
        return true;
      }
    );
  });

  it("rejects transition to the current phase (self-transition)", () => {
    const manager = new LifecycleManager({
      runId: "run-self-test",
      initialPhase: "plan",
      emit: () => {},
    });

    assert.equal(manager.canTransitionTo("plan"), false);
    assert.throws(
      () => manager.transitionTo("plan"),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError);
        assert.equal(err.fromPhase, "plan");
        assert.equal(err.toPhase, "plan");
        return true;
      }
    );
  });

  it("rejects backward transitions", () => {
    const manager = new LifecycleManager({
      runId: "run-backward-test",
      initialPhase: "legion",
      emit: () => {},
    });

    const backwardTargets: RunPhase[] = ["queued", "exhume", "plan", "pact_review"];
    for (const target of backwardTargets) {
      assert.equal(manager.canTransitionTo(target), false);
      assert.throws(
        () => manager.transitionTo(target),
        (err: unknown) => {
          assert.ok(err instanceof IllegalTransitionError);
          assert.equal(err.fromPhase, "legion");
          assert.equal(err.toPhase, target);
          return true;
        }
      );
    }
  });

  it("rejects skipping phases forward without early exit flag or reason", () => {
    const manager = new LifecycleManager({
      runId: "run-skip-test",
      initialPhase: "queued",
      emit: () => {},
    });

    // queued -> plan (skipping exhume) without reason/earlyExit
    assert.equal(manager.canTransitionTo("plan"), false);
    assert.throws(
      () => manager.transitionTo("plan"),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError);
        assert.equal(err.fromPhase, "queued");
        assert.equal(err.toPhase, "plan");
        return true;
      }
    );

    // queued -> final_check
    assert.equal(manager.canTransitionTo("final_check"), false);
    assert.throws(() => manager.transitionTo("final_check"), IllegalTransitionError);
  });

  it("isLegalTransition returns false for invalid phase names", () => {
    assert.equal(
      isLegalTransition("queued", "invalid" as RunPhase),
      false
    );
    assert.equal(
      isLegalTransition("invalid" as RunPhase, "exhume"),
      false
    );
  });

  it("async methods transitionToAsync and advanceAsync reject illegal transitions", async () => {
    const manager = new LifecycleManager({
      runId: "run-async-illegal",
      initialPhase: "final_check",
      emit: () => {},
    });

    await assert.rejects(
      async () => manager.transitionToAsync("plan"),
      IllegalTransitionError
    );

    const mDone = new LifecycleManager({
      runId: "run-async-done",
      initialPhase: "done",
      emit: () => {},
    });

    await assert.rejects(
      async () => mDone.advanceAsync(),
      IllegalTransitionError
    );
  });
});

describe("Task 14.5: Early phase exits (Requirement 26.1)", () => {
  it("exits early on user stop (cancelled) from active phases directly to done", () => {
    const activePhases: RunPhase[] = [
      "queued",
      "exhume",
      "plan",
      "pact_review",
      "legion",
      "final_check",
    ];

    for (const phase of activePhases) {
      const emitted: EventEnvelope[] = [];
      const manager = new LifecycleManager({
        runId: `run-cancel-${phase}`,
        initialPhase: phase,
        emit: (e) => {
          emitted.push(e);
        },
      });

      const next = manager.exitEarly("user_stop");
      assert.equal(next, "done");
      assert.equal(manager.phase, "done");
      assert.equal(manager.outcome, "cancelled");
      assert.equal(manager.isTerminal, true);

      assert.equal(emitted.length, 1);
      const data = emitted[0].data as Record<string, unknown>;
      assert.equal(data.phase, "done");
      assert.equal(data.previousPhase, phase);
      assert.equal(data.reason, "user_stop");
      assert.equal(data.outcome, "cancelled");
    }
  });

  it("exits early on admin kill (killed)", () => {
    const emitted: EventEnvelope[] = [];
    const manager = new LifecycleManager({
      runId: "run-admin-kill",
      initialPhase: "legion",
      emit: (e) => {
          emitted.push(e);
        },
    });

    manager.exitEarly("admin_kill");
    assert.equal(manager.phase, "done");
    assert.equal(manager.outcome, "killed");

    const data = emitted[0].data as Record<string, unknown>;
    assert.equal(data.reason, "admin_kill");
    assert.equal(data.outcome, "killed");
  });

  it("exits early on unrecoverable error (error)", () => {
    const emitted: EventEnvelope[] = [];
    const manager = new LifecycleManager({
      runId: "run-unrecov-err",
      initialPhase: "exhume",
      emit: (e) => {
          emitted.push(e);
        },
    });

    manager.exitEarly({
      reason: "unrecoverable_error",
      actor: "supervisor",
      data: { errorDetails: "sandbox collapsed" },
    });

    assert.equal(manager.phase, "done");
    assert.equal(manager.outcome, "error");

    const data = emitted[0].data as Record<string, unknown>;
    assert.equal(data.reason, "unrecoverable_error");
    assert.equal(data.outcome, "error");
    assert.equal(data.errorDetails, "sandbox collapsed");
  });

  it("exits early on budget stop (budget_stopped)", () => {
    const manager = new LifecycleManager({
      runId: "run-budget-stop",
      initialPhase: "legion",
      emit: () => {},
    });

    manager.exitEarly("budget_stopped");
    assert.equal(manager.phase, "done");
    assert.equal(manager.outcome, "budget_stopped");
  });

  it("exits early on healthy_already when no initial failures exist", () => {
    const emitted: EventEnvelope[] = [];
    const manager = new LifecycleManager({
      runId: "run-healthy-exit",
      initialPhase: "exhume",
      emit: (e) => {
          emitted.push(e);
        },
    });

    manager.exitEarly("healthy_already");
    assert.equal(manager.phase, "done");
    assert.equal(manager.outcome, "healthy_already");

    const data = emitted[0].data as Record<string, unknown>;
    assert.equal(data.reason, "healthy_already");
    assert.equal(data.outcome, "healthy_already");
  });

  it("supports early exit route via report phase before done", () => {
    const emitted: EventEnvelope[] = [];
    const manager = new LifecycleManager({
      runId: "run-early-report",
      initialPhase: "legion",
      emit: (e) => {
          emitted.push(e);
        },
    });

    // Jump from legion to report with early exit reason
    const pReport = manager.exitEarly({
      reason: "budget_stopped",
      targetPhase: "report",
    });
    assert.equal(pReport, "report");
    assert.equal(manager.phase, "report");

    // Advance from report to done
    const pDone = manager.advance();
    assert.equal(pDone, "done");
    assert.equal(manager.phase, "done");
    assert.equal(manager.outcome, "budget_stopped");

    assert.equal(emitted.length, 2);
  });

  it("supports asynchronous exitEarlyAsync", async () => {
    const manager = new LifecycleManager({
      runId: "run-async-exit",
      initialPhase: "plan",
      emit: async () => {},
    });

    const res = await manager.exitEarlyAsync("user_stop");
    assert.equal(res, "done");
    assert.equal(manager.phase, "done");
    assert.equal(manager.outcome, "cancelled");
  });
});

describe("Task 14.5: Terminal outcome evaluations (Requirements 26.2, 26.3, 26.14, 41.1, 41.3)", () => {
  it("evaluates to resurrected only when build and tests pass (Requirement 26.3)", () => {
    // 1. Passing build and tests with booleans
    const res1 = evaluateOutcome({
      installPassed: true,
      buildPassed: true,
      testsPassed: true,
    });
    assert.equal(res1, "resurrected");

    // 2. Passing build and tests with exitCode = 0
    const res2 = evaluateOutcome({
      install: { exitCode: 0 },
      build: { exitCode: 0 },
      test: { exitCode: 0 },
    });
    assert.equal(res2, "resurrected");

    // 3. Passing build and tests with status = "passed"
    const res3 = evaluateOutcome({
      finalCheck: {
        installPassed: true,
        buildPassed: true,
        testsPassed: true,
      },
    });
    assert.equal(res3, "resurrected");

    // 4. Must NOT be resurrected if tests failed
    const res4 = evaluateOutcome({
      installPassed: true,
      buildPassed: true,
      testsPassed: false,
    });
    assert.notEqual(res4, "resurrected");
    assert.equal(res4, "partial");

    // 5. Must NOT be resurrected if build failed
    const res5 = evaluateOutcome({
      installPassed: true,
      buildPassed: false,
      testsPassed: true,
    });
    assert.notEqual(res5, "resurrected");
    assert.equal(res5, "partial");
  });

  it("evaluates to resurrected_build_only when repo has no tests and build passes (Requirements 26.14, 41.3)", () => {
    // 1. Explicit hasTests: false and buildPassed: true
    const res1 = evaluateOutcome({
      installPassed: true,
      buildPassed: true,
      hasTests: false,
    });
    assert.equal(res1, "resurrected_build_only");

    // 2. repoHasTests: false
    const res2 = evaluateOutcome({
      installPassed: true,
      buildPassed: true,
      repoHasTests: false,
    });
    assert.equal(res2, "resurrected_build_only");

    // 3. test step marked no_tests_found
    const res3 = evaluateOutcome({
      installPassed: true,
      buildPassed: true,
      test: "no_tests_found",
    });
    assert.equal(res3, "resurrected_build_only");

    // 4. test step object with status: no_tests_found
    const res4 = evaluateOutcome({
      finalCheck: {
        install: { exitCode: 0 },
        build: { exitCode: 0 },
        test: { status: "no_tests_found" },
      },
    });
    assert.equal(res4, "resurrected_build_only");

    // 5. Build failure when repo has no tests must NOT be resurrected_build_only
    const res5 = evaluateOutcome({
      installPassed: true,
      buildPassed: false,
      hasTests: false,
    });
    assert.notEqual(res5, "resurrected_build_only");
    assert.equal(res5, "partial");
  });

  it("evaluates to partial when install passed but build or tests failed or tasks partially succeeded", () => {
    // 1. Install passed, tests failed
    assert.equal(
      evaluateOutcome({
        installPassed: true,
        buildPassed: true,
        testsPassed: false,
      }),
      "partial"
    );

    // 2. Install passed, build failed
    assert.equal(
      evaluateOutcome({
        installPassed: true,
        buildPassed: false,
        testsPassed: false,
      }),
      "partial"
    );

    // 3. Tasks mixed: some merged, some failed
    assert.equal(
      evaluateOutcome({
        tasks: [
          { state: "merged", merged: true },
          { state: "failed", failed: true },
        ],
      }),
      "partial"
    );

    // 4. Tasks mixed: some merged, some skipped
    assert.equal(
      evaluateOutcome({
        tasks: [
          { state: "merged", merged: true },
          { state: "skipped", skipped: true },
        ],
      }),
      "partial"
    );

    // 5. Via evaluateReportOutcome from task states
    assert.equal(
      evaluateReportOutcome({
        tasks: [
          { id: "task-1", state: "merged" },
          { id: "task-2", state: "failed" },
        ],
        installPassed: true,
      }),
      "partial"
    );
  });

  it("evaluates to not_resurrected when repository installation fails (Requirement 41.1)", () => {
    // 1. Explicit installPassed: false
    assert.equal(
      evaluateOutcome({
        installPassed: false,
        buildPassed: true,
        testsPassed: true,
      }),
      "not_resurrected"
    );

    // 2. Even if all tasks were merged, if install failed, outcome is not_resurrected
    assert.equal(
      evaluateOutcome({
        installPassed: false,
        tasks: [
          { state: "merged", merged: true },
          { state: "merged", merged: true },
        ],
      }),
      "not_resurrected"
    );

    // 3. Via evaluateReportOutcome
    assert.equal(
      evaluateReportOutcome({
        installPassed: false,
        mergedTasksCount: 5,
        totalTasksCount: 5,
      }),
      "not_resurrected"
    );

    // 4. Zero tasks merged and failures exist
    assert.equal(
      evaluateOutcome({
        tasks: [
          { state: "failed", failed: true },
          { state: "abandoned", abandoned: true },
        ],
      }),
      "not_resurrected"
    );
  });

  it("evaluates all other early exit outcomes correctly", () => {
    // healthy_already
    assert.equal(evaluateOutcome({ healthyAlready: true }), "healthy_already");
    assert.equal(evaluateOutcome({ noInitialFailures: true }), "healthy_already");
    assert.equal(evaluateOutcome({ initialFailuresCount: 0, userStop: true }), "healthy_already");
    assert.equal(evaluateOutcome({ reason: "healthy_already" }), "healthy_already");

    // cancelled
    assert.equal(evaluateOutcome({ userStop: true }), "cancelled");
    assert.equal(evaluateOutcome({ cancelled: true }), "cancelled");
    assert.equal(evaluateOutcome({ reason: "user_stop" }), "cancelled");
    assert.equal(evaluateOutcome({ reason: "cancelled" }), "cancelled");

    // killed
    assert.equal(evaluateOutcome({ killed: true }), "killed");
    assert.equal(evaluateOutcome({ reason: "admin_kill" }), "killed");

    // budget_stopped
    assert.equal(evaluateOutcome({ budgetStopped: true }), "budget_stopped");
    assert.equal(evaluateOutcome({ budgetExceeded: true }), "budget_stopped");
    assert.equal(evaluateOutcome({ reason: "budget_stopped" }), "budget_stopped");

    // error
    assert.equal(evaluateOutcome({ unrecoverableError: true }), "error");
    assert.equal(evaluateOutcome({ error: new Error("Fatal") }), "error");
    assert.equal(evaluateOutcome({ reason: "unrecoverable_error" }), "error");
  });

  it("evaluates to exactly one outcome among the nine valid RUN_OUTCOMES (Requirement 26.2)", () => {
    const testCases: OutcomeEvaluationInput[] = [
      { installPassed: true, buildPassed: true, testsPassed: true },
      { installPassed: true, buildPassed: true, hasTests: false },
      { installPassed: true, buildPassed: false, testsPassed: false },
      { installPassed: false, buildPassed: false, testsPassed: false },
      { healthyAlready: true },
      { userStop: true },
      { killed: true },
      { budgetStopped: true },
      { unrecoverableError: true },
      { outcome: "resurrected" },
      { outcome: "build-only" },
    ];

    for (const tc of testCases) {
      const outcome = evaluateOutcome(tc);
      assert.ok(
        RUN_OUTCOMES.includes(outcome),
        `Outcome '${outcome}' must be one of RUN_OUTCOMES`
      );
    }
  });

  it("evaluates via LifecycleManager.evaluateOutcome and updates outcome when in done phase", () => {
    const manager = new LifecycleManager({
      runId: "run-lm-eval",
      emit: () => {},
    });

    // Advance to done
    while (manager.phase !== "done") {
      manager.advance();
    }

    assert.equal(manager.outcome, null);
    const evaluated = manager.evaluateOutcome({
      installPassed: true,
      buildPassed: true,
      testsPassed: true,
    });

    assert.equal(evaluated, "resurrected");
    assert.equal(manager.outcome, "resurrected");
    assert.equal(manager.getOutcome(), "resurrected");
  });

  it("evaluateReportOutcomeWithDetails provides full breakdown and evidence", () => {
    const input: TaskItemInput[] = [
      { id: "t1", state: "merged" },
      { id: "t2", state: "failed" },
    ];

    const detailed = evaluateReportOutcomeWithDetails({
      tasks: input,
      installPassed: true,
      buildPassed: false,
    });

    assert.equal(detailed.outcome, "partial");
    assert.equal(detailed.summary.total, 2);
    assert.equal(detailed.summary.merged, 1);
    assert.equal(detailed.summary.failed, 1);
    assert.ok(detailed.evidence.length > 0);
  });
});

describe("Task 14.5: Run completion integration and event sequencing (Requirements 26.13, 26.15)", () => {
  it("emits run.done strictly after all artifacts are ready and all boxes are destroyed", async () => {
    const eventSequence: string[] = [];
    const emittedEvents: EventEnvelope[] = [];

    const manager = new LifecycleManager({
      runId: "run-completion-e2e",
      emit: (e) => {
        eventSequence.push(`event:${e.kind}`);
        emittedEvents.push(e);
      },
    });

    // Advance through the standard lifecycle phases up to report
    manager.advance(); // queued -> exhume
    manager.advance(); // exhume -> plan
    manager.advance(); // plan -> pact_review
    manager.advance(); // pact_review -> legion
    manager.advance(); // legion -> final_check

    // Evaluate outcome at final_check
    const outcome = manager.evaluateOutcome({
      installPassed: true,
      buildPassed: true,
      testsPassed: true,
    });
    assert.equal(outcome, "resurrected");

    manager.advance(); // final_check -> report
    assert.equal(manager.phase, "report");

    // Backend with box tracking
    const backend = createMockExecutionBackend();

    // Prepare complete artifact manifest
    const manifest = createMockManifest(true);

    const startedAt = 10000;
    const endedAt = 25000;

    // Finalize run
    const result = await finalizeRun({
      runId: "run-completion-e2e",
      backend,
      manifest,
      outcome,
      startedAt,
      endedAt,
      lifecycleManager: manager,
      emit: (e) => {
        eventSequence.push(`event:${e.kind}`);
        emittedEvents.push(e);
      },
    });

    assert.equal(result.outcome, "resurrected");
    assert.equal(result.durationMs, 15000);
    assert.equal(manager.phase, "done");
    assert.equal(manager.outcome, "resurrected");
    assert.equal(manager.isTerminal, true);

    // Verify boxes were destroyed
    assert.deepEqual(backend.destroyedBoxIds, [
      "runbox-run-completion-e2e",
      "auditbox-run-completion-e2e",
    ]);

    // Verify event ordering: run.phase (done) before run.done
    const donePhaseIdx = eventSequence.lastIndexOf("event:run.phase");
    const runDoneIdx = eventSequence.indexOf("event:run.done");
    assert.ok(donePhaseIdx >= 0, "run.phase must have been emitted");
    assert.ok(runDoneIdx >= 0, "run.done must have been emitted");
    assert.ok(
      donePhaseIdx < runDoneIdx,
      `run.phase (done) at index ${donePhaseIdx} must precede run.done at index ${runDoneIdx}`
    );

    // Verify run.done payload
    const runDoneEvent = emittedEvents.find((e) => e.kind === "run.done");
    assert.ok(runDoneEvent);
    assert.equal(runDoneEvent.runId, "run-completion-e2e");
    assert.equal(runDoneEvent.ts, endedAt);

    const data = runDoneEvent.data as RunDoneEventData;
    assert.equal(data.outcome, "resurrected");
    assert.equal(data.durationMs, 15000);
    assert.deepEqual(data.boxesDestroyed, [
      "runbox-run-completion-e2e",
      "auditbox-run-completion-e2e",
    ]);
    assert.ok(data.manifest);
    assert.equal((data.manifest as ArtifactManifest).allReady, true);
  });

  it("rejects run finalization and does not emit run.done if artifacts are not ready", async () => {
    const backend = createMockExecutionBackend();
    const incompleteManifest = createMockManifest(false);
    const emitted: EventEnvelope[] = [];

    await assert.rejects(
      async () =>
        finalizeRun({
          runId: "run-incomplete-artifacts",
          backend,
          manifest: incompleteManifest,
          emit: (e) => {
          emitted.push(e);
        },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactsNotStoredError);
        return true;
      }
    );

    // Ensure run.done was NOT emitted
    assert.equal(
      emitted.some((e) => e.kind === "run.done"),
      false
    );
  });

  it("rejects run finalization and does not emit run.done if residual processes remain in strict mode", async () => {
    const backend = createMockExecutionBackend();
    const manifest = createMockManifest(true);
    const emitted: EventEnvelope[] = [];

    await assert.rejects(
      async () =>
        finalizeRun({
          runId: "run-residual-processes",
          backend,
          manifest,
          strictVerification: true,
          residualChecker: {
            checkProcesses: async () => [
              {
                pid: 12345,
                cmdline: "untrusted_binary",
                containerId: "runbox-run-residual-processes",
              },
            ],
            checkMounts: async () => [],
          },
          emit: (e) => {
          emitted.push(e);
        },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResidualStateError);
        return true;
      }
    );

    assert.equal(
      emitted.some((e) => e.kind === "run.done"),
      false
    );
  });
});

describe("Task 14.5: fast-check property tests for lifecycle invariants", () => {
  it("Property: sequential advances strictly increment phase index and terminate at done", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: RUN_PHASES.length - 2 }),
        (startIdx) => {
          const initialPhase = RUN_PHASES[startIdx];
          const emitted: EventEnvelope[] = [];

          const manager = new LifecycleManager({
            runId: `run-prop-${startIdx}`,
            initialPhase,
            emit: (e) => {
          emitted.push(e);
        },
          });

          let current = initialPhase;
          let steps = 0;

          while (manager.phase !== "done") {
            const currentIdx = RUN_PHASES.indexOf(current);
            const next = manager.advance();
            const nextIdx = RUN_PHASES.indexOf(next);

            assert.equal(nextIdx, currentIdx + 1);
            current = next;
            steps++;
          }

          assert.equal(manager.phase, "done");
          assert.equal(manager.isTerminal, true);
          assert.equal(steps, RUN_PHASES.length - 1 - startIdx);
          assert.equal(emitted.length, steps);

          // Done phase is absorbing: further advance throws
          assert.throws(() => manager.advance(), IllegalTransitionError);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property: evaluateOutcome is total, deterministic, and always returns a valid RUN_OUTCOME", () => {
    const boolOrNull = fc.option(fc.boolean(), { nil: undefined });
    const reasonGen = fc.option(
      fc.constantFrom(
        "user_stop",
        "cancelled",
        "admin_kill",
        "budget_stopped",
        "budget_exceeded",
        "unrecoverable_error",
        "healthy_already",
        "fatal"
      ),
      { nil: undefined }
    );

    fc.assert(
      fc.property(
        boolOrNull,
        boolOrNull,
        boolOrNull,
        boolOrNull,
        reasonGen,
        (installPassed, buildPassed, testsPassed, hasTests, reason) => {
          const input: OutcomeEvaluationInput = {
            installPassed,
            buildPassed,
            testsPassed,
            hasTests,
            reason,
          };

          const out1 = evaluateOutcome(input);
          const out2 = evaluateOutcome(input);

          // Purity: deterministic
          assert.equal(out1, out2);

          // Totality: belongs to spec outcomes
          assert.ok(RUN_OUTCOMES.includes(out1));

          // Priority invariant: install failure prevents resurrected
          if (installPassed === false && !reason) {
            assert.equal(out1, "not_resurrected");
          }

          // Priority invariant: resurrected requires build and tests passed
          if (out1 === "resurrected") {
            assert.equal(buildPassed, true);
            assert.equal(testsPassed, true);
          }

          // Priority invariant: resurrected_build_only requires no tests and build passed
          if (out1 === "resurrected_build_only") {
            assert.equal(hasTests, false);
            assert.equal(buildPassed, true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
