#!/usr/bin/env bash
set -euo pipefail

# Spike S5: Can a request wake the paused box, and how fast?
# Settles: Dev runbook
# Fallback: Operator wakes the box by hand before use
#
# Run this on the operator machine, not on the box: a paused box cannot time its
# own wake, and the request that measures the wake is the request that causes it.
# The first request after the idle window is made here, with a stopwatch; the
# pause itself is proven by the heartbeat P13 armed (largest gap between
# heartbeats). Without that gap the number is just an SSH round trip, so the
# spike reports INCONCLUSIVE instead of a pass.
#
# PASS  the box was paused and the first request woke it within the 45s bound
#       the provider documents for a held request.
# FAIL  it took longer than that bound, or the box came back on a fresh boot.
# Exit 2 needs-owner-run: box not paused yet, or P13 was never armed.

PROBE_ID="S5"
DATE_STR="${PHASE0_DATE:-$(date +%Y-%m-%d)}"
EVIDENCE_DIR="${EVIDENCE_DIR:-01_evidence/phase0-${DATE_STR}/${PROBE_ID}}"
EVIDENCE_PATH="${EVIDENCE_PATH:-${EVIDENCE_DIR}/transcript.txt}"

if [[ -z "${PHASE0_BOX_HOST:-}" ]]; then
  echo "INCONCLUSIVE: PHASE0_BOX_HOST is required"
  exit 2
fi
BOX_HOST="$PHASE0_BOX_HOST"
WAKE_TIMEOUT="${PHASE0_WAKE_TIMEOUT:-90}"
MIN_PAUSE_GAP="${PHASE0_P13_MIN_GAP_SEC:-60}"
WAKE_BOUND_MS="${PHASE0_WAKE_BOUND_MS:-45000}"
REMOTE_STATE="${PHASE0_P13_REMOTE_STATE:-\$HOME/.phase0/P13}"

mkdir -p "$EVIDENCE_DIR" 2>/dev/null || true

write_transcript() {
  local content="$1"
  if [[ -n "${EVIDENCE_PATH:-}" ]]; then
    mkdir -p "$(dirname "$EVIDENCE_PATH")" 2>/dev/null || true
    printf "%s\n" "$content" | sed "s#${HOME:-~}#~#g" > "$EVIDENCE_PATH" 2>/dev/null || true
  fi
}

now_ms() {
  local ns
  ns="$(date +%s%N 2>/dev/null || true)"
  case "$ns" in
    *N*|"") echo "$(( $(date +%s) * 1000 ))" ;;
    *) echo "$(( ns / 1000000 ))" ;;
  esac
}

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o LogLevel=ERROR -o StrictHostKeyChecking=accept-new)

started_ms="$(now_ms)"
attempts=0
woke_ms=""
last_err=""

while :; do
  attempts=$((attempts + 1))
  if boot="$(ssh "${SSH_OPTS[@]}" "$BOX_HOST" 'cat /proc/sys/kernel/random/boot_id' 2>/tmp/s5-ssh-err.$$)"; then
    woke_ms="$(now_ms)"
    last_err=""
    break
  fi
  last_err="$(tr -d '\r' < /tmp/s5-ssh-err.$$ 2>/dev/null | tail -n 1)"
  rm -f /tmp/s5-ssh-err.$$
  if [[ $(( $(now_ms) - started_ms )) -ge $(( WAKE_TIMEOUT * 1000 )) ]]; then
    break
  fi
  sleep 2
done
rm -f /tmp/s5-ssh-err.$$ 2>/dev/null || true

if [[ -z "$woke_ms" ]]; then
  transcript="Spike S5 at $(date -u +%Y-%m-%dT%H:%M:%SZ) host=$BOX_HOST attempts=$attempts"
  transcript+=$'\n'"No answer within ${WAKE_TIMEOUT}s; last error: ${last_err:-none}"
  transcript+=$'\n'"VERDICT: INCONCLUSIVE - the box did not answer; nothing about waking was measured."
  write_transcript "$transcript"
  echo "INCONCLUSIVE: needs-owner-run: no answer from $BOX_HOST within ${WAKE_TIMEOUT}s (${last_err:-no output})"
  exit 2
fi

latency_ms=$(( woke_ms - started_ms ))

# Proof that the box was really paused: P13's heartbeat file, largest gap.
hb_stats="$(ssh "${SSH_OPTS[@]}" "$BOX_HOST" "wc -l < $REMOTE_STATE/heartbeat.log 2>/dev/null || echo 0; echo '---S5---'; tail -n 400 $REMOTE_STATE/heartbeat.log 2>/dev/null || true" 2>/dev/null || true)"
hb_lines="$(printf '%s\n' "$hb_stats" | head -n 1 | tr -d ' \r')"
hb_series="$(printf '%s\n' "$hb_stats" | sed -n '/^---S5---$/,$p' | tail -n +2)"

max_gap=0
if [[ -n "$hb_series" ]]; then
  max_gap="$(printf '%s\n' "$hb_series" | awk 'NR==1{prev=$1; next}
    {d=$1-prev; if(d>m)m=d; prev=$1}
    END{printf "%d", m+0}')"
fi

transcript="Spike S5 at $(date -u +%Y-%m-%dT%H:%M:%SZ) host=$BOX_HOST"
transcript+=$'\n'"first request: ssh + ${attempts} attempt(s), ${latency_ms} ms until the box answered"
transcript+=$'\n'"boot_id after wake: ${boot}"
transcript+=$'\n'"P13 heartbeat: lines=${hb_lines:-0} largest_gap=${max_gap}s (a pause is proven from ${MIN_PAUSE_GAP}s)"
transcript+=$'\n'"documented bound for a held request: ${WAKE_BOUND_MS} ms (exec/ps/files wait up to 45s; the SSH gateway gives up at 15s)"

if [[ "${hb_lines:-0}" -le 1 || "$max_gap" -lt "$MIN_PAUSE_GAP" ]]; then
  transcript+=$'\n'"VERDICT: INCONCLUSIVE - no pause recorded in this window (gap ${max_gap}s); ${latency_ms} ms is only an SSH round trip."
  transcript+=$'\n'"Arm P13 first, leave the box idle for its auto-pause window, then run this spike as the first request."
  write_transcript "$transcript"
  echo "INCONCLUSIVE: needs-owner-run: box not paused (heartbeat gap ${max_gap}s); wake latency not measured"
  exit 2
fi

if [[ "$latency_ms" -gt "$WAKE_BOUND_MS" ]]; then
  transcript+=$'\n'"VERDICT: FAIL - the box was paused (gap ${max_gap}s) and took ${latency_ms} ms to answer, above the ${WAKE_BOUND_MS} ms bound."
  write_transcript "$transcript"
  echo "FAIL: wake took ${latency_ms} ms after a ${max_gap}s pause (bound ${WAKE_BOUND_MS} ms)"
  exit 1
fi

transcript+=$'\n'"VERDICT: PASS - a ${max_gap}s pause was woken by the first request in ${latency_ms} ms."
transcript+=$'\n'"Runbook: the box wakes on use; keep recordings short of the max-run limit and hold an activity lease during silent model calls."
write_transcript "$transcript"
echo "PASS: request woke the paused box in ${latency_ms} ms (pause gap ${max_gap}s)"
exit 0
