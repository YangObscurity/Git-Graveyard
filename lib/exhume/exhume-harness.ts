/**
 * Exhumer Harness baseline command execution and failure classification in Runbox.
 * Requirements: 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.13, 11.14, 11.16, 20.13.
 * Task: 8.3.
 *
 * Executes fixed baseline commands (runtime versions, install, build, test)
 * in Runbox through an injected command runner without any model calls,
 * enforces wall-clock caps, retry logic, and emits command.started/command.result events.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  RunnerExitCodeError,
  isForbiddenEnvName,
  isForbiddenEnvValue,
} from "../backend/docker-exec-stream";
import { scanForEscapingSymlinks } from "../security/symlink-scanner";
import type {
  ExecutionBackend,
  ExecRequest,
  ExecResult,
  ExecProcess,
  Sandbox,
  SandboxSpec,
} from "../backend/types";
import type {
  EventEnvelope,
  EventInput,
} from "../events/event-store";
import type { Signal } from "../grimoire/types";
import type { RunOutcome } from "../runs/run-store";
import {
  createDeathCertificate,
  extractFailureExcerpt,
  type BaselineCommandRow,
  type BaselineStepStatus,
  type DeathCertificate,
  type StepName,
} from "./death-certificate";
import {
  inspectRepositoryManifests,
  markStepsNotRunOnInstallFailure,
} from "./script-detector";
import {
  handleEarlyCompletion,
  persistDeathCertificate,
  runGrimoireBaseAnalysis,
  runExhumerTriageSession,
  type ExhumerTriageSessionOptions,
} from "./triage";
import {
  buildRunNetworkPolicy,
  getRunNetworkPolicy,
  registerRunNetworkPolicy,
} from "../backend/network-policy";
import {
  NO_TESTS_FOUND_LABEL,
  NO_TESTS_FOUND_RULE_ID,
  type FileListInput,
  type ManifestInspectionInput,
  type ManifestInspectionResult,
  type PackageJson,
} from "./types";

/**
 * Result returned by an injected command runner execution.
 */
export interface CommandExecutionResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  stdoutTail?: string;
  stderrTail?: string;
  logRef?: string;
  timedOut?: boolean;
  oomKilled?: boolean;
  durationMs?: number;
}

/**
 * Result of executing a baseline command step.
 */
export type BaselineStepResult = BaselineCommandRow & {
  readonly error?: string;
};

/**
 * Runner function signature.
 */
export type CommandRunnerFn = (
  argv: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    logRef?: string;
  }
) => Promise<CommandExecutionResult>;

/**
 * Injected command runner interface supporting function, Sandbox, or run/exec object.
 */
export type InjectedCommandRunner =
  | CommandRunnerFn
  | Sandbox
  | {
      run: (req: ExecRequest) => Promise<ExecResult | CommandExecutionResult>;
    }
  | {
      exec: (req: ExecRequest) => Promise<ExecProcess>;
    };

/**
 * Minimal interface for event emission/storage.
 */
export interface EventEmitterLike {
  append?(event: EventInput): unknown | Promise<unknown>;
  emit?(event: EventInput | EventEnvelope): unknown | Promise<unknown>;
}

/**
 * Options configuring ExhumerHarness execution.
 */
export interface ExhumerHarnessOptions {
  runId: string;
  baseSha: string;
  repoUrl?: string;
  worktreeDir?: string;
  bindPath?: string;
  wardenDir?: string;
  wardenBindPath?: string;
  allowedRoot?: string;
  requireWardenPath?: boolean;
  backend?: ExecutionBackend;
  runner?: InjectedCommandRunner;
  runbox?: Sandbox;
  auditbox?: Sandbox;
  manifestInspection?: ManifestInspectionResult;
  files?: FileListInput;
  packageJson?: PackageJson | string | Record<string, unknown> | null;
  pyprojectToml?: string | Record<string, unknown> | null;
  setupPy?: string | null;
  pipfile?: string | null;
  requirementsTxt?: string | string[] | null;
  eventStore?: EventEmitterLike;
  emitEvent?: (event: EventInput) => void | Promise<void>;
  events?: EventInput[];
  wallClockTimeoutMs?: number;
  defaultTimeoutMs?: number;
  diskMiB?: number | string;
  boxImage?: string;
  settings?: {
    maxTimeoutMs?: number;
    housekeepingTimeoutMs?: number;
    [k: string]: unknown;
  } | null;
  ensureNetworkPolicy?: boolean;
  logs?: Record<string, string>;
  supervisor?: ExhumerTriageSessionOptions["supervisor"];
  sessionClient?: ExhumerTriageSessionOptions["sessionClient"];
  synthesizer?: ExhumerTriageSessionOptions["synthesizer"];
  requireBindPath?: boolean;
  requireTimeout?: boolean;
  env?: Record<string, string>;
  enableGrimoire?: boolean;
  enableTriageSession?: boolean;
  storageDir?: string;
  userStop?: boolean;
  userChoice?: "Stop here" | string;
  stopHere?: boolean;
}

/**
 * Result of running the Exhumer baseline harness.
 */
export interface ExhumeHarnessResult {
  deathCertificate: DeathCertificate;
  runbox?: Sandbox;
  auditbox?: Sandbox;
  rows: readonly BaselineCommandRow[];
  manifestInspection: ManifestInspectionResult;
  wallClockTimeoutHit: boolean;
  healthy: boolean;
  signals?: readonly Signal[];
  outcome?: RunOutcome;
  earlyCompleted?: boolean;
  certificatePath?: string;
}

