// Task 13.2 unit tests: Scheduler dependency graph, task queues, and slot controller
// Requirements: 13.8, 13.9, 13.10, 23.1, 23.2, 23.3, 23.4, 23.5, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14, 23.15

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
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
import { onSubmit } from "../../lib/scheduler/candidate-submission";
import type { TaskMergeEvidence } from "../../lib/scheduler/types";
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-sa2-lib-"));
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

    const integrationBranch = "graveyard/run-sa2-lib";
    runGit(["branch", integrationBranch, baseSha]);
    runGit(["checkout", "-b", "task/sa2-lib", integrationBranch]);
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
      runId: "run-sa2-lib",
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
    runId: "run-sa2-lib",
    kind: "task.state",
    actor: "scheduler",
    taskId,
    data: {
      taskId,
      state: "in_review",
    },
  });
  eventSource.append({
    runId: "run-sa2-lib",
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
    runId: "run-sa2-lib",
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
    runId: "run-sa2-lib",
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

describe("Scheduler: dependency evaluation and graph initialization (Requirements 23.1, 23.2, 23.8)", () => {
  it("initializes dependency graph from markdown string without model call", () => {
    const scheduler = new Scheduler(SAMPLE_TASKS_MD);
    assert.equal(scheduler.getTasks().length, 4);

    const t1 = scheduler.getTask("T1");
    const t2 = scheduler.getTask("T2");
    const t4 = scheduler.getTask("T4");

    assert.ok(t1);
    assert.ok(t2);
    assert.ok(t4);

    assert.deepEqual(t1.dependencies, []);
    assert.deepEqual(t1.dependents.sort(), ["T2", "T3"]);
    assert.deepEqual(t2.dependencies, ["T1"]);
    assert.deepEqual(t2.dependents, ["T4"]);
    assert.deepEqual(t4.dependencies.sort(), ["T2", "T3"]);
  });

  it("sets pending tasks to ready when dependencies are merged (Requirement 23.2)", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });

    // T1 has no dependencies: initially ready
    assert.equal(scheduler.getTask("T1")?.state, "ready");
    // T2 and T3 depend on T1: initially pending
    assert.equal(scheduler.getTask("T2")?.state, "pending");
    assert.equal(scheduler.getTask("T3")?.state, "pending");
    assert.equal(scheduler.getTask("T4")?.state, "pending");

    // Merge T1 through in_review and a passing gate
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const m1 = scheduler.mergeTask("T1", createPassingEvidence("T1"));
    assert.equal(m1.ok, true);
    assert.equal(scheduler.getTask("T1")?.state, "merged");

    // T2 and T3 should now be ready
    assert.equal(scheduler.getTask("T2")?.state, "ready");
    assert.equal(scheduler.getTask("T3")?.state, "ready");

    // T4 depends on both T2 and T3, so it should still be pending
    assert.equal(scheduler.getTask("T4")?.state, "pending");

    // Merge T2 through in_review and a passing gate
    scheduler.dispatchTask("T2");
    scheduler.submitForReview("T2");
    const m2 = scheduler.mergeTask("T2", createPassingEvidence("T2"));
    assert.equal(m2.ok, true);
    assert.equal(scheduler.getTask("T4")?.state, "pending");

    // Merge T3: T4 should now become ready
    scheduler.dispatchTask("T3");
    scheduler.submitForReview("T3");
    const m3 = scheduler.mergeTask("T3", createPassingEvidence("T3"));
    assert.equal(m3.ok, true);
    assert.equal(scheduler.getTask("T4")?.state, "ready");
  });
});

