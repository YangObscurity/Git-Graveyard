import * as fs from "node:fs";

/**
 * Note on line format recognition (see tasks.md task 1.3):
 * The spec does not fix the line format for probe results in memory/RUNS.md.
 * This parser recognises table lines that start with "| <id> |" (ignoring whitespace
 * around pipes and id) where <id> matches a probe or spike identifier (e.g. P1..P17, S1..S5).
 * A line carries a pass outcome if any subsequent cell contains a recognized pass token
 * (such as "pass", "passed", "ok", "success", or "true", case-insensitive) and does not
 * contain failure or negation tokens (such as "fail", "failed", "not passed", "error").
 * Any probe or spike missing from the file or without a recorded passing result
 * counts as not passed.
 */

export const DEV_PROBES = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
  "P9",
  "P12",
  "P13",
  "P14",
  "P15",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
] as const;

export const PROD_PROBES = ["P10", "P11", "P16", "P17"] as const;

export const ALL_PROBE_IDS = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
  "P9",
  "P10",
  "P11",
  "P12",
  "P13",
  "P14",
  "P15",
  "P16",
  "P17",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
] as const;

export type ProbeId = (typeof ALL_PROBE_IDS)[number] | string;

export interface ProbeOutcome {
  id: string;
  passed: boolean;
  outcome: string;
  raw?: string;
}

export type ProbeResults = Record<string, ProbeOutcome>;

// A status cell reads "passed (details...)" or "failed (exit code 2)". The
// parenthesised detail is free text and may contain the opposite word (for
// example "passed (... the write failed ...)"), so only the text outside the
// parentheses decides the outcome.
function stripParenthesised(cell: string): string {
  let prev: string;
  let out = cell;
  do {
    prev = out;
    out = out.replace(/\([^()]*\)/g, " ");
  } while (out !== prev);
  return out.replace(/\([^]*$/, " ").trim();
}

function carriesPassOutcome(rawCells: string[]): boolean {
  const cells = rawCells.map(stripParenthesised).filter((c) => c.length > 0);
  if (cells.length === 0) {
    return false;
  }

  const hasExplicitFail = cells.some((cell) => {
    const c = cell.toLowerCase().trim();
    return (
      c === "fail" ||
      c === "failed" ||
      c === "not passed" ||
      c === "not pass" ||
      c === "error" ||
      c === "false" ||
      /\b(fail|failed|failure|not\s+pass(ed)?)\b/i.test(c)
    );
  });

  if (hasExplicitFail) {
    return false;
  }

  const hasExplicitPass = cells.some((cell) => {
    const c = cell.toLowerCase().trim();
    return (
      c === "pass" ||
      c === "passed" ||
      c === "ok" ||
      c === "success" ||
      c === "true" ||
      /\b(pass|passed|ok|success)\b/i.test(c)
    );
  });

  return hasExplicitPass;
}

function extractOutcomeText(cells: string[], passed: boolean): string {
  if (cells.length === 0) {
    return passed ? "passed" : "not_passed";
  }
  if (passed) {
    const passCell = cells.find((c) =>
      /\b(pass|passed|ok|success|true)\b/i.test(c.toLowerCase())
    );
    return passCell ? passCell.trim() : "passed";
  }
  const failCell = cells.find((c) =>
    /\b(fail|failed|failure|not\s+pass(ed)?|error|false)\b/i.test(c.toLowerCase())
  );
  return failCell ? failCell.trim() : cells[0].trim();
}

export function parseRunsContent(content: string): Record<string, ProbeOutcome> {
  const results: Record<string, ProbeOutcome> = {};

  for (const id of ALL_PROBE_IDS) {
    results[id] = {
      id,
      passed: false,
      outcome: "not_passed",
    };
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\|\s*([^|]+?)\s*\|(.*)$/);
    if (!match) {
      continue;
    }

    const rawId = match[1].trim();
    const rest = match[2];

    // Markdown table separator rows (|---|---|) are not probe rows.
    if (/^[-:\s]+$/.test(rawId)) {
      continue;
    }

    const cells = rest
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const upperId = rawId.toUpperCase();
    const isKnown = ALL_PROBE_IDS.includes(upperId as (typeof ALL_PROBE_IDS)[number]);

    // The runner writes | <timestamp> | phase0-runner | P1: <title> | <status> | <dir> |,
    // so the id can also sit as a "P1:" prefix in a later cell. Without this the
    // runner's own lines never reach the gate.
    let id = isKnown ? upperId : rawId;
    let resolved = isKnown;
    if (!isKnown) {
      for (const cell of cells) {
        const prefixed = cell.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:/);
        if (prefixed && ALL_PROBE_IDS.includes(prefixed[1].toUpperCase() as (typeof ALL_PROBE_IDS)[number])) {
          id = prefixed[1].toUpperCase();
          resolved = true;
          break;
        }
      }
    }

    // Journal rows carry a timestamp in the first cell; they are not probe rows
    // unless a "P<id>:" or "S<id>:" cell named one.
    if (!resolved && /^\d{4}-\d{2}-\d{2}T/.test(rawId)) {
      continue;
    }

    const passed = carriesPassOutcome(cells);
    const outcomeText = extractOutcomeText(cells, passed);

    results[id] = {
      id,
      passed,
      outcome: outcomeText,
      raw: trimmed,
    };
  }

  return results;
}

export function parseRuns(filePath: string): Record<string, ProbeOutcome> {
  try {
    if (!fs.existsSync(filePath)) {
      const results: Record<string, ProbeOutcome> = {};
      for (const id of ALL_PROBE_IDS) {
        results[id] = {
          id,
          passed: false,
          outcome: "not_passed",
        };
      }
      return results;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return parseRunsContent(content);
  } catch {
    const results: Record<string, ProbeOutcome> = {};
    for (const id of ALL_PROBE_IDS) {
      results[id] = {
        id,
        passed: false,
        outcome: "not_passed",
      };
    }
    return results;
  }
}

export const parseProbeRuns = parseRuns;
export const parseRunsMd = parseRuns;
export const readRuns = parseRuns;

export default parseRuns;
