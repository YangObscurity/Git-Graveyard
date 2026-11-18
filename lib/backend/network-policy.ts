// Task 7.2: Per-run container network isolation and egress CONNECT proxy
// Requirements: 21.9, 21.10, 21.11, 21.12, 43.8, 43.11

import {
  ALLOWED_HOST_REASONS,
  CONFIRMED_ALLOWED_HOSTS,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_BLOCKED_HOSTS,
  getKiroHosts,
  isHostAllowed,
} from "./connect-proxy";
import type { SandboxSpec } from "./types";

/**
 * Error thrown when an attempt is made to mutate or overwrite an active run's network policy.
 * Requirement 21.12.
 */
export class NetworkPolicyImmutableError extends Error {
  readonly ok = false as const;
  readonly code = "NETWORK_POLICY_IMMUTABLE" as const;
  readonly runId: string;

  constructor(runId: string, message?: string) {
    const msg =
      message ??
      `Network policy for run '${runId}' is immutable and cannot be modified while run is active`;
    super(msg);
    this.name = "NetworkPolicyImmutableError";
    this.runId = runId;
    Object.setPrototypeOf(this, NetworkPolicyImmutableError.prototype);
  }
}

/**
 * Deep freeze helper ensuring object graphs are completely immutable.
 * Requirement 21.12.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj as Readonly<T>;
  }

  Object.freeze(obj);

  for (const key of Object.getOwnPropertyNames(obj)) {
    const prop = (obj as Record<string, unknown>)[key];
    if (prop !== null && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }

  return obj as Readonly<T>;
}

/**
 * Check if a policy object is frozen.
 */
export function isPolicyImmutable(policy: unknown): boolean {
  if (!policy || typeof policy !== "object") {
    return false;
  }
  return Object.isFrozen(policy);
}

/**
 * Pure descriptor for an isolated per-run internal Docker network.
 * Flag --internal ensures no external gateway is accessible directly from containers.
 * Requirements: 21.9, 43.11.
 */
export interface DockerNetworkDescriptor {
  readonly name: string;
  readonly driver: "bridge";
  readonly internal: true;
  readonly labels: Readonly<Record<string, string>>;
  readonly createArgv: readonly string[];
}

export interface BuildDockerNetworkOptions {
  networkName?: string;
  labels?: Record<string, string>;
}

/**
 * Pure builder creating Docker internal network description.
 * No docker calls are made.
 * Requirements: 21.9, 43.11.
 */
export function buildDockerInternalNetwork(
  runId: string,
  options?: BuildDockerNetworkOptions
): Readonly<DockerNetworkDescriptor> {
  const name = options?.networkName ?? `graveyard-run-${runId}`;
  const labels: Record<string, string> = {
    "git-graveyard.run-id": runId,
    "git-graveyard.managed": "true",
    "git-graveyard.internal": "true",
    ...(options?.labels ?? {}),
  };

  const createArgv: string[] = [
    "network",
    "create",
    "--internal",
    "--driver",
    "bridge",
  ];

  for (const [key, value] of Object.entries(labels)) {
    createArgv.push("--label", `${key}=${value}`);
  }

  createArgv.push(name);

  const descriptor: DockerNetworkDescriptor = {
    name,
    driver: "bridge",
    internal: true,
    labels,
    createArgv,
  };

  return deepFreeze(descriptor);
}

/**
 * Pure builder generating proxy environment variables for containers.
 * All traffic must route through the CONNECT proxy.
 * Requirements: 21.9, 43.11.
 */
export function buildProxyEnvironment(
  proxyUrl: string
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
  return deepFreeze(env);
}

export interface NetworkAllowEntry {
  readonly host: string;
  readonly ports?: readonly number[];
  readonly reason: string;
}

/**
 * Immutable per-run network policy specification.
 * Requirements: 21.9, 21.10, 21.11, 21.12, 43.8, 43.11.
 */
export interface RunNetworkPolicy {
  readonly runId: string;
  readonly networkName: string;
  readonly internal: true;
  readonly defaultEgress: "deny";
  readonly proxyUrl: string;
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly proxyEnv: Readonly<Record<string, string>>;
  readonly allowlist: readonly NetworkAllowEntry[];
  readonly blockedHosts: readonly string[];
  readonly kiroHosts: readonly string[];
  readonly dockerNetwork: Readonly<DockerNetworkDescriptor>;
  readonly createdAt: number;
  readonly immutable: true;
}

export interface BuildRunNetworkPolicyOptions {
  proxyHost?: string;
  proxyPort?: number;
  proxyUrl?: string;
  networkName?: string;
  kiroHosts?: readonly string[];
  customAllowlist?: readonly NetworkAllowEntry[];
  labels?: Record<string, string>;
}

/**
 * Pure builder for RunNetworkPolicy.
 * Assembles internal network description, proxy URL, environment, and allowlist.
 * Deep-freezes the returned policy to maintain immutability.
 * Requirements: 21.9, 21.10, 21.11, 21.12, 43.8, 43.11.
 */
