#!/usr/bin/env tsx
import * as fs from "node:fs";
import * as path from "node:path";
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
import {
  analyzePython,
  checkDeclaredPythonVersion,
  initPythonParser,
} from "../../lib/rules/m1-python";
import { isPythonFile } from "../../lib/grimoire/gate-js";
import type { PatchStep } from "../../lib/grimoire/gate-js";
import {
  generateBundle,
  resolveEngineVersion,
  POETRY_LOCK_COMMAND,
  DEFAULT_NPM_LOCK_COMMAND,
  type BundleInput,
  type BundleManualTaskInput,
  type BundleTargetRuntime,
  type GrimoireBundle,
} from "../../lib/grimoire/bundle";
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
  /** M2 patch steps collected while baking. Never written to `all.patch`. */
  m2Steps: PatchStep[];
}

export interface BakeOptions {
  check?: boolean;
  fixturesDir?: string;
  goldenDir?: string;
  /** Directory that holds the per-repository Grimoire bundles. */
  specsDir?: string;
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

/** Reads the detector-read fixture files, excluding fixture metadata files. */
export function readFixtureFiles(fixtureDir: string): InventoryInputFile[] {
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
  return files;
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
  const files: InventoryInputFile[] = readFixtureFiles(fixtureDir);

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
  const m2Steps: PatchStep[] = [];
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
      m2Steps.push(m2Res.step as unknown as PatchStep);
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
    m2Steps,
    reportJson: {
      signals: allSignals,
      verdict,
      unknowns: uniqueUnknowns,
    },
  };
}

const PY_MANIFEST_RE = /(^|\/)(pyproject\.toml|setup\.py|requirements[^/]*\.txt|Pipfile)$/;

export interface PythonPlanData {
  steps: PatchStep[];
  labels: Record<string, "m1-clean" | "m1-partial">;
  unknowns: UnknownRecord[];
}

/** Runs the M1 engine (async: needs the tree-sitter wasm parser) over a fixture. */
export async function collectPythonPlan(fixtureDir: string): Promise<PythonPlanData> {
  const files = readFixtureFiles(fixtureDir);
  const inventory = scanInventory(files);
  const empty: PythonPlanData = { steps: [], labels: {}, unknowns: [] };
  if (!inventory.ok) return empty;

  const pythonFiles = inventory.scannedFiles.filter((sf) => isPythonFile(sf.path));
  if (pythonFiles.length === 0) return empty;

  await initPythonParser();

  const manifests = files
    .filter((f) => typeof f.content === "string" && PY_MANIFEST_RE.test(f.path))
    .map((f) => ({ path: f.path, content: f.content as string }));
  const declared = checkDeclaredPythonVersion(manifests);

  const steps: PatchStep[] = [];
  const labels: Record<string, "m1-clean" | "m1-partial"> = {};
  const unknowns: UnknownRecord[] = [];
  for (const sf of pythonFiles) {
    const content = typeof sf.content === "string" ? sf.content : "";
    const result = analyzePython(content, sf.path, { py2Only: declared.py2Only });
    labels[result.file] = result.label;
    unknowns.push(...result.unknowns);
    if (result.reverted || result.acceptedEdits.length > 0) {
      steps.push(result.step);
    }
  }
  return { steps, labels, unknowns };
}

interface FixtureRuntimePlan {
  targetRuntime: BundleTargetRuntime | null;
  lockCommands: Record<string, string>;
  m2Fired: boolean;
  removedDependencies: string[];
  driftedDependencies: Array<{
    name: string;
    declaredVersion: string;
    latestVersion: string;
    manifestDir: string;
  }>;
}

