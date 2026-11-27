// Task 20.2: Headless Fallback execution channel
// Requirements: 17.1-17.12, 45.15, 45.18
//
// Used only when probe P1 fails to operate ACP headlessly with KIRO_API_KEY and
// probe P14 confirms stream-json reports the active model. Each turn spawns
// `kiro-cli chat --v3 --no-interactive --output-format stream-json`, the raw
// stdout stream is written to disk before parsing, and the parsed records drive
// the exit-code mapping, the model check, approval resume and auto-denied asks.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  buildSkeletonEnv,
} from "../supervisor/skeleton-env";
import type {
  ChildProcessLike,
  SpawnFunction,
  SpawnOptions,
} from "../supervisor/types";
import {
  DEFAULT_REDACTION_MASK,
  redactText,
  redactValue,
  type RedactionOptions,
} from "../security/redactor";
import {
  createStreamDiskLogger,
  extractApprovalRequests,
  extractAskRequests,
  extractHeadlessCredits,
  extractSessionId,
  mapHeadlessExitCode,
  parseStreamJsonLine,
  verifyHeadlessModel,
  type HeadlessApprovalRequest,
  type HeadlessAskRequest,
  type HeadlessExitStatus,
  type HeadlessModelVerification,
  type StreamDiskLogger,
  type StreamJsonRecord,
} from "./stream-parser";

const defaultSpawn = spawn as unknown as SpawnFunction;

/**
 * Resolves a sandbox username to its numeric uid/gid by reading `/etc/passwd`.
 * POSIX only (win32 has no `/etc/passwd`), and returns `null` when the user is
 * unknown or the file cannot be read, so the caller fails the turn closed rather
 * than spawning without the requested sandbox identity.
 */
export function defaultResolveUserIds(
  user: string
): { uid: number; gid: number } | null {
  if (process.platform === "win32") {
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync("/etc/passwd", "utf-8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(":");
    if (fields.length < 4 || fields[0] !== user) {
      continue;
    }
    const uid = Number.parseInt(fields[2], 10);
    const gid = Number.parseInt(fields[3], 10);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
      return null;
    }
    return { uid, gid };
  }
  return null;
}

/**
 * Activation gate (Probe P1 & P14): the Headless Fallback is enabled ONLY when
 * ACP failed its probe (P1 failed) and the stream can verify the active model
 * (P14 passed). Requirements 17.1, 17.10, 45.15, 45.18.
 */
export function isHeadlessFallbackAllowed(gates: {
  p1Passed: boolean;
  p14Passed: boolean;
}): boolean {
  return gates.p1Passed === false && gates.p14Passed === true;
}

export interface HeadlessApprovalDecision {
  approvalId: string | null;
  decision: "approve" | "deny";
}

export type HeadlessTurnStatus =
  | HeadlessExitStatus
  | "refused"
  | "cancelled"
  | "approval_denied"
  | "model_mismatch";

export interface BuildHeadlessArgsOptions {
  prompt: string;
  modelId: string;
  agentName?: string;
  resumeId?: string;
  gatewayToolIds?: readonly string[];
  requireMcpStartup?: boolean;
  approvalDecision?: HeadlessApprovalDecision | null;
}

/**
 * Builds the argv array for one headless turn. The resume turn appends
 * `--resume-id` and carries the approval decision/ID in its prompt.
 * Requirements 17.2, 17.3, 17.6.
 */
export function buildHeadlessArgs(options: BuildHeadlessArgsOptions): string[] {
  const args: string[] = [
    "chat",
    "--v3",
    "--no-interactive",
    "--output-format",
    "stream-json",
    "--model",
    options.modelId,
  ];
  if (options.agentName) {
    args.push("--agent", options.agentName);
  }
  const toolIds = options.gatewayToolIds ?? [];
  // Requirement 17.2: `--require-mcp-startup` is ALWAYS passed.
  args.push("--require-mcp-startup");
  if (toolIds.length > 0) {
    args.push("--trust-tools", toolIds.join(","));
  }
  if (options.resumeId) {
    args.push("--resume-id", options.resumeId);
  }
  args.push("--", options.prompt);
  return args;
}

interface TurnSpawnResult {
  exitCode: number | null;
  records: StreamJsonRecord[];
  rawOutput: string;
  spawnError: Error | null;
  /** Signal that terminated the process, when it was aborted (Requirement 17.8). */
  signal: NodeJS.Signals | string | null;
  /** Disk logging failure recorded while streaming the raw stdout (Requirement 17.4). */
  logError: Error | null;
  /** Every ask auto-denied while this process streamed (Requirement 17.11). */
  autoDeniedAsks: HeadlessAskRequest[];
  /**
   * The failure raised by the required `onAskAutoDeny` hook, when it rejected or
   * threw while streaming an ask. A non-null value means the turn failed closed
   * and the child process was signalled (Requirements 17.11).
   */
  askDenyError: Error | null;
}

export interface HeadlessTurnOptions {
  prompt: string;
  resumeId?: string;
  modelId?: string;
  approvalDecision?: HeadlessApprovalDecision | null;
}

export interface HeadlessTurnResult {
  ok: boolean;
  status: HeadlessTurnStatus;
  reason?: string;
  exitCode: number | null;
  output: string;
  outputDiscarded: boolean;
  records: StreamJsonRecord[];
  activeModel: string | null;
  modelVerified: boolean;
  sessionId: string | null;
  creditsReported: boolean;
  credits: number | null;
  approvals: HeadlessApprovalRequest[];
  autoDeniedAsks: HeadlessAskRequest[];
  logPath: string | null;
  resumed: boolean;
  spawnError: string | null;
  logError: string | null;
}

