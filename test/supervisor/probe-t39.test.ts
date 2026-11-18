// Probe closure tests (T39 follow-up, 2026-11-11)
// P6: kiro-cli asks the client for a shell type before any tool runs; no answer
//     stalls the session. P2: the client still refuses fs/* and terminal/*.
// P4: agents must land under the Skeleton's own HOME (KIRO_HOME is ignored).
// P5: caps come from wall clock, tool calls and (when reported) credits.
// P9: the child process gets exactly four environment variables, no sandbox flag.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { AcpClient, ACP_SHELL_TYPE, spawnSkeletonProcess } from "../../lib/supervisor/acp-client";
import { AcpTransport } from "../../lib/supervisor/acp-transport";
import { BudgetCapTracker } from "../../lib/supervisor/budget-caps";
import {
  buildSkeletonEnv,
  provisionSkeletonEnvironment,
  resolveSkeletonPaths,
} from "../../lib/supervisor/skeleton-env";
import type { ChildProcessLike } from "../../lib/supervisor/types";

class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 4321;
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | string | null = null;

  public send(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  public kill(): boolean {
    this.killed = true;
    return true;
  }
}

function collectClientMessages(child: MockChildProcess): any[] {
  const messages: any[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString("utf-8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // ignore partial lines
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  return messages;
}

function makeClient(): { child: MockChildProcess; client: AcpClient; messages: any[] } {
  const child = new MockChildProcess();
  const messages = collectClientMessages(child);
  const transport = new AcpTransport(child);
  const client = new AcpClient(transport, { watchdogLimitMs: 5000 });
  return { child, client, messages };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("P6: client duties on the _kiro/* namespace", () => {
  it("answers _kiro/terminal/shell_type so the engine can reach a tool call", async () => {
    const { child, messages } = makeClient();

    child.send({ jsonrpc: "2.0", id: 7, method: "_kiro/terminal/shell_type", params: { sessionId: "s1" } });
    await waitFor(() => messages.some((m) => m.id === 7));

    const answer = messages.find((m) => m.id === 7);
    assert.ok(answer, "the client must answer the shell-type request");
    assert.deepEqual(answer.result, { shellType: ACP_SHELL_TYPE });
    assert.equal(answer.error, undefined);
  });

  it("rejects an unknown _kiro/* method with -32601 (audit N-B2)", async () => {
    const { child, messages } = makeClient();

    child.send({ jsonrpc: "2.0", id: 8, method: "_kiro/session/context", params: {} });
    await waitFor(() => messages.some((m) => m.id === 8));

    const answer = messages.find((m) => m.id === 8);
    assert.ok(answer, "a _kiro/* request must get an answer");
    assert.equal(answer.error?.code, -32601);
    assert.equal(answer.result, undefined);
  });

  it("still rejects fs/* and terminal/* with -32601 (probe P2, Design B)", async () => {
    const { child, messages } = makeClient();

    child.send({ jsonrpc: "2.0", id: 9, method: "fs/read", params: { path: "/etc/passwd" } });
    await waitFor(() => messages.some((m) => m.id === 9));

    const answer = messages.find((m) => m.id === 9);
    assert.ok(answer);
    assert.equal(answer.error?.code, -32601);
    assert.equal(answer.result, undefined);
  });

  it("rejects a method outside both namespaces with -32601", async () => {
    const { child, messages } = makeClient();

    child.send({ jsonrpc: "2.0", id: 10, method: "custom/unknown", params: {} });
    await waitFor(() => messages.some((m) => m.id === 10));

    const answer = messages.find((m) => m.id === 10);
    assert.ok(answer);
    assert.equal(answer.error?.code, -32601);
  });

  it("advertises no fs or terminal capability at initialize (probe P2)", async () => {
    const { child, client, messages } = makeClient();

    const initPromise = client.initialize({});
    await waitFor(() => messages.some((m) => m.method === "initialize"));
    const request = messages.find((m) => m.method === "initialize");
    assert.ok(request, "initialize must be sent");

    const caps = request.params.clientCapabilities as Record<string, unknown>;
    assert.equal(caps.fs, undefined, "the client must not advertise fs");
    assert.equal(caps.terminal, undefined, "the client must not advertise terminal");

    child.send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } });
    await initPromise;
  });
});

