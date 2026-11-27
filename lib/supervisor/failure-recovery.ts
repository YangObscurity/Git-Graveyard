// Task 23.3: Supervisor failure recovery, crash handling, quarantine and nudges.
// Requirements: 15.1-15.6, 16.16, 22.14, 22.15, 41.5, 41.6, 41.20, 41.23.

import * as fs from "node:fs";
import * as path from "node:path";

import type { EventEnvelope } from "../events/event-store";
import { type EventStore } from "../events/event-store";
import type { RunStore } from "../runs/run-store";
import { redactEventData, type Redactor, type RedactionOptions } from "../security/redactor";
import {
  verifySessionModel,
  type ModelVerificationResult,
  type SkeletonRole,
} from "./model-allowlist";

export const SECURITY_CONTAINMENT_EVENT_KIND = "security.containment";

/**
 * Fail-closed redaction helper: replaces every string leaf value with the
 * redaction mask. Used when a caller-supplied redactor throws so no partial,
 * unredacted data can ever be returned. Arrays and objects are both tracked in
 * `seen`, and any already-seen value collapses to the mask, so cyclic structures
 * can never recurse infinitely or leak original references.
 */
export function redactAllStringLeaves(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof value === "string") {
    return "[REDACTED]";
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[REDACTED]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => redactAllStringLeaves(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactAllStringLeaves(item, seen);
    }
    return out;
  }
  return value;
}

export type PrePromptBlockReason = "model_mismatch" | "gateway_missing";

export interface PrePromptInvariantsInput {
  readonly role: SkeletonRole | string;
  readonly activeModel: unknown;
  readonly hard?: boolean | string | null;
  readonly runId?: string;
  readonly skeletonId?: string;
  readonly checkGateway?: () => boolean | Promise<boolean>;
}

export interface PrePromptInvariantsResult {
  readonly ok: boolean;
  readonly canPrompt: boolean;
  readonly role: SkeletonRole | string;
  readonly reason?: PrePromptBlockReason;
  readonly error?: string;
  readonly modelVerification?: ModelVerificationResult;
  readonly gatewayConnected?: boolean;
}

export interface ProcessCrashInput {
  readonly runId: string;
  readonly skeletonId: string;
  readonly role?: string;
  readonly reason?: "crash" | "broken_pipe" | string;
  readonly worktreeDir?: string;
  readonly logRef?: string;
  readonly sessionId?: string;
  readonly crashCount?: number;
  readonly loadSession?: (params: {
    runId: string;
    skeletonId: string;
    sessionId?: string;
  }) => boolean | Promise<boolean>;
}

/**
 * Descriptive failure message emitted whenever a crashed Skeleton could not be
 * respawned: `loadSession` returned false, threw, or the crash budget was already
 * exhausted. The worktree and log are always preserved for a fresh attempt.
 */
export const RESPAWN_FAILED_MESSAGE =
  "Respawn failed: the session could not be resumed; kept the worktree and log";

export type RespawnMessage =
  | "Resumed the same session"
  | "Restarted from its last commit"
  | typeof RESPAWN_FAILED_MESSAGE;

export interface ProcessCrashResult {
  readonly runId: string;
  readonly skeletonId: string;
  readonly status: "recovering" | "failed";
  readonly respawned: boolean;
  readonly respawnMessage: RespawnMessage;
  readonly preservedWorktree: string | null;
  readonly logRef: string | null;
  readonly promptResent: false;
  readonly sessionLoaded: boolean;
  readonly attempts: number;
  readonly recoveringEvent: EventEnvelope | null;
  readonly failedEvent: EventEnvelope | null;
}

export interface FailureRecoverySettings {
  readonly silenceThresholdMs?: number;
  readonly maxWardenRejectionRounds?: number;
}

const DEFAULT_SILENCE_THRESHOLD_MS = 120000;
const DEFAULT_MAX_WARDEN_REJECTION_ROUNDS = 3;

export interface PactTaskLike {
  readonly id: string;
  readonly state?: string;
  readonly blocked?: boolean;
  readonly blockedBy?: readonly string[];
  readonly deps?: readonly string[];
}

