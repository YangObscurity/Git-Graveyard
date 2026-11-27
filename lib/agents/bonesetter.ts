// Task 20.1: Bonesetter agent template validation and lifecycle manager
// Requirements: 14.1, 14.2, 14.5, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 14.15, 14.18
//
// The Bonesetter is a builder Skeleton that repairs package manifests and lock
// files inside its own worktree under the read-workspace policy preset. This
// module validates the committed template, confines writes to manifest and
// lockfile names, bundles bounded Grimoire steering resources, and provisions
// the isolated Skeleton environment on the pinned Claude Sonnet 5.5 model.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_SONNET_5_5_MODEL_ID } from "./model-allowlist";
import {
  provisionSkeletonEnvironment,
  resolveSkeletonPaths,
  type SkeletonPaths,
} from "../supervisor/skeleton-env";

/**
 * Exact list of manifest and lockfile globs the Bonesetter may write, matching
 * the allow rule in lib/agents/templates/bonesetter.md.
 * Requirements: 14.5, 14.9.
 */
export const BONESETTER_MANIFEST_ALLOW_PATTERNS = [
  "**/package.json",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/poetry.lock",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/setup.py",
  "**/pyproject.toml",
  "**/requirements*.txt",
] as const;

/** Hard limits for bundled steering resources (Requirement 14.14). */
export const BONESETTER_MAX_STEERING_FILES = 32;
export const BONESETTER_MAX_STEERING_CHARS = 100_000;

/** Relative folder inside the worktree where Grimoire guidance is written. */
export const BONESETTER_STEERING_RELATIVE_DIR = path.join(".kiro", "steering");

function isDeniedSecretSegment(segment: string): boolean {
  if (segment === ".env" || segment.startsWith(".env.")) {
    return true;
  }
  if (segment.toLowerCase().endsWith(".pem")) {
    return true;
  }
  if (segment.startsWith("id_")) {
    return true;
  }
  return false;
}

/**
 * The exact set of manifest and lock file names the Bonesetter may write at the
 * cwd root. This is the authoritative, single-source write set shared by the
 * Bonesetter tool client and the PermissionBroker: a manifest or lock name that
 * is NOT one of these ten is never writable, even when the broader broker
 * `MANIFEST_LOCK_FILENAMES` list contains it.
 *
 * The ten names are exactly the intersection of the broker's
 * `MANIFEST_LOCK_FILENAMES` and the Bonesetter template allow patterns:
 * `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
 * `pnpm-lock.yaml`, `poetry.lock`, `pipfile`, `pipfile.lock`, `pyproject.toml`
 * and `requirements.txt`.
 */
export const BONESETTER_WRITABLE_FILENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "requirements.txt",
]);

/**
 * Pure check that a path is writable by the Bonesetter: only a manifest or
 * lockfile name at the cwd root that is in `BONESETTER_WRITABLE_FILENAMES`.
 * Strictly rejects nested manifest paths (e.g. `packages/app/package.json`),
 * `.git/**`, `.kiro/**`, secret names (`.env*`, `*.pem`, `id_*`), `../`
 * traversal, absolute paths, leading/trailing whitespace, and any
 * arbitrary source file such as `.ts`, `.js`, `.py`.
 *
 * Only the exact intersection of the broker's manifest/lock names and the
 * Bonesetter template allow patterns is writable: a broker-only name
 * (`cargo.toml`, `setup.cfg`, `go.mod`, `Gemfile`, ...) or a template-only glob
 * (`setup.py`, `requirements*.txt` beyond `requirements.txt`) is rejected even
 * though one side alone would permit it.
 * Requirements: 14.5, 14.9, 14.10, 14.11.
 */
export function isBonesetterWritablePath(filePath: string): boolean {
  if (typeof filePath !== "string") {
    return false;
  }
  // Never silently `.trim()` a padded path into an allowed name.
  if (filePath !== filePath.trim()) {
    return false;
  }
  const raw = filePath;
  if (raw.length === 0 || raw.includes("\0")) {
    return false;
  }

  const normalized = raw.replace(/\\/g, "/");

  // Absolute paths (POSIX or Windows drive) live outside the worktree.
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return false;
  }

  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return false;
  }
  // Reject traversal and the protected directories.
  if (segments.some((s) => s === "..")) {
    return false;
  }
  if (segments.some((s) => s === ".")) {
    return false;
  }
  if (segments.some((s) => s === ".git" || s === ".kiro")) {
    return false;
  }
  if (segments.some((s) => isDeniedSecretSegment(s))) {
    return false;
  }

  // Manifest and lock names are matched only at the cwd root by exact relative
  // path; a nested path is never writable. A root name is writable only when it
  // is in the exact shared intersection set.
  const rel = segments.join("/");
  if (rel.includes("/")) {
    return false;
  }
  return BONESETTER_WRITABLE_FILENAMES.has(rel.toLowerCase());
}

