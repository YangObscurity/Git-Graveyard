import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  computeDeathCertificateSha256,
  createDeathCertificate,
  serializeDeathCertificate,
} from "@/lib/exhume/death-certificate";
import type { EventInput } from "@/lib/events/event-store";
import type { PactTask } from "@/lib/pact/pact-parser";
import { renderPact } from "@/lib/pact/pact-renderer";
import {
  listRecordedRunsOnDisk,
  seedRecordedRunsIntoStores,
} from "@/lib/runs/recorded-runs-loader";
import type { RunRecord } from "@/lib/runs/run-store";
import { authorizeSimRequest } from "@/lib/runtime/diagnostics";
import {
  isSafeRunId,
  resolveEventStore,
  resolveRunStore,
} from "@/lib/runtime/store-context";
import { redactEvent, redactValue } from "@/lib/security/redactor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIM_STEPS = [
  "exhume",
  "certificate",
  "plan",
  "pact",
  "legion",
  "approval",
  "ask",
  "done_resurrected",
  "done_partial",
  "publish",
] as const;

type SimStep = (typeof SIM_STEPS)[number];

const createInviteSchema = z.object({
  action: z.literal("create_invite"),
  code: z.string().trim().min(1).optional(),
  allowedRunCount: z.number().int().positive().optional(),
  caps: z.record(z.string(), z.unknown()).nullable().optional(),
  pushFlag: z.boolean().optional(),
  label: z.string().optional(),
});

const stepRunSchema = z.object({
  action: z.literal("step_run"),
  runId: z.string().trim().min(1),
  step: z.enum(SIM_STEPS),
  url: z.string().trim().min(1).optional(),
  sha: z.string().trim().min(1).optional(),
});

const seedRecordedSchema = z.object({
  action: z.literal("seed_recorded_runs"),
});

const simBodySchema = z.discriminatedUnion("action", [
  createInviteSchema,
  stepRunSchema,
  seedRecordedSchema,
]);

function createSamplePactTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Update legacy dependencies and repair build script",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["package.json", "src/index.js"],
      filesInScope: ["package.json", "src/index.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 1,
    },
    {
      id: "T2",
      title: "Warden final check verification",
      role: "bonesetter",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 8,
    },
    {
      id: "T3",
      title: "Scribe report generation",
      role: "soul-stitcher",
      dependencies: ["T2"],
      depends: ["T2"],
      dependsOn: ["T2"],
      files: ["report/evidence.json"],
      filesInScope: ["report/evidence.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 15,
    },
    {
      id: "T4",
      title: "Grimoire gate verification",
      role: "bonesetter",
      dependencies: ["T3"],
      depends: ["T3"],
      dependsOn: ["T3"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 22,
    },
  ];
}

function appendRedacted(
  eventStore: ReturnType<typeof resolveEventStore>,
  input: EventInput
): void {
  const redacted = redactEvent(input as unknown as Record<string, unknown>);
  eventStore.append({
    runId: String(redacted.runId),
    kind: String(redacted.kind),
    actor: String(redacted.actor),
    data: (redacted.data as Record<string, unknown>) ?? { refs: [] },
    ts: typeof redacted.ts === "number" ? redacted.ts : undefined,
    skeletonId:
      typeof redacted.skeletonId === "string"
        ? redacted.skeletonId
        : redacted.skeletonId === null
        ? null
        : undefined,
    taskId:
      typeof redacted.taskId === "string"
        ? redacted.taskId
        : redacted.taskId === null
        ? null
        : undefined,
    attempt:
      typeof redacted.attempt === "number"
        ? redacted.attempt
        : redacted.attempt === null
        ? null
        : undefined,
  });
}

function removeFromAdmissionQueue(runId: string): void {
  const g = globalThis as unknown as {
    __admissionQueue?: Array<{ runId?: string; queuePosition?: number }>;
  };
  if (!Array.isArray(g.__admissionQueue)) {
    return;
  }
  const idx = g.__admissionQueue.findIndex((q) => q && q.runId === runId);
  if (idx >= 0) {
    g.__admissionQueue.splice(idx, 1);
    for (let i = 0; i < g.__admissionQueue.length; i++) {
      g.__admissionQueue[i].queuePosition = i + 1;
    }
  }
}

