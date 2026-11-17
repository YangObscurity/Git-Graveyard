#!/usr/bin/env tsx
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ALLOWED_LICENSES = new Set<string>([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
]);

export const LOCK_FILE_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
] as const;

export const LOCK_FILE_SET = new Set<string>(LOCK_FILE_NAMES);

export const IGNORED_DIRECTORY_NAMES = new Set<string>([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".agent-ws",
  ".cache",
  ".kiro",
]);

export interface PinOptions {
  sourceDir: string;
  owner: string;
  repo: string;
  asof: string;
  license: string;
  registryFile: string;
  outDir?: string;
}

export interface PinResult {
  owner: string;
  repo: string;
  sha: string;
  asOf: string;
  license: string;
  targetDir: string;
  files: string[];
}

export interface ScannedFile {
  relPath: string;
  absPath: string;
  buffer: Buffer;
}

export interface CliArgs {
  local?: string;
  owner?: string;
  repo?: string;
  asof?: string;
  license?: string;
  registry?: string;
  github?: boolean;
  selftest?: boolean;
  outdir?: string;
  help?: boolean;
}

export function isDetectorFile(filename: string): boolean {
  if (filename === "package.json") return true;
  if (filename.endsWith(".js") && filename.length > 3) return true;
  if (filename.endsWith(".cjs") && filename.length > 4) return true;
  if (filename.endsWith(".mjs") && filename.length > 4) return true;
  if (filename.endsWith(".ts") && filename.length > 3) return true;
  if (filename.endsWith(".tsx") && filename.length > 4) return true;
  if (filename.endsWith(".jsx") && filename.length > 4) return true;
  if (filename === "webpack.config" || filename.startsWith("webpack.config.")) return true;
  if (LOCK_FILE_SET.has(filename)) return true;
  return false;
}

export function isLicenseFile(filename: string): boolean {
  return (
    filename === "LICENSE" ||
    filename === "LICENSE.md" ||
    filename === "LICENSE.txt" ||
    filename === "LICENCE"
  );
}

export function scanSourceTree(sourceDir: string): ScannedFile[] {
  const results: ScannedFile[] = [];

  function walk(currentDir: string, currentRel: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        walk(
          path.join(currentDir, entry.name),
          currentRel ? `${currentRel}/${entry.name}` : entry.name
        );
      } else if (entry.isFile()) {
        const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
        if (isDetectorFile(entry.name) || isLicenseFile(entry.name)) {
          const absPath = path.join(currentDir, entry.name);
          const buffer = fs.readFileSync(absPath);
          results.push({ relPath, absPath, buffer });
        }
      }
    }
  }

  walk(sourceDir, "");
  return results;
}

