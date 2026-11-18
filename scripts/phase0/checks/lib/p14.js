// P14: does `chat --v3 --no-interactive --output-format stream-json` report the
// ACTIVE model? Without --model the stream says "auto", which is not a model. So
// the probe pins a model and requires the stream's model config option to end on
// exactly that value; matching the text "model" anywhere proves nothing (the
// option list contains it for every run).
const { execFileSync } = require("node:child_process");
const { finish } = require("./acp");

const WANT = process.env.P14_MODEL || "claude-haiku-5.5";

(async () => {
  const lines = [];
  let out = "";
  let ok = true;
  try {
    out = execFileSync(
      process.env.KIRO_BIN,
      ["chat", "--v3", "--no-interactive", "--model", WANT, "--output-format", "stream-json", "Reply with the single word ok."],
      { encoding: "utf-8", timeout: 180000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch (e) {
    ok = false;
    out = (e && e.stdout) || "";
    lines.push("run failed: " + (e && e.message));
  }
  const recs = [];
  for (const l of out.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { recs.push(JSON.parse(l)); } catch (_) {}
  }
  const types = {};
  const modelValues = [];
  let finished = null;
  for (const r of recs) {
    const u = r.data && r.data.update;
    const key = r.type + (u ? "/" + u.sessionUpdate : "");
    types[key] = (types[key] || 0) + 1;
    for (const c of (u && u.configOptions) || []) if (c.id === "model") modelValues.push(c.currentValue);
    if (r.type === "runFinished") finished = r.data;
  }
  lines.push("records: " + recs.length + "; types: " + JSON.stringify(types));
  lines.push("model currentValue over time: " + JSON.stringify(modelValues));
  lines.push("runFinished: " + JSON.stringify(finished && { status: finished.status, stopReason: finished.stopReason }));
  const last = modelValues[modelValues.length - 1];
  if (!recs.length) return finish(lines, "FAIL: stream-json produced no records");
  if (!finished || finished.status !== "success") return finish(lines, "FAIL: the run did not finish with success");
  if (last === WANT) {
    return finish(lines, "PASS: stream-json reports the active model: pinned " + WANT + " and the stream's model option ended on it (without --model it reports 'auto')");
  }
  return finish(lines, "FAIL: stream-json did not confirm the pinned model " + WANT + " (last reported: " + last + "); Headless_Fallback stays disabled for live runs");
})().catch((e) => {
  console.log("FAIL: unexpected error in P14: " + e.message);
  process.exit(1);
});
