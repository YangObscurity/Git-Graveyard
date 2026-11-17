// Task 11.5: Credential vault and secret placement constraints
// Requirements: 42.7, 42.8, 42.9, 42.10, 42.11, 42.12, 42.13, 42.14, 42.15, 42.17, 42.19, 42.20

import { redactObject, scanTextForSecrets } from "./redactor";

export type ExecutionEnvironment = "development" | "production";

export type SecretKind =
  | "kiro_api_key"
  | "instabox_api_key"
  | "github_token"
  | "docker_pat"
  | "admin_secret"
  | "dev_box_ssh_address";

export type SecretLocationType =
  | "necro_secret_file"
  | "host_secret_store"
  | "necromancer_memory"
  | "kiro_cli_child_env"
  | "owner_local_machine"
  | "git_service"
  | "server_config"
  | "host_ssh_config"
  | "box_environment"
  | "box_file"
  | "stored_event"
  | "command_log"
  | "artifact"
  | "repository"
  | "documentation"
  | "ui_bundle"
  | "skeleton_env"
  | "dev_box";

export interface SecretPlacementPolicy {
  readonly kind: SecretKind;
  readonly allowedLocations: readonly SecretLocationType[];
  readonly forbiddenLocations: readonly SecretLocationType[];
  readonly description: string;
}

export interface SecretInventory {
  readonly kiroApiKeyDev?: string;
  readonly kiroApiKeyProd?: string;
  readonly instaboxApiKey?: string;
  readonly githubToken?: string;
  readonly dockerPat?: string;
  readonly adminSecret?: string;
  readonly devBoxSshAddress?: string;
  readonly extraSecrets?: readonly string[];
}

export interface PlacementViolation {
  readonly secretKind: SecretKind | "custom_secret";
  readonly location: SecretLocationType | string;
  readonly target: string;
  readonly match?: string;
  readonly rule: string;
}

export interface PlacementCheckResult {
  readonly valid: boolean;
  readonly passed: boolean;
  readonly violations: readonly PlacementViolation[];
  readonly reason?: string;
}

export interface KiroKeyStorageMetadata {
  readonly storageType: "file" | "host_secret_store";
  readonly filePath?: string;
  readonly fileOwner?: string;
  readonly fileMode?: number | string;
}

export interface LiveRunEligibilityConfig {
  readonly contentUseOptOutSet: boolean;
  readonly environment: ExecutionEnvironment;
  readonly kiroApiKeyDev?: string;
  readonly kiroApiKeyProd?: string;
}

export interface LiveRunEligibilityResult {
  readonly allowed: boolean;
  readonly violations: readonly string[];
  readonly reason?: string;
}

export type PublicationTarget = "history" | "replay";
export type PublicationStatus = "pending" | "reviewed" | "approved" | "rejected";

export interface RunPublicationRecord {
  readonly runId: string;
  readonly target: PublicationTarget;
  readonly status: PublicationStatus;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  readonly redacted: boolean;
  readonly rawData?: Readonly<Record<string, unknown>>;
  readonly publishedData?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
}

export interface PublicationValidationResult {
  readonly canPublish: boolean;
  readonly violations: readonly string[];
  readonly reason?: string;
}

export interface CredentialVaultConfig {
  readonly environment?: ExecutionEnvironment;
  readonly secrets?: SecretInventory;
}

// Secret placement policies defined as data