/**
 * Error thrown when an operation requires an injected runner or execution backend,
 * but none was provided. Host execution of repository commands is strictly prohibited.
 * Requirements: 19.6, 42.1.
 */
export class RunnerRequiredError extends Error {
  constructor(
    message = "No injected runner provided: host execution of repository commands is prohibited"
  ) {
    super(message);
    this.name = "RunnerRequiredError";
  }
}

/**
 * Base error thrown when a required setting is missing.
 * Requirement L-7.
 */
export class RequiredSettingError extends Error {
  readonly setting?: string;
  constructor(message: string, setting?: string) {
    super(message);
    this.name = "RequiredSettingError";
    this.setting = setting;
  }
}

/**
 * Base error for bind path validation issues.
 * Requirement L-7.
 */
export class BindPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindPathError";
  }
}

/**
 * Error thrown when a bind path is required but missing.
 * Requirement L-7.
 */
export class BindPathRequiredError extends RequiredSettingError {
  constructor(
    message = "Bind path is required: caller must provide bind path",
    setting = "bindPath"
  ) {
    super(message, setting);
    this.name = "BindPathRequiredError";
  }
}

/**
 * Error thrown when a warden path is required but missing.
 * Requirement L-7.
 */
export class WardenPathRequiredError extends BindPathRequiredError {
  constructor(
    message = "Warden bind path is required: caller must provide warden bind path",
    setting = "wardenBindPath"
  ) {
    super(message, setting);
    this.name = "WardenPathRequiredError";
  }
}

/**
 * Error thrown when a bind path does not exist on disk.
 * Requirement L-7.
 */
export class BindPathNotFoundError extends BindPathError {
  constructor(message = "Bind path does not exist: bind path must exist on host") {
    super(message);
    this.name = "BindPathNotFoundError";
  }
}

/**
 * Error thrown when a bind path is not a directory.
 * Requirement L-7.
 */
export class BindPathNotDirectoryError extends BindPathError {
  constructor(message = "Bind path is not a directory: bind path must be a directory") {
    super(message);
    this.name = "BindPathNotDirectoryError";
  }
}

/**
 * Error thrown when a bind path does not resolve inside the allowed root.
 * Requirement L-7.
 */
export class BindPathRootError extends BindPathError {
  constructor(message = "Bind path does not resolve inside allowed root") {
    super(message);
    this.name = "BindPathRootError";
  }
}

/**
 * Error thrown when a bind path does not contain the required path segment after realpath.
 * Requirement L-7.
 */
export class BindPathSegmentError extends BindPathError {
  constructor(message = "Bind path does not contain expected segment after realpath resolution") {
    super(message);
    this.name = "BindPathSegmentError";
  }
}

/**
 * Validates bind path ensuring it is provided, resolves realpath, and checks that
 * the path exists, is a directory, resolves inside the allowed root (if specified),
 * and contains the expected segment name.
 * Refuses without silent repairs or fallbacks.
 * Requirement L-7.
 */
export function validateBindPath(
  bindPath?: string,
  expectedSegmentOrOptions: string | { expectedSegment?: string; allowedRoot?: string } = "builders",
  allowedRoot?: string
): string {
  if (!bindPath || typeof bindPath !== "string" || !bindPath.trim()) {
    throw new BindPathRequiredError("Bind path is required: caller must provide bind path");
  }

  let expectedSegment: string | undefined = "builders";
  let root: string | undefined = allowedRoot;

  if (typeof expectedSegmentOrOptions === "object" && expectedSegmentOrOptions !== null) {
    expectedSegment = expectedSegmentOrOptions.expectedSegment;
    root = expectedSegmentOrOptions.allowedRoot ?? root;
  } else if (typeof expectedSegmentOrOptions === "string") {
    if (
      allowedRoot === undefined &&
      (expectedSegmentOrOptions.includes("/") ||
        expectedSegmentOrOptions.includes("\\") ||
        path.isAbsolute(expectedSegmentOrOptions))
    ) {
      root = expectedSegmentOrOptions;
      expectedSegment = undefined;
    } else {
      expectedSegment = expectedSegmentOrOptions;
    }
  }

  const resolved = path.resolve(bindPath.trim());

  // (1) validateBindPath must not fall back to path.resolve or to the nearest existing ancestor.
  // A bind path that does not exist, is not a directory, or does not resolve inside the allowed root
  // is refused with an error; nothing is repaired silently.
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    throw new BindPathNotFoundError(
      `Bind path does not exist: path '${resolved}' cannot be resolved; silent repairs and fallbacks are prohibited`
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    throw new BindPathNotFoundError(
      `Bind path does not exist: path '${realPath}' cannot be stated`
    );
  }

  if (!stat.isDirectory()) {
    throw new BindPathNotDirectoryError(
      `Bind path is not a directory: path '${realPath}' must be an existing directory`
    );
  }

  if (root) {
    // L-7 residual: the allowed root must exist. A failing realpath for the allowed root
    // throws; there is no path.resolve fallback and nothing is repaired silently.
    const resolvedRoot = path.resolve(root);
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(resolvedRoot);
    } catch {
      throw new BindPathNotFoundError(
        `Allowed root does not exist: path '${resolvedRoot}' cannot be resolved; silent repairs and fallbacks are prohibited`
      );
    }
    const rel = path.relative(realRoot, realPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new BindPathRootError(
        `Bind path '${realPath}' is outside allowed root '${realRoot}'`
      );
    }
  }

  if (expectedSegment) {
    const segments = realPath.split(/[/\\]+/).filter(Boolean);
    const matchesSegment = segments.includes(expectedSegment);

    if (!matchesSegment) {
      throw new BindPathSegmentError(
        `Bind path segment mismatch: path '${realPath}' must contain segment '${expectedSegment}' after realpath resolution`
      );
    }
  }

  return realPath;
}

