// Task 10.5: MCP Gateway server, bearer authentication, and transport
// Requirements: 19.1, 19.2, 19.3, 19.4, 19.14, 45.9

import * as crypto from "node:crypto";
import * as http from "node:http";
import { EventEmitter } from "node:events";
import type { ExecutionBackend, Sandbox } from "../backend/types";
import {
  ConfigurationError,
  type AckMessageParams,
  type AskParams,
  type ProposeTaskParams,
  type RegisterSkeletonOptions,
  type RegisteredSkeleton,
  type ReportBlockerParams,
  type ReportTaskResultParams,
  type SandboxExecParams,
  type SandboxLogParams,
  type ToolExecutionContext,
  type WardenVerdictParams,
} from "./types";
import { ApprovalManager, type EventEmitCallback } from "./approval-manager";
import { LogStore } from "../events/log-store";
import type { RunStore } from "../runs/run-store";
import type { EventStore } from "../events/event-store";
import {
  handleSandboxExec,
  handleSandboxLog,
  type ExecutionToolsOptions,
  type ProcessSweeper,
} from "./execution-tools";
import {
  handleAckMessage,
  handleAsk,
  handleProposeTask,
  handleReportBlocker,
  handleReportTaskResult,
  handleWardenVerdict,
  CollaborationStore,
  defaultCollaborationStore,
  type CollaborationToolsOptions,
} from "./collaboration-tools";
import type { BudgetGovernor } from "../governor/budget-governor";

export { ConfigurationError };

/**
 * Tool role mapping from Requirement 19.3:
 * - sandbox_exec and sandbox_log: Exhumer, Bonesetter, Soul-stitcher, Warden
 * - report_task_result: Planner, Exhumer, Bonesetter, Soul-stitcher, Scribe
 * - warden_verdict: Warden
 * - ask: Planner, Bonesetter, Soul-stitcher
 * - report_blocker: Bonesetter, Soul-stitcher
 * - propose_task: Soul-stitcher
 * - ack_message: Bonesetter, Soul-stitcher, Scribe
 */
export const ALLOWED_MCP_TOOLS_BY_ROLE: Record<string, ReadonlySet<string>> = {
  Planner: new Set(["report_task_result", "ask"]),
  Exhumer: new Set(["sandbox_exec", "sandbox_log", "report_task_result"]),
  Bonesetter: new Set([
    "sandbox_exec",
    "sandbox_log",
    "report_task_result",
    "ask",
    "report_blocker",
    "ack_message",
  ]),
  "Soul-stitcher": new Set([
    "sandbox_exec",
    "sandbox_log",
    "report_task_result",
    "ask",
    "report_blocker",
    "propose_task",
    "ack_message",
  ]),
  Warden: new Set(["sandbox_exec", "sandbox_log", "warden_verdict"]),
  Scribe: new Set(["report_task_result", "ack_message"]),
};

/**
 * Normalizes role string to canonical form.
 */
export function normalizeRole(role: string): string | null {
  if (typeof role !== "string") {
    return null;
  }
  const clean = role.trim().toLowerCase().replace(/_/g, "-");
  if (clean === "planner") return "Planner";
  if (clean === "exhumer") return "Exhumer";
  if (clean === "bonesetter") return "Bonesetter";
  if (clean === "soul-stitcher" || clean === "soulstitcher") return "Soul-stitcher";
  if (clean === "warden") return "Warden";
  if (clean === "scribe") return "Scribe";
  return null;
}

/**
 * Validates whether a given role is authorized to invoke a tool.
 * Requirements: 19.3, 19.4.
 */
export function isRoleAuthorizedForTool(role: string, toolName: string): boolean {
  const norm = normalizeRole(role);
  if (!norm) {
    return false;
  }
  const toolSet = ALLOWED_MCP_TOOLS_BY_ROLE[norm];
  return !!toolSet && toolSet.has(toolName);
}

export interface McpGatewayOptions {
  approvalManager?: ApprovalManager;
  runStore?: RunStore;
  eventStore?: EventStore;
  logStore?: LogStore;
  collaborationStore?: CollaborationStore;
  onEmitEvent?: EventEmitCallback;
  processSweeper?: ProcessSweeper;
  defaultTimeoutMs?: number;
  approvalWaitMs?: number;
  defaultWaitMs?: number;
  backend?: ExecutionBackend;
  runbox?: Sandbox;
  auditbox?: Sandbox;
  /** Fallback per-run budget governor consulted for every `sandbox_exec` when no run/skeleton governor is registered. */
  budgetGovernor?: BudgetGovernor;
}

