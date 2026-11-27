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
  type RunExecutionHandle,
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
  it("updates only toolCallsPerRun in place on Pact approval, preserving Exhume/Plan usage and the run wall clock", async () => {
    const runId = "run-governor-cap-update";
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

    const INITIAL_TOOL_CALLS_CAP = 4;
    const APPROVED_TOOL_CALLS_CAP = 8;
    const WALL_CLOCK_CAP_MS = 1200;
    const PLAN_ELAPSED_MS = 500;
    const PACT_HOLD_MS = 250;
    const LEGION_ELAPSED_MS = 900;
    const PLAN_TOOL_CALLS = 2;

    runStore.createRun({
      runId,
      url: "https://github.com/git-graveyard/example-repo",
      sha: repoCtx.baseSha,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      caps: { toolCallsPerRun: INITIAL_TOOL_CALLS_CAP, runWallClockMs: WALL_CLOCK_CAP_MS },
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

    const waitFor = (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
      const started = Date.now();
      return new Promise<void>((resolve, reject) => {
        const tick = () => {
          let ok = false;
          try {
            ok = predicate();
          } catch {
            ok = false;
          }
          if (ok) {
            resolve();
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error("waitFor timed out"));
            return;
          }
          setTimeout(tick, 10);
        };
        tick();
      });
    };

    let orchestratorHandle: RunExecutionHandle | undefined;
    let capturedGovernor: BudgetGovernor | undefined;
    let wallBeforeApproval = 0;

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
      const governor = orchestratorHandle?.budgetGovernor;
      assert.ok(governor, "the per-run governor must exist during Plan");
      capturedGovernor = governor;
      // Exhume / Plan already spent tool calls and wall-clock time before the Pact is approved.
      for (let i = 0; i < PLAN_TOOL_CALLS; i += 1) {
        governor!.recordToolCall("plan-skeleton");
      }
      await new Promise((resolve) => setTimeout(resolve, PLAN_ELAPSED_MS));
      wallBeforeApproval = governor!.runWallClockMs();
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
      fs.writeFileSync(path.join(ctx.worktreeDir, "feature.txt"), "resurrected\n", "utf8");
      // Legion spends enough wall-clock time that cumulative Exhume/Plan + Legion crosses the cap.
      await new Promise((resolve) => setTimeout(resolve, LEGION_ELAPSED_MS));
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
      autoApprovePact: false,
      exhumeRunner,
      planRunner,
      workerRunner,
      wardenRunner,
      finalCheckRunner,
    });
    activeOrchestrators.push(orchestrator);

    const handle = orchestrator.startRun(runId);
    orchestratorHandle = handle;

    // Wait for Plan to finish and hold the Pact review open so the Pact wait is measurable.
    await waitFor(() => handle.getPhase() === "pact_review");
    await new Promise((resolve) => setTimeout(resolve, PACT_HOLD_MS));

    const governorBeforeApproval = capturedGovernor;
    assert.ok(governorBeforeApproval, "Plan captured the running governor");
    assert.ok(wallBeforeApproval >= PLAN_ELAPSED_MS, "Plan spent real wall-clock time");

    // The Pact approval changes ONLY toolCallsPerRun.
    await orchestrator.approvePact(runId, {
      approvedTaskIds: ["T1"],
      approvedBy: "tester",
      caps: { toolCallsPerRun: APPROVED_TOOL_CALLS_CAP },
    });

    const finalResult = await handle.promise;

    // The exact same governor instance survived the grant.
    assert.ok(handle.budgetGovernor, "the run keeps a governor");
    assert.equal(handle.budgetGovernor, governorBeforeApproval);
    // Metering survived the grant: the Exhume/Plan tool calls are still counted.
    assert.equal(handle.budgetGovernor!.totalToolCallsSoFar(), PLAN_TOOL_CALLS);
    // Only toolCallsPerRun changed; the run wall-clock cap is unchanged.
    assert.equal(
      handle.budgetGovernor!.getCap("toolCallsPerRun"),
      APPROVED_TOOL_CALLS_CAP
    );
    assert.equal(handle.budgetGovernor!.getCap("runWallClockMs"), WALL_CLOCK_CAP_MS);
    // The Pact wait was tracked (and is therefore excluded from the run wall clock).
    assert.ok(
      handle.budgetGovernor!.pactWaitMs() >= 200,
      "the Pact review wait is excluded from the run wall clock"
    );
    // The unchanged wall-clock cap is still enforced from cumulative Exhume/Plan + Legion time, so
    // the run stops rather than letting a rebuilt governor's fresh clock forgive that time.
    assert.equal(
      handle.budgetGovernor!.getExceededDimensions().includes("runWallClockMs"),
      true
    );
    assert.equal(handle.scheduler?.isBudgetExceeded, true);
    assert.equal(finalResult.outcome, "budget_stopped");
    // The run wall clock was not reset: it still reflects the Plan time spent before approval.
    assert.ok(
      handle.budgetGovernor!.runWallClockMs() >= PLAN_ELAPSED_MS,
      "the run wall clock must not be reset by the Pact approval"
    );

    // A `cap_update` event recorded the toolCallsPerRun change (not the grant's `cap_increase`).
    const updates = eventStore.getEvents(runId, { kind: "budget.update" });
    assert.ok(
      updates.some(
        (event) =>
          (event.data as { change?: string; dimension?: string }).change === "cap_update" &&
          (event.data as { dimension?: string }).dimension === "toolCallsPerRun"
      ),
      "a cap_update budget.update event records the toolCallsPerRun change"
    );
  });

});

