#!/usr/bin/env bash
set -euo pipefail

# Probe P13: Does auto-pause kill a live run on the box?
# Settles: Dev operation
# Fallback: Operator keeps a session open during recordings; production is unaffected
#
# A paused box cannot observe its own pause, and the request that measures it is
# also the request that wakes it. So this check has two phases:
#
#   arm     no state file: record boot_id and uptime, start a detached heartbeat
#           (a stand-in for a live run) and a long-lived container, print what to
#           do next, exit 2. That exit code is the expected result of phase one.
#   assess  state file present: run after the idle window. Compare boot_id,
#           heartbeat continuity, the largest heartbeat gap (proof that the box
#           really paused) and the container.
#
# PASS  the pause kept memory and processes; the live run survives auto-pause.
# FAIL  the box came back fresh (boot_id changed) or the heartbeat/container died.
# Exit 2 needs-owner-run: armed and waiting, or no pause observed yet.

PROBE_ID="P13"
DATE_STR="${PHASE0_DATE:-$(date +%Y-%m-%d)}"
EVIDENCE_DIR="${EVIDENCE_DIR:-01_evidence/phase0-${DATE_STR}/${PROBE_ID}}"
EVIDENCE_PATH="${EVIDENCE_PATH:-${EVIDENCE_DIR}/transcript.txt}"
STATE_DIR="${PHASE0_P13_STATE_DIR:-$HOME/.phase0/P13}"
STATE_FILE="$STATE_DIR/state.json"
HEARTBEAT_FILE="$STATE_DIR/heartbeat.log"
CONTAINER_FILE="$STATE_DIR/container.name"
HEARTBEAT_INTERVAL="${PHASE0_P13_HEARTBEAT_SEC:-20}"
MIN_PAUSE_GAP="${PHASE0_P13_MIN_GAP_SEC:-60}"

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

boot_id() {
  cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown
}

uptime_sec() {
  awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || echo 0
}

state_get() {
  local key="$1"
  [[ -f "$STATE_FILE" ]] || return 0
  sed -n "s/.*\"${key}\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$STATE_FILE" | head -n 1
}

arm() {
  mkdir -p "$STATE_DIR"
  rm -f "$HEARTBEAT_FILE"

  local container="p13-live-run-${RANDOM}${RANDOM}"
  local docker_state="unavailable"

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker image inspect alpine:latest >/dev/null 2>&1 || docker pull -q alpine:latest >/dev/null 2>&1 || true
    if docker run -d --name "$container" alpine:latest sh -c 'while :; do sleep 5; done' >/dev/null 2>&1; then
      docker_state="running"
      printf '%s' "$container" > "$CONTAINER_FILE"
    else
      docker_state="start-failed"
    fi
  fi

  # Detached heartbeat: survives the SSH session that armed it.
  setsid nohup bash -c 'while :; do date -u +%s >> "$1"; sleep "$2"; done' _ \
    "$HEARTBEAT_FILE" "$HEARTBEAT_INTERVAL" >/dev/null 2>&1 &

  sleep 2
  local hb_lines=0
  [[ -f "$HEARTBEAT_FILE" ]] && hb_lines="$(wc -l < "$HEARTBEAT_FILE" | tr -d ' ')"

  {
    printf '{\n'
    printf '  "probe": "P13",\n'
    printf '  "phase": "armed",\n'
    printf '  "boot_id": "%s",\n' "$(boot_id)"
    printf '  "uptime_sec": %s,\n' "$(uptime_sec)"
    printf '  "armed_at_epoch": %s,\n' "$(date -u +%s)"
    printf '  "armed_at_utc": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "heartbeat_file": "%s",\n' "$HEARTBEAT_FILE"
    printf '  "heartbeat_interval": %s,\n' "$HEARTBEAT_INTERVAL"
    printf '  "heartbeat_lines": %s,\n' "$hb_lines"
    printf '  "container": "%s",\n' "$container"
    printf '  "container_state": "%s",\n' "$docker_state"
    printf '  "host": "%s"\n' "$(hostname)"
    printf '}\n'
  } > "$STATE_FILE"

  local transcript
  transcript="Probe P13 armed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  transcript+=$'\n'"boot_id: $(boot_id)  uptime: $(uptime_sec)s  heartbeat: $HEARTBEAT_FILE (every ${HEARTBEAT_INTERVAL}s)"
  transcript+=$'\n'"live-run stand-in: container $container ($docker_state)"
  transcript+=$'\n'"state: $STATE_FILE"
  transcript+=$'\n'
  transcript+=$'\n'"Next: leave the box idle for longer than its auto-pause setting"
  transcript+=$'\n'"(free tier: 30 minutes fixed; paid: 5-30 minutes). Do not open a shell,"
  transcript+=$'\n'"do not run exec and do not use the dashboard terminal during that window."
  transcript+=$'\n'"Then send the first request with spike S5 (it measures the wake) and run:"
  transcript+=$'\n'"  PHASE0_P13_MODE=assess bash scripts/phase0/checks/P13.sh"
  write_transcript "$transcript"

  echo "P13 armed: heartbeat $HEARTBEAT_FILE, container $container ($docker_state)"
  echo "Leave the box idle for its auto-pause window, then run spike S5 and P13 assess."
  echo "INCONCLUSIVE: needs-owner-run: armed; waiting for the idle window before the verdict"
  exit 2
}