/**
 * Error thrown when wallClockTimeoutMs is required but missing or invalid.
 * Requirement L-7.
 */
export class TimeoutRequiredError extends RequiredSettingError {
  constructor(
    message = "wallClockTimeoutMs is required: caller must provide wallClockTimeoutMs",
    setting = "wallClockTimeoutMs"
  ) {
    super(message, setting);
    this.name = "TimeoutRequiredError";
  }
}

/**
 * Error thrown when timeout configuration settings are missing.
 * Requirement L-7.
 */
export class TimeoutSettingRequiredError extends RequiredSettingError {
  constructor(
    message = "Settings with configured maximum timeout is required: settings must be provided",
    setting = "settings"
  ) {
    super(message, setting);
    this.name = "TimeoutSettingRequiredError";
  }
}

/**
 * Error thrown when wallClockTimeoutMs exceeds configured maximum.
 * Requirement L-7.
 */
export class TimeoutExceededError extends Error {
  constructor(message = "wallClockTimeoutMs exceeds configured maximum allowed by settings") {
    super(message);
    this.name = "TimeoutExceededError";
  }
}

/**
 * Resolves and validates wallClockTimeoutMs against configured maximum from settings.
 * Rejects when wallClockTimeoutMs is missing or invalid, or when settings/maximum is missing,
 * or when wallClockTimeoutMs exceeds the configured maximum.
 * Requirement L-7.
 */
export function resolveWallClockTimeout(
  optionsOrTimeout?:
    | number
    | ExhumerHarnessOptions
    | {
        wallClockTimeoutMs?: number;
        settings?: Record<string, unknown> | null;
      },
  settings?: Record<string, unknown> | null
): number {
  if (typeof optionsOrTimeout === "object" && optionsOrTimeout !== null) {
    const wallClock = optionsOrTimeout.wallClockTimeoutMs;
    const effSettings =
      settings ??
      (optionsOrTimeout.settings as Record<string, unknown> | null | undefined);
    if (!effSettings) {
      if (
        typeof wallClock === "number" &&
        Number.isFinite(wallClock) &&
        Number.isSafeInteger(wallClock) &&
        wallClock > 0
      ) {
        return wallClock;
      }
      return 60000;
    }
    return resolveWallClockTimeout(wallClock, effSettings);
  }

  const wallClockTimeoutMs = optionsOrTimeout;
  if (wallClockTimeoutMs === undefined || wallClockTimeoutMs === null) {
    throw new TimeoutRequiredError(
      "wallClockTimeoutMs is required: caller must provide wallClockTimeoutMs"
    );
  }

  if (
    typeof wallClockTimeoutMs !== "number" ||
    !Number.isFinite(wallClockTimeoutMs) ||
    !Number.isSafeInteger(wallClockTimeoutMs) ||
    wallClockTimeoutMs <= 0
  ) {
    throw new TimeoutRequiredError(
      `wallClockTimeoutMs must be a positive safe integer; received ${String(wallClockTimeoutMs)}`
    );
  }

  if (!settings || typeof settings !== "object") {
    throw new TimeoutSettingRequiredError(
      "Settings with configured maximum timeout is required: settings must be provided"
    );
  }

  const rawSettings = settings as Record<string, unknown>;
  const maxLimit =
    rawSettings.maxWallClockTimeoutMs ??
    rawSettings.wallClockTimeoutMsMax ??
    rawSettings.maxTimeoutMs ??
    rawSettings.maxTimeout ??
    rawSettings.timeoutMaxMs ??
    rawSettings["exhume.maxWallClockTimeoutMs"];

  if (
    typeof maxLimit !== "number" ||
    !Number.isFinite(maxLimit) ||
    !Number.isSafeInteger(maxLimit) ||
    maxLimit <= 0
  ) {
    throw new TimeoutSettingRequiredError(
      "Configured maximum timeout setting is required: settings must specify a positive safe integer for maxWallClockTimeoutMs or maxTimeoutMs"
    );
  }

  if (wallClockTimeoutMs > maxLimit) {
    throw new TimeoutExceededError(
      `wallClockTimeoutMs (${wallClockTimeoutMs}) exceeds configured maximum allowed by settings (${maxLimit})`
    );
  }

  return wallClockTimeoutMs;
}

function sanitizeRunnerEnv(
  env?: Record<string, string>
): Record<string, string> | undefined {
  if (!env || typeof env !== "object") {
    return env;
  }
  const dangerousKeys = new Set([
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "PYTHONPATH",
    "BASH_ENV",
    "ENV",
    "PERL5OPT",
    "RUBYOPT",
  ]);
  const sanitized: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (dangerousKeys.has(k.toUpperCase())) continue;
    if (isForbiddenEnvName(k)) continue;
    if (isForbiddenEnvValue(v)) continue;
    sanitized[k] = v;
  }
  return sanitized;
}

