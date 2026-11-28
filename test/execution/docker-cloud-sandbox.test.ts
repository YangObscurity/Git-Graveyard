// Offline integration tests for the DockerCloudSandboxBackend (Topology P-B),
// workspace sync security, and cloud sandbox lifecycle / host config.
// All tests run deterministically offline via an injected DockerCloudClient.

import test, { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  DockerCloudSandboxBackend,
  TopologyViolationError,
  SandboxDestroyedDuringCreateError,
  ArgvValidationError,
  RootUserRejectedError,
  type DockerCloudClient,
  type CloudExecOutcome,
  type ProbeResultLookup,
} from "../../lib/execution/docker-cloud-sandbox-backend";
import {
  selectExecutionBackend,
  createProductionExecutionBackend,
} from "../../lib/execution/backend-factory";
import {
  syncIn,
  syncOut,
  type HostWorktree,
  type SyncTransport,
} from "../../lib/execution/sandbox-sync";
import {
  MAX_SYNC_FILE_BYTES,
  SandboxSyncValidationError,
} from "../../lib/execution/sync-validator";
import {
  CloudSandboxLifecycle,
  DEFAULT_SANDBOX_TTL_MS,
  MAX_SANDBOX_TTL_MS,
  MAX_CONCURRENT_RUNS,
  SnapshotProhibitedError,
  TtlCapExceededError,
  ConcurrencyQuotaExceededError,
} from "../../lib/execution/cloud-lifecycle";
import {
  loadProductionHostConfig,
  daemonSupervisionDescriptor,
  HostConfigError,
} from "../../lib/execution/host-config";
import { buildRunNetworkPolicy } from "../../lib/backend/network-policy";
import { SpecValidationError } from "../../lib/backend/spec-validator";
import type { SandboxSpec, ExecRequest } from "../../lib/backend/types";

const PINNED_IMAGE =
  "docker.io/library/node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface ExecCall {
  id: string;
  argv: string[];
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number };
}

/**
 * In-memory fake DockerCloudClient. Records all calls and returns scripted
 * outcomes so tests are fully deterministic and offline.
 */
class FakeCloudClient implements DockerCloudClient {
  readonly execCalls: ExecCall[] = [];
  readonly created: SandboxSpec[] = [];
  readonly destroyed: string[] = [];
  readonly files = new Map<string, Map<string, Uint8Array | string>>();
  readonly labelsById = new Map<string, Record<string, string>>();
  private nextId = 1;
  /** Scripted outcome per argv[0] match, or a default. */
  constructor(
    private readonly handler?: (
      id: string,
      argv: string[],
      options?: ExecCall["options"]
    ) => CloudExecOutcome | Promise<CloudExecOutcome>
  ) {}

  async createSandbox(spec: SandboxSpec): Promise<{ id: string }> {
    this.created.push(spec);
    const id = `box-${this.nextId++}`;
    this.files.set(id, new Map());
    // Store exactly the labels handed to createSandbox, so re-attachment relies
    // only on what the client persisted (not on labels the backend sets later).
    this.labelsById.set(id, { ...(spec.labels ?? {}) });
    return { id };
  }

  async getSandbox(id: string): Promise<{ id: string; labels?: Record<string, string> } | undefined> {
    if (this.files.has(id)) {
      return {
        id,
        labels: this.labelsById.get(id) ?? { "git-graveyard.managed": "true" },
      };
    }
    return undefined;
  }

  async listSandboxes(labels?: Record<string, string>): Promise<Array<{ id: string; labels?: Record<string, string> }>> {
    const all = [...this.files.keys()].map((id) => ({
      id,
      labels: this.labelsById.get(id) ?? { "git-graveyard.managed": "true" },
    }));
    if (!labels) return all;
    return all.filter((s) =>
      Object.entries(labels).every(([k, v]) => s.labels?.[k] === v)
    );
  }

  async destroySandbox(id: string): Promise<void> {
    this.destroyed.push(id);
  }

  async exec(
    id: string,
    argv: string[],
    options?: ExecCall["options"]
  ): Promise<CloudExecOutcome> {
    this.execCalls.push({ id, argv: [...argv], options });
    if (this.handler) {
      return this.handler(id, argv, options);
    }
    return {
      exitCode: 0,
      timedOut: false,
      oomKilled: false,
      separateStderr: true,
      chunks: [
        { seq: 0, stream: "stdout", data: "ok\n", at: 1 },
      ],
      stdoutTail: "ok\n",
      stderrTail: "",
      logRef: `log-${id}`,
    };
  }

  async readFile(id: string, path: string): Promise<Uint8Array | string> {
    const sandboxFiles = this.files.get(id);
    const v = sandboxFiles?.get(path);
    if (v === undefined) throw new Error(`No file ${path} in ${id}`);
    return v;
  }

  async writeFile(id: string, path: string, data: Uint8Array | string): Promise<void> {
    const sandboxFiles = this.files.get(id) ?? new Map();
    sandboxFiles.set(path, data);
    this.files.set(id, sandboxFiles);
  }

  async listFiles(id: string, _root?: string): Promise<Array<{ path: string; size?: number; isSymlink?: boolean }>> {
    const sandboxFiles = this.files.get(id) ?? new Map();
    return [...sandboxFiles.entries()].map(([p, d]) => ({
      path: p,
      size: typeof d === "string" ? Buffer.byteLength(d) : d.length,
    }));
  }

