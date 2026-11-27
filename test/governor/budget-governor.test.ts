// Live wiring tests for the per-run BudgetGovernor:
// - the MCP gateway refuses a `sandbox_exec` once a tool-call cap is crossed (without running it);
// - the RunOrchestrator + TaskDispatcher stop dispatching prompts at the cap and finalize with
//   `outcome: "budget_stopped"`.

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BudgetGovernor } from "../../lib/governor/budget-governor";
import { McpGateway } from "../../lib/gateway/mcp-gateway";
import { LogStore } from "../../lib/events/log-store";
import { EventStore, resetDefaultEventStore } from "../../lib/events/event-store";
import { RunStore, resetDefaultRunStore } from "../../lib/runs/run-store";
import { GitService } from "../../lib/git/git-service";
import { parsePact } from "../../lib/pact/pact-parser";
import { createDeathCertificate } from "../../lib/exhume/death-certificate";
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import { RuntimeHost, resetRuntimeHost } from "../../lib/runtime/runtime-host";
import {
  RunOrchestrator,
  resetRunOrchestrator,
  type ExhumeRunnerContext,
  type PlanRunnerContext,
  type FinalCheckContext,
} from "../../lib/orchestrator/run-orchestrator";
import type { WorkerContext, WardenReviewContext } from "../../lib/scheduler/dispatcher";

// ---------------------------------------------------------------------------------------------
// Gateway-level enforcement
// ---------------------------------------------------------------------------------------------

describe("BudgetGovernor: MCP gateway sandbox_exec enforcement", () => {
  it("allows the first sandbox_exec and refuses the second at toolCallsPerRun=1 without running it", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "governor-gw-"));
    const worktreeDir = path.join(baseDir, "wt");
    fs.mkdirSync(worktreeDir, { recursive: true });

    let runCalls = 0;
    const runbox = {
      async run() {
        runCalls += 1;
        return {
          logRef: `log-${runCalls}`,
          exitCode: 0,
          stdoutTail: "ok",
          stderrTail: "",
          timedOut: false,
          oomKilled: false,
        };
      },
    };

    const gateway = new McpGateway({
      defaultTimeoutMs: 60000,
      approvalWaitMs: 300000,
      logStore: new LogStore({ inMemory: true }),
      runbox: runbox as any,
    });
    const runId = "run-governor-gw";
    const skeleton = gateway.registerSkeleton({
      skeletonId: "skel-governor-gw",
      role: "Soul-stitcher",
      worktreeRoot: worktreeDir,
      runId,
    });

    const governor = new BudgetGovernor({ runId, caps: { toolCallsPerRun: 1 } });
    gateway.registerRunBudgetGovernor(runId, governor);

    const first = (await gateway.handleToolCall(skeleton.bearerToken, "sandbox_exec", {
      argv: ["npm", "test"],
      cwd: worktreeDir,
    })) as { status: string };
    assert.equal(first.status, "completed");
    assert.equal(runCalls, 1);

    const second = (await gateway.handleToolCall(skeleton.bearerToken, "sandbox_exec", {
      argv: ["npm", "test"],
      cwd: worktreeDir,
    })) as { status: string; code?: string; dimensions?: string[] };
    assert.equal(second.status, "refused");
    assert.equal(second.code, "BUDGET_EXCEEDED");
    assert.ok(second.dimensions?.includes("toolCallsPerRun"));
    // The refused command never reached the sandbox.
    assert.equal(runCalls, 1);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Orchestrator + dispatcher prompt-budget enforcement
// ---------------------------------------------------------------------------------------------

interface TestRepoContext {
  tmpDir: string;
  gitDir: string;
  baseSha: string;
  runsDir: string;
}

function createTestRepo(runId: string): TestRepoContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `governor-repo-${runId}-`));
  const runsDir = path.join(tmpDir, "runs");
  const gitDir = path.join(runsDir, runId, "git");
  fs.mkdirSync(gitDir, { recursive: true });

  const runGit = (args: string[], cwd = gitDir): string =>
    childProcess
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

  runGit(["init", "--initial-branch=main", "."]);
  runGit(["config", "user.name", "Test Runner"]);
  runGit(["config", "user.email", "runner@example.test"]);
  fs.writeFileSync(
    path.join(gitDir, "package.json"),
    JSON.stringify({ name: "governor-repo", version: "1.0.0" }, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(gitDir, "base.txt"), "Initial base content\n", "utf8");
  runGit(["add", "."]);
  runGit(["commit", "-m", "Initial commit"]);

  const baseSha = runGit(["rev-parse", "HEAD"]);
  runGit(["branch", `graveyard/${runId}`, baseSha]);
  return { tmpDir, gitDir, baseSha, runsDir };
}


