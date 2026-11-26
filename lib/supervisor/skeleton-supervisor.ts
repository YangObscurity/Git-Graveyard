// Task 9.3, 9.4, 9.5: SkeletonSupervisor implementation
// Spawns one kiro-cli ACP process per Skeleton with its own HOME,
// speaks ACP over stdio, answers session/request_permission through PermissionBroker,
// and checks active model with allowlist before any session/prompt.
// Requirements: 14.1-14.4, 14.18, 15.1-15.8, 16.1-16.21, 41.20, 41.21, 45.12

import { ChildProcess, spawn as defaultSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { AcpClient, RequiredSettingError, spawnSkeletonProcess } from "./acp-client";
import {
  archiveSkeletonSessions,
  buildSessionNewParams,
  createSkeletonRaisedEvent,
  formatTaskPrompt,
  verifySessionNegotiation,
} from "./acp-session";
import { AcpTransport } from "./acp-transport";
import { EventTap } from "./event-tap";
import {
  AllowedModelId,
  getAssignedModelForRole,
  isAllowedModelId,
  ModelMismatchError,
  normalizeRole,
  SkeletonRole,
} from "./model-allowlist";
import {
  provisionSkeletonEnvironment,
  resolveSkeletonPaths,
  SkeletonPaths,
} from "./skeleton-env";
import { BudgetCapTracker, type BudgetCapSnapshot } from "./budget-caps";
import { HeadlessFallbackChannel } from "../acp/headless-fallback";
import type {
  ChildProcessLike,
  ExecutionChannel,
  GatewayEventSource,
  GatewayFatalEventPayload,
  McpServerConfig,
  SkeletonFailedEvent,
  SkeletonRaisedEvent,
  SkeletonSupervisorEvent,
  SkeletonSupervisorOptions,
  SpawnFunction,
  SpawnOptions,
  SupervisorFailureReason,
  SupervisorState,
  TaskPromptOptions,
} from "./types";
import {
  createPermissionBroker,
  PermissionBroker,
  PermissionBrokerOptions,
  MalformedRequestError,
  DuplicateOptionIdError,
} from "../broker/permission-broker";

export class SkeletonSupervisorError extends Error {
  readonly reason: SupervisorFailureReason;
  readonly role: string;
  readonly skeletonId: string;

  constructor(
    reason: SupervisorFailureReason,
    message: string,
    role: string,
    skeletonId: string
  ) {
    super(message);
    this.name = "SkeletonSupervisorError";
    this.reason = reason;
    this.role = role;
    this.skeletonId = skeletonId;
  }
}

export { RequiredSettingError };
export const ConfigurationError = RequiredSettingError;
export type ConfigurationError = RequiredSettingError;

/**
 * Audit N-B16: Safe identifier regex for skeletonId and runId.
 * Rejects '..', '/', '\', null bytes, and leading dashes.
 */
export const SAFE_IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Resolves symlinks via fs.realpathSync by walking up dirname for missing
 * leaf components to resolve the deepest existing ancestor's realpath and
 * rejoining the non-existent tail (audit N-B16).
 * Handles broken symlinks using fs.lstatSync and fs.readlinkSync so
 * symlinks cannot bypass resolution by pointing to non-existent targets.
 */
function resolveDeepestRealPath(
  targetPath: string,
  visited: Set<string> = new Set()
): string {
  const abs = path.resolve(targetPath);
  if (visited.has(abs)) {
    return abs;
  }
  visited.add(abs);

  let current = abs;
  const tail: string[] = [];

  while (current && current !== path.dirname(current)) {
    try {
      const lstat = fs.lstatSync(current);
      if (lstat.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(current);
          return tail.length > 0 ? path.join(real, ...tail) : real;
        } catch {
          // Broken symlink: destination does not exist on disk
          const linkTarget = fs.readlinkSync(current);
          const resolvedLink = path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(current), linkTarget);
          const real = resolveDeepestRealPath(resolvedLink, visited);
          return tail.length > 0 ? path.join(real, ...tail) : real;
        }
      }
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch (err: any) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        tail.unshift(path.basename(current));
        current = path.dirname(current);
        continue;
      }
      break;
    }
  }

  try {
    const realRoot = fs.realpathSync(current);
    return tail.length > 0 ? path.join(realRoot, ...tail) : realRoot;
  } catch {
    return abs;
  }
}

/**
 * True when target is inside base or equal to it. Resolves symlinks via
 * fs.realpathSync (walking up dirname for missing leaf components to resolve
 * the deepest existing ancestor's realpath and rejoining the non-existent tail)
 * for both base and target before path.relative, and verifies fs.lstatSync does
 * not traverse symlinked quarantineDir or target files outside base (audit N-B1, N-B16).
 */
export function isPathInside(base: string, target: string): boolean {
  if (typeof base !== "string" || typeof target !== "string") {
    return false;
  }
  const realBase = resolveDeepestRealPath(base);
  const realTarget = resolveDeepestRealPath(target);

  const rel = path.relative(realBase, realTarget);
  const isInside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!isInside) {
    return false;
  }

  // Verify fs.lstatSync along target path does not traverse a symlink outside base
  const absBase = path.resolve(base);
  const absTarget = path.resolve(target);
  let cur = absTarget;
  while (cur && cur !== path.dirname(cur) && cur !== absBase) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        const linkDest = resolveDeepestRealPath(cur);
        const linkRel = path.relative(realBase, linkDest);
        if (linkRel.startsWith("..") || path.isAbsolute(linkRel)) {
          return false;
        }
      }
    } catch {
      // Non-existent components handled by resolveDeepestRealPath
    }
    cur = path.dirname(cur);
  }

  return true;
}

/**
 * SkeletonSupervisor coordinates spawning, ACP stdio transport, session negotiation,
 * allowlist verification, and PermissionBroker interaction for an isolated Skeleton.
 */
export class SkeletonSupervisor extends EventEmitter {
  readonly runId: string;
  readonly skeletonId: string;
  readonly role: SkeletonRole | string;
  readonly cwd: string;
  readonly executionChannel: ExecutionChannel;

  private options: SkeletonSupervisorOptions;
  private spawnFn: SpawnFunction;
  private permissionBroker: PermissionBroker;
  private paths: SkeletonPaths;
  private watchdogLimitMs: number;
  private cancelGracePeriodMs: number;
  private resolvedSettings: Record<string, unknown>;
  private quarantineDir: string;

  private process: ChildProcessLike | null = null;
  private transport: AcpTransport | null = null;
  private client: AcpClient | null = null;

  private state: SupervisorState = "uninitialized";
  private sessionId: string | null = null;
  private verifiedModelId: AllowedModelId | null = null;
  private verifiedAgent: string | null = null;
  private failureReason: SupervisorFailureReason | null = null;
  private failureError: string | null = null;

