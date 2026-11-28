// DockerCloudSandboxBackend: production execution backend under Topology P-B.
// Conforms strictly to ExecutionBackend (lib/backend/types.ts) with
// kind = "docker-cloud-sandbox". A transport/client adapter (DockerCloudClient)
// is injected so offline tests run deterministically without real Docker Cloud
// credentials or network calls.

import type {
  BackendKind,
  ExecChunk,
  ExecProcess,
  ExecRequest,
  ExecResult,
  ExecutionBackend,
  Sandbox,
  SandboxSpec,
} from "../backend/types";
import {
  SpecValidationError,
  validateExecRequest,
  validateSandboxSpec,
} from "../backend/spec-validator";
import {
  buildSandboxNetworkSpec,
  type RunNetworkPolicy,
} from "../backend/network-policy";
import {
  isForbiddenEnvName,
  isForbiddenEnvValue,
  isRootUser,
} from "../backend/docker-exec-stream";
import { validateSyncOutOrThrow, type SyncFileEntry } from "./sync-validator";

/**
 * Recorded probe result used for Topology P-B enforcement. A probe "passes"
 * only when its outcome is a recognized pass token.
 */
export interface ProbeRecord {
  readonly id: string;
  readonly passed?: unknown;
  readonly outcome?: unknown;
  readonly raw?: unknown;
}

export type ProbeResultLookup =
  | Record<string, unknown>
  | Map<string, unknown>
  | Array<{ id: string; [key: string]: unknown }>;

const PASS_TOKENS = new Set(["pass", "passed", "ok", "success", "true"]);

function valuePassed(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    return PASS_TOKENS.has(val.trim().toLowerCase());
  }
  if (typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if ("passed" in rec) return valuePassed(rec.passed);
    if ("outcome" in rec) return valuePassed(rec.outcome);
  }
  return false;
}

function lookupProbe(results: ProbeResultLookup | undefined, id: string): unknown {
  if (!results) return undefined;
  if (results instanceof Map) {
    return results.get(id) ?? results.get(id.toUpperCase()) ?? results.get(id.toLowerCase());
  }
  if (Array.isArray(results)) {
    return results.find(
      (e) => e && typeof e === "object" && String(e.id).toUpperCase() === id.toUpperCase()
    );
  }
  const rec = results as Record<string, unknown>;
  return rec[id] ?? rec[id.toUpperCase()] ?? rec[id.toLowerCase()];
}

/**
 * Error thrown when Topology P-B is violated: kiro-cli or Necromancer may not
 * run inside a cloud sandbox, and P10/P11 must have a recorded pass.
 */
export class TopologyViolationError extends Error {
  readonly ok = false as const;
  readonly code = "TOPOLOGY_P_B_VIOLATION" as const;
  readonly missingProbes: string[];

  constructor(message: string, missingProbes: string[] = []) {
    super(message);
    this.name = "TopologyViolationError";
    this.missingProbes = missingProbes;
    Object.setPrototypeOf(this, TopologyViolationError.prototype);
  }
}

/** Error thrown when a command is not a non-empty argv array. */
export class ArgvValidationError extends Error {
  readonly ok = false as const;
  readonly code = "ARGV_VALIDATION_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "ArgvValidationError";
    Object.setPrototypeOf(this, ArgvValidationError.prototype);
  }
}

/** Error thrown when a root/uid 0 user is requested. */
export class RootUserRejectedError extends Error {
  readonly ok = false as const;
  readonly code = "ROOT_USER_REJECTED" as const;

  constructor(message = "User ID 0 (root) is forbidden") {
    super(message);
    this.name = "RootUserRejectedError";
    Object.setPrototypeOf(this, RootUserRejectedError.prototype);
  }
}

/**
 * A single sequenced output chunk produced by an exec.
 */
export interface CloudExecChunk {
  readonly seq: number;
  readonly stream: "stdout" | "stderr" | "merged";
  readonly data: string;
  readonly at: number;
}

/** Result of a cloud exec, including the P16 separateStderr flag. */
export interface CloudExecOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly oomKilled: boolean;
  readonly separateStderr: boolean;
  readonly chunks: CloudExecChunk[];
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly logRef: string;
}

/**
 * Transport/client adapter for Docker Cloud. Injected so offline tests never
 * touch the network or real credentials.
 */
