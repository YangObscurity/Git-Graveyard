import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  decide,
  createPermissionBroker,
  decideWatchdogTimeout,
  ConfigurationError,
  RequiredSettingError,
  PermissionBrokerRequest,
} from "../../lib/broker/permission-broker";

// Local constant: the broker no longer exports DEFAULT_BROKER_WATCHDOG_LIMIT_MS (SB6),
// so tests that need a valid limit pass this value explicitly.
const BROKER_WATCHDOG_LIMIT_MS = 5000;

describe("Work package R5-B3b: Permission broker decides only by policy (audit M-2, M-3)", () => {
  describe("Audit M-2: request.evaluator removed from decision", () => {
    it("decides by policy and ignores evaluator attempting to allow a forbidden capability", () => {
      let evaluatorCalled = false;
      const req: PermissionBrokerRequest = {
        role: "Planner",
        capability: "shell",
        target: "rm -rf /",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
        evaluator: () => {
          evaluatorCalled = true;
          return { allowed: true, rule: "evaluator_bypass" };
        },
      };

      const res = decide(req);
      assert.equal(evaluatorCalled, false, "evaluator function must never be called");
      assert.equal(res.outcome.outcome, "selected");
      assert.equal(res.outcome.optionId, "opt-reject");
      assert.equal(res.optionKind, "reject_once");
      assert.equal(res.rule, "forbidden_capability");
    });

    it("decides by policy and ignores evaluator attempting to reject an allowed capability", () => {
      let evaluatorCalled = false;
      const req: PermissionBrokerRequest = {
        role: "Planner",
        capability: "mcp",
        target: "necromancer/ask",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
        evaluator: () => {
          evaluatorCalled = true;
          return { allowed: false, rule: "evaluator_reject" };
        },
      };

      const res = decide(req);
      assert.equal(evaluatorCalled, false, "evaluator function must never be called");
      assert.equal(res.outcome.outcome, "selected");
      assert.equal(res.outcome.optionId, "opt-allow");
      assert.equal(res.optionKind, "allow_once");
      assert.equal(res.rule, "allow_mcp_gateway_tool");
    });

    it("evaluator throwing an error has no effect because it is not invoked", () => {
      const req: PermissionBrokerRequest = {
        role: "Planner",
        capability: "mcp",
        target: "necromancer/ask",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
        evaluator: () => {
          throw new Error("malicious evaluator explosion");
        },
      };

      const res = decide(req);
      assert.equal(res.outcome.outcome, "selected");
      assert.equal(res.outcome.optionId, "opt-allow");
      assert.equal(res.optionKind, "allow_once");
      assert.notEqual(res.rule, "evaluator_error");
      assert.equal(res.rule, "allow_mcp_gateway_tool");
    });

    it("broker instance ignores request.evaluator in handleRequestPermission and decide", async () => {
      const broker = createPermissionBroker({
        role: "Planner",
        cwd: "/configured/workspace",
        watchdogLimitMs: 5000,
      });

      let evaluatorCount = 0;
      const req: PermissionBrokerRequest = {
        capability: "shell",
        target: "echo test",
        options: [
          { optionId: "allow-1", kind: "allow_once" },
          { optionId: "reject-1", kind: "reject_once" },
        ],
        evaluator: () => {
          evaluatorCount++;
          return { allowed: true, rule: "custom_rule" };
        },
      };

      const directRes = broker.decide(req);
      assert.equal(directRes.optionKind, "reject_once");
      assert.equal(directRes.rule, "forbidden_capability");

      const handleRes = await broker.handleRequestPermission(req);
      assert.equal(handleRes.outcome.outcome, "selected");
      assert.equal((handleRes.outcome as any).optionId, "reject-1");
      assert.equal(evaluatorCount, 0, "evaluator must not be called during broker execution");
    });
  });

  describe("Audit M-2: request fields cannot override broker options", () => {
    it("request fields trying to replace role, cwd, additionalDirectories or settings do not change merged request", () => {
      const broker = createPermissionBroker({
        role: "Planner",
        cwd: "/configured/workspace",
        additionalDirectories: ["/configured/extra"],
        settings: { watchdogLimitMs: 4000, customSetting: "from_options" },
        watchdogLimitMs: 4000,
      });

      const maliciousRequest: PermissionBrokerRequest = {
        sessionId: "session-1",
        requestId: "req-1",
        toolCallId: "tc-1",
        capability: "fs_write",
        target: "specs/plan.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
        // Malicious override attempts
        role: "Exhumer",
        cwd: "/evil/cwd",
        additionalDirectories: ["/evil/extra"],
        settings: { customSetting: "forged" } as any,
        watchdogLimitMs: 999999 as any,
      };

      // Direct inspection of mergeRequest
      const merged = broker.mergeRequest(maliciousRequest);
      assert.equal(merged.role, "Planner", "role must come from broker options");
      assert.equal(merged.cwd, "/configured/workspace", "cwd must come from broker options");
      assert.deepEqual(
        merged.additionalDirectories,
        ["/configured/extra"],
        "additionalDirectories must come from broker options"
      );
      assert.equal((merged.settings as any)?.customSetting, "from_options");
      assert.equal(merged.watchdogLimitMs, 4000);

      // Protocol fields are preserved
      assert.equal(merged.sessionId, "session-1");
      assert.equal(merged.requestId, "req-1");
      assert.equal(merged.toolCallId, "tc-1");
      assert.equal(merged.capability, "fs_write");
      assert.equal(merged.target, "specs/plan.md");

      // Evaluation respects broker's role (Planner can write under specs/, Exhumer cannot)
      const res = broker.decide(maliciousRequest);
      assert.equal(res.role, "Planner");
      assert.equal(res.optionKind, "allow_once");
      assert.equal(res.rule, "allow_fs_write_scope");
    });

    it("broker without role does not adopt role from request", () => {
      const broker = createPermissionBroker({
        cwd: "/configured/workspace",
        watchdogLimitMs: 5000,
      });

      const req: PermissionBrokerRequest = {
        role: "Soul-stitcher",
        capability: "fs_write",
        target: "anyfile.txt",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      };

      const merged = broker.mergeRequest(req);
      assert.equal(merged.role, undefined, "request.role must not leak into merged request");

      const res = broker.decide(req);
      assert.equal(res.optionKind, "reject_once");
      assert.equal(res.rule, "reject_fs_write_outside_scope");
    });

    it("broker without cwd does not adopt cwd from request", () => {
      const broker = createPermissionBroker({
        role: "Planner",
        watchdogLimitMs: 5000,
      });

      const req: PermissionBrokerRequest = {
        cwd: "/evil/path",
        capability: "fs_read",
        target: "/evil/path/file.txt",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      };

      const merged = broker.mergeRequest(req);
      assert.equal(merged.cwd, undefined, "request.cwd must not leak into merged request");

      const res = broker.decide(req);
      assert.equal(res.optionKind, "reject_once");
      assert.equal(res.rule, "reject_fs_read_outside_workspace");
    });
  });

  describe("Audit M-3: decideWatchdogTimeout without explicit limit throws required-setting error", () => {
    it("decideWatchdogTimeout throws RequiredSettingError when watchdogLimitMs is omitted", () => {
      const req: PermissionBrokerRequest = {
        role: "Planner",
        options: [{ optionId: "rej-1", kind: "reject_once" }],
      };

      assert.throws(
        () => (decideWatchdogTimeout as any)(req),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.ok(err instanceof ConfigurationError, "Must be an instance of ConfigurationError");
          return true;
        }
      );
    });

    it("decideWatchdogTimeout throws RequiredSettingError for undefined, null, zero, negative, or non-finite limits", () => {
      const req: PermissionBrokerRequest = {
        role: "Planner",
        options: [{ optionId: "rej-1", kind: "reject_once" }],
      };

      const invalidLimits = [undefined, null, 0, -1, -5000, NaN, Infinity, -Infinity, "5000" as any];
      for (const badLimit of invalidLimits) {
        assert.throws(
          () => decideWatchdogTimeout(req, badLimit as any),
          (err: unknown) => {
            assert.ok(
              err instanceof RequiredSettingError,
              `Expected bad limit ${String(badLimit)} to throw RequiredSettingError`
            );
            assert.ok(err instanceof ConfigurationError);
            return true;
          }
        );
      }
    });

    it("decideWatchdogTimeout succeeds when explicit positive limit is passed", () => {
      const req: PermissionBrokerRequest = {
        role: "Planner",
        options: [
          { optionId: "allow-1", kind: "allow_once" },
          { optionId: "rej-1", kind: "reject_once" },
        ],
      };

      const res = decideWatchdogTimeout(req, BROKER_WATCHDOG_LIMIT_MS);
      assert.equal(res.outcome.outcome, "selected");
      assert.equal(res.outcome.optionId, "rej-1");
      assert.equal(res.optionKind, "reject_once");
      assert.equal(res.rule, "broker_watchdog_timeout");
    });

    it("broker has no default watchdog limit: constructing it without a watchdogLimitMs setting throws a required-setting error", () => {
      assert.throws(
        () => createPermissionBroker({}),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.ok(err instanceof ConfigurationError, "Must be an instance of ConfigurationError");
          return true;
        }
      );

      // Verify that calling decideWatchdogTimeout without limit does NOT fall back to any default
      const req: PermissionBrokerRequest = {
        role: "Planner",
        options: [{ optionId: "rej-1", kind: "reject_once" }],
      };
      assert.throws(() => (decideWatchdogTimeout as any)(req), RequiredSettingError);
    });

    it("resolveWatchdogLimit does not fall back to silent default", () => {
      const broker = createPermissionBroker({
        watchdogLimitMs: 3500,
      });
      assert.equal(broker.resolveWatchdogLimit(), 3500);

      // Request cannot override configured limit
      assert.equal(broker.resolveWatchdogLimit({ watchdogLimitMs: 99999 }), 3500);
    });
  });
});
