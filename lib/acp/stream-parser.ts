// Task 20.2: stream-json parser and disk stream logger for the Headless Fallback channel
// Requirements: 17.2, 17.3, 17.4, 17.5, 17.9, 17.12, 45.15, 45.18
//
// The Headless Fallback runs `kiro-cli chat --v3 --no-interactive --output-format
// stream-json`. Each stdout line is one JSON object (NDJSON). This module parses
// those records defensively, maps the documented exit codes, and verifies the
// active model reported by the stream (probe P14).

import * as fs from "node:fs";
import * as path from "node:path";
import { isAllowedModelId, isAutoModel } from "../agents/model-allowlist";
import { redactText, type RedactionOptions } from "../security/redactor";

/**
 * One parsed line of the `--output-format stream-json` stdout stream.
 * Records that carry no `type` field are still returned; the parser never
 * throws for a well-formed JSON object.
 */
export interface StreamJsonRecord {
  type: string;
  [key: string]: unknown;
}

/** Status values produced by mapping the headless process exit code. */
export type HeadlessExitStatus =
  | "success"
  | "failure"
  | "gateway_missing"
  | "missing_agent";

export interface HeadlessExitMapping {
  ok: boolean;
  status: HeadlessExitStatus;
  discardOutput: boolean;
}

export interface HeadlessModelVerification {
  ok: boolean;
  activeModel: string | null;
  reason?: "model_mismatch";
}

export interface HeadlessModelVerificationOptions {
  /**
   * Explicit test flag: when Probe P14 could not confirm the stream reports the
   * active model, the caller may disable the model check for a fixture run. This
   * never widens the production allowlist; it only skips the assertion.
   */
  modelCheckDisabled?: boolean;
}

export interface HeadlessCredits {
  creditsReported: boolean;
  credits: number | null;
}

export interface HeadlessApprovalRequest {
  approvalId: string | null;
  toolCallId: string | null;
  command: string | null;
  expiresAt: string | null;
  raw: StreamJsonRecord;
}

export interface HeadlessAskRequest {
  askId: string | null;
  toolCallId: string | null;
  text: string | null;
  raw: StreamJsonRecord;
}

// ---------------------------------------------------------------------------
// Exit code mapping (Requirement 17.8, 17.9)
// ---------------------------------------------------------------------------

/**
 * Maps the headless `kiro-cli chat` exit code to its documented meaning.
 * 0 success, 1 (or any other non-zero) failure, 3 gateway_missing,
 * 4 missing_agent (whose output MUST be discarded).
 */
export function mapHeadlessExitCode(
  code: number | null | undefined
): HeadlessExitMapping {
  if (code === 0) {
    return { ok: true, status: "success", discardOutput: false };
  }
  if (code === 3) {
    return { ok: false, status: "gateway_missing", discardOutput: false };
  }
  if (code === 4) {
    return { ok: false, status: "missing_agent", discardOutput: true };
  }
  return { ok: false, status: "failure", discardOutput: false };
}

// ---------------------------------------------------------------------------
// NDJSON parsing (Requirement 17.12)
// ---------------------------------------------------------------------------

function inferRecordType(rec: Record<string, unknown>): string {
  if (typeof rec.type === "string" && rec.type.trim().length > 0) {
    return rec.type.trim();
  }
  return "unknown";
}

/**
 * Safely parses one NDJSON line. Blank lines return null. Malformed lines return
 * a `parse_warning` record carrying the raw text so a caller can persist it
 * without crashing the turn.
 */
export function parseStreamJsonLine(line: string): StreamJsonRecord | null {
  if (typeof line !== "string") {
    return null;
  }
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      return { ...rec, type: inferRecordType(rec) } as StreamJsonRecord;
    }
    if (Array.isArray(parsed)) {
      return { type: "array", items: parsed };
    }
    return { type: "value", value: parsed };
  } catch {
    return { type: "parse_warning", raw: line };
  }
}

// ---------------------------------------------------------------------------
// Active model extraction & verification (probe P14)
// ---------------------------------------------------------------------------

