"use client";

import React from "react";
import type {
  SignalChip as SignalChipType,
  Receipt,
} from "@/lib/grimoire/autopsy";
import type { RuleId } from "@/lib/grimoire/types";
import type { SignalChipData } from "./SignalChip";

export interface ReceiptViewerProps {
  chip?: SignalChipType | SignalChipData | null;
  receipt?: Receipt | null;
  sha?: string;
  onClose?: () => void;
}

export function ReceiptViewer({
  chip,
  receipt,
  sha,
  onClose,
}: ReceiptViewerProps) {
  if (!chip && !receipt) {
    return null;
  }

  const activeRuleId: RuleId | string =
    chip?.ruleId ?? receipt?.ruleId ?? "M1";
  const activeFile = chip?.file ?? receipt?.file ?? "";
  const activeLine = chip?.line ?? receipt?.line ?? 0;
  const activeTarget =
    chip?.target ?? receipt?.target ?? `${activeFile}:${activeLine}`;
  const activeSha = sha || "(default branch head)";
  const snippet = chip?.snippet ?? receipt?.snippet ?? "";
  const uiState = snippet ? "ready" : "empty";

  return (
    <div
      data-testid="receipt-viewer-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs"
    >
      <div
        data-testid="receipt-viewer"
        data-ui-element="receipt-viewer"
        data-ui-state={uiState}
        className="crypt-panel-engraved w-full max-w-2xl p-6 space-y-4 font-mono text-parchment shadow-2xl"
      >
        <div className="flex items-center justify-between pb-3 border-b border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-2 py-0.5 rounded bg-emerald-950/60 border border-[var(--necromancy-emerald-border)] text-xs font-bold uppercase text-emerald-300 shrink-0">
              {activeRuleId}
            </span>
            <h3 className="text-sm font-semibold text-bone truncate">
              Receipt: {activeTarget}
            </h3>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              data-testid="receipt-viewer-close"
              className="crypt-btn-ghost text-xs px-2.5 py-1 rounded shrink-0"
            >
              Close
            </button>
          )}
        </div>

        {/* Location and Sha details */}
        <div className="crypt-well grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs p-3 text-ash">
          <div>
            <span className="text-dust block text-[10px] uppercase tracking-wider mb-0.5">
              File &amp; Line:
            </span>
            <span className="text-bone font-semibold break-all">
              {activeTarget}
            </span>
          </div>
          <div>
            <span className="text-dust block text-[10px] uppercase tracking-wider mb-0.5">
              Analysed Commit SHA:
            </span>
            <span className="text-bone font-semibold break-all">
              {activeSha}
            </span>
          </div>
        </div>

        {/* Source snippet line at the recorded file:line */}
        <div className="space-y-1.5">
          <div className="text-xs text-ash">
            Source line at recorded position ({activeTarget}):
          </div>
          <div
            data-testid="receipt-source-container"
            className="crypt-well p-3 overflow-x-auto"
          >
            {snippet ? (
              <div className="flex items-start gap-3 text-xs leading-relaxed">
                <span className="text-dust select-none text-right w-10 shrink-0 tabular-nums">
                  {activeLine}
                </span>
                <pre
                  data-testid="receipt-source-line"
                  className="text-emerald-300 font-mono whitespace-pre-wrap break-all"
                >
                  {snippet}
                </pre>
              </div>
            ) : (
              <p
                data-testid="receipt-no-snippet"
                className="text-dust text-xs italic"
              >
                Source line snippet not available in repository snapshot.
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end pt-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="crypt-btn-ghost px-4 py-1.5 rounded text-xs"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
