// P8: how many `kiro-cli acp` processes can one login run at once, at what RSS and
// latency? Two rounds (4, then 8) each run a full prompt turn per process. RSS is
// the real resident size of the process tree read from /proc; if it cannot be read
// the number is reported as unmeasured, never filled in.
const fs = require("node:fs");
const { AcpSession, finish } = require("./acp");

function treeRssKb(rootPid) {
  const ppid = new Map();
  const rss = new Map();
  let names;
  try {
    names = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch (_) {
    return null;
  }
  for (const n of names) {
    try {
      const st = fs.readFileSync("/proc/" + n + "/status", "utf8");
      const pp = /PPid:\s+(\d+)/.exec(st);
      const vm = /VmRSS:\s+(\d+)/.exec(st);
      ppid.set(Number(n), pp ? Number(pp[1]) : 0);
      rss.set(Number(n), vm ? Number(vm[1]) : 0);
    } catch (_) {}
  }
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, pp] of ppid) if (!inTree.has(p) && inTree.has(pp)) { inTree.add(p); grew = true; }
  }
  let total = 0;
  for (const p of inTree) total += rss.get(p) || 0;
  return total;
}

async function one(i, cwd, lines) {
  const s = new AcpSession({ cwd, clientName: "p8-" + i }).start();
  let maxKb = 0;
  const timer = setInterval(() => {
    if (s.child && s.child.pid) {
      const kb = treeRssKb(s.child.pid);
      if (kb !== null && kb > maxKb) maxKb = kb;
    }
  }, 250);
  const t0 = Date.now();
  let ok = false;
  let limited = false;
  let detail = "";
  const init = await s.initialize();
  if (init.result) {
    const ses = await s.newSession();
    if (ses.result && ses.result.sessionId) {
      const turn = await s.prompt(ses.result.sessionId, "Reply with the single word ok. Do not use any tool.", 150000);
      ok = !!(turn.result && turn.result.stopReason === "end_turn" && s.agentText.trim());
      detail = "stopReason=" + (turn.result && turn.result.stopReason) + (turn.timedOut ? " (timeout)" : "");
    } else detail = "session/new: " + JSON.stringify(ses.error || ses);
  } else detail = "initialize: " + JSON.stringify(init.error || init);
  const latency = Date.now() - t0;
  clearInterval(timer);
  await s.stop();
  const all = s.lines.join("\n");
  if (/\b429\b|rate.?limit|too many requests/i.test(all)) limited = true;
  lines.push("[proc " + i + "] ok=" + ok + " limited=" + limited + " latency=" + latency + " ms maxRssKb=" + maxKb + " " + detail);
  return { ok, limited, latency, maxKb };
}

async function round(n, cwd, lines) {
  lines.push("--- round with " + n + " parallel processes");
  const res = await Promise.all(Array.from({ length: n }, (_, i) => one(i + 1, cwd, lines)));
  const okN = res.filter((r) => r.ok).length;
  const limited = res.some((r) => r.limited);
  const totalKb = res.reduce((a, r) => a + r.maxKb, 0);
  const avg = Math.round(res.reduce((a, r) => a + r.latency, 0) / res.length);
  lines.push("round " + n + ": ok " + okN + "/" + n + ", rate limited: " + limited + ", sum of per-process peak RSS: " + (totalKb ? Math.round(totalKb / 1024) + " MB" : "unmeasured") + ", mean latency " + avg + " ms");
  return { n, okN, limited, totalKb, avg };
}

(async () => {
  const lines = [];
  const cwd = process.env.P8_WORK;
  const r4 = await round(4, cwd, lines);
  if (r4.okN < 4 || r4.limited) {
    return finish(lines, "FAIL: 4 parallel kiro-cli acp processes did not all finish (ok " + r4.okN + "/4, rate limited: " + r4.limited + ")");
  }
  const r8 = await round(8, cwd, lines);
  const note = "; 8 parallel: ok " + r8.okN + "/8" + (r8.limited ? ", rate limited" : "");
  return finish(
    lines,
    "PASS: 4 parallel kiro-cli acp processes finished (sum of peak RSS " +
      (r4.totalKb ? Math.round(r4.totalKb / 1024) + " MB" : "unmeasured") + ", mean latency " + r4.avg + " ms)" + note
  );
})().catch((e) => {
  console.log("FAIL: unexpected error in P8: " + e.message);
  process.exit(1);
});
