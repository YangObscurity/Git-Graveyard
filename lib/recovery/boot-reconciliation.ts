// Task 23.4: Boot reconciliation, box failure recovery, GitHub rate limits and
// Kiro credit exhaustion handling.
// Requirements: 32.9, 41.7, 41.8, 43.13, 43.14, 43.15, 43.19.

import * as path from "node:path";

import type { EventEnvelope } from "../events/event-store";
import { type EventStore } from "../events/event-store";
import {
  RunStore,
  type RunOutcome,
  type RunPhase,
  type RunRecord,
} from "../runs/run-store";
import { redactEventData, type Redactor, type RedactionOptions } from "../security/redactor";

export const SANDBOX_OWNERSHIP_LABEL = "managedBy";
export const DEFAULT_SANDBOX_MANAGED_BY = "git-graveyard";
export const SANDBOX_WORKER_LABEL = "workerId";
export const SANDBOX_TENANT_LABEL = "tenantId";

export interface SandboxBoxInfo {
  readonly sandboxId?: string;
  readonly id?: string;
  readonly runId?: string;
  readonly labels?: Record<string, string>;
  readonly status?: string;
  readonly [key: string]: unknown;
}

export interface SandboxBackendLike {
  list(labels?: Record<string, string>): Promise<unknown[]> | unknown[];
  destroy(id: string): Promise<void> | void;
}

export interface ProcessOps {
  isAlive?(pid: number): boolean;
  readCommand?(pid: number): string | null | undefined;
  readOwner?(pid: number): string | number | null | undefined;
  kill?(pid: number, signal?: NodeJS.Signals | string): boolean | void;
  /**
   * Optional atomic hook: re-verifies the process command/owner and signals it in
   * one indivisible operation so no other process can be killed between the check
   * and the signal. When provided it is preferred over `kill`.
   */
  killVerified?(pid: number, signal?: NodeJS.Signals | string): boolean | void;
}

export interface PidFileRecord {
  readonly pid: number;
  readonly path?: string;
  readonly runId?: string;
  readonly skeletonId?: string;
  readonly command?: string;
  readonly expectedCommand?: string;
  readonly owner?: string | number;
  readonly expectedOwner?: string | number;
}

export interface BootReconciliationParams {
  readonly runStore?: RunStore;
  readonly eventStore?: EventStore;
  readonly backend?: SandboxBackendLike;
  readonly pidFiles?: readonly PidFileRecord[];
  readonly processOps?: ProcessOps;
  readonly managedBy?: string;
  readonly workerId?: string;
  readonly tenantId?: string;
}

export interface BootReconciliationResult {
  readonly livingRuns: string[];
  readonly recovered: string[];
  readonly errored: string[];
  readonly reapedPids: number[];
  readonly skippedPids: number[];
  readonly failedPids: number[];
  readonly destroyedBoxes: string[];
  readonly failedDestroys: string[];
  readonly unownedBoxes: string[];
  readonly workerRestarted: boolean;
  readonly pausedRuns: string[];
}

export type BoxFailureKind = "oom" | "exit" | "ttl_expired";

export interface BoxCommandSpec {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly ref?: string;
}

export interface CommandOutcome {
  readonly exitCode?: number | null;
  readonly oomKilled?: boolean;
  readonly timedOut?: boolean;
  readonly ref?: string;
  readonly [key: string]: unknown;
}

export interface BoxFailureInput {
  readonly runId: string;
  readonly sandboxId: string;
  readonly kind: BoxFailureKind;
  readonly failedCommand?: string | BoxCommandSpec;
  readonly priorRecreations?: number;
  readonly recreateBox?: (params: {
    runId: string;
    sandboxId: string;
    kind: BoxFailureKind;
  }) =>
    | { sandboxId?: string }
    | string
    | null
    | Promise<{ sandboxId?: string } | string | null>;
  /**
   * Explicit opt-in allowing the failed command to be re-run against the original
   * (already-failed) sandbox when no fresh sandbox was created. Omitted or false
   * means the command is only re-run once a fresh sandbox actually exists.
   */
  readonly allowSameBoxRerun?: boolean;
  readonly rerunCommand?: (params: {
    runId: string;
    sandboxId: string;
    command?: string;
    args?: readonly string[];
    ref?: string;
    kind: BoxFailureKind;
  }) => CommandOutcome | null | Promise<CommandOutcome | null>;
}

