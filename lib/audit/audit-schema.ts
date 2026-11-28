// WP-29 Task 29.1: Promotion Gate audit schema, item catalog and validator engine.
//
// Models every C11 audit block (CR, PI, IS, NE, PO, AD, LG, SN, PR, RP, RL, SC, KI)
// plus the three extension items (XR-01, XR-02, XR-03) with explicit item IDs and
// severities (A / B / C). The validator enforces the conclusion rules:
//   - every item concludes as `Pass` or `Accepted risk` with an Owner signature,
//   - a severity `B` item marked `Accepted risk` must carry a non-empty rationale,
//   - unsigned / incomplete / unknown / duplicate audits are rejected cleanly.
//
// This module is pure (no I/O, no secrets) so it can be reused by the Admin route,
// the offline runner and the test-suite alike.

export type AuditSeverity = "A" | "B" | "C";

export type AuditConclusion = "Pass" | "Accepted risk";

export type AuditPhase = "G1" | "G3";

/** The thirteen C11 audit blocks. */
export type AuditBlockId =
  | "CR"
  | "PI"
  | "IS"
  | "NE"
  | "PO"
  | "AD"
  | "LG"
  | "SN"
  | "PR"
  | "RP"
  | "RL"
  | "SC"
  | "KI";

/** The three extension items introduced by this work package. */
export type AuditExtensionId = "XR-01" | "XR-02" | "XR-03";

export type AuditItemId = AuditBlockId | AuditExtensionId;

export interface AuditItemSpec {
  readonly id: AuditItemId;
  readonly kind: "block" | "extension";
  readonly severity: AuditSeverity;
  readonly title: string;
  /**
   * When true the item is a post-promotion item: it is only required on a `G3`
   * (post-promotion) audit and is not required on a `G1` (pre-promotion) audit.
   */
  readonly post: boolean;
}

/**
 * The authoritative item catalog. Severities are assigned deterministically so the
 * gate, the runner and the tests all agree on which items demand a written rationale
 * when a risk is accepted (severity `B`).
 */
export const AUDIT_ITEM_CATALOG: readonly AuditItemSpec[] = [
  { id: "CR", kind: "block", severity: "A", title: "Code review", post: false },
  { id: "PI", kind: "block", severity: "A", title: "Provenance integrity", post: false },
  { id: "IS", kind: "block", severity: "A", title: "Isolation", post: false },
  { id: "NE", kind: "block", severity: "B", title: "Necromancer configuration", post: false },
  { id: "PO", kind: "block", severity: "C", title: "Post-promotion operations", post: false },
  { id: "AD", kind: "block", severity: "B", title: "Admin surface", post: false },
  { id: "LG", kind: "block", severity: "C", title: "Logging", post: false },
  { id: "SN", kind: "block", severity: "A", title: "Sandbox network", post: false },
  { id: "PR", kind: "block", severity: "B", title: "Push restrictions", post: false },
  { id: "RP", kind: "block", severity: "B", title: "Repository privacy", post: true },
  { id: "RL", kind: "block", severity: "C", title: "Release licensing", post: true },
  { id: "SC", kind: "block", severity: "A", title: "Secret containment", post: false },
  { id: "KI", kind: "block", severity: "B", title: "Kiro key handling", post: false },
  { id: "XR-01", kind: "extension", severity: "A", title: "Box/sandbox teardown", post: false },
  { id: "XR-02", kind: "extension", severity: "A", title: "Kill switch levels", post: false },
  { id: "XR-03", kind: "extension", severity: "A", title: "Non-fork push refusal", post: false },
] as const;

/** Every item ID in catalog order. */
export const AUDIT_ITEM_IDS: readonly AuditItemId[] = AUDIT_ITEM_CATALOG.map(
  (spec) => spec.id
);

/** The subset of items that are post-promotion (`post`) items. */
export const AUDIT_POST_ITEM_IDS: readonly AuditItemId[] = AUDIT_ITEM_CATALOG.filter(
  (spec) => spec.post
).map((spec) => spec.id);

const CATALOG_BY_ID: ReadonlyMap<AuditItemId, AuditItemSpec> = new Map(
  AUDIT_ITEM_CATALOG.map((spec) => [spec.id, spec])
);

export function isAuditItemId(value: unknown): value is AuditItemId {
  return typeof value === "string" && CATALOG_BY_ID.has(value as AuditItemId);
}

export function getItemSpec(id: unknown): AuditItemSpec | undefined {
  if (!isAuditItemId(id)) {
    return undefined;
  }
  return CATALOG_BY_ID.get(id);
}

export function getItemSeverity(id: AuditItemId): AuditSeverity | undefined {
  return CATALOG_BY_ID.get(id)?.severity;
}

/** Item IDs required for a phase: G1 excludes post items, G3 requires everything. */
export function requiredItemIdsForPhase(phase: AuditPhase): AuditItemId[] {
  return AUDIT_ITEM_CATALOG.filter((spec) => (phase === "G3" ? true : !spec.post)).map(
    (spec) => spec.id
  );
}

export interface AuditItemConclusion {
  id: AuditItemId;
  conclusion: AuditConclusion;
  /** Owner signature for this item; must be a non-empty string. */
  owner: string;
  /** Required (non-empty) when a severity `B` item accepts a risk. */
  rationale?: string;
}

