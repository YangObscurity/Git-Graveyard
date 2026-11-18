// Task 7.4: Streaming sandbox_exec execution and command process group cleanup
// Requirements: 20.11, 20.12, 21.13, 43.2, 43.6, H-3, M-5, M-6, L-2

import * as path from "node:path";
import {
  SpecValidationError,
  validateExecRequest,
} from "./spec-validator";
import type {
  ExecChunk,
  ExecProcess,
  ExecRequest,
  ExecResult,
  SandboxSpec,
} from "./types";
import {
  LogStore,
  type StoreCommandOutputParams,
  type StoredCommandResult,
  extractTail,
} from "../events/log-store";
import type {
  DockerRunner,
  DockerRunnerOptions,
  DockerRunnerResult,
} from "./instabox-docker-backend";

/**
 * Interface representing a store that can persist execution logs by logRef.
 */
export interface LogStoreLike {
  storeCommandOutput?(
    params: StoreCommandOutputParams
  ): StoredCommandResult | Promise<StoredCommandResult>;
  writeLog?(
    logRef: string,
    content: string | Buffer,
    metadata?: Record<string, unknown>
  ): string | Promise<string>;
  getLog?(logRef: string): string | null | Promise<string | null>;
  [key: string]: unknown;
}

/**
 * Injected docker runner: function or object exposing runDocker/runner.
 */
export type InjectedDockerRunner =
  | DockerRunner
  | {
      runDocker: (
        argv: string[],
        options?: DockerRunnerOptions
      ) => Promise<DockerRunnerResult | string | unknown> | DockerRunnerResult | string | unknown;
      runner?: DockerRunner;
    }
  | {
      runner: DockerRunner;
    };

/**
 * Options for DockerExecStream execution.
 */
