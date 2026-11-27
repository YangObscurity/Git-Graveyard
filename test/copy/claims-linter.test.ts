import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  lintUiCopy,
  checkKiroBrandingCopy,
  isSafeClaim,
  hasNonEnglishProse,
  isKiroRoleSentence,
  isGateFooter,
} from "../../lib/copy/claims-linter";
import { KIRO_ROLE_SENTENCE, GATE_FOOTER } from "../../lib/copy/glossary";
import { GlossProvider, GlossedTerm } from "../../components/GlossedTerm";

function rules(result: { findings: readonly { rule: string }[] }): string[] {
  return result.findings.map((f) => f.rule);
}

describe("claims-linter: forbidden claims (Requirement 40.9)", () => {
  it("passes clean English copy", () => {
    const result = lintUiCopy("The run finished. 3 tasks merged.");
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  });

  it("flags X% faster", () => {
    const result = lintUiCopy("This build is 40% faster than before.");
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("percent-faster"));
    assert.equal(result.findings[0].match, "40% faster");
  });

  it("flags hours saved", () => {
    assert.ok(rules(lintUiCopy("Save 3 hours saved every week.")).includes("hours-saved"));
    assert.ok(rules(lintUiCopy("1 hour saved")).includes("hours-saved"));
  });

  it("flags production ready (space, hyphen or multi-space)", () => {
    assert.ok(rules(lintUiCopy("It is production ready.")).includes("production-ready"));
    assert.ok(rules(lintUiCopy("production-ready tool")).includes("production-ready"));
    assert.ok(rules(lintUiCopy("production   ready")).includes("production-ready"));
  });

  it("flags safety guarantees and the standalone safe claim", () => {
    assert.ok(rules(lintUiCopy("The system is safe now.")).includes("safe-guarantee"));
    assert.ok(rules(lintUiCopy("This is completely safe")).includes("safe-guarantee"));
    const standalone = lintUiCopy("Mark this safe.");
    assert.ok(rules(standalone).includes("safe-claim"));
    assert.equal(isSafeClaim("a safe choice"), true);
    assert.equal(isSafeClaim("a safer choice"), false);
  });

  it("flags a skeleton/model/agent/ai that understood", () => {
    assert.ok(rules(lintUiCopy("The skeleton understood the task.")).includes("understood"));
    assert.ok(rules(lintUiCopy("The model understood")).includes("understood"));
    assert.ok(rules(lintUiCopy("The agent understood the repo")).includes("understood"));
    assert.ok(rules(lintUiCopy("The AI understood")).includes("understood"));
  });

  it("flags auxiliary and adverbial forms before 'understood'", () => {
    const auxiliary = [
      "The Skeleton has understood the task.",
      "the agent had fully understood",
      "model has already understood",
      "The AI has now understood the repo",
    ];
    for (const copy of auxiliary) {
      const result = lintUiCopy(copy);
      assert.equal(result.ok, false, `expected failure for: ${copy}`);
      assert.ok(rules(result).includes("understood"), `expected understood rule for: ${copy}`);
    }
  });

  it("flags the Kiro product claim", () => {
    assert.ok(rules(lintUiCopy("This is a Kiro product.")).includes("kiro-product"));
  });

  it("is case-insensitive", () => {
    assert.ok(rules(lintUiCopy("PRODUCTION READY")).includes("production-ready"));
    assert.ok(rules(lintUiCopy("40% FASTER")).includes("percent-faster"));
  });

  it("reports every occurrence", () => {
    const result = lintUiCopy("2 hours saved and 3 hours saved.");
    assert.equal(result.findings.filter((f) => f.rule === "hours-saved").length, 2);
  });
});

describe("claims-linter: non-English prose", () => {
  it("flags CJK text", () => {
    const result = lintUiCopy("这是中文。");
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("non-english"));
    assert.equal(hasNonEnglishProse("这是中文"), true);
  });

  it("flags accented Latin letters", () => {
    assert.equal(hasNonEnglishProse("café"), true);
  });

  it("accepts plain ASCII English", () => {
    assert.equal(hasNonEnglishProse("The quick brown fox jumps."), false);
  });

  it("flags Hebrew and other non-ASCII Unicode letters", () => {
    assert.equal(hasNonEnglishProse("שלום"), true);
    const result = lintUiCopy("שלום");
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("non-english"));
  });

  it("allows ASCII and typographic punctuation and symbols", () => {
    assert.equal(hasNonEnglishProse("a — b – c … d"), false);
    assert.equal(hasNonEnglishProse("box ┌─┐│└┘ 42% #1"), false);
    assert.equal(hasNonEnglishProse("plain ASCII 123 !?.,;:'\"()[]{}<>/\\|@#$%^&*-_=+"), false);
  });
});

