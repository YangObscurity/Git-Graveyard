// Task 10: MCP Gateway, Command Policy, and Tool Handlers
// Requirements: 19.1-19.19, 20.1-20.14, 29.10-29.12

import type { ExecutionBackend, Sandbox } from "../backend/types";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type CommandClassification = "allowed" | "needs_approval" | "blocked";

export interface CommandClassificationResult {
  classification: CommandClassification;
  reason?: string;
  matchedRule?: string;
  argv: string[];
}

export interface CommandPolicyOptions {
  cwd?: string;
  worktreeRoot?: string;
  egressAllowlist?: readonly string[];
  policy?: CommandPolicyData;
}

export interface AllowedCommandRule {
  id: string;
  name: string;
  argvPrefix?: string[];
  description?: string;
  binaries?: string[];
  flags?: string[];
}

export interface HardBlockRule {
  id: string;
  name: string;
  description: string;
  keywords: string[];
}

export interface CommandPolicyData {
  version: string;
  name: string;
  description: string;
  egressAllowlist: string[];
  allowedCommands: AllowedCommandRule[];
  hardBlockRules: HardBlockRule[];
  defaultClassification: "needs_approval";
}

export interface AdminPolicyView {
  version: string;
  name: string;
  summary: string;
  egressAllowlist: readonly string[];
  allowedCount: number;
  hardBlockCount: number;
  policy: CommandPolicyData;
}

export interface RegisteredSkeleton {
  skeletonId: string;
  bearerToken: string;
  role: string;
  worktreeRoot?: string;
  runId?: string;
  createdAt: number;
  lastSeenAt?: number;
  backend?: ExecutionBackend;
  runbox?: Sandbox;
  auditbox?: Sandbox;
}

export interface RegisterSkeletonOptions {
  skeletonId: string;
  role: string;
  worktreeRoot?: string;
  runId?: string;
  bearerToken?: string;
  backend?: ExecutionBackend;
  runbox?: Sandbox;
  auditbox?: Sandbox;
}

export interface ApprovalGrant {
  approvalId: string;
  skeletonId: string;
  argvSha256: string;
  cwd: string;
  expiresAt: number;
  used: boolean;
  createdAt: number;
}

export interface ApprovalRequest {
  approvalId: string;
  skeletonId: string;
  runId: string;
  argv: string[];
  cwd: string;
  expiresAt: number;
  status: "approval_pending" | "approved" | "denied";
  createdAt: number;
  resolvedAt?: number;
  deniedReason?: string;
  instruction?: string;
}

export interface SandboxExecParams {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  runId?: string;
  approvalId?: string;
  approvalTtlMs?: number;
  files?: unknown;
}

export interface SandboxExecBlockedResult {
  status: "blocked";
  reason: string;
}

export interface SandboxExecApprovalPendingResult {
  status: "approval_pending";
  approvalId: string;
  expiresAt: number;
}

export interface RefusalFinding {
  path: string;
  ruleId: string;
  fingerprint: string;
}

export type SandboxExecRefusalCode =
  | "PATH_ESCAPE"
  | "SECRET_DETECTED"
  | "ESCAPING_SYMLINK"
  | "INVALID_PARAMS"
  | "WORKTREE_ROOT_REQUIRED"
  | "INVALID_ARGV"
  | "RUN_ID_REQUIRED"
  | "INVALID_TIMEOUT"
  | "CWD_OUTSIDE_WORKTREE"
  | "NO_SANDBOX_AVAILABLE"
  | (string & {});

export interface SandboxExecRefusedResult {
  status: "refused";
  error: string;
  code?: SandboxExecRefusalCode;
  findings?: RefusalFinding[];
}

export interface SandboxExecRunningResult {
  status: "running";
  log_ref: string;
}

export interface SandboxExecCompletedResult {
  status: "completed";
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
  truncated: boolean;
  log_ref: string;
}

