/**
 * The backend can record the same approval or command event twice in a row
 * (recorded run live-gulp-plumber-t40 has 4 approval and 10 command duplicates).
 * The view must show each approval and each command once, while a command that
 * genuinely ran twice (different logRef) still shows twice.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { buildRunView, type RunEvent } from "@/lib/ui/run-model";

const RECORDED_EVENTS = path.resolve(
  __dirname,
  "../../output/recorded-runs/live-gulp-plumber-t40/events.ndjson"
);

let seq = 0;
function ev(
  kind: string,
  data: Record<string, unknown> = {},
  extra: Partial<RunEvent> = {}
): RunEvent {
  seq += 1;
  return { seq, ts: 1_000_000 + seq * 1000, kind, actor: "test", data, ...extra };
}

function approvalEntries(view: ReturnType<typeof buildRunView>) {
  return view.channel.filter((c) => c.type === "approval");
}

describe("duplicate approval events", () => {
  it("shows one approval and one channel entry when the same approvalId is recorded twice", () => {
    seq = 0;
    const requested = { approvalId: "ap-1", argv: ["cat", "package.json"], cwd: "/w" };
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("approval.requested", requested, { skeletonId: "sk-1" }),
      ev("approval.requested", requested, { skeletonId: "sk-1" }),
    ]);

    assert.equal(view.approvals.length, 1);
    assert.equal(approvalEntries(view).length, 1);
  });

  it("keeps two approvals that have different approvalIds", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("approval.requested", { approvalId: "ap-1", argv: ["npm", "test"] }),
      ev("approval.requested", { approvalId: "ap-2", argv: ["npm", "test"] }),
    ]);

    assert.equal(view.approvals.length, 2);
    assert.equal(approvalEntries(view).length, 2);
  });

  it("shows one resolved entry when the same approval.resolved is recorded twice", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("approval.requested", { approvalId: "ap-1", argv: ["npm", "test"] }),
      ev("approval.resolved", { approvalId: "ap-1", decision: "approved" }),
      ev("approval.resolved", { approvalId: "ap-1", decision: "approved" }),
    ]);

    assert.equal(view.approvals[0].status, "resolved");
    const entries = approvalEntries(view);
    assert.equal(entries.filter((e) => e.kind === "approval.requested").length, 1);
    assert.equal(entries.filter((e) => e.kind === "approval.resolved").length, 1);
  });

  it("ignores a late duplicate approval.requested after the approval is already resolved", () => {
    seq = 0;
    const requested = { approvalId: "ap-1", argv: ["npm", "test"], cwd: "/w" };
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("approval.requested", requested),
      ev("approval.resolved", { approvalId: "ap-1", decision: "approved" }),
      ev("approval.requested", requested),
    ]);

    assert.equal(view.approvals[0].status, "resolved");
    assert.equal(approvalEntries(view).length, 2);
  });
});

describe("duplicate command events", () => {
  it("shows one row when the same command start and result are each recorded twice", () => {
    seq = 0;
    const started = { argv: ["npm", "test"], step: "tests_repo", logRef: "log-a" };
    const result = { ...started, exitCode: 0, status: "passed", durationMs: 800 };
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("command.started", started),
      ev("command.started", started),
      ev("command.result", result),
      ev("command.result", result),
    ]);

    assert.equal(view.commands.length, 1);
    assert.equal(view.commands[0].status, "passed");
    assert.equal(view.commands[0].logRef, "log-a");
  });

  it("keeps two rows when the same command really ran twice (different logRef)", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.phase", { phase: "legion" }),
      ev("command.started", { argv: ["npm", "test"], logRef: "log-a" }),
      ev("command.result", { argv: ["npm", "test"], logRef: "log-a", exitCode: 1 }),
      ev("command.started", { argv: ["npm", "test"], logRef: "log-b" }),
      ev("command.result", { argv: ["npm", "test"], logRef: "log-b", exitCode: 0 }),
    ]);

    assert.equal(view.commands.length, 2);
    assert.deepEqual(
      view.commands.map((c) => c.status),
      ["failed", "passed"]
    );
  });

  it("still pairs results without a logRef by command line, as before", () => {
    seq = 0;
    const view = buildRunView([
      ev("run.phase", { phase: "exhume" }),
      ev("command.started", { argv: ["node", "--version"] }),
      ev("command.result", { argv: ["node", "--version"], exitCode: 0 }),
    ]);

    assert.equal(view.commands.length, 1);
    assert.equal(view.commands[0].status, "passed");
  });
});

describe("recorded run live-gulp-plumber-t40", () => {
  const events = fs
    .readFileSync(RECORDED_EVENTS, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEvent);

  it("shows each of its 4 approvals once in the channel", () => {
    const view = buildRunView(events);

    assert.equal(approvalEntries(view).length, 4);
    assert.equal(view.approvals.length, 4);
  });

  it("shows each recorded command once", () => {
    const view = buildRunView(events);
    const logRefs = view.commands.map((c) => c.logRef).filter(Boolean);

    assert.equal(new Set(logRefs).size, logRefs.length);
  });
});
