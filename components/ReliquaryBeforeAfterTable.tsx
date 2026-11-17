"use client";

import React, { useState } from "react";
import { StatusPill, type StatusPillProps } from "@/components/ui/StatusPill";

export interface BeforeAfterCellData {
  status: string;
  exitCode?: number | null;
  duration?: number | string | null;
  output?: string | null;
  command?: string | null;
}

export interface BeforeAfterRowData {
  label: string;
  key: string;
  before: BeforeAfterCellData;
  after: BeforeAfterCellData;
}

export interface ReliquaryBeforeAfterTableProps {
  rows?: BeforeAfterRowData[];
  installBefore?: Partial<BeforeAfterCellData>;
  installAfter?: Partial<BeforeAfterCellData>;
  buildBefore?: Partial<BeforeAfterCellData>;
  buildAfter?: Partial<BeforeAfterCellData>;
  testsRepoBefore?: Partial<BeforeAfterCellData>;
  testsRepoAfter?: Partial<BeforeAfterCellData>;
  grimoireBefore?: Partial<BeforeAfterCellData>;
  grimoireAfter?: Partial<BeforeAfterCellData>;
  lockfileBefore?: Partial<BeforeAfterCellData>;
  lockfileAfter?: Partial<BeforeAfterCellData>;
  runtimeBefore?: Partial<BeforeAfterCellData>;
  runtimeAfter?: Partial<BeforeAfterCellData>;
  testsAddedBefore?: Partial<BeforeAfterCellData>;
  testsAddedAfter?: Partial<BeforeAfterCellData>;
}

export function formatDuration(val?: number | string | null): string {
  if (val === undefined || val === null || val === "") {
    return "-";
  }
  if (typeof val === "string") {
    return val;
  }
  if (typeof val === "number") {
    if (val < 1000) {
      return `${val}ms`;
    }
    const sec = (val / 1000).toFixed(1);
    return `${sec}s`;
  }
  return "-";
}

export function formatExitCode(code?: number | null): string {
  if (code === undefined || code === null) {
    return "-";
  }
  return String(code);
}

