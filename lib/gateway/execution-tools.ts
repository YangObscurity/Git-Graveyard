// Task 10.6: MCP execution tools and backend dispatch
// Requirements: 19.5, 19.6, 19.7, 19.8, 19.9, 19.10, 19.19, 20.4, 20.6, 20.7, 20.8, 20.10, 20.11, 20.12

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { classifyCommand, isInsideWorktree } from "./command-policy";
import { ApprovalManager, sha256Argv } from "./approval-manager";
import { LogStore, generateLogRef } from "../events/log-store";
import { scanForEscapingSymlinks } from "../security/symlink-scanner";
import {
  scanWorktreeFiles,
  redactEvent,
  redactText,
  type WorktreeFileInput,
  type SecretScanResult,
  type SecretViolation,
} from "../security/redactor";
import type { EventStore } from "../events/event-store";
import {
  ConfigurationError,
  type RefusalFinding,
  type SandboxExecFatalResult,
  type SandboxExecParams,
  type SandboxExecRefusedResult,
  type SandboxExecResult,
  type SandboxLogParams,
  type SandboxLogResult,
  type ToolExecutionContext,
} from "./types";
import type {
  ExecutionBackend,
  ExecChunk,
  ExecProcess,
  ExecRequest,
  ExecResult,
  Sandbox,
} from "../backend/types";
import type { EventEmitCallback } from "./approval-manager";

export { ConfigurationError };

export type ProcessSweeper = (pgid?: number | string) => Promise<void> | void;

export type CustomCommandRunner = (
  argv: string[],
  options: {
    cwd: string;
    box: "runbox" | "auditbox";
    timeoutMs: number;
    logRef: string;
    runId?: string;
  }
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  running?: boolean;
}>;

export interface SweepableSandbox extends Sandbox {
  killProcessGroup?(pgid?: number | string): Promise<void> | void;
  containerId?: string;
  box?: "runbox" | "auditbox" | string;
  role?: string;
}

export interface SweepableBackend extends ExecutionBackend {
  runbox?: Sandbox;
  auditbox?: Sandbox;
  getBox?(box: "runbox" | "auditbox" | string): Promise<Sandbox | undefined> | Sandbox | undefined;
  killProcessGroup?(target?: string | Sandbox, pgid?: number | string): Promise<void> | void;
  sweepProcesses?(target?: string | Sandbox, pgid?: number | string): Promise<void> | void;
}

