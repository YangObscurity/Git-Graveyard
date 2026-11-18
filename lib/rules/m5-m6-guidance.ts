import { createRequire } from "node:module";
import type { Signal, RuleId, Confidence, UnknownRecord } from "../grimoire/types";

// Requirement 2.2 / 3.2: The six supported lock files
export const LOCK_FILE_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
] as const;

export type LockFileName = (typeof LOCK_FILE_NAMES)[number];
export const SUPPORTED_LOCK_FILES = LOCK_FILE_NAMES;

const LOCK_FILE_SET = new Set<string>(LOCK_FILE_NAMES);

// Requirement 8.9: Reason when registry lookup fails
export const REGISTRY_UNAVAILABLE_REASON = "registry_unavailable";

// Requirement 8.8: Reason for Python dependencies under M5
export const PYTHON_M5_UNKNOWN_REASON = "unknown";
export const PYTHON_UNKNOWN_REASON = "unknown";

// Try to load semver dynamically if available
const req = createRequire(import.meta.url);
let semverLib: any = null;
try {
  semverLib = req("semver");
} catch {
  semverLib = null;
}

export interface DriftedDependency {
  name: string;
  declaredVersion: string;
  latestVersion: string;
  declaredMajor: number;
  latestMajor: number;
  majorDrift: number;
  majorDiff: number;
  manifestDir: string;
  file: string;
  forced: boolean;
  targetVersion: string;
  [key: string]: unknown;
}

export type RegistryLookupResult =
  | string
  | { version?: string; latest?: string; [key: string]: unknown }
  | null
  | undefined;

export type RegistryLookupFn = (
  packageName: string
) => Promise<RegistryLookupResult> | RegistryLookupResult;

/**
 * Default offline registry lookup.
 * Requirement 8.9: Never calls the network in tests; returns null to trigger registry_unavailable.
 */
export const defaultOfflineRegistryLookup: RegistryLookupFn = () => null;

let globalRegistryLookup: RegistryLookupFn = defaultOfflineRegistryLookup;

export function setDefaultRegistryLookup(fn: RegistryLookupFn): void {
  globalRegistryLookup = fn;
}

export function resetDefaultRegistryLookup(): void {
  globalRegistryLookup = defaultOfflineRegistryLookup;
}

export function getDefaultRegistryLookup(): RegistryLookupFn {
  return globalRegistryLookup;
}

export type PackageJsonInput =
  | Record<string, unknown>
  | string
  | null
  | undefined;

export interface M5GuidanceOptions {
  /**
   * Injected registry lookup function.
   * If omitted, falls back to injected registry / registryMap or default offline lookup.
   */
  registryLookup?: RegistryLookupFn;

  /**
   * Static or snapshot registry answers (e.g. from registry.json).
   */
  registry?: Record<string, RegistryLookupResult>;
  registryMap?: Map<string, RegistryLookupResult> | Record<string, RegistryLookupResult>;
  registryJson?: Record<string, RegistryLookupResult>;

  /**
   * Requirement 8.7: Version bumps forced by other rules (e.g. M4 forcing vite).
   */
  forcedBumps?: Record<string, string>;
  forcedChanges?: Record<string, string>;
  forcedDependencies?: Record<string, string>;
  forceBump?: boolean | Record<string, boolean>;

  /**
   * Requirement 8.8: Language specification. When "python", M5 is recorded as unknown.
   */
  language?: "node" | "python" | string;
  isPython?: boolean;

  /**
   * Target manifest directory path, defaults to ".".
   */
  manifestDir?: string;
  manifestDirectory?: string;

  /**
   * Manifest file path, defaults to "package.json".
   */
  filePath?: string;
  file?: string;
  manifestPath?: string;

  /**
   * Output collector for unknown records.
   */
  unknowns?: UnknownRecord[];

  /**
   * Whether to evaluate devDependencies in package.json. Defaults to true.
   */
  includeDevDependencies?: boolean;

