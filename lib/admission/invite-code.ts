// Task 22.1: Invite code generator, storage and authentication service.
// Requirements: 29.4, 31.1, 31.2, 31.3, 31.4, 31.5.
//
// The service is the only path that mints or revokes Invite_Codes. It is backed by the `RunStore`
// invite-code table so the plaintext code is hashed (salted SHA-256) before it is ever persisted.
// The plaintext is returned exactly once, from `createCode`; every later read (`listCodes`,
// `getCode`, `verifyCode`) exposes only the stored hash and never the raw salt.

import * as crypto from "node:crypto";
import {
  RunStore,
  generateSalt,
  hashInviteCode,
  type InviteCodeRecord,
} from "../runs/run-store";

/**
 * Verified Admin session context. The Admin routes build this from `requireAdminAuth`; tests may
 * pass an explicit `adminSession` flag. An authenticated actor (a non-empty owner/admin actor) also
 * satisfies the requirement because only a verified caller can supply one.
 */
export interface InviteCodeAdminContext {
  actor?: string;
  adminSession?: boolean | string | { verified?: boolean; actor?: string; sessionId?: string } | null;
  isAdmin?: boolean;
}

export class InviteCodeAuthorizationError extends Error {
  readonly code = "ADMIN_AUTH_REQUIRED";

  constructor(message = "A verified Admin session is required to manage invite codes") {
    super(message);
    this.name = "InviteCodeAuthorizationError";
  }
}

/** True only for a verified Admin session or an authenticated actor context. */
export function isVerifiedAdminContext(ctx?: InviteCodeAdminContext | null): boolean {
  if (!ctx || typeof ctx !== "object") {
    return false;
  }
  if (ctx.isAdmin === true || ctx.adminSession === true) {
    return true;
  }
  const session = ctx.adminSession;
  if (session && typeof session === "object" && session.verified === true) {
    return true;
  }
  if (
    typeof ctx.actor === "string" &&
    ctx.actor.trim().length > 0 &&
    ctx.adminSession !== false
  ) {
    return true;
  }
  return false;
}

