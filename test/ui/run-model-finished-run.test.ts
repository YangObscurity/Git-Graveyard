/**
 * A concluded run must not look like it still needs the user or still has live Skeletons.
 * (Legion screen of a finished run showed "[Action Needed]", expired approval buttons
 * and a planner card stuck on RUNNING.)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LegionSkeletonCard, type SkeletonData } from "@/components/LegionSkeletonCard";
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

  it("settles active and waiting skeletons to stopped on killed, cancelled, error, or not_resurrected runs", () => {
    for (const terminal of [
      ev("admin.kill", { reason: "admin stopped" }),
      ev("run.done", { outcome: "cancelled" }),
      ev("run.done", { outcome: "error", reason: "boom" }),
      ev("run.done", { outcome: "not_resurrected" }),
    ]) {
      seq = 0;
      const events = [
        ev("run.queued", { url: "https://github.com/o/r", sha: "HEAD" }),
        ev("run.phase", { phase: "legion" }),
        ev("skeleton.raised", { role: "soul-stitcher" }, { skeletonId: "sk-run" }),
        ev("skeleton.tool_call", { tool: "sandbox_exec" }, { skeletonId: "sk-run" }),
        ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-wait" }),
        ev("skeleton.state", { state: "awaiting_approval" }, { skeletonId: "sk-wait" }),
        ev("skeleton.raised", { role: "warden" }, { skeletonId: "sk-blk" }),
        ev("skeleton.state", { state: "blocked" }, { skeletonId: "sk-blk" }),
        { ...terminal, seq: 99 },
      ];

      const view = buildRunView(events);
      assert.equal(view.phase, "done");
      for (const skel of view.skeletons) {
        assert.equal(skel.state, "stopped", `expected stopped for ${terminal.kind}`);
        assert.equal(skel.currentToolCall, null);
      }
    }
  });

  it("on partial outcome, settles merged-task skeletons to completed and unmerged ones to stopped", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.queued", { url: "https://github.com/o/r", sha: "HEAD" }),
      ev("run.phase", { phase: "legion" }),
      ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-done", taskId: "T1" }),
      ev("task.merged", { taskId: "T1" }, { taskId: "T1" }),
      ev("skeleton.raised", { role: "soul-stitcher" }, { skeletonId: "sk-open", taskId: "T2" }),
      ev("task.state", { taskId: "T2", state: "running" }, { taskId: "T2" }),
      ev("run.done", { outcome: "partial" }),
    ]);

    const doneSkel = view.skeletons.find((s) => s.skeletonId === "sk-done");
    const openSkel = view.skeletons.find((s) => s.skeletonId === "sk-open");
    assert.equal(doneSkel?.state, "completed");
    assert.equal(openSkel?.state, "stopped");
  });

  it("promotes stopped skeletons to completed when outcome arrives after done phase", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.queued", { url: "https://github.com/o/r", sha: "HEAD" }),
      ev("run.phase", { phase: "legion" }),
      ev("skeleton.raised", { role: "planner" }, { skeletonId: "sk-p" }),
      ev("run.phase", { phase: "done" }),
      ev("run.done", { outcome: "resurrected" }),
    ]);

    assert.equal(view.skeletons[0].state, "completed");
  });
});

function renderSkeletonCard(overrides: Partial<SkeletonData>, runDone = true): string {
  const skeleton: SkeletonData = {
    skeletonId: "sk-1",
    role: "soul-stitcher",
    state: "completed",
    taskIds: ["T1"],
    attempt: 1,
    currentToolCall: null,
    toolCallsCount: 1,
    logs: [],
    elapsedSeconds: 5,
    credits: null,
    worktree: "wt-1",
    lastEvent: null,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(LegionSkeletonCard, { skeleton, runDone }));
}

describe("LegionSkeletonCard settled states and Warden verdict", () => {
  it("renders a stopped builder card with [STOP] and not reported verdict", () => {
    const html = renderSkeletonCard({ role: "soul-stitcher", state: "stopped" });
    assert.ok(html.includes("[STOP] stopped"));
    assert.ok(html.includes("not reported"));
    assert.ok(!html.includes(">approved<"));
    assert.ok(!html.includes("[DONE]"));
  });

  it("renders a completed planner card with not reported Warden verdict instead of approved", () => {
    const html = renderSkeletonCard({ skeletonId: "sk-planner", role: "planner", state: "completed" });
    assert.ok(html.includes("[DONE] completed"));
    assert.ok(html.includes(">not reported<"));
    assert.ok(!html.includes(">approved<"));
  });

  it("renders a completed builder card as [DONE] and approved when no explicit verdict was stored", () => {
    const html = renderSkeletonCard({ role: "soul-stitcher", state: "completed" });
    assert.ok(html.includes("[DONE] completed"));
    assert.ok(html.includes(">approved<"));
  });
});
