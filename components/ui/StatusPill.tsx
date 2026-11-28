import React from "react";
import { StateGlyph, type StateFamily } from "./StateGlyph";

export interface StatusPillProps {
  tone: "emerald" | "amber" | "crimson" | "violet" | "neutral";
  pulse?: boolean;
  label: string;
  icon?: React.ReactNode;
  testId?: string;
  uiState?: string;
  className?: string;
}

const TONE_TO_FAMILY: Record<StatusPillProps["tone"], StateFamily> = {
  emerald: "risen",
  amber: "wait",
  crimson: "fail",
  violet: "kiro",
  neutral: "idle",
};

const TONE_CLASSES: Record<
  StatusPillProps["tone"],
  { pill: string; dot: string }
> = {
  emerald: {
    pill: "crypt-tag crypt-tag--risen",
    dot: "bg-[var(--state-risen-fg)]",
  },
  amber: {
    pill: "crypt-tag crypt-tag--wait",
    dot: "bg-[var(--state-wait-fg)]",
  },
  crimson: {
    pill: "crypt-tag crypt-tag--fail",
    dot: "bg-[var(--state-fail-fg)]",
  },
  violet: {
    pill: "crypt-kiro",
    dot: "bg-[var(--spectral-violet)]",
  },
  neutral: {
    pill: "crypt-tag crypt-tag--idle",
    dot: "bg-[var(--state-idle-fg)]",
  },
};

function toSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
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
  const family = TONE_TO_FAMILY[tone];
  const resolvedState = uiState ?? toSlug(label);

  return (
    <span
      data-testid={testId}
      data-ui-element="status-pill"
      data-ui-state={resolvedState}
      data-ui-variant={tone}
      data-state-family={family}
      className={`${styles.pill} ${className}`.trim()}
    >
      {pulse && (
        <span
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full shrink-0 crypt-pulse-emerald ${styles.dot}`}
        />
      )}
      <span aria-hidden="true" className="inline-flex items-center shrink-0">
        {icon ?? <StateGlyph family={family} />}
      </span>
      <span>{label}</span>
    </span>
  );
}
