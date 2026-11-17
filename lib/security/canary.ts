// Task 11.6: CI secret redaction canary tests
// Requirements: 42.6

import * as fs from "node:fs";
import type { EventData, EventEnvelope, EventInput, EventKind } from "../events/event-tap";
import { EventTap, type EventTapOptions } from "../events/event-tap";
import { EventStore } from "../events/event-store";
import {
  DEFAULT_REDACTION_MASK,
  SENSITIVE_PATTERNS,
  HOST_DETAIL_PATTERNS,
  redactText,
  redactValue,
  redactObject,
  redactLog,
  scanTextForSecrets,
  scanCandidateDiff,
  scanWorktreeFiles,
  shouldQuarantineWorktree,
  type SecretScanResult,
  type WorktreeFileInput,
  type RedactionOptions,
} from "./redactor";
import type { ArtifactManifest, StoredArtifact } from "../lifecycle/artifact-collector";

export type CanaryKind =
  | "ksk"
  | "ghp"
  | "akia"
  | "github_pat"
  | "dckr_pat"
  | "pem";

export interface CanaryTokenSet {
  readonly ksk: string;
  readonly ghp: string;
  readonly akia: string;
  readonly githubPat: string;
  readonly dckrPat: string;
  readonly pemBlock: string;
  readonly allTokens: readonly string[];
}

export interface PlantedRepositoryFile {
  readonly path: string;
  readonly content: string;
  readonly originalContent?: string;
  readonly plantedTokens: readonly string[];
}

export interface PlantedCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly merged: string;
  readonly plantedTokens: readonly string[];
}

export interface PlantedToolResult {
  readonly payload: Record<string, unknown>;
  readonly plantedTokens: readonly string[];
}

export interface CanaryOccurrence {
  readonly token: string;
  readonly location: string;
  readonly snippet: string;
}

export interface CanaryVerificationResult {
  readonly passed: boolean;
  readonly leaked: boolean;
  readonly occurrences: readonly CanaryOccurrence[];
  readonly leakedTokens: readonly string[];
  readonly reason?: string;
}

export interface CanaryPipelineSimulationOptions {
  readonly runId?: string;
  readonly tokens?: CanaryTokenSet;
  readonly repoFiles?: readonly WorktreeFileInput[];
  readonly commandStdout?: string;
  readonly commandStderr?: string;
  readonly toolResultPayload?: Record<string, unknown>;
  readonly eventStore?: EventStore;
  readonly artifactsDir?: string;
}

export interface CanaryPipelineSimulationReport {
  readonly passed: boolean;
  readonly runId: string;
  readonly plantedTokens: readonly string[];
  readonly worktreeQuarantined: boolean;
  readonly diffQuarantined: boolean;
  readonly downstreamEventTapPassed: boolean;
  readonly eventStorePassed: boolean;
  readonly commandLogsPassed: boolean;
  readonly artifactsPassed: boolean;
  readonly leakedOccurrences: readonly CanaryOccurrence[];
  readonly summary: string;
}

// Prefixes constructed via join to avoid accidental static scanner hits
export const KSK_CANARY_PREFIX = ["ksk", "CANARY"].join("_");
export const GHP_CANARY_PREFIX = ["ghp", "CANARY"].join("_");
export const AKIA_CANARY_PREFIX = ["AKIA", "CANARY"].join("_");
export const GITHUB_PAT_CANARY_PREFIX = ["github", "pat", "CANARY"].join("_");
export const DCKR_PAT_CANARY_PREFIX = ["dckr", "pat", "CANARY"].join("_");
export const PEM_CANARY_HEADER = "-----BEGIN CANARY PRIVATE KEY-----";
export const PEM_CANARY_FOOTER = "-----END CANARY PRIVATE KEY-----";

// AKIA canaries follow the AWS access key id shape (AKIA followed by exactly
// 16 characters from A-Z and 0-9), so the CANARY marker is embedded without
// separators and the remaining characters are uppercase letters and digits.
const AKIA_CANARY_MARKER = "CANARY";
const AKIA_BODY_LENGTH = 16;
const AKIA_UNIQUE_PART_LENGTH = AKIA_BODY_LENGTH - AKIA_CANARY_MARKER.length;
// R6-B2 narrowed the token patterns to a prefix followed by at least 20 token
// alphabet characters; canaries carry at least 24 so the generator always
// outruns the pattern minimum.
const CANARY_TAIL_MIN_LENGTH = 24;