export interface DockerCloudClient {
  /** Provisions a sandbox and returns its id. */
  createSandbox(spec: SandboxSpec): Promise<{ id: string }>;
  /** Re-attaches an existing sandbox by id, or undefined if not found. */
  getSandbox(id: string): Promise<{ id: string; labels?: Record<string, string> } | undefined>;
  /** Lists sandboxes filtered by labels. */
  listSandboxes(labels?: Record<string, string>): Promise<Array<{ id: string; labels?: Record<string, string> }>>;
  /** Destroys a sandbox by id. */
  destroySandbox(id: string): Promise<void>;
  /** Runs a command (argv only) and returns the full outcome. */
  exec(
    id: string,
    argv: string[],
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number }
  ): Promise<CloudExecOutcome>;
  /** Reads a file from the sandbox by relative path. */
  readFile(id: string, path: string): Promise<Uint8Array | string>;
  /** Writes a file into the sandbox by relative path. */
  writeFile(id: string, path: string, data: Uint8Array | string): Promise<void>;
  /** Lists sandbox file entries under an optional root. */
  listFiles(id: string, root?: string): Promise<SyncFileEntry[]>;
  /** Exports sandbox logs. */
  exportLogs(id: string): Promise<void>;
}

export interface DockerCloudSandboxBackendOptions {
  /** Injected transport/client adapter. */
  client: DockerCloudClient;
  /** Recorded probe results for Topology P-B enforcement (P10, P11, P16). */
  probes?: ProbeResultLookup;
  /** Network policy used to build the default-deny egress spec. */
  networkPolicy?: RunNetworkPolicy;
  /** Default labels applied to created sandboxes. */
  labels?: Record<string, string>;
}
/**
 * Validates that a command payload is a non-empty argv array of non-empty
 * strings. Rejects shell strings (including `sh -c ...` raw strings).
 */
export function assertArgvArray(payload: unknown): asserts payload is string[] {
  if (typeof payload === "string") {
    throw new ArgvValidationError(
      "Command must be an argv array, not a shell string"
    );
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new ArgvValidationError("Command argv must be a non-empty array of strings");
  }
  for (const arg of payload) {
    if (typeof arg !== "string" || arg.trim().length === 0) {
      throw new ArgvValidationError("Command argv elements must be non-empty strings");
    }
  }
}

/**
 * A Docker Cloud sandbox. Commands run strictly as argv arrays; root/uid 0 is
 * rejected. When probe P16 reports unseparated stderr, the merged stream is
 * exposed via separateStderr: false.
 */
export class DockerCloudSandbox implements Sandbox {
  readonly id: string;
  readonly labels: Record<string, string>;
  private state: "running" | "stopped" | "destroyed" = "running";
  private seqCounter = 0;

  constructor(
    id: string,
    private readonly client: DockerCloudClient,
    private readonly spec: SandboxSpec,
    private readonly separateStderr: boolean,
    labels?: Record<string, string>
  ) {
    this.id = id;
    this.labels = { ...(labels ?? spec.labels ?? {}) };
  }

  private assertActive(): void {
    if (this.state === "destroyed") {
      throw new Error(`Sandbox '${this.id}' has been destroyed`);
    }
  }

  private rejectRoot(user: unknown): void {
    if (isRootUser(user)) {
      throw new RootUserRejectedError();
    }
  }

  async exec(req: ExecRequest): Promise<ExecProcess> {
    this.assertActive();
    validateExecRequest(req);
    const argv = req.argv;
    assertArgvArray(argv);
    this.rejectRoot((req as Record<string, unknown>).user);
    this.rejectRoot((req as Record<string, unknown>).uid);

    const outcome = await this.client.exec(this.id, argv, {
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: req.maxOutputBytes,
    });

    const chunks: ExecChunk[] = outcome.chunks.map((c) => ({
      seq: c.seq,
      stream: this.separateStderr ? c.stream : "merged",
      data: c.data,
      at: c.at,
    }));

    const self = this;
    const process: ExecProcess = {
      seq: 0,
      output: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
      async wait() {
        return {
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          oomKilled: outcome.oomKilled,
        };
      },
    };
    void self;
    return process;
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    this.assertActive();
    validateExecRequest(req);
    const argv = req.argv;
    assertArgvArray(argv);
    this.rejectRoot((req as Record<string, unknown>).user);
    this.rejectRoot((req as Record<string, unknown>).uid);

    const outcome = await this.client.exec(this.id, argv, {
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: req.maxOutputBytes,
    });

    const result: ExecResult & { separateStderr: boolean } = {
      logRef: outcome.logRef,
      oomKilled: outcome.oomKilled,
      timedOut: outcome.timedOut,
      exitCode: outcome.exitCode,
      stdoutTail: outcome.stdoutTail,
      stderrTail: outcome.stderrTail,
      truncated: false,
      separateStderr: this.separateStderr,
    };
    return result;
  }

