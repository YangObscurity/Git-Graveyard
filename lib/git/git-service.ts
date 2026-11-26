import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { candidateSha256FromDiff } from "../merge/candidate-hash";
import type { GateResultInput } from "../merge/types";
import { isCheckPassing, validateWardenVerdict } from "../warden/warden-review";

export const GIT_HOOKS_FLAG = "core.hooksPath=/dev/null";
export const GIT_FSMONITOR_FLAG = "core.fsmonitor=false";
export const GIT_PROTOCOL_ALLOW_FLAG = "protocol.allow=never";
export const GIT_ISOLATION_FLAGS: readonly string[] = [
  "-c",
  GIT_HOOKS_FLAG,
  "-c",
  GIT_FSMONITOR_FLAG,
  "-c",
  GIT_PROTOCOL_ALLOW_FLAG,
];

export class RepoSizeExceededError extends Error {
  readonly ok = false as const;
  readonly code = "TOO_LARGE" as const;
  readonly size: number;
  readonly cap: number;
  readonly reason: string;

  constructor(size: number, cap: number, message?: string) {
    const reason =
      message ??
      `Repository size (${size} KB) exceeds repository size cap (${cap} KB). Refusing to clone.`;
    super(reason);
    this.name = "RepoSizeExceededError";
    this.size = size;
    this.cap = cap;
    this.reason = reason;
    Object.setPrototypeOf(this, RepoSizeExceededError.prototype);
  }
}

export class GitServiceError extends Error {
  readonly ok = false as const;
  readonly code: string;
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(
    message: string,
    code = "GIT_ERROR",
    exitCode?: number,
    stderr?: string
  ) {
    super(message);
    this.name = "GitServiceError";
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
    Object.setPrototypeOf(this, GitServiceError.prototype);
  }
}

export class WorktreeNotFoundError extends GitServiceError {
  constructor(
    message = "Worktree directory is missing or not a valid worktree"
  ) {
    super(message, "WORKTREE_NOT_FOUND");
    this.name = "WorktreeNotFoundError";
    Object.setPrototypeOf(this, WorktreeNotFoundError.prototype);
  }
}
export { WorktreeNotFoundError as MissingWorktreeError };

export const SHA1_REGEX = /^[0-9a-f]{40}$/;
export const REF_NAME_REGEX =
  /^(?:HEAD|refs\/(?:heads|tags|remotes)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)*)(?:~[0-9]+|\^+[0-9]*)*$/;

export function isValidSha1(sha: unknown): boolean {
  return typeof sha === "string" && SHA1_REGEX.test(sha.trim());
}

export function isValidRevision(rev: unknown): boolean {
  if (typeof rev !== "string") {
    return false;
  }
  const trimmed = rev.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    return false;
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("@{") ||
    trimmed.includes("//") ||
    trimmed.includes(":") ||
    trimmed.includes("\\") ||
    trimmed.includes(" ") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".lock")
  ) {
    return false;
  }
  const basePart = trimmed.replace(/(?:~[0-9]+|\^+[0-9]*)+$/, "");
  const segments = basePart.split("/");
  for (const seg of segments) {
    if (seg.startsWith(".") || seg.startsWith("-") || !seg) {
      return false;
    }
  }
  return SHA1_REGEX.test(trimmed) || REF_NAME_REGEX.test(trimmed);
}

export function assertValidRevision(rev: unknown, name = "revision"): string {
  if (typeof rev !== "string" || !rev.trim()) {
    throw new GitServiceError(
      `Invalid ${name}: revision argument is required`,
      "INVALID_REVISION"
    );
  }
  const trimmed = rev.trim();
  if (trimmed.startsWith("-")) {
    throw new GitServiceError(
      `Invalid ${name} '${trimmed}': revision must not begin with a dash`,
      "INVALID_REVISION"
    );
  }
  if (!isValidRevision(trimmed)) {
    throw new GitServiceError(
      `Invalid ${name} '${trimmed}': must be a 40-character hex SHA or match strict ref pattern`,
      "INVALID_REVISION"
    );
  }
  return trimmed;
}

export const SEGMENT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function isValidSegmentId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.includes("..")) return false;
  return SEGMENT_ID_REGEX.test(trimmed);
}

export function assertValidSegmentId(id: unknown, name = "id"): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new GitServiceError(
      `Invalid ${name}: argument is required`,
      "INVALID_ARGUMENT"
    );
  }
  const trimmed = id.trim();
  if (trimmed.startsWith("-")) {
    throw new GitServiceError(
      `Invalid ${name} '${trimmed}': must not begin with a dash`,
      "INVALID_ARGUMENT"
    );
  }
  if (trimmed.startsWith(".")) {
    throw new GitServiceError(
      `Invalid ${name} '${trimmed}': must not begin with a dot`,
      "INVALID_ARGUMENT"
    );
  }
  if (trimmed.includes("..") || !SEGMENT_ID_REGEX.test(trimmed)) {
    throw new GitServiceError(
      `Invalid ${name} '${trimmed}': must match strict identifier pattern`,
      "INVALID_ARGUMENT"
    );
  }
  return trimmed;
}

export interface RepoMetadataWithSize {
  size?: number;
  sizeInKb?: number;
  size_kb?: number;
  full_name?: string;
  fullName?: string;
  default_branch?: string;
  defaultBranch?: string;
  [key: string]: unknown;
}

export interface SizeCheckResult {
  ok: boolean;
  size?: number;
  cap?: number;
  reason?: string;
}

export interface GitExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  timeout?: number;
  maxBuffer?: number;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitExecFileFunction = (
  file: string,
  args: string[],
  options: childProcess.ExecFileOptions,
  callback: (
    error: childProcess.ExecFileException | null,
    stdout: string | Buffer,
    stderr: string | Buffer
  ) => void
) => void;

export type ForkCheckerFn = (
  target: string,
  targetUrl?: string
) => Promise<string | null | undefined> | string | null | undefined;

export interface ForkCheckerObj {
  getParent?: (
    target: string,
    targetUrl?: string
  ) => Promise<string | null | undefined> | string | null | undefined;
  checkFork?: (
    target: string,
    targetUrl?: string
  ) => Promise<string | null | undefined> | string | null | undefined;
}

export type ForkChecker = ForkCheckerFn | ForkCheckerObj;

export interface GitServiceOptions {
  repositorySizeCap?: number;
  repoSizeCap?: number;
  maxSizeKb?: number;
  runsDir?: string;
  gitBinary?: string;
  execFileFn?: GitExecFileFunction;
  githubToken?: string;
  githubWriteToken?: string;
  ownerLogin?: string;
  sourceRepoUrl?: string;
  forkRepoUrl?: string;
  forkChecker?: ForkChecker;
  checker?: ForkChecker;
}

export interface CloneBaseOptions {
  runId?: string;
  runDir?: string;
  repoUrl: string;
  baseSha: string;
  gitDir?: string;
  worktreeDir?: string;
  metadata?: RepoMetadataWithSize | number;
  size?: number;
  repositorySizeCap?: number;
  repoSizeCap?: number;
  sizeCap?: number;
}

export interface BaseWorktreeResult {
  gitDir: string;
  worktreeDir: string;
  baseSha: string;
}

export interface CreateIntegrationHeadOptions {
  runId: string;
  baseSha?: string;
  gitDir?: string;
  runDir?: string;
}

export interface IntegrationHeadResult {
  branch: string;
  sha: string;
  gitDir: string;
}

export interface CreateTaskWorktreeOptions {
  runId: string;
  taskId: string;
  gitDir?: string;
  runDir?: string;
  worktreeDir?: string;
  baseBranch?: string;
}

export interface TaskWorktreeResult {
  runId: string;
  taskId: string;
  branch: string;
  worktreeDir: string;
  gitDir: string;
  cleanup: () => Promise<void>;
}

export interface RemoveTaskWorktreeOptions {
  runId?: string;
  taskId?: string;
  gitDir?: string;
  runDir?: string;
  worktreeDir?: string;
}

export interface RebaseTaskOptions {
  runId: string;
  taskId?: string;
  gitDir?: string;
  runDir?: string;
  worktreeDir?: string;
  integrationBranch?: string;
  taskBranch?: string;
}

export interface RebaseResult {
  ok: boolean;
  conflict: boolean;
  candidateSha?: string;
  candidateSha256?: string;
  conflictedFiles?: string[];
  requiresConflictChoice?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface MergeCandidateOptions {
  runId: string;
  candidateSha: string;
  expectedIntegrationHeadSha: string;
  candidateSha256?: string;
  verdict?: string | Record<string, unknown>;
  verdictCandidateSha256?: string;
  gateResult?: GateResultInput | boolean | unknown;
  gate?: GateResultInput | boolean | unknown;
  gitDir?: string;
  runDir?: string;
  integrationBranch?: string;
  baseSha?: string;
  integrationBaseSha?: string;
  integrationBase?: string;
}

export interface MergeCandidateResult {
  ok: boolean;
  merged: boolean;
  newHeadSha?: string;
  previousHeadSha?: string;
  reason?: string;
}

// Module-private construction token: only this module holds the value, so a
// VerifiedMerge instance is proof that the merge ran through this module's
// verified gate-evidence path.
const verifiedMergeToken = Symbol("git-service.verified-merge.token");

const verifiedMergeInstances = new WeakSet<VerifiedMerge>();

export interface VerifiedMergeProof {
  runId: string;
  branch: string;
  candidateSha: string;
  candidateSha256: string;
  newHeadSha: string;
  previousHeadSha: string;
}

export class VerifiedMerge implements MergeCandidateResult {
  readonly ok = true as const;
  readonly merged = true as const;
  readonly runId: string;
  readonly branch: string;
  readonly candidateSha: string;
  readonly candidateSha256: string;
  readonly newHeadSha: string;
  readonly previousHeadSha: string;