describe("P4: agents and settings land under the Skeleton HOME", () => {
  it("writes the role agent into $HOME/.kiro/agents as well as $KIRO_HOME/agents", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-p4-"));
    const templates = path.join(base, "templates");
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(
      path.join(templates, "worker.json"),
      JSON.stringify({ name: "worker", tools: ["*"] }),
      "utf-8"
    );

    const paths = resolveSkeletonPaths("run1", "sk1", path.join(base, "runs"));
    try {
      provisionSkeletonEnvironment({ paths, role: "worker", templatesDir: templates });

      assert.ok(
        fs.existsSync(path.join(paths.homeAgentsDir, "worker.json")),
        "the loaded location is $HOME/.kiro/agents"
      );
      assert.ok(
        fs.existsSync(path.join(paths.agentsDir, "worker.json")),
        "$KIRO_HOME/agents keeps a copy for older readers"
      );
      const homeSettings = JSON.parse(fs.readFileSync(paths.homeSettingsPath, "utf-8"));
      assert.equal(homeSettings["chat.disableInheritingDefaultResources"], true);
      const kiroHomeSettings = JSON.parse(fs.readFileSync(paths.settingsPath, "utf-8"));
      assert.deepEqual(kiroHomeSettings, homeSettings);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("P9: no in-engine sandbox, explicit child environment", () => {
  it("spawns kiro-cli with exactly four environment variables and no sandbox flag", () => {
    let captured: { command: string; args: string[]; env: Record<string, string> } | undefined;

    const spawnFn = (command: string, args: string[], options: any) => {
      captured = { command, args, env: options.env };
      return new MockChildProcess();
    };

    spawnSkeletonProcess({
      runId: "run1",
      skeletonId: "sk1",
      role: "worker",
      cwd: os.tmpdir(),
      home: path.join(os.tmpdir(), "gg-home"),
      kiroHome: path.join(os.tmpdir(), "gg-kiro-home"),
      kiroApiKey: "test-key",
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
      watchdogLimitMs: 5000,
      spawnFn: spawnFn as any,
    });

    assert.ok(captured, "the process must be spawned");
    assert.equal(captured!.command, "kiro-cli");
    assert.deepEqual(captured!.args, ["acp", "--agent-engine=v3"]);
    assert.deepEqual(Object.keys(captured!.env).sort(), [
      "HOME",
      "KIRO_API_KEY",
      "KIRO_HOME",
      "PATH",
    ]);
  });
});

describe("P5: caps from wall clock, tool calls and reported credits", () => {
  function tracker(limits: { maxWallClockMs: number; maxToolCalls: number; maxCredits?: number | null }) {
    let nowMs = 1000;
    const t = new BudgetCapTracker(limits, () => nowMs);
    return { t, advance: (ms: number) => (nowMs += ms) };
  }

  it("fires on wall clock even when no tool call and no credit ever arrives", () => {
    const { t, advance } = tracker({ maxWallClockMs: 1000, maxToolCalls: 100 });
    advance(1500);
    const snap = t.snapshot();
    assert.equal(snap.exceeded, true);
    assert.equal(snap.reason, "wall_clock");
  });

  it("counts tool calls and fires on the cap", () => {
    const { t } = tracker({ maxWallClockMs: 60000, maxToolCalls: 2 });

    t.observe({ sessionUpdate: "tool_call", toolCall: { toolCallId: "a" } });
    t.observe({ sessionUpdate: "tool_call", toolCall: { toolCallId: "b" } });
    assert.equal(t.snapshot().exceeded, false);

    t.observe({ sessionUpdate: "tool_call", toolCall: { toolCallId: "c" } });
    const snap = t.snapshot();
    assert.equal(snap.toolCalls, 3);
    assert.equal(snap.reason, "tool_calls");
  });

  it("caps credits only when the stream reports them (spike S1 shape)", () => {
    const reported = tracker({ maxWallClockMs: 60000, maxToolCalls: 100, maxCredits: 0.5 });
    reported.t.observe({
      sessionUpdate: "agent_message",
      _meta: { kiro: { credits: [{ usage: 0.6, unit: "credit" }] } },
    });
    const snap = reported.t.snapshot();
    assert.equal(snap.creditsReported, true);
    assert.equal(snap.reason, "credits");

    const unreported = tracker({ maxWallClockMs: 60000, maxToolCalls: 100, maxCredits: 0.5 });
    unreported.t.observe({ sessionUpdate: "agent_message" });
    const quiet = unreported.t.snapshot();
    assert.equal(quiet.creditsReported, false);
    assert.equal(quiet.exceeded, false, "no credit cap without reported credits");
  });

  it("keeps the first cap hit", () => {
    const { t, advance } = tracker({ maxWallClockMs: 1000, maxToolCalls: 1 });
    advance(1500);
    t.snapshot();
    t.observe({ sessionUpdate: "tool_call", toolCall: { toolCallId: "a" } });
    t.observe({ sessionUpdate: "tool_call", toolCall: { toolCallId: "b" } });
    assert.equal(t.snapshot().reason, "wall_clock");
  });
});