export interface ExecutionToolsOptions {
  approvalManager?: ApprovalManager;
  logStore?: LogStore;
  eventStore?: EventStore;
  onEmitEvent?: EventEmitCallback;
  processSweeper?: ProcessSweeper;
  defaultTimeoutMs?: number;
  approvalWaitMs?: number;
  defaultLogLimit?: number;
  backend?: ExecutionBackend;
  runbox?: Sandbox;
  auditbox?: Sandbox;
  maxScanFiles?: number;
  maxWorktreeScanFiles?: number;
  maxScanTotalBytes?: number;
  maxWorktreeScanBytes?: number;
  settings?: {
    maxScanFiles?: number;
    maxWorktreeScanFiles?: number;
    maxScanTotalBytes?: number;
    maxWorktreeScanBytes?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// Audit N-2 / N-B9: the escape check and the later read share one file descriptor
// opened with O_NOFOLLOW, so a symlink swapped in between the check and the read
// is never followed: the descriptor's real path is compared with the expected
// worktree root before anything is read through it.
const O_NOFOLLOW_FLAG: number =
  typeof (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW === "number"
    ? ((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW as number)
    : 0;

type CheckedFileOpen =
  | { ok: true; fd: number }
  | { ok: false; symlinkRefused: boolean; code?: string; error?: unknown };

function openCheckedFile(fullPath: string): CheckedFileOpen {
  try {
    return { ok: true, fd: fs.openSync(fullPath, fs.constants.O_RDONLY | O_NOFOLLOW_FLAG) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ELOOP: the final path component is a symlink and O_NOFOLLOW refused it.
    // Where O_NOFOLLOW is unavailable (Windows) a symlink is followed here and
    // rejected by the descriptor verification below instead.
    return { ok: false, symlinkRefused: code === "ELOOP", code, error: err };
  }
}

function descriptorRealPathInsideRoot(fd: number, fullPath: string, realWorktreeRoot: string): boolean {
  // 1. Real path of the open descriptor via procfs, compared with the expected root.
  try {
    return isPathInside(fs.realpathSync(`/proc/self/fd/${fd}`), realWorktreeRoot);
  } catch {
    // procfs unavailable (e.g. Windows): fall back to an identity check.
  }
  // 2. Fallback: the descriptor must still be the file at fullPath, and that
  //    path's real path must lie inside the expected root.
  try {
    const fdStat = fs.fstatSync(fd);
    const pathStat = fs.statSync(fullPath);
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) return false;
    return isPathInside(fs.realpathSync(fullPath), realWorktreeRoot);
  } catch {
    return false;
  }
}

function readFileChunksFromFd(fd: number, chunkSize = 1024 * 1024, overlap = 8192): string[] {
  const chunks: string[] = [];
  const stat = fs.fstatSync(fd);
  const totalSize = stat.size;
  let position = 0;
  while (position < totalSize) {
    const readLength = Math.min(chunkSize, totalSize - position);
    const buffer = Buffer.alloc(readLength);
    const bytesRead = fs.readSync(fd, buffer, 0, readLength, position);
    if (bytesRead <= 0) break;
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    chunks.push(text);
    if (position + bytesRead >= totalSize) break;
    const step = bytesRead - overlap;
    if (step <= 0) {
      position += bytesRead;
    } else {
      position += step;
    }
  }
  return chunks;
}

export class PathEscapeError extends Error {
  public readonly code = "PATH_ESCAPE";
  public readonly path: string;
  public readonly findings: RefusalFinding[];

  constructor(filePath: string, findings?: RefusalFinding[]) {
    super(`Path escape detected: ${filePath}`);
    this.name = "PathEscapeError";
    this.path = filePath;
    this.findings = findings ?? [{
      path: filePath,
      ruleId: "PATH_ESCAPE",
      fingerprint: computeFingerprint(filePath),
    }];
  }
}

function computeFingerprint(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// N-B11: exported limit defaults kept for direct helper compatibility.
export const MAX_WORKTREE_SCAN_FILES = 1000;
export const MAX_WORKTREE_SCAN_TOTAL_BYTES = 32 * 1024 * 1024;

export function validateScanLimits(options?: ExecutionToolsOptions): { maxFiles: number; maxBytes: number } {
  const checkLimit = (name: string, val: unknown): number | undefined => {
    if (val === undefined) return undefined;
    if (
      typeof val !== "number" ||
      !Number.isFinite(val) ||
      !Number.isInteger(val) ||
      val <= 0
    ) {
      throw new ConfigurationError(`Invalid ${name}: must be a positive finite integer, got ${String(val)}`);
    }
    return val;
  };

  const settings = (options as any)?.settings;

  const f1 = checkLimit("maxScanFiles", options?.maxScanFiles);
  const f2 = checkLimit("maxWorktreeScanFiles", options?.maxWorktreeScanFiles);
  const f3 = checkLimit("settings.maxScanFiles", settings?.maxScanFiles);
  const f4 = checkLimit("settings.maxWorktreeScanFiles", settings?.maxWorktreeScanFiles);

  const b1 = checkLimit("maxScanTotalBytes", options?.maxScanTotalBytes);
  const b2 = checkLimit("maxWorktreeScanBytes", options?.maxWorktreeScanBytes);
  const b3 = checkLimit("settings.maxScanTotalBytes", settings?.maxScanTotalBytes);
  const b4 = checkLimit("settings.maxWorktreeScanBytes", settings?.maxWorktreeScanBytes);

  const maxFiles = f4 ?? f3 ?? f2 ?? f1 ?? MAX_WORKTREE_SCAN_FILES;
  const maxBytes = b4 ?? b3 ?? b2 ?? b1 ?? MAX_WORKTREE_SCAN_TOTAL_BYTES;

  return { maxFiles, maxBytes };
}

interface ScanBudget {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
}

function chargeScanBudget(budget: ScanBudget, bytes: number, sourcePath: string): void {
  budget.files += 1;
  budget.bytes += bytes;
  if (budget.files > budget.maxFiles) {
    throw new ScanLimitExceededError(sourcePath, "file-count");
  }
  if (budget.bytes > budget.maxBytes) {
    throw new ScanLimitExceededError(sourcePath, "total-bytes");
  }
}

export class ScanLimitExceededError extends Error {
  public readonly code = "SCAN_LIMIT_EXCEEDED";
  public readonly path: string;
  public readonly limit: "file-count" | "total-bytes";
  public readonly findings: RefusalFinding[];

  constructor(filePath: string, limit: "file-count" | "total-bytes", findings?: RefusalFinding[]) {
    super(`Worktree scan limit exceeded (${limit}): ${filePath}`);
    this.name = "ScanLimitExceededError";
    this.path = filePath;
    this.limit = limit;
    this.findings = findings ?? [{
      path: filePath,
      ruleId: "SCAN_LIMIT_EXCEEDED",
      fingerprint: computeFingerprint(`${limit}:${filePath}`),
    }];
  }
}

export function sanitizeSecretFindings(violations: unknown): RefusalFinding[] {
  if (!Array.isArray(violations)) return [];
  return violations.map((v: any) => {
    if (v && typeof v === "object" && typeof v.fingerprint === "string" && !("match" in v)) {
      return {
        path: String(v.path ?? v.file ?? ""),
        ruleId: String(v.ruleId ?? v.patternName ?? "SECRET_DETECTED"),
        fingerprint: String(v.fingerprint),
      };
    }
    const matchText = String(v?.match ?? "");
    const fingerprint = computeFingerprint(matchText);
    return {
      path: String(v?.file ?? v?.path ?? ""),
      ruleId: String(v?.patternName ?? v?.ruleId ?? v?.type ?? "SECRET_DETECTED"),
      fingerprint,
    };
  });
}

export function sanitizePathEscapeFindings(findings: unknown): RefusalFinding[] {
  if (!Array.isArray(findings)) return [];
  return findings.map((f: any) => {
    if (typeof f === "string") {
      return {
        path: f,
        ruleId: "PATH_ESCAPE",
        fingerprint: computeFingerprint(f),
      };
    }
    const p = String(f?.path ?? "");
    const fingerprint = typeof f?.fingerprint === "string" ? f.fingerprint : computeFingerprint(p);
    return {
      path: p,
      ruleId: "PATH_ESCAPE",
      fingerprint,
    };
  });
}

export function sanitizeEscapingSymlinkFindings(
  findings: unknown,
  worktreeRoot?: string
): RefusalFinding[] {
  if (!Array.isArray(findings)) return [];
  const realRoot = worktreeRoot ? path.resolve(worktreeRoot) : undefined;
  return findings.map((f: any) => {
    let relPath: string;
    if (typeof f === "string") {
      relPath = f;
    } else if (f && typeof f === "object") {
      relPath = String(f.relativePath ?? f.path ?? "");
    } else {
      relPath = "";
    }
    if (path.isAbsolute(relPath)) {
      if (realRoot && isPathInside(relPath, realRoot)) {
        relPath = path.relative(realRoot, relPath);
      } else {
        relPath = path.basename(relPath);
      }
    }
    relPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const fingerprint =
      typeof f?.fingerprint === "string"
        ? f.fingerprint
        : computeFingerprint(`ESCAPING_SYMLINK:${relPath}`);
    return {
      path: relPath,
      ruleId: "ESCAPING_SYMLINK",
      fingerprint,
    };
  });
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function stripResolvedRoot(message: string, resolvedRoot: string): string {
  if (!message || !resolvedRoot) return message;
  let result = message;
  const roots: string[] = [resolvedRoot];
  try {
    const norm = path.resolve(resolvedRoot);
    if (!roots.includes(norm)) roots.push(norm);
    const real = fs.realpathSync(norm);
    if (!roots.includes(real)) roots.push(real);
  } catch {}

  for (const root of roots) {
    if (!root) continue;
    const posixRoot = root.replace(/\\/g, "/");
    const withSlash = root.endsWith("/") || root.endsWith("\\") ? root : root + "/";
    const posixWithSlash = posixRoot.endsWith("/") ? posixRoot : posixRoot + "/";

    result = result.split(withSlash).join("");
    if (posixWithSlash !== withSlash) {
      result = result.split(posixWithSlash).join("");
    }
    result = result.split(root).join(".");
    if (posixRoot !== root) {
      result = result.split(posixRoot).join(".");
    }
  }
  return result;
}

export function toWorktreeRelativePath(targetPath: unknown, resolvedRoot: string): string {
  if (targetPath === null || targetPath === undefined) {
    return ".";
  }

  let str: string;
  if (typeof targetPath === "string") {
    str = targetPath;
  } else if (targetPath && typeof targetPath === "object") {
    if (typeof (targetPath as any).path === "string") {
      str = (targetPath as any).path;
    } else if (typeof (targetPath as any).message === "string") {
      str = (targetPath as any).message;
    } else {
      str = String(targetPath);
    }
  } else {
    str = String(targetPath);
  }

  if (str === "<outside-worktree>") {
    return "<outside-worktree>";
  }

  const normRoot = path.resolve(resolvedRoot);
  let realRoot = normRoot;
  try {
    realRoot = fs.realpathSync(normRoot);
  } catch {}

  const isErrorMessage =
    str.includes("\n") ||
    /^(Error:|Failed to|EACCES:|ENOENT:|EPERM:)/.test(str) ||
    (str.includes(": ") && (str.includes(resolvedRoot) || str.includes(normRoot) || str.includes(realRoot)));

  if (isErrorMessage) {
    return stripResolvedRoot(str, resolvedRoot);
  }

  const posixStr = str.replace(/\\/g, "/");

  if (path.isAbsolute(str) || /^[A-Za-z]:\//.test(posixStr)) {
    const insideNorm = isPathInside(str, normRoot);
    const insideReal = isPathInside(str, realRoot);
    if (!insideNorm && !insideReal) {
      if (path.resolve(str) === normRoot || path.resolve(str) === realRoot) {
        return ".";
      }
      return "<outside-worktree>";
    }
    const base = insideNorm ? normRoot : realRoot;
    const rel = path.relative(base, str).replace(/\\/g, "/");
    return (rel === "" || rel === ".") ? "." : rel;
  }

  const resolved = path.resolve(normRoot, str);
  if (!isPathInside(resolved, normRoot) && !isPathInside(resolved, realRoot)) {
    if (resolved === normRoot || resolved === realRoot) {
      return ".";
    }
    return "<outside-worktree>";
  }
  const rel = path.relative(normRoot, resolved).replace(/\\/g, "/");
  return (rel === "" || rel === ".") ? "." : rel;
}

export function checkPathEscape(entry: string, worktreeRoot: string, realWorktreeRoot: string): boolean {
  const resolvedTarget = path.resolve(worktreeRoot, entry);
  // 1. Lexical check against both worktreeRoot and realWorktreeRoot
  if (!isPathInside(resolvedTarget, path.resolve(worktreeRoot)) || !isPathInside(resolvedTarget, realWorktreeRoot)) {
    return true;
  }
  // 2. Symlink and real path check
  try {
    const lstat = fs.lstatSync(resolvedTarget);
    if (lstat.isSymbolicLink()) {
      try {
        const realTarget = fs.realpathSync(resolvedTarget);
        if (!isPathInside(realTarget, realWorktreeRoot)) {
          return true;
        }
      } catch {
        // Broken symlink: check destination
        const linkDest = fs.readlinkSync(resolvedTarget);
        const resolvedDest = path.resolve(path.dirname(resolvedTarget), linkDest);
        if (!isPathInside(resolvedDest, realWorktreeRoot)) {
          return true;
        }
      }
    } else {
      try {
        const realTarget = fs.realpathSync(resolvedTarget);
        if (!isPathInside(realTarget, realWorktreeRoot)) {
          return true;
        }
      } catch {
        // If realpathSync fails but lstat succeeded, it's inside (already passed lexical check)
      }
    }
  } catch {
    // Does not exist on disk. Since resolvedTarget passed lexical checks, it's a non-existent path inside worktree
  }
  return false;
}

/**
 * Recursively collects worktree files from disk or context for secret scanning.
 * The gateway enumerates worktree files itself from worktreeRoot.
 * Merges enumerated worktree files with all caller-supplied lists:
 * params.files, context.files, context.worktreeFiles, options.worktreeFiles.
 * An empty list adds nothing and skips nothing.
 * Caller files are validated: escaping paths are refused with PATH_ESCAPE and never read.
 * Audit N-B4 (scan part): node_modules, .git, .next and dist folders are skipped
 * at any depth, and the collection is bounded by file count and total bytes;
 * above a limit it reports a finding (ScanLimitExceededError) and fails closed.
 * Audit N-2 / N-B9: caller files are read through one O_NOFOLLOW descriptor that
 * is verified against the expected root, so a symlink swapped in after the check
 * is refused, never followed.
 * Requirements: 22.14, 22.15, 42.5.
 */
export function collectWorktreeFiles(
  worktreeRoot: string,
  context?: ToolExecutionContext,
  options?: ExecutionToolsOptions,
  params?: SandboxExecParams
): WorktreeFileInput[] {
  let realWorktreeRoot: string;
  try {
    realWorktreeRoot = fs.realpathSync(worktreeRoot);
  } catch {
    realWorktreeRoot = path.resolve(worktreeRoot);
  }

  // Caller-supplied lists: params.files, context.files, context.worktreeFiles, options.worktreeFiles
  const callerLists: unknown[] = [
    params?.files,
    (context as any)?.files,
    (context as any)?.worktreeFiles,
    (options as any)?.worktreeFiles,
  ];

  // 1. Path escape check: each string entry of params.files and other caller-supplied lists
  // is resolved against worktree root, and real path must lie inside real path of worktree root.
  // An escaping path is refused: the file is NEVER read, and refusal uses code PATH_ESCAPE.
  const escapingPaths: string[] = [];

  for (const list of callerLists) {
    if (!list) continue;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string") {
          if (checkPathEscape(item, worktreeRoot, realWorktreeRoot)) {
            escapingPaths.push(item);
          }
        } else if (item && typeof item === "object" && typeof (item as any).path === "string") {
          if (checkPathEscape((item as any).path, worktreeRoot, realWorktreeRoot)) {
            escapingPaths.push((item as any).path);
          }
        }
      }
    } else if (typeof list === "object") {
      for (const p of Object.keys(list as Record<string, unknown>)) {
        if (checkPathEscape(p, worktreeRoot, realWorktreeRoot)) {
          escapingPaths.push(p);
        }
      }
    }
  }

  if (escapingPaths.length > 0) {
    throw new PathEscapeError(escapingPaths[0], sanitizePathEscapeFindings(escapingPaths));
  }

  // 2. Enumerate worktree files from disk.
  // N-B11: only skip .git directories and root-level node_modules, and fail closed
  // on unreadable directories or files.
  const enumeratedFiles: WorktreeFileInput[] = [];
  const { maxFiles, maxBytes } = validateScanLimits(options);
  const budget: ScanBudget = { files: 0, bytes: 0, maxFiles, maxBytes };

  function walk(currentDir: string, relPrefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err: any) {
      const relDir = relPrefix || ".";
      const errMsg = stripResolvedRoot(`Failed to read worktree directory ${relDir}: ${err?.message ?? String(err)}`, worktreeRoot);
      const error: any = new Error(errMsg);
      error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
      error.path = relDir;
      throw error;
    }

    for (const ent of entries) {
      const fullPath = path.join(currentDir, ent.name);
      const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;

      // N-B11: only skip .git directories (at any depth) and root-level node_modules
      if (ent.name === ".git" || relPath === "node_modules") {
        continue;
      }

      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        walk(fullPath, relPath);
      } else if (ent.isFile()) {
        const opened = openCheckedFile(fullPath);
        if (!opened || !opened.ok) {
          const error: any = new Error(`Failed to open worktree file: ${relPath}`);
          error.code = (opened as any)?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
          error.path = relPath;
          throw error;
        }
        try {
          if (!descriptorRealPathInsideRoot(opened.fd, fullPath, realWorktreeRoot)) {
            const error: any = new Error(`Worktree file descriptor verification failed: ${relPath}`);
            error.code = "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
          let stat: fs.Stats;
          try {
            stat = fs.fstatSync(opened.fd);
          } catch (err: any) {
            const error: any = new Error(`Failed to stat worktree file ${relPath}: ${err?.message ?? String(err)}`);
            error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
          if (!stat.isFile()) {
            const error: any = new Error(`Worktree entry is not a regular file: ${relPath}`);
            error.code = "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
          chargeScanBudget(budget, stat.size, relPath);
          let chunks: string[];
          try {
            chunks = readFileChunksFromFd(opened.fd);
          } catch (err: any) {
            const error: any = new Error(`Failed to read worktree file ${relPath}: ${err?.message ?? String(err)}`);
            error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
          if (stat.size <= 1024 * 1024) {
            enumeratedFiles.push({ path: relPath, content: chunks[0] ?? "" });
          } else {
            for (const chunk of chunks) {
              enumeratedFiles.push({ path: relPath, content: chunk });
            }
          }
        } finally {
          fs.closeSync(opened.fd);
        }
      }
    }
  }

  if (fs.existsSync(worktreeRoot)) {
    let rootStat: fs.Stats;
    try {
      rootStat = fs.statSync(worktreeRoot);
    } catch (err: any) {
      const errMsg = stripResolvedRoot(`Failed to stat worktree root .: ${err?.message ?? String(err)}`, worktreeRoot);
      const error: any = new Error(errMsg);
      error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
      error.path = ".";
      throw error;
    }
    if (rootStat && rootStat.isDirectory()) {
      walk(worktreeRoot, "");
    }
  }

  // 3. Union, not fallback: merge enumerated worktree files with all caller-supplied lists
  const extraFiles: WorktreeFileInput[] = [];

  for (const list of callerLists) {
    if (!list) continue;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string") {
          const targetPath = path.resolve(worktreeRoot, item);
          // Audit N-2 / N-B9: one O_NOFOLLOW descriptor backs both the escape
          // verification and the read, so a symlink swapped in after the check
          // above is refused (PATH_ESCAPE) instead of being followed.
          const opened = openCheckedFile(targetPath);
          if (!opened.ok) {
            if (opened.symlinkRefused) {
              throw new PathEscapeError(item, sanitizePathEscapeFindings([item]));
            }
            if (opened.code === "ENOENT") {
              continue;
            }
            const error: any = new Error(`Failed to open worktree file: ${item}`);
            error.code = opened.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
            error.path = item;
            throw error;
          }
          try {
            if (!descriptorRealPathInsideRoot(opened.fd, targetPath, realWorktreeRoot)) {
              throw new PathEscapeError(item, sanitizePathEscapeFindings([item]));
            }
            let stat: fs.Stats;
            try {
              stat = fs.fstatSync(opened.fd);
            } catch (err: any) {
              const error: any = new Error(`Failed to stat worktree file ${item}: ${err?.message ?? String(err)}`);
              error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
              error.path = item;
              throw error;
            }
            if (!stat.isFile()) {
              const error: any = new Error(`Worktree entry is not a regular file: ${item}`);
              error.code = "SCAN_READ_ERROR";
              error.path = item;
              throw error;
            }
            chargeScanBudget(budget, stat.size, item);
            let chunks: string[];
            try {
              chunks = readFileChunksFromFd(opened.fd);
            } catch (err: any) {
              const error: any = new Error(`Failed to read worktree file ${item}: ${err?.message ?? String(err)}`);
              error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
              error.path = item;
              throw error;
            }
            if (stat.size <= 1024 * 1024) {
              extraFiles.push({ path: item, content: chunks[0] ?? "" });
            } else {
              for (const chunk of chunks) {
                extraFiles.push({ path: item, content: chunk });
              }
            }
          } finally {
            fs.closeSync(opened.fd);
          }
        } else if (item && typeof item === "object" && typeof (item as any).path === "string") {
          const directContent = String((item as any).content ?? "");
          chargeScanBudget(budget, Buffer.byteLength(directContent), (item as any).path);
          extraFiles.push({
            path: (item as any).path,
            content: directContent,
          });
        }
      }
    } else if (typeof list === "object") {
      for (const [p, content] of Object.entries(list as Record<string, string>)) {
        const recordContent = String(content ?? "");
        chargeScanBudget(budget, Buffer.byteLength(recordContent), p);
        extraFiles.push({
          path: p,
          content: recordContent,
        });
      }
    }
  }

  return [...enumeratedFiles, ...extraFiles];
}

interface ScanAccumulator {
  passed: boolean;
  violations: SecretViolation[];
  flaggedFiles: string[];
}

function mergeSingleScanResult(
  accumulator: ScanAccumulator,
  fileResult: SecretScanResult
): void {
  if (!fileResult.passed || fileResult.hasSecrets) {
    accumulator.passed = false;
  }
  if (fileResult.violations && fileResult.violations.length > 0) {
    accumulator.violations.push(...fileResult.violations);
  }
  if (fileResult.flaggedFiles && fileResult.flaggedFiles.length > 0) {
    for (const f of fileResult.flaggedFiles) {
      if (!accumulator.flaggedFiles.includes(f)) {
        accumulator.flaggedFiles.push(f);
      }
    }
  }
}

/**
 * Scans one already-verified open descriptor sequentially, chunk by chunk
 * (Audit N-2 / N-B9): the caller opened the file with O_NOFOLLOW and verified
 * the descriptor against the expected root, so no swapped-in symlink can be
 * followed here and the content is read from the pinned descriptor.
 */
function scanFdBounded(
  fd: number,
  relPath: string,
  totalSize: number,
  accumulator: ScanAccumulator
): void {
  const chunkSize = 1024 * 1024;
  const overlap = 8192;
  let position = 0;
  while (position < totalSize) {
    const readLength = Math.min(chunkSize, totalSize - position);
    const buffer = Buffer.alloc(readLength);
    const bytesRead = fs.readSync(fd, buffer, 0, readLength, position);
    if (bytesRead <= 0) break;
    const chunk = buffer.subarray(0, bytesRead).toString("utf-8");
    const res = scanWorktreeFiles([{ path: relPath, content: chunk }]);
    mergeSingleScanResult(accumulator, res);
    if (position + bytesRead >= totalSize) break;
    const step = bytesRead - overlap;
    if (step <= 0) {
      position += bytesRead;
    } else {
      position += step;
    }
  }
}

function scanDirectContentBounded(
  relPath: string,
  content: string,
  accumulator: ScanAccumulator,
  budget: ScanBudget
): void {
  chargeScanBudget(budget, Buffer.byteLength(content), relPath);
  const chunkSize = 1024 * 1024;
  const overlap = 8192;
  if (content.length <= chunkSize) {
    const res = scanWorktreeFiles([{ path: relPath, content }]);
    mergeSingleScanResult(accumulator, res);
  } else {
    let position = 0;
    while (position < content.length) {
      const chunk = content.slice(position, position + chunkSize);
      const res = scanWorktreeFiles([{ path: relPath, content: chunk }]);
      mergeSingleScanResult(accumulator, res);
      if (position + chunk.length >= content.length) break;
      const step = chunk.length - overlap;
      if (step <= 0) {
        position += chunk.length;
      } else {
        position += step;
      }
    }
  }
}

/**
 * Scans worktree files sequentially with bounded memory (Audit N-2).
 * Each file is read, scanned with scanWorktreeFiles, and released before the next file is read.
 * Preserves path escape checks and union rules for caller-supplied file lists.
 * Audit N-B4 (scan part): node_modules, .git, .next and dist folders are skipped
 * at any depth, and the scan is bounded by file count and total bytes; above a
 * limit it reports a finding (ScanLimitExceededError) and fails closed.
 * Audit N-2 / N-B9: every file is read through one O_NOFOLLOW descriptor that is
 * verified against the expected root, so a symlink swapped in after the check is
 * refused, never followed (caller-supplied paths refuse with PATH_ESCAPE).
 */
export function scanWorktreeFilesBounded(
  worktreeRoot: string,
  context?: ToolExecutionContext,
  options?: ExecutionToolsOptions,
  params?: SandboxExecParams
): SecretScanResult {
  let realWorktreeRoot: string;
  try {
    realWorktreeRoot = fs.realpathSync(worktreeRoot);
  } catch {
    realWorktreeRoot = path.resolve(worktreeRoot);
  }

  // Caller-supplied lists: params.files, context.files, context.worktreeFiles, options.worktreeFiles
  const callerLists: unknown[] = [
    params?.files,
    (context as any)?.files,
    (context as any)?.worktreeFiles,
    (options as any)?.worktreeFiles,
  ];

  // 1. Path escape check: each string entry of params.files and other caller-supplied lists
  // is resolved against worktree root, and real path must lie inside real path of worktree root.
  // An escaping path is refused: the file is NEVER read, and refusal uses code PATH_ESCAPE.
  const escapingPaths: string[] = [];

  for (const list of callerLists) {
    if (!list) continue;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string") {
          if (checkPathEscape(item, worktreeRoot, realWorktreeRoot)) {
            escapingPaths.push(item);
          }
        } else if (item && typeof item === "object" && typeof (item as any).path === "string") {
          if (checkPathEscape((item as any).path, worktreeRoot, realWorktreeRoot)) {
            escapingPaths.push((item as any).path);
          }
        }
      }
    } else if (typeof list === "object") {
      for (const p of Object.keys(list as Record<string, unknown>)) {
        if (checkPathEscape(p, worktreeRoot, realWorktreeRoot)) {
          escapingPaths.push(p);
        }
      }
    }
  }

  if (escapingPaths.length > 0) {
    throw new PathEscapeError(escapingPaths[0], sanitizePathEscapeFindings(escapingPaths));
  }

  const accumulator: ScanAccumulator = {
    passed: true,
    violations: [],
    flaggedFiles: [],
  };

  const { maxFiles, maxBytes } = validateScanLimits(options);
  const budget: ScanBudget = { files: 0, bytes: 0, maxFiles, maxBytes };

  // 2. Enumerate and scan worktree files from disk sequentially.
  // N-B11: only skip .git directories and root-level node_modules, and fail closed
  // on unreadable directories or files.
  function walk(currentDir: string, relPrefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err: any) {
      const relDir = relPrefix || ".";
      const errMsg = stripResolvedRoot(`Failed to read worktree directory ${relDir}: ${err?.message ?? String(err)}`, worktreeRoot);
      const error: any = new Error(errMsg);
      error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
      error.path = relDir;
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      const fullPath = path.join(currentDir, ent.name);
      const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;

      // N-B11: only skip .git directories (at any depth) and root-level node_modules
      if (ent.name === ".git" || relPath === "node_modules") {
        continue;
      }

      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        walk(fullPath, relPath);
      } else if (ent.isFile()) {
        const opened = openCheckedFile(fullPath);
        if (!opened || !opened.ok) {
          const error: any = new Error(`Failed to open worktree file: ${relPath}`);
          error.code = (opened as any)?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
          error.path = relPath;
          throw error;
        }
        try {
          if (!descriptorRealPathInsideRoot(opened.fd, fullPath, realWorktreeRoot)) {
            const error: any = new Error(`Worktree file descriptor verification failed: ${relPath}`);
            error.code = "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
          let stat: fs.Stats;
          try {
            stat = fs.fstatSync(opened.fd);
          } catch (err: any) {
            const error: any = new Error(`Failed to stat worktree file ${relPath}: ${err?.message ?? String(err)}`);
            error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
          if (!stat.isFile()) {
            const error: any = new Error(`Worktree entry is not a regular file: ${relPath}`);
            error.code = "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
          chargeScanBudget(budget, stat.size, relPath);
          try {
            scanFdBounded(opened.fd, relPath, stat.size, accumulator);
          } catch (err: any) {
            if (err instanceof ScanLimitExceededError) {
              throw err;
            }
            const error: any = new Error(`Failed to scan worktree file ${relPath}: ${err?.message ?? String(err)}`);
            error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
            error.path = relPath;
            throw error;
          }
        } finally {
          fs.closeSync(opened.fd);
        }
      }
    }
  }

  if (fs.existsSync(worktreeRoot)) {
    let rootStat: fs.Stats;
    try {
      rootStat = fs.statSync(worktreeRoot);
    } catch (err: any) {
      const errMsg = stripResolvedRoot(`Failed to stat worktree root .: ${err?.message ?? String(err)}`, worktreeRoot);
      const error: any = new Error(errMsg);
      error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
      error.path = ".";
      throw error;
    }
    if (rootStat && rootStat.isDirectory()) {
      walk(worktreeRoot, "");
    }
  }

  // 3. Union, not fallback: scan caller-supplied lists sequentially.
  // Audit N-2 / N-B9: one O_NOFOLLOW descriptor backs the escape verification
  // and the scan, so a symlink swapped in after the escape check above is
  // refused (PATH_ESCAPE) instead of being followed.
  for (const list of callerLists) {
    if (!list) continue;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string") {
          const targetPath = path.resolve(worktreeRoot, item);
          const opened = openCheckedFile(targetPath);
          if (!opened.ok) {
            if (opened.symlinkRefused) {
              throw new PathEscapeError(item, sanitizePathEscapeFindings([item]));
            }
            if (opened.code === "ENOENT") {
              continue;
            }
            const error: any = new Error(`Failed to open worktree file: ${item}`);
            error.code = opened.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
            error.path = item;
            throw error;
          }
          try {
            if (!descriptorRealPathInsideRoot(opened.fd, targetPath, realWorktreeRoot)) {
              throw new PathEscapeError(item, sanitizePathEscapeFindings([item]));
            }
            let stat: fs.Stats;
            try {
              stat = fs.fstatSync(opened.fd);
            } catch (err: any) {
              const error: any = new Error(`Failed to stat worktree file ${item}: ${err?.message ?? String(err)}`);
              error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
              error.path = item;
              throw error;
            }
            if (!stat.isFile()) {
              const error: any = new Error(`Worktree entry is not a regular file: ${item}`);
              error.code = "SCAN_READ_ERROR";
              error.path = item;
              throw error;
            }
            chargeScanBudget(budget, stat.size, item);
            try {
              scanFdBounded(opened.fd, item, stat.size, accumulator);
            } catch (err: any) {
              if (err instanceof ScanLimitExceededError) {
                throw err;
              }
              const error: any = new Error(`Failed to scan worktree file ${item}: ${err?.message ?? String(err)}`);
              error.code = err?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
              error.path = item;
              throw error;
            }
          } finally {
            fs.closeSync(opened.fd);
          }
        } else if (item && typeof item === "object" && typeof (item as any).path === "string") {
          scanDirectContentBounded(
            (item as any).path,
            String((item as any).content ?? ""),
            accumulator,
            budget
          );
        }
      }
    } else if (typeof list === "object") {
      for (const [p, content] of Object.entries(list as Record<string, string>)) {
        scanDirectContentBounded(p, String(content ?? ""), accumulator, budget);
      }
    }
  }

  const hasSecrets = accumulator.violations.length > 0;
  const passed = accumulator.passed && !hasSecrets;
  const flaggedFiles = accumulator.flaggedFiles;

  return {
    hasSecrets,
    passed,
    shouldQuarantine: hasSecrets,
    violations: accumulator.violations,
    flaggedFiles,
    reason: hasSecrets
      ? `Quarantined: secret or sensitive pattern detected in changed worktree file(s): ${flaggedFiles.join(", ")}`
      : undefined,
  };
}

