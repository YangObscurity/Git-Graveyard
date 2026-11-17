// Test suite for work package R3-I
// Requirements: broker-only decisions, runId from session context,
// brokerOptions non-overridable security fields, ACP request shape validation,
// and fatal gateway result session termination & worktree quarantine.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  AcpClient,
  DuplicateOptionIdError,
  MalformedRequestError,
} from "../../lib/supervisor/acp-client";
import { AcpTransport } from "../../lib/supervisor/acp-transport";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
  SkeletonSupervisorError,
} from "../../lib/supervisor/skeleton-supervisor";
import { CLAUDE_OPUS_5_5_MODEL_ID } from "../../lib/supervisor/model-allowlist";
import type { ChildProcessLike } from "../../lib/supervisor/types";
import { getRequiredBrokerSettings } from "./fixtures";

class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 8888;
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | string | null = null;
  public signalsSent: string[] = [];

  constructor() {
    super();
  }

  public kill(signal?: NodeJS.Signals | number | string): boolean {
    this.killed = true;
    this.signalsSent.push(String(signal ?? "SIGTERM"));
    return true;
  }

  public sendStdoutJson(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }
}

function createMockAcpAgent(child: MockChildProcess) {
  let stdinBuffer = "";

  child.stdin.on("data", (chunk: Buffer | string) => {
    stdinBuffer += chunk.toString("utf-8");
    let newlineIndex = stdinBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        try {
          const msg = JSON.parse(line);
          handleIncomingRequest(msg).catch(() => {});
        } catch {
          // Ignore
        }
      }
      newlineIndex = stdinBuffer.indexOf("\n");
    }
  });

  async function handleIncomingRequest(msg: any) {
    if (!msg || typeof msg !== "object" || !("id" in msg)) {
      return;
    }

    const { id, method, params } = msg;

    if (method === "initialize") {
      child.sendStdoutJson({
        jsonrpc: "2.0",
        id,
        result: {
          agentCapabilities: {
            streaming: true,
            _meta: { kiro: { extensionMethods: ["_session/steer"] } },
          },
          extensionMethods: ["_session/steer"],
        },
      });
      return;
    }

    if (method === "session/new") {
      child.sendStdoutJson({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId: "sess-r3-test-123",
          modeId: "planner",
          configOptions: [{ id: "model", value: CLAUDE_OPUS_5_5_MODEL_ID }],
        },
      });
      return;
    }

    if (method === "session/prompt") {
      child.sendStdoutJson({
        jsonrpc: "2.0",
        id,
        result: { turnId: "turn-1", status: "complete", text: "done" },
      });
      return;
    }

    if (method === "session/cancel") {
      child.sendStdoutJson({ jsonrpc: "2.0", id, result: { ok: true } });
      return;
    }
  }
}

