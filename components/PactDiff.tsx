"use client";

import React from "react";
import { StatusPill } from "./ui/StatusPill";

export interface PactDiffProps {
  previousVersion?: number;
  currentVersion: number;
  addedTaskIds?: string[];
  removedTaskIds?: string[];
  modifiedTaskIds?: string[];
  diffText?: string;
}

function classifyDiffLine(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "bg-emerald-950/35 text-emerald-200 border-l-2 border-l-emerald-400/70";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "bg-rose-950/35 text-rose-200 border-l-2 border-l-rose-400/70";
  }
  if (line.startsWith("@@")) {
    return "bg-violet-950/25 text-violet-300";
  }
  return "text-parchment";
}

export function PactDiff({
  previousVersion,
  currentVersion,
  addedTaskIds = [],
  removedTaskIds = [],
  modifiedTaskIds = [],
  diffText,
}: PactDiffProps) {
  const hasChanges =
    addedTaskIds.length > 0 ||
    removedTaskIds.length > 0 ||
    modifiedTaskIds.length > 0 ||
    Boolean(diffText && diffText.trim().length > 0);

  const uiState = hasChanges ? "modified" : "clean";

  return (
    <div
      data-testid="pact-diff"
      data-ui-element="pact-diff"
      data-ui-state={uiState}
      className="crypt-panel p-5 font-mono text-xs space-y-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/[0.08] pb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-semibold text-bone tracking-wide uppercase">
              Pact Revision Diff
            </h3>
            <StatusPill
              tone={hasChanges ? "amber" : "neutral"}
              label={hasChanges ? "Modified" : "Clean"}
              uiState={uiState}
            />
          </div>
          <p className="text-ash text-xs mt-1">
            Comparing{" "}
            {previousVersion !== undefined
              ? `version ${previousVersion}`
              : "previous"}
            {" -> "}
            version {currentVersion}
          </p>
        </div>
      </div>

      {!hasChanges ? (
        <div
          data-testid="pact-diff-empty"
          className="crypt-well p-4 text-ash text-center"
        >
          No changes between versions.
        </div>
      ) : (
        <div className="space-y-3">
          {/* Summary badges */}
          <div className="flex flex-wrap gap-2 text-xs">
            {addedTaskIds.length > 0 && (
              <div
                data-testid="pact-diff-added"
                className="px-2.5 py-1 rounded bg-emerald-950/50 border border-emerald-500/40 text-emerald-300"
              >
                Added: {addedTaskIds.join(", ")}
              </div>
            )}
            {removedTaskIds.length > 0 && (
              <div
                data-testid="pact-diff-removed"
                className="px-2.5 py-1 rounded bg-rose-950/50 border border-rose-500/40 text-rose-300"
              >
                Removed: {removedTaskIds.join(", ")}
              </div>
            )}
            {modifiedTaskIds.length > 0 && (
              <div
                data-testid="pact-diff-modified"
                className="px-2.5 py-1 rounded bg-amber-950/50 border border-amber-500/40 text-amber-300"
              >
                Modified: {modifiedTaskIds.join(", ")}
              </div>
            )}
          </div>

          {/* Raw diff block if provided */}
          {diffText && (
            <div className="crypt-well p-3 overflow-x-auto text-[11px] leading-relaxed">
              <pre className="whitespace-pre font-mono">
                {diffText.split("\n").map((line, idx) => (
                  <span
                    key={idx}
                    className={`block px-2 py-0.5 rounded-sm ${classifyDiffLine(line)}`}
                  >
                    {line || " "}
                  </span>
                ))}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
