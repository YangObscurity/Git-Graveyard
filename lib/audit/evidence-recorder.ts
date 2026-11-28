// WP-29 Task 29.2: Audit evidence recorder.
//
// Writes audit evidence under `<baseDir>/01_evidence/audit-<date>/` with strictly one
// file per item ID. Item IDs are sanitized against path traversal, the resolved target
// is always re-checked to stay inside the audit directory (never overwriting outside
// it), and any accidental secret-like value is redacted before it reaches disk.

import * as fs from "node:fs";
import * as path from "node:path";
import { redactText, scanTextForSecrets } from "../security/redactor";

/** Characters permitted in a sanitized evidence item id / date segment. */
const SAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

export interface EvidenceRecordOptions {
  /** Workspace root; evidence is written beneath `<baseDir>/01_evidence/`. */
  baseDir: string;
  /** ISO date (YYYY-MM-DD) used for the `audit-<date>` directory. */
  date: string;
  /** The audit item id (e.g. `CR`, `XR-01`); one file is written per id. */
  itemId: string;
  /** String or JSON-serialisable content recorded for the item. */
  content: unknown;
  /** Optional actor recorded alongside the evidence. */
  actor?: string;
  /** Optional phase (`G1` / `G3`) recorded alongside the evidence. */
  phase?: string;
}

export interface EvidenceRecordResult {
  itemId: string;
  /** Absolute path of the written file. */
  path: string;
  filename: string;
  /** True when at least one secret-like value was redacted. */
  redacted: boolean;
  /** True when the raw content tripped the secret scanner. */
  hadSecrets: boolean;
}

export interface RedactedEvidenceContent {
  text: string;
  redacted: boolean;
  hadSecrets: boolean;
}

/**
 * Sanitizes an item id into a single safe path segment. Throws on any traversal attempt
 * (`/`, `\`, `..`, NUL) so a caller can never escape the audit directory.
 */
export function sanitizeEvidenceSegment(raw: string, label = "id"): string {
  if (typeof raw !== "string") {
    throw new TypeError(`Evidence ${label} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`Evidence ${label} must be a non-empty string`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(`Evidence ${label} must not contain path separators: ${trimmed}`);
  }
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw new Error(`Evidence ${label} must not contain traversal segments: ${trimmed}`);
  }
  const safe = trimmed.replace(SAFE_SEGMENT, "_");
  if (safe.length === 0 || safe === "." || safe === "..") {
    throw new Error(`Evidence ${label} sanitizes to an empty segment: ${trimmed}`);
  }
  return safe;
}

/** Backwards-friendly alias: sanitize an evidence item id. */
export function sanitizeEvidenceItemId(itemId: string): string {
  return sanitizeEvidenceSegment(itemId, "item id");
}

/** Absolute path of the `audit-<date>` directory beneath `<baseDir>/01_evidence/`. */
export function auditEvidenceDir(baseDir: string, date: string): string {
  const safeDate = sanitizeEvidenceSegment(date, "date");
  return path.join(path.resolve(baseDir), "01_evidence", `audit-${safeDate}`);
}

/** Serializes content to text and redacts any secret-like value. */
export function redactEvidenceContent(content: unknown): RedactedEvidenceContent {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else {
    try {
      text = JSON.stringify(content, null, 2) ?? String(content);
    } catch {
      text = String(content);
    }
  }
  const hadSecrets = scanTextForSecrets(text).hasSecrets;
  const redactedText = redactText(text);
  return {
    text: redactedText,
    redacted: redactedText !== text,
    hadSecrets,
  };
}

/**
 * Records one evidence file for an item id. The file is always written inside the
 * `audit-<date>` directory; a traversal attempt in the item id or date throws instead
 * of writing anywhere else.
 */
export function recordEvidenceItem(options: EvidenceRecordOptions): EvidenceRecordResult {
  const safeId = sanitizeEvidenceItemId(options.itemId);
  const dir = auditEvidenceDir(options.baseDir, options.date);
  const filename = `${safeId}.json`;
  const filePath = path.join(dir, filename);

  // Defence in depth: the resolved target must stay inside the audit directory.
  const resolvedDir = path.resolve(dir);
  const resolvedTarget = path.resolve(filePath);
  if (resolvedTarget !== resolvedDir && !resolvedTarget.startsWith(resolvedDir + path.sep)) {
    throw new Error(
      `Refusing to write evidence outside the audit directory: ${resolvedTarget}`
    );
  }

  const redacted = redactEvidenceContent(options.content);
  const payload = {
    itemId: safeId,
    date: options.date,
    phase: options.phase ?? null,
    actor: options.actor ?? null,
    redacted: redacted.redacted,
    content: redacted.text,
  };

  fs.mkdirSync(resolvedDir, { recursive: true });
  fs.writeFileSync(resolvedTarget, JSON.stringify(payload, null, 2), "utf8");

  return {
    itemId: safeId,
    path: resolvedTarget,
    filename,
    redacted: redacted.redacted,
    hadSecrets: redacted.hadSecrets,
  };
}

/** Lists the evidence files recorded for a date (one per item id). */
export function listEvidenceFiles(baseDir: string, date: string): string[] {
  const dir = auditEvidenceDir(baseDir, date);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}