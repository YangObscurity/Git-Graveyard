// Test suite for SkeletonSupervisor (Task 9.3, 9.4, 9.5)
// Requirements: 14.1-14.4, 15.1-15.8, 16.1-16.21, 41.20, 41.21, 45.12

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
} from "../../lib/supervisor/model-allowlist";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
  SkeletonSupervisorError,
} from "../../lib/supervisor/skeleton-supervisor";
import { spawnSkeletonProcess } from "../../lib/supervisor/acp-client";
import type {
  ChildProcessLike,
  SkeletonSupervisorEvent,
  SpawnFunction,
  SpawnOptions,
} from "../../lib/supervisor/types";
import { PermissionBroker } from "../../lib/broker/permission-broker";
import { getRequiredBrokerSettings } from "./fixtures";

/**
 * Mock ChildProcess for tests so real OS processes are never spawned.
 */
class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 9999;
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
 * Helper to simulate an ACP agent speaking JSON-RPC over stdio.
 */
function createMockAcpAgent(child: MockChildProcess, handlers?: {
  onInitialize?: (params: any) => any;
  onSessionNew?: (params: any) => any;
  onSessionPrompt?: (params: any) => any;
  onSessionCancel?: (params: any) => any;
  onSessionLoad?: (params: any) => any;
}) {
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
          // Ignore
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
      const res = handlers?.onInitialize ? await handlers.onInitialize(params) : {
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
      const res = handlers?.onSessionNew ? await handlers.onSessionNew(params) : {
        sessionId: "sess-default-123",
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
      const res = handlers?.onSessionLoad ? await handlers.onSessionLoad(params) : {
        sessionId: params?.sessionId ?? "sess-loaded-123",
        status: "ok",
      };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    if (method === "session/prompt") {
      const res = handlers?.onSessionPrompt ? await handlers.onSessionPrompt(params) : {
        turnId: "turn-1",
        status: "complete",
        text: "Task completed successfully",
      };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    if (method === "session/cancel") {
      const res = handlers?.onSessionCancel ? await handlers.onSessionCancel(params) : {
        status: "cancelled",
      };
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: res });
      return;
    }

    // Default response
    child.sendStdoutJson({ jsonrpc: "2.0", id, result: { ok: true } });
  }
}

test("Requirement 16.1, 16.2: Spawns kiro-cli acp process with exact environment and skel user", async () => {
  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];
  let capturedOptions: any = null;

  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: (params) => ({
      sessionId: "sess-spawn-test",
      modeId: "planner",
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    }),
  });

  const mockSpawn: SpawnFunction = (command, args, options) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedOptions = options;
    return mockChild;
  };

  const supervisor = createSkeletonSupervisor({
    runId: "run-test-1",
    skeletonId: "skel-planner",
    role: "planner",
    cwd: "/data/runs/run-test-1/wt",
    quarantineDir: "/data/runs/run-test-1/quarantine",
    kiroApiKey: "ksk_mock_test_key_12345",
    spawnFn: mockSpawn,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await supervisor.raise();

  // Requirement 16.1: kiro-cli acp --agent-engine=v3 running as skel
  assert.equal(capturedCommand, "kiro-cli");
  assert.deepEqual(capturedArgs, ["acp", "--agent-engine=v3"]);
  assert.equal(capturedOptions?.user, "skel");

  // Requirement 16.2: Environment strictly set to exactly KIRO_API_KEY, KIRO_HOME, HOME, PATH
  assert.ok(capturedOptions?.env);
  const envKeys = Object.keys(capturedOptions.env).sort();
  assert.deepEqual(envKeys, ["HOME", "KIRO_API_KEY", "KIRO_HOME", "PATH"]);
  assert.equal(capturedOptions.env.KIRO_API_KEY, "ksk_mock_test_key_12345");
  assert.ok(capturedOptions.env.KIRO_HOME.includes("skel-planner"));
  assert.ok(capturedOptions.env.HOME.includes("skel-planner"));

  await supervisor.finish();
});

test("Requirement 14.18, 16.8: Assigns policy preset edit-workspace for Planner/Soul-stitcher/Scribe and read-workspace for Exhumer/Bonesetter/Warden", async () => {
  const presetsByRole: Record<string, string> = {};

  const roles = [
    "planner",
    "soul-stitcher",
    "scribe",
    "exhumer",
    "bonesetter",
    "warden",
  ];

  for (const role of roles) {
    let capturedPreset = "";
    const mockChild = new MockChildProcess();
    createMockAcpAgent(mockChild, {
      onSessionNew: (params) => {
        capturedPreset = params?._meta?.kiro?.policyPreset;
        return {
          sessionId: `sess-${role}`,
          modeId: role,
          configOptions: [
            {
              id: "model",
              value: role === "planner" || role === "warden"
                ? CLAUDE_OPUS_5_5_MODEL_ID
                : role === "exhumer" || role === "scribe"
                ? CLAUDE_HAIKU_5_5_MODEL_ID
                : CLAUDE_SONNET_5_5_MODEL_ID,
            },
          ],
        };
      },
    });

    const supervisor = createSkeletonSupervisor({
      runId: "run-preset-test",
      skeletonId: `skel-${role}`,
      role,
      cwd: "/data/runs/run-preset-test/wt",
      quarantineDir: "/data/runs/run-preset-test/quarantine",
      kiroApiKey: "ksk_test_key",
      spawnFn: () => mockChild,
      brokerOptions: getRequiredBrokerSettings(),
      cancelGracePeriodMs: 5000,
    });

    await supervisor.raise();
    presetsByRole[role] = capturedPreset;
    await supervisor.finish();
  }

  assert.equal(presetsByRole.planner, "edit-workspace");
  assert.equal(presetsByRole["soul-stitcher"], "edit-workspace");
  assert.equal(presetsByRole.scribe, "edit-workspace");
  assert.equal(presetsByRole.exhumer, "read-workspace");
  assert.equal(presetsByRole.bonesetter, "read-workspace");
  assert.equal(presetsByRole.warden, "read-workspace");
});

