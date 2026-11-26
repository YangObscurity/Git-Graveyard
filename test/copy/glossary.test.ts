import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  glossary,
  KIRO_ROLE_SENTENCE,
  GATE_FOOTER,
  formatPlainError,
} from "../../lib/copy/glossary";

describe("glossary: terms and definitions (Requirement 47.4, Task 3.3, 3.6)", () => {
  const EXPECTED_GOTHIC_TERMS = [
    "Necromancer",
    "Skeleton",
    "Grimoire",
    "Pact",
    "Death_Certificate",
    "Legion",
    "Reliquary",
    "Lay_to_rest",
  ] as const;

  it("contains exactly the eight required gothic terms", () => {
    const terms = Object.keys(glossary).sort();
    const expected = [...EXPECTED_GOTHIC_TERMS].sort();
    assert.deepEqual(terms, expected);
  });

  it("defines plain-English glosses for every gothic term", () => {
    for (const term of EXPECTED_GOTHIC_TERMS) {
      const def = glossary[term];
      assert.equal(typeof def, "string", `Expected definition for ${term} to be a string`);
      assert.ok(def.length > 0, `Expected non-empty definition for ${term}`);
    }
  });

  it("matches the canonical glossary definitions exactly", () => {
    assert.equal(
      glossary.Necromancer,
      "The Node/TypeScript planner service that owns planning, scheduling and every policy decision of a live run."
    );
    assert.equal(
      glossary.Skeleton,
      "One kiro-cli session with a role-specific custom agent, raised by the Necromancer for one role and task."
    );
    assert.equal(
      glossary.Grimoire,
      "The deterministic rule engine for rules M1 to M6 (detection, dead or alive, migration guidance, Grimoire bundle)."
    );
    assert.equal(
      glossary.Pact,
      "The plan for one repository: requirements.md, design.md and tasks.md written by the Planner and approved by the user."
    );
    assert.equal(
      glossary.Death_Certificate,
      "The stored baseline result of install, build and test on the base sha, with the Exhumer's failure classes."
    );
    assert.equal(
      glossary.Legion,
      "The set of live Skeletons in a run."
    );
    assert.equal(
      glossary.Reliquary,
      "The results page of a run."
    );
    assert.equal(
      glossary.Lay_to_rest,
      "Stopping a Skeleton; its task becomes abandoned."
    );
  });
});

describe("glossary: Kiro role and gate footer text (Requirements 47.5, 47.6, Task 3.3, 3.6)", () => {
  it("defines the exact Kiro CLI role description sentence (Requirement 47.5)", () => {
    assert.equal(KIRO_ROLE_SENTENCE, "Skeleton sessions run on Kiro CLI.");
  });

  it("defines the exact gate footer text containing Kiro role and independence statement (Requirement 47.6)", () => {
    assert.equal(
      GATE_FOOTER,
      "Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project."
    );
    assert.ok(GATE_FOOTER.startsWith(KIRO_ROLE_SENTENCE));
    assert.ok(GATE_FOOTER.endsWith("Git-Graveyard is an independent project."));
  });
});

describe("glossary: formatPlainError (Requirement 47.3, Task 3.3, 3.6)", () => {
  const KNOWN_CODES: Record<string, string> = {
    BAD_URL: "The repository URL is invalid or malformed.",
    REPO_EMPTY: "The repository default branch contains no commits.",
    REPO_NOT_FOUND: "The repository was not found or is private.",
    GITHUB_UNAVAILABLE: "GitHub services are temporarily unavailable.",
    RATE_LIMITED: "The GitHub API rate limit was exceeded.",
    TOO_LARGE: "The repository archive exceeds size limits.",
    ARCHIVE_UNSAFE: "The repository archive contains unsafe paths or links.",
    TIMEOUT: "The operation timed out.",
    LANGUAGE_UNKNOWN: "No supported programming language was detected.",
  };

  it("formats every known error code with plain words and next action", () => {
    for (const [code, desc] of Object.entries(KNOWN_CODES)) {
      const nextAction = "Please check your network and retry.";
      const formatted = formatPlainError(code, nextAction);
      assert.equal(
        formatted,
        `Error code: ${code}. What happened: ${desc} What to do next: ${nextAction}`
      );
    }
  });

  it("handles case-insensitive error codes", () => {
    const formatted = formatPlainError("bad_url", "Provide a valid GitHub URL.");
    assert.equal(
      formatted,
      "Error code: bad_url. What happened: The repository URL is invalid or malformed. What to do next: Provide a valid GitHub URL."
    );

    const formattedLower = formatPlainError("rate_limited", "Wait 60 minutes.");
    assert.equal(
      formattedLower,
      "Error code: rate_limited. What happened: The GitHub API rate limit was exceeded. What to do next: Wait 60 minutes."
    );
  });

  it("provides fallback description for unknown error codes", () => {
    const formatted = formatPlainError("UNKNOWN_FOO", "Contact support.");
    assert.equal(
      formatted,
      "Error code: UNKNOWN_FOO. What happened: An unexpected error occurred. What to do next: Contact support."
    );
  });

  it("preserves exact nextAction text provided by caller", () => {
    const customAction = "Run git status and inspect the working directory.";
    const formatted = formatPlainError("TIMEOUT", customAction);
    assert.ok(formatted.includes(`What to do next: ${customAction}`));
  });
});
