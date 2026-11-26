import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EventEnvelope } from "../events/types";
import type { DeathCertificate } from "../exhume/death-certificate";
import {
  serializeDeathCertificate,
  computeDeathCertificateSha256,
} from "../exhume/death-certificate";
import type { GitService, ExportAllPatchResult } from "../git/git-service";

export type ArtifactKind =
  | "patch"
  | "spec"
  | "report"
  | "events"
  | "certificate";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "patch",
  "spec",
  "report",
  "events",
  "certificate",
] as const;

export interface StoredArtifact {
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly createdAt: number;
}

export interface ArtifactManifest {
  readonly runId: string;
  readonly artifactsDir: string;
  readonly artifacts: Record<ArtifactKind, StoredArtifact | null>;
  readonly allReady: boolean;
  readonly createdAt: number;
}

export type EmitEventFn = (event: EventEnvelope) => void | Promise<void>;

export interface ArtifactCollectorOptions {
  runId: string;
  artifactsDir?: string;
  baseRunsDir?: string;
  gitService?: GitService;
  baseSha?: string;
  emit?: EmitEventFn;
  now?: () => number;
  actor?: string;
  initialSeq?: number;
}

export interface SpecBundleInput {
  requirements?: string;
  design?: string;
  tasks?: string;
  specDir?: string;
  rawContent?: string | Buffer;
}

export interface CollectPatchInput {
  patch?: string | Buffer;
  gitService?: GitService;
  baseSha?: string;
  runDir?: string;
  gitDir?: string;
  integrationBranch?: string;
}

export interface CollectAllInputs {
  patch?: CollectPatchInput | string | Buffer;
  spec?: SpecBundleInput | string | Buffer;
  certificate?: DeathCertificate | string | Buffer;
  report?: string | Buffer | { markdown?: string; findings?: unknown };
  events?:
    | string
    | Buffer
    | readonly EventEnvelope[]
    | Iterable<EventEnvelope>
    | AsyncIterable<EventEnvelope>;
}

/**
 * Computes deterministic SHA-256 hex digest of string or buffer content.
 */
export function computeArtifactSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Computes byte size of string or buffer content.
 */
export function computeArtifactByteSize(content: string | Buffer): number {
  return Buffer.isBuffer(content)
    ? content.length
    : Buffer.byteLength(content, "utf8");
}

/**
 * Verifies sha256 hash against actual file bytes on disk.
 */
export async function verifyArtifactIntegrity(
  filePath: string,
  expectedSha256: string
): Promise<boolean> {
  try {
    const bytes = await fs.promises.readFile(filePath);
    const hash = computeArtifactSha256(bytes);
    return hash.toLowerCase() === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Sets file permission mode to read-only (0o444) to guarantee immutability.
 */
export async function makeFileImmutable(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o444);
  } catch {
    // Non-fatal if filesystem does not support chmod permissions
  }
}

/**
 * ArtifactCollector and sha256 integrity manager.
 * Requirement 26.10, 26.11, 26.12 / Task 14.2.
 */
export class ArtifactCollector {
  readonly runId: string;
  readonly artifactsDir: string;
  private readonly gitService?: GitService;
  private readonly defaultBaseSha?: string;
  private readonly emitFn: EmitEventFn;
  private readonly nowFn: () => number;
  private readonly actor: string;
  private seq: number;
  private readonly storedArtifacts: Map<ArtifactKind, StoredArtifact> =
    new Map();

  constructor(options: ArtifactCollectorOptions) {
    this.runId = options.runId;
    this.artifactsDir =
      options.artifactsDir ??
      path.join(options.baseRunsDir ?? "/data/runs", options.runId, "artifacts");
    this.gitService = options.gitService;
    this.defaultBaseSha = options.baseSha;
    this.emitFn = options.emit ?? (() => {});
    this.nowFn = options.now ?? Date.now;
    this.actor = options.actor ?? "necromancer";
    this.seq = typeof options.initialSeq === "number" ? options.initialSeq : 1;
  }

