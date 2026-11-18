#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { InstaboxDockerBackend } from "../lib/backend/instabox-docker-backend";
import { EventStore } from "../lib/events/event-store";
import { LogStore } from "../lib/events/log-store";
import { GitService } from "../lib/git/git-service";
import { RunOrchestrator } from "../lib/orchestrator/run-orchestrator";
import { RunStore } from "../lib/runs/run-store";
import { RuntimeHost } from "../lib/runtime/runtime-host";
import { redactEvent, redactText } from "../lib/security/redactor";

interface CliArgs {
  repo: string;
  runId: string;
  outputDir: string;
  maxMinutes: number;
  maxParallel: number;
  sha: string;
  boxImage?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  let repo = "";
  let runId = "";
  let outputDir = "";
  let maxMinutes = 10;
  let maxParallel = 1;
  let sha = "HEAD";
  let boxImage: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo" && i + 1 < argv.length) {
      repo = argv[++i];
    } else if (arg === "--run-id" && i + 1 < argv.length) {
      runId = argv[++i];
    } else if (arg === "--output-dir" && i + 1 < argv.length) {
      outputDir = argv[++i];
    } else if (arg === "--max-minutes" && i + 1 < argv.length) {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) maxMinutes = parsed;
    } else if (arg === "--max-parallel" && i + 1 < argv.length) {
      const parsed = Number(argv[++i]);
      if (Number.isInteger(parsed) && parsed >= 1) maxParallel = parsed;
    } else if (arg === "--sha" && i + 1 < argv.length) {
      sha = argv[++i];
    } else if (arg === "--box-image" && i + 1 < argv.length) {
      boxImage = argv[++i];
    }
  }

  if (!repo || !runId) {
    throw new Error(
      "Usage: tsx scripts/run-live-resurrection.ts --repo <url> --run-id <id> [--output-dir <dir>] [--max-minutes 10] [--max-parallel 1] [--sha HEAD] [--box-image <image@sha256:...>]"
    );
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error(`Invalid --run-id '${runId}'; must match /^[a-zA-Z0-9._-]+$/`);
  }

  return {
    repo,
    runId,
    outputDir: outputDir
      ? path.resolve(outputDir)
      : path.resolve(process.cwd(), "output", "recorded-runs", runId),
    maxMinutes,
    maxParallel,
    sha,
    boxImage,
  };
}

function resolvePinnedBoxImage(explicit?: string): string {
  const candidate = explicit ?? process.env.INSTABOX_DOCKER_IMAGE ?? "node:22-bookworm";
  if (candidate.includes("@sha256:")) {
    return candidate;
  }
  try {
    const digest = execFileSync(
      "docker",
      ["inspect", "--format", "{{index .RepoDigests 0}}", candidate],
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (digest.includes("@sha256:")) {
      return digest;
    }
  } catch (err) {
    throw new Error(
      `Failed to resolve pinned @sha256 digest for Docker image '${candidate}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  throw new Error(
    `Docker image '${candidate}' has no RepoDigests; pass --box-image with @sha256:<64hex>`
  );
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sanitizeString(input: string, replacements: Array<[string, string]>): string {
  let out = redactText(input);
  for (const [needle, repl] of replacements) {
    if (needle && needle.length > 2) {
      out = out.split(needle).join(repl);
    }
  }
  // Redact common SSH/email/personal path leaks just in case
  out = out.replace(/\/data\/home\/[^\s"'`:/]+/g, "/home/user");
  out = out.replace(/\/home\/[^\s"'`:/]+/g, "/home/user");
  out = out.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (email) =>
    email.endsWith("@git-graveyard.local") || email.endsWith("@users.noreply.github.com")
      ? email
      : "[redacted-email]"
  );
  return out;
}

function sanitizeJsonValue(val: unknown, replacements: Array<[string, string]>): unknown {
  if (typeof val === "string") {
    return sanitizeString(val, replacements);
  }
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeJsonValue(item, replacements));
  }
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k === "inviteCodeHash" || k === "bearerToken" || k === "salt") {
        continue;
      }
      out[k] = sanitizeJsonValue(v, replacements);
    }
    return out;
  }
  return val;
}

