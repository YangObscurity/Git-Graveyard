#!/usr/bin/env tsx
/**
 * calibrate-e11.ts — E11 calibration summary from the first recorded runs (Requirement 30.20).
 *
 * Reads the first three completed Recorded_Runs from an `EventStore` (or from a `--runs-dir`
 * directory of recorded-run bundles with an events.ndjson per run) and derives the empirical distributions the E11
 * defaults are calibrated from. Every number comes from a recorded event; a dimension that was
 * not recorded is reported as `"not available"` rather than `0`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { EventStore, type EventEnvelope } from "../lib/events/event-store";
import {
  E11_DEFAULT_SETTINGS,
  SettingsStore,
  pickLatestRunDoneEvent,
  resolveDefaultSettingsStorePath,
  type SettingsAuditEntry,
} from "../lib/admin/settings-store";

export interface CalibrationSourceRun {
  runId: string;
  events: EventEnvelope[];
}

export interface MetricDistribution {
  status: "available" | "not available";
  samples: number[];
  count: number;
  min: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  citations: string[];
  note?: string;
}

export interface RunWallClockPauseInterval {
  startCitation: string;
  endCitation: string | null;
  durationMs: number;
  source: "run.clock" | "pact_review" | "approval_wait";
}

export interface RunWallClockDetail {
  runId: string;
  startCitation: string;
  endCitation: string;
  totalMs: number;
  pausedMs: number;
  activeMs: number;
  pauseIntervals: RunWallClockPauseInterval[];
}

export interface CalibrationProposal {
  key: string;
  currentDefault: number | null;
  currentValue: unknown;
  observedSamples: number[];
  summary: string;
  proposedValue: number | null;
  citations: string[];
}

export interface CalibrationAnalysis {
  runIds: string[];
  wardenRejectionRoundsPerTask: MetricDistribution;
  promptDurationsMs: MetricDistribution;
  runWallClockExcludingPactMs: MetricDistribution;
  runWallClockDetails: RunWallClockDetail[];
  approvalWaitTimesMs: MetricDistribution;
  silenceDurationsMs: MetricDistribution;
  proposals: CalibrationProposal[];
}

export interface AnalyzeCalibrationOptions {
  settingsStore?: SettingsStore;
}

export interface RunCalibrationOptions {
  eventStore?: EventStore;
  settingsStore?: SettingsStore;
  runsDir?: string;
  apply?: boolean;
  actor?: string;
  limit?: number;
  all?: boolean;
  ts?: number;
}

export interface RunCalibrationResult {
  runIds: string[];
  analysis: CalibrationAnalysis;
  markdown: string;
  json: string;
  applied: SettingsAuditEntry[];
  recalibrationRequired: boolean;
}

const DEFAULT_RECORDED_RUNS_DIR = path.join(process.cwd(), "output", "recorded-runs");
const DEFAULT_LIMIT = 3;

/**
 * Actor attributed to an `--apply` when none is supplied. This is a *documented* default (not a
 * silent one): an applied change is always written with a real operator identity, so the audit trail
 * never records an unknown/system actor for a calibration write.
 */
export const DEFAULT_CALIBRATION_ACTOR = "owner";

/** Thrown when `--apply` is requested without any way to persist the proposal. */
export const APPLY_REQUIRES_STORE_MESSAGE =
  "--apply requires a SettingsStore instance or settings-db path";

const PROMPT_START_KINDS = new Set(["skeleton.raised", "skeleton.tool_call"]);
const PROMPT_END_KINDS = new Set(["skeleton.usage", "skeleton.state", "verdict"]);
const SILENCE_ACTIVITY_KINDS = new Set([
  "skeleton.tool_call",
  "skeleton.tool_result",
  "skeleton.log",
  "command.started",
  "command.result",
]);

