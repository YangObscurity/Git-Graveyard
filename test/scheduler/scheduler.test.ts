// Task 13.2 / 13.5: Unit and property tests for Scheduler and ready-task order
// Requirements: 13.8, 13.9, 13.10, 23.1, 23.2, 23.3, 23.4, 23.5, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14, 23.15

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { before, describe, it } from "node:test";
import * as fc from "fast-check";

import {
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
  MODEL_TIER_OPUS,
  MODEL_TIER_SONNET,
} from "../../lib/agents/model-allowlist";
import type { EventEnvelope } from "../../lib/events/types";
import type { PactTask } from "../../lib/pact/pact-parser";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import { GitService, VerifiedMerge } from "../../lib/git/git-service";
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import { Scheduler } from "../../lib/scheduler/scheduler";
import type { ScheduledTask, TaskMergeEvidence } from "../../lib/scheduler/types";
import { EventStore } from "../../lib/events/event-store";

// Work package SA2: the scheduler merge path only accepts a VerifiedMerge
// issued by GitService.mergeCandidate. Build one real proof for this file and
// rebuild the per-task evidence around it.
interface Sa2RealMergeProof {
  verifiedMerge: VerifiedMerge;
  candidateSha: string;
  candidateSha256: string;
  diff: string;
  tree: string;
}

async function createSa2RealMergeProof(): Promise<Sa2RealMergeProof> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-sa2-t-"));
  try {
    const gitDir = path.join(tmpDir, "git");
    fs.mkdirSync(gitDir, { recursive: true });

    const runGit = (args: string[]): string =>
      childProcess
        .execFileSync("git", args, {
          cwd: gitDir,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            HOME: tmpDir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          } as unknown as NodeJS.ProcessEnv,
        })
        .trim();

    runGit(["init", "--initial-branch=main", "."]);
    runGit(["config", "user.name", "Test Runner"]);
    runGit(["config", "user.email", "runner@example.test"]);
    fs.writeFileSync(path.join(gitDir, "base.txt"), "line 1: base\n", "utf8");
    runGit(["add", "base.txt"]);
    runGit(["commit", "-m", "initial base commit"]);
    const baseSha = runGit(["rev-parse", "HEAD"]);

    const integrationBranch = "graveyard/run-sa2-t";
    runGit(["branch", integrationBranch, baseSha]);
    runGit(["checkout", "-b", "task/sa2-t", integrationBranch]);
    fs.writeFileSync(
      path.join(gitDir, "base.txt"),
      "line 1: base\nline 2: candidate addition\n",
      "utf8"
    );
    runGit(["add", "."]);
    runGit(["commit", "-m", "sa2 candidate work"]);
    const candidateSha = runGit(["rev-parse", "HEAD"]);
    const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
    runGit(["checkout", integrationBranch]);

    const diff = childProcess.execFileSync(
      "git",
      ["diff", "--binary", "--no-color", `${baseSha}..${candidateSha}`],
      { cwd: gitDir, encoding: "utf8" }
    );
    const candidateSha256 = candidateSha256FromDiff(diff);

    const service = new GitService({ runsDir: tmpDir });
    const verdict = buildVerdictRecord(candidateSha, {
      verdict: "approve",
      diff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });
    const mergeResult = await (service as any).mergeCandidate({
      runId: "run-sa2-t",
      candidateSha,
      expectedIntegrationHeadSha: baseSha,
      verdict,
      verdictCandidateSha256: candidateSha256,
      gateResult: { ok: true, tree },
      gitDir,
    });
    assert.ok(mergeResult instanceof VerifiedMerge);

    return {
      verifiedMerge: mergeResult as VerifiedMerge,
      candidateSha,
      candidateSha256,
      diff,
      tree,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

let sa2RealProof: Sa2RealMergeProof;

before(async () => {
  sa2RealProof = await createSa2RealMergeProof();
});

function createPassingEvidence(taskId: string): TaskMergeEvidence {
  const proof = sa2RealProof;
  const diff = proof.diff;
  const tree = proof.tree;
  const candidateSha = proof.candidateSha;
  const candidateSha256 = proof.candidateSha256;
  const eventSource = new EventStore(":memory:");
  eventSource.append({
    runId: "run-sa2-t",
    kind: "task.state",
    actor: "scheduler",
    taskId,
    data: {
      taskId,
      state: "in_review",
    },
  });
  eventSource.append({
    runId: "run-sa2-t",
    kind: "gate.result",
    actor: "grimoire",
    taskId,
    data: {
      taskId,
      ok: true,
      tree,
    },
  });
  eventSource.append({
    runId: "run-sa2-t",
    kind: "verdict",
    actor: "warden",
    taskId,
    data: {
      taskId,
      verdict: "approve",
      candidateSha256,
      target: taskId,
      tree,
      refs: ["cmd:test"],
    },
  });
  return {
    taskId,
    runId: "run-sa2-t",
    diff,
    tree,
    candidateSha,
    candidateSha256,
    eventSource,
    gitMerge: proof.verifiedMerge as unknown as TaskMergeEvidence["gitMerge"],
    verdict: buildVerdictRecord(candidateSha, {
      target: taskId,
      taskId,
      verdict: "approve",
      diff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    }),
    gateResult: {
      ok: true,
      gate: "syntax",
      kind: "gate.result",
      tree,
    },
  };
}

const SAMPLE_TASKS_MD = `
- [ ] T1. Manifest dependency update
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1, M2
- [ ] T2. Migrate request calls to requestCompat
  - role: soul-stitcher
  - depends: T1
  - files: lib/fetcher.js
  - accept: npm test
  - hard: yes
  - rules: M2
- [ ] T3. Update build configuration
  - role: soul-stitcher
  - depends: T1
  - files: webpack.config.js
  - accept: npm test
  - hard: no
  - rules: M3
- [ ] T4. Integration verification
  - role: soul-stitcher
  - depends: T2, T3
  - files: index.js
  - accept: npm test
  - hard: yes
  - rules: M1, M2
`;

function createMockPactTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Manifest dependency update",
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
      rules: ["M1", "M2"],
      ruleIds: ["M1", "M2"],
      line: 2,
    },
    {
      id: "T2",
      title: "Migrate request calls to requestCompat",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/fetcher.js"],
      filesInScope: ["lib/fetcher.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M2"],
      ruleIds: ["M2"],
      line: 9,
    },
    {
      id: "T3",
      title: "Update build configuration",
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
      rules: ["M3"],
      ruleIds: ["M3"],
      line: 16,
    },
    {
      id: "T4",
      title: "Integration verification",
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
      rules: ["M1", "M2"],
      ruleIds: ["M1", "M2"],
      line: 23,
    },
  ];
}