/**
 * ExhumerHarness executes baseline install, build, test, and version commands
 * in the Runbox without any model call and produces the Death Certificate.
 */
export class ExhumerHarness {
  readonly options: ExhumerHarnessOptions;
  readonly worktreeDir?: string;
  readonly wardenDir?: string;
  private runbox?: Sandbox;
  private auditbox?: Sandbox;
  private startTime = 0;
  private wallClockTimeoutHit = false;

  constructor(options: ExhumerHarnessOptions) {
    const runner = options.runner ?? options.runbox;
    if (!runner && !options.backend) {
      throw new RunnerRequiredError();
    }
    this.options = { ...options };

    // L-7: Remove default to builders/base and warden. The caller must give the bind path.
    const rawWorktree = options.bindPath ?? options.worktreeDir;
    if (rawWorktree) {
      this.worktreeDir = validateBindPath(rawWorktree, "builders", options.allowedRoot);
    } else {
      this.worktreeDir = undefined;
    }

    const rawWarden = options.wardenBindPath ?? options.wardenDir;
    if (rawWarden) {
      this.wardenDir = validateBindPath(rawWarden, "warden", options.allowedRoot);
    } else {
      this.wardenDir = undefined;
    }

    if (options.requireBindPath && !this.worktreeDir) {
      throw new BindPathRequiredError("Bind path is required: caller must provide bind path");
    }

    if (options.requireWardenPath && !this.wardenDir) {
      throw new WardenPathRequiredError("Warden bind path is required: caller must provide warden path");
    }

    // L-7: wallClockTimeoutMs must be given: when it is missing the harness refuses to run, instead of running without a limit.
    if (
      options.wallClockTimeoutMs === undefined ||
      options.wallClockTimeoutMs === null
    ) {
      throw new TimeoutRequiredError(
        "wallClockTimeoutMs is required: caller must provide wallClockTimeoutMs"
      );
    }

    if (
      typeof options.wallClockTimeoutMs !== "number" ||
      !Number.isFinite(options.wallClockTimeoutMs) ||
      !Number.isSafeInteger(options.wallClockTimeoutMs) ||
      options.wallClockTimeoutMs <= 0
    ) {
      throw new TimeoutRequiredError(
        `wallClockTimeoutMs must be a positive safe integer; received ${String(options.wallClockTimeoutMs)}`
      );
    }

    if (options.settings !== undefined) {
      this.options.wallClockTimeoutMs = resolveWallClockTimeout(
        options.wallClockTimeoutMs,
        options.settings
      );
    } else {
      this.options.wallClockTimeoutMs = options.wallClockTimeoutMs;
    }

    this.runbox = options.runbox;
    this.auditbox = options.auditbox;
  }

