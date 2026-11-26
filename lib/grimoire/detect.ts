import type { UnknownRecord } from "./types";

export type Language = "node" | "python";

export interface InventoryInputFile {
  path: string;
  content?: string;
  [key: string]: unknown;
}

export interface ScannedFile {
  path: string;
  content?: string;
  manifestDir: string;
  manifestDirectory?: string;
  language?: Language;
  [key: string]: unknown;
}

export interface ManifestDirectory {
  path: string;
  language: Language;
  manifests: string[];
  lockFiles: string[];
  hasLockFile: boolean;
  files: string[];
}

export interface InventorySummary {
  manifests: string[];
  lockFiles: string[];
  totalFiles: number;
  scannedFiles: number;
  directoriesCount: number;
}

export interface ScanInventorySuccess {
  readonly ok: true;
  languages: Language[];
  files: ScannedFile[];
  scannedFiles: ScannedFile[];
  manifestDirectories: ManifestDirectory[];
  manifestDirs: string[];
  directories: ManifestDirectory[];
  lockFiles: string[];
  unknowns: UnknownRecord[];
  inventory: InventorySummary;
}

export const APPROVED_PATTERNS = [
  "package.json",
  "*.js",
  "*.cjs",
  "*.mjs",
  "*.jsx",
  "*.ts",
  "*.tsx",
  "webpack.config.*",
  "*.py",
  "requirements*.txt",
  "setup.py",
  "pyproject.toml",
  "Pipfile",
] as const;

export const LOCK_FILE_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
] as const;

export type LockFileName = (typeof LOCK_FILE_NAMES)[number];

export const LOOKED_FOR_FILES = [
  "package.json",
  "*.py",
  "requirements*.txt",
  "setup.py",
  "pyproject.toml",
  "Pipfile",
] as const;

export class LanguageUnknownError extends Error {
  readonly ok = false as const;
  readonly code = "LANGUAGE_UNKNOWN" as const;
  override readonly message: string;
  readonly lookedFor: readonly string[];
  readonly filesLookedFor: readonly string[];
  readonly languages: readonly Language[] = [];
  readonly files: readonly ScannedFile[] = [];
  readonly scannedFiles: readonly ScannedFile[] = [];
  readonly manifestDirectories: readonly ManifestDirectory[] = [];
  readonly manifestDirs: readonly string[] = [];
  readonly directories: readonly ManifestDirectory[] = [];
  readonly lockFiles: readonly string[] = [];
  readonly unknowns: readonly UnknownRecord[] = [];
  readonly inventory: InventorySummary;

  constructor(message?: string, lookedFor?: readonly string[]) {
    const list = lookedFor ?? LOOKED_FOR_FILES;
    const msg =
      message ??
      `No supported programming language was detected. Looked for: ${list.join(", ")}`;
    super(msg);
    this.name = "LanguageUnknownError";
    this.message = msg;
    this.lookedFor = list;
    this.filesLookedFor = list;
    this.inventory = {
      manifests: [],
      lockFiles: [],
      totalFiles: 0,
      scannedFiles: 0,
      directoriesCount: 0,
    };
    Object.setPrototypeOf(this, LanguageUnknownError.prototype);
  }
}

export type ScanInventoryResult = ScanInventorySuccess | LanguageUnknownError;

export interface ScanInventoryOptions {
  throwOnError?: boolean;
}