describe("Scheduler: dependency failure, abandonment, skip and user asks (Requirements 23.3, 23.4)", () => {
  it("transitions open tasks to blocked when dependency fails and raises user ask (Requirements 23.3, 23.4)", () => {
    const emittedEvents: EventEnvelope[] = [];
    const scheduler = new Scheduler(createMockPactTasks(), {
      emit: (evt) => {
        emittedEvents.push(evt);
      },
    });

    assert.equal(scheduler.getTask("T2")?.state, "pending");
    assert.equal(scheduler.getTask("T3")?.state, "pending");

    // Fail T1
    scheduler.failTask("T1", "Acceptance tests failed");

    assert.equal(scheduler.getTask("T1")?.state, "failed");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");

    // User asks should be raised for both blocked tasks
    const asks = scheduler.getAsks();
    assert.equal(asks.length, 2);

    const askT2 = asks.find((a) => a.taskId === "T2");
    assert.ok(askT2);
    assert.equal(askT2.blockedByTaskId, "T1");
    assert.deepEqual(askT2.options, ["re-plan", "skip", "stop"]);
    assert.equal(askT2.resolved, false);

    // Verify ask.raised event was emitted
    const askEvent = emittedEvents.find((e) => e.kind === "ask.raised" && e.taskId === "T2");
    assert.ok(askEvent);
  });

  it("transitions open tasks to blocked when dependency is abandoned (Requirement 23.3, 23.13)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.abandonTask("T1", "Skeleton laid to rest");

    assert.equal(scheduler.getTask("T1")?.state, "abandoned");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");
  });

  it("transitions open tasks to blocked when dependency is skipped (Requirement 23.3, 23.11)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.skipTask("T1", "Turned off in pact");

    assert.equal(scheduler.getTask("T1")?.state, "skipped");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");
  });

  it("answering ask with re-plan unblocks task to ready (Requirement 23.10)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.failTask("T1");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");

    const asks = scheduler.getPendingAsks();
    const askT2 = asks.find((a) => a.taskId === "T2");
    assert.ok(askT2);

    scheduler.answerAsk(askT2.askId, "re-plan");
    assert.equal(scheduler.getTask("T2")?.state, "ready");
    assert.equal(askT2.resolved, true);
    assert.equal(askT2.resolution, "re-plan");
  });

  it("answering ask with skip sets task to skipped (Requirement 23.11)", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.failTask("T1");
    const askT2 = scheduler.getPendingAsks().find((a) => a.taskId === "T2");
    assert.ok(askT2);

    scheduler.answerAsk(askT2.askId, "skip");
    assert.equal(scheduler.getTask("T2")?.state, "skipped");
  });

  it("answering ask with stop requests halt on scheduler", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.failTask("T1");
    const askT2 = scheduler.getPendingAsks().find((a) => a.taskId === "T2");
    assert.ok(askT2);

    scheduler.answerAsk(askT2.askId, "stop");
    assert.equal(scheduler.isStopRequested, true);
    assert.equal(scheduler.canDispatch(), false);
  });
});

describe("Scheduler: re-planning dependencies (Requirement 23.10)", () => {
  it("unblocks task to ready when user re-plans without dependencies", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.failTask("T1");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");

    scheduler.replanDependency("T2");
    assert.equal(scheduler.getTask("T2")?.state, "ready");
  });

  it("unblocks task and updates dependency graph when re-planning with new merged dependencies", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.failTask("T1");
    assert.equal(scheduler.getTask("T2")?.state, "blocked");

    // Re-plan T2 to have no dependencies
    scheduler.replanDependency("T2", []);
    assert.equal(scheduler.getTask("T2")?.state, "ready");
    assert.deepEqual(scheduler.getTask("T2")?.dependencies, []);
  });
});

