// Task 9.3: Model allowlist and role tier registry
// Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.9, 15.10

/**
 * The three allowed Claude 5.5 model IDs recorded from the specification.
 * Auto is explicitly excluded and never allowed.
 */
const DEFAULT_HAIKU_MODEL_ID = "claude-haiku-5.5" as const;
const DEFAULT_SONNET_MODEL_ID = "claude-sonnet-5.5" as const;
const DEFAULT_OPUS_MODEL_ID = "claude-opus-5.5" as const;

/**
 * Resolves a model ID from an optional override (for example an environment variable).
 * Blank values and "auto" are ignored so the allowlist can never admit auto.
 */
export function resolveModelId(override: string | undefined, fallback: string): string {
  const trimmed = override?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.toLowerCase() === "auto") {
    return fallback;
  }
  return trimmed;
}

/**
 * The names below keep their "5_5" form for compatibility. Accounts that cannot use
 * the Claude 5.5 models can set GG_MODEL_OPUS / GG_MODEL_SONNET / GG_MODEL_HAIKU.
 * The literal types stay as the defaults; the runtime value follows the override.
 */
export const CLAUDE_HAIKU_5_5_MODEL_ID = resolveModelId(
  process.env.GG_MODEL_HAIKU,
  DEFAULT_HAIKU_MODEL_ID
) as typeof DEFAULT_HAIKU_MODEL_ID;
export const CLAUDE_SONNET_5_5_MODEL_ID = resolveModelId(
  process.env.GG_MODEL_SONNET,
  DEFAULT_SONNET_MODEL_ID
) as typeof DEFAULT_SONNET_MODEL_ID;
export const CLAUDE_OPUS_5_5_MODEL_ID = resolveModelId(
  process.env.GG_MODEL_OPUS,
  DEFAULT_OPUS_MODEL_ID
) as typeof DEFAULT_OPUS_MODEL_ID;

export const ALLOWED_MODEL_IDS = [
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
] as const;

export type AllowedModelId = (typeof ALLOWED_MODEL_IDS)[number];

/**
 * Excluded model IDs. Auto must never be allowed.
 */
export const AUTO_MODEL_ID = "auto" as const;
export const EXCLUDED_MODEL_IDS = ["auto", "Auto", "AUTO"] as const;

/**
 * Human-readable model tier names.
 */
export const MODEL_TIER_HAIKU = "Claude Haiku 5.5" as const;
export const MODEL_TIER_SONNET = "Claude Sonnet 5.5" as const;
export const MODEL_TIER_OPUS = "Claude Opus 5.5" as const;

export type ModelTier =
  | typeof MODEL_TIER_HAIKU
  | typeof MODEL_TIER_SONNET
  | typeof MODEL_TIER_OPUS;

export const MODEL_TIER_BY_ID: Readonly<Record<AllowedModelId, ModelTier>> = {
  [CLAUDE_HAIKU_5_5_MODEL_ID]: MODEL_TIER_HAIKU,
  [CLAUDE_SONNET_5_5_MODEL_ID]: MODEL_TIER_SONNET,
  [CLAUDE_OPUS_5_5_MODEL_ID]: MODEL_TIER_OPUS,
} as const;

export const MODEL_ID_BY_TIER: Readonly<Record<ModelTier, AllowedModelId>> = {
  [MODEL_TIER_HAIKU]: CLAUDE_HAIKU_5_5_MODEL_ID,
  [MODEL_TIER_SONNET]: CLAUDE_SONNET_5_5_MODEL_ID,
  [MODEL_TIER_OPUS]: CLAUDE_OPUS_5_5_MODEL_ID,
} as const;

/**
 * Standard Skeleton roles.
 */
export type SkeletonRole =
  | "planner"
  | "exhumer"
  | "bonesetter"
  | "soul-stitcher"
  | "warden"
  | "scribe";

export const ALL_SKELETON_ROLES: readonly SkeletonRole[] = [
  "planner",
  "exhumer",
  "bonesetter",
  "soul-stitcher",
  "warden",
  "scribe",
] as const;

/**
 * Default assigned model ID per role.
 * Requirement 15.3:
 * - Opus 5.5 for Planner and Warden
 * - Sonnet 5.5 for Bonesetter and Soul-stitcher
 * - Haiku 5.5 for Exhumer triage session and Scribe
 */