test("Requirement 15.3, 15.4: Default model tiers and Soul-stitcher hard escalation", async () => {
  let capturedModelHardNo = "";
  let capturedModelHardYes = "";

  // 1. Soul-stitcher with hard: false/omitted -> Claude Sonnet 5.5
  const mockChild1 = new MockChildProcess();
  createMockAcpAgent(mockChild1, {
    onSessionNew: (params) => {
      capturedModelHardNo = params?._meta?.kiro?.modelId;
      return {
        sessionId: "sess-ss-normal",
        modeId: "soul-stitcher",
        configOptions: [{ id: "model", value: CLAUDE_SONNET_5_5_MODEL_ID }],
      };
    },
  });

  const sup1 = createSkeletonSupervisor({
    runId: "run-model-tier",
    skeletonId: "skel-ss-normal",
    role: "soul-stitcher",
    cwd: "/data/runs/run-model-tier/wt",
    quarantineDir: "/data/runs/run-model-tier/quarantine",
    spawnFn: () => mockChild1,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await sup1.raise();
  assert.equal(capturedModelHardNo, CLAUDE_SONNET_5_5_MODEL_ID);
  await sup1.finish();

  // 2. Soul-stitcher with hard: yes -> Claude Opus 5.5
  const mockChild2 = new MockChildProcess();
  createMockAcpAgent(mockChild2, {
    onSessionNew: (params) => {
      capturedModelHardYes = params?._meta?.kiro?.modelId;
      return {
        sessionId: "sess-ss-hard",
        modeId: "soul-stitcher",
        configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
      };
    },
  });

  const sup2 = createSkeletonSupervisor({
    runId: "run-model-tier",
    skeletonId: "skel-ss-hard",
    role: "soul-stitcher",
    hard: "yes",
    cwd: "/data/runs/run-model-tier/wt",
    quarantineDir: "/data/runs/run-model-tier/quarantine",
    spawnFn: () => mockChild2,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await sup2.raise();
  assert.equal(capturedModelHardYes, CLAUDE_OPUS_5_5_MODEL_ID);
  await sup2.finish();
});

test("Requirement 15.5, 15.6, 41.20: Fails with model_mismatch before any prompt when active model is not allowed or differs from role tier", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-mismatch-1",
      modeId: "planner",
      configOptions: [
        {
          id: "model",
          // Planner requires Claude Opus 5.5, returning Haiku 5.5
          value: CLAUDE_HAIKU_5_5_MODEL_ID,
        },
      ],
    }),
  });

  const events: SkeletonSupervisorEvent[] = [];
  const supervisor = createSkeletonSupervisor({
    runId: "run-mismatch-test",
    skeletonId: "skel-planner-mismatch",
    role: "planner",
    cwd: "/data/runs/run-mismatch-test/wt",
    quarantineDir: "/data/runs/run-mismatch-test/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
    onEvent: (e) => {
      events.push(e);
    },
  });

  await assert.rejects(
    async () => {
      await supervisor.raise();
    },
    (err: any) => {
      assert.equal(err.reason, "model_mismatch");
      return true;
    }
  );

  assert.equal(supervisor.getState(), "failed");
  assert.equal(supervisor.getFailureReason(), "model_mismatch");

  // Attempting to prompt must fail before sending any prompt
  await assert.rejects(
    async () => {
      await supervisor.prompt("Test prompt text");
    },
    (err: any) => {
      assert.equal(err.reason, "model_mismatch");
      return true;
    }
  );

  // Failed event was emitted
  const failedEvent = events.find((e) => e.kind === "skeleton.failed");
  assert.ok(failedEvent);
  assert.equal(failedEvent.reason, "model_mismatch");

  await supervisor.finish();
});

test("Requirement 15.2, 15.6: Fails with model_mismatch when active model is Auto", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-auto-test",
      modeId: "bonesetter",
      configOptions: [
        {
          id: "model",
          value: "auto",
        },
      ],
    }),
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-auto-test",
    skeletonId: "skel-bonesetter-auto",
    role: "bonesetter",
    cwd: "/data/runs/run-auto-test/wt",
    quarantineDir: "/data/runs/run-auto-test/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await assert.rejects(
    async () => {
      await supervisor.raise();
    },
    (err: any) => {
      assert.equal(err.reason, "model_mismatch");
      return true;
    }
  );

  assert.equal(supervisor.getFailureReason(), "model_mismatch");
  await supervisor.finish();
});

