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
/** Thrown when the sandbox a create returned was destroyed while the create was in flight. */
export class SandboxDestroyedDuringCreateError extends Error {
  readonly ok = false as const;
  readonly code = "SANDBOX_DESTROYED_DURING_CREATE" as const;
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(`Sandbox '${sandboxId}' was destroyed while it was being created; create it again`);
    this.name = "SandboxDestroyedDuringCreateError";
    this.sandboxId = sandboxId;
    Object.setPrototypeOf(this, SandboxDestroyedDuringCreateError.prototype);
  }
}

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
 * Shared pre-exec guard. Enforces Topology P-B (no kiro-cli / Necromancer
 * inside a cloud sandbox) and the secret env denylist. Passed into every
 * DockerCloudSandbox so exec, run and execWithIdempotency all enforce it
 * before touching the transport.
 */
export type ExecGuard = (req: ExecRequest) => void;

/**
 * Transport/client adapter for Docker Cloud. Injected so offline tests never
 * touch the network or real credentials.
 */
export interface DockerCloudClient {
  /**
   * Provisions a sandbox and returns its id. The adapter MUST persist
   * `spec.labels` on the remote sandbox so a later label-filtered lookup
   * (e.g. by `git-graveyard.idempotency-key`) can re-attach it after a restart.
   */
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
    labels?: Record<string, string>,
    private readonly guard?: ExecGuard
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
    this.guard?.(req);

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
    this.guard?.(req);

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
  private readonly sandboxesByIdempotencyKey = new Map<
    string,
    DockerCloudSandbox | Promise<DockerCloudSandbox>
  >();
  /** Ids destroyed in this process; never re-attached or cached again. */
  private readonly destroyedIds = new Set<string>();
  /** In-flight destroy count per id; while above zero, create(), attach() and get() treat the id as destroyed. */
  private readonly destroyingIds = new Map<string, number>();
  /** Exec idempotency keys (`sandboxId:idempotencyKey`) mapped to in-flight outcomes. */
  private readonly execIdempotency = new Map<string, Promise<CloudExecOutcome>>();
  /** Shared Topology P-B + env denylist guard enforced on every exec path. */
  private readonly execGuard: ExecGuard;

  constructor(options: DockerCloudSandboxBackendOptions) {
    if (!options || !options.client) {
      throw new SpecValidationError("DockerCloudSandboxBackend requires a client adapter");
    }
    this.options = options;
    this.execGuard = this.buildExecGuard();
  }

