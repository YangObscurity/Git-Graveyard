// Execution backend factory selecting DockerCloudSandboxBackend when
// EXECUTION_BACKEND === "docker-cloud-sandbox", defaulting safely to
// createExecutionBackend from lib/backend/execution-backend.ts otherwise.

import {
  createExecutionBackend,
  type InstaboxDockerBackendOptions,
} from "../backend/execution-backend";
import type { ExecutionBackend } from "../backend/types";
import {
  DockerCloudSandboxBackend,
  type DockerCloudClient,
  type ProbeResultLookup,
} from "./docker-cloud-sandbox-backend";
import type { RunNetworkPolicy } from "../backend/network-policy";

export interface SelectExecutionBackendOptions {
  /** Injected client adapter required for the docker-cloud-sandbox backend. */
  client?: DockerCloudClient;
  /** Recorded probe results for Topology P-B enforcement. */
  probes?: ProbeResultLookup;
  /** Network policy for default-deny egress. */
  networkPolicy?: RunNetworkPolicy;
  /** Default labels applied to created sandboxes. */
  labels?: Record<string, string>;
  /** Options forwarded to the default instabox-docker backend. */
  instaboxOptions?: InstaboxDockerBackendOptions;
}

/**
 * Selects the production execution backend from EXECUTION_BACKEND (or an
 * explicit backendKind). Selects DockerCloudSandboxBackend when the value is
 * "docker-cloud-sandbox"; otherwise defaults safely to createExecutionBackend.
 */
export function selectExecutionBackend(
  backendKindOrOptions?: string | SelectExecutionBackendOptions,
  maybeOptions?: SelectExecutionBackendOptions
): ExecutionBackend {
  let backendKind: string | undefined;
  let options: SelectExecutionBackendOptions | undefined;

  if (
    backendKindOrOptions &&
    typeof backendKindOrOptions === "object"
  ) {
    options = backendKindOrOptions;
    backendKind = undefined;
  } else {
    backendKind = backendKindOrOptions as string | undefined;
    options = maybeOptions;
  }

  const chosen = backendKind ?? process.env.EXECUTION_BACKEND ?? "instabox-docker";

  if (chosen === "docker-cloud-sandbox") {
    if (!options?.client) {
      throw new Error(
        "docker-cloud-sandbox backend requires an injected DockerCloudClient adapter"
      );
    }
    return new DockerCloudSandboxBackend({
      client: options.client,
      probes: options.probes,
      networkPolicy: options.networkPolicy,
      labels: options.labels,
    });
  }

  return createExecutionBackend(chosen, options?.instaboxOptions);
}

/**
 * Production factory. Identical to selectExecutionBackend but named for the
 * production entry point.
 */
export function createProductionExecutionBackend(
  backendKindOrOptions?: string | SelectExecutionBackendOptions,
  maybeOptions?: SelectExecutionBackendOptions
): ExecutionBackend {
  return selectExecutionBackend(backendKindOrOptions, maybeOptions);
}

export default selectExecutionBackend;