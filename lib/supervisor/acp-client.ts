// Task 9.4: ACP Client and lifecycle management
// Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.10, 16.12, 16.18

import { spawn as defaultSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { AcpTransport } from "./acp-transport";
import { buildSkeletonEnv } from "./skeleton-env";
import type { SkeletonRole } from "./model-allowlist";
import type {
  AcpCapabilities,
  ChildProcessLike,
  KiroSessionMeta,
  McpServerConfig,
  SessionLoadParams,
  SessionNewParams,
  SpawnFunction,
} from "./types";
import type {
  AcpPermissionBrokerAdapter,
  PermissionBroker,
  PermissionBrokerRequest,
  PermissionOption,
  RequestPermissionResponse,
  RequestPermissionSubject,
  RequestPermissionToolCall,
} from "../broker/permission-broker";
import {
  createPermissionBroker,
  validatePermissionRequest,
  MalformedRequestError,
  DuplicateOptionIdError,
} from "../broker/permission-broker";

class RequiredSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequiredSettingError";
  }
}

/**
 * Answer given to kiro-cli's `_kiro/terminal/shell_type` client duty (probe P6,
 * 2026-11-11). A fixed name keeps the answer independent of the host and is all
 * the engine needs to continue towards a tool call.
 */
export const ACP_SHELL_TYPE = "bash";

export {
  MalformedRequestError,
  DuplicateOptionIdError,
  validatePermissionRequest,
  RequiredSettingError,
};

export interface AcpClientOptions {
  runId?: string;
  skeletonId?: string;
  role?: string;
  cwd?: string;
  additionalDirectories?: string[];
  watchdogLimitMs?: number;
  settings?: Record<string, unknown>;
  acpWireFormat?: "legacy" | "acp-v1";
  onUpdate?: (update: unknown) => void | Promise<void>;
  onRequestPermission?: (
    request: PermissionBrokerRequest
  ) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
  onAdmissionHalt?: (reason: string) => void | Promise<void>;
}

/**
 * Options for spawning a Skeleton ACP process.
 * Requirements: 16.1, 16.2.
 */
export interface SpawnSkeletonOptions {
  cwd: string;
  role: SkeletonRole | string;
  runId: string;
  skeletonId: string;
  kiroApiKey?: string;
  kiroHome?: string;
  home?: string;
  pathEnv?: string;
  user?: string;
  command?: string;
  args?: readonly string[];
  spawnFn?: SpawnFunction;
  additionalDirectories?: string[];
  watchdogLimitMs?: number;
  settings?: Record<string, unknown>;
  acpWireFormat?: "legacy" | "acp-v1";
  permissionBroker?: PermissionBroker | AcpPermissionBrokerAdapter;
  onUpdate?: (update: unknown) => void | Promise<void>;
  onRequestPermission?: (
    request: PermissionBrokerRequest
  ) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
  onAdmissionHalt?: (reason: string) => void | Promise<void>;
}

/**
 * Result structure returned when spawning a Skeleton ACP process.
 */
export interface SpawnedSkeleton {
  process: ChildProcessLike;
  transport: AcpTransport;
  client: AcpClient;
  env: Record<string, string>;
  command: string;
  args: readonly string[];
  user: string;
}

/**
 * Spawns kiro-cli acp --agent-engine=v3 as unprivileged user skel
 * with process environment set to exactly KIRO_API_KEY, KIRO_HOME, HOME, and PATH.
 * Requirements: 16.1, 16.2, 16.3.
 */
