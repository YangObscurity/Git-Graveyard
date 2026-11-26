import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RunStore } from "../../lib/runs/run-store";
import { EventStore } from "../../lib/events/event-store";
import {
  PactService,
  DEFAULT_PACT_IDLE_LIMIT_MS,
  type DeathCertificateLike,
} from "../../lib/pact/pact-service";
import type { PactTask } from "../../lib/pact/pact-parser";
import { NON_REMOVABLE_REQUIREMENTS } from "../../lib/pact/pact-review";

function createHarness(options?: { pactIdleLimitMs?: number }) {
  const db = new DatabaseSync(":memory:");
  const runStore = new RunStore(db);
  const eventStore = new EventStore(db);
  const service = new PactService({
    runStore,
    eventStore,
    pactIdleLimitMs: options?.pactIdleLimitMs ?? 1000, // 1 second for fast test
  });

  return {
    db,
    runStore,
    eventStore,
    service,
    createRun: (
      runId: string,
      phase:
        | "queued"
        | "exhume"
        | "plan"
        | "pact_review"
        | "legion"
        | "final_check"
        | "report"
        | "done" = "pact_review",
      sandboxId: string | null = "sandbox-1"
    ) => {
      return runStore.createRun({
        runId,
        url: "https://github.com/example/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase,
        outcome: null,
        sandboxId,
        caps: { maxMinutes: 60, maxParallel: 2 },
      });
    },
  };
}