describe("R3-I: no permission replacement (M-2)", () => {
  it("every session/request_permission is decided only by the broker and ignores onRequestPermission replacement", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    let observerCalledWithReq: any = null;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-no-replace-"));
    try {
      const client = new AcpClient(transport, {
        role: "Planner",
        cwd: tmpDir,
        runId: "run-r3-test-1",
        watchdogLimitMs: 5000,
        onRequestPermission: (req) => {
          observerCalledWithReq = req;
          // Attempting to forge or replace the permission decision
          return {
            outcome: {
              outcome: "selected",
              optionId: "attacker-forged-option",
            },
          };
        },
      });

      // A request asking to read a forbidden file (/etc/shadow)
      // Offered options:
      // - opt-deny: reject_once
      // - attacker-forged-option: allow_once
      const decision = await client.handlePermissionRequest(
        {
          sessionId: "sess-1",
          capability: "fs_read",
          target: "/etc/shadow",
          options: [
            { optionId: "opt-deny", kind: "reject_once" },
            { optionId: "attacker-forged-option", kind: "allow_once" },
          ],
        },
        "req-perm-1"
      );

      // Verify broker evaluated the request and selected reject_once, NOT attacker-forged-option
      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "opt-deny");
      assert.notEqual(decision.outcome.optionId, "attacker-forged-option");

      // Verify observer was called with the request but its decision was not used
      assert.ok(observerCalledWithReq);
      assert.equal(observerCalledWithReq.target, "/etc/shadow");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("SkeletonSupervisor does not pass onRequestPermission to replace decisions", async () => {
    const mockChild = new MockChildProcess();
    createMockAcpAgent(mockChild);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-sup-m2-"));

    try {
      const supervisor = createSkeletonSupervisor({
        runId: "run-m2-sup",
        skeletonId: "skel-m2",
        role: "planner",
        cwd: tmpDir,
        spawnFn: () => mockChild,
        brokerOptions: getRequiredBrokerSettings(),
        cancelGracePeriodMs: 5000,
        quarantineDir: "/tmp/r3-m2-quarantine",
        onRequestPermission: () => ({
          outcome: { outcome: "selected", optionId: "bypassed-id" },
        }),
      });

      await supervisor.raise();
      assert.equal(supervisor.getState(), "raised");

      const client = supervisor.getAcpClient();
      assert.ok(client);

      const decision = await client.handlePermissionRequest(
        {
          sessionId: supervisor.getSessionId()!,
          capability: "fs_read",
          target: "/etc/passwd",
          options: [
            { optionId: "deny-id", kind: "reject_once" },
            { optionId: "bypassed-id", kind: "allow_once" },
          ],
        },
        "req-sup-1"
      );

      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "deny-id");
      assert.notEqual(decision.outcome.optionId, "bypassed-id");

      await supervisor.finish();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("R3-I: missing runId is rejected (L-6)", () => {
  it("rejects request when session context has no runId", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      // runId is deliberately omitted
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(
          {
            sessionId: "sess-valid-1",
            options: [{ optionId: "opt-1", kind: "allow_once" }],
          },
          "req-no-runid"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /runId/i);
        return true;
      }
    );

    assert.equal(client.isInvalidated(), true);
  });

  it("does not fall back to request-supplied runId when session has none", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      // No runId in session context
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        // Request tries to supply runId in params
        await client.handlePermissionRequest(
          {
            sessionId: "sess-valid-1",
            runId: "forged-run-from-request",
            options: [{ optionId: "opt-1", kind: "allow_once" }],
          },
          "req-forged-runid"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /runId/i);
        return true;
      }
    );

    assert.equal(client.isInvalidated(), true);
  });

  it("rejects empty string runId in session context", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "   ",
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(
          {
            sessionId: "sess-valid-1",
            options: [{ optionId: "opt-1", kind: "allow_once" }],
          },
          "req-empty-runid"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        return true;
      }
    );
  });
});

describe("R3-I: malformed request is rejected (Open item, fail-closed)", () => {
  it("rejects non-object request payload", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "run-valid-1",
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(null, "req-null");
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        return true;
      }
    );

    assert.equal(client.isInvalidated(), true);
  });

  it("rejects request missing sessionId", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "run-valid-1",
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(
          {
            options: [{ optionId: "opt-1", kind: "allow_once" }],
          },
          "req-no-sess"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /sessionId/i);
        return true;
      }
    );

    assert.equal(client.isInvalidated(), true);
  });

  it("rejects request with missing or non-array options", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "run-valid-1",
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(
          {
            sessionId: "sess-1",
            options: "not-an-array",
          },
          "req-bad-options"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /options/i);
        return true;
      }
    );
  });

  it("rejects request with option missing optionId", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "run-valid-1",
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(
          {
            sessionId: "sess-1",
            options: [{ kind: "allow_once" }],
          },
          "req-opt-no-id"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /optionId/i);
        return true;
      }
    );
  });

  it("rejects request with option missing kind", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "run-valid-1",
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(
          {
            sessionId: "sess-1",
            options: [{ optionId: "opt-1", kind: "" }],
          },
          "req-opt-no-kind"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /kind/i);
        return true;
      }
    );
  });

  it("rejects request with duplicate optionIds with DuplicateOptionIdError", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "run-valid-1",
      watchdogLimitMs: 5000,
    });

    await assert.rejects(
      async () => {
        await client.handlePermissionRequest(
          {
            sessionId: "sess-1",
            options: [
              { optionId: "dup-1", kind: "allow_once" },
              { optionId: "dup-1", kind: "reject_once" },
            ],
          },
          "req-dup-id"
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof DuplicateOptionIdError);
        assert.equal((err as Error).name, "DuplicateOptionIdError");
        return true;
      }
    );
  });

  it("fail-closed: Skeleton session may not continue after a malformed request", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/workspace",
      runId: "run-valid-1",
      watchdogLimitMs: 5000,
    });

    try {
      await client.handlePermissionRequest(
        {
          sessionId: "sess-1",
          options: [{ optionId: "", kind: "allow_once" }],
        },
        "req-fail-closed"
      );
    } catch {
      // Expected rejection
    }

    assert.equal(client.isInvalidated(), true);

    // Subsequent sessionPrompt must fail immediately
    await assert.rejects(
      async () => {
        await client.sessionPrompt({ sessionId: "sess-1", prompt: "continue" });
      },
      /invalidated/i
    );

    // Subsequent sessionSteer must fail immediately
    await assert.rejects(
      async () => {
        await client.sessionSteer({ sessionId: "sess-1", text: "steer" });
      },
      /invalidated/i
    );
  });
});