export const scanWorktreeBounded = scanWorktreeFilesBounded;

/**
 * Payload shape of a gateway execution event.
 */
type ExecutionEvent = {
  runId: string;
  kind: string;
  actor: string;
  skeletonId?: string;
  data: Record<string, unknown>;
};

/**
 * Builds a gateway execution event with a redacted payload (Audit N-B3).
 * argv and cwd are redacted here, before the event reaches EventStore.append
 * or onEmitEvent: every event built in this file must go through this helper,
 * so no call site can store or emit an event carrying unredacted payload text.
 */
function buildExecutionEvent(
  runId: string,
  kind: string,
  actor: string,
  data: Record<string, unknown>,
  skeletonId?: string
): ExecutionEvent {
  const event: ExecutionEvent =
    skeletonId !== undefined
      ? { runId, kind, actor, skeletonId, data }
      : { runId, kind, actor, data };
  return redactEvent(event);
}

/**
 * Records a security event (command.refused with security metadata) in EventStore and onEmitEvent.
 */
async function recordSecurityRefusal(
  runId: string,
  context: ToolExecutionContext,
  argv: string[],
  reason: string,
  ruleId: string,
  options?: ExecutionToolsOptions,
  findings?: unknown
): Promise<void> {
  let sanitizedFindings: unknown = findings;
  if (ruleId === "SECRET_DETECTED") {
    sanitizedFindings = sanitizeSecretFindings(findings);
  } else if (ruleId === "PATH_ESCAPE") {
    sanitizedFindings = sanitizePathEscapeFindings(findings);
  } else if (ruleId === "ESCAPING_SYMLINK") {
    sanitizedFindings = sanitizeEscapingSymlinkFindings(findings, context?.worktreeRoot);
  }

  const eventPayload = buildExecutionEvent(
    runId,
    "command.refused",
    (context?.role ? context.role.toLowerCase() : "unknown"),
    {
      argv,
      reason,
      ruleId,
      securityEvent: true,
      findings: sanitizedFindings,
      refs: [],
    },
    context.skeletonId
  );

  if (options?.eventStore && typeof options.eventStore.append === "function") {
    try {
      options.eventStore.append(eventPayload);
    } catch {
      // Safe fallback
    }
  }

  if (options?.onEmitEvent) {
    try {
      await options.onEmitEvent(eventPayload);
    } catch {
      // Safe fallback
    }
  }
}