  async wait(): Promise<{ exitCode: number | null; signal?: string; timedOut?: boolean; oomKilled?: boolean }> {
    this.assertActive();
    // The cloud client exec already completed; wait reports the recorded state.
    return { exitCode: null, timedOut: false, oomKilled: false };
  }

  async stop(): Promise<void> {
    this.assertActive();
    this.state = "stopped";
  }

  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;
    await this.client.destroySandbox(this.id);
    this.state = "destroyed";
  }

  /** Prohibits snapshot creation. */
  async snapshot(_id?: string): Promise<never> {
    throw new SpecValidationError(
      "Snapshot creation is prohibited (Requirement 21.16, 43.18)"
    );
  }
}
/**
 * DockerCloudSandboxBackend: production ExecutionBackend under Topology P-B.
 */
export class DockerCloudSandboxBackend implements ExecutionBackend {
  readonly kind: BackendKind = "docker-cloud-sandbox";
  readonly options: DockerCloudSandboxBackendOptions;

  private readonly sandboxesById = new Map<string, DockerCloudSandbox>();
  private readonly sandboxesByIdempotencyKey = new Map<string, DockerCloudSandbox>();
  /** Idempotency keys seen for exec calls, mapped to their first outcome. */
  private readonly execIdempotency = new Map<string, CloudExecOutcome>();

  constructor(options: DockerCloudSandboxBackendOptions) {
    if (!options || !options.client) {
      throw new SpecValidationError("DockerCloudSandboxBackend requires a client adapter");
    }
    this.options = options;
  }