function evCitation(seq: number): string {
  return `ev:${seq}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function makeDistribution(
  samples: number[],
  citations: string[],
  options?: { available?: boolean; note?: string }
): MetricDistribution {
  const available = options?.available !== false && samples.length > 0;
  if (!available) {
    return {
      status: "not available",
      samples,
      count: samples.length,
      min: null,
      median: null,
      p90: null,
      max: null,
      citations,
      note: options?.note ?? "not recorded in the analyzed runs",
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const result: MetricDistribution = {
    status: "available",
    samples,
    count: samples.length,
    min: sorted[0],
    median: median(sorted),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1],
    citations,
  };
  if (options?.note !== undefined) {
    result.note = options.note;
  }
  return result;
}

function phaseOf(ev: EventEnvelope): string | null {
  const data = ev.data as Record<string, unknown>;
  if (typeof data.to === "string") {
    return data.to;
  }
  if (typeof data.phase === "string") {
    return data.phase;
  }
  return null;
}

function calcWardenRejectionRounds(runs: CalibrationSourceRun[]): MetricDistribution {
  const perTask = new Map<string, number>();
  const citations: string[] = [];
  let sawVerdict = false;

  for (const run of runs) {
    for (const ev of run.events) {
      if (ev.kind !== "verdict") {
        continue;
      }
      sawVerdict = true;
      const rawTask = ev.taskId ?? ev.data.taskId;
      const taskId = typeof rawTask === "string" && rawTask.length > 0 ? rawTask : "unknown-task";
      const groupKey = `${run.runId}::${taskId}`;
      if (!perTask.has(groupKey)) {
        perTask.set(groupKey, 0);
      }
      if (ev.data.verdict === "reject") {
        perTask.set(groupKey, (perTask.get(groupKey) ?? 0) + 1);
        citations.push(evCitation(ev.seq));
      }
    }
  }

  const samples = [...perTask.values()];
  return makeDistribution(samples, citations, {
    available: sawVerdict,
    note: sawVerdict ? undefined : "no verdict events recorded",
  });
}

function calcPromptDurations(runs: CalibrationSourceRun[]): MetricDistribution {
  const samples: number[] = [];
  const citations: string[] = [];
  let sawBoundaryStart = false;

  for (const run of runs) {
    const bySkeleton = new Map<string, EventEnvelope[]>();
    for (const ev of run.events) {
      if (!PROMPT_START_KINDS.has(ev.kind) && !PROMPT_END_KINDS.has(ev.kind)) {
        continue;
      }
      const skeletonId = ev.skeletonId ?? `actor:${ev.actor}`;
      const list = bySkeleton.get(skeletonId);
      if (list) {
        list.push(ev);
      } else {
        bySkeleton.set(skeletonId, [ev]);
      }
    }

    for (const events of bySkeleton.values()) {
      let start: EventEnvelope | null = null;
      for (const ev of events) {
        if (PROMPT_START_KINDS.has(ev.kind)) {
          if (start === null) {
            start = ev;
            sawBoundaryStart = true;
          }
          continue;
        }
        if (PROMPT_END_KINDS.has(ev.kind) && start !== null) {
          const duration = ev.ts - start.ts;
          if (duration >= 0) {
            samples.push(duration);
            citations.push(`${evCitation(start.seq)}..${evCitation(ev.seq)}`);
          }
          start = null;
        }
      }
    }
  }

  return makeDistribution(samples, citations, {
    available: sawBoundaryStart,
    note: sawBoundaryStart ? undefined : "no prompt boundary timestamps recorded",
  });
}


function calcRunWallClock(runs: CalibrationSourceRun[]): {
  distribution: MetricDistribution;
  details: RunWallClockDetail[];
} {
  const details: RunWallClockDetail[] = [];
  const samples: number[] = [];
  const citations: string[] = [];

  for (const run of runs) {
    const events = run.events;

    let startEv: EventEnvelope | null = null;
    for (const ev of events) {
      if (ev.kind === "run.started") {
        startEv = ev;
        break;
      }
    }
    if (!startEv) {
      for (const ev of events) {
        if (ev.kind === "run.phase") {
          const phase = phaseOf(ev);
          if (phase !== null && phase !== "queued") {
            startEv = ev;
            break;
          }
        }
      }
    }

    // Pick the `run.done` with the highest `seq` (via the shared helper) instead of the last one in
    // array order, so an out-of-order store replay resolves the same terminal event as the settings
    // store's completion counter.
    const endEv = pickLatestRunDoneEvent(events);

    if (!startEv || !endEv || endEv.ts < startEv.ts) {
      continue;
    }

    const rawIntervals: Array<{
      start: EventEnvelope;
      end: EventEnvelope | null;
      source: "run.clock" | "pact_review" | "approval_wait";
    }> = [];
    let clockPause: EventEnvelope | null = null;
    let pactPause: EventEnvelope | null = null;
    const approvalAwaiting = new Map<string, EventEnvelope>();

    for (const ev of events) {
      if (ev.ts < startEv.ts) {
        continue;
      }
      if (ev.kind === "run.clock") {
        const action = (ev.data as Record<string, unknown>).action;
        if (action === "pause") {
          if (!clockPause) {
            clockPause = ev;
          }
        } else if (action === "resume" && clockPause) {
          rawIntervals.push({ start: clockPause, end: ev, source: "run.clock" });
          clockPause = null;
        }
      } else if (ev.kind === "run.phase") {
        const phase = phaseOf(ev);
        if (phase === "pact_review") {
          if (!pactPause) {
            pactPause = ev;
          }
        } else if (phase === "legion" && pactPause) {
          rawIntervals.push({ start: pactPause, end: ev, source: "pact_review" });
          pactPause = null;
        }
      } else if (ev.kind === "pact.approved" && pactPause) {
        rawIntervals.push({ start: pactPause, end: ev, source: "pact_review" });
        pactPause = null;
      } else if (ev.kind === "approval.requested") {
        const id = String((ev.data as Record<string, unknown>).approvalId ?? `${run.runId}:${ev.seq}`);
        if (!approvalAwaiting.has(id)) {
          approvalAwaiting.set(id, ev);
        }
      } else if (ev.kind === "approval.resolved") {
        const id = String((ev.data as Record<string, unknown>).approvalId ?? "");
        const request = approvalAwaiting.get(id);
        if (request) {
          rawIntervals.push({ start: request, end: ev, source: "approval_wait" });
          approvalAwaiting.delete(id);
        }
      }
    }
    if (clockPause) {
      rawIntervals.push({ start: clockPause, end: null, source: "run.clock" });
    }
    if (pactPause) {
      rawIntervals.push({ start: pactPause, end: null, source: "pact_review" });
    }
    // An approval that never resolved still counts as a wait; clamp it to the run end (the shared
    // clamp below turns `end: null` into `endEv.ts`).
    for (const request of approvalAwaiting.values()) {
      rawIntervals.push({ start: request, end: null, source: "approval_wait" });
    }

    const clamped = rawIntervals
      .map((it) => ({
        ...it,
        startTs: Math.max(it.start.ts, startEv.ts),
        endTs: Math.min(it.end ? it.end.ts : endEv.ts, endEv.ts),
      }))
      .filter((it) => it.endTs > it.startTs)
      .sort((a, b) => a.startTs - b.startTs);

    // Merge overlapping pause intervals (e.g. a run.clock pause covering pact_review) so the
    // excluded time is subtracted exactly once.
    const merged: Array<{ startTs: number; endTs: number }> = [];
    for (const it of clamped) {
      const last = merged[merged.length - 1];
      if (last && it.startTs <= last.endTs) {
        last.endTs = Math.max(last.endTs, it.endTs);
      } else {
        merged.push({ startTs: it.startTs, endTs: it.endTs });
      }
    }

    const pausedMs = merged.reduce((acc, m) => acc + (m.endTs - m.startTs), 0);
    const totalMs = endEv.ts - startEv.ts;
    const activeMs = Math.max(0, totalMs - pausedMs);

    const detail: RunWallClockDetail = {
      runId: run.runId,
      startCitation: evCitation(startEv.seq),
      endCitation: evCitation(endEv.seq),
      totalMs,
      pausedMs,
      activeMs,
      pauseIntervals: clamped.map((it) => ({
        startCitation: evCitation(it.start.seq),
        endCitation: it.end ? evCitation(it.end.seq) : null,
        durationMs: it.endTs - it.startTs,
        source: it.source,
      })),
    };

    details.push(detail);
    samples.push(activeMs);
    citations.push(detail.startCitation, detail.endCitation);
    for (const interval of detail.pauseIntervals) {
      citations.push(interval.startCitation);
      if (interval.endCitation) {
        citations.push(interval.endCitation);
      }
    }
  }

  return {
    distribution: makeDistribution(samples, citations, {
      available: samples.length > 0,
      note: samples.length > 0 ? undefined : "no run with both a start and a run.done event",
    }),
    details,
  };
}


function calcApprovalWaits(runs: CalibrationSourceRun[]): MetricDistribution {
  const samples: number[] = [];
  const citations: string[] = [];
  let requestedCount = 0;

  for (const run of runs) {
    const awaiting = new Map<string, EventEnvelope>();
    for (const ev of run.events) {
      if (ev.kind === "approval.requested") {
        const id = String(ev.data.approvalId ?? `${run.runId}:${ev.seq}`);
        if (!awaiting.has(id)) {
          awaiting.set(id, ev);
        }
        requestedCount += 1;
      }
    }
    for (const ev of run.events) {
      if (ev.kind !== "approval.resolved") {
        continue;
      }
      const id = String(ev.data.approvalId ?? "");
      const request = awaiting.get(id);
      if (!request) {
        continue;
      }
      const duration = ev.ts - request.ts;
      if (duration >= 0) {
        samples.push(duration);
        citations.push(`${evCitation(request.seq)}..${evCitation(ev.seq)}`);
      }
      awaiting.delete(id);
    }
  }

  return makeDistribution(samples, citations, {
    available: requestedCount > 0,
    note: requestedCount > 0 ? undefined : "no approval requests recorded",
  });
}

/**
 * Requirement 41.12: `silentSkeletonMs` measures silence *only* while no tool call or command is
 * pending. This builds the in-flight spans from matched pairs so a long-running command/tool call is
 * never mistaken for silence:
 *  - `command.started` -> `command.result`   (paired by data.logRef, else skeleton, else actor)
 *  - `skeleton.tool_call` -> `skeleton.tool_result` (paired by skeleton-scoped tool call id)
 * Unmatched halves are ignored: a lone start or result is not a span, and treating it as one would
 * wrongly erase real silence (recorded fixtures and logs frequently omit the other half).
 *
 * The spans are bucketed by the *skeleton scope* of the matched start (`skeletonId`, else
 * `actor:<actor>`) so an in-flight command in one skeleton never erases another skeleton's silence.
 */
function pendingActivityIntervals(
  events: EventEnvelope[]
): Map<string, Array<{ startTs: number; endTs: number }>> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const byScope = new Map<string, Array<{ startTs: number; endTs: number }>>();

  const addSpan = (scope: string, startTs: number, endTs: number): void => {
    const list = byScope.get(scope);
    if (list) {
      list.push({ startTs, endTs });
    } else {
      byScope.set(scope, [{ startTs, endTs }]);
    }
  };

  const pair = (startKind: string, endKind: string, keyOf: (ev: EventEnvelope) => string): void => {
    const awaiting = new Map<string, EventEnvelope>();
    for (const ev of ordered) {
      if (ev.kind === startKind) {
        const key = keyOf(ev);
        if (!awaiting.has(key)) {
          awaiting.set(key, ev);
        }
      } else if (ev.kind === endKind) {
        const key = keyOf(ev);
        const start = awaiting.get(key);
        if (start) {
          if (ev.ts > start.ts) {
            addSpan(start.skeletonId ?? `actor:${start.actor}`, start.ts, ev.ts);
          }
          awaiting.delete(key);
        }
      }
    }
  };

  // Concurrent tasks with the same role share `ev.actor`, so pair `command.started` /
  // `command.result` spans by the recorded `data.logRef` (falling back to the skeleton id, then the
  // actor). Pairing by actor alone would merge two simultaneous commands into a single span and drop
  // the second, wrongly counting in-flight work as silence.
  pair("command.started", "command.result", (ev) => {
    const data = ev.data as Record<string, unknown> | undefined;
    return `command:${String(data?.logRef ?? ev.skeletonId ?? ev.actor)}`;
  });
  // Concurrent skeletons run independent ACP sessions, so `data.toolCallId` is only unique *within*
  // a skeleton. Scope the pairing key by skeleton (falling back to the actor) so two skeletons that
  // both reuse `toolCallId: "tc-1"` never collide: each tool call pairs with its own result.
  pair("skeleton.tool_call", "skeleton.tool_result", (ev) => {
    const data = ev.data as Record<string, unknown> | undefined;
    const toolCallId = data?.toolCallId;
    const skelScope = ev.skeletonId ?? `actor:${ev.actor}`;
    return typeof toolCallId === "string"
      ? `tool:${skelScope}:${toolCallId}`
      : `tool:${skelScope}`;
  });
  return byScope;
}

/**
 * Milliseconds of `[startTs, endTs)` covered by any pending (in-flight) interval. The result is
 * clamped to the window length so two overlapping in-flight spans are never subtracted twice.
 */
function pendingOverlapMs(
  intervals: Array<{ startTs: number; endTs: number }>,
  startTs: number,
  endTs: number
): number {
  let covered = 0;
  for (const interval of intervals) {
    const lo = Math.max(interval.startTs, startTs);
    const hi = Math.min(interval.endTs, endTs);
    if (hi > lo) {
      covered += hi - lo;
    }
  }
  return Math.min(covered, Math.max(0, endTs - startTs));
}

function calcSilenceDurations(runs: CalibrationSourceRun[]): MetricDistribution {
  const samples: number[] = [];
  const citations: string[] = [];
  let anyRunWithActivity = false;

  for (const run of runs) {
    // Partition activity per skeleton scope. Combining every skeleton into one timeline would let a
    // busy skeleton A fan its events across skeleton B's frozen window and split B's single long gap
    // into many short ones, so a genuinely silent skeleton would be reported as active.
    const activityBySkeleton = new Map<string, EventEnvelope[]>();
    for (const ev of run.events) {
      if (!SILENCE_ACTIVITY_KINDS.has(ev.kind)) {
        continue;
      }
      const skelScope = ev.skeletonId ?? `actor:${ev.actor}`;
      const list = activityBySkeleton.get(skelScope);
      if (list) {
        list.push(ev);
      } else {
        activityBySkeleton.set(skelScope, [ev]);
      }
    }

    // In-flight spans are bucketed the same way, so a pending tool call/command only erases silence
    // inside its own skeleton.
    const pendingBySkeleton = pendingActivityIntervals(run.events);

    let runMaxGap = -1;
    let winner: { from: EventEnvelope; to: EventEnvelope } | null = null;

    for (const [skelScope, scopeEvents] of activityBySkeleton) {
      if (scopeEvents.length < 2) {
        continue;
      }
      anyRunWithActivity = true;

      const ordered = [...scopeEvents].sort((a, b) => a.seq - b.seq);
      const pending = pendingBySkeleton.get(skelScope) ?? [];

      // Requirement 41.12: time while a tool call or command is in flight is not silence, so the
      // in-flight portion of each gap is subtracted before the maximum gap is taken.
      let scopeMaxGap = 0;
      let from = ordered[0];
      let to = ordered[0];
      for (let i = 1; i < ordered.length; i += 1) {
        const previous = ordered[i - 1];
        const current = ordered[i];
        const raw = current.ts - previous.ts;
        const gap = Math.max(0, raw - pendingOverlapMs(pending, previous.ts, current.ts));
        if (gap > scopeMaxGap) {
          scopeMaxGap = gap;
          from = previous;
          to = current;
        }
      }

      if (scopeMaxGap > runMaxGap) {
        runMaxGap = scopeMaxGap;
        winner = { from, to };
      }
    }

    if (winner) {
      samples.push(Math.max(0, runMaxGap));
      citations.push(`${evCitation(winner.from.seq)}..${evCitation(winner.to.seq)}`);
    }
  }

  return makeDistribution(samples, citations, {
    available: anyRunWithActivity,
    note: anyRunWithActivity ? undefined : "no skeleton with two activity events per run",
  });
}


interface HeadroomResult {
  value: number | null;
  summary: string;
}

/**
 * Per-key minimum floors so a calibration can never collapse a cap to `0`.
 *
 * A clean run set (for example zero Warden rejections -> `max = 0`, or an instant/synthetic run ->
 * a `0` ms prompt or silence delta) must not disable Warden retries or propose a `0 ms` timeout.
 * `wardenRounds` keeps at least 1 round; every wall-clock/timeout cap keeps at least 1000 ms.
 * Any other key defaults to a positive floor of 1.
 */
const MIN_PROPOSED_VALUE: Readonly<Record<string, number>> = {
  wardenRounds: 1,
  promptWallClockMs: 1000,
  runWallClockMs: 1000,
  silentSkeletonMs: 1000,
  approvalWaitMs: 1000,
  exhumerTriageWallClockMs: 1000,
};

/**
 * Proposes a value with safe headroom over the observed maximum; when a dimension was not
 * recorded the E11 starting value (or the current store value) is kept.
 */
function proposeValue(
  distribution: MetricDistribution,
  key: string,
  currentValue: unknown
): HeadroomResult {
  const currentDefault = E11_DEFAULT_SETTINGS[key] ?? null;
  if (distribution.status !== "available" || distribution.samples.length === 0) {
    const kept = typeof currentValue === "number" ? currentValue : currentDefault;
    return {
      value: kept,
      summary:
        distribution.note ?? "not available; keeping the current value and E11 starting value",
    };
  }
  const max = distribution.max ?? 0;
  const floor = MIN_PROPOSED_VALUE[key] ?? 1;
  // Never below the per-key floor and never below 1, even when the observed maximum is 0.
  const proposed = Math.max(floor, Math.ceil(max * 1.25), 1);
  return {
    value: proposed,
    summary: `max ${max}, p90 ${distribution.p90} over ${distribution.samples.length} sample(s)`,
  };
}

function buildProposals(
  metrics: {
    warden: MetricDistribution;
    prompt: MetricDistribution;
    runClock: MetricDistribution;
    approval: MetricDistribution;
    silence: MetricDistribution;
  },
  settingsStore?: SettingsStore
): CalibrationProposal[] {
  const currentValueOf = (key: string): unknown =>
    settingsStore ? settingsStore.getSetting(key) : undefined;

  const rows: Array<{ key: string; distribution: MetricDistribution | null }> = [
    { key: "wardenRounds", distribution: metrics.warden },
    { key: "promptWallClockMs", distribution: metrics.prompt },
    { key: "runWallClockMs", distribution: metrics.runClock },
    { key: "silentSkeletonMs", distribution: metrics.silence },
    { key: "approvalWaitMs", distribution: metrics.approval },
    // queueIdleLimitMs has no direct event metric; keep the current value.
    { key: "queueIdleLimitMs", distribution: null },
  ];

  return rows.map(({ key, distribution }) => {
    const currentValue = currentValueOf(key);
    const currentDefault = E11_DEFAULT_SETTINGS[key] ?? null;

    if (distribution === null) {
      return {
        key,
        currentDefault,
        currentValue,
        observedSamples: [],
        summary: "not available; no queue idle data recorded in the analyzed runs",
        proposedValue: typeof currentValue === "number" ? currentValue : currentDefault,
        citations: [],
      };
    }

    const { value, summary } = proposeValue(distribution, key, currentValue);
    return {
      key,
      currentDefault,
      currentValue,
      observedSamples: distribution.samples,
      summary,
      proposedValue: value,
      citations: distribution.citations,
    };
  });
}

export function analyzeRecordedRunsForCalibration(
  runs: CalibrationSourceRun[],
  options?: AnalyzeCalibrationOptions
): CalibrationAnalysis {
  const safeRuns = Array.isArray(runs) ? runs : [];
  const warden = calcWardenRejectionRounds(safeRuns);
  const prompt = calcPromptDurations(safeRuns);
  const runClock = calcRunWallClock(safeRuns);
  const approval = calcApprovalWaits(safeRuns);
  const silence = calcSilenceDurations(safeRuns);

  return {
    runIds: safeRuns.map((run) => run.runId),
    wardenRejectionRoundsPerTask: warden,
    promptDurationsMs: prompt,
    runWallClockExcludingPactMs: runClock.distribution,
    runWallClockDetails: runClock.details,
    approvalWaitTimesMs: approval,
    silenceDurationsMs: silence,
    proposals: buildProposals(
      { warden, prompt, runClock: runClock.distribution, approval, silence },
      options?.settingsStore
    ),
  };
}


function formatDistributionRow(label: string, dist: MetricDistribution): string {
  const value = (n: number | null): string => (n === null ? "not available" : String(n));
  const citations = dist.citations.length > 0 ? dist.citations.join(", ") : "not available";
  return `| ${label} | ${dist.status} | ${value(dist.min)} | ${value(dist.median)} | ${value(
    dist.p90
  )} | ${value(dist.max)} | ${dist.count} | ${citations} |`;
}

export function formatCalibrationMarkdown(analysis: CalibrationAnalysis): string {
  const lines: string[] = [];
  lines.push("# E11 Calibration Summary");
  lines.push("");
  lines.push(`Recorded runs analyzed: ${analysis.runIds.length}`);
  if (analysis.runIds.length > 0) {
    lines.push("");
    for (const runId of analysis.runIds) {
      lines.push(`- ${runId}`);
    }
  }
  lines.push("");
  lines.push("## Observed metrics");
  lines.push("");
  lines.push("| Metric | Status | Min | Median | P90 | Max | Samples | Citations |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  lines.push(
    formatDistributionRow("Warden rejection rounds per task", analysis.wardenRejectionRoundsPerTask)
  );
  lines.push(formatDistributionRow("Prompt durations (ms)", analysis.promptDurationsMs));
  lines.push(
    formatDistributionRow(
      "Run wall-clock excluding Pact/approval (ms)",
      analysis.runWallClockExcludingPactMs
    )
  );
  lines.push(formatDistributionRow("Approval wait times (ms)", analysis.approvalWaitTimesMs));
  lines.push(formatDistributionRow("Silence durations (ms)", analysis.silenceDurationsMs));
  lines.push("");
  lines.push("### Run wall-clock detail");
  lines.push("");
  lines.push("| Run | Start | End | Total ms | Paused ms | Active ms | Pauses |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const detail of analysis.runWallClockDetails) {
    const pauses =
      detail.pauseIntervals
        .map(
          (p) =>
            `${p.source} ${p.startCitation}${
              p.endCitation ? `..${p.endCitation}` : "..end"
            } (${p.durationMs} ms)`
        )
        .join("; ") || "none";
    lines.push(
      `| ${detail.runId} | ${detail.startCitation} | ${detail.endCitation} | ${detail.totalMs} | ${detail.pausedMs} | ${detail.activeMs} | ${pauses} |`
    );
  }
  lines.push("");
  lines.push("## Proposed settings");
  lines.push("");
  lines.push(
    "| Setting | E11 default | Current value | Observed samples | Summary | Proposed | Citations |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const proposal of analysis.proposals) {
    const currentDefault = proposal.currentDefault === null ? "not set" : proposal.currentDefault;
    const currentValue =
      proposal.currentValue === undefined ? "not set" : JSON.stringify(proposal.currentValue);
    const observed =
      proposal.observedSamples.length > 0
        ? `[${proposal.observedSamples.join(", ")}]`
        : "not available";
    const proposed = proposal.proposedValue === null ? "not available" : proposal.proposedValue;
    const citations =
      proposal.citations.length > 0 ? proposal.citations.join(", ") : "not available";
    lines.push(
      `| ${proposal.key} | ${currentDefault} | ${currentValue} | ${observed} | ${proposal.summary} | ${proposed} | ${citations} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}


