"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import { StatusPill } from "@/components/ui/StatusPill";
import { KillSwitchModal, type KillSwitchModalLevel } from "@/components/KillSwitchModal";
import { routes } from "@/lib/ui/run-routes";
import {
  executeKillSwitch,
  getAdminSession,
  getKillSwitch,
  getPromotionAudit,
  getQueue,
  listAdminRuns,
  listInviteCodes,
  runAdminAction,
  signInAdmin,
  type AdminApiResult,
  type AdminKillSwitchData,
  type AdminKillSwitchPreview,
  type AdminRunData,
} from "@/lib/ui/admin-api";

export interface AdminInviteCodeView {
  codeHash: string;
  allowedRunCount?: number;
  usedRunCount?: number;
  expiresAt?: number | null;
  label?: string | null;
}

export interface AdminRunView {
  runId: string;
  repository?: string | null;
  outcome?: string | null;
  phase?: string | null;
  isPublished?: boolean;
  isRemoved?: boolean;
  reviewed?: boolean;
}

export interface AdminPromotionAuditView {
  present: boolean;
  verified: boolean;
  actor?: string | null;
  signedAt?: number | null;
}

export interface AdminProbeP15View {
  getUsageAdvertised: boolean;
}

export interface AdminDashboardProps {
  /** Explicit session state (tests and SSR). When omitted the client fetches it. */
  authenticated?: boolean;
  actor?: { id: string; role: string } | null;
  inviteCodes?: AdminInviteCodeView[] | null;
  runs?: AdminRunView[] | null;
  promotionAudit?: AdminPromotionAuditView | null;
  probeP15?: AdminProbeP15View | null;
  activeRunCount?: number;
  queuedRunCount?: number;
  /** Optional sign-in error surfaced by the client flow (tests and SSR). */
  signInError?: string | null;
}

const PRODUCTION_LOCK_MESSAGE =
  "Production mode is locked. A signed pre-promotion audit record is required before the Necromancer can switch to production mode.";

const PRODUCTION_MODE_DEPLOYMENT_MESSAGE =
  "Switching to production mode is done in the deployment configuration.";

const P15_CREDIT_NOTE =
  "The Kiro CLI does not advertise _kiro/account/getUsage, so the credit balance cannot be read here. Check the credit balance in the Kiro portal.";

// The logical redaction fields the Admin redact route accepts. Kept in sync with
// the route's allowed list so the dashboard form can validate before sending.
const ALLOWED_REDACTION_FIELDS: readonly string[] = [
  "logs",
  "stdout",
  "stderr",
  "diff",
  "messages",
  "prompts",
  "commands",
  "report",
];

const KILL_SWITCH_UNAVAILABLE_MESSAGE = "Affected run count unavailable";

function mapRunData(raw: AdminRunData): AdminRunView {
  const metadata =
    raw.metadata && typeof raw.metadata === "object"
      ? (raw.metadata as Record<string, unknown>)
      : {};
  return {
    runId: raw.runId,
    repository: raw.repository ?? null,
    outcome: raw.outcome ?? null,
    phase: raw.phase ?? null,
    isPublished: raw.isPublished === true,
    isRemoved: raw.isRemoved === true,
    reviewed: raw.reviewed === true || metadata.reviewed === true,
  };
}

