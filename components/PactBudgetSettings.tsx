"use client";

import React, { useState, useEffect } from "react";
import type { PactBudget, BudgetCeiling } from "@/lib/pact/pact-review";
import { StatusPill } from "./ui/StatusPill";

export const BUDGET_CHECK_TERMS_NOTE =
  "The cap is checked between tool calls. A single tool call may finish after the cap is reached.";

export const BUDGET_CREDITS_UNREPORTED_NOTE =
  "Credits are not reported by the CLI; the cap is minutes and tool calls";

export interface PactBudgetSettingsProps {
  ceiling?: BudgetCeiling | null;
  budget?: PactBudget;
  onChange?: (budget: PactBudget) => void;
  disabled?: boolean;
  creditsReported?: boolean;
}

const DEFAULT_CEILING: Required<Omit<BudgetCeiling, "maxCredits">> & {
  maxCredits: number | null;
} = {
  maxMinutes: 60,
  maxParallel: 2,
  maxCredits: null,
  maxToolCalls: 100,
};

function getGaugeRatio(value: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / ceiling) * 100)));
}

function getGaugeBarClass(value: number, ceiling: number): string {
  if (value > ceiling) return "bg-rose-400";
  const ratio = ceiling > 0 ? value / ceiling : 0;
  if (ratio > 0.9) return "bg-rose-400";
  if (ratio >= 0.75) return "bg-amber-400";
  return "bg-emerald-400";
}