/**
 * Builds the unique tail appended after a canary prefix constant. The tail
 * stays inside the token alphabet ([A-Za-z0-9_.-]) and repeats the sanitized
 * suffix until at least CANARY_TAIL_MIN_LENGTH characters follow the prefix.
 */
function buildCanaryTail(cleanSuffix: string): string {
  const base = cleanSuffix.length > 0 ? cleanSuffix : "TOKEN";
  if (base.length >= CANARY_TAIL_MIN_LENGTH) {
    return base;
  }
  const unit = `${base}_`;
  return unit.repeat(Math.ceil(CANARY_TAIL_MIN_LENGTH / unit.length));
}

/**
 * Builds the characters that follow the CANARY marker inside an AKIA canary
 * body: uppercase alphanumeric, derived from the sanitized suffix, and always
 * ending with two digits so the body contains digits.
 */
function buildAkiaUniquePart(cleanSuffix: string): string {
  const alnum = cleanSuffix.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const head = alnum
    .slice(0, AKIA_UNIQUE_PART_LENGTH - 2)
    .padEnd(AKIA_UNIQUE_PART_LENGTH - 2, "0");
  let checksum = 0;
  for (let i = 0; i < cleanSuffix.length; i++) {
    checksum = (checksum + cleanSuffix.charCodeAt(i)) % 100;
  }
  return `${head}${String(checksum).padStart(2, "0")}`;
}

/**
 * Creates a unique canary token formatted to match the corresponding sensitive pattern.
 * Prefixed kinds (ksk, ghp, github_pat, dckr_pat) keep their prefix and the
 * CANARY marker and append a unique tail of at least 24 token alphabet
 * characters; akia follows the AWS access key id shape (AKIA plus exactly 16
 * characters from A-Z and 0-9, containing the CANARY marker and digits).
 * Requirements: 42.6, 42.3.
 */
export function createCanaryToken(kind: CanaryKind, suffix = "TOKEN_01"): string {
  const cleanSuffix = suffix.replace(/[^a-zA-Z0-9_.-]/g, "_");
  switch (kind) {
    case "ksk":
      return `${KSK_CANARY_PREFIX}_${buildCanaryTail(cleanSuffix)}`;
    case "ghp":
      return `${GHP_CANARY_PREFIX}_${buildCanaryTail(cleanSuffix)}`;
    case "akia":
      return ["AKIA", AKIA_CANARY_MARKER, buildAkiaUniquePart(cleanSuffix)].join("");
    case "github_pat":
      return `${GITHUB_PAT_CANARY_PREFIX}_${buildCanaryTail(cleanSuffix)}`;
    case "dckr_pat":
      return `${DCKR_PAT_CANARY_PREFIX}_${buildCanaryTail(cleanSuffix)}`;
    case "pem":
      return [
        PEM_CANARY_HEADER,
        `MIIBOgIBAAJBAK9CanaryPayload${cleanSuffix}==`,
        PEM_CANARY_FOOTER,
      ].join("\n");
  }
}

/**
 * Creates a complete suite of standard canary tokens covering all primary sensitive formats.
 */
export function createDefaultCanaryTokens(suffix = "CI_CANARY"): CanaryTokenSet {
  const ksk = createCanaryToken("ksk", suffix);
  const ghp = createCanaryToken("ghp", suffix);
  const akia = createCanaryToken("akia", suffix);
  const githubPat = createCanaryToken("github_pat", suffix);
  const dckrPat = createCanaryToken("dckr_pat", suffix);
  const pemBlock = createCanaryToken("pem", suffix);

  const allTokens = [
    ksk,
    ghp,
    akia,
    githubPat,
    dckrPat,
    pemBlock,
    PEM_CANARY_HEADER,
  ];

  return {
    ksk,
    ghp,
    akia,
    githubPat,
    dckrPat,
    pemBlock,
    allTokens,
  };
}

