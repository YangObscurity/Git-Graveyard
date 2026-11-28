"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useShortcutsDisabled } from "@/lib/a11y/shortcuts";

export type AnnouncementPoliteness = "polite" | "assertive";

export type AnnouncementCategory =
  | "state_transition"
  | "fatal_error"
  | "kill_action"
  | "control";

export interface AnnouncementPayload {
  message: string;
  politeness: AnnouncementPoliteness;
  id: number;
}

export const REDUCED_MOTION_STORAGE_KEY =
  "git-graveyard.a11y.reduced-motion";

/**
 * Maps semantic event categories to live-region politeness.
 * Assertive is strictly reserved for fatal run errors and kill actions.
 */
export function resolveAnnouncementPoliteness(
  category: AnnouncementCategory
): AnnouncementPoliteness {
  if (category === "fatal_error" || category === "kill_action") {
    return "assertive";
  }
  return "polite";
}

/**
 * Formats an advance warning notice when a timed control is approaching expiry.
 * Returns null when remainingSeconds is above the warning threshold.
 */
export function formatExpiryAdvanceWarning(
  remainingSeconds: number,
  thresholdSeconds: number = 60,
  controlLabel: string = "Pending control"
): string | null {
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) return null;
  const rounded = Math.ceil(remainingSeconds);
  if (rounded > thresholdSeconds) return null;
  if (rounded === 0) {
    return `${controlLabel} is expiring now.`;
  }
  return `${controlLabel} expires in ${rounded} second${rounded === 1 ? "" : "s"}.`;
}

type AnnouncementSubscriber = (payload: AnnouncementPayload) => void;

const subscribers = new Set<AnnouncementSubscriber>();
let nextAnnouncementId = 1;

function dispatchAnnouncement(
  message: string,
  politeness: AnnouncementPoliteness
): void {
  const clean = message.trim();
  if (!clean) return;
  const payload: AnnouncementPayload = {
    message: clean,
    politeness,
    id: nextAnnouncementId++,
  };
  for (const sub of subscribers) {
    try {
      sub(payload);
    } catch {
      // Never let one listener break announcements
    }
  }
}

/** Announces a non-fatal state transition politely. */
export function announcePolite(message: string): void {
  dispatchAnnouncement(message, "polite");
}

/** Announces a fatal run error or kill action assertively. */
export function announceAssertive(message: string): void {
  dispatchAnnouncement(message, "assertive");
}

/** Routes an announcement using its semantic category. */
export function announceCategory(
  category: AnnouncementCategory,
  message: string
): void {
  dispatchAnnouncement(message, resolveAnnouncementPoliteness(category));
}

export interface AriaAnnouncerContextValue {
  politeMessage: string;
  assertiveMessage: string;
  announcePolite: (message: string) => void;
  announceAssertive: (message: string) => void;
  announceCategory: (category: AnnouncementCategory, message: string) => void;
}

const AriaAnnouncerContext = createContext<AriaAnnouncerContextValue>({
  politeMessage: "",
  assertiveMessage: "",
  announcePolite,
  announceAssertive,
  announceCategory,
});

export function useAriaAnnouncer(): AriaAnnouncerContextValue {
  return useContext(AriaAnnouncerContext);
}

export function AriaAnnouncerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler: AnnouncementSubscriber = (payload) => {
      if (payload.politeness === "assertive") {
        setAssertiveMessage("");
        setTimeout(() => setAssertiveMessage(payload.message), 10);
      } else {
        setPoliteMessage("");
        setTimeout(() => setPoliteMessage(payload.message), 10);
      }

      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        setPoliteMessage("");
        setAssertiveMessage("");
      }, 6000);
    };

    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  const value: AriaAnnouncerContextValue = {
    politeMessage,
    assertiveMessage,
    announcePolite,
    announceAssertive,
    announceCategory,
  };

  return (
    <AriaAnnouncerContext.Provider value={value}>
      {children}
    </AriaAnnouncerContext.Provider>
  );
}

