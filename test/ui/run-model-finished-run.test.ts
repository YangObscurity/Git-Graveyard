/**
 * A concluded run must not look like it still needs the user or still has live Skeletons.
 * (Legion screen of a finished run showed "[Action Needed]", expired approval buttons
 * and a planner card stuck on RUNNING.)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRunView,
  openAsks,
  pendingApprovals,
  type RunEvent,
} from "@/lib/ui/run-model";

let seq = 0;
function ev(
  kind: string,
  data: Record<string, unknown> = {},
  extra: Partial<RunEvent> = {}
): RunEvent {
  seq += 1;
  return { seq, ts: 1_000_000 + seq * 1000, kind, actor: "test", data, ...extra };
}

function liveRunEvents(): RunEvent[] {
  seq = 0;
  return [
    ev("run.queued", { url: "https://github.com/o/r", sha: "HEAD" }),
    ev("run.phase", { phase: "exhume" }),
    ev("skeleton.raised", { role: "planner" }, { skeletonId: "sk-planner" }),
    ev("skeleton.tool_call", { tool: "read" }, { skeletonId: "sk-planner" }),
    ev(
      "approval.requested",
      { approvalId: "ap-1", argv: ["cat", "package.json"], cwd: "/w", expiresAt: 1_500_000 },
      { skeletonId: "sk-planner" }
    ),
    ev("ask.raised", { askId: "ask-1", question: "Proceed?" }, { skeletonId: "sk-planner" }),
  ];
}

function finishedRunEvents(): RunEvent[] {
  return [...liveRunEvents(), ev("run.phase", { phase: "done", outcome: "resurrected" })];
}

describe("a run that is still live", () => {
  it("keeps pending approvals and open asks", () => {
    const view = buildRunView(liveRunEvents());

    assert.equal(pendingApprovals(view).length, 1);
    assert.equal(openAsks(view).length, 1);
  });

  it("keeps the Skeleton running", () => {
    const view = buildRunView(liveRunEvents());

    assert.equal(view.skeletons[0].state, "running");
    assert.notEqual(view.skeletons[0].currentToolCall, null);
  });
});

describe("a run that has concluded", () => {
  it("reports no pending approvals even if one was never answered", () => {
    const view = buildRunView(finishedRunEvents());

    assert.equal(view.phase, "done");
    assert.equal(pendingApprovals(view).length, 0);
  });

  it("reports no open asks even if one was never answered", () => {
    const view = buildRunView(finishedRunEvents());

    assert.equal(openAsks(view).length, 0);
  });

  it("settles Skeletons that were still running and clears their tool call", () => {
    const view = buildRunView(finishedRunEvents());

    assert.equal(view.skeletons[0].state, "completed");
    assert.equal(view.skeletons[0].currentToolCall, null);
  });

  it("keeps a Skeleton that failed as failed", () => {
    seq = 0;
    const events = [
      ev("run.queued", { url: "https://github.com/o/r", sha: "HEAD" }),
      ev("run.phase", { phase: "exhume" }),
      ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-b" }),
      ev("skeleton.failed", { reason: "boom" }, { skeletonId: "sk-b" }),
      ev("run.phase", { phase: "done", outcome: "failed" }),
    ];

    const view = buildRunView(events);

    assert.equal(view.skeletons[0].state, "failed");
  });

  it("keeps a Skeleton that was laid to rest as laid to rest", () => {
    seq = 0;
    const events = [
      ev("run.queued", { url: "https://github.com/o/r", sha: "HEAD" }),
      ev("run.phase", { phase: "exhume" }),
      ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-b" }),
      ev("skeleton.laid_to_rest", {}, { skeletonId: "sk-b" }),
      ev("run.done", { outcome: "partial" }),
    ];

    const view = buildRunView(events);

    assert.equal(view.skeletons[0].state, "laid_to_rest");
  });
});
