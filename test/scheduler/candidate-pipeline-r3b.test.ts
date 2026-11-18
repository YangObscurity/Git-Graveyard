// candidate-pipeline-r3b.test.ts
// Verification of R4-A1 remediation items 1 to 5 with real git repositories

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import {
  onSubmit,
  isValidSha,
  isValidRef,
  isValidRevisionOrRef,
  isValidPath,
  NO_REVIEWER_INJECTED,
} from "../../lib/scheduler/candidate-submission";
import { EventStore } from "../../lib/events/event-store";
import { Scheduler } from "../../lib/scheduler/scheduler";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";

interface TestGitRepo {
  dir: string;
  runGit: (args: string[]) => string;
  getDiff: (from: string, to: string) => string;
  cleanup: () => void;
}

function createRepo(): TestGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-r3b-"));
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

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-pkg" }, null, 2)
  );
  runGit(["add", "package.json"]);
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

function createEvidenceEvents(
  taskId: string,
  candidateSha256: string,
  tree: string
) {
  return [
    {
      kind: "verdict",
      taskId,
      data: {
        taskId,
        verdict: "approve",
        candidateSha256,
        tree,
      },
    },
    {
      kind: "gate.result",
      taskId,
      data: {
        taskId,
        ok: true,
        tree,
      },
    },
  ];
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
    reasons: [
      {
        text: "Install, build, accept and tests all passed (Requirement 24.5)",
        refs: ["cmd:test"],
      },
    ],
    evidenceRefs: ["cmd:test"],
    checks: {
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
      noTestWeakening: { ok: true },
    },
  };
}

