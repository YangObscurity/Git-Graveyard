// Task 10.4: Command approval workflow and grant tracking
// Requirements: 20.6, 20.7, 20.8, 20.9, 20.10, 20.14

import * as crypto from "node:crypto";
import * as path from "node:path";
import { ConfigurationError, type ApprovalGrant, type ApprovalRequest } from "./types";
import type { RunStore } from "../runs/run-store";
import { matchCommandPattern } from "../runs/run-store";
import type { EventStore } from "../events/event-store";
import { redactEvent, redactText, redactValue } from "../security/redactor";

export { ConfigurationError };

export interface RequestApprovalParams {
  runId: string;
  skeletonId?: string;
  argv?: string[];
  cwd?: string;
  ttlMs?: number;
  reason?: string;
  summary?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface ResolveApprovalParams {
  decision?: "approved" | "denied" | string;
  status?: "approved" | "denied" | string;
  reason?: string;
  resolutionReason?: string;
  resolvedBy?: string;
  ttlMs?: number;
  runId?: string;
  /**
   * Approval scope. `"once"` approves a single request; `"run_pattern"`
   * records the resolved pattern for the run so later matching approvals
   * auto-resolve.
   */
  scope?: string;
  /** Explicit run-scoped command pattern for `approve_pattern` resolutions. */
  pattern?: string;
  [key: string]: unknown;
}

export interface ApprovalRecord extends ApprovalRequest {
  reason?: string;
  summary?: string;
  detail?: string;
  resolutionReason?: string;
}

export type EventEmitCallback = (event: {
  kind: string;
  runId: string;
  actor: string;
  data: Record<string, unknown>;
  skeletonId?: string;
}) => void | Promise<void>;

export interface ApprovalManagerOptions {
  defaultWaitMs?: number;
  approvalWaitMs?: number;
  onEmitEvent?: EventEmitCallback;
  runStore?: RunStore;
  eventStore?: EventStore;
}

/**
 * Computes deterministic SHA-256 of argv array.
 * Requirement 20.7.
 */
export function sha256Argv(argv: string[]): string {
  const serialized = JSON.stringify(argv);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

/**
 * Derives a conservative run-scoped command prefix from an approved argv: the
 * leading run of non-flag tokens, always including the program name. So
 * `["npm", "test", "--watch"]` yields `"npm test"` and
 * `["python", "-m", "unittest"]` yields `"python"`. The result is a prefix, so
 * `matchCommandPattern` still requires a word boundary before matching.
 */
export function deriveCommandPrefix(
  argv: readonly string[] | undefined
): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) return undefined;
  const tokens = argv.filter(
    (token) => typeof token === "string" && token.trim().length > 0
  );
  if (tokens.length === 0) return undefined;
  const head: string[] = [tokens[0]];
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].startsWith("-")) break;
    head.push(tokens[i]);
  }
  return head.join(" ");
}

export class ApprovalManager {
  public readonly defaultWaitMs: number;
  private readonly onEmitEvent?: EventEmitCallback;
  private readonly runStore?: RunStore;
  private readonly eventStore?: EventStore;

  // One-time grants bound to (skeletonId, sha256(argv), cwd)
  // Maps key to array of grants to allow multiple sequential one-time grants.
  private readonly grants: Map<string, ApprovalGrant[]> = new Map();

  // Active one-time grants indexed by approvalId
  private readonly grantsByApprovalId: Map<string, ApprovalGrant> = new Map();

  // Pending approval requests keyed by approvalId
  private readonly pendingRequests: Map<string, ApprovalRequest> = new Map();

  // Stored approval records indexed by approvalId
  private readonly records: Map<string, ApprovalRecord> = new Map();

  // Raw grant inputs (approvalId -> { argv, cwd }) for grantApproval key hashing
  private readonly rawGrantInputs: Map<string, { argv: string[]; cwd: string }> = new Map();

  // Run-scoped approved patterns keyed by runId
  private readonly runPatterns: Map<string, Set<string>> = new Map();