test("Requirement 15.7: Fails with mode_mismatch before any prompt when active mode does not match role", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-wrong-mode",
      modeId: "exhumer", // expected planner
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    }),
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-mode-test",
    skeletonId: "skel-planner-wrong-mode",
    role: "planner",
    cwd: "/data/runs/run-mode-test/wt",
    quarantineDir: "/data/runs/run-mode-test/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await assert.rejects(
    async () => {
      await supervisor.raise();
    },
    (err: any) => {
      assert.equal(err.reason, "mode_mismatch");
      return true;
    }
  );

  assert.equal(supervisor.getFailureReason(), "mode_mismatch");
  await supervisor.finish();
});

test("Requirement 16.9, 41.21: Fails with gateway_missing when MCP gateway check fails", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-gateway-test",
      modeId: "warden",
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    }),
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-gw-test",
    skeletonId: "skel-warden-gw",
    role: "warden",
    cwd: "/data/runs/run-gw-test/wt",
    quarantineDir: "/data/runs/run-gw-test/quarantine",
    checkMcpGateway: true,
    isGatewayConnected: () => false, // simulates disconnected MCP gateway
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await assert.rejects(
    async () => {
      await supervisor.raise();
    },
    (err: any) => {
      assert.equal(err.reason, "gateway_missing");
      return true;
    }
  );

  assert.equal(supervisor.getFailureReason(), "gateway_missing");
  await supervisor.finish();
});

test("Requirement 15.8: Emits skeleton.raised event with verified modelId, sessionId, and agent", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-raised-999",
      modeId: "planner",
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    }),
  });

  const raisedEvents: any[] = [];
  const supervisor = createSkeletonSupervisor({
    runId: "run-raised-test",
    skeletonId: "skel-planner-raised",
    role: "planner",
    cwd: "/data/runs/run-raised-test/wt",
    quarantineDir: "/data/runs/run-raised-test/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
    onEvent: (event) => {
      if (event.kind === "skeleton.raised") {
        raisedEvents.push(event);
      }
    },
  });

  const result = await supervisor.raise();

  assert.equal(result.kind, "skeleton.raised");
  assert.equal(result.sessionId, "sess-raised-999");
  assert.equal(result.modelId, CLAUDE_OPUS_5_5_MODEL_ID);
  assert.equal(result.agent, "planner");
  assert.equal(result.skeletonId, "skel-planner-raised");
  assert.equal(result.runId, "run-raised-test");

  assert.equal(raisedEvents.length, 1);
  assert.deepEqual(raisedEvents[0], result);

  await supervisor.finish();
});

test("Requirement 16.6: Fails with auth_failed when initialize asks for login", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onInitialize: () => ({
      status: "login_required",
      authMethods: ["login"],
      loginRequired: true,
    }),
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-auth-test",
    skeletonId: "skel-auth-fail",
    role: "scribe",
    cwd: "/data/runs/run-auth-test/wt",
    quarantineDir: "/data/runs/run-auth-test/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await assert.rejects(
    async () => {
      await supervisor.raise();
    },
    (err: any) => {
      assert.equal(err.reason, "auth_failed");
      return true;
    }
  );

  assert.equal(supervisor.getFailureReason(), "auth_failed");
  await supervisor.finish();
});

test("Requirement 16.3, 16.4: Answers unknown client requests and fs/* / terminal/* with JSON-RPC error", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-rpc-test",
      modeId: "scribe",
      configOptions: [{ id: "model", value: CLAUDE_HAIKU_5_5_MODEL_ID }],
    }),
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-rpc-test",
    skeletonId: "skel-scribe-rpc",
    role: "scribe",
    cwd: "/data/runs/run-rpc-test/wt",
    quarantineDir: "/data/runs/run-rpc-test/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await supervisor.raise();

  // Test fs/read request from agent
  const fsErrorPromise = new Promise<any>((resolve) => {
    let buf = "";
    mockChild.stdin.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf-8");
      if (buf.includes("\n")) {
        const line = buf.slice(0, buf.indexOf("\n")).trim();
        buf = buf.slice(buf.indexOf("\n") + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 701) {
            resolve(msg);
          }
        } catch {}
      }
    });
  });

  mockChild.sendStdoutJson({
    jsonrpc: "2.0",
    id: 701,
    method: "fs/read",
    params: { path: "/etc/passwd" },
  });

  const fsErrorReply = await fsErrorPromise;
  assert.ok(fsErrorReply.error);
  assert.equal(fsErrorReply.error.code, -32601);

  // Test unknown client method
  const unknownErrorPromise = new Promise<any>((resolve) => {
    let buf = "";
    mockChild.stdin.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf-8");
      if (buf.includes("\n")) {
        const line = buf.slice(0, buf.indexOf("\n")).trim();
        buf = buf.slice(buf.indexOf("\n") + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 702) {
            resolve(msg);
          }
        } catch {}
      }
    });
  });

  mockChild.sendStdoutJson({
    jsonrpc: "2.0",
    id: 702,
    method: "someUnknownMethod",
    params: {},
  });

  const unknownReply = await unknownErrorPromise;
  assert.ok(unknownReply.error);
  assert.equal(unknownReply.error.code, -32601);

  await supervisor.finish();
});

