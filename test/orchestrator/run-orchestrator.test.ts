// Task: T34 Wave 2B - Test Suite for RunOrchestrator
// Requirements: 11, 12, 13, 23, 24, 25, 26, 27, 28, 29, 30, 41

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RunOrchestrator,
  createRunOrchestrator,
  getRunOrchestrator,
  resetRunOrchestrator,
  type RunExecutionHandle,
  type ExhumeRunnerContext,
  type PlanRunnerContext,
  type FinalCheckContext,
  type PactApprovalInput,
} from "../../lib/orchestrator/run-orchestrator";
import {
  RuntimeHost,
  resetRuntimeHost,
} from "../../lib/runtime/runtime-host";
import {
  EventStore,
  getDefaultEventStore,
  resetDefaultEventStore,
} from "../../lib/events/event-store";
import {
  RunStore,
  getDefaultRunStore,
  resetDefaultRunStore,
} from "../../lib/runs/run-store";
import {
  LogStore,
  getDefaultLogStore,
  resetDefaultLogStore,
} from "../../lib/events/log-store";
import { GitService } from "../../lib/git/git-service";
import { parsePact } from "../../lib/pact/pact-parser";
import { createDeathCertificate } from "../../lib/exhume/death-certificate";
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import type { WorkerContext, WardenReviewContext } from "../../lib/scheduler/dispatcher";

interface TestRepoContext {
  tmpDir: string;
  gitDir: string;
  runId: string;
  baseSha: string;
  runsDir: string;
  cleanup: () => void;
}

