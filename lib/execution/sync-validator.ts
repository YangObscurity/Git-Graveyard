// Workspace file sync security validation for the Docker Cloud Sandbox backend.
// Wraps and reuses lib/backend/sync-validator.ts so the size limit (MAX_SYNC_FILE_BYTES)
// and path-safety rules (absolute paths, `..` traversal, .git/ and .kiro/ trees,
// symlinks, oversized files, build-output exclusion) are enforced in one place
// without duplicating logic.

import {
  MAX_SYNC_FILE_BYTES,
  SyncValidationError,
  checkSyncFile,
  checkSyncPath,
  isExcludedBuildOutput,
  validateSyncOut,
  type SyncFileEntry,
  type SyncOutReport,
  type SyncPathCheckResult,
  type SyncValidationOptions,
} from "../backend/sync-validator";

export {
  MAX_SYNC_FILE_BYTES,
  SyncValidationError,
  type SyncFileEntry,
  type SyncOutReport,
  type SyncPathCheckResult,
  type SyncValidationOptions,
};

/**
 * Error thrown when a workspace sync operation is rejected by the security
 * validator. Mirrors SyncValidationError but carries a distinct code so callers
 * can distinguish sync-layer rejections from the shared validator.
 */
export class SandboxSyncValidationError extends Error {
  readonly ok = false as const;
  readonly code = "SANDBOX_SYNC_VALIDATION_ERROR" as const;
  readonly reason: string;
  readonly path?: string;

  constructor(reason: string, filePath?: string, message?: string) {
    const msg =
      message ?? `Workspace sync rejected path '${filePath ?? "unknown"}': ${reason}`;
    super(msg);
    this.name = "SandboxSyncValidationError";
    this.reason = reason;
    this.path = filePath;
    Object.setPrototypeOf(this, SandboxSyncValidationError.prototype);
  }
}

/**
 * Validates a single relative path for sync operations. Rejects absolute paths
 * (POSIX and Windows), `..` parent traversal, and any path under `.git/` or
 * `.kiro/`. Reuses the shared checkSyncPath from lib/backend/sync-validator.ts.
 */
export function validateSyncPathOrThrow(filePath: string): void {
  const result = checkSyncPath(filePath);
  if (!result.valid) {
    throw new SandboxSyncValidationError(
      result.reason ?? "Invalid path",
      filePath,
      result.error?.message
    );
  }
}

/**
 * Validates a single file entry for syncOut. In addition to the path checks it
 * rejects symbolic links and files exceeding MAX_SYNC_FILE_BYTES. Reuses the
 * shared checkSyncFile from lib/backend/sync-validator.ts.
 */
export function validateSyncFileOrThrow(
  file: SyncFileEntry | string,
  options?: SyncValidationOptions
): void {
  const result = checkSyncFile(file, options);
  if (!result.valid) {
    const filePath = typeof file === "string" ? file : file?.path;
    throw new SandboxSyncValidationError(
      result.reason ?? "Invalid file",
      filePath,
      result.error?.message
    );
  }
}

/**
 * Validates a collection of files for syncOut. Build output directories
 * (node_modules, dist, .next) are excluded; source files, manifests and lock
 * files are retained. Reuses validateSyncOut from lib/backend/sync-validator.ts
 * and rethrows the first rejection as a SandboxSyncValidationError.
 */
export function validateSyncOutOrThrow(
  files: Iterable<SyncFileEntry | string>,
  options?: SyncValidationOptions
): SyncOutReport {
  const report = validateSyncOut(files, options);
  if (!report.valid) {
    const first = report.rejected[0];
    throw new SandboxSyncValidationError(
      first?.reason ?? "Sync validation failed",
      first?.path
    );
  }
  return report;
}

/**
 * Returns true when a path targets an excluded build-output directory
 * (node_modules, dist, .next). Reuses isExcludedBuildOutput.
 */
export function isBuildOutputExcluded(filePath: string): boolean {
  return isExcludedBuildOutput(filePath);
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