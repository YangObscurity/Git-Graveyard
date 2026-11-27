// Task 21.3: Tier 3 hard blocks enforced in code.
// Requirements: 27.13, 27.14, 27.15, 29.10, 29.11, 29.12, 29.13.
//
// This module complements the committed command policy in
// `lib/gateway/command-policy.ts`: the gateway classifies `sandbox_exec` argv
// for a live box, while this module supplies the unbypassable Tier 3 checks the
// Necromancer applies to command argv, budget ceiling changes and candidate
// diffs before any of them can take effect. Hard blocks can never be lifted by
// a prompt, an invite code, a Necromancer decision or a UI action.

/**
 * Stable structured denial codes. Callers persist these; never rename.
 */
export type HardBlockCode =
  | "HARD_BLOCK_INVALID_ARGV"
  | "HARD_BLOCK_SUDO"
  | "HARD_BLOCK_PRIVILEGE_ESCALATION"
  | "HARD_BLOCK_CONTAINER_SOCKET"
  | "HARD_BLOCK_HOST_MOUNT"
  | "HARD_BLOCK_DESTRUCTIVE_HOST_OP"
  | "HARD_BLOCK_BUDGET_CEILING"
  | "HARD_BLOCK_INVALID_BUDGET"
  | "HARD_BLOCK_PROTECTED_PATH";

export interface HardBlockResult {
  blocked: boolean;
  code?: HardBlockCode;
  reason?: string;
  /** The argv token, path or budget field that triggered the block. */
  matched?: string;
  details?: Record<string, unknown>;
}

export function hardBlockAllowed(): HardBlockResult {
  return { blocked: false };
}

/** Directories no candidate diff may modify inside a worktree (Requirement 29.13). */
export const PROTECTED_DIRECTORIES: readonly string[] = [".kiro", ".git"];

/** Container runtime sockets that must never be reachable (Requirement 29.12). */
export const CONTAINER_SOCKET_MARKERS: readonly string[] = [
  "docker.sock",
  "podman.sock",
  "containerd.sock",
  "crio.sock",
];

const SUDO_BINARIES: ReadonlySet<string> = new Set([
  "sudo",
  "sudoedit",
  "doas",
  "su",
  "pkexec",
]);

const PRIVILEGE_ESCALATION_BINARIES: ReadonlySet<string> = new Set([
  "setcap",
  "setuid",
  "chsh",
]);

const DESTRUCTIVE_HOST_BINARIES: ReadonlySet<string> = new Set([
  "mkfs",
  "mkfs.ext4",
  "mkfs.xfs",
  "fdisk",
  "parted",
  "mkswap",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
]);

const HOST_NAMESPACE_FLAGS: readonly string[] = [
  "--pid",
  "--net",
  "--network",
  "--ipc",
  "--uts",
  "--userns",
];

function basename(token: string): string {
  const trimmed = token.trim();
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}


function isDestructiveRm(argv: readonly string[]): boolean {
  if (argv.length === 0 || basename(argv[0]) !== "rm") {
    return false;
  }
  let recursive = false;
  let force = false;
  const operands: string[] = [];
  for (const raw of argv.slice(1)) {
    const token = raw.trim();
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (token.startsWith("--")) {
        if (token === "--recursive" || token === "--dir") recursive = true;
        if (token === "--force") force = true;
      } else {
        if (token.includes("r") || token.includes("R")) recursive = true;
        if (token.includes("f")) force = true;
      }
      continue;
    }
    operands.push(token);
  }
  if (!recursive || !force) {
    return false;
  }
  return operands.some(
    (op) =>
      op === "/" ||
      op === "/*" ||
      op === "/etc" ||
      op === "/usr" ||
      op === "/var" ||
      op === "/home" ||
      op.startsWith("/etc/") ||
      op.startsWith("/usr/") ||
      op.startsWith("/var/") ||
      op.startsWith("/home/") ||
      op.startsWith("/dev/")
  );
}

