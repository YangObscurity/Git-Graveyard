export const DEV_REQUIRED_PROBES = [
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

export const PROD_REQUIRED_PROBES = [
  "P10",
  "P11",
  "P16",
  "P17",
] as const;

import { acpLoadHandling } from "./probe-fallbacks";
import { resolveHomeIsolation, resolveSandboxFallback } from "./probe-settles";

export interface GateResult {
  allowed: boolean;
  missing: string[];
  /** Probes that really failed (exit code 1) and whose fallback is wired in code. */
  settledByFallback: string[];
}

/**
 * Probes whose ideal outcome does not hold on the platform and whose fallback is
 * already implemented. A recorded real FAIL (exit code 1, not the INCONCLUSIVE
 * exit code 2) counts as resolved for these probes only. P12 and S2 are not here.
 *
 * Only P4, P7 and P9 remain: P2 and P5 were first recorded as FAIL by probes that
 * never reached a tool call (a repeated session/prompt cancelled the turn, the
 * shell_type request went unanswered, credits were searched for as a key name
 * instead of the unit value). Re-measured on kiro-cli 3.2.0 both PASS.
 * The resolver call is a presence check, not proof the fallback works; the proof
 * is in the fallback tests.
 */
const SETTLED_BY_FALLBACK: Record<string, (probe: unknown) => boolean> = {
  // P7: Kiro loads the repo's steering, AGENTS.md, skills and mcp.json; the fallback
  // (lib/security/untrusted-content.ts) strips them and marks them skip-worktree.
  P7: (probe) => acpLoadHandling(probe) !== "not passed",
  P4: (probe) => resolveHomeIsolation(probe as never) !== "not passed",
  P9: (probe) => resolveSandboxFallback(probe as never) !== "not passed",
};

function lookup(results: unknown, id: string): unknown {
  if (!results) {
    return undefined;
  }
  if (results instanceof Map) {
    return results.get(id) ?? results.get(id.toUpperCase()) ?? results.get(id.toLowerCase());
  }
  if (Array.isArray(results)) {
    return results.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "id" in entry &&
        String((entry as { id: unknown }).id).toUpperCase() === id.toUpperCase()
    );
  }
  if (typeof results === "object") {
    const rec = results as Record<string, unknown>;
    return rec[id] ?? rec[id.toUpperCase()] ?? rec[id.toLowerCase()];
  }
  return undefined;
}

function isRealFail(probe: unknown): boolean {
  if (!probe || typeof probe !== "object") {
    return false;
  }
  const p = probe as { passed?: unknown; outcome?: unknown; raw?: unknown };
  if (p.passed === true) {
    return false;
  }
  const text = `${typeof p.outcome === "string" ? p.outcome : ""} ${typeof p.raw === "string" ? p.raw : ""}`;
  return /\bexit code 1(?!\d)/i.test(text);
}

function settledByFallback(results: unknown, id: string): boolean {
  const resolver = SETTLED_BY_FALLBACK[id];
  if (!resolver) {
    return false;
  }
  const probe = lookup(results, id);
  return isRealFail(probe) && resolver(probe);
}

function checkValuePassed(val: unknown): boolean {
  if (val === undefined || val === null) {
    return false;
  }
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    return s === "pass" || s === "passed" || s === "ok" || s === "success" || s === "true";
  }
  if (typeof val === "object") {
    if ("passed" in val) {
      const p = (val as { passed: unknown }).passed;
      if (typeof p === "boolean") {
        return p;
      }
      if (typeof p === "string") {
        const s = p.trim().toLowerCase();
        return s === "pass" || s === "passed" || s === "ok" || s === "success" || s === "true";
      }
    }
    if ("outcome" in val) {
      const o = (val as { outcome: unknown }).outcome;
      if (typeof o === "string") {
        const s = o.trim().toLowerCase();
        return s === "pass" || s === "passed" || s === "ok" || s === "success" || s === "true";
      }
      if (typeof o === "boolean") {
        return o;
      }
    }
  }
  return false;
}

function hasPassingResult(results: unknown, id: string): boolean {
  if (!results) {
    return false;
  }

  if (results instanceof Map) {
    const val =
      results.get(id) ??
      results.get(id.toUpperCase()) ??
      results.get(id.toLowerCase());
    return checkValuePassed(val);
  }

  if (Array.isArray(results)) {
    const item = results.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "id" in entry &&
        String((entry as { id: unknown }).id).toUpperCase() === id.toUpperCase()
    );
    return checkValuePassed(item);
  }

  if (typeof results === "object") {
    const rec = results as Record<string, unknown>;
    const val =
      rec[id] ??
      rec[id.toUpperCase()] ??
      rec[id.toLowerCase()];
    return checkValuePassed(val);
  }

  return false;
}

export function devLiveRunsAllowed(results: unknown): GateResult {
  const missing: string[] = [];
  const settled: string[] = [];
  for (const id of DEV_REQUIRED_PROBES) {
    if (hasPassingResult(results, id)) {
      continue;
    }
    if (settledByFallback(results, id)) {
      settled.push(id);
    } else {
      missing.push(id);
    }
  }
  return {
    allowed: missing.length === 0,
    missing,
    settledByFallback: settled,
  };
}

export function prodLiveRunsAllowed(results: unknown): GateResult {
  const missing: string[] = [];
  for (const id of PROD_REQUIRED_PROBES) {
    if (!hasPassingResult(results, id)) {
      missing.push(id);
    }
  }
  return {
    allowed: missing.length === 0,
    missing,
    settledByFallback: [],
  };
}
