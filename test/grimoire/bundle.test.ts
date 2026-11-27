// Task 19.4: Grimoire bundle generator and deterministic serializer.
// Validates: Requirements 6.1, 6.2, 10.1 - 10.11 (design R3-10, R4-22 P9).
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_RULE_IDS,
  BUNDLE_TASK_STATUSES,
  buildMappingRows,
  collectManualTasks,
  extractMappingRows,
  generateBundle,
  isPatchWorthyStep,
  normalizePatchSteps,
  normalizeUnknowns,
  parseBundleTasks,
  renderTasks,
  resolvedStatusCounts,
  resolveEngineVersion,
  type BundleInput,
} from "../../lib/grimoire/bundle";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const specsRoot = path.join(repoRoot, ".kiro", "specs", "resurrection");
const goldenRoot = path.join(repoRoot, "test", "golden");

const DATE_TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;

function baseInput(overrides: Partial<BundleInput> = {}): BundleInput {
  return {
    owner: "graveyard-fixtures",
    repo: "F-bundle",
    sha: "0".repeat(64),
    asOf: "2026-11-08T00:00:00Z",
    targetRuntime: { kind: "node", value: ">=22" },
    m2Fired: true,
    removedDependencies: ["request"],
    driftedDependencies: [
      { name: "webpack", declaredVersion: "^2.7.0", latestVersion: "5.98.0", manifestDir: "." },
    ],
    signals: [
      {
        ruleId: "M2",
        file: "index.js",
        line: 1,
        column: 16,
        matched: "require('request')",
        confidence: "high",
        manifestDir: ".",
      },
      {
        ruleId: "M6",
        file: "package.json",
        line: 1,
        column: 1,
        matched: "missing lock file",
        confidence: "high",
        manifestDir: ".",
      },
    ],
    steps: [
      {
        ruleId: "M2",
        file: "index.js",
        reverted: false,
        compat: true,
        behavior: "unknown",
        notes: "transport is fetch; only the R1 adapter behaviors are kept",
        diff: "--- index.js\n+++ index.js\n",
        hunks: 1,
      },
      {
        ruleId: "M1",
        file: "tools/build.py",
        reverted: true,
        revertReason: "all_edits_rejected",
      },
    ],
    unknowns: [{ ruleId: "M1", reason: "py2_residue", file: "tools/build.py", line: 7 }],
    pythonFileLabels: { "tools/build.py": "m1-partial", "tools/clean.py": "m1-clean" },
    lockCommands: { ".": "npm install --package-lock-only --ignore-scripts" },
    preset: true,
    ...overrides,
  };
}

function bullets(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => /^- /.test(line));
}

function assertEveryBulletCitesRule(text: string, label: string): void {
  for (const line of bullets(text)) {
    assert.match(
      line,
      /^- (M[1-6]|unknown): /,
      `${label} bullet must cite a rule ID M1 to M6 or the word unknown: ${line}`
    );
  }
}