  /**
   * Direct dependency maps if not passing package.json.
   */
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface M5GuidanceResult {
  ruleId: "M5";
  driftedDependencies: DriftedDependency[];
  drifted: DriftedDependency[];
  driftedDeps: DriftedDependency[];
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageJson?: Record<string, unknown>;
  manifestChanged: boolean;
  unknowns: UnknownRecord[];
  report: string[];
  reportText: string;
}

export interface ManifestDirectoryLike {
  path?: string;
  manifestDir?: string;
  language?: string;
  manifests?: readonly string[];
  lockFiles?: readonly string[];
  hasLockFile?: boolean;
  files?: readonly string[];
  [key: string]: unknown;
}

export interface M6GuidanceOptions {
  manifestDir?: string;
  manifestDirectory?: string;
  manifestDirectories?: readonly ManifestDirectoryLike[];
  directories?: readonly ManifestDirectoryLike[];
  manifestDirs?: readonly string[];
  files?: readonly unknown[] | Iterable<unknown>;
  lockFiles?: readonly string[];
  manifests?: readonly string[];
  confidence?: Confidence;
  unknowns?: UnknownRecord[];
  filePath?: string;
  file?: string;
  matched?: string;
}

export interface M6GuidanceResult {
  ruleId: "M6";
  signals: Signal[];
  manifestDirectoriesWithoutLock: string[];
  missingLockDirs: string[];
  unknowns: UnknownRecord[];
}

export interface M5M6GuidanceResult {
  m5: M5GuidanceResult;
  m6: M6GuidanceResult;
  signals: Signal[];
  unknowns: UnknownRecord[];
  driftedDependencies: DriftedDependency[];
}

function normalizePath(p: string): string {
  if (typeof p !== "string") return "";
  let norm = p.replace(/\\/g, "/");
  norm = norm.replace(/^\.?\/+/, "");
  norm = norm.replace(/\/+/g, "/");
  return norm.replace(/\/+$/, "");
}

function getBasename(filePath: string): string {
  if (typeof filePath !== "string") return "";
  const norm = normalizePath(filePath);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function getDirectory(filePath: string): string {
  if (typeof filePath !== "string") return ".";
  const norm = normalizePath(filePath);
  const idx = norm.lastIndexOf("/");
  if (idx === -1) return ".";
  const dir = norm.slice(0, idx);
  return dir.length === 0 ? "." : dir;
}

/**
 * Checks whether a given filename or path is one of the six supported lock files.
 * Requirement 2.2 / 3.2.
 */
export function isSupportedLockFile(filenameOrPath: string): boolean {
  if (typeof filenameOrPath !== "string") return false;
  const basename = getBasename(filenameOrPath);
  return LOCK_FILE_SET.has(basename);
}

export const isLockFile = isSupportedLockFile;

/**
 * Checks whether an array of filenames contains at least one supported lock file.
 */
export function hasSupportedLockFile(fileList: readonly string[]): boolean {
  if (!Array.isArray(fileList)) return false;
  return fileList.some((f) => isSupportedLockFile(f));
}

/**
 * Parses the major version integer from a declared semver range or version string.
 * Supports carets, tildes, operators, npm aliases, and simple version strings.
 * Returns null if the major version cannot be determined.
 */
export function parseMajorVersion(versionStr: unknown): number | null {
  if (typeof versionStr !== "string") return null;
  const cleaned = versionStr.trim();
  if (!cleaned || cleaned === "*" || cleaned === "latest") return null;

  // Handle npm alias: npm:pkg@^1.2.3
  const aliasMatch = cleaned.match(/^npm:[^@]+@(.*)$/);
  const target = aliasMatch ? aliasMatch[1].trim() : cleaned;

  if (semverLib) {
    try {
      const min = semverLib.minVersion(target);
      if (min && typeof min.major === "number") return min.major;
    } catch {
      // ignore
    }

    try {
      const coerced = semverLib.coerce(target);
      if (coerced && typeof coerced.major === "number") return coerced.major;
    } catch {
      // ignore
    }
  }

  // Regex fallback: find the first number sequence
  const match = target.match(/(?:^|[^\d])(\d+)(?:\.\d+)?/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (!Number.isNaN(num)) return num;
  }

  return null;
}

/**
 * Evaluates whether a declared version is at least minDrift (default: 2) major versions behind latest.
 * Requirement 8.6: "major version is at least 2 behind the latest registry version".
 */
export function isMajorDrifted(
  declaredVersion: unknown,
  latestVersion: unknown,
  minDrift: number = 2
): {
  isDrifted: boolean;
  declaredMajor: number | null;
  latestMajor: number | null;
  majorDrift: number | null;
} {
  const declaredMajor = parseMajorVersion(declaredVersion);
  const latestMajor = parseMajorVersion(latestVersion);

  if (declaredMajor === null || latestMajor === null) {
    return {
      isDrifted: false,
      declaredMajor,
      latestMajor,
      majorDrift: null,
    };
  }

  const majorDrift = latestMajor - declaredMajor;
  return {
    isDrifted: majorDrift >= minDrift,
    declaredMajor,
    latestMajor,
    majorDrift,
  };
}

export function isDrifted(
  declaredVersion: unknown,
  latestVersion: unknown,
  minDrift: number = 2
): boolean {
  return isMajorDrifted(declaredVersion, latestVersion, minDrift).isDrifted;
}

function extractVersionFromLookupResult(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.version === "string" && obj.version.trim()) {
      return obj.version.trim();
    }
    if (typeof obj.latest === "string" && obj.latest.trim()) {
      return obj.latest.trim();
    }
    const distTags = obj["dist-tags"];
    if (distTags && typeof distTags === "object") {
      const dtLatest = (distTags as Record<string, unknown>).latest;
      if (typeof dtLatest === "string" && dtLatest.trim()) {
        return dtLatest.trim();
      }
    }
  }
  return null;
}

