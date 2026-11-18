// Task 13.4: Warden review pure function and verdict builder
// Requirements: 14.7, 24.5, 24.6, 24.7, 24.8, 24.14, 24.15, 24.16, 25.6, 25.8

import * as crypto from "node:crypto";
import { candidateSha256FromDiff } from "../merge/candidate-hash";
import type {
  WardenVerdictStatus,
  ReasonWithRefs,
  WardenReason,
  TestCountBaseline,
  ReviewCheckResult,
  ReviewFindings,
  WardenVerdictRecord,
  WardenEnvironment,
  BuilderEnvironment,
  WardenIsolationResult,
} from "./types";

export const EVIDENCE_REF_PREFIXES = ["cmd:", "file:", "gh:", "ev:"] as const;

export const EVIDENCE_REF_PATTERNS = Object.assign(
  [
    /^cmd:\S+$/,
    /^file:\S+$/,
    /^gh:\S+$/,
    /^ev:\S+$/,
  ] as const,
  {
    cmd: /^cmd:\S+$/,
    file: /^file:\S+$/,
    gh: /^gh:\S+$/,
    ev: /^ev:\S+$/,
  }
);

export const WARDEN_ALLOWED_TOOLS = new Set([
  "read",
  "sandbox_exec",
  "sandbox_log",
  "warden_verdict",
]);

export const FORBIDDEN_WARDEN_TOOLS = new Set([
  "write",
  "shell",
  "web",
  "web_fetch",
  "web_search",
  "subagent",
  "propose_task",
  "report_task_result",
  "ask",
  "report_blocker",
]);

/**
 * Computes deterministic SHA-256 hex digest for candidate diff text.
 * Must not hash the commit sha string any more.
 */
export function computeCandidateSha256(diffText: string): string {
  if (!diffText || typeof diffText !== "string") {
    return "";
  }
  // Commit SHA strings must not be hashed
  if (/^[0-9a-f]{40}$/i.test(diffText.trim())) {
    return "";
  }
  return candidateSha256FromDiff(diffText);
}

/**
 * Validates whether a reference string matches allowed evidence ref formats (cmd:, file:, gh:, ev:).
 * Only accepts valid evidence ref schemes 'cmd:', 'file:', 'gh:', and 'ev:' with non-empty bodies.
 */
export function isValidEvidenceRef(ref: string): boolean {
  if (!ref || typeof ref !== "string") {
    return false;
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return false;
  }
  return (
    EVIDENCE_REF_PATTERNS.cmd.test(trimmed) ||
    EVIDENCE_REF_PATTERNS.file.test(trimmed) ||
    EVIDENCE_REF_PATTERNS.gh.test(trimmed) ||
    EVIDENCE_REF_PATTERNS.ev.test(trimmed)
  );
}

/**
 * Helper to inspect whether any valid evidence reference matching isValidEvidenceRef
 * is present in an input (evidenceRefs, refs, reasons, findings, or check objects).
 */