// ---------------------------------------------------------------------------
// Template parsing & validation (Requirements 14.5, 14.9, 14.10, 14.11, 14.12, 14.18)
// ---------------------------------------------------------------------------

export interface BonesetterTemplateRule {
  capability: string;
  effect: string;
  match: string[];
}

export interface BonesetterTemplateInfo {
  name: string | null;
  description: string | null;
  model: string | null;
  modelTier: string | null;
  policyPreset: string | null;
  includeMcpJson: boolean | null;
  includePowers: boolean | null;
  tools: string[];
  excludedTools: string[];
  rules: BonesetterTemplateRule[];
}

function moduleDir(): string {
  return typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBoolean(value: string): boolean | null {
  const norm = value.trim().toLowerCase();
  if (norm === "true") {
    return true;
  }
  if (norm === "false") {
    return false;
  }
  return null;
}

/**
 * Minimal, dependency-free parser for the Bonesetter template frontmatter. It
 * understands only the shapes the committed template uses: top-level scalars,
 * top-level `tools` / `excludedTools` lists, and `permissions.rules` entries with
 * an optional `match` list.
 */
function parseBonesetterTemplate(content: string): BonesetterTemplateInfo {
  const normalized = content.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!fm) {
    throw new Error(
      "Invalid Bonesetter template: missing YAML frontmatter delimited by ---"
    );
  }

  const info: BonesetterTemplateInfo = {
    name: null,
    description: null,
    model: null,
    modelTier: null,
    policyPreset: null,
    includeMcpJson: null,
    includePowers: null,
    tools: [],
    excludedTools: [],
    rules: [],
  };

  type Section = "none" | "tools" | "excludedTools" | "rules";
  let section: Section = "none";
  let currentRule: BonesetterTemplateRule | null = null;
  let inRuleMatch = false;

  for (const rawLine of fm[1].split("\n")) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = trimmedLine;

    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (section === "tools" && indent <= 2) {
        info.tools.push(unquote(item));
        continue;
      }
      if (section === "excludedTools" && indent <= 2) {
        info.excludedTools.push(unquote(item));
        continue;
      }
      if (section === "rules") {
        if (indent >= 4 && item.includes(":")) {
          const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(item);
          currentRule = {
            capability: match ? unquote(match[2]) : "",
            effect: "",
            match: [],
          };
          info.rules.push(currentRule);
          inRuleMatch = false;
          continue;
        }
        if (indent >= 6 && inRuleMatch && currentRule) {
          currentRule.match.push(unquote(item));
          continue;
        }
      }
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_.]+):\s*(.*)$/.exec(line);
    if (!keyMatch) {
      continue;
    }
    const key = keyMatch[1];
    const value = keyMatch[2];

    if (indent === 0) {
      inRuleMatch = false;
      switch (key) {
        case "name":
          info.name = unquote(value);
          section = "none";
          break;
        case "description":
          info.description = unquote(value);
          section = "none";
          break;
        case "model":
          info.model = unquote(value);
          section = "none";
          break;
        case "modelTier":
          info.modelTier = unquote(value);
          section = "none";
          break;
        case "policyPreset":
          info.policyPreset = unquote(value);
          section = "none";
          break;
        case "includeMcpJson":
          info.includeMcpJson = parseBoolean(value);
          section = "none";
          break;
        case "includePowers":
          info.includePowers = parseBoolean(value);
          section = "none";
          break;
        case "tools":
          section = "tools";
          break;
        case "excludedTools":
          section = "excludedTools";
          break;
        default:
          section = "none";
          break;
      }
      continue;
    }

    if (indent === 2 && key === "rules") {
      section = "rules";
      continue;
    }
    if (section === "rules" && currentRule) {
      if (key === "capability") {
        currentRule.capability = unquote(value);
        inRuleMatch = false;
        continue;
      }
      if (key === "effect") {
        currentRule.effect = unquote(value);
        inRuleMatch = false;
        continue;
      }
      if (key === "match") {
        inRuleMatch = true;
        continue;
      }
    }
  }

  return info;
}