  constructor(options?: ApprovalManagerOptions) {
    const wait = options?.defaultWaitMs ?? options?.approvalWaitMs;
    if (typeof wait !== "number" || isNaN(wait) || wait < 1) {
      throw new ConfigurationError(
        "Missing or invalid defaultWaitMs setting: positive integer required with no hard-coded default"
      );
    }
    this.defaultWaitMs = wait;
    this.onEmitEvent = options?.onEmitEvent;
    this.runStore = options?.runStore;
    this.eventStore = options?.eventStore;
  }

  /**
   * Helper to append to EventStore (if configured) and invoke onEmitEvent callback.
   * Requirement N-B12: run redactEvent(event) BEFORE appending to this.eventStore
   * and BEFORE calling this.onEmitEvent.
   */
  public async emitEvent(event: {
    kind: string;
    runId: string;
    actor: string;
    data: Record<string, unknown>;
    skeletonId?: string;
  }): Promise<void> {
    const redacted = redactEvent(event);
    if (this.eventStore && typeof this.eventStore.append === "function") {
      try {
        this.eventStore.append({
          runId: redacted.runId,
          kind: redacted.kind,
          actor: redacted.actor,
          skeletonId: redacted.skeletonId,
          data: {
            ...redacted.data,
            refs: Array.isArray(redacted.data?.refs) ? (redacted.data.refs as string[]) : [],
          },
        });
      } catch {
        // Safe fallback
      }
    }
    if (this.onEmitEvent) {
      await this.onEmitEvent(redacted);
    }
  }

  /**
   * Generates a unique key for binding one-time grants.
   * Requirement 20.7: bound to (skeletonId, sha256(argv), cwd).
   */
  private makeGrantKey(skeletonId: string, argvSha256: string, cwd: string): string {
    const normCwd = path.resolve(cwd);
    return `${skeletonId}:${argvSha256}:${normCwd}`;
  }

