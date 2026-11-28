"use client";

import React from "react";

/** One task in the synchronized graph/table views. */
export interface TaskNode {
  taskId: string;
  state: string;
  attempt?: number;
  /** Warden verdict: "approve" | "reject" | a pending marker, or null. */
  verdict?: string | null;
  /** Task IDs this task depends on. */
  dependencies: string[];
}

export interface TaskGraphProps {
  tasks: TaskNode[];
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
}

const NODE_WIDTH = 168;
const NODE_HEIGHT = 60;
const COL_GAP = 48;
const ROW_GAP = 20;
const PADDING = 16;

interface Positioned {
  node: TaskNode;
  depth: number;
  row: number;
  x: number;
  y: number;
}

/** Assign each task a depth (longest dependency chain) without looping on cycles. */
function computeDepths(tasks: TaskNode[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  function depthOf(id: string): number {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const node = byId.get(id);
    let depth = 0;
    if (node) {
      for (const dep of node.dependencies) {
        if (!byId.has(dep)) continue;
        depth = Math.max(depth, depthOf(dep) + 1);
      }
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  }

  for (const t of tasks) depthOf(t.taskId);
  return depths;
}

function layout(tasks: TaskNode[]): { positioned: Positioned[]; width: number; height: number } {
  const depths = computeDepths(tasks);
  const perColumn = new Map<number, TaskNode[]>();
  for (const t of tasks) {
    const d = depths.get(t.taskId) ?? 0;
    const col = perColumn.get(d) ?? [];
    col.push(t);
    perColumn.set(d, col);
  }

  const positioned: Positioned[] = [];
  let maxRows = 0;
  let maxDepth = 0;
  for (const [depth, col] of perColumn) {
    maxDepth = Math.max(maxDepth, depth);
    maxRows = Math.max(maxRows, col.length);
    col.forEach((node, row) => {
      positioned.push({
        node,
        depth,
        row,
        x: PADDING + depth * (NODE_WIDTH + COL_GAP),
        y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
      });
    });
  }

  return {
    positioned,
    width: PADDING * 2 + (maxDepth + 1) * NODE_WIDTH + maxDepth * COL_GAP,
    height: PADDING * 2 + Math.max(1, maxRows) * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP,
  };
}

function verdictToneClass(verdict?: string | null): string {
  const v = (verdict ?? "").toLowerCase();
  if (v === "approve" || v === "approved" || v === "pass")
    return "border-emerald-500/50 text-emerald-300";
  if (v === "reject" || v === "rejected" || v === "fail" || v === "failed")
    return "border-rose-500/50 text-rose-300";
  return "border-amber-500/40 text-amber-300";
}

function stateToneClass(state: string): string {
  const s = state.toLowerCase();
  if (s === "merged" || s === "completed" || s === "done")
    return "border-emerald-500/40 border-t-emerald-400";
  if (s === "failed" || s === "error" || s === "abandoned")
    return "border-rose-500/40 border-t-rose-400";
  if (s === "running" || s === "in_progress" || s === "in_review")
    return "border-emerald-500/30 border-t-emerald-400";
  return "border-white/15 border-t-neutral-500";
}

/**
 * Interactive directed acyclic task graph. Nodes are real buttons (keyboard
 * focusable, Enter/Space selects) and edges are drawn from each dependency to
 * the task that depends on it. The same TaskNode[] feeds TaskTable, so the two
 * views stay in lockstep.
 */
export function TaskGraph({ tasks, selectedTaskId, onSelectTask }: TaskGraphProps) {
  const { positioned, width, height } = layout(tasks);
  const posById = new Map(positioned.map((p) => [p.node.taskId, p]));

  if (tasks.length === 0) {
    return (
      <div data-testid="task-graph" className="crypt-panel text-xs text-ash p-8 text-center">
        No tasks have been recorded for this run yet.
      </div>
    );
  }

  return (
    <div
      data-testid="task-graph"
      data-ui-element="task-graph"
      role="group"
      aria-label="Task dependency graph"
      className="crypt-panel overflow-auto p-4"
    >
      <div className="relative" style={{ width: `${width}px`, height: `${height}px` }}>
        <svg
          className="absolute inset-0 pointer-events-none"
          width={width}
          height={height}
          aria-hidden="true"
        >
          {positioned.flatMap((p) =>
            p.node.dependencies.map((dep) => {
              const from = posById.get(dep);
              if (!from) return null;
              const x1 = from.x + NODE_WIDTH;
              const y1 = from.y + NODE_HEIGHT / 2;
              const x2 = p.x;
              const y2 = p.y + NODE_HEIGHT / 2;
              return (
                <line
                  key={`edge-${dep}-${p.node.taskId}`}
                  data-testid={`task-graph-edge-${dep}-${p.node.taskId}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="rgba(148,163,184,0.45)"
                  strokeWidth={1.5}
                />
              );
            })
          )}
        </svg>

        {positioned.map((p) => {
          const t = p.node;
          const selected = selectedTaskId === t.taskId;
          return (
            <button
              key={t.taskId}
              type="button"
              data-testid={`task-graph-node-${t.taskId}`}
              data-task-id={t.taskId}
              aria-pressed={selected}
              onClick={() => onSelectTask?.(t.taskId)}
              className={`absolute flex flex-col items-start justify-center gap-0.5 px-3 text-left text-xs border border-t-2 rounded crypt-well ${stateToneClass(
                t.state
              )} ${selected ? "ring-2 ring-emerald-400/70" : ""}`}
              style={{
                left: `${p.x}px`,
                top: `${p.y}px`,
                width: `${NODE_WIDTH}px`,
                height: `${NODE_HEIGHT}px`,
              }}
            >
              <span className="font-semibold text-bone truncate w-full">{t.taskId}</span>
              <span className="text-[10px] text-ash truncate w-full">
                {t.state}
                {typeof t.attempt === "number" ? ` · attempt ${t.attempt}` : ""}
              </span>
              <span className={`text-[10px] px-1.5 rounded border ${verdictToneClass(t.verdict)}`}>
                Warden: {t.verdict || "pending"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default TaskGraph;