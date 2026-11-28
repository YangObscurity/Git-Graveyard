"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import { StatusPill } from "@/components/ui/StatusPill";
import { KillSwitchModal } from "@/components/KillSwitchModal";
import { routes } from "@/lib/ui/run-routes";

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
}

const PRODUCTION_LOCK_MESSAGE =
  "Production mode is locked. A signed pre-promotion audit record is required before the Necromancer can switch to production mode.";

const P15_CREDIT_NOTE =
  "The Kiro CLI does not advertise _kiro/account/getUsage, so the credit balance cannot be read here. Check the credit balance in the Kiro portal.";

export function AdminDashboard({
  authenticated,
  actor,
  inviteCodes,
  runs,
  promotionAudit,
  probeP15,
  activeRunCount = 0,
  queuedRunCount = 0,
}: AdminDashboardProps) {
  const [session, setSession] = useState<{ authenticated: boolean; actor: { id: string; role: string } | null }>(
    { authenticated: authenticated ?? false, actor: actor ?? null }
  );
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [killSwitchOpen, setKillSwitchOpen] = useState<boolean>(false);

  // Only the client fetches the session; an explicit prop (tests, SSR) wins.
  useEffect(() => {
    if (authenticated !== undefined) return;
    let cancelled = false;
    fetch("/api/admin/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setSession({
          authenticated: data.authenticated === true,
          actor: data.actor ?? null,
        });
      })
      .catch(() => {
        // A failed lookup leaves the dashboard in the sign-in state.
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

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
          className="w-full crypt-well px-3 py-2 text-sm text-bone placeholder:text-dust focus:outline-none"
          placeholder="Enter the admin token"
        />
        <button
          type="button"
          data-testid="admin-signin-button"
          className="crypt-btn-primary px-4 py-2 rounded text-sm"
        >
          Sign in
        </button>
        <p className="text-xs text-dust">
          The token is verified on the server and is never stored in the page.
        </p>
      </div>
    );
  }

  const codes = inviteCodes ?? [];
  const runList = runs ?? [];
  const auditVerified = Boolean(promotionAudit?.present && promotionAudit?.verified);
  const finishedRuns = runList.filter((run) => (run.phase ?? "").toLowerCase() === "done");

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
        <button
          type="button"
          data-testid="admin-production-toggle"
          disabled={!auditVerified}
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
        {codes.length === 0 ? (
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
        {finishedRuns.length === 0 ? (
          <p data-testid="admin-runs-empty" className="text-xs text-ash">
            No finished runs are waiting for review.
          </p>
        ) : (
          <ul className="space-y-3">
            {finishedRuns.map((run) => {
              const isReviewed = reviewed[run.runId] === true;
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
                      onChange={(event) =>
                        setReviewed((prev) => ({
                          ...prev,
                          [run.runId]: event.target.checked,
                        }))
                      }
                    />
                    I have reviewed this run and confirmed the redactions.
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`admin-publish-${run.runId}`}
                      disabled={!isReviewed}
                      className="crypt-btn-primary px-3 py-1 rounded text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Publish to History
                    </button>
                    <button
                      type="button"
                      data-testid={`admin-redact-${run.runId}`}
                      className="crypt-btn-ghost px-3 py-1 rounded text-[11px]"
                    >
                      Redact
                    </button>
                    <button
                      type="button"
                      data-testid={`admin-hide-${run.runId}`}
                      className="crypt-btn-ghost px-3 py-1 rounded text-[11px]"
                    >
                      Hide (Removed by the owner)
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p data-testid="admin-publish-gate" className="text-[11px] text-dust">
          Publishing to History requires an explicit Admin review and redaction
          confirmation.
        </p>
      </section>

      {/* Kill switch */}
      <section data-testid="admin-kill-switch" className="crypt-panel p-4 space-y-2">
        <h2 className="text-sm font-semibold text-bone">Kill switch</h2>
        <p className="text-xs text-ash">
          {activeRunCount} active and {queuedRunCount} queued runs are affected by a
          kill-switch level.
        </p>
        <button
          type="button"
          data-testid="admin-open-kill-switch"
          onClick={() => setKillSwitchOpen(true)}
          className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
        >
          Open kill switch
        </button>
      </section>

      <KillSwitchModal
        open={killSwitchOpen}
        activeRunCount={activeRunCount}
        queuedRunCount={queuedRunCount}
        onClose={() => setKillSwitchOpen(false)}
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