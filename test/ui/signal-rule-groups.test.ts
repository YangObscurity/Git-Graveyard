import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignalRuleGroups } from "@/components/SignalRuleGroups";
import { SignalChip } from "@/components/SignalChip";

const RULES = ["M1", "M2", "M3", "M4", "M5", "M6"] as const;

// Shape of gulp-plumber's M3 list: many lines in index.js plus test helpers.
const M3_FILES: ReadonlyArray<readonly [string, number]> = [
  ["test/util/index.js", 5],
  ["test/util/index.js", 1],
  ...Array.from({ length: 20 }, (_, i) => ["index.js", i + 3] as const),
  ...Array.from({ length: 6 }, (_, i) => ["test/index.js", i + 10] as const),
];

const m3Chips = M3_FILES.map(([file, line]) => ({
  ruleId: "M3",
  file,
  line,
  target: `${file}:${line}`,
}));

function render(chipsByRule: Record<string, unknown[]>) {
  return renderToStaticMarkup(
    React.createElement(SignalRuleGroups, {
      chipsByRule: chipsByRule as never,
      ruleIds: RULES,
      sha: "abc1234",
    })
  );
}

function allMatches(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((m) => m[1]);
}

describe("SignalRuleGroups", () => {
  const html = render({ M3: m3Chips });

  it("renders one copyable chip for every receipt, none dropped", () => {
    const payloads = allMatches(html, /data-clipboard-payload="([^"]+)"/g);
    assert.equal(payloads.length, 28);
    assert.deepEqual(
      [...payloads].sort(),
      m3Chips.map((c) => c.target).sort()
    );
  });

  it("gives every copy control an accessible name with its file:line", () => {
    const labels = allMatches(html, /aria-label="(Copy [^"]+)"/g);
    assert.equal(labels.length, 28);
    assert.ok(labels.includes("Copy index.js:3 to clipboard"));
    assert.ok(labels.includes("Copy test/util/index.js:5 to clipboard"));
  });

  it("shows one row per file, sorted by path, with its count", () => {
    const files = allMatches(html, /data-testid="signal-file-row" data-file="([^"]*)"/g);
    assert.deepEqual(files, ["index.js", "test/index.js", "test/util/index.js"]);
    assert.ok(html.includes("20 signals"));
    assert.ok(html.includes("6 signals"));
    assert.ok(html.includes("28 signals in 3 files"));
  });

  it("orders receipts by file then line", () => {
    const targets = allMatches(html, /data-target="([^"]+)"/g);
    assert.equal(targets[0], "index.js:3");
    assert.equal(targets[19], "index.js:22");
    assert.equal(targets[20], "test/index.js:10");
    assert.deepEqual(targets.slice(26), ["test/util/index.js:1", "test/util/index.js:5"]);
  });

  it("keeps the full receipt (rule and file:line) in each compact chip's text", () => {
    assert.ok(html.includes('<span class="sr-only">M3 index.js</span>:3'));
  });

  it("collapses rules without signals into one short line with honest wording", () => {
    for (const ruleId of ["M1", "M2", "M4", "M5", "M6"]) {
      assert.ok(html.includes(`data-testid="rule-group-${ruleId}"`));
      assert.ok(html.includes(`No signals detected for Rule ${ruleId}.`));
    }
    assert.ok(!html.includes("No signals detected for Rule M3."));
    // Only the rule with signals gets a full panel.
    assert.equal(allMatches(html, /class="(crypt-panel )/g).length, 1);
  });

  it("labels a signal that recorded no file instead of hiding it", () => {
    const out = render({ M1: [{ ruleId: "M1", file: "", line: 4 }] });
    assert.ok(out.includes("file not recorded"));
    assert.ok(out.includes('data-clipboard-payload=":4"'));
  });

  it("labels a signal that recorded no line instead of hiding it", () => {
    const out = render({ M2: [{ ruleId: "M2", file: "setup.py", line: 0 }] });
    assert.ok(out.includes(":line not recorded"));
    assert.ok(out.includes('data-clipboard-payload="setup.py:0"'));
  });
});

describe("SignalChip default variant", () => {
  it("still shows the rule badge and the whole file:line receipt", () => {
    const out = renderToStaticMarkup(
      React.createElement(SignalChip, {
        chip: { ruleId: "M1", file: "package.json", line: 42 },
      })
    );
    assert.ok(out.includes('data-chip-variant="full"'));
    assert.ok(out.includes(">package.json:42<"));
    assert.ok(out.includes('aria-label="Copy package.json:42 to clipboard"'));
    assert.ok(out.includes(">Copy<"));
  });
});
