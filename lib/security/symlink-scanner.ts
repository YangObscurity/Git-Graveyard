// Task 11.3: Worktree symlink scanner and escape quarantine
// Requirements: 22.8, 22.9, 45.10

import * as fs from "node:fs";
import * as path from "node:path";

export type SymlinkFindingType =
  | "escaping_symlink"
  | "directory_symlink"
  | "outside_hardlink"
  | "symlink_root"
  | "read_error"
  | "depth_limit_exceeded";

export interface SymlinkFinding {
  readonly path: string;
  readonly relativePath: string;
  readonly target: string;
  readonly resolvedTarget: string;
  readonly linkTarget?: string;
  readonly type: SymlinkFindingType;
  readonly kind: SymlinkFindingType;
  readonly reason: string;
}

export interface SymlinkScanOptions {
  readonly ignoreDirs?: readonly string[];
  readonly maxDepth?: number;
  readonly outsideFiles?: readonly string[];
  readonly knownOutsidePaths?: readonly string[];
  readonly outsideRoots?: readonly string[];
}

export class SymlinkScanReport extends Array<SymlinkFinding> {
  get findings(): readonly SymlinkFinding[] {
    return this;
  }

  get hasEscapes(): boolean {
    return this.length > 0;
  }

  get hasEscapingSymlinks(): boolean {
    return this.length > 0;
  }

  get clean(): boolean {
    return this.length === 0;
  }

  get passed(): boolean {
    return this.length === 0;
  }

  get shouldQuarantine(): boolean {
    return this.length > 0;
  }

  get relativePaths(): readonly string[] {
    return this.map((f) => f.relativePath);
  }

  get violations(): readonly string[] {
    return this.map((f) => f.reason);
  }

  get reason(): string | undefined {
    if (this.length === 0) {
      return undefined;
    }
    return `Quarantined: escaping symlink, directory link, or outside hard link detected: ${this.relativePaths.join(", ")}`;
  }
}

/**
 * Normalizes a relative path using forward slashes without leading/trailing slashes.
 */
