// Task 19.10: Property test for deterministic Grimoire output (Property 9: P9).
// Validates: Requirements 10.8, 10.10 (design R4-22 P9).
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectSignals } from "../../lib/grimoire/signals";
import { computeVerdict } from "../../lib/grimoire/verdict";
import { generateBundle, type BundleInput } from "../../lib/grimoire/bundle";
import { bakeFixture, bakeFixtureArtifacts } from "../../scripts/fixtures/bake";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = path.join(repoRoot, "test", "fixtures", "pinned");
const AS_OF = "2026-11-08T00:00:00Z";
const DATE_TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;

const fileArb = fc.record({
  path: fc.constantFrom("index.js", "lib/util.cjs", "tools/build.py", "setup.py", "package.json"),
  content: fc.constantFrom(
    "const request = require('request');\n",
    "module.exports = { a: 1 };\n",
    'print "hi"\n',
    "exports.x = 1;\n",
    "not valid @@@\n"
  ),
});

const filesArb = fc.array(fileArb, { maxLength: 6 });

const stepArb = fc.record({
  ruleId: fc.constantFrom("M1", "M2", "M3", "M6"),
  file: fc.constantFrom("index.js", "tools/build.py", "setup.py"),
  reverted: fc.boolean(),
  diff: fc.constant("--- a\n+++ b\n"),
  hunks: fc.constant(1),
  compat: fc.boolean(),
  behavior: fc.constantFrom("preserved", "unknown", "changed"),
});

const bundleInputArb: fc.Arbitrary<BundleInput> = fc
  .record({
    files: filesArb,
    steps: fc.array(stepArb, { maxLength: 5 }),
    m2Fired: fc.boolean(),
    driftedDependencies: fc.array(
      fc.record({
        name: fc.constantFrom("lodash", "webpack"),
        declaredVersion: fc.constant("^1.0.0"),
        latestVersion: fc.constant("9.0.0"),
        manifestDir: fc.constant("."),
      }),
      { maxLength: 2 }
    ),
    pythonFileLabels: fc.dictionary(
      fc.constantFrom("tools/build.py", "setup.py"),
      fc.constantFrom("m1-clean" as const, "m1-partial" as const)
    ),
  })
  .map((fields) => {
    const detected = detectSignals(fields.files as never);
    const input: BundleInput = {
      owner: "graveyard-fixtures",
      repo: "F-props",
      asOf: AS_OF,
      targetRuntime: { kind: "node", value: ">=22" },
      m2Fired: fields.m2Fired,
      driftedDependencies: fields.driftedDependencies,
      steps: fields.steps,
      signals: detected.signals,
      unknowns: detected.unknowns,
      pythonFileLabels: fields.pythonFileLabels,
      preset: true,
    };
    return input;
  });

function fixtureDirFor(repo: string): string {
  const repos = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, "repos.json"), "utf8")
  ) as Array<{ repo: string; path: string }>;
  const entry = repos.find((item) => item.repo === repo);
  assert.ok(entry, `${repo} must be pinned`);
  return path.join(fixturesDir, entry!.path);
}

describe("Property 9: deterministic Grimoire output (Requirements 10.8, 10.10)", () => {
  it("emits byte-identical signals and dead-or-alive results for identical inputs", () => {
    fc.assert(
      fc.property(filesArb, (files) => {
        const firstSignals = detectSignals(files as never);
        const secondSignals = detectSignals(files.map((file) => ({ ...file })) as never);
        assert.deepEqual(firstSignals.signals, secondSignals.signals);
        assert.deepEqual(firstSignals.unknowns, secondSignals.unknowns);

        const firstVerdict = computeVerdict({
          archived: false,
          lastCommitAt: "2020-01-01T00:00:00Z",
          createdAt: "2016-01-01T00:00:00Z",
          signals: firstSignals.signals,
          asOf: AS_OF,
        });
        const secondVerdict = computeVerdict({
          archived: false,
          lastCommitAt: "2020-01-01T00:00:00Z",
          createdAt: "2016-01-01T00:00:00Z",
          signals: secondSignals.signals,
          asOf: AS_OF,
        });
        assert.deepEqual(firstVerdict, secondVerdict);
        assert.equal(firstVerdict.asOf, "2026-11-08T00:00:00.000Z");
      }),
      { numRuns: 120 }
    );
  });

  it("produces a byte-identical Grimoire bundle across repeated runs", () => {
    fc.assert(
      fc.property(bundleInputArb, (input) => {
        const first = generateBundle(input);
        const second = generateBundle(input);
        assert.equal(first.requirements, second.requirements);
        assert.equal(first.design, second.design);
        assert.equal(first.tasks, second.tasks);
        assert.equal(
          JSON.stringify([first.requirements, first.design, first.tasks]),
          JSON.stringify([second.requirements, second.design, second.tasks])
        );
      }),
      { numRuns: 120 }
    );
  });

  it("writes no timestamp other than the pinned asOf into the bundle", () => {
    fc.assert(
      fc.property(bundleInputArb, (input) => {
        const bundle = generateBundle({ ...input, asOf: undefined });
        for (const text of [bundle.requirements, bundle.design, bundle.tasks]) {
          assert.deepEqual(text.match(DATE_TIME_RE), null);
        }
        const withAsOf = generateBundle(input);
        for (const match of withAsOf.requirements.match(DATE_TIME_RE) ?? []) {
          assert.equal(match, AS_OF);
        }
        assert.deepEqual(withAsOf.tasks.match(DATE_TIME_RE), null);
        assert.deepEqual(withAsOf.design.match(DATE_TIME_RE), null);
      }),
      { numRuns: 100 }
    );
  });

  it("bakes byte-identical golden artifacts from the frozen F-python2 fixture", async () => {
    const fixtureDir = fixtureDirFor("F-python2");
    const first = bakeFixture(fixtureDir);
    const second = bakeFixture(fixtureDir);
    assert.equal(first.allPatch, second.allPatch);
    assert.equal(JSON.stringify(first.reportJson), JSON.stringify(second.reportJson));

    const firstArtifacts = await bakeFixtureArtifacts(fixtureDir, first);
    const secondArtifacts = await bakeFixtureArtifacts(fixtureDir, second);
    assert.equal(firstArtifacts.requirements, secondArtifacts.requirements);
    assert.equal(firstArtifacts.design, secondArtifacts.design);
    assert.equal(firstArtifacts.tasks, secondArtifacts.tasks);
    assert.equal(firstArtifacts.eventsNdjson, secondArtifacts.eventsNdjson);
    assert.equal(firstArtifacts.verifyResultJson, secondArtifacts.verifyResultJson);
  });

  it("bakes byte-identical artifacts for a Node fixture with frozen registry answers", async () => {
    const fixtureDir = fixtureDirFor("F-node-cjs-request");
    const first = bakeFixture(fixtureDir);
    const second = bakeFixture(fixtureDir);
    const firstArtifacts = await bakeFixtureArtifacts(fixtureDir, first);
    const secondArtifacts = await bakeFixtureArtifacts(fixtureDir, second);
    assert.equal(firstArtifacts.tasks, secondArtifacts.tasks);
    assert.equal(firstArtifacts.eventsNdjson, secondArtifacts.eventsNdjson);
    assert.equal(firstArtifacts.verifyResultJson, secondArtifacts.verifyResultJson);
    assert.match(firstArtifacts.tasks, /request\(opts, cb\)/);
  });
});
