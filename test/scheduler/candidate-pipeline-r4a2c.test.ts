// candidate-pipeline-r4a2c.test.ts
// Verification of R4-A2c remediation (audit N-2 HIGH):
// Candidate pipeline writes gate.result and verdict events from its own checks.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { onSubmit } from "../../lib/scheduler/candidate-submission";
import { Scheduler } from "../../lib/scheduler/scheduler";
import { EventStore } from "../../lib/events/event-store";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

interface TestGitRepo {
  dir: string;
  runGit: (args: string[]) => string;
  getDiff: (from: string, to: string) => string;
  cleanup: () => void;
}

function createRepo(): TestGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-r4a2c-"));
  const runGit = (args: string[]) =>
    childProcess
      .execFileSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      })
      .trim();

  const getDiff = (from: string, to: string) =>
    childProcess.execFileSync("git", ["diff", from, to], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Worker"]);
  runGit(["config", "user.email", "worker@graveyard"]);

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-pkg" }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "src", "index.js"),
    "const initial = 0;\nmodule.exports = { initial };\n"
  );
  runGit(["add", "package.json", "src/index.js"]);
  runGit(["commit", "-m", "Initial commit"]);

  return {
    dir,
    runGit,
    getDiff,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

// A reviewer result that passes validateWardenVerdict and carries install,
// build, accept and tests all passing (audit N-A1, N-A4).
function approveVerdict(
  candidateSha: string,
  candidateSha256: string,
  tree: string
) {
  return {
    verdict: "approve",
    status: "approve",
    candidateSha,
    candidateSha256,
    tree,
    reasons: [{ text: "Install, build, accept and tests all passed (Requirement 24.5)", refs: ["cmd:npm-test"] }],
    checks: {
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      noTestWeakening: { ok: true },
    },
  };
}

describe("candidate-pipeline-r4a2c: event recording and merge proof (audit N-2 HIGH)", () => {
  it("a successful submission leaves one gate.result event and one verdict event that carry the candidate tree", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2c-success";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const baseHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 42;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Implement T1"]);

      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(baseHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
        {
          id: "T2",
          title: "Task 2",
          role: "bonesetter",
          dependencies: ["T1"],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;
      const t2 = scheduler.getTask("T2")!;

      const eventStore = new EventStore();

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore,
        wardenReviewer: async () =>
          approveVerdict(candidateSha, candidateSha256, tree),
      });

      assert.equal(res.ok, true);
      assert.equal(res.merged, true);
      assert.equal(res.state, "merged");
      assert.equal(t1.state, "merged");
      assert.equal(t2.state, "ready");

      const events = eventStore.getEvents(runId);
      const gateEvents = events.filter((e) => e.kind === "gate.result");
      const verdictEvents = events.filter((e) => e.kind === "verdict");

      assert.equal(
        gateEvents.length,
        1,
        `Expected exactly 1 gate.result event, got ${gateEvents.length}`
      );
      assert.equal(
        verdictEvents.length,
        1,
        `Expected exactly 1 verdict event, got ${verdictEvents.length}`
      );

      const gateEvent = gateEvents[0];
      assert.equal(gateEvent.taskId, "T1");
      assert.equal(gateEvent.data.ok, true);
      assert.equal(
        gateEvent.data.tree,
        tree,
        "gate.result event must carry candidate tree"
      );
      assert.equal(gateEvent.data.candidateSha, candidateSha);

      const verdictEvent = verdictEvents[0];
      assert.equal(verdictEvent.taskId, "T1");
      assert.equal(verdictEvent.data.verdict, "approve");
      assert.equal(verdictEvent.data.candidateSha256, candidateSha256);
      assert.equal(verdictEvent.data.candidateSha, candidateSha);
      assert.equal(
        verdictEvent.data.tree,
        tree,
        "verdict event must carry candidate tree"
      );

      // Verify integration ref in git was updated to candidateSha
      const finalHeadSha = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(finalHeadSha, candidateSha);
    } finally {
      repo.cleanup();
    }
  });

  it("a caller-supplied gateResult with ok true does not replace a failing real gate", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2c-caller-gate-override";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const baseHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const broken = {{{ invalid syntax here\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Broken commit"]);

      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(baseHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      const eventStore = new EventStore();

      // Caller passes fake gateResult with ok=true
      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore,
        gateResult: { ok: true, tree, reasons: [] },
        wardenReviewer: async () =>
          approveVerdict(candidateSha, candidateSha256, tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        res.reasons.some(
          (r) =>
            r.includes("syntax") ||
            r.includes("Unexpected token") ||
            r.includes("failed")
        ),
        `Expected syntax error reason, got: ${res.reasons.join(", ")}`
      );

      // Verify that gate.result event in event store recorded ok=false
      const events = eventStore.getEvents(runId);
      const gateEvents = events.filter((e) => e.kind === "gate.result");
      assert.equal(gateEvents.length, 1);
      assert.equal(
        gateEvents[0].data.ok,
        false,
        "Real gate failure must be written to event store with ok=false"
      );
      assert.equal(gateEvents[0].data.tree, tree);

      // Verify integration ref was NOT updated
      const finalHeadSha = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(finalHeadSha, baseHeadSha);
    } finally {
      repo.cleanup();
    }
  });

  it("a submission without an event store is refused before any merge", async () => {
    const repo = createRepo();
    try {
      const runId = "r4a2c-no-event-store";
      repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
      const baseHeadSha = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["checkout", "-b", "task/T1"]);
      fs.writeFileSync(
        path.join(repo.dir, "src", "index.js"),
        "const valid = 99;\nmodule.exports = { valid };\n"
      );
      repo.runGit(["add", "src/index.js"]);
      repo.runGit(["commit", "-m", "Valid commit"]);

      const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
      const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
      repo.runGit(["checkout", `graveyard/${runId}`]);

      const diff = repo.getDiff(baseHeadSha, candidateSha);
      const candidateSha256 = candidateSha256FromDiff(diff);

      const scheduler = new Scheduler([
        {
          id: "T1",
          title: "Task 1",
          role: "bonesetter",
          dependencies: [],
          files: ["src/index.js"],
          acceptanceCommand: "npm test",
        } as any,
      ], { runId });
      scheduler.dispatchTask("T1");
      const t1 = scheduler.getTask("T1")!;

      // Call onSubmit without eventStore
      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId,
        diff,
        allowList: ["src/index.js"],
        gitDir: repo.dir,
        eventStore: undefined,
        wardenReviewer: async () =>
          approveVerdict(candidateSha, candidateSha256, tree),
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "rejected");
      assert.equal(t1.state, "rejected");
      assert.ok(
        res.reasons.some((r) =>
          r.includes("event store required for merge proof")
        ),
        `Expected reason 'event store required for merge proof', got: ${res.reasons.join(", ")}`
      );
      assert.equal(res.reason, "event store required for merge proof");

      // Verify no merge occurred
      const finalHeadSha = repo.runGit(["rev-parse", `graveyard/${runId}`]);
      assert.equal(finalHeadSha, baseHeadSha);
    } finally {
      repo.cleanup();
    }
  });
});
