// Test suite for Task 9.5: ACP session negotiation, verification, and lifecycle management
// Requirements: 14.18, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 16.7, 16.8, 16.9, 16.10, 16.12, 16.13, 16.14, 16.15, 16.16, 16.17, 16.21, 41.20, 41.21, 45.12

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  archiveSkeletonSessions,
  BONESETTER_MANIFEST_ALLOW_PATTERNS,
  BONESETTER_MANIFEST_ALLOW_RULE,
  buildSessionNewParams,
  createSkeletonRaisedEvent,
  formatTaskPrompt,
  getPolicyPresetForRole,
  verifySessionNegotiation,
} from "../../lib/supervisor/acp-session";
import {
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
} from "../../lib/supervisor/model-allowlist";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
} from "../../lib/supervisor/skeleton-supervisor";
import { getRequiredBrokerSettings } from "./fixtures";
import type {
  ChildProcessLike,
  SkeletonSupervisorEvent,
} from "../../lib/supervisor/types";

/**
 * Mock ChildProcess for tests to avoid spawning real OS processes.
 */
class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 8888;
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | string | null = null;
  public signalsSent: string[] = [];

  constructor() {
    super();
  }

  public kill(signal?: NodeJS.Signals | number | string): boolean {
    this.killed = true;
    this.signalsSent.push(String(signal ?? "SIGTERM"));
    return true;
  }

  public simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  public sendStdoutJson(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }
}

/**
 * Helper to simulate an ACP agent responding to JSON-RPC over stdio.
 */
