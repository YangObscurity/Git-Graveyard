"use client";

import React, { useEffect, useState } from "react";
import type {
  SignalChip as SignalChipType,
  Receipt,
} from "@/lib/grimoire/autopsy";
import type { RuleId } from "@/lib/grimoire/types";
import {
  hasUsableLine,
  receiptCopyValue,
  receiptTarget,
} from "@/lib/ui/signal-groups";

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

/**
 * "full" shows the rule badge and the whole `file:line` receipt.
 * "line" is the compact chip used inside a file row: it shows the line only,
 * and keeps the full receipt in its accessible text, title and copy value.
 */
export type SignalChipVariant = "full" | "line";

export interface SignalChipProps {
  chip: SignalChipType | SignalChipData;
  sha?: string;
  onOpenReceipt?: (chip: SignalChipType | SignalChipData) => void;
  variant?: SignalChipVariant;
}

type CopyStatus = "idle" | "copied" | "failed";

const COPY_STATUS_RESET_MS = 2000;

const COPY_LABELS: Record<CopyStatus, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
};

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="w-3 h-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h6" />
    </svg>
  );
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

export function SignalChip({
  chip,
  sha,
  onOpenReceipt,
  variant = "full",
}: SignalChipProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), COPY_STATUS_RESET_MS);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const ruleId = chip.ruleId || "M1";
  const file = chip.file || "";
  const target = receiptTarget(chip);
  const clipboardPayload = receiptCopyValue(chip);
  const receiptFormatted = chip.receipt?.formatted || `${ruleId} ${target}`;
  const severity = resolveSignalSeverity(ruleId, chip.confidence);
  const styles = SEVERITY_STYLES[severity];
  const isLineVariant = variant === "line";

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyStatus("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(clipboardPayload);
      setCopyStatus("copied");
    } catch {
      // Shown to the user as "Copy failed" plus the live status text below.
      setCopyStatus("failed");
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
      data-chip-variant={variant}
      data-rule-id={ruleId}
      data-target={target}
      data-sha={sha}
      title={receiptFormatted}
      className={`crypt-well inline-flex items-center font-mono text-parchment transition-colors ${
        isLineVariant ? "gap-1 pl-2 pr-1 py-0.5 text-[11px]" : "gap-2 px-2.5 py-1.5 text-xs"
      } ${styles.container}`}
    >
      {/* Rule and file:line receipt */}
      <button
        type="button"
        onClick={handleOpen}
        data-testid="signal-chip-receipt-button"
        className="flex items-center gap-1.5 hover:text-bone cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 rounded"
        title={`View source receipt line ${receiptFormatted}`}
      >
        {isLineVariant ? (
          <span
            data-testid="signal-chip-target"
            className="underline decoration-dotted underline-offset-2 text-bone tabular-nums"
          >
            {/* The full receipt stays in the text; only the line is drawn,
                because the rule and file are shown by the surrounding row. */}
            <span className="sr-only">{`${ruleId} ${file}`}</span>
            {hasUsableLine(chip) ? `:${chip.line}` : ":line not recorded"}
          </span>
        ) : (
          <>
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
          </>
        )}
      </button>

      {/* Copy control (Requirement 5.6) */}
      <button
        type="button"
        onClick={handleCopy}
        data-testid="signal-chip-copy"
        data-clipboard-payload={clipboardPayload}
        data-copy-status={copyStatus}
        className={`rounded bg-neutral-900/90 hover:bg-neutral-800 text-ash hover:text-bone text-[10px] cursor-pointer border border-white/10 hover:border-white/25 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
          isLineVariant ? "inline-flex items-center gap-1 px-1 py-0.5" : "px-1.5 py-0.5"
        }`}
        title={`Copy ${clipboardPayload} to clipboard`}
        aria-label={`Copy ${clipboardPayload} to clipboard`}
      >
        {isLineVariant && copyStatus === "idle" ? <CopyIcon /> : COPY_LABELS[copyStatus]}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copyStatus === "copied"
          ? `Copied ${clipboardPayload}`
          : copyStatus === "failed"
          ? `Could not copy ${clipboardPayload} to the clipboard. The browser did not allow clipboard access.`
          : ""}
      </span>
    </div>
  );
}
