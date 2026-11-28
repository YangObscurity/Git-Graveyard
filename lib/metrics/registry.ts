/**
 * Honest Metric Registry (R4-13, Requirement 40).
 *
 * Every number the UI may render maps to exactly one row below. A row names the
 * authoritative recorded source the value is computed from; nothing here invents,
 * estimates or reads a number out of model text. The formatters in
 * `lib/metrics/formatters` turn those recorded sources into display values, and a
 * missing source always renders a fixed fallback string rather than a guess.
 */

/** The twenty-one metric rows M1 to M31 (M8–M10 share one row definition). */
export type MetricId =
  | "M1"
  | "M2"
  | "M3"
  | "M4"
  | "M5"
  | "M6"
  | "M7"
  | "M8"
  | "M9"
  | "M10"
  | "M11"
  | "M12"
  | "M13"
  | "M14"
  | "M15"
  | "M16"
  | "M17"
  | "M18"
  | "M19"
  | "M20"
  | "M21"
  | "M22"
  | "M23"
  | "M24"
  | "M25"
  | "M26"
  | "M27"
  | "M28"
  | "M29"
  | "M30"
  | "M31";

/** One Metric Registry row: what is shown and where its value comes from. */
export interface MetricDefinition {
  readonly id: MetricId;
  /** What the row shows on screen. */
  readonly shown: string;
  /** The authoritative recorded source the value is computed from. */
  readonly source: string;
}

/**
 * The full registry, M1 to M31, transcribed from the R4-13 table. Order is the
 * table order; M8 to M10 are three rows that share the "command.result" source.
 */
export const METRIC_REGISTRY: readonly MetricDefinition[] = [
  {
    id: "M1",
    shown: "Stars, forks, archived, default branch",
    source: "GitHub GET /repos/{owner}/{repo}, with asOf",
  },
  {
    id: "M2",
    shown: "Created date, last commit date",
    source: "created_at; committer date of the default-branch head",
  },
  {
    id: "M3",
    shown: "Years dead, lifespan",
    source: "R3-11 formulas with asOf",
  },
  {
    id: "M4",
    shown: "Dead or still breathing, reasons",
    source: "R3-11",
  },
  {
    id: "M5",
    shown: "Last Words",
    source: "First line of the head commit message, at most 120 characters",
  },
  {
    id: "M6",
    shown: "Grimoire signals per rule",
    source: "Grimoire detector on the base tree and on the final tree",
  },
  {
    id: "M7",
    shown: "Signal location",
    source: "Detector file:line",
  },
  {
    id: "M8",
    shown: "Install: status, exit code, duration",
    source: "command.result of the install command",
  },
  {
    id: "M9",
    shown: "Build: status, exit code, duration",
    source: "command.result of the build command",
  },
  {
    id: "M10",
    shown: "Test: status, exit code, duration",
    source: "command.result of the test command",
  },
  {
    id: "M11",
    shown: "Test counts",
    source: "Parsed machine-readable runner output; otherwise Counts not available",
  },
  {
    id: "M12",
    shown: "First failure excerpt",
    source: "Stored log by logRef, verbatim, linked",
  },
  {
    id: "M13",
    shown: "No tests found",
    source:
      "Node: no scripts.test or the default placeholder; Python: pytest --collect-only exit code 5 or no test files",
  },
  {
    id: "M14",
    shown: "npm deprecation warnings",
    source:
      "Count of install-log lines in npm's deprecation format (format unknown, spike S3)",
  },
  {
    id: "M15",
    shown: "Runtime used",
    source: "command.result of the version commands",
  },
  {
    id: "M16",
    shown: "Lock file present",
    source: "File existence at the given sha",
  },
  {
    id: "M17",
    shown: "Diff size",
    source: "git diff --numstat base to final head",
  },
  {
    id: "M18",
    shown: "Tasks per state",
    source: "Latest task.state per task",
  },
  {
    id: "M19",
    shown: "Verdict and reject counts",
    source: "verdict events",
  },
  {
    id: "M20",
    shown: "Elapsed time per skeleton",
    source: "ts from skeleton.raised",
  },
  {
    id: "M21",
    shown: "Run elapsed and paused time",
    source: "run.clock",
  },
  {
    id: "M22",
    shown: "Credits per skeleton and per run",
    source:
      "skeleton.usage.credits from turn_completion if probe P5 shows a credit field; otherwise not reported. Never estimated",
  },
  {
    id: "M23",
    shown: "Tool-call count",
    source: "Count of skeleton.tool_call",
  },
  {
    id: "M24",
    shown: "Budget meter",
    source: "budget.update.percent on the capped dimension",
  },
  {
    id: "M25",
    shown: "Runs like this took between X and Y",
    source:
      "Wall times of at least 3 comparable published runs; otherwise No estimate yet",
  },
  {
    id: "M26",
    shown: "Queue position",
    source: "run.queue_position; no time estimate",
  },
  {
    id: "M27",
    shown: "Tests added by skeletons",
    source: "Test files added in the diff, counts if parseable; separate row",
  },
  {
    id: "M28",
    shown: "Report check result",
    source: "report.checked",
  },
  {
    id: "M29",
    shown: "Artifact size and hash",
    source: "artifact.ready",
  },
  {
    id: "M30",
    shown: "Kiro CLI version, agents, verified models, session IDs",
    source:
      "run.started, skeleton.raised; the version comes from a recorded kiro-cli --version result",
  },
  {
    id: "M31",
    shown: "History counts",
    source: "Count over stored runs",
  },
] as const;

/** Every metric id in registry order. */
export const METRIC_IDS: readonly MetricId[] = METRIC_REGISTRY.map((row) => row.id);

const REGISTRY_BY_ID: Readonly<Record<MetricId, MetricDefinition>> =
  Object.fromEntries(METRIC_REGISTRY.map((row) => [row.id, row])) as Record<
    MetricId,
    MetricDefinition
  >;

/** Look up a registry row by id. Throws only on an id outside M1–M31. */
export function getMetric(id: MetricId): MetricDefinition {
  const row = REGISTRY_BY_ID[id];
  if (!row) {
    throw new RangeError(`Unknown metric id: ${String(id)}`);
  }
  return row;
}