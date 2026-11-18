// Task 14.4 / Requirements 26.13, 26.15: Sandbox teardown and run finalization tests
import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import type {
  ExecutionBackend,
  Sandbox,
  SandboxSpec,
} from "../../lib/backend/types";
import type { EventEnvelope } from "../../lib/events/types";
import {
  LifecycleManager,
  type RunOutcome,
  RUN_OUTCOMES,
} from "../../lib/lifecycle/lifecycle-manager";
import type { ArtifactManifest } from "../../lib/lifecycle/artifact-collector";
import {
  RunFinalizer,
  finalizeRun,
  teardownBoxes,
  verifyBoxDestruction,
  createRunDoneEvent,
  resolveRunBoxIds,
  normalizeRunOutcome,
  ResidualStateError,
  ArtifactsNotStoredError,
  type FinalizerExecutionBackend,
  type RunDoneEventData,
  type RunDoneEventEnvelope,
  type ResidualChecker,
  type ResidualVerificationResult,
} from "../../lib/lifecycle/run-finalizer";

function createStubSandbox(id: string, onDestroy?: () => void): Sandbox {
  return {
    id,
    async exec() {
      return {
        seq: 0,
        output: (async function* () {})(),
        async wait() {
          return { exitCode: 0, timedOut: false, oomKilled: false };
        },
      };
    },
    async run() {
      return {
        logRef: `log-${id}`,
        oomKilled: false,
        timedOut: false,
        exitCode: 0,
      };
    },
    async wait() {
      return { exitCode: 0, timedOut: false, oomKilled: false };
    },
    async stop() {},
    async destroy() {
      if (onDestroy) {
        onDestroy();
      }
    },
  };
}

/**
 * Creates a complete mock ExecutionBackend implementing all required methods
 * plus destroyBox() for container teardown.
 */
function createFullExecutionBackend(overrides?: {
  destroyBox?: (boxId: string) => Promise<void>;
  destroy?: (id: string) => Promise<void>;
  get?: (id: string) => Promise<Sandbox | undefined>;
  list?: () => Promise<unknown[]>;
}): ExecutionBackend & {
  destroyBox: (boxId: string) => Promise<void>;
  destroyedBoxIds: string[];
  calls: {
    create: number;
    get: number;
    list: number;
    destroy: number;
    destroyBox: number;
  };
} {
  const destroyedBoxIds: string[] = [];
  const calls = {
    create: 0,
    get: 0,
    list: 0,
    destroy: 0,
    destroyBox: 0,
  };

  const backend: ExecutionBackend & {
    destroyBox: (boxId: string) => Promise<void>;
    destroyedBoxIds: string[];
    calls: typeof calls;
  } = {
    kind: "instabox-docker",
    destroyedBoxIds,
    calls,
    async create(spec: SandboxSpec): Promise<Sandbox> {
      calls.create++;
      return createStubSandbox(spec.idempotencyKey || "sandbox-test");
    },
    async get(id: string): Promise<Sandbox | undefined> {
      calls.get++;
      if (overrides?.get) {
        return overrides.get(id);
      }
      return undefined;
    },
    async list(): Promise<unknown[]> {
      calls.list++;
      if (overrides?.list) {
        return overrides.list();
      }
      return [];
    },
    async destroy(id: string): Promise<void> {
      calls.destroy++;
      destroyedBoxIds.push(id);
      if (overrides?.destroy) {
        await overrides.destroy(id);
      }
    },
    async destroyBox(boxId: string): Promise<void> {
      calls.destroyBox++;
      destroyedBoxIds.push(boxId);
      if (overrides?.destroyBox) {
        await overrides.destroyBox(boxId);
      } else if (overrides?.destroy) {
        await overrides.destroy(boxId);
      }
    },
  };

  return backend;
}

/**
 * Creates a sample ready ArtifactManifest.
 */