describe("test/scheduler: Ready-task order and dispatch priority (Requirement 23.14)", () => {
  it("orders ready tasks strictly by original order in tasks.md (Requirement 23.14)", () => {
    const tasks: PactTask[] = [
      {
        id: "task-01",
        title: "First task",
        role: "bonesetter",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["a.js"],
        filesInScope: ["a.js"],
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
        id: "task-02",
        title: "Second task",
        role: "soul-stitcher",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["b.js"],
        filesInScope: ["b.js"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M2"],
        ruleIds: ["M2"],
        line: 8,
      },
      {
        id: "task-03",
        title: "Third task",
        role: "soul-stitcher",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["c.js"],
        filesInScope: ["c.js"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: true,
        hardFlag: true,
        hardRaw: "yes",
        rules: ["M3"],
        ruleIds: ["M3"],
        line: 15,
      },
    ];

    const scheduler = new Scheduler(tasks, { runParallelCap: 3 });
    const readyTasks = scheduler.getReadyTasks();

    assert.equal(readyTasks.length, 3);
    assert.equal(readyTasks[0].id, "task-01");
    assert.equal(readyTasks[1].id, "task-02");
    assert.equal(readyTasks[2].id, "task-03");

    // Order numbers must be strictly increasing
    assert.ok(readyTasks[0].order < readyTasks[1].order);
    assert.ok(readyTasks[1].order < readyTasks[2].order);
  });

  it("dispatches ready tasks in priority order when slots are limited (Requirement 23.14)", () => {
    const tasks = createMockPactTasks();
    for (const t of tasks) {
      t.dependencies = [];
      t.depends = [];
      t.dependsOn = [];
    }

    const scheduler = new Scheduler(tasks, { runParallelCap: 2 });
    assert.equal(scheduler.getAvailableSlots(), 2);

    const ready = scheduler.getReadyTasks();
    assert.deepEqual(
      ready.map((t) => t.id),
      ["T1", "T2", "T3", "T4"]
    );

    const firstDispatch = scheduler.dispatchNext(1);
    assert.equal(firstDispatch.length, 1);
    assert.equal(firstDispatch[0].id, "T1");
    assert.equal(firstDispatch[0].state, "running");

    assert.deepEqual(
      scheduler.getReadyTasks().map((t) => t.id),
      ["T2", "T3", "T4"]
    );

    const secondDispatch = scheduler.dispatchNext();
    assert.equal(secondDispatch.length, 1);
    assert.equal(secondDispatch[0].id, "T2");
    assert.equal(secondDispatch[0].state, "running");

    assert.equal(scheduler.getAvailableSlots(), 0);
    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);

    assert.deepEqual(
      scheduler.getReadyTasks().map((t) => t.id),
      ["T3", "T4"]
    );
  });

  it("preserves priority order when tasks dynamically unblock after dependency merges (Requirement 23.2, 23.14)", () => {
    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Root task",
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
        title: "Dependent task A",
        role: "soul-stitcher",
        dependencies: ["T1"],
        depends: ["T1"],
        dependsOn: ["T1"],
        files: ["a.js"],
        filesInScope: ["a.js"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M2"],
        ruleIds: ["M2"],
        line: 8,
      },
      {
        id: "T3",
        title: "Independent task",
        role: "soul-stitcher",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["b.js"],
        filesInScope: ["b.js"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M3"],
        ruleIds: ["M3"],
        line: 15,
      },
      {
        id: "T4",
        title: "Dependent task B",
        role: "soul-stitcher",
        dependencies: ["T1"],
        depends: ["T1"],
        dependsOn: ["T1"],
        files: ["c.js"],
        filesInScope: ["c.js"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: true,
        hardFlag: true,
        hardRaw: "yes",
        rules: ["M2"],
        ruleIds: ["M2"],
        line: 22,
      },
    ];

    const scheduler = new Scheduler(tasks, { runParallelCap: 4, runId: "run-sa2-t" });

    assert.deepEqual(
      scheduler.getReadyTasks().map((t) => t.id),
      ["T1", "T3"]
    );

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    scheduler.mergeTask("T1", createPassingEvidence("T1"));

    const newReady = scheduler.getReadyTasks();
    assert.deepEqual(
      newReady.map((t) => t.id),
      ["T2", "T3", "T4"]
    );
    assert.ok(newReady[0].order < newReady[1].order);
    assert.ok(newReady[1].order < newReady[2].order);
  });

  it("dispatchTask dispatches specific ready task only if ready and slot available", () => {
    const tasks = createMockPactTasks();
    const scheduler = new Scheduler(tasks, { runParallelCap: 1 });

    assert.equal(scheduler.dispatchTask("T2"), null);

    const dispatched = scheduler.dispatchTask("T1");
    assert.ok(dispatched);
    assert.equal(dispatched.id, "T1");
    assert.equal(dispatched.state, "running");

    assert.equal(scheduler.dispatchTask("T1"), null);
  });
});

describe("test/scheduler: Pact review and approval gating (Requirements 13.8, 13.9, 13.10, 23.7)", () => {
  it("blocks dispatching when pactApproved is false (Requirement 13.8)", () => {
    const scheduler = new Scheduler(createMockPactTasks(), {
      pactApproved: false,
    });

    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);
    assert.equal(scheduler.dispatchTask("T1"), null);

    scheduler.approvePact(["T1", "T2", "T3", "T4"]);
    assert.equal(scheduler.canDispatch(), true);

    const dispatched = scheduler.dispatchNext(1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].id, "T1");
  });

  it("filters tasks by approvedTaskIds and marks unapproved tasks skipped (Requirement 23.7, 23.11)", () => {
    const scheduler = new Scheduler(createMockPactTasks(), {
      approvedTaskIds: ["T1", "T3", "T4"],
      pactApproved: true,
      runId: "run-sa2-t",
    });

    assert.equal(scheduler.getTask("T1")?.state, "ready");
    assert.equal(scheduler.getTask("T2")?.state, "skipped");
    assert.equal(scheduler.getTask("T3")?.state, "pending");

    assert.equal(scheduler.getTask("T4")?.state, "blocked");

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    scheduler.mergeTask("T1", createPassingEvidence("T1"));
    assert.equal(scheduler.getTask("T3")?.state, "ready");
  });
});