/**
 * Skeleton registration extended with the optional per-skeleton budget governor. The base
 * `RegisterSkeletonOptions` shape is unchanged, so an existing caller keeps working; the extra field
 * is carried onto the registered entry and consulted ahead of the per-run governor.
 */
export type GatewayRegisterSkeletonOptions = RegisterSkeletonOptions & {
  budgetGovernor?: BudgetGovernor;
};

/** Registered Skeleton extended with the optional per-skeleton budget governor. */
export type GatewayRegisteredSkeleton = RegisteredSkeleton & {
  budgetGovernor?: BudgetGovernor;
};

/**
 * R5-B4 (audit "fatal result", PARTIAL): decides whether a tool result is
 * fatal and must be emitted as a "fatal" event on the gateway. A result is
 * fatal when its status is "fatal", or it carries fatal === true, or it
 * carries quarantine === true. Non-fatal results never emit.
 */
function isFatalToolResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const res = result as Record<string, unknown>;
  return res.status === "fatal" || res.fatal === true || res.quarantine === true;
}

/**
 * SB1 (N-B1): payload of the gateway "fatal" event. skeletonId and runId come
 * from the mapping of the caller's bearer token to a registered Skeleton;
 * result is the fatal tool result itself, unchanged.
 */
export interface FatalEventPayload {
  skeletonId: string;
  runId?: string;
  result: unknown;
}

/**
 * MCP Gateway core engine managing per-Skeleton bearer tokens and tool dispatch.
 * Extends EventEmitter so supervisor-side subscribers can listen for "fatal"
 * events emitted when a tool result is fatal (R5-B4, SB1).
 */
export class McpGateway extends EventEmitter {
  readonly approvalManager: ApprovalManager;
  readonly logStore: LogStore;
  readonly eventStore?: EventStore;
  readonly collaborationStore: CollaborationStore;
  readonly options: McpGatewayOptions;
  readonly defaultTimeoutMs: number;
  readonly approvalWaitMs: number;

  private readonly tokensToSkeleton: Map<string, GatewayRegisteredSkeleton> = new Map();
  private readonly idsToSkeleton: Map<string, GatewayRegisteredSkeleton> = new Map();
  private readonly connectedSkeletons: Set<string> = new Set();
  /** Per-run budget governors registered by the orchestrator, keyed by runId. */
  private readonly runGovernors: Map<string, BudgetGovernor> = new Map();
  /** Runs asked to stop gracefully: a new `sandbox_exec` for such a run is refused. */
  private readonly gracefulStopRuns: Set<string> = new Set();

  constructor(options?: McpGatewayOptions) {
    super();
    if (!options) {
      throw new ConfigurationError(
        "McpGateway requires configuration settings: defaultTimeoutMs and approvalWaitMs"
      );
    }

    if (
      typeof options.defaultTimeoutMs !== "number" ||
      isNaN(options.defaultTimeoutMs) ||
      options.defaultTimeoutMs < 1
    ) {
      throw new ConfigurationError(
        "Missing or invalid defaultTimeoutMs setting: positive integer required with no hard-coded default"
      );
    }
    this.defaultTimeoutMs = options.defaultTimeoutMs;

    const approvalWait = options.approvalWaitMs ?? options.defaultWaitMs;
    if (!options.approvalManager) {
      if (
        typeof approvalWait !== "number" ||
        isNaN(approvalWait) ||
        approvalWait < 1
      ) {
        throw new ConfigurationError(
          "Missing or invalid approvalWaitMs setting: positive integer required with no hard-coded default"
        );
      }
      this.approvalWaitMs = approvalWait;
      this.approvalManager = new ApprovalManager({
        defaultWaitMs: approvalWait,
        onEmitEvent: options.onEmitEvent,
        runStore: options.runStore,
        eventStore: options.eventStore,
      });
    } else {
      this.approvalManager = options.approvalManager;
      this.approvalWaitMs = approvalWait ?? this.approvalManager.defaultWaitMs;
    }

    // SB1 (M-3): a missing LogStore is a configuration error. No in-memory
    // fallback is created silently.
    if (!options.logStore) {
      throw new ConfigurationError(
        "Missing logStore setting: a LogStore instance is required; no in-memory fallback is provided"
      );
    }

    this.options = options;
    this.eventStore = options.eventStore;
    this.logStore = options.logStore;
    this.collaborationStore =
      options.collaborationStore ?? new CollaborationStore();
  }

