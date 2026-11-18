import type { ProbeOutcome, ProbeResults } from "./runs-parser";

export type NotPassed = "not passed";

export interface SymlinkScanSetting {
  required: boolean;
  mandatory: boolean;
  scanTiming: "before_every_prompt_and_after_every_sandbox_exec" | "none";
  timing: "before_every_prompt_and_after_every_sandbox_exec" | "none";
  scanBeforePrompt: boolean;
  scanAfterSandboxExec: boolean;
  enforceMandatoryScan: boolean;
  policy: "mandatory symlink scan before every prompt and after every sandbox_exec" | "none";
  description: string;
}

export type SymlinkScanResult = SymlinkScanSetting | NotPassed;

export interface CreditsDisplayPolicy {
  capsApplyTo: "wall_clock_and_tool_calls_only" | "credits_wall_clock_and_tool_calls";
  caps: ("wall_clock" | "tool_calls" | "credits")[];
  wallClockAndToolCallsOnly: boolean;
  creditsCapEnforced: boolean;
  uiDisplay: "not reported" | "reported";
  creditsDisplay: "not reported" | "reported";
  displayCredits: "not reported" | "reported";
  estimateCredits: false;
  description: string;
}

export type CreditsDisplayResult = CreditsDisplayPolicy | NotPassed;

export interface HeadlessFallbackState {
  active: boolean;
  channel: "Headless_Fallback" | "ACP_V3";
  headlessFallbackActive: boolean;
  disabledForLiveRuns: boolean;
  liveRunsDisabled: boolean;
  liveRunsAllowed: boolean;
  liveRunsEnabled: boolean;
  description: string;
}

export type HeadlessFallbackResult = HeadlessFallbackState | NotPassed;

export interface AcpLoadHandling {
  removeLoadedFiles: boolean;
  remove: boolean;
  markSkipWorktree: boolean;
  skipWorktree: boolean;
  action: "remove_and_skip_worktree" | "keep";
  untrustedFilesHandled: boolean;
  description: string;
}

export type AcpLoadHandlingResult = AcpLoadHandling | NotPassed;

export interface CreditBalanceSource {
  creditBalanceSource: "kiro_portal" | "_kiro/account/getUsage";
  balanceSource: "kiro_portal" | "_kiro/account/getUsage";
  directOwnerToPortal: boolean;
  connectionVerification: "gateway_records" | "mcp_status";
  connectionSource: "gateway_records" | "mcp_status";
  verifyViaGatewayRecords: boolean;
  verifyFromGatewayRecords: boolean;
  description: string;
}

export type CreditBalanceResult = CreditBalanceSource | NotPassed;

function extractProbe(
  probeOrResults: unknown,
  expectedId: string
): ProbeOutcome | undefined {
  if (!probeOrResults || typeof probeOrResults !== "object") {
    if (typeof probeOrResults === "boolean") {
      return {
        id: expectedId,
        passed: probeOrResults,
        outcome: probeOrResults ? "pass" : "fail",
      };
    }
    if (typeof probeOrResults === "string") {
      const s = probeOrResults.trim().toLowerCase();
      if (s === "not passed" || s === "not_passed" || s === "missing") {
        return undefined;
      }
      const passed = s === "pass" || s === "passed" || s === "ok" || s === "true";
      return {
        id: expectedId,
        passed,
        outcome: probeOrResults,
      };
    }
    return undefined;
  }

  const rec = probeOrResults as Record<string, unknown>;

  if ("id" in rec && typeof rec.id === "string") {
    return rec as unknown as ProbeOutcome;
  }

  const found =
    rec[expectedId] ??
    rec[expectedId.toUpperCase()] ??
    rec[expectedId.toLowerCase()];

  if (found && typeof found === "object" && "id" in (found as Record<string, unknown>)) {
    return found as unknown as ProbeOutcome;
  }

  return undefined;
}

function isMissingProbe(probe: unknown): boolean {
  if (probe === undefined || probe === null) {
    return true;
  }
  if (typeof probe !== "object") {
    return true;
  }

  const obj = probe as Record<string, unknown>;

  if (!("passed" in obj) && !("outcome" in obj) && !("raw" in obj)) {
    return true;
  }

  if (typeof obj.outcome === "string") {
    const o = obj.outcome.trim().toLowerCase();
    if (o === "not_passed" || o === "not passed" || o === "missing" || o === "unknown") {
      return true;
    }
  }

  if (obj.passed === false && !obj.raw && (!obj.outcome || obj.outcome === "not_passed")) {
    return true;
  }

  return false;
}

/**
 * symlinkScanRequired(p12)
 *
 * Enforces a mandatory symlink scan before every prompt and after every sandbox_exec
 * when P12 shows that file tools follow symlinks.
 * If P12 result is missing, returns "not passed", never a default.
 */
