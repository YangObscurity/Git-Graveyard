import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DockerExecStream,
  RunnerExitCodeError,
  type DockerExecProcess,
  getMinimalDockerEnv,
  isForbiddenEnvName,
  isForbiddenEnvValue,
  isRootUser,
} from "./docker-exec-stream";
import {
  buildContainerNetworkArgs,
  getRunNetworkPolicy,
  releaseRunNetworkPolicy,
  type RunNetworkPolicy,
} from "./network-policy";
import {
  SpecValidationError,
  validateExecRequest,
  validateSandboxSpec,
} from "./spec-validator";
import type {
  BackendKind,
  ExecProcess,
  ExecRequest,
  ExecResult,
  ExecutionBackend,
  HardenedExecResult,
  Sandbox,
  SandboxSpec,
} from "./types";

/**
 * Error thrown when a capability or backend is not available in v1.
 * Code: NOT_IN_V1.
 */
export class NotInV1Error extends Error {
  readonly ok = false as const;
  readonly code = "NOT_IN_V1" as const;

  constructor(message = "Operation or backend is not available in v1") {
    super(message);
    this.name = "NotInV1Error";
    Object.setPrototypeOf(this, NotInV1Error.prototype);
  }
}

/**
 * Error thrown when creating a box without a registered network policy.
 * Requirements: 21.9, 43.11.
 */
export class NetworkPolicyRequiredError extends Error {
  readonly ok = false as const;
  readonly code = "NETWORK_POLICY_REQUIRED" as const;
  readonly runId?: string;

  constructor(runId?: string, message?: string) {
    const msg =
      message ??
      (runId
        ? `No network policy registered for run '${runId}' (Requirement 21.9, 43.11)`
        : "No network policy registered for run (Requirement 21.9, 43.11)");
    super(msg);
    this.name = "NetworkPolicyRequiredError";
    this.runId = runId;
    Object.setPrototypeOf(this, NetworkPolicyRequiredError.prototype);
  }
}

/**
 * Error thrown when an invalid or unpinned container image is provided.
 * Requirement 21.1.
 */
export class ImageConfigError extends Error {
  readonly ok = false as const;
  readonly code = "IMAGE_CONFIG_ERROR" as const;
  readonly reason: string;

  constructor(reason: string, message?: string) {
    const msg = message ?? `Docker image rejected: ${reason}`;
    super(msg);
    this.name = "ImageConfigError";
    this.reason = reason;
    Object.setPrototypeOf(this, ImageConfigError.prototype);
  }
}

/**
 * Error thrown when a filesystem mount violates security policy.
 * Requirements: 21.2, 21.6, 21.8, 43.10.
 */
export class MountSecurityError extends Error {
  readonly ok = false as const;
  readonly code = "MOUNT_SECURITY_ERROR" as const;
  readonly reason: string;

  constructor(reason: string, message?: string) {
    const msg = message ?? `Filesystem mount rejected: ${reason}`;
    super(msg);
    this.name = "MountSecurityError";
    this.reason = reason;
    Object.setPrototypeOf(this, MountSecurityError.prototype);
  }
}

export interface DockerRunnerOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  input?: string | Buffer;
  onStdout?: (data: string | Buffer | Uint8Array) => void;
  onStderr?: (data: string | Buffer | Uint8Array) => void;
  [key: string]: unknown;
}

export interface DockerRunnerResult {
  exitCode?: number | null;
  code?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  [key: string]: unknown;
}

export type DockerRunner = (
  argv: string[],
  options?: DockerRunnerOptions
) => Promise<DockerRunnerResult | string> | DockerRunnerResult | string;

export interface InstaboxDockerBackendOptions {
  image?: string;
  runner?: DockerRunner;
  dockerRunner?: DockerRunner;
  runsDir?: string;
  defaultNetworkName?: string;
  networkPolicy?: RunNetworkPolicy;
  labels?: Record<string, string>;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Regex pattern verifying image contains a pinned digest.
 * Requirement 21.1: Image pinned by digest holding Node and Python toolchains.
 * Anchored start-and-end regex requiring alphanumeric start, no whitespace, no leading dash,
 * and exact 64-char sha256 digest.
 */
export const PINNED_DIGEST_REGEX =
  /^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-fA-F0-9]{64}$/;

export function isPinnedDigestImage(image: unknown): boolean {
  if (typeof image !== "string") {
    return false;
  }
  const trimmed = image.trim();
  if (trimmed.length === 0 || /[\r\n\s]/.test(trimmed)) {
    return false;
  }
  return PINNED_DIGEST_REGEX.test(trimmed);
}

export const isPinnedDigest = isPinnedDigestImage;

export const SAFE_CONTAINER_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function assertValidContainerId(
  containerId: unknown
): asserts containerId is string {
  if (typeof containerId !== "string" || containerId.length === 0) {
    throw new SpecValidationError("Container id must be a non-empty string");
  }
  if (containerId.startsWith("-")) {
    throw new SpecValidationError(
      `Container id must not start with a dash: '${containerId}'`
    );
  }
  if (/[\s\r\n\x00-\x1f\x7f]/.test(containerId)) {
    throw new SpecValidationError(
      `Container id must not contain whitespace, newlines, or control characters: '${containerId}'`
    );
  }
  if (!SAFE_CONTAINER_ID_REGEX.test(containerId)) {
    throw new SpecValidationError(
      `Container id '${containerId}' contains invalid characters; must match ${SAFE_CONTAINER_ID_REGEX}`
    );
  }
}

/**
 * Allowed prefix for mounts inside the container.
 */
export const ALLOWED_CONTAINER_MOUNT_PREFIX = "/workspace";

export const CONTAINER_MOUNT_TARGET_REGEX = /^\/[a-zA-Z0-9._\/-]+$/;

/**
 * Validates a container mount destination path (mountAt).
 * Refuses any path that contains a colon or comma, is not an absolute POSIX path,
 * contains characters outside letters, digits, dot, underscore, dash and slash,
 * or lies outside /workspace.
 * Requirements: 21.6, 43.10, H-2.
 */
export function validateMountAt(mountAt: string): void {
  if (typeof mountAt !== "string" || mountAt.length === 0) {
    throw new MountSecurityError("Mount mountAt must be a non-empty string");
  }
  if (mountAt.includes(":") || mountAt.includes(",")) {
    throw new MountSecurityError("Mount mountAt must not contain a colon or comma");
  }
  if (!mountAt.startsWith("/") || !CONTAINER_MOUNT_TARGET_REGEX.test(mountAt)) {
    throw new MountSecurityError(
      `Container mount target '${mountAt}' must be an absolute POSIX path made only of letters, digits, dot, underscore, dash and slash`
    );
  }
  const normalized = path.posix.normalize(mountAt);
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
    throw new MountSecurityError(
      `mountAt '${mountAt}' is outside the allowed container prefix '/workspace'`
    );
  }
}

/**
 * Resolves the disk limit for tmpfs scratch space from SandboxSpec.
 * A missing limit is refused.
 * Requirement 21.4.
 */
