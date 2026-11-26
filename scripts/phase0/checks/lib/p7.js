// P7: does an ACP session load a cloned repo's own .kiro files, AGENTS.md, skills?
//
// The mock repo carries a marker in each place. Three independent observables:
//   1. the session's mode list (does the repo's agent show up?),
//   2. _kiro/steering/documents_changed and the other *_changed notifications
//      (do they list a document from the repo?),
//   3. the model is asked to quote what it was given; a marker in the reply means
//      the file reached its context.
// A positive control keeps PASS honest: the steering notification must have
// listed at least one document (the built-in ones), proving observable 2 works,
// and the turn must have finished. Without that a quiet run proves nothing.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { AcpSession, modesOf, finish } = require("./acp");

const MARKERS = {
  "AGENTS.md": "MARKER_AGENTS_MD_DETECTED_P7",
  ".kiro/steering/marker-steer.md": "MARKER_STEERING_DETECTED_P7",
  ".kiro/skills/marker-skill/SKILL.md": "MARKER_SKILL_DETECTED_P7",
};

(async () => {
  const lines = [];
  const repo = process.env.MOCK_REPO;
  const loaded = new Set();

  // A stub MCP server named only in the repo's .kiro/settings/mcp.json: if Kiro
  // contacts it, the repo's MCP configuration was loaded.
  let stubHits = 0;
  const stub = http.createServer((req, res) => {
    stubHits++;
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let id = null;
      try { id = JSON.parse(b).id; } catch (_) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "repo-stub", version: "1" }, tools: [] } }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  fs.writeFileSync(
    path.join(repo, ".kiro", "settings", "mcp.json"),
    JSON.stringify({ mcpServers: { "repo-stub": { type: "http", url: "http://127.0.0.1:" + stub.address().port + "/" } } }) + "\n"
  );

  const s = new AcpSession({
    cwd: repo,
    clientName: "p7-probe",
    onNotification: (m) => {
      const text = JSON.stringify(m.params || {});
      for (const [file, marker] of Object.entries(MARKERS)) if (text.includes(marker)) loaded.add(file + " (notification " + m.method + ")");
      if (text.includes("marker-skill")) loaded.add(".kiro/skills/marker-skill (named in " + m.method + ")");
      if (/steering\/documents_changed|skills|agents|hooks|mcp/.test(m.method) && text.includes("p7-mock-repo")) loaded.add("repo path in " + m.method);
    },
  }).start();

  const init = await s.initialize();
  if (!init.result) {
    lines.push(...s.lines);
    return finish(lines, "FAIL: initialize failed: " + JSON.stringify(init.error || init));
  }
  const ses = await s.newSession();
  if (!ses.result || !ses.result.sessionId) {
    lines.push(...s.lines);
    await s.stop();
    return finish(lines, "FAIL: session/new failed: " + JSON.stringify(ses.error || ses));
  }
  const modes = modesOf(ses);
  lines.push("modes: current=" + modes.current + " available=" + modes.available.join(","));
  if (modes.available.includes("repo-marker-agent")) loaded.add(".kiro/agents/repo-marker.json (mode list)");

  const turn = await s.prompt(
    ses.result.sessionId,
    "Without using any tool: quote verbatim any line you were given from AGENTS.md, steering files or skills that contains the word MARKER. If you were given none, answer exactly NONE.",
    120000
  );
  // Is the repo's agent selectable by name?
  const ses2 = await s.newSession({ _meta: { kiro: { modeId: "repo-marker-agent" } } });
  const m2 = modesOf(ses2);
  lines.push("second session with modeId repo-marker-agent: current=" + m2.current);
  if (m2.current === "repo-marker-agent") loaded.add(".kiro/agents/repo-marker.json (selectable by modeId)");
  await new Promise((r) => setTimeout(r, 1500));
  if (stubHits > 0) loaded.add(".kiro/settings/mcp.json (stub contacted " + stubHits + "x)");
  lines.push("repo mcp.json stub hits: " + stubHits + "; repo hooks: no observable, not tested");
  stub.close();
  await s.stop();
  lines.push(...s.lines);
  for (const [file, marker] of Object.entries(MARKERS)) if (s.agentText.includes(marker)) loaded.add(file + " (quoted by the model)");

  const steeringNotes = s.notifications.filter((n) => /steering\/documents_changed/.test(n.method));
  const docCount = steeringNotes.reduce((n, m) => n + (((m.params || {}).documents || []).length), 0);
  lines.push("steering notifications: " + steeringNotes.length + ", documents listed: " + docCount);
  lines.push("agent text: " + JSON.stringify(s.agentText.slice(0, 200)));
  lines.push("loaded from repo: " + (loaded.size ? Array.from(loaded).join("; ") : "nothing"));

  if (loaded.size > 0) {
    return finish(lines, "FAIL: the ACP session loads repository files: " + Array.from(loaded).join("; "));
  }
  const stop = turn.result && turn.result.stopReason;
  if (stop !== "end_turn" || docCount === 0) {
    return finish(lines, "INCONCLUSIVE: no positive control (stopReason=" + stop + ", steering documents listed=" + docCount + "), so a quiet run proves nothing");
  }
  return finish(lines, "PASS: with the turn finished and the steering notification observed (" + docCount + " documents), nothing from the repo's agents, steering, AGENTS.md or skills was loaded");
})().catch((e) => {
  console.log("FAIL: unexpected error in P7: " + e.message);
  process.exit(1);
});