describe("Scheduler: live Skeleton concurrency slot controller (Requirement 23.5)", () => {
  it("enforces single Soul-stitcher concurrency (Increment 1 default: parallel cap = 1)", () => {
    const tasks = createMockPactTasks();
    // Make both T1 and T2 ready without dependencies
    tasks[1].dependencies = [];
    tasks[1].depends = [];

    const scheduler = new Scheduler(tasks, { runParallelCap: 1 });
    assert.equal(scheduler.getEffectiveLimit(), 1);
    assert.equal(scheduler.getAvailableSlots(), 1);
    assert.equal(scheduler.getReadyTasks().length, 2);

    // Dispatch first task
    const dispatched = scheduler.dispatchNext();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].id, "T1");
    assert.equal(dispatched[0].state, "running");

    // Slots should now be exhausted
    assert.equal(scheduler.getAvailableSlots(), 0);
    assert.equal(scheduler.canDispatch(), false);

    // Second dispatch attempts should return empty
    assert.deepEqual(scheduler.dispatchNext(), []);

    // Complete T1 review and merge
    scheduler.submitForReview("T1");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
    // Once task is in review, live running count drops and slot opens up
    assert.equal(scheduler.getAvailableSlots(), 1);
    assert.equal(scheduler.canDispatch(), true);

    // Next ready task can be dispatched
    const secondBatch = scheduler.dispatchNext();
    assert.equal(secondBatch.length, 1);
    assert.equal(secondBatch[0].id, "T2");
  });

  it("takes the minimum of parallel cap, global limit, and backend runningMax (Requirement 23.5)", () => {
    // parallel cap 4, global limit 2, runningMax 3 -> effective is 2
    const s1 = new Scheduler(createMockPactTasks(), {
      runParallelCap: 4,
      globalSkeletonLimit: 2,
      runningMax: 3,
    });
    assert.equal(s1.getEffectiveLimit(), 2);

    // parallel cap 3, global limit 5, runningMax 1 -> effective is 1
    const s2 = new Scheduler(createMockPactTasks(), {
      runParallelCap: 3,
      globalSkeletonLimit: 5,
      runningMax: 1,
    });
    assert.equal(s2.getEffectiveLimit(), 1);

    // parallel cap 2, no other limits -> effective is 2
    const s3 = new Scheduler(createMockPactTasks(), {
      runParallelCap: 2,
    });
    assert.equal(s3.getEffectiveLimit(), 2);
  });
});

describe("Scheduler: approvedTaskIds and disabled tasks (Requirements 13.8, 23.7, 23.11)", () => {
  it("sets unapproved tasks to skipped and blocks dependent tasks (Requirements 23.7, 23.11)", () => {
    // T1, T3, and T4 are approved; T2 is turned off
    const scheduler = new Scheduler(createMockPactTasks(), {
      approvedTaskIds: ["T1", "T3", "T4"],
    });

    assert.equal(scheduler.getTask("T1")?.state, "ready");
    assert.equal(scheduler.getTask("T2")?.state, "skipped");
    assert.equal(scheduler.getTask("T3")?.state, "pending");

    // T4 depends on T2 (which is skipped), so T4 must be blocked!
    assert.equal(scheduler.getTask("T4")?.state, "blocked");
  });

  it("blocks dispatching when pactApproved is false (Requirement 13.8)", () => {
    const scheduler = new Scheduler(createMockPactTasks(), {
      pactApproved: false,
    });

    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);

    // Approve Pact
    scheduler.approvePact(["T1", "T2", "T3", "T4"]);
    assert.equal(scheduler.canDispatch(), true);
    const dispatched = scheduler.dispatchNext();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].id, "T1");
  });
});

describe("Scheduler: priority order dispatching (Requirement 23.14)", () => {
  it("dispatches ready tasks in the exact priority order from tasks.md", () => {
    // Create 3 tasks with 0 dependencies
    const tasks = createMockPactTasks().slice(0, 3);
    tasks[0].dependencies = [];
    tasks[1].dependencies = [];
    tasks[2].dependencies = [];

    const scheduler = new Scheduler(tasks, { runParallelCap: 3 });
    const ready = scheduler.getReadyTasks();
    assert.deepEqual(
      ready.map((t) => t.id),
      ["T1", "T2", "T3"]
    );

    const dispatched = scheduler.dispatchNext(2);
    assert.deepEqual(
      dispatched.map((t) => t.id),
      ["T1", "T2"]
    );
  });
});