function createSampleTasks(): PactTask[] {
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
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 1,
    },
    {
      id: "T2",
      title: "Migrate request calls",
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
      files: ["package.json"],
      filesInScope: ["package.json"],
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
      title: "Scribe report compilation",
      role: "bonesetter",
      dependencies: ["T3"],
      depends: ["T3"],
      dependsOn: ["T3"],
      files: ["package.json"],
      filesInScope: ["package.json"],
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
      title: "Grimoire syntax gate verification",
      role: "bonesetter",
      dependencies: ["T4"],
      depends: ["T4"],
      dependsOn: ["T4"],
      files: ["package.json"],
      filesInScope: ["package.json"],
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

describe("PactService: Core Mutation and State Tracking", () => {
  it("edits pact and tracks state versions correctly", () => {
    const { service, createRun } = createHarness();
    createRun("run-svc-1", "plan");

    const editRes = service.edit("run-svc-1", {
      tasks: createSampleTasks(),
    });
    assert.equal(editRes.ok, true);
    assert.equal(editRes.pactVersion, 1);

    const state = service.getState("run-svc-1");
    assert.equal(state.latestVersion, 1);
    assert.equal(state.hasPact, true);
    assert.equal(state.currentTasks.length, 5);
  });

  it("approves pact and advances to legion", () => {
    const { service, createRun } = createHarness();
    createRun("run-svc-2", "pact_review");

    service.edit("run-svc-2", {
      tasks: createSampleTasks(),
    });

    const approveRes = service.approve("run-svc-2", {
      approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
      budget: { maxMinutes: 30, maxParallel: 2 },
    });

    assert.equal(approveRes.ok, true);
    assert.equal(approveRes.phase, "legion");

    const state = service.getState("run-svc-2");
    assert.equal(state.isApproved, true);
    assert.equal(state.approvedRecord?.pactVersion, 1);
  });

  it("requests revision and records pending revision", () => {
    const { service, createRun } = createHarness();
    createRun("run-svc-3", "pact_review");

    service.edit("run-svc-3", {
      tasks: createSampleTasks(),
    });

    const revRes = service.revise("run-svc-3", {
      feedback: "Please add more details to T2",
    });

    assert.equal(revRes.ok, true);
    assert.equal(revRes.feedback, "Please add more details to T2");

    const state = service.getState("run-svc-3");
    assert.equal(state.pendingRevision, "Please add more details to T2");
  });

  it("stops run cleanly", () => {
    const { service, createRun } = createHarness();
    createRun("run-svc-4", "pact_review");

    const stopRes = service.stop("run-svc-4", {
      reason: "cancelled_by_user",
    });

    assert.equal(stopRes.ok, true);
    assert.equal(stopRes.phase, "done");
    assert.equal(stopRes.outcome, "cancelled");
  });
});

describe("PactService: Approval Events (Requirement 13.4)", () => {
  it("emits pact.approved with pactVersion, approvedTaskIds, and budget (Requirement 13.4)", () => {
    const { service, createRun, eventStore } = createHarness();
    createRun("run-appr-ev", "pact_review");

    service.edit("run-appr-ev", { tasks: createSampleTasks() });

    const approvalResult = service.approve("run-appr-ev", {
      approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
      budget: { maxMinutes: 45, maxParallel: 2, maxToolCalls: 100 },
    });

    assert.equal(approvalResult.ok, true);
    assert.equal(approvalResult.pactVersion, 1);
    assert.equal(approvalResult.phase, "legion");

    // Inspect event store for pact.approved event
    const events = eventStore.getEvents("run-appr-ev", { kinds: ["pact.approved"] });
    assert.equal(events.length, 1);

    const data = events[0].data as Record<string, unknown>;
    assert.equal(data.pactVersion, 1);
    assert.deepEqual(data.approvedTaskIds, ["T1", "T2", "T3", "T4", "T5"]);
    assert.deepEqual(data.budget, { maxMinutes: 45, maxParallel: 2, maxToolCalls: 100 });
  });

  it("rejects approval if approvedTaskIds is empty or budget is missing", () => {
    const { service, createRun } = createHarness();
    createRun("run-appr-bad", "pact_review");

    service.edit("run-appr-bad", { tasks: createSampleTasks() });

    // Missing approvedTaskIds
    const res1 = service.approve("run-appr-bad", {
      approvedTaskIds: [],
      budget: { maxMinutes: 30, maxParallel: 2 },
    });
    assert.equal(res1.ok, false);
    assert.match(res1.error ?? "", /approvedTaskIds/);

    // Missing budget
    const res2 = service.approve("run-appr-bad", {
      approvedTaskIds: ["T1"],
      // @ts-expect-error test missing budget
      budget: null,
    });
    assert.equal(res2.ok, false);
    assert.match(res2.error ?? "", /budget/);
  });
});

describe("PactService: Parking and Resume Lifecycle (Requirements 13.6, 13.7)", () => {
  it("detects idle timeout in pact_review phase", () => {
    const { service, createRun } = createHarness({ pactIdleLimitMs: 1000 });
    const run = createRun("run-idle", "pact_review");

    // Immediately after creation, not idle
    const check1 = service.checkIdle("run-idle", run.createdAt + 100);
    assert.equal(check1.idle, false);

    // After 2 seconds (limit is 1000ms), is idle
    const check2 = service.checkIdle("run-idle", run.createdAt + 2000);
    assert.equal(check2.idle, true);
  });

  it("does not flag idle in non-pact_review phases", () => {
    const { service, createRun } = createHarness({ pactIdleLimitMs: 1000 });
    const run = createRun("run-idle-legion", "legion");

    const check = service.checkIdle("run-idle-legion", run.createdAt + 5000);
    assert.equal(check.idle, false);
    assert.equal(check.elapsedMs, 0);
  });

  it("parks run, preserves pact, pauses clock, and releases runbox (Requirements 13.1, 13.6)", () => {
    const { service, createRun, runStore, eventStore } = createHarness();
    createRun("run-park-1", "pact_review", "box-123");

    // Populate pact
    service.edit("run-park-1", {
      tasks: createSampleTasks(),
    });

    const parkRes = service.parkRun("run-park-1", "idle_limit_exceeded");
    assert.equal(parkRes.ok, true);
    assert.equal(parkRes.parked, true);
    assert.equal(parkRes.pactPreserved, true);
    assert.equal(parkRes.runboxReleased, true);

    // Runbox released (sandboxId cleared)
    const run = runStore.getRun("run-park-1");
    assert.equal(run?.sandboxId, null);
    assert.equal(run?.metadata?.isParked, true);
    assert.equal(run?.metadata?.parkedPactVersion, 1);

    // Pact is still preserved in state
    const state = service.getState("run-park-1");
    assert.equal(state.hasPact, true);
    assert.equal(state.latestVersion, 1);

    // Clock paused (Requirement 13.1)
    const clockEvents = eventStore.getEvents("run-park-1", { kinds: ["run.clock"] });
    assert.equal(clockEvents.length >= 1, true);
    assert.equal((clockEvents[clockEvents.length - 1].data as any).action, "pause");

    // Necromancer decision event emitted
    const decisions = eventStore.getEvents("run-park-1", { kinds: ["necromancer.decision"] });
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0].data as any).action, "park_run");
  });

  it("returns failure when parking non-existent run", () => {
    const { service } = createHarness();
    const result = service.parkRun("non-existent-run");
    assert.equal(result.ok, false);
    assert.equal(result.parked, false);
  });

  it("resumes parked run, re-queues with same pact and flags re-clone (Requirement 13.7)", () => {
    const { service, createRun, runStore, eventStore } = createHarness();
    createRun("run-resume-1", "pact_review", "box-456");

    service.edit("run-resume-1", {
      tasks: createSampleTasks(),
    });

    service.parkRun("run-resume-1");

    // Now resume
    const resumeRes = service.resumeRun("run-resume-1");
    assert.equal(resumeRes.ok, true);
    assert.equal(resumeRes.resumed, true);
    assert.equal(resumeRes.requiresReclone, true);
    assert.equal(resumeRes.pactPreserved, true);
    assert.equal(resumeRes.phase, "queued");

    const run = runStore.getRun("run-resume-1");
    assert.equal(run?.phase, "queued");
    assert.equal(run?.metadata?.isParked, false);
    assert.equal(run?.metadata?.requiresReclone, true);

    // Same pact is kept
    const state = service.getState("run-resume-1");
    assert.equal(state.hasPact, true);
    assert.equal(state.latestVersion, 1);

    // Events emitted
    const queuedEvents = eventStore.getEvents("run-resume-1", { kinds: ["run.queued"] });
    assert.equal(queuedEvents.length, 1);
    assert.equal((queuedEvents[0].data as any).reclone, true);
    assert.equal((queuedEvents[0].data as any).pactVersion, 1);
  });

  it("returns failure when resuming non-existent run", () => {
    const { service } = createHarness();
    const result = service.resumeRun("non-existent-run");
    assert.equal(result.ok, false);
    assert.equal(result.resumed, false);
  });
});

