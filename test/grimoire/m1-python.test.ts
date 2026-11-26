import test, { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePython,
  applyM1,
  byteOffsetToUtf16,
  checkDeclaredPythonVersion,
  classifyVersionSpecifier,
  collectResidue,
  initPythonParser,
  isPy2OnlySpecifier,
  parsePython,
  planPythonEdits,
  resolveEditConflicts,
  type PythonPlannedEdit,
  type PythonSplice,
} from "../../lib/rules/m1-python";
import {
  detectPythonSignals,
  detectPythonSignalsLexical,
  detectSignals,
} from "../../lib/grimoire/signals";

before(async () => {
  await initPythonParser();
});

function makeEdit(
  splices: PythonSplice[],
  ruleOrder = 1,
  line = 1
): PythonPlannedEdit {
  const primary = splices[0];
  return {
    ruleId: "M1",
    ruleOrder,
    line,
    confidence: "high",
    description: "test edit",
    start: primary.start,
    end: primary.end,
    replacement: primary.replacement,
    splices,
  };
}

function unknownReasons(source: string, file = "a.py"): string[] {
  return analyzePython(source, file).unknowns.map((u) => u.reason);
}

describe("M1 rewrite rows (Requirement 6.4-6.12, R3-8.1)", () => {
  it("row 1: rewrites `print x, y` to a print() call", () => {
    assert.equal(applyM1("print x, y\n"), "print(x, y)\n");
  });

  it("row 2: rewrites `print x,` with end=\" \" and a softspace behavior note", () => {
    const res = analyzePython("print x,\n", "a.py");
    assert.equal(res.output, 'print(x, end=" ")\n');
    assert.equal(res.edits[0].confidence, "medium");
    assert.ok(
      res.behaviorNotes.some(
        (n) => n.note === "Py2 softspace output is not identical"
      )
    );
  });

  it("row 3: rewrites `print >>f, x` and keeps the chevron target", () => {
    assert.equal(applyM1("print >>f, x\n"), "print(x, file=f)\n");
    assert.equal(applyM1("print >>sys.stderr, x\n"), "print(x, file=sys.stderr)\n");
  });

  it("row 3: rewrites `print >>f, x,` with end and file", () => {
    const res = analyzePython("print >>f, x,\n", "a.py");
    assert.equal(res.output, 'print(x, end=" ", file=f)\n');
    assert.equal(res.edits[0].confidence, "medium");
  });

  it("row 4: rewrites a bare `print` to `print()`", () => {
    assert.equal(applyM1("print\n"), "print()\n");
  });

  it("row 5: leaves a two-argument `print(a, b)` call unchanged with a behavior note", () => {
    const res = analyzePython("print(a, b)\n", "a.py");
    assert.equal(res.output, "print(a, b)\n");
    assert.equal(res.edits.length, 0);
    assert.ok(res.behaviorNotes.some((n) => n.note === "Py2 prints a tuple"));
  });

  it("row 5: does not add the tuple note when print_function is imported", () => {
    const res = analyzePython(
      "from __future__ import print_function\nprint(a, b)\n",
      "a.py"
    );
    assert.equal(res.output, "from __future__ import print_function\nprint(a, b)\n");
    assert.equal(res.behaviorNotes.length, 0);
  });

  it("row 5: leaves a single-argument `print(x)` call unchanged", () => {
    const res = analyzePython("print(x)\n", "a.py");
    assert.equal(res.output, "print(x)\n");
    assert.equal(res.edits.length, 0);
    assert.equal(res.behaviorNotes.length, 0);
  });

  it("row 6: rewrites `except E, e:` to `except E as e:`", () => {
    const res = analyzePython(
      "try:\n    pass\nexcept E, e:\n    pass\n",
      "a.py"
    );
    assert.equal(
      res.output,
      "try:\n    pass\nexcept E as e:\n    pass\n"
    );
    assert.equal(res.edits[0].confidence, "high");
  });

  it("row 6: does not rewrite the Python 3 `except (E, e):` tuple form", () => {
    const src = "try:\n    pass\nexcept (E, e):\n    pass\n";
    assert.equal(applyM1(src), src);
  });

  it("row 7: rewrites `unicode(...)` to `str(...)` with bytes-vs-text review note", () => {
    const res = analyzePython("x = unicode(y)\n", "a.py");
    assert.equal(res.output, "x = str(y)\n");
    assert.equal(res.edits[0].confidence, "medium");
    const expectedNote =
      "Py2 bytes vs text unknown: verify argument is not a Py2 byte string decoded via unicode()";
    assert.equal(res.edits[0].note, expectedNote);
    assert.ok(res.behaviorNotes.some((n) => n.note === expectedNote));
  });

  it("row 7: does not rewrite multi-arg unicode(b, encoding) and records unicode_decoding_ambiguous", () => {
    const src = 'x = unicode(b, "utf-8")\n';
    const res = analyzePython(src, "a.py");
    assert.equal(res.output, src);
    assert.equal(res.edits.length, 0);
    assert.ok(
      res.unknowns.some((u) => u.reason === "unicode_decoding_ambiguous" && u.line === 1)
    );
  });

  it("row 8: rewrites iteritems/iterkeys/itervalues", () => {
    assert.equal(applyM1("a = d.iteritems()\n"), "a = d.items()\n");
    assert.equal(applyM1("a = d.iterkeys()\n"), "a = d.keys()\n");
    assert.equal(applyM1("a = d.itervalues()\n"), "a = d.values()\n");
  });
});

