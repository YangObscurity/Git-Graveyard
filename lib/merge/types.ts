// Task 13.4: Merge rule types and interfaces
// Requirements: 9.12, 25.6, 25.7, 25.8

export type MergeVerdictStatus = "approve" | "reject" | string;

export interface ReasonWithRefs {
  text: string;
  refs?: string[];
  [key: string]: unknown;
}

export type MergeReason = ReasonWithRefs | string;

export interface CandidateInfo {
  sha?: string;
  candidateSha?: string;
  sha256?: string;
  candidateSha256?: string;
  tree?: string;
  treeSha?: string;
  diff?: string;
  diffText?: string;
  [key: string]: unknown;
}

export interface TaskInput {
  id?: string;
  taskId?: string;
  candidate?: CandidateInfo | string;
  candidateSha?: string;
  candidateSha256?: string;
  sha?: string;
  sha256?: string;
  tree?: string;
  treeSha?: string;
  candidateTree?: string;
  diff?: string;
  diffText?: string;
  state?: string;
  [key: string]: unknown;
}

export interface VerdictInput {
  verdict?: MergeVerdictStatus;
  status?: MergeVerdictStatus;
  ok?: boolean;
  approved?: boolean;
  candidateSha?: string;
  candidateSha256?: string;
  sha?: string;
  sha256?: string;
  target?: string;
  taskId?: string;
  tree?: string;
  treeSha?: string;
  candidateTree?: string;
  reasons?: readonly MergeReason[] | MergeReason[];
  refs?: readonly string[] | string[];
  [key: string]: unknown;
}

export interface GateResultInput {
  ok?: boolean;
  passed?: boolean;
  status?: string;
  gate?: string;
  kind?: string;
  tree?: string | Record<string, unknown>;
  treeSha?: string;
  candidateTree?: string;
  files?: readonly string[];
  reasons?: readonly string[];
  data?: {
    tree?: string;
    ok?: boolean;
    [key: string]: unknown;
  };
  result?: {
    tree?: string;
    ok?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MergeRuleOptions {
  task?: TaskInput | string;
  candidate?: CandidateInfo | string;
  verdict?: VerdictInput | string;
  gateResult?: GateResultInput | boolean;
  candidateSha?: string;
  candidateSha256?: string;
  expectedCandidateSha256?: string;
  diff?: string;
  diffText?: string;
  tree?: string;
  gateTree?: string;
  verdictTree?: string;
  expectedHeadSha?: string;
  currentHeadSha?: string;
  integrationHeadSha?: string;
  expectedIntegrationHeadSha?: string;
  events?: readonly unknown[];
  [key: string]: unknown;
}

export type MergeStatus = "merged" | "not_merged";

export interface MergeRuleResult {
  merged: boolean;
  status: MergeStatus;
  ok: boolean;
  accepted: boolean;
  reason?: string;
  reasons: string[];
  verdictApproved: boolean;
  candidateShaMatches: boolean;
  gatePassed: boolean;
  treeMatches: boolean;
  headUnchanged: boolean;
  candidateSha?: string;
  candidateSha256?: string;
  taskId?: string;
}
