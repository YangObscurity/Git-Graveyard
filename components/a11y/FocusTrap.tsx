"use client";

import React, { useCallback, useEffect, useRef } from "react";

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Returns focusable elements inside `container` in DOM order. */
export function getFocusableElements(
  container: HTMLElement | null
): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      !el.hidden
  );
}

/**
 * Computes the element that should receive focus when Tab or Shift+Tab wraps
 * at the boundary of `focusables`, or null if normal browser traversal applies.
 */
export function getNextFocusTarget(
  focusables: readonly HTMLElement[],
  currentActive: Element | null,
  shiftKey: boolean
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (shiftKey && currentActive === first) {
    return last;
  }
  if (!shiftKey && currentActive === last) {
    return first;
  }
  if (!currentActive || !focusables.includes(currentActive as HTMLElement)) {
    return shiftKey ? last : first;
  }
  return null;
}

export interface FocusTrapProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Whether the focus trap is currently active. Defaults to true. */
  active?: boolean;
  /** Invoked when the user presses Escape while the dialog is active. */
  onEscape?: () => void;
  /** Whether focus should be restored to the opener when closed. Defaults to true. */
  restoreFocus?: boolean;
  /** Optional element to focus initially when activated. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Optional explicit element to restore focus to upon dismissal. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Dialog ARIA role. Defaults to "dialog". */
  role?: "dialog" | "alertdialog";
  /** Sets aria-modal on the container. Defaults to true. */
  ariaModal?: boolean;
  children: React.ReactNode;
}

/**
 * Reusable modal FocusTrap trapping Tab/Shift+Tab inside `role="dialog"` /
 * `aria-modal="true"`, supporting Escape dismissal, and restoring focus to the
 * opener element when closed.
 */
export function FocusTrap({
  active = true,
  onEscape,
  restoreFocus = true,
  initialFocusRef,
  returnFocusRef,
  role = "dialog",
  ariaModal = true,
  className = "",
  onKeyDown,
  children,
  ...rest
}: FocusTrapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active || typeof document === "undefined") return;

    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const initialTarget =
      initialFocusRef?.current ??
      getFocusableElements(containerRef.current)[0] ??
      containerRef.current;

    if (initialTarget && typeof initialTarget.focus === "function") {
      initialTarget.focus();
    }

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscapeRef.current?.();
      }
    };

    document.addEventListener("keydown", onDocumentKeyDown);

    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown);
      if (!restoreFocus) return;
      const target = returnFocusRef?.current ?? openerRef.current;
      if (
        target &&
        typeof target.focus === "function" &&
        (typeof target.isConnected !== "boolean" || target.isConnected)
      ) {
        target.focus();
      }
    };
  }, [active, restoreFocus, initialFocusRef, returnFocusRef]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (!active || event.defaultPrevented) return;

      if (event.key === "Escape") {
        event.stopPropagation();
        onEscapeRef.current?.();
        return;
      }

      if (event.key !== "Tab") return;

      const focusables = getFocusableElements(containerRef.current);
      if (focusables.length === 0) {
        event.preventDefault();
        containerRef.current?.focus();
        return;
      }

      const activeEl =
        typeof document !== "undefined" ? document.activeElement : null;
      const wrapTarget = getNextFocusTarget(
        focusables,
        activeEl,
        event.shiftKey
      );
      if (wrapTarget) {
        event.preventDefault();
        wrapTarget.focus();
      }
    },
    [active, onKeyDown]
  );

  return (
    <div
      {...rest}
      ref={containerRef}
      role={role}
      aria-modal={ariaModal ? "true" : undefined}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={className}
    >
      {children}
    </div>
  );
}

export default FocusTrap;