/**
 * Normalizes input tokens or token set into a flat list of distinct non-empty string tokens.
 */
export function getCanaryTokensList(
  tokens: string | readonly string[] | CanaryTokenSet
): readonly string[] {
  if (typeof tokens === "string") {
    return [tokens];
  }
  if (Array.isArray(tokens)) {
    return Array.from(new Set(tokens.filter((t) => typeof t === "string" && t.length > 0)));
  }
  if (tokens && typeof tokens === "object" && Array.isArray((tokens as CanaryTokenSet).allTokens)) {
    return (tokens as CanaryTokenSet).allTokens;
  }
  if (tokens && typeof tokens === "object") {
    const collected: string[] = [];
    for (const val of Object.values(tokens)) {
      if (typeof val === "string" && val.length > 0) {
        collected.push(val);
      }
    }
    return Array.from(new Set(collected));
  }
  return [];
}

/**
 * Plants canary tokens into a single repository / worktree file.
 * Requirement 42.6.
 */
export function plantCanaryInRepositoryFile(
  file: { readonly path: string; readonly content: string },
  canaryOrTokens: string | readonly string[] | CanaryTokenSet,
  placement: "start" | "end" | "inline" = "end"
): PlantedRepositoryFile {
  const tokenList = getCanaryTokensList(canaryOrTokens);
  const injection = tokenList
    .map((tok) => `// CANARY_INJECTION: ${tok}`)
    .join("\n");

  let content: string;
  if (placement === "start") {
    content = `${injection}\n${file.content}`;
  } else if (placement === "inline") {
    const lines = file.content.split("\n");
    const mid = Math.floor(lines.length / 2);
    lines.splice(mid, 0, injection);
    content = lines.join("\n");
  } else {
    content = file.content.endsWith("\n")
      ? `${file.content}${injection}\n`
      : `${file.content}\n${injection}\n`;
  }

  return {
    path: file.path,
    content,
    originalContent: file.content,
    plantedTokens: tokenList,
  };
}

/**
 * Plants canary tokens across an array or mapping of repository / worktree files.
 * Requirement 42.6.
 */
export function plantCanaryInRepositoryFiles(
  files: readonly WorktreeFileInput[] | Readonly<Record<string, string>>,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet
): PlantedRepositoryFile[] {
  const fileList: WorktreeFileInput[] = Array.isArray(files)
    ? (files as WorktreeFileInput[])
    : Object.entries(files).map(([path, content]) => ({ path, content }));

  const tokens = getCanaryTokensList(canaryOrTokens);
  return fileList.map((file, index) => {
    // Distribute tokens across files if multiple tokens given
    const assignedToken = tokens.length > 0 ? tokens[index % tokens.length] : "";
    return plantCanaryInRepositoryFile(file, assignedToken ? [assignedToken] : tokens);
  });
}

/**
 * Plants canary tokens into a unified diff string representing candidate edits.
 * Requirement 42.6, 42.5.
 */
export function plantCanaryInDiff(
  diff: string,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet
): string {
  const tokens = getCanaryTokensList(canaryOrTokens);
  const addedLines = tokens
    .map((tok) => `+const CANARY_SECRET = "${tok}";`)
    .join("\n");

  if (diff.includes("@@")) {
    const parts = diff.split(/(@@[^@]+@@\n)/);
    if (parts.length >= 3) {
      parts[2] = `${addedLines}\n${parts[2]}`;
      return parts.join("");
    }
  }

  return `${diff}\n+/* CANARY INJECTION */\n${addedLines}\n`;
}

/**
 * Plants canary tokens into command output stdout, stderr, and merged streams.
 * Requirement 42.6.
 */
