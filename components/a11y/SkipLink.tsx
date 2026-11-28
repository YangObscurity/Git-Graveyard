"use client";

import React, { useEffect, useState } from "react";

export const DEFAULT_NEEDS_YOU_ANCHOR_ID = "needs-you-slot";
export const DEFAULT_MAIN_ANCHOR_ID = "main-content";

export interface SkipLinkProps {
  /** Anchor ID for the Needs-you action slot. Defaults to "needs-you-slot". */
  needsYouAnchorId?: string;
  /** Fallback anchor ID when the Needs-you slot is absent. Defaults to "main-content". */
  fallbackAnchorId?: string;
  /** Optional explicit override for SSR or deterministic unit tests. */
  hasNeedsYou?: boolean;
  className?: string;
}

export interface SkipLinkTarget {
  href: string;
  label: string;
  targetId: string;
}

/**
 * Resolves the skip-link destination: points to the Needs-you action slot when
 * present, falling back cleanly to the main content landmark otherwise.
 */
export function resolveSkipLinkTarget(
  hasNeedsYou: boolean,
  needsYouAnchorId: string = DEFAULT_NEEDS_YOU_ANCHOR_ID,
  fallbackAnchorId: string = DEFAULT_MAIN_ANCHOR_ID
): SkipLinkTarget {
  if (hasNeedsYou) {
    return {
      href: `#${needsYouAnchorId}`,
      label: "Skip to actions needing you",
      targetId: needsYouAnchorId,
    };
  }
  return {
    href: `#${fallbackAnchorId}`,
    label: "Skip to main content",
    targetId: fallbackAnchorId,
  };
}

/**
 * Keyboard-accessible skip link pointing to the Needs-you action slot when
 * present and falling back gracefully to #main-content when absent.
 */
export function SkipLink({
  needsYouAnchorId = DEFAULT_NEEDS_YOU_ANCHOR_ID,
  fallbackAnchorId = DEFAULT_MAIN_ANCHOR_ID,
  hasNeedsYou: explicitHasNeedsYou,
  className = "",
}: SkipLinkProps) {
  const [detectedNeedsYou, setDetectedNeedsYou] = useState<boolean>(false);

  useEffect(() => {
    if (explicitHasNeedsYou !== undefined || typeof document === "undefined") {
      return;
    }

    const checkSlot = () => {
      setDetectedNeedsYou(Boolean(document.getElementById(needsYouAnchorId)));
    };

    checkSlot();

    if (typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(checkSlot);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["id"],
    });

    return () => observer.disconnect();
  }, [explicitHasNeedsYou, needsYouAnchorId]);

  const hasNeedsYou = explicitHasNeedsYou ?? detectedNeedsYou;
  const target = resolveSkipLinkTarget(
    hasNeedsYou,
    needsYouAnchorId,
    fallbackAnchorId
  );

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (typeof document === "undefined") return;
    const el =
      document.getElementById(target.targetId) ??
      document.getElementById(fallbackAnchorId) ??
      document.querySelector("main");

    if (el instanceof HTMLElement) {
      event.preventDefault();
      if (!el.hasAttribute("tabindex")) {
        el.setAttribute("tabindex", "-1");
      }
      el.focus({ preventScroll: false });
      el.scrollIntoView?.({ block: "start" });
    }
  };

  return (
    <a
      href={target.href}
      onClick={handleClick}
      data-testid="a11y-skip-link"
      data-skip-target={target.targetId}
      className={`a11y-skip-link ${className}`.trim()}
    >
      {target.label}
    </a>
  );
}

export default SkipLink;