function resolveWritableSimArtifactsDir(runId: string, run: RunRecord): string {
  const meta =
    run.metadata && typeof run.metadata === "object"
      ? (run.metadata as Record<string, unknown>)
      : null;
  if (
    meta &&
    typeof meta.artifactsDir === "string" &&
    meta.artifactsDir.trim() &&
    !meta.artifactsDir.includes("[REDACTED]")
  ) {
    return path.resolve(meta.artifactsDir);
  }
  const runsRoot = process.env.RUNS_DIR
    ? path.resolve(process.env.RUNS_DIR)
    : path.join(os.tmpdir(), "git-graveyard-data", "runs");
  return path.resolve(runsRoot, runId, "artifacts");
}

function writeArtifactFile(
  dir: string,
  fileName: string,
  content: string
): { sha256: string; byteSize: number } {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.resolve(dir, fileName);
  if (!target.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error("Invalid artifact file path");
  }
  const buf = Buffer.from(content, "utf8");
  fs.writeFileSync(target, buf);
  return {
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    byteSize: buf.length,
  };
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEBUG_SIM !== "1") {
    return Response.json(
      {
        ok: false,
        code: "SIM_DISABLED_IN_PRODUCTION",
        error: "Debug simulation endpoint is disabled in production",
      },
      { status: 403 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    const authPre = authorizeSimRequest(request);
    if (!authPre.allowed) {
      return authPre.response;
    }
    return Response.json(
      { ok: false, code: "BAD_JSON", error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const bodyObj =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>)
      : undefined;

  const auth = authorizeSimRequest(request, bodyObj);
  if (!auth.allowed) {
    return auth.response;
  }

  if (!bodyObj) {
    return Response.json(
      { ok: false, code: "BAD_REQUEST", error: "Request body must be an object" },
      { status: 400 }
    );
  }

  const parsed = simBodySchema.safeParse(bodyObj);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        code: "VALIDATION_ERROR",
        error: "Invalid simulation request",
        issues: parsed.error.issues,
      },
      { status: 400 }
    );
  }

  const runStore = resolveRunStore(request);
  const eventStore = resolveEventStore(request, undefined, runStore);
  const data = parsed.data;

  if (data.action === "create_invite") {
    const code = data.code ?? `sim-${crypto.randomBytes(4).toString("hex")}`;
    const rec = runStore.createInviteCode({
      code,
      allowedRunCount: data.allowedRunCount ?? 5,
      caps: data.caps ?? { maxMinutes: 30, maxParallel: 2 },
      pushFlag: Boolean(data.pushFlag),
      label: data.label ?? "dev-sim",
    });

    return Response.json(
      {
        ok: true,
        action: "create_invite",
        code,
        allowedRunCount: rec.allowedRunCount,
        remainingRunCount: rec.remainingRunCount,
        caps: rec.caps,
        pushFlag: rec.pushFlag,
      },
      { status: 200 }
    );
  }

  if (data.action === "seed_recorded_runs") {
    const res = seedRecordedRunsIntoStores(runStore, eventStore, { force: true });
    const available = listRecordedRunsOnDisk();
    return Response.json(
      {
        ok: true,
        action: "seed_recorded_runs",
        seededRunIds: res.seededRunIds,
        alreadySeededRunIds: res.alreadySeededRunIds,
        availableOnDiskCount: available.length,
        skipped: res.skipped,
        ...(res.reason ? { reason: res.reason } : {}),
      },
      { status: 200 }
    );
  }

  // action === "step_run"
  const { runId, step } = data;
  if (!isSafeRunId(runId)) {
    return Response.json(
      { ok: false, code: "INVALID_RUN_ID", error: "Invalid runId" },
      { status: 400 }
    );
  }

  const now = Date.now();
  let run = runStore.getRun(runId);
  if (!run) {
    const cleanUrl = data.url ?? "https://github.com/git-graveyard/sim-fixture";
    const cleanSha = data.sha ?? "0123456789abcdef0123456789abcdef01234567";
    run = runStore.createRun({
      runId,
      url: cleanUrl,
      sha: cleanSha,
      phase: "queued",
      outcome: null,
      caps: { maxMinutes: 30, maxParallel: 2 },
      pushFlag: false,
      metadata: { simulated: true, queuedAt: now },
      createdAt: now,
      updatedAt: now,
    });
    if (eventStore.countEvents(runId) === 0) {
      appendRedacted(eventStore, {
        runId,
        kind: "run.queued",
        actor: "necromancer",
        data: {
          queuePosition: 1,
          url: cleanUrl,
          sha: cleanSha,
          backend: process.env.EXECUTION_BACKEND ?? "instabox-docker",
          refs: [],
        },
      });
    }
  }

  const oldPhase = run.phase;
  const sampleTasks = createSamplePactTasks();
  const sampleMarkdown = renderPact(sampleTasks);

  switch (step as SimStep) {
    case "exhume": {
      removeFromAdmissionQueue(runId);
      runStore.updateRun(runId, {
        phase: "exhume",
        queuePosition: null,
        startedAt: run.startedAt ?? now,
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.started",
        actor: "necromancer",
        data: { url: run.url, sha: run.sha, refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: oldPhase, to: "exhume", phase: "exhume", refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "command.started",
        actor: "exhumer",
        data: { step: "install", commandLine: "npm install", refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "command.result",
        actor: "exhumer",
        data: {
          step: "install",
          commandLine: "npm install",
          status: "failed",
          exitCode: 1,
          durationMs: 280,
          stderrTail: "ERR! Legacy lockfile resolution failed",
          refs: [],
        },
      });
      break;
    }

    case "certificate": {
      if (oldPhase === "queued") {
        removeFromAdmissionQueue(runId);
        runStore.updateRun(runId, {
          phase: "exhume",
          queuePosition: null,
          startedAt: run.startedAt ?? now,
        });
        appendRedacted(eventStore, {
          runId,
          kind: "run.phase",
          actor: "necromancer",
          data: { from: oldPhase, to: "exhume", phase: "exhume", refs: [] },
        });
      }
      const cert = createDeathCertificate({
        runId,
        baseSha: run.sha,
        repoUrl: run.url,
        primaryLanguage: "node",
        packageManager: "npm",
        install: {
          step: "install",
          command: "npm install",
          status: "failed",
          exitCode: 1,
          durationMs: 280,
        },
        build: {
          step: "build",
          command: "npm run build",
          status: "not run",
          exitCode: null,
        },
        test: {
          step: "test",
          command: "npm test",
          status: "not run",
          exitCode: null,
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "exhume.certificate",
        actor: "exhumer",
        data: {
          baseSha: cert.baseSha,
          healthy: cert.healthy,
          failureClasses: [...cert.failureClasses],
          sha256: cert.sha256,
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "grimoire.summary",
        actor: "grimoire",
        data: {
          primaryLanguage: "node",
          signalsCount: 1,
          refs: [],
        },
      });
      break;
    }

    case "plan": {
      removeFromAdmissionQueue(runId);
      runStore.updateRun(runId, {
        phase: "plan",
        queuePosition: null,
        startedAt: run.startedAt ?? now,
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: oldPhase, to: "plan", phase: "plan", refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "skeleton.raised",
        actor: "planner",
        skeletonId: "skel-planner-sim",
        data: {
          role: "Planner",
          agent: "planner",
          modelId: "claude-opus-5.5",
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "necromancer.decision",
        actor: "necromancer",
        data: {
          decision: "Drafting resurrection Pact",
          reason: "Identified failing baseline install and test targets",
          refs: [],
        },
      });
      break;
    }

    case "pact": {
      removeFromAdmissionQueue(runId);
      runStore.updateRun(runId, {
        phase: "pact_review",
        queuePosition: null,
        startedAt: run.startedAt ?? now,
        metadata: {
          ...(run.metadata ?? {}),
          pact: sampleMarkdown,
          pactTasks: sampleTasks,
          pactVersion: 1,
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: oldPhase, to: "pact_review", phase: "pact_review", refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.clock",
        actor: "necromancer",
        data: { action: "pause", phase: "pact_review", refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "pact.drafted",
        actor: "planner",
        data: {
          pactVersion: 1,
          tasks: sampleTasks,
          markdown: sampleMarkdown,
          refs: [],
        },
      });
      break;
    }

    case "legion": {
      removeFromAdmissionQueue(runId);
      runStore.updateRun(runId, {
        phase: "legion",
        queuePosition: null,
        startedAt: run.startedAt ?? now,
      });
      appendRedacted(eventStore, {
        runId,
        kind: "pact.approved",
        actor: "user",
        data: {
          pactVersion: 1,
          approvedTaskIds: sampleTasks.map((t) => t.id),
          budget: { maxMinutes: 30, maxParallel: 2 },
          caps: { maxMinutes: 30, maxParallel: 2 },
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: { from: oldPhase, to: "legion", phase: "legion", refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.clock",
        actor: "necromancer",
        data: { action: "resume", phase: "legion", refs: [] },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "skeleton.raised",
        actor: "bonesetter",
        skeletonId: "skel-bonesetter-sim-1",
        taskId: "T1",
        attempt: 1,
        data: {
          role: "Bonesetter",
          agent: "bonesetter",
          modelId: "claude-sonnet-5.5",
          worktreeRoot: "wt-T1",
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "task.state",
        actor: "scheduler",
        taskId: "T1",
        attempt: 1,
        data: {
          taskId: "T1",
          state: "running",
          title: sampleTasks[0].title,
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "skeleton.tool_call",
        actor: "bonesetter",
        skeletonId: "skel-bonesetter-sim-1",
        taskId: "T1",
        data: {
          tool: "sandbox_exec",
          toolCallId: "sim-tool-1",
          arguments: { argv: ["npm", "test"] },
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "skeleton.tool_result",
        actor: "mcp_gateway",
        skeletonId: "skel-bonesetter-sim-1",
        taskId: "T1",
        data: {
          toolCallId: "sim-tool-1",
          status: "completed",
          result: { exit_code: 0, stdout_tail: "All simulated checks passed" },
          refs: [],
        },
      });
      break;
    }

    case "approval": {
      if (oldPhase === "queued") {
        removeFromAdmissionQueue(runId);
        runStore.updateRun(runId, {
          phase: "legion",
          queuePosition: null,
          startedAt: run.startedAt ?? now,
        });
        appendRedacted(eventStore, {
          runId,
          kind: "run.phase",
          actor: "necromancer",
          data: { from: oldPhase, to: "legion", phase: "legion", refs: [] },
        });
      }
      appendRedacted(eventStore, {
        runId,
        kind: "approval.requested",
        actor: "mcp_gateway",
        skeletonId: "skel-bonesetter-sim-1",
        data: {
          approvalId: `sim-appr-${now}`,
          command: "npm install --legacy-peer-deps",
          cwd: ".",
          reason: "Command requires explicit owner approval",
          expiresAt: now + 300000,
          refs: [],
        },
      });
      break;
    }

    case "ask": {
      if (oldPhase === "queued") {
        removeFromAdmissionQueue(runId);
        runStore.updateRun(runId, {
          phase: "legion",
          queuePosition: null,
          startedAt: run.startedAt ?? now,
        });
        appendRedacted(eventStore, {
          runId,
          kind: "run.phase",
          actor: "necromancer",
          data: { from: oldPhase, to: "legion", phase: "legion", refs: [] },
        });
      }
      appendRedacted(eventStore, {
        runId,
        kind: "ask.raised",
        actor: "bonesetter",
        skeletonId: "skel-bonesetter-sim-1",
        taskId: "T1",
        data: {
          askId: `sim-ask-${now}`,
          question: "Keep legacy Node compatibility shim or drop deprecated option?",
          options: ["Keep shim", "Drop option", "Skip"],
          refs: [],
        },
      });
      break;
    }

    case "done_resurrected":
    case "done_partial": {
      const isResurrected = step === "done_resurrected";
      const outcome = isResurrected ? "resurrected" : "partial";
      removeFromAdmissionQueue(runId);

      appendRedacted(eventStore, {
        runId,
        kind: "task.state",
        actor: "warden",
        taskId: "T1",
        attempt: 1,
        data: {
          taskId: "T1",
          state: "merged",
          title: sampleTasks[0].title,
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "verdict",
        actor: "warden",
        taskId: "T1",
        data: {
          target: "T1",
          taskId: "T1",
          verdict: "approve",
          reasons: ["Simulated candidate checks passed cleanly"],
          refs: [],
        },
      });
      if (!isResurrected) {
        appendRedacted(eventStore, {
          runId,
          kind: "task.state",
          actor: "warden",
          taskId: "T2",
          attempt: 1,
          data: {
            taskId: "T2",
            state: "failed",
            title: "Repair legacy integration tests",
            refs: [],
          },
        });
        appendRedacted(eventStore, {
          runId,
          kind: "verdict",
          actor: "warden",
          taskId: "T2",
          data: {
            target: "T2",
            taskId: "T2",
            verdict: "reject",
            reasons: ["Repository integration test suite exited with code 1"],
            refs: [],
          },
        });
      }

      appendRedacted(eventStore, {
        runId,
        kind: "final_check.result",
        actor: "warden",
        data: {
          passed: isResurrected,
          installPassed: true,
          buildPassed: true,
          testsPassed: isResurrected,
          hasTests: true,
          refs: [],
        },
      });

      appendRedacted(eventStore, {
        runId,
        kind: "report.checked",
        actor: "scribe",
        data: {
          ok: true,
          passed: true,
          reading: isResurrected
            ? "Install, build, and repository tests passed after resurrection."
            : "Install and build passed; repository tests still fail.",
          refs: [],
        },
      });

      const artifactsDir = resolveWritableSimArtifactsDir(runId, run);
      const patchContent = [
        "diff --git a/package.json b/package.json",
        "index 1111111..2222222 100644",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1,4 +1,4 @@ Task: T1 Rule: M1",
        '-  "scripts": { "build": "legacy-build", "test": "exit 1" }',
        '+  "scripts": { "build": "node build.mjs", "test": "node test.mjs" }',
        "",
      ].join("\n");
      const specContent = JSON.stringify(
        {
          schemaVersion: "v1",
          runId,
          outcome,
          tasks: sampleTasks,
        },
        null,
        2
      );
      const reportContent = [
        `# Resurrection Report: ${runId}`,
        "",
        `- Outcome: ${outcome}`,
        `- Install: passed`,
        `- Build: passed`,
        `- Tests: ${isResurrected ? "passed" : "failed"}`,
        "",
      ].join("\n");
      const certObj = createDeathCertificate({
        runId,
        baseSha: run.sha,
        repoUrl: run.url,
        primaryLanguage: "node",
        packageManager: "npm",
        install: {
          step: "install",
          command: "npm install",
          status: "failed",
          exitCode: 1,
          durationMs: 280,
        },
        build: {
          step: "build",
          command: "npm run build",
          status: "not run",
          exitCode: null,
        },
        test: {
          step: "test",
          command: "npm test",
          status: "not run",
          exitCode: null,
        },
      });
      const certContent = serializeDeathCertificate({
        ...certObj,
        sha256: computeDeathCertificateSha256(certObj),
      });

      const patchMeta = writeArtifactFile(artifactsDir, "all.patch", patchContent);
      const specMeta = writeArtifactFile(artifactsDir, "spec.json", specContent);
      const reportMeta = writeArtifactFile(artifactsDir, "report.md", reportContent);
      const certMeta = writeArtifactFile(
        artifactsDir,
        "death-certificate.json",
        certContent
      );

      appendRedacted(eventStore, {
        runId,
        kind: "artifact.ready",
        actor: "necromancer",
        data: {
          kind: "patch",
          path: "artifacts/all.patch",
          sha256: patchMeta.sha256,
          byteSize: patchMeta.byteSize,
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "artifact.ready",
        actor: "necromancer",
        data: {
          kind: "spec",
          path: "artifacts/spec.json",
          sha256: specMeta.sha256,
          byteSize: specMeta.byteSize,
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "artifact.ready",
        actor: "necromancer",
        data: {
          kind: "report",
          path: "artifacts/report.md",
          sha256: reportMeta.sha256,
          byteSize: reportMeta.byteSize,
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "artifact.ready",
        actor: "necromancer",
        data: {
          kind: "certificate",
          path: "artifacts/death-certificate.json",
          sha256: certMeta.sha256,
          byteSize: certMeta.byteSize,
          refs: [],
        },
      });

      appendRedacted(eventStore, {
        runId,
        kind: "run.phase",
        actor: "necromancer",
        data: {
          from: oldPhase,
          to: "done",
          phase: "done",
          outcome,
          refs: [],
        },
      });
      appendRedacted(eventStore, {
        runId,
        kind: "run.done",
        actor: "necromancer",
        data: {
          phase: "done",
          outcome,
          reason: isResurrected
            ? "Simulated resurrection completed"
            : "Simulated partial resurrection completed",
          refs: [],
        },
      });

      const currentEvents = eventStore.getEvents(runId);
      const ndjson =
        currentEvents.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
      const eventsMeta = writeArtifactFile(artifactsDir, "events.ndjson", ndjson);
      appendRedacted(eventStore, {
        runId,
        kind: "artifact.ready",
        actor: "necromancer",
        data: {
          kind: "events",
          path: "artifacts/events.ndjson",
          sha256: eventsMeta.sha256,
          byteSize: eventsMeta.byteSize,
          refs: [],
        },
      });

      const beforeAfterRows = [
        {
          label: "Install",
          key: "install",
          before: { status: "failed", exitCode: 1, durationMs: 280 },
          after: { status: "passed", exitCode: 0, durationMs: 210 },
        },
        {
          label: "Build",
          key: "build",
          before: { status: "not run", exitCode: null },
          after: { status: "passed", exitCode: 0, durationMs: 180 },
        },
        {
          label: "Tests (repository's own)",
          key: "tests_repo",
          before: { status: "not run", exitCode: null },
          after: {
            status: isResurrected ? "passed" : "failed",
            exitCode: isResurrected ? 0 : 1,
            durationMs: 310,
          },
        },
      ];

      runStore.updateRun(runId, {
        phase: "done",
        outcome,
        queuePosition: null,
        startedAt: run.startedAt ?? now,
        endedAt: now,
        metadata: redactValue({
          ...(run.metadata ?? {}),
          beforeAfterRows,
        }),
      });
      break;
    }

    case "publish": {
      runStore.updateRun(runId, {
        isPublished: true,
        updatedAt: now,
      });
      appendRedacted(eventStore, {
        runId,
        kind: "admin.publish",
        actor: "admin",
        data: {
          publishedAt: now,
          source: "debug-sim",
          refs: [],
        },
      });
      break;
    }
  }

  const updatedRun = runStore.getRun(runId);
  return Response.json(
    {
      ok: true,
      action: "step_run",
      runId,
      step,
      phase: updatedRun?.phase ?? null,
      outcome: updatedRun?.outcome ?? null,
      isPublished: updatedRun?.isPublished ?? false,
      lastSeq: eventStore.getLatestSeq(runId),
    },
    { status: 200 }
  );
}
