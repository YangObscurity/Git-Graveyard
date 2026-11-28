/**
 * Wave 5: Modal focus handling, kill-switch confirmation reset, and the
 * interrupt-confirmation binding to the tool call it was opened for.
 *
 * The test harness renders with renderToStaticMarkup (no DOM), so focus
 * behaviour that needs a live document is covered through the exported pure
 * helpers (focusable-element selection and the interrupt-confirm validity
 * check) plus static markup assertions for the dialog semantics.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  KillSwitchModal,
  getKillSwitchFocusableElements,
  KILL_SWITCH_FOCUSABLE_SELECTOR,
  killSwitchConfirmationPhrase,
} from "@/components/KillSwitchModal";
import {
  LayToRestModal,
  getFocusableElements,
  FOCUSABLE_SELECTOR,
} from "@/components/LayToRestModal";
import {
  LegionSkeletonCard,
  type SkeletonData,
  INTERRUPT_STALE_MESSAGE,
  interruptConfirmStillValid,
  type InterruptConfirmBinding,
} from "@/components/LegionSkeletonCard";

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
    currentToolCall: { tool: "sandbox_exec", toolCallId: "tc-1", startedAt: 1_000_000 },
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
// 1. Modal focus: accessible name and dialog semantics
// ---------------------------------------------------------------------------

describe("modal focus: dialogs carry an accessible name and aria-modal", () => {
  it("KillSwitchModal is labelled by its heading", () => {
    const html = render(<KillSwitchModal open activeRunCount={1} queuedRunCount={1} />);
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('aria-labelledby="kill-switch-title"'));
    assert.ok(html.includes('id="kill-switch-title"'));
  });

  it("LayToRestModal is labelled by its heading", () => {
    const html = render(
      <LayToRestModal
        skeletonId="sk-1"
        role="bonesetter"
        onKeep={() => {}}
        onDiscard={() => {}}
        onCancel={() => {}}
      />
    );
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('aria-labelledby="lay-to-rest-title"'));
    assert.ok(html.includes('id="lay-to-rest-title"'));
  });
});

// ---------------------------------------------------------------------------
// Pure helper: focusable-element selection
// ---------------------------------------------------------------------------

describe("modal focus: focusable-element selection helpers", () => {
  it("exposes a selector covering the standard focusable controls", () => {
    assert.ok(KILL_SWITCH_FOCUSABLE_SELECTOR.includes("button:not([disabled])"));
    assert.ok(KILL_SWITCH_FOCUSABLE_SELECTOR.includes("input:not([disabled])"));
    assert.ok(KILL_SWITCH_FOCUSABLE_SELECTOR.includes("a[href]"));
    assert.ok(FOCUSABLE_SELECTOR.includes("button:not([disabled])"));
    assert.ok(FOCUSABLE_SELECTOR.includes("input:not([disabled])"));
    assert.ok(FOCUSABLE_SELECTOR.includes("a[href]"));
  });

  it("returns an empty list when there is no container", () => {
    assert.deepEqual(getKillSwitchFocusableElements(null), []);
    assert.deepEqual(getFocusableElements(null), []);
  });
});

// ---------------------------------------------------------------------------
// 2. Kill-switch confirmation survives close and reopen
// ---------------------------------------------------------------------------

describe("kill-switch confirmation reset on reopen", () => {
  it("renders the confirmation input empty and confirm disabled on a fresh open", () => {
    const html = render(<KillSwitchModal open activeRunCount={2} queuedRunCount={3} />);
    const confirm = html.match(/<button[^>]*data-testid="kill-switch-confirm"[^>]*>/);
    assert.ok(confirm, "confirm button must render");
    assert.ok(/disabled/.test(confirm[0]), "confirm must be disabled before typing");
    const input = html.match(/<input[^>]*data-testid="kill-switch-confirmation-input"[^>]*>/);
    assert.ok(input, "confirmation input must render");
    assert.ok(!/value="[^"]+"/.test(input[0]), "input must start empty");
  });

  it("the required phrase depends on the selected level and counts", () => {
    assert.equal(killSwitchConfirmationPhrase("pause_new_runs", 2, 3), "PAUSE 3 QUEUED");
    assert.equal(killSwitchConfirmationPhrase("stop_gracefully", 2, 3), "STOP 2 RUNNING");
    assert.equal(killSwitchConfirmationPhrase("hard_kill", 2, 3), "KILL 2 ACTIVE 3 QUEUED");
  });

  it("renders nothing when closed", () => {
    assert.equal(render(<KillSwitchModal open={false} />), "");
  });

  it("shows no phrase and keeps Execute disabled before the previews load", () => {
    // No activeRunCount/queuedRunCount => the dashboard has not loaded fresh previews yet.
    const html = render(<KillSwitchModal open />);
    assert.ok(!/Required phrase:\s*<span/.test(html), "no phrase must be shown before load");
    assert.ok(!html.includes("PAUSE 0 QUEUED"));
    assert.ok(!html.includes("STOP 0 RUNNING"));
    assert.ok(!html.includes("KILL 0 ACTIVE 0 QUEUED"));
    assert.ok(html.includes("waiting for the current affected run count"));
    const confirm = html.match(/<button[^>]*data-testid="kill-switch-confirm"[^>]*>/);
    assert.ok(confirm, "confirm button must render");
    assert.ok(/disabled/.test(confirm[0]), "confirm must be disabled before previews load");
  });
});

// ---------------------------------------------------------------------------
// 3. Interrupt confirmation bound to the tool call it was opened for
// ---------------------------------------------------------------------------

describe("interrupt confirmation binding to the tool call", () => {
  it("is valid while the captured tool call is still the current one", () => {
    const binding: InterruptConfirmBinding = { toolCallId: "tc-1" };
    assert.equal(interruptConfirmStillValid(binding, "tc-1", false), true);
  });

  it("is stale when the tool call id changes", () => {
    const binding: InterruptConfirmBinding = { toolCallId: "tc-1" };
    assert.equal(interruptConfirmStillValid(binding, "tc-2", false), false);
  });

  it("is stale when the Skeleton has no running tool call", () => {
    const binding: InterruptConfirmBinding = { toolCallId: "tc-1" };
    assert.equal(interruptConfirmStillValid(binding, null, false), false);
    assert.equal(interruptConfirmStillValid(binding, undefined, false), false);
  });

  it("is stale when the run has ended", () => {
    const binding: InterruptConfirmBinding = { toolCallId: "tc-1" };
    assert.equal(interruptConfirmStillValid(binding, "tc-1", true), false);
  });

  it("is stale when no binding was recorded", () => {
    assert.equal(interruptConfirmStillValid(null, "tc-1", false), false);
  });

  it("exposes the plain-English stale message", () => {
    assert.equal(
      INTERRUPT_STALE_MESSAGE,
      "The command finished before the interrupt was sent."
    );
  });

  it("the card can open the interrupt confirmation for the current tool call", () => {
    const html = render(<LegionSkeletonCard skeleton={baseSkeleton()} />);
    assert.ok(html.includes("Interrupt"));
    assert.ok(!/disabled=""[^>]*title="No active tool call/.test(html));
  });

  it("the interrupt button is disabled when there is no active tool call", () => {
    const html = render(
      <LegionSkeletonCard skeleton={baseSkeleton({ currentToolCall: null })} />
    );
    assert.ok(html.includes("No active tool call to interrupt"));
  });
});