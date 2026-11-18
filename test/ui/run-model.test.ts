import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRunEvents,
  buildRunView,
  createRunView,
  elapsedSeconds,
  mergedTaskCount,
  openAsks,
  pendingApprovals,
  type RunEvent,
} from "@/lib/ui/run-model";

// Payload shapes below are the ones the backend writes:
// start-run/route.ts (queue), lifecycle-manager.ts (run.phase),
// exhume-harness.ts (command.*, exhume.certificate), approval-manager.ts,
// collaboration-tools.ts (ask.*, task.state), event-tap.ts (skeleton.*),
// control/route.ts (run.clock pause/resume, run.done).
let seq = 0;
function ev(kind: string, data: Record<string, unknown> = {}, extra: Partial<RunEvent> = {}): RunEvent {
  seq += 1;
  return { seq, ts: 1_000_000 + seq * 1000, kind, actor: "test", data, ...extra };
}

function journey(): RunEvent[] {
  seq = 0;
  return [
    ev("run.queued", { queuePosition: 2, url: "https://github.com/o/r", sha: "HEAD" }),
    ev("run.queue_position", { queuePosition: 2 }),
    ev("run.queue_position", { queuePosition: 1 }),
    ev("run.phase", { phase: "exhume", previousPhase: "queued" }),
    ev("command.started", { argv: ["npm", "ci"], commandLine: "npm ci", step: "install" }),
    ev("command.result", {
      argv: ["npm", "ci"],
      commandLine: "npm ci",
      step: "install",
      exitCode: 1,
      status: "failed",
      durationMs: 4200,
      stderrTail: "ERESOLVE unable to resolve dependency tree",
    }),
    ev("exhume.certificate", {
      baseSha: "abc1234",
      healthy: false,
      failureClasses: ["install_failed"],
      sha256: "f".repeat(64),
    }),
    ev("run.phase", { phase: "plan", previousPhase: "exhume" }),
    ev("run.phase", { phase: "pact_review", previousPhase: "plan" }),
    ev("pact.approved", { pactVersion: 2, approvedTaskIds: ["T1"], caps: { maxToolCalls: 80 } }),
    ev("run.phase", { phase: "legion", previousPhase: "pact_review" }),
    ev("skeleton.raised", { role: "bonesetter", agent: "bonesetter" }, { skeletonId: "sk-1", taskId: "T1" }),
    ev("skeleton.tool_call", { tool: "sandbox_exec", toolCallId: "tc-1", arguments: { argv: ["npm", "test"] } }, { skeletonId: "sk-1" }),
    ev("approval.requested", { approvalId: "ap-1", argv: ["npm", "install", "left-pad"], cwd: "/workspace", expiresAt: 2_000_000 }, { skeletonId: "sk-1" }),
    ev("ask.raised", { askId: "ask-1", question: "Keep the legacy build script?" }, { skeletonId: "sk-1" }),
    ev("task.state", { taskId: "T1", status: "in_review", summary: "candidate submitted" }, { skeletonId: "sk-1" }),
  ];
}