  async exportLogs(_id: string): Promise<void> {
    // no-op
  }

  seedFile(id: string, path: string, data: Uint8Array | string): void {
    const sandboxFiles = this.files.get(id) ?? new Map();
    sandboxFiles.set(path, data);
    this.files.set(id, sandboxFiles);
  }
}

function allProbesPass(): ProbeResultLookup {
  return {
    P10: { id: "P10", passed: true },
    P11: { id: "P11", passed: true },
    P16: { id: "P16", passed: true },
  };
}

function makeBackend(
  client: DockerCloudClient,
  probes?: ProbeResultLookup
): DockerCloudSandboxBackend {
  const policy = buildRunNetworkPolicy(`run-${Math.random().toString(36).slice(2)}`);
  return new DockerCloudSandboxBackend({ client, probes, networkPolicy: policy });
}

describe("DockerCloudSandboxBackend: factory selection", () => {
  it("selects DockerCloudSandboxBackend when EXECUTION_BACKEND=docker-cloud-sandbox", () => {
    const prev = process.env.EXECUTION_BACKEND;
    process.env.EXECUTION_BACKEND = "docker-cloud-sandbox";
    try {
      const client = new FakeCloudClient();
      const backend = selectExecutionBackend({ client, probes: allProbesPass() });
      assert.ok(backend instanceof DockerCloudSandboxBackend);
      assert.equal(backend.kind, "docker-cloud-sandbox");
    } finally {
      if (prev === undefined) delete process.env.EXECUTION_BACKEND;
      else process.env.EXECUTION_BACKEND = prev;
    }
  });

  it("createProductionExecutionBackend selects DockerCloudSandboxBackend with explicit kind", () => {
    const client = new FakeCloudClient();
    const backend = createProductionExecutionBackend("docker-cloud-sandbox", {
      client,
      probes: allProbesPass(),
    });
    assert.ok(backend instanceof DockerCloudSandboxBackend);
    assert.equal(backend.kind, "docker-cloud-sandbox");
  });

  it("defaults safely to createExecutionBackend (instabox-docker) otherwise", () => {
    const prev = process.env.EXECUTION_BACKEND;
    delete process.env.EXECUTION_BACKEND;
    try {
      const backend = selectExecutionBackend();
      assert.equal(backend.kind, "instabox-docker");
    } finally {
      if (prev !== undefined) process.env.EXECUTION_BACKEND = prev;
    }
  });

  it("throws when docker-cloud-sandbox is selected without a client adapter", () => {
    assert.throws(
      () => selectExecutionBackend("docker-cloud-sandbox", {}),
      /requires an injected DockerCloudClient/
    );
  });
});
describe("Topology P-B enforcement", () => {
  it("rejects launching kiro-cli inside a cloud sandbox", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "k1", image: PINNED_IMAGE });
    await assert.rejects(
      () => backend.execWithIdempotency(box.id, { argv: ["kiro-cli", "run"] }),
      (err: unknown) => {
        assert.ok(err instanceof TopologyViolationError);
        assert.equal((err as TopologyViolationError).code, "TOPOLOGY_P_B_VIOLATION");
        return true;
      }
    );
  });

  it("rejects launching Necromancer inside a cloud sandbox", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "k2", image: PINNED_IMAGE });
    await assert.rejects(
      () => backend.execWithIdempotency(box.id, { argv: ["necromancer", "--serve"] }),
      (err: unknown) => err instanceof TopologyViolationError
    );
  });

  it("requires P10 and P11 recorded pass before a kiro-cli launch", async () => {
    const client = new FakeCloudClient();
    const probes: ProbeResultLookup = {
      P10: { id: "P10", passed: false },
      P11: { id: "P11", passed: true },
      P16: { id: "P16", passed: true },
    };
    const backend = makeBackend(client, probes);
    const box = await backend.create({ idempotencyKey: "k3", image: PINNED_IMAGE });
    await assert.rejects(
      () => backend.execWithIdempotency(box.id, { argv: ["kiro-cli", "run"] }),
      (err: unknown) => {
        assert.ok(err instanceof TopologyViolationError);
        assert.ok((err as TopologyViolationError).missingProbes.includes("P10"));
        return true;
      }
    );
  });

  it("runs a normal command even when probes are missing (only kiro-cli/Necromancer gated)", async () => {
    const client = new FakeCloudClient();
    const probes: ProbeResultLookup = {
      P10: { id: "P10", passed: false },
      P11: { id: "P11", passed: false },
    };
    const backend = makeBackend(client, probes);
    const box = await backend.create({ idempotencyKey: "k5", image: PINNED_IMAGE });
    const outcome = await backend.execWithIdempotency(box.id, { argv: ["echo", "hi"] });
    assert.equal(outcome.exitCode, 0);
  });

  it("runs a normal command once P10/P11 pass", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "k4", image: PINNED_IMAGE });
    const outcome = await backend.execWithIdempotency(box.id, { argv: ["echo", "hi"] });
    assert.equal(outcome.exitCode, 0);
  });
});
describe("Argv-array enforcement and UID 0 rejection", () => {
  it("rejects a shell string command", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "a1", image: PINNED_IMAGE });
    await assert.rejects(
      () =>
        backend.execWithIdempotency(box.id, {
          argv: "sh -c 'echo hi'",
        } as unknown as ExecRequest),
      (err: unknown) => err instanceof ArgvValidationError || err instanceof SpecValidationError
    );
  });

  it("rejects uid 0 in the exec request", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "a2", image: PINNED_IMAGE });
    await assert.rejects(
      () =>
        backend.execWithIdempotency(box.id, {
          argv: ["whoami"],
          user: 0,
        } as ExecRequest),
      (err: unknown) => err instanceof RootUserRejectedError
    );
  });

  it("rejects user root in the exec request", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "a3", image: PINNED_IMAGE });
    await assert.rejects(
      () =>
        backend.execWithIdempotency(box.id, {
          argv: ["whoami"],
          user: "root",
        } as ExecRequest),
      (err: unknown) => err instanceof RootUserRejectedError
    );
  });

  it("rejects uid 0 in the sandbox spec at create", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    await assert.rejects(
      () => backend.create({ idempotencyKey: "a4", image: PINNED_IMAGE, uid: 0 }),
      (err: unknown) => err instanceof RootUserRejectedError
    );
  });

  it("rejects an empty argv array", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "a5", image: PINNED_IMAGE });
    await assert.rejects(
      () => backend.execWithIdempotency(box.id, { argv: [] }),
      (err: unknown) => err instanceof ArgvValidationError
    );
  });
});
describe("Probe P16 separateStderr handling", () => {
  it("exposes separateStderr:false and a single merged stream when P16 not passed", async () => {
    const client = new FakeCloudClient((_id, argv) => ({
      exitCode: 0,
      timedOut: false,
      oomKilled: false,
      separateStderr: false,
      chunks: [
        { seq: 0, stream: "stdout", data: "out\n", at: 1 },
        { seq: 1, stream: "stderr", data: "err\n", at: 2 },
      ],
      stdoutTail: "out\n",
      stderrTail: "err\n",
      logRef: "log-p16",
    }));
    const probes: ProbeResultLookup = {
      P10: { id: "P10", passed: true },
      P11: { id: "P11", passed: true },
      P16: { id: "P16", passed: false },
    };
    const backend = makeBackend(client, probes);
    const box = await backend.create({ idempotencyKey: "p16-1", image: PINNED_IMAGE });
    const result = (await box.run({ argv: ["combined"] })) as unknown as {
      separateStderr: boolean;
    };
    assert.equal(result.separateStderr, false);

    const proc = await box.exec({ argv: ["combined"] });
    const chunks: Array<{ stream?: string }> = [];
    if (proc.output) {
      for await (const c of proc.output) {
        chunks.push({ stream: c.stream });
      }
    }
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((c) => c.stream === "merged"));
  });

  it("exposes separateStderr:true when P16 passed", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "p16-2", image: PINNED_IMAGE });
    const result = (await box.run({ argv: ["split"] })) as unknown as {
      separateStderr: boolean;
    };
    assert.equal(result.separateStderr, true);
  });
});
/** In-memory host worktree used as the authoritative edit source. */
class FakeHostWorktree implements HostWorktree {
  readonly root = "/host/worktree";
  readonly files = new Map<string, Uint8Array | string>();
  constructor(seed?: Record<string, string>) {
    if (seed) {
      for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
    }
  }
  async listFiles(_root?: string): Promise<Array<{ path: string; size?: number; isSymlink?: boolean }>> {
    return [...this.files.entries()].map(([p, d]) => ({
      path: p,
      size: typeof d === "string" ? Buffer.byteLength(d) : d.length,
    }));
  }
  async readFile(relPath: string): Promise<Uint8Array | string> {
    const v = this.files.get(relPath);
    if (v === undefined) throw new Error(`missing ${relPath}`);
    return v;
  }
  async writeFile(relPath: string, data: Uint8Array | string): Promise<void> {
    this.files.set(relPath, data);
  }
}

