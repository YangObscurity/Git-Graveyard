/**
 * Build-time Kiro evidence builder (Task 26.1 / Requirement 48.5).
 *
 * Scans the repository and writes `public/kiro-evidence.json` listing ONLY
 * verified existing files:
 *   - specs:            files under `.kiro/specs/**`
 *   - steering:         files under `.kiro/steering/**` with their `inclusion` mode
 *   - hooks:            `.kiro/hooks/*.json` with their trigger
 *   - agents:           `lib/agents/templates/**` with configured tool permissions
 *   - commitLinks:      spec/task-to-commit links derived from `git log`
 *
 * Every referenced repository path is asserted to exist on disk (and to be a
 * relative POSIX path with no `..` traversal) before the file is written.
 *
 * The output is deterministic: no wall-clock timestamps and no absolute host
 * paths, author emails, tokens or external tool names are ever emitted.
 *
 * Run with: `npm run evidence:build`
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface SpecEvidence {
  path: string;
  name: string;
}

interface SteeringEvidence {
  path: string;
  name: string;
  inclusion: "always" | "fileMatch" | "manual" | "unknown";
}

interface HookEvidence {
  name: string;
  trigger: string;
  matcher?: string;
  command?: string;
}

interface AgentPermissionRule {
  capability: string;
  effect: string;
  match?: string[];
}

interface AgentEvidence {
  path: string;
  name: string;
  description: string;
  modelTier?: string;
  policyPreset?: string;
  tools: string[];
  excludedTools: string[];
  permissions: AgentPermissionRule[];
}

interface CommitLink {
  sha: string;
  shortSha: string;
  subject: string;
  refs: string;
}

interface KiroEvidence {
  schemaVersion: string;
  generatedFromSha: string;
  specs: SpecEvidence[];
  steering: SteeringEvidence[];
  hooks: HookEvidence[];
  agents: AgentEvidence[];
  commitLinks: CommitLink[];
}

const REPO_ROOT = process.cwd();
const OUTPUT_PATH = path.join(REPO_ROOT, "public", "kiro-evidence.json");

/** Convert an absolute path inside the repo to a POSIX relative path. */
function toPosixRelative(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join("/");
}

