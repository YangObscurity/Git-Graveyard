import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn } from "node:child_process";

export interface ProbeEntry {
  id: string;
  title: string;
  command: string;
  isOperatorCheck?: boolean;
}

export interface RunOptions {
  rootDir?: string;
  dateStr?: string;
  skipOperatorCheck?: boolean;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProbeRunResult {
  id: string;
  title: string;
  command: string;
  exitCode: number | null;
  status: "passed" | "failed";
  stdout: string;
  stderr: string;
  evidenceDir: string;
  timestamp: string;
}

export const OPERATOR_CHECK_IDS = new Set<string>(["P13", "S5"]);

export const RUN_ORDER: readonly string[] = [
  "P1",
  "P4",
  "P15",
  "P3",
  "P6",
  "P7",
  "P2",
  "P5",
  "P12",
  "P9",
  "P8",
  "S4",
  "P13",
  "S5",
  "P14",
  "S1",
  "S2",
  "S3",
  "P11",
  "P10",
  "P16",
  "P17",
] as const;

export const PROBE_TABLE: ProbeEntry[] = [
  // Section R4-19 (E2 primary channel): NEEDS-OWNER-REVIEW
  {
    id: "P1",
    title: "Does `kiro-cli acp --agent-engine=v3` work headless with only `KIRO_API_KEY`?",
    command: "bash scripts/phase0/checks/P1.sh",
  },
  // Section R4-19 (wp-c Design A / R4-4): NEEDS-OWNER-REVIEW
  {
    id: "P2",
    title: "Does Kiro call client `fs/*` or `terminal/*`?",
    command: "bash scripts/phase0/checks/P2.sh",
  },
  // Section R4-19 (R4-6 Gateway transport): NEEDS-OWNER-REVIEW
  {
    id: "P3",
    title: "Does `session/new` accept the HTTP gateway, does `@necromancer/tool` select it, and can a timeout be set?",
    command: "bash scripts/phase0/checks/P3.sh",
  },
  // Section R4-19 (R4-3 / R4-4 Agent location and model allowlist): NEEDS-OWNER-REVIEW
  {
    id: "P4",
    title: "Are agents read from `$KIRO_HOME/agents`? Is the mode the agent name? Which model IDs and effort values exist?",
    command: "bash scripts/phase0/checks/P4.sh",
  },
  // Section R4-19 (R4-15 / M22 Credits in turn_completion): NEEDS-OWNER-REVIEW
  {
    id: "P5",
    title: "What does `turn_completion` / `promptTurnSummaries` contain?",
    command: "bash scripts/phase0/checks/P5.sh",
  },
  // Section R4-19 (R4-5 PermissionBroker policy): NEEDS-OWNER-REVIEW
  {
    id: "P6",
    title: "Do `ask`, `deny` and exclude-only `deny` behave as designed? Which permission options are offered?",
    command: "bash scripts/phase0/checks/P6.sh",
  },
  // Section R4-19 (R4-16 .kiro handling): NEEDS-OWNER-REVIEW
  {
    id: "P7",
    title: "Does an ACP session load the repo's `.kiro/agents`, steering, hooks, `mcp.json`, `AGENTS.md`, skills?",
    command: "bash scripts/phase0/checks/P7.sh",
  },
  // Section R4-19 (R4-15 Concurrency caps): NEEDS-OWNER-REVIEW
  {
    id: "P8",
    title: "How many `kiro-cli acp` processes can one key run, at what RSS and latency?",
    command: "bash scripts/phase0/checks/P8.sh",
  },
  // Section R4-19 (R4-6 / R4-16 bwrap sandbox and shim safety): NEEDS-OWNER-REVIEW
  {
    id: "P9",
    title: "Does `bwrap` work in the VM? What do sandboxed commands and the stdio shim see in env?",
    command: "bash scripts/phase0/checks/P9.sh",
  },
  // Section R4-19 (R4-7 Docker proxy injection): NEEDS-OWNER-REVIEW
  {
    id: "P10",
    title: "Docker proxy injection for Kiro hosts",
    command: "bash scripts/phase0/checks/P10.sh",
  },
  // Section R4-19 (R4-16 Key transport host and header): NEEDS-OWNER-REVIEW
  {
    id: "P11",
    title: "Which host and header carry the key; is there a token exchange?",
    command: "bash scripts/phase0/checks/P11.sh",
  },
  // Section R4-19 (R4-16 Symlink defense and nosymfollow): NEEDS-OWNER-REVIEW
  {
    id: "P12",
    title: "Do Kiro file tools follow symlinks; does the kernel support `nosymfollow`?",
    command: "bash scripts/phase0/checks/P12.sh",
  },
  // Section R4-19 (R4-14 Operator check): owner runs by hand during live runs
  {
    id: "P13",
    title: "Does auto-pause kill a live run on the box?",
    command: "bash scripts/phase0/checks/P13.sh",
    isOperatorCheck: true,
  },
  // Section R4-19 (R4-4 / E1 Fallback stream-json schema): NEEDS-OWNER-REVIEW
  {
    id: "P14",
    title: "`stream-json` record schema, including whether the active model is reported",
    command: "bash scripts/phase0/checks/P14.sh",
  },
  // Section R4-19 (R4-4 Advertised kiro extension methods): NEEDS-OWNER-REVIEW
  {
    id: "P15",
    title: "Which `_kiro/*` and `_session/*` methods are advertised?",
    command: "bash scripts/phase0/checks/P15.sh",
  },
  // Section R4-19 (R4-7 Docker SDK non-pty framing): NEEDS-OWNER-REVIEW
  {
    id: "P16",
    title: "Docker SDK non-pty framing: separate stderr, split lines, lossless resume?",
    command: "bash scripts/phase0/checks/P16.sh",
  },
  // Section R4-19 (R4-7 Shared cloud volume mount): NEEDS-OWNER-REVIEW
  {
    id: "P17",
    title: "Can one volume be mounted into two cloud sandboxes?",
    command: "bash scripts/phase0/checks/P17.sh",
  },
  // Section R4-19 (E6 / R4-15 Spike S1 credits display): NEEDS-OWNER-REVIEW
  {
    id: "S1",
    title: "Does stream-json expose usage or credits? Do the 4,000 hackathon credits work with `KIRO_API_KEY`?",
    command: "tsx scripts/phase0/checks/S1.ts",
  },
  // Section R4-19 (R4-4 / R4-6 Spike S2 resume-id and PreToolUse hook): NEEDS-OWNER-REVIEW
  {
    id: "S2",
    title: "Does `--resume-id` work after an interrupt with the workspace intact? Does a `PreToolUse` hook block with exit 2 in headless V3? What is the shell tool ID?",
    command: "tsx scripts/phase0/checks/S2.ts",
  },
  // Section R4-19 (R4-13 / wp-d D8.3 Spike S3 candidate repo exhumation): NEEDS-OWNER-REVIEW
  {
    id: "S3",
    title: "Exhume the candidate repos by hand (wp-d D8.3)",
    command: "tsx scripts/phase0/checks/S3.ts",
  },
  // Section R4-19 (R4-15 Spike S4 host memory and CPU): NEEDS-OWNER-REVIEW
  {
    id: "S4",
    title: "Memory and CPU of one session plus a Node build on the box",
    command: "tsx scripts/phase0/checks/S4.ts",
  },
  // Section R4-19 (R4-14 / wp-d D7 Spike S5 Operator check): owner runs by hand to verify dev box wake
  {
    id: "S5",
    title: "Can a request wake the paused box, and how fast?",
    command: "bash scripts/phase0/checks/S5.sh",
    isOperatorCheck: true,
  },
];

export function getProbeMap(table: ProbeEntry[] = PROBE_TABLE): Map<string, ProbeEntry> {
  return new Map(table.map((e) => [e.id, e]));
}

export function getProbesInRunOrder(
  table: ProbeEntry[] = PROBE_TABLE,
  runOrder: readonly string[] = RUN_ORDER
): ProbeEntry[] {
  const map = getProbeMap(table);
  return runOrder.map((id) => {
    const entry = map.get(id);
    if (!entry) {
      throw new Error(`Probe entry not found for ID: ${id}`);
    }
    return entry;
  });
}

export function findRepoRoot(startDir: string = process.cwd()): string {
  let curr = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(curr, "package.json")) && fs.existsSync(path.join(curr, ".kiro"))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) {
      break;
    }
    curr = parent;
  }
  return path.resolve(startDir);
}

