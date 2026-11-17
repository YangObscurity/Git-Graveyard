#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Work package T1.1: Development box preparation script
# ==============================================================================

# Step 1: Inspect machine architecture and C library version
echo "Step 1: Inspect machine architecture and C library version"
echo "Machine architecture: $(uname -m)"
echo "C library version: $(ldd --version | head -n 1)"

# Step 2: Install kiro-cli 3.1.0 and verify sha256 checksum
echo "Step 2: Install kiro-cli 3.1.0"
if [[ -z "${KIRO_CLI_URL:-}" ]]; then
  echo "Error: KIRO_CLI_URL is unset. Set KIRO_CLI_URL to the artifact download URL." >&2
  exit 1
fi

if [[ -z "${KIRO_CLI_SHA256:-}" ]]; then
  echo "Error: KIRO_CLI_SHA256 is unset. Set KIRO_CLI_SHA256 to the expected sha256 checksum." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

artifact_path="$tmp_dir/kiro-cli-artifact"
echo "Downloading kiro-cli artifact from KIRO_CLI_URL..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$KIRO_CLI_URL" -o "$artifact_path"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$artifact_path" "$KIRO_CLI_URL"
else
  echo "Error: Neither curl nor wget is available." >&2
  exit 1
fi

echo "Verifying sha256 checksum..."
actual_sha256="$(sha256sum "$artifact_path" | awk '{print $1}')"
if [[ "$actual_sha256" != "$KIRO_CLI_SHA256" ]]; then
  echo "Error: sha256 checksum mismatch for kiro-cli artifact." >&2
  echo "Expected: $KIRO_CLI_SHA256" >&2
  echo "Actual:   $actual_sha256" >&2
  exit 1
fi
echo "sha256 checksum verified."

echo "Extracting and installing kiro-cli 3.1.0..."
extract_dir="$tmp_dir/extracted"
mkdir -p "$extract_dir"

if file "$artifact_path" 2>/dev/null | grep -qi "zip"; then
  unzip -q "$artifact_path" -d "$extract_dir"
elif file "$artifact_path" 2>/dev/null | grep -qi "gzip\|tar"; then
  tar -xf "$artifact_path" -C "$extract_dir"
else
  if ! unzip -q "$artifact_path" -d "$extract_dir" 2>/dev/null; then
    tar -xf "$artifact_path" -C "$extract_dir" 2>/dev/null || cp "$artifact_path" "$extract_dir/kiro-cli"
  fi
fi

if [[ -f "$extract_dir/kirocli/install.sh" ]]; then
  chmod +x "$extract_dir/kirocli/install.sh"
  "$extract_dir/kirocli/install.sh" --global --no-modify-path
elif [[ -f "$extract_dir/install.sh" ]]; then
  chmod +x "$extract_dir/install.sh"
  "$extract_dir/install.sh" --global --no-modify-path
elif [[ -f "$extract_dir/kiro-cli" ]]; then
  chmod +x "$extract_dir/kiro-cli"
  install -m 755 "$extract_dir/kiro-cli" /usr/local/bin/kiro-cli
else
  installer="$(find "$extract_dir" -type f -name "install.sh" | head -n 1)"
  if [[ -n "$installer" ]]; then
    chmod +x "$installer"
    "$installer" --global --no-modify-path
  else
    echo "Error: Could not locate installer script or kiro-cli binary in artifact." >&2
    exit 1
  fi
fi
echo "kiro-cli 3.1.0 installed successfully."

# Step 3: Write root-owned KIRO_DEFAULT_SETTINGS file
echo "Step 3: Write root-owned KIRO_DEFAULT_SETTINGS file"

# Confirmed Kiro default settings keys (aligned with scripts/host-isolation.sh)
CONFIRMED_TELEMETRY_KEY="telemetry.enabled"
CONFIRMED_AUTO_UPDATE_KEY="app.disableAutoupdates"

if [[ -z "$CONFIRMED_TELEMETRY_KEY" || -z "$CONFIRMED_AUTO_UPDATE_KEY" ]]; then
  echo "settings keys not confirmed"
  exit 3
fi

default_settings_file="${KIRO_DEFAULT_SETTINGS:-/etc/kiro/default-settings.json}"
mkdir -p "$(dirname "$default_settings_file")"

cat << EOF > "$default_settings_file"
{
  "$CONFIRMED_TELEMETRY_KEY": false,
  "$CONFIRMED_AUTO_UPDATE_KEY": true
}
EOF

chown root:root "$default_settings_file" 2>/dev/null || true
chmod 644 "$default_settings_file"
echo "Root-owned KIRO_DEFAULT_SETTINGS written to $default_settings_file."

# Step 4: Check development Kiro key in environment
echo "Step 4: Check development Kiro key in environment"

if [[ -z "${KIRO_API_KEY:-}" ]]; then
  echo "Error: KIRO_API_KEY is missing from environment" >&2
  exit 1
fi

echo "Present development Kiro key variable: KIRO_API_KEY"

unexpected_key_vars=()
for var in $(compgen -e); do
  case "$var" in
    KIRO_API_KEY)
      ;;
    *KIRO*KEY* | *KIRO*PROD* | *PROD*KIRO*)
      unexpected_key_vars+=("$var")
      ;;
  esac
done

if [[ ${#unexpected_key_vars[@]} -gt 0 ]]; then
  echo "Error: Unexpected key variable(s) found in environment:" >&2
  for key_name in "${unexpected_key_vars[@]}"; do
    echo "  $key_name" >&2
  done
  exit 1
fi

echo "Environment check passed: only development Kiro key is present."
