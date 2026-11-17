import type { ExecRequest, SandboxSpec } from "./types";

/**
 * Standard secret environment variable patterns and known names.
 * Requirements: 21.5, 21.14, 42.2, 42.3, 43.4.
 */
export const DEFAULT_SECRET_ENV_NAMES = [
  "KIRO_API_KEY",
  "KIRO_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "DOCKER_PAT",
  "DOCKER_TOKEN",
  "ADMIN_SECRET",
  "INVITE_CODE",
  "INVITE_CODES",
  "INSTABOX_API_KEY",
  "INSTABOX_KEY",
] as const;

export const SECRET_NAME_PATTERNS = [
  /(?:^|_)(?:secret|token|password|passwd|api_?key|credential|private_?key)(?:$|_)/i,
];

export const SECRET_VALUE_PATTERNS = [
  "ksk_",
  "ghp_",
  "github_pat_",
  "dckr_pat_",
  "AKIA",
  "-----BEGIN",
];

export interface SpecValidationOptions {
  customSecretDenylist?: string[];
  throwOnError?: boolean;
}

export class SpecValidationError extends Error {
  readonly ok = false as const;
  readonly code = "SPEC_VALIDATION_ERROR" as const;
  readonly reason: string;

  constructor(reason: string, message?: string) {
    const msg = message ?? `Sandbox specification rejected: ${reason}`;
    super(msg);
    this.name = "SpecValidationError";
    this.reason = reason;
    Object.setPrototypeOf(this, SpecValidationError.prototype);
  }
}

export interface SpecValidationResult {
  valid: boolean;
  ok: boolean;
  reason?: string;
  code?: string;
  error?: SpecValidationError;
}

function isSecretEnvName(name: string, customDenylist?: string[]): boolean {
  if (typeof name !== "string") {
    return false;
  }
  const upper = name.trim().toUpperCase();

  if (customDenylist && customDenylist.some((d) => d.toUpperCase() === upper)) {
    return true;
  }

  for (const known of DEFAULT_SECRET_ENV_NAMES) {
    if (upper === known) {
      return true;
    }
  }

  for (const pattern of SECRET_NAME_PATTERNS) {
    if (pattern.test(upper)) {
      return true;
    }
  }

  return false;
}

function isSecretEnvValue(value: string, customDenylist?: string[]): boolean {
  if (typeof value !== "string") {
    return false;
  }

  if (customDenylist && customDenylist.some((d) => value.includes(d))) {
    return true;
  }

  for (const prefix of SECRET_VALUE_PATTERNS) {
    if (value.includes(prefix)) {
      return true;
    }
  }

  return false;
}

function hasUserIdZero(spec: Record<string, unknown>): boolean {
  if (spec.uid === 0 || spec.uid === "0") {
    return true;
  }
  if (spec.userId === 0 || spec.userId === "0") {
    return true;
  }
  if (spec.user === 0 || spec.user === "0" || spec.user === "root") {
    return true;
  }
  if (typeof spec.user === "object" && spec.user !== null) {
    const userObj = spec.user as Record<string, unknown>;
    if (userObj.uid === 0 || userObj.uid === "0" || userObj.name === "root") {
      return true;
    }
  }
  return false;
}

function hasNonEmptySecrets(spec: Record<string, unknown>): boolean {
  if (!("secrets" in spec)) {
    return false;
  }
  const s = spec.secrets;
  if (s === undefined || s === null) {
    return false;
  }
  if (Array.isArray(s)) {
    return s.length > 0;
  }
  if (typeof s === "object") {
    return Object.keys(s).length > 0;
  }
  if (typeof s === "string") {
    return s.trim().length > 0;
  }
  if (typeof s === "boolean") {
    return s;
  }
  return true;
}

function hasNonEmptyPorts(spec: Record<string, unknown>): boolean {
  if (!("ports" in spec)) {
    return false;
  }
  const p = spec.ports;
  if (p === undefined || p === null) {
    return false;
  }
  if (Array.isArray(p)) {
    return p.length > 0;
  }
  if (typeof p === "number") {
    return true;
  }
  if (typeof p === "object") {
    return Object.keys(p).length > 0;
  }
  if (typeof p === "string") {
    return p.trim().length > 0;
  }
  if (typeof p === "boolean") {
    return p;
  }
  return true;
}

function checkCommandShape(command: unknown): { valid: boolean; reason?: string } {
  if (typeof command === "string") {
    return {
      valid: false,
      reason: "Command formatted as shell string instead of argv array",
    };
  }
  if (!Array.isArray(command)) {
    return {
      valid: false,
      reason: "Command is not an argv array",
    };
  }
  for (const arg of command) {
    if (typeof arg !== "string") {
      return {
        valid: false,
        reason: "Command argv element is not a string",
      };
    }
  }
  return { valid: true };
}

/**
 * Checks a SandboxSpec against security boundaries.
 * Rejects user ID 0, secrets field, ports field, secret denylist in env,
 * or commands given as shell strings.
 * Requirements: 21.2, 21.3, 21.5, 21.14, 43.2, 43.3, 43.4, 43.7.
 */