/** In-memory sync transport backed by a file map. */
class FakeSyncTransport implements SyncTransport {
  readonly files = new Map<string, Uint8Array | string>();
  constructor(seed?: Record<string, string>) {
    if (seed) {
      for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
    }
  }
  async readSandboxFile(path: string): Promise<Uint8Array | string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`missing ${path}`);
    return v;
  }
  async writeSandboxFile(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(path, data);
  }
  async listSandboxFiles(_root?: string): Promise<Array<{ path: string; size?: number; isSymlink?: boolean; type?: string }>> {
    return [...this.files.entries()].map(([p, d]) => ({
      path: p,
      size: typeof d === "string" ? Buffer.byteLength(d) : d.length,
    }));
  }
}
describe("Workspace sync: host worktree authority and syncOut security", () => {
  it("syncIn pushes host worktree files into the sandbox", async () => {
    const worktree = new FakeHostWorktree({ "src/a.ts": "export const a = 1;", "package.json": "{}" });
    const transport = new FakeSyncTransport();
    const result = await syncIn(worktree, transport);
    assert.equal(result.ok, true);
    assert.ok(result.transferred.includes("src/a.ts"));
    assert.equal(await transport.readSandboxFile("src/a.ts"), "export const a = 1;");
  });

  it("syncOut rejects absolute POSIX paths", async () => {
    const transport = new FakeSyncTransport({ "/etc/passwd": "root" });
    const worktree = new FakeHostWorktree();
    await assert.rejects(
      () => syncOut(transport, worktree),
      (err: unknown) => err instanceof SandboxSyncValidationError
    );
  });

  it("syncOut rejects Windows absolute paths", async () => {
    const transport = new FakeSyncTransport({ "C:\\Windows\\system32": "x" });
    const worktree = new FakeHostWorktree();
    await assert.rejects(() => syncOut(transport, worktree));
  });

  it("syncOut rejects .. parent traversal", async () => {
    const transport = new FakeSyncTransport({ "../escape.txt": "x" });
    const worktree = new FakeHostWorktree();
    await assert.rejects(() => syncOut(transport, worktree));
  });

  it("syncOut rejects paths under .git/", async () => {
    const transport = new FakeSyncTransport({ ".git/config": "[core]" });
    const worktree = new FakeHostWorktree();
    await assert.rejects(() => syncOut(transport, worktree));
  });

  it("syncOut rejects paths under .kiro/", async () => {
    const transport = new FakeSyncTransport({ ".kiro/steering.md": "x" });
    const worktree = new FakeHostWorktree();
    await assert.rejects(() => syncOut(transport, worktree));
  });

  it("syncOut rejects symlinks", async () => {
    const transport = new FakeSyncTransport();
    transport.files.set("link.ts", "target");
    // Override listSandboxFiles to report a symlink entry.
    (transport as unknown as { listSandboxFiles: () => Promise<unknown[]> }).listSandboxFiles = async () => [
      { path: "link.ts", isSymlink: true },
    ];
    const worktree = new FakeHostWorktree();
    await assert.rejects(
      () => syncOut(transport, worktree),
      (err: unknown) => err instanceof SandboxSyncValidationError
    );
  });

  it("syncOut rejects oversized files", async () => {
    const big = "a".repeat(MAX_SYNC_FILE_BYTES + 10);
    const transport = new FakeSyncTransport({ "big.txt": big });
    const worktree = new FakeHostWorktree();
    await assert.rejects(() => syncOut(transport, worktree));
  });

  it("syncOut excludes node_modules and dist but keeps sources and lock files", async () => {
    const transport = new FakeSyncTransport({
      "node_modules/pkg/index.js": "x",
      "dist/bundle.js": "y",
      "src/index.ts": "z",
      "package-lock.json": "{}",
      "package.json": "{}",
    });
    const worktree = new FakeHostWorktree();
    const result = await syncOut(transport, worktree);
    assert.equal(result.ok, true);
    assert.ok(result.skipped.includes("node_modules/pkg/index.js"));
    assert.ok(result.skipped.includes("dist/bundle.js"));
    assert.ok(result.transferred.includes("src/index.ts"));
    assert.ok(result.transferred.includes("package-lock.json"));
    assert.ok(result.transferred.includes("package.json"));
    assert.ok(worktree.files.has("src/index.ts"));
  });
});
describe("SandboxSpec security rejection and default-deny network", () => {
  it("rejects specs carrying secret values in env", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    await assert.rejects(
      () =>
        backend.create({
          idempotencyKey: "s1",
          image: PINNED_IMAGE,
          env: { GITHUB_TOKEN: "ghp_secretvalue" },
        }),
      /secret denylist|secret pattern/
    );
  });

  it("rejects non-empty secrets field", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    await assert.rejects(
      () => backend.create({ idempotencyKey: "s2", image: PINNED_IMAGE, secrets: { a: 1 } }),
      /secrets field/
    );
  });

  it("rejects non-empty ports field", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    await assert.rejects(
      () => backend.create({ idempotencyKey: "s3", image: PINNED_IMAGE, ports: [8080] }),
      /ports field/
    );
  });

  it("rejects denylisted env var names", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    await assert.rejects(
      () =>
        backend.create({
          idempotencyKey: "s4",
          image: PINNED_IMAGE,
          env: { KIRO_API_KEY: "anything" },
        }),
      /secret denylist/
    );
  });

  it("defaults network to deny with an explicit allowlist", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "s5", image: PINNED_IMAGE });
    assert.ok(box);
    assert.equal(client.created.length, 1);
    // The spec handed to the cloud client carries the resolved default-deny network.
    const sent = client.created[0] as SandboxSpec & { network?: { default?: string } };
    assert.equal(sent.network?.default, "deny");
  });
});