  /**
   * Registers a Skeleton with its own unique bearer token.
   * Requirement 19.2: Identify calling Skeleton by its bearer token.
   * Audit N-B10: reject duplicate registrations and empty identifiers.
   */
  registerSkeleton(opts: GatewayRegisterSkeletonOptions): GatewayRegisteredSkeleton {
    const norm = normalizeRole(opts.role);
    if (!norm) {
      throw new Error(`Cannot register Skeleton: unknown role '${opts.role}'`);
    }

    if (!opts.skeletonId || typeof opts.skeletonId !== "string" || !opts.skeletonId.trim()) {
      throw new Error("Cannot register Skeleton: skeletonId is required");
    }

    const trimmedId = opts.skeletonId.trim();

    if (this.idsToSkeleton.has(trimmedId)) {
      throw new Error(`Cannot register Skeleton: duplicate skeletonId '${trimmedId}'`);
    }

    if (!opts.worktreeRoot || typeof opts.worktreeRoot !== "string" || !opts.worktreeRoot.trim()) {
      throw new Error("Cannot register Skeleton: worktreeRoot is required (Requirement 19.5)");
    }

    if (opts.bearerToken !== undefined) {
      if (typeof opts.bearerToken !== "string" || !opts.bearerToken.trim()) {
        throw new Error("Cannot register Skeleton: bearerToken must be non-empty when provided");
      }
      if (this.tokensToSkeleton.has(opts.bearerToken.trim())) {
        throw new Error(`Cannot register Skeleton: duplicate bearerToken '${opts.bearerToken.trim()}'`);
      }
    }

    if (opts.runId !== undefined) {
      if (typeof opts.runId !== "string" || !opts.runId.trim()) {
        throw new Error("Cannot register Skeleton: runId must be non-empty when provided");
      }
    }

    const bearerToken =
      opts.bearerToken !== undefined
        ? opts.bearerToken.trim()
        : `skel-${crypto.randomBytes(24).toString("hex")}`;

    if (this.tokensToSkeleton.has(bearerToken)) {
      throw new Error(`Cannot register Skeleton: duplicate bearerToken '${bearerToken}'`);
    }

    const reg: GatewayRegisteredSkeleton = {
      skeletonId: trimmedId,
      bearerToken,
      role: norm,
      worktreeRoot: opts.worktreeRoot,
      runId: opts.runId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      backend: opts.backend,
      runbox: opts.runbox,
      auditbox: opts.auditbox,
      budgetGovernor: opts.budgetGovernor,
    };

    this.tokensToSkeleton.set(bearerToken, reg);
    this.idsToSkeleton.set(trimmedId, reg);
    this.connectedSkeletons.add(trimmedId);

    return reg;
  }

  /**
   * Looks up a registered Skeleton by bearer token.
   */
  getSkeletonByToken(token: string): GatewayRegisteredSkeleton | undefined {
    if (!token || typeof token !== "string") {
      return undefined;
    }
    const clean = token.replace(/^Bearer\s+/i, "").trim();
    return this.tokensToSkeleton.get(clean);
  }

  /**
   * Looks up a registered Skeleton by ID.
   */
  getSkeletonById(skeletonId: string): GatewayRegisteredSkeleton | undefined {
    return this.idsToSkeleton.get(skeletonId);
  }

  // -------------------------------------------------------------------------------------------
  // Per-run budget governor registry
  // -------------------------------------------------------------------------------------------

  /** Registers (or replaces) the budget governor consulted for every `sandbox_exec` of a run. */
  registerRunBudgetGovernor(runId: string, governor: BudgetGovernor): void {
    if (typeof runId !== "string" || runId.length === 0) {
      return;
    }
    this.runGovernors.set(runId, governor);
  }

  /** Drops a run's budget governor once the run finishes. */
  unregisterRunBudgetGovernor(runId: string): void {
    this.runGovernors.delete(runId);
  }

  /** Resolves the budget governor registered for a run, if any. */
  getRunBudgetGovernor(runId: string): BudgetGovernor | undefined {
    return this.runGovernors.get(runId);
  }

  // -------------------------------------------------------------------------------------------
  // Boundary-aware graceful stop
  // -------------------------------------------------------------------------------------------