export function computeSha256(files: ScannedFile[]): string {
  const sorted = files.slice().sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );

  const hash = crypto.createHash("sha256");
  for (const f of sorted) {
    hash.update(f.relPath);
    hash.update("\0");
    hash.update(f.buffer);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function pinFixture(options: PinOptions): PinResult {
  const { sourceDir, owner, repo, asof, license, registryFile } = options;

  if (!ALLOWED_LICENSES.has(license)) {
    throw new Error(
      `Fixture refused: license "${license}" is not permitted. Permitted licenses: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause`
    );
  }

  const resolvedSourceDir = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedSourceDir) || !fs.statSync(resolvedSourceDir).isDirectory()) {
    throw new Error(`Source directory not found: ${resolvedSourceDir}`);
  }

  const resolvedRegistryFile = path.resolve(registryFile);
  if (!fs.existsSync(resolvedRegistryFile)) {
    throw new Error(`Registry file not found: ${resolvedRegistryFile}`);
  }

  let registryContent = "";
  let registryJson: unknown;
  try {
    registryContent = fs.readFileSync(resolvedRegistryFile, "utf8");
    registryJson = JSON.parse(registryContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in registry file: ${msg}`);
  }

  const scannedFiles = scanSourceTree(resolvedSourceDir);
  if (scannedFiles.length === 0) {
    throw new Error(`No detector-read files or LICENSE found in ${resolvedSourceDir}`);
  }

  const hasLicense = scannedFiles.some((f) => isLicenseFile(path.basename(f.relPath)));
  if (!hasLicense) {
    throw new Error(`LICENSE file not found in ${resolvedSourceDir}`);
  }

  const sha = computeSha256(scannedFiles);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const defaultOutDir = path.resolve(repoRoot, "test", "fixtures", "pinned");
  const targetOutDir = options.outDir ? path.resolve(options.outDir) : defaultOutDir;

  const folderName = `${owner}-${repo}@${sha}`;
  const fixtureDir = path.join(targetOutDir, folderName);
  fs.mkdirSync(fixtureDir, { recursive: true });

  const copiedFiles: string[] = [];
  for (const f of scannedFiles) {
    const destPath = path.join(fixtureDir, f.relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, f.buffer);
    copiedFiles.push(f.relPath);
  }

  let lastWords = "";
  const lastCommitPath = path.join(resolvedSourceDir, "LAST_COMMIT.txt");
  if (fs.existsSync(lastCommitPath)) {
    const rawCommit = fs.readFileSync(lastCommitPath, "utf8");
    const firstLine = rawCommit.split(/\r?\n/)[0] ?? "";
    lastWords = firstLine.trim();
  }

  const metaData = {
    owner,
    repo,
    sha,
    asOf: asof,
    stars: 0,
    lastWords,
    license,
  };

  fs.writeFileSync(
    path.join(fixtureDir, "meta.json"),
    JSON.stringify(metaData, null, 2) + "\n",
    "utf8"
  );

  fs.writeFileSync(
    path.join(fixtureDir, "registry.json"),
    JSON.stringify(registryJson, null, 2) + "\n",
    "utf8"
  );

  const reposJsonPath = path.join(targetOutDir, "repos.json");
  let reposList: any[] = [];
  let isObjectFormat = false;
  let reposObj: Record<string, any> = {};

  if (fs.existsSync(reposJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(reposJsonPath, "utf8"));
      if (Array.isArray(parsed)) {
        reposList = parsed;
      } else if (parsed && typeof parsed === "object") {
        isObjectFormat = true;
        reposObj = parsed;
      }
    } catch {
      reposList = [];
    }
  }

  const newRepoEntry = {
    owner,
    repo,
    sha,
    asOf: asof,
    license,
    path: folderName,
  };

  if (isObjectFormat) {
    const key = `${owner}/${repo}`;
    reposObj[key] = newRepoEntry;
    fs.writeFileSync(
      reposJsonPath,
      JSON.stringify(reposObj, null, 2) + "\n",
      "utf8"
    );
  } else {
    const existingIdx = reposList.findIndex(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        entry.owner === owner &&
        entry.repo === repo &&
        entry.sha === sha
    );
    if (existingIdx >= 0) {
      reposList[existingIdx] = newRepoEntry;
    } else {
      reposList.push(newRepoEntry);
    }
    fs.writeFileSync(
      reposJsonPath,
      JSON.stringify(reposList, null, 2) + "\n",
      "utf8"
    );
  }

  return {
    owner,
    repo,
    sha,
    asOf: asof,
    license,
    targetDir: fixtureDir,
    files: copiedFiles,
  };
}

export function runSelftest(): void {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pin-selftest-"));
  const tmpSrc = path.join(tmpBase, "src");
  const tmpOut = path.join(tmpBase, "out");
  const tmpRegistry = path.join(tmpBase, "registry.json");

  try {
    fs.mkdirSync(tmpSrc, { recursive: true });
    fs.mkdirSync(tmpOut, { recursive: true });

    // 1. Create source files
    fs.writeFileSync(
      path.join(tmpSrc, "package.json"),
      JSON.stringify({ name: "selftest-package", version: "1.0.0" }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpSrc, "index.ts"),
      "export const answer = 42;\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpSrc, "webpack.config.js"),
      "module.exports = {};\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpSrc, "package-lock.json"),
      JSON.stringify({ name: "selftest-package", lockfileVersion: 3 }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpSrc, "LICENSE"),
      "MIT License\n\nCopyright (c) 2026 Selftest\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpSrc, "LAST_COMMIT.txt"),
      "test: selftest commit message\nSecond line should be ignored\n",
      "utf8"
    );
    // Non-detector file that must not be copied
    fs.writeFileSync(
      path.join(tmpSrc, "README.md"),
      "# Non detector file\n",
      "utf8"
    );

    // Subdirectory with detector file
    fs.mkdirSync(path.join(tmpSrc, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "src", "util.cjs"),
      "module.exports = { util: true };\n",
      "utf8"
    );

    // 2. Create registry answers JSON
    const registryData = {
      express: { latest: "4.18.2" },
      react: { latest: "19.0.0" },
    };
    fs.writeFileSync(tmpRegistry, JSON.stringify(registryData, null, 2) + "\n", "utf8");

    // 3. Test license refusal
    let licenseRefused = false;
    try {
      pinFixture({
        sourceDir: tmpSrc,
        owner: "test-owner",
        repo: "test-repo",
        asof: "2026-11-08T00:00:00.000Z",
        license: "GPL-3.0",
        registryFile: tmpRegistry,
        outDir: tmpOut,
      });
    } catch {
      licenseRefused = true;
    }
    if (!licenseRefused) {
      throw new Error("Selftest failed: GPL-3.0 license was not refused");
    }

    // 4. Pin valid fixture
    const res = pinFixture({
      sourceDir: tmpSrc,
      owner: "test-owner",
      repo: "test-repo",
      asof: "2026-11-08T00:00:00.000Z",
      license: "MIT",
      registryFile: tmpRegistry,
      outDir: tmpOut,
    });

    if (!res.sha || typeof res.sha !== "string" || res.sha.length !== 64) {
      throw new Error(`Selftest failed: invalid sha "${res.sha}"`);
    }

    const expectedFolderName = `test-owner-test-repo@${res.sha}`;
    const fixtureFolder = path.join(tmpOut, expectedFolderName);
    if (!fs.existsSync(fixtureFolder)) {
      throw new Error(`Selftest failed: fixture folder ${expectedFolderName} not found`);
    }

    // Verify detector files exist at original paths
    const expectedFiles = [
      "package.json",
      "index.ts",
      "webpack.config.js",
      "package-lock.json",
      "LICENSE",
      path.join("src", "util.cjs"),
      "meta.json",
      "registry.json",
    ];
    for (const f of expectedFiles) {
      const fullPath = path.join(fixtureFolder, f);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Selftest failed: expected file missing: ${f}`);
      }
    }

    // Verify non-detector file is NOT copied
    if (fs.existsSync(path.join(fixtureFolder, "README.md"))) {
      throw new Error("Selftest failed: README.md was incorrectly copied");
    }

    // Verify meta.json content
    const metaParsed = JSON.parse(
      fs.readFileSync(path.join(fixtureFolder, "meta.json"), "utf8")
    );
    if (metaParsed.owner !== "test-owner") throw new Error("meta.json owner mismatch");
    if (metaParsed.repo !== "test-repo") throw new Error("meta.json repo mismatch");
    if (metaParsed.sha !== res.sha) throw new Error("meta.json sha mismatch");
    if (metaParsed.asOf !== "2026-11-08T00:00:00.000Z") throw new Error("meta.json asOf mismatch");
    if (metaParsed.stars !== 0) throw new Error("meta.json stars must be 0");
    if (metaParsed.lastWords !== "test: selftest commit message") {
      throw new Error(`meta.json lastWords mismatch: ${metaParsed.lastWords}`);
    }

    // Verify registry.json content
    const regParsed = JSON.parse(
      fs.readFileSync(path.join(fixtureFolder, "registry.json"), "utf8")
    );
    if (!regParsed.express || regParsed.express.latest !== "4.18.2") {
      throw new Error("registry.json content mismatch");
    }

    // Verify repos.json content
    const reposJsonPath = path.join(tmpOut, "repos.json");
    if (!fs.existsSync(reposJsonPath)) {
      throw new Error("repos.json was not created");
    }
    const reposData = JSON.parse(fs.readFileSync(reposJsonPath, "utf8"));
    if (!Array.isArray(reposData) || reposData.length !== 1) {
      throw new Error("repos.json should contain exactly one entry");
    }
    if (
      reposData[0].owner !== "test-owner" ||
      reposData[0].repo !== "test-repo" ||
      reposData[0].sha !== res.sha ||
      reposData[0].license !== "MIT"
    ) {
      throw new Error("repos.json entry content mismatch");
    }

    console.log("Selftest passed: fixture pinned and output shape verified.");
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--github") {
      args.github = true;
    } else if (arg === "--selftest") {
      args.selftest = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("--local=")) {
      args.local = arg.slice("--local=".length);
    } else if (arg === "--local" && i + 1 < argv.length) {
      args.local = argv[++i];
    } else if (arg.startsWith("--owner=")) {
      args.owner = arg.slice("--owner=".length);
    } else if (arg === "--owner" && i + 1 < argv.length) {
      args.owner = argv[++i];
    } else if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length);
    } else if (arg === "--repo" && i + 1 < argv.length) {
      args.repo = argv[++i];
    } else if (arg.startsWith("--asof=")) {
      args.asof = arg.slice("--asof=".length);
    } else if (arg === "--asof" && i + 1 < argv.length) {
      args.asof = argv[++i];
    } else if (arg.startsWith("--license=")) {
      args.license = arg.slice("--license=".length);
    } else if (arg === "--license" && i + 1 < argv.length) {
      args.license = argv[++i];
    } else if (arg.startsWith("--registry=")) {
      args.registry = arg.slice("--registry=".length);
    } else if (arg === "--registry" && i + 1 < argv.length) {
      args.registry = argv[++i];
    } else if (arg.startsWith("--outdir=")) {
      args.outdir = arg.slice("--outdir=".length);
    } else if (arg === "--outdir" && i + 1 < argv.length) {
      args.outdir = argv[++i];
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`Usage:
  pin.ts --local <sourceDir> --owner <owner> --repo <repo> --asof <ISO time> --license <SPDX id> --registry <json file>
  pin.ts --selftest
  pin.ts --github

Options:
  --local <dir>       Path to local source directory
  --owner <owner>     Repository owner name
  --repo <repo>       Repository name
  --asof <time>       ISO timestamp
  --license <id>      SPDX license id (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause)
  --registry <file>   JSON file containing frozen npm registry answers
  --outdir <dir>      Output fixtures directory (default: test/fixtures/pinned)
  --selftest          Run selftest verification without writing to 01_evidence
  --github            GitHub mode (not implemented yet)
  --help, -h          Show this help message`);
}

export function main(): void {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.github) {
    console.error("--github mode is not implemented yet");
    process.exit(1);
  }

  if (args.selftest) {
    try {
      runSelftest();
      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      process.exit(1);
    }
  }

  if (!args.local) {
    console.error("Error: --local <sourceDir> or --selftest required.");
    printUsage();
    process.exit(1);
  }

  const missing: string[] = [];
  if (!args.owner) missing.push("--owner");
  if (!args.repo) missing.push("--repo");
  if (!args.asof) missing.push("--asof");
  if (!args.license) missing.push("--license");
  if (!args.registry) missing.push("--registry");

  if (missing.length > 0) {
    console.error(`Error: Missing required arguments: ${missing.join(", ")}`);
    printUsage();
    process.exit(1);
  }

  try {
    const result = pinFixture({
      sourceDir: args.local,
      owner: args.owner!,
      repo: args.repo!,
      asof: args.asof!,
      license: args.license!,
      registryFile: args.registry!,
      outDir: args.outdir,
    });
    console.log(`Pinned fixture to ${result.targetDir}`);
    console.log(`SHA: ${result.sha}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("pin.ts") ||
  process.argv[1]?.endsWith("pin.js");

if (isMain) {
  main();
}
