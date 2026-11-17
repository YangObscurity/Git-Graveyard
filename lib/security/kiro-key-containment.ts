// Task 11.7: Property 11: Kiro key containment (P11)
// Requirements: 21.5, 42.6, 42.7, 42.8

import type { BackendKind, SandboxSpec } from "../backend/types";
import {
  checkSandboxSpec,
  DEFAULT_SECRET_ENV_NAMES,
  SECRET_VALUE_PATTERNS,
} from "../backend/spec-validator";
import {
  type CanaryTokenSet,
  getCanaryTokensList,
  findCanaryOccurrences,
  KSK_CANARY_PREFIX,
  GHP_CANARY_PREFIX,
  AKIA_CANARY_PREFIX,
  GITHUB_PAT_CANARY_PREFIX,
  DCKR_PAT_CANARY_PREFIX,
  PEM_CANARY_HEADER,
} from "./canary";
import {
  type SecretInventory,
  type ExecutionEnvironment,
  type KiroKeyStorageMetadata,
  validateKiroKeyStorage,
  validateBoxEnvironment,
  validateBoxFiles,
  validateStoredEventPayload,
  validateCommandLog,
  validateArtifacts,
} from "./credential-vault";
import {
  scanTextForSecrets,
  DEFAULT_REDACTION_MASK,
  redactText,
} from "./redactor";

export type ContainmentScope =
  | "box_env"
  | "box_files"
  | "stored_events"
  | "command_logs"
  | "artifacts"
  | "key_storage"
  | "child_env";

export type ContainmentRequirement = "21.5" | "42.6" | "42.7" | "42.8";

export type SecretClassification =
  | "kiro_api_key"
  | "canary_key"
  | "sensitive_pattern"
  | "custom_secret";

export interface BoxFileEntry {
  readonly path: string;
  readonly content: string | Buffer;
}

export interface BoxArtifactEntry {
  readonly name: string;
  readonly content: string | Buffer;
}

export interface BoxContainmentTarget {
  readonly id?: string;
  readonly backend?: BackendKind | string;
  readonly env?: Readonly<Record<string, string | undefined>> | null;
  readonly files?:
    | ReadonlyArray<BoxFileEntry>
    | Readonly<Record<string, string | Buffer>>
    | null;
  readonly commandLogs?:
    | ReadonlyArray<string | Record<string, unknown>>
    | string
    | null;
  readonly events?: ReadonlyArray<Record<string, unknown>> | null;
  readonly artifacts?:
    | ReadonlyArray<BoxArtifactEntry>
    | Readonly<Record<string, string | Buffer>>
    | null;
}

export interface KeyContainmentViolation {
  readonly scope: ContainmentScope;
  readonly target: string;
  readonly secretKind: SecretClassification;
  readonly snippet: string;
  readonly backend?: string;
  readonly requirement: ContainmentRequirement;
  readonly rule: string;
}

export interface KiroKeyContainmentOptions {
  readonly kiroApiKey?: string;
  readonly devKey?: string;
  readonly prodKey?: string;
  readonly canaryTokens?: string | readonly string[] | CanaryTokenSet;
  readonly extraSecrets?: readonly string[];
  readonly checkSensitivePatterns?: boolean;
  readonly backends?: readonly (BackendKind | string)[];
}

export interface ContainmentCheckResult {
  readonly passed: boolean;
  readonly contained: boolean;
  readonly violations: readonly KeyContainmentViolation[];
  readonly checkedScopes: readonly ContainmentScope[];
  readonly reason?: string;
}

export interface Property11Report {
  readonly passed: boolean;
  readonly property: "P11";
  readonly name: "Kiro key containment";
  readonly requirements: readonly ["21.5", "42.6", "42.7", "42.8"];
  readonly totalBoxesChecked: number;
  readonly backendsChecked: readonly string[];
  readonly violations: readonly KeyContainmentViolation[];
  readonly summary: string;
}

export class KeyContainmentError extends Error {
  readonly violations: readonly KeyContainmentViolation[];

  constructor(
    message: string,
    violations: readonly KeyContainmentViolation[] = []
  ) {
    super(message);
    this.name = "KeyContainmentError";
    this.violations = violations;
    Object.setPrototypeOf(this, KeyContainmentError.prototype);
  }
}