function parseNdjsonEvents(text: string, fallbackRunId: string): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const data =
      record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : {};
    const envelope: EventEnvelope = {
      runId: typeof record.runId === "string" ? record.runId : fallbackRunId,
      seq: Number(record.seq ?? events.length + 1),
      ts: Number(record.ts ?? 0),
      kind: String(record.kind ?? "unknown"),
      actor: String(record.actor ?? "unknown"),
      // Spread `data` first so the normalized `refs` (always an array of strings) sits *after* the
      // spread and can never be overwritten by a non-string `data.refs`.
      data: { ...data, refs: Array.isArray(data.refs) ? data.refs.map(String) : [] },
    };
    if (typeof record.skeletonId === "string") {
      envelope.skeletonId = record.skeletonId;
    }
    if (typeof record.taskId === "string") {
      envelope.taskId = record.taskId;
    }
    events.push(envelope);
  }
  return events;
}

/**
 * A run whose latest `run.done` reports `outcome === "error"` is not a completed run. The latest
 * event comes from the shared {@link pickLatestRunDoneEvent} so the CLI and the settings store agree
 * on what "the run's terminal outcome" is.
 */
function isErroredRun(events: EventEnvelope[]): boolean {
  const done = pickLatestRunDoneEvent(events);
  return done !== null && done.data.outcome === "error";
}