describe("Grimoire bundle templates (Requirements 10.1, 10.2, 10.10)", () => {
  it("renders requirements.md with a target runtime, dependency changes and checks", () => {
    const bundle = generateBundle(baseInput());
    assert.match(bundle.requirements, /^# Requirements: graveyard-fixtures\/F-bundle$/m);
    assert.match(bundle.requirements, /^## Target runtime$/m);
    assert.match(bundle.requirements, /^## Dependency changes$/m);
    assert.match(bundle.requirements, /^## Checks$/m);
    assert.match(bundle.requirements, /target Node runtime SHALL be `>=22` \(rule M2/);
    assert.match(bundle.requirements, /dependency `request` SHALL be removed/);
    assert.match(bundle.requirements, /dependency `webpack` \(`\^2\.7\.0`\) SHALL be reported as drifted/);
    assert.match(bundle.requirements, /SHALL run \(rule M6/);
    assertEveryBulletCitesRule(bundle.requirements, "requirements.md");
  });

  it("falls back to `unspecified` when engines.node and requires-python are absent", () => {
    const bundle = generateBundle(
      baseInput({ targetRuntime: null, m2Fired: false, removedDependencies: [] })
    );
    assert.match(bundle.requirements, /could not be determined from `engines\.node` or `requires-python`/);
  });

  it("uses requires-python as the Python target runtime without M2", () => {
    const bundle = generateBundle(
      baseInput({
        targetRuntime: { kind: "python", value: ">=3.9" },
        m2Fired: false,
        removedDependencies: [],
        driftedDependencies: [],
      })
    );
    assert.match(bundle.requirements, /target Python runtime SHALL be `>=3\.9` \(rule M1/);
    assert.match(bundle.requirements, /Python dependency drift SHALL be recorded as `unknown`/);
  });

  it("renders design.md with all six M1 to M6 mapping rows", () => {
    const bundle = generateBundle(baseInput());
    assert.match(bundle.design, /^## Mapping$/m);
    assert.match(bundle.design, /^\| Rule \| Fired \| Finding \| Target \| Files \|$/m);
    const rows = extractMappingRows(bundle.design);
    assert.deepEqual(
      rows.map((row) => row.ruleId),
      [...BUNDLE_RULE_IDS]
    );
    for (const row of rows) {
      assert.ok(BUNDLE_RULE_IDS.includes(row.ruleId));
    }
    assert.equal(rows.find((row) => row.ruleId === "M2")?.fired, true);
    assert.equal(rows.find((row) => row.ruleId === "M2")?.files.includes("index.js"), true);
    assert.equal(rows.find((row) => row.ruleId === "M3")?.fired, false);
  });

  it("extracts backtick-wrapped paths that contain a comma", () => {
    const design = [
      "## Mapping",
      "",
      "| Rule | Fired | Finding | Target | Files |",
      "|---|---|---|---|---|",
      "| M1 | yes | f | t | `a,b.py`, `plain.py` |",
      "",
      "## Next",
    ].join("\n");
    const rows = extractMappingRows(design);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].files, ["a,b.py", "plain.py"]);
  });

  it("renders compatibility and behavior notes from the patch steps", () => {
    const bundle = generateBundle(baseInput());
    assert.match(bundle.design, /^## Compatibility notes$/m);
    assert.match(bundle.design, /`index\.js` keeps the compatibility shim; behaviour is `unknown`/);
    assert.match(bundle.design, /^## Behavior notes$/m);
    assert.match(bundle.design, /`index\.js`: transport is fetch/);
  });

  it("renders the unknown list with a reason code and a fallback line", () => {
    const withUnknowns = generateBundle(baseInput());
    assert.match(withUnknowns.design, /`py2_residue` at `tools\/build\.py:7`/);

    const withoutUnknowns = generateBundle(baseInput({ unknowns: [] }));
    assert.match(withoutUnknowns.design, /no unknown item was recorded for this repository/);
  });

  it("writes design.md with the Outcome task status counts for every status", () => {
    const bundle = generateBundle(baseInput());
    assert.match(bundle.design, /^## Outcome$/m);
    for (const status of BUNDLE_TASK_STATUSES) {
      assert.match(bundle.design, new RegExp(`${status}=\\d+`));
    }
  });
});

describe("tasks.md bijection and markings (Requirements 10.3-10.6, 10.11)", () => {
  it("produces exactly one patch task per (ruleId, file) patch step", () => {
    const input = baseInput();
    const bundle = generateBundle(input);
    const parsed = parseBundleTasks(bundle.tasks);

    const stepKeys = new Set(bundle.patchSteps.map((step) => `${step.ruleId}:${step.file}`));
    const taskKeys = new Set(parsed.patch.map((task) => `${task.ruleId}:${task.file}`));
    assert.deepEqual([...taskKeys].sort(), [...stepKeys].sort());
    assert.equal(parsed.patch.length, stepKeys.size);
  });

  it("checks a patch task if and only if its patch step is not reverted", () => {
    const bundle = generateBundle(baseInput());
    const parsed = parseBundleTasks(bundle.tasks);
    const reverted = new Set(
      bundle.patchSteps.filter((step) => step.reverted).map((step) => `${step.ruleId}:${step.file}`)
    );
    for (const task of parsed.patch) {
      const key = `${task.ruleId}:${task.file}`;
      assert.equal(task.checked, !reverted.has(key), `${key} marking must match reverted`);
    }
    assert.equal(parsed.patch.filter((task) => !task.checked).length, reverted.size);
  });

  it("appends the Outcome revert reason under a reverted patch task", () => {
    const bundle = generateBundle(baseInput());
    const parsed = parseBundleTasks(bundle.tasks);
    const revertedTask = parsed.patch.find((task) => task.ruleId === "M1");
    assert.ok(revertedTask, "the reverted M1 step must have a patch task");
    assert.equal(revertedTask!.checked, false);
    assert.equal(revertedTask!.outcome, "reverted (all_edits_rejected)");
    assert.match(bundle.tasks, /- \[ \] \d+\. M1 `tools\/build\.py`[\s\S]*- Outcome: reverted \(all_edits_rejected\)/);
  });

  it("leaves manual tasks unchecked except the preset M6 task", () => {
    const bundle = generateBundle(baseInput());
    const parsed = parseBundleTasks(bundle.tasks);
    const manualByRule = new Map(parsed.manual.map((task) => [task.ruleId, task]));
    assert.equal(manualByRule.get("M5")?.checked, false);
    assert.equal(manualByRule.get("M6")?.checked, true);
    assert.equal(manualByRule.get("M6")?.outcome, "baked by bake:presets");

    const nonPreset = generateBundle(baseInput({ preset: false }));
    const parsedNonPreset = parseBundleTasks(nonPreset.tasks);
    for (const task of parsedNonPreset.manual) {
      assert.equal(task.checked, false, "non-preset manual tasks stay unchecked");
    }
  });

  it("separates patch tasks from manual tasks and numbers them once", () => {
    const bundle = generateBundle(baseInput());
    const parsed = parseBundleTasks(bundle.tasks);
    assert.match(bundle.tasks, /^## Patch tasks$/m);
    assert.match(bundle.tasks, /^## Manual tasks$/m);
    const indices = [...parsed.patch, ...parsed.manual].map((task) => task.index);
    assert.deepEqual(indices, indices.map((_, i) => i + 1));
  });

  it("writes no patch task when no step is patch-worthy", () => {
    const bundle = generateBundle(
      baseInput({
        steps: [{ ruleId: "M1", file: "noop.py", reverted: false }],
      })
    );
    assert.equal(bundle.patchSteps.length, 0);
    assert.match(bundle.tasks, /No patch task applies to this repository/);
    assert.equal(parseBundleTasks(bundle.tasks).patch.length, 0);
  });

  it("drops a step with no edits and no revert and keeps the plan deterministic", () => {
    assert.equal(isPatchWorthyStep({ ruleId: "M1", file: "a.py", reverted: false }), false);
    assert.equal(isPatchWorthyStep({ ruleId: "M1", file: "a.py", reverted: true }), true);
    assert.equal(
      isPatchWorthyStep({ ruleId: "M1", file: "a.py", reverted: false, acceptedEdits: 1 }),
      true
    );
    const steps = normalizePatchSteps([
      { ruleId: "M2", file: "b.js", reverted: false, diff: "x" },
      { ruleId: "M1", file: "z.py", reverted: false, acceptedEdits: 1 },
      { ruleId: "M1", file: "a.py", reverted: false, acceptedEdits: 2 },
      { ruleId: "M1", file: "a.py", reverted: false, acceptedEdits: 2 },
      { ruleId: "M7", file: "invalid.js", reverted: false, diff: "x" },
    ]);
    assert.deepEqual(
      steps.map((step) => step.key),
      ["M1:a.py", "M1:z.py", "M2:b.js"]
    );
  });
});

describe("Outcome labels and deterministic output (Requirements 10.7-10.10)", () => {
  it("labels every Python file m1-clean or m1-partial in the Outcome section", () => {
    const bundle = generateBundle(baseInput());
    assert.match(bundle.design, /- M1: `tools\/build\.py` labelled `m1-partial`/);
    assert.match(bundle.design, /- M1: `tools\/clean\.py` labelled `m1-clean`/);
    assert.equal(
      (bundle.design.match(/labelled `m1-(clean|partial)`/g) ?? []).length,
      2
    );
  });

  it("writes the label of each Python file into the Outcome summary", () => {
    const bundle = generateBundle(baseInput({ pythonFileLabels: {} }));
    assert.match(bundle.design, /no Python file was labelled in this run/);
  });

  it("excludes wall-clock timestamps and model prose", () => {
    const withoutAsOf = generateBundle(baseInput({ asOf: undefined }));
    for (const text of [withoutAsOf.requirements, withoutAsOf.design, withoutAsOf.tasks]) {
      assert.deepEqual(text.match(DATE_TIME_RE), null);
      assert.doesNotMatch(text, /Date\.now|new Date\(/);
    }
    assert.doesNotMatch(withoutAsOf.design, /\bmodel\b/i);
    assert.doesNotMatch(withoutAsOf.tasks, /\bmodel\b/i);
  });

  it("only embeds the pinned fixture asOf when one is supplied", () => {
    const withAsOf = generateBundle(baseInput({ asOf: "2026-11-08T00:00:00Z" }));
    const matches = withAsOf.requirements.match(DATE_TIME_RE) ?? [];
    assert.ok(matches.length > 0);
    for (const match of matches) {
      assert.equal(match, "2026-11-08T00:00:00Z");
    }
  });

  it("reports the engine version from the engine-version module", () => {
    const bundle = generateBundle(baseInput());
    assert.equal(bundle.engineVersion, resolveEngineVersion());
    assert.match(bundle.engineVersion, /^[0-9a-f]{64}$/);
    assert.match(bundle.requirements, new RegExp(`engine \`${bundle.engineVersion}\``));
  });

  it("produces byte-identical requirements, design and tasks on repeated runs", () => {
    const input = baseInput();
    const first = generateBundle(input);
    const second = generateBundle({ ...input });
    assert.equal(first.requirements, second.requirements);
    assert.equal(first.design, second.design);
    assert.equal(first.tasks, second.tasks);
    assert.equal(
      JSON.stringify([first.requirements, first.design, first.tasks]),
      JSON.stringify([second.requirements, second.design, second.tasks])
    );
  });

  it("is stable across reordered inputs", () => {
    const base = baseInput();
    const shuffled = baseInput({
      signals: [...base.signals!].reverse(),
      unknowns: [...base.unknowns!].reverse(),
      driftedDependencies: [
        { name: "zlib", declaredVersion: "1.0.0", latestVersion: "9.0.0", manifestDir: "." },
        ...base.driftedDependencies!,
      ],
    });
    const ordered = baseInput({
      driftedDependencies: [
        ...base.driftedDependencies!,
        { name: "zlib", declaredVersion: "1.0.0", latestVersion: "9.0.0", manifestDir: "." },
      ],
    });
    assert.equal(renderTasks(shuffled), renderTasks(ordered));
    assert.equal(
      generateBundle(shuffled).design,
      generateBundle(ordered).design
    );
    assert.equal(
      JSON.stringify(buildMappingRows(shuffled, normalizePatchSteps(shuffled.steps))),
      JSON.stringify(buildMappingRows(ordered, normalizePatchSteps(ordered.steps)))
    );
  });

  it("dedupes manual tasks by (ruleId, target)", () => {
    const tasks = collectManualTasks(
      baseInput({
        manualTasks: [
          { ruleId: "M6", target: ".", description: "run `npm install`" },
          { ruleId: "M6", target: ".", description: "duplicate" },
          { ruleId: "M7", target: ".", description: "invalid rule" },
        ],
      })
    );
    assert.equal(tasks.filter((task) => task.ruleId === "M6").length, 1);
    assert.equal(tasks.filter((task) => task.ruleId === "M7").length, 0);
  });

  it("normalizes an explicit manual task target before deduping", () => {
    const tasks = collectManualTasks(
      baseInput({
        manualTasks: [
          { ruleId: "M6", target: ".", description: "explicit" },
          { ruleId: "M6", target: "./", description: "duplicate once normalized" },
          { ruleId: "M5", target: "packages\\a\\", description: "windows separators" },
        ],
      })
    );
    const m6 = tasks.filter((task) => task.ruleId === "M6");
    assert.equal(m6.length, 1, "keys must be deduped after normalizing the target");
    assert.equal(m6[0].target, ".");
    const m5 = tasks.filter((task) => task.ruleId === "M5");
    assert.equal(m5.length, 2);
    assert.ok(
      m5.some((task) => task.target === "packages/a"),
      "the explicit target must be normalized to forward slashes"
    );
  });
});

function outcomeStatusCounts(design: string): Record<string, number> {
  const line = design.split("\n").find((entry) => entry.includes("task status counts:"));
  assert.ok(line, "design.md must render the Outcome task status counts");
  const payload = line
    .replace(/^.*task status counts:\s*/, "")
    .replace(/\s*\(Requirements.*$/, "");
  const counts: Record<string, number> = {};
  for (const part of payload.split(",")) {
    const [status, value] = part.trim().split("=");
    counts[status] = Number(value);
  }
  return counts;
}

describe("Outcome task counts and unknown line ordering (Requirements 6.3, 10.5, 10.7)", () => {
  it("counts checked manual tasks in merged so the status counts sum to the total task count", () => {
    const input = baseInput();
    const bundle = generateBundle(input);
    const counts = resolvedStatusCounts(input, bundle.patchTasks, bundle.manualTasks);
    const total = bundle.patchTasks.length + bundle.manualTasks.length;

    assert.equal(total, 4);
    assert.equal(bundle.manualTasks.filter((task) => task.checked).length, 1);
    assert.equal(
      counts.find((entry) => entry.status === "merged")?.count,
      2,
      "merged must include the checked M6 manual task"
    );
    assert.equal(
      counts.reduce((sum, entry) => sum + entry.count, 0),
      total,
      "pending + merged must equal the total number of tasks"
    );

    const rendered = outcomeStatusCounts(bundle.design);
    assert.equal(rendered.merged, 2);
    assert.equal(
      Object.values(rendered).reduce((sum, value) => sum + value, 0),
      total
    );
  });

  it("counts a checked manual task as merged even when no patch task exists", () => {
    const input = baseInput({
      signals: [],
      steps: [],
      driftedDependencies: [],
      removedDependencies: [],
      m2Fired: false,
      unknowns: [],
      pythonFileLabels: {},
      manualTasks: [
        { ruleId: "M5", target: ".", description: "review drifted dependency `webpack`" },
        {
          ruleId: "M6",
          target: ".",
          description: "run `npm install --package-lock-only --ignore-scripts`",
          checked: true,
        },
      ],
    });
    const bundle = generateBundle(input);
    const counts = resolvedStatusCounts(input, bundle.patchTasks, bundle.manualTasks);
    const total = bundle.patchTasks.length + bundle.manualTasks.length;

    assert.equal(bundle.patchTasks.length, 0);
    assert.equal(total, 2);
    assert.equal(counts.find((entry) => entry.status === "pending")?.count, 1);
    assert.equal(counts.find((entry) => entry.status === "merged")?.count, 1);
    assert.equal(
      counts.reduce((sum, entry) => sum + entry.count, 0),
      total
    );
  });

  it("treats an explicit taskStatusCounts as authoritative without mixing derived counts", () => {
    const input = baseInput({ taskStatusCounts: { merged: 2 } });
    const bundle = generateBundle(input);
    const provided = resolvedStatusCounts(input, bundle.patchTasks, bundle.manualTasks);
    const derived = resolvedStatusCounts(
      baseInput(),
      bundle.patchTasks,
      bundle.manualTasks
    );

    assert.equal(provided.find((entry) => entry.status === "merged")?.count, 2);
    // `pending` is omitted from taskStatusCounts, so it must read 0 rather than
    // the derived value from the patch and manual tasks.
    assert.equal(provided.find((entry) => entry.status === "pending")?.count, 0);
    assert.notEqual(
      derived.find((entry) => entry.status === "pending")?.count,
      0,
      "the derived pending count must be non-zero to prove the values are not mixed"
    );

    const rendered = outcomeStatusCounts(bundle.design);
    assert.equal(rendered.pending, 0);
    assert.equal(rendered.merged, 2);
  });

  it("orders a lower line number before a higher one for the same file and reason", () => {
    const items = normalizeUnknowns([
      { ruleId: "M1", reason: "py2_residue", file: "tools/build.py", line: 10 },
      { ruleId: "M1", reason: "py2_residue", file: "tools/build.py", line: 7 },
    ]);
    assert.deepEqual(
      items.map((item) => item.line),
      ["7", "10"],
      "line 7 must sort before line 10 within the same file and reason"
    );

    const design = generateBundle(
      baseInput({
        unknowns: [
          { ruleId: "M1", reason: "py2_residue", file: "tools/build.py", line: 10 },
          { ruleId: "M1", reason: "py2_residue", file: "tools/build.py", line: 7 },
        ],
      })
    ).design;
    const idx7 = design.indexOf("tools/build.py:7");
    const idx10 = design.indexOf("tools/build.py:10");
    assert.ok(idx7 >= 0 && idx10 >= 0, "both unknown lines must render");
    assert.ok(idx7 < idx10, "design.md must render line 7 before line 10");
  });

  it("keeps a non-numeric line value without coercing it during the sort", () => {
    const items = normalizeUnknowns([
      { ruleId: "M1", reason: "py2_residue", file: "a.py", line: Number.NaN },
      { ruleId: "M1", reason: "py2_residue", file: "a.py", line: 7 },
    ]);
    assert.equal(items.length, 2);
    // `NaN` never parses as a number, so it takes the lexical fallback and stays intact.
    assert.deepEqual(items.map((item) => item.line).sort(), ["7", "NaN"]);
    assert.deepEqual(
      normalizeUnknowns([
        { ruleId: "M1", reason: "py2_residue", file: "a.py", line: Number.NaN },
        { ruleId: "M1", reason: "py2_residue", file: "a.py", line: 7 },
      ]),
      items,
      "the fallback ordering must be deterministic across runs"
    );
  });
});

interface PinnedRepo {
  owner: string;
  repo: string;
  path: string;
}

function pinnedRepos(): PinnedRepo[] {
  const reposPath = path.join(repoRoot, "test", "fixtures", "pinned", "repos.json");
  return JSON.parse(fs.readFileSync(reposPath, "utf8")) as PinnedRepo[];
}

describe("baked Grimoire bundles and golden artifacts (Requirement 10.8, R3-12)", () => {
  const repos = pinnedRepos();

  it("pins at least the three preset fixtures", () => {
    const names = repos.map((item) => item.repo).sort();
    assert.ok(names.includes("F-node-cjs-request"));
    assert.ok(names.includes("F-node-webpack2"));
    assert.ok(names.includes("F-python2"));
  });

  for (const item of repos) {
    const folder = `${item.owner}-${item.repo}`;
    const specFolder = path.join(specsRoot, folder);
    const goldenFolder = path.join(goldenRoot, folder);

    it(`commits a requirements.md, design.md and tasks.md bundle for ${folder}`, () => {
      for (const name of ["requirements.md", "design.md", "tasks.md"]) {
        const file = path.join(specFolder, name);
        assert.ok(fs.existsSync(file), `${file} must be committed`);
      }
      const requirements = fs.readFileSync(path.join(specFolder, "requirements.md"), "utf8");
      const design = fs.readFileSync(path.join(specFolder, "design.md"), "utf8");
      const tasks = fs.readFileSync(path.join(specFolder, "tasks.md"), "utf8");

      assertEveryBulletCitesRule(requirements, `${folder} requirements.md`);

      const rows = extractMappingRows(design);
      assert.deepEqual(
        rows.map((row) => row.ruleId),
        [...BUNDLE_RULE_IDS],
        `${folder} design.md must cite M1 to M6`
      );

      const parsed = parseBundleTasks(tasks);
      const keys = parsed.patch.map((task) => `${task.ruleId}:${task.file}`);
      assert.equal(new Set(keys).size, keys.length, `${folder} patch task keys must be unique`);

      const verify = JSON.parse(
        fs.readFileSync(path.join(goldenFolder, "verify-result.json"), "utf8")
      ) as { patchSteps: number; revertedSteps: number; engineVersion: string };
      assert.equal(parsed.patch.length, verify.patchSteps, `${folder} P7 bijection`);
      assert.equal(
        parsed.patch.filter((task) => !task.checked).length,
        verify.revertedSteps,
        `${folder} unchecked patch tasks equal reverted steps`
      );
      assert.match(verify.engineVersion, /^[0-9a-f]{64}$/);

      const events = fs
        .readFileSync(path.join(goldenFolder, "events.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { seq: number; kind: string });
      assert.ok(events.length > 0);
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_, index) => index)
      );
      assert.equal(events[events.length - 1].kind, "gate.result");
    });
  }
});