describe("Scheduler: stop, budget caps, and terminal states (Requirement 23.9)", () => {
  it("halts dispatching when stop is requested", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    assert.equal(scheduler.canDispatch(), true);

    scheduler.requestStop();
    assert.equal(scheduler.isStopRequested, true);
    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);
  });

  it("halts dispatching when budget cap is exceeded", () => {
    const scheduler = new Scheduler(createMockPactTasks());
    assert.equal(scheduler.canDispatch(), true);

    scheduler.setBudgetExceeded(true);
    assert.equal(scheduler.isBudgetExceeded, true);
    assert.equal(scheduler.canDispatch(), false);
    assert.deepEqual(scheduler.dispatchNext(), []);
  });

  it("reports allTerminal when every task is terminal", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
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

describe("Scheduler: attempts and failure threshold (Requirement 23.12)", () => {
  it("sets task to failed when attempts reach maximum", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { maxAttempts: 2 });
    const t1 = scheduler.getTask("T1");
    assert.ok(t1);

    scheduler.dispatchNext(); // attempt 1
    assert.equal(t1.attempts, 1);

    // Warden rejects with retry
    scheduler.rejectTask("T1", { retry: true, reason: "Tests failed" });
    assert.equal(t1.state, "ready");

    scheduler.dispatchNext(); // attempt 2
    assert.equal(t1.attempts, 2);

    // Rejecting again should hit max attempts and transition to failed
    scheduler.rejectTask("T1", { retry: true, reason: "Still failing" });
    assert.equal(t1.state, "failed");

    // Dependent tasks should become blocked
    assert.equal(scheduler.getTask("T2")?.state, "blocked");
    assert.equal(scheduler.getTask("T3")?.state, "blocked");
  });
});

describe("Scheduler: model tier selection (Requirement 23.15)", () => {
  it("assigns Claude Opus 5.5 for hard: yes, and Claude Sonnet 5.5 otherwise", () => {
    const scheduler = new Scheduler(createMockPactTasks());

    // T1 is hard: no -> Sonnet 5.5
    assert.equal(scheduler.getModelTier("T1"), CLAUDE_SONNET_5_5_MODEL_ID);
    assert.equal(scheduler.getModelTierName("T1"), MODEL_TIER_SONNET);

    // T2 is hard: yes -> Opus 5.5
    assert.equal(scheduler.getModelTier("T2"), CLAUDE_OPUS_5_5_MODEL_ID);
    assert.equal(scheduler.getModelTierName("T2"), MODEL_TIER_OPUS);

    // T3 is hard: no -> Sonnet 5.5
    assert.equal(scheduler.getModelTier("T3"), CLAUDE_SONNET_5_5_MODEL_ID);

    // T4 is hard: yes -> Opus 5.5
    assert.equal(scheduler.getModelTier("T4"), CLAUDE_OPUS_5_5_MODEL_ID);
  });
});