describe("PactService: Skeleton Raising Gating and Revision Locking (Requirements 13.8, 13.9, 13.10)", () => {
  it("disallows Bonesetter, Soul-stitcher, Warden, Scribe before pact.approved (Requirement 13.8)", () => {
    const { service, createRun } = createHarness();
    createRun("run-gate-1", "pact_review");

    for (const role of ["bonesetter", "soul-stitcher", "warden", "scribe"]) {
      const check = service.canRaiseSkeleton("run-gate-1", role);
      assert.equal(check.allowed, false);
      assert.match(check.reason ?? "", /pact\.approved/);
    }
  });

  it("allows Bonesetter, Soul-stitcher, Warden, Scribe after pact.approved (Requirement 13.8)", () => {
    const { service, createRun } = createHarness();
    createRun("run-gate-2", "pact_review");

    service.edit("run-gate-2", { tasks: createSampleTasks() });
    service.approve("run-gate-2", {
      approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
      budget: { maxMinutes: 60, maxParallel: 2 },
    });

    for (const role of ["bonesetter", "soul-stitcher", "warden", "scribe"]) {
      const check = service.canRaiseSkeleton("run-gate-2", role);
      assert.equal(check.allowed, true);
    }
  });

  it("requires revision approval during legion before raising revision skeleton (Requirement 13.10)", () => {
    const { service, createRun, eventStore } = createHarness();
    createRun("run-rev-guard", "legion");

    service.edit("run-rev-guard", { tasks: createSampleTasks() });
    service.approve("run-rev-guard", {
      approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
      budget: { maxMinutes: 60, maxParallel: 2 },
    });

    // Before new revision, raising is allowed
    assert.equal(service.canRaiseSkeleton("run-rev-guard", "soul-stitcher").allowed, true);

    // Now revision is drafted during legion
    eventStore.append({
      runId: "run-rev-guard",
      kind: "pact.revision",
      actor: "planner",
      data: { pactVersion: 2, feedback: "Split T2 into T2a and T2b", refs: [] },
    });

    // Raising skeleton for revision is blocked until approved
    const checkBlocked = service.canRaiseSkeleton("run-rev-guard", "soul-stitcher", { isRevision: true });
    assert.equal(checkBlocked.allowed, false);
    assert.match(checkBlocked.reason ?? "", /Revision drafted during legion/);

    // User approves the revision
    service.approve("run-rev-guard", {
      pactVersion: 2,
      approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
      budget: { maxMinutes: 60, maxParallel: 2 },
    });

    // Raising revision skeleton is now allowed
    const checkAllowed = service.canRaiseSkeleton("run-rev-guard", "soul-stitcher", { isRevision: true });
    assert.equal(checkAllowed.allowed, true);
  });

  it("enforces Exhumer requires run.started and Planner requires exhume.certificate (Requirement 13.9)", () => {
    const { service, createRun, eventStore } = createHarness();
    createRun("run-early", "queued");

    // Exhumer without run.started is blocked
    const exhumerCheck1 = service.canRaiseSkeleton("run-early", "exhumer");
    assert.equal(exhumerCheck1.allowed, false);

    // Planner without exhume.certificate is blocked
    const plannerCheck1 = service.canRaiseSkeleton("run-early", "planner");
    assert.equal(plannerCheck1.allowed, false);

    // Emit run.started
    eventStore.append({
      runId: "run-early",
      kind: "run.started",
      actor: "necromancer",
      data: { refs: [] },
    });

    const exhumerCheck2 = service.canRaiseSkeleton("run-early", "exhumer");
    assert.equal(exhumerCheck2.allowed, true);

    // Emit exhume.certificate
    eventStore.append({
      runId: "run-early",
      kind: "exhume.certificate",
      actor: "exhumer",
      data: { refs: [] },
    });

    const plannerCheck2 = service.canRaiseSkeleton("run-early", "planner");
    assert.equal(plannerCheck2.allowed, true);
  });
});

