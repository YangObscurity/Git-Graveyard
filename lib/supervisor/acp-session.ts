// Task 9.5: ACP session negotiation and verification
// Requirements: 14.18, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 16.7, 16.8, 16.9, 16.10, 16.12, 16.13, 16.14, 16.15, 16.16, 16.17, 16.21, 41.20, 41.21, 45.12

import * as fs from "node:fs";
import * as path from "node:path";
import {
  AllowedModelId,
  getAssignedModelForRole,
  normalizeRole,
  SkeletonRole,
  verifySessionMode,
  verifySessionModel,
} from "./model-allowlist";
import { getDefaultRunsBaseDir } from "./skeleton-env";
import type {
  ArchiveSessionsOptions,
  McpServerConfig,
  PolicyPreset,
  SessionNewParams,
  SkeletonRaisedEvent,
  SupervisorFailureReason,
  TaskPromptOptions,
} from "./types";

/**
 * Standard glob patterns for manifest and lock files allowed for Bonesetter.
 * Requirements: 14.6, 16.8.
 */
export const BONESETTER_MANIFEST_ALLOW_PATTERNS = [
  "**/package.json",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/poetry.lock",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/setup.py",
  "**/pyproject.toml",
  "**/requirements*.txt",
] as const;

/**
 * Agent allow rule granting fs_write on manifest and lock file names for Bonesetter.
 * Requirement 16.8.
 */
export const BONESETTER_MANIFEST_ALLOW_RULE = {
  capability: "fs_write",
  match: [...BONESETTER_MANIFEST_ALLOW_PATTERNS],
  effect: "allow",
} as const;

/**
 * Determines the policy preset for a given Skeleton role.
 * Requirements 14.18, 16.8:
 * - edit-workspace for Planner, Soul-stitcher, and Scribe
 * - read-workspace for Exhumer, Bonesetter, and Warden
 */
export function getPolicyPresetForRole(role: SkeletonRole | string): PolicyPreset {
  const norm = normalizeRole(role);
  if (norm === "planner" || norm === "soul-stitcher" || norm === "scribe") {
    return "edit-workspace";
  }
  return "read-workspace";
}

export interface BuildSessionNewOptions {
  cwd: string;
  role: SkeletonRole | string;
  runId: string;
  skeletonId: string;
  gatewayUrl?: string;
  bearerToken?: string;
  mcpServers?: McpServerConfig[];
  additionalDirectories?: string[];
  snapshotDir?: string;
  readOnlySnapshotDir?: string;
  hard?: boolean | string | null;
  effortLevel?: string;
}

/**
 * Builds the parameters for the session/new ACP request.
 * Requirements: 15.3, 15.4, 16.7, 16.8.
 */
export function buildSessionNewParams(
  options: BuildSessionNewOptions
): SessionNewParams {
  const normRole = normalizeRole(options.role) ?? options.role;
  const modelId = getAssignedModelForRole(options.role, { hard: options.hard });
  const policyPreset = getPolicyPresetForRole(options.role);

  // Construct MCP gateway server definition with per-Skeleton bearer token
  const mcpServers: McpServerConfig[] = options.mcpServers ? [...options.mcpServers] : [];
  if (mcpServers.length === 0 && options.gatewayUrl) {
    const headers: Record<string, string> = {};
    if (options.bearerToken) {
      headers.Authorization = `Bearer ${options.bearerToken}`;
    }
    mcpServers.push({
      id: "necromancer-gateway",
      name: "Necromancer Gateway",
      transport: "http",
      url: options.gatewayUrl,
      headers,
    });
  }

  // Planner additionalDirectories contains the read-only repo snapshot (Requirement 16.7)
  const additionalDirs = options.additionalDirectories ? [...options.additionalDirectories] : [];
  const snapshotPath = options.snapshotDir ?? options.readOnlySnapshotDir;
  if (normRole === "planner" && snapshotPath && !additionalDirs.includes(snapshotPath)) {
    additionalDirs.push(snapshotPath);
  }

  const kiroMeta: Record<string, unknown> = {
    modeId: normRole,
    modelId,
    policyPreset,
    ...(options.effortLevel ? { effortLevel: options.effortLevel } : {}),
  };

  // Requirement 16.8: Configuring Bonesetter with an agent allow rule for manifest and lock file names
  if (normRole === "bonesetter") {
    kiroMeta.rules = [BONESETTER_MANIFEST_ALLOW_RULE];
    kiroMeta.allowRules = [BONESETTER_MANIFEST_ALLOW_RULE];
    kiroMeta.manifestAllowRule = BONESETTER_MANIFEST_ALLOW_RULE;
  }

  return {
    cwd: options.cwd,
    mcpServers,
    _meta: {
      kiro: kiroMeta as any,
    },
    ...(additionalDirs.length > 0 ? { additionalDirectories: additionalDirs } : {}),
  };
}

export interface VerifySessionOptions {
  role: SkeletonRole | string;
  hard?: boolean | string | null;
  checkGateway?: boolean;
  isGatewayConnected?: () => Promise<boolean> | boolean;
}

export interface SessionVerificationSuccess {
  readonly ok: true;
  readonly sessionId: string;
  readonly modelId: AllowedModelId;
  readonly agent: string;
}

export interface SessionVerificationFailure {
  readonly ok: false;
  readonly reason: SupervisorFailureReason;
  readonly error: string;
  readonly sessionId?: string;
  readonly modelId?: string | null;
  readonly agent?: string | null;
}

export type SessionVerificationResult =
  | SessionVerificationSuccess
  | SessionVerificationFailure;

/**
 * Extracts session ID from session/new response.
 */
