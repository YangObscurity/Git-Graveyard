"use client";

import React from "react";
import type { TaskState } from "@/lib/events/types";
import { StatusPill, type StatusPillProps } from "@/components/ui/StatusPill";
import { CryptOrnament } from "@/components/ui/CryptOrnament";

export interface TaskLedgerItem {
  id: string;
  title?: string;
  description?: string;
  state: TaskState | string;
  attempts: number;
  verdict?: "approve" | "reject" | string | null;
  reasons?: readonly (string | { message?: string; ref?: string; reason?: string })[] | null;
}

export interface ReliquaryTaskLedgerProps {
  tasks?: TaskLedgerItem[];
  emptyMessage?: string;
}

export function ReliquaryTaskLedger({
  tasks,
  emptyMessage,
}: ReliquaryTaskLedgerProps) {
  if (!tasks || tasks.length === 0) {
    return (
      <div
        className="crypt-panel p-8 text-center font-mono space-y-2"
        data-testid="reliquary-empty-tasks"
        data-ui-element="reliquary-ledger"
        data-ui-state="empty"
      >
        <p className="text-sm text-ash">
          {emptyMessage ?? "No tasks recorded."}
        </p>
      </div>
    );
  }

  function resolveStateTone(state: string): StatusPillProps["tone"] {
    const s = state.toLowerCase();
    if (s === "merged") return "emerald";
    if (s === "failed" || s === "rejected") return "crimson";
    if (s === "abandoned" || s === "skipped") return "neutral";
    return "amber";
  }

  function renderStateBadge(state: string) {
    return (
      <StatusPill
        tone={resolveStateTone(state)}
        label={state}
        className="text-[10px] px-2 py-0.5 normal-case tracking-wide"
      />
    );
  }

  function renderVerdictBadge(verdict?: string | null) {
    if (!verdict || verdict === "-") {
      return <span className="text-dust font-mono">-</span>;
    }
    const v = verdict.toLowerCase();
    if (v === "approve") {
      return (
        <StatusPill
          tone="emerald"
          label="approve"
          icon={<CryptOrnament kind="wax-seal" className="w-3.5 h-3.5 text-emerald-400" />}
          className="text-[10px] px-2 py-0.5 normal-case tracking-wide"
        />
      );
    }
    if (v === "reject") {
      return (
        <StatusPill
          tone="crimson"
          label="reject"
          className="text-[10px] px-2 py-0.5 normal-case tracking-wide"
        />
      );
    }
    return <span className="text-parchment font-mono">{verdict}</span>;
  }

  function formatReasons(reasons?: readonly (string | { message?: string; ref?: string; reason?: string })[] | null) {
    if (!reasons || reasons.length === 0) {
      return <span className="text-dust">-</span>;
    }

    return (
      <ul className="space-y-1.5 list-none p-0 m-0">
        {reasons.map((r, i) => {
          let text = "";
          let ref: string | undefined = undefined;
          if (typeof r === "string") {
            text = r;
          } else if (r && typeof r === "object") {
            text = r.message || r.reason || JSON.stringify(r);
            ref = r.ref;
          }
          return (
            <li key={i} className="text-parchment text-xs flex flex-wrap items-baseline gap-1.5">
              <span>{text}</span>
              {ref && (
                <span className="crypt-well text-[11px] text-emerald-300 px-1.5 py-0.5 font-mono">
                  {ref}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div
      className="space-y-3 font-mono"
      data-testid="task-ledger-container"
      data-ui-element="reliquary-ledger"
      data-ui-state="populated"
    >
      <div className="crypt-panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm" data-testid="task-ledger-table">
            <thead>
              <tr className="border-b border-white/10 bg-recessed/90 text-[11px] text-ash uppercase tracking-wider">
                <th className="px-4 py-3 w-1/6">Task ID</th>
                <th className="px-4 py-3 w-1/8">Final State</th>
                <th className="px-4 py-3 w-1/12 text-center">Attempts</th>
                <th className="px-4 py-3 w-1/8">Warden Verdict</th>
                <th className="px-4 py-3 w-1/2">Reasons / Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className="hover:bg-slab-hover/60 transition-colors"
                  data-testid={`task-row-${task.id}`}
                >
                  <td className="px-4 py-3.5 align-top font-semibold text-bone">
                    <div className="text-xs font-mono text-bone">{task.id}</div>
                    {task.title && (
                      <div className="text-xs font-normal text-ash mt-0.5">
                        {task.title}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5 align-top">
                    {renderStateBadge(task.state)}
                  </td>
                  <td className="px-4 py-3.5 align-top text-center text-xs text-bone">
                    <span className="crypt-well inline-flex items-center justify-center min-w-[1.75rem] px-2 py-0.5 text-xs text-parchment">
                      {task.attempts ?? 1}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 align-top">
                    {renderVerdictBadge(task.verdict)}
                  </td>
                  <td className="px-4 py-3.5 align-top text-xs">
                    {formatReasons(task.reasons)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export const TaskLedger = ReliquaryTaskLedger;
