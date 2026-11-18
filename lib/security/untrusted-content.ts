// Task 11.2: Git repository isolation and untrusted Kiro content neutralization
// Requirements: 22.10, 22.11, 45.17

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { acpLoadHandling } from "../probes/probe-fallbacks";

export const GIT_HOOKS_FLAG = "core.hooksPath=/dev/null";
export const GIT_FSMONITOR_FLAG = "core.fsmonitor=false";
export const GIT_ISOLATION_FLAGS: readonly string[] = [
  "-c",
  GIT_HOOKS_FLAG,
  "-c",
  GIT_FSMONITOR_FLAG,
];

export type UntrustedContentType =
  | "kiro_directory"
  | "kiro_file"
  | "agents_file"
  | "skill";

export interface UntrustedContentEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly type: UntrustedContentType;
  readonly reason: string;
  readonly isDirectory?: boolean;
}

export interface UntrustedScanResult {
  readonly hasUntrustedContent: boolean;
  readonly entries: readonly UntrustedContentEntry[];
  readonly untrustedPaths: readonly string[];
  readonly kiroPaths: readonly string[];
  readonly agentsPaths: readonly string[];
  readonly skillPaths: readonly string[];
}

export type NeutralizationAction = "remove_and_skip_worktree" | "keep";

export interface NeutralizationPlan {
  readonly action: NeutralizationAction;
  readonly shouldNeutralize: boolean;
  readonly entries: readonly UntrustedContentEntry[];
  readonly pathsToSkipWorktree: readonly string[];
  readonly pathsToRemove: readonly string[];
  readonly gitCommands: readonly {
    readonly command: string;
    readonly args: readonly string[];
  }[];
  readonly reason: string;
}

export interface NeutralizationResult {
  readonly success: boolean;
  readonly action: NeutralizationAction;
  readonly removedPaths: readonly string[];
  readonly skippedWorktreePaths: readonly string[];
  readonly errors?: readonly string[];
}

export interface ScanOptions {
  readonly ignoreDirs?: readonly string[];
  readonly maxDepth?: number;
}

export interface NeutralizeOptions {
  readonly p7?: unknown;
  readonly scanResult?: UntrustedScanResult;
  readonly dryRun?: boolean;
  readonly gitExec?: (
    args: readonly string[],
    cwd: string
  ) => { stdout: string; stderr: string; exitCode: number } | Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Normalizes a repository-relative path to forward slashes without leading/trailing slashes.
 */
export function normalizeRepoRelativePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    return "";
  }
  let p = rawPath.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  p = p.replace(/^\/+/, "");
  p = p.replace(/\/+$/, "");
  p = path.posix.normalize(p);
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  p = p.replace(/^\/+/, "");
  if (p === "." || p === "./") {
    return "";
  }
  return p;
}

/**
 * Checks whether a path points to a .kiro directory or a file within .kiro.
 * Does not match .kiro-runs or other dotted prefixes.
 */
export function isKiroPath(filePath: string): boolean {
  const norm = normalizeRepoRelativePath(filePath);
  if (!norm) return false;
  const segments = norm.split("/");
  return segments.includes(".kiro");
}

/**
 * Checks whether a path points to an AGENTS.md file (case-insensitive).
 */
export function isAgentsFilePath(filePath: string): boolean {
  const norm = normalizeRepoRelativePath(filePath);
  if (!norm) return false;
  const base = path.posix.basename(norm).toLowerCase();
  return base === "agents.md";
}

/**
 * Checks whether a path points to skills configuration or definitions.
 * Recognizes .agents/skills, .kiro/skills, skills/, .skills/, and SKILL.md files.
 */
export function isSkillPath(filePath: string): boolean {
  const norm = normalizeRepoRelativePath(filePath);
  if (!norm) return false;
  const lower = norm.toLowerCase();
  const segments = lower.split("/");

  if (segments.includes("skills") || segments.includes(".skills")) {
    return true;
  }
  if (segments.includes(".agents") && segments.includes("skills")) {
    return true;
  }
  const base = path.posix.basename(lower);
  if (base === "skill.md") {
    return true;
  }
  return false;
}