test("Requirement 16.3, 18.1-18.5: Forwards session/request_permission through PermissionBroker and returns decision", async () => {
  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-perm-test",
      modeId: "planner",
      configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
    }),
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-perm-test",
    skeletonId: "skel-planner-perm",
    role: "planner",
    cwd: "/data/runs/run-perm-test/wt",
    quarantineDir: "/data/runs/run-perm-test/quarantine",
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
    spawnFn: () => mockChild,
  });

  await supervisor.raise();

  // Agent asks permission to execute allowed Planner tool report_task_result
  const permPromise = new Promise<any>((resolve) => {
    let buf = "";
    mockChild.stdin.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf-8");
      while (buf.includes("\n")) {
        const line = buf.slice(0, buf.indexOf("\n")).trim();
        buf = buf.slice(buf.indexOf("\n") + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 888) {
            resolve(msg);
          }
        } catch {}
      }
    });
  });

  mockChild.sendStdoutJson({
    jsonrpc: "2.0",
    id: 888,
    method: "session/request_permission",
    params: {
      sessionId: "sess-perm-test",
      toolCallId: "tc-report-1",
      _meta: {
        kiro: {
          mcpTool: "necromancer/report_task_result",
          role: "Planner",
        },
      },
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    },
  });

  const permReply = await permPromise;
  assert.ok(permReply.result);
  // Planner is allowed report_task_result, so option opt-allow should be selected
  assert.equal(permReply.result.outcome.outcome, "selected");
  assert.equal(permReply.result.outcome.optionId, "opt-allow");

  await supervisor.finish();
});

test("Requirement 16.10: Prompt completes only on prompt response", async () => {
  let promptReceived = false;
  let completePromptCallback: (() => void) | null = null;

  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-prompt-test",
      modeId: "scribe",
      configOptions: [{ id: "model", value: CLAUDE_HAIKU_5_5_MODEL_ID }],
    }),
    onSessionPrompt: (params) => {
      promptReceived = true;
      return new Promise((resolve) => {
        completePromptCallback = () => {
          resolve({
            status: "finished",
            summary: "Report written",
          });
        };
      });
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-prompt-test",
    skeletonId: "skel-scribe-prompt",
    role: "scribe",
    cwd: "/data/runs/run-prompt-test/wt",
    quarantineDir: "/data/runs/run-prompt-test/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await supervisor.raise();

  let promptCompleted = false;
  const promptPromise = supervisor.prompt("Generate final summary report").then((res) => {
    promptCompleted = true;
    return res;
  });

  // Small delay to let JSON-RPC flow to agent
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(promptReceived, "Prompt request should have reached mock agent");
  assert.equal(promptCompleted, false, "Prompt should NOT be complete before response arrives");

  // Agent now replies
  completePromptCallback!();
  const result: any = await promptPromise;

  assert.equal(promptCompleted, true);
  assert.equal(result.status, "finished");

  await supervisor.finish();
});

test("Requirement 16.14: Cancel sends session/cancel and signals process", async () => {
  let cancelReceived = false;

  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onSessionNew: () => ({
      sessionId: "sess-cancel-test",
      modeId: "bonesetter",
      configOptions: [{ id: "model", value: CLAUDE_SONNET_5_5_MODEL_ID }],
    }),
    onSessionCancel: () => {
      cancelReceived = true;
      return { status: "cancelled" };
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-cancel-test",
    skeletonId: "skel-bonesetter-cancel",
    role: "bonesetter",
    cwd: "/data/runs/run-cancel-test/wt",
    quarantineDir: "/data/runs/run-cancel-test/quarantine",
    cancelGracePeriodMs: 10,
    cancelPromptTimeoutMs: 100,
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
  });

  await supervisor.raise();
  await supervisor.cancel("Admin requested stop");

  assert.ok(cancelReceived, "session/cancel should have been dispatched to agent");
  assert.ok(mockChild.signalsSent.includes("SIGTERM"), "SIGTERM should have been sent to process");
  assert.equal(supervisor.getState(), "terminated");

  await supervisor.finish();
});