function resolveRegistryVersionSync(
  pkgName: string,
  options?: M5GuidanceOptions
): { resolved: boolean; version: string | null } {
  // 1. Check options.registryMap
  if (options?.registryMap) {
    const map = options.registryMap;
    if (map instanceof Map && map.has(pkgName)) {
      return { resolved: true, version: extractVersionFromLookupResult(map.get(pkgName)) };
    }
    if (typeof map === "object" && pkgName in map) {
      return { resolved: true, version: extractVersionFromLookupResult((map as Record<string, unknown>)[pkgName]) };
    }
  }

  // 2. Check options.registry
  if (options?.registry && typeof options.registry === "object" && pkgName in options.registry) {
    return { resolved: true, version: extractVersionFromLookupResult(options.registry[pkgName]) };
  }

  // 3. Check options.registryJson
  if (options?.registryJson && typeof options.registryJson === "object" && pkgName in options.registryJson) {
    return { resolved: true, version: extractVersionFromLookupResult(options.registryJson[pkgName]) };
  }

  // 4. Check options.registryLookup
  const lookupFn = options?.registryLookup ?? globalRegistryLookup;
  if (lookupFn) {
    try {
      const res = lookupFn(pkgName);
      if (res instanceof Promise) {
        // Handled in async resolver; for sync resolution, we cannot await
        return { resolved: false, version: null };
      }
      return { resolved: true, version: extractVersionFromLookupResult(res) };
    } catch {
      return { resolved: true, version: null };
    }
  }

  return { resolved: false, version: null };
}

async function resolveRegistryVersionAsync(
  pkgName: string,
  options?: M5GuidanceOptions
): Promise<string | null> {
  // 1. Check sync options first
  const syncRes = resolveRegistryVersionSync(pkgName, options);
  if (syncRes.resolved) {
    return syncRes.version;
  }

  // 2. Call lookupFn asynchronously
  const lookupFn = options?.registryLookup ?? globalRegistryLookup;
  if (lookupFn) {
    try {
      const res = await lookupFn(pkgName);
      return extractVersionFromLookupResult(res);
    } catch {
      return null;
    }
  }

  return null;
}

function parsePackageJson(input: PackageJsonInput): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return { ...input };
  }
  return {};
}

function isForcedBump(
  depName: string,
  options?: M5GuidanceOptions
): { isForced: boolean; forcedVersion?: string } {
  if (!options) return { isForced: false };

  if (options.forcedBumps && typeof options.forcedBumps === "object" && depName in options.forcedBumps) {
    return { isForced: true, forcedVersion: options.forcedBumps[depName] };
  }
  if (options.forcedChanges && typeof options.forcedChanges === "object" && depName in options.forcedChanges) {
    return { isForced: true, forcedVersion: options.forcedChanges[depName] };
  }
  if (options.forcedDependencies && typeof options.forcedDependencies === "object" && depName in options.forcedDependencies) {
    return { isForced: true, forcedVersion: options.forcedDependencies[depName] };
  }
  if (options.forceBump === true) {
    return { isForced: true };
  }
  if (typeof options.forceBump === "object" && options.forceBump !== null && (options.forceBump as Record<string, boolean>)[depName] === true) {
    return { isForced: true };
  }

  return { isForced: false };
}

/**
 * Requirement 8.8: Record M5 for Python dependencies as unknown.
 */
export function recordPythonM5Unknown(options?: M5GuidanceOptions): UnknownRecord {
  const filePath = options?.file ?? options?.filePath ?? options?.manifestPath ?? "requirements.txt";
  const record: UnknownRecord = {
    ruleId: "M5",
    reason: PYTHON_M5_UNKNOWN_REASON,
    file: filePath,
    line: 1,
  };
  if (options?.unknowns) {
    options.unknowns.push(record);
  }
  return record;
}

/**
 * Evaluates Python dependencies under M5.
 * Requirement 8.8: When evaluating Python dependencies under M5, THE Grimoire SHALL record M5
 * for Python dependencies as unknown.
 */