/**
 * Standard canary prefix set covering LG-02 canary tests.
 * Requirements: 42.6, 42.3.
 */
export const STANDARD_CANARY_PREFIXES: readonly string[] = [
  KSK_CANARY_PREFIX,
  GHP_CANARY_PREFIX,
  AKIA_CANARY_PREFIX,
  GITHUB_PAT_CANARY_PREFIX,
  DCKR_PAT_CANARY_PREFIX,
  PEM_CANARY_HEADER,
];

/**
 * Extracts and deduplicates all non-empty secret keys and tokens from containment options.
 * Requirements: 21.5, 42.6, 42.7, 42.8.
 */
export function extractSecretTokens(
  options?: KiroKeyContainmentOptions
): {
  readonly kiroKeys: readonly string[];
  readonly canaryKeys: readonly string[];
  readonly allSecrets: readonly string[];
} {
  if (!options) {
    return { kiroKeys: [], canaryKeys: [], allSecrets: [] };
  }

  const kiroKeys: string[] = [];
  if (options.kiroApiKey && options.kiroApiKey.trim().length >= 3) {
    kiroKeys.push(options.kiroApiKey.trim());
  }
  if (options.devKey && options.devKey.trim().length >= 3) {
    kiroKeys.push(options.devKey.trim());
  }
  if (options.prodKey && options.prodKey.trim().length >= 3) {
    kiroKeys.push(options.prodKey.trim());
  }

  const canaryKeys: string[] = [];
  if (options.canaryTokens) {
    const extracted = getCanaryTokensList(options.canaryTokens);
    for (const tok of extracted) {
      if (typeof tok === "string" && tok.trim().length >= 3) {
        canaryKeys.push(tok.trim());
      }
    }
  }

  const extraKeys: string[] = [];
  if (options.extraSecrets) {
    for (const extra of options.extraSecrets) {
      if (typeof extra === "string" && extra.trim().length >= 3) {
        extraKeys.push(extra.trim());
      }
    }
  }

  const distinctKiro = Array.from(new Set(kiroKeys));
  const distinctCanary = Array.from(new Set(canaryKeys));
  const distinctAll = Array.from(
    new Set([...distinctKiro, ...distinctCanary, ...extraKeys])
  );

  return {
    kiroKeys: distinctKiro,
    canaryKeys: distinctCanary,
    allSecrets: distinctAll,
  };
}

/**
 * Pure helper to create an obfuscated snippet of a detected secret match for safe reporting.
 */
function createSnippet(text: string, match: string): string {
  const idx = text.indexOf(match);
  if (idx === -1) {
    return match.length > 8 ? `${match.slice(0, 4)}...${match.slice(-4)}` : "[MATCH]";
  }
  const start = Math.max(0, idx - 15);
  const end = Math.min(text.length, idx + match.length + 15);
  const raw = text.slice(start, end).replace(/\s+/g, " ");
  return raw.replace(match, `${match.slice(0, 3)}...[MASKED]`);
}

/**
 * Scans a text string for Kiro API keys, canary keys, and sensitive patterns.
 * Requirements: 21.5, 42.6, 42.7, 42.8.
 */