export function PactBudgetSettings({
  ceiling: propCeiling,
  budget: propBudget,
  onChange,
  disabled = false,
  creditsReported = false,
}: PactBudgetSettingsProps) {
  const effectiveCeiling = {
    maxMinutes:
      propCeiling?.maxMinutes !== undefined && propCeiling.maxMinutes > 0
        ? propCeiling.maxMinutes
        : DEFAULT_CEILING.maxMinutes,
    maxParallel:
      propCeiling?.maxParallel !== undefined && propCeiling.maxParallel > 0
        ? propCeiling.maxParallel
        : DEFAULT_CEILING.maxParallel,
    maxCredits:
      propCeiling?.maxCredits !== undefined
        ? propCeiling.maxCredits
        : DEFAULT_CEILING.maxCredits,
    maxToolCalls:
      propCeiling?.maxToolCalls !== undefined && propCeiling.maxToolCalls > 0
        ? propCeiling.maxToolCalls
        : DEFAULT_CEILING.maxToolCalls,
  };

  const [maxMinutes, setMaxMinutes] = useState<number>(
    propBudget?.maxMinutes !== undefined && propBudget.maxMinutes > 0
      ? Math.min(propBudget.maxMinutes, effectiveCeiling.maxMinutes)
      : effectiveCeiling.maxMinutes
  );
  const [maxParallel, setMaxParallel] = useState<number>(
    propBudget?.maxParallel !== undefined && propBudget.maxParallel > 0
      ? Math.min(propBudget.maxParallel, effectiveCeiling.maxParallel)
      : effectiveCeiling.maxParallel
  );
  const [maxCredits, setMaxCredits] = useState<number | null>(
    propBudget?.maxCredits !== undefined
      ? propBudget.maxCredits
      : effectiveCeiling.maxCredits
  );
  const [maxToolCalls, setMaxToolCalls] = useState<number>(
    propBudget?.maxToolCalls !== undefined && propBudget.maxToolCalls > 0
      ? Math.min(propBudget.maxToolCalls, effectiveCeiling.maxToolCalls)
      : effectiveCeiling.maxToolCalls
  );

  const [minuteError, setMinuteError] = useState<string | null>(null);
  const [parallelError, setParallelError] = useState<string | null>(null);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [toolCallsError, setToolCallsError] = useState<string | null>(null);

  useEffect(() => {
    if (propBudget) {
      if (propBudget.maxMinutes) {
        setMaxMinutes(Math.min(propBudget.maxMinutes, effectiveCeiling.maxMinutes));
      }
      if (propBudget.maxParallel) {
        setMaxParallel(Math.min(propBudget.maxParallel, effectiveCeiling.maxParallel));
      }
      if (propBudget.maxCredits !== undefined) {
        setMaxCredits(propBudget.maxCredits);
      }
      if (propBudget.maxToolCalls) {
        setMaxToolCalls(Math.min(propBudget.maxToolCalls, effectiveCeiling.maxToolCalls));
      }
    }
  }, [propBudget, effectiveCeiling.maxMinutes, effectiveCeiling.maxParallel, effectiveCeiling.maxToolCalls]);

  const emitChange = (
    nextMinutes: number,
    nextParallel: number,
    nextCredits: number | null,
    nextToolCalls: number
  ) => {
    if (onChange) {
      const budgetObj: PactBudget = {
        maxMinutes: nextMinutes,
        maxParallel: nextParallel,
        ...(nextCredits !== null ? { maxCredits: nextCredits } : {}),
        maxToolCalls: nextToolCalls,
      };
      onChange(budgetObj);
    }
  };

  const handleMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isNaN(val) || val <= 0) {
      setMinuteError("Run duration must be at least 1 minute.");
      return;
    }
    if (val > effectiveCeiling.maxMinutes) {
      setMinuteError(
        `Duration cannot exceed the invite code ceiling of ${effectiveCeiling.maxMinutes} minutes.`
      );
    } else {
      setMinuteError(null);
    }
    setMaxMinutes(val);
    emitChange(val, maxParallel, maxCredits, maxToolCalls);
  };

  const handleParallelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isNaN(val) || val <= 0) {
      setParallelError("Parallel workers must be at least 1.");
      return;
    }
    if (val > effectiveCeiling.maxParallel) {
      setParallelError(
        `Parallel workers cannot exceed the invite code ceiling of ${effectiveCeiling.maxParallel}.`
      );
    } else {
      setParallelError(null);
    }
    setMaxParallel(val);
    emitChange(maxMinutes, val, maxCredits, maxToolCalls);
  };

  const handleCreditsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.value === "") {
      setMaxCredits(null);
      setCreditsError(null);
      emitChange(maxMinutes, maxParallel, null, maxToolCalls);
      return;
    }
    const val = parseInt(e.target.value, 10);
    if (Number.isNaN(val) || val <= 0) {
      setCreditsError("Credits must be a positive number.");
      return;
    }
    if (
      effectiveCeiling.maxCredits !== null &&
      effectiveCeiling.maxCredits !== undefined &&
      val > effectiveCeiling.maxCredits
    ) {
      setCreditsError(
        `Credits cannot exceed the invite code ceiling of ${effectiveCeiling.maxCredits}.`
      );
    } else {
      setCreditsError(null);
    }
    setMaxCredits(val);
    emitChange(maxMinutes, maxParallel, val, maxToolCalls);
  };

  const handleToolCallsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isNaN(val) || val <= 0) {
      setToolCallsError("Tool calls must be at least 1.");
      return;
    }
    if (val > effectiveCeiling.maxToolCalls) {
      setToolCallsError(
        `Tool calls cannot exceed the invite code ceiling of ${effectiveCeiling.maxToolCalls}.`
      );
    } else {
      setToolCallsError(null);
    }
    setMaxToolCalls(val);
    emitChange(maxMinutes, maxParallel, maxCredits, val);
  };

  const showCreditInput =
    creditsReported &&
    effectiveCeiling.maxCredits !== null &&
    effectiveCeiling.maxCredits !== undefined;

  const uiState = disabled ? "readonly" : "editable";

  return (
    <div
      data-testid="budget-settings"
      data-ui-element="pact-budget"
      data-ui-state={uiState}
      className="crypt-panel p-5 font-mono text-xs space-y-5"
    >
      <div className="border-b border-white/[0.08] pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-bone tracking-wide uppercase">
            Budget Ward Ceilings
          </h3>
          <p className="text-ash text-xs mt-1">
            Budget caps from the invite code set the ceiling. You may lower them before approving.
          </p>
        </div>
        <StatusPill
          tone={disabled ? "neutral" : "emerald"}
          label={disabled ? "Readonly" : "Editable"}
          uiState={uiState}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Max Minutes Field */}
        <div className="crypt-well p-3.5 space-y-2 focus-within:border-emerald-400/50 transition-colors">
          <div className="flex justify-between items-center text-parchment">
            <label htmlFor="budget-minutes" className="font-medium">
              Max Run Duration (minutes)
            </label>
            <span className="text-ash text-[11px] tabular-nums">
              Ceiling: {effectiveCeiling.maxMinutes} min
            </span>
          </div>
          <div className="flex items-center gap-2 bg-crypt border border-white/10 rounded px-3 py-1.5 focus-within:border-emerald-400/60">
            <input
              id="budget-minutes"
              data-testid="budget-input-minutes"
              type="number"
              min={1}
              max={effectiveCeiling.maxMinutes}
              value={maxMinutes}
              onChange={handleMinutesChange}
              disabled={disabled}
              className="w-full bg-transparent text-bone tabular-nums focus:outline-none disabled:opacity-50"
            />
            <span className="text-[11px] text-dust uppercase shrink-0">min</span>
          </div>
          <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full transition-all ${getGaugeBarClass(maxMinutes, effectiveCeiling.maxMinutes)}`}
              style={{ width: `${getGaugeRatio(maxMinutes, effectiveCeiling.maxMinutes)}%` }}
            />
          </div>
          {minuteError && (
            <p
              data-testid="budget-error-minutes"
              className="text-amber-400 text-[11px]"
            >
              {minuteError}
            </p>
          )}
        </div>

        {/* Max Parallel Field */}
        <div className="crypt-well p-3.5 space-y-2 focus-within:border-emerald-400/50 transition-colors">
          <div className="flex justify-between items-center text-parchment">
            <label htmlFor="budget-parallel" className="font-medium">
              Max Parallel Skeletons
            </label>
            <span className="text-ash text-[11px] tabular-nums">
              Ceiling: {effectiveCeiling.maxParallel}
            </span>
          </div>
          <div className="flex items-center gap-2 bg-crypt border border-white/10 rounded px-3 py-1.5 focus-within:border-emerald-400/60">
            <input
              id="budget-parallel"
              data-testid="budget-input-parallel"
              type="number"
              min={1}
              max={effectiveCeiling.maxParallel}
              value={maxParallel}
              onChange={handleParallelChange}
              disabled={disabled}
              className="w-full bg-transparent text-bone tabular-nums focus:outline-none disabled:opacity-50"
            />
            <span className="text-[11px] text-dust uppercase shrink-0">skeletons</span>
          </div>
          <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full transition-all ${getGaugeBarClass(maxParallel, effectiveCeiling.maxParallel)}`}
              style={{ width: `${getGaugeRatio(maxParallel, effectiveCeiling.maxParallel)}%` }}
            />
          </div>
          {parallelError && (
            <p
              data-testid="budget-error-parallel"
              className="text-amber-400 text-[11px]"
            >
              {parallelError}
            </p>
          )}
        </div>

        {/* Max Tool Calls Field */}
        <div className="crypt-well p-3.5 space-y-2 focus-within:border-emerald-400/50 transition-colors">
          <div className="flex justify-between items-center text-parchment">
            <label htmlFor="budget-tool-calls" className="font-medium">
              Max Tool Calls Cap
            </label>
            <span className="text-ash text-[11px] tabular-nums">
              Ceiling: {effectiveCeiling.maxToolCalls}
            </span>
          </div>
          <div className="flex items-center gap-2 bg-crypt border border-white/10 rounded px-3 py-1.5 focus-within:border-emerald-400/60">
            <input
              id="budget-tool-calls"
              data-testid="budget-input-tool-calls"
              type="number"
              min={1}
              max={effectiveCeiling.maxToolCalls}
              value={maxToolCalls}
              onChange={handleToolCallsChange}
              disabled={disabled}
              className="w-full bg-transparent text-bone tabular-nums focus:outline-none disabled:opacity-50"
            />
            <span className="text-[11px] text-dust uppercase shrink-0">calls</span>
          </div>
          <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full transition-all ${getGaugeBarClass(maxToolCalls, effectiveCeiling.maxToolCalls)}`}
              style={{ width: `${getGaugeRatio(maxToolCalls, effectiveCeiling.maxToolCalls)}%` }}
            />
          </div>
          {toolCallsError && (
            <p
              data-testid="budget-error-tool-calls"
              className="text-amber-400 text-[11px]"
            >
              {toolCallsError}
            </p>
          )}
        </div>

        {/* Credits Field or Unreported Note */}
        <div className="crypt-well p-3.5 space-y-2">
          {showCreditInput ? (
            <>
              <div className="flex justify-between items-center text-parchment">
                <label htmlFor="budget-credits" className="font-medium">
                  Max Credits
                </label>
                <span className="text-ash text-[11px] tabular-nums">
                  Ceiling: {effectiveCeiling.maxCredits}
                </span>
              </div>
              <div className="flex items-center gap-2 bg-crypt border border-white/10 rounded px-3 py-1.5 focus-within:border-emerald-400/60">
                <input
                  id="budget-credits"
                  data-testid="budget-input-credits"
                  type="number"
                  min={1}
                  max={effectiveCeiling.maxCredits ?? undefined}
                  value={maxCredits ?? ""}
                  onChange={handleCreditsChange}
                  disabled={disabled}
                  className="w-full bg-transparent text-bone tabular-nums focus:outline-none disabled:opacity-50"
                />
                <span className="text-[11px] text-dust uppercase shrink-0">credits</span>
              </div>
              {effectiveCeiling.maxCredits ? (
                <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full transition-all ${getGaugeBarClass(maxCredits ?? 0, effectiveCeiling.maxCredits)}`}
                    style={{
                      width: `${getGaugeRatio(maxCredits ?? 0, effectiveCeiling.maxCredits)}%`,
                    }}
                  />
                </div>
              ) : null}
              {creditsError && (
                <p
                  data-testid="budget-error-credits"
                  className="text-amber-400 text-[11px]"
                >
                  {creditsError}
                </p>
              )}
            </>
          ) : (
            <div className="text-ash text-xs flex items-center h-full leading-relaxed">
              <span data-testid="budget-credits-note">
                {BUDGET_CREDITS_UNREPORTED_NOTE}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Mandatory Budget Terms Sentence (Requirement 36.13) */}
      <div
        data-testid="budget-terms-note"
        className="crypt-well p-3.5 text-ash text-xs leading-relaxed"
      >
        <span className="text-parchment font-semibold uppercase text-[10px] tracking-wider block mb-1">
          Terms Note
        </span>
        {BUDGET_CHECK_TERMS_NOTE}
      </div>
    </div>
  );
}

export const BudgetSettings = PactBudgetSettings;