export function plantCanaryInCommandOutput(
  output: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly merged?: string;
  },
  canaryOrTokens: string | readonly string[] | CanaryTokenSet
): PlantedCommandOutput {
  const tokens = getCanaryTokensList(canaryOrTokens);
  const tokenString = tokens.join(" ");

  const baseStdout = output.stdout ?? "";
  const baseStderr = output.stderr ?? "";

  const stdout = baseStdout.length > 0
    ? `${baseStdout}\n[stdout canary: ${tokenString}]`
    : `[stdout canary: ${tokenString}]`;

  const stderr = baseStderr.length > 0
    ? `${baseStderr}\n[stderr canary: ${tokenString}]`
    : `[stderr canary: ${tokenString}]`;

  const merged = output.merged
    ? `${output.merged}\n[merged canary: ${tokenString}]`
    : `${stdout}\n${stderr}`;

  return {
    stdout,
    stderr,
    merged,
    plantedTokens: tokens,
  };
}

/**
 * Plants canary tokens into a tool result payload object.
 * Requirement 42.6.
 */
export function plantCanaryInToolResult(
  payload: Record<string, unknown>,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet,
  targetField = "output"
): PlantedToolResult {
  const tokens = getCanaryTokensList(canaryOrTokens);
  const tokenString = tokens.join(" ");

  const copy: Record<string, unknown> = { ...payload };

  if (typeof copy[targetField] === "string") {
    copy[targetField] = `${copy[targetField]} [tool_canary: ${tokenString}]`;
  } else {
    copy[targetField] = `[tool_canary: ${tokenString}]`;
  }

  copy.canarySecrets = tokens;
  copy.nestedDetails = {
    authHeader: `Bearer ${tokens[0] ?? ""}`,
    tokenList: [...tokens],
  };

  return {
    payload: copy,
    plantedTokens: tokens,
  };
}

/**
 * Plants canary tokens into an EventInput data structure.
 * Requirement 42.6.
 */
export function plantCanaryInEvent(
  event: EventInput,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet,
  location: "data" | "actor" | "skeletonId" | "taskId" = "data"
): EventInput {
  const tokens = getCanaryTokensList(canaryOrTokens);
  const tokenString = tokens.join(" ");
  const copy: EventInput = {
    ...event,
    data: { ...(event.data ?? { refs: [] }) },
  };

  if (location === "actor") {
    copy.actor = `${copy.actor ?? "actor"}-${tokenString}`;
  } else if (location === "skeletonId") {
    copy.skeletonId = `${copy.skeletonId ?? "skel"}-${tokenString}`;
  } else if (location === "taskId") {
    copy.taskId = `${copy.taskId ?? "task"}-${tokenString}`;
  } else {
    copy.data = {
      ...copy.data,
      canaryPayload: tokenString,
      rawOutput: `Execution returned: ${tokenString}`,
    };
  }

  return copy;
}

/**
 * Recursively scans any JavaScript data structure (strings, buffers, arrays, objects)
 * for occurrences of any canary token.
 * Requirement 42.6.
 */
export function findCanaryOccurrences(
  target: unknown,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet,
  locationPrefix = "root",
  seen: WeakSet<object> = new WeakSet()
): CanaryOccurrence[] {
  const tokens = getCanaryTokensList(canaryOrTokens);
  if (tokens.length === 0 || target === null || target === undefined) {
    return [];
  }

  const occurrences: CanaryOccurrence[] = [];

  const checkText = (text: string, loc: string): void => {
    if (!text || typeof text !== "string") {
      return;
    }
    for (const token of tokens) {
      if (text.includes(token)) {
        const idx = text.indexOf(token);
        const start = Math.max(0, idx - 20);
        const end = Math.min(text.length, idx + token.length + 20);
        const snippet = text.slice(start, end).replace(/\s+/g, " ");
        occurrences.push({
          token,
          location: loc,
          snippet,
        });
      }
    }
  };

  if (typeof target === "string") {
    checkText(target, locationPrefix);
    return occurrences;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(target)) {
    checkText((target as Buffer).toString("utf-8"), locationPrefix);
    return occurrences;
  }

  if (typeof target !== "object") {
    return occurrences;
  }

  if (seen.has(target as object)) {
    return occurrences;
  }
  seen.add(target as object);

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      const childOccurrences = findCanaryOccurrences(
        target[i],
        tokens,
        `${locationPrefix}[${i}]`,
        seen
      );
      for (const occ of childOccurrences) {
        occurrences.push(occ);
      }
    }
    return occurrences;
  }

  if (target instanceof Map) {
    for (const [key, val] of target.entries()) {
      const keyStr = typeof key === "string" ? key : String(key);
      checkText(keyStr, `${locationPrefix}.map_key(${keyStr})`);
      const childOccurrences = findCanaryOccurrences(
        val,
        tokens,
        `${locationPrefix}[${keyStr}]`,
        seen
      );
      for (const occ of childOccurrences) {
        occurrences.push(occ);
      }
    }
    return occurrences;
  }

  if (target instanceof Set) {
    let idx = 0;
    for (const val of target) {
      const childOccurrences = findCanaryOccurrences(
        val,
        tokens,
        `${locationPrefix}.set[${idx++}]`,
        seen
      );
      for (const occ of childOccurrences) {
        occurrences.push(occ);
      }
    }
    return occurrences;
  }

  for (const [key, val] of Object.entries(target)) {
    checkText(key, `${locationPrefix}.key(${key})`);
    const childOccurrences = findCanaryOccurrences(
      val,
      tokens,
      `${locationPrefix}.${key}`,
      seen
    );
    for (const occ of childOccurrences) {
      occurrences.push(occ);
    }
  }

  return occurrences;
}