describe("Re-attachment, idempotency and streaming", () => {
  it("re-attaches via get(id) after host restart", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "r1", image: PINNED_IMAGE });
    // Simulate a fresh backend sharing the same client (host restart).
    const backend2 = makeBackend(client, allProbesPass());
    const reattached = await backend2.get(box.id);
    assert.ok(reattached);
    assert.equal(reattached!.id, box.id);
  });

  it("re-attaches via label-filtered list(labels)", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    await backend.create({
      idempotencyKey: "r2",
      image: PINNED_IMAGE,
      labels: { "git-graveyard.run-id": "run-42" },
    });
    const backend2 = makeBackend(client, allProbesPass());
    const listed = await backend2.list({ "git-graveyard.run-id": "run-42" });
    assert.ok(listed.length >= 1);
  });

  it("deduplicates create by idempotency key", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const a = await backend.create({ idempotencyKey: "dup", image: PINNED_IMAGE });
    const b = await backend.create({ idempotencyKey: "dup", image: PINNED_IMAGE });
    assert.equal(a.id, b.id);
    assert.equal(client.created.length, 1);
  });

  it("deduplicates exec by idempotency key", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "r3", image: PINNED_IMAGE });
    const o1 = await backend.execWithIdempotency(box.id, {
      argv: ["echo", "x"],
      idempotencyKey: "exec-key",
    });
    const o2 = await backend.execWithIdempotency(box.id, {
      argv: ["echo", "x"],
      idempotencyKey: "exec-key",
    });
    assert.equal(o1, o2);
    assert.equal(client.execCalls.length, 1);
  });

  it("produces sequenced monotonic output chunks", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "r4", image: PINNED_IMAGE });
    const proc = await box.exec({ argv: ["seq"] });
    const seqs: number[] = [];
    if (proc.output) {
      for await (const c of proc.output) seqs.push(c.seq);
    }
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1]);
    }
  });
});
describe("Sandbox exec/run enforce the shared Topology P-B and env guard", () => {
  it("box.exec rejects kiro-cli without calling client.exec", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "g1", image: PINNED_IMAGE });
    await assert.rejects(
      () => box.exec({ argv: ["kiro-cli", "run"] }),
      (err: unknown) => err instanceof TopologyViolationError
    );
    assert.equal(client.execCalls.length, 0);
  });

  it("box.run rejects Necromancer argv without calling client.exec", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "g2", image: PINNED_IMAGE });
    await assert.rejects(
      () => box.run({ argv: ["necromancer", "--serve"] }),
      (err: unknown) => err instanceof TopologyViolationError
    );
    assert.equal(client.execCalls.length, 0);
  });

  it("box.exec rejects a denylisted env var name without calling client.exec", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "g3", image: PINNED_IMAGE });
    await assert.rejects(
      () => box.exec({ argv: ["echo", "hi"], env: { GITHUB_TOKEN: "anything" } }),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.equal(client.execCalls.length, 0);
  });

  it("box.run rejects a denylisted env var value without calling client.exec", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "g4", image: PINNED_IMAGE });
    await assert.rejects(
      () => box.run({ argv: ["echo", "hi"], env: { GREETING: "ghp_secretvalue" } }),
      (err: unknown) => err instanceof SpecValidationError
    );
    assert.equal(client.execCalls.length, 0);
  });
});

