// Validated always-on production host configuration loader.
// Confirms the production host runs kiro-cli, that Necromancer runs outside
// every cloud sandbox (Topology P-B), and that required production config
// (TTL, concurrency cap, egress allowlist, kiro-cli binary) is present.
// Strictly rejects missing required production config.

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  DEFAULT_SANDBOX_TTL_MS,
  MAX_CONCURRENT_RUNS,
  MAX_SANDBOX_TTL_MS,
} from "./cloud-lifecycle";
import { CONFIRMED_ALLOWED_HOSTS } from "../backend/connect-proxy";

/** Error thrown when required production host configuration is missing/invalid. */
export class HostConfigError extends Error {
  readonly ok = false as const;
  readonly code = "HOST_CONFIG_ERROR" as const;
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Invalid production host configuration: ${reason}`);
    this.name = "HostConfigError";
    this.reason = reason;
    Object.setPrototypeOf(this, HostConfigError.prototype);
  }
}

export interface ProductionHostConfig {
  /** Sandbox default TTL in ms (1h). */
  readonly ttlMs: number;
  /** Renewable hard cap in ms (24h). */
  readonly maxTtlMs: number;
  /** Max concurrent runs (5). */
  readonly maxConcurrentRuns: number;
  /** Allowlisted egress hostnames (default-deny with explicit allowlist). */
  readonly allowedEgressHosts: readonly string[];
  /** Absolute path to the verified host kiro-cli binary. */
  readonly kiroCliBinary: string;
  /** Topology must be P-B. */
  readonly topology: "P-B";
}

export interface DaemonSupervisionDescriptor {
  /** Necromancer daemon name. */
  readonly daemon: "necromancer";
  /** Necromancer runs on the production host, outside every cloud sandbox. */
  readonly runsOutsideCloudSandboxes: true;
  /** kiro-cli runs on the production host. */
  readonly kiroCliRunsOnHost: true;
  /** Topology P-B. */
  readonly topology: "P-B";
}

/**
 * Descriptor confirming Necromancer runs on the production host, outside every
 * cloud sandbox, and that kiro-cli runs on the host (Topology P-B).
 */
export function daemonSupervisionDescriptor(): DaemonSupervisionDescriptor {
  return {
    daemon: "necromancer",
    runsOutsideCloudSandboxes: true,
    kiroCliRunsOnHost: true,
    topology: "P-B",
  };
}

export interface LoadHostConfigOptions {
  /** Injected environment (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injected file existence check (defaults to fs.existsSync). */
  exists?: (p: string) => boolean;
  /**
   * Injected stat check used to confirm KIRO_CLI_BIN points at a regular file
   * (defaults to fs.statSync). Returning undefined skips the file-type check.
   */
  stat?: (p: string) => { isFile(): boolean } | undefined;
  /** Override TTL (defaults to DEFAULT_SANDBOX_TTL_MS). */
  ttlMs?: number;
  /** Override concurrency cap (defaults to MAX_CONCURRENT_RUNS). */
  maxConcurrentRuns?: number;
  /** Override egress allowlist (defaults to CONFIRMED_ALLOWED_HOSTS). */
  allowedEgressHosts?: readonly string[];
}

function resolveKiroCliBinary(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  stat: (p: string) => { isFile(): boolean } | undefined
): string {
  const configured = env.KIRO_CLI_BIN;
  if (configured !== undefined && configured !== null && configured.trim() !== "") {
    // An explicitly configured binary must be an absolute path to an existing
    // regular file; never silently fall back to the default locations.
    const candidate = configured.trim();
    if (!isAbsolute(candidate)) {
      throw new HostConfigError(
        `KIRO_CLI_BIN must be an absolute path: '${candidate}'`
      );
    }
    if (!exists(candidate)) {
      throw new HostConfigError(`KIRO_CLI_BIN does not exist: '${candidate}'`);
    }
    let info: { isFile(): boolean } | undefined;
    try {
      info = stat(candidate);
    } catch {
      info = undefined;
    }
    if (info && !info.isFile()) {
      throw new HostConfigError(
        `KIRO_CLI_BIN must be a regular file, not a directory: '${candidate}'`
      );
    }
    return candidate;
  }

  // KIRO_CLI_BIN unset: fall back to the standard host locations.
  const candidates: string[] = [];
  const home = env.HOME ?? "";
  if (home) {
    candidates.push(`${home}/.local/bin/kiro-cli`);
  }
  candidates.push("/usr/local/bin/kiro-cli", "/usr/bin/kiro-cli");

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  throw new HostConfigError(
    "kiro-cli binary not found at KIRO_CLI_BIN or standard host locations"
  );
}

/**
 * Loads and validates the always-on production host configuration. Throws
 * HostConfigError when any required production config is missing or invalid.
 */
export function loadProductionHostConfig(
  options?: LoadHostConfigOptions
): ProductionHostConfig {
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;
  const stat =
    options?.stat ??
    ((p: string) => {
      try {
        return statSync(p);
      } catch {
        return undefined;
      }
    });

  const ttlMs = options?.ttlMs ?? DEFAULT_SANDBOX_TTL_MS;
  if (
    typeof ttlMs !== "number" ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_SANDBOX_TTL_MS
  ) {
    throw new HostConfigError(
      `ttlMs must be a positive number not exceeding ${MAX_SANDBOX_TTL_MS}`
    );
  }

  const maxTtlMs = MAX_SANDBOX_TTL_MS;

  const maxConcurrentRuns = options?.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS;
  if (
    typeof maxConcurrentRuns !== "number" ||
    !Number.isInteger(maxConcurrentRuns) ||
    maxConcurrentRuns <= 0
  ) {
    throw new HostConfigError("maxConcurrentRuns must be a positive integer");
  }

  const allowedEgressHosts = options?.allowedEgressHosts ?? CONFIRMED_ALLOWED_HOSTS;
  if (!Array.isArray(allowedEgressHosts) || allowedEgressHosts.length === 0) {
    throw new HostConfigError(
      "allowedEgressHosts must be a non-empty array of hostnames"
    );
  }
  for (const host of allowedEgressHosts) {
    if (typeof host !== "string" || host.trim().length === 0) {
      throw new HostConfigError("allowedEgressHosts entries must be non-empty strings");
    }
  }

  const kiroCliBinary = resolveKiroCliBinary(env, exists, stat);

  return {
    ttlMs,
    maxTtlMs,
    maxConcurrentRuns,
    allowedEgressHosts: [...allowedEgressHosts],
    kiroCliBinary,
    topology: "P-B",
  };
}