/**
 * Safely converts an object to a Record of string to unknown through unknown first.
 * Prevents TS2352 conversion errors when inspecting Sandbox and ExecutionBackend values.
 */
function asRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === "object") {
    return (val as unknown) as Record<string, unknown>;
  }
  return null;
}

/**
 * Stops a finished command's processes and reports cleanup failures to the caller.
 * Requirement 20.11 / H-3 (R6-A2): a command's processes are stopped only through
 * that command's own process group. The caller passes the group id recorded for
 * that command (pgid). When no group id is known, no kill or sweep is claimed:
 * the sandbox and backend cleanup entry points are not invoked at all. No call in
 * this function passes a user name (Audit N-B8): the injected sweeper receives
 * only the command's pgid, and the user-wide sweep is removed. Errors from the
 * pgid-scoped cleanup propagate to the caller instead of being swallowed.
 */
export async function cleanupProcesses(
  backend?: ExecutionBackend,
  sandbox?: Sandbox,
  boxName: "runbox" | "auditbox" = "runbox",
  processSweeper?: ProcessSweeper,
  pgid?: number | string
): Promise<void> {
  // 1. Injected custom processSweeper: receives only the command's pgid, never
  // a user name (Audit N-B8)
  if (processSweeper) {
    try {
      await processSweeper(pgid);
    } catch {
      // Sweeper failure must not mask successful execution result
    }
  }

  // 2. Without the command's own group id there is no cleanup to claim (H-3)
  if (pgid === undefined || pgid === null) {
    return;
  }

  // 3. Sandbox-level process-group kill scoped to that command's pgid
  if (sandbox) {
    const sObj = asRecord(sandbox);
    if (sObj && typeof sObj.killProcessGroup === "function") {
      await (sObj.killProcessGroup as Function)(pgid);
    }
  }

  // 4. Backend-level cleanup scoped to that command's pgid
  if (backend) {
    const bObj = asRecord(backend);
    if (bObj) {
      const sandboxRecord = asRecord(sandbox);
      const target =
        sandboxRecord &&
        typeof sandboxRecord.containerId === "string" &&
        sandboxRecord.containerId
          ? sandboxRecord.containerId
          : sandbox ?? boxName;
      if (typeof bObj.sweepProcesses === "function") {
        await (bObj.sweepProcesses as Function)(target, pgid);
      } else if (typeof bObj.killProcessGroup === "function") {
        await (bObj.killProcessGroup as Function)(target, pgid);
      }
    }
  }
}