describe("create() idempotency and restart re-attachment", () => {
  it("two concurrent creates with one key call createSandbox once", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const [a, b] = await Promise.all([
      backend.create({ idempotencyKey: "cc", image: PINNED_IMAGE }),
      backend.create({ idempotencyKey: "cc", image: PINNED_IMAGE }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(client.created.length, 1);
  });

  it("a fresh backend over the same client re-attaches instead of creating", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "re", image: PINNED_IMAGE });
    const backend2 = makeBackend(client, allProbesPass());
    const again = await backend2.create({ idempotencyKey: "re", image: PINNED_IMAGE });
    assert.equal(again.id, box.id);
    assert.equal(client.created.length, 1);
  });

  it("never re-attaches another key's sandbox when the client ignores the label filter", async () => {
    class UnfilteredClient extends FakeCloudClient {
      override async listSandboxes(): Promise<Array<{ id: string; labels?: Record<string, string> }>> {
        return super.listSandboxes();
      }
    }
    const client = new UnfilteredClient();
    const backend = makeBackend(client, allProbesPass());
    const first = await backend.create({ idempotencyKey: "key-a", image: PINNED_IMAGE });
    const backend2 = makeBackend(client, allProbesPass());
    const second = await backend2.create({ idempotencyKey: "key-b", image: PINNED_IMAGE });
    assert.notEqual(second.id, first.id);
    assert.equal(client.created.length, 2);
  });
});

describe("exec idempotency cache", () => {
  it("keys by sandbox id so the same key on two sandboxes runs twice", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const b1 = await backend.create({ idempotencyKey: "e1", image: PINNED_IMAGE });
    const b2 = await backend.create({ idempotencyKey: "e2", image: PINNED_IMAGE });
    await backend.execWithIdempotency(b1.id, { argv: ["echo"], idempotencyKey: "same" });
    await backend.execWithIdempotency(b2.id, { argv: ["echo"], idempotencyKey: "same" });
    assert.equal(client.execCalls.length, 2);
  });

  it("concurrent same-key calls share one client.exec", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "e3", image: PINNED_IMAGE });
    const [o1, o2] = await Promise.all([
      backend.execWithIdempotency(box.id, { argv: ["echo"], idempotencyKey: "ck" }),
      backend.execWithIdempotency(box.id, { argv: ["echo"], idempotencyKey: "ck" }),
    ]);
    assert.equal(o1, o2);
    assert.equal(client.execCalls.length, 1);
  });

  it("clears a sandbox's entries on destroy", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "e4", image: PINNED_IMAGE });
    await backend.execWithIdempotency(box.id, { argv: ["echo"], idempotencyKey: "dk" });
    assert.equal(client.execCalls.length, 1);
    await backend.destroy(box.id);
    await backend.execWithIdempotency(box.id, { argv: ["echo"], idempotencyKey: "dk" });
    assert.equal(client.execCalls.length, 2);
  });
});

