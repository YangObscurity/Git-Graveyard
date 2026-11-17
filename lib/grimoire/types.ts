// Requirement 6.1
export type RuleId = "M1" | "M2" | "M3" | "M4" | "M5" | "M6";

// Requirement 3.11 (conflict: task 4.5 also lists "low")
export type Confidence = "high" | "medium";

// Requirement 3.11
export interface Signal {
  ruleId: RuleId;
  file: string;
  line: number;
  column: number;
  matched: string;
  confidence: Confidence;
  manifestDir: string;
}

// Requirements 3.9, 3.13
export interface UnknownRecord {
  ruleId?: unknown; // type not fixed by spec
  reason: string;
  file?: string;
  line?: unknown; // type not fixed by spec
}

// Requirements 4.1 to 4.4
export type DeadReason = "archived" | "dormant_24m" | "deprecation_signal";

// Requirements 4.1 to 4.4
export type AutopsyDeadReason = DeadReason;

// Requirement 4.5
export type AutopsyVerdict = "dead" | "alive";

// Requirement 4.5
export type AutopsyStatus = AutopsyVerdict;