/**
 * Scans the worktree after sandbox_exec for escaping symlinks and secrets.
 * A finding ends the skeleton run, quarantines the worktree and fails the run.
 * Requirements 22.8, 22.9, 22.14, 22.15.
 */
async function runPostExecScans(
  resolvedRoot: string,
  runId: string,
  context: ToolExecutionContext,
  argv: string[],
  options?: ExecutionToolsOptions,
  params?: SandboxExecParams
): Promise<SandboxExecFatalResult | null> {
  if (fs.existsSync(resolvedRoot)) {
    const postSymlinkReport = scanForEscapingSymlinks(resolvedRoot);
    if (!postSymlinkReport.clean || postSymlinkReport.hasEscapingSymlinks || postSymlinkReport.hasEscapes) {
      const sanitizedFindings = sanitizeEscapingSymlinkFindings(postSymlinkReport.findings, resolvedRoot);
      const relativePaths = sanitizedFindings.map((f) => f.path).filter(Boolean);
      const reason =
        relativePaths.length > 0
          ? `Escaping symlink detected in worktree root after sandbox execution: ${relativePaths.join(", ")}`
          : "Escaping symlink detected in worktree root after sandbox execution (Requirements 22.8, 22.9)";

      await recordSecurityRefusal(
        runId,
        context,
        argv,
        reason,
        "ESCAPING_SYMLINK",
        options,
        sanitizedFindings
      );

      const skeletonFailEvent = buildExecutionEvent(
        runId,
        "skeleton.state",
        (context?.role ? context.role.toLowerCase() : "unknown"),
        {
          state: "failed",
          status: "failed",
          reason,
          quarantine: true,
          refs: [],
        },
        context.skeletonId
      );
      if (options?.eventStore && typeof options.eventStore.append === "function") {
        try { options.eventStore.append(skeletonFailEvent); } catch {}
      }
      if (options?.onEmitEvent) {
        try { await options.onEmitEvent(skeletonFailEvent); } catch {}
      }

    const runFailEvent = buildExecutionEvent(
      runId,
      "run.done",
      "supervisor",
      {
        status: "failed",
        outcome: "quarantined",
        reason,
        quarantine: true,
        refs: [],
      }
    );
    if (options?.eventStore && typeof options.eventStore.append === "function") {
      try { options.eventStore.append(runFailEvent); } catch {}
    }
    if (options?.onEmitEvent) {
      try { await options.onEmitEvent(runFailEvent); } catch {}
    }

    return {
      status: "fatal",
      fatal: true,
      quarantine: true,
      code: "ESCAPING_SYMLINK",
      error: reason,
      reason,
      findings: sanitizedFindings,
    };
  }
  }

  let postSecretScan: SecretScanResult;
  try {
    postSecretScan = scanWorktreeFilesBounded(resolvedRoot, context, options, params);
  } catch (err: unknown) {
    // Audit N-B4 (scan part): an over-limit scan fails closed as a fatal result
    // that carries a finding, instead of passing an unscanned worktree.
    if (err instanceof ScanLimitExceededError || (err && typeof err === "object" && (err as any).code === "SCAN_LIMIT_EXCEEDED")) {
      const limitErr = err as ScanLimitExceededError;
      const findings: RefusalFinding[] = limitErr.findings;
      const reason = limitErr.message;
      await recordSecurityRefusal(
        runId,
        context,
        argv,
        reason,
        "SCAN_LIMIT_EXCEEDED",
        options,
        findings
      );
      return {
        status: "fatal",
        fatal: true,
        quarantine: true,
        code: "SCAN_LIMIT_EXCEEDED",
        error: reason,
        reason,
        findings,
      };
    }
    if (err instanceof PathEscapeError || (err && typeof err === "object" && (err as any).code === "PATH_ESCAPE")) {
      const escapeErr = err as PathEscapeError;
      const findings: RefusalFinding[] = escapeErr.findings ?? sanitizePathEscapeFindings([escapeErr.path]);
      const reason = `Path escape detected: ${escapeErr.path}`;
      await recordSecurityRefusal(
        runId,
        context,
        argv,
        reason,
        "PATH_ESCAPE",
        options,
        findings
      );
      return {
        status: "fatal",
        fatal: true,
        quarantine: true,
        code: "PATH_ESCAPE",
        error: reason,
        reason,
        findings,
      };
    }
    // Fail-closed for non-ScanLimitExceeded scan/read errors
    const errMsg = (err as any)?.message ?? String(err);
    const sanitizedErrMsg = stripResolvedRoot(errMsg, resolvedRoot);
    const reason = stripResolvedRoot(`Worktree scan failed: ${sanitizedErrMsg}`, resolvedRoot);
    const code = (err as any)?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
    const findings: RefusalFinding[] = [{
      path: toWorktreeRelativePath((err as any)?.path ?? resolvedRoot, resolvedRoot),
      ruleId: "SCAN_READ_ERROR",
      fingerprint: computeFingerprint(sanitizedErrMsg),
    }];
    await recordSecurityRefusal(
      runId,
      context,
      argv,
      reason,
      code,
      options,
      findings
    );
    const skeletonFailEvent = buildExecutionEvent(
      runId,
      "skeleton.state",
      (context?.role ? context.role.toLowerCase() : "unknown"),
      {
        state: "failed",
        status: "failed",
        reason,
        quarantine: true,
        refs: [],
      },
      context.skeletonId
    );
    if (options?.eventStore && typeof options.eventStore.append === "function") {
      try { options.eventStore.append(skeletonFailEvent); } catch {}
    }
    if (options?.onEmitEvent) {
      try { await options.onEmitEvent(skeletonFailEvent); } catch {}
    }
    const runFailEvent = buildExecutionEvent(
      runId,
      "run.done",
      "supervisor",
      {
        status: "failed",
        outcome: "quarantined",
        reason,
        quarantine: true,
        refs: [],
      }
    );
    if (options?.eventStore && typeof options.eventStore.append === "function") {
      try { options.eventStore.append(runFailEvent); } catch {}
    }
    if (options?.onEmitEvent) {
      try { await options.onEmitEvent(runFailEvent); } catch {}
    }
    return {
      status: "fatal",
      fatal: true,
      quarantine: true,
      code,
      error: reason,
      reason,
      findings,
    };
  }

  if (!postSecretScan.passed || postSecretScan.hasSecrets) {
    const sanitizedFindings = sanitizeSecretFindings(postSecretScan.violations);
    const reason = redactText(
      postSecretScan.reason ??
      "Secret or sensitive pattern detected in worktree files after sandbox execution (Requirements 22.14, 22.15)"
    );

      await recordSecurityRefusal(
        runId,
        context,
        argv,
        reason,
        "SECRET_DETECTED",
        options,
        sanitizedFindings
      );

      const skeletonFailEvent = buildExecutionEvent(
        runId,
        "skeleton.state",
        context.role.toLowerCase(),
        {
          state: "failed",
          status: "failed",
          reason,
          quarantine: true,
          refs: [],
        },
        context.skeletonId
      );
      if (options?.eventStore && typeof options.eventStore.append === "function") {
        try { options.eventStore.append(skeletonFailEvent); } catch {}
      }
      if (options?.onEmitEvent) {
        try { await options.onEmitEvent(skeletonFailEvent); } catch {}
      }

      const runFailEvent = buildExecutionEvent(
        runId,
        "run.done",
        "supervisor",
        {
          status: "failed",
          outcome: "quarantined",
          reason,
          quarantine: true,
          refs: [],
        }
      );
      if (options?.eventStore && typeof options.eventStore.append === "function") {
        try { options.eventStore.append(runFailEvent); } catch {}
      }
      if (options?.onEmitEvent) {
        try { await options.onEmitEvent(runFailEvent); } catch {}
      }

      return {
        status: "fatal",
        fatal: true,
        quarantine: true,
        code: "SECRET_DETECTED",
        error: reason,
        reason,
        findings: sanitizedFindings,
      };
    }

  return null;
}