describe("Scheduler: event emission", () => {
  it("emits task.state events on lifecycle transitions", () => {
    const events: EventEnvelope[] = [];
    const scheduler = new Scheduler(createMockPactTasks(), {
      runId: "run-sa2-lib",
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
    assert.equal(runningEvt.runId, "run-sa2-lib");

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

describe("Scheduler: Transition whitelist (Requirement 23.2, 25.6, 25.7, 25.8)", () => {
  it("accepts valid transitions according to design.md state machine", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "ready");

    // ready -> running
    scheduler.dispatchTask("T1");
    assert.equal(t1.state, "running");

    // running -> in_review
    scheduler.submitForReview("T1");
    assert.equal(t1.state, "in_review");

    // in_review -> rejected
    scheduler.rejectTask("T1", { reason: "Failed review" });
    assert.equal(t1.state, "rejected");

    // rejected -> ready (retry)
    scheduler.retryTask("T1");
    assert.equal(t1.state, "ready");

    // ready -> running
    scheduler.dispatchTask("T1");
    assert.equal(t1.state, "running");

    // running -> in_review
    scheduler.submitForReview("T1");

    // in_review -> merged (with passing gate)
    const m = scheduler.mergeTask("T1", createPassingEvidence("T1"));
    assert.equal(m.ok, true);
    assert.equal(t1.state, "merged");
  });

  it("throws when transitioning outside the whitelist", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    const t2 = scheduler.getTask("T2")!;
    assert.equal(t2.state, "pending");

    // Attempt invalid transitions using (scheduler as any).transitionTask
    assert.throws(
      () => (scheduler as any).transitionTask(t2, "merged"),
      /Invalid task state transition from 'pending' to 'merged'/
    );

    assert.throws(
      () => (scheduler as any).transitionTask(t2, "running"),
      /Invalid task state transition from 'pending' to 'running'/
    );

    assert.throws(
      () => (scheduler as any).transitionTask(t2, "in_review"),
      /Invalid task state transition from 'pending' to 'in_review'/
    );

    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "ready");

    assert.throws(
      () => (scheduler as any).transitionTask(t1, "merged"),
      /Invalid task state transition from 'ready' to 'merged'/
    );

    assert.throws(
      () => (scheduler as any).transitionTask(t1, "in_review"),
      /Invalid task state transition from 'ready' to 'in_review'/
    );

    scheduler.dispatchTask("T1");
    assert.equal(t1.state, "running");

    assert.throws(
      () => (scheduler as any).transitionTask(t1, "merged"),
      /Invalid task state transition from 'running' to 'merged'/
    );

    // Terminal states cannot transition
    scheduler.submitForReview("T1");
    scheduler.mergeTask("T1", createPassingEvidence("T1"));
    assert.equal(t1.state, "merged");

    assert.throws(
      () => (scheduler as any).transitionTask(t1, "running"),
      /Invalid task state transition from 'merged' to 'running'/
    );
    assert.throws(
      () => (scheduler as any).transitionTask(t1, "ready"),
      /Invalid task state transition from 'merged' to 'ready'/
    );
  });
});

describe("Scheduler: mergeTask requires evidence and passing gate (Requirement 9.12, 25.6, 25.7, 25.8)", () => {
  it("rejects merge when evidence is missing (removes bare mergeTask path)", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "in_review");

    const result = scheduler.mergeTask("T1");
    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(t1.state, "in_review");
    assert.ok(result.reasons.length > 0);
  });

  it("rejects merge when task is not in in_review state", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "ready");

    const evidence = createPassingEvidence("T1");
    const result = scheduler.mergeTask("T1", evidence);
    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(t1.state, "ready");
    assert.ok(result.reason?.includes("can only merge from 'in_review'"));
  });

  it("keeps task in_review and returns reasons when Warden rejects", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;

    const badEvidence = createPassingEvidence("T1");
    (badEvidence.verdict as any).verdict = "reject";

    const result = scheduler.mergeTask("T1", badEvidence);
    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(t1.state, "in_review");
    assert.ok(result.reasons.some((r) => r.includes("not 'approve'")));
  });

  it("keeps task in_review and returns reasons when Grimoire gate fails", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;

    const badEvidence = createPassingEvidence("T1");
    (badEvidence.gateResult as any).ok = false;

    const result = scheduler.mergeTask("T1", badEvidence);
    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(t1.state, "in_review");
    assert.ok(result.reasons.some((r) => r.includes("gate failed or missing")));
  });

  it("keeps task in_review and returns reasons when candidateSha256 does not match diff hash", () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;

    const badEvidence = createPassingEvidence("T1");
    (badEvidence.verdict as any).candidateSha256 = "0000000000000000000000000000000000000000000000000000000000000000";

    const result = scheduler.mergeTask("T1", badEvidence);
    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(t1.state, "in_review");
    assert.ok(result.reasons.some((r) => r.includes("does not match")));
  });
});