export function hasAnyValidEvidenceRef(input: unknown): boolean {
  if (!input) {
    return false;
  }
  if (typeof input === "string") {
    if (isValidEvidenceRef(input)) {
      return true;
    }
    return extractEvidenceRefs(input).some(isValidEvidenceRef);
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (hasAnyValidEvidenceRef(item)) {
        return true;
      }
    }
    return false;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;

    if (typeof obj.ref === "string" && isValidEvidenceRef(obj.ref)) {
      return true;
    }
    if (typeof obj.evidenceRef === "string" && isValidEvidenceRef(obj.evidenceRef)) {
      return true;
    }
    if (typeof obj.logRef === "string") {
      const candidate = `cmd:${obj.logRef.trim()}`;
      if (isValidEvidenceRef(candidate)) {
        return true;
      }
    }

    if (obj.evidenceRefs !== undefined && hasAnyValidEvidenceRef(obj.evidenceRefs)) {
      return true;
    }
    if (obj.refs !== undefined && hasAnyValidEvidenceRef(obj.refs)) {
      return true;
    }
    if (obj.reasons !== undefined && hasAnyValidEvidenceRef(obj.reasons)) {
      return true;
    }

    if (typeof obj.text === "string" && extractEvidenceRefs(obj.text).some(isValidEvidenceRef)) {
      return true;
    }
    if (typeof obj.message === "string" && extractEvidenceRefs(obj.message).some(isValidEvidenceRef)) {
      return true;
    }

    if (obj.findings !== undefined && obj.findings !== input && hasAnyValidEvidenceRef(obj.findings)) {
      return true;
    }

    for (const checkKey of [
      "install",
      "build",
      "accept",
      "taskAccept",
      "acceptCommand",
      "tests",
      "test",
      "noTestWeakening",
    ]) {
      const checkVal = obj[checkKey];
      if (checkVal && typeof checkVal === "object") {
        const c = checkVal as Record<string, unknown>;
        if (typeof c.ref === "string" && isValidEvidenceRef(c.ref)) {
          return true;
        }
        if (typeof c.logRef === "string") {
          const candidate = `cmd:${c.logRef.trim()}`;
          if (isValidEvidenceRef(candidate)) {
            return true;
          }
        }
        if (Array.isArray(c.refs) && c.refs.some((r) => typeof r === "string" && isValidEvidenceRef(r))) {
          return true;
        }
      }
    }

    if (obj.checks && typeof obj.checks === "object" && obj.checks !== input) {
      const checksObj = obj.checks as Record<string, unknown>;
      for (const key of Object.keys(checksObj)) {
        const checkVal = checksObj[key];
        if (checkVal && typeof checkVal === "object") {
          const c = checkVal as Record<string, unknown>;
          if (typeof c.ref === "string" && isValidEvidenceRef(c.ref)) {
            return true;
          }
          if (typeof c.logRef === "string") {
            const candidate = `cmd:${c.logRef.trim()}`;
            if (isValidEvidenceRef(candidate)) {
              return true;
            }
          }
        }
      }
    }

    if (Array.isArray(obj.failures)) {
      for (const f of obj.failures) {
        if (hasAnyValidEvidenceRef(f)) {
          return true;
        }
      }
    }

    if (Array.isArray(obj.errors)) {
      for (const e of obj.errors) {
        if (hasAnyValidEvidenceRef(e)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extracts evidence refs (cmd:, file:, gh:, ev:) from text.
 */
export function extractEvidenceRefs(text: string): string[] {
  if (!text || typeof text !== "string") {
    return [];
  }
  const matches = text.match(/\b(?:cmd|file|gh|ev):[^\s,;)\]}]+/gi);
  if (!matches) {
    return [];
  }
  return Array.from(new Set(matches.map((m) => m.trim())));
}

/**
 * Normalizes a reason item into a structured ReasonWithRefs.
 */
export function normalizeReason(raw: WardenReason | unknown): ReasonWithRefs {
  if (!raw) {
    return { text: "Unknown reason", refs: [] };
  }

  if (typeof raw === "string") {
    const refs = extractEvidenceRefs(raw);
    return { text: raw.trim(), refs };
  }

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const text =
      typeof obj.text === "string"
        ? obj.text.trim()
        : typeof obj.message === "string"
          ? obj.message.trim()
          : typeof obj.reason === "string"
            ? obj.reason.trim()
            : "Unknown reason";

    const explicitRefs: string[] = [];
    if (Array.isArray(obj.refs)) {
      for (const r of obj.refs) {
        if (typeof r === "string" && r.trim().length > 0) {
          explicitRefs.push(r.trim());
        }
      }
    } else if (typeof obj.ref === "string" && obj.ref.trim().length > 0) {
      explicitRefs.push(obj.ref.trim());
    }

    const textRefs = extractEvidenceRefs(text);
    const combinedRefs = Array.from(new Set([...explicitRefs, ...textRefs]));

    return {
      text,
      refs: combinedRefs,
    };
  }

  return { text: String(raw), refs: [] };
}

/**
 * Compares test baselines before and after candidate changes.
 * Requirement 24.6: check no_test_weakening by comparing test files and counts.
 */
