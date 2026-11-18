// Task 11.4: Redactor engine and worktree secret scanner
// Requirements: 22.14, 22.15, 42.1, 42.2, 42.3, 42.4, 42.5

import * as process from "node:process";

export const DEFAULT_REDACTION_MASK = "[REDACTED]";

// Requirement 42.3: Sensitive pattern matches
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  // Kiro subscription keys / canary tokens
  /ksk_[A-Za-z0-9_.-]{20,}/g,
  // GitHub Personal Access Tokens (classic) - no leading \b so _ghp_ or xghp_ matches
  /ghp_[A-Za-z0-9_.-]{20,}/g,
  // GitHub OAuth access tokens
  /gho_[A-Za-z0-9_.-]{20,}/g,
  // GitHub user-to-server tokens
  /ghu_[A-Za-z0-9_.-]{20,}/g,
  // GitHub server-to-server tokens
  /ghs_[A-Za-z0-9_.-]{20,}/g,
  // GitHub refresh tokens
  /ghr_[A-Za-z0-9_.-]{20,}/g,
  // GitHub fine-grained Personal Access Tokens - no leading \b
  /github_pat_[A-Za-z0-9_.-]{20,}/g,
  // GitLab Personal Access Tokens (glpat-)
  /(?<![a-zA-Z0-9])glpat-[A-Za-z0-9_.-]{20,}/g,
  // npm tokens
  /(?<![a-zA-Z0-9])npm_[A-Za-z0-9]{30,}/g,
  // Docker Personal Access Tokens
  /dckr_pat_[A-Za-z0-9_.-]{20,}/g,
  // AWS Access Key ID / canaries (AKIA or temporary ASIA followed by exactly 16 uppercase or digit characters)
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  // Stripe live secret and restricted keys (sk_live_ or rk_live_ followed by at least 20 alphanumeric chars)
  /(?<![a-zA-Z0-9])(?:sk|rk)_live_[A-Za-z0-9]{20,}/g,
  // sk- style keys (OpenAI / Anthropic style keys) - at least 20 token characters after the prefix
  /(?<![a-zA-Z0-9])sk-[A-Za-z0-9_.-]{20,}/g,
  // AIza Google API keys - exactly 35 characters after the prefix
  /(?<![a-zA-Z0-9])AIza[0-9A-Za-z_.-]{35}/g,
  // Slack tokens (e.g. xoxb-, xoxp-, xoxa-, xoxr-, xoxs-, xoxo-, xoxe-, xapp-)
  /(?<![a-zA-Z0-9])(?:xox[aboprs]|xoxe(?:-1)?|xapp)-[A-Za-z0-9_.-]{10,}/g,
  // Bearer tokens (e.g. Authorization: Bearer <token>) - scheme is case-insensitive (RFC 7235), at least 20 token characters
  /(?<=\bBearer\s+)[A-Za-z0-9_.~+/-]{20,}=*/gi,
  // Three-segment JWTs starting with eyJ
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Generic API keys: assignment to a literal value of 20+ chars containing both letters and digits
  /(?<=\b(?:api[_-]?key|apikey)["'`]?\s*[:=]\s*["'`])(?=[A-Za-z0-9_.-]*[A-Za-z])(?=[A-Za-z0-9_.-]*[0-9])[A-Za-z0-9_.-]{20,}(?=["'`])/gi,
  // PEM private key blocks (private keys only; public certificates are not flagged)
  /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY[A-Z0-9 _-]*-----[\s\S]*?-----END [A-Z0-9 _-]*PRIVATE KEY[A-Z0-9 _-]*-----/g,
  // Unclosed or single-line PEM private key headers
  /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY[^\r\n]*/g,
];

// Requirement 42.4: Host details, local filesystem paths, and Box network addresses
export const HOST_DETAIL_PATTERNS: readonly RegExp[] = [
  // Local filesystem path: /data/home and subpaths
  /\/data\/home(?:\/[^\s"'`,;)>}\]]*)?/g,
  // Local filesystem path: Windows user profiles C:\Users and subpaths (including spaces in username)
  /(?:[a-zA-Z]:)?[\\/]Users[\\/][^\\/\r\n"'`,;)>}\]]+[\\/][^\s"'`,;)>}\]]*|(?<=["'`])(?:[a-zA-Z]:)?[\\/]Users[\\/][^"'`\r\n]+(?=["'`])|(?:[a-zA-Z]:)?[\\/]Users[\\/][^\\/\r\n"'`,;)>}\]]+(?=[\r\n"'`,;)>}\]]|$)|(?:[a-zA-Z]:)?[\\/]Users(?:\\[^\s"'`,;)>}\]]*|\/[^\s"'`,;)>}\]]*)?/gi,
  // Generic home directory paths: /home/<user>
  /\/home\/[a-zA-Z0-9._-]+(?:\/[^\s"'`,;)>}\]]*)?/g,
  // Root home directory paths: /root and subpaths
  /(?<![\w/])\/root(?:\/[^\s"'`,;)>}\]]*)?/g,
  // Tilde home directory paths: ~, ~/, ~/.ssh, ~root, ~user/subpath
  /(?<![\w@~])~(?:[a-zA-Z_][a-zA-Z0-9._-]*(?:\/[^\s"'`,;)>}\]]*|(?=[\s"'`,;)>}\]]|$))|\/[^\s"'`,;)>}\]]*|(?=[\s"'`,;)>}\]]|$))/g,
  // Box and network IPv4 addresses (with optional port)
  /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::[0-9]{1,5})?\b/g,
  // Loopback and link-local IPv6 addresses
  /\b(?:fe80::[0-9a-fA-F:]+|::1)\b/g,
  // Standalone loopback IPv6 address
  /(?<![a-zA-Z0-9])::1(?![a-zA-Z0-9])/g,
];