  /**
   * Emits approval.requested and registers pending approval request.
   * Requirement 20.6 & N-B12.
   * In requestApproval, redact params.reason with redactText (and redact any sensitive
   * string fields such as summary/detail) before storing the ApprovalRecord and before
   * emitting approval.requested.
   */
  async requestApproval(
    params: RequestApprovalParams
  ): Promise<ApprovalRecord>;
  async requestApproval(
    runId: string,
    skeletonId: string,
    argv: string[],
    cwd: string,
    ttlMs?: number,
    optionsOrReason?: string | Partial<RequestApprovalParams>
  ): Promise<ApprovalRecord>;
  async requestApproval(
    runIdOrParams: string | RequestApprovalParams,
    skeletonId?: string,
    argv?: string[],
    cwd?: string,
    ttlMs?: number,
    optionsOrReason?: string | Partial<RequestApprovalParams>
  ): Promise<ApprovalRecord> {
    let runId: string;
    let actualSkeletonId: string;
    let actualArgv: string[];
    let actualCwd: string;
    let actualTtlMs: number | undefined;
    let rawReason: string | undefined;
    let rawSummary: string | undefined;
    let rawDetail: string | undefined;

    if (typeof runIdOrParams === "object" && runIdOrParams !== null) {
      runId = runIdOrParams.runId;
      actualSkeletonId = runIdOrParams.skeletonId ?? "";
      actualArgv = runIdOrParams.argv ?? [];
      actualCwd = runIdOrParams.cwd ?? process.cwd();
      actualTtlMs = runIdOrParams.ttlMs;
      rawReason = runIdOrParams.reason;
      rawSummary = runIdOrParams.summary;
      rawDetail = runIdOrParams.detail;
    } else {
      runId = runIdOrParams;
      actualSkeletonId = skeletonId ?? "";
      actualArgv = argv ?? [];
      actualCwd = cwd ?? process.cwd();
      actualTtlMs = ttlMs;
      if (typeof optionsOrReason === "string") {
        rawReason = optionsOrReason;
      } else if (typeof optionsOrReason === "object" && optionsOrReason !== null) {
        rawReason = optionsOrReason.reason;
        rawSummary = optionsOrReason.summary;
        rawDetail = optionsOrReason.detail;
        if (optionsOrReason.ttlMs !== undefined && actualTtlMs === undefined) {
          actualTtlMs = optionsOrReason.ttlMs;
        }
      }
    }

    const redactedReason = typeof rawReason === "string" ? redactText(rawReason) : undefined;
    const redactedSummary = typeof rawSummary === "string" ? redactText(rawSummary) : undefined;
    const redactedDetail = typeof rawDetail === "string" ? redactText(rawDetail) : undefined;

    const approvalId = `appr-${crypto.randomBytes(8).toString("hex")}`;
    const effectiveTtl =
      typeof actualTtlMs === "number"
        ? Math.min(actualTtlMs, this.defaultWaitMs)
        : this.defaultWaitMs;
    const expiresAt = Date.now() + effectiveTtl;

    const canonicalCwd = path.resolve(actualCwd);
    const redactedArgv = actualArgv.map((a) => redactText(a));
    const redactedCwd = redactText(canonicalCwd);

    this.rawGrantInputs.set(approvalId, { argv: actualArgv, cwd: canonicalCwd });

    const request: ApprovalRecord = {
      approvalId,
      skeletonId: actualSkeletonId,
      runId,
      argv: redactedArgv,
      cwd: redactedCwd,
      expiresAt,
      status: "approval_pending",
      createdAt: Date.now(),
      ...(redactedReason !== undefined ? { reason: redactedReason } : {}),
      ...(redactedSummary !== undefined ? { summary: redactedSummary } : {}),
      ...(redactedDetail !== undefined ? { detail: redactedDetail } : {}),
    };

    this.pendingRequests.set(approvalId, request);
    this.records.set(approvalId, request);

    await this.emitEvent({
      kind: "approval.requested",
      runId,
      actor: "mcp_gateway",
      skeletonId: actualSkeletonId,
      data: {
        approvalId,
        argv: redactedArgv,
        cwd: redactedCwd,
        expiresAt,
        ...(redactedReason !== undefined ? { reason: redactedReason } : {}),
        ...(redactedSummary !== undefined ? { summary: redactedSummary } : {}),
        ...(redactedDetail !== undefined ? { detail: redactedDetail } : {}),
        refs: [],
      },
    });

    // Run-scoped pattern auto-approval: a command that already matches a
    // pattern approved for this run resolves immediately with a one-time grant
    // instead of raising a fresh pending card.
    try {
      if (
        this.isPatternApproved(runId, actualArgv, {
          cwd: canonicalCwd,
          skeletonId: actualSkeletonId,
        })
      ) {
        const approved: ApprovalRecord = {
          ...request,
          status: "approved",
          resolvedAt: Date.now(),
        };
        this.records.set(approvalId, approved);
        this.pendingRequests.delete(approvalId);
        this.grantApproval(
          approvalId,
          actualSkeletonId,
          actualArgv,
          canonicalCwd,
          approved.expiresAt,
          runId
        );
        await this.emitEvent({
          kind: "approval.resolved",
          runId,
          actor: "mcp_gateway",
          skeletonId: actualSkeletonId,
          data: {
            approvalId,
            decision: "approved",
            argv: redactedArgv,
            cwd: redactedCwd,
            expiresAt: approved.expiresAt,
            patternApproved: true,
            refs: [],
          },
        });
        return this.records.get(approvalId) ?? approved;
      }
    } catch {
      // A pattern lookup failure must never break raising the request.
    }

    return request;
  }