  /**
   * Builds the shared pre-exec guard: Topology P-B plus the secret env
   * denylist. Used by exec, run and execWithIdempotency.
   */
  private buildExecGuard(): ExecGuard {
    return (req: ExecRequest): void => {
      this.enforceTopologyPB(req.argv);
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
    };
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
  private enforceTopologyPB(argv: string[]): void {
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

    // Idempotency: return the existing (or in-flight) sandbox for a repeated
    // create. The map may hold a pending promise so concurrent callers share
    // a single provisioning attempt.
    const existing = this.sandboxesByIdempotencyKey.get(spec.idempotencyKey);
    if (existing) {
      return await existing;
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

    // The client must receive the resolved default-deny network, not the raw
    // spec, or egress would be unrestricted whenever spec.network was omitted.
    const resolvedSpec: SandboxSpec = { ...spec, network };

    // Store the in-flight promise before the first await so concurrent creates
    // with the same key share one sandbox instead of provisioning twice.
    const pending = this.provision(spec.idempotencyKey, resolvedSpec, spec);
    this.sandboxesByIdempotencyKey.set(spec.idempotencyKey, pending);
    try {
      return await pending;
    } catch (err) {
      // Do not leave a rejected promise cached for a failed creation.
      if (this.sandboxesByIdempotencyKey.get(spec.idempotencyKey) === pending) {
        this.sandboxesByIdempotencyKey.delete(spec.idempotencyKey);
      }
      throw err;
    }
  }

  /**
   * Re-attaches an existing sandbox (from a previous process) or provisions a
   * new one. On a local miss the client is queried by idempotency-key label so
   * a restart does not create a duplicate sandbox.
   */
  private async provision(
    idempotencyKey: string,
    resolvedSpec: SandboxSpec,
    spec: SandboxSpec
  ): Promise<DockerCloudSandbox> {
    // Build the merged labels before contacting the client so the adapter can
    // persist them on the remote sandbox. Backend defaults come first, this
    // create's own labels override them, and the reserved `git-graveyard.*`
    // keys are written last so neither can override them.
    const labels: Record<string, string> = {
      ...(this.options.labels ?? {}),
      ...(spec.labels ?? {}),
      "git-graveyard.managed": "true",
      "git-graveyard.idempotency-key": idempotencyKey,
    };
    const specWithLabels: SandboxSpec = { ...resolvedSpec, labels };

    const matches = await this.options.client.listSandboxes({
      "git-graveyard.idempotency-key": idempotencyKey,
    });
    // The client is not required to honour the label filter, so only a sandbox
    // that actually carries this idempotency key may be re-attached; anything
    // else would hand this run another run's sandbox. A sandbox destroyed while
    // this list was in flight must not be cached or returned.
    const match = matches.find(
      (s) =>
        s.labels?.["git-graveyard.idempotency-key"] === idempotencyKey &&
        !this.destroyedIds.has(s.id)
    );
    if (match) {
      const attached = this.attach(match.id, match.labels, idempotencyKey);
      if (attached) return attached;
    }

    const { id } = await this.options.client.createSandbox(specWithLabels);
    // Same rule as the list path: a sandbox destroyed while createSandbox was
    // in flight is never cached or returned as usable. The caller must create
    // again with a new attempt.
    if (this.destroyedIds.has(id) || this.destroyingIds.has(id)) {
      throw new SandboxDestroyedDuringCreateError(id);
    }
    const sandbox = new DockerCloudSandbox(
      id,
      this.options.client,
      specWithLabels,
      this.separateStderr,
      labels,
      this.execGuard
    );
    this.sandboxesById.set(id, sandbox);
    this.sandboxesByIdempotencyKey.set(idempotencyKey, sandbox);
    return sandbox;
  }

  /**
   * Builds (or reuses) a sandbox wrapper for an existing remote sandbox and
   * indexes it by its `git-graveyard.idempotency-key` label.
   */
  private attach(
    id: string,
    labels: Record<string, string> | undefined,
    idempotencyKey: string
  ): DockerCloudSandbox | undefined {
    // Never re-attach or cache a sandbox that was destroyed in this process.
    if (this.destroyedIds.has(id) || this.destroyingIds.has(id)) return undefined;
    let sandbox = this.sandboxesById.get(id);
    if (!sandbox) {
      sandbox = new DockerCloudSandbox(
        id,
        this.options.client,
        { idempotencyKey, labels },
        this.separateStderr,
        labels,
        this.execGuard
      );
      this.sandboxesById.set(id, sandbox);
    }
    const key = labels?.["git-graveyard.idempotency-key"] ?? idempotencyKey;
    if (key) {
      this.sandboxesByIdempotencyKey.set(key, sandbox);
    }
    return sandbox;
  }
  async get(id: string): Promise<DockerCloudSandbox | undefined> {
    // A sandbox that is destroyed or being destroyed is never handed out, even
    // if its wrapper is still cached.
    if (this.destroyedIds.has(id) || this.destroyingIds.has(id)) return undefined;
    const local = this.sandboxesById.get(id);
    if (local) return local;
    const remote = await this.options.client.getSandbox(id);
    if (!remote) return undefined;
    return this.attach(
      id,
      remote.labels,
      remote.labels?.["git-graveyard.idempotency-key"] ?? ""
    );
  }

  async list(labels?: Record<string, string>): Promise<DockerCloudSandbox[]> {
    const remotes = await this.options.client.listSandboxes(labels);
    const result: DockerCloudSandbox[] = [];
    for (const remote of remotes) {
      const sandbox = this.attach(
        remote.id,
        remote.labels,
        remote.labels?.["git-graveyard.idempotency-key"] ?? ""
      );
      if (!sandbox) continue;
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
    // Mark the destroy as in flight first, so a create() that returns this id
    // while the remote destroy is still running refuses it too.
    this.destroyingIds.set(id, (this.destroyingIds.get(id) ?? 0) + 1);
    try {
      const sandbox = this.sandboxesById.get(id);
      if (sandbox) {
        await sandbox.destroy();
      } else {
        await this.options.client.destroySandbox(id);
      }
    } finally {
      const left = (this.destroyingIds.get(id) ?? 1) - 1;
      if (left > 0) this.destroyingIds.set(id, left);
      else this.destroyingIds.delete(id);
    }
    this.sandboxesById.delete(id);
    for (const [key, s] of this.sandboxesByIdempotencyKey.entries()) {
      if (s instanceof Promise) continue;
      if (s.id === id) this.sandboxesByIdempotencyKey.delete(key);
    }
    // Drop any cached exec outcomes for this sandbox.
    const prefix = `${id}:`;
    for (const key of [...this.execIdempotency.keys()]) {
      if (key.startsWith(prefix)) this.execIdempotency.delete(key);
    }
    // Record the id so a sandbox destroyed while an await was in flight is
    // never re-attached or cached again by this backend.
    this.destroyedIds.add(id);
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
    this.execGuard(req);
    const key = req.idempotencyKey;
    const cacheKey = key ? `${id}:${key}` : undefined;
    if (cacheKey) {
      const existing = this.execIdempotency.get(cacheKey);
      if (existing) return existing;
    }
    const pending = this.options.client.exec(id, req.argv, {
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: req.maxOutputBytes,
    });
    if (cacheKey) {
      this.execIdempotency.set(cacheKey, pending);
    }
    try {
      return await pending;
    } catch (err) {
      // Do not cache a failed exec; a retry should hit the transport again.
      if (cacheKey && this.execIdempotency.get(cacheKey) === pending) {
        this.execIdempotency.delete(cacheKey);
      }
      throw err;
    }
  }

  private rejectRootUser(req: ExecRequest): void {
    const raw = req as Record<string, unknown>;
    if (isRootUser(raw.user) || isRootUser(raw.uid)) {
      throw new RootUserRejectedError();
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