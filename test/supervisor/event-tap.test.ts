// Test suite for Task 9.6: EventTap update stream processor and usage routing
// Requirements: 16.11, 16.19, 16.20

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { EventStore } from "../../lib/events/event-store";
import {
  createDefaultCanaryTokens,
  type CanaryTokenSet,
} from "../../lib/security/canary";
import {
  createEventTap,
  EventTap,
  isAgentText,
  isSessionInfoWithTurnCompletion,
  isToolCall,
  isToolResult,
  SupervisorEventTap,
} from "../../lib/supervisor/event-tap";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
} from "../../lib/supervisor/skeleton-supervisor";
import { getRequiredBrokerSettings } from "./fixtures";
import type { ChildProcessLike } from "../../lib/supervisor/types";

class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 7777;
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | string | null = null;

  constructor() {
    super();
  }

  public kill(signal?: NodeJS.Signals | number | string): boolean {
    this.killed = true;
    return true;
  }
}

test("Task 9.6: Maps tool calls to skeleton.tool_call and skeleton.tool_result (Requirement 16.19)", async () => {
  const eventStore = new EventStore(":memory:");
  const eventTap = new EventTap({
    runId: "run-test-01",
    skeletonId: "skel-bonesetter",
    taskId: "T9.6",
    role: "bonesetter",
    eventStore,
  });

  // 1. Tool call start
  const callUpdates = await eventTap.processUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-99",
    tool: "sandbox_exec",
    arguments: { argv: ["npm", "test"] },
  });

  assert.equal(callUpdates.length, 1);
  const callEvent = callUpdates[0];
  assert.equal(callEvent.kind, "skeleton.tool_call");
  assert.equal(callEvent.runId, "run-test-01");
  assert.equal(callEvent.skeletonId, "skel-bonesetter");
  assert.equal(callEvent.taskId, "T9.6");
  assert.equal(callEvent.data.toolCallId, "call-99");
  assert.equal(callEvent.data.tool, "sandbox_exec");
  assert.deepEqual(callEvent.data.arguments, { argv: ["npm", "test"] });
  assert.ok(Array.isArray(callEvent.data.refs));

  // 2. Tool result completion
  const resultUpdates = await eventTap.processUpdate({
    sessionUpdate: "tool_result",
    toolCallId: "call-99",
    result: { exit_code: 0, stdout_tail: "tests pass" },
    status: "completed",
  });

  assert.equal(resultUpdates.length, 1);
  const resultEvent = resultUpdates[0];
  assert.equal(resultEvent.kind, "skeleton.tool_result");
  assert.equal(resultEvent.runId, "run-test-01");
  assert.equal(resultEvent.skeletonId, "skel-bonesetter");
  assert.equal(resultEvent.taskId, "T9.6");
  assert.equal(resultEvent.data.toolCallId, "call-99");
  assert.equal(resultEvent.data.status, "completed");
  assert.deepEqual(resultEvent.data.result, { exit_code: 0, stdout_tail: "tests pass" });

  // 3. Nested toolCall format from ACP
  const nestedUpdates = await eventTap.processUpdate({
    sessionId: "sess-1",
    update: {
      sessionUpdate: "tool_call",
      toolCall: {
        id: "call-100",
        name: "report_task_result",
        arguments: { taskId: "T9.6", status: "success" },
      },
    },
  });

  assert.equal(nestedUpdates.length, 1);
  assert.equal(nestedUpdates[0].kind, "skeleton.tool_call");
  assert.equal(nestedUpdates[0].data.toolCallId, "call-100");
  assert.equal(nestedUpdates[0].data.tool, "report_task_result");

  eventTap.close();
});

test("Task 9.6: Maps agent text to skeleton.log events with stream agent (Requirement 16.19)", async () => {
  const eventStore = new EventStore(":memory:");
  const eventTap = new EventTap({
    runId: "run-test-02",
    skeletonId: "skel-planner",
    taskId: "T9.6",
    role: "planner",
    eventStore,
  });

  // Agent message
  const updates1 = await eventTap.processUpdate({
    sessionUpdate: "agent_message",
    text: "Reviewing repository structure for modernization.",
  });

  assert.equal(updates1.length, 1);
  const logEvent1 = updates1[0];
  assert.equal(logEvent1.kind, "skeleton.log");
  assert.equal(logEvent1.data.stream, "agent");
  assert.equal(logEvent1.data.text, "Reviewing repository structure for modernization.");
  assert.equal(logEvent1.runId, "run-test-02");
  assert.equal(logEvent1.skeletonId, "skel-planner");
  assert.equal(logEvent1.taskId, "T9.6");

  // Agent delta text
  const updates2 = await eventTap.processUpdate({
    sessionUpdate: "agent_message_delta",
    delta: "Found 3 manifest files.",
  });

  assert.equal(updates2.length, 1);
  const logEvent2 = updates2[0];
  assert.equal(logEvent2.kind, "skeleton.log");
  assert.equal(logEvent2.data.stream, "agent");
  assert.equal(logEvent2.data.text, "Found 3 manifest files.");

  eventTap.close();
});