describe("PactService: Failure Coverage Verification (Requirement 12.14)", () => {
  it("returns ok: true when all failures are covered by tasks", () => {
    const { service } = createHarness();
    const tasks = createSampleTasks();

    const deathCert: DeathCertificateLike = {
      failures: [
        { ruleId: "M1", file: "package.json", description: "Deprecated dep" },
        { ruleId: "M2", file: "lib/request.js", description: "Request call" },
      ],
    };

    const coverage = service.verifyFailureCoverage(tasks, deathCert);
    assert.equal(coverage.ok, true);
    assert.equal(coverage.coveredFailures.length, 2);
    assert.equal(coverage.uncoveredFailures.length, 0);
  });

  it("maps uncovered failures to uncoveredFailures (Not addressed by any task)", () => {
    const { service } = createHarness();
    const tasks = createSampleTasks();

    const deathCert: DeathCertificateLike = {
      failures: [
        { ruleId: "M1", file: "package.json", description: "Deprecated dep" },
        { ruleId: "M2", file: "lib/request.js", description: "Request call" },
        { ruleId: "M99", file: "unknown/path.py", description: "Python error" },
      ],
    };

    const coverage = service.verifyFailureCoverage(tasks, deathCert);
    assert.equal(coverage.ok, false);
    assert.equal(coverage.coveredFailures.length, 2);
    assert.equal(coverage.uncoveredFailures.length, 1);
    assert.equal(coverage.uncoveredFailures[0].ruleId, "M99");
    assert.equal(coverage.uncoveredFailures[0].file, "unknown/path.py");
  });

  it("matches failures by stage in task title", () => {
    const { service } = createHarness();
    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Fix build failure in compiler",
        role: "bonesetter",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["Makefile"],
        filesInScope: ["Makefile"],
        acceptanceCommand: "make",
        accept: "make",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M1"],
        ruleIds: ["M1"],
        line: 1,
      },
    ];

    const deathCert: DeathCertificateLike = {
      failures: [{ stage: "build", message: "Build error" }],
    };

    const coverage = service.verifyFailureCoverage(tasks, deathCert);
    assert.equal(coverage.ok, true);
    assert.equal(coverage.coveredFailures.length, 1);
  });

  it("handles empty or missing failures in death certificate", () => {
    const { service } = createHarness();
    const tasks = createSampleTasks();

    assert.equal(service.verifyFailureCoverage(tasks, null).ok, true);
    assert.equal(service.verifyFailureCoverage(tasks, undefined).ok, true);
    assert.equal(service.verifyFailureCoverage(tasks, { failures: [] }).ok, true);
  });
});

describe("PactService: Non-Removable Requirements (Requirement 13.5)", () => {
  it("verifies all non-removable requirements present", () => {
    const { service } = createHarness();
    const tasks = createSampleTasks();

    const check = service.verifyNonRemovableRequirements(tasks);
    assert.equal(check.ok, true);
    assert.equal(check.missing.length, 0);
  });

  it("detects missing warden_final_check", () => {
    const { service } = createHarness();
    const tasks = createSampleTasks().filter((t) => !t.title.includes("Warden"));

    const check = service.verifyNonRemovableRequirements(tasks);
    assert.equal(check.ok, false);
    assert.deepEqual(check.missing, ["warden_final_check"]);
  });

  it("detects missing scribe_report", () => {
    const { service } = createHarness();
    const tasks = createSampleTasks().filter((t) => !t.title.includes("Scribe"));

    const check = service.verifyNonRemovableRequirements(tasks);
    assert.equal(check.ok, false);
    assert.deepEqual(check.missing, ["scribe_report"]);
  });

  it("detects missing grimoire_gate", () => {
    const { service } = createHarness();
    const tasks = createSampleTasks().filter(
      (t) => !t.title.includes("Grimoire") && !t.title.includes("syntax")
    );

    const check = service.verifyNonRemovableRequirements(tasks);
    assert.equal(check.ok, false);
    assert.deepEqual(check.missing, ["grimoire_gate"]);
  });

  it("detects all missing non-removable requirements when none present", () => {
    const { service } = createHarness();
    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Just a plain task",
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
    ];

    const check = service.verifyNonRemovableRequirements(tasks);
    assert.equal(check.ok, false);
    assert.deepEqual(check.missing, [
      "warden_final_check",
      "scribe_report",
      "grimoire_gate",
    ]);
  });
});
