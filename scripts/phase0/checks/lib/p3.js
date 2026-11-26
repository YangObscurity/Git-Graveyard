// P3: does session/new accept an HTTP MCP gateway, and does the model select and
// run a tool from it? The stub is a minimal streamable-HTTP MCP server. PASS needs
// the stub to have seen tools/list AND tools/call, i.e. the tool was really
// selected and executed. Merely getting a session id proves nothing.
//
// The "timeout" part of the question is recorded, not claimed: the ACP mcpServers
// schema has no timeout field, so the probe sends none and reports that.
const http = require("node:http");
const { AcpSession, finish } = require("./acp");

(async () => {
  const lines = [];
  const seen = { initialize: 0, toolsList: 0, toolsCall: 0, other: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lines.push("[STUB] " + req.method + " " + req.url + " " + body.slice(0, 300));
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      let j;
      try {
        j = JSON.parse(body);
      } catch (_) {
        res.writeHead(400);
        return res.end();
      }
      const reply = (result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
      };
      if (j.method === "initialize") {
        seen.initialize++;
        return reply({ protocolVersion: j.params && j.params.protocolVersion ? j.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "necromancer", version: "1.0.0" } });
      }
      if (j.method === "notifications/initialized" || j.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (j.method === "tools/list") {
        seen.toolsList++;
        return reply({
          tools: [
            {
              name: "necromancer_tool",
              description: "Returns the probe token. Call it with x set to test.",
              inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
            },
          ],
        });
      }
      if (j.method === "tools/call") {
        seen.toolsCall++;
        return reply({ content: [{ type: "text", text: "PROBE-TOKEN-P3" }] });
      }
      seen.other.push(j.method);
      return reply({});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  lines.push("stub MCP gateway on 127.0.0.1:" + port);

  const s = new AcpSession({ cwd: process.env.P3_WORK, clientName: "p3-probe" }).start();
  const done = async (verdict) => {
    await s.stop();
    server.close();
    lines.push(...s.lines);
    lines.push("stub saw: initialize=" + seen.initialize + " tools/list=" + seen.toolsList + " tools/call=" + seen.toolsCall + " other=" + seen.other.join(","));
    finish(lines, verdict);
  };

  const init = await s.initialize();
  if (!init.result) return done("FAIL: initialize failed: " + JSON.stringify(init.error || init));
  const caps = init.result.agentCapabilities && init.result.agentCapabilities.mcpCapabilities;
  lines.push("mcpCapabilities advertised: " + JSON.stringify(caps));
  const ses = await s.newSession({ mcpServers: [{ type: "http", name: "necromancer", url: "http://127.0.0.1:" + port + "/", headers: [] }] });
  if (!ses.result || !ses.result.sessionId) return done("FAIL: session/new rejected the HTTP gateway: " + JSON.stringify(ses.error || ses));
  lines.push("session/new accepted the HTTP gateway");
  const turn = await s.prompt(ses.result.sessionId, "Use the necromancer_tool tool from the necromancer MCP server with x set to test, then tell me the token it returned.", 150000);
  const stop = turn.result && turn.result.stopReason;
  lines.push("turn stopReason=" + stop + "; tool calls in stream: " + JSON.stringify(s.toolCalls.map((t) => t.title)));
  lines.push("agent text: " + JSON.stringify(s.agentText.slice(0, 160)));
  if (seen.toolsList > 0 && seen.toolsCall > 0) {
    return done("PASS: the HTTP gateway was accepted, its tool was listed and called" + (s.agentText.includes("PROBE-TOKEN-P3") ? " and its result reached the model" : "") + "; timeout: no field exists in the ACP mcpServers schema, so none was set");
  }
  if (seen.toolsList === 0 && seen.initialize === 0) {
    return done("FAIL: the gateway was accepted by session/new but Kiro never contacted it");
  }
  if (seen.toolsList > 0) return done("INCONCLUSIVE: the tool was listed but the model did not call it");
  return done("FAIL: Kiro contacted the gateway but never listed its tools");
})().catch((e) => {
  console.log("FAIL: unexpected error in P3: " + e.message);
  process.exit(1);
});