describe("candidate-pipeline-r3b: items 1-5 remediation", () => {
  // ---------------------------------------------------------------------------
  // Item 1: gateRunner removed; onSubmit always runs real gateJs on files read from git
  // ---------------------------------------------------------------------------
  describe("Item 1: real gate execution and removal of gateRunner", () => {
    it("runs real gateJs on files read from candidate tree at verified SHA", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item1-ok";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repo.dir, "src", "index.js"),
          "const message = 'valid js';\nmodule.exports = { message };\n"
        );
        repo.runGit(["add", "src/index.js"]);
        repo.runGit(["commit", "-m", "Add valid src/index.js"]);

        const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, candidateSha);
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

        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          diff,
          allowList: ["src/index.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async () =>
            approveVerdict(candidateSha, candidateSha256, tree),
        });

        assert.equal(res.ok, true);
        assert.equal(res.merged, true);
        assert.equal(res.state, "merged");
        assert.ok(res.gateResult !== undefined);
        assert.equal((res.gateResult as any).ok, true);
      } finally {
        repo.cleanup();
      }
    });

    it("real gateJs catches syntax errors and rejects candidate even if caller claims gateResult ok", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item1-err";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repo.dir, "src", "index.js"),
          "const broken = {{{ syntax error here;\n"
        );
        repo.runGit(["add", "src/index.js"]);
        repo.runGit(["commit", "-m", "Add broken js"]);

        const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, candidateSha);
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

        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          diff,
          allowList: ["src/index.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          // Caller attempts to pass fake gateResult
          gateResult: { ok: true, tree, reasons: [] },
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async () =>
            approveVerdict(candidateSha, candidateSha256, tree),
        });

        assert.equal(res.ok, false);
        assert.equal(res.merged, false);
        assert.equal(res.state, "rejected");
        assert.ok(
          res.reasons.some(
            (r) => r.includes("Unexpected token") || r.includes("syntax")
          ),
          `Expected syntax error reason, got: ${res.reasons.join(", ")}`
        );
      } finally {
        repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Item 2: Candidate SHA comes from git: resolve refs/heads/task/<taskId>
  // ---------------------------------------------------------------------------
  describe("Item 2: candidate SHA resolution from git refs/heads/task/<taskId>", () => {
    it("resolves candidate SHA from git when report.candidateSha is omitted", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item2-resolve";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repo.dir, "src", "index.js"),
          "const a = 10;\nmodule.exports = { a };\n"
        );
        repo.runGit(["add", "src/index.js"]);
        repo.runGit(["commit", "-m", "Commit on task/T1"]);

        const expectedSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${expectedSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, expectedSha);
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

        // candidateSha is NOT provided by caller
        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          diff,
          allowList: ["src/index.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async (_run, candidate) => {
            assert.equal(candidate.candidateSha, expectedSha);
            return approveVerdict(candidate.candidateSha, candidateSha256, tree);
          },
        });

        assert.equal(res.ok, true);
        assert.equal(res.merged, true);
      } finally {
        repo.cleanup();
      }
    });

    it("accepts candidateSha when it matches the resolved ref", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item2-match";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repo.dir, "src", "index.js"),
          "const b = 20;\nmodule.exports = { b };\n"
        );
        repo.runGit(["add", "src/index.js"]);
        repo.runGit(["commit", "-m", "Commit on task/T1"]);

        const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, candidateSha);
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

        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          candidateSha, // matching
          diff,
          allowList: ["src/index.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async () =>
            approveVerdict(candidateSha, candidateSha256, tree),
        });

        assert.equal(res.ok, true);
        assert.equal(res.merged, true);
      } finally {
        repo.cleanup();
      }
    });

    it("rejects candidateSha when it does not equal the resolved ref", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item2-mismatch";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repo.dir, "src", "index.js"),
          "const c = 30;\nmodule.exports = { c };\n"
        );
        repo.runGit(["add", "src/index.js"]);
        repo.runGit(["commit", "-m", "Commit on task/T1"]);

        const realCandidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${realCandidateSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, realCandidateSha);
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

        // Pass headSha (a valid 40-char SHA) as candidateSha, which mismatches realCandidateSha
        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          candidateSha: headSha,
          diff,
          allowList: ["src/index.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async () =>
            approveVerdict(headSha, candidateSha256, tree),
        });

        assert.equal(res.ok, false);
        assert.equal(res.merged, false);
        assert.equal(res.state, "rejected");
        assert.ok(
          res.reasons.some((r) => r.includes("Candidate SHA mismatch")),
          `Expected mismatch reason, got: ${res.reasons.join(", ")}`
        );
      } finally {
        repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Item 3: Validate every revision and ref string before any git call
  // ---------------------------------------------------------------------------
  describe("Item 3: strict validation of revisions and refs", () => {
    it("helper validators enforce strict format", () => {
      // 40-char hex SHAs
      assert.equal(isValidSha("4a7a008ca27d71769aaf5729db0d109a1ba63ed8"), true);
      assert.equal(isValidSha("4A7A008CA27D71769AAF5729DB0D109A1BA63ED8"), true);
      assert.equal(isValidSha("4a7a008c"), false); // too short
      assert.equal(
        isValidSha("4a7a008ca27d71769aaf5729db0d109a1ba63ed80"),
        false
      ); // 41 chars
      assert.equal(
        isValidSha("4a7a008ca27d71769aaf5729db0d109a1ba63edg"),
        false
      ); // non-hex 'g'
      assert.equal(isValidSha("HEAD"), false); // not a sha
      assert.equal(isValidSha(""), false);
      assert.equal(isValidSha(null), false);

      // Strict ref names
      assert.equal(isValidRef("HEAD"), true);
      assert.equal(isValidRef("refs/heads/task/T1"), true);
      assert.equal(isValidRef("refs/heads/graveyard/run-1"), true);
      assert.equal(isValidRef("refs/tags/v1.0.0"), true);
      assert.equal(isValidRef("task/T1"), true);
      assert.equal(isValidRef("graveyard/run-1"), true);

      // Rejections
      assert.equal(isValidRef("HEAD~1"), false);
      assert.equal(isValidRef("master^"), false);
      assert.equal(isValidRef("refs/heads/../etc/passwd"), false);
      assert.equal(isValidRef("refs/heads//main"), false);
      assert.equal(isValidRef("refs/heads/main.lock"), false);
      assert.equal(isValidRef("task/T1; rm -rf /"), false);
      assert.equal(isValidRef("--all"), false);
      assert.equal(isValidRef("-C /etc"), false);
      assert.equal(isValidRef(""), false);
      assert.equal(isValidRef(undefined), false);

      // Revision or ref
      assert.equal(
        isValidRevisionOrRef("4a7a008ca27d71769aaf5729db0d109a1ba63ed8"),
        true
      );
      assert.equal(isValidRevisionOrRef("refs/heads/task/T1"), true);
      assert.equal(isValidRevisionOrRef("HEAD"), true);
      assert.equal(isValidRevisionOrRef("HEAD~1"), false);
      assert.equal(isValidRevisionOrRef("invalid;cmd"), false);

      // Safe path
      assert.equal(isValidPath("src/index.js"), true);
      assert.equal(isValidPath("package.json"), true);
      assert.equal(isValidPath("/etc/passwd"), false);
      assert.equal(isValidPath("../outside.js"), false);
    });

    it("rejects invalid ref strings in taskId before any git call", async () => {
      const repo = createRepo();
      try {
        const scheduler = new Scheduler([
          {
            id: "bad/../task",
            title: "Bad task",
            role: "bonesetter",
            dependencies: [],
            files: ["src/index.js"],
            acceptanceCommand: "npm test",
          } as any,
        ]);
        scheduler.dispatchTask("bad/../task");

        const res = await onSubmit({
          scheduler,
          taskId: "bad/../task",
          runId: "run-item3-bad-taskid",
          gitDir: repo.dir,
          eventStore: new EventStore(),
          diff: "",
        });

        assert.equal(res.ok, false);
        assert.equal(res.state, "rejected");
        assert.ok(
          res.reasons.some(
            (r) =>
              r.includes("invalid candidate ref") || r.includes("Git read failed")
          )
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects non-40-character caller candidateSha before git rev-parse", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item3-invalid-sha";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        repo.runGit(["checkout", "-b", "task/T1"]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const scheduler = new Scheduler([
          {
            id: "T1",
            title: "Task 1",
            role: "bonesetter",
            dependencies: [],
            files: ["package.json"],
            acceptanceCommand: "npm test",
          } as any,
        ]);
        scheduler.dispatchTask("T1");

        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          candidateSha: "HEAD~1", // Invalid sha format
          diff: "",
          gitDir: repo.dir,
          eventStore: new EventStore(),
        });

        assert.equal(res.ok, false);
        assert.equal(res.state, "rejected");
        assert.ok(
          res.reasons.some(
            (r) =>
              r.includes("not a valid 40-character hex SHA") ||
              r.includes("invalid candidate SHA") ||
              r.includes("Caller candidateSha")
          )
        );
      } finally {
        repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Item 4: Deletions come only from git diff --name-status (status D)
  // ---------------------------------------------------------------------------
  describe("Item 4: deletions exclusively from git diff --name-status (status D)", () => {
    it("detects deleted file via git diff --name-status without reading content, allowEmpty=true", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item4-del";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);

        fs.writeFileSync(path.join(repo.dir, "obsolete.js"), "const old = 1;\n");
        repo.runGit(["add", "obsolete.js"]);
        repo.runGit(["commit", "-m", "Add obsolete.js"]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        repo.runGit(["rm", "obsolete.js"]);
        repo.runGit(["commit", "-m", "Delete obsolete.js"]);

        const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, candidateSha);
        const candidateSha256 = candidateSha256FromDiff(diff);

        const scheduler = new Scheduler([
          {
            id: "T1",
            title: "Task 1",
            role: "bonesetter",
            dependencies: [],
            files: ["obsolete.js"],
            acceptanceCommand: "npm test",
          } as any,
        ], { runId });
        scheduler.dispatchTask("T1");

        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          diff,
          allowList: ["obsolete.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async () =>
            approveVerdict(candidateSha, candidateSha256, tree),
        });

        assert.equal(res.ok, true);
        assert.equal(res.merged, true);
        assert.equal(res.state, "merged");

        const gateDeletions = (res.gateResult as any)?.deletions || [];
        assert.ok(
          gateDeletions.includes("obsolete.js"),
          "Deleted file must be detected via status D"
        );
      } finally {
        repo.cleanup();
      }
    });

    it("ignores caller report.deletions and gates modified files", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item4-spoof";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);

        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "code.js"), "const ok = 1;\n");
        repo.runGit(["add", "src/code.js"]);
        repo.runGit(["commit", "-m", "Add src/code.js"]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        // Modify src/code.js with invalid syntax
        fs.writeFileSync(
          path.join(repo.dir, "src", "code.js"),
          "const syntaxError = {{{;\n"
        );
        repo.runGit(["add", "src/code.js"]);
        repo.runGit(["commit", "-m", "Break src/code.js"]);

        const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, candidateSha);
        const candidateSha256 = candidateSha256FromDiff(diff);

        const scheduler = new Scheduler([
          {
            id: "T1",
            title: "Task 1",
            role: "bonesetter",
            dependencies: [],
            files: ["src/code.js"],
            acceptanceCommand: "npm test",
          } as any,
        ]);
        scheduler.dispatchTask("T1");

        // Caller attempts to spoof deletions so file isn't read/gated
        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          diff,
          allowList: ["src/code.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          // Spoofed caller inputs must be ignored
          deletions: ["src/code.js"],
          deletedFiles: ["src/code.js"],
          deletedPaths: ["src/code.js"],
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async () =>
            approveVerdict(candidateSha, candidateSha256, tree),
        } as any);

        assert.equal(res.ok, false);
        assert.equal(res.merged, false);
        assert.equal(res.state, "rejected");
        assert.ok(
          res.reasons.some(
            (r) => r.includes("Unexpected token") || r.includes("syntax")
          ),
          `Expected syntax rejection because modified file must be gated, got: ${res.reasons.join(", ")}`
        );
      } finally {
        repo.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Item 5: Gate tree is candidate tree read from git; separate expected vs current head
  // ---------------------------------------------------------------------------
  describe("Item 5: gate tree binding and separate expected vs current integration head", () => {
    it("rejects when verdict tree does not match candidate tree read from git", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item5-tree";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        const headSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repo.dir, "src", "index.js"),
          "const x = 99;\nmodule.exports = { x };\n"
        );
        repo.runGit(["add", "src/index.js"]);
        repo.runGit(["commit", "-m", "Commit on task/T1"]);

        const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const realTree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
        const bogusTree = "0000000000000000000000000000000000000000";
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(headSha, candidateSha);
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

        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          diff,
          allowList: ["src/index.js"],
          gitDir: repo.dir,
          eventStore: new EventStore(),
          events: createEvidenceEvents("T1", candidateSha256, realTree),
          // The verdict itself passes validateWardenVerdict and carries all
          // checks; only the tree is wrong, so the rejection reason is the
          // tree mismatch, not a verdict validation failure.
          wardenReviewer: async () =>
            approveVerdict(candidateSha, candidateSha256, bogusTree), // Tree mismatch
        });

        assert.equal(res.ok, false);
        assert.equal(res.state, "rejected");
        assert.ok(
          res.reasons.some((r) => r.includes("does not match candidate tree")),
          `Expected tree mismatch reason, got: ${res.reasons.join(", ")}`
        );
      } finally {
        repo.cleanup();
      }
    });

    it("detects concurrent integration head update between submission time and merge check time", async () => {
      const repo = createRepo();
      try {
        const runId = "run-item5-concurrent";
        repo.runGit(["checkout", "-b", `graveyard/${runId}`]);
        const initialHeadSha = repo.runGit(["rev-parse", "HEAD"]);

        repo.runGit(["checkout", "-b", "task/T1"]);
        fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repo.dir, "src", "index.js"),
          "const c = 1;\nmodule.exports = { c };\n"
        );
        repo.runGit(["add", "src/index.js"]);
        repo.runGit(["commit", "-m", "Task commit"]);

        const candidateSha = repo.runGit(["rev-parse", "HEAD"]);
        const tree = repo.runGit(["rev-parse", `${candidateSha}^{tree}`]);
        repo.runGit(["checkout", `graveyard/${runId}`]);

        const diff = repo.getDiff(initialHeadSha, candidateSha);
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

        const res = await onSubmit({
          scheduler,
          taskId: "T1",
          runId,
          diff,
          allowList: ["src/index.js"],
          gitDir: repo.dir,
          expectedIntegrationHeadSha: initialHeadSha,
          eventStore: new EventStore(),
          events: createEvidenceEvents("T1", candidateSha256, tree),
          wardenReviewer: async () => {
            // Concurrent change: advance graveyard branch before merge check runs!
            fs.writeFileSync(
              path.join(repo.dir, "concurrent.txt"),
              "concurrent change on integration branch\n"
            );
            repo.runGit(["add", "concurrent.txt"]);
            repo.runGit(["commit", "-m", "Concurrent integration update"]);

            return approveVerdict(candidateSha, candidateSha256, tree);
          },
        });

        // The current integration head was read again from git and no longer equals expectedHeadSha
        assert.equal(res.ok, false);
        assert.equal(res.merged, false);
        assert.equal(res.state, "rejected");
        assert.ok(
          res.reasons.some(
            (r) =>
              r.includes("Integration_Head moved during review") ||
              r.includes("Merge gate check failed")
          ),
          `Expected head moved reason, got: ${res.reasons.join(", ")}`
        );
      } finally {
        repo.cleanup();
      }
    });
  });
});