export const SECRET_PLACEMENT_POLICIES: Readonly<Record<SecretKind, SecretPlacementPolicy>> = {
  kiro_api_key: {
    kind: "kiro_api_key",
    allowedLocations: [
      "necro_secret_file",
      "host_secret_store",
      "necromancer_memory",
      "kiro_cli_child_env",
    ],
    forbiddenLocations: [
      "box_environment",
      "box_file",
      "stored_event",
      "command_log",
      "artifact",
      "repository",
      "documentation",
      "ui_bundle",
      "dev_box",
    ],
    description:
      "Kiro API key is kept only in necro secret file (dev) or host secret store (prod), in memory, and in kiro-cli child env (Requirements 42.7, 42.8).",
  },
  instabox_api_key: {
    kind: "instabox_api_key",
    allowedLocations: ["owner_local_machine"],
    forbiddenLocations: [
      "box_environment",
      "box_file",
      "stored_event",
      "command_log",
      "artifact",
      "repository",
      "documentation",
      "ui_bundle",
      "dev_box",
      "host_secret_store",
      "necromancer_memory",
      "kiro_cli_child_env",
      "skeleton_env",
    ],
    description:
      "Instabox API key is stored only on Owner local machine and excluded from Boxes and repository (Requirements 42.17, 42.20).",
  },
  github_token: {
    kind: "github_token",
    allowedLocations: ["git_service"],
    forbiddenLocations: [
      "skeleton_env",
      "box_environment",
      "box_file",
      "command_log",
      "stored_event",
      "artifact",
      "repository",
      "documentation",
      "ui_bundle",
    ],
    description:
      "GitHub tokens are held inside GitService and excluded from Skeleton environments, Boxes, and logs (Requirements 42.10, 42.19).",
  },
  docker_pat: {
    kind: "docker_pat",
    allowedLocations: ["host_secret_store"],
    forbiddenLocations: [
      "dev_box",
      "box_environment",
      "box_file",
      "command_log",
      "stored_event",
      "artifact",
      "repository",
      "documentation",
      "ui_bundle",
      "skeleton_env",
    ],
    description:
      "Docker PAT is stored only in production host secret store and excluded from dev box and Boxes (Requirement 42.11).",
  },
  admin_secret: {
    kind: "admin_secret",
    allowedLocations: ["server_config", "necromancer_memory"],
    forbiddenLocations: [
      "ui_bundle",
      "command_log",
      "stored_event",
      "box_environment",
      "box_file",
      "artifact",
      "repository",
      "documentation",
      "skeleton_env",
    ],
    description:
      "Admin secret is configured server-side and excluded from UI bundles and logs (Requirement 42.12).",
  },
  dev_box_ssh_address: {
    kind: "dev_box_ssh_address",
    allowedLocations: ["host_ssh_config", "owner_local_machine"],
    forbiddenLocations: [
      "repository",
      "documentation",
      "stored_event",
      "command_log",
      "artifact",
      "ui_bundle",
      "box_environment",
      "box_file",
    ],
    description:
      "Dev box SSH address is kept out of repository, documentation, and stored events (Requirement 42.13).",
  },
};

// Pure policy helper functions

export function getSecretPlacementPolicy(
  kind: SecretKind,
  env?: ExecutionEnvironment
): SecretPlacementPolicy {
  const basePolicy = SECRET_PLACEMENT_POLICIES[kind];
  if (kind === "kiro_api_key" && env) {
    if (env === "development") {
      return {
        ...basePolicy,
        allowedLocations: [
          "necro_secret_file",
          "necromancer_memory",
          "kiro_cli_child_env",
        ],
      };
    } else {
      return {
        ...basePolicy,
        allowedLocations: [
          "host_secret_store",
          "necromancer_memory",
          "kiro_cli_child_env",
        ],
      };
    }
  }
  return basePolicy;
}

export function isLocationAllowed(
  kind: SecretKind,
  location: SecretLocationType,
  env?: ExecutionEnvironment
): boolean {
  const policy = getSecretPlacementPolicy(kind, env);
  if (policy.forbiddenLocations.includes(location)) {
    return false;
  }
  return policy.allowedLocations.includes(location);
}

// Pure validation for distinct environment keys (Requirement 42.9)

export function validateDistinctEnvironmentKeys(
  devKey?: string,
  prodKey?: string
): { valid: boolean; reason?: string } {
  const cleanDev = devKey?.trim();
  const cleanProd = prodKey?.trim();

  if (!cleanDev || !cleanProd) {
    return {
      valid: false,
      reason: "Both development and production Kiro API keys must be non-empty",
    };
  }

  if (cleanDev === cleanProd) {
    return {
      valid: false,
      reason:
        "Development and production environments must use separate distinct Kiro API keys (Requirement 42.9)",
    };
  }

  return { valid: true };
}

// Pure validation for Kiro API key storage (Requirement 42.7)

