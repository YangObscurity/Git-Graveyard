import React from "react";

export interface CryptOrnamentProps {
  kind:
    | "arch-sigil"
    | "tomb-arch"
    | "wax-seal"
    | "skeleton-skull"
    | "divider"
    | "corner-ticks"
    | "candle";
  className?: string;
  lit?: boolean;
  flicker?: boolean;
  igniting?: boolean;
  size?: "sm" | "md" | "hero";
  sealed?: boolean;
  sealState?: "sealed" | "unsealing" | "sealing" | "open";
}

export function CryptOrnament({
  kind,
  className = "",
  lit = true,
  flicker = false,
  igniting = false,
  size = "md",
  sealed = true,
  sealState,
}: CryptOrnamentProps) {
  if (kind === "candle") {
    const sizeClass =
      size === "sm"
        ? "crypt-candle--sm"
        : size === "hero"
        ? "crypt-candle--hero"
        : "";
    const motionClass = [
      flicker ? "is-flicker" : "",
      igniting ? "is-igniting" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <svg
        viewBox="0 0 22 30"
        fill="none"
        aria-hidden="true"
        data-lit={lit ? "true" : "false"}
        className={`crypt-candle shrink-0 ${sizeClass} ${motionClass} ${className}`.trim()}
      >
        <ellipse className="halo" cx="11" cy="7.5" rx="6.5" ry="5.5" />
        <path
          className="flame"
          d="M11 2C13.2 4.8 14 7.2 14 9C14 10.65 12.66 12 11 12C9.34 12 8 10.65 8 9C8 7.2 8.8 4.8 11 2Z"
        />
        <path
          className="flame-core"
          d="M11 5.2C12 6.8 12.3 8 12.3 9.1C12.3 10 11.72 10.7 11 10.7C10.28 10.7 9.7 10 9.7 9.1C9.7 8 10 6.8 11 5.2Z"
        />
        <line className="wick" x1="11" y1="11.5" x2="11" y2="14.5" />
        <rect className="wax" x="7" y="14" width="8" height="14" rx="1.5" />
        <rect className="wax-shade" x="12" y="14" width="3" height="14" rx="1" />
      </svg>
    );
  }

  if (kind === "arch-sigil") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`w-5 h-5 shrink-0 ${className}`.trim()}
      >
        <path d="M5 21V11.5C5 7 12 2.5 12 2.5C12 2.5 19 7 19 11.5V21" />
        <path d="M8 21V12.5C8 9.2 12 6 12 6C12 6 16 9.2 16 12.5V21" className="opacity-55" />
        <path d="M12 8.5V17.5" />
        <path d="M9.5 12H14.5" />
        <path d="M2.5 21H21.5" />
      </svg>
    );
  }

  if (kind === "tomb-arch") {
    return (
      <svg
        viewBox="0 0 120 36"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.35}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`w-28 h-9 shrink-0 ${className}`.trim()}
      >
        <path d="M6 34H114" className="opacity-65" />
        <path d="M14 34V24C14 14 60 3 60 3C60 3 106 14 106 24V34" />
        <path
          d="M24 34V25C24 17.5 60 8 60 8C60 8 96 17.5 96 25V34"
          className="opacity-45"
        />
        <path d="M60 11L64 15L60 19L56 15Z" />
        <path d="M60 19V30" className="opacity-70" />
      </svg>
    );
  }

  if (kind === "wax-seal") {
    const isSealed = sealState ? sealState === "sealed" || sealState === "sealing" : sealed;
    const sealMotion =
      sealState === "unsealing"
        ? "is-unsealing"
        : sealState === "sealing"
        ? "is-sealing"
        : "";

    return (
      <svg
        viewBox="0 0 40 40"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        data-sealed={isSealed ? "true" : "false"}
        className={`crypt-seal w-7 h-7 shrink-0 ${sealMotion} ${className}`.trim()}
      >
        <g className="half half-l">
          <path d="M20 4L13.5 5.5L8 10L5.5 16.5V23.5L8 30L13.5 34.5L20 36" />
          <path d="M20 9.5A10.5 10.5 0 0 0 20 30.5" className="opacity-70" />
          <path d="M20 13.5L15 20L20 26.5" />
          <path d="M13 20H19" className="opacity-55" />
        </g>
        <g className="half half-r">
          <path d="M20 4L26.5 5.5L32 10L34.5 16.5V23.5L32 30L26.5 34.5L20 36" />
          <path d="M20 9.5A10.5 10.5 0 0 1 20 30.5" className="opacity-70" />
          <path d="M20 13.5L25 20L20 26.5" />
          <path d="M21 20H27" className="opacity-55" />
        </g>
      </svg>
    );
  }

  if (kind === "skeleton-skull") {
    return (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.35}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`w-4 h-4 shrink-0 ${className}`.trim()}
      >
        <path d="M4.5 12.5V9C4.5 5.4 6.9 3 10 3C13.1 3 15.5 5.4 15.5 9V12.5L13.75 14.25V17H6.25V14.25L4.5 12.5Z" />
        <circle cx="7.75" cy="9.5" r="1.2" />
        <circle cx="12.25" cy="9.5" r="1.2" />
        <path d="M10 11.75L9.25 13.25H10.75L10 11.75Z" />
        <path d="M8.25 15V17M10 15V17M11.75 15V17" className="opacity-70" />
      </svg>
    );
  }

  if (kind === "corner-ticks") {
    return (
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 w-full h-full ${className}`.trim()}
      >
        <span className="absolute top-0 left-0 w-2.5 h-2.5 border-t border-l border-current/55" />
        <span className="absolute top-0 right-0 w-2.5 h-2.5 border-t border-r border-current/55" />
        <span className="absolute bottom-0 left-0 w-2.5 h-2.5 border-b border-l border-current/55" />
        <span className="absolute bottom-0 right-0 w-2.5 h-2.5 border-b border-r border-current/55" />
      </span>
    );
  }

  // kind === "divider"
  return (
    <div
      aria-hidden="true"
      className={`flex items-center gap-3 w-full text-[var(--fg-ash)] ${className}`.trim()}
    >
      <span className="h-px flex-1 bg-[var(--border-hairline)]" />
      <span className="w-1.5 h-1.5 rotate-45 border border-[var(--border-engraved)] bg-[var(--bg-slab)] shrink-0" />
      <span className="h-px flex-1 bg-[var(--border-hairline)]" />
    </div>
  );
}
