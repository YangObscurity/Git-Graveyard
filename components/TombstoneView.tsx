"use client";

import React, { useEffect, useState } from "react";
import type {
  AutopsyResult,
  SignalChip as SignalChipType,
} from "@/lib/grimoire/autopsy";
import {
  DISCLAIMER,
  VALID_RULE_IDS,
  escapePlainText,
} from "@/lib/grimoire/autopsy";
import { routes } from "@/lib/ui/run-routes";
import { SignalRuleGroups } from "./SignalRuleGroups";
import { ReceiptViewer } from "./ReceiptViewer";
import { ExhumeView } from "./ExhumeView";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";

export interface TombstoneViewProps {
  owner: string;
  repo: string;
  initialAutopsy?: AutopsyResult | null;
  searchParams?: { [key: string]: string | string[] | undefined };
  usesTreeRef?: boolean;
}

export function TombstoneView({
  owner,
  repo,
  initialAutopsy,
  searchParams,
  usesTreeRef: propUsesTreeRef,
}: TombstoneViewProps) {
  const [autopsy, setAutopsy] = useState<AutopsyResult | null>(
    initialAutopsy ?? null
  );
  // Requirement 35.1: While the autopsy request is pending, show a loading state without stage names
  const [loading, setLoading] = useState<boolean>(!initialAutopsy);
  const [errorInfo, setErrorInfo] = useState<{
    code: string;
    message: string;
    lookedFor?: string[];
    filesLookedFor?: string[];
    resetTime?: string;
  } | null>(null);

  const [selectedReceiptChip, setSelectedReceiptChip] =
    useState<SignalChipType | null>(null);

  // Check if input contained /tree/<ref> (Requirement 1.4)
  const rawUrlParam =
    typeof searchParams?.url === "string" ? searchParams.url : "";
  const treeParam = searchParams?.tree ?? searchParams?.ref;
  const isTreeRefParam =
    searchParams?.usesTreeRef === "true" ||
    Boolean(treeParam) ||
    rawUrlParam.includes("/tree/");
  const hasTreeRef = Boolean(propUsesTreeRef || isTreeRefParam);

  // A run started from the Gate arrives here as ?run=<runId>, so the Exhume
  // panel below follows that run instead of offering to start a second one.
  const runParam = searchParams?.run;
  const attachedRunId =
    typeof runParam === "string" && /^[A-Za-z0-9._-]+$/.test(runParam)
      ? runParam
      : undefined;

  // Fetch autopsy if not provided
  useEffect(() => {
    if (initialAutopsy) {
      return;
    }

    let cancelled = false;

    async function loadAutopsy() {
      try {
        setLoading(true);
        setErrorInfo(null);

        const targetUrl = `https://github.com/${owner}/${repo}`;
        const res = await fetch("/api/run-autopsy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: targetUrl }),
        });

        const data = await res.json();

        if (!cancelled) {
          if (!res.ok || !data.ok) {
            setErrorInfo({
              code: data.code || "AUTOSPY_FAILED",
              message:
                data.message ||
                data.error ||
                "Failed to complete repository autopsy.",
              lookedFor: data.lookedFor || data.filesLookedFor,
              filesLookedFor: data.filesLookedFor,
              resetTime: data.resetTime || data.resetAt,
            });
            setLoading(false);
            return;
          }

          setAutopsy(data);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setErrorInfo({
            code: "NETWORK_ERROR",
            message:
              err instanceof Error
                ? err.message
                : "Network error occurred while fetching autopsy.",
          });
          setLoading(false);
        }
      }
    }

    loadAutopsy();

    return () => {
      cancelled = true;
    };
  }, [owner, repo, initialAutopsy]);

  // Requirement 35.1: Loading state without stage names
  if (loading) {
    return (
      <div
        data-testid="tombstone-loading"
        data-ui-element="tombstone-view"
        data-ui-state="loading"
        className="crypt-panel-engraved p-12 text-center font-mono space-y-4"
      >
        <CryptOrnament
          kind="tomb-arch"
          className="w-24 h-8 text-emerald-400/50 mx-auto"
        />
        <div className="inline-block w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm text-bone">
          Conducting autopsy for {owner}/{repo}...
        </p>
        <p className="text-xs text-ash">
          Scanning repository manifest and source signals.
        </p>
      </div>
    );
  }

  // Error States (Requirements 35.3 to 35.6)
  if (errorInfo) {
    let errorTitle = "Autopsy Encountered an Error";
    let errorExplanation = errorInfo.message;

    if (errorInfo.code === "REPO_NOT_FOUND") {
      // Requirement 35.3: Not-found-or-private message
      errorTitle = "Repository Not Found";
      errorExplanation =
        "The requested repository was not found or is private. Please ensure the repository is public and accessible on GitHub.";
    } else if (errorInfo.code === "TOO_LARGE") {
      // Requirement 35.4: Size limit that was exceeded
      errorTitle = "Repository Exceeds Size Limit";
      errorExplanation =
        "The repository exceeds the size limits (maximum 20 MB compressed, 60 MB decompressed, or 2000 entries).";
    } else if (errorInfo.code === "LANGUAGE_UNKNOWN") {
      // Requirement 35.5: Name the files Grimoire looked for
      errorTitle = "Unsupported or Unknown Language";
      const filesList = (
        errorInfo.lookedFor ||
        errorInfo.filesLookedFor || [
          "package.json",
          "setup.py",
          "pyproject.toml",
          "requirements.txt",
        ]
      ).join(", ");
      errorExplanation = `No supported programming language was detected in this repository. The Grimoire looked for: ${filesList}.`;
    } else if (errorInfo.code === "RATE_LIMITED") {
      // Requirement 35.6: GitHub reset time
      errorTitle = "GitHub API Rate Limit Exceeded";
      errorExplanation = `The GitHub API rate limit has been exhausted. Rate limit resets at: ${
        errorInfo.resetTime || "a later time"
      }.`;
    }

    return (
      <div
        data-testid="tombstone-error"
        data-ui-element="tombstone-view"
        data-ui-state="error"
        className="crypt-panel-engraved p-8 border-l-2 border-l-rose-500 border-rose-500/35 bg-rose-950/20 text-rose-200 font-mono space-y-4"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusPill tone="crimson" label={errorInfo.code} />
          <h2 className="text-base font-bold text-bone">{errorTitle}</h2>
        </div>
        <p className="text-xs text-rose-200/90 leading-relaxed">
          {errorExplanation}
        </p>
        <div className="pt-2 flex flex-wrap gap-3">
          <a
            href="/"
            className="crypt-btn-ghost px-4 py-2 rounded text-xs inline-flex"
          >
            Return to Gate
          </a>
          {attachedRunId && (
            <a
              href={routes.run(attachedRunId)}
              data-testid="tombstone-error-run-link"
              className="crypt-btn-primary px-4 py-2 rounded text-xs inline-flex"
            >
              Open your run
            </a>
          )}
        </div>
        {attachedRunId && (
          <p className="text-xs text-parchment">
            Your live run {attachedRunId} was started and is not affected by
            this autopsy error.
          </p>
        )}
      </div>
    );
  }

  if (!autopsy) {
    return (
      <div
        data-ui-element="tombstone-view"
        data-ui-state="error"
        className="crypt-panel p-8 text-center text-ash font-mono text-sm"
      >
        No autopsy record available.
      </div>
    );
  }

  // Repository name from GitHub API full_name (Requirement 1.8)
  const repoFullName =
    autopsy.fullName || autopsy.full_name || `${owner}/${repo}`;
  const isAlive = autopsy.status === "alive";
  const reasonsList = autopsy.deadReasons || autopsy.reasons || [];

  // Signal chips grouped by rule M1 to M6 (Requirement 5.3)
  const chipsByRule: Record<string, SignalChipType[]> =
    autopsy.signalChips || autopsy.chipsByRule || {};

  const totalSignals = autopsy.chips?.length ?? 0;

  return (
    <div
      data-testid="tombstone-view"
      data-ui-element="tombstone-view"
      data-ui-state="ready"
      data-ui-variant={isAlive ? "alive" : "dead"}
      className="space-y-8 font-mono text-parchment"
    >
      {/* Ceremonial Tombstone Monument Header */}
      <header className="crypt-panel-engraved p-6 md:p-7 space-y-5">
        <div className="flex flex-col items-center text-center space-y-2 pb-4 border-b border-white/10">
          <CryptOrnament
            kind="tomb-arch"
            className={`w-28 h-9 ${
              isAlive ? "text-emerald-400/75" : "text-rose-400/70"
            }`}
          />
          <span className="text-[10px] uppercase font-bold text-ash tracking-[0.22em]">
            STAGE II · REPOSITORY TOMBSTONE
          </span>
          {/* Requirement 1.8: Repository name from GitHub API full_name */}
          <h1
            data-testid="repo-full-name"
            className="font-serif-ritual text-2xl md:text-4xl font-bold text-bone tracking-tight break-all"
          >
            {repoFullName}
          </h1>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <StatusPill
              testId="autopsy-status-badge"
              tone={isAlive ? "emerald" : "crimson"}
              pulse={isAlive}
              label={isAlive ? "Still Breathing" : "Dead"}
            />
            <span className="text-xs text-ash">
              Commit SHA:{" "}
              <code className="text-bone bg-recessed px-1.5 py-0.5 rounded border border-white/10">
                {autopsy.sha ? autopsy.sha.slice(0, 7) : "HEAD"}
              </code>{" "}
              (branch: {autopsy.defaultBranch || "main"})
            </span>
          </div>
        </div>

        <div className="flex justify-end">
          <a
            href="/"
            className="crypt-btn-ghost px-3.5 py-1.5 rounded text-xs"
          >
            Back to Gate
          </a>
        </div>
      </header>

      {/* Requirement 1.4 Notice: Default branch head is used when input has /tree/<ref> */}
      {hasTreeRef && (
        <div
          data-testid="tree-ref-notice"
          className="crypt-panel p-3.5 border-l-2 border-l-amber-400 text-xs text-parchment font-mono flex items-center gap-2.5"
        >
          <StatusPill tone="amber" label="Notice" />
          <span>
            The default-branch head commit is analysed instead of the specified
            /tree/ ref.
          </span>
        </div>
      )}

      {/* ================================================================= */}
      {/* SECTION A: AUTOPSY CARD (Requirement 35.8, Requirement 5)         */}
      {/* ================================================================= */}
      <section
        data-testid="autopsy-card"
        className="crypt-panel-engraved p-6 space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-white/10">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-[0.18em] text-ash block">
              Section A: Instant Diagnosis
            </span>
            <h2 className="text-lg font-bold text-bone mt-0.5">Autopsy Report</h2>
          </div>

          <span className="text-[11px] text-ash">
            Grimoire Rules Checked: M1–M6
          </span>
        </div>

        {/* Diagnosis and Reasons (Requirement 35.2 & 35.8) */}
        <div className="crypt-well p-4 space-y-2.5">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-ash">
            Diagnosis:
          </div>
          <p
            data-testid="autopsy-cause-text"
            className="text-xs text-bone leading-relaxed"
          >
            {autopsy.cause ||
              (isAlive
                ? "Repository is still breathing; no death criteria triggered."
                : `Repository diagnosed as dead. Reasons: ${reasonsList.join(
                    ", "
                  )}.`)}
          </p>

          {/* Dead reasons or Still breathing checks (Requirement 35.2) */}
          {isAlive ? (
            <div
              data-testid="still-breathing-reasons"
              className="text-xs text-emerald-300/90 pt-2 border-t border-white/10"
            >
              Checked: Repository is not archived, active within 24 calendar
              months, and contains no fatal obsolescence signals.
            </div>
          ) : (
            reasonsList.length > 0 && (
              <div
                data-testid="dead-reasons-list"
                className="text-xs text-rose-300/90 pt-2 border-t border-white/10 flex flex-wrap gap-2 items-center"
              >
                <span className="text-ash text-[10px] uppercase font-semibold">
                  Triggered Criteria:
                </span>
                {reasonsList.map((r) => (
                  <span
                    key={r}
                    className="px-2 py-0.5 rounded bg-rose-950/50 border border-[var(--crimson-seal-border)] text-rose-200 text-[11px]"
                  >
                    {r}
                  </span>
                ))}
              </div>
            )
          )}
        </div>

        {/* Last Words (Requirement 5.2: plain text with markup escaped) */}
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-ash">
            Last Words (Default-Branch Head Commit Message)
          </span>
          <div
            data-testid="last-words-box"
            data-escaped-last-words={autopsy.lastWordsEscaped || escapePlainText(autopsy.lastWords || "")}
            className="crypt-well p-3.5 border-l-2 border-l-amber-500/45 pl-4 text-xs text-parchment italic font-mono whitespace-pre-wrap break-all"
          >
            {autopsy.lastWords ? `"${autopsy.lastWords}"` : "(No commit message recorded)"}
          </div>
        </div>

        {/* Repository Lifespan, Activity, Stars, Forks, Languages (Requirement 35.8, 40.13) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="crypt-well p-3 space-y-1">
            <span className="text-dust text-[10px] uppercase tracking-wider block font-semibold">
              Lifespan
            </span>
            <span data-testid="autopsy-lifespan" className="font-semibold text-bone block">
              {autopsy.lifespanYears === "unknown"
                ? "unknown"
                : `${autopsy.lifespanYears} years`}
            </span>
          </div>

          <div className="crypt-well p-3 space-y-1">
            <span className="text-dust text-[10px] uppercase tracking-wider block font-semibold">
              Years Dead
            </span>
            <span data-testid="autopsy-years-dead" className="font-semibold text-bone block">
              {autopsy.yearsDead} years dead
            </span>
          </div>

          <div className="crypt-well p-3 space-y-1">
            <span className="text-dust text-[10px] uppercase tracking-wider block font-semibold">
              Stars / Forks
            </span>
            <span data-testid="autopsy-stars-forks" className="font-semibold text-bone block tabular-nums">
              {autopsy.stars} stars / {autopsy.forks} forks
            </span>
          </div>

          <div className="crypt-well p-3 space-y-1">
            <span className="text-dust text-[10px] uppercase tracking-wider block font-semibold">
              Languages
            </span>
            <span data-testid="autopsy-languages" className="font-semibold text-bone truncate block">
              {autopsy.languages && autopsy.languages.length > 0
                ? autopsy.languages.join(", ")
                : "None recorded"}
            </span>
          </div>

          {/* asOf timestamp citation (Requirement 40.13) */}
          <div className="col-span-2 sm:col-span-4 text-[10px] text-dust pt-1">
            Metrics snapshot timestamp (asOf):{" "}
            <span data-testid="autopsy-as-of" className="text-ash">
              {autopsy.asOf}
            </span>
          </div>
        </div>

        {/* Requirement 5.7: Grimoire Disclaimer */}
        <div
          data-testid="grimoire-disclaimer"
          className="crypt-well p-3.5 border-l-2 border-l-amber-400/60 border-amber-500/25 text-amber-300/95 text-xs italic"
        >
          {DISCLAIMER}
        </div>

        {/* Signal Chips Grouped by Rule ID M1 to M6 (Requirement 5.3) */}
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-bone">
              Signal Chips by Grimoire Rule (M1 to M6)
            </h3>
            <span className="text-[11px] text-ash">
              Total Signals: {totalSignals}
            </span>
          </div>

          <SignalRuleGroups
            chipsByRule={chipsByRule}
            ruleIds={VALID_RULE_IDS}
            sha={autopsy.sha}
            onOpenReceipt={(c) => setSelectedReceiptChip(c as SignalChipType)}
          />
        </div>
      </section>

      {/* ================================================================= */}
      {/* SECTION B: EXHUME & DEATH CERTIFICATE (Requirement 35.9 - 35.19)  */}
      {/* ================================================================= */}
      <ExhumeView
        repoUrl={`https://github.com/${owner}/${repo}`}
        sha={autopsy.sha}
        initialRunId={attachedRunId}
      />

      {/* Source Receipt Viewer Modal (Requirement 5.5) */}
      {selectedReceiptChip && (
        <ReceiptViewer
          chip={selectedReceiptChip}
          sha={autopsy.sha}
          onClose={() => setSelectedReceiptChip(null)}
        />
      )}
    </div>
  );
}