export function writeEvidenceFileExclusive(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing file: ${filePath}`);
  }
  fs.writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
}

export function appendRunRecord(
  runsFilePath: string,
  entry: ProbeEntry,
  status: string,
  evidenceRelDir: string,
  timestamp: string = new Date().toISOString()
): void {
  const line = `| ${timestamp} | phase0-runner | ${entry.id}: ${entry.title} | ${status} | \`${evidenceRelDir}\` |\n`;
  if (fs.existsSync(runsFilePath)) {
    const existing = fs.readFileSync(runsFilePath, "utf-8");
    const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    fs.appendFileSync(runsFilePath, prefix + line, "utf-8");
  } else {
    fs.writeFileSync(runsFilePath, line, "utf-8");
  }
}

export async function promptOperatorConfirmation(entry: ProbeEntry): Promise<void> {
  if (!OPERATOR_CHECK_IDS.has(entry.id)) {
    return;
  }

  let promptMsg = `\n[OPERATOR CHECK REQUIRED] ${entry.id}: ${entry.title}\n`;
  if (entry.id === "P13") {
    promptMsg += "Requirement (45.13): Operator must verify an active session is open during recordings.\n";
  } else if (entry.id === "S5") {
    promptMsg += "Requirement (45.14): Operator must manually verify dev box wake status before continuing.\n";
  }
  promptMsg += "Press Enter to confirm and proceed...";

  if (!process.stdin.isTTY) {
    console.log(promptMsg);
    console.log("(Non-interactive terminal: auto-confirmed)");
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve) => {
    rl.question(promptMsg + " ", () => {
      rl.close();
      resolve();
    });
    rl.on("close", () => resolve());
  });
}

