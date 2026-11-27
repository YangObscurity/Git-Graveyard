// Task 23.2: Deterministic report verification for the Scribe reading.
// Requirements: 26.6, 26.7, 26.8, 26.16, 26.17, 41.1, 41.3.

import type { EventEnvelope } from "../events/event-store";
import { type EventStore } from "../events/event-store";
import type { RunOutcome } from "../runs/run-store";
import {
  SCRIBE_NARRATIVE_FALLBACK_NOTICE,
  EVIDENCE_MARKER_PREFIXES,
  type UnbackedClaimItem,
} from "../lifecycle/report-step";
import {
  evaluateReportOutcome,
  type ReportOutcomeEvaluationInput,
} from "../lifecycle/outcome-evaluator";
import { redactEventData, redactText, type Redactor, type RedactionOptions } from "../security/redactor";

export type { UnbackedClaimItem };

/**
 * Status assertions that must always carry an evidence marker.
 */
export const STATUS_KEYWORDS = [
  "passed",
  "failed",
  "fixed",
  "broken",
  "installed",
  "built",
  "merged",
  "skipped",
  "upgraded",
  "resurrected",
  "clean",
  "succeeded",
  "error",
  "not run",
] as const;

export type StatusKeyword = (typeof STATUS_KEYWORDS)[number];

export const EVIDENCE_MARKER_PREFIX_LIST: readonly string[] =
  EVIDENCE_MARKER_PREFIXES;

// Marker token: prefix followed by a non-space, non-delimiter payload.
export const EVIDENCE_MARKER_REGEX =
  /\b(?:cmd|file|gh|ev):[^\s,;)\]}"']+/gi;

const NUMERAL_REGEX = /\d/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STATUS_REGEX = new RegExp(
  `\\b(?:${STATUS_KEYWORDS.map((k) => escapeRegExp(k)).join("|")})\\b`,
  "i"
);

export interface EvidenceCommandResult {
  readonly id?: string;
  readonly commandId?: string;
  readonly ref?: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly [key: string]: unknown;
}

export interface EvidenceIndexInput {
  readonly events?: readonly EventEnvelope[];
  readonly commandResults?: readonly EvidenceCommandResult[];
  readonly files?: readonly string[];
  readonly github?: readonly string[];
  readonly markers?: readonly string[];
}

/**
 * Normalizes a file marker payload by dropping a trailing `:line` suffix and any
 * leading `./` so `file:src/a.ts` and `file:src/a.ts:12` resolve the same path.
 */
