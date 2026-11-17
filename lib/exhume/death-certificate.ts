/**
 * Death Certificate data structure, failure classification, and persistence.
 * Requirements: 11.5, 11.8, 11.9, 11.10, 11.13, 11.14, 11.15.
 * Task: 8.3, 8.4.
 *
 * Stores the baseline result of install, build, and test on the base sha
 * with deterministic failure classification.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  NO_TESTS_FOUND_LABEL,
  NO_TESTS_FOUND_RULE_ID,
  type NoTestsFoundLabel,
  type NoTestsFoundRuleId,
  type PackageManager,
  type SupportedLanguage,
} from "./types";

export type StepName = "version" | "install" | "retry" | "build" | "test";

export type BaselineStepStatus =
  | "passed"
  | "failed"
  | "not run"
  | NoTestsFoundLabel;

export interface BaselineCommandRow {
  readonly step: StepName;
  readonly command: string;
  readonly status: BaselineStepStatus;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly logRef?: string;
  readonly reason?: string;
  readonly ruleId?: NoTestsFoundRuleId | string;
  readonly errorExcerpt?: string;
  readonly timedOut?: boolean;
  readonly oomKilled?: boolean;
  readonly noTestsFound?: boolean;
}

export interface FailureClassification {
  readonly class: string;
  readonly step: StepName | "general";
  readonly message: string;
  readonly excerpt?: string;
  readonly ref?: string;
  readonly ruleId?: string;
}

export interface DeathCertificate {
  readonly schemaVersion: "v1";
  readonly baseSha: string;
  readonly runId?: string;
  readonly repoUrl?: string;
  readonly primaryLanguage: SupportedLanguage | "unknown";
  readonly packageManager: PackageManager;
  readonly createdAt: string;
  readonly healthy: boolean;
  readonly rows: readonly BaselineCommandRow[];
  readonly runtimes: readonly BaselineCommandRow[];
  readonly install: BaselineCommandRow;
  readonly retry?: BaselineCommandRow;
  readonly build: BaselineCommandRow;
  readonly test: BaselineCommandRow;
  readonly failureClasses: readonly string[];
  readonly failures: readonly FailureClassification[];
  readonly sha256: string;
  readonly summary?: string;
}

export interface CreateDeathCertificateParams {
  baseSha: string;
  runId?: string;
  repoUrl?: string;
  primaryLanguage?: SupportedLanguage | "unknown";
  packageManager?: PackageManager;
  createdAt?: string;
  rows?: readonly BaselineCommandRow[];
  runtimes?: readonly BaselineCommandRow[];
  install: BaselineCommandRow;
  retry?: BaselineCommandRow;
  build: BaselineCommandRow;
  test: BaselineCommandRow;
  failureClasses?: readonly string[];
  failures?: readonly FailureClassification[];
  summary?: string;
}

/**
 * Extracts a concise failure excerpt (first 5 lines or first 500 characters)
 * from stdout or stderr text.
 */
