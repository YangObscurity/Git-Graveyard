// Task 9.3, 9.4, 9.5: SkeletonSupervisor Types
// Requirements: 14.1-14.4, 15.1-15.8, 16.1-16.21

import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { AllowedModelId, ModelTier, SkeletonRole } from "./model-allowlist";
import type {
  AcpPermissionBrokerAdapter,
  PermissionBroker,
  PermissionBrokerOptions,
  PermissionBrokerRequest,
  RequestPermissionResponse,
} from "../broker/permission-broker";
import type { BudgetCapLimits } from "./budget-caps";

export type { AllowedModelId, ModelTier, SkeletonRole };

/**
 * Minimal interface representing a child process for ACP communication.
 * Compatible with ChildProcess from node:child_process.
 */
export interface ChildProcessLike extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | string | null;
  kill(signal?: NodeJS.Signals | number | string): boolean;
}

/**
 * Payload the gateway emits with a "fatal" event: the fatal result belongs to
 * the Skeleton named by skeletonId (audit N-B1).
 */
export interface GatewayFatalEventPayload {
  skeletonId: string;
  runId: string;
  result?: unknown;
}

/**
 * Gateway event source the supervisor subscribes to. Typed with on and off so
 * the fatal listener can be removed when the Skeleton finishes or is
 * terminated (audit N-B1).
 */
export interface GatewayEventSource {
  on(event: string, listener: (payload: GatewayFatalEventPayload) => void): unknown;
  off(event: string, listener: (payload: GatewayFatalEventPayload) => void): unknown;
}

/**
 * Options passed to the process spawn function.
 */
export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  uid?: number | string;
  user?: string;
  stdio?: any;
  detached?: boolean;
  [key: string]: unknown;
}

/**
 * Injectable function signature for spawning processes.
 */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcessLike;

/**
 * Policy preset types defined in Requirements 14.18 and 16.8.
 */
export type PolicyPreset = "edit-workspace" | "read-workspace" | string;

/**
 * MCP Server entry structure in session/new.
 */
export interface McpServerConfig {
  id: string;
  name?: string;
  transport: "http" | "stdio" | string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Array<{ name: string; value: string }>;
  [key: string]: unknown;
}

/**
 * Metadata passed under _meta.kiro in session/new.
 */
export interface KiroSessionMeta {
  modeId: string;
  modelId: string;
  policyPreset: PolicyPreset;
  effortLevel?: string;
  rules?: unknown[];
  allowRules?: unknown[];
  manifestAllowRule?: unknown;
  [key: string]: unknown;
}

/**
 * Parameters for session/new request.
 */
export interface SessionNewParams {
  cwd: string;
  mcpServers: McpServerConfig[];
  _meta: {
    kiro: KiroSessionMeta;
    [key: string]: unknown;
  };
  additionalDirectories?: string[];
  [key: string]: unknown;
}

/**
 * Parameters for session/load request.
 */