export const ROLE_DEFAULT_MODELS: Readonly<Record<SkeletonRole, AllowedModelId>> = {
  planner: CLAUDE_OPUS_5_5_MODEL_ID,
  warden: CLAUDE_OPUS_5_5_MODEL_ID,
  bonesetter: CLAUDE_SONNET_5_5_MODEL_ID,
  "soul-stitcher": CLAUDE_SONNET_5_5_MODEL_ID,
  exhumer: CLAUDE_HAIKU_5_5_MODEL_ID,
  scribe: CLAUDE_HAIKU_5_5_MODEL_ID,
} as const;

export const ROLE_DEFAULT_TIERS: Readonly<Record<SkeletonRole, ModelTier>> = {
  planner: MODEL_TIER_OPUS,
  warden: MODEL_TIER_OPUS,
  bonesetter: MODEL_TIER_SONNET,
  "soul-stitcher": MODEL_TIER_SONNET,
  exhumer: MODEL_TIER_HAIKU,
  scribe: MODEL_TIER_HAIKU,
} as const;

/**
 * Standard reason string for model mismatch failures.
 */
export const MODEL_MISMATCH_REASON = "model_mismatch" as const;
export type ModelMismatchReason = typeof MODEL_MISMATCH_REASON;

/**
 * Default effort level while Probe P4 effort values are not recorded.
 * Requirement 15.10.
 */
export const DEFAULT_EFFORT_LEVEL = "default" as const;

/**
 * Options for role tier assignment and escalation.
 */
export interface RoleModelAssignmentOptions {
  /**
   * Requirement 15.4: If a task is marked hard: yes, Soul-stitcher escalates to Opus 5.5.
   */
  readonly hard?: boolean | string | null;
}

/**
 * Normalizes role name to standard SkeletonRole if recognized.
 */
export function normalizeRole(role: string): SkeletonRole | null {
  if (typeof role !== "string") {
    return null;
  }
  const norm = role.trim().toLowerCase().replace(/_/g, "-");
  if (norm === "soulstitcher") {
    return "soul-stitcher";
  }
  if ((ALL_SKELETON_ROLES as readonly string[]).includes(norm)) {
    return norm as SkeletonRole;
  }
  return null;
}

/**
 * Pure check whether a model ID is "auto" (case-insensitive).
 * Requirement 15.2: Auto must be excluded from allowlist.
 */
export function isAutoModel(modelId: unknown): boolean {
  if (typeof modelId !== "string") {
    return false;
  }
  return modelId.trim().toLowerCase() === "auto";
}

/**
 * Pure check whether a model ID is in the allowlist.
 * Requirement 15.1, 15.2.
 */
export function isAllowedModelId(modelId: unknown): modelId is AllowedModelId {
  if (typeof modelId !== "string") {
    return false;
  }
  const trimmed = modelId.trim();
  if (isAutoModel(trimmed)) {
    return false;
  }
  return (ALLOWED_MODEL_IDS as readonly string[]).includes(trimmed);
}

/**
 * Returns the human-readable tier name for an allowed model ID.
 */
export function getModelTier(modelId: string): ModelTier | undefined {
  if (!isAllowedModelId(modelId)) {
    return undefined;
  }
  return MODEL_TIER_BY_ID[modelId];
}

/**
 * Evaluates whether task options represent hard: yes.
 */
export function isHardTask(hard: unknown): boolean {
  if (typeof hard === "boolean") {
    return hard;
  }
  if (typeof hard === "string") {
    const val = hard.trim().toLowerCase();
    return val === "yes" || val === "true" || val === "1";
  }
  return false;
}

/**
 * Returns the assigned model ID for a given role, applying escalation if hard: yes.
 * Requirements: 15.3, 15.4.
 */
export function getAssignedModelForRole(
  role: SkeletonRole | string,
  options?: RoleModelAssignmentOptions
): AllowedModelId {
  const norm = normalizeRole(role);
  if (!norm) {
    throw new Error(`Unknown Skeleton role: "${role}"`);
  }
  if (norm === "soul-stitcher" && isHardTask(options?.hard)) {
    return CLAUDE_OPUS_5_5_MODEL_ID;
  }
  return ROLE_DEFAULT_MODELS[norm];
}

/**
 * Returns the assigned model tier for a role.
 * Requirements: 15.3, 15.4.
 */
export function getAssignedTierForRole(
  role: SkeletonRole | string,
  options?: RoleModelAssignmentOptions
): ModelTier {
  const modelId = getAssignedModelForRole(role, options);
  return MODEL_TIER_BY_ID[modelId];
}