export interface BoxFailureFlags {
  readonly oomKilled: boolean;
  readonly timedOut: boolean;
}

export interface BoxFailureResult {
  readonly runId: string;
  readonly sandboxId: string;
  readonly kind: BoxFailureKind;
  readonly recreated: boolean;
  readonly newSandboxId: string | null;
  readonly attempts: number;
  readonly commandOutcome: CommandOutcome;
  readonly flags: BoxFailureFlags;
}

export interface GitHubRateLimitInput {
  readonly runId: string;
  readonly statusCode: 403 | 429;
  readonly resetAtMs?: number;
  readonly retryAfterSec?: number;
}

export interface GitHubRateLimitResult {
  readonly runId: string;
  readonly statusCode: 403 | 429;
  readonly resetAtMs: number;
  readonly cooldownMs: number;
  readonly retryAfterSec: number | null;
  readonly event: EventEnvelope | null;
}

export interface KiroCreditExhaustionInput {
  readonly runId: string;
  readonly runStore?: RunStore;
  readonly eventStore?: EventStore;
}

export interface KiroCreditExhaustionResult {
  readonly runId: string;
  readonly phase: "done";
  readonly outcome: "budget_stopped";
  readonly preservedMergedWork: boolean;
  readonly event: EventEnvelope | null;
}

export interface BootReconciliationDeps {
  readonly runStore?: RunStore;
  readonly eventStore?: EventStore;
  readonly backend?: SandboxBackendLike;
  readonly processOps?: ProcessOps;
  readonly redactor?: Redactor;
  readonly redactionOptions?: RedactionOptions;
  readonly managedBy?: string;
  readonly workerId?: string;
  readonly tenantId?: string;
  readonly now?: () => number;
}

/**
 * Fail-closed redaction helper: replaces every string leaf value with the
 * redaction mask, and is cycle-safe for both objects and arrays so a self
 * referential structure can never recurse infinitely or leak original values.
 */