export function evaluatePythonM5(options?: M5GuidanceOptions): M5GuidanceResult {
  const record = recordPythonM5Unknown(options);
  const reportLine = "M5: Python dependencies recorded as unknown (no package index lookup chosen in v1)";
  return {
    ruleId: "M5",
    driftedDependencies: [],
    drifted: [],
    driftedDeps: [],
    dependencies: {},
    manifestChanged: false,
    unknowns: [record],
    report: [reportLine],
    reportText: reportLine,
  };
}

/**
 * Formats human-readable report lines for drifted dependencies.
 * Requirement 8.6: List the dependency in the report.
 */
export function formatM5Report(drifted: readonly DriftedDependency[]): string[] {
  if (!Array.isArray(drifted) || drifted.length === 0) {
    return [];
  }
  return drifted.map((d) => {
    return `${d.name}: declared ${d.declaredVersion} (v${d.declaredMajor}) is ${d.majorDrift} major versions behind registry latest ${d.latestVersion} (v${d.latestMajor})`;
  });
}

export const reportM5Drift = formatM5Report;

function evaluateDependencyMapSync(
  deps: Record<string, string>,
  options: M5GuidanceOptions,
  manifestDir: string,
  manifestFile: string
): {
  driftedList: DriftedDependency[];
  updatedDeps: Record<string, string>;
  unknownsList: UnknownRecord[];
  changed: boolean;
} {
  const driftedList: DriftedDependency[] = [];
  const updatedDeps: Record<string, string> = { ...deps };
  const unknownsList: UnknownRecord[] = [];
  let changed = false;

  for (const [depName, declaredVersion] of Object.entries(deps)) {
    if (typeof declaredVersion !== "string") continue;

    const declaredMajor = parseMajorVersion(declaredVersion);
    if (declaredMajor === null) {
      // Wildcard, local file, git or unparseable: keep unchanged
      continue;
    }

    const { resolved, version: latestVersion } = resolveRegistryVersionSync(depName, options);

    if (!resolved || !latestVersion) {
      // Requirement 8.9: On a failed lookup, keep the old version and record unknown with reason registry_unavailable
      const unknownRecord: UnknownRecord = {
        ruleId: "M5",
        reason: REGISTRY_UNAVAILABLE_REASON,
        file: manifestFile,
        line: 1,
      };
      unknownsList.push(unknownRecord);
      if (options.unknowns) {
        options.unknowns.push(unknownRecord);
      }
      continue;
    }

    const latestMajor = parseMajorVersion(latestVersion);
    if (latestMajor === null) {
      continue;
    }

    const majorDrift = latestMajor - declaredMajor;

    // Requirement 8.6: 2 or more major versions behind
    if (majorDrift >= 2) {
      const forcedCheck = isForcedBump(depName, options);
      const isForced = forcedCheck.isForced;
      let targetVersion = declaredVersion;

      if (isForced) {
        // Requirement 8.7: Apply version bump only when another rule forces the bump
        targetVersion = forcedCheck.forcedVersion ?? `^${latestVersion}`;
        updatedDeps[depName] = targetVersion;
        changed = true;
      }

      const item: DriftedDependency = {
        name: depName,
        declaredVersion,
        latestVersion,
        declaredMajor,
        latestMajor,
        majorDrift,
        majorDiff: majorDrift,
        manifestDir,
        file: manifestFile,
        forced: isForced,
        targetVersion,
      };
      driftedList.push(item);
    }
  }

  return { driftedList, updatedDeps, unknownsList, changed };
}