describe("test/scheduler: Dependency evaluation and graph initialization (Requirements 23.1, 23.2, 23.8)", () => {
  it("initializes dependency graph from markdown without model calls (Requirement 23.1, 23.8)", () => {
    const scheduler = new Scheduler(SAMPLE_TASKS_MD);
    assert.equal(scheduler.getTasks().length, 4);

    const t1 = scheduler.getTask("T1");
    const t2 = scheduler.getTask("T2");
    const t3 = scheduler.getTask("T3");
    const t4 = scheduler.getTask("T4");

    assert.ok(t1 && t2 && t3 && t4);
    assert.deepEqual(t1.dependencies, []);
    assert.deepEqual(t2.dependencies, ["T1"]);
    assert.deepEqual(t3.dependencies, ["T1"]);
    assert.deepEqual(t4.dependencies.sort(), ["T2", "T3"]);
  });

  it("advances pending tasks to ready only when every dependency is merged (Requirement 23.2)", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-t" });

    assert.equal(scheduler.getTask("T1")?.state, "ready");
    assert.equal(scheduler.getTask("T2")?.state, "pending");
    assert.equal(scheduler.getTask("T3")?.state, "pending");
    assert.equal(scheduler.getTask("T4")?.state, "pending");

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    scheduler.mergeTask("T1", createPassingEvidence("T1"));
    assert.equal(scheduler.getTask("T1")?.state, "merged");
    assert.equal(scheduler.getTask("T2")?.state, "ready");
    assert.equal(scheduler.getTask("T3")?.state, "ready");
    assert.equal(scheduler.getTask("T4")?.state, "pending");

    scheduler.dispatchTask("T2");
    scheduler.submitForReview("T2");
    scheduler.mergeTask("T2", createPassingEvidence("T2"));
    assert.equal(scheduler.getTask("T4")?.state, "pending");

    scheduler.dispatchTask("T3");
    scheduler.submitForReview("T3");
    scheduler.mergeTask("T3", createPassingEvidence("T3"));
    assert.equal(scheduler.getTask("T4")?.state, "ready");
  });
});