function isDestructiveDd(argv: readonly string[]): boolean {
  if (argv.length === 0 || basename(argv[0]) !== "dd") {
    return false;
  }
  // The shell operator cannot be seen in argv, so a write to a raw device path
  // is the closest enforceable signal.
  return argv.slice(1).some((arg) => {
    const token = arg.trim();
    const eq = token.indexOf("=");
    const value = eq >= 0 ? token.slice(eq + 1) : token;
    return /^of=\/dev\/(sd|nvme|hd|vd|mmcblk)/.test(token) ||
      /^\/dev\/(sd|nvme|hd|vd|mmcblk)/.test(value);
  });
}

/**
 * Rejects a command argv that names a Tier 3 forbidden operation.
 * Pure: never touches the filesystem or the network.
 * Requirements: 27.13, 29.10, 29.11, 29.12.
 */
export function checkCommandHardBlocks(
  argv: readonly string[] | string[]
): HardBlockResult {
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      blocked: true,
      code: "HARD_BLOCK_INVALID_ARGV",
      reason: "Blocked: argv must be a non-empty array of strings (Requirement 29.10)",
    };
  }
  if (argv.some((arg) => typeof arg !== "string")) {
    return {
      blocked: true,
      code: "HARD_BLOCK_INVALID_ARGV",
      reason: "Blocked: every argv element must be a string (Requirement 29.10)",
    };
  }

  const argvCopy = [...argv];
  const joined = argvCopy.join(" ");
  const firstBin = basename(argvCopy[0]);

  // 1. Sudo and raw privilege escalation (Requirement 29.12).
  for (const token of argvCopy) {
    if (SUDO_BINARIES.has(basename(token))) {
      return {
        blocked: true,
        code: "HARD_BLOCK_SUDO",
        reason: `Blocked: command attempts sudo or privilege escalation via '${basename(token)}' (Requirement 29.12)`,
        matched: token,
      };
    }
  }
  for (const token of argvCopy) {
    if (PRIVILEGE_ESCALATION_BINARIES.has(basename(token))) {
      return {
        blocked: true,
        code: "HARD_BLOCK_PRIVILEGE_ESCALATION",
        reason: `Blocked: command attempts raw privilege escalation via '${basename(token)}' (Requirement 29.12)`,
        matched: token,
      };
    }
  }

  // 2. Container / runtime sockets (Requirement 29.12).
  for (const token of argvCopy) {
    for (const marker of CONTAINER_SOCKET_MARKERS) {
      if (token.includes(marker)) {
        return {
          blocked: true,
          code: "HARD_BLOCK_CONTAINER_SOCKET",
          reason: `Blocked: argv references container runtime socket '${marker}' (Requirement 29.12)`,
          matched: token,
        };
      }
    }
  }

  // 3. Host mounts, host namespaces and container escape flags (Requirement 29.12).
  for (let i = 0; i < argvCopy.length; i++) {
    const token = argvCopy[i];
    const eq = token.indexOf("=");
    const flagName = eq >= 0 ? token.slice(0, eq) : token;
    if (flagName === "--privileged") {
      return {
        blocked: true,
        code: "HARD_BLOCK_HOST_MOUNT",
        reason: `Blocked: argv requests a host mount or host namespace via '${flagName}' (Requirement 29.12)`,
        matched: token,
      };
    }
    if (HOST_NAMESPACE_FLAGS.includes(flagName)) {
      const value = (eq >= 0 ? token.slice(eq + 1) : argvCopy[i + 1] ?? "").trim();
      if (value === "host") {
        return {
          blocked: true,
          code: "HARD_BLOCK_HOST_MOUNT",
          reason: `Blocked: argv requests a host namespace via '${flagName}=host' (Requirement 29.12)`,
          matched: token,
        };
      }
    }
    if (flagName.startsWith("--mount")) {
      const value = eq >= 0 ? token.slice(eq + 1) : argvCopy[i + 1] ?? "";
      if (/(?:^|,)source=\/(?:$|,)/.test(value) || /type=bind/.test(value)) {
        return {
          blocked: true,
          code: "HARD_BLOCK_HOST_MOUNT",
          reason: "Blocked: argv bind-mounts a host path (Requirement 29.12)",
          matched: token,
        };
      }
    }
    if (flagName === "-v" || flagName === "--volume") {
      const value = (eq >= 0 ? token.slice(eq + 1) : argvCopy[i + 1] ?? "").trim();
      if (value.startsWith("/")) {
        return {
          blocked: true,
          code: "HARD_BLOCK_HOST_MOUNT",
          reason: "Blocked: argv bind-mounts a host path (Requirement 29.12)",
          matched: token,
        };
      }
    }
  }

  // 4. Destructive host operations (Requirement 29.12).
  if (DESTRUCTIVE_HOST_BINARIES.has(firstBin)) {
    return {
      blocked: true,
      code: "HARD_BLOCK_DESTRUCTIVE_HOST_OP",
      reason: `Blocked: destructive host operation '${firstBin}' (Requirement 29.12)`,
      matched: argvCopy[0],
    };
  }
  if (isDestructiveRm(argvCopy)) {
    return {
      blocked: true,
      code: "HARD_BLOCK_DESTRUCTIVE_HOST_OP",
      reason: "Blocked: recursive forced removal against a host path (Requirement 29.12)",
      matched: joined,
    };
  }
  if (isDestructiveDd(argvCopy)) {
    return {
      blocked: true,
      code: "HARD_BLOCK_DESTRUCTIVE_HOST_OP",
      reason: "Blocked: raw device write is a destructive host operation (Requirement 29.12)",
      matched: joined,
    };
  }

  return hardBlockAllowed();
}