test("Task 9.6: Maps session_info_update with turn_completion to skeleton.usage (Requirement 16.19)", async () => {
  const eventStore = new EventStore(":memory:");
  const eventTap = new EventTap({
    runId: "run-test-03",
    skeletonId: "skel-soul-stitcher",
    taskId: "T9.6",
    role: "soul-stitcher",
    eventStore,
  });

  // session_info_update with turn_completion and credits
  const updates1 = await eventTap.processUpdate({
    sessionUpdate: "session_info_update",
    turn_completion: {
      credits: 25,
      tokens: { input: 1200, output: 450, total: 1650 },
      inputTokens: 1200,
      outputTokens: 450,
      totalTokens: 1650,
      durationMs: 3400,
      model: "claude-sonnet-5.5",
    },
  });

  assert.equal(updates1.length, 1);
  const usageEvent1 = updates1[0];
  assert.equal(usageEvent1.kind, "skeleton.usage");
  assert.equal(usageEvent1.runId, "run-test-03");
  assert.equal(usageEvent1.skeletonId, "skel-soul-stitcher");
  assert.equal(usageEvent1.taskId, "T9.6");
  assert.equal(usageEvent1.data.credits, 25);
  assert.equal(usageEvent1.data.totalTokens, 1650);
  assert.equal(usageEvent1.data.durationMs, 3400);

  // session_info_update when CLI does not report credits (probe P5: credits is null)
  const updates2 = await eventTap.processUpdate({
    sessionUpdate: "session_info_update",
    turn_completion: {
      tokens: { input: 500, output: 100 },
      totalTokens: 600,
    },
  });

  assert.equal(updates2.length, 1);
  const usageEvent2 = updates2[0];
  assert.equal(usageEvent2.kind, "skeleton.usage");
  assert.equal(usageEvent2.data.credits, null);

  eventTap.close();
});

test("Task 9.6: Routes context_usage received in session/update directly to BudgetGovernor (Requirement 16.20)", async () => {
  const eventStore = new EventStore(":memory:");
  const receivedContextUsage: Array<{ usage: any; context: any }> = [];

  const mockBudgetGovernor = {
    recordContextUsage: async (usage: unknown, context?: any) => {
      receivedContextUsage.push({ usage, context });
    },
  };

  const eventTap = new EventTap({
    runId: "run-test-04",
    skeletonId: "skel-scribe",
    taskId: "T9.6",
    role: "scribe",
    eventStore,
    budgetGovernor: mockBudgetGovernor,
  });

  // Direct context_usage update
  await eventTap.processUpdate({
    sessionUpdate: "context_usage",
    context_usage: {
      tokensUsed: 45000,
      maxTokens: 200000,
      ratio: 0.225,
    },
  });

  assert.equal(receivedContextUsage.length, 1);
  assert.equal(receivedContextUsage[0].usage.tokensUsed, 45000);
  assert.equal(receivedContextUsage[0].context.runId, "run-test-04");
  assert.equal(receivedContextUsage[0].context.skeletonId, "skel-scribe");
  assert.equal(receivedContextUsage[0].context.taskId, "T9.6");

  // Combined session_info_update with turn_completion AND context_usage
  const combinedUpdates = await eventTap.processUpdate({
    sessionUpdate: "session_info_update",
    turn_completion: {
      credits: 10,
      totalTokens: 800,
    },
    context_usage: {
      tokensUsed: 45800,
      maxTokens: 200000,
    },
  });

  assert.equal(combinedUpdates.length, 1);
  assert.equal(combinedUpdates[0].kind, "skeleton.usage");
  assert.equal(receivedContextUsage.length, 2);
  assert.equal(receivedContextUsage[1].usage.tokensUsed, 45800);

  eventTap.close();
});