export interface MaxRejectionsInput {
  readonly runId: string;
  readonly taskId: string;
  readonly rejectionRounds: number;
  readonly maxRounds?: number;
  readonly pactTasks?: readonly PactTaskLike[];
}

export interface MaxRejectionsResult {
  readonly runId: string;
  readonly taskId: string;
  readonly skipped: boolean;
  readonly state: string;
  readonly dispatched: string[];
  readonly remaining: string[];
}

export interface SilenceNudgeInput {
  readonly runId: string;
  readonly skeletonId?: string;
  readonly silentDurationMs: number;
  readonly thresholdMs?: number;
}

export interface SilenceNudgeResult {
  readonly runId: string;
  readonly nudged: boolean;
  readonly silentDurationMs: number;
  readonly thresholdMs: number;
  readonly event: EventEnvelope | null;
}

/**
 * Structured silence-nudge message. The field names mirror a `message.sent`
 * event so a handler-issued nudge is indistinguishable from a MessageService
 * nudge at the event layer.
 */
export interface SilenceNudgeMessage {
  readonly runId: string;
  readonly msgId: string;
  readonly from: "necromancer";
  readonly to: string;
  readonly skeletonId?: string;
  readonly intent: "nudge";
  readonly text: string;
  readonly nudge: true;
  readonly refs: readonly string[];
}

export interface SilenceNudgeMessageService {
  send(message: {
    runId: string;
    from: "necromancer";
    to: string;
    skeletonId?: string;
    intent: "nudge";
    text: string;
    refs: readonly string[];
  }): unknown;
}

export type QuarantineReason = "secret_detected" | "symlink_escape";

export interface QuarantineWorktreeInput {
  readonly runId: string;
  readonly skeletonId?: string;
  readonly worktreeDir?: string;
  readonly reason: QuarantineReason;
  readonly detail?: string;
  readonly quarantineRoot?: string;
}

export interface QuarantineWorktreeResult {
  readonly runId: string;
  readonly quarantined: true;
  readonly isolated: boolean;
  readonly mergeBlocked: true;
  readonly reason: QuarantineReason;
  readonly worktreeDir: string | null;
  readonly event: EventEnvelope | null;
}

export interface BrokerWatchdogTimeoutInput {
  readonly runId: string;
  readonly skeletonId?: string;
  readonly role?: string;
  readonly capability?: string;
  readonly target?: string;
  readonly toolCallId?: string;
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly watchdogLimitMs?: number;
}

export interface BrokerWatchdogTimeoutResult {
  readonly runId: string;
  readonly logged: true;
  readonly event: EventEnvelope | null;
}

export interface FailureRecoveryDeps {
  readonly eventStore: EventStore;
  readonly runStore?: RunStore;
  readonly redactor?: Redactor;
  readonly redactionOptions?: RedactionOptions;
  readonly settings?: FailureRecoverySettings;
  readonly quarantineRoot?: string;
  readonly stopProcess?: (params: {
    readonly runId: string;
    readonly skeletonId?: string;
    readonly worktreeDir?: string;
    readonly reason: QuarantineReason;
  }) => boolean | void;
  /**
   * Optional override for the recursive read-only containment pass. When supplied
   * it replaces the built-in pass, letting a caller (or test) exercise the
   * post-rename containment failure path deterministically.
   */
  readonly readOnlyPass?: (root: string) => void;
  /**
   * Optional silence-nudge delivery hook. When supplied the hook is responsible
   * for delivering the nudge; a throw or an explicit `false` reports
   * `nudged: false` and records no `message.sent` event.
   */
  readonly deliverNudge?: (message: SilenceNudgeMessage) => boolean | void;
  /**
   * Optional silence-nudge delivery service (e.g. the MessageService). When
   * supplied it replaces the direct `message.sent` append; a throw or an explicit
   * `false` reports `nudged: false`.
   */
  readonly messageService?: SilenceNudgeMessageService;
  readonly now?: () => number;
}

/**
 * Coordinates supervisor failure recovery: pre-prompt invariant verification,
 * kiro-cli crash handling, Warden rejection overflow, silence nudges, worktree
 * quarantine and PermissionBroker watchdog timeouts.
 */