export function loadRecordedRunsFromDir(dir: string, limit = DEFAULT_LIMIT): CalibrationSourceRun[] {
  return collectCompletedRunsFromDir(dir).slice(0, Math.max(0, limit));
}

/**
 * Every *completed, non-error* run in a directory, ordered chronologically by the run's `run.done`
 * timestamp (ties broken by run id). Kept separate from {@link loadRecordedRunsFromDir} (which
 * slices to `limit` samples) so the full completed-run id set can feed `recalibrationRequired` while
 * only the leading runs feed the distributions.
 *
 * Ordering by `run.done` timestamp — never by directory name — keeps the sample order independent of
 * any custom `--run-id` naming scheme, so directory mode picks the same runs as EventStore mode
 * ({@link collectCompletedRunsFromEventStore}).
 */
function collectCompletedRunsFromDir(dir: string): CalibrationSourceRun[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const runIds = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const runs: CalibrationSourceRun[] = [];
  for (const runId of runIds) {
    const eventsPath = path.join(dir, runId, "events.ndjson");
    if (!fs.existsSync(eventsPath)) {
      continue;
    }
    const events = parseNdjsonEvents(fs.readFileSync(eventsPath, "utf8"), runId);
    // Skip errored runs *and* runs that never concluded (no `run.done`) so an incomplete run can
    // never enter calibration or displace a completed one.
    const done = pickLatestRunDoneEvent(events);
    if (done === null || isErroredRun(events)) {
      continue;
    }
    runs.push({ runId, events });
  }

  runs.sort(
    (a, b) =>
      (pickLatestRunDoneEvent(a.events)?.ts ?? 0) - (pickLatestRunDoneEvent(b.events)?.ts ?? 0) ||
      a.runId.localeCompare(b.runId)
  );
  return runs;
}

