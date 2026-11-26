import test, { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initPythonParser,
  planPythonEdits,
  applyM1,
  type PythonPlannedEdit,
} from "../../lib/rules/m1-python";
import {
  checkPythonCandidateGate,
  errorCount,
  gatePython,
  gatePythonSync,
} from "../../lib/grimoire/python-gate";
import { parsePython } from "../../lib/rules/m1-python";
import { GitService } from "../../lib/git/git-service";
import { EventStore } from "../../lib/events/event-store";
import { Scheduler } from "../../lib/scheduler/scheduler";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import { onSubmit } from "../../lib/scheduler/candidate-submission";
import type { PactTask } from "../../lib/pact/pact-parser";

before(async () => {
  await initPythonParser();
});

function makeEdit(
  ruleOrder: number,
  start: number,
  end: number,
  replacement: string,
  line = 1
): PythonPlannedEdit {
  return {
    ruleId: "M1",
    ruleOrder,
    line,
    confidence: "high",
    description: "test edit",
    start,
    end,
    replacement,
    splices: [{ start, end, replacement }],
  };
}

function makeEventStore(): {
  events: any[];
  store: { append(input: any): any };
} {
  const events: any[] = [];
  const store = {
    append(input: any) {
      events.push(input);
      return {
        runId: input.runId ?? "run-gate",
        seq: events.length - 1,
        ts: 0,
        kind: input.kind,
        actor: input.actor,
        data: input.data,
      };
    },
  };
  return { events, store };
}

describe("errorCount", () => {
  it("counts error and missing nodes, and is zero for valid Python", () => {
    assert.equal(errorCount(parsePython("x = 1\n")!), 0);
    assert.ok(errorCount(parsePython("def f(:\n")!) > 0);
  });
});

describe("gatePython monotone acceptance (Requirement 9.1-9.4)", () => {
  it("accepts edits that keep errors flat and strictly reduce residue", async () => {
    const src = "print x\nprint y\n";
    const plan = planPythonEdits(src, "a.py")!;
    const result = await gatePython(src, plan.edits, { file: "a.py" });
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.residueBefore, 2);
    assert.equal(result.residueAfter, 0);
    assert.equal(result.text, "print(x)\nprint(y)\n");
    assert.equal(result.label, "m1-clean");
    assert.equal(result.reverted, false);
  });

  it("rejects an edit that raises the parse error count (gate_errors_rose)", async () => {
    const src = "print x\n";
    const bad = makeEdit(1, 0, 7, "print(x,", 1);
    const result = await gatePython(src, [bad], { file: "a.py" });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, "gate_errors_rose");
    assert.equal(result.label, "m1-partial");
    assert.equal(result.reverted, true);
    assert.equal(result.revertReason, "all_edits_rejected");
    // buildStep must carry the same revertReason as the file result, not hardcode.
    assert.equal(result.step.revertReason, result.revertReason);
    assert.equal(result.step.revertReason, "all_edits_rejected");
    assert.ok(result.unknowns.some((u) => u.reason === "gate_errors_rose"));
    assert.ok(result.unknowns.every((u) => typeof u.line === "number"));
  });

  it("rejects an edit that does not reduce residue (gate_residue_not_reduced)", async () => {
    const src = "print x\n";
    const noop = makeEdit(1, 7, 7, " ", 1);
    const result = await gatePython(src, [noop], { file: "a.py" });
    assert.equal(result.rejected[0].reason, "gate_residue_not_reduced");
    assert.equal(result.reverted, true);
    assert.equal(result.revertReason, "all_edits_rejected");
    assert.equal(result.step.revertReason, result.revertReason);
    assert.equal(result.step.revertReason, "all_edits_rejected");
  });

  it("returns the original text unchanged on parse timeout", async () => {
    const src = "print x\n";
    const plan = planPythonEdits(src, "a.py")!;
    const result = await gatePython(src, plan.edits, {
      file: "a.py",
      parse: () => null,
    });
    assert.equal(result.text, src);
    assert.equal(result.reverted, true);
    assert.equal(result.revertReason, "parse_timeout");
    // step.revertReason must not hardcode "all_edits_rejected" on parse timeout.
    assert.equal(result.step.revertReason, result.revertReason);
    assert.equal(result.step.revertReason, "parse_timeout");
    assert.ok(result.unknowns.some((u) => u.reason === "parse_timeout"));
  });

  it("labels a file with remaining residue m1-partial", async () => {
    const src = "print x\nexec code in ns\n";
    const plan = planPythonEdits(src, "a.py")!;
    const result = await gatePython(src, plan.edits, { file: "a.py" });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.residueAfter, 1);
    assert.equal(result.label, "m1-partial");
  });

  it("exposes a synchronous gate once the parser is initialized", () => {
    const plan = planPythonEdits("print x\n", "a.py")!;
    const result = gatePythonSync("print x\n", plan.edits, { file: "a.py" });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.text, "print(x)\n");
    assert.equal(result.step.ruleId, "M1");
  });
});