/**
 * Classifies an untrusted content path, returning its type and description or null if trusted.
 */
export function classifyUntrustedPath(filePath: string): UntrustedContentType | null {
  const norm = normalizeRepoRelativePath(filePath);
  if (!norm) return null;

  if (isKiroPath(norm)) {
    const isDir = norm === ".kiro" || norm.endsWith("/.kiro");
    return isDir ? "kiro_directory" : "kiro_file";
  }

  if (isAgentsFilePath(norm)) {
    return "agents_file";
  }

  if (isSkillPath(norm)) {
    return "skill";
  }

  return null;
}

/**
 * Returns true if the path is any untrusted Kiro configuration, AGENTS.md, or skill.
 */
export function isUntrustedContent(filePath: string): boolean {
  return classifyUntrustedPath(filePath) !== null;
}

export const isUntrustedPath = isUntrustedContent;

/**
 * Pure function: Scans a given list of repository-relative paths for untrusted content.
 */
export function scanUntrustedPaths(filePaths: readonly string[]): UntrustedScanResult {
  const entries: UntrustedContentEntry[] = [];
  const untrustedSet = new Set<string>();
  const kiroSet = new Set<string>();
  const agentsSet = new Set<string>();
  const skillSet = new Set<string>();

  for (const raw of filePaths) {
    const norm = normalizeRepoRelativePath(raw);
    if (!norm) continue;

    const classification = classifyUntrustedPath(norm);
    if (classification) {
      untrustedSet.add(norm);
      let reason = "";
      switch (classification) {
        case "kiro_directory":
        case "kiro_file":
          kiroSet.add(norm);
          reason = `Untrusted .kiro configuration item: ${norm}`;
          break;
        case "agents_file":
          agentsSet.add(norm);
          reason = `Untrusted AGENTS.md specification file: ${norm}`;
          break;
        case "skill":
          skillSet.add(norm);
          reason = `Untrusted agent skill definition or directory: ${norm}`;
          break;
      }

      entries.push({
        path: norm,
        relativePath: norm,
        type: classification,
        reason,
      });
    }
  }

  // Sort entries deterministically
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    hasUntrustedContent: entries.length > 0,
    entries,
    untrustedPaths: Array.from(untrustedSet).sort(),
    kiroPaths: Array.from(kiroSet).sort(),
    agentsPaths: Array.from(agentsSet).sort(),
    skillPaths: Array.from(skillSet).sort(),
  };
}

/**
 * Recursively scans a cloned repository on disk for untrusted content.
 * Skips the .git internal repository directory.
 */
export function scanClonedRepository(
  repoRoot: string,
  options?: ScanOptions
): UntrustedScanResult {
  const ignoreDirs = new Set(options?.ignoreDirs ?? [".git"]);
  const maxDepth = options?.maxDepth ?? 30;
  const discoveredPaths: string[] = [];

  function walk(currentDir: string, currentRel: string, depth: number): void {
    if (depth > maxDepth) {
      throw new Error(`Repository scan exceeded maximum depth of ${maxDepth} at ${currentRel || "."}`);
    }

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err: any) {
      throw new Error(`Failed to read repository directory ${currentRel || "."}: ${err?.message ?? String(err)}`);
    }

    for (const ent of dirEntries) {
      const entRel = currentRel ? `${currentRel}/${ent.name}` : ent.name;
      const fullPath = path.join(currentDir, ent.name);

      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name)) {
          continue;
        }

        // If the directory itself is untrusted (e.g. .kiro, .agents/skills, skills), record it
        if (isUntrustedContent(entRel)) {
          discoveredPaths.push(entRel);
        }

        walk(fullPath, entRel, depth + 1);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        if (isUntrustedContent(entRel)) {
          discoveredPaths.push(entRel);
        }
      }
    }
  }

  walk(repoRoot, "", 0);

  return scanUntrustedPaths(discoveredPaths);
}

