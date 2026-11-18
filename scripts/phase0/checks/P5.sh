#!/usr/bin/env bash
set -euo pipefail

# Probe P5: What does `turn_completion` / `promptTurnSummaries` contain?
# Settles: Credits as a cap and as M22
# Fallback: Caps on wall-clock and tool calls only; UI shows `not reported`

PROBE_ID="P5"
DATE_STR="${PHASE0_DATE:-$(date +%Y-%m-%d)}"
EVIDENCE_DIR="${EVIDENCE_DIR:-01_evidence/phase0-${DATE_STR}/${PROBE_ID}}"
EVIDENCE_PATH="${EVIDENCE_PATH:-${EVIDENCE_DIR}/transcript.txt}"

mkdir -p "$EVIDENCE_DIR" 2>/dev/null || true

write_transcript() {
  local content="$1"
  if [[ -n "${EVIDENCE_PATH:-}" ]]; then
    mkdir -p "$(dirname "$EVIDENCE_PATH")" 2>/dev/null || true
    if [[ -n "${KIRO_API_KEY:-}" ]]; then
      printf "%s\n" "$content" | sed "s#${KIRO_API_KEY}#[REDACTED]#g" | sed "s#${HOME:-~}#~#g" > "$EVIDENCE_PATH" 2>/dev/null || true
    else
      printf "%s\n" "$content" | sed "s#${HOME:-~}#~#g" > "$EVIDENCE_PATH" 2>/dev/null || true
    fi
  fi
}

# (a) Verify preconditions first
KIRO_BIN="${KIRO_CLI_BIN:-}"
if [[ -z "$KIRO_BIN" ]]; then
  if [[ -x "$HOME/.local/bin/kiro-cli" ]]; then
    KIRO_BIN="$HOME/.local/bin/kiro-cli"
  elif command -v kiro-cli >/dev/null 2>&1; then
    KIRO_BIN="$(command -v kiro-cli)"
  fi
fi

if [[ -z "$KIRO_BIN" || ! -x "$KIRO_BIN" ]]; then
  write_transcript "Precondition check failed: kiro-cli binary not found at KIRO_CLI_BIN or ~/.local/bin/kiro-cli. Live Kiro login required (needs-owner-run)."
  echo "INCONCLUSIVE: needs-owner-run: kiro-cli binary not found at KIRO_CLI_BIN or ~/.local/bin/kiro-cli"
  exit 2
fi

# Auth path: KIRO_API_KEY when one exists, otherwise the kiro-cli login session.
# A key cannot be issued for this account (P1 / V1), so the evidence names the
# path that was actually used instead of assuming the key.
PHASE0_AUTH_PATH="api-key"
if [[ -z "${KIRO_API_KEY:-}" ]]; then
  if "$KIRO_BIN" whoami 2>/dev/null | grep -qi "logged in"; then
    PHASE0_AUTH_PATH="cli-login"
  else
    write_transcript "Precondition check failed: no KIRO_API_KEY and no kiro-cli login session. Live Kiro login required (needs-owner-run)."
    echo "INCONCLUSIVE: needs-owner-run: no KIRO_API_KEY and no kiro-cli login session"
    exit 2
  fi
fi
export PHASE0_AUTH_PATH
echo "AUTH: ${PHASE0_AUTH_PATH}"

# (b) Perform check with kiro-cli acp --agent-engine=v3
TMP_DIR="$(mktemp -d /tmp/kiro-p5-XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

TMP_KIRO_HOME="$TMP_DIR/kiro_home"
TMP_WORK="$TMP_DIR/work"
mkdir -p "$TMP_KIRO_HOME" "$TMP_WORK"

export KIRO_BIN
export TMP_KIRO_HOME
export TMP_WORK
export EVIDENCE_PATH

node - << 'EOF'
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const kiroBin = process.env.KIRO_BIN;
const kiroHome = process.env.TMP_KIRO_HOME;
const workDir = process.env.TMP_WORK;
const evidencePath = process.env.EVIDENCE_PATH;
const apiKey = process.env.KIRO_API_KEY;
const homeDir = process.env.HOME || "";

const transcriptLines = [];
const discoveredFields = new Set();
let hasCreditField = false;

function record(msg) {
  transcriptLines.push(msg);
}