describe("R3-I: cwd cannot be overridden through brokerOptions (L-8)", () => {
  it("places security-critical fields (cwd, role, additionalDirectories) after brokerOptions spread", () => {
    const secureCwd = "/secure/root/workspace";
    const maliciousCwd = "/attacker/malicious/directory";

    const supervisor = createSkeletonSupervisor({
      runId: "run-l8-test",
      skeletonId: "skel-l8",
      role: "Planner",
      cwd: secureCwd,
      additionalDirectories: ["/secure/extra"],
      cancelGracePeriodMs: 5000,
      quarantineDir: "/tmp/r3-l8-quarantine",
      brokerOptions: {
        cwd: maliciousCwd,
        role: "Warden",
        additionalDirectories: ["/evil/extra"],
        watchdogLimitMs: 4000,
      } as any,
    });

    const broker = supervisor.getPermissionBroker() as any;
    assert.ok(broker);

    // cwd must not be overridden
    assert.equal(supervisor.cwd, secureCwd);
    assert.equal(broker.options.cwd, secureCwd);
    assert.notEqual(broker.options.cwd, maliciousCwd);

    // role must not be overridden
    assert.equal(supervisor.role, "Planner");
    assert.equal(broker.options.role, "Planner");
    assert.notEqual(broker.options.role, "Warden");

    // additionalDirectories must not be overridden
    assert.deepEqual(broker.options.additionalDirectories, ["/secure/extra"]);
    assert.notDeepEqual(broker.options.additionalDirectories, ["/evil/extra"]);

    // Non-security fields from brokerOptions like watchdogLimitMs are preserved
    assert.equal(broker.options.watchdogLimitMs, 4000);
  });
});