describe("test/scheduler: Dependency failure, abandonment, skip, and user asks (Requirements 23.3, 23.4, 23.10, 23.11)", () => {
  it("transitions open tasks to blocked on dependency failure and raises user ask (Requirements 23.3, 23.4)", () => {
    const emittedEvents: EventEnvelope[] = [];
    const scheduler = new Scheduler(createMockPactTasks(), {
      emit: (e) => {
        emittedEvents.push(e);
      },
    });

    scheduler.failTask("T1", "Install command failed");

    assert.equal(scheduler.getTask("T1")?.state, "failed");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");

    const asks = scheduler.getAsks();
    assert.equal(asks.length, 2);
    const askT2 = asks.find((a) => a.taskId === "T2");
    assert.ok(askT2);
    assert.equal(askT2.blockedByTaskId, "T1");
    assert.deepEqual(askT2.options, ["re-plan", "skip", "stop"]);
    assert.equal(askT2.resolved, false);

    const askEvent = emittedEvents.find((e) => e.kind === "ask.raised" && e.taskId === "T2");
    assert.ok(askEvent);
  });

  it("transitions open tasks to blocked on dependency abandonment (Requirement 23.3, 23.13)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.abandonTask("T1", "Skeleton laid to rest");

    assert.equal(scheduler.getTask("T1")?.state, "abandoned");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");
  });

  it("transitions open tasks to blocked on dependency skip (Requirement 23.3, 23.11)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.skipTask("T1", "Skipped by pact");

    assert.equal(scheduler.getTask("T1")?.state, "skipped");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");
  });

  it("resolving user ask with re-plan unblocks task to ready (Requirement 23.10)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.failTask("T1");

    const ask = scheduler.getPendingAsks().find((a) => a.taskId === "T2");
    assert.ok(ask);

    scheduler.answerAsk(ask.askId, "re-plan");
    assert.equal(scheduler.getTask("T2")?.state, "ready");
    assert.equal(ask.resolved, true);
    assert.equal(ask.resolution, "re-plan");
  });

  it("replanDependency unblocks task and resets dependencies (Requirement 23.10)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.failTask("T1");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");

    scheduler.replanDependency("T2", []);
    assert.equal(scheduler.getTask("T2")?.state, "ready");
    assert.deepEqual(scheduler.getTask("T2")?.dependencies, []);
  });
});

