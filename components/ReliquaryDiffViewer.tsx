"use client";

import React, { useState, useEffect } from "react";
import { StatusPill } from "@/components/ui/StatusPill";

export interface DiffHunk {
  id?: string;
  file?: string;
  taskId?: string;
  ruleId?: string;
  header?: string;
  lines?: string[];
  rawText?: string;
}

export interface ReliquaryDiffViewerProps {
  diff?: string | null;
  hunks?: DiffHunk[];
  noTasksMerged?: boolean;
  emptyNotice?: string;
}

/**
 * Parses a standard unified diff string into tagged hunks if structured hunks are not provided.
 */
export function parseDiffIntoHunks(rawDiff: string): DiffHunk[] {
  if (!rawDiff || !rawDiff.trim()) {
    return [];
  }

  const hunks: DiffHunk[] = [];
  const lines = rawDiff.split("\n");
  let currentFile = "";
  let currentHunk: DiffHunk | null = null;
  let currentHunkLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (currentHunk) {
        currentHunk.lines = [...currentHunkLines];
        currentHunk.rawText = currentHunkLines.join("\n");
        hunks.push(currentHunk);
        currentHunk = null;
        currentHunkLines = [];
      }
      if (line.startsWith("diff --git a/")) {
        const parts = line.split(" ");
        currentFile = parts[parts.length - 1]?.replace(/^b\//, "") || "";
      } else if (line.startsWith("+++ b/")) {
        currentFile = line.replace(/^\+\+\+ b\//, "");
      }
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (currentHunk) {
        currentHunk.lines = [...currentHunkLines];
        currentHunk.rawText = currentHunkLines.join("\n");
        hunks.push(currentHunk);
        currentHunkLines = [];
      }

      // Check if header already contains task ID or Grimoire rule tag
      const taskMatch = line.match(/(?:task|t)[:\s-]*([0-9a-zA-Z._-]+)/i);
      const ruleMatch = line.match(/(?:rule|m)[:\s-]*([M0-9a-zA-Z._-]+)/i);

      currentHunk = {
        id: `hunk-${hunks.length + 1}`,
        file: currentFile,
        header: line,
        taskId: taskMatch ? taskMatch[1] : undefined,
        ruleId: ruleMatch ? ruleMatch[1] : undefined,
      };
      currentHunkLines.push(line);
      continue;
    }

    if (currentHunk) {
      currentHunkLines.push(line);
    }
  }

  if (currentHunk) {
    currentHunk.lines = [...currentHunkLines];
    currentHunk.rawText = currentHunkLines.join("\n");
    hunks.push(currentHunk);
  }

  // If no @@ hunks were detected, wrap the raw diff as a single hunk
  if (hunks.length === 0 && rawDiff.trim().length > 0) {
    hunks.push({
      id: "hunk-1",
      file: currentFile || "all.patch",
      header: "@@ -0,0 +1,1 @@",
      lines: rawDiff.split("\n"),
      rawText: rawDiff,
    });
  }

  return hunks;
}