// Requirement 42.2: Environment variables holding Necromancer secrets
export const SECRET_ENV_VARS: readonly string[] = [
  "ADMIN_KEY",
  "ADMIN_TOKEN",
  "ADMIN_SECRET",
  "GITHUB_WRITE_TOKEN",
  "GITHUB_TOKEN",
  "KIRO_KEY",
  "KIRO_API_KEY",
  "P12_SECRET",
  "INVITE_CODES",
];

export interface RedactionOptions {
  readonly secrets?: readonly string[];
  readonly patterns?: readonly RegExp[];
  readonly customPatterns?: readonly RegExp[];
  readonly redactionMask?: string;
  readonly mask?: string;
  readonly autoRegisterEnvSecrets?: boolean;
  readonly hostPaths?: readonly string[];
  readonly hostDetails?: readonly string[];
  readonly redactKeys?: boolean;
}

export type SecretViolationType =
  | "exact_secret"
  | "sensitive_pattern"
  | "host_detail"
  | "custom_pattern";

export interface SecretViolation {
  readonly type: SecretViolationType;
  readonly patternName?: string;
  readonly match: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface SecretScanResult {
  readonly hasSecrets: boolean;
  readonly passed: boolean;
  readonly shouldQuarantine: boolean;
  readonly violations: readonly SecretViolation[];
  readonly flaggedFiles: readonly string[];
  readonly reason?: string;
}

export interface WorktreeFileInput {
  readonly path: string;
  readonly content: string;
}

/**
 * Escapes a literal string for safe usage inside a regular expression.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Retrieves non-empty secret values from recognized Necromancer environment variables.
 */
export function getEnvSecrets(): string[] {
  const secrets: string[] = [];
  if (typeof process === "undefined" || !process.env) {
    return secrets;
  }
  for (const varName of SECRET_ENV_VARS) {
    const val = process.env[varName];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        if (!secrets.includes(trimmed)) {
          secrets.push(trimmed);
        }
        if (trimmed.includes(",")) {
          for (const part of trimmed.split(",")) {
            const p = part.trim();
            if (p.length > 0 && !secrets.includes(p)) {
              secrets.push(p);
            }
          }
        }
      }
    }
  }
  return secrets;
}

