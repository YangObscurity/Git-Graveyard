// Work package R5-B2b: quarantine records under quarantineDir, agent flags ignored
// Audit items N-5, N-6; continues R5-B2a.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
} from "../../lib/supervisor/skeleton-supervisor";
import { RequiredSettingError } from "../../lib/supervisor/acp-client";
import { CLAUDE_OPUS_5_5_MODEL_ID } from "../../lib/supervisor/model-allowlist";
import type {
  ChildProcessLike,
  SpawnFunction,
} from "../../lib/supervisor/types";
import { getRequiredBrokerSettings } from "./fixtures";

/**
 * Mock ChildProcess for tests so real OS processes are never spawned.
 */
class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 9999;
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalsSent: string[] = [];

  public kill(signal?: NodeJS.Signals | number | string): boolean {
    this.killed = true;
    this.signalsSent.push(String(signal ?? "SIGTERM"));
    return true;
  }
}

/**
 * Simulates an ACP agent speaking JSON-RPC over stdio with a valid planner
 * session so the supervisor raises cleanly.
 */
function attachMockAcpAgent(child: MockChildProcess): void {
  let stdinBuffer = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    stdinBuffer += chunk.toString("utf-8");
    let newlineIndex = stdinBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          respond(JSON.parse(line)).catch(() => {});
        } catch {
          // Ignore malformed lines
        }
      }
      newlineIndex = stdinBuffer.indexOf("\n");
    }
  });

  async function respond(msg: any): Promise<void> {
    if (!msg || typeof msg !== "object" || !("id" in msg)) {
      return;
    }
    const { id, method } = msg;
    let result: unknown;
    if (method === "initialize") {
      result = {
        agentCapabilities: {
          streaming: true,
          _meta: {
            kiro: {
              extensionMethods: ["_session/steer"],
            },
          },
        },
        extensionMethods: ["_session/steer"],
        mcpCapabilities: { http: true },
      };
    } else if (method === "session/new") {
      result = {
        sessionId: "sess-r5b2b-planner",
        modeId: "planner",
        configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
      };
    } else {
      result = { ok: true };
    }
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}

interface QuarantineFixture {
  supervisor: SkeletonSupervisor;
  child: MockChildProcess;
  worktreeDir: string;
  quarantineDir: string;
  baseDir: string;
}

/**
 * Builds a raised supervisor with a real temp worktree and a quarantine
 * directory outside that worktree (both under a temp base directory).
 */
function buildRaisedSupervisor(): QuarantineFixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b2b-"));
  const worktreeDir = path.join(baseDir, "wt");
  const quarantineDir = path.join(baseDir, "quarantine");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "task.md"), "sample task", "utf-8");

  const child = new MockChildProcess();
  attachMockAcpAgent(child);
  const mockSpawn: SpawnFunction = () => child;

  const supervisor = createSkeletonSupervisor({
    runId: "run-r5b2b-quarantine",
    skeletonId: "skel-r5b2b-planner",
    role: "planner",
    cwd: worktreeDir,
    quarantineDir,
    watchdogLimitMs: 5000,
    cancelGracePeriodMs: 5000,
    brokerOptions: getRequiredBrokerSettings(),
    spawnFn: mockSpawn,
  });

  return { supervisor, child, worktreeDir, quarantineDir, baseDir };
}

async function withRaisedFixture(
  run: (fixture: QuarantineFixture) => Promise<void>
): Promise<void> {
  const fixture = buildRaisedSupervisor();
  try {
    await fixture.supervisor.raise();
    await run(fixture);
  } finally {
    await fixture.supervisor.finish();
    fs.rmSync(fixture.baseDir, { recursive: true, force: true });
  }
}