export interface DockerExecStreamOptions {
  containerId?: string;
  boxId?: string;
  runner?: InjectedDockerRunner;
  dockerRunner?: InjectedDockerRunner;
  store?: LogStoreLike | LogStore;
  logStore?: LogStoreLike | LogStore;
  user?: string | number;
  uid?: number;
  runId?: string;
  logRef?: string;
  defaultTimeoutMs?: number;
  maxTailLines?: number;
  maxTailBytes?: number;
  sandbox?: {
    id?: string;
    containerId?: string;
    spec?: Partial<SandboxSpec>;
    backend?: {
      runner?: InjectedDockerRunner;
      runDocker?: (argv: string[], options?: DockerRunnerOptions) => Promise<unknown>;
    };
  };
  spec?: Partial<SandboxSpec>;
  envAllowlist?: string[] | Set<string>;
  dockerHost?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExecExitStatus {
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  oomKilled: boolean;
}

/**
 * Custom error thrown when a runner result has an invalid or string exit code.
 * Requirement M-5.
 */
export class RunnerExitCodeError extends Error {
  readonly code = "INVALID_RUNNER_EXIT_CODE";
  constructor(message: string) {
    super(message);
    this.name = "RunnerExitCodeError";
  }
}

/**
 * Marker the wrapper shell writes to stderr so the stream can learn the real
 * process group id of the command. The shell started by setsid is the session
 * leader, so its pid is the process group id, and exec keeps that pid.
 * Group ids are never invented; the group is known only once this marker line
 * arrives on the container's stderr. Requirement H-3.
 */
export const PGID_MARKER = "__GG_PGID__";

/**
 * Anchored regex for safe container IDs: starts with alphanumeric, followed by up to 127
 * alphanumeric, underscore, dot, or dash characters (length 1 to 128).
 */
export const SAFE_CONTAINER_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/**
 * Maximum byte cap for stream accumulators (20 MiB).
 */
export const STREAM_ACCUM_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Asserts containerId is a valid non-empty string matching SAFE_CONTAINER_ID_REGEX
 * and does not start with a dash. Returns the validated containerId string.
 */
export function assertValidStreamContainerId(containerId: unknown): string {
  if (typeof containerId !== "string" || containerId.length === 0) {
    throw new SpecValidationError("Container id must be a non-empty string");
  }
  if (containerId.startsWith("-")) {
    throw new SpecValidationError(
      `Container id must not start with a dash: '${containerId}'`
    );
  }
  if (!SAFE_CONTAINER_ID_REGEX.test(containerId)) {
    throw new SpecValidationError(
      `Container id '${containerId}' contains invalid characters or exceeds 128 characters; must match ${SAFE_CONTAINER_ID_REGEX}`
    );
  }
  return containerId;
}

/**
 * Appends addition to current string up to maxBytes limit.
 */
export function appendWithCap(
  current: string,
  currentBytes: number,
  addition: string,
  maxBytes: number = STREAM_ACCUM_MAX_BYTES
): { text: string; bytes: number } {
  if (currentBytes >= maxBytes) {
    return { text: current, bytes: currentBytes };
  }
  const addBuf = Buffer.from(addition, "utf8");
  if (currentBytes + addBuf.byteLength <= maxBytes) {
    return {
      text: current + addition,
      bytes: currentBytes + addBuf.byteLength,
    };
  }
  const remaining = maxBytes - currentBytes;
  const sliced = addBuf.subarray(0, remaining).toString("utf8");
  return {
    text: current + sliced,
    bytes: maxBytes,
  };
}

/**
 * Shell script executed as ['setsid', '-w', 'sh', '-c', SCRIPT, ...argv]:
 * prints the process group marker to stderr, then execs the command with the
 * same pid, keeping it the process group id. Requirement H-3.
 */
export const COMMAND_GROUP_SCRIPT = `echo ${PGID_MARKER} $$ 1>&2; exec "$0" "$@"`;

/**
 * Wraps an argv command so it starts as its own session leader inside the
 * container: ['setsid', '-w', 'sh', '-c', SCRIPT, ...argv].
 * setsid -w (util-linux) waits for the wrapped command and returns its exit
 * status, so the command's exit code propagates through the wrapper in every
 * case; plain setsid forks and returns 0 when the process is already a group
 * leader. The wrapper is never skipped, not even when argv[0] is setsid
 * itself. Requirement H-3.
 */
export function wrapWithSetsid(argv: string[]): string[] {
  return ["setsid", "-w", "sh", "-c", COMMAND_GROUP_SCRIPT, ...argv];
}

/**
 * Invoke the injected runner across function or object variations.
 * The returned result always carries an integer exit code; a missing, string
 * or non-integer exit code throws RunnerExitCodeError (M-5).
 */
async function invokeRunner(
  runner: InjectedDockerRunner,
  argv: string[],
  options?: DockerRunnerOptions
): Promise<DockerRunnerResult & { exitCode: number }> {
  let raw: unknown;
  if (typeof runner === "function") {
    raw = await runner(argv, options);
  } else if (runner && typeof (runner as { runDocker?: unknown }).runDocker === "function") {
    raw = await (runner as { runDocker: (a: string[], o?: DockerRunnerOptions) => unknown }).runDocker(argv, options);
  } else if (runner && typeof (runner as { runner?: unknown }).runner === "function") {
    const fn = (runner as { runner: DockerRunner }).runner;
    raw = await fn(argv, options);
  } else {
    throw new Error("Invalid injected docker runner");
  }

  if (typeof raw === "string") {
    throw new RunnerExitCodeError(
      `Docker runner returned a string instead of an integer exit code: '${raw}'`
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new RunnerExitCodeError(
      `Docker runner result must be an object with an integer exit code, received: ${typeof raw}`
    );
  }
  const r = raw as DockerRunnerResult;
  const rawObj = raw as Record<string, unknown>;
  const rawCode = r.exitCode ?? rawObj.code;
  if (typeof rawCode === "string") {
    throw new RunnerExitCodeError(
      `Docker runner exit code must be an integer, received string: '${rawCode}'`
    );
  }
  if (typeof rawCode !== "number" || !Number.isInteger(rawCode)) {
    throw new RunnerExitCodeError(
      `Docker runner result must include an integer exit code, received: ${String(rawCode)}`
    );
  }
  const exitCode = rawCode;
  const stdout =
    typeof r.stdout === "string"
      ? r.stdout
      : Buffer.isBuffer(r.stdout)
      ? r.stdout.toString("utf8")
      : "";
  const stderr =
    typeof r.stderr === "string"
      ? r.stderr
      : Buffer.isBuffer(r.stderr)
      ? r.stderr.toString("utf8")
      : "";
  return { ...r, exitCode, stdout, stderr };
}

function isZeroOrRootUid(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (val === 0) return true;
  if (typeof val === "number") return val === 0;
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    if (
      trimmed === "root" ||
      trimmed.startsWith("root:") ||
      trimmed === "root:root"
    ) {
      return true;
    }
    const first = trimmed.split(":")[0];
    if (first === "root" || /^0+$/.test(first)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a user representation is root or UID 0.
 * Recognizes numeric uids, including leading zeros (e.g. '00'), as root.
 * Requirement 21.3, 43.7, L-2.
 */
export function isRootUser(user: unknown): boolean {
  if (user === undefined || user === null) {
    return false;
  }
  if (isZeroOrRootUid(user)) {
    return true;
  }
  if (typeof user === "object") {
    const u = user as Record<string, unknown>;
    return (
      isZeroOrRootUid(u.uid) ||
      isZeroOrRootUid(u.user) ||
      isZeroOrRootUid(u.userId) ||
      isZeroOrRootUid(u.name) ||
      isZeroOrRootUid(u.username)
    );
  }
  return false;
}

/**
 * Denylist patterns for environment variable names and values.
 * Requirement 43.4.
 */
export const FORBIDDEN_ENV_NAME_SUBSTRINGS = [
  "KIRO",
  "GITHUB",
  "TOKEN",
  "SECRET",
  "KEY",
  "PASSWORD",
  "CREDENTIAL",
] as const;

export const FORBIDDEN_ENV_VALUE_PREFIXES = [
  "ksk_",
  "ghp_",
  "ghs_",
  "gho_",
  "ghu_",
  "ghr_",
  "github_pat_",
] as const;

export function isForbiddenEnvName(name: string): boolean {
  if (typeof name !== "string") return false;
  const upper = name.toUpperCase();
  return FORBIDDEN_ENV_NAME_SUBSTRINGS.some((sub) => upper.includes(sub));
}

export function isForbiddenEnvValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return FORBIDDEN_ENV_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Resolves the non-root user from the sandbox spec or options.
 * Defaults to "1000:1000" if unspecified.
 * Refuses user 0 or root.
 * Refuses user spec without a numeric uid and never produces '-u undefined'.
 * Requirements: 21.3, 43.7, L-2.
 */
export function resolveNonRootUser(
  spec?: Partial<SandboxSpec> | null,
  explicitUser?: string | number
): string {
  if (explicitUser !== undefined && explicitUser !== null) {
    if (isRootUser(explicitUser)) {
      throw new SpecValidationError("User ID 0 (root) is forbidden");
    }
    const str = String(explicitUser).trim();
    if (!/^\d+(:\d+)?$/.test(str)) {
      throw new SpecValidationError(
        "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
      );
    }
  }

  if (spec) {
    const raw = spec as Record<string, unknown>;

    // Refuse root users across any representation (Requirement 21.3, 43.7, L-2)
    if (isRootUser(raw.user) || isRootUser(raw.uid) || isRootUser(raw.userId)) {
      throw new SpecValidationError("User ID 0 (root) is forbidden");
    }

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
        const uid = u.uid;
        const gid = u.gid;
        return gid !== undefined ? `${uid}:${gid}` : `${uid}`;
      } else if (typeof raw.user === "number") {
        if (!Number.isInteger(raw.user) || raw.user <= 0) {
          throw new SpecValidationError(
            "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
          );
        }
        return String(raw.user);
      } else if (typeof raw.user === "string") {
        const trimmed = raw.user.trim();
        if (!/^\d+(:\d+)?$/.test(trimmed)) {
          throw new SpecValidationError(
            "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
          );
        }
        const uidNum = parseInt(trimmed.split(":")[0], 10);
        if (uidNum <= 0) {
          throw new SpecValidationError(
            "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
          );
        }
        return trimmed;
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
      return String(raw.uid);
    }

    if ("userId" in raw && raw.userId !== undefined && raw.userId !== null) {
      if (typeof raw.userId !== "number" || !Number.isInteger(raw.userId) || raw.userId <= 0) {
        throw new SpecValidationError(
          "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
        );
      }
      return String(raw.userId);
    }
  }

  if (explicitUser !== undefined && explicitUser !== null && String(explicitUser).trim()) {
    return String(explicitUser).trim();
  }

  return "1000:1000";
}

/**
 * Builds the explicit minimal environment for child processes running docker.
 * Only PATH and LANG, plus DOCKER_HOST when the spec or options name it.
 * Must not inherit process.env.
 */
export function getMinimalDockerEnv(options?: DockerRunnerOptions): Record<string, string> {
  const minimal: Record<string, string> = {
    PATH: options?.env?.PATH ?? process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: options?.env?.LANG ?? process.env.LANG ?? "C.UTF-8",
  };

  const rawOptions = options as Record<string, unknown> | undefined;
  const rawSpec = (rawOptions?.spec ?? (rawOptions?.sandbox as Record<string, unknown> | undefined)?.spec) as
    | Record<string, unknown>
    | undefined;

  const dockerHost =
    rawOptions?.dockerHost as string | undefined ??
    rawSpec?.dockerHost as string | undefined ??
    (rawSpec?.env as Record<string, string> | undefined)?.DOCKER_HOST ??
    options?.env?.DOCKER_HOST;

  if (typeof dockerHost === "string" && dockerHost.trim().length > 0) {
    minimal.DOCKER_HOST = dockerHost.trim();
  }

  return minimal;
}

/**
 * Validates that an ExecRequest strictly uses argv arrays and rejects shell command strings.
 * Refuses caller-supplied user of 0 or root, and secret env names or values.
 * Requirements: 20.12, 21.3, 43.2, 43.4, 43.7, M-6.
 */
export function validateCommandArgv(req: ExecRequest): void {
  validateExecRequest(req);

  if (!req || typeof req !== "object") {
    throw new SpecValidationError("ExecRequest must be an object");
  }

  const raw = req as Record<string, unknown>;
  if (typeof raw.command === "string" || typeof raw.cmd === "string") {
    throw new SpecValidationError("Command formatted as shell string instead of argv array");
  }

  if (!Array.isArray(req.argv) || req.argv.length === 0) {
    throw new SpecValidationError("ExecRequest argv must be a non-empty array of strings");
  }

  for (const item of req.argv) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new SpecValidationError("ExecRequest argv elements must be non-empty strings");
    }
  }

  // Refuse caller-supplied user 0 or root in request
  if (isRootUser(raw.user) || isRootUser(raw.uid)) {
    throw new SpecValidationError("User ID 0 (root) is forbidden");
  }

  // Refuse secret denylist in env
  if (req.env && typeof req.env === "object") {
    for (const [k, v] of Object.entries(req.env)) {
      if (isForbiddenEnvName(k)) {
        throw new SpecValidationError(
          `Environment variable name '${k}' matches secret denylist`
        );
      }
      if (typeof v === "string" && isForbiddenEnvValue(v)) {
        throw new SpecValidationError(
          `Environment variable '${k}' value matches secret pattern`
        );
      }
    }
  }

  // Refuse zero, negative, non-finite, or non-safe-integer timeoutMs (Rule 3, M-6)
  if (req.timeoutMs !== undefined) {
    if (
      typeof req.timeoutMs !== "number" ||
      !Number.isFinite(req.timeoutMs) ||
      !Number.isSafeInteger(req.timeoutMs) ||
      req.timeoutMs <= 0
    ) {
      throw new SpecValidationError(
        `timeoutMs must be a positive integer; received ${String(req.timeoutMs)}`
      );
    }
  }
}

/**
 * Resolves timeoutMs ensuring it is a positive safe integer not exceeding configured maximum.
 * The maximum comes from settings, and a missing setting rejects.
 * Requirement M-6.
 */
export function resolveTimeoutMs(
  reqTimeoutMs?: number,
  defaultTimeoutMs?: number,
  spec?: Partial<SandboxSpec> | null,
  settings?: Record<string, unknown> | null
): number {
  if (reqTimeoutMs !== undefined) {
    if (
      typeof reqTimeoutMs !== "number" ||
      !Number.isFinite(reqTimeoutMs) ||
      !Number.isSafeInteger(reqTimeoutMs) ||
      reqTimeoutMs <= 0
    ) {
      throw new SpecValidationError(
        `timeoutMs must be a positive safe integer; received ${String(reqTimeoutMs)}`
      );
    }
  }

  const candidates: number[] = [];

  const rawSettings = settings as Record<string, unknown> | undefined | null;
  if (rawSettings && typeof rawSettings === "object") {
    const sMax =
      rawSettings.maxTimeoutMs ??
      rawSettings.maxTimeout ??
      rawSettings.timeoutMs ??
      rawSettings.defaultTimeoutMs;
    if (typeof sMax === "number" && Number.isSafeInteger(sMax) && sMax > 0) {
      candidates.push(sMax);
    }
  }

  const rawSpec = spec as Record<string, unknown> | undefined | null;
  const lifetime = spec?.lifetime as Record<string, unknown> | undefined | null;
  if (lifetime && typeof lifetime === "object") {
    const lMax = lifetime.ttlMs ?? lifetime.maxTimeoutMs ?? lifetime.timeoutMs;
    if (typeof lMax === "number" && Number.isSafeInteger(lMax) && lMax > 0) {
      candidates.push(lMax);
    }
  }

  if (rawSpec && typeof rawSpec === "object") {
    const specMax = rawSpec.maxTimeoutMs ?? rawSpec.maxTimeout ?? rawSpec.ttlMs;
    if (typeof specMax === "number" && Number.isSafeInteger(specMax) && specMax > 0) {
      candidates.push(specMax);
    }
    if (rawSpec.settings && typeof rawSpec.settings === "object") {
      const s = rawSpec.settings as Record<string, unknown>;
      const sMax = s.maxTimeoutMs ?? s.maxTimeout ?? s.timeoutMs;
      if (typeof sMax === "number" && Number.isSafeInteger(sMax) && sMax > 0) {
        candidates.push(sMax);
      }
    }
  }

  if (candidates.length === 0) {
    throw new SpecValidationError(
      "Missing required timeout setting: maximum timeout must be configured as a positive safe integer"
    );
  }

  const maxLimit = Math.min(...candidates);

  let resolved = reqTimeoutMs;
  if (resolved === undefined) {
    if (defaultTimeoutMs !== undefined) {
      if (
        typeof defaultTimeoutMs !== "number" ||
        !Number.isFinite(defaultTimeoutMs) ||
        !Number.isSafeInteger(defaultTimeoutMs) ||
        defaultTimeoutMs <= 0
      ) {
        throw new SpecValidationError(
          `defaultTimeoutMs must be a positive safe integer; received ${String(defaultTimeoutMs)}`
        );
      }
      if (defaultTimeoutMs > maxLimit) {
        throw new SpecValidationError(
          `defaultTimeoutMs (${defaultTimeoutMs}) exceeds maximum allowed by settings (${maxLimit})`
        );
      }
      resolved = defaultTimeoutMs;
    } else {
      resolved = maxLimit;
    }
  }

  if (resolved > maxLimit) {
    throw new SpecValidationError(
      `timeoutMs (${resolved}) exceeds maximum allowed by sandbox settings (${maxLimit})`
    );
  }

  return resolved;
}

/**
 * Builds the docker exec command line arguments.
 * (1) docker exec always runs as the non-root user from the sandbox spec.
 *     A caller-supplied user of 0 or root is refused, and the path that sets -u
 *     from the request is removed.
 * (2) Environment: only names listed in the sandbox spec env allow-list are passed with -e.
 *     A name that contains KIRO, GITHUB, TOKEN, SECRET, KEY, PASSWORD or CREDENTIAL,
 *     and any value that starts with ksk_, ghp_ or ghs_, is refused.
 * (3) Every command starts as ['setsid', '-w', 'sh', '-c', SCRIPT, ...argv] so
 *     it runs in its own real process group, reports its group id via the
 *     marker line on stderr, and its exit code propagates through the wrapper.
 *     Requirement H-3.
 */
export function buildExecArgv(
  containerId: string,
  req: ExecRequest,
  options?: {
    user?: string | number;
    spec?: Partial<SandboxSpec>;
    envAllowlist?: string[] | Set<string>;
    containerCwd?: string;
  }
): string[] {
  validateCommandArgv(req);

  const argv: string[] = ["exec"];

  const cwdToUse =
    options?.containerCwd ??
    (options?.spec?.workspace && options.spec.workspace.mode === "bind"
      ? (req.cwd && (req.cwd === options.spec.workspace.mountAt || req.cwd.startsWith(options.spec.workspace.mountAt + "/"))
          ? req.cwd
          : options.spec.workspace.mountAt)
      : req.cwd);

  if (cwdToUse && typeof cwdToUse === "string" && cwdToUse.trim()) {
    argv.push("-w", cwdToUse.trim());
  }

  // Build env allow-list from sandbox spec
  const allowlist = new Set<string>();
  const spec = options?.spec;
  if (spec) {
    const rawSpec = spec as Record<string, unknown>;
    const specAllowlist =
      rawSpec.envAllowlist ??
      rawSpec.env_allowlist ??
      rawSpec.allowedEnv;
    if (Array.isArray(specAllowlist)) {
      for (const item of specAllowlist) {
        if (typeof item === "string" && item.trim()) {
          allowlist.add(item.trim());
        }
      }
    }
    if (spec.env && typeof spec.env === "object") {
      for (const name of Object.keys(spec.env)) {
        allowlist.add(name);
      }
    }
  }

  if (options?.envAllowlist) {
    for (const item of options.envAllowlist) {
      if (typeof item === "string" && item.trim()) {
        allowlist.add(item.trim());
      }
    }
  }

  // Only pass names listed in the sandbox spec env allow-list with -e.
  // Refuse secret names and values.
  if (req.env && typeof req.env === "object") {
    for (const [k, v] of Object.entries(req.env)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
        throw new SpecValidationError(
          `Environment variable name '${k}' is invalid; must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`
        );
      }
      if (isForbiddenEnvName(k)) {
        throw new SpecValidationError(
          `Environment variable name '${k}' matches secret denylist`
        );
      }
      if (typeof v === "string" && isForbiddenEnvValue(v)) {
        throw new SpecValidationError(
          `Environment variable '${k}' value matches secret pattern`
        );
      }
      if (allowlist.has(k)) {
        argv.push("-e", `${k}=${v}`);
      }
    }
  }