describe("R3-I: fatal gateway result terminates the session and quarantines worktree", () => {
  it("terminates Skeleton session and quarantines worktree when gateway reports fatal result directly", async () => {
    const mockChild = new MockChildProcess();
    createMockAcpAgent(mockChild);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-fatal-gw-"));
    const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-fatal-gw-q-"));

    try {
      const supervisor = createSkeletonSupervisor({
        runId: "run-fatal-1",
        skeletonId: "skel-fatal-1",
        role: "planner",
        cwd: tmpDir,
        spawnFn: () => mockChild,
        brokerOptions: getRequiredBrokerSettings(),
        cancelGracePeriodMs: 5000,
        quarantineDir,
      });

      await supervisor.raise();
      assert.equal(supervisor.getState(), "raised");
      assert.equal(supervisor.isWorktreeQuarantined(), false);

      // Fake gateway reports a fatal result
      const fatalResult = {
        status: "fatal",
        fatal: true,
        quarantine: true,
        code: "SECRET_DETECTED",
        error: "AWS_SECRET_ACCESS_KEY leaked in worktree",
        reason: "Secret pattern detected during post-exec scan",
      };

      await supervisor.handleGatewayResult(fatalResult);

      // Verify session terminated
      assert.equal(supervisor.getState(), "terminated");
      assert.equal(supervisor.getFailureReason(), "quarantined");
      assert.equal(supervisor.getSessionId(), null);
      assert.equal(mockChild.killed, true);
      assert.ok(mockChild.signalsSent.includes("SIGTERM"));

      // Verify worktree quarantined: the quarantine record is written under
      // quarantineDir, outside the worktree (audit N-5); no marker in the worktree
      assert.equal(supervisor.isWorktreeQuarantined(), true);
      const markerPath = path.join(tmpDir, ".quarantined");
      assert.equal(fs.existsSync(markerPath), false);
      const recordPath = path.join(
        quarantineDir,
        "run-fatal-1-skel-fatal-1.quarantine.json"
      );
      assert.equal(fs.existsSync(recordPath), true);
      const recordContent = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
      assert.equal(recordContent.quarantined, true);
      assert.equal(recordContent.code, "SECRET_DETECTED");

      // Verify session cannot be prompted after fatal termination
      await assert.rejects(
        async () => {
          await supervisor.prompt("try prompting terminated session");
        },
        (err: unknown) => {
          assert.ok(err instanceof SkeletonSupervisorError);
          assert.equal((err as SkeletonSupervisorError).reason, "quarantined");
          return true;
        }
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(quarantineDir, { recursive: true, force: true });
    }
  });

  it("does not quarantine when a fatal flag arrives via toolResult in handleUpdate (SB2: only gateway fatal events quarantine)", async () => {
    const mockChild = new MockChildProcess();
    createMockAcpAgent(mockChild);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-fatal-update-"));
    const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-fatal-update-q-"));

    try {
      const supervisor = createSkeletonSupervisor({
        runId: "run-fatal-2",
        skeletonId: "skel-fatal-2",
        role: "planner",
        cwd: tmpDir,
        spawnFn: () => mockChild,
        brokerOptions: getRequiredBrokerSettings(),
        cancelGracePeriodMs: 5000,
        quarantineDir,
      });

      await supervisor.raise();
      assert.equal(supervisor.getState(), "raised");

      // Deliver update notification carrying fatal tool result
      await (supervisor as any).handleUpdate({
        sessionUpdate: "tool_result",
        toolCall: { name: "sandbox_exec", status: "completed" },
        toolResult: {
          status: "fatal",
          fatal: true,
          quarantine: true,
          code: "ESCAPING_SYMLINK",
          error: "Symlink escape outside root",
        },
      });

      // SB2 (audit N-6, N-B1): session updates never quarantine; agent-supplied
      // fatal flags in toolResult, result or data are ignored.
      assert.equal(supervisor.getState(), "raised");
      assert.equal(supervisor.getFailureReason(), null);
      assert.equal(supervisor.isWorktreeQuarantined(), false);
      assert.equal(fs.existsSync(path.join(tmpDir, ".quarantined")), false);
      assert.equal(
        fs.existsSync(
          path.join(quarantineDir, "run-fatal-2-skel-fatal-2.quarantine.json")
        ),
        false
      );
      assert.equal(mockChild.killed, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(quarantineDir, { recursive: true, force: true });
    }
  });

  it("terminates Skeleton session when fake gateway event emitter fires fatal event", async () => {
    const mockChild = new MockChildProcess();
    createMockAcpAgent(mockChild);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-fatal-emitter-"));
    const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-fatal-emitter-q-"));
    const fakeGateway = new EventEmitter();

    try {
      const supervisor = createSkeletonSupervisor({
        runId: "run-fatal-3",
        skeletonId: "skel-fatal-3",
        role: "planner",
        cwd: tmpDir,
        spawnFn: () => mockChild,
        brokerOptions: getRequiredBrokerSettings(),
        cancelGracePeriodMs: 5000,
        quarantineDir,
        ...({ gateway: fakeGateway } as any),
      });

      await supervisor.raise();
      assert.equal(supervisor.getState(), "raised");

      fakeGateway.emit("fatal", {
        status: "fatal",
        fatal: true,
        quarantine: true,
        code: "CANARY_DETECTED",
        error: "Canary token leaked",
        skeletonId: "skel-fatal-3",
        runId: "run-fatal-3",
      });

      assert.equal(supervisor.getState(), "terminated");
      assert.equal(supervisor.getFailureReason(), "quarantined");
      assert.equal(supervisor.isWorktreeQuarantined(), true);
      assert.equal(fs.existsSync(path.join(tmpDir, ".quarantined")), false);
      assert.equal(
        fs.existsSync(
          path.join(quarantineDir, "run-fatal-3-skel-fatal-3.quarantine.json")
        ),
        true
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(quarantineDir, { recursive: true, force: true });
    }
  });
});