async function evaluateDependencyMapAsync(
  deps: Record<string, string>,
  options: M5GuidanceOptions,
  manifestDir: string,
  manifestFile: string
): Promise<{
  driftedList: DriftedDependency[];
  updatedDeps: Record<string, string>;
  unknownsList: UnknownRecord[];
  changed: boolean;
}> {
  const driftedList: DriftedDependency[] = [];
  const updatedDeps: Record<string, string> = { ...deps };
  const unknownsList: UnknownRecord[] = [];
  let changed = false;

  for (const [depName, declaredVersion] of Object.entries(deps)) {
    if (typeof declaredVersion !== "string") continue;

    const declaredMajor = parseMajorVersion(declaredVersion);
    if (declaredMajor === null) {
      continue;
    }

    const latestVersion = await resolveRegistryVersionAsync(depName, options);

    if (!latestVersion) {
      // Requirement 8.9: On a failed lookup, keep old version and record registry_unavailable
      const unknownRecord: UnknownRecord = {
        ruleId: "M5",
        reason: REGISTRY_UNAVAILABLE_REASON,
        file: manifestFile,
        line: 1,
      };
      unknownsList.push(unknownRecord);
      if (options.unknowns) {
        options.unknowns.push(unknownRecord);
      }
      continue;
    }

    const latestMajor = parseMajorVersion(latestVersion);
    if (latestMajor === null) {
      continue;
    }

    const majorDrift = latestMajor - declaredMajor;

    // Requirement 8.6: 2 or more major versions behind
    if (majorDrift >= 2) {
      const forcedCheck = isForcedBump(depName, options);
      const isForced = forcedCheck.isForced;
      let targetVersion = declaredVersion;

      if (isForced) {
        // Requirement 8.7: Apply version bump only when another rule forces the bump
        targetVersion = forcedCheck.forcedVersion ?? `^${latestVersion}`;
        updatedDeps[depName] = targetVersion;
        changed = true;
      }

      const item: DriftedDependency = {
        name: depName,
        declaredVersion,
        latestVersion,
        declaredMajor,
        latestMajor,
        majorDrift,
        majorDiff: majorDrift,
        manifestDir,
        file: manifestFile,
        forced: isForced,
        targetVersion,
      };
      driftedList.push(item);
    }
  }

  return { driftedList, updatedDeps, unknownsList, changed };
}

/**
 * Evaluates M5 dependency version drift for Node dependencies.
 * Requirement 8.6: List dependencies 2 or more major versions behind, leave declared version unchanged.
 * Requirement 8.7: Apply bump only when another rule forces it.
 * Requirement 8.8: Python dependencies recorded as unknown.
 * Requirement 8.9: Failed lookup records unknown with reason registry_unavailable.
 */
export function evaluateM5Dependencies(
  pkgInput?: PackageJsonInput,
  options?: M5GuidanceOptions
): M5GuidanceResult {
  const opts = options ?? {};

  // Check Python
  if (
    opts.language === "python" ||
    opts.isPython === true ||
    (typeof opts.filePath === "string" && (opts.filePath.endsWith(".py") || opts.filePath.includes("requirements"))) ||
    (typeof opts.file === "string" && (opts.file.endsWith(".py") || opts.file.includes("requirements")))
  ) {
    return evaluatePythonM5(opts);
  }

  const manifestDir = opts.manifestDir ?? opts.manifestDirectory ?? ".";
  const manifestFile =
    opts.filePath ??
    opts.file ??
    opts.manifestPath ??
    (manifestDir === "." ? "package.json" : `${manifestDir}/package.json`);

  const pkg = parsePackageJson(pkgInput);

  // Collect dependencies
  let deps: Record<string, string> = {};
  if (opts.dependencies && typeof opts.dependencies === "object") {
    deps = { ...opts.dependencies };
  } else if (pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies)) {
    deps = { ...(pkg.dependencies as Record<string, string>) };
  }

  // Collect devDependencies if enabled
  const includeDev = opts.includeDevDependencies ?? true;
  let devDeps: Record<string, string> | undefined = undefined;
  if (opts.devDependencies && typeof opts.devDependencies === "object") {
    devDeps = { ...opts.devDependencies };
  } else if (includeDev && pkg.devDependencies && typeof pkg.devDependencies === "object" && !Array.isArray(pkg.devDependencies)) {
    devDeps = { ...(pkg.devDependencies as Record<string, string>) };
  }

  const { driftedList: driftedDeps, updatedDeps, unknownsList: depUnknowns, changed: depsChanged } =
    evaluateDependencyMapSync(deps, opts, manifestDir, manifestFile);

  let driftedDev: DriftedDependency[] = [];
  let updatedDev: Record<string, string> | undefined = undefined;
  let devUnknowns: UnknownRecord[] = [];
  let devChanged = false;

  if (devDeps) {
    const res = evaluateDependencyMapSync(devDeps, opts, manifestDir, manifestFile);
    driftedDev = res.driftedList;
    updatedDev = res.updatedDeps;
    devUnknowns = res.unknownsList;
    devChanged = res.changed;
  }

  const allDrifted = [...driftedDeps, ...driftedDev];
  const allUnknowns = [...depUnknowns, ...devUnknowns];
  const manifestChanged = depsChanged || devChanged;

  const updatedPkg = { ...pkg };
  if (Object.keys(updatedDeps).length > 0 || "dependencies" in pkg) {
    updatedPkg.dependencies = updatedDeps;
  }
  if (updatedDev !== undefined) {
    updatedPkg.devDependencies = updatedDev;
  }

  const report = formatM5Report(allDrifted);

  return {
    ruleId: "M5",
    driftedDependencies: allDrifted,
    drifted: allDrifted,
    driftedDeps: allDrifted,
    dependencies: updatedDeps,
    devDependencies: updatedDev,
    packageJson: updatedPkg,
    manifestChanged,
    unknowns: allUnknowns,
    report,
    reportText: report.join("\n"),
  };
}

