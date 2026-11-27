import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePermissionForm } from "../probes/probe-settles";
import { BONESETTER_WRITABLE_FILENAMES } from "../agents/bonesetter";

/**
 * Invariant KI-05 / Requirement 18.2:
 * The PermissionBroker never modifies permissions.yaml.
 * Persistent options (allow_always, reject_always) are strictly forbidden
 * and never selected.
 */

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: PermissionOptionKind | string;
  [key: string]: unknown;
}

export type RequestPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome;
}

export interface RequestPermissionSubject {
  type?: string;
  toolCallId?: string;
  [key: string]: unknown;
}

export interface RequestPermissionToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  arguments?: unknown;
  _meta?: {
    kiro?: {
      consent?: unknown;
      mcpTool?: unknown;
      role?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PermissionBrokerRequest {
  sessionId?: string;
  toolCall?: RequestPermissionToolCall;
  options?: PermissionOption[];
  title?: string;
  description?: string | null;
  subject?: RequestPermissionSubject | null;
  _meta?: {
    kiro?: {
      consent?: unknown;
      mcpTool?: unknown;
      role?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };

  requestId?: string;
  id?: string | number;
  toolCallId?: string;
  role?: string;
  skeletonRole?: string;
  capability?: string;
  target?: string;
  arguments?: unknown;
  rawInput?: unknown;
  cwd?: string;
  additionalDirectories?: string[];
  runId?: string;

  decision?: "allow_once" | "reject_once" | string;
  matchedRule?: string;
  rule?: string;
  evaluator?: (req: PermissionBrokerRequest) => {
    allowed: boolean;
    rule: string;
    capability?: string;
    target?: string;
  } | null;

  probeP6?: unknown;
  permissionForm?: {
    form?: string;
    explicitPathsAllowed?: boolean;
    otherActions?: string;
    brokerRejects?: boolean;
    [key: string]: unknown;
  };
  fallbackChosen?: boolean;

  params?: unknown;
  [key: string]: unknown;
}

export type RequestPermissionParams = PermissionBrokerRequest;

export interface PermissionDecisionEventData {
  requestId: string;
  toolCallId: string;
  role: string;
  capability: string;
  target: string;
  optionKind: "allow_once" | "reject_once";
  rule: string;
  refs: string[];
  [key: string]: unknown;
}

export interface PermissionAnomalyEventData {
  requestId: string;
  toolCallId?: string;
  role?: string;
  capability?: string;
  target?: string;
  reason: string;
  neededKind?: "allow_once" | "reject_once";
  offeredKinds: string[];
  rule: string;
  refs: string[];
  [key: string]: unknown;
}

export type PermissionDecisionEvent = {
  runId: string;
  kind: "permission.decision";
  actor: "PermissionBroker";
  data: PermissionDecisionEventData;
};

export type PermissionAnomalyEvent = {
  runId: string;
  kind: "permission.anomaly";
  actor: "PermissionBroker";
  data: PermissionAnomalyEventData;
};

export type PermissionEvent = PermissionDecisionEvent | PermissionAnomalyEvent;

export interface PermissionDecision {
  outcome: RequestPermissionOutcome;
  selectedOption: PermissionOption | null;
  selectedOptionId: string | null;
  optionKind: "allow_once" | "reject_once" | null;
  cancelTurn: boolean;
  decision: "allow_once" | "reject_once" | "cancelled";
  rule: string;
  capability: string;
  target: string;
  requestId: string;
  toolCallId: string;
  role: string;
  event: PermissionEvent;

  option: PermissionOption | null;
  optionId: string | null;
  cancelled: boolean;
  anomaly: boolean;
}

const ALLOWED_MCP_TOOLS_BY_ROLE: Record<string, Set<string>> = {
  Planner: new Set(["report_task_result", "ask"]),
  Exhumer: new Set(["sandbox_exec", "sandbox_log", "report_task_result"]),
  Bonesetter: new Set([
    "sandbox_exec",
    "sandbox_log",
    "report_task_result",
    "ask",
    "report_blocker",
    "ack_message",
  ]),
  "Soul-stitcher": new Set([
    "sandbox_exec",
    "sandbox_log",
    "report_task_result",
    "ask",
    "report_blocker",
    "propose_task",
    "ack_message",
  ]),
  Warden: new Set(["sandbox_exec", "sandbox_log", "warden_verdict"]),
  Scribe: new Set(["report_task_result", "ack_message"]),
};

const FORBIDDEN_CAPABILITIES = new Set([
  "shell",
  "web_fetch",
  "web_search",
  "subagent",
  "skill",
  "power",
]);

const SECRET_PATH_PATTERNS = [
  /(?:^|\/)\.env(?:$|\..*)/i,
  /\.(?:key|pem|pkcs12|pfx|crt)$/i,
  /(?:^|\/)id_(?:rsa|ed25519|dsa|ecdsa)(?:$|\..*)/i,
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)\.aws(?:\/|$)/i,
];

export const MANIFEST_LOCK_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "pyproject.toml",
  "setup.cfg",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
]);

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class RequiredSettingError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = "RequiredSettingError";
  }
}

export class MalformedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedRequestError";
  }
}

export class DuplicateOptionIdError extends MalformedRequestError {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateOptionIdError";
  }
}

export class InvalidRequestError extends MalformedRequestError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/**
 * Validates that an incoming permission request meets the required shape:
 * - sessionId: non-empty string
 * - runId: non-empty string
 * - options: array of options
 * - each option: object with non-empty optionId and kind string
 * - no two options share an optionId (fail-closed)
 * Rejects any malformed request with a named error.
 */
export function validatePermissionRequest(
  request: unknown
): asserts request is PermissionBrokerRequest {
  if (!request || typeof request !== "object") {
    throw new MalformedRequestError("Permission request must be a non-null object");
  }

  const req = request as Record<string, unknown>;

  if (typeof req.sessionId !== "string" || req.sessionId.trim().length === 0) {
    throw new MalformedRequestError("Permission request missing required sessionId");
  }

  if (typeof req.runId !== "string" || req.runId.trim().length === 0) {
    throw new MalformedRequestError("Permission request missing required runId");
  }

  if (!Array.isArray(req.options)) {
    throw new MalformedRequestError("Permission request missing required options array");
  }

  const seenOptionIds = new Set<string>();

  for (let i = 0; i < req.options.length; i++) {
    const opt = req.options[i];
    if (!opt || typeof opt !== "object") {
      throw new MalformedRequestError(`Option at index ${i} must be a non-null object`);
    }

    const optObj = opt as Record<string, unknown>;
    const rawOptionId =
      optObj.optionId !== undefined && optObj.optionId !== null && String(optObj.optionId).trim().length > 0
        ? String(optObj.optionId).trim()
        : optObj.id !== undefined && optObj.id !== null && String(optObj.id).trim().length > 0
        ? String(optObj.id).trim()
        : "";

    if (!rawOptionId) {
      throw new MalformedRequestError(`Option at index ${i} missing required optionId`);
    }

    if (typeof optObj.kind !== "string" || optObj.kind.trim().length === 0) {
      throw new MalformedRequestError(`Option at index ${i} missing required kind string`);
    }

    if (seenOptionIds.has(rawOptionId)) {
      throw new DuplicateOptionIdError(`Duplicate optionId '${rawOptionId}' found at index ${i}`);
    }
    seenOptionIds.add(rawOptionId);
  }
}

export const validateRequestShape = validatePermissionRequest;
export const validateRequest = validatePermissionRequest;