describe("M1 multi-line, nested and residue handling", () => {
  it("handles multi-line print statements through node ranges (R3-8.1)", () => {
    assert.equal(
      applyM1("print x, \\\n    y\n"),
      "print(x, \\\n    y)\n"
    );
  });

  it("applies nested edits to `print unicode(x)` (both splices)", () => {
    assert.equal(applyM1("print unicode(x)\n"), "print(str(x))\n");
    assert.equal(
      applyM1("print unicode(d.iteritems())\n"),
      "print(str(d.items()))\n"
    );
    assert.equal(
      applyM1("print >>f, unicode(d.itervalues())\n"),
      "print(str(d.values()), file=f)\n"
    );
  });

  it("leaves a chevron print without arguments unchanged", () => {
    assert.equal(applyM1("print >>f\n"), "print >>f\n");
  });

  it("records unicode_rebound for an assignment and leaves code unchanged", () => {
    const src = "unicode = str\nx = unicode(y)\n";
    const res = analyzePython(src, "a.py");
    assert.equal(res.output, src);
    assert.ok(res.unknowns.some((u) => u.reason === "unicode_rebound"));
  });

  it("records unicode_rebound for `def unicode` and an import", () => {
    assert.ok(
      unknownReasons("def unicode(x):\n    return x\ny = unicode(1)\n").includes(
        "unicode_rebound"
      )
    );
    assert.ok(
      unknownReasons("import unicode\nx = unicode(y)\n").includes(
        "unicode_rebound"
      )
    );
  });

  it("records unicode_rebound for parameter, lambda, for/with/global bindings of unicode", () => {
    const paramSrc = "def f(unicode):\n    return unicode(x)\n";
    const paramRes = analyzePython(paramSrc, "a.py");
    assert.equal(paramRes.output, paramSrc);
    assert.ok(paramRes.unknowns.some((u) => u.reason === "unicode_rebound"));

    const lambdaSrc = "fn = lambda unicode: unicode(x)\n";
    assert.equal(analyzePython(lambdaSrc, "a.py").output, lambdaSrc);
    assert.ok(unknownReasons(lambdaSrc).includes("unicode_rebound"));

    const forSrc = "for unicode in items:\n    z = unicode(1)\n";
    assert.equal(analyzePython(forSrc, "a.py").output, forSrc);
    assert.ok(unknownReasons(forSrc).includes("unicode_rebound"));

    const withSrc = "with ctx() as unicode:\n    z = unicode(1)\n";
    assert.equal(analyzePython(withSrc, "a.py").output, withSrc);
    assert.ok(unknownReasons(withSrc).includes("unicode_rebound"));

    const globalSrc = "def g():\n    global unicode\n    return unicode(1)\n";
    assert.equal(analyzePython(globalSrc, "a.py").output, globalSrc);
    assert.ok(unknownReasons(globalSrc).includes("unicode_rebound"));
  });

  it("records unicode_rebound for the attribute form obj.unicode(...)", () => {
    const src = "x = obj.unicode(y)\n";
    const res = analyzePython(src, "a.py");
    assert.equal(res.output, src);
    assert.ok(res.unknowns.some((u) => u.reason === "unicode_rebound"));
  });

  it("records iterator_use for next(d.iteritems())", () => {
    const src = "x = next(d.iteritems())\n";
    const res = analyzePython(src, "a.py");
    assert.equal(res.output, src);
    assert.ok(res.unknowns.some((u) => u.reason === "iterator_use"));
  });

  it("records iterator_use for d.iterkeys().next()", () => {
    const src = "x = d.iterkeys().next()\n";
    const res = analyzePython(src, "a.py");
    assert.equal(res.output, src);
    assert.ok(res.unknowns.some((u) => u.reason === "iterator_use"));
  });

  it("preserves a UTF-8 BOM and CRLF line endings (Requirement 6.17)", () => {
    const src = "\uFEFFprint x\r\nprint y\r\n";
    const out = applyM1(src);
    assert.equal(out, "\uFEFFprint(x)\r\nprint(y)\r\n");
    assert.equal(out.charCodeAt(0), 0xfeff);
    assert.ok(out.includes("\r\n"));
  });

  it("makes no edit for invalid UTF-8 bytes (Requirement 6.18)", () => {
    const res = analyzePython("print x\n", "a.py", {
      rawBytes: Uint8Array.from([0x70, 0x72, 0xff, 0xfe]),
    });
    assert.equal(res.output, "print x\n");
    assert.equal(res.edits.length, 0);
    assert.ok(res.unknowns.some((u) => u.reason === "encoding_unsupported"));
  });

  it("makes no edit for a lone surrogate (Requirement 6.18)", () => {
    const src = "print x\n\uD800";
    const res = analyzePython(src, "a.py");
    assert.equal(res.output, src);
    assert.ok(res.unknowns.some((u) => u.reason === "encoding_unsupported"));
  });

  it("makes no edit when a non-UTF-8 coding cookie accompanies broken bytes", () => {
    const src = "# -*- coding: latin-1 -*-\nprint x \uFFFD\n";
    const res = analyzePython(src, "a.py");
    assert.equal(res.output, src);
    assert.equal(res.edits.length, 0);
    assert.ok(res.unknowns.some((u) => u.reason === "encoding_unsupported"));
  });
});