function createMockAcpAgent(
  child: MockChildProcess,
  handlers?: {
    onInitialize?: (params: any) => any;
    onSessionNew?: (params: any) => any;
    onSessionPrompt?: (params: any) => any;
    onSessionCancel?: (params: any) => any;
    onSessionSteer?: (params: any) => any;
    onSessionLoad?: (params: any) => any;
  }
) {
  let stdinBuffer = "";

  child.stdin.on("data", (chunk: Buffer | string) => {
    stdinBuffer += chunk.toString("utf-8");
    let newlineIndex = stdinBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        try {
          const msg = JSON.parse(line);
          handleIncomingRequest(msg).catch(() => {});
        } catch {
          // Ignore parse errors
        }
      }
      newlineIndex = stdinBuffer.indexOf("\n");
    }
  });

  async function handleIncomingRequest(msg: any) {
    if (!msg || typeof msg !== "object" || !("id" in msg)) {
      return;
    }

    const { id, method, params } = msg;

    if (method === "initialize") {
      const res = handlers?.onInitialize
        ? await handlers.onInitialize(params)
        : {
            agentCapabilities: {
              streaming: true,
              _meta: {
                kiro: {
                  extensionMethods: ["_session/steer"],
                },
              },
            },
            extensionMethods: ["_session/steer"],
            mcpCapabilities: { http: true },
          };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    if (method === "session/new") {
      const res = handlers?.onSessionNew
        ? await handlers.onSessionNew(params)
        : {
            sessionId: "sess-mock-001",
            modeId: params?._meta?.kiro?.modeId ?? "planner",
            configOptions: [
              {
                id: "model",
                value: params?._meta?.kiro?.modelId ?? CLAUDE_OPUS_5_5_MODEL_ID,
              },
            ],
          };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    if (method === "session/load") {
      const res = handlers?.onSessionLoad
        ? await handlers.onSessionLoad(params)
        : {
            sessionId: params?.sessionId ?? "sess-loaded-001",
            status: "ok",
          };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    if (method === "session/prompt") {
      const res = handlers?.onSessionPrompt
        ? await handlers.onSessionPrompt(params)
        : {
            turnId: "turn-1",
            status: "complete",
            text: "Prompt processed",
          };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    if (method === "session/cancel") {
      const res = handlers?.onSessionCancel
        ? await handlers.onSessionCancel(params)
        : { status: "cancelled" };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    if (method === "_session/steer") {
      const res = handlers?.onSessionSteer
        ? await handlers.onSessionSteer(params)
        : { status: "steered" };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    child.sendStdoutJson({ jsonrpc: "2.0", id, result: { ok: true } });
  }
}

test("Task 9.5: Policy presets and Bonesetter manifest allow rule in session/new (Requirements 14.18, 16.8)", () => {
  // 1. Policy presets mapping
  assert.equal(getPolicyPresetForRole("planner"), "edit-workspace");
  assert.equal(getPolicyPresetForRole("soul-stitcher"), "edit-workspace");
  assert.equal(getPolicyPresetForRole("scribe"), "edit-workspace");
  assert.equal(getPolicyPresetForRole("exhumer"), "read-workspace");
  assert.equal(getPolicyPresetForRole("bonesetter"), "read-workspace");
  assert.equal(getPolicyPresetForRole("warden"), "read-workspace");

  // 2. Bonesetter manifest allow rule patterns
  assert.ok(BONESETTER_MANIFEST_ALLOW_PATTERNS.includes("**/package.json"));
  assert.ok(BONESETTER_MANIFEST_ALLOW_PATTERNS.includes("**/package-lock.json"));
  assert.ok(BONESETTER_MANIFEST_ALLOW_PATTERNS.includes("**/yarn.lock"));
  assert.ok(BONESETTER_MANIFEST_ALLOW_PATTERNS.includes("**/pyproject.toml"));
  assert.equal(BONESETTER_MANIFEST_ALLOW_RULE.capability, "fs_write");
  assert.equal(BONESETTER_MANIFEST_ALLOW_RULE.effect, "allow");

  // 3. buildSessionNewParams for Bonesetter includes manifest allow rule
  const bonesetterParams = buildSessionNewParams({
    cwd: "/data/runs/run-1/wt",
    role: "bonesetter",
    runId: "run-1",
    skeletonId: "skel-bonesetter",
    gatewayUrl: "/mcp-gateway",
    bearerToken: "token-bone-123",
  });

  assert.equal(bonesetterParams.cwd, "/data/runs/run-1/wt");
  assert.equal(bonesetterParams._meta.kiro.policyPreset, "read-workspace");
  assert.equal(bonesetterParams._meta.kiro.modeId, "bonesetter");
  assert.equal(bonesetterParams._meta.kiro.modelId, CLAUDE_SONNET_5_5_MODEL_ID);
  assert.ok(Array.isArray(bonesetterParams._meta.kiro.rules));
  assert.deepEqual(bonesetterParams._meta.kiro.manifestAllowRule, BONESETTER_MANIFEST_ALLOW_RULE);

  // 4. MCP Gateway bearer token in headers
  assert.equal(bonesetterParams.mcpServers.length, 1);
  assert.equal(bonesetterParams.mcpServers[0].headers?.Authorization, "Bearer token-bone-123");
});

test("Task 9.5: Planner additionalDirectories contains read-only snapshot (Requirement 16.7)", () => {
  const plannerParams = buildSessionNewParams({
    cwd: "/data/runs/run-1/wt",
    role: "planner",
    runId: "run-1",
    skeletonId: "skel-planner",
    snapshotDir: "/data/runs/run-1/snapshot",
  });

  assert.equal(plannerParams._meta.kiro.policyPreset, "edit-workspace");
  assert.equal(plannerParams._meta.kiro.modeId, "planner");
  assert.equal(plannerParams._meta.kiro.modelId, CLAUDE_OPUS_5_5_MODEL_ID);
  assert.ok(Array.isArray(plannerParams.additionalDirectories));
  assert.ok(plannerParams.additionalDirectories.includes("/data/runs/run-1/snapshot"));
});

test("Task 9.5: Session negotiation verification checks active model, mode and gateway (Requirements 15.5-15.8, 16.9)", async () => {
  // 1. Success case
  const successRes = await verifySessionNegotiation(
    {
      sessionId: "sess-valid-1",
      modeId: "warden",
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    },
    { role: "warden" }
  );
  assert.equal(successRes.ok, true);
  if (successRes.ok) {
    assert.equal(successRes.sessionId, "sess-valid-1");
    assert.equal(successRes.modelId, CLAUDE_OPUS_5_5_MODEL_ID);
    assert.equal(successRes.agent, "warden");
  }

  // 2. Model mismatch (model outside allowlist or wrong tier)
  const mismatchRes = await verifySessionNegotiation(
    {
      sessionId: "sess-bad-model",
      modeId: "warden",
      configOptions: [{ id: "model", value: "claude-haiku-5.5" }], // Warden expects Opus
    },
    { role: "warden" }
  );
  assert.equal(mismatchRes.ok, false);
  if (!mismatchRes.ok) {
    assert.equal(mismatchRes.reason, "model_mismatch");
  }

  // 3. Mode mismatch
  const modeMismatchRes = await verifySessionNegotiation(
    {
      sessionId: "sess-bad-mode",
      modeId: "bonesetter", // Expected warden
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    },
    { role: "warden" }
  );
  assert.equal(modeMismatchRes.ok, false);
  if (!modeMismatchRes.ok) {
    assert.equal(modeMismatchRes.reason, "mode_mismatch");
  }

  // 4. Gateway missing
  const gwMissingRes = await verifySessionNegotiation(
    {
      sessionId: "sess-gw-fail",
      modeId: "warden",
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    },
    {
      role: "warden",
      checkGateway: true,
      isGatewayConnected: () => false,
    }
  );
  assert.equal(gwMissingRes.ok, false);
  if (!gwMissingRes.ok) {
    assert.equal(gwMissingRes.reason, "gateway_missing");
  }

  // 5. skeleton.raised event payload
  const raisedEvt = createSkeletonRaisedEvent({
    runId: "run-test-1",
    skeletonId: "skel-test-1",
    role: "warden",
    sessionId: "sess-valid-1",
    modelId: CLAUDE_OPUS_5_5_MODEL_ID,
    agent: "warden",
  });
  assert.equal(raisedEvt.kind, "skeleton.raised");
  assert.equal(raisedEvt.sessionId, "sess-valid-1");
  assert.equal(raisedEvt.modelId, CLAUDE_OPUS_5_5_MODEL_ID);
  assert.equal(raisedEvt.agent, "warden");
});

test("Task 9.5: formatTaskPrompt and dispatchTask with tasks.md, death certificate, and Grimoire guidance (Requirement 16.21)", async () => {
  const formatted = formatTaskPrompt({
    taskText: "- [ ] 1.1 Migrate request to native fetch in lib/http.js",
    deathCertificateRows: [
      "| Step | Command | Status | Exit Code | Reason |",
      "| install | npm install | failed | 1 | Cannot resolve request |",
    ],
    grimoireGuidance: [
      "Rule M2: Replace request library calls with fetch or node-fetch",
    ],
  });

  assert.ok(formatted.includes("## Task Item (tasks.md)"));
  assert.ok(formatted.includes("1.1 Migrate request to native fetch"));
  assert.ok(formatted.includes("## Death Certificate Rows"));
  assert.ok(formatted.includes("Cannot resolve request"));
  assert.ok(formatted.includes("## Grimoire Guidance"));
  assert.ok(formatted.includes("Rule M2: Replace request library calls"));

  // Dispatch via SkeletonSupervisor.dispatchTask
  let receivedPromptText = "";
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionPrompt: (params) => {
      receivedPromptText = params.prompt;
      return { status: "complete", output: "All done" };
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-prompt-test",
    skeletonId: "skel-prompt-test",
    role: "soul-stitcher",
    cwd: "/data/runs/run-prompt-test/wt",
    quarantineDir: "/tmp/run-prompt-test-quarantine",
    cancelGracePeriodMs: 50,
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
  });

  await supervisor.raise();

  await supervisor.dispatchTask({
    taskText: "Task 1.1 instruction",
    deathCertificateRows: "death cert table",
    grimoireGuidance: "M2 guidance",
  });

  assert.ok(receivedPromptText.includes("Task 1.1 instruction"));
  assert.ok(receivedPromptText.includes("death cert table"));
  assert.ok(receivedPromptText.includes("M2 guidance"));

  await supervisor.finish();
});

test("Task 9.5: Steer delivers correction via _session/steer if advertised (Requirement 16.12)", async () => {
  let steerReceived = false;
  let steerText = "";
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionSteer: (params) => {
      steerReceived = true;
      steerText = params.text;
      return { ok: true };
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-steer-test",
    skeletonId: "skel-steer-test",
    role: "bonesetter",
    cwd: "/data/runs/run-steer-test/wt",
    quarantineDir: "/tmp/run-steer-test-quarantine",
    cancelGracePeriodMs: 50,
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
  });

  await supervisor.raise();
  await supervisor.steer("Please fix syntax in package.json");

  assert.equal(steerReceived, true);
  assert.equal(steerText, "Please fix syntax in package.json");

  await supervisor.finish();
});

test("Task 9.5: Steer fallback waits for tool completion, cancels, and reprompts when _session/steer is not advertised (Requirement 16.13)", async () => {
  let cancelReceived = false;
  let promptReceived = false;
  let repromptText = "";

  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onInitialize: () => ({
      agentCapabilities: {},
      extensionMethods: [], // _session/steer NOT advertised
    }),
    onSessionCancel: () => {
      cancelReceived = true;
      return { status: "cancelled" };
    },
    onSessionPrompt: (params) => {
      promptReceived = true;
      repromptText = params.prompt;
      return { status: "complete" };
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-steer-fallback",
    skeletonId: "skel-steer-fallback",
    role: "soul-stitcher",
    cwd: "/data/runs/run-steer-fallback/wt",
    quarantineDir: "/tmp/run-steer-fallback-quarantine",
    cancelGracePeriodMs: 50,
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
  });

  await supervisor.raise();
  await supervisor.steer("Correction without steer method");

  assert.equal(cancelReceived, true, "session/cancel should have been called");
  assert.equal(promptReceived, true, "new session/prompt should have been called");
  assert.equal(repromptText, "Correction without steer method");

  await supervisor.finish();
});

test("Task 9.5: Cancel sends session/cancel, waits for pending prompt, and signals process (Requirement 16.14)", async () => {
  let cancelDispatched = false;
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionCancel: () => {
      cancelDispatched = true;
      return { status: "cancelled" };
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-cancel-test",
    skeletonId: "skel-cancel-test",
    role: "exhumer",
    cwd: "/data/runs/run-cancel-test/wt",
    quarantineDir: "/tmp/run-cancel-test-quarantine",
    cancelGracePeriodMs: 50,
    cancelPromptTimeoutMs: 100,
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
  });

  await supervisor.raise();
  await supervisor.cancel("user_cancelled");

  assert.equal(cancelDispatched, true);
  assert.ok(mockChild.signalsSent.includes("SIGTERM"));
  assert.equal(supervisor.getState(), "terminated");

  await supervisor.finish();
});

test("Task 9.5: Single respawn on crash with session/load and continue instruction without lost prompt (Requirements 16.16, 16.17)", async () => {
  let spawns = 0;
  let loadedSessionId = "";
  let promptText = "";

  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionLoad: (params) => {
      loadedSessionId = params.sessionId;
      return { status: "loaded" };
    },
    onSessionPrompt: (params) => {
      promptText = params.prompt;
      return { status: "complete" };
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-crash-test",
    skeletonId: "skel-crash-test",
    role: "soul-stitcher",
    cwd: "/data/runs/run-crash-test/wt",
    quarantineDir: "/tmp/run-crash-test-quarantine",
    cancelGracePeriodMs: 50,
    spawnFn: () => {
      spawns++;
      return mockChild;
    },
    brokerOptions: getRequiredBrokerSettings(),
  });

  await supervisor.raise();
  assert.equal(spawns, 1);

  // Simulate process crash
  mockChild.simulateExit(1, "SIGSEGV");

  // Allow respawn to complete
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(spawns, 2, "Should have respawned once");
  assert.ok(loadedSessionId.length > 0, "session/load should have been sent");
  assert.equal(promptText, "continue from the current tree state");
  assert.equal(supervisor.getState(), "raised");

  await supervisor.finish();
});

