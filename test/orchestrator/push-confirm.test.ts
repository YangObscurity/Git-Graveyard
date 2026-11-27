// Task 21.5: Explicit push confirmation wiring (Requirement 29.5).
// Validates: Requirement 29.5.

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RunOrchestrator,
  resetRunOrchestrator,
  type ExhumeRunnerContext,
  type PlanRunnerContext,
  type FinalCheckContext,
} from "../../lib/orchestrator/run-orchestrator";
import {
  RuntimeHost,
  resetRuntimeHost,
} from "../../lib/runtime/runtime-host";
import {
  EventStore,
  resetDefaultEventStore,
} from "../../lib/events/event-store";
import {
  RunStore,
  resetDefaultRunStore,
} from "../../lib/runs/run-store";
import {
  LogStore,
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-confirm-" + runId + "-"));
  const runsDir = path.join(tmpDir, "runs");
  const gitDir = path.join(runsDir, runId, "git");
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
  fs.writeFileSync(
    path.join(gitDir, "package.json"),
    JSON.stringify(
      { name: "test-repo", version: "1.0.0", scripts: { test: "node test.js" } },
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
  runGit(["branch", `graveyard/${runId}`, baseSha]);

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

describe("RunOrchestrator: explicit push confirmation (Requirement 29.5)", () => {
  const tmpDirs: string[] = [];
  const activeHosts: RuntimeHost[] = [];
  const activeOrchestrators: RunOrchestrator[] = [];

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

  interface Harness {
    host: RuntimeHost;
    gitService: GitService;
    runStore: RunStore;
    eventStore: EventStore;
    pushCalls: Array<{ runId: string; options: Record<string, unknown> }>;
  }

  function createHarness(repoCtx: TestRepoContext): Harness {
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
    const pushCalls: Harness["pushCalls"] = [];
    (gitService as unknown as { pushToFork: unknown }).pushToFork = async (
      runId: string,
      options: Record<string, unknown>
    ) => {
      pushCalls.push({ runId, options });
      return {
        ok: true,
        runId,
        branch: (options.branchName as string) ?? `graveyard/${runId}`,
        targetRepoUrl: options.targetRepoUrl as string,
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      };
    };
    return { host, gitService, runStore, eventStore, pushCalls };
  }

  const pactMarkdown = `
- [ ] T1. Feature Fix
  - role: bonesetter
  - depends:
  - files: feature.txt
  - accept: node test.js
  - hard: no
  - rules: M1
`;

  function buildRunners() {
    const exhumeRunner = async (ctx: ExhumeRunnerContext) => ({
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
      manifestInspection: {} as never,
      wallClockTimeoutHit: false,
    });

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
      childProcess.execFileSync("git", ["add", "feature.txt"], { cwd: ctx.worktreeDir });
      childProcess.execFileSync("git", ["commit", "-m", "Add feature.txt"], {
        cwd: ctx.worktreeDir,
      });
      return { ok: true, taskId: ctx.taskId, worktreeDir: ctx.worktreeDir };
    };

    const wardenRunner = async (ctx: WardenReviewContext) =>
      buildVerdictRecord(ctx.candidateSha, {
        diff: ctx.diff,
        candidateSha256: ctx.candidateSha256,
        tree: ctx.candidateTree,
        install: { ok: true, ref: "cmd:npm-install" },
        build: { ok: true, ref: "cmd:npm-build" },
        accept: { ok: true, ref: "cmd:node test.js", exitCode: 0 },
        tests: { ok: true, ref: "cmd:tests" },
        noTestWeakening: true,
      });

    const finalCheckRunner = async (_ctx: FinalCheckContext) => ({
      ok: true,
      passed: true,
      installPassed: true,
      buildPassed: true,
      testsPassed: true,
      hasTests: true,
    });

    return { exhumeRunner, planRunner, workerRunner, wardenRunner, finalCheckRunner };
  }

  function seedRun(
    harness: Harness,
    repoCtx: TestRepoContext,
    metadata?: Record<string, unknown>
  ): void {
    harness.runStore.createRun({
      runId: repoCtx.runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      pushFlag: true,
      pushTargetFork: "https://github.com/fork-owner/example-repo",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: metadata ?? null,
    });
  }


  async function runWithPush(
    repoCtx: TestRepoContext,
    options: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    preStart?: (harness: Harness) => void
  ): Promise<Harness> {
    const harness = createHarness(repoCtx);
    seedRun(harness, repoCtx, metadata);
    preStart?.(harness);
    const runners = buildRunners();
    const orchestrator = new RunOrchestrator({
      host: harness.host,
      gitService: harness.gitService,
      runsDir: repoCtx.runsDir,
      ...runners,
      ...(options as Record<string, never>),
    } as never);
    activeOrchestrators.push(orchestrator);
    const handle = orchestrator.startRun(repoCtx.runId);
    await handle.promise;
    return harness;
  }

  it("pushes when pushConfirm option is true and forwards pushConfirm/eventStore", async () => {
    const repoCtx = createTestRepo("run-pc-option");
    tmpDirs.push(repoCtx.tmpDir);
    const harness = await runWithPush(repoCtx, { pushConfirm: true });

    assert.equal(harness.pushCalls.length, 1);
    const opts = harness.pushCalls[0].options;
    assert.equal(opts.pushConfirm, true);
    assert.equal(opts.eventStore, harness.host.eventStore);
    assert.equal(opts.targetRepoUrl, "https://github.com/fork-owner/example-repo");
    assert.equal(opts.sourceRepoUrl, "https://github.com/git-graveyard/example-repo");
  });

  it("pushes when run metadata records pushConfirm: true", async () => {
    const repoCtx = createTestRepo("run-pc-meta");
    tmpDirs.push(repoCtx.tmpDir);
    const harness = await runWithPush(repoCtx, {}, { pushConfirm: true });
    assert.equal(harness.pushCalls.length, 1);
  });

  it("pushes when an ask.answered event recorded a push_confirm 'Push'", async () => {
    const repoCtx = createTestRepo("run-pc-ask");
    tmpDirs.push(repoCtx.tmpDir);
    const harness = await runWithPush(repoCtx, {}, undefined, (h) => {
      h.eventStore.append({
        runId: repoCtx.runId,
        kind: "ask.answered",
        actor: "user",
        data: { askId: "ask-push", kind: "push_confirm", answer: "Push" },
      });
    });
    assert.equal(harness.pushCalls.length, 1);
  });

  it("pushes when requestPushConfirmation resolves true and receives the push info", async () => {
    const repoCtx = createTestRepo("run-pc-cb");
    tmpDirs.push(repoCtx.tmpDir);
    let seen: Record<string, unknown> | null = null;
    const harness = await runWithPush(repoCtx, {
      requestPushConfirmation: (info: Record<string, unknown>) => {
        seen = info;
        return true;
      },
    });
    assert.equal(harness.pushCalls.length, 1);
    assert.deepEqual(seen, {
      runId: repoCtx.runId,
      targetFork: "https://github.com/fork-owner/example-repo",
      branch: `graveyard/${repoCtx.runId}`,
    });
  });

  it("skips the push and emits push.result when no confirmation is granted", async () => {
    const repoCtx = createTestRepo("run-pc-skip");
    tmpDirs.push(repoCtx.tmpDir);
    const harness = await runWithPush(repoCtx, {
      requestPushConfirmation: () => false,
    });
    assert.equal(harness.pushCalls.length, 0);
    const results = harness.eventStore.getEvents(repoCtx.runId, { kind: "push.result" });
    assert.equal(results.length, 1);
    assert.equal(results[0].data.ok, false);
    assert.equal(results[0].data.skipped, true);
    assert.ok(String(results[0].data.reason).includes("Explicit push confirmation not granted"));
  });

  it("emits a redacted push.result on failure unless pushToFork already recorded one", async () => {
    const repoCtx = createTestRepo("run-pc-fail");
    tmpDirs.push(repoCtx.tmpDir);
    const harness = createHarness(repoCtx);
    seedRun(harness, repoCtx);
    (harness.gitService as unknown as { pushToFork: unknown }).pushToFork = async (
      runId: string,
      options: Record<string, unknown>
    ) => {
      (options.eventStore as { append: (e: Record<string, unknown>) => void }).append({
        runId,
        kind: "push.result",
        actor: "necromancer",
        data: { ok: false, reason: "recorded by git service" },
      });
      throw new Error("remote rejected the push");
    };
    const runners = buildRunners();
    const orchestrator = new RunOrchestrator({
      host: harness.host,
      gitService: harness.gitService,
      runsDir: repoCtx.runsDir,
      ...runners,
      pushConfirm: true,
    });
    activeOrchestrators.push(orchestrator);
    const handle = orchestrator.startRun(repoCtx.runId);
    await handle.promise;

    const results = harness.eventStore.getEvents(repoCtx.runId, { kind: "push.result" });
    assert.equal(results.length, 1, "push.result must not be double-emitted");
    assert.equal(results[0].data.reason, "recorded by git service");
  });
});