export interface AuditDocument {
  phase: AuditPhase;
  /** The signing actor; must be a non-empty string. */
  actor: string;
  items: AuditItemConclusion[];
}

export type AuditValidationCode =
  | "INVALID_DOCUMENT"
  | "UNSIGNED_DOCUMENT"
  | "UNKNOWN_ITEM"
  | "DUPLICATE_ITEM"
  | "MISSING_ITEM"
  | "INVALID_CONCLUSION"
  | "MISSING_OWNER_SIGNATURE"
  | "MISSING_RATIONALE";

export interface AuditValidationError {
  code: AuditValidationCode;
  message: string;
  itemId?: AuditItemId;
}

export interface AuditValidationResult {
  ok: boolean;
  errors: AuditValidationError[];
  phase: AuditPhase | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAuditPhase(value: unknown): value is AuditPhase {
  return value === "G1" || value === "G3";
}

export function isAuditConclusion(value: unknown): value is AuditConclusion {
  return value === "Pass" || value === "Accepted risk";
}

/** Type guard for a structured audit document (shallow structural check). */
export function isAuditDocument(value: unknown): value is AuditDocument {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (!isAuditPhase(value.phase)) {
    return false;
  }
  if (typeof value.actor !== "string") {
    return false;
  }
  if (!Array.isArray(value.items)) {
    return false;
  }
  return true;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates an audit document against the conclusion rules. Never throws: malformed
 * input is reported as an `INVALID_DOCUMENT` (or `UNSIGNED_DOCUMENT`) error so callers
 * can reject the audit cleanly.
 */
export function validateAuditDocument(doc: unknown): AuditValidationResult {
  const errors: AuditValidationError[] = [];

  if (!isPlainRecord(doc)) {
    return {
      ok: false,
      phase: null,
      errors: [
        {
          code: "INVALID_DOCUMENT",
          message: "Audit document must be an object with a phase, actor and items array.",
        },
      ],
    };
  }

  const phase = isAuditPhase(doc.phase) ? doc.phase : null;
  if (!phase) {
    errors.push({
      code: "INVALID_DOCUMENT",
      message: "Audit phase must be either 'G1' (pre-promotion) or 'G3' (post-promotion).",
    });
  }

  if (!nonEmptyString(doc.actor)) {
    errors.push({
      code: "UNSIGNED_DOCUMENT",
      message: "Audit document is unsigned: a non-empty actor is required.",
    });
  }

  const rawItems = doc.items;
  if (!Array.isArray(rawItems)) {
    errors.push({
      code: "INVALID_DOCUMENT",
      message: "Audit items must be an array of item conclusions.",
    });
    return { ok: false, errors, phase };
  }

  const seen = new Set<AuditItemId>();
  for (let i = 0; i < rawItems.length; i += 1) {
    const raw = rawItems[i];
    if (!isPlainRecord(raw)) {
      errors.push({
        code: "INVALID_DOCUMENT",
        message: `Audit item at index ${i} must be an object.`,
      });
      continue;
    }

    const id = raw.id;
    if (!isAuditItemId(id)) {
      errors.push({
        code: "UNKNOWN_ITEM",
        message: `Unknown audit item id at index ${i}: ${String(id)}.`,
      });
      continue;
    }

    if (seen.has(id)) {
      errors.push({
        code: "DUPLICATE_ITEM",
        message: `Audit item '${id}' is declared more than once.`,
        itemId: id,
      });
      continue;
    }
    seen.add(id);

    const conclusion = raw.conclusion;
    if (!isAuditConclusion(conclusion)) {
      errors.push({
        code: "INVALID_CONCLUSION",
        message: `Audit item '${id}' must conclude as 'Pass' or 'Accepted risk'.`,
        itemId: id,
      });
    }

    const owner = raw.owner;
    if (!nonEmptyString(owner)) {
      errors.push({
        code: "MISSING_OWNER_SIGNATURE",
        message: `Audit item '${id}' requires a non-empty Owner signature.`,
        itemId: id,
      });
    }

    const spec = CATALOG_BY_ID.get(id);
    const rationale = raw.rationale;
    if (
      spec &&
      spec.severity === "B" &&
      conclusion === "Accepted risk" &&
      !nonEmptyString(rationale)
    ) {
      errors.push({
        code: "MISSING_RATIONALE",
        message: `Audit item '${id}' is severity B and accepts a risk; a non-empty written rationale is required.`,
        itemId: id,
      });
    }
  }

  if (phase) {
    for (const requiredId of requiredItemIdsForPhase(phase)) {
      if (!seen.has(requiredId)) {
        errors.push({
          code: "MISSING_ITEM",
          message: `Audit is incomplete: required item '${requiredId}' is missing for phase ${phase}.`,
          itemId: requiredId,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, phase };
}

/** Convenience: builds a passing G1/G3 document where every item is `Pass`. */
export function buildPassingAuditDocument(
  phase: AuditPhase,
  actor: string,
  owner = actor
): AuditDocument {
  return {
    phase,
    actor,
    items: requiredItemIdsForPhase(phase).map((id) => ({
      id,
      conclusion: "Pass" as AuditConclusion,
      owner,
    })),
  };
}