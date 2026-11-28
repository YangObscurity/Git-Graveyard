// WP-29 Task 29.1: Deterministic promotion gate.
//
// Reads a signed pre-promotion (`G1`) audit record, verifies its HMAC exactly the way
// the Admin route does (canonical JSON + timing-safe compare + prototype-pollution
// rejection) and answers the three production gate questions:
//   - may production credentials be issued?
//   - may a public production URL be published?
//   - may the Necromancer switch to production mode?
//
// All three are refused until a signed `G1` audit record passes validation. The module
// never logs or persists raw secrets; it only handles the server-side admin secret to
// verify the record signature.

import * as crypto from "node:crypto";
import {
  type AuditPhase,
  type AuditValidationResult,
  isAuditDocument,
  validateAuditDocument,
} from "./audit-schema";

/** Structurally compatible with the record persisted by the Admin route. */
export interface PromotionAuditRecord {
  actor: string;
  signedAt: number;
  status: string;
  signature: string;
  items: unknown;
}

/** Recursively sorts object keys so the signed payload is stable. */
function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      out[key] = canonicalizeValue(source[key]);
    }
    return out;
  }
  return value;
}

function canonicalizeRecord(
  record: Omit<PromotionAuditRecord, "signature">
): string {
  return JSON.stringify(
    canonicalizeValue({
      actor: record.actor,
      signedAt: record.signedAt,
      status: record.status,
      items: record.items ?? null,
    })
  );
}

function sign(secret: string, canonical: string): string {
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

/** True when a reserved prototype-pollution key appears anywhere in `value`. */
export function containsReservedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsReservedKey);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return true;
      }
      if (containsReservedKey(source[key])) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Verifies a stored record's HMAC against `secret` using the same canonicalization as
 * the Admin route. A record whose items carry a reserved key can never be proven
 * authentic (the signed payload would have stripped it) and is reported as unverified.
 */
export function verifyPromotionRecordSignature(
  record: PromotionAuditRecord | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!record || !secret) {
    return false;
  }
  if (containsReservedKey(record.items)) {
    return false;
  }
  const expected = sign(secret, canonicalizeRecord(record));
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(record.signature, "utf8");
  try {
    return (
      expectedBuf.length === actualBuf.length &&
      crypto.timingSafeEqual(expectedBuf, actualBuf)
    );
  } catch {
    return false;
  }
}

export interface CreateSignedRecordInput {
  actor: string;
  status: string;
  items: unknown;
  secret: string;
  signedAt?: number;
}

/**
 * Produces a signed record identical in shape to the Admin route's persisted record.
 * Exposed so the gate, the runner and tests can mint records without touching the DB.
 */
export function createSignedPromotionAuditRecord(
  input: CreateSignedRecordInput
): PromotionAuditRecord {
  const signedAt = typeof input.signedAt === "number" ? input.signedAt : Date.now();
  const record: Omit<PromotionAuditRecord, "signature"> = {
    actor: input.actor,
    signedAt,
    status: input.status,
    items: input.items ?? null,
  };
  const signature = sign(input.secret, canonicalizeRecord(record));
  return { ...record, signature };
}

export interface PromotionGateInput {
  record: PromotionAuditRecord | null | undefined;
  /** Server-only admin secret used to verify the record signature. */
  secret?: string | null;
}

export interface PromotionGateSnapshot {
  present: boolean;
  verified: boolean;
  phase: AuditPhase | null;
  /** True only when a verified record is a passing `G1` audit. */
  g1Passed: boolean;
  validation: AuditValidationResult | null;
  signedAt: number | null;
}

/**
 * Evaluates the stored record into a gate snapshot. A missing, unverifiable, malformed
 * or failing record yields `g1Passed: false`, which denies every production action.
 */
export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateSnapshot {
  const record = input.record ?? null;
  if (!record) {
    return {
      present: false,
      verified: false,
      phase: null,
      g1Passed: false,
      validation: null,
      signedAt: null,
    };
  }

  const verified = verifyPromotionRecordSignature(record, input.secret);
  const signedAt = typeof record.signedAt === "number" ? record.signedAt : null;
  if (!verified) {
    return {
      present: true,
      verified: false,
      phase: null,
      g1Passed: false,
      validation: null,
      signedAt,
    };
  }

  const doc: unknown = record.items;
  const validation = validateAuditDocument(doc);
  const phase = isAuditDocument(doc) ? doc.phase : validation.phase;
  const g1Passed = validation.ok && phase === "G1";

  return {
    present: true,
    verified: true,
    phase,
    g1Passed,
    validation,
    signedAt,
  };
}