describe("checkPythonCandidateGate (Requirement 9.10, 9.11, 9.13)", () => {
  it("passes a candidate whose Python files keep errors flat and residue non-increasing", async () => {
    const before = [{ path: "src/a.py", content: "print x\n" }];
    const after = [{ path: "src/a.py", content: applyM1("print x\n") }];
    const { events, store } = makeEventStore();
    const result = await checkPythonCandidateGate(
      { before, after },
      { eventStore: store, refs: ["ref-1"], actor: "grimoire" }
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ["src/a.py"]);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.kind, "gate.result");
    assert.equal(result.gate, "syntax");

    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.kind, "gate.result");
    assert.equal(event.actor, "grimoire");
    assert.deepEqual(event.data.refs, ["ref-1"]);
    assert.equal(event.data.gate, "syntax");
    assert.equal(event.data.language, "python");
    assert.equal(event.data.ok, true);
    assert.deepEqual(event.data.files, ["src/a.py"]);
    assert.deepEqual(event.data.reasons, []);
  });

  it("fails a candidate whose Python residue rises", async () => {
    const before = [{ path: "a.py", content: "print(x, y)\n" }];
    const after = [{ path: "a.py", content: "print(x, y)\nprint a\n" }];
    const result = await checkPythonCandidateGate({ before, after }, {});
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("gate_residue_not_reduced")));
    assert.deepEqual(result.files, ["a.py"]);
  });

  it("fails a candidate whose Python parse-error count rises", async () => {
    const before = [{ path: "a.py", content: "x = 1\n" }];
    const after = [{ path: "a.py", content: "def f(:\n" }];
    const result = await checkPythonCandidateGate({ before, after }, {});
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("gate_errors_rose")));
  });

  it("accepts an empty change set and still reports a passing gate", async () => {
    const files = [{ path: "a.py", content: "print(x)\n" }];
    const result = await checkPythonCandidateGate(
      { before: files, after: files },
      {}
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, []);
  });

  it("emits gate.result through an emit function", async () => {
    const emitted: any[] = [];
    await checkPythonCandidateGate(
      {
        before: [{ path: "a.py", content: "print x\n" }],
        after: [{ path: "a.py", content: "print(x)\n" }],
      },
      { emit: (event) => emitted.push(event), refs: [] }
    );
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "gate.result");
    assert.equal(emitted[0].data.ok, true);
  });

  it("carries the candidate tree on both the GateResult and the gate.result event data", async () => {
    const { events, store } = makeEventStore();
    const emitted: any[] = [];
    const tree = "1111111111111111111111111111111111111111";
    const result = await checkPythonCandidateGate(
      {
        before: [{ path: "a.py", content: "print x\n" }],
        after: [{ path: "a.py", content: "print(x)\n" }],
        tree,
      },
      { eventStore: store, emit: (event) => emitted.push(event), refs: [] }
    );
    assert.equal(result.ok, true);
    assert.equal(result.tree, tree);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.tree, tree);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].data.tree, tree);
  });

  it("propagates candidateTree supplied via options to the result and event data", async () => {
    const { events, store } = makeEventStore();
    const emitted: any[] = [];
    const tree = "2222222222222222222222222222222222222222";
    const result = await checkPythonCandidateGate(
      {
        before: [{ path: "a.py", content: "print x\n" }],
        after: [{ path: "a.py", content: "print(x)\n" }],
      },
      {
        eventStore: store,
        candidateTree: tree,
        emit: (event) => emitted.push(event),
        refs: [],
      }
    );
    assert.equal(result.tree, tree);
    assert.equal(events[0].data.tree, tree);
    assert.equal(emitted[0].data.tree, tree);
  });

  it("omits tree from the result and gate.result event data when no tree is supplied", async () => {
    const { events, store } = makeEventStore();
    const emitted: any[] = [];
    const result = await checkPythonCandidateGate(
      {
        before: [{ path: "a.py", content: "print x\n" }],
        after: [{ path: "a.py", content: "print(x)\n" }],
      },
      { eventStore: store, emit: (event) => emitted.push(event), refs: [] }
    );
    assert.ok(!("tree" in result));
    assert.equal(events.length, 1);
    assert.ok(!("tree" in events[0].data));
    assert.equal(emitted.length, 1);
    assert.ok(!("tree" in emitted[0].data));
  });

  it("only inspects changed .py files and ignores other languages", async () => {
    const before = [
      { path: "a.py", content: "print x\n" },
      { path: "b.js", content: "const x = 1;\n" },
    ];
    const after = [
      { path: "a.py", content: "print(x)\n" },
      { path: "b.js", content: "const = ;\n" },
    ];
    const result = await checkPythonCandidateGate({ before, after }, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ["a.py"]);
  });

  it("rejects Py2-residue files when before/head is absent (no self-comparison)", async () => {
    const result = await checkPythonCandidateGate(
      { files: [{ path: "legacy.py", content: "print x\n" }] },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("gate_residue_not_reduced")));
  });

  it("passes clean Py3 new files when before/head is absent", async () => {
    const result = await checkPythonCandidateGate(
      { files: [{ path: "clean.py", content: "print(x)\n" }] },
      {}
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ["clean.py"]);
  });

  it("rejects missing afterContent on new files without baseline", async () => {
    const result = await checkPythonCandidateGate(
      { changedFiles: ["new_missing.py"] },
      {}
    );
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("content not supplied")));
    assert.equal(result.details?.["new_missing.py"]?.error, "content not supplied");
  });

  it("accepts valid deletion when present in before or listed in deletions", async () => {
    const fromBefore = await checkPythonCandidateGate(
      {
        before: [{ path: "old.py", content: "print x\n" }],
        after: [],
        changedFiles: ["old.py"],
      },
      {}
    );
    assert.equal(fromBefore.ok, true);
    assert.equal(fromBefore.details?.["old.py"]?.ok, true);

    const fromDeletions = await checkPythonCandidateGate(
      {
        deletions: ["removed.py"],
        changedFiles: ["removed.py"],
      },
      {}
    );
    assert.equal(fromDeletions.ok, true);
    assert.equal(fromDeletions.details?.["removed.py"]?.ok, true);
  });
});

