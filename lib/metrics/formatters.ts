/**
 * Honest value formatters for the Metric Registry (R4-13, Requirement 40).
 *
 * Each `formatM*` function is a pure, total function of its recorded source: it
 * never throws, never estimates, and never reads a number out of model text. When
 * the source is present it returns the value computed from that source; when the
 * source is missing it returns a fixed fallback string with the reason:
 *
 *   - "not available"        general missing source (Requirement 40.2)
 *   - "not reported"         credits the CLI did not report (Requirement 40.15)
 *   - "Counts not available" test counts with no machine-readable report (40.5)
 *   - "not run"              a step an earlier failure or missing script skipped (40.7)
 *   - "No estimate yet"      fewer than 3 comparable runs (Requirement 40.10)
 *
 * Durations come only from the Necromancer clock (recorded `durationMs`/`ts`),
 * never from a wall clock read here. Install/build/test status is derived only
 * from `exitCode`, `timedOut` and `oomKilled` (Requirement 40.6). No score,
 * health percentage, confidence percentage or queue time estimate is produced.
 */
import type { MetricId } from "./registry";

/** A rendered metric value. `available` is false exactly when `text` is a fallback. */
export interface MetricValue {
  readonly available: boolean;
  readonly text: string;
  /** Present when `available` is false: why the source was missing. */
  readonly reason?: string;
  /** The numeric values the text was computed from (empty for pure fallbacks). */
  readonly numbers: readonly number[];
}

export const NOT_AVAILABLE = "not available";
export const NOT_REPORTED = "not reported";
export const COUNTS_NOT_AVAILABLE = "Counts not available";
export const NOT_RUN = "not run";
export const NO_ESTIMATE_YET = "No estimate yet";

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;
const MAX_LAST_WORDS = 120;
const DORMANT_MONTHS = 24;

function ok(text: string, numbers: readonly number[] = []): MetricValue {
  return { available: true, text, numbers };
}