  /**
   * Marks a run as stopping gracefully. A subsequent `sandbox_exec` for the run is refused at this
   * tool boundary WITHOUT executing a new sandbox command, so the in-flight worker turn ends cleanly.
   */
  markRunGracefulStop(runId: string): void {
    if (typeof runId !== "string" || runId.length === 0) {
      return;
    }
    this.gracefulStopRuns.add(runId);
  }

  /** Clears the graceful-stop marker for a run once it finishes. */
  clearRunGracefulStop(runId: string): void {
    this.gracefulStopRuns.delete(runId);
  }

  /**
   * Checks whether the MCP Gateway connection record shows the Skeleton connected.
   */
  isSkeletonConnected(skeletonId: string): boolean {
    return this.connectedSkeletons.has(skeletonId);
  }

  /**
   * Marks connection record active for Skeleton.
   */
  recordConnection(skeletonId: string): void {
    this.connectedSkeletons.add(skeletonId);
    const skel = this.idsToSkeleton.get(skeletonId);
    if (skel) {
      skel.lastSeenAt = Date.now();
    }
  }

  /**
   * Dispatches a tool invocation using the caller's bearer token and emits
   * "fatal" once on this gateway when the tool result is fatal (R5-B4, SB1).
   * The emit happens after the handler has produced and recorded the result
   * and before the result is returned to the caller. The payload names the
   * Skeleton and the run: { skeletonId, runId, result }, where skeletonId and
   * runId come from the mapping of the caller's bearer token to a registered
   * Skeleton and result is the result object itself, unchanged. A bearer token
   * without a Skeleton mapping emits nothing. Non-fatal results emit nothing.
   */
  async handleToolCall(
    bearerToken: string,
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    const result = await this.dispatchToolCall(bearerToken, toolName, args);

    if (isFatalToolResult(result)) {
      const skeleton = this.getSkeletonByToken(bearerToken);
      if (skeleton) {
        const payload: FatalEventPayload = {
          skeletonId: skeleton.skeletonId,
          runId: skeleton.runId,
          result,
        };
        try {
          this.emit("fatal", payload);
        } catch {
          // Subscriber errors must not change the result returned to the caller.
        }
      }
    }

    return result;
  }

  /**
   * Dispatches a tool invocation using the caller's bearer token.
   * Requirements: 19.2, 19.3, 19.4.
   */
  private async dispatchToolCall(
    bearerToken: string,
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    // 1. Authenticate bearer token (Requirement 19.2)
    const skeleton = this.getSkeletonByToken(bearerToken);
    if (!skeleton) {
      return {
        status: "refused",
        error: "Refused: missing, invalid, or unrecognized bearer token (Requirement 19.2)",
        code: "UNAUTHORIZED",
      };
    }

    this.recordConnection(skeleton.skeletonId);

    // 2. Re-check role authorization for tool on every invocation (Requirements 19.3, 19.4)
    if (!isRoleAuthorizedForTool(skeleton.role, toolName)) {
      return {
        status: "refused",
        error: `Refused: role '${skeleton.role}' is not authorized to call tool '${toolName}' (Requirements 19.3, 19.4)`,
        code: "FORBIDDEN_ROLE",
      };
    }

    const context: ToolExecutionContext = {
      skeletonId: skeleton.skeletonId,
      role: skeleton.role,
      bearerToken: skeleton.bearerToken,
      worktreeRoot: skeleton.worktreeRoot,
      runId: skeleton.runId,
      backend: skeleton.backend ?? this.options.backend,
      runbox: skeleton.runbox ?? this.options.runbox,
      auditbox: skeleton.auditbox ?? this.options.auditbox,
    };

    const execOpts: ExecutionToolsOptions = {
      approvalManager: this.approvalManager,
      logStore: this.logStore,
      eventStore: this.options.eventStore,
      onEmitEvent: this.options.onEmitEvent,
      processSweeper: this.options.processSweeper,
      defaultTimeoutMs: this.defaultTimeoutMs,
      approvalWaitMs: this.approvalWaitMs,
      backend: skeleton.backend ?? this.options.backend,
      runbox: skeleton.runbox ?? this.options.runbox,
      auditbox: skeleton.auditbox ?? this.options.auditbox,
    };

    const collabOpts: CollaborationToolsOptions = {
      onEmitEvent: this.options.onEmitEvent,
      collaborationStore: this.collaborationStore,
    };

    // 3. Dispatch to specific tool handler
    switch (toolName) {
      case "sandbox_exec": {
        // Boundary-aware graceful stop: never start a new sandbox command for a run that is
        // stopping gracefully, so the in-flight worker turn ends at this tool boundary.
        if (skeleton.runId && this.gracefulStopRuns.has(skeleton.runId)) {
          return {
            status: "refused",
            code: "GRACEFUL_STOP",
            error: "Refused: run is stopping gracefully at the next tool boundary",
          };
        }

        // Per-run budget enforcement: refuse a sandbox command once any capped dimension is crossed,
        // without executing it. The governor latches the crossing, so the run cannot silently resume.
        const governor =
          skeleton.budgetGovernor ??
          (skeleton.runId ? this.runGovernors.get(skeleton.runId) : undefined) ??
          this.options.budgetGovernor;
        if (governor) {
          const gate = governor.canDispatchSandboxExec();
          if (!gate.allowed) {
            return {
              status: "refused",
              code: "BUDGET_EXCEEDED",
              error: `Refused: budget exceeded (${gate.dimensions.join(", ")})`,
              dimensions: gate.dimensions,
            };
          }
          governor.recordToolCall(skeleton.skeletonId);
          governor.evaluate();
        }

        return handleSandboxExec(args as SandboxExecParams, context, execOpts);
      }
      case "sandbox_log":
        return handleSandboxLog(args as SandboxLogParams, context, execOpts);
      case "report_task_result":
        return handleReportTaskResult(args as ReportTaskResultParams, context, collabOpts);
      case "warden_verdict":
        return handleWardenVerdict(args as WardenVerdictParams, context, collabOpts);
      case "ask":
        return handleAsk(args as AskParams, context, collabOpts);
      case "report_blocker":
        return handleReportBlocker(args as ReportBlockerParams, context, collabOpts);
      case "propose_task":
        return handleProposeTask(args as ProposeTaskParams, context, collabOpts);
      case "ack_message":
        return handleAckMessage(args as AckMessageParams, context, collabOpts);
      default:
        return {
          status: "refused",
          error: `Refused: unknown gateway tool '${toolName}'`,
          code: "UNKNOWN_TOOL",
        };
    }
  }
}