function createSampleManifest(runId: string): ArtifactManifest {
  return {
    runId,
    artifactsDir: `/data/runs/${runId}/artifacts`,
    artifacts: {
      patch: {
        kind: "patch",
        path: `/data/runs/${runId}/artifacts/all.patch`,
        fileName: "all.patch",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        byteSize: 120,
        createdAt: 1000,
      },
      spec: {
        kind: "spec",
        path: `/data/runs/${runId}/artifacts/spec.json`,
        fileName: "spec.json",
        sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef",
        byteSize: 340,
        createdAt: 1000,
      },
      report: {
        kind: "report",
        path: `/data/runs/${runId}/artifacts/report.md`,
        fileName: "report.md",
        sha256: "b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef12",
        byteSize: 560,
        createdAt: 1000,
      },
      events: null,
      certificate: null,
    },
    allReady: true,
    createdAt: 1000,
  };
}

describe("Task 14.4: Sandbox teardown via ExecutionBackend.destroyBox (Requirement 26.13)", () => {
  it("invokes backend.destroyBox for runbox and auditbox by default naming convention", async () => {
    const backend = createFullExecutionBackend();
    const runId = "run-test-conv-01";

    const destroyed = await teardownBoxes(backend, runId);

    assert.equal(backend.calls.destroyBox, 2);
    assert.deepEqual(backend.destroyedBoxIds, [
      `runbox-${runId}`,
      `auditbox-${runId}`,
    ]);
    assert.deepEqual(destroyed, [`runbox-${runId}`, `auditbox-${runId}`]);
  });

  it("invokes backend.destroyBox for explicit boxIds", async () => {
    const backend = createFullExecutionBackend();
    const runId = "run-test-explicit-01";
    const explicitIds = ["runbox-custom-1", "auditbox-custom-2", "extra-box-3"];

    const destroyed = await teardownBoxes(backend, runId, explicitIds);

    assert.equal(backend.calls.destroyBox, 3);
    assert.deepEqual(backend.destroyedBoxIds, explicitIds);
    assert.deepEqual(destroyed, explicitIds);
  });

  it("invokes backend.destroyBox for boxes passed as object or array of Sandboxes", async () => {
    const backend = createFullExecutionBackend();
    const runId = "run-test-boxes-obj";

    let runboxDestroyed = false;
    let auditboxDestroyed = false;

    const runboxSandbox: Sandbox = createStubSandbox("runbox-obj-id", () => {
      runboxDestroyed = true;
    });
    const auditboxSandbox: Sandbox = createStubSandbox("auditbox-obj-id", () => {
      auditboxDestroyed = true;
    });

    const destroyed = await teardownBoxes(backend, runId, undefined, {
      boxes: [runboxSandbox, auditboxSandbox],
    });

    assert.equal(backend.calls.destroyBox, 2);
    assert.deepEqual(backend.destroyedBoxIds, ["runbox-obj-id", "auditbox-obj-id"]);
    assert.deepEqual(destroyed, ["runbox-obj-id", "auditbox-obj-id"]);
    assert.equal(runboxDestroyed, true);
    assert.equal(auditboxDestroyed, true);
  });

  it("falls back to destroy(boxId) when destroyBox is absent", async () => {
    let destroyCalledWith: string[] = [];

    // mock backend without destroyBox method
    const backendWithoutDestroyBox: ExecutionBackend = {
      kind: "instabox-docker" as const,
      create: async () => createStubSandbox("dummy-box"),
      get: async () => undefined,
      list: async () => [],
      destroy: async (id: string) => {
        destroyCalledWith.push(id);
      },
    };

    const runId = "run-fallback-destroy";
    const destroyed = await teardownBoxes(backendWithoutDestroyBox, runId);

    assert.deepEqual(destroyCalledWith, [`runbox-${runId}`, `auditbox-${runId}`]);
    assert.deepEqual(destroyed, [`runbox-${runId}`, `auditbox-${runId}`]);
  });
});