test("Requirement 16.16, 16.17: Unexpected process exit triggers single respawn with session/load and continue instruction", async () => {
  let spawnCount = 0;
  let sessionLoadReceived = false;
  let continuePromptReceived = false;
  let lostPromptResent = false;

  const originalChild = new MockChildProcess();
  createMockAcpAgent(originalChild, {
    onSessionNew: () => ({
      sessionId: "sess-respawn-456",
      modeId: "bonesetter",
      configOptions: [{ id: "model", value: CLAUDE_SONNET_5_5_MODEL_ID }],
    }),
  });

  const respawnChild = new MockChildProcess();
  createMockAcpAgent(respawnChild, {
    onSessionLoad: (params) => {
      sessionLoadReceived = true;
      assert.equal(params.sessionId, "sess-respawn-456");
      return { status: "loaded" };
    },
    onSessionPrompt: (params) => {
      if (params.prompt === "continue from the current tree state") {
        continuePromptReceived = true;
      } else if (params.prompt === "original lost prompt") {
        lostPromptResent = true;
      }
      return { status: "turn_complete" };
    },
  });

  const mockSpawn: SpawnFunction = () => {
    spawnCount++;
    return spawnCount === 1 ? originalChild : respawnChild;
  };

  const supervisor = createSkeletonSupervisor({
    runId: "run-respawn-test",
    skeletonId: "skel-bonesetter-respawn",
    role: "bonesetter",
    cwd: "/data/runs/run-respawn-test/wt",
    quarantineDir: "/data/runs/run-respawn-test/quarantine",
    spawnFn: mockSpawn,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  await supervisor.raise();
  assert.equal(spawnCount, 1);

  // Simulate unexpected crash of the child process
  originalChild.simulateExit(1, "SIGSEGV");

  // Wait for respawn and session/load
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(spawnCount, 2, "Should have respawned once");
  assert.ok(sessionLoadReceived, "session/load should have been sent to respawned process");
  assert.ok(continuePromptReceived, "continue instruction should have been sent");
  assert.equal(lostPromptResent, false, "Lost prompt should not have been resent");

  await supervisor.finish();
});

test("Task 9.4: spawnSkeletonProcess spawns kiro-cli acp with exact environment and skel user", async () => {
  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];
  let capturedOptions: any = null;

  const mockChild = new MockChildProcess();
  const mockSpawn: SpawnFunction = (command, args, options) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedOptions = options;
    return mockChild;
  };

  const spawned = spawnSkeletonProcess({
    runId: "run-spawn-direct",
    skeletonId: "skel-planner-direct",
    role: "planner",
    cwd: "/tmp/test-wt",
    kiroApiKey: "ksk_direct_key_999",
    kiroHome: "/tmp/direct-kiro-home",
    home: "/tmp/direct-home",
    spawnFn: mockSpawn,
    permissionBroker: new PermissionBroker({
      role: "planner",
      cwd: "/tmp/test-wt",
      ...getRequiredBrokerSettings(),
    }),
  });

  assert.equal(capturedCommand, "kiro-cli");
  assert.deepEqual(capturedArgs, ["acp", "--agent-engine=v3"]);
  assert.equal(capturedOptions?.user, "skel");
  assert.deepEqual(Object.keys(capturedOptions.env).sort(), [
    "HOME",
    "KIRO_API_KEY",
    "KIRO_HOME",
    "PATH",
  ]);
  assert.equal(capturedOptions.env.KIRO_API_KEY, "ksk_direct_key_999");
  assert.equal(capturedOptions.env.KIRO_HOME, "/tmp/direct-kiro-home");
  assert.equal(capturedOptions.env.HOME, "/tmp/direct-home");
  assert.ok(spawned.client);
  assert.ok(spawned.transport);

  spawned.client.close();
});

test("Requirement 16.18: ACP login request triggers onAdmissionHalt and fails spawn with auth_failed", async () => {
  let admissionHaltedWithReason = "";

  const mockChild = new MockChildProcess();
  createMockAcpAgent(mockChild, {
    onInitialize: () => ({
      status: "login_required",
      authMethods: ["login"],
      loginRequired: true,
    }),
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-halt-admission",
    skeletonId: "skel-auth-halt",
    role: "scribe",
    cwd: "/data/runs/run-halt-admission/wt",
    quarantineDir: "/data/runs/run-halt-admission/quarantine",
    spawnFn: () => mockChild,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
    onAdmissionHalt: (reason) => {
      admissionHaltedWithReason = reason;
    },
  });

  await assert.rejects(
    async () => {
      await supervisor.raise();
    },
    (err: any) => {
      assert.equal(err.reason, "auth_failed");
      return true;
    }
  );

  assert.equal(admissionHaltedWithReason, "auth_failed");
  assert.equal(supervisor.getFailureReason(), "auth_failed");
  await supervisor.finish();
});