  private promptPending: boolean = false;
  private respawnCount: number = 0;
  private budgetCaps?: BudgetCapTracker;
  private budgetCapHit: BudgetCapSnapshot | null = null;
  private isTerminating: boolean = false;
  private activeToolCalls: number = 0;
  private hasResultToolCall: boolean = false;
  private eventTap: EventTap | null = null;
  private currentTaskId: string | null = null;
  private worktreeQuarantined: boolean = false;
  private gateway: GatewayEventSource | null = null;
  private gatewayFatalHandler:
    | ((payload: GatewayFatalEventPayload) => void)
    | null = null;
  private gatewayListenerAttached: boolean = false;
  /** The Headless Fallback channel driving the in-flight turn, if any. */
  private activeHeadlessChannel: HeadlessFallbackChannel | null = null;
  /**
   * The channel whose in-flight turn a mid-turn `steer()` intentionally
   * cancelled. While it matches the channel being finalized, a "cancelled" turn
   * is a steer-driven resume rather than a Skeleton failure.
   */
  private steeringHeadlessChannel: HeadlessFallbackChannel | null = null;
  /**
   * The promise of the in-flight headless turn, if any. `steer()` awaits it after
   * cancelling the active channel so two concurrent `kiro-cli` processes can never
   * be spawned at the same time (Requirement 17.3).
   */
  private activeHeadlessTurn: Promise<unknown> | null = null;
  /**
   * The REAL session id reported by the CLI on a previous headless turn. It is
   * kept separate from `sessionId` (which may hold a supervisor-side placeholder)
   * and is the ONLY value ever passed as `--resume-id`. `null` until the CLI
   * reports one, so the first headless turn is always a fresh (non-resumed) run.
   */
  private headlessCliSessionId: string | null = null;

  constructor(options: SkeletonSupervisorOptions) {
    super();

    // Audit M-3: Validate watchdog limit before starting any Skeleton (no silent 5000 default)
    const optWatchdog =
      options.watchdogLimitMs ?? options.brokerOptions?.watchdogLimitMs;
    const settingsWatchdog =
      (options.settings as any)?.watchdogLimitMs ??
      (options.brokerOptions as any)?.settings?.watchdogLimitMs;

    let resolvedWatchdog: number | undefined;
    if (optWatchdog !== undefined) {
      if (
        typeof optWatchdog !== "number" ||
        !Number.isInteger(optWatchdog) ||
        optWatchdog <= 0
      ) {
        throw new RequiredSettingError(
          "watchdogLimitMs must be a positive integer in options"
        );
      }
      resolvedWatchdog = optWatchdog;
    } else if (settingsWatchdog !== undefined) {
      if (
        typeof settingsWatchdog !== "number" ||
        !Number.isInteger(settingsWatchdog) ||
        settingsWatchdog <= 0
      ) {
        throw new RequiredSettingError(
          "watchdogLimitMs must be a positive integer in settings"
        );
      }
      resolvedWatchdog = settingsWatchdog;
    } else {
      throw new RequiredSettingError(
        "watchdogLimitMs is required and must be a positive integer in options or settings"
      );
    }
    this.watchdogLimitMs = resolvedWatchdog;

    // Audit M-3: Validate timeout limit before starting any Skeleton (no silent 5000 default)
    const optTimeout =
      options.cancelGracePeriodMs ??
      (options as any).timeoutLimitMs;
    const settingsTimeout =
      (options.settings as any)?.cancelGracePeriodMs ??
      (options.settings as any)?.timeoutLimitMs ??
      (options.brokerOptions as any)?.settings?.cancelGracePeriodMs ??
      (options.brokerOptions as any)?.settings?.timeoutLimitMs;

    let resolvedTimeout: number | undefined;
    if (optTimeout !== undefined) {
      if (
        typeof optTimeout !== "number" ||
        !Number.isInteger(optTimeout) ||
        optTimeout <= 0
      ) {
        throw new RequiredSettingError(
          "cancelGracePeriodMs must be a positive integer in options"
        );
      }
      resolvedTimeout = optTimeout;
    } else if (settingsTimeout !== undefined) {
      if (
        typeof settingsTimeout !== "number" ||
        !Number.isInteger(settingsTimeout) ||
        settingsTimeout <= 0
      ) {
        throw new RequiredSettingError(
          "cancelGracePeriodMs must be a positive integer in settings"
        );
      }
      resolvedTimeout = settingsTimeout;
    } else {
      throw new RequiredSettingError(
        "cancelGracePeriodMs is required and must be a positive integer in options or settings"
      );
    }
    this.cancelGracePeriodMs = resolvedTimeout;

    // Audit N-5: Quarantine records are written only under quarantineDir, a
    // caller-supplied directory outside the worktree. Refuse to start without
    // one (no marker file is written inside the worktree).
    if (
      typeof options.quarantineDir !== "string" ||
      options.quarantineDir.length === 0
    ) {
      throw new RequiredSettingError(
        "quarantineDir is required and must be a non-empty string in options"
      );
    }

    // Audit N-B1, N-B16: quarantine records must land outside every directory the
    // Skeleton can write to: cwd and any additionalDirectories.
    const quarantineRoots: string[] = [];
    if (typeof options.cwd === "string" && options.cwd.length > 0) {
      quarantineRoots.push(options.cwd);
    }
    for (const extraDir of options.additionalDirectories ?? []) {
      if (typeof extraDir === "string" && extraDir.length > 0) {
        quarantineRoots.push(extraDir);
      }
    }
    for (const root of quarantineRoots) {
      const lexicalRel = path.relative(path.resolve(root), path.resolve(options.quarantineDir));
      const lexicalInside = lexicalRel === "" || (!lexicalRel.startsWith("..") && !path.isAbsolute(lexicalRel));
      if (lexicalInside || isPathInside(root, options.quarantineDir)) {
        throw new RequiredSettingError(
          "quarantineDir must be outside cwd and additionalDirectories"
        );
      }
    }

    const allowedRoot = (options as any).allowedRoot ?? (options.settings as any)?.allowedRoot;
    if (typeof allowedRoot === "string" && allowedRoot.length > 0) {
      if (!isPathInside(allowedRoot, options.quarantineDir)) {
        throw new RequiredSettingError(
          "quarantineDir must be inside allowedRoot"
        );
      }
    }

    this.quarantineDir = options.quarantineDir;

    this.resolvedSettings = {
      ...(options.settings ?? (options.brokerOptions as any)?.settings ?? {}),
      watchdogLimitMs: this.watchdogLimitMs,
      cancelGracePeriodMs: this.cancelGracePeriodMs,
    };

    this.options = { ...options };
    this.runId = options.runId;
    this.skeletonId = options.skeletonId;
    this.role = options.role;
    this.cwd = options.cwd;

    // Audit N-B16: Validate this.skeletonId and (if non-empty) this.runId
    if (
      typeof this.skeletonId !== "string" ||
      !SAFE_IDENTIFIER_REGEX.test(this.skeletonId)
    ) {
      throw new RequiredSettingError(
        `skeletonId is required and must match SAFE_IDENTIFIER_REGEX: got ${JSON.stringify(
          this.skeletonId
        )}`
      );
    }
    if (options.runId !== undefined) {
      const trimmedRunId =
        typeof this.runId === "string" ? this.runId.trim() : "";
      if (
        typeof this.runId !== "string" ||
        trimmedRunId === "" ||
        !SAFE_IDENTIFIER_REGEX.test(trimmedRunId)
      ) {
        throw new RequiredSettingError(
          `runId must match SAFE_IDENTIFIER_REGEX: got ${JSON.stringify(this.runId)}`
        );
      }
      this.runId = trimmedRunId;
      this.options.runId = trimmedRunId;
    }

    // Requirement 17.1: Channel selection based on probe P1 or explicit option
    const isP1Failed =
      options.channel === "Headless_Fallback" ||
      options.channel === "headless" ||
      Boolean(
        options.probeResults &&
        options.probeResults.P1 &&
        options.probeResults.P1.passed === false
      );
    this.executionChannel = isP1Failed ? "Headless_Fallback" : "ACP_V3";

    // Injectable spawn function - falls back to node:child_process.spawn
    this.spawnFn = options.spawnFn ?? options.spawn ?? (defaultSpawn as unknown as SpawnFunction);

    // Caps are enforced from what the stream actually reports (probe P5).
    if (options.budgetCaps) {
      this.budgetCaps = new BudgetCapTracker(options.budgetCaps);
    }

    // PermissionBroker adapter
    // (M-2, M-3, N-3) Caller permissionBroker option has no effect.
    // Broker is created from settings with validated watchdog limit.
    // (L-8) Put security-critical fields after the spread and make them non-overridable.
    const brokerOpts: PermissionBrokerOptions = {
      ...options.brokerOptions,
      watchdogLimitMs: this.watchdogLimitMs,
      settings: this.resolvedSettings,
      // Security-critical fields after spread: non-overridable
      cwd: options.cwd,
      role: String(options.role),
      additionalDirectories: options.additionalDirectories,
    };
    this.permissionBroker = createPermissionBroker(brokerOpts);

    // Resolve isolated filesystem paths
    this.paths = resolveSkeletonPaths(options.runId, options.skeletonId, options.baseDir);
    if (options.homeDir) {
      (this.paths as any).homeDir = options.homeDir;
    }
    if (options.kiroHomeDir) {
      (this.paths as any).kiroHomeDir = options.kiroHomeDir;
    }

    this.currentTaskId = options.taskId ?? null;
    if (options.eventTap) {
      this.eventTap = options.eventTap;
    }

    // Audit N-B1: the gateway emits "fatal" with a { skeletonId, runId, result }
    // payload naming the Skeleton the fatal result belongs to. Subscribe once;
    // events naming another Skeleton are ignored, and the listener is removed
    // when the Skeleton finishes or is terminated.
    const gateway = options.gateway;
    if (
      gateway &&
      typeof gateway.on === "function" &&
      typeof gateway.off === "function"
    ) {
      const gwFatalHandler = (payload: GatewayFatalEventPayload): void => {
        this.handleGatewayFatalEvent(payload).catch((err) => {
          // Audit N-B7: the error is surfaced on the error event, not swallowed.
          this.emit("error", err);
        });
      };
      gateway.on("fatal", gwFatalHandler);
      this.gateway = gateway;
      this.gatewayFatalHandler = gwFatalHandler;
      this.gatewayListenerAttached = true;
    }
  }