/**
 * Handles the sandbox_exec MCP tool invocation.
 * Requirements: 19.5-19.9, 19.19, 20.4, 20.6-20.12, 22.8, 22.9, 22.14, 22.15.
 */
export async function handleSandboxExec(
  params: SandboxExecParams,
  context: ToolExecutionContext,
  options?: ExecutionToolsOptions
): Promise<SandboxExecResult> {
  // 1. Validate params as a plain object first (L-5)
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      status: "refused",
      error: "params must be a plain object",
      code: "INVALID_PARAMS",
    };
  }

  // Validate scan limits settings (throws ConfigurationError if provided as invalid/non-positive)
  validateScanLimits(options);

  const approvalMgr =
    options?.approvalManager ??
    (options?.approvalWaitMs !== undefined &&
    typeof options.approvalWaitMs === "number" &&
    Number.isSafeInteger(options.approvalWaitMs) &&
    options.approvalWaitMs >= 1
      ? new ApprovalManager({
          defaultWaitMs: options.approvalWaitMs,
        })
      : undefined);

  // 2. Validate worktreeRoot is provided (Requirement 19.5)
  if (!context?.worktreeRoot || typeof context.worktreeRoot !== "string" || !context.worktreeRoot.trim()) {
    return {
      status: "refused",
      error: "Caller worktreeRoot is required (Requirement 19.5)",
      code: "WORKTREE_ROOT_REQUIRED",
    };
  }

  // 3. Validate caller role is provided (Audit L-5)
  if (!context?.role || typeof context.role !== "string" || !context.role.trim()) {
    return {
      status: "refused",
      error: "Caller role is required",
      code: "ROLE_REQUIRED",
    };
  }

  // 4. Validate argv is strictly an array of strings (Requirement 20.12)
  if (!Array.isArray(params.argv) || params.argv.length === 0) {
    return {
      status: "refused",
      error: "Command must be provided strictly as a non-empty argv array (Requirement 20.12)",
      code: "INVALID_ARGV",
    };
  }

  if (params.argv.some((arg) => typeof arg !== "string")) {
    return {
      status: "refused",
      error: "All argv elements must be strings (Requirement 20.12)",
      code: "INVALID_ARGV",
    };
  }

  // 5. Validate context.runId is provided (M-3, no run-default fallback)
  if (!context?.runId || typeof context.runId !== "string" || !context.runId.trim()) {
    return {
      status: "refused",
      error: "Caller runId is required",
      code: "RUN_ID_REQUIRED",
    };
  }
  const runId = context.runId.trim();

  // 6. Validate cwd type if supplied (Audit L-5)
  if (params.cwd !== undefined && typeof params.cwd !== "string") {
    return {
      status: "refused",
      error: "cwd must be a string",
      code: "INVALID_CWD",
    };
  }

  const resolvedRoot = path.resolve(context.worktreeRoot);
  const cwd = params.cwd ? path.resolve(resolvedRoot, params.cwd) : resolvedRoot;

  // 7. Validate timeoutMs if supplied (L-5: positive safe integer)
  if (
    params.timeoutMs !== undefined &&
    (typeof params.timeoutMs !== "number" ||
      !Number.isSafeInteger(params.timeoutMs) ||
      params.timeoutMs < 1)
  ) {
    return {
      status: "refused",
      error: "timeoutMs must be a positive safe integer (zero, negative, and non-integer values are refused)",
      code: "INVALID_TIMEOUT",
    };
  }

  // 8. Validate approvalTtlMs if supplied (Audit L-5: finite positive number)
  if (
    params.approvalTtlMs !== undefined &&
    (typeof params.approvalTtlMs !== "number" ||
      !Number.isFinite(params.approvalTtlMs) ||
      params.approvalTtlMs <= 0 ||
      Number.isNaN(params.approvalTtlMs))
  ) {
    return {
      status: "refused",
      error: "approvalTtlMs must be a finite positive number",
      code: "INVALID_APPROVAL_TTL",
    };
  }

  // 9. Validate cwd lies within caller worktree (Requirement 19.5)
  if (!isInsideWorktree(cwd, resolvedRoot)) {
    const genericReason = "Requested cwd resolves outside worktree root";
    return {
      status: "refused",
      error: genericReason,
      code: "CWD_OUTSIDE_WORKTREE",
    };
  }

  // 3.4 Validate caller-supplied file lists for path escapes first (Requirement 1, audit N-1)
  const callerLists: unknown[] = [
    params.files,
    (context as any)?.files,
    (context as any)?.worktreeFiles,
    (options as any)?.worktreeFiles,
  ];

  let realWorktreeRoot: string;
  try {
    realWorktreeRoot = fs.realpathSync(resolvedRoot);
  } catch {
    realWorktreeRoot = resolvedRoot;
  }

  const callerEscapes: string[] = [];
  for (const list of callerLists) {
    if (!list) continue;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string") {
          if (checkPathEscape(item, resolvedRoot, realWorktreeRoot)) {
            callerEscapes.push(item);
          }
        } else if (item && typeof item === "object" && typeof (item as any).path === "string") {
          if (checkPathEscape((item as any).path, resolvedRoot, realWorktreeRoot)) {
            callerEscapes.push((item as any).path);
          }
        }
      }
    } else if (typeof list === "object") {
      for (const p of Object.keys(list as Record<string, unknown>)) {
        if (checkPathEscape(p, resolvedRoot, realWorktreeRoot)) {
          callerEscapes.push(p);
        }
      }
    }
  }

  if (callerEscapes.length > 0) {
    const findings = sanitizePathEscapeFindings(callerEscapes);
    const reason = `Path escape detected: ${callerEscapes[0]}`;
    await recordSecurityRefusal(
      runId,
      context,
      params.argv,
      reason,
      "PATH_ESCAPE",
      options,
      findings
    );
    return {
      status: "refused",
      error: reason,
      code: "PATH_ESCAPE",
      findings,
    };
  }

  // 3.5 Pre-execution security scans: escaping symlinks and worktree secrets (Requirements 22.8, 22.14, 22.15, 42.5)
  if (fs.existsSync(resolvedRoot)) {
    const symlinkReport = scanForEscapingSymlinks(resolvedRoot);
    if (!symlinkReport.clean || symlinkReport.hasEscapingSymlinks || symlinkReport.hasEscapes) {
      const sanitizedFindings = sanitizeEscapingSymlinkFindings(symlinkReport.findings, resolvedRoot);
      const relativePaths = sanitizedFindings.map((f) => f.path).filter(Boolean);
      const reason =
        relativePaths.length > 0
          ? `Escaping symlink detected in worktree root: ${relativePaths.join(", ")}`
          : "Escaping symlink detected in worktree root (Requirements 22.8, 22.9, 45.10)";
      await recordSecurityRefusal(
        runId,
        context,
        params.argv,
        reason,
        "ESCAPING_SYMLINK",
        options,
        sanitizedFindings
      );
      return {
        status: "refused",
        error: reason,
        code: "ESCAPING_SYMLINK",
        findings: sanitizedFindings,
      };
    }
  }

  let secretScan: SecretScanResult;
  try {
    secretScan = scanWorktreeFilesBounded(resolvedRoot, context, options, params);
  } catch (err: unknown) {
    // Audit N-B4 (scan part): an over-limit scan fails closed as a refusal that
    // carries a finding, before any command is dispatched.
    if (err instanceof ScanLimitExceededError || (err && typeof err === "object" && (err as any).code === "SCAN_LIMIT_EXCEEDED")) {
      const limitErr = err as ScanLimitExceededError;
      const findings: RefusalFinding[] = limitErr.findings;
      const reason = limitErr.message;
      await recordSecurityRefusal(
        runId,
        context,
        params.argv,
        reason,
        "SCAN_LIMIT_EXCEEDED",
        options,
        findings
      );
      return {
        status: "refused",
        error: reason,
        code: "SCAN_LIMIT_EXCEEDED",
        findings,
      };
    }
    if (err instanceof PathEscapeError || (err && typeof err === "object" && (err as any).code === "PATH_ESCAPE")) {
      const escapeErr = err as PathEscapeError;
      const findings: RefusalFinding[] = escapeErr.findings ?? sanitizePathEscapeFindings([escapeErr.path]);
      const reason = `Path escape detected: ${escapeErr.path}`;
      await recordSecurityRefusal(
        runId,
        context,
        params.argv,
        reason,
        "PATH_ESCAPE",
        options,
        findings
      );
      return {
        status: "refused",
        error: reason,
        code: "PATH_ESCAPE",
        findings,
      };
    }
    if (err instanceof ConfigurationError) {
      throw err;
    }
    const errMsg = (err as any)?.message ?? String(err);
    const sanitizedErrMsg = stripResolvedRoot(errMsg, resolvedRoot);
    const reason = stripResolvedRoot(`Worktree scan failed: ${sanitizedErrMsg}`, resolvedRoot);
    const code = (err as any)?.code === "EACCES" ? "EACCES" : "SCAN_READ_ERROR";
    const findings: RefusalFinding[] = [{
      path: toWorktreeRelativePath((err as any)?.path ?? resolvedRoot, resolvedRoot),
      ruleId: "SCAN_READ_ERROR",
      fingerprint: computeFingerprint(sanitizedErrMsg),
    }];
    await recordSecurityRefusal(
      runId,
      context,
      params.argv,
      reason,
      code,
      options,
      findings
    );
    return {
      status: "refused",
      error: reason,
      code,
      findings,
    };
  }

  if (!secretScan.passed || secretScan.hasSecrets) {
    const sanitizedFindings = sanitizeSecretFindings(secretScan.violations);
    const reason = redactText(
      secretScan.reason ??
      "Secret or sensitive pattern detected in worktree files (Requirements 22.14, 22.15, 42.5)"
    );
    await recordSecurityRefusal(
      runId,
      context,
      params.argv,
      reason,
      "SECRET_DETECTED",
      options,
      sanitizedFindings
    );
    return {
      status: "refused",
      error: reason,
      code: "SECRET_DETECTED",
      findings: sanitizedFindings,
    };
  }

  // 4. Classify command argv using committed Command Policy (Requirements 20.1, 20.4, 20.5)
  const classification = classifyCommand(params.argv, {
    cwd,
    worktreeRoot: resolvedRoot,
  });

  // 5. Handle Hard_Block: start no process, emit command.refused, return status blocked
  // (Requirements 20.4, 20.10, 29.10, 29.11, 29.12)
  if (classification.classification === "blocked") {
    const refusedEvent = buildExecutionEvent(
      runId,
      "command.refused",
      context.role.toLowerCase(),
      {
        argv: params.argv,
        reason: classification.reason ?? "Blocked by Command Policy",
        ruleId: classification.matchedRule,
        refs: [],
      },
      context.skeletonId
    );

    if (options?.eventStore && typeof options.eventStore.append === "function") {
      try {
        options.eventStore.append(refusedEvent);
      } catch {
        // Safe fallback
      }
    }

    if (options?.onEmitEvent) {
      await options.onEmitEvent(refusedEvent);
    }

    return {
      status: "blocked",
      reason: classification.reason ?? "Command blocked by hard security policy",
    };
  }

  // 6. Handle needs_approval (Requirements 20.5, 20.6, 20.7, 20.8)
  if (classification.classification === "needs_approval") {
    if (!approvalMgr) {
      throw new ConfigurationError("ApprovalManager or approvalWaitMs setting is required for approval handling");
    }

    // Check if presented approvalId is expired (Requirement 20.14)
    if (params.approvalId && approvalMgr.isRequestExpired(params.approvalId)) {
      const expired = await approvalMgr.handleExpiredRequest(params.approvalId);
      return {
        status: "blocked",
        reason:
          expired?.reason ??
          "Approval request unanswered past deadline; treated as denied (Requirement 20.14)",
      };
    }

    const isApproved = approvalMgr.checkAndConsumeApproval(
      runId,
      context.skeletonId,
      params.argv,
      cwd,
      params.approvalId
    );

    if (!isApproved) {
      // Clamp approvalTtlMs to Admin configuration limit (agent may lower, never raise)
      const adminApprovalLimit =
        options?.approvalWaitMs ?? approvalMgr.defaultWaitMs;
      if (
        adminApprovalLimit === undefined ||
        typeof adminApprovalLimit !== "number" ||
        !Number.isSafeInteger(adminApprovalLimit) ||
        adminApprovalLimit < 1
      ) {
        return {
          status: "refused",
          error: "Missing required approval wait limit: approvalWaitMs must be configured as a positive safe integer",
          code: "MISSING_APPROVAL_TIMEOUT_SETTING",
        };
      }
      const approvalTtlMs =
        typeof params.approvalTtlMs === "number"
          ? Math.min(params.approvalTtlMs, adminApprovalLimit)
          : adminApprovalLimit;

      const approvalReq = await approvalMgr.requestApproval(
        runId,
        context.skeletonId,
        params.argv,
        cwd,
        approvalTtlMs
      );

      return {
        status: "approval_pending",
        approvalId: approvalReq.approvalId,
        expiresAt: approvalReq.expiresAt,
      };
    }
  }

  // 7. Command is allowed or approved: dispatch to execution backend (Requirements 19.6, 19.7, 19.19)
  // Builders (Exhumer, Bonesetter, Soul-stitcher) run in Runbox; Warden runs in Auditbox (Requirement 19.6)
  const isWarden = context.role.toLowerCase() === "warden";
  const box: "runbox" | "auditbox" = isWarden ? "auditbox" : "runbox";

  // Resolve target sandbox from context or options BEFORE emitting command.started
  // Requirement (2): NO_SANDBOX_AVAILABLE is returned before command.started is emitted
  const backend = context.backend ?? options?.backend;
  let targetSandbox: Sandbox | undefined = isWarden
    ? (context.auditbox ?? options?.auditbox)
    : (context.runbox ?? options?.runbox);

  if (!targetSandbox && backend) {
    const backendObj = asRecord(backend);
    if (backendObj) {
      if (isWarden && backendObj.auditbox) {
        targetSandbox = (backendObj.auditbox as unknown) as Sandbox;
      } else if (!isWarden && backendObj.runbox) {
        targetSandbox = (backendObj.runbox as unknown) as Sandbox;
      } else if (typeof backendObj.getBox === "function") {
        try {
          targetSandbox = (await (backendObj.getBox as Function)(box)) as Sandbox;
        } catch {
          // ignore resolution error
        }
      } else if (typeof backend.get === "function") {
        try {
          targetSandbox = (await backend.get(box)) ?? (await backend.get(`${box}-${runId}`));
        } catch {
          // ignore resolution error
        }
      }
    }
  }

  // Requirement (1) No host execution: sandbox_exec runs only through the sandbox
  const sandboxObj = asRecord(targetSandbox);
  const hasSandbox =
    typeof targetSandbox === "function" ||
    (sandboxObj && (typeof sandboxObj.run === "function" || typeof sandboxObj.exec === "function"));

  if (!hasSandbox) {
    return {
      status: "refused",
      error: "No sandbox is available for execution (host execution is forbidden)",
      code: "NO_SANDBOX_AVAILABLE",
    };
  }

  // Timeouts and limits come from the injected settings object (M-3)
  const adminTimeoutLimit = options?.defaultTimeoutMs;
  if (
    adminTimeoutLimit === undefined ||
    adminTimeoutLimit === null ||
    typeof adminTimeoutLimit !== "number" ||
    !Number.isSafeInteger(adminTimeoutLimit) ||
    adminTimeoutLimit < 1
  ) {
    return {
      status: "refused",
      error: "Missing required timeout setting: defaultTimeoutMs must be configured as a positive safe integer",
      code: "MISSING_TIMEOUT_SETTING",
    };
  }
  if (params.timeoutMs !== undefined && params.timeoutMs > adminTimeoutLimit) {
    return {
      status: "refused",
      error: `timeoutMs (${params.timeoutMs}) exceeds maximum allowed timeout setting (${adminTimeoutLimit})`,
      code: "INVALID_TIMEOUT",
    };
  }
  const timeoutMs =
    params.timeoutMs !== undefined
      ? params.timeoutMs
      : adminTimeoutLimit;

  if (!options?.logStore) {
    return {
      status: "refused",
      error: "Missing required LogStore configuration (in-memory fallback is disabled)",
      code: "CONFIGURATION_ERROR",
    };
  }
  const store = options.logStore;
  const logRef = generateLogRef(runId);

  // Emit command.started ONLY after confirming sandbox availability (Requirement 2)
  const startedEvent = buildExecutionEvent(
    runId,
    "command.started",
    context.role.toLowerCase(),
    {
      argv: params.argv,
      cwd,
      box,
      logRef,
      timeoutMs,
      refs: [],
    },
    context.skeletonId
  );

  if (options?.eventStore && typeof options.eventStore.append === "function") {
    try {
      options.eventStore.append(startedEvent);
    } catch {
      // Safe fallback
    }
  }

  if (options?.onEmitEvent) {
    await options.onEmitEvent(startedEvent);
  }

  // Group id recorded for this command (H-3, R6-A2): the exec() process object
  // carries the pgid the backend assigned to the command. When no pgid is
  // recorded, cleanup must not claim a kill or sweep happened.
  let commandPgid: number | string | undefined;

  // Dispatch outcome and failure tracking (Audit N-B5): the post-exec scans below
  // run after the finally block, so they run on success, on dispatch failure, and
  // after a cleanup failure alike, and no cleanup error can hide their results.
  let execOutcome: SandboxExecResult | null = null;
  let execError: unknown = null;
  let cleanupError: unknown = null;
  let stillRunning = false;

  try {
    let result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut?: boolean;
      running?: boolean;
    };

    if (typeof targetSandbox === "function") {
      result = await (targetSandbox as Function)(params.argv, {
        cwd,
        box,
        timeoutMs,
        logRef,
        runId,
      });
    } else if (sandboxObj && typeof sandboxObj.run === "function") {
      const runRes = await (targetSandbox!.run as (req: ExecRequest) => Promise<ExecResult>)({
        argv: params.argv,
        cwd,
        timeoutMs,
        logRef,
      });
      const isRunning =
        (asRecord(runRes)?.running as boolean | undefined) === true ||
        (runRes.exitCode === null && !runRes.timedOut);
      result = {
        exitCode: runRes.exitCode ?? (runRes.timedOut ? 124 : 0),
        stdout: runRes.stdoutTail ?? "",
        stderr: runRes.stderrTail ?? "",
        timedOut: Boolean(runRes.timedOut),
        running: isRunning,
      };
    } else if (sandboxObj && typeof sandboxObj.exec === "function") {
      const proc = await (targetSandbox!.exec as (req: ExecRequest) => Promise<ExecProcess>)({
        argv: params.argv,
        cwd,
        timeoutMs,
        logRef,
      });
      const procRecord = asRecord(proc);
      const procPgid = procRecord?.pgid;
      if (typeof procPgid === "number" && Number.isSafeInteger(procPgid) && procPgid > 1) {
        commandPgid = procPgid;
      } else if (typeof procPgid === "string" && /^\d+$/.test(procPgid.trim()) && Number(procPgid.trim()) > 1) {
        commandPgid = procPgid.trim();
      }
      let stdout = "";
      let stderr = "";
      if (proc.output && typeof (proc.output as AsyncIterable<ExecChunk>)[Symbol.asyncIterator] === "function") {
        try {
          for await (const chunk of proc.output) {
            if (chunk.stream === "stderr") {
              stderr += typeof chunk.data === "string" ? chunk.data : String(chunk.data ?? "");
            } else {
              stdout += typeof chunk.data === "string" ? chunk.data : String(chunk.data ?? "");
            }
          }
        } catch {
          // ignore streaming read errors
        }
      }
      let waitRes: { exitCode: number | null; signal?: string; timedOut?: boolean; oomKilled?: boolean } = {
        exitCode: 0,
      };
      if (typeof proc.wait === "function") {
        waitRes = await proc.wait();
      }
      result = {
        exitCode: waitRes.exitCode ?? (waitRes.timedOut ? 124 : 0),
        stdout,
        stderr,
        timedOut: Boolean(waitRes.timedOut),
        running: waitRes.exitCode === null && !waitRes.timedOut,
      };
    } else {
      return {
        status: "refused",
        error: "No sandbox is available for execution (host execution is forbidden)",
        code: "NO_SANDBOX_AVAILABLE",
      };
    }

    // After execution: run redactor text scan on captured output and store only redacted text
    const redactedStdout = redactText(result.stdout);
    const redactedStderr = redactText(result.stderr);

    // Handle continuing executions returning status running (Requirement 19.9)
    if (result.running) {
      store.storeCommandOutput({
        logRef,
        runId,
        stdout: redactedStdout,
        stderr: redactedStderr,
        exitCode: null,
        timedOut: false,
        metadata: {
          skeletonId: context.skeletonId,
          runId,
        },
      });

      // The command keeps its process group alive (Requirement 19.9): no cleanup
      // is claimed for a still-running command. Post-exec scans still run below.
      stillRunning = true;
      execOutcome = {
        status: "running",
        log_ref: logRef,
      };
    } else {
      // Store completed command output in LogStore (Requirements 19.8, 19.10)
      const stored = store.storeCommandOutput({
        logRef,
        runId,
        stdout: redactedStdout,
        stderr: redactedStderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        metadata: {
          skeletonId: context.skeletonId,
          runId,
        },
      });

      // Emit command.result (Requirement 19.19)
      const resultEvent = buildExecutionEvent(
        runId,
        "command.result",
        context.role.toLowerCase(),
        {
          argv: params.argv,
          box,
          exitCode: result.exitCode,
          logRef,
          timedOut: !!result.timedOut,
          truncated: stored.truncated,
          refs: [],
        },
        context.skeletonId
      );

      if (options?.eventStore && typeof options.eventStore.append === "function") {
        try {
          options.eventStore.append(resultEvent);
        } catch {
          // Safe fallback
        }
      }

      if (options?.onEmitEvent) {
        await options.onEmitEvent(resultEvent);
      }

      // Return completed execution output (Requirement 19.8)
      execOutcome = {
        status: "completed",
        exit_code: stored.exitCode ?? result.exitCode,
        stdout_tail: stored.stdoutTail,
        stderr_tail: stored.stderrTail,
        truncated: stored.truncated,
        log_ref: logRef,
      };
    }
  } catch (err) {
    execError = err;
  } finally {
    // Cleanup always runs for finished commands, even when the dispatch or the
    // output storage failed (Audit N-B5). Stop only this command's process group
    // when its pgid was recorded (Requirement 20.11, H-3); without a recorded pgid
    // no kill or sweep is claimed and no user-wide sweep runs.
    if (!stillRunning) {
      try {
        await cleanupProcesses(backend, targetSandbox, box, options?.processSweeper, commandPgid);
      } catch (cleanupErr) {
        // The cleanup error is recorded as an event and does not hide the
        // post-exec scan results below (Audit N-B5).
        cleanupError = cleanupErr;
        const cleanupFailEvent = buildExecutionEvent(
          runId,
          "command.cleanup_failed",
          context.role.toLowerCase(),
          {
            argv: params.argv,
            reason: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            refs: [],
          },
          context.skeletonId
        );
        if (options?.eventStore && typeof options.eventStore.append === "function") {
          try { options.eventStore.append(cleanupFailEvent); } catch {}
        }
        if (options?.onEmitEvent) {
          try { await options.onEmitEvent(cleanupFailEvent); } catch {}
        }
      }
    }
  }

  // Post-execution security scans always run: escaping symlinks and worktree
  // secrets (Requirements 22.8, 22.9, 22.14, 22.15; Audit N-B5). They run after
  // success, after a dispatch failure, and after a cleanup failure alike.
  const postExecFatal = await runPostExecScans(
    resolvedRoot,
    runId,
    context,
    params.argv,
    options,
    params
  );
  if (postExecFatal) {
    return postExecFatal;
  }

  // A cleanup error surfaces to the caller (R6-A2), but only after the scan
  // results above have been recorded, so it never hides them.
  if (cleanupError !== null) {
    throw cleanupError;
  }

  if (execError !== null) {
    const errorMsg = execError instanceof Error ? execError.message : String(execError);
    const redactedError = redactText(errorMsg);
    store.storeCommandOutput({
      logRef,
      runId,
      stdout: "",
      stderr: redactedError,
      exitCode: 1,
      metadata: {
        skeletonId: context.skeletonId,
        runId,
      },
    });

    return {
      status: "completed",
      exit_code: 1,
      stdout_tail: "",
      stderr_tail: redactedError,
      truncated: false,
      log_ref: logRef,
    };
  }

  return execOutcome as SandboxExecResult;
}