// Global gateway instance reference (configured explicitly via setDefaultGateway)
let defaultGateway: McpGateway | null = null;

export function setDefaultGateway(gateway: McpGateway): void {
  defaultGateway = gateway;
}

export function getDefaultGateway(): McpGateway {
  if (!defaultGateway) {
    throw new ConfigurationError("Default McpGateway has not been configured with required settings");
  }
  return defaultGateway;
}

/**
 * Registers a Skeleton on the default gateway instance.
 */
export function registerSkeleton(
  opts: GatewayRegisterSkeletonOptions
): GatewayRegisteredSkeleton {
  return getDefaultGateway().registerSkeleton(opts);
}

/**
 * Checks connection status on default gateway instance.
 */
export function isSkeletonConnected(skeletonId: string): boolean {
  return getDefaultGateway().isSkeletonConnected(skeletonId);
}

/**
 * Dispatches a tool call on the default gateway instance.
 * Exported so module remains free of network listeners in tests.
 */
export async function handleToolCall(
  bearerToken: string,
  toolName: string,
  args: unknown
): Promise<unknown> {
  return getDefaultGateway().handleToolCall(bearerToken, toolName, args);
}

// SB1 (N-B6): request bodies are capped at 1 MiB; a larger body gets 413.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Creates an HTTP MCP server listening strictly on 127.0.0.1.
 * Server wiring is NOT started by default to keep the module free of network listeners in tests.
 * Requirement 19.1.
 * SB1 (N-B1): the bearer token is authenticated against the Skeleton mapping
 * before the request body is read; a request whose token has no Skeleton
 * mapping gets 401 and its body is never read.
 * SB1 (N-B6): the request body is capped at 1 MiB; a larger body gets 413.
 */
const MCP_TOOL_DEFINITIONS: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  sandbox_exec: {
    description: "Execute a command inside the isolated container sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["argv"],
      additionalProperties: true,
    },
  },
  sandbox_log: {
    description: "Read a sandbox execution log by logRef.",
    inputSchema: {
      type: "object",
      properties: {
        logRef: { type: "string" },
      },
      required: ["logRef"],
      additionalProperties: true,
    },
  },
  report_task_result: {
    description: "Report structured completion result for the current task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        summary: { type: "string" },
        status: { type: "string" },
      },
      required: ["summary"],
      additionalProperties: true,
    },
  },
  warden_verdict: {
    description: "Submit Warden verification verdict with evidence refs.",
    inputSchema: {
      type: "object",
      properties: {
        candidateSha: { type: "string" },
        approved: { type: "boolean" },
      },
      additionalProperties: true,
    },
  },
  ask: {
    description: "Ask a blocking clarification question.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
      additionalProperties: true,
    },
  },
  report_blocker: {
    description: "Report an unrecoverable blocker on the current task.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
      additionalProperties: true,
    },
  },
  propose_task: {
    description: "Propose a follow-up task when additional work is required.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        role: { type: "string" },
      },
      required: ["title"],
      additionalProperties: true,
    },
  },
  ack_message: {
    description: "Acknowledge a steered or queued message.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
      },
      additionalProperties: true,
    },
  },
};