describe("Cloud lifecycle: pull failures and stale sweeps", () => {
  it("destroys the sandbox and frees the slot when syncOut fails", async () => {
    const lc = new CloudSandboxLifecycle();
    const boom = new Error("sync failed");
    let destroyed = false;
    lc.register(
      "box-1",
      "run-1",
      {
        async destroy() {
          destroyed = true;
        },
      },
      {
        async syncOut() {
          throw boom;
        },
      }
    );
    const result = await lc.pullAndDestroy("box-1");
    assert.equal(destroyed, true);
    assert.equal(result.destroyed, true);
    assert.equal(result.pullError, boom);
    assert.equal(lc.get("box-1")!.state, "destroyed");
    // Slot released, so a new run can register.
    lc.register("box-2", "run-2");
  });

  it("expireStale processes every stale record even when one fails", async () => {
    let now = 1_000_000;
    const lc = new CloudSandboxLifecycle({ now: () => now });
    const destroyed: string[] = [];
    lc.register(
      "box-1",
      "run-1",
      {
        async destroy() {
          destroyed.push("box-1");
        },
      },
      {
        async syncOut() {
          throw new Error("boom");
        },
      }
    );
    lc.register(
      "box-2",
      "run-2",
      {
        async destroy() {
          destroyed.push("box-2");
        },
      },
      {
        async syncOut() {
          return { ok: true, transferred: [], skipped: [], rejected: [] };
        },
      }
    );
    now += DEFAULT_SANDBOX_TTL_MS + 1;
    const expired = await lc.expireStale();
    assert.deepEqual(expired.sort(), ["box-1", "box-2"]);
    assert.deepEqual(destroyed.sort(), ["box-1", "box-2"]);
    assert.ok(lc.errors.has("box-1"));
    assert.equal(lc.get("box-1")!.state, "expired");
    assert.equal(lc.get("box-2")!.state, "expired");
  });
});

describe("Host configuration: strict KIRO_CLI_BIN validation", () => {
  it("rejects a KIRO_CLI_BIN that does not exist", () => {
    assert.throws(
      () =>
        loadProductionHostConfig({
          env: { KIRO_CLI_BIN: "/opt/missing/kiro-cli" } as unknown as NodeJS.ProcessEnv,
          exists: () => false,
        }),
      (err: unknown) => err instanceof HostConfigError
    );
  });

  it("rejects a relative KIRO_CLI_BIN path", () => {
    assert.throws(
      () =>
        loadProductionHostConfig({
          env: { KIRO_CLI_BIN: "bin/kiro-cli" } as unknown as NodeJS.ProcessEnv,
          exists: () => true,
        }),
      (err: unknown) => err instanceof HostConfigError
    );
  });

  it("rejects a KIRO_CLI_BIN that is a directory", () => {
    assert.throws(
      () =>
        loadProductionHostConfig({
          env: { KIRO_CLI_BIN: "/opt/kiro-cli" } as unknown as NodeJS.ProcessEnv,
          exists: () => true,
          stat: () => ({ isFile: () => false }),
        }),
      (err: unknown) => err instanceof HostConfigError
    );
  });
});

describe("Cloud lifecycle: TTL, concurrency, snapshot, pull-before-destroy", () => {
  it("uses a default 1h TTL and a 24h hard cap", () => {
    assert.equal(DEFAULT_SANDBOX_TTL_MS, 3_600_000);
    assert.equal(MAX_SANDBOX_TTL_MS, 86_400_000);
    const lc = new CloudSandboxLifecycle();
    const rec = lc.register("box-1", "run-1");
    assert.equal(rec.ttlMs, DEFAULT_SANDBOX_TTL_MS);
    assert.equal(rec.expiresAt, rec.createdAt + DEFAULT_SANDBOX_TTL_MS);
  });

  it("renews TTL but refuses renewal past the 24h hard cap", () => {
    const lc = new CloudSandboxLifecycle();
    const rec = lc.register("box-1", "run-1");
    // Renew within cap.
    lc.renew("box-1", 3_600_000);
    assert.ok((lc.get("box-1")!.ttlMs) <= MAX_SANDBOX_TTL_MS);
    // Attempt to exceed the 24h cap.
    assert.throws(
      () => lc.renew("box-1", MAX_SANDBOX_TTL_MS),
      (err: unknown) => err instanceof TtlCapExceededError
    );
    void rec;
  });

  it("enforces the 5-run concurrency limit", () => {
    const lc = new CloudSandboxLifecycle();
    assert.equal(MAX_CONCURRENT_RUNS, 5);
    for (let i = 0; i < 5; i++) {
      lc.register(`box-${i}`, `run-${i}`);
    }
    assert.throws(
      () => lc.register("box-6", "run-6"),
      (err: unknown) => err instanceof ConcurrencyQuotaExceededError
    );
  });

  it("prohibits snapshot creation", async () => {
    const lc = new CloudSandboxLifecycle();
    await assert.rejects(
      () => lc.snapshot("box-1"),
      (err: unknown) => err instanceof SnapshotProhibitedError
    );
  });

  it("pulls artifacts and logs before destroy", async () => {
    const lc = new CloudSandboxLifecycle();
    const events: string[] = [];
    let destroyed = false;
    lc.register(
      "box-1",
      "run-1",
      {
        async destroy() {
          destroyed = true;
          events.push("destroy");
        },
      },
      {
        async syncOut() {
          events.push("syncOut");
          return { ok: true, transferred: [], skipped: [], rejected: [] };
        },
        async exportLogs() {
          events.push("exportLogs");
        },
      }
    );
    await lc.pullAndDestroy("box-1");
    assert.deepEqual(events, ["syncOut", "exportLogs", "destroy"]);
    assert.equal(destroyed, true);
    assert.equal(lc.get("box-1")!.state, "destroyed");
  });

  it("expires stale sandboxes cleanly, pulling first", async () => {
    let now = 1_000_000;
    const lc = new CloudSandboxLifecycle({ now: () => now });
    const events: string[] = [];
    lc.register(
      "box-1",
      "run-1",
      { async destroy() { events.push("destroy"); } },
      {
        async syncOut() {
          events.push("syncOut");
          return { ok: true, transferred: [], skipped: [], rejected: [] };
        },
      }
    );
    now += DEFAULT_SANDBOX_TTL_MS + 1;
    const expired = await lc.expireStale();
    assert.deepEqual(expired, ["box-1"]);
    assert.deepEqual(events, ["syncOut", "destroy"]);
    assert.equal(lc.get("box-1")!.state, "expired");
    // Run slot released, so a new run can register.
    lc.register("box-2", "run-2");
  });
});