/**
 * Handles the sandbox_log MCP tool invocation.
 * Returns log slice by offset and limit, returning exit status once finished.
 * Requirement 19.10.
 */
export async function handleSandboxLog(
  params: SandboxLogParams,
  context: ToolExecutionContext,
  options?: ExecutionToolsOptions
): Promise<SandboxLogResult> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid sandbox_log: params must be a plain object");
  }
  if (typeof params.log_ref !== "string" || !params.log_ref.trim()) {
    throw new Error("Invalid sandbox_log: log_ref must be a non-empty string");
  }

  const offset = typeof params.offset === "number" && params.offset >= 0 ? params.offset : 0;

  if (!options?.logStore) {
    return {
      log_ref: params.log_ref,
      slice: "",
      offset,
      limit: typeof params.limit === "number" && params.limit > 0 ? params.limit : 0,
      total: 0,
      hasMore: false,
      exit_code: null,
      status: "refused",
      error: "Missing required LogStore configuration (in-memory fallback is disabled)",
      code: "CONFIGURATION_ERROR",
    };
  }
  const store = options.logStore;

  let limit: number;
  if (params.limit !== undefined) {
    if (
      typeof params.limit !== "number" ||
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1
    ) {
      return {
        log_ref: params.log_ref,
        slice: "",
        offset,
        limit: 0,
        total: 0,
        hasMore: false,
        exit_code: null,
        status: "refused",
        error: "limit must be a positive safe integer",
        code: "INVALID_LIMIT",
      };
    }
    limit = params.limit;
  } else {
    const adminLogLimit = options?.defaultLogLimit ?? (options as any)?.defaultLimit;
    if (
      adminLogLimit === undefined ||
      adminLogLimit === null ||
      typeof adminLogLimit !== "number" ||
      !Number.isSafeInteger(adminLogLimit) ||
      adminLogLimit < 1
    ) {
      return {
        log_ref: params.log_ref,
        slice: "",
        offset,
        limit: 0,
        total: 0,
        hasMore: false,
        exit_code: null,
        status: "refused",
        error: "Missing required log read limit setting: defaultLogLimit must be configured as a positive safe integer",
        code: "MISSING_LOG_LIMIT_SETTING",
      };
    }
    limit = adminLogLimit;
  }

  if (!context?.runId || typeof context.runId !== "string" || !context.runId.trim()) {
    return {
      log_ref: params.log_ref,
      slice: "",
      offset,
      limit,
      total: 0,
      hasMore: false,
      exit_code: null,
      status: "refused",
      error: "Caller runId is required",
      code: "RUN_ID_REQUIRED",
    };
  }

  const record = store.getLogRecord(params.log_ref);
  if (!record) {
    return {
      log_ref: params.log_ref,
      slice: "",
      offset,
      limit,
      total: 0,
      hasMore: false,
      exit_code: null,
      status: "not-found",
      error: "not-found",
      code: "NOT_FOUND",
    };
  }

  // Check log ownership: must belong to calling runId and skeletonId (Requirement 19.10)
  const recordRunId = record.runId ?? (record.metadata?.runId as string | undefined);
  const recordSkeletonId =
    (record.metadata?.skeletonId as string | undefined) ??
    (record.metadata?.actor as string | undefined);

  const callingRunId = context.runId.trim();
  const callingSkeletonId = context.skeletonId;

  if (
    recordRunId !== callingRunId ||
    recordSkeletonId !== callingSkeletonId
  ) {
    return {
      log_ref: params.log_ref,
      slice: "",
      offset,
      limit,
      total: 0,
      hasMore: false,
      exit_code: null,
      status: "not-found",
      error: "not-found",
      code: "NOT_FOUND",
    };
  }

  const slice = store.getLogSlice(params.log_ref, {
    offset,
    limit,
    unit: "lines",
  });

  const exitCode = record ? record.exitCode ?? null : null;
  const status = record
    ? record.exitCode !== undefined && record.exitCode !== null
      ? "finished"
      : "running"
    : "unknown";

  return {
    log_ref: params.log_ref,
    slice: slice.content,
    offset: slice.offset,
    limit: slice.limit,
    total: slice.total,
    hasMore: slice.hasMore,
    exit_code: exitCode,
    status,
  };
}
