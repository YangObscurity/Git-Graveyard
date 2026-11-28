"use client";

import { useEffect, useState } from "react";

export const SHORTCUTS_DISABLED_STORAGE_KEY =
  "git-graveyard.a11y.shortcuts-disabled";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface KeyboardEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | {
    tagName?: string;
    isContentEditable?: boolean;
  } | null;
  preventDefault?: () => void;
}

export interface ShortcutBinding {
  id: string;
  key: string;
  code?: string;
  description: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  allowInInput?: boolean;
  handler: (event: KeyboardEventLike) => void;
}

type PreferenceListener = (disabled: boolean) => void;

const preferenceListeners = new Set<PreferenceListener>();
let inMemoryDisabledFallback = false;

function resolveStorage(explicit?: StorageLike | null): StorageLike | null {
  if (explicit !== undefined) return explicit;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function syncDocumentShortcutAttribute(disabled: boolean): void {
  if (typeof document === "undefined") return;
  try {
    if (disabled) {
      document.documentElement.setAttribute(
        "data-a11y-shortcuts-disabled",
        "true"
      );
    } else {
      document.documentElement.removeAttribute("data-a11y-shortcuts-disabled");
    }
  } catch {
    // Ignore DOM errors in restricted contexts
  }
}

function notifyPreferenceListeners(disabled: boolean): void {
  for (const listener of preferenceListeners) {
    try {
      listener(disabled);
    } catch {
      // Keep other subscribers unaffected
    }
  }
}

/** Reads whether global/single-key keyboard shortcuts are currently disabled. */
export function isShortcutsDisabled(storage?: StorageLike | null): boolean {
  const store = resolveStorage(storage);
  if (!store) return inMemoryDisabledFallback;
  try {
    return store.getItem(SHORTCUTS_DISABLED_STORAGE_KEY) === "true";
  } catch {
    return inMemoryDisabledFallback;
  }
}

/** Convenience inverse of isShortcutsDisabled. */
export function areShortcutsEnabled(storage?: StorageLike | null): boolean {
  return !isShortcutsDisabled(storage);
}

/** Persists the user's keyboard-shortcuts disabled state and notifies listeners. */
export function setShortcutsDisabled(
  disabled: boolean,
  storage?: StorageLike | null
): boolean {
  inMemoryDisabledFallback = disabled;
  const store = resolveStorage(storage);
  if (store) {
    try {
      store.setItem(SHORTCUTS_DISABLED_STORAGE_KEY, disabled ? "true" : "false");
    } catch {
      // Fall back to in-memory preference when storage is blocked
    }
  }
  syncDocumentShortcutAttribute(disabled);
  notifyPreferenceListeners(disabled);
  return disabled;
}

/** Toggles and persists the keyboard-shortcuts disabled state. */
export function toggleShortcutsDisabled(
  storage?: StorageLike | null
): boolean {
  const next = !isShortcutsDisabled(storage);
  return setShortcutsDisabled(next, storage);
}

/** Subscribes to changes in the keyboard-shortcuts disabled preference. */
export function subscribeShortcutsPreference(
  listener: PreferenceListener
): () => void {
  preferenceListeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      preferenceListeners.delete(listener);
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === SHORTCUTS_DISABLED_STORAGE_KEY) {
      const disabled = event.newValue === "true";
      inMemoryDisabledFallback = disabled;
      syncDocumentShortcutAttribute(disabled);
      listener(disabled);
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    preferenceListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function isEditableTarget(target: KeyboardEventLike["target"]): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function isInteractiveActivationTarget(
  target: KeyboardEventLike["target"],
  event: KeyboardEventLike
): boolean {
  if (!target || typeof target !== "object") return false;
  const tag = ((target as { tagName?: string }).tagName || "").toUpperCase();
  if (tag !== "BUTTON" && tag !== "A" && tag !== "SUMMARY") return false;
  return (
    event.code === "Space" ||
    event.key === " " ||
    event.key === "Enter" ||
    event.code === "Enter"
  );
}

function matchesBinding(
  binding: ShortcutBinding,
  event: KeyboardEventLike
): boolean {
  if (Boolean(binding.ctrlKey) !== Boolean(event.ctrlKey)) return false;
  if (Boolean(binding.metaKey) !== Boolean(event.metaKey)) return false;
  if (Boolean(binding.altKey) !== Boolean(event.altKey)) return false;
  if (
    binding.shiftKey !== undefined &&
    Boolean(binding.shiftKey) !== Boolean(event.shiftKey)
  ) {
    return false;
  }
  if (binding.code && event.code) {
    return binding.code === event.code;
  }
  return binding.key.toLowerCase() === event.key.toLowerCase();
}

export interface ShortcutManager {
  register: (binding: ShortcutBinding) => () => void;
  unregister: (id: string) => void;
  list: () => readonly ShortcutBinding[];
  isDisabled: () => boolean;
  setDisabled: (disabled: boolean) => boolean;
  toggle: () => boolean;
  handleKeyDown: (event: KeyboardEventLike) => boolean;
}

/**
 * Creates a keyboard shortcut manager that respects the persistent disable
 * setting and skips editable inputs or native button activations.
 */
export function createShortcutManager(options?: {
  storage?: StorageLike | null;
}): ShortcutManager {
  const bindings = new Map<string, ShortcutBinding>();
  const storage = options?.storage;

  return {
    register(binding) {
      bindings.set(binding.id, binding);
      return () => {
        bindings.delete(binding.id);
      };
    },
    unregister(id) {
      bindings.delete(id);
    },
    list() {
      return Array.from(bindings.values());
    },
    isDisabled() {
      return isShortcutsDisabled(storage);
    },
    setDisabled(disabled) {
      return setShortcutsDisabled(disabled, storage);
    },
    toggle() {
      return toggleShortcutsDisabled(storage);
    },
    handleKeyDown(event) {
      if (event.defaultPrevented) return false;
      if (isShortcutsDisabled(storage)) return false;
      if (isInteractiveActivationTarget(event.target, event)) return false;

      const editable = isEditableTarget(event.target);
      for (const binding of bindings.values()) {
        if (editable && !binding.allowInInput) continue;
        if (!matchesBinding(binding, event)) continue;
        event.preventDefault?.();
        binding.handler(event);
        return true;
      }
      return false;
    },
  };
}

export const globalShortcutManager = createShortcutManager();

/** React hook returning `[shortcutsDisabled, setDisabled, toggle]` synced with storage. */
export function useShortcutsDisabled(): [
  boolean,
  (disabled: boolean) => void,
  () => void,
] {
  const [disabled, setDisabledState] = useState<boolean>(false);

  useEffect(() => {
    const initial = isShortcutsDisabled();
    setDisabledState(initial);
    syncDocumentShortcutAttribute(initial);
    return subscribeShortcutsPreference((next) => {
      setDisabledState(next);
    });
  }, []);

  const setDisabled = (next: boolean) => {
    setShortcutsDisabled(next);
  };

  const toggle = () => {
    toggleShortcutsDisabled();
  };

  return [disabled, setDisabled, toggle];
}

/** Registers a global keyboard shortcut while mounted, respecting the disable toggle. */
export function useGlobalShortcut(
  binding: ShortcutBinding | null,
  deps: readonly unknown[] = []
): void {
  useEffect(() => {
    if (!binding || typeof window === "undefined") return;
    const unregister = globalShortcutManager.register(binding);
    const onKeyDown = (event: KeyboardEvent) => {
      // Dispatch only this binding via manager-style checks if caller invokes standalone.
      if (event.defaultPrevented) return;
      if (isShortcutsDisabled()) return;
      if (isInteractiveActivationTarget(event.target, event)) return;
      if (isEditableTarget(event.target) && !binding.allowInInput) return;
      if (!matchesBinding(binding, event)) return;
      event.preventDefault();
      binding.handler(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding?.id, binding?.key, binding?.code, ...deps]);
}