function toPosixRelative(raw: string): string {
  let p = raw.replace(/\\/g, "/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  p = p.replace(/^\/+/, "");
  p = p.replace(/\/+$/, "");
  return p;
}

/**
 * Checks whether targetPath lies outside rootDir.
 */
export function isPathOutsideRoot(targetPath: string, rootDir: string): boolean {
  const normTarget = path.resolve(targetPath);
  const normRoot = path.resolve(rootDir);
  const rel = path.relative(normRoot, normTarget);
  return rel.startsWith("..") || path.isAbsolute(rel) || rel === "..";
}

/**
 * Scans a worktree root for escaping symlinks, directory symlinks, and hard links to files outside root.
 * Walks the tree using fs.lstat and never follows symbolic links.
 * Requirements: 22.8, 22.9, 45.10
 */
export function scanForEscapingSymlinks(
  root: string,
  options?: SymlinkScanOptions
): SymlinkScanReport {
  const report = new SymlinkScanReport();
  if (!root || typeof root !== "string") {
    return report;
  }

  if (root.startsWith("diff --git ") || root.startsWith("--- ")) {
    return scanDiffForSymlinks(root);
  }

  const canonicalRoot = path.resolve(root);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(canonicalRoot);
  } catch (err: any) {
    report.push({
      path: canonicalRoot,
      relativePath: ".",
      target: canonicalRoot,
      resolvedTarget: canonicalRoot,
      type: "read_error",
      kind: "read_error",
      reason: `Read error accessing worktree root: ${err?.message ?? err}`,
    });
    return report;
  }

  if (rootStat.isSymbolicLink()) {
    let linkTarget = "";
    try {
      linkTarget = fs.readlinkSync(canonicalRoot);
    } catch {}
    const resolvedTarget = path.resolve(path.dirname(canonicalRoot), linkTarget);
    report.push({
      path: canonicalRoot,
      relativePath: ".",
      target: resolvedTarget || canonicalRoot,
      resolvedTarget: resolvedTarget || canonicalRoot,
      linkTarget,
      type: "symlink_root",
      kind: "symlink_root",
      reason: `Worktree root is a symbolic link (symbolic link as root is forbidden): ${canonicalRoot} -> ${linkTarget}`,
    });
    return report;
  }

  if (!rootStat.isDirectory()) {
    report.push({
      path: canonicalRoot,
      relativePath: ".",
      target: canonicalRoot,
      resolvedTarget: canonicalRoot,
      type: "read_error",
      kind: "read_error",
      reason: `Read error accessing worktree root: worktree root is not a directory: ${canonicalRoot}`,
    });
    return report;
  }

  const ignoreDirs = new Set(options?.ignoreDirs ?? []);
  const maxDepth = options?.maxDepth ?? 50;

  // Track regular file inodes to detect hard links to files outside root
  interface InodeFileEntry {
    fullPath: string;
    relPath: string;
    nlink: number;
    dev: number;
    ino: number;
  }
  const filesByInode = new Map<string, InodeFileEntry[]>();

  // Queue for traversing directories: [ { dir: fullPath, relDir: relativePath, depth: number } ]
  const queue: { dir: string; relDir: string; depth: number }[] = [
    { dir: canonicalRoot, relDir: "", depth: 0 },
  ];

  while (queue.length > 0) {
    const item = queue.shift()!;
    const { dir, relDir, depth } = item;
    if (depth > maxDepth) {
      report.push({
        path: dir,
        relativePath: relDir || ".",
        target: dir,
        resolvedTarget: dir,
        type: "depth_limit_exceeded",
        kind: "depth_limit_exceeded",
        reason: `Maximum directory depth of ${maxDepth} exceeded at: ${relDir || "."}`,
      });
      continue;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch (err: any) {
      report.push({
        path: dir,
        relativePath: relDir || ".",
        target: dir,
        resolvedTarget: dir,
        type: "read_error",
        kind: "read_error",
        reason: `Read error on directory ${relDir || "."}: ${err?.message ?? err}`,
      });
      continue;
    }

    for (const name of entries) {
      if (ignoreDirs.has(name)) {
        continue;
      }

      const fullPath = path.join(dir, name);
      const relPath = relDir ? toPosixRelative(path.join(relDir, name)) : name;

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (err: any) {
        report.push({
          path: fullPath,
          relativePath: relPath,
          target: fullPath,
          resolvedTarget: fullPath,
          type: "read_error",
          kind: "read_error",
          reason: `Read error on file ${relPath}: ${err?.message ?? err}`,
        });
        continue;
      }

      if (stat.isSymbolicLink()) {
        // Link type and target are read with fs.lstat and fs.readlink only
        let linkTarget = "";
        try {
          linkTarget = fs.readlinkSync(fullPath);
        } catch (err: any) {
          report.push({
            path: fullPath,
            relativePath: relPath,
            target: fullPath,
            resolvedTarget: fullPath,
            type: "read_error",
            kind: "read_error",
            reason: `Read error reading symlink ${relPath}: ${err?.message ?? err}`,
          });
          continue;
        }

        // A link is outside the root when path.resolve of the link directory and the readlink value is outside it
        const resolvedTarget = path.resolve(dir, linkTarget);
        const isOutside = isPathOutsideRoot(resolvedTarget, canonicalRoot);

        let isDirectory = false;
        try {
          const targetStat = fs.lstatSync(resolvedTarget);
          if (targetStat.isDirectory()) {
            isDirectory = true;
          }
        } catch {
          isDirectory = false;
        }

        if (isDirectory) {
          report.push({
            path: fullPath,
            relativePath: relPath,
            target: resolvedTarget,
            resolvedTarget,
            linkTarget,
            type: "directory_symlink",
            kind: "directory_symlink",
            reason: `Directory symlink is forbidden (directory links refused outright): ${relPath} -> ${linkTarget}`,
          });
        } else if (isOutside) {
          report.push({
            path: fullPath,
            relativePath: relPath,
            target: resolvedTarget,
            resolvedTarget,
            linkTarget,
            type: "escaping_symlink",
            kind: "escaping_symlink",
            reason: `Symbolic link resolves outside worktree root: ${relPath} -> ${linkTarget}`,
          });
        }
        // Inside symlink to a regular file is safe and not flagged
      } else if (stat.isDirectory()) {
        // Real directory: traverse children
        queue.push({
          dir: fullPath,
          relDir: relPath,
          depth: depth + 1,
        });
      } else if (stat.isFile()) {
        // Regular file: record inode to inspect hard links
        const key = `${stat.dev}:${stat.ino}`;
        const existing = filesByInode.get(key) ?? [];
        existing.push({
          fullPath,
          relPath,
          nlink: stat.nlink,
          dev: stat.dev,
          ino: stat.ino,
        });
        filesByInode.set(key, existing);
      }
    }
  }

  // Check hard links to files outside root
  // If nlink > filesInWorktreeCount, there are hard links pointing to this inode from outside root
  for (const [, entries] of filesByInode.entries()) {
    const sample = entries[0];
    if (sample.nlink > entries.length) {
      // Find candidate outside target path
      let outsideTarget: string | undefined;

      // 1. Check explicitly passed outside files / paths
      const candidates = [
        ...(options?.outsideFiles ?? []),
        ...(options?.knownOutsidePaths ?? []),
      ];
      for (const cand of candidates) {
        try {
          const cStat = fs.lstatSync(cand);
          if (cStat.dev === sample.dev && cStat.ino === sample.ino) {
            outsideTarget = path.resolve(cand);
            break;
          }
        } catch {}
      }

      // 2. Check candidate outside roots
      if (!outsideTarget && options?.outsideRoots) {
        for (const outRoot of options.outsideRoots) {
          try {
            const outEntries = fs.readdirSync(outRoot);
            for (const outName of outEntries) {
              const cand = path.join(outRoot, outName);
              try {
                const cStat = fs.lstatSync(cand);
                if (cStat.dev === sample.dev && cStat.ino === sample.ino) {
                  outsideTarget = path.resolve(cand);
                  break;
                }
              } catch {}
            }
            if (outsideTarget) break;
          } catch {}
        }
      }

      // 3. Check parent directory of root (common in temp dirs and worktree setups)
      if (!outsideTarget) {
        const parentDir = path.dirname(canonicalRoot);
        try {
          const parentEntries = fs.readdirSync(parentDir);
          for (const pName of parentEntries) {
            const cand = path.join(parentDir, pName);
            if (cand === canonicalRoot) continue;
            try {
              const cStat = fs.lstatSync(cand);
              if (cStat.isFile() && cStat.dev === sample.dev && cStat.ino === sample.ino) {
                outsideTarget = path.resolve(cand);
                break;
              }
            } catch {}
          }
        } catch {}
      }

      const finalTarget =
        outsideTarget ?? `outside file (inode ${sample.ino})`;

      for (const file of entries) {
        report.push({
          path: file.fullPath,
          relativePath: file.relPath,
          target: finalTarget,
          resolvedTarget: finalTarget,
          type: "outside_hardlink",
          kind: "outside_hardlink",
          reason: `Hard link to file outside root: ${file.relPath} (target: ${finalTarget})`,
        });
      }
    }
  }

  // Sort findings deterministically by relativePath
  report.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return report;
}

export function shouldQuarantineWorktree(
  findings: readonly SymlinkFinding[] | SymlinkScanReport
): boolean {
  return findings.length > 0;
}

/**
 * Scans a git diff for symlinks by reading the mode field of the diff headers,
 * rather than matching diff text.
 */
export function scanDiffForSymlinks(diff: string): SymlinkScanReport {
  const report = new SymlinkScanReport();
  if (!diff || typeof diff !== "string") {
    return report;
  }

  const lines = diff.split("\n");
  let currentFile = "diff";
  let inHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      inHeader = true;
      const parts = line.split(" ");
      if (parts.length >= 4) {
        currentFile = parts[3].replace(/^[b]\//, "");
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      const target = line.slice(4).trim().replace(/^[a]\//, "");
      if (target && target !== "/dev/null") {
        currentFile = target;
      }
      inHeader = true;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim().replace(/^[b]\//, "");
      if (target && target !== "/dev/null") {
        currentFile = target;
      }
      inHeader = true;
      continue;
    }

    // A hunk starts with @@, marking the end of diff headers for this file
    if (line.startsWith("@@")) {
      inHeader = false;
      continue;
    }

    if (inHeader) {
      // Only inspect the mode field of diff headers, not diff content
      const modeMatch = line.trim().match(/^(?:new file mode|deleted file mode|old mode|new mode)\s+([0-9]+)$/);
      const indexMatch = line.trim().match(/^index\s+\S+\s+([0-9]+)$/);
      const mode = modeMatch ? modeMatch[1] : (indexMatch ? indexMatch[1] : null);
      if (mode === "120000") {
        report.push({
          path: currentFile,
          relativePath: currentFile,
          target: "symlink (mode 120000)",
          resolvedTarget: "symlink (mode 120000)",
          type: "escaping_symlink",
          kind: "escaping_symlink",
          reason: `Symlink mode 120000 detected in diff header: ${line.trim()} for ${currentFile}`,
        });
      }
    }
  }

  return report;
}

export const scanDiff = scanDiffForSymlinks;
export const scanCandidateDiffForSymlinks = scanDiffForSymlinks;

export function hasSymlinkInDiff(diff: string): boolean {
  return scanDiffForSymlinks(diff).length > 0;
}
