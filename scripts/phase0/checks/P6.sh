#!/usr/bin/env bash
set -euo pipefail

# Probe P6: Do `ask`, `deny` and exclude-only `deny` behave as designed? Which permission options are offered?
# Settles: Write restriction form; Broker option selection
# Fallback: Documented-safe form: allow the path, everything else falls to `ask`, the Broker rejects
#
# kiro-cli 3.1.0 loads agents from <workspace>/.kiro/agents/<name>.json (JSON, not
# markdown frontmatter) and ignores KIRO_HOME for discovery, so the probe agent is
# written into the temp workspace and the session is started with --agent. A CRLF
# JSON file is rejected by the loader, so the file is written with LF only.
# Every session/request_permission payload is recorded verbatim: that is the
# evidence for whether an agent can supply top-level fields itself (B7) and which
# option ids are offered (B8).

PROBE_ID="P6"
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

# (b) Perform check: workspace agent, then one ACP session that asks for a denied
# shell command, a read and two writes.
TMP_DIR="$(mktemp -d /tmp/kiro-p6-XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

TMP_WORK="$TMP_DIR/work"
mkdir -p "$TMP_WORK/.kiro/agents"
printf 'probe input\n' > "$TMP_WORK/test.txt"

cat > "$TMP_WORK/.kiro/agents/p6-agent.json" <<'AGENT_EOF'
{
  "name": "p6-agent",
  "description": "Phase 0 P6 probe agent",
  "prompt": null,
  "mcpServers": {},
  "tools": ["*"],
  "toolAliases": {},
  "allowedTools": [],
  "resources": [],
  "toolsSettings": {},
  "includeMcpJson": true,
  "model": null,
  "permissions": {
    "rules": [
      { "capability": "shell", "match": ["*"], "effect": "deny" },
      { "capability": "fs_read", "match": ["./**"], "effect": "ask" },
      { "capability": "fs_write", "match": ["unallowed.txt"], "effect": "deny" }
    ]
  }
}
AGENT_EOF

if ! "$KIRO_BIN" agent validate --path "$TMP_WORK/.kiro/agents/p6-agent.json" > "$TMP_DIR/validate.log" 2>&1; then
  write_transcript "Precondition check failed: kiro-cli rejected the probe agent config. $(tr '\n' ' ' < "$TMP_DIR/validate.log")"
  echo "INCONCLUSIVE: needs-owner-run: kiro-cli rejected the probe agent config"
  exit 2
fi

export KIRO_BIN
export P6_WORK="$TMP_WORK"
export EVIDENCE_PATH

node "$(dirname "$0")/lib/p6-acp.js"