function verifyZeroLeftoverContainers(runId: string): void {
  const byLabel = execFileSync(
    "docker",
    ["ps", "-a", "-q", "--filter", `label=git-graveyard.run-id=${runId}`],
    { encoding: "utf-8", timeout: 10000 }
  ).trim();
  const byName = execFileSync(
    "docker",
    ["ps", "-a", "-q", "--filter", `name=${runId}`],
    { encoding: "utf-8", timeout: 10000 }
  ).trim();
  if (byLabel || byName) {
    throw new Error(
      `Leftover Docker containers detected for run '${runId}': ${[byLabel, byName]
        .filter(Boolean)
        .join(", ")}`
    );
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const wallClockTimeoutMs = Math.round(args.maxMinutes * 60 * 1000);
  const boxImage = resolvePinnedBoxImage(args.boxImage);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `gg-live-${args.runId}-`));
  const runsDir = path.join(workRoot, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  const runStore = new RunStore({ path: path.join(workRoot, "runs.db") });
  const eventStore = new EventStore({ path: path.join(workRoot, "events.db") });
  const logStore = new LogStore({ dir: path.join(workRoot, "logs") });
  const backend = new InstaboxDockerBackend({
    settings: {
      maxTimeoutMs: wallClockTimeoutMs,
      housekeepingTimeoutMs: 60000,
    },
  });
  const host = new RuntimeHost({
    runStore,
    eventStore,
    logStore,
    backend,
    defaultTimeoutMs: Math.min(wallClockTimeoutMs, 180000),
    approvalWaitMs: 60000,
    skipReconcile: true,
  });
  const gitService = new GitService({ runsDir });
  const orchestrator = new RunOrchestrator({
    host,
    runStore,
    eventStore,
    logStore,
    gitService,
    runsDir,
    autoApprovePact: true,
    wallClockTimeoutMs,
    boxImage,
  });

  let runCompleted = false;

  try {
    const inviteCode = `live-${args.runId}-${crypto.randomBytes(4).toString("hex")}`;
    runStore.createInviteCode({
      code: inviteCode,
      allowedRunCount: 1,
      pushFlag: false,
      caps: {
        maxParallelTasks: args.maxParallel,
        runParallelCap: args.maxParallel,
        wallClockTimeoutMs,
      },
      label: `live-resurrection-${args.runId}`,
    });

    runStore.createRun({
      runId: args.runId,
      url: args.repo,
      sha: args.sha,
      pushFlag: false,
      inviteCode,
      caps: {
        maxParallelTasks: args.maxParallel,
        runParallelCap: args.maxParallel,
        wallClockTimeoutMs,
      },
    });
    runStore.useInviteCode(inviteCode);

    console.log(
      JSON.stringify({
        stage: "starting",
        runId: args.runId,
        repo: args.repo,
        maxMinutes: args.maxMinutes,
        maxParallel: args.maxParallel,
        boxImage,
      })
    );

    const handle = orchestrator.startRun(args.runId);
    const timeoutTimer = setTimeout(() => {
      void handle.stop(`Wall-clock limit of ${args.maxMinutes} minutes reached`);
    }, wallClockTimeoutMs + 15000);

    let finalResult;
    try {
      finalResult = await handle.promise;
      runCompleted = true;
    } finally {
      clearTimeout(timeoutTimer);
    }

    // Emit admin.publish after completion so History lists this run cleanly
    host.emitEvent({
      runId: args.runId,
      kind: "admin.publish",
      actor: "admin",
      data: {
        published: true,
        outcome: finalResult.outcome,
      },
    });
    runStore.updateRun(args.runId, { isPublished: true });

    const storedEvents = eventStore.getEvents(args.runId);
    const rawRun = runStore.getRun(args.runId);
    if (!rawRun) {
      throw new Error(`Run record '${args.runId}' missing from RunStore`);
    }

    await orchestrator.shutdown({ closeHost: true });

    verifyZeroLeftoverContainers(args.runId);

    const artifactsSrcDir = path.join(runsDir, args.runId, "artifacts");
    const requiredArtifacts = [
      "all.patch",
      "spec.json",
      "report.md",
      "events.ndjson",
      "death-certificate.json",
    ];
    for (const file of requiredArtifacts) {
      const fullPath = path.join(artifactsSrcDir, file);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Missing required artifact '${file}' in ${artifactsSrcDir}`);
      }
    }

    // Export clean redacted bundle
    fs.mkdirSync(path.join(args.outputDir, "artifacts"), { recursive: true });
    const replacements: Array<[string, string]> = [
      [workRoot, `/var/lib/git-graveyard`],
      [runsDir, `/var/lib/git-graveyard/runs`],
      [process.cwd(), `/workspace/git-graveyard`],
      [os.homedir(), `/home/user`],
      [os.tmpdir(), `/tmp`],
    ];

    const exportedArtifactHashes: Record<string, { sha256: string; bytes: number }> = {};
    for (const file of requiredArtifacts) {
      const rawContent = fs.readFileSync(path.join(artifactsSrcDir, file), "utf-8");
      const sanitizedContent = sanitizeString(rawContent, replacements);
      const destPath = path.join(args.outputDir, "artifacts", file);
      fs.writeFileSync(destPath, sanitizedContent, "utf-8");
      exportedArtifactHashes[file] = {
        sha256: sha256File(destPath),
        bytes: Buffer.byteLength(sanitizedContent, "utf-8"),
      };
    }

    const redactedEventsLines = storedEvents.map((ev) => {
      const redacted = redactEvent(ev as unknown as Record<string, unknown>);
      const clean = sanitizeJsonValue(redacted, replacements);
      return JSON.stringify(clean);
    });
    const eventsOutPath = path.join(args.outputDir, "events.ndjson");
    fs.writeFileSync(
      eventsOutPath,
      redactedEventsLines.join("\n") + (redactedEventsLines.length ? "\n" : ""),
      "utf-8"
    );
    // Keep artifacts/events.ndjson synchronized with the redacted event stream
    fs.writeFileSync(
      path.join(args.outputDir, "artifacts", "events.ndjson"),
      fs.readFileSync(eventsOutPath, "utf-8"),
      "utf-8"
    );
    exportedArtifactHashes["events.ndjson"] = {
      sha256: sha256File(path.join(args.outputDir, "artifacts", "events.ndjson")),
      bytes: fs.statSync(path.join(args.outputDir, "artifacts", "events.ndjson")).size,
    };

    const cleanRun = sanitizeJsonValue(
      {
        ...rawRun,
        isPublished: true,
        pushFlag: false,
        metadata: {
          ...(rawRun.metadata ?? {}),
          artifactHashes: exportedArtifactHashes,
        },
      },
      replacements
    );
    fs.writeFileSync(
      path.join(args.outputDir, "run.json"),
      JSON.stringify(cleanRun, null, 2) + "\n",
      "utf-8"
    );

    console.log(
      JSON.stringify({
        ok: true,
        runId: args.runId,
        outcome: finalResult.outcome,
        outputDir: args.outputDir,
        artifacts: exportedArtifactHashes,
        eventCount: storedEvents.length,
      })
    );
  } finally {
    if (!runCompleted) {
      try {
        await orchestrator.shutdown({ closeHost: true });
      } catch {}
    }
    try {
      runStore.close();
    } catch {}
    try {
      eventStore.close();
    } catch {}
    try {
      fs.rmSync(workRoot, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error("Live resurrection run failed:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
