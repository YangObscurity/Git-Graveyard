"use client";

import React, { useEffect, useState } from "react";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";

export interface ApprovalData {
  approvalId: string;
  command: string;
  cwd?: string;
  riskClass?: string;
  reason?: string;
  skeletonId?: string;
  expiresAt?: number;
  candidateSha256?: string;
  grimoireSummary?: string;
  status?: "pending" | "resolved";
  resolution?: string;
}

export interface LegionApprovalCardProps {
  approval: ApprovalData;
  onDecision?: (
    approvalId: string,
    decision: "approve_once" | "approve_pattern" | "deny" | "deny_and_lay_to_rest"
  ) => void;
  disabled?: boolean;
  submitting?: boolean;
}

export function LegionApprovalCard({
  approval,
  onDecision,
  disabled = false,
  submitting = false,
}: LegionApprovalCardProps) {
  const [remainingText, setRemainingText] = useState<string>("");

  useEffect(() => {
    if (!approval.expiresAt) {
      setRemainingText("No expiration deadline");
      return;
    }

    function updateRemaining() {
      const now = Date.now();
      const diffMs = (approval.expiresAt ?? now) - now;
      if (diffMs <= 0) {
        setRemainingText("Expired");
        return;
      }
      const totalSec = Math.floor(diffMs / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      setRemainingText(`Expires in ${mins}m ${secs.toString().padStart(2, "0")}s`);
    }

    updateRemaining();
    const interval = setInterval(updateRemaining, 1000);
    return () => clearInterval(interval);
  }, [approval.expiresAt]);

  const exactCommand = approval.command || "(no command provided)";
  const workingDir = approval.cwd || "/workspace";
  const riskClass = approval.riskClass || "needs_approval";
  const reason = approval.reason || "No explicit reason stated";
  const requestingSkeleton = approval.skeletonId || "Unknown skeleton";
  const expiryTimeText = approval.expiresAt
    ? `${new Date(approval.expiresAt).toISOString()} (${remainingText})`
    : remainingText || "No expiration deadline";

  const isResolved = approval.status === "resolved";
  const isApproved =
    isResolved && (approval.resolution || "").toLowerCase().startsWith("approve");
  const isRejected = isResolved && !isApproved;

  const uiState: "pending" | "submitting" | "approved" | "rejected" = submitting
    ? "submitting"
    : isApproved
    ? "approved"
    : isRejected
    ? "rejected"
    : "pending";

  const cardToneClass = isApproved
    ? "border-emerald-500/45 shadow-[0_0_24px_-8px_rgba(16,185,129,0.28)]"
    : isRejected
    ? "border-rose-500/45 shadow-[0_0_24px_-8px_rgba(244,63,94,0.28)]"
    : "border-amber-500/50 shadow-[0_0_24px_-8px_rgba(245,158,11,0.26)]";

  const sealColorClass = isApproved
    ? "text-emerald-400"
    : isRejected
    ? "text-rose-400"
    : "text-amber-400";

  return (
    <div
      data-ui-element="legion-approval-card"
      data-ui-state={uiState}
      data-approval-id={approval.approvalId}
      className={`crypt-panel-engraved p-5 space-y-4 font-mono text-bone ${cardToneClass}`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-white/[0.08] pb-3 gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <CryptOrnament kind="wax-seal" className={`w-7 h-7 ${sealColorClass}`} />
          <StatusPill
            tone={isApproved ? "emerald" : isRejected ? "crimson" : "amber"}
            pulse={!isResolved}
            label={
              isResolved
                ? isApproved
                  ? "Seal Approved"
                  : "Seal Denied"
                : "Approval Required"
            }
            uiState={uiState}
          />
          <span className="text-xs text-ash">ID: {approval.approvalId}</span>
        </div>
        <div className="text-left sm:text-right text-xs text-amber-300">
          <span className="font-semibold tabular-nums">{remainingText}</span>
        </div>
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <span className="text-[11px] uppercase tracking-wider text-dust block">
            Exact Command
          </span>
          <code className="crypt-well text-xs md:text-sm text-amber-200 p-2.5 block overflow-x-auto mt-1">
            {exactCommand}
          </code>
        </div>

        {(approval.candidateSha256 || approval.grimoireSummary) && (
          <div className="crypt-well p-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs border-amber-500/20">
            {approval.candidateSha256 && (
              <div className="min-w-0">
                <span className="text-[11px] uppercase tracking-wider text-dust block">
                  candidateSha256 Verification
                </span>
                <code className="text-emerald-300 break-all text-xs mt-0.5 block">
                  {approval.candidateSha256}
                </code>
              </div>
            )}
            {approval.grimoireSummary && (
              <div>
                <span className="text-[11px] uppercase tracking-wider text-dust block">
                  Grimoire Gate Summary
                </span>
                <span className="text-parchment mt-0.5 block">
                  {approval.grimoireSummary}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="crypt-well p-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-dust">Working Directory: </span>
            <span className="text-bone">{workingDir}</span>
          </div>
          <div>
            <span className="text-dust">Risk Class: </span>
            <span className="text-amber-300 font-semibold">{riskClass}</span>
          </div>
          <div>
            <span className="text-dust">Requesting Skeleton: </span>
            <span className="text-bone">{requestingSkeleton}</span>
          </div>
          <div>
            <span className="text-dust">Expiry Time: </span>
            <span className="text-parchment">{expiryTimeText}</span>
          </div>
        </div>

        <div className="text-xs px-1">
          <span className="text-dust">Reason: </span>
          <span className="text-parchment">{reason}</span>
        </div>
      </div>

      {isResolved ? (
        <div className="text-xs text-ash border-t border-white/[0.08] pt-3">
          Status: Resolved ({approval.resolution || "completed"})
        </div>
      ) : (
        <div className="border-t border-white/[0.08] pt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onDecision?.(approval.approvalId, "approve_once")}
            disabled={disabled || submitting}
            className="crypt-btn-primary px-3 py-1.5 text-xs rounded"
          >
            Approve once
          </button>
          <button
            type="button"
            onClick={() => onDecision?.(approval.approvalId, "approve_pattern")}
            disabled={disabled || submitting}
            className="crypt-btn-ghost px-3 py-1.5 text-xs rounded border-emerald-500/40 text-emerald-300 hover:border-emerald-400/60"
          >
            Approve this pattern for the run
          </button>
          <button
            type="button"
            onClick={() => onDecision?.(approval.approvalId, "deny")}
            disabled={disabled || submitting}
            className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onDecision?.(approval.approvalId, "deny_and_lay_to_rest")}
            disabled={disabled || submitting}
            className="crypt-btn-danger px-3 py-1.5 text-xs rounded"
          >
            Deny and lay to rest
          </button>
        </div>
      )}
    </div>
  );
}

export default LegionApprovalCard;