export function loadCompletedRunsFromEventStore(
  store: EventStore,
  limit: number
): CalibrationSourceRun[] {
  return collectCompletedRunsFromEventStore(store).slice(0, Math.max(0, limit));
}

/** Every completed, non-errored run in an EventStore (see the directory sibling). */
function collectCompletedRunsFromEventStore(store: EventStore): CalibrationSourceRun[] {
  const ordered: Array<{ runId: string; doneTs: number; events: EventEnvelope[] }> = [];
  for (const runId of store.getRunIds()) {
    const events = store.getEvents(runId);
    const done = pickLatestRunDoneEvent(events);
    // Ignore runs that never concluded and runs that errored.
    if (!done || done.data.outcome === "error") {
      continue;
    }
    ordered.push({ runId, doneTs: done.ts, events });
  }
  ordered.sort((a, b) => a.doneTs - b.doneTs || a.runId.localeCompare(b.runId));

  return ordered.map(({ runId, events }) => ({ runId, events }));
}

export function runCalibration(options?: RunCalibrationOptions): RunCalibrationResult {
  // Never silently no-op an --apply. Persisting requires a store; without one the caller must be
  // told, rather than receiving a result that looks applied but wrote nothing.
  if (options?.apply === true && !options.settingsStore) {
    throw new Error(APPLY_REQUIRES_STORE_MESSAGE);
  }

  const limit = options?.limit && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;

  // Requirement 8: collect *every* completed, non-error run so the recalibration counter sees runs
  // beyond the sample window, then feed the leading `limit` runs (or every run with `--all`) into the
  // distributions.
  let allCompletedRuns: CalibrationSourceRun[];
  if (options?.runsDir) {
    allCompletedRuns = collectCompletedRunsFromDir(options.runsDir);
  } else if (options?.eventStore) {
    allCompletedRuns = collectCompletedRunsFromEventStore(options.eventStore);
  } else {
    allCompletedRuns = collectCompletedRunsFromDir(DEFAULT_RECORDED_RUNS_DIR);
  }
  const allCompletedRunIds = allCompletedRuns.map((run) => run.runId);
  const sampleRuns = options?.all === true ? allCompletedRuns : allCompletedRuns.slice(0, limit);

  const analysis = analyzeRecordedRunsForCalibration(sampleRuns, {
    settingsStore: options?.settingsStore,
  });
  const markdown = formatCalibrationMarkdown(analysis);
  const json = JSON.stringify({ analysis }, null, 2);

  const applied: SettingsAuditEntry[] = [];
  let recalibrationRequired = false;

  const settingsStore = options?.settingsStore;
  if (settingsStore) {
    // Requirement 30.20: sync *all* completed run ids (not just the sampled three) so run 4+ re-arms
    // `recalibrationRequired` after a calibration over the first three.
    settingsStore.syncRecordedRunCount({ recordedRunIds: allCompletedRunIds });
    recalibrationRequired = settingsStore.isRecalibrationRequired();
  }

  if (options?.apply && settingsStore) {
    const actor =
      options.actor && options.actor.trim() !== "" ? options.actor : DEFAULT_CALIBRATION_ACTOR;
    for (const proposal of analysis.proposals) {
      if (proposal.proposedValue === null) {
        continue;
      }
      const reason = [
        "E11 calibration from recorded runs",
        `observed: ${proposal.summary}`,
        proposal.citations.length > 0 ? `evidence: ${proposal.citations.join(", ")}` : "evidence: none",
      ].join("; ");
      applied.push(
        settingsStore.setSetting(proposal.key, proposal.proposedValue, {
          actor,
          reason,
          ts: options.ts,
        })
      );
    }
    settingsStore.markCalibrated({
      actor,
      runIds: analysis.runIds,
      ts: options.ts,
    });
    // `markCalibrated` clears `recalibrationRequired` using only the sampled run ids. Re-sync against
    // *every* completed run id so the flag is not cleared prematurely: runs outside the sample window
    // stay uncalibrated and keep it armed. With `--all` (or a `--limit` covering every run) the
    // sampled ids equal the completed set, so the flag clears.
    settingsStore.syncRecordedRunCount({ recordedRunIds: allCompletedRunIds });
    recalibrationRequired = settingsStore.isRecalibrationRequired();
  }

  return { runIds: analysis.runIds, analysis, markdown, json, applied, recalibrationRequired };
}