test("Requirement 17.1, 17.2, 17.3, 17.4: Headless Fallback channel activates on P1 failure, runs turns and corrections, and writes the raw stream outside the worktree", async () => {
  const capturedCommands: Array<{ command: string; args: readonly string[]; options: any }> = [];
  const cliSessionId = "cli-headless-sess-1";

  const mockSpawn: SpawnFunction = (command, args, options) => {
    capturedCommands.push({ command, args, options });
    const child = new MockChildProcess();
    // Stream a valid session record matching the role tier and close cleanly,
    // asynchronously, so the awaited prompt()/steer() observes the real result.
    setImmediate(() => {
      child.stdout.write(
        JSON.stringify({
          type: "session",
          sessionId: cliSessionId,
          model: CLAUDE_SONNET_5_5_MODEL_ID,
        }) + "\n"
      );
      child.stdout.write(JSON.stringify({ type: "assistant", text: "Done" }) + "\n");
      child.stdout.end();
      setImmediate(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
    });
    return child;
  };

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-ss-"));

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-test",
    skeletonId: "skel-headless-ss",
    role: "soul-stitcher",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false, outcome: "acp probe failed" },
      P14: { id: "P14", passed: true },
    },
    gatewayToolIds: ["sandbox_exec", "report_task_result"],
    onAskAutoDeny: () => {},
    spawnFn: mockSpawn,
    brokerOptions: getRequiredBrokerSettings(),
    cancelGracePeriodMs: 5000,
  });

  // Requirement 17.1: Uses Headless_Fallback when probe P1 fails
  assert.equal(supervisor.getExecutionChannel(), "Headless_Fallback");

  const raised = await supervisor.raise();
  assert.equal(raised.kind, "skeleton.raised");
  assert.equal(raised.modelId, CLAUDE_SONNET_5_5_MODEL_ID);

  // Requirement 17.2, 17.4: runs a turn with kiro-cli chat --v3 --no-interactive
  const promptResult: any = await supervisor.prompt("Fix package.json dependencies");
  assert.equal(promptResult.status, "complete");
  assert.equal(promptResult.sessionId, cliSessionId);
  assert.ok(promptResult.output.includes("Done"));

  assert.equal(capturedCommands.length, 1);
  const promptCmd = capturedCommands[0];
  assert.equal(promptCmd.command, "kiro-cli");
  assert.ok(promptCmd.args.includes("chat"));
  assert.ok(promptCmd.args.includes("--v3"));
  assert.ok(promptCmd.args.includes("--no-interactive"));
  assert.ok(promptCmd.args.includes("--agent"));
  assert.ok(promptCmd.args.includes("soul-stitcher"));
  assert.ok(promptCmd.args.includes("--model"));
  assert.ok(promptCmd.args.includes(CLAUDE_SONNET_5_5_MODEL_ID));
  assert.ok(promptCmd.args.includes("--require-mcp-startup"));
  assert.ok(promptCmd.args.includes("--trust-tools"));
  assert.ok(promptCmd.args.includes("sandbox_exec,report_task_result"));
  assert.ok(promptCmd.args.includes("--output-format"));
  assert.ok(promptCmd.args.includes("stream-json"));
  // The first headless turn is never a resume.
  assert.ok(!promptCmd.args.includes("--resume-id"));

  // The raw stream log lives under the sessions dir, never inside the worktree.
  assert.equal(
    promptResult.rawLogPath,
    path.join(supervisor.getPaths().sessionsDir, "headless-stream.jsonl")
  );
  assert.ok(fs.existsSync(promptResult.rawLogPath));
  assert.ok(!fs.existsSync(path.join(supervisor.cwd, "headless-stream.jsonl")));

  // Requirement 17.3: Correction resumes with the REAL CLI session id.
  await supervisor.steer("Please revert the previous lockfile change");

  assert.equal(capturedCommands.length, 2);
  const steerCmd = capturedCommands[1];
  assert.equal(steerCmd.command, "kiro-cli");
  assert.equal(steerCmd.args[steerCmd.args.indexOf("--resume-id") + 1], cliSessionId);

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test("Requirement 17.4, 17.8: a failing headless turn propagates the real reason and fails the supervisor", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-fail-"));
  let spawnCount = 0;

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-fail",
    skeletonId: "skel-headless-fail",
    role: "bonesetter",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false },
      P14: { id: "P14", passed: true },
    },
    onAskAutoDeny: () => {},
    cancelGracePeriodMs: 1,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: () => {
      spawnCount += 1;
      const child = new MockChildProcess();
      setImmediate(() => {
        child.stdout.write(
          JSON.stringify({
            type: "session",
            sessionId: "cli-gw",
            model: CLAUDE_SONNET_5_5_MODEL_ID,
          }) + "\n"
        );
        child.stdout.end();
        setImmediate(() => {
          child.exitCode = 3; // gateway_missing
          child.emit("close", 3);
        });
      });
      return child;
    },
  });

  await supervisor.raise();

  await assert.rejects(
    () => supervisor.prompt("do work"),
    (err: any) => err instanceof SkeletonSupervisorError && err.reason === "gateway_missing"
  );

  assert.equal(spawnCount, 1);
  assert.equal(supervisor.getState(), "failed");
  assert.equal(supervisor.getFailureReason(), "gateway_missing");

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test("Requirement 17.11: a headless turn fails closed before spawning when onAskAutoDeny is missing", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-nohook-"));
  let spawned = false;

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-nohook",
    skeletonId: "skel-headless-nohook",
    role: "bonesetter",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false },
      P14: { id: "P14", passed: true },
    },
    cancelGracePeriodMs: 1,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: () => {
      spawned = true;
      return new MockChildProcess();
    },
  });

  await supervisor.raise();

  await assert.rejects(
    () => supervisor.prompt("do work"),
    (err: any) => err instanceof SkeletonSupervisorError && err.reason === "ask_auto_deny_failed"
  );

  assert.equal(spawned, false);
  assert.equal(supervisor.getState(), "failed");
  assert.equal(supervisor.getFailureReason(), "ask_auto_deny_failed");

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});


