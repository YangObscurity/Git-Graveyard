import path from "node:path";

/**
 * Maximum sync file size in bytes.
 * The spec does not fix the size value: define MAX_SYNC_FILE_BYTES with a comment that says so.
 */
export const MAX_SYNC_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB default; size value not fixed by spec

export interface SyncFileEntry {
  path: string;
  size?: number;
  content?: string | Uint8Array;
  bytes?: Uint8Array;
  isSymlink?: boolean;
  isSymbolicLink?: boolean;
  type?: string;
  target?: string;
  mode?: number;
  [key: string]: unknown;
}

export interface SyncValidationOptions {
  maxBytes?: number;
  throwOnError?: boolean;
}

export class SyncValidationError extends Error {
  readonly ok = false as const;
  readonly code = "SYNC_VALIDATION_ERROR" as const;
  readonly reason: string;
  readonly path?: string;

  constructor(reason: string, filePath?: string, message?: string) {
    const msg = message ?? `Sync validation rejected path '${filePath ?? "unknown"}': ${reason}`;
    super(msg);
    this.name = "SyncValidationError";
    this.reason = reason;
    this.path = filePath;
    Object.setPrototypeOf(this, SyncValidationError.prototype);
  }
}

export interface SyncPathCheckResult {
  valid: boolean;
  ok: boolean;
  reason?: string;
  error?: SyncValidationError;
}

export interface SyncOutReport {
  valid: boolean;
  ok: boolean;
  accepted: string[];
  rejected: Array<{ path: string; reason: string }>;
  errors: SyncValidationError[];
}

/**
 * Checks if path is an absolute path on POSIX or Windows.
 */
function isAbsolutePath(p: string): boolean {
  if (typeof p !== "string") {
    return true;
  }
  const trimmed = p.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return true;
  }
  if (/^[a-zA-Z]:[/\\]?/.test(trimmed)) {
    return true;
  }
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Checks for parent traversal (..) in raw path segments and normalized paths.
 */
function hasParentTraversal(p: string): boolean {
  if (typeof p !== "string") {
    return true;
  }
  const rawSegments = p.split(/[/\\]/);
  for (const seg of rawSegments) {
    if (seg === "..") {
      return true;
    }
  }

  const normalizedPosix = path.posix.normalize(p.replace(/\\/g, "/"));
  if (
    normalizedPosix === ".." ||
    normalizedPosix.startsWith("../") ||
    normalizedPosix.includes("/../")
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if path targets .git/ or .kiro/ trees.
 */
function isGitOrKiroPath(p: string): boolean {
  if (typeof p !== "string") {
    return true;
  }
  const segments = p.split(/[/\\]/).filter((s) => s.length > 0);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower === ".git" || lower === ".kiro") {
      return true;
    }
  }
  return false;
}

/**
 * Checks if path points inside build output directories.
 * Requirement 21.15, 43.15.
 */
export function isExcludedBuildOutput(p: string): boolean {
  if (typeof p !== "string") {
    return false;
  }
  const segments = p.split(/[/\\]/).filter((s) => s.length > 0);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower === "node_modules" || lower === "dist" || lower === ".next") {
      return true;
    }
  }
  return false;
}

/**
 * Validates a single path string against absolute paths, traversal, and .git/.kiro directories.
 */
export function checkSyncPath(filePath: string): SyncPathCheckResult {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    const reason = "Path must be a non-empty string";
    const error = new SyncValidationError(reason, filePath);
    return { valid: false, ok: false, reason, error };
  }

  const trimmed = filePath.trim();

  // Reject absolute paths
  if (isAbsolutePath(trimmed)) {
    const reason = "Absolute paths are forbidden";
    const error = new SyncValidationError(reason, trimmed);
    return { valid: false, ok: false, reason, error };
  }

  // Reject parent traversal (..)
  if (hasParentTraversal(trimmed)) {
    const reason = "Parent directory traversal (..) is forbidden";
    const error = new SyncValidationError(reason, trimmed);
    return { valid: false, ok: false, reason, error };
  }

  // Reject .git/ and .kiro/ paths
  if (isGitOrKiroPath(trimmed)) {
    const reason = "Paths under .git/ or .kiro/ are forbidden";
    const error = new SyncValidationError(reason, trimmed);
    return { valid: false, ok: false, reason, error };
  }

  return { valid: true, ok: true };
}

/**
 * Checks a file entry or path against all syncOut constraints:
 * path safety, symlink detection, and file size limit.
 * Requirements: 21.15, 43.14.
 */