/**
 * Pure verification evaluating whether a target object or text contains zero canary token leaks.
 * Requirement 42.6.
 */
export function verifyNoCanaryLeaks(
  target: unknown,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet,
  locationPrefix = "target"
): CanaryVerificationResult {
  const occurrences = findCanaryOccurrences(target, canaryOrTokens, locationPrefix);
  const passed = occurrences.length === 0;
  const leaked = !passed;
  const leakedTokens = Array.from(new Set(occurrences.map((o) => o.token)));

  const reason = passed
    ? undefined
    : `Canary leak detected: ${leakedTokens.length} token(s) leaked across ${occurrences.length} location(s): ${occurrences.map((o) => `${o.token}@${o.location}`).join(", ")}`;

  return {
    passed,
    leaked,
    occurrences,
    leakedTokens,
    reason,
  };
}

/**
 * Verifies that events emitted or returned downstream of EventTap contain no canary tokens.
 * Requirement 42.6.
 */
export function verifyDownstreamEventTap(
  events: readonly EventEnvelope[] | EventEnvelope | unknown,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet
): CanaryVerificationResult {
  return verifyNoCanaryLeaks(events, canaryOrTokens, "downstream_event_tap");
}

/**
 * Verifies that an EventStore database or list of persisted events contains no canary tokens.
 * Requirement 42.6.
 */
export function verifyEventStoreContainment(
  eventStoreOrEvents: EventStore | readonly EventEnvelope[],
  runId: string,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet
): CanaryVerificationResult {
  const events =
    eventStoreOrEvents instanceof EventStore
      ? eventStoreOrEvents.getEvents(runId)
      : eventStoreOrEvents;

  return verifyNoCanaryLeaks(events, canaryOrTokens, `event_store:${runId}`);
}

/**
 * Verifies that generated artifacts (in-memory maps or on-disk paths) contain no canary tokens.
 * Requirement 42.6.
 */
