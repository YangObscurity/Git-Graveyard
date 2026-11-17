// Task 11.1: Host isolation, user permissions and Kiro system settings
// Requirements: 21.5, 22.1, 22.2, 22.3, 22.4, 22.5, 22.13, 42.6, 42.7, 42.8, 42.14, 42.16, 42.18

export interface UserIsolationPolicy {
  readonly username: string;
  readonly forbiddenGroups: readonly string[];
  readonly allowSudo: boolean;
  readonly allowDocker: boolean;
}

export interface FileAccessPolicy {
  readonly targetUser: string;
  readonly allowRead: boolean;
  readonly allowWrite: boolean;
  readonly allowExecute: boolean;
  readonly forbiddenModeMask: number;
}

export interface SecretFilePolicy {
  readonly allowedReader: string;
  readonly forbiddenReader: string;
  readonly requiredFileMode: number;
}

export interface KiroCliPolicy {
  readonly requiredVersion: string;
  readonly checksumAlgorithm: string;
  readonly autoUpdateDisabled: boolean;
}

export interface KiroDefaultSettingsPolicy {
  readonly telemetryKey: string;
  readonly telemetryValue: boolean;
  readonly autoUpdatesKey: string;
  readonly autoUpdatesValue: boolean;
  readonly requiredSettings: Readonly<Record<string, unknown>>;
  readonly settingsFilePath: string;
  readonly fileOwner: string;
  readonly shareContentOptOutRequired: boolean;
}

export interface HostNetworkPolicy {
  readonly targetUser: string;
  readonly defaultOutbound: "deny";
  readonly allowLoopbackGateway: boolean;
  readonly allowKiroEndpoints: boolean;
}

export interface UiServerPolicy {
  readonly unprivilegedUserOnly: boolean;
  readonly allowSecrets: boolean;
  readonly apiReach: "loopback";
}