test("Task 9.5: archiveSkeletonSessions archives sessions into run evidence and finish cleans up KIRO_HOME (Requirement 16.15)", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-test-archive-"));
  const runId = "run-archive-test";
  const skeletonId = "skel-scribe-01";

  // Create temporary sessions directory with mock session files
  const sessionsDir = path.join(tmpBase, runId, "homes", skeletonId, "kiro-home", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "session-1.json"), JSON.stringify({ state: "active" }), "utf-8");
  fs.writeFileSync(path.join(sessionsDir, "session-2.raw"), "stream output", "utf-8");

  // 1. Standalone archiveSkeletonSessions function
  const destDir = archiveSkeletonSessions({
    sessionsDir,
    runId,
    skeletonId,
    baseDir: tmpBase,
  });

  assert.ok(fs.existsSync(destDir));
  assert.ok(fs.existsSync(path.join(destDir, "session-1.json")));
  assert.ok(fs.existsSync(path.join(destDir, "session-2.raw")));

  // 2. Lifecycle finish with deleteKiroHomeOnFinish and archiveSessionsOnFinish
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild);

  const supervisor = createSkeletonSupervisor({
    runId,
    skeletonId,
    role: "scribe",
    cwd: path.join(tmpBase, runId, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, runId, "quarantine"),
    archiveSessionsOnFinish: true,
    deleteKiroHomeOnFinish: true,
    cancelGracePeriodMs: 50,
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
  });

  await supervisor.raise();
  const paths = supervisor.getPaths();

  // Create dummy session file before finish
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.sessionsDir, "final-session.json"), "{\"status\":\"done\"}", "utf-8");

  await supervisor.finish();

  assert.equal(supervisor.getState(), "terminated");
  // Sessions should be archived under evidence/sessions/<skeletonId>
  const evidenceSessionFile = path.join(
    tmpBase,
    runId,
    "evidence",
    "sessions",
    skeletonId,
    "final-session.json"
  );
  assert.ok(fs.existsSync(evidenceSessionFile), "Session file should be archived into run evidence");

  // kiroHomeDir should be deleted
  assert.equal(fs.existsSync(paths.kiroHomeDir), false, "KIRO_HOME should be deleted on finish");

  // Clean up test base
  fs.rmSync(tmpBase, { recursive: true, force: true });
});