export interface SandboxExecFatalResult {
  status: "fatal";
  error: string;
  code?: string;
  quarantine?: boolean;
  fatal?: boolean;
  reason?: string;
  findings?: unknown;
}

export type SandboxExecResult =
  | SandboxExecBlockedResult
  | SandboxExecApprovalPendingResult
  | SandboxExecRefusedResult
  | SandboxExecRunningResult
  | SandboxExecCompletedResult
  | SandboxExecFatalResult;

export interface SandboxLogParams {
  log_ref: string;
  offset?: number;
  limit?: number;
}

export interface SandboxLogResult {
  log_ref: string;
  slice: string;
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  exit_code?: number | null;
  status?: string;
  error?: string;
  code?: string;
}

export interface ReportTaskResultParams {
  taskId: string;
  status: string;
  summary: string;
  refs?: string[];
}

export interface ReportTaskResultResult {
  success: boolean;
  taskId: string;
  status: string;
  summary: string;
  refs?: string[];
}

export interface ReasonWithRefs {
  text: string;
  refs: string[];
}

export interface WardenVerdictParams {
  target: string;
  verdict: "approve" | "reject";
  reasons: ReasonWithRefs[];
  candidateSha256: string;
}

export interface WardenVerdictResult {
  success: boolean;
  target: string;
  verdict: "approve" | "reject";
  candidateSha256: string;
}

export interface AskParams {
  question: string;
  [key: string]: unknown;
}

export interface AskResult {
  message: string;
  recorded: boolean;
  question: string;
  askId?: string;
}

export interface QueuedAsk {
  askId: string;
  question: string;
  skeletonId: string;
  role: string;
  runId?: string;
  status: "queued" | "answered" | "delivered";
  createdAt: number;
  answeredAt?: number;
  answer?: string;
  deliveryMethod?: "steer" | "prompt";
}

export interface TaskProposal {
  proposalId: string;
  title: string;
  description?: string;
  skeletonId: string;
  role: string;
  runId?: string;
  status: "pending_confirmation" | "confirmed" | "rejected";
  createdAt: number;
  resolvedAt?: number;
  resolutionReason?: string;
}

export interface ReportedBlocker {
  blockerId: string;
  text: string;
  kind: string;
  skeletonId: string;
  role: string;
  runId?: string;
  status: "reported" | "mitigated";
  createdAt: number;
  mitigatedAt?: number;
  mitigationAction?: string;
}

export interface TypedTaskResult {
  taskId: string;
  status: string;
  summary: string;
  refs: string[];
  skeletonId: string;
  role: string;
  runId?: string;
  recordedAt: number;
}

export interface AcknowledgedMessage {
  msgId: string;
  skeletonId: string;
  role: string;
  runId?: string;
  acknowledgedAt: number;
}

export interface WardenVerdictRecord {
  target: string;
  verdict: "approve" | "reject";
  candidateSha256: string;
  reasons: ReasonWithRefs[];
  refs: string[];
  skeletonId: string;
  runId?: string;
  recordedAt: number;
}

export interface ReportBlockerParams {
  text: string;
  kind: string;
  [key: string]: unknown;
}

export interface ReportBlockerResult {
  recorded: boolean;
  text: string;
  kind: string;
  blockerId?: string;
}

export interface ProposeTaskParams {
  title: string;
  description?: string;
  [key: string]: unknown;
}

export interface ProposeTaskResult {
  recorded: boolean;
  proposalId: string;
  title: string;
  description?: string;
  status?: string;
}

export interface AckMessageParams {
  msgId: string;
}

export interface AckMessageResult {
  acknowledged: boolean;
  msgId: string;
}

export interface ToolExecutionContext {
  skeletonId: string;
  role: string;
  bearerToken: string;
  worktreeRoot?: string;
  runId?: string;
  backend?: ExecutionBackend;
  runbox?: Sandbox;
  auditbox?: Sandbox;
}