  /**
   * Ensures the artifacts directory exists.
   */
  async ensureDirectory(): Promise<void> {
    if (!fs.existsSync(this.artifactsDir)) {
      await fs.promises.mkdir(this.artifactsDir, { recursive: true });
    }
  }

  private async writeImmutableFile(
    fileName: string,
    content: string | Buffer
  ): Promise<{ filePath: string; sha256: string; byteSize: number }> {
    await this.ensureDirectory();
    const filePath = path.join(this.artifactsDir, fileName);

    // If file already exists and is read-only, make it temporarily writable before overwrite
    if (fs.existsSync(filePath)) {
      try {
        await fs.promises.chmod(filePath, 0o644);
      } catch {
        // Continue
      }
    }

    const sha256 = computeArtifactSha256(content);
    const byteSize = computeArtifactByteSize(content);

    await fs.promises.writeFile(filePath, content);
    await makeFileImmutable(filePath);

    return { filePath, sha256, byteSize };
  }

  private async emitArtifactReady(artifact: StoredArtifact): Promise<void> {
    const ts = this.nowFn();
    const envelope: EventEnvelope = {
      runId: this.runId,
      seq: this.seq++,
      ts,
      kind: "artifact.ready",
      actor: this.actor,
      data: {
        kind: artifact.kind,
        path: artifact.path,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
        refs: [],
      },
    };

    const res = this.emitFn(envelope);
    if (res && typeof (res as Promise<unknown>).then === "function") {
      await res;
    }
  }

  /**
   * Requirement 26.10: Export all.patch from base sha to Integration_Head via GitService
   * or persist provided patch string/buffer.
   */
  async collectPatch(
    input?: CollectPatchInput | string | Buffer
  ): Promise<StoredArtifact> {
    const fileName = "all.patch";
    let patchContent: string | Buffer = "";
    let sha256: string | undefined;
    let byteSize: number | undefined;

    if (typeof input === "string" || Buffer.isBuffer(input)) {
      patchContent = input;
    } else {
      const patchInput: CollectPatchInput =
        input && typeof input === "object" ? input : {};
      if (patchInput.patch) {
        patchContent = patchInput.patch;
      } else {
        const gs = patchInput.gitService ?? this.gitService;
        const bSha = patchInput.baseSha ?? this.defaultBaseSha;
        if (gs && bSha) {
          const outputPath = path.join(this.artifactsDir, fileName);
          await this.ensureDirectory();
          const patchResult: ExportAllPatchResult = await gs.exportAllPatch({
            runId: this.runId,
            baseSha: bSha,
            runDir: patchInput.runDir,
            gitDir: patchInput.gitDir,
            integrationBranch: patchInput.integrationBranch,
            outputPath,
          });
          patchContent = patchResult.patch;
          sha256 = patchResult.sha256;
          byteSize = patchResult.byteSize;
          await makeFileImmutable(outputPath);
          const artifact: StoredArtifact = {
            kind: "patch",
            path: outputPath,
            fileName,
            sha256,
            byteSize,
            createdAt: this.nowFn(),
          };
          this.storedArtifacts.set("patch", artifact);
          await this.emitArtifactReady(artifact);
          return artifact;
        }
      }
    }

    const written = await this.writeImmutableFile(fileName, patchContent);
    const artifact: StoredArtifact = {
      kind: "patch",
      path: written.filePath,
      fileName,
      sha256: written.sha256,
      byteSize: written.byteSize,
      createdAt: this.nowFn(),
    };

    this.storedArtifacts.set("patch", artifact);
    await this.emitArtifactReady(artifact);
    return artifact;
  }

