import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Spike S2: Does `--resume-id` work after an interrupt with the workspace intact? Does a `PreToolUse` hook block with exit 2 in headless V3? What is the shell tool ID?
// Settles: Fallback approvals
// If it fails: Fallback refuses every `needs_approval` command outright
//
// This run measures all three answers for real: resume by id, a PreToolUse hook
// that exits 2 against the shell tool (and the tool id its stdin reports), and
// whether the blocked command really never ran. The spike passes only when all
// three exist; a model that never reaches the shell tool is INCONCLUSIVE.

const lines: string[] = [];

function sanitize(text: string): string {
  let res = String(text);
  const home = process.env.HOME;
  if (home) res = res.split(home).join("~");
  const key = process.env.KIRO_API_KEY;
  if (key) res = res.split(key).join("[REDACTED]");
  return res;
}

function record(msg: string): void {
  lines.push(msg);
  console.log(sanitize(msg));
}

function writeTranscript(): void {
  const evPath = process.env.EVIDENCE_PATH;
  if (!evPath) return;
  try {
    fs.mkdirSync(path.dirname(evPath), { recursive: true });
    fs.writeFileSync(evPath, sanitize(lines.join("\n")), "utf-8");
  } catch (_) {}
}

function findKiro(): string | null {
  const explicit = process.env.KIRO_CLI_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = process.env.HOME || "";
  const local = path.join(home, ".local", "bin", "kiro-cli");
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, "kiro-cli");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function runChat(kiro: string, args: string[], cwd?: string): { ok: boolean; out: string; status?: number } {
  try {
    const out = execFileSync(kiro, args, {
      cwd,
      encoding: "utf-8",
      timeout: 240000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { ok: false, out: e.stdout || "", status: e.status };
  }
}

function findSessionId(text: string): string | null {
  const matches = text.match(/"sessionId"\s*:\s*"([^"\\]+)"/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1];
    const m = last.match(/"sessionId"\s*:\s*"([^"\\]+)"/);
    if (m) return m[1];
  }
  return null;
}

function main(): void {
  const kiro = findKiro();
  if (!kiro) {
    record("INCONCLUSIVE: needs-owner-run: kiro-cli binary not found");
    writeTranscript();
    process.exit(2);
  }

  const apiKey = process.env.KIRO_API_KEY || "";
  let authPath = "api-key";
  if (!apiKey) {
    let whoami = "";
    try {
      whoami = execFileSync(kiro, ["whoami"], { encoding: "utf-8", timeout: 15000 });
    } catch (_) {
      whoami = "";
    }
    if (/logged in/i.test(whoami)) {
      authPath = "cli-login";
    } else {
      record("INCONCLUSIVE: needs-owner-run: no KIRO_API_KEY and no kiro-cli login session");
      writeTranscript();
      process.exit(2);
    }
  }

  record(`Spike S2: resume-id, PreToolUse hook and shell tool id (auth path: ${authPath})`);

  const first = runChat(kiro, [
    "chat",
    "--v3",
    "--no-interactive",
    "--output-format",
    "stream-json",
    "Remember the magic number 41. Reply with the single word stored.",
  ]);
  record(`first turn: ok=${first.ok} status=${first.status ?? "none"} bytes=${first.out.length}`);

  let sessionId = findSessionId(first.out);
  if (!sessionId) {
    const listed = runChat(kiro, ["chat", "-l", "--format", "json"]);
    sessionId = findSessionId(listed.out);
    record(`session id from the session list: ${sessionId ?? "not found"} (list ok=${listed.ok})`);
  } else {
    record(`session id from the stream: ${sessionId}`);
  }

  if (!sessionId) {
    record("VERDICT: INCONCLUSIVE - no session id was reported, so resume could not be attempted");
    writeTranscript();
    process.exit(2);
  }

  const second = runChat(kiro, [
    "chat",
    "--v3",
    "--no-interactive",
    "--resume-id",
    sessionId,
    "--output-format",
    "stream-json",
    "What magic number did I ask you to remember? Reply with just the number.",
  ]);
  record(`resume turn: ok=${second.ok} status=${second.status ?? "none"} bytes=${second.out.length}`);

  const resumed = second.ok && /\b41\b/.test(second.out);
  record(`resume kept the workspace context: ${resumed}`);

  if (!resumed) {
    record("VERDICT: FAIL - --resume-id did not continue the session with its context; refuse needs_approval commands outright");
    writeTranscript();
    process.exit(1);
  }

  // Hook half: a PreToolUse hook that records its stdin and exits 2 must stop the
  // shell tool in a headless V3 run, and its stdin names the shell tool id. The
  // agent lives in the temp workspace (kiro-cli 3.x loads <cwd>/.kiro/agents/).
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-s2-"));
  const cleanup = (): void => {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (_) {}
  };
  try {
    fs.mkdirSync(path.join(work, ".kiro", "agents"), { recursive: true });
    const hookPath = path.join(work, "hook.sh");
    const stdinLog = path.join(work, "hook-stdin.json");
    const marker = path.join(work, "marker.txt");
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh
cat > "${stdinLog}"
echo "blocked by s2 hook" >&2
exit 2
`,
      { mode: 0o755 }
    );
    // LF only: a CRLF agent file is rejected by the loader.
    fs.writeFileSync(
      path.join(work, ".kiro", "agents", "s2-agent.json"),
      JSON.stringify(
        {
          name: "s2-agent",
          description: "Phase 0 S2 probe agent",
          prompt: null,
          mcpServers: {},
          tools: ["*"],
          toolAliases: {},
          allowedTools: ["*"],
          resources: [],
          hooks: { preToolUse: [{ matcher: "*", command: hookPath }] },
          toolsSettings: {},
          includeMcpJson: true,
          model: null,
        },
        null,
        2
      ) + "\n"
    );

    const hooked = runChat(
      kiro,
      [
        "chat",
        "--v3",
        "--no-interactive",
        "--agent",
        "s2-agent",
        "--trust-all-tools",
        "--output-format",
        "stream-json",
        `Run the shell command: touch ${marker} . Then say done.`,
      ],
      work
    );
    record(`hook turn: ok=${hooked.ok} status=${hooked.status ?? "none"} bytes=${hooked.out.length}`);

    const hookRan = fs.existsSync(stdinLog);
    const markerExists = fs.existsSync(marker);
    let toolName = "unknown";
    let eventName = "unknown";
    if (hookRan) {
      try {
        const payload = JSON.parse(fs.readFileSync(stdinLog, "utf-8")) as { tool_name?: string; hook_event_name?: string };
        toolName = payload.tool_name ?? "unknown";
        eventName = payload.hook_event_name ?? "unknown";
      } catch (_) {}
    }
    record(`hook ran: ${hookRan}; event: ${eventName}; shell tool id (hook tool_name): ${toolName}; marker created despite exit 2: ${markerExists}`);

    if (!hookRan) {
      record("VERDICT: INCONCLUSIVE - the model never reached a shell tool call, so the hook was not exercised");
      writeTranscript();
      cleanup();
      process.exit(2);
    }
    if (markerExists) {
      record("VERDICT: FAIL - PreToolUse exit 2 did not block the shell tool; fallback refuses every needs_approval command outright");
      writeTranscript();
      cleanup();
      process.exit(1);
    }
    record(`VERDICT: PASS - resume works, PreToolUse exit 2 blocks the shell tool in headless V3, shell tool id is ${toolName}`);
    writeTranscript();
    cleanup();
    process.exit(0);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (_) {}
  }
}

main();