export interface HostIsolationPolicy {
  readonly userPolicy: UserIsolationPolicy;
  readonly filePolicy: FileAccessPolicy;
  readonly secretPolicy: SecretFilePolicy;
  readonly kiroCliPolicy: KiroCliPolicy;
  readonly settingsPolicy: KiroDefaultSettingsPolicy;
  readonly networkPolicy: HostNetworkPolicy;
  readonly uiServerPolicy: UiServerPolicy;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export interface FileAccessSubject {
  readonly username: string;
  readonly groups: readonly string[];
}

export interface FileMetadata {
  readonly owner: string;
  readonly group: string;
  readonly mode: number | string;
}

export interface ChecksumVerificationResult {
  readonly valid: boolean;
  readonly actual?: string;
  readonly expected?: string;
  readonly reason?: string;
}

export interface ManifestVerificationResult {
  readonly valid: boolean;
  readonly expectedSha256: string;
  readonly matchedEntry?: unknown;
  readonly reason?: string;
}

export interface EnvironmentCheckResult {
  readonly manifestUrl?: string;
  readonly expectedChecksum?: string;
  readonly valid: boolean;
  readonly missing: readonly string[];
}

// Pure functions returning policy descriptors as data

export function getSkelUserPolicy(): UserIsolationPolicy {
  return {
    username: "skel",
    forbiddenGroups: ["docker", "sudo", "wheel"],
    allowSudo: false,
    allowDocker: false,
  };
}

export function getNecromancerFilePolicy(): FileAccessPolicy {
  return {
    targetUser: "skel",
    allowRead: false,
    allowWrite: false,
    allowExecute: false,
    forbiddenModeMask: 0o007,
  };
}

export function getSecretFilePolicy(): SecretFilePolicy {
  return {
    allowedReader: "necro",
    forbiddenReader: "skel",
    requiredFileMode: 0o600,
  };
}

export function getKiroCliPolicy(): KiroCliPolicy {
  return {
    requiredVersion: "3.1.0",
    checksumAlgorithm: "sha256",
    autoUpdateDisabled: true,
  };
}

export function getKiroDefaultSettingsPolicy(): KiroDefaultSettingsPolicy {
  return {
    telemetryKey: "telemetry.enabled",
    telemetryValue: false,
    autoUpdatesKey: "app.disableAutoupdates",
    autoUpdatesValue: true,
    requiredSettings: {
      "telemetry.enabled": false,
      "app.disableAutoupdates": true,
    },
    settingsFilePath: "/etc/kiro/default-settings.json",
    fileOwner: "root",
    shareContentOptOutRequired: true,
  };
}

export function getHostNetworkPolicy(): HostNetworkPolicy {
  return {
    targetUser: "skel",
    defaultOutbound: "deny",
    allowLoopbackGateway: true,
    allowKiroEndpoints: true,
  };
}

export function getUiServerPolicy(): UiServerPolicy {
  return {
    unprivilegedUserOnly: true,
    allowSecrets: false,
    apiReach: "loopback",
  };
}

export function getHostPolicy(): HostIsolationPolicy {
  return {
    userPolicy: getSkelUserPolicy(),
    filePolicy: getNecromancerFilePolicy(),
    secretPolicy: getSecretFilePolicy(),
    kiroCliPolicy: getKiroCliPolicy(),
    settingsPolicy: getKiroDefaultSettingsPolicy(),
    networkPolicy: getHostNetworkPolicy(),
    uiServerPolicy: getUiServerPolicy(),
  };
}

// Pure validation functions

export function validateUserGroups(
  username: string,
  groups: readonly string[],
  policy: UserIsolationPolicy = getSkelUserPolicy()
): ValidationResult {
  const violations: string[] = [];
  const normUser = username.trim().toLowerCase();
  const expectedUser = policy.username.trim().toLowerCase();

  if (normUser !== expectedUser) {
    violations.push(`Expected user "${policy.username}", got "${username}"`);
  }

  const forbiddenSet = new Set(
    policy.forbiddenGroups.map((g) => g.trim().toLowerCase())
  );

  for (const grp of groups) {
    const normGrp = grp.trim().toLowerCase();
    if (forbiddenSet.has(normGrp)) {
      violations.push(`User "${username}" belongs to forbidden group "${grp}"`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

export function validateFileModePermissions(
  mode: number | string,
  policy: FileAccessPolicy = getNecromancerFilePolicy()
): ValidationResult {
  const violations: string[] = [];
  const numericMode =
    typeof mode === "string" ? parseInt(mode, 8) : mode;

  if (isNaN(numericMode)) {
    return {
      valid: false,
      violations: [`Invalid file mode: "${mode}"`],
    };
  }

  const otherBits = numericMode & 0o007;

  if (!policy.allowRead && (otherBits & 0o004) !== 0) {
    violations.push("World/other read permission is granted (o+r)");
  }
  if (!policy.allowWrite && (otherBits & 0o002) !== 0) {
    violations.push("World/other write permission is granted (o+w)");
  }
  if (!policy.allowExecute && (otherBits & 0o001) !== 0) {
    violations.push("World/other execute permission is granted (o+x)");
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

export function canUserReadFile(
  file: FileMetadata,
  user: FileAccessSubject
): boolean {
  if (user.username === "root") {
    return true;
  }

  const numericMode =
    typeof file.mode === "string" ? parseInt(file.mode, 8) : file.mode;

  if (isNaN(numericMode)) {
    return false;
  }

  if (user.username === file.owner) {
    return (numericMode & 0o400) !== 0;
  }

  const userGroups = new Set(user.groups.map((g) => g.toLowerCase()));
  if (userGroups.has(file.group.toLowerCase())) {
    return (numericMode & 0o040) !== 0;
  }

  return (numericMode & 0o004) !== 0;
}

export function verifyChecksum(
  actualSha256: string,
  expectedSha256: string
): ChecksumVerificationResult {
  const normActual = actualSha256.trim().toLowerCase();
  const normExpected = expectedSha256.trim().toLowerCase();

  if (!normActual) {
    return {
      valid: false,
      actual: normActual,
      expected: normExpected,
      reason: "Actual checksum is empty",
    };
  }

  if (!normExpected) {
    return {
      valid: false,
      actual: normActual,
      expected: normExpected,
      reason: "Expected checksum is empty",
    };
  }

  const matches = normActual === normExpected;
  return {
    valid: matches,
    actual: normActual,
    expected: normExpected,
    reason: matches
      ? undefined
      : `Checksum mismatch: expected ${normExpected}, got ${normActual}`,
  };
}

export function verifyManifestContainsChecksum(
  manifest: unknown,
  expectedSha256: string
): ManifestVerificationResult {
  const normExpected = expectedSha256.trim().toLowerCase();
  if (!normExpected) {
    return {
      valid: false,
      expectedSha256,
      reason: "Expected checksum is empty",
    };
  }

  if (!manifest) {
    return {
      valid: false,
      expectedSha256: normExpected,
      reason: "Manifest content is empty or null",
    };
  }

  if (typeof manifest === "string") {
    const trimmed = manifest.trim();
    if (!trimmed) {
      return {
        valid: false,
        expectedSha256: normExpected,
        reason: "Manifest string is empty",
      };
    }

    try {
      const parsed = JSON.parse(trimmed);
      return verifyManifestContainsChecksum(parsed, normExpected);
    } catch {
      const lowerText = trimmed.toLowerCase();
      if (lowerText.includes(normExpected)) {
        return {
          valid: true,
          expectedSha256: normExpected,
          matchedEntry: trimmed,
        };
      }
      return {
        valid: false,
        expectedSha256: normExpected,
        reason: `Expected checksum ${normExpected} not found in manifest text`,
      };
    }
  }

  let foundEntry: unknown = undefined;

  function search(node: unknown): boolean {
    if (!node) return false;

    if (typeof node === "string") {
      if (node.trim().toLowerCase() === normExpected) {
        return true;
      }
      return false;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        if (search(item)) {
          if (!foundEntry) foundEntry = item;
          return true;
        }
      }
      return false;
    }

    if (typeof node === "object") {
      for (const value of Object.values(node)) {
        if (search(value)) {
          if (!foundEntry) foundEntry = node;
          return true;
        }
      }
      return false;
    }

    return false;
  }

  const found = search(manifest);
  return {
    valid: found,
    expectedSha256: normExpected,
    matchedEntry: foundEntry,
    reason: found
      ? undefined
      : `Expected checksum ${normExpected} not found in release manifest`,
  };
}

export function validateKiroDefaultSettings(
  settings: Record<string, unknown>,
  policy: KiroDefaultSettingsPolicy = getKiroDefaultSettingsPolicy()
): ValidationResult {
  const violations: string[] = [];

  for (const [key, expectedVal] of Object.entries(policy.requiredSettings)) {
    if (settings[key] !== expectedVal) {
      violations.push(
        `Setting "${key}" expected ${JSON.stringify(expectedVal)}, but got ${JSON.stringify(settings[key])}`
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

export function checkHostIsolationEnvironment(
  env: Record<string, string | undefined>
): EnvironmentCheckResult {
  const manifestUrl =
    env.KIRO_CLI_MANIFEST_URL ||
    env.KIRO_RELEASE_MANIFEST_URL ||
    env.KIRO_MANIFEST_URL;
  const expectedChecksum =
    env.KIRO_CLI_EXPECTED_SHA256 ||
    env.KIRO_CLI_SHA256 ||
    env.KIRO_EXPECTED_SHA256 ||
    env.KIRO_EXPECTED_CHECKSUM ||
    env.KIRO_SHA256;

  const missing: string[] = [];
  if (!manifestUrl || !manifestUrl.trim()) {
    missing.push("manifest URL (KIRO_CLI_MANIFEST_URL or KIRO_RELEASE_MANIFEST_URL)");
  }
  if (!expectedChecksum || !expectedChecksum.trim()) {
    missing.push("expected checksum (KIRO_CLI_EXPECTED_SHA256 or KIRO_CLI_SHA256)");
  }

  return {
    manifestUrl: manifestUrl?.trim(),
    expectedChecksum: expectedChecksum?.trim(),
    valid: missing.length === 0,
    missing,
  };
}