export interface HeadlessFallbackChannelOptions {
  runId: string;
  skeletonId: string;
  /** Isolated KIRO_HOME for the Skeleton. */
  kiroHomeDir: string;
  /** Isolated HOME for the Skeleton. */
  homeDir: string;
  modelId: string;
  agentName?: string;
  /** Working directory (the Skeleton's worktree). */
  worktreeDir?: string;
  cwd?: string;
  kiroApiKey?: string;
  pathEnv?: string;
  /** Sandbox user the spawned headless process runs as. */
  user?: string;
  /**
   * Resolves a sandbox username to numeric uid/gid for `defaultSpawn`. Defaults
   * to reading `/etc/passwd` on POSIX. Returning `null` (or resolving to a uid
   * the current process may not adopt) fails the turn closed with `spawn_failed`
   * instead of spawning without the requested identity.
   */
  resolveUserIds?: (user: string) => { uid: number; gid: number } | null;
  command?: string;
  spawnFn?: SpawnFunction;
  /** Exact gateway MCP tool IDs passed through `--trust-tools`. */
  gatewayToolIds?: readonly string[];
  requireMcpStartup?: boolean;
  /** Full path of the raw stdout log. Defaults to `<worktreeDir>/headless-stream.jsonl`. */
  logPath?: string;
  /**
   * Trusted base directory the stream log must stay strictly inside (Requirement
   * 17.4). When set, `createStreamDiskLogger` rejects symlinked components and
   * verifies the resolved parent stays within this directory's realpath.
   */
  logTrustedBaseDir?: string;
  /**
   * Whether spike S2 showed `--resume-id` resumes with the workspace intact.
   * When false, every `needs_approval` command is refused outright.
   */
  s2ResumeSupported?: boolean;
  /** Probe P1 result. The channel is enabled only when P1 failed. */
  p1Passed?: boolean;
  /** Probe P14 result. The channel is enabled only when P14 passed. */
  p14Passed?: boolean;
  /** Explicit test flag that disables the P14 model assertion. */
  p14ModelCheckDisabled?: boolean;
  onApproval?: (
    request: HeadlessApprovalRequest
  ) =>
    | HeadlessApprovalDecision["decision"]
    | Promise<HeadlessApprovalDecision["decision"]>;
  /**
   * Requirement 17.11: enforcement hook invoked as soon as an `ask` request is
   * observed, so the Gateway records the auto-denial and never enqueues or waits
   * on a blocking ask while the Headless Fallback is active. Required for a turn
   * to run: the channel never silently skips auto-denial. When the hook is
   * missing or rejects, the turn fails closed and the child process is signalled.
   */
  onAskAutoDeny?: (ask: HeadlessAskRequest) => Promise<void> | void;
  onLog?: (stream: "stdout" | "stderr", text: string) => void;
  maxResumeRounds?: number;
}

const MAX_RESUME_ROUNDS_DEFAULT = 4;

function buildApprovalResumePrompt(decision: HeadlessApprovalDecision): string {
  const id = decision.approvalId ?? "unknown";
  return `Approval ${id} resolved: ${decision.decision}. Continue the task from the current tree state.`;
}

/**
 * Joins the raw stdout captured across the approval-resume rounds of one turn
 * (Requirement 17.5). A single round is returned unchanged so a non-resumed turn
 * keeps its exact raw output. Multiple rounds are joined with a single "\n" after
 * trimming each round's trailing newlines, so every round's output is retained
 * without introducing blank lines between them.
 */
