"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchRunSummary } from "@/lib/ui/api";
import { hrefForRun, routes } from "@/lib/ui/run-routes";
import { CryptOrnament } from "./ui/CryptOrnament";

export interface RunEntryProps {
  runId: string;
}

/**
 * /runs/[runId]: looks up where the run is and sends the visitor to the
 * screen for that phase (Legion, Pact or Reliquary).
 */
export function RunEntry({ runId }: RunEntryProps) {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    router = null;
  }

  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    fetchRunSummary(runId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError({ notFound: result.status === 404, message: result.message });
        return;
      }
      const target = hrefForRun(runId, result.summary.phase);
      if (router) {
        router.replace(target);
      } else {
        window.location.replace(target);
      }
    });
    return () => {
      cancelled = true;
    };
    // router identity is stable for the lifetime of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (error) {
    return (
      <div
        data-testid="run-entry-error"
        data-ui-element="run-entry"
        data-ui-state="error"
        className="crypt-panel-engraved p-8 border-l-2 border-l-rose-500 space-y-4 font-mono"
      >
        <h1 className="text-base font-bold text-bone">
          {error.notFound ? "Run not found" : "The run could not be opened"}
        </h1>
        <p className="text-xs text-rose-200/90 leading-relaxed">
          {error.notFound
            ? `No run with the ID ${runId} is recorded here. Check the link, or pick a run from History.`
            : `${error.message} Reload the page to try again.`}
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href={routes.history()} className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Open History
          </Link>
          <Link href={routes.gate()} className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Return to Gate
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="run-entry-loading"
      data-ui-element="run-entry"
      data-ui-state="loading"
      className="crypt-panel-engraved p-12 text-center font-mono space-y-4"
    >
      <CryptOrnament kind="arch-sigil" className="w-8 h-8 text-emerald-400/60 mx-auto" />
      <p className="text-sm text-bone">Finding run {runId}...</p>
    </div>
  );
}