function normalizeRole(roleStr: string): string {
  const s = roleStr.trim().toLowerCase();
  if (s === "planner") return "Planner";
  if (s === "exhumer") return "Exhumer";
  if (s === "bonesetter") return "Bonesetter";
  if (s === "soul-stitcher" || s === "soul_stitcher" || s === "soulstitcher") {
    return "Soul-stitcher";
  }
  if (s === "warden") return "Warden";
  if (s === "scribe") return "Scribe";
  return roleStr.trim();
}

function extractToolCallId(req: PermissionBrokerRequest): string {
  if (typeof req.toolCallId === "string" && req.toolCallId.length > 0) {
    return req.toolCallId;
  }
  if (
    typeof req.toolCall?.toolCallId === "string" &&
    req.toolCall.toolCallId.length > 0
  ) {
    return req.toolCall.toolCallId;
  }
  if (
    typeof req.subject?.toolCallId === "string" &&
    req.subject.toolCallId.length > 0
  ) {
    return req.subject.toolCallId;
  }
  const consent =
    req._meta?.kiro?.consent ?? req.toolCall?._meta?.kiro?.consent;
  if (consent && typeof consent === "object" && "toolCallId" in consent) {
    const tc = (consent as { toolCallId: unknown }).toolCallId;
    if (typeof tc === "string" && tc.length > 0) {
      return tc;
    }
  }
  if (req.id !== undefined && req.id !== null) {
    return String(req.id);
  }
  return "";
}

function extractConsent(req: PermissionBrokerRequest): unknown {
  return (
    req._meta?.kiro?.consent ??
    req.toolCall?._meta?.kiro?.consent ??
    req.consent
  );
}

function parseMcpToolIdentity(candidate: unknown): string | undefined {
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  if (candidate && typeof candidate === "object") {
    const obj = candidate as Record<string, unknown>;
    if (typeof obj.identity === "string" && obj.identity.trim().length > 0) {
      return obj.identity.trim();
    }
    if (
      typeof obj.serverName === "string" &&
      obj.serverName.trim().length > 0 &&
      typeof obj.toolName === "string" &&
      obj.toolName.trim().length > 0
    ) {
      return `${obj.serverName.trim()}/${obj.toolName.trim()}`;
    }
    if (typeof obj.name === "string" && obj.name.trim().length > 0) {
      return obj.name.trim();
    }
  }
  return undefined;
}

function extractMcpTool(req: PermissionBrokerRequest): string | undefined {
  const metaRecord = req._meta as Record<string, unknown> | undefined;
  const toolCallMetaRecord = req.toolCall?._meta as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    req._meta?.kiro?.mcpTool,
    req.toolCall?._meta?.kiro?.mcpTool,
    metaRecord?.mcpToolIdentity,
    toolCallMetaRecord?.mcpToolIdentity,
    req.mcpTool,
  ];
  for (const candidate of candidates) {
    const parsed = parseMcpToolIdentity(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function extractArguments(
  req: PermissionBrokerRequest
): Record<string, unknown> | null {
  const raw =
    req.arguments ??
    req.toolCall?.rawInput ??
    req.toolCall?.arguments ??
    req.rawInput ??
    (req.params && typeof req.params === "object"
      ? (req.params as Record<string, unknown>).arguments
      : undefined);

  if (!raw) return null;
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { _raw: raw };
    }
  }
  return null;
}

function extractTargetFromArgs(
  args: Record<string, unknown> | null,
  capability: string
): string {
  if (!args) return "";
  if (capability === "fs_read" || capability === "fs_write") {
    const p =
      args.path ??
      args.filePath ??
      args.file_path ??
      args.target ??
      args.uri ??
      args._raw;
    if (typeof p === "string") return p.trim();
  }
  if (capability === "mcp") {
    const t = args.tool ?? args.name ?? args.toolName ?? args.tool_name;
    if (typeof t === "string") return t.trim();
  }
  if (capability === "shell") {
    if (Array.isArray(args.argv)) {
      return args.argv.map(String).join(" ");
    }
    const c = args.command ?? args.cmd ?? args._raw;
    if (typeof c === "string") return c.trim();
  }
  if (capability === "web_fetch" || capability === "web_search") {
    const u = args.url ?? args.query ?? args.endpoint ?? args._raw;
    if (typeof u === "string") return u.trim();
  }
  const fallback = args.target ?? args.path ?? args.name ?? args.command;
  return typeof fallback === "string" ? fallback.trim() : "";
}

function extractCapabilityAndTarget(
  req: PermissionBrokerRequest,
  mcpTool: string | undefined,
  consent: unknown,
  args: Record<string, unknown> | null
): { capability: string; target: string } {
  if (mcpTool) {
    return {
      capability: "mcp",
      target: mcpTool,
    };
  }

  if (typeof consent === "string") {
    const c = consent.trim().toLowerCase();
    const target =
      extractTargetFromArgs(args, c) ||
      (typeof req.target === "string" ? req.target : "");
    return { capability: c, target };
  }

  if (consent && typeof consent === "object") {
    const cObj = consent as Record<string, unknown>;
    const cap = String(
      cObj.capability ?? cObj.type ?? cObj.action ?? cObj.kind ?? ""
    )
      .trim()
      .toLowerCase();
    const tgt =
      String(cObj.target ?? cObj.path ?? cObj.resource ?? "").trim() ||
      extractTargetFromArgs(args, cap);
    if (cap) {
      return { capability: cap, target: tgt };
    }
  }

  if (typeof req.capability === "string" && req.capability.trim().length > 0) {
    const cap = req.capability.trim().toLowerCase();
    const target =
      extractTargetFromArgs(args, cap) ||
      (typeof req.target === "string" ? req.target : "");
    return { capability: cap, target };
  }

  const tk = String(req.toolCall?.kind ?? "").trim().toLowerCase();
  if (tk === "read" || tk === "fs_read") {
    return {
      capability: "fs_read",
      target: extractTargetFromArgs(args, "fs_read"),
    };
  }
  if (tk === "write" || tk === "edit" || tk === "fs_write") {
    return {
      capability: "fs_write",
      target: extractTargetFromArgs(args, "fs_write"),
    };
  }
  if (tk === "execute" || tk === "shell") {
    return {
      capability: "shell",
      target: extractTargetFromArgs(args, "shell"),
    };
  }

  // Handle ACP v2 structured _meta.trustOptions setting_key metadata
  const trustOptions = (req._meta as Record<string, unknown> | undefined)?.trustOptions;
  if (Array.isArray(trustOptions)) {
    for (const item of trustOptions) {
      if (!item || typeof item !== "object") continue;
      const optObj = item as Record<string, unknown>;
      const settingKey = typeof optObj.setting_key === "string" ? optObj.setting_key.trim() : "";
      if (settingKey === "runtime_write_paths" || settingKey === "runtime_read_paths") {
        const cap = settingKey === "runtime_write_paths" ? "fs_write" : "fs_read";
        const firstPattern = Array.isArray(optObj.patterns) && typeof optObj.patterns[0] === "string"
          ? optObj.patterns[0].trim()
          : "";
        const display = typeof optObj.display === "string" ? optObj.display.trim() : "";
        const target = extractTargetFromArgs(args, cap) || firstPattern || display;
        return { capability: cap, target };
      }
    }
  }

  return {
    capability: "",
    target: typeof req.target === "string" ? req.target : "",
  };
}

