// Task 10.3 / 10.5: Committed Command Policy engine and hard blocks
// Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.12, 20.13, 29.10, 29.11, 29.12

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdminPolicyView,
  CommandClassification,
  CommandClassificationResult,
  CommandPolicyData,
  CommandPolicyOptions,
} from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_EGRESS_ALLOWLIST = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
] as const;

export const CLOUD_METADATA_ADDRESS = "169.254.169.254";

/**
 * Recursively freezes an object and all nested object properties.
 */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function loadCommittedPolicy(): CommandPolicyData {
  try {
    const policyPath = path.resolve(__dirname, "command-policy.json");
    const raw = fs.readFileSync(policyPath, "utf8");
    return JSON.parse(raw) as CommandPolicyData;
  } catch {
    return {
      version: "1.0.0",
      name: "git-graveyard-command-policy",
      description: "Committed Command Policy for sandbox_exec execution classification",
      egressAllowlist: [...DEFAULT_EGRESS_ALLOWLIST],
      allowedCommands: [],
      hardBlockRules: [],
      defaultClassification: "needs_approval",
    };
  }
}

let cachedPolicy: CommandPolicyData | null = null;

/**
 * Loads the committed policy JSON file from lib/gateway/command-policy.json.
 * Requirement 20.1, 20.2.
 */
export function getCommittedPolicy(): CommandPolicyData {
  if (cachedPolicy) {
    return cachedPolicy;
  }
  cachedPolicy = deepFreeze(loadCommittedPolicy());
  return cachedPolicy;
}

/**
 * Formats the committed command policy for display on the Admin Page.
 * Requirement 20.2. Any cached policy object is deep-frozen before it is shown to Admin.
 */
export function formatPolicyForAdmin(): AdminPolicyView {
  const policy = getCommittedPolicy();
  deepFreeze(policy);
  const summary =
    `Command Policy v${policy.version}: ` +
    `${policy.allowedCommands.length} allowed command rules, ` +
    `${policy.hardBlockRules.length} hard block rules, ` +
    `${policy.egressAllowlist.length} egress allowlist domains. ` +
    `Default classification: ${policy.defaultClassification}.`;

  return deepFreeze({
    version: policy.version,
    name: policy.name,
    summary,
    egressAllowlist: policy.egressAllowlist,
    allowedCount: policy.allowedCommands.length,
    hardBlockCount: policy.hardBlockRules.length,
    policy,
  });
}

/**
 * Checks if a working directory lies strictly inside the caller worktree root.
 * Requirement 19.5, 20.3.
 */
export function isInsideWorktree(cwd?: string, worktreeRoot?: string): boolean {
  if (!worktreeRoot) {
    return false;
  }
  const resolvedRoot = path.resolve(worktreeRoot);
  const resolvedCwd = cwd ? path.resolve(resolvedRoot, cwd) : resolvedRoot;
  const rel = path.relative(resolvedRoot, resolvedCwd);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Extracts hostnames from URL strings found within an argument.
 */
export function extractHostnamesFromArg(arg: string): string[] {
  const hosts: string[] = [];
  const urlRegex = /(?:https?|ssh):\/\/([^/:\s]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(arg)) !== null) {
    if (match[1]) {
      hosts.push(match[1].toLowerCase());
    }
  }
  const gitRegex = /git@([^/:\s]+)/gi;
  while ((match = gitRegex.exec(arg)) !== null) {
    if (match[1]) {
      hosts.push(match[1].toLowerCase());
    }
  }
  return hosts;
}

/**
 * Removes matching quote pairs (single quotes '...', double quotes "...", and escaped characters)
 * from a shell word, matching POSIX shell quote removal.
 */
export function removeQuotes(word: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < word.length) {
    const ch = word[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        result += ch;
      }
      i++;
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < word.length) {
        const next = word[i + 1];
        if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
          result += next;
          i += 2;
        } else {
          result += ch;
          i++;
        }
      } else {
        result += ch;
        i++;
      }
    } else {
      if (ch === "'") {
        inSingle = true;
        i++;
      } else if (ch === '"') {
        inDouble = true;
        i++;
      } else if (ch === "\\" && i + 1 < word.length) {
        result += word[i + 1];
        i += 2;
      } else {
        result += ch;
        i++;
      }
    }
  }
  return result;
}