export interface BudgetIncreaseInput {
  /** Dimension being raised, for the reason string ("credits", "tool_calls", ...). */
  dimension?: string;
  currentCap: number;
  requestedCap: number;
  /** Hard code ceiling: no decision or user action may raise a cap past this. */
  codeCeiling?: number;
  /** Global ceiling across all runs, when configured. */
  globalCeiling?: number;
}

/**
 * Rejects any budget ceiling increase beyond the Code_Ceiling or the global
 * ceiling (Requirements 27.14, 28.1, 30.8). Reductions are never blocked.
 */
export function checkBudgetIncreaseHardBlocks(
  input: BudgetIncreaseInput
): HardBlockResult {
  const { currentCap, requestedCap } = input;
  if (!Number.isFinite(currentCap) || !Number.isFinite(requestedCap)) {
    return {
      blocked: true,
      code: "HARD_BLOCK_INVALID_BUDGET",
      reason: "Blocked: budget caps must be finite numbers (Requirement 30.8)",
    };
  }
  if (requestedCap <= currentCap) {
    return hardBlockAllowed();
  }

  const ceilings: number[] = [];
  if (Number.isFinite(input.codeCeiling)) ceilings.push(input.codeCeiling as number);
  if (Number.isFinite(input.globalCeiling)) ceilings.push(input.globalCeiling as number);
  if (ceilings.length === 0) {
    return {
      blocked: true,
      code: "HARD_BLOCK_BUDGET_CEILING",
      reason:
        "Blocked: no code ceiling or global ceiling configured, cap increase refused (Requirement 30.8)",
      details: { currentCap, requestedCap, dimension: input.dimension },
    };
  }

  const allowedMax = Math.min(...ceilings);
  if (requestedCap > allowedMax) {
    return {
      blocked: true,
      code: "HARD_BLOCK_BUDGET_CEILING",
      reason: `Blocked: cap increase to ${requestedCap} exceeds the ceiling ${allowedMax} (Requirement 30.8)`,
      matched: String(requestedCap),
      details: { currentCap, requestedCap, allowedMax, dimension: input.dimension },
    };
  }

  return hardBlockAllowed();
}

/**
 * Normalizes a candidate path: strips git `a/`/`b/` prefixes, surrounding
 * quotes, and leading `./`. Returns null for an unusable entry.
 */
