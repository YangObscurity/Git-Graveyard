import type {
  DeadReason,
  AutopsyDeadReason,
  AutopsyVerdict,
  AutopsyStatus,
  Signal,
  RuleId,
  Confidence,
} from "./types";

export type {
  DeadReason,
  AutopsyDeadReason,
  AutopsyVerdict,
  AutopsyStatus,
  Signal,
  RuleId,
  Confidence,
};

// Requirement 4.6: While status is alive, label is "still breathing"
export const STILL_BREATHING = "still breathing" as const;
export const ALIVE_LABEL = STILL_BREATHING;
export const STILL_BREATHING_LABEL = STILL_BREATHING;

export const MS_PER_DAY = 86_400_000;
export const DAYS_PER_YEAR = 365.25;
export const MS_PER_YEAR = DAYS_PER_YEAR * MS_PER_DAY;

// Requirement 4.3, 4.4: M1 to M4 count; M5 and M6 are excluded
const DEPRECATION_RULES = new Set<string>(["M1", "M2", "M3", "M4"]);

export interface VerdictResult {
  status: AutopsyVerdict;
  deadReasons: DeadReason[];
  reasons: DeadReason[];
  lifespanYears: number | "unknown";
  yearsDead: number;
  label?: string;
  asOf: string;
}

export type Verdict = VerdictResult;
export type ComputeVerdictResult = VerdictResult;