export function normalizeFilePath(value: string): string {
  let norm = value.trim();
  norm = norm.replace(/:\d+$/, "");
  norm = norm.replace(/^\.\//, "");
  return norm;
}

/**
 * Deterministic evidence resolver indexed from events, command results, artifact
 * and workspace file paths, and GitHub snapshots.
 */
export class EvidenceIndex {
  readonly commandIds: ReadonlySet<string>;
  readonly filePaths: ReadonlySet<string>;
  readonly githubRefs: ReadonlySet<string>;
  readonly eventSeqs: ReadonlySet<number>;
  readonly rawMarkers: ReadonlySet<string>;

  constructor(
    input: {
      commandIds?: Iterable<string>;
      filePaths?: Iterable<string>;
      githubRefs?: Iterable<string>;
      eventSeqs?: Iterable<number>;
      rawMarkers?: Iterable<string>;
    } = {}
  ) {
    this.commandIds = new Set(input.commandIds ?? []);
    this.filePaths = new Set(input.filePaths ?? []);
    this.githubRefs = new Set(input.githubRefs ?? []);
    this.eventSeqs = new Set(input.eventSeqs ?? []);
    this.rawMarkers = new Set(input.rawMarkers ?? []);
  }

  /**
   * Resolves one citation marker against the index. Returns false for fabricated
   * or non-existent references.
   */
  resolve(marker: string): boolean {
    if (typeof marker !== "string") {
      return false;
    }
    const trimmed = marker.trim();
    if (trimmed.length === 0) {
      return false;
    }
    if (this.rawMarkers.has(trimmed)) {
      return true;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      return false;
    }
    const prefix = trimmed.slice(0, colon).toLowerCase();
    const value = trimmed.slice(colon + 1);
    switch (prefix) {
      case "cmd":
        return this.commandIds.has(value);
      case "gh":
        return this.githubRefs.has(value);
      case "ev": {
        const seq = Number(value);
        return Number.isInteger(seq) && this.eventSeqs.has(seq);
      }
      case "file": {
        const normalized = normalizeFilePath(value);
        return this.filePaths.has(value) || this.filePaths.has(normalized);
      }
      default:
        return false;
    }
  }
}

interface CollectedMarkers {
  commandIds: Set<string>;
  filePaths: Set<string>;
  githubRefs: Set<string>;
  eventSeqs: Set<number>;
  rawMarkers: Set<string>;
}

function addMarker(collected: CollectedMarkers, marker: string): void {
  if (typeof marker !== "string") {
    return;
  }
  const trimmed = marker.trim();
  if (trimmed.length === 0) {
    return;
  }
  collected.rawMarkers.add(trimmed);
  const colon = trimmed.indexOf(":");
  if (colon <= 0) {
    return;
  }
  const prefix = trimmed.slice(0, colon).toLowerCase();
  const value = trimmed.slice(colon + 1);
  switch (prefix) {
    case "cmd":
      collected.commandIds.add(value);
      break;
    case "gh":
      collected.githubRefs.add(value);
      break;
    case "ev": {
      const seq = Number(value);
      if (Number.isInteger(seq)) {
        collected.eventSeqs.add(seq);
      }
      break;
    }
    case "file":
      collected.filePaths.add(normalizeFilePath(value));
      collected.filePaths.add(value);
      break;
    default:
      break;
  }
}

/**
 * Builds an EvidenceIndex from stored events, command results, artifact or
 * workspace file paths, and GitHub snapshots.
 */
export function buildEvidenceIndex(input: EvidenceIndexInput = {}): EvidenceIndex {
  const collected: CollectedMarkers = {
    commandIds: new Set<string>(),
    filePaths: new Set<string>(),
    githubRefs: new Set<string>(),
    eventSeqs: new Set<number>(),
    rawMarkers: new Set<string>(),
  };

  for (const event of input.events ?? []) {
    if (!event) {
      continue;
    }
    if (typeof event.seq === "number") {
      collected.eventSeqs.add(event.seq);
      collected.rawMarkers.add(`ev:${event.seq}`);
    }
    const data = event.data as Record<string, unknown> | undefined;
    if (data) {
      if (Array.isArray(data.refs)) {
        for (const ref of data.refs) {
          addMarker(collected, String(ref));
        }
      }
      const id = data.id ?? data.commandId ?? data.commandRef;
      if (
        typeof id === "string" &&
        (event.kind === "command.result" || event.kind === "command.started")
      ) {
        collected.commandIds.add(id);
        collected.rawMarkers.add(`cmd:${id}`);
      }
      const path = data.path ?? data.file;
      if (typeof path === "string" && event.kind === "artifact.ready") {
        collected.filePaths.add(normalizeFilePath(path));
      }
      const ghRef = data.githubRef;
      if (typeof ghRef === "string" && event.kind === "push.result") {
        addMarker(collected, `gh:${ghRef}`);
      }
    }
  }

  for (const result of input.commandResults ?? []) {
    if (!result) {
      continue;
    }
    const id = result.id ?? result.commandId;
    if (typeof id === "string" && id.length > 0) {
      collected.commandIds.add(id);
      collected.rawMarkers.add(`cmd:${id}`);
    }
    if (typeof result.ref === "string" && result.ref.length > 0) {
      addMarker(collected, result.ref);
    }
  }

  for (const file of input.files ?? []) {
    if (typeof file === "string" && file.length > 0) {
      collected.filePaths.add(normalizeFilePath(file));
      collected.filePaths.add(file);
    }
  }

  for (const gh of input.github ?? []) {
    if (typeof gh === "string" && gh.length > 0) {
      collected.githubRefs.add(gh);
      collected.rawMarkers.add(`gh:${gh}`);
    }
  }

  for (const marker of input.markers ?? []) {
    addMarker(collected, marker);
  }

  return new EvidenceIndex(collected);
}

export interface ReportCheckResult {
  readonly passed: boolean;
  readonly unbackedClaims: readonly UnbackedClaimItem[];
  readonly checkedCount: number;
  readonly resolvedMarkers: readonly string[];
}

/**
 * Splits the reading into sentences on sentence terminators and newlines.
 */
export function splitSentences(reading: string): string[] {
  if (!reading || typeof reading !== "string") {
    return [];
  }
  return reading
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Splits a sentence into clauses on semicolons and comma+space boundaries.
 */
export function splitClauses(sentence: string): string[] {
  if (!sentence || typeof sentence !== "string") {
    return [];
  }
  return sentence
    .split(/;\s*|,(?=\s)\s*/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Extracts citation markers from a text fragment.
 */
export function extractMarkers(text: string): string[] {
  if (!text || typeof text !== "string") {
    return [];
  }
  const regex = new RegExp(EVIDENCE_MARKER_REGEX.source, EVIDENCE_MARKER_REGEX.flags);
  const markers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    markers.push(match[0]);
    if (match[0].length === 0) {
      regex.lastIndex++;
    }
  }
  return markers;
}

function stripMarkers(text: string): string {
  const regex = new RegExp(EVIDENCE_MARKER_REGEX.source, EVIDENCE_MARKER_REGEX.flags);
  return text.replace(regex, " ");
}

function detectStatus(text: string): StatusKeyword | null {
  const match = text.match(STATUS_REGEX);
  if (!match) {
    return null;
  }
  return match[0].toLowerCase() as StatusKeyword;
}

/**
 * Verifies the Scribe reading clause-by-clause. Every clause that states a numeral
 * or a status keyword must carry at least one resolvable citation marker.
 */
export function checkReading(
  reading: string,
  index: EvidenceIndex
): ReportCheckResult {
  if (!reading || typeof reading !== "string" || reading.trim().length === 0) {
    return {
      passed: true,
      unbackedClaims: [],
      checkedCount: 0,
      resolvedMarkers: [],
    };
  }

  const unbackedClaims: UnbackedClaimItem[] = [];
  const resolvedMarkers: string[] = [];
  let checkedCount = 0;

  for (const sentence of splitSentences(reading)) {
    for (const clause of splitClauses(sentence)) {
      const withoutMarkers = stripMarkers(clause);
      const hasNumeral = NUMERAL_REGEX.test(withoutMarkers);
      const status = detectStatus(withoutMarkers);
      if (!hasNumeral && !status) {
        continue;
      }
      checkedCount++;
      const markers = extractMarkers(clause);
      const claim: string = status ?? "numeral";
      if (markers.length === 0) {
        unbackedClaims.push({
          claim,
          text: clause.trim(),
          reason: "Missing required evidence marker (cmd:, file:, gh:, ev:)",
        });
        continue;
      }
      for (const marker of markers) {
        if (index.resolve(marker)) {
          resolvedMarkers.push(marker);
        } else {
          unbackedClaims.push({
            claim,
            text: clause.trim(),
            ref: marker,
            reason: `Evidence marker '${marker}' not found in stored evidence`,
          });
        }
      }
    }
  }

  return {
    passed: unbackedClaims.length === 0,
    unbackedClaims,
    checkedCount,
    resolvedMarkers: Array.from(new Set(resolvedMarkers)),
  };
}

export class ReportCheck {
  verify(reading: string, index: EvidenceIndex): ReportCheckResult {
    return checkReading(reading, index);
  }
}

export interface ReportCheckRetryOptions {
  readonly reading: string;
  readonly index: EvidenceIndex;
  readonly retry: (
    unbackedClaims: readonly UnbackedClaimItem[]
  ) => string | null | Promise<string | null>;
  readonly eventStore?: EventStore;
  readonly runId?: string;
  readonly actor?: string;
  readonly redactionOptions?: RedactionOptions;
}

export interface ReportCheckRetryResult {
  readonly passed: boolean;
  readonly reading: string;
  readonly narrativeDropped: boolean;
  readonly fallbackNotice: string | null;
  readonly reportCheck: ReportCheckResult;
  readonly retried: boolean;
  readonly reportCheckedEvent: EventEnvelope | null;
}

function emitReportChecked(
  eventStore: EventStore,
  runId: string,
  actor: string,
  data: Record<string, unknown>,
  redactionOptions?: RedactionOptions
): EventEnvelope {
  const redacted = redactEventData(data, redactionOptions);
  return eventStore.append({
    runId,
    kind: "report.checked",
    actor,
    data: redacted,
  });
}

/**
 * Verifies the initial Scribe draft; on failure it invokes the retry callback once
 * with the exact unbacked claims. When the retry still fails the reading is dropped
 * and replaced with the fallback notice, and a redacted `report.checked` event is
 * recorded either way.
 */
export async function runReportCheckWithRetry(
  options: ReportCheckRetryOptions
): Promise<ReportCheckRetryResult> {
  const actor = options.actor ?? "ScribeService";
  const index = options.index;

  const first = checkReading(options.reading, index);

  const emit = (
    result: ReportCheckResult,
    finalReading: string,
    narrativeDropped: boolean,
    retried: boolean
  ): EventEnvelope | null => {
    if (!options.eventStore || !options.runId) {
      return null;
    }
    return emitReportChecked(
      options.eventStore,
      options.runId,
      actor,
      {
        passed: result.passed,
        checkedCount: result.checkedCount,
        resolvedMarkers: result.resolvedMarkers,
        unbackedClaims: result.unbackedClaims.map((c) => ({
          claim: c.claim,
          ref: c.ref ?? null,
          reason: c.reason,
          text: c.text,
        })),
        narrativeDropped,
        fallbackNotice: narrativeDropped
          ? SCRIBE_NARRATIVE_FALLBACK_NOTICE
          : null,
        retried,
        readingLength: finalReading.length,
        refs: [],
      },
      options.redactionOptions
    );
  };

  if (first.passed) {
    const event = emit(first, options.reading, false, false);
    return {
      passed: true,
      reading: options.reading,
      narrativeDropped: false,
      fallbackNotice: null,
      reportCheck: first,
      retried: false,
      reportCheckedEvent: event,
    };
  }

  let retriedReading: string | null = null;
  try {
    retriedReading = await options.retry(first.unbackedClaims);
  } catch {
    retriedReading = null;
  }

  if (typeof retriedReading === "string" && retriedReading.trim().length > 0) {
    const second = checkReading(retriedReading, index);
    if (second.passed) {
      const event = emit(second, retriedReading, false, true);
      return {
        passed: true,
        reading: retriedReading,
        narrativeDropped: false,
        fallbackNotice: null,
        reportCheck: second,
        retried: true,
        reportCheckedEvent: event,
      };
    }
  }

  const fallbackReading = SCRIBE_NARRATIVE_FALLBACK_NOTICE;
  const droppedCheck: ReportCheckResult = {
    passed: false,
    unbackedClaims: first.unbackedClaims,
    checkedCount: first.checkedCount,
    resolvedMarkers: first.resolvedMarkers,
  };
  const event = emit(droppedCheck, fallbackReading, true, true);
  return {
    passed: false,
    reading: fallbackReading,
    narrativeDropped: true,
    fallbackNotice: SCRIBE_NARRATIVE_FALLBACK_NOTICE,
    reportCheck: droppedCheck,
    retried: true,
    reportCheckedEvent: event,
  };
}

export type InstallErrorContext = "baseline" | "new";

export interface InstallErrorRow {
  readonly context: InstallErrorContext;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly error: string;
  readonly ref: string | null;
}

export interface InstallErrorInput {
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly error?: string;
  readonly message?: string;
  readonly stderr?: string;
  readonly ref?: string;
}

export type InstallErrorLike = string | InstallErrorInput | null | undefined;

export interface InstallComparison {
  readonly hasInstallErrors: boolean;
  readonly baseline: InstallErrorRow | null;
  readonly new: InstallErrorRow | null;
  readonly rows: readonly InstallErrorRow[];
}

export interface RunOutcomeAssignment {
  readonly outcome: RunOutcome;
  readonly installComparison: InstallComparison;
}

export interface AssignOutcomeInput extends ReportOutcomeEvaluationInput {
  readonly baselineInstallError?: InstallErrorLike;
  readonly newInstallError?: InstallErrorLike;
  readonly redactor?: Redactor;
  readonly redactionOptions?: RedactionOptions;
}

/**
 * Redacts install error text with the injected redactor (when supplied) on top of
 * the built-in `redactText` engine so secret tokens and keys never reach the
 * `InstallErrorRow` rows returned in the install comparison.
 */
function redactInstallText(
  text: string,
  redactor?: Redactor,
  redactionOptions?: RedactionOptions
): string {
  const base = redactText(text, redactionOptions);
  if (!redactor || typeof redactor.redactText !== "function") {
    return base;
  }
  try {
    return redactor.redactText(base);
  } catch {
    return base;
  }
}

function toInstallRow(
  context: InstallErrorContext,
  value: InstallErrorLike,
  redactor?: Redactor,
  redactionOptions?: RedactionOptions
): InstallErrorRow | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0
      ? null
      : {
          context,
          command: null,
          exitCode: null,
          error: redactInstallText(trimmed, redactor, redactionOptions),
          ref: null,
        };
  }
  const error = value.error ?? value.stderr ?? value.message ?? "";
  const row: InstallErrorRow = {
    context,
    command: value.command ?? null,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    error: redactInstallText(String(error), redactor, redactionOptions),
    ref: value.ref ?? null,
  };
  if (
    row.error.length === 0 &&
    row.command === null &&
    row.exitCode === null &&
    row.ref === null
  ) {
    return null;
  }
  return row;
}

function buildInstallComparison(
  baseline: InstallErrorLike,
  newError: InstallErrorLike,
  redactor?: Redactor,
  redactionOptions?: RedactionOptions
): InstallComparison {
  const baselineRow = toInstallRow("baseline", baseline, redactor, redactionOptions);
  const newRow = toInstallRow("new", newError, redactor, redactionOptions);
  const rows: InstallErrorRow[] = [];
  if (baselineRow) {
    rows.push(baselineRow);
  }
  if (newRow) {
    rows.push(newRow);
  }
  return {
    hasInstallErrors: rows.length > 0,
    baseline: baselineRow,
    new: newRow,
    rows,
  };
}

/**
 * Assigns the run outcome with the deterministic report evaluator and attaches the
 * structured side-by-side baseline vs new installation error rows.
 */
export function assignRunOutcomeWithInstallComparison(
  input: AssignOutcomeInput
): RunOutcomeAssignment {
  const outcome = evaluateReportOutcome(input);
  const installComparison = buildInstallComparison(
    input.baselineInstallError,
    input.newInstallError,
    input.redactor,
    input.redactionOptions
  );
  return { outcome, installComparison };
}

export const EVIDENCE_CHECK_FALLBACK_NOTICE = SCRIBE_NARRATIVE_FALLBACK_NOTICE;
