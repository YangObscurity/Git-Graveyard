"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  DeathCertificate,
  BaselineCommandRow,
  FailureClassification,
} from "@/lib/exhume/death-certificate";
import { postControl } from "@/lib/ui/api";
import { routes } from "@/lib/ui/run-routes";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";
import { ReceiptViewer } from "./ReceiptViewer";
import type { SignalChipData } from "./SignalChip";

export function formatDeathCertificateTable(cert: DeathCertificate): string {
  const headers = ["Step", "Command", "Status", "Exit Code", "Reason / Notes"];
  const rowsData: string[][] = [];

  const rows = cert.rows && cert.rows.length > 0
    ? cert.rows
    : [
        ...(cert.runtimes ?? []),
        cert.install,
        ...(cert.retry ? [cert.retry] : []),
        cert.build,
        cert.test,
      ].filter(Boolean);

  for (const r of rows) {
    const exitStr =
      r.exitCode !== undefined && r.exitCode !== null ? String(r.exitCode) : "-";
    const note = r.ruleId
      ? `Rule: ${r.ruleId}${r.reason ? ` (${r.reason})` : ""}`
      : r.reason ?? "-";
    rowsData.push([r.step, r.command, r.status, exitStr, note]);
  }

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rowsData.map((row) => (row[i] ?? "").length))
  );

  const headerLine =
    "| " +
    headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ") +
    " |";
  const separatorLine =
    "|-" +
    colWidths.map((w) => "-".repeat(w)).join("-|-") +
    "-|";
  const bodyLines = rowsData.map(
    (row) =>
      "| " +
      row.map((cell, i) => cell.padEnd(colWidths[i])).join(" | ") +
      " |"
  );

  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

export interface DeathCertificateViewProps {
  certificate: DeathCertificate;
  runId?: string;
  onNavigateToPact?: (runId?: string) => void;
  onStopHere?: () => void;
}