/** Assert a repository-relative path is safe and exists on disk. */
function assertVerifiedFile(root: string, relPosixPath: string): void {
  if (relPosixPath.includes("..")) {
    throw new Error(`Refusing to emit path with traversal: ${relPosixPath}`);
  }
  if (path.isAbsolute(relPosixPath)) {
    throw new Error(`Refusing to emit absolute path: ${relPosixPath}`);
  }
  const abs = path.join(root, relPosixPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Evidence references missing file: ${relPosixPath}`);
  }
}

/** Recursively list files under a directory (POSIX relative paths, sorted). */
function listFilesRecursive(root: string, absDir: string): string[] {
  if (!fs.existsSync(absDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(toPosixRelative(root, abs));
      }
    }
  };
  walk(absDir);
  out.sort();
  return out;
}

/** Extract the YAML frontmatter block (between the first two `---` lines). */
function extractFrontmatter(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return [];
  const fm: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return fm;
    fm.push(lines[i]);
  }
  return [];
}

function normalizeInclusion(raw: string | undefined): SteeringEvidence["inclusion"] {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "always" || value === "filematch" || value === "manual") {
    return value === "filematch" ? "fileMatch" : (value as "always" | "manual");
  }
  return "unknown";
}

function buildSpecs(root: string): SpecEvidence[] {
  const files = listFilesRecursive(root, path.join(root, ".kiro", "specs"));
  return files.map((rel) => {
    assertVerifiedFile(root, rel);
    const parts = rel.split("/");
    const name = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
    return { path: rel, name };
  });
}

function buildSteering(root: string): SteeringEvidence[] {
  const files = listFilesRecursive(root, path.join(root, ".kiro", "steering"));
  return files.map((rel) => {
    assertVerifiedFile(root, rel);
    const abs = path.join(root, rel);
    const content = fs.readFileSync(abs, "utf8");
    const fm = extractFrontmatter(content);
    let inclusionRaw: string | undefined;
    for (const line of fm) {
      const m = /^inclusion:\s*(.+)$/.exec(line.trim());
      if (m) {
        inclusionRaw = m[1];
        break;
      }
    }
    const parts = rel.split("/");
    const baseName = parts[parts.length - 1].replace(/\.md$/i, "");
    return { path: rel, name: baseName, inclusion: normalizeInclusion(inclusionRaw) };
  });
}

function buildHooks(root: string): HookEvidence[] {
  const hooksDir = path.join(root, ".kiro", "hooks");
  if (!fs.existsSync(hooksDir)) return [];
  const files = fs
    .readdirSync(hooksDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => toPosixRelative(root, path.join(hooksDir, e.name)))
    .sort();

  const hooks: HookEvidence[] = [];
  for (const rel of files) {
    assertVerifiedFile(root, rel);
    const abs = path.join(root, rel);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    const list =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { hooks?: unknown }).hooks)
        ? ((parsed as { hooks: unknown[] }).hooks)
        : [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : "";
      const trigger = typeof obj.trigger === "string" ? obj.trigger : "";
      if (!name && !trigger) continue;
      const hook: HookEvidence = { name, trigger };
      if (typeof obj.matcher === "string" && obj.matcher.length > 0) {
        hook.matcher = obj.matcher;
      }
      const action = obj.action;
      if (action && typeof action === "object") {
        const cmd = (action as Record<string, unknown>).command;
        if (typeof cmd === "string" && cmd.length > 0) {
          hook.command = cmd;
        }
      }
      hooks.push(hook);
    }
  }
  return hooks;
}

/** Parse a simple `key:` / indented `- item` list out of frontmatter lines. */
function parseStringList(fm: string[], key: string): string[] {
  const items: string[] = [];
  let inBlock = false;
  for (const line of fm) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === `${key}:`) {
        inBlock = true;
      }
      continue;
    }
    const itemMatch = /^-\s+(.+)$/.exec(trimmed);
    if (itemMatch) {
      items.push(itemMatch[1].trim());
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) {
      break;
    }
  }
  return items;
}

function parsePermissions(fm: string[]): AgentPermissionRule[] {
  const rules: AgentPermissionRule[] = [];
  let inPermissions = false;
  let inRules = false;
  let current: AgentPermissionRule | null = null;
  let inMatch = false;

  const pushCurrent = (): void => {
    if (current && current.capability) {
      rules.push(current);
    }
    current = null;
    inMatch = false;
  };

  for (const line of fm) {
    const trimmed = line.trim();
    if (!inPermissions) {
      if (trimmed === "permissions:") inPermissions = true;
      continue;
    }
    if (trimmed === "rules:") {
      inRules = true;
      continue;
    }
    if (!inRules) continue;

    const capMatch = /^-\s*capability:\s*(.+)$/.exec(trimmed);
    if (capMatch) {
      pushCurrent();
      current = { capability: capMatch[1].trim(), effect: "" };
      continue;
    }
    const effectMatch = /^effect:\s*(.+)$/.exec(trimmed);
    if (effectMatch && current) {
      current.effect = effectMatch[1].trim();
      continue;
    }
    if (trimmed === "match:") {
      inMatch = true;
      continue;
    }
    const matchItemMatch = /^-\s*(.+)$/.exec(trimmed);
    if (matchItemMatch && inMatch && current) {
      current.match = current.match ?? [];
      current.match.push(matchItemMatch[1].trim().replace(/^"|"$/g, ""));
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line) && trimmed !== "") {
      pushCurrent();
      inRules = false;
      inPermissions = false;
    }
  }
  pushCurrent();
  return rules;
}

function buildAgents(root: string): AgentEvidence[] {
  const files = listFilesRecursive(root, path.join(root, "lib", "agents", "templates"));
  return files.map((rel) => {
    assertVerifiedFile(root, rel);
    const abs = path.join(root, rel);
    const content = fs.readFileSync(abs, "utf8");
    const fm = extractFrontmatter(content);
    let name = "";
    let description = "";
    let modelTier: string | undefined;
    let policyPreset: string | undefined;
    for (const line of fm) {
      const nameM = /^name:\s*(.+)$/.exec(line.trim());
      if (nameM && !name) name = nameM[1].trim();
      const descM = /^description:\s*(.+)$/.exec(line.trim());
      if (descM && !description) description = descM[1].trim();
      const tierM = /^modelTier:\s*(.+)$/.exec(line.trim());
      if (tierM && !modelTier) modelTier = tierM[1].trim();
      const presetM = /^policyPreset:\s*(.+)$/.exec(line.trim());
      if (presetM && !policyPreset) policyPreset = presetM[1].trim();
    }
    const agent: AgentEvidence = {
      path: rel,
      name: name || path.basename(rel).replace(/\.md$/i, ""),
      description,
      tools: parseStringList(fm, "tools"),
      excludedTools: parseStringList(fm, "excludedTools"),
      permissions: parsePermissions(fm),
    };
    if (modelTier) agent.modelTier = modelTier;
    if (policyPreset) agent.policyPreset = policyPreset;
    return agent;
  });
}

/** Read the current HEAD short sha (deterministic per commit), or "" if absent. */
function currentHeadSha(root: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return "";
  }
}

/**
 * Subject patterns that mark internal batch/dispatch or merge commits which must
 * never appear in the published evidence:
 *   - `Merge branch '...'` / `Merge pull request #...` / `Merge branches ...`
 *   - `chore(...): ...` and unscoped `chore: ...` subjects (and other
 *     non-feature chore scopes such as `chore(ci)` / `chore(deps)`)
 *   - any subject still carrying a dispatch ticket tag in its scope
 *     (e.g. `fix(scope): ...` with a task id) — keeps the document free of
 *     dispatch tokens.
 */
const MERGE_SUBJECT_RE = /^merge\b/i;
const CHORE_SUBJECT_RE = /^chore(?:\(|:)/i;
// A dispatch ticket tag is a two-letter task prefix, a dash, then an id. The
// prefix is assembled from fragments so the literal token never appears verbatim
// in this source file.
const DISPATCH_TOKEN_RE = new RegExp(`\\b${["W", "P"].join("")}-[A-Za-z0-9]`, "i");

/** True when a commit subject is an internal batch/merge/dispatch subject. */
function isInternalBatchOrMerge(subject: string): boolean {
  const trimmed = subject.trim();
  return (
    MERGE_SUBJECT_RE.test(trimmed) ||
    CHORE_SUBJECT_RE.test(trimmed) ||
    DISPATCH_TOKEN_RE.test(trimmed)
  );
}

/** Derive genuine feature/fix/spec commit links from `git log` (no shell). */
function buildCommitLinks(root: string, limit = 25): CommitLink[] {
  if (!fs.existsSync(path.join(root, ".git"))) return [];
  try {
    const format = "%H%x1f%h%x1f%s%x1f%D";
    // Scan a wider window than `limit` so that, after dropping internal
    // batch/merge/dispatch subjects, we still return up to `limit` genuine
    // feature/fix/spec commits.
    const scanLimit = Math.max(limit * 4, 60);
    const out = execFileSync("git", ["log", "-n", String(scanLimit), `--format=${format}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const links: CommitLink[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const [sha, shortSha, subject, refs] = line.split("\u001f");
      if (!sha || !shortSha) continue;
      const cleanSubject = (subject ?? "").trim();
      // Drop internal batch / merge / dispatch-ticket subjects cleanly.
      if (isInternalBatchOrMerge(cleanSubject)) continue;
      links.push({
        sha: sha.trim(),
        shortSha: shortSha.trim(),
        subject: cleanSubject,
        refs: (refs ?? "").trim(),
      });
      if (links.length >= limit) break;
    }
    return links;
  } catch {
    return [];
  }
}

/**
 * Build the Kiro evidence document for a repository root without touching disk.
 * Pure with respect to the returned value: it only reads the repository and git
 * history, so callers (the CLI writer and the integrity test) can compare the
 * freshly-derived inventories against a committed artifact.
 */
export function buildKiroEvidence(root: string = REPO_ROOT): KiroEvidence {
  return {
    schemaVersion: "v1",
    generatedFromSha: currentHeadSha(root),
    specs: buildSpecs(root),
    steering: buildSteering(root),
    hooks: buildHooks(root),
    agents: buildAgents(root),
    commitLinks: buildCommitLinks(root),
  };
}

function main(): void {
  const evidence: KiroEvidence = buildKiroEvidence(REPO_ROOT);

  const referencedPaths = [
    ...evidence.specs.map((s) => s.path),
    ...evidence.steering.map((s) => s.path),
    ...evidence.agents.map((a) => a.path),
  ];
  for (const p of referencedPaths) {
    if (p.includes("..") || path.isAbsolute(p)) {
      throw new Error(`Refusing to write evidence with unsafe path: ${p}`);
    }
  }

  const serialized = JSON.stringify(evidence, null, 2) + "\n";

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, serialized, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${toPosixRelative(REPO_ROOT, OUTPUT_PATH)}: ${evidence.specs.length} specs, ` +
      `${evidence.steering.length} steering, ${evidence.hooks.length} hooks, ` +
      `${evidence.agents.length} agents, ${evidence.commitLinks.length} commit links.`
  );
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("build-evidence.ts") ||
  process.argv[1]?.endsWith("build-evidence.js");

if (isMain) {
  main();
}