describe("Host configuration", () => {
  it("loads a validated production host config", () => {
    const cfg = loadProductionHostConfig({
      env: { HOME: "/home/prod", KIRO_CLI_BIN: "/home/prod/.local/bin/kiro-cli" } as unknown as NodeJS.ProcessEnv,
      exists: (p) => p === "/home/prod/.local/bin/kiro-cli",
    });
    assert.equal(cfg.topology, "P-B");
    assert.equal(cfg.ttlMs, DEFAULT_SANDBOX_TTL_MS);
    assert.equal(cfg.maxTtlMs, MAX_SANDBOX_TTL_MS);
    assert.equal(cfg.maxConcurrentRuns, MAX_CONCURRENT_RUNS);
    assert.ok(cfg.allowedEgressHosts.length > 0);
    assert.equal(cfg.kiroCliBinary, "/home/prod/.local/bin/kiro-cli");
  });

  it("strictly rejects missing kiro-cli binary", () => {
    assert.throws(
      () =>
        loadProductionHostConfig({
          env: { HOME: "/home/prod" } as unknown as NodeJS.ProcessEnv,
          exists: () => false,
        }),
      (err: unknown) => err instanceof HostConfigError
    );
  });

  it("rejects empty egress allowlist", () => {
    assert.throws(
      () =>
        loadProductionHostConfig({
          env: { KIRO_CLI_BIN: "/bin/kiro-cli" } as unknown as NodeJS.ProcessEnv,
          exists: (p) => p === "/bin/kiro-cli",
          allowedEgressHosts: [],
        }),
      (err: unknown) => err instanceof HostConfigError
    );
  });

  it("provides a daemon supervision descriptor confirming external Necromancer", () => {
    const d = daemonSupervisionDescriptor();
    assert.equal(d.daemon, "necromancer");
    assert.equal(d.runsOutsideCloudSandboxes, true);
    assert.equal(d.kiroCliRunsOnHost, true);
    assert.equal(d.topology, "P-B");
  });
});

describe("Remote sandbox labels reach the client", () => {
  it("persists merged labels so a fresh backend re-attaches from client storage", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({
      idempotencyKey: "lbl-1",
      image: PINNED_IMAGE,
      labels: { "git-graveyard.run-id": "run-9", custom: "v" },
    });
    // The spec handed to the client carries the merged labels, reserved last.
    const sent = client.created[0] as SandboxSpec & {
      labels?: Record<string, string>;
    };
    assert.equal(sent.labels?.["git-graveyard.managed"], "true");
    assert.equal(sent.labels?.["git-graveyard.idempotency-key"], "lbl-1");
    assert.equal(sent.labels?.["git-graveyard.run-id"], "run-9");
    assert.equal(sent.labels?.custom, "v");
    // The client stored exactly what it received.
    assert.deepEqual(client.labelsById.get(box.id), sent.labels);

    // A fresh backend re-attaches using only what the client stored.
    const backend2 = makeBackend(client, allProbesPass());
    const again = await backend2.create({ idempotencyKey: "lbl-1", image: PINNED_IMAGE });
    assert.equal(again.id, box.id);
    assert.equal(client.created.length, 1);
  });

  it("does not let spec.labels override the reserved labels", async () => {
    const client = new FakeCloudClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({
      idempotencyKey: "lbl-2",
      image: PINNED_IMAGE,
      labels: {
        "git-graveyard.managed": "false",
        "git-graveyard.idempotency-key": "spoofed",
      },
    });
    const stored = client.labelsById.get(box.id);
    assert.equal(stored?.["git-graveyard.managed"], "true");
    assert.equal(stored?.["git-graveyard.idempotency-key"], "lbl-2");
  });

  it("lets a create's own labels override the backend default labels", async () => {
    const client = new FakeCloudClient();
    const backend = new DockerCloudSandboxBackend({
      client,
      probes: allProbesPass(),
      networkPolicy: buildRunNetworkPolicy("run-labels-order"),
      labels: { team: "default" },
    });
    const box = await backend.create({
      idempotencyKey: "lbl-3",
      image: PINNED_IMAGE,
      labels: { team: "run" },
    });
    assert.equal(client.labelsById.get(box.id)?.team, "run");
  });
});

