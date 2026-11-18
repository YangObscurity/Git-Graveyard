import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HistoryList,
  formatOutcome,
  formatDuration,
  type HistoryRunItem,
} from "@/components/HistoryList";
import HistoryPage from "@/app/history/page";

describe("Task 15.6 / Requirement 33: History Page (real recorded runs only)", () => {
  describe("Requirement 33.3: Show only runs with an admin.publish event", () => {
    it("renders published runs and omits unpublished runs", () => {
      const mockRuns: HistoryRunItem[] = [
        {
          runId: "run-pub-1",
          repository: "owner/repo-one",
          sha: "abc1234567",
          isPublished: true,
          outcome: "resurrected",
          createdAt: 1700000000000,
        },
        {
          runId: "run-unpub-2",
          repository: "owner/repo-two",
          sha: "def2345678",
          isPublished: false,
          outcome: "resurrected",
          createdAt: 1700000100000,
        },
        {
          runId: "run-pub-3",
          repository: "owner/repo-three",
          sha: "789abcdef0",
          isPublished: true,
          outcome: "partial",
          createdAt: 1700000200000,
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(HistoryList, { initialRuns: mockRuns })
      );

      assert.ok(html.includes("owner/repo-one"), "Published run 1 should be rendered");
      assert.ok(!html.includes("owner/repo-two"), "Unpublished run 2 should NOT be rendered");
      assert.ok(html.includes("owner/repo-three"), "Published run 3 should be rendered");
    });
  });

  describe("Task 15.6: Each run labelled 'Recorded run'", () => {
    it("labels each published run with 'Recorded run'", () => {
      const mockRuns: HistoryRunItem[] = [
        {
          runId: "run-pub-1",
          repository: "owner/repo-one",
          isPublished: true,
          outcome: "resurrected",
        },
        {
          runId: "run-pub-2",
          repository: "owner/repo-two",
          isPublished: true,
          outcome: "failed",
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(HistoryList, { initialRuns: mockRuns })
      );

      const matches = html.match(/Recorded run/g);
      assert.equal(matches?.length, 2, "Every published run must be labelled 'Recorded run'");
    });
  });

  describe("Requirement 33.5: Failed, partial, and cancelled runs displayed at same weight (no best of filter)", () => {
    it("displays failed, partial, cancelled, and successful runs equally", () => {
      const mockRuns: HistoryRunItem[] = [
        {
          runId: "run-resurrected",
          repository: "owner/repo-resurrected",
          isPublished: true,
          outcome: "resurrected",
        },
        {
          runId: "run-failed",
          repository: "owner/repo-failed",
          isPublished: true,
          outcome: "not_resurrected",
        },
        {
          runId: "run-partial",
          repository: "owner/repo-partial",
          isPublished: true,
          outcome: "partial",
        },
        {
          runId: "run-cancelled",
          repository: "owner/repo-cancelled",
          isPublished: true,
          outcome: "cancelled",
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(HistoryList, { initialRuns: mockRuns })
      );

      assert.ok(html.includes("owner/repo-resurrected"));
      assert.ok(html.includes("Resurrected"));
      assert.ok(html.includes("owner/repo-failed"));
      assert.ok(html.includes("Not Resurrected"));
      assert.ok(html.includes("owner/repo-partial"));
      assert.ok(html.includes("Partially Resurrected"));
      assert.ok(html.includes("owner/repo-cancelled"));
      assert.ok(html.includes("Cancelled"));
    });
  });

  describe("Requirement 33.10: Removed-run label when admin hides a published run", () => {
    it("shows 'Removed by the owner' when isRemoved is true or outcome indicates removed", () => {
      const mockRuns: HistoryRunItem[] = [
        {
          runId: "run-removed-1",
          repository: "owner/repo-hidden",
          isPublished: true,
          isRemoved: true,
          outcome: "resurrected",
        },
        {
          runId: "run-normal-2",
          repository: "owner/repo-active",
          isPublished: true,
          isRemoved: false,
          outcome: "resurrected",
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(HistoryList, { initialRuns: mockRuns })
      );

      assert.ok(html.includes("Removed by the owner"));
      assert.ok(html.includes("history-replay-link-run-normal-2"));
      // The removed run should not offer an active replay link
      assert.ok(!html.includes("history-replay-link-run-removed-1"));
    });
  });

  describe("Requirement 39.1: Empty state in plain words", () => {
    it("shows 'No recorded runs have been published yet.' when empty", () => {
      const html = renderToStaticMarkup(
        React.createElement(HistoryList, { initialRuns: [] })
      );

      assert.ok(html.includes("No recorded runs have been published yet."));
    });
  });

  describe("Plain words formatters for outcome and duration", () => {
    it("formats all outcomes to plain words without jargon", () => {
      assert.equal(formatOutcome("resurrected"), "Resurrected");
      assert.equal(formatOutcome("resurrected_build_only"), "Resurrected (build only)");
      assert.equal(formatOutcome("partial"), "Partially Resurrected");
      assert.equal(formatOutcome("not_resurrected"), "Not Resurrected");
      assert.equal(formatOutcome("healthy_already"), "Healthy Already");
      assert.equal(formatOutcome("cancelled"), "Cancelled");
      assert.equal(formatOutcome("killed"), "Killed");
      assert.equal(formatOutcome("budget_stopped"), "Budget Exceeded");
      assert.equal(formatOutcome("error"), "Error");
      assert.equal(formatOutcome("anything", true), "Removed by the owner");
      assert.equal(formatOutcome("Removed by the owner"), "Removed by the owner");
    });

    it("formats wall time durations cleanly", () => {
      assert.equal(formatDuration(1000, 5000), "4s");
      assert.equal(formatDuration(1000, 65000), "1m 4s");
      assert.equal(formatDuration(null, 5000), null);
    });
  });

  describe("HistoryPage full render", () => {
    it("renders HistoryPage with header, list container, and footer", () => {
      const html = renderToStaticMarkup(React.createElement(HistoryPage));
      assert.ok(html.includes("Recorded Run History"));
      assert.ok(html.includes("Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project."));
    });
  });
});