assess() {
  local base_boot base_uptime base_epoch base_lines container
  base_boot="$(state_get boot_id)"
  base_uptime="$(state_get uptime_sec)"
  base_epoch="$(state_get armed_at_epoch)"
  base_lines="$(state_get heartbeat_lines)"
  container="$(cat "$CONTAINER_FILE" 2>/dev/null || state_get container)"

  local cur_boot cur_uptime now_epoch
  cur_boot="$(boot_id)"
  cur_uptime="$(uptime_sec)"
  now_epoch="$(date -u +%s)"

  local hb_lines=0
  [[ -f "$HEARTBEAT_FILE" ]] && hb_lines="$(wc -l < "$HEARTBEAT_FILE" | tr -d ' ')"

  local max_gap=0 last_ts=0 first_ts=0
  if [[ -f "$HEARTBEAT_FILE" && "$hb_lines" -gt 1 ]]; then
    read -r first_ts max_gap last_ts < <(awk 'NR==1{f=$1; prev=$1; next}
      {d=$1-prev; if(d>m)m=d; prev=$1}
      END{printf "%d %d %d\n", f, m+0, prev}' "$HEARTBEAT_FILE")
  fi

  local container_state="unknown"
  if [[ -n "$container" ]] && command -v docker >/dev/null 2>&1; then
    container_state="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)"
  fi

  local transcript
  transcript="Probe P13 assessment at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  transcript+=$'\n'"armed at epoch: ${base_epoch} (wall clock now: ${now_epoch})"
  transcript+=$'\n'"boot_id: armed=$base_boot now=$cur_boot"
  transcript+=$'\n'"uptime: armed=${base_uptime}s now=${cur_uptime}s"
  transcript+=$'\n'"heartbeat: armed_lines=$base_lines now_lines=$hb_lines max_gap=${max_gap}s first=$first_ts last=$last_ts"
  transcript+=$'\n'"live-run container: ${container:-none} state=$container_state"
  transcript+=$'\n'"min pause gap required: ${MIN_PAUSE_GAP}s"

  if [[ -n "$base_boot" && "$cur_boot" != "$base_boot" ]]; then
    transcript+=$'\n'"VERDICT: FAIL - boot_id changed, the box booted fresh; a live run would have been killed."
    write_transcript "$transcript"
    echo "FAIL: the box came back fresh on boot; live runs do not survive the pause"
    exit 1
  fi

  if [[ "$hb_lines" -le "${base_lines:-0}" ]]; then
    transcript+=$'\n'"VERDICT: FAIL - the heartbeat stopped; the live run did not continue."
    write_transcript "$transcript"
    echo "FAIL: heartbeat stopped across the pause; a live run would have died"
    exit 1
  fi

  if [[ "$max_gap" -lt "$MIN_PAUSE_GAP" ]]; then
    transcript+=$'\n'"VERDICT: INCONCLUSIVE - largest heartbeat gap ${max_gap}s < ${MIN_PAUSE_GAP}s; no pause was observed in this window."
    write_transcript "$transcript"
    echo "INCONCLUSIVE: needs-owner-run: no pause observed (max heartbeat gap ${max_gap}s); leave the box idle longer"
    exit 2
  fi

  if [[ "$container_state" != "running" ]]; then
    transcript+=$'\n'"VERDICT: FAIL - pause observed (gap ${max_gap}s) but the container is '${container_state}'."
    write_transcript "$transcript"
    echo "FAIL: pause observed but the live-run container is ${container_state}"
    exit 1
  fi

  transcript+=$'\n'"VERDICT: PASS - a ${max_gap}s pause was observed, the heartbeat continued and the container still runs."
  transcript+=$'\n'"Auto-pause keeps memory and processes: a live run survives it. Production is unaffected."
  write_transcript "$transcript"
  echo "PASS: auto-pause kept the live run (observed gap ${max_gap}s, container running, boot_id unchanged)"
  exit 0
}

MODE="${PHASE0_P13_MODE:-auto}"
case "$MODE" in
  arm)
    arm
    ;;
  assess)
    if [[ ! -f "$STATE_FILE" ]]; then
      write_transcript "Precondition check failed: P13 is not armed ($STATE_FILE missing). Run it once without PHASE0_P13_MODE=assess first."
      echo "INCONCLUSIVE: needs-owner-run: P13 not armed"
      exit 2
    fi
    assess
    ;;
  auto)
    if [[ -f "$STATE_FILE" ]]; then
      assess
    else
      arm
    fi
    ;;
  *)
    echo "Unknown PHASE0_P13_MODE: $MODE (expected arm, assess or auto)" >&2
    exit 64
    ;;
esac