describe("Task 14.4: Residual verification (processes, mounts, boxes)", () => {
  it("verifies clean teardown when zero residual boxes, processes, and mounts remain", async () => {
    const backend = createFullExecutionBackend({
      get: async () => undefined, // Not found = destroyed
    });

    const residualChecker: ResidualChecker = {
      checkProcesses: async () => [],
      checkMounts: async () => [],
      checkBoxes: async () => [],
    };

    const result = await verifyBoxDestruction(
      backend,
      "run-clean-01",
      ["runbox-clean", "auditbox-clean"],
      {
        residualChecker,
        hostMountPaths: ["/data/runs/run-clean-01/builders", "/data/runs/run-clean-01/warden"],
      }
    );

    assert.equal(result.verified, true);
    assert.equal(result.residualBoxesCount, 0);
    assert.equal(result.residualProcessesCount, 0);
    assert.equal(result.residualMountsCount, 0);
    assert.deepEqual(result.residualBoxIds, []);
    assert.deepEqual(result.residualProcesses, []);
    assert.deepEqual(result.residualMounts, []);
  });

  it("detects residual container processes and reports them accurately", async () => {
    const backend = createFullExecutionBackend();
    const residualChecker: ResidualChecker = {
      checkProcesses: async (_runId, boxIds) => [
        { pid: 12345, command: "npm test", boxId: boxIds[0] },
      ],
      checkMounts: async () => [],
      checkBoxes: async () => [],
    };

    const result = await verifyBoxDestruction(
      backend,
      "run-residual-proc",
      ["runbox-1", "auditbox-1"],
      { residualChecker }
    );

    assert.equal(result.verified, false);
    assert.equal(result.residualProcessesCount, 1);
    assert.equal(result.residualProcesses[0].pid, 12345);
  });

  it("detects residual host bind mounts and reports them accurately", async () => {
    const backend = createFullExecutionBackend();
    const residualChecker: ResidualChecker = {
      checkProcesses: async () => [],
      checkMounts: async (_runId, mountPaths) => [
        { mountPath: mountPaths[0], source: "/tmp/builders/run-1" },
      ],
      checkBoxes: async () => [],
    };

    const result = await verifyBoxDestruction(
      backend,
      "run-residual-mount",
      ["runbox-1", "auditbox-1"],
      {
        residualChecker,
        hostMountPaths: ["/data/runs/run-1/builders"],
      }
    );

    assert.equal(result.verified, false);
    assert.equal(result.residualMountsCount, 1);
    assert.equal(result.residualMounts[0].mountPath, "/data/runs/run-1/builders");
  });

  it("throws ResidualStateError in strict mode when residual state is found", async () => {
    const backend = createFullExecutionBackend();
    const residualChecker: ResidualChecker = {
      checkProcesses: async () => [{ pid: 9999, command: "node server.js" }],
    };

    await assert.rejects(
      async () => {
        await verifyBoxDestruction(
          backend,
          "run-strict-fail",
          ["runbox-1"],
          {
            residualChecker,
            strict: true,
          }
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof ResidualStateError);
        const rErr = err as ResidualStateError;
        assert.equal(rErr.name, "ResidualStateError");
        assert.equal(rErr.result.residualProcessesCount, 1);
        return true;
      }
    );
  });
});

