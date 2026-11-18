import {
  InstaboxDockerBackend,
  type InstaboxDockerBackendOptions,
  InstaboxDockerSandbox,
  NetworkPolicyRequiredError,
  NotInV1Error,
} from "./instabox-docker-backend";
import type {
  BackendKind,
  ExecutionBackend,
  Sandbox,
  SandboxSpec,
} from "./types";

export {
  InstaboxDockerBackend,
  type InstaboxDockerBackendOptions,
  InstaboxDockerSandbox,
  NetworkPolicyRequiredError,
  NotInV1Error,
};

/**
 * Stub implementation for the production Docker Cloud Sandbox backend.
 * Requirement 43.1, 43.12. Throws NOT_IN_V1 on execution.
 */
export class DockerCloudSandboxStub implements ExecutionBackend {
  readonly kind: BackendKind = "docker-cloud-sandbox";

  async create(_spec: SandboxSpec): Promise<Sandbox> {
    throw new NotInV1Error("docker-cloud-sandbox is not available in v1");
  }

  async get(_id: string): Promise<Sandbox | undefined> {
    throw new NotInV1Error("docker-cloud-sandbox is not available in v1");
  }

  async list(_labels?: Record<string, string>): Promise<unknown[]> {
    throw new NotInV1Error("docker-cloud-sandbox is not available in v1");
  }

  async destroy(_id: string): Promise<void> {
    throw new NotInV1Error("docker-cloud-sandbox is not available in v1");
  }

  async snapshot(_id?: string): Promise<never> {
    throw new NotInV1Error(
      "Snapshots are not supported in v1 (Requirement 21.16, 43.18)"
    );
  }

  async syncIn(): Promise<never> {
    throw new NotInV1Error("syncIn is not available in v1");
  }

  async syncOut(): Promise<never> {
    throw new NotInV1Error("syncOut is not available in v1");
  }
}

export const DockerCloudSandboxBackend = DockerCloudSandboxStub;

/**
 * Factory picking the ExecutionBackend from EXECUTION_BACKEND environment variable
 * or an explicit backendKind argument.
 * Defaults to instabox-docker in development.
 * Requirement 43.1.
 */
export function createExecutionBackend(
  backendKindOrOptions?: BackendKind | string | InstaboxDockerBackendOptions,
  maybeOptions?: InstaboxDockerBackendOptions
): ExecutionBackend {
  let backendKind: string | undefined;
  let options: InstaboxDockerBackendOptions | undefined;

  if (backendKindOrOptions && typeof backendKindOrOptions === "object") {
    options = backendKindOrOptions as InstaboxDockerBackendOptions;
    backendKind = undefined;
  } else {
    backendKind = backendKindOrOptions as string | undefined;
    options = maybeOptions;
  }

  const chosen = backendKind ?? process.env.EXECUTION_BACKEND ?? "instabox-docker";

  if (chosen === "instabox-docker") {
    return new InstaboxDockerBackend(options);
  }

  if (chosen === "docker-cloud-sandbox") {
    return new DockerCloudSandboxStub();
  }

  throw new NotInV1Error(`Unsupported execution backend: '${chosen}'`);
}

export const getExecutionBackend = createExecutionBackend;
export const executionBackendFactory = createExecutionBackend;
export default createExecutionBackend;