export interface CliOptions {
  db?: string;
  settingsDb?: string;
  runsDir?: string;
  json: boolean;
  markdown: boolean;
  out?: string;
  apply: boolean;
  actor?: string;
  limit?: number;
  all?: boolean;
}

export function parseCalibrationArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, markdown: false, apply: false };

  // A value flag must be followed by a real value. Without this check a missing value (end of argv)
  // or a following flag (`--db --json`) would be swallowed into the option, silently dropping the
  // flag that should have been parsed next.
  const requireValue = (flag: string, at: number, noun = "path"): string => {
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a ${noun} argument`);
    }
    return value;
  };

  // `--limit` takes a positive integer count of completed runs to calibrate.
  const requirePositiveInteger = (flag: string, at: number): number => {
    const raw = requireValue(flag, at, "positive integer");
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${flag} requires a positive integer argument (received "${raw}")`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--db":
        options.db = requireValue("--db", i);
        i += 1;
        break;
      case "--settings-db":
        options.settingsDb = requireValue("--settings-db", i);
        i += 1;
        break;
      case "--runs-dir":
        options.runsDir = requireValue("--runs-dir", i);
        i += 1;
        break;
      case "--out":
        options.out = requireValue("--out", i);
        i += 1;
        break;
      case "--actor":
        options.actor = requireValue("--actor", i, "value");
        i += 1;
        break;
      case "--limit":
        options.limit = requirePositiveInteger("--limit", i);
        i += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--markdown":
        options.markdown = true;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--all":
        options.all = true;
        break;
      default:
        // An unknown `--flag` is a mistake, not something to silently ignore.
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        break;
    }
  }
  return options;
}

