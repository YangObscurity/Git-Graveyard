"use client";

import React from "react";
import type { TaskNode } from "./TaskGraph";

export interface TaskTableProps {
  tasks: TaskNode[];
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
}

function verdictLabel(verdict?: string | null): string {
  return verdict && verdict.length > 0 ? verdict : "pending";
}

/**
 * Keyboard-navigable table view of the same tasks shown in TaskGraph. Each row
 * is a real button in the first cell (Tab to a row, Enter/Space to select) and
 * carries the identical state, dependencies, attempt number and Warden verdict
 * as the graph, so the two views never disagree.
 */
export function TaskTable({ tasks, selectedTaskId, onSelectTask }: TaskTableProps) {
  if (tasks.length === 0) {
    return (
      <div data-testid="task-table" className="crypt-panel text-xs text-ash p-8 text-center">
        No tasks have been recorded for this run yet.
      </div>
    );
  }

  return (
    <div data-testid="task-table" data-ui-element="task-table" className="crypt-panel overflow-auto p-4">
      <table className="w-full text-xs border-collapse">
        <caption className="sr-only">Tasks with state, dependencies, attempts and Warden verdict</caption>
        <thead>
          <tr className="text-dust uppercase tracking-wider text-[11px]">
            <th scope="col" className="text-left px-2 py-1.5 border-b border-white/10">Task</th>
            <th scope="col" className="text-left px-2 py-1.5 border-b border-white/10">State</th>
            <th scope="col" className="text-left px-2 py-1.5 border-b border-white/10">Attempt</th>
            <th scope="col" className="text-left px-2 py-1.5 border-b border-white/10">Depends on</th>
            <th scope="col" className="text-left px-2 py-1.5 border-b border-white/10">Warden</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const selected = selectedTaskId === t.taskId;
            return (
              <tr
                key={t.taskId}
                data-testid={`task-table-row-${t.taskId}`}
                data-task-id={t.taskId}
                aria-selected={selected}
                className={selected ? "bg-emerald-950/30" : ""}
              >
                <td className="px-2 py-1.5 border-b border-white/[0.06]">
                  <button
                    type="button"
                    data-testid={`task-table-select-${t.taskId}`}
                    aria-pressed={selected}
                    onClick={() => onSelectTask?.(t.taskId)}
                    className="font-semibold text-bone underline-offset-4 hover:underline"
                  >
                    {t.taskId}
                  </button>
                </td>
                <td className="px-2 py-1.5 border-b border-white/[0.06] text-parchment">{t.state}</td>
                <td className="px-2 py-1.5 border-b border-white/[0.06] tabular-nums text-parchment">
                  {typeof t.attempt === "number" ? t.attempt : "-"}
                </td>
                <td className="px-2 py-1.5 border-b border-white/[0.06] text-ash">
                  {t.dependencies.length > 0 ? t.dependencies.join(", ") : "-"}
                </td>
                <td className="px-2 py-1.5 border-b border-white/[0.06] text-parchment">
                  {verdictLabel(t.verdict)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default TaskTable;