function extractRole(req: PermissionBrokerRequest): string {
  const r = req.role;
  return typeof r === "string" ? r.trim() : "";
}

export function resolveRealPathWithNearestParent(targetPath: string): string {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      try {
        return fs.realpathSync(targetPath);
      } catch (err: any) {
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
          const linkTarget = fs.readlinkSync(targetPath);
          const absLinkTarget = path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(targetPath), linkTarget);
          return resolveRealPathWithNearestParent(absLinkTarget);
        }
        throw err;
      }
    }
    return fs.realpathSync(targetPath);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      let current = path.dirname(targetPath);
      const parts: string[] = [path.basename(targetPath)];
      while (current && current !== path.dirname(current)) {
        try {
          const currentStat = fs.lstatSync(current);
          if (currentStat.isSymbolicLink()) {
            try {
              const realParent = fs.realpathSync(current);
              return path.resolve(realParent, ...parts);
            } catch (linkErr: any) {
              if (linkErr && (linkErr.code === "ENOENT" || linkErr.code === "ENOTDIR")) {
                const linkTarget = fs.readlinkSync(current);
                const absLinkTarget = path.isAbsolute(linkTarget)
                  ? linkTarget
                  : path.resolve(path.dirname(current), linkTarget);
                const realParent = resolveRealPathWithNearestParent(absLinkTarget);
                return path.resolve(realParent, ...parts);
              }
            }
          }
          const realParent = fs.realpathSync(current);
          return path.resolve(realParent, ...parts);
        } catch (parentErr: any) {
          if (parentErr && (parentErr.code === "ENOENT" || parentErr.code === "ENOTDIR")) {
            parts.unshift(path.basename(current));
            current = path.dirname(current);
            continue;
          }
          break;
        }
      }
      try {
        const realRoot = fs.realpathSync(current);
        return path.resolve(realRoot, ...parts);
      } catch {
        return targetPath;
      }
    }
    return targetPath;
  }
}

export function isRootDir(p: string): boolean {
  if (!p || typeof p !== "string" || p.trim().length === 0) return false;
  const norm = p.replace(/\\/g, "/");
  if (norm === "/" || /^\/+$/.test(norm)) return true;
  const parsed = path.parse(p);
  if (parsed.root.length > 0 && parsed.root === p) return true;
  const winParsed = path.win32.parse(p);
  if (winParsed.root.length > 0 && winParsed.root === p) return true;
  return false;
}