export function resolveDiskLimit(spec: SandboxSpec): string {
  const rawSpec = spec as Record<string, unknown>;
  const limit =
    spec.resources?.diskMiB ??
    rawSpec.diskMiB ??
    (spec.resources as Record<string, unknown> | undefined)?.diskLimit ??
    rawSpec.diskLimit;

  if (limit === undefined || limit === null) {
    throw new SpecValidationError(
      "Disk limit is required for tmpfs scratch space (Requirement 21.4)"
    );
  }

  if (typeof limit === "number") {
    if (limit <= 0 || Number.isNaN(limit)) {
      throw new SpecValidationError(
        `Invalid disk limit: ${limit}; must be a positive number`
      );
    }
    return `${limit}m`;
  }

  if (typeof limit === "string") {
    const trimmed = limit.trim();
    if (!trimmed) {
      throw new SpecValidationError(
        "Disk limit must be a non-empty string or positive number"
      );
    }
    if (/^\d+$/.test(trimmed)) {
      return `${trimmed}m`;
    }
    if (/^\d+[kmgKMG]?$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    throw new SpecValidationError(`Invalid disk limit format: '${trimmed}'`);
  }

  throw new SpecValidationError("Disk limit must be a number or string");
}

/**
 * Validates a hostPath for bind mounting into a box.
 * Requirements: 21.2, 21.6, 21.8, 43.10.
 *
 * Rules:
 * - Refuse any path that contains a colon.
 * - Resolve every hostPath with fs.realpathSync before checking boundaries.
 * - Strictly forbid mounts of KIRO_HOME, host user home, /data, and .git.
 * - Strictly forbid container socket mounts.
 * - Bind-mount only builders/ into Runbox and only warden/ into Auditbox.
 */
export function validateMountPath(hostPath: string, boxRole?: string): string {
  if (typeof hostPath !== "string" || !hostPath.trim()) {
    throw new MountSecurityError("Mount hostPath must be a non-empty string");
  }

  const rawPath = hostPath.trim();
  if (rawPath.includes(":") || rawPath.includes(",")) {
    throw new MountSecurityError("Mount hostPath must not contain a colon or comma");
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(rawPath);
  } catch (err) {
    throw new MountSecurityError(
      `Mount hostPath '${rawPath}' could not be resolved via realpath: ${(err as Error).message}`
    );
  }

  if (resolved.includes(":") || resolved.includes(",")) {
    throw new MountSecurityError("Mount hostPath must not contain a colon or comma");
  }

  const normalized = resolved.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  // Requirement 21.2: No container socket
  if (
    normalized.includes("docker.sock") ||
    normalized.includes("containerd.sock")
  ) {
    throw new MountSecurityError(
      "Mounting container socket is forbidden (Requirement 21.2)"
    );
  }

  // Requirement 21.6: Mount no .git directory
  if (segments.some((seg) => seg === ".git" || seg.endsWith(".git"))) {
    throw new MountSecurityError(
      "Mounting .git directory is forbidden (Requirement 21.6)"
    );
  }

  // Requirement 21.6: Mount no KIRO_HOME
  const kiroHome = process.env.KIRO_HOME;
  if (kiroHome) {
    let resolvedKiroHome: string;
    try {
      resolvedKiroHome = fs.realpathSync(kiroHome);
    } catch {
      resolvedKiroHome = path.resolve(kiroHome);
    }
    if (
      resolved === resolvedKiroHome ||
      resolved.startsWith(resolvedKiroHome + path.sep)
    ) {
      throw new MountSecurityError(
        "Mounting KIRO_HOME directory is forbidden (Requirement 21.6)"
      );
    }
  }
  if (
    segments.some(
      (seg) =>
        seg === ".kiro" ||
        seg === "kiro-home" ||
        seg.startsWith(".kiro")
    )
  ) {
    throw new MountSecurityError(
      "Mounting KIRO_HOME or .kiro directory is forbidden (Requirement 21.6)"
    );
  }

  // Requirement 21.6: Mount no host user home directory
  const homeDir = os.homedir();
  const envHome = process.env.HOME;
  if (
    rawPath === "~" ||
    rawPath.startsWith("~/") ||
    (homeDir && resolved === path.resolve(homeDir)) ||
    (envHome && resolved === path.resolve(envHome)) ||
    resolved === "/root" ||
    resolved === "/home"
  ) {
    throw new MountSecurityError(
      "Mounting host user home directory is forbidden (Requirement 21.6)"
    );
  }

  // Requirement 21.6: Mount no /data directory directly
  if (resolved === "/data" || resolved === "/data/") {
    throw new MountSecurityError(
      "Mounting /data directory is forbidden (Requirement 21.6)"
    );
  }

  // Requirements 21.7, 21.8, 43.10:
  // Bind-mount only builders/ into Runbox and only warden/ into Auditbox
  const role = (boxRole ?? "").toLowerCase();
  const isAudit =
    role === "auditbox" ||
    role === "warden" ||
    role.includes("audit") ||
    role.includes("warden");
  const isRun =
    role === "runbox" ||
    role === "builder" ||
    role.includes("run") ||
    role.includes("builder");

  const hasBuilders = segments.some((seg) => seg === "builders");
  const hasWarden = segments.some((seg) => seg === "warden");

  if (isAudit) {
    if (hasBuilders) {
      throw new MountSecurityError(
        "Auditbox cannot mount builders/ directory (Requirement 43.10)"
      );
    }
    if (!hasWarden) {
      throw new MountSecurityError(
        "Auditbox may bind-mount only warden/ directory (Requirement 43.10)"
      );
    }
  } else if (isRun) {
    if (hasWarden) {
      throw new MountSecurityError(
        "Runbox cannot mount warden/ checkout directory (Requirement 21.8, 43.10)"
      );
    }
    if (!hasBuilders) {
      throw new MountSecurityError(
        "Runbox may bind-mount only builders/ directory (Requirement 43.10)"
      );
    }
  } else {
    // Role not explicitly designated: verify it is strictly either builders or warden
    if (hasWarden && hasBuilders) {
      throw new MountSecurityError(
        "Mount cannot bridge both builders/ and warden/ directories (Requirement 21.8, 43.10)"
      );
    }
    if (!hasWarden && !hasBuilders) {
      throw new MountSecurityError(
        "InstaboxDockerBackend bind-mount must be builders/ for runbox or warden/ for auditbox (Requirement 43.10)"
      );
    }
  }

  return resolved;
}

/**
 * Maximum output kept per stream by the default runner, matching the previous
 * execFile maxBuffer so runaway output still fails instead of growing unbounded.
 */
export const DEFAULT_RUNNER_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

/**
 * Default childProcess runner used when no custom runner is injected.
 * Uses explicit minimal environment (PATH and LANG, plus DOCKER_HOST when spec names it).
 * Does not inherit process.env.
 *
 * The command runs under spawn with piped stdout and stderr so that stderr is
 * streamed to the caller through onStderr while the command runs; the exec
 * stream learns the command's process group id from the stderr marker before
 * any timeout fires (SC2, N-C1). A rejected runner keeps the collected stdout
 * and stderr on the error. On the runner's own timeout the local child is
 * killed; the stream kills the command's group inside the container with a
 * separate docker exec kill call and reports timedOut with exit code 124.
 *
 * No silent timeout default: a caller-supplied timeoutMs must be a positive
 * integer; nothing is substituted when it is absent (Requirement M-6, R6-A2),
 * and a call without a timeout is refused outright. docker wait is the only
 * exception: it blocks until the container exits (SC2, N-C3).
 */
export async function defaultChildProcessRunner(
  argv: string[],
  options?: DockerRunnerOptions
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs === undefined || timeoutMs === null) {
    if (argv[0] !== "wait") {
      throw new SpecValidationError(
        "Missing required timeout setting: every docker call must carry a positive integer timeoutMs; only docker wait is exempt"
      );
    }
  } else if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new SpecValidationError(
      `Missing required timeout setting: timeoutMs must be a positive integer; received ${String(timeoutMs)}`
    );
  }
  return new Promise((resolve, reject) => {
    const minimalEnv = getMinimalDockerEnv(options);
    const child = childProcess.spawn("docker", argv, {
      cwd: options?.cwd,
      env: minimalEnv as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overMaxBuffer = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // A rejected runner keeps the collected stdout and stderr on the error.
      (err as Error & { stdout?: string; stderr?: string }).stdout = stdout;
      (err as Error & { stdout?: string; stderr?: string }).stderr = stderr;
      reject(err);
    };
    const settleResolve = (value: {
      exitCode: number;
      stdout: string;
      stderr: string;
    }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= DEFAULT_RUNNER_MAX_BUFFER_BYTES && !overMaxBuffer) {
        stdout += chunk;
        options?.onStdout?.(chunk);
      } else {
        overMaxBuffer = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= DEFAULT_RUNNER_MAX_BUFFER_BYTES && !overMaxBuffer) {
        stderr += chunk;
        // Stream stderr while the command runs so the caller learns the pgid
        // from the marker line before any timeout fires (SC2, N-C1).
        options?.onStderr?.(chunk);
      } else {
        overMaxBuffer = true;
        child.kill("SIGTERM");
      }
    });

    if (typeof timeoutMs === "number") {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      settleReject(err);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (overMaxBuffer) {
        settleReject(
          new Error(
            "docker command output exceeded the runner maxBuffer limit and the child was killed"
          )
        );
        return;
      }
      if (timedOut) {
        // The runner's own timer killed the local child after the timeout;
        // post-SIGTERM numeric exit codes still reject with err.timedOut = true and code 124.
        const err = new Error(
          `docker command timed out after ${String(timeoutMs)}ms and was killed (signal ${String(
            signal ?? "SIGTERM"
          )})`
        ) as Error & {
          killed: boolean;
          timedOut: boolean;
          signal?: NodeJS.Signals;
          code: number | null;
          exitCode?: number | null;
        };
        err.killed = true;
        err.timedOut = true;
        err.signal = signal ?? "SIGTERM";
        err.code = 124;
        err.exitCode = 124;
        settleReject(err);
        return;
      }
      if (typeof code === "number") {
        settleResolve({ exitCode: code, stdout, stderr });
        return;
      }
      // Ended without an integer exit code (spawn failure or an external
      // signal): an infrastructure error, never mapped to exit 1 (M-5).
      const err = new Error(
        `docker command ended without an integer exit code (code ${String(
          code
        )}, signal ${String(signal)})`
      ) as Error & { signal?: NodeJS.Signals | null; code: number | null };
      err.signal = signal;
      err.code = null;
      settleReject(err);
    });
  });
}