export class FailureRecoveryHandler {
  private readonly deps: FailureRecoveryDeps;
  private readonly quarantinedWorktrees = new Set<string>();
  private readonly blockedMerges = new Set<string>();

  constructor(deps: FailureRecoveryDeps) {
    if (!deps || !deps.eventStore) {
      throw new TypeError("FailureRecoveryHandler requires an eventStore");
    }
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private redact(data: Record<string, unknown>): Record<string, unknown> {
    const byOptions = redactEventData(data, this.deps.redactionOptions);
    const redactor = this.deps.redactor;
    if (!redactor || typeof redactor.redactEventData !== "function") {
      return byOptions;
    }
    try {
      return redactor.redactEventData(byOptions);
    } catch {
      // Fail closed: if the injected redactor throws, redact every string leaf
      // rather than returning partially redacted data.
      return redactAllStringLeaves(byOptions) as Record<string, unknown>;
    }
  }

  /**
   * Verifies the active model against the role tier and the MCP gateway before a
   * prompt is sent. Fails closed with a structured model_mismatch or
   * gateway_missing result.
   */
  async verifyPrePromptInvariants(
    input: PrePromptInvariantsInput
  ): Promise<PrePromptInvariantsResult> {
    const modelVerification = verifySessionModel(input.activeModel, input.role, {
      hard: input.hard,
    });

    if (!modelVerification.ok) {
      return {
        ok: false,
        canPrompt: false,
        role: input.role,
        reason: "model_mismatch",
        error: modelVerification.error,
        modelVerification,
      };
    }

    let gatewayConnected = false;
    if (typeof input.checkGateway === "function") {
      try {
        gatewayConnected = (await input.checkGateway()) === true;
      } catch {
        gatewayConnected = false;
      }
    }

    if (!gatewayConnected) {
      return {
        ok: false,
        canPrompt: false,
        role: input.role,
        reason: "gateway_missing",
        error:
          "gateway_missing: MCP gateway connectivity check failed before sending the prompt",
        modelVerification,
        gatewayConnected: false,
      };
    }

    return {
      ok: true,
      canPrompt: true,
      role: input.role,
      modelVerification,
      gatewayConnected: true,
    };
  }

  /**
   * Handles a kiro-cli crash or broken pipe: preserves the candidate worktree and
   * log references, records the Recovering state, and respawns at most once via
   * session/load without re-transmitting the prompt.
   */
  async handleProcessCrash(input: ProcessCrashInput): Promise<ProcessCrashResult> {
    const preservedWorktree = input.worktreeDir ?? null;
    const logRef = input.logRef ?? null;
    const crashCount = input.crashCount ?? 0;

    const appendFailed = (): EventEnvelope =>
      this.deps.eventStore.append({
        runId: input.runId,
        kind: "skeleton.state",
        actor: "FailureRecoveryHandler",
        skeletonId: input.skeletonId,
        data: this.redact({
          state: "failed",
          skeletonId: input.skeletonId,
          role: input.role ?? null,
          reason: input.reason ?? "crash",
          worktree: preservedWorktree,
          logRef,
          terminal: true,
          attempts: 1,
          refs: [],
        }),
      });

    // When the crash budget is exhausted, the terminal failed state is emitted
    // directly: no intermediate `recovering` state is recorded first.
    if (crashCount >= 1) {
      return {
        runId: input.runId,
        skeletonId: input.skeletonId,
        status: "failed",
        respawned: false,
        respawnMessage: RESPAWN_FAILED_MESSAGE,
        preservedWorktree,
        logRef,
        promptResent: false,
        sessionLoaded: false,
        attempts: 1,
        recoveringEvent: null,
        failedEvent: appendFailed(),
      };
    }

    const recoveringEvent = this.deps.eventStore.append({
      runId: input.runId,
      kind: "skeleton.state",
      actor: "FailureRecoveryHandler",
      skeletonId: input.skeletonId,
      data: this.redact({
        state: "recovering",
        skeletonId: input.skeletonId,
        role: input.role ?? null,
        reason: input.reason ?? "crash",
        worktree: preservedWorktree,
        logRef,
        refs: [],
      }),
    });

    const base = {
      runId: input.runId,
      skeletonId: input.skeletonId,
      preservedWorktree,
      logRef,
      promptResent: false as const,
      recoveringEvent,
    };

    let sessionLoaded = false;
    if (input.loadSession) {
      try {
        sessionLoaded =
          (await input.loadSession({
            runId: input.runId,
            skeletonId: input.skeletonId,
            sessionId: input.sessionId,
          })) === true;
      } catch {
        sessionLoaded = false;
      }
    }

    if (sessionLoaded) {
      return {
        ...base,
        status: "recovering",
        respawned: true,
        respawnMessage: "Resumed the same session",
        sessionLoaded: true,
        attempts: 1,
        failedEvent: null,
      };
    }

    return {
      ...base,
      status: "failed",
      respawned: false,
      respawnMessage: RESPAWN_FAILED_MESSAGE,
      sessionLoaded: false,
      attempts: 1,
      failedEvent: appendFailed(),
    };
  }

  /**
   * Marks a task that reached the maximum Warden rejection rounds as skipped and
   * reports the open, non-blocked Pact tasks that can continue dispatching.
   */
  handleMaxWardenRejections(input: MaxRejectionsInput): MaxRejectionsResult {
    const maxRounds =
      input.maxRounds ??
      this.deps.settings?.maxWardenRejectionRounds ??
      DEFAULT_MAX_WARDEN_REJECTION_ROUNDS;
    const skipped = input.rejectionRounds >= maxRounds;

    const tasks = input.pactTasks ?? [];
    const states = new Map<string, string>();
    for (const task of tasks) {
      states.set(task.id, task.state ?? "pending");
    }
    if (skipped) {
      states.set(input.taskId, "skipped");
    }

    const completed = new Set<string>();
    for (const [id, state] of states.entries()) {
      // Only a merged task (or a task skipped under the rejection policy) may
      // unblock its dependents. "failed" and "abandoned" dependencies stay
      // blocked so downstream work is never dispatched on incomplete input.
      if (state === "merged" || state === "skipped") {
        completed.add(id);
      }
    }

    const dispatched: string[] = [];
    const remaining: string[] = [];
    for (const task of tasks) {
      const state = states.get(task.id) ?? "pending";
      if (state !== "pending" && state !== "ready") {
        continue;
      }
      // Resolve dependencies defensively: a non-empty `blockedBy` must never hide
      // unmet `deps`, so both lists are combined and every unmet dependency blocks
      // the task.
      const deps = [...(task.blockedBy ?? []), ...(task.deps ?? [])];
      const isBlocked =
        task.blocked === true || deps.some((dep) => !completed.has(dep));
      if (isBlocked) {
        remaining.push(task.id);
      } else {
        dispatched.push(task.id);
      }
    }

    return {
      runId: input.runId,
      taskId: input.taskId,
      skipped,
      state: skipped ? "skipped" : states.get(input.taskId) ?? "pending",
      dispatched,
      remaining,
    };
  }

  /**
   * Emits a structured silence nudge when the silent duration reaches the
   * configured threshold. An optional delivery hook/service can actually deliver
   * the nudge; a failed delivery reports `nudged: false` and records no event.
   */
  handleSilenceNudge(input: SilenceNudgeInput): SilenceNudgeResult {
    const thresholdMs =
      input.thresholdMs ??
      this.deps.settings?.silenceThresholdMs ??
      DEFAULT_SILENCE_THRESHOLD_MS;
    const nudged = input.silentDurationMs >= thresholdMs;

    if (!nudged) {
      return {
        runId: input.runId,
        nudged: false,
        silentDurationMs: input.silentDurationMs,
        thresholdMs,
        event: null,
      };
    }

    const to = input.skeletonId ?? input.runId;
    const msgId = `${input.runId}:msg:nudge:${this.now()}`;
    const text = `Silent for ${Math.floor(
      input.silentDurationMs / 1000
    )}s; report status.`;

    // Optional delivery: an explicit hook is preferred over an injected message
    // service. A throw or an explicit `false` means delivery failed, so the
    // handler reports `nudged: false` and records no `message.sent` event. When
    // neither hook is injected the nudge is emitted directly, preserving the
    // existing event-append behavior.
    let delivered = true;
    try {
      if (typeof this.deps.deliverNudge === "function") {
        delivered =
          this.deps.deliverNudge({
            runId: input.runId,
            msgId,
            from: "necromancer",
            to,
            skeletonId: input.skeletonId,
            intent: "nudge",
            text,
            nudge: true,
            refs: [],
          }) !== false;
      } else if (
        this.deps.messageService &&
        typeof this.deps.messageService.send === "function"
      ) {
        const sent = this.deps.messageService.send({
          runId: input.runId,
          from: "necromancer",
          to,
          skeletonId: input.skeletonId,
          intent: "nudge",
          text,
          refs: [],
        });
        delivered = sent !== false;
      }
    } catch {
      delivered = false;
    }

    if (!delivered) {
      return {
        runId: input.runId,
        nudged: false,
        silentDurationMs: input.silentDurationMs,
        thresholdMs,
        event: null,
      };
    }

    const event = this.deps.eventStore.append({
      runId: input.runId,
      kind: "message.sent",
      actor: "FailureRecoveryHandler",
      skeletonId: input.skeletonId,
      data: this.redact({
        msgId,
        from: "necromancer",
        to,
        intent: "nudge",
        text,
        nudge: true,
        kind: "silence_nudge",
        silentDurationMs: input.silentDurationMs,
        thresholdMs,
        refs: [],
      }),
    });

    return {
      runId: input.runId,
      nudged: true,
      silentDurationMs: input.silentDurationMs,
      thresholdMs,
      event,
    };
  }

  /**
   * Locks and isolates a worktree for secret detection or a symlink escape, blocks
   * its merge, and records a redacted containment event.
   */
  quarantineWorktree(input: QuarantineWorktreeInput): QuarantineWorktreeResult {
    if (input.worktreeDir) {
      this.quarantinedWorktrees.add(input.worktreeDir);
    }
    this.quarantinedWorktrees.add(`${input.runId}:${input.skeletonId ?? ""}`);
    this.blockedMerges.add(input.runId);

    let requestedSteps = 0;
    let succeededSteps = 0;

    let finalWorktreeDir: string | null = input.worktreeDir ?? null;

    const stopProcess = this.deps.stopProcess;
    if (typeof stopProcess === "function") {
      requestedSteps++;
      try {
        const outcome = stopProcess({
          runId: input.runId,
          skeletonId: input.skeletonId,
          worktreeDir: input.worktreeDir,
          reason: input.reason,
        });
        if (outcome !== false) {
          succeededSteps++;
        }
      } catch {
        // containment step failed; isolation stays false for this step
      }
    }

    if (input.worktreeDir) {
      requestedSteps++;
      const contained = this.containWorktreeOnDisk(input.worktreeDir, input);
      // Always report the accurate final path, even when containment failed.
      finalWorktreeDir = contained.finalPath;
      if (contained.isolated) {
        succeededSteps++;
      }
    }

    const isolated = requestedSteps > 0 && succeededSteps === requestedSteps;

    const event = this.deps.eventStore.append({
      runId: input.runId,
      kind: SECURITY_CONTAINMENT_EVENT_KIND,
      actor: "FailureRecoveryHandler",
      skeletonId: input.skeletonId,
      data: this.redact({
        reason: input.reason,
        detail: input.detail ?? null,
        worktree: finalWorktreeDir,
        isolated,
        mergeBlocked: true,
        refs: [],
      }),
    });

    return {
      runId: input.runId,
      quarantined: true,
      isolated,
      mergeBlocked: true,
      reason: input.reason,
      worktreeDir: finalWorktreeDir,
      event,
    };
  }

  /**
   * Performs real on-disk containment for a quarantined worktree: writes a
   * symlink-safe lock marker, restricts the worktree and its files to read-only,
   * and moves it under the configured quarantine root when one is set. Returns the
   * containment outcome together with the accurate final path so a caller can
   * distinguish a fully isolated worktree from one whose post-rename read-only pass
   * or realpath validation failed.
   */
  private containWorktreeOnDisk(
    worktreeDir: string,
    input: QuarantineWorktreeInput
  ): { isolated: boolean; finalPath: string; error?: string } {
    let realWorktree: string;
    try {
      // lstat does not follow the final path component, so a symlinked worktree
      // root is rejected outright instead of being followed.
      const lstat = fs.lstatSync(worktreeDir);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
        return { isolated: false, finalPath: worktreeDir };
      }
      realWorktree = fs.realpathSync(worktreeDir);
    } catch {
      return { isolated: false, finalPath: worktreeDir };
    }

    const quarantineRoot = input.quarantineRoot ?? this.deps.quarantineRoot;
    const hasQuarantineRoot =
      typeof quarantineRoot === "string" && quarantineRoot.trim().length > 0;

    let realQuarantineRoot: string | null = null;
    if (hasQuarantineRoot) {
      try {
        fs.mkdirSync(quarantineRoot as string, { recursive: true });
        realQuarantineRoot = fs.realpathSync(quarantineRoot as string);
      } catch {
        return { isolated: false, finalPath: worktreeDir };
      }
      // Refuse to quarantine the quarantine base onto itself.
      if (realWorktree === realQuarantineRoot) {
        return { isolated: false, finalPath: worktreeDir };
      }
    }

    let finalPath = worktreeDir;
    let movedTo: string | null = null;

    try {
      // Open the marker with O_NOFOLLOW so it is created as a brand-new file and
      // a pre-existing symlink at that path is never followed (O_EXCL fails the
      // open instead of writing through the link).
      const markerPath = path.join(worktreeDir, ".QUARANTINED");
      const markerFlags =
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0);
      let fd: number | null = null;
      try {
        fd = fs.openSync(markerPath, markerFlags, 0o444);
        fs.writeSync(
          fd,
          JSON.stringify(
            {
              runId: input.runId,
              skeletonId: input.skeletonId ?? null,
              reason: input.reason,
              quarantinedAt: this.now(),
            },
            null,
            2
          )
        );
      } finally {
        if (fd !== null) {
          fs.closeSync(fd);
        }
      }

      // A chmod failure must propagate so read-only containment fails loudly.
      // The move happens first because a read-only directory cannot be renamed;
      // the real moved path is recorded immediately so a later failure never
      // reports the stale pre-rename path.
      if (hasQuarantineRoot) {
        const root = quarantineRoot as string;
        const target = path.join(
          root,
          `${path.basename(worktreeDir)}-${this.now()}`
        );
        fs.renameSync(worktreeDir, target);
        movedTo = target;
        finalPath = target;
        this.quarantinedWorktrees.add(target);
      }

      const readOnly =
        this.deps.readOnlyPass ??
        ((root: string): void => this.makeWorktreeReadOnly(root));
      readOnly(finalPath);

      // Validate realpath containment so the moved worktree can never resolve
      // outside the configured quarantine base.
      if (hasQuarantineRoot && realQuarantineRoot !== null) {
        const realTarget = fs.realpathSync(finalPath);
        if (
          realTarget !== realQuarantineRoot &&
          !realTarget.startsWith(realQuarantineRoot + path.sep)
        ) {
          // Verification failed: roll the rename back cleanly when possible so no
          // stale path is reported; otherwise report the real moved path. Either
          // way the worktree is not isolated.
          if (movedTo !== null) {
            try {
              fs.renameSync(movedTo, worktreeDir);
              this.quarantinedWorktrees.delete(movedTo);
              movedTo = null;
            } catch {
              // Rollback failed: the worktree stays at the moved path.
            }
          }
          return {
            isolated: false,
            finalPath: movedTo ?? worktreeDir,
            error: "quarantine containment escaped the quarantine root",
          };
        }
      }

      return { isolated: true, finalPath };
    } catch (error) {
      // A post-rename failure (e.g. the read-only pass or realpath verification
      // throwing) must not report the stale pre-rename path. The worktree stays
      // contained and the actual moved path is returned so the result and the
      // emitted event stay accurate, and the worktree is never reported isolated.
      return {
        isolated: false,
        finalPath: movedTo ?? finalPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Recursive least-privilege containment: only the write bits are stripped from
   * each entry's existing mode (`mode & ~0o222`) so a `0600` file becomes `0400`
   * and a `0700` directory becomes `0500` without ever granting group/other read
   * access. Symlinks are skipped entirely so their targets are never followed or
   * chmodded, and any chmod failure propagates to the caller.
   */
  private makeWorktreeReadOnly(root: string): void {
    const dirs: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      dirs.push(current);
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        // Re-lstat immediately before chmod to close the Dirent TOCTOU window:
        // the entry may have been swapped for a symlink or a hard-linked file
        // between readdir and chmod. Never chmod a symlink or a multi-hardlink
        // file, as that would reach outside the worktree or the file's aliases.
        let st: fs.Stats;
        try {
          st = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (st.isFile() && st.nlink === 1) {
          fs.chmodSync(full, st.mode & ~0o222);
        }
        // Anything else (device, socket, fifo, or multi-hardlink file) is skipped.
      }
    }
    for (const dir of dirs) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(dir);
      } catch {
        continue;
      }
      fs.chmodSync(dir, st.mode & ~0o222);
    }
  }

  isWorktreeQuarantined(worktreeDir: string): boolean {
    if (this.quarantinedWorktrees.has(worktreeDir)) {
      return true;
    }
    if (this.hasQuarantineMarker(worktreeDir)) {
      // Memoize the marker match so later lookups stay quarantined even once the
      // marker is gone, matching isMergeBlocked across supervisor restarts.
      this.quarantinedWorktrees.add(worktreeDir);
      return true;
    }
    return false;
  }

  private hasQuarantineMarker(worktreeDir: string): boolean {
    try {
      fs.lstatSync(path.join(worktreeDir, ".QUARANTINED"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reports whether a run's merge is blocked. In addition to the in-memory set,
   * the block is reconstructed from the persisted `security.containment` events
   * and, when a worktree path is supplied, from the on-disk `.QUARANTINED` marker,
   * so a merge block survives a supervisor restart.
   */
  isMergeBlocked(runId: string, worktreeDir?: string): boolean {
    if (this.blockedMerges.has(runId)) {
      return true;
    }
    try {
      const events = this.deps.eventStore.getEvents(runId, {
        kind: SECURITY_CONTAINMENT_EVENT_KIND,
      });
      if (events.some((e) => e.data?.mergeBlocked === true)) {
        this.blockedMerges.add(runId);
        return true;
      }
    } catch {
      // Fail closed: a store error means the block cannot be disproven, so the
      // merge stays blocked instead of silently falling through to false.
      this.blockedMerges.add(runId);
      return true;
    }
    if (typeof worktreeDir === "string" && worktreeDir.length > 0) {
      if (
        this.quarantinedWorktrees.has(worktreeDir) ||
        this.hasQuarantineMarker(worktreeDir)
      ) {
        // Persist the block so later calls without a worktreeDir stay blocked.
        this.blockedMerges.add(runId);
        return true;
      }
    }
    return false;
  }

  /**
   * Records a clean permission.anomaly event when the PermissionBroker watchdog
   * times out.
   */
  handleBrokerWatchdogTimeout(
    input: BrokerWatchdogTimeoutInput
  ): BrokerWatchdogTimeoutResult {
    const event = this.deps.eventStore.append({
      runId: input.runId,
      kind: "permission.anomaly",
      actor: "PermissionBroker",
      skeletonId: input.skeletonId,
      data: this.redact({
        reason: "watchdog_timeout",
        skeletonId: input.skeletonId ?? null,
        role: input.role ?? null,
        capability: input.capability ?? null,
        target: input.target ?? null,
        toolCallId: input.toolCallId ?? null,
        requestId: input.requestId ?? null,
        timeoutMs: input.timeoutMs ?? null,
        watchdogLimitMs: input.watchdogLimitMs ?? null,
        refs: [],
      }),
    });

    return { runId: input.runId, logged: true, event };
  }
}

export function createFailureRecoveryHandler(
  deps: FailureRecoveryDeps
): FailureRecoveryHandler {
  return new FailureRecoveryHandler(deps);
}
