import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SkipLink,
  resolveSkipLinkTarget,
} from "@/components/a11y/SkipLink";
import {
  FocusTrap,
  FOCUSABLE_SELECTOR,
  getFocusableElements,
  getNextFocusTarget,
} from "@/components/a11y/FocusTrap";
import {
  AriaAnnouncer,
  AccessibilityControls,
  resolveAnnouncementPoliteness,
  formatExpiryAdvanceWarning,
} from "@/components/a11y/AriaAnnouncer";
import {
  getNextRovingIndex,
  getRovingTabIndex,
  resolveActiveRovingIndex,
} from "@/lib/a11y/roving-tabindex";
import {
  createShortcutManager,
  SHORTCUTS_DISABLED_STORAGE_KEY,
  type StorageLike,
} from "@/lib/a11y/shortcuts";
import {
  LegionSkeletonCard,
  SkeletonInterruptConfirm,
  parseLogLineMeta,
  type SkeletonData,
} from "@/components/LegionSkeletonCard";
import { TaskGraph, type TaskNode } from "@/components/TaskGraph";
import { ReliquaryDiffViewer } from "@/components/ReliquaryDiffViewer";
import { ReplayPlayer, getEventKindIcon } from "@/components/ReplayPlayer";
import type { EventEnvelope } from "@/lib/events/types";

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("a11y: SkipLink", () => {
  it("targets #needs-you-slot when needs-you slot is present", () => {
    const target = resolveSkipLinkTarget(true);
    assert.equal(target.href, "#needs-you-slot");
    assert.equal(target.targetId, "needs-you-slot");

    const html = render(<SkipLink hasNeedsYou={true} />);
    assert.ok(html.includes('href="#needs-you-slot"'));
    assert.ok(html.includes('class="a11y-skip-link"'));
    assert.ok(html.includes("Skip to actions needing you"));
  });

  it("falls back gracefully to #main-content when needs-you slot is absent", () => {
    const target = resolveSkipLinkTarget(false);
    assert.equal(target.href, "#main-content");
    assert.equal(target.targetId, "main-content");

    const html = render(<SkipLink hasNeedsYou={false} />);
    assert.ok(html.includes('href="#main-content"'));
    assert.ok(html.includes("Skip to main content"));
  });
});

describe("a11y: FocusTrap", () => {
  it("renders modal dialog semantics (role=dialog, aria-modal=true)", () => {
    const html = render(
      <FocusTrap aria-label="Review dialog">
        <button type="button">Confirm</button>
        <button type="button">Cancel</button>
      </FocusTrap>
    );
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('aria-label="Review dialog"'));
  });

  it("exposes standard focusable selector and handles null containers safely", () => {
    assert.ok(FOCUSABLE_SELECTOR.includes("button:not([disabled])"));
    assert.ok(FOCUSABLE_SELECTOR.includes("a[href]"));
    assert.deepEqual(getFocusableElements(null), []);
  });

  it("wraps Tab from last element to first and Shift+Tab from first to last", () => {
    const first = { id: "first" } as unknown as HTMLElement;
    const middle = { id: "middle" } as unknown as HTMLElement;
    const last = { id: "last" } as unknown as HTMLElement;
    const list = [first, middle, last];

    assert.equal(getNextFocusTarget(list, last, false), first);
    assert.equal(getNextFocusTarget(list, first, true), last);
    assert.equal(getNextFocusTarget(list, middle, false), null);
    assert.equal(getNextFocusTarget(list, middle, true), null);
    assert.equal(getNextFocusTarget([], null, false), null);
  });
});

