"use client";

import React, { useState } from "react";
import { StatusPill } from "./ui/StatusPill";

export interface AskData {
  askId: string;
  question: string;
  options?: string[];
  skeletonId?: string;
  taskId?: string;
  status?: "open" | "answered";
  answer?: string;
}

export interface LegionAskCardProps {
  ask: AskData;
  /** Resolves true when the answer was accepted. */
  onAnswer?: (askId: string, answer: string) => Promise<boolean> | boolean | void;
  disabled?: boolean;
}

/**
 * A question raised by the Necromancer or a Skeleton that waits for the user
 * (Requirement 28). The answer is sent to POST /api/runs/[runId]/asks.
 */
export function LegionAskCard({ ask, onAnswer, disabled = false }: LegionAskCardProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isAnswered = ask.status === "answered";
  const uiState = isAnswered ? "answered" : submitting ? "submitting" : "open";

  async function send(answer: string) {
    const clean = answer.trim();
    if (!clean || !onAnswer || submitting) return;
    setSubmitting(true);
    try {
      const accepted = await onAnswer(ask.askId, clean);
      if (accepted !== false) setDraft("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid={`legion-ask-${ask.askId}`}
      data-ui-element="legion-ask-card"
      data-ui-state={uiState}
      className="crypt-panel border-l-2 border-l-amber-400 border-amber-500/40 p-4 space-y-3 font-mono text-xs"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill
            tone={isAnswered ? "neutral" : "amber"}
            pulse={!isAnswered}
            label={isAnswered ? "Answered" : "Needs your answer"}
            uiState={uiState}
          />
          {ask.skeletonId && <span className="text-dust">from {ask.skeletonId}</span>}
          {ask.taskId && <span className="text-dust">task {ask.taskId}</span>}
        </div>
      </div>

      <p className="text-bone whitespace-pre-wrap leading-relaxed">{ask.question}</p>

      {isAnswered ? (
        <p className="text-parchment">
          <span className="text-dust uppercase text-[10px] tracking-wider mr-2">
            Answer
          </span>
          {ask.answer ?? "(answer not recorded)"}
        </p>
      ) : (
        <div className="space-y-2.5">
          {ask.options && ask.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ask.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={disabled || submitting}
                  onClick={() => send(option)}
                  className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <label htmlFor={`ask-answer-${ask.askId}`} className="sr-only">
              Your answer
            </label>
            <div className="crypt-well flex-1">
              <input
                id={`ask-answer-${ask.askId}`}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={disabled || submitting}
                placeholder="Type your answer"
                className="w-full px-3 py-2 bg-transparent text-bone placeholder-neutral-500 text-xs focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={disabled || submitting || !draft.trim()}
              className="crypt-btn-primary px-4 py-2 rounded text-xs"
            >
              {submitting ? "Sending..." : "Send answer"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export default LegionAskCard;