  public getEventTap(): EventTap | null {
    return this.eventTap;
  }

  public setEventTap(eventTap: EventTap): void {
    this.eventTap = eventTap;
  }

  public setTaskId(taskId: string): void {
    this.currentTaskId = taskId;
    if (this.eventTap) {
      this.eventTap.setTaskId(taskId);
    }
  }

  public getTaskId(): string | null {
    return this.currentTaskId;
  }

  public getExecutionChannel(): ExecutionChannel {
    return this.executionChannel;
  }

  public getState(): SupervisorState {
    return this.state;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public getVerifiedModel(): AllowedModelId | null {
    return this.verifiedModelId;
  }

  public getVerifiedAgent(): string | null {
    return this.verifiedAgent;
  }

  public getFailureReason(): SupervisorFailureReason | null {
    return this.failureReason;
  }

  public getPaths(): SkeletonPaths {
    return this.paths;
  }

  public getChildProcess(): ChildProcessLike | null {
    return this.process;
  }

  public getAcpClient(): AcpClient | null {
    return this.client;
  }

  public getPermissionBroker(): PermissionBroker {
    return this.permissionBroker;
  }

  public isWorktreeQuarantined(): boolean {
    return this.worktreeQuarantined;
  }

  /**
   * Spawns the Skeleton process and establishes verified ACP session.
   * Requirements: 14.1, 14.2, 15.5-15.8, 16.1-16.9, 41.20, 41.21.
   */
  public async raise(): Promise<SkeletonRaisedEvent> {
    if (this.state === "raised" && this.sessionId) {
      return createSkeletonRaisedEvent({
        runId: this.runId,
        skeletonId: this.skeletonId,
        role: String(this.role),
        sessionId: this.sessionId,
        modelId: this.verifiedModelId ?? "",
        agent: this.verifiedAgent ?? String(this.role),
      });
    }

    this.state = "spawning";

    try {
      // 1. Provision isolated HOME and $KIRO_HOME/agents/ (Requirements 14.2, 14.13)
      const assignedModel = getAssignedModelForRole(this.role, { hard: this.options.hard });
      provisionSkeletonEnvironment({
        paths: this.paths,
        role: this.role,
        model: assignedModel,
      });

      // Requirement 17.1: Headless Fallback execution channel
      if (this.executionChannel === "Headless_Fallback") {
        this.sessionId = `headless-${this.skeletonId}`;
        this.verifiedModelId = getAssignedModelForRole(this.role, { hard: this.options.hard });
        this.verifiedAgent = normalizeRole(this.role) ?? String(this.role);
        this.state = "raised";

        const raisedEvent = createSkeletonRaisedEvent({
          runId: this.runId,
          skeletonId: this.skeletonId,
          role: String(this.role),
          sessionId: this.sessionId,
          modelId: this.verifiedModelId,
          agent: this.verifiedAgent,
        });

        await this.emitEvent(raisedEvent);
        return raisedEvent;
      }

      // 2. Spawn process as user skel (Requirements 16.1, 16.2, 16.3, 16.4)
      const spawned = spawnSkeletonProcess({
        cwd: this.cwd,
        role: this.role,
        additionalDirectories: this.options.additionalDirectories,
        runId: this.runId,
        skeletonId: this.skeletonId,
        kiroApiKey: this.options.kiroApiKey,
        kiroHome: this.paths.kiroHomeDir,
        home: this.paths.homeDir,
        pathEnv: this.options.pathEnv,
        user: this.options.user,
        command: this.options.command,
        args: this.options.args,
        spawnFn: this.spawnFn,
        watchdogLimitMs: this.watchdogLimitMs,
        settings: this.resolvedSettings,
        acpWireFormat: this.options.acpWireFormat,
        permissionBroker: this.permissionBroker,
        onUpdate: (update) => this.handleUpdate(update),
        onAdmissionHalt: this.options.onAdmissionHalt,
      });

      this.process = spawned.process;
      this.attachProcessListeners(this.process);
      this.transport = spawned.transport;
      this.client = spawned.client;
      if ((spawned.client as any).permissionBroker) {
        this.permissionBroker = (spawned.client as any).permissionBroker;
      }
      this.client.on("error", (err: any) => {
        if (
          err instanceof MalformedRequestError ||
          err?.name === "MalformedRequestError" ||
          err?.name === "DuplicateOptionIdError"
        ) {
          this.failSkeleton("malformed_permission_request", err.message);
        }
      });

      this.state = "initializing";

      // 3. Send initialize and verify capabilities / login (Requirements 16.5, 16.6, 16.18)
      await this.client.initialize();

      // 4. Send session/new (Requirements 16.7, 16.8)
      const sessionNewParams = buildSessionNewParams({
        cwd: this.cwd,
        role: this.role,
        runId: this.runId,
        skeletonId: this.skeletonId,
        gatewayUrl: this.options.gatewayUrl,
        bearerToken: this.options.bearerToken,
        mcpServers: this.options.mcpServers,
        additionalDirectories: this.options.additionalDirectories,
        snapshotDir: this.options.snapshotDir,
        readOnlySnapshotDir: this.options.readOnlySnapshotDir,
        hard: this.options.hard,
      });

      const sessionResponse = await this.client.sessionNew(sessionNewParams);
      this.budgetCaps?.start();

      // 7. Verify model allowlist, mode, and gateway before allowing prompts
      // (Requirements 15.5, 15.6, 15.7, 16.9, 41.20, 41.21)
      const verification = await verifySessionNegotiation(sessionResponse, {
        role: this.role,
        hard: this.options.hard,
        checkGateway: this.options.checkMcpGateway ?? Boolean(this.options.isGatewayConnected),
        isGatewayConnected: this.options.isGatewayConnected,
      });

      if (!verification.ok) {
        this.failSkeleton(verification.reason, verification.error);
        throw new SkeletonSupervisorError(
          verification.reason,
          verification.error,
          String(this.role),
          this.skeletonId
        );
      }

      this.sessionId = verification.sessionId;
      this.verifiedModelId = verification.modelId;
      this.verifiedAgent = verification.agent;
      this.state = "raised";

      // 8. Emit skeleton.raised event (Requirement 15.8)
      const raisedEvent = createSkeletonRaisedEvent({
        runId: this.runId,
        skeletonId: this.skeletonId,
        role: String(this.role),
        sessionId: this.sessionId,
        modelId: this.verifiedModelId,
        agent: this.verifiedAgent,
      });

      await this.emitEvent(raisedEvent);
      return raisedEvent;
    } catch (err: any) {
      const reason = err?.reason ?? "spawn_failed";
      this.failSkeleton(reason, err?.message ?? "Failed to raise skeleton");
      throw err;
    }
  }

  /**
   * Dispatches a prompt to the Skeleton.
   * Requirement 15.6: Fails before prompt if active model was not verified.
   * Requirement 16.10: Completes only when prompt response arrives.
   * Requirement 16.21: Formats TaskPromptOptions containing tasks.md item, death certificate, guidance.
   */
  public async prompt(promptText: string | TaskPromptOptions | unknown): Promise<unknown> {
    if (this.state === "failed" || this.failureReason) {
      throw new SkeletonSupervisorError(
        this.failureReason ?? "model_mismatch",
        `Cannot prompt Skeleton: ${this.failureError ?? this.failureReason}`,
        String(this.role),
        this.skeletonId
      );
    }

    if (this.state !== "raised" || !this.sessionId || (!this.client && this.executionChannel !== "Headless_Fallback")) {
      throw new SkeletonSupervisorError(
        "spawn_failed",
        `Skeleton is not raised (state: ${this.state})`,
        String(this.role),
        this.skeletonId
      );
    }

    // Requirements 15.5, 15.6: No session/prompt sent if active model outside allowlist or differs from role tier
    const expectedModel = getAssignedModelForRole(this.role, { hard: this.options.hard });
    if (
      !this.verifiedModelId ||
      !isAllowedModelId(this.verifiedModelId) ||
      this.verifiedModelId !== expectedModel
    ) {
      this.failSkeleton(
        "model_mismatch",
        `Active model "${this.verifiedModelId}" is outside allowlist or differs from role tier`
      );
      throw new SkeletonSupervisorError(
        "model_mismatch",
        `Cannot prompt Skeleton: active model "${this.verifiedModelId}" is outside allowlist or differs from role tier`,
        String(this.role),
        this.skeletonId
      );
    }

    if (
      typeof promptText === "object" &&
      promptText !== null &&
      "taskId" in promptText &&
      typeof (promptText as any).taskId === "string"
    ) {
      this.setTaskId((promptText as any).taskId);
    }

    const resolvedPrompt =
      typeof promptText === "object" && promptText !== null && "taskText" in promptText
        ? formatTaskPrompt(promptText as TaskPromptOptions)
        : promptText;

    // Requirements 17.2, 17.3, 17.4: the Headless Fallback execution is delegated
    // ENTIRELY to HeadlessFallbackChannel, which streams stdout to disk
    // (`headless-stream.jsonl`) BEFORE parsing, maps the exit code, verifies the
    // active model against the allowlist, handles approval resumes via
    // `--resume-id`, and auto-denies every `ask` during live streaming (failing
    // closed when the required hook rejects). The turn is awaited and its real
    // result or failure is propagated.
    if (this.executionChannel === "Headless_Fallback") {
      return this.runTrackedHeadlessTurn(resolvedPrompt, this.headlessLogPath());
    }

    this.state = "prompting";
    this.promptPending = true;

    try {
      const result = await this.client!.sessionPrompt({
        sessionId: this.sessionId,
        prompt: resolvedPrompt,
      });
      this.promptPending = false;
      this.state = "raised";

      // Requirement 16.15: If typed result tool call returned and Turn completed, auto-finish if configured
      if (this.options.autoFinishOnTypedResult && this.hasResultToolCall) {
        await this.finish();
      }

      return result;
    } catch (err) {
      this.promptPending = false;
      if (!this.failureReason) {
        this.state = "raised";
      }
      throw err;
    }
  }

  /**
   * Starts a headless turn and tracks its promise so a concurrent `steer()` can
   * cancel and await it BEFORE starting a resume turn. Exactly one headless turn
   * is ever in flight (Requirement 17.3).
   */
  private runTrackedHeadlessTurn(
    resolvedPrompt: unknown,
    rawLogPath: string
  ): Promise<unknown> {
    const turn = this.runHeadlessTurn(resolvedPrompt, rawLogPath);
    this.activeHeadlessTurn = turn;
    const clear = (): void => {
      if (this.activeHeadlessTurn === turn) {
        this.activeHeadlessTurn = null;
      }
    };
    turn.then(clear, clear);
    return turn;
  }

  /**
   * Runs one Headless Fallback turn through the channel and awaits its real
   * result. A failed turn transitions the supervisor into the failed state with
   * the channel's real reason (for example `model_mismatch`, `gateway_missing`,
   * `missing_agent`, `stream_log_write_failed`, `ask_auto_deny_failed` or
   * `headless_fallback_disabled`) and throws a `SkeletonSupervisorError`.
   * Requirements 17.2-17.4, 17.11.
   */
  private async runHeadlessTurn(
    resolvedPrompt: unknown,
    rawLogPath: string
  ): Promise<unknown> {
    // The stream log lives under the Skeleton's sessions dir, never inside the
    // worktree, so it can never be staged into a candidate commit.
    fs.mkdirSync(this.paths.sessionsDir, { recursive: true });
    const channel = this.createHeadlessChannel(rawLogPath);
    this.activeHeadlessChannel = channel;
    this.state = "prompting";
    this.promptPending = true;

    try {
      const turn = await channel.runTurn({
        prompt:
          typeof resolvedPrompt === "string"
            ? resolvedPrompt
            : String(resolvedPrompt),
        // The supervisor's own id is NOT a CLI session id. Only a real id
        // reported by a previous headless turn may be used to resume.
        resumeId: this.headlessCliSessionId ?? undefined,
      });

      if (!turn.ok) {
        // A mid-turn steer() cancelled this turn on purpose; it is NOT a Skeleton
        // failure. Preserve the real CLI session id so the replacement resume
        // turn continues the same session, then return cleanly so steer() can
        // start that resume turn with the Skeleton still "raised".
        if (
          turn.status === "cancelled" &&
          this.steeringHeadlessChannel === channel
        ) {
          const rawSessionId = channel.getLastRawSessionId() ?? turn.sessionId;
          if (
            typeof rawSessionId === "string" &&
            rawSessionId.trim().length > 0
          ) {
            this.headlessCliSessionId = rawSessionId;
          }
          this.steeringHeadlessChannel = null;
          this.promptPending = false;
          this.state = "raised";
          return {
            status: "cancelled",
            rawLogPath,
            sessionId: turn.sessionId,
          };
        }
        const reason = (turn.reason ?? turn.status) as SupervisorFailureReason;
        const detail =
          turn.spawnError ??
          turn.logError ??
          `Headless Fallback turn failed: ${turn.status}`;
        this.failSkeleton(reason, detail);
        throw new SkeletonSupervisorError(
          reason,
          `Headless Fallback turn failed: ${detail}`,
          String(this.role),
          this.skeletonId
        );
      }

      // Requirement 17.12: the PUBLIC session id stays redacted, but the resume
      // must use the RAW CLI session id the channel retained internally, so a
      // raw id that overlaps the API key still resumes correctly.
      const rawSessionId = channel.getLastRawSessionId() ?? turn.sessionId;
      if (
        typeof rawSessionId === "string" &&
        rawSessionId.trim().length > 0
      ) {
        this.headlessCliSessionId = rawSessionId;
      }
      this.promptPending = false;
      this.state = "raised";
      return {
        status: "complete",
        output: turn.output,
        rawLogPath,
        sessionId: turn.sessionId,
        credits: turn.credits,
      };
    } catch (err) {
      this.promptPending = false;
      if (!this.failureReason) {
        this.state = "raised";
      }
      throw err;
    } finally {
      if (this.activeHeadlessChannel === channel) {
        this.activeHeadlessChannel = null;
      }
    }
  }

  /**
   * Dispatches a structured task prompt to the Skeleton.
   * Requirement 16.21.
   */
  public async dispatchTask(options: TaskPromptOptions | string): Promise<unknown> {
    return this.prompt(options);
  }

  /**
   * Delivers a mid-turn correction.
   * Requirement 16.12, 16.13: Use _session/steer if advertised; else cancel and reprompt.
   * Requirement 17.3: When correction started in Headless Fallback, start new process with --resume-id.
   */
  public async steer(correctionText: string): Promise<void> {
    if (this.state === "failed" || this.failureReason) {
      throw new SkeletonSupervisorError(
        this.failureReason ?? "model_mismatch",
        `Cannot steer Skeleton: ${this.failureError ?? this.failureReason}`,
        String(this.role),
        this.skeletonId
      );
    }

    const expectedModel = getAssignedModelForRole(this.role, { hard: this.options.hard });
    if (
      !this.verifiedModelId ||
      !isAllowedModelId(this.verifiedModelId) ||
      this.verifiedModelId !== expectedModel
    ) {
      this.failSkeleton(
        "model_mismatch",
        `Active model "${this.verifiedModelId}" is outside allowlist or differs from role tier`
      );
      throw new SkeletonSupervisorError(
        "model_mismatch",
        `Cannot steer Skeleton: active model "${this.verifiedModelId}" is outside allowlist or differs from role tier`,
        String(this.role),
        this.skeletonId
      );
    }

    if (this.executionChannel === "Headless_Fallback") {
      // Requirement 17.3: the correction is delegated to the Headless Fallback
      // channel, which resumes the CLI session with the real session id reported
      // by an earlier turn (never the supervisor-side placeholder). If a headless
      // turn is already in flight, cancel the active channel and wait for that
      // turn to settle BEFORE starting the resume, so two concurrent `kiro-cli`
      // processes can never be spawned at the same time.
      if (
        this.activeHeadlessChannel !== null ||
        this.activeHeadlessTurn !== null ||
        this.state === "prompting" ||
        this.promptPending
      ) {
        // Record the channel BEFORE cancelling it so `runHeadlessTurn` treats the
        // cancellation as steer-driven (resume) rather than a Skeleton failure.
        this.steeringHeadlessChannel = this.activeHeadlessChannel;
        this.activeHeadlessChannel?.cancel();
        const inFlight = this.activeHeadlessTurn;
        if (inFlight) {
          try {
            await inFlight;
          } catch {
            // The cancelled turn fails closed; steer still resumes from the
            // settled CLI session state.
          } finally {
            // Clear the steer marker once the cancelled turn has settled.
            this.steeringHeadlessChannel = null;
          }
        } else {
          this.steeringHeadlessChannel = null;
        }
      }
      await this.runTrackedHeadlessTurn(correctionText, this.headlessLogPath());
      return;
    }

    if (!this.client || !this.sessionId) {
      throw new Error("Cannot steer: Skeleton has no active session");
    }

    if (this.client.isMethodAdvertised("_session/steer")) {
      await this.client.sessionSteer({
        sessionId: this.sessionId,
        text: correctionText,
      });
      return;
    }

    // Fallback if _session/steer not advertised (Requirement 16.13):
    // 1. Wait for current tool call to complete
    if (this.activeToolCalls > 0) {
      // Audit M-3 residual: wait deadline uses requireCancelPromptTimeoutMs instead of hardcoded 10000
      const toolWaitDeadline = Date.now() + this.requireCancelPromptTimeoutMs();
      while (this.activeToolCalls > 0 && Date.now() < toolWaitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // 2. Send session/cancel
    await this.client.sessionCancel({ sessionId: this.sessionId });

    // 3. Wait for pending prompt response
    if (this.promptPending) {
      // Audit M-3: no numeric default; the limit comes from required settings.
      const promptTimeout = this.requireCancelPromptTimeoutMs();
      const waitDeadline = Date.now() + promptTimeout;
      while (this.promptPending && Date.now() < waitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // 4. Send correction as a new session/prompt
    await this.prompt(correctionText);
  }

  /**
   * Cancels the active turn or session.
   * Requirement 16.14: Send session/cancel, wait up to 10s for prompt response,
   * send SIGTERM, and send SIGKILL 5s later if still running.
   */
  public async cancel(reason: string = "cancelled"): Promise<void> {
    this.state = "cancelling";

    // Requirement 17.8: abort the in-flight headless turn, if any, so its child
    // process is signalled and the turn reports "cancelled".
    this.activeHeadlessChannel?.cancel();

    if (this.client && this.sessionId) {
      try {
        await this.client.sessionCancel({ sessionId: this.sessionId });
      } catch {
        // Continue to process termination
      }
    }

    // Wait for the prompt response within the required limit (Requirement 16.14)
    if (this.promptPending) {
      // Audit M-3: no numeric default; the limit comes from required settings.
      const promptTimeout = this.requireCancelPromptTimeoutMs();
      const waitDeadline = Date.now() + promptTimeout;
      while (this.promptPending && Date.now() < waitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // Send SIGTERM to process group (Requirement 16.14)
    if (this.process && !this.process.killed) {
      this.signalProcess(this.process, "SIGTERM");

      // Send SIGKILL after grace period if still running (Requirement 16.14)
      const gracePeriod = this.cancelGracePeriodMs;
      if (gracePeriod > 0) {
        await new Promise((resolve) => setTimeout(resolve, gracePeriod));
      }
      if (this.process && !this.process.killed && this.process.exitCode === null) {
        this.signalProcess(this.process, "SIGKILL");
      }
    }

    // Audit N-B1: a cancelled Skeleton is terminated; stop listening for
    // gateway fatal events.
    this.removeGatewayFatalListener();
    this.state = "terminated";
  }

  /**
   * Sends POSIX signal to child process group or process.
   * Requirement 16.14.
   */
  private signalProcess(proc: ChildProcessLike, signal: NodeJS.Signals): void {
    const isRealChildProcess =
      this.spawnFn === (defaultSpawn as unknown as SpawnFunction) &&
      proc instanceof ChildProcess;

    if (
      isRealChildProcess &&
      proc.pid &&
      typeof process !== "undefined" &&
      typeof process.kill === "function"
    ) {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch {
        // Process group signal failed, fallback to PID
      }
      try {
        process.kill(proc.pid, signal);
        return;
      } catch {
        // Fallback to proc.kill
      }
    }
    try {
      proc.kill(signal);
    } catch {
      // Ignore
    }
  }

  /**
   * Terminates the process and cleans up filesystem state.
   * Requirement 16.15: End process, archive sessions folder, delete remaining KIRO_HOME.
   */
  public async finish(): Promise<void> {
    this.isTerminating = true;

    // Abort any in-flight headless turn before tearing the Skeleton down.
    this.activeHeadlessChannel?.cancel();

    // Audit N-B1: a finished Skeleton no longer listens for gateway fatal events.
    this.removeGatewayFatalListener();

    if (this.client) {
      try {
        this.client.close();
      } catch {
        // Ignore
      }
    }

    if (this.process && !this.process.killed && this.process.exitCode === null) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }

    this.state = "terminated";

    // Requirement 16.15: Archive Skeleton sessions folder into run evidence
    const shouldArchive = this.options.archiveSessionsOnFinish ?? true;
    if (shouldArchive && fs.existsSync(this.paths.sessionsDir)) {
      try {
        archiveSkeletonSessions({
          sessionsDir: this.paths.sessionsDir,
          runId: this.runId,
          skeletonId: this.skeletonId,
          evidenceDir: this.options.evidenceDir,
          baseDir: this.options.baseDir,
        });
      } catch {
        // Ignore archive error
      }
    }

    // Requirement 16.15: Clean up KIRO_HOME if requested
    if (this.options.deleteKiroHomeOnFinish && fs.existsSync(this.paths.kiroHomeDir)) {
      try {
        fs.rmSync(this.paths.kiroHomeDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }

  /**
   * The disk path the Headless Fallback channel writes the raw stream-json to.
   * It lives under the Skeleton's sessions dir, NEVER inside the worktree, so
   * `commitDirtyWorktreeIfNeeded` can never stage the raw stream into a candidate
   * (Requirement 17.4).
   */
  private headlessLogPath(): string {
    return path.join(this.paths.sessionsDir, "headless-stream.jsonl");
  }

  /**
   * Builds the Headless Fallback channel for a turn or correction, wiring the
   * Skeleton's command, working directory, model, isolated environment, gateway
   * tool ids, injectable spawn function and stream log location. Approval is
   * bridged to `options.onApproval` (failing closed to `deny`), and the required
   * auto-deny hook is forwarded verbatim (Requirement 17.11): when it is missing
   * the channel is left without one so it fails closed with `ask_auto_deny_failed`
   * before spawning, and a present hook's errors propagate.
   */
  private createHeadlessChannel(logPath: string): HeadlessFallbackChannel {
    const modelId =
      this.verifiedModelId ??
      getAssignedModelForRole(this.role, { hard: this.options.hard });
    const onAskAutoDeny = this.options.onAskAutoDeny;
    return new HeadlessFallbackChannel({
      runId: this.runId,
      skeletonId: this.skeletonId,
      kiroHomeDir: this.paths.kiroHomeDir,
      homeDir: this.paths.homeDir,
      modelId: String(modelId),
      agentName: String(this.role),
      cwd: this.cwd,
      worktreeDir: this.cwd,
      kiroApiKey: this.options.kiroApiKey,
      pathEnv: this.options.pathEnv,
      // The sandbox user defaults to "skel" so the headless process runs as the
      // Skeleton user unless the caller overrides it.
      user: this.options.user ?? "skel",
      command: this.options.command ?? "kiro-cli",
      spawnFn: this.spawnFn,
      gatewayToolIds: this.options.gatewayToolIds,
      logPath,
      logTrustedBaseDir: this.paths.sessionsDir,
      // Requirement 17.1: the supervisor already selected the Headless channel on
      // P1 failure, so the channel runs only when P1 failed and P14 passed.
      p1Passed: this.options.probeResults?.P1?.passed ?? false,
      p14Passed: this.options.probeResults?.P14?.passed === true,
      s2ResumeSupported: this.options.probeResults?.S2?.passed === true,
      onApproval: async (request) => {
        // Never auto-approve (or resume) after cancellation or termination.
        if (
          this.isTerminating ||
          this.state === "terminated" ||
          this.state === "cancelling"
        ) {
          return "deny";
        }
        const handler = this.options.onApproval;
        if (typeof handler !== "function") {
          // Fail closed: an unhandled approval is denied, never auto-approved.
          return "deny";
        }
        try {
          return await handler(request);
        } catch {
          return "deny";
        }
      },
      ...(typeof onAskAutoDeny === "function" ? { onAskAutoDeny } : {}),
    });
  }

  private attachProcessListeners(proc: ChildProcessLike): void {
    proc.on("error", (err: any) => {
      if (this.isTerminating || this.state === "terminated") return;
      this.failSkeleton(
        "unexpected_exit",
        "Skeleton process error: " + (err?.message ?? String(err))
      );
    });

    proc.on("exit", async (code, signal) => {
      if (this.isTerminating || this.state === "terminated") {
        return;
      }

      // Requirement 16.16: If kiro-cli exits unexpectedly, respawn once with same KIRO_HOME
      if (this.respawnCount === 0 && this.state === "raised") {
        this.respawnCount++;
        try {
          await this.handleUnexpectedExitRespawn();
          return;
        } catch (err: any) {
          this.failSkeleton("unexpected_exit", `Respawn failed after exit code ${code}: ${err?.message}`);
        }
      } else {
        this.failSkeleton(
          "unexpected_exit",
          `Skeleton process exited unexpectedly with code ${code}, signal ${signal}`
        );
      }
    });
  }

  /**
   * Respawns crashed Skeleton once with same KIRO_HOME and session/load.
   * Requirements 16.16, 16.17.
   */
  private async handleUnexpectedExitRespawn(): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Cannot reload session: missing sessionId");
    }

    const spawned = spawnSkeletonProcess({
      cwd: this.cwd,
      role: this.role,
      additionalDirectories: this.options.additionalDirectories,
      runId: this.runId,
      skeletonId: this.skeletonId,
      kiroApiKey: this.options.kiroApiKey,
      kiroHome: this.paths.kiroHomeDir,
      home: this.paths.homeDir,
      pathEnv: this.options.pathEnv,
      user: this.options.user,
      command: this.options.command,
      args: this.options.args,
      spawnFn: this.spawnFn,
      watchdogLimitMs: this.watchdogLimitMs,
      settings: this.resolvedSettings,
      acpWireFormat: this.options.acpWireFormat,
      permissionBroker: this.permissionBroker,
      onUpdate: (update) => this.handleUpdate(update),
      onAdmissionHalt: this.options.onAdmissionHalt,
    });

    this.process = spawned.process;
    this.attachProcessListeners(this.process);
    this.transport = spawned.transport;
    this.client = spawned.client;
    if ((spawned.client as any).permissionBroker) {
      this.permissionBroker = (spawned.client as any).permissionBroker;
    }
    this.client.on("error", (err: any) => {
      if (
        err instanceof MalformedRequestError ||
        err?.name === "MalformedRequestError" ||
        err?.name === "DuplicateOptionIdError"
      ) {
        this.failSkeleton("malformed_permission_request", err.message);
      }
    });

    await this.client.initialize();

    const sessionParams = buildSessionNewParams({
      cwd: this.cwd,
      role: this.role,
      runId: this.runId,
      skeletonId: this.skeletonId,
      gatewayUrl: this.options.gatewayUrl,
      bearerToken: this.options.bearerToken,
      mcpServers: this.options.mcpServers,
      additionalDirectories: this.options.additionalDirectories,
      snapshotDir: this.options.snapshotDir,
      readOnlySnapshotDir: this.options.readOnlySnapshotDir,
      hard: this.options.hard,
    });

    // Send session/load with same parameters (Requirement 16.16)
    await this.client.sessionLoad({
      sessionId: this.sessionId,
      cwd: this.cwd,
      mcpServers: sessionParams.mcpServers,
      _meta: sessionParams._meta,
      ...(sessionParams.additionalDirectories
        ? { additionalDirectories: sessionParams.additionalDirectories }
        : {}),
    });

    // Requirement 16.17: Send continue instruction without any copy of the lost prompt
    await this.client.sessionPrompt({
      sessionId: this.sessionId,
      prompt: "continue from the current tree state",
    });

    this.state = "raised";
  }

  /**
   * Audit M-3: cancelPromptTimeoutMs has no numeric default. The wait limit
   * comes from options or settings and must be a positive integer whenever it
   * is actually needed.
   */
  private requireCancelPromptTimeoutMs(): number {
    const value =
      this.options.cancelPromptTimeoutMs ??
      this.resolvedSettings.cancelPromptTimeoutMs;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new RequiredSettingError(
        "cancelPromptTimeoutMs is required and must be a positive integer in options or settings"
      );
    }
    return value;
  }

  private failSkeleton(reason: SupervisorFailureReason, error: string): void {
    this.state = "failed";
    this.failureReason = reason;
    this.failureError = error;

    const failedEvent: SkeletonFailedEvent = {
      kind: "skeleton.failed",
      runId: this.runId,
      skeletonId: this.skeletonId,
      role: String(this.role),
      reason,
      error,
      actor: "SkeletonSupervisor",
      refs: [],
    };

    this.emitEvent(failedEvent).catch(() => {});
  }

  private async handleUpdate(update: unknown): Promise<void> {
    if (this.budgetCaps && !this.budgetCapHit) {
      const snapshot = this.budgetCaps.observe(update);
      if (snapshot.exceeded) {
        this.budgetCapHit = snapshot;
        this.emit("budget_exceeded", snapshot);
        // Requirement: caps are enforced in code, not by asking the model nicely.
        void this.cancel(`budget_cap_exceeded:${snapshot.reason ?? "unknown"}`).catch((err) => {
          this.emit("error", err);
        });
      }
    }

    if (update && typeof update === "object") {
      const u = update as Record<string, unknown>;

      // Audit N-6, N-B1: session updates never quarantine. Only gateway fatal
      // events quarantine; agent-supplied fatal flags in toolResult, result or
      // data are ignored here.

      // Track active tool calls and typed result tool calls (Requirements 16.13, 16.15)
      if (
        u.sessionUpdate === "tool_call" ||
        u.kind === "tool_call" ||
        (u.toolCall && !u.toolResult)
      ) {
        this.activeToolCalls++;
        const toolName = (u.toolCall as any)?.name ?? (u.toolCall as any)?.title ?? u.tool;
        if (toolName === "report_task_result" || toolName === "warden_verdict") {
          this.hasResultToolCall = true;
        }
      }
      if (
        u.sessionUpdate === "tool_result" ||
        u.kind === "tool_result" ||
        u.toolResult ||
        (u.toolCall && (u.toolCall as any).status === "completed")
      ) {
        this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
        const toolName = (u.toolCall as any)?.name ?? (u.toolCall as any)?.title ?? u.tool;
        if (toolName === "report_task_result" || toolName === "warden_verdict") {
          this.hasResultToolCall = true;
        }
      }
    }
    if (this.eventTap) {
      try {
        await this.eventTap.processUpdate(update, {
          runId: this.runId,
          skeletonId: this.skeletonId,
          role: String(this.role),
          taskId: this.currentTaskId ?? undefined,
        });
      } catch (err) {
        this.emit("error", err);
      }
    }
    if (this.options.onUpdate) {
      await this.options.onUpdate(update);
    }
    this.emit("update", update);
  }

  /**
   * Handles a fatal result reported by the gateway.
   * Terminates that Skeleton session and writes the quarantine record under
   * quarantineDir, outside the worktree (audit N-5). This is the only path
   * that quarantines a Skeleton: a gateway fatal event naming another Skeleton
   * never reaches this method, and quarantine flags or markers supplied by the
   * agent in session updates are ignored (audit N-6, N-B1).
   */
  public async handleFatalGatewayResult(result?: unknown): Promise<void> {
    const resObj = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
    const reason =
      (typeof resObj.reason === "string" ? resObj.reason : undefined) ??
      (typeof resObj.error === "string" ? resObj.error : undefined) ??
      "fatal_gateway_result";

    // 1. Mark worktree quarantined
    this.worktreeQuarantined = true;

    // Audit N-B16: Validate this.skeletonId and (if non-empty) this.runId right
    // before building any quarantine file path so path traversal filenames are impossible.
    if (
      typeof this.skeletonId !== "string" ||
      !SAFE_IDENTIFIER_REGEX.test(this.skeletonId)
    ) {
      throw new RequiredSettingError(
        `skeletonId must match SAFE_IDENTIFIER_REGEX: got ${JSON.stringify(
          this.skeletonId
        )}`
      );
    }
    if (
      this.runId !== undefined &&
      this.runId !== null &&
      this.runId !== "" &&
      (typeof this.runId !== "string" || !SAFE_IDENTIFIER_REGEX.test(this.runId))
    ) {
      throw new RequiredSettingError(
        `runId must match SAFE_IDENTIFIER_REGEX: got ${JSON.stringify(this.runId)}`
      );
    }

    // 2. Write the quarantine record under quarantineDir, outside the worktree
    // (audit N-5: nothing is written inside the worktree). Audit N-B7: a
    // failed write terminates the Skeleton, emits an event, and the error is
    // not swallowed.
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
      const recordPath = path.join(
        this.quarantineDir,
        `${this.runId}-${this.skeletonId}.quarantine.json`
      );
      if (!isPathInside(this.quarantineDir, recordPath)) {
        throw new RequiredSettingError(
          "quarantine record path escapes quarantineDir"
        );
      }
      fs.writeFileSync(
        recordPath,
        JSON.stringify({
          quarantined: true,
          quarantinedAt: new Date().toISOString(),
          runId: this.runId,
          skeletonId: this.skeletonId,
          reason,
          code: resObj.code ?? "FATAL",
        }),
        "utf-8"
      );
    } catch (err) {
      this.terminateSkeletonProcess();
      this.failSkeleton(
        "quarantine_write_failed",
        `Failed to write the quarantine record under quarantineDir: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      this.state = "terminated";
      throw err;
    }

    // 3. Terminate that Skeleton session (kill process, close client)
    this.terminateSkeletonProcess();

    // 4. Emit failure / quarantine event
    this.failSkeleton(
      "quarantined",
      `Session terminated and worktree quarantined due to fatal gateway result: ${reason}`
    );

    // Ensure session state is terminated
    this.state = "terminated";
  }

  /**
   * Handles a gateway "fatal" event. The payload is { skeletonId, runId,
   * result } naming the Skeleton the fatal result belongs to (audit N-B1, N-B10):
   * only an event naming THIS Skeleton quarantines, events naming another
   * Skeleton are ignored. Fatal events missing skeletonId must be ignored
   * without quarantining (audit N-B10).
   */
  private async handleGatewayFatalEvent(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const p = payload as Record<string, unknown>;

    // Audit N-B10: Require typeof p.skeletonId === 'string' && p.skeletonId === this.skeletonId
    if (typeof p.skeletonId !== "string" || p.skeletonId !== this.skeletonId) {
      return;
    }

    // Audit N-B10: When this.runId is set (or when p.runId is present), require typeof p.runId === 'string' && p.runId === this.runId
    const hasThisRunId =
      typeof this.runId === "string" && this.runId.length > 0;
    const hasPRunId = p.runId !== undefined && p.runId !== null;
    if (hasThisRunId || hasPRunId) {
      if (typeof p.runId !== "string" || p.runId !== this.runId) {
        return;
      }
    }

    await this.handleFatalGatewayResult(p.result ?? payload);
  }

  /**
   * Terminates the Skeleton session (kill process, close client) and removes
   * the gateway fatal listener: a terminated Skeleton no longer subscribes
   * (audit N-B1).
   */
  private terminateSkeletonProcess(): void {
    this.removeGatewayFatalListener();
    this.isTerminating = true;

    // Abort any in-flight headless turn before tearing the Skeleton down.
    this.activeHeadlessChannel?.cancel();

    if (this.client) {
      try {
        this.client.close();
      } catch {
        // Ignore
      }
    }

    if (this.process && !this.process.killed && this.process.exitCode === null) {
      try {
        this.signalProcess(this.process, "SIGTERM");
      } catch {
        // Ignore
      }
      if (!this.process.killed) {
        try {
          this.process.kill("SIGTERM");
        } catch {
          // Ignore
        }
      }
    }

    this.sessionId = null;
  }

  /**
   * Removes the gateway fatal listener exactly once (audit N-B1).
   */
  private removeGatewayFatalListener(): void {
    if (
      !this.gateway ||
      !this.gatewayFatalHandler ||
      !this.gatewayListenerAttached
    ) {
      return;
    }
    this.gatewayListenerAttached = false;
    try {
      this.gateway.off("fatal", this.gatewayFatalHandler);
    } catch {
      // Ignore emitter errors while detaching
    }
    this.gateway = null;
    this.gatewayFatalHandler = null;
  }

  /**
   * Dispatches gateway results to the supervisor. If fatal, terminates session.
   * A bare quarantine flag without a fatal marker does not quarantine.
   */
  public async handleGatewayResult(result: unknown): Promise<void> {
    if (result && typeof result === "object") {
      const res = result as Record<string, unknown>;
      if (res.status === "fatal" || res.fatal === true) {
        await this.handleFatalGatewayResult(res);
      }
    }
  }

  public async reportGatewayResult(result: unknown): Promise<void> {
    return this.handleGatewayResult(result);
  }

  private async emitEvent(event: SkeletonSupervisorEvent): Promise<void> {
    if (this.options.onEvent) {
      try {
        await this.options.onEvent(event);
      } catch {
        // Ignore subscriber error
      }
    }
    this.emit(event.kind, event);
    this.emit("event", event);
  }
}

/**
 * Factory function to create a new SkeletonSupervisor.
 */
export function createSkeletonSupervisor(
  options: SkeletonSupervisorOptions
): SkeletonSupervisor {
  return new SkeletonSupervisor(options);
}
