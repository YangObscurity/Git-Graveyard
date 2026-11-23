/**
 * Legion header copy must match the run state: a concluded run must not say it
 * "keeps going" or is waiting for a tool call, and "not reported" meters get a
 * one-line explanation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LegionRunHeader } from "@/components/LegionRunHeader";

function render(props: Partial<React.ComponentProps<typeof LegionRunHeader>> = {}) {
  return renderToStaticMarkup(
    <LegionRunHeader runId="run-1" phase="legion" {...props} />
  );
}

describe("LegionRunHeader: run state copy", () => {
  it("says the run keeps going while it is live", () => {
    const html = render({ phase: "legion" });

    assert.ok(html.includes("You can leave this page. The run keeps going."));
    assert.ok(html.includes("Now: Waiting for next tool call"));
  });

  it("says the run has ended once it is done", () => {
    const html = render({ phase: "done" });

    assert.ok(!html.includes("The run keeps going."));
    assert.ok(!html.includes("Waiting for next tool call"));
    assert.ok(html.includes("This run has ended."));
  });
});

describe("LegionRunHeader: not reported meters", () => {
  it("explains not reported when a cap or credits were not recorded", () => {
    const html = render({ toolCallsCap: null, wallClockCapMinutes: null, creditsUsed: null });

    assert.ok(html.includes("not reported"));
    assert.ok(html.includes("Credits are not reported by the CLI."));
  });

  it("shows no explanation when every value was recorded", () => {
    const html = render({
      toolCallsUsed: 3,
      toolCallsCap: 100,
      wallClockMinutes: 2,
      wallClockCapMinutes: 60,
      creditsUsed: 1,
      creditsCap: 10,
    });

    assert.ok(!html.includes("Credits are not reported by the CLI."));
  });
});
