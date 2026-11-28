import React from "react";

export type StateFamily = "risen" | "wait" | "fail" | "idle" | "kiro";

export type StateGlyphVariant =
  | "check"
  | "seal"
  | "play"
  | "flame"
  | "hourglass"
  | "eye"
  | "queue"
  | "cross"
  | "seal-broken"
  | "clock"
  | "dash"
  | "dot"
  | "lock"
  | "coffin"
  | "session"
  | "spec"
  | "folder";

export interface StateGlyphProps {
  family: StateFamily;
  variant?: StateGlyphVariant;
  className?: string;
}

const DEFAULT_VARIANT: Record<StateFamily, StateGlyphVariant> = {
  risen: "check",
  wait: "hourglass",
  fail: "cross",
  idle: "dash",
  kiro: "session",
};

const FAMILY_COLOR_CLASS: Record<StateFamily, string> = {
  risen: "text-[var(--state-risen-fg)]",
  wait: "text-[var(--state-wait-fg)]",
  fail: "text-[var(--state-fail-fg)]",
  idle: "text-[var(--state-idle-fg)]",
  kiro: "text-[var(--spectral-violet)]",
};

function renderPaths(variant: StateGlyphVariant): React.ReactNode {
  switch (variant) {
    case "check":
      return <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />;
    case "seal":
      return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M5.75 8.25L7.5 10L10.5 6.25" />
        </>
      );
    case "play":
      return <polygon points="5,3.5 12.5,8 5,12.5" />;
    case "flame":
      return (
        <path d="M8 2C10.5 4.8 12 7 12 9.4C12 11.8 10.2 13.5 8 13.5C5.8 13.5 4 11.8 4 9.4C4 7.7 4.9 6.1 6.2 4.9C6.3 6.2 7 7 7.8 7.3C7.3 5.5 7.5 3.6 8 2Z" />
      );
    case "hourglass":
      return (
        <>
          <path d="M4.5 2.5H11.5" />
          <path d="M4.5 13.5H11.5" />
          <path d="M5.25 2.5V5.25L8 8L10.75 5.25V2.5" />
          <path d="M5.25 13.5V10.75L8 8L10.75 10.75V13.5" />
        </>
      );
    case "eye":
      return (
        <>
          <path d="M2 8C3.8 5 6 3.75 8 3.75C10 3.75 12.2 5 14 8C12.2 11 10 12.25 8 12.25C6 12.25 3.8 11 2 8Z" />
          <circle cx="8" cy="8" r="1.75" />
        </>
      );
    case "queue":
      return (
        <>
          <path d="M3 4.5H13" />
          <path d="M3 8H10.5" />
          <path d="M3 11.5H8" />
          <circle cx="12" cy="11.5" r="1.5" />
        </>
      );
    case "cross":
      return (
        <>
          <path d="M4.25 4.25L11.75 11.75" />
          <path d="M11.75 4.25L4.25 11.75" />
        </>
      );
    case "seal-broken":
      return (
        <>
          <path d="M7 2.6C4.2 3.1 2.2 5.4 2.2 8.2C2.2 11 4.2 13.3 7 13.8" />
          <path d="M9.5 2.6C12.1 3.2 13.8 5.5 13.8 8.2C13.8 10.9 12.1 13.2 9.5 13.8" />
          <path d="M8.25 3.5L7.25 6.5L8.75 9.2L7.75 12.5" />
        </>
      );
    case "clock":
      return (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5V8.25L10.25 9.75" />
        </>
      );
    case "dash":
      return <path d="M4 8H12" />;
    case "dot":
      return <circle cx="8" cy="8" r="2.25" fill="currentColor" stroke="none" />;
    case "lock":
      return (
        <>
          <rect x="3.75" y="7" width="8.5" height="6.25" rx="1.25" />
          <path d="M5.75 7V5.25C5.75 4 6.75 3 8 3C9.25 3 10.25 4 10.25 5.25V7" />
        </>
      );
    case "coffin":
      return (
        <>
          <polygon points="6,2.25 10,2.25 12,6 10.25,13.75 5.75,13.75 4,6" />
          <path d="M8 5V9.5" />
          <path d="M6.5 6.75H9.5" />
        </>
      );
    case "session":
      return (
        <>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="M5 6.5L7 8L5 9.5" />
          <path d="M8.25 9.5H11" />
        </>
      );
    case "spec":
      return (
        <>
          <path d="M4 2.5H9.5L12 5V13.5H4V2.5Z" />
          <path d="M9.5 2.5V5H12" />
          <path d="M6 8H10" />
          <path d="M6 10.5H9" />
        </>
      );
    case "folder":
      return (
        <path d="M2.5 4.5C2.5 3.95 2.95 3.5 3.5 3.5H6.5L7.75 5H12.5C13.05 5 13.5 5.45 13.5 6V11.5C13.5 12.05 13.05 12.5 12.5 12.5H3.5C2.95 12.5 2.5 12.05 2.5 11.5V4.5Z" />
      );
  }
}

export function StateGlyph({
  family,
  variant,
  className = "",
}: StateGlyphProps) {
  const resolvedVariant = variant ?? DEFAULT_VARIANT[family];
  const colorClass = FAMILY_COLOR_CLASS[family];

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-state-family={family}
      data-glyph={resolvedVariant}
      className={`w-3.5 h-3.5 shrink-0 ${colorClass} ${className}`.trim()}
    >
      {renderPaths(resolvedVariant)}
    </svg>
  );
}