export function buildRunNetworkPolicy(
  runId: string,
  options?: BuildRunNetworkPolicyOptions
): Readonly<RunNetworkPolicy> {
  const networkDescriptor = buildDockerInternalNetwork(runId, {
    networkName: options?.networkName,
    labels: options?.labels,
  });

  const proxyHost = options?.proxyHost ?? "connect-proxy";
  const proxyPort = options?.proxyPort ?? 8080;
  const proxyUrl = options?.proxyUrl ?? `http://${proxyHost}:${proxyPort}`;
  const proxyEnv = buildProxyEnvironment(proxyUrl);

  const allowlist: NetworkAllowEntry[] = options?.customAllowlist
    ? [...options.customAllowlist]
    : CONFIRMED_ALLOWED_HOSTS.map((host) => ({
        host,
        reason: ALLOWED_HOST_REASONS[host] ?? "Allowed egress host",
      }));

  const inputKiroHosts = options?.kiroHosts ?? getKiroHosts();
  const blockedHosts = [
    ...DEFAULT_BLOCKED_HOSTS,
    ...inputKiroHosts.filter(
      (kh) => !DEFAULT_BLOCKED_HOSTS.includes(kh as (typeof DEFAULT_BLOCKED_HOSTS)[number])
    ),
  ];

  const policy: RunNetworkPolicy = {
    runId,
    networkName: networkDescriptor.name,
    internal: true,
    defaultEgress: "deny",
    proxyUrl,
    proxyHost,
    proxyPort,
    proxyEnv,
    allowlist,
    blockedHosts,
    kiroHosts: inputKiroHosts,
    dockerNetwork: networkDescriptor,
    createdAt: Date.now(),
    immutable: true,
  };

  return deepFreeze(policy);
}

/**
 * Build container CLI arguments for connecting a container to the internal network
 * with proxy configuration.
 */
export function buildContainerNetworkArgs(
  policy: RunNetworkPolicy
): readonly string[] {
  const args: string[] = [
    "--network",
    policy.networkName,
    "--env",
    `HTTP_PROXY=${policy.proxyUrl}`,
    "--env",
    `HTTPS_PROXY=${policy.proxyUrl}`,
    "--env",
    `http_proxy=${policy.proxyUrl}`,
    "--env",
    `https_proxy=${policy.proxyUrl}`,
    "--env",
    "NO_PROXY=localhost,127.0.0.1",
    "--env",
    "no_proxy=localhost,127.0.0.1",
  ];
  return Object.freeze(args);
}

/**
 * Build SandboxSpec["network"] descriptor conforming to lib/backend/types.ts.
 * Requirements: 21.9, 43.8.
 */
export function buildSandboxNetworkSpec(
  policy?: RunNetworkPolicy
): NonNullable<SandboxSpec["network"]> {
  if (!policy) {
    return {
      default: "deny",
      allow: CONFIRMED_ALLOWED_HOSTS.map((host) => ({
        host,
        reason: ALLOWED_HOST_REASONS[host] ?? "Allowed egress host",
      })),
    };
  }

  return {
    default: "deny",
    allow: policy.allowlist.map((entry) => ({
      host: entry.host,
      ports: entry.ports ? [...entry.ports] : undefined,
      reason: entry.reason,
    })),
  };
}

function arePoliciesEqual(a: RunNetworkPolicy, b: RunNetworkPolicy): boolean {
  if (a.runId !== b.runId) return false;
  if (a.networkName !== b.networkName) return false;
  if (a.proxyUrl !== b.proxyUrl) return false;
  if (a.internal !== b.internal) return false;
  if (a.defaultEgress !== b.defaultEgress) return false;

  if (a.allowlist.length !== b.allowlist.length) return false;
  for (let i = 0; i < a.allowlist.length; i++) {
    if (a.allowlist[i].host !== b.allowlist[i].host) return false;
  }

  if (a.blockedHosts.length !== b.blockedHosts.length) return false;
  for (let i = 0; i < a.blockedHosts.length; i++) {
    if (a.blockedHosts[i] !== b.blockedHosts[i]) return false;
  }

  return true;
}

/**
 * Policy registry enforcing policy immutability during an active run.
 * Requirement 21.12.
 */
export class NetworkPolicyRegistry {
  private readonly policies = new Map<string, Readonly<RunNetworkPolicy>>();

  register(policy: RunNetworkPolicy): Readonly<RunNetworkPolicy> {
    const existing = this.policies.get(policy.runId);
    if (existing) {
      if (!arePoliciesEqual(existing, policy)) {
        throw new NetworkPolicyImmutableError(
          policy.runId,
          `Cannot modify network policy for active run '${policy.runId}' (Requirement 21.12)`
        );
      }
      return existing;
    }

    const frozen = deepFreeze(policy);
    this.policies.set(policy.runId, frozen);
    return frozen;
  }

  get(runId: string): Readonly<RunNetworkPolicy> | undefined {
    return this.policies.get(runId);
  }

  has(runId: string): boolean {
    return this.policies.has(runId);
  }

  /**
   * Release network policy when a run terminates.
   * Requirement 21.16.
   */
  release(runId: string): boolean {
    return this.policies.delete(runId);
  }

  clear(): void {
    this.policies.clear();
  }

  size(): number {
    return this.policies.size;
  }
}

export const globalNetworkPolicyRegistry = new NetworkPolicyRegistry();

export function registerRunNetworkPolicy(
  policy: RunNetworkPolicy
): Readonly<RunNetworkPolicy> {
  return globalNetworkPolicyRegistry.register(policy);
}

export function getRunNetworkPolicy(
  runId: string
): Readonly<RunNetworkPolicy> | undefined {
  return globalNetworkPolicyRegistry.get(runId);
}

export function hasRunNetworkPolicy(runId: string): boolean {
  return globalNetworkPolicyRegistry.has(runId);
}

export function releaseRunNetworkPolicy(runId: string): boolean {
  return globalNetworkPolicyRegistry.release(runId);
}