function combineRoundOutput(chunks: readonly string[]): string {
  if (chunks.length === 0) {
    return "";
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  return chunks.map((chunk) => chunk.replace(/\n+$/, "")).join("\n");
}

/**
 * The Headless Fallback execution channel. Refuses every turn when disabled,
 * isolates the environment to the strict four variables, streams stdout through
 * the parser, maps exit codes, verifies the active model, resumes the session
 * with `--resume-id` after an approved interrupt, and auto-denies `ask`.
 */
export class HeadlessFallbackChannel {
  private readonly options: HeadlessFallbackChannelOptions;
  private readonly spawnFn: SpawnFunction;
  private readonly command: string;
  private readonly cwd: string;
  private readonly logPath: string | null;
  private readonly s2ResumeSupported: boolean;
  private readonly maxResumeRounds: number;
  private currentProcess: ChildProcessLike | null = null;
  /** Set when `cancel()` aborts the in-flight turn (Requirement 17.8). */
  private turnCancelled = false;
  /**
   * Wake-up callbacks registered while the turn awaits an approval decision.
   * `cancel()` invokes every one of them so a stalled `onApproval` promise can
   * never leave the turn waiting forever.
   */
  private cancelWaiters: Set<() => void> = new Set();
  /**
   * The unredacted session id reported by the most recent turn. The PUBLIC
   * `HeadlessTurnResult.sessionId` is redacted (Requirement 17.12), but the
   * supervisor must resume `--resume-id` with the REAL CLI session id even when
   * the raw id shares characters with the KIRO_API_KEY. This field is internal
   * only and is never returned to callers.
   */
  private lastRawSessionId: string | null = null;

  constructor(options: HeadlessFallbackChannelOptions) {
    this.options = options;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.command = options.command ?? "kiro-cli";
    this.cwd = options.cwd ?? options.worktreeDir ?? process.cwd();
    this.s2ResumeSupported = options.s2ResumeSupported ?? false;
    this.maxResumeRounds = options.maxResumeRounds ?? MAX_RESUME_ROUNDS_DEFAULT;
    if (options.logPath !== undefined) {
      this.logPath = options.logPath;
    } else if (options.worktreeDir || options.cwd) {
      this.logPath = `${this.cwd}/headless-stream.jsonl`;
    } else {
      this.logPath = null;
    }
  }

  /** True when both the P1 and P14 gates agree the channel may run. */
  public isEnabled(): boolean {
    return isHeadlessFallbackAllowed({
      p1Passed: this.options.p1Passed ?? true,
      p14Passed: this.options.p14Passed ?? false,
    });
  }

  public getCurrentProcess(): ChildProcessLike | null {
    return this.currentProcess;
  }

  /**
   * The unredacted session id reported by the most recent turn, or `null` when
   * no turn has reported one. Used ONLY to build a resume `--resume-id`; the
   * public `HeadlessTurnResult.sessionId` stays redacted (Requirement 17.12).
   */
  public getLastRawSessionId(): string | null {
    return this.lastRawSessionId;
  }

  /** Cancels the in-flight turn. */
  public cancel(): boolean {
    // Latch the cancellation BEFORE checking for a live process. A cancel()
    // issued while an async onApproval await is pending finds no live process
    // (that round already exited), but the pending turn must still be marked
    // cancelled so it finalizes as "cancelled" and never spawns a resume
    // process (Requirement 17.8).
    this.turnCancelled = true;
    // Wake any turn blocked on an approval decision so it can finalize as
    // "cancelled" immediately instead of waiting on an unresolved `onApproval`.
    this.wakeCancelWaiters();
    const proc = this.currentProcess;
    if (!proc) {
      // The pending turn was latched as cancelled; there is no live process to
      // signal and no subsequent spawn may occur.
      return true;
    }
    try {
      return proc.kill("SIGTERM");
    } catch {
      return false;
    }
  }

  /**
   * The explicit secret literals that must be redacted even when they do not match
   * a generic token pattern (Requirement 17.12). The Skeleton's `KIRO_API_KEY` is
   * an arbitrary value, so it is registered directly whenever it carries any
   * non-whitespace content. Both the raw value and its trimmed form are registered
   * so a padded key is scrubbed with or without the surrounding whitespace; a
   * whitespace-only value is never registered (it would otherwise replace every
   * space in the stream).
   */
  private explicitSecretLiterals(): string[] {
    const key = this.options.kiroApiKey;
    if (typeof key !== "string") {
      return [];
    }
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      return [];
    }
    return key === trimmed ? [key] : [key, trimmed];
  }

  /**
   * The redaction options shared by the disk logger and every returned
   * `HeadlessTurnResult` field. Reuses the existing redactor engine (generic token
   * patterns + registered env secrets) and adds the explicit KIRO_API_KEY literal.
   */
  private redactionOptions(): RedactionOptions {
    const secrets = this.explicitSecretLiterals();
    return secrets.length > 0 ? { secrets } : {};
  }

  /**
   * Clones an ask and redacts every string it carries (`askId`, `text`, the raw
   * record including `raw.options`) with the channel's redaction options, so the
   * `onAskAutoDeny` hook and any `ask.auto_denied` event built from it never leak
   * an explicit non-env `kiroApiKey` (Requirement 17.12).
   */
  private redactAskForHook(ask: HeadlessAskRequest): HeadlessAskRequest {
    const options = this.redactionOptions();
    const raw = redactUnknownValue(ask.raw, options);
    return {
      askId: ask.askId === null ? null : redactText(ask.askId, options),
      toolCallId:
        ask.toolCallId === null ? null : redactText(ask.toolCallId, options),
      text: ask.text === null ? null : redactText(ask.text, options),
      raw: (raw ?? {}) as StreamJsonRecord,
    };
  }

  private emptyResult(): HeadlessTurnResult {
    return {
      ok: false,
      status: "failure",
      exitCode: null,
      output: "",
      outputDiscarded: false,
      records: [],
      activeModel: null,
      modelVerified: false,
      sessionId: null,
      creditsReported: false,
      credits: null,
      approvals: [],
      autoDeniedAsks: [],
      logPath: this.logPath,
      resumed: false,
      spawnError: null,
      logError: null,
    };
  }

  private finalize(input: {
    base: HeadlessTurnResult;
    ok: boolean;
    status: HeadlessTurnStatus;
    reason?: string;
    exitCode: number | null;
    output: string;
    outputDiscarded: boolean;
    records: StreamJsonRecord[];
    approvals: HeadlessApprovalRequest[];
    autoDeniedAsks: HeadlessAskRequest[];
    resumed: boolean;
    modelId: string;
    spawnError?: string | null;
    logError?: string | null;
    /**
     * The verification of the SPECIFIC round that failed model verification.
     * When present it is authoritative: a per-round `model_mismatch` must be
     * reported with the offending round's `activeModel` instead of recomputing
     * over the accumulated records, where round 1's model would otherwise win.
     */
    modelVerification?: HeadlessModelVerification;
  }): HeadlessTurnResult {
    const credits = extractHeadlessCredits(input.records);
    const sessionId = extractSessionId(input.records);
    // Retain the RAW (unredacted) session id so a later resume can pass the true
    // CLI session id via `--resume-id` even when it overlaps the API key. Only a
    // turn that actually reported one updates the retained value.
    if (sessionId !== null) {
      this.lastRawSessionId = sessionId;
    }
    // A caller-supplied per-round verification (the offending round) takes
    // precedence; otherwise verify the accumulated records so a turn accepted as
    // success is still defense-in-depth checked here.
    const verification =
      input.modelVerification ??
      verifyHeadlessModel(input.records, input.modelId, {
        modelCheckDisabled: this.options.p14ModelCheckDisabled === true,
      });
    let ok = input.ok;
    let status = input.status;
    let reason = input.reason;
    if (status === "success" && !verification.ok) {
      ok = false;
      status = "model_mismatch";
      reason = "model_mismatch";
    }
    // Preserve an explicit per-round model_mismatch failure: never let the
    // accumulated records (which still hold an earlier round's valid model) turn
    // the turn back into a pass.
    if (verification.ok === false && status === "model_mismatch") {
      ok = false;
      status = "model_mismatch";
      reason = reason ?? "model_mismatch";
    }

    // Requirement 17.12: never return raw secrets from memory. The structural
    // protocol fields (credits, session id, model, approvals, asks) were already
    // parsed from the RAW records above, so redacting here cannot break turn
    // parsing. The raw stdout, every record, and the approval/ask payloads are all
    // passed through the same redactor as the disk logger, plus the explicit
    // KIRO_API_KEY literal (which may not match any generic token pattern).
    const redaction = this.redactionOptions();

    return {
      ok,
      status,
      reason,
      exitCode: input.exitCode,
      output: redactText(input.output, redaction),
      outputDiscarded: input.outputDiscarded,
      records: redactValue(input.records, redaction),
      activeModel: verification.activeModel,
      modelVerified: verification.ok,
      // Requirement 17.12: the extracted session id (and approval
      // ids inside `approvals`) may embed a credential, so the RETURNED metadata
      // is redacted too. `runTurn` keeps resuming from the RAW `extractSessionId`
      // so `--resume-id` stays accurate while the returned value never leaks.
      sessionId: sessionId === null ? null : redactText(sessionId, redaction),
      creditsReported: credits.creditsReported,
      credits: credits.credits,
      approvals: redactValue(input.approvals, redaction),
      autoDeniedAsks: redactValue(input.autoDeniedAsks, redaction),
      logPath: input.base.logPath,
      resumed: input.resumed,
      spawnError: input.spawnError ?? null,
      logError: input.logError ?? null,
    };
  }

  private async requestApproval(
    request: HeadlessApprovalRequest
  ): Promise<HeadlessApprovalDecision["decision"]> {
    if (!this.options.onApproval) {
      return "deny";
    }
    try {
      const decision = await this.options.onApproval(request);
      return decision === "approve" ? "approve" : "deny";
    } catch {
      return "deny";
    }
  }

  /**
   * Removes and invokes every cancellation waiter registered by an in-flight
   * approval await so a stalled `onApproval` promise can never block the turn.
   */
  private wakeCancelWaiters(): void {
    if (this.cancelWaiters.size === 0) {
      return;
    }
    const waiters = Array.from(this.cancelWaiters);
    this.cancelWaiters.clear();
    for (const wake of waiters) {
      try {
        wake();
      } catch {
        // A throwing waiter must not stop the remaining waiters.
      }
    }
  }

  /**
   * Awaits the approval decision for `target`, but resolves the instant `cancel()`
   * runs so an approval that never settles cannot hang the turn. The cancellation
   * waiter is always removed in `finally`, and a cancellation still finalizes the
   * turn as "cancelled" in `runTurn` without spawning a resume process.
   */
  private awaitApprovalOrCancel(
    target: HeadlessApprovalRequest
  ): Promise<HeadlessApprovalDecision["decision"]> {
    let waiter: (() => void) | null = null;
    const cancelled = new Promise<void>((resolve) => {
      waiter = resolve;
      this.cancelWaiters.add(resolve);
    });
    const approval = this.requestApproval(target);
    return Promise.race([
      approval,
      cancelled.then(() => "deny" as const),
    ]).finally(() => {
      if (waiter) {
        this.cancelWaiters.delete(waiter);
      }
    });
  }


  public async runTurn(options: HeadlessTurnOptions): Promise<HeadlessTurnResult> {
    const base = this.emptyResult();
    if (!this.isEnabled()) {
      return {
        ...base,
        ok: false,
        status: "refused",
        reason: "headless_fallback_disabled",
      };
    }

    const modelId = options.modelId ?? this.options.modelId;
    // Requirement 17.11: auto-denial is REQUIRED and is
    // enforced from live streaming. Production code never silently skips it: a
    // missing hook fails closed before any process is spawned.
    if (typeof this.options.onAskAutoDeny !== "function") {
      return this.finalize({
        base,
        ok: false,
        status: "failure",
        reason: "ask_auto_deny_failed",
        exitCode: null,
        output: "",
        outputDiscarded: false,
        records: [],
        approvals: [],
        autoDeniedAsks: [],
        resumed: false,
        modelId,
        spawnError: "onAskAutoDeny is required and must be a function",
      });
    }
    const records: StreamJsonRecord[] = [];
    const approvals: HeadlessApprovalRequest[] = [];
    const autoDeniedAsks: HeadlessAskRequest[] = [];
    let resumed = false;
    // Reset the per-turn cancellation flag.
    this.turnCancelled = false;
    // Requirement 17.6: when the caller resumes with an approval decision, the
    // resumed session must receive the approval ID and decision in its prompt.
    let currentPrompt = options.prompt;
    if (options.approvalDecision) {
      currentPrompt = `${options.prompt}\n\n${buildApprovalResumePrompt(
        options.approvalDecision
      )}`;
    }
    let currentResumeId = options.resumeId;
    let approvalDecision = options.approvalDecision ?? null;
    // Requirement 17.5: retain the raw stdout of every approval-resume round so
    // pre-approval output from an earlier round is not lost when the session is
    // resumed with `--resume-id`.
    let outputChunks: string[] = [];
    let output = "";
    let outputDiscarded = false;
    let exitCode: number | null = null;

    for (let round = 0; round <= this.maxResumeRounds; round += 1) {
      const spawnResult = await this.spawnTurn({
        prompt: currentPrompt,
        modelId,
        resumeId: currentResumeId,
        approvalDecision,
      });

      records.push(...spawnResult.records);
      exitCode = spawnResult.exitCode;
      // Requirement 17.11: asks observed DURING live streaming are recorded here.
      autoDeniedAsks.push(...spawnResult.autoDeniedAsks);
      if (spawnResult.rawOutput.length > 0) {
        outputChunks.push(spawnResult.rawOutput);
      }
      output = combineRoundOutput(outputChunks);

      // Requirement 17.9: exit code 4 (missing agent) invalidates the stream, so
      // the output is discarded BEFORE any return path settles, including the
      // auto-deny failure and cancellation paths handled below.
      if (exitCode === 4) {
        outputChunks = [];
        output = "";
        outputDiscarded = true;
      }

      if (spawnResult.spawnError) {
        return this.finalize({
          base,
          ok: false,
          status: "failure",
          reason: "spawn_failed",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
          // Requirement 17.8: preserve the spawn error message.
          spawnError: spawnResult.spawnError.message,
        });
      }

      // A rejected/thrown `onAskAutoDeny` (observed during
      // live streaming) fails the turn closed. The child process was already
      // signalled inside `spawnTurn`; the ask is never treated as safely handled.
      if (spawnResult.askDenyError) {
        return this.finalize({
          base,
          ok: false,
          status: "failure",
          reason: "ask_auto_deny_failed",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
          spawnError: spawnResult.askDenyError.message,
        });
      }

      // Requirement 17.8: a cancel()/signal abort reports "cancelled" instead of
      // mapping the SIGTERM exit code to "failure".
      if (this.turnCancelled || spawnResult.signal !== null) {
        return this.finalize({
          base,
          ok: false,
          status: "cancelled",
          reason: "cancelled",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
        });
      }

      // Requirement 17.4: fail the turn when the raw stdout could not be logged.
      if (spawnResult.logError) {
        return this.finalize({
          base,
          ok: false,
          status: "failure",
          reason: "stream_log_write_failed",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
          logError: spawnResult.logError.message,
        });
      }

      const mapping = mapHeadlessExitCode(exitCode);
      if (!mapping.ok) {
        if (mapping.discardOutput) {
          // Requirement 17.9 / 17.5: discard output after a missing agent exit
          // (4), including every accumulated approval-resume round.
          outputChunks = [];
          output = "";
          outputDiscarded = true;
        }
        return this.finalize({
          base,
          ok: false,
          status: mapping.status,
          reason: mapping.status,
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
        });
      }

      // Verify the model reported by THIS round alone, before its output is
      // accepted or its approval is acted upon (Requirement 17.10, 45.18). A
      // resumed (`--resume-id`) round that reports a different model or omits
      // model reporting must fail closed rather than inherit round 1's model.
      // Only reached after `mapHeadlessExitCode` accepted exit code 0, so a
      // non-zero exit keeps its existing exit-code failure behavior.
      const roundVerification = verifyHeadlessModel(spawnResult.records, modelId, {
        modelCheckDisabled: this.options.p14ModelCheckDisabled === true,
      });
      if (!roundVerification.ok) {
        return this.finalize({
          base,
          ok: false,
          status: "model_mismatch",
          reason: "model_mismatch",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
          modelVerification: roundVerification,
        });
      }

      const roundApprovals = extractApprovalRequests(spawnResult.records);
      if (roundApprovals.length === 0) {
        return this.finalize({
          base,
          ok: true,
          status: "success",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
        });
      }

      approvals.push(...roundApprovals);

      // Requirement 17.7: an S2 failure refuses every needs_approval outright.
      if (!this.s2ResumeSupported) {
        return this.finalize({
          base,
          ok: false,
          status: "refused",
          reason: "approval_resume_unsupported",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
        });
      }

      const target = roundApprovals[0];
      const decision = await this.awaitApprovalOrCancel(target);

      // Requirement 17.8: a cancel() issued while the approval decision was
      // pending must finalize as "cancelled" and must NEVER spawn a resume
      // process or deny the approval after the fact.
      if (this.turnCancelled) {
        return this.finalize({
          base,
          ok: false,
          status: "cancelled",
          reason: "cancelled",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
        });
      }

      if (decision !== "approve") {
        return this.finalize({
          base,
          ok: false,
          status: "approval_denied",
          reason: "approval_denied",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
        });
      }

      // Requirement 17.6: resume the session with --resume-id,
      // passing the approval decision/ID in the resumed prompt. A missing session
      // id must NEVER spawn a fresh process without --resume-id: fail closed.
      const nextResumeId =
        extractSessionId(spawnResult.records) ?? currentResumeId;
      if (!nextResumeId || !nextResumeId.trim()) {
        return this.finalize({
          base,
          ok: false,
          status: "failure",
          reason: "missing_resume_id",
          exitCode,
          output,
          outputDiscarded,
          records,
          approvals,
          autoDeniedAsks,
          resumed,
          modelId,
          spawnError:
            "cannot resume the approved session: no session id was reported",
        });
      }
      approvalDecision = { approvalId: target.approvalId, decision: "approve" };
      currentPrompt = buildApprovalResumePrompt(approvalDecision);
      currentResumeId = nextResumeId;
      resumed = true;
    }

    return this.finalize({
      base,
      ok: false,
      status: "failure",
      reason: "resume_round_limit",
      exitCode,
      output,
      outputDiscarded,
      records,
      approvals,
      autoDeniedAsks,
      resumed,
      modelId,
    });
  }


  private spawnTurn(input: {
    prompt: string;
    modelId: string;
    resumeId?: string;
    approvalDecision?: HeadlessApprovalDecision | null;
  }): Promise<TurnSpawnResult> {
    const args = buildHeadlessArgs({
      prompt: input.prompt,
      modelId: input.modelId,
      agentName: this.options.agentName,
      resumeId: input.resumeId,
      gatewayToolIds: this.options.gatewayToolIds,
      requireMcpStartup: this.options.requireMcpStartup,
      approvalDecision: input.approvalDecision,
    });

    // Requirement 16.2 / 17.2: exactly KIRO_API_KEY, KIRO_HOME, HOME and PATH.
    const env = buildSkeletonEnv({
      kiroApiKey: this.options.kiroApiKey,
      kiroHome: this.options.kiroHomeDir,
      home: this.options.homeDir,
      pathEnv: this.options.pathEnv,
    });

    return new Promise<TurnSpawnResult>((resolve) => {
      // Only the built-in spawn can adopt a sandbox identity; a caller-injected
      // spawnFn keeps receiving `user` verbatim so test/custom sandbox adapters
      // and the existing `user` contract keep working (Requirement 16.2).
      const usingDefaultSpawn = this.spawnFn === defaultSpawn;
      const spawnOptions: SpawnOptions = {
        cwd: this.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (usingDefaultSpawn && this.options.user) {
        const requestedUser = this.options.user;
        let currentUsername: string | null = null;
        try {
          currentUsername = os.userInfo().username;
        } catch {
          currentUsername = null;
        }
        if (currentUsername === requestedUser) {
          // Already running as the requested user: spawn normally.
        } else if (process.platform === "win32") {
          // win32 cannot switch users; fail closed without spawning.
          resolve({
            exitCode: null,
            records: [],
            rawOutput: "",
            spawnError: new Error(
              `Cannot switch to sandbox user "${requestedUser}" on win32`
            ),
            signal: null,
            logError: null,
            autoDeniedAsks: [],
            askDenyError: null,
          });
          return;
        } else {
          const resolved = (this.options.resolveUserIds ?? defaultResolveUserIds)(
            requestedUser
          );
          const currentUid =
            typeof process.getuid === "function" ? process.getuid() : null;
          if (
            resolved === null ||
            (currentUid !== null &&
              currentUid !== 0 &&
              currentUid !== resolved.uid)
          ) {
            // Unresolvable user or lacking privilege: fail closed without
            // spawning rather than running as the wrong identity.
            resolve({
              exitCode: null,
              records: [],
              rawOutput: "",
              spawnError: new Error(
                `Cannot switch to sandbox user "${requestedUser}": the requested uid/gid could not be adopted`
              ),
              signal: null,
              logError: null,
              autoDeniedAsks: [],
              askDenyError: null,
            });
            return;
          }
          spawnOptions.uid = resolved.uid;
          spawnOptions.gid = resolved.gid;
        }
      } else if (this.options.spawnFn !== undefined && this.options.user) {
        // A custom/test spawnFn keeps receiving the user name as before.
        spawnOptions.user = this.options.user;
      }

      let proc: ChildProcessLike;
      try {
        proc = this.spawnFn(this.command, args, spawnOptions);
      } catch (err) {
        resolve({
          exitCode: null,
          records: [],
          rawOutput: "",
          spawnError: err as Error,
          signal: null,
          logError: null,
          autoDeniedAsks: [],
          askDenyError: null,
        });
        return;
      }
      this.currentProcess = proc;

      let buffer = "";
      let rawOutput = "";
      const records: StreamJsonRecord[] = [];
      let settled = false;
      let closing = false;
      const autoDeniedAsks: HeadlessAskRequest[] = [];
      const pendingAskDenies: Promise<void>[] = [];
      let askDenyError: Error | null = null;
      // Requirement 17.4: write the raw stream to disk before parsing it, with
      // generic token patterns AND the explicit KIRO_API_KEY literal scrubbed.
      const logger = this.logPath
        ? createStreamDiskLogger(this.logPath, {
            secrets: this.explicitSecretLiterals(),
            ...(this.options.logTrustedBaseDir
              ? { trustedBaseDir: this.options.logTrustedBaseDir }
              : {}),
          })
        : null;

      // Fail closed the instant a required auto-deny hook
      // rejects. The child process is signalled with SIGTERM, further records stop
      // parsing, and the turn only settles once the child has actually exited
      // (close/exit) so the caller never resolves before the process is gone.
      const settleAskDenyFailure = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          // Ignore a failed kill; the turn still fails closed.
        }
        const finalize = (): void => {
          const logError = logger?.getLastError() ?? null;
          logger?.close();
          this.currentProcess = null;
          resolve({
            exitCode: proc.exitCode ?? null,
            records,
            rawOutput,
            spawnError: null,
            signal: null,
            logError,
            autoDeniedAsks,
            askDenyError: err,
          });
        };
        // Already exited: settle immediately.
        if (proc.exitCode !== null) {
          finalize();
          return;
        }
        let done = false;
        const onCloseOrExit = (): void => {
          if (done) {
            return;
          }
          done = true;
          finalize();
        };
        proc.once("close", onCloseOrExit);
        proc.once("exit", onCloseOrExit);
      };

      const consumeLine = (line: string): void => {
        // Once the turn has settled (cancelled, denied, killed, or resolved) no
        // further records are parsed and no further ask hook is invoked.
        if (settled) {
          return;
        }
        if (line.trim().length === 0) {
          return;
        }
        const record = parseStreamJsonLine(line);
        if (record !== null) {
          records.push(record);
          // Requirement 17.11: auto-deny each `ask` the moment it arrives on the
          // live stream, BEFORE the process exits, so a blocking `ask` can never
          // stall the turn. An ask is reported as auto-denied only AFTER the
          // required hook resolves without error; a rejected/thrown hook fails the
          // turn closed and the ask is never treated as handled.
          for (const ask of extractAskRequests([record])) {
            if (settled) {
              break;
            }
            const hook = this.options.onAskAutoDeny;
            // Requirement 17.12: redact the ask BEFORE it reaches the hook so any
            // event the hook records (ask.auto_denied) can never carry an explicit
            // credential embedded in the ask text, id, or raw options.
            const redactedAsk = this.redactAskForHook(ask);
            let denial: Promise<void>;
            try {
              // `runTurn` refuses to spawn without the hook, so it is defined here.
              denial = Promise.resolve(hook!(redactedAsk));
            } catch (err) {
              denial = Promise.reject(err);
            }
            const tracked = denial.then(
              () => {
                // Never report an ask whose turn already failed or settled while
                // its denial was still in flight.
                if (!settled) {
                  autoDeniedAsks.push(redactedAsk);
                }
              },
              (err: unknown) => {
                const failure =
                  err instanceof Error ? err : new Error(String(err));
                if (!askDenyError) {
                  askDenyError = failure;
                  settleAskDenyFailure(failure);
                }
              }
            );
            pendingAskDenies.push(tracked);
          }
        }
      };

      // Requirement 17.12: a StringDecoder keeps a multi-byte UTF-8 sequence that is
      // split across two `data` chunks intact. Decoding each chunk with
      // `chunk.toString("utf-8")` instead corrupts the split character into
      // `\uFFFD` in the raw output, the disk log and every parsed record.
      const stdoutDecoder = new StringDecoder("utf-8");
      let stdoutDecoderFlushed = false;
      const appendStdoutText = (text: string): void => {
        if (text.length === 0) {
          return;
        }
        rawOutput += text;
        buffer += text;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          logger?.appendLine(line);
          consumeLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      };

      // Flush the decoder's held-back partial sequence exactly once, before the turn
      // resolves, so a trailing multi-byte character is neither dropped nor emitted
      // as `\uFFFD`.
      const flushStdoutDecoder = (): void => {
        if (stdoutDecoderFlushed) {
          return;
        }
        stdoutDecoderFlushed = true;
        appendStdoutText(stdoutDecoder.end());
      };

      // Requirement 17.12: stderr is assembled across `data` chunks BEFORE it is
      // matched, so a credential split across two chunks can never slip through as
      // two individually-unmatchable halves. A StringDecoder keeps a multi-byte
      // UTF-8 sequence that is split across chunks intact.
      const stderrDecoder = new StringDecoder("utf-8");
      let stderrBuffer = "";
      let stderrFlushed = false;
      const stderrSecrets = this.explicitSecretLiterals();
      const maxSecretLen = stderrSecrets.reduce(
        (max, secret) => Math.max(max, secret.length),
        0
      );
      // Overlap retained when a newline-free stream exceeds the memory cap, sized to
      // exceed the longest secret so any token spanning the flush boundary is held
      // back whole rather than split into two individually-unmatchable halves.
      const overlapLen = Math.max(256, maxSecretLen + 32);
      const STDERR_BUFFER_LIMIT = 65536;
      const REDACTION_MARKER = DEFAULT_REDACTION_MASK;

      const emitStderr = (text: string): void => {
        if (text.length === 0) {
          return;
        }
        // Never forward a raw token/key to the onLog sink: every emitted segment is
        // scrubbed through the same redactor (generic token patterns + the explicit
        // KIRO_API_KEY literal) before it reaches the caller.
        this.options.onLog?.("stderr", redactText(text, this.redactionOptions()));
      };

      // Redact and emit whatever is left in the buffer, exactly once (guarded so the
      // `end` handler and `close`/`finish` cannot double-emit a trailing line).
      const flushStderr = (): void => {
        if (stderrFlushed) {
          return;
        }
        stderrFlushed = true;
        const remainder = stderrDecoder.end();
        if (remainder.length > 0) {
          stderrBuffer += remainder;
        }
        if (stderrBuffer.length > 0) {
          emitStderr(stderrBuffer);
          stderrBuffer = "";
        }
      };

      const finish = (code: number | null): void => {
        if (settled || closing) {
          return;
        }
        closing = true;
        // Flush any multi-byte sequence the stdout decoder is still holding BEFORE
        // draining the residual buffer, so a split character is reconstructed rather
        // than dropped or replaced with `\uFFFD`.
        flushStdoutDecoder();
        // Requirement 17.12: flush any buffered stderr BEFORE resolving the turn so
        // a credential split across the final chunks is still redacted, not dropped.
        flushStderr();
        if (buffer.length > 0) {
          logger?.appendLine(buffer);
          consumeLine(buffer);
          buffer = "";
        }
        // Serialize/await every pending auto-deny promise
        // BEFORE finalizing. A rejected hook that was observed while streaming
        // fails the turn closed instead of being silently swallowed.
        void Promise.all(pendingAskDenies).then(() => {
          if (settled) {
            return;
          }
          if (askDenyError) {
            settleAskDenyFailure(askDenyError);
            return;
          }
          settled = true;
          const logError = logger?.getLastError() ?? null;
          logger?.close();
          this.currentProcess = null;
          resolve({
            exitCode: code,
            records,
            rawOutput,
            spawnError: null,
            signal: proc.signalCode ?? null,
            logError,
            autoDeniedAsks,
            askDenyError: null,
          });
        });
      };

      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer | string) => {
          // Decode through the shared StringDecoder so a multi-byte UTF-8 character
          // split across two `data` chunks is reassembled intact instead of becoming
          // `\uFFFD`.
          const text =
            typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
          appendStdoutText(text);
        });
        proc.stdout.on("end", () => {
          // Flush any held-back partial sequence. The turn settles strictly on the
          // process "close" event, which fires after every stdout and stderr chunk
          // has been drained.
          flushStdoutDecoder();
        });
      }
      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer | string) => {
          // Requirement 17.12: accumulate across chunks before matching. Redacting
          // each raw chunk independently would leak both halves of a credential that
          // is split across two `data` events (neither half matches on its own).
          const chunkBuffer =
            typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
          stderrBuffer += stderrDecoder.write(chunkBuffer);
          // Emit only complete lines (newline preserved) once the whole line has been
          // assembled, so a token split across chunks is matched and scrubbed first.
          let stderrNewlineIndex = stderrBuffer.indexOf("\n");
          while (stderrNewlineIndex >= 0) {
            const stderrLine = stderrBuffer.slice(0, stderrNewlineIndex + 1);
            stderrBuffer = stderrBuffer.slice(stderrNewlineIndex + 1);
            emitStderr(stderrLine);
            stderrNewlineIndex = stderrBuffer.indexOf("\n");
          }
          // Protect memory on a newline-free huge stream: emit the prefix but keep an
          // overlap tail so any secret spanning the flush boundary is not split before
          // it can be matched.
          if (stderrBuffer.length > STDERR_BUFFER_LIMIT) {
            // Redact the WHOLE buffer FIRST so a secret spanning the eventual cut is
            // matched and replaced before any slice is emitted. Slicing first would
            // split a straddling secret into two incomplete halves, neither of which
            // matches on its own, leaking the leading fragment unredacted.
            const redacted = redactText(stderrBuffer, this.redactionOptions());
            let safeCut = Math.max(0, redacted.length - overlapLen);
            // Never slice through a "[REDACTED]" marker: if the boundary lands
            // strictly inside one, advance to just past its end so every emitted
            // segment carries only whole markers.
            const markerStart = redacted.lastIndexOf(
              REDACTION_MARKER,
              safeCut + 10
            );
            if (
              markerStart >= 0 &&
              markerStart < safeCut &&
              safeCut < markerStart + REDACTION_MARKER.length
            ) {
              safeCut = markerStart + REDACTION_MARKER.length;
            }
            const prefix = redacted.slice(0, safeCut);
            stderrBuffer = redacted.slice(safeCut);
            // `prefix` is already fully redacted; emit it directly instead of
            // re-running the redactor over the whole segment a second time.
            if (prefix.length > 0) {
              this.options.onLog?.("stderr", prefix);
            }
          }
        });
        proc.stderr.on("end", () => {
          // Flush a trailing line that was never newline-terminated.
          flushStderr();
        });
      }

      proc.on("error", (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        const logError = logger?.getLastError() ?? null;
        logger?.close();
        this.currentProcess = null;
        resolve({
          exitCode: proc.exitCode ?? null,
          records,
          rawOutput,
          spawnError: err,
          signal: null,
          logError,
          autoDeniedAsks,
          askDenyError,
        });
      });
      // Requirement 17.4/17.8: resolve strictly on "close" so every buffered
      // stdout/stderr NDJSON chunk is fully drained before parsing; the "exit"
      // event is intentionally NOT used (it can fire before "close").
      proc.on("close", (code: number | null) => finish(code));
    });
  }


}