/** Derives the target runtime, lock commands and M5/M2 dependency facts. */
export function planFixtureRuntime(
  files: readonly InventoryInputFile[],
  registryJson: Record<string, unknown>,
  m2Fired: boolean
): FixtureRuntimePlan {
  const lockCommands: Record<string, string> = {};
  const removedDependencies: string[] = [];
  const driftedDependencies: FixtureRuntimePlan["driftedDependencies"] = [];
  let targetRuntime: BundleTargetRuntime | null = null;

  const pkgFile = files.find((f) => f.path === "package.json");
  let pkgJson: Record<string, unknown> = {};
  if (pkgFile && typeof pkgFile.content === "string") {
    try {
      pkgJson = JSON.parse(pkgFile.content) as Record<string, unknown>;
    } catch {
      pkgJson = {};
    }
  }

  const engines = pkgJson.engines as Record<string, unknown> | undefined;
  const engineNode = typeof engines?.node === "string" ? engines.node : null;
  if (m2Fired) {
    targetRuntime = { kind: "node", value: ">=22" };
  } else if (engineNode) {
    targetRuntime = { kind: "node", value: engineNode };
  }

  if (pkgFile) {
    lockCommands["."] = DEFAULT_NPM_LOCK_COMMAND;
    const deps = pkgJson.dependencies as Record<string, unknown> | undefined;
    if (m2Fired && deps && typeof deps["request"] === "string") {
      removedDependencies.push("request");
    }
    const m5Res = evaluateM5Dependencies(pkgJson, {
      registry: registryJson as never,
      filePath: "package.json",
      manifestDir: ".",
    });
    for (const dep of m5Res.driftedDependencies) {
      driftedDependencies.push({
        name: dep.name,
        declaredVersion: dep.declaredVersion,
        latestVersion: dep.latestVersion,
        manifestDir: dep.manifestDir ?? ".",
      });
    }
    driftedDependencies.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const pyproject = files.find((f) => f.path === "pyproject.toml");
  const hasPython = files.some((f) => f.path.endsWith(".py"));
  if (pyproject && typeof pyproject.content === "string") {
    const declared = checkDeclaredPythonVersion([
      { path: pyproject.path, content: pyproject.content },
    ]);
    if (declared.declared) {
      targetRuntime = targetRuntime ?? { kind: "python", value: declared.declared };
    }
    const poetry = /\[tool\.poetry\]/.test(pyproject.content);
    lockCommands["."] = poetry ? POETRY_LOCK_COMMAND : "unknown";
  } else if (hasPython && !targetRuntime) {
    targetRuntime = { kind: "unspecified", value: "unspecified" };
  }

  return {
    targetRuntime,
    lockCommands,
    m2Fired,
    removedDependencies,
    driftedDependencies,
  };
}

export interface BakedFixtureArtifacts {
  owner: string;
  repo: string;
  folderName: string;
  requirements: string;
  design: string;
  tasks: string;
  eventsNdjson: string;
  verifyResultJson: string;
}

/** Renders the Grimoire bundle and the deterministic golden artifacts for one fixture. */
export async function bakeFixtureArtifacts(
  fixtureDir: string,
  baked?: BakedFixtureOutput
): Promise<BakedFixtureArtifacts> {
  const result = baked ?? bakeFixture(fixtureDir);
  const meta: PinnedRepoMeta = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "meta.json"), "utf8")
  );
  const registryPath = path.join(fixtureDir, "registry.json");
  const registryJson: Record<string, unknown> = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, "utf8"))
    : {};

  const files = readFixtureFiles(fixtureDir);
  const python = await collectPythonPlan(fixtureDir);
  const runtime = planFixtureRuntime(files, registryJson, result.m2Steps.length > 0);

  const bundle = generateBundle({
    owner: result.owner,
    repo: result.repo,
    sha: meta.sha,
    asOf: meta.asOf,
    targetRuntime: runtime.targetRuntime,
    m2Fired: runtime.m2Fired,
    removedDependencies: runtime.removedDependencies,
    driftedDependencies: runtime.driftedDependencies,
    signals: result.reportJson.signals,
    steps: [...result.m2Steps, ...python.steps],
    unknowns: [...result.reportJson.unknowns, ...python.unknowns],
    pythonFileLabels: python.labels,
    lockCommands: runtime.lockCommands,
    preset: true,
  });

  // Deterministic event stream (no timestamps, Requirement 10.10 / P9).
  const events: string[] = [];
  result.reportJson.signals.forEach((signal, seq) => {
    events.push(
      JSON.stringify({
        seq,
        kind: "signal",
        ruleId: signal.ruleId,
        file: signal.file,
        line: signal.line,
        column: signal.column,
        matched: signal.matched,
        confidence: signal.confidence,
        manifestDir: signal.manifestDir,
      })
    );
  });
  events.push(
    JSON.stringify({
      seq: events.length,
      kind: "verdict",
      status: result.reportJson.verdict.status,
      deadReasons: result.reportJson.verdict.deadReasons,
      lifespanYears: result.reportJson.verdict.lifespanYears,
      yearsDead: result.reportJson.verdict.yearsDead,
    })
  );
  events.push(
    JSON.stringify({
      seq: events.length,
      kind: "gate.result",
      gate: "syntax",
      ok: true,
      files: bundle.patchSteps.map((step) => step.file),
      reasons: [],
    })
  );

  const revertedSteps = bundle.patchSteps.filter((step) => step.reverted).length;
  const verifyResult = {
    owner: result.owner,
    repo: result.repo,
    sha: meta.sha,
    gate: "syntax",
    ok: revertedSteps === 0,
    engineVersion: resolveEngineVersion(),
    signals: result.reportJson.signals.length,
    patchSteps: bundle.patchSteps.length,
    revertedSteps,
    unknowns: result.reportJson.unknowns.length + python.unknowns.length,
    pythonLabels: python.labels,
  };

  return {
    owner: result.owner,
    repo: result.repo,
    folderName: `${result.owner}-${result.repo}`,
    requirements: bundle.requirements,
    design: bundle.design,
    tasks: bundle.tasks,
    eventsNdjson: events.map((line) => line + "\n").join(""),
    verifyResultJson: JSON.stringify(verifyResult, null, 2) + "\n",
  };
}

