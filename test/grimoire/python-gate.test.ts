import test, { describe, it, before } from "node:test";
import assert from "node:assert/strict";
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
    assert.ok(result.unknowns.some((u) => u.reason === "gate_errors_rose"));
    assert.ok(result.unknowns.every((u) => typeof u.line === "number"));
  });

  it("rejects an edit that does not reduce residue (gate_residue_not_reduced)", async () => {
    const src = "print x\n";
    const noop = makeEdit(1, 0, 0, " ", 1);
    const result = await gatePython(src, [noop], { file: "a.py" });
    assert.equal(result.rejected[0].reason, "gate_residue_not_reduced");
    assert.equal(result.reverted, true);
    assert.equal(result.revertReason, "all_edits_rejected");
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
});