export function checkNoTestWeakening(
  before?: TestCountBaseline,
  after?: TestCountBaseline
): { ok: boolean; reason?: string; ref?: string; deletedFiles?: string[] } {
  if (!before && !after) {
    return { ok: true };
  }

  if (before && after) {
    // Check deleted test files
    if (Array.isArray(before.testFiles) && Array.isArray(after.testFiles)) {
      const afterSet = new Set(after.testFiles);
      const deletedFiles = before.testFiles.filter((f) => !afterSet.has(f));
      if (deletedFiles.length > 0) {
        return {
          ok: false,
          deletedFiles,
          reason: `Test weakening detected: test file(s) removed (${deletedFiles.join(", ")})`,
          ref: `file:${deletedFiles[0]}`,
        };
      }
    }

    // Check test counts
    if (typeof before.total === "number" && typeof after.total === "number") {
      if (after.total < before.total) {
        return {
          ok: false,
          reason: `Test weakening detected: total tests decreased from ${before.total} to ${after.total}`,
          ref: "cmd:test-weakening",
        };
      }
    }

    if (typeof before.passed === "number" && typeof after.passed === "number") {
      if (after.passed < before.passed) {
        return {
          ok: false,
          reason: `Test weakening detected: passed tests decreased from ${before.passed} to ${after.passed}`,
          ref: "cmd:test-weakening",
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Helper to inspect if a check result passes.
 * Requirement 24.5 / Audit H-8: A check passes only when its value is the boolean true,
 * or an object whose ok is the boolean true and that has none of these failure markers:
 * passed false, a nonzero numeric exitCode, status failed or error.
 */
export function isCheckPassing(val: unknown): boolean {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (obj.ok !== true) {
      return false;
    }
    if (obj.passed === false) {
      return false;
    }
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) {
      return false;
    }
    if (obj.status === "failed" || obj.status === "error") {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Helper to inspect if a check result indicates failure.
 * A check fails when its value is boolean false, or an object with boolean ok
 * that has ok === false or any failure marker: passed false, nonzero numeric exitCode,
 * status failed or error.
 */
export function isCheckFailed(val: unknown): boolean {
  if (val === false) {
    return true;
  }
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (typeof obj.ok === "boolean") {
      if (obj.ok === false || obj.passed === false) {
        return true;
      }
      if (typeof obj.exitCode === "number" && obj.exitCode !== 0) {
        return true;
      }
      if (obj.status === "failed" || obj.status === "error") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Helper to inspect if a check result is missing.
 * Requirement 24.5 / Audit H-8: Every other value is a missing check:
 * undefined, null, the empty string, zero, any other string or number, arrays,
 * and objects without a boolean ok.
 */
export function isCheckMissing(val: unknown): boolean {
  return !isCheckPassing(val) && !isCheckFailed(val);
}

/**
 * Helper to extract log reference from a check result.
 */
function getCheckRef(val: ReviewCheckResult | boolean | undefined, defaultPrefix = "cmd"): string | undefined {
  if (val && typeof val === "object") {
    if (typeof val.ref === "string" && val.ref.trim().length > 0) {
      return val.ref.trim();
    }
    if (typeof val.logRef === "string" && val.logRef.trim().length > 0) {
      return `${defaultPrefix}:${val.logRef.trim()}`;
    }
  }
  return undefined;
}

/**
 * Pure function that builds the Warden verdict record from the candidate SHA and review findings.
 * Requirements: 24.5, 24.6, 24.7, 24.8, 24.16, 25.6, 25.8.
 */
export function buildVerdictRecord(
  candidateShaOrOptions:
    | string
    | (ReviewFindings & {
        candidateSha?: string;
        candidateSha256?: string;
        target?: string;
        [key: string]: unknown;
      }),
  findingsArg?: ReviewFindings,
  optionsArg?: Record<string, unknown>
): WardenVerdictRecord {
  let candidateSha = "";
  let findings: ReviewFindings = {};
  let options: Record<string, unknown> = {};

  if (typeof candidateShaOrOptions === "string") {
    candidateSha = candidateShaOrOptions.trim();
    findings = findingsArg ?? {};
    options = optionsArg ?? {};
  } else if (candidateShaOrOptions && typeof candidateShaOrOptions === "object") {
    findings = candidateShaOrOptions;
    candidateSha = (candidateShaOrOptions.candidateSha ?? "").trim();
    options = (findingsArg as Record<string, unknown>) ?? {};
  }

  const explicitSha256 =
    findings.candidateSha256 ??
    (typeof options.candidateSha256 === "string" ? options.candidateSha256 : undefined);

  const candidateDiff =
    (typeof findings.diff === "string" ? findings.diff : undefined) ??
    (typeof findings.diffText === "string" ? findings.diffText : undefined) ??
    (typeof options.diff === "string" ? options.diff : undefined) ??
    (typeof options.diffText === "string" ? options.diffText : undefined) ??
    (candidateShaOrOptions && typeof candidateShaOrOptions === "object"
      ? (typeof (candidateShaOrOptions as Record<string, unknown>).diff === "string"
          ? ((candidateShaOrOptions as Record<string, unknown>).diff as string)
          : typeof (candidateShaOrOptions as Record<string, unknown>).diffText === "string"
            ? ((candidateShaOrOptions as Record<string, unknown>).diffText as string)
            : undefined)
      : undefined);

  let candidateSha256 = "";
  if (candidateDiff) {
    candidateSha256 = candidateSha256FromDiff(candidateDiff);
  } else if (explicitSha256) {
    candidateSha256 = explicitSha256.trim().toLowerCase();
  }

  const tree =
    (typeof findings.tree === "string" && findings.tree.trim()
      ? findings.tree.trim()
      : undefined) ??
    (typeof options.tree === "string" && options.tree.trim()
      ? options.tree.trim()
      : undefined) ??
    (candidateShaOrOptions && typeof candidateShaOrOptions === "object"
      ? (typeof (candidateShaOrOptions as Record<string, unknown>).tree === "string" &&
        (candidateShaOrOptions as Record<string, unknown>).tree
          ? ((candidateShaOrOptions as Record<string, unknown>).tree as string).trim()
          : undefined)
      : undefined);

  const target =
    findings.target ??
    findings.taskId ??
    (typeof options.target === "string" ? options.target : undefined) ??
    candidateSha;

  const taskId = findings.taskId ?? findings.target;

  // Evaluate no_test_weakening if before/after test baselines are provided
  let testWeakeningResult: { ok: boolean; reason?: string; ref?: string } = {
    ok: true,
  };
  if (findings.testBaselineBefore || findings.testBaselineAfter) {
    testWeakeningResult = checkNoTestWeakening(
      findings.testBaselineBefore,
      findings.testBaselineAfter
    );
  } else if (findings.noTestWeakening !== undefined) {
    if (findings.noTestWeakening === false) {
      testWeakeningResult = {
        ok: false,
        reason: "Test weakening detected",
        ref: "cmd:test-weakening",
      };
    } else if (typeof findings.noTestWeakening === "object") {
      const res = findings.noTestWeakening;
      if (res.ok === false || res.passed === false) {
        testWeakeningResult = {
          ok: false,
          reason: res.reason ?? res.error ?? "Test weakening detected",
          ref: res.ref ?? (res.logRef ? `cmd:${res.logRef}` : "cmd:test-weakening"),
        };
      }
    }
  }

  // Detect failures across all individual checks
  const failureReasons: ReasonWithRefs[] = [];

  // Check for empty findings
  const hasAnyChecks =
    findings.install !== undefined ||
    findings.build !== undefined ||
    findings.tests !== undefined ||
    findings.test !== undefined ||
    findings.accept !== undefined ||
    findings.taskAccept !== undefined ||
    findings.acceptCommand !== undefined ||
    findings.noTestWeakening !== undefined ||
    findings.testBaselineBefore !== undefined ||
    findings.testBaselineAfter !== undefined ||
    (Array.isArray(findings.failures) && findings.failures.length > 0) ||
    (Array.isArray(findings.errors) && findings.errors.length > 0);

  if (!hasAnyChecks) {
    failureReasons.push({
      text: "Empty findings: Warden review requires explicit checks (Requirement 24.5)",
      refs: ["cmd:verify"],
    });
  }

  // Missing install check means reject
  if (isCheckMissing(findings.install)) {
    failureReasons.push({
      text: "Missing install check in auditbox environment (Requirement 24.5)",
      refs: ["cmd:install"],
    });
  } else if (isCheckFailed(findings.install)) {
    const ref = getCheckRef(findings.install) ?? "cmd:install";
    failureReasons.push({
      text: "Installation failed in auditbox environment",
      refs: [ref],
    });
  }

  // Missing build check means reject
  if (isCheckMissing(findings.build)) {
    failureReasons.push({
      text: "Missing build check in auditbox environment (Requirement 24.5)",
      refs: ["cmd:build"],
    });
  } else if (isCheckFailed(findings.build)) {
    const ref = getCheckRef(findings.build) ?? "cmd:build";
    failureReasons.push({
      text: "Build failed in auditbox environment",
      refs: [ref],
    });
  }

  const acceptCheck =
    findings.accept ?? findings.taskAccept ?? findings.acceptCommand;
  if (isCheckMissing(acceptCheck)) {
    failureReasons.push({
      text: "Missing accept check in auditbox environment (Requirement 24.5)",
      refs: [getCheckRef(acceptCheck) ?? "cmd:accept"],
    });
  } else if (isCheckFailed(acceptCheck)) {
    const ref = getCheckRef(acceptCheck) ?? "cmd:accept";
    failureReasons.push({
      text: "Task acceptance command failed",
      refs: [ref],
    });
  }

  // Missing tests check means reject
  const testsCheck = findings.tests ?? findings.test;
  if (isCheckMissing(testsCheck)) {
    failureReasons.push({
      text: "Missing tests check in auditbox environment (Requirement 24.5)",
      refs: ["cmd:tests"],
    });
  } else if (isCheckFailed(testsCheck)) {
    const ref = getCheckRef(testsCheck) ?? "cmd:tests";
    failureReasons.push({
      text: "Repository tests failed in auditbox",
      refs: [ref],
    });
  }

  if (!testWeakeningResult.ok) {
    failureReasons.push({
      text: testWeakeningResult.reason ?? "Test weakening detected",
      refs: testWeakeningResult.ref ? [testWeakeningResult.ref] : ["cmd:test-weakening"],
    });
  }

  if (Array.isArray(findings.failures)) {
    for (const f of findings.failures) {
      if (f) {
        const text = f.text ?? f.message ?? "Candidate test or verification failure";
        const refs = f.ref ? [f.ref] : extractEvidenceRefs(text);
        failureReasons.push({ text, refs });
      }
    }
  }

  if (Array.isArray(findings.errors)) {
    for (const err of findings.errors) {
      if (err) {
        failureReasons.push(normalizeReason(err));
      }
    }
  }

  // A check object without a boolean ok is a missing check and rejects
  const checkEntries: [string, unknown][] = [
    ["install", findings.install],
    ["build", findings.build],
    ["accept", acceptCheck],
    ["tests", testsCheck],
  ];
  for (const [name, checkVal] of checkEntries) {
    if (
      checkVal !== undefined &&
      checkVal !== null &&
      typeof checkVal === "object" &&
      typeof (checkVal as Record<string, unknown>).ok !== "boolean"
    ) {
      if (!failureReasons.some((r) => r.text.includes(name))) {
        failureReasons.push({
          text: `Missing ${name} check: check object lacks boolean ok (Requirement 24.5)`,
          refs: [getCheckRef(checkVal as ReviewCheckResult) ?? `cmd:${name}`],
        });
      }
    }
  }

  // Fail closed: findings.ok false always rejects, whatever the reasons contain
  const isOkFalse =
    findings.ok === false ||
    findings.passed === false ||
    options.ok === false ||
    options.passed === false;

  // findings.ok false with empty reasons is a rejection with a reason
  if (isOkFalse) {
    if (
      (!findings.reasons || findings.reasons.length === 0) &&
      failureReasons.length === 0
    ) {
      if (
        !failureReasons.some((r) =>
          r.text.includes("Candidate review failed verification checks")
        )
      ) {
        failureReasons.push({
          text: "Candidate review failed verification checks",
          refs: ["cmd:verify"],
        });
      }
    }
  }

  // Determine final verdict: "approve" or "reject"
  let verdict: WardenVerdictStatus;
  const rawVerdict = (findings.verdict ?? findings.status ?? "").toLowerCase().trim();

  // Fail closed: An explicit approve cannot override a failed check or findings.ok === false
  if (isOkFalse) {
    verdict = "reject";
  } else if (failureReasons.length > 0) {
    verdict = "reject";
  } else if (rawVerdict === "reject") {
    verdict = "reject";
  } else if (rawVerdict === "approve" || rawVerdict === "") {
    verdict = "approve";
  } else {
    verdict = "reject";
  }

  // Assemble reasons
  const combinedReasons: ReasonWithRefs[] = [];

  if (Array.isArray(findings.reasons) && findings.reasons.length > 0) {
    for (const r of findings.reasons) {
      combinedReasons.push(normalizeReason(r));
    }
    if (verdict === "reject" && failureReasons.length > 0) {
      for (const fr of failureReasons) {
        if (!combinedReasons.some((cr) => cr.text === fr.text)) {
          combinedReasons.push(fr);
        }
      }
    }
  } else if (failureReasons.length > 0) {
    combinedReasons.push(...failureReasons);
  } else {
    if (verdict === "approve") {
      combinedReasons.push({
        text: "Warden review passed: install, build, accept command, and repository tests succeeded with no test weakening",
        refs: ["cmd:all-checks-passed"],
      });
    } else {
      combinedReasons.push({
        text: "Warden review rejected candidate",
        refs: [],
      });
    }
  }

  // Aggregate all unique refs
  const allRefsSet = new Set<string>();
  if (Array.isArray(findings.refs)) {
    for (const r of findings.refs) {
      if (typeof r === "string" && r.trim().length > 0) {
        allRefsSet.add(r.trim());
      }
    }
  }
  for (const r of combinedReasons) {
    for (const ref of r.refs) {
      if (typeof ref === "string" && ref.trim().length > 0) {
        allRefsSet.add(ref.trim());
      }
    }
  }
  const allRefs = Array.from(allRefsSet);

  // Requirement N-A15: Mandatory evidence refs for approve verdicts
  // In buildVerdictRecord, if effectiveVerdict === 'approve' and neither evidenceRefs
  // nor reasons nor findings contain at least one valid evidence reference matching
  // isValidEvidenceRef, downgrade effectiveVerdict to 'reject' and append an explicit reason.
  let effectiveVerdict: WardenVerdictStatus = verdict;
  if (effectiveVerdict === "approve") {
    const hasEvidenceRef =
      hasAnyValidEvidenceRef(findings.evidenceRefs) ||
      hasAnyValidEvidenceRef(options.evidenceRefs) ||
      hasAnyValidEvidenceRef(findings.refs) ||
      hasAnyValidEvidenceRef(options.refs) ||
      hasAnyValidEvidenceRef(combinedReasons) ||
      hasAnyValidEvidenceRef(findings.reasons) ||
      hasAnyValidEvidenceRef(findings);

    if (!hasEvidenceRef) {
      effectiveVerdict = "reject";
      verdict = "reject";
      combinedReasons.push({
        text: "Approve verdict requires at least one valid evidence reference (cmd:, file:, gh:, ev:)",
        refs: [],
      });
    }
  }

  const atLeastOneReasonHasRef = combinedReasons.some((r) =>
    r.refs.some((ref) => isValidEvidenceRef(ref))
  );
  const allReasonsHaveRefs =
    combinedReasons.length > 0 &&
    combinedReasons.every((r) => r.refs.some((ref) => isValidEvidenceRef(ref)));

  // Requirement 24.7 & 24.16: If every reason of a reject verdict lacks a ref, requires rerun
  const requiresRerun = verdict === "reject" && !atLeastOneReasonHasRef;

  // Missing checks never default to ok true
  const checks: Record<string, unknown> = {
    install:
      findings.install !== undefined && findings.install !== null
        ? typeof findings.install === "boolean"
          ? { ok: false, missing: true }
          : typeof findings.install.ok === "boolean"
            ? findings.install
            : { ok: false, missing: true }
        : { ok: false, missing: true },
    build:
      findings.build !== undefined && findings.build !== null
        ? typeof findings.build === "boolean"
          ? { ok: false, missing: true }
          : typeof findings.build.ok === "boolean"
            ? findings.build
            : { ok: false, missing: true }
        : { ok: false, missing: true },
    accept:
      acceptCheck !== undefined && acceptCheck !== null
        ? typeof acceptCheck === "boolean"
          ? { ok: false, missing: true }
          : typeof acceptCheck.ok === "boolean"
            ? acceptCheck
            : { ok: false, missing: true }
        : { ok: false, omitted: true },
    tests:
      testsCheck !== undefined && testsCheck !== null
        ? typeof testsCheck === "boolean"
          ? { ok: false, missing: true }
          : typeof testsCheck.ok === "boolean"
            ? testsCheck
            : { ok: false, missing: true }
        : { ok: false, missing: true },
    noTestWeakening: testWeakeningResult.ok,
  };

  const ts = typeof options.ts === "number" ? options.ts : Date.now();

  return {
    verdict,
    status: verdict,
    ok: verdict === "approve",
    approved: verdict === "approve",
    target,
    taskId,
    candidateSha,
    candidateSha256,
    diff: candidateDiff,
    diffText: candidateDiff,
    tree,
    reasons: combinedReasons,
    refs: allRefs,
    noTestWeakening: testWeakeningResult.ok,
    checks,
    ts,
    allReasonsHaveRefs,
    atLeastOneReasonHasRef,
    requiresRerun,
  };
}

export const buildWardenVerdict = buildVerdictRecord;
export const createWardenVerdict = buildVerdictRecord;
export const createVerdictRecord = buildVerdictRecord;

/**
 * Validates a Warden verdict record against Requirements 24.7 and 24.16.
 */
export function validateWardenVerdict(verdict: WardenVerdictRecord | unknown): {
  valid: boolean;
  verdict?: WardenVerdictStatus;
  reasons: string[];
  allLackRefs: boolean;
  requiresRerun: boolean;
} {
  const reasons: string[] = [];
  if (!verdict || typeof verdict !== "object") {
    return {
      valid: false,
      reasons: ["Verdict is not an object"],
      allLackRefs: true,
      requiresRerun: true,
    };
  }

  const v = verdict as Record<string, unknown>;
  const status = String(v.verdict ?? v.status ?? "").toLowerCase();

  if (status !== "approve" && status !== "reject") {
    reasons.push("Verdict status must be either 'approve' or 'reject'");
  }

  const candidateSha256 = String(v.candidateSha256 ?? "").trim();
  if (!candidateSha256) {
    reasons.push("candidateSha256 must be a non-empty string");
  }

  const verdictReasons = Array.isArray(v.reasons) ? v.reasons : [];
  if (verdictReasons.length === 0) {
    reasons.push("Verdict must include reasons array");
  }

  const atLeastOneRef = hasAnyValidEvidenceRef(v);
  const allLackRefs = !atLeastOneRef;
  const requiresRerun = status === "reject" && allLackRefs;

  if (requiresRerun) {
    reasons.push(
      "Reject verdict has no evidence refs across all reasons; requires rerun with evidence (Requirement 24.7)"
    );
  }

  // Requirement N-A15: Mandatory evidence refs for approve verdicts
  if (status === "approve" && allLackRefs) {
    reasons.push(
      "Approve verdict requires at least one valid evidence reference (cmd:, file:, gh:, ev:)"
    );
  }

  return {
    valid: reasons.length === 0,
    verdict: status === "approve" ? "approve" : status === "reject" ? "reject" : undefined,
    reasons,
    allLackRefs,
    requiresRerun,
  };
}

/**
 * Validates that Warden isolation guarantees are strictly maintained.
 * Requirements: 14.7, 24.14, 24.15 (Property 13: Warden isolation).
 */
export function checkWardenIsolation(
  wardenEnv: WardenEnvironment,
  builderEnvs: BuilderEnvironment | readonly BuilderEnvironment[] | BuilderEnvironment[]
): WardenIsolationResult {
  const violations: string[] = [];
  const builders: BuilderEnvironment[] = Array.isArray(builderEnvs)
    ? [...builderEnvs]
    : [builderEnvs as BuilderEnvironment];

  // 1. Tool boundaries: Warden must have zero write tools (Requirement 14.7)
  const wardenTools = new Set(wardenEnv.tools ?? []);
  for (const forbidden of FORBIDDEN_WARDEN_TOOLS) {
    if (wardenTools.has(forbidden)) {
      violations.push(
        `Warden has forbidden tool '${forbidden}'; zero write tools permitted (Requirement 14.7)`
      );
    }
  }
  for (const tool of wardenTools) {
    if (!WARDEN_ALLOWED_TOOLS.has(tool)) {
      violations.push(
        `Warden has unexpected tool '${tool}'; only read, sandbox_exec, sandbox_log, warden_verdict allowed (Requirement 14.7)`
      );
    }
  }

  // 2. Checkout directory: Warden checkout must be under warden/
  const wardenCheckout = (wardenEnv.checkoutDir ?? "").replace(/\\/g, "/");
  if (!wardenCheckout.includes("warden") && !wardenCheckout.endsWith("/warden")) {
    violations.push(
      `Warden checkout path '${wardenCheckout}' is not isolated under warden/ (Requirement 24.14)`
    );
  }

  // 3. Box type: Warden must use auditbox
  if (wardenEnv.boxType && wardenEnv.boxType !== "auditbox") {
    violations.push(
      `Warden container box type '${wardenEnv.boxType}' is not auditbox (Requirement 24.14)`
    );
  }

  // 4. Disjointness checks against every Builder (Requirements 24.14, 24.15)
  for (const builder of builders) {
    const bRole = builder.role || "builder";

    if (wardenEnv.sessionId && builder.sessionId && wardenEnv.sessionId === builder.sessionId) {
      violations.push(
        `Warden shares sessionId '${wardenEnv.sessionId}' with builder (${bRole}) (Requirement 24.14)`
      );
    }

    const wardenPid = wardenEnv.processId ?? wardenEnv.pid;
    const builderPid = builder.processId ?? builder.pid;
    if (wardenPid && builderPid && wardenPid === builderPid) {
      violations.push(
        `Warden shares process ID '${wardenPid}' with builder (${bRole}) (Requirement 24.14)`
      );
    }

    if (wardenEnv.kiroHome && builder.kiroHome && wardenEnv.kiroHome === builder.kiroHome) {
      violations.push(
        `Warden shares KIRO_HOME '${wardenEnv.kiroHome}' with builder (${bRole}) (Requirement 24.14)`
      );
    }

    const builderCheckout = (builder.checkoutDir ?? builder.worktreeDir ?? "").replace(/\\/g, "/");
    if (wardenCheckout && builderCheckout && wardenCheckout === builderCheckout) {
      violations.push(
        `Warden shares checkout directory '${wardenCheckout}' with builder (${bRole}) (Requirement 24.14)`
      );
    }

    if (wardenEnv.boxId && builder.boxId && wardenEnv.boxId === builder.boxId) {
      violations.push(
        `Warden shares container box ID '${wardenEnv.boxId}' with builder (${bRole}) (Requirement 24.14)`
      );
    }

    // Host path reachability check (Requirement 24.15)
    if (Array.isArray(wardenEnv.writableHostPaths) && Array.isArray(builder.writableHostPaths)) {
      const builderPaths = new Set(
        builder.writableHostPaths.map((p: string) => p.replace(/\\/g, "/"))
      );
      for (const wp of wardenEnv.writableHostPaths) {
        const normWp = wp.replace(/\\/g, "/");
        if (builderPaths.has(normWp)) {
          violations.push(
            `Warden writable host path '${normWp}' is reachable by builder (${bRole}) (Requirement 24.15)`
          );
        }
      }
    }
  }

  return {
    isolated: violations.length === 0,
    violations,
  };
}