export async function runBake(options?: BakeOptions): Promise<void> {
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

  const specsDir = options?.specsDir
    ? path.resolve(options.specsDir)
    : path.join(repoRoot, ".kiro", "specs", "resurrection");

  if (options?.check) {
    let hasDifference = false;

    for (const item of reposList) {
      const fixtureDir = path.join(fixturesDir, item.path);
      const result = bakeFixture(fixtureDir);
      const artifacts = await bakeFixtureArtifacts(fixtureDir, result);
      const goldenFolder = path.join(goldenDir, artifacts.folderName);
      const specFolder = path.join(specsDir, artifacts.folderName);

      const fresh: Array<[string, string]> = [
        [path.join(goldenFolder, "all.patch"), result.allPatch],
        [
          path.join(goldenFolder, "report.json"),
          JSON.stringify(result.reportJson, null, 2) + "\n",
        ],
        [path.join(goldenFolder, "events.ndjson"), artifacts.eventsNdjson],
        [
          path.join(goldenFolder, "verify-result.json"),
          artifacts.verifyResultJson,
        ],
        [path.join(specFolder, "requirements.md"), artifacts.requirements],
        [path.join(specFolder, "design.md"), artifacts.design],
        [path.join(specFolder, "tasks.md"), artifacts.tasks],
      ];

      for (const [target, content] of fresh) {
        if (!fs.existsSync(target)) {
          console.error(`Check failed: missing committed file ${target}`);
          hasDifference = true;
          continue;
        }
        if (fs.readFileSync(target, "utf8") !== content) {
          console.error(`Check failed: ${target} differs`);
          hasDifference = true;
        }
      }
    }

    if (hasDifference) {
      process.exitCode = 1;
      return;
    }
    console.log(
      "Check passed: golden files, events, verify result and the Grimoire bundle match byte for byte."
    );
    return;
  }

  // Normal mode: write the golden files and the Grimoire bundle.
  for (const item of reposList) {
    const fixtureDir = path.join(fixturesDir, item.path);
    const result = bakeFixture(fixtureDir);
    const artifacts = await bakeFixtureArtifacts(fixtureDir, result);
    const goldenFolder = path.join(goldenDir, artifacts.folderName);
    const specFolder = path.join(specsDir, artifacts.folderName);

    fs.mkdirSync(goldenFolder, { recursive: true });
    fs.mkdirSync(specFolder, { recursive: true });

    fs.writeFileSync(path.join(goldenFolder, "all.patch"), result.allPatch, "utf8");
    fs.writeFileSync(
      path.join(goldenFolder, "report.json"),
      JSON.stringify(result.reportJson, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(goldenFolder, "events.ndjson"),
      artifacts.eventsNdjson,
      "utf8"
    );
    fs.writeFileSync(
      path.join(goldenFolder, "verify-result.json"),
      artifacts.verifyResultJson,
      "utf8"
    );
    fs.writeFileSync(
      path.join(specFolder, "requirements.md"),
      artifacts.requirements,
      "utf8"
    );
    fs.writeFileSync(path.join(specFolder, "design.md"), artifacts.design, "utf8");
    fs.writeFileSync(path.join(specFolder, "tasks.md"), artifacts.tasks, "utf8");

    console.log(
      `Baked golden output and Grimoire bundle for ${artifacts.folderName} to ${goldenFolder} and ${specFolder}`
    );
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isCheck = argv.includes("--check");

  try {
    await runBake({ check: isCheck });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exitCode = 1;
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("bake.ts") ||
  process.argv[1]?.endsWith("bake.js");

if (isMain) {
  main();
}