describe("test/scheduler: Live Skeleton concurrency slot controller (Requirement 23.5)", () => {
  it("enforces minimum of runParallelCap, globalSkeletonLimit, and runningMax", () => {
    const s1 = new Scheduler(createMockPactTasks(), {
      runParallelCap: 5,
      globalSkeletonLimit: 2,
      runningMax: 4,
    });
    assert.equal(s1.getEffectiveLimit(), 2);

    const s2 = new Scheduler(createMockPactTasks(), {
      runParallelCap: 3,
      globalSkeletonLimit: 5,
      runningMax: 1,
    });
    assert.equal(s2.getEffectiveLimit(), 1);

    const s3 = new Scheduler(createMockPactTasks(), {
      runParallelCap: 2,
    });
    assert.equal(s3.getEffectiveLimit(), 2);
  });

  it("frees execution slot when task enters review or completes", () => {
    const tasks = createMockPactTasks();
    tasks[1].dependencies = [];
    tasks[1].depends = [];

    const scheduler = new Scheduler(tasks, { runParallelCap: 1 });
    assert.equal(scheduler.getAvailableSlots(), 1);

    scheduler.dispatchNext();
    assert.equal(scheduler.getAvailableSlots(), 0);
    assert.equal(scheduler.canDispatch(), false);

    scheduler.submitForReview("T1");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
    assert.equal(scheduler.getAvailableSlots(), 1);
    assert.equal(scheduler.canDispatch(), true);

    const nextBatch = scheduler.dispatchNext();
    assert.equal(nextBatch.length, 1);
    assert.equal(nextBatch[0].id, "T2");
  });
});

describe("test/scheduler: Model tier selection (Requirement 23.15)", () => {
  it("assigns Claude Opus 5.5 to hard tasks and Claude Sonnet 5.5 to normal tasks", () => {
    const scheduler = new Scheduler(createMockPactTasks());

    assert.equal(scheduler.getModelTier("T1"), CLAUDE_SONNET_5_5_MODEL_ID);
    assert.equal(scheduler.getModelTierName("T1"), MODEL_TIER_SONNET);

    assert.equal(scheduler.getModelTier("T2"), CLAUDE_OPUS_5_5_MODEL_ID);
    assert.equal(scheduler.getModelTierName("T2"), MODEL_TIER_OPUS);

    assert.equal(scheduler.getModelTier("T3"), CLAUDE_SONNET_5_5_MODEL_ID);
    assert.equal(scheduler.getModelTier("T4"), CLAUDE_OPUS_5_5_MODEL_ID);
  });
});

