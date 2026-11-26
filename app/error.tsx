"use client";

import Link from "next/link";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div
        data-testid="route-error"
        data-ui-element="route-error"
        data-ui-state="error"
        className="max-w-2xl mx-auto crypt-panel-engraved p-8 border-l-2 border-l-rose-500 space-y-4"
      >
        <h1 className="text-base font-bold text-bone">This page failed to load</h1>
        <p className="text-xs text-rose-200/90 leading-relaxed">
          Something went wrong while showing this page. Try again; if it keeps
          failing, return to the Gate.
        </p>
        {error.digest && (
          <p className="text-[11px] text-dust">Error reference: {error.digest}</p>
        )}
        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="button"
            onClick={reset}
            className="crypt-btn-primary px-4 py-2 rounded text-xs"
          >
            Try again
          </button>
          <Link href="/" className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Return to Gate
          </Link>
        </div>
      </div>
    </main>
  );
}