function resolveTemplateContent(input?: string): string {
  if (input === undefined) {
    const candidates = [
      path.resolve(moduleDir(), "templates", "bonesetter.md"),
      path.resolve(process.cwd(), "lib/agents/templates/bonesetter.md"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf-8");
      }
    }
    throw new Error(
      `Invalid Bonesetter template: file not found (looked at ${candidates.join(", ")})`
    );
  }

  if (fs.existsSync(input) && fs.statSync(input).isFile()) {
    return fs.readFileSync(input, "utf-8");
  }

  // Raw frontmatter or file content always spans lines (or opens with the
  // frontmatter delimiter); only a single-line token can be a path.
  if (input.includes("\n") || input.trimStart().startsWith("---")) {
    return input;
  }

  const looksLikePath = /[\\/]/.test(input) || /\.(md|ya?ml|txt)$/i.test(input);
  if (looksLikePath) {
    throw new Error(`Invalid Bonesetter template: file not found (${input})`);
  }

  // Treat the argument as raw frontmatter content.
  return input;
}

export interface ValidatedBonesetterTemplate extends BonesetterTemplateInfo {
  manifestAllowPatterns: string[];
}

/**
 * Parses and validates the committed Bonesetter template (or a supplied path /
 * raw content). Throws a clear error when any guarantee is violated:
 * read-workspace preset, no MCP json, no powers, denied shell/web/subagent,
 * fs_read secret denies, fs_write `.git/**` / `.kiro/**` denies, and fs_write
 * allow rules that only cover manifest and lockfile globs.
 * Requirements: 14.5, 14.9, 14.10, 14.11, 14.12, 14.18.
 */