export function AdminDashboard({
  authenticated,
  actor,
  inviteCodes,
  runs,
  promotionAudit,
  probeP15,
  activeRunCount,
  queuedRunCount,
  signInError,
}: AdminDashboardProps) {
  const [session, setSession] = useState<{ authenticated: boolean; actor: { id: string; role: string } | null }>(
    { authenticated: authenticated ?? false, actor: actor ?? null }
  );
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [killSwitchOpen, setKillSwitchOpen] = useState<boolean>(false);
  const [token, setToken] = useState<string>("");
  const [signInErrorState, setSignInErrorState] = useState<string | null>(null);
  const [signInPending, setSignInPending] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [fetchedCodes, setFetchedCodes] = useState<AdminInviteCodeView[] | null>(null);
  const [fetchedRuns, setFetchedRuns] = useState<AdminRunView[] | null>(null);
  const [fetchedAudit, setFetchedAudit] = useState<AdminPromotionAuditView | null>(null);
  const [fetchedQueueDepth, setFetchedQueueDepth] = useState<number | null>(null);
  const [sectionErrors, setSectionErrors] = useState<Record<string, string>>({});
  const [runActionError, setRunActionError] = useState<string | null>(null);
  const [killSwitchError, setKillSwitchError] = useState<string | null>(null);
  const [killSwitchResult, setKillSwitchResult] = useState<string | null>(null);
  const [fetchedKillPreviews, setFetchedKillPreviews] = useState<AdminKillSwitchPreview[] | null>(
    null
  );
  const [killPreviewsUnavailable, setKillPreviewsUnavailable] = useState<boolean>(false);
  const [redactTarget, setRedactTarget] = useState<string | null>(null);
  const [redactFieldsInput, setRedactFieldsInput] = useState<string>("");
  const [redactError, setRedactError] = useState<string | null>(null);

  // Only the client fetches the session; an explicit prop (tests, SSR) wins.
  useEffect(() => {
    if (authenticated !== undefined) return;
    let cancelled = false;
    getAdminSession()
      .then((result) => {
        if (cancelled || !result.ok) return;
        setSession({
          authenticated: result.data.authenticated === true,
          actor: result.data.actor ?? null,
        });
      })
      .catch(() => {
        // A failed lookup leaves the dashboard in the sign-in state.
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  // After sign-in (and only then) load the admin data through the typed
  // wrappers. Explicit props win, so a caller that supplies them (tests, SSR)
  // never triggers a fetch.
  useEffect(() => {
    if (!session.authenticated) return;
    if (authenticated !== undefined) return;
    let cancelled = false;
    setLoading(true);
    setSectionErrors({});
    (async () => {
      const [codes, runList, audit, queue, killSwitch] = await Promise.all([
        listInviteCodes(),
        listAdminRuns(),
        getPromotionAudit(),
        getQueue(),
        getKillSwitch(),
      ]);
      if (cancelled) return;
      const errors: Record<string, string> = {};
      if (codes.ok) {
        setFetchedCodes(codes.data.inviteCodes ?? []);
      } else {
        errors.inviteCodes = codes.message;
      }
      if (runList.ok) {
        setFetchedRuns(runList.data.map(mapRunData));
      } else {
        errors.runs = runList.message;
      }
      if (audit.ok) {
        // Fail closed: an unreadable or unverified audit is treated as missing.
        setFetchedAudit({
          present: audit.data.present === true,
          verified: audit.data.present === true && audit.data.verified === true,
          actor: audit.data.actor ?? null,
          signedAt: audit.data.signedAt ?? null,
        });
      } else {
        errors.promotionAudit = audit.message;
        setFetchedAudit(null);
      }
      if (queue.ok) {
        setFetchedQueueDepth(queue.data.queue?.depth ?? 0);
      } else {
        errors.queue = queue.message;
      }
      applyKillPreviews(killSwitch);
      setSectionErrors(errors);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session.authenticated, authenticated]);

  async function handleSignIn(): Promise<void> {
    const value = token.trim();
    if (value.length === 0) {
      setSignInErrorState("Enter the admin token to sign in.");
      return;
    }
    setSignInPending(true);
    setSignInErrorState(null);
    const result = await signInAdmin(value);
    if (!result.ok) {
      setSignInErrorState(result.message);
      setSignInPending(false);
      return;
    }
    // Re-read the session so the dashboard reflects the server-trusted actor.
    const reloaded = await getAdminSession();
    const nextSession = reloaded.ok
      ? {
          authenticated: reloaded.data.authenticated === true,
          actor: reloaded.data.actor ?? null,
        }
      : {
          authenticated: result.data.authenticated === true,
          actor: result.data.actor ?? null,
        };
    setSession(nextSession);
    setToken("");
    setSignInPending(false);
  }

  async function handleReviewChange(runId: string, checked: boolean): Promise<void> {
    setReviewed((prev) => ({ ...prev, [runId]: checked }));
    if (!checked) {
      return;
    }
    setRunActionError(null);
    const result = await runAdminAction(runId, { action: "review" });
    if (!result.ok) {
      // The server refused the review, so the local gate must not stay open.
      setReviewed((prev) => ({ ...prev, [runId]: false }));
      setRunActionError(result.message);
    }
  }

  async function handleRunAction(
    runId: string,
    action: "publish" | "redact" | "hide"
  ): Promise<void> {
    setRunActionError(null);
    const result = await runAdminAction(runId, { action });
    if (!result.ok) {
      setRunActionError(result.message);
      return;
    }
    const reloaded = await listAdminRuns();
    if (reloaded.ok) {
      setFetchedRuns(reloaded.data.map(mapRunData));
    }
  }

  async function handleKillSwitchConfirm(
    level: KillSwitchModalLevel,
    phrase: string
  ): Promise<void> {
    setKillSwitchError(null);
    setKillSwitchResult(null);
    const result = await executeKillSwitch(level, phrase);
    if (!result.ok) {
      // A 409 means the affected runs changed after the Admin read the count, so the typed
      // phrase is now stale. Surface the new count and reload the previews; the modal keeps
      // Execute disabled until the operator types the new phrase.
      if (result.status === 409) {
        setKillSwitchError(
          "The number of affected runs changed. Review the new count and type the new phrase."
        );
        void refreshKillSwitchPreviews();
      } else {
        // Keep the modal open with the error so the operator can retry.
        setKillSwitchError(result.message);
      }
      return;
    }
    setKillSwitchResult(`Kill switch executed: ${level}.`);
    setKillSwitchOpen(false);
  }

  /** Records the kill-switch previews, or marks them unavailable so the UI never shows 0. */
  function applyKillPreviews(result: AdminApiResult<AdminKillSwitchData>): void {
    if (result.ok && Array.isArray(result.data.previews)) {
      setFetchedKillPreviews(result.data.previews);
      setKillPreviewsUnavailable(false);
    } else {
      setFetchedKillPreviews(null);
      setKillPreviewsUnavailable(true);
    }
  }

  /** Re-reads the kill-switch previews; used when the modal opens. */
  async function refreshKillSwitchPreviews(): Promise<void> {
    const result = await getKillSwitch();
    applyKillPreviews(result);
  }

  function openKillSwitch(): void {
    // Drop the previously loaded previews so the modal cannot arm Execute against a stale
    // count; it stays disabled until the refresh below succeeds and the phrase is rebuilt from
    // the fresh count.
    setKillSwitchError(null);
    setFetchedKillPreviews(null);
    setKillPreviewsUnavailable(false);
    setKillSwitchOpen(true);
    void refreshKillSwitchPreviews();
  }

  /** Opens the redact form for a run, resetting any prior input and error. */
  function openRedactForm(runId: string): void {
    setRedactTarget(runId);
    setRedactFieldsInput("");
    setRedactError(null);
  }

  function closeRedactForm(): void {
    setRedactTarget(null);
    setRedactFieldsInput("");
    setRedactError(null);
  }

  /**
   * Validates the requested field names against the route's allowed redaction
   * fields, then sends the redact action. An empty or invalid list is rejected
   * client-side and never sent (the route also rejects an empty target list).
   */
  async function submitRedact(runId: string): Promise<void> {
    const requested = redactFieldsInput
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (requested.length === 0) {
      setRedactError("Enter at least one redaction field.");
      return;
    }
    const invalid = requested.filter((name) => !ALLOWED_REDACTION_FIELDS.includes(name));
    if (invalid.length > 0) {
      setRedactError(
        `Unsupported redaction field${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}.`
      );
      return;
    }
    setRedactError(null);
    setRunActionError(null);
    const result = await runAdminAction(runId, { action: "redact", fields: requested });
    if (!result.ok) {
      setRedactError(result.message);
      setRunActionError(result.message);
      return;
    }
    closeRedactForm();
    setReviewed((current) => ({ ...current, [runId]: true }));
    const reloaded = await listAdminRuns();
    if (reloaded.ok) {
      setFetchedRuns(reloaded.data.map(mapRunData));
    }
  }

  const shownSignInError = signInErrorState ?? signInError ?? null;

  // Unauthenticated: the sign-in state is the ONLY thing rendered. No invite
  // codes, runs, settings or kill controls are exposed.
  if (!session.authenticated) {
    return (
      <div
        data-testid="admin-signin"
        data-ui-element="admin-dashboard"
        data-ui-state="unauthenticated"
        className="crypt-panel-engraved p-6 md:p-8 font-mono space-y-4 max-w-xl mx-auto"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded border border-[var(--necromancy-emerald-border)] bg-emerald-950/40 text-emerald-400">
            <CryptOrnament kind="arch-sigil" className="w-6 h-6" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/90 font-semibold">
              ADMIN
            </div>
            <h1 className="text-xl font-bold text-bone">Admin sign-in</h1>
          </div>
        </div>
        <p className="text-sm text-ash">
          Sign in to manage this Git-Graveyard deployment.
        </p>
        <label htmlFor="admin-token" className="text-xs text-ash block">
          Admin token
        </label>
        <input
          id="admin-token"
          data-testid="admin-token-input"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="w-full crypt-well px-3 py-2 text-sm text-bone placeholder:text-dust focus:outline-none"
          placeholder="Enter the admin token"
        />
        <button
          type="button"
          data-testid="admin-signin-button"
          onClick={handleSignIn}
          disabled={signInPending}
          className="crypt-btn-primary px-4 py-2 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Sign in
        </button>
        {shownSignInError ? (
          <p data-testid="admin-signin-error" className="text-xs text-red-300">
            {shownSignInError}
          </p>
        ) : null}
        <p className="text-xs text-dust">
          The token is verified on the server and is never stored in the page.
        </p>
      </div>
    );
  }

  const codes = inviteCodes ?? fetchedCodes ?? [];
  const runList = runs ?? fetchedRuns ?? [];
  const audit = promotionAudit !== undefined ? promotionAudit : fetchedAudit;
  const auditVerified = Boolean(audit?.present && audit?.verified);

  // The server list is authoritative: it already excludes unfinished runs and
  // includes killed/failed runs in other phases, so the client must not re-filter.
  const finishedRuns = runList;

  // Derive the affected run counts from the kill-switch previews so the modal and
  // the summary reflect the server's blast radius. When the previews cannot be
  // read the counts stay undefined (never defaulted to 0) and the UI shows an
  // explicit unavailable message with Execute kept disabled.
  const previewByLevel = new Map<string, AdminKillSwitchPreview>();
  if (fetchedKillPreviews) {
    for (const preview of fetchedKillPreviews) {
      previewByLevel.set(preview.level, preview);
    }
  }
  const activeFromPreview = previewByLevel.get("stop_gracefully")?.affectedRunCount;
  const queuedFromPreview = previewByLevel.get("pause_new_runs")?.affectedRunCount;
  const active = activeFromPreview ?? activeRunCount;
  const queued = queuedFromPreview ?? queuedRunCount ?? fetchedQueueDepth;
  const killCountsKnown = active !== undefined && queued !== undefined;

  return (
    <div
      data-testid="admin-dashboard"
      data-ui-element="admin-dashboard"
      data-ui-state="authenticated"
      className="space-y-6 font-mono"
    >
      <header className="crypt-panel-engraved p-5 md:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="mt-0.5 p-2 rounded border border-[var(--necromancy-emerald-border)] bg-emerald-950/40 text-emerald-400">
            <CryptOrnament kind="arch-sigil" className="w-6 h-6" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/90 font-semibold">
              ADMIN
            </div>
            <h1 className="text-xl md:text-2xl font-bold text-bone">Admin dashboard</h1>
            <p className="text-xs text-ash mt-1">
              Signed in as {session.actor?.id ?? "owner"}
              {session.actor?.role ? ` (${session.actor.role})` : ""}.
            </p>
          </div>
        </div>
        <StatusPill tone="emerald" label="Signed in" testId="admin-signed-in-pill" />
      </header>

      {/* Requirement 44.14: production mode stays locked without a signed pre-promotion audit */}
      <section
        data-testid="admin-production-mode"
        className="crypt-panel p-4 space-y-2 border-l-2 border-l-amber-400/70"
      >
        <h2 className="text-sm font-semibold text-bone">Necromancer production mode</h2>
        {auditVerified ? (
          <p data-testid="admin-production-unlocked" className="text-xs text-emerald-300">
            A signed pre-promotion audit record exists. The Necromancer can be switched
            to production mode.
          </p>
        ) : (
          <p data-testid="admin-production-lock" className="text-xs text-amber-200">
            {PRODUCTION_LOCK_MESSAGE}
          </p>
        )}
        <p data-testid="admin-production-deployment-note" className="text-xs text-ash">
          {PRODUCTION_MODE_DEPLOYMENT_MESSAGE}
        </p>
        <button
          type="button"
          data-testid="admin-production-toggle"
          disabled
          className="crypt-btn-ghost px-3 py-1.5 rounded text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Switch Necromancer to production mode
        </button>
      </section>

      {/* Probe P15: credit balance source */}
      {probeP15 && !probeP15.getUsageAdvertised ? (
        <section
          data-testid="admin-p15-credit-note"
          className="crypt-panel p-4 text-xs text-amber-200 border-l-2 border-l-amber-400/70"
        >
          {P15_CREDIT_NOTE}
        </section>
      ) : null}

      {/* Invite codes */}
      <section data-testid="admin-invite-codes" className="crypt-panel p-4 space-y-3">
        <h2 className="text-sm font-semibold text-bone">Invite codes</h2>
        {loading && inviteCodes === undefined ? (
          <p data-testid="admin-invite-loading" className="text-xs text-ash">
            Loading invite codes...
          </p>
        ) : sectionErrors.inviteCodes ? (
          <p data-testid="admin-invite-error" className="text-xs text-red-300">
            {sectionErrors.inviteCodes}
          </p>
        ) : codes.length === 0 ? (
          <p data-testid="admin-invite-empty" className="text-xs text-ash">
            No invite codes have been created yet.
          </p>
        ) : (
          <ul className="space-y-2 text-xs text-parchment">
            {codes.map((code) => (
              <li
                key={code.codeHash}
                data-testid="admin-invite-code-item"
                className="crypt-well px-3 py-1.5 flex flex-wrap items-center justify-between gap-2"
              >
                <span className="text-dust">
                  {code.label ?? "invite code"} | {code.codeHash.slice(0, 8)}
                </span>
                <span>
                  {code.usedRunCount ?? 0} / {code.allowedRunCount ?? 0} runs used
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* Finished runs: publish, redact and hide */}
      <section data-testid="admin-runs" className="crypt-panel p-4 space-y-3">
        <h2 className="text-sm font-semibold text-bone">Finished runs</h2>
        {loading && runs === undefined ? (
          <p data-testid="admin-runs-loading" className="text-xs text-ash">
            Loading runs...
          </p>
        ) : sectionErrors.runs ? (
          <p data-testid="admin-runs-error" className="text-xs text-red-300">
            {sectionErrors.runs}
          </p>
        ) : finishedRuns.length === 0 ? (
          <p data-testid="admin-runs-empty" className="text-xs text-ash">
            No finished runs are waiting for review.
          </p>
        ) : (
          <ul className="space-y-3">
            {finishedRuns.map((run) => {
              const isReviewed = reviewed[run.runId] ?? run.reviewed === true;
              return (
                <li
                  key={run.runId}
                  data-testid={`admin-run-${run.runId}`}
                  className="crypt-well p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-bone">
                      {run.repository ?? run.runId}
                    </span>
                    <span className="text-[11px] text-dust">
                      {run.isRemoved
                        ? "Removed by the owner"
                        : run.isPublished
                        ? "Published"
                        : "Not published"}
                    </span>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-ash">
                    <input
                      type="checkbox"
                      data-testid={`admin-review-confirm-${run.runId}`}
                      checked={isReviewed}
                      onChange={(event) => handleReviewChange(run.runId, event.target.checked)}
                    />
                    I have reviewed this run and confirmed the redactions.
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`admin-publish-${run.runId}`}
                      disabled={!isReviewed}
                      onClick={() => handleRunAction(run.runId, "publish")}
                      className="crypt-btn-primary px-3 py-1 rounded text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Publish to History
                    </button>
                    <button
                      type="button"
                      data-testid={`admin-redact-${run.runId}`}
                      onClick={() => openRedactForm(run.runId)}
                      className="crypt-btn-ghost px-3 py-1 rounded text-[11px]"
                    >
                      Redact
                    </button>
                    <button
                      type="button"
                      data-testid={`admin-hide-${run.runId}`}
                      onClick={() => handleRunAction(run.runId, "hide")}
                      className="crypt-btn-ghost px-3 py-1 rounded text-[11px]"
                    >
                      Hide (Removed by the owner)
                    </button>
                  </div>
                  {redactTarget === run.runId ? (
                    <div
                      data-testid={`admin-redact-form-${run.runId}`}
                      className="crypt-well p-2 space-y-1.5 border border-white/10"
                    >
                      <label
                        htmlFor={`admin-redact-fields-${run.runId}`}
                        className="text-[11px] text-ash block"
                      >
                        Redaction fields (comma separated): {ALLOWED_REDACTION_FIELDS.join(", ")}
                      </label>
                      <input
                        id={`admin-redact-fields-${run.runId}`}
                        data-testid={`admin-redact-fields-input-${run.runId}`}
                        type="text"
                        value={redactFieldsInput}
                        onChange={(event) => setRedactFieldsInput(event.target.value)}
                        placeholder="logs, diff"
                        className="w-full crypt-well px-2 py-1 text-[11px] text-bone placeholder:text-dust focus:outline-none"
                      />
                      {redactError ? (
                        <p
                          data-testid={`admin-redact-error-${run.runId}`}
                          className="text-[11px] text-red-300"
                        >
                          {redactError}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          data-testid={`admin-redact-submit-${run.runId}`}
                          onClick={() => submitRedact(run.runId)}
                          className="crypt-btn-primary px-3 py-1 rounded text-[11px]"
                        >
                          Apply redaction
                        </button>
                        <button
                          type="button"
                          data-testid={`admin-redact-cancel-${run.runId}`}
                          onClick={closeRedactForm}
                          className="crypt-btn-ghost px-3 py-1 rounded text-[11px]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <p data-testid="admin-publish-gate" className="text-[11px] text-dust">
          Publishing to History requires an explicit Admin review and redaction
          confirmation.
        </p>
        {runActionError ? (
          <p data-testid="admin-run-action-error" className="text-xs text-red-300">
            {runActionError}
          </p>
        ) : null}
      </section>

      {/* Kill switch */}
      <section data-testid="admin-kill-switch" className="crypt-panel p-4 space-y-2">
        <h2 className="text-sm font-semibold text-bone">Kill switch</h2>
        {killCountsKnown ? (
          <p data-testid="admin-kill-switch-counts" className="text-xs text-ash">
            {active} active and {queued} queued runs are affected by a kill-switch
            level.
          </p>
        ) : (
          <p data-testid="admin-kill-switch-unavailable" className="text-xs text-amber-200">
            {KILL_SWITCH_UNAVAILABLE_MESSAGE}
          </p>
        )}
        {sectionErrors.queue ? (
          <p data-testid="admin-queue-error" className="text-xs text-red-300">
            {sectionErrors.queue}
          </p>
        ) : null}
        {killSwitchResult ? (
          <p data-testid="admin-kill-switch-result" className="text-xs text-emerald-300">
            {killSwitchResult}
          </p>
        ) : null}
        <button
          type="button"
          data-testid="admin-open-kill-switch"
          onClick={openKillSwitch}
          className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
        >
          Open kill switch
        </button>
      </section>

      <KillSwitchModal
        open={killSwitchOpen}
        activeRunCount={active ?? undefined}
        queuedRunCount={queued ?? undefined}
        onClose={() => setKillSwitchOpen(false)}
        onConfirm={handleKillSwitchConfirm}
        error={killSwitchError}
      />

      <footer className="pt-2">
        <Link
          href={routes.history()}
          data-testid="admin-history-link"
          className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
        >
          History Vault
        </Link>
      </footer>
    </div>
  );
}

export default AdminDashboard;