export type ProductionGateAction =
  | "issue_production_credentials"
  | "publish_production_url"
  | "switch_necromancer_to_production";

export type ProductionGateCode =
  | "G1_AUDIT_REQUIRED"
  | "G1_AUDIT_INVALID"
  | "G1_AUDIT_UNSIGNED"
  | "PRODUCTION_ALLOWED";

export interface GateDecision {
  action: ProductionGateAction;
  allowed: boolean;
  code: ProductionGateCode;
  reason: string;
}

const ACTION_LABELS: Record<ProductionGateAction, string> = {
  issue_production_credentials: "issue production credentials",
  publish_production_url: "publish a public production URL",
  switch_necromancer_to_production: "switch the Necromancer to production mode",
};

function denyReason(snapshot: PromotionGateSnapshot): {
  code: ProductionGateCode;
  reason: string;
} {
  if (!snapshot.present) {
    return {
      code: "G1_AUDIT_REQUIRED",
      reason: "No signed pre-promotion (G1) audit record is present.",
    };
  }
  if (!snapshot.verified) {
    return {
      code: "G1_AUDIT_UNSIGNED",
      reason: "The pre-promotion (G1) audit record could not be verified as authentic.",
    };
  }
  return {
    code: "G1_AUDIT_INVALID",
    reason: "The pre-promotion (G1) audit record did not pass validation.",
  };
}

/** Decides one production action from a gate snapshot. */
export function decideProductionGate(
  action: ProductionGateAction,
  snapshot: PromotionGateSnapshot
): GateDecision {
  if (snapshot.g1Passed) {
    return {
      action,
      allowed: true,
      code: "PRODUCTION_ALLOWED",
      reason: `Allowed: a signed pre-promotion (G1) audit record passed.`,
    };
  }
  const { code, reason } = denyReason(snapshot);
  return {
    action,
    allowed: false,
    code,
    reason: `Refused: cannot ${ACTION_LABELS[action]} — ${reason}`,
  };
}

export function canIssueProductionCredentials(
  snapshot: PromotionGateSnapshot
): GateDecision {
  return decideProductionGate("issue_production_credentials", snapshot);
}

export function canPublishProductionUrl(snapshot: PromotionGateSnapshot): GateDecision {
  return decideProductionGate("publish_production_url", snapshot);
}

export function canSwitchNecromancerToProduction(
  snapshot: PromotionGateSnapshot
): GateDecision {
  return decideProductionGate("switch_necromancer_to_production", snapshot);
}

export interface ProductionReadiness {
  snapshot: PromotionGateSnapshot;
  issueProductionCredentials: GateDecision;
  publishProductionUrl: GateDecision;
  switchNecromancerToProduction: GateDecision;
  allowed: boolean;
}

/** Evaluates all three production gate decisions at once. */
export function checkProductionReadiness(
  input: PromotionGateInput
): ProductionReadiness {
  const snapshot = evaluatePromotionGate(input);
  const issueProductionCredentials = canIssueProductionCredentials(snapshot);
  const publishProductionUrl = canPublishProductionUrl(snapshot);
  const switchNecromancerToProduction = canSwitchNecromancerToProduction(snapshot);
  return {
    snapshot,
    issueProductionCredentials,
    publishProductionUrl,
    switchNecromancerToProduction,
    allowed:
      issueProductionCredentials.allowed &&
      publishProductionUrl.allowed &&
      switchNecromancerToProduction.allowed,
  };
}

/**
 * Throws when a production action is not allowed. Callers on the credential-issuance,
 * URL-publication and production-mode-switch paths use this as the deterministic block.
 */
export function assertProductionAllowed(
  action: ProductionGateAction,
  snapshot: PromotionGateSnapshot
): void {
  const decision = decideProductionGate(action, snapshot);
  if (!decision.allowed) {
    const err = new Error(decision.reason) as Error & {
      code?: ProductionGateCode;
      gate?: GateDecision;
    };
    err.code = decision.code;
    err.gate = decision;
    throw err;
  }
}

/** Type re-export so callers can reference the audit document type from the gate. */
export type { AuditDocument } from "./audit-schema";