/**
 * Asynchronous version of evaluateM5Dependencies supporting async registry lookup functions.
 */
export async function evaluateM5DependenciesAsync(
  pkgInput?: PackageJsonInput,
  options?: M5GuidanceOptions
): Promise<M5GuidanceResult> {
  const opts = options ?? {};

  // Check Python
  if (
    opts.language === "python" ||
    opts.isPython === true ||
    (typeof opts.filePath === "string" && (opts.filePath.endsWith(".py") || opts.filePath.includes("requirements"))) ||
    (typeof opts.file === "string" && (opts.file.endsWith(".py") || opts.file.includes("requirements")))
  ) {
    return evaluatePythonM5(opts);
  }

  const manifestDir = opts.manifestDir ?? opts.manifestDirectory ?? ".";
  const manifestFile =
    opts.filePath ??
    opts.file ??
    opts.manifestPath ??
    (manifestDir === "." ? "package.json" : `${manifestDir}/package.json`);

  const pkg = parsePackageJson(pkgInput);

  let deps: Record<string, string> = {};
  if (opts.dependencies && typeof opts.dependencies === "object") {
    deps = { ...opts.dependencies };
  } else if (pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies)) {
    deps = { ...(pkg.dependencies as Record<string, string>) };
  }

  const includeDev = opts.includeDevDependencies ?? true;
  let devDeps: Record<string, string> | undefined = undefined;
  if (opts.devDependencies && typeof opts.devDependencies === "object") {
    devDeps = { ...opts.devDependencies };
  } else if (includeDev && pkg.devDependencies && typeof pkg.devDependencies === "object" && !Array.isArray(pkg.devDependencies)) {
    devDeps = { ...(pkg.devDependencies as Record<string, string>) };
  }

  const { driftedList: driftedDeps, updatedDeps, unknownsList: depUnknowns, changed: depsChanged } =
    await evaluateDependencyMapAsync(deps, opts, manifestDir, manifestFile);

  let driftedDev: DriftedDependency[] = [];
  let updatedDev: Record<string, string> | undefined = undefined;
  let devUnknowns: UnknownRecord[] = [];
  let devChanged = false;

  if (devDeps) {
    const res = await evaluateDependencyMapAsync(devDeps, opts, manifestDir, manifestFile);
    driftedDev = res.driftedList;
    updatedDev = res.updatedDeps;
    devUnknowns = res.unknownsList;
    devChanged = res.changed;
  }

  const allDrifted = [...driftedDeps, ...driftedDev];
  const allUnknowns = [...depUnknowns, ...devUnknowns];
  const manifestChanged = depsChanged || devChanged;

  const updatedPkg = { ...pkg };
  if (Object.keys(updatedDeps).length > 0 || "dependencies" in pkg) {
    updatedPkg.dependencies = updatedDeps;
  }
  if (updatedDev !== undefined) {
    updatedPkg.devDependencies = updatedDev;
  }

  const report = formatM5Report(allDrifted);

  return {
    ruleId: "M5",
    driftedDependencies: allDrifted,
    drifted: allDrifted,
    driftedDeps: allDrifted,
    dependencies: updatedDeps,
    devDependencies: updatedDev,
    packageJson: updatedPkg,
    manifestChanged,
    unknowns: allUnknowns,
    report,
    reportText: report.join("\n"),
  };
}

export function getM5Guidance(
  pkgInput?: PackageJsonInput,
  options?: M5GuidanceOptions
): M5GuidanceResult {
  return evaluateM5Dependencies(pkgInput, options);
}

export const getM5GuidanceAsync = evaluateM5DependenciesAsync;
export const evaluateM5 = evaluateM5Dependencies;
export const detectM5Drift = evaluateM5Dependencies;

function getPrimaryManifestFile(dir: ManifestDirectoryLike): string {
  if (Array.isArray(dir.manifests) && dir.manifests.length > 0) {
    const first = dir.manifests[0];
    if (typeof first === "string" && first.trim()) {
      return normalizePath(first);
    }
  }

  const d = normalizePath(dir.path ?? dir.manifestDir ?? ".");
  const isPython = dir.language === "python";
  const defaultManifest = isPython ? "requirements.txt" : "package.json";
  return d === "." || d === "" ? defaultManifest : `${d}/${defaultManifest}`;
}

