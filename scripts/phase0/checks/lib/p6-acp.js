// Probe P6 ACP driver: start one session with the workspace agent and record
// every permission request verbatim.
//
// Evidence this produces:
//   - the exact session/request_permission payload (does Kiro send fields an
//     agent could supply itself? B7),
//   - the option ids offered (duplicates? B8),
//   - whether a `deny` rule blocked a tool silently and whether an `ask` rule
//     produced a request at all.
//
// Exit 0 PASS, 1 FAIL, 2 INCONCLUSIVE (the model never used a tool).

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const kiroBin = process.env.KIRO_BIN;
const workDir = process.env.P6_WORK;
const evidencePath = process.env.EVIDENCE_PATH;
const apiKey = process.env.KIRO_API_KEY;
const homeDir = process.env.HOME || "";

const lines = [];
const permissionRequests = [];
const optionIds = [];
const toolCalls = [];
let initSuccess = false;
let sessionId = null;
let promptSent = false;
let promptDone = false;
let procClosed = false;

function record(msg) {
  lines.push(String(msg));
}

function sanitize(text) {
  let s = String(text);
  if (apiKey) s = s.split(apiKey).join("[REDACTED]");
  if (homeDir) s = s.split(homeDir).join("~");
  return s;
}

function flush() {
  if (!evidencePath) return;
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, sanitize(lines.join("\n")), "utf-8");
  } catch (_) {}
}

function collectOptions(params) {
  const opts = params && (params.options || params.permissionOptions);
  if (!Array.isArray(opts)) return;
  for (const opt of opts) {
    const id = opt && (opt.optionId ?? opt.id ?? opt.kind ?? opt.type);
    if (id !== undefined) optionIds.push(String(id));
  }
}

async function run() {
  record(`P6 ACP driver: auth path ${process.env.PHASE0_AUTH_PATH || "unknown"}, cwd ${workDir}`);
  record("agent: .kiro/agents/p6-agent.json (rules: shell deny *, fs_read ask ./, fs_write deny unallowed.txt)");

  const child = spawn(kiroBin, ["acp", "--agent-engine=v3"], {
    cwd: workDir,
    env: { ...process.env, KIRO_API_KEY: apiKey || "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rlOut = readline.createInterface({ input: child.stdout });
  const rlErr = readline.createInterface({ input: child.stderr });

  rlOut.on("line", (line) => {
    record(`[STDOUT] ${line}`);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }

    if (msg.id === 1) {
      if (msg.result) initSuccess = true;
      if (msg.error) record(`[ERROR] initialize: ${JSON.stringify(msg.error)}`);
    } else if (msg.id === 2) {
      if (msg.result && msg.result.sessionId) sessionId = msg.result.sessionId;
      if (msg.error) record(`[ERROR] session/new: ${JSON.stringify(msg.error)}`);
    } else if (msg.id === 3) {
      promptDone = true;
    }

    if (msg.method === "session/request_permission") {
      permissionRequests.push(msg.params);
      collectOptions(msg.params);
      record(`[PERMISSION REQUEST] ${JSON.stringify(msg.params)}`);

      // ACP wants a selected option, not a bare verdict:
      // { outcome: { outcome: "selected", optionId } }. Sending "allow_once"
      // makes the engine fail the tool even though it was allowed.
      const opts = Array.isArray(msg.params?.options) ? msg.params.options : [];
      const allow =
        opts.find((o) => o && o.kind === "allow_once") ??
        opts.find((o) => o && typeof o.optionId === "string" && o.optionId.startsWith("accept"));
      const answer = {
        jsonrpc: "2.0",
        id: msg.id,
        result: allow
          ? { outcome: { outcome: "selected", optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" } },
      };
      try {
        child.stdin.write(JSON.stringify(answer) + "\n");
        record(`[PERMISSION ANSWER] ${JSON.stringify(answer)}`);
      } catch (_) {}
      return;
    }

    // Requests the engine makes to the client. kiro-cli 3.1.0 asks the client
    // for the shell type before it lets a tool run; ignoring it stalls the
    // session before any tool call (which is what the first P6 run showed).
    if (typeof msg.method === "string" && msg.id !== undefined) {
      const method = msg.method;
      let result = {};
      if (method === "_kiro/terminal/shell_type") {
        result = { shellType: "bash" };
      }
      record(`[CLIENT REQUEST] ${method} ${JSON.stringify(msg.params || {})}`);
      try {
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n"
        );
        record(`[CLIENT ANSWER] ${method} -> ${JSON.stringify(result)}`);
      } catch (_) {}
    }

    if (msg.method === "session/update" && msg.params && msg.params.update) {
      const u = msg.params.update;
      if (u.sessionUpdate === "tool_call" || u.toolCall) {
        const tc = u.toolCall || u;
        toolCalls.push({ title: tc.title, kind: tc.kind, status: tc.status });
        record(`[TOOL CALL] ${JSON.stringify(tc).slice(0, 800)}`);
      }
      if (u.sessionUpdate === "tool_call_update") {
        record(`[TOOL UPDATE] ${JSON.stringify(u).slice(0, 800)}`);
      }
    }
  });

  rlErr.on("line", (line) => record(`[STDERR] ${line}`));
  child.on("close", (code) => {
    procClosed = true;
    record(`Child exited with code ${code}`);
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "p6-probe", version: "1.0.0" },
      },
    }) + "\n"
  );

  const deadline = Date.now() + 120000;
  while (!procClosed && Date.now() < deadline) {
    if (initSuccess && !sessionId) {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: workDir, mcpServers: [], _meta: { kiro: { modeId: "p6-agent" } } },
        }) + "\n"
      );
    } else if (sessionId && !promptSent) {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId,
            prompt: [
              {
                type: "text",
                text:
                  "Do these four things in order, using the tools: " +
                  "(1) run the shell command echo hi; " +
                  "(2) read the file test.txt; " +
                  "(3) write the file unallowed.txt with the text blocked; " +
                  "(4) write the file allowed.txt with the text ok. " +
                  "Then say done.",
              },
            ],
          },
        }) + "\n"
      );
      promptSent = true;
    }
    if (promptDone) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  try {
    child.stdin.end();
    child.kill("SIGTERM");
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 800));

  const unallowed = fs.existsSync(path.join(workDir, "unallowed.txt"));
  const allowed = fs.existsSync(path.join(workDir, "allowed.txt"));
  record(`files after the run: unallowed.txt=${unallowed} allowed.txt=${allowed}`);
  record(`permission requests: ${permissionRequests.length}; option ids: ${optionIds.join(", ") || "none"}`);
  record(`tool calls: ${toolCalls.length}`);

  let verdict;
  if (permissionRequests.length > 0) {
    verdict =
      `PASS: ${permissionRequests.length} permission request(s); option ids: ${optionIds.join(", ") || "none"}` +
      `; unallowed.txt written: ${unallowed}`;
  } else if (unallowed) {
    verdict = "FAIL: no permission request and unallowed.txt was written; the deny rule did not hold";
  } else if (toolCalls.length === 0) {
    verdict = "INCONCLUSIVE: the session used no tool, so ask/deny were never exercised";
  } else {
    verdict = "FAIL: tools ran with no permission request while fs_read was set to ask";
  }

  record(`VERDICT: ${verdict}`);
  flush();
  console.log(verdict);
  process.exit(verdict.startsWith("PASS") ? 0 : verdict.startsWith("FAIL") ? 1 : 2);
}

run().catch((err) => {
  record(`Unexpected error: ${err.message}`);
  flush();
  console.log(`FAIL: unexpected error in P6: ${err.message}`);
  process.exit(1);
});

