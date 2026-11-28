import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusPill, type StatusPillProps } from "@/components/ui/StatusPill";
import { StateGlyph, type StateFamily } from "@/components/ui/StateGlyph";
import { RitualRibbon } from "@/components/ui/RitualRibbon";
import { CryptOrnament } from "@/components/ui/CryptOrnament";

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

describe("StateGlyph", () => {
  const families: StateFamily[] = ["risen", "wait", "fail", "idle", "kiro"];

  it("renders an aria-hidden inline SVG for every state family", () => {
    for (const family of families) {
      const html = render(<StateGlyph family={family} />);
      assert.ok(html.includes("<svg"), `Expected SVG for family ${family}`);
      assert.ok(
        html.includes('aria-hidden="true"'),
        `Expected aria-hidden="true" for family ${family}`
      );
      assert.ok(
        html.includes(`data-state-family="${family}"`),
        `Expected data-state-family="${family}"`
      );
    }
  });
});

describe("StatusPill", () => {
  const tones: Array<{ tone: StatusPillProps["tone"]; label: string }> = [
    { tone: "emerald", label: "Passed" },
    { tone: "amber", label: "Approval Required" },
    { tone: "crimson", label: "Failed" },
    { tone: "violet", label: "Kiro spec" },
    { tone: "neutral", label: "Not run" },
  ];

  it("renders an icon and accessible text label for every tone without violet body text", () => {
    for (const { tone, label } of tones) {
      const html = render(
        <StatusPill tone={tone} label={label} testId={`pill-${tone}`} />
      );
      assert.ok(html.includes(`data-testid="pill-${tone}"`));
      assert.ok(html.includes('data-ui-element="status-pill"'));
      assert.ok(html.includes(`data-ui-variant="${tone}"`));
      assert.ok(html.includes("<svg"), `Expected icon SVG for tone ${tone}`);
      assert.ok(html.includes(label), `Expected label "${label}" in output`);
      if (tone === "violet") {
        assert.ok(
          !html.includes("text-violet-"),
          "Violet StatusPill must not apply purple text classes"
        );
        assert.ok(html.includes("crypt-kiro"));
      }
    }
  });
});

describe("RitualRibbon", () => {
  it("renders all five stations, marks current with aria-current=\"step\", and links only reachable stations", () => {
    const html = render(
      <RitualRibbon
        currentStation="pact"
        reachableStations={["gate", "tomb", "pact"]}
        hrefs={{
          gate: "/",
          tomb: "/tomb/acme/repo?run=run-1",
          pact: "/runs/run-1/pact",
        }}
        lockedReasons={{
          legion: "Approve the Pact first.",
          relic: "Opens at final check.",
        }}
      />
    );

    for (const label of ["Gate", "Tombstone", "Pact", "Legion", "Reliquary"]) {
      assert.ok(html.includes(label), `Expected station ${label}`);
    }

    const pactSection = html.match(
      /<li[^>]*data-station="pact"[^>]*>([\s\S]*?)<\/li>/
    );
    assert.ok(pactSection, "Expected Pact list item");
    assert.ok(
      pactSection[1].includes('aria-current="step"'),
      "Current station must carry aria-current=\"step\""
    );
    assert.ok(
      pactSection[1].includes("<a "),
      "Reachable current station should render as a link"
    );

    for (const reachable of ["gate", "tomb", "pact"]) {
      const li = html.match(
        new RegExp(`<li[^>]*data-station="${reachable}"[^>]*>([\\s\\S]*?)<\\/li>`)
      );
      assert.ok(li, `Expected ${reachable} station`);
      assert.ok(li[1].includes("<a "), `${reachable} must render as a link`);
    }

    for (const locked of ["legion", "relic"]) {
      const li = html.match(
        new RegExp(`<li[^>]*data-station="${locked}"[^>]*>([\\s\\S]*?)<\\/li>`)
      );
      assert.ok(li, `Expected ${locked} station`);
      assert.ok(
        !li[1].includes("<a "),
        `Unreachable station ${locked} must not render as a link`
      );
      assert.ok(
        li[1].includes('aria-disabled="true"'),
        `Unreachable station ${locked} must be aria-disabled="true"`
      );
    }
  });
});

describe("CryptOrnament", () => {
  it("renders every existing kind and the new candle kind as aria-hidden", () => {
    const kinds = [
      "arch-sigil",
      "tomb-arch",
      "wax-seal",
      "skeleton-skull",
      "divider",
      "corner-ticks",
      "candle",
    ] as const;

    for (const kind of kinds) {
      const html = render(<CryptOrnament kind={kind} />);
      assert.ok(
        html.includes('aria-hidden="true"'),
        `Expected aria-hidden="true" for ornament kind ${kind}`
      );
    }

    const unlitCandle = render(<CryptOrnament kind="candle" lit={false} />);
    assert.ok(unlitCandle.includes('data-lit="false"'));

    const openSeal = render(<CryptOrnament kind="wax-seal" sealed={false} />);
    assert.ok(openSeal.includes('data-sealed="false"'));
  });
});