export function verifyArtifactContainment(
  artifacts:
    | Readonly<Record<string, string | Buffer>>
    | ReadonlyArray<{
        readonly name: string;
        readonly content?: string | Buffer;
        readonly path?: string;
      }>
    | ArtifactManifest,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet
): CanaryVerificationResult {
  const tokens = getCanaryTokensList(canaryOrTokens);
  const occurrences: CanaryOccurrence[] = [];

  const checkContent = (
    content: string | Buffer,
    label: string
  ): void => {
    const text = Buffer.isBuffer(content)
      ? content.toString("utf-8")
      : String(content);
    const occs = findCanaryOccurrences(text, tokens, label);
    for (const occ of occs) {
      occurrences.push(occ);
    }
  };

  if (
    artifacts &&
    typeof artifacts === "object" &&
    "artifacts" in artifacts &&
    typeof (artifacts as ArtifactManifest).artifacts === "object"
  ) {
    const manifest = artifacts as ArtifactManifest;
    for (const [kind, art] of Object.entries(manifest.artifacts)) {
      if (!art) {
        continue;
      }
      const label = `artifact:${manifest.runId}:${kind}:${art.fileName}`;
      if (fs.existsSync(art.path)) {
        try {
          const bytes = fs.readFileSync(art.path);
          checkContent(bytes, label);
        } catch {
          // Ignore unreadable artifact in pure scan
        }
      }
    }
  } else if (Array.isArray(artifacts)) {
    for (const art of artifacts) {
      const label = `artifact:${art.name}`;
      if (art.content !== undefined) {
        checkContent(art.content, label);
      } else if (art.path && fs.existsSync(art.path)) {
        try {
          const bytes = fs.readFileSync(art.path);
          checkContent(bytes, label);
        } catch {
          // Ignore file read error
        }
      }
    }
  } else if (artifacts && typeof artifacts === "object") {
    for (const [name, content] of Object.entries(artifacts)) {
      checkContent(content as string | Buffer, `artifact:${name}`);
    }
  }

  const passed = occurrences.length === 0;
  const leaked = !passed;
  const leakedTokens = Array.from(new Set(occurrences.map((o) => o.token)));

  return {
    passed,
    leaked,
    occurrences,
    leakedTokens,
    reason: passed
      ? undefined
      : `Canary leak in artifacts: ${leakedTokens.length} token(s) leaked across ${occurrences.length} location(s)`,
  };
}

/**
 * Verifies command log strings or log objects for zero canary token leaks.
 * Requirement 42.6.
 */
export function verifyCommandLogContainment(
  log: unknown,
  canaryOrTokens: string | readonly string[] | CanaryTokenSet
): CanaryVerificationResult {
  return verifyNoCanaryLeaks(log, canaryOrTokens, "command_log");
}

/**
 * Pure helper verifying that worktree scanner quarantines changed files on canary detection.
 * Requirements: 22.14, 22.15, 42.5.
 */
export function verifyWorktreeQuarantineOnCanary(
  files: readonly WorktreeFileInput[] | Readonly<Record<string, string>>,
  options?: RedactionOptions
): SecretScanResult {
  return scanWorktreeFiles(files, options);
}

/**
 * Pure helper verifying that candidate diff scanner quarantines candidate diffs on canary detection.
 * Requirements: 42.5.
 */
export function verifyDiffQuarantineOnCanary(
  diff: string,
  options?: RedactionOptions
): SecretScanResult {
  return scanCandidateDiff(diff, options);
}

/**
 * Runs an in-memory simulation of the entire CI secret redaction canary test pipeline.
 * Requirement 42.6.
 */