/**
 * Extracts active model string from ACP session/new response, configOptions, or direct value.
 * Requirement 15.5.
 */
export function extractActiveModel(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;

  // Check if wrapped in JSON-RPC result
  if (record.result && typeof record.result === "object") {
    const fromResult = extractActiveModel(record.result);
    if (fromResult) {
      return fromResult;
    }
  }

  // Check configOptions property
  if ("configOptions" in record && record.configOptions !== undefined) {
    const opts = record.configOptions;
    if (Array.isArray(opts)) {
      const fromArray = extractModelFromConfigArray(opts);
      if (fromArray) {
        return fromArray;
      }
    } else if (opts && typeof opts === "object") {
      const fromRecord = extractModelFromConfigRecord(opts as Record<string, unknown>);
      if (fromRecord) {
        return fromRecord;
      }
    }
  }

  // Check if input itself is an array of config options
  if (Array.isArray(input)) {
    const fromArray = extractModelFromConfigArray(input);
    if (fromArray) {
      return fromArray;
    }
  }

  // Check direct properties on the object
  if ("activeModel" in record && typeof record.activeModel === "string" && record.activeModel.trim()) {
    return record.activeModel.trim();
  }

  if ("model" in record) {
    const modelProp = record.model;
    if (typeof modelProp === "string" && modelProp.trim()) {
      return modelProp.trim();
    }
    if (modelProp && typeof modelProp === "object") {
      const extracted = extractValueFromOption(modelProp as Record<string, unknown>);
      if (extracted) {
        return extracted;
      }
    }
  }

  if ("modelId" in record && typeof record.modelId === "string" && record.modelId.trim()) {
    return record.modelId.trim();
  }

  // Check models.currentModelId (ACP v2/v3 session/new response format)
  if (record.models && typeof record.models === "object" && !Array.isArray(record.models)) {
    const modelsObj = record.models as Record<string, unknown>;
    if (typeof modelsObj.currentModelId === "string" && modelsObj.currentModelId.trim()) {
      return modelsObj.currentModelId.trim();
    }
  }

  // Check _meta.kiro.modelId or _meta.kiro.model
  if (record._meta && typeof record._meta === "object") {
    const meta = record._meta as Record<string, unknown>;
    if (meta.kiro && typeof meta.kiro === "object") {
      const kiro = meta.kiro as Record<string, unknown>;
      if (typeof kiro.modelId === "string" && kiro.modelId.trim()) {
        return kiro.modelId.trim();
      }
      if (typeof kiro.model === "string" && kiro.model.trim()) {
        return kiro.model.trim();
      }
    }
  }

  return null;
}

function extractModelFromConfigArray(arr: unknown[]): string | null {
  for (const item of arr) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const opt = item as Record<string, unknown>;
    const id = opt.id ?? opt.configId ?? opt.key ?? opt.name;
    if (
      typeof id === "string" &&
      (id.toLowerCase() === "model" ||
        id.toLowerCase() === "modelid" ||
        id.toLowerCase() === "model_id" ||
        id.toLowerCase() === "activemodel" ||
        id.toLowerCase() === "active_model")
    ) {
      const val = extractValueFromOption(opt);
      if (val) {
        return val;
      }
    }
  }
  return null;
}

function extractModelFromConfigRecord(rec: Record<string, unknown>): string | null {
  for (const key of ["model", "modelId", "model_id", "activeModel", "active_model"]) {
    if (key in rec) {
      const val = rec[key];
      if (typeof val === "string" && val.trim()) {
        return val.trim();
      }
      if (val && typeof val === "object") {
        const extracted = extractValueFromOption(val as Record<string, unknown>);
        if (extracted) {
          return extracted;
        }
      }
    }
  }
  return null;
}