export function extractSessionId(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const r = response as Record<string, unknown>;
  if (typeof r.sessionId === "string" && r.sessionId.trim()) {
    return r.sessionId.trim();
  }
  if (typeof r.id === "string" && r.id.trim()) {
    return r.id.trim();
  }
  if (r.result && typeof r.result === "object") {
    return extractSessionId(r.result);
  }
  return null;
}

/**
 * Verifies active model, active mode, and MCP gateway connectivity on session/new response.
 * Requirements: 15.5, 15.6, 15.7, 16.9, 41.20, 41.21, 45.12.
 */
export async function verifySessionNegotiation(
  sessionResponse: unknown,
  options: VerifySessionOptions
): Promise<SessionVerificationResult> {
  const sessionId = extractSessionId(sessionResponse);
  if (!sessionId) {
    return {
      ok: false,
      reason: "spawn_failed",
      error: "session/new response did not contain a valid sessionId",
    };
  }

  // 1. Model verification (Requirements 15.5, 15.6, 41.20)
  const modelResult = verifySessionModel(sessionResponse, options.role, {
    hard: options.hard,
  });

  if (!modelResult.ok) {
    return {
      ok: false,
      reason: "model_mismatch",
      error: modelResult.error,
      sessionId,
      modelId: modelResult.modelId,
    };
  }

  // 2. Mode verification (Requirement 15.7)
  const modeResult = verifySessionMode(sessionResponse, options.role);
  if (!modeResult.ok) {
    return {
      ok: false,
      reason: "mode_mismatch",
      error: modeResult.error ?? "Active mode does not match role",
      sessionId,
      modelId: modelResult.modelId,
      agent: modeResult.modeId,
    };
  }

  // 3. MCP Gateway connectivity check (Requirements 16.9, 41.21, 45.12)
  if (options.checkGateway || options.isGatewayConnected) {
    let connected = false;
    if (options.isGatewayConnected) {
      try {
        connected = await options.isGatewayConnected();
      } catch {
        connected = false;
      }
    } else if (sessionResponse && typeof sessionResponse === "object") {
      const resp = sessionResponse as Record<string, unknown>;
      const kiroMeta = (resp._meta as Record<string, unknown> | undefined)?.kiro as
        | Record<string, unknown>
        | undefined;
      connected = Boolean(
        resp.gatewayConnected === true ||
        resp.mcpGatewayConnected === true ||
        resp.mcpStatus === "connected" ||
        kiroMeta?.gatewayConnected === true
      );
    }

    if (!connected) {
      return {
        ok: false,
        reason: "gateway_missing",
        error: "gateway_missing: MCP Gateway is not connected to Skeleton",
        sessionId,
        modelId: modelResult.modelId,
        agent: modeResult.modeId,
      };
    }
  }

  return {
    ok: true,
    sessionId,
    modelId: modelResult.modelId,
    agent: modeResult.modeId ?? options.role,
  };
}

/**
 * Creates the skeleton.raised event payload.
 * Requirement 15.8.
 */
export function createSkeletonRaisedEvent(params: {
  runId: string;
  skeletonId: string;
  role: string;
  sessionId: string;
  modelId: AllowedModelId | string;
  agent: string;
  refs?: string[];
}): SkeletonRaisedEvent {
  return {
    kind: "skeleton.raised",
    runId: params.runId,
    skeletonId: params.skeletonId,
    role: params.role,
    sessionId: params.sessionId,
    modelId: params.modelId,
    agent: params.agent,
    actor: "SkeletonSupervisor",
    refs: params.refs ?? [],
  };
}

/**
 * Formats task prompt containing tasks.md item text, death certificate rows, and Grimoire guidance.
 * Requirement 16.21.
 */
export function formatTaskPrompt(options: TaskPromptOptions): string {
  const sections: string[] = [];

  const taskText = (options.taskText ?? "").trim();
  if (taskText) {
    sections.push(`## Task Item (tasks.md)\n${taskText}`);
  }

  if (options.deathCertificateRows !== undefined && options.deathCertificateRows !== null) {
    let rowsFormatted = "";
    if (typeof options.deathCertificateRows === "string") {
      rowsFormatted = options.deathCertificateRows.trim();
    } else if (Array.isArray(options.deathCertificateRows)) {
      rowsFormatted = options.deathCertificateRows
        .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
        .join("\n");
    } else {
      rowsFormatted = JSON.stringify(options.deathCertificateRows, null, 2);
    }
    if (rowsFormatted) {
      sections.push(`## Death Certificate Rows\n${rowsFormatted}`);
    }
  }

  if (options.grimoireGuidance !== undefined && options.grimoireGuidance !== null) {
    let guidanceFormatted = "";
    if (typeof options.grimoireGuidance === "string") {
      guidanceFormatted = options.grimoireGuidance.trim();
    } else if (Array.isArray(options.grimoireGuidance)) {
      guidanceFormatted = options.grimoireGuidance.join("\n");
    } else {
      guidanceFormatted = JSON.stringify(options.grimoireGuidance, null, 2);
    }
    if (guidanceFormatted) {
      sections.push(`## Grimoire Guidance\n${guidanceFormatted}`);
    }
  }

  return sections.join("\n\n");
}

/**
 * Archives Skeleton sessions folder into run evidence.
 * Requirement 16.15.
 */
export function archiveSkeletonSessions(options: ArchiveSessionsOptions): string {
  const { sessionsDir, runId, skeletonId } = options;
  const baseDir = options.baseDir ?? getDefaultRunsBaseDir();
  const evidenceDir = options.evidenceDir ?? path.join(baseDir, runId, "evidence");
  const destDir = path.join(evidenceDir, "sessions", skeletonId);

  fs.mkdirSync(destDir, { recursive: true });

  if (fs.existsSync(sessionsDir)) {
    copyDirRecursive(sessionsDir, destDir);
  }

  return destDir;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