export function validateBonesetterTemplate(
  templatePathOrContent?: string
): ValidatedBonesetterTemplate {
  const content = resolveTemplateContent(templatePathOrContent);
  const info = parseBonesetterTemplate(content);
  const errors: string[] = [];

  if (info.policyPreset !== "read-workspace") {
    errors.push(
      `policyPreset must be "read-workspace" (got ${JSON.stringify(info.policyPreset)})`
    );
  }
  if (info.includeMcpJson !== false) {
    errors.push("includeMcpJson must be false");
  }
  if (info.includePowers !== false) {
    errors.push("includePowers must be false");
  }
  for (const tool of ["shell", "web", "subagent"]) {
    if (!info.excludedTools.includes(tool)) {
      errors.push(`excludedTools must contain "${tool}"`);
    }
  }

  // The template must be configured with all eight tools the Bonesetter tool
  // interface exposes. A missing tool would silently degrade the agent, so each
  // missing entry is reported with a clear message.
  for (const tool of [
    "read",
    "write",
    "sandbox_exec",
    "sandbox_log",
    "report_task_result",
    "ask",
    "report_blocker",
    "ack_message",
  ]) {
    if (!info.tools.includes(tool)) {
      errors.push(`tools must contain "${tool}"`);
    }
  }

  const fsReadDenyGlobs = new Set<string>();
  for (const rule of info.rules) {
    if (rule.capability === "fs_read" && rule.effect === "deny") {
      for (const glob of rule.match) {
        fsReadDenyGlobs.add(glob);
      }
    }
  }
  for (const glob of ["**/.env", "**/.env.*", "**/*.pem", "**/id_*"]) {
    if (!fsReadDenyGlobs.has(glob)) {
      errors.push(`fs_read deny rule must cover "${glob}"`);
    }
  }

  const fsWriteDenyGlobs = new Set<string>();
  for (const rule of info.rules) {
    if (rule.capability === "fs_write" && rule.effect === "deny") {
      for (const glob of rule.match) {
        fsWriteDenyGlobs.add(glob);
      }
    }
  }
  for (const glob of ["**/.git/**", "**/.kiro/**"]) {
    if (!fsWriteDenyGlobs.has(glob)) {
      errors.push(`fs_write deny rule must cover "${glob}"`);
    }
  }

  const allowedGlobs = new Set<string>(BONESETTER_MANIFEST_ALLOW_PATTERNS);
  const fsWriteAllowRules = info.rules.filter(
    (rule) => rule.capability === "fs_write" && rule.effect === "allow"
  );
  if (fsWriteAllowRules.length === 0) {
    errors.push("fs_write allow rule for manifest and lockfile names is missing");
  }
  for (const rule of fsWriteAllowRules) {
    if (rule.match.length === 0) {
      errors.push("fs_write allow rule must list at least one manifest glob");
    }
    for (const glob of rule.match) {
      if (!allowedGlobs.has(glob)) {
        errors.push(`fs_write allow rule must only cover manifest/lockfile globs (found "${glob}")`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid Bonesetter template: ${errors.join("; ")}`);
  }

  return {
    ...info,
    manifestAllowPatterns: [...BONESETTER_MANIFEST_ALLOW_PATTERNS],
  };
}

// ---------------------------------------------------------------------------
// Bounded steering resources (Requirement 14.14)
// ---------------------------------------------------------------------------

export interface GrimoireGuidanceEntry {
  fileName?: string;
  content: string;
}

export interface BundleBonesetterSteeringResourcesOptions {
  targetDir: string;
  grimoireGuidance: Array<{ fileName?: string; content: string }>;
  maxFiles?: number;
  maxTotalChars?: number;
  /**
   * Trusted worktree root the steering target directory must stay strictly inside.
   * When set, symlinked components (`.kiro`, `.kiro/steering`, …)
   * and target files are refused and the resolved target must stay within the
   * resolved worktree root.
   */
  worktreeDir?: string;
}

export interface BundledSteeringFile {
  fileName: string;
  filePath: string;
  chars: number;
  truncated: boolean;
}

export interface RejectedSteeringFile {
  fileName: string;
  reason: "max_files_exceeded" | "max_total_chars_exceeded";
}

export interface BundledSteeringResources {
  targetDir: string;
  files: BundledSteeringFile[];
  rejected: RejectedSteeringFile[];
  totalFiles: number;
  totalChars: number;
  truncated: boolean;
}

function safeSteeringFileName(
  requested: string | undefined,
  index: number,
  used: Set<string>
): string {
  const fallback = `guidance-${index + 1}.md`;
  let candidate =
    typeof requested === "string" && requested.trim().length > 0
      ? requested.trim()
      : fallback;
  // Strip any directory component to prevent traversal.
  candidate = candidate.replace(/\\/g, "/").split("/").pop() ?? fallback;
  candidate = path.basename(candidate);
  if (candidate === "." || candidate === ".." || candidate.length === 0) {
    candidate = fallback;
  }
  if (!candidate.toLowerCase().endsWith(".md")) {
    candidate = `${candidate}.md`;
  }
  candidate = candidate.replace(/[\0<>:"|?*]/g, "_");

  let unique = candidate;
  let n = 1;
  while (used.has(unique)) {
    unique = `${candidate.replace(/\.md$/i, "")}-${n}.md`;
    n += 1;
  }
  used.add(unique);
  return unique;
}

/** True when the path exists and is itself a symlink (never follows the link). */
function isSymbolicLinkSync(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when target is inside base or equal to it (lexical, after resolving). */
function isPathInsideDirSync(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Realpath of the deepest existing ancestor of `target`, with the non-existent
 * tail rejoined, so a not-yet-created directory still resolves against its real
 * parent.
 */
function realpathOfExistingPrefixSync(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(current);
  } catch {
    real = current;
  }
  return tail.length > 0 ? path.join(real, ...tail) : real;
}

/**
 * Writes the task's Grimoire guidance into the steering folder, enforcing the
 * hard limits of at most 32 files and at most 100,000 characters in total
 * (Requirement 14.14). Content beyond the character budget is truncated and
 * files beyond the file budget are rejected, deterministically and in input
 * order, so the limits are never exceeded.
 */
export function bundleBonesetterSteeringResources(
  options: BundleBonesetterSteeringResourcesOptions
): BundledSteeringResources {
  const maxFiles = options.maxFiles ?? BONESETTER_MAX_STEERING_FILES;
  const maxTotalChars = options.maxTotalChars ?? BONESETTER_MAX_STEERING_CHARS;
  if (!Number.isInteger(maxFiles) || maxFiles < 0) {
    throw new Error(`maxFiles must be a non-negative integer (got ${maxFiles})`);
  }
  if (!Number.isInteger(maxTotalChars) || maxTotalChars < 0) {
    throw new Error(
      `maxTotalChars must be a non-negative integer (got ${maxTotalChars})`
    );
  }

  const targetDir = path.resolve(options.targetDir);
  const entries = Array.isArray(options.grimoireGuidance)
    ? options.grimoireGuidance
    : [];
  const worktreeDir =
    typeof options.worktreeDir === "string" && options.worktreeDir.length > 0
      ? path.resolve(options.worktreeDir)
      : null;

  const files: BundledSteeringFile[] = [];
  const rejected: RejectedSteeringFile[] = [];
  const usedNames = new Set<string>();
  let totalChars = 0;
  let truncated = false;

  // Finding [10]: refuse a symlinked target directory outright, then verify the
  // whole chain from the trusted worktree root stays symlink-free and contained.
  if (isSymbolicLinkSync(targetDir)) {
    throw new Error(
      `refusing to write steering resources through the symlink at ${targetDir}`
    );
  }
  if (worktreeDir) {
    const rel = path.relative(worktreeDir, targetDir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `steering target directory ${targetDir} must live inside the worktree ${worktreeDir}`
      );
    }
    let current = worktreeDir;
    if (isSymbolicLinkSync(current)) {
      throw new Error(`refusing a symlinked worktree ${current}`);
    }
    for (const segment of rel.split(path.sep).filter((s) => s.length > 0)) {
      current = path.join(current, segment);
      if (isSymbolicLinkSync(current)) {
        throw new Error(
          `refusing to write steering resources through the symlink at ${current}`
        );
      }
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const realWorktree = realpathOfExistingPrefixSync(worktreeDir);
    const realTargetDir = fs.realpathSync(targetDir);
    if (!isPathInsideDirSync(realWorktree, realTargetDir)) {
      throw new Error(
        `steering target directory ${realTargetDir} escapes the worktree ${realWorktree}`
      );
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const targetPrefix = targetDir.endsWith(path.sep) ? targetDir : targetDir + path.sep;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const requestedName =
      entry && typeof entry.fileName === "string" ? entry.fileName : undefined;

    if (files.length >= maxFiles) {
      rejected.push({
        fileName: requestedName ?? `guidance-${index + 1}.md`,
        reason: "max_files_exceeded",
      });
      continue;
    }

    const remaining = maxTotalChars - totalChars;
    if (remaining <= 0) {
      rejected.push({
        fileName: requestedName ?? `guidance-${index + 1}.md`,
        reason: "max_total_chars_exceeded",
      });
      continue;
    }

    const rawContent = entry && typeof entry.content === "string" ? entry.content : "";
    let content = rawContent;
    let entryTruncated = false;
    if (content.length > remaining) {
      content = content.slice(0, remaining);
      entryTruncated = true;
      truncated = true;
    }

    const fileName = safeSteeringFileName(requestedName, index, usedNames);
    const filePath = path.resolve(targetDir, fileName);
    if (!filePath.startsWith(targetPrefix)) {
      rejected.push({ fileName, reason: "max_files_exceeded" });
      continue;
    }
    // Finding [10]: never write THROUGH a symlinked steering file.
    if (isSymbolicLinkSync(filePath)) {
      throw new Error(
        `refusing to write the steering file through the symlink at ${filePath}`
      );
    }

    fs.writeFileSync(filePath, content, "utf-8");
    files.push({
      fileName,
      filePath,
      chars: content.length,
      truncated: entryTruncated,
    });
    totalChars += content.length;
  }

  return {
    targetDir,
    files,
    rejected,
    totalFiles: files.length,
    totalChars,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Typed Bonesetter tool interface (Requirement 14.5)
// ---------------------------------------------------------------------------

export interface BonesetterReadArgs {
  path: string;
  [key: string]: unknown;
}

export interface BonesetterWriteArgs {
  path: string;
  content: string;
  [key: string]: unknown;
}

export interface BonesetterSandboxExecArgs {
  argv: string[];
  cwd?: string;
  timeout_s?: number;
  [key: string]: unknown;
}

export interface BonesetterSandboxLogArgs {
  log_ref: string;
  offset?: number;
  limit?: number;
  [key: string]: unknown;
}

export interface BonesetterReportTaskResultArgs {
  taskId: string;
  status: string;
  summary: string;
  refs?: string[];
  [key: string]: unknown;
}

export interface BonesetterAskArgs {
  text: string;
  [key: string]: unknown;
}

export interface BonesetterReportBlockerArgs {
  text: string;
  kind: string;
  [key: string]: unknown;
}

export interface BonesetterAckMessageArgs {
  msgId: string;
  [key: string]: unknown;
}

/**
 * The eight tools the Bonesetter agent is configured with. `write` enforces the
 * manifest/lockfile boundary before forwarding to the gateway.
 * Requirement 14.5.
 */
export interface BonesetterToolClient {
  read(args: BonesetterReadArgs): Promise<unknown>;
  write(args: BonesetterWriteArgs): Promise<unknown>;
  sandbox_exec(args: BonesetterSandboxExecArgs): Promise<unknown>;
  sandbox_log(args: BonesetterSandboxLogArgs): Promise<unknown>;
  report_task_result(args: BonesetterReportTaskResultArgs): Promise<unknown>;
  ask(args: BonesetterAskArgs): Promise<unknown>;
  report_blocker(args: BonesetterReportBlockerArgs): Promise<unknown>;
  ack_message(args: BonesetterAckMessageArgs): Promise<unknown>;
}

export interface BonesetterToolHandlers {
  read: (args: BonesetterReadArgs) => Promise<unknown>;
  write: (args: BonesetterWriteArgs) => Promise<unknown>;
  sandboxExec: (args: BonesetterSandboxExecArgs) => Promise<unknown>;
  sandboxLog: (args: BonesetterSandboxLogArgs) => Promise<unknown>;
  reportTaskResult: (args: BonesetterReportTaskResultArgs) => Promise<unknown>;
  ask: (args: BonesetterAskArgs) => Promise<unknown>;
  reportBlocker: (args: BonesetterReportBlockerArgs) => Promise<unknown>;
  ackMessage: (args: BonesetterAckMessageArgs) => Promise<unknown>;
}

export class BonesetterWriteDeniedError extends Error {
  readonly path: string;
  constructor(filePath: string) {
    super(
      `Bonesetter write denied: "${filePath}" is not a manifest or lockfile inside the worktree`
    );
    this.name = "BonesetterWriteDeniedError";
    this.path = filePath;
  }
}

/**
 * Builds the typed Bonesetter tool client over the supplied handlers. The `write`
 * method enforces `isBonesetterWritablePath` before forwarding, so an arbitrary
 * source file is rejected in code, not by convention.
 * Requirement 14.5.
 */
export function createBonesetterToolClient(
  handlers: BonesetterToolHandlers
): BonesetterToolClient {
  return {
    read: (args) => handlers.read(args),
    write: async (args) => {
      if (!isBonesetterWritablePath(args.path)) {
        throw new BonesetterWriteDeniedError(args.path);
      }
      return handlers.write(args);
    },
    sandbox_exec: (args) => handlers.sandboxExec(args),
    sandbox_log: (args) => handlers.sandboxLog(args),
    report_task_result: (args) => handlers.reportTaskResult(args),
    ask: (args) => handlers.ask(args),
    report_blocker: (args) => handlers.reportBlocker(args),
    ack_message: (args) => handlers.ackMessage(args),
  };
}

// ---------------------------------------------------------------------------
// Session preparation (Requirements 14.1, 14.2, 14.13, 14.14, 14.18)
// ---------------------------------------------------------------------------

export interface PrepareBonesetterSessionOptions {
  runId: string;
  skeletonId: string;
  worktreeDir: string;
  baseDir?: string;
  grimoireGuidance?: Array<{ fileName?: string; content: string }>;
  templatesDir?: string;
  /** Overrides the default `<worktreeDir>/.kiro/steering` target folder. */
  steeringDir?: string;
}

export interface PreparedBonesetterSession {
  paths: SkeletonPaths;
  modelId: typeof CLAUDE_SONNET_5_5_MODEL_ID;
  policyPreset: "read-workspace";
  manifestAllowPatterns: string[];
  steeringFiles: string[];
  steeringDir: string;
  worktreeDir: string;
  runId: string;
  skeletonId: string;
}

/**
 * Resolves the exact `bonesetter` template file `provisionSkeletonEnvironment`
 * reads from a custom `templatesDir`. `skeleton-env.ts` prefers `<role>.json`
 * over `<role>.md`, so the same order is mirrored here. A `.json` template cannot
 * be validated by the frontmatter rules (and must not silently shadow the
 * validated `.md`), so it is surfaced to `validateBonesetterTemplate`, which
 * rejects it. When neither file exists the `.md` path is returned so validation
 * throws a clear "file not found" error before any provisioning touches disk.
 */
function resolveBonesetterTemplatePath(templatesDir: string): string {
  const dir = path.resolve(templatesDir);
  for (const name of ["bonesetter.json", "bonesetter.md"]) {
    const candidate = path.join(dir, name);
    // `existsSync` follows symlinks, so a broken symlink reports "missing"; use
    // `lstatSync` to detect the entry itself (link included).
    let exists = false;
    try {
      fs.lstatSync(candidate);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      continue;
    }
    // Any entry that exists but is not a regular file (for example a directory
    // named `bonesetter.json`, or a broken symlink whose target `statSync`
    // cannot resolve) must be rejected immediately instead of silently falling
    // through to the next candidate. Otherwise `provisionSkeletonEnvironment`
    // would select the same directory and fail trying to read it.
    let isFile = false;
    try {
      isFile = fs.statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      throw new Error(
        `Invalid Bonesetter template path: ${candidate} is not a file`
      );
    }
    return candidate;
  }
  return path.join(dir, "bonesetter.md");
}

/**
 * Validates the Bonesetter template, provisions the isolated Skeleton paths on
 * the pinned Claude Sonnet 5.5 model, and writes the bounded Grimoire steering
 * resources for the task (Requirements 14.1, 14.2, 14.13, 14.14, 14.18).
 */
export function prepareBonesetterSession(
  options: PrepareBonesetterSessionOptions
): PreparedBonesetterSession {
  if (!options || typeof options !== "object") {
    throw new Error("prepareBonesetterSession requires options");
  }
  const { runId, skeletonId, worktreeDir } = options;
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error("prepareBonesetterSession requires a non-empty runId");
  }
  if (typeof skeletonId !== "string" || skeletonId.trim().length === 0) {
    throw new Error("prepareBonesetterSession requires a non-empty skeletonId");
  }
  if (typeof worktreeDir !== "string" || worktreeDir.trim().length === 0) {
    throw new Error("prepareBonesetterSession requires a non-empty worktreeDir");
  }

  // Treat an empty or whitespace-only templatesDir as "not provided" so the
  // committed default template is validated exactly as before.
  const customTemplatesDir =
    typeof options.templatesDir === "string" && options.templatesDir.trim().length > 0
      ? options.templatesDir.trim()
      : undefined;

  // Refuse to operate on a template that drifted from the committed guarantees.
  // When a custom templatesDir is supplied, the EXACT `bonesetter.md` that
  // provisionSkeletonEnvironment copies into the Skeleton is validated: a missing
  // file, a tampered preset, or widened write rules must throw here, BEFORE any
  // provisioning touches disk. Without this the default template would be
  // validated while a tampered custom one is provisioned.
  const validated = validateBonesetterTemplate(
    customTemplatesDir
      ? resolveBonesetterTemplatePath(customTemplatesDir)
      : undefined
  );

  const resolvedWorktreeDir = path.resolve(worktreeDir);
  const paths = resolveSkeletonPaths(runId, skeletonId, options.baseDir);

  provisionSkeletonEnvironment({
    paths,
    role: "bonesetter",
    templatesDir: customTemplatesDir,
    model: CLAUDE_SONNET_5_5_MODEL_ID,
  });

  const steeringDir = path.resolve(
    options.steeringDir ?? path.join(resolvedWorktreeDir, BONESETTER_STEERING_RELATIVE_DIR)
  );
  const worktreePrefix = resolvedWorktreeDir.endsWith(path.sep)
    ? resolvedWorktreeDir
    : resolvedWorktreeDir + path.sep;
  if (!steeringDir.startsWith(worktreePrefix) && steeringDir !== resolvedWorktreeDir) {
    throw new Error(
      `steeringDir must live inside the Bonesetter worktree (got ${steeringDir})`
    );
  }

  const bundled = bundleBonesetterSteeringResources({
    targetDir: steeringDir,
    grimoireGuidance: options.grimoireGuidance ?? [],
    worktreeDir: resolvedWorktreeDir,
  });

  return {
    paths,
    modelId: CLAUDE_SONNET_5_5_MODEL_ID,
    policyPreset: "read-workspace",
    manifestAllowPatterns: validated.manifestAllowPatterns,
    steeringFiles: bundled.files.map((file) => file.filePath),
    steeringDir,
    worktreeDir: resolvedWorktreeDir,
    runId,
    skeletonId,
  };
}