describe("claims-linter: exact branding copy (Requirements 47.5, 47.6)", () => {
  it("accepts the exact Kiro role sentence", () => {
    assert.equal(isKiroRoleSentence(KIRO_ROLE_SENTENCE), true);
    const result = checkKiroBrandingCopy(KIRO_ROLE_SENTENCE, "role");
    assert.equal(result.ok, true);
  });

  it("rejects a paraphrased role sentence", () => {
    const result = checkKiroBrandingCopy("Skeleton sessions run on Kiro.", "role");
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("role-sentence-mismatch"));
  });

  it("accepts the exact gate footer", () => {
    assert.equal(isGateFooter(GATE_FOOTER), true);
    const result = checkKiroBrandingCopy(GATE_FOOTER, "gate");
    assert.equal(result.ok, true);
  });

  it("rejects a gate footer missing the independence statement", () => {
    const result = checkKiroBrandingCopy(KIRO_ROLE_SENTENCE, "gate");
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("gate-footer-mismatch"));
  });

  it("runs only the forbidden-claims check when no context is given", () => {
    const clean = checkKiroBrandingCopy("Anything at all goes here.");
    assert.equal(clean.ok, true);
    const dirty = checkKiroBrandingCopy("It is production ready.");
    assert.equal(dirty.ok, false);
  });
});

describe("GlossedTerm: first-appearance SSR rendering (Requirement 47.4)", () => {
  it("renders an accessible gloss (abbr + title) standalone during SSR", () => {
    const html = renderToStaticMarkup(
      React.createElement(GlossedTerm, { term: "Necromancer" })
    );
    assert.match(html, /<abbr/);
    assert.match(html, /title="The Node\/TypeScript planner service/);
    assert.match(html, /data-glossed-term="Necromancer"/);
    assert.ok(html.includes("Necromancer"));
  });

  it("glosses each term only on first appearance inside a provider", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        GlossProvider,
        null,
        React.createElement(GlossedTerm, { term: "Skeleton" }),
        React.createElement("span", null, " | "),
        React.createElement(GlossedTerm, { term: "Skeleton" })
      )
    );
    // Exactly one <abbr> for the two Skeleton occurrences.
    const abbrCount = (html.match(/<abbr/g) ?? []).length;
    assert.equal(abbrCount, 1);
  });

  it("renders a plain span (no gloss) for a repeat term with showOnce", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        GlossProvider,
        null,
        React.createElement(GlossedTerm, { term: "Legion" }),
        React.createElement(GlossedTerm, { term: "Legion" })
      )
    );
    const abbrCount = (html.match(/<abbr/g) ?? []).length;
    assert.equal(abbrCount, 1);
  });

  it("supports a children override and className", () => {
    const html = renderToStaticMarkup(
      React.createElement(GlossedTerm, {
        term: "Pact",
        children: "the plan",
        className: "font-bold",
      })
    );
    assert.ok(html.includes("the plan"));
    assert.ok(html.includes("font-bold"));
    assert.ok(html.includes("Pact"));
  });

  it("renders every gothic term with its glossary definition", () => {
    const terms = [
      "Necromancer",
      "Skeleton",
      "Grimoire",
      "Pact",
      "Death_Certificate",
      "Legion",
      "Reliquary",
      "Lay_to_rest",
    ] as const;
    for (const term of terms) {
      const html = renderToStaticMarkup(React.createElement(GlossedTerm, { term }));
      assert.match(html, /<abbr/);
      assert.ok(html.includes(`data-glossed-term="${term}"`));
    }
  });

  it("keeps first-appearance gloss under React.StrictMode and renders second sibling as span", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          GlossProvider,
          null,
          React.createElement(GlossedTerm, { term: "Grimoire" }),
          React.createElement(GlossedTerm, { term: "Grimoire" })
        )
      )
    );
    const abbrCount = (html.match(/<abbr/g) ?? []).length;
    const spanCount = (html.match(/<span/g) ?? []).length;
    assert.equal(abbrCount, 1);
    assert.equal(spanCount, 1);
  });

  it("still glosses subsequent appearances when showOnce is false", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        GlossProvider,
        null,
        React.createElement(GlossedTerm, { term: "Grimoire" }),
        React.createElement(GlossedTerm, { term: "Grimoire", showOnce: false })
      )
    );
    const abbrCount = (html.match(/<abbr/g) ?? []).length;
    assert.equal(abbrCount, 2);
  });
});