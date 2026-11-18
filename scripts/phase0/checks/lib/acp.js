// Shared ACP driver for the Phase 0 probes.
//
// It exists because the first probe drivers each re-implemented the protocol and
// each got the same things wrong: they re-sent session/prompt (a second prompt
// cancels the running turn), left _kiro/terminal/shell_type unanswered (the
// engine then stalls before its first tool), answered permission requests with a
// bare verdict instead of a selected option, and read session/new `modes` as an
// array although it is { currentModeId, availableModes }.
//
// One session, one prompt at a time, every line kept verbatim in `lines`.

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

class AcpSession {
  constructor(opts) {
    this.kiroBin = opts.kiroBin || process.env.KIRO_BIN;
    this.cwd = opts.cwd;
    this.env = opts.env || process.env;
    this.clientCapabilities = opts.clientCapabilities || {};
    this.clientName = opts.clientName || "phase0-probe";
    this.lines = [];
    this.notifications = [];
    this.clientRequests = [];
    this.permissionRequests = [];
    this.toolCalls = [];
    this.agentText = "";
    this.stderr = [];
    this.exitCode = null;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.onClientRequest = opts.onClientRequest || null;
    this.onNotification = opts.onNotification || null;
    this.permission = opts.permission || "accept"; // "accept" | "reject"
    this.lineFilter = opts.lineFilter || null; // (line) => string, applied before storing
  }

  record(s) {
    this.lines.push(String(s));
  }

  start() {
    this.child = spawn(this.kiroBin, ["acp", "--agent-engine=v3"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rlOut = readline.createInterface({ input: this.child.stdout });
    this.rlErr = readline.createInterface({ input: this.child.stderr });
    this.rlOut.on("line", (line) => this.handleLine(line));
    this.rlErr.on("line", (line) => {
      this.stderr.push(line);
      this.record("[STDERR] " + line);
    });
    this.exited = new Promise((resolve) => {
      this.child.on("close", (code) => {
        this.closed = true;
        this.exitCode = code;
        this.record("Child exited with code " + code);
        for (const [, p] of this.pending) p.resolve({ error: { message: "process exited" } });
        this.pending.clear();
        resolve(code);
      });
    });
    return this;
  }

  write(obj) {
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch (_) {}
  }

  handleLine(line) {
    this.record("[STDOUT] " + (this.lineFilter ? this.lineFilter(line) : line));
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }

    // Request from the engine to the client.
    if (typeof msg.method === "string" && msg.id !== undefined) {
      this.clientRequests.push({ method: msg.method, params: msg.params });
      if (msg.method === "session/request_permission") {
        this.permissionRequests.push(msg.params);
        const opts = Array.isArray(msg.params && msg.params.options) ? msg.params.options : [];
        const wanted = this.permission === "accept" ? ["accept", "allow"] : ["reject", "deny"];
        const choice =
          opts.find((o) => o && typeof o.optionId === "string" && !o.optionId.startsWith("always") && wanted.some((w) => o.optionId.startsWith(w))) ||
          opts.find((o) => o && o.kind === (this.permission === "accept" ? "allow_once" : "reject_once"));
        this.write({
          jsonrpc: "2.0",
          id: msg.id,
          result: choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } },
        });
        return;
      }
      let handled = null;
      if (this.onClientRequest) handled = this.onClientRequest(msg);
      if (handled === null || handled === undefined) {
        handled = msg.method === "_kiro/terminal/shell_type" ? { shellType: "bash" } : {};
      }
      this.write({ jsonrpc: "2.0", id: msg.id, result: handled });
      return;
    }

    // Notification.
    if (typeof msg.method === "string") {
      this.notifications.push(msg);
      if (msg.method === "session/update" && msg.params && msg.params.update) {
        const u = msg.params.update;
        if (u.sessionUpdate === "tool_call") this.toolCalls.push(u);
        if (u.sessionUpdate === "agent_message_chunk" && u.content && typeof u.content.text === "string") this.agentText += u.content.text;
      }
      if (this.onNotification) this.onNotification(msg);
    }
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: "timeout after " + timeoutMs + " ms" }, timedOut: true });
      }, timeoutMs || 60000);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  initialize(extra) {
    return this.request(
      "initialize",
      Object.assign(
        { protocolVersion: 1, clientCapabilities: this.clientCapabilities, clientInfo: { name: this.clientName, version: "1.0.0" } },
        extra || {}
      ),
      30000
    );
  }

  newSession(params) {
    return this.request("session/new", Object.assign({ cwd: this.cwd, mcpServers: [] }, params || {}), 60000);
  }

  // Exactly one prompt; resolves with the response (result.stopReason) or a timeout.
  prompt(sessionId, text, timeoutMs) {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, timeoutMs || 120000);
  }

  async stop() {
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch (_) {}
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 1500))]);
  }
}

// Modes live in session/new result.modes = { currentModeId, availableModes: [...] }.
function modesOf(sessionNewResponse) {
  const m = sessionNewResponse && sessionNewResponse.result && sessionNewResponse.result.modes;
  if (!m) return { current: null, available: [] };
  if (Array.isArray(m)) return { current: null, available: m.map((x) => x.id || x.name || String(x)) };
  return {
    current: m.currentModeId || null,
    available: Array.isArray(m.availableModes) ? m.availableModes.map((x) => x.id || x.name || String(x)) : [],
  };
}

function sanitizer(extra) {
  return (text) => {
    let s = String(text);
    const key = process.env.KIRO_API_KEY;
    if (key) s = s.split(key).join("[REDACTED]");
    const home = process.env.HOME;
    if (home) s = s.split(home).join("~");
    for (const x of extra || []) if (x) s = s.split(x).join("[MASKED]");
    return s;
  };
}

function writeEvidence(lines, extraMasks) {
  const evPath = process.env.EVIDENCE_PATH;
  if (!evPath) return;
  try {
    fs.mkdirSync(path.dirname(evPath), { recursive: true });
    fs.writeFileSync(evPath, sanitizer(extraMasks)(lines.join("\n")), "utf-8");
  } catch (_) {}
}

// Exit helper: 0 PASS, 1 FAIL, 2 INCONCLUSIVE. Writes evidence first.
function finish(lines, verdict, extraMasks) {
  lines.push("VERDICT: " + verdict);
  writeEvidence(lines, extraMasks);
  console.log(verdict);
  process.exit(verdict.startsWith("PASS") ? 0 : verdict.startsWith("FAIL") ? 1 : 2);
}

module.exports = { AcpSession, modesOf, sanitizer, writeEvidence, finish };