/**
 * Determines whether untrusted content must be neutralized based on Probe P7 outcome.
 * If P7 shows that ACP loads repository Kiro files, or if P7 is not passed, neutralization is required.
 */
export function shouldNeutralizeUntrustedContent(p7Outcome?: unknown): boolean {
  if (typeof p7Outcome === "boolean") {
    return p7Outcome;
  }
  if (!p7Outcome) {
    // Missing probe P7 defaults to not passed -> neutralize
    return true;
  }

  const p7Handling = acpLoadHandling(p7Outcome);
  if (p7Handling === "not passed") {
    return true;
  }

  return Boolean(p7Handling.removeLoadedFiles || p7Handling.markSkipWorktree || p7Handling.action === "remove_and_skip_worktree");
}

/**
 * Pure function: Plans neutralization of untrusted content.
 * Generates the list of files to mark skip-worktree, files to remove, and git command arguments.
 */
export function planUntrustedContentNeutralization(
  scanResultOrPaths: UntrustedScanResult | readonly string[],
  p7Outcome?: unknown
): NeutralizationPlan {
  const scanResult: UntrustedScanResult = Array.isArray(scanResultOrPaths)
    ? scanUntrustedPaths(scanResultOrPaths)
    : (scanResultOrPaths as UntrustedScanResult);

  const shouldNeutralize = shouldNeutralizeUntrustedContent(p7Outcome);

  if (!shouldNeutralize || !scanResult.hasUntrustedContent) {
    return {
      action: "keep",
      shouldNeutralize: false,
      entries: scanResult.entries,
      pathsToSkipWorktree: [],
      pathsToRemove: [],
      gitCommands: [],
      reason: "ACP probe P7 confirmed safe or no untrusted content found in repository.",
    };
  }

  // Paths to mark with skip-worktree: individual files that git tracks
  const pathsToSkipWorktree = [...scanResult.untrustedPaths].sort();
  // Paths to remove from worktree view
  const pathsToRemove = [...scanResult.untrustedPaths].sort();

  const gitCommands = [
    {
      command: "git",
      args: [
        ...GIT_ISOLATION_FLAGS,
        "update-index",
        "--skip-worktree",
        "--",
        ...pathsToSkipWorktree,
      ],
    },
  ];

  return {
    action: "remove_and_skip_worktree",
    shouldNeutralize: true,
    entries: scanResult.entries,
    pathsToSkipWorktree,
    pathsToRemove,
    gitCommands,
    reason: "Probe P7 indicated ACP loads repository configuration: removing from worktree view and applying skip-worktree.",
  };
}

/**
 * Neutralizes untrusted content in a cloned worktree when probe P7 indicates ACP loads repository files.
 * Marks files with git update-index --skip-worktree so git status does not show them as deleted,
 * and removes them from the worktree view.
 */
