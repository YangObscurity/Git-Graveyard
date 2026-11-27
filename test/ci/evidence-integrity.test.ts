import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Task 26.2 / Requirements 48.6 — CI verification of Kiro evidence integrity.
 *
 * Verifies that:
 *   - public/kiro-evidence.json exists and parses as JSON
 *   - it has the expected schema shape (arrays of specs, steering, hooks, agents, commitLinks)
 *   - it contains ZERO absolute paths and ZERO path traversal (`..`)
 *   - every file path listed (specs, steering, agents) exists on disk in the repo
 *   - every listed commit SHA resolves via `git cat-file -t <sha>` when `.git` is
 *     present, with a clean fallback for shallow clones
 */

const REPO_ROOT = process.cwd();
const EVIDENCE_PATH = path.join(REPO_ROOT, "public", "kiro-evidence.json");

interface SpecEntry {
  path: string;
  name: string;
}
interface SteeringEntry {
  path: string;
  name: string;
  inclusion: string;
}
interface HookEntry {
  name: string;
  trigger: string;
  matcher?: string;
  command?: string;
}
interface AgentEntry {
  path: string;
  name: string;
  description: string;
  tools: string[];
  excludedTools: string[];
  permissions: Array<{ capability: string; effect: string; match?: string[] }>;
}
interface CommitEntry {
  sha: string;
  shortSha: string;
  subject: string;
  refs: string;
}
interface EvidenceDoc {
  schemaVersion: string;
  generatedFromSha: string;
  specs: SpecEntry[];
  steering: SteeringEntry[];
  hooks: HookEntry[];
  agents: AgentEntry[];
  commitLinks: CommitEntry[];
}

function loadEvidence(): EvidenceDoc {
  assert.ok(fs.existsSync(EVIDENCE_PATH), "public/kiro-evidence.json must exist");
  const raw = fs.readFileSync(EVIDENCE_PATH, "utf8");
  let parsed: unknown;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(raw);
  }, "public/kiro-evidence.json must be valid JSON");
  return parsed as EvidenceDoc;
}

function isAbsolutePath(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // Windows-style absolute paths (drive letter or UNC) even on POSIX CI.
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (/^\\\\/.test(p)) return true;
  return false;
}

function gitAvailable(root: string = REPO_ROOT): boolean {
  if (!fs.existsSync(path.join(root, ".git"))) return false;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isShallow(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, ".git", "shallow"));
}

function catFileType(sha: string): string | null {
  try {
    const out = execFileSync("git", ["cat-file", "-t", sha], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

describe("Task 26.2 / Requirement 48.6: Kiro evidence integrity", () => {
  const evidence = loadEvidence();

  it("has the expected top-level schema shape", () => {
    assert.equal(typeof evidence.schemaVersion, "string");
    assert.ok(Array.isArray(evidence.specs), "specs must be an array");
    assert.ok(Array.isArray(evidence.steering), "steering must be an array");
    assert.ok(Array.isArray(evidence.hooks), "hooks must be an array");
    assert.ok(Array.isArray(evidence.agents), "agents must be an array");
    assert.ok(Array.isArray(evidence.commitLinks), "commitLinks must be an array");
  });

  it("lists only verified, existing repository files", () => {
    const filePaths = [
      ...evidence.specs.map((s) => s.path),
      ...evidence.steering.map((s) => s.path),
      ...evidence.agents.map((a) => a.path),
    ];
    assert.ok(filePaths.length > 0, "evidence must reference at least one file");
    for (const rel of filePaths) {
      assert.equal(typeof rel, "string");
      assert.ok(!isAbsolutePath(rel), `path must be relative, got absolute: ${rel}`);
      assert.ok(!rel.includes(".."), `path must not traverse, got: ${rel}`);
      const abs = path.join(REPO_ROOT, rel);
      assert.ok(fs.existsSync(abs), `referenced file must exist on disk: ${rel}`);
    }
  });

  it("contains zero absolute host paths anywhere in the document", () => {
    const serialized = JSON.stringify(evidence);
    for (const entry of [...evidence.specs, ...evidence.steering, ...evidence.agents]) {
      assert.ok(!isAbsolutePath(entry.path), `absolute path detected in evidence: ${entry.path}`);
    }
    assert.ok(!/\/home\/[^/"]+/.test(serialized), "evidence must not embed host /home paths");
    assert.ok(!/\/Users\/[^/"]+/.test(serialized), "evidence must not embed host /Users paths");
    assert.ok(!/[a-zA-Z]:\\\\/.test(serialized), "evidence must not embed Windows drive paths");
  });

  it("parses steering inclusion modes cleanly", () => {
    const allowed = new Set(["always", "fileMatch", "manual", "unknown"]);
    for (const s of evidence.steering) {
      assert.ok(allowed.has(s.inclusion), `steering ${s.path} has invalid inclusion: ${s.inclusion}`);
    }
  });

  it("parses hooks with a name and trigger", () => {
    for (const h of evidence.hooks) {
      assert.ok(h.name.length > 0, "hook must have a name");
      assert.ok(h.trigger.length > 0, "hook must have a trigger");
    }
  });

  it("parses agent templates with tool permissions", () => {
    for (const a of evidence.agents) {
      assert.ok(a.name.length > 0, "agent must have a name");
      assert.ok(Array.isArray(a.tools), "agent tools must be an array");
      assert.ok(Array.isArray(a.excludedTools), "agent excludedTools must be an array");
      assert.ok(Array.isArray(a.permissions), "agent permissions must be an array");
      for (const rule of a.permissions) {
        assert.ok(rule.capability.length > 0, "permission rule must have a capability");
        assert.ok(rule.effect.length > 0, "permission rule must have an effect");
      }
    }
  });

  it("resolves every listed commit SHA via git cat-file when git is present", (ctx) => {
    if (!gitAvailable()) {
      // Source-archive runs ship without a .git directory. The committed
      // evidence may legitimately list commit links, so skip Git object
      // resolution here rather than asserting the list is empty.
      ctx.skip("git is unavailable (source-archive run); skipping commit object resolution");
      return;
    }
    const shallow = isShallow();
    for (const link of evidence.commitLinks) {
      assert.match(link.sha, /^[0-9a-f]{7,40}$/, `invalid sha format: ${link.sha}`);
      assert.ok(link.shortSha.length > 0, "commit must have a short sha");
      const type = catFileType(link.sha);
      if (type === null) {
        if (!shallow) {
          assert.fail(`commit SHA does not resolve in a full clone: ${link.sha}`);
        }
      } else {
        assert.equal(type, "commit", `git object for ${link.sha} must be a commit`);
      }
    }
  });

  it("does not leak author emails into commit links", () => {
    for (const link of evidence.commitLinks) {
      assert.ok(!link.subject.includes("@"), `subject must not contain an email: ${link.subject}`);
      assert.ok(!link.refs.includes("@"), `refs must not contain an email: ${link.refs}`);
    }
  });

  it("treats a synthetic directory without .git as having no git (no-git fallback)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-evidence-nogit-"));
    try {
      assert.equal(fs.existsSync(path.join(dir, ".git")), false);
      assert.equal(gitAvailable(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});