export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
  _meta: {
    kiro: KiroSessionMeta;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Advertised capabilities returned by initialize request.
 */
export interface AcpCapabilities {
  agentCapabilities?: {
    _meta?: {
      kiro?: {
        extensionMethods?: string[];
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  extensionMethods?: string[];
  mcpCapabilities?: {
    http?: boolean;
    stdio?: boolean;
    [key: string]: unknown;
  };
  authMethods?: unknown[];
  loginRequired?: boolean;
  authRequired?: boolean;
  [key: string]: unknown;
}

/**
 * Event data emitted when a Skeleton is successfully raised and verified.
 * Requirement 15.8.
 */
export interface SkeletonRaisedEvent {
  kind: "skeleton.raised";
  runId: string;
  skeletonId: string;
  role: string;
  sessionId: string;
  modelId: AllowedModelId | string;
  agent: string;
  actor: "SkeletonSupervisor";
  refs: string[];
}

/**
 * Standard reasons for Skeleton failure.
 */
export type SupervisorFailureReason =
  | "auth_failed"
  | "model_mismatch"
  | "mode_mismatch"
  | "gateway_missing"
  | "spawn_failed"
  | "unexpected_exit"
  | "timeout"
  | "cancelled"
  | string;

/**
 * Event data emitted when a Skeleton fails.
 */
export interface SkeletonFailedEvent {
  kind: "skeleton.failed";
  runId: string;
  skeletonId: string;
  role: string;
  reason: SupervisorFailureReason;
  error: string;
  actor: "SkeletonSupervisor";
  refs: string[];
}

export type SkeletonSupervisorEvent = SkeletonRaisedEvent | SkeletonFailedEvent;

/**
 * Configuration options for the SkeletonSupervisor.
 */
export interface SkeletonSupervisorOptions {
  runId: string;
  skeletonId: string;
  role: SkeletonRole | string;
  cwd: string;
  /**
   * Directory outside the worktree where quarantine records are written.
   * Required at runtime: the supervisor refuses to start without it (audit N-5).
   */
  quarantineDir?: string;
  homeDir?: string;
  kiroHomeDir?: string;
  kiroApiKey?: string;
  pathEnv?: string;
  user?: string;
  command?: string;
  args?: string[];
  spawnFn?: SpawnFunction;
  spawn?: SpawnFunction;
  brokerOptions?: PermissionBrokerOptions;
  watchdogLimitMs?: number;
  settings?: Record<string, unknown>;
  gatewayUrl?: string;
  bearerToken?: string;
  mcpServers?: McpServerConfig[];
  additionalDirectories?: string[];
  snapshotDir?: string;
  readOnlySnapshotDir?: string;
  hard?: boolean | string | null;
  checkMcpGateway?: boolean;
  isGatewayConnected?: () => Promise<boolean> | boolean;
  cancelGracePeriodMs?: number;
  timeoutLimitMs?: number;
  cancelPromptTimeoutMs?: number;
  onEvent?: (event: SkeletonSupervisorEvent) => void | Promise<void>;
  onUpdate?: (update: unknown) => void | Promise<void>;
  onLog?: (stream: string, text: string) => void | Promise<void>;
  onRequestPermission?: (
    request: PermissionBrokerRequest
  ) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
  archiveSessionsOnFinish?: boolean;
  deleteKiroHomeOnFinish?: boolean;
  evidenceDir?: string;
  autoFinishOnTypedResult?: boolean;
  baseDir?: string;
  channel?: "ACP_V3" | "Headless_Fallback" | "acp" | "headless";
  probeResults?: Record<string, any>;
  onAdmissionHalt?: (reason: string) => void | Promise<void>;
  /**
   * Gateway event source emitting "fatal" with a GatewayFatalEventPayload that
   * names the target Skeleton (audit N-B1). The supervisor subscribes once and
   * removes its listener when the Skeleton finishes or is terminated.
   */
  gateway?: GatewayEventSource;
  gatewayToolIds?: string[];
  eventTap?: any;
  budgetGovernor?: any;
  /**
   * Caps enforced in code (probe P5): wall clock and tool calls, plus credits when
   * the stream reports them. The supervisor cancels the session on the first cap.
   */
  budgetCaps?: BudgetCapLimits;
  acpWireFormat?: "legacy" | "acp-v1";
  taskId?: string;
  distributeSse?: (event: any) => void | Promise<void>;
}

/**
 * Options for dispatching structured task prompt.
 * Requirement 16.21.
 */
export interface TaskPromptOptions {
  taskText: string;
  deathCertificateRows?: string | string[] | readonly unknown[];
  grimoireGuidance?: string | string[] | readonly string[];
  [key: string]: unknown;
}

/**
 * Options for archiving Skeleton sessions on finish.
 * Requirement 16.15.
 */
export interface ArchiveSessionsOptions {
  sessionsDir: string;
  runId: string;
  skeletonId: string;
  evidenceDir?: string;
  baseDir?: string;
}

export type ExecutionChannel = "ACP_V3" | "Headless_Fallback";

/**
 * Skeleton operational states.
 */
export type SupervisorState =
  | "uninitialized"
  | "spawning"
  | "initializing"
  | "raised"
  | "prompting"
  | "cancelling"
  | "failed"
  | "terminated";