  constructor(token: typeof verifiedMergeToken, proof: VerifiedMergeProof) {
    if (token !== verifiedMergeToken) {
      throw new GitServiceError(
        "VerifiedMerge cannot be constructed outside the git-service module",
        "VERIFIED_MERGE_CONSTRUCTION_PROHIBITED"
      );
    }
    this.runId = proof.runId;
    this.branch = proof.branch;
    this.candidateSha = proof.candidateSha;
    this.candidateSha256 = proof.candidateSha256;
    this.newHeadSha = proof.newHeadSha;
    this.previousHeadSha = proof.previousHeadSha;

    Object.freeze(this);
    verifiedMergeInstances.add(this);
  }
}

export function isVerifiedMerge(value: unknown): value is VerifiedMerge {
  return (
    typeof value === "object" &&
    value !== null &&
    verifiedMergeInstances.has(value as VerifiedMerge)
  );
}

export interface CandidateDiffOptions {
  fromRef?: string;
  toRef?: string;
  baseSha?: string;
  candidateSha?: string;
  gitDir?: string;
  runDir?: string;
  runId?: string;
}

export interface CandidateDiffResult {
  patch: string;
  files: string[];
  fromRef: string;
  toRef: string;
  sha256: string;
  byteSize: number;
}

export interface ExportAllPatchOptions {
  runId: string;
  baseSha: string;
  gitDir?: string;
  runDir?: string;
  outputPath?: string;
  integrationBranch?: string;
}

export interface ExportAllPatchResult {
  patch: string;
  sha256: string;
  byteSize: number;
  outputPath?: string;
}

export interface PushToForkOptions {
  runId?: string;
  gitDir?: string;
  runDir?: string;
  forkRemoteUrl?: string;
  targetRepoUrl?: string;
  sourceRepoUrl?: string;
  ownerLogin?: string;
  forkChecker?: ForkChecker;
  checker?: ForkChecker;
  checkFork?: ForkChecker;
  invitePushFlag?: boolean;
  runPhase?: string;
  token?: string;
  branchName?: string;
}

export interface PushToForkResult {
  ok: true;
  runId: string;
  branch: string;
  targetRepoUrl: string;
  commitSha: string;
  stdout?: string;
  stderr?: string;
}

export function extractRepoSize(input: unknown): number | undefined {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : undefined;
  }
  if (typeof input === "string") {
    const parsed = parseInt(input, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.size === "number") return obj.size;
    if (typeof obj.sizeInKb === "number") return obj.sizeInKb;
    if (typeof obj.size_kb === "number") return obj.size_kb;
    if (typeof obj.size === "string") {
      const p = parseInt(obj.size, 10);
      if (Number.isFinite(p)) return p;
    }
    if (typeof obj.data === "object" && obj.data !== null) {
      return extractRepoSize(obj.data);
    }
  }
  return undefined;
}

export function checkRepoSize(
  sizeOrMetadata: number | RepoMetadataWithSize | unknown,
  cap?: number
): SizeCheckResult {
  const size = extractRepoSize(sizeOrMetadata);
  if (cap === undefined || !Number.isFinite(cap)) {
    return { ok: true, size, cap };
  }
  if (size === undefined) {
    return { ok: true, size: undefined, cap };
  }
  if (size > cap) {
    return {
      ok: false,
      size,
      cap,
      reason: `Repository size (${size} KB) exceeds repository size cap (${cap} KB). Refusing to clone.`,
    };
  }
  return { ok: true, size, cap };
}

export function assertRepoSizeWithinCap(
  sizeOrMetadata: number | RepoMetadataWithSize | unknown,
  cap?: number
): void {
  const result = checkRepoSize(sizeOrMetadata, cap);
  if (!result.ok) {
    throw new RepoSizeExceededError(
      result.size ?? 0,
      result.cap ?? 0,
      result.reason
    );
  }
}

export function computeSha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function getIntegrationBranchName(runId: string): string {
  return `graveyard/${runId}`;
}

export function getTaskBranchName(taskId: string): string {
  return `task/${taskId}`;
}

export function hasEmbeddedCredentials(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      return true;
    }
  } catch {
    // Non-standard URL
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@\s]+@/.test(trimmed)) {
    return true;
  }
  if (/^git@[^:]+:/.test(trimmed)) {
    return true;
  }
  if (/^[^/@\s]+:[^/@\s]+@[^/\s]+\//.test(trimmed)) {
    return true;
  }
  return false;
}

export function redactCredentials(text: string, token?: string): string {
  if (!text || typeof text !== "string") return text;
  let redacted = text;
  if (token && typeof token === "string" && token.length > 0) {
    redacted = redacted.split(token).join("[REDACTED]");
  }
  redacted = redacted.replace(
    /((?:https?|ssh|git):\/\/)([^/@\s]+)@/g,
    "$1[REDACTED]@"
  );
  redacted = redacted.replace(
    /(ghp_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})/g,
    "[REDACTED]"
  );
  return redacted;
}

export function resolveHostGitDir(dir: string): string {
  const dotGit = path.join(dir, ".git");
  try {
    if (fs.existsSync(dotGit) && fs.statSync(dotGit).isDirectory()) {
      return dotGit;
    }
  } catch {
    // Ignore error
  }
  return dir;
}

export function getHostGitDirForWorktree(
  gitDir: string,
  worktreeDir?: string
): string {
  const hostMain = resolveHostGitDir(gitDir);
  if (!worktreeDir || typeof worktreeDir !== "string" || !worktreeDir.trim()) {
    throw new WorktreeNotFoundError("Worktree directory is required");
  }

  const resolvedWorktreeDir = path.resolve(worktreeDir);
  if (
    resolvedWorktreeDir === hostMain ||
    resolvedWorktreeDir === path.resolve(gitDir)
  ) {
    throw new WorktreeNotFoundError(
      `Specified worktree directory '${worktreeDir}' is the main repository git directory, not a worktree`
    );
  }

  if (!fs.existsSync(worktreeDir)) {
    throw new WorktreeNotFoundError(
      `Worktree directory does not exist: ${worktreeDir}`
    );
  }

  // Never trust the .git file inside the worktree: it is caller-controlled
  // data and may point anywhere. Resolve the git directory as
  // hostMain/worktrees/<name> instead, then require its realpath to stay
  // inside hostMain/worktrees.
  const worktreesBase = path.join(hostMain, "worktrees");
  if (!fs.existsSync(worktreesBase)) {
    throw new WorktreeNotFoundError(
      `Worktree directory '${worktreeDir}' is not a valid worktree: worktrees directory missing in '${hostMain}'`
    );
  }

  let candidate: string | null = null;
  const directCandidate = path.join(worktreesBase, path.basename(worktreeDir));
  try {
    if (
      fs.existsSync(directCandidate) &&
      fs.statSync(directCandidate).isDirectory()
    ) {
      candidate = directCandidate;
    }
  } catch {
    // Ignore error
  }

  if (!candidate) {
    try {
      const entries = fs.readdirSync(worktreesBase, { withFileTypes: true });
      const targetDotGit = path.resolve(worktreeDir, ".git");
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidateDir = path.join(worktreesBase, entry.name);
          const gitdirFile = path.join(candidateDir, "gitdir");
          if (fs.existsSync(gitdirFile)) {
            const content = fs.readFileSync(gitdirFile, "utf8").trim();
            if (path.resolve(content) === targetDotGit) {
              candidate = candidateDir;
              break;
            }
          }
        }
      }
    } catch {
      // Ignore filesystem scan error
    }
  }

  if (!candidate) {
    throw new WorktreeNotFoundError(
      `Worktree directory '${worktreeDir}' is not registered in repository worktrees at '${worktreesBase}'`
    );
  }

  let realCandidate: string;
  let realWorktreesBase: string;
  try {
    realCandidate = fs.realpathSync(candidate);
    realWorktreesBase = fs.realpathSync(worktreesBase);
  } catch {
    throw new WorktreeNotFoundError(
      `Worktree git directory for '${worktreeDir}' could not be resolved under '${worktreesBase}'`
    );
  }
  const relativeToWorktreesBase = path.relative(
    realWorktreesBase,
    realCandidate
  );
  if (
    !relativeToWorktreesBase ||
    relativeToWorktreesBase.startsWith("..") ||
    path.isAbsolute(relativeToWorktreesBase)
  ) {
    throw new WorktreeNotFoundError(
      `Worktree git directory '${candidate}' resolves outside the repository worktrees at '${worktreesBase}'`
    );
  }

  return candidate;
}

export function validateGithubTargetUrl(url: string): {
  owner: string;
  repo: string;
} {
  if (typeof url !== "string") {
    throw new GitServiceError(
      "pushToFork refused: target fork URL is required (Requirement 29.2)",
      "MISSING_FORK_URL"
    );
  }
  const trimmed = url.trim();
  if (!trimmed) {
    throw new GitServiceError(
      "pushToFork refused: target fork URL is required (Requirement 29.2)",
      "MISSING_FORK_URL"
    );
  }

  if (trimmed.endsWith("/")) {
    throw new GitServiceError(
      "pushToFork refused: target URL must not have a trailing slash",
      "INVALID_TARGET_URL"
    );
  }

  if (hasEmbeddedCredentials(trimmed)) {
    throw new GitServiceError(
      "pushToFork refused: target URL contains embedded credentials",
      "INVALID_TARGET_URL"
    );
  }

  const match = trimmed.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (!match) {
    throw new GitServiceError(
      "pushToFork refused: unparsable target URL: must be https://github.com/<owner>/<repo> with optional .git suffix; other hosts, http, and extra path segments are refused",
      "INVALID_TARGET_URL"
    );
  }

  const owner = match[1];
  const repo = match[2];

  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new GitServiceError(
      "pushToFork refused: unparsable target URL",
      "INVALID_TARGET_URL"
    );
  }

  return { owner, repo };
}

export function extractOwnerRepo(
  urlOrSlug: string
): { owner: string; repo: string } | null {
  if (typeof urlOrSlug !== "string") return null;
  const trimmed = urlOrSlug.trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = trimmed.match(
    /^https:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const slugMatch = trimmed.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (slugMatch) {
    return { owner: slugMatch[1], repo: slugMatch[2] };
  }

  return null;
}

export function isSameRepository(url1: string, url2: string): boolean {
  const p1 = extractOwnerRepo(url1);
  const p2 = extractOwnerRepo(url2);
  if (p1 && p2) {
    return (
      p1.owner.toLowerCase() === p2.owner.toLowerCase() &&
      p1.repo.toLowerCase() === p2.repo.toLowerCase()
    );
  }
  return url1.trim().toLowerCase() === url2.trim().toLowerCase();
}

export function isGraveyardRef(ref: string): boolean {
  if (typeof ref !== "string") return false;
  let trimmed = ref.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith("--branch=")) {
    return isGraveyardRef(trimmed.slice("--branch=".length));
  }
  if (trimmed.startsWith("--create=")) {
    return isGraveyardRef(trimmed.slice("--create=".length));
  }
  if (
    (trimmed.startsWith("-b") ||
      trimmed.startsWith("-B") ||
      trimmed.startsWith("-c") ||
      trimmed.startsWith("-C")) &&
    trimmed.length > 2
  ) {
    return isGraveyardRef(trimmed.slice(2));
  }

  trimmed = trimmed.replace(/^[\+\^\:\-]+/, "");
  if (!trimmed) return false;

  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    return parts.some((p) => isGraveyardRef(p));
  }

  if (
    trimmed === "refs/heads/graveyard" ||
    trimmed === "graveyard" ||
    trimmed.startsWith("refs/heads/graveyard/") ||
    trimmed.startsWith("graveyard/")
  ) {
    return true;
  }

  return false;
}

export const FORBIDDEN_GIT_CONFIG_KEYS = [
  "core.hookspath",
  "core.fsmonitor",
  "core.sshcommand",
  "core.gitproxy",
  "core.askpass",
  "core.editor",
  "core.pager",
  "protocol.",
  "filter.",
  "diff.external",
  "credential.",
  "alias.",
  "include.",
  "includeif.",
];