export function executeCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

export async function runProbe(
  entry: ProbeEntry,
  options: RunOptions = {}
): Promise<ProbeRunResult> {
  if (!entry.command || entry.command.trim() === "") {
    throw new Error(`Refusing to run ${entry.id}: command is empty.`);
  }

  const rootDir = options.rootDir || findRepoRoot();
  const dateStr = options.dateStr || new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();

  if (!options.skipOperatorCheck && OPERATOR_CHECK_IDS.has(entry.id)) {
    await promptOperatorConfirmation(entry);
  }

  const evidenceDir = path.resolve(rootDir, "01_evidence", `phase0-${dateStr}`, entry.id);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVIDENCE_DIR: evidenceDir,
    EVIDENCE_PATH: path.join(evidenceDir, "transcript.txt"),
  };

  console.log(`[EXEC] Running ${entry.id}: ${entry.command}`);
  const result = await executeCommand(entry.command, rootDir, env);

  const status: "passed" | "failed" = result.exitCode === 0 ? "passed" : "failed";
  const statusLabel = result.exitCode === 0 ? "passed" : `failed (exit code ${result.exitCode})`;

  const stdoutPath = path.join(evidenceDir, "stdout.txt");
  const stderrPath = path.join(evidenceDir, "stderr.txt");

  writeEvidenceFileExclusive(stdoutPath, result.stdout);
  writeEvidenceFileExclusive(stderrPath, result.stderr);

  const evidenceRelDir = path.posix.join("01_evidence", `phase0-${dateStr}`, entry.id) + "/";
  const runsFilePath = path.resolve(rootDir, "memory", "RUNS.md");
  fs.mkdirSync(path.dirname(runsFilePath), { recursive: true });
  appendRunRecord(runsFilePath, entry, statusLabel, evidenceRelDir, timestamp);

  console.log(`[${status.toUpperCase()}] ${entry.id} (exit: ${result.exitCode}) -> ${evidenceRelDir}`);

  return {
    id: entry.id,
    title: entry.title,
    command: entry.command,
    exitCode: result.exitCode,
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    evidenceDir,
    timestamp,
  };
}

