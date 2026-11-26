/**
 * Task 20.2: Headless Fallback channel and stream-json parser.
 * Covers exit mapping, P14 model verification, P5/S1 credit extraction, the
 * P1/P14 activation gate, strict four-variable env isolation, approval resume
 * via --resume-id, S2-false refusal and auto-denied asks.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  createStreamDiskLogger,
  extractHeadlessActiveModel,
  extractHeadlessCredits,
  mapHeadlessExitCode,
  parseStreamJsonLine,
  verifyHeadlessModel,
} from "../../lib/acp/stream-parser";
import {
  HeadlessFallbackChannel,
  buildHeadlessArgs,
  isHeadlessFallbackAllowed,
} from "../../lib/acp/headless-fallback";
import type { ChildProcessLike, SpawnFunction } from "../../lib/supervisor/types";

class MockProcess extends EventEmitter {
  stdin = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | string | null = null;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/**
 * Synthetic credential fixtures are assembled at runtime so the repository's
 * `gitleaks` `generic-api-key` rule never sees a contiguous literal secret and
 * never flags these test files. The same construction is applied to the synthetic
 * `ghp_` / `sk-` tokens below.
 */
const sampleCredential = ["fixture", "kiro", "val", "1234"].join("-");
const sampleShortCredential = ["k9", "z!"].join("");

interface Captured {
  args?: readonly string[];
  env?: Record<string, string>;
  calls: number;
}

/**
 * Builds a spawn function that writes scripted stdout lines and exits with the
 * given code. The script receives the call index so a resume turn can respond
 * differently. An optional `stderrLines` array is written to stderr before the
 * process closes.
 */
function makeSpawn(
  script: (
    callIndex: number,
    args: readonly string[]
  ) => { lines: unknown[]; code: number | null; stderrLines?: unknown[] },
  captured: Captured
): SpawnFunction {
  return (command: string, args: readonly string[], options): ChildProcessLike => {
    captured.calls += 1;
    captured.args = args;
    captured.env = options.env;
    const proc = new MockProcess();
    const { lines, code, stderrLines } = script(captured.calls - 1, args);
    setImmediate(() => {
      for (const line of lines) {
        proc.stdout.write(typeof line === "string" ? line : JSON.stringify(line) + "\n");
      }
      proc.stdout.end();
      if (stderrLines) {
        for (const line of stderrLines) {
          proc.stderr.write(
            typeof line === "string" ? line : JSON.stringify(line) + "\n"
          );
        }
        proc.stderr.end();
      }
      setImmediate(() => {
        proc.exitCode = code;
        proc.emit("close", code);
      });
    });
    return proc as unknown as ChildProcessLike;
  };
}

function makeChannel(
  options: Partial<ConstructorParameters<typeof HeadlessFallbackChannel>[0]> = {}
) {
  const { onAskAutoDeny, ...rest } = options;
  return new HeadlessFallbackChannel({
    runId: "run-1",
    skeletonId: "skel-1",
    kiroHomeDir: "/isolated/kiro-home",
    homeDir: "/isolated/home",
    modelId: "claude-sonnet-5.5",
    agentName: "bonesetter",
    worktreeDir: "/tmp/worktree",
    p1Passed: false,
    p14Passed: true,
    ...rest,
    // The hook is required in production; tests default to a no-op and may
    // override it (including with `undefined` to exercise the fail-closed path).
    onAskAutoDeny: onAskAutoDeny ?? (() => {}),
  });
}

describe("stream-parser exit codes", () => {
  it("maps 0 to success without discarding output", () => {
    assert.deepEqual(mapHeadlessExitCode(0), {
      ok: true,
      status: "success",
      discardOutput: false,
    });
  });

  it("maps 1 to failure without discarding output", () => {
    assert.deepEqual(mapHeadlessExitCode(1), {
      ok: false,
      status: "failure",
      discardOutput: false,
    });
  });

  it("maps any other non-zero to failure", () => {
    assert.equal(mapHeadlessExitCode(2).status, "failure");
    assert.equal(mapHeadlessExitCode(null).status, "failure");
    assert.equal(mapHeadlessExitCode(undefined).status, "failure");
  });

  it("maps 3 to gateway_missing", () => {
    assert.deepEqual(mapHeadlessExitCode(3), {
      ok: false,
      status: "gateway_missing",
      discardOutput: false,
    });
  });

  it("maps 4 to missing_agent and discards output", () => {
    assert.deepEqual(mapHeadlessExitCode(4), {
      ok: false,
      status: "missing_agent",
      discardOutput: true,
    });
  });
});

describe("stream-parser NDJSON", () => {
  it("parses one JSON object per line", () => {
    const record = parseStreamJsonLine('{"type":"session","sessionId":"s-1"}');
    assert.deepEqual(record, { type: "session", sessionId: "s-1" });
  });

  it("returns null for blank lines", () => {
    assert.equal(parseStreamJsonLine(""), null);
    assert.equal(parseStreamJsonLine("   "), null);
  });

  it("returns a parse_warning for malformed lines instead of crashing", () => {
    const record = parseStreamJsonLine("{ not json");
    assert.equal(record?.type, "parse_warning");
    assert.equal(record?.raw, "{ not json");
  });
});