describe("BudgetGovernor: RunOrchestrator + TaskDispatcher prompt budget", () => {
  const tmpDirs: string[] = [];
  const activeHosts: RuntimeHost[] = [];
  const activeOrchestrators: RunOrchestrator[] = [];

  beforeEach(async () => {
    await resetRunOrchestrator();
    await resetRuntimeHost({ closeStores: true });
    resetDefaultEventStore();
    resetDefaultRunStore();
  });

  afterEach(async () => {
    for (const orch of activeOrchestrators.splice(0)) {
      try {
        await orch.shutdown();
      } catch {}
    }
    for (const host of activeHosts.splice(0)) {
      try {
        await host.stop({ closeStores: true });
      } catch {}
    }
    await resetRunOrchestrator();
    await resetRuntimeHost({ closeStores: true });
    for (const dir of tmpDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("stops prompt dispatch at promptsPerSkeleton=1 and finalizes with outcome budget_stopped", async () => {
    const runId = "run-governor-prompt";
    const repoCtx = createTestRepo(runId);
    tmpDirs.push(repoCtx.tmpDir);

    const eventStore = new EventStore(path.join(repoCtx.tmpDir, "events.db"));
    const runStore = new RunStore(path.join(repoCtx.tmpDir, "runs.db"));
    const host = new RuntimeHost({
      skipReconcile: true,
      eventStore,
      runStore,
      logStore: new LogStore({ dir: path.join(repoCtx.tmpDir, "logs") }),
      closeStoresOnShutdown: true,
    });
    activeHosts.push(host);
    const gitService = new GitService({ runsDir: repoCtx.runsDir });

    runStore.createRun({
      runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      caps: { promptsPerSkeleton: 1 },
    });

    const pactMarkdown = `
- [ ] T1. First task
  - role: bonesetter
  - depends:
  - files: one.txt
  - accept: node test.js
  - hard: no
  - rules: M1
- [ ] T2. Second task
  - role: bonesetter
  - depends:
  - files: two.txt
  - accept: node test.js
  - hard: no
  - rules: M1
`;

    const exhumeRunner = async (ctx: ExhumeRunnerContext) => ({
      healthy: false,
      deathCertificate: createDeathCertificate({
        runId: ctx.runId,
        baseSha: ctx.baseSha,
        install: { step: "install", status: "passed", command: "npm install" },
        build: { step: "build", status: "passed", command: "npm run build" },
        test: { step: "test", status: "failed", command: "npm test", exitCode: 1 },
        failures: [{ step: "test", class: "syntax_error", message: "boom" }],
      }),
      rows: [],
      manifestInspection: {} as any,
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

    let workerInvocations = 0;
    const workerRunner = async (ctx: WorkerContext) => {
      workerInvocations += 1;
      fs.writeFileSync(path.join(ctx.worktreeDir, `${ctx.taskId}.txt`), "work\n", "utf8");
      return { ok: true, taskId: ctx.taskId, worktreeDir: ctx.worktreeDir };
    };

    const wardenRunner = async (ctx: WardenReviewContext) =>
      buildVerdictRecord(ctx.candidateSha, {
        diff: ctx.diff,
        candidateSha256: ctx.candidateSha256,
        tree: ctx.candidateTree,
        install: { ok: true, ref: "cmd:install" },
        build: { ok: true, ref: "cmd:build" },
        accept: { ok: true, ref: "cmd:accept", exitCode: 0 },
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
    const finalResult = await handle.promise;

    // Dispatch stopped at the limit: exactly one prompt ran, never both tasks.
    assert.equal(workerInvocations, 1);
    assert.equal(handle.scheduler?.isBudgetExceeded, true);
    assert.equal(finalResult.outcome, "budget_stopped");
    assert.equal(handle.getPhase(), "done");
    assert.equal(runStore.getRun(runId)?.outcome, "budget_stopped");
  });
});