const MODEL_FIELD_PATHS: ReadonlyArray<readonly string[]> = [
  ["model"],
  ["activeModel"],
  ["active_model"],
  ["modelId"],
  ["model_id"],
  ["session", "model"],
  ["session", "modelId"],
  ["session", "activeModel"],
  ["metadata", "model"],
  ["metadata", "modelId"],
  ["data", "model"],
  ["data", "modelId"],
];

function readStringPath(rec: unknown, segments: readonly string[]): string | null {
  let cur: unknown = rec;
  for (const key of segments) {
    if (cur === null || typeof cur !== "object") {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "string" && cur.trim().length > 0) {
    return cur.trim();
  }
  if (cur !== null && typeof cur === "object") {
    const obj = cur as Record<string, unknown>;
    const id = obj.id ?? obj.value ?? obj.name ?? obj.currentValue ?? obj.selectedValue;
    if (typeof id === "string" && id.trim().length > 0) {
      return id.trim();
    }
  }
  return null;
}

/**
 * Returns the first active model reported anywhere in the stream, checking the
 * model fields recorded by Probe P14 (`model`, `activeModel`, `modelId`,
 * `session.model`, `metadata.model`). Returns null when the stream never reports
 * one.
 */
export function extractHeadlessActiveModel(
  records: readonly StreamJsonRecord[]
): string | null {
  if (!Array.isArray(records)) {
    return null;
  }
  for (const rec of records) {
    if (rec === null || typeof rec !== "object") {
      continue;
    }
    for (const segments of MODEL_FIELD_PATHS) {
      const found = readStringPath(rec, segments);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Verifies that the stream reported the expected, allowlisted active model.
 * Auto, a missing model, or a model outside the allowlist or different from the
 * expected model fails with reason `model_mismatch` (Requirement 17.10, 45.18).
 */
export function verifyHeadlessModel(
  records: readonly StreamJsonRecord[],
  expectedModelId: string,
  options?: HeadlessModelVerificationOptions
): HeadlessModelVerification {
  const activeModel = extractHeadlessActiveModel(records);
  if (options?.modelCheckDisabled === true) {
    return { ok: true, activeModel };
  }
  if (activeModel === null) {
    return { ok: false, activeModel: null, reason: "model_mismatch" };
  }
  if (isAutoModel(activeModel)) {
    return { ok: false, activeModel, reason: "model_mismatch" };
  }
  if (!isAllowedModelId(activeModel)) {
    return { ok: false, activeModel, reason: "model_mismatch" };
  }
  if (activeModel !== expectedModelId) {
    return { ok: false, activeModel, reason: "model_mismatch" };
  }
  return { ok: true, activeModel };
}

// ---------------------------------------------------------------------------
// Credit extraction (probe P5 / spike S1)
// ---------------------------------------------------------------------------

function collectPromptTurnSummaries(
  value: unknown,
  out: Record<string, unknown>[],
  depth = 0
): void {
  if (depth > 6 || value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPromptTurnSummaries(item, out, depth + 1);
    }
    return;
  }
  const rec = value as Record<string, unknown>;
  if (Array.isArray(rec.promptTurnSummaries)) {
    for (const item of rec.promptTurnSummaries) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        out.push(item as Record<string, unknown>);
      }
    }
  }
  for (const key of Object.keys(rec)) {
    collectPromptTurnSummaries(rec[key], out, depth + 1);
  }
}

function pickNumeric(
  rec: Record<string, unknown>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === "string" && val.trim() !== "" && Number.isFinite(Number(val))) {
      return Number(val);
    }
  }
  return null;
}

/**
 * Extracts the credits reported by `turn_completion` / `promptTurnSummaries`
 * entries whose `unit === "credit"` (Probe P5 / spike S1). When the stream never
 * reports a credit field the result is `{ creditsReported: false, credits: null }`;
 * credits are never estimated (design M22).
 */
