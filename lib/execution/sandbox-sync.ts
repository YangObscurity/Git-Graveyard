// Workspace file sync for the Docker Cloud Sandbox backend.
// The host git worktree is the authoritative source of truth for edits:
//   - syncIn pushes host worktree files into the cloud sandbox.
//   - syncOut pulls files produced inside the sandbox back to the host worktree,
//     after strict security validation (no absolute paths, no `..`, no .git/.kiro,
//     no symlinks, no oversized files, build outputs excluded).

import {
  MAX_SYNC_FILE_BYTES,
  SandboxSyncValidationError,
  isBuildOutputExcluded,
  validateSyncFileOrThrow,
  validateSyncOutOrThrow,
  validateSyncPathOrThrow,
  type SyncFileEntry,
  type SyncOutReport,
} from "./sync-validator";

/**
 * A transport-agnostic file transfer adapter. The Docker Cloud client
 * implements this so syncIn/syncOut never touch the network directly and stay
 * deterministic in offline tests.
 */
export interface SyncTransport {
  /** Reads a file's bytes from the sandbox at the given relative path. */
  readSandboxFile(path: string): Promise<Uint8Array | string>;
  /** Writes bytes to the sandbox at the given relative path. */
  writeSandboxFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Lists sandbox file entries (relative paths) under an optional root. */
  listSandboxFiles(root?: string): Promise<SyncFileEntry[]>;
}

/**
 * Host worktree file provider. Reads the authoritative source files from the
 * host git worktree and writes pulled files back into it.
 */
export interface HostWorktree {
  /** Absolute path to the host git worktree root. */
  readonly root: string;
  /** Lists host worktree files (relative paths) under an optional root. */
  listFiles(root?: string): Promise<SyncFileEntry[]>;
  /** Reads a host worktree file's bytes by relative path. */
  readFile(relPath: string): Promise<Uint8Array | string>;
  /** Writes bytes to a host worktree file by relative path. */
  writeFile(relPath: string, data: Uint8Array | string): Promise<void>;
}

export interface SyncResult {
  readonly ok: boolean;
  readonly transferred: string[];
  readonly skipped: string[];
  readonly rejected: Array<{ path: string; reason: string }>;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function entryPath(entry: SyncFileEntry | string): string {
  return typeof entry === "string" ? entry : entry.path;
}

/**
 * Pushes host worktree files into the cloud sandbox (host -> sandbox).
 * The host worktree is authoritative: every transferred path is validated
 * against the sync security rules before it is written into the sandbox.
 */
export async function syncIn(
  worktree: HostWorktree,
  transport: SyncTransport,
  root?: string
): Promise<SyncResult> {
  const transferred: string[] = [];
  const skipped: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  const entries = await worktree.listFiles(root);
  for (const entry of entries) {
    const relPath = entryPath(entry);
    if (isBuildOutputExcluded(relPath)) {
      skipped.push(relPath);
      continue;
    }
    try {
      validateSyncFileOrThrow(entry);
      const data = await worktree.readFile(relPath);
      await transport.writeSandboxFile(relPath, data);
      transferred.push(relPath);
    } catch (err) {
      if (err instanceof SandboxSyncValidationError) {
        rejected.push({ path: relPath, reason: err.reason });
      } else {
        throw err;
      }
    }
  }

  return {
    ok: rejected.length === 0,
    transferred,
    skipped,
    rejected,
  };
}

/**
 * Pulls files produced inside the sandbox back to the host worktree
 * (sandbox -> host). Every pulled path is validated; absolute paths, `..`
 * traversal, .git/.kiro trees, symlinks and oversized files are rejected, and
 * build output directories are excluded. Source files, manifests and lock
 * files are retained.
 */
export async function syncOut(
  transport: SyncTransport,
  worktree: HostWorktree,
  root?: string
): Promise<SyncResult> {
  const entries = await transport.listSandboxFiles(root);

  // First pass: validate the whole batch with the shared validator so build
  // outputs are excluded and every remaining file passes path/symlink/size
  // checks. validateSyncOutOrThrow throws on the first rejection.
  const report: SyncOutReport = validateSyncOutOrThrow(entries);

  const acceptedSet = new Set(report.accepted);
  const transferred: string[] = [];
  const skipped: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  for (const entry of entries) {
    const relPath = entryPath(entry);
    if (isBuildOutputExcluded(relPath)) {
      skipped.push(relPath);
      continue;
    }
    if (!acceptedSet.has(relPath)) {
      // Should not happen because validateSyncOutOrThrow already threw, but
      // keep the guard for defense in depth.
      rejected.push({ path: relPath, reason: "Rejected by sync validation" });
      continue;
    }
    // Re-validate each file individually before writing to the host worktree.
    validateSyncFileOrThrow(entry);
    validateSyncPathOrThrow(relPath);
    const data = await transport.readSandboxFile(relPath);
    const bytes = toBytes(data);
    if (bytes.length > MAX_SYNC_FILE_BYTES) {
      throw new SandboxSyncValidationError(
        `File size ${bytes.length} bytes exceeds maximum limit of ${MAX_SYNC_FILE_BYTES} bytes`,
        relPath
      );
    }
    await worktree.writeFile(relPath, bytes);
    transferred.push(relPath);
  }

  return {
    ok: rejected.length === 0,
    transferred,
    skipped,
    rejected,
  };
}