"use client";

import React, { useState } from "react";
import type {
  SignalChip as SignalChipType,
  Receipt,
} from "@/lib/grimoire/autopsy";
import type { RuleId } from "@/lib/grimoire/types";

export interface SignalChipData {
  ruleId: RuleId | string;
  file: string;
  line: number;
  target?: string;
  clipboardPayload?: string;
  receipt?: Receipt;
  confidence?: string;
  matched?: string;
  snippet?: string;
}

export interface SignalChipProps {
  chip: SignalChipType | SignalChipData;
  sha?: string;
  onOpenReceipt?: (chip: SignalChipType | SignalChipData) => void;
}

type SignalSeverity = "critical" | "high" | "medium" | "low" | "info";

function resolveSignalSeverity(
  ruleId: string,
  confidence?: string
): SignalSeverity {
  const conf = confidence?.toLowerCase();
  const rule = ruleId.toUpperCase();

  if (conf === "high") {
    return rule === "M1" ? "critical" : "high";
  }
  if (conf === "medium") {
    return "medium";
  }
  if (conf === "low") {
    return "low";
  }
  if (rule === "M1") return "critical";
  if (rule === "M2") return "high";
  if (rule === "M3" || rule === "M4") return "medium";
  if (rule === "M5" || rule === "M6") return "info";
  return "info";
}

const SEVERITY_STYLES: Record<
  SignalSeverity,
  { container: string; badge: string }
> = {
  critical: {
    container:
      "border-rose-500/35 hover:border-rose-400/60 bg-rose-950/15",
    badge: "bg-rose-950/70 border-rose-500/45 text-rose-300",
  },
  high: {
    container:
      "border-rose-500/30 hover:border-rose-400/55 bg-rose-950/10",
    badge: "bg-rose-950/60 border-rose-500/40 text-rose-300",
  },
  medium: {
    container:
      "border-amber-500/30 hover:border-amber-400/55 bg-amber-950/10",
    badge: "bg-amber-950/60 border-amber-500/40 text-amber-300",
  },
  low: {
    container:
      "border-violet-500/30 hover:border-violet-400/55 bg-violet-950/10",
    badge: "bg-violet-950/60 border-violet-500/40 text-violet-300",
  },
  info: {
    container:
      "border-white/15 hover:border-white/30",
    badge: "bg-neutral-900 border-white/20 text-neutral-300",
  },
};

export function SignalChip({ chip, sha, onOpenReceipt }: SignalChipProps) {
  const [copied, setCopied] = useState(false);

  const ruleId = chip.ruleId || "M1";
  const file = chip.file || "";
  const line = chip.line ?? 0;
  const target = chip.target || `${file}:${line}`;
  const clipboardPayload = chip.clipboardPayload || target;
  const receiptFormatted = chip.receipt?.formatted || `${ruleId} ${target}`;
  const severity = resolveSignalSeverity(ruleId, chip.confidence);
  const styles = SEVERITY_STYLES[severity];

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(clipboardPayload);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write fallback
    }
  }

  function handleOpen(e: React.MouseEvent) {
    e.preventDefault();
    if (onOpenReceipt) {
      onOpenReceipt(chip);
    }
  }

  return (
    <div
      data-testid="signal-chip"
      data-ui-element="signal-chip"
      data-ui-state={severity}
      data-ui-variant={ruleId}
      data-rule-id={ruleId}
      data-target={target}
      data-sha={sha}
      title={receiptFormatted}
      className={`crypt-well inline-flex items-center gap-2 px-2.5 py-1.5 text-xs font-mono text-parchment transition-colors ${styles.container}`}
    >
      {/* Rule and file:line receipt */}
      <button
        type="button"
        onClick={handleOpen}
        data-testid="signal-chip-receipt-button"
        className="flex items-center gap-1.5 hover:text-bone cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 rounded"
        title="View source receipt line"
      >
        <span
          className={`px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${styles.badge}`}
        >
          {ruleId}
        </span>
        <span
          data-testid="signal-chip-target"
          className="underline decoration-dotted underline-offset-2 text-bone"
        >
          {target}
        </span>
      </button>

      {/* Copy control (Requirement 5.6) */}
      <button
        type="button"
        onClick={handleCopy}
        data-testid="signal-chip-copy"
        data-clipboard-payload={clipboardPayload}
        className="px-1.5 py-0.5 rounded bg-neutral-900/90 hover:bg-neutral-800 text-ash hover:text-bone text-[10px] cursor-pointer border border-white/10 hover:border-white/25 transition-colors"
        title={`Copy ${clipboardPayload} to clipboard`}
        aria-label={`Copy ${clipboardPayload} to clipboard`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