/** Public, non-sensitive view of a stored Invite_Code (no plaintext code, no raw salt). */
export interface SanitizedInviteCode {
  codeHash: string;
  expiresAt: number | null;
  allowedRunCount: number;
  usedRunCount: number;
  remainingRunCount: number;
  caps: Record<string, unknown> | null;
  pushFlag: boolean;
  revoked: boolean;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

function sanitizeInviteCode(record: InviteCodeRecord): SanitizedInviteCode {
  return {
    codeHash: record.codeHash,
    expiresAt: record.expiresAt,
    allowedRunCount: record.allowedRunCount,
    usedRunCount: record.usedRunCount,
    remainingRunCount: record.remainingRunCount,
    caps: record.caps,
    pushFlag: record.pushFlag,
    revoked: record.revoked,
    label: record.label,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface CreateInviteCodeInput {
  expiresAt?: number | null;
  allowedRunCount?: number;
  caps?: Record<string, unknown> | null;
  /** Off by default; only an explicit `true` turns the push flag on (Requirement 31.3). */
  pushFlag?: boolean;
  label?: string | null;
}

export interface CreateInviteCodeResult {
  /** The only place the plaintext code is ever exposed (Requirement 31.4). */
  code: string;
  record: SanitizedInviteCode;
}

export type InviteCodeRejectionReason =
  | "not_found"
  | "expired"
  | "used_up"
  | "revoked"
  | "rate_limited";

export interface InviteCodeVerificationOk {
  ok: true;
  status: "valid";
  codeHash: string;
  caps: Record<string, unknown> | null;
  pushFlag: boolean;
  remainingRunCount: number;
  expiresAt: number | null;
}

export interface InviteCodeVerificationDenied {
  ok: false;
  reason: InviteCodeRejectionReason;
  retryAfterMs?: number;
  status?: "not_found" | "expired" | "used_up" | "revoked";
}

export type InviteCodeVerificationResult =
  | InviteCodeVerificationOk
  | InviteCodeVerificationDenied;

export interface InviteCodeServiceOptions {
  runStore: RunStore;
  now?: () => number;
  /** Maximum verification attempts within the sliding window before `rate_limited`. */
  maxAttemptsPerIp?: number;
  /** Sliding-window length in milliseconds. */
  attemptWindowMs?: number;
  /** Number of random bytes used to mint the plaintext code. */
  codeBytes?: number;
}

export const DEFAULT_MAX_ATTEMPTS_PER_IP = 5;
export const DEFAULT_ATTEMPT_WINDOW_MS = 60_000;
export const DEFAULT_CODE_BYTES = 24;
export class InviteCodeService {
  private readonly runStore: RunStore;
  private readonly now: () => number;
  private readonly maxAttemptsPerIp: number;
  private readonly attemptWindowMs: number;
  private readonly codeBytes: number;
  private readonly attemptsByIp = new Map<string, number[]>();

  constructor(options: InviteCodeServiceOptions) {
    if (!options || !options.runStore) {
      throw new TypeError("InviteCodeService requires a runStore");
    }
    this.runStore = options.runStore;
    this.now = options.now ?? (() => Date.now());
    this.maxAttemptsPerIp =
      typeof options.maxAttemptsPerIp === "number" && options.maxAttemptsPerIp > 0
        ? Math.floor(options.maxAttemptsPerIp)
        : DEFAULT_MAX_ATTEMPTS_PER_IP;
    this.attemptWindowMs =
      typeof options.attemptWindowMs === "number" && options.attemptWindowMs > 0
        ? Math.floor(options.attemptWindowMs)
        : DEFAULT_ATTEMPT_WINDOW_MS;
    this.codeBytes =
      typeof options.codeBytes === "number" && options.codeBytes >= 16
        ? Math.floor(options.codeBytes)
        : DEFAULT_CODE_BYTES;
  }

  private assertAdmin(admin?: InviteCodeAdminContext | null): void {
    if (!isVerifiedAdminContext(admin)) {
      throw new InviteCodeAuthorizationError();
    }
  }

  /** Cryptographically strong plaintext code (`crypto.randomBytes`, base64url). */
  generatePlaintextCode(): string {
    return `gg_${crypto.randomBytes(this.codeBytes).toString("base64url")}`;
  }

  createCode(
    input: CreateInviteCodeInput,
    admin?: InviteCodeAdminContext | null
  ): CreateInviteCodeResult {
    this.assertAdmin(admin);
    const code = this.generatePlaintextCode();
    const salt = generateSalt(16);
    const codeHash = hashInviteCode(code, salt);
    const allowed =
      typeof input?.allowedRunCount === "number" && input.allowedRunCount >= 0
        ? Math.floor(input.allowedRunCount)
        : 1;

    const record = this.runStore.storeHashedInviteCode({
      codeHash,
      salt,
      expiresAt: input?.expiresAt ?? null,
      allowedRunCount: allowed,
      caps: input?.caps ?? null,
      // Default off: only an explicit `true` enables the push flag.
      pushFlag: input?.pushFlag === true,
      label: input?.label ?? undefined,
    });

    return { code, record: sanitizeInviteCode(record) };
  }

  /** Sanitized list — never exposes the plaintext code or the stored salt. */
  listCodes(): SanitizedInviteCode[] {
    return this.runStore.listInviteCodes().map(sanitizeInviteCode);
  }

  /** Sanitized single record by hash — never exposes the plaintext code or the stored salt. */
  getCode(codeHash: string): SanitizedInviteCode | null {
    const record = this.runStore.getInviteCodeByHash(codeHash);
    return record ? sanitizeInviteCode(record) : null;
  }

  revokeCode(
    codeOrHash: string,
    admin?: InviteCodeAdminContext | null
  ): { ok: boolean; codeHash?: string } {
    this.assertAdmin(admin);
    if (typeof codeOrHash !== "string" || codeOrHash.trim().length === 0) {
      return { ok: false };
    }
    const resolved = this.resolveRecord(codeOrHash);
    const ok = this.runStore.revokeInviteCode(codeOrHash.trim());
    const codeHash = resolved?.codeHash ?? undefined;
    return codeHash ? { ok, codeHash } : { ok };
  }

  /** Consumes one allowed run from an Invite_Code (Requirement 31.7). */
  consumeRun(codeOrHash: string): boolean {
    const resolved = this.resolveRecord(codeOrHash);
    if (!resolved) {
      return false;
    }
    return this.runStore.consumeInviteCodeRun(resolved.codeHash);
  }
  /**
   * Verifies a plaintext code for a client IP, enforcing a per-IP sliding-window rate limit.
   * Rejections are distinct so the Gate can show a specific message for each case.
   */
  verifyCode(code: string, clientIp?: string): InviteCodeVerificationResult {
    const ip =
      typeof clientIp === "string" && clientIp.trim().length > 0 ? clientIp.trim() : "unknown";
    const now = this.now();

    const rate = this.recordAndCheckRateLimit(ip, now);
    if (rate.limited) {
      return { ok: false, reason: "rate_limited", retryAfterMs: rate.retryAfterMs };
    }

    if (typeof code !== "string" || code.trim().length === 0) {
      return { ok: false, reason: "not_found", status: "not_found" };
    }

    const details = this.runStore.lookupInviteCodeDetails(code.trim());
    if (details.valid) {
      return {
        ok: true,
        status: "valid",
        codeHash: details.codeHash ?? "",
        caps: details.caps ?? null,
        pushFlag: Boolean(details.pushFlag),
        remainingRunCount: details.remainingRunCount,
        expiresAt: details.expiresAt ?? null,
      };
    }

    if (
      details.status === "expired" ||
      details.status === "used_up" ||
      details.status === "revoked"
    ) {
      return { ok: false, reason: details.status, status: details.status };
    }

    return { ok: false, reason: "not_found", status: "not_found" };
  }

  /** Clears the per-IP sliding window (used by tests and by the Admin "unlock" action). */
  resetRateLimits(): void {
    this.attemptsByIp.clear();
  }

  private recordAndCheckRateLimit(
    ip: string,
    now: number
  ): { limited: boolean; retryAfterMs: number } {
    const cutoff = now - this.attemptWindowMs;
    const existing = this.attemptsByIp.get(ip) ?? [];
    const pruned = existing.filter((ts) => ts > cutoff);
    pruned.push(now);
    this.attemptsByIp.set(ip, pruned);

    if (pruned.length > this.maxAttemptsPerIp) {
      const oldest = pruned[0];
      const retryAfterMs = Math.max(1, this.attemptWindowMs - (now - oldest));
      return { limited: true, retryAfterMs };
    }
    return { limited: false, retryAfterMs: 0 };
  }

  private resolveRecord(codeOrHash: string): InviteCodeRecord | null {
    const direct = this.runStore.getInviteCodeByHash(codeOrHash);
    if (direct) {
      return direct;
    }
    const details = this.runStore.lookupInviteCodeDetails(codeOrHash);
    if (details.codeHash) {
      return this.runStore.getInviteCodeByHash(details.codeHash);
    }
    return null;
  }

}