function main(): void {
  const options = parseCalibrationArgs(process.argv.slice(2));

  const eventStore = options.db ? new EventStore(options.db) : undefined;
  let settingsStore = options.settingsDb ? new SettingsStore(options.settingsDb) : undefined;

  // An explicit `--apply` without `--settings-db` must not be silently dropped. Resolve the default
  // store (env override, then the shared default path) and open it so the proposal is actually
  // persisted; `runCalibration` throws if apply is requested with no store at all.
  if (!settingsStore && options.apply) {
    const settingsPath = process.env.SETTINGS_STORE_PATH ?? resolveDefaultSettingsStorePath();
    settingsStore = new SettingsStore(settingsPath);
  }

  try {
    const result = runCalibration({
      eventStore,
      settingsStore,
      runsDir: options.runsDir,
      apply: options.apply,
      actor: options.actor,
      limit: options.limit,
      all: options.all,
    });

    const formatted = options.json ? result.json : result.markdown;
    if (options.out) {
      fs.writeFileSync(options.out, formatted, "utf8");
    }
    process.stdout.write(`${formatted}\n`);
  } finally {
    if (eventStore) {
      eventStore.close();
    }
    if (settingsStore) {
      settingsStore.close();
    }
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("calibrate-e11.ts") ||
  process.argv[1]?.endsWith("calibrate-e11.js");

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