function redactExactValues(
  text: string,
  values: Iterable<string>,
  mask: string
): string {
  if (!text || typeof text !== "string") {
    return "";
  }
  const sorted = Array.from(values)
    .filter((v) => typeof v === "string" && v.length > 0 && v !== mask)
    .sort((a, b) => b.length - a.length);

  let result = text;
  for (const val of sorted) {
    const pattern = new RegExp(escapeRegExp(val), "g");
    result = result.replace(pattern, () => mask);
  }
  return result;
}

/**
 * Pure function redacting sensitive tokens, secrets, host details, and personal paths from a string.
 */
export function redactText(text: string, options?: RedactionOptions): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  const mask = options?.redactionMask ?? options?.mask ?? DEFAULT_REDACTION_MASK;
  let result = text;

  // 1. Exact secrets replacement (Requirement 42.2)
  const secretsToRedact = new Set<string>();
  if (options?.autoRegisterEnvSecrets !== false) {
    for (const sec of getEnvSecrets()) {
      secretsToRedact.add(sec);
    }
  }
  if (options?.secrets) {
    for (const sec of options.secrets) {
      if (typeof sec === "string" && sec.length > 0) {
        secretsToRedact.add(sec);
      }
    }
  }
  if (secretsToRedact.size > 0) {
    result = redactExactValues(result, secretsToRedact, mask);
  }

  // 2. Sensitive pattern matches (Requirement 42.3)
  for (const pattern of SENSITIVE_PATTERNS) {
    const p = new RegExp(pattern.source, pattern.flags);
    result = result.replace(p, () => mask);
  }

  // 3. Custom caller-supplied patterns
  const callerPatterns = options?.customPatterns ?? options?.patterns;
  if (callerPatterns) {
    for (const pattern of callerPatterns) {
      const p = new RegExp(pattern.source, pattern.flags);
      result = result.replace(p, () => mask);
    }
  }

  // 4. Exact host paths and details
  const extraHostPaths = new Set<string>();
  if (options?.hostPaths) {
    for (const hp of options.hostPaths) {
      if (typeof hp === "string" && hp.length > 0) {
        extraHostPaths.add(hp);
      }
    }
  }
  if (options?.hostDetails) {
    for (const hd of options.hostDetails) {
      if (typeof hd === "string" && hd.length > 0) {
        extraHostPaths.add(hd);
      }
    }
  }
  if (extraHostPaths.size > 0) {
    result = redactExactValues(result, extraHostPaths, mask);
  }

  // 5. Host details, personal paths and network addresses (Requirement 42.4)
  for (const pattern of HOST_DETAIL_PATTERNS) {
    const p = new RegExp(pattern.source, pattern.flags);
    result = result.replace(p, () => mask);
  }

  return result;
}

/**
 * Pure function deeply redacting all string values in primitives, arrays, sets, maps, and objects.
 */
export function redactValue<T>(
  value: T,
  options?: RedactionOptions,
  seen: WeakMap<object, unknown> = new WeakMap()
): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactText(value, options) as unknown as T;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return seen.get(value as object) as T;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value as object, result);
    for (const item of value) {
      result.push(redactValue(item, options, seen));
    }
    return result as unknown as T;
  }

  if (value instanceof Set) {
    const result = new Set<unknown>();
    seen.set(value as object, result);
    for (const item of value) {
      result.add(redactValue(item, options, seen));
    }
    return result as unknown as T;
  }

  if (value instanceof Map) {
    const result = new Map<unknown, unknown>();
    seen.set(value as object, result);
    for (const [k, v] of value.entries()) {
      result.set(
        typeof k === "string" ? redactText(k, options) : redactValue(k, options, seen),
        redactValue(v, options, seen)
      );
    }
    return result as unknown as T;
  }

  if (value instanceof Date) {
    const result = new Date(value.getTime());
    seen.set(value as object, result);
    return result as unknown as T;
  }

  if (value instanceof RegExp) {
    seen.set(value as object, value);
    return value;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    const result = Buffer.from(redactText((value as Buffer).toString("utf-8"), options));
    seen.set(value as object, result);
    return result as unknown as T;
  }

  if (value instanceof Error) {
    const copy = new (value.constructor as { new (msg?: string): Error })(
      redactText(value.message, options)
    );
    if (value.stack) {
      copy.stack = redactText(value.stack, options);
    }
    seen.set(value as object, copy);
    return copy as unknown as T;
  }

  // Plain objects
  const result: Record<string, unknown> = {};
  seen.set(value as object, result);
  for (const [key, val] of Object.entries(value)) {
    const targetKey =
      options?.redactKeys && typeof key === "string"
        ? redactText(key, options)
        : key;
    result[targetKey] = redactValue(val, options, seen);
  }
  return result as unknown as T;
}