export function extractFailureExcerpt(
  text: string | null | undefined,
  maxLines = 5,
  maxChars = 500
): string {
  if (!text || typeof text !== "string") {
    return "";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split("\n");
  const selected = lines.slice(0, maxLines).join("\n");
  if (selected.length > maxChars) {
    return selected.slice(0, maxChars) + "...";
  }
  return selected;
}

/**
 * Deterministically classifies command execution failures without model calls.
 * Scans exit codes, timeouts, oom statuses, and standard failure signatures.
 */
export function classifyFailures(
  rows: readonly BaselineCommandRow[]
): {
  failureClasses: string[];
  failures: FailureClassification[];
} {
  const failureClassesSet = new Set<string>();
  const failures: FailureClassification[] = [];

  for (const row of rows) {
    const errorText = `${row.reason ?? ""}\n${row.errorExcerpt ?? ""}`;

    if (row.timedOut || row.reason === "time limit") {
      failureClassesSet.add("time_limit");
      failures.push({
        class: "time_limit",
        step: row.step,
        message: `Command timed out: ${row.command}`,
        excerpt: row.errorExcerpt,
        ref: row.logRef ? `cmd:${row.logRef}` : undefined,
      });
    }

    if (row.oomKilled) {
      failureClassesSet.add("oom_killed");
      failures.push({
        class: "oom_killed",
        step: row.step,
        message: `Out of memory: ${row.command}`,
        excerpt: row.errorExcerpt,
        ref: row.logRef ? `cmd:${row.logRef}` : undefined,
      });
    }

    if (
      row.step === "test" &&
      (row.noTestsFound ||
        row.status === NO_TESTS_FOUND_LABEL ||
        row.ruleId === NO_TESTS_FOUND_RULE_ID)
    ) {
      failureClassesSet.add("no_tests");
      failures.push({
        class: "no_tests",
        step: "test",
        message: row.reason || "No tests found",
        ruleId: NO_TESTS_FOUND_RULE_ID,
        ref: row.logRef ? `cmd:${row.logRef}` : undefined,
      });
    }

    if (row.status === "failed") {
      if (row.step === "install") {
        failureClassesSet.add("install_failed");
        failures.push({
          class: "install_failed",
          step: "install",
          message: `Install failed with exit code ${row.exitCode ?? "non-zero"}: ${row.command}`,
          excerpt: row.errorExcerpt,
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      } else if (row.step === "retry") {
        failureClassesSet.add("install_retry_failed");
        failures.push({
          class: "install_retry_failed",
          step: "retry",
          message: `Install retry failed with exit code ${row.exitCode ?? "non-zero"}: ${row.command}`,
          excerpt: row.errorExcerpt,
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      } else if (row.step === "build") {
        failureClassesSet.add("build_failed");
        failures.push({
          class: "build_failed",
          step: "build",
          message: `Build failed with exit code ${row.exitCode ?? "non-zero"}: ${row.command}`,
          excerpt: row.errorExcerpt,
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      } else if (row.step === "test") {
        failureClassesSet.add("test_failed");
        failures.push({
          class: "test_failed",
          step: "test",
          message: `Test failed with exit code ${row.exitCode ?? "non-zero"}: ${row.command}`,
          excerpt: row.errorExcerpt,
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      // Pattern-based error classification across stdout/stderr excerpts
      if (
        /syntaxerror/i.test(errorText) ||
        /invalid syntax/i.test(errorText) ||
        /unexpected token/i.test(errorText)
      ) {
        failureClassesSet.add("syntax_error");
        failures.push({
          class: "syntax_error",
          step: row.step,
          message: "Syntax error detected in codebase or build",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      if (
        /cannot find module/i.test(errorText) ||
        /modulenotfounderror/i.test(errorText) ||
        /no module named/i.test(errorText) ||
        /importerror/i.test(errorText) ||
        /err_module_not_found/i.test(errorText)
      ) {
        failureClassesSet.add("missing_dependency");
        failures.push({
          class: "missing_dependency",
          step: row.step,
          message: "Missing module or unresolved dependency",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      if (
        /eresolve/i.test(errorText) ||
        /conflicting peer dependency/i.test(errorText) ||
        /peer dep/i.test(errorText)
      ) {
        failureClassesSet.add("peer_dependency_conflict");
        failures.push({
          class: "peer_dependency_conflict",
          step: row.step,
          message: "Peer dependency conflict during package installation",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      if (
        /unsupported engine/i.test(errorText) ||
        /requires node/i.test(errorText) ||
        /requires python/i.test(errorText) ||
        /incompatible with this engine/i.test(errorText)
      ) {
        failureClassesSet.add("version_incompatible");
        failures.push({
          class: "version_incompatible",
          step: row.step,
          message: "Runtime version incompatible with package engine requirements",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      if (/typeerror/i.test(errorText) || /TS\d{4}:/i.test(errorText)) {
        failureClassesSet.add("type_error");
        failures.push({
          class: "type_error",
          step: row.step,
          message: "Type error detected during build or execution",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      if (
        /assertionerror/i.test(errorText) ||
        /assert\s+/i.test(errorText) ||
        /failed asserts/i.test(errorText)
      ) {
        failureClassesSet.add("assertion_error");
        failures.push({
          class: "assertion_error",
          step: row.step,
          message: "Assertion failure in test suite",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      if (
        /eacces/i.test(errorText) ||
        /permission denied/i.test(errorText)
      ) {
        failureClassesSet.add("permission_denied");
        failures.push({
          class: "permission_denied",
          step: row.step,
          message: "Permission denied during command execution",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }

      if (
        /etimedout/i.test(errorText) ||
        /enotfound/i.test(errorText) ||
        /getaddrinfo/i.test(errorText)
      ) {
        failureClassesSet.add("network_timeout");
        failures.push({
          class: "network_timeout",
          step: row.step,
          message: "Network unreachable or address lookup failure",
          excerpt: extractFailureExcerpt(errorText),
          ref: row.logRef ? `cmd:${row.logRef}` : undefined,
        });
      }
    }
  }

  return {
    failureClasses: Array.from(failureClassesSet),
    failures,
  };
}

/**
 * Computes deterministic SHA-256 hex hash of any object or string.
 */
export function computeDeathCertificateSha256(
  certOrObj: unknown
): string {
  let content: string;
  if (typeof certOrObj === "string") {
    content = certOrObj;
  } else if (certOrObj && typeof certOrObj === "object") {
    // If object has sha256 property, omit it when hashing
    const copy = { ...(certOrObj as Record<string, unknown>) };
    delete copy.sha256;
    content = JSON.stringify(copy, Object.keys(copy).sort(), 2);
  } else {
    content = String(certOrObj);
  }
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Checks if the repository baseline is healthy.
 * Requirement 11.15: WHEN install, build and tests all pass,
 * Necromancer may end run with outcome healthy_already.
 */
export function isRepositoryHealthy(
  install: BaselineCommandRow,
  build: BaselineCommandRow,
  test: BaselineCommandRow
): boolean {
  const installOk = install.status === "passed";
  const buildOk =
    build.status === "passed" ||
    (build.status === "not run" && build.reason === "no build script");
  const testOk = test.status === "passed";

  return installOk && buildOk && testOk;
}

/**
 * Constructs a DeathCertificate from execution rows and metadata.
 */
export function createDeathCertificate(
  params: CreateDeathCertificateParams
): DeathCertificate {
  const runtimes = params.runtimes ?? [];
  const allRows: BaselineCommandRow[] = params.rows
    ? [...params.rows]
    : [
        ...runtimes,
        params.install,
        ...(params.retry ? [params.retry] : []),
        params.build,
        params.test,
      ];

  const classified =
    params.failureClasses && params.failures
      ? {
          failureClasses: [...params.failureClasses],
          failures: [...params.failures],
        }
      : classifyFailures(allRows);

  const healthy = isRepositoryHealthy(
    params.install,
    params.build,
    params.test
  );

  const createdAt = params.createdAt ?? new Date().toISOString();

  const preliminary = {
    schemaVersion: "v1" as const,
    baseSha: params.baseSha,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.repoUrl ? { repoUrl: params.repoUrl } : {}),
    primaryLanguage: params.primaryLanguage ?? "unknown",
    packageManager: params.packageManager ?? "unknown",
    createdAt,
    healthy,
    rows: allRows,
    runtimes,
    install: params.install,
    ...(params.retry ? { retry: params.retry } : {}),
    build: params.build,
    test: params.test,
    failureClasses: classified.failureClasses,
    failures: classified.failures,
    ...(params.summary ? { summary: params.summary } : {}),
  };

  const sha256 = computeDeathCertificateSha256(preliminary);

  return {
    ...preliminary,
    sha256,
  };
}

/**
 * Serializes a DeathCertificate to formatted JSON.
 */
export function serializeDeathCertificate(cert: DeathCertificate): string {
  return JSON.stringify(cert, null, 2);
}

/**
 * Deserializes JSON string into a DeathCertificate.
 */
export function deserializeDeathCertificate(jsonStr: string): DeathCertificate {
  const parsed = JSON.parse(jsonStr) as DeathCertificate;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid DeathCertificate JSON: expected object");
  }
  if (parsed.schemaVersion !== "v1") {
    throw new Error(
      `Unsupported DeathCertificate schemaVersion: '${parsed.schemaVersion}'`
    );
  }
  if (!parsed.baseSha) {
    throw new Error("Invalid DeathCertificate: missing baseSha");
  }
  return parsed;
}

/**
 * Formats baseline command rows into an ASCII / Markdown table.
 * Used for Tombstone and Reliquary displays.
 */
export function formatDeathCertificateTable(
  cert: DeathCertificate
): string {
  const headers = ["Step", "Command", "Status", "Exit Code", "Reason / Notes"];
  const rowsData: string[][] = [];

  for (const r of cert.rows) {
    const exitStr =
      r.exitCode !== undefined && r.exitCode !== null
        ? String(r.exitCode)
        : "-";
    const note = r.ruleId
      ? `Rule: ${r.ruleId}${r.reason ? ` (${r.reason})` : ""}`
      : r.reason ?? "-";
    rowsData.push([r.step, r.command, r.status, exitStr, note]);
  }

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rowsData.map((row) => (row[i] ?? "").length))
  );

  const headerLine =
    "| " +
    headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ") +
    " |";
  const separatorLine =
    "|-" +
    colWidths.map((w) => "-".repeat(w)).join("-|-") +
    "-|";
  const bodyLines = rowsData.map(
    (row) =>
      "| " +
      row.map((cell, i) => cell.padEnd(colWidths[i])).join(" | ") +
      " |"
  );

  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

/**
 * Saves a DeathCertificate to disk under targetPath or targetDir/death-certificate.json.
 */
export async function saveDeathCertificate(
  cert: DeathCertificate,
  targetPathOrDir: string
): Promise<string> {
  let filePath = targetPathOrDir;
  if (
    !targetPathOrDir.endsWith(".json") ||
    fs.existsSync(targetPathOrDir) &&
      fs.statSync(targetPathOrDir).isDirectory()
  ) {
    filePath = path.join(targetPathOrDir, "death-certificate.json");
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const serialized = serializeDeathCertificate(cert);
  await fs.promises.writeFile(filePath, serialized, "utf8");
  return filePath;
}

/**
 * Loads a DeathCertificate from disk under targetPath or targetDir/death-certificate.json.
 */
export async function loadDeathCertificate(
  targetPathOrDir: string
): Promise<DeathCertificate> {
  let filePath = targetPathOrDir;
  if (
    !targetPathOrDir.endsWith(".json") ||
    fs.existsSync(targetPathOrDir) &&
      fs.statSync(targetPathOrDir).isDirectory()
  ) {
    filePath = path.join(targetPathOrDir, "death-certificate.json");
  }

  const raw = await fs.promises.readFile(filePath, "utf8");
  return deserializeDeathCertificate(raw);
}