describe("Work package R5-B2b: quarantine record location and agent flag immunity (audit N-5, N-6)", () => {
  describe("Audit N-5: quarantineDir is a required setting", () => {
    it("throws RequiredSettingError when quarantineDir is missing", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-r5b2b-q-missing",
            skeletonId: "skel-r5b2b-q-missing",
            role: "planner",
            cwd: "/tmp/test-r5b2b-q-missing",
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.match((err as Error).message, /quarantineDir/i);
          return true;
        }
      );
    });

    it("throws RequiredSettingError when quarantineDir is an empty string", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-r5b2b-q-empty",
            skeletonId: "skel-r5b2b-q-empty",
            role: "planner",
            cwd: "/tmp/test-r5b2b-q-empty",
            quarantineDir: "",
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.match((err as Error).message, /quarantineDir/i);
          return true;
        }
      );
    });

    it("refuses to start before spawning any Skeleton", () => {
      let spawnCalls = 0;
      const countingSpawn: SpawnFunction = () => {
        spawnCalls++;
        return new MockChildProcess();
      };

      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-r5b2b-q-nospawn",
            skeletonId: "skel-r5b2b-q-nospawn",
            role: "planner",
            cwd: "/tmp/test-r5b2b-q-nospawn",
            watchdogLimitMs: 5000,
            cancelGracePeriodMs: 5000,
            spawnFn: countingSpawn,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          return true;
        }
      );

      assert.equal(spawnCalls, 0, "No Skeleton process may be spawned without quarantineDir");
    });
  });

  describe("Audit N-5: the quarantine record is written under quarantineDir", () => {
    it("writes the record under quarantineDir on a fatal gateway result and writes nothing inside the worktree", async () => {
      await withRaisedFixture(async ({ supervisor, child, worktreeDir, quarantineDir }) => {
        const worktreeBefore = fs.readdirSync(worktreeDir).sort();
        assert.equal(supervisor.isWorktreeQuarantined(), false);

        await supervisor.handleFatalGatewayResult({
          status: "fatal",
          fatal: true,
          code: "CANARY_HIT",
          reason: "canary token detected in worktree",
        });

        assert.equal(supervisor.isWorktreeQuarantined(), true);
        assert.equal(supervisor.getState(), "terminated");
        assert.equal(supervisor.getFailureReason(), "quarantined");
        assert.ok(child.signalsSent.includes("SIGTERM"), "Session process must be terminated");

        // The record lands under quarantineDir and nowhere else
        const recordFiles = fs.readdirSync(quarantineDir).sort();
        assert.equal(recordFiles.length, 1, "Exactly one quarantine record must exist under quarantineDir");
        const record = JSON.parse(
          fs.readFileSync(path.join(quarantineDir, recordFiles[0]), "utf-8")
        );
        assert.equal(record.quarantined, true);
        assert.equal(record.runId, "run-r5b2b-quarantine");
        assert.equal(record.skeletonId, "skel-r5b2b-planner");
        assert.equal(record.reason, "canary token detected in worktree");
        assert.equal(record.code, "CANARY_HIT");

        // Nothing is written inside the worktree (no marker file)
        assert.deepEqual(fs.readdirSync(worktreeDir).sort(), worktreeBefore);
        assert.equal(fs.existsSync(path.join(worktreeDir, ".quarantined")), false);
      });
    });
  });

  describe("Audit N-6: agent-supplied quarantine flags are ignored", () => {
    it("does not quarantine a Skeleton when the agent supplies a quarantine flag or marker", async () => {
      await withRaisedFixture(async ({ supervisor, worktreeDir, quarantineDir }) => {
        // The agent plants its own marker file inside the worktree
        fs.writeFileSync(
          path.join(worktreeDir, ".quarantined"),
          JSON.stringify({ quarantined: true }),
          "utf-8"
        );
        const worktreeAfterAgentMarker = fs.readdirSync(worktreeDir).sort();
        assert.equal(supervisor.getState(), "raised");

        // Agent-supplied flags in tool results and update payloads
        await (supervisor as any).handleUpdate({ toolResult: { quarantine: true } });
        await (supervisor as any).handleUpdate({ toolResult: { fatal: false, quarantine: true } });
        await (supervisor as any).handleUpdate({ result: { status: "quarantined" } });
        await (supervisor as any).handleUpdate({ data: { quarantine: true, quarantined: true } });

        // Agent-supplied flags on gateway results without a fatal marker
        await supervisor.handleGatewayResult({ status: "completed", quarantine: true });
        await supervisor.reportGatewayResult({ quarantine: true, reason: "agent requested quarantine" });

        assert.equal(supervisor.isWorktreeQuarantined(), false, "Agent flag must not quarantine the Skeleton");
        assert.equal(supervisor.getState(), "raised", "Skeleton must stay raised after agent-supplied flags");
        assert.equal(supervisor.getFailureReason(), null);
        assert.deepEqual(fs.readdirSync(quarantineDir), [], "No quarantine record may be written");
        assert.deepEqual(
          fs.readdirSync(worktreeDir).sort(),
          worktreeAfterAgentMarker,
          "Supervisor must not add anything to the worktree"
        );
      });
    });
  });

  describe("Audit N-6: fatal gateway results still quarantine", () => {
    it("quarantines the Skeleton when the gateway reports a fatal result", async () => {
      await withRaisedFixture(async ({ supervisor, child, worktreeDir, quarantineDir }) => {
        await supervisor.handleGatewayResult({
          status: "fatal",
          fatal: true,
          code: "SECRET_DETECTED",
          reason: "secret pattern matched in worktree",
        });

        assert.equal(supervisor.isWorktreeQuarantined(), true);
        assert.equal(supervisor.getState(), "terminated");
        assert.equal(supervisor.getFailureReason(), "quarantined");
        assert.ok(child.signalsSent.includes("SIGTERM"), "Session process must be terminated");

        const recordFiles = fs.readdirSync(quarantineDir).sort();
        assert.equal(recordFiles.length, 1, "Exactly one quarantine record must exist under quarantineDir");
        const record = JSON.parse(
          fs.readFileSync(path.join(quarantineDir, recordFiles[0]), "utf-8")
        );
        assert.equal(record.quarantined, true);
        assert.equal(record.code, "SECRET_DETECTED");

        assert.equal(fs.existsSync(path.join(worktreeDir, ".quarantined")), false);
      });
    });
  });
});