  /**
   * Checks whether the overall wall-clock time cap has been exceeded.
   * Requirement 11.14.
   */
  private isWallClockTimedOut(): boolean {
    if (this.wallClockTimeoutHit) {
      return true;
    }
    if (
      this.startTime > 0 &&
      this.options.wallClockTimeoutMs &&
      this.options.wallClockTimeoutMs > 0
    ) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= this.options.wallClockTimeoutMs) {
        this.wallClockTimeoutHit = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Emits a harness event to the configured store, callback, or array.
   */
  private async emitEvent(input: EventInput): Promise<void> {
    if (this.options.events) {
      this.options.events.push(input);
    }

    if (typeof this.options.emitEvent === "function") {
      try {
        await this.options.emitEvent(input);
      } catch {
        // Event emission error handled gracefully
      }
    }

    if (this.options.eventStore) {
      const store = this.options.eventStore;
      try {
        if (typeof store.append === "function") {
          await store.append(input);
        } else if (typeof store.emit === "function") {
          await store.emit(input);
        }
      } catch {
        // Event store write failure handled gracefully
      }
    }
  }

  /**
   * Provisions Runbox and Auditbox via ExecutionBackend if backend is configured.
   * Requirement 11.4: WHEN the clone completes, THE ExecutionBackend SHALL
   * create one Runbox and one Auditbox for the run.
   */
  async provisionBoxes(): Promise<{ runbox?: Sandbox; auditbox?: Sandbox }> {
    const backend = this.options.backend;
    if (!backend) {
      return { runbox: this.runbox, auditbox: this.auditbox };
    }

    const runId = this.options.runId;

    if (
      this.options.ensureNetworkPolicy !== false &&
      backend.kind === "instabox-docker"
    ) {
      if (!getRunNetworkPolicy(runId)) {
        registerRunNetworkPolicy(buildRunNetworkPolicy(runId));
      }
    }

    const shouldPopulate =
      backend.kind === "instabox-docker" ||
      this.options.diskMiB !== undefined ||
      this.options.boxImage !== undefined ||
      this.options.settings !== undefined;

    if (!this.runbox) {
      const rawPath = this.options.bindPath ?? this.options.worktreeDir ?? this.worktreeDir;
      if (!rawPath) {
        throw new BindPathRequiredError(
          "Bind path (builders base) is required: caller must provide base bind path"
        );
      }
      const buildersHostPath = validateBindPath(rawPath, "builders", this.options.allowedRoot);

      const runboxSpec: SandboxSpec = {
        idempotencyKey: `runbox-${runId}`,
        labels: { runId, role: "runbox" },
        user: { uid: 1000 },
        workspace: {
          mode: "bind",
          hostPath: buildersHostPath,
          mountAt: "/workspace",
        },
      };

      if (shouldPopulate) {
        runboxSpec.resources = {
          diskMiB: (this.options.diskMiB as any) ?? 2048,
        };
        runboxSpec.settings = (this.options.settings as any) ?? {
          maxTimeoutMs: resolveWallClockTimeout(this.options),
          housekeepingTimeoutMs: 60000,
        };
        const image = this.options.boxImage ?? process.env.INSTABOX_DOCKER_IMAGE;
        if (image) {
          runboxSpec.image = image;
        }
      }

      this.runbox = await backend.create(runboxSpec);
    }

    if (!this.auditbox) {
      const rawWarden = this.options.wardenBindPath ?? this.options.wardenDir ?? this.wardenDir;
      if (!rawWarden) {
        throw new WardenPathRequiredError(
          "Warden bind path is required: caller must provide warden bind path"
        );
      }
      const wardenHostPath = validateBindPath(rawWarden, "warden", this.options.allowedRoot);

      const auditboxSpec: SandboxSpec = {
        idempotencyKey: `auditbox-${runId}`,
        labels: { runId, role: "auditbox" },
        user: { uid: 1000 },
        workspace: {
          mode: "bind",
          hostPath: wardenHostPath,
          mountAt: "/workspace",
        },
      };

      if (shouldPopulate) {
        auditboxSpec.resources = {
          diskMiB: (this.options.diskMiB as any) ?? 2048,
        };
        auditboxSpec.settings = (this.options.settings as any) ?? {
          maxTimeoutMs: resolveWallClockTimeout(this.options),
          housekeepingTimeoutMs: 60000,
        };
        const image = this.options.boxImage ?? process.env.INSTABOX_DOCKER_IMAGE;
        if (image) {
          auditboxSpec.image = image;
        }
      }

      this.auditbox = await backend.create(auditboxSpec);
    }

    return { runbox: this.runbox, auditbox: this.auditbox };
  }

  /**
   * Dispatches command execution to the runner or runbox.
   * Host execution without an injected runner is prohibited (Requirements 19.6, 42.1).
   */
  async dispatchCommand(
    argv: string[],
    logRef: string,
    timeoutMs?: number
  ): Promise<CommandExecutionResult> {
    const runner = this.options.runner ?? this.runbox;
    const cwd = this.worktreeDir;
    const env = sanitizeRunnerEnv(this.options.env);

    if (!runner) {
      throw new RunnerRequiredError();
    }

    if (typeof runner === "function") {
      const res = await runner(argv, { cwd, env, timeoutMs, logRef });
      // N-C5: a missing exit code is never treated as 0 (passed); dispatchCommand refuses.
      if (!Number.isInteger(res?.exitCode)) {
        throw new RunnerExitCodeError(
          `Runner reported no exit code for command '${argv.join(" ")}'; a missing exit code never counts as passed`
        );
      }
      return res;
    }

    if (runner && typeof (runner as { run?: unknown }).run === "function") {
      const target = runner as { run: (r: ExecRequest) => Promise<ExecResult | CommandExecutionResult> };
      const res = await target.run({ argv, cwd, env, timeoutMs, logRef });
      // N-C5: a missing exit code is never treated as 0 (passed); dispatchCommand refuses.
      if (!Number.isInteger(res?.exitCode)) {
        throw new RunnerExitCodeError(
          `Runner reported no exit code for command '${argv.join(" ")}'; a missing exit code never counts as passed`
        );
      }
      return {
        exitCode: res.exitCode as number,
        stdoutTail: res.stdoutTail,
        stderrTail: res.stderrTail,
        timedOut: res.timedOut,
        oomKilled: res.oomKilled,
        logRef: res.logRef ?? logRef,
      };
    }

    if (runner && typeof (runner as { exec?: unknown }).exec === "function") {
      const target = runner as { exec: (r: ExecRequest) => Promise<ExecProcess> };
      const proc = await target.exec({ argv, cwd, env, timeoutMs, logRef });
      // N-C5: without a wait result there is no exit code; it is never defaulted to 0 (passed).
      if (typeof proc.wait !== "function") {
        throw new RunnerExitCodeError(
          `Runner process for command '${argv.join(" ")}' provides no wait result and therefore no exit code`
        );
      }
      const waitRes = await proc.wait();
      if (!Number.isInteger(waitRes?.exitCode)) {
        throw new RunnerExitCodeError(
          `Runner process for command '${argv.join(" ")}' reported no exit code; a missing exit code never counts as passed`
        );
      }
      return {
        exitCode: waitRes.exitCode,
        timedOut: waitRes.timedOut,
        oomKilled: waitRes.oomKilled,
        logRef,
      };
    }

    throw new RunnerRequiredError(
      "Injected runner does not provide a valid execution interface (run, exec, or function)"
    );
  }

  /**
   * Executes a single baseline command step in Runbox.
   * Alias for executeInRunbox.
   */
  async runCommandStep(
    argv: string[],
    step: StepName = "test"
  ): Promise<BaselineStepResult> {
    return this.executeInRunbox(argv, step);
  }

  /**
   * Executes a command in Runbox, managing wall-clock timeout and event emission.
   * Requirement 11.16: emit command.started and command.result.
   */
  async executeInRunbox(
    argv: string[],
    step: StepName
  ): Promise<BaselineStepResult> {
    const runner = this.options.runner ?? this.runbox;
    if (!runner) {
      throw new RunnerRequiredError();
    }

    const commandLine = argv.join(" ");

    if (this.startTime === 0) {
      this.startTime = Date.now();
    }

    // Check wall-clock timeout prior to start
    if (this.isWallClockTimedOut()) {
      return {
        step,
        command: commandLine,
        status: "not run",
        reason: "time limit",
        timedOut: true,
      };
    }

    // Ensure npm install commands carry --ignore-scripts (Requirement 11.6, 20.13)
    let finalArgv = [...argv];
    if (
      finalArgv[0] === "npm" &&
      (finalArgv[1] === "install" ||
        finalArgv[1] === "i" ||
        finalArgv[1] === "ci" ||
        finalArgv[1] === "add")
    ) {
      if (!finalArgv.includes("--ignore-scripts")) {
        finalArgv.push("--ignore-scripts");
      }
    }

    const logRef = `exhume-${this.options.runId}-${step}-${Date.now()}`;
    const startedAt = Date.now();

    // Emit command.started (Requirement 11.16)
    await this.emitEvent({
      runId: this.options.runId,
      kind: "command.started",
      actor: "exhumer",
      ts: startedAt,
      data: {
        argv: finalArgv,
        commandLine: finalArgv.join(" "),
        step,
        cwd: this.worktreeDir,
        refs: [`cmd:${logRef}`],
      },
    });

    // Compute remaining wall-clock timeout if applicable
    let cmdTimeout = this.options.defaultTimeoutMs;
    if (this.options.wallClockTimeoutMs && this.options.wallClockTimeoutMs > 0) {
      const remainingWall = this.options.wallClockTimeoutMs - (Date.now() - this.startTime);
      if (remainingWall <= 0) {
        this.wallClockTimeoutHit = true;
        return {
          step,
          command: commandLine,
          status: "not run",
          reason: "time limit",
          timedOut: true,
        };
      }
      cmdTimeout = cmdTimeout ? Math.min(cmdTimeout, remainingWall) : remainingWall;
    }

    if (this.worktreeDir && fs.existsSync(this.worktreeDir)) {
      const scanReport = scanForEscapingSymlinks(this.worktreeDir);
      if (!scanReport.clean) {
        throw new Error(
          "Symlink escape detected in worktreeDir: " +
            (scanReport.reason || "unclean")
        );
      }
    }

    let execResult: CommandExecutionResult;
    let infrastructureError: string | null = null;
    try {
      execResult = await this.dispatchCommand(finalArgv, logRef, cmdTimeout);
    } catch (err: unknown) {
      if (err instanceof RunnerRequiredError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      infrastructureError = msg;
      execResult = {
        exitCode: null,
        stderr: msg,
        stderrTail: extractFailureExcerpt(msg),
        timedOut: this.isWallClockTimedOut(),
        logRef,
      };
    }

    const durationMs = Date.now() - startedAt;

    // Check if wall-clock timeout elapsed during command execution
    if (this.isWallClockTimedOut()) {
      execResult.timedOut = true;
    }

    const exitCode = execResult.exitCode;
    const isSuccess = exitCode === 0 && !execResult.timedOut && !execResult.oomKilled;
    const status: BaselineStepStatus = isSuccess ? "passed" : "failed";

    const errorExcerpt =
      execResult.stderrTail ??
      extractFailureExcerpt(execResult.stderr) ??
      execResult.stdoutTail ??
      extractFailureExcerpt(execResult.stdout);

    // Emit command.result (Requirement 11.16)
    await this.emitEvent({
      runId: this.options.runId,
      kind: "command.result",
      actor: "exhumer",
      ts: Date.now(),
      data: {
        argv: finalArgv,
        commandLine: finalArgv.join(" "),
        step,
        exitCode,
        status,
        durationMs,
        logRef,
        timedOut: !!execResult.timedOut,
        oomKilled: !!execResult.oomKilled,
        stdoutTail: execResult.stdoutTail ?? extractFailureExcerpt(execResult.stdout),
        stderrTail: execResult.stderrTail ?? extractFailureExcerpt(execResult.stderr),
        refs: [`cmd:${logRef}`],
        ...(infrastructureError ? { error: infrastructureError } : {}),
      },
    });

    const reason = infrastructureError
      ? `infrastructure error: ${infrastructureError}`
      : execResult.timedOut
      ? "time limit"
      : execResult.oomKilled
      ? "out of memory"
      : undefined;

    return {
      step,
      command: finalArgv.join(" "),
      status,
      exitCode,
      durationMs,
      logRef,
      errorExcerpt: errorExcerpt || undefined,
      timedOut: execResult.timedOut,
      oomKilled: execResult.oomKilled,
      reason,
      ...(infrastructureError ? { error: infrastructureError } : {}),
    };
  }

  /**
   * Executes the full baseline Exhumer sequence:
   * 1. Manifest inspection
   * 2. Runtime versions
   * 3. Install (with --ignore-scripts and lockfile-aware retry)
   * 4. Build (when script exists)
   * 5. Test (detecting placeholders and exit code 5)
   * 6. Death Certificate generation and persistence
   */
  async execute(): Promise<ExhumeHarnessResult> {
    this.startTime = Date.now();
    this.wallClockTimeoutHit = false;

    // Provision Runbox and Auditbox via ExecutionBackend (Requirement 11.4)
    await this.provisionBoxes();

    const runner = this.options.runner ?? this.runbox;
    if (!runner) {
      throw new RunnerRequiredError();
    }

    // Resolve manifest inspection (Requirement 11.5 to 11.10)
    let inspection = this.options.manifestInspection;
    if (!inspection) {
      const inspectionInput: ManifestInspectionInput = {
        files: this.options.files,
        packageJson: this.options.packageJson,
        pyprojectToml: this.options.pyprojectToml,
        setupPy: this.options.setupPy,
        pipfile: this.options.pipfile,
        requirementsTxt: this.options.requirementsTxt,
      };
      inspection = inspectRepositoryManifests(inspectionInput);
    }

    const allRows: BaselineCommandRow[] = [];
    const runtimeRows: BaselineCommandRow[] = [];

    if (this.worktreeDir && fs.existsSync(this.worktreeDir)) {
      const scanReport = scanForEscapingSymlinks(this.worktreeDir);
      if (!scanReport.clean) {
        throw new Error(
          "Symlink escape detected in worktreeDir: " +
            (scanReport.reason || "unclean")
        );
      }
    }

    // Step 0: Grimoire base analysis if enabled (Requirement 11.11)
    let signals: Signal[] = [];
    if (this.options.enableGrimoire) {
      const grimoireRes = await runGrimoireBaseAnalysis({
        runId: this.options.runId,
        treeDir: this.worktreeDir,
        files: this.options.files,
        eventStore: this.options.eventStore,
        emitEvent: this.options.emitEvent,
        events: this.options.events,
      });
      signals = grimoireRes.signals;
    }

    // Step 1: Version commands (Requirement 11.5)
    for (const vCmd of inspection.versionCommands) {
      if (this.isWallClockTimedOut()) {
        const unreached: BaselineCommandRow = {
          step: "version",
          command: vCmd.join(" "),
          status: "not run",
          reason: "time limit",
          timedOut: true,
        };
        runtimeRows.push(unreached);
        allRows.push(unreached);
        continue;
      }

      const row = await this.executeInRunbox([...vCmd], "version");
      runtimeRows.push(row);
      allRows.push(row);
    }

    // Step 2: Install command (Requirements 11.5, 11.6, 11.7, 11.8)
    let installRow: BaselineCommandRow;
    let retryRow: BaselineCommandRow | undefined;
    let installFailed = false;

    if (this.isWallClockTimedOut()) {
      installRow = {
        step: "install",
        command: inspection.installCommand.join(" "),
        status: "not run",
        reason: "time limit",
        timedOut: true,
      };
      allRows.push(installRow);
      installFailed = true;
    } else if (inspection.installCommand.length === 0) {
      installRow = {
        step: "install",
        command: "install",
        status: "passed",
        durationMs: 0,
      };
      allRows.push(installRow);
    } else {
      installRow = await this.executeInRunbox(
        [...inspection.installCommand],
        "install"
      );
      allRows.push(installRow);

      if (installRow.status === "failed") {
        if (!this.isWallClockTimedOut() && inspection.installRetryCommand && inspection.installRetryCommand.length > 0) {
          retryRow = await this.executeInRunbox(
            [...inspection.installRetryCommand],
            "retry"
          );
          allRows.push(retryRow);
          if (retryRow.status === "failed") {
            installFailed = true;
          }
        } else if (!this.isWallClockTimedOut()) {
          installFailed = true;
        }
      }
    }

    // Step 3: Build command (Requirement 11.5, 11.8, 11.9, 11.14)
    let buildRow: BaselineCommandRow;

    if (this.isWallClockTimedOut()) {
      // Requirement 11.14: Retain completed rows and mark unreached rows as not run with reason time limit
      buildRow = {
        step: "build",
        command: inspection.build.commandLine ?? "npm run build",
        status: "not run",
        reason: "time limit",
        timedOut: true,
      };
      allRows.push(buildRow);
    } else if (installFailed) {
      // Requirement 11.8: Mark build and tests not run when install and retry fail
      const notRunSpec = markStepsNotRunOnInstallFailure(true, true);
      buildRow = {
        step: "build",
        command: inspection.build.commandLine ?? "npm run build",
        status: "not run",
        reason: notRunSpec?.reason ?? "install failed and install retry failed",
      };
      allRows.push(buildRow);
    } else if (!inspection.build.hasBuildScript) {
      // Requirement 11.9: If no build script, mark build not run with reason
      buildRow = {
        step: "build",
        command: "build",
        status: "not run",
        reason: inspection.build.reason ?? "no build script",
      };
      allRows.push(buildRow);
    } else if (inspection.build.command && inspection.build.command.length > 0) {
      buildRow = await this.executeInRunbox(
        [...inspection.build.command],
        "build"
      );
      allRows.push(buildRow);
    } else {
      buildRow = {
        step: "build",
        command: "build",
        status: "not run",
        reason: "no build script",
      };
      allRows.push(buildRow);
    }

    // Step 4: Test command (Requirement 11.5, 11.8, 11.10, 11.14)
    let testRow: BaselineCommandRow;

    if (this.isWallClockTimedOut()) {
      // Requirement 11.14: Wall-clock cap hit
      testRow = {
        step: "test",
        command: inspection.test.testCommandLine ?? "npm test",
        status: "not run",
        reason: "time limit",
        timedOut: true,
      };
      allRows.push(testRow);
    } else if (installFailed) {
      // Requirement 11.8: Mark tests not run on install failure
      const notRunSpec = markStepsNotRunOnInstallFailure(true, true);
      testRow = {
        step: "test",
        command: inspection.test.testCommandLine ?? "npm test",
        status: "not run",
        reason: notRunSpec?.reason ?? "install failed and install retry failed",
      };
      allRows.push(testRow);
    } else if (this.isWallClockTimedOut()) {
      // Requirement 11.14: Wall-clock cap hit
      testRow = {
        step: "test",
        command: inspection.test.testCommandLine ?? "npm test",
        status: "not run",
        reason: "time limit",
        timedOut: true,
      };
      allRows.push(testRow);
    } else if (inspection.test.noTestsFound) {
      // Requirement 11.10: Record "No tests found" with rule M13
      testRow = {
        step: "test",
        command: inspection.test.testCommandLine ?? "npm test",
        status: NO_TESTS_FOUND_LABEL,
        ruleId: NO_TESTS_FOUND_RULE_ID,
        reason: inspection.test.reason,
        noTestsFound: true,
      };
      allRows.push(testRow);
    } else if (inspection.test.testCommand && inspection.test.testCommand.length > 0) {
      const executedTest = await this.executeInRunbox(
        [...inspection.test.testCommand],
        "test"
      );

      // Requirement 11.10: Python pytest collect returns exit code 5 -> No tests found with M13
      if (
        inspection.primaryLanguage === "python" &&
        executedTest.exitCode === 5
      ) {
        testRow = {
          ...executedTest,
          status: NO_TESTS_FOUND_LABEL,
          ruleId: NO_TESTS_FOUND_RULE_ID,
          reason: "pytest --collect-only exit code 5 (no tests collected)",
          noTestsFound: true,
        };
      } else {
        testRow = executedTest;
      }
      allRows.push(testRow);
    } else {
      testRow = {
        step: "test",
        command: "test",
        status: NO_TESTS_FOUND_LABEL,
        ruleId: NO_TESTS_FOUND_RULE_ID,
        reason: "no tests found",
        noTestsFound: true,
      };
      allRows.push(testRow);
    }

    // Step 5: Death Certificate synthesis and persistence (Requirements 11.12, 11.13, 11.15)
    let deathCertificate: DeathCertificate;
    if (this.options.enableTriageSession) {
      const triageSessionRes = await runExhumerTriageSession({
        runId: this.options.runId,
        baseSha: this.options.baseSha,
        repoUrl: this.options.repoUrl,
        primaryLanguage: inspection.primaryLanguage,
        packageManager: inspection.packageManager,
        rows: allRows,
        runtimes: runtimeRows,
        install: installRow,
        retry: retryRow,
        build: buildRow,
        test: testRow,
        signals,
        logs: this.options.logs,
        supervisor: this.options.supervisor,
        sessionClient: this.options.sessionClient,
        synthesizer: this.options.synthesizer,
        eventStore: this.options.eventStore,
        emitEvent: this.options.emitEvent,
        events: this.options.events,
      });
      deathCertificate = triageSessionRes.deathCertificate;
    } else {
      deathCertificate = createDeathCertificate({
        baseSha: this.options.baseSha,
        runId: this.options.runId,
        repoUrl: this.options.repoUrl,
        primaryLanguage: inspection.primaryLanguage,
        packageManager: inspection.packageManager,
        rows: allRows,
        runtimes: runtimeRows,
        install: installRow,
        retry: retryRow,
        build: buildRow,
        test: testRow,
      });
    }

    let certificatePath: string | undefined;
    if (this.options.storageDir) {
      const persistRes = await persistDeathCertificate(deathCertificate, {
        storageDir: this.options.storageDir,
        eventStore: this.options.eventStore,
        emitEvent: this.options.emitEvent,
        events: this.options.events,
      });
      certificatePath = persistRes.filePath;
    } else {
      // Requirement 11.13: Emit exhume.certificate when Death_Certificate is stored
      await this.emitEvent({
        runId: this.options.runId,
        kind: "exhume.certificate",
        actor: "exhumer",
        ts: Date.now(),
        data: {
          baseSha: deathCertificate.baseSha,
          healthy: deathCertificate.healthy,
          failureClasses: deathCertificate.failureClasses,
          sha256: deathCertificate.sha256,
          refs: [`cert:${deathCertificate.sha256}`],
        },
      });
    }

    // Requirement 11.15: Support early completion setting outcome to healthy_already
    const earlyCheck = await handleEarlyCompletion(deathCertificate, {
      userStop: this.options.userStop,
      userChoice: this.options.userChoice,
      stopHere: this.options.stopHere,
      eventStore: this.options.eventStore,
      emitEvent: this.options.emitEvent,
      events: this.options.events,
    });

    return {
      deathCertificate,
      runbox: this.runbox,
      auditbox: this.auditbox,
      rows: allRows,
      manifestInspection: inspection,
      wallClockTimeoutHit: this.wallClockTimeoutHit,
      healthy: deathCertificate.healthy,
      signals: signals.length > 0 ? signals : undefined,
      outcome: earlyCheck.shouldCompleteEarly ? "healthy_already" : undefined,
      earlyCompleted: earlyCheck.shouldCompleteEarly,
      certificatePath,
    };
  }
}

/**
 * Functional convenience entry point to run the Exhumer baseline harness.
 */
export async function runExhumerHarness(
  options: ExhumerHarnessOptions
): Promise<ExhumeHarnessResult> {
  const harness = new ExhumerHarness(options);
  return harness.execute();
}

/**
 * Alias for runExhumerHarness.
 */
export const exhumeBaseline = runExhumerHarness;