function parseDockerPsLabels(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== "string") {
    return result;
  }
  const pairs = raw.split(",");
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx !== -1) {
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (k) {
        result[k] = v;
      }
    }
  }
  return result;
}

/**
 * Validates the user configuration in a SandboxSpec.
 * A user spec without a numeric uid must be an error and must never produce '-u undefined'.
 * Requirements: 21.3, 43.7, L-2.
 */
export function validateUserSpec(spec?: Partial<SandboxSpec> | null): void {
  if (!spec) return;

  const raw = spec as Record<string, unknown>;

  // Check root user first (Requirements 21.3, 43.7)
  if (isRootUser(raw.user) || isRootUser(raw.uid) || isRootUser(raw.userId)) {
    throw new SpecValidationError("User ID 0 (root) is forbidden");
  }

  // A user spec without a numeric uid must be an error and must never produce '-u undefined' (L-2)
  if ("user" in raw && raw.user !== undefined && raw.user !== null) {
    if (typeof raw.user === "object") {
      const u = raw.user as Record<string, unknown>;
      if (
        u.uid === undefined ||
        u.uid === null ||
        typeof u.uid !== "number" ||
        !Number.isInteger(u.uid) ||
        u.uid <= 0
      ) {
        throw new SpecValidationError(
          "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
        );
      }
      if (
        u.gid !== undefined &&
        u.gid !== null &&
        (typeof u.gid !== "number" || !Number.isInteger(u.gid) || u.gid < 0)
      ) {
        throw new SpecValidationError("User spec gid must be a non-negative integer");
      }
    } else if (typeof raw.user === "number") {
      if (!Number.isInteger(raw.user) || raw.user <= 0) {
        throw new SpecValidationError(
          "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
        );
      }
    } else if (typeof raw.user === "string") {
      const trimmed = raw.user.trim();
      if (!/^\d+(:\d+)?$/.test(trimmed)) {
        throw new SpecValidationError(
          "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
        );
      }
      const parts = trimmed.split(":");
      const uidNum = parseInt(parts[0], 10);
      if (uidNum <= 0) {
        throw new SpecValidationError(
          "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
        );
      }
    } else {
      throw new SpecValidationError(
        "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
      );
    }
  }

  if ("uid" in raw && raw.uid !== undefined && raw.uid !== null) {
    if (typeof raw.uid !== "number" || !Number.isInteger(raw.uid) || raw.uid <= 0) {
      throw new SpecValidationError(
        "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
      );
    }
  }

  if ("userId" in raw && raw.userId !== undefined && raw.userId !== null) {
    if (typeof raw.userId !== "number" || !Number.isInteger(raw.userId) || raw.userId <= 0) {
      throw new SpecValidationError(
        "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
      );
    }
  }
}

/**
 * Helper to check for duplicate keys in a comma-separated mount string.
 */
function checkDuplicateKeysInMountString(
  mountStr: string,
  locationDescription = "mount specification"
): void {
  const seenKeys = new Set<string>();
  const parts = mountStr.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = (eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx)).trim().toLowerCase();
    if (seenKeys.has(key)) {
      throw new MountSecurityError(
        `Duplicate key inside ${locationDescription}: '${key}'`
      );
    }
    seenKeys.add(key);
  }
}

export function normalizeContainerTarget(target: string): string {
  const norm = path.posix.normalize(target);
  return norm.length > 1 && norm.endsWith("/") ? norm.replace(/\/+$/, "") : norm;
}

