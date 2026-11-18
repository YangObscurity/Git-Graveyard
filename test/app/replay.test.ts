import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as fc from "fast-check";
import type { EventEnvelope } from "@/lib/events/types";
import {
  ReplayPlayer,
  buildReplayTimeline,
  formatTimeMs,
  formatTimestamp,
} from "@/components/ReplayPlayer";
import ReplayPage from "@/app/replay/[runId]/page";

function makeMockEvent(seq: number, ts: number = 1700000000000 + seq * 1000, kind: string = "skeleton.tool_call"): EventEnvelope {
  return {
    runId: "run-test-replay",
    seq,
    ts,
    kind: kind as EventEnvelope["kind"],
    actor: "planner",
    data: { message: `Step ${seq}`, refs: [] },
  };
}

describe("Task 15.6 / Requirement 33 & 39: Replay page (real recorded runs only)", () => {
  describe("Requirement 33.1: Stored events rendered strictly in seq order", () => {
    it("renders events strictly ordered by seq ascending without editing or inventing events", () => {
      // Out of order input events
      const rawEvents: EventEnvelope[] = [
        makeMockEvent(3, 1700000003000),
        makeMockEvent(1, 1700000001000),
        makeMockEvent(2, 1700000002000),
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-order-test",
          initialEvents: rawEvents,
        })
      );

      const pos1 = html.indexOf("#1");
      const pos2 = html.indexOf("#2");
      const pos3 = html.indexOf("#3");

      assert.ok(pos1 !== -1 && pos2 !== -1 && pos3 !== -1, "All events must be rendered");
      assert.ok(pos1 < pos2, "Event 1 must precede Event 2");
      assert.ok(pos2 < pos3, "Event 2 must precede Event 3");
    });
  });

  describe("Requirement 33.2: Visible gap rendered at missing seq numbers", () => {
    it("renders a visible gap indicator when sequence numbers are missing", () => {
      // Missing seq 2 and missing seq 4, 5
      const eventsWithGaps: EventEnvelope[] = [
        makeMockEvent(1),
        makeMockEvent(3),
        makeMockEvent(6),
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-gap-test",
          initialEvents: eventsWithGaps,
        })
      );

      assert.ok(html.includes("data-testid=\"replay-gap\""), "Gap elements must be rendered");
      assert.ok(html.includes("Gap: missing event seq 2"), "Missing seq 2 must be identified");
      assert.ok(html.includes("Gap: missing event seq 4 to 5"), "Missing seq 4 to 5 range must be identified");
    });

    it("renders a visible gap if stream does not start at expected seq", () => {
      const events: EventEnvelope[] = [
        makeMockEvent(3),
        makeMockEvent(4),
      ];

      const timeline = buildReplayTimeline(events, 1);
      assert.equal(timeline[0].type, "gap");
      if (timeline[0].type === "gap") {
        assert.equal(timeline[0].fromSeq, 1);
        assert.equal(timeline[0].toSeq, 2);
      }
    });
  });

  describe("Requirement 33.7: Persistent 'Replay' banner and no run action buttons", () => {
    it("renders persistent Replay banner and hides every run action button", () => {
      const events: EventEnvelope[] = [
        makeMockEvent(1),
        makeMockEvent(2),
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-banner-test",
          initialEvents: events,
        })
      );

      // Persistent banner
      assert.ok(html.includes("data-testid=\"replay-banner\""));
      assert.ok(html.includes("Replay"));
      assert.ok(html.includes("Run: run-banner-test"));

      // Run action buttons must NOT be present
      assert.ok(!html.includes("Pause run"));
      assert.ok(!html.includes("Resume run"));
      assert.ok(!html.includes("Stop run"));
      assert.ok(!html.includes("Cancel run"));
      assert.ok(!html.includes("Start run"));
      assert.ok(!html.includes("Kill run"));
      assert.ok(!html.includes("Exhume"));
    });
  });

  describe("Requirement 33.8: 'Redacted by the owner' at admin.redaction point", () => {
    it("renders 'Redacted by the owner' when reaching an admin.redaction event", () => {
      const events: EventEnvelope[] = [
        makeMockEvent(1, 1700000001000, "skeleton.tool_call"),
        makeMockEvent(2, 1700000002000, "admin.redaction"),
        makeMockEvent(3, 1700000003000, "run.done"),
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-redaction-test",
          initialEvents: events,
        })
      );

      assert.ok(html.includes("data-testid=\"redaction-label\""));
      assert.ok(html.includes("Redacted by the owner"));
    });
  });

  describe("Requirement 33.9: Replay time, original time, and shortened wait labels", () => {
    it("displays replay time and original time in clocks", () => {
      const events: EventEnvelope[] = [
        makeMockEvent(1, 1700000001000),
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-clocks-test",
          initialEvents: events,
        })
      );

      assert.ok(html.includes("data-testid=\"replay-time\""));
      assert.ok(html.includes("Replay time:"));
      assert.ok(html.includes("data-testid=\"original-time\""));
      assert.ok(html.includes("Original time:"));
    });

    it("labels shortened waits when wall time between events exceeds threshold", () => {
      const events: EventEnvelope[] = [
        makeMockEvent(1, 1700000000000),
        makeMockEvent(2, 1700000060000), // 60s wait
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-wait-test",
          initialEvents: events,
        })
      );

      assert.ok(html.includes("data-testid=\"shortened-wait-label\""));
      assert.ok(html.includes("Shortened wait"));
    });
  });

  describe("Requirement 39.4: Ended state and Reliquary offer at last event", () => {
    it("shows ended state and offers link to Reliquary at the last event", () => {
      const events: EventEnvelope[] = [
        makeMockEvent(1),
        makeMockEvent(2),
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-ended-test",
          initialEvents: events,
        })
      );

      assert.ok(html.includes("data-testid=\"replay-ended-state\""));
      assert.ok(html.includes("Run ended"));
      assert.ok(html.includes("data-testid=\"replay-reliquary-link\""));
      assert.ok(html.includes("/runs/run-ended-test/relic"));
    });
  });

  describe("Requirement 39.5: Killed run stopped label on last event", () => {
    it("labels last stored event as point where run was stopped when run was killed", () => {
      const events: EventEnvelope[] = [
        makeMockEvent(1, 1700000001000, "skeleton.tool_call"),
        makeMockEvent(2, 1700000002000, "admin.kill"),
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-killed-test",
          initialEvents: events,
        })
      );

      assert.ok(html.includes("data-testid=\"run-stopped-label\""));
      assert.ok(html.includes("Point where the run was stopped"));
    });
  });

  describe("Empty state in plain words", () => {
    it("renders 'No events recorded for this run.' when event stream is empty", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-empty-test",
          initialEvents: [],
        })
      );

      assert.ok(html.includes("data-testid=\"replay-empty\""));
      assert.ok(html.includes("No events recorded for this run."));
    });
  });

  describe("ReplayPage async server component render", () => {
    it("renders ReplayPage correctly with runId param", async () => {
      const pageElement = await ReplayPage({
        params: Promise.resolve({ runId: "test-run-123" }),
      });
      const html = renderToStaticMarkup(pageElement);

      assert.ok(html.includes("Run: test-run-123"));
      assert.ok(html.includes("data-testid=\"replay-banner\""));
    });
  });

  describe("Property 18: Replay timeline invariants (fast-check)", () => {
    it("always produces sorted events, accurate gap detection, and preserves all original events", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.integer({ min: 1, max: 200 }), { minLength: 1, maxLength: 50 }),
          (seqNumbers) => {
            // Create random events with these sequence numbers in arbitrary order
            const events: EventEnvelope[] = seqNumbers.map((s) => makeMockEvent(s));
            const sortedSeq = [...seqNumbers].sort((a, b) => a - b);
            const minSeq = sortedSeq[0];

            const timeline = buildReplayTimeline(events, minSeq);

            // Invariant 1: All events in timeline are sorted by seq ascending
            const eventItems = timeline.filter((t) => t.type === "event") as { type: "event"; event: EventEnvelope }[];
            assert.equal(eventItems.length, events.length, "No events should be lost");
            for (let i = 0; i < eventItems.length - 1; i++) {
              assert.ok(
                eventItems[i].event.seq < eventItems[i + 1].event.seq,
                "Events must be strictly ascending"
              );
            }

            // Invariant 2: Missing sequences between consecutive events produce exact gaps
            const gapItems = timeline.filter((t) => t.type === "gap") as { type: "gap"; fromSeq: number; toSeq: number }[];
            for (const gap of gapItems) {
              assert.ok(gap.fromSeq <= gap.toSeq, "Gap fromSeq must be <= toSeq");
            }

            // Invariant 3: Sum of event count + covered gap seq count equals total range
            let totalMissingCount = 0;
            for (const gap of gapItems) {
              totalMissingCount += gap.toSeq - gap.fromSeq + 1;
            }
            const expectedTotalRange = sortedSeq[sortedSeq.length - 1] - minSeq + 1;
            assert.equal(
              eventItems.length + totalMissingCount,
              expectedTotalRange,
              "Events plus gaps must cover the exact seq range"
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
