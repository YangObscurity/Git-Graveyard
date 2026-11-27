import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bakeFixture, bakeFixtureArtifacts } from "../../scripts/fixtures/bake";

describe("Golden test runner: compares fresh output with committed bytes", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(currentDir, "../..");
  const fixturesDir = path.join(repoRoot, "test", "fixtures", "pinned");
  const reposJsonPath = path.join(fixturesDir, "repos.json");

  it("repos.json exists and contains pinned fixture records", () => {
    assert.ok(fs.existsSync(reposJsonPath), "repos.json must exist in fixtures directory");
    const repos = JSON.parse(fs.readFileSync(reposJsonPath, "utf8"));
    assert.ok(Array.isArray(repos), "repos.json must be an array");
    assert.ok(repos.length > 0, "repos.json must have at least one pinned fixture");
  });

  const reposList: Array<{ owner: string; repo: string; path: string }> = JSON.parse(
    fs.readFileSync(reposJsonPath, "utf8")
  );

  for (const repoItem of reposList) {
    const fixtureFolder = repoItem.path;
    const folderName = `${repoItem.owner}-${repoItem.repo}`;

    describe(`Fixture: ${folderName}`, () => {
      const fixtureDir = path.join(fixturesDir, fixtureFolder);
      const committedGoldenDir = path.join(currentDir, folderName);

      it(`matches committed all.patch byte-for-byte for ${folderName}`, async () => {
        const freshOutput = await bakeFixtureArtifacts(
          fixtureDir,
          bakeFixture(fixtureDir)
        );
        const committedPatchPath = path.join(committedGoldenDir, "all.patch");

        assert.ok(
          fs.existsSync(committedPatchPath),
          `Committed all.patch must exist at ${committedPatchPath}`
        );

        const committedPatch = fs.readFileSync(committedPatchPath, "utf8");
        assert.equal(
          freshOutput.allPatch,
          committedPatch,
          `Fresh all.patch must match committed bytes for ${folderName}`
        );
      });

      it(`matches committed report.json byte-for-byte for ${folderName}`, () => {
        const freshOutput = bakeFixture(fixtureDir);
        const committedReportPath = path.join(committedGoldenDir, "report.json");

        assert.ok(
          fs.existsSync(committedReportPath),
          `Committed report.json must exist at ${committedReportPath}`
        );

        const freshReportJson = JSON.stringify(freshOutput.reportJson, null, 2) + "\n";
        const committedReportJson = fs.readFileSync(committedReportPath, "utf8");

        assert.equal(
          freshReportJson,
          committedReportJson,
          `Fresh report.json must match committed bytes for ${folderName}`
        );

        // Also assert parsed structure equality
        const freshParsed = JSON.parse(freshReportJson);
        const committedParsed = JSON.parse(committedReportJson);
        assert.deepEqual(freshParsed, committedParsed);
      });
    });
  }
});