describe("Scheduler: onSubmit candidate submission pipeline (review findings B4 and B5)", () => {
  it("rejects task when diff touches files outside allow-list (Scope check)", async () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.dispatchTask("T1");
    const t1 = scheduler.getTask("T1")!;

    const outOfScopeDiff = `--- a/lib/secret.ts\n+++ b/lib/secret.ts\n@@ -0,0 +1,1 @@\n+export const x = 1;\n`;
    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      diff: outOfScopeDiff,
      allowList: ["package.json"],
    });

    assert.equal(res.ok, false);
    assert.equal(res.state, "rejected");
    assert.equal(t1.state, "rejected");
    assert.ok(res.reasons.some((r) => r.includes("outside task scope") || r.includes("secret.ts")));
  });

  it("rejects task when diff contains secret leakage (Redactor scan)", async () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.dispatchTask("T1");
    const t1 = scheduler.getTask("T1")!;

    const secretDiff = `--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n-old\n+const token = "ghp_123456789012345678901234567890123456";\n`;
    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      diff: secretDiff,
      allowList: ["package.json"],
    });

    assert.equal(res.ok, false);
    assert.equal(res.state, "rejected");
    assert.equal(t1.state, "rejected");
    assert.ok(res.reasons.some((r) => r.includes("Secret violation")));
  });

  it("rejects task when diff contains symlink (Symlink scan)", async () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.dispatchTask("T1");
    const t1 = scheduler.getTask("T1")!;

    const symlinkDiff = `--- a/package.json\n+++ b/package.json\nnew file mode 120000\n@@ -0,0 +1,1 @@\n+target\n`;
    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      diff: symlinkDiff,
      allowList: ["package.json"],
    });

    assert.equal(res.ok, false);
    assert.equal(res.state, "rejected");
    assert.equal(t1.state, "rejected");
    assert.ok(res.reasons.some((r) => r.includes("symlink")));
  });

  it("rejects task when JS syntax gate fails", async () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.dispatchTask("T1");
    const t1 = scheduler.getTask("T1")!;

    const candidateSha = "c1234567890abcdef1234567890abcdef1234567";
    const tree = "a1234567890abcdef1234567890abcdef1234567";
    const headSha = "b1234567890abcdef1234567890abcdef1234567";
    const invalidJsDiff = `--- a/src/index.js\n+++ b/src/index.js\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
    // onSubmit requires a real GitService instance (N-A1) and re-derives the
    // caller diff with git diff --binary (N-A5), so the mock must answer the
    // diff command with the caller's diff.
    const mockGitService = Object.assign(new GitService(), {
      execGit: async (args: string[]) => {
        if (args.includes("show")) {
          return { stdout: "const broken = {{;", stderr: "", exitCode: 0 };
        }
        if (args.includes("--name-status")) {
          return { stdout: "M\tsrc/index.js\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("diff")) {
          return { stdout: invalidJsDiff, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("refs/heads/task/T1") || a.includes("task/T1"))) {
          return { stdout: candidateSha, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("^{tree}"))) {
          return { stdout: tree, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("graveyard") || a === "HEAD")) {
          return { stdout: headSha, stderr: "", exitCode: 0 };
        }
        return { stdout: tree, stderr: "", exitCode: 0 };
      },
    }) as any;

    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      runId: "run-test-123",
      candidateSha,
      diff: invalidJsDiff,
      allowList: ["src/index.js"],
      gitService: mockGitService,
      eventStore: new EventStore(":memory:"),
      eventSource: new EventStore(":memory:"),
    });

    assert.equal(res.ok, false);
    assert.equal(res.state, "rejected");
    assert.equal(t1.state, "rejected");
    assert.ok(
      res.reasons.some((r) => r.includes("src/index.js: Unexpected token (1:16)"))
    );
  });

  it("rejects task when Warden review returns reject", async () => {
    const scheduler = new Scheduler(createMockPactTasks());
    scheduler.dispatchTask("T1");
    const t1 = scheduler.getTask("T1")!;

    const candidateSha = "c1234567890abcdef1234567890abcdef1234567";
    const tree = "a1234567890abcdef1234567890abcdef1234567";
    const headSha = "b1234567890abcdef1234567890abcdef1234567";
    const validDiff = `--- a/src/index.js\n+++ b/src/index.js\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
    // onSubmit requires a real GitService instance (N-A1) and re-derives the
    // caller diff with git diff --binary (N-A5), so the mock must answer the
    // diff command with the caller's diff.
    const mockGitService = Object.assign(new GitService(), {
      execGit: async (args: string[]) => {
        if (args.includes("show")) {
          return { stdout: "const x = 1; module.exports = { x };", stderr: "", exitCode: 0 };
        }
        if (args.includes("--name-status")) {
          return { stdout: "M\tsrc/index.js\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("diff")) {
          return { stdout: validDiff, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("refs/heads/task/T1") || a.includes("task/T1"))) {
          return { stdout: candidateSha, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("^{tree}"))) {
          return { stdout: tree, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("graveyard") || a === "HEAD")) {
          return { stdout: headSha, stderr: "", exitCode: 0 };
        }
        return { stdout: tree, stderr: "", exitCode: 0 };
      },
    }) as any;

    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      runId: "run-test-123",
      candidateSha,
      diff: validDiff,
      allowList: ["src/index.js"],
      gitService: mockGitService,
      eventStore: new EventStore(":memory:"),
      eventSource: new EventStore(":memory:"),
      wardenReviewer: async () => ({
        verdict: "reject",
        reasons: ["Test weakening detected in test suite"],
        tree,
      }),
    });

    assert.equal(res.ok, false);
    assert.equal(res.state, "rejected");
    assert.equal(t1.state, "rejected");
    assert.ok(res.reasons.some((r) => r.includes("Test weakening detected")));
  });

  it("transitions task through in_review to merged on successful candidate submission", async () => {
    const scheduler = new Scheduler(createMockPactTasks(), { runId: "run-sa2-lib" });
    scheduler.dispatchTask("T1");
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "running");

    const proof = sa2RealProof;
    const validDiff = proof.diff;
    const candidateSha = proof.candidateSha;
    const candidateSha256 = proof.candidateSha256;
    const tree = proof.tree;
    const headSha = "b1234567890abcdef1234567890abcdef1234567";

    const origMergeTask = scheduler.mergeTask.bind(scheduler);
    scheduler.mergeTask = (tId: string, ev?: any) => {
      const evWithProof = {
        ...ev,
        gitMerge: proof.verifiedMerge,
      };
      return origMergeTask(tId, evWithProof);
    };

    // Mock GitService whose mergeCandidate succeeds with the real proof.
    // onSubmit requires a real GitService instance (N-A1) and re-derives the
    // caller diff with git diff --binary (N-A5), so the mock must answer the
    // diff command with the caller's diff.
    const mockGitService = Object.assign(new GitService(), {
      execGit: async (args: string[]) => {
        if (args.includes("show")) {
          return { stdout: "const x = 1; module.exports = { x };", stderr: "", exitCode: 0 };
        }
        if (args.includes("--name-status")) {
          return { stdout: "M\tbase.txt\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("diff")) {
          return { stdout: validDiff, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("refs/heads/task/T1") || a.includes("task/T1"))) {
          return { stdout: candidateSha, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("^{tree}"))) {
          return { stdout: tree, stderr: "", exitCode: 0 };
        }
        if (args.some((a) => a.includes("graveyard") || a === "HEAD")) {
          return { stdout: headSha, stderr: "", exitCode: 0 };
        }
        return { stdout: tree, stderr: "", exitCode: 0 };
      },
      mergeCandidate: async () => proof.verifiedMerge,
    }) as any;

    const eventSource = new EventStore(":memory:");
    eventSource.append({
      runId: "run-sa2-lib",
      kind: "task.state",
      actor: "scheduler",
      taskId: "T1",
      data: {
        taskId: "T1",
        state: "in_review",
      },
    });
    eventSource.append({
      runId: "run-sa2-lib",
      kind: "gate.result",
      actor: "grimoire",
      taskId: "T1",
      data: {
        taskId: "T1",
        ok: true,
        tree,
      },
    });
    eventSource.append({
      runId: "run-sa2-lib",
      kind: "verdict",
      actor: "warden",
      taskId: "T1",
      data: {
        taskId: "T1",
        verdict: "approve",
        candidateSha256,
        target: "T1",
        tree,
        refs: ["cmd:test"],
      },
    });

    const res = await onSubmit({
      scheduler,
      taskId: "T1",
      runId: "run-sa2-lib",
      diff: validDiff,
      allowList: ["base.txt"],
      candidateSha,
      candidateSha256,
      expectedIntegrationHeadSha: headSha,
      gitService: mockGitService,
      eventSource,
      eventStore: eventSource,
      wardenReviewer: async () =>
        buildVerdictRecord(candidateSha, {
          target: "T1",
          taskId: "T1",
          verdict: "approve",
          diff: validDiff,
          tree,
          install: { ok: true },
          build: { ok: true },
          accept: { ok: true },
          tests: { ok: true },
        }),
    });

    assert.equal(res.ok, true);
    assert.equal(res.merged, true);
    assert.equal(res.state, "merged");
    assert.equal(t1.state, "merged");
  });
});