const GIT_SEPARATE_VALUE_GLOBAL_FLAGS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "-c",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

const GIT_EQUALS_GLOBAL_FLAG_PREFIXES = [
  "--git-dir=",
  "--work-tree=",
  "--namespace=",
  "--super-prefix=",
  "--config-env=",
];

const GIT_SAFE_BOOLEAN_GLOBAL_FLAGS = new Set([
  "--bare",
  "--no-pager",
  "-p",
  "-P",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
]);

function findGitSubcommand(args: string[]): { subcommand: string; index: number } | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (GIT_SEPARATE_VALUE_GLOBAL_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (
      GIT_EQUALS_GLOBAL_FLAG_PREFIXES.some((p) => arg.startsWith(p)) ||
      (arg.startsWith("-c") && arg.length > 2) ||
      (arg.startsWith("-C") && arg.length > 2)
    ) {
      continue;
    }
    if (GIT_SAFE_BOOLEAN_GLOBAL_FLAGS.has(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      throw new GitServiceError(
        `Unknown or prohibited git global option: ${arg}`,
        "SECURITY_VIOLATION"
      );
    }
    return { subcommand: arg, index: i };
  }
  return null;
}

export function assertNoGraveyardRefMutation(args: string[]): void {
  if (!Array.isArray(args) || args.length === 0) return;

  const subInfo = findGitSubcommand(args);
  if (!subInfo) return;

  const { subcommand, index } = subInfo;
  const subArgs = args.slice(index + 1);

  const hasGraveyardTarget = subArgs.some((arg) => isGraveyardRef(arg));

  if (subcommand === "update-ref") {
    if (hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via update-ref: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "branch") {
    const isList = subArgs.some(
      (a) => a === "--list" || a === "-l" || a === "--show-current"
    );
    if (!isList && hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via branch: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "reset") {
    if (hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via reset: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "push") {
    if (hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via push: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "fetch") {
    if (hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via fetch: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "receive-pack") {
    if (hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via receive-pack: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "tag") {
    const isList = subArgs.some((a) => a === "--list" || a === "-l");
    if (!isList && hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via tag: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "checkout" || subcommand === "switch") {
    if (hasGraveyardTarget) {
      const hasDetach = subArgs.includes("--detach") || subArgs.includes("-d");
      const hasBranchCreation = subArgs.some(
        (a) =>
          a === "-b" ||
          a.startsWith("-b") ||
          a === "-B" ||
          a.startsWith("-B") ||
          a === "-c" ||
          a.startsWith("-c") ||
          a === "-C" ||
          a.startsWith("-C") ||
          a === "--branch" ||
          a.startsWith("--branch=") ||
          a === "--create" ||
          a.startsWith("--create=") ||
          a === "--orphan" ||
          a.startsWith("--orphan=")
      );
      if (!hasDetach || hasBranchCreation) {
        throw new GitServiceError(
          `Mutation of graveyard ref is prohibited via ${subcommand}: ${args.join(" ")}`,
          "SECURITY_VIOLATION"
        );
      }
    }
  } else if (
    subcommand === "worktree" ||
    subcommand === "rebase" ||
    subcommand === "merge" ||
    subcommand === "cherry-pick" ||
    subcommand === "pull" ||
    subcommand === "commit" ||
    subcommand === "revert" ||
    subcommand === "am"
  ) {
    if (hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via ${subcommand}: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  } else if (subcommand === "symbolic-ref") {
    const isDelete = subArgs.some((a) => a === "-d" || a === "--delete");
    const nonFlagArgs = subArgs.filter((a) => !a.startsWith("-"));
    const isWrite = nonFlagArgs.length >= 2;
    if ((isDelete || isWrite) && hasGraveyardTarget) {
      throw new GitServiceError(
        `Mutation of graveyard ref is prohibited via symbolic-ref: ${args.join(" ")}`,
        "SECURITY_VIOLATION"
      );
    }
  }
}

const HEAD_MUTATING_COMMANDS = new Set([
  "reset",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "pull",
  "update-ref",
  "branch",
  "checkout",
  "switch",
  "worktree",
]);

function assertHeadNotGraveyard(
  args: string[],
  options: GitExecOptions = {}
): void {
  const subInfo = findGitSubcommand(args);
  if (!subInfo || !HEAD_MUTATING_COMMANDS.has(subInfo.subcommand)) {
    return;
  }

  let effectiveCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  let targetGitDir: string | null = null;
  let rawGitDir: string | null = null;

  for (let i = 0; i < subInfo.index; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    if (arg === "-C") {
      if (i + 1 < subInfo.index) {
        effectiveCwd = path.resolve(effectiveCwd, args[i + 1]);
        if (rawGitDir !== null) {
          targetGitDir = path.resolve(effectiveCwd, rawGitDir);
        }
        i++;
      }
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      effectiveCwd = path.resolve(effectiveCwd, arg.slice(2));
      if (rawGitDir !== null) {
        targetGitDir = path.resolve(effectiveCwd, rawGitDir);
      }
      continue;
    }
    if (arg === "--git-dir") {
      if (i + 1 < subInfo.index) {
        rawGitDir = args[i + 1];
        targetGitDir = path.resolve(effectiveCwd, rawGitDir);
        i++;
      }
      continue;
    }
    if (arg.startsWith("--git-dir=")) {
      rawGitDir = arg.slice("--git-dir=".length);
      targetGitDir = path.resolve(effectiveCwd, rawGitDir);
      continue;
    }
    if (
      arg === "-c" ||
      arg === "--work-tree" ||
      arg === "--namespace" ||
      arg === "--super-prefix" ||
      arg === "--config-env" ||
      GIT_SEPARATE_VALUE_GLOBAL_FLAGS.has(arg)
    ) {
      if (i + 1 < subInfo.index) {
        i++;
      }
      continue;
    }
  }

  if (!targetGitDir) {
    const dotGit = path.join(effectiveCwd, ".git");
    try {
      if (fs.existsSync(path.join(dotGit, "HEAD"))) {
        targetGitDir = dotGit;
      } else if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
        const content = fs.readFileSync(dotGit, "utf8").trim();
        if (content.startsWith("gitdir:")) {
          const gitDirRef = content.slice("gitdir:".length).trim();
          targetGitDir = path.resolve(effectiveCwd, gitDirRef);
        }
      } else if (fs.existsSync(path.join(effectiveCwd, "HEAD"))) {
        targetGitDir = effectiveCwd;
      }
    } catch {
      // ignore filesystem errors
    }
  }

  if (targetGitDir) {
    try {
      const headFile = path.join(targetGitDir, "HEAD");
      if (fs.existsSync(headFile)) {
        const headContent = fs.readFileSync(headFile, "utf8").trim();
        if (headContent.startsWith("ref:")) {
          const target = headContent.slice("ref:".length).trim();
          if (
            target.startsWith("refs/heads/graveyard") ||
            target === "graveyard" ||
            target.startsWith("graveyard/")
          ) {
            throw new GitServiceError(
              "Mutation prohibited while HEAD points to a graveyard ref",
              "SECURITY_VIOLATION"
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof GitServiceError) throw err;
      // ignore other errors
    }
  }
}

export class GitService {
  public static readonly GIT_HOOKS_FLAG = GIT_HOOKS_FLAG;
  public static readonly GIT_FSMONITOR_FLAG = GIT_FSMONITOR_FLAG;
  public static readonly GIT_PROTOCOL_ALLOW_FLAG = GIT_PROTOCOL_ALLOW_FLAG;
  public static readonly GIT_ISOLATION_FLAGS = GIT_ISOLATION_FLAGS;

  public readonly repositorySizeCap?: number;
  #runsDir: string;
  #gitBinary: string;
  #githubToken?: string;
  #githubWriteToken?: string;
  public readonly ownerLogin?: string;
  public readonly sourceRepoUrl?: string;
  public readonly forkRepoUrl?: string;
  public readonly forkChecker?: ForkChecker;

  public get runsDir(): string {
    return this.#runsDir;
  }

  public get gitBinary(): string {
    return this.#gitBinary;
  }

  constructor(options: GitServiceOptions = {}) {
    if (options.execFileFn !== undefined) {
      throw new GitServiceError(
        "Custom execFileFn is not allowed",
        "SECURITY_VIOLATION"
      );
    }
    if (options.gitBinary !== undefined && options.gitBinary !== "git") {
      throw new GitServiceError(
        "Custom gitBinary is not allowed",
        "SECURITY_VIOLATION"
      );
    }

    const envCap =
      typeof process !== "undefined" && process.env?.REPOSITORY_SIZE_CAP
        ? parseInt(process.env.REPOSITORY_SIZE_CAP, 10)
        : undefined;

    this.repositorySizeCap =
      options.repositorySizeCap ??
      options.repoSizeCap ??
      options.maxSizeKb ??
      (Number.isFinite(envCap) ? envCap : undefined);

    this.#runsDir = options.runsDir ?? "/data/runs";
    this.#gitBinary = "git";

    this.#githubToken =
      options.githubToken ??
      (typeof process !== "undefined" ? process.env?.GITHUB_TOKEN : undefined);
    this.#githubWriteToken =
      options.githubWriteToken ??
      (typeof process !== "undefined"
        ? process.env?.GITHUB_WRITE_TOKEN
        : undefined);
    this.ownerLogin =
      options.ownerLogin ??
      (typeof process !== "undefined"
        ? process.env?.GITHUB_OWNER_LOGIN ?? process.env?.OWNER_LOGIN
        : undefined);
    this.sourceRepoUrl = options.sourceRepoUrl;
    this.forkRepoUrl = options.forkRepoUrl;
    this.forkChecker = options.forkChecker ?? options.checker;
  }

  private checkGitSecurity(
    args: string[],
    isAuthorizedForkPush = false
  ): void {
    for (const arg of args) {
      if (arg === "--exec-path" || arg.startsWith("--exec-path=")) {
        throw new GitServiceError(
          `Custom git exec-path is prohibited: ${arg}`,
          "SECURITY_VIOLATION"
        );
      }
    }

    const isPush = args.some((arg) => arg === "push");
    if (isPush) {
      const hasForce = args.some(
        (arg) =>
          arg === "--force" ||
          arg === "-f" ||
          arg === "--force-with-lease" ||
          arg.startsWith("+")
      );
      if (hasForce) {
        throw new GitServiceError(
          "Force push is strictly prohibited (Requirement 29.8)",
          "FORCE_PUSH_PROHIBITED"
        );
      }

      const hasDelete = args.some(
        (arg) => arg === "--delete" || arg === "-d" || arg.startsWith(":")
      );
      if (hasDelete) {
        throw new GitServiceError(
          "Branch deletion is strictly prohibited (Requirement 29.8)",
          "BRANCH_DELETION_PROHIBITED"
        );
      }

      if (!isAuthorizedForkPush) {
        throw new GitServiceError(
          "Git write operation refused: direct push prohibited; push is only permitted via pushToFork to owner's fork (Requirement 29)",
          "WRITE_PROHIBITED"
        );
      }
    }

    let subInfo: { subcommand: string; index: number } | null = null;
    try {
      subInfo = findGitSubcommand(args);
    } catch {
      // ignore
    }

    if (subInfo?.subcommand === "config") {
      const subArgs = args.slice(subInfo.index + 1);
      const nonFlagArgs: string[] = [];
      for (let j = 0; j < subArgs.length; j++) {
        const arg = subArgs[j];
        if (arg === "--") {
          continue;
        }
        if (
          arg === "--file" ||
          arg === "-f" ||
          arg === "--blob" ||
          arg === "--type" ||
          arg === "--default"
        ) {
          j++;
          continue;
        }
        if (
          arg.startsWith("--file=") ||
          arg.startsWith("-f") ||
          arg.startsWith("--blob=") ||
          arg.startsWith("--type=") ||
          arg.startsWith("--default=")
        ) {
          continue;
        }
        if (arg.startsWith("-")) {
          continue;
        }
        nonFlagArgs.push(arg);
      }

      if (nonFlagArgs.length > 0) {
        const firstArg = nonFlagArgs[0];
        let rawKey = firstArg;
        let val = nonFlagArgs.length > 1 ? nonFlagArgs[1] : undefined;
        if (rawKey.includes("=")) {
          const eqIdx = rawKey.indexOf("=");
          val = rawKey.slice(eqIdx + 1);
          rawKey = rawKey.slice(0, eqIdx);
        }
        const key = rawKey.trim().toLowerCase();

        if (
          (key === "core.hookspath" && val === "/dev/null") ||
          (key === "core.fsmonitor" && val === "false")
        ) {
          // Allowed internal hardening
        } else {
          for (const prefix of FORBIDDEN_GIT_CONFIG_KEYS) {
            if (key === prefix || key.startsWith(prefix)) {
              throw new GitServiceError(
                `Prohibited git config override: ${rawKey}`,
                "SECURITY_VIOLATION"
              );
            }
          }
        }
      }
    }

    const configPairs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-c" && i + 1 < args.length) {
        configPairs.push(args[i + 1]);
        i++;
      } else if (arg.startsWith("-c") && arg !== "-c") {
        let rest = arg.slice(2);
        if (rest.startsWith("=")) rest = rest.slice(1);
        configPairs.push(rest);
      } else if (arg === "--config-env" && i + 1 < args.length) {
        configPairs.push(args[i + 1]);
        i++;
      } else if (arg.startsWith("--config-env=")) {
        configPairs.push(arg.slice("--config-env=".length));
      }
    }

    for (const pair of configPairs) {
      const eqIdx = pair.indexOf("=");
      const rawKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
      const key = rawKey.trim().toLowerCase();

      if (
        key === "protocol.https.allow" &&
        (isAuthorizedForkPush || args.includes("clone") || args.includes("fetch"))
      ) {
        continue;
      }

      for (const prefix of FORBIDDEN_GIT_CONFIG_KEYS) {
        if (key === prefix || key.startsWith(prefix)) {
          throw new GitServiceError(
            `Prohibited git config override: ${rawKey}`,
            "SECURITY_VIOLATION"
          );
        }
      }
    }
  }

  private buildSanitizedEnv(
    options: GitExecOptions,
    freshHome: string,
    isAuthorizedForkPush = false
  ): NodeJS.ProcessEnv {
    const allowedExtraEnvKeys = new Set([
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TZ",
      "GIT_TERMINAL_PROMPT",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_DATE",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_DATE",
    ]);

    if (isAuthorizedForkPush) {
      allowedExtraEnvKeys.add("GIT_WRITE_TOKEN");
      allowedExtraEnvKeys.add("GIT_ASKPASS_TOKEN");
    }

    const filteredExtraEnv: Record<string, string> = {};
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (allowedExtraEnvKeys.has(k) && typeof v === "string") {
          filteredExtraEnv[k] = v;
        }
      }
    }

    const minimalEnv: NodeJS.ProcessEnv = {
      ...filteredExtraEnv,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: filteredExtraEnv.LANG ?? process.env.LANG ?? "C.UTF-8",
      HOME: freshHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: filteredExtraEnv.GIT_TERMINAL_PROMPT ?? "0",
    } as unknown as NodeJS.ProcessEnv;

    if (
      isAuthorizedForkPush &&
      typeof options.env?.GIT_ASKPASS === "string"
    ) {
      minimalEnv.GIT_ASKPASS = options.env.GIT_ASKPASS;
    }

    return minimalEnv;
  }

  public validateRevision(rev: unknown, name?: string): string {
    return assertValidRevision(rev, name);
  }

  public isValidRevision(rev: unknown): boolean {
    return isValidRevision(rev);
  }

  public static validateRevision(rev: unknown, name?: string): string {
    return assertValidRevision(rev, name);
  }

  public static isValidRevision(rev: unknown): boolean {
    return isValidRevision(rev);
  }

  public checkSize(
    sizeOrMetadata: number | RepoMetadataWithSize | unknown,
    capOverride?: number
  ): SizeCheckResult {
    const cap = capOverride ?? this.repositorySizeCap;
    return checkRepoSize(sizeOrMetadata, cap);
  }

  public assertSizeWithinCap(
    sizeOrMetadata: number | RepoMetadataWithSize | unknown,
    capOverride?: number
  ): void {
    const cap = capOverride ?? this.repositorySizeCap;
    assertRepoSizeWithinCap(sizeOrMetadata, cap);
  }

  public static checkSize(
    sizeOrMetadata: number | RepoMetadataWithSize | unknown,
    cap?: number
  ): SizeCheckResult {
    return checkRepoSize(sizeOrMetadata, cap);
  }

  public static assertSizeWithinCap(
    sizeOrMetadata: number | RepoMetadataWithSize | unknown,
    cap?: number
  ): void {
    assertRepoSizeWithinCap(sizeOrMetadata, cap);
  }

  public async execGit(
    args: string[],
    options: GitExecOptions = {}
  ): Promise<GitExecResult> {
    assertNoGraveyardRefMutation(args);
    assertHeadNotGraveyard(args, options);
    return this.#execGitInternal(args, options, false);
  }

  async #execGitInternal(
    args: string[],
    options: GitExecOptions = {},
    isAuthorizedForkPush = false
  ): Promise<GitExecResult> {
    this.checkGitSecurity(args, isAuthorizedForkPush);
    const fullArgs = [...GitService.GIT_ISOLATION_FLAGS, ...args];

    const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "git-home-"));
    const minimalEnv = this.buildSanitizedEnv(options, freshHome, isAuthorizedForkPush);

    return new Promise((resolve, reject) => {
      childProcess.execFile(
        this.#gitBinary,
        fullArgs,
        {
          cwd: options.cwd,
          env: minimalEnv,
          timeout: options.timeout ?? 120000,
          maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          try {
            fs.rmSync(freshHome, { recursive: true, force: true });
          } catch {
            // Ignore cleanup error
          }

          const stdoutStr =
            typeof stdout === "string"
              ? stdout
              : Buffer.isBuffer(stdout)
              ? (stdout as any).toString("utf8")
              : "";
          const stderrStr =
            typeof stderr === "string"
              ? stderr
              : Buffer.isBuffer(stderr)
              ? (stderr as any).toString("utf8")
              : "";

          if (error) {
            const exitCode =
              typeof error.code === "number"
                ? error.code
                : typeof (error as any).status === "number"
                ? (error as any).status
                : 1;
            const tokenToRedact =
              options.env?.GIT_WRITE_TOKEN ?? options.env?.GIT_ASKPASS_TOKEN;
            const rawMessage = `Git command failed: ${this.#gitBinary} ${fullArgs.join(" ")}\n${stderrStr || error.message}`;
            const cleanMessage = redactCredentials(rawMessage, tokenToRedact);
            const cleanStderr = redactCredentials(stderrStr, tokenToRedact);
            const gitError = new GitServiceError(
              cleanMessage,
              "GIT_COMMAND_FAILED",
              exitCode,
              cleanStderr
            );
            reject(gitError);
            return;
          }

          resolve({
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode: 0,
          });
        }
      );
    });
  }

  public execGitSync(
    args: string[],
    options: GitExecOptions = {}
  ): GitExecResult {
    assertNoGraveyardRefMutation(args);
    assertHeadNotGraveyard(args, options);
    return this.#execGitSyncInternal(args, options, false);
  }

  #execGitSyncInternal(
    args: string[],
    options: GitExecOptions = {},
    isAuthorizedForkPush = false
  ): GitExecResult {
    this.checkGitSecurity(args, isAuthorizedForkPush);
    const fullArgs = [...GitService.GIT_ISOLATION_FLAGS, ...args];
    const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "git-home-"));
    const minimalEnv = this.buildSanitizedEnv(options, freshHome, isAuthorizedForkPush);

    try {
      const stdout = childProcess.execFileSync(this.#gitBinary, fullArgs, {
        cwd: options.cwd,
        env: minimalEnv,
        timeout: options.timeout ?? 120000,
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        encoding: "utf8",
      });
      return {
        stdout: stdout ?? "",
        stderr: "",
        exitCode: 0,
      };
    } catch (err: any) {
      const stderrStr = err.stderr ? String(err.stderr) : "";
      const exitCode = typeof err.status === "number" ? err.status : 1;
      const tokenToRedact =
        options.env?.GIT_WRITE_TOKEN ?? options.env?.GIT_ASKPASS_TOKEN;
      const rawMessage = `Git command failed: ${this.#gitBinary} ${fullArgs.join(" ")}\n${stderrStr || err.message}`;
      const cleanMessage = redactCredentials(rawMessage, tokenToRedact);
      const cleanStderr = redactCredentials(stderrStr, tokenToRedact);
      throw new GitServiceError(
        cleanMessage,
        "GIT_COMMAND_FAILED",
        exitCode,
        cleanStderr
      );
    } finally {
      try {
        fs.rmSync(freshHome, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  }

  public async cloneRepo(
    repoUrl: string,
    gitDir: string,
    baseSha?: string
  ): Promise<void> {
    if (baseSha !== undefined && baseSha !== null) {
      assertValidRevision(baseSha, "baseSha");
    }

    const parentDir = path.dirname(gitDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const isExistingRepo =
      fs.existsSync(path.join(gitDir, ".git")) ||
      fs.existsSync(path.join(gitDir, "HEAD"));

    if (!isExistingRepo) {
      const cloneArgs = [
        ...(repoUrl.startsWith("https://")
          ? ["-c", "protocol.https.allow=always"]
          : []),
        "clone",
        "--",
        repoUrl,
        gitDir,
      ];
      await this.#execGitInternal(cloneArgs);
    }

    const hostGitDir = resolveHostGitDir(gitDir);
    await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "config",
      "core.hooksPath",
      "/dev/null",
    ]);
    await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "config",
      "core.fsmonitor",
      "false",
    ]);

    if (baseSha !== undefined && baseSha !== null) {
      assertValidRevision(baseSha, "baseSha");
      try {
        await this.#execGitInternal([
          "--git-dir",
          hostGitDir,
          "--work-tree",
          gitDir,
          "checkout",
          "--end-of-options",
          baseSha,
        ]);
      } catch {
        const fetchArgs = [
          ...(repoUrl.startsWith("https://")
            ? ["-c", "protocol.https.allow=always"]
            : []),
          "--git-dir",
          hostGitDir,
          "--work-tree",
          gitDir,
          "fetch",
          "origin",
          "--end-of-options",
          baseSha,
        ];
        await this.#execGitInternal(fetchArgs);
        await this.#execGitInternal([
          "--git-dir",
          hostGitDir,
          "--work-tree",
          gitDir,
          "checkout",
          "--end-of-options",
          baseSha,
        ]);
      }
    }
  }

  public async createBaseWorktree(
    gitDir: string,
    worktreeDir: string,
    baseSha: string
  ): Promise<void> {
    assertValidRevision(baseSha, "baseSha");
    const parentDir = path.dirname(worktreeDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const hostGitDir = resolveHostGitDir(gitDir);

    if (fs.existsSync(worktreeDir)) {
      try {
        await this.#execGitInternal([
          "--git-dir",
          hostGitDir,
          "--work-tree",
          gitDir,
          "worktree",
          "prune",
        ]);
      } catch {
        // Ignore prune failure
      }
      if (fs.existsSync(worktreeDir)) {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
        try {
          await this.#execGitInternal([
            "--git-dir",
            hostGitDir,
            "--work-tree",
            gitDir,
            "worktree",
            "prune",
          ]);
        } catch {
          // Ignore prune failure
        }
      }
    }

    await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "worktree",
      "add",
      "--detach",
      "--",
      worktreeDir,
      baseSha,
    ]);

    const effectiveBaseGitDir = getHostGitDirForWorktree(gitDir, worktreeDir);
    await this.#execGitInternal([
      "--git-dir",
      effectiveBaseGitDir,
      "--work-tree",
      worktreeDir,
      "config",
      "core.hooksPath",
      "/dev/null",
    ]);
    await this.#execGitInternal([
      "--git-dir",
      effectiveBaseGitDir,
      "--work-tree",
      worktreeDir,
      "config",
      "core.fsmonitor",
      "false",
    ]);
  }

  private async createIntegrationHead(
    optionsOrRunId: CreateIntegrationHeadOptions | string,
    baseSha?: string,
    gitDir?: string
  ): Promise<IntegrationHeadResult> {
    const options: CreateIntegrationHeadOptions =
      typeof optionsOrRunId === "string"
        ? { runId: optionsOrRunId, baseSha, gitDir }
        : optionsOrRunId;

    const { runId } = options;
    assertValidSegmentId(runId, "runId");
    if ((options as any).taskId !== undefined && (options as any).taskId !== null) {
      assertValidSegmentId((options as any).taskId, "taskId");
    }

    const resolvedGitDir =
      options.gitDir ??
      (options.runDir
        ? path.join(options.runDir, "git")
        : path.join(this.#runsDir, runId, "git"));

    const hostGitDir = resolveHostGitDir(resolvedGitDir);
    const branchName = `graveyard/${runId}`;
    assertValidRevision(branchName, "branchName");

    if (options.baseSha) {
      assertValidRevision(options.baseSha, "baseSha");
      await this.#execGitInternal([
        "--git-dir",
        hostGitDir,
        "--work-tree",
        resolvedGitDir,
        "branch",
        "-f",
        "--end-of-options",
        branchName,
        options.baseSha,
      ]);
    } else {
      const headShaRes = await this.#execGitInternal([
        "--git-dir",
        hostGitDir,
        "--work-tree",
        resolvedGitDir,
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD",
      ]);
      const headSha = headShaRes.stdout.trim();
      assertValidRevision(headSha, "headSha");
      await this.#execGitInternal([
        "--git-dir",
        hostGitDir,
        "--work-tree",
        resolvedGitDir,
        "branch",
        "-f",
        "--end-of-options",
        branchName,
        headSha,
      ]);
    }

    const shaRes = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      resolvedGitDir,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${branchName}`,
    ]);
    const sha = shaRes.stdout.trim();

    return {
      branch: branchName,
      sha,
      gitDir: resolvedGitDir,
    };
  }

  public async getIntegrationHeadSha(
    runId: string,
    gitDir?: string
  ): Promise<string> {
    const validRunId = assertValidSegmentId(runId, "runId");
    const resolvedGitDir = gitDir ?? path.join(this.#runsDir, validRunId, "git");
    const hostGitDir = resolveHostGitDir(resolvedGitDir);
    const branchName = `graveyard/${validRunId}`;
    assertValidRevision(branchName, "branchName");
    const res = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      resolvedGitDir,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${branchName}`,
    ]);
    return res.stdout.trim();
  }

  public async createTaskWorktree(
    options: CreateTaskWorktreeOptions
  ): Promise<TaskWorktreeResult> {
    const { runId, taskId } = options;
    assertValidSegmentId(runId, "runId");
    assertValidSegmentId(taskId, "taskId");

    const runRoot = options.runDir ?? path.join(this.runsDir, runId);
    const gitDir = options.gitDir ?? path.join(runRoot, "git");
    const worktreeDir =
      options.worktreeDir ?? path.join(runRoot, "builders", taskId);
    const integrationBranch = options.baseBranch ?? `graveyard/${runId}`;
    const taskBranch = `task/${taskId}`;
    assertValidRevision(integrationBranch, "integrationBranch");
    assertValidRevision(taskBranch, "taskBranch");

    const parentDir = path.dirname(worktreeDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const hostGitDir = resolveHostGitDir(gitDir);

    if (fs.existsSync(worktreeDir)) {
      try {
        await this.#execGitInternal([
          "--git-dir",
          hostGitDir,
          "--work-tree",
          gitDir,
          "worktree",
          "remove",
          "--force",
          "--",
          worktreeDir,
        ]);
      } catch {
        // ignore removal error
      }
      if (fs.existsSync(worktreeDir)) {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
      try {
        await this.#execGitInternal([
          "--git-dir",
          hostGitDir,
          "--work-tree",
          gitDir,
          "worktree",
          "prune",
        ]);
      } catch {
        // ignore prune error
      }
    }

    await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "branch",
      "-f",
      "--end-of-options",
      taskBranch,
      integrationBranch,
    ]);

    await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "worktree",
      "add",
      "--",
      worktreeDir,
      taskBranch,
    ]);

    const effectiveTaskGitDir = getHostGitDirForWorktree(gitDir, worktreeDir);
    await this.#execGitInternal([
      "--git-dir",
      effectiveTaskGitDir,
      "--work-tree",
      worktreeDir,
      "config",
      "core.hooksPath",
      "/dev/null",
    ]);
    await this.#execGitInternal([
      "--git-dir",
      effectiveTaskGitDir,
      "--work-tree",
      worktreeDir,
      "config",
      "core.fsmonitor",
      "false",
    ]);

    const cleanup = async (): Promise<void> => {
      await this.removeTaskWorktree({
        runId,
        taskId,
        gitDir,
        worktreeDir,
      });
    };

    return {
      runId,
      taskId,
      branch: taskBranch,
      worktreeDir,
      gitDir,
      cleanup,
    };
  }

  public async removeTaskWorktree(
    optionsOrRunId: RemoveTaskWorktreeOptions | string,
    taskId?: string,
    gitDir?: string,
    worktreeDir?: string
  ): Promise<void> {
    const options: RemoveTaskWorktreeOptions =
      typeof optionsOrRunId === "string"
        ? { runId: optionsOrRunId, taskId, gitDir, worktreeDir }
        : optionsOrRunId;

    const runId = assertValidSegmentId(options.runId, "runId");
    const resolvedTaskId = assertValidSegmentId(options.taskId, "taskId");

    const integrationBranch = `graveyard/${runId}`;
    const taskBranch = `task/${resolvedTaskId}`;
    assertValidRevision(integrationBranch, "integrationBranch");
    assertValidRevision(taskBranch, "taskBranch");

    const runRoot = options.runDir ?? path.join(this.runsDir, runId);
    const resolvedGitDir = options.gitDir ?? path.join(runRoot, "git");
    const resolvedWorktreeDir =
      options.worktreeDir ?? path.join(runRoot, "builders", resolvedTaskId);

    // Containment guard: assert the target resolves inside runsDir before any
    // recursive removal happens.
    const runsRoot = path.resolve(this.runsDir);
    const resolvedTarget = path.resolve(resolvedWorktreeDir);
    const relativeToRunsRoot = path.relative(runsRoot, resolvedTarget);
    if (
      !relativeToRunsRoot ||
      relativeToRunsRoot.startsWith("..") ||
      path.isAbsolute(relativeToRunsRoot)
    ) {
      throw new GitServiceError(
        `removeTaskWorktree refused: worktree path '${resolvedWorktreeDir}' resolves outside runsDir '${this.runsDir}'`,
        "WORKTREE_PATH_OUTSIDE_RUNS_DIR"
      );
    }

    const hostGitDir = resolveHostGitDir(resolvedGitDir);

    if (resolvedWorktreeDir) {
      try {
        await this.#execGitInternal([
          "--git-dir",
          hostGitDir,
          "--work-tree",
          resolvedGitDir,
          "worktree",
          "remove",
          "--force",
          "--",
          resolvedWorktreeDir,
        ]);
      } catch {
        // Ignore worktree remove errors
      }

      if (fs.existsSync(resolvedWorktreeDir)) {
        fs.rmSync(resolvedWorktreeDir, { recursive: true, force: true });
      }

      try {
        await this.#execGitInternal([
          "--git-dir",
          hostGitDir,
          "--work-tree",
          resolvedGitDir,
          "worktree",
          "prune",
        ]);
      } catch {
        // Ignore prune errors
      }
    }
  }

  public cleanupTaskWorktree = this.removeTaskWorktree;

  public async withTaskWorktree<T>(
    options: CreateTaskWorktreeOptions,
    fn: (worktree: TaskWorktreeResult) => Promise<T>
  ): Promise<T> {
    const worktree = await this.createTaskWorktree(options);
    try {
      return await fn(worktree);
    } finally {
      await worktree.cleanup();
    }
  }

  public async rebaseCandidate(
    options: RebaseTaskOptions
  ): Promise<RebaseResult> {
    const { runId, taskId } = options;
    assertValidSegmentId(runId, "runId");
    if (taskId !== undefined && taskId !== null) {
      assertValidSegmentId(taskId, "taskId");
    }
    const runRoot = options.runDir ?? path.join(this.runsDir, runId);
    const gitDir = options.gitDir ?? path.join(runRoot, "git");
    const hostMainGitDir = resolveHostGitDir(gitDir);
    const integrationBranch =
      options.integrationBranch ?? `graveyard/${runId}`;
    const taskBranch = options.taskBranch ?? `task/${taskId}`;
    assertValidRevision(integrationBranch, "integrationBranch");
    if (taskId || options.taskBranch) {
      assertValidRevision(taskBranch, "taskBranch");
    }

    if (isGraveyardRef(taskBranch)) {
      throw new GitServiceError(
        `Rebase candidate task branch cannot be a graveyard ref: ${taskBranch}`,
        "SECURITY_VIOLATION"
      );
    }

    let targetDir = options.worktreeDir;
    if (!targetDir && taskId) {
      targetDir = path.join(runRoot, "builders", taskId);
    }
    if (!targetDir) {
      targetDir = gitDir;
    }

    if (targetDir === gitDir && !taskId && !options.taskBranch) {
      throw new GitServiceError(
        "Rebase candidate requires a task worktree or task branch",
        "SECURITY_VIOLATION"
      );
    }

    try {
      let rebaseArgs: string[];
      if (targetDir === gitDir) {
        rebaseArgs = [
          "--git-dir",
          hostMainGitDir,
          "--work-tree",
          gitDir,
          "rebase",
          "--end-of-options",
          integrationBranch,
          taskBranch,
        ];
      } else {
        const effectiveGitDir = getHostGitDirForWorktree(gitDir, targetDir);
        rebaseArgs = [
          "--git-dir",
          effectiveGitDir,
          "--work-tree",
          targetDir,
          "rebase",
          "--end-of-options",
          integrationBranch,
        ];
      }

      const res = await this.#execGitInternal(rebaseArgs);

      const shaRes = await this.#execGitInternal([
        "--git-dir",
        hostMainGitDir,
        "--work-tree",
        gitDir,
        "rev-parse",
        "--verify",
        "--end-of-options",
        taskBranch,
      ]);
      const candidateSha = shaRes.stdout.trim();
      const diffRes = await this.#execGitInternal([
        "--git-dir",
        hostMainGitDir,
        "--work-tree",
        gitDir,
        "diff",
        "--binary",
        "--no-color",
        "--end-of-options",
        `${integrationBranch}..${candidateSha}`,
      ]);
      const candidateSha256 = candidateSha256FromDiff(diffRes.stdout);

      return {
        ok: true,
        conflict: false,
        candidateSha,
        candidateSha256,
        stdout: res.stdout,
        stderr: res.stderr,
      };
    } catch (err: any) {
      const stderrStr = err.stderr || err.message || "";
      const stdoutStr = err.stdout || "";
      const combinedOutput = `${stdoutStr}\n${stderrStr}`;
      const isConflict =
        combinedOutput.includes("CONFLICT") ||
        combinedOutput.toLowerCase().includes("conflict") ||
        combinedOutput.includes("failed to merge in the changes") ||
        combinedOutput.includes("could not apply") ||
        combinedOutput.includes("Resolve all conflicts manually");

      if (isConflict) {
        let conflictedFiles: string[] = [];
        try {
          const effectiveGitDir =
            targetDir === gitDir
              ? hostMainGitDir
              : getHostGitDirForWorktree(gitDir, targetDir);
          const diffArgs = [
            "--git-dir",
            effectiveGitDir,
            "--work-tree",
            targetDir,
            "diff",
            "--name-only",
            "--diff-filter=U",
          ];
          const diffRes = await this.#execGitInternal(diffArgs);
          conflictedFiles = diffRes.stdout
            .split("\n")
            .map((f) => f.trim())
            .filter(Boolean);
        } catch {
          const matches = [
            ...combinedOutput.matchAll(
              /CONFLICT\s*(?:\([^)]+\))?:\s*Merge conflict in\s+(.+)/g
            ),
          ];
          conflictedFiles = matches.map((m) => m[1].trim());
        }

        try {
          const effectiveGitDir =
            targetDir === gitDir
              ? hostMainGitDir
              : getHostGitDirForWorktree(gitDir, targetDir);
          const abortArgs = [
            "--git-dir",
            effectiveGitDir,
            "--work-tree",
            targetDir,
            "rebase",
            "--abort",
          ];
          await this.#execGitInternal(abortArgs);
        } catch {
          // ignore abort error if already aborted
        }

        return {
          ok: false,
          conflict: true,
          requiresConflictChoice: true,
          conflictedFiles,
          stderr: stderrStr,
          stdout: stdoutStr,
          error:
            "Rebase conflict detected; requires user conflict_choice (Requirement 25.2)",
        };
      }

      throw err;
    }
  }

  public rebaseTaskBranch = this.rebaseCandidate;

  private async mergeCandidate(
    options: MergeCandidateOptions
  ): Promise<MergeCandidateResult> {
    const { runId, candidateSha, expectedIntegrationHeadSha } = options;
    assertValidSegmentId(runId, "runId");
    if ((options as any).taskId !== undefined && (options as any).taskId !== null) {
      assertValidSegmentId((options as any).taskId, "taskId");
    }
    const runRoot = options.runDir ?? path.join(this.#runsDir, runId);
    const gitDir = options.gitDir ?? path.join(runRoot, "git");
    const integrationBranch =
      options.integrationBranch ?? `graveyard/${runId}`;
    assertValidRevision(integrationBranch, "integrationBranch");

    const SHA1_REGEX = /^[0-9a-f]{40}$/;

    if (!candidateSha || !SHA1_REGEX.test(candidateSha)) {
      return {
        ok: false,
        merged: false,
        reason: "candidateSha must match ^[0-9a-f]{40}$ (Requirement 25.6)",
      };
    }

    const rawVerdict = options.verdict;
    if (
      !rawVerdict ||
      typeof rawVerdict !== "object" ||
      Array.isArray(rawVerdict)
    ) {
      return {
        ok: false,
        merged: false,
        reason: "Verdict is required and must be a non-null plain object (Requirement 25.6)",
      };
    }

    const wardenValidation = validateWardenVerdict(rawVerdict);
    if (!wardenValidation.valid || wardenValidation.verdict !== "approve") {
      return {
        ok: false,
        merged: false,
        reason: `Warden verdict validation failed: ${wardenValidation.reasons.join("; ") || "verdict is not approve"}`,
      };
    }

    const verdictRecord = rawVerdict as Record<string, unknown>;
    const checks =
      verdictRecord.checks &&
      typeof verdictRecord.checks === "object" &&
      !Array.isArray(verdictRecord.checks)
        ? (verdictRecord.checks as Record<string, unknown>)
        : undefined;

    const installCheck = checks?.install ?? verdictRecord.install;
    const buildCheck = checks?.build ?? verdictRecord.build;
    const acceptCheck =
      checks?.accept ??
      verdictRecord.accept ??
      checks?.taskAccept ??
      verdictRecord.taskAccept ??
      checks?.acceptCommand ??
      verdictRecord.acceptCommand;
    const testsCheck =
      checks?.tests ??
      verdictRecord.tests ??
      checks?.test ??
      verdictRecord.test;

    if (!isCheckPassing(installCheck)) {
      return {
        ok: false,
        merged: false,
        reason: "Verdict install check did not pass (Requirement 24.5)",
      };
    }
    if (!isCheckPassing(buildCheck)) {
      return {
        ok: false,
        merged: false,
        reason: "Verdict build check did not pass (Requirement 24.5)",
      };
    }
    if (!isCheckPassing(acceptCheck)) {
      return {
        ok: false,
        merged: false,
        reason: "Verdict accept check did not pass (Requirement 24.5)",
      };
    }
    if (!isCheckPassing(testsCheck)) {
      return {
        ok: false,
        merged: false,
        reason: "Verdict tests check did not pass (Requirement 24.5)",
      };
    }

    const verdictRecordSha256 =
      typeof verdictRecord.candidateSha256 === "string"
        ? verdictRecord.candidateSha256
        : typeof verdictRecord.sha256 === "string"
        ? verdictRecord.sha256
        : undefined;

    if (
      !verdictRecordSha256 ||
      typeof verdictRecordSha256 !== "string" ||
      !verdictRecordSha256.trim()
    ) {
      return {
        ok: false,
        merged: false,
        reason: "Verdict candidateSha256 is required (Requirement 25.6, 25.8)",
      };
    }

    if (
      options.verdictCandidateSha256 !== undefined &&
      (typeof options.verdictCandidateSha256 !== "string" ||
        !options.verdictCandidateSha256.trim())
    ) {
      return {
        ok: false,
        merged: false,
        reason: "Verdict candidateSha256 is required (Requirement 25.6, 25.8)",
      };
    }

    const rawGateResult =
      options.gateResult !== undefined
        ? options.gateResult
        : (options as any).gate;

    if (
      !rawGateResult ||
      typeof rawGateResult !== "object" ||
      Array.isArray(rawGateResult)
    ) {
      return {
        ok: false,
        merged: false,
        reason: "Grimoire gate result must be a non-null plain object (reject bare boolean) (Requirement 9.12, 25.7)",
      };
    }

    const gateObj = rawGateResult as Record<string, unknown>;
    if (gateObj.ok !== true) {
      return {
        ok: false,
        merged: false,
        reason: "Grimoire syntax gate result is not ok (Requirement 9.12, 25.7)",
      };
    }

    if (
      typeof gateObj.tree !== "string" ||
      !gateObj.tree.trim()
    ) {
      return {
        ok: false,
        merged: false,
        reason: "Grimoire gate result tree must be a non-empty string (Requirement 25.7)",
      };
    }

    const currentHeadSha = await this.getIntegrationHeadSha(runId, gitDir);
    if (currentHeadSha !== expectedIntegrationHeadSha) {
      return {
        ok: false,
        merged: false,
        previousHeadSha: currentHeadSha,
        reason: `Integration_Head moved during review (expected ${expectedIntegrationHeadSha}, got ${currentHeadSha}) (Requirement 25.8)`,
      };
    }

    const integrationBase =
      (options as any).integrationBaseSha ??
      (options as any).integrationBase ??
      options.baseSha ??
      expectedIntegrationHeadSha;

    if (!integrationBase || !SHA1_REGEX.test(integrationBase)) {
      return {
        ok: false,
        merged: false,
        previousHeadSha: currentHeadSha,
        reason: "integrationBase must match ^[0-9a-f]{40}$",
      };
    }

    if (integrationBase !== currentHeadSha) {
      return {
        ok: false,
        merged: false,
        previousHeadSha: currentHeadSha,
        reason: `integrationBase must equal the current head of the integration branch (expected ${currentHeadSha}, got ${integrationBase})`,
      };
    }

    const hostGitDir = resolveHostGitDir(gitDir);

    let actualTree = "";
    try {
      const treeRes = await this.#execGitInternal([
        "--git-dir",
        hostGitDir,
        "--work-tree",
        gitDir,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${candidateSha}^{tree}`,
      ]);
      actualTree = treeRes.stdout.trim();
    } catch (err: any) {
      return {
        ok: false,
        merged: false,
        reason: `Failed to resolve candidate tree: ${err?.message ?? String(err)}`,
      };
    }

    if (actualTree !== (gateObj.tree as string).trim()) {
      return {
        ok: false,
        merged: false,
        reason: `Candidate tree mismatch: expected ${actualTree}, got ${(gateObj.tree as string).trim()}`,
      };
    }

    const diffRes = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "diff",
      "--binary",
      "--no-color",
      "--end-of-options",
      `${integrationBase}..${candidateSha}`,
    ]);
    const computedCandidateSha256 = candidateSha256FromDiff(diffRes.stdout);

    if (
      verdictRecordSha256.trim().toLowerCase() !==
      computedCandidateSha256.toLowerCase()
    ) {
      return {
        ok: false,
        merged: false,
        previousHeadSha: currentHeadSha,
        reason:
          "Verdict candidateSha256 does not match candidate diff hash (Requirement 25.8)",
      };
    }

    if (
      options.verdictCandidateSha256 !== undefined &&
      (options.verdictCandidateSha256.trim().toLowerCase() !==
        computedCandidateSha256.toLowerCase() ||
        options.verdictCandidateSha256.trim().toLowerCase() !==
          verdictRecordSha256.trim().toLowerCase())
    ) {
      return {
        ok: false,
        merged: false,
        previousHeadSha: currentHeadSha,
        reason:
          "Verdict candidateSha256 does not match candidate diff hash (Requirement 25.8)",
      };
    }

    try {
      await this.#execGitInternal([
        "--git-dir",
        hostGitDir,
        "--work-tree",
        gitDir,
        "merge-base",
        "--is-ancestor",
        "--end-of-options",
        currentHeadSha,
        candidateSha,
      ]);
    } catch {
      return {
        ok: false,
        merged: false,
        previousHeadSha: currentHeadSha,
        reason:
          "Candidate is not a direct descendant of Integration_Head; fast-forward not possible",
      };
    }

    await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "update-ref",
      "--end-of-options",
      `refs/heads/${integrationBranch}`,
      candidateSha,
      currentHeadSha,
    ]);

    // VerifiedMerge is only issued after the ref has actually moved and the
    // expected sha was checked on the stored ref.
    const movedHeadRes = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${integrationBranch}`,
    ]);
    const movedHeadSha = movedHeadRes.stdout.trim();
    if (!isValidSha1(movedHeadSha) || movedHeadSha !== candidateSha) {
      return {
        ok: false,
        merged: false,
        previousHeadSha: currentHeadSha,
        reason: `Integration ref did not move to the candidate sha after update-ref (expected ${candidateSha}, got ${movedHeadSha}) (Requirement 25.8)`,
      };
    }

    return new VerifiedMerge(verifiedMergeToken, {
      runId,
      branch: integrationBranch,
      candidateSha,
      candidateSha256: computedCandidateSha256,
      newHeadSha: movedHeadSha,
      previousHeadSha: currentHeadSha,
    });
  }

  public async rollbackIntegrationRef(
    proof: VerifiedMerge,
    options: { gitDir?: string; runDir?: string } = {}
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!isVerifiedMerge(proof)) {
      throw new GitServiceError(
        "Proof must be a valid VerifiedMerge instance",
        "SECURITY_VIOLATION"
      );
    }
    assertValidSegmentId(proof.runId, "runId");
    if ((options as any).taskId !== undefined && (options as any).taskId !== null) {
      assertValidSegmentId((options as any).taskId, "taskId");
    }
    const runRoot = options.runDir ?? path.join(this.#runsDir, proof.runId);
    const gitDir = options.gitDir ?? path.join(runRoot, "git");
    const hostGitDir = resolveHostGitDir(gitDir);
    const targetRef = proof.branch.startsWith("refs/heads/")
      ? proof.branch
      : `refs/heads/${proof.branch}`;

    try {
      await this.#execGitInternal([
        "--git-dir",
        hostGitDir,
        "--work-tree",
        gitDir,
        "update-ref",
        "--end-of-options",
        targetRef,
        proof.previousHeadSha,
        proof.newHeadSha,
      ]);
      return { ok: true };
    } catch (err: any) {
      return {
        ok: false,
        reason: `Rollback update-ref failed: ${err?.message ?? String(err)}`,
      };
    }
  }

  public async getCandidateDiff(
    options: CandidateDiffOptions = {}
  ): Promise<CandidateDiffResult> {
    let gitDir = options.gitDir;
    if (!gitDir && options.runDir) {
      gitDir = path.join(options.runDir, "git");
    } else if (!gitDir && options.runId) {
      gitDir = path.join(this.runsDir, options.runId, "git");
    } else if (!gitDir) {
      gitDir = path.resolve("git");
    }

    const fromRef =
      options.fromRef ??
      options.baseSha ??
      (options.runId ? `graveyard/${options.runId}` : "HEAD");
    const toRef = options.toRef ?? options.candidateSha ?? "HEAD";
    assertValidRevision(fromRef, "fromRef");
    assertValidRevision(toRef, "toRef");

    const hostGitDir = resolveHostGitDir(gitDir);
    const diffRes = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "diff",
      "--binary",
      "--no-color",
      "--end-of-options",
      `${fromRef}..${toRef}`,
    ]);

    const filesRes = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "diff",
      "--name-only",
      "--end-of-options",
      `${fromRef}..${toRef}`,
    ]);

    const patch = diffRes.stdout;
    const files = filesRes.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    const sha256 = candidateSha256FromDiff(patch);
    const byteSize = Buffer.byteLength(patch, "utf8");

    return {
      patch,
      files,
      fromRef,
      toRef,
      sha256,
      byteSize,
    };
  }

  public async getCandidateFiles(
    fromRef: string,
    toRef: string,
    gitDir: string
  ): Promise<string[]> {
    assertValidRevision(fromRef, "fromRef");
    assertValidRevision(toRef, "toRef");
    const hostGitDir = resolveHostGitDir(gitDir);
    const filesRes = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "diff",
      "--name-only",
      "--end-of-options",
      `${fromRef}..${toRef}`,
    ]);
    return filesRes.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  public async exportAllPatch(
    options: ExportAllPatchOptions
  ): Promise<ExportAllPatchResult> {
    const { runId, baseSha } = options;
    const validRunId = assertValidSegmentId(runId, "runId");
    assertValidRevision(baseSha, "baseSha");
    const runRoot = options.runDir ?? path.join(this.runsDir, validRunId);
    const gitDir = options.gitDir ?? path.join(runRoot, "git");
    const integrationBranch =
      options.integrationBranch ?? `graveyard/${validRunId}`;
    assertValidRevision(integrationBranch, "integrationBranch");

    const hostGitDir = resolveHostGitDir(gitDir);
    const diffRes = await this.#execGitInternal([
      "--git-dir",
      hostGitDir,
      "--work-tree",
      gitDir,
      "diff",
      "--binary",
      "--no-color",
      "--end-of-options",
      `${baseSha}..refs/heads/${integrationBranch}`,
    ]);

    const patch = diffRes.stdout;
    const sha256 = candidateSha256FromDiff(patch);
    const byteSize = Buffer.byteLength(patch, "utf8");

    if (options.outputPath) {
      const parentDir = path.dirname(options.outputPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(options.outputPath, patch, "utf8");
    }

    return {
      patch,
      sha256,
      byteSize,
      outputPath: options.outputPath,
    };
  }

  public async pushToFork(
    runId: string,
    options: PushToForkOptions = {}
  ): Promise<PushToForkResult> {
    const effectiveRunId = (options.runId ?? runId)?.trim();
    if (!effectiveRunId || effectiveRunId.startsWith("-")) {
      throw new GitServiceError(
        "pushToFork requires a valid runId and must not begin with a dash",
        "INVALID_RUN_ID"
      );
    }
    assertValidSegmentId(effectiveRunId, "runId");
    if ((options as any).taskId !== undefined && (options as any).taskId !== null) {
      assertValidSegmentId((options as any).taskId, "taskId");
    }

    const targetUrl = (
      options.targetRepoUrl ??
      options.forkRemoteUrl ??
      this.forkRepoUrl
    )?.trim();

    if (!targetUrl) {
      throw new GitServiceError(
        "pushToFork refused: target fork URL is required (Requirement 29.2)",
        "MISSING_FORK_URL"
      );
    }

    const targetParsed = validateGithubTargetUrl(targetUrl);

    // Source repository URL check
    const sourceUrl = (options.sourceRepoUrl ?? this.sourceRepoUrl)?.trim();
    if (!sourceUrl) {
      throw new GitServiceError(
        "pushToFork refused: source repository URL is required (Requirement 29.2)",
        "MISSING_SOURCE_URL"
      );
    }

    if (hasEmbeddedCredentials(sourceUrl)) {
      throw new GitServiceError(
        "pushToFork refused: source repository URL contains embedded credentials",
        "INVALID_SOURCE_URL"
      );
    }

    const isValidSlugPart = (s: string) =>
      /^[A-Za-z0-9_.-]+$/.test(s) && s !== "." && s !== "..";

    const sourceParsed = extractOwnerRepo(sourceUrl);
    if (
      !sourceParsed ||
      !isValidSlugPart(sourceParsed.owner) ||
      !isValidSlugPart(sourceParsed.repo)
    ) {
      throw new GitServiceError(
        "pushToFork refused: unparsable source repository URL",
        "INVALID_SOURCE_URL"
      );
    }

    if (
      targetParsed.owner.toLowerCase() === sourceParsed.owner.toLowerCase() &&
      targetParsed.repo.toLowerCase() === sourceParsed.repo.toLowerCase()
    ) {
      throw new GitServiceError(
        "pushToFork refused: target repository cannot be the source repository (Requirement 29.7)",
        "SOURCE_WRITE_FORBIDDEN"
      );
    }

    // runPhase must be 'done'. A missing value is a refusal.
    if (options.runPhase !== "done") {
      throw new GitServiceError(
        `pushToFork refused: run phase must be 'done', but got '${options.runPhase}' (Requirement 29.3)`,
        "INVALID_RUN_PHASE"
      );
    }

    // invitePushFlag must be exactly true. A missing value is a refusal.
    if (options.invitePushFlag !== true) {
      throw new GitServiceError(
        "pushToFork refused: invite code does not have push flag enabled (Requirement 29.3)",
        "PUSH_FLAG_DISABLED"
      );
    }

    // Target owner must equal configured owner login, compared case-insensitively.
    const configuredOwner = (
      options.ownerLogin ??
      this.ownerLogin ??
      (typeof process !== "undefined"
        ? process.env?.GITHUB_OWNER_LOGIN ?? process.env?.OWNER_LOGIN
        : undefined)
    )?.trim();

    if (!configuredOwner) {
      throw new GitServiceError(
        "pushToFork refused: configured owner login is required (Requirement 29.2)",
        "MISSING_OWNER_LOGIN"
      );
    }

    if (targetParsed.owner.toLowerCase() !== configuredOwner.toLowerCase()) {
      throw new GitServiceError(
        `pushToFork refused: target repository owner '${targetParsed.owner}' does not match configured owner login '${configuredOwner}' (Requirement 29.2)`,
        "TARGET_NOT_OWNER_FORK"
      );
    }

    // Target must be a fork of source according to checker caller supplies.
    const checker =
      options.forkChecker ??
      options.checker ??
      options.checkFork ??
      this.forkChecker;

    if (!checker) {
      throw new GitServiceError(
        "pushToFork refused: fork checker is required (Requirement 29.2)",
        "MISSING_FORK_CHECKER"
      );
    }

    const targetFullName = `${targetParsed.owner}/${targetParsed.repo}`;
    let parentFullName: string | null | undefined;
    try {
      if (typeof checker === "function") {
        parentFullName = await checker(targetFullName, targetUrl);
        if (!parentFullName && targetUrl !== targetFullName) {
          const alt = await checker(targetUrl, targetFullName);
          if (alt) parentFullName = alt;
        }
      } else if (checker && typeof (checker as any).getParent === "function") {
        parentFullName = await (checker as any).getParent(
          targetFullName,
          targetUrl
        );
        if (!parentFullName && targetUrl !== targetFullName) {
          const alt = await (checker as any).getParent(
            targetUrl,
            targetFullName
          );
          if (alt) parentFullName = alt;
        }
      } else if (checker && typeof (checker as any).checkFork === "function") {
        parentFullName = await (checker as any).checkFork(
          targetFullName,
          targetUrl
        );
        if (!parentFullName && targetUrl !== targetFullName) {
          const alt = await (checker as any).checkFork(
            targetUrl,
            targetFullName
          );
          if (alt) parentFullName = alt;
        }
      }
    } catch (err: any) {
      throw new GitServiceError(
        `pushToFork refused: fork checker failed: ${err.message}`,
        "NOT_A_FORK"
      );
    }

    if (
      !parentFullName ||
      typeof parentFullName !== "string" ||
      !parentFullName.trim()
    ) {
      throw new GitServiceError(
        "pushToFork refused: target repository is not a verified fork of source repository (Requirement 29.2)",
        "NOT_A_FORK"
      );
    }

    const parentParsed = extractOwnerRepo(parentFullName.trim());
    if (
      !parentParsed ||
      !isValidSlugPart(parentParsed.owner) ||
      !isValidSlugPart(parentParsed.repo)
    ) {
      throw new GitServiceError(
        "pushToFork refused: fork checker returned invalid parent full name (Requirement 29.2)",
        "NOT_A_FORK"
      );
    }

    if (
      parentParsed.owner.toLowerCase() !== sourceParsed.owner.toLowerCase() ||
      parentParsed.repo.toLowerCase() !== sourceParsed.repo.toLowerCase()
    ) {
      throw new GitServiceError(
        `pushToFork refused: target repository parent '${parentParsed.owner}/${parentParsed.repo}' does not match source repository '${sourceParsed.owner}/${sourceParsed.repo}' (Requirement 29.2)`,
        "NOT_A_FORK"
      );
    }

    // Branch check
    const branch = `graveyard/${effectiveRunId}`;
    assertValidRevision(branch, "branch");
    if (options.branchName && options.branchName !== branch) {
      assertValidRevision(options.branchName, "branchName");
      throw new GitServiceError(
        `pushToFork refused: push must target branch '${branch}' only (Requirement 29.6)`,
        "INVALID_PUSH_BRANCH"
      );
    }

    // Token check: write token is GITHUB_WRITE_TOKEN only, no fallback to GITHUB_TOKEN
    const token = (
      options.token ??
      this.#githubWriteToken ??
      (typeof process !== "undefined"
        ? process.env?.GITHUB_WRITE_TOKEN
        : undefined)
    )?.trim();

    if (!token) {
      throw new GitServiceError(
        "pushToFork refused: GitHub write token is required (Requirement 29.1, 42.10)",
        "MISSING_WRITE_TOKEN"
      );
    }

    // GIT_ASKPASS helper script in fresh temporary directory with mode 0700
    const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-askpass-"));
    fs.chmodSync(askpassDir, 0o700);
    const helperScriptPath = path.join(askpassDir, "askpass.sh");
    const scriptContent = `#!/bin/sh
case "$1" in
  *[Uu]sername*)
    echo "x-access-token"
    ;;
  *)
    echo "\${GIT_WRITE_TOKEN:-\$GIT_ASKPASS_TOKEN}"
    ;;
esac
`;
    fs.writeFileSync(helperScriptPath, scriptContent, {
      mode: 0o700,
      encoding: "utf8",
    });
    fs.chmodSync(helperScriptPath, 0o700);

    const runRoot = options.runDir ?? path.join(this.runsDir, effectiveRunId);
    const gitDir = options.gitDir ?? path.join(runRoot, "git");
    const hostGitDir = resolveHostGitDir(gitDir);

    try {
      const shaRes = await this.#execGitInternal([
        "--git-dir",
        hostGitDir,
        "--work-tree",
        gitDir,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `refs/heads/${branch}`,
      ]);
      const commitSha = shaRes.stdout.trim();

      const pushRes = await this.#execGitInternal(
        [
          "-c",
          "protocol.https.allow=always",
          "--git-dir",
          hostGitDir,
          "--work-tree",
          gitDir,
          "push",
          "--",
          targetUrl,
          `refs/heads/${branch}:refs/heads/${branch}`,
        ],
        {
          env: {
            GIT_ASKPASS: helperScriptPath,
            GIT_TERMINAL_PROMPT: "0",
            GIT_WRITE_TOKEN: token,
            GIT_ASKPASS_TOKEN: token,
          },
        },
        true
      );

      return {
        ok: true,
        runId: effectiveRunId,
        branch,
        targetRepoUrl: targetUrl,
        commitSha,
        stdout: pushRes.stdout,
        stderr: pushRes.stderr,
      };
    } catch (err: any) {
      const cleanMessage = redactCredentials(err.message ?? "", token);
      const cleanStderr = redactCredentials(err.stderr ?? "", token);
      throw new GitServiceError(
        cleanMessage,
        err.code ?? "GIT_COMMAND_FAILED",
        err.exitCode,
        cleanStderr
      );
    } finally {
      try {
        fs.rmSync(askpassDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  public async cloneAndCreateBaseWorktree(
    options: CloneBaseOptions
  ): Promise<BaseWorktreeResult> {
    const cap =
      options.repositorySizeCap ??
      options.repoSizeCap ??
      options.sizeCap ??
      this.repositorySizeCap;

    const rawSize = options.size ?? options.metadata;
    if (rawSize !== undefined && cap !== undefined) {
      this.assertSizeWithinCap(rawSize, cap);
    }

    let gitDir = options.gitDir;
    let worktreeDir = options.worktreeDir;

    if (!gitDir || !worktreeDir) {
      let runRoot = options.runDir;
      if (!runRoot && options.runId) {
        runRoot = path.join(this.runsDir, options.runId);
      }
      if (runRoot) {
        gitDir = gitDir ?? path.join(runRoot, "git");
        worktreeDir = worktreeDir ?? path.join(runRoot, "builders", "base");
      } else {
        gitDir = gitDir ?? path.resolve("git");
        worktreeDir = worktreeDir ?? path.resolve("builders/base");
      }
    }

    await this.cloneRepo(options.repoUrl, gitDir, options.baseSha);
    await this.createBaseWorktree(gitDir, worktreeDir, options.baseSha);

    if (options.runId) {
      await this.createIntegrationHead({
        runId: options.runId,
        baseSha: options.baseSha,
        gitDir,
      });
    }

    return {
      gitDir,
      worktreeDir,
      baseSha: options.baseSha,
    };
  }

  public async cloneBase(
    options: CloneBaseOptions
  ): Promise<BaseWorktreeResult> {
    return this.cloneAndCreateBaseWorktree(options);
  }

  public async cloneBaseWorktree(
    options: CloneBaseOptions
  ): Promise<BaseWorktreeResult> {
    return this.cloneAndCreateBaseWorktree(options);
  }

  public static async cloneAndCreateBaseWorktree(
    options: CloneBaseOptions
  ): Promise<BaseWorktreeResult> {
    const service = new GitService({
      repositorySizeCap:
        options.repositorySizeCap ?? options.repoSizeCap ?? options.sizeCap,
      runsDir: options.runDir ? path.dirname(options.runDir) : undefined,
    });
    return service.cloneAndCreateBaseWorktree(options);
  }

  public static async cloneBase(
    options: CloneBaseOptions
  ): Promise<BaseWorktreeResult> {
    return GitService.cloneAndCreateBaseWorktree(options);
  }

  public static async getIntegrationHeadSha(
    runId: string,
    gitDir?: string
  ): Promise<string> {
    const service = new GitService();
    return service.getIntegrationHeadSha(runId, gitDir);
  }

  public static async createTaskWorktree(
    options: CreateTaskWorktreeOptions
  ): Promise<TaskWorktreeResult> {
    const service = new GitService();
    return service.createTaskWorktree(options);
  }

  public static async removeTaskWorktree(
    optionsOrRunId: RemoveTaskWorktreeOptions | string,
    taskId?: string,
    gitDir?: string,
    worktreeDir?: string
  ): Promise<void> {
    const service = new GitService();
    return service.removeTaskWorktree(
      optionsOrRunId,
      taskId,
      gitDir,
      worktreeDir
    );
  }

  public static async withTaskWorktree<T>(
    options: CreateTaskWorktreeOptions,
    fn: (worktree: TaskWorktreeResult) => Promise<T>
  ): Promise<T> {
    const service = new GitService();
    return service.withTaskWorktree(options, fn);
  }

  public static async rebaseCandidate(
    options: RebaseTaskOptions
  ): Promise<RebaseResult> {
    const service = new GitService();
    return service.rebaseCandidate(options);
  }

  public static async getCandidateDiff(
    options: CandidateDiffOptions = {}
  ): Promise<CandidateDiffResult> {
    const service = new GitService();
    return service.getCandidateDiff(options);
  }

  public static async exportAllPatch(
    options: ExportAllPatchOptions
  ): Promise<ExportAllPatchResult> {
    const service = new GitService();
    return service.exportAllPatch(options);
  }

  public static async pushToFork(
    runId: string,
    options: PushToForkOptions = {}
  ): Promise<PushToForkResult> {
    const service = new GitService();
    return service.pushToFork(runId, options);
  }
}

export default GitService;
