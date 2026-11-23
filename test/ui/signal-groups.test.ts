import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  groupSignalsByFile,
  groupSignalsByRule,
  receiptCopyValue,
  receiptTarget,
} from "@/lib/ui/signal-groups";

const chip = (
  file: string | undefined,
  line: number | undefined,
  extra: Record<string, unknown> = {}
) => ({ ruleId: "M3", file, line, ...extra });

describe("receiptTarget / receiptCopyValue", () => {
  it("uses file:line when nothing else is recorded", () => {
    const c = chip("index.js", 3);
    assert.equal(receiptTarget(c), "index.js:3");
    assert.equal(receiptCopyValue(c), "index.js:3");
  });

  it("prefers the recorded target and clipboard payload", () => {
    const c = chip("index.js", 3, {
      target: "lib/index.js:3",
      clipboardPayload: "lib/index.js:3",
    });
    assert.equal(receiptTarget(c), "lib/index.js:3");
    assert.equal(receiptCopyValue(c), "lib/index.js:3");
  });

  it("falls back to target when there is no clipboard payload", () => {
    const c = chip("a.js", 9, { target: "a.js:9" });
    assert.equal(receiptCopyValue(c), "a.js:9");
  });

  it("matches the previous chip behaviour when file or line is missing", () => {
    assert.equal(receiptTarget(chip(undefined, 4)), ":4");
    assert.equal(receiptTarget(chip("a.js", undefined)), "a.js:0");
  });
});

describe("groupSignalsByFile", () => {
  it("returns an empty list for no signals", () => {
    assert.deepEqual(groupSignalsByFile([]), []);
  });

  it("groups by file, sorts files by path and lines ascending, and counts", () => {
    const input = [
      chip("test/util/index.js", 5),
      chip("index.js", 4),
      chip("index.js", 3),
      chip("README.md", 1),
      chip("test/util/index.js", 2),
    ];

    const groups = groupSignalsByFile(input);

    assert.deepEqual(
      groups.map((g) => [g.file, g.count]),
      [
        ["README.md", 1],
        ["index.js", 2],
        ["test/util/index.js", 2],
      ]
    );
    assert.deepEqual(
      groups[1].signals.map((s) => s.line),
      [3, 4]
    );
    assert.deepEqual(
      groups[2].signals.map((s) => s.line),
      [2, 5]
    );
  });

  it("orders files by code point, not by locale", () => {
    const groups = groupSignalsByFile([chip("b.js", 1), chip("B.js", 1), chip("a.js", 1)]);
    assert.deepEqual(
      groups.map((g) => g.file),
      ["B.js", "a.js", "b.js"]
    );
  });

  it("keeps every receipt, including duplicates of the same file:line", () => {
    const first = chip("index.js", 3, { matched: "first" });
    const second = chip("index.js", 3, { matched: "second" });
    const groups = groupSignalsByFile([first, second]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
    // Stable: equal lines keep their input order.
    assert.equal(groups[0].signals[0], first);
    assert.equal(groups[0].signals[1], second);
  });

  it("puts signals with no file in their own group, after named files", () => {
    const groups = groupSignalsByFile([
      chip(undefined, 2),
      chip("", 1),
      chip("z.js", 1),
    ]);

    assert.deepEqual(
      groups.map((g) => [g.file, g.hasFile, g.count]),
      [
        ["z.js", true, 1],
        ["", false, 2],
      ]
    );
    assert.deepEqual(
      groups[1].signals.map((s) => s.line),
      [1, 2]
    );
  });

  it("puts signals with no usable line after numbered lines", () => {
    const noLine = chip("a.js", undefined);
    const zeroLine = chip("a.js", 0);
    const groups = groupSignalsByFile([noLine, chip("a.js", 7), zeroLine, chip("a.js", 2)]);

    assert.deepEqual(
      groups[0].signals.map((s) => s.line),
      [2, 7, undefined, 0]
    );
    assert.equal(groups[0].count, 4);
  });

  it("does not mutate the input array or its items", () => {
    const input = Object.freeze([
      Object.freeze(chip("b.js", 2)),
      Object.freeze(chip("a.js", 1)),
    ]);
    const before = JSON.stringify(input);

    groupSignalsByFile(input);

    assert.equal(JSON.stringify(input), before);
  });
});

describe("groupSignalsByRule", () => {
  const RULES = ["M1", "M2", "M3", "M4", "M5", "M6"] as const;

  it("returns one entry per rule in the given order, with zero counts for empty rules", () => {
    const groups = groupSignalsByRule(
      { M3: [chip("index.js", 3)] },
      RULES
    );

    assert.deepEqual(
      groups.map((g) => [g.ruleId, g.count, g.files.length]),
      [
        ["M1", 0, 0],
        ["M2", 0, 0],
        ["M3", 1, 1],
        ["M4", 0, 0],
        ["M5", 0, 0],
        ["M6", 0, 0],
      ]
    );
  });

  it("preserves every receipt of a large rule (28 signals across files)", () => {
    const lines = Array.from({ length: 20 }, (_, i) => chip("index.js", i + 3));
    const others = Array.from({ length: 8 }, (_, i) => chip("test/util/index.js", i + 1));
    const m3 = [...others, ...lines];

    const [group] = groupSignalsByRule({ M3: m3 }, ["M3"]);

    assert.equal(group.count, 28);
    assert.equal(group.files.length, 2);
    const receipts = group.files.flatMap((f) => f.signals.map(receiptCopyValue));
    assert.equal(receipts.length, 28);
    assert.deepEqual(
      [...receipts].sort(),
      m3.map(receiptCopyValue).sort()
    );
    assert.equal(receipts[0], "index.js:3");
    assert.equal(receipts[27], "test/util/index.js:8");
  });

  it("treats a missing or null rule entry as no signals", () => {
    const groups = groupSignalsByRule(
      { M1: undefined, M2: null } as unknown as Record<string, never[]>,
      ["M1", "M2"]
    );
    assert.deepEqual(
      groups.map((g) => g.count),
      [0, 0]
    );
  });
});