  // User: docker exec always runs as the non-root user from the sandbox spec.
  // A caller-supplied user of 0 or root is refused, and the path that sets -u from the request is removed.
  const reqRaw = req as Record<string, unknown>;
  if (isRootUser(reqRaw.user) || isRootUser(reqRaw.uid)) {
    throw new SpecValidationError("User ID 0 (root) is forbidden");
  }

  const nonRootUser = resolveNonRootUser(options?.spec, options?.user);
  argv.push("-u", nonRootUser);

  assertValidStreamContainerId(containerId);
  argv.push(containerId);
  argv.push(...wrapWithSetsid(req.argv));

  return argv;
}

/**
 * Creates an ExecChunk with sequence numbering.
 * Requirement 43.6.
 */
export function createChunk(
  seq: number,
  stream: "stdout" | "stderr" | "merged",
  data: string | Uint8Array | Buffer,
  at?: number
): ExecChunk {
  const rawBytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return {
    seq,
    stream,
    data: rawBytes,
    at: at ?? Date.now(),
  };
}

/**
 * Kills the command's process group inside the container.
 * Signals only kill -KILL -- -PGID for the recorded group, and only when the
 * pgid is an integer greater than 1. No process of a user is ever signalled.
 * Requirements: 20.11, H-3.
 */