export function DeathCertificateView({
  certificate,
  runId,
  onNavigateToPact,
  onStopHere,
}: DeathCertificateViewProps) {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    router = null;
  }

  const [stopped, setStopped] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [selectedFailureReceipt, setSelectedFailureReceipt] =
    useState<SignalChipData | null>(null);

  const isHealthy = Boolean(certificate.healthy);
  const failureClasses = certificate.failureClasses || [];
  const failures = certificate.failures || [];
  const canOpenPact = Boolean(runId || onNavigateToPact);

  // Rows from certificate
  const rows: readonly BaselineCommandRow[] =
    certificate.rows && certificate.rows.length > 0
      ? certificate.rows
      : [
          ...(certificate.runtimes ?? []),
          certificate.install,
          ...(certificate.retry ? [certificate.retry] : []),
          certificate.build,
          certificate.test,
        ].filter(Boolean);

  const uiState = rows.length > 0 ? "ready" : "empty";

  function openFailureReceipt(failure: FailureClassification) {
    const refText = failure.ref || failure.step;
    const match = refText.match(/^(.*?):(\d+)$/);
    const file = match ? match[1] : refText;
    const line = match ? Number(match[2]) : 0;
    setSelectedFailureReceipt({
      ruleId: failure.ruleId || failure.class,
      file,
      line,
      target: refText,
      snippet: failure.excerpt || failure.message,
    });
  }

  function handleNavigatePact() {
    if (onNavigateToPact) {
      onNavigateToPact(runId);
      return;
    }
    // A Pact belongs to a run. Without one there is nowhere to go.
    if (!runId) return;
    const target = routes.pact(runId);
    if (router) {
      router.push(target);
    } else if (typeof window !== "undefined") {
      window.location.href = target;
    }
  }

  async function handleStop() {
    if (onStopHere) {
      setStopped(true);
      onStopHere();
      return;
    }
    if (!runId) {
      setStopped(true);
      return;
    }
    setStopping(true);
    setStopError(null);
    const result = await postControl(runId, "stop", "Failed to stop the run");
    setStopping(false);
    if (!result.ok) {
      setStopError(`${result.message} The run is still active; try again.`);
      return;
    }
    setStopped(true);
  }

  function handleDownloadJson() {
    try {
      const dataStr =
        "data:text/json;charset=utf-8," +
        encodeURIComponent(JSON.stringify(certificate, null, 2));
      const downloadAnchor = document.createElement("a");
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute(
        "download",
        `death-certificate-${certificate.baseSha?.slice(0, 7) || "run"}.json`
      );
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setDownloadNotice("Death Certificate downloaded as JSON.");
      setTimeout(() => setDownloadNotice(null), 3000);
    } catch {
      // Ignore
    }
  }

  function handleDownloadMarkdown() {
    try {
      const tableText = formatDeathCertificateTable(certificate);
      const dataStr =
        "data:text/markdown;charset=utf-8," + encodeURIComponent(tableText);
      const downloadAnchor = document.createElement("a");
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute(
        "download",
        `death-certificate-${certificate.baseSha?.slice(0, 7) || "run"}.md`
      );
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setDownloadNotice("Death Certificate table downloaded as Markdown.");
      setTimeout(() => setDownloadNotice(null), 3000);
    } catch {
      // Ignore
    }
  }

  return (
    <div
      data-testid="death-certificate-view"
      data-ui-element="death-certificate"
      data-ui-state={uiState}
      className="crypt-panel-engraved p-6 font-mono text-xs space-y-6"
    >
      {/* Header and metadata */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div className="flex items-start gap-3.5">
          <CryptOrnament
            kind="wax-seal"
            className={`w-7 h-7 mt-0.5 ${
              isHealthy ? "text-emerald-400" : "text-rose-400"
            }`}
          />
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusPill
                tone={isHealthy ? "emerald" : "crimson"}
                label="Baseline Record"
              />
              <h3 className="font-serif-ritual text-lg font-bold text-bone">
                Death Certificate
              </h3>
            </div>
            <p className="text-ash text-xs mt-1">
              Recorded baseline execution results on base commit{" "}
              <code className="text-bone bg-recessed px-1.5 py-0.5 rounded border border-white/10">
                {certificate.baseSha || "HEAD"}
              </code>
              .
            </p>
          </div>
        </div>

        {/* SHA-256 Fingerprint */}
        <div className="crypt-well px-3 py-2 text-left sm:text-right shrink-0">
          <span className="text-[10px] text-dust uppercase tracking-wider block">
            Certificate Digest (SHA-256)
          </span>
          <span
            data-testid="death-certificate-sha256"
            className="text-[11px] text-bone font-mono"
            title={certificate.sha256}
          >
            {certificate.sha256 ? `${certificate.sha256.slice(0, 16)}...` : "-"}
          </span>
        </div>
      </div>

      {/* Overview Metadata Bar */}
      <div className="crypt-well grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 text-parchment">
        <div>
          <span className="text-dust text-[10px] uppercase tracking-wider block">
            Base SHA
          </span>
          <span data-testid="cert-base-sha" className="font-semibold text-bone">
            {certificate.baseSha ? certificate.baseSha.slice(0, 7) : "-"}
          </span>
        </div>
        <div>
          <span className="text-dust text-[10px] uppercase tracking-wider block">
            Language
          </span>
          <span className="font-semibold text-bone">
            {certificate.primaryLanguage}
          </span>
        </div>
        <div>
          <span className="text-dust text-[10px] uppercase tracking-wider block">
            Package Manager
          </span>
          <span className="font-semibold text-bone">
            {certificate.packageManager}
          </span>
        </div>
        <div>
          <span className="text-dust text-[10px] uppercase tracking-wider block">
            Baseline Verdict
          </span>
          <span
            className={`font-semibold ${
              isHealthy ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {isHealthy ? "Passed all tests" : "Baseline failures detected"}
          </span>
        </div>
      </div>

      {/* Table of Baseline Commands (Requirement 35.13) */}
      <div className="space-y-2.5">
        <h4 className="text-xs font-semibold text-bone uppercase tracking-wider">
          Baseline Execution Steps
        </h4>
        <div className="crypt-panel overflow-x-auto">
          <table
            data-testid="death-certificate-table"
            className="w-full text-left border-collapse"
          >
            <thead>
              <tr className="bg-recessed text-ash border-b border-white/10 text-[11px] uppercase tracking-wider">
                <th className="py-2.5 px-3 font-semibold">Step</th>
                <th className="py-2.5 px-3 font-semibold">Command</th>
                <th className="py-2.5 px-3 font-semibold">Status</th>
                <th className="py-2.5 px-3 font-semibold">Exit Code</th>
                <th className="py-2.5 px-3 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {rows.map((r, idx) => {
                const statusLower = String(r.status || "").toLowerCase();
                const isStepPassed = statusLower === "passed";
                const isStepFailed = statusLower === "failed";
                const isNoTestsFound =
                  statusLower === "no tests found" ||
                  r.status === "No tests found";
                const statusLabel =
                  isNoTestsFound && r.ruleId
                    ? `No tests found (${r.ruleId})`
                    : r.status;

                return (
                  <tr
                    key={`${r.step}-${idx}`}
                    data-testid={`cert-row-${r.step}`}
                    className="hover:bg-slab-hover/70 transition-colors"
                  >
                    <td className="py-2.5 px-3 font-semibold uppercase text-[10px] text-parchment">
                      {r.step}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-bone">
                      <code>{r.command}</code>
                    </td>
                    <td className="py-2.5 px-3">
                      <StatusPill
                        tone={
                          isStepPassed
                            ? "emerald"
                            : isStepFailed
                            ? "crimson"
                            : isNoTestsFound
                            ? "amber"
                            : "neutral"
                        }
                        label={statusLabel}
                      />
                    </td>
                    <td className="py-2.5 px-3 text-ash font-mono tabular-nums">
                      {r.exitCode !== undefined && r.exitCode !== null
                        ? r.exitCode
                        : "-"}
                    </td>
                    <td className="py-2.5 px-3 text-ash text-[11px]">
                      {r.ruleId ? `Rule ${r.ruleId}` : r.reason || "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Failure Classification Section */}
      {!isHealthy && failureClasses.length > 0 && (
        <div className="crypt-well space-y-3 p-4 border-l-2 border-l-rose-500 border-rose-500/35 bg-rose-950/20 text-rose-200">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-rose-300">
              Diagnosed Failure Classes ({failureClasses.length})
            </h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {failureClasses.map((fc) => (
              <span
                key={fc}
                data-testid="failure-class-chip"
                className="px-2 py-0.5 rounded bg-rose-950/60 border border-[var(--crimson-seal-border)] text-rose-200 text-xs font-mono"
              >
                {fc}
              </span>
            ))}
          </div>
          {failures.length > 0 && (
            <div className="space-y-2.5 pt-2 border-t border-rose-500/20">
              {failures.map((f, i) => (
                <div key={i} className="text-xs space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-rose-300">
                        [{f.step}] {f.class}:
                      </span>
                      <span className="text-rose-100">{f.message}</span>
                      {f.ref && (
                        <code className="px-1.5 py-0.5 rounded bg-recessed border border-white/10 text-[11px] text-amber-300">
                          {f.ref}
                        </code>
                      )}
                    </div>
                    {(f.ref || f.excerpt) && (
                      <button
                        type="button"
                        onClick={() => openFailureReceipt(f)}
                        className="crypt-btn-ghost px-2 py-0.5 rounded text-[11px]"
                      >
                        View receipt
                      </button>
                    )}
                  </div>
                  {f.excerpt && (
                    <pre className="p-2.5 rounded bg-[#030406] border border-rose-500/25 text-[11px] text-rose-200/90 whitespace-pre-wrap overflow-x-auto max-h-32">
                      {f.excerpt}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Requirement 35.14: Healthy repository state */}
      {isHealthy && (
        <div
          data-testid="healthy-repo-banner"
          className="crypt-well p-4 border-l-2 border-l-emerald-400 border-emerald-500/35 bg-emerald-950/20 text-emerald-200 space-y-3"
        >
          <div className="font-semibold text-sm text-bone">
            This repository installs, builds and passes its tests today.
          </div>
          <p className="text-xs text-emerald-200/85 leading-relaxed">
            All baseline steps succeeded cleanly on current runtimes. You may proceed to plan modernizations anyway, or stop the run here.
          </p>
          {!stopped ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={handleNavigatePact}
                data-testid="plan-modernization-button"
                disabled={!canOpenPact}
                title={canOpenPact ? undefined : "Start a live Exhume to get a Pact for this repository."}
                className="crypt-btn-primary px-4 py-2 rounded text-xs"
              >
                Plan modernization anyway
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                data-testid="stop-here-button"
                className="crypt-btn-ghost px-4 py-2 rounded text-xs"
              >
                {stopping ? "Stopping..." : "Stop here"}
              </button>
            </div>
          ) : (
            <div className="text-xs text-ash italic">
              Run stopped here. Baseline health confirmed.
            </div>
          )}
          {stopError && (
            <p className="text-xs text-rose-300" role="alert">
              {stopError}
            </p>
          )}
        </div>
      )}

      {/* Requirement 35.13 & 35.19: Action to Ask the Necromancer for a Pact */}
      {!isHealthy && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-white/10">
          <div>
            <button
              type="button"
              onClick={handleNavigatePact}
              data-testid="ask-pact-button"
              disabled={!canOpenPact}
              title={canOpenPact ? undefined : "Start a live Exhume to get a Pact for this repository."}
              className="crypt-btn-primary px-5 py-2.5 rounded text-xs"
            >
              Ask the Necromancer for a Pact
            </button>
          </div>

          {/* Export Downloads */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadJson}
              data-testid="download-cert-json"
              className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={handleDownloadMarkdown}
              data-testid="download-cert-md"
              className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            >
              Export Markdown
            </button>
          </div>
        </div>
      )}

      {downloadNotice && (
        <div className="text-xs text-emerald-300 font-mono">{downloadNotice}</div>
      )}

      {selectedFailureReceipt && (
        <ReceiptViewer
          chip={selectedFailureReceipt}
          sha={certificate.baseSha}
          onClose={() => setSelectedFailureReceipt(null)}
        />
      )}
    </div>
  );
}