/**
 * Pure function redacting an object structure without mutating the original object.
 */
export function redactObject<T extends object>(
  obj: T,
  options?: RedactionOptions
): T {
  return redactValue(obj, options);
}

/**
 * Redacts event data payload while preserving evidence references array.
 */
export function redactEventData(
  data?: Partial<{ refs?: unknown[] }> | Record<string, unknown> | null,
  options?: RedactionOptions
): Record<string, unknown> & { refs: string[] } {
  if (!data || typeof data !== "object") {
    return { refs: [] };
  }
  const redacted = redactValue(data, options) as Record<string, unknown>;
  const refs: string[] = Array.isArray(redacted.refs)
    ? (redacted.refs as unknown[]).map((r: unknown) => String(r))
    : [];
  return {
    ...redacted,
    refs,
  };
}

/**
 * Redacts an event envelope or event object without mutating input.
 */
export function redactEvent<T extends Record<string, unknown>>(
  event: T,
  options?: RedactionOptions
): T {
  if (!event || typeof event !== "object") {
    return event;
  }
  const copy = { ...event } as Record<string, unknown>;
  if (copy.data && typeof copy.data === "object") {
    copy.data = redactEventData(copy.data as Record<string, unknown>, options);
  }
  if (copy.payload && typeof copy.payload === "object" && !Array.isArray(copy.payload)) {
    copy.payload = redactEventData(copy.payload as Record<string, unknown>, options);
  }
  for (const [key, val] of Object.entries(copy)) {
    if (key === "data" || key === "payload") continue;
    if (key === "kind" || key === "phase" || key === "runId" || key === "type") continue;
    if (typeof val === "string") {
      copy[key] = redactText(val, options);
    } else if (val && typeof val === "object") {
      copy[key] = redactValue(val, options);
    }
  }
  return copy as T;
}

/**
 * Redacts log text or command execution log record (stdout, stderr, etc.).
 */
export function redactLog(log: string, options?: RedactionOptions): string;
export function redactLog<T extends Record<string, unknown>>(
  log: T,
  options?: RedactionOptions
): T;
export function redactLog(
  log: string | Record<string, unknown>,
  options?: RedactionOptions
): string | Record<string, unknown> {
  if (typeof log === "string") {
    return redactText(log, options);
  }
  if (log && typeof log === "object") {
    return redactValue(log, options);
  }
  return log;
}

function getLineAndCol(text: string, index: number): { line: number; column: number } {
  if (index <= 0) return { line: 1, column: 1 };
  const slice = text.slice(0, index);
  const lines = slice.split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

function safePercentDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
  }
}

function safeUnicodeEscapeDecode(str: string): string {
  return str.replace(/\\u([0-9a-fA-F]{4})|\\u\{([0-9a-fA-F]+)\}/gi, (_, hex4, hexVar) => {
    try {
      const code = parseInt(hex4 || hexVar, 16);
      return String.fromCodePoint(code);
    } catch {
      return _;
    }
  });
}

function safeBase64Decode(str: string): string | null {
  try {
    const buf = Buffer.from(str, "base64");
    if (buf.length < 4) return null;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) {
      return decoded;
    }
  } catch {
    // invalid UTF-8
  }
  return null;
}

/**
 * Scans a string for exact secrets, sensitive patterns, host details, or personal paths.
 * Scans the whole text directly (not line-by-line), and also scans one level of
 * percent-decoding, base64 decoding, and backslash-u escape decoding.
 */