export interface AriaAnnouncerProps {
  /** Optional static messages for deterministic SSR / unit tests. */
  politeMessage?: string;
  assertiveMessage?: string;
}

/**
 * Exposes separate polite (non-fatal state transitions) and assertive (fatal
 * run errors and kill actions) live regions. Ticking timers and counters must
 * never be rendered inside these regions.
 */
export function AriaAnnouncer({
  politeMessage: propPolite,
  assertiveMessage: propAssertive,
}: AriaAnnouncerProps = {}) {
  const ctx = useAriaAnnouncer();
  const polite = propPolite ?? ctx.politeMessage;
  const assertive = propAssertive ?? ctx.assertiveMessage;

  return (
    <div data-testid="aria-announcer" className="sr-only">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="aria-announcer-polite"
      >
        {polite}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="aria-announcer-assertive"
      >
        {assertive}
      </div>
    </div>
  );
}

function readReducedMotionPreference(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.getAttribute("data-ui-reduced-motion") === "true") {
    return true;
  }
  try {
    return window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function applyReducedMotionPreference(enabled: boolean): void {
  if (typeof document !== "undefined") {
    if (enabled) {
      document.documentElement.setAttribute("data-ui-reduced-motion", "true");
    } else {
      document.documentElement.removeAttribute("data-ui-reduced-motion");
    }
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        REDUCED_MOTION_STORAGE_KEY,
        enabled ? "true" : "false"
      );
    } catch {
      // Ignore storage failures
    }
  }
}

/**
 * Persistent global accessibility controls mounted in the layout's
 * complementary landmark: reduced motion override, disableable global keyboard
 * shortcuts toggle, and the live AriaAnnouncer regions.
 */
export function AccessibilityControls() {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [shortcutsDisabled, , toggleShortcuts] = useShortcutsDisabled();

  useEffect(() => {
    const initial = readReducedMotionPreference();
    setReducedMotion(initial);
    if (initial) {
      applyReducedMotionPreference(true);
    }

    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(() => {
      const attrVal =
        document.documentElement.getAttribute("data-ui-reduced-motion") === "true";
      setReducedMotion(attrVal);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-ui-reduced-motion"],
    });
    return () => observer.disconnect();
  }, []);

  const handleToggleReducedMotion = useCallback(() => {
    const next = !reducedMotion;
    setReducedMotion(next);
    applyReducedMotionPreference(next);
    announcePolite(
      next ? "Reduced motion enabled." : "Reduced motion disabled."
    );
  }, [reducedMotion]);

  const handleToggleShortcuts = useCallback(() => {
    const nextDisabled = !shortcutsDisabled;
    toggleShortcuts();
    announcePolite(
      nextDisabled
        ? "Global keyboard shortcuts disabled."
        : "Global keyboard shortcuts enabled."
    );
  }, [shortcutsDisabled, toggleShortcuts]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-parchment">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ash uppercase tracking-wider text-[11px]">
          Accessibility:
        </span>
        <button
          type="button"
          data-testid="a11y-reduced-motion-toggle"
          aria-pressed={reducedMotion}
          onClick={handleToggleReducedMotion}
          className="crypt-btn-ghost px-2.5 py-1 rounded text-xs"
        >
          {reducedMotion ? "Reduced motion: On" : "Reduced motion: Off"}
        </button>
        <button
          type="button"
          data-testid="a11y-shortcuts-toggle"
          aria-pressed={shortcutsDisabled}
          onClick={handleToggleShortcuts}
          className="crypt-btn-ghost px-2.5 py-1 rounded text-xs"
        >
          {shortcutsDisabled
            ? "Keyboard shortcuts: Off"
            : "Keyboard shortcuts: On"}
        </button>
      </div>
      <AriaAnnouncer />
    </div>
  );
}

export default AriaAnnouncer;
