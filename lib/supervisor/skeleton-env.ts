// Task 9.2: Skeleton environment, directory isolation and env builder
// Requirements: 14.1, 14.2, 14.13, 14.16, 16.1, 16.2

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
  normalizeRole,
} from "./model-allowlist";
import type { SkeletonRole } from "./model-allowlist";

/**
 * Resolved paths for an isolated Skeleton environment.
 */
export interface SkeletonPaths {
  readonly rootDir: string;
  readonly homeDir: string;
  readonly kiroHomeDir: string;
  readonly agentsDir: string;
  readonly sessionsDir: string;
  readonly settingsPath: string;
  /**
   * Probe P4 (2026-11-11): kiro-cli 3.1.0 ignores KIRO_HOME, so an agent written
   * under $KIRO_HOME/agents is never loaded. The same files are written under the
   * Skeleton's own HOME, which is where the loader actually looks.
   */
  readonly homeKiroDir: string;
  readonly homeAgentsDir: string;
  readonly homeSessionsDir: string;
  readonly homeSettingsPath: string;
}

/**
 * Resolves the default base directory for runs.
 * Uses RUNS_DIR environment variable if provided, or /data/runs if writable,
 * otherwise falls back to a writable temporary directory.
 */
export function getDefaultRunsBaseDir(): string {
  if (process.env.RUNS_DIR) {
    return process.env.RUNS_DIR;
  }
  try {
    if (fs.existsSync("/data/runs")) {
      fs.accessSync("/data/runs", fs.constants.W_OK);
      return "/data/runs";
    }
    if (fs.existsSync("/data")) {
      fs.accessSync("/data", fs.constants.W_OK);
      return "/data/runs";
    }
  } catch {
    // /data or /data/runs not writable
  }
  return path.join(os.tmpdir(), "git-graveyard-runs");
}

/**
 * Resolves directory paths for an isolated Skeleton.
 * Requirement 14.2, 14.16: each Skeleton receives its own isolated HOME.
 */
export function resolveSkeletonPaths(
  runId: string,
  skeletonId: string,
  baseDir?: string
): SkeletonPaths {
  const resolvedBaseDir = baseDir ?? getDefaultRunsBaseDir();
  const rootDir = path.join(resolvedBaseDir, runId, "homes", skeletonId);
  const homeDir = path.join(rootDir, "home");
  const kiroHomeDir = path.join(rootDir, "kiro-home");
  const agentsDir = path.join(kiroHomeDir, "agents");
  const sessionsDir = path.join(kiroHomeDir, "sessions");
  const settingsPath = path.join(kiroHomeDir, "settings.json");

  const homeKiroDir = path.join(homeDir, ".kiro");
  const homeAgentsDir = path.join(homeKiroDir, "agents");
  const homeSessionsDir = path.join(homeKiroDir, "sessions");
  const homeSettingsPath = path.join(homeKiroDir, "settings.json");

  return {
    rootDir,
    homeDir,
    kiroHomeDir,
    agentsDir,
    sessionsDir,
    settingsPath,
    homeKiroDir,
    homeAgentsDir,
    homeSessionsDir,
    homeSettingsPath,
  };
}

/**
 * Builds the exact execution environment for a Skeleton process.
 * Requirement 16.2:
 * Process environment MUST be set to exactly KIRO_API_KEY, KIRO_HOME, HOME, and PATH.
 * No other environment variables from process.env are inherited.
 */
export function buildSkeletonEnv(options: {
  kiroApiKey?: string;
  kiroHome: string;
  home: string;
  pathEnv?: string;
}): Record<string, string> {
  const apiKey =
    options.kiroApiKey ??
    (typeof process !== "undefined" && process.env?.KIRO_API_KEY
      ? process.env.KIRO_API_KEY
      : "");

  const resolvedPath =
    options.pathEnv ??
    (typeof process !== "undefined" && process.env?.PATH
      ? process.env.PATH
      : "/usr/local/bin:/usr/bin:/bin");

  // Strictly set to exactly these four environment variables
  return {
    KIRO_API_KEY: apiKey,
    KIRO_HOME: options.kiroHome,
    HOME: options.home,
    PATH: resolvedPath,
  };
}

