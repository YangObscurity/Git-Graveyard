import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AcpSession } = require("./lib/acp.js");

// Spike S4: Memory and CPU of one session plus a Node build on the box
// Settles: Parallel Soul-stitchers on dev
// If it fails: One at a time
//
// This measures instead of reading os.totalmem(): it runs one real Kiro ACP turn
// at the same time as a real Node build (clone + npm install + npm test of the heaviest
// candidate, bower/bower) and samples MemAvailable, the load average and the resident
// size of both process trees every 500 ms. From the peaks it computes how many
// sessions the box can hold next to one build while keeping a safety margin.
//
// PASS: both finished and MemAvailable never dropped below the margin.
// The capacity line states the measured numbers it was derived from.

const lines: string[] = [];
function rec(m: string): void {
  lines.push(m);
  console.log(m);
}
function flush(): void {
  const evPath = process.env.EVIDENCE_PATH;
  if (!evPath) return;
  try {
    fs.mkdirSync(path.dirname(evPath), { recursive: true });
    fs.writeFileSync(evPath, lines.join("\n").split(process.env.HOME || "\u0000").join("~"), "utf-8");
  } catch (_) {}
}

function meminfo(): { totalKb: number; availKb: number } | null {
  try {
    const t = fs.readFileSync("/proc/meminfo", "utf8");
    const total = /MemTotal:\s+(\d+)/.exec(t);
    const avail = /MemAvailable:\s+(\d+)/.exec(t);
    return total && avail ? { totalKb: Number(total[1]), availKb: Number(avail[1]) } : null;
  } catch (_) {
    return null;
  }
}
function treeRssKb(root: number): number {
  const ppid = new Map<number, number>();
  const rss = new Map<number, number>();
  for (const n of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try {
      const st = fs.readFileSync(`/proc/${n}/status`, "utf8");
      const pp = /PPid:\s+(\d+)/.exec(st);
      const vm = /VmRSS:\s+(\d+)/.exec(st);
      ppid.set(Number(n), pp ? Number(pp[1]) : 0);
      rss.set(Number(n), vm ? Number(vm[1]) : 0);
    } catch (_) {}
  }
  const tree = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, pp] of ppid) if (!tree.has(p) && tree.has(pp)) { tree.add(p); grew = true; }
  }
  let sum = 0;
  for (const p of tree) sum += rss.get(p) || 0;
  return sum;
}

async function main(): Promise<void> {
  const mem0 = meminfo();
  if (!mem0 || process.platform !== "linux") {
    rec("INCONCLUSIVE: /proc/meminfo is not available here (run this on the dev box)");
    flush();
    process.exit(2);
  }
  const kiro = process.env.KIRO_BIN || path.join(process.env.HOME || "", ".local", "bin", "kiro-cli");
  if (!fs.existsSync(kiro)) {
    rec("INCONCLUSIVE: needs-owner-run: kiro-cli binary not found");
    flush();
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-s4-"));
  const cleanup = (): void => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  };
  const cpus = os.cpus().length;
  rec(`box: ${cpus} vCPUs, MemTotal ${Math.round(mem0.totalKb / 1024)} MB, MemAvailable at start ${Math.round(mem0.availKb / 1024)} MB`);

  const repoDir = path.join(tmp, "build-target");
  const clone = spawnSync("git", ["clone", "--depth", "1", "https://github.com/bower/bower.git", repoDir], { encoding: "utf-8", timeout: 120000 });
  if (clone.status !== 0) {
    rec("INCONCLUSIVE: could not clone the build target: " + String(clone.stderr).slice(0, 200));
    cleanup();
    flush();
    process.exit(2);
  }

  let minAvailKb = mem0.availKb;
  let peakSessionKb = 0;
  let peakBuildKb = 0;
  let peakLoad = 0;
  const work = path.join(tmp, "work");
  fs.mkdirSync(work);
  const session = new AcpSession({ kiroBin: kiro, cwd: work, clientName: "s4-probe" }).start();

  const build = spawn("sh", ["-c", "npm install --ignore-scripts --no-audit --no-fund && npm test --silent"], { cwd: repoDir, env: { ...process.env, CI: "1" }, stdio: "ignore" });
  const buildDone = new Promise<number | null>((r) => build.on("close", (code) => r(code)));

  const timer = setInterval(() => {
    const m = meminfo();
    if (m && m.availKb < minAvailKb) minAvailKb = m.availKb;
    if (session.child && session.child.pid) peakSessionKb = Math.max(peakSessionKb, treeRssKb(session.child.pid));
    if (build.pid) peakBuildKb = Math.max(peakBuildKb, treeRssKb(build.pid));
    peakLoad = Math.max(peakLoad, os.loadavg()[0]);
  }, 500);

  const t0 = Date.now();
  const init = await session.initialize();
  let sessionOk = false;
  if (init.result) {
    const ses = await session.newSession();
    if (ses.result && ses.result.sessionId) {
      const turn = await session.prompt(ses.result.sessionId, "Count from 1 to 40 with one number per line, then say done. Do not use any tool.", 150000);
      sessionOk = !!(turn.result && turn.result.stopReason === "end_turn");
    }
  }
  const buildStart = Date.now();
  const buildCode = await Promise.race([buildDone, new Promise<number | null>((r) => setTimeout(() => r(-1), 600000))]);
  const buildMs = Date.now() - t0;
  clearInterval(timer);
  await session.stop();
  const wall = Date.now() - t0;
  cleanup();

  const marginKb = 1024 * 1024; // keep 1 GiB free
  rec(`session turn ok: ${sessionOk}; build exit: ${buildCode} (npm install + npm test of bower/bower); wall ${wall} ms`);
  rec(`peak RSS: one Kiro session ${Math.round(peakSessionKb / 1024)} MB, one Node build ${Math.round(peakBuildKb / 1024)} MB; lowest MemAvailable ${Math.round(minAvailKb / 1024)} MB; peak 1-min load ${peakLoad.toFixed(2)} on ${cpus} vCPUs`);
  const usableKb = mem0.totalKb - marginKb - peakBuildKb;
  const sessions = peakSessionKb > 0 ? Math.max(0, Math.floor(usableKb / peakSessionKb)) : 0;
  rec(`capacity: (MemTotal - 1 GiB margin - one build) / one session = ${sessions} sessions next to one build`);

  rec(`build ran ${buildMs} ms (exit code does not matter for load; a build that dies in seconds is not a load)`);
  void buildStart;
  if (buildMs < 10000) {
    rec("VERDICT: INCONCLUSIVE - the build ended in under 10 s, so it was not a real load next to the session");
    flush();
    process.exit(2);
  }
  if (!sessionOk || buildCode === -1) {
    rec("VERDICT: INCONCLUSIVE - the session turn or the build did not finish, so the peaks are not a full measurement");
    flush();
    process.exit(2);
  }
  if (minAvailKb < marginKb) {
    rec("VERDICT: FAIL - MemAvailable dropped below the 1 GiB margin with one session plus one build; run one Soul-stitcher at a time");
    flush();
    process.exit(1);
  }
  rec(`VERDICT: PASS - one session (${Math.round(peakSessionKb / 1024)} MB) plus one Node build (${Math.round(peakBuildKb / 1024)} MB) kept MemAvailable above ${Math.round(marginKb / 1024)} MB (lowest ${Math.round(minAvailKb / 1024)} MB); the box holds about ${sessions} sessions next to one build, so parallel Soul-stitchers are allowed up to that`);
  flush();
  process.exit(0);
}

main().catch((e) => {
  rec(`FAIL: unexpected error in S4: ${(e as Error).message}`);
  flush();
  process.exit(1);
});