export async function killProcessGroup(
  runner: InjectedDockerRunner,
  containerId: string,
  pgid?: number | string,
  options?: DockerRunnerOptions
): Promise<void> {
  assertValidStreamContainerId(containerId);
  if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 1) return;

  try {
    await invokeRunner(
      runner,
      ["exec", containerId, "kill", "-KILL", "--", `-${pgid}`],
      options
    );
  } catch {
    // Process might have already exited
  }
}

/**
 * Process cleanup: kills only the command's own process group.
 * Takes a numeric pgid and throws when the pgid is missing or is not an
 * integer greater than 1. Never signals the processes of a user.
 * Requirements: 20.11, H-3, N-2.
 */
export async function sweepProcesses(
  runner: InjectedDockerRunner,
  containerId: string,
  pgid?: number | string,
  options?: DockerRunnerOptions
): Promise<void> {
  if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(
      `sweepProcesses requires an integer pgid greater than 1; received: ${String(pgid)}`
    );
  }
  await killProcessGroup(runner, containerId, pgid, options);
}

/**
 * Inspect container out-of-memory status and check command output.
 */
export async function checkOomStatus(
  runner: InjectedDockerRunner,
  containerId: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string,
  runnerResult?: DockerRunnerResult
): Promise<boolean> {
  assertValidStreamContainerId(containerId);

  if (runnerResult && (runnerResult as Record<string, unknown>).oomKilled === true) {
    return true;
  }

  try {
    const inspectRes = await invokeRunner(
      runner,
      ["inspect", "--format", "{{.State.OOMKilled}}", containerId]
    );
    const output = (typeof inspectRes.stdout === "string" ? inspectRes.stdout : "").trim();
    if (output === "true") {
      return true;
    }
  } catch {
    // Container inspect error non-fatal
  }

  // N-C14: When exitCode === 0, never classify as OOM based on stdout/stderr text
  if (exitCode === 0) {
    return false;
  }

  const combined = `${stderr}\n${stdout}`;
  if (
    /out of memory/i.test(combined) ||
    /oom-killer/i.test(combined) ||
    /oomkilled/i.test(combined) ||
    /javascript heap out of memory/i.test(combined) ||
    /memory limit exceeded/i.test(combined) ||
    /cannot allocate memory/i.test(combined)
  ) {
    return true;
  }

  if (exitCode === 137) {
    if (/killed/i.test(combined)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether the command timed out.
 * N-C14: Rely strictly on timedOutFlag, runnerResult.timedOut, exitCode === 124.
 * No stdout/stderr text matching.
 */
function checkTimeoutStatus(
  timedOutFlag: boolean,
  exitCode: number | null | undefined,
  stderr?: string,
  runnerResult?: DockerRunnerResult
): boolean {
  if (timedOutFlag) return true;
  if (runnerResult && (runnerResult as Record<string, unknown>).timedOut === true) return true;
  if (exitCode === 124) return true;
  return false;
}

/**
 * Implementation of ExecProcess supporting streaming output and resumption.
 * Requirements: 43.6, 20.11, H-3.
 */
export class DockerExecProcess implements ExecProcess {
  private readonly chunks: ExecChunk[] = [];
  private nextSeq = 0;
  private isDone = false;
  private error: unknown = null;
  private exitResult: ExecExitStatus = {
    exitCode: null,
    timedOut: false,
    oomKilled: false,
  };
  private readonly subscribers = new Set<() => void>();
  private readonly executionPromise: Promise<ExecResult>;
  private readonly abortController = new AbortController();
  private readonly runner: InjectedDockerRunner;
  private readonly containerId: string;
  private commandPgid?: number;
  private groupKnownFlag = false;

  constructor(
    containerId: string,
    runner: InjectedDockerRunner,
    executionPromise: Promise<ExecResult>
  ) {
    this.containerId = containerId;
    this.runner = runner;
    this.executionPromise = executionPromise;
  }

  get seq(): number {
    return this.nextSeq;
  }

  get pgid(): number | undefined {
    return this.commandPgid;
  }

  /**
   * False until the process group marker arrived and the real group id was
   * recorded. When false, no group kill is ever claimed or signalled.
   * Requirement H-3.
   */
  get groupKnown(): boolean {
    return this.groupKnownFlag;
  }

  setPgid(pgid: number): void {
    this.commandPgid = pgid;
    this.groupKnownFlag = true;
  }

  addChunk(
    stream: "stdout" | "stderr" | "merged",
    data: string | Uint8Array | Buffer
  ): ExecChunk | undefined {
    if (this.isDone) {
      return undefined;
    }
    const chunk = createChunk(this.nextSeq++, stream, data);
    this.chunks.push(chunk);
    this.notifySubscribers();
    return chunk;
  }

  finish(status: ExecExitStatus): void {
    this.exitResult = status;
    this.isDone = true;
    this.notifySubscribers();
  }

  fail(err: unknown): void {
    this.error = err;
    this.isDone = true;
    this.notifySubscribers();
  }

  private notifySubscribers(): void {
    for (const subscriber of Array.from(this.subscribers)) {
      try {
        subscriber();
      } catch {
        // Subscriber callback failure handled gracefully
      }
    }
  }

  private subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Resumes the output stream from a requested sequence number.
   * Requirement 43.6.
   */
  resume(from: number | bigint = 0): AsyncIterable<ExecChunk> {
    const fromSeq = typeof from === "bigint" ? Number(from) : Number(from) || 0;
    const self = this;

    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        let waitingResolve: ((val: IteratorResult<ExecChunk>) => void) | null = null;
        let waitingReject: ((err: unknown) => void) | null = null;

        const checkNext = () => {
          if (!waitingResolve) return;

          while (index < self.chunks.length) {
            const chunk = self.chunks[index++];
            if (chunk.seq >= fromSeq) {
              const res = waitingResolve;
              waitingResolve = null;
              waitingReject = null;
              res({ value: chunk, done: false });
              return;
            }
          }

          if (self.isDone) {
            const res = waitingResolve;
            const rej = waitingReject;
            waitingResolve = null;
            waitingReject = null;
            if (self.error) {
              rej?.(self.error);
            } else {
              res?.({ value: undefined as unknown as ExecChunk, done: true });
            }
          }
        };

        const unregister = self.subscribe(checkNext);

        return {
          async next(): Promise<IteratorResult<ExecChunk>> {
            while (index < self.chunks.length) {
              const chunk = self.chunks[index++];
              if (chunk.seq >= fromSeq) {
                return { value: chunk, done: false };
              }
            }

            if (self.isDone) {
              unregister();
              if (self.error) {
                throw self.error;
              }
              return { value: undefined as unknown as ExecChunk, done: true };
            }

            return new Promise<IteratorResult<ExecChunk>>((resolve, reject) => {
              waitingResolve = resolve;
              waitingReject = reject;
              checkNext();
            });
          },
          async return(): Promise<IteratorResult<ExecChunk>> {
            unregister();
            return { value: undefined as unknown as ExecChunk, done: true };
          },
        };
      },
    };
  }

  get output(): AsyncIterable<ExecChunk> {
    return this.resume(0);
  }

  /**
   * Delivers a signal to the command's process group inside the container.
   * Only the command's process group is signalled with kill -SIG -- -PGID,
   * and only when the recorded pgid is an integer greater than 1.
   * Requirement 20.11, H-3.
   */
  async signal(sig: "SIGINT" | "SIGTERM" | "SIGKILL" | string): Promise<void> {
    assertValidStreamContainerId(this.containerId);
    this.abortController.abort();
    if (
      typeof this.commandPgid !== "number" ||
      !Number.isInteger(this.commandPgid) ||
      this.commandPgid <= 1
    ) {
      return;
    }
    const cleanSig = String(sig).toUpperCase().replace(/^SIG/, "");

    try {
      await invokeRunner(this.runner, [
        "exec",
        this.containerId,
        "kill",
        `-${cleanSig}`,
        "--",
        `-${this.commandPgid}`,
      ]);
    } catch {
      // Signal dispatch best-effort
    }
  }

  async wait(): Promise<{ exitCode: number | null; signal?: string; timedOut: boolean; oomKilled: boolean }> {
    const res = await this.executionPromise;
    return {
      exitCode: res.exitCode ?? null,
      signal: this.exitResult.signal,
      timedOut: res.timedOut,
      oomKilled: res.oomKilled,
    };
  }

  async getResult(): Promise<ExecResult> {
    return this.executionPromise;
  }
}

/**
 * Resolves options and container ID from arguments.
 */
function resolveExecutionArgs(
  arg1: string | DockerExecStreamOptions,
  arg2?: ExecRequest | DockerExecStreamOptions,
  arg3?: DockerExecStreamOptions
): {
  containerId: string;
  req: ExecRequest;
  options: DockerExecStreamOptions;
} {
  if (typeof arg1 === "string") {
    const containerId = arg1;
    const req = arg2 as ExecRequest;
    const options = (arg3 ?? {}) as DockerExecStreamOptions;
    return { containerId, req, options };
  } else {
    const options = arg1;
    const req = arg2 as ExecRequest;
    const containerId =
      options.containerId ??
      options.boxId ??
      options.sandbox?.containerId ??
      options.sandbox?.id ??
      "";
    return { containerId, req, options };
  }
}

/**
 * DockerExecStream orchestrates running commands inside containers with docker exec,
 * sequential chunk streaming, stream resumption, process group sweeping, and log persistence.
 */
export class DockerExecStream {
  readonly containerId: string;
  readonly runner: InjectedDockerRunner;
  readonly logStore: LogStoreLike | LogStore;
  readonly options: DockerExecStreamOptions;

  constructor(options: DockerExecStreamOptions) {
    this.options = { ...options };

    if (isRootUser(options.user) || isRootUser(options.uid)) {
      throw new SpecValidationError("User ID 0 (root) is forbidden");
    }
    const spec = options.spec ?? options.sandbox?.spec;
    if (spec) {
      if (isRootUser(spec.user) || isRootUser(spec.uid) || isRootUser(spec.userId)) {
        throw new SpecValidationError("User ID 0 (root) is forbidden");
      }
      const rawUser = (spec as Record<string, unknown>).user;
      if (rawUser !== undefined && rawUser !== null) {
        if (typeof rawUser === "object") {
          const u = rawUser as Record<string, unknown>;
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
        } else if (typeof rawUser === "string" && !/^\d+(:\d+)?$/.test(rawUser.trim())) {
          throw new SpecValidationError(
            "User spec without a numeric uid is forbidden and must not produce '-u undefined'"
          );
        }
      }
    }

    const rawContainerId =
      options.containerId ??
      options.boxId ??
      options.sandbox?.containerId ??
      options.sandbox?.id;
    this.containerId = assertValidStreamContainerId(rawContainerId);
    const resolvedRunner =
      options.runner ??
      options.dockerRunner ??
      options.sandbox?.backend?.runner;
    if (typeof resolvedRunner !== "function") {
      throw new SpecValidationError(
        "DockerExecStream requires an explicit injected runner"
      );
    }
    this.runner = resolvedRunner;
    this.logStore =
      options.store ??
      options.logStore ??
      new LogStore({ inMemory: true });
  }

  /**
   * Executes a command inside the container and returns a streaming ExecProcess.
   * Requirement 43.6, 20.11, 43.2, H-3, M-5, M-6.
   */
  async exec(req: ExecRequest): Promise<DockerExecProcess> {
    validateCommandArgv(req);

    const containerId = assertValidStreamContainerId(this.containerId);

    const runner = this.runner;
    const logStore = this.logStore;
    const options = this.options;

    const spec = options.spec ?? options.sandbox?.spec;
    const workspace = spec?.workspace;

    let containerCwd: string | undefined;
    let hostCwd: string | undefined;

    if (workspace && workspace.mode === "bind") {
      const mountAt = workspace.mountAt;
      const hostPath = workspace.hostPath;
      hostCwd = hostPath;
      if (req.cwd) {
        if (req.cwd === mountAt || req.cwd === mountAt + "/") {
          containerCwd = mountAt;
        } else if (req.cwd.startsWith(mountAt + "/")) {
          containerCwd = req.cwd;
          const rel = path.posix.relative(mountAt, req.cwd);
          hostCwd = path.join(hostPath, rel);
        } else if (req.cwd === hostPath || req.cwd === hostPath + "/") {
          containerCwd = mountAt;
        } else if (req.cwd.startsWith(hostPath + "/")) {
          const rel = path.relative(hostPath, req.cwd);
          containerCwd = path.posix.join(mountAt, rel.replace(/\\/g, "/"));
          hostCwd = req.cwd;
        } else {
          containerCwd = req.cwd;
        }
      } else {
        containerCwd = mountAt;
      }
    } else {
      containerCwd = req.cwd;
      hostCwd = req.cwd;
    }

    const effectiveTimeoutMs = resolveTimeoutMs(
      req.timeoutMs,
      options.defaultTimeoutMs,
      spec,
      options.settings
    );

    const logRef =
      (req as Record<string, unknown>).logRef as string | undefined ??
      options.logRef ??
      (req.idempotencyKey ? `exec-${req.idempotencyKey}` : `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const execArgv = buildExecArgv(containerId, req, {
      user: options.user ?? options.uid,
      spec: options.spec ?? options.sandbox?.spec,
      envAllowlist: options.envAllowlist,
      containerCwd,
    });

    let resolveExecResult!: (value: ExecResult | PromiseLike<ExecResult>) => void;
    let rejectExecResult!: (reason?: unknown) => void;

    const executionPromise = new Promise<ExecResult>((resolve, reject) => {
      resolveExecResult = resolve;
      rejectExecResult = reject;
    });

    // The group id is unknown until the container reports it via the marker
    // line on stderr; no group id is invented here. Requirement H-3.
    const processRef = new DockerExecProcess(containerId, runner, executionPromise);

    (async () => {
      let stdoutAccum = "";
      let stdoutAccumBytes = 0;
      let stderrAccum = "";
      let stderrAccumBytes = 0;
      let exitCode: number | null = null;
      let runnerResult: DockerRunnerResult | undefined;
      let stderrSeen = false;
      let markerResolved = false;
      let stderrHeadHold = "";

      const markerLineRe = new RegExp(`^${PGID_MARKER}\\s+(\\d+)\\s*$`);

      const takeStdout = (data: string): string => data;

      // Reads the first stderr line for the process group marker and returns
      // the stderr text callers receive (the marker line removed). Data before
      // the first newline is held back until that line can be judged.
      const takeStderr = (data: string): string | null => {
        if (markerResolved) return data;
        stderrHeadHold += data;
        const nl = stderrHeadHold.indexOf("\n");
        if (nl === -1) return null;
        const head = stderrHeadHold;
        stderrHeadHold = "";
        markerResolved = true;
        const firstLine = head.slice(0, nl).replace(/\r$/, "");
        const match = firstLine.match(markerLineRe);
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isInteger(parsed)) {
            processRef.setPgid(parsed);
            return head.slice(nl + 1);
          }
        }
        return head;
      };

      // Resolves stderr held back while scanning for the marker. A held
      // complete marker line (no trailing newline) is parsed and removed; a
      // partial marker prefix is dropped; other text passes through.
      const flushStderrHold = (): string => {
        const held = stderrHeadHold;
        stderrHeadHold = "";
        if (markerResolved || held.length === 0) {
          return held;
        }
        markerResolved = true;
        const stripped = held.replace(/\r$/, "");
        const match = stripped.match(markerLineRe);
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isInteger(parsed)) {
            processRef.setPgid(parsed);
            return "";
          }
        }
        if (PGID_MARKER.startsWith(stripped)) {
          return "";
        }
        return held;
      };

      try {
        // Rule 3: The timer is always set
        timer = setTimeout(() => {
          timedOut = true;
          processRef.signal("SIGKILL").catch(() => {});
        }, effectiveTimeoutMs);

        // Rule 5: Host execFile cwd is host path, while docker exec -w receives container path
        const runnerOpts: DockerRunnerOptions = {
          cwd: hostCwd,
          timeoutMs: effectiveTimeoutMs,
          onStdout: (data: string | Buffer | Uint8Array) => {
            const str = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
            const appended = appendWithCap(stdoutAccum, stdoutAccumBytes, str);
            stdoutAccum = appended.text;
            stdoutAccumBytes = appended.bytes;
            processRef.addChunk("stdout", data);
          },
          onStderr: (data: string | Buffer | Uint8Array) => {
            const str = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
            stderrSeen = true;
            const cleaned = takeStderr(str);
            if (cleaned === null || cleaned.length === 0) {
              return;
            }
            const appended = appendWithCap(stderrAccum, stderrAccumBytes, cleaned);
            stderrAccum = appended.text;
            stderrAccumBytes = appended.bytes;
            processRef.addChunk("stderr", cleaned);
          },
        };

        const result = await invokeRunner(runner, execArgv, runnerOpts);
        runnerResult = result;
        // Strict exit codes (N-3, M-5): the exit code comes only from the exec
        // result; invokeRunner throws on a missing or non-integer exit code.
        exitCode = result.exitCode;

        // If stdout was not streamed via callbacks, stream it in sequence
        const outStr =
          typeof result.stdout === "string"
            ? result.stdout
            : Buffer.isBuffer(result.stdout)
            ? result.stdout.toString("utf8")
            : "";

        if (!stdoutAccum && outStr) {
          const appended = appendWithCap(stdoutAccum, stdoutAccumBytes, outStr);
          stdoutAccum = appended.text;
          stdoutAccumBytes = appended.bytes;
          processRef.addChunk("stdout", outStr);
        }

        // Stderr that was not streamed via callbacks: strip the marker line
        // and emit the remainder, so callers never receive the marker.
        const errStr =
          typeof result.stderr === "string"
            ? result.stderr
            : Buffer.isBuffer(result.stderr)
            ? result.stderr.toString("utf8")
            : "";

        if (!stderrSeen && errStr) {
          let cleaned = takeStderr(errStr);
          if (cleaned === null) {
            cleaned = flushStderrHold();
          }
          if (cleaned) {
            const appended = appendWithCap(stderrAccum, stderrAccumBytes, cleaned);
            stderrAccum = appended.text;
            stderrAccumBytes = appended.bytes;
            processRef.addChunk("stderr", cleaned);
          }
        }
      } catch (err: unknown) {
        const errAny = err as Record<string, unknown> | null | undefined;
        const isRunnerTimeout =
          Boolean(errAny && typeof errAny === "object" && errAny.timedOut === true) ||
          timedOut;

        if (isRunnerTimeout) {
          // N-C10: Treat runner rejections with timedOut === true or stream timeout as command timeout
          timedOut = true;
          exitCode = 124;

          const rawOut = errAny?.stdout;
          const out =
            typeof rawOut === "string"
              ? takeStdout(rawOut)
              : Buffer.isBuffer(rawOut)
              ? takeStdout(rawOut.toString("utf8"))
              : rawOut
              ? takeStdout(String(rawOut))
              : "";
          if (out && !stdoutAccum) {
            const appended = appendWithCap(stdoutAccum, stdoutAccumBytes, out);
            stdoutAccum = appended.text;
            stdoutAccumBytes = appended.bytes;
            processRef.addChunk("stdout", out);
          }

          const rawErr = errAny?.stderr;
          const errText =
            typeof rawErr === "string"
              ? rawErr
              : Buffer.isBuffer(rawErr)
              ? rawErr.toString("utf8")
              : "";
          if (errText && !stderrAccum.includes(errText)) {
            let cleaned = takeStderr(errText);
            if (cleaned === null) {
              cleaned = flushStderrHold();
            }
            if (cleaned && !stderrAccum.includes(cleaned)) {
              const appended = appendWithCap(stderrAccum, stderrAccumBytes, cleaned);
              stderrAccum = appended.text;
              stderrAccumBytes = appended.bytes;
              processRef.addChunk("stderr", cleaned);
            }
          }
        } else {
          // Strict exit codes (N-3, M-5): a runner error carrying an integer
          // exit code is the command's real exit code; every other runner error
          // propagates and is never mapped to exit 0 or exit 1.
          const errObj = err as {
            exitCode?: unknown;
            code?: unknown;
            stdout?: unknown;
            stderr?: unknown;
            message?: string;
          } | null | undefined;
          const rawErrCode =
            errObj && typeof errObj === "object"
              ? errObj.exitCode ?? errObj.code
              : undefined;
          if (
            errObj &&
            typeof errObj === "object" &&
            typeof rawErrCode === "number" &&
            Number.isInteger(rawErrCode)
          ) {
            exitCode = rawErrCode;
            const out = errObj.stdout ? String(errObj.stdout) : "";
            const errText = errObj.stderr ? String(errObj.stderr) : errObj.message ?? "";
            if (out && !stdoutAccum) {
              const appended = appendWithCap(stdoutAccum, stdoutAccumBytes, out);
              stdoutAccum = appended.text;
              stdoutAccumBytes = appended.bytes;
              processRef.addChunk("stdout", out);
            }
            if (errText && !stderrSeen && !stderrAccum) {
              let cleaned = takeStderr(errText);
              if (cleaned === null) {
                cleaned = flushStderrHold();
              }
              if (cleaned) {
                const appended = appendWithCap(stderrAccum, stderrAccumBytes, cleaned);
                stderrAccum = appended.text;
                stderrAccumBytes = appended.bytes;
                processRef.addChunk("stderr", cleaned);
              }
            }
          } else {
            processRef.fail(err);
            rejectExecResult(err);
            return;
          }
        }
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }

        // Resolve any stderr held back while scanning for the marker, so the
        // recorded group is known before the finish kill.
        const heldStderr = flushStderrHold();
        if (heldStderr) {
          const appended = appendWithCap(stderrAccum, stderrAccumBytes, heldStderr);
          stderrAccum = appended.text;
          stderrAccumBytes = appended.bytes;
          processRef.addChunk("stderr", heldStderr);
        }

        // Rule 4, H-3: kill only the command's own recorded process group
        // inside the container, never the container user's processes. When the
        // marker never arrived the group is unknown and nothing is signalled.
        try {
          await killProcessGroup(runner, containerId, processRef.pgid);
        } catch {
          // Process group kill non-fatal
        }
      }

      const isTimeout = checkTimeoutStatus(timedOut, exitCode, stderrAccum, runnerResult);
      if (isTimeout) {
        // A command that times out reports exit code 124. Requirement H-3, N-3.
        exitCode = 124;
      }

      const isOom = await checkOomStatus(
        runner,
        containerId,
        exitCode,
        stdoutAccum,
        stderrAccum,
        runnerResult
      );

      // Persistence via injected store
      let stored: StoredCommandResult | undefined;
      if (typeof logStore.storeCommandOutput === "function") {
        stored = await logStore.storeCommandOutput({
          logRef,
          runId: options.runId,
          stdout: stdoutAccum,
          stderr: stderrAccum,
          exitCode,
          timedOut: isTimeout,
          oomKilled: isOom,
          maxTailLines: options.maxTailLines,
          maxTailBytes: options.maxTailBytes,
        });
      } else if (typeof logStore.writeLog === "function") {
        const content = stdoutAccum && stderrAccum ? `${stdoutAccum}\n${stderrAccum}` : stdoutAccum || stderrAccum;
        await logStore.writeLog(logRef, content, {
          exitCode,
          timedOut: isTimeout,
          oomKilled: isOom,
        });
      }

      const stdoutTailRes = extractTail(stdoutAccum, {
        maxLines: options.maxTailLines,
        maxBytes: options.maxTailBytes,
      });
      const stderrTailRes = extractTail(stderrAccum, {
        maxLines: options.maxTailLines,
        maxBytes: options.maxTailBytes,
      });

      const finalResult: ExecResult = {
        logRef,
        oomKilled: isOom,
        timedOut: isTimeout,
        exitCode,
        stdoutTail: stored?.stdoutTail ?? stdoutTailRes.tail,
        stderrTail: stored?.stderrTail ?? stderrTailRes.tail,
        truncated: stored?.truncated ?? (stdoutTailRes.truncated || stderrTailRes.truncated),
      };

      processRef.finish({
        exitCode,
        timedOut: isTimeout,
        oomKilled: isOom,
      });

      resolveExecResult(finalResult);
    })().catch((err) => {
      processRef.fail(err);
      rejectExecResult(err);
    });

    return processRef;
  }

  /**
   * Executes a command inside the container and returns the completed ExecResult.
   */
  async run(req: ExecRequest): Promise<ExecResult> {
    const process = await this.exec(req);
    return process.getResult();
  }

  async killProcessGroup(pgid?: number | string): Promise<void> {
    await killProcessGroup(this.runner, this.containerId, pgid);
  }
}

/**
 * Executes a command inside a box via docker exec, returning a streaming ExecProcess.
 */
export async function dockerExecStream(
  arg1: string | DockerExecStreamOptions,
  arg2?: ExecRequest | DockerExecStreamOptions,
  arg3?: DockerExecStreamOptions
): Promise<DockerExecProcess> {
  const { containerId, req, options } = resolveExecutionArgs(arg1, arg2, arg3);
  const stream = new DockerExecStream({ ...options, containerId });
  return stream.exec(req);
}

/**
 * Executes a command inside a box via docker exec, returning the completed ExecResult.
 */
export async function dockerExecRun(
  arg1: string | DockerExecStreamOptions,
  arg2?: ExecRequest | DockerExecStreamOptions,
  arg3?: DockerExecStreamOptions
): Promise<ExecResult> {
  const { containerId, req, options } = resolveExecutionArgs(arg1, arg2, arg3);
  const stream = new DockerExecStream({ ...options, containerId });
  return stream.run(req);
}

export default DockerExecStream;