export function scanTextForSecrets(
  text: string,
  options?: RedactionOptions
): SecretScanResult {
  if (!text || typeof text !== "string") {
    return {
      hasSecrets: false,
      passed: true,
      shouldQuarantine: false,
      violations: [],
      flaggedFiles: [],
    };
  }

  const rawViolations: SecretViolation[] = [];

  // Gather exact secrets to check
  const secretsToCheck = new Set<string>();
  if (options?.autoRegisterEnvSecrets !== false) {
    for (const sec of getEnvSecrets()) {
      secretsToCheck.add(sec);
    }
  }
  if (options?.secrets) {
    for (const sec of options.secrets) {
      if (typeof sec === "string" && sec.length > 0) {
        secretsToCheck.add(sec);
      }
    }
  }

  // Gather extra host details to check
  const extraHostPaths = new Set<string>();
  if (options?.hostPaths) {
    for (const hp of options.hostPaths) {
      if (typeof hp === "string" && hp.trim().length >= 3) {
        extraHostPaths.add(hp.trim());
      }
    }
  }
  if (options?.hostDetails) {
    for (const hd of options.hostDetails) {
      if (typeof hd === "string" && hd.trim().length >= 3) {
        extraHostPaths.add(hd.trim());
      }
    }
  }

  function scanDirect(target: string, isEncoded = false, baseOffset = 0): SecretViolation[] {
    const found: SecretViolation[] = [];

    // Check exact secrets across the whole text
    for (const sec of secretsToCheck) {
      if (sec.length < 3) continue;
      let idx = target.indexOf(sec);
      while (idx !== -1) {
        const { line, column } = isEncoded
          ? getLineAndCol(text, baseOffset)
          : getLineAndCol(target, idx);
        found.push({
          type: "exact_secret",
          match: sec,
          line,
          column,
        });
        idx = target.indexOf(sec, idx + sec.length);
      }
    }

    // Check sensitive patterns across the whole text
    for (const pattern of SENSITIVE_PATTERNS) {
      const p = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = p.exec(target)) !== null) {
        const { line, column } = isEncoded
          ? getLineAndCol(text, baseOffset)
          : getLineAndCol(target, match.index);
        found.push({
          type: "sensitive_pattern",
          patternName: pattern.source,
          match: match[0],
          line,
          column,
        });
        if (match[0].length === 0) {
          p.lastIndex++;
        }
      }
    }

    // Check caller-supplied patterns
    const callerPatterns = options?.customPatterns ?? options?.patterns;
    if (callerPatterns) {
      for (const pattern of callerPatterns) {
        const p = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = p.exec(target)) !== null) {
          const { line, column } = isEncoded
            ? getLineAndCol(text, baseOffset)
            : getLineAndCol(target, match.index);
          found.push({
            type: "custom_pattern",
            patternName: pattern.source,
            match: match[0],
            line,
            column,
          });
          if (match[0].length === 0) {
            p.lastIndex++;
          }
        }
      }
    }

    // Check custom host details and host paths
    for (const hp of extraHostPaths) {
      let idx = target.indexOf(hp);
      while (idx !== -1) {
        const { line, column } = isEncoded
          ? getLineAndCol(text, baseOffset)
          : getLineAndCol(target, idx);
        found.push({
          type: "host_detail",
          match: hp,
          line,
          column,
        });
        idx = target.indexOf(hp, idx + hp.length);
      }
    }

    return found;
  }

  // 1. Scan whole text directly (not line-by-line)
  rawViolations.push(...scanDirect(text, false, 0));

  // 2. Scan one level of percent-decoding
  const percentDecoded = safePercentDecode(text);
  if (percentDecoded !== text) {
    const hits = scanDirect(percentDecoded, true, 0);
    rawViolations.push(...hits);
  }

  // 3. Scan one level of backslash-u escape decoding
  const unicodeDecoded = safeUnicodeEscapeDecode(text);
  if (unicodeDecoded !== text) {
    const hits = scanDirect(unicodeDecoded, true, 0);
    rawViolations.push(...hits);
  }

  // 4. Scan one level of base64 decoding
  // 4a. Entire trimmed text as base64
  const trimmed = text.trim();
  if (
    /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) &&
    trimmed.length >= 8 &&
    trimmed.length % 4 === 0
  ) {
    const decoded = safeBase64Decode(trimmed);
    if (decoded && decoded !== trimmed) {
      const hits = scanDirect(decoded, true, 0);
      rawViolations.push(...hits);
    }
  }

  // 4b. Embedded base64 tokens
  const b64Regex = /[A-Za-z0-9+/]{8,}={0,2}/g;
  let b64Match: RegExpExecArray | null;
  while ((b64Match = b64Regex.exec(text)) !== null) {
    const candidate = b64Match[0];
    const decoded = safeBase64Decode(candidate);
    if (decoded && decoded !== candidate) {
      const hits = scanDirect(decoded, true, b64Match.index);
      rawViolations.push(...hits);
    }
  }

  // Deduplicate violations
  const violations: SecretViolation[] = [];
  const seenViolations = new Set<string>();
  for (const v of rawViolations) {
    const key = `${v.type}|${v.match}|${v.line}|${v.column}|${v.patternName ?? ""}`;
    if (!seenViolations.has(key)) {
      seenViolations.add(key);
      violations.push(v);
    }
  }

  const hasSecrets = violations.length > 0;
  return {
    hasSecrets,
    passed: !hasSecrets,
    shouldQuarantine: hasSecrets,
    violations,
    flaggedFiles: [],
    reason: hasSecrets
      ? `Found ${violations.length} secret or sensitive pattern violation(s)`
      : undefined,
  };
}

