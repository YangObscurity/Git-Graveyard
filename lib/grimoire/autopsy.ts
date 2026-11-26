import type {
  RuleId,
  Confidence,
  Signal,
  DeadReason,
  AutopsyVerdict,
  AutopsyStatus,
} from "./types";
import {
  computeVerdict,
  STILL_BREATHING,
  type VerdictResult,
  type ComputeVerdictOptions,
} from "./verdict";
import type { RepoMetadata, DefaultHeadCommit } from "./github";
import type { Language, ScannedFile, ScanInventorySuccess } from "./detect";

export const DISCLAIMER =
  "Grimoire's instant verdict is rule-based and has not run your code.";
export const GRIMOIRE_DISCLAIMER = DISCLAIMER;

export const VALID_RULE_IDS: readonly RuleId[] = [
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
] as const;
export const RULE_IDS = VALID_RULE_IDS;

export interface Receipt {
  ruleId: RuleId;
  file: string;
  line: number;
  target: string;
  formatted: string;
  snippet?: string;
  toString(): string;
}

export interface SignalChip {
  ruleId: RuleId;
  file: string;
  line: number;
  target: string;
  clipboardPayload: string;
  receipt: Receipt;
  confidence?: Confidence;
  matched?: string;
  column?: number;
  manifestDir?: string;
  signal?: Signal;
  snippet?: string;
}

export type FilesInput =
  | Map<string, unknown>
  | Record<string, unknown>
  | readonly unknown[]
  | Iterable<unknown>;

export interface AutopsyInputs {
  archived?: boolean;
  lastCommitAt?: string | Date | number;
  createdAt?: string | Date | number;
  created_at?: string | Date | number;
  asOf?: string | Date | number;
  meta?: RepoMetadata | Record<string, unknown>;
  metadata?: RepoMetadata | Record<string, unknown>;
  headCommit?: DefaultHeadCommit | Record<string, unknown>;
  defaultHeadCommit?: DefaultHeadCommit | Record<string, unknown>;
  commit?: Record<string, unknown>;
  signals?:
    | readonly Signal[]
    | Iterable<Signal>
    | { signals?: readonly Signal[] }
    | null;
  files?: FilesInput | null;
  scannedFiles?: ScannedFile[] | null;
  inventory?: ScanInventorySuccess | Record<string, unknown>;
  languages?: Language[] | readonly string[];
  verdict?: VerdictResult | Record<string, unknown>;
  lastWords?: string | null;
  commitMessage?: string | null;
  message?: string | null;
  sha?: string | null;
  fullName?: string | null;
  full_name?: string | null;
  defaultBranch?: string | null;
  default_branch?: string | null;
  stars?: number | null;
  forks?: number | null;
  [key: string]: unknown;
}

export interface AutopsyResult {
  status: AutopsyVerdict;
  label?: string;
  reasons: DeadReason[];
  deadReasons: DeadReason[];
  cause: string;
  lastWords: string;
  lastWordsRaw: string;
  lastWordsEscaped: string;
  escapedLastWords: string;
  lifespanYears: number | "unknown";
  yearsDead: number;
  asOf: string;
  receipts: Receipt[];
  signalChips: Record<RuleId, SignalChip[]>;
  chipsByRule: Record<RuleId, SignalChip[]>;
  chips: SignalChip[];
  groupedChips: Array<{ ruleId: RuleId; chips: SignalChip[] }>;
  fullName: string;
  full_name: string;
  defaultBranch: string;
  default_branch: string;
  sha: string;
  stars: number;
  forks: number;
  languages: string[];
  disclaimer: string;
  verdict: VerdictResult;
}

export function isRuleId(val: unknown): val is RuleId {
  if (typeof val !== "string") return false;
  const upper = val.toUpperCase();
  return (
    upper === "M1" ||
    upper === "M2" ||
    upper === "M3" ||
    upper === "M4" ||
    upper === "M5" ||
    upper === "M6"
  );
}

/**
 * Extracts Last_Words from the first non-empty line of the default-branch
 * head commit message, truncated to 120 UTF-8 characters.
 */