export function spawnSkeletonProcess(
  options: SpawnSkeletonOptions
): SpawnedSkeleton {
  const procEnv = buildSkeletonEnv({
    kiroApiKey: options.kiroApiKey,
    kiroHome: options.kiroHome ?? "",
    home: options.home ?? "",
    pathEnv: options.pathEnv,
  });

  const command = options.command ?? "kiro-cli";
  const args = options.args ?? ["acp", "--agent-engine=v3"];
  const user = options.user ?? "skel";
  const spawnFn = options.spawnFn ?? (defaultSpawn as unknown as SpawnFunction);

  const proc = spawnFn(command, args, {
    cwd: options.cwd,
    env: procEnv,
    user,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const transport = new AcpTransport(proc);
  const client = new AcpClient(transport, {
    runId: options.runId,
    skeletonId: options.skeletonId,
    role: String(options.role),
    cwd: options.cwd,
    additionalDirectories: options.additionalDirectories,
    watchdogLimitMs:
      options.watchdogLimitMs ??
      ((options.settings as any)?.watchdogLimitMs as number | undefined) ??
      ((options.permissionBroker as any)?.watchdogLimitMs as number | undefined) ??
      ((options.permissionBroker as any)?.options?.watchdogLimitMs as number | undefined),
    settings:
      options.settings ??
      ((options.permissionBroker as any)?.options?.settings as Record<string, unknown> | undefined),
    acpWireFormat: options.acpWireFormat,
    onUpdate: options.onUpdate,
    onRequestPermission: options.onRequestPermission,
    onAdmissionHalt: options.onAdmissionHalt,
  });

  return {
    process: proc,
    transport,
    client,
    env: procEnv,
    command,
    args,
    user,
  };
}

export const spawnAcpClient = spawnSkeletonProcess;

/**
 * Checks whether an initialize response asks for user authentication or login.
 * Requirement 16.6: If the initialize reply asks for a login, fail with auth_failed.
 */
export function isLoginRequested(initResult: unknown): boolean {
  if (!initResult || typeof initResult !== "object") {
    return false;
  }
  const r = initResult as Record<string, unknown>;
  if (
    r.loginRequired === true ||
    r.authRequired === true ||
    r.requiresLogin === true ||
    r.action === "login"
  ) {
    return true;
  }
  if (
    r.status === "login_required" ||
    r.status === "auth_required" ||
    r.status === "unauthenticated"
  ) {
    return true;
  }
  if (typeof r.loginUrl === "string" || typeof r.authUrl === "string") {
    return true;
  }
  if (Array.isArray(r.authMethods)) {
    for (const m of r.authMethods) {
      if (typeof m === "string" && (m.includes("login") || m.includes("interactive"))) {
        return true;
      }
      if (m && typeof m === "object") {
        const mr = m as Record<string, unknown>;
        if (
          mr.type === "login" ||
          mr.required === true ||
          mr.name === "login" ||
          mr.kind === "login"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Recursively creates a deep, frozen copy of plain data only.
 * Functions and non-plain properties are omitted so an observer cannot mutate
 * the original request or invoke methods on it (Audit M-2, N-3).
 */
export function deepFreezePlainData<T>(
  val: T,
  seen: WeakMap<object, unknown> = new WeakMap<object, unknown>()
): T {
  if (val === null || typeof val !== "object") {
    if (typeof val === "function") {
      return undefined as unknown as T;
    }
    return val;
  }

  if (seen.has(val)) {
    return seen.get(val) as T;
  }

  if (Array.isArray(val)) {
    const copy: unknown[] = [];
    seen.set(val, copy);
    for (const item of val) {
      if (typeof item !== "function") {
        copy.push(deepFreezePlainData(item, seen));
      }
    }
    return Object.freeze(copy) as unknown as T;
  }

  const copy: Record<string, unknown> = {};
  seen.set(val, copy);
  for (const [key, prop] of Object.entries(val)) {
    if (typeof prop !== "function") {
      copy[key] = deepFreezePlainData(prop, seen);
    }
  }
  return Object.freeze(copy) as unknown as T;
}

/**
 * ACP Client implementing JSON-RPC communication for a Skeleton.
 */
export class AcpClient extends EventEmitter {
  private transport: AcpTransport;
  private options: AcpClientOptions;
  private permissionBroker: AcpPermissionBrokerAdapter;
  private capabilities: AcpCapabilities = {};
  private activeSessionId: string | null = null;
  private requiredHandlersRegistered: boolean = false;
  private sessionInvalidated: boolean = false;
  private watchdogLimitMs: number;

  constructor(transport: AcpTransport, options: AcpClientOptions = {}) {
    let resolvedLimit: number | undefined;
    if (
      typeof options.watchdogLimitMs === "number" &&
      Number.isInteger(options.watchdogLimitMs) &&
      options.watchdogLimitMs > 0
    ) {
      resolvedLimit = options.watchdogLimitMs;
    } else if (
      typeof (options.settings as any)?.watchdogLimitMs === "number" &&
      Number.isInteger((options.settings as any)?.watchdogLimitMs) &&
      (options.settings as any)?.watchdogLimitMs > 0
    ) {
      resolvedLimit = (options.settings as any).watchdogLimitMs as number;
    }

    if (resolvedLimit === undefined) {
      throw new RequiredSettingError(
        "watchdogLimitMs is required and must be a positive integer in options.watchdogLimitMs or settings.watchdogLimitMs"
      );
    }

    super();
    this.transport = transport;
    this.options = options;
    this.watchdogLimitMs = resolvedLimit;
    // (M-2) Every session/request_permission request is decided only by the broker.
    // The constructor always creates the broker; caller permissionBroker option has no effect.
    this.permissionBroker = createPermissionBroker({
      role: options.role,
      cwd: options.cwd,
      additionalDirectories: options.additionalDirectories,
      watchdogLimitMs: resolvedLimit,
      settings: options.settings
        ? { ...options.settings, watchdogLimitMs: resolvedLimit }
        : options.settings,
    });

    // Requirement 16.3: Handlers MUST be registered prior to sending session/new
    this.registerRequiredHandlers();
  }

  public isInvalidated(): boolean {
    return this.sessionInvalidated;
  }

  /**
   * Registers default handlers for ACP events and permissions before session/new.
   */
  private registerRequiredHandlers(): void {
    // 1. session/update notification handler
    this.transport.registerNotificationHandler("session/update", async (params: unknown) => {
      if (this.options.onUpdate) {
        try {
          await this.options.onUpdate(params);
        } catch (err) {
          this.emit("error", err);
        }
      }
      this.emit("update", params);
    });

    // Also support session/update as request if kiro-cli sends as request
    this.transport.registerRequestHandler("session/update", async (params: unknown) => {
      if (this.options.onUpdate) {
        await this.options.onUpdate(params);
      }
      this.emit("update", params);
      return { ok: true };
    });

    // 2. session/request_permission request handler
    this.transport.registerRequestHandler(
      "session/request_permission",
      async (params: unknown, id: string | number) => {
        return this.handlePermissionRequest(params, id);
      }
    );

    // Requirement 16.4: Answer every incoming fs/*, terminal/* and unknown client request with JSON-RPC error.
    // The AcpTransport handles unknown methods by returning error code -32601.
    // Explicitly hook common fs/* and terminal/* prefixes for clarity.
    const fsTerminalMethods = [
      "fs/read",
      "fs/write",
      "fs/list",
      "terminal/run",
      "terminal/exec",
      "terminal/spawn",
    ];
    for (const m of fsTerminalMethods) {
      this.transport.registerRequestHandler(m, () => {
        const err = new Error(`Method "${m}" not supported: probe P2 has not recorded Kiro invoking it`);
        (err as any).code = -32601;
        throw err;
      });
    }

    // kiro-cli 3.1.0 also makes client-duty requests on its own `_kiro/*`
    // namespace. It asks for the shell type before it lets a tool run, and with
    // no answer the session stalls before the first tool call (probe P6,
    // 2026-11-11). The probes recorded exactly one `_kiro` request arriving at
    // the client (P6, P12): `_kiro/terminal/shell_type`. The other `_kiro`
    // traffic the engine sends is notifications that need no answer (P7
    // steering `*_changed`, P15 `_kiro/mcp/status`), and requests like
    // `_kiro/account/getUsage` (P15) run the other way, client to engine.
    // Audit N-B2: there is no catch-all answer any more. Every other method
    // gets JSON-RPC error -32601 so requirement 16.4 holds, and permission
    // requests keep their own broker handler above; they are never answered
    // here.
    this.transport.registerFallbackRequestHandler(async (method, params) => {
      this.emit("client_request", { method, params });
      if (method === "_kiro/terminal/shell_type") {
        return { shellType: ACP_SHELL_TYPE };
      }
      const err = new Error(`Method "${method}" not supported`);
      (err as any).code = -32601;
      throw err;
    });

    this.requiredHandlersRegistered = true;
  }

  public async handlePermissionRequest(
    params: unknown,
    requestId: string | number
  ): Promise<RequestPermissionResponse> {
    if (this.sessionInvalidated) {
      const err = new MalformedRequestError(
        "Session has been invalidated due to a previous malformed permission request"
      );
      throw err;
    }

    if (!params || typeof params !== "object") {
      this.sessionInvalidated = true;
      const err = new MalformedRequestError("Permission request must be a non-null object");
      this.emit("error", err);
      throw err;
    }

    const rawReq = params as Record<string, unknown>;

    // (L-6) Take the run id from the session context and reject a request that has none.
    // Must NOT fall back to rawReq.runId.
    const sessionRunId =
      typeof this.options.runId === "string" && this.options.runId.trim().length > 0
        ? this.options.runId.trim()
        : undefined;

    if (!sessionRunId) {
      this.sessionInvalidated = true;
      const err = new MalformedRequestError(
        "Permission request missing required runId in session context"
      );
      this.emit("error", err);
      throw err;
    }

    // Resolve sessionId: must be non-empty string from request or activeSessionId
    const resolvedSessionId =
      (typeof rawReq.sessionId === "string" && rawReq.sessionId.trim().length > 0
        ? rawReq.sessionId.trim()
        : undefined) ??
      (this.activeSessionId && this.activeSessionId.trim().length > 0
        ? this.activeSessionId.trim()
        : undefined);

    if (!resolvedSessionId) {
      this.sessionInvalidated = true;
      const err = new MalformedRequestError(
        "Permission request missing required sessionId"
      );
      this.emit("error", err);
      throw err;
    }

    // Validate options array shape
    if (!Array.isArray(rawReq.options)) {
      this.sessionInvalidated = true;
      const err = new MalformedRequestError(
        "Permission request missing required options array"
      );
      this.emit("error", err);
      throw err;
    }

    // Validate each option has optionId and kind, and no duplicate optionIds
    const seenOptionIds = new Set<string>();
    for (let i = 0; i < rawReq.options.length; i++) {
      const opt = rawReq.options[i];
      if (!opt || typeof opt !== "object") {
        this.sessionInvalidated = true;
        const err = new MalformedRequestError(`Option at index ${i} must be a non-null object`);
        this.emit("error", err);
        throw err;
      }
      const optObj = opt as Record<string, unknown>;
      const rawOptionId =
        optObj.optionId !== undefined && optObj.optionId !== null && String(optObj.optionId).trim().length > 0
          ? String(optObj.optionId).trim()
          : optObj.id !== undefined && optObj.id !== null && String(optObj.id).trim().length > 0
          ? String(optObj.id).trim()
          : "";
      if (!rawOptionId) {
        this.sessionInvalidated = true;
        const err = new MalformedRequestError(`Option at index ${i} missing required optionId`);
        this.emit("error", err);
        throw err;
      }
      if (typeof optObj.kind !== "string" || optObj.kind.trim().length === 0) {
        this.sessionInvalidated = true;
        const err = new MalformedRequestError(`Option at index ${i} missing required kind string`);
        this.emit("error", err);
        throw err;
      }
      if (seenOptionIds.has(rawOptionId)) {
        this.sessionInvalidated = true;
        const err = new DuplicateOptionIdError(`Duplicate optionId '${rawOptionId}' found at index ${i}`);
        this.emit("error", err);
        throw err;
      }
      seenOptionIds.add(rawOptionId);
    }

    // Requirement 18.4 & ACP field whitelist:
    // Build brokerRequest strictly from whitelisted fields (toolCallId, consent/capability, arguments).
    // Never spread rawReq parameters.
    // Values from this.options (role, cwd, additionalDirectories) must override anything request carries.
    const brokerRequest: PermissionBrokerRequest = {
      id: requestId,
      requestId: String(requestId),
      sessionId: resolvedSessionId,
      runId: sessionRunId,

      // additionalDirectories, role and cwd come only from broker options, never from request
      role: this.options.role,
      cwd: this.options.cwd,
      additionalDirectories: this.options.additionalDirectories,

      // Explicitly whitelisted identity, consent, capability, and argument fields
      toolCallId:
        typeof rawReq.toolCallId === "string" ? rawReq.toolCallId : undefined,
      capability:
        typeof rawReq.capability === "string" ? rawReq.capability : undefined,
      target: typeof rawReq.target === "string" ? rawReq.target : undefined,
      consent: rawReq.consent,
      mcpTool:
        typeof rawReq.mcpTool === "string" ? rawReq.mcpTool : undefined,
      arguments: rawReq.arguments,
      rawInput: rawReq.rawInput,
      params: rawReq.params,
      options: rawReq.options as PermissionOption[],
      _meta:
        rawReq._meta && typeof rawReq._meta === "object"
          ? (rawReq._meta as PermissionBrokerRequest["_meta"])
          : undefined,
      toolCall:
        rawReq.toolCall && typeof rawReq.toolCall === "object"
          ? (rawReq.toolCall as RequestPermissionToolCall)
          : undefined,
      subject:
        rawReq.subject && typeof rawReq.subject === "object"
          ? (rawReq.subject as RequestPermissionSubject)
          : undefined,
    };

    // Assert shape via validatePermissionRequest
    validatePermissionRequest(brokerRequest);

    // (M-2, N-3) No permission replacement: onRequestPermission cannot replace decision.
    // Call observer callback if present with a deep, frozen copy of plain data only,
    // so that it cannot change the request the broker decides on.
    // Observer return value is ignored; every decision comes ONLY from the broker.
    if (this.options.onRequestPermission) {
      try {
        const frozenCopy = deepFreezePlainData(brokerRequest);
        await this.options.onRequestPermission(frozenCopy);
      } catch {
        // Observer callback error ignored
      }
    }

    // Every session/request_permission request is decided ONLY by the broker.
    return this.permissionBroker.handleRequestPermission(brokerRequest);
  }

  private getRequestTimeoutMs(overrideMs?: number): number {
    return (
      overrideMs ??
      ((this.options.settings as any)?.cancelPromptTimeoutMs as number | undefined) ??
      this.watchdogLimitMs ??
      0
    );
  }

  /**
   * Initializes ACP channel and verifies capabilities.
   * Requirement 16.5: Store advertised capabilities.
   * Requirement 16.6: Fail spawn with reason auth_failed if reply asks for login.
   * Requirement 16.18: Halt Admission on auth_failed.
   */
  public async initialize(
    clientCapabilities: Record<string, unknown> = {}
  ): Promise<AcpCapabilities> {
    const initParams =
      this.options.acpWireFormat === "acp-v1"
        ? {
            protocolVersion: 1,
            clientInfo: { name: "git-graveyard", version: "1.0.0" },
            clientCapabilities: {
              ...clientCapabilities,
              streaming: true,
            },
          }
        : {
            clientCapabilities: {
              ...clientCapabilities,
              streaming: true,
            },
          };

    let result: unknown;
    try {
      result = await this.transport.sendRequest(
        "initialize",
        initParams,
        this.getRequestTimeoutMs()
      );
    } catch (err: any) {
      if (
        err?.code === 401 ||
        err?.code === -32001 ||
        err?.message?.toLowerCase().includes("login") ||
        err?.message?.toLowerCase().includes("auth")
      ) {
        if (this.options.onAdmissionHalt) {
          try {
            await this.options.onAdmissionHalt("auth_failed");
          } catch {
            // Ignore callback error
          }
        }
        this.emit("admission_halt", "auth_failed");
        const authErr = new Error("auth_failed: initialize request failed with authentication error");
        (authErr as any).reason = "auth_failed";
        throw authErr;
      }
      throw err;
    }

    if (isLoginRequested(result)) {
      if (this.options.onAdmissionHalt) {
        try {
          await this.options.onAdmissionHalt("auth_failed");
        } catch {
          // Ignore callback error
        }
      }
      this.emit("admission_halt", "auth_failed");
      const authErr = new Error("auth_failed: kiro-cli ACP initialize requested login");
      (authErr as any).reason = "auth_failed";
      throw authErr;
    }

    this.capabilities = (result && typeof result === "object" ? result : {}) as AcpCapabilities;
    return this.capabilities;
  }

  /**
   * Returns whether an optional method was advertised during initialize.
   * Requirement 16.5: Send an optional method only when the method is advertised.
   */
  public isMethodAdvertised(methodName: string): boolean {
    if (this.capabilities.extensionMethods?.includes(methodName)) {
      return true;
    }

    const kiroExt =
      this.capabilities.agentCapabilities?._meta?.kiro?.extensionMethods;
    if (Array.isArray(kiroExt) && kiroExt.includes(methodName)) {
      return true;
    }

    return false;
  }

  /**
   * Establishes a new session via session/new.
   * Requirement 16.3: Handlers registered prior to sending session/new.
   * Requirement 16.7, 16.8.
   */
  private normalizeWireMcpServers(
    mcpServers: McpServerConfig[] | undefined
  ): unknown[] {
    if (!Array.isArray(mcpServers)) {
      return [];
    }
    return mcpServers.map((srv) => {
      const serverName =
        srv.id === "necromancer-gateway" ? "necromancer" : (srv.name ?? srv.id ?? "necromancer");
      const rawHeaders = srv.headers;
      const headers = Array.isArray(rawHeaders)
        ? rawHeaders
        : rawHeaders && typeof rawHeaders === "object"
        ? Object.entries(rawHeaders).map(([name, value]) => ({
            name,
            value: String(value),
          }))
        : [];
      return {
        type: srv.transport === "sse" ? "sse" : srv.transport === "stdio" ? "stdio" : "http",
        name: serverName,
        ...(srv.url ? { url: srv.url } : {}),
        ...(srv.command ? { command: srv.command } : {}),
        ...(srv.args ? { args: srv.args } : {}),
        headers,
      };
    });
  }

  public async sessionNew(params: SessionNewParams): Promise<unknown> {
    if (!this.requiredHandlersRegistered) {
      throw new Error("Cannot send session/new: required handlers are not registered");
    }
    const wireParams =
      this.options.acpWireFormat === "acp-v1"
        ? {
            cwd: params.cwd,
            mcpServers: this.normalizeWireMcpServers(params.mcpServers),
          }
        : params;
    const res = await this.transport.sendRequest(
      "session/new",
      wireParams,
      this.getRequestTimeoutMs()
    );
    if (res && typeof res === "object") {
      const rec = res as Record<string, unknown>;
      if (typeof rec.sessionId === "string") {
        this.activeSessionId = rec.sessionId;
      }
    }
    return res;
  }

  /**
   * Reloads a session via session/load after respawn.
   * Requirement 16.16.
   */
  public async sessionLoad(params: SessionLoadParams): Promise<unknown> {
    if (this.sessionInvalidated) {
      throw new Error("Cannot send session/load: Skeleton session has been invalidated");
    }
    const wireParams =
      this.options.acpWireFormat === "acp-v1"
        ? {
            sessionId: params.sessionId,
            cwd: params.cwd,
            mcpServers: this.normalizeWireMcpServers(params.mcpServers),
          }
        : params;
    const res = await this.transport.sendRequest(
      "session/load",
      wireParams,
      this.getRequestTimeoutMs()
    );
    this.activeSessionId = params.sessionId;
    return res;
  }

  /**
   * Dispatches a prompt to the Skeleton.
   * Requirement 16.10: Treat call as complete only when the prompt response arrives.
   */
  public async sessionPrompt(params: {
    sessionId: string;
    prompt: unknown;
  }): Promise<unknown> {
    if (this.sessionInvalidated) {
      throw new Error("Cannot send session/prompt: Skeleton session has been invalidated");
    }
    const wireParams =
      this.options.acpWireFormat === "acp-v1" && typeof params.prompt === "string"
        ? {
            sessionId: params.sessionId,
            prompt: [{ type: "text", text: params.prompt }],
          }
        : params;
    return this.transport.sendRequest("session/prompt", wireParams, 0); // 0 or long timeout for prompting
  }

  /**
   * Cancels an active turn via session/cancel.
   * Requirement 16.14.
   */
  public async sessionCancel(params: { sessionId: string }): Promise<unknown> {
    return this.transport.sendRequest(
      "session/cancel",
      params,
      this.getRequestTimeoutMs()
    );
  }

  /**
   * Delivers a mid-turn correction via _session/steer if advertised.
   * Requirement 16.12.
   */
  public async sessionSteer(params: {
    sessionId: string;
    text: string;
  }): Promise<unknown> {
    if (this.sessionInvalidated) {
      throw new Error("Cannot send _session/steer: Skeleton session has been invalidated");
    }
    if (!this.isMethodAdvertised("_session/steer")) {
      throw new Error("_session/steer is not advertised by the agent");
    }
    return this.transport.sendRequest(
      "_session/steer",
      params,
      this.getRequestTimeoutMs()
    );
  }

  /**
   * Closes the client and underlying transport.
   */
  public close(): void {
    this.transport.close();
  }
}
