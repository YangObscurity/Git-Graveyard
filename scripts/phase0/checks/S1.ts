import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Spike S1: Does stream-json expose usage or credits? Do the 4,000 hackathon credits work with KIRO_API_KEY?
// Settles: Credit display; who pays for live runs
// If it fails: Live runs draw on the owner's plan credits; the owner lowers caps
//
// Runs one headless turn with --output-format stream-json and reads the records
// that come back. A field carrying credits, usage or cost answers the probe. The
// auth path actually used is recorded: a key cannot be issued for this account,
// so the run uses the kiro-cli login session and says so.

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

function walkKeys(value: unknown, prefix: string, out: Array<[string, string]>, context: Array<[string, string]>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkKeys(item, `${prefix}[${i}]`, out, context));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    if (/credit|cost|billing|consumption|charge/i.test(k) || (typeof v === "string" && /^credits?$/i.test(v))) {
      out.push([keyPath, JSON.stringify(v)]);
      // A unit value ("credit") sits next to its amount: keep the siblings too.
      if (typeof v === "string" && !Array.isArray(value)) {
        for (const [sk, sv] of Object.entries(value as Record<string, unknown>)) {
          if (sk !== k && /usage|amount|used|total/i.test(sk)) out.push([prefix ? `${prefix}.${sk}` : sk, JSON.stringify(sv)]);
        }
      }
    } else if (/token|usagePercent/i.test(k)) {
      context.push([keyPath, JSON.stringify(v)]);
    }
    walkKeys(v, keyPath, out, context);
  }
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
    } catch (err) {
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

  record(`Spike S1: one headless turn via ${kiro} (auth path: ${authPath})`);

  let stdout = "";
  let runOk = true;
  try {
    stdout = execFileSync(
      kiro,
      ["chat", "--v3", "--no-interactive", "--output-format", "stream-json", "reply with the word ok"],
      { encoding: "utf-8", timeout: 240000, maxBuffer: 32 * 1024 * 1024, cwd: process.cwd() }
    );
  } catch (err) {
    runOk = false;
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    stdout = e.stdout || "";
    record(`stream-json run failed: status=${e.status ?? "unknown"} ${e.message ?? ""}`);
    if (e.stderr) record(`stderr: ${String(e.stderr).slice(0, 2000)}`);
  }

  const rawLines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const recordTypes = new Set<string>();
  const fieldNames = new Set<string>();
  const hits: Array<[string, string]> = [];
  const contextFields: Array<[string, string]> = [];

  for (const line of rawLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const type = String(obj.type ?? obj.sessionUpdate ?? obj.method ?? "unknown");
    recordTypes.add(type);
    Object.keys(obj).forEach((k) => fieldNames.add(k));
    walkKeys(parsed, "", hits, contextFields);
  }

  record(`records returned: ${rawLines.length}; parsed types: ${Array.from(recordTypes).sort().join(", ") || "none"}`);
  if (fieldNames.size > 0) {
    record(`top-level fields seen: ${Array.from(fieldNames).sort().join(", ")}`);
  }
  if (hits.length > 0) {
    record(`credit-like fields: ${hits.slice(0, 20).map(([k, v]) => `${k}=${v}`).join("; ")}`);
  }
  if (contextFields.length > 0) {
    record(
      `context counters only (not credits): ${contextFields.slice(0, 8).map(([k, v]) => `${k}=${v}`).join("; ")}`
    );
  }

  if (!runOk && rawLines.length === 0) {
    record("VERDICT: FAIL - stream-json run produced no records; credits cannot be read this way");
    writeTranscript();
    process.exit(1);
  }

  // Only the turn summary counts: per-model rateUnit fields also say "Credit"
  // (a price list, not usage) and made the first version of this spike pass.
  const usageSeen: string[] = [];
  for (const line of rawLines) {
    try {
      const o = JSON.parse(line) as { data?: { update?: { _meta?: { kiro?: { promptTurnSummaries?: Array<{ unit?: string; usage?: number }>; kind?: string } } } } };
      const sums = o.data?.update?._meta?.kiro?.promptTurnSummaries;
      if (Array.isArray(sums)) for (const x of sums) if (x && x.unit === "credit" && typeof x.usage === "number") usageSeen.push(String(x.usage));
    } catch (_) {}
  }
  record(`turn summary credit usage values: ${usageSeen.join(", ") || "none"}`);
  if (usageSeen.length > 0) {
    record(`VERDICT: PASS - stream-json reports credit usage (see the list above); caps can be enforced from it. Not verified: whether the 4,000 hackathon credits apply to a KIRO_API_KEY (auth path here: ${authPath})`);
    writeTranscript();
    process.exit(0);
  }

  record(
    "VERDICT: FAIL - no credit, cost or billing field in stream-json; only context token counters exist. " +
      "Cap wall clock and tool calls, and show 'not reported' in the UI."
  );
  writeTranscript();
  process.exit(1);
}

main();