/**
 * Evaluates whether a manifest directory lacks all six supported lock files.
 * Requirement 8.10: WHEN a Manifest_Directory has no lock file from any package manager
 * in the lock file list, THE Grimoire SHALL emit an M6 Signal for that directory.
 */
export function evaluateM6(
  manifestDir: string | ManifestDirectoryLike,
  lockFiles?: readonly string[],
  options?: M6GuidanceOptions
): Signal | null {
  let dirPath = ".";
  let locks: readonly string[] = lockFiles ?? [];
  let manifests: readonly string[] = [];
  let hasLock = false;

  if (typeof manifestDir === "string") {
    dirPath = normalizePath(manifestDir);
    if (!dirPath) dirPath = ".";
  } else if (manifestDir && typeof manifestDir === "object") {
    dirPath = normalizePath(manifestDir.path ?? manifestDir.manifestDir ?? ".");
    if (!dirPath) dirPath = ".";
    if (manifestDir.hasLockFile === true) {
      hasLock = true;
    }
    if (Array.isArray(manifestDir.lockFiles)) {
      locks = manifestDir.lockFiles;
    }
    if (Array.isArray(manifestDir.manifests)) {
      manifests = manifestDir.manifests;
    }
  }

  if (options?.lockFiles && Array.isArray(options.lockFiles)) {
    locks = options.lockFiles;
  }

  if (hasLock || hasSupportedLockFile(locks)) {
    return null;
  }

  const file =
    options?.file ??
    options?.filePath ??
    (manifests.length > 0
      ? normalizePath(manifests[0])
      : dirPath === "."
      ? "package.json"
      : `${dirPath}/package.json`);

  const signal: Signal = {
    ruleId: "M6",
    file,
    line: 1,
    column: 1,
    matched: options?.matched ?? "missing lock file",
    confidence: options?.confidence ?? "high",
    manifestDir: dirPath,
  };

  return signal;
}

export const emitM6Signal = evaluateM6;

/**
 * Emits an M6 Signal for every manifest directory that has none of the six lock files.
 * Requirement 8.10 / Requirement 2.2 / 3.2.
 */
export function detectM6Signals(
  input?: unknown,
  options?: M6GuidanceOptions
): Signal[] {
  const signals: Signal[] = [];
  const opts = options ?? {};

  // Case 1: manifestDirectories passed in input or options
  let dirList: ManifestDirectoryLike[] = [];

  if (Array.isArray(input)) {
    // Check if input is array of ManifestDirectoryLike or array of files
    if (input.length > 0 && typeof input[0] === "object" && input[0] !== null && ("hasLockFile" in input[0] || "manifests" in input[0] || "lockFiles" in input[0])) {
      dirList = input as ManifestDirectoryLike[];
    } else {
      // Input is array of files/paths: group into directories
      return detectM6SignalsFromFiles(input, opts);
    }
  } else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.manifestDirectories)) {
      dirList = obj.manifestDirectories as ManifestDirectoryLike[];
    } else if (Array.isArray(obj.directories)) {
      dirList = obj.directories as ManifestDirectoryLike[];
    } else if (Array.isArray(obj.files) || Array.isArray(obj.scannedFiles)) {
      const files = (obj.files ?? obj.scannedFiles) as readonly unknown[];
      return detectM6SignalsFromFiles(files, opts);
    } else if ("path" in obj || "manifestDir" in obj || "lockFiles" in obj) {
      dirList = [obj as ManifestDirectoryLike];
    }
  }

  if (dirList.length === 0 && Array.isArray(opts.manifestDirectories)) {
    dirList = opts.manifestDirectories as ManifestDirectoryLike[];
  }
  if (dirList.length === 0 && Array.isArray(opts.directories)) {
    dirList = opts.directories as ManifestDirectoryLike[];
  }
  if (dirList.length === 0 && Array.isArray(opts.manifestDirs)) {
    dirList = opts.manifestDirs.map((d) => ({ path: d, manifests: [], lockFiles: [] }));
  }

  // If dirList is still empty and opts.files is provided
  if (dirList.length === 0 && opts.files) {
    const rawFiles = Array.isArray(opts.files) ? opts.files : Array.from(opts.files as any);
    return detectM6SignalsFromFiles(rawFiles, opts);
  }

  // If single directory check via options
  if (dirList.length === 0 && (opts.manifestDir || opts.manifestDirectory)) {
    const sig = evaluateM6(opts.manifestDir ?? opts.manifestDirectory ?? ".", opts.lockFiles, opts);
    return sig ? [sig] : [];
  }

  for (const dir of dirList) {
    const sig = evaluateM6(dir, undefined, opts);
    if (sig) {
      signals.push(sig);
    }
  }

  return signals;
}

