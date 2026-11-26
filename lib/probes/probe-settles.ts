import type { ProbeOutcome, ProbeResults } from "./runs-parser";

/**
 * Result returned when a required probe outcome is missing.
 * Missing probe outcomes must never be resolved to a default.
 */
export type NotPassed = "not passed";

/**
 * Common shape for all settled probe decisions.
 */
export interface SettleDecision<T> {
  status: "standard" | "fallback";
  fallbackChosen: boolean;
  fallback: string;
  why: string;
  reason: string;
  setting: T;
}

export interface HomeIsolationSetting {
  isolatedHome: boolean;
  agentsDir: string;
  perSkeletonHome: boolean;
  strategy: "global" | "per-skeleton-home";
}

export type HomeIsolationResolution = SettleDecision<HomeIsolationSetting> & HomeIsolationSetting;
export type HomeIsolationResult = HomeIsolationResolution | NotPassed;

export interface PermissionFormSetting {
  form: "candidate-deny-exclude" | "documented-safe";
  explicitPathsAllowed: boolean;
  otherActions: "deny" | "ask";
  brokerRejects: boolean;
}

export type PermissionFormResolution = SettleDecision<PermissionFormSetting> & PermissionFormSetting;
export type PermissionFormResult = PermissionFormResolution | NotPassed;

export interface SingleSkeletonLimitSetting {
  limitToOneSkeleton: boolean;
  maxConcurrentSkeletons: number;
  concurrencyLimit: number;
}

export type SingleSkeletonLimitResolution = SettleDecision<SingleSkeletonLimitSetting> & SingleSkeletonLimitSetting;
export type SingleSkeletonLimitResult = SingleSkeletonLimitResolution | NotPassed;

export interface SandboxFallbackSetting {
  internalSandboxEnabled: boolean;
  sandboxDisabled: boolean;
  spawnStdioShim: boolean;
  sanitizedEnvironment: boolean;
}

export type SandboxFallbackResolution = SettleDecision<SandboxFallbackSetting> & SandboxFallbackSetting;
export type SandboxFallbackResult = SandboxFallbackResolution | NotPassed;

function extractOutcome(
  input: ProbeOutcome | ProbeResults | Record<string, unknown> | undefined | null,
  targetId: string
): ProbeOutcome | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input === "object" && "id" in input && typeof input.id === "string") {
    return input as ProbeOutcome;
  }
  const rec = input as Record<string, unknown>;
  const val = rec[targetId] ?? rec[targetId.toUpperCase()] ?? rec[targetId.toLowerCase()];
  if (val && typeof val === "object" && "id" in val) {
    return val as ProbeOutcome;
  }
  return undefined;
}

function isMissing(outcome: ProbeOutcome | undefined): boolean {
  if (!outcome) {
    return true;
  }
  if (outcome.outcome === "not_passed" || outcome.outcome === "not passed") {
    return true;
  }
  if (!outcome.passed && !outcome.raw && (!outcome.outcome || outcome.outcome === "not_passed")) {
    return true;
  }
  return false;
}

function isPassed(outcome: ProbeOutcome): boolean {
  if (typeof outcome.passed === "boolean") {
    return outcome.passed;
  }
  if (typeof outcome.outcome === "string") {
    const s = outcome.outcome.trim().toLowerCase();
    return s === "pass" || s === "passed" || s === "ok" || s === "success" || s === "true";
  }
  return false;
}

/**
 * Resolves Skeleton HOME isolation fallback from probe P4 result.
 * If /agents is ignored or agents are not read from $KIRO_HOME/agents,
 * resolves an isolated HOME directory per Skeleton so ~/.kiro/agents/ resolves per Skeleton.
 * Requirement 45.6.
 */
export function resolveHomeIsolation(
  p4Input?: ProbeOutcome | ProbeResults | Record<string, unknown> | null
): HomeIsolationResult {
  const p4 = extractOutcome(p4Input, "P4");
  if (isMissing(p4)) {
    return "not passed";
  }

  const passed = isPassed(p4!);
  if (passed) {
    const setting: HomeIsolationSetting = {
      isolatedHome: false,
      agentsDir: "$KIRO_HOME/agents",
      perSkeletonHome: false,
      strategy: "global",
    };
    const why = "Probe P4 passed: global agents are read from $KIRO_HOME/agents.";
    return {
      status: "standard",
      fallbackChosen: false,
      fallback: "none",
      why,
      reason: why,
      setting,
      ...setting,
    };
  }

  const setting: HomeIsolationSetting = {
    isolatedHome: true,
    agentsDir: "~/.kiro/agents",
    perSkeletonHome: true,
    strategy: "per-skeleton-home",
  };
  const why =
    "Probe P4 failed or showed /agents is ignored: agents are not read from $KIRO_HOME/agents; providing each Skeleton with an isolated HOME directory so ~/.kiro/agents/ resolves per Skeleton.";
  return {
    status: "fallback",
    fallbackChosen: true,
    fallback: "per-skeleton-home",
    why,
    reason: why,
    setting,
    ...setting,
  };
}