test("Requirement 17.1: a headless turn is refused when P14 did not pass", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-nop14-"));
  let spawned = false;

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-nop14",
    skeletonId: "skel-headless-nop14",
    role: "bonesetter",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false },
      // P14 intentionally absent: the channel must NOT run.
    },
    onAskAutoDeny: () => {},
    cancelGracePeriodMs: 1,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: () => {
      spawned = true;
      return new MockChildProcess();
    },
  });

  await supervisor.raise();

  await assert.rejects(
    () => supervisor.prompt("do work"),
    (err: any) =>
      err instanceof SkeletonSupervisorError && err.reason === "headless_fallback_disabled"
  );

  assert.equal(spawned, false);
  assert.equal(supervisor.getFailureReason(), "headless_fallback_disabled");

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test("Requirement 17.6, 17.7: a headless turn resumes with --resume-id after an approved interrupt", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-s2-"));
  const capturedCommands: Array<{ command: string; args: readonly string[] }> = [];

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-s2",
    skeletonId: "skel-headless-s2",
    role: "soul-stitcher",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false },
      P14: { id: "P14", passed: true },
      S2: { id: "S2", passed: true },
    },
    onApproval: () => "approve",
    onAskAutoDeny: () => {},
    cancelGracePeriodMs: 1,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: (command, args) => {
      capturedCommands.push({ command, args });
      const callIndex = capturedCommands.length - 1;
      const child = new MockChildProcess();
      setImmediate(() => {
        child.stdout.write(
          JSON.stringify({
            type: "session",
            sessionId: "cli-s2",
            model: CLAUDE_SONNET_5_5_MODEL_ID,
          }) + "\n"
        );
        if (callIndex === 0) {
          child.stdout.write(
            JSON.stringify({ type: "approval_request", approvalId: "ap-1", tool: "shell" }) +
              "\n"
          );
        } else {
          child.stdout.write(JSON.stringify({ type: "assistant", text: "resumed" }) + "\n");
        }
        child.stdout.end();
        setImmediate(() => {
          child.exitCode = 0;
          child.emit("close", 0);
        });
      });
      return child;
    },
  });

  await supervisor.raise();

  const result: any = await supervisor.prompt("run a command");
  assert.equal(result.status, "complete");
  assert.equal(capturedCommands.length, 2);

  const resumeArgs = capturedCommands[1].args;
  const resumeIndex = resumeArgs.indexOf("--resume-id");
  assert.ok(resumeIndex >= 0);
  assert.equal(resumeArgs[resumeIndex + 1], "cli-s2");

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test("Requirement 16.14, 17.8: cancel() kills the active headless channel", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-cancel-"));
  let killed = false;
  let activeChild: MockChildProcess | null = null;

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-cancel",
    skeletonId: "skel-headless-cancel",
    role: "bonesetter",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false },
      P14: { id: "P14", passed: true },
    },
    onAskAutoDeny: () => {},
    cancelGracePeriodMs: 1,
    cancelPromptTimeoutMs: 50,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: () => {
      const child = new MockChildProcess();
      // Never closes on its own; kill() emits close with a SIGTERM signal.
      child.kill = () => {
        killed = true;
        child.killed = true;
        child.signalCode = "SIGTERM";
        child.exitCode = null;
        child.emit("close", null);
        return true;
      };
      activeChild = child;
      return child;
    },
  });

  await supervisor.raise();

  const pending = supervisor.prompt("long task");
  const rejected = assert.rejects(
    () => pending,
    (err: any) => err instanceof SkeletonSupervisorError && err.reason === "cancelled"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(activeChild);

  await supervisor.cancel();

  assert.equal(killed, true);
  await rejected;

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test("Requirement 17.3: steer() mid-headless-turn never runs two concurrent headless processes", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-steer-"));
  let live = 0;
  let maxConcurrentSpawns = 0;
  const children: MockChildProcess[] = [];

  const spawnFn: SpawnFunction = () => {
    live += 1;
    maxConcurrentSpawns = Math.max(maxConcurrentSpawns, live);
    const child = new MockChildProcess();
    const index = children.length;
    children.push(child);
    // The FIRST turn stays open until it is cancelled; the resume turn closes
    // cleanly so steer() can complete.
    child.kill = () => {
      child.killed = true;
      child.signalCode = "SIGTERM";
      child.exitCode = null;
      child.emit("close", null);
      return true;
    };
    setImmediate(() => {
      child.stdout.write(
        JSON.stringify({
          type: "session",
          sessionId: `cli-steer-${index}`,
          model: CLAUDE_SONNET_5_5_MODEL_ID,
        }) + "\n"
      );
      if (index > 0) {
        child.stdout.write(JSON.stringify({ type: "assistant", text: "resumed" }) + "\n");
        child.stdout.end();
        setImmediate(() => {
          child.exitCode = 0;
          child.emit("close", 0);
        });
      }
    });
    child.on("close", () => {
      live -= 1;
    });
    return child;
  };

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-steer",
    skeletonId: "skel-headless-steer",
    role: "bonesetter",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false },
      P14: { id: "P14", passed: true },
    },
    onAskAutoDeny: () => {},
    cancelGracePeriodMs: 1,
    cancelPromptTimeoutMs: 100,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn,
  });

  await supervisor.raise();

  const firstTurn = supervisor.prompt("first turn");
  const spawnDeadline = Date.now() + 2000;
  while (children.length < 1 && Date.now() < spawnDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(live, 1, "the first headless turn must have exactly one live process");

  // steer while the first headless turn is still in flight. It must resolve
  // without throwing and must NOT mark the Skeleton failed.
  const steerPromise = supervisor.steer("correction");
  await steerPromise;
  await firstTurn;

  assert.equal(
    maxConcurrentSpawns,
    1,
    "steer() must never run two concurrent headless processes"
  );
  assert.equal(
    supervisor.getState(),
    "raised",
    "a mid-turn steer() must leave the Skeleton raised"
  );
  assert.equal(
    supervisor.getFailureReason(),
    null,
    "a mid-turn steer() must not fail the Skeleton"
  );
  assert.ok(children.length >= 2, "steer() must spawn a resume process");

  // The Skeleton stays usable: a follow-up prompt must still succeed.
  const followUp: any = await supervisor.prompt("follow-up");
  assert.equal(followUp.status, "complete");
  assert.equal(live, 0);

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test("Requirement 16.2: headless spawn runs as the sandbox user (default \"skel\", override honored)", async () => {
  const capturedUsers: Array<string | undefined> = [];

  const buildSupervisor = (user?: string) => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-user-"));
    const supervisor = createSkeletonSupervisor({
      runId: "run-headless-user",
      skeletonId: "skel-headless-user",
      role: "bonesetter",
      cwd: path.join(tmpBase, "wt"),
      baseDir: tmpBase,
      quarantineDir: path.join(tmpBase, "quarantine"),
      ...(user ? { user } : {}),
      probeResults: {
        P1: { id: "P1", passed: false },
        P14: { id: "P14", passed: true },
      },
      onAskAutoDeny: () => {},
      cancelGracePeriodMs: 1,
      brokerOptions: getRequiredBrokerSettings(),
      spawnFn: ((
        _command: string,
        _args: readonly string[],
        options: SpawnOptions
      ) => {
        capturedUsers.push(options.user);
        const child = new MockChildProcess();
        setImmediate(() => {
          child.stdout.write(
            JSON.stringify({
              type: "session",
              sessionId: "cli-user",
              model: CLAUDE_SONNET_5_5_MODEL_ID,
            }) + "\n"
          );
          child.stdout.write(JSON.stringify({ type: "assistant", text: "done" }) + "\n");
          child.stdout.end();
          setImmediate(() => {
            child.exitCode = 0;
            child.emit("close", 0);
          });
        });
        return child;
      }) as SpawnFunction,
    });
    return { supervisor, tmpBase };
  };

  // Default: the sandbox user is "skel".
  const defaultRun = buildSupervisor();
  await defaultRun.supervisor.raise();
  await defaultRun.supervisor.prompt("work");
  assert.equal(capturedUsers[0], "skel", "headless spawn must default to user skel");
  await defaultRun.supervisor.finish();
  fs.rmSync(defaultRun.tmpBase, { recursive: true, force: true });

  // Explicit override: options.user wins.
  const overrideRun = buildSupervisor("sandbox-runner");
  await overrideRun.supervisor.raise();
  await overrideRun.supervisor.prompt("work");
  assert.equal(capturedUsers[1], "sandbox-runner", "an explicit user must be honored");
  await overrideRun.supervisor.finish();
  fs.rmSync(overrideRun.tmpBase, { recursive: true, force: true });
});