function detectM6SignalsFromFiles(
  files: readonly unknown[],
  options?: M6GuidanceOptions
): Signal[] {
  const lockFilesByDir = new Map<string, string[]>();
  const manifestDirs = new Set<string>();
  const manifestsByDir = new Map<string, string[]>();

  for (const item of files) {
    let p = "";
    if (typeof item === "string") {
      p = item;
    } else if (item && typeof item === "object" && typeof (item as any).path === "string") {
      p = (item as any).path;
    }
    if (!p) continue;

    const norm = normalizePath(p);
    const basename = getBasename(norm);
    const dir = getDirectory(norm);

    if (isSupportedLockFile(basename)) {
      const list = lockFilesByDir.get(dir) ?? [];
      list.push(norm);
      lockFilesByDir.set(dir, list);
    }

    if (
      basename === "package.json" ||
      basename === "setup.py" ||
      basename === "pyproject.toml" ||
      basename === "Pipfile" ||
      (basename.startsWith("requirements") && basename.endsWith(".txt"))
    ) {
      manifestDirs.add(dir);
      const list = manifestsByDir.get(dir) ?? [];
      list.push(norm);
      manifestsByDir.set(dir, list);
    }
  }

  const signals: Signal[] = [];
  const sortedDirs = Array.from(manifestDirs).sort();

  for (const dir of sortedDirs) {
    const locks = lockFilesByDir.get(dir) ?? [];
    if (!hasSupportedLockFile(locks)) {
      const manifests = manifestsByDir.get(dir) ?? [];
      const primaryFile =
        manifests.length > 0
          ? manifests[0]
          : dir === "."
          ? "package.json"
          : `${dir}/package.json`;

      signals.push({
        ruleId: "M6",
        file: primaryFile,
        line: 1,
        column: 1,
        matched: options?.matched ?? "missing lock file",
        confidence: options?.confidence ?? "high",
        manifestDir: dir,
      });
    }
  }

  return signals;
}

/**
 * Returns M6 Guidance including emitted signals and directories without lock files.
 */
export function getM6Guidance(
  input?: unknown,
  options?: M6GuidanceOptions
): M6GuidanceResult {
  const signals = detectM6Signals(input, options);
  const manifestDirectoriesWithoutLock = signals.map((s) => s.manifestDir);

  return {
    ruleId: "M6",
    signals,
    manifestDirectoriesWithoutLock,
    missingLockDirs: manifestDirectoriesWithoutLock,
    unknowns: options?.unknowns ?? [],
  };
}

export const checkMissingLockFiles = detectM6Signals;
export const evaluateM6Directory = evaluateM6;

/**
 * Combined M5 and M6 guidance.
 */
export function getM5M6Guidance(
  options?: M5GuidanceOptions & M6GuidanceOptions & { pkgInput?: PackageJsonInput; input?: unknown }
): M5M6GuidanceResult {
  const m5 = evaluateM5Dependencies(options?.pkgInput, options);
  const m6 = getM6Guidance(options?.input ?? options?.manifestDirectories, options);

  const combinedUnknowns = [...m5.unknowns, ...m6.unknowns];

  return {
    m5,
    m6,
    signals: m6.signals,
    unknowns: combinedUnknowns,
    driftedDependencies: m5.driftedDependencies,
  };
}

export default {
  LOCK_FILE_NAMES,
  SUPPORTED_LOCK_FILES,
  REGISTRY_UNAVAILABLE_REASON,
  PYTHON_M5_UNKNOWN_REASON,
  PYTHON_UNKNOWN_REASON,
  defaultOfflineRegistryLookup,
  setDefaultRegistryLookup,
  resetDefaultRegistryLookup,
  getDefaultRegistryLookup,
  isSupportedLockFile,
  isLockFile,
  hasSupportedLockFile,
  parseMajorVersion,
  isMajorDrifted,
  isDrifted,
  formatM5Report,
  reportM5Drift,
  recordPythonM5Unknown,
  evaluatePythonM5,
  evaluateM5Dependencies,
  evaluateM5DependenciesAsync,
  getM5Guidance,
  getM5GuidanceAsync,
  evaluateM5,
  detectM5Drift,
  evaluateM6,
  emitM6Signal,
  detectM6Signals,
  getM6Guidance,
  checkMissingLockFiles,
  evaluateM6Directory,
  getM5M6Guidance,
};