test("Task 9.6: Tags events with run, Skeleton, task, and toolCallId (Requirement 16.11)", async () => {
  const eventStore = new EventStore(":memory:");
  const eventTap = new EventTap({
    runId: "run-tag-01",
    skeletonId: "skel-warden",
    taskId: "T9.6",
    role: "warden",
    eventStore,
  });

  // 1. Tool call tagged with toolCallId
  const toolCallEvents = await eventTap.processUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-tag-abc",
    tool: "warden_verdict",
    arguments: { target: "T9.6", verdict: "approve" },
  });

  assert.equal(toolCallEvents.length, 1);
  const tc = toolCallEvents[0];
  assert.equal(tc.runId, "run-tag-01");
  assert.equal(tc.skeletonId, "skel-warden");
  assert.equal(tc.taskId, "T9.6");
  assert.equal(tc.data.toolCallId, "call-tag-abc");
  assert.equal(tc.data.runId, "run-tag-01");
  assert.equal(tc.data.skeletonId, "skel-warden");
  assert.equal(tc.data.taskId, "T9.6");

  // 2. Mid-tool agent log receives active toolCallId tag
  const logEvents = await eventTap.processUpdate({
    sessionUpdate: "agent_message",
    text: "Inspecting verification gate result.",
  });

  assert.equal(logEvents.length, 1);
  assert.equal(logEvents[0].data.toolCallId, "call-tag-abc");
  assert.equal(logEvents[0].runId, "run-tag-01");
  assert.equal(logEvents[0].taskId, "T9.6");

  // 3. Tool result receives toolCallId tag and completes the tool call
  const toolResultEvents = await eventTap.processUpdate({
    sessionUpdate: "tool_result",
    toolCallId: "call-tag-abc",
    result: { approved: true },
  });

  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].data.toolCallId, "call-tag-abc");

  // 4. Subsequent log after tool call completion has no active toolCallId
  const subsequentLogs = await eventTap.processUpdate({
    sessionUpdate: "agent_message",
    text: "Autopsy finished.",
  });

  assert.equal(subsequentLogs.length, 1);
  assert.equal(subsequentLogs[0].data.toolCallId, undefined);

  eventTap.close();
});

test("Task 9.6: Redacts secrets before persisting to EventStore (Requirement 16.11)", async () => {
  const eventStore = new EventStore(":memory:");
  const tokens: CanaryTokenSet = createDefaultCanaryTokens();

  const customSecret = ["secret", "token", "super", "private"].join("_");

  const eventTap = new EventTap({
    runId: "run-redact-01",
    skeletonId: "skel-exhumer",
    taskId: "T9.6",
    role: "exhumer",
    eventStore,
    secrets: [customSecret],
  });

  // Tool call with secret in arguments
  const callUpdates = await eventTap.processUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-sec-01",
    tool: "sandbox_exec",
    arguments: {
      argv: ["echo", tokens.ksk, tokens.ghp, customSecret],
      command: `export TOKEN=${tokens.ghp}`,
    },
  });

  assert.equal(callUpdates.length, 1);
  const callEvt = callUpdates[0];
  const callStr = JSON.stringify(callEvt);

  assert.ok(!callStr.includes(tokens.ksk));
  assert.ok(!callStr.includes(tokens.ghp));
  assert.ok(!callStr.includes(customSecret));
  assert.ok(callStr.includes("[REDACTED]"));

  // Check that the persisted event in EventStore is also redacted
  const storedEvents = eventStore.getEvents("run-redact-01");
  assert.equal(storedEvents.length, 1);
  const storedStr = JSON.stringify(storedEvents[0]);
  assert.ok(!storedStr.includes(tokens.ksk));
  assert.ok(!storedStr.includes(tokens.ghp));
  assert.ok(!storedStr.includes(customSecret));

  // Log with secret in agent text
  const logUpdates = await eventTap.processUpdate({
    sessionUpdate: "agent_message",
    text: `Found key in config: ${tokens.githubPat}`,
  });

  assert.equal(logUpdates.length, 1);
  const logText = String(logUpdates[0].data.text);
  assert.ok(!logText.includes(tokens.githubPat));
  assert.ok(logText.includes("[REDACTED]"));

  eventTap.close();
});

