import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactCollector,
  computeArtifactSha256,
  computeArtifactByteSize,
  verifyArtifactIntegrity,
  ARTIFACT_KINDS,
} from "../../lib/lifecycle/artifact-collector";
import type { EventEnvelope } from "../../lib/events/types";
import {
  createDeathCertificate,
  type DeathCertificate,
} from "../../lib/exhume/death-certificate";
import type { GitService, ExportAllPatchResult, ExportAllPatchOptions } from "../../lib/git/git-service";

test("artifact-collector: computeArtifactSha256 and byteSize", async (t) => {
  await t.test("computes deterministic sha256 for strings and buffers", () => {
    const text = "hello world\n";
    const hash1 = computeArtifactSha256(text);
    const hash2 = computeArtifactSha256(Buffer.from(text, "utf8"));
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  await t.test("computes correct byte size for ascii and multi-byte content", () => {
    const ascii = "plain ascii text";
    assert.equal(computeArtifactByteSize(ascii), 16);
    const buf = Buffer.from("test");
    assert.equal(computeArtifactByteSize(buf), 4);
  });
});

test("artifact-collector: full collection lifecycle and integrity", async (t) => {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "artifact-collector-test-")
  );

  t.after(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  const runId = "test-run-142";
  const artifactsDir = path.join(tmpDir, "artifacts");
  const emittedEvents: EventEnvelope[] = [];

  const collector = new ArtifactCollector({
    runId,
    artifactsDir,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    emit: (ev) => {
      emittedEvents.push(ev);
    },
  });

  await t.test("collectPatch writes all.patch and emits artifact.ready", async () => {
    const patchText = "diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old\n+new\n";
    const artifact = await collector.collectPatch(patchText);

    assert.equal(artifact.kind, "patch");
    assert.equal(artifact.fileName, "all.patch");
    assert.ok(fs.existsSync(artifact.path));
    assert.equal(artifact.byteSize, Buffer.byteLength(patchText, "utf8"));
    assert.equal(artifact.sha256, computeArtifactSha256(patchText));

    const readyEvent = emittedEvents.find(
      (e) => e.kind === "artifact.ready" && e.data.kind === "patch"
    );
    assert.ok(readyEvent);
    assert.equal(readyEvent.data.sha256, artifact.sha256);
    assert.equal(readyEvent.data.byteSize, artifact.byteSize);
  });

  await t.test("collectSpecBundle gathers requirements, design, tasks into bundle", async () => {
    const artifact = await collector.collectSpecBundle({
      requirements: "# Requirements\n",
      design: "# Design\n",
      tasks: "# Tasks\n",
    });

    assert.equal(artifact.kind, "spec");
    assert.equal(artifact.fileName, "spec.json");
    assert.ok(fs.existsSync(artifact.path));

    // Verify individual files in spec directory
    const reqPath = path.join(artifactsDir, "spec", "requirements.md");
    const desPath = path.join(artifactsDir, "spec", "design.md");
    const tskPath = path.join(artifactsDir, "spec", "tasks.md");
    assert.ok(fs.existsSync(reqPath));
    assert.ok(fs.existsSync(desPath));
    assert.ok(fs.existsSync(tskPath));

    const readyEvent = emittedEvents.find(
      (e) => e.kind === "artifact.ready" && e.data.kind === "spec"
    );
    assert.ok(readyEvent);
    assert.equal(readyEvent.data.sha256, artifact.sha256);
  });

  await t.test("collectCertificate stores DeathCertificate and verifies sha256", async () => {
    const mockCert = createDeathCertificate({
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      runId,
      primaryLanguage: "node",
      install: {
        step: "install",
        command: "npm install",
        status: "passed",
        exitCode: 0,
      },
      build: {
        step: "build",
        command: "npm run build",
        status: "passed",
        exitCode: 0,
      },
      test: {
        step: "test",
        command: "npm test",
        status: "passed",
        exitCode: 0,
      },
    });

    const artifact = await collector.collectCertificate(mockCert);
    assert.equal(artifact.kind, "certificate");
    assert.equal(artifact.fileName, "death-certificate.json");
    assert.ok(fs.existsSync(artifact.path));

    const content = await fs.promises.readFile(artifact.path, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.schemaVersion, "v1");
    assert.equal(parsed.runId, runId);
  });

  await t.test("collectReport stores structured report", async () => {
    const reportText = "# Run Report\n\nResurrected cleanly.\n";
    const artifact = await collector.collectReport(reportText);

    assert.equal(artifact.kind, "report");
    assert.equal(artifact.fileName, "report.md");
    assert.ok(fs.existsSync(artifact.path));
    assert.equal(artifact.sha256, computeArtifactSha256(reportText));
  });

  await t.test("collectEvents streams and writes events.ndjson", async () => {
    const sampleEvents: EventEnvelope[] = [
      {
        runId,
        seq: 1,
        ts: Date.now(),
        kind: "run.phase",
        actor: "necromancer",
        data: { phase: "queued", refs: [] },
      },
      {
        runId,
        seq: 2,
        ts: Date.now(),
        kind: "run.phase",
        actor: "necromancer",
        data: { phase: "done", refs: [] },
      },
    ];

    const artifact = await collector.collectEvents(sampleEvents);
    assert.equal(artifact.kind, "events");
    assert.equal(artifact.fileName, "events.ndjson");
    assert.ok(fs.existsSync(artifact.path));

    const lines = (await fs.promises.readFile(artifact.path, "utf8"))
      .trim()
      .split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).kind, "run.phase");
  });

  await t.test("getManifest returns all 5 artifacts ready", () => {
    const manifest = collector.getManifest();
    assert.equal(manifest.runId, runId);
    assert.equal(manifest.allReady, true);
    for (const kind of ARTIFACT_KINDS) {
      assert.ok(manifest.artifacts[kind]);
    }
  });

  await t.test("verifyIntegrity confirms sha256 integrity and catches tampering", async () => {
    for (const kind of ARTIFACT_KINDS) {
      const ok = await collector.verifyIntegrity(kind);
      assert.equal(ok, true, `Integrity failed for artifact ${kind}`);
    }

    const reportArtifact = collector.getArtifact("report");
    assert.ok(reportArtifact);

    // Make temporarily writable to tamper
    await fs.promises.chmod(reportArtifact.path, 0o644);
    await fs.promises.writeFile(
      reportArtifact.path,
      "tampered content\n",
      "utf8"
    );

    const tamperedOk = await collector.verifyIntegrity("report");
    assert.equal(tamperedOk, false);
  });
});

