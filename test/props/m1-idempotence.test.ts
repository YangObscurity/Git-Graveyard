// Task 19.5: Property test for M1 idempotence (Property 2: P2).
// Validates: Requirement 6.15 (design R3-18 P2).
import test, { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { applyM1, analyzePython, initPythonParser } from "../../lib/rules/m1-python";

before(async () => {
  await initPythonParser();
});

/**
 * Statement blocks drawn from the M1 rewrite rows (R3-8.1) and from the residue
 * list the Grimoire never rewrites. Blocks are whole line groups so `except`
 * clauses stay attached to their `try` suite.
 */
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
  ['q = ur"raw"'],
  ["exec \"x = 1\""],
  ["raise E, msg"],
  ["y = 1"],
  ["try:", "    x = 1", "except E, e:", "    pass"],
  ["try:", "    x = 1", "except (E, F) as e:", "    pass"]
);

const pythonSourceArb = fc
  .array(pythonBlockArb, { minLength: 0, maxLength: 8 })
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
    const body = blocks.flat();
    return `${[...header, ...body].join("\n")}\n`;
  });

describe("Property 2: M1 idempotence (Requirement 6.15)", () => {
  it("applyM1(applyM1(f)) === applyM1(f) for generated Python sources", () => {
    fc.assert(
      fc.property(pythonSourceArb, (source) => {
        const once = applyM1(source, "fixture.py");
        const twice = applyM1(once, "fixture.py");
        assert.equal(twice, once, `M1 is not idempotent for:\n${source}`);
        assert.equal(applyM1(twice, "fixture.py"), once);
      }),
      { numRuns: 150 }
    );
  });

  it("applyM1 is idempotent on every row of the R3-8.1 table", () => {
    const rows = [
      'print "x"\n',
      "print x,\n",
      "print >>f, x\n",
      "print >>f, x,\n",
      "print\n",
      "print(a, b)\n",
      "try:\n    pass\nexcept E, e:\n    pass\n",
      "y = unicode(z)\n",
      "dd = items.iteritems()\n",
      "kk = items.iterkeys()\n",
      "vv = items.itervalues()\n",
      "w = `x`\n",
      "n = 0755\n",
      "m = 1L\n",
      "c = a <> b\n",
    ];
    for (const source of rows) {
      const once = applyM1(source, "row.py");
      assert.equal(applyM1(once, "row.py"), once, `row not idempotent: ${JSON.stringify(source)}`);
    }
  });

  it("is idempotent on the outputs of the pinned F-python2 fixture", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../.."
    );
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

    for (const rel of pythonFiles) {
      const source = fs.readFileSync(path.join(fixtureDir, rel), "utf8");
      const once = analyzePython(source, rel).output;
      assert.equal(applyM1(once, rel), once, `${rel} output is not M1-idempotent`);
    }
  });
});
