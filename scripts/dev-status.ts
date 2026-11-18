import { resetDefaultEventStore } from "../lib/events/event-store";
import { resetDefaultRunStore } from "../lib/runs/run-store";
import {
  collectSystemDiagnostics,
  inspectRunDiagnostics,
  type RunDiagnostics,
  type SystemDiagnostics,
} from "../lib/runtime/diagnostics";

interface CliOptions {
  url?: string;
  json: boolean;
  probeToolchains: boolean;
  runId?: string;
  adminToken?: string;
  help: boolean;
}

interface RemoteProbeResult {
  url: string;
  health?: {
    ok: boolean;
    status: number;
    latencyMs: number;
    data?: unknown;
    error?: string;
  };
  debugStatus?: {
    ok: boolean;
    status: number;
    latencyMs: number;
    data?: unknown;
    error?: string;
  };
  runDiagnostics?: {
    ok: boolean;
    status: number;
    latencyMs: number;
    data?: unknown;
    error?: string;
  };
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    probeToolchains: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--no-toolchains") {
      opts.probeToolchains = false;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--url" && argv[i + 1]) {
      opts.url = argv[++i];
    } else if (arg.startsWith("--url=")) {
      opts.url = arg.slice("--url=".length);
    } else if (arg === "--run" && argv[i + 1]) {
      opts.runId = argv[++i];
    } else if (arg.startsWith("--run=")) {
      opts.runId = arg.slice("--run=".length);
    } else if (arg === "--admin-token" && argv[i + 1]) {
      opts.adminToken = argv[++i];
    } else if (arg.startsWith("--admin-token=")) {
      opts.adminToken = arg.slice("--admin-token=".length);
    }
  }

  return opts;
}

async function fetchJsonWithTimeout(
  targetUrl: string,
  headers?: Record<string, string>
): Promise<{
  ok: boolean;
  status: number;
  latencyMs: number;
  data?: unknown;
  error?: string;
}> {
  const start = Date.now();
  try {
    const res = await fetch(targetUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Date.now() - start;
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // keep raw text fallback
    }
    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeRemoteServer(
  rawUrl: string,
  opts: CliOptions
): Promise<RemoteProbeResult> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  const baseUrl = rawUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "x-ui-debug": "1",
  };
  const token = opts.adminToken ?? process.env.ADMIN_TOKEN ?? process.env.ADMIN_KEY;
  if (token && token.trim()) {
    headers["x-admin-token"] = token.trim();
  }

  const health = await fetchJsonWithTimeout(`${baseUrl}/api/health?detail=1`);
  const debugStatus = await fetchJsonWithTimeout(
    `${baseUrl}/api/debug/status?uiDebug=1&probeToolchains=${opts.probeToolchains ? "1" : "0"}`,
    headers
  );

  let runDiagnostics: RemoteProbeResult["runDiagnostics"];
  if (opts.runId) {
    runDiagnostics = await fetchJsonWithTimeout(
      `${baseUrl}/api/debug/runs/${encodeURIComponent(opts.runId)}?uiDebug=1`,
      headers
    );
  }

  return {
    url: baseUrl,
    health,
    debugStatus,
    ...(runDiagnostics ? { runDiagnostics } : {}),
  };
}

