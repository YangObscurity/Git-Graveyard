// Task 9.7: Property test for Model allowlist (Property 17: P17)
// Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 17.1, 17.2, 17.3, 17.4
//
// Property 17: No session/prompt is sent to a session whose active model,
// read from configOptions after session/new, is outside the three allowed IDs
// or differs from the role tier.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import {
  ALL_SKELETON_ROLES,
  ALLOWED_MODEL_IDS,
  AllowedModelId,
  areLiveRunsEnabled,
  assertSessionModel,
  AUTO_MODEL_ID,
  canSendSessionPrompt,
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
  extractActiveModel,
  getAssignedModelForRole,
  getAssignedTierForRole,
  getDefaultEffortLevel,
  getModelTier,
  isAllowedModelId,
  isAutoModel,
  isHardTask,
  MODEL_MISMATCH_REASON,
  MODEL_TIER_BY_ID,
  MODEL_TIER_HAIKU,
  MODEL_TIER_OPUS,
  MODEL_TIER_SONNET,
  ModelMismatchError,
  normalizeRole,
  refuseSessionPrompt,
  ROLE_DEFAULT_MODELS,
  ROLE_DEFAULT_TIERS,
  SkeletonRole,
  verifySessionModel,
} from "../../lib/supervisor/model-allowlist";

import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
  SkeletonSupervisorError,
} from "../../lib/supervisor/skeleton-supervisor";
import { getRequiredBrokerSettings } from "./fixtures";

import {
  buildSessionNewParams,
  verifySessionNegotiation,
} from "../../lib/supervisor/acp-session";

import type {
  ChildProcessLike,
  SkeletonFailedEvent,
  SkeletonRaisedEvent,
  SpawnOptions,
} from "../../lib/supervisor/types";

/**
 * Mock ChildProcess for tests to avoid spawning real OS processes.
 */
class MockAcpChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 7777;
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

  public sendStdoutJson(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }
}

interface RecordedAcpState {
  initializeCount: number;
  sessionNewCount: number;
  sessionPromptCount: number;
  sessionCancelCount: number;
  sessionSteerCount: number;
  promptsSent: Array<{ sessionId: string; prompt: unknown }>;
  allRequests: Array<{ id: unknown; method: string; params: any }>;
}

/**
 * Helper to simulate an ACP agent with a customizable session/new response,
 * recording all requests dispatched to stdin.
 */
function attachMockAcpAgent(
  child: MockAcpChildProcess,
  options: {
    sessionResponse: unknown;
    modeId?: string;
  }
): RecordedAcpState {
  const recorded: RecordedAcpState = {
    initializeCount: 0,
    sessionNewCount: 0,
    sessionPromptCount: 0,
    sessionCancelCount: 0,
    sessionSteerCount: 0,
    promptsSent: [],
    allRequests: [],
  };

  let buffer = "";

  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString("utf-8");
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg && typeof msg === "object" && "id" in msg) {
            recorded.allRequests.push({
              id: msg.id,
              method: msg.method,
              params: msg.params,
            });

            if (msg.method === "initialize") {
              recorded.initializeCount++;
              child.sendStdoutJson({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
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
                },
              });
            } else if (msg.method === "session/new") {
              recorded.sessionNewCount++;
              child.sendStdoutJson({
                jsonrpc: "2.0",
                id: msg.id,
                result: options.sessionResponse,
              });
            } else if (msg.method === "session/prompt") {
              recorded.sessionPromptCount++;
              recorded.promptsSent.push({
                sessionId: msg.params?.sessionId,
                prompt: msg.params?.prompt,
              });
              child.sendStdoutJson({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  status: "completed",
                  output: "ok",
                },
              });
            } else if (msg.method === "session/cancel") {
              recorded.sessionCancelCount++;
              child.sendStdoutJson({
                jsonrpc: "2.0",
                id: msg.id,
                result: { status: "cancelled" },
              });
            } else if (msg.method === "_session/steer") {
              recorded.sessionSteerCount++;
              child.sendStdoutJson({
                jsonrpc: "2.0",
                id: msg.id,
                result: { status: "steered" },
              });
            }
          }
        } catch {
          // Ignore JSON parse error in mock stream
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return recorded;
}