/**
 * Validates a single mount specification (string or object) and extracts normalized source, target, readOnly.
 * Rejects duplicate keys inside the specification, validates container target, and resolves host path.
 * Requirements: 21.6, 43.10, H-2.
 */
export function parseAndValidateMount(
  m: unknown,
  role: string,
  locationDescription = "mount specification"
): { source: string; target: string; readOnly: boolean } {
  if (typeof m === "string") {
    checkDuplicateKeysInMountString(m, locationDescription);
    const parts = m.split(",");
    let source: string | undefined;
    let target: string | undefined;
    let readOnly = false;

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      const key = (eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx)).trim().toLowerCase();
      const val = eqIdx === -1 ? "" : trimmed.slice(eqIdx + 1).trim();

      if (key === "source" || key === "src" || key === "hostpath") {
        source = val;
      } else if (key === "target" || key === "dst" || key === "destination" || key === "mountat") {
        target = val;
      } else if (key === "readonly" || key === "ro") {
        readOnly = true;
      } else if (key === "type") {
        if (val && val !== "bind") {
          throw new MountSecurityError(`Unsupported mount type '${val}' in ${locationDescription}`);
        }
      }
    }

    if (!source) {
      throw new MountSecurityError(`Mount hostPath/source is required in ${locationDescription}`);
    }
    if (!target) {
      throw new MountSecurityError(`Mount mountAt/target is required in ${locationDescription}`);
    }

    validateMountAt(target);
    const resolvedSource = validateMountPath(source, role);
    return {
      source: resolvedSource,
      target: normalizeContainerTarget(target),
      readOnly,
    };
  }

  if (m && typeof m === "object") {
    const obj = m as Record<string, unknown>;

    // Reject duplicate keys inside one mount specification:
    // hostPath vs source
    if (obj.hostPath !== undefined && obj.source !== undefined) {
      throw new MountSecurityError(
        `Duplicate key inside ${locationDescription}: both hostPath and source specified`
      );
    }
    // mountAt vs target
    if (obj.mountAt !== undefined && obj.target !== undefined) {
      throw new MountSecurityError(
        `Duplicate key inside ${locationDescription}: both mountAt and target specified`
      );
    }
    // readOnly vs readonly
    if (obj.readOnly !== undefined && obj.readonly !== undefined) {
      throw new MountSecurityError(
        `Duplicate key inside ${locationDescription}: both readOnly and readonly specified`
      );
    }

    for (const k of ["options", "raw", "spec", "mount"] as const) {
      if (typeof obj[k] === "string") {
        checkDuplicateKeysInMountString(obj[k] as string, `${locationDescription} ${k}`);
      }
    }

    if (Array.isArray(obj.options)) {
      const seen = new Set<string>();
      for (const opt of obj.options) {
        const s = String(opt).trim().toLowerCase();
        if (seen.has(s)) {
          throw new MountSecurityError(
            `Duplicate key inside ${locationDescription} options: '${s}'`
          );
        }
        seen.add(s);
      }
    }

    const rawSource = obj.hostPath ?? obj.source;
    const rawTarget = obj.mountAt ?? obj.target;

    if (rawSource === undefined || rawSource === null || (typeof rawSource === "string" && !rawSource.trim())) {
      throw new MountSecurityError(`Mount hostPath/source is required in ${locationDescription}`);
    }
    if (typeof rawSource !== "string") {
      throw new MountSecurityError(`Mount hostPath must be a string in ${locationDescription}`);
    }

    if (rawTarget === undefined || rawTarget === null || (typeof rawTarget === "string" && !rawTarget.trim())) {
      throw new MountSecurityError(`Mount mountAt/target is required in ${locationDescription}`);
    }
    if (typeof rawTarget !== "string") {
      throw new MountSecurityError(`Mount mountAt must be a string in ${locationDescription}`);
    }

    validateMountAt(rawTarget);
    const resolvedSource = validateMountPath(rawSource, role);
    const readOnly = Boolean(obj.readOnly ?? obj.readonly);

    return {
      source: resolvedSource,
      target: normalizeContainerTarget(rawTarget),
      readOnly,
    };
  }

  throw new MountSecurityError(`Invalid mount specification in ${locationDescription}`);
}

/**
 * A command's timeoutMs must be given by the caller as a positive integer, and
 * maxTimeoutMs must come from the backend settings. A missing or non-positive-integer
 * value is a required-setting error raised before the command starts; no value is
 * clamped or replaced. Requirements: M-6, R6-A2.
 */
function requireCommandTimeoutSettings(
  reqTimeoutMs: unknown,
  settings?: Record<string, unknown>
): void {
  if (
    typeof reqTimeoutMs !== "number" ||
    !Number.isSafeInteger(reqTimeoutMs) ||
    reqTimeoutMs <= 0
  ) {
    throw new SpecValidationError(
      "Missing required timeout setting: command timeoutMs must be given by the caller as a positive integer"
    );
  }
  const maxTimeoutMs = settings?.maxTimeoutMs;
  if (
    typeof maxTimeoutMs !== "number" ||
    !Number.isSafeInteger(maxTimeoutMs) ||
    maxTimeoutMs <= 0
  ) {
    throw new SpecValidationError(
      "Missing required timeout setting: maxTimeoutMs must be configured in the backend settings as a positive integer"
    );
  }
}

/**
 * housekeepingTimeoutMs is a required backend setting: every non-command
 * docker call carries it as its timeout, and the default runner refuses a call
 * without one (docker wait is the only exception). A missing or
 * non-positive-integer value is a required-setting error raised before the
 * call is made; no value is clamped or replaced. Requirements: SC2, N-C3, N-C16.
 */
export function requireHousekeepingTimeoutSettings(
  settings?: Record<string, unknown>
): number {
  const housekeepingTimeoutMs = settings?.housekeepingTimeoutMs;
  if (
    typeof housekeepingTimeoutMs !== "number" ||
    !Number.isSafeInteger(housekeepingTimeoutMs) ||
    housekeepingTimeoutMs <= 0
  ) {
    throw new SpecValidationError(
      "Missing required timeout setting: housekeepingTimeoutMs must be configured in the backend settings as a positive integer"
    );
  }
  return housekeepingTimeoutMs;
}

/**
 * InstaboxDockerBackend Sandbox instance.
 */
export class InstaboxDockerSandbox implements Sandbox {
  readonly id: string;
  readonly containerId: string;
  readonly idempotencyKey: string;
  readonly labels: Record<string, string>;
  readonly state: string;
  readonly spec: Partial<SandboxSpec>;
  public readonly backend: InstaboxDockerBackend;

  constructor(
    id: string,
    spec: Partial<SandboxSpec>,
    backend: InstaboxDockerBackend,
    state = "running"
  ) {
    assertValidContainerId(id);
    validateUserSpec(spec);
    this.id = id;
    this.containerId = id;
    this.idempotencyKey = spec.idempotencyKey ?? id;
    this.labels = { ...(spec.labels ?? {}) };
    this.state = state;
    this.backend = backend;
    this.spec = spec;
  }

