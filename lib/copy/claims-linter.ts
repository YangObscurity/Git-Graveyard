/**
 * English-only copy rules and the forbidden-claims linter (R4-13, Requirement 40.9,
 * Requirements 47.1–47.6).
 *
 * The UI must never claim "X% faster", "hours saved", "production ready", "safe",
 * that a Skeleton "understood" something, or that the app is a Kiro product. It
 * must be English-only prose, and it must carry the exact Kiro role sentence and
 * gate footer. These helpers are pure and total: they never throw and read only
 * the string they are given.
 */
import { GATE_FOOTER, KIRO_ROLE_SENTENCE } from "./glossary";

/** One detected problem in a piece of UI copy. */
export interface CopyLintFinding {
  /** Stable identifier for the rule that fired. */
  readonly rule: string;
  /** The offending substring, when the rule matched a span. */
  readonly match?: string;
  /** A plain-English explanation of the problem. */
  readonly message: string;
}

/** The result of linting one string. */
export interface CopyLintResult {
  readonly ok: boolean;
  readonly findings: readonly CopyLintFinding[];
}

/** A forbidden claim pattern and the rule name reported when it matches. */
interface ForbiddenPattern {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly message: string;
}

/**
 * Forbidden claims, case-insensitive (Requirement 40.9). Each pattern is global so
 * every occurrence is reported.
 */
export const FORBIDDEN_CLAIM_PATTERNS: readonly ForbiddenPattern[] = [
  {
    rule: "percent-faster",
    pattern: /\b\d+%\s*faster\b/gi,
    message: 'The UI must not claim "X% faster".',
  },
  {
    rule: "hours-saved",
    pattern: /\bhours?\s+saved\b/gi,
    message: 'The UI must not claim "hours saved".',
  },
  {
    rule: "production-ready",
    pattern: /\bproduction[\s-]+ready\b/gi,
    message: 'The UI must not claim "production ready".',
  },
  {
    rule: "safe-guarantee",
    pattern: /\b(?:is|now|guaranteed|completely)\s+safe\b/gi,
    message: 'The UI must not guarantee that something is "safe".',
  },
  {
    rule: "understood",
    pattern:
      /\b(?:skeleton|model|agent|ai)(?:\s+(?:has|have|had|is|are|was|were|been|being|already|fully|just|now|then|really|actually|truly|simply))*\s+understood\b/gi,
    message: 'The UI must not claim a Skeleton "understood" something.',
  },
  {
    rule: "kiro-product",
    pattern: /\bkiro\s+product\b/gi,
    message: "The UI must not claim the app is a Kiro product.",
  },
];

/** Standalone forbidden "safe" claim: the bare word "safe" as a guarantee. */
const SAFE_CLAIM_PATTERN = /\bsafe\b/gi;

/**
 * True when the text contains a standalone forbidden "safe" claim. This is the
 * helper the spec calls out alongside the compound guarantee pattern.
 */
export function isSafeClaim(text: string): boolean {
  SAFE_CLAIM_PATTERN.lastIndex = 0;
  return SAFE_CLAIM_PATTERN.test(text);
}

/** Matches any Unicode letter (used to detect non-English prose). */
const UNICODE_LETTER = /\p{L}/u;

function collectMatches(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  const global = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
  global.lastIndex = 0;
  let result: RegExpExecArray | null;
  while ((result = global.exec(text)) !== null) {
    matches.push(result[0]);
    if (result.index === global.lastIndex) {
      global.lastIndex += 1;
    }
  }
  return matches;
}

/**
 * True when the text contains any non-ASCII Unicode letter (non-English prose).
 * ASCII English text, numbers and ASCII/typographic punctuation are allowed.
 */
export function hasNonEnglishProse(text: string): boolean {
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x7f && UNICODE_LETTER.test(ch)) {
      return true;
    }
  }
  return false;
}

/**
 * Lint a piece of UI copy for forbidden claims and non-English prose. Returns
 * `ok: true` with no findings when the copy is clean.
 */
export function lintUiCopy(text: string): CopyLintResult {
  const findings: CopyLintFinding[] = [];
  if (typeof text !== "string") {
    return {
      ok: false,
      findings: [{ rule: "not-a-string", message: "Copy must be a string." }],
    };
  }

  for (const { rule, pattern, message } of FORBIDDEN_CLAIM_PATTERNS) {
    for (const match of collectMatches(text, pattern)) {
      findings.push({ rule, match, message });
    }
  }

  for (const match of collectMatches(text, SAFE_CLAIM_PATTERN)) {
    findings.push({
      rule: "safe-claim",
      match,
      message: 'The UI must not claim something is "safe".',
    });
  }

  if (hasNonEnglishProse(text)) {
    findings.push({
      rule: "non-english",
      message: "User-facing copy must be English-only prose.",
    });
  }

  return { ok: findings.length === 0, findings };
}

/** The result of checking branding copy against the exact required sentences. */
export interface BrandingCheckResult {
  readonly ok: boolean;
  readonly findings: readonly CopyLintFinding[];
}

/**
 * Check branding copy: it must pass the forbidden-claims linter and, when it is
 * the role sentence or the gate footer, match the exact required text.
 *
 * `context` is "role" for the Kiro role sentence and "gate" for the gate footer;
 * when omitted only the forbidden-claims check runs.
 */
export function checkKiroBrandingCopy(
  text: string,
  context?: "role" | "gate"
): BrandingCheckResult {
  const lint = lintUiCopy(text);
  const findings: CopyLintFinding[] = [...lint.findings];

  if (context === "role" && text !== KIRO_ROLE_SENTENCE) {
    findings.push({
      rule: "role-sentence-mismatch",
      message: `The Kiro role copy must be exactly: "${KIRO_ROLE_SENTENCE}"`,
    });
  }
  if (context === "gate" && text !== GATE_FOOTER) {
    findings.push({
      rule: "gate-footer-mismatch",
      message: `The gate footer must be exactly: "${GATE_FOOTER}"`,
    });
  }

  return { ok: findings.length === 0, findings };
}

/** True when the text is exactly the required Kiro role sentence. */
export function isKiroRoleSentence(text: string): boolean {
  return text === KIRO_ROLE_SENTENCE;
}

/** True when the text is exactly the required gate footer. */
export function isGateFooter(text: string): boolean {
  return text === GATE_FOOTER;
}