/**
 * Options for provisioning isolated Skeleton environment on disk.
 */
export interface ProvisionSkeletonOptions {
  paths: SkeletonPaths;
  role: SkeletonRole | string;
  templatesDir?: string;
  model?: string;
}

const BUILTIN_KIRO_TOOLS = new Set(["read", "write", "code", "grep", "glob"]);

function synthesizeKiroAgentJsonFromMarkdown(
  markdownContent: string,
  normRole: string,
  overrideModel?: string
): string {
  const normalized = markdownContent.replace(/\r\n/g, "\n");
  let description = `Skeleton role: ${normRole}`;
  let model = overrideModel ?? CLAUDE_SONNET_5_5_MODEL_ID;
  const tools: string[] = [];
  let body = normalized;

  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (fmMatch) {
    const frontmatter = fmMatch[1];
    body = fmMatch[2].trim();
    const lines = frontmatter.split("\n");
    let inTools = false;
    for (const line of lines) {
      const descMatch = /^description:\s*(.+)$/.exec(line);
      if (descMatch) {
        description = descMatch[1].trim();
        inTools = false;
        continue;
      }
      const tierMatch = /^modelTier:\s*(.+)$/.exec(line);
      if (tierMatch && !overrideModel) {
        const tier = tierMatch[1].trim().toLowerCase();
        if (tier.includes("opus")) {
          model = CLAUDE_OPUS_5_5_MODEL_ID;
        } else if (tier.includes("haiku")) {
          model = CLAUDE_HAIKU_5_5_MODEL_ID;
        } else if (tier.includes("sonnet")) {
          model = CLAUDE_SONNET_5_5_MODEL_ID;
        }
        inTools = false;
        continue;
      }
      if (/^tools:\s*$/.test(line)) {
        inTools = true;
        continue;
      }
      if (inTools) {
        const itemMatch = /^\s*-\s+([a-zA-Z0-9_-]+)\s*$/.exec(line);
        if (itemMatch) {
          const toolName = itemMatch[1].trim();
          tools.push(
            BUILTIN_KIRO_TOOLS.has(toolName) ? toolName : `@necromancer/${toolName}`
          );
          continue;
        }
        if (/^[a-zA-Z0-9_-]+:/.test(line)) {
          inTools = false;
        }
      }
    }
  }

  return (
    JSON.stringify(
      {
        name: normRole,
        description,
        prompt: body || null,
        mcpServers: {},
        tools,
        toolAliases: {},
        allowedTools: [],
        resources: [],
        toolsSettings: {},
        includeMcpJson: false,
        model,
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Locations (relative to HOME) where kiro-cli keeps its login state.
 * Linux uses the XDG data dir; macOS uses Application Support.
 */
const KIRO_AUTH_STORE_RELATIVE_PATHS: ReadonlyArray<readonly string[]> = [
  [".local", "share", "kiro-cli"],
  ["Library", "Application Support", "kiro-cli"],
];

/**
 * Exposes the host's kiro-cli auth store inside an isolated HOME via symlinks
 * (credentials are never copied). Stores that do not exist on the host are
 * skipped, existing entries are kept, and failures are ignored because linking
 * is unsupported in some environments (for example Windows without symlink rights).
 */
export function linkHostKiroAuthStore(hostHome: string, isolatedHome: string): void {
  if (path.resolve(isolatedHome) === path.resolve(hostHome)) {
    return;
  }

  for (const segments of KIRO_AUTH_STORE_RELATIVE_PATHS) {
    try {
      const hostStore = path.join(hostHome, ...segments);
      if (!fs.existsSync(hostStore)) {
        continue;
      }
      const target = path.join(isolatedHome, ...segments);
      if (fs.existsSync(target)) {
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(hostStore, target, "dir");
    } catch {
      // Ignore: symlinks may be unsupported or unnecessary in this environment.
    }
  }
}

/**
 * Provisions the directory tree and settings for an isolated Skeleton.
 * Requirement 14.2: Copy role agent template into $KIRO_HOME/agents/.
 * Requirement 14.13: Set chat.disableInheritingDefaultResources to true in settings.
 */
export function provisionSkeletonEnvironment(
  options: ProvisionSkeletonOptions
): void {
  const { paths, role, templatesDir } = options;

  // Create isolated directories. The HOME copies matter because kiro-cli 3.1.0
  // ignores KIRO_HOME when it looks for agents and settings (probe P4).
  fs.mkdirSync(paths.homeDir, { recursive: true });
  fs.mkdirSync(paths.kiroHomeDir, { recursive: true });
  fs.mkdirSync(paths.agentsDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.mkdirSync(paths.homeKiroDir, { recursive: true });
  fs.mkdirSync(paths.homeAgentsDir, { recursive: true });
  fs.mkdirSync(paths.homeSessionsDir, { recursive: true });

  // Requirement 14.13: Configure chat.disableInheritingDefaultResources: true
  let currentSettings: Record<string, unknown> = {};
  if (fs.existsSync(paths.settingsPath)) {
    try {
      const raw = fs.readFileSync(paths.settingsPath, "utf-8");
      currentSettings = JSON.parse(raw);
    } catch {
      currentSettings = {};
    }
  }

  currentSettings["chat.disableInheritingDefaultResources"] = true;
  const serializedSettings = JSON.stringify(currentSettings, null, 2);
  fs.writeFileSync(paths.settingsPath, serializedSettings, "utf-8");
  fs.writeFileSync(paths.homeSettingsPath, serializedSettings, "utf-8");

  // When running with CLI login auth instead of KIRO_API_KEY, expose the host's
  // kiro-cli auth store inside the isolated HOME without copying credentials.
  if (!process.env.KIRO_API_KEY) {
    linkHostKiroAuthStore(os.homedir(), paths.homeDir);
  }

  // Requirement 14.2: Copy role agent template unchanged
  const normRole = normalizeRole(role) ?? (typeof role === "string" ? role.toLowerCase() : "");
  if (!normRole) {
    return;
  }

  const currentDir =
    typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));

  const candidateTemplatesDirs = [
    templatesDir,
    path.resolve(currentDir, "../agents/templates"),
    path.resolve(process.cwd(), "lib/agents/templates"),
  ].filter((d): d is string => typeof d === "string" && fs.existsSync(d));

  const defaultTemplatesDir =
    candidateTemplatesDirs[0] ?? path.resolve(currentDir, "../agents/templates");

  const candidateTemplateNames = [
    `${normRole}.json`,
    `${normRole}.md`,
    `${normRole.replace(/-/g, "_")}.json`,
    `${normRole.replace(/-/g, "_")}.md`,
  ];

  for (const name of candidateTemplateNames) {
    const srcPath = path.join(defaultTemplatesDir, name);
    if (fs.existsSync(srcPath)) {
      const content = fs.readFileSync(srcPath, "utf-8");
      const ext = path.extname(name);
      // kiro-cli 3.1.0 discovers <workspace>/.kiro/agents/*.json (probe P6) and
      // ignores KIRO_HOME; the same file is written under $KIRO_HOME for older
      // readers and under the Skeleton's HOME, which is the one that loads.
      const fileName = `${normRole}${ext}`;
      fs.writeFileSync(path.join(paths.agentsDir, fileName), content, "utf-8");
      fs.writeFileSync(path.join(paths.homeAgentsDir, fileName), content, "utf-8");

      if (ext === ".md") {
        const jsonName = `${normRole}.json`;
        const homeJsonPath = path.join(paths.homeAgentsDir, jsonName);
        const agentsJsonPath = path.join(paths.agentsDir, jsonName);
        if (!fs.existsSync(homeJsonPath) && !fs.existsSync(path.join(defaultTemplatesDir, jsonName))) {
          const synthesized = synthesizeKiroAgentJsonFromMarkdown(
            content,
            normRole,
            options.model
          );
          fs.writeFileSync(agentsJsonPath, synthesized, "utf-8");
          fs.writeFileSync(homeJsonPath, synthesized, "utf-8");
        }
      }
      break;
    }
  }
}