export interface ComputeVerdictOptions {
  archived?: boolean;
  lastCommitAt?: string | Date | number;
  createdAt?: string | Date | number;
  created_at?: string | Date | number;
  signals?: readonly Signal[] | Iterable<Signal> | { signals?: readonly Signal[] } | null;
  asOf?: string | Date | number;
  meta?: {
    archived?: boolean;
    createdAt?: string | Date | number;
    created_at?: string | Date | number;
    asOf?: string | Date | number;
    [key: string]: unknown;
  };
  headCommit?: {
    lastCommitAt?: string | Date | number;
    committerDate?: string | Date | number;
    [key: string]: unknown;
  };
  defaultHeadCommit?: {
    lastCommitAt?: string | Date | number;
    committerDate?: string | Date | number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type ComputeVerdictInput = ComputeVerdictOptions;

export function roundToOneDecimal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function subtract24CalendarMonths(date: Date): Date {
  const result = new Date(date.getTime());
  const origDay = result.getUTCDate();
  // Move to the 1st of the month to prevent day-overflow during year subtraction
  result.setUTCDate(1);
  result.setUTCFullYear(result.getUTCFullYear() - 2);
  // Clamp day to max days in target month
  const maxDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(origDay, maxDay));
  return result;
}

export function hasDeprecationSignal(
  signals?: readonly Signal[] | Iterable<Signal> | { signals?: readonly Signal[] } | null
): boolean {
  if (!signals) return false;
  const list =
    typeof signals === "object" && "signals" in signals && Array.isArray((signals as any).signals)
      ? (signals as any).signals
      : signals;

  if (typeof (list as any)[Symbol.iterator] !== "function") {
    return false;
  }

  for (const s of list as Iterable<Signal>) {
    if (!s) continue;
    const ruleId = typeof s.ruleId === "string" ? s.ruleId.trim().toUpperCase() : "";
    const confidence = typeof s.confidence === "string" ? s.confidence.trim().toLowerCase() : "";
    if (confidence === "high" && DEPRECATION_RULES.has(ruleId)) {
      return true;
    }
  }
  return false;
}

function parseDate(val: unknown): Date | null {
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val;
  }
  if (typeof val === "string" || typeof val === "number") {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function computeVerdict(options: ComputeVerdictOptions): VerdictResult;
export function computeVerdict(
  archived: boolean,
  lastCommitAt?: string | Date | number,
  createdAt?: string | Date | number,
  signals?: readonly Signal[] | Iterable<Signal> | { signals?: readonly Signal[] } | null,
  asOf?: string | Date | number
): VerdictResult;
export function computeVerdict(
  inputOrArchived?: ComputeVerdictOptions | boolean,
  maybeLastCommitAt?: string | Date | number,
  maybeCreatedAt?: string | Date | number,
  maybeSignals?: readonly Signal[] | Iterable<Signal> | { signals?: readonly Signal[] } | null,
  maybeAsOf?: string | Date | number
): VerdictResult {
  let archived = false;
  let lastCommitAtRaw: unknown = undefined;
  let createdAtRaw: unknown = undefined;
  let signalsRaw: unknown = undefined;
  let asOfRaw: unknown = undefined;

  if (typeof inputOrArchived === "object" && inputOrArchived !== null) {
    const opts = inputOrArchived;
    archived = Boolean(opts.archived ?? opts.meta?.archived ?? false);
    lastCommitAtRaw =
      opts.lastCommitAt ??
      opts.headCommit?.lastCommitAt ??
      opts.headCommit?.committerDate ??
      opts.defaultHeadCommit?.lastCommitAt ??
      opts.defaultHeadCommit?.committerDate;
    createdAtRaw =
      opts.createdAt ??
      opts.created_at ??
      opts.meta?.createdAt ??
      opts.meta?.created_at;
    signalsRaw = opts.signals;
    asOfRaw = opts.asOf ?? opts.meta?.asOf;
  } else {
    archived = Boolean(inputOrArchived);
    lastCommitAtRaw = maybeLastCommitAt;
    createdAtRaw = maybeCreatedAt;
    signalsRaw = maybeSignals;
    asOfRaw = maybeAsOf;
  }

  // Requirement 4.10, 4.11: asOf is passed in by caller or defaults to autopsy request time
  const parsedAsOf = parseDate(asOfRaw);
  const asOfDate = parsedAsOf ?? new Date();

  const lastCommitDate = parseDate(lastCommitAtRaw);
  const createdDate = parseDate(createdAtRaw);

  const deadReasons: DeadReason[] = [];

  // Requirement 4.1: archived is true
  if (archived) {
    deadReasons.push("archived");
  }

  // Requirement 4.2: lastCommitAt is earlier than asOf minus 24 calendar months
  if (lastCommitDate) {
    const threshold = subtract24CalendarMonths(asOfDate);
    if (lastCommitDate.getTime() < threshold.getTime()) {
      deadReasons.push("dormant_24m");
    }
  }

  // Requirement 4.3, 4.4: at least one high-confidence signal with ruleId M1-M4 (excluding M5-M6)
  if (hasDeprecationSignal(signalsRaw as any)) {
    deadReasons.push("deprecation_signal");
  }

  // Requirement 4.5: status dead when at least one reason holds, otherwise alive
  const status: AutopsyVerdict = deadReasons.length > 0 ? "dead" : "alive";

  // Requirement 4.7, 4.8: lifespanYears = (lastCommitAt - createdAt) / 365.25 days, rounded to one decimal
  // Reported as "unknown" when negative
  let lifespanYears: number | "unknown";
  if (lastCommitDate && createdDate) {
    const lifespanDiffMs = lastCommitDate.getTime() - createdDate.getTime();
    if (lifespanDiffMs < 0) {
      lifespanYears = "unknown";
    } else {
      lifespanYears = roundToOneDecimal(lifespanDiffMs / MS_PER_YEAR);
    }
  } else {
    lifespanYears = "unknown";
  }

  // Requirement 4.9: yearsDead = (asOf - lastCommitAt) / 365.25 days, rounded to one decimal
  let yearsDead: number;
  if (lastCommitDate) {
    const yearsDeadDiffMs = asOfDate.getTime() - lastCommitDate.getTime();
    yearsDead = roundToOneDecimal(yearsDeadDiffMs / MS_PER_YEAR);
  } else {
    yearsDead = 0;
  }

  // Requirement 4.6: label "still breathing" for alive status
  const label = status === "alive" ? STILL_BREATHING : undefined;

  return {
    status,
    deadReasons,
    reasons: deadReasons,
    lifespanYears,
    yearsDead,
    label,
    asOf: asOfDate.toISOString(),
  };
}