export function validateKiroKeyStorage(
  storage: KiroKeyStorageMetadata,
  env: ExecutionEnvironment
): { valid: boolean; violations: readonly string[] } {
  const violations: string[] = [];

  if (env === "development") {
    if (storage.storageType !== "file") {
      violations.push(
        "Development Kiro API key must be stored in a file (Requirement 42.7)"
      );
    }
    if (storage.fileOwner && storage.fileOwner.trim().toLowerCase() !== "necro") {
      violations.push(
        `Secret file must be owned by "necro" user, found "${storage.fileOwner}" (Requirement 42.7)`
      );
    }
    if (storage.fileMode !== undefined) {
      const mode =
        typeof storage.fileMode === "string"
          ? parseInt(storage.fileMode, 8)
          : storage.fileMode;
      if (isNaN(mode)) {
        violations.push(`Invalid file mode: "${storage.fileMode}"`);
      } else {
        const groupOtherBits = mode & 0o077;
        if (groupOtherBits !== 0) {
          violations.push(
            `Secret file must not grant group or other permissions (mode 0o${mode.toString(8)}), required 0o600 or 0o400`
          );
        }
      }
    }
  } else {
    if (storage.storageType !== "host_secret_store") {
      violations.push(
        "Production Kiro API key must be maintained in the host secret store (Requirement 42.7)"
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// Pure validation for Docker PAT storage (Requirement 42.11)

export function validateDockerPatStorage(
  env: ExecutionEnvironment,
  hasDockerPat: boolean
): { valid: boolean; violations: readonly string[] } {
  const violations: string[] = [];

  if (env === "development" && hasDockerPat) {
    violations.push(
      "Docker PAT must not be stored in the development box or environment (Requirement 42.11)"
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// Pure validation for Instabox API key storage (Requirements 42.17, 42.20)

export function validateInstaboxKeyStorage(
  location: SecretLocationType
): { valid: boolean; violations: readonly string[] } {
  const violations: string[] = [];

  if (location !== "owner_local_machine") {
    violations.push(
      `Instabox API key must be stored only on the Owner local machine, found at "${location}" (Requirements 42.17, 42.20)`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// Pure validation for GitService token holding (Requirement 42.10)

export function validateGitServiceTokenHold(
  holder: string
): { valid: boolean; violations: readonly string[] } {
  const violations: string[] = [];
  const normalized = holder.trim().toLowerCase();

  if (normalized !== "gitservice") {
    violations.push(
      `GitHub tokens must be held exclusively by GitService, found "${holder}" (Requirement 42.10)`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// Helper to extract non-empty secret values from inventory

function getSecretItems(
  inventory: SecretInventory
): readonly { readonly kind: SecretKind | "custom_secret"; readonly value: string }[] {
  const items: { kind: SecretKind | "custom_secret"; value: string }[] = [];

  if (inventory.kiroApiKeyDev && inventory.kiroApiKeyDev.trim().length >= 3) {
    items.push({ kind: "kiro_api_key", value: inventory.kiroApiKeyDev.trim() });
  }
  if (inventory.kiroApiKeyProd && inventory.kiroApiKeyProd.trim().length >= 3) {
    items.push({ kind: "kiro_api_key", value: inventory.kiroApiKeyProd.trim() });
  }
  if (inventory.instaboxApiKey && inventory.instaboxApiKey.trim().length >= 3) {
    items.push({ kind: "instabox_api_key", value: inventory.instaboxApiKey.trim() });
  }
  if (inventory.githubToken && inventory.githubToken.trim().length >= 3) {
    items.push({ kind: "github_token", value: inventory.githubToken.trim() });
  }
  if (inventory.dockerPat && inventory.dockerPat.trim().length >= 3) {
    items.push({ kind: "docker_pat", value: inventory.dockerPat.trim() });
  }
  if (inventory.adminSecret && inventory.adminSecret.trim().length >= 3) {
    items.push({ kind: "admin_secret", value: inventory.adminSecret.trim() });
  }
  if (inventory.devBoxSshAddress && inventory.devBoxSshAddress.trim().length >= 3) {
    items.push({ kind: "dev_box_ssh_address", value: inventory.devBoxSshAddress.trim() });
  }
  if (inventory.extraSecrets) {
    for (const extra of inventory.extraSecrets) {
      if (typeof extra === "string" && extra.trim().length >= 3) {
        items.push({ kind: "custom_secret", value: extra.trim() });
      }
    }
  }

  return items;
}

function checkTextForInventorySecrets(
  text: string,
  targetName: string,
  location: SecretLocationType,
  inventory: SecretInventory,
  violations: PlacementViolation[],
  filterKinds?: readonly SecretKind[]
): void {
  if (!text || typeof text !== "string") {
    return;
  }

  const items = getSecretItems(inventory);
  for (const item of items) {
    if (filterKinds && item.kind !== "custom_secret" && !filterKinds.includes(item.kind)) {
      continue;
    }

    if (text.includes(item.value)) {
      violations.push({
        secretKind: item.kind,
        location,
        target: targetName,
        match: item.value.slice(0, 4) + "...",
        rule: `Secret of kind "${item.kind}" detected at forbidden location "${location}" in ${targetName}`,
      });
    }
  }

  // Also check sensitive patterns (Requirement 42.3)
  const scan = scanTextForSecrets(text, {
    autoRegisterEnvSecrets: false,
  });
  if (scan.hasSecrets) {
    for (const v of scan.violations) {
      violations.push({
        secretKind: "custom_secret",
        location,
        target: targetName,
        match: v.match.slice(0, 4) + "...",
        rule: `Sensitive pattern "${v.patternName || v.type}" detected at location "${location}" in ${targetName}`,
      });
    }
  }
}

// Pure validation for Box environments (Requirements 42.8, 42.11, 42.19, 42.20)

export function validateBoxEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];

  for (const [key, val] of Object.entries(env)) {
    const combined = `${key}=${val ?? ""}`;
    checkTextForInventorySecrets(
      combined,
      `env:${key}`,
      "box_environment",
      inventory,
      violations
    );
  }

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Box environment contains ${violations.length} secret placement violation(s)`,
  };
}

// Pure validation for Box files (Requirements 42.8, 42.11, 42.19, 42.20)

export function validateBoxFiles(
  files:
    | ReadonlyArray<{ readonly path: string; readonly content: string }>
    | Readonly<Record<string, string>>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];
  const entries = Array.isArray(files)
    ? files
    : Object.entries(files).map(([path, content]) => ({ path, content }));

  for (const file of entries) {
    checkTextForInventorySecrets(
      file.content,
      file.path,
      "box_file",
      inventory,
      violations
    );
  }

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Box files contain ${violations.length} secret placement violation(s)`,
  };
}

// Pure validation for Skeleton environment (Requirement 42.19)

export function validateSkeletonEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];

  // GitHub tokens must not be in Skeleton environments (Requirement 42.19)
  // Docker PAT and Instabox API key must also be excluded
  const forbiddenKinds: readonly SecretKind[] = [
    "github_token",
    "docker_pat",
    "instabox_api_key",
  ];

  for (const [key, val] of Object.entries(env)) {
    const combined = `${key}=${val ?? ""}`;
    checkTextForInventorySecrets(
      combined,
      `skel-env:${key}`,
      "skeleton_env",
      inventory,
      violations,
      forbiddenKinds
    );
  }

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Skeleton environment contains ${violations.length} forbidden token violation(s)`,
  };
}

// Pure validation for stored events (Requirements 42.8, 42.12, 42.13)

export function validateStoredEventPayload(
  event: Readonly<Record<string, unknown>>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];
  const jsonStr = JSON.stringify(event);

  checkTextForInventorySecrets(
    jsonStr,
    `event:${String(event.type || event.kind || "event")}`,
    "stored_event",
    inventory,
    violations
  );

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Stored event contains ${violations.length} secret placement violation(s)`,
  };
}

export const validateStoredEvent = validateStoredEventPayload;

// Pure validation for command logs (Requirements 42.8, 42.12, 42.19)

export function validateCommandLog(
  log: string | Readonly<Record<string, unknown>>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];
  const text = typeof log === "string" ? log : JSON.stringify(log);

  checkTextForInventorySecrets(
    text,
    "command_log",
    "command_log",
    inventory,
    violations
  );

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Command log contains ${violations.length} secret placement violation(s)`,
  };
}

// Pure validation for artifacts (Requirements 42.8, 42.13)

export function validateArtifacts(
  artifacts:
    | Readonly<Record<string, string | Buffer>>
    | ReadonlyArray<{ readonly name: string; readonly content: string | Buffer }>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];
  const entries = Array.isArray(artifacts)
    ? artifacts.map((a) => ({ name: a.name, content: a.content }))
    : Object.entries(artifacts).map(([name, content]) => ({ name, content }));

  for (const entry of entries) {
    const text =
      typeof entry.content === "string"
        ? entry.content
        : entry.content.toString("utf-8");
    checkTextForInventorySecrets(
      text,
      `artifact:${entry.name}`,
      "artifact",
      inventory,
      violations
    );
  }

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Artifacts contain ${violations.length} secret placement violation(s)`,
  };
}

// Pure validation for repository content (Requirements 42.8, 42.13, 42.20)

export function validateRepositoryContent(
  files:
    | ReadonlyArray<{ readonly path: string; readonly content: string }>
    | Readonly<Record<string, string>>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];
  const entries = Array.isArray(files)
    ? files
    : Object.entries(files).map(([path, content]) => ({ path, content }));

  for (const file of entries) {
    checkTextForInventorySecrets(
      file.content,
      `repo:${file.path}`,
      "repository",
      inventory,
      violations
    );
  }

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Repository content contains ${violations.length} secret placement violation(s)`,
  };
}

// Pure validation for documentation (Requirement 42.13)

export function validateDocumentation(
  docs:
    | ReadonlyArray<{ readonly path: string; readonly content: string }>
    | Readonly<Record<string, string>>,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];
  const entries = Array.isArray(docs)
    ? docs
    : Object.entries(docs).map(([path, content]) => ({ path, content }));

  // Requirement 42.13 specifically mandates dev box SSH address out of documentation
  const docForbiddenKinds: readonly SecretKind[] = [
    "dev_box_ssh_address",
    "kiro_api_key",
    "instabox_api_key",
    "github_token",
    "docker_pat",
    "admin_secret",
  ];

  for (const doc of entries) {
    checkTextForInventorySecrets(
      doc.content,
      `doc:${doc.path}`,
      "documentation",
      inventory,
      violations,
      docForbiddenKinds
    );
  }

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `Documentation contains ${violations.length} forbidden secret/address violation(s)`,
  };
}

// Pure validation for UI client bundle (Requirement 42.12)

export function validateUiBundle(
  bundleContent: string,
  inventory: SecretInventory
): PlacementCheckResult {
  const violations: PlacementViolation[] = [];

  // Admin secret and all other secrets must be out of client bundles
  checkTextForInventorySecrets(
    bundleContent,
    "ui_bundle",
    "ui_bundle",
    inventory,
    violations
  );

  const valid = violations.length === 0;
  return {
    valid,
    passed: valid,
    violations,
    reason: valid
      ? undefined
      : `UI bundle contains ${violations.length} secret violation(s)`,
  };
}

// Pure validation for live run eligibility (Requirement 42.14, 42.9)

export function validateLiveRunEligibility(
  config: LiveRunEligibilityConfig
): LiveRunEligibilityResult {
  const violations: string[] = [];

  // Requirement 42.14: While Kiro content-use opt-out has not been set, refuse live run
  if (!config.contentUseOptOutSet) {
    violations.push(
      "Kiro content-use opt-out has not been set; live runs are refused (Requirement 42.14)"
    );
  }

  // Active key validation
  if (config.environment === "development") {
    if (!config.kiroApiKeyDev || !config.kiroApiKeyDev.trim()) {
      violations.push("Development Kiro API key is missing");
    }
  } else if (config.environment === "production") {
    if (!config.kiroApiKeyProd || !config.kiroApiKeyProd.trim()) {
      violations.push("Production Kiro API key is missing");
    }
  }

  // Separate keys validation if both are present
  if (config.kiroApiKeyDev && config.kiroApiKeyProd) {
    const distinctCheck = validateDistinctEnvironmentKeys(
      config.kiroApiKeyDev,
      config.kiroApiKeyProd
    );
    if (!distinctCheck.valid && distinctCheck.reason) {
      violations.push(distinctCheck.reason);
    }
  }

  const allowed = violations.length === 0;
  return {
    allowed,
    violations,
    reason: allowed ? undefined : violations.join("; "),
  };
}

// Admin review and redaction workflow for History or Replay publication (Requirement 42.15)

export function createPublicationRequest(
  runId: string,
  target: PublicationTarget,
  rawData?: Record<string, unknown>
): RunPublicationRecord {
  return {
    runId,
    target,
    status: "pending",
    redacted: false,
    rawData: rawData ? Object.freeze({ ...rawData }) : undefined,
  };
}

export function adminReviewRun(
  record: RunPublicationRecord,
  review: {
    readonly adminUser: string;
    readonly approved: boolean;
    readonly notes?: string;
  }
): RunPublicationRecord {
  const cleanAdmin = review.adminUser?.trim();
  if (!cleanAdmin) {
    throw new Error("Admin review requires a valid non-empty adminUser");
  }

  return {
    ...record,
    status: review.approved ? "reviewed" : "rejected",
    reviewedBy: cleanAdmin,
    reviewedAt: new Date().toISOString(),
    notes: review.notes,
  };
}

export function adminRedactRun(
  record: RunPublicationRecord,
  redactorFn?: (data: Record<string, unknown>) => Record<string, unknown>
): RunPublicationRecord {
  const dataToRedact = record.rawData ?? {};
  const redactedData = redactorFn
    ? redactorFn(dataToRedact)
    : redactObject(dataToRedact, { autoRegisterEnvSecrets: false });

  return {
    ...record,
    redacted: true,
    publishedData: Object.freeze(redactedData),
  };
}

export function validateRunForPublication(
  record: RunPublicationRecord,
  inventory?: SecretInventory
): PublicationValidationResult {
  const violations: string[] = [];

  if (record.status !== "reviewed" && record.status !== "approved") {
    violations.push(
      `Run publication requires admin review first, current status is "${record.status}" (Requirement 42.15)`
    );
  }

  if (!record.reviewedBy || !record.reviewedBy.trim()) {
    violations.push("Run publication requires an admin reviewer identity");
  }

  if (!record.redacted) {
    violations.push(
      "Run data must undergo redaction prior to publication (Requirement 42.15)"
    );
  }

  if (!record.publishedData) {
    violations.push("No publishedData payload prepared for publication");
  } else {
    // Scan published data to guarantee no secrets leak into public History or Replay
    if (inventory) {
      const invCheck = validateStoredEvent(record.publishedData, inventory);
      if (!invCheck.valid) {
        for (const v of invCheck.violations) {
          violations.push(v.rule);
        }
      }
    }

    const jsonStr = JSON.stringify(record.publishedData);
    const scan = scanTextForSecrets(jsonStr, { autoRegisterEnvSecrets: false });
    if (scan.hasSecrets) {
      for (const v of scan.violations) {
        violations.push(
          `Unmasked sensitive pattern "${v.patternName || v.type}" in publication data`
        );
      }
    }
  }

  const canPublish = violations.length === 0;
  return {
    canPublish,
    violations,
    reason: canPublish ? undefined : violations.join("; "),
  };
}

export function publishRun(
  record: RunPublicationRecord,
  inventory?: SecretInventory
): {
  readonly success: boolean;
  readonly record: RunPublicationRecord;
  readonly reason?: string;
} {
  const validation = validateRunForPublication(record, inventory);
  if (!validation.canPublish) {
    return {
      success: false,
      record,
      reason: validation.reason,
    };
  }

  return {
    success: true,
    record: {
      ...record,
      status: "approved",
    },
  };
}

// CredentialVault class wrapping pure functions and holding in-memory secrets

export class CredentialVault {
  readonly environment: ExecutionEnvironment;
  private readonly inventory: SecretInventory;

  constructor(config?: CredentialVaultConfig) {
    this.environment = config?.environment ?? "development";
    this.inventory = { ...(config?.secrets ?? {}) };
  }

  getEnvironment(): ExecutionEnvironment {
    return this.environment;
  }

  getSecretInventory(): SecretInventory {
    return { ...this.inventory };
  }

  getActiveKiroKey(): string | undefined {
    return this.environment === "development"
      ? this.inventory.kiroApiKeyDev
      : this.inventory.kiroApiKeyProd;
  }

  getKiroCliChildEnv(): Record<string, string> {
    const key = this.getActiveKiroKey();
    if (!key) {
      return {};
    }
    return { KIRO_API_KEY: key };
  }

  validateDistinctKeys(): { valid: boolean; reason?: string } {
    return validateDistinctEnvironmentKeys(
      this.inventory.kiroApiKeyDev,
      this.inventory.kiroApiKeyProd
    );
  }

  validateStorage(storage: KiroKeyStorageMetadata): {
    valid: boolean;
    violations: readonly string[];
  } {
    return validateKiroKeyStorage(storage, this.environment);
  }

  validateBoxEnv(
    env: Readonly<Record<string, string | undefined>>
  ): PlacementCheckResult {
    return validateBoxEnvironment(env, this.inventory);
  }

  validateBoxFiles(
    files:
      | ReadonlyArray<{ readonly path: string; readonly content: string }>
      | Readonly<Record<string, string>>
  ): PlacementCheckResult {
    return validateBoxFiles(files, this.inventory);
  }

  validateSkeletonEnv(
    env: Readonly<Record<string, string | undefined>>
  ): PlacementCheckResult {
    return validateSkeletonEnvironment(env, this.inventory);
  }

  validateStoredEvent(
    event: Readonly<Record<string, unknown>>
  ): PlacementCheckResult {
    return validateStoredEvent(event, this.inventory);
  }

  validateCommandLog(
    log: string | Readonly<Record<string, unknown>>
  ): PlacementCheckResult {
    return validateCommandLog(log, this.inventory);
  }

  validateArtifacts(
    artifacts:
      | Readonly<Record<string, string | Buffer>>
      | ReadonlyArray<{ readonly name: string; readonly content: string | Buffer }>
  ): PlacementCheckResult {
    return validateArtifacts(artifacts, this.inventory);
  }

  validateRepo(
    files:
      | ReadonlyArray<{ readonly path: string; readonly content: string }>
      | Readonly<Record<string, string>>
  ): PlacementCheckResult {
    return validateRepositoryContent(files, this.inventory);
  }

  validateDocs(
    docs:
      | ReadonlyArray<{ readonly path: string; readonly content: string }>
      | Readonly<Record<string, string>>
  ): PlacementCheckResult {
    return validateDocumentation(docs, this.inventory);
  }

  validateUiBundle(bundleContent: string): PlacementCheckResult {
    return validateUiBundle(bundleContent, this.inventory);
  }

  validateLiveRun(optOutSet: boolean): LiveRunEligibilityResult {
    return validateLiveRunEligibility({
      contentUseOptOutSet: optOutSet,
      environment: this.environment,
      kiroApiKeyDev: this.inventory.kiroApiKeyDev,
      kiroApiKeyProd: this.inventory.kiroApiKeyProd,
    });
  }

  createPublicationRequest(
    runId: string,
    target: PublicationTarget,
    rawData?: Record<string, unknown>
  ): RunPublicationRecord {
    return createPublicationRequest(runId, target, rawData);
  }

  adminReviewRun(
    record: RunPublicationRecord,
    review: {
      readonly adminUser: string;
      readonly approved: boolean;
      readonly notes?: string;
    }
  ): RunPublicationRecord {
    return adminReviewRun(record, review);
  }

  adminRedactRun(
    record: RunPublicationRecord,
    redactorFn?: (data: Record<string, unknown>) => Record<string, unknown>
  ): RunPublicationRecord {
    return adminRedactRun(record, redactorFn);
  }

  validateRunForPublication(
    record: RunPublicationRecord
  ): PublicationValidationResult {
    return validateRunForPublication(record, this.inventory);
  }

  publishRun(record: RunPublicationRecord): {
    readonly success: boolean;
    readonly record: RunPublicationRecord;
    readonly reason?: string;
  } {
    return publishRun(record, this.inventory);
  }
}

export function createCredentialVault(
  config?: CredentialVaultConfig
): CredentialVault {
  return new CredentialVault(config);
}