describe("test/scheduler: Terminal states, stop requests, and max attempts (Requirements 23.9, 23.12)", () => {
  it("stops dispatching when requestStop is called (Requirement 23.9)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    assert.equal(scheduler.canDispatch(), true);

    scheduler.requestStop("User requested stop");
    assert.equal(scheduler.isStopRequested, true);
    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);
  });

  it("stops dispatching when budget cap is exceeded (Requirement 23.9)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.setBudgetExceeded(true, "Token budget exhausted");

    assert.equal(scheduler.isBudgetExceeded, true);
    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);
  });

  it("transitions task to failed after exceeding max attempts and blocks dependents (Requirement 23.12)", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { maxAttempts: 2 });
    const t1 = scheduler.getTask("T1");
    assert.ok(t1);

    scheduler.dispatchNext();
    assert.equal(t1.attempts, 1);

    scheduler.rejectTask("T1", { retry: true, reason: "Failure 1" });
    assert.equal(t1.state, "ready");

    scheduler.dispatchNext();
    assert.equal(t1.attempts, 2);

    scheduler.rejectTask("T1", { retry: true, reason: "Failure 2" });
    assert.equal(t1.state, "failed");

    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");
  });

  it("detects when all tasks are terminal", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-t" });
    assert.equal(scheduler.isAllTerminal(), false);

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    scheduler.mergeTask("T1", createPassingEvidence("T1"));

    scheduler.dispatchTask("T2");
    scheduler.submitForReview("T2");
    scheduler.mergeTask("T2", createPassingEvidence("T2"));

    scheduler.dispatchTask("T3");
    scheduler.submitForReview("T3");
    scheduler.mergeTask("T3", createPassingEvidence("T3"));
    assert.equal(scheduler.isAllTerminal(), false);

    scheduler.dispatchTask("T4");
    scheduler.submitForReview("T4");
    scheduler.mergeTask("T4", createPassingEvidence("T4"));
    assert.equal(scheduler.isAllTerminal(), true);
    assert.equal(scheduler.canDispatch(), false);
  });
});

describe("test/scheduler: Event emission on state transitions", () => {
  it("emits task.state events on lifecycle transitions", () => {
    const events: EventEnvelope[] = [];
    const scheduler = new Scheduler(createMockPactTasks(), {
      runId: "run-sa2-t",
      emit: (e) => {
        events.push(e);
      },
    });

    scheduler.dispatchNext();
    scheduler.submitForReview("T1");
    scheduler.mergeTask("T1", createPassingEvidence("T1"));

    const stateEvents = events.filter((e) => e.kind === "task.state");
    assert.ok(stateEvents.length >= 3);

    const runningEvt = stateEvents.find(
      (e) => e.taskId === "T1" && (e.data as Record<string, unknown>).state === "running"
    );
    assert.ok(runningEvt);
    assert.equal(runningEvt.runId, "run-sa2-t");

    const reviewEvt = stateEvents.find(
      (e) => e.taskId === "T1" && (e.data as Record<string, unknown>).state === "in_review"
    );
    assert.ok(reviewEvt);

    const mergedEvt = stateEvents.find(
      (e) => e.taskId === "T1" && (e.data as Record<string, unknown>).state === "merged"
    );
    assert.ok(mergedEvt);
  });
});