function redactAllStringLeaves(
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

function boxId(box: SandboxBoxInfo): string | null {
  const fromLabels = box.labels?.sandboxId ?? box.labels?.id;
  const id = box.sandboxId ?? box.id ?? fromLabels;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function boxRunId(box: SandboxBoxInfo): string | null {
  const fromLabels = box.labels?.runId;
  const id = box.runId ?? fromLabels;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Extracts the exact executable basename from a command line or single token.
 * Handles both POSIX and Windows separators, strips surrounding quotes and a
 * trailing `.exe`, and lowercases the result. Never performs substring matching.
 */
function executableBasename(token: string | null | undefined): string {
  if (typeof token !== "string") {
    return "";
  }
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return "";
  }
  let argv0: string;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    argv0 = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  } else {
    argv0 = trimmed.split(/\s+/)[0] ?? "";
  }
  const unquoted = argv0.replace(/^["']+/, "").replace(/["']+$/, "");
  if (unquoted.length === 0) {
    return "";
  }
  const base = path.win32.basename(path.posix.basename(unquoted));
  return base.replace(/\.exe$/i, "").trim().toLowerCase();
}

/**
 * Strictly matches the command whose executable basename equals the expected
 * executable name. Substrings such as `vim kiro-cli.md` never match `kiro-cli`.
 */
function commandMatches(actual: string, expected: string): boolean {
  const expectedBase = executableBasename(expected);
  if (expectedBase.length === 0) {
    return false;
  }
  const actualBase = executableBasename(actual);
  return actualBase.length > 0 && actualBase === expectedBase;
}

function normalizeCommand(
  failedCommand: string | BoxCommandSpec | undefined
): BoxCommandSpec {
  if (failedCommand === undefined) {
    return {};
  }
  if (typeof failedCommand === "string") {
    return { command: failedCommand };
  }
  return {
    command: failedCommand.command,
    args: failedCommand.args,
    ref: failedCommand.ref,
  };
}

function mergeFlags(
  outcome: CommandOutcome | null | undefined,
  flags: BoxFailureFlags
): CommandOutcome {
  const merged = { ...(outcome ?? {}) } as Record<string, unknown>;
  merged.oomKilled = outcome?.oomKilled === true || flags.oomKilled;
  merged.timedOut = outcome?.timedOut === true || flags.timedOut;
  return merged as CommandOutcome;
}

/**
 * Boot reconciliation and runtime failure handling for worker restarts, orphaned
 * processes and boxes, box failures, GitHub rate limits and Kiro credit exhaustion.
 */
export class BootReconciliationService {
  private readonly deps: BootReconciliationDeps;

  constructor(deps: BootReconciliationDeps = {}) {
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
   * Reaps a pidfile only after verifying the process command and ownership through
   * processOps. Unverifiable pids are skipped so unrelated host PIDs are never
   * signalled.
   */
  private canReap(pf: PidFileRecord, processOps?: ProcessOps): boolean {
    if (!processOps) {
      return false;
    }
    if (typeof processOps.kill !== "function" && typeof processOps.killVerified !== "function") {
      return false;
    }
    const pid = pf?.pid;
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    if (typeof processOps.isAlive === "function") {
      let alive = false;
      try {
        alive = processOps.isAlive(pid) === true;
      } catch {
        // A probe failure must never abort boot reconciliation: treat the pid as
        // not reapable and skip it.
        alive = false;
      }
      if (!alive) {
        return false;
      }
    }
    const readCommand = processOps.readCommand;
    if (typeof readCommand !== "function") {
      return false;
    }
    let actual: string | null = null;
    try {
      actual = readCommand(pid) ?? null;
    } catch {
      actual = null;
    }
    if (!actual) {
      return false;
    }
    // Only kiro-cli processes are ever signalled: the recorded command field is
    // informational, so the match target defaults to the canonical executable
    // names unless an explicit expectedCommand is supplied. Matching is strict on
    // the executable basename so substrings such as `vim kiro-cli.md` never match.
    const explicitExpected = pf.expectedCommand?.trim();
    const expectedNames =
      explicitExpected && explicitExpected.length > 0
        ? [explicitExpected]
        : ["kiro-cli", "kiro-cli-real"];
    if (!expectedNames.some((name) => commandMatches(actual, name))) {
      return false;
    }
    // Owner verification is mandatory and fails closed: reaping is skipped when no
    // expected owner is known, when the process owner cannot be read, or when the
    // observed owner differs from the expected one.
    const expectedOwner = pf.expectedOwner ?? pf.owner;
    if (expectedOwner === undefined || expectedOwner === null) {
      return false;
    }
    const readOwner = processOps.readOwner;
    if (typeof readOwner !== "function") {
      return false;
    }
    let owner: string | number | null | undefined;
    try {
      owner = readOwner(pid);
    } catch {
      owner = undefined;
    }
    if (owner === undefined || owner === null || String(owner) !== String(expectedOwner)) {
      return false;
    }
    return true;
  }

  /**
   * Inspects living runs, reaps orphaned kiro-cli processes, destroys orphan boxes,
   * pauses run clocks, and marks runs whose boxes were lost as error while
   * preserving every collected event.
   */
  async reconcileOnBoot(
    params: BootReconciliationParams = {}
  ): Promise<BootReconciliationResult> {
    const runStore = params.runStore ?? this.deps.runStore;
    const eventStore = params.eventStore ?? this.deps.eventStore;
    const backend = params.backend ?? this.deps.backend;
    const processOps = params.processOps ?? this.deps.processOps;
    const pidFiles = params.pidFiles ?? [];

    if (!runStore || !eventStore) {
      throw new TypeError(
        "reconcileOnBoot requires a runStore and an eventStore"
      );
    }

    const now = this.now();
    const living = runStore.getLivingRuns();

    const pausedRuns: string[] = [];
    for (const run of living) {
      eventStore.append({
        runId: run.runId,
        kind: "run.clock",
        actor: "BootReconciliationService",
        data: this.redact({
          action: "pause",
          phase: run.phase,
          reason: "worker_restart",
          refs: [],
        }),
      });
      pausedRuns.push(run.runId);
    }

    const reapedPids: number[] = [];
    const skippedPids: number[] = [];
    const failedPids: number[] = [];
    for (const pf of pidFiles) {
      if (this.canReap(pf, processOps)) {
        let signalled = false;
        try {
          const killVerified = processOps?.killVerified;
          if (typeof killVerified === "function") {
            // Preferred atomic path: the processOps hooks handle re-verification and
            // signalling in a single indivisible operation.
            const outcome = killVerified(pf.pid, "SIGTERM");
            signalled = outcome !== false;
          } else {
            // Re-verify the process command/owner identity immediately before the
            // kill so a PID reused between the first check and the signal is never
            // signalled (closes the TOCTOU window).
            if (this.canReap(pf, processOps)) {
              const outcome = processOps?.kill?.(pf.pid, "SIGTERM");
              signalled = outcome !== false;
            }
          }
        } catch {
          signalled = false;
        }
        // Only record a pid as reaped once the kill actually succeeds; failures
        // are tracked separately and never reported as reaped.
        if (signalled) {
          reapedPids.push(pf.pid);
        } else {
          skippedPids.push(pf.pid);
          failedPids.push(pf.pid);
        }
      } else {
        skippedPids.push(pf.pid);
      }
    }

    const managedBy =
      params.managedBy ?? this.deps.managedBy ?? DEFAULT_SANDBOX_MANAGED_BY;
    const workerId = params.workerId ?? this.deps.workerId;
    const tenantId = params.tenantId ?? this.deps.tenantId;

    const filterLabels: Record<string, string> = {
      [SANDBOX_OWNERSHIP_LABEL]: managedBy,
    };
    if (typeof workerId === "string" && workerId.length > 0) {
      filterLabels[SANDBOX_WORKER_LABEL] = workerId;
    }
    if (typeof tenantId === "string" && tenantId.length > 0) {
      filterLabels[SANDBOX_TENANT_LABEL] = tenantId;
    }

    // A candidate box is only ours when it explicitly carries every configured
    // ownership label. Anything else is treated as unowned and never destroyed.
    const ownsBox = (box: SandboxBoxInfo): boolean => {
      const labels = box.labels;
      if (!labels || typeof labels !== "object") {
        return false;
      }
      if (labels[SANDBOX_OWNERSHIP_LABEL] !== managedBy) {
        return false;
      }
      if (
        filterLabels[SANDBOX_WORKER_LABEL] !== undefined &&
        labels[SANDBOX_WORKER_LABEL] !== filterLabels[SANDBOX_WORKER_LABEL]
      ) {
        return false;
      }
      if (
        filterLabels[SANDBOX_TENANT_LABEL] !== undefined &&
        labels[SANDBOX_TENANT_LABEL] !== filterLabels[SANDBOX_TENANT_LABEL]
      ) {
        return false;
      }
      return true;
    };

    let listValid = true;
    let boxes: SandboxBoxInfo[] = [];
    if (backend) {
      const raw = await backend.list(filterLabels);
      if (Array.isArray(raw)) {
        boxes = raw.filter(
          (b): b is SandboxBoxInfo => typeof b === "object" && b !== null
        );
      } else {
        // A non-array (null/undefined/garbage) list result is not a trustworthy
        // empty set: abort lost-box transitions so living runs are never falsely
        // marked lost while the backend listing is unavailable.
        listValid = false;
      }
    }
    const boxIds = new Set<string>();
    for (const box of boxes) {
      const id = boxId(box);
      if (id) {
        boxIds.add(id);
      }
    }

    const destroyedBoxes: string[] = [];
    const failedDestroys: string[] = [];
    const unownedBoxes: string[] = [];
    if (backend) {
      for (const box of boxes) {
        const id = boxId(box);
        if (!id) {
          continue;
        }
        const runId = boxRunId(box);
        const belongs = living.some(
          (r) => r.sandboxId === id || (runId !== null && r.runId === runId)
        );
        if (belongs) {
          continue;
        }
        if (!ownsBox(box)) {
          unownedBoxes.push(id);
          continue;
        }
        let destroyed = false;
        try {
          await backend.destroy(id);
          destroyed = true;
        } catch {
          destroyed = false;
        }
        // Only record a box as destroyed once the backend destroy succeeds;
        // failures are tracked separately and never reported as destroyed.
        if (destroyed) {
          destroyedBoxes.push(id);
        } else {
          failedDestroys.push(id);
        }
      }
    }

    const recovered: string[] = [];
    const errored: string[] = [];
    for (const run of living) {
      const boxPresent = run.sandboxId ? boxIds.has(run.sandboxId) : true;
      if (listValid && backend && run.sandboxId && !boxPresent) {
        runStore.markSandboxLost(run.runId, run.sandboxId);
        runStore.updateRun(run.runId, {
          phase: "done",
          outcome: "error",
          endedAt: now,
          updatedAt: now,
        });
        errored.push(run.runId);
      } else {
        recovered.push(run.runId);
      }
    }

    let workerRestarted = false;
    if (living.length > 0) {
      eventStore.append({
        runId: living[0].runId,
        kind: "system.worker_restart",
        actor: "BootReconciliationService",
        data: this.redact({
          restarted: true,
          pausedDurationMs: 0,
          affectedRuns: living.map((r) => r.runId),
          refs: [],
        }),
      });
      workerRestarted = true;
    }

    return {
      livingRuns: living.map((r) => r.runId),
      recovered,
      errored,
      reapedPids,
      skippedPids,
      failedPids,
      destroyedBoxes,
      failedDestroys,
      unownedBoxes,
      workerRestarted,
      pausedRuns,
    };
  }

  /**
   * Recreates the box at most once per failure, reruns the failed command, and
   * tags the command outcome with oomKilled or timedOut cleanly.
   */
  async handleBoxFailure(input: BoxFailureInput): Promise<BoxFailureResult> {
    const prior = input.priorRecreations ?? 0;
    const flags: BoxFailureFlags = {
      oomKilled: input.kind === "oom",
      timedOut: input.kind === "ttl_expired",
    };

    let attempts = prior;
    let recreated = false;
    let newSandboxId: string | null = null;
    // A failed recreation must never rerun the command against the original,
    // already-failed box.
    let recreationFailed = false;
    // When the recreation cap (one recreation per failure) has already been reached,
    // the failed box must not be re-run at all.
    const capReached = prior >= 1;
    if (!capReached && typeof input.recreateBox === "function") {
      // A recreation is performed or at least attempted, so advance the counter
      // so callers persisting result.attempts enforce the 1-recreation cap.
      attempts = prior + 1;
      try {
        const result = await input.recreateBox({
          runId: input.runId,
          sandboxId: input.sandboxId,
          kind: input.kind,
        });
        const resolvedId =
          result === null || result === undefined
            ? null
            : typeof result === "string"
              ? result
              : result.sandboxId ?? null;
        if (
          typeof resolvedId === "string" &&
          resolvedId.trim().length > 0
        ) {
          recreated = true;
          newSandboxId = resolvedId;
        } else {
          // Empty or missing sandboxId is a failed recreation.
          recreationFailed = true;
        }
      } catch {
        recreated = false;
        recreationFailed = true;
      }
    }

    const spec = normalizeCommand(input.failedCommand);
    let commandOutcome: CommandOutcome = { ...flags };
    // The failed command is only re-run once a fresh sandbox actually exists (or
    // when the caller explicitly opts into rerunning against the same, already
    // failed box). Otherwise the command is never re-run against input.sandboxId.
    const mayRerun =
      !capReached &&
      !recreationFailed &&
      (recreated || input.allowSameBoxRerun === true);
    if (mayRerun && typeof input.rerunCommand === "function") {
      try {
        const outcome = await input.rerunCommand({
          runId: input.runId,
          sandboxId: newSandboxId ?? input.sandboxId,
          command: spec.command,
          args: spec.args,
          ref: spec.ref,
          kind: input.kind,
        });
        commandOutcome = mergeFlags(outcome, flags);
      } catch {
        commandOutcome = { ...flags };
      }
    }

    return {
      runId: input.runId,
      sandboxId: input.sandboxId,
      kind: input.kind,
      recreated,
      newSandboxId,
      attempts,
      commandOutcome,
      flags,
    };
  }

  /**
   * Computes the cooldown window for a GitHub 403/429 rate limit and records a
   * system.github_rate_limit event with the reset time.
   */
  handleGitHubRateLimit(input: GitHubRateLimitInput): GitHubRateLimitResult {
    const now = this.now();
    const rawRetryAfterSec = input.retryAfterSec;
    // NaN, Infinity and negative values are unusable: fall back cleanly to the
    // default cooldown rather than producing an invalid reset time.
    const retryAfterSec =
      typeof rawRetryAfterSec === "number" &&
      Number.isFinite(rawRetryAfterSec) &&
      rawRetryAfterSec >= 0
        ? rawRetryAfterSec
        : null;
    const fallbackReset =
      now + (retryAfterSec !== null ? retryAfterSec * 1000 : 60000);
    const resetAtMs =
      typeof input.resetAtMs === "number" && input.resetAtMs > 0
        ? input.resetAtMs
        : fallbackReset;
    const cooldownMs = Math.max(0, resetAtMs - now);

    let event: EventEnvelope | null = null;
    if (this.deps.eventStore) {
      event = this.deps.eventStore.append({
        runId: input.runId,
        kind: "system.github_rate_limit",
        actor: "BootReconciliationService",
        data: this.redact({
          statusCode: input.statusCode,
          resetAtMs,
          cooldownMs,
          retryAfterSec,
          retryAfter: retryAfterSec,
          refs: [],
        }),
      });
    }

    return {
      runId: input.runId,
      statusCode: input.statusCode,
      resetAtMs,
      cooldownMs,
      retryAfterSec,
      event,
    };
  }

  /**
   * Transitions a run to done / budget_stopped when Kiro credits are exhausted,
   * preserving merged work and evidence.
   */
  handleKiroCreditExhaustion(
    input: KiroCreditExhaustionInput
  ): KiroCreditExhaustionResult {
    const runStore = input.runStore ?? this.deps.runStore;
    const eventStore = input.eventStore ?? this.deps.eventStore;
    const now = this.now();

    // Validate the run before touching any state: a missing run must never be
    // reported as a successful budget_stopped transition or emit events.
    if (!runStore) {
      throw new Error(
        `handleKiroCreditExhaustion requires a runStore to validate run "${input.runId}"`
      );
    }
    const run = runStore.getRun(input.runId);
    if (!run) {
      throw new Error(
        `handleKiroCreditExhaustion: run "${input.runId}" not found`
      );
    }

    const merged = (run.metadata as Record<string, unknown> | null)
      ?.mergedTasksCount;
    const preservedMergedWork = typeof merged === "number" ? merged > 0 : true;

    runStore.updateRun(input.runId, {
      phase: "done",
      outcome: "budget_stopped",
      endedAt: now,
      updatedAt: now,
    });

    let event: EventEnvelope | null = null;
    if (eventStore) {
      event = eventStore.append({
        runId: input.runId,
        kind: "budget.exceeded",
        actor: "BootReconciliationService",
        data: this.redact({
          reason: "kiro_credit_exhausted",
          outcome: "budget_stopped",
          preservedWork: preservedMergedWork,
          refs: [],
        }),
      });
    }

    return {
      runId: input.runId,
      phase: "done",
      outcome: "budget_stopped",
      preservedMergedWork,
      event,
    };
  }
}

export function createBootReconciliationService(
  deps: BootReconciliationDeps = {}
): BootReconciliationService {
  return new BootReconciliationService(deps);
}
