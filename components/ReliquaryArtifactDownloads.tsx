"use client";

import React from "react";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import { StatusPill } from "@/components/ui/StatusPill";

export interface ReliquaryArtifactItem {
  id: string;
  name: string;
  fileName: string;
  kind: "patch" | "spec" | "report" | "events" | "certificate" | string;
  size?: number | null;
  sha256?: string | null;
  downloadUrl?: string | null;
  content?: string | null;
  missing?: boolean;
}

export interface ReliquaryArtifactDownloadsProps {
  runId: string;
  artifacts?: ReliquaryArtifactItem[];
  packing?: boolean;
  noTasksMerged?: boolean;
}

export function formatByteSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || bytes < 0) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function RelicFileIcon({ kind }: { kind: string }) {
  const k = kind.toLowerCase();
  const toneClass =
    k === "certificate"
      ? "text-rose-400"
      : k === "patch"
      ? "text-emerald-400"
      : k === "spec"
      ? "text-amber-400"
      : "text-violet-400";

  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`w-4 h-4 shrink-0 ${toneClass}`}
    >
      <path d="M5 2.5H11.5L15.5 6.5V17.5H5V2.5Z" />
      <path d="M11.5 2.5V6.5H15.5" />
      <path d="M7.5 10.5H13" className="opacity-70" />
      <path d="M7.5 13.5H11.5" className="opacity-70" />
    </svg>
  );
}

export function ReliquaryArtifactDownloads({
  runId,
  artifacts: customArtifacts,
  packing,
  noTasksMerged,
}: ReliquaryArtifactDownloadsProps) {
  // Requirement 38.10: While artifacts are being assembled, show "Packing the relics"
  if (packing) {
    return (
      <div
        className="crypt-panel crypt-shimmer p-8 text-center font-mono space-y-3"
        data-testid="reliquary-packing-relics"
        data-ui-element="reliquary-artifacts"
        data-ui-state="packing"
      >
        <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm font-semibold text-bone">
          Packing the relics
        </p>
        <p className="text-xs text-ash">
          Assembling patch, spec bundle, run report, event stream and death certificate...
        </p>
      </div>
    );
  }

  // When artifacts is omitted or empty and not packing, render honest empty notice
  if (!customArtifacts || customArtifacts.length === 0) {
    return (
      <div
        className="crypt-panel p-8 text-center font-mono space-y-3"
        data-testid="reliquary-no-artifacts"
        data-ui-element="reliquary-artifacts"
        data-ui-state="empty"
      >
        <CryptOrnament kind="wax-seal" className="w-7 h-7 text-dust mx-auto" />
        <p className="text-sm text-ash">
          No recorded artifact metadata available.{" "}
          <a
            href={`/api/runs/${encodeURIComponent(runId)}/events?from=1`}
            className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2 transition-colors"
          >
            The event log is still available.
          </a>
        </p>
      </div>
    );
  }

  let rawList = customArtifacts;

  // Requirement 38.11: When no task merged, offer only Death_Certificate and report
  if (noTasksMerged) {
    rawList = rawList.filter(
      (a) => a.kind === "certificate" || a.kind === "report" || a.id === "certificate" || a.id === "report"
    );
  }

  function handleDirectDownload(art: ReliquaryArtifactItem) {
    if (art.content) {
      const blob = new Blob([art.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = art.fileName;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div
      className="space-y-3 font-mono"
      data-testid="artifact-downloads-container"
      data-ui-element="reliquary-artifacts"
      data-ui-state="populated"
    >
      {noTasksMerged && (
        <div className="crypt-panel border-l-2 border-l-amber-400 text-xs text-amber-300 p-3">
          No task merged during this run. Only the Death Certificate and the run report are offered.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5" data-testid="artifacts-grid">
        {rawList.map((art) => {
          // Requirement 38.12: When an artifact is missing, show "This file could not be built. The event log is still available."
          if (art.missing) {
            return (
              <div
                key={art.id}
                className="crypt-panel border-l-2 border-l-rose-500 p-4 space-y-2"
                data-testid={`artifact-missing-${art.id}`}
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-parchment">
                  <RelicFileIcon kind={art.kind} />
                  <span>
                    {art.name} ({art.fileName})
                  </span>
                </div>
                <div className="text-xs text-rose-400">
                  This file could not be built. The event log is still available.
                </div>
              </div>
            );
          }

          return (
            <div
              key={art.id}
              className="crypt-panel p-4 hover:border-emerald-500/35 hover:bg-slab-hover/40 transition-colors space-y-3"
              data-testid={`artifact-card-${art.id}`}
            >
              <div className="flex justify-between items-start gap-2">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="crypt-well p-2 shrink-0">
                    <RelicFileIcon kind={art.kind} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-bone font-mono truncate">
                      {art.name}
                    </div>
                    <div className="text-xs text-ash font-mono truncate">
                      {art.fileName}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <StatusPill
                    tone="neutral"
                    label={formatByteSize(art.size)}
                    testId={`artifact-size-${art.id}`}
                    className="text-[10px] px-2 py-0.5 normal-case"
                  />
                </div>
              </div>

              <div
                className="crypt-well px-2.5 py-1.5 text-[11px] font-mono text-dust break-all"
                title={art.sha256 ?? ""}
              >
                <span className="text-dust">sha256: </span>
                <span className="text-parchment select-all" data-testid={`artifact-sha-${art.id}`}>
                  {art.sha256 ?? "unknown"}
                </span>
              </div>

              <div className="pt-0.5">
                {art.content ? (
                  <button
                    type="button"
                    onClick={() => handleDirectDownload(art)}
                    className="crypt-btn-ghost px-3 py-1.5 text-xs font-mono rounded"
                    data-testid={`download-button-${art.id}`}
                  >
                    Download {art.fileName}
                  </button>
                ) : (
                  <a
                    href={art.downloadUrl ?? `/runs/${runId}/relic/download?artifact=${art.id}`}
                    download={art.fileName}
                    className="crypt-btn-ghost px-3 py-1.5 text-xs font-mono rounded"
                    data-testid={`download-link-${art.id}`}
                  >
                    Download {art.fileName}
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ArtifactDownloads = ReliquaryArtifactDownloads;