describe("Declared Python version (Requirement 6.19)", () => {
  it("flags Python-2-only requires-python specs including !=3.* exclusions", () => {
    assert.ok(isPy2OnlySpecifier("==2.*"));
    assert.ok(isPy2OnlySpecifier("<3"));
    assert.ok(isPy2OnlySpecifier("<=2.7"));
    assert.ok(isPy2OnlySpecifier(">=2.7,<3"));
    assert.ok(isPy2OnlySpecifier(">=2.7,!=3.*,<4"));
    assert.ok(!isPy2OnlySpecifier(">=2.7,!=3.13.*"));
    assert.ok(!isPy2OnlySpecifier(">=3.8"));
    assert.ok(!isPy2OnlySpecifier(">=2.7,<4"));
    assert.ok(!isPy2OnlySpecifier(">=3"));
  });

  it("ignores commented requires-python/python_requires lines and reads active declarations", () => {
    const pyproject = checkDeclaredPythonVersion([
      {
        path: "pyproject.toml",
        content: [
          "[project]",
          '# requires-python = "<3"',
          'description = "requires-python = \'<3\'"',
          'requires-python = ">=3.8" # previously <3',
          "",
        ].join("\n"),
      },
    ]);
    assert.equal(pyproject.py2Only, false);
    assert.equal(pyproject.declared, ">=3.8");

    const setupPy = checkDeclaredPythonVersion([
      {
        path: "setup.py",
        content: [
          "setup(",
          "    # python_requires='<3',",
          "    python_requires='>=3.8',",
          ")",
          "",
        ].join("\n"),
      },
    ]);
    assert.equal(setupPy.py2Only, false);
    assert.equal(setupPy.declared, ">=3.8");
  });

  it("reads requires-python from pyproject.toml and python_requires from setup.py", () => {
    const pyproject = checkDeclaredPythonVersion([
      { path: "pyproject.toml", content: '[project]\nrequires-python = "==2.*"\n' },
    ]);
    assert.equal(pyproject.py2Only, true);
    assert.equal(pyproject.declared, "==2.*");

    const setup = checkDeclaredPythonVersion([
      { path: "setup.py", content: "setup(python_requires='<=2.7')\n" },
    ]);
    assert.equal(setup.py2Only, true);

    const ok = checkDeclaredPythonVersion([
      { path: "pyproject.toml", content: '[project]\nrequires-python = ">=3.9"\n' },
    ]);
    assert.equal(ok.py2Only, false);
  });

  it("halts M1 edits when the repo declares Python 2 only", () => {
    const src = "print x\n";
    const res = analyzePython(src, "a.py", { py2Only: true });
    assert.equal(res.output, src);
    assert.equal(res.edits.length, 0);
    assert.ok(res.unknowns.some((u) => u.reason === "py2_only_declared"));
  });
});