export function extractHeadlessCredits(
  records: readonly StreamJsonRecord[]
): HeadlessCredits {
  if (!Array.isArray(records)) {
    return { creditsReported: false, credits: null };
  }
  let total = 0;
  let found = false;
  for (const rec of records) {
    if (rec === null || typeof rec !== "object") {
      continue;
    }
    const summaries: Record<string, unknown>[] = [];
    collectPromptTurnSummaries(rec, summaries);
    let creditFromSummaries = false;
    for (const summary of summaries) {
      const unit =
        typeof summary.unit === "string" ? summary.unit.trim().toLowerCase() : "";
      if (unit !== "credit" && unit !== "credits") {
        continue;
      }
      // Spike S1 / Probe P5 records `{ unit: "credit", usage: 0.06 }` entries, so
      // `usage` must be read alongside the other numeric credit fields.
      const value = pickNumeric(summary, [
        "usage",
        "credits",
        "credit",
        "value",
        "amount",
        "count",
        "total",
        "used",
      ]);
      if (value !== null) {
        total += value;
        found = true;
        creditFromSummaries = true;
      }
    }
    const type = typeof rec.type === "string" ? rec.type.toLowerCase() : "";
    if (type === "turn_completion" || type === "turn-completion") {
      // Guard against double-counting when the same record carries both a credit
      // summary entry and a top-level credit field.
      if (!creditFromSummaries) {
        const direct = pickNumeric(rec, ["credits", "credit"]);
        if (direct !== null) {
          total += direct;
          found = true;
        }
      }
    }
  }
  return found
    ? { creditsReported: true, credits: total }
    : { creditsReported: false, credits: null };
}

// ---------------------------------------------------------------------------
// Approval, ask and session extraction
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function looksLikeApprovalRequest(rec: Record<string, unknown>): boolean {
  const type = typeof rec.type === "string" ? rec.type.toLowerCase() : "";
  if (type.includes("resolved") || type.includes("decision")) {
    return false;
  }
  const hints = [
    "approval_request",
    "approval.requested",
    "approval_pending",
    "needs_approval",
    "approval",
  ];
  if (hints.some((hint) => type.includes(hint))) {
    return true;
  }
  const status = typeof rec.status === "string" ? rec.status.toLowerCase() : "";
  if (status === "approval_pending") {
    return true;
  }
  if (
    (rec.approvalId ?? rec.approval_id) !== undefined &&
    (rec.needsApproval === true || rec.requiresApproval === true)
  ) {
    return true;
  }
  return false;
}

/**
 * Returns every approval request in the stream. Each request carries the
 * approval ID the gateway returned for the refused `needs_approval` command
 * (Requirement 17.5).
 */
export function extractApprovalRequests(
  records: readonly StreamJsonRecord[]
): HeadlessApprovalRequest[] {
  if (!Array.isArray(records)) {
    return [];
  }
  const out: HeadlessApprovalRequest[] = [];
  for (const rec of records) {
    if (rec === null || typeof rec !== "object") {
      continue;
    }
    if (!looksLikeApprovalRequest(rec)) {
      continue;
    }
    out.push({
      approvalId: asString(rec.approvalId ?? rec.approval_id ?? rec.id),
      toolCallId: asString(rec.toolCallId ?? rec.tool_call_id),
      command: asString(rec.command ?? rec.argv ?? rec.cmd),
      expiresAt: asString(rec.expiresAt ?? rec.expires_at),
      raw: rec,
    });
  }
  return out;
}