test("Requirement 17.12: prompt().sessionId is redacted while steer() resumes with the unredacted --resume-id", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-raw-"));
  // Assemble the key at runtime so no literal secret appears in the source.
  const kiroKey = ["zq", "7", "over", "lap", "x", "9931"].join("");
  const rawSessionId = `sess-${kiroKey}-end`;
  const capturedCommands: Array<{ args: readonly string[] }> = [];

  const spawnFn: SpawnFunction = (command, args) => {
    capturedCommands.push({ args });
    const child = new MockChildProcess();
    setImmediate(() => {
      child.stdout.write(
        JSON.stringify({
          type: "session",
          sessionId: rawSessionId,
          model: CLAUDE_SONNET_5_5_MODEL_ID,
        }) + "\n"
      );
      child.stdout.write(JSON.stringify({ type: "assistant", text: "done" }) + "\n");
      child.stdout.end();
      setImmediate(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
    });
    return child;
  };

  const supervisor = createSkeletonSupervisor({
    runId: "run-headless-raw",
    skeletonId: "skel-headless-raw",
    role: "bonesetter",
    cwd: path.join(tmpBase, "wt"),
    baseDir: tmpBase,
    quarantineDir: path.join(tmpBase, "quarantine"),
    probeResults: {
      P1: { id: "P1", passed: false },
      P14: { id: "P14", passed: true },
    },
    kiroApiKey: kiroKey,
    onAskAutoDeny: () => {},
    cancelGracePeriodMs: 1,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn,
  });

  await supervisor.raise();

  const promptResult: any = await supervisor.prompt("do work");
  assert.equal(promptResult.status, "complete");
  // Requirement 17.12: the PUBLIC session id never leaks the credential.
  assert.ok(
    !String(promptResult.sessionId).includes(kiroKey),
    "prompt().sessionId must not leak the API key"
  );
  assert.notEqual(promptResult.sessionId, rawSessionId);

  // The RAW session id was retained internally and is used verbatim to resume,
  // even though its characters overlap the API key.
  await supervisor.steer("correction");
  assert.equal(capturedCommands.length, 2);
  const steerArgs = capturedCommands[1].args;
  const resumeIndex = steerArgs.indexOf("--resume-id");
  assert.ok(resumeIndex >= 0, "steer must pass --resume-id");
  assert.equal(steerArgs[resumeIndex + 1], rawSessionId);

  await supervisor.finish();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

