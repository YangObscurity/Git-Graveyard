"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseRepoInput } from "@/lib/grimoire/normalize";
import { GATE_FOOTER } from "@/lib/copy/glossary";
import { startRun } from "@/lib/ui/api";
import { rememberInviteCode } from "@/lib/ui/invite-session";
import { routes } from "@/lib/ui/run-routes";
import { HealthBadge } from "./HealthBadge";
import { RecentRuns } from "./RecentRuns";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";

export function GateView() {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    // Graceful fallback for non-Next App Router test environments
    router = null;
  }

  const [repoUrl, setRepoUrl] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [commitSha, setCommitSha] = useState("");

  const [healthStatus, setHealthStatus] = useState<string | null>(null);
  const [queueLength, setQueueLength] = useState<number>(0);
  const [badgeText, setBadgeText] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState<boolean>(true);

  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [queuedRunId, setQueuedRunId] = useState<string | null>(null);
  const [queuedExhumeUrl, setQueuedExhumeUrl] = useState<string | null>(null);

  // Poll/fetch health status
  useEffect(() => {
    let cancelled = false;

    async function fetchHealth() {
      try {
        setHealthLoading(true);
        const res = await fetch("/api/health");
        if (!res.ok) {
          if (!cancelled) {
            setHealthStatus("unavailable");
            setBadgeText("Live runs: unavailable");
            setHealthLoading(false);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          const status = data.status || data.liveRunStatus || "unavailable";
          const qLength =
            typeof data.queueLength === "number" ? data.queueLength : 0;
          const text =
            data.badgeText ||
            (status === "open"
              ? "Live runs: open"
              : status === "queue length" || qLength > 0
              ? `Live runs: queue is ${qLength} long`
              : status === "paused by owner" || status === "paused"
              ? "Live runs: paused by the owner"
              : "Live runs: unavailable");
          setHealthStatus(status);
          setQueueLength(qLength);
          setBadgeText(text);
          setHealthLoading(false);
        }
      } catch {
        if (!cancelled) {
          setHealthStatus("unavailable");
          setBadgeText("Live runs: unavailable");
          setHealthLoading(false);
        }
      }
    }

    fetchHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  const isPaused =
    healthStatus === "paused by owner" ||
    healthStatus === "paused" ||
    badgeText === "Live runs: paused by the owner";
  const isUnavailable =
    healthStatus === "unavailable" ||
    badgeText === "Live runs: unavailable";

  function handleAutopsy(e?: React.FormEvent) {
    if (e) {
      e.preventDefault();
    }
    setFormError(null);
    setFormSuccess(null);

    const parsed = parseRepoInput(repoUrl);
    if (!parsed.ok) {
      setFormError(
        "Invalid repository URL. Accepted URL forms include: https://github.com/owner/repo, github.com/owner/repo, or git@github.com:owner/repo (optionally with .git, tree, or blob paths)."
      );
      return;
    }

    const targetUrl = routes.tomb(parsed.owner, parsed.repo);
    if (router) {
      router.push(targetUrl);
    } else if (typeof window !== "undefined") {
      window.location.href = targetUrl;
    }
  }

  async function handleStartRun(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    setQueuedRunId(null);
    setQueuedExhumeUrl(null);

    // 1. Validate repository URL (Requirement 34.6)
    const parsed = parseRepoInput(repoUrl);
    if (!parsed.ok) {
      setFormError(
        "Invalid repository URL. Accepted URL forms include: https://github.com/owner/repo, github.com/owner/repo, or git@github.com:owner/repo (optionally with .git, tree, or blob paths)."
      );
      return;
    }

    // 2. Validate invite code
    const cleanCode = inviteCode.trim();
    if (!cleanCode) {
      setFormError("An invite code is required to start a live run.");
      return;
    }

    // 3. Submit request to POST /api/start-run (Requirement 34.11).
    // Requirement 34.7: each refusal has its own message (lib/ui/api.ts).
    setSubmitting(true);
    const result = await startRun({
      url: repoUrl,
      sha: commitSha,
      inviteCode: cleanCode,
    });
    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    rememberInviteCode(result.runId, cleanCode);
    const exhumeUrl = `${routes.tomb(parsed.owner, parsed.repo)}?run=${encodeURIComponent(result.runId)}`;
    setQueuedRunId(result.runId);
    setQueuedExhumeUrl(exhumeUrl);
    setFormSuccess(
      typeof result.queuePosition === "number"
        ? `Run queued. Run ID: ${result.runId}. Queue position: ${result.queuePosition}.`
        : `Run queued. Run ID: ${result.runId}.`
    );
    // The Tombstone shows the Exhume of this run as it happens.
    if (router) {
      router.push(exhumeUrl);
    }
  }

  const gateUiState = submitting ? "submitting" : formError ? "invalid" : "idle";

  return (
    <div
      data-testid="gate-view"
      data-ui-element="gate-view"
      data-ui-state={gateUiState}
      className="flex flex-col min-h-full space-y-10 font-mono"
    >
      {/* Hero Monument Header with Brand and Health Badge */}
      <header className="text-center space-y-4 pb-6 border-b border-white/10">
        <CryptOrnament
          kind="tomb-arch"
          className="w-28 h-9 text-emerald-400/75 mx-auto mb-2"
        />
        <div className="flex items-center justify-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.22em] text-emerald-400/90 font-semibold">
            STAGE I · FORENSIC TRIAGE GATE
          </span>
        </div>
        <h1 className="font-serif-ritual text-3xl md:text-5xl font-bold tracking-tight text-bone">
          Git-Graveyard
        </h1>
        <p className="text-sm text-parchment max-w-xl mx-auto leading-relaxed">
          Resurrection engine for abandoned GitHub repositories.
        </p>
        <div className="pt-1 flex justify-center">
          <HealthBadge
            status={healthStatus ?? undefined}
            queueLength={queueLength}
            badgeText={badgeText ?? undefined}
            loading={healthLoading}
          />
        </div>
      </header>

      {/* Requirement 34.8 Explanation Notice when paused or unavailable */}
      {isPaused && (
        <section
          data-testid="status-explanation-paused"
          className="crypt-panel p-4 border-l-2 border-l-amber-400 border-amber-500/35 bg-amber-950/20 text-amber-200 text-sm space-y-1.5"
        >
          <div className="flex items-center gap-2">
            <StatusPill tone="amber" label="Notice: Live runs paused" />
          </div>
          <p className="text-xs text-amber-300/90 leading-relaxed">
            Live runs are currently paused by the owner. Exhume is disabled, but
            repository autopsy is still available.
          </p>
        </section>
      )}

      {isUnavailable && !healthLoading && (
        <section
          data-testid="status-explanation-unavailable"
          className="crypt-panel p-4 border-l-2 border-l-rose-500 border-rose-500/35 bg-rose-950/20 text-rose-200 text-sm space-y-1.5"
        >
          <div className="flex items-center gap-2">
            <StatusPill tone="crimson" label="Notice: Live runs unavailable" />
          </div>
          <p className="text-xs text-rose-300/90 leading-relaxed">
            Live runs are currently unavailable. Exhume is disabled, but
            repository autopsy is still available.
          </p>
        </section>
      )}

      {/* Product Overview Section */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs text-parchment">
        <div className="crypt-panel p-5 space-y-2.5 overflow-hidden">
          <CryptOrnament kind="corner-ticks" className="text-bone" />
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-bone uppercase tracking-wider">
              1. Instant Autopsy
            </h2>
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-recessed border border-white/10 text-ash">
              Static
            </span>
          </div>
          <p className="leading-relaxed text-ash">
            Grimoire rule engine scans manifests and ASTs for fatal obsolescence
            (Python 2 syntax, deprecated requests library, Webpack 2 configurations)
            without executing repository code.
          </p>
        </div>
        <div className="crypt-panel p-5 space-y-2.5 overflow-hidden">
          <CryptOrnament kind="corner-ticks" className="text-emerald-400" />
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-bone uppercase tracking-wider">
              2. Live Resurrection
            </h2>
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-950/40 border border-[var(--necromancy-emerald-border)] text-emerald-300">
              Sandbox
            </span>
          </div>
          <p className="leading-relaxed text-ash">
            With an invite code, Skeletons run in isolated sandboxes to update
            dependencies, apply syntax patches, and restore passing build and test
            suites.
          </p>
        </div>
      </section>

      {/* Repository Inscription Altar (URL Form Section) */}
      <section className="crypt-panel-engraved p-5 md:p-7 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-white/10">
          <div>
            <span className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/90 font-semibold block mb-1">
              Repository Inscription Altar
            </span>
            <h2 className="text-lg font-semibold text-bone">
              Resurrect or Diagnose a Repository
            </h2>
            <p className="text-xs text-ash mt-1">
              Provide a GitHub repository address to inspect its autopsy or start a
              live resurrection run.
            </p>
          </div>
        </div>

        <form onSubmit={handleStartRun} className="space-y-5">
          <div>
            <label
              htmlFor="repo-url-input"
              className="block text-[11px] uppercase tracking-wider font-medium text-parchment mb-1.5"
            >
              Repository URL
            </label>
            <div className="crypt-well flex items-center transition-all focus-within:border-emerald-400/60 focus-within:shadow-[0_0_20px_-6px_rgba(16,185,129,0.35)]">
              <span
                aria-hidden="true"
                className="pl-3.5 pr-2 py-2.5 text-xs text-emerald-400/80 select-none border-r border-white/10"
              >
                git://
              </span>
              <input
                id="repo-url-input"
                data-testid="repo-url-input"
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                className="w-full px-3.5 py-2.5 bg-transparent text-bone placeholder-neutral-500 text-sm focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="invite-code-input"
                className="block text-[11px] uppercase tracking-wider font-medium text-parchment mb-1.5"
              >
                Invite Code (required for live runs)
              </label>
              <div className="crypt-well transition-all focus-within:border-emerald-400/60 focus-within:shadow-[0_0_20px_-6px_rgba(16,185,129,0.35)]">
                <input
                  id="invite-code-input"
                  data-testid="invite-code-input"
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Enter invite code"
                  className="w-full px-3.5 py-2.5 bg-transparent text-bone placeholder-neutral-500 text-sm focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="commit-sha-input"
                className="block text-[11px] uppercase tracking-wider font-medium text-parchment mb-1.5"
              >
                Commit SHA (optional, defaults to HEAD)
              </label>
              <div className="crypt-well transition-all focus-within:border-emerald-400/60 focus-within:shadow-[0_0_20px_-6px_rgba(16,185,129,0.35)]">
                <input
                  id="commit-sha-input"
                  data-testid="commit-sha-input"
                  type="text"
                  value={commitSha}
                  onChange={(e) => setCommitSha(e.target.value)}
                  placeholder="HEAD"
                  className="w-full px-3.5 py-2.5 bg-transparent text-bone placeholder-neutral-500 text-sm focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Error and Success Notices */}
          {formError && (
            <div
              data-testid="form-error-message"
              className="crypt-well p-3.5 border-l-2 border-l-rose-500 border-rose-500/35 bg-rose-950/30 text-rose-200 text-xs font-mono"
            >
              {formError}
            </div>
          )}

          {formSuccess && (
            <div
              data-testid="form-success-message"
              className="crypt-well p-3.5 border-l-2 border-l-emerald-400 border-emerald-500/35 bg-emerald-950/30 text-emerald-200 text-xs font-mono space-y-1.5"
            >
              <p>{formSuccess}</p>
              {queuedRunId && (
                <div className="pt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {queuedExhumeUrl && (
                    <a
                      href={queuedExhumeUrl}
                      data-testid="queued-run-exhume-link"
                      className="underline text-emerald-300 hover:text-emerald-100"
                    >
                      Watch the Exhume
                    </a>
                  )}
                  <a
                    href={routes.run(queuedRunId)}
                    data-testid="queued-run-link"
                    className="underline text-emerald-300 hover:text-emerald-100"
                  >
                    Open the run
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Form Actions */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting}
              data-testid="submit-start-run"
              className="crypt-btn-primary px-5 py-2.5 rounded text-xs"
            >
              {submitting ? "Submitting..." : "Start Live Run"}
            </button>

            <button
              type="button"
              onClick={handleAutopsy}
              data-testid="submit-diagnose-autopsy"
              className="crypt-btn-ghost px-5 py-2.5 rounded text-xs"
            >
              Diagnose (Autopsy)
            </button>
          </div>
        </form>
      </section>

      {/* Recent Runs Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-semibold text-bone">
              Recent Recorded Runs
            </h2>
          </div>
          <a
            href={routes.history()}
            className="text-xs text-ash hover:text-emerald-300 underline underline-offset-4 transition-colors"
          >
            View all history
          </a>
        </div>
        <RecentRuns limit={5} />
      </section>

      {/* Requirement 34.10 Footer in every Gate state */}
      <footer
        data-testid="gate-footer"
        className="mt-auto pt-4 pb-6 text-center text-xs text-ash space-y-4"
      >
        <CryptOrnament kind="divider" />
        <p>{GATE_FOOTER}</p>
      </footer>
    </div>
  );
}