function extractValueFromOption(opt: Record<string, unknown>): string | null {
  const candidate =
    opt.value ??
    opt.currentValue ??
    opt.selectedValue ??
    opt.selected ??
    opt.activeValue ??
    opt.active ??
    opt.modelId ??
    opt.id;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

/**
 * Result interfaces for model verification.
 */
export interface ModelVerificationSuccess {
  readonly ok: true;
  readonly allowed: true;
  readonly matchesTier: true;
  readonly modelId: AllowedModelId;
  readonly expectedModelId: AllowedModelId;
  readonly tier: ModelTier;
  readonly role: SkeletonRole;
  readonly canPrompt: true;
}

export interface ModelVerificationFailure {
  readonly ok: false;
  readonly allowed: boolean;
  readonly matchesTier: boolean;
  readonly modelId: string | null;
  readonly expectedModelId: AllowedModelId | null;
  readonly reason: ModelMismatchReason;
  readonly error: string;
  readonly role: SkeletonRole | string;
  readonly canPrompt: false;
}

export type ModelVerificationResult =
  | ModelVerificationSuccess
  | ModelVerificationFailure;

/**
 * Pure verification of the active model reported after session/new.
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6.
 *
 * Checks that:
 * 1. Role is a valid SkeletonRole.
 * 2. Active model can be read from session/configOptions.
 * 3. Active model is in the allowlist (never auto).
 * 4. Active model matches the assigned tier for the role (accounting for hard escalation).
 */
export function verifySessionModel(
  sessionResponseOrConfigOptions: unknown,
  role: SkeletonRole | string,
  options?: RoleModelAssignmentOptions
): ModelVerificationResult {
  const normRole = normalizeRole(role);
  if (!normRole) {
    return {
      ok: false,
      allowed: false,
      matchesTier: false,
      modelId: null,
      expectedModelId: null,
      reason: MODEL_MISMATCH_REASON,
      error: `model_mismatch: Unknown Skeleton role "${role}"`,
      role,
      canPrompt: false,
    };
  }

  const expectedModelId = getAssignedModelForRole(normRole, options);
  const activeModel = extractActiveModel(sessionResponseOrConfigOptions);

  if (!activeModel) {
    return {
      ok: false,
      allowed: false,
      matchesTier: false,
      modelId: null,
      expectedModelId,
      reason: MODEL_MISMATCH_REASON,
      error: `model_mismatch: No active model reported in session configOptions for role "${normRole}"`,
      role: normRole,
      canPrompt: false,
    };
  }

  if (isAutoModel(activeModel)) {
    return {
      ok: false,
      allowed: false,
      matchesTier: false,
      modelId: activeModel,
      expectedModelId,
      reason: MODEL_MISMATCH_REASON,
      error: `model_mismatch: Active model "${activeModel}" is auto, which is explicitly excluded from the allowlist`,
      role: normRole,
      canPrompt: false,
    };
  }

  if (!isAllowedModelId(activeModel)) {
    return {
      ok: false,
      allowed: false,
      matchesTier: false,
      modelId: activeModel,
      expectedModelId,
      reason: MODEL_MISMATCH_REASON,
      error: `model_mismatch: Active model "${activeModel}" is outside the allowlist (${ALLOWED_MODEL_IDS.join(", ")})`,
      role: normRole,
      canPrompt: false,
    };
  }

  if (activeModel !== expectedModelId) {
    return {
      ok: false,
      allowed: true,
      matchesTier: false,
      modelId: activeModel,
      expectedModelId,
      reason: MODEL_MISMATCH_REASON,
      error: `model_mismatch: Active model "${activeModel}" does not match assigned tier "${expectedModelId}" for role "${normRole}"`,
      role: normRole,
      canPrompt: false,
    };
  }

  return {
    ok: true,
    allowed: true,
    matchesTier: true,
    modelId: activeModel,
    expectedModelId,
    tier: MODEL_TIER_BY_ID[activeModel],
    role: normRole,
    canPrompt: true,
  };
}

/**
 * Returns true if session/prompt is permitted for the given session and role.
 * Returns false otherwise.
 * Requirements: 15.5, 15.6.
 */
export function canSendSessionPrompt(
  sessionResponseOrConfigOptions: unknown,
  role: SkeletonRole | string,
  options?: RoleModelAssignmentOptions
): boolean {
  return verifySessionModel(sessionResponseOrConfigOptions, role, options).ok;
}

/**
 * Refuses session/prompt if the active model is not allowed or differs from the role tier.
 * Returns true if prompt must be refused, false if prompt may proceed.
 * Requirements: 15.5, 15.6.
 */
export function refuseSessionPrompt(
  sessionResponseOrConfigOptions: unknown,
  role: SkeletonRole | string,
  options?: RoleModelAssignmentOptions
): boolean {
  return !canSendSessionPrompt(sessionResponseOrConfigOptions, role, options);
}

/**
 * Error thrown when session active model verification fails.
 */
export class ModelMismatchError extends Error {
  readonly reason: ModelMismatchReason = MODEL_MISMATCH_REASON;
  readonly modelId: string | null;
  readonly expectedModelId: AllowedModelId | null;
  readonly role: SkeletonRole | string;

  constructor(result: ModelVerificationFailure) {
    super(result.error);
    this.name = "ModelMismatchError";
    this.modelId = result.modelId;
    this.expectedModelId = result.expectedModelId;
    this.role = result.role;
  }
}

/**
 * Asserts that the session active model is in the allowlist and matches the role's assigned tier.
 * Throws ModelMismatchError with reason "model_mismatch" if invalid, or returns the verified AllowedModelId.
 */
export function assertSessionModel(
  sessionResponseOrConfigOptions: unknown,
  role: SkeletonRole | string,
  options?: RoleModelAssignmentOptions
): AllowedModelId {
  const result = verifySessionModel(sessionResponseOrConfigOptions, role, options);
  if (!result.ok) {
    throw new ModelMismatchError(result);
  }
  return result.modelId;
}

/**
 * Pure check whether live runs are enabled based on recorded allowed models.
 * Requirement 15.9: If Probe P4 records no allowed model ID, keep live runs disabled.
 */
export function areLiveRunsEnabled(
  recordedAllowedModels: readonly string[] = ALLOWED_MODEL_IDS
): boolean {
  if (!recordedAllowedModels || !Array.isArray(recordedAllowedModels)) {
    return false;
  }
  return (
    recordedAllowedModels.length > 0 &&
    recordedAllowedModels.some((m) => isAllowedModelId(m))
  );
}

/**
 * Returns default effort level.
 * Requirement 15.10.
 */
export function getDefaultEffortLevel(): string {
  return DEFAULT_EFFORT_LEVEL;
}

/**
 * Extracts active mode from session/new response.
 * Requirement 15.7.
 */
export function extractActiveMode(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof input !== "object") {
    return null;
  }
  const rec = input as Record<string, unknown>;
  if (rec.result && typeof rec.result === "object") {
    const fromRes = extractActiveMode(rec.result);
    if (fromRes) {
      return fromRes;
    }
  }
  if (typeof rec.activeModeId === "string" && rec.activeModeId.trim()) {
    return rec.activeModeId.trim();
  }
  if (typeof rec.activeMode === "string" && rec.activeMode.trim()) {
    return rec.activeMode.trim();
  }
  if (typeof rec.modeId === "string" && rec.modeId.trim()) {
    return rec.modeId.trim();
  }
  if (typeof rec.mode === "string" && rec.mode.trim()) {
    return rec.mode.trim();
  }
  if (rec.modes && typeof rec.modes === "object" && !Array.isArray(rec.modes)) {
    const modesObj = rec.modes as Record<string, unknown>;
    if (typeof modesObj.currentModeId === "string" && modesObj.currentModeId.trim()) {
      return modesObj.currentModeId.trim();
    }
  }
  if (Array.isArray(rec.modes)) {
    for (const m of rec.modes) {
      if (m && typeof m === "object") {
        const mr = m as Record<string, unknown>;
        if (mr.active === true || mr.selected === true) {
          const id = mr.id ?? mr.modeId ?? mr.name;
          if (typeof id === "string" && id.trim()) {
            return id.trim();
          }
        }
      }
    }
  }
  return null;
}

/**
 * Verifies that the active mode matches the role's agent mode.
 * Requirement 15.7.
 */
export function verifySessionMode(
  sessionResponse: unknown,
  role: SkeletonRole | string
): {
  ok: boolean;
  modeId: string | null;
  expectedModeId: string;
  error?: string;
} {
  const norm = normalizeRole(role);
  const expected = norm ?? (typeof role === "string" ? role.toLowerCase() : "");
  const activeMode = extractActiveMode(sessionResponse);
  if (!activeMode) {
    return {
      ok: false,
      modeId: null,
      expectedModeId: expected,
      error: `Missing active mode in session response; expected "${expected}"`,
    };
  }
  const normActive = activeMode.toLowerCase().replace(/_/g, "-");
  if (normActive !== expected) {
    return {
      ok: false,
      modeId: activeMode,
      expectedModeId: expected,
      error: `Active mode "${activeMode}" does not match role "${expected}"`,
    };
  }
  return { ok: true, modeId: activeMode, expectedModeId: expected };
}
