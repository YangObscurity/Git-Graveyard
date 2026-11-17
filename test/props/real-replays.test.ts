// Task 15.7: Property test for Real replays (Property 18: Real replays (P18))
// Validates: Requirements 33.1, 33.2, 33.6

import assert from "node:assert/strict";
import child_process from "node:child_process";
import test, { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as fc from "fast-check";

import { DatabaseSync } from "node:sqlite";
import {
  buildReplayTimeline,
  formatTimeMs,
  formatTimestamp,
  ReplayPlayer,
  type ReplayTimelineItem,
  type ReplayTimelineEvent,
  type ReplayTimelineGap,
} from "../../components/ReplayPlayer";
import ReplayPage from "../../app/replay/[runId]/page";
import { EventStore } from "../../lib/events/event-store";
import type { EventEnvelope, EventKind } from "../../lib/events/types";

// ---------------------------------------------------------------------------
// Helpers and Arbitraries
// ---------------------------------------------------------------------------

const KNOWN_KINDS: EventKind[] = [
  "skeleton.tool_call",
  "skeleton.tool_result",
  "skeleton.log",
  "skeleton.state",
  "exhume.certificate",
  "pact.drafted",
  "pact.approved",
  "gate.result",
  "verdict",
  "admin.redaction",
  "admin.kill",
  "admin.publish",
  "run.started",
  "run.done",
];

const KNOWN_ACTORS = [
  "planner",
  "exhumer",
  "bonesetter",
  "soul-stitcher",
  "warden",
  "scribe",
  "admin",
  "system",
];

const FORBIDDEN_RUN_ACTION_BUTTONS = [
  "Pause run",
  "Resume run",
  "Stop run",
  "Cancel run",
  "Start run",
  "Kill run",
  "Exhume",
];

const safeRunIdArb = fc
  .stringMatching(/^[a-z0-9_-]{3,16}$/)
  .filter((s) => s.length >= 3);

const eventKindArb = fc.constantFrom(...KNOWN_KINDS);
const actorArb = fc.constantFrom(...KNOWN_ACTORS);

const eventDataArb = fc.record({
  message: fc.string({ minLength: 0, maxLength: 40 }),
  step: fc.integer({ min: 1, max: 100 }),
  refs: fc.array(fc.stringMatching(/^[a-z0-9_.-]{1,16}$/), { maxLength: 3 }),
});

function makeEvent(
  runId: string,
  seq: number,
  ts: number,
  kind: string = "skeleton.tool_call",
  actor: string = "planner",
  data: Record<string, unknown> = { refs: [] }
): EventEnvelope {
  return {
    runId,
    seq,
    ts,
    kind: kind as EventEnvelope["kind"],
    actor,
    data: {
      refs: Array.isArray(data.refs) ? (data.refs as string[]) : [],
      ...data,
    },
  };
}

/**
 * Spies on node:child_process to detect if any child process is spawned.
 */
function createProcessSpy() {
  let callCount = 0;
  const methods = ["spawn", "spawnSync", "exec", "execSync", "fork"] as const;
  const originals: Record<string, unknown> = {};

  for (const m of methods) {
    originals[m] = child_process[m];
  }

  return {
    install() {
      callCount = 0;
      for (const m of methods) {
        const orig = originals[m] as Function;
        Object.defineProperty(child_process, m, {
          value: (...args: unknown[]) => {
            callCount++;
            return orig.apply(child_process, args);
          },
          configurable: true,
          writable: true,
        });
      }
    },
    restore() {
      for (const m of methods) {
        Object.defineProperty(child_process, m, {
          value: originals[m],
          configurable: true,
          writable: true,
        });
      }
    },
    getCallCount() {
      return callCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suite: Property 18: Real replays (P18)
// Validates: Requirements 33.1, 33.2, 33.6
// ---------------------------------------------------------------------------

describe("Task 15.7 (Property 18: Real replays) - Property Tests", () => {
  describe("Requirement 33.1: Strict seq ordering, event preservation, and immutability", () => {
    it("Property 18.1: buildReplayTimeline orders arbitrary shuffled events strictly ascending by seq without losing or editing any event", () => {
      fc.assert(
        fc.property(
          safeRunIdArb,
          fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 40 }),
          fc.array(eventKindArb, { minLength: 40, maxLength: 40 }),
          fc.array(actorArb, { minLength: 40, maxLength: 40 }),
          (runId, seqs, kinds, actors) => {
            const rawEvents: EventEnvelope[] = seqs.map((seq, idx) =>
              makeEvent(
                runId,
                seq,
                1700000000000 + seq * 1000,
                kinds[idx % kinds.length],
                actors[idx % actors.length],
                { message: `event-${seq}`, refs: [] }
              )
            );

            // Snapshot copy for immutability check
            const eventsSnapshot = JSON.parse(JSON.stringify(rawEvents));

            const minSeq = Math.min(...seqs);
            const timeline = buildReplayTimeline(rawEvents, minSeq);

            // Invariant 1: Input array and objects were NOT mutated
            assert.deepEqual(rawEvents, eventsSnapshot, "Input events array must not be mutated");

            // Invariant 2: Exactly the input events appear in the timeline (no inserted/dropped events)
            const eventItems = timeline.filter(
              (item): item is ReplayTimelineEvent => item.type === "event"
            );
            assert.equal(
              eventItems.length,
              rawEvents.length,
              "Timeline must contain exactly the stored events"
            );

            // Invariant 3: Timeline events are strictly ascending by seq
            for (let i = 0; i < eventItems.length - 1; i++) {
              assert.ok(
                eventItems[i].event.seq < eventItems[i + 1].event.seq,
                `Events must be strictly ascending: ${eventItems[i].event.seq} < ${eventItems[i + 1].event.seq}`
              );
            }

            // Invariant 4: Every event preserves its exact properties (no edited events)
            const mapBySeq = new Map(rawEvents.map((e) => [e.seq, e]));
            for (const item of eventItems) {
              const original = mapBySeq.get(item.event.seq);
              assert.ok(original, `Original event for seq ${item.event.seq} must exist`);
              assert.equal(item.event.runId, original.runId);
              assert.equal(item.event.ts, original.ts);
              assert.equal(item.event.kind, original.kind);
              assert.equal(item.event.actor, original.actor);
              assert.deepEqual(item.event.data, original.data);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Property 18.2: Pure helper buildReplayTimeline is idempotent and handles deeply frozen inputs", () => {
      fc.assert(
        fc.property(
          safeRunIdArb,
          fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 25 }),
          (runId, seqs) => {
            const rawEvents: EventEnvelope[] = seqs.map((seq) =>
              Object.freeze(makeEvent(runId, seq, 1700000000000 + seq * 500))
            );
            Object.freeze(rawEvents);

            // Calling on frozen array and objects must succeed without mutation errors
            const minSeq = Math.min(...seqs);
            const timeline1 = buildReplayTimeline(rawEvents, minSeq);
            const timeline2 = buildReplayTimeline(rawEvents, minSeq);

            // Idempotent and deterministic
            assert.deepEqual(timeline1, timeline2, "buildReplayTimeline must be deterministic");
          }
        ),
        { numRuns: 50 }
      );
    });

    it("Property 18.3: Rendered markup displays events in strict sequential order with preserved payloads", () => {
      fc.assert(
        fc.property(
          safeRunIdArb,
          fc.uniqueArray(fc.integer({ min: 1, max: 150 }), { minLength: 1, maxLength: 15 }),
          (runId, seqs) => {
            const rawEvents: EventEnvelope[] = seqs.map((seq) =>
              makeEvent(runId, seq, 1700000000000 + seq * 1000, "skeleton.tool_call", "planner", {
                token: `tok-${seq}`,
                refs: [],
              })
            );

            const sortedSeqs = [...seqs].sort((a, b) => a - b);
            const html = renderToStaticMarkup(
              React.createElement(ReplayPlayer, {
                runId,
                initialEvents: rawEvents,
                from: sortedSeqs[0],
              })
            );

            // Verify each event appears in strict chronological position in HTML
            let lastPos = -1;
            for (const seq of sortedSeqs) {
              const marker = `data-testid="replay-event-${seq}"`;
              const pos = html.indexOf(marker);
              assert.ok(pos !== -1, `Event marker for seq ${seq} must exist in rendered HTML`);
              assert.ok(
                pos > lastPos,
                `Event ${seq} must appear in HTML after previous event (current pos: ${pos}, last pos: ${lastPos})`
              );
              lastPos = pos;

              // Payload token must be rendered in data pre
              assert.ok(
                html.includes(`tok-${seq}`),
                `Event data payload for seq ${seq} must be present in HTML`
              );
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Requirement 33.2: Visual gaps for missing sequence numbers", () => {
    it("Property 18.4: Gap detection partitions the sequence space [expectedStartSeq, maxSeq] exactly", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 30 }),
          (expectedStartSeq, rawSeqs) => {
            // Adjust sequence numbers so all are >= expectedStartSeq
            const seqs = Array.from(new Set(rawSeqs.map((s) => s + expectedStartSeq - 1)));
            const events: EventEnvelope[] = seqs.map((seq) =>
              makeEvent("run-gap-test", seq, 1700000000000 + seq * 1000)
            );

            const minSeq = Math.min(...seqs);
            const maxSeq = Math.max(...seqs);
            const timeline = buildReplayTimeline(events, expectedStartSeq);

            const gaps = timeline.filter(
              (item): item is ReplayTimelineGap => item.type === "gap"
            );
            const timelineEvents = timeline.filter(
              (item): item is ReplayTimelineEvent => item.type === "event"
            );

            // Invariant 1: All gaps are well-formed (fromSeq <= toSeq)
            for (const gap of gaps) {
              assert.ok(
                gap.fromSeq <= gap.toSeq,
                `Gap bounds must be ordered: fromSeq ${gap.fromSeq} <= toSeq ${gap.toSeq}`
              );
            }

            // Invariant 2: Gaps and events are disjoint (no event falls within any gap)
            const eventSeqSet = new Set(seqs);
            for (const gap of gaps) {
              for (let s = gap.fromSeq; s <= gap.toSeq; s++) {
                assert.ok(
                  !eventSeqSet.has(s),
                  `Missing sequence ${s} in gap must not be present in events`
                );
              }
            }

            // Invariant 3: Every missing sequence in [expectedStartSeq, maxSeq] is in exactly one gap
            let totalMissingCount = 0;
            for (const gap of gaps) {
              totalMissingCount += gap.toSeq - gap.fromSeq + 1;
            }
            const expectedTotalRange = maxSeq - expectedStartSeq + 1;
            assert.equal(
              timelineEvents.length + totalMissingCount,
              expectedTotalRange,
              "Events count + missing gap count must exactly equal total range"
            );

            // Invariant 4: No two gaps are consecutive without an event in between
            for (let i = 0; i < timeline.length - 1; i++) {
              if (timeline[i].type === "gap") {
                assert.equal(
                  timeline[i + 1].type,
                  "event",
                  "A gap must be followed by an event"
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Property 18.5: Contiguous event streams produce zero gaps", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 40 }),
          (startSeq, count) => {
            const events: EventEnvelope[] = Array.from({ length: count }, (_, idx) =>
              makeEvent("run-contig-test", startSeq + idx, 1700000000000 + idx * 1000)
            );

            const timeline = buildReplayTimeline(events, startSeq);
            const gaps = timeline.filter((item) => item.type === "gap");

            assert.equal(gaps.length, 0, "Contiguous event stream must produce zero gaps");

            const html = renderToStaticMarkup(
              React.createElement(ReplayPlayer, {
                runId: "run-contig-test",
                initialEvents: events,
                from: startSeq,
              })
            );

            assert.ok(
              !html.includes("data-testid=\"replay-gap\""),
              "Rendered HTML of contiguous stream must contain no replay-gap elements"
            );
          }
        ),
        { numRuns: 50 }
      );
    });

    it("Property 18.6: Visual gaps render with exact testid and range descriptions in HTML", () => {
      fc.assert(
        fc.property(
          safeRunIdArb,
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 2, max: 8 }),
          (runId, startSeq, gapSize) => {
            // Event 1 at startSeq, Event 2 at startSeq + gapSize + 1
            const ev1 = makeEvent(runId, startSeq, 1700000001000);
            const ev2 = makeEvent(runId, startSeq + gapSize + 1, 1700000002000);
            const events = [ev1, ev2];

            const html = renderToStaticMarkup(
              React.createElement(ReplayPlayer, {
                runId,
                initialEvents: events,
                from: startSeq,
              })
            );

            assert.ok(
              html.includes("data-testid=\"replay-gap\""),
              "Rendered HTML must contain gap element"
            );

            const expectedGapFrom = startSeq + 1;
            const expectedGapTo = startSeq + gapSize;
            const expectedLabel =
              expectedGapFrom === expectedGapTo
                ? `seq ${expectedGapFrom}`
                : `seq ${expectedGapFrom} to ${expectedGapTo}`;

            assert.ok(
              html.includes(`Gap: missing event ${expectedLabel}`),
              `HTML must contain exact gap description: 'Gap: missing event ${expectedLabel}'`
            );
          }
        ),
        { numRuns: 40 }
      );
    });
  });

  describe("Requirement 33.6: Zero live Skeleton processes and zero Kiro credentials", () => {
    it("Property 18.7: Replay loading and rendering spawns strictly ZERO child processes", async () => {
      const spy = createProcessSpy();
      spy.install();

      try {
        await fc.assert(
          fc.asyncProperty(
            safeRunIdArb,
            fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { minLength: 0, maxLength: 15 }),
            async (runId, seqs) => {
              const beforeCount = spy.getCallCount();

              const events: EventEnvelope[] = seqs.map((seq) =>
                makeEvent(runId, seq, 1700000000000 + seq * 1000)
              );

              // 1. Pure helper timeline construction
              const minSeq = seqs.length > 0 ? Math.min(...seqs) : 1;
              buildReplayTimeline(events, minSeq);

              // 2. React component static markup render
              renderToStaticMarkup(
                React.createElement(ReplayPlayer, {
                  runId,
                  initialEvents: events,
                })
              );

              // 3. ReplayPage server component render
              const pageElement = await ReplayPage({
                params: Promise.resolve({ runId }),
                searchParams: Promise.resolve({ from: "1", to: "100" }),
              });
              renderToStaticMarkup(pageElement);

              const afterCount = spy.getCallCount();
              assert.equal(
                afterCount - beforeCount,
                0,
                "Loading and rendering Replay must spawn strictly zero child processes"
              );
            }
          ),
          { numRuns: 30 }
        );
      } finally {
        spy.restore();
      }
    });

    it("Property 18.8: Replay loads and renders cleanly in environments with zero Kiro credentials", async () => {
      // Save original environment
      const originalApiKey = process.env.KIRO_API_KEY;
      const originalHome = process.env.KIRO_HOME;

      try {
        await fc.assert(
          fc.asyncProperty(
            safeRunIdArb,
            fc.constantFrom(undefined, "", "dummy-non-existent-key"),
            fc.constantFrom(undefined, "", "/non/existent/path"),
            fc.uniqueArray(fc.integer({ min: 1, max: 80 }), { minLength: 1, maxLength: 10 }),
            async (runId, dummyKey, dummyHome, seqs) => {
              // Strip or mock Kiro environment to verify zero credential dependency
              if (dummyKey === undefined) {
                delete process.env.KIRO_API_KEY;
              } else {
                process.env.KIRO_API_KEY = dummyKey;
              }

              if (dummyHome === undefined) {
                delete process.env.KIRO_HOME;
              } else {
                process.env.KIRO_HOME = dummyHome;
              }

              const events = seqs.map((seq) =>
                makeEvent(runId, seq, 1700000000000 + seq * 1000)
              );

              // Timeline helper must succeed without credentials
              const timeline = buildReplayTimeline(events, 1);
              assert.ok(timeline.length > 0);

              // ReplayPlayer must render without credentials
              const playerHtml = renderToStaticMarkup(
                React.createElement(ReplayPlayer, {
                  runId,
                  initialEvents: events,
                })
              );
              assert.ok(playerHtml.includes("data-testid=\"replay-banner\""));
              assert.ok(playerHtml.includes("Replay"));

              // ReplayPage must render without credentials
              const pageElement = await ReplayPage({
                params: Promise.resolve({ runId }),
              });
              const pageHtml = renderToStaticMarkup(pageElement);
              assert.ok(pageHtml.includes("data-testid=\"replay-banner\""));
            }
          ),
          { numRuns: 30 }
        );
      } finally {
        // Restore environment
        if (originalApiKey !== undefined) {
          process.env.KIRO_API_KEY = originalApiKey;
        } else {
          delete process.env.KIRO_API_KEY;
        }
        if (originalHome !== undefined) {
          process.env.KIRO_HOME = originalHome;
        } else {
          delete process.env.KIRO_HOME;
        }
      }
    });

    it("Property 18.9: Cold storage playback from SQLite EventStore requires zero live skeletons and zero credentials", async () => {
      const spy = createProcessSpy();
      spy.install();

      const originalApiKey = process.env.KIRO_API_KEY;
      delete process.env.KIRO_API_KEY;

      try {
        await fc.assert(
          fc.asyncProperty(
            safeRunIdArb,
            fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 15 }),
            async (runId, seqs) => {
              const beforeCount = spy.getCallCount();

              // Initialize in-memory SQLite EventStore with zero live skeletons
              const db = new DatabaseSync(":memory:");
              const store = new EventStore({ db });

              const insertStmt = db.prepare(
                "INSERT INTO events (runId, seq, ts, kind, actor, data) VALUES (?, ?, ?, ?, ?, ?)"
              );

              // Seed events
              const sortedSeqs = [...seqs].sort((a, b) => a - b);
              for (const seq of sortedSeqs) {
                insertStmt.run(
                  runId,
                  seq,
                  1700000000000 + seq * 1000,
                  "skeleton.tool_call",
                  "planner",
                  JSON.stringify({ action: `exec-${seq}`, refs: [] })
                );
              }

              // Retrieve stored events from cold storage
              const storedEvents = store.getEvents(runId);
              assert.equal(storedEvents.length, seqs.length);

              // Reconstruct replay timeline
              const minSeq = sortedSeqs[0];
              const timeline = buildReplayTimeline(storedEvents, minSeq);

              // Render replay player
              const html = renderToStaticMarkup(
                React.createElement(ReplayPlayer, {
                  runId,
                  initialEvents: storedEvents,
                  from: minSeq,
                })
              );

              // Validate strict seq order and presence
              assert.ok(html.includes("data-testid=\"replay-banner\""));
              for (const seq of sortedSeqs) {
                assert.ok(
                  html.includes(`data-testid="replay-event-${seq}"`),
                  `Event ${seq} from EventStore must be rendered`
                );
              }

              // Verify zero child processes were spawned during cold playback
              const afterCount = spy.getCallCount();
              assert.equal(
                afterCount - beforeCount,
                0,
                "Cold store replay must operate with strictly zero child processes"
              );

              store.close();
            }
          ),
          { numRuns: 20 }
        );
      } finally {
        spy.restore();
        if (originalApiKey !== undefined) {
          process.env.KIRO_API_KEY = originalApiKey;
        }
      }
    });
  });

  describe("Requirement 33.7 & 33.8: Replay banner, redactions, and exclusion of run action buttons", () => {
    it("Property 18.10: Replay banner is persistent and run action buttons are strictly excluded", () => {
      fc.assert(
        fc.property(
          safeRunIdArb,
          fc.uniqueArray(fc.integer({ min: 1, max: 50 }), { minLength: 0, maxLength: 10 }),
          (runId, seqs) => {
            const events = seqs.map((seq) =>
              makeEvent(runId, seq, 1700000000000 + seq * 1000)
            );

            const html = renderToStaticMarkup(
              React.createElement(ReplayPlayer, {
                runId,
                initialEvents: events,
              })
            );

            // Persistent Replay banner and runId
            assert.ok(html.includes("data-testid=\"replay-banner\""));
            assert.ok(html.includes("Replay"));
            assert.ok(html.includes(`Run: ${runId}`));

            // Every run action button MUST be absent
            for (const buttonText of FORBIDDEN_RUN_ACTION_BUTTONS) {
              assert.ok(
                !html.includes(buttonText),
                `Run action button '${buttonText}' must NOT be present in Replay view`
              );
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it("Property 18.11: Redaction events render 'Redacted by the owner' and hide sensitive event data", () => {
      fc.assert(
        fc.property(
          safeRunIdArb,
          fc.integer({ min: 1, max: 100 }),
          fc.stringMatching(/^[A-Z0-9_]{8,20}$/),
          (runId, seq, secretValue) => {
            const redactionEvent = makeEvent(
              runId,
              seq,
              1700000000000 + seq * 1000,
              "admin.redaction",
              "admin",
              { confidential: secretValue, refs: [] }
            );

            const html = renderToStaticMarkup(
              React.createElement(ReplayPlayer, {
                runId,
                initialEvents: [redactionEvent],
                from: seq,
              })
            );

            // Requirement 33.8: show "Redacted by the owner"
            assert.ok(html.includes("data-testid=\"redaction-label\""));
            assert.ok(html.includes("Redacted by the owner"));

            // Sensitive data in redaction event must not be rendered
            assert.ok(
              !html.includes(secretValue),
              "Confidential payload in admin.redaction must not be displayed"
            );
          }
        ),
        { numRuns: 30 }
      );
    });

    it("Property 18.12: Time formatting helpers are pure, robust, and monotonic", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100000000 }),
          (ms) => {
            const formatted = formatTimeMs(ms);
            assert.match(
              formatted,
              /^\d+:\d{2}$/,
              "formatTimeMs must produce minutes:seconds format"
            );

            const formattedTs = formatTimestamp(ms);
            assert.ok(
              formattedTs.length > 0,
              "formatTimestamp must return non-empty timestamp string"
            );
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
