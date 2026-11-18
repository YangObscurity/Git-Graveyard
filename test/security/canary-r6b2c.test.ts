// R6-B2c regression test: canary tokens keep real provider shapes after the
// R6-B2 redactor narrowing, so every generated canary is still matched by the
// redactor token patterns and redacted from text.
// Requirements: 42.3, 42.6

import test from "node:test";
import assert from "node:assert/strict";

import {
  createCanaryToken,
  createDefaultCanaryTokens,
  type CanaryKind,
} from "../../lib/security/canary";
import {
  DEFAULT_REDACTION_MASK,
  SENSITIVE_PATTERNS,
  redactText,
} from "../../lib/security/redactor";

const ALL_KINDS: readonly CanaryKind[] = [
  "ksk",
  "ghp",
  "akia",
  "github_pat",
  "dckr_pat",
  "pem",
];

const PREFIXED_SHAPES: ReadonlyArray<readonly [CanaryKind, string]> = [
  ["ksk", "ksk_CANARY_"],
  ["ghp", "ghp_CANARY_"],
  ["github_pat", "github_pat_CANARY_"],
  ["dckr_pat", "dckr_pat_CANARY_"],
];

const SAMPLE_SUFFIXES: readonly string[] = [
  "TOKEN_01",
  "CI_CANARY",
  "R6_B2C_REGRESSION",
];

function isMatchedByTokenPatterns(token: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) =>
    new RegExp(pattern.source, pattern.flags).test(token)
  );
}

test("R6-B2c: every generated canary of each kind matches a redactor token pattern", () => {
  for (const kind of ALL_KINDS) {
    for (const suffix of SAMPLE_SUFFIXES) {
      const token = createCanaryToken(kind, suffix);
      assert.ok(
        isMatchedByTokenPatterns(token),
        `canary ${kind} (suffix ${suffix}) is not matched by any redactor token pattern: ${token}`
      );
    }
  }

  const defaultSet = createDefaultCanaryTokens();
  for (const token of defaultSet.allTokens) {
    assert.ok(
      isMatchedByTokenPatterns(token),
      `default canary set token is not matched by any redactor token pattern: ${token}`
    );
  }
});

test("R6-B2c: prefixed canaries keep the CANARY marker and at least 24 alphabet characters", () => {
  for (const [kind, prefix] of PREFIXED_SHAPES) {
    for (const suffix of SAMPLE_SUFFIXES) {
      const token = createCanaryToken(kind, suffix);
      assert.ok(
        token.startsWith(prefix),
        `${kind} canary must keep its prefix: ${token}`
      );
      assert.ok(
        token.includes("CANARY"),
        `${kind} canary must keep the CANARY marker: ${token}`
      );
      const tail = token.slice(prefix.length);
      assert.ok(
        tail.length >= 24,
        `${kind} canary must carry at least 24 token alphabet characters after the prefix: ${token}`
      );
      assert.match(
        tail,
        /^[A-Za-z0-9_.-]+$/,
        `${kind} canary tail must stay inside the token alphabet: ${token}`
      );
    }
  }
});

test("R6-B2c: AKIA canaries follow the AWS shape with marker and digits", () => {
  const suffixes = [...SAMPLE_SUFFIXES, "SAMPLE3"];
  for (const suffix of suffixes) {
    const token = createCanaryToken("akia", suffix);
    assert.match(
      token,
      /^AKIA[A-Z0-9]{16}$/,
      `AKIA canary must be AKIA plus exactly 16 uppercase or digit characters: ${token}`
    );
    assert.ok(
      token.includes("CANARY"),
      `AKIA canary must contain the CANARY marker: ${token}`
    );
    assert.ok(
      /[0-9]/.test(token),
      `AKIA canary must contain digits: ${token}`
    );
  }
});

test("R6-B2c: generated canaries stay unique across suffixes and kinds", () => {
  const suffixes = ["ALPHA", "BETA", "GAMMA"];
  for (const kind of ALL_KINDS) {
    const tokens = suffixes.map((suffix) => createCanaryToken(kind, suffix));
    assert.equal(
      new Set(tokens).size,
      tokens.length,
      `${kind} canaries must stay unique across suffixes`
    );
  }

  const set = createDefaultCanaryTokens("R6_B2C_UNIQUE");
  const perKind = [
    set.ksk,
    set.ghp,
    set.akia,
    set.githubPat,
    set.dckrPat,
    set.pemBlock,
  ];
  assert.equal(
    new Set(perKind).size,
    perKind.length,
    "canaries of different kinds must stay unique"
  );
});

test("R6-B2c: text containing a generated canary is redacted", () => {
  for (const kind of ALL_KINDS) {
    const token = createCanaryToken(kind, "R6_B2C_REDACT");
    const redacted = redactText(`guard-before ${token} guard-after`);
    assert.ok(
      !redacted.includes(token),
      `${kind} canary survived redaction: ${redacted}`
    );
    assert.ok(
      redacted.includes(DEFAULT_REDACTION_MASK),
      `${kind} canary was not replaced by the redaction mask: ${redacted}`
    );
  }
});

test("R6-B2c: text containing the full default canary set is redacted", () => {
  const set = createDefaultCanaryTokens("R6_B2C_REDACT_SET");
  const text = `run log: ${set.allTokens.join(" | ")}`;
  const redacted = redactText(text);
  for (const token of set.allTokens) {
    assert.ok(
      !redacted.includes(token),
      `canary token survived redaction: ${token}`
    );
  }
  assert.ok(
    redacted.includes(DEFAULT_REDACTION_MASK),
    "redacted canary text must contain the redaction mask"
  );
});
