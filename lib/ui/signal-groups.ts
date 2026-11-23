/**
 * Pure helpers that arrange Signal_Chips for the Tombstone: by rule, then by
 * file, with lines in ascending order. Every input signal appears exactly once
 * in the output, so no receipt is ever dropped, sampled or truncated.
 */

/** The fields of a Signal_Chip that grouping and receipts depend on. */
export interface SignalReceiptLike {
  ruleId?: string;
  file?: string;
  line?: number;
  target?: string;
  clipboardPayload?: string;
}

export interface FileSignalGroup<T extends SignalReceiptLike> {
  /** File path as recorded; "" when the signal recorded no file. */
  file: string;
  hasFile: boolean;
  count: number;
  signals: readonly T[];
}

export interface RuleSignalGroup<T extends SignalReceiptLike> {
  ruleId: string;
  count: number;
  files: readonly FileSignalGroup<T>[];
}

/** The `file:line` receipt shown for a signal (same rule the chip always used). */
export function receiptTarget(signal: SignalReceiptLike): string {
  return signal.target || `${signal.file || ""}:${signal.line ?? 0}`;
}

/** The value the copy control writes to the clipboard. */
export function receiptCopyValue(signal: SignalReceiptLike): string {
  return signal.clipboardPayload || receiptTarget(signal);
}

/** True when the signal recorded a real 1-based line number. */
export function hasUsableLine(signal: SignalReceiptLike): boolean {
  return Number.isInteger(signal.line) && (signal.line as number) > 0;
}

function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareByLine(a: SignalReceiptLike, b: SignalReceiptLike): number {
  const aHas = hasUsableLine(a);
  const bHas = hasUsableLine(b);
  if (aHas && bHas) return (a.line as number) - (b.line as number);
  if (aHas !== bHas) return aHas ? -1 : 1;
  return 0;
}

/** Named files sorted by path; the "no file recorded" group goes last. */
function compareFileKeys(a: string, b: string): number {
  if (a === "" || b === "") {
    return a === b ? 0 : a === "" ? 1 : -1;
  }
  return compareCodePoints(a, b);
}

/**
 * Groups signals by file path. Files are ordered by path (code point order,
 * so the order does not depend on the viewer's locale); lines ascend, and
 * signals without a usable line keep their input order after numbered lines.
 */
export function groupSignalsByFile<T extends SignalReceiptLike>(
  signals: readonly T[]
): FileSignalGroup<T>[] {
  // A fresh local index; the input array and its items are never modified.
  const byFile = new Map<string, T[]>();
  for (const signal of signals) {
    const key = signal.file || "";
    byFile.set(key, [...(byFile.get(key) ?? []), signal]);
  }

  return [...byFile.keys()].sort(compareFileKeys).map((file) => {
    const fileSignals = [...(byFile.get(file) ?? [])].sort(compareByLine);
    return {
      file,
      hasFile: file !== "",
      count: fileSignals.length,
      signals: fileSignals,
    };
  });
}

/**
 * Builds one entry per rule ID, in the order given, each grouped by file.
 * A rule with no entry (or a null entry) yields a zero-count group.
 */
export function groupSignalsByRule<T extends SignalReceiptLike>(
  chipsByRule: Readonly<Record<string, readonly T[] | null | undefined>>,
  ruleIds: readonly string[]
): RuleSignalGroup<T>[] {
  return ruleIds.map((ruleId) => {
    const signals = chipsByRule[ruleId] ?? [];
    return {
      ruleId,
      count: signals.length,
      files: groupSignalsByFile(signals),
    };
  });
}