describe("test/scheduler: Fast-check property test for ready-task order", () => {
  it("always returns ready tasks in strictly ascending order by their definition order", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/),
            hard: fc.boolean(),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (rawItems) => {
          const seen = new Set<string>();
          const uniqueItems = rawItems.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });

          if (uniqueItems.length === 0) return;

          const tasks: PactTask[] = uniqueItems.map((item, idx) => ({
            id: item.id,
            title: `Task ${item.id}`,
            role: "soul-stitcher",
            dependencies: [],
            depends: [],
            dependsOn: [],
            files: ["src/index.js"],
            filesInScope: ["src/index.js"],
            acceptanceCommand: "npm test",
            accept: "npm test",
            hard: item.hard,
            hardFlag: item.hard,
            hardRaw: item.hard ? "yes" : "no",
            rules: ["M1"],
            ruleIds: ["M1"],
            line: (idx + 1) * 5,
          }));

          const scheduler = new Scheduler(tasks, { runParallelCap: 10 });
          const ready = scheduler.getReadyTasks();

          assert.equal(ready.length, tasks.length);
          for (let i = 0; i < ready.length - 1; i++) {
            assert.ok(
              ready[i].order <= ready[i + 1].order,
              `Ready tasks not ordered: order[${i}]=${ready[i].order} > order[${i + 1}]=${ready[i + 1].order}`
            );
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property 10: Pact before Legion (Requirements 13.8, 13.9, 13.10, 23.7)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 5 }),
        (taskCount, parallelCap) => {
          const allIds = Array.from({ length: taskCount }, (_, i) => `T${i + 1}`);
          const tasks: PactTask[] = allIds.map((id, idx) => ({
            id,
            title: `Task ${id}`,
            role: "soul-stitcher",
            dependencies: [],
            depends: [],
            dependsOn: [],
            files: ["src/index.js"],
            filesInScope: ["src/index.js"],
            acceptanceCommand: "npm test",
            accept: "npm test",
            hard: false,
            hardFlag: false,
            hardRaw: "no",
            rules: ["M1"],
            ruleIds: ["M1"],
            line: (idx + 1) * 5,
          }));

          // 1. Before pact approval: strictly no tasks dispatch
          const scheduler = new Scheduler(tasks, {
            pactApproved: false,
            runParallelCap: parallelCap,
          });

          assert.equal(scheduler.canDispatch(), false);
          assert.deepEqual(scheduler.dispatchNext(), []);
          assert.equal(scheduler.getRunningTasks().length, 0);

          // 2. Select approved subset
          const approved = allIds.filter((_, idx) => idx % 2 === 0);
          const approvedSet = new Set(approved);

          scheduler.approvePact(approved);

          // 3. Dispatch tasks
          const dispatched = scheduler.dispatchNext();
          for (const t of dispatched) {
            assert.ok(approvedSet.has(t.id), `Task ${t.id} must be in approvedSet`);
          }

          // 4. Tasks not in approved are skipped
          for (const t of scheduler.getTasks()) {
            if (!approvedSet.has(t.id)) {
              assert.equal(t.state, "skipped");
              assert.equal(t.attempts, 0);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property: Pending tasks become ready if and only if all dependencies are merged (Requirement 23.2)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        (chainLength) => {
          // Chain: T1 -> T2 -> ... -> Tn
          const tasks: PactTask[] = [];
          for (let i = 1; i <= chainLength; i++) {
            const deps = i > 1 ? [`T${i - 1}`] : [];
            tasks.push({
              id: `T${i}`,
              title: `Task T${i}`,
              role: "soul-stitcher",
              dependencies: deps,
              depends: deps,
              dependsOn: deps,
              files: ["src/index.js"],
              filesInScope: ["src/index.js"],
              acceptanceCommand: "npm test",
              accept: "npm test",
              hard: false,
              hardFlag: false,
              hardRaw: "no",
              rules: ["M1"],
              ruleIds: ["M1"],
              line: i * 5,
            });
          }

          const scheduler = new Scheduler(tasks, { pactApproved: true, runId: "run-sa2-t" });

          // Initially, only T1 is ready, rest are pending
          assert.equal(scheduler.getTask("T1")?.state, "ready");
          for (let i = 2; i <= chainLength; i++) {
            assert.equal(scheduler.getTask(`T${i}`)?.state, "pending");
          }

          // Merge sequentially: T_i merging must unblock T_{i+1} to ready
          for (let i = 1; i < chainLength; i++) {
            scheduler.dispatchTask(`T${i}`);
            scheduler.submitForReview(`T${i}`);
            scheduler.mergeTask(`T${i}`, createPassingEvidence(`T${i}`));

            assert.equal(scheduler.getTask(`T${i}`)?.state, "merged");
            assert.equal(scheduler.getTask(`T${i + 1}`)?.state, "ready");
            for (let j = i + 2; j <= chainLength; j++) {
              assert.equal(scheduler.getTask(`T${j}`)?.state, "pending");
            }
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});