describe("Python 2 residue (Requirement 6.14, R3-9)", () => {
  const unhandledSrc = [
    "exec code in ns",
    "if a <> b:",
    "    pass",
    "x = `a`",
    "y = ur'z'",
    "o = 0777",
    "l = 10L",
    "def f((a, b)):",
    "    pass",
    "raise E, msg",
    "",
  ].join("\n");

  it("counts all unhandled residue kinds and records py2_residue", () => {
    const tree = parsePython(unhandledSrc);
    assert.ok(tree);
    const kinds = collectResidue(tree!).map((item) => item.kind);
    for (const kind of [
      "exec_statement",
      "not_equal",
      "backtick_string",
      "ur_prefix",
      "octal",
      "long",
      "tuple_param",
      "raise_statement",
    ]) {
      assert.ok(kinds.includes(kind), `expected residue kind ${kind}`);
    }
    const res = analyzePython(unhandledSrc, "r.py");
    const py2res = res.unknowns.filter((u) => u.reason === "py2_residue");
    assert.equal(py2res.length, 8);
    assert.ok(
      py2res.every((u) => u.ruleId === "M1" && typeof u.line === "number")
    );
  });

  it("counts handled residue kinds (print, chevron, bare print, except, unicode, iterator)", () => {
    const src = [
      "print z",
      "print >>g, q",
      "print",
      "try:",
      "    pass",
      "except E, e:",
      "    pass",
      "u = unicode(w)",
      "it = d.iteritems()",
      "",
    ].join("\n");
    const tree = parsePython(src)!;
    const kinds = collectResidue(tree).map((item) => item.kind);
    assert.ok(kinds.includes("print_statement"));
    assert.ok(kinds.includes("chevron"));
    assert.ok(kinds.includes("bare_print"));
    assert.ok(kinds.includes("except_clause"));
    assert.ok(kinds.includes("unicode_call"));
    assert.ok(kinds.includes("iterator_call"));
    const res = analyzePython(src, "r.py");
    assert.equal(res.unknowns.filter((u) => u.reason === "py2_residue").length, 0);
  });

  it("does not treat 0, 0x10, 0b1, 0o7 as residue", () => {
    const tree = parsePython("a = 0\nb = 0x10\nc = 0b1\nd = 0o7\n")!;
    assert.equal(collectResidue(tree).length, 0);
  });
});

