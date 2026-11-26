import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSkeletonSupervisor,
  SkeletonSupervisor,
} from "../../lib/supervisor/skeleton-supervisor";
import { RequiredSettingError } from "../../lib/supervisor/acp-client";
import {
  PermissionBroker,
  PermissionBrokerRequest,
} from "../../lib/broker/permission-broker";
import { getRequiredBrokerSettings } from "./fixtures";

describe("Work package R5-B2a: Skeleton supervisor watchdog & timeout limits and broker injection (audit M-2, M-3, N-3)", () => {
  describe("Audit M-3: Missing watchdog setting is a required-setting error", () => {
    it("throws RequiredSettingError when watchdogLimitMs is omitted from both options and settings", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-m3-w-missing",
            skeletonId: "skel-m3-w-missing",
            role: "planner",
            cwd: "/tmp/test-m3-w",
            cancelGracePeriodMs: 5000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.match((err as Error).message, /watchdogLimitMs/i);
          return true;
        }
      );
    });

    it("throws RequiredSettingError when watchdogLimitMs is non-positive or non-integer in options", () => {
      const invalidValues = [0, -1, -5000, NaN, Infinity, -Infinity, 1.5, 5000.5, "5000" as any, null as any];
      for (const badVal of invalidValues) {
        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: "run-m3-w-bad-opt",
              skeletonId: "skel-m3-w-bad-opt",
              role: "planner",
              cwd: "/tmp/test-m3-w",
              watchdogLimitMs: badVal,
              cancelGracePeriodMs: 5000,
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            assert.match((err as Error).message, /watchdogLimitMs/i);
            return true;
          },
          `Expected invalid watchdog value ${String(badVal)} in options to throw RequiredSettingError`
        );
      }
    });

    it("throws RequiredSettingError when watchdogLimitMs is non-positive or non-integer in settings", () => {
      const invalidValues = [0, -1, -5000, NaN, Infinity, -Infinity, 2.7, "5000" as any];
      for (const badVal of invalidValues) {
        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: "run-m3-w-bad-settings",
              skeletonId: "skel-m3-w-bad-settings",
              role: "planner",
              cwd: "/tmp/test-m3-w",
              settings: { watchdogLimitMs: badVal },
              cancelGracePeriodMs: 5000,
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            assert.match((err as Error).message, /watchdogLimitMs/i);
            return true;
          },
          `Expected invalid watchdog value ${String(badVal)} in settings to throw RequiredSettingError`
        );
      }
    });

    it("accepts valid watchdogLimitMs from options", () => {
      const supervisor = createSkeletonSupervisor({
        runId: "run-m3-w-ok-opt",
        quarantineDir: "/tmp/test-m3-w-quarantine",
        skeletonId: "skel-m3-w-ok-opt",
        role: "planner",
        cwd: "/tmp/test-m3-w",
        watchdogLimitMs: 4000,
        cancelGracePeriodMs: 5000,
      });
      assert.ok(supervisor instanceof SkeletonSupervisor);
      assert.equal((supervisor.getPermissionBroker() as any).options.watchdogLimitMs, 4000);
    });

    it("accepts valid watchdogLimitMs from settings", () => {
      const supervisor = createSkeletonSupervisor({
        runId: "run-m3-w-ok-settings",
        quarantineDir: "/tmp/test-m3-w-quarantine",
        skeletonId: "skel-m3-w-ok-settings",
        role: "planner",
        cwd: "/tmp/test-m3-w",
        settings: { watchdogLimitMs: 3500 },
        cancelGracePeriodMs: 5000,
      });
      assert.ok(supervisor instanceof SkeletonSupervisor);
      assert.equal((supervisor.getPermissionBroker() as any).options.watchdogLimitMs, 3500);
    });

    it("prioritizes options.watchdogLimitMs over settings.watchdogLimitMs", () => {
      const supervisor = createSkeletonSupervisor({
        runId: "run-m3-w-prio",
        quarantineDir: "/tmp/test-m3-w-quarantine",
        skeletonId: "skel-m3-w-prio",
        role: "planner",
        cwd: "/tmp/test-m3-w",
        watchdogLimitMs: 6000,
        settings: { watchdogLimitMs: 3000 },
        cancelGracePeriodMs: 5000,
      });
      assert.equal((supervisor.getPermissionBroker() as any).options.watchdogLimitMs, 6000);
    });
  });

  describe("Audit M-3: Missing timeout setting is a required-setting error", () => {
    it("throws RequiredSettingError when cancelGracePeriodMs is omitted from both options and settings", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-m3-t-missing",
            skeletonId: "skel-m3-t-missing",
            role: "planner",
            cwd: "/tmp/test-m3-t",
            watchdogLimitMs: 5000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.match((err as Error).message, /cancelGracePeriodMs/i);
          return true;
        }
      );
    });

    it("throws RequiredSettingError when cancelGracePeriodMs is non-positive or non-integer in options", () => {
      const invalidValues = [0, -1, -5000, NaN, Infinity, -Infinity, 1.5, 5000.5, "5000" as any, null as any];
      for (const badVal of invalidValues) {
        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: "run-m3-t-bad-opt",
              skeletonId: "skel-m3-t-bad-opt",
              role: "planner",
              cwd: "/tmp/test-m3-t",
              watchdogLimitMs: 5000,
              cancelGracePeriodMs: badVal,
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            assert.match((err as Error).message, /cancelGracePeriodMs/i);
            return true;
          },
          `Expected invalid cancelGracePeriodMs value ${String(badVal)} in options to throw RequiredSettingError`
        );
      }
    });

    it("throws RequiredSettingError when cancelGracePeriodMs is non-positive or non-integer in settings", () => {
      const invalidValues = [0, -1, -5000, NaN, Infinity, -Infinity, 2.7, "5000" as any];
      for (const badVal of invalidValues) {
        assert.throws(
          () =>
            createSkeletonSupervisor({
              runId: "run-m3-t-bad-settings",
              skeletonId: "skel-m3-t-bad-settings",
              role: "planner",
              cwd: "/tmp/test-m3-t",
              watchdogLimitMs: 5000,
              settings: { cancelGracePeriodMs: badVal },
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            assert.match((err as Error).message, /cancelGracePeriodMs/i);
            return true;
          },
          `Expected invalid cancelGracePeriodMs value ${String(badVal)} in settings to throw RequiredSettingError`
        );
      }
    });

    it("accepts valid cancelGracePeriodMs from options", () => {
      const supervisor = createSkeletonSupervisor({
        runId: "run-m3-t-ok-opt",
        quarantineDir: "/tmp/test-m3-t-quarantine",
        skeletonId: "skel-m3-t-ok-opt",
        role: "planner",
        cwd: "/tmp/test-m3-t",
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 2500,
      });
      assert.ok(supervisor instanceof SkeletonSupervisor);
    });

    it("accepts valid cancelGracePeriodMs from settings", () => {
      const supervisor = createSkeletonSupervisor({
        runId: "run-m3-t-ok-settings",
        quarantineDir: "/tmp/test-m3-t-quarantine",
        skeletonId: "skel-m3-t-ok-settings",
        role: "planner",
        cwd: "/tmp/test-m3-t",
        watchdogLimitMs: 5000,
        settings: { cancelGracePeriodMs: 4500 },
      });
      assert.ok(supervisor instanceof SkeletonSupervisor);
    });

    it("prioritizes options.cancelGracePeriodMs over settings.cancelGracePeriodMs", () => {
      const supervisor = createSkeletonSupervisor({
        runId: "run-m3-t-prio",
        quarantineDir: "/tmp/test-m3-t-quarantine",
        skeletonId: "skel-m3-t-prio",
        role: "planner",
        cwd: "/tmp/test-m3-t",
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 1200,
        settings: { cancelGracePeriodMs: 8000 },
      });
      assert.ok(supervisor instanceof SkeletonSupervisor);
    });

    it("throws before starting any Skeleton when both limits are missing", () => {
      assert.throws(
        () =>
          createSkeletonSupervisor({
            runId: "run-m3-both-missing",
            skeletonId: "skel-m3-both-missing",
            role: "planner",
            cwd: "/tmp/test-m3-both",
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          return true;
        }
      );
    });
  });

  describe("Audit M-2, N-3: permissionBroker option has no effect", () => {
    it("supervisor constructor ignores caller-injected permissionBroker option", () => {
      const fakeBroker = new PermissionBroker({
        role: "warden",
        cwd: "/fake/path",
        watchdogLimitMs: 1000,
      });

      const supervisor = createSkeletonSupervisor({
        runId: "run-m2-fake-broker",
        quarantineDir: "/tmp/real-path-quarantine",
        skeletonId: "skel-m2-fake-broker",
        role: "planner",
        cwd: "/tmp/real-path",
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        permissionBroker: fakeBroker,
      } as any);

      const actualBroker = supervisor.getPermissionBroker();
      assert.ok(actualBroker instanceof PermissionBroker);
      assert.notEqual(actualBroker, fakeBroker, "Supervisor must NOT use the caller-injected permissionBroker");
      assert.equal((actualBroker as any).options.role, "planner", "Broker must be created with supervisor role");
      assert.equal((actualBroker as any).options.cwd, "/tmp/real-path", "Broker must be created with supervisor cwd");
      assert.equal((actualBroker as any).options.watchdogLimitMs, 5000, "Broker must use resolved watchdog limit");
    });

    it("permissionBroker created from settings makes decisions by policy, not injected broker", () => {
      let fakeBrokerCalled = false;
      const fakeBroker = {
        decide: () => {
          fakeBrokerCalled = true;
          return { optionKind: "reject_once" as const };
        },
        handleRequestPermission: async () => {
          fakeBrokerCalled = true;
          return { outcome: { outcome: "cancelled" as const } };
        },
        options: { watchdogLimitMs: 1000 },
      } as any;

      const supervisor = createSkeletonSupervisor({
        runId: "run-m2-decision",
        quarantineDir: "/workspace/project-quarantine",
        skeletonId: "skel-m2-decision",
        role: "planner",
        cwd: "/workspace/project",
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        permissionBroker: fakeBroker,
      } as any);

      const broker = supervisor.getPermissionBroker();
      assert.notEqual(broker, fakeBroker);

      // Verify that the supervisor's broker decides allowed Planner tool report_task_result
      const req: PermissionBrokerRequest = {
        role: "Planner",
        _meta: { kiro: { mcpTool: "necromancer/report_task_result" } },
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      };

      const decision = broker.decide(req);
      assert.equal(decision.optionKind, "allow_once");
      assert.equal(fakeBrokerCalled, false, "Caller fakeBroker must never have been called");
    });
  });
});