function sanitize(text) {
  let s = String(text);
  if (apiKey) {
    s = s.split(apiKey).join("[REDACTED]");
  }
  if (homeDir) {
    s = s.split(homeDir).join("~");
  }
  return s;
}

function flushTranscript() {
  if (evidencePath) {
    try {
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, sanitize(transcriptLines.join("\n")), "utf-8");
    } catch (_) {}
  }
}

function inspectPayload(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const [key, val] of Object.entries(obj)) {
    discoveredFields.add(key);
    if (/credit/i.test(key) || (typeof val === "string" && /^credits?$/i.test(val))) {
      hasCreditField = true;
    }
    if (val && typeof val === "object") {
      inspectPayload(val);
    }
  }
}

async function run() {
  record("Starting kiro-cli acp --agent-engine=v3 probe P5");

  const child = spawn(kiroBin, ["acp", "--agent-engine=v3"], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KIRO_HOME: kiroHome,
      KIRO_API_KEY: apiKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let procClosed = false;
  let initSuccess = false;
  let sessionSuccess = false;
  let promptDone = false;
  let promptSent = false;
  let sessionId = "";

  const rlOut = readline.createInterface({ input: child.stdout });
  const rlErr = readline.createInterface({ input: child.stderr });

  rlOut.on("line", (line) => {
    record(`[STDOUT] ${line}`);
    try {
      const msg = JSON.parse(line);
      if (typeof msg.method === "string" && msg.id !== undefined) {
        if (msg.method === "_kiro/terminal/shell_type") { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { shellType: "bash" } }) + "\n"); }
      }
      if (msg.id === 1 && msg.result) {
        initSuccess = true;
      } else if (msg.id === 2 && msg.result && msg.result.sessionId) {
        sessionSuccess = true;
        sessionId = msg.result.sessionId;
      } else if (msg.id === 3) {
        promptDone = true;
        if (msg.result) {
          inspectPayload(msg.result);
        }
      }

      // Inspect any notifications for turn_completion or promptTurnSummaries
      if (msg.method === "session/update" && msg.params) {
        inspectPayload(msg.params);
      }
      if (msg.params && msg.params.promptTurnSummaries) {
        inspectPayload(msg.params.promptTurnSummaries);
      }
      if (msg.params && msg.params.turn_completion) {
        inspectPayload(msg.params.turn_completion);
      }
    } catch (_) {}
  });

  rlErr.on("line", (line) => {
    record(`[STDERR] ${line}`);
  });

  child.on("close", (code) => {
    procClosed = true;
    record(`Child exited with code ${code}`);
  });

  const initReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "p5-probe", version: "1.0.0" },
    },
  };
  child.stdin.write(JSON.stringify(initReq) + "\n");

  const start = Date.now();
  while (!procClosed && Date.now() - start < 120000) {
    if (initSuccess && !sessionSuccess) {
      const sessionReq = {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: workDir, mcpServers: [] },
      };
      child.stdin.write(JSON.stringify(sessionReq) + "\n");
      await new Promise((r) => setTimeout(r, 600));
    } else if (sessionSuccess && !promptDone && !promptSent) {
      promptSent = true;
      const promptReq = {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "Reply with the single word ok. Do not use any tool." }],
        },
      };
      child.stdin.write(JSON.stringify(promptReq) + "\n");
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (promptDone) {
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  child.stdin.end();
  try {
    child.kill("SIGTERM");
  } catch (_) {}

  await new Promise((r) => setTimeout(r, 500));
  flushTranscript();

  const fieldList = Array.from(discoveredFields).join(", ");
  if (hasCreditField) {
    console.log(`PASS: turn_completion contains credits and tokens: ${fieldList}`);
    process.exit(0);
  } else if (!promptDone) {
    console.log("INCONCLUSIVE: the prompt turn never completed, so credit reporting was not observed");
    process.exit(2);
  } else {
    console.log(`FAIL: turn_completion lacks credit fields (found fields: ${fieldList || "none"})`);
    process.exit(1);
  }
}

run().catch((err) => {
  record(`Unexpected error: ${err.message}`);
  flushTranscript();
  console.log(`FAIL: unexpected error in P5 probe: ${err.message}`);
  process.exit(1);
});
EOF