  /**
   * Creates a one-time approval grant bound to (skeletonId, sha256(argv), cwd).
   * Requirement 20.7: start a process for at most one later call that matches all three.
   */
  grantOnce(
    skeletonId: string,
    argv: string[],
    cwd: string,
    ttlMs?: number,
    runId?: string
  ): ApprovalGrant {
    const argvSha256 = sha256Argv(argv);
    const normCwd = path.resolve(cwd);
    const approvalId = `grant-${crypto.randomBytes(8).toString("hex")}`;
    const effectiveTtl =
      typeof ttlMs === "number"
        ? Math.min(ttlMs, this.defaultWaitMs)
        : this.defaultWaitMs;
    const expiresAt = Date.now() + effectiveTtl;

    const grant: ApprovalGrant & { runId?: string } = {
      approvalId,
      skeletonId,
      argvSha256,
      cwd: normCwd,
      expiresAt,
      used: false,
      createdAt: Date.now(),
      ...(runId ? { runId } : {}),
    };

    const key = this.makeGrantKey(skeletonId, argvSha256, cwd);
    const list = this.grants.get(key) ?? [];
    list.push(grant);
    this.grants.set(key, list);
    this.grantsByApprovalId.set(approvalId, grant);
    return grant;
  }

  /**
   * Records approval for an existing request ID.
   * Requirement 20.7.
   */
  grantApproval(
    approvalId: string,
    skeletonId: string,
    argv: string[],
    cwd: string,
    expiresAt: number,
    runId?: string
  ): ApprovalGrant {
    const rawInputs = this.rawGrantInputs.get(approvalId);
    const effectiveArgv = rawInputs ? rawInputs.argv : argv;
    const effectiveCwd = rawInputs ? rawInputs.cwd : cwd;
    const argvSha256 = sha256Argv(effectiveArgv);
    const normCwd = path.resolve(effectiveCwd);
    const effectiveRunId =
      runId ??
      this.records.get(approvalId)?.runId ??
      this.pendingRequests.get(approvalId)?.runId;

    const grant: ApprovalGrant & { runId?: string } = {
      approvalId,
      skeletonId,
      argvSha256,
      cwd: normCwd,
      expiresAt,
      used: false,
      createdAt: Date.now(),
      ...(effectiveRunId ? { runId: effectiveRunId } : {}),
    };

    const key = this.makeGrantKey(skeletonId, argvSha256, effectiveCwd);
    const list = this.grants.get(key) ?? [];
    list.push(grant);
    this.grants.set(key, list);
    this.grantsByApprovalId.set(approvalId, grant);

    // Keep request in pendingRequests with status 'approved' until consumed
    const req = this.pendingRequests.get(approvalId);
    if (req) {
      req.status = "approved";
      req.resolvedAt = Date.now();
      req.expiresAt = expiresAt;
    }
    return grant;
  }