  /**
   * Requirement 26.11: Gather spec bundle (requirements.md, design.md, tasks.md)
   * and persist immutably with sha256.
   */
  async collectSpecBundle(
    input?: SpecBundleInput | string | Buffer
  ): Promise<StoredArtifact> {
    const fileName = "spec.json";
    let requirements = "";
    let design = "";
    let tasks = "";
    let rawContent: string | Buffer | null = null;

    if (typeof input === "string" || Buffer.isBuffer(input)) {
      rawContent = input;
    } else if (input && typeof input === "object") {
      if (input.rawContent) {
        rawContent = input.rawContent;
      } else {
        if (input.specDir && fs.existsSync(input.specDir)) {
          const reqPath = path.join(input.specDir, "requirements.md");
          const desPath = path.join(input.specDir, "design.md");
          const tskPath = path.join(input.specDir, "tasks.md");

          if (fs.existsSync(reqPath)) {
            requirements = await fs.promises.readFile(reqPath, "utf8");
          }
          if (fs.existsSync(desPath)) {
            design = await fs.promises.readFile(desPath, "utf8");
          }
          if (fs.existsSync(tskPath)) {
            tasks = await fs.promises.readFile(tskPath, "utf8");
          }
        }
        if (input.requirements) requirements = input.requirements;
        if (input.design) design = input.design;
        if (input.tasks) tasks = input.tasks;
      }
    }

    // Write individual spec files under spec/ directory
    const specSubdir = path.join(this.artifactsDir, "spec");
    if (!fs.existsSync(specSubdir)) {
      await fs.promises.mkdir(specSubdir, { recursive: true });
    }

    if (requirements) {
      await fs.promises.writeFile(
        path.join(specSubdir, "requirements.md"),
        requirements,
        "utf8"
      );
    }
    if (design) {
      await fs.promises.writeFile(
        path.join(specSubdir, "design.md"),
        design,
        "utf8"
      );
    }
    if (tasks) {
      await fs.promises.writeFile(
        path.join(specSubdir, "tasks.md"),
        tasks,
        "utf8"
      );
    }

    const payload =
      rawContent !== null
        ? rawContent
        : JSON.stringify(
            {
              schemaVersion: "v1",
              runId: this.runId,
              files: {
                "requirements.md": requirements,
                "design.md": design,
                "tasks.md": tasks,
              },
            },
            null,
            2
          );

    const written = await this.writeImmutableFile(fileName, payload);
    const artifact: StoredArtifact = {
      kind: "spec",
      path: written.filePath,
      fileName,
      sha256: written.sha256,
      byteSize: written.byteSize,
      createdAt: this.nowFn(),
    };

    this.storedArtifacts.set("spec", artifact);
    await this.emitArtifactReady(artifact);
    return artifact;
  }

  /**
   * Requirement 26.11: Persist DeathCertificate immutably with sha256.
   */
  async collectCertificate(
    input?: DeathCertificate | string | Buffer
  ): Promise<StoredArtifact> {
    const fileName = "death-certificate.json";
    let payload: string | Buffer;

    if (typeof input === "string" || Buffer.isBuffer(input)) {
      payload = input;
    } else if (input && typeof input === "object") {
      payload = serializeDeathCertificate(input);
    } else {
      payload = JSON.stringify(
        {
          schemaVersion: "v1",
          baseSha: this.defaultBaseSha ?? "unknown",
          runId: this.runId,
          primaryLanguage: "unknown",
          rows: [],
          failureClasses: [],
          failures: [],
          sha256: computeDeathCertificateSha256({
            schemaVersion: "v1",
            baseSha: this.defaultBaseSha ?? "unknown",
            runId: this.runId,
            primaryLanguage: "unknown",
            rows: [],
            failureClasses: [],
            failures: [],
          }),
        },
        null,
        2
      );
    }

    const written = await this.writeImmutableFile(fileName, payload);
    const artifact: StoredArtifact = {
      kind: "certificate",
      path: written.filePath,
      fileName,
      sha256: written.sha256,
      byteSize: written.byteSize,
      createdAt: this.nowFn(),
    };

    this.storedArtifacts.set("certificate", artifact);
    await this.emitArtifactReady(artifact);
    return artifact;
  }