function createTestRepo(runId: string): TestRepoContext {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "orchestrator-test-" + runId + "-")
  );
  const runsDir = path.join(tmpDir, "runs");
  const gitDir = path.join(runsDir, runId, "git");
  fs.mkdirSync(gitDir, { recursive: true });

  const runGit = (args: string[], cwd = gitDir): string => {
    return childProcess
      .execFileSync("git", args, {
        cwd,
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
  };

  runGit(["init", "--initial-branch=main", "."]);
  runGit(["config", "user.name", "Test Runner"]);
  runGit(["config", "user.email", "runner@example.test"]);

  fs.writeFileSync(
    path.join(gitDir, "package.json"),
    JSON.stringify(
      {
        name: "test-repo",
        version: "1.0.0",
        scripts: { test: "node test.js" },
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(gitDir, "test.js"), "process.exit(0);\n", "utf8");
  fs.writeFileSync(path.join(gitDir, "base.txt"), "Initial base content\n", "utf8");

  runGit(["add", "."]);
  runGit(["commit", "-m", "Initial commit"]);

  const baseSha = runGit(["rev-parse", "HEAD"]);
  const integrationBranch = `graveyard/${runId}`;
  runGit(["branch", integrationBranch, baseSha]);

  return {
    tmpDir,
    gitDir,
    runId,
    baseSha,
    runsDir,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("RunOrchestrator: Wave 2B Production Run Orchestration", () => {
  const tmpDirs: string[] = [];
  const activeHosts: RuntimeHost[] = [];
  const activeOrchestrators: RunOrchestrator[] = [];

  function createIsolatedEnv(repoCtx: TestRepoContext) {
    const eventStore = new EventStore(path.join(repoCtx.tmpDir, "events.db"));
    const runStore = new RunStore(path.join(repoCtx.tmpDir, "runs.db"));
    const logStore = new LogStore({ dir: path.join(repoCtx.tmpDir, "logs") });
    const host = new RuntimeHost({
      skipReconcile: true,
      eventStore,
      runStore,
      logStore,
      closeStoresOnShutdown: true,
    });
    activeHosts.push(host);

    const gitService = new GitService({ runsDir: repoCtx.runsDir });

    return { eventStore, runStore, logStore, host, gitService };
  }

  beforeEach(async () => {
    await resetRunOrchestrator();
    await resetRuntimeHost({ closeStores: true });
    resetDefaultEventStore();
    resetDefaultRunStore();
    resetDefaultLogStore();
  });

  afterEach(async () => {
    for (const orch of activeOrchestrators) {
      try {
        await orch.shutdown();
      } catch {}
    }
    activeOrchestrators.length = 0;

    for (const h of activeHosts) {
      try {
        await h.stop({ closeStores: true });
      } catch {}
    }
    activeHosts.length = 0;

    await resetRunOrchestrator();
    await resetRuntimeHost({ closeStores: true });
    resetDefaultEventStore();
    resetDefaultRunStore();
    resetDefaultLogStore();

    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  it("1. full happy-path lifecycle: queued -> exhume -> plan -> pact_review -> legion -> final_check -> report -> done", async () => {
    const runId = "run-happy-01";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const { host, gitService, runStore, eventStore } = createIsolatedEnv(repoCtx);

    runStore.createRun({
      runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const pactMarkdown = `
- [ ] T1. Feature Fix
  - role: bonesetter
  - depends:
  - files: feature.txt
  - accept: node test.js
  - hard: no
  - rules: M1
`;

    const exhumeRunner = async (ctx: ExhumeRunnerContext) => {
      return {
        healthy: false,
        deathCertificate: createDeathCertificate({
          runId: ctx.runId,
          baseSha: ctx.baseSha,
          install: { step: "install", status: "passed", command: "npm install" },
          build: { step: "build", status: "passed", command: "npm run build" },
          test: { step: "test", status: "failed", command: "npm test", exitCode: 1 },
          failures: [{ step: "test", class: "syntax_error", message: "Syntax error" }],
        }),
        rows: [],
        manifestInspection: {} as any,
        wallClockTimeoutHit: false,
      };
    };

    const planRunner = async (ctx: PlanRunnerContext) => {
      const parsed = parsePact(pactMarkdown);
      return {
        ok: true as const,
        draftId: `pact-${ctx.runId}-v1`,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        markdown: pactMarkdown,
        tasks: parsed.tasks,
        version: 1,
        coverage: {
          ok: true,
          covered: true,
          coveredFailures: [],
          uncoveredFailures: [],
          missingFailures: [],
        },
      };
    };

    const workerRunner = async (ctx: WorkerContext) => {
      const filePath = path.join(ctx.worktreeDir, "feature.txt");
      fs.writeFileSync(filePath, "resurrected feature content\n", "utf8");
      childProcess.execFileSync("git", ["add", "feature.txt"], {
        cwd: ctx.worktreeDir,
      });
      childProcess.execFileSync("git", ["commit", "-m", "Add feature.txt"], {
        cwd: ctx.worktreeDir,
      });
      return {
        ok: true,
        taskId: ctx.taskId,
        worktreeDir: ctx.worktreeDir,
      };
    };

    const wardenRunner = async (ctx: WardenReviewContext) => {
      return buildVerdictRecord(ctx.candidateSha, {
        diff: ctx.diff,
        candidateSha256: ctx.candidateSha256,
        tree: ctx.candidateTree,
        install: { ok: true, ref: "cmd:npm-install" },
        build: { ok: true, ref: "cmd:npm-build" },
        accept: { ok: true, ref: "cmd:node test.js", exitCode: 0 },
        tests: { ok: true, ref: "cmd:tests" },
        noTestWeakening: true,
      });
    };

    const finalCheckRunner = async (ctx: FinalCheckContext) => {
      return {
        ok: true,
        passed: true,
        installPassed: true,
        buildPassed: true,
        testsPassed: true,
        hasTests: true,
      };
    };

    const orchestrator = new RunOrchestrator({
      host,
      gitService,
      runsDir: repoCtx.runsDir,
      exhumeRunner,
      planRunner,
      workerRunner,
      wardenRunner,
      finalCheckRunner,
    });
    activeOrchestrators.push(orchestrator);

    const handle = orchestrator.startRun(runId);
    assert.ok(handle);
    assert.equal(handle.runId, runId);

    const finalResult = await handle.promise;

    assert.equal(finalResult.outcome, "resurrected");
    assert.equal(handle.getPhase(), "done");

    // Check RunStore was updated
    const finalRun = runStore.getRun(runId);
    assert.ok(finalRun);
    assert.equal(finalRun.phase, "done");
    assert.equal(finalRun.outcome, "resurrected");
    assert.ok(typeof finalRun.endedAt === "number");

    // Verify artifacts stored in runsDir/<runId>/artifacts
    const artifactsDir = path.join(repoCtx.runsDir, runId, "artifacts");
    assert.ok(fs.existsSync(path.join(artifactsDir, "all.patch")));
    assert.ok(fs.existsSync(path.join(artifactsDir, "report.md")));
    assert.ok(fs.existsSync(path.join(artifactsDir, "death-certificate.json")));
    assert.ok(fs.existsSync(path.join(artifactsDir, "spec.json")));
    assert.ok(fs.existsSync(path.join(artifactsDir, "events.ndjson")));

    // Verify events were emitted into isolated eventStore
    const events = eventStore.getEvents(runId);
    const phaseEvents = events.filter((e) => e.kind === "run.phase");
    assert.ok(phaseEvents.length >= 5);
  });

  it("2. healthy_already early exit terminates immediately with outcome healthy_already", async () => {
    const runId = "run-healthy-02";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const { host, gitService, runStore } = createIsolatedEnv(repoCtx);

    runStore.createRun({
      runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const exhumeRunner = async (ctx: ExhumeRunnerContext) => {
      return {
        healthy: true,
        outcome: "healthy_already" as const,
        earlyCompleted: true,
        deathCertificate: createDeathCertificate({
          runId: ctx.runId,
          baseSha: ctx.baseSha,
          install: { step: "install", status: "passed", command: "npm install" },
          build: { step: "build", status: "passed", command: "npm run build" },
          test: { step: "test", status: "passed", command: "npm test", exitCode: 0 },
          failures: [],
        }),
        rows: [],
        manifestInspection: {} as any,
        wallClockTimeoutHit: false,
      };
    };

    const orchestrator = new RunOrchestrator({
      host,
      gitService,
      runsDir: repoCtx.runsDir,
      exhumeRunner,
    });
    activeOrchestrators.push(orchestrator);

    const handle = orchestrator.startRun(runId);
    const finalResult = await handle.promise;

    assert.equal(finalResult.outcome, "healthy_already");
    assert.equal(handle.getPhase(), "done");

    const finalRun = runStore.getRun(runId);
    assert.equal(finalRun?.outcome, "healthy_already");
    assert.equal(finalRun?.phase, "done");
  });

  it("3. Pact revision and pause/resume/stop/kill controls", async () => {
    const runId = "run-control-03";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const { host, gitService, runStore } = createIsolatedEnv(repoCtx);

    runStore.createRun({
      runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const planRunner = async (ctx: PlanRunnerContext) => {
      const markdown = "- [ ] T1. Step 1\n  - role: bonesetter\n  - depends:\n  - files: a.js\n  - accept: npm test\n  - hard: no\n  - rules: M1\n";
      const parsed = parsePact(markdown);
      return {
        ok: true as const,
        draftId: `pact-${ctx.runId}-v1`,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        markdown,
        tasks: parsed.tasks,
        version: 1,
        coverage: {
          ok: true,
          covered: true,
          coveredFailures: [],
          uncoveredFailures: [],
          missingFailures: [],
        },
      };
    };

    let workerPaused = false;
    let workerAborted = false;

    const workerRunner = async (ctx: WorkerContext) => {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 10000);

        if (ctx.signal) {
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            workerAborted = true;
            const err = new Error("Task aborted by stop");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const exhumeRunner = async (ctx: ExhumeRunnerContext) => {
      return {
        healthy: false,
        deathCertificate: createDeathCertificate({
          runId: ctx.runId,
          baseSha: ctx.baseSha,
          install: { step: "install", status: "passed", command: "npm install" },
          build: { step: "build", status: "passed", command: "npm run build" },
          test: { step: "test", status: "failed", command: "npm test", exitCode: 1 },
          failures: [{ step: "test", class: "syntax_error", message: "Syntax error" }],
        }),
        rows: [],
        manifestInspection: {} as any,
        wallClockTimeoutHit: false,
      };
    };

    const orchestrator = new RunOrchestrator({
      host,
      gitService,
      runsDir: repoCtx.runsDir,
      autoApprovePact: false,
      exhumeRunner,
      planRunner,
      workerRunner,
    });
    activeOrchestrators.push(orchestrator);

    const handle = orchestrator.startRun(runId);

    // Wait until plan phase completes and reaches pact_review
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (handle.getPhase() === "pact_review") {
          clearInterval(interval);
          resolve(true);
        }
      }, 10);
    });

    // Test Pact revision
    const revised = await orchestrator.revisePact(
      runId,
      "Please add logging to Step 1"
    );
    assert.ok(revised);
    assert.equal(handle.pactDraft?.version, 2);

    // Approve pact to enter legion
    await orchestrator.approvePact(runId, {
      approvedTaskIds: ["T1"],
    });

    // Wait until legion phase starts and task is active
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (
          handle.getPhase() === "legion" &&
          handle.dispatcher &&
          handle.dispatcher.getLiveCount() > 0
        ) {
          clearInterval(interval);
          resolve(true);
        }
      }, 10);
    });

    // Test pause and resume
    orchestrator.pauseRun(runId);
    assert.equal(orchestrator.host.isPaused(), true);
    assert.equal(handle.dispatcher?.isPaused(), true);

    orchestrator.resumeRun(runId);
    assert.equal(orchestrator.host.isPaused(), false);
    assert.equal(handle.dispatcher?.isPaused(), false);

    // Test stopRun
    await orchestrator.stopRun(runId, "User requested cancellation");
    const result = await handle.promise;

    assert.equal(result.outcome, "cancelled");
    assert.equal(handle.getPhase(), "done");
    assert.equal(workerAborted, true);
  });

  it("3b. killRun terminates run with outcome killed", async () => {
    const runId = "run-kill-03b";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const { host, gitService, runStore } = createIsolatedEnv(repoCtx);

    runStore.createRun({
      runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const planRunner = async (ctx: PlanRunnerContext) => {
      const markdown = "- [ ] T1. Step 1\n  - role: bonesetter\n  - depends:\n  - files: a.js\n  - accept: npm test\n  - hard: no\n  - rules: M1\n";
      const parsed = parsePact(markdown);
      return {
        ok: true as const,
        draftId: `pact-${ctx.runId}-v1`,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        markdown,
        tasks: parsed.tasks,
        version: 1,
        coverage: {
          ok: true,
          covered: true,
          coveredFailures: [],
          uncoveredFailures: [],
          missingFailures: [],
        },
      };
    };

    let workerAborted = false;
    const workerRunner = async (ctx: WorkerContext) => {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 10000);

        if (ctx.signal) {
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            workerAborted = true;
            const err = new Error("Task aborted by kill");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const exhumeRunner = async (ctx: ExhumeRunnerContext) => {
      return {
        healthy: false,
        deathCertificate: createDeathCertificate({
          runId: ctx.runId,
          baseSha: ctx.baseSha,
          install: { step: "install", status: "passed", command: "npm install" },
          build: { step: "build", status: "passed", command: "npm run build" },
          test: { step: "test", status: "failed", command: "npm test", exitCode: 1 },
          failures: [{ step: "test", class: "syntax_error", message: "Syntax error" }],
        }),
        rows: [],
        manifestInspection: {} as any,
        wallClockTimeoutHit: false,
      };
    };

    const orchestrator = new RunOrchestrator({
      host,
      gitService,
      runsDir: repoCtx.runsDir,
      autoApprovePact: true,
      exhumeRunner,
      planRunner,
      workerRunner,
    });
    activeOrchestrators.push(orchestrator);

    const handle = orchestrator.startRun(runId);

    // Wait until legion phase starts and task is active
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (
          handle.getPhase() === "legion" &&
          handle.dispatcher &&
          handle.dispatcher.getLiveCount() > 0
        ) {
          clearInterval(interval);
          resolve(true);
        }
      }, 10);
    });

    // Test resolveApproval and answerAsk
    const approvalRes = await orchestrator.resolveApproval(runId, "app-none", "approved");
    assert.equal(approvalRes, null);

    const askRes = await orchestrator.answerAsk(runId, "ask-none", "re-plan");
    assert.equal(typeof askRes, "boolean");

    // Test killRun
    await orchestrator.killRun(runId, "Admin kill request");
    const result = await handle.promise;

    assert.equal(result.outcome, "killed");
    assert.equal(handle.getPhase(), "done");
    assert.equal(workerAborted, true);

    const finalRun = runStore.getRun(runId);
    assert.equal(finalRun?.phase, "done");
    assert.equal(finalRun?.outcome, "killed");
  });

  it("4. fatal gateway abort safely tears down boxes and transitions to error/done", async () => {
    const runId = "run-fatal-04";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const { host, gitService, runStore } = createIsolatedEnv(repoCtx);

    runStore.createRun({
      runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let workerSignalAborted = false;
    const workerRunner = async (ctx: WorkerContext) => {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 10000);

        if (ctx.signal) {
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            workerSignalAborted = true;
            const err = new Error("Task aborted by fatal");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const planRunner = async (ctx: PlanRunnerContext) => {
      const markdown = "- [ ] T1. Task\n  - role: bonesetter\n  - depends:\n  - files: f.js\n  - accept: npm test\n  - hard: no\n  - rules: M1\n";
      const parsed = parsePact(markdown);
      return {
        ok: true as const,
        draftId: `pact-${ctx.runId}-v1`,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        markdown,
        tasks: parsed.tasks,
        version: 1,
        coverage: {
          ok: true,
          covered: true,
          coveredFailures: [],
          uncoveredFailures: [],
          missingFailures: [],
        },
      };
    };

    const exhumeRunner = async (ctx: ExhumeRunnerContext) => {
      return {
        healthy: false,
        deathCertificate: createDeathCertificate({
          runId: ctx.runId,
          baseSha: ctx.baseSha,
          install: { step: "install", status: "passed", command: "npm install" },
          build: { step: "build", status: "passed", command: "npm run build" },
          test: { step: "test", status: "failed", command: "npm test", exitCode: 1 },
          failures: [{ step: "test", class: "syntax_error", message: "Syntax error" }],
        }),
        rows: [],
        manifestInspection: {} as any,
        wallClockTimeoutHit: false,
      };
    };

    const orchestrator = new RunOrchestrator({
      host,
      gitService,
      runsDir: repoCtx.runsDir,
      autoApprovePact: true,
      exhumeRunner,
      planRunner,
      workerRunner,
    });
    activeOrchestrators.push(orchestrator);

    const handle = orchestrator.startRun(runId);

    // Wait until legion phase starts and task is active
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (
          handle.getPhase() === "legion" &&
          handle.dispatcher &&
          handle.dispatcher.getLiveCount() > 0
        ) {
          clearInterval(interval);
          resolve(true);
        }
      }, 10);
    });

    // Trigger gateway fatal event
    host.gateway.emit("fatal", {
      runId,
      reason: "quarantined",
      result: { ok: false, error: "Security violation" },
    });

    const result = await handle.promise;
    assert.equal(result.outcome, "error");
    assert.equal(handle.getPhase(), "done");
    assert.equal(workerSignalAborted, true);

    const finalRun = runStore.getRun(runId);
    assert.equal(finalRun?.phase, "done");
    assert.equal(finalRun?.outcome, "error");
  });

  it("5. admission queue: enqueueRun, pause/resume, cancelQueuedRun, drainQueue", async () => {
    const runId1 = "run-queue-1";
    const runId2 = "run-queue-2";
    const repoCtx = createTestRepo(runId1);
    tmpDirs.push(repoCtx.tmpDir);

    const { host, gitService, runStore } = createIsolatedEnv(repoCtx);

    runStore.createRun({
      runId: runId1,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    runStore.createRun({
      runId: runId2,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const orchestrator = new RunOrchestrator({
      host,
      gitService,
      runsDir: repoCtx.runsDir,
      maxConcurrentRuns: 1,
    });
    activeOrchestrators.push(orchestrator);

    orchestrator.pauseAdmission();
    assert.equal(orchestrator.isAdmissionPaused(), true);

    const q1 = orchestrator.enqueueRun(runId1);
    const q2 = orchestrator.enqueueRun(runId2);
    assert.equal(q1.queuePosition, 1);
    assert.equal(q2.queuePosition, 2);

    const snapshot = orchestrator.getQueueSnapshot();
    assert.equal(snapshot.queued.length, 2);
    assert.equal(snapshot.paused, true);

    // Cancel runId2 from queue
    const cancelled = orchestrator.cancelQueuedRun(runId2);
    assert.equal(cancelled, true);

    const afterCancel = orchestrator.getQueueSnapshot();
    assert.equal(afterCancel.queued.length, 1);
    assert.equal(afterCancel.queued[0], runId1);

    const run2Record = runStore.getRun(runId2);
    assert.equal(run2Record?.phase, "done");
    assert.equal(run2Record?.outcome, "cancelled");

    // Drain remaining
    const drained = orchestrator.drainQueue();
    assert.deepEqual(drained, [runId1]);
    assert.equal(orchestrator.getQueueSnapshot().queued.length, 0);
  });

  it("6. singleton and factory lifecycle: getRunOrchestrator, resetRunOrchestrator, shutdown", async () => {
    const runId = "run-single-06";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const { host, gitService } = createIsolatedEnv(repoCtx);

    const orch1 = getRunOrchestrator({ host, gitService, runsDir: repoCtx.runsDir });
    const orch2 = getRunOrchestrator();
    assert.equal(orch1, orch2);

    const g = globalThis as unknown as { __runOrchestrator?: unknown };
    assert.equal(g.__runOrchestrator, orch1);

    await resetRunOrchestrator();
    assert.equal(g.__runOrchestrator, undefined);

    const orch3 = createRunOrchestrator({ host, gitService, runsDir: repoCtx.runsDir });
    activeOrchestrators.push(orch3);
    assert.notEqual(orch1, orch3);
    assert.equal(g.__runOrchestrator, orch3);

    await orch3.shutdown();
    assert.equal(g.__runOrchestrator, undefined);
  });
});