export function extractLastWords(
  commitMessage:
    | string
    | { message?: string; commitMessage?: string }
    | null
    | undefined
): string {
  const raw =
    typeof commitMessage === "string"
      ? commitMessage
      : commitMessage && typeof commitMessage === "object"
      ? commitMessage.message ?? commitMessage.commitMessage ?? ""
      : "";

  if (typeof raw !== "string" || raw.length === 0) {
    return "";
  }

  const lines = raw.split(/\r?\n|\r/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const chars = Array.from(trimmed);
      if (chars.length > 120) {
        return chars.slice(0, 120).join("");
      }
      return trimmed;
    }
  }

  return "";
}

/**
 * Escapes markup characters for plain text display.
 */
export function escapePlainText(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const escapeMarkup = escapePlainText;

const CAUSE_TEMPLATES = {
  archived: "Repository is archived.",
  dormant_24m: "No commit activity for over 24 calendar months.",
  deprecation_signal: "Deprecation signals detected in repository source files.",
  alive: "Repository is still breathing; no death criteria triggered.",
  defaultDead: "Repository diagnosed as dead by Grimoire rule-based heuristics.",
} as const;

/**
 * Formats autopsy cause text from templates only.
 * Always includes the sentence:
 * "Grimoire's instant verdict is rule-based and has not run your code."
 */
export function formatAutopsyCause(
  verdictOrStatus?:
    | AutopsyVerdict
    | VerdictResult
    | { status?: string; reasons?: string[]; deadReasons?: string[] }
    | null,
  reasonsInput?: readonly (DeadReason | string)[]
): string {
  let status: string = "dead";
  let reasons: string[] = [];

  if (typeof verdictOrStatus === "string") {
    status = verdictOrStatus;
    if (Array.isArray(reasonsInput)) {
      reasons = reasonsInput.map(String);
    }
  } else if (verdictOrStatus && typeof verdictOrStatus === "object") {
    status = verdictOrStatus.status ?? "dead";
    const r =
      verdictOrStatus.deadReasons ??
      verdictOrStatus.reasons ??
      (Array.isArray(reasonsInput) ? reasonsInput : []);
    if (Array.isArray(r)) {
      reasons = r.map(String);
    }
  } else if (Array.isArray(reasonsInput)) {
    reasons = reasonsInput.map(String);
    status = reasons.length > 0 ? "dead" : "alive";
  }

  const parts: string[] = [];

  if (status === "alive") {
    parts.push(CAUSE_TEMPLATES.alive);
  } else {
    const descriptions: string[] = [];
    for (const reason of reasons) {
      if (reason === "archived") {
        descriptions.push(CAUSE_TEMPLATES.archived);
      } else if (reason === "dormant_24m") {
        descriptions.push(CAUSE_TEMPLATES.dormant_24m);
      } else if (reason === "deprecation_signal") {
        descriptions.push(CAUSE_TEMPLATES.deprecation_signal);
      } else if (reason) {
        descriptions.push(`Reason: ${reason}.`);
      }
    }

    if (descriptions.length > 0) {
      parts.push(descriptions.join(" "));
    } else {
      parts.push(CAUSE_TEMPLATES.defaultDead);
    }
  }

  parts.push(DISCLAIMER);
  return parts.join(" ");
}

export const generateCauseText = formatAutopsyCause;
export const formatCauseText = formatAutopsyCause;

/**
 * Formats a Receipt showing rule ID and file:line.
 */
export function formatReceipt(
  ruleId: RuleId,
  file: string,
  line: number,
  snippet?: string
): Receipt {
  const target = `${file}:${line}`;
  const formatted = `${ruleId} ${target}`;
  return {
    ruleId,
    file,
    line,
    target,
    formatted,
    snippet,
    toString() {
      return formatted;
    },
  };
}

/**
 * Returns clipboard payload for a Signal or SignalChip (which is file:line).
 */
export function getClipboardPayload(
  item:
    | { file?: string; line?: number; clipboardPayload?: string }
    | Signal
    | SignalChip
    | Receipt
    | string
    | null
    | undefined
): string {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return "";
  }
  if ("clipboardPayload" in item && typeof item.clipboardPayload === "string") {
    return item.clipboardPayload;
  }
  const file = "file" in item && typeof item.file === "string" ? item.file : "";
  const line =
    "line" in item &&
    (typeof item.line === "number" || typeof item.line === "string")
      ? item.line
      : "";
  if (file && line !== "") {
    return `${file}:${line}`;
  }
  return file || String(line);
}

