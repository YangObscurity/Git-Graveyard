"use client";

import React, { useCallback, useEffect, useRef } from "react";

export interface LayToRestModalProps {
  /** Skeleton being laid to rest, shown in the heading for context. */
  skeletonId: string;
  /** Role of the Skeleton (e.g. "bonesetter"); optional, for the subtitle. */
  role?: string;
  /** Keep the Skeleton's commits and abandon the task. */
  onKeep: () => void;
  /** Discard the Skeleton's work entirely. */
  onDiscard: () => void;
  /** Close the modal without laying the Skeleton to rest. */
  onCancel: () => void;
}

/** Selector matching every control that can receive keyboard focus inside a dialog. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Returns the focusable controls inside a container, in DOM order. */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true"
  );
}

/** Moves focus to the first focusable control in the container, if any. */
export function focusFirstElement(container: HTMLElement | null): void {
  const first = getFocusableElements(container)[0];
  if (first) first.focus();
}

/**
 * Confirmation dialog for laying a Skeleton to rest. The user must choose what
 * happens to the Skeleton's work (keep its commits or discard it) or cancel.
 * The choices map straight to the two recorded lay-to-rest outcomes.
 */
export function LayToRestModal({
  skeletonId,
  role,
  onKeep,
  onDiscard,
  onCancel,
}: LayToRestModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Move focus into the dialog on open and return it to the previous element on close.
  useEffect(() => {
    restoreFocusRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    focusFirstElement(dialogRef.current);
    return () => {
      const previous = restoreFocusRef.current;
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      cancelRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getFocusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return (
    <div
      ref={dialogRef}
      onKeyDown={handleKeyDown}
      data-testid="lay-to-rest-modal"
      data-ui-element="lay-to-rest-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lay-to-rest-title"
      className="crypt-panel border-rose-500/45 bg-rose-950/30 p-4 space-y-3"
    >
      <div className="space-y-1">
        <h3
          id="lay-to-rest-title"
          className="text-sm font-bold text-rose-200 uppercase tracking-wider"
        >
          Lay this Skeleton to rest?
        </h3>
        <p className="text-xs text-parchment">
          {role ? `${role} ` : "Skeleton "}
          {skeletonId} will stop and its task will become abandoned. Choose what
          to do with its work.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="lay-to-rest-keep"
          onClick={onKeep}
          className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
        >
          Keep its commits
        </button>
        <button
          type="button"
          data-testid="lay-to-rest-discard"
          onClick={onDiscard}
          className="crypt-btn-danger px-3 py-1.5 text-xs rounded"
        >
          Discard its work
        </button>
        <button
          type="button"
          data-testid="lay-to-rest-cancel"
          onClick={onCancel}
          className="crypt-btn-ghost px-3 py-1.5 text-xs rounded text-ash"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default LayToRestModal;