export function symlinkScanRequired(p12?: unknown): SymlinkScanResult {
  const probe = extractProbe(p12, "P12");
  if (!probe || isMissingProbe(probe)) {
    return "not passed";
  }

  const outcomeText = (probe.outcome || "").toLowerCase();
  const rawText = (probe.raw || "").toLowerCase();
  const text = `${outcomeText} ${rawText}`;

  const followsSymlinks =
    !probe.passed ||
    (/\bfollow/i.test(text) && !/\b(no\s+follow|not\s+follow|does\s+not\s+follow|safe)\b/i.test(text));

  const timing = "before_every_prompt_and_after_every_sandbox_exec";
  const policy = "mandatory symlink scan before every prompt and after every sandbox_exec";
  const description = "mandatory symlink scan before every prompt and after every sandbox_exec";

  const obj: SymlinkScanSetting = {
    required: true,
    mandatory: true,
    scanTiming: timing,
    timing,
    scanBeforePrompt: true,
    scanAfterSandboxExec: true,
    enforceMandatoryScan: true,
    policy,
    description,
  };

  Object.defineProperty(obj, "valueOf", {
    value: function () {
      return true;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(obj, "toString", {
    value: function () {
      return description;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return obj;
}

/**
 * creditsDisplayPolicy(p5)
 *
 * When P5 shows that turn_completion lacks credits, caps apply to wall-clock time
 * and tool calls only, and the UI shows "not reported" for credits.
 * If P5 result is missing, returns "not passed", never a default.
 */
export function creditsDisplayPolicy(p5?: unknown): CreditsDisplayResult {
  const probe = extractProbe(p5, "P5");
  if (!probe || isMissingProbe(probe)) {
    return "not passed";
  }

  const outcomeText = (probe.outcome || "").toLowerCase();
  const rawText = (probe.raw || "").toLowerCase();
  const text = `${outcomeText} ${rawText}`;

  const lacksCredits =
    !probe.passed ||
    /\b(no\s+credit|lack|lacks|missing\s+credit|not\s+reported|no\s+field)\b/i.test(text);

  const caps: ("wall_clock" | "tool_calls" | "credits")[] = lacksCredits
    ? ["wall_clock", "tool_calls"]
    : ["wall_clock", "tool_calls", "credits"];
  const capsApplyTo = lacksCredits
    ? "wall_clock_and_tool_calls_only"
    : "credits_wall_clock_and_tool_calls";
  const uiDisplay = lacksCredits ? "not reported" : "reported";
  const description = lacksCredits
    ? 'caps apply to wall-clock time and tool calls only, and the UI shows "not reported" for credits'
    : "caps apply to credits, wall-clock time, and tool calls; credits are reported";

  const obj: CreditsDisplayPolicy = {
    capsApplyTo,
    caps,
    wallClockAndToolCallsOnly: lacksCredits,
    creditsCapEnforced: !lacksCredits,
    uiDisplay,
    creditsDisplay: uiDisplay,
    displayCredits: uiDisplay,
    estimateCredits: false,
    description,
  };

  Object.defineProperty(obj, "toString", {
    value: function () {
      return description;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return obj;
}

/**
 * headlessFallbackState(p1, p14)
 *
 * The Headless_Fallback channel is active only when P1 fails.
 * It stays disabled for live runs when P14 shows that stream-json cannot verify the active model.
 * If either probe result is missing, returns "not passed", never a default.
 */
export function headlessFallbackState(p1?: unknown, p14?: unknown): HeadlessFallbackResult {
  let probe1 = extractProbe(p1, "P1");
  let probe14 = extractProbe(p14, "P14");

  if (!probe14 && p1 && typeof p1 === "object" && !("id" in p1)) {
    probe14 = extractProbe(p1, "P14");
  }

  if (!probe1 || isMissingProbe(probe1) || !probe14 || isMissingProbe(probe14)) {
    return "not passed";
  }

  const outcome1 = (probe1.outcome || "").toLowerCase();
  const raw1 = (probe1.raw || "").toLowerCase();
  const text1 = `${outcome1} ${raw1}`;
  const p1Failed = !probe1.passed || /\b(fail|failed|error|auth_failed|cannot)\b/i.test(text1);

  const outcome14 = (probe14.outcome || "").toLowerCase();
  const raw14 = (probe14.raw || "").toLowerCase();
  const text14 = `${outcome14} ${raw14}`;
  const p14CannotVerifyModel =
    !probe14.passed ||
    /\b(cannot\s+verify|no\s+model|not\s+reported|unverified|missing\s+model)\b/i.test(text14);

  const channel = p1Failed ? "Headless_Fallback" : "ACP_V3";
  const active = p1Failed;
  const disabledForLiveRuns = p14CannotVerifyModel;
  const liveRunsAllowed = !disabledForLiveRuns;

  let description = "";
  if (p1Failed) {
    if (disabledForLiveRuns) {
      description =
        "the Headless_Fallback channel is active only when P1 fails. It stays disabled for live runs when P14 shows that stream-json cannot verify the active model.";
    } else {
      description =
        "the Headless_Fallback channel is active only when P1 fails. Live runs enabled as stream-json verified the active model.";
    }
  } else {
    description = "ACP_V3 channel is primary; Headless_Fallback is inactive.";
  }

  const obj: HeadlessFallbackState = {
    active,
    channel,
    headlessFallbackActive: active,
    disabledForLiveRuns,
    liveRunsDisabled: disabledForLiveRuns,
    liveRunsAllowed,
    liveRunsEnabled: liveRunsAllowed,
    description,
  };

  Object.defineProperty(obj, "valueOf", {
    value: function () {
      return active;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(obj, "toString", {
    value: function () {
      return description;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return obj;
}

/**
 * acpLoadHandling(p7)
 *
 * When P7 shows that ACP loads repository Kiro files, remove them and mark them skip-worktree.
 * If P7 result is missing, returns "not passed", never a default.
 */
export function acpLoadHandling(p7?: unknown): AcpLoadHandlingResult {
  const probe = extractProbe(p7, "P7");
  if (!probe || isMissingProbe(probe)) {
    return "not passed";
  }

  const outcomeText = (probe.outcome || "").toLowerCase();
  const rawText = (probe.raw || "").toLowerCase();
  const text = `${outcomeText} ${rawText}`;

  const loadsRepoKiroFiles =
    !probe.passed ||
    (/\b(load|loads|loading)\b/i.test(text) && !/\b(no\s+load|not\s+load|does\s+not\s+load|safe)\b/i.test(text));

  const action = loadsRepoKiroFiles ? "remove_and_skip_worktree" : "keep";
  const description = loadsRepoKiroFiles
    ? "when P7 shows that ACP loads repository Kiro files, remove them and mark them skip-worktree."
    : "ACP does not load repository Kiro files; keep files in worktree.";

  const obj: AcpLoadHandling = {
    removeLoadedFiles: loadsRepoKiroFiles,
    remove: loadsRepoKiroFiles,
    markSkipWorktree: loadsRepoKiroFiles,
    skipWorktree: loadsRepoKiroFiles,
    action,
    untrustedFilesHandled: loadsRepoKiroFiles,
    description,
  };

  Object.defineProperty(obj, "valueOf", {
    value: function () {
      return loadsRepoKiroFiles;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(obj, "toString", {
    value: function () {
      return description;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return obj;
}

/**
 * creditBalanceSource(p15)
 *
 * When _kiro/account/getUsage is not advertised, direct the Owner to the Kiro portal.
 * When no MCP status method is advertised, verify the connection from gateway records.
 * If P15 result is missing, returns "not passed", never a default.
 */
export function creditBalanceSource(p15?: unknown): CreditBalanceResult {
  const probe = extractProbe(p15, "P15");
  if (!probe || isMissingProbe(probe)) {
    return "not passed";
  }

  const outcomeText = (probe.outcome || "").toLowerCase();
  const rawText = (probe.raw || "").toLowerCase();
  const text = `${outcomeText} ${rawText}`;

  let getUsageAdvertised = probe.passed;
  if (/\b(no\s+getusage|getusage\s+not\s+advertised|not\s+advertised)\b/i.test(text)) {
    getUsageAdvertised = false;
  }

  let mcpStatusAdvertised = probe.passed;
  if (/\b(no\s+mcp\s+status|mcp\s+status\s+not\s+advertised|no\s+mcp_status)\b/i.test(text)) {
    mcpStatusAdvertised = false;
  }

  const balanceSource = getUsageAdvertised ? "_kiro/account/getUsage" : "kiro_portal";
  const directOwnerToPortal = !getUsageAdvertised;
  const connectionVerification = mcpStatusAdvertised ? "mcp_status" : "gateway_records";
  const verifyViaGatewayRecords = !mcpStatusAdvertised;

  const description =
    `${directOwnerToPortal ? "direct Owner to Kiro portal for credit balance" : "obtain credit balance via _kiro/account/getUsage"}; ` +
    `${verifyViaGatewayRecords ? "verify connection from gateway records" : "verify connection status via advertised MCP status method"}.`;

  const obj: CreditBalanceSource = {
    creditBalanceSource: balanceSource,
    balanceSource,
    directOwnerToPortal,
    connectionVerification,
    connectionSource: connectionVerification,
    verifyViaGatewayRecords,
    verifyFromGatewayRecords: verifyViaGatewayRecords,
    description,
  };

  Object.defineProperty(obj, "toString", {
    value: function () {
      return description;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return obj;
}

export default {
  symlinkScanRequired,
  creditsDisplayPolicy,
  headlessFallbackState,
  acpLoadHandling,
  creditBalanceSource,
};