function extractTextFromEntry(entry: unknown): string | null {
  if (entry == null) return null;
  if (typeof entry === "string") return entry;
  if (typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    if (typeof e.content === "string") return e.content;
    if (typeof e.text === "string") return e.text;
    if (typeof e.source === "string") return e.source;
    if (e.bytes instanceof Uint8Array) {
      try {
        return new TextDecoder("utf-8").decode(e.bytes);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function getFileContentFromCollection(
  files: unknown,
  filePath: string
): string | null {
  if (!files || typeof files !== "object") return null;

  const normalized = filePath.replace(/\\/g, "/").replace(/^\.?\/+/, "");

  if (files instanceof Map) {
    if (files.has(filePath)) {
      return extractTextFromEntry(files.get(filePath));
    }
    if (files.has(normalized)) {
      return extractTextFromEntry(files.get(normalized));
    }
    for (const [key, val] of files.entries()) {
      const kNorm = String(key).replace(/\\/g, "/").replace(/^\.?\/+/, "");
      if (
        kNorm === normalized ||
        kNorm.endsWith("/" + normalized) ||
        normalized.endsWith("/" + kNorm)
      ) {
        return extractTextFromEntry(val);
      }
    }
    return null;
  }

  if (
    Array.isArray(files) ||
    typeof (files as any)[Symbol.iterator] === "function"
  ) {
    for (const item of files as Iterable<any>) {
      if (!item) continue;
      const itemPath =
        typeof item === "string"
          ? item
          : item.path ?? item.filePath ?? item.name;
      if (typeof itemPath === "string") {
        const itemNorm = itemPath.replace(/\\/g, "/").replace(/^\.?\/+/, "");
        if (
          itemNorm === normalized ||
          itemNorm.endsWith("/" + normalized) ||
          normalized.endsWith("/" + itemNorm)
        ) {
          return extractTextFromEntry(item);
        }
      }
    }
    return null;
  }

  const obj = files as Record<string, unknown>;
  if (filePath in obj) {
    return extractTextFromEntry(obj[filePath]);
  }
  if (normalized in obj) {
    return extractTextFromEntry(obj[normalized]);
  }
  for (const [key, val] of Object.entries(obj)) {
    const kNorm = key.replace(/\\/g, "/").replace(/^\.?\/+/, "");
    if (
      kNorm === normalized ||
      kNorm.endsWith("/" + normalized) ||
      normalized.endsWith("/" + kNorm)
    ) {
      return extractTextFromEntry(val);
    }
  }

  return null;
}

function extractLineFromContent(content: string, line: number): string {
  if (typeof content !== "string" || !Number.isFinite(line) || line < 1) {
    return "";
  }
  const lines = content.split(/\r?\n/);
  const idx = Math.floor(line) - 1;
  if (idx >= 0 && idx < lines.length) {
    return lines[idx];
  }
  return "";
}

/**
 * Extracts the source line at recorded file:line for analysed sha.
 * Pure function: operates only on provided string or files collection.
 */
export function extractSourceSnippet(
  filesOrContent: unknown,
  fileOrTargetOrLine?: unknown,
  maybeLine?: unknown
): string {
  if (
    typeof filesOrContent === "string" &&
    typeof fileOrTargetOrLine === "number"
  ) {
    return extractLineFromContent(filesOrContent, fileOrTargetOrLine);
  }

  if (typeof fileOrTargetOrLine === "string" && maybeLine === undefined) {
    const target = fileOrTargetOrLine.trim();
    const lastColon = target.lastIndexOf(":");
    if (lastColon !== -1) {
      const filePath = target.slice(0, lastColon);
      const lineNum = parseInt(target.slice(lastColon + 1), 10);
      if (Number.isFinite(lineNum)) {
        const content = getFileContentFromCollection(filesOrContent, filePath);
        if (content !== null) {
          return extractLineFromContent(content, lineNum);
        }
      }
    }
  }

  if (
    typeof fileOrTargetOrLine === "string" &&
    typeof maybeLine === "number"
  ) {
    const content = getFileContentFromCollection(
      filesOrContent,
      fileOrTargetOrLine
    );
    if (content !== null) {
      return extractLineFromContent(content, maybeLine);
    }
  }

  if (
    typeof filesOrContent === "string" &&
    fileOrTargetOrLine &&
    typeof fileOrTargetOrLine === "object"
  ) {
    return extractSourceSnippet(fileOrTargetOrLine, filesOrContent);
  }

  return "";
}

/**
 * Creates a SignalChip from a Signal.
 */
export function createSignalChip(
  signal: Signal | (Record<string, unknown> & { file: string; line: number }),
  files?: FilesInput | null
): SignalChip {
  const rawRule = String(signal.ruleId ?? "").toUpperCase();
  const ruleId: RuleId = isRuleId(rawRule) ? (rawRule as RuleId) : "M1";
  const file = String(signal.file ?? "");
  const line = Number(signal.line ?? 0);
  const target = `${file}:${line}`;
  const clipboardPayload = target;

  const snippet = files
    ? extractSourceSnippet(files, file, line) || undefined
    : undefined;
  const receipt = formatReceipt(ruleId, file, line, snippet);

  return {
    ruleId,
    file,
    line,
    target,
    clipboardPayload,
    receipt,
    confidence: signal.confidence as Confidence | undefined,
    matched: typeof signal.matched === "string" ? signal.matched : undefined,
    column: typeof signal.column === "number" ? signal.column : undefined,
    manifestDir:
      typeof signal.manifestDir === "string" ? signal.manifestDir : undefined,
    signal: signal as Signal,
    snippet,
  };
}

/**
 * Groups Signal_Chips by rule ID M1 to M6.
 */
export function groupSignalChipsByRule(
  signals: Iterable<Signal | SignalChip | unknown> | null | undefined,
  files?: FilesInput | null
): Record<RuleId, SignalChip[]> {
  const groups: Record<RuleId, SignalChip[]> = {
    M1: [],
    M2: [],
    M3: [],
    M4: [],
    M5: [],
    M6: [],
  };

  if (!signals) return groups;

  const items = Array.isArray(signals)
    ? signals
    : typeof (signals as any)[Symbol.iterator] === "function"
    ? Array.from(signals)
    : "signals" in (signals as any) &&
      Array.isArray((signals as any).signals)
    ? (signals as any).signals
    : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    let chip: SignalChip;
    if (
      "clipboardPayload" in item &&
      "receipt" in item &&
      isRuleId((item as any).ruleId)
    ) {
      chip = item as SignalChip;
    } else {
      chip = createSignalChip(item as any, files);
    }

    const rule = chip.ruleId;
    if (groups[rule]) {
      groups[rule].push(chip);
    }
  }

  return groups;
}

/**
 * Combines already-fetched inputs into a formatted autopsy result.
 * Pure function: operates strictly over passed inputs with no network or fs reads.
 */
export function formatAutopsy(inputs: AutopsyInputs): AutopsyResult {
  const meta = inputs.meta ?? inputs.metadata ?? null;
  const headCommit =
    inputs.headCommit ??
    inputs.defaultHeadCommit ??
    inputs.commit ??
    null;

  let rawMessage = "";
  if (typeof inputs.lastWords === "string" && inputs.lastWords.length > 0) {
    rawMessage = inputs.lastWords;
  } else if (
    typeof inputs.commitMessage === "string" &&
    inputs.commitMessage.length > 0
  ) {
    rawMessage = inputs.commitMessage;
  } else if (
    typeof inputs.message === "string" &&
    inputs.message.length > 0
  ) {
    rawMessage = inputs.message;
  } else if (headCommit) {
    rawMessage =
      typeof headCommit.message === "string"
        ? headCommit.message
        : typeof (headCommit as any).commitMessage === "string"
        ? (headCommit as any).commitMessage
        : typeof (headCommit as any).lastWords === "string"
        ? (headCommit as any).lastWords
        : "";
  }

  const lastWords = extractLastWords(rawMessage);
  const lastWordsEscaped = escapePlainText(lastWords);

  const rawSignals =
    inputs.signals &&
    typeof inputs.signals === "object" &&
    "signals" in inputs.signals &&
    Array.isArray((inputs.signals as any).signals)
      ? (inputs.signals as any).signals
      : inputs.signals;

  const signalsList: Signal[] = Array.isArray(rawSignals)
    ? rawSignals
    : rawSignals && typeof (rawSignals as any)[Symbol.iterator] === "function"
    ? Array.from(rawSignals as Iterable<Signal>)
    : [];

  const files = inputs.files ?? inputs.scannedFiles ?? null;

  let verdict: VerdictResult;
  if (
    inputs.verdict &&
    typeof inputs.verdict === "object" &&
    "status" in inputs.verdict
  ) {
    const v = inputs.verdict as any;
    const status: AutopsyVerdict = v.status === "alive" ? "alive" : "dead";
    const reasons: DeadReason[] = Array.isArray(v.reasons)
      ? v.reasons
      : Array.isArray(v.deadReasons)
      ? v.deadReasons
      : [];
    verdict = {
      status,
      deadReasons: reasons,
      reasons,
      lifespanYears: v.lifespanYears ?? "unknown",
      yearsDead: typeof v.yearsDead === "number" ? v.yearsDead : 0,
      label: status === "alive" ? STILL_BREATHING : undefined,
      asOf:
        typeof v.asOf === "string"
          ? v.asOf
          : typeof inputs.asOf === "string"
          ? inputs.asOf
          : new Date().toISOString(),
    };
  } else {
    const verdictOpts: ComputeVerdictOptions = {
      archived: Boolean(inputs.archived ?? meta?.archived ?? false),
      lastCommitAt:
        inputs.lastCommitAt ??
        headCommit?.lastCommitAt ??
        (headCommit as any)?.committerDate,
      createdAt:
        inputs.createdAt ??
        inputs.created_at ??
        meta?.created_at ??
        (meta as any)?.createdAt,
      signals: signalsList,
      asOf: inputs.asOf ?? (meta as any)?.asOf,
      meta: (meta as any) ?? undefined,
      headCommit: (headCommit as any) ?? undefined,
    };
    verdict = computeVerdict(verdictOpts);
  }

  const groupedChips = groupSignalChipsByRule(signalsList, files);

  const chips: SignalChip[] = [];
  for (const ruleId of VALID_RULE_IDS) {
    chips.push(...groupedChips[ruleId]);
  }

  const receipts: Receipt[] = chips.map((c) => c.receipt);

  const cause = formatAutopsyCause(verdict, verdict.reasons);

  const fullName =
    typeof inputs.fullName === "string"
      ? inputs.fullName
      : typeof inputs.full_name === "string"
      ? inputs.full_name
      : typeof meta?.full_name === "string"
      ? meta.full_name
      : typeof meta?.fullName === "string"
      ? (meta.fullName as string)
      : "";

  const defaultBranch =
    typeof inputs.defaultBranch === "string"
      ? inputs.defaultBranch
      : typeof inputs.default_branch === "string"
      ? inputs.default_branch
      : typeof meta?.default_branch === "string"
      ? meta.default_branch
      : typeof meta?.defaultBranch === "string"
      ? (meta.defaultBranch as string)
      : "main";

  const sha =
    typeof inputs.sha === "string"
      ? inputs.sha
      : typeof headCommit?.sha === "string"
      ? headCommit.sha
      : "";

  const stars =
    typeof inputs.stars === "number"
      ? inputs.stars
      : typeof meta?.stargazers_count === "number"
      ? meta.stargazers_count
      : typeof (meta as any)?.stargazersCount === "number"
      ? (meta as any).stargazersCount
      : typeof (meta as any)?.stars === "number"
      ? (meta as any).stars
      : 0;

  const forks =
    typeof inputs.forks === "number"
      ? inputs.forks
      : typeof meta?.forks_count === "number"
      ? meta.forks_count
      : typeof (meta as any)?.forksCount === "number"
      ? (meta as any).forksCount
      : typeof (meta as any)?.forks === "number"
      ? (meta as any).forks
      : 0;

  let rawLangs: unknown =
    inputs.languages ?? inputs.inventory?.languages ?? [];
  const languages: string[] = Array.isArray(rawLangs)
    ? rawLangs.map(String)
    : [];

  return {
    status: verdict.status,
    label: verdict.status === "alive" ? STILL_BREATHING : undefined,
    reasons: verdict.reasons,
    deadReasons: verdict.deadReasons,
    cause,
    lastWords,
    lastWordsRaw: lastWords,
    lastWordsEscaped,
    escapedLastWords: lastWordsEscaped,
    lifespanYears: verdict.lifespanYears,
    yearsDead: verdict.yearsDead,
    asOf: verdict.asOf,
    receipts,
    signalChips: groupedChips,
    chipsByRule: groupedChips,
    chips,
    groupedChips: VALID_RULE_IDS.map((ruleId) => ({
      ruleId,
      chips: groupedChips[ruleId] ?? [],
    })),
    fullName,
    full_name: fullName,
    defaultBranch,
    default_branch: defaultBranch,
    sha,
    stars,
    forks,
    languages,
    disclaimer: DISCLAIMER,
    verdict,
  };
}

export const runGrimoireAutopsy = formatAutopsy;
