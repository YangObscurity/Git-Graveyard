import React from "react";

export interface CryptOrnamentProps {
  kind:
    | "arch-sigil"
    | "tomb-arch"
    | "wax-seal"
    | "skeleton-skull"
    | "divider"
    | "corner-ticks";
  className?: string;
}

export function CryptOrnament({ kind, className = "" }: CryptOrnamentProps) {
  if (kind === "arch-sigil") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`w-5 h-5 shrink-0 ${className}`.trim()}
      >
        <path d="M4 21V11C4 6 12 2 12 2C12 2 20 6 20 11V21" />
        <path d="M12 7V17" />
        <path d="M9 11H15" />
        <path d="M2 21H22" />
      </svg>
    );
  }

  if (kind === "tomb-arch") {
    return (
      <svg
        viewBox="0 0 120 36"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`w-28 h-9 shrink-0 ${className}`.trim()}
      >
        <path d="M6 34H114" className="opacity-60" />
        <path d="M14 34V24C14 14 60 3 60 3C60 3 106 14 106 24V34" />
        <path
          d="M22 34V25C22 17.5 60 8 60 8C60 8 98 17.5 98 25V34"
          className="opacity-45"
        />
        <path d="M60 11L64 15L60 19L56 15Z" />
        <path d="M60 19V30" className="opacity-70" />
      </svg>
    );
  }

  if (kind === "wax-seal") {
    return (
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`w-7 h-7 shrink-0 ${className}`.trim()}
      >
        <polygon points="11,3 21,3 29,11 29,21 21,29 11,29 3,21 3,11" />
        <circle cx="16" cy="16" r="8.5" className="opacity-70" />
        <path d="M16 10.5L19.5 16L16 21.5L12.5 16Z" />
        <path d="M10.5 16H21.5" className="opacity-55" />
      </svg>
    );
  }

  if (kind === "skeleton-skull") {
    return (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`w-4 h-4 shrink-0 ${className}`.trim()}
      >
        <path d="M5 13V9.5C5 5.8 7.2 3.5 10 3.5C12.8 3.5 15 5.8 15 9.5V13L13.5 14.5V17H6.5V14.5L5 13Z" />
        <circle cx="8" cy="10" r="1.15" />
        <circle cx="12" cy="10" r="1.15" />
        <path d="M10 12V13.5" />
        <path d="M8.5 15.2V17M11.5 15.2V17" className="opacity-70" />
      </svg>
    );
  }

  if (kind === "corner-ticks") {
    return (
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 w-full h-full ${className}`.trim()}
      >
        <span className="absolute top-0 left-0 w-2 h-2 border-t border-l border-current/45 rounded-tl-[2px]" />
        <span className="absolute top-0 right-0 w-2 h-2 border-t border-r border-current/45 rounded-tr-[2px]" />
        <span className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-current/45 rounded-bl-[2px]" />
        <span className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-current/45 rounded-br-[2px]" />
      </span>
    );
  }

  // kind === "divider"
  return (
    <div
      aria-hidden="true"
      className={`flex items-center gap-3 w-full text-neutral-600 ${className}`.trim()}
    >
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-neutral-700/70 to-transparent" />
      <span className="w-1.5 h-1.5 rotate-45 border border-current/70 bg-current/20 shrink-0" />
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-neutral-700/70 to-transparent" />
    </div>
  );
}