describe("Edit conflicts (Requirement 6.16)", () => {
  it("skips the later overlapping edit and records edit_conflict", () => {
    const first = makeEdit([{ start: 0, end: 5, replacement: "aaaaa" }], 1, 1);
    const second = makeEdit([{ start: 3, end: 8, replacement: "bbbbb" }], 2, 1);
    const resolution = resolveEditConflicts([first, second], "a.py");
    assert.equal(resolution.edits.length, 1);
    assert.equal(resolution.conflicts.length, 1);
    assert.equal(resolution.conflicts[0], second);
    assert.ok(resolution.unknowns.some((u) => u.reason === "edit_conflict"));
  });

  it("keeps non-overlapping edits and maps offsets through applied splices", () => {
    const head = makeEdit([{ start: 5, end: 6, replacement: "(" }], 1, 1);
    const tail = makeEdit([{ start: 16, end: 16, replacement: ")" }], 1, 1);
    const inner = makeEdit([{ start: 6, end: 13, replacement: "str" }], 7, 1);
    const resolution = resolveEditConflicts([head, tail, inner], "a.py");
    assert.equal(resolution.conflicts.length, 0);
    assert.equal(resolution.edits.length, 3);
    assert.equal(applyM1("print unicode(x)\n"), "print(str(x))\n");
  });
});

describe("M1 idempotence (Requirement 6.15)", () => {
  const sources = [
    "print x, y\n",
    "print x,\n",
    "print >>f, unicode(d.iteritems())\n",
    "print\n",
    "try:\n    pass\nexcept E, e:\n    pass\n",
    "u = unicode(v)\nit = d.iterkeys()\n",
    "\uFEFFprint a\r\n",
    "exec code in ns\n",
    "print(a, b)\n",
  ];
  for (const src of sources) {
    it(`applyM1(applyM1(f)) === applyM1(f) for ${JSON.stringify(src)}`, () => {
      const once = applyM1(src);
      assert.equal(applyM1(once), once);
    });
  }
});


describe("PatchStep and labels (Requirement 6.1, 9.3)", () => {
  it("emits a PatchStep with ruleId M1, a unified diff, and m1-clean label", () => {
    const res = analyzePython("print x\n", "tools/a.py");
    assert.equal(res.step.ruleId, "M1");
    assert.equal(res.step.file, "tools/a.py");
    assert.equal(res.step.reverted, false);
    assert.ok(typeof res.step.diff === "string");
    assert.ok(res.step.diff!.includes("-print x"));
    assert.ok(res.step.diff!.includes("+print(x)"));
    assert.equal(res.label, "m1-clean");
    assert.equal(res.residueAfter, 0);
  });

  it("labels a file with remaining residue m1-partial", () => {
    const res = analyzePython("exec code in ns\n", "b.py");
    assert.equal(res.label, "m1-partial");
    assert.equal(res.residueBefore, 1);
    assert.equal(res.residueAfter, 1);
  });

  it("returns the plan with rule M1 citations", () => {
    const plan = planPythonEdits("print x\n", "a.py");
    assert.ok(plan);
    assert.ok(plan!.edits.every((edit) => edit.ruleId === "M1"));
  });
});