export function ReliquaryBeforeAfterTable({
  rows: customRows,
  installBefore,
  installAfter,
  buildBefore,
  buildAfter,
  testsRepoBefore,
  testsRepoAfter,
  grimoireBefore,
  grimoireAfter,
  lockfileBefore,
  lockfileAfter,
  runtimeBefore,
  runtimeAfter,
  testsAddedBefore,
  testsAddedAfter,
}: ReliquaryBeforeAfterTableProps) {
  const [activeOutput, setActiveOutput] = useState<{
    label: string;
    phase: "Before" | "After";
    cell: BeforeAfterCellData;
  } | null>(null);

  const defaultRows: BeforeAfterRowData[] = [
    {
      label: "Install",
      key: "install",
      before: {
        status: installBefore?.status ?? "failed",
        exitCode: installBefore?.exitCode !== undefined ? installBefore.exitCode : 1,
        duration: installBefore?.duration ?? null,
        output: installBefore?.output ?? null,
        command: installBefore?.command ?? "npm install --ignore-scripts",
      },
      after: {
        status: installAfter?.status ?? "not run",
        exitCode: installAfter?.exitCode !== undefined ? installAfter.exitCode : null,
        duration: installAfter?.duration ?? null,
        output: installAfter?.output ?? null,
        command: installAfter?.command ?? "npm install --ignore-scripts",
      },
    },
    {
      label: "Build",
      key: "build",
      before: {
        status: buildBefore?.status ?? "not run",
        exitCode: buildBefore?.exitCode !== undefined ? buildBefore.exitCode : null,
        duration: buildBefore?.duration ?? null,
        output: buildBefore?.output ?? null,
        command: buildBefore?.command ?? "npm run build",
      },
      after: {
        status: buildAfter?.status ?? "not run",
        exitCode: buildAfter?.exitCode !== undefined ? buildAfter.exitCode : null,
        duration: buildAfter?.duration ?? null,
        output: buildAfter?.output ?? null,
        command: buildAfter?.command ?? "npm run build",
      },
    },
    {
      label: "Tests (repository's own)",
      key: "tests_repo",
      before: {
        status: testsRepoBefore?.status ?? "not run",
        exitCode: testsRepoBefore?.exitCode !== undefined ? testsRepoBefore.exitCode : null,
        duration: testsRepoBefore?.duration ?? null,
        output: testsRepoBefore?.output ?? null,
        command: testsRepoBefore?.command ?? "npm test",
      },
      after: {
        status: testsRepoAfter?.status ?? "not run",
        exitCode: testsRepoAfter?.exitCode !== undefined ? testsRepoAfter.exitCode : null,
        duration: testsRepoAfter?.duration ?? null,
        output: testsRepoAfter?.output ?? null,
        command: testsRepoAfter?.command ?? "npm test",
      },
    },
    {
      label: "Grimoire signals",
      key: "grimoire_signals",
      before: {
        status: grimoireBefore?.status ?? "signals found",
        exitCode: grimoireBefore?.exitCode !== undefined ? grimoireBefore.exitCode : null,
        duration: grimoireBefore?.duration ?? null,
        output: grimoireBefore?.output ?? null,
        command: grimoireBefore?.command ?? null,
      },
      after: {
        status: grimoireAfter?.status ?? "not run",
        exitCode: grimoireAfter?.exitCode !== undefined ? grimoireAfter.exitCode : null,
        duration: grimoireAfter?.duration ?? null,
        output: grimoireAfter?.output ?? null,
        command: grimoireAfter?.command ?? null,
      },
    },
    {
      label: "Lockfile",
      key: "lockfile",
      before: {
        status: lockfileBefore?.status ?? "missing",
        exitCode: lockfileBefore?.exitCode !== undefined ? lockfileBefore.exitCode : null,
        duration: lockfileBefore?.duration ?? null,
        output: lockfileBefore?.output ?? null,
        command: lockfileBefore?.command ?? null,
      },
      after: {
        status: lockfileAfter?.status ?? "not run",
        exitCode: lockfileAfter?.exitCode !== undefined ? lockfileAfter.exitCode : null,
        duration: lockfileAfter?.duration ?? null,
        output: lockfileAfter?.output ?? null,
        command: lockfileAfter?.command ?? null,
      },
    },
    {
      label: "Runtime used",
      key: "runtime_used",
      before: {
        status: runtimeBefore?.status ?? "legacy",
        exitCode: runtimeBefore?.exitCode !== undefined ? runtimeBefore.exitCode : null,
        duration: runtimeBefore?.duration ?? null,
        output: runtimeBefore?.output ?? null,
        command: runtimeBefore?.command ?? null,
      },
      after: {
        status: runtimeAfter?.status ?? "not run",
        exitCode: runtimeAfter?.exitCode !== undefined ? runtimeAfter.exitCode : null,
        duration: runtimeAfter?.duration ?? null,
        output: runtimeAfter?.output ?? null,
        command: runtimeAfter?.command ?? null,
      },
    },
    {
      label: "Tests added by skeletons",
      key: "tests_added_by_skeletons",
      before: {
        status: testsAddedBefore?.status ?? "none",
        exitCode: testsAddedBefore?.exitCode !== undefined ? testsAddedBefore.exitCode : null,
        duration: testsAddedBefore?.duration ?? null,
        output: testsAddedBefore?.output ?? null,
        command: testsAddedBefore?.command ?? null,
      },
      after: {
        status: testsAddedAfter?.status ?? "not run",
        exitCode: testsAddedAfter?.exitCode !== undefined ? testsAddedAfter.exitCode : null,
        duration: testsAddedAfter?.duration ?? null,
        output: testsAddedAfter?.output ?? null,
        command: testsAddedAfter?.command ?? null,
      },
    },
  ];

  const rows = customRows && customRows.length > 0 ? customRows : defaultRows;

  const hasPopulatedAfter =
    Boolean(customRows && customRows.length > 0) ||
    rows.some((r) => {
      const s = (r.after?.status ?? "").toLowerCase();
      return (
        (s !== "" && s !== "not run") ||
        (r.after?.exitCode !== undefined && r.after?.exitCode !== null)
      );
    });

  function isPositiveStatus(status: string): boolean {
    const s = status.toLowerCase();
    return s.includes("pass") || s === "clean" || s === "present" || s === "modern";
  }

  function isNegativeStatus(status: string): boolean {
    const s = status.toLowerCase();
    return s.includes("fail") || s === "error";
  }

  function resolveTone(status: string): StatusPillProps["tone"] {
    const s = status.toLowerCase();
    if (isPositiveStatus(s)) {
      return "emerald";
    }
    if (isNegativeStatus(s)) {
      return "crimson";
    }
    if (s === "not run" || s === "none" || s === "missing") {
      return "neutral";
    }
    return "amber";
  }

  function renderStatusBadge(status: string) {
    return (
      <StatusPill
        tone={resolveTone(status)}
        label={status}
        className="text-[10px] px-2 py-0.5 normal-case tracking-wide"
      />
    );
  }

  function renderDeltaTag(before: BeforeAfterCellData, after: BeforeAfterCellData) {
    const afterLower = (after.status ?? "").toLowerCase();
    if (!afterLower || afterLower === "not run") {
      return null;
    }
    const beforeGood = isPositiveStatus(before.status);
    const afterGood = isPositiveStatus(after.status);
    const afterBad = isNegativeStatus(after.status);

    if (!beforeGood && afterGood) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-emerald-950/50 border border-emerald-500/35 text-emerald-300">
          ▲ recovered
        </span>
      );
    }
    if (beforeGood && afterBad) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-rose-950/50 border border-rose-500/35 text-rose-300">
          ▼ regressed
        </span>
      );
    }
    return null;
  }

  function renderCell(
    label: string,
    phase: "Before" | "After",
    cell: BeforeAfterCellData,
    beforeCell?: BeforeAfterCellData
  ) {
    const deltaTag = phase === "After" && beforeCell ? renderDeltaTag(beforeCell, cell) : null;

    return (
      <div className="space-y-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {renderStatusBadge(cell.status)}
          {deltaTag}
          <span className="text-ash">
            exit: <span className="font-mono text-neutral-200">{formatExitCode(cell.exitCode)}</span>
          </span>
          <span className="text-ash">
            time: <span className="font-mono text-neutral-200">{formatDuration(cell.duration)}</span>
          </span>
        </div>
        <div>
          <button
            type="button"
            data-testid={`view-output-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${phase.toLowerCase()}`}
            onClick={() => setActiveOutput({ label, phase, cell })}
            className="text-xs text-emerald-400 hover:text-emerald-300 underline underline-offset-2 cursor-pointer font-mono transition-colors"
          >
            View output
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="space-y-4"
      data-testid="before-after-table-container"
      data-ui-element="reliquary-before-after"
      data-ui-state={hasPopulatedAfter ? "populated" : "unpopulated"}
    >
      <div className="crypt-panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm font-mono" data-testid="before-after-table">
            <thead>
              <tr className="border-b border-white/10 bg-recessed/90 text-[11px] text-ash uppercase tracking-wider">
                <th className="px-4 py-3 w-1/4">Verification Step</th>
                <th className="px-4 py-3 w-3/8">Before (Tomb)</th>
                <th className="px-4 py-3 w-3/8">After (Relic)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {rows.map((r) => {
                const isAddedRow = r.label === "Tests added by skeletons";
                return (
                  <tr
                    key={r.key}
                    className={`hover:bg-slab-hover/60 transition-colors ${
                      isAddedRow ? "bg-emerald-950/10 border-t border-emerald-500/20" : ""
                    }`}
                    data-testid={`row-${r.key}`}
                  >
                    <td className="px-4 py-3.5 align-top font-semibold text-bone">
                      <div>{r.label}</div>
                      {isAddedRow && (
                        <div className="text-xs font-normal text-dust mt-0.5">
                          Separate verification of skeleton-authored test suite
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 align-top" data-testid={`cell-${r.key}-before`}>
                      {renderCell(r.label, "Before", r.before)}
                    </td>
                    <td className="px-4 py-3.5 align-top" data-testid={`cell-${r.key}-after`}>
                      {renderCell(r.label, "After", r.after, r.before)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {activeOutput && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          data-testid="output-modal"
        >
          <div className="w-full max-w-2xl crypt-panel-engraved p-6 space-y-4 font-mono">
            <div className="flex justify-between items-center border-b border-white/10 pb-3">
              <h3 className="text-sm font-semibold text-bone">
                Output: {activeOutput.label} ({activeOutput.phase})
              </h3>
              <button
                type="button"
                onClick={() => setActiveOutput(null)}
                className="crypt-btn-ghost text-xs px-2.5 py-1 rounded"
                data-testid="close-output-modal"
              >
                Close
              </button>
            </div>

            <div className="text-xs space-y-1.5 text-ash">
              {activeOutput.cell.command && (
                <div>
                  <span className="text-dust">Command: </span>
                  <span className="text-emerald-300 font-mono">{activeOutput.cell.command}</span>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  <span className="text-dust">Status: </span>
                  <span className="text-bone">{activeOutput.cell.status}</span>
                </span>
                <span>
                  <span className="text-dust">Exit code: </span>
                  <span className="text-bone">{formatExitCode(activeOutput.cell.exitCode)}</span>
                </span>
                <span>
                  <span className="text-dust">Duration: </span>
                  <span className="text-bone">{formatDuration(activeOutput.cell.duration)}</span>
                </span>
              </div>
            </div>

            <div className="crypt-well p-3.5 max-h-96 overflow-y-auto">
              <pre
                className="text-xs text-parchment font-mono whitespace-pre-wrap break-all"
                data-testid="output-content"
              >
                {activeOutput.cell.output || "No output recorded."}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const BeforeAfterTable = ReliquaryBeforeAfterTable;
