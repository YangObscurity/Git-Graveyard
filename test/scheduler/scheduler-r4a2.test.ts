// Work package R4-A2a: Scheduler merge git proof, atomic apply, no public apply path (audit B-3, N-4)
// Work package SA2: the scheduler merge path only accepts a VerifiedMerge
// issued by GitService.mergeCandidate; the passing evidence below is built
// around one real proof created through the real GitService path.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import { GitService, VerifiedMerge } from "../../lib/git/git-service";
import { buildVerdictRecord } from "../../lib/warden/warden-review";
import { Scheduler } from "../../lib/scheduler/scheduler";
import type { PactTask } from "../../lib/pact/pact-parser";
import type { TaskMergeEvidence } from "../../lib/scheduler/types";
import { EventStore } from "../../lib/events/event-store";

interface Sa2RealMergeProof {
  verifiedMerge: VerifiedMerge;
  candidateSha: string;
  candidateSha256: string;
  diff: string;
  tree: string;
}

async function createSa2RealMergeProof(): Promise<Sa2RealMergeProof> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-sa2-r4a2-"));
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

    const integrationBranch = "graveyard/run-sa2-r4a2";
    runGit(["branch", integrationBranch, baseSha]);
    runGit(["checkout", "-b", "task/sa2-r4a2", integrationBranch]);
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
      runId: "run-sa2-r4a2",
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

function createTestTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Task 1",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["lib/a.js"],
      filesInScope: ["lib/a.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: [],
      ruleIds: [],
      line: 1,
    },
    {
      id: "T2",
      title: "Task 2",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/b.js"],
      filesInScope: ["lib/b.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: [],
      ruleIds: [],
      line: 2,
    },
  ];
}

function createPassingEvidence(
  taskId: string,
  overrides?: {
    gitMerge?: any;
    candidateSha?: string;
  }
): TaskMergeEvidence {
  const diff = sa2RealProof.diff;
  const tree = sa2RealProof.tree;
  const candidateSha = overrides?.candidateSha ?? sa2RealProof.candidateSha;
  const candidateSha256 = candidateSha256FromDiff(diff);
  const eventSource = new EventStore(":memory:");
  eventSource.append({
    runId: "run-sa2-r4a2",
    kind: "task.state",
    actor: "scheduler",
    taskId,
    data: {
      taskId,
      state: "in_review",
    },
  });
  eventSource.append({
    runId: "run-sa2-r4a2",
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
    runId: "run-sa2-r4a2",
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

  let gitMerge: any = undefined;
  if (overrides && "gitMerge" in overrides) {
    gitMerge = overrides.gitMerge;
  } else {
    gitMerge = sa2RealProof.verifiedMerge;
  }

  const evidence: TaskMergeEvidence = {
    taskId,
    runId: "run-sa2-r4a2",
    diff,
    tree,
    candidateSha,
    candidateSha256,
    eventSource,
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

  if (gitMerge !== undefined) {
    (evidence as any).gitMerge = gitMerge;
  }

  return evidence;
}

describe("R4-A2a: Scheduler merge git proof, atomic apply, and public apply path removal (audit B-3, N-4)", () => {
  it("merge without gitMerge is refused and the state stays in_review", () => {
    const scheduler = new Scheduler(createTestTasks(), { runId: "run-sa2-r4a2" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "in_review");

    const evidence = createPassingEvidence("T1", { gitMerge: undefined });
    const result = scheduler.mergeTask("T1", evidence);

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(result.reason, "git merge proof missing");
    assert.deepEqual(result.reasons, ["git merge proof missing"]);
    assert.equal(t1.state, "in_review");
  });

  it("ancestorVerified false is refused and the state stays in_review", () => {
    const scheduler = new Scheduler(createTestTasks(), { runId: "run-sa2-r4a2" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "in_review");

    const evidence = createPassingEvidence("T1", {
      gitMerge: {
        candidateSha: "1111111111111111111111111111111111111111",
        integrationHeadSha: "2222222222222222222222222222222222222222",
        ancestorVerified: false,
      },
    });
    const result = scheduler.mergeTask("T1", evidence);

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(result.reason, "git merge proof missing");
    assert.deepEqual(result.reasons, ["git merge proof missing"]);
    assert.equal(t1.state, "in_review");
  });

  it("a mismatched candidate sha is refused and the state stays in_review", () => {
    const scheduler = new Scheduler(createTestTasks(), { runId: "run-sa2-r4a2" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;
    assert.equal(t1.state, "in_review");

    const evidence = createPassingEvidence("T1", {
      candidateSha: "1111111111111111111111111111111111111111",
      gitMerge: {
        candidateSha: "3333333333333333333333333333333333333333",
        integrationHeadSha: "2222222222222222222222222222222222222222",
        ancestorVerified: true,
      },
    });
    const result = scheduler.mergeTask("T1", evidence);

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(result.reason, "git merge proof missing");
    assert.deepEqual(result.reasons, ["git merge proof missing"]);
    assert.equal(t1.state, "in_review");
  });

  it("a valid proof merges and releases a dependent whose only dependency this was", () => {
    const scheduler = new Scheduler(createTestTasks(), { runId: "run-sa2-r4a2" });
    assert.equal(scheduler.getTask("T1")?.state, "ready");
    assert.equal(scheduler.getTask("T2")?.state, "pending");

    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
    assert.equal(scheduler.getTask("T2")?.state, "pending");

    const evidence = createPassingEvidence("T1");
    const result = scheduler.mergeTask("T1", evidence);

    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
    assert.equal(scheduler.getTask("T1")?.state, "merged");
    assert.equal(scheduler.getTask("T2")?.state, "ready");
  });

  it("atomic apply: if releasing a dependent throws, restore all recorded states and return failed result", () => {
    const scheduler = new Scheduler(createTestTasks(), { runId: "run-sa2-r4a2" });
    scheduler.dispatchTask("T1");
    scheduler.submitForReview("T1");
    const t1 = scheduler.getTask("T1")!;
    const t2 = scheduler.getTask("T2")!;
    assert.equal(t1.state, "in_review");
    assert.equal(t2.state, "pending");

    const originalAreAllDependenciesMerged = (
      scheduler as any
    ).areAllDependenciesMerged.bind(scheduler);
    (scheduler as any).areAllDependenciesMerged = (task: any) => {
      if (task.id === "T2") {
        throw new Error("Simulated dependent release failure");
      }
      return originalAreAllDependenciesMerged(task);
    };

    const evidence = createPassingEvidence("T1");
    const result = scheduler.mergeTask("T1", evidence);

    assert.equal(result.ok, false);
    assert.equal(result.merged, false);
    assert.equal(result.reason, "Simulated dependent release failure");
    assert.equal(scheduler.getTask("T1")?.state, "in_review");
    assert.equal(scheduler.getTask("T2")?.state, "pending");
  });

  it("public api: only canMergeTask and mergeTask are public; checkMergeAllowed alias removed", () => {
    const scheduler = new Scheduler(createTestTasks());
    assert.equal(typeof scheduler.canMergeTask, "function");
    assert.equal(typeof scheduler.mergeTask, "function");
    assert.equal((scheduler as any).checkMergeAllowed, undefined);
  });
});