/**
 * Event payload for an auto-denied headless `ask`. Reads only the REAL
 * `HeadlessAskRequest` fields (`askId`, `text`) plus an `options` list taken
 * safely from the raw stream record, so a caller never has to reach into a
 * non-existent `question` property.
 */
export type AskAutoDeniedEventData = {
  askId: string | null;
  question: string | null;
  text: string | null;
  options: unknown;
};

/**
 * Recursively redacts every string in an arbitrary value (array/nested object)
 * with `redactText`, leaving non-string primitives untouched. Used so an
 * `ask.auto_denied` payload can never carry an explicit credential embedded in
 * the ask text or its `options` list (Requirement 17.12).
 */
function redactUnknownValue(
  value: unknown,
  redactionOptions?: RedactionOptions
): unknown {
  if (typeof value === "string") {
    return redactText(value, redactionOptions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknownValue(item, redactionOptions));
  }
  if (value !== null && typeof value === "object") {
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(value))
    ) {
      return value;
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactUnknownValue(entry, redactionOptions);
    }
    return result;
  }
  return value;
}

/**
 * Builds the `ask.auto_denied` event data from a real `HeadlessAskRequest`.
 * The question text is the request's `text`; `options` is read defensively from
 * `ask.raw` (only when the raw record actually carries an `options` field).
 * Every string is passed through the redactor before it is returned so an
 * explicit credential in the ask text or options can never leak.
 */
export function buildAskAutoDeniedEventData(
  ask: HeadlessAskRequest,
  redactionOptions?: RedactionOptions
): AskAutoDeniedEventData {
  let options: unknown = null;
  const raw = ask.raw as unknown;
  if (raw !== null && typeof raw === "object" && "options" in raw) {
    options = (raw as Record<string, unknown>).options ?? null;
  }
  const text = ask.text ?? null;
  const redactedText = text === null ? null : redactText(text, redactionOptions);
  return {
    askId:
      ask.askId === null ? null : redactText(ask.askId, redactionOptions),
    question: redactedText,
    text: redactedText,
    options: redactUnknownValue(options, redactionOptions),
  };
}