function formatHumanReport(
  local: SystemDiagnostics,
  localRun: RunDiagnostics | null,
  remote?: RemoteProbeResult
): string {
  const lines: string[] = [];
  lines.push("=== Git-Graveyard Dev Status ===");
  lines.push(
    `Timestamp: ${local.timestamp} | Node: ${local.nodeVersion} (${local.platform}) | Env: ${local.nodeEnv}`
  );
  lines.push(`Engine: ${local.engineVersion}`);
  lines.push("");

  lines.push("[Stores]");
  lines.push(
    `  RunStore:   mode=${local.stores.runStore.storageMode} total=${local.stores.runStore.totalRuns} living=${local.stores.runStore.livingRunsCount} published=${local.stores.runStore.publishedRunsCount} activeLive=${local.stores.runStore.activeLiveRunsCount}`
  );
  lines.push(
    `  Invites:    total=${local.stores.runStore.inviteCodesSummary.total} active=${local.stores.runStore.inviteCodesSummary.active} remainingRuns=${local.stores.runStore.inviteCodesSummary.totalRemainingRuns}`
  );
  lines.push(
    `  EventStore: mode=${local.stores.eventStore.storageMode} totalEvents=${local.stores.eventStore.totalEvents} distinctRuns=${local.stores.eventStore.distinctRunCount}`
  );
  lines.push(
    `  Recorded:   onDisk=${local.stores.recordedRuns.availableOnDisk.length} seeded=${local.stores.recordedRuns.seededRunIds.length}`
  );

  lines.push("");
  lines.push("[Probes]");
  lines.push(
    `  memory/RUNS.md present=${local.probes.sourcePresent} devAllowed=${local.probes.devAllowed} prodAllowed=${local.probes.prodAllowed} settled=${local.probes.settledByFallback.join(",") || "none"} blocking=${local.probes.blocking.join(",") || "none"}`
  );

  if (local.toolchains) {
    lines.push("");
    lines.push("[Toolchains]");
    lines.push(
      `  git:             ${local.toolchains.git.available ? "OK" : "MISSING"} (${local.toolchains.git.version ?? local.toolchains.git.error ?? "n/a"})`
    );
    lines.push(
      `  docker:          ${local.toolchains.docker.available ? "OK" : "MISSING"} (${local.toolchains.docker.version ?? local.toolchains.docker.error ?? "n/a"})`
    );
    lines.push(
      `  kiro-cli:        ${local.toolchains.kiroCli.available ? "OK" : "MISSING"} [${local.toolchains.kiroCli.source ?? "unknown"}] (${local.toolchains.kiroCli.version ?? local.toolchains.kiroCli.error ?? "n/a"})`
    );
    lines.push(
      `  tree-sitter-py:  ${local.toolchains.wasmTreeSitter.available ? "OK" : "MISSING"}`
    );
    lines.push(
      `  monaco assets:   ${local.toolchains.monacoAssets.available ? "OK" : "MISSING"}`
    );
  }

  lines.push("");
  lines.push("[Env Presence]");
  lines.push(
    `  backend=${local.envPresence.executionBackend} hasGithubToken=${local.envPresence.hasGithubToken} hasGithubWriteToken=${local.envPresence.hasGithubWriteToken} hasAdminToken=${local.envPresence.hasAdminToken}`
  );

  if (local.recentRuns.length > 0) {
    lines.push("");
    lines.push(`[Recent Runs (${local.recentRuns.length})]`);
    for (const r of local.recentRuns) {
      lines.push(
        `  - ${r.runId} | ${r.repository} | phase=${r.phase} outcome=${r.outcome ?? "null"} | published=${r.isPublished} | events=${r.eventCount} (last=#${r.lastSeq} ${r.lastEventKind ?? "-"})`
      );
    }
  }

  if (localRun) {
    lines.push("");
    lines.push(`[Local Run Diagnostics: ${localRun.runId}]`);
    lines.push(
      `  phaseParity: runStore=${localRun.phaseParity.runStorePhase} reducedView=${localRun.phaseParity.reducedViewPhase} parityOk=${localRun.phaseParity.parityOk}`
    );
    lines.push(
      `  sequenceIntegrity: count=${localRun.sequenceIntegrity.eventCount} range=${localRun.sequenceIntegrity.firstSeq ?? "-"}..${localRun.sequenceIntegrity.lastSeq ?? "-"} gaps=${localRun.sequenceIntegrity.missingSeqGaps.length}`
    );
    const presentArts = localRun.artifacts
      .filter((a) => a.presentOnDisk)
      .map((a) => `${a.fileName}(shaMatch=${a.shaMatch ?? "n/a"})`);
    lines.push(`  artifactsOnDisk: ${presentArts.join(", ") || "none"}`);
  }

  if (remote) {
    lines.push("");
    lines.push(`[Remote Server: ${remote.url}]`);
    if (remote.health) {
      const hData = remote.health.data as Record<string, unknown> | undefined;
      lines.push(
        `  /api/health?detail=1 -> status=${remote.health.status} (${remote.health.latencyMs}ms) badge=${String(hData?.badgeText ?? remote.health.error ?? "unknown")}`
      );
    }
    if (remote.debugStatus) {
      const dData = remote.debugStatus.data as Record<string, unknown> | undefined;
      const diag = dData?.diagnostics as Record<string, unknown> | undefined;
      const adm = diag?.admission as Record<string, unknown> | undefined;
      lines.push(
        `  /api/debug/status -> status=${remote.debugStatus.status} (${remote.debugStatus.latencyMs}ms) queueLength=${String(adm?.queueLength ?? remote.debugStatus.error ?? "n/a")}`
      );
    }
    if (remote.runDiagnostics) {
      lines.push(
        `  /api/debug/runs -> status=${remote.runDiagnostics.status} (${remote.runDiagnostics.latencyMs}ms)`
      );
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: npx tsx scripts/dev-status.ts [--url http://localhost:3000] [--run <runId>] [--admin-token <token>] [--no-toolchains] [--json]"
    );
    return;
  }

  try {
    const local = collectSystemDiagnostics({
      probeToolchains: opts.probeToolchains,
    });
    const localRun = opts.runId ? inspectRunDiagnostics(opts.runId) : null;
    const remote = opts.url ? await probeRemoteServer(opts.url, opts) : undefined;

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            local,
            ...(opts.runId ? { localRun } : {}),
            ...(remote ? { remote } : {}),
          },
          null,
          2
        )
      );
    } else {
      console.log(formatHumanReport(local, localRun, remote));
    }
  } finally {
    resetDefaultRunStore();
    resetDefaultEventStore();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
