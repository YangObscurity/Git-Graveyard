// Test suite for work package R5-B1
// Audit M-2 and N-3 remediation:
// 1. permissionBroker option has no effect (constructor always creates its own broker).
// 2. Missing or non-positive-integer watchdog limit throws RequiredSettingError and creates nothing.
// 3. Observer onRequestPermission receives a deep, frozen plain-data copy;
//    a mutation attempt on the copy leaves the broker decision unchanged.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  AcpClient,
  RequiredSettingError,
  deepFreezePlainData,
} from "../../lib/supervisor/acp-client";
import { AcpTransport } from "../../lib/supervisor/acp-transport";
import type { ChildProcessLike } from "../../lib/supervisor/types";

class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 8999;
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

describe("R5-B1 (1): permissionBroker option has no effect", () => {
  it("constructor always creates broker and ignores caller-injected permissionBroker", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b1-broker-opt-"));

    try {
      let fakeBrokerInvoked = false;
      const fakeBroker = {
        handleRequestPermission: async () => {
          fakeBrokerInvoked = true;
          return {
            outcome: {
              outcome: "selected" as const,
              optionId: "fake-allowed-id",
            },
          };
        },
      };

      // Pass fakeBroker in options (cast as any since option is removed from type)
      const client = new AcpClient(transport, {
        role: "Planner",
        cwd: tmpDir,
        runId: "run-r5b1-broker-1",
        watchdogLimitMs: 5000,
        permissionBroker: fakeBroker,
      } as any);

      // Verify the client's internal broker is NOT the injected fakeBroker
      assert.notEqual((client as any).permissionBroker, fakeBroker);

      // Request access to forbidden file
      const decision = await client.handlePermissionRequest(
        {
          sessionId: "sess-r5b1-1",
          capability: "fs_read",
          target: "/etc/shadow",
          options: [
            { optionId: "opt-deny", kind: "reject_once" },
            { optionId: "fake-allowed-id", kind: "allow_once" },
          ],
        },
        "req-r5b1-1"
      );

      // The fake broker was not invoked; the genuine broker decided reject_once
      assert.equal(fakeBrokerInvoked, false);
      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "opt-deny");
      assert.notEqual(decision.outcome.optionId, "fake-allowed-id");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("R5-B1 (2): missing or invalid watchdog limit throws RequiredSettingError", () => {
  it("throws RequiredSettingError when watchdogLimitMs is omitted and creates nothing", () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    assert.throws(
      () => new AcpClient(transport, {}),
      (err: unknown) => {
        assert.ok(err instanceof RequiredSettingError);
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /watchdogLimitMs/i);
        return true;
      }
    );

    assert.throws(
      () => new AcpClient(transport, { role: "Planner", cwd: "/tmp" }),
      (err: unknown) => {
        assert.ok(err instanceof RequiredSettingError);
        return true;
      }
    );
  });

  it("throws RequiredSettingError when watchdog limit is non-positive or non-integer in options", () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const invalidValues = [0, -1, -5000, NaN, Infinity, -Infinity, 1.5, 5000.5, "5000" as any, null as any];

    for (const badVal of invalidValues) {
      assert.throws(
        () =>
          new AcpClient(transport, {
            role: "Planner",
            cwd: "/tmp",
            watchdogLimitMs: badVal,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          return true;
        },
        `Expected bad watchdog value ${String(badVal)} in options to throw RequiredSettingError`
      );
    }
  });

  it("throws RequiredSettingError when watchdog limit is non-positive or non-integer in settings", () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const invalidValues = [0, -1, -5000, NaN, Infinity, -Infinity, 2.7, "5000" as any];

    for (const badVal of invalidValues) {
      assert.throws(
        () =>
          new AcpClient(transport, {
            role: "Planner",
            cwd: "/tmp",
            settings: { watchdogLimitMs: badVal },
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          return true;
        },
        `Expected bad watchdog value ${String(badVal)} in settings to throw RequiredSettingError`
      );
    }
  });

  it("accepts positive integer watchdog limit from options.watchdogLimitMs", () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/tmp",
      watchdogLimitMs: 4000,
    });
    assert.ok(client);
  });

  it("accepts positive integer watchdog limit from settings.watchdogLimitMs", () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/tmp",
      settings: { watchdogLimitMs: 3500 },
    });
    assert.ok(client);
  });

  it("prioritizes options.watchdogLimitMs over settings.watchdogLimitMs when both valid", () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);

    const client = new AcpClient(transport, {
      role: "Planner",
      cwd: "/tmp",
      watchdogLimitMs: 6000,
      settings: { watchdogLimitMs: 3000 },
    });
    assert.ok(client);
    assert.equal(((client as any).permissionBroker as any).watchdogLimitMs, 6000);
  });
});