describe("candidate-submission Python gate wiring", () => {
  function setupPyRepo(initialContent: string, nextContent: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-cand-sub-"));
    const gitDir = path.join(tmpDir, "git");
    fs.mkdirSync(gitDir, { recursive: true });
    const runGit = (args: string[]) =>
      childProcess
        .execFileSync("git", args, {
          cwd: gitDir,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        })
        .trim();

    runGit(["init", "--initial-branch=main", "."]);
    runGit(["config", "user.name", "Test Runner"]);
    runGit(["config", "user.email", "runner@example.test"]);

    fs.writeFileSync(path.join(gitDir, "app.py"), initialContent);
    runGit(["add", "app.py"]);
    runGit(["commit", "-m", "init"]);
    const baseSha = runGit(["rev-parse", "HEAD"]);
    const runId = "run-py-gate";
    runGit(["branch", `graveyard/${runId}`, baseSha]);

    fs.writeFileSync(path.join(gitDir, "app.py"), nextContent);
    runGit(["add", "app.py"]);
    runGit(["commit", "-m", "candidate"]);
    const candidateSha = runGit(["rev-parse", "HEAD"]);
    const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
    runGit(["branch", "task/T1", candidateSha]);

    const diff = childProcess.execFileSync(
      "git",
      ["diff", "--binary", "--no-color", baseSha, candidateSha],
      {
        cwd: gitDir,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      }
    );

    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Py Task",
        role: "bonesetter",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["app.py"],
        filesInScope: ["app.py"],
        acceptanceCommand: "pytest",
        accept: "pytest",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M1"],
        ruleIds: ["M1"],
        line: 1,
      },
    ];

    return {
      tmpDir,
      gitDir,
      baseSha,
      candidateSha,
      tree,
      runId,
      diff,
      tasks,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  it("accepts and merges Python-only candidate that reduces residue with single gate.result event", async () => {
    const repo = setupPyRepo("print x\n", "print(x)\n");
    try {
      const scheduler = new Scheduler(repo.tasks, { runId: repo.runId });
      scheduler.dispatchTask("T1");
      const eventStore = new EventStore();
      const candidateSha256 = candidateSha256FromDiff(repo.diff);

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId: repo.runId,
        diff: repo.diff,
        allowList: ["app.py"],
        candidateSha: repo.candidateSha,
        candidateSha256,
        tree: repo.tree,
        gitDir: repo.gitDir,
        expectedIntegrationHeadSha: repo.baseSha,
        currentHeadSha: repo.baseSha,
        eventStore,
        gitService: new GitService(),
        wardenReview: async () => ({
          verdict: "approve",
          candidateSha: repo.candidateSha,
          candidateSha256,
          tree: repo.tree,
          reasons: [{ text: "ok", refs: ["cmd:test"] }],
          checks: {
            install: { ok: true },
            build: { ok: true },
            accept: { ok: true },
            tests: { ok: true },
            noTestWeakening: { ok: true },
          },
        }),
      });

      assert.equal(res.ok, true);
      assert.equal(res.merged, true);
      const gateEvents = eventStore.getEvents(repo.runId, { kind: "gate.result" });
      assert.equal(gateEvents.length, 1);
      assert.equal(gateEvents[0].data?.ok, true);
    } finally {
      repo.cleanup();
    }
  });

  it("rejects Python candidate that introduces residue or syntax errors before Warden", async () => {
    const repo = setupPyRepo("print(x)\n", "print(x)\nprint y\n");
    try {
      const scheduler = new Scheduler(repo.tasks, { runId: repo.runId });
      scheduler.dispatchTask("T1");
      const eventStore = new EventStore();
      const candidateSha256 = candidateSha256FromDiff(repo.diff);
      let wardenCalled = false;

      const res = await onSubmit({
        scheduler,
        taskId: "T1",
        runId: repo.runId,
        diff: repo.diff,
        allowList: ["app.py"],
        candidateSha: repo.candidateSha,
        candidateSha256,
        tree: repo.tree,
        gitDir: repo.gitDir,
        expectedIntegrationHeadSha: repo.baseSha,
        currentHeadSha: repo.baseSha,
        eventStore,
        gitService: new GitService(),
        wardenReview: async () => {
          wardenCalled = true;
          return { verdict: "approve" };
        },
      });

      assert.equal(res.ok, false);
      assert.equal(res.merged, false);
      assert.equal(res.state, "rejected");
      assert.equal(wardenCalled, false);
      assert.ok(res.reasons.some((r) => r.includes("gate_residue_not_reduced")));
      const gateEvents = eventStore.getEvents(repo.runId, { kind: "gate.result" });
      assert.equal(gateEvents.length, 1);
      assert.equal(gateEvents[0].data?.ok, false);
    } finally {
      repo.cleanup();
    }
  });
});