  /**
   * Resolves an approval request with a decision and reason.
   * Requirement N-B12: redact resolution.reason with redactText before storing
   * record.resolutionReason and before emitting approval.resolved.
   */
  async resolveApproval(
    approvalId: string,
    resolution?: ResolveApprovalParams | string
  ): Promise<ApprovalRecord | null> {
    if (resolution === undefined || resolution === null) {
      throw new Error("Resolution decision is required");
    }

    let decision: "approved" | "denied";
    let rawReason: string | undefined;
    let resolvedBy = "user";
    let ttlMs: number | undefined;
    let scope: string | undefined;
    let explicitPattern: string | undefined;

    if (typeof resolution === "string") {
      if (resolution === "approved" || resolution === "approve_once") {
        decision = "approved";
        if (resolution === "approve_once") scope = "once";
      } else if (resolution === "approve_pattern") {
        decision = "approved";
        scope = "run_pattern";
      } else if (resolution === "denied" || resolution === "deny") {
        decision = "denied";
      } else {
        decision = "denied";
        rawReason = resolution;
      }
    } else if (typeof resolution === "object") {
      const raw = resolution.decision ?? resolution.status;
      if (typeof resolution.scope === "string") {
        scope = resolution.scope;
      }
      if (typeof resolution.pattern === "string") {
        explicitPattern = resolution.pattern;
      }

      // Canonical `approved`/`denied` decisions plus the API-facing aliases
      // (`approve_once` / `approve_pattern` / `deny`) all normalize to the same
      // approved/denied outcome so callers on either vocabulary interoperate.
      if (
        raw === "approved" ||
        raw === "approve_once" ||
        raw === "approve_pattern"
      ) {
        decision = "approved";
        if (raw === "approve_once" && scope === undefined) {
          scope = "once";
        }
        if (raw === "approve_pattern" && scope === undefined) {
          scope = "run_pattern";
        }
      } else if (
        raw === "denied" ||
        raw === "deny" ||
        raw === "deny_and_lay_to_rest" ||
        raw === "rejected" ||
        raw === "cancelled" ||
        raw === "expired" ||
        raw === "timeout"
      ) {
        decision = "denied";
      } else {
        throw new Error("Invalid approval decision: expected approved or denied");
      }
      rawReason = resolution.reason ?? resolution.resolutionReason;
      resolvedBy = resolution.resolvedBy ?? "user";
      ttlMs = resolution.ttlMs;
    } else {
      throw new Error("Invalid approval decision: expected approved or denied");
    }

    const req = (this.pendingRequests.get(approvalId) ?? this.records.get(approvalId)) as ApprovalRecord | undefined;
    if (!req) {
      return null;
    }

    if (typeof resolution === "object" && resolution.runId !== undefined) {
      if (resolution.runId !== req.runId) {
        throw new Error(`runId mismatch: expected ${req.runId}, got ${resolution.runId}`);
      }
    }

    const redactedReason = typeof rawReason === "string" ? redactText(rawReason) : undefined;
    const now = Date.now();

    if (decision === "denied") {
      req.status = "denied";
      req.resolvedAt = now;
      req.resolutionReason = redactedReason;
      req.deniedReason = redactedReason ?? "Request denied by user";
      req.instruction = "Command was denied. Please re-plan your task without this command.";
      this.pendingRequests.delete(approvalId);
      this.records.set(approvalId, req);

      await this.emitEvent({
        kind: "approval.resolved",
        runId: req.runId,
        actor: resolvedBy,
        skeletonId: req.skeletonId,
        data: {
          approvalId,
          decision: "denied",
          argv: req.argv,
          cwd: req.cwd,
          reason: req.deniedReason,
          instruction: req.instruction,
          refs: [],
        },
      });

      return req;
    }

    if (now > req.expiresAt) {
      req.status = "denied";
      req.resolvedAt = now;
      req.deniedReason = "Approval request expired past deadline";
      req.resolutionReason = req.deniedReason;
      req.instruction = "Command was denied due to deadline expiration. Please re-plan your task.";
      this.records.set(approvalId, req);
      return null;
    }

    req.status = "approved";
    req.resolvedAt = now;
    req.resolutionReason = redactedReason;
    const expiresAt = ttlMs ? now + ttlMs : req.expiresAt;
    req.expiresAt = expiresAt;

    const rawInputs = this.rawGrantInputs.get(approvalId);
    this.grantApproval(
      approvalId,
      req.skeletonId,
      rawInputs ? rawInputs.argv : req.argv,
      rawInputs ? rawInputs.cwd : req.cwd,
      expiresAt,
      req.runId
    );
    this.records.set(approvalId, req);

    // Run-scoped pattern approval: a `run_pattern` scope (or the
    // `approve_pattern` alias) records the resolved pattern for the run so any
    // later approval check in the same run that matches it auto-approves. A
    // `once` scope only ever approves the single request resolved here.
    const effectivePatternArgv = rawInputs ? rawInputs.argv : req.argv;
    const wantsRunPattern =
      scope === "run_pattern" ||
      scope === "pattern" ||
      (typeof resolution === "object" &&
        (resolution as ResolveApprovalParams).decision === "approve_pattern") ||
      resolution === "approve_pattern";
    if (wantsRunPattern) {
      const derived =
        (typeof explicitPattern === "string" ? explicitPattern : "").trim() ||
        deriveCommandPrefix(effectivePatternArgv);
      if (derived) {
        this.addPatternApproval(req.runId, derived, {
          command: Array.isArray(effectivePatternArgv)
            ? effectivePatternArgv.join(" ")
            : undefined,
          cwd: rawInputs ? rawInputs.cwd : req.cwd,
          skeletonId: req.skeletonId,
          approvedBy: resolvedBy,
        });
      }
    }

    await this.emitEvent({
      kind: "approval.resolved",
      runId: req.runId,
      actor: resolvedBy,
      skeletonId: req.skeletonId,
      data: {
        approvalId,
        decision: "approved",
        argv: req.argv,
        cwd: req.cwd,
        expiresAt,
        ...(redactedReason !== undefined ? { reason: redactedReason } : {}),
        refs: [],
      },
    });

    return req;
  }