/**
 * Splits a shell code string by pipeline and list operators (; \n && || | |& &),
 * respecting single and double quotes so that operators inside quotes are not split.
 */
export function splitShellListAndPipelines(code: string): string[] {
  const commands: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < code.length) {
    const ch = code[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") {
        inSingle = false;
      }
      i++;
    } else if (inDouble) {
      current += ch;
      if (ch === "\\" && i + 1 < code.length) {
        current += code[i + 1];
        i += 2;
      } else {
        if (ch === '"') {
          inDouble = false;
        }
        i++;
      }
    } else {
      if (ch === "'") {
        inSingle = true;
        current += ch;
        i++;
      } else if (ch === '"') {
        inDouble = true;
        current += ch;
        i++;
      } else if (ch === "\\" && i + 1 < code.length) {
        current += ch + code[i + 1];
        i += 2;
      } else if (ch === "&" && code[i + 1] === "&") {
        if (current.trim()) commands.push(current.trim());
        current = "";
        i += 2;
      } else if (ch === "|" && code[i + 1] === "|") {
        if (current.trim()) commands.push(current.trim());
        current = "";
        i += 2;
      } else if (ch === "|" && code[i + 1] === "&") {
        if (current.trim()) commands.push(current.trim());
        current = "";
        i += 2;
      } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
        if (current.trim()) commands.push(current.trim());
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  if (current.trim()) {
    commands.push(current.trim());
  }
  return commands;
}

/**
 * Tokenizes a simple command string into words, respecting single and double quotes
 * and backslash escapes.
 */
export function tokenizeSimpleCommand(cmdStr: string): string[] {
  const words: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasChars = false;
  let i = 0;

  while (i < cmdStr.length) {
    const ch = cmdStr[i];

    if (inSingle) {
      current += ch;
      hasChars = true;
      if (ch === "'") {
        inSingle = false;
      }
      i++;
    } else if (inDouble) {
      current += ch;
      hasChars = true;
      if (ch === "\\" && i + 1 < cmdStr.length) {
        current += cmdStr[i + 1];
        i += 2;
      } else {
        if (ch === '"') {
          inDouble = false;
        }
        i++;
      }
    } else {
      if (ch === "'") {
        inSingle = true;
        current += ch;
        hasChars = true;
        i++;
      } else if (ch === '"') {
        inDouble = true;
        current += ch;
        hasChars = true;
        i++;
      } else if (ch === "\\" && i + 1 < cmdStr.length) {
        current += "\\" + cmdStr[i + 1];
        hasChars = true;
        i += 2;
      } else if (/\s/.test(ch)) {
        if (hasChars) {
          words.push(current);
          current = "";
          hasChars = false;
        }
        i++;
      } else {
        current += ch;
        hasChars = true;
        i++;
      }
    }
  }

  if (hasChars) {
    words.push(current);
  }

  return words;
}

/**
 * Unwraps command, exec, env, timeout, nice, nohup, and time wrappers iteratively.
 * If env is invoked without an inner command, it is an environment dump.
 */
