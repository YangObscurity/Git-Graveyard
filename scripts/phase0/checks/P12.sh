#!/usr/bin/env bash
set -euo pipefail

# Probe P12: Do Kiro file tools follow symlinks; does the kernel support `nosymfollow`?
# Settles: Symlink defence
# Fallback: Mandatory scan before every prompt and after every sandbox_exec (planned anyway)

PROBE_ID="P12"
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

# (b) Perform check: a workspace with symlinks that point outside it, one ACP
# session that reads and writes through them, and a verdict from what leaks.
# kiro-cli 3.x loads agents from <workspace>/.kiro/agents/<name>.json (LF only).
nosymfollow_supported=false
if grep -q "nosymfollow" /proc/mounts 2>/dev/null; then
  nosymfollow_supported=true
fi
echo "kernel nosymfollow in /proc/mounts: ${nosymfollow_supported}"

TMP_DIR="$(mktemp -d /tmp/kiro-p12-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

P12_SECRET="P12-SECRET-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
P12_CONTROL="P12-CONTROL-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
mkdir -p "$TMP_DIR/outside" "$TMP_DIR/work/.kiro/agents"
printf '%s' "$P12_SECRET" > "$TMP_DIR/outside/secret.txt"
printf '%s' "$P12_CONTROL" > "$TMP_DIR/work/real.txt"
ln -s "$TMP_DIR/outside/secret.txt" "$TMP_DIR/work/link.txt"
ln -s "$TMP_DIR/outside" "$TMP_DIR/work/dirlink"
ln -s "$TMP_DIR/outside/written.txt" "$TMP_DIR/work/wlink.txt"

cat > "$TMP_DIR/work/.kiro/agents/p12-agent.json" <<'AGENT_EOF'
{
  "name": "p12-agent",
  "description": "Phase 0 P12 probe agent",
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
      { "capability": "fs_read", "match": ["./**"], "effect": "allow" },
      { "capability": "fs_write", "match": ["./**"], "effect": "allow" }
    ]
  }
}
AGENT_EOF

if ! "$KIRO_BIN" agent validate --path "$TMP_DIR/work/.kiro/agents/p12-agent.json" > "$TMP_DIR/validate.log" 2>&1; then
  write_transcript "Precondition check failed: kiro-cli rejected the probe agent config. $(tr '\n' ' ' < "$TMP_DIR/validate.log")"
  echo "INCONCLUSIVE: needs-owner-run: kiro-cli rejected the probe agent config"
  exit 2
fi

export KIRO_BIN
export P12_WORK="$TMP_DIR/work"
export P12_OUTSIDE="$TMP_DIR/outside"
export P12_SECRET P12_CONTROL
export EVIDENCE_PATH

node "$(dirname "$0")/lib/p12-acp.js"