test("artifact-collector: GitService exportAllPatch integration", async (t) => {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "artifact-git-test-")
  );

  t.after(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  let exportedOptions: ExportAllPatchOptions | null = null;
  const mockGitService = {
    exportAllPatch: async (
      opts: ExportAllPatchOptions
    ): Promise<ExportAllPatchResult> => {
      exportedOptions = opts;
      const fakePatch = "diff --git a/file.ts b/file.ts\n";
      const sha256 = computeArtifactSha256(fakePatch);
      const byteSize = computeArtifactByteSize(fakePatch);
      if (opts.outputPath) {
        await fs.promises.writeFile(opts.outputPath, fakePatch, "utf8");
      }
      return {
        patch: fakePatch,
        sha256,
        byteSize,
        outputPath: opts.outputPath,
      };
    },
  } as unknown as GitService;

  const collector = new ArtifactCollector({
    runId: "git-test-run",
    artifactsDir: path.join(tmpDir, "artifacts"),
    gitService: mockGitService,
    baseSha: "base1234567890",
  });

  const artifact = await collector.collectPatch();
  assert.equal(artifact.kind, "patch");
  assert.equal(artifact.fileName, "all.patch");
  assert.ok(exportedOptions);
  assert.equal((exportedOptions as ExportAllPatchOptions).baseSha, "base1234567890");
  assert.ok(await collector.verifyIntegrity("patch"));
});
