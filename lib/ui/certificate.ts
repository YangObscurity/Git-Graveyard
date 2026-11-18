// Assemble the Death Certificate the UI shows from what the run's event log
// recorded: the exhume.certificate event (base sha, healthy flag, failure
// classes, digest) and the command.result rows of the baseline.
//
// The certificate event does not carry the rows, so they come from the
// commands. A step with no recorded command is shown as "not run"; nothing is
// assumed to have passed.

import type {
  BaselineCommandRow,
  BaselineStepStatus,
  DeathCertificate,
  StepName,
} from "@/lib/exhume/death-certificate";
import type { RunCommand, RunView } from "./run-model";

const STEP_NAMES: readonly StepName[] = ["version", "install", "retry", "build", "test"];

function asStep(step: string | undefined): StepName | null {
  return step && (STEP_NAMES as readonly string[]).includes(step)
    ? (step as StepName)
    : null;
}

function toRow(command: RunCommand, step: StepName): BaselineCommandRow {
  return {
    step,
    command: command.command,
    status: command.status as BaselineStepStatus,
    exitCode: command.exitCode ?? null,
    durationMs: command.durationMs,
    logRef: command.logRef,
    reason: command.reason,
    ruleId: command.ruleId,
    errorExcerpt: command.errorExcerpt,
    timedOut: command.timedOut,
    oomKilled: command.oomKilled,
  };
}

function notRun(step: StepName): BaselineCommandRow {
  return { step, command: "not recorded", status: "not run" };
}

export function certificateFromRun(
  view: RunView,
  runId: string
): DeathCertificate | null {
  const meta = view.certificate;
  if (!meta) return null;

  const rows: BaselineCommandRow[] = [];
  for (const command of view.commands) {
    if (command.status === "running") continue;
    const step = asStep(command.step);
    if (step) rows.push(toRow(command, step));
  }

  const last = (step: StepName) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].step === step) return rows[i];
    }
    return undefined;
  };
  const retry = last("retry");

  return {
    schemaVersion: "v1",
    baseSha: meta.baseSha ?? "",
    runId,
    primaryLanguage: "unknown",
    packageManager: "unknown",
    createdAt: meta.recordedAt ? new Date(meta.recordedAt).toISOString() : "",
    healthy: meta.healthy,
    rows,
    runtimes: rows.filter((r) => r.step === "version"),
    install: last("install") ?? notRun("install"),
    ...(retry ? { retry } : {}),
    build: last("build") ?? notRun("build"),
    test: last("test") ?? notRun("test"),
    failureClasses: meta.failureClasses,
    failures: [],
    sha256: meta.sha256 ?? "",
  };
}