function buildMcpToolsListForRole(role: string): Array<Record<string, unknown>> {
  const norm = normalizeRole(role);
  const allowed = norm ? ALLOWED_MCP_TOOLS_BY_ROLE[norm] : undefined;
  if (!allowed) {
    return [];
  }
  const tools: Array<Record<string, unknown>> = [];
  for (const name of allowed) {
    const meta = MCP_TOOL_DEFINITIONS[name] ?? {
      description: `Necromancer gateway tool: ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
    };
    tools.push({
      name,
      description: meta.description,
      inputSchema: meta.inputSchema,
    });
  }
  return tools;
}

export function createMcpGatewayServer(gateway?: McpGateway): http.Server {
  const gw = gateway ?? getDefaultGateway();
  const server = http.createServer(async (req, res) => {
    // Only accept connections on loopback
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::ffff:127.0.0.1" && remoteAddr !== "::1") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Access denied: gateway accepts connections only on 127.0.0.1" }));
      return;
    }

    const authHeader = req.headers["authorization"] ?? "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (req.method === "POST") {
      // SB1 (N-B1): authenticate the bearer before reading the request body.
      const skeleton = gw.getSkeletonByToken(bearerToken);
      if (!skeleton) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "Connection": "close",
        });
        res.end(
          JSON.stringify({
            error: "Unauthorized: missing, invalid, or unrecognized bearer token (Requirement 19.2)",
          })
        );
        return;
      }

      // SB1 (N-B6): reject up front when the declared Content-Length already
      // exceeds the cap, and count the bytes as they arrive otherwise.
      // RB5 (N-B15): destroy request so oversized bodies are not drained.
      const declaredLength = Number(req.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
        res.writeHead(413, {
          "Content-Type": "application/json",
          "Connection": "close",
        });
        res.end(JSON.stringify({ error: "Request body exceeds the 1 MiB limit" }));
        req.destroy();
        return;
      }

      let body = "";
      let bodyBytes = 0;
      let oversized = false;
      req.on("data", (chunk: Buffer) => {
        if (oversized) {
          return;
        }
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
          oversized = true;
          res.writeHead(413, {
            "Content-Type": "application/json",
            "Connection": "close",
          });
          res.end(JSON.stringify({ error: "Request body exceeds the 1 MiB limit" }));
          req.destroy();
          return;
        }
        body += chunk.toString("utf8");
      });

      req.on("end", async () => {
        if (oversized) {
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        try {
          if (parsed && typeof parsed === "object" && parsed.jsonrpc === "2.0") {
            const method = parsed.method;
            if (method === "notifications/initialized" || parsed.id === undefined) {
              res.writeHead(202);
              res.end();
              return;
            }
            if (method === "initialize") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: {
                    protocolVersion: parsed.params?.protocolVersion ?? "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "necromancer", version: "1.0.0" },
                  },
                })
              );
              return;
            }
            if (method === "tools/list") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: {
                    tools: buildMcpToolsListForRole(skeleton.role),
                  },
                })
              );
              return;
            }
            if (method === "tools/call") {
              const callName =
                typeof parsed.params?.name === "string" ? parsed.params.name : "";
              const callArgs = parsed.params?.arguments ?? {};
              const result = await gw.handleToolCall(bearerToken, callName, callArgs);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: {
                    content: [{ type: "text", text: JSON.stringify(result) }],
                    isError: Boolean(
                      result && (result as any).ok === false && (result as any).error
                    ),
                  },
                })
              );
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                error: { code: -32601, message: `Method not found: ${String(method)}` },
              })
            );
            return;
          }

          const toolName = parsed.tool ?? parsed.name ?? req.url?.replace(/^\//, "");
          const args = parsed.arguments ?? parsed.args ?? parsed.params ?? {};

          const result = await gw.handleToolCall(bearerToken, toolName, args);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  });

  return server;
}
