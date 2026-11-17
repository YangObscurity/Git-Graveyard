// Task 13.2: Scheduler types and interfaces
// Requirements: 13.8, 13.9, 13.10, 23.1, 23.2, 23.3, 23.4, 23.5, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14, 23.15

import type { EventEnvelope } from "../events/types";
import type { PactRole, PactTask, RuleId } from "../pact/pact-parser";
import type { AllowedModelId, ModelTier } from "../agents/model-allowlist";
import type {
  GateResultInput,
  MergeGateOptions,
  WardenVerdictRecord,
  WardenVerdictStatus,
} from "../warden/types";

export type TaskState =
  | "pending"
  | "ready"
  | "running"
  | "in_review"
  | "rejected"
  | "merged"
  | "failed"
  | "abandoned"
  | "skipped"
  | "blocked";

/**
 * Task state machine transition whitelist from design.md (Requirement 23.2, 25.6, 25.7, 25.8).
 * Only transitions permitted by the state machine in design.md are accepted.
 */
export const VALID_TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["ready", "blocked", "skipped"],
  ready: ["running", "failed", "abandoned", "skipped"],
  running: ["in_review", "failed", "abandoned"],
  in_review: ["merged", "rejected"],
  rejected: ["running", "ready", "failed"],
  blocked: ["ready", "skipped"],
  merged: [],
  failed: [],
  abandoned: [],
  skipped: [],
};

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  "merged",
  "failed",
  "abandoned",
  "skipped",
] as const;

export const OPEN_TASK_STATES: readonly TaskState[] = [
  "pending",
  "ready",
  "running",
  "in_review",
  "rejected",
  "blocked",
] as const;

export interface ScheduledTask {
  id: string;
  title: string;
  role: PactRole;
  state: TaskState;
  previousState?: TaskState;
  dependencies: string[];
  dependents: string[];
  files: string[];
  filesInScope: string[];
  acceptanceCommand: string;
  accept: string;
  hard: boolean;
  hardRaw: "yes" | "no";
  rules: RuleId[];
  ruleIds: RuleId[];
  attempts: number;
  maxAttempts: number;
  order: number;
  line: number;
  modelTier: AllowedModelId;
  modelTierName: ModelTier;
  blockedBy?: string[];
  rejectionReason?: string;
  raw?: PactTask;
}

export type AskOption = "re-plan" | "skip" | "stop" | string;

export interface SchedulerAsk {
  askId: string;
  taskId: string;
  blockedByTaskId?: string;
  question: string;
  options: AskOption[];
  ts: number;
  resolved: boolean;
  resolution?: string;
  reason?: string;
}

export type EmitFunction = (event: EventEnvelope) => void | Promise<void>;

export interface ConcurrencyCaps {
  runParallelCap?: number;
  globalSkeletonLimit?: number;
  runningMax?: number;
}

export interface SlotStatus {
  runParallelCap: number;
  globalSkeletonLimit: number;
  runningMax: number;
  effectiveLimit: number;
  liveCount: number;
  availableSlots: number;
}

export interface SchedulerSummary {
  total: number;
  pending: number;
  ready: number;
  running: number;
  inReview: number;
  rejected: number;
  merged: number;
  failed: number;
  abandoned: number;
  skipped: number;
  blocked: number;
  allTerminal: boolean;
  stopRequested: boolean;
  budgetExceeded: boolean;
  liveCount: number;
  availableSlots: number;
  concurrencyLimit: number;
}

export interface RejectTaskOptions {
  reason?: string;
  retry?: boolean;
}

export interface GitMergeProof {
  candidateSha: string;
  integrationHeadSha: string;
  ancestorVerified: boolean;
}

export type TaskMergeEvidence =
  | (MergeGateOptions & { gitMerge?: GitMergeProof })
  | {
      verdict?: WardenVerdictRecord | WardenVerdictStatus | string | Record<string, unknown>;
      candidateSha?: string;
      candidateSha256?: string;
      expectedCandidateSha256?: string;
      diff?: string;
      diffText?: string;
      gateResult?: GateResultInput | boolean | Record<string, unknown>;
      tree?: string;
      gateTree?: string;
      verdictTree?: string;
      expectedHeadSha?: string;
      currentHeadSha?: string;
      integrationHeadSha?: string;
      expectedIntegrationHeadSha?: string;
      taskId?: string;
      gitMerge?: GitMergeProof;
      [key: string]: unknown;
    };

export interface MergeTaskResult {
  ok: boolean;
  merged: boolean;
  task: ScheduledTask;
  reasons: string[];
  reason?: string;
  emissionPromise?: Promise<void>;
  emissionSettledPromise?: Promise<{ ok: boolean; error?: unknown }>;
}

export interface SchedulerOptions {
  pact?: string | PactTask[] | { tasks: PactTask[] };
  tasks?: PactTask[];
  approvedTaskIds?: string[] | Set<string> | readonly string[];
  pactApproved?: boolean;
  pactVersion?: number;
  runParallelCap?: number;
  globalSkeletonLimit?: number;
  runningMax?: number;
  maxAttempts?: number;
  runId?: string;
  actor?: string;
  emit?: EmitFunction;
  now?: () => number;
}