export function checkSyncFile(
  file: SyncFileEntry | string,
  options?: SyncValidationOptions
): SyncPathCheckResult {
  const filePath = typeof file === "string" ? file : file?.path;
  const pathCheck = checkSyncPath(filePath);
  if (!pathCheck.valid) {
    return pathCheck;
  }

  if (typeof file === "object" && file !== null) {
    // Reject symlinks
    if (
      file.isSymlink === true ||
      file.isSymbolicLink === true ||
      file.type === "symlink" ||
      file.target !== undefined ||
      (typeof file.mode === "number" && (file.mode & 0o170000) === 0o120000)
    ) {
      const reason = "Symbolic links are forbidden";
      const error = new SyncValidationError(reason, filePath);
      return { valid: false, ok: false, reason, error };
    }

    // Reject files over size limit
    const maxBytes = options?.maxBytes ?? MAX_SYNC_FILE_BYTES;
    let size = file.size;

    if (size === undefined) {
      if (file.bytes instanceof Uint8Array) {
        size = file.bytes.length;
      } else if (typeof file.content === "string") {
        size = Buffer.byteLength(file.content, "utf8");
      } else if (file.content instanceof Uint8Array) {
        size = file.content.length;
      }
    }

    if (typeof size === "number" && size > maxBytes) {
      const reason = `File size ${size} bytes exceeds maximum limit of ${maxBytes} bytes`;
      const error = new SyncValidationError(reason, filePath);
      return { valid: false, ok: false, reason, error };
    }
  }

  return { valid: true, ok: true };
}

export function validateSyncPath(
  filePath: string,
  options?: SyncValidationOptions
): boolean {
  const result = checkSyncPath(filePath);
  if (!result.valid) {
    if (options?.throwOnError !== false) {
      throw result.error ?? new SyncValidationError(result.reason ?? "Invalid path", filePath);
    }
    return false;
  }
  return true;
}

export function validateSyncFile(
  file: SyncFileEntry | string,
  options?: SyncValidationOptions
): boolean {
  const result = checkSyncFile(file, options);
  if (!result.valid) {
    if (options?.throwOnError !== false) {
      const filePath = typeof file === "string" ? file : file?.path;
      throw result.error ?? new SyncValidationError(result.reason ?? "Invalid file", filePath);
    }
    return false;
  }
  return true;
}

export function isSyncPathSafe(filePath: string): boolean {
  return checkSyncPath(filePath).valid;
}

export function isSyncFileSafe(
  file: SyncFileEntry | string,
  options?: SyncValidationOptions
): boolean {
  return checkSyncFile(file, options).valid;
}

export function validateSyncPathOrThrow(
  filePath: string,
  options?: SyncValidationOptions
): void {
  const result = checkSyncPath(filePath);
  if (!result.valid) {
    throw result.error ?? new SyncValidationError(result.reason ?? "Invalid path", filePath);
  }
}

export function validateSyncFileOrThrow(
  file: SyncFileEntry | string,
  options?: SyncValidationOptions
): void {
  const result = checkSyncFile(file, options);
  if (!result.valid) {
    const filePath = typeof file === "string" ? file : file?.path;
    throw result.error ?? new SyncValidationError(result.reason ?? "Invalid file", filePath);
  }
}

/**
 * Validates a collection of files for syncOut, categorizing into accepted and rejected.
 * Excludes build outputs, includes sources, manifests, and lock files.
 * Requirements: 21.15, 43.14, 43.15.
 */
export function validateSyncOut(
  files: Iterable<SyncFileEntry | string>,
  options?: SyncValidationOptions
): SyncOutReport {
  const accepted: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const errors: SyncValidationError[] = [];

  for (const item of files) {
    const itemPath = typeof item === "string" ? item : item?.path;
    if (isExcludedBuildOutput(itemPath)) {
      continue;
    }

    const check = checkSyncFile(item, options);
    if (check.valid) {
      accepted.push(itemPath);
    } else {
      const reason = check.reason ?? "Invalid file";
      rejected.push({ path: itemPath, reason });
      if (check.error) {
        errors.push(check.error);
      }
    }
  }

  const valid = rejected.length === 0;

  if (!valid && options?.throwOnError) {
    throw errors[0] ?? new SyncValidationError("Sync validation failed", rejected[0]?.path);
  }

  return {
    valid,
    ok: valid,
    accepted,
    rejected,
    errors,
  };
}
