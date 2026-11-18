"use client";

import React, { useState } from "react";
import { StatusPill } from "./ui/StatusPill";

export interface PactChannelMessage {
  id: string;
  kind: "decision" | "ask" | "approval" | "message" | "log";
  actor: string;
  text: string;
  ts?: number;
  refs?: string[];
}

export interface PactChannelProps {
  messages?: PactChannelMessage[];
  isDrafting?: boolean;
}

function isUserPromptMessage(msg: PactChannelMessage): boolean {
  const actorLower = msg.actor.toLowerCase();
  return actorLower === "user" || actorLower === "operator" || msg.kind === "ask";
}

function getKindBadgeClass(kind: PactChannelMessage["kind"]): string {
  switch (kind) {
    case "decision":
      return "bg-emerald-950/50 border-emerald-500/35 text-emerald-300";
    case "approval":
      return "bg-emerald-950/60 border-emerald-400/40 text-emerald-200";
    case "ask":
      return "bg-amber-950/50 border-amber-500/35 text-amber-300";
    default:
      return "bg-neutral-900/90 border-white/10 text-ash";
  }
}

export function PactChannel({
  messages = [],
  isDrafting = false,
}: PactChannelProps) {
  const [filter, setFilter] = useState<
    "all" | "decision" | "ask" | "approval" | "message"
  >("all");

  const filteredMessages = messages.filter((m) => {
    if (filter === "all") return true;
    if (filter === "decision") return m.kind === "decision";
    if (filter === "ask") return m.kind === "ask";
    if (filter === "approval") return m.kind === "approval";
    if (filter === "message") return m.kind === "message" || m.kind === "log";
    return true;
  });

  const formatTimestamp = (ts?: number) => {
    if (!ts) return "";
    const date = new Date(ts);
    return date.toISOString().slice(11, 19);
  };

  return (
    <div
      data-testid="pact-channel"
      data-ui-element="pact-channel"
      data-ui-state={isDrafting ? "sending" : "idle"}
      className="crypt-panel p-5 font-mono text-xs space-y-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-semibold text-bone tracking-wide uppercase">
              Necromancer Channel
            </h3>
            {isDrafting && (
              <StatusPill
                tone="amber"
                pulse={true}
                label="Drafting"
                testId="pact-channel-drafting-badge"
              />
            )}
          </div>
          <p className="text-ash text-xs mt-1">
            Live planner and necromancer decisions, asks, and guidance.
          </p>
        </div>

        {/* Filter buttons */}
        <div className="flex flex-wrap gap-1.5">
          {(["all", "decision", "ask", "approval", "message"] as const).map(
            (tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilter(tab)}
                className={`px-2.5 py-1 rounded text-[11px] capitalize border transition-colors ${
                  filter === tab
                    ? "bg-emerald-950/50 text-emerald-300 border-emerald-500/45 font-semibold"
                    : "crypt-btn-ghost text-ash hover:text-bone"
                }`}
              >
                {tab === "message" ? "Messages" : tab}
              </button>
            )
          )}
        </div>
      </div>

      {/* Messages Stream */}
      <div
        data-testid="pact-channel-stream"
        className="crypt-well max-h-64 overflow-y-auto space-y-2.5 p-3"
      >
        {filteredMessages.length === 0 ? (
          <div
            data-testid="pact-channel-empty"
            className="text-ash text-xs py-6 text-center"
          >
            No messages in the Necromancer channel yet.
          </div>
        ) : (
          filteredMessages.map((msg) => {
            const isPrompt = isUserPromptMessage(msg);
            return (
              <div
                key={msg.id}
                data-testid={`pact-channel-msg-${msg.id}`}
                className={`p-3 rounded-md border space-y-1.5 ${
                  isPrompt
                    ? "bg-neutral-800/70 border-white/10 border-r-2 border-r-amber-400/70 text-parchment"
                    : "bg-emerald-950/15 border-emerald-500/20 border-l-2 border-l-emerald-500/60 text-parchment"
                }`}
              >
                <div className="flex items-center justify-between text-[11px] text-dust">
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-semibold uppercase ${
                        isPrompt ? "text-amber-300" : "text-emerald-300"
                      }`}
                    >
                      [{msg.actor}]
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${getKindBadgeClass(msg.kind)}`}
                    >
                      {msg.kind}
                    </span>
                  </div>
                  {msg.ts && <span className="tabular-nums">{formatTimestamp(msg.ts)}</span>}
                </div>
                <div className="text-xs text-bone whitespace-pre-wrap leading-relaxed">
                  {msg.text}
                </div>
                {msg.refs && msg.refs.length > 0 && (
                  <div className="text-[10px] text-ash flex flex-wrap gap-1 pt-1">
                    <span className="text-dust">Refs:</span>
                    {msg.refs.map((ref, idx) => (
                      <span
                        key={idx}
                        className="px-1.5 py-0.5 rounded bg-recessed border border-white/10 text-parchment"
                      >
                        {ref}
                      </span>
                    ))}
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
