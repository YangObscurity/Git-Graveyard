import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = process.env.E2E_PORT || "3100";
const host = process.env.E2E_HOST || "127.0.0.1";

// Snapshot next-env.d.ts before next dev mutates it, so we can restore it on exit
const nextEnvPath = path.join(rootDir, "next-env.d.ts");
let nextEnvSnapshot = null;
try {
  nextEnvSnapshot = fs.existsSync(nextEnvPath) ? fs.readFileSync(nextEnvPath, "utf8") : null;
} catch {
  // ignore
}

const monacoMarker = path.join(rootDir, "public", "monaco", "vs", "loader.js");
if (!fs.existsSync(monacoMarker)) {
  execFileSync(process.execPath, [path.join(rootDir, "scripts", "copy-monaco.mjs")], {
    cwd: rootDir,
    stdio: "inherit",
  });
}

const engineVersionFile = path.join(rootDir, "lib", "engine", "engine-version.ts");
if (!fs.existsSync(engineVersionFile)) {
  execFileSync(
    process.execPath,
    [path.join(rootDir, "scripts", "generate-engine-version.mjs")],
    { cwd: rootDir, stdio: "inherit" }
  );
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-graveyard-e2e-"));
const runsDir = path.join(tempDir, "runs");
fs.mkdirSync(runsDir, { recursive: true });

const env = { ...process.env };
delete env.KIRO_API_KEY;
delete env.KIRO_PROD_KEY;
delete env.GITHUB_TOKEN;
delete env.GITHUB_WRITE_TOKEN;
delete env.ADMIN_KEY;

env.NODE_ENV = "development";
env.RUN_STORE_PATH = path.join(tempDir, "runs.db");
env.EVENT_STORE_PATH = path.join(tempDir, "events.db");
env.RUNS_DIR = runsDir;
env.ADMIN_TOKEN = "e2e-admin-token";
env.DISABLE_AUTO_ORCHESTRATOR = "1";
env.ALLOW_DEBUG_SIM = "1";
env.NEXT_TELEMETRY_DISABLED = "1";

const nextBin = path.join(rootDir, "node_modules", "next", "dist", "bin", "next");
const child = spawn(
  process.execPath,
  [nextBin, "dev", "-H", host, "-p", port],
  {
    cwd: rootDir,
    env,
    stdio: "inherit",
  }
);

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // Restore next-env.d.ts if next dev mutated it (keeps git status clean after test:e2e)
  if (nextEnvSnapshot !== null) {
    try {
      const current = fs.existsSync(nextEnvPath) ? fs.readFileSync(nextEnvPath, "utf8") : null;
      if (current !== nextEnvSnapshot) {
        fs.writeFileSync(nextEnvPath, nextEnvSnapshot, "utf8");
      }
    } catch {
      // ignore restore errors
    }
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors while Windows releases sqlite handle
  }
}

function shutdown(signal) {
  if (!child.killed) {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
  cleanup();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", cleanup);

child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