  /** Returns whether P10 and P11 both have a recorded pass. */
  private topologyProbesPass(): { ok: boolean; missing: string[] } {
    const probes = this.options.probes;
    const missing: string[] = [];
    for (const id of ["P10", "P11"]) {
      if (!valuePassed(lookupProbe(probes, id))) {
        missing.push(id);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * Enforces Topology P-B. kiro-cli and Necromancer may never run inside a
   * cloud sandbox; when P10/P11 lack a recorded pass, any attempt to launch
   * kiro-cli or Necromancer is rejected.
   */
  private enforceTopologyPTrong(argv: string[]): void {
    const joined = argv.join(" ");
    const mentionsKiro = /\bkiro-cli\b/.test(joined) || argv.some((a) => a === "kiro-cli");
    const mentionsNecromancer = /necromancer/i.test(joined);
    if (mentionsKiro || mentionsNecromancer) {
      const { ok, missing } = this.topologyProbesPass();
      if (!ok) {
        throw new TopologyViolationError(
          `Topology P-B requires recorded passes for probes ${missing.join(", ")} before launching kiro-cli/Necromancer inside a cloud sandbox`,
          missing
        );
      }
      throw new TopologyViolationError(
        "Topology P-B: kiro-cli and Necromancer must run on the production host, never inside a cloud sandbox",
        []
      );
    }
  }

  private get separateStderr(): boolean {
    // P16 default: when not recorded as passed, treat stderr as unseparated.
    return valuePassed(lookupProbe(this.options.probes, "P16"));
  }

  async create(spec: SandboxSpec): Promise<DockerCloudSandbox> {
    if (!spec || typeof spec !== "object") {
      throw new SpecValidationError("SandboxSpec must be an object");
    }
    if (!spec.idempotencyKey || typeof spec.idempotencyKey !== "string") {
      throw new SpecValidationError("idempotencyKey is required");
    }

    // Idempotency: return the existing sandbox for a repeated create.
    const existing = this.sandboxesByIdempotencyKey.get(spec.idempotencyKey);
    if (existing) {
      return existing;
    }

    // Reject root/uid 0 in the spec.
    const rawSpec = spec as Record<string, unknown>;
    if (
      isRootUser(rawSpec.user) ||
      isRootUser(rawSpec.uid) ||
      isRootUser(rawSpec.userId)
    ) {
      throw new RootUserRejectedError();
    }

    // Full spec validation: secrets, ports, denylisted env, shell strings.
    validateSandboxSpec(spec);

    // Default-deny egress with explicit allowlist.
    const network = spec.network ?? buildSandboxNetworkSpec(this.options.networkPolicy);
    if (!network || network.default !== "deny") {
      throw new SpecValidationError(
        "SandboxSpec network must default to deny with an explicit allowlist"
      );
    }

    const { id } = await this.options.client.createSandbox(spec);
    const labels: Record<string, string> = {
      "git-graveyard.managed": "true",
      "git-graveyard.idempotency-key": spec.idempotencyKey,
      ...(this.options.labels ?? {}),
      ...(spec.labels ?? {}),
    };
    const sandbox = new DockerCloudSandbox(
      id,
      this.options.client,
      spec,
      this.separateStderr,
      labels
    );
    this.sandboxesById.set(id, sandbox);
    this.sandboxesByIdempotencyKey.set(spec.idempotencyKey, sandbox);
    return sandbox;
  }
async get(id: string): Promise<DockerCloudSandbox | undefined> {
    const local = this.sandboxesById.get(id);
    if (local) return local;
    for (const sandbox of this.sandboxesByIdempotencyKey.values()) {
      if (sandbox.id === id) return sandbox;
    }
    const remote = await this.options.client.getSandbox(id);
    if (!remote) return undefined;
    const sandbox = new DockerCloudSandbox(
      remote.id,
      this.options.client,
      { idempotencyKey: remote.id, labels: remote.labels },
      this.separateStderr,
      remote.labels
    );
    this.sandboxesById.set(sandbox.id, sandbox);
    return sandbox;
  }

  async list(labels?: Record<string, string>): Promise<DockerCloudSandbox[]> {
    const remotes = await this.options.client.listSandboxes(labels);
    const result: DockerCloudSandbox[] = [];
    for (const remote of remotes) {
      let sandbox = this.sandboxesById.get(remote.id);
      if (!sandbox) {
        sandbox = new DockerCloudSandbox(
          remote.id,
          this.options.client,
          { idempotencyKey: remote.id, labels: remote.labels },
          this.separateStderr,
          remote.labels
        );
        this.sandboxesById.set(remote.id, sandbox);
      }
      if (this.matchesLabels(sandbox.labels, labels)) {
        result.push(sandbox);
      }
    }
    return result;
  }

  private matchesLabels(
    candidate: Record<string, string>,
    filter?: Record<string, string>
  ): boolean {
    if (!filter || Object.keys(filter).length === 0) return true;
    for (const [k, v] of Object.entries(filter)) {
      if (candidate[k] !== v) return false;
    }
    return true;
  }

  async destroy(id: string): Promise<void> {
    const sandbox = this.sandboxesById.get(id);
    if (sandbox) {
      await sandbox.destroy();
    } else {
      await this.options.client.destroySandbox(id);
    }
    this.sandboxesById.delete(id);
    for (const [key, s] of this.sandboxesByIdempotencyKey.entries()) {
      if (s.id === id) this.sandboxesByIdempotencyKey.delete(key);
    }
  }

  /** Prohibits snapshot creation. */
  async snapshot(_id?: string): Promise<never> {
    throw new SpecValidationError(
      "Snapshot creation is prohibited (Requirement 21.16, 43.18)"
    );
  }

  /**
   * Executes a command with idempotency-key deduplication. The argv array is
   * enforced; root/uid 0 is rejected; Topology P-B is enforced for kiro-cli /
   * Necromancer launches.
   */
  async execWithIdempotency(id: string, req: ExecRequest): Promise<CloudExecOutcome> {
    validateExecRequest(req);
    assertArgvArray(req.argv);
    this.rejectRootUser(req);
    this.enforceTopologyPTrong(req.argv);
    const key = req.idempotencyKey;
    if (key && this.execIdempotency.has(key)) {
      return this.execIdempotency.get(key)!;
    }
    const outcome = await this.options.client.exec(id, req.argv, {
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: req.maxOutputBytes,
    });
    if (key) {
      this.execIdempotency.set(key, outcome);
    }
    return outcome;
  }

  private rejectRootUser(req: ExecRequest): void {
    const raw = req as Record<string, unknown>;
    if (isRootUser(raw.user) || isRootUser(raw.uid)) {
      throw new RootUserRejectedError();
    }
    if (req.env && typeof req.env === "object") {
      for (const [k, v] of Object.entries(req.env)) {
        if (isForbiddenEnvName(k)) {
          throw new SpecValidationError(
            `Environment variable name '${k}' matches secret denylist`
          );
        }
        if (isForbiddenEnvValue(v)) {
          throw new SpecValidationError(
            `Environment variable '${k}' value matches secret pattern`
          );
        }
      }
    }
  }

  /**
   * Validates and returns the syncOut batch after security checks. Build
   * outputs are excluded; absolute paths, `..`, .git/.kiro, symlinks and
   * oversized files are rejected.
   */
  validateSyncOut(files: Iterable<SyncFileEntry | string>): void {
    validateSyncOutOrThrow(files);
  }
}

export default DockerCloudSandboxBackend;