/**
 * Scans candidate diffs for added secrets or host details before Grimoire gate submission.
 * Requirement 42.5 & 22.14.
 */
export function scanCandidateDiff(
  diff: string,
  options?: RedactionOptions
): SecretScanResult {
  if (!diff || typeof diff !== "string" || !diff.trim()) {
    return {
      hasSecrets: false,
      passed: true,
      shouldQuarantine: false,
      violations: [],
      flaggedFiles: [],
    };
  }

  const lines = diff.split("\n");
  const violations: SecretViolation[] = [];
  const flaggedFiles = new Set<string>();

  let currentFile = "diff";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const parts = line.split(" ");
      if (parts.length >= 4) {
        currentFile = parts[3].replace(/^[b]\//, "");
      }
      continue;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim().replace(/^[b]\//, "");
      if (target && target !== "/dev/null") {
        currentFile = target;
      }
      continue;
    }

    // Only scan newly added or modified lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedContent = line.slice(1);
      const scan = scanTextForSecrets(addedContent, options);
      if (scan.hasSecrets) {
        flaggedFiles.add(currentFile);
        for (const v of scan.violations) {
          violations.push({
            ...v,
            file: currentFile,
            line: i + 1,
          });
        }
      }
    }
  }

  const hasSecrets = violations.length > 0;
  return {
    hasSecrets,
    passed: !hasSecrets,
    shouldQuarantine: hasSecrets,
    violations,
    flaggedFiles: Array.from(flaggedFiles),
    reason: hasSecrets
      ? `Quarantined: secret or sensitive pattern detected in candidate diff for file(s): ${Array.from(flaggedFiles).join(", ")}`
      : undefined,
  };
}

/**
 * Scans changed worktree files before sandbox_exec or candidate submission.
 * Requirements 22.14, 22.15, 42.5.
 */