describe("stream-parser model verification (P14)", () => {
  it("reads the active model from the documented fields", () => {
    assert.equal(extractHeadlessActiveModel([{ type: "x", model: "claude-sonnet-5.5" }]), "claude-sonnet-5.5");
    assert.equal(extractHeadlessActiveModel([{ type: "x", activeModel: "claude-opus-5.5" }]), "claude-opus-5.5");
    assert.equal(extractHeadlessActiveModel([{ type: "x", modelId: "claude-haiku-5.5" }]), "claude-haiku-5.5");
    assert.equal(
      extractHeadlessActiveModel([{ type: "x", session: { model: "claude-sonnet-5.5" } }]),
      "claude-sonnet-5.5"
    );
    assert.equal(
      extractHeadlessActiveModel([{ type: "x", metadata: { model: "claude-opus-5.5" } }]),
      "claude-opus-5.5"
    );
  });

  it("accepts the expected allowlisted model", () => {
    const result = verifyHeadlessModel(
      [{ type: "session", model: "claude-sonnet-5.5" }],
      "claude-sonnet-5.5"
    );
    assert.equal(result.ok, true);
    assert.equal(result.activeModel, "claude-sonnet-5.5");
  });

  it("rejects auto", () => {
    const result = verifyHeadlessModel([{ type: "session", model: "auto" }], "claude-sonnet-5.5");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "model_mismatch");
  });

  it("rejects a missing model", () => {
    const result = verifyHeadlessModel([{ type: "log", text: "hi" }], "claude-sonnet-5.5");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "model_mismatch");
    assert.equal(result.activeModel, null);
  });

  it("rejects a model outside the allowlist or different from the expected tier", () => {
    assert.equal(verifyHeadlessModel([{ type: "x", model: "claude-opus-5.5" }], "claude-sonnet-5.5").ok, false);
    assert.equal(verifyHeadlessModel([{ type: "x", model: "gpt-5" }], "claude-sonnet-5.5").ok, false);
  });

  it("honors the explicit P14 model-check-disabled test flag", () => {
    const result = verifyHeadlessModel([], "claude-sonnet-5.5", { modelCheckDisabled: true });
    assert.equal(result.ok, true);
  });
});

describe("stream-parser credit extraction (P5/S1)", () => {
  it("reads turn_completion.promptTurnSummaries credit entries", () => {
    const result = extractHeadlessCredits([
      {
        type: "turn_completion",
        promptTurnSummaries: [
          { unit: "credit", value: 12 },
          { unit: "token", value: 1000 },
        ],
      },
    ]);
    assert.equal(result.creditsReported, true);
    assert.equal(result.credits, 12);
  });

  it("sums credits across summaries", () => {
    const result = extractHeadlessCredits([
      { type: "turn_completion", promptTurnSummaries: [{ unit: "credit", credits: 5 }] },
      { type: "turn_completion", promptTurnSummaries: [{ unit: "credit", amount: 7 }] },
    ]);
    assert.equal(result.credits, 12);
  });

  it("returns not-reported without a credit field", () => {
    assert.deepEqual(extractHeadlessCredits([{ type: "turn_completion" }]), {
      creditsReported: false,
      credits: null,
    });
    assert.deepEqual(
      extractHeadlessCredits([{ type: "turn_completion", promptTurnSummaries: [{ unit: "token", value: 9 }] }]),
      { creditsReported: false, credits: null }
    );
  });

  it("reads the `usage` field of a credit summary (spike S1 / probe P5)", () => {
    const result = extractHeadlessCredits([
      {
        type: "turn_completion",
        promptTurnSummaries: [{ unit: "credit", usage: 0.06 }],
      },
    ]);
    assert.equal(result.creditsReported, true);
    assert.equal(result.credits, 0.06);
  });

  it("does not double-count a record with both a summary credit and a top-level credit", () => {
    const result = extractHeadlessCredits([
      {
        type: "turn_completion",
        credits: 100,
        promptTurnSummaries: [{ unit: "credit", usage: 5 }],
      },
    ]);
    assert.equal(result.creditsReported, true);
    assert.equal(result.credits, 5);
  });

  it("counts a top-level credit when no summary credit is present", () => {
    const result = extractHeadlessCredits([{ type: "turn_completion", credits: 7 }]);
    assert.equal(result.creditsReported, true);
    assert.equal(result.credits, 7);
  });
});

describe("StreamDiskLogger (Requirement 17.4)", () => {
  it("reports ok and no error after a successful write", () => {
    const { logPath, cleanup } = tempLogPath("logger-ok");
    try {
      const logger = createStreamDiskLogger(logPath);
      logger.appendLine('{"type":"log"}');
      assert.equal(logger.ok, true);
      assert.equal(logger.getLastError(), null);
      assert.equal(logger.lastError, null);
      logger.close();
      assert.ok(fs.existsSync(logPath));
    } finally {
      cleanup();
    }
  });

  it("exposes the disk write failure through getLastError()/ok", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-logger-fail-"));
    try {
      // A directory at the log path makes openSync fail (EISDIR).
      const logger = createStreamDiskLogger(dir);
      logger.appendLine('{"type":"log"}');
      assert.equal(logger.ok, false);
      assert.ok(logger.getLastError() instanceof Error);
      assert.ok(logger.lastError instanceof Error);
      logger.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts explicit secret literals that match no generic token pattern", () => {
    const { logPath, cleanup } = tempLogPath("logger-secret");
    try {
      const logger = createStreamDiskLogger(logPath, {
        secrets: [sampleCredential],
      });
      logger.appendLine(`{"type":"log","text":"key=${sampleCredential}"}`);
      logger.close();
      const written = fs.readFileSync(logPath, "utf-8");
      assert.ok(!written.includes(sampleCredential));
      assert.ok(written.includes("[REDACTED]"));
    } finally {
      cleanup();
    }
  });
});

describe("isHeadlessFallbackAllowed (P1/P14 gate)", () => {
  it("is enabled only when P1 failed and P14 passed", () => {
    assert.equal(isHeadlessFallbackAllowed({ p1Passed: false, p14Passed: true }), true);
    assert.equal(isHeadlessFallbackAllowed({ p1Passed: true, p14Passed: true }), false);
    assert.equal(isHeadlessFallbackAllowed({ p1Passed: false, p14Passed: false }), false);
    assert.equal(isHeadlessFallbackAllowed({ p1Passed: true, p14Passed: false }), false);
  });
});