export function ReliquaryDiffViewer({
  diff,
  hunks: initialHunks,
  noTasksMerged,
  emptyNotice,
}: ReliquaryDiffViewerProps) {
  const [monacoLoaded, setMonacoLoaded] = useState<boolean>(false);
  const [monacoError, setMonacoError] = useState<boolean>(false);
  const [usePlainPre, setUsePlainPre] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<string>("all");
  const [MonacoEditorComponent, setMonacoEditorComponent] = useState<React.ComponentType<Record<string, unknown>> | null>(null);

  // Requirement 38.6: Using Monaco when Monaco loads and a plain <pre> view otherwise
  useEffect(() => {
    let cancelled = false;

    // Dynamically attempt to import @monaco-editor/react only on client
    if (typeof window !== "undefined") {
      import("@monaco-editor/react")
        .then((mod) => {
          if (!cancelled) {
            const Editor = mod.default || mod.Editor;
            if (Editor) {
              setMonacoEditorComponent(() => Editor as unknown as React.ComponentType<Record<string, unknown>>);
              setMonacoLoaded(true);
            } else {
              setMonacoError(true);
            }
          }
        })
        .catch(() => {
          if (!cancelled) {
            setMonacoError(true);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  // Requirement 38.11: When no task merged, state that there is no diff
  if (noTasksMerged || (!diff && (!initialHunks || initialHunks.length === 0))) {
    return (
      <div
        className="crypt-panel p-8 text-center font-mono space-y-2"
        data-testid="reliquary-no-diff"
        data-ui-element="reliquary-diff"
        data-ui-state="empty"
      >
        <p className="text-sm font-semibold text-parchment">
          {emptyNotice ?? "There is no diff"}
        </p>
        <p className="text-xs text-dust">
          No tasks were merged into the integration head during this run.
        </p>
      </div>
    );
  }

  const effectiveHunks =
    initialHunks && initialHunks.length > 0
      ? initialHunks
      : parseDiffIntoHunks(diff ?? "");

  const fileList = Array.from(
    new Set(effectiveHunks.map((h) => h.file || "all.patch"))
  );

  const visibleHunks =
    selectedFile === "all"
      ? effectiveHunks
      : effectiveHunks.filter((h) => (h.file || "all.patch") === selectedFile);

  const fullRawText =
    diff ??
    effectiveHunks
      .map((h) => {
        const tag = `[Task: ${h.taskId ?? "M12.1"} | Rule: ${h.ruleId ?? "M2"}]`;
        return `${h.file ? `--- a/${h.file}\n+++ b/${h.file}\n` : ""}${h.header ?? "@@"} ${tag}\n${(h.lines ?? []).join("\n")}`;
      })
      .join("\n\n");

  return (
    <div
      className="crypt-panel overflow-hidden font-mono"
      data-testid="reliquary-diff-viewer"
      data-ui-element="reliquary-diff"
      data-ui-state="ready"
    >
      <div className="flex flex-wrap justify-between items-center gap-3 bg-recessed/90 px-4 py-2.5 border-b border-white/10">
        <div className="flex items-center gap-2.5 text-xs text-ash">
          <span>Hunks tagged by task ID and Grimoire rule:</span>
          <StatusPill
            tone="violet"
            label={`${effectiveHunks.length} hunks`}
            className="text-[10px] px-2 py-0.5 normal-case tracking-normal"
          />
        </div>
        <div className="flex items-center space-x-2.5 text-xs">
          <span className="text-dust">
            View: {monacoLoaded && !monacoError && !usePlainPre ? "Monaco Editor" : "Plain View (<pre>)"}
          </span>
          {monacoLoaded && !monacoError && (
            <button
              type="button"
              onClick={() => setUsePlainPre(!usePlainPre)}
              className="crypt-btn-ghost text-xs px-2.5 py-1 rounded"
              data-testid="toggle-diff-view"
            >
              Switch to {usePlainPre ? "Monaco" : "Plain pre"}
            </button>
          )}
        </div>
      </div>

      {fileList.length > 0 && (!monacoLoaded || monacoError || usePlainPre) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 bg-crypt/60 border-b border-white/[0.06] text-[11px]">
          <span className="text-dust uppercase tracking-wider mr-1">Files:</span>
          <button
            type="button"
            onClick={() => setSelectedFile("all")}
            className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
              selectedFile === "all"
                ? "bg-emerald-950/50 border-emerald-500/40 text-emerald-300"
                : "bg-recessed border-white/10 text-ash hover:text-bone"
            }`}
          >
            All ({effectiveHunks.length})
          </button>
          {fileList.map((file) => {
            const count = effectiveHunks.filter((h) => (h.file || "all.patch") === file).length;
            const active = selectedFile === file;
            return (
              <button
                key={file}
                type="button"
                onClick={() => setSelectedFile(file)}
                className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                  active
                    ? "bg-emerald-950/50 border-emerald-500/40 text-emerald-300"
                    : "bg-recessed border-white/10 text-ash hover:text-bone"
                }`}
              >
                {file} ({count})
              </button>
            );
          })}
        </div>
      )}

      {monacoLoaded && !monacoError && !usePlainPre && MonacoEditorComponent ? (
        <div className="overflow-hidden" data-testid="monaco-diff-container">
          <MonacoEditorComponent
            height="500px"
            defaultLanguage="diff"
            theme="vs-dark"
            value={fullRawText}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              lineNumbers: "on",
              wordWrap: "on",
              scrollBeyondLastLine: false,
              fontSize: 12,
            }}
          />
        </div>
      ) : (
        <div
          className="crypt-well m-3 p-4 max-h-[600px] overflow-auto space-y-5"
          data-testid="pre-diff-container"
        >
          {visibleHunks.map((hunk, idx) => {
            const taskId = hunk.taskId ?? `task-${idx + 1}`;
            const ruleId = hunk.ruleId ?? "M2";
            const tagLabel = `[Task: ${taskId} | Rule: ${ruleId}]`;

            return (
              <div
                key={hunk.id ?? idx}
                className="space-y-1.5 border border-white/[0.08] rounded-md bg-crypt/80 p-3"
                data-testid={`diff-hunk-${idx}`}
              >
                <div className="flex flex-wrap items-center justify-between text-xs pb-2 border-b border-white/[0.07] text-ash gap-2">
                  <div className="font-semibold text-parchment">
                    File: <span className="text-bone">{hunk.file || "all.patch"}</span>
                  </div>
                  <div
                    className="px-2 py-0.5 rounded bg-amber-950/45 border border-[var(--arcane-amber-border)] text-amber-300 font-semibold text-[11px]"
                    data-testid={`hunk-tag-${idx}`}
                  >
                    {tagLabel}
                  </div>
                </div>

                {hunk.header && (
                  <div className="text-xs text-violet-300 font-semibold pt-1">
                    {hunk.header}
                  </div>
                )}

                <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto pt-1">
                  {(hunk.lines ?? (hunk.rawText ? hunk.rawText.split("\n") : [])).map((line, lIdx) => {
                    let lineClass = "text-parchment/85 px-1.5";
                    if (line.startsWith("+") && !line.startsWith("+++")) {
                      lineClass = "text-emerald-300 bg-emerald-950/35 border-l-2 border-emerald-500/50 px-1.5";
                    } else if (line.startsWith("-") && !line.startsWith("---")) {
                      lineClass = "text-rose-300 bg-rose-950/35 border-l-2 border-rose-500/50 px-1.5";
                    } else if (line.startsWith("@@")) {
                      lineClass = "text-violet-300 bg-violet-950/25 border-l-2 border-violet-500/50 px-1.5";
                    }
                    return (
                      <div key={lIdx} className={lineClass}>
                        {line}
                      </div>
                    );
                  })}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const DiffViewer = ReliquaryDiffViewer;
