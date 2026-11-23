/**
 * Replay shows each recorded event as one plain-English line; the raw JSON stays
 * available but collapsed. Summaries may only use fields already in the event.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { EventEnvelope } from "@/lib/events/types";
import { summarizeEvent } from "@/lib/ui/event-summary";

const RECORDED_EVENTS_PATH = join(
  process.cwd(),
  "output/recorded-runs/live-gulp-plumber-t40/events.ndjson"
);

function loadRecordedEvents(): EventEnvelope[] {
  return readFileSync(RECORDED_EVENTS_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope);
}

const recorded = loadRecordedEvents();

function recordedSeq(seq: number): EventEnvelope {
  const found = recorded.find((e) => e.seq === seq);
  assert.ok(found, `recorded event seq ${seq} must exist`);
  return found;
}

function ev(
  kind: string,
  data: Record<string, unknown> | null | undefined,
  extra: Partial<EventEnvelope> = {}
): EventEnvelope {
  return {
    runId: "run-test",
    seq: 1,
    ts: 1_700_000_000_000,
    kind,
    actor: "tester",
    data: data as EventEnvelope["data"],
    ...extra,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const BANNED = /\bsafe\b|production ready|understood|\bscore|estimat|% faster|hours saved/i;
const BROKEN = /undefined|NaN|\[object Object\]|null/;

describe("summarizeEvent: recorded run live-gulp-plumber-t40", () => {
  it("the recorded file has 66 events", () => {
    assert.equal(recorded.length, 66);
  });

  it("every recorded event gets a non-empty single line with no banned or broken words", () => {
    for (const event of recorded) {
      const summary = summarizeEvent(event);
      assert.equal(typeof summary, "string");
      assert.ok(summary.trim().length > 0, `seq ${event.seq} summary must not be empty`);
      assert.ok(!/[\r\n]/.test(summary), `seq ${event.seq} summary must be one line: ${summary}`);
      assert.ok(summary.length <= 200, `seq ${event.seq} summary too long: ${summary.length}`);
      assert.ok(!BANNED.test(summary), `seq ${event.seq} uses banned wording: ${summary}`);
      assert.ok(!BROKEN.test(summary), `seq ${event.seq} leaks a missing value: ${summary}`);
      assert.ok(
        !summary.includes(event.kind),
        `seq ${event.seq} (${event.kind}) should have a specific summary, got fallback: ${summary}`
      );
    }
  });

  it("run.phase shows the previous and new phase", () => {
    assert.equal(summarizeEvent(recordedSeq(1)), "Phase: queued → exhume");
    assert.equal(summarizeEvent(recordedSeq(16)), "Phase: plan → pact_review");
  });

  it("run.phase adds the recorded outcome when present", () => {
    assert.equal(summarizeEvent(recordedSeq(64)), "Phase: report → done (outcome: resurrected)");
  });

  it("grimoire.summary shows the recorded summary text", () => {
    assert.equal(
      summarizeEvent(recordedSeq(2)),
      "Grimoire analysis detected 0 deprecation signals on base tree"
    );
  });

  it("command.started shows the command line", () => {
    assert.equal(summarizeEvent(recordedSeq(5)), "Started: npm --version");
  });

  it("command.started builds the command from argv when there is no commandLine", () => {
    assert.equal(summarizeEvent(recordedSeq(24)), "Started: ls -a");
  });

  it("command.result shows status, exit code and duration", () => {
    assert.equal(
      summarizeEvent(recordedSeq(8)),
      "npm install --ignore-scripts passed (exit 0, 12.9s)"
    );
    assert.equal(summarizeEvent(recordedSeq(4)), "node --version passed (exit 0, 204ms)");
    assert.equal(summarizeEvent(recordedSeq(10)), "npm test failed (exit 1, 861ms)");
  });

  it("command.result without a reported status says finished, not passed or failed", () => {
    assert.equal(summarizeEvent(recordedSeq(28)), "ls -a finished (exit 0)");
    assert.equal(summarizeEvent(recordedSeq(38)), "npm test finished (exit 2)");
  });

  it("exhume.certificate shows health and failure classes", () => {
    assert.equal(
      summarizeEvent(recordedSeq(11)),
      "Death Certificate issued: baseline not healthy (test_failed)"
    );
  });

  it("skeleton.raised shows role and model", () => {
    assert.equal(
      summarizeEvent(recordedSeq(13)),
      "Skeleton raised: planner (model claude-opus-5.5)"
    );
    assert.equal(
      summarizeEvent(recordedSeq(21)),
      "Skeleton raised: soul-stitcher (model claude-opus-5.5)"
    );
  });

  it("pact.drafted shows version and task count", () => {
    assert.equal(summarizeEvent(recordedSeq(14)), "Pact v1 drafted with 1 task");
  });

  it("pact.approved shows version and approved tasks", () => {
    assert.equal(summarizeEvent(recordedSeq(17)), "Pact v1 approved (tasks: T1)");
  });

  it("task.state shows the transition and reason", () => {
    assert.equal(
      summarizeEvent(recordedSeq(19)),
      "Task T1: pending → ready (All dependencies merged)"
    );
    assert.equal(summarizeEvent(recordedSeq(20)), "Task T1: ready → running");
    assert.equal(summarizeEvent(recordedSeq(51)), "Task T1: running → in_review");
  });

  it("task.state with a status and summary shows the first line of the summary", () => {
    const summary = summarizeEvent(recordedSeq(50));
    assert.ok(
      summary.startsWith('Task T1: done — Fixed the npm test crash ("primordials is not defined")'),
      summary
    );
    assert.ok(!summary.includes("Changes:"), "only the first line of the summary is used");
  });

  it("approval.requested shows the command waiting for approval", () => {
    assert.equal(summarizeEvent(recordedSeq(22)), "Approval requested: cat package.json");
    assert.equal(summarizeEvent(recordedSeq(42)), "Approval requested: npx mocha -R dot");
  });

  it("gate.result, verdict and task.merged show the recorded outcome", () => {
    assert.equal(summarizeEvent(recordedSeq(52)), "Gate check passed (T1)");
    assert.equal(summarizeEvent(recordedSeq(53)), "Verdict: approve (T1)");
    assert.equal(
      summarizeEvent(recordedSeq(55)),
      "Task T1 merged into graveyard/live-gulp-plumber-t40"
    );
  });

  it("final_check.result lists each recorded check", () => {
    assert.equal(
      summarizeEvent(recordedSeq(57)),
      "Final check passed (install passed, build passed, tests passed)"
    );
  });

  it("artifact.ready shows kind and size", () => {
    assert.equal(summarizeEvent(recordedSeq(59)), "Artifact ready: patch (311.5 KB)");
    assert.equal(summarizeEvent(recordedSeq(60)), "Artifact ready: spec (478 B)");
  });

  it("run.done shows outcome and duration", () => {
    assert.equal(summarizeEvent(recordedSeq(65)), "Run finished: resurrected (2m 29s)");
  });

  it("admin.publish shows the published outcome", () => {
    assert.equal(summarizeEvent(recordedSeq(66)), "Run published (outcome: resurrected)");
  });
});

describe("summarizeEvent: other kinds the run model handles", () => {
  it("summarizes command.refused with its reason", () => {
    assert.equal(
      summarizeEvent(ev("command.refused", { argv: ["rm", "x"], reason: "not allowed", refs: [] })),
      "Refused: rm x (not allowed)"
    );
  });

  it("summarizes approvals, asks and messages", () => {
    assert.equal(
      summarizeEvent(ev("approval.resolved", { approvalId: "ap-1", decision: "allow", refs: [] })),
      "Approval ap-1: allow"
    );
    assert.equal(
      summarizeEvent(ev("ask.raised", { askId: "a1", question: "Proceed?", refs: [] })),
      "Question: Proceed?"
    );
    assert.equal(
      summarizeEvent(ev("ask.answered", { askId: "a1", answer: "yes", refs: [] })),
      "Answer: yes"
    );
    assert.equal(
      summarizeEvent(ev("message.sent", { text: "hello", refs: [] })),
      "Message sent: hello"
    );
    assert.equal(
      summarizeEvent(ev("progress.report", { summary: "half way", refs: [] })),
      "Progress: half way"
    );
  });

  it("summarizes run lifecycle kinds", () => {
    assert.equal(summarizeEvent(ev("run.queued", { position: 2, refs: [] })), "Run queued (position 2)");
    assert.equal(summarizeEvent(ev("run.started", { refs: [] })), "Run started");
    assert.equal(summarizeEvent(ev("run.clock", { action: "pause", refs: [] })), "Run clock paused");
    assert.equal(
      summarizeEvent(ev("admin.kill", { reason: "stuck", refs: [] })),
      "Run stopped by admin (stuck)"
    );
    assert.equal(summarizeEvent(ev("admin.redaction", { refs: [] })), "Redacted by the owner");
    assert.equal(summarizeEvent(ev("pact.revised", { pactVersion: 2, refs: [] })), "Pact v2 revised");
    assert.equal(summarizeEvent(ev("pact.revision", { pactVersion: 2, refs: [] })), "Pact v2 revised");
  });

  it("summarizes skeleton kinds", () => {
    assert.equal(
      summarizeEvent(ev("skeleton.tool_call", { tool: "read_file", refs: [] })),
      "Tool call: read_file"
    );
    assert.equal(
      summarizeEvent(ev("skeleton.state", { state: "idle", refs: [] })),
      "Skeleton state: idle"
    );
    assert.equal(
      summarizeEvent(ev("skeleton.failed", { reason: "crashed", refs: [] })),
      "Skeleton failed (crashed)"
    );
    assert.equal(
      summarizeEvent(ev("skeleton.usage", { credits: 3, refs: [] })),
      "Usage reported: 3 credits"
    );
    assert.equal(
      summarizeEvent(ev("skeleton.instruction", { instruction: "stop", refs: [] })),
      "Instruction sent: stop"
    );
  });

  it("summarizes failed checks without guessing", () => {
    assert.equal(
      summarizeEvent(ev("gate.result", { ok: false, reasons: ["lint", "tests"], refs: [] }, { taskId: "T2" })),
      "Gate check failed (T2): lint, tests"
    );
    assert.equal(
      summarizeEvent(
        ev("final_check.result", { passed: false, installPassed: true, testsPassed: false, refs: [] })
      ),
      "Final check failed (install passed, tests failed)"
    );
    assert.equal(
      summarizeEvent(ev("exhume.certificate", { healthy: true, refs: [] })),
      "Death Certificate issued: baseline healthy"
    );
  });
});

describe("summarizeEvent: fallback and missing fields", () => {
  it("falls back to kind and actor for an unknown kind", () => {
    assert.equal(summarizeEvent(ev("custom.thing", { refs: [] })), "custom.thing event from tester");
  });

  it("falls back without actor or kind", () => {
    assert.equal(summarizeEvent(ev("custom.thing", { refs: [] }, { actor: "" })), "custom.thing event");
    assert.equal(summarizeEvent(ev("", { refs: [] }, { actor: "" })), "Event");
  });

  it("never throws when data is missing or not an object", () => {
    for (const kind of ["command.result", "run.phase", "task.state", "pact.drafted", "custom.x"]) {
      assert.doesNotThrow(() => summarizeEvent(ev(kind, null)));
      assert.doesNotThrow(() => summarizeEvent(ev(kind, undefined)));
      assert.doesNotThrow(() =>
        summarizeEvent(ev(kind, "oops" as unknown as Record<string, unknown>))
      );
    }
  });

  it("says what is not reported instead of inventing values", () => {
    assert.equal(summarizeEvent(ev("command.result", { refs: [] })), "Command finished (exit code not reported)");
    assert.equal(summarizeEvent(ev("command.started", { refs: [] })), "Started: command not reported");
    assert.equal(summarizeEvent(ev("run.phase", { refs: [] })), "Phase changed (phase not reported)");
    assert.equal(summarizeEvent(ev("run.phase", { phase: "plan", refs: [] })), "Phase: plan");
    assert.equal(summarizeEvent(ev("grimoire.summary", { refs: [] })), "Grimoire summary recorded");
    assert.equal(
      summarizeEvent(ev("grimoire.summary", { signalsCount: 3, refs: [] })),
      "Grimoire found 3 signals"
    );
    assert.equal(summarizeEvent(ev("pact.drafted", { refs: [] })), "Pact drafted");
    assert.equal(summarizeEvent(ev("artifact.ready", { refs: [] })), "Artifact ready");
    assert.equal(summarizeEvent(ev("run.done", { refs: [] })), "Run finished");
    assert.equal(summarizeEvent(ev("task.state", { refs: [] })), "Task state changed");
    assert.equal(summarizeEvent(ev("approval.requested", { refs: [] })), "Approval requested");
    assert.equal(summarizeEvent(ev("skeleton.raised", { refs: [] })), "Skeleton raised");
  });

  it("ignores values of the wrong type", () => {
    assert.equal(
      summarizeEvent(ev("command.result", { commandLine: 42, exitCode: "0", durationMs: "fast", refs: [] })),
      "Command finished (exit code not reported)"
    );
    assert.equal(summarizeEvent(ev("run.done", { outcome: {}, durationMs: Number.NaN, refs: [] })), "Run finished");
  });

  it("reports timeouts and out-of-memory kills from the recorded flags", () => {
    assert.equal(
      summarizeEvent(ev("command.result", { commandLine: "npm test", timedOut: true, durationMs: 180000, refs: [] })),
      "npm test timed out (3m 0s)"
    );
    assert.equal(
      summarizeEvent(ev("command.result", { commandLine: "npm test", oomKilled: true, exitCode: 137, refs: [] })),
      "npm test ran out of memory (exit 137)"
    );
  });

  it("collapses multi-line text and caps the length", () => {
    const long = `first line\nsecond line ${"x".repeat(500)}`;
    const summary = summarizeEvent(ev("message.sent", { text: long, refs: [] }));
    assert.equal(summary, "Message sent: first line");
    const wide = summarizeEvent(ev("message.sent", { text: "y".repeat(500), refs: [] }));
    assert.ok(wide.length <= 200, `length ${wide.length}`);
    assert.ok(wide.endsWith("…"));
  });

  it("does not mutate the event", () => {
    const event = deepFreeze(structuredClone(recordedSeq(8)));
    const before = JSON.stringify(event);
    assert.doesNotThrow(() => summarizeEvent(event));
    assert.equal(JSON.stringify(event), before);
  });
});
