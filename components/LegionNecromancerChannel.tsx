"use client";

import React, { useState } from "react";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";

export type ChannelFilter = "all" | "decisions" | "asks" | "approvals" | "messages";

export interface ChannelEntry {
  id: string;
  seq: number;
  ts: number;
  kind: string;
  type: "decision" | "ask" | "approval" | "message";
  title?: string;
  text: string;
  actor?: string;
  skeletonId?: string;
  refs?: string[];
  options?: string[];
  answered?: boolean;
}

export interface LegionNecromancerChannelProps {
  entries: ChannelEntry[];
  initialFilter?: ChannelFilter;
}

export function LegionNecromancerChannel({
  entries,
  initialFilter = "all",
}: LegionNecromancerChannelProps) {
  const [activeFilter, setActiveFilter] = useState<ChannelFilter>(initialFilter);

  const filteredEntries = entries.filter((entry) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "decisions") return entry.type === "decision";
    if (activeFilter === "asks") return entry.type === "ask";
    if (activeFilter === "approvals") return entry.type === "approval";
    if (activeFilter === "messages") return entry.type === "message";
    return true;
  });

  return (
    <div
      data-ui-element="legion-necromancer-channel"
      data-ui-state={filteredEntries.length === 0 ? "empty" : "populated"}
      data-ui-variant={activeFilter}
      className="crypt-panel p-5 space-y-4 font-mono text-bone"
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-white/[0.08] pb-3 gap-3">
        <div className="flex items-start gap-2.5">
          <CryptOrnament kind="arch-sigil" className="w-4 h-4 text-emerald-400 mt-0.5" />
          <div>
            <h3 className="text-base font-bold text-bone">Necromancer Channel</h3>
            <p className="text-xs text-ash mt-0.5">
              Decisions, asks, approvals and Skeleton communication
            </p>
          </div>
        </div>

        {/* Filters (Requirement 37.14) */}
        <div className="flex flex-wrap gap-1.5">
          {(["all", "decisions", "asks", "approvals", "messages"] as const).map((filter) => {
            const isSelected = activeFilter === filter;
            const label = filter.charAt(0).toUpperCase() + filter.slice(1);
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                  isSelected
                    ? "bg-emerald-950/60 text-emerald-200 border-[var(--necromancy-emerald-border)] font-semibold"
                    : "bg-recessed text-ash border-white/[0.08] hover:text-bone hover:border-white/20"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Entry List */}
      <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
        {filteredEntries.length === 0 ? (
          <div className="crypt-well text-xs text-dust p-5 text-center">
            {activeFilter === "decisions"
              ? "No decisions recorded yet."
              : activeFilter === "asks"
              ? "No asks recorded yet."
              : activeFilter === "approvals"
              ? "No approvals recorded yet."
              : activeFilter === "messages"
              ? "No messages recorded yet."
              : "No channel entries recorded yet."}
          </div>
        ) : (
          filteredEntries.map((entry) => {
            const isDecision = entry.type === "decision";
            const hasRefs = entry.refs && entry.refs.length > 0;

            const tone: "violet" | "amber" | "emerald" | "neutral" =
              entry.type === "decision"
                ? "violet"
                : entry.type === "ask"
                ? "amber"
                : entry.type === "approval"
                ? "emerald"
                : "neutral";

            const accentBorder =
              entry.type === "decision"
                ? "border-l-2 border-l-violet-400/70"
                : entry.type === "ask"
                ? "border-l-2 border-l-amber-400/70"
                : entry.type === "approval"
                ? "border-l-2 border-l-emerald-400/70"
                : "border-l-2 border-l-white/15";

            return (
              <div
                key={entry.id || `entry-${entry.seq}`}
                className={`crypt-well text-xs p-3 space-y-2 ${accentBorder}`}
              >
                <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5 gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusPill
                      tone={tone}
                      label={entry.type}
                      className="text-[10px] px-2 py-0"
                    />
                    {entry.actor && (
                      <span className="text-parchment font-semibold">{entry.actor}</span>
                    )}
                    {entry.skeletonId && (
                      <span className="text-dust">({entry.skeletonId})</span>
                    )}
                  </div>
                  <span className="text-dust text-[10px] tabular-nums shrink-0">
                    seq #{entry.seq}
                  </span>
                </div>

                <div className="text-bone whitespace-pre-wrap leading-relaxed">
                  {entry.text}
                </div>

                {/* Evidence links or "no evidence cited" (Requirement 28.5, 37.14) */}
                {isDecision && (
                  <div className="pt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-dust">Evidence:</span>
                    {hasRefs ? (
                      entry.refs!.map((ref, idx) => (
                        <span
                          key={idx}
                          className="px-1.5 py-0.5 bg-slab text-violet-300 border border-[var(--spectral-violet-border)] rounded"
                          title={`Evidence reference: ${ref}`}
                        >
                          [{ref}]
                        </span>
                      ))
                    ) : (
                      <span className="px-1.5 py-0.5 bg-slab text-amber-300/90 border border-[var(--arcane-amber-border)] rounded italic">
                        no evidence cited
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default LegionNecromancerChannel;
