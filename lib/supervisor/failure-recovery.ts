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
 * unredacted data can ever be returned.
 */
function redactAllStringLeaves(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof value === "string") {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAllStringLeaves(item, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
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

export type RespawnMessage = "Resumed the same session" | "Restarted from its last commit";

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

    if (crashCount >= 1) {
      return {
        ...base,
        status: "failed",
        respawned: false,
        respawnMessage: "Restarted from its last commit",
        sessionLoaded: false,
        attempts: 1,
        failedEvent: appendFailed(),
      };
    }

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
      respawnMessage: "Restarted from its last commit",
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
      const deps = task.blockedBy ?? task.deps ?? [];
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
   * Emits a silence nudge when the silent duration reaches the configured
   * threshold.
   */
  handleSilenceNudge(input: SilenceNudgeInput): SilenceNudgeResult {
    const thresholdMs =
      input.thresholdMs ??
      this.deps.settings?.silenceThresholdMs ??
      DEFAULT_SILENCE_THRESHOLD_MS;
    const nudged = input.silentDurationMs >= thresholdMs;

    let event: EventEnvelope | null = null;
    if (nudged) {
      event = this.deps.eventStore.append({
        runId: input.runId,
        kind: "message.sent",
        actor: "FailureRecoveryHandler",
        skeletonId: input.skeletonId,
        data: this.redact({
          nudge: true,
          kind: "silence_nudge",
          silentDurationMs: input.silentDurationMs,
          thresholdMs,
          refs: [],
        }),
      });
    }

    return {
      runId: input.runId,
      nudged,
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
      if (contained !== null) {
        succeededSteps++;
        finalWorktreeDir = contained;
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
   * final worktree path on success, or null whenever a requested containment step
   * cannot be completed.
   */
  private containWorktreeOnDisk(
    worktreeDir: string,
    input: QuarantineWorktreeInput
  ): string | null {
    let realWorktree: string;
    try {
      // lstat does not follow the final path component, so a symlinked worktree
      // root is rejected outright instead of being followed.
      const lstat = fs.lstatSync(worktreeDir);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
        return null;
      }
      realWorktree = fs.realpathSync(worktreeDir);
    } catch {
      return null;
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
        return null;
      }
      // Refuse to quarantine the quarantine base onto itself.
      if (realWorktree === realQuarantineRoot) {
        return null;
      }
    }

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
      // The move happens first because a read-only directory cannot be renamed.
      let finalPath = worktreeDir;
      if (hasQuarantineRoot) {
        const root = quarantineRoot as string;
        const target = path.join(
          root,
          `${path.basename(worktreeDir)}-${this.now()}`
        );
        fs.renameSync(worktreeDir, target);
        finalPath = target;
        this.quarantinedWorktrees.add(target);
      }

      this.makeWorktreeReadOnly(finalPath);

      // Validate realpath containment so the moved worktree can never resolve
      // outside the configured quarantine base.
      if (hasQuarantineRoot && realQuarantineRoot !== null) {
        const realTarget = fs.realpathSync(finalPath);
        if (
          realTarget !== realQuarantineRoot &&
          !realTarget.startsWith(realQuarantineRoot + path.sep)
        ) {
          return null;
        }
      }

      return finalPath;
    } catch {
      return null;
    }
  }

  /**
   * Recursive read-only permissions: files become 0444 and directories become
   * 0555 so the quarantined worktree can no longer be modified in place. Symlinks
   * are skipped entirely so their targets are never followed or chmodded, and any
   * chmod failure propagates to the caller.
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
        // Never follow or chmod a symlink; skip it so the link target outside the
        // worktree is left untouched.
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(full);
        } else {
          fs.chmodSync(full, 0o444);
        }
      }
    }
    for (const dir of dirs) {
      fs.chmodSync(dir, 0o555);
    }
  }

  isWorktreeQuarantined(worktreeDir: string): boolean {
    return this.quarantinedWorktrees.has(worktreeDir);
  }

  isMergeBlocked(runId: string): boolean {
    return this.blockedMerges.has(runId);
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