  async exec(req: ExecRequest): Promise<DockerExecProcess> {
    assertValidContainerId(this.containerId);
    validateExecRequest(req);
    validateUserSpec(this.spec);
    requireCommandTimeoutSettings(
      req.timeoutMs,
      this.backend.options.settings
    );
    requireHousekeepingTimeoutSettings(this.backend.options.settings);
    const stream = new DockerExecStream({
      containerId: this.containerId,
      runner: (argv, options) =>
        this.backend.runner(argv, this.backend.withHousekeepingTimeout(argv, options)),
      runId: this.labels?.["git-graveyard.run-id"] ?? this.labels?.["runId"],
      logRef: (req as Record<string, unknown>).logRef as string | undefined,
      defaultTimeoutMs: req.timeoutMs,
      sandbox: this,
      spec: this.spec,
      settings: this.backend.options.settings,
    });
    return stream.exec(req);
  }

  async run(req: ExecRequest): Promise<HardenedExecResult> {
    assertValidContainerId(this.containerId);
    validateExecRequest(req);
    validateUserSpec(this.spec);
    requireCommandTimeoutSettings(
      req.timeoutMs,
      this.backend.options.settings
    );
    requireHousekeepingTimeoutSettings(this.backend.options.settings);
    const stream = new DockerExecStream({
      containerId: this.containerId,
      runner: (argv, options) =>
        this.backend.runner(argv, this.backend.withHousekeepingTimeout(argv, options)),
      runId: this.labels?.["git-graveyard.run-id"] ?? this.labels?.["runId"],
      logRef: (req as Record<string, unknown>).logRef as string | undefined,
      defaultTimeoutMs: req.timeoutMs,
      sandbox: this,
      spec: this.spec,
      settings: this.backend.options.settings,
    });
    const result = await stream.run(req);
    const rawCode = result.exitCode;
    if (typeof rawCode !== "number" || !Number.isInteger(rawCode)) {
      // A missing or non-integer exit code is an infrastructure error and is
      // never mapped to exit 1 (SC2, N-C5 sandbox path; M-5).
      throw new RunnerExitCodeError(
        `Docker runner result must include an integer exit code, received: ${String(rawCode)}`
      );
    }
    return {
      logRef: result.logRef,
      oomKilled: result.oomKilled,
      timedOut: result.timedOut,
      exitCode: rawCode,
      stdoutTail: result.stdoutTail ?? "",
      stderrTail: result.stderrTail ?? "",
      truncated: result.truncated,
    };
  }

  async wait(): Promise<{
    exitCode: number;
    signal?: string;
    timedOut: boolean;
    oomKilled: boolean;
  }> {
    assertValidContainerId(this.containerId);
    const res = await this.backend.runDocker(["wait", this.containerId]);
    if (res.exitCode !== 0) {
      throw new Error(
        `docker wait failed with exit code ${res.exitCode}: ${res.stderr}`
      );
    }
    const trimmed = res.stdout.trim();
    if (!trimmed || !/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `Failed to parse container exit code from docker wait output: '${res.stdout}'`
      );
    }
    const code = parseInt(trimmed, 10);
    if (Number.isNaN(code)) {
      throw new Error(
        `Failed to parse container exit code from docker wait output: '${res.stdout}'`
      );
    }
    return {
      exitCode: code,
      timedOut: false,
      oomKilled: false,
    };
  }

  async stop(): Promise<void> {
    assertValidContainerId(this.containerId);
    await this.backend.runDocker(["stop", this.containerId]);
  }

  async destroy(): Promise<void> {
    assertValidContainerId(this.containerId);
    await this.backend.destroy(this);
  }

  async status(): Promise<string> {
    assertValidContainerId(this.containerId);
    return this.state;
  }

  async sweepProcesses(pgid?: number | string): Promise<void> {
    assertValidContainerId(this.containerId);
    return this.backend.sweepProcesses(this.containerId, pgid);
  }

  async snapshot(_id?: string): Promise<never> {
    throw new NotInV1Error(
      "Snapshots are not supported in v1 (Requirement 21.16, 43.18)"
    );
  }

  async syncIn(): Promise<never> {
    throw new NotInV1Error("syncIn is not supported in v1 InstaboxDockerBackend");
  }

  async syncOut(): Promise<never> {
    throw new NotInV1Error("syncOut is not supported in v1 InstaboxDockerBackend");
  }
}

/**
 * InstaboxDockerBackend
 *
 * Implements ExecutionBackend interface with Docker for development environments.
 * Requirements: 21.1, 21.2, 21.4, 21.6, 21.7, 21.8, 21.16, 43.1, 43.5, 43.9, 43.10, 43.18.
 */
export class InstaboxDockerBackend implements ExecutionBackend {
  readonly kind: BackendKind = "instabox-docker";
  readonly options: InstaboxDockerBackendOptions;
  public runner: DockerRunner;

  private readonly sandboxesById = new Map<string, InstaboxDockerSandbox>();
  private readonly sandboxesByIdempotencyKey = new Map<string, InstaboxDockerSandbox>();

  constructor(options?: InstaboxDockerBackendOptions) {
    this.options = { ...(options ?? {}) };
    this.runner =
      this.options.runner ??
      this.options.dockerRunner ??
      defaultChildProcessRunner;
  }

  public setRunner(runner: DockerRunner): void {
    this.runner = runner;
  }

  /**
   * Fills the required housekeeping timeout into a runner call that carries no
   * timeout of its own, so the stream's group-kill and inspect calls issued
   * during a sandbox run are bounded too. docker wait is exempt: it blocks
   * until the container exits. Requirements: SC2, N-C3.
   */
  public withHousekeepingTimeout(
    argv: string[],
    options?: DockerRunnerOptions
  ): DockerRunnerOptions | undefined {
    if (
      argv[0] !== "wait" &&
      (options?.timeoutMs === undefined || options?.timeoutMs === null)
    ) {
      const housekeepingTimeoutMs = requireHousekeepingTimeoutSettings(
        this.options.settings
      );
      return { ...options, timeoutMs: housekeepingTimeoutMs };
    }
    return options;
  }