describe("R5-B1 (3): observer receives deep frozen plain-data copy; mutation leaves broker decision unchanged", () => {
  it("observer callback receives deeply frozen copy and mutation attempts cannot alter broker decision", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b1-obs-mut-"));

    try {
      let observerReceivedRequest: any = null;
      let targetMutationThrew = false;
      let optionMutationThrew = false;
      let pushMutationThrew = false;

      const client = new AcpClient(transport, {
        role: "Planner",
        cwd: tmpDir,
        runId: "run-r5b1-obs-1",
        watchdogLimitMs: 5000,
        onRequestPermission: (req) => {
          observerReceivedRequest = req;

          // 1. Verify deep freeze on root and nested structures
          assert.ok(req.options, "options must be defined");
          assert.ok(Object.isFrozen(req), "root request must be frozen");
          assert.ok(Object.isFrozen(req.options), "options array must be frozen");
          assert.ok(Object.isFrozen(req.options[0]), "option element must be frozen");
          assert.ok(Object.isFrozen(req.options[1]), "option element must be frozen");

          // 2. Mutation attempt: mutate target on the copy
          try {
            (req as any).target = path.join(tmpDir, "innocent-file.txt");
          } catch {
            targetMutationThrew = true;
          }

          // 3. Mutation attempt: mutate kind on options[0]
          try {
            (req.options[0] as any).kind = "allow_once";
          } catch {
            optionMutationThrew = true;
          }

          // 4. Mutation attempt: push new option to array
          try {
            (req.options as any).push({ optionId: "injected", kind: "allow_once" });
          } catch {
            pushMutationThrew = true;
          }

          // 5. Attempt to forge decision via return value
          return {
            outcome: {
              outcome: "selected" as const,
              optionId: "opt-forged-allow",
            },
          };
        },
      });

      const decision = await client.handlePermissionRequest(
        {
          sessionId: "sess-obs-test-1",
          capability: "fs_read",
          target: "/etc/shadow",
          options: [
            { optionId: "opt-deny", kind: "reject_once" },
            { optionId: "opt-forged-allow", kind: "allow_once" },
          ],
        },
        "req-obs-1"
      );

      // Verify that mutating frozen copy threw TypeErrors
      assert.equal(targetMutationThrew, true, "attempt to mutate target should throw on frozen copy");
      assert.equal(optionMutationThrew, true, "attempt to mutate option.kind should throw on frozen copy");
      assert.equal(pushMutationThrew, true, "attempt to push to options should throw on frozen copy");

      // Verify observer received original values
      assert.ok(observerReceivedRequest);
      assert.equal(observerReceivedRequest.target, "/etc/shadow");
      assert.equal(observerReceivedRequest.options[0].kind, "reject_once");

      // Verify genuine broker made decision on unmutated brokerRequest
      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "opt-deny");
      assert.notEqual(decision.outcome.optionId, "opt-forged-allow");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("observer copy strips functions and preserves plain data only", async () => {
    const mockChild = new MockChildProcess();
    const transport = new AcpTransport(mockChild);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b1-obs-plain-"));

    try {
      let observerReceivedRequest: any = null;

      const client = new AcpClient(transport, {
        role: "Planner",
        cwd: tmpDir,
        runId: "run-r5b1-plain-1",
        watchdogLimitMs: 5000,
        onRequestPermission: (req) => {
          observerReceivedRequest = req;
          return {
            outcome: { outcome: "selected" as const, optionId: "opt-1" },
          };
        },
      });

      await client.handlePermissionRequest(
        {
          sessionId: "sess-plain-1",
          capability: "fs_read",
          target: "/etc/passwd",
          rawInput: {
            field: "valid-value",
            nested: {
              active: true,
              maliciousFn: () => "evil",
            },
            fnArray: [1, 2, () => "evil"],
          },
          options: [
            { optionId: "opt-1", kind: "reject_once" },
          ],
        },
        "req-plain-1"
      );

      assert.ok(observerReceivedRequest);
      assert.equal(observerReceivedRequest.rawInput.field, "valid-value");
      assert.equal(observerReceivedRequest.rawInput.nested.active, true);
      assert.equal(observerReceivedRequest.rawInput.nested.maliciousFn, undefined);
      assert.deepEqual(observerReceivedRequest.rawInput.fnArray, [1, 2]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deepFreezePlainData helper handles primitives, arrays, objects, and circular structures", () => {
    assert.equal(deepFreezePlainData(42), 42);
    assert.equal(deepFreezePlainData("hello"), "hello");
    assert.equal(deepFreezePlainData(null), null);
    assert.equal(deepFreezePlainData(undefined), undefined);
    assert.equal(deepFreezePlainData(() => {}), undefined);

    const obj: any = { a: 1, b: [2, 3], c: { d: "nested" } };
    const frozen = deepFreezePlainData(obj);
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.b));
    assert.ok(Object.isFrozen(frozen.c));

    // Circular reference
    const circular: any = { name: "circ" };
    circular.self = circular;
    const frozenCirc = deepFreezePlainData(circular);
    assert.ok(Object.isFrozen(frozenCirc));
    assert.equal(frozenCirc.self, frozenCirc);
  });
});