describe("a11y: AriaAnnouncer & AccessibilityControls", () => {
  it("exposes separate polite and assertive live regions", () => {
    const html = render(
      <AriaAnnouncer
        politeMessage="Task T1 merged"
        assertiveMessage="Run terminated"
      />
    );
    assert.ok(html.includes('data-testid="aria-announcer-polite"'));
    assert.ok(html.includes('aria-live="polite"'));
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes("Task T1 merged"));

    assert.ok(html.includes('data-testid="aria-announcer-assertive"'));
    assert.ok(html.includes('aria-live="assertive"'));
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Run terminated"));
  });

  it("reserves assertive strictly for fatal_error and kill_action", () => {
    assert.equal(resolveAnnouncementPoliteness("state_transition"), "polite");
    assert.equal(resolveAnnouncementPoliteness("control"), "polite");
    assert.equal(resolveAnnouncementPoliteness("fatal_error"), "assertive");
    assert.equal(resolveAnnouncementPoliteness("kill_action"), "assertive");
  });

  it("formats advance warning notices for expiring timed controls", () => {
    assert.equal(formatExpiryAdvanceWarning(120, 60, "Approval"), null);
    assert.equal(
      formatExpiryAdvanceWarning(45, 60, "Approval"),
      "Approval expires in 45 seconds."
    );
    assert.equal(
      formatExpiryAdvanceWarning(1, 60, "Approval"),
      "Approval expires in 1 second."
    );
    assert.equal(
      formatExpiryAdvanceWarning(0, 60, "Approval"),
      "Approval is expiring now."
    );
  });

  it("renders persistent Reduced motion and Keyboard shortcuts toggles", () => {
    const html = render(<AccessibilityControls />);
    assert.ok(html.includes('data-testid="a11y-reduced-motion-toggle"'));
    assert.ok(html.includes('data-testid="a11y-shortcuts-toggle"'));
    assert.ok(html.includes("Reduced motion: Off"));
    assert.ok(html.includes("Keyboard shortcuts: On"));
  });
});

describe("a11y: roving-tabindex and TaskGraph", () => {
  it("computes Arrow, Home, and End navigation with wrapping", () => {
    assert.equal(getNextRovingIndex(0, 3, "ArrowRight"), 1);
    assert.equal(getNextRovingIndex(2, 3, "ArrowRight"), 0);
    assert.equal(getNextRovingIndex(0, 3, "ArrowLeft"), 2);
    assert.equal(getNextRovingIndex(1, 3, "ArrowDown"), 2);
    assert.equal(getNextRovingIndex(0, 3, "ArrowUp"), 2);
    assert.equal(getNextRovingIndex(2, 3, "Home"), 0);
    assert.equal(getNextRovingIndex(0, 3, "End"), 2);
    assert.equal(getNextRovingIndex(1, 3, "Enter"), null);
    assert.equal(getNextRovingIndex(2, 3, "ArrowRight", { wrap: false }), 2);
  });

  it("computes roving tabindex and resolves active index on list updates", () => {
    assert.equal(getRovingTabIndex(0, 0), 0);
    assert.equal(getRovingTabIndex(1, 0), -1);
    assert.equal(resolveActiveRovingIndex(["T1", "T2", "T3"], "T2"), 1);
    assert.equal(resolveActiveRovingIndex(["T1", "T3"], "T2", "T3"), 1);
    assert.equal(resolveActiveRovingIndex([], "T1"), -1);
  });

  it("TaskGraph renders exactly one tabIndex=0 node and pairs state colors with icons", () => {
    const tasks: TaskNode[] = [
      { taskId: "T1", state: "merged", attempt: 1, verdict: "approve", dependencies: [] },
      { taskId: "T2", state: "running", attempt: 1, verdict: null, dependencies: ["T1"] },
      { taskId: "T3", state: "failed", attempt: 1, verdict: "reject", dependencies: ["T1"] },
    ];
    const html = render(<TaskGraph tasks={tasks} selectedTaskId="T2" />);
    const zeroTabs = (html.match(/tabindex="0"/gi) ?? []).length;
    const negTabs = (html.match(/tabindex="-1"/gi) ?? []).length;
    assert.equal(zeroTabs, 1);
    assert.equal(negTabs, 2);
    assert.ok(html.includes("[✓]"));
    assert.ok(html.includes("[▶]"));
    assert.ok(html.includes("[✕]"));
  });
});

describe("a11y: disableable global keyboard shortcuts", () => {
  it("dispatches shortcuts when enabled and suppresses all shortcuts when disabled", () => {
    const storage = createMemoryStorage();
    const manager = createShortcutManager({ storage });
    let count = 0;

    manager.register({
      id: "replay-play",
      key: " ",
      code: "Space",
      description: "Toggle replay",
      handler: () => {
        count += 1;
      },
    });

    assert.equal(manager.isDisabled(), false);
    assert.equal(manager.handleKeyDown({ key: " ", code: "Space" }), true);
    assert.equal(count, 1);

    // Skips editable targets and native button Space activation
    assert.equal(
      manager.handleKeyDown({ key: " ", code: "Space", target: { tagName: "INPUT" } }),
      false
    );
    assert.equal(
      manager.handleKeyDown({ key: " ", code: "Space", target: { tagName: "BUTTON" } }),
      false
    );
    assert.equal(count, 1);

    // Toggle disabled persists in storage and suppresses shortcut
    assert.equal(manager.toggle(), true);
    assert.equal(storage.getItem(SHORTCUTS_DISABLED_STORAGE_KEY), "true");
    assert.equal(manager.handleKeyDown({ key: " ", code: "Space" }), false);
    assert.equal(count, 1);

    // Re-enable restores dispatch
    assert.equal(manager.setDisabled(false), false);
    assert.equal(manager.handleKeyDown({ key: " ", code: "Space" }), true);
    assert.equal(count, 2);
  });
});