export function verify(table: ProbeEntry[] = PROBE_TABLE, runOrder: readonly string[] = RUN_ORDER): void {
  console.log("================================================================================");
  console.log("Phase 0 Probe and Spike Table (R4-19)");
  console.log("================================================================================");
  console.log(
    "Order | ID   | OpCheck | Command (empty = not filled) | Title"
  );
  console.log(
    "------+------+---------+------------------------------+--------------------------------"
  );

  const entryMap = new Map(table.map((e) => [e.id, e]));

  for (let i = 0; i < runOrder.length; i++) {
    const id = runOrder[i];
    const entry = entryMap.get(id);
    if (!entry) continue;
    const orderStr = String(i + 1).padStart(2, "0");
    const idStr = entry.id.padEnd(4, " ");
    const opCheck = OPERATOR_CHECK_IDS.has(entry.id) ? "yes    " : "no     ";
    const cmdStr = (entry.command ? entry.command : "(empty)").padEnd(28, " ");
    console.log(`${orderStr}    | ${idStr} | ${opCheck} | ${cmdStr} | ${entry.title}`);
  }

  console.log("--------------------------------------------------------------------------------\n");

  const emptyEntries = runOrder
    .map((id) => entryMap.get(id))
    .filter((e): e is ProbeEntry => !!e && (!e.command || e.command.trim() === ""));

  console.log(`Empty Entries (${emptyEntries.length} of ${runOrder.length}):`);
  for (const entry of emptyEntries) {
    const op = OPERATOR_CHECK_IDS.has(entry.id) ? " [OPERATOR CHECK]" : "";
    console.log(`  - ${entry.id}${op}: ${entry.title}`);
  }

  console.log("\nSummary:");
  console.log(`  Total probes & spikes: ${runOrder.length}`);
  console.log(`  Configured commands:   ${runOrder.length - emptyEntries.length}`);
  console.log(`  Empty entries:         ${emptyEntries.length}`);
  console.log(`  Operator checks:       ${OPERATOR_CHECK_IDS.size} (${Array.from(OPERATOR_CHECK_IDS).join(", ")})`);
  console.log("\nVerification complete: all checks passed. No commands executed.");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: tsx scripts/phase0/runner.ts [options] [probe-ids...]");
    console.log("");
    console.log("Options:");
    console.log("  --verify            Print data table and empty entries, run nothing (exits 0)");
    console.log("  --date <YYYY-MM-DD> Override evidence directory date");
    console.log("  --help, -h          Show this help message");
    console.log("");
    console.log("Run order (from R4-19):");
    console.log(`  ${RUN_ORDER.join(", ")}`);
    return;
  }

  if (argv.includes("--verify")) {
    verify(PROBE_TABLE, RUN_ORDER);
    return;
  }

  let dateStr: string | undefined;
  const dateIdx = argv.indexOf("--date");
  if (dateIdx !== -1 && dateIdx + 1 < argv.length) {
    dateStr = argv[dateIdx + 1];
  }

  const flags = new Set(["--verify", "--date", "-h", "--help"]);
  const targetIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--date") {
      i++;
      continue;
    }
    if (flags.has(arg)) continue;
    targetIds.push(arg.toUpperCase());
  }

  const probeMap = getProbeMap(PROBE_TABLE);
  const sequenceIds = targetIds.length > 0 ? targetIds : Array.from(RUN_ORDER);

  for (const id of sequenceIds) {
    if (!probeMap.has(id)) {
      console.error(`Error: Unknown probe or spike ID: ${id}`);
      process.exit(1);
    }
  }

  const entriesToRun = sequenceIds.map((id) => probeMap.get(id)!);
  const emptyEntries = entriesToRun.filter(
    (e) => !e.command || e.command.trim() === ""
  );

  if (emptyEntries.length > 0) {
    console.error("Refusing to run entry with empty command.");
    console.error(`Empty entries (${emptyEntries.length} of ${entriesToRun.length}):`);
    for (const e of emptyEntries) {
      console.error(`  - ${e.id}: ${e.title}`);
    }
  }

  const executableEntries = entriesToRun.filter(
    (e) => e.command && e.command.trim() !== ""
  );

  if (executableEntries.length === 0) {
    console.error("\nNo configured entries to run. Please fill in commands before executing.");
    process.exit(1);
  }

  console.log(`\nExecuting ${executableEntries.length} configured probe(s)...`);
  for (const entry of executableEntries) {
    await runProbe(entry, { dateStr });
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("runner.ts") || process.argv[1].endsWith("runner.js"));

if (isMain) {
  main().catch((err) => {
    console.error("Runner failed with error:", err);
    process.exit(1);
  });
}