// Arbitrary generators for Property testing
const roleArb = fc.constantFrom<SkeletonRole>(...ALL_SKELETON_ROLES);
const allowedModelArb = fc.constantFrom<AllowedModelId>(...ALLOWED_MODEL_IDS);

// Disallowed model generator: random strings not in ALLOWED_MODEL_IDS
const disallowedModelArb = fc
  .oneof(
    fc.constantFrom(
      "auto",
      "Auto",
      "AUTO",
      "aUtO",
      " auto ",
      "claude-3-5-sonnet-20241022",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
      "gpt-4o",
      "gpt-4-turbo",
      "claude-opus-5",
      "claude-haiku-5.0",
      "claude-sonnet-5.0",
      "unknown-model-xyz",
      ""
    ),
    fc.string({ minLength: 1, maxLength: 40 }).filter((s) => {
      const trimmed = s.trim();
      return !(ALLOWED_MODEL_IDS as readonly string[]).includes(trimmed);
    })
  );

// Hard task flag generator
const hardTaskArb = fc.oneof(
  fc.boolean(),
  fc.constantFrom("yes", "no", "true", "false", "1", "0", "YES", "NO", null, undefined)
);

describe("Task 9.7 (Property 17: P17) - Model Allowlist Property Tests", () => {
  it("Requirement 15.1, 15.2: Model allowlist contains exactly 3 Claude 5.5 IDs and excludes Auto", () => {
    assert.equal(ALLOWED_MODEL_IDS.length, 3);
    assert.deepEqual(ALLOWED_MODEL_IDS, [
      "claude-haiku-5.5",
      "claude-sonnet-5.5",
      "claude-opus-5.5",
    ]);

    assert.equal(isAllowedModelId("claude-haiku-5.5"), true);
    assert.equal(isAllowedModelId("claude-sonnet-5.5"), true);
    assert.equal(isAllowedModelId("claude-opus-5.5"), true);

    // Auto must be excluded in all shapes
    assert.equal(isAllowedModelId("auto"), false);
    assert.equal(isAllowedModelId("Auto"), false);
    assert.equal(isAllowedModelId("AUTO"), false);
    assert.equal(isAllowedModelId(" auto "), false);
    assert.equal(isAutoModel("auto"), true);
    assert.equal(isAutoModel("Auto"), true);
    assert.equal(isAutoModel("AUTO"), true);
  });

  it("Requirement 15.3, 15.4: Role tier assignment and hard task escalation completeness", () => {
    // Default tier assignments
    assert.equal(ROLE_DEFAULT_MODELS.planner, CLAUDE_OPUS_5_5_MODEL_ID);
    assert.equal(ROLE_DEFAULT_MODELS.warden, CLAUDE_OPUS_5_5_MODEL_ID);
    assert.equal(ROLE_DEFAULT_MODELS.bonesetter, CLAUDE_SONNET_5_5_MODEL_ID);
    assert.equal(ROLE_DEFAULT_MODELS["soul-stitcher"], CLAUDE_SONNET_5_5_MODEL_ID);
    assert.equal(ROLE_DEFAULT_MODELS.exhumer, CLAUDE_HAIKU_5_5_MODEL_ID);
    assert.equal(ROLE_DEFAULT_MODELS.scribe, CLAUDE_HAIKU_5_5_MODEL_ID);

    fc.assert(
      fc.property(roleArb, hardTaskArb, (role, hard) => {
        const assigned = getAssignedModelForRole(role, { hard });
        assert.ok(isAllowedModelId(assigned), `Assigned model ${assigned} must be allowed`);

        const isHard = isHardTask(hard);
        if (role === "soul-stitcher" && isHard) {
          assert.equal(assigned, CLAUDE_OPUS_5_5_MODEL_ID);
        } else if (role === "soul-stitcher" && !isHard) {
          assert.equal(assigned, CLAUDE_SONNET_5_5_MODEL_ID);
        } else if (role === "planner" || role === "warden") {
          assert.equal(assigned, CLAUDE_OPUS_5_5_MODEL_ID);
        } else if (role === "bonesetter") {
          assert.equal(assigned, CLAUDE_SONNET_5_5_MODEL_ID);
        } else if (role === "exhumer" || role === "scribe") {
          assert.equal(assigned, CLAUDE_HAIKU_5_5_MODEL_ID);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("Property 17.1: Rejection and canPrompt=false for any model outside allowlist (Requirements 15.1, 15.2, 15.5, 15.6)", () => {
    fc.assert(
      fc.property(roleArb, hardTaskArb, disallowedModelArb, (role, hard, badModel) => {
        // Build session response with bad model in configOptions
        const sessionResponse = {
          sessionId: "sess-prop-bad-model",
          modeId: role,
          configOptions: [
            {
              id: "model",
              value: badModel,
            },
          ],
        };

        const result = verifySessionModel(sessionResponse, role, { hard });
        assert.equal(result.ok, false);
        assert.equal(result.reason, MODEL_MISMATCH_REASON);
        assert.equal(result.canPrompt, false);

        // Verification function helpers
        assert.equal(canSendSessionPrompt(sessionResponse, role, { hard }), false);
        assert.equal(refuseSessionPrompt(sessionResponse, role, { hard }), true);

        // assertSessionModel must throw ModelMismatchError
        assert.throws(
          () => assertSessionModel(sessionResponse, role, { hard }),
          (err: any) => err instanceof ModelMismatchError && err.reason === "model_mismatch"
        );
      }),
      { numRuns: 100 }
    );
  });

  it("Property 17.2: Rejection and canPrompt=false when active model is allowed but differs from role tier (Requirements 15.5, 15.6)", () => {
    fc.assert(
      fc.property(roleArb, hardTaskArb, allowedModelArb, (role, hard, allowedModel) => {
        const expectedModel = getAssignedModelForRole(role, { hard });
        fc.pre(allowedModel !== expectedModel);

        const sessionResponse = {
          sessionId: "sess-prop-tier-diff",
          modeId: role,
          configOptions: [
            {
              id: "model",
              value: allowedModel,
            },
          ],
        };

        const result = verifySessionModel(sessionResponse, role, { hard });
        assert.equal(result.ok, false);
        assert.equal(result.reason, MODEL_MISMATCH_REASON);
        assert.equal(result.matchesTier, false);
        assert.equal(result.canPrompt, false);

        assert.equal(canSendSessionPrompt(sessionResponse, role, { hard }), false);
        assert.equal(refuseSessionPrompt(sessionResponse, role, { hard }), true);

        assert.throws(
          () => assertSessionModel(sessionResponse, role, { hard }),
          (err: any) => err instanceof ModelMismatchError && err.reason === "model_mismatch"
        );
      }),
      { numRuns: 100 }
    );
  });

  it("Property 17.3: Invariant: canPrompt is true IF AND ONLY IF model is allowed and matches role tier", () => {
    const candidateModelArb = fc.oneof(allowedModelArb, disallowedModelArb);

    fc.assert(
      fc.property(roleArb, hardTaskArb, candidateModelArb, (role, hard, candidateModel) => {
        const expectedModel = getAssignedModelForRole(role, { hard });
        const shouldPass = isAllowedModelId(candidateModel) && candidateModel === expectedModel;

        const sessionResponse = {
          sessionId: "sess-prop-equiv",
          modeId: role,
          configOptions: [{ id: "model", value: candidateModel }],
        };

        const canPrompt = canSendSessionPrompt(sessionResponse, role, { hard });
        const refuse = refuseSessionPrompt(sessionResponse, role, { hard });
        const verification = verifySessionModel(sessionResponse, role, { hard });

        assert.equal(canPrompt, shouldPass);
        assert.equal(refuse, !shouldPass);
        assert.equal(verification.ok, shouldPass);
        assert.equal(verification.canPrompt, shouldPass);
      }),
      { numRuns: 100 }
    );
  });

  it("Property 17.4: ConfigOptions representation invariance for valid active models (Requirement 15.5)", () => {
    // Generate various structural shapes for configOptions
    fc.assert(
      fc.property(roleArb, hardTaskArb, (role, hard) => {
        const expectedModel = getAssignedModelForRole(role, { hard });

        const variations = [
          // Array id/value
          { configOptions: [{ id: "model", value: expectedModel }] },
          // Array name/selectedValue
          { configOptions: [{ name: "model", selectedValue: expectedModel }] },
          // Array key/currentValue
          { configOptions: [{ key: "model", currentValue: expectedModel }] },
          // Array configId/activeValue
          { configOptions: [{ configId: "model", activeValue: expectedModel }] },
          // Array id=modelId
          { configOptions: [{ id: "modelId", value: expectedModel }] },
          // Array id=active_model
          { configOptions: [{ id: "active_model", value: expectedModel }] },
          // Array with dummy options before and after
          {
            configOptions: [
              { id: "theme", value: "dark" },
              { id: "model", value: expectedModel },
              { id: "tabSize", value: 2 },
            ],
          },
          // Record model string
          { configOptions: { model: expectedModel } },
          // Record model object
          { configOptions: { model: { value: expectedModel } } },
          // Record modelId
          { configOptions: { modelId: expectedModel } },
          // Direct properties
          { activeModel: expectedModel },
          { modelId: expectedModel },
          // Nested in result
          { result: { configOptions: [{ id: "model", value: expectedModel }] } },
          // Meta kiro
          { _meta: { kiro: { modelId: expectedModel } } },
        ];

        for (const variant of variations) {
          const extracted = extractActiveModel(variant);
          assert.equal(
            extracted,
            expectedModel,
            `Failed to extract active model from variant: ${JSON.stringify(variant)}`
          );

          const result = verifySessionModel(variant, role, { hard });
          assert.equal(result.ok, true);
          assert.equal(result.canPrompt, true);
          assert.equal(result.modelId, expectedModel);
          assert.equal(canSendSessionPrompt(variant, role, { hard }), true);
        }
      }),
      { numRuns: 50 }
    );
  });

  it("Property 17.5 (P17 core): SkeletonSupervisor sends ZERO session/prompt when model is outside allowlist (Requirements 15.1, 15.5, 15.6)", async () => {
    // Test across combinations of roles and disallowed models
    const testCases: Array<{ role: SkeletonRole; hard: boolean; badModel: string }> = [
      { role: "planner", hard: false, badModel: "auto" },
      { role: "planner", hard: false, badModel: "Auto" },
      { role: "warden", hard: false, badModel: "gpt-4o" },
      { role: "bonesetter", hard: false, badModel: "claude-3-5-sonnet-20241022" },
      { role: "soul-stitcher", hard: false, badModel: "unknown-vendor-model" },
      { role: "soul-stitcher", hard: true, badModel: "claude-opus-4" },
      { role: "exhumer", hard: false, badModel: "AUTO" },
      { role: "scribe", hard: false, badModel: "" },
    ];

    for (const tc of testCases) {
      const mockChild = new MockAcpChildProcess();
      const recorded = attachMockAcpAgent(mockChild, {
        sessionResponse: {
          sessionId: `sess-bad-${tc.role}`,
          modeId: tc.role,
          configOptions: [{ id: "model", value: tc.badModel }],
        },
      });

      const supervisor = createSkeletonSupervisor({
        runId: "run-prop-disallowed",
        cancelGracePeriodMs: 1,
        skeletonId: `skel-${tc.role}-bad`,
        role: tc.role,
        hard: tc.hard,
        cwd: "/data/runs/test-run/wt",
        quarantineDir: "/tmp/run-prop-disallowed-quarantine",
        spawnFn: () => mockChild,
        brokerOptions: getRequiredBrokerSettings(),
      });

      let raised = false;
      let caughtError: any = null;

      try {
        await supervisor.raise();
        raised = true;
      } catch (err: any) {
        caughtError = err;
      }

      // 1. raise() MUST fail
      assert.equal(raised, false, `raise() must fail for disallowed model "${tc.badModel}"`);
      assert.ok(caughtError instanceof SkeletonSupervisorError);
      assert.equal(caughtError.reason, MODEL_MISMATCH_REASON);

      // 2. Supervisor state MUST be "failed"
      assert.equal(supervisor.getState(), "failed");
      assert.equal(supervisor.getFailureReason(), MODEL_MISMATCH_REASON);

      // 3. Attempting to prompt MUST reject
      await assert.rejects(
        () => supervisor.prompt("Execute task instructions"),
        (err: any) => err instanceof SkeletonSupervisorError && err.reason === MODEL_MISMATCH_REASON
      );

      // 4. Attempting to dispatchTask MUST reject
      await assert.rejects(
        () => supervisor.dispatchTask("Execute task instructions"),
        (err: any) => err instanceof SkeletonSupervisorError && err.reason === MODEL_MISMATCH_REASON
      );

      // 5. Attempting to steer MUST reject
      await assert.rejects(
        () => supervisor.steer("Correction text"),
        (err: any) => err instanceof SkeletonSupervisorError && err.reason === MODEL_MISMATCH_REASON
      );

      // 6. INVARIANT: Exactly 0 session/prompt requests were sent to the ACP process
      assert.equal(
        recorded.sessionPromptCount,
        0,
        `Zero session/prompt must be sent when model "${tc.badModel}" is outside allowlist`
      );
      assert.equal(recorded.promptsSent.length, 0);

      await supervisor.finish();
    }
  });

  it("Property 17.6 (P17 core): SkeletonSupervisor sends ZERO session/prompt when active model differs from role tier (Requirements 15.5, 15.6)", async () => {
    // Test matrix of role vs differing allowed model
    const testCases: Array<{
      role: SkeletonRole;
      hard: boolean;
      wrongAllowedModel: AllowedModelId;
      expectedModel: AllowedModelId;
    }> = [
      // Planner expects Opus 5.5, returned Sonnet 5.5
      {
        role: "planner",
        hard: false,
        wrongAllowedModel: CLAUDE_SONNET_5_5_MODEL_ID,
        expectedModel: CLAUDE_OPUS_5_5_MODEL_ID,
      },
      // Planner expects Opus 5.5, returned Haiku 5.5
      {
        role: "planner",
        hard: false,
        wrongAllowedModel: CLAUDE_HAIKU_5_5_MODEL_ID,
        expectedModel: CLAUDE_OPUS_5_5_MODEL_ID,
      },
      // Warden expects Opus 5.5, returned Sonnet 5.5
      {
        role: "warden",
        hard: false,
        wrongAllowedModel: CLAUDE_SONNET_5_5_MODEL_ID,
        expectedModel: CLAUDE_OPUS_5_5_MODEL_ID,
      },
      // Bonesetter expects Sonnet 5.5, returned Opus 5.5
      {
        role: "bonesetter",
        hard: false,
        wrongAllowedModel: CLAUDE_OPUS_5_5_MODEL_ID,
        expectedModel: CLAUDE_SONNET_5_5_MODEL_ID,
      },
      // Soul-stitcher without hard expects Sonnet 5.5, returned Opus 5.5
      {
        role: "soul-stitcher",
        hard: false,
        wrongAllowedModel: CLAUDE_OPUS_5_5_MODEL_ID,
        expectedModel: CLAUDE_SONNET_5_5_MODEL_ID,
      },
      // Soul-stitcher WITH hard: yes expects Opus 5.5, returned Sonnet 5.5
      {
        role: "soul-stitcher",
        hard: true,
        wrongAllowedModel: CLAUDE_SONNET_5_5_MODEL_ID,
        expectedModel: CLAUDE_OPUS_5_5_MODEL_ID,
      },
      // Exhumer expects Haiku 5.5, returned Sonnet 5.5
      {
        role: "exhumer",
        hard: false,
        wrongAllowedModel: CLAUDE_SONNET_5_5_MODEL_ID,
        expectedModel: CLAUDE_HAIKU_5_5_MODEL_ID,
      },
      // Scribe expects Haiku 5.5, returned Opus 5.5
      {
        role: "scribe",
        hard: false,
        wrongAllowedModel: CLAUDE_OPUS_5_5_MODEL_ID,
        expectedModel: CLAUDE_HAIKU_5_5_MODEL_ID,
      },
    ];

    for (const tc of testCases) {
      const mockChild = new MockAcpChildProcess();
      const recorded = attachMockAcpAgent(mockChild, {
        sessionResponse: {
          sessionId: `sess-diff-${tc.role}`,
          modeId: tc.role,
          configOptions: [{ id: "model", value: tc.wrongAllowedModel }],
        },
      });

      const supervisor = createSkeletonSupervisor({
        runId: "run-prop-tier-diff",
        cancelGracePeriodMs: 1,
        skeletonId: `skel-${tc.role}-tier-diff`,
        role: tc.role,
        hard: tc.hard,
        cwd: "/data/runs/test-run/wt",
        quarantineDir: "/tmp/run-prop-tier-diff-quarantine",
        spawnFn: () => mockChild,
        brokerOptions: getRequiredBrokerSettings(),
      });

      let raised = false;
      let caughtError: any = null;

      try {
        await supervisor.raise();
        raised = true;
      } catch (err: any) {
        caughtError = err;
      }

      // 1. raise() MUST fail
      assert.equal(
        raised,
        false,
        `raise() must fail when role ${tc.role} gets ${tc.wrongAllowedModel} instead of ${tc.expectedModel}`
      );
      assert.ok(caughtError instanceof SkeletonSupervisorError);
      assert.equal(caughtError.reason, MODEL_MISMATCH_REASON);

      // 2. Supervisor state MUST be "failed"
      assert.equal(supervisor.getState(), "failed");
      assert.equal(supervisor.getFailureReason(), MODEL_MISMATCH_REASON);

      // 3. Attempting to prompt MUST reject
      await assert.rejects(
        () => supervisor.prompt("Execute task instructions"),
        (err: any) => err instanceof SkeletonSupervisorError && err.reason === MODEL_MISMATCH_REASON
      );

      // 4. Attempting to dispatchTask MUST reject
      await assert.rejects(
        () => supervisor.dispatchTask("Execute task instructions"),
        (err: any) => err instanceof SkeletonSupervisorError && err.reason === MODEL_MISMATCH_REASON
      );

      // 5. INVARIANT: Exactly 0 session/prompt requests were sent to ACP
      assert.equal(
        recorded.sessionPromptCount,
        0,
        `Zero session/prompt must be sent when model ${tc.wrongAllowedModel} differs from tier for role ${tc.role}`
      );
      assert.equal(recorded.promptsSent.length, 0);

      await supervisor.finish();
    }
  });

  it("Property 17.7: SkeletonSupervisor permits session/prompt when active model matches role tier (Requirements 15.5, 15.8, 16.10)", async () => {
    // Valid role and tier combinations
    const validCases: Array<{
      role: SkeletonRole;
      hard: boolean;
      model: AllowedModelId;
    }> = [
      { role: "planner", hard: false, model: CLAUDE_OPUS_5_5_MODEL_ID },
      { role: "warden", hard: false, model: CLAUDE_OPUS_5_5_MODEL_ID },
      { role: "bonesetter", hard: false, model: CLAUDE_SONNET_5_5_MODEL_ID },
      { role: "soul-stitcher", hard: false, model: CLAUDE_SONNET_5_5_MODEL_ID },
      { role: "soul-stitcher", hard: true, model: CLAUDE_OPUS_5_5_MODEL_ID },
      { role: "exhumer", hard: false, model: CLAUDE_HAIKU_5_5_MODEL_ID },
      { role: "scribe", hard: false, model: CLAUDE_HAIKU_5_5_MODEL_ID },
    ];

    for (const tc of validCases) {
      const mockChild = new MockAcpChildProcess();
      const recorded = attachMockAcpAgent(mockChild, {
        sessionResponse: {
          sessionId: `sess-ok-${tc.role}`,
          modeId: tc.role,
          configOptions: [{ id: "model", value: tc.model }],
        },
      });

      let raisedEventReceived: SkeletonRaisedEvent | null = null;

      const supervisor = createSkeletonSupervisor({
        runId: "run-prop-ok",
        cancelGracePeriodMs: 1,
        skeletonId: `skel-${tc.role}-ok`,
        role: tc.role,
        hard: tc.hard,
        cwd: "/data/runs/test-run/wt",
        quarantineDir: "/tmp/run-prop-ok-quarantine",
        spawnFn: () => mockChild,
        brokerOptions: getRequiredBrokerSettings(),
        onEvent: (event) => {
          if (event.kind === "skeleton.raised") {
            raisedEventReceived = event;
          }
        },
      });

      const raised = await supervisor.raise();

      assert.equal(supervisor.getState(), "raised");
      assert.equal(raised.modelId, tc.model);
      assert.equal(raised.sessionId, `sess-ok-${tc.role}`);
      assert.ok(raisedEventReceived);
      assert.equal((raisedEventReceived as SkeletonRaisedEvent).modelId, tc.model);

      // Now prompt the skeleton
      const promptResult: any = await supervisor.prompt("Execute verified task");
      assert.equal(promptResult?.status, "completed");

      // Verify that exactly ONE session/prompt was sent
      assert.equal(recorded.sessionPromptCount, 1);
      assert.equal(recorded.promptsSent.length, 1);
      assert.equal(recorded.promptsSent[0].sessionId, `sess-ok-${tc.role}`);
      assert.equal(recorded.promptsSent[0].prompt, "Execute verified task");

      await supervisor.finish();
    }
  });

  it("Requirements 17.1-17.4: Headless Fallback activates on P1 failure, enforces role model allowlist, and writes stream", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "gg-test-headless-prop-"));

    const roles: Array<{ role: SkeletonRole; hard: boolean; expectedModel: AllowedModelId }> = [
      { role: "planner", hard: false, expectedModel: CLAUDE_OPUS_5_5_MODEL_ID },
      { role: "warden", hard: false, expectedModel: CLAUDE_OPUS_5_5_MODEL_ID },
      { role: "bonesetter", hard: false, expectedModel: CLAUDE_SONNET_5_5_MODEL_ID },
      { role: "soul-stitcher", hard: false, expectedModel: CLAUDE_SONNET_5_5_MODEL_ID },
      { role: "soul-stitcher", hard: true, expectedModel: CLAUDE_OPUS_5_5_MODEL_ID },
      { role: "exhumer", hard: false, expectedModel: CLAUDE_HAIKU_5_5_MODEL_ID },
      { role: "scribe", hard: false, expectedModel: CLAUDE_HAIKU_5_5_MODEL_ID },
    ];

    for (const item of roles) {
      const capturedCommands: Array<{ command: string; args: string[] }> = [];
      const cliSessionId = `cli-sess-${item.role}`;

      const supervisor = createSkeletonSupervisor({
        runId: `run-headless-${item.role}`,
        skeletonId: `skel-headless-${item.role}`,
        role: item.role,
        hard: item.hard,
        cwd: path.join(tmpBase, "wt"),
        baseDir: tmpBase,
        quarantineDir: path.join(tmpBase, "quarantine"),
        channel: "Headless_Fallback",
        probeResults: {
          P1: { id: "P1", passed: false, reason: "headless API key verification failed" },
          P14: { id: "P14", passed: true },
        },
        gatewayToolIds: ["sandbox_exec", "sandbox_log"],
        cancelGracePeriodMs: 1,
        brokerOptions: getRequiredBrokerSettings(),
        // The required auto-deny hook must be present or the channel fails closed.
        onAskAutoDeny: () => {},
        spawnFn: (cmd: string, args: readonly string[], options: SpawnOptions) => {
          capturedCommands.push({ command: cmd, args: [...args] });
          const child = new MockAcpChildProcess();
          // Stream a valid session record matching the role tier and close cleanly,
          // asynchronously, so the awaited prompt()/steer() observes the real result.
          setImmediate(() => {
            child.stdout.write(
              JSON.stringify({
                type: "session",
                sessionId: cliSessionId,
                model: item.expectedModel,
              }) + "\n"
            );
            child.stdout.write(
              JSON.stringify({ type: "assistant", text: "headless ok" }) + "\n"
            );
            child.stdout.end();
            setImmediate(() => {
              child.exitCode = 0;
              child.emit("close", 0);
            });
          });
          return child;
        },
      });

      // 1. Channel selection (Requirement 17.1)
      assert.equal(supervisor.getExecutionChannel(), "Headless_Fallback");

      const raised = await supervisor.raise();
      assert.equal(supervisor.getState(), "raised");
      assert.equal(raised.modelId, item.expectedModel);

      // 2. Await the headless turn and assert the real awaited result.
      const promptResult: any = await supervisor.prompt("Headless turn task");
      assert.equal(promptResult.status, "complete");
      assert.equal(promptResult.sessionId, cliSessionId);
      assert.ok(promptResult.output.includes("headless ok"));

      assert.equal(capturedCommands.length, 1);
      const promptCmd = capturedCommands[0];
      assert.equal(promptCmd.command, "kiro-cli");
      assert.ok(promptCmd.args.includes("chat"));
      assert.ok(promptCmd.args.includes("--v3"));
      assert.ok(promptCmd.args.includes("--no-interactive"));
      assert.ok(promptCmd.args.includes("--agent"));
      assert.equal(promptCmd.args[promptCmd.args.indexOf("--agent") + 1], item.role);
      assert.ok(promptCmd.args.includes("--model"));
      assert.equal(promptCmd.args[promptCmd.args.indexOf("--model") + 1], item.expectedModel);
      assert.ok(isAllowedModelId(item.expectedModel));
      assert.ok(promptCmd.args.includes("--require-mcp-startup"));
      assert.ok(promptCmd.args.includes("--output-format"));
      assert.equal(promptCmd.args[promptCmd.args.indexOf("--output-format") + 1], "stream-json");
      assert.ok(promptCmd.args.includes("--trust-tools"));
      assert.equal(promptCmd.args[promptCmd.args.indexOf("--trust-tools") + 1], "sandbox_exec,sandbox_log");
      // The first headless turn is never a resume.
      assert.ok(!promptCmd.args.includes("--resume-id"));

      // 3. Raw output written to disk OUTSIDE the worktree (Requirement 17.4)
      const sessionsDir = supervisor.getPaths().sessionsDir;
      assert.equal(
        promptResult.rawLogPath,
        path.join(sessionsDir, "headless-stream.jsonl")
      );
      assert.ok(fs.existsSync(promptResult.rawLogPath));
      assert.ok(!promptResult.rawLogPath.startsWith(`${supervisor.cwd}${path.sep}`));
      assert.ok(!fs.existsSync(path.join(supervisor.cwd, "headless-stream.jsonl")));

      // 4. Correction resumes with the REAL CLI session id (Requirement 17.3)
      await supervisor.steer("Correction via resume-id");
      assert.equal(capturedCommands.length, 2);
      const steerCmd = capturedCommands[1];
      assert.equal(steerCmd.command, "kiro-cli");
      assert.ok(steerCmd.args.includes("--resume-id"));
      assert.equal(steerCmd.args[steerCmd.args.indexOf("--resume-id") + 1], cliSessionId);
      assert.ok(steerCmd.args.includes("--model"));
      assert.equal(steerCmd.args[steerCmd.args.indexOf("--model") + 1], item.expectedModel);

      await supervisor.finish();
    }

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
});