export function unwrapWrappers(words: readonly string[]): {
  words: string[];
  isEnvDump: boolean;
} {
  let current = [...words];
  let depth = 0;

  while (current.length > 0 && depth < 20) {
    depth++;
    const first = removeQuotes(current[0] ?? "").toLowerCase();
    const baseCmd = path.basename(first);

    // 1. command [-p] [-v] [-V] cmd [args...]
    if (baseCmd === "command") {
      let idx = 1;
      let hasV = false;
      while (idx < current.length && removeQuotes(current[idx]).startsWith("-")) {
        const flag = removeQuotes(current[idx]);
        if (flag === "-v" || flag === "-V") {
          hasV = true;
        }
        idx++;
      }
      if (hasV) {
        return { words: current, isEnvDump: false };
      }
      if (idx < current.length) {
        current = current.slice(idx);
        continue;
      }
      return { words: current, isEnvDump: false };
    }

    // 2. exec [-c] [-l] [-a name] cmd [args...]
    if (baseCmd === "exec") {
      let idx = 1;
      while (idx < current.length) {
        const a = removeQuotes(current[idx]);
        if (a === "--") {
          idx++;
          break;
        }
        if (a === "-a" && idx + 1 < current.length) {
          idx += 2;
          continue;
        }
        if (a.startsWith("-")) {
          idx++;
          continue;
        }
        break;
      }
      if (idx < current.length) {
        current = current.slice(idx);
        continue;
      }
      return { words: current, isEnvDump: false };
    }

    // 3. env [options...] [NAME=VALUE...] [cmd [args...]]
    if (baseCmd === "env") {
      let idx = 1;
      while (idx < current.length) {
        const a = removeQuotes(current[idx]);
        if (a === "--") {
          idx++;
          break;
        }
        if (
          /^\d*[><]/.test(a) ||
          a === ">" ||
          a === ">>" ||
          a === "<" ||
          a === "2>&1"
        ) {
          if ((a === ">" || a === ">>" || a === "<") && idx + 1 < current.length) {
            idx += 2;
            continue;
          }
          idx++;
          continue;
        }
        if (a.startsWith("-")) {
          if (
            (a === "-u" || a === "-C" || a === "--unset" || a === "--chdir") &&
            idx + 1 < current.length
          ) {
            idx += 2;
            continue;
          }
          idx++;
          continue;
        }
        if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(a)) {
          idx++;
          continue;
        }
        break;
      }
      if (idx >= current.length) {
        // env without command dumps environment
        return { words: current, isEnvDump: true };
      }
      current = current.slice(idx);
      continue;
    }

    // 4. timeout [options...] duration cmd [args...]
    if (baseCmd === "timeout") {
      let idx = 1;
      while (idx < current.length) {
        const a = removeQuotes(current[idx]);
        if (a === "--") {
          idx++;
          break;
        }
        if (a.startsWith("-")) {
          if (
            (a === "-s" || a === "-k" || a === "--signal" || a === "--kill-after") &&
            idx + 1 < current.length
          ) {
            idx += 2;
            continue;
          }
          idx++;
          continue;
        }
        // First non-flag is duration
        idx++;
        break;
      }
      if (idx < current.length) {
        current = current.slice(idx);
        continue;
      }
      return { words: current, isEnvDump: false };
    }

    // 5. nice [options...] cmd [args...]
    if (baseCmd === "nice") {
      let idx = 1;
      while (idx < current.length) {
        const a = removeQuotes(current[idx]);
        if (a === "--") {
          idx++;
          break;
        }
        if (a.startsWith("-")) {
          if ((a === "-n" || a === "--adjustment") && idx + 1 < current.length) {
            idx += 2;
            continue;
          }
          idx++;
          continue;
        }
        break;
      }
      if (idx < current.length) {
        current = current.slice(idx);
        continue;
      }
      return { words: current, isEnvDump: false };
    }

    // 6. nohup, time
    if (baseCmd === "nohup" || baseCmd === "time") {
      let idx = 1;
      while (idx < current.length) {
        const a = removeQuotes(current[idx]);
        if (a === "--") {
          idx++;
          break;
        }
        if (a.startsWith("-")) {
          idx++;
          continue;
        }
        break;
      }
      if (idx < current.length) {
        current = current.slice(idx);
        continue;
      }
      return { words: current, isEnvDump: false };
    }

    break;
  }

  return { words: current, isEnvDump: false };
}