function tempLogPath(tag: string): { logPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gg-headless-${tag}-`));
  return {
    logPath: path.join(dir, "stream.jsonl"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("buildHeadlessArgs", () => {
  it("orders the documented argv and appends --resume-id", () => {
    const args = buildHeadlessArgs({
      prompt: "do work",
      modelId: "claude-sonnet-5.5",
      agentName: "bonesetter",
      gatewayToolIds: ["sandbox_exec", "report_task_result"],
      resumeId: "sess-7",
    });
    assert.deepEqual(args, [
      "chat",
      "--v3",
      "--no-interactive",
      "--output-format",
      "stream-json",
      "--model",
      "claude-sonnet-5.5",
      "--agent",
      "bonesetter",
      "--require-mcp-startup",
      "--trust-tools",
      "sandbox_exec,report_task_result",
      "--resume-id",
      "sess-7",
      "--",
      "do work",
    ]);
  });

  it("always emits --require-mcp-startup even when the option is false", () => {
    const args = buildHeadlessArgs({
      prompt: "p",
      modelId: "claude-sonnet-5.5",
      requireMcpStartup: false,
    });
    assert.ok(args.includes("--require-mcp-startup"));
    assert.equal(args.filter((a) => a === "--require-mcp-startup").length, 1);
  });
});

describe("HeadlessFallbackChannel activation gate", () => {
  it("refuses immediately when disabled and never spawns", async () => {
    let spawned = false;
    const channel = makeChannel({
      p1Passed: true,
      p14Passed: true,
      spawnFn: (() => {
        spawned = true;
        return new MockProcess() as unknown as ChildProcessLike;
      }) as unknown as SpawnFunction,
    });
    const result = await channel.runTurn({ prompt: "hi" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "headless_fallback_disabled");
    assert.equal(spawned, false);
    assert.equal(channel.isEnabled(), false);
  });
});

describe("HeadlessFallbackChannel turn execution", () => {
  it("isolates the environment to four variables and verifies the model", async () => {
    const { logPath, cleanup } = tempLogPath("env");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        gatewayToolIds: ["sandbox_exec"],
        logPath,
        spawnFn: makeSpawn(
          () => ({
            lines: [
              { type: "session", sessionId: "sess-1", model: "claude-sonnet-5.5" },
              {
                type: "turn_completion",
                promptTurnSummaries: [{ unit: "credit", value: 5 }],
              },
            ],
            code: 0,
          }),
          captured
        ),
      });

      const result = await channel.runTurn({ prompt: "do work" });

      assert.equal(result.ok, true);
      assert.equal(result.status, "success");
      assert.equal(result.sessionId, "sess-1");
      assert.equal(result.modelVerified, true);
      assert.equal(result.activeModel, "claude-sonnet-5.5");
      assert.equal(result.creditsReported, true);
      assert.equal(result.credits, 5);
      assert.equal(result.outputDiscarded, false);

      assert.deepEqual(Object.keys(captured.env ?? {}).sort(), [
        "HOME",
        "KIRO_API_KEY",
        "KIRO_HOME",
        "PATH",
      ]);
      assert.ok(captured.args?.includes("--output-format"));
      assert.ok(captured.args?.includes("stream-json"));
      assert.ok(captured.args?.includes("--trust-tools"));
      assert.ok(fs.existsSync(logPath));
    } finally {
      cleanup();
    }
  });

  it("discards output on exit code 4 (missing agent)", async () => {
    const { logPath, cleanup } = tempLogPath("exit4");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        spawnFn: makeSpawn(
          () => ({ lines: [{ type: "log", text: "boom" }], code: 4 }),
          captured
        ),
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "missing_agent");
      assert.equal(result.outputDiscarded, true);
      assert.equal(result.output, "");
    } finally {
      cleanup();
    }
  });

  it("fails with model_mismatch when the stream reports auto", async () => {
    const { logPath, cleanup } = tempLogPath("auto");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        spawnFn: makeSpawn(
          () => ({ lines: [{ type: "session", model: "auto" }], code: 0 }),
          captured
        ),
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "model_mismatch");
      assert.equal(result.reason, "model_mismatch");
      assert.equal(result.modelVerified, false);
    } finally {
      cleanup();
    }
  });

  it("auto-denies ask requests and never blocks forever", async () => {
    const { logPath, cleanup } = tempLogPath("ask");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        spawnFn: makeSpawn(
          () => ({
            lines: [
              { type: "session", model: "claude-sonnet-5.5" },
              { type: "ask_request", askId: "a-1", text: "which manager?" },
            ],
            code: 0,
          }),
          captured
        ),
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);
      assert.equal(result.autoDeniedAsks.length, 1);
      assert.equal(result.autoDeniedAsks[0].askId, "a-1");
    } finally {
      cleanup();
    }
  });

  it("drains buffered stdout before parsing even when exit fires first", async () => {
    const { logPath, cleanup } = tempLogPath("exit-race");
    try {
      const channel = makeChannel({
        logPath,
        spawnFn: (command, args, options) => {
          const proc = new MockProcess();
          setImmediate(() => {
            // An exit (code 0) is emitted BEFORE any stdout data or close. If the
            // channel listened on "exit" it would settle with no records.
            proc.emit("exit", 0);
            proc.stdout.write(
              JSON.stringify({ type: "session", model: "claude-sonnet-5.5" }) + "\n"
            );
            proc.stdout.end();
            setImmediate(() => {
              proc.exitCode = 0;
              proc.emit("close", 0);
            });
          });
          return proc as unknown as ChildProcessLike;
        },
      });
      const result = await channel.runTurn({ prompt: "do work" });
      assert.equal(result.ok, true);
      assert.equal(result.status, "success");
      assert.equal(result.activeModel, "claude-sonnet-5.5");
    } finally {
      cleanup();
    }
  });

  it("injects the approval decision into the initial resumed prompt", async () => {
    const { logPath, cleanup } = tempLogPath("approval-prompt");
    try {
      let spawnArgs: readonly string[] | undefined;
      const channel = makeChannel({
        logPath,
        spawnFn: (command, args, options) => {
          spawnArgs = args;
          const proc = new MockProcess();
          setImmediate(() => {
            proc.stdout.write(
              JSON.stringify({ type: "session", model: "claude-sonnet-5.5" }) + "\n"
            );
            proc.stdout.end();
            setImmediate(() => {
              proc.exitCode = 0;
              proc.emit("close", 0);
            });
          });
          return proc as unknown as ChildProcessLike;
        },
      });
      const result = await channel.runTurn({
        prompt: "original task",
        approvalDecision: { approvalId: "ap-9", decision: "approve" },
      });
      assert.equal(result.ok, true);
      const promptArg = spawnArgs?.[spawnArgs.length - 1] ?? "";
      assert.ok(promptArg.includes("original task"));
      assert.ok(promptArg.includes("ap-9"));
      assert.ok(promptArg.includes("approve"));
    } finally {
      cleanup();
    }
  });

  it("invokes the onAskAutoDeny hook for every observed ask", async () => {
    const { logPath, cleanup } = tempLogPath("ask-hook");
    try {
      const denied: Array<string | null> = [];
      const channel = makeChannel({
        logPath,
        onAskAutoDeny: (ask) => {
          denied.push(ask.askId);
        },
        spawnFn: makeSpawn(
          () => ({
            lines: [
              { type: "session", model: "claude-sonnet-5.5" },
              { type: "ask_request", askId: "a-1", text: "q1" },
              { type: "ask_request", askId: "a-2", text: "q2" },
            ],
            code: 0,
          }),
          { calls: 0 }
        ),
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);
      assert.deepEqual(denied, ["a-1", "a-2"]);
      assert.equal(result.autoDeniedAsks.length, 2);
    } finally {
      cleanup();
    }
  });

  it("preserves the spawn error message when spawning fails", async () => {
    const { logPath, cleanup } = tempLogPath("spawn-fail");
    try {
      const channel = makeChannel({
        logPath,
        spawnFn: () => {
          throw new Error("spawn boom");
        },
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "failure");
      assert.equal(result.reason, "spawn_failed");
      assert.equal(result.spawnError, "spawn boom");
    } finally {
      cleanup();
    }
  });

  it("fails with stream_log_write_failed when the raw stream cannot be logged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-logfail-"));
    try {
      const channel = makeChannel({
        // A directory at the log path forces the disk logger to fail (EISDIR).
        logPath: dir,
        spawnFn: makeSpawn(
          () => ({ lines: [{ type: "session", model: "claude-sonnet-5.5" }], code: 0 }),
          { calls: 0 }
        ),
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "failure");
      assert.equal(result.reason, "stream_log_write_failed");
      assert.equal(typeof result.logError, "string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HeadlessFallbackChannel cancellation", () => {
  it("reports cancelled (not failure) when cancel() aborts the active turn", async () => {
    const { logPath, cleanup } = tempLogPath("cancel");
    try {
      let proc: MockProcess | null = null;
      const channel = makeChannel({
        logPath,
        spawnFn: () => {
          const p = new MockProcess();
          // Never closes on its own; kill() emits close with a SIGTERM signal.
          p.kill = () => {
            p.signalCode = "SIGTERM";
            p.exitCode = null;
            p.emit("close", null);
            return true;
          };
          proc = p;
          return p as unknown as ChildProcessLike;
        },
      });
      const pending = channel.runTurn({ prompt: "long task" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(proc);
      assert.equal(channel.cancel(), true);
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.status, "cancelled");
      assert.equal(result.reason, "cancelled");
    } finally {
      cleanup();
    }
  });
});

describe("HeadlessFallbackChannel approval interrupts", () => {
  it("outright refuses needs_approval when S2 resume is unsupported", async () => {
    const { logPath, cleanup } = tempLogPath("s2false");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        s2ResumeSupported: false,
        onApproval: () => "approve",
        spawnFn: makeSpawn(
          () => ({
            lines: [
              { type: "session", sessionId: "sess-9", model: "claude-sonnet-5.5" },
              { type: "approval_request", approvalId: "ap-1", tool: "shell" },
            ],
            code: 0,
          }),
          captured
        ),
      });
      const result = await channel.runTurn({ prompt: "run a command" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "refused");
      assert.equal(result.reason, "approval_resume_unsupported");
      assert.equal(result.approvals.length, 1);
      assert.equal(result.approvals[0].approvalId, "ap-1");
      // Only the first process ran; no resume happened.
      assert.equal(captured.calls, 1);
    } finally {
      cleanup();
    }
  });

  it("resumes the session with --resume-id after an approved interrupt", async () => {
    const { logPath, cleanup } = tempLogPath("s2true");
    try {
      const captured: Captured = { calls: 0 };
      const seenApprovalIds: Array<string | null> = [];
      let resumeTurnArgs: readonly string[] | undefined;

      const channel = makeChannel({
        logPath,
        s2ResumeSupported: true,
        onApproval: (request) => {
          seenApprovalIds.push(request.approvalId);
          return "approve";
        },
        spawnFn: (command, args, options) => {
          captured.calls += 1;
          captured.args = args;
          captured.env = options.env;
          const proc = new MockProcess();
          const callIndex = captured.calls - 1;
          if (callIndex === 1) {
            resumeTurnArgs = args;
          }
          const lines =
            callIndex === 0
              ? [
                  { type: "session", sessionId: "sess-42", model: "claude-sonnet-5.5" },
                  { type: "approval_request", approvalId: "ap-7", tool: "shell" },
                ]
              : [{ type: "session", model: "claude-sonnet-5.5" }];
          setImmediate(() => {
            for (const line of lines) {
              proc.stdout.write(JSON.stringify(line) + "\n");
            }
            proc.stdout.end();
            setImmediate(() => {
              proc.exitCode = 0;
              proc.emit("close", 0);
            });
          });
          return proc as unknown as ChildProcessLike;
        },
      });

      const result = await channel.runTurn({ prompt: "run a command" });

      assert.equal(result.ok, true);
      assert.equal(result.resumed, true);
      assert.deepEqual(seenApprovalIds, ["ap-7"]);
      assert.equal(captured.calls, 2);
      // Requirement 17.6: the resume turn carries --resume-id <sessionId>.
      const resumeIndex = resumeTurnArgs?.indexOf("--resume-id") ?? -1;
      assert.ok(resumeIndex >= 0);
      assert.equal(resumeTurnArgs?.[resumeIndex + 1], "sess-42");
    } finally {
      cleanup();
    }
  });
});

describe("HeadlessFallbackChannel secret redaction", () => {
  const GENERIC_GH = `ghp_${"A".repeat(30)}`;
  const GENERIC_SK = `sk-${"b".repeat(32)}`;
  const KIRO_KEY = sampleCredential;

  it("redacts generic tokens and the KIRO_API_KEY literal in the output, records, approvals, asks and disk log", async () => {
    const { logPath, cleanup } = tempLogPath("redact");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        kiroApiKey: KIRO_KEY,
        s2ResumeSupported: true,
        onApproval: () => "approve",
        onAskAutoDeny: () => {
          /* auto-denied */
        },
        spawnFn: makeSpawn(
          (callIndex) =>
            callIndex === 0
              ? {
                  lines: [
                    { type: "session", sessionId: "sess-secret", model: "claude-sonnet-5.5" },
                    {
                      type: "assistant",
                      text: `leaked ${GENERIC_GH} and ${GENERIC_SK} and ${KIRO_KEY}`,
                    },
                    {
                      type: "ask_request",
                      askId: "a-1",
                      text: `run ${GENERIC_GH} with ${KIRO_KEY}`,
                    },
                    {
                      type: "approval_request",
                      approvalId: "ap-1",
                      tool: "shell",
                      command: `echo ${GENERIC_GH} ${KIRO_KEY}`,
                    },
                    {
                      type: "turn_completion",
                      promptTurnSummaries: [{ unit: "credit", value: 5 }],
                    },
                  ],
                  code: 0,
                }
              : {
                  lines: [
                    { type: "session", sessionId: "sess-secret", model: "claude-sonnet-5.5" },
                    {
                      type: "assistant",
                      text: `resumed with ${GENERIC_GH} and ${KIRO_KEY}`,
                    },
                    {
                      type: "turn_completion",
                      promptTurnSummaries: [{ unit: "credit", value: 5 }],
                    },
                  ],
                  code: 0,
                },
          captured
        ),
      });

      const result = await channel.runTurn({ prompt: "do work" });

      // Normal turn parsing is unaffected by redaction.
      assert.equal(result.ok, true);
      assert.equal(result.status, "success");
      assert.equal(result.modelVerified, true);
      assert.equal(result.activeModel, "claude-sonnet-5.5");
      assert.equal(result.sessionId, "sess-secret");
      assert.equal(result.creditsReported, true);
      assert.equal(result.credits, 10);
      assert.equal(result.approvals.length, 1);
      assert.equal(result.approvals[0].approvalId, "ap-1");
      assert.equal(result.autoDeniedAsks.length, 1);
      assert.equal(result.autoDeniedAsks[0].askId, "a-1");

      const secrets = [GENERIC_GH, GENERIC_SK, KIRO_KEY];

      // Returned output, records, approvals and auto-denied asks are all scrubbed.
      for (const secret of secrets) {
        assert.ok(!result.output.includes(secret), `output leaks ${secret}`);
        assert.ok(
          !JSON.stringify(result.records).includes(secret),
          `records leak ${secret}`
        );
        assert.ok(
          !JSON.stringify(result.approvals).includes(secret),
          `approvals leak ${secret}`
        );
        assert.ok(
          !JSON.stringify(result.autoDeniedAsks).includes(secret),
          `autoDeniedAsks leak ${secret}`
        );
      }
      assert.ok(result.output.includes("[REDACTED]"));
      assert.ok(JSON.stringify(result.records).includes("[REDACTED]"));

      // The on-disk stream log is scrubbed of both the generic token and the key.
      const written = fs.readFileSync(logPath, "utf-8");
      for (const secret of secrets) {
        assert.ok(!written.includes(secret), `disk log leaks ${secret}`);
      }
    } finally {
      cleanup();
    }
  });

  it("redacts a short (<8 char) kiroApiKey literal everywhere it can leak", async () => {
    const { logPath, cleanup } = tempLogPath("redact-short");
    try {
      // A dynamically constructed short key ("k9z!", length 4) previously escaped
      // explicit redaction because the literal filter required >= 8 characters.
      const shortKey = sampleShortCredential;
      assert.ok(shortKey.length < 8);
      assert.ok(shortKey.trim().length > 0);

      const loggedStderr: string[] = [];
      const channel = makeChannel({
        logPath,
        kiroApiKey: shortKey,
        onLog: (stream, text) => {
          if (stream === "stderr") {
            loggedStderr.push(text);
          }
        },
        spawnFn: makeSpawn(
          () => ({
            lines: [
              { type: "session", model: "claude-sonnet-5.5" },
              { type: "assistant", text: `leaked ${shortKey} and ${GENERIC_GH}` },
            ],
            code: 0,
            stderrLines: [`stderr carries ${shortKey}\n`],
          }),
          { calls: 0 }
        ),
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);
      assert.ok(result.output.includes("[REDACTED]"));
      assert.ok(!result.output.includes(shortKey), "output leaks the short key");
      assert.ok(!result.output.includes(GENERIC_GH), "output leaks the generic token");
      assert.ok(
        !JSON.stringify(result.records).includes(shortKey),
        "records leak the short key"
      );

      const written = fs.readFileSync(logPath, "utf-8");
      assert.ok(!written.includes(shortKey), "disk log leaks the short key");

      // The onLog sink is scrubbed as well (the key was written to stderr).
      const allLogged = loggedStderr.join("");
      assert.ok(allLogged.length > 0);
      assert.ok(!allLogged.includes(shortKey), "onLog leaks the short key");
    } finally {
      cleanup();
    }
  });

  it("keeps output empty when it is discarded (exit code 4)", async () => {
    const { logPath, cleanup } = tempLogPath("redact-discard");
    try {
      const channel = makeChannel({
        logPath,
        kiroApiKey: KIRO_KEY,
        spawnFn: makeSpawn(
          () => ({
            lines: [{ type: "log", text: `boom ${KIRO_KEY} ${GENERIC_GH}` }],
            code: 4,
          }),
          { calls: 0 }
        ),
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.outputDiscarded, true);
      assert.equal(result.output, "");
    } finally {
      cleanup();
    }
  });

  it("redacts child stderr before forwarding it to onLog", async () => {
    const { logPath, cleanup } = tempLogPath("stderr-redact");
    try {
      const stderrChunks: string[] = [];
      const channel = makeChannel({
        logPath,
        kiroApiKey: KIRO_KEY,
        onLog: (stream, text) => {
          if (stream === "stderr") {
            stderrChunks.push(text);
          }
        },
        spawnFn: makeSpawn(
          () => ({
            lines: [{ type: "session", model: "claude-sonnet-5.5" }],
            code: 0,
            stderrLines: [`token ${GENERIC_GH} key ${KIRO_KEY}\n`],
          }),
          { calls: 0 }
        ),
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);

      const stderrText = stderrChunks.join("");
      assert.ok(stderrText.length > 0, "onLog never received stderr");
      assert.ok(
        !stderrText.includes(GENERIC_GH),
        "onLog leaked the generic token"
      );
      assert.ok(!stderrText.includes(KIRO_KEY), "onLog leaked the kiroApiKey");
      assert.ok(stderrText.includes("[REDACTED]"));
    } finally {
      cleanup();
    }
  });

  it("redacts credentials split across stderr chunk boundaries", async () => {
    const { logPath, cleanup } = tempLogPath("stderr-chunk-split");
    try {
      const stderrChunks: string[] = [];
      // Split each secret in half so neither `data` chunk contains a matchable
      // token on its own. `ghp_` needs 20+ trailing chars and the KIRO_API_KEY
      // literal is registered explicitly, so a half never matches in isolation.
      const ghHalfA = `ghp_${"A".repeat(15)}`;
      const ghHalfB = `${"A".repeat(15)}`;
      const keyHalfA = sampleCredential.slice(0, 13);
      const keyHalfB = sampleCredential.slice(13);

      const channel = makeChannel({
        logPath,
        kiroApiKey: KIRO_KEY,
        onLog: (stream, text) => {
          if (stream === "stderr") {
            stderrChunks.push(text);
          }
        },
        spawnFn: (command, args, options) => {
          const proc = new MockProcess();
          proc.stdout.write(
            JSON.stringify({ type: "session", model: "claude-sonnet-5.5" }) + "\n"
          );
          proc.stdout.end();
          // Write the fragments on separate ticks so each is its own `data` event.
          const fragments = [
            // A newline-terminated line whose first token is split across chunks.
            `newline line: ${ghHalfA}`,
            `${ghHalfB} then ${keyHalfA}`,
            `${keyHalfB}\n`,
            // A trailing line with no newline, split again and flushed on end/close.
            `tail ${keyHalfA}`,
            `${keyHalfB}`,
          ];
          let index = 0;
          const pump = (): void => {
            if (index < fragments.length) {
              proc.stderr.write(fragments[index]);
              index += 1;
              setImmediate(pump);
              return;
            }
            proc.stderr.end();
            setImmediate(() => {
              proc.exitCode = 0;
              proc.emit("close", 0);
            });
          };
          setImmediate(pump);
          return proc as unknown as ChildProcessLike;
        },
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);

      const joined = stderrChunks.join("");
      assert.ok(joined.length > 0, "onLog never received stderr");
      assert.ok(joined.includes("[REDACTED]"), "no redaction marker emitted");
      // No whole secret may survive reassembly.
      assert.ok(!joined.includes(GENERIC_GH), "onLog leaked the whole github token");
      assert.ok(
        !joined.includes(sampleCredential),
        "onLog leaked the whole kiro key"
      );
      // No half-token may leak unredacted either.
      assert.ok(!joined.includes(ghHalfA), "onLog leaked a github token half");
      assert.ok(!joined.includes(keyHalfA), "onLog leaked a kiro key half");
      assert.ok(!joined.includes("ghp_"), "onLog leaked a raw token prefix");
      // Every individual chunk passed to onLog is clean on its own.
      for (const chunk of stderrChunks) {
        assert.ok(!chunk.includes(GENERIC_GH), "a stderr chunk leaked the github token");
        assert.ok(!chunk.includes(sampleCredential), "a stderr chunk leaked the kiro key");
        assert.ok(!chunk.includes("ghp_"), "a stderr chunk leaked the token prefix");
      }
    } finally {
      cleanup();
    }
  });

  it("does not split a secret when evicting a >64KB newline-free stderr stream", async () => {
    const { logPath, cleanup } = tempLogPath("stderr-evict-split");
    try {
      // A dynamically constructed credential so gitleaks never sees a contiguous
      // literal. It must straddle the eviction cut so the old slice-then-redact
      // order split it into two individually-unmatchable halves.
      const secret = ["ghp_", "Q".repeat(30)].join("");
      const stdoutLine = JSON.stringify({
        type: "session",
        model: "claude-sonnet-5.5",
      });
      const stderrChunks: string[] = [];
      const channel = makeChannel({
        logPath,
        kiroApiKey: KIRO_KEY,
        onLog: (stream, text) => {
          if (stream === "stderr") {
            stderrChunks.push(text);
          }
        },
        spawnFn: (command, args, options) => {
          const proc = new MockProcess();
          proc.stdout.write(stdoutLine + "\n");
          proc.stdout.end();
          // One newline-free chunk just over the 64KB cap, with the credential
          // centred on the 128-char-overlap cut the previous implementation used so
          // a naive `slice(cut)` would emit its leading half unredacted.
          const total = 65536 + 64;
          const secretStart = total - 128 - Math.floor(secret.length / 2);
          const payload =
            "x".repeat(secretStart) +
            secret +
            "y".repeat(total - secretStart - secret.length);
          assert.ok(payload.length > 65536);
          setImmediate(() => {
            proc.stderr.write(payload);
            setImmediate(() => {
              proc.stderr.end();
              setImmediate(() => {
                proc.exitCode = 0;
                proc.emit("close", 0);
              });
            });
          });
          return proc as unknown as ChildProcessLike;
        },
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);

      const joined = stderrChunks.join("");
      assert.ok(joined.length > 0, "onLog never received stderr");
      assert.ok(joined.includes("[REDACTED]"), "no redaction marker emitted");
      // Neither the whole credential nor any fragment of it may leak.
      assert.ok(!joined.includes(secret), "onLog leaked the whole credential");
      assert.ok(!joined.includes("ghp_"), "onLog leaked the raw token prefix");
      assert.ok(
        !joined.includes(secret.slice(0, 17)),
        "onLog leaked the leading half of the credential"
      );
      assert.ok(
        !joined.includes(secret.slice(17)),
        "onLog leaked the trailing half of the credential"
      );
      // Every individual chunk passed to onLog is clean on its own too.
      for (const chunk of stderrChunks) {
        assert.ok(!chunk.includes("ghp_"), "a stderr chunk leaked the token prefix");
        assert.ok(!chunk.includes(secret), "a stderr chunk leaked the credential");
      }
    } finally {
      cleanup();
    }
  });

  it("reassembles a multi-byte UTF-8 stdout line split across chunks", async () => {
    const { logPath, cleanup } = tempLogPath("stdout-utf8-split");
    try {
      const sessionLine =
        JSON.stringify({ type: "session", model: "claude-sonnet-5.5" }) + "\n";
      const cjkLine = JSON.stringify({ type: "assistant", text: "你好世界" }) + "\n";
      const cjkBytes = Buffer.from(cjkLine, "utf-8");
      // Split one byte into the first 3-byte CJK character so the sequence is torn
      // across two `data` events.
      const splitAt = cjkBytes.indexOf(Buffer.from("你", "utf-8")) + 1;
      assert.ok(splitAt > 0 && splitAt < cjkBytes.length);

      const channel = makeChannel({
        logPath,
        spawnFn: (command, args, options) => {
          const proc = new MockProcess();
          setImmediate(() => {
            proc.stdout.write(sessionLine);
            setImmediate(() => {
              proc.stdout.write(cjkBytes.subarray(0, splitAt));
              setImmediate(() => {
                proc.stdout.write(cjkBytes.subarray(splitAt));
                setImmediate(() => {
                  proc.stdout.end();
                  setImmediate(() => {
                    proc.exitCode = 0;
                    proc.emit("close", 0);
                  });
                });
              });
            });
          });
          return proc as unknown as ChildProcessLike;
        },
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);
      assert.ok(result.output.includes("你好世界"), `output: ${result.output}`);
      assert.ok(!result.output.includes("\uFFFD"), "output corrupted to U+FFFD");
      assert.ok(
        JSON.stringify(result.records).includes("你好世界"),
        "records lost the multi-byte text"
      );
      assert.ok(
        !JSON.stringify(result.records).includes("\uFFFD"),
        "records corrupted to U+FFFD"
      );
      const written = fs.readFileSync(logPath, "utf-8");
      assert.ok(written.includes("你好世界"), "disk log lost the multi-byte text");
      assert.ok(!written.includes("\uFFFD"), "disk log corrupted to U+FFFD");
    } finally {
      cleanup();
    }
  });
});

describe("HeadlessFallbackChannel output accumulation", () => {
  it("retains both rounds' output across an approval resume", async () => {
    const { logPath, cleanup } = tempLogPath("resume-output");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        s2ResumeSupported: true,
        onApproval: () => "approve",
        spawnFn: makeSpawn(
          (callIndex) =>
            callIndex === 0
              ? {
                  lines: [
                    { type: "session", sessionId: "sess-1", model: "claude-sonnet-5.5" },
                    { type: "approval_request", approvalId: "ap-1", tool: "shell" },
                  ],
                  code: 0,
                }
              : {
                  lines: [
                    { type: "session", sessionId: "sess-1", model: "claude-sonnet-5.5" },
                    { type: "turn_completion", promptTurnSummaries: [{ unit: "credit", value: 3 }] },
                  ],
                  code: 0,
                },
          captured
        ),
      });

      const result = await channel.runTurn({ prompt: "run a command" });

      assert.equal(result.ok, true);
      assert.equal(result.resumed, true);
      assert.equal(captured.calls, 2);
      // Pre-approval round 0 output must not be lost after resuming into round 1.
      assert.ok(
        result.output.includes("approval_request"),
        "round 0 output was dropped"
      );
      assert.ok(
        result.output.includes("turn_completion"),
        "round 1 output was dropped"
      );
      // Rounds are joined by exactly one newline, never a blank line.
      assert.ok(!result.output.includes("\n\n"));
    } finally {
      cleanup();
    }
  });

  it("returns the exact raw output for a single round", async () => {
    const { logPath, cleanup } = tempLogPath("single-output");
    try {
      const lines = [
        { type: "session", model: "claude-sonnet-5.5" },
        { type: "assistant", text: "done" },
      ];
      const expected = lines.map((line) => JSON.stringify(line) + "\n").join("");
      const channel = makeChannel({
        logPath,
        spawnFn: makeSpawn(() => ({ lines, code: 0 }), { calls: 0 }),
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);
      // A non-resumed turn preserves its raw output byte-for-byte.
      assert.equal(result.output, expected);
    } finally {
      cleanup();
    }
  });
});

describe("HeadlessFallbackChannel auto-deny fail-closed", () => {
  it("fails closed when onAskAutoDeny is missing and never spawns", async () => {
    let spawned = false;
    const channel = new HeadlessFallbackChannel({
      runId: "run-1",
      skeletonId: "skel-1",
      kiroHomeDir: "/isolated/kiro-home",
      homeDir: "/isolated/home",
      modelId: "claude-sonnet-5.5",
      agentName: "bonesetter",
      worktreeDir: "/tmp/worktree",
      p1Passed: false,
      p14Passed: true,
      spawnFn: ((() => {
        spawned = true;
        return new MockProcess() as unknown as ChildProcessLike;
      }) as unknown) as SpawnFunction,
    } as unknown as ConstructorParameters<typeof HeadlessFallbackChannel>[0]);

    const result = await channel.runTurn({ prompt: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "failure");
    assert.equal(result.reason, "ask_auto_deny_failed");
    assert.equal(spawned, false);
  });

  it("auto-denies asks DURING live streaming, before the process closes", async () => {
    const { logPath, cleanup } = tempLogPath("ask-streaming");
    try {
      let closed = false;
      const observed: boolean[] = [];
      const channel = makeChannel({
        logPath,
        onAskAutoDeny: () => {
          observed.push(closed);
        },
        spawnFn: (command, args, options) => {
          const proc = new MockProcess();
          setImmediate(() => {
            proc.stdout.write(
              JSON.stringify({ type: "session", model: "claude-sonnet-5.5" }) + "\n"
            );
            proc.stdout.write(
              JSON.stringify({ type: "ask_request", askId: "a-1", text: "q" }) + "\n"
            );
            // Only close AFTER the ask line has been streamed.
            setImmediate(() => {
              proc.stdout.end();
              setImmediate(() => {
                closed = true;
                proc.exitCode = 0;
                proc.emit("close", 0);
              });
            });
          });
          return proc as unknown as ChildProcessLike;
        },
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);
      assert.deepEqual(observed, [false]);
      assert.equal(result.autoDeniedAsks.length, 1);
    } finally {
      cleanup();
    }
  });

  it("kills the child and fails closed when onAskAutoDeny throws", async () => {
    const { logPath, cleanup } = tempLogPath("ask-throw");
    try {
      let killed = false;
      const channel = makeChannel({
        logPath,
        onAskAutoDeny: () => {
          throw new Error("deny boom");
        },
        spawnFn: (command, args, options) => {
          const proc = new MockProcess();
          proc.kill = () => {
            killed = true;
            return true;
          };
          setImmediate(() => {
            proc.stdout.write(
              JSON.stringify({ type: "session", model: "claude-sonnet-5.5" }) + "\n"
            );
            proc.stdout.write(
              JSON.stringify({ type: "ask_request", askId: "a-1", text: "q" }) + "\n"
            );
            // Never closes on its own; the channel must settle on the hook failure.
          });
          return proc as unknown as ChildProcessLike;
        },
      });

      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "failure");
      assert.equal(result.reason, "ask_auto_deny_failed");
      assert.equal(killed, true);
      assert.equal(result.spawnError, "deny boom");
    } finally {
      cleanup();
    }
  });
});


describe("HeadlessFallbackChannel missing-resume-id fail-closed", () => {
  it("refuses to resume when no session id is reported", async () => {
    const { logPath, cleanup } = tempLogPath("missing-resume");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        s2ResumeSupported: true,
        onApproval: () => "approve",
        spawnFn: makeSpawn(
          () => ({
            lines: [
              { type: "session", model: "claude-sonnet-5.5" },
              { type: "approval_request", approvalId: "ap-1", tool: "shell" },
            ],
            code: 0,
          }),
          captured
        ),
      });
      const result = await channel.runTurn({ prompt: "run" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "failure");
      assert.equal(result.reason, "missing_resume_id");
      // No resume process was spawned without --resume-id.
      assert.equal(captured.calls, 1);
    } finally {
      cleanup();
    }
  });
});

describe("HeadlessFallbackChannel returned sessionId redaction", () => {
  it("redacts a credential embedded in the returned sessionId", async () => {
    const { logPath, cleanup } = tempLogPath("session-redact");
    try {
      const leaked = sampleCredential;
      const channel = makeChannel({
        logPath,
        kiroApiKey: leaked,
        spawnFn: makeSpawn(
          () => ({
            lines: [
              {
                type: "session",
                sessionId: `sess-${leaked}-tail`,
                model: "claude-sonnet-5.5",
              },
            ],
            code: 0,
          }),
          { calls: 0 }
        ),
      });
      const result = await channel.runTurn({ prompt: "x" });
      assert.equal(result.ok, true);
      assert.ok(
        !(result.sessionId ?? "").includes(leaked),
        "returned sessionId leaked the credential"
      );
      assert.ok((result.sessionId ?? "").includes("[REDACTED]"));
    } finally {
      cleanup();
    }
  });
});

describe("createStreamDiskLogger symlink containment", () => {
  it("refuses to write through a symlinked log file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-outside-"));
    try {
      const linkPath = path.join(dir, "stream.jsonl");
      fs.symlinkSync(path.join(outside, "target.jsonl"), linkPath);
      const logger = createStreamDiskLogger(linkPath, { trustedBaseDir: dir });
      logger.appendLine('{"type":"log"}');
      assert.equal(logger.ok, false);
      assert.ok(logger.getLastError() instanceof Error);
      logger.close();
      assert.equal(fs.existsSync(path.join(outside, "target.jsonl")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write outside the trusted base through a symlinked subdirectory", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-base-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-escape-"));
    try {
      fs.symlinkSync(outside, path.join(base, "escape"));
      const logPath = path.join(base, "escape", "stream.jsonl");
      const logger = createStreamDiskLogger(logPath, { trustedBaseDir: base });
      logger.appendLine('{"type":"log"}');
      assert.equal(logger.ok, false);
      assert.ok(logger.getLastError() instanceof Error);
      logger.close();
      assert.equal(fs.existsSync(path.join(outside, "stream.jsonl")), false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts a log path whose parent directory name begins with two dots", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-headless-dotdot-"));
    try {
      // `..diagnostics` is a SIBLING of the base's other entries, not a parent
      // escape: a naive `rel.startsWith("..")` check rejected it outright.
      const logPath = path.join(base, "..diagnostics", "stream.jsonl");
      const logger = createStreamDiskLogger(logPath, { trustedBaseDir: base });
      logger.appendLine('{"type":"log"}');
      assert.equal(logger.ok, true);
      assert.equal(logger.getLastError(), null);
      logger.close();
      assert.ok(fs.existsSync(logPath));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

