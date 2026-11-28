"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

export type RovingOrientation = "horizontal" | "vertical" | "both";

export interface RovingIndexOptions {
  orientation?: RovingOrientation;
  wrap?: boolean;
}

/**
 * Computes the next active index for a roving-tabindex group given a keyboard key.
 * Returns null when the key is not a navigation key for the configured orientation.
 */
export function getNextRovingIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
  options: RovingIndexOptions = {}
): number | null {
  if (itemCount <= 0) return null;

  const orientation = options.orientation ?? "both";
  const wrap = options.wrap ?? true;
  const clamped =
    currentIndex >= 0 && currentIndex < itemCount ? currentIndex : 0;

  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return itemCount - 1;
  }

  const allowHorizontal = orientation === "horizontal" || orientation === "both";
  const allowVertical = orientation === "vertical" || orientation === "both";

  const isNext =
    (allowHorizontal && key === "ArrowRight") ||
    (allowVertical && key === "ArrowDown");
  const isPrev =
    (allowHorizontal && key === "ArrowLeft") ||
    (allowVertical && key === "ArrowUp");

  if (!isNext && !isPrev) {
    return null;
  }

  if (isNext) {
    if (clamped + 1 < itemCount) return clamped + 1;
    return wrap ? 0 : itemCount - 1;
  }

  if (clamped - 1 >= 0) return clamped - 1;
  return wrap ? itemCount - 1 : 0;
}

/** Returns 0 for the active roving item and -1 for all other items. */
export function getRovingTabIndex(index: number, activeIndex: number): 0 | -1 {
  return index === activeIndex ? 0 : -1;
}

/**
 * Resolves a valid active index from the current active ID, falling back to
 * the selected ID or the first item when the list changes.
 */
export function resolveActiveRovingIndex(
  itemIds: readonly string[],
  activeId: string | null | undefined,
  selectedId?: string | null
): number {
  if (itemIds.length === 0) return -1;
  if (activeId) {
    const idx = itemIds.indexOf(activeId);
    if (idx !== -1) return idx;
  }
  if (selectedId) {
    const idx = itemIds.indexOf(selectedId);
    if (idx !== -1) return idx;
  }
  return 0;
}

export interface UseRovingTabIndexOptions extends RovingIndexOptions {
  selectedId?: string | null;
}

export interface RovingItemProps {
  tabIndex: 0 | -1;
  onFocus: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * React hook managing roving tabindex across a dynamic list of item IDs.
 * Keeps Tab entry/exit clean while Arrow keys, Home, and End move focus.
 */
export function useRovingTabIndex<T extends HTMLElement = HTMLButtonElement>(
  itemIds: readonly string[],
  options: UseRovingTabIndexOptions = {}
) {
  const { selectedId = null, orientation = "both", wrap = true } = options;
  const [activeId, setActiveId] = useState<string | null>(
    () => selectedId ?? itemIds[0] ?? null
  );
  const itemRefs = useRef<Map<string, T>>(new Map());

  const activeIndex = useMemo(
    () => resolveActiveRovingIndex(itemIds, activeId, selectedId),
    [itemIds, activeId, selectedId]
  );

  const resolvedActiveId =
    activeIndex >= 0 && activeIndex < itemIds.length
      ? itemIds[activeIndex]
      : null;

  useEffect(() => {
    if (resolvedActiveId !== activeId) {
      setActiveId(resolvedActiveId);
    }
  }, [resolvedActiveId, activeId]);

  const registerItemRef = useCallback((id: string) => {
    return (el: T | null) => {
      if (el) {
        itemRefs.current.set(id, el);
      } else {
        itemRefs.current.delete(id);
      }
    };
  }, []);

  const focusItemAtIndex = useCallback(
    (nextIndex: number) => {
      const nextId = itemIds[nextIndex];
      if (!nextId) return;
      setActiveId(nextId);
      const target = itemRefs.current.get(nextId);
      if (target && typeof target.focus === "function") {
        target.focus();
      }
    },
    [itemIds]
  );

  const getItemProps = useCallback(
    (id: string, index: number): RovingItemProps => ({
      tabIndex: getRovingTabIndex(index, activeIndex),
      onFocus: () => {
        setActiveId(id);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        const nextIndex = getNextRovingIndex(index, itemIds.length, event.key, {
          orientation,
          wrap,
        });
        if (nextIndex === null) return;
        event.preventDefault();
        focusItemAtIndex(nextIndex);
      },
    }),
    [activeIndex, itemIds.length, orientation, wrap, focusItemAtIndex]
  );

  return {
    activeId: resolvedActiveId,
    activeIndex,
    setActiveId,
    registerItemRef,
    getItemProps,
  };
}