export function runCanaryMemoryPipeline(
  options?: CanaryPipelineSimulationOptions
): CanaryPipelineSimulationReport {
  const runId = options?.runId ?? `canary-run-${Date.now()}`;
  const tokens = options?.tokens ?? createDefaultCanaryTokens("CI_RUN");
  const tokenList = tokens.allTokens;

  // 1. Plant canary tokens in repository files
  const sampleFiles: WorktreeFileInput[] = options?.repoFiles
    ? [...options.repoFiles]
    : [
        { path: "src/index.ts", content: "export function run() { return true; }\n" },
        { path: "package.json", content: '{"name": "test-repo", "version": "1.0.0"}\n' },
      ];
  const plantedRepoFiles = plantCanaryInRepositoryFiles(sampleFiles, tokens);

  // Scan changed worktree files before sandbox_exec (Requirement 42.5)
  const worktreeScan = scanWorktreeFiles(plantedRepoFiles);
  const worktreeQuarantined = worktreeScan.shouldQuarantine;

  // Scan candidate diff before Grimoire gate (Requirement 42.5)
  const plantedDiff = plantCanaryInDiff(
    "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,1 +1,2 @@\n-export function run() { return true; }\n+export function run() { return false; }\n",
    tokens
  );
  const diffScan = scanCandidateDiff(plantedDiff);
  const diffQuarantined = diffScan.shouldQuarantine;

  // 2. Plant canary tokens in command output stdout/stderr
  const plantedOutput = plantCanaryInCommandOutput(
    {
      stdout: options?.commandStdout ?? "Build succeeded with 0 warnings",
      stderr: options?.commandStderr ?? "info: checking dependencies",
    },
    tokens
  );

  // Redact command logs
  const redactedStdout = redactText(plantedOutput.stdout);
  const redactedStderr = redactText(plantedOutput.stderr);
  const redactedMerged = redactText(plantedOutput.merged);
  const logCheck = verifyCommandLogContainment(
    { stdout: redactedStdout, stderr: redactedStderr, merged: redactedMerged },
    tokens
  );

  // 3. Plant canary tokens in tool result payload
  const plantedTool = plantCanaryInToolResult(
    options?.toolResultPayload ?? {
      toolName: "sandbox_exec",
      callId: "call-101",
      result: "executed command cleanly",
    },
    tokens
  );
  const redactedToolPayload = redactValue(plantedTool.payload) as Record<string, unknown>;
  const toolCheck = verifyNoCanaryLeaks(redactedToolPayload, tokens, "tool_payload");

  // 4. Ingest events into EventTap and EventStore
  const eventStore = options?.eventStore ?? new EventStore(":memory:");
  const eventTap = new EventTap(eventStore);

  const rawEvents: EventInput[] = [
    {
      runId,
      kind: "command.result",
      actor: "necro",
      data: {
        command: ["npm", "test"],
        stdout: plantedOutput.stdout,
        stderr: plantedOutput.stderr,
        merged: plantedOutput.merged,
        refs: [],
      },
    },
    {
      runId,
      kind: "skeleton.tool_result",
      actor: "skel",
      skeletonId: "bonesetter",
      data: {
        toolName: "sandbox_exec",
        payload: plantedTool.payload,
        refs: [],
      },
    },
    {
      runId,
      kind: "task.state",
      actor: "necro",
      taskId: "T1",
      data: {
        state: "in_review",
        fileSample: plantedRepoFiles[0]?.content ?? "",
        refs: [],
      },
    },
  ];

  const downstreamEnvelopes: EventEnvelope[] = [];
  for (const rawEv of rawEvents) {
    const envelope = eventTap.append(rawEv);
    downstreamEnvelopes.push(envelope);
  }

  // Verify downstream of EventTap
  const downstreamCheck = verifyDownstreamEventTap(downstreamEnvelopes, tokens);

  // Verify inside EventStore
  const storeCheck = verifyEventStoreContainment(eventStore, runId, tokens);

  // 5. Generate and check in-memory artifacts
  const artifacts: Record<string, string> = {
    "all.patch": redactText(plantedDiff),
    "events.ndjson": downstreamEnvelopes.map((e) => JSON.stringify(e)).join("\n"),
    "report.md": redactText(
      `# Run Report for ${runId}\nCommand log summary: ${plantedOutput.stdout}\n`
    ),
    "spec.json": JSON.stringify(
      redactValue({
        requirements: "clean requirements",
        toolOutput: plantedTool.payload,
      })
    ),
  };

  const artifactsCheck = verifyArtifactContainment(artifacts, tokens);

  const allLeaks = [
    ...downstreamCheck.occurrences,
    ...storeCheck.occurrences,
    ...logCheck.occurrences,
    ...toolCheck.occurrences,
    ...artifactsCheck.occurrences,
  ];

  const leakedTokens = Array.from(new Set(allLeaks.map((o) => o.token)));
  const passed =
    worktreeQuarantined &&
    diffQuarantined &&
    downstreamCheck.passed &&
    storeCheck.passed &&
    logCheck.passed &&
    toolCheck.passed &&
    artifactsCheck.passed;

  const summary = passed
    ? `Canary CI suite passed: ${tokenList.length} canary tokens contained across worktree, diff, EventTap, EventStore, command logs, and artifacts.`
    : `Canary CI suite failed: ${leakedTokens.length} token(s) leaked downstream.`;

  return {
    passed,
    runId,
    plantedTokens: tokenList,
    worktreeQuarantined,
    diffQuarantined,
    downstreamEventTapPassed: downstreamCheck.passed,
    eventStorePassed: storeCheck.passed,
    commandLogsPassed: logCheck.passed,
    artifactsPassed: artifactsCheck.passed,
    leakedOccurrences: allLeaks,
    summary,
  };
}
