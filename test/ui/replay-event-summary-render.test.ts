/**
 * Replay shows each event's plain-English summary first; the raw JSON is kept in a
 * collapsed "Raw event" disclosure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReplayPlayer } from "@/components/ReplayPlayer";
import type { EventEnvelope } from "@/lib/events/types";

const recorded: EventEnvelope[] = readFileSync(
  join(process.cwd(), "output/recorded-runs/live-gulp-plumber-t40/events.ndjson"),
  "utf8"
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as EventEnvelope);

function render(events: EventEnvelope[]): string {
  return renderToStaticMarkup(
    React.createElement(ReplayPlayer, { runId: "live-gulp-plumber-t40", initialEvents: events })
  );
}

describe("ReplayPlayer event summaries", () => {
  const html = render(recorded);

  it("renders one summary per event", () => {
    const count = html.split('data-testid="event-summary"').length - 1;
    assert.equal(count, recorded.length);
  });

  it("shows the plain-English summary text", () => {
    assert.ok(html.includes("npm install --ignore-scripts passed (exit 0, 12.9s)"));
    assert.ok(html.includes("Started: npm --version"));
    assert.ok(html.includes("Phase: queued → exhume"));
    assert.ok(html.includes("Grimoire analysis detected 0 deprecation signals on base tree"));
  });

  it("keeps the raw JSON in a closed 'Raw event' disclosure", () => {
    const rawBlocks = html.match(/<details[^>]*data-testid="event-raw"[^>]*>/g) ?? [];
    assert.equal(rawBlocks.length, recorded.length);
    for (const block of rawBlocks) {
      assert.ok(!/\sopen(=|\s|>)/.test(block), `raw event must be collapsed: ${block}`);
    }
    assert.ok(html.includes("Raw event"));
    assert.ok(html.includes("&quot;commandLine&quot;: &quot;npm install --ignore-scripts&quot;"));
  });

  it("the summary comes before the raw JSON within each event", () => {
    const start = html.indexOf('data-testid="replay-event-8"');
    const summaryPos = html.indexOf('data-testid="event-summary"', start);
    const rawPos = html.indexOf('data-testid="event-raw"', start);
    assert.ok(start !== -1 && summaryPos !== -1 && rawPos !== -1);
    assert.ok(summaryPos < rawPos);
  });

  it("an admin.redaction event shows only the redaction label", () => {
    const redacted = render([
      { runId: "r", seq: 1, ts: 1, kind: "admin.redaction", actor: "admin", data: { refs: [] } },
    ]);
    assert.ok(redacted.includes("Redacted by the owner"));
    assert.ok(!redacted.includes('data-testid="event-raw"'));
  });
});