  public async runDocker(
    argv: string[],
    options?: DockerRunnerOptions
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let callOptions = options;
    if (
      argv[0] !== "wait" &&
      (callOptions?.timeoutMs === undefined || callOptions?.timeoutMs === null)
    ) {
      callOptions = {
        ...callOptions,
        timeoutMs: requireHousekeepingTimeoutSettings(this.options.settings),
      };
    }
    try {
      const rawResult = await this.runner(argv, callOptions);
      if (typeof rawResult === "string") {
        throw new Error(
          `Docker runner returned a string instead of an integer exit code: '${rawResult}'`
        );
      }
      if (!rawResult || typeof rawResult !== "object") {
        throw new Error(
          `Docker runner result must be an object with an integer exit code, received: ${typeof rawResult}`
        );
      }
      const rawCode = rawResult.exitCode ?? rawResult.code;
      if (rawCode === undefined || rawCode === null) {
        throw new Error("Docker runner result is missing exit code");
      }
      if (typeof rawCode === "string") {
        throw new Error(
          `Docker runner exit code must be an integer, received string: '${rawCode}'`
        );
      }
      if (typeof rawCode !== "number" || !Number.isInteger(rawCode)) {
        throw new Error(
          `Docker runner exit code must be an integer, received: ${rawCode}`
        );
      }
      const exitCode = rawCode;
      const stdout =
        typeof rawResult.stdout === "string"
          ? rawResult.stdout
          : Buffer.isBuffer(rawResult.stdout)
          ? rawResult.stdout.toString("utf8")
          : "";
      const stderr =
        typeof rawResult.stderr === "string"
          ? rawResult.stderr
          : Buffer.isBuffer(rawResult.stderr)
          ? rawResult.stderr.toString("utf8")
          : "";
      return { exitCode, stdout, stderr };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        !(err instanceof Error && err.message.startsWith("Docker runner")) &&
        (typeof (err as { exitCode?: unknown }).exitCode === "number" ||
          typeof (err as { code?: unknown }).code === "number")
      ) {
        const e = err as {
          exitCode?: number;
          code?: number;
          stdout?: unknown;
          stderr?: unknown;
          message?: string;
        };
        const rawCode = e.exitCode ?? e.code;
        if (typeof rawCode === "number" && Number.isInteger(rawCode)) {
          return {
            exitCode: rawCode,
            stdout: e.stdout ? String(e.stdout) : "",
            stderr: e.stderr ? String(e.stderr) : (e.message ?? ""),
          };
        }
      }
      throw err;
    }
  }

  private resolveRole(spec: SandboxSpec): string {
    const roleCandidate =
      spec.labels?.["git-graveyard.box-role"] ??
      spec.labels?.["kind"] ??
      spec.labels?.["role"] ??
      spec.labels?.["boxRole"] ??
      (spec as { role?: unknown }).role ??
      (spec as { kind?: unknown }).kind;

    if (typeof roleCandidate === "string" && roleCandidate.trim()) {
      return roleCandidate.trim();
    }

    if (
      spec.idempotencyKey.includes("auditbox") ||
      spec.idempotencyKey.includes("warden")
    ) {
      return "auditbox";
    }
    if (spec.idempotencyKey.includes("runbox")) {
      return "runbox";
    }

    return "";
  }

  public collectAndValidateMounts(
    spec: SandboxSpec,
    role: string
  ): Array<{ source: string; target: string; readOnly: boolean }> {
    const allMounts: Array<{ source: string; target: string; readOnly: boolean }> = [];

    if (spec.workspace && typeof spec.workspace === "object") {
      if (spec.workspace.mode === "bind") {
        const m = parseAndValidateMount(
          spec.workspace,
          role,
          "workspace mount specification"
        );
        allMounts.push(m);
      }
    }

    const anySpec = spec as {
      mounts?: unknown;
      binds?: unknown;
    };

    if (anySpec.mounts !== undefined && anySpec.mounts !== null) {
      if (!Array.isArray(anySpec.mounts)) {
        throw new MountSecurityError("spec.mounts must be an array");
      }
      for (const m of anySpec.mounts) {
        allMounts.push(
          parseAndValidateMount(m, role, "mount specification in mounts")
        );
      }
    }

    if (anySpec.binds !== undefined && anySpec.binds !== null) {
      if (!Array.isArray(anySpec.binds)) {
        throw new MountSecurityError("spec.binds must be an array");
      }
      for (const b of anySpec.binds) {
        allMounts.push(
          parseAndValidateMount(b, role, "mount specification in binds")
        );
      }
    }

    const seenTargets = new Set<string>();
    for (const m of allMounts) {
      if (seenTargets.has(m.target)) {
        throw new MountSecurityError(
          `Rejecting two mounts with the same container target: '${m.target}'`
        );
      }
      seenTargets.add(m.target);
    }

    return allMounts;
  }

  private validateSpecMounts(spec: SandboxSpec): void {
    const role = this.resolveRole(spec);
    this.collectAndValidateMounts(spec, role);
  }

  private resolveAndValidateImage(spec: SandboxSpec): string {
    const candidate =
      spec.image ??
      this.options.image ??
      process.env.INSTABOX_DOCKER_IMAGE ??
      process.env.BOX_IMAGE;

    if (!candidate || typeof candidate !== "string" || !candidate.trim()) {
      throw new ImageConfigError(
        "Pinned digest image is required by configuration but was not provided"
      );
    }

    const trimmed = candidate.trim();
    if (!isPinnedDigestImage(trimmed)) {
      throw new ImageConfigError(
        `Image '${trimmed}' does not contain a pinned digest (e.g. image@sha256:...)`
      );
    }

    return trimmed;
  }

  private buildCreateArgv(spec: SandboxSpec, image: string): string[] {
    // Network policy and proxy configuration (Requirement 21.9, 43.11)
    const runId =
      spec.labels?.["git-graveyard.run-id"] ??
      spec.labels?.["runId"] ??
      (spec as { runId?: string }).runId;

    let activePolicy: RunNetworkPolicy | undefined;
    if (runId) {
      const registered = getRunNetworkPolicy(runId);
      if (registered) {
        activePolicy = registered;
      } else if (
        this.options.networkPolicy &&
        this.options.networkPolicy.runId === runId
      ) {
        activePolicy = this.options.networkPolicy;
      } else {
        throw new NetworkPolicyRequiredError(
          runId,
          `No network policy registered for run '${runId}' (Requirement 21.9, 43.11)`
        );
      }
    } else {
      activePolicy = this.options.networkPolicy;
      if (!activePolicy) {
        throw new NetworkPolicyRequiredError(
          undefined,
          "No network policy registered for run (Requirement 21.9, 43.11)"
        );
      }
    }

    const argv: string[] = ["create"];

    // Hardening: Drop all capabilities (Requirement 21.2)
    argv.push("--cap-drop=ALL");

    // Hardening: No new privileges (Requirement 21.2)
    argv.push("--security-opt", "no-new-privileges");

    // Hardening: Read-only root filesystem (Requirement 21.4)
    argv.push("--read-only");

    // Hardening: tmpfs scratch space with disk limit (Requirement 21.4)
    const diskLimit = resolveDiskLimit(spec);
    argv.push("--tmpfs", `/tmp:size=${diskLimit}`);

    // User configuration: Non-root user (Requirement 21.3, 43.7, L-2)
    validateUserSpec(spec);
    let userArg = "1000:1000";
    if (spec.user && typeof spec.user === "object") {
      const uid = spec.user.uid;
      const gid = spec.user.gid;
      userArg = gid !== undefined ? `${uid}:${gid}` : `${uid}`;
    } else if (spec.uid !== undefined) {
      userArg = String(spec.uid);
    } else if (spec.userId !== undefined) {
      userArg = String(spec.userId);
    } else if (typeof spec.user === "number" || typeof spec.user === "string") {
      userArg = String(spec.user).trim();
    }
    argv.push("--user", userArg);

    // Resources limits (Requirement 21.4)
    if (spec.resources) {
      if (typeof spec.resources.cpus === "number") {
        argv.push("--cpus", String(spec.resources.cpus));
      }
      if (typeof spec.resources.memoryMiB === "number") {
        argv.push("--memory", `${spec.resources.memoryMiB}m`);
      }
      if (typeof spec.resources.pids === "number") {
        argv.push("--pids-limit", String(spec.resources.pids));
      }
    }

    // Container name
    const specRaw = spec as { name?: unknown; containerName?: unknown };
    if (specRaw.name !== undefined) {
      assertValidContainerId(specRaw.name);
    }
    if (specRaw.containerName !== undefined) {
      assertValidContainerId(specRaw.containerName);
    }
    const containerName =
      (typeof specRaw.name === "string" ? specRaw.name : undefined) ??
      (typeof specRaw.containerName === "string" ? specRaw.containerName : undefined) ??
      `graveyard-${spec.idempotencyKey.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    assertValidContainerId(containerName);
    argv.push("--name", containerName);

    // Labels
    const role = this.resolveRole(spec);
    const labels: Record<string, string> = {
      "git-graveyard.managed": "true",
      "git-graveyard.idempotency-key": spec.idempotencyKey,
      ...(this.options.labels ?? {}),
      ...(spec.labels ?? {}),
    };
    if (role) {
      labels["git-graveyard.box-role"] = role;
    }
    for (const [key, value] of Object.entries(labels)) {
      argv.push("--label", `${key}=${value}`);
    }

    // Environment variables
    if (spec.env && typeof spec.env === "object") {
      for (const [key, value] of Object.entries(spec.env)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          throw new SpecValidationError(
            `Environment variable name '${key}' is invalid; must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`
          );
        }
        if (isForbiddenEnvName(key)) {
          throw new SpecValidationError(
            `Environment variable name '${key}' matches secret denylist`
          );
        }
        if (typeof value === "string" && isForbiddenEnvValue(value)) {
          throw new SpecValidationError(
            `Environment variable '${key}' value matches secret pattern`
          );
        }
        argv.push("--env", `${key}=${value}`);
      }
    }

    // Network policy and proxy configuration (Requirement 21.9, 43.11)
    argv.push(...buildContainerNetworkArgs(activePolicy));

    // Bind mount workspace with --mount type=bind instead of -v (Requirement 43.10, H-2)
    // Rule 6: The mount argument uses the realpath result, not the raw hostPath
    const mounts = this.collectAndValidateMounts(spec, role);
    for (const m of mounts) {
      const readOnlyPart = m.readOnly ? ",readonly" : "";
      argv.push(
        "--mount",
        `type=bind,source=${m.source},target=${m.target}${readOnlyPart}`
      );
    }

    // Pinned image (Requirement 21.1)
    argv.push(image);

    // Optional command argv
    if (Array.isArray(spec.argv) && spec.argv.length > 0) {
      argv.push(...spec.argv);
    } else if (Array.isArray(spec.command) && spec.command.length > 0) {
      argv.push(...spec.command);
    }

    return argv;
  }

  /**
   * Provisions a Docker container adhering to container hardening and filesystem isolation.
   * Requirements: 21.1, 21.2, 21.4, 21.6, 21.7, 21.8, 43.5, 43.10.
   */
  async create(spec: SandboxSpec): Promise<InstaboxDockerSandbox> {
    if (!spec || typeof spec !== "object") {
      throw new SpecValidationError("SandboxSpec must be an object");
    }

    if (!spec.idempotencyKey || typeof spec.idempotencyKey !== "string") {
      throw new SpecValidationError("idempotencyKey is required");
    }

    // Idempotency check: in-memory cache
    if (this.sandboxesByIdempotencyKey.has(spec.idempotencyKey)) {
      return this.sandboxesByIdempotencyKey.get(spec.idempotencyKey)!;
    }

    const specRaw = spec as { name?: unknown; containerName?: unknown };
    if (specRaw.name !== undefined) {
      assertValidContainerId(specRaw.name);
    }
    if (specRaw.containerName !== undefined) {
      assertValidContainerId(specRaw.containerName);
    }

    // Security validation against secret denylist, user 0, shell strings
    validateSandboxSpec(spec);

    // Validate environment variables against secret denylist (Requirements 21.5, 43.4)
    if (spec.env && typeof spec.env === "object") {
      for (const [key, value] of Object.entries(spec.env)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          throw new SpecValidationError(
            `Environment variable name '${key}' is invalid; must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`
          );
        }
        if (isForbiddenEnvName(key)) {
          throw new SpecValidationError(
            `Environment variable name '${key}' matches secret denylist`
          );
        }
        if (typeof value === "string" && isForbiddenEnvValue(value)) {
          throw new SpecValidationError(
            `Environment variable '${key}' value matches secret pattern`
          );
        }
      }
    }

    // Validate user spec (Requirements 21.3, 43.7, L-2)
    validateUserSpec(spec);

    // Unsupported sync workspace mode in v1 (Requirement 43.10)
    if (
      spec.workspace &&
      typeof spec.workspace === "object" &&
      spec.workspace.mode === "sync"
    ) {
      throw new NotInV1Error(
        "Workspace sync mode is not supported in v1 InstaboxDockerBackend (Requirement 43.10)"
      );
    }

    // Validate filesystem mounts: no KIRO_HOME, host home, /data, .git; role boundaries
    this.validateSpecMounts(spec);

    // Image resolution: must be pinned digest
    const image = this.resolveAndValidateImage(spec);

    // Build docker create arguments
    const createArgv = this.buildCreateArgv(spec, image);

    // Execute via injected runner
    const result = await this.runDocker(createArgv);
    if (result.exitCode !== 0) {
      throw new Error(
        `docker create failed with exit code ${result.exitCode}: ${result.stderr}`
      );
    }

    const containerId =
      result.stdout.trim().split("\n")[0]?.trim() ||
      `box-${spec.idempotencyKey}`;

    const sandbox = new InstaboxDockerSandbox(containerId, spec, this, "created");

    this.sandboxesById.set(containerId, sandbox);
    this.sandboxesByIdempotencyKey.set(spec.idempotencyKey, sandbox);

    return sandbox;
  }

  /**
   * Re-attaches an existing Box for restart recovery.
   * Requirement 43.9.
   */
  async get(containerId: string): Promise<InstaboxDockerSandbox | undefined> {
    assertValidContainerId(containerId);
    const id = containerId;

    if (this.sandboxesById.has(id)) {
      return this.sandboxesById.get(id);
    }
    if (this.sandboxesByIdempotencyKey.has(id)) {
      return this.sandboxesByIdempotencyKey.get(id);
    }

    try {
      const res = await this.runDocker(["inspect", id]);
      if (res.exitCode !== 0 || !res.stdout.trim()) {
        return undefined;
      }

      const inspectData = JSON.parse(res.stdout);
      const containerInfo = Array.isArray(inspectData)
        ? inspectData[0]
        : inspectData;
      if (!containerInfo) {
        return undefined;
      }

      const containerId = containerInfo.Id ?? containerInfo.id ?? id;
      const labels = (containerInfo.Config?.Labels ?? {}) as Record<
        string,
        string
      >;
      const idempotencyKey =
        labels["git-graveyard.idempotency-key"] ??
        labels["idempotencyKey"] ??
        id;
      const state = containerInfo.State?.Status ?? "running";

      const sandbox = new InstaboxDockerSandbox(
        containerId,
        {
          idempotencyKey,
          labels,
        },
        this,
        state
      );

      this.sandboxesById.set(containerId, sandbox);
      this.sandboxesByIdempotencyKey.set(idempotencyKey, sandbox);

      return sandbox;
    } catch (_err) {
      return undefined;
    }
  }

  /**
   * Lists boxes filtered by labels for restart recovery.
   * Requirement 43.9.
   */
  async list(labels?: Record<string, string>): Promise<InstaboxDockerSandbox[]> {
    const resultBoxes: InstaboxDockerSandbox[] = [];
    const seenIds = new Set<string>();

    try {
      const argv = ["ps", "-a", "--no-trunc", "--format", "{{json .}}"];
      if (labels && Object.keys(labels).length > 0) {
        for (const [key, value] of Object.entries(labels)) {
          argv.push("--filter", `label=${key}=${value}`);
        }
      }

      const res = await this.runDocker(argv);
      if (res.exitCode === 0 && res.stdout.trim()) {
        const lines = res.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        for (const line of lines) {
          let containerId = "";
          let containerLabels: Record<string, string> = {};
          let state = "running";

          try {
            const parsed = JSON.parse(line);
            containerId = parsed.ID ?? parsed.Id ?? parsed.id ?? "";
            state = parsed.State ?? parsed.Status ?? "running";
            if (typeof parsed.Labels === "string") {
              containerLabels = parseDockerPsLabels(parsed.Labels);
            } else if (
              typeof parsed.Labels === "object" &&
              parsed.Labels !== null
            ) {
              containerLabels = parsed.Labels as Record<string, string>;
            }
          } catch (_err) {
            containerId = line.split(/\s+/)[0];
          }

          if (containerId && !seenIds.has(containerId)) {
            seenIds.add(containerId);
            let sandbox = this.sandboxesById.get(containerId);
            if (!sandbox) {
              const idempotencyKey =
                containerLabels["git-graveyard.idempotency-key"] ??
                containerLabels["idempotencyKey"] ??
                containerId;
              sandbox = new InstaboxDockerSandbox(
                containerId,
                {
                  idempotencyKey,
                  labels: containerLabels,
                },
                this,
                state
              );
              this.sandboxesById.set(containerId, sandbox);
              this.sandboxesByIdempotencyKey.set(idempotencyKey, sandbox);
            }
            resultBoxes.push(sandbox);
          }
        }
      }
    } catch (_err) {
      // Ignore docker ps failure; fallback to matching in-memory
    }

    for (const sandbox of this.sandboxesById.values()) {
      if (!seenIds.has(sandbox.id)) {
        if (this.matchesLabels(sandbox.labels, labels)) {
          seenIds.add(sandbox.id);
          resultBoxes.push(sandbox);
        }
      }
    }

    return resultBoxes;
  }

  private matchesLabels(
    candidate: Record<string, string>,
    filter?: Record<string, string>
  ): boolean {
    if (!filter || Object.keys(filter).length === 0) {
      return true;
    }
    for (const [k, v] of Object.entries(filter)) {
      if (candidate[k] !== v) {
        return false;
      }
    }
    return true;
  }

  /**
   * Destroys boxes for a run or a specific box without creating any snapshot.
   * Requirements: 21.16, 43.18.
   */
  async destroy(sandbox: string | Sandbox): Promise<void> {
    const rawId = typeof sandbox === "string" ? sandbox : sandbox?.id;
    assertValidContainerId(rawId);
    const id: string = rawId;

    const targetsToDestroy = new Set<string>();
    let runIdToRelease: string | undefined;

    // Check if id matches a runId
    for (const s of this.sandboxesById.values()) {
      const runId =
        s.labels?.["git-graveyard.run-id"] ??
        s.labels?.["runId"] ??
        s.labels?.["run"];
      if (runId === id) {
        targetsToDestroy.add(s.id);
        runIdToRelease = runId;
      }
    }

    if (targetsToDestroy.size === 0) {
      const s =
        this.sandboxesById.get(id) ??
        this.sandboxesByIdempotencyKey.get(id);
      if (s) {
        targetsToDestroy.add(s.id);
        const runId =
          s.labels?.["git-graveyard.run-id"] ?? s.labels?.["runId"];
        if (runId) {
          runIdToRelease = runId;
        }
      } else {
        targetsToDestroy.add(id);
      }
    }

    for (const containerId of targetsToDestroy) {
      try {
        await this.runDocker(["rm", "-f", "-v", containerId]);
      } catch (_err) {
        // Safe destruction
      }
      this.sandboxesById.delete(containerId);
      for (const [key, s] of this.sandboxesByIdempotencyKey.entries()) {
        if (s.id === containerId) {
          this.sandboxesByIdempotencyKey.delete(key);
        }
      }
    }

    if (runIdToRelease) {
      try {
        releaseRunNetworkPolicy(runIdToRelease);
      } catch (_err) {
        // Safe release
      }
    }
  }

  async destroyRun(runId: string): Promise<void> {
    await this.destroy(runId);
  }

  async destroyBox(boxId: string): Promise<void> {
    await this.destroy(boxId);
  }

  async snapshot(_id?: string): Promise<never> {
    throw new NotInV1Error(
      "Snapshots are not supported in v1 (Requirement 21.16, 43.18)"
    );
  }

  async syncIn(): Promise<never> {
    throw new NotInV1Error("syncIn is not supported in v1 InstaboxDockerBackend");
  }

  async syncOut(): Promise<never> {
    throw new NotInV1Error("syncOut is not supported in v1 InstaboxDockerBackend");
  }

  /**
   * Signals only the command's own process group inside the container.
   * Takes the numeric pgid recorded for that command; a missing or invalid pgid
   * (not a safe integer greater than 1) is an error. There is no user argument and
   * no user-wide sweep. Cleanup errors propagate to the caller: no catch hides a
   * failure. Requirements: 20.11, H-3, R6-A2.
   */
  async sweepProcesses(containerId: string, pgid?: number | string): Promise<void> {
    assertValidContainerId(containerId);
    const numericPgid =
      typeof pgid === "number"
        ? pgid
        : typeof pgid === "string" && /^\d+$/.test(pgid.trim())
        ? Number(pgid.trim())
        : Number.NaN;
    if (!Number.isSafeInteger(numericPgid) || numericPgid <= 1) {
      throw new SpecValidationError(
        `sweepProcesses requires a numeric pgid greater than 1 for the command's own process group; received ${String(pgid)}`
      );
    }
    const killArgv = ["exec", containerId, "kill", "--", `-${numericPgid}`];
    await this.runner(killArgv, this.withHousekeepingTimeout(killArgv));
  }
}

export default InstaboxDockerBackend;