describe("a11y: LegionSkeletonCard log semantics & expiry notices", () => {
  const sampleSkeleton: SkeletonData = {
    skeletonId: "sk-a11y-1",
    role: "bonesetter",
    state: "running",
    taskIds: ["T1"],
    attempt: 1,
    currentToolCall: { tool: "sandbox_exec", toolCallId: "tc-1", startedAt: 1_000_000 },
    toolCallsCount: 1,
    logs: [
      "Checking rule M1 in file: package.json:12",
      "Applied M2 transform to src/index.js",
      "Running npm test",
    ],
    elapsedSeconds: 42,
    credits: null,
    worktree: "wt-1",
    lastEvent: null,
  };

  it("extracts rule and file metadata from console log lines", () => {
    assert.deepEqual(parseLogLineMeta("Checking rule M1 in file: package.json:12"), {
      rule: "M1",
      file: "package.json:12",
    });
    assert.deepEqual(parseLogLineMeta("Applied M2 transform to src/index.js"), {
      rule: "M2",
      file: "src/index.js",
    });
    assert.deepEqual(parseLogLineMeta("Running npm test"), {
      rule: "",
      file: "",
    });
  });

  it("renders accessible card name, role=log, aria-live=off, toggle, and row attributes", () => {
    const html = render(<LegionSkeletonCard skeleton={sampleSkeleton} />);
    assert.ok(html.includes('aria-labelledby="skeleton-card-title-sk-a11y-1"'));
    assert.ok(html.includes('aria-label="Skeleton bonesetter sk-a11y-1"'));
    assert.ok(html.includes('role="log"'));
    assert.ok(html.includes('aria-live="off"'));
    assert.ok(html.includes('data-testid="skeleton-log-announce-toggle-sk-a11y-1"'));
    assert.ok(html.includes("Log announcements: Off"));
    assert.ok(html.includes('data-rule="M1"'));
    assert.ok(html.includes('data-file="package.json:12"'));
    assert.ok(html.includes('data-rule="M2"'));
    assert.ok(html.includes('data-file="src/index.js"'));
    // Ticking elapsed timer is NOT inside the aria-live / role="log" container
    const logChunk = html.split('role="log"')[1] ?? "";
    assert.ok(!logChunk.includes("00:42"));
  });

  it("shows advance expiry notice in SkeletonInterruptConfirm", () => {
    const html = render(
      <SkeletonInterruptConfirm
        skeletonId="sk-a11y-1"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    assert.ok(
      html.includes('data-testid="skeleton-interrupt-expiry-notice-sk-a11y-1"')
    );
    assert.ok(html.includes("Advance notice:"));
  });
});

describe("a11y: ReliquaryDiffViewer <pre> fallback and ReplayPlayer badges", () => {
  it("renders semantic <pre> fallback with aria-label and keyboard-focusable scroll", () => {
    const html = render(
      <ReliquaryDiffViewer
        diff={"diff --git a/a.js b/a.js\n@@ -1,1 +1,1 @@ Task: T1 Rule: M2\n-old\n+new\n"}
      />
    );
    assert.ok(html.includes('data-testid="pre-diff-container"'));
    assert.ok(html.includes("<pre"));
    assert.ok(html.includes('aria-label="Code diff for a.js"'));
    const preChunk = html.slice(html.indexOf("<pre"));
    assert.ok(!preChunk.includes("text-violet-300"));
  });

  it("ReplayPlayer pairs event badges with icons and avoids purple body text", () => {
    assert.equal(getEventKindIcon("pact.approved"), "[◆]");
    assert.equal(getEventKindIcon("admin.kill"), "[!]");
    assert.equal(getEventKindIcon("skeleton.tool_call"), "[✓]");

    const events: EventEnvelope[] = [
      {
        runId: "run-a11y",
        seq: 1,
        ts: 1700000001000,
        kind: "pact.approved",
        actor: "user",
        data: { version: 1, refs: [] },
      },
    ];
    const html = render(
      <ReplayPlayer runId="run-a11y" initialEvents={events} />
    );
    assert.ok(html.includes("[◆]"));
    assert.ok(!html.includes("text-violet-300"));
    assert.ok(html.includes('data-reduced-motion="false"'));
  });
});