export function checkSandboxSpec(
  spec: unknown,
  options?: SpecValidationOptions
): SpecValidationResult {
  if (!spec || typeof spec !== "object") {
    const error = new SpecValidationError("SandboxSpec must be an object");
    return { valid: false, ok: false, reason: "SandboxSpec must be an object", error };
  }

  const s = spec as Record<string, unknown>;

  // Requirement 43.7: Reject user ID 0
  if (hasUserIdZero(s)) {
    const reason = "User ID 0 (root) is forbidden";
    const error = new SpecValidationError(reason);
    return { valid: false, ok: false, reason, error };
  }

  // Requirement 43.3: Reject secrets field
  if (hasNonEmptySecrets(s)) {
    const reason = "Non-empty secrets field is forbidden";
    const error = new SpecValidationError(reason);
    return { valid: false, ok: false, reason, error };
  }

  // Requirement 43.3: Reject ports field
  if (hasNonEmptyPorts(s)) {
    const reason = "Non-empty ports field is forbidden";
    const error = new SpecValidationError(reason);
    return { valid: false, ok: false, reason, error };
  }

  // Requirement 43.4: Reject environment variables matching secret denylist
  if (s.env && typeof s.env === "object") {
    const envObj = s.env as Record<string, unknown>;
    for (const [key, val] of Object.entries(envObj)) {
      if (isSecretEnvName(key, options?.customSecretDenylist)) {
        const reason = `Environment variable name '${key}' matches secret denylist`;
        const error = new SpecValidationError(reason);
        return { valid: false, ok: false, reason, error };
      }
      if (typeof val === "string" && isSecretEnvValue(val, options?.customSecretDenylist)) {
        const reason = `Environment variable '${key}' value matches secret pattern`;
        const error = new SpecValidationError(reason);
        return { valid: false, ok: false, reason, error };
      }
    }
  }

  // Requirement 43.2: Reject shell strings in command or argv
  if ("command" in s && s.command !== undefined && s.command !== null) {
    const cmdCheck = checkCommandShape(s.command);
    if (!cmdCheck.valid) {
      const error = new SpecValidationError(cmdCheck.reason!);
      return { valid: false, ok: false, reason: cmdCheck.reason, error };
    }
  }

  if ("argv" in s && s.argv !== undefined && s.argv !== null) {
    const argvCheck = checkCommandShape(s.argv);
    if (!argvCheck.valid) {
      const error = new SpecValidationError(argvCheck.reason!);
      return { valid: false, ok: false, reason: argvCheck.reason, error };
    }
  }

  return { valid: true, ok: true };
}

/**
 * Validates a SandboxSpec. Throws by default on validation failure,
 * or returns boolean if options.throwOnError is false.
 */
export function validateSandboxSpec(
  spec: unknown,
  options?: SpecValidationOptions
): boolean {
  const result = checkSandboxSpec(spec, options);
  if (!result.valid) {
    if (options?.throwOnError !== false) {
      throw result.error ?? new SpecValidationError(result.reason ?? "Invalid spec");
    }
    return false;
  }
  return true;
}

export function isSandboxSpecValid(
  spec: unknown,
  options?: SpecValidationOptions
): boolean {
  return checkSandboxSpec(spec, options).valid;
}

export function validateSandboxSpecOrThrow(
  spec: unknown,
  options?: SpecValidationOptions
): void {
  const result = checkSandboxSpec(spec, options);
  if (!result.valid) {
    throw result.error ?? new SpecValidationError(result.reason ?? "Invalid spec");
  }
}

/**
 * Checks an ExecRequest or command payload for strictly argv array execution.
 * Requirement 43.2.
 */
export function checkExecRequest(
  req: unknown,
  _options?: SpecValidationOptions
): SpecValidationResult {
  if (!req) {
    const error = new SpecValidationError("ExecRequest must be provided");
    return { valid: false, ok: false, reason: "ExecRequest must be provided", error };
  }

  if (typeof req === "string") {
    const reason = "Command formatted as shell string instead of argv array";
    const error = new SpecValidationError(reason);
    return { valid: false, ok: false, reason, error };
  }

  if (Array.isArray(req)) {
    const cmdCheck = checkCommandShape(req);
    if (!cmdCheck.valid) {
      const error = new SpecValidationError(cmdCheck.reason!);
      return { valid: false, ok: false, reason: cmdCheck.reason, error };
    }
    return { valid: true, ok: true };
  }

  if (typeof req === "object") {
    const r = req as Record<string, unknown>;
    const commandPayload = r.argv ?? r.command ?? r.cmd;
    if (commandPayload === undefined || commandPayload === null) {
      const reason = "ExecRequest missing argv array";
      const error = new SpecValidationError(reason);
      return { valid: false, ok: false, reason, error };
    }
    const check = checkCommandShape(commandPayload);
    if (!check.valid) {
      const error = new SpecValidationError(check.reason!);
      return { valid: false, ok: false, reason: check.reason, error };
    }
    return { valid: true, ok: true };
  }

  const reason = "Invalid ExecRequest format";
  const error = new SpecValidationError(reason);
  return { valid: false, ok: false, reason, error };
}

export function validateExecRequest(
  req: unknown,
  options?: SpecValidationOptions
): boolean {
  const result = checkExecRequest(req, options);
  if (!result.valid) {
    if (options?.throwOnError !== false) {
      throw result.error ?? new SpecValidationError(result.reason ?? "Invalid ExecRequest");
    }
    return false;
  }
  return true;
}

export function isExecRequestValid(
  req: unknown,
  options?: SpecValidationOptions
): boolean {
  return checkExecRequest(req, options).valid;
}

export function validateExecRequestOrThrow(
  req: unknown,
  options?: SpecValidationOptions
): void {
  const result = checkExecRequest(req, options);
  if (!result.valid) {
    throw result.error ?? new SpecValidationError(result.reason ?? "Invalid ExecRequest");
  }
}

export const validateCommand = validateExecRequest;