  /**
   * Requirement 26.11: Persist structured report from event findings immutably with sha256.
   */
  async collectReport(
    input?: string | Buffer | { markdown?: string; findings?: unknown }
  ): Promise<StoredArtifact> {
    const fileName = "report.md";
    let payload: string | Buffer;

    if (typeof input === "string" || Buffer.isBuffer(input)) {
      payload = input;
    } else if (input && typeof input === "object") {
      if (input.markdown) {
        payload = input.markdown;
      } else {
        payload = [
          `# Run Report: ${this.runId}`,
          "",
          "## Findings",
          "",
          input.findings ? JSON.stringify(input.findings, null, 2) : "No findings recorded.",
        ].join("\n");
      }
    } else {
      payload = `# Run Report: ${this.runId}\n\nNo report generated.\n`;
    }

    const written = await this.writeImmutableFile(fileName, payload);
    const artifact: StoredArtifact = {
      kind: "report",
      path: written.filePath,
      fileName,
      sha256: written.sha256,
      byteSize: written.byteSize,
      createdAt: this.nowFn(),
    };

    this.storedArtifacts.set("report", artifact);
    await this.emitArtifactReady(artifact);
    return artifact;
  }

  /**
   * Requirement 26.11: Stream / write events.ndjson immutably with sha256.
   */
  async collectEvents(
    input?:
      | string
      | Buffer
      | readonly EventEnvelope[]
      | Iterable<EventEnvelope>
      | AsyncIterable<EventEnvelope>
  ): Promise<StoredArtifact> {
    const fileName = "events.ndjson";
    let payload: string | Buffer;

    if (typeof input === "string" || Buffer.isBuffer(input)) {
      payload = input;
    } else if (input && Symbol.asyncIterator in Object(input)) {
      const chunks: string[] = [];
      for await (const event of input as AsyncIterable<EventEnvelope>) {
        chunks.push(JSON.stringify(event) + "\n");
      }
      payload = chunks.join("");
    } else if (input && Symbol.iterator in Object(input)) {
      const chunks: string[] = [];
      for (const event of input as Iterable<EventEnvelope>) {
        chunks.push(JSON.stringify(event) + "\n");
      }
      payload = chunks.join("");
    } else {
      payload = "";
    }

    const written = await this.writeImmutableFile(fileName, payload);
    const artifact: StoredArtifact = {
      kind: "events",
      path: written.filePath,
      fileName,
      sha256: written.sha256,
      byteSize: written.byteSize,
      createdAt: this.nowFn(),
    };

    this.storedArtifacts.set("events", artifact);
    await this.emitArtifactReady(artifact);
    return artifact;
  }

  /**
   * Assembles all five artifacts for the done phase.
   */
  async collectAll(inputs?: CollectAllInputs): Promise<ArtifactManifest> {
    await this.ensureDirectory();

    await this.collectPatch(inputs?.patch);
    await this.collectSpecBundle(inputs?.spec);
    await this.collectCertificate(inputs?.certificate);
    await this.collectReport(inputs?.report);
    await this.collectEvents(inputs?.events);

    return this.getManifest();
  }

  /**
   * Retrieves stored artifact by kind.
   */
  getArtifact(kind: ArtifactKind): StoredArtifact | undefined {
    return this.storedArtifacts.get(kind);
  }

  /**
   * Verifies the integrity of a stored artifact on disk.
   */
  async verifyIntegrity(kind: ArtifactKind): Promise<boolean> {
    const artifact = this.storedArtifacts.get(kind);
    if (!artifact) {
      return false;
    }
    return verifyArtifactIntegrity(artifact.path, artifact.sha256);
  }

  /**
   * Returns current manifest of all artifacts.
   */
  getManifest(): ArtifactManifest {
    const artifactsRecord: Record<ArtifactKind, StoredArtifact | null> = {
      patch: this.storedArtifacts.get("patch") ?? null,
      spec: this.storedArtifacts.get("spec") ?? null,
      report: this.storedArtifacts.get("report") ?? null,
      events: this.storedArtifacts.get("events") ?? null,
      certificate: this.storedArtifacts.get("certificate") ?? null,
    };

    const allReady = ARTIFACT_KINDS.every((k) => artifactsRecord[k] !== null);

    return {
      runId: this.runId,
      artifactsDir: this.artifactsDir,
      artifacts: artifactsRecord,
      allReady,
      createdAt: this.nowFn(),
    };
  }
}