export function scanTextForKeyLeaks(
  text: string,
  options: KiroKeyContainmentOptions | undefined,
  context: {
    readonly scope: ContainmentScope;
    readonly target: string;
    readonly backend?: string;
    readonly requirement: ContainmentRequirement;
  }
): KeyContainmentViolation[] {
  if (!text || typeof text !== "string") {
    return [];
  }

  const violations: KeyContainmentViolation[] = [];
  const { kiroKeys, canaryKeys, allSecrets } = extractSecretTokens(options);

  // 1. Check exact Kiro API keys
  for (const key of kiroKeys) {
    if (text.includes(key)) {
      violations.push({
        scope: context.scope,
        target: context.target,
        secretKind: "kiro_api_key",
        snippet: createSnippet(text, key),
        backend: context.backend,
        requirement: context.requirement,
        rule: `Kiro API key value leaked at scope '${context.scope}' in '${context.target}' (Requirement ${context.requirement})`,
      });
    }
  }

  // 2. Check canary keys (Requirements 42.6, 42.8)
  for (const canary of canaryKeys) {
    if (text.includes(canary)) {
      violations.push({
        scope: context.scope,
        target: context.target,
        secretKind: "canary_key",
        snippet: createSnippet(text, canary),
        backend: context.backend,
        requirement: context.requirement,
        rule: `Canary token leaked at scope '${context.scope}' in '${context.target}' (Requirement ${context.requirement})`,
      });
    }
  }

  // 3. Check extra secrets if configured
  const remainingSecrets = allSecrets.filter(
    (s) => !kiroKeys.includes(s) && !canaryKeys.includes(s)
  );
  for (const extra of remainingSecrets) {
    if (text.includes(extra)) {
      violations.push({
        scope: context.scope,
        target: context.target,
        secretKind: "custom_secret",
        snippet: createSnippet(text, extra),
        backend: context.backend,
        requirement: context.requirement,
        rule: `Secret token leaked at scope '${context.scope}' in '${context.target}' (Requirement ${context.requirement})`,
      });
    }
  }

  // 4. Sensitive patterns check (Requirement 42.3, 42.6)
  if (options?.checkSensitivePatterns !== false) {
    const scan = scanTextForSecrets(text, { autoRegisterEnvSecrets: false });
    if (scan.hasSecrets) {
      for (const v of scan.violations) {
        // Avoid duplicate reporting if already flagged by exact match
        const alreadyFlagged = violations.some(
          (ex) => ex.snippet.includes(v.match.slice(0, 3))
        );
        if (!alreadyFlagged) {
          violations.push({
            scope: context.scope,
            target: context.target,
            secretKind: "sensitive_pattern",
            snippet: createSnippet(text, v.match),
            backend: context.backend,
            requirement: context.requirement,
            rule: `Sensitive secret pattern '${v.patternName || v.type}' detected at scope '${context.scope}' in '${context.target}' (Requirement ${context.requirement})`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Pure verification for Box environment variables.
 * Ensures Kiro API key, canary keys, and secret environment names/patterns
 * do not occur in Box environment.
 * Validates: Requirements 21.5, 42.8.
 */
export function verifyBoxEnvironmentContainment(
  env: Readonly<Record<string, string | undefined>> | null | undefined,
  options?: KiroKeyContainmentOptions,
  context?: { readonly target?: string; readonly backend?: string }
): ContainmentCheckResult {
  const violations: KeyContainmentViolation[] = [];
  const targetName = context?.target ?? "box_env";
  const backend = context?.backend;

  if (!env || typeof env !== "object") {
    return {
      passed: true,
      contained: true,
      violations: [],
      checkedScopes: ["box_env"],
    };
  }

  // Inspect each environment variable key and value
  for (const [key, val] of Object.entries(env)) {
    const entryTarget = `${targetName}:${key}`;
    const keyValText = `${key}=${val ?? ""}`;

    // Key leaks in key/value string
    const keyLeaks = scanTextForKeyLeaks(keyValText, options, {
      scope: "box_env",
      target: entryTarget,
      backend,
      requirement: "21.5",
    });
    for (const v of keyLeaks) {
      violations.push(v);
    }

    // Check against standard secret environment variable names
    const upperKey = key.trim().toUpperCase();
    if (DEFAULT_SECRET_ENV_NAMES.includes(upperKey as (typeof DEFAULT_SECRET_ENV_NAMES)[number])) {
      violations.push({
        scope: "box_env",
        target: entryTarget,
        secretKind: "kiro_api_key",
        snippet: `${key}=[DENIED_ENV_NAME]`,
        backend,
        requirement: "21.5",
        rule: `Secret environment variable '${key}' is forbidden in Box environment (Requirements 21.5, 42.8)`,
      });
    }
  }

  // Cross-check with credential-vault validateBoxEnvironment
  const inventory: SecretInventory = {
    kiroApiKeyDev: options?.devKey ?? options?.kiroApiKey,
    kiroApiKeyProd: options?.prodKey,
    extraSecrets: options?.extraSecrets,
  };
  const vaultCheck = validateBoxEnvironment(env, inventory);
  if (!vaultCheck.valid) {
    for (const v of vaultCheck.violations) {
      const alreadyListed = violations.some(
        (ex) => ex.target === `${targetName}:${v.target}` || ex.target === v.target
      );
      if (!alreadyListed) {
        violations.push({
          scope: "box_env",
          target: `${targetName}:${v.target}`,
          secretKind: v.secretKind === "kiro_api_key" ? "kiro_api_key" : "custom_secret",
          snippet: v.match ?? "[SECRET]",
          backend,
          requirement: "42.8",
          rule: v.rule,
        });
      }
    }
  }

  const passed = violations.length === 0;
  return {
    passed,
    contained: passed,
    violations,
    checkedScopes: ["box_env"],
    reason: passed
      ? undefined
      : `Box environment contains ${violations.length} secret containment violation(s)`,
  };
}

/**
 * Pure verification for Box files (initial files, mounted files, copied files).
 * Ensures Kiro API key and canary keys do not occur in any Box file.
 * Validates: Requirements 21.5, 42.8.
 */
export function verifyBoxFilesContainment(
  files:
    | ReadonlyArray<BoxFileEntry>
    | Readonly<Record<string, string | Buffer>>
    | null
    | undefined,
  options?: KiroKeyContainmentOptions,
  context?: { readonly target?: string; readonly backend?: string }
): ContainmentCheckResult {
  const violations: KeyContainmentViolation[] = [];
  const backend = context?.backend;

  if (!files) {
    return {
      passed: true,
      contained: true,
      violations: [],
      checkedScopes: ["box_files"],
    };
  }

  const entries: BoxFileEntry[] = Array.isArray(files)
    ? (files as BoxFileEntry[])
    : Object.entries(files).map(([p, content]) => ({ path: p, content }));

  for (const entry of entries) {
    const textContent =
      typeof entry.content === "string"
        ? entry.content
        : Buffer.isBuffer(entry.content)
        ? entry.content.toString("utf-8")
        : String(entry.content);

    const fileTarget = `file:${entry.path}`;
    const fileLeaks = scanTextForKeyLeaks(textContent, options, {
      scope: "box_files",
      target: fileTarget,
      backend,
      requirement: "21.5",
    });
    for (const v of fileLeaks) {
      violations.push(v);
    }
  }

  // Cross-check with credential-vault validateBoxFiles
  const inventory: SecretInventory = {
    kiroApiKeyDev: options?.devKey ?? options?.kiroApiKey,
    kiroApiKeyProd: options?.prodKey,
    extraSecrets: options?.extraSecrets,
  };
  const stringFiles = entries.map((e) => ({
    path: e.path,
    content: typeof e.content === "string" ? e.content : e.content.toString("utf-8"),
  }));
  const vaultCheck = validateBoxFiles(stringFiles, inventory);
  if (!vaultCheck.valid) {
    for (const v of vaultCheck.violations) {
      const alreadyListed = violations.some((ex) => ex.target === `file:${v.target}`);
      if (!alreadyListed) {
        violations.push({
          scope: "box_files",
          target: `file:${v.target}`,
          secretKind: v.secretKind === "kiro_api_key" ? "kiro_api_key" : "custom_secret",
          snippet: v.match ?? "[SECRET]",
          backend,
          requirement: "42.8",
          rule: v.rule,
        });
      }
    }
  }

  const passed = violations.length === 0;
  return {
    passed,
    contained: passed,
    violations,
    checkedScopes: ["box_files"],
    reason: passed
      ? undefined
      : `Box files contain ${violations.length} secret containment violation(s)`,
  };
}

/**
 * Pure verification for stored events in EventStore or emitted by runs.
 * Ensures Kiro API key and canary keys do not occur in stored event payloads.
 * Validates: Requirements 42.8, 42.6.
 */
export function verifyStoredEventsContainment(
  events: readonly Record<string, unknown>[] | null | undefined,
  options?: KiroKeyContainmentOptions,
  context?: { readonly target?: string; readonly backend?: string }
): ContainmentCheckResult {
  const violations: KeyContainmentViolation[] = [];
  const backend = context?.backend;

  if (!events || !Array.isArray(events)) {
    return {
      passed: true,
      contained: true,
      violations: [],
      checkedScopes: ["stored_events"],
    };
  }

  const inventory: SecretInventory = {
    kiroApiKeyDev: options?.devKey ?? options?.kiroApiKey,
    kiroApiKeyProd: options?.prodKey,
    extraSecrets: options?.extraSecrets,
  };

  for (let idx = 0; idx < events.length; idx++) {
    const evt = events[idx];
    const eventTarget = `event[${idx}]:${String(evt.type || evt.kind || "event")}`;
    const jsonStr = JSON.stringify(evt);

    const eventLeaks = scanTextForKeyLeaks(jsonStr, options, {
      scope: "stored_events",
      target: eventTarget,
      backend,
      requirement: "42.8",
    });
    for (const v of eventLeaks) {
      violations.push(v);
    }

    const vaultCheck = validateStoredEventPayload(evt, inventory);
    if (!vaultCheck.valid) {
      for (const v of vaultCheck.violations) {
        const alreadyListed = violations.some((ex) => ex.target === eventTarget);
        if (!alreadyListed) {
          violations.push({
            scope: "stored_events",
            target: eventTarget,
            secretKind: v.secretKind === "kiro_api_key" ? "kiro_api_key" : "custom_secret",
            snippet: v.match ?? "[SECRET]",
            backend,
            requirement: "42.8",
            rule: v.rule,
          });
        }
      }
    }
  }

  const passed = violations.length === 0;
  return {
    passed,
    contained: passed,
    violations,
    checkedScopes: ["stored_events"],
    reason: passed
      ? undefined
      : `Stored events contain ${violations.length} secret containment violation(s)`,
  };
}

/**
 * Pure verification for command execution logs (stdout, stderr, merged streams).
 * Ensures Kiro API key and canary keys do not occur in command logs.
 * Validates: Requirement 42.8.
 */
export function verifyCommandLogsContainment(
  logs:
    | ReadonlyArray<string | Record<string, unknown>>
    | string
    | null
    | undefined,
  options?: KiroKeyContainmentOptions,
  context?: { readonly target?: string; readonly backend?: string }
): ContainmentCheckResult {
  const violations: KeyContainmentViolation[] = [];
  const backend = context?.backend;

  if (!logs) {
    return {
      passed: true,
      contained: true,
      violations: [],
      checkedScopes: ["command_logs"],
    };
  }

  const logList = Array.isArray(logs) ? logs : [logs];
  const inventory: SecretInventory = {
    kiroApiKeyDev: options?.devKey ?? options?.kiroApiKey,
    kiroApiKeyProd: options?.prodKey,
    extraSecrets: options?.extraSecrets,
  };

  for (let idx = 0; idx < logList.length; idx++) {
    const item = logList[idx];
    const logText = typeof item === "string" ? item : JSON.stringify(item);
    const logTarget = `log[${idx}]`;

    const logLeaks = scanTextForKeyLeaks(logText, options, {
      scope: "command_logs",
      target: logTarget,
      backend,
      requirement: "42.8",
    });
    for (const v of logLeaks) {
      violations.push(v);
    }

    const vaultCheck = validateCommandLog(item, inventory);
    if (!vaultCheck.valid) {
      for (const v of vaultCheck.violations) {
        const alreadyListed = violations.some((ex) => ex.target === logTarget);
        if (!alreadyListed) {
          violations.push({
            scope: "command_logs",
            target: logTarget,
            secretKind: v.secretKind === "kiro_api_key" ? "kiro_api_key" : "custom_secret",
            snippet: v.match ?? "[SECRET]",
            backend,
            requirement: "42.8",
            rule: v.rule,
          });
        }
      }
    }
  }

  const passed = violations.length === 0;
  return {
    passed,
    contained: passed,
    violations,
    checkedScopes: ["command_logs"],
    reason: passed
      ? undefined
      : `Command logs contain ${violations.length} secret containment violation(s)`,
  };
}

/**
 * Pure verification for generated run artifacts.
 * Ensures Kiro API key and canary keys do not occur in any artifact content.
 * Validates: Requirements 42.8, 42.6.
 */
export function verifyArtifactsContainment(
  artifacts:
    | ReadonlyArray<BoxArtifactEntry>
    | Readonly<Record<string, string | Buffer>>
    | null
    | undefined,
  options?: KiroKeyContainmentOptions,
  context?: { readonly target?: string; readonly backend?: string }
): ContainmentCheckResult {
  const violations: KeyContainmentViolation[] = [];
  const backend = context?.backend;

  if (!artifacts) {
    return {
      passed: true,
      contained: true,
      violations: [],
      checkedScopes: ["artifacts"],
    };
  }

  const entries: BoxArtifactEntry[] = Array.isArray(artifacts)
    ? (artifacts as BoxArtifactEntry[])
    : Object.entries(artifacts).map(([n, content]) => ({ name: n, content }));

  const inventory: SecretInventory = {
    kiroApiKeyDev: options?.devKey ?? options?.kiroApiKey,
    kiroApiKeyProd: options?.prodKey,
    extraSecrets: options?.extraSecrets,
  };

  for (const entry of entries) {
    const textContent =
      typeof entry.content === "string"
        ? entry.content
        : Buffer.isBuffer(entry.content)
        ? entry.content.toString("utf-8")
        : String(entry.content);

    const artifactTarget = `artifact:${entry.name}`;
    const artifactLeaks = scanTextForKeyLeaks(textContent, options, {
      scope: "artifacts",
      target: artifactTarget,
      backend,
      requirement: "42.8",
    });
    for (const v of artifactLeaks) {
      violations.push(v);
    }
  }

  const vaultCheck = validateArtifacts(entries, inventory);
  if (!vaultCheck.valid) {
    for (const v of vaultCheck.violations) {
      const alreadyListed = violations.some(
        (ex) => ex.target === `artifact:${v.target}`
      );
      if (!alreadyListed) {
        violations.push({
          scope: "artifacts",
          target: `artifact:${v.target}`,
          secretKind: v.secretKind === "kiro_api_key" ? "kiro_api_key" : "custom_secret",
          snippet: v.match ?? "[SECRET]",
          backend,
          requirement: "42.8",
          rule: v.rule,
        });
      }
    }
  }

  const passed = violations.length === 0;
  return {
    passed,
    contained: passed,
    violations,
    checkedScopes: ["artifacts"],
    reason: passed
      ? undefined
      : `Artifacts contain ${violations.length} secret containment violation(s)`,
  };
}

/**
 * Pure verification for Kiro API key storage location on the host.
 * Keeps key only in one necro-readable file in development or host secret store in production,
 * in memory, and in kiro-cli child process environment.
 * Validates: Requirement 42.7.
 */
export function verifyHostKeyPlacement(
  storage: KiroKeyStorageMetadata,
  env: ExecutionEnvironment,
  options?: { readonly keyInChildEnv?: boolean }
): ContainmentCheckResult {
  const violations: KeyContainmentViolation[] = [];
  const vaultCheck = validateKiroKeyStorage(storage, env);

  if (!vaultCheck.valid) {
    for (const msg of vaultCheck.violations) {
      violations.push({
        scope: "key_storage",
        target: storage.filePath ?? "host_secret_store",
        secretKind: "kiro_api_key",
        snippet: storage.storageType,
        requirement: "42.7",
        rule: msg,
      });
    }
  }

  if (options?.keyInChildEnv === false) {
    violations.push({
      scope: "child_env",
      target: "kiro_cli_child_env",
      secretKind: "kiro_api_key",
      snippet: "missing_in_child_env",
      requirement: "42.7",
      rule: "Kiro API key must be supplied to kiro-cli child process environment (Requirement 42.7)",
    });
  }

  const passed = violations.length === 0;
  return {
    passed,
    contained: passed,
    violations,
    checkedScopes: ["key_storage", "child_env"],
    reason: passed
      ? undefined
      : `Host key placement contains ${violations.length} violation(s)`,
  };
}

/**
 * Comprehensive verification for a single Box across all its containment facets:
 * env, files, stored events, command logs, and artifacts.
 * Validates: Requirements 21.5, 42.6, 42.7, 42.8.
 */
export function verifyBoxContainment(
  box: BoxContainmentTarget,
  options?: KiroKeyContainmentOptions
): ContainmentCheckResult {
  const violations: KeyContainmentViolation[] = [];
  const checkedScopes: ContainmentScope[] = [];
  const backend = box.backend;
  const boxId = box.id ?? "box";

  // 1. Env containment
  const envCheck = verifyBoxEnvironmentContainment(box.env, options, {
    target: `${boxId}:env`,
    backend,
  });
  for (const v of envCheck.violations) {
    violations.push(v);
  }
  checkedScopes.push("box_env");

  // 2. Files containment
  const filesCheck = verifyBoxFilesContainment(box.files, options, {
    target: `${boxId}:files`,
    backend,
  });
  for (const v of filesCheck.violations) {
    violations.push(v);
  }
  checkedScopes.push("box_files");

  // 3. Command logs containment
  const logsCheck = verifyCommandLogsContainment(box.commandLogs, options, {
    target: `${boxId}:logs`,
    backend,
  });
  for (const v of logsCheck.violations) {
    violations.push(v);
  }
  checkedScopes.push("command_logs");

  // 4. Stored events containment
  const eventsCheck = verifyStoredEventsContainment(box.events, options, {
    target: `${boxId}:events`,
    backend,
  });
  for (const v of eventsCheck.violations) {
    violations.push(v);
  }
  checkedScopes.push("stored_events");

  // 5. Artifacts containment
  const artifactsCheck = verifyArtifactsContainment(box.artifacts, options, {
    target: `${boxId}:artifacts`,
    backend,
  });
  for (const v of artifactsCheck.violations) {
    violations.push(v);
  }
  checkedScopes.push("artifacts");

  const passed = violations.length === 0;
  return {
    passed,
    contained: passed,
    violations,
    checkedScopes,
    reason: passed
      ? undefined
      : `Box '${boxId}' (${backend ?? "unknown backend"}) failed Kiro key containment with ${violations.length} violation(s)`,
  };
}

/**
 * Pure verification for multiple Boxes created across either or both backends.
 * Validates: Requirements 21.5, 42.6, 42.7, 42.8.
 */
export function verifyBoxesContainment(
  boxes: readonly BoxContainmentTarget[],
  options?: KiroKeyContainmentOptions
): ContainmentCheckResult {
  const allViolations: KeyContainmentViolation[] = [];
  const checkedScopes: Set<ContainmentScope> = new Set();

  for (const box of boxes) {
    const res = verifyBoxContainment(box, options);
    for (const scope of res.checkedScopes) {
      checkedScopes.add(scope);
    }
    for (const v of res.violations) {
      allViolations.push(v);
    }
  }

  const passed = allViolations.length === 0;
  return {
    passed,
    contained: passed,
    violations: allViolations,
    checkedScopes: Array.from(checkedScopes),
    reason: passed
      ? undefined
      : `Containment check failed across ${boxes.length} box(es) with ${allViolations.length} total violation(s)`,
  };
}

/**
 * Top-level unified containment verification function for Property 11.
 * Accepts either a single box or an array of boxes from either backend.
 * Validates: Requirements 21.5, 42.6, 42.7, 42.8.
 */
export function verifyKiroKeyContainment(
  target: BoxContainmentTarget | readonly BoxContainmentTarget[],
  options?: KiroKeyContainmentOptions
): ContainmentCheckResult {
  if (Array.isArray(target)) {
    return verifyBoxesContainment(target, options);
  }
  return verifyBoxContainment(target as BoxContainmentTarget, options);
}

/**
 * Pure simulator modeling box creation across both ExecutionBackend implementations:
 * "instabox-docker" and "docker-cloud-sandbox".
 * Simulates sandbox spec validation, secret stripping, and downstream outputs.
 * Requirements: 21.5, 42.8, 43.1, 43.3, 43.4.
 */
export function simulateBoxCreation(
  backend: BackendKind | string,
  spec: SandboxSpec,
  options: {
    readonly kiroApiKey: string;
    readonly canaryTokens?: CanaryTokenSet;
    readonly commandStdout?: string;
    readonly commandStderr?: string;
    readonly emittedEvents?: readonly Record<string, unknown>[];
    readonly collectedArtifacts?: readonly BoxArtifactEntry[];
    readonly files?: readonly BoxFileEntry[];
  }
): BoxContainmentTarget {
  // Spec check as executed by backend
  const specCheck = checkSandboxSpec(spec);

  // If spec contained forbidden secrets, backend would reject or strip them.
  // In a compliant backend, env is sanitized:
  const sanitizedEnv: Record<string, string> = {};
  if (spec.env && typeof spec.env === "object") {
    for (const [k, v] of Object.entries(spec.env)) {
      if (typeof v === "string") {
        // Redact any occurrences of kiroApiKey or canary tokens
        const cleanVal = redactText(v, {
          secrets: [
            options.kiroApiKey,
            ...(options.canaryTokens ? options.canaryTokens.allTokens : []),
          ],
        });
        sanitizedEnv[k] = cleanVal;
      }
    }
  }

  // Sanitize files
  const sanitizedFiles: BoxFileEntry[] = (options.files ?? []).map((file) => ({
    path: file.path,
    content: redactText(
      typeof file.content === "string"
        ? file.content
        : file.content.toString("utf-8"),
      {
        secrets: [
          options.kiroApiKey,
          ...(options.canaryTokens ? options.canaryTokens.allTokens : []),
        ],
      }
    ),
  }));

  // Sanitize command logs
  const rawLogs = [
    options.commandStdout ?? "",
    options.commandStderr ?? "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const sanitizedLogs = redactText(rawLogs, {
    secrets: [
      options.kiroApiKey,
      ...(options.canaryTokens ? options.canaryTokens.allTokens : []),
    ],
  });

  // Sanitize events
  const sanitizedEvents = (options.emittedEvents ?? []).map((evt) => {
    const json = JSON.stringify(evt);
    const cleanJson = redactText(json, {
      secrets: [
        options.kiroApiKey,
        ...(options.canaryTokens ? options.canaryTokens.allTokens : []),
      ],
    });
    return JSON.parse(cleanJson) as Record<string, unknown>;
  });

  // Sanitize artifacts
  const sanitizedArtifacts: BoxArtifactEntry[] = (
    options.collectedArtifacts ?? []
  ).map((art) => ({
    name: art.name,
    content: redactText(
      typeof art.content === "string"
        ? art.content
        : art.content.toString("utf-8"),
      {
        secrets: [
          options.kiroApiKey,
          ...(options.canaryTokens ? options.canaryTokens.allTokens : []),
        ],
      }
    ),
  }));

  return {
    id: spec.idempotencyKey ?? `box-${backend}`,
    backend,
    env: sanitizedEnv,
    files: sanitizedFiles,
    commandLogs: sanitizedLogs,
    events: sanitizedEvents,
    artifacts: sanitizedArtifacts,
  };
}

/**
 * Creates a formal Property 11 test report across evaluated boxes and backends.
 * Requirements: 21.5, 42.6, 42.7, 42.8.
 */
export function createProperty11Report(
  boxes: readonly BoxContainmentTarget[],
  options?: KiroKeyContainmentOptions
): Property11Report {
  const result = verifyBoxesContainment(boxes, options);
  const backendsSet = new Set<string>();
  for (const b of boxes) {
    if (b.backend) {
      backendsSet.add(b.backend);
    }
  }

  const passed = result.passed;
  const summary = passed
    ? `Property 11 verified: Kiro key containment maintained across ${boxes.length} box(es) and ${backendsSet.size} backend(s). Zero key or canary leaks.`
    : `Property 11 violated: ${result.violations.length} secret containment leak(s) detected across ${boxes.length} box(es).`;

  return {
    passed,
    property: "P11",
    name: "Kiro key containment",
    requirements: ["21.5", "42.6", "42.7", "42.8"],
    totalBoxesChecked: boxes.length,
    backendsChecked: Array.from(backendsSet),
    violations: result.violations,
    summary,
  };
}

/**
 * Throws a KeyContainmentError if any containment violation is detected.
 * Pure assertion helper for test suites.
 */
export function assertKiroKeyContainment(
  target: BoxContainmentTarget | readonly BoxContainmentTarget[],
  options?: KiroKeyContainmentOptions
): void {
  const result = verifyKiroKeyContainment(target, options);
  if (!result.passed) {
    const details = result.violations.map((v) => ` - [${v.scope}] ${v.rule}`).join("\n");
    throw new KeyContainmentError(
      `Property 11 containment check failed:\n${details}`,
      result.violations
    );
  }
}