test("Task 9.6: Persists to EventStore before SSE distribution (Requirement 16.11)", async () => {
  const eventStore = new EventStore(":memory:");
  const distributionLog: Array<{ eventSeq: number; storeCountAtTime: number }> = [];

  const sseDistributor = async (envelope: any) => {
    // Assert that at the exact time SSE distribution is called,
    // the event is ALREADY committed in EventStore and can be read by seq
    const stored = eventStore.getEvents("run-persist-01");
    const count = stored.length;
    const matching = stored.find((e) => e.seq === envelope.seq);
    assert.ok(matching !== undefined, "Event must be in EventStore before SSE distribution");
    distributionLog.push({
      eventSeq: envelope.seq,
      storeCountAtTime: count,
    });
  };

  const eventTap = new EventTap({
    runId: "run-persist-01",
    skeletonId: "skel-bonesetter",
    taskId: "T9.6",
    role: "bonesetter",
    eventStore,
    distributeSse: sseDistributor,
  });

  await eventTap.processUpdate({
    sessionUpdate: "agent_message",
    text: "Step 1: Reading manifest",
  });

  await eventTap.processUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    tool: "sandbox_exec",
    arguments: { argv: ["npm", "install"] },
  });

  await eventTap.processUpdate({
    sessionUpdate: "tool_result",
    toolCallId: "call-1",
    result: { status: "ok" },
  });

  assert.equal(distributionLog.length, 3);
  assert.equal(distributionLog[0].eventSeq, 1);
  assert.equal(distributionLog[0].storeCountAtTime, 1);
  assert.equal(distributionLog[1].eventSeq, 2);
  assert.equal(distributionLog[1].storeCountAtTime, 2);
  assert.equal(distributionLog[2].eventSeq, 3);
  assert.equal(distributionLog[2].storeCountAtTime, 3);

  eventTap.close();
});

test("Task 9.6: processStream processes multiple updates in sequence", async () => {
  const eventStore = new EventStore(":memory:");
  const eventTap = new EventTap({
    runId: "run-stream-01",
    skeletonId: "skel-soul-stitcher",
    taskId: "T9.6",
    role: "soul-stitcher",
    eventStore,
  });

  const stream = [
    { sessionUpdate: "agent_message", text: "Applying modernization patch" },
    { sessionUpdate: "tool_call", toolCallId: "call-patch", tool: "sandbox_exec", arguments: { argv: ["git", "diff"] } },
    { sessionUpdate: "tool_result", toolCallId: "call-patch", result: { stdout: "diff --git" } },
    { sessionUpdate: "session_info_update", turn_completion: { credits: 5, totalTokens: 300 } },
  ];

  const results = await eventTap.processStream(stream);

  assert.equal(results.length, 4);
  assert.equal(results[0].kind, "skeleton.log");
  assert.equal(results[1].kind, "skeleton.tool_call");
  assert.equal(results[2].kind, "skeleton.tool_result");
  assert.equal(results[3].kind, "skeleton.usage");

  eventTap.close();
});

test("Task 9.6: Integration with SkeletonSupervisor update flow", async () => {
  const eventStore = new EventStore(":memory:");
  const sseEvents: any[] = [];
  const contextUsages: any[] = [];

  const eventTap = new EventTap({
    runId: "run-sup-01",
    skeletonId: "skel-sup-01",
    role: "bonesetter",
    taskId: "T9.6",
    eventStore,
    distributeSse: (evt) => {
      sseEvents.push(evt);
    },
    budgetGovernor: (usage) => {
      contextUsages.push(usage);
    },
  });

  const supervisor = createSkeletonSupervisor({
    runId: "run-sup-01",
    skeletonId: "skel-sup-01",
    role: "bonesetter",
    cwd: "/mock/cwd",
    quarantineDir: "/tmp/run-sup-01-quarantine",
    eventTap,
    taskId: "T9.6",
    cancelGracePeriodMs: 5000,
    brokerOptions: getRequiredBrokerSettings(),
  });

  assert.equal(supervisor.getEventTap(), eventTap);
  assert.equal(supervisor.getTaskId(), "T9.6");

  // Simulate an incoming session/update through supervisor.handleUpdate (via emit update)
  (supervisor as any).handleUpdate({
    sessionUpdate: "agent_message",
    text: "Executing Bonesetter task",
  });

  // Wait for microtasks
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sseEvents.length, 1);
  assert.equal(sseEvents[0].kind, "skeleton.log");
  assert.equal(sseEvents[0].runId, "run-sup-01");
  assert.equal(sseEvents[0].skeletonId, "skel-sup-01");
  assert.equal(sseEvents[0].taskId, "T9.6");

  // Simulate tool call through supervisor
  (supervisor as any).handleUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-sup-01",
    tool: "sandbox_exec",
    arguments: { argv: ["npm", "ci"] },
    context_usage: { tokens: 1000 },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sseEvents.length, 2);
  assert.equal(sseEvents[1].kind, "skeleton.tool_call");
  assert.equal(contextUsages.length, 1);
  assert.equal(contextUsages[0].tokens, 1000);

  eventTap.close();
});