describe("Python M1 signal detection", () => {
  it("detects .py files in synchronous detectSignals", () => {
    const signals = detectSignals([
      { path: "p.py", content: "# print z\nprint x\ns = 'print y'\n" },
    ]);
    assert.ok(signals.some((s) => s.ruleId === "M1" && s.line === 2));
    assert.equal(signals.filter((s) => s.line === 1 || s.line === 3).length, 0);
  });

  it("detectPythonSignals suppresses comments and strings", async () => {
    const result = await detectPythonSignals([
      {
        path: "p.py",
        content: 'print x\ns = "unicode(z)"\n# print z\nu = unicode(w)\n',
      },
    ]);
    assert.ok(result.some((s) => s.ruleId === "M1" && s.line === 1));
    assert.ok(result.some((s) => s.ruleId === "M1" && s.line === 4));
    assert.equal(result.filter((s) => s.line === 2 || s.line === 3).length, 0);
  });

  it("lexical fallback detects M1 patterns outside comments and strings", () => {
    const content = [
      "print x",
      's = "print y"',
      "# print z",
      "if a <> b:",
      "    pass",
      "e = d.iteritems()",
      "u = unicode(v)",
      "",
    ].join("\n");
    const result = detectPythonSignalsLexical([{ path: "p.py", content }]);
    const lines = result.map((s) => s.line).sort((a, b) => a - b);
    assert.ok(lines.includes(1));
    assert.ok(lines.includes(4));
    assert.ok(lines.includes(6));
    assert.ok(lines.includes(7));
    assert.ok(!lines.includes(2));
    assert.ok(!lines.includes(3));
    assert.ok(result.every((s) => s.ruleId === "M1"));
  });

  it("lexical fallback preserves string state across backslash-newline continuations and skips Py3 exec (code)", () => {
    const lfString = 's = "hello \\\nd.iteritems()"\n';
    const crlfString = 's = "hello \\\r\nd.iteritems()"\r\n';
    assert.equal(detectPythonSignalsLexical([{ path: "lf.py", content: lfString }]).length, 0);
    assert.equal(detectPythonSignalsLexical([{ path: "crlf.py", content: crlfString }]).length, 0);

    const py3Exec = 'exec (code)\nexec  (code)\nexec\t (code)\nexec(code)\n';
    assert.equal(detectPythonSignalsLexical([{ path: "exec3.py", content: py3Exec }]).length, 0);
  });

  // The sync `detectSignals` uses the tree-sitter path once the parser is
  // initialized; temporarily clear the registered sync parser so these cases
  // exercise the comment/string-aware lexical fallback (where the `exec` regex
  // lives) rather than the parser, which would mask a regex regression.
  function withLexicalFallback<T>(fn: () => T): T {
    const g = globalThis as Record<string, unknown>;
    const key = "__ggPythonParseSync";
    const saved = g[key];
    delete g[key];
    try {
      return fn();
    } finally {
      if (saved !== undefined) g[key] = saved;
    }
  }

  it("synchronous detectSignals lexical fallback ignores Py3 exec calls separated by wide whitespace", () => {
    const py3 = ["exec (code)", "exec  (code)", "exec\t (code)", "exec(code)"].join("\n") + "\n";
    const result = withLexicalFallback(() =>
      detectSignals([{ path: "exec3.py", content: py3 }])
    );
    const execSignals = result.filter((s) => s.matched.includes("exec"));
    assert.equal(execSignals.length, 0, "Py3 exec call forms must not be flagged");
    assert.equal(result.length, 0);
  });

  it("synchronous detectSignals lexical fallback flags Py2 exec statement forms as unhandled", () => {
    const py2 = ['exec "x = 1"', "exec stmt in ns"].join("\n") + "\n";
    const result = withLexicalFallback(() =>
      detectSignals([{ path: "exec2.py", content: py2 }])
    );
    const execSignals = result.filter((s) => s.matched.includes("exec"));
    assert.equal(execSignals.length, 2, "both Py2 exec statement forms must be flagged");
    assert.deepEqual(
      execSignals.map((s) => s.line),
      [1, 2]
    );
    const py2Unknowns = result.unknowns.filter((u) => u.reason === "py2_residue");
    assert.equal(py2Unknowns.length, 2);
    assert.ok(py2Unknowns.every((u) => u.ruleId === "M1"));
  });

  it("lexical fallback detects ur/ru strings, old octals, long ints, tuple params, raise E, msg, and emits unknowns", () => {
    const content = [
      'a = ur"raw"',
      "b = 0777",
      "c = 10L",
      'raise ValueError, "bad"',
      "def f((a, b)):",
      "    pass",
      'u = unicode(raw_bytes, "utf-8")',
      "x = 1.07",
      "def g(p=(1, 2)):",
      '    raise ValueError("a", "b")',
      "",
    ].join("\n");
    const result = detectPythonSignalsLexical([{ path: "legacy.py", content }]);
    const lines = result.map((s) => s.line);
    assert.ok(lines.includes(1), "expected ur string signal on line 1");
    assert.ok(lines.includes(2), "expected octal signal on line 2");
    assert.ok(lines.includes(3), "expected long literal signal on line 3");
    assert.ok(lines.includes(4), "expected raise E, msg signal on line 4");
    assert.ok(lines.includes(5), "expected tuple param signal on line 5");
    assert.ok(lines.includes(7), "expected unicode call signal on line 7");
    assert.ok(!lines.includes(8), "must not flag float 1.07");
    assert.ok(!lines.includes(9), "must not flag default tuple value p=(1, 2)");
    assert.ok(!lines.includes(10), "must not flag Py3 raise ValueError(\"a\", \"b\")");

    const py2Unknowns = result.unknowns.filter((u) => u.reason === "py2_residue");
    assert.equal(py2Unknowns.length, 5);
    assert.ok(
      result.unknowns.some(
        (u) => u.reason === "unicode_decoding_ambiguous" && u.line === 7
      )
    );
  });
});


