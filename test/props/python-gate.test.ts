// Task 19.9: Property test for the monotone Python gate (Property 8: P8).
// Validates: Requirements 9.1, 9.3 (design R3-9, R3-18 P8).
import test, { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  applyEditsToOriginal,
  countPythonResidue,
  initPythonParser,
  parsePython,
  planPythonEdits,
  type PythonPlannedEdit,
} from "../../lib/rules/m1-python";
import { errorCount, gatePython, gatePythonSync } from "../../lib/grimoire/python-gate";

before(async () => {
  await initPythonParser();
});

const pythonBlockArb = fc.constantFrom<readonly string[]>(
  ['print "x"'],
  ["print x,"],
  ["print >>f, x"],
  ["print"],
  ["print(a, b)"],
  ["y = unicode(z)"],
  ["dd = items.iteritems()"],
  ["kk = items.iterkeys()"],
  ["vv = items.itervalues()"],
  ["w = `x`"],
  ["n = 0755"],
  ["m = 1L"],
  ["c = a <> b"],
  ["y = 1"],
  ["v = x + 1"],
  ["try:", "    x = 1", "except E, e:", "    pass"],
  ["print unicode(z)"],
  ["print >>f, unicode(z),"]
);

const pythonSourceArb = fc
  .array(pythonBlockArb, { minLength: 1, maxLength: 8 })
  .map((blocks) => {
    const header = [
      "import sys",
      "f = sys.stderr",
      "x = 1",
      "a = 1",
      "b = 2",
      "z = 'z'",
      "items = {}",
    ];
    return `${[...header, ...blocks.flat()].join("\n")}\n`;
  });

function measure(source: string): { errors: number; residue: number } {
  const tree = parsePython(source);
  assert.ok(tree, "the source under test must parse");
  try {
    return { errors: errorCount(tree), residue: countPythonResidue(tree) };
  } finally {
    tree.delete?.();
  }
}

function replayAccepted(
  source: string,
  accepted: PythonPlannedEdit[]
): Array<{ errors: number; residue: number }> {
  const seq: Array<{ errors: number; residue: number }> = [];
  const accumulated: PythonPlannedEdit[] = [];
  for (const edit of accepted) {
    accumulated.push(edit);
    const text = applyEditsToOriginal(source, accumulated);
    const tree = parsePython(text);
    assert.ok(tree, "every accepted edit must keep the file parseable");
    try {
      seq.push({ errors: errorCount(tree), residue: countPythonResidue(tree) });
    } finally {
      tree.delete?.();
    }
  }
  return seq;
}

describe("Property 8: monotone Python gate (Requirements 9.1, 9.3)", () => {
  it("never raises the parse-error count and strictly lowers residue for accepted edits", () => {
    fc.assert(
      fc.property(pythonSourceArb, (source) => {
        const plan = planPythonEdits(source, "fixture.py");
        assert.ok(plan, "generated sources must parse");
        const result = gatePythonSync(source, plan.edits, { file: "fixture.py" });

        assert.ok(
          result.errorsAfter <= result.errorsBefore,
          `errors rose from ${result.errorsBefore} to ${result.errorsAfter}`
        );
        if (result.accepted.length > 0) {
          assert.ok(
            result.residueAfter < result.residueBefore,
            `residue must strictly fall: ${result.residueBefore} -> ${result.residueAfter}`
          );
        }
        assert.equal(
          result.label,
          result.residueAfter === 0 ? "m1-clean" : "m1-partial"
        );
        for (const rejected of result.rejected) {
          assert.ok(
            ["parse_timeout", "gate_errors_rose", "gate_residue_not_reduced"].includes(
              rejected.reason
            )
          );
        }
      }),
      { numRuns: 150 }
    );
  });

  it("strictly lowers residue and never raises errors at every accepted edit", () => {
    fc.assert(
      fc.property(pythonSourceArb, (source) => {
        const plan = planPythonEdits(source, "fixture.py");
        assert.ok(plan, "generated sources must parse");
        const result = gatePythonSync(source, plan.edits, { file: "fixture.py" });

        let prev = measure(source);
        for (const step of replayAccepted(source, result.accepted)) {
          assert.ok(
            step.errors <= prev.errors,
            `errors rose across an accepted edit: ${prev.errors} -> ${step.errors}`
          );
          assert.ok(
            step.residue < prev.residue,
            `residue did not strictly fall: ${prev.residue} -> ${step.residue}`
          );
          prev = step;
        }
        assert.equal(result.residueAfter, prev.residue);
        assert.equal(result.errorsAfter, prev.errors);
      }),
      { numRuns: 120 }
    );
  });

  it("holds P8 for every Python file of the pinned F-python2 fixture", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const repos = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "test", "fixtures", "pinned", "repos.json"), "utf8")
    ) as Array<{ repo: string; path: string }>;
    const entry = repos.find((item) => item.repo === "F-python2");
    assert.ok(entry, "F-python2 must be pinned");
    const fixtureDir = path.join(repoRoot, "test", "fixtures", "pinned", entry!.path);

    const pythonFiles: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
        const relPath = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) walk(path.join(dir, it.name), relPath);
        else if (it.name.endsWith(".py")) pythonFiles.push(relPath);
      }
    };
    walk(fixtureDir, "");
    assert.ok(pythonFiles.length > 0);

    let cleanSeen = 0;
    for (const rel of pythonFiles) {
      const source = fs.readFileSync(path.join(fixtureDir, rel), "utf8");
      const plan = planPythonEdits(source, rel);
      assert.ok(plan, `${rel} must parse`);
      const result = await gatePython(source, plan.edits, { file: rel });
      assert.ok(result.errorsAfter <= result.errorsBefore, `${rel} errors rose`);
      if (result.accepted.length > 0) {
        assert.ok(result.residueAfter < result.residueBefore, `${rel} residue did not fall`);
      }
      assert.equal(result.label, result.residueAfter === 0 ? "m1-clean" : "m1-partial");
      if (result.label === "m1-clean") cleanSeen += 1;
    }
    assert.ok(cleanSeen > 0, "the fixture must contain at least one m1-clean file");
  });
});