function missing(fallback: string, reason: string): MetricValue {
  return { available: false, text: fallback, reason, numbers: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse a recorded ISO/epoch timestamp to epoch ms, or undefined. */
function time(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** One decimal place, trailing ".0" kept for stable output. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Human duration from Necromancer-clock milliseconds. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return NOT_AVAILABLE;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${round1(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

/** First line of a commit message, capped at 120 characters (M5). */
export function firstLine(message: string): string {
  const line = message.split(/\r?\n/, 1)[0] ?? "";
  return line.length > MAX_LAST_WORDS ? line.slice(0, MAX_LAST_WORDS) : line;
}

// ---------------------------------------------------------------------------
// Recorded source shapes. Every field is optional: a missing field is exactly
// the "source missing" case each formatter must render as a fallback.
// ---------------------------------------------------------------------------

/** M1: GitHub repository metadata, with the asOf date it was read at. */
export interface RepoMetaSource {
  stars?: number;
  forks?: number;
  archived?: boolean;
  defaultBranch?: string;
  asOf?: string;
}

/** M2: repository creation and default-branch head commit dates. */
export interface RepoDatesSource {
  createdAt?: string;
  lastCommitAt?: string;
}

/** M3/M4: the R3-11 inputs plus the asOf the computation is pinned to. */
export interface DeadAliveSource {
  createdAt?: string;
  lastCommitAt?: string;
  asOf?: string;
  archived?: boolean;
  deadReasons?: readonly string[];
  status?: "dead" | "alive";
}

/** M6: Grimoire signal counts per rule on the base and final trees. */
export interface GrimoireSignalsSource {
  base?: Readonly<Record<string, number>>;
  final?: Readonly<Record<string, number>>;
}

/** M7: a single detector signal location. */
export interface SignalLocationSource {
  ruleId?: string;
  file?: string;
  line?: number;
}

/** M8–M10: one recorded command.result row. */
export interface CommandResultSource {
  step?: string;
  commandLine?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  oomKilled?: boolean;
  durationMs?: number;
  /** "not run" when an earlier step failed or no script exists. */
  notRun?: boolean;
  notRunReason?: string;
}

/** M11: parsed machine-readable test counts, when a runner report exists. */
export interface TestCountsSource {
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
}

/** M13: "No tests found" detection metadata. */
export interface NoTestsFoundSource {
  detected?: boolean;
  language?: string;
  reason?: string;
}

/** M14: npm deprecation warnings; the line format is unknown while S3 is open. */
export interface DeprecationWarningsSource {
  /** Set only when a recorded S3 format exists and lines were counted. */
  count?: number;
  /** True once spike S3 has recorded npm's deprecation line format. */
  formatRecorded?: boolean;
}

/** M15: runtime versions taken from recorded version command results. */
export interface RuntimeVersionSource {
  node?: string;
  npm?: string;
  python?: string;
}

/** M16: lock file presence at a given sha. */
export interface LockFileSource {
  present?: boolean;
  sha?: string;
  name?: string;
}

/** M17: git diff --numstat size. */
export interface DiffSizeSource {
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

/** M18: latest task.state per task. */
export interface TaskStateSource {
  taskId: string;
  state: string;
}

/** M19: verdict event counts. */
export interface VerdictCountsSource {
  approve?: number;
  reject?: number;
}

/** M20: elapsed time per skeleton, from skeleton.raised ts and a clock `now`. */
export interface SkeletonElapsedSource {
  skeletonId: string;
  raisedAt: number;
}

/** M21: run elapsed and paused time from the Necromancer run.clock. */
export interface RunClockSource {
  elapsedMs?: number;
  pausedMs?: number;
}

/** M22: credits, only when probe P5 reported a credit field. */
export interface CreditsSource {
  perSkeleton?: Readonly<Record<string, number>>;
  perRun?: number;
  /** False when P5 showed no credit field: render "not reported". */
  reported?: boolean;
}

/** M24: budget meter on the capped dimension. */
export interface BudgetMeterSource {
  dimension?: string;
  percent?: number;
}

/** M25: wall times (ms) of comparable published runs. */
export interface ComparableRunsSource {
  /** Recorded wall times in ms; fewer than 3 yields "No estimate yet". */
  wallTimesMs?: readonly number[];
}

/** M26: queue position, with no time estimate. */
export interface QueuePositionSource {
  position?: number;
}

/** M27: test files added by skeletons in the diff. */
export interface TestsAddedSource {
  files?: readonly string[];
  /** Present only when the added test files were parseable into a count. */
  count?: number;
}

/** M28: report check result. */
export interface ReportCheckSource {
  checked?: boolean;
  passed?: boolean;
  note?: string;
}

/** M29: artifact size and hash from artifact.ready. */
export interface ArtifactSource {
  kind?: string;
  byteSize?: number;
  sha256?: string;
}

/** M30: Kiro CLI version, agents, verified models and session ids. */
export interface RunStartedSource {
  kiroCliVersion?: string;
  agents?: readonly string[];
  verifiedModels?: readonly string[];
  sessionIds?: readonly string[];
}

/** M31: history counts over stored runs. */
export interface HistoryCountsSource {
  total?: number;
  byOutcome?: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// M1–M7
// ---------------------------------------------------------------------------

/** M1: Stars, forks, archived, default branch, with asOf. */
export function formatM1(source: RepoMetaSource | null | undefined): MetricValue {
  const s = source ?? {};
  const asOf = str(s.asOf);
  if (!asOf) {
    return missing(NOT_AVAILABLE, "GitHub metadata has no asOf date");
  }
  const stars = num(s.stars);
  const forks = num(s.forks);
  if (stars === undefined || forks === undefined) {
    return missing(NOT_AVAILABLE, "GitHub stars/forks were not recorded");
  }
  const archived =
    s.archived === true
      ? "archived"
      : s.archived === false
      ? "not archived"
      : "archived status not available";
  const branch = str(s.defaultBranch) ?? NOT_AVAILABLE;
  const text = `${stars} stars, ${forks} forks, ${archived}, default branch ${branch} (as of ${asOf})`;
  return ok(text, [stars, forks]);
}

/** M2: Created date, last commit date. */
export function formatM2(source: RepoDatesSource | null | undefined): MetricValue {
  const s = source ?? {};
  const createdAt = str(s.createdAt);
  const lastCommitAt = str(s.lastCommitAt);
  if (!createdAt || !lastCommitAt) {
    return missing(NOT_AVAILABLE, "repository created/last-commit date was not recorded");
  }
  return ok(`Created ${createdAt}; last commit ${lastCommitAt}`);
}

/** M3: Years dead, lifespan (R3-11 formulas with asOf). */
export function formatM3(source: DeadAliveSource | null | undefined): MetricValue {
  const s = source ?? {};
  const createdAt = time(s.createdAt);
  const lastCommitAt = time(s.lastCommitAt);
  const asOf = time(s.asOf);
  if (createdAt === undefined || lastCommitAt === undefined || asOf === undefined) {
    return missing(NOT_AVAILABLE, "R3-11 inputs (created, last commit, asOf) incomplete");
  }
  const lifespanMs = lastCommitAt - createdAt;
  const yearsDead = round1((asOf - lastCommitAt) / MS_PER_DAY / DAYS_PER_YEAR);
  const lifespanText =
    lifespanMs < 0 ? "unknown" : `${round1(lifespanMs / MS_PER_DAY / DAYS_PER_YEAR)} years`;
  const text = `Lifespan ${lifespanText}; years dead ${yearsDead} (as of ${s.asOf})`;
  return ok(text, [yearsDead]);
}

/** M4: Dead or still breathing, reasons (R3-11). */
export function formatM4(source: DeadAliveSource | null | undefined): MetricValue {
  const s = source ?? {};
  if (s.status !== "dead" && s.status !== "alive") {
    return missing(NOT_AVAILABLE, "R3-11 status was not recorded");
  }
  if (s.status === "alive") {
    return ok("Still breathing");
  }
  const reasons = Array.isArray(s.deadReasons) ? s.deadReasons.filter(Boolean) : [];
  const reasonText = reasons.length > 0 ? reasons.join(", ") : "no reason recorded";
  return ok(`Dead: ${reasonText}`);
}

/** M5: Last Words — first line of the head commit message, at most 120 chars. */
export function formatM5(source: { lastCommitMessage?: string } | null | undefined): MetricValue {
  const message = str(source?.lastCommitMessage);
  if (message === undefined) {
    return missing(NOT_AVAILABLE, "head commit message was not recorded");
  }
  const line = firstLine(message);
  if (line.length === 0) {
    return missing(NOT_AVAILABLE, "head commit message was empty");
  }
  return ok(line);
}

/** M6: Grimoire signals per rule, base tree and final tree. */
export function formatM6(source: GrimoireSignalsSource | null | undefined): MetricValue {
  const s = source ?? {};
  const base = isRecord(s.base) ? s.base : undefined;
  const finalTree = isRecord(s.final) ? s.final : undefined;
  if (!base || !finalTree) {
    return missing(NOT_AVAILABLE, "Grimoire base/final signal counts were not recorded");
  }
  const rules = Array.from(new Set([...Object.keys(base), ...Object.keys(finalTree)])).sort();
  if (rules.length === 0) {
    return ok("No Grimoire signals on base or final tree");
  }
  const parts = rules.map((rule) => {
    const b = num(base[rule]) ?? 0;
    const f = num(finalTree[rule]) ?? 0;
    return `${rule}: base ${b}, final ${f}`;
  });
  return ok(parts.join("; "));
}

/** M7: Signal location (file:line). */
export function formatM7(source: SignalLocationSource | null | undefined): MetricValue {
  const s = source ?? {};
  const file = str(s.file);
  const line = num(s.line);
  const ruleId = str(s.ruleId);
  if (!file || line === undefined) {
    return missing(NOT_AVAILABLE, "detector signal has no file:line");
  }
  const prefix = ruleId ? `${ruleId} ` : "";
  return ok(`${prefix}${file}:${line}`);
}

// ---------------------------------------------------------------------------
// M8–M10: install, build, test — status from exitCode/timedOut/oomKilled only.
// ---------------------------------------------------------------------------

/** The status word for a command, derived only from the recorded result flags. */
export function commandStatus(source: CommandResultSource): string {
  if (source.timedOut === true) return "timed out";
  if (source.oomKilled === true) return "killed (out of memory)";
  const code = source.exitCode;
  if (typeof code === "number" && Number.isFinite(code)) {
    return code === 0 ? "passed" : `failed (exit ${code})`;
  }
  return NOT_AVAILABLE;
}

function formatCommandStep(
  source: CommandResultSource | null | undefined,
  label: string
): MetricValue {
  const s = source ?? {};
  if (s.notRun === true) {
    return missing(NOT_RUN, s.notRunReason ?? `${label} was not run`);
  }
  if (s.exitCode === undefined && s.timedOut !== true && s.oomKilled !== true) {
    return missing(NOT_AVAILABLE, `${label} command.result was not recorded`);
  }
  const status = commandStatus(s);
  const parts = [`${label}: ${status}`];
  const numbers: number[] = [];
  if (typeof s.exitCode === "number" && Number.isFinite(s.exitCode)) {
    parts.push(`exit ${s.exitCode}`);
    numbers.push(s.exitCode);
  }
  const duration = num(s.durationMs);
  if (duration !== undefined) {
    parts.push(formatDuration(duration));
  }
  return ok(parts.join(", "), numbers);
}

/** M8: Install status, exit code, duration. */
export function formatM8(source: CommandResultSource | null | undefined): MetricValue {
  return formatCommandStep(source, "Install");
}

/** M9: Build status, exit code, duration. */
export function formatM9(source: CommandResultSource | null | undefined): MetricValue {
  return formatCommandStep(source, "Build");
}

/** M10: Test status, exit code, duration. */
export function formatM10(source: CommandResultSource | null | undefined): MetricValue {
  return formatCommandStep(source, "Test");
}

// ---------------------------------------------------------------------------
// M11–M14
// ---------------------------------------------------------------------------

/** M11: Test counts from a parsed machine-readable report, else Counts not available. */
export function formatM11(source: TestCountsSource | null | undefined): MetricValue {
  const s = source ?? {};
  const passed = num(s.passed);
  const failed = num(s.failed);
  const skipped = num(s.skipped);
  const total = num(s.total);
  if (
    passed === undefined &&
    failed === undefined &&
    total === undefined &&
    skipped === undefined
  ) {
    return missing(COUNTS_NOT_AVAILABLE, "no machine-readable runner report was parsed");
  }
  const parts: string[] = [];
  const numbers: number[] = [];
  if (passed !== undefined) {
    parts.push(`${passed} passed`);
    numbers.push(passed);
  }
  if (failed !== undefined) {
    parts.push(`${failed} failed`);
    numbers.push(failed);
  }
  if (skipped !== undefined) {
    parts.push(`${skipped} skipped`);
    numbers.push(skipped);
  }
  if (total !== undefined) {
    parts.push(`${total} total`);
    numbers.push(total);
  }
  return ok(parts.join(", "), numbers);
}

/** M12: First failure excerpt — the stored log by logRef, verbatim. */
export function formatM12(source: { logRef?: string } | null | undefined): MetricValue {
  const logRef = str(source?.logRef);
  if (!logRef) {
    return missing(NOT_AVAILABLE, "no failure logRef was recorded");
  }
  return ok(logRef);
}

/** M13: "No tests found" detection metadata. */
export function formatM13(source: NoTestsFoundSource | null | undefined): MetricValue {
  const s = source ?? {};
  if (s.detected !== true) {
    return missing(NOT_AVAILABLE, "no 'No tests found' detection was recorded");
  }
  const language = str(s.language);
  const reason = str(s.reason);
  const parts = ["No tests found"];
  if (language) parts.push(`(${language})`);
  if (reason) parts.push(`— ${reason}`);
  return ok(parts.join(" "));
}

/** M14: npm deprecation warnings — not available while S3 format is unrecorded. */
export function formatM14(source: DeprecationWarningsSource | null | undefined): MetricValue {
  const s = source ?? {};
  if (s.formatRecorded !== true) {
    return missing(
      NOT_AVAILABLE,
      "npm deprecation warning line format is not yet recorded (spike S3)"
    );
  }
  const count = num(s.count);
  if (count === undefined) {
    return missing(NOT_AVAILABLE, "install log had no parseable deprecation lines recorded");
  }
  return ok(`${count} deprecation warnings`, [count]);
}

// ---------------------------------------------------------------------------
// M15–M19
// ---------------------------------------------------------------------------

/** M15: Runtime used, from recorded version command results. */
export function formatM15(source: RuntimeVersionSource | null | undefined): MetricValue {
  const s = source ?? {};
  const node = str(s.node);
  const npm = str(s.npm);
  const python = str(s.python);
  const parts: string[] = [];
  if (node) parts.push(`node ${node}`);
  if (npm) parts.push(`npm ${npm}`);
  if (python) parts.push(`python ${python}`);
  if (parts.length === 0) {
    return missing(NOT_AVAILABLE, "no runtime version command result was recorded");
  }
  return ok(parts.join(", "));
}

/** M16: Lock file present at the given sha. */
export function formatM16(source: LockFileSource | null | undefined): MetricValue {
  const s = source ?? {};
  if (s.present !== true && s.present !== false) {
    return missing(NOT_AVAILABLE, "lock file presence was not recorded");
  }
  const name = str(s.name) ?? "lock file";
  const sha = str(s.sha);
  const where = sha ? ` at ${sha}` : "";
  return ok(`${name} ${s.present ? "present" : "absent"}${where}`);
}

/** M17: Diff size (git diff --numstat). */
export function formatM17(source: DiffSizeSource | null | undefined): MetricValue {
  const s = source ?? {};
  const files = num(s.filesChanged);
  const insertions = num(s.insertions);
  const deletions = num(s.deletions);
  if (files === undefined && insertions === undefined && deletions === undefined) {
    return missing(NOT_AVAILABLE, "git diff --numstat was not recorded");
  }
  const parts: string[] = [];
  const numbers: number[] = [];
  if (files !== undefined) {
    parts.push(`${files} files changed`);
    numbers.push(files);
  }
  if (insertions !== undefined) {
    parts.push(`+${insertions}`);
    numbers.push(insertions);
  }
  if (deletions !== undefined) {
    parts.push(`-${deletions}`);
    numbers.push(deletions);
  }
  return ok(parts.join(", "), numbers);
}

/** M18: Tasks per state (latest task.state per task). */
export function formatM18(source: readonly TaskStateSource[] | null | undefined): MetricValue {
  if (!Array.isArray(source) || source.length === 0) {
    return missing(NOT_AVAILABLE, "no task states were recorded");
  }
  const latest = new Map<string, string>();
  for (const row of source) {
    if (row && typeof row.taskId === "string") {
      latest.set(row.taskId, row.state);
    }
  }
  if (latest.size === 0) {
    return missing(NOT_AVAILABLE, "no task states were recorded");
  }
  const counts = new Map<string, number>();
  for (const state of latest.values()) {
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => `${count} ${state}`);
  return ok(parts.join(", "));
}

/** M19: Verdict and reject counts (verdict events). */
export function formatM19(source: VerdictCountsSource | null | undefined): MetricValue {
  const s = source ?? {};
  const approve = num(s.approve);
  const reject = num(s.reject);
  if (approve === undefined && reject === undefined) {
    return missing(NOT_AVAILABLE, "no verdict events were recorded");
  }
  const parts: string[] = [];
  const numbers: number[] = [];
  if (approve !== undefined) {
    parts.push(`${approve} approved`);
    numbers.push(approve);
  }
  if (reject !== undefined) {
    parts.push(`${reject} rejected`);
    numbers.push(reject);
  }
  return ok(parts.join(", "), numbers);
}

// ---------------------------------------------------------------------------
// M20–M23
// ---------------------------------------------------------------------------

/** M20: Elapsed time per skeleton (ts from skeleton.raised, against clock now). */
export function formatM20(
  source: readonly SkeletonElapsedSource[] | null | undefined,
  now: number
): MetricValue {
  if (!Array.isArray(source) || source.length === 0) {
    return missing(NOT_AVAILABLE, "no skeleton.raised events were recorded");
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return missing(NOT_AVAILABLE, "Necromancer clock now is unavailable");
  }
  // Every row must be a well-formed record; a malformed element means the
  // source is unusable, so report it cleanly instead of throwing.
  for (const row of source) {
    if (
      !isRecord(row) ||
      typeof row.skeletonId !== "string" ||
      row.skeletonId.length === 0 ||
      typeof row.raisedAt !== "number" ||
      !Number.isFinite(row.raisedAt)
    ) {
      return missing(NOT_AVAILABLE, "a skeleton.raised record was malformed");
    }
  }
  const parts = source.map((row) => {
    const elapsed = Math.max(0, now - row.raisedAt);
    return `${row.skeletonId}: ${formatDuration(elapsed)}`;
  });
  return ok(parts.join("; "));
}

/** M21: Run elapsed and paused time (run.clock, Necromancer clock only). */
export function formatM21(source: RunClockSource | null | undefined): MetricValue {
  const s = source ?? {};
  const elapsed = num(s.elapsedMs);
  const paused = num(s.pausedMs);
  if (elapsed === undefined && paused === undefined) {
    return missing(NOT_AVAILABLE, "run.clock was not recorded");
  }
  const parts: string[] = [];
  if (elapsed !== undefined) parts.push(`elapsed ${formatDuration(elapsed)}`);
  if (paused !== undefined) parts.push(`paused ${formatDuration(paused)}`);
  return ok(parts.join(", "));
}

/** M22: Credits per skeleton and per run; "not reported" unless P5 reported them. */
export function formatM22(source: CreditsSource | null | undefined): MetricValue {
  const s = source ?? {};
  if (s.reported !== true) {
    return missing(NOT_REPORTED, "the CLI did not report a credit field (probe P5)");
  }
  const perRun = num(s.perRun);
  const perSkeleton = isRecord(s.perSkeleton) ? s.perSkeleton : undefined;
  const parts: string[] = [];
  const numbers: number[] = [];
  if (perRun !== undefined) {
    parts.push(`${perRun} credits this run`);
    numbers.push(perRun);
  }
  if (perSkeleton) {
    const entries = Object.entries(perSkeleton)
      .map(([id, value]) => [id, num(value)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined);
    for (const [id, value] of entries) {
      parts.push(`${id}: ${value}`);
      numbers.push(value);
    }
  }
  if (parts.length === 0) {
    return missing(NOT_REPORTED, "the CLI reported no credit values (probe P5)");
  }
  return ok(parts.join("; "), numbers);
}

/** M23: Tool-call count (count of skeleton.tool_call). */
export function formatM23(source: { count?: number } | null | undefined): MetricValue {
  const count = num(source?.count);
  if (count === undefined) {
    return missing(NOT_AVAILABLE, "no skeleton.tool_call events were recorded");
  }
  return ok(`${count} tool calls`, [count]);
}

// ---------------------------------------------------------------------------
// M24–M27
// ---------------------------------------------------------------------------

/** M24: Budget meter (budget.update.percent on the capped dimension). */
export function formatM24(source: BudgetMeterSource | null | undefined): MetricValue {
  const s = source ?? {};
  const percent = num(s.percent);
  const dimension = str(s.dimension);
  if (percent === undefined || !dimension) {
    return missing(NOT_AVAILABLE, "budget.update.percent was not recorded");
  }
  return ok(`${dimension} budget ${percent}% used`, [percent]);
}

/** M25: Comparable run duration range, only with at least 3 comparable runs. */
export function formatM25(source: ComparableRunsSource | null | undefined): MetricValue {
  const s = source ?? {};
  const wallTimes = Array.isArray(s.wallTimesMs)
    ? s.wallTimesMs.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0)
    : [];
  if (wallTimes.length < 3) {
    return missing(NO_ESTIMATE_YET, `only ${wallTimes.length} comparable published runs`);
  }
  const shortest = Math.min(...wallTimes);
  const longest = Math.max(...wallTimes);
  const text = `Runs like this took between ${formatDuration(shortest)} and ${formatDuration(longest)}`;
  return ok(text, [shortest, longest]);
}

/** M26: Queue position, with no time estimate. */
export function formatM26(source: QueuePositionSource | null | undefined): MetricValue {
  const position = num(source?.position);
  if (position === undefined) {
    return missing(NOT_AVAILABLE, "run.queue_position was not recorded");
  }
  return ok(`Queue position ${position}`, [position]);
}

/** M27: Tests added by skeletons (test files added in the diff, separate row). */
export function formatM27(source: TestsAddedSource | null | undefined): MetricValue {
  const s = source ?? {};
  const files = Array.isArray(s.files) ? s.files.filter((f): f is string => typeof f === "string") : [];
  const count = num(s.count);
  if (files.length === 0 && count === undefined) {
    return missing(NOT_AVAILABLE, "no test files added in the diff were recorded");
  }
  const parts: string[] = [];
  const numbers: number[] = [];
  if (count !== undefined) {
    parts.push(`${count} test files added`);
    numbers.push(count);
  } else {
    parts.push(`${files.length} test files added`);
    numbers.push(files.length);
  }
  if (files.length > 0) {
    parts.push(`(${files.join(", ")})`);
  }
  return ok(parts.join(" "), numbers);
}

// ---------------------------------------------------------------------------
// M28–M31
// ---------------------------------------------------------------------------

/** M28: Report check result (report.checked). */
export function formatM28(source: ReportCheckSource | null | undefined): MetricValue {
  const s = source ?? {};
  if (s.checked !== true && s.checked !== false) {
    return missing(NOT_AVAILABLE, "report.checked was not recorded");
  }
  if (s.checked === false) {
    return ok("Report not checked");
  }
  if (typeof s.passed !== "boolean") {
    return missing(NOT_AVAILABLE, "report check result is missing");
  }
  const passed = s.passed;
  const note = str(s.note);
  const base = passed ? "Report check passed" : "Report check failed";
  return ok(note ? `${base} — ${note}` : base);
}

/** M29: Artifact size and hash (artifact.ready). */
export function formatM29(source: ArtifactSource | null | undefined): MetricValue {
  const s = source ?? {};
  const byteSize = num(s.byteSize);
  const sha256 = str(s.sha256);
  const kind = str(s.kind);
  if (byteSize === undefined && !sha256) {
    return missing(NOT_AVAILABLE, "artifact.ready size/hash was not recorded");
  }
  const parts: string[] = [];
  const numbers: number[] = [];
  if (kind) parts.push(kind);
  if (byteSize !== undefined) {
    parts.push(`${byteSize} bytes`);
    numbers.push(byteSize);
  }
  if (sha256) parts.push(`sha256 ${sha256}`);
  return ok(parts.join(", "), numbers);
}

/** M30: Kiro CLI version, agents, verified models, session IDs. */
export function formatM30(source: RunStartedSource | null | undefined): MetricValue {
  const s = source ?? {};
  const version = str(s.kiroCliVersion);
  const agents = Array.isArray(s.agents) ? s.agents.filter((a): a is string => typeof a === "string") : [];
  const models = Array.isArray(s.verifiedModels)
    ? s.verifiedModels.filter((m): m is string => typeof m === "string")
    : [];
  const sessionIds = Array.isArray(s.sessionIds)
    ? s.sessionIds.filter((id): id is string => typeof id === "string")
    : [];
  const parts: string[] = [];
  if (version) parts.push(`Kiro CLI ${version}`);
  if (agents.length > 0) parts.push(`agents: ${agents.join(", ")}`);
  if (models.length > 0) parts.push(`verified models: ${models.join(", ")}`);
  if (sessionIds.length > 0) parts.push(`sessions: ${sessionIds.join(", ")}`);
  if (parts.length === 0) {
    return missing(NOT_AVAILABLE, "no run.started/skeleton.raised details were recorded");
  }
  return ok(parts.join("; "));
}

/** M31: History counts over stored runs. */
export function formatM31(source: HistoryCountsSource | null | undefined): MetricValue {
  const s = source ?? {};
  const total = num(s.total);
  const byOutcome = isRecord(s.byOutcome) ? s.byOutcome : undefined;
  if (total === undefined && !byOutcome) {
    return missing(NOT_AVAILABLE, "no stored runs were recorded");
  }
  const parts: string[] = [];
  const numbers: number[] = [];
  if (total !== undefined) {
    parts.push(`${total} runs`);
    numbers.push(total);
  }
  if (byOutcome) {
    const outcomes = Object.entries(byOutcome)
      .map(([key, value]) => [key, num(value)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of outcomes) {
      parts.push(`${key}: ${value}`);
      numbers.push(value);
    }
  }
  if (parts.length === 0) {
    return missing(NOT_AVAILABLE, "no stored runs were recorded");
  }
  return ok(parts.join(", "), numbers);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** A formatter for one metric row: takes its recorded source, returns a value. */
export type MetricFormatter = (source: unknown) => MetricValue;

/**
 * Formatters keyed by metric id. M20 needs a clock reading, so its entry reads
 * `now` from a `now` field on the source when present; callers that track the
 * Necromancer clock pass `{ skeletons, now }`.
 */
export const METRIC_FORMATTERS: Readonly<Record<MetricId, MetricFormatter>> = {
  M1: (s) => formatM1(s as RepoMetaSource),
  M2: (s) => formatM2(s as RepoDatesSource),
  M3: (s) => formatM3(s as DeadAliveSource),
  M4: (s) => formatM4(s as DeadAliveSource),
  M5: (s) => formatM5(s as { lastCommitMessage?: string }),
  M6: (s) => formatM6(s as GrimoireSignalsSource),
  M7: (s) => formatM7(s as SignalLocationSource),
  M8: (s) => formatM8(s as CommandResultSource),
  M9: (s) => formatM9(s as CommandResultSource),
  M10: (s) => formatM10(s as CommandResultSource),
  M11: (s) => formatM11(s as TestCountsSource),
  M12: (s) => formatM12(s as { logRef?: string }),
  M13: (s) => formatM13(s as NoTestsFoundSource),
  M14: (s) => formatM14(s as DeprecationWarningsSource),
  M15: (s) => formatM15(s as RuntimeVersionSource),
  M16: (s) => formatM16(s as LockFileSource),
  M17: (s) => formatM17(s as DiffSizeSource),
  M18: (s) => formatM18(s as readonly TaskStateSource[]),
  M19: (s) => formatM19(s as VerdictCountsSource),
  M20: (s) => {
    const record = isRecord(s) ? s : {};
    const now = num(record.now) ?? Number.NaN;
    const rows = Array.isArray(record.skeletons)
      ? (record.skeletons as readonly SkeletonElapsedSource[])
      : (s as readonly SkeletonElapsedSource[]);
    return formatM20(rows, now);
  },
  M21: (s) => formatM21(s as RunClockSource),
  M22: (s) => formatM22(s as CreditsSource),
  M23: (s) => formatM23(s as { count?: number }),
  M24: (s) => formatM24(s as BudgetMeterSource),
  M25: (s) => formatM25(s as ComparableRunsSource),
  M26: (s) => formatM26(s as QueuePositionSource),
  M27: (s) => formatM27(s as TestsAddedSource),
  M28: (s) => formatM28(s as ReportCheckSource),
  M29: (s) => formatM29(s as ArtifactSource),
  M30: (s) => formatM30(s as RunStartedSource),
  M31: (s) => formatM31(s as HistoryCountsSource),
};

/** Format one metric row by id. */
export function formatMetric(id: MetricId, source: unknown): MetricValue {
  return METRIC_FORMATTERS[id](source);
}