export function normalizePath(p: string): string {
  if (typeof p !== "string") {
    return "";
  }
  let normalized = p.replace(/\\/g, "/");
  normalized = normalized.replace(/^\.?\/+/, "");
  normalized = normalized.replace(/\/+/g, "/");
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

export function getBasename(filePath: string): string {
  const norm = normalizePath(filePath);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

export function getDirectory(filePath: string): string {
  const norm = normalizePath(filePath);
  const idx = norm.lastIndexOf("/");
  if (idx === -1) {
    return ".";
  }
  const dir = norm.slice(0, idx);
  return dir.length === 0 ? "." : dir;
}

export function getAncestorDirectories(filePath: string): string[] {
  const norm = normalizePath(filePath);
  const segments = norm.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length <= 1) {
    return ["."];
  }
  const dirSegments = segments.slice(0, -1);
  const ancestors: string[] = [];
  for (let i = dirSegments.length; i > 0; i--) {
    ancestors.push(dirSegments.slice(0, i).join("/"));
  }
  ancestors.push(".");
  return ancestors;
}

export function isApprovedSourceOrManifest(filename: string): boolean {
  if (filename === "package.json") return true;
  if (filename === "setup.py") return true;
  if (filename === "pyproject.toml") return true;
  if (filename === "Pipfile") return true;

  if (filename.startsWith("requirements") && filename.endsWith(".txt")) return true;
  if (filename.startsWith("webpack.config.") || filename === "webpack.config") return true;

  if (filename.endsWith(".js") && filename.length > 3) return true;
  if (filename.endsWith(".cjs") && filename.length > 4) return true;
  if (filename.endsWith(".mjs") && filename.length > 4) return true;
  if (filename.endsWith(".jsx") && filename.length > 4) return true;
  if (filename.endsWith(".ts") && filename.length > 3) return true;
  if (filename.endsWith(".tsx") && filename.length > 4) return true;
  if (filename.endsWith(".py") && filename.length > 3) return true;

  return false;
}

const LOCK_FILE_SET = new Set<string>(LOCK_FILE_NAMES);

export function isLockFile(filename: string): boolean {
  return LOCK_FILE_SET.has(filename);
}

export function isNodeManifest(filename: string): boolean {
  return filename === "package.json";
}

export function isPythonManifest(filename: string): boolean {
  if (filename === "setup.py") return true;
  if (filename === "pyproject.toml") return true;
  if (filename === "Pipfile") return true;
  if (filename.startsWith("requirements") && filename.endsWith(".txt")) return true;
  return false;
}

export function isPythonFile(filename: string): boolean {
  return filename.endsWith(".py") || isPythonManifest(filename);
}

export function isNodeFile(filename: string): boolean {
  if (isNodeManifest(filename)) return true;
  if (filename.endsWith(".js")) return true;
  if (filename.endsWith(".cjs")) return true;
  if (filename.endsWith(".mjs")) return true;
  if (filename.endsWith(".jsx")) return true;
  if (filename.endsWith(".ts")) return true;
  if (filename.endsWith(".tsx")) return true;
  if (filename.startsWith("webpack.config.") || filename === "webpack.config") return true;
  return false;
}

export function scanInventory(
  files: readonly InventoryInputFile[] | Iterable<InventoryInputFile>,
  options?: ScanInventoryOptions | boolean
): ScanInventoryResult {
  const throwOnError =
    typeof options === "boolean" ? options : options?.throwOnError === true;

  const rawList: InventoryInputFile[] = Array.isArray(files)
    ? files
    : Array.from((files as any)?.values?.() ?? files ?? []);

  // Deduplicate and filter out empty paths
  const seenPaths = new Set<string>();
  const rawFiles: InventoryInputFile[] = [];
  for (const f of rawList) {
    if (!f || typeof f.path !== "string") continue;
    const norm = normalizePath(f.path);
    if (!norm) continue;
    if (seenPaths.has(norm)) continue;
    seenPaths.add(norm);
    rawFiles.push(f);
  }

  // 1. Language classification across all input files (Criteria 3.4, 3.5)
  let hasNode = false;
  let hasPython = false;

  for (const f of rawFiles) {
    const basename = getBasename(f.path);
    if (isNodeManifest(basename)) {
      hasNode = true;
    }
    if (basename.endsWith(".py") || isPythonManifest(basename)) {
      hasPython = true;
    }
  }

  const languages: Language[] = [];
  if (hasNode) languages.push("node");
  if (hasPython) languages.push("python");

  // 2. Fail with LANGUAGE_UNKNOWN if languages is empty (Criterion 3.6)
  if (languages.length === 0) {
    const error = new LanguageUnknownError();
    if (throwOnError) {
      throw error;
    }
    return error;
  }

  // 3. Inventory lock files for existence only (Criterion 3.2)
  const lockFiles: string[] = [];
  const lockFilesByDir = new Map<string, string[]>();

  for (const f of rawFiles) {
    const normPath = normalizePath(f.path);
    const basename = getBasename(normPath);
    if (isLockFile(basename)) {
      lockFiles.push(normPath);
      const dir = getDirectory(normPath);
      const existing = lockFilesByDir.get(dir) ?? [];
      existing.push(normPath);
      lockFilesByDir.set(dir, existing);
    }
  }
  lockFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // 4. Discover Manifest Directories (Criterion 3.7)
  const nodeManifestDirsSet = new Set<string>();
  const pythonManifestDirsSet = new Set<string>();
  const nodeManifestsByDir = new Map<string, string[]>();
  const pythonManifestsByDir = new Map<string, string[]>();
  const allManifests: string[] = [];

  for (const f of rawFiles) {
    const normPath = normalizePath(f.path);
    const basename = getBasename(normPath);

    if (isNodeManifest(basename)) {
      const dir = getDirectory(normPath);
      nodeManifestDirsSet.add(dir);
      const list = nodeManifestsByDir.get(dir) ?? [];
      list.push(normPath);
      nodeManifestsByDir.set(dir, list);
      allManifests.push(normPath);
    }

    if (isPythonManifest(basename)) {
      const dir = getDirectory(normPath);
      pythonManifestDirsSet.add(dir);
      const list = pythonManifestsByDir.get(dir) ?? [];
      list.push(normPath);
      pythonManifestsByDir.set(dir, list);
      allManifests.push(normPath);
    }
  }

  // Check if any Python file has no ancestor Manifest_Directory (Criterion 3.7)
  if (hasPython) {
    let hasOrphanPython = false;
    for (const f of rawFiles) {
      const normPath = normalizePath(f.path);
      const basename = getBasename(normPath);
      if (isPythonFile(basename)) {
        const ancestors = getAncestorDirectories(normPath);
        const hasAncestor = ancestors.some((a) => pythonManifestDirsSet.has(a));
        if (!hasAncestor) {
          hasOrphanPython = true;
          break;
        }
      }
    }
    if (hasOrphanPython) {
      pythonManifestDirsSet.add(".");
    }
  }

  // 5. Order Manifest Directories: Node sorted by path first, then Python sorted by path (Criterion 3.8)
  const sortedNodeDirs = Array.from(nodeManifestDirsSet).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const sortedPythonDirs = Array.from(pythonManifestDirsSet).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  const nodeManifestDirectories: ManifestDirectory[] = sortedNodeDirs.map((dir) => ({
    path: dir,
    language: "node",
    manifests: nodeManifestsByDir.get(dir) ?? [],
    lockFiles: lockFilesByDir.get(dir) ?? [],
    hasLockFile: (lockFilesByDir.get(dir) ?? []).length > 0,
    files: [],
  }));

  const pythonManifestDirectories: ManifestDirectory[] = sortedPythonDirs.map((dir) => ({
    path: dir,
    language: "python",
    manifests: pythonManifestsByDir.get(dir) ?? [],
    lockFiles: lockFilesByDir.get(dir) ?? [],
    hasLockFile: (lockFilesByDir.get(dir) ?? []).length > 0,
    files: [],
  }));

  const allOrderedDirectories: ManifestDirectory[] = [
    ...nodeManifestDirectories,
    ...pythonManifestDirectories,
  ];

  // 6. Cap at 10 directories. Record remaining directories as unknown with reason manifest_cap (Criterion 3.9)
  const MAX_MANIFEST_DIRECTORIES = 10;
  const processedDirectories = allOrderedDirectories.slice(0, MAX_MANIFEST_DIRECTORIES);
  const cappedDirectories = allOrderedDirectories.slice(MAX_MANIFEST_DIRECTORIES);

  const unknowns: UnknownRecord[] = cappedDirectories.map((dir) => ({
    ruleId: "",
    reason: "manifest_cap",
    file: dir.path,
    directory: dir.path,
    manifestDir: dir.path,
    ...(dir.manifests[0] ? { manifestFile: dir.manifests[0] } : {}),
  }));

  // 7. Filter approved source extensions and manifests, sort by path, cap at 400 (Criteria 3.1, 3.3)
  const approved = rawFiles.filter((f) => {
    const basename = getBasename(f.path);
    return isApprovedSourceOrManifest(basename);
  });

  approved.sort((a, b) => {
    const pathA = normalizePath(a.path);
    const pathB = normalizePath(b.path);
    return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
  });

  const cappedFiles = approved.slice(0, 400);

  // 8. Assign each source file to nearest ancestor Manifest_Directory (Criterion 3.7)
  const filesAssigned: ScannedFile[] = cappedFiles.map((f) => {
    const normPath = normalizePath(f.path);
    const basename = getBasename(normPath);
    const isPy = isPythonFile(basename);
    const ancestors = getAncestorDirectories(normPath);

    let assignedDir = ".";
    if (isPy) {
      const match = ancestors.find((a) => pythonManifestDirsSet.has(a));
      assignedDir = match ?? ".";
    } else {
      const match = ancestors.find((a) => nodeManifestDirsSet.has(a));
      assignedDir = match ?? (nodeManifestDirsSet.has(".") ? "." : sortedNodeDirs[0] ?? ".");
    }

    const scanned: ScannedFile = {
      ...f,
      path: normPath,
      content: f.content ?? (f as any).text,
      manifestDir: assignedDir,
      manifestDirectory: assignedDir,
      language: isPy ? "python" : "node",
    };

    return scanned;
  });

  // Populate files on processedDirectories
  for (const dir of processedDirectories) {
    dir.files = filesAssigned
      .filter((sf) => sf.manifestDir === dir.path && sf.language === dir.language)
      .map((sf) => sf.path);
  }

  const manifestDirs = processedDirectories.map((d) => d.path);

  const inventorySummary: InventorySummary = {
    manifests: allManifests.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    lockFiles,
    totalFiles: rawFiles.length,
    scannedFiles: filesAssigned.length,
    directoriesCount: allOrderedDirectories.length,
  };

  return {
    ok: true,
    languages,
    files: filesAssigned,
    scannedFiles: filesAssigned,
    manifestDirectories: processedDirectories,
    manifestDirs,
    directories: processedDirectories,
    lockFiles,
    unknowns,
    inventory: inventorySummary,
  };
}

export function scanInventoryOrThrow(
  files: readonly InventoryInputFile[] | Iterable<InventoryInputFile>
): ScanInventorySuccess {
  const result = scanInventory(files, { throwOnError: true });
  if (!result.ok) {
    throw result;
  }
  return result;
}
