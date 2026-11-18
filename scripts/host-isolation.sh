#!/usr/bin/env bash
set -euo pipefail

# Work package T11.1: Host isolation, user permissions and Kiro system settings
# Requirements: 21.5, 22.1, 22.2, 22.3, 22.4, 22.5, 22.13, 42.6, 42.7, 42.8, 42.14, 42.16, 42.18

run_elevated() {
  if [[ $(id -u) -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

# Step 1: Environment variable verification
# The manifest URL and expected checksum are not in the spec; read from environment variables.
MANIFEST_URL="${KIRO_CLI_MANIFEST_URL:-${KIRO_RELEASE_MANIFEST_URL:-${KIRO_MANIFEST_URL:-}}}"
EXPECTED_SHA256="${KIRO_CLI_EXPECTED_SHA256:-${KIRO_CLI_SHA256:-${KIRO_EXPECTED_SHA256:-${KIRO_EXPECTED_CHECKSUM:-${KIRO_SHA256:-}}}}}"

if [[ -z "${MANIFEST_URL}" ]]; then
  echo "Error: Release manifest URL is unset. Please set KIRO_CLI_MANIFEST_URL or KIRO_RELEASE_MANIFEST_URL." >&2
  exit 1
fi

if [[ -z "${EXPECTED_SHA256}" ]]; then
  echo "Error: Expected checksum is unset. Please set KIRO_CLI_EXPECTED_SHA256 or KIRO_CLI_SHA256." >&2
  exit 1
fi

# Step 2: Retrieve release manifest and verify checksum for kiro-cli 3.1.0
manifest_content=""
if [[ "$MANIFEST_URL" =~ ^http:// ]]; then
  echo "Error: Insecure http:// manifest URL is not allowed: $MANIFEST_URL" >&2
  exit 1
elif [[ "$MANIFEST_URL" =~ ^https:// ]]; then
  if command -v curl >/dev/null 2>&1; then
    manifest_content="$(curl -fsSL "$MANIFEST_URL")"
  elif command -v wget >/dev/null 2>&1; then
    manifest_content="$(wget -q -O - "$MANIFEST_URL")"
  else
    echo "Error: Neither curl nor wget is available to fetch manifest." >&2
    exit 1
  fi
elif [[ "$MANIFEST_URL" =~ ^file:// ]]; then
  manifest_file="${MANIFEST_URL#file://}"
  if [[ ! -f "$manifest_file" ]]; then
    echo "Error: Manifest file not found: $manifest_file" >&2
    exit 1
  fi
  manifest_content="$(cat "$manifest_file")"
elif [[ -f "$MANIFEST_URL" ]]; then
  manifest_content="$(cat "$MANIFEST_URL")"
else
  echo "Error: Invalid manifest URL or file path: $MANIFEST_URL (only https://, file://, or existing local files are accepted)" >&2
  exit 1
fi

if [[ -z "$manifest_content" ]]; then
  echo "Error: Release manifest is empty or could not be loaded." >&2
  exit 1
fi

normalized_expected="$(echo "$EXPECTED_SHA256" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

# The expected checksum must be exactly 64 hexadecimal characters.
if ! [[ "$normalized_expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Error: Expected checksum must be exactly 64 hexadecimal characters (got ${#normalized_expected})." >&2
  exit 1
fi

# Parse first whitespace-delimited field normalized to lowercase, filter strictly to
# 64 hex chars, and match whole line with grep -F -x -q.
if ! echo "$manifest_content" | awk '{print $1}' | tr '[:upper:]' '[:lower:]' | grep -E '^[0-9a-f]{64}$' | grep -F -x -q "$normalized_expected"; then
  echo "Error: Expected checksum $EXPECTED_SHA256 not found in release manifest." >&2
  exit 1
fi
echo "Verified: kiro-cli 3.1.0 checksum found in release manifest."

# Verify installed binary checksum if present
kiro_bin="${KIRO_CLI_PATH:-${KIRO_CLI_BIN:-}}"
if [[ -z "$kiro_bin" ]] && command -v kiro-cli >/dev/null 2>&1; then
  kiro_bin="$(command -v kiro-cli)"
fi
if [[ -n "$kiro_bin" && -f "$kiro_bin" ]]; then
  actual_sha256="$(sha256sum "$kiro_bin" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')"
  if [[ "$actual_sha256" != "$normalized_expected" ]]; then
    echo "Error: Installed kiro-cli binary checksum ($actual_sha256) does not match expected checksum ($normalized_expected)." >&2
    exit 1
  fi
  echo "Verified: Installed kiro-cli binary checksum matches expected checksum."
fi

# Step 3: Configure skel user with no docker or sudo membership
SKEL_USER="skel"

if ! id -u "$SKEL_USER" >/dev/null 2>&1; then
  echo "User $SKEL_USER does not exist. Creating unprivileged user $SKEL_USER..."
  if command -v useradd >/dev/null 2>&1; then
    run_elevated useradd -m -s /bin/bash "$SKEL_USER"
  elif command -v adduser >/dev/null 2>&1; then
    run_elevated adduser --disabled-password --gecos "" "$SKEL_USER"
  else
    echo "Error: Cannot create user $SKEL_USER (neither useradd nor adduser command found)." >&2
    exit 1
  fi
fi

for forbidden_group in docker sudo wheel; do
  if getent group "$forbidden_group" >/dev/null 2>&1; then
    if id -nG "$SKEL_USER" 2>/dev/null | grep -qw "$forbidden_group"; then
      echo "Removing $SKEL_USER from forbidden group: $forbidden_group"
      if command -v gpasswd >/dev/null 2>&1; then
        run_elevated gpasswd -d "$SKEL_USER" "$forbidden_group"
      elif command -v deluser >/dev/null 2>&1; then
        run_elevated deluser "$SKEL_USER" "$forbidden_group"
      else
        echo "Error: Neither gpasswd nor deluser found to remove $SKEL_USER from $forbidden_group." >&2
        exit 1
      fi
    fi
  fi
done

if [[ -f /etc/sudoers.d/skel ]]; then
  run_elevated rm -f /etc/sudoers.d/skel
fi

skel_groups="$(id -nG "$SKEL_USER")"
for forbidden_group in docker sudo wheel; do
  if echo "$skel_groups" | grep -qw "$forbidden_group"; then
    echo "Error: User $SKEL_USER belongs to forbidden group: $forbidden_group" >&2
    exit 1
  fi
done
echo "Verified: User $SKEL_USER has no docker or sudo membership."

# Step 4: Configure Necromancer files to prevent skel read access
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NECRO_FILES_DIR="${NECROMANCER_DIR:-${NECROMANCER_PATH:-$REPO_DIR}}"

if [[ -d "$NECRO_FILES_DIR" ]]; then
  run_elevated chmod o-rwx "$NECRO_FILES_DIR"

  if command -v setfacl >/dev/null 2>&1; then
    run_elevated setfacl -m "u:${SKEL_USER}:---" "$NECRO_FILES_DIR"
  fi

  can_read=false
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    if sudo -u "$SKEL_USER" test -r "$NECRO_FILES_DIR" 2>/dev/null; then
      can_read=true
    fi
  elif command -v su >/dev/null 2>&1 && [[ $(id -u) -eq 0 ]]; then
    if su -s /bin/bash "$SKEL_USER" -c 'test -r "$1"' -- "$NECRO_FILES_DIR" 2>/dev/null; then
      can_read=true
    fi
  else
    mode="$(stat -c "%a" "$NECRO_FILES_DIR" 2>/dev/null || stat -f "%Lp" "$NECRO_FILES_DIR" 2>/dev/null || echo "")"
    if [[ -n "$mode" ]]; then
      other_digit="${mode: -1}"
      if [[ "$other_digit" -ge 4 ]]; then
        can_read=true
      fi
    fi
  fi

  if [[ "$can_read" = true ]]; then
    echo "Error: User $SKEL_USER has read access to Necromancer files at $NECRO_FILES_DIR" >&2
    exit 1
  fi
  echo "Verified: User $SKEL_USER has no read access to Necromancer files."
fi

# Step 5: Ensure root-owned KIRO_DEFAULT_SETTINGS if path specified or configured
SETTINGS_FILE="${KIRO_DEFAULT_SETTINGS:-/etc/kiro/default-settings.json}"
SETTINGS_DIR="$(dirname "$SETTINGS_FILE")"
if [[ ! -d "$SETTINGS_DIR" ]]; then
  run_elevated mkdir -p "$SETTINGS_DIR"
fi
TMP_SETTINGS="$(mktemp)"
cat << 'EOF' > "$TMP_SETTINGS"
{
  "telemetry.enabled": false,
  "app.disableAutoupdates": true
}
EOF
run_elevated cp "$TMP_SETTINGS" "$SETTINGS_FILE"
run_elevated chown root:root "$SETTINGS_FILE"
run_elevated chmod 644 "$SETTINGS_FILE"
rm -f "$TMP_SETTINGS"
echo "Configured: Root-owned KIRO_DEFAULT_SETTINGS file written."

# Step 6: Configure default-deny egress rule for skel user using nftables
NFT_BIN=""
if command -v nft >/dev/null 2>&1; then
  NFT_BIN="$(command -v nft)"
fi
if [[ -z "$NFT_BIN" ]]; then
  for candidate in /usr/sbin/nft /sbin/nft /usr/local/sbin/nft; do
    if [[ -x "$candidate" ]]; then
      NFT_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NFT_BIN" ]]; then
  echo "Error: nftables command (nft) not found." >&2
  exit 1
fi

SKEL_UID="$(id -u "$SKEL_USER")"
if [[ -z "$SKEL_UID" ]]; then
  echo "Error: User $SKEL_USER does not exist or UID could not be determined." >&2
  exit 1
fi

ALLOWLIST_FILE="${EGRESS_ALLOWLIST_FILE:-$REPO_DIR/config/egress-allowlist.txt}"

is_valid_ipv4() {
  local entry="$1"
  local ip_part="${entry%%/*}"
  if [[ "$entry" =~ / ]]; then
    local cidr_part="${entry##*/}"
    if [[ "$entry" != "${ip_part}/${cidr_part}" ]]; then
      return 1
    fi
    if ! [[ "$cidr_part" =~ ^[0-9]+$ ]] || [[ "$cidr_part" -lt 8 ]] || [[ "$cidr_part" -gt 32 ]]; then
      return 1
    fi
  fi
  if ! [[ "$ip_part" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    return 1
  fi
  local IFS='.'
  local -a octets=($ip_part)
  local all_zero=true
  local all_255=true
  for octet in "${octets[@]}"; do
    if [[ $((10#$octet)) -gt 255 ]]; then
      return 1
    fi
    if [[ $((10#$octet)) -ne 0 ]]; then
      all_zero=false
    fi
    if [[ $((10#$octet)) -ne 255 ]]; then
      all_255=false
    fi
  done
  if [[ "$all_zero" = true || "$all_255" = true ]]; then
    return 1
  fi
  return 0
}

is_valid_ipv6() {
  local entry="$1"
  local ip_part="${entry%%/*}"
  if [[ "$entry" =~ / ]]; then
    local cidr_part="${entry##*/}"
    if [[ "$entry" != "${ip_part}/${cidr_part}" ]]; then
      return 1
    fi
    if ! [[ "$cidr_part" =~ ^[0-9]+$ ]] || [[ "$cidr_part" -lt 32 ]] || [[ "$cidr_part" -gt 128 ]]; then
      return 1
    fi
  fi
  if ! [[ "$ip_part" =~ ^[0-9a-fA-F:]+$ ]] || ! [[ "$ip_part" =~ : ]]; then
    return 1
  fi
  if [[ "$ip_part" =~ ::: ]] || [[ "$ip_part" =~ ::.*:: ]]; then
    return 1
  fi
  local IFS=':'
  local -a groups=($ip_part)
  if [[ ${#groups[@]} -gt 8 ]]; then
    return 1
  fi
  for grp in "${groups[@]}"; do
    if [[ ${#grp} -gt 4 ]]; then
      return 1
    fi
  done
  local non_colons="${ip_part//:/}"
  if [[ -z "$non_colons" ]] || [[ "$non_colons" =~ ^0+$ ]]; then
    return 1
  fi
  return 0
}

is_valid_hostname() {
  local entry="$1"
  if [[ ${#entry} -gt 253 || ${#entry} -lt 1 ]]; then
    return 1
  fi
  if ! [[ "$entry" =~ ^[a-zA-Z0-9.-]+$ ]]; then
    return 1
  fi
  if [[ "$entry" =~ ^[.-] || "$entry" =~ [.-]$ ]]; then
    return 1
  fi
  if [[ "$entry" =~ \.\. ]]; then
    return 1
  fi
  local IFS='.'
  local -a labels=($entry)
  for label in "${labels[@]}"; do
    if [[ ${#label} -lt 1 || ${#label} -gt 63 ]]; then
      return 1
    fi
    if ! [[ "$label" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]]; then
      return 1
    fi
  done
  return 0
}

allow_rules=""
entry_count=0

if [[ -f "$ALLOWLIST_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    cleaned="$(echo "$line" | sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ -z "$cleaned" ]]; then
      continue
    fi
    entry_count=$((entry_count + 1))

    # Any entry with prefix length 0 (e.g. 0.0.0.0/0 or ::/0) matches every
    # destination and is refused.
    if [[ "$cleaned" == */* ]] && [[ "${cleaned##*/}" =~ ^0+$ ]]; then
      echo "Error: Egress allowlist entry '$cleaned' has prefix length 0 and is refused." >&2
      exit 1
    fi

    if is_valid_ipv4 "$cleaned"; then
      allow_rules="${allow_rules}    skuid $SKEL_UID ip daddr $cleaned accept"$'\n'
    elif is_valid_ipv6 "$cleaned"; then
      allow_rules="${allow_rules}    skuid $SKEL_UID ip6 daddr $cleaned accept"$'\n'
    elif is_valid_hostname "$cleaned"; then
      if [[ "$cleaned" == *.invalid || "$cleaned" == "invalid" ]]; then
        echo "Error: Hostname '$cleaned' is under reserved .invalid domain and cannot be resolved." >&2
        exit 1
      fi
      resolved=false
      if command -v getent >/dev/null 2>&1; then
        while IFS= read -r addr; do
          if [[ -n "$addr" ]] && is_valid_ipv4 "$addr"; then
            IFS='.' read -r r1 r2 r3 r4 <<< "$addr"
            o1=$((10#$r1))
            o2=$((10#$r2))
            if [[ $o1 -eq 0 || $o1 -eq 10 || ($o1 -eq 100 && $o2 -ge 64 && $o2 -le 127) || $o1 -eq 127 || ($o1 -eq 169 && $o2 -eq 254) || ($o1 -eq 172 && $o2 -ge 16 && $o2 -le 31) || ($o1 -eq 192 && $o2 -eq 168) || $o1 -ge 224 ]]; then
              continue
            fi
            resolved=true
            allow_rules="${allow_rules}    skuid $SKEL_UID ip daddr $addr accept"$'\n'
          fi
        done < <(getent ahosts "$cleaned" 2>/dev/null | awk '{print $1}' | sort -u)
      fi
      if [[ "$resolved" = false ]]; then
        echo "Error: Hostname '$cleaned' failed to resolve to an IPv4 address." >&2
        exit 1
      fi
    else
      echo "Error: Invalid egress allowlist entry '$cleaned'. Must be a valid IP address or strict hostname." >&2
      exit 1
    fi
  done < "$ALLOWLIST_FILE"
fi

if [[ $entry_count -eq 0 ]]; then
  echo "Egress allowlist ($ALLOWLIST_FILE) has no entries. Denying all skel user egress except loopback (fail closed)."
else
  echo "Configured $entry_count allowlist destination(s) for skel user from $ALLOWLIST_FILE."
fi

TMP_RULESET="$(mktemp)"
cat << EOF > "$TMP_RULESET"
table inet host_isolation
delete table inet host_isolation
table inet host_isolation {
  chain output {
    type filter hook output priority filter; policy accept;
    skuid $SKEL_UID oif "lo" ip daddr 127.0.0.0/8 accept
    skuid $SKEL_UID oif "lo" ip6 daddr ::1 accept
${allow_rules}    skuid $SKEL_UID drop
  }
}
EOF

# Before applying, check the generated ruleset with nft in check mode (nft -c -f) and abort on failure
if ! run_elevated "$NFT_BIN" -c -f "$TMP_RULESET"; then
  echo "Error: nft check mode failed (nft -c -f) for generated ruleset. Aborting without applying." >&2
  rm -f "$TMP_RULESET"
  exit 1
fi

run_elevated "$NFT_BIN" -f "$TMP_RULESET"
rm -f "$TMP_RULESET"

# Step 7: Final self-check: verify nftables default-deny egress rules for skel UID
echo "Listing nftables rules matching skel UID ($SKEL_UID):"
table_content="$(run_elevated "$NFT_BIN" list table inet host_isolation)"
matching_rules=""
if echo "$table_content" | grep -qE "(skuid|meta skuid)[[:space:]]+($SKEL_UID|$SKEL_USER)\b"; then
  matching_rules="$(echo "$table_content" | grep -E "(skuid|meta skuid)[[:space:]]+($SKEL_UID|$SKEL_USER)\b")"
fi
if [[ -z "$matching_rules" ]]; then
  ruleset_content="$(run_elevated "$NFT_BIN" list ruleset)"
  if echo "$ruleset_content" | grep -qE "(skuid|meta skuid)[[:space:]]+($SKEL_UID|$SKEL_USER)\b"; then
    matching_rules="$(echo "$ruleset_content" | grep -E "(skuid|meta skuid)[[:space:]]+($SKEL_UID|$SKEL_USER)\b")"
  fi
fi
echo "$matching_rules"

if ! echo "$matching_rules" | grep -q "drop"; then
  echo "Error: Default-deny drop rule for skel UID ($SKEL_UID) is missing from nftables." >&2
  exit 1
fi
echo "Verified: Default-deny egress drop rule for skel UID ($SKEL_UID) is active."

echo "Host isolation configuration and verification completed successfully."
