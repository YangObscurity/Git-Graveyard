// P15: which _kiro/* and _session/* methods does the engine advertise, and do the
// three the design cares about work? It records the initialize result, then calls
//   _kiro/account/getUsage   (credit balance),
//   _session/steer           (steering a running turn),
//   _kiro/mcp/status         (MCP connection state)
// and reports for each: advertised?, and the actual JSON-RPC outcome. PASS means
// initialize answered and every outcome is recorded; the facts are in the line.
const { AcpSession, finish } = require("./acp");

function extensionStrings(obj) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === "string" && /^_(kiro|session)\//.test(v)) found.add(v);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (/^_(kiro|session)\//.test(k)) found.add(k); walk(x); }
  };
  walk(obj);
  return Array.from(found).sort();
}

(async () => {
  const lines = [];
  const s = new AcpSession({ cwd: process.env.P15_WORK, clientName: "p15-probe" }).start();
  const init = await s.initialize();
  if (!init.result) {
    lines.push(...s.lines);
    await s.stop();
    return finish(lines, "FAIL: initialize failed (this is what a wrong protocolVersion type also produces): " + JSON.stringify(init.error || init));
  }
  const advertised = extensionStrings(init.result);
  lines.push("initialize result keys: " + Object.keys(init.result).join(","));
  lines.push("advertised extension names in initialize: " + (advertised.join(", ") || "none"));
  const ses = await s.newSession();
  const sid = ses.result && ses.result.sessionId;
  const methods = ["_kiro/account/getUsage", "_session/steer", "_kiro/mcp/status"];
  const outcome = {};
  for (const m of methods) {
    const params = m === "_session/steer" ? { sessionId: sid, message: "steer probe" } : sid ? { sessionId: sid } : {};
    const r = await s.request(m, params, 20000);
    outcome[m] = r.result !== undefined ? "result " + JSON.stringify(r.result).slice(0, 160) : "error " + JSON.stringify(r.error || r).slice(0, 160);
    lines.push(m + " advertised=" + advertised.includes(m) + " -> " + outcome[m]);
  }
  const notified = Array.from(new Set(s.notifications.map((n) => n.method).filter((m) => /^_(kiro|session)\//.test(m)))).sort();
  lines.push("extension notifications seen: " + notified.join(", "));
  await s.stop();
  lines.push(...s.lines);
  const missingMethod = (o) => /-32601|method not found|unknown method|unsupported/i.test(o);
  // A handler that complains about its arguments or state exists. _kiro/mcp/status
  // is a notification the engine pushes, so seeing it in the stream is the proof.
  const works = (m) =>
    m === "_kiro/mcp/status"
      ? notified.includes("_kiro/mcp/status")
      : outcome[m].startsWith("result") || (outcome[m].startsWith("error") && !missingMethod(outcome[m]));
  return finish(
    lines,
    "PASS: initialize answered; getUsage " + (works("_kiro/account/getUsage") ? "works" : "not available (owner checks the portal)") +
      "; steer " + (works("_session/steer") ? "exists" : "not available (cancel and re-prompt)") +
      "; mcp status " + (works("_kiro/mcp/status") ? "is pushed as a notification" : "not available (use the gateway's own record)")
  );
})().catch((e) => {
  console.log("FAIL: unexpected error in P15: " + e.message);
  process.exit(1);
});
