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
  source: "run.clock" | "pact_review";
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

    let endEv: EventEnvelope | null = null;
    for (const ev of events) {
      if (ev.kind === "run.done") {
        endEv = ev;
      }
    }

    if (!startEv || !endEv || endEv.ts < startEv.ts) {
      continue;
    }

    const rawIntervals: Array<{
      start: EventEnvelope;
      end: EventEnvelope | null;
      source: "run.clock" | "pact_review";
    }> = [];
    let clockPause: EventEnvelope | null = null;
    let pactPause: EventEnvelope | null = null;

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
      }
    }
    if (clockPause) {
      rawIntervals.push({ start: clockPause, end: null, source: "run.clock" });
    }
    if (pactPause) {
      rawIntervals.push({ start: pactPause, end: null, source: "pact_review" });
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

function calcSilenceDurations(runs: CalibrationSourceRun[]): MetricDistribution {
  const samples: number[] = [];
  const citations: string[] = [];
  let anyRunWithActivity = false;

  for (const run of runs) {
    const activity = run.events
      .filter((ev) => SILENCE_ACTIVITY_KINDS.has(ev.kind))
      .sort((a, b) => a.seq - b.seq);
    if (activity.length < 2) {
      continue;
    }
    anyRunWithActivity = true;
    let maxGap = 0;
    let from = activity[0];
    let to = activity[0];
    for (let i = 1; i < activity.length; i += 1) {
      const gap = activity[i].ts - activity[i - 1].ts;
      if (gap > maxGap) {
        maxGap = gap;
        from = activity[i - 1];
        to = activity[i];
      }
    }
    samples.push(maxGap);
    citations.push(`${evCitation(from.seq)}..${evCitation(to.seq)}`);
  }

  return makeDistribution(samples, citations, {
    available: anyRunWithActivity,
    note: anyRunWithActivity ? undefined : "fewer than two activity events per run",
  });
}


interface HeadroomResult {
  value: number | null;
  summary: string;
}

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
  const proposed = Math.ceil(max * 1.25);
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
      data: { refs: Array.isArray(data.refs) ? data.refs.map(String) : [], ...data },
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

export function loadRecordedRunsFromDir(dir: string, limit = DEFAULT_LIMIT): CalibrationSourceRun[] {
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
    if (runs.length >= limit) {
      break;
    }
    const eventsPath = path.join(dir, runId, "events.ndjson");
    if (!fs.existsSync(eventsPath)) {
      continue;
    }
    const events = parseNdjsonEvents(fs.readFileSync(eventsPath, "utf8"), runId);
    runs.push({ runId, events });
  }
  return runs;
}

function loadCompletedRunsFromEventStore(
  store: EventStore,
  limit: number
): CalibrationSourceRun[] {
  const ordered: Array<{ runId: string; doneTs: number }> = [];
  for (const runId of store.getRunIds()) {
    const doneEvents = store.getEvents(runId, { kind: "run.done" });
    if (doneEvents.length === 0) {
      continue;
    }
    ordered.push({ runId, doneTs: doneEvents[doneEvents.length - 1].ts });
  }
  ordered.sort((a, b) => a.doneTs - b.doneTs || a.runId.localeCompare(b.runId));

  return ordered.slice(0, limit).map((entry) => ({
    runId: entry.runId,
    events: store.getEvents(entry.runId),
  }));
}

export function runCalibration(options?: RunCalibrationOptions): RunCalibrationResult {
  const limit = options?.limit && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;

  let runs: CalibrationSourceRun[];
  if (options?.runsDir) {
    runs = loadRecordedRunsFromDir(options.runsDir, limit);
  } else if (options?.eventStore) {
    runs = loadCompletedRunsFromEventStore(options.eventStore, limit);
  } else {
    runs = loadRecordedRunsFromDir(DEFAULT_RECORDED_RUNS_DIR, limit);
  }

  const analysis = analyzeRecordedRunsForCalibration(runs, {
    settingsStore: options?.settingsStore,
  });
  const markdown = formatCalibrationMarkdown(analysis);
  const json = JSON.stringify({ analysis }, null, 2);

  const applied: SettingsAuditEntry[] = [];
  let recalibrationRequired = false;

  const settingsStore = options?.settingsStore;
  if (settingsStore) {
    settingsStore.syncRecordedRunCount({ recordedRunIds: analysis.runIds });
    recalibrationRequired = settingsStore.isRecalibrationRequired();
  }

  if (options?.apply && settingsStore) {
    const actor = options.actor && options.actor.trim() !== "" ? options.actor : "owner";
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
}

export function parseCalibrationArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, markdown: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--db":
        options.db = next;
        i += 1;
        break;
      case "--settings-db":
        options.settingsDb = next;
        i += 1;
        break;
      case "--runs-dir":
        options.runsDir = next;
        i += 1;
        break;
      case "--out":
        options.out = next;
        i += 1;
        break;
      case "--actor":
        options.actor = next;
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
      default:
        break;
    }
  }
  return options;
}

function main(): void {
  const options = parseCalibrationArgs(process.argv.slice(2));

  const eventStore = options.db ? new EventStore(options.db) : undefined;
  const settingsStore = options.settingsDb ? new SettingsStore(options.settingsDb) : undefined;

  try {
    const result = runCalibration({
      eventStore,
      settingsStore,
      runsDir: options.runsDir,
      apply: options.apply,
      actor: options.actor,
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

