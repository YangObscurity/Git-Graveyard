#!/usr/bin/env bash
set -euo pipefail

# Probe P4: Are agents read from `$KIRO_HOME/agents`? Is the mode the agent name? Which model IDs and effort values exist?
# Settles: Agent file location; the model allowlist
# Fallback: Give each skeleton its own HOME so the documented ~/.kiro/agents/ resolves per skeleton

PROBE_ID="P4"
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
TMP_DIR="$(mktemp -d /tmp/kiro-p4-XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

TMP_KIRO_HOME="$TMP_DIR/kiro_home"
TMP_WORK="$TMP_DIR/work"
mkdir -p "$TMP_KIRO_HOME/agents" "$TMP_WORK"

# kiro-cli 3.x agent files are JSON (LF only), not markdown frontmatter.
cat << 'AGENT_EOF' > "$TMP_KIRO_HOME/agents/p4-agent.json"
{ "name": "p4-agent", "description": "Test agent for probe P4", "prompt": null, "mcpServers": {}, "tools": ["*"], "toolAliases": {}, "allowedTools": [], "resources": [], "toolsSettings": {}, "includeMcpJson": true, "model": null }
AGENT_EOF

export KIRO_BIN
export TMP_KIRO_HOME
export TMP_WORK
export EVIDENCE_PATH

node - << 'EOF'
const { spawn, execSync } = require("node:child_process");
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
let modeFound = false;
const recordedModes = [];
const recordedModels = [];
const recordedEffortValues = [];

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

async function run() {
  record("Starting kiro-cli acp --agent-engine=v3 probe P4");

  // Query models via CLI command
  try {
    const listOut = execSync(`"${kiroBin}" chat --list-models --format json`, {
      env: { ...process.env, KIRO_HOME: kiroHome },
      encoding: "utf-8",
      timeout: 10000,
    });
    record(`chat --list-models output: ${listOut.trim()}`);
    try {
      const parsed = JSON.parse(listOut);
      if (Array.isArray(parsed)) {
        for (const m of parsed) {
          recordedModels.push(m.id || m.name || String(m));
        }
      }
    } catch (_) {}
  } catch (err) {
    record(`chat --list-models failed: ${err.message}`);
  }

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
  let failureReason = "";

  const rlOut = readline.createInterface({ input: child.stdout });
  const rlErr = readline.createInterface({ input: child.stderr });

  rlOut.on("line", (line) => {
    record(`[STDOUT] ${line}`);
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result) {
        initSuccess = true;
      } else if (msg.id === 2 && msg.result) {
        sessionSuccess = true;
        if (msg.result.modes && msg.result.modes.currentModeId === "p4-agent") { modeFound = true; }
        const modeList = Array.isArray(msg.result.modes) ? msg.result.modes : (msg.result.modes && Array.isArray(msg.result.modes.availableModes) ? msg.result.modes.availableModes : []);
        {
          for (const mode of modeList) {
            const mId = mode.id || mode.name || String(mode);
            recordedModes.push(mId);
            if (mId === "p4-agent") {
              modeFound = true;
            }
          }
        }
        if (msg.result.configOptions && Array.isArray(msg.result.configOptions)) {
          for (const opt of msg.result.configOptions) {
            if (opt.id === "model" && opt.options) {
              for (const m of opt.options) {
                recordedModels.push(m.id || m.value || String(m));
              }
            } else if (opt.id === "effortLevel" && opt.options) {
              for (const e of opt.options) {
                recordedEffortValues.push(e.id || e.value || String(e));
              }
            }
          }
        }
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
      clientInfo: { name: "p4-probe", version: "1.0.0" },
    },
  };
  child.stdin.write(JSON.stringify(initReq) + "\n");

  const start = Date.now();
  while (!procClosed && Date.now() - start < 15000) {
    if (initSuccess && !sessionSuccess) {
      const sessionReq = {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: workDir, mcpServers: [], _meta: { kiro: { modeId: "p4-agent" } } },
      };
      child.stdin.write(JSON.stringify(sessionReq) + "\n");
      await new Promise((r) => setTimeout(r, 600));
    }
    if (sessionSuccess) {
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

  const uniqueModels = Array.from(new Set(recordedModels));
  const uniqueEffort = Array.from(new Set(recordedEffortValues));

  if (modeFound) {
    console.log(
      `PASS: agents read from $KIRO_HOME/agents; mode matches agent name; models: ${uniqueModels.join(", ") || "recorded"}`
    );
    process.exit(0);
  } else {
    console.log(
      `FAIL: agents not read from $KIRO_HOME/agents (modes found: ${recordedModes.join(", ") || "none"})`
    );
    process.exit(1);
  }
}

run().catch((err) => {
  record(`Unexpected error: ${err.message}`);
  flushTranscript();
  console.log(`FAIL: unexpected error in P4 probe: ${err.message}`);
  process.exit(1);
});
EOF