describe("Task 14.4 / Requirement 26.15: Run Finalization and run.done emission", () => {
  it("rejects finalization if artifactsStored is explicitly false", async () => {
    const backend = createFullExecutionBackend();

    await assert.rejects(
      async () => {
        await finalizeRun({
          runId: "run-art-unready",
          backend,
          artifactsStored: false,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ArtifactsNotStoredError);
        const aErr = err as ArtifactsNotStoredError;
        assert.equal(aErr.runId, "run-art-unready");
        return true;
      }
    );

    // Verify boxes were NOT destroyed because finalization aborted before teardown
    assert.equal(backend.calls.destroyBox, 0);
  });

  it("rejects finalization if manifest.allReady is false", async () => {
    const backend = createFullExecutionBackend();
    const manifest = createSampleManifest("run-art-unready-2");
    // cast through unknown with a comment: test unready manifest
    const unreadyManifest = { ...manifest, allReady: false } as unknown as ArtifactManifest;

    await assert.rejects(
      async () => {
        await finalizeRun({
          runId: "run-art-unready-2",
          backend,
          manifest: unreadyManifest,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ArtifactsNotStoredError);
        return true;
      }
    );
  });

  it("emits run.done strictly AFTER boxes are destroyed and artifacts are stored", async () => {
    const eventsSequence: string[] = [];
    const emittedEvents: EventEnvelope[] = [];

    const backend = createFullExecutionBackend({
      destroyBox: async (boxId: string) => {
        eventsSequence.push(`destroyBox:${boxId}`);
      },
    });

    const manifest = createSampleManifest("run-seq-test");

    const result = await finalizeRun({
      runId: "run-seq-test",
      backend,
      manifest,
      outcome: "resurrected",
      startedAt: 1000,
      endedAt: 3500,
      emit: async (event: EventEnvelope) => {
        eventsSequence.push(`emit:${event.kind}`);
        emittedEvents.push(event);
      },
    });

    // 1. Boxes were destroyed first
    assert.deepEqual(eventsSequence, [
      "destroyBox:runbox-run-seq-test",
      "destroyBox:auditbox-run-seq-test",
      "emit:run.done",
    ]);

    // 2. run.done event is emitted with explicit types
    assert.equal(emittedEvents.length, 1);
    const doneEvent = emittedEvents[0];
    assert.equal(doneEvent.kind, "run.done");
    assert.equal(doneEvent.runId, "run-seq-test");

    const data: RunDoneEventData = doneEvent.data as RunDoneEventData;
    assert.equal(data.phase, "done");
    assert.equal(data.outcome, "resurrected");
    assert.equal(typeof data.durationMs, "number");
    assert.equal(data.durationMs, 2500);
    assert.equal(data.totalDurationMs, 2500);
    assert.equal(data.duration, 2500);
    assert.deepEqual(data.refs, []);
    assert.deepEqual(data.boxesDestroyed, [
      "runbox-run-seq-test",
      "auditbox-run-seq-test",
    ]);
    assert.deepEqual(data.manifest, manifest);

    // 3. Result returned by finalizeRun matches
    assert.equal(result.runId, "run-seq-test");
    assert.equal(result.outcome, "resurrected");
    assert.equal(result.durationMs, 2500);
    assert.deepEqual(result.boxesDestroyed, [
      "runbox-run-seq-test",
      "auditbox-run-seq-test",
    ]);
    assert.equal(result.residualVerification.verified, true);
  });

  it("integrates with LifecycleManager: advances to done and updates outcome", async () => {
    const emittedEvents: EventEnvelope[] = [];
    const lm = new LifecycleManager({
      runId: "run-lm-test",
      initialPhase: "report",
      emit: (e) => {
        emittedEvents.push(e);
      },
    });

    const backend = createFullExecutionBackend();

    const result = await finalizeRun({
      runId: "run-lm-test",
      backend,
      lifecycleManager: lm,
      outcome: "resurrected_build_only",
      startedAt: 100,
      endedAt: 600,
      emit: (e) => {
        emittedEvents.push(e);
      },
    });

    assert.equal(lm.phase, "done");
    assert.equal(lm.outcome, "resurrected_build_only");
    assert.equal(result.outcome, "resurrected_build_only");

    // LifecycleManager emitted run.phase, finalizeRun emitted run.done
    const phaseEvent = emittedEvents.find((e) => e.kind === "run.phase");
    assert.ok(phaseEvent);
    assert.equal((phaseEvent.data as Record<string, unknown>).phase, "done");

    const doneEvent = emittedEvents.find((e) => e.kind === "run.done");
    assert.ok(doneEvent);
    const doneData = doneEvent.data as RunDoneEventData;
    assert.equal(doneData.outcome, "resurrected_build_only");
    assert.equal(doneData.durationMs, 500);
  });

  it("handles explicit durationMs override and actor configuration", async () => {
    const backend = createFullExecutionBackend();
    let capturedEvent: EventEnvelope | undefined;

    await finalizeRun({
      runId: "run-override-test",
      backend,
      durationMs: 42000,
      actor: "test-actor",
      seq: 42,
      outcome: "partial",
      emit: (e) => {
        capturedEvent = e;
      },
    });

    assert.ok(capturedEvent);
    assert.equal(capturedEvent.actor, "test-actor");
    assert.equal(capturedEvent.seq, 42);

    const data = capturedEvent.data as RunDoneEventData;
    assert.equal(data.durationMs, 42000);
    assert.equal(data.totalDurationMs, 42000);
    assert.equal(data.outcome, "partial");
  });

  it("works seamlessly via RunFinalizer class instance", async () => {
    const backend = createFullExecutionBackend();
    const finalizer = new RunFinalizer({
      backend,
      actor: "run-finalizer-class",
    });

    let emittedDone: EventEnvelope | undefined;
    const result = await finalizer.finalize({
      runId: "run-class-test",
      outcome: "cancelled",
      startedAt: 100,
      endedAt: 250,
      emit: (e) => {
        emittedDone = e;
      },
    });

    assert.equal(result.outcome, "cancelled");
    assert.equal(result.durationMs, 150);
    assert.equal(backend.calls.destroyBox, 2);

    assert.ok(emittedDone);
    const data = emittedDone.data as RunDoneEventData;
    assert.equal(data.outcome, "cancelled");
    assert.equal(emittedDone.actor, "run-finalizer-class");
  });
});

describe("Task 14.4: Pure helper functions and outcome normalization", () => {
  it("resolveRunBoxIds gathers all IDs from conventions, explicit arrays and objects", async () => {
    const ids = await resolveRunBoxIds("test-run-1", null, {
      boxIds: ["box-1", "box-2"],
      boxes: {
        runbox: "box-3",
        auditbox: createStubSandbox("box-4"),
      },
      runbox: "box-5",
      auditbox: "box-6",
    });

    assert.equal(ids.includes("box-1"), true);
    assert.equal(ids.includes("box-2"), true);
    assert.equal(ids.includes("box-3"), true);
    assert.equal(ids.includes("box-4"), true);
    assert.equal(ids.includes("box-5"), true);
    assert.equal(ids.includes("box-6"), true);
  });

  it("normalizeRunOutcome maps all 9 spec terminal outcomes correctly", () => {
    for (const outcome of RUN_OUTCOMES) {
      assert.equal(normalizeRunOutcome(outcome), outcome);
      assert.equal(normalizeRunOutcome(outcome.toUpperCase()), outcome);
    }
    assert.equal(normalizeRunOutcome("build-only"), "resurrected_build_only");
    assert.equal(normalizeRunOutcome(undefined), "not_resurrected");
    assert.equal(normalizeRunOutcome("unknown_string"), "not_resurrected");
  });

  it("createRunDoneEvent constructs a valid typed envelope", () => {
    const manifest = createSampleManifest("run-direct-event");
    const event = createRunDoneEvent(
      "run-direct-event",
      "healthy_already",
      1234,
      manifest,
      {
        seq: 5,
        ts: 9999,
        actor: "necromancer",
        boxesDestroyed: ["runbox-1", "auditbox-1"],
      }
    );

    assert.equal(event.kind, "run.done");
    assert.equal(event.runId, "run-direct-event");
    assert.equal(event.seq, 5);
    assert.equal(event.ts, 9999);
    assert.equal(event.actor, "necromancer");

    const data = event.data as RunDoneEventData;
    assert.equal(data.outcome, "healthy_already");
    assert.equal(data.durationMs, 1234);
    assert.deepEqual(data.boxesDestroyed, ["runbox-1", "auditbox-1"]);
    assert.deepEqual(data.refs, []);
  });
});

describe("Task 14.4: fast-check property testing for finalizer robustness", () => {
  it("never throws unexpected errors and always produces valid durationMs >= 0", () => {
    fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.constantFrom(...RUN_OUTCOMES),
        fc.nat(100000),
        fc.nat(100000),
        async (runIdSuffix, outcome, t1, t2) => {
          const runId = `run-${runIdSuffix.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
          const startedAt = Math.min(t1, t2);
          const endedAt = Math.max(t1, t2);

          const backend = createFullExecutionBackend();
          const emitted: EventEnvelope[] = [];

          const result = await finalizeRun({
            runId,
            backend,
            outcome,
            startedAt,
            endedAt,
            emit: (e) => {
              emitted.push(e);
            },
          });

          assert.equal(result.outcome, outcome);
          assert.equal(result.durationMs, endedAt - startedAt);
          assert.ok(result.durationMs >= 0);
          assert.equal(emitted.length, 1);

          const data = emitted[0].data as RunDoneEventData;
          assert.equal(data.outcome, outcome);
          assert.equal(data.durationMs, endedAt - startedAt);
          assert.equal(data.phase, "done");
          assert.equal(backend.calls.destroyBox, 2);
        }
      ),
      { numRuns: 30 }
    );
  });
});