  /**
   * Approves a pending request by approvalId and creates a one-time grant bound
   * to (skeletonId, sha256(argv), cwd). Emits approval.resolved.
   * Requirements: 20.6, 20.7.
   */
  async approveRequest(
    approvalId: string,
    options?: { ttlMs?: number; resolvedBy?: string; reason?: string; runId?: string }
  ): Promise<ApprovalGrant | null> {
    const res = await this.resolveApproval(approvalId, {
      decision: "approved",
      ttlMs: options?.ttlMs,
      resolvedBy: options?.resolvedBy,
      reason: options?.reason,
      runId: options?.runId,
    });
    if (!res) {
      return null;
    }
    return this.grantsByApprovalId.get(approvalId) ?? null;
  }

  /**
   * Denies a pending approval request.
   * Requirement 20.14: Treat unanswered requests past deadline as denied to trigger Skeleton re-planning.
   */
  async denyRequest(
    approvalId: string,
    reason?: string,
    options?: { resolvedBy?: string; runId?: string }
  ): Promise<ApprovalRequest | null> {
    return this.resolveApproval(approvalId, {
      decision: "denied",
      reason,
      resolvedBy: options?.resolvedBy,
      runId: options?.runId,
    });
  }

  /**
   * Checks and consumes a one-time grant.
   * Grants are valid for AT MOST ONE execution, and void if presented after expiresAt.
   * Requirements: 20.7, 20.8.
   */
  consumeGrant(
    skeletonId: string,
    argv: string[],
    cwd: string,
    approvalId?: string,
    expectedRunId?: string
  ): boolean {
    const argvSha256 = sha256Argv(argv);
    const key = this.makeGrantKey(skeletonId, argvSha256, cwd);
    const list = this.grants.get(key);

    if (!list || list.length === 0) {
      return false;
    }

    const now = Date.now();
    const matchesRunId = (g: ApprovalGrant): boolean => {
      if (!expectedRunId) {
        return true;
      }
      const grantRunId =
        (g as ApprovalGrant & { runId?: string }).runId ??
        this.records.get(g.approvalId)?.runId ??
        this.pendingRequests.get(g.approvalId)?.runId;
      if (grantRunId !== undefined && grantRunId !== expectedRunId) {
        return false;
      }
      return true;
    };

    let validIndex = -1;
    if (approvalId) {
      validIndex = list.findIndex(
        (g) =>
          g.approvalId === approvalId &&
          !g.used &&
          now <= g.expiresAt &&
          matchesRunId(g)
      );
    }
    if (validIndex === -1 && !approvalId) {
      validIndex = list.findIndex(
        (g) => !g.used && now <= g.expiresAt && matchesRunId(g)
      );
    }

    if (validIndex === -1) {
      // Clean up expired or already used grants
      const remaining = list.filter((g) => !g.used && now <= g.expiresAt);
      if (remaining.length === 0) {
        this.grants.delete(key);
      } else {
        this.grants.set(key, remaining);
      }
      return false;
    }

    // Mark used and remove grant (valid for at most one future execution)
    const grant = list[validIndex];
    grant.used = true;
    list.splice(validIndex, 1);
    if (list.length === 0) {
      this.grants.delete(key);
    }
    if (grant.approvalId) {
      this.grantsByApprovalId.delete(grant.approvalId);
      this.pendingRequests.delete(grant.approvalId);
      this.rawGrantInputs.delete(grant.approvalId);
    }
    return true;
  }