describe("Sandbox destroyed while createSandbox is in flight", () => {
  it("is neither cached nor returned", async () => {
    let backend!: DockerCloudSandboxBackend;
    class DestroyingClient extends FakeCloudClient {
      override async createSandbox(spec: SandboxSpec): Promise<{ id: string }> {
        const created = await super.createSandbox(spec);
        // A concurrent caller destroys the new sandbox before create() resumes.
        await backend.destroy(created.id);
        return created;
      }
    }
    const client = new DestroyingClient();
    backend = makeBackend(client, allProbesPass());
    await assert.rejects(
      backend.create({ idempotencyKey: "gone", image: PINNED_IMAGE }),
      (err: unknown) =>
        err instanceof SandboxDestroyedDuringCreateError && err.sandboxId === "box-1"
    );
    assert.equal(await backend.get("box-1"), undefined);
  });

  it("is refused when its destroy has started but not finished", async () => {
    let backend!: DockerCloudSandboxBackend;
    let finishDestroy!: () => void;
    let destroyStarted!: Promise<void>;
    class SlowDestroyClient extends FakeCloudClient {
      override async destroySandbox(id: string): Promise<void> {
        await new Promise<void>((resolve) => {
          finishDestroy = resolve;
        });
        return super.destroySandbox(id);
      }
      override async createSandbox(spec: SandboxSpec): Promise<{ id: string }> {
        const created = await super.createSandbox(spec);
        // A concurrent caller starts destroying the new sandbox; the remote
        // destroy is still running when createSandbox returns.
        destroyStarted = backend.destroy(created.id);
        return created;
      }
    }
    const client = new SlowDestroyClient();
    backend = makeBackend(client, allProbesPass());
    await assert.rejects(
      backend.create({ idempotencyKey: "half-gone", image: PINNED_IMAGE }),
      (err: unknown) => err instanceof SandboxDestroyedDuringCreateError
    );
    finishDestroy();
    await destroyStarted;
    assert.equal(await backend.get("box-1"), undefined);
  });

  it("keeps the in-flight mark until every overlapping destroy has finished", async () => {
    let calls = 0;
    let finishFirst!: () => void;
    class OverlapClient extends FakeCloudClient {
      override async destroySandbox(id: string): Promise<void> {
        calls += 1;
        if (calls === 2) throw new Error("second destroy failed");
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        return super.destroySandbox(id);
      }
    }
    const client = new OverlapClient();
    const backend = makeBackend(client, allProbesPass());
    const box = await backend.create({ idempotencyKey: "overlap", image: PINNED_IMAGE });
    // The first destroy waits on the remote; the overlapping second one fails.
    const first = backend.destroy(box.id);
    await assert.rejects(backend.destroy(box.id), /second destroy failed/);
    // The first destroy is still running: the sandbox must not be handed out.
    assert.equal(await backend.get(box.id), undefined);
    finishFirst();
    await first;
    assert.equal(await backend.get(box.id), undefined);
  });
});

describe("Destroyed sandbox is not re-cached during provision", () => {
  it("does not return or cache a sandbox destroyed while create() awaits the remote list", async () => {
    const client = new FakeCloudClient();
    // Pre-seed an existing remote sandbox S carrying the idempotency key.
    const S = "box-existing";
    client.files.set(S, new Map());
    client.labelsById.set(S, {
      "git-graveyard.managed": "true",
      "git-graveyard.idempotency-key": "K",
    });

    let releaseList!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const originalList = client.listSandboxes.bind(client);
    let listEntered = false;
    (
      client as unknown as {
        listSandboxes: (labels?: Record<string, string>) => Promise<
          Array<{ id: string; labels?: Record<string, string> }>
        >;
      }
    ).listSandboxes = async (labels?: Record<string, string>) => {
      listEntered = true;
      await gate;
      return originalList(labels);
    };

    const backend = makeBackend(client, allProbesPass());
    const createPromise = backend.create({ idempotencyKey: "K", image: PINNED_IMAGE });

    // Wait until provision has entered the delayed listSandboxes.
    while (!listEntered) {
      await new Promise((r) => setTimeout(r, 0));
    }

    // Attach S, then destroy it before the list resolves.
    const got = await backend.get(S);
    assert.equal(got?.id, S);
    await backend.destroy(S);

    releaseList();
    const result = await createPromise;

    // The destroyed S is neither returned nor cached; a new sandbox is created.
    assert.notEqual(result.id, S);
    assert.equal(client.created.length, 1);
    assert.equal(await backend.get(S), undefined);
  });
});

describe("Cloud lifecycle: log export after a failed sync", () => {
  it("exports logs even when syncOut fails, before destroy", async () => {
    const lc = new CloudSandboxLifecycle();
    const events: string[] = [];
    const syncErr = new Error("sync failed");
    const exportErr = new Error("export failed");
    lc.register(
      "box-1",
      "run-1",
      {
        async destroy() {
          events.push("destroy");
        },
      },
      {
        async syncOut() {
          events.push("syncOut");
          throw syncErr;
        },
        async exportLogs() {
          events.push("exportLogs");
          throw exportErr;
        },
      }
    );
    const result = await lc.pullAndDestroy("box-1");
    assert.deepEqual(events, ["syncOut", "exportLogs", "destroy"]);
    assert.equal(result.pullError, syncErr);
    assert.equal(result.exportError, exportErr);
    assert.equal(result.destroyed, true);
    assert.equal(lc.get("box-1")!.state, "destroyed");
  });
});
