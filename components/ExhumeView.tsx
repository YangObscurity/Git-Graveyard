"use client";

import React, { useEffect, useState } from "react";
import type { DeathCertificate } from "@/lib/exhume/death-certificate";
import { postControl, startRun } from "@/lib/ui/api";
import { certificateFromRun } from "@/lib/ui/certificate";
import { rememberInviteCode } from "@/lib/ui/invite-session";
import { elapsedSeconds as runElapsedSeconds } from "@/lib/ui/run-model";
import { announceRunPhase } from "@/lib/ui/run-phase-bus";
import { describeOutcome, routes } from "@/lib/ui/run-routes";
import { useRunStream } from "@/lib/ui/use-run-stream";
import { CommandRow } from "./CommandRow";
import { DeathCertificateView } from "./DeathCertificateView";
import { StatusPill } from "./ui/StatusPill";

export interface ExhumeViewProps {
  repoUrl: string;
  sha?: string;
  initialInviteCode?: string;
  initialRunId?: string;
  initialCertificate?: DeathCertificate | null;
  caps?: Record<string, unknown> | null;
  queueState?: string | null;
}

type ExhumeStage =
  | "idle"
  | "queued"
  | "running"
  | "certificate_ready"
  | "ended"
  | "cancelled";

function formatCapValue(value: unknown): string {
  if (value === null || value === undefined) return "not reported";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatClock(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function ExhumeView({
  repoUrl,
  sha,
  initialInviteCode = "",
  initialRunId,
  initialCertificate,
  caps: propCaps,
  queueState: propQueueState,
}: ExhumeViewProps) {
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  // Queue position from the start-run response, until the event log reports one.
  const [admittedPosition, setAdmittedPosition] = useState<number | null>(null);
  const [queueStatusText, setQueueStatusText] = useState<string | null>(
    propQueueState ?? null
  );
  const [exhumeError, setExhumeError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // The run's own event log is the only source for queue position, command
  // rows and the certificate.
  const { view, reconnecting, loadError } = useRunStream(runId ?? "", {
    live: Boolean(runId) && !initialCertificate,
  });

  const certificate: DeathCertificate | null =
    initialCertificate ?? (runId ? certificateFromRun(view, runId) : null);

  const stage: ExhumeStage = certificate
    ? "certificate_ready"
    : !runId
    ? "idle"
    : view.phase === "done"
    ? view.outcome === "cancelled" || view.outcome === "killed"
      ? "cancelled"
      : "ended"
    : view.phase === "unknown" || view.phase === "queued"
    ? "queued"
    : "running";

  const queuePosition = view.queuePosition ?? admittedPosition;
  const commandRows = view.commands;
  const elapsedSeconds = runElapsedSeconds(view, now);
  const displaySha = sha ? sha.slice(0, 7) : "HEAD";

  // Live-run status shown before a run is started
  useEffect(() => {
    if (stage !== "idle" || propQueueState) {
      return;
    }
    let cancelled = false;

    async function fetchHealth() {
      try {
        const res = await fetch("/api/health");
        if (cancelled) return;
        if (!res.ok) {
          setQueueStatusText("Live run status is currently unavailable.");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setQueueStatusText(
          typeof data.badgeText === "string" && data.badgeText
            ? data.badgeText
            : "Live run status was not reported."
        );
      } catch {
        if (!cancelled) {
          setQueueStatusText("Live run status is currently unavailable.");
        }
      }
    }

    fetchHealth();
    return () => {
      cancelled = true;
    };
  }, [stage, propQueueState]);

  // Elapsed clock while running
  useEffect(() => {
    if (stage !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  // Let the nav stepper follow the run.
  useEffect(() => {
    if (runId && view.phase !== "unknown") {
      announceRunPhase({ runId, phase: view.phase, outcome: view.outcome });
    }
  }, [runId, view.phase, view.outcome]);

  async function handleStartExhume(e?: React.FormEvent) {
    if (e) {
      e.preventDefault();
    }
    const cleanCode = inviteCode.trim();
    if (!cleanCode) {
      setExhumeError("An invite code is required to start a live Exhume run.");
      return;
    }

    setIsSubmitting(true);
    setExhumeError(null);

    const result = await startRun({ url: repoUrl, sha, inviteCode: cleanCode });
    setIsSubmitting(false);
    if (!result.ok) {
      setExhumeError(result.message);
      return;
    }
    rememberInviteCode(result.runId, cleanCode);
    setAdmittedPosition(result.queuePosition);
    setRunId(result.runId);
  }

  // The run-control endpoint stops a queued or running run. The stage moves
  // when the resulting run.done event arrives on the stream.
  async function handleCancel() {
    if (!runId) return;
    setIsCancelling(true);
    setExhumeError(null);
    const result = await postControl(runId, "stop", "Failed to cancel the run");
    setIsCancelling(false);
    if (!result.ok) {
      setExhumeError(`${result.message} The run is still active; try again.`);
    }
  }

  function handleStartOver() {
    setRunId(null);
    setAdmittedPosition(null);
    setExhumeError(null);
  }

  const endedOutcome = describeOutcome(view.outcome);

  const exhumeUiState =
    stage === "certificate_ready"
      ? "completed"
      : stage === "ended" || (stage === "idle" && Boolean(exhumeError))
      ? "error"
      : stage === "queued" || stage === "running"
      ? "exhuming"
      : inviteCode.trim()
      ? "ready"
      : "locked";

  const panelAccentClass =
    exhumeUiState === "completed" || exhumeUiState === "ready"
      ? "border-emerald-500/35"
      : exhumeUiState === "exhuming"
      ? "border-amber-500/40"
      : exhumeUiState === "error"
      ? "border-rose-500/40"
      : "";

  const stagePillProps: {
    tone: "emerald" | "amber" | "crimson" | "neutral";
    label: string;
    pulse?: boolean;
  } =
    stage === "certificate_ready"
      ? { tone: "emerald", label: "Certificate Ready" }
      : stage === "running"
      ? { tone: "amber", label: "Exhuming", pulse: true }
      : stage === "queued"
      ? { tone: "amber", label: "Queued", pulse: true }
      : stage === "cancelled"
      ? { tone: "neutral", label: "Cancelled" }
      : stage === "ended"
      ? { tone: endedOutcome.tone, label: endedOutcome.label }
      : exhumeError
      ? { tone: "crimson", label: "Error" }
      : inviteCode.trim()
      ? { tone: "emerald", label: "Ready" }
      : { tone: "amber", label: "Locked" };

  const capEntries =
    propCaps && typeof propCaps === "object" ? Object.entries(propCaps) : [];

  const activeRunNotice = (reconnecting || loadError || exhumeError) &&
    (stage === "queued" || stage === "running") && (
      <div
        data-testid="exhume-stream-notice"
        className="crypt-well p-3 border-l-2 border-l-amber-400 text-xs text-amber-200 space-y-1"
      >
        {exhumeError && <p>{exhumeError}</p>}
        {loadError && <p>{loadError}</p>}
        {reconnecting && (
          <p>
            Reconnecting to the run. Showing events up to #{view.lastSeq}; the
            run keeps going on the server.
          </p>
        )}
      </div>
    );

  return (
    <section
      data-testid="exhume-section"
      data-ui-element="exhume-view"
      data-ui-state={exhumeUiState}
      data-run-id={runId ?? undefined}
      className={`crypt-panel p-6 font-mono text-xs space-y-6 transition-colors ${panelAccentClass}`.trim()}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-base font-bold text-bone uppercase tracking-wider">
              Live Exhume &amp; Death Certificate
            </h2>
            <StatusPill
              tone={stagePillProps.tone}
              pulse={stagePillProps.pulse}
              label={stagePillProps.label}
            />
          </div>
          <p className="text-ash text-xs mt-1">
            Sandbox verification of real install, build, and test behavior.
          </p>
        </div>

        {/* Elapsed clock while running */}
        {stage === "running" && (
          <div
            data-testid="exhume-elapsed-clock"
            className="crypt-well px-3 py-1.5 flex items-center gap-2 text-parchment shrink-0"
          >
            <span className="text-dust uppercase text-[10px]">Elapsed:</span>
            <span className="text-sm font-bold text-amber-300 tabular-nums">
              {formatClock(elapsedSeconds)}
            </span>
          </div>
        )}
      </div>

      {/* Stage 1: IDLE - Requirement 35.9 & 35.10 */}
      {stage === "idle" && (
        <div className="space-y-5" data-testid="exhume-idle-panel">
          {/* What will run */}
          <div className="crypt-well p-4 space-y-2 text-parchment">
            <h3 className="font-semibold text-bone uppercase text-[11px] tracking-wider">
              What will run:
            </h3>
            <p className="text-ash leading-relaxed text-xs">
              A fresh sandbox clones the repository at commit{" "}
              <code className="text-bone font-bold bg-neutral-900 px-1.5 py-0.5 rounded border border-white/10">
                {displaySha}
              </code>
              , then runs the repository&apos;s own install, build and test commands
              on a current Node/Python. The repository&apos;s code will run
              inside the sandbox. The sandbox has limited network access.
            </p>
          </div>

          {/* Caps and queue state */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-ash">
            <div
              data-testid="exhume-caps-info"
              className="crypt-well p-3.5 space-y-1"
            >
              <span className="text-dust uppercase text-[10px] tracking-wider block font-semibold">
                Execution Caps
              </span>
              {capEntries.length > 0 ? (
                <ul className="text-parchment space-y-0.5">
                  {capEntries.map(([key, value]) => (
                    <li key={key}>
                      {key}: {formatCapValue(value)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-parchment">
                  Set by your invite code. The Pact lists the ceilings before
                  you approve it.
                </p>
              )}
            </div>
            <div
              data-testid="exhume-queue-info"
              className="crypt-well p-3.5 space-y-1"
            >
              <span className="text-dust uppercase text-[10px] tracking-wider block font-semibold">
                Admission Queue State
              </span>
              <p className="text-parchment">
                {queueStatusText || "Checking queue capacity..."}
              </p>
            </div>
          </div>

          {/* Invite Code Input and Exhume CTA */}
          <form onSubmit={handleStartExhume} className="space-y-4 pt-2">
            <div>
              <label
                htmlFor="tomb-invite-code"
                className="block text-[11px] uppercase tracking-wider font-medium text-parchment mb-1.5"
              >
                Invite Code
              </label>
              <div className="crypt-well w-full sm:w-96 transition-all focus-within:border-emerald-400/60 focus-within:shadow-[0_0_20px_-6px_rgba(16,185,129,0.35)]">
                <input
                  id="tomb-invite-code"
                  data-testid="tomb-invite-code-input"
                  type="text"
                  autoComplete="off"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Enter invite code to unlock live Exhume"
                  className="w-full px-3.5 py-2.5 bg-transparent text-bone placeholder-neutral-500 text-xs focus:outline-none font-mono"
                />
              </div>
            </div>

            {/* Error notice */}
            {exhumeError && (
              <div
                data-testid="exhume-error-notice"
                className="crypt-well p-3.5 border-l-2 border-l-rose-500 border-rose-500/35 bg-rose-950/30 text-rose-200 text-xs"
              >
                {exhumeError}
              </div>
            )}

            {/* CTA Buttons and Replay link */}
            <div className="flex flex-wrap items-center gap-4 pt-1">
              <button
                type="submit"
                disabled={!inviteCode.trim() || isSubmitting}
                data-testid="start-exhume-button"
                className="crypt-btn-primary px-5 py-2.5 rounded text-xs"
              >
                {isSubmitting ? "Starting Exhume..." : "Exhume"}
              </button>

              {/* Requirement 35.10: Without code, offer link to a Replay */}
              {!inviteCode.trim() && (
                <div
                  data-testid="no-code-replay-offer"
                  className="text-xs text-ash"
                >
                  No invite code?{" "}
                  <a
                    href={routes.history()}
                    className="underline text-parchment hover:text-emerald-300 transition-colors"
                  >
                    Watch the Replay of a recorded run in History
                  </a>
                  .
                </div>
              )}
            </div>
          </form>
        </div>
      )}

      {/* Stage 2: QUEUED - Requirement 35.11 Waiting Room Strip */}
      {stage === "queued" && (
        <div
          data-testid="waiting-room-strip"
          className="crypt-panel p-4 border-l-2 border-l-amber-400 border-amber-500/40 bg-amber-950/20 text-amber-200 text-xs space-y-3"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="font-bold text-sm text-bone block">
                Waiting Room
              </span>
              <p className="mt-0.5 text-amber-300/90">
                {typeof queuePosition === "number" ? (
                  <>
                    You are at position{" "}
                    <span
                      data-testid="exhume-queue-position"
                      className="font-bold text-amber-200"
                    >
                      {queuePosition}
                    </span>{" "}
                    in the admission queue. Your place is kept.
                  </>
                ) : (
                  "Your run is in the admission queue. Your place is kept."
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isCancelling}
              data-testid="cancel-queued-exhume"
              className="crypt-btn-ghost px-3 py-1.5 rounded text-xs self-start sm:self-auto"
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </button>
          </div>
        </div>
      )}

      {/* Stage 3: RUNNING - Requirement 35.12 Row per command as it starts */}
      {stage === "running" && (
        <div className="space-y-4" data-testid="exhume-running-panel">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div className="flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 crypt-pulse-emerald shrink-0" />
              <span className="text-xs text-bone font-semibold">
                Executing sandbox baseline commands...
              </span>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isCancelling}
              data-testid="cancel-running-exhume"
              className="crypt-btn-danger px-3 py-1.5 rounded text-xs"
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </button>
          </div>

          {/* List of Command Rows inside recessed probe log pane */}
          <div className="crypt-well p-3 space-y-2 max-h-96 overflow-y-auto">
            {commandRows.length === 0 ? (
              <div className="text-xs text-dust italic p-4 text-center">
                Waiting for sandbox to initialize...
              </div>
            ) : (
              commandRows.map((cmd) => <CommandRow key={cmd.id} row={cmd} />)
            )}
          </div>
        </div>
      )}

      {activeRunNotice}

      {/* Stage 4: CERTIFICATE READY - Requirement 35.13 */}
      {stage === "certificate_ready" && certificate && (
        <DeathCertificateView
          certificate={certificate}
          runId={runId || undefined}
        />
      )}

      {/* Stage 5: ENDED without a certificate (error, budget stop, ...) */}
      {stage === "ended" && runId && (
        <div
          data-testid="exhume-ended-notice"
          className="crypt-well p-4 border-l-2 border-l-rose-500 text-xs space-y-3"
        >
          <p className="font-semibold text-bone">
            The run ended before a Death Certificate was recorded. Outcome:{" "}
            {endedOutcome.label}.
          </p>
          {(view.error || view.outcomeReason) && (
            <p className="text-parchment">{view.error ?? view.outcomeReason}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={routes.eventLog(runId)}
              className="underline text-parchment hover:text-emerald-300 transition-colors"
            >
              View the kept event log
            </a>
            <button
              type="button"
              onClick={handleStartOver}
              className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            >
              Run Exhume again
            </button>
          </div>
        </div>
      )}

      {/* Stage 6: CANCELLED */}
      {stage === "cancelled" && (
        <div
          data-testid="exhume-cancelled-notice"
          className="crypt-well p-4 text-ash text-xs space-y-3"
        >
          <p className="font-semibold text-bone">
            {view.outcome === "killed"
              ? "The run was stopped by the owner."
              : "Exhume was stopped by the user."}
          </p>
          <button
            type="button"
            onClick={handleStartOver}
            className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
          >
            Run Exhume again
          </button>
        </div>
      )}
    </section>
  );
}
