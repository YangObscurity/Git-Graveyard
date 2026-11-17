import React from "react";

export interface StatusPillProps {
  tone: "emerald" | "amber" | "crimson" | "violet" | "neutral";
  pulse?: boolean;
  label: string;
  icon?: React.ReactNode;
  testId?: string;
  uiState?: string;
  className?: string;
}

const TONE_CLASSES: Record<
  StatusPillProps["tone"],
  { pill: string; dot: string }
> = {
  emerald: {
    pill: "bg-emerald-950/50 text-emerald-300 border-[var(--necromancy-emerald-border)] shadow-[0_0_14px_-6px_rgba(16,185,129,0.5)]",
    dot: "bg-emerald-400",
  },
  amber: {
    pill: "bg-amber-950/50 text-amber-300 border-[var(--arcane-amber-border)] shadow-[0_0_14px_-6px_rgba(245,158,11,0.45)]",
    dot: "bg-amber-400",
  },
  crimson: {
    pill: "bg-rose-950/50 text-rose-300 border-[var(--crimson-seal-border)] shadow-[0_0_14px_-6px_rgba(244,63,94,0.45)]",
    dot: "bg-rose-400",
  },
  violet: {
    pill: "bg-violet-950/50 text-violet-300 border-[var(--spectral-violet-border)] shadow-[0_0_14px_-6px_rgba(167,139,250,0.45)]",
    dot: "bg-violet-400",
  },
  neutral: {
    pill: "bg-neutral-900/80 text-neutral-300 border-[var(--border-engraved)]",
    dot: "bg-neutral-400",
  },
};

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export function StatusPill({
  tone,
  pulse = false,
  label,
  icon,
  testId,
  uiState,
  className = "",
}: StatusPillProps) {
  const styles = TONE_CLASSES[tone];
  const resolvedState = uiState ?? toSlug(label);

  return (
    <span
      data-testid={testId}
      data-ui-element="status-pill"
      data-ui-state={resolvedState}
      data-ui-variant={tone}
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] uppercase tracking-wider font-mono font-medium whitespace-nowrap ${styles.pill} ${className}`.trim()}
    >
      {pulse && (
        <span
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full shrink-0 crypt-pulse-emerald ${styles.dot}`}
        />
      )}
      {icon && <span className="inline-flex items-center shrink-0">{icon}</span>}
      <span>{label}</span>
    </span>
  );
}