export function normalizeCandidatePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    value = value.slice(2);
  } else if (value.startsWith("./")) {
    value = value.slice(2);
  }
  value = value.replace(/\\/g, "/");
  return value || null;
}

/**
 * Returns true when a candidate path lives inside `.kiro/` or `.git/`.
 * Requirement 29.13.
 */
export function isProtectedPath(rawPath: string): boolean {
  const normalized = normalizeCandidatePath(rawPath);
  if (!normalized) return false;
  for (const dir of PROTECTED_DIRECTORIES) {
    if (normalized === dir || normalized === `${dir}/`) return true;
    if (normalized.startsWith(`${dir}/`)) return true;
    if (normalized.includes(`/${dir}/`)) return true;
  }
  return false;
}


const DIFF_GIT_HEADER = /^diff --git (?:")?a\/(.+?)(?:")? (?:")?b\/(.+?)(?:")?$/;
const DIFF_OLD_PATH = /^--- (?:")?a\/(.+?)(?:")?$/;
const DIFF_NEW_PATH = /^\+\+\+ (?:")?b\/(.+?)(?:")?$/;
const DIFF_RENAME = /^(?:rename|copy) (?:from|to) (?:")?(.+?)(?:")?$/;

/**
 * Extracts candidate file paths from a unified diff, tolerating quoted and
 * rename/copy headers.
 */
export function parseDiffPaths(diff: string): string[] {
  if (typeof diff !== "string" || !diff) return [];
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    let match = DIFF_GIT_HEADER.exec(trimmed);
    if (match) {
      paths.add(match[1]);
      paths.add(match[2]);
      continue;
    }
    match = DIFF_OLD_PATH.exec(trimmed);
    if (match) {
      paths.add(match[1]);
      continue;
    }
    match = DIFF_NEW_PATH.exec(trimmed);
    if (match) {
      paths.add(match[1]);
      continue;
    }
    match = DIFF_RENAME.exec(trimmed);
    if (match) {
      paths.add(match[1]);
      continue;
    }
  }
  return [...paths];
}

export type CandidateDiffInput =
  | string
  | readonly string[]
  | { diff?: string; files?: readonly string[] };

function collectCandidatePaths(input: CandidateDiffInput): string[] {
  if (typeof input === "string") {
    return parseDiffPaths(input);
  }
  if (Array.isArray(input)) {
    return [...(input as readonly string[])];
  }
  const obj = input as { diff?: string; files?: readonly string[] };
  const out: string[] = [];
  if (Array.isArray(obj.files)) {
    out.push(...obj.files);
  }
  if (typeof obj.diff === "string") {
    out.push(...parseDiffPaths(obj.diff));
  }
  return out;
}

/**
 * Rejects a candidate diff that modifies any file inside `.kiro/` or `.git/`.
 * Requirement 29.13; returns a structured denial with the offending paths.
 */
export function validateCandidateDiff(input: CandidateDiffInput): HardBlockResult {
  const candidates = collectCandidatePaths(input);
  const offenders: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (isProtectedPath(candidate)) {
      const normalized = normalizeCandidatePath(candidate);
      if (normalized) offenders.push(normalized);
    }
  }
  if (offenders.length > 0) {
    return {
      blocked: true,
      code: "HARD_BLOCK_PROTECTED_PATH",
      reason: `Refused: candidate diff modifies protected path(s) inside ${PROTECTED_DIRECTORIES.map(
        (d) => `${d}/`
      ).join(" or ")} (Requirement 29.13)`,
      matched: offenders[0],
      details: { offenders },
    };
  }
  return hardBlockAllowed();
}

/**
 * Throws a plain Error carrying the structured denial, for call sites that
 * cannot continue after a hard block. Never lifts a block.
 */
export function assertNoHardBlock(result: HardBlockResult): void {
  if (result.blocked) {
    const err = new Error(result.reason ?? "Hard block enforced") as Error & {
      code?: HardBlockCode;
      hardBlock?: HardBlockResult;
    };
    err.code = result.code;
    err.hardBlock = result;
    throw err;
  }
}