describe("Wave-19A remediation regressions", () => {
  // Finding 3 / [3]: web-tree-sitter reports UTF-16 code-unit offsets for the
  // installed binding (verified against node.startIndex/node.endIndex), so JS
  // String.slice is already correct for multi-byte source. These tests lock in
  // that behavior and the byte-offset -> UTF-16 helper used defensively.
  const cjkEmoji = "# \u4e2d\u6587\u6ce8\u91ca \ud83d\udc0d\n";

  it("rewrites a statement preceded by multi-byte UTF-8 text at the correct range", () => {
    const src = cjkEmoji + 'print "hi"\n';
    assert.equal(applyM1(src), cjkEmoji + 'print("hi")\n');
    const res = analyzePython(src, "unicode_before.py");
    assert.equal(res.edits.length, 1);
    assert.equal(res.residueAfter, 0);
  });

  it("keeps multi-byte characters that appear inside a rewritten statement intact", () => {
    assert.equal(
      applyM1('x = "\u4e2d\u6587"\nprint x\n'),
      'x = "\u4e2d\u6587"\nprint(x)\n'
    );
    assert.equal(applyM1('print "\ud83d\udc0d"\n'), 'print("\ud83d\udc0d")\n');
    const nested = analyzePython('print unicode("\u4e2d\u6587")\n', "unicode_inside.py");
    assert.equal(nested.output, 'print(str("\u4e2d\u6587"))\n');
  });

  it("byteOffsetToUtf16 maps UTF-8 byte offsets to UTF-16 code-unit indices", () => {
    const src = cjkEmoji + 'print "hi"\n';
    const map = byteOffsetToUtf16(src);
    assert.equal(map(0), 0);
    assert.equal(map(Buffer.byteLength(cjkEmoji, "utf8")), cjkEmoji.length);
    assert.equal(map(Buffer.byteLength(src, "utf8")), src.length);
    // A pure-ASCII source maps identically.
    const asciiMap = byteOffsetToUtf16('print "hi"\n');
    assert.equal(asciiMap(6), 6);
  });

  // Finding 14 / [14]: a leading-zero float is not a Py2 octal.
  it("does not classify Python 3 floats such as 00.5 / .005 as Py2 octals", () => {
    const content = [
      "a = 00.5",
      "b = .005",
      "c = 0755",
      "d = 0644",
      "e = 007",
      "f = 1.07",
      "",
    ].join("\n");
    const result = detectPythonSignalsLexical([{ path: "octal.py", content }]);
    const lines = result.map((s) => s.line);
    assert.ok(!lines.includes(1), "00.5 must not be flagged as an octal");
    assert.ok(!lines.includes(2), ".005 must not be flagged as an octal");
    assert.ok(lines.includes(3), "0755 is a Py2 octal");
    assert.ok(lines.includes(4), "0644 is a Py2 octal");
    assert.ok(lines.includes(5), "007 is a Py2 octal");
    assert.ok(!lines.includes(6), "1.07 must not be flagged as an octal");
  });

  // Finding 19 / [19]: `except E as (a, b):` is a Python 3 SyntaxError.
  it("leaves tuple/attribute/subscript except targets unrewritten as Py2 residue", () => {
    const tupleSrc = "try:\n    pass\nexcept E, (a, b):\n    pass\n";
    const res = analyzePython(tupleSrc, "a.py");
    assert.equal(res.output, tupleSrc);
    assert.equal(res.edits.length, 0);
    assert.ok(res.unknowns.some((u) => u.reason === "py2_residue"));
    const tree = parsePython(tupleSrc)!;
    try {
      const kinds = collectResidue(tree).map((item) => item.kind);
      assert.ok(kinds.includes("except_target_unsupported"));
    } finally {
      tree.delete?.();
    }

    for (const target of ["obj.attr", "d[k]"]) {
      const src = `try:\n    pass\nexcept E, ${target}:\n    pass\n`;
      assert.equal(applyM1(src), src);
    }

    // The identifier form still rewrites.
    assert.equal(
      applyM1("try:\n    pass\nexcept E, e:\n    pass\n"),
      "try:\n    pass\nexcept E as e:\n    pass\n"
    );
  });

  // Finding 20 / [20]: `str(encoding=...)` is a Python 3 TypeError.
  it("does not rewrite unicode(...) when a keyword argument is present", () => {
    for (const src of [
      'x = unicode(encoding="utf-8")\n',
      'x = unicode(y, errors="strict")\n',
    ]) {
      const res = analyzePython(src, "a.py");
      assert.equal(res.output, src);
      assert.equal(res.edits.length, 0);
      assert.ok(
        res.unknowns.some((u) => u.reason === "unicode_decoding_ambiguous")
      );
    }
  });

  // CodeRabbit / [7]: PEP 440 pre/post/dev specifiers.
  it("classifies PEP 440 pre/post/dev specifiers as Python 3 compatible", () => {
    for (const spec of [
      ">=3.13.0rc1",
      "==3.12.0a1",
      ">=3.11.0b2",
      "~=3.11.0",
      ">=3.10.0.post1",
      ">=3.11.0.dev1",
    ]) {
      assert.equal(classifyVersionSpecifier(spec), "py3_compatible", spec);
      assert.equal(isPy2OnlySpecifier(spec), false, spec);
    }
  });

  it("keeps pre-release Python 2 pins py2-only and clearly flags unparseable specifiers", () => {
    assert.ok(isPy2OnlySpecifier(">=2.7.0rc1, <3"));
    assert.equal(classifyVersionSpecifier(">=2.7.0rc1, <3"), "py2_only");
    assert.equal(classifyVersionSpecifier("not-a-version"), "unknown");
    // Unparseable specs stay conservative (halt M1) but are distinguishable.
    assert.equal(isPy2OnlySpecifier("not-a-version"), true);

    const py3 = checkDeclaredPythonVersion([
      {
        path: "pyproject.toml",
        content: '[project]\nrequires-python = ">=3.13.0rc1"\n',
      },
    ]);
    assert.equal(py3.py2Only, false);
    assert.equal(py3.declaredStatus, "py3_compatible");
    assert.equal(py3.reason, "py3_compatible_declared");

    const malformed = checkDeclaredPythonVersion([
      {
        path: "pyproject.toml",
        content: '[project]\nrequires-python = "not-a-version"\n',
      },
    ]);
    assert.equal(malformed.py2Only, true);
    assert.equal(malformed.declaredStatus, "unknown");
    assert.equal(malformed.reason, "version_specifier_unparseable");

    const py2 = checkDeclaredPythonVersion([
      { path: "setup.py", content: "setup(python_requires='>=2.7, <3')\n" },
    ]);
    assert.equal(py2.py2Only, true);
    assert.equal(py2.declaredStatus, "py2_only");
    assert.equal(py2.reason, "py2_only_declared");
  });
});

