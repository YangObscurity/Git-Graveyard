// Task 13.4, 13.5: Warden review and merge gate types
// Requirements: 14.7, 24.5, 24.6, 24.7, 24.8, 24.14, 24.15, 24.16, 25.6, 25.7, 25.8

export type WardenVerdictStatus = "approve" | "reject";

export interface ReasonWithRefs {
  text: string;
  refs: string[];
}

export type WardenReason = ReasonWithRefs | string;

export interface TestCountBaseline {
  total: number;
  passed: number;
  failed?: number;
  skipped?: number;
  testFiles?: readonly string[] | string[];
  [key: string]: unknown;
}

export interface ReviewCheckResult {
  ok?: boolean;
  passed?: boolean;
  status?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  logRef?: string;
  ref?: string;
  error?: string;
  reason?: string;
  details?: unknown;
  [key: string]: unknown;
}

export interface ReviewFailureItem {
  text?: string;
  message?: string;
  ref?: string;
  [key: string]: unknown;
}

export interface ReviewFindings {
  verdict?: WardenVerdictStatus | string;
  status?: WardenVerdictStatus | string;
  target?: string;
  taskId?: string;
  candidateSha?: string;
  candidateSha256?: string;
  diff?: string;
  diffText?: string;
  tree?: string;
  reasons?: readonly WardenReason[] | WardenReason[];
  refs?: readonly string[] | string[];
  install?: ReviewCheckResult | boolean;
  build?: ReviewCheckResult | boolean;
  accept?: ReviewCheckResult | boolean;
  taskAccept?: ReviewCheckResult | boolean;
  acceptCommand?: ReviewCheckResult | boolean;
  tests?: ReviewCheckResult | boolean;
  test?: ReviewCheckResult | boolean;
  noTestWeakening?: boolean | ReviewCheckResult;
  testBaselineBefore?: TestCountBaseline;
  testBaselineAfter?: TestCountBaseline;
  failures?: readonly ReviewFailureItem[] | ReviewFailureItem[];
  errors?: readonly string[] | string[];
  warnings?: readonly string[] | string[];
  ok?: boolean;
  passed?: boolean;
  [key: string]: unknown;
}

export interface WardenVerdictRecord {
  verdict: WardenVerdictStatus;
  status: WardenVerdictStatus;
  ok: boolean;
  approved: boolean;
  target: string;
  taskId?: string;
  candidateSha: string;
  candidateSha256: string;
  diff?: string;
  diffText?: string;
  tree?: string;
  reasons: ReasonWithRefs[];
  refs: string[];
  noTestWeakening?: boolean;
  checks?: Record<string, unknown>;
  ts: number;
  allReasonsHaveRefs?: boolean;
  atLeastOneReasonHasRef?: boolean;
  requiresRerun?: boolean;
  [key: string]: unknown;
}

export interface GateResultInput {
  ok: boolean;
  gate?: string;
  kind?: string;
  reasons?: readonly string[] | string[];
  files?: readonly string[] | string[];
  tree?: string | Record<string, unknown>;
  treeSha?: string;
  [key: string]: unknown;
}

export interface MergeGateEventItem {
  kind: string;
  seq?: number;
  ts?: number;
  data?: Record<string, unknown>;
  taskId?: string;
  [key: string]: unknown;
}

export interface MergeGateOptions {
  verdict?:
    | WardenVerdictRecord
    | {
        verdict?: WardenVerdictStatus | string;
        candidateSha256?: string;
        candidateSha?: string;
        target?: string;
        tree?: string;
        reasons?: readonly WardenReason[] | WardenReason[];
        refs?: readonly string[] | string[];
        [key: string]: unknown;
      }
    | WardenVerdictStatus
    | string;
  candidate?:
    | {
        candidateSha?: string;
        candidateSha256?: string;
        diff?: string;
        diffText?: string;
        tree?: string;
        [key: string]: unknown;
      }
    | string;
  candidateSha?: string;
  candidateSha256?: string;
  expectedCandidateSha256?: string;
  diff?: string;
  diffText?: string;
  gateResult?: GateResultInput | boolean;
  expectedHeadSha?: string;
  currentHeadSha?: string;
  integrationHeadSha?: string;
  expectedIntegrationHeadSha?: string;
  tree?: string;
  gateTree?: string;
  verdictTree?: string;
  events?: readonly MergeGateEventItem[] | MergeGateEventItem[];
  taskId?: string;
  task?: {
    id: string;
    state?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MergeGateResult {
  accepted: boolean;
  ok: boolean;
  merged?: boolean;
  reason?: string;
  reasons?: string[];
  verdictApproved: boolean;
  candidateShaMatches: boolean;
  gatePassed: boolean;
  treeMatches?: boolean;
  headUnchanged?: boolean;
  eventsPreceded?: boolean;
  candidateSha?: string;
  candidateSha256?: string;
}

export interface WardenEnvironment {
  role: "warden" | "Warden" | string;
  sessionId: string;
  processId?: number | string;
  pid?: number | string;
  kiroHome: string;
  checkoutDir: string;
  boxId: string;
  boxType: "auditbox" | string;
  tools: readonly string[] | string[];
  writableHostPaths?: readonly string[] | string[];
  [key: string]: unknown;
}

export interface BuilderEnvironment {
  role: string;
  sessionId: string;
  processId?: number | string;
  pid?: number | string;
  kiroHome: string;
  checkoutDir: string;
  worktreeDir?: string;
  boxId: string;
  boxType: "runbox" | string;
  tools: readonly string[] | string[];
  writableHostPaths?: readonly string[] | string[];
  [key: string]: unknown;
}

export interface WardenIsolationResult {
  isolated: boolean;
  violations: string[];
}