/**
 * Resolves documented-safe permission form from probe P6 result.
 * If designed ask or deny rules do not behave as designed, falls back to
 * documented-safe form: explicit paths are allowed, other actions go to ask,
 * and the PermissionBroker rejects.
 * Requirement 45.7.
 */
export function resolvePermissionForm(
  p6Input?: ProbeOutcome | ProbeResults | Record<string, unknown> | null
): PermissionFormResult {
  const p6 = extractOutcome(p6Input, "P6");
  if (isMissing(p6)) {
    return "not passed";
  }

  const passed = isPassed(p6!);
  if (passed) {
    const setting: PermissionFormSetting = {
      form: "candidate-deny-exclude",
      explicitPathsAllowed: true,
      otherActions: "deny",
      brokerRejects: false,
    };
    const why = "Probe P6 passed: designed ask and deny rules behave as designed.";
    return {
      status: "standard",
      fallbackChosen: false,
      fallback: "none",
      why,
      reason: why,
      setting,
      ...setting,
    };
  }

  const setting: PermissionFormSetting = {
    form: "documented-safe",
    explicitPathsAllowed: true,
    otherActions: "ask",
    brokerRejects: true,
  };
  const why =
    "Probe P6 failed: designed ask or deny rules do not behave as designed; using documented-safe permission form where explicit paths are allowed, other actions go to ask, and PermissionBroker rejects.";
  return {
    status: "fallback",
    fallbackChosen: true,
    fallback: "documented-safe",
    why,
    reason: why,
    setting,
    ...setting,
  };
}

/**
 * Resolves single-Skeleton concurrency limit from probe P8 or spike S4 result.
 * If probe P8 or spike S4 shows that parallel sessions exceed host capacity,
 * limits live execution to one Skeleton at a time.
 * Requirement 45.8.
 */
export function resolveSingleSkeletonLimit(
  p8Input?: ProbeOutcome | ProbeResults | Record<string, unknown> | null,
  s4Input?: ProbeOutcome | null
): SingleSkeletonLimitResult {
  let outcomeP8: ProbeOutcome | undefined;
  let outcomeS4: ProbeOutcome | undefined;

  if (p8Input && typeof p8Input === "object" && !("id" in p8Input)) {
    outcomeP8 = extractOutcome(p8Input, "P8");
    outcomeS4 = s4Input ? extractOutcome(s4Input, "S4") : extractOutcome(p8Input, "S4");
  } else {
    outcomeP8 = extractOutcome(p8Input, "P8");
    outcomeS4 = extractOutcome(s4Input, "S4");
  }

  if (isMissing(outcomeP8) || isMissing(outcomeS4)) {
    return "not passed";
  }

  const p8Passed = isPassed(outcomeP8!);
  const s4Passed = isPassed(outcomeS4!);

  if (p8Passed && s4Passed) {
    const setting: SingleSkeletonLimitSetting = {
      limitToOneSkeleton: false,
      maxConcurrentSkeletons: 4,
      concurrencyLimit: 4,
    };
    const why = "Probe P8 and spike S4 passed: parallel sessions do not exceed host capacity.";
    return {
      status: "standard",
      fallbackChosen: false,
      fallback: "none",
      why,
      reason: why,
      setting,
      ...setting,
    };
  }

  const setting: SingleSkeletonLimitSetting = {
    limitToOneSkeleton: true,
    maxConcurrentSkeletons: 1,
    concurrencyLimit: 1,
  };
  const why =
    "Probe P8 or spike S4 showed parallel sessions exceed host capacity; limiting live execution to one Skeleton at a time.";
  return {
    status: "fallback",
    fallbackChosen: true,
    fallback: "single-skeleton",
    why,
    reason: why,
    setting,
    ...setting,
  };
}

/**
 * Resolves internal sandbox disabling and stdio shim spawning with explicit sanitized environment
 * from probe P9 result if bwrap is unavailable.
 * Requirement 45.9.
 */
export function resolveSandboxFallback(
  p9Input?: ProbeOutcome | ProbeResults | Record<string, unknown> | null
): SandboxFallbackResult {
  const p9 = extractOutcome(p9Input, "P9");
  if (isMissing(p9)) {
    return "not passed";
  }

  const passed = isPassed(p9!);
  if (passed) {
    const setting: SandboxFallbackSetting = {
      internalSandboxEnabled: true,
      sandboxDisabled: false,
      spawnStdioShim: false,
      sanitizedEnvironment: false,
    };
    const why = "Probe P9 passed: bwrap works in the execution environment.";
    return {
      status: "standard",
      fallbackChosen: false,
      fallback: "none",
      why,
      reason: why,
      setting,
      ...setting,
    };
  }

  const setting: SandboxFallbackSetting = {
    internalSandboxEnabled: false,
    sandboxDisabled: true,
    spawnStdioShim: true,
    sanitizedEnvironment: true,
  };
  const why =
    "Probe P9 failed: bwrap is unavailable or does not work; disabling internal sandbox and spawning stdio shim with an explicit sanitized environment.";
  return {
    status: "fallback",
    fallbackChosen: true,
    fallback: "disable-internal-sandbox-sanitized-stdio-shim",
    why,
    reason: why,
    setting,
    ...setting,
  };
}
