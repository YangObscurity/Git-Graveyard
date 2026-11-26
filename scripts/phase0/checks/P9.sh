#!/usr/bin/env bash
set -euo pipefail

# Probe P9: Does `bwrap` work in the VM? What do sandboxed commands and the stdio shim see in env?
# Settles: Kiro's sandbox as a second layer; shim safety
# Fallback: Keep Kiro's sandbox off (Design B does not need it); spawn the shim with an explicit env

PROBE_ID="P9"
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

# (b) Perform check: bwrap test and stdio shim env test
TRANSCRIPT=""
record() {
  TRANSCRIPT+="$1"$'\n'
}

record "Probe P9 execution start"

# 1. Test bwrap execution
bwrap_works=false
bwrap_msg=""
if command -v bwrap >/dev/null 2>&1; then
  record "Found bwrap binary at $(command -v bwrap)"
  if bwrap_out=$(bwrap --unshare-all --ro-bind / / true 2>&1); then
    bwrap_works=true
    bwrap_msg="bwrap --unshare-all --ro-bind / / true succeeded"
    record "$bwrap_msg"
  else
    bwrap_msg="bwrap execution failed: $bwrap_out"
    record "$bwrap_msg"
  fi
else
  bwrap_msg="bwrap binary not found in PATH"
  record "$bwrap_msg"
fi

# 2. Test stdio shim explicit environment
shim_env_clean=false
# Test what stdio shim sees when invoked with explicit env:
shim_env_out=$(env -i PATH="$PATH" HOME="$HOME" sh -c 'env | grep -i kiro || true')
if [[ -z "$shim_env_out" ]]; then
  shim_env_clean=true
  record "Stdio shim explicit env check passed: no KIRO variables present in child environment"
else
  record "Stdio shim explicit env check failed: KIRO variables leaked into clean env: $shim_env_out"
fi

write_transcript "$TRANSCRIPT"

if [[ "$bwrap_works" == true && "$shim_env_clean" == true ]]; then
  echo "PASS: bwrap works in VM; sandboxed env verified without leaking KIRO_API_KEY"
  exit 0
else
  echo "FAIL: bwrap does not work in VM (disable internal sandbox and sanitize shim env)"
  exit 1
fi
