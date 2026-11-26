#!/usr/bin/env bash
set -euo pipefail

# Probe P7: Does an ACP session load the repo's `.kiro/agents`, steering, hooks, `mcp.json`, `AGENTS.md`, skills?
# Settles: `.kiro/` handling
# Fallback: Strip the loaded items from the worktree view and mark them `skip-worktree`

PROBE_ID="P7"
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

# (b) Perform check (shared driver lib/acp.js; the old inline driver re-sent
# session/prompt, never answered _kiro/terminal/shell_type and could pass without
# ever running a turn).
TMP_DIR="$(mktemp -d /tmp/kiro-p7-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
export KIRO_BIN EVIDENCE_PATH
# Mock cloned repo: a marker in every place Kiro could load from. Agent files are
# JSON in kiro-cli 3.x (LF only).
MOCK_REPO="$TMP_DIR/p7-mock-repo"
mkdir -p "$MOCK_REPO/.kiro/agents" "$MOCK_REPO/.kiro/steering" "$MOCK_REPO/.kiro/hooks" "$MOCK_REPO/.kiro/settings" "$MOCK_REPO/.kiro/skills/marker-skill"
cat > "$MOCK_REPO/.kiro/agents/repo-marker.json" <<'AGENT_EOF'
{ "name": "repo-marker-agent", "description": "Untrusted agent from a cloned repository", "prompt": "MARKER_AGENT_PROMPT_P7", "mcpServers": {}, "tools": ["*"], "toolAliases": {}, "allowedTools": [], "resources": [], "toolsSettings": {}, "includeMcpJson": true, "model": null }
AGENT_EOF
echo "MARKER_STEERING_DETECTED_P7" > "$MOCK_REPO/.kiro/steering/marker-steer.md"
echo '{"version":"v1","hooks":[]}' > "$MOCK_REPO/.kiro/hooks/marker-hook.json"
echo '{"mcpServers":{}}' > "$MOCK_REPO/.kiro/settings/mcp.json"
echo "MARKER_AGENTS_MD_DETECTED_P7" > "$MOCK_REPO/AGENTS.md"
printf -- '---\nname: marker-skill\ndescription: probe skill\n---\nMARKER_SKILL_DETECTED_P7\n' > "$MOCK_REPO/.kiro/skills/marker-skill/SKILL.md"
export MOCK_REPO
node "$(dirname "$0")/lib/p7.js"