function looksLikeAskRequest(rec: Record<string, unknown>): boolean {
  const type = typeof rec.type === "string" ? rec.type.toLowerCase() : "";
  if (
    type.includes("ask_request") ||
    type.includes("ask.requested") ||
    type.includes("ask_needed")
  ) {
    return true;
  }
  const candidates = [rec.tool, rec.toolName, rec.name, rec.method];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const norm = candidate.trim().toLowerCase();
    if (
      norm === "ask" ||
      norm.endsWith("/ask") ||
      norm.endsWith(".ask") ||
      norm.endsWith(":ask")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns every `ask` request emitted while the Headless Fallback is active.
 * These are auto-denied by the channel and never block forever (Requirement 17.11).
 */
export function extractAskRequests(
  records: readonly StreamJsonRecord[]
): HeadlessAskRequest[] {
  if (!Array.isArray(records)) {
    return [];
  }
  const out: HeadlessAskRequest[] = [];
  for (const rec of records) {
    if (rec === null || typeof rec !== "object") {
      continue;
    }
    if (!looksLikeAskRequest(rec)) {
      continue;
    }
    out.push({
      askId: asString(rec.askId ?? rec.ask_id ?? rec.id),
      toolCallId: asString(rec.toolCallId ?? rec.tool_call_id),
      text: asString(rec.text ?? rec.question ?? rec.prompt ?? rec.message),
      raw: rec,
    });
  }
  return out;
}

const SESSION_ID_PATHS: ReadonlyArray<readonly string[]> = [
  ["sessionId"],
  ["session_id"],
  ["session", "id"],
  ["session", "sessionId"],
  ["data", "sessionId"],
  ["metadata", "sessionId"],
];

/**
 * Returns the session ID reported by the stream, used to resume a turn with
 * `--resume-id` (Requirement 17.3, 17.6).
 */
export function extractSessionId(
  records: readonly StreamJsonRecord[]
): string | null {
  if (!Array.isArray(records)) {
    return null;
  }
  for (const rec of records) {
    if (rec === null || typeof rec !== "object") {
      continue;
    }
    for (const segments of SESSION_ID_PATHS) {
      const found = readStringPath(rec, segments);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Disk stream logger (Requirement 17.4)
// ---------------------------------------------------------------------------

export interface StreamDiskLoggerOptions {
  /**
   * Redact sensitive values before they reach disk. Defaults to true so raw
   * stdout never persists a secret.
   */
  redact?: boolean;
  redactionMask?: string;
  redactionOptions?: RedactionOptions;
  /**
   * Explicit secret literals that must be redacted even when they do not match a
   * generic token pattern (for example the Skeleton's `KIRO_API_KEY`, which is an
   * arbitrary value). Merged with any `redactionOptions.secrets`.
   */
  secrets?: readonly string[];
  /**
   * Trusted base directory the log path must stay strictly inside.
   * When set, `createStreamDiskLogger` refuses a symlink at the log path or at any
   * intermediate component between this base and the log path, and asserts the
   * resolved parent directory stays within the base's realpath. Nothing outside
   * the boundary is ever opened or written. `baseDir` is accepted as an alias.
   */
  trustedBaseDir?: string;
  baseDir?: string;
}

export interface StreamDiskLogger {
  readonly logFilePath: string;
  appendLine(line: string): void;
  append(text: string): void;
  close(): void;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly lastError: Error | null;
  /** True when every write to disk has succeeded so far. */
  readonly ok: boolean;
  /** Returns the first/last disk write failure, or null when logging succeeded. */
  getLastError(): Error | null;
}

/** True when the path exists and is itself a symlink (never follows the link). */
function isSymlinkPath(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when target is inside base or equal to it (lexical, after resolving).
 * Only a genuine parent escape is rejected: the relative path is exactly "..",
 * starts with "../" (or "..\\"), or is absolute. A sibling directory whose name
 * merely begins with two dots (for example `<base>/..diagnostics/stream.jsonl`)
 * is NOT an escape and stays inside the base.
 */
function isInsideDir(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  if (rel === "") {
    return true;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Realpath of the deepest existing ancestor of `target`, with the non-existent
 * tail rejoined, so a not-yet-created log directory still yields a real absolute
 * path that can be compared against a trusted base.
 */
function realpathOfExistingPrefix(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(current);
  } catch {
    real = current;
  }
  return tail.length > 0 ? path.join(real, ...tail) : real;
}

/**
 * Writes the raw stdout stream to disk before it is parsed (Requirement 17.4).
 * Values are redacted by default so a token in the stream never lands on disk.
 */
export function createStreamDiskLogger(
  logFilePath: string,
  options?: StreamDiskLoggerOptions
): StreamDiskLogger {
  const redact = options?.redact ?? true;
  let fd: number | null = null;
  let closed = false;
  let lineCount = 0;
  let byteCount = 0;
  let lastError: Error | null = null;

  const ensureOpen = (): void => {
    if (fd !== null) {
      return;
    }
    const dir = path.dirname(logFilePath);
    const trustedBase = options?.trustedBaseDir ?? options?.baseDir;

    // Finding [5]: refuse a symlink at the log file itself. `openSync` follows
    // symlinks, so this check must happen BEFORE anything is opened.
    if (isSymlinkPath(logFilePath)) {
      throw new Error(
        `refusing to write the headless stream log through the symlink at ${logFilePath}`
      );
    }

    if (trustedBase && trustedBase.length > 0) {
      const base = path.resolve(trustedBase);
      const target = path.resolve(logFilePath);
      if (!isInsideDir(base, target)) {
        throw new Error(
          `headless stream log path ${target} is outside the trusted base ${base}`
        );
      }
      // Refuse a symlink at the base or at any intermediate component between the
      // base and the log file, so a symlinked `.kiro`/worktree subdir cannot
      // redirect the write outside the boundary.
      let current = base;
      if (isSymlinkPath(current)) {
        throw new Error(`refusing a symlinked trusted base ${current}`);
      }
      const rel = path.relative(base, dir);
      for (const segment of rel.split(path.sep).filter((s) => s.length > 0)) {
        current = path.join(current, segment);
        if (isSymlinkPath(current)) {
          throw new Error(
            `refusing to write the headless stream log through the symlink at ${current}`
          );
        }
      }
      fs.mkdirSync(dir, { recursive: true });
      // Containment: the RESOLVED parent directory must stay strictly within the
      // RESOLVED trusted base (a symlink swapped in after the checks is caught).
      const realBase = realpathOfExistingPrefix(base);
      const realDir = fs.realpathSync(dir);
      if (!isInsideDir(realBase, realDir)) {
        throw new Error(
          `headless stream log directory ${realDir} escapes the trusted base ${realBase}`
        );
      }
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }

    fd = fs.openSync(logFilePath, "a");
    // Guard the open-to-use window: if the path became a symlink between the
    // check above and `openSync`, close immediately instead of writing through it.
    if (isSymlinkPath(logFilePath)) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
      fd = null;
      throw new Error(
        `refusing to write the headless stream log through the symlink at ${logFilePath}`
      );
    }
  };

  const write = (text: string): void => {
    if (closed) {
      return;
    }
    try {
      let out = text;
      if (redact) {
        const baseOptions: RedactionOptions =
          options?.redactionOptions ??
          (options?.redactionMask
            ? { redactionMask: options.redactionMask }
            : {});
        const explicitSecrets = (options?.secrets ?? []).filter(
          (secret): secret is string =>
            typeof secret === "string" && secret.length > 0
        );
        const redactionOptions: RedactionOptions =
          explicitSecrets.length > 0
            ? {
                ...baseOptions,
                secrets: [...(baseOptions.secrets ?? []), ...explicitSecrets],
              }
            : baseOptions;
        out = redactText(text, redactionOptions);
      }
      ensureOpen();
      if (fd !== null) {
        fs.writeSync(fd, out);
        byteCount += Buffer.byteLength(out);
      }
    } catch (err) {
      lastError = err as Error;
    }
  };

  return {
    logFilePath,
    appendLine(line: string): void {
      lineCount += 1;
      write(`${line ?? ""}\n`);
    },
    append(text: string): void {
      write(text ?? "");
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close failures.
        }
        fd = null;
      }
    },
    get lineCount(): number {
      return lineCount;
    },
    get byteCount(): number {
      return byteCount;
    },
    get lastError(): Error | null {
      return lastError;
    },
    get ok(): boolean {
      return lastError === null;
    },
    getLastError(): Error | null {
      return lastError;
    },
  };
}