function isNodeCodeEnvDump(code: string): boolean {
  if (/\/proc\/(?:self|\d+)\/environ/i.test(code)) return true;
  if (/\bprintenv\b/i.test(code)) return true;
  if (
    /\bprocess\s*(?:\?\s*)?\.\s*env\b/i.test(code) ||
    /\bprocess\s*\[\s*['"]?env['"]?\s*\]/i.test(code) ||
    /require\s*\(\s*['"]?(?:node:)?process['"]?\s*\)\s*(?:\?\s*)?(?:\.\s*env\b|\[\s*['"]?env['"]?\s*\])/i.test(code) ||
    /import\s*\(\s*['"]?(?:node:)?process['"]?\s*\)/i.test(code)
  ) {
    return true;
  }
  return false;
}

function isRubyCodeEnvDump(code: string): boolean {
  if (/\/proc\/(?:self|\d+)\/environ/i.test(code)) return true;
  if (/\bprintenv\b/i.test(code)) return true;
  if (/\bENV\b/.test(code)) return true;
  return false;
}

function isPythonCodeEnvDump(code: string): boolean {
  if (/\/proc\/(?:self|\d+)\/environ/i.test(code)) return true;
  if (/\bprintenv\b/i.test(code)) return true;
  if (
    /\bos\s*(?:\?\s*)?\.\s*(?:environ|environb|getenv)\b/i.test(code) ||
    /\bposix\s*(?:\?\s*)?\.\s*environ\b/i.test(code) ||
    /\bfrom\s+os\s+import\s+.*?\b(?:environ|environb|getenv)\b/i.test(code) ||
    /\benviron\b/i.test(code)
  ) {
    return true;
  }
  return false;
}

function isPerlCodeEnvDump(code: string): boolean {
  if (/\/proc\/(?:self|\d+)\/environ/i.test(code)) return true;
  if (/\bprintenv\b/i.test(code)) return true;
  if (
    /%ENV\b/.test(code) ||
    /\$ENV\b/.test(code) ||
    /\bENV\b/.test(code)
  ) {
    return true;
  }
  return false;
}

/**
 * Checks if a shell command string contains an environment dump by splitting
 * pipelines and lists into simple commands and evaluating each.
 */
export function isShellCodeEnvDump(code: string, depth = 0): boolean {
  if (depth > 20) {
    return false;
  }
  if (/\/proc\/(?:self|\d+)\/environ/i.test(code)) {
    return true;
  }

  // Check subshells $(...) or `...`
  const subshellMatch = /\$\(([^)]+)\)|`([^`]+)`/g;
  let sm: RegExpExecArray | null;
  while ((sm = subshellMatch.exec(code)) !== null) {
    const inner = sm[1] ?? sm[2];
    if (inner && isShellCodeEnvDump(inner, depth + 1)) {
      return true;
    }
  }

  // Split by shell pipelines and lists: ; | || && \n &
  const subCommands = splitShellListAndPipelines(code);
  for (const sub of subCommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;
    const tokens = tokenizeSimpleCommand(trimmed);
    if (tokens.length > 0 && isEnvironmentDump(tokens, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects whether an argv array attempts an environment dump, including unwrapping
 * wrappers such as command, exec, env, timeout, nice, sh -c, bash -c, and code-running interpreters like
 * node -e/-p, ruby -e, python -c, perl -e, declare -x, and printenv.
 * Normalises quote pairs and splits pipelines/lists into simple commands.
 * Requirements: 20.4, 29.11.
 */
export function isEnvironmentDump(
  argv: readonly string[] | string[],
  depth = 0
): boolean {
  if (!argv || argv.length === 0 || depth > 20) {
    return false;
  }

  // Check /proc/.../environ anywhere in raw arguments
  if (argv.some((arg) => /\/proc\/(?:self|\d+)\/environ/i.test(arg))) {
    return true;
  }

  // 1. Unwrap command, exec, env, timeout, nice, nohup, time wrappers
  // and remove quote pairs from words
  const unwrapResult = unwrapWrappers(argv);
  if (unwrapResult.isEnvDump) {
    return true;
  }
  const words = unwrapResult.words;
  if (words.length === 0) {
    return false;
  }

  if (words.some((arg) => /\/proc\/(?:self|\d+)\/environ/i.test(arg))) {
    return true;
  }

  const firstArg = removeQuotes(words[0] ?? "").toLowerCase();
  const baseCmd = path.basename(firstArg);

  // 1. Direct standalone printenv
  if (baseCmd === "printenv") {
    return true;
  }

  // 2. Direct export or set without assignments (dumping env)
  if (
    (baseCmd === "export" && (words.length === 1 || (words.length === 2 && words[1].startsWith("-")))) ||
    (baseCmd === "set" && words.length === 1)
  ) {
    return true;
  }

  // 2b. declare -x or declare without assignments
  if (baseCmd === "declare" || baseCmd === "typeset") {
    if (
      words.some((a) => a === "-x" || /^-[a-zA-Z]*x/.test(a)) ||
      words.length === 1 ||
      (words.length === 2 && words[1].startsWith("-"))
    ) {
      return true;
    }
  }

  // 2c. env with no command (if reached here)
  if (baseCmd === "env") {
    return true;
  }

  // 3. Shell wrapper: sh, bash, zsh, dash, ksh
  const isShell = /^(?:sh|bash|zsh|dash|ksh)$/i.test(baseCmd);
  if (isShell) {
    const isBash = baseCmd === "bash";
    const hasLoginFlag = words.some((a) => a === "-l" || a === "--login" || /^-[a-zA-Z]*l/.test(a));
    const hasCommandFlag = words.some((a) => a === "-c" || /^-[a-zA-Z]*c/.test(a));
    const hasCombinedLc = words.some((a) => /^-[a-zA-Z]*l[a-zA-Z]*c/.test(a) || /^-[a-zA-Z]*c[a-zA-Z]*l/.test(a));

    if (isBash && (hasCombinedLc || (hasLoginFlag && hasCommandFlag))) {
      return true;
    }

    const cIdx = words.findIndex((a) => a === "-c" || /^-[a-zA-Z]*c/.test(a));
    if (cIdx !== -1) {
      let code = "";
      if (words[cIdx] === "-c" && cIdx + 1 < words.length) {
        code = words[cIdx + 1];
      } else if (words[cIdx].startsWith("-c")) {
        code = words[cIdx].slice(2);
      } else if (cIdx + 1 < words.length) {
        code = words[cIdx + 1];
      }
      if (code) {
        return isShellCodeEnvDump(code, depth + 1);
      }
    }
  }

  // 4. Interpreter wrapper: node / nodejs (-e, -p, --eval, --print)
  const isNode = /^(?:node|nodejs)$/i.test(baseCmd);
  if (isNode) {
    const hasEvalOrPrint = words.some(
      (a) =>
        a === "-e" ||
        a === "--eval" ||
        a === "-p" ||
        a === "--print" ||
        a === "-pe" ||
        a === "-ep" ||
        /^-[a-zA-Z]*(?:e|p)/.test(a)
    );
    if (hasEvalOrPrint) {
      const codeArgs = words.slice(1).join(" ");
      if (isNodeCodeEnvDump(codeArgs)) {
        return true;
      }
    }
  }

  // 5. Interpreter wrapper: ruby (-e, --eval)
  const isRuby = /^ruby\d*(?:\.\d+)?$/i.test(baseCmd);
  if (isRuby) {
    const hasEval = words.some(
      (a) => a === "-e" || a === "--eval" || /^-[a-zA-Z]*e/.test(a)
    );
    if (hasEval) {
      const codeArgs = words.slice(1).join(" ");
      if (isRubyCodeEnvDump(codeArgs)) {
        return true;
      }
    }
  }

  // 6. Interpreter wrapper: python / python3 (-c)
  const isPython = /^(?:python|python3|python\d+(?:\.\d+)?)$/i.test(baseCmd);
  if (isPython) {
    const hasCommand = words.some((a) => a === "-c" || /^-[a-zA-Z]*c/.test(a));
    if (hasCommand) {
      const codeArgs = words.slice(1).join(" ");
      if (isPythonCodeEnvDump(codeArgs)) {
        return true;
      }
    }
    const mIdx = words.findIndex((a) => a === "-m");
    if (mIdx !== -1 && mIdx + 1 < words.length && words[mIdx + 1] === "printenv") {
      return true;
    }
  }

  // 7. Interpreter wrapper: perl (-e, -E)
  const isPerl = /^(?:perl|perl\d+(?:\.\d+)?)$/i.test(baseCmd);
  if (isPerl) {
    const hasEval = words.some((a) => a === "-e" || a === "-E" || /^-[a-zA-Z]*[eE]/.test(a));
    if (hasEval) {
      const codeArgs = words.slice(1).join(" ");
      if (isPerlCodeEnvDump(codeArgs)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates whether an argv matches any Hard_Block rule.
 * Requirements: 20.4, 29.10, 29.11, 29.12.
 * Hard blocks cannot be overridden by any input.
 */
export function checkHardBlocks(argv: readonly string[] | string[]): {
  blocked: boolean;
  reason?: string;
  ruleId?: string;
} {
  const joined = argv.join(" ");

  // 1. Sudo privilege escalation (Requirement 29.12)
  const sudoRegex = /\b(sudo|doas|su)\b/i;
  if (
    argv.some((arg) => sudoRegex.test(arg)) ||
    sudoRegex.test(joined)
  ) {
    return {
      blocked: true,
      reason: "Blocked: command attempts sudo or privilege escalation (Requirement 29.12)",
      ruleId: "hard-block-sudo",
    };
  }

  // 2. Kiro API key (Requirement 29.11)
  const kiroPatterns = [
    /kiro[-_]?(?:api[-_]?)?key/i,
    /kiro[-_]?key/i,
    /\bksk_[a-zA-Z0-9_-]+/i,
    /\bkiro[-_]?(?:api[-_]?)?(?:token|secret)\b/i,
  ];
  for (const pat of kiroPatterns) {
    if (pat.test(joined)) {
      return {
        blocked: true,
        reason: "Blocked: argv references Kiro API key or key identifier (Requirement 29.11)",
        ruleId: "hard-block-kiro-key",
      };
    }
  }

  // 3. GitHub token (Requirement 29.11)
  const githubPatterns = [
    /\bgithub[-_]?token\b/i,
    /\bgh[-_]?token\b/i,
    /\bgh[pousr]_[a-zA-Z0-9_-]+/i,
    /\bgithub_pat_[a-zA-Z0-9_-]+/i,
  ];
  for (const pat of githubPatterns) {
    if (pat.test(joined)) {
      return {
        blocked: true,
        reason: "Blocked: argv references GitHub credential or token (Requirement 29.11)",
        ruleId: "hard-block-github-token",
      };
    }
  }

  // 4. Environment dump (Requirement 29.11)
  // Treat env, sh -c, bash -c, and interpreter forms (node -e, python -c) as wrappers
  if (isEnvironmentDump(argv)) {
    return {
      blocked: true,
      reason: "Blocked: command attempts environment dump (Requirement 29.11)",
      ruleId: "hard-block-env-dump",
    };
  }

  // 5. ~/.ssh credentials (Requirement 29.11)
  const sshPatterns = [
    /~[/\\]\.ssh/i,
    /(?:^|[/\\]|\s)\.ssh(?:[/\\]|\s|$)/i,
    /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i,
    /\bauthorized_keys\b/i,
    /\bknown_hosts\b/i,
  ];
  for (const pat of sshPatterns) {
    if (pat.test(joined)) {
      return {
        blocked: true,
        reason: "Blocked: argv targets ~/.ssh or host SSH credentials (Requirement 29.11)",
        ruleId: "hard-block-ssh",
      };
    }
  }

  // 6. Cloud metadata IP address 169.254.169.254 (Requirement 29.11)
  if (
    joined.includes(CLOUD_METADATA_ADDRESS) ||
    joined.includes("metadata.google.internal") ||
    joined.includes("metadata.google") ||
    joined.includes("fd00:ec2::254")
  ) {
    return {
      blocked: true,
      reason: "Blocked: argv targets cloud metadata address (Requirement 29.11)",
      ruleId: "hard-block-cloud-metadata",
    };
  }

  // 7. Container sockets (Requirement 29.12)
  if (
    joined.includes("docker.sock") ||
    joined.includes("containerd.sock") ||
    joined.includes("podman.sock")
  ) {
    return {
      blocked: true,
      reason: "Blocked: argv references container socket (Requirement 29.12)",
      ruleId: "hard-block-container-socket",
    };
  }

  // 8. Host mounts and escape directories (Requirement 29.12)
  const hostMountEscapeRegex = /(?:^|[=\s"'])\/(?:host|proc|sys|dev)(?:[\s/="'\\]|$)/i;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      arg === "/host" ||
      arg.startsWith("/host/") ||
      arg === "/proc" ||
      arg.startsWith("/proc/") ||
      arg === "/sys" ||
      arg.startsWith("/sys/") ||
      arg === "/dev" ||
      arg.startsWith("/dev/") ||
      arg.startsWith("-v/") ||
      arg.startsWith("-v /") ||
      arg.startsWith("-v /:") ||
      arg.startsWith("--mount") ||
      arg.startsWith("--volume") ||
      hostMountEscapeRegex.test(arg) ||
      (arg === "-v" && argv[i + 1]?.startsWith("/"))
    ) {
      return {
        blocked: true,
        reason: "Blocked: argv references host mount or container escape path (Requirement 29.12)",
        ruleId: "hard-block-host-mount",
      };
    }
  }

  return { blocked: false };
}

/**
 * Classifies an argv array inside the caller worktree against allowed rules.
 * Requirement 20.3.
 */
export function checkAllowedRules(
  argv: readonly string[] | string[],
  policy?: CommandPolicyData
): { allowed: boolean; ruleId?: string } {
  if (argv.length === 0) {
    return { allowed: false };
  }

  const p = policy ?? getCommittedPolicy();
  const cmd = argv[0];
  const sub1 = argv[1];
  const sub2 = argv[2];

  // Git inside-worktree commands: status, diff, log, add, commit, checkout -b
  if (cmd === "git") {
    if (sub1 === "status") {
      return { allowed: true, ruleId: "git-status" };
    }
    if (sub1 === "diff") {
      return { allowed: true, ruleId: "git-diff" };
    }
    if (sub1 === "log") {
      return { allowed: true, ruleId: "git-log" };
    }
    if (sub1 === "add") {
      return { allowed: true, ruleId: "git-add" };
    }
    if (sub1 === "commit") {
      return { allowed: true, ruleId: "git-commit" };
    }
    if (sub1 === "checkout" && sub2 === "-b") {
      return { allowed: true, ruleId: "git-checkout-b" };
    }
  }

  // Package installs against declared managers: npm ci, npm install, pip install -r, poetry install
  if (cmd === "npm") {
    if (sub1 === "ci") {
      return { allowed: true, ruleId: "npm-ci" };
    }
    if (sub1 === "install" || sub1 === "i") {
      return { allowed: true, ruleId: "npm-install" };
    }
  }

  if ((cmd === "pip" || cmd === "pip3") && sub1 === "install" && sub2 === "-r") {
    return { allowed: true, ruleId: "pip-install-r" };
  }

  if (cmd === "poetry" && sub1 === "install") {
    return { allowed: true, ruleId: "poetry-install" };
  }

  // npm run build, test, lint, typecheck (and npm test, npm t)
  if (cmd === "npm") {
    if (sub1 === "run") {
      if (sub2 === "build") {
        return { allowed: true, ruleId: "npm-run-build" };
      }
      if (sub2 === "test") {
        return { allowed: true, ruleId: "npm-run-test" };
      }
      if (sub2 === "lint") {
        return { allowed: true, ruleId: "npm-run-lint" };
      }
      if (sub2 === "typecheck") {
        return { allowed: true, ruleId: "npm-run-typecheck" };
      }
    }
    if (sub1 === "test") {
      return { allowed: true, ruleId: "npm-test" };
    }
    if (sub1 === "t") {
      return { allowed: true, ruleId: "npm-t" };
    }
  }

  // Allowed harmless commands
  if (cmd === "ls") {
    return { allowed: true, ruleId: "ls" };
  }

  // pytest and python -m pytest
  if (cmd === "pytest") {
    return { allowed: true, ruleId: "pytest" };
  }
  if ((cmd === "python" || cmd === "python3") && sub1 === "-m" && sub2 === "pytest") {
    return { allowed: true, ruleId: "python-pytest" };
  }

  // python -m unittest
  if ((cmd === "python" || cmd === "python3") && sub1 === "-m" && sub2 === "unittest") {
    return { allowed: true, ruleId: "python-unittest" };
  }

  // Version commands for toolchain binaries
  const versionRule = p.allowedCommands.find((c) => c.id === "version-commands");
  const versionBinaries = versionRule?.binaries ?? [
    "node",
    "npm",
    "python",
    "python3",
    "pip",
    "pip3",
    "poetry",
    "git",
    "npx",
    "tsc",
  ];
  const versionFlags = versionRule?.flags ?? ["-v", "--version", "-V"];

  if (
    argv.length >= 2 &&
    versionBinaries.includes(cmd) &&
    argv.slice(1).every((arg) => versionFlags.includes(arg))
  ) {
    return { allowed: true, ruleId: "version-commands" };
  }

  return { allowed: false };
}

/**
 * Checks whether an argv array references network hostnames outside the egress allowlist.
 * Requirement 20.5.
 */
export function checkDisallowedHosts(
  argv: readonly string[] | string[],
  egressAllowlist: readonly string[] = DEFAULT_EGRESS_ALLOWLIST
): { hasDisallowedHost: boolean; host?: string } {
  const allowSet = new Set(egressAllowlist.map((h) => h.toLowerCase()));

  for (const arg of argv) {
    const hosts = extractHostnamesFromArg(arg);
    for (const h of hosts) {
      if (!allowSet.has(h)) {
        return { hasDisallowedHost: true, host: h };
      }
    }
  }

  return { hasDisallowedHost: false };
}

/**
 * Classifies command argv arrays strictly as allowed, needs_approval, or blocked.
 * Pure function over argv arrays.
 * Hard blocks cannot be overridden by any input.
 * Requirements: 20.1, 20.3, 20.4, 20.5, 29.10, 29.11, 29.12.
 */
export function classifyCommand(
  argv: readonly string[] | string[],
  options?: CommandPolicyOptions
): CommandClassificationResult {
  // 1. Validate argv
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      classification: "blocked",
      reason: "Blocked: argv must be a non-empty array of strings (Requirement 20.12)",
      matchedRule: "invalid-argv",
      argv: Array.isArray(argv) ? [...argv] : [],
    };
  }

  if (argv.some((arg) => typeof arg !== "string")) {
    return {
      classification: "blocked",
      reason: "Blocked: all argv elements must be strings (Requirement 20.12)",
      matchedRule: "invalid-argv-elements",
      argv: [...argv],
    };
  }

  const argvCopy = [...argv];

  // 2. Check Hard Blocks first (Requirements 20.4, 29.10, 29.11, 29.12)
  // Hard blocks cannot be overridden by any input.
  const hardBlock = checkHardBlocks(argvCopy);
  if (hardBlock.blocked) {
    return {
      classification: "blocked",
      reason: hardBlock.reason,
      matchedRule: hardBlock.ruleId,
      argv: argvCopy,
    };
  }

  // 3. Check egress allowlist (Requirement 20.5)
  // Allowed command rules and egress allowlist come strictly from committed command-policy.json
  const policy = getCommittedPolicy();
  const allowlist = policy.egressAllowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const hostCheck = checkDisallowedHosts(argvCopy, allowlist);
  if (hostCheck.hasDisallowedHost) {
    return {
      classification: "needs_approval",
      reason: `Command names network host outside egress allowlist: ${hostCheck.host}`,
      matchedRule: "external-host",
      argv: argvCopy,
    };
  }

  // 4. Check cwd inside worktree (Requirement 20.3, 19.5)
  if (options?.worktreeRoot || options?.cwd) {
    const insideWorktree = isInsideWorktree(options?.cwd, options?.worktreeRoot);
    if (!insideWorktree) {
      return {
        classification: "needs_approval",
        reason: "Working directory is outside caller worktree",
        matchedRule: "outside-worktree",
        argv: argvCopy,
      };
    }
  }

  // 5. Check allowed command rules (Requirement 20.3)
  const allowedCheck = checkAllowedRules(argvCopy, policy);
  if (allowedCheck.allowed) {
    return {
      classification: "allowed",
      matchedRule: allowedCheck.ruleId,
      argv: argvCopy,
    };
  }

  // 6. Default to needs_approval (Requirement 20.5)
  return {
    classification: "needs_approval",
    reason: "Command is not in allowlist and requires approval (approval is required) under committed policy",
    matchedRule: "default-policy",
    argv: argvCopy,
  };
}

export const commandPolicyClassifier = classifyCommand;
export const classifyArgv = classifyCommand;