export function scanWorktreeFiles(
  files: readonly WorktreeFileInput[] | Readonly<Record<string, string>>,
  options?: RedactionOptions
): SecretScanResult {
  const fileList: WorktreeFileInput[] = Array.isArray(files)
    ? (files as WorktreeFileInput[])
    : Object.entries(files).map(([path, content]) => ({ path, content }));

  const violations: SecretViolation[] = [];
  const flaggedFiles: string[] = [];

  for (const file of fileList) {
    const content =
      typeof file.content === "string"
        ? file.content
        : typeof Buffer !== "undefined" && Buffer.isBuffer(file.content)
        ? (file.content as Buffer).toString("utf-8")
        : String(file.content ?? "");
    const scan = scanTextForSecrets(content, options);
    if (scan.hasSecrets) {
      flaggedFiles.push(file.path);
      for (const v of scan.violations) {
        violations.push({
          ...v,
          file: file.path,
        });
      }
    }
  }

  const hasSecrets = violations.length > 0;
  return {
    hasSecrets,
    passed: !hasSecrets,
    shouldQuarantine: hasSecrets,
    violations,
    flaggedFiles,
    reason: hasSecrets
      ? `Quarantined: secret or sensitive pattern detected in changed worktree file(s): ${flaggedFiles.join(", ")}`
      : undefined,
  };
}

/**
 * Convenience helper evaluating whether a scan result triggers worktree quarantine.
 */
export function shouldQuarantineWorktree(scanResult: SecretScanResult): boolean {
  return scanResult.shouldQuarantine;
}

/**
 * Redactor class encapsulating configured options for repeated pure operations.
 * Glossary: "Redactor: The redaction layer used by the EventTap and the log writer."
 */
export class Redactor {
  readonly options: RedactionOptions;
  private readonly registeredSecrets = new Set<string>();

  constructor(options?: RedactionOptions) {
    this.options = { ...options };
    if (options?.secrets) {
      for (const s of options.secrets) {
        if (typeof s === "string" && s.length > 0) {
          this.registeredSecrets.add(s);
        }
      }
    }
  }

  registerSecret(secret: string): void {
    if (typeof secret === "string" && secret.trim().length > 0) {
      this.registeredSecrets.add(secret.trim());
    }
  }

  registerSecrets(secrets: Iterable<string>): void {
    for (const s of secrets) {
      this.registerSecret(s);
    }
  }

  getRegisteredSecrets(): string[] {
    return Array.from(this.registeredSecrets);
  }

  private getEffectiveOptions(overrideOpts?: RedactionOptions): RedactionOptions {
    const combinedSecrets = new Set<string>();
    if (this.options.secrets) {
      for (const s of this.options.secrets) combinedSecrets.add(s);
    }
    for (const s of this.registeredSecrets) {
      combinedSecrets.add(s);
    }
    if (overrideOpts?.secrets) {
      for (const s of overrideOpts.secrets) combinedSecrets.add(s);
    }
    return {
      ...this.options,
      ...overrideOpts,
      secrets: Array.from(combinedSecrets),
    };
  }

  redactText(text: string): string {
    return redactText(text, this.getEffectiveOptions());
  }

  redactValue<T>(value: T): T {
    return redactValue(value, this.getEffectiveOptions());
  }

  redactObject<T extends object>(obj: T): T {
    return redactObject(obj, this.getEffectiveOptions());
  }

  redactEvent<T extends Record<string, unknown>>(event: T): T {
    return redactEvent(event, this.getEffectiveOptions());
  }

  redactEventData(
    data?: Partial<{ refs?: unknown[] }> | Record<string, unknown> | null
  ): Record<string, unknown> & { refs: string[] } {
    return redactEventData(data, this.getEffectiveOptions());
  }

  redactLog(log: string): string;
  redactLog<T extends Record<string, unknown>>(log: T): T;
  redactLog(
    log: string | Record<string, unknown>
  ): string | Record<string, unknown> {
    return redactLog(log as any, this.getEffectiveOptions());
  }

  scanText(text: string): SecretScanResult {
    return scanTextForSecrets(text, this.getEffectiveOptions());
  }

  scanDiff(diff: string): SecretScanResult {
    return scanCandidateDiff(diff, this.getEffectiveOptions());
  }

  scanFiles(
    files: readonly WorktreeFileInput[] | Readonly<Record<string, string>>
  ): SecretScanResult {
    return scanWorktreeFiles(files, this.getEffectiveOptions());
  }
}

/**
 * Factory helper creating a new Redactor instance.
 */
export function createRedactor(options?: RedactionOptions): Redactor {
  return new Redactor(options);
}
