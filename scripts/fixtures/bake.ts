#!/usr/bin/env tsx
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scanInventory, type InventoryInputFile } from "../../lib/grimoire/detect";
import { detectSignals } from "../../lib/grimoire/signals";
import { computeVerdict, type VerdictResult } from "../../lib/grimoire/verdict";
import { transformM2Request } from "../../lib/rules/m2-request";
import { updateM2Manifest } from "../../lib/rules/m2-manifest";
import {
  evaluateM5Dependencies,
  detectM6Signals,
} from "../../lib/rules/m5-m6-guidance";
import type { Signal, UnknownRecord } from "../../lib/grimoire/types";

export interface PinnedRepoMeta {
  owner: string;
  repo: string;
  sha: string;
  asOf: string;
  stars?: number;
  lastWords?: string;
  license?: string;
  archived?: boolean;
  createdAt?: string;
  lastCommitAt?: string;
}

export interface BakedFixtureOutput {
  owner: string;
  repo: string;
  allPatch: string;
  reportJson: {
    signals: Signal[];
    verdict: VerdictResult;
    unknowns: UnknownRecord[];
  };
}

export interface BakeOptions {
  check?: boolean;
  fixturesDir?: string;
  goldenDir?: string;
}

function isBabelParseable(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = norm.slice(norm.lastIndexOf("/") + 1);
  return (
    basename.endsWith(".js") ||
    basename.endsWith(".cjs") ||
    basename.endsWith(".mjs") ||
    basename.endsWith(".jsx") ||
    basename.endsWith(".ts") ||
    basename.endsWith(".tsx")
  );
}