export function neutralizeUntrustedContent(
  repoRoot: string,
  options?: NeutralizeOptions
): NeutralizationResult {
  const scanResult = options?.scanResult ?? scanClonedRepository(repoRoot);
  const plan = planUntrustedContentNeutralization(scanResult, options?.p7);

  if (!plan.shouldNeutralize || plan.pathsToRemove.length === 0) {
    return {
      success: true,
      action: "keep",
      removedPaths: [],
      skippedWorktreePaths: [],
    };
  }

  const errors: string[] = [];
  const skippedWorktreePaths: string[] = [];
  const removedPaths: string[] = [];

  // Filter paths for skip-worktree: git update-index requires actual file paths in the index
  const filesToSkip: string[] = [];
  for (const rel of plan.pathsToSkipWorktree) {
    const full = path.join(repoRoot, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      // If stat fails, attempt skip-worktree on rel anyway
      filesToSkip.push(rel);
      continue;
    }

    if (st.isFile() || st.isSymbolicLink()) {
      filesToSkip.push(rel);
    } else if (st.isDirectory()) {
      // Find files inside the directory to mark skip-worktree
      const dirFiles = findFilesRecursively(full, rel);
      filesToSkip.push(...dirFiles);
    }
  }

  const uniqueFilesToSkip = Array.from(new Set(filesToSkip)).sort();

  // Step 1: Mark files skip-worktree in git index
  if (!options?.dryRun && uniqueFilesToSkip.length > 0) {
    const gitArgs = [
      ...GIT_ISOLATION_FLAGS,
      "update-index",
      "--skip-worktree",
      "--",
      ...uniqueFilesToSkip,
    ];

    if (options?.gitExec) {
      try {
        const res = options.gitExec(gitArgs, repoRoot);
        if (res && typeof (res as Promise<unknown>).then === "function") {
          // Promise returned; in pure synchronous flow notify or wait
        }
        skippedWorktreePaths.push(...uniqueFilesToSkip);
      } catch (err) {
        errors.push(`git update-index execution failed: ${String(err)}`);
      }
    } else {
      try {
        const proc = childProcess.spawnSync("git", gitArgs, {
          cwd: repoRoot,
          encoding: "utf-8",
        });
        if (proc.status === 0) {
          skippedWorktreePaths.push(...uniqueFilesToSkip);
        } else {
          // Even if some untracked files fail to mark, record error and proceed with removal
          errors.push(`git update-index exited with code ${proc.status}: ${proc.stderr}`);
        }
      } catch (err) {
        errors.push(`Failed to spawn git: ${String(err)}`);
      }
    }
  }

  // Step 2: Remove untrusted items from worktree view so ACP does not see or load them
  if (!options?.dryRun) {
    // Collect root untrusted paths to remove (e.g. remove .kiro directory as a whole)
    const rootsToRemove = findTopLevelUntrustedRoots(plan.pathsToRemove);

    for (const rel of rootsToRemove) {
      const full = path.join(repoRoot, rel);
      try {
        if (fs.existsSync(full)) {
          fs.rmSync(full, { recursive: true, force: true });
          removedPaths.push(rel);
        }
      } catch (err) {
        errors.push(`Failed to remove untrusted path ${rel}: ${String(err)}`);
      }
    }
  }

  return {
    success: errors.length === 0,
    action: "remove_and_skip_worktree",
    removedPaths,
    skippedWorktreePaths,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Finds all files within a directory relative to the repository root.
 */
export function findFilesRecursively(
  dirFullPath: string,
  dirRelPath: string,
  depth = 0,
  maxDepth = 30
): string[] {
  if (depth > maxDepth) {
    throw new Error(`Directory traversal exceeded maximum depth of ${maxDepth} at ${dirRelPath || "."}`);
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirFullPath, { withFileTypes: true });
  } catch (err: any) {
    if (depth === 0 && (err?.code === "ENOENT" || !fs.existsSync(dirFullPath))) {
      return [];
    }
    throw err;
  }

  const result: string[] = [];
  for (const ent of entries) {
    const childFull = path.join(dirFullPath, ent.name);
    const childRel = dirRelPath ? `${dirRelPath}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      result.push(...findFilesRecursively(childFull, childRel, depth + 1, maxDepth));
    } else {
      result.push(childRel);
    }
  }
  return result;
}

/**
 * Finds the topmost untrusted directories/files to remove cleanly without redundant deletions.
 */
function findTopLevelUntrustedRoots(paths: readonly string[]): string[] {
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const roots: string[] = [];

  for (const p of sorted) {
    const isChild = roots.some(
      (root) => p === root || p.startsWith(`${root}/`)
    );
    if (!isChild) {
      roots.push(p);
    }
  }

  return roots;
}
