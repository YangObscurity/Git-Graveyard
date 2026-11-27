// Task 13.2 / T34 Wave 2A: Unit & integration tests for TaskDispatcher
// Requirements: 13.8, 13.9, 13.10, 23.1-23.15, 24.5-24.16, 25.6-25.8

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TaskDispatcher,
  type WorkerContext,
  type WardenReviewContext,
} from "../../lib/scheduler/dispatcher";
import { Scheduler } from "../../lib/scheduler/scheduler";
import { GitService } from "../../lib/git/git-service";
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
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SkeletonSupervisor } from "../../lib/supervisor/skeleton-supervisor";
import { CLAUDE_SONNET_5_5_MODEL_ID } from "../../lib/supervisor/model-allowlist";

/**
 * Minimal injectable child process for exercising a headless turn through a
 * Dispatcher-constructed supervisor without spawning a real OS process.
 */
class DispatcherMockChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | string | null = null;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface TestRepoContext {
  tmpDir: string;
  gitDir: string;
  runId: string;
  baseSha: string;
  cleanup: () => void;
}

function createTestRepo(runId: string): TestRepoContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-test-"));
  const gitDir = path.join(tmpDir, "git");
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
    JSON.stringify({ name: "graveyard-test", version: "1.0.0" }, null, 2),
    "utf8"
  );
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
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("TaskDispatcher: T34 Wave 2A Execution & Merge Pipeline", () => {
  const tmpDirs: string[] = [];
  const activeHosts: RuntimeHost[] = [];

  beforeEach(async () => {
    await resetRuntimeHost({ closeStores: true });
    resetDefaultEventStore();
    resetDefaultRunStore();
    resetDefaultLogStore();
  });

  afterEach(async () => {
    for (const h of activeHosts) {
      try {
        await h.stop({ closeStores: true });
      } catch {}
    }
    activeHosts.length = 0;

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

  it("(i) multi-task dependency DAG (parallel + sequential tasks) dispatching with slot limits", async () => {
    const runId = "run-dag-01";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const host = new RuntimeHost({
      skipReconcile: true,
      eventStore: new EventStore(path.join(repoCtx.tmpDir, "events.db")),
      runStore: new RunStore(path.join(repoCtx.tmpDir, "runs.db")),
      logStore: new LogStore({ dir: path.join(repoCtx.tmpDir, "logs") }),
      closeStoresOnShutdown: true,
    });
    activeHosts.push(host);
    const gitService = new GitService({ runsDir: repoCtx.tmpDir });

    const pactMarkdown = `
- [ ] T1. Task A
  - role: bonesetter
  - depends:
  - files: a.txt
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Task B
  - role: bonesetter
  - depends:
  - files: b.txt
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T3. Task C
  - role: soul-stitcher
  - depends: T1, T2
  - files: c.txt
  - accept: npm test
  - hard: yes
  - rules: M2
- [ ] T4. Task D
  - role: soul-stitcher
  - depends: T3
  - files: d.txt
  - accept: npm test
  - hard: no
  - rules: M2
`;

    const scheduler = new Scheduler({
      pact: pactMarkdown,
      runId,
      runParallelCap: 2,
    });

    const executionOrder: string[] = [];
    let peakLiveCount = 0;

    const fileMap: Record<string, string> = {
      T1: "a.txt",
      T2: "b.txt",
      T3: "c.txt",
      T4: "d.txt",
    };

    const workerRunner = async (ctx: WorkerContext) => {
      executionOrder.push(ctx.taskId);
      const live = scheduler.getLiveSkeletonsCount();
      if (live > peakLiveCount) {
        peakLiveCount = live;
      }

      const fileName = fileMap[ctx.taskId] ?? `${ctx.taskId}.txt`;
      fs.writeFileSync(
        path.join(ctx.worktreeDir, fileName),
        `Content for ${ctx.taskId}\n`,
        "utf8"
      );

      childProcess.execFileSync("git", ["add", fileName], {
        cwd: ctx.worktreeDir,
      });
      childProcess.execFileSync(
        "git",
        ["commit", "-m", `Implement ${ctx.taskId}`],
        { cwd: ctx.worktreeDir }
      );
    };

    const wardenRunner = async (ctx: WardenReviewContext) => {
      return buildVerdictRecord(ctx.candidateSha, {
        diff: ctx.diff,
        candidateSha256: ctx.candidateSha256,
        tree: ctx.candidateTree,
        install: { ok: true, ref: "cmd:install" },
        build: { ok: true, ref: "cmd:build" },
        accept: { ok: true, ref: "cmd:accept", exitCode: 0 },
        tests: { ok: true, ref: "cmd:tests" },
        noTestWeakening: true,
      });
    };

    const dispatcher = new TaskDispatcher({
      runId,
      scheduler,
      gitService,
      host,
      runDir: repoCtx.tmpDir,
      gitDir: repoCtx.gitDir,
      baseSha: repoCtx.baseSha,
      workerRunner,
      wardenRunner,
      pollIntervalMs: 10,
    });

    const result = await dispatcher.run();

    assert.equal(result.status, "completed");
    assert.equal(result.tasksMerged, 4);
    assert.equal(result.tasksFailed, 0);

    // Verify DAG dependencies ordering
    const idxA = executionOrder.indexOf("T1");
    const idxB = executionOrder.indexOf("T2");
    const idxC = executionOrder.indexOf("T3");
    const idxD = executionOrder.indexOf("T4");

    assert.ok(idxA !== -1 && idxB !== -1);
    assert.ok(idxC > idxA && idxC > idxB, "T3 must execute after T1 and T2");
    assert.ok(idxD > idxC, "T4 must execute after T3");

    // Slot limit respected: peak live count <= runParallelCap (2)
    assert.ok(peakLiveCount <= 2, `Peak live count was ${peakLiveCount}, expected <= 2`);

    // Verify all 4 files merged on integration branch
    const showFile = (f: string) => {
      return childProcess
        .execFileSync(
          "git",
          ["show", `graveyard/${runId}:${f}`],
          { cwd: repoCtx.gitDir, encoding: "utf8" }
        )
        .trim();
    };

    assert.equal(showFile("a.txt"), "Content for T1");
    assert.equal(showFile("b.txt"), "Content for T2");
    assert.equal(showFile("c.txt"), "Content for T3");
    assert.equal(showFile("d.txt"), "Content for T4");

    // Verify all tasks in scheduler are terminal 'merged'
    assert.ok(scheduler.isAllTerminal());
    assert.equal(scheduler.getTask("T1")?.state, "merged");
    assert.equal(scheduler.getTask("T2")?.state, "merged");
    assert.equal(scheduler.getTask("T3")?.state, "merged");
    assert.equal(scheduler.getTask("T4")?.state, "merged");

    await host.stop();
  });

  it("(ii) approved candidate verified through real onSubmit -> Warden verdict SHA256 match -> merged onto integration branch -> worktree cleaned", async () => {
    const runId = "run-submit-ok";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const host = new RuntimeHost({
      skipReconcile: true,
      eventStore: new EventStore(path.join(repoCtx.tmpDir, "events.db")),
      runStore: new RunStore(path.join(repoCtx.tmpDir, "runs.db")),
      logStore: new LogStore({ dir: path.join(repoCtx.tmpDir, "logs") }),
      closeStoresOnShutdown: true,
    });
    activeHosts.push(host);
    const gitService = new GitService({ runsDir: repoCtx.tmpDir });

    const pactMarkdown = `
- [ ] T1. Feature Task
  - role: bonesetter
  - depends:
  - files: feature.js
  - accept: node feature.js
  - hard: no
  - rules: M1
`;

    const scheduler = new Scheduler({
      pact: pactMarkdown,
      runId,
    });

    let capturedWorktreeDir = "";
    let capturedVerdictSha256 = "";
    let wardenCalled = false;

    const workerRunner = async (ctx: WorkerContext) => {
      capturedWorktreeDir = ctx.worktreeDir;
      assert.ok(fs.existsSync(ctx.worktreeDir));
      assert.equal(ctx.model, scheduler.getModelTier("T1"));

      const code = "console.log('Feature works');\n";
      fs.writeFileSync(path.join(ctx.worktreeDir, "feature.js"), code, "utf8");

      childProcess.execFileSync("git", ["add", "feature.js"], {
        cwd: ctx.worktreeDir,
      });
      childProcess.execFileSync("git", ["commit", "-m", "Add feature.js"], {
        cwd: ctx.worktreeDir,
      });
    };

    const wardenRunner = async (ctx: WardenReviewContext) => {
      wardenCalled = true;
      assert.ok(ctx.candidateSha.length === 40);
      assert.ok(ctx.candidateSha256.length === 64);
      assert.ok(ctx.diff.includes("feature.js"));
      capturedVerdictSha256 = ctx.candidateSha256;

      return buildVerdictRecord(ctx.candidateSha, {
        diff: ctx.diff,
        candidateSha256: ctx.candidateSha256,
        tree: ctx.candidateTree,
        install: { ok: true, ref: "cmd:npm-install" },
        build: { ok: true, ref: "cmd:npm-build" },
        accept: { ok: true, ref: "cmd:node feature.js", exitCode: 0 },
        tests: { ok: true, ref: "cmd:tests" },
        noTestWeakening: true,
      });
    };

    let onAfterMergeCalled = false;
    const dispatcher = new TaskDispatcher({
      runId,
      scheduler,
      gitService,
      host,
      runDir: repoCtx.tmpDir,
      gitDir: repoCtx.gitDir,
      baseSha: repoCtx.baseSha,
      workerRunner,
      wardenRunner,
      onAfterMerge: (task, res) => {
        onAfterMergeCalled = true;
        assert.equal(task.id, "T1");
        assert.ok(res.merged);
      },
    });

    const stepResult = await dispatcher.step();

    assert.equal(stepResult.status, "completed");
    assert.equal(stepResult.tasksMerged, 1);
    assert.ok(wardenCalled);
    assert.ok(onAfterMergeCalled);

    // Verify task state is merged
    const task = scheduler.getTask("T1");
    assert.equal(task?.state, "merged");

    // Verify candidate merged onto graveyard integration branch
    const integrationHead = await gitService.getIntegrationHeadSha(
      runId,
      repoCtx.gitDir
    );
    const content = childProcess
      .execFileSync(
        "git",
        ["show", `${integrationHead}:feature.js`],
        { cwd: repoCtx.gitDir, encoding: "utf8" }
      )
      .trim();
    assert.equal(content, "console.log('Feature works');");

    // Verify worktree cleaned up
    assert.ok(capturedWorktreeDir.length > 0);
    assert.equal(
      fs.existsSync(capturedWorktreeDir),
      false,
      "Task worktree must be removed after successful merge"
    );

    // Verify eventStore logged task.merged
    const events = host.eventStore.getEvents(runId);
    const mergedEvent = events.find((e) => e.kind === "task.merged");
    assert.ok(mergedEvent);
    assert.equal(mergedEvent.taskId, "T1");

    await host.stop();
  });

  it("(iii) rejected candidate triggering retry/re-dispatch and failure after maxAttempts", async () => {
    const runId = "run-reject-retry";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const host = new RuntimeHost({
      skipReconcile: true,
      eventStore: new EventStore(path.join(repoCtx.tmpDir, "events.db")),
      runStore: new RunStore(path.join(repoCtx.tmpDir, "runs.db")),
      logStore: new LogStore({ dir: path.join(repoCtx.tmpDir, "logs") }),
      closeStoresOnShutdown: true,
    });
    activeHosts.push(host);
    const gitService = new GitService({ runsDir: repoCtx.tmpDir });

    const pactMarkdown = `
- [ ] T1. Failing Task
  - role: bonesetter
  - depends:
  - files: bug.js
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Dependent Task
  - role: soul-stitcher
  - depends: T1
  - files: dep.js
  - accept: npm test
  - hard: no
  - rules: M1
`;

    const scheduler = new Scheduler({
      pact: pactMarkdown,
      runId,
      maxAttempts: 2,
    });

    let attemptCount = 0;
    const worktreeDirs: string[] = [];

    const workerRunner = async (ctx: WorkerContext) => {
      attemptCount++;
      worktreeDirs.push(ctx.worktreeDir);

      fs.writeFileSync(
        path.join(ctx.worktreeDir, "bug.js"),
        `// Attempt ${attemptCount} broken code\n`,
        "utf8"
      );

      childProcess.execFileSync("git", ["add", "bug.js"], {
        cwd: ctx.worktreeDir,
      });
      childProcess.execFileSync(
        "git",
        ["commit", "-m", `Attempt ${attemptCount}`],
        { cwd: ctx.worktreeDir }
      );
    };

    const wardenRunner = async (ctx: WardenReviewContext) => {
      return buildVerdictRecord(ctx.candidateSha, {
        diff: ctx.diff,
        candidateSha256: ctx.candidateSha256,
        tree: ctx.candidateTree,
        install: {
          ok: false,
          ref: "cmd:npm-install",
          reason: "Syntax failure in bug.js",
        },
        build: { ok: true, ref: "cmd:npm-build" },
        accept: { ok: false, ref: "cmd:accept" },
        tests: { ok: false, ref: "cmd:tests" },
        noTestWeakening: false,
      });
    };

    const dispatcher = new TaskDispatcher({
      runId,
      scheduler,
      gitService,
      host,
      runDir: repoCtx.tmpDir,
      gitDir: repoCtx.gitDir,
      baseSha: repoCtx.baseSha,
      workerRunner,
      wardenRunner,
      pollIntervalMs: 10,
    });

    const loopResult = await dispatcher.run();

    assert.equal(attemptCount, 2, "Task should have attempted exactly 2 times (maxAttempts = 2)");
    assert.equal(loopResult.tasksFailed, 1);
    assert.equal(loopResult.tasksMerged, 0);

    // Verify T1 failed
    const taskFail = scheduler.getTask("T1");
    assert.equal(taskFail?.state, "failed");
    assert.equal(taskFail?.attempts, 2);

    // Verify dependent task is blocked
    const taskDep = scheduler.getTask("T2");
    assert.equal(taskDep?.state, "blocked");

    // Verify worktrees were cleaned
    for (const wt of worktreeDirs) {
      assert.equal(fs.existsSync(wt), false, `Worktree ${wt} should be cleaned`);
    }

    await host.stop();
  });

  it("(iv) pause/resume and stop()/abort canceling running worker cleanly with no dangling handles", async () => {
    const runId = "run-pause-stop";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const host = new RuntimeHost({
      skipReconcile: true,
      eventStore: new EventStore(path.join(repoCtx.tmpDir, "events.db")),
      runStore: new RunStore(path.join(repoCtx.tmpDir, "runs.db")),
      logStore: new LogStore({ dir: path.join(repoCtx.tmpDir, "logs") }),
      closeStoresOnShutdown: true,
    });
    activeHosts.push(host);
    const gitService = new GitService({ runsDir: repoCtx.tmpDir });

    const pactMarkdown = `
- [ ] T1. First Task
  - role: bonesetter
  - depends:
  - files: p1.txt
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Second Task
  - role: bonesetter
  - depends:
  - files: p2.txt
  - accept: npm test
  - hard: no
  - rules: M1
`;

    const scheduler = new Scheduler({
      pact: pactMarkdown,
      runId,
      runParallelCap: 1,
    });

    let p1Ran = false;
    let p2Cancelled = false;

    const workerRunner = async (ctx: WorkerContext) => {
      if (ctx.taskId === "T1") {
        p1Ran = true;
        fs.writeFileSync(
          path.join(ctx.worktreeDir, "p1.txt"),
          "p1 content\n",
          "utf8"
        );
        childProcess.execFileSync("git", ["add", "p1.txt"], {
          cwd: ctx.worktreeDir,
        });
        childProcess.execFileSync("git", ["commit", "-m", "Commit p1"], {
          cwd: ctx.worktreeDir,
        });
        return;
      }

      if (ctx.taskId === "T2") {
        return new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve();
          }, 30000);

          if (ctx.signal) {
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              p2Cancelled = true;
              const err = new Error("Task aborted by stop");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      }
    };

    const wardenRunner = async (ctx: WardenReviewContext) => {
      return buildVerdictRecord(ctx.candidateSha, {
        diff: ctx.diff,
        candidateSha256: ctx.candidateSha256,
        tree: ctx.candidateTree,
        install: { ok: true, ref: "cmd:install" },
        build: { ok: true, ref: "cmd:build" },
        accept: { ok: true, ref: "cmd:accept", exitCode: 0 },
        tests: { ok: true, ref: "cmd:tests" },
        noTestWeakening: true,
      });
    };

    const dispatcher = new TaskDispatcher({
      runId,
      scheduler,
      gitService,
      host,
      runDir: repoCtx.tmpDir,
      gitDir: repoCtx.gitDir,
      baseSha: repoCtx.baseSha,
      workerRunner,
      wardenRunner,
      pollIntervalMs: 10,
    });

    // 1. Test Pause & Resume
    dispatcher.pause();
    assert.equal(dispatcher.isPaused(), true);

    const stepWhilePaused = await dispatcher.step();
    assert.equal(stepWhilePaused.status, "idle");
    assert.equal(p1Ran, false, "No task should run while paused");

    dispatcher.resume();
    assert.equal(dispatcher.isPaused(), false);

    // Run one step to complete T1
    const step1 = await dispatcher.step();
    assert.equal(p1Ran, true);
    assert.equal(scheduler.getTask("T1")?.state, "merged");

    // 2. Test Stop & Abort on T2
    assert.equal(scheduler.getTask("T2")?.state, "ready");

    const runPromise = dispatcher.run();

    // Wait for T2 to enter activeTasks (git worktree setup may exceed 50ms on slower filesystems)
    for (let i = 0; i < 80 && dispatcher.getLiveCount() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(dispatcher.getLiveCount(), 1);
    assert.ok(dispatcher.getActiveTask("T2"));

    // Now call stop
    await dispatcher.stop("User abort request");

    const finalResult = await runPromise;
    assert.equal(dispatcher.stopped, true);
    assert.equal(dispatcher.isStopped, true);
    assert.equal(finalResult.status, "stopped");
    assert.ok(p2Cancelled, "Worker signal should have received abort event");
    assert.equal(dispatcher.getLiveCount(), 0, "No active tasks should remain");

    await host.stop();
  });

  it("handles merge_rollback_failed fail-fast and triggers stop", async () => {
    const runId = "run-failfast";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const host = new RuntimeHost({
      skipReconcile: true,
      eventStore: new EventStore(path.join(repoCtx.tmpDir, "events.db")),
      runStore: new RunStore(path.join(repoCtx.tmpDir, "runs.db")),
      logStore: new LogStore({ dir: path.join(repoCtx.tmpDir, "logs") }),
      closeStoresOnShutdown: true,
    });
    activeHosts.push(host);
    const gitService = new GitService({ runsDir: repoCtx.tmpDir });

    const pactMarkdown = `
- [ ] T1. Explosive Task
  - role: bonesetter
  - depends:
  - files: boom.js
  - accept: npm test
  - hard: no
  - rules: M1
`;

    const scheduler = new Scheduler({
      pact: pactMarkdown,
      runId,
    });

    const workerRunner = async (ctx: WorkerContext) => {
      fs.writeFileSync(
        path.join(ctx.worktreeDir, "boom.js"),
        "console.log('boom');\n",
        "utf8"
      );
      childProcess.execFileSync("git", ["add", "boom.js"], {
        cwd: ctx.worktreeDir,
      });
      childProcess.execFileSync("git", ["commit", "-m", "Commit boom"], {
        cwd: ctx.worktreeDir,
      });
    };

    // Monkey-patch gitService.rollbackIntegrationRef to simulate rollback failure
    (gitService as any).rollbackIntegrationRef = async () => {
      return {
        ok: false,
        reason: "Simulated rollback update-ref disk error",
      };
    };

    // Monkey-patch scheduler.mergeTask to fail after git merge succeeds to trigger rollback
    const originalMergeTask = scheduler.mergeTask.bind(scheduler);
    scheduler.mergeTask = () => {
      throw new Error("Simulated scheduler merge state failure");
    };

    const dispatcher = new TaskDispatcher({
      runId,
      scheduler,
      gitService,
      host,
      runDir: repoCtx.tmpDir,
      gitDir: repoCtx.gitDir,
      baseSha: repoCtx.baseSha,
      workerRunner,
      wardenRunner: async (ctx) => {
        return buildVerdictRecord(ctx.candidateSha, {
          diff: ctx.diff,
          candidateSha256: ctx.candidateSha256,
          tree: ctx.candidateTree,
          install: { ok: true, ref: "cmd:install" },
          build: { ok: true, ref: "cmd:build" },
          accept: { ok: true, ref: "cmd:accept", exitCode: 0 },
          tests: { ok: true, ref: "cmd:tests" },
          noTestWeakening: true,
        });
      },
    });

    const stepResult = await dispatcher.step();
    assert.equal(stepResult.status, "failed");
    assert.equal(dispatcher.isStopped, true);
    assert.ok(
      stepResult.reason?.includes("rollback") ||
        stepResult.error !== undefined
    );

    await host.stop();
  });

  it("(v) createWorkerSupervisor forwards probeResults/onApproval and a default onAskAutoDeny that spawns a headless turn and emits ask.auto_denied", async () => {
    const runId = "run-dispatch-headless";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const eventStore = new EventStore(path.join(repoCtx.tmpDir, "events.db"));
    const gitService = new GitService({ runsDir: repoCtx.tmpDir });

    const pactMarkdown = `
- [ ] T1. Headless Task
  - role: bonesetter
  - depends:
  - files: h.txt
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const scheduler = new Scheduler({ pact: pactMarkdown, runId });
    const task = scheduler.getTask("T1");
    assert.ok(task);

    const capturedOpts: any[] = [];
    let spawnCount = 0;

    const dispatcher = new TaskDispatcher({
      runId,
      scheduler,
      gitService,
      eventStore,
      runDir: path.join(repoCtx.tmpDir, "run"),
      gitDir: repoCtx.gitDir,
      baseSha: repoCtx.baseSha,
      probeResults: { P1: { passed: false }, P14: { passed: true } },
      onApproval: () => "approve",
      // onAskAutoDeny is intentionally omitted: the Dispatcher must supply a
      // production default from its event sink.
      supervisorFactory: (opts) => {
        capturedOpts.push(opts);
        return new SkeletonSupervisor({
          ...opts,
          spawnFn: ((command: string, args: readonly string[]) => {
            spawnCount += 1;
            void args;
            const child = new DispatcherMockChild();
            setImmediate(() => {
              child.stdout.write(
                JSON.stringify({
                  type: "session",
                  sessionId: "cli-dispatch",
                  model: CLAUDE_SONNET_5_5_MODEL_ID,
                }) + "\n"
              );
              child.stdout.write(
                JSON.stringify({
                  type: "ask_request",
                  askId: "ask-9",
                  question: "Proceed?",
                  options: ["yes", "no"],
                }) + "\n"
              );
              child.stdout.end();
              setImmediate(() => {
                child.exitCode = 0;
                child.emit("close", 0);
              });
            });
            return child as any;
          }) as any,
        });
      },
    });

    const supervisor = (dispatcher as any).createWorkerSupervisor(
      task,
      "skel-dispatch-headless",
      path.join(repoCtx.tmpDir, "wt"),
      undefined
    );

    // The Dispatcher forwarded its probe results and approval bridge.
    assert.equal(capturedOpts.length, 1);
    const opts = capturedOpts[0];
    assert.deepEqual(opts.probeResults, {
      P1: { passed: false },
      P14: { passed: true },
    });
    assert.equal(typeof opts.onApproval, "function");
    assert.equal(
      typeof opts.onAskAutoDeny,
      "function",
      "the Dispatcher must supply a default onAskAutoDeny from its event sink"
    );

    await supervisor.raise();
    await supervisor.prompt("do work");

    assert.equal(spawnCount, 1, "the headless turn must spawn exactly one process");

    const events = eventStore.getEvents(runId);
    const autoDenied = events.find((e) => e.kind === "ask.auto_denied");
    assert.ok(autoDenied, "ask.auto_denied event must be emitted");
    assert.equal(autoDenied.actor, "SkeletonSupervisor");
    assert.equal(autoDenied.skeletonId, "skel-dispatch-headless");
    const data = autoDenied.data as any;
    assert.equal(data.askId, "ask-9");
    assert.equal(data.question, "Proceed?");
    assert.deepEqual(data.options, ["yes", "no"]);

    await supervisor.finish();
  });

  it("buildDefaultAskAutoDeny awaits emitEvent and rejects cleanly when the sink rejects", async () => {
    const runId = "run-ask-deny-reject";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-ask-deny-"));
    tmpDirs.push(tmpDir);

    const gitService = new GitService({ runsDir: tmpDir });
    const pactMarkdown = `
- [ ] T1. Ask Deny Task
  - role: bonesetter
  - depends:
  - files: a.txt
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const scheduler = new Scheduler({ pact: pactMarkdown, runId });
    const sinkError = new Error("emit sink boom");
    const dispatcher = new TaskDispatcher({
      runId,
      scheduler,
      gitService,
      // The event sink rejects: the default onAskAutoDeny must surface that
      // rejection instead of resolving or floating it as an unhandled rejection.
      emitEvent: () => Promise.reject(sinkError),
    });

    const onAskAutoDeny = (dispatcher as any).buildDefaultAskAutoDeny(
      "skel-ask-deny"
    );
    assert.equal(typeof onAskAutoDeny, "function");

    await assert.rejects(
      async () => {
        await onAskAutoDeny({
          askId: "ask-1",
          toolCallId: null,
          text: "Proceed?",
          raw: { type: "ask_request", askId: "ask-1", text: "Proceed?" },
        });
      },
      (err: any) => {
        assert.equal(err, sinkError);
        return true;
      }
    );
  });
});