function isPathWithinDir(targetPath: string, baseDir: string): boolean {
  if (!baseDir) return false;
  const absBase = path.resolve(baseDir);
  const absTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(absBase, targetPath);

  if (absTarget === absBase) return true;
  const rel = path.relative(absBase, absTarget);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isPathWithinAnyDir(targetPath: string, baseDirs: string[]): boolean {
  for (const dir of baseDirs) {
    if (isPathWithinDir(targetPath, dir)) return true;
  }
  return false;
}

function isPathProhibitedForRead(filePath: string, cwd: string): boolean {
  const p = filePath.replace(/\\/g, "/");

  if (/^\/?proc(?:\/|$)/i.test(p) || p.includes("/proc/")) return true;
  if (/^\/?sys(?:\/|$)/i.test(p) || p.includes("/sys/")) return true;
  if (/^\/?dev(?:\/|$)/i.test(p) || p.includes("/dev/")) return true;

  if (/(?:^|\/)kiro[-_]?home(?:\/|$)/i.test(p)) return true;

  if (/^\/?(?:root|home(?:\/[^/]+)?)(?:\/|$)/i.test(p)) {
    if (!cwd || !isPathWithinDir(filePath, cwd)) {
      return true;
    }
  }

  for (const regex of SECRET_PATH_PATTERNS) {
    if (regex.test(p)) return true;
  }

  return false;
}

/**
 * Pure decision engine function.
 * Evaluates host-supplied identity and arguments without inspecting
 * request title or annotations.
 * Selects exactly one offered option of kind allow_once or reject_once.
 * Never selects allow_always or reject_always.
 * Never modifies permissions.yaml.
 * If no one-time option of the needed kind is offered, selects no option,
 * answers cancelled, and cancels the turn.
 */
export function decide(request: PermissionBrokerRequest): PermissionDecision {
  const reqId =
    request.requestId ??
    (request.id !== undefined && request.id !== null ? String(request.id) : "") ??
    "";
  const toolCallId = extractToolCallId(request);
  const rawRole = extractRole(request);
  const normRole = normalizeRole(rawRole);
  const consent = extractConsent(request);
  const mcpTool = extractMcpTool(request);
  const args = extractArguments(request);

  let { capability, target } = extractCapabilityAndTarget(
    request,
    mcpTool,
    consent,
    args
  );

  const cwd = request.cwd ?? "";

  let neededKind: "allow_once" | "reject_once" = "reject_once";
  let matchedRule = "default_reject";

  // 1. Probe P6 fallback check (Requirement 45.7)
  let isFallback = false;
  if (request.fallbackChosen === true) {
    isFallback = true;
  } else if (
    request.permissionForm &&
    typeof request.permissionForm === "object"
  ) {
    if (
      request.permissionForm.brokerRejects === true ||
      request.permissionForm.form === "documented-safe" ||
      request.permissionForm.otherActions === "ask"
    ) {
      isFallback = true;
    }
  } else if (request.probeP6 !== undefined && request.probeP6 !== null) {
    if (typeof request.probeP6 === "boolean") {
      if (!request.probeP6) isFallback = true;
    } else {
      try {
        const settled = resolvePermissionForm(request.probeP6 as any);
        if (
          settled === "not passed" ||
          (typeof settled === "object" && settled.brokerRejects)
        ) {
          isFallback = true;
        }
      } catch {
        // Fallback resolution error fails closed
        isFallback = true;
      }
    }
  }

  if (isFallback) {
    neededKind = "reject_once";
    matchedRule = "probe_p6_fallback";
  } else {
    // Built-in rule evaluation (Requirements 18.5 - 18.12)
    if (FORBIDDEN_CAPABILITIES.has(capability)) {
      // Requirement 18.12
      neededKind = "reject_once";
      matchedRule = "forbidden_capability";
    } else if (capability === "mcp") {
      // Requirements 18.10, 18.11
      if (!target) {
        neededKind = "reject_once";
        matchedRule = "reject_unlisted_mcp_tool";
      } else {
        let toolName = target.trim();
        if (toolName.startsWith("@")) {
          toolName = toolName.slice(1);
        }
        if (!toolName.startsWith("necromancer/")) {
          neededKind = "reject_once";
          matchedRule = "reject_unlisted_mcp_tool";
        } else {
          const shortName = toolName.slice("necromancer/".length).trim();
          const allowedTools = ALLOWED_MCP_TOOLS_BY_ROLE[normRole];
          if (allowedTools && allowedTools.has(shortName)) {
            neededKind = "allow_once";
            matchedRule = "allow_mcp_gateway_tool";
          } else {
            neededKind = "reject_once";
            matchedRule = "reject_unlisted_mcp_tool";
          }
        }
      }
    } else if (capability === "fs_read") {
      // Requirements 18.6, 18.7
      // Reject when cwd is empty; there is no relative fallback
      if (!cwd || cwd.trim().length === 0) {
        neededKind = "reject_once";
        matchedRule = "reject_fs_read_outside_workspace";
      } else if (!target || target.trim().length === 0) {
        neededKind = "reject_once";
        matchedRule = "reject_fs_read_prohibited";
      } else {
        const absCwd = path.resolve(cwd);
        const normTarget = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(absCwd, target);

        // A request that asks for / or for any directory outside the configured set is denied
        if (isRootDir(normTarget) || isRootDir(target)) {
          neededKind = "reject_once";
          matchedRule = "reject_fs_read_outside_workspace";
        } else if (isPathProhibitedForRead(normTarget, absCwd)) {
          neededKind = "reject_once";
          matchedRule = "reject_fs_read_prohibited";
        } else {
          const searchDirs = [
            absCwd,
            ...(request.additionalDirectories ?? []).map((d) => path.resolve(d)),
          ].filter(Boolean);

          if (!isPathWithinAnyDir(normTarget, searchDirs)) {
            neededKind = "reject_once";
            matchedRule = "reject_fs_read_outside_workspace";
          } else {
            // Check realpath / symlinks
            const realTarget = resolveRealPathWithNearestParent(normTarget);
            const realCwd = resolveRealPathWithNearestParent(absCwd);
            const realSearchDirs = [
              realCwd,
              ...(request.additionalDirectories ?? []).map((d) =>
                resolveRealPathWithNearestParent(path.resolve(d))
              ),
            ].filter(Boolean);

            if (
              isRootDir(realTarget) ||
              !isPathWithinAnyDir(realTarget, realSearchDirs)
            ) {
              neededKind = "reject_once";
              matchedRule = "reject_fs_read_outside_workspace";
            } else if (isPathProhibitedForRead(realTarget, realCwd)) {
              neededKind = "reject_once";
              matchedRule = "reject_fs_read_prohibited";
            } else {
              neededKind = "allow_once";
              matchedRule = "allow_fs_read_workspace";
            }
          }
        }
      }
    } else if (capability === "fs_write") {
      // Requirements 18.8, 18.9
      // Reject when cwd is empty; there is no relative fallback
      if (!cwd || cwd.trim().length === 0) {
        neededKind = "reject_once";
        matchedRule = "reject_fs_write_outside_scope";
      } else if (!target || target.trim().length === 0) {
        neededKind = "reject_once";
        matchedRule = "reject_fs_write_outside_scope";
      } else {
        const absCwd = path.resolve(cwd);
        const normTarget = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(absCwd, target);

        // A request that asks for / or for any directory outside cwd is denied
        const relFromCwd = path.relative(absCwd, normTarget);
        if (
          isRootDir(normTarget) ||
          isRootDir(target) ||
          relFromCwd.startsWith("..") ||
          path.isAbsolute(relFromCwd)
        ) {
          neededKind = "reject_once";
          matchedRule = "reject_fs_write_outside_scope";
        } else {
          const p = normTarget.replace(/\\/g, "/");

          if (
            /(?:^|\/)\.git(?:\/|$)/i.test(p) ||
            /(?:^|\/)\.kiro(?:\/|$)/i.test(p)
          ) {
            neededKind = "reject_once";
            matchedRule = "reject_fs_write_git_kiro";
          } else if (normRole === "Exhumer" || normRole === "Warden") {
            neededKind = "reject_once";
            matchedRule = "reject_fs_write_role_forbidden";
          } else {
            // Check realpath / symlinks
            const realTarget = resolveRealPathWithNearestParent(normTarget);
            const realCwd = resolveRealPathWithNearestParent(absCwd);

            if (isRootDir(realTarget) || !isPathWithinDir(realTarget, realCwd)) {
              neededKind = "reject_once";
              matchedRule = "reject_fs_write_outside_scope";
            } else {
              const realP = realTarget.replace(/\\/g, "/");
              if (
                /(?:^|\/)\.git(?:\/|$)/i.test(realP) ||
                /(?:^|\/)\.kiro(?:\/|$)/i.test(realP)
              ) {
                neededKind = "reject_once";
                matchedRule = "reject_fs_write_git_kiro";
              } else if (normRole === "Planner") {
                // A Planner may write only under specs/ inside cwd after normalisation,
                // and a sibling directory with the same prefix must not match.
                // Uses the real target (realpath)
                const specsDir = path.resolve(realCwd, "specs");
                const realSpecsDir = resolveRealPathWithNearestParent(specsDir);
                const relSpecs = path.relative(realSpecsDir, realTarget);

                const isUnderSpecs =
                  !relSpecs.startsWith("..") &&
                  !path.isAbsolute(relSpecs) &&
                  relSpecs.length > 0;

                if (isUnderSpecs) {
                  neededKind = "allow_once";
                  matchedRule = "allow_fs_write_scope";
                } else {
                  neededKind = "reject_once";
                  matchedRule = "reject_fs_write_outside_scope";
                }
              } else if (normRole === "Scribe") {
                let isNormTargetSymlink = false;
                try {
                  isNormTargetSymlink = fs.lstatSync(normTarget).isSymbolicLink();
                } catch {
                  isNormTargetSymlink = false;
                }

                const reportDir = path.resolve(absCwd, "report");
                const reportsDir = path.resolve(absCwd, "reports");
                const relReport = path.relative(reportDir, normTarget);
                const relReports = path.relative(reportsDir, normTarget);
                const normRel = relFromCwd.replace(/\\/g, "/");

                const isLexicalReport =
                  !relReport.startsWith("..") &&
                  !path.isAbsolute(relReport) &&
                  relReport.length > 0;
                const isLexicalReports =
                  !relReports.startsWith("..") &&
                  !path.isAbsolute(relReports) &&
                  relReports.length > 0;
                const isLexicalFile =
                  normRel === "report.md" || normRel === "report.json";

                const reportDirCandidate = path.resolve(realCwd, "report");
                const reportsDirCandidate = path.resolve(realCwd, "reports");
                const realReportDir = resolveRealPathWithNearestParent(reportDirCandidate);
                const realReportsDir = resolveRealPathWithNearestParent(reportsDirCandidate);

                let reportIsSymlink = false;
                try {
                  reportIsSymlink = fs.lstatSync(reportDirCandidate).isSymbolicLink();
                } catch {
                  reportIsSymlink = false;
                }

                let reportsIsSymlink = false;
                try {
                  reportsIsSymlink = fs.lstatSync(reportsDirCandidate).isSymbolicLink();
                } catch {
                  reportsIsSymlink = false;
                }

                const reportDirEscapes =
                  reportIsSymlink &&
                  (path.basename(realReportDir) !== "report" ||
                    !isPathWithinDir(realReportDir, realCwd));

                const reportsDirEscapes =
                  reportsIsSymlink &&
                  (path.basename(realReportsDir) !== "reports" ||
                    !isPathWithinDir(realReportsDir, realCwd));

                const realRelFromCwd = path.relative(realCwd, realTarget).replace(/\\/g, "/");

                const relRealReport = path.relative(realReportDir, realTarget);
                const isUnderRealReport =
                  !relRealReport.startsWith("..") &&
                  !path.isAbsolute(relRealReport) &&
                  relRealReport.length > 0;

                const relRealReports = path.relative(realReportsDir, realTarget);
                const isUnderRealReports =
                  !relRealReports.startsWith("..") &&
                  !path.isAbsolute(relRealReports) &&
                  relRealReports.length > 0;

                const allowedInReport =
                  !reportDirEscapes && isLexicalReport && isUnderRealReport;
                const allowedInReports =
                  !reportsDirEscapes && isLexicalReports && isUnderRealReports;
                const allowedFile =
                  isLexicalFile &&
                  (realRelFromCwd === "report.md" || realRelFromCwd === "report.json");

                if (
                  !isNormTargetSymlink &&
                  (allowedInReport || allowedInReports || allowedFile)
                ) {
                  neededKind = "allow_once";
                  matchedRule = "allow_fs_write_scope";
                } else {
                  neededKind = "reject_once";
                  matchedRule = "reject_fs_write_outside_scope";
                }
              } else if (normRole === "Bonesetter") {
                // The manifest and lock names are matched only at the cwd root,
                // and only the exact ten-name intersection shared with the
                // Bonesetter tool boundary is writable (finding [21]).
                // Uses the real target (realpath)
                const realRel = path.relative(realCwd, realTarget).replace(/\\/g, "/").toLowerCase();
                if (!realRel.includes("/") && BONESETTER_WRITABLE_FILENAMES.has(realRel)) {
                  neededKind = "allow_once";
                  matchedRule = "allow_fs_write_scope";
                } else {
                  neededKind = "reject_once";
                  matchedRule = "reject_fs_write_outside_scope";
                }
              } else if (normRole === "Soul-stitcher") {
                neededKind = "allow_once";
                matchedRule = "allow_fs_write_scope";
              } else {
                neededKind = "reject_once";
                matchedRule = "reject_fs_write_outside_scope";
              }
            }
          }
        }
      }
    } else {
      // Requirement 18.5
      neededKind = "reject_once";
      matchedRule = "default_reject";
    }
  }

  // Option Selection (Requirements 18.1, 18.2, 18.3, 18.15)
  // ACP requirement: decide() selects only an option whose kind is exactly the string
  // allow_once or the string reject_once. Any other kind is never selected.
  // The option object is chosen directly and its own optionId is returned without looking it up by id.
  // When two or more options share the same optionId the broker must not select any option.
  // Return outcome cancelled and emit a permission.anomaly event that names the duplicate id.
  // If no exact one-time option is offered, select nothing and cancel.
  const offeredOptions = Array.isArray(request.options) ? request.options : [];
  const runId = typeof request.runId === "string" ? request.runId : "";

  // Check for duplicate optionIds across all offered options
  const seenOptionIds = new Map<string, number>();
  for (const opt of offeredOptions) {
    if (!opt || typeof opt !== "object") continue;
    const rawOptionId =
      opt.optionId !== undefined && opt.optionId !== null && String(opt.optionId).trim().length > 0
        ? String(opt.optionId)
        : opt.id !== undefined && opt.id !== null && String(opt.id).trim().length > 0
        ? String(opt.id)
        : "";
    const optId = rawOptionId.trim();
    if (optId) {
      seenOptionIds.set(optId, (seenOptionIds.get(optId) ?? 0) + 1);
    }
  }

  let duplicateId: string | undefined;
  for (const [id, count] of seenOptionIds.entries()) {
    if (count > 1) {
      duplicateId = id;
      break;
    }
  }

  if (duplicateId !== undefined) {
    const cancelOutcome: RequestPermissionOutcome = {
      outcome: "cancelled",
    };

    const anomalyEvent: PermissionAnomalyEvent = {
      runId,
      kind: "permission.anomaly",
      actor: "PermissionBroker",
      data: {
        requestId: reqId,
        toolCallId,
        role: normRole || rawRole,
        capability,
        target,
        reason: `duplicate_option_id: ${duplicateId}`,
        duplicateOptionId: duplicateId,
        duplicateId,
        neededKind,
        offeredKinds: offeredOptions.map((o) =>
          typeof o === "object" && o !== null
            ? String(o.kind ?? o.optionId ?? o.id ?? "unknown")
            : "unknown"
        ),
        rule: matchedRule,
        refs: [],
      },
    };

    return {
      outcome: cancelOutcome,
      selectedOption: null,
      selectedOptionId: null,
      optionKind: null,
      cancelTurn: true,
      decision: "cancelled",
      rule: matchedRule,
      capability,
      target,
      requestId: reqId,
      toolCallId,
      role: normRole || rawRole,
      event: anomalyEvent,

      option: null,
      optionId: null,
      cancelled: true,
      anomaly: true,
    };
  }

  let selectedIndex = -1;
  let matchedOption: PermissionOption | null = null;
  let matchedRawOptionId = "";

  for (let i = 0; i < offeredOptions.length; i++) {
    const opt = offeredOptions[i];
    if (!opt || typeof opt !== "object") continue;

    const rawOptionId =
      opt.optionId !== undefined && opt.optionId !== null && String(opt.optionId).trim().length > 0
        ? String(opt.optionId)
        : opt.id !== undefined && opt.id !== null && String(opt.id).trim().length > 0
        ? String(opt.id)
        : "";
    const optId = rawOptionId.trim();

    if (!optId) continue;

    // Only match exact one-time kind (allow_once or reject_once).
    // Any other kind (including reject-once, allow-once, persistent options) is never selected.
    if (
      (neededKind === "allow_once" && opt.kind === "allow_once") ||
      (neededKind === "reject_once" && opt.kind === "reject_once")
    ) {
      selectedIndex = i;
      matchedOption = offeredOptions[i];
      matchedRawOptionId = rawOptionId;
      if (matchedOption.optionId === undefined) {
        try {
          (matchedOption as any).optionId = rawOptionId;
        } catch {
          // Ignore if opt is non-extensible/frozen
        }
      }
      break;
    }
  }

  if (matchedOption) {
    // Exactly one option of kind allow_once or reject_once selected (Requirement 18.1)
    const selectedOptionId = matchedRawOptionId;
    const outcome: RequestPermissionOutcome = {
      outcome: "selected",
      optionId: selectedOptionId,
    };

    const decisionEvent: PermissionDecisionEvent = {
      runId,
      kind: "permission.decision",
      actor: "PermissionBroker",
      data: {
        requestId: reqId,
        toolCallId,
        role: normRole || rawRole,
        capability,
        target,
        optionKind: neededKind,
        rule: matchedRule,
        refs: [],
      },
    };

    return {
      outcome,
      selectedOption: matchedOption,
      selectedOptionId,
      optionKind: neededKind,
      cancelTurn: false,
      decision: neededKind,
      rule: matchedRule,
      capability,
      target,
      requestId: reqId,
      toolCallId,
      role: normRole || rawRole,
      event: decisionEvent,

      option: matchedOption,
      optionId: selectedOptionId,
      cancelled: false,
      anomaly: false,
    };
  }

  // Requirement 18.3: No one-time option of needed kind offered -> cancel turn and emit anomaly
  const cancelOutcome: RequestPermissionOutcome = {
    outcome: "cancelled",
  };

  const anomalyEvent: PermissionAnomalyEvent = {
    runId,
    kind: "permission.anomaly",
    actor: "PermissionBroker",
    data: {
      requestId: reqId,
      toolCallId,
      role: normRole || rawRole,
      capability,
      target,
      reason: "no_one_time_option_offered",
      neededKind,
      offeredKinds: offeredOptions.map((o) =>
        typeof o === "object" && o !== null
          ? String(o.kind ?? o.optionId ?? o.id ?? "unknown")
          : "unknown"
      ),
      rule: matchedRule,
      refs: [],
    },
  };

  return {
    outcome: cancelOutcome,
    selectedOption: null,
    selectedOptionId: null,
    optionKind: null,
    cancelTurn: true,
    decision: "cancelled",
    rule: matchedRule,
    capability,
    target,
    requestId: reqId,
    toolCallId,
    role: normRole || rawRole,
    event: anomalyEvent,

    option: null,
    optionId: null,
    cancelled: true,
    anomaly: true,
  };
}

/**
 * Pure decision evaluator for watchdog timeouts on unanswered requests.
 * Requirements: 18.14, 41.23, Task 10.2.
 * Selects reject_once from offered options matching verified shapes,
 * never selecting allow_always or reject_always.
 * If no reject_once option is offered, selects no option, answers cancelled,
 * and marks cancelTurn: true (Requirement 18.3).
 */
export function decideWatchdogTimeout(
  request: PermissionBrokerRequest,
  watchdogLimitMs?: number
): PermissionDecision {
  if (
    watchdogLimitMs === undefined ||
    watchdogLimitMs === null ||
    typeof watchdogLimitMs !== "number" ||
    !Number.isFinite(watchdogLimitMs) ||
    watchdogLimitMs <= 0
  ) {
    throw new RequiredSettingError(
      `PermissionBroker requires an explicit positive finite watchdog limit in settings (got: ${watchdogLimitMs})`
    );
  }
  const reqId =
    request.requestId ??
    (request.id !== undefined && request.id !== null ? String(request.id) : "") ??
    "";
  const toolCallId = extractToolCallId(request);
  const rawRole = extractRole(request);
  const normRole = normalizeRole(rawRole);
  const consent = extractConsent(request);
  const mcpTool = extractMcpTool(request);
  const args = extractArguments(request);

  const { capability, target } = extractCapabilityAndTarget(
    request,
    mcpTool,
    consent,
    args
  );

  const offeredOptions = Array.isArray(request.options) ? request.options : [];
  let selectedIndex = -1;
  let matchedOption: PermissionOption | null = null;
  let matchedRawOptionId = "";

  for (let i = 0; i < offeredOptions.length; i++) {
    const opt = offeredOptions[i];
    if (!opt || typeof opt !== "object") continue;

    const rawOptionId =
      opt.optionId !== undefined && opt.optionId !== null && String(opt.optionId).trim().length > 0
        ? String(opt.optionId)
        : opt.id !== undefined && opt.id !== null && String(opt.id).trim().length > 0
        ? String(opt.id)
        : "";
    const optId = rawOptionId.trim();

    if (!optId) continue;

    // Only match exact reject_once kind.
    // Any other kind (including reject-once, allow-once, persistent options) is never selected.
    if (opt.kind === "reject_once") {
      selectedIndex = i;
      matchedOption = offeredOptions[i];
      matchedRawOptionId = rawOptionId;
      if (matchedOption.optionId === undefined) {
        try {
          (matchedOption as any).optionId = rawOptionId;
        } catch {
          // Ignore if opt is non-extensible/frozen
        }
      }
      break;
    }
  }

  const runId = typeof request.runId === "string" ? request.runId : "";

  if (matchedOption) {
    // Exactly one option of kind reject_once selected (Requirements 18.1, 18.14, 41.23)
    const selectedOptionId = matchedRawOptionId;
    const outcome: RequestPermissionOutcome = {
      outcome: "selected",
      optionId: selectedOptionId,
    };

    const anomalyEvent: PermissionAnomalyEvent = {
      runId,
      kind: "permission.anomaly",
      actor: "PermissionBroker",
      data: {
        requestId: reqId,
        toolCallId,
        role: normRole || rawRole,
        capability,
        target,
        reason: "watchdog_timeout",
        neededKind: "reject_once",
        offeredKinds: offeredOptions.map((o) =>
          typeof o === "object" && o !== null
            ? String(o.kind ?? o.optionId ?? o.id ?? "unknown")
            : "unknown"
        ),
        rule: "broker_watchdog_timeout",
        refs: [],
      },
    };

    return {
      outcome,
      selectedOption: matchedOption,
      selectedOptionId,
      optionKind: "reject_once",
      cancelTurn: false,
      decision: "reject_once",
      rule: "broker_watchdog_timeout",
      capability,
      target,
      requestId: reqId,
      toolCallId,
      role: normRole || rawRole,
      event: anomalyEvent,

      option: matchedOption,
      optionId: selectedOptionId,
      cancelled: false,
      anomaly: true,
    };
  }

  // Requirement 18.3: No one-time option of needed kind offered -> cancel turn and emit anomaly
  const cancelOutcome: RequestPermissionOutcome = {
    outcome: "cancelled",
  };

  const anomalyEvent: PermissionAnomalyEvent = {
    runId,
    kind: "permission.anomaly",
    actor: "PermissionBroker",
    data: {
      requestId: reqId,
      toolCallId,
      role: normRole || rawRole,
      capability,
      target,
      reason: "watchdog_timeout_no_reject_once_option",
      neededKind: "reject_once",
      offeredKinds: offeredOptions.map((o) =>
        typeof o === "object" && o !== null
          ? String(o.kind ?? o.optionId ?? o.id ?? "unknown")
          : "unknown"
      ),
      rule: "broker_watchdog_timeout",
      refs: [],
    },
  };

  return {
    outcome: cancelOutcome,
    selectedOption: null,
    selectedOptionId: null,
    optionKind: null,
    cancelTurn: true,
    decision: "cancelled",
    rule: "broker_watchdog_timeout",
    capability,
    target,
    requestId: reqId,
    toolCallId,
    role: normRole || rawRole,
    event: anomalyEvent,

    option: null,
    optionId: null,
    cancelled: true,
    anomaly: true,
  };
}

/**
 * Adapter interface for ACP client permission handling.
 */
export interface AcpPermissionBrokerAdapter {
  handleRequestPermission(
    request: PermissionBrokerRequest
  ): Promise<RequestPermissionResponse> | RequestPermissionResponse;
  cancelTurn?(sessionId?: string, reason?: string): Promise<void> | void;
  cancelRequest?(
    requestId: string,
    reason?: string
  ): Promise<RequestPermissionResponse | null> | RequestPermissionResponse | null;
  handleWatchdogTimeout?(
    request: PermissionBrokerRequest,
    limitMs?: number
  ): Promise<RequestPermissionResponse> | RequestPermissionResponse;
}

export type AcpPermissionHandler = (
  request: PermissionBrokerRequest
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

export interface PermissionBrokerAdapterOptions {
  role?: string;
  cwd?: string;
  additionalDirectories?: string[];
  settings?: Record<string, unknown>;
  probeP6?: unknown;
  permissionForm?: {
    form?: string;
    explicitPathsAllowed?: boolean;
    otherActions?: string;
    brokerRejects?: boolean;
    [key: string]: unknown;
  };
  fallbackChosen?: boolean;
  runId?: string;
  watchdogLimitMs?: number;
  watchdogMs?: number;
  watchdogTimeoutMs?: number;
  timeoutMs?: number;
  onEvent?: (event: PermissionEvent) => void | Promise<void>;
  onCancelTurn?: (sessionId?: string, reason?: string) => void | Promise<void>;
  onLogBug?: (message: string, context?: unknown) => void | Promise<void>;
  logger?: {
    error?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    info?: (message: string, ...args: unknown[]) => void;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface PendingPermissionEntry {
  requestId: string;
  sessionId?: string;
  request: PermissionBrokerRequest;
  timer?: NodeJS.Timeout;
  limitMs: number;
  resolve: (res: RequestPermissionResponse) => void;
  reject: (err: unknown) => void;
  startTime: number;
}

/**
 * ACP client adapter for PermissionBroker with role boundary enforcement,
 * watchdog timeout handling for unanswered requests, and turn cancellation.
 */
export class PermissionBrokerAdapter implements AcpPermissionBrokerAdapter {
  readonly watchdogLimitMs: number;
  protected options: PermissionBrokerAdapterOptions;
  private pendingRequests: Map<string, PendingPermissionEntry> = new Map();
  private requestCounter: number = 0;

  constructor(options: PermissionBrokerAdapterOptions = {}) {
    const settingsObj = (options.settings ?? options) as Record<string, unknown>;
    // Audit M-3: the watchdog comes only from the required watchdogLimitMs
    // setting; timeoutMs and alias keys are never used as the watchdog.
    const rawLimit = settingsObj?.watchdogLimitMs ?? options.watchdogLimitMs;

    const limit = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
    if (typeof rawLimit !== "number" && typeof rawLimit !== "string") {
      throw new RequiredSettingError(
        `PermissionBroker requires a positive finite watchdog limit in settings (got: ${rawLimit})`
      );
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new RequiredSettingError(
        `PermissionBroker requires a positive finite watchdog limit in settings (got: ${rawLimit})`
      );
    }

    this.watchdogLimitMs = limit;
    this.options = { ...options, watchdogLimitMs: limit };
  }

  public resolveWatchdogLimit(_req?: PermissionBrokerRequest): number {
    if (
      typeof this.watchdogLimitMs !== "number" ||
      !Number.isFinite(this.watchdogLimitMs) ||
      this.watchdogLimitMs <= 0
    ) {
      throw new RequiredSettingError(
        `PermissionBroker requires a positive finite watchdog limit in settings (got: ${this.watchdogLimitMs})`
      );
    }
    return this.watchdogLimitMs;
  }

  public isRequestExpired(
    req: PermissionBrokerRequest,
    limitMs: number
  ): boolean {
    if (
      req.timedOut === true ||
      req.isWatchdogTimeout === true ||
      req.unanswered === true ||
      req.watchdogExpired === true ||
      req.isTimeout === true
    ) {
      return true;
    }
    if (typeof req.ageMs === "number" && req.ageMs >= limitMs) {
      return true;
    }
    const ts =
      req.receivedAt ?? req.createdAt ?? req.timestamp ?? req.ts ?? req.requestTime;
    if (ts !== undefined && ts !== null) {
      const time =
        ts instanceof Date
          ? ts.getTime()
          : typeof ts === "string"
          ? new Date(ts).getTime()
          : Number(ts);
      if (!Number.isNaN(time) && Date.now() - time >= limitMs) {
        return true;
      }
    }
    return false;
  }

  public async handleWatchdogTimeout(
    request: PermissionBrokerRequest,
    limitMs?: number
  ): Promise<RequestPermissionResponse> {
    const effectiveLimit =
      typeof limitMs === "number" && Number.isFinite(limitMs) && limitMs > 0
        ? limitMs
        : this.watchdogLimitMs;
    const decision = decideWatchdogTimeout(request, effectiveLimit);

    // 1. Log a Necromancer bug (Requirements 18.14, 41.23, Task 10.2)
    const bugMsg = `[Necromancer bug] Permission request ${decision.requestId || decision.toolCallId || "unknown"} remained unanswered past watchdog limit (${effectiveLimit}ms)`;
    console.error(bugMsg);
    if (typeof this.options.onLogBug === "function") {
      try {
        await this.options.onLogBug(bugMsg, {
          requestId: decision.requestId,
          toolCallId: decision.toolCallId,
          role: decision.role,
          watchdogLimitMs: effectiveLimit,
        });
      } catch {
        // ignore logger error
      }
    }
    if (typeof this.options.logger?.error === "function") {
      try {
        this.options.logger.error(bugMsg, {
          requestId: decision.requestId,
          toolCallId: decision.toolCallId,
          watchdogLimitMs: effectiveLimit,
        });
      } catch {
        // ignore logger error
      }
    }

    // 2. Emit permission.anomaly (Requirements 41.23, Task 10.2)
    if (this.options.onEvent && decision.event) {
      await this.options.onEvent(decision.event);
    }

    // 3. Cancel path if no reject_once option offered (Requirement 18.3)
    if (decision.cancelTurn && this.options.onCancelTurn) {
      const reason =
        decision.event.kind === "permission.anomaly"
          ? decision.event.data.reason
          : "watchdog_timeout_cancelled";
      await this.options.onCancelTurn(request.sessionId, reason);
    }

    return {
      outcome: decision.outcome,
    };
  }

  protected async applyDecision(
    decision: PermissionDecision,
    request: PermissionBrokerRequest
  ): Promise<RequestPermissionResponse> {
    if (this.options.onEvent && decision.event) {
      await this.options.onEvent(decision.event);
    }

    if (decision.cancelTurn && this.options.onCancelTurn) {
      const reason =
        decision.event.kind === "permission.anomaly"
          ? decision.event.data.reason
          : "permission_rejected";
      await this.options.onCancelTurn(request.sessionId, reason);
    }

    return {
      outcome: decision.outcome,
    };
  }

  public validateRequest(request: unknown): void {
    validatePermissionRequest(request);
  }

  public mergeRequest(request: PermissionBrokerRequest): PermissionBrokerRequest {
    const optionFieldKeys = new Set([
      "role",
      "cwd",
      "additionalDirectories",
      "settings",
      "probeP6",
      "permissionForm",
      "fallbackChosen",
      "runId",
      "watchdogLimitMs",
      "watchdogMs",
      "watchdogTimeoutMs",
      "timeoutMs",
      "onEvent",
      "onCancelTurn",
      "onLogBug",
      "logger",
    ]);

    const forbiddenProtocolKeys = new Set([
      "asyncEvaluator",
      "pending",
      "evaluator",
      "decision",
      "timedOut",
      "isWatchdogTimeout",
      "unanswered",
      "watchdogExpired",
      "isTimeout",
      "ageMs",
    ]);

    const protocolReq: PermissionBrokerRequest = {};
    for (const [key, val] of Object.entries(request)) {
      if (!optionFieldKeys.has(key) && !forbiddenProtocolKeys.has(key)) {
        (protocolReq as any)[key] = val;
      }
    }

    const merged: PermissionBrokerRequest = {
      ...protocolReq,
      ...this.options,
      role: this.options.role,
      cwd: this.options.cwd,
      additionalDirectories: this.options.additionalDirectories,
      settings: this.options.settings,
      probeP6: this.options.probeP6,
      permissionForm: this.options.permissionForm,
      fallbackChosen: this.options.fallbackChosen,
      runId: this.options.runId ?? request.runId,
      watchdogLimitMs: this.watchdogLimitMs,
    };

    delete (merged as any).decision;
    delete (merged as any).timedOut;
    delete (merged as any).isWatchdogTimeout;
    delete (merged as any).unanswered;
    delete (merged as any).watchdogExpired;
    delete (merged as any).isTimeout;
    delete (merged as any).ageMs;
    delete (merged as any).evaluator;
    if ((this.options as any).asyncEvaluator === undefined) {
      delete (merged as any).asyncEvaluator;
    }
    if ((this.options as any).pending === undefined) {
      delete (merged as any).pending;
    }

    return merged;
  }

  async handleRequestPermission(
    request: PermissionBrokerRequest,
    options?: { validate?: boolean }
  ): Promise<RequestPermissionResponse> {
    if (options?.validate || (this.options as any).validateRequests || (this.options as any).strictValidation) {
      validatePermissionRequest(request);
    }
    const mergedReq = this.mergeRequest(request);

    const watchdogLimit = this.resolveWatchdogLimit(mergedReq);

    // If request already unanswered / timed out past watchdog limit
    if (this.isRequestExpired(mergedReq, watchdogLimit)) {
      return this.handleWatchdogTimeout(mergedReq, watchdogLimit);
    }

    // If pending or async evaluation requested
    if (
      typeof mergedReq.asyncEvaluator === "function" ||
      mergedReq.pending === true
    ) {
      return this.waitForDecision(mergedReq, watchdogLimit);
    }

    const { asyncEvaluator: _ae, evaluator: _ev, ...cleanMergedReq } = mergedReq as any;
    const decision = decide(cleanMergedReq);
    return this.applyDecision(decision, mergedReq);
  }

  public decide(request: PermissionBrokerRequest): PermissionDecision {
    const mergedReq = this.mergeRequest(request);
    const { asyncEvaluator: _ae, evaluator: _ev, ...cleanMergedReq } = mergedReq as any;
    return decide(cleanMergedReq);
  }

  public async waitForDecision(
    request: PermissionBrokerRequest,
    limitMs?: number
  ): Promise<RequestPermissionResponse> {
    const configuredLimit = this.resolveWatchdogLimit(request);
    const effectiveLimit =
      typeof limitMs === "number" && Number.isFinite(limitMs) && limitMs > 0
        ? limitMs
        : configuredLimit;

    const reqId =
      request.requestId ??
      extractToolCallId(request) ??
      `req-${++this.requestCounter}`;

    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.pendingRequests.delete(reqId);
      };

      if (effectiveLimit > 0 && Number.isFinite(effectiveLimit)) {
        timer = setTimeout(async () => {
          cleanup();
          try {
            const res = await this.handleWatchdogTimeout(request, effectiveLimit);
            resolve(res);
          } catch (err) {
            reject(err);
          }
        }, effectiveLimit);
      }

      this.pendingRequests.set(reqId, {
        requestId: reqId,
        sessionId: request.sessionId,
        request,
        timer,
        limitMs: effectiveLimit,
        resolve: (res) => {
          cleanup();
          resolve(res);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        startTime: Date.now(),
      });

      if (typeof request.asyncEvaluator === "function") {
        (
          request.asyncEvaluator as (
            r: PermissionBrokerRequest
          ) => Promise<{ allowed: boolean; rule?: string } | null>
        )(request).then(
          (evalRes) => {
            const { asyncEvaluator: _ae, evaluator: _ev, ...cleanReq } = request as any;
            const decision = decide({
              ...cleanReq,
              evaluator: () => ({
                allowed: Boolean(evalRes?.allowed),
                rule: evalRes?.rule ?? "async_evaluator",
              }),
            });
            this.applyDecision(decision, request).then(
              (res) => {
                const entry = this.pendingRequests.get(reqId);
                if (entry) entry.resolve(res);
              },
              (err) => {
                const entry = this.pendingRequests.get(reqId);
                if (entry) entry.reject(err);
              }
            );
          },
          () => {
            const { asyncEvaluator: _ae, evaluator: _ev, ...cleanReq } = request as any;
            const decision = decide({
              ...cleanReq,
              evaluator: () => ({
                allowed: false,
                rule: "async_evaluator_error",
              }),
            });
            this.applyDecision(decision, request).then(
              (res) => {
                const entry = this.pendingRequests.get(reqId);
                if (entry) entry.resolve(res);
              },
              (err) => {
                const entry = this.pendingRequests.get(reqId);
                if (entry) entry.reject(err);
              }
            );
          }
        );
      }
    });
  }

  public async answerPendingRequest(
    requestId: string,
    decisionInput?: PermissionBrokerRequest | PermissionDecision
  ): Promise<RequestPermissionResponse | null> {
    const entry = this.pendingRequests.get(requestId);
    if (!entry) return null;

    let decision: PermissionDecision;
    if (
      decisionInput &&
      typeof decisionInput === "object" &&
      "outcome" in decisionInput &&
      "decision" in decisionInput
    ) {
      decision = decisionInput as PermissionDecision;
    } else {
      decision = decide({
        ...entry.request,
        ...(decisionInput ?? {}),
      });
    }

    const res = await this.applyDecision(decision, entry.request);
    entry.resolve(res);
    return res;
  }

  public async cancelRequest(
    requestId: string,
    reason: string = "request_cancelled"
  ): Promise<RequestPermissionResponse | null> {
    const entry = this.pendingRequests.get(requestId);
    if (!entry) return null;

    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.pendingRequests.delete(requestId);

    if (this.options.onCancelTurn) {
      await this.options.onCancelTurn(entry.sessionId, reason);
    }

    const res: RequestPermissionResponse = {
      outcome: { outcome: "cancelled" },
    };
    entry.resolve(res);
    return res;
  }

  public async cancelTurn(sessionId?: string, reason?: string): Promise<void> {
    const actualReason = reason ?? "turn_cancelled";

    for (const [reqId, entry] of Array.from(this.pendingRequests.entries())) {
      if (!sessionId || entry.sessionId === sessionId) {
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        this.pendingRequests.delete(reqId);
        entry.resolve({
          outcome: { outcome: "cancelled" },
        });
      }
    }

    if (this.options.onCancelTurn) {
      await this.options.onCancelTurn(sessionId, actualReason);
    }
  }

  public async triggerWatchdog(
    requestIdOrRequest?: string | PermissionBrokerRequest
  ): Promise<RequestPermissionResponse> {
    if (typeof requestIdOrRequest === "string") {
      const entry = this.pendingRequests.get(requestIdOrRequest);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingRequests.delete(requestIdOrRequest);
        const limit = this.resolveWatchdogLimit(entry.request);
        const res = await this.handleWatchdogTimeout(entry.request, limit);
        entry.resolve(res);
        return res;
      }
      return { outcome: { outcome: "cancelled" } };
    }

    const req = requestIdOrRequest ?? {};
    const limit = this.resolveWatchdogLimit(req);
    return this.handleWatchdogTimeout(req, limit);
  }

  public async checkWatchdogs(
    now: number = Date.now()
  ): Promise<RequestPermissionResponse[]> {
    const results: RequestPermissionResponse[] = [];
    for (const [reqId, entry] of Array.from(this.pendingRequests.entries())) {
      const limit = entry.limitMs ?? this.resolveWatchdogLimit(entry.request);
      if (now - entry.startTime >= limit) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingRequests.delete(reqId);
        const res = await this.handleWatchdogTimeout(entry.request, limit);
        entry.resolve(res);
        results.push(res);
      }
    }
    return results;
  }

  public getPendingRequests(): PermissionBrokerRequest[] {
    return Array.from(this.pendingRequests.values()).map((e) => e.request);
  }

  public hasPendingRequest(requestId: string): boolean {
    return this.pendingRequests.has(requestId);
  }

  public dispose(): void {
    for (const entry of this.pendingRequests.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.pendingRequests.clear();
  }
}

export type PermissionBrokerOptions = PermissionBrokerAdapterOptions;

export class PermissionBroker extends PermissionBrokerAdapter {
  constructor(options: PermissionBrokerOptions = {}) {
    super(options);
  }
}

export function createPermissionBroker(
  options?: PermissionBrokerOptions
): PermissionBroker {
  return new PermissionBroker(options);
}

export function createAcpAdapter(
  options?: PermissionBrokerAdapterOptions
): PermissionBrokerAdapter {
  return new PermissionBrokerAdapter(options);
}
