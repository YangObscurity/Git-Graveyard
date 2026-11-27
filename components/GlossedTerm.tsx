"use client";

/**
 * Plain-English glosses for gothic terms on first appearance (Requirement 47.4).
 *
 * `GlossProvider` tracks which terms have already been shown in a rendered tree;
 * `GlossedTerm` renders the term with an accessible inline/title/abbr gloss the
 * first time it appears and as plain text afterwards. Both work standalone during
 * SSR (no provider) and inside a provider.
 */
import React, { createContext, useContext } from "react";
import { glossary } from "@/lib/copy/glossary";

export type GothicTerm = keyof typeof glossary;

interface GlossContextValue {
  /** Terms already glossed in this tree. */
  readonly seen: Set<string>;
}

const GlossContext = createContext<GlossContextValue | null>(null);

export interface GlossProviderProps {
  children: React.ReactNode;
}

/**
 * Tracks seen terms for its subtree. A fresh `Set` is created per provider
 * instance so each rendered tree glosses each term exactly once.
 */
export function GlossProvider({ children }: GlossProviderProps) {
  // A ref-backed Set keeps the same identity across re-renders of the provider.
  const seenRef = React.useRef<Set<string> | null>(null);
  if (seenRef.current === null) {
    seenRef.current = new Set<string>();
  }
  const value = React.useMemo<GlossContextValue>(() => ({ seen: seenRef.current as Set<string> }), []);
  return <GlossContext.Provider value={value}>{children}</GlossContext.Provider>;
}

export interface GlossedTermProps {
  /** The gothic term to gloss. */
  term: GothicTerm;
  /** Optional visible override for the term text. */
  children?: React.ReactNode;
  /** Extra class name for the wrapping element. */
  className?: string;
  /** When true (default) the gloss shows only on first appearance per tree. */
  showOnce?: boolean;
}

/**
 * Render a gothic term with an accessible gloss on first appearance. Without a
 * provider (standalone SSR) every render is treated as a first appearance.
 */
export function GlossedTerm({
  term,
  children,
  className,
  showOnce = true,
}: GlossedTermProps) {
  const context = useContext(GlossContext);
  const definition = glossary[term];
  const visible = children ?? term;

  const decisionRef = React.useRef<{
    term: GothicTerm;
    showOnce: boolean;
    context: GlossContextValue | null;
    isFirst: boolean;
  } | null>(null);

  if (
    decisionRef.current === null ||
    decisionRef.current.term !== term ||
    decisionRef.current.showOnce !== showOnce ||
    decisionRef.current.context !== context
  ) {
    let isFirst = true;
    if (showOnce && context) {
      isFirst = !context.seen.has(term);
      if (isFirst) {
        context.seen.add(term);
      }
    }
    decisionRef.current = { term, showOnce, context, isFirst };
  }
  const isFirstAppearance = decisionRef.current.isFirst;

  if (!isFirstAppearance) {
    return <span className={className}>{visible}</span>;
  }

  return (
    <abbr
      title={definition}
      aria-label={`${typeof visible === "string" ? visible : term}: ${definition}`}
      className={`underline decoration-dotted underline-offset-2 cursor-help ${className ?? ""}`.trim()}
      data-glossed-term={term}
    >
      {visible}
    </abbr>
  );
}