describe("run-model reducer", () => {
  it("starts with nothing invented", () => {
    const view = createRunView();
    assert.equal(view.phase, "unknown");
    assert.equal(view.outcome, null);
    assert.equal(view.queuePosition, null);
    assert.equal(view.caps, null);
    assert.equal(view.certificate, null);
    assert.equal(view.commands.length, 0);
    assert.equal(elapsedSeconds(view, Date.now()), 0);
  });

  it("reads queuePosition, the field start-run writes", () => {
    const view = buildRunView(journey().slice(0, 3));
    assert.equal(view.phase, "queued");
    assert.equal(view.queuePosition, 1);
  });

  it("a late queue update does not pull a started run back to queued", () => {
    const events = journey().slice(0, 4);
    const late: RunEvent = { seq: 99, kind: "run.queue_position", data: { queuePosition: 0 } };
    const view = buildRunView([...events, late]);
    assert.equal(view.phase, "exhume");
  });

  it("builds command rows from commandLine and pairs result with start", () => {
    const view = buildRunView(journey().slice(0, 6));
    assert.equal(view.commands.length, 1);
    const row = view.commands[0];
    assert.equal(row.command, "npm ci");
    assert.equal(row.step, "install");
    assert.equal(row.status, "failed");
    assert.equal(row.exitCode, 1);
    assert.equal(row.durationMs, 4200);
    assert.match(row.errorExcerpt ?? "", /ERESOLVE/);
  });

  it("keeps only what exhume.certificate reported", () => {
    const view = buildRunView(journey().slice(0, 7));
    assert.deepEqual(view.certificate, {
      baseSha: "abc1234",
      healthy: false,
      failureClasses: ["install_failed"],
      sha256: "f".repeat(64),
      recordedAt: 1_000_000 + 7 * 1000,
    });
  });

  it("follows phases, pact approval and caps", () => {
    const view = buildRunView(journey());
    assert.equal(view.phase, "legion");
    assert.equal(view.pact.approved, true);
    assert.equal(view.pact.version, 2);
    assert.deepEqual(view.caps, { maxToolCalls: 80 });
    assert.equal(view.startedAt, 1_000_000 + 4 * 1000);

    const budgetView = buildRunView([
      ev("pact.approved", {
        pactVersion: 1,
        approvedTaskIds: ["T1"],
        budget: { maxMinutes: 30, maxParallel: 2, maxToolCalls: 80 },
      }),
    ]);
    assert.deepEqual(budgetView.caps, { maxMinutes: 30, maxParallel: 2, maxToolCalls: 80 });
  });

  it("tracks skeletons, tool calls, approvals, asks and tasks", () => {
    const view = buildRunView(journey());
    assert.equal(view.skeletons.length, 1);
    const sk = view.skeletons[0];
    assert.equal(sk.role, "bonesetter");
    assert.equal(sk.toolCallsCount, 1);
    assert.equal(sk.currentToolCall?.tool, "sandbox_exec");
    assert.deepEqual(sk.taskIds, ["T1"]);
    assert.equal(view.toolCalls, 1);

    const approvals = pendingApprovals(view);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].command, "npm install left-pad");

    const asks = openAsks(view);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].question, "Keep the legacy build script?");

    assert.deepEqual(view.tasks, [
      { taskId: "T1", state: "in_review", summary: "candidate submitted" },
    ]);
  });

  it("is idempotent: stored log followed by a stream replay from seq 1", () => {
    const events = journey();
    const once = buildRunView(events);
    const twice = applyRunEvents(once, events);
    assert.equal(twice, once, "re-applying seen events returns the same view");

    const interleaved = applyRunEvents(buildRunView(events.slice(0, 10)), events);
    assert.equal(interleaved.channel.length, once.channel.length);
    assert.equal(interleaved.toolCalls, once.toolCalls);
    assert.equal(interleaved.skeletons[0].toolCallsCount, 1);
    assert.equal(interleaved.commands.length, 1);
    assert.equal(new Set(interleaved.channel.map((c) => c.id)).size, interleaved.channel.length);
  });

  it("does not mutate the previous view", () => {
    const events = journey();
    const before = buildRunView(events.slice(0, 12));
    const snapshot = JSON.stringify({ ...before, seen: [...before.seen] });
    applyRunEvents(before, events);
    assert.equal(JSON.stringify({ ...before, seen: [...before.seen] }), snapshot);
  });

  it("resolves approvals and asks", () => {
    const events = journey();
    const next = applyRunEvents(buildRunView(events), [
      { seq: 50, ts: 1, kind: "approval.resolved", actor: "user", data: { approvalId: "ap-1", decision: "approved" } },
      { seq: 51, ts: 2, kind: "ask.answered", actor: "user", data: { askId: "ask-1", answer: "Yes, keep it" } },
    ]);
    assert.equal(pendingApprovals(next).length, 0);
    assert.equal(next.approvals[0].resolution, "approved");
    assert.equal(openAsks(next).length, 0);
    assert.equal(next.asks[0].answer, "Yes, keep it");
    assert.ok(next.channel.some((c) => c.askId === "ask-1" && c.answered === true));
  });

  it("recovers pause and resume from run.clock", () => {
    const base = buildRunView(journey());
    const paused = applyRunEvents(base, [
      { seq: 60, kind: "run.clock", data: { action: "pause", reason: "User pause action" } },
    ]);
    assert.equal(paused.paused, true);
    const resumed = applyRunEvents(paused, [
      { seq: 61, kind: "run.clock", data: { action: "resume" } },
    ]);
    assert.equal(resumed.paused, false);
  });

  it("records terminal outcome from run.done and from run.phase", () => {
    const stopped = applyRunEvents(buildRunView(journey()), [
      { seq: 70, ts: 1_100_000, kind: "run.done", data: { phase: "done", outcome: "cancelled", reason: "User stop action" } },
      { seq: 71, ts: 1_100_001, kind: "run.phase", data: { from: "legion", to: "done", outcome: "cancelled" } },
    ]);
    assert.equal(stopped.phase, "done");
    assert.equal(stopped.outcome, "cancelled");
    assert.equal(stopped.error, null);
    assert.equal(stopped.endedAt, 1_100_000);

    const failed = applyRunEvents(buildRunView(journey()), [
      { seq: 70, kind: "run.done", data: { outcome: "error", reason: "Fatal quarantine" } },
    ]);
    assert.equal(failed.outcome, "error");
    assert.equal(failed.error, "Fatal quarantine");
  });

  it("counts merged tasks and marks failed skeletons", () => {
    const view = applyRunEvents(buildRunView(journey()), [
      { seq: 80, kind: "task.merged", taskId: "T1", attempt: 1, data: { taskId: "T1", attempt: 1 } },
      { seq: 81, kind: "skeleton.failed", skeletonId: "sk-1", data: { reason: "quarantined" } },
    ]);
    assert.equal(mergedTaskCount(view), 1);
    assert.equal(view.skeletons[0].state, "failed");
    assert.equal(view.skeletons[0].currentToolCall, null);
    assert.ok(view.skeletons[0].logs.includes("Failed: quarantined"));
  });

  it("ignores malformed entries", () => {
    const view = buildRunView([null, 42, { kind: "run.phase" }, { seq: 1 }, "x"]);
    assert.equal(view.lastSeq, 0);
    assert.equal(view.phase, "unknown");
  });
});