  /**
   * Stores a run-scoped pattern approval without altering Kiro permission files.
   * If RunStore is provided, records to RunStore.
   * Requirement 20.9.
   */
  addPatternApproval(
    runId: string,
    pattern: string,
    options?: {
      command?: string;
      cwd?: string;
      skeletonId?: string;
      approvedBy?: string;
      description?: string;
    }
  ): void {
    let patterns = this.runPatterns.get(runId);
    if (!patterns) {
      patterns = new Set();
      this.runPatterns.set(runId, patterns);
    }
    patterns.add(pattern);

    // Requirement 20.9: Store run-scoped pattern in RunStore without altering Kiro permission files
    if (this.runStore) {
      try {
        this.runStore.addApprovedPattern(runId, {
          pattern,
          command: options?.command ?? null,
          cwd: options?.cwd ?? null,
          skeletonId: options?.skeletonId ?? null,
          approvedBy: options?.approvedBy,
          description: options?.description,
        });
      } catch {
        // Safe fallback if run record does not exist in DB yet
      }
    }
  }

  /**
   * Checks if an argv matches any run-scoped pattern approval for that run.
   * Requirement 20.9.
   */
  isPatternApproved(
    runId: string,
    argv: string[],
    options?: { cwd?: string; skeletonId?: string }
  ): boolean {
    if (this.runStore) {
      try {
        if (this.runStore.isPatternApproved(runId, argv, options)) {
          return true;
        }
      } catch {
        // Fall back to in-memory patterns
      }
    }

    const patterns = this.runPatterns.get(runId);
    if (!patterns || patterns.size === 0) {
      return false;
    }

    const joined = argv.join(" ");
    const cmd = argv[0];

    for (const pat of patterns) {
      if (pat === cmd || pat === joined) {
        return true;
      }
      if (matchCommandPattern(pat, argv)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks if a command has an active approval (either one-time grant consumed or pattern approved).
   */
  checkAndConsumeApproval(
    runId: string,
    skeletonId: string,
    argv: string[],
    cwd: string,
    approvalId?: string
  ): boolean {
    if (this.isPatternApproved(runId, argv, { cwd, skeletonId })) {
      return true;
    }
    return this.consumeGrant(skeletonId, argv, cwd, approvalId, runId);
  }

  /**
   * Checks whether a pending approval request has expired.
   * Requirement 20.14: Treat unanswered requests past deadline as denied.
   */
  isRequestExpired(approvalId: string): boolean {
    // 1. Check if there is an active unconsumed approved grant
    const grant = this.grantsByApprovalId.get(approvalId);
    if (grant) {
      if (!grant.used && Date.now() <= grant.expiresAt) {
        return false;
      }
      return true;
    }

    // 2. Check pending request
    const req = this.pendingRequests.get(approvalId);
    if (!req) {
      return true;
    }

    if (req.status === "approved") {
      return Date.now() > req.expiresAt;
    }

    if (Date.now() > req.expiresAt) {
      req.status = "denied";
      req.deniedReason = "deadline_expired";
      req.instruction = "Command was denied due to deadline expiration. Please re-plan your task.";
      return true;
    }

    return false;
  }

  /**
   * Resolves an expired request as denied and returns instruction for Skeleton to re-plan.
   * Requirement 20.14.
   */
  async handleExpiredRequest(approvalId: string): Promise<{
    status: "denied";
    reason: string;
    instruction: string;
  } | null> {
    const grant = this.grantsByApprovalId.get(approvalId);
    if (grant && !grant.used && Date.now() <= grant.expiresAt) {
      return null;
    }

    const req = this.pendingRequests.get(approvalId);
    if (req && req.status === "approved" && Date.now() <= req.expiresAt) {
      return null;
    }

    if (req && Date.now() > req.expiresAt) {
      req.status = "denied";
      req.resolvedAt = Date.now();
      req.deniedReason = "Approval request unanswered past deadline; treated as denied (Requirement 20.14)";
      req.instruction = "Command was denied due to deadline expiration. Please re-plan your task.";
      this.pendingRequests.delete(approvalId);
      this.grantsByApprovalId.delete(approvalId);

      await this.emitEvent({
        kind: "approval.resolved",
        runId: req.runId,
        actor: "mcp_gateway",
        skeletonId: req.skeletonId,
        data: {
          approvalId,
          decision: "denied",
          argv: req.argv,
          cwd: req.cwd,
          reason: req.deniedReason,
          instruction: req.instruction,
          refs: [],
        },
      });

      return {
        status: "denied",
        reason: req.deniedReason,
        instruction: req.instruction,
      };
    }

    return {
      status: "denied",
      reason: "Approval request unknown or expired past deadline",
      instruction: "Command was denied. Please re-plan your task.",
    };
  }

  /**
   * Sweeps and expires all unanswered pending requests past their deadline.
   * Requirement 20.14: Treat unanswered requests past deadline as denied to trigger Skeleton re-planning.
   */
  async expireUnansweredRequests(runId?: string): Promise<ApprovalRequest[]> {
    const now = Date.now();
    const expired: ApprovalRequest[] = [];

    for (const [id, req] of this.pendingRequests.entries()) {
      if (runId && req.runId !== runId) {
        continue;
      }
      if (now > req.expiresAt) {
        req.status = "denied";
        req.resolvedAt = now;
        req.deniedReason = "Approval request unanswered past deadline; treated as denied (Requirement 20.14)";
        req.instruction = "Command was denied due to deadline expiration. Please re-plan your task.";
        this.pendingRequests.delete(id);
        expired.push(req);

        await this.emitEvent({
          kind: "approval.resolved",
          runId: req.runId,
          actor: "mcp_gateway",
          skeletonId: req.skeletonId,
          data: {
            approvalId: id,
            decision: "denied",
            argv: req.argv,
            cwd: req.cwd,
            reason: req.deniedReason,
            instruction: req.instruction,
            refs: [],
          },
        });
      }
    }

    return expired;
  }

  /**
   * Emits command.refused and formats blocked result for Skeleton.
   * Requirement 20.10: Refuse blocked commands by starting no process in any Box.
   */
  async refuseBlockedCommand(
    runId: string,
    skeletonId: string,
    role: string,
    argv: string[],
    reason: string,
    ruleId?: string
  ): Promise<{ status: "blocked"; reason: string }> {
    await this.emitEvent({
      kind: "command.refused",
      runId,
      actor: role.toLowerCase(),
      skeletonId,
      data: {
        argv,
        reason,
        ruleId: ruleId ?? "hard_block",
        refs: [],
      },
    });

    return {
      status: "blocked",
      reason,
    };
  }

  /**
   * Gets pending request by ID.
   */
  getPendingRequest(approvalId: string): ApprovalRequest | undefined {
    return this.pendingRequests.get(approvalId);
  }

  /**
   * Gets stored approval record by ID.
   */
  getApprovalRecord(approvalId: string): ApprovalRecord | undefined {
    return this.records.get(approvalId) ?? (this.pendingRequests.get(approvalId) as ApprovalRecord | undefined);
  }

  /**
   * Returns all currently pending requests.
   */
  getPendingRequests(runId?: string): ApprovalRequest[] {
    const all = Array.from(this.pendingRequests.values());
    if (runId) {
      return all.filter((r) => r.runId === runId);
    }
    return all;
  }

  /**
   * Cleans up expired grants and pending requests.
   */
  sweepExpired(): void {
    const now = Date.now();
    for (const [key, list] of this.grants.entries()) {
      const remaining = list.filter((g) => !g.used && now <= g.expiresAt);
      if (remaining.length === 0) {
        this.grants.delete(key);
      } else {
        this.grants.set(key, remaining);
      }
    }
    for (const [id, grant] of this.grantsByApprovalId.entries()) {
      if (grant.used || now > grant.expiresAt) {
        this.grantsByApprovalId.delete(id);
      }
    }
    for (const [id, req] of this.pendingRequests.entries()) {
      if (now > req.expiresAt) {
        this.pendingRequests.delete(id);
      }
    }
  }
}
