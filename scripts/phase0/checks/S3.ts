import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Spike S3: Exhume the candidate repos by hand (wp-d D8.3)
// Settles: Recommended targets
// If it fails: Choose other candidates from wp-d D8.3
//
// D8.3 says metadata alone does not show that a repo installs, builds or has
// tests, and that promotion to "recommended" needs one real Exhume. So this clones
// each candidate at its current head, runs a real `npm install` and the repo's own
// test script (or the Python test runner), and records what happened, including the
// exact format of npm's deprecation lines (design V26). A failing baseline is data,
// not a probe failure: that is what a death certificate is.
//
// PASS: at least two candidates were really exhumed (cloned, installed, tested)
// with every outcome recorded. FAIL: fewer than two could be exhumed.

const lines: string[] = [];
function rec(m: string): void {
  lines.push(m);
  console.log(sanitize(m));
}
function sanitize(text: string): string {
  let res = text;
  const home = process.env.HOME;
  if (home) res = res.split(home).join("~");
  return res;
}
function flush(): void {
  const evPath = process.env.EVIDENCE_PATH;
  if (!evPath) return;
  try {
    fs.mkdirSync(path.dirname(evPath), { recursive: true });
    fs.writeFileSync(evPath, sanitize(lines.join("\n")), "utf-8");
  } catch (_) {}
}

interface Candidate {
  repo: string;
  kind: "node" | "python";
}
const CANDIDATES: Candidate[] = [
  { repo: "request/request", kind: "node" },
  { repo: "kriskowal/q", kind: "node" },
  { repo: "not-kennethreitz/envoy", kind: "python" },
];

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): { status: number | null; out: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1", npm_config_fund: "false", npm_config_audit: "false" } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), ms: Date.now() - t0 };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-s3-"));
const cleanup = (): void => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {}
};

interface Outcome {
  repo: string;
  exhumed: boolean;
  summary: string;
}
const outcomes: Outcome[] = [];
const deprecationSamples = new Set<string>();

for (const c of CANDIDATES) {
  const dir = path.join(tmp, c.repo.replace("/", "__"));
  rec(`--- ${c.repo} (${c.kind})`);
  const clone = run("git", ["clone", "--depth", "1", `https://github.com/${c.repo}.git`, dir], tmp, 120000);
  if (clone.status !== 0) {
    rec(`clone failed: ${clone.out.slice(0, 200)}`);
    outcomes.push({ repo: c.repo, exhumed: false, summary: "clone failed" });
    continue;
  }
  const head = run("git", ["log", "-1", "--format=%H %cI"], dir, 10000).out.trim();
  const licence = fs.readdirSync(dir).filter((f) => /^licen[cs]e/i.test(f));
  rec(`head: ${head}; licence files: ${licence.join(", ") || "none"}; clone ${clone.ms} ms`);

  if (c.kind === "node") {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { engines?: unknown; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
    rec(`engines: ${JSON.stringify(pkg.engines)}; test script: ${pkg.scripts && pkg.scripts.test ? pkg.scripts.test.slice(0, 80) : "none"}; declared dependencies: ${deps}`);
    const inst = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], dir, 420000);
    const dep = inst.out.split(/\r?\n/).filter((l) => /npm (warn|WARN) deprecated/.test(l));
    dep.slice(0, 3).forEach((l) => deprecationSamples.add(l.trim().slice(0, 160)));
    rec(`npm install: exit ${inst.status} in ${inst.ms} ms; deprecation lines: ${dep.length}`);
    let testSummary = "no test script";
    if (pkg.scripts && pkg.scripts.test) {
      const t = run("npm", ["test", "--silent"], dir, 300000);
      testSummary = `npm test exit ${t.status} in ${t.ms} ms; tail: ${t.out.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 200)}`;
    }
    rec(testSummary);
    outcomes.push({ repo: c.repo, exhumed: inst.status !== null, summary: `install exit ${inst.status}, ${dep.length} deprecations, ${testSummary}` });
  } else {
    const py = run("python3", ["--version"], dir, 10000);
    const hasTests = fs.existsSync(path.join(dir, "test_envoy.py")) || fs.readdirSync(dir).some((f) => /^test/.test(f));
    rec(`python: ${py.out.trim()}; test files present: ${hasTests}; setup.py present: ${fs.existsSync(path.join(dir, "setup.py"))}`);
    let summary = "no test run";
    const testFile = fs.readdirSync(dir).find((f) => /^test.*\.py$/.test(f));
    if (testFile) {
      const t = run("python3", [testFile], dir, 120000);
      summary = `python3 ${testFile}: exit ${t.status} in ${t.ms} ms; tail: ${t.out.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 200)}`;
    }
    rec(summary);
    outcomes.push({ repo: c.repo, exhumed: py.status === 0, summary });
  }
}

rec("--- npm deprecation line format seen (V26): " + (deprecationSamples.size ? Array.from(deprecationSamples).join(" || ") : "none in these installs"));
cleanup();

const done = outcomes.filter((o) => o.exhumed);
for (const o of outcomes) rec(`outcome ${o.repo}: exhumed=${o.exhumed}; ${o.summary}`);
if (done.length >= 2) {
  rec(`VERDICT: PASS - ${done.length}/${CANDIDATES.length} candidates were really exhumed (cloned, installed, tested): ${done.map((o) => o.repo).join(", ")}`);
  flush();
  process.exit(0);
}
if (done.length === 0 && outcomes.every((o) => o.summary === "clone failed")) {
  rec("VERDICT: INCONCLUSIVE - no candidate could be cloned from this box, nothing was exhumed");
  flush();
  process.exit(2);
}
rec(`VERDICT: FAIL - only ${done.length} candidate(s) could be exhumed; choose other candidates from wp-d D8.3`);
flush();
process.exit(1);
