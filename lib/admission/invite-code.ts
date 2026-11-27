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
 * Verified Admin session context. The Admin routes build this from `requireAdminAuth` as
 * `{ actor, adminSession: true }`; tests may pass an explicit `adminSession: { verified: true }`
 * or `isAdmin: true`. A bare `actor` string is NEVER sufficient on its own — `isVerifiedAdminContext`
 * requires an explicit verification signal so an unauthenticated caller cannot manage invite codes.
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

/** True only for a verified Admin session; a bare actor string is never sufficient on its own. */
export function isVerifiedAdminContext(ctx?: InviteCodeAdminContext | null): boolean {
  if (!ctx || typeof ctx !== "object") {
    return false;
  }
  if (ctx.isAdmin === true || ctx.adminSession === true) {
    return true;
  }
  const session = ctx.adminSession;
  return typeof session === "object" && session !== null && session.verified === true;
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
/** Upper bound on distinct per-IP attempt buckets so spoofed keys cannot exhaust memory. */
export const MAX_IP_TRACKING_BUCKETS = 10_000;
/**
 * Bounded, saturating fallback ceiling on total verification attempts per window for the whole
 * instance. It guards the coarse limit even after per-IP buckets have been evicted under pressure.
 */
export const MAX_GLOBAL_FALLBACK_ATTEMPTS = 10_000;

/** Per-IP sliding-window attempt bucket; `lastSeenMs` drives LRU eviction. */
interface AttemptBucket {
  timestamps: number[];
  lastSeenMs: number;
}
export class InviteCodeService {
  private readonly runStore: RunStore;
  private readonly now: () => number;
  private readonly maxAttemptsPerIp: number;
  private readonly attemptWindowMs: number;
  private readonly codeBytes: number;
  private readonly attemptsByIp = new Map<string, AttemptBucket>();
  /** Saturating, bounded global attempt counter for the current window (fallback limit). */
  private globalFallbackCount = 0;
  private globalFallbackWindowStart = 0;

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

  /** Sanitized list — never exposes the plaintext code or the stored salt. Admin-only. */
  listCodes(admin?: InviteCodeAdminContext | null): SanitizedInviteCode[] {
    this.assertAdmin(admin);
    return this.runStore.listInviteCodes().map(sanitizeInviteCode);
  }

  /**
   * Sanitized single record by hash (or plaintext) — never exposes the plaintext code or the stored
   * salt. Admin-only: a disclosed raw hash must not be readable unauthenticated.
   */
  getCode(
    codeOrHash: string,
    admin?: InviteCodeAdminContext | null
  ): SanitizedInviteCode | null {
    this.assertAdmin(admin);
    const record = this.resolveRecord(codeOrHash);
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
    const trimmed = codeOrHash.trim();
    const resolved = this.resolveRecord(trimmed);
    const ok = this.runStore.revokeInviteCode(resolved ? resolved.codeHash : trimmed);
    const codeHash = resolved?.codeHash ?? undefined;
    return codeHash ? { ok, codeHash } : { ok };
  }

  /**
   * Consumes one allowed run from an Invite_Code (Requirement 31.7). A verified plaintext code is
   * sufficient; a bare hash (which may have been disclosed elsewhere) additionally requires a
   * verified Admin context so it cannot be replayed unauthenticated.
   */
  consumeRun(codeOrHash: string, admin?: InviteCodeAdminContext | null): boolean {
    if (typeof codeOrHash !== "string" || codeOrHash.trim().length === 0) {
      return false;
    }
    const trimmed = codeOrHash.trim();
    // A verified plaintext resolves through the salt-compare lookup; a non-valid status here means
    // the caller presented a plaintext that maps to a known-but-unusable code (never a raw hash).
    const details = this.runStore.lookupInviteCodeDetails(trimmed);
    if (details.valid) {
      return this.runStore.consumeInviteCodeRun(details.codeHash ?? "");
    }
    if (details.codeHash) {
      return false;
    }
    // No plaintext match: treat the value as a raw hash, which requires a verified Admin context.
    this.assertAdmin(admin);
    const direct = this.runStore.getInviteCodeByHash(trimmed);
    if (!direct) {
      return false;
    }
    return this.runStore.consumeInviteCodeRun(direct.codeHash);
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
    this.globalFallbackCount = 0;
    this.globalFallbackWindowStart = 0;
  }

  /**
   * Number of retained attempt timestamps for a client key inside the active window. Exposed so the
   * per-IP bucket growth can be asserted bounded (it never exceeds `maxAttemptsPerIp`).
   */
  attemptWindowSizeForIp(clientIp?: string): number {
    const ip =
      typeof clientIp === "string" && clientIp.trim().length > 0 ? clientIp.trim() : "unknown";
    const cutoff = this.now() - this.attemptWindowMs;
    return (this.attemptsByIp.get(ip)?.timestamps ?? []).filter((ts) => ts > cutoff).length;
  }

  private recordAndCheckRateLimit(
    ip: string,
    now: number
  ): { limited: boolean; retryAfterMs: number } {
    const cutoff = now - this.attemptWindowMs;
    const existing = this.attemptsByIp.get(ip);
    const pruned = (existing?.timestamps ?? []).filter((ts) => ts > cutoff);

    // Per-IP limit is enforced BEFORE a new timestamp is pushed. Once the bucket already holds
    // `maxAttemptsPerIp` live timestamps the request is rate-limited without recording another
    // timestamp, so the per-IP array can never grow past `maxAttemptsPerIp` under a flood.
    if (pruned.length >= this.maxAttemptsPerIp) {
      this.attemptsByIp.set(ip, { timestamps: pruned, lastSeenMs: now });
      this.pruneAttemptBuckets(cutoff);
      const oldest = pruned[0];
      const retryAfterMs = Math.max(1, this.attemptWindowMs - (now - oldest));
      return { limited: true, retryAfterMs };
    }

    pruned.push(now);
    this.attemptsByIp.set(ip, { timestamps: pruned, lastSeenMs: now });
    this.pruneAttemptBuckets(cutoff);

    // Saturating, bounded global fallback: when the per-IP map is saturated every bucket was
    // evicted at least once, so per-IP tracking is unreliable; a single bounded counter still caps
    // total attempts for the window without growing memory.
    if (now - this.globalFallbackWindowStart >= this.attemptWindowMs) {
      this.globalFallbackWindowStart = now;
      this.globalFallbackCount = 0;
    }
    this.globalFallbackCount = Math.min(
      this.globalFallbackCount + 1,
      MAX_GLOBAL_FALLBACK_ATTEMPTS
    );
    if (
      this.attemptsByIp.size >= MAX_IP_TRACKING_BUCKETS &&
      this.globalFallbackCount >= MAX_GLOBAL_FALLBACK_ATTEMPTS
    ) {
      return { limited: true, retryAfterMs: this.attemptWindowMs };
    }

    return { limited: false, retryAfterMs: 0 };
  }

  /**
   * Drops every attempt bucket whose timestamps have all aged out, then caps the map at
   * {@link MAX_IP_TRACKING_BUCKETS} keys. Eviction is least-recently-seen (`lastSeenMs`) LRU rather
   * than oldest-inserted, so a flood of distinct client keys can never grow the per-instance
   * tracking map without bound while active buckets survive longest.
   */
  private pruneAttemptBuckets(cutoff: number): void {
    for (const [key, bucket] of this.attemptsByIp) {
      const live = bucket.timestamps.filter((ts) => ts > cutoff);
      if (live.length === 0) {
        this.attemptsByIp.delete(key);
      } else if (live.length !== bucket.timestamps.length) {
        bucket.timestamps = live;
      }
    }
    if (this.attemptsByIp.size <= MAX_IP_TRACKING_BUCKETS) {
      return;
    }
    const overflow = this.attemptsByIp.size - MAX_IP_TRACKING_BUCKETS;
    const byLastSeen = [...this.attemptsByIp.entries()].sort(
      (a, b) => a[1].lastSeenMs - b[1].lastSeenMs
    );
    for (let i = 0; i < overflow && i < byLastSeen.length; i += 1) {
      this.attemptsByIp.delete(byLastSeen[i][0]);
    }
  }

  /** Resolves a trimmed plaintext-or-hash value to its stored record, or `null`. */
  private resolveRecord(codeOrHash: string): InviteCodeRecord | null {
    if (typeof codeOrHash !== "string") {
      return null;
    }
    const trimmed = codeOrHash.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const direct = this.runStore.getInviteCodeByHash(trimmed);
    if (direct) {
      return direct;
    }
    const details = this.runStore.lookupInviteCodeDetails(trimmed);
    if (details.codeHash) {
      return this.runStore.getInviteCodeByHash(details.codeHash);
    }
    return null;
  }

}

