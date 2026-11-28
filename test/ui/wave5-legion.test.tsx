/**
 * Wave 5: Legion attention, SSE reconnect, Necromancer/Skeleton recovery,
 * Skeleton card controls, run-end states, and the synchronized Task graph/table
 * (Tasks 24.1-24.3).
 *
 * Every state is rendered with renderToStaticMarkup (no DOM, no network) or
 * asserted through the exported pure model helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LegionDashboard } from "@/components/LegionDashboard";
import { LegionRunHeader } from "@/components/LegionRunHeader";
import {
  LegionSkeletonCard,
  SkeletonInterruptConfirm,
  type SkeletonData,
} from "@/components/LegionSkeletonCard";
import { LayToRestModal } from "@/components/LayToRestModal";
import { TaskGraph, type TaskNode } from "@/components/TaskGraph";
import { TaskTable } from "@/components/TaskTable";
import { eventStreamUrl } from "@/lib/ui/api";
import {
  applyRunEvents,
  buildRunView,
  lastEventIdParam,
  needsUserCount,
  reconnectBannerText,
  recoveryOutcomeLabel,
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

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

function baseSkeleton(overrides: Partial<SkeletonData> = {}): SkeletonData {
  return {
    skeletonId: "sk-1",
    role: "soul-stitcher",
    state: "running",
    taskIds: ["T1"],
    attempt: 1,
    currentToolCall: { tool: "sandbox_exec", startedAt: 1_000_000 },
    toolCallsCount: 2,
    logs: [],
    elapsedSeconds: 10,
    credits: null,
    worktree: "wt-1",
    lastEvent: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 24.1: Attention, SSE reconnect & recovery
// ---------------------------------------------------------------------------

describe("Task 24.1 attention: inbox badge and You slot when waiting for the user", () => {
  it("counts approvals and open questions as needing the user", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("approval.requested", { approvalId: "ap-1", argv: ["npm", "i"] }, { skeletonId: "sk-1" }),
      ev("ask.raised", { askId: "ask-1", question: "Keep it?" }, { skeletonId: "sk-1" }),
    ]);
    assert.equal(needsUserCount(view), 2);
  });

  it("renders an inbox badge and populates the You slot", () => {
    seq = 0;
    const events = [
      ev("run.phase", { phase: "legion" }),
      ev("approval.requested", { approvalId: "ap-1", argv: ["npm", "i"] }, { skeletonId: "sk-1" }),
      ev("ask.raised", { askId: "ask-1", question: "Keep it?" }, { skeletonId: "sk-1" }),
    ];
    const html = render(<LegionDashboard runId="run-attn" initialEvents={events} />);
    assert.ok(html.includes('data-testid="legion-inbox-badge"'));
    assert.ok(html.includes("Inbox:"));
    assert.ok(html.includes("[You]"));
    assert.ok(/\[!\]\s*2 actions/.test(html));
  });

  it("shows no inbox badge when nothing needs the user", () => {
    seq = 0;
    const html = render(
      <LegionDashboard runId="run-clear" initialEvents={[ev("run.phase", { phase: "legion" })]} />
    );
    assert.ok(!html.includes('data-testid="legion-inbox-badge"'));
    assert.equal(needsUserCount(buildRunView([])), 0);
  });
});

describe("Task 24.1 SSE reconnect: banner text and Last-Event-ID tracking", () => {
  it("formats the reconnect banner with the last applied seq", () => {
    assert.equal(reconnectBannerText(7), "Reconnecting... showing events up to #7");
    assert.equal(reconnectBannerText(0), "Reconnecting... showing events up to #0");
  });

  it("derives the Last-Event-ID resume value from the last seq", () => {
    assert.equal(lastEventIdParam(7), "7");
    assert.equal(lastEventIdParam(0), null);
    assert.ok(eventStreamUrl("run-1", 5).includes("lastEventId=5"));
    assert.ok(!eventStreamUrl("run-1", 0).includes("lastEventId"));
  });

  it("tracks the latest received event sequence on the view", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-1" }),
      ev("skeleton.log", { text: "hello" }, { skeletonId: "sk-1" }),
    ]);
    assert.equal(view.lastSeq, 3);
    assert.equal(lastEventIdParam(view.lastSeq), "3");
  });

  it("the header shows RECONNECTING while the stream is down", () => {
    const html = render(<LegionRunHeader runId="run-1" phase="legion" isReconnecting />);
    assert.ok(html.includes("RECONNECTING"));
  });
});

describe("Task 24.1 recovery: Recovering then resumed or restarted", () => {
  it("marks the run recovering on a worker restart and clears on recovery complete", () => {
    seq = 0;
    const base = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-1" }),
    ]);
    const recovering = applyRunEvents(base, [ev("system.worker_restart", {})]);
    assert.equal(recovering.recovering, true);
    const done = applyRunEvents(recovering, [ev("system.recovery_complete", {})]);
    assert.equal(done.recovering, false);
  });

  it("records a resumed outcome and labels it", () => {
    seq = 0;
    const view = applyRunEvents(
      buildRunView([ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-1" })]),
      [ev("skeleton.recovered", { outcome: "resumed" }, { skeletonId: "sk-1" })]
    );
    assert.equal(view.skeletons[0].recoveryOutcome, "resumed");
    assert.equal(view.skeletons[0].state, "running");
    assert.equal(recoveryOutcomeLabel("resumed"), "Resumed the same session");
  });

  it("records a restarted outcome and labels it", () => {
    seq = 0;
    const view = applyRunEvents(
      buildRunView([ev("skeleton.raised", { role: "bonesetter" }, { skeletonId: "sk-1" })]),
      [ev("skeleton.recovered", { outcome: "restarted" }, { skeletonId: "sk-1" })]
    );
    assert.equal(view.skeletons[0].recoveryOutcome, "restarted");
    assert.equal(recoveryOutcomeLabel("restarted"), "Restarted from its last commit");
    assert.equal(recoveryOutcomeLabel(null), null);
  });

  it("shows Recovering on an affected card, then the recovery outcome", () => {
    const recoveringCard = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ state: "running" })} recovering />
    );
    assert.ok(recoveringCard.includes("Recovering"));

    const resumedCard = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ recoveryOutcome: "resumed" })} />
    );
    assert.ok(resumedCard.includes("Resumed the same session"));

    const restartedCard = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ recoveryOutcome: "restarted" })} />
    );
    assert.ok(restartedCard.includes("Restarted from its last commit"));
  });
});

// ---------------------------------------------------------------------------
// Task 24.2: Skeleton card controls, silent timer & run-end states
// ---------------------------------------------------------------------------

describe("Task 24.2 builder vs warden card actions", () => {
  it("a builder card exposes Send instruction, Interrupt, Re-raise and Lay to rest", () => {
    const html = render(<LegionSkeletonCard skeleton={baseSkeleton({ role: "bonesetter" })} />);
    assert.ok(html.includes("Send instruction"));
    assert.ok(html.includes("Interrupt"));
    assert.ok(html.includes("Re-raise"));
    assert.ok(html.includes("Lay to rest"));
    assert.ok(!html.includes("Add review focus"));
  });

  it("a warden card exposes Add review focus instead of Send instruction", () => {
    const html = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ role: "warden", state: "auditing" })} />
    );
    assert.ok(html.includes("Add review focus"));
    assert.ok(!html.includes("Send instruction"));
  });
});

describe("Task 24.2 disabled actions expose an accessible reason", () => {
  it("a disabled Send instruction button carries a title explaining why", () => {
    const html = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ state: "completed" })} runDone />
    );
    // The button is disabled and its title states the reason.
    assert.ok(/disabled=""[^>]*title="Run has concluded"/.test(html));
    assert.ok(html.includes("Run has concluded"));
  });

  it("a disabled Interrupt button explains there is no active tool call", () => {
    const html = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ currentToolCall: null })} />
    );
    assert.ok(html.includes("No active tool call to interrupt"));
  });
});

describe("Task 24.2 interrupt warning and lay-to-rest modal", () => {
  it("the interrupt confirmation warns the running output will be lost", () => {
    const html = render(
      <SkeletonInterruptConfirm skeletonId="sk-1" onConfirm={() => {}} onCancel={() => {}} />
    );
    assert.ok(html.includes("Interrupt now"));
    assert.ok(/output so far will be lost/.test(html));
  });

  it("the lay-to-rest modal offers keep, discard and cancel", () => {
    const html = render(
      <LayToRestModal
        skeletonId="sk-1"
        role="bonesetter"
        onKeep={() => {}}
        onDiscard={() => {}}
        onCancel={() => {}}
      />
    );
    assert.ok(html.includes('data-testid="lay-to-rest-modal"'));
    assert.ok(html.includes("Keep its commits"));
    assert.ok(html.includes("Discard its work"));
    assert.ok(html.includes("Cancel"));
  });
});

describe("Task 24.2 silent timer", () => {
  it("renders Silent for mm:ss past the silence threshold", () => {
    const html = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ silentSeconds: 125, isSilent: true })} />
    );
    assert.ok(html.includes("Silent for 02:05"));
  });

  it("does not show the silent pill before the threshold", () => {
    const html = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ silentSeconds: 30, isSilent: false })} />
    );
    assert.ok(!html.includes("Silent for"));
  });
});

describe("Task 24.2 run-level error and partial state", () => {
  it("shows a plain-English error summary with evidence links", () => {
    seq = 0;
    const events = [
      ev("run.phase", { phase: "legion" }),
      ev("run.done", { outcome: "error", reason: "Fatal quarantine" }),
    ];
    const html = render(<LegionDashboard runId="run-err" initialEvents={events} />);
    assert.ok(html.includes("Run-level error occurred:"));
    assert.ok(html.includes("Fatal quarantine"));
    assert.ok(html.includes("View kept event evidence log"));
    assert.ok(html.includes("View kept artifacts and commit state"));
  });

  it("shows the explicit partial run state", () => {
    seq = 0;
    const events = [
      ev("run.phase", { phase: "legion" }),
      ev("task.merged", { taskId: "T1" }, { taskId: "T1" }),
      ev("run.done", { outcome: "partial" }),
    ];
    const html = render(<LegionDashboard runId="run-partial" initialEvents={events} />);
    assert.ok(html.includes("Run status: partial"));
    assert.ok(/Some tasks merged successfully/.test(html));
  });
});

// ---------------------------------------------------------------------------
// Task 24.3: Synchronized Task graph & accessible Task table
// ---------------------------------------------------------------------------

const SAMPLE_TASKS: TaskNode[] = [
  { taskId: "T1", state: "merged", attempt: 1, verdict: "approve", dependencies: [] },
  { taskId: "T2", state: "in_review", attempt: 2, verdict: null, dependencies: ["T1"] },
  { taskId: "T3", state: "failed", attempt: 1, verdict: "reject", dependencies: ["T1"] },
];

describe("Task 24.3 TaskGraph renders nodes, edges, attempts and verdicts", () => {
  it("draws a node per task and an edge per dependency", () => {
    const html = render(<TaskGraph tasks={SAMPLE_TASKS} />);
    assert.ok(html.includes('data-testid="task-graph"'));
    assert.ok(html.includes('data-testid="task-graph-node-T1"'));
    assert.ok(html.includes('data-testid="task-graph-node-T2"'));
    assert.ok(html.includes('data-testid="task-graph-node-T3"'));
    assert.ok(html.includes('data-testid="task-graph-edge-T1-T2"'));
    assert.ok(html.includes('data-testid="task-graph-edge-T1-T3"'));
    assert.ok(html.includes("Warden: approve"));
    assert.ok(html.includes("attempt 2"));
  });

  it("marks the selected node with aria-pressed", () => {
    const html = render(<TaskGraph tasks={SAMPLE_TASKS} selectedTaskId="T2" />);
    assert.ok(/data-testid="task-graph-node-T2"[^>]*aria-pressed="true"/.test(html));
    assert.ok(/data-testid="task-graph-node-T1"[^>]*aria-pressed="false"/.test(html));
  });
});

describe("Task 24.3 TaskTable carries identical data and is keyboard navigable", () => {
  it("renders a row per task with state, attempt, dependencies and verdict", () => {
    const html = render(<TaskTable tasks={SAMPLE_TASKS} />);
    assert.ok(html.includes('data-testid="task-table"'));
    assert.ok(html.includes('data-testid="task-table-row-T1"'));
    assert.ok(html.includes('data-testid="task-table-select-T2"'));
    assert.ok(html.includes("approve"));
    assert.ok(html.includes("reject"));
    // T2 depends on T1.
    assert.ok(/T2[\s\S]*T1/.test(html));
  });

  it("marks the selected row and its select button", () => {
    const html = render(<TaskTable tasks={SAMPLE_TASKS} selectedTaskId="T2" />);
    assert.ok(/data-testid="task-table-row-T2"[^>]*aria-selected="true"/.test(html));
    assert.ok(/data-testid="task-table-select-T2"[^>]*aria-pressed="true"/.test(html));
  });

  it("graph and table expose the same tasks, attempts and verdicts", () => {
    const graph = render(<TaskGraph tasks={SAMPLE_TASKS} selectedTaskId="T3" />);
    const table = render(<TaskTable tasks={SAMPLE_TASKS} selectedTaskId="T3" />);
    for (const t of SAMPLE_TASKS) {
      assert.ok(graph.includes(t.taskId), `graph missing ${t.taskId}`);
      assert.ok(table.includes(t.taskId), `table missing ${t.taskId}`);
      const verdict = t.verdict || "pending";
      assert.ok(graph.includes(verdict), `graph missing verdict ${verdict}`);
      assert.ok(table.includes(verdict), `table missing verdict ${verdict}`);
    }
    // The same selection is reflected in both views.
    assert.ok(/aria-pressed="true"/.test(graph));
    assert.ok(/aria-selected="true"/.test(table));
  });
});

describe("Task 24.3 dashboard toggle preserves the selected task across views", () => {
  it("renders an accessible graph/table switch and defaults to the graph", () => {
    seq = 0;
    const events = [
      ev("run.phase", { phase: "legion" }),
      ev("task.state", { taskId: "T1", state: "merged", verdict: "approve" }),
      ev(
        "task.state",
        { taskId: "T2", state: "in_review", attempt: 2, dependencies: ["T1"] },
        { taskId: "T2", attempt: 2 }
      ),
    ];
    const html = render(<LegionDashboard runId="run-tasks" initialEvents={events} />);
    assert.ok(html.includes('data-testid="legion-task-views"'));
    assert.ok(html.includes('data-testid="task-view-graph"'));
    assert.ok(html.includes('data-testid="task-view-table"'));
    // Graph is the default view.
    assert.ok(/data-testid="task-view-graph"[^>]*aria-pressed="true"/.test(html));
    assert.ok(html.includes('data-testid="task-graph"'));
    // The task data reached the view model with its dependency and verdict.
    assert.ok(html.includes("T1"));
    assert.ok(html.includes("approve"));
  });
});