export function bakeFixture(fixtureDir: string): BakedFixtureOutput {
  const metaPath = path.join(fixtureDir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    throw new Error(`meta.json not found in fixture directory: ${fixtureDir}`);
  }

  const meta: PinnedRepoMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const registryPath = path.join(fixtureDir, "registry.json");
  const registryJson: Record<string, unknown> = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, "utf8"))
    : {};

  // Read fixture files (exclude metadata files)
  const files: InventoryInputFile[] = [];

  function walk(currentDir: string, currentRel: string) {
    const dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of dirEntries) {
      const rel = currentRel ? `${currentRel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(path.join(currentDir, ent.name), rel);
      } else if (ent.isFile()) {
        if (
          rel === "meta.json" ||
          rel === "registry.json" ||
          rel === "repos.json" ||
          rel === "README.md"
        ) {
          continue;
        }
        const content = fs.readFileSync(path.join(currentDir, ent.name), "utf8");
        files.push({ path: rel, content });
      }
    }
  }

  walk(fixtureDir, "");

  // 1. Detect
  const inventory = scanInventory(files);
  const inventoryUnknowns: UnknownRecord[] = inventory.ok ? inventory.unknowns : [];

  // 2. Signals
  const scannedFiles = inventory.ok ? inventory.scannedFiles : [];
  const astSignalsResult = detectSignals(scannedFiles);
  const astSignals = astSignalsResult.signals;
  const astUnknowns = astSignalsResult.unknowns;

  // 3. M6 signals
  const manifestDirectories = inventory.ok ? inventory.manifestDirectories : [];
  const m6Signals = detectM6Signals(manifestDirectories);

  // Combine and sort signals deterministically
  const allSignals: Signal[] = [...astSignals, ...m6Signals];
  allSignals.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });

  // 4. Verdict (asOf from meta.json)
  const verdict = computeVerdict({
    archived: Boolean(meta.archived),
    lastCommitAt: meta.lastCommitAt,
    createdAt: meta.createdAt,
    signals: allSignals,
    asOf: meta.asOf,
  });

  // 5. M2 transform
  let allPatch = "";
  const m2Unknowns: UnknownRecord[] = [];
  let m2Fired = false;

  for (const sf of scannedFiles) {
    if (!isBabelParseable(sf.path)) {
      continue;
    }
    const sourceCode = typeof sf.content === "string" ? sf.content : "";
    const m2Res = transformM2Request(sourceCode, {
      filePath: sf.path,
      manifestDir: sf.manifestDir,
    });

    if (m2Res.changed && m2Res.step?.diff) {
      allPatch += (allPatch ? "\n" : "") + m2Res.step.diff;
      m2Fired = true;
    }

    if (m2Res.unknowns.length > 0) {
      m2Unknowns.push(...m2Res.unknowns);
    }
  }

  // 6. Manifest updates (M2 & M5)
  const manifestUnknowns: UnknownRecord[] = [];
  const m5Unknowns: UnknownRecord[] = [];

  const pkgInputFile = files.find((f) => f.path === "package.json");
  if (pkgInputFile && typeof pkgInputFile.content === "string") {
    let pkgJson: Record<string, unknown> = {};
    try {
      pkgJson = JSON.parse(pkgInputFile.content);
    } catch {
      pkgJson = {};
    }

    if (m2Fired) {
      const manifestRes = updateM2Manifest(pkgJson, {
        stillImportsRequest: false,
        m2Fired: true,
        filePath: "package.json",
      });
      if (manifestRes.unknowns.length > 0) {
        manifestUnknowns.push(...manifestRes.unknowns);
      }
    }

    const m5Res = evaluateM5Dependencies(pkgJson, {
      registry: registryJson as any,
      filePath: "package.json",
      manifestDir: ".",
    });
    if (m5Res.unknowns.length > 0) {
      m5Unknowns.push(...m5Res.unknowns);
    }
  }

  // 7. Combine unknowns
  const allUnknownsList = [
    ...inventoryUnknowns,
    ...astUnknowns,
    ...m2Unknowns,
    ...manifestUnknowns,
    ...m5Unknowns,
  ];

  const seenUnknowns = new Set<string>();
  const uniqueUnknowns: UnknownRecord[] = [];
  for (const u of allUnknownsList) {
    const k = `${u.ruleId}:${u.reason}:${u.file ?? ""}:${u.line ?? ""}`;
    if (!seenUnknowns.has(k)) {
      seenUnknowns.add(k);
      uniqueUnknowns.push(u);
    }
  }

  return {
    owner: meta.owner,
    repo: meta.repo,
    allPatch,
    reportJson: {
      signals: allSignals,
      verdict,
      unknowns: uniqueUnknowns,
    },
  };
}

export function runBake(options?: BakeOptions): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const fixturesDir = options?.fixturesDir
    ? path.resolve(options.fixturesDir)
    : path.join(repoRoot, "test", "fixtures", "pinned");
  const goldenDir = options?.goldenDir
    ? path.resolve(options.goldenDir)
    : path.join(repoRoot, "test", "golden");

  const reposJsonPath = path.join(fixturesDir, "repos.json");
  if (!fs.existsSync(reposJsonPath)) {
    throw new Error(`repos.json not found in fixtures directory: ${fixturesDir}`);
  }

  const reposList: Array<{ owner: string; repo: string; path: string }> = JSON.parse(
    fs.readFileSync(reposJsonPath, "utf8")
  );

  if (options?.check) {
    // Check mode: regenerate into a temporary folder and compare with the committed files
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "bake-check-"));
    try {
      let hasDifference = false;

      for (const item of reposList) {
        const fixtureDir = path.join(fixturesDir, item.path);
        const result = bakeFixture(fixtureDir);
        const folderName = `${result.owner}-${result.repo}`;

        const freshPatch = result.allPatch;
        const freshReport = JSON.stringify(result.reportJson, null, 2) + "\n";

        const tmpTargetDir = path.join(tmpBase, folderName);
        fs.mkdirSync(tmpTargetDir, { recursive: true });
        const tmpPatchPath = path.join(tmpTargetDir, "all.patch");
        fs.writeFileSync(tmpPatchPath, freshPatch, "utf8");
        const tmpReportPath = path.join(tmpTargetDir, "report.json");
        fs.writeFileSync(tmpReportPath, freshReport, "utf8");

        const committedFixtureDir = path.join(goldenDir, folderName);
        const committedPatchPath = path.join(committedFixtureDir, "all.patch");
        const committedReportPath = path.join(committedFixtureDir, "report.json");

        if (!fs.existsSync(committedPatchPath)) {
          console.error(`Check failed: missing committed file ${committedPatchPath}`);
          hasDifference = true;
          continue;
        }
        if (!fs.existsSync(committedReportPath)) {
          console.error(`Check failed: missing committed file ${committedReportPath}`);
          hasDifference = true;
          continue;
        }

        const committedPatch = fs.readFileSync(committedPatchPath, "utf8");
        const committedReport = fs.readFileSync(committedReportPath, "utf8");

        if (freshPatch !== committedPatch) {
          console.error(`Check failed: all.patch differs for ${folderName}`);
          hasDifference = true;
        }

        if (freshReport !== committedReport) {
          console.error(`Check failed: report.json differs for ${folderName}`);
          hasDifference = true;
        }
      }

      if (hasDifference) {
        process.exit(1);
      }
      console.log("Check passed: all golden files match committed files byte for byte.");
    } finally {
      try {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  } else {
    // Normal mode: write golden files
    for (const item of reposList) {
      const fixtureDir = path.join(fixturesDir, item.path);
      const result = bakeFixture(fixtureDir);
      const folderName = `${result.owner}-${result.repo}`;
      const targetDir = path.join(goldenDir, folderName);

      fs.mkdirSync(targetDir, { recursive: true });

      const patchPath = path.join(targetDir, "all.patch");
      fs.writeFileSync(patchPath, result.allPatch, "utf8");

      const reportPath = path.join(targetDir, "report.json");
      const reportContent = JSON.stringify(result.reportJson, null, 2) + "\n";
      fs.writeFileSync(reportPath, reportContent, "utf8");

      console.log(`Baked golden output for ${folderName} to ${targetDir}`);
    }
  }
}

export function main(): void {
  const argv = process.argv.slice(2);
  const isCheck = argv.includes("--check");

  try {
    runBake({ check: isCheck });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("bake.ts") ||
  process.argv[1]?.endsWith("bake.js");

if (isMain) {
  main();
}
