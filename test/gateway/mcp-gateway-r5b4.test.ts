// Work package R5-B4: the MCP gateway emits "fatal" for fatal tool results.
// Audit item "fatal result, PARTIAL" (after R5-B2b): the supervisor subscribes
// to a "fatal" event on the gateway, but nothing in lib/gateway emitted it.
// These tests drive the real handleToolCall path: a fatal sandbox result must
// emit "fatal" exactly once on the same gateway object, with a payload that
// names the Skeleton and the run and carries the result ({ skeletonId, runId,
// result }, SB1), and the result returned to the caller must be unchanged.

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpGateway } from "../../lib/gateway/mcp-gateway";
import { LogStore } from "../../lib/events/log-store";

/**
 * Builds a gateway fixture: a real McpGateway, a registered Soul-stitcher
 * skeleton bound to a real temp worktree, and a fake runbox whose run
 * optionally drops a file with a secret pattern into the worktree (simulating
 * what a sandboxed command could leave behind, which the post-exec secret
 * scan reports as a fatal result).
 */
interface GatewayFixture {
  gateway: McpGateway;
  bearerToken: string;
  worktreeDir: string;
  baseDir: string;
}

function buildGatewayFixture(dropSecretOnRun: boolean): GatewayFixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b4-gw-"));
  const worktreeDir = path.join(baseDir, "wt");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "task.md"), "sample task", "utf-8");

  const secretFile = path.join(worktreeDir, "leaked.txt");
  const fakeRunbox = {
    run: async () => {
      if (dropSecretOnRun) {
        // AWS access key pattern (AKIA followed by 16 uppercase/digits)
        fs.writeFileSync(secretFile, 'aws_key = "AKIAABCDEFGHIJKLMNOP"\n', "utf-8");
      }
      return {
        exitCode: 0,
        stdoutTail: "executed git status in runbox",
        stderrTail: "",
        timedOut: false,
      };
    },
  };

  const gateway = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    runbox: fakeRunbox as any,
  });

  const skeleton = gateway.registerSkeleton({
    skeletonId: "skel-r5b4-gw",
    role: "Soul-stitcher",
    worktreeRoot: worktreeDir,
    runId: "run-r5b4-gw",
  });

  return {
    gateway,
    bearerToken: skeleton.bearerToken,
    worktreeDir,
    baseDir,
  };
}

function cleanupFixture(baseDir: string): void {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

test("R5-B4: a fatal tool result emits fatal exactly once with that result as payload", async () => {
  const fixture = buildGatewayFixture(true);
  try {
    const emissions: Array<Record<string, unknown>> = [];
    fixture.gateway.on("fatal", (payload: unknown) => {
      emissions.push(payload as Record<string, unknown>);
    });

    const returned = (await fixture.gateway.handleToolCall(
      fixture.bearerToken,
      "sandbox_exec",
      { argv: ["git", "status"], cwd: fixture.worktreeDir }
    )) as { status: string; fatal?: boolean; quarantine?: boolean; code?: string };

    assert.equal(returned.status, "fatal", "The tool result must be fatal");
    assert.equal(returned.fatal, true);
    assert.equal(returned.quarantine, true);
    assert.equal(returned.code, "SECRET_DETECTED");

    assert.equal(
      emissions.length,
      1,
      "Exactly one fatal event must be emitted for one fatal tool result"
    );
    assert.equal(
      emissions[0]["result"],
      returned,
      "The fatal event payload must carry the same result object returned to the caller"
    );
  } finally {
    cleanupFixture(fixture.baseDir);
  }
});

test("R5-B4: a non-fatal tool result emits nothing", async () => {
  const fixture = buildGatewayFixture(false);
  try {
    const emissions: unknown[] = [];
    fixture.gateway.on("fatal", (payload: unknown) => {
      emissions.push(payload);
    });

    const returned = (await fixture.gateway.handleToolCall(
      fixture.bearerToken,
      "sandbox_exec",
      { argv: ["git", "status"], cwd: fixture.worktreeDir }
    )) as { status: string };

    assert.equal(returned.status, "completed", "The clean command must complete");
    assert.equal(
      emissions.length,
      0,
      "A non-fatal tool result must not emit the fatal event"
    );

    // A refused result is also non-fatal and must not emit
    const refused = (await fixture.gateway.handleToolCall(
      fixture.bearerToken,
      "sandbox_exec",
      { argv: ["git", "status"], cwd: "/etc" }
    )) as { status: string };
    assert.equal(refused.status, "refused");
    assert.equal(
      emissions.length,
      0,
      "A refused tool result must not emit the fatal event"
    );
  } finally {
    cleanupFixture(fixture.baseDir);
  }
});

test("R5-B4: the result returned to the caller is unchanged by the emit", async () => {
  const fixture = buildGatewayFixture(true);
  try {
    const emissions: Array<Record<string, unknown>> = [];
    fixture.gateway.on("fatal", (payload: unknown) => {
      emissions.push(payload as Record<string, unknown>);
    });

    const returned = (await fixture.gateway.handleToolCall(
      fixture.bearerToken,
      "sandbox_exec",
      { argv: ["git", "status"], cwd: fixture.worktreeDir }
    )) as Record<string, unknown>;

    assert.equal(emissions.length, 1);
    assert.equal(emissions[0]["result"], returned, "Same object, not a copy");

    // The returned result still carries the full fatal result value
    assert.equal(returned["status"], "fatal");
    assert.equal(returned["fatal"], true);
    assert.equal(returned["quarantine"], true);
    assert.equal(returned["code"], "SECRET_DETECTED");
    assert.equal(
      typeof returned["error"],
      "string",
      "The fatal error message must still be present"
    );
    assert.ok(
      Array.isArray(returned["findings"]) && (returned["findings"] as unknown[]).length > 0,
      "The fatal findings must still be present"
    );
    assert.equal(
      typeof returned["reason"],
      "string",
      "The fatal reason must still be present"
    );
  } finally {
    cleanupFixture(fixture.baseDir);
  }
});

test("R5-B4: the emit lands on the same gateway object a supervisor-style subscriber listens on", async () => {
  // The supervisor subscribes with gateway.on("fatal", handler) on the gateway
  // instance it is given (skeleton-supervisor.ts). This mirrors that wiring:
  // the subscriber registered on this instance must receive the fatal result.
  const fixture = buildGatewayFixture(true);
  try {
    let handlerCalls = 0;
    let lastPayload: Record<string, unknown> | undefined;
    fixture.gateway.on("fatal", (payload: unknown) => {
      handlerCalls++;
      lastPayload = payload as Record<string, unknown>;
    });

    await fixture.gateway.handleToolCall(fixture.bearerToken, "sandbox_exec", {
      argv: ["git", "status"],
      cwd: fixture.worktreeDir,
    });

    assert.equal(handlerCalls, 1);
    assert.ok(lastPayload, "The subscriber must receive the fatal result");
    const payloadResult = lastPayload["result"] as { status: string; fatal?: boolean };
    assert.equal(payloadResult.status, "fatal");
    assert.equal(payloadResult.fatal, true);
  } finally {
    cleanupFixture(fixture.baseDir);
  }
});
