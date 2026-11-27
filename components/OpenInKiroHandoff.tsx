"use client";

import React, { useState } from "react";
import {
  buildKiroHandoff,
  formatKiroHandoffText,
  type KiroHandoffInput,
} from "@/lib/artifacts/kiro-handoff";

export interface OpenInKiroHandoffProps extends KiroHandoffInput {
  /** Optional override for the run outcome label (unused in commands). */
  outcome?: string;
}

/**
 * SSR-safe, copy-friendly handoff panel. Renders the clone/apply/copy/verify
 * steps for resuming a run bundle locally in Kiro.
 */
export function OpenInKiroHandoff({
  owner,
  repo,
  baseSha,
  runId,
  targetSpecName,
  certificate,
  verificationCommands,
}: OpenInKiroHandoffProps): React.ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  const plan = buildKiroHandoff({
    owner,
    repo,
    baseSha,
    runId,
    targetSpecName,
    certificate,
    verificationCommands,
  });
  const plainText = formatKiroHandoffText(plan);

  const handleCopy = (): void => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(plainText).then(() => {
        setCopied(true);
      });
    }
  };

  return (
    <section
      className="crypt-panel p-5 font-mono text-xs space-y-4"
      data-testid="open-in-kiro-handoff"
      data-ui-element="open-in-kiro-handoff"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-bone">Open in Kiro Handoff Instructions</h3>
        <button
          type="button"
          onClick={handleCopy}
          className="crypt-btn-ghost px-3 py-1 rounded text-[11px]"
          data-testid="open-in-kiro-copy"
        >
          {copied ? "Copied" : "Copy commands"}
        </button>
      </div>

      <p className="text-ash">
        Resume this run locally: <span className="text-parchment">{plan.owner}/{plan.repo}</span>{" "}
        at base <span className="text-emerald-300">{plan.baseSha}</span>.
      </p>

      <ol className="list-decimal list-inside space-y-3 text-ash">
        {plan.steps.map((step, i) => (
          <li key={step.title} data-testid="open-in-kiro-step">
            <div className="font-semibold text-bone">{step.title}</div>
            <div className="text-[11px] text-dust">{step.detail}</div>
            <pre className="crypt-well mt-1 p-2 overflow-x-auto text-[11px] text-emerald-300">
              {step.commands.join("\n")}
            </pre>
            {i === 1 && (
              <div className="text-[11px] text-amber-200/90 mt-1">
                Fallback copy target if Kiro does not list nested spec folders:{" "}
                <code className="crypt-well px-1.5 py-0.5">{plan.specCopyFallback}</code>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default OpenInKiroHandoff;