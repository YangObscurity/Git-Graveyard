// Task 13.7: Property tests for Warden isolation (Property 13: P13)
// Validates: Requirements 14.7, 21.7, 21.8, 24.14, 24.15

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import * as fc from "fast-check";

import {
  checkWardenIsolation,
  WARDEN_ALLOWED_TOOLS,
  FORBIDDEN_WARDEN_TOOLS,
  computeCandidateSha256,
} from "../../lib/warden/warden-review";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type {
  BuilderEnvironment,
  WardenEnvironment,
  WardenIsolationResult,
} from "../../lib/warden/types";
import { Scheduler } from "../../lib/scheduler/scheduler";
import type { PactRole, PactTask, RuleId } from "../../lib/pact/pact-parser";
import {
  mergeRule,
  isCandidateShaMatching,
  isGateResultPassing,
} from "../../lib/merge/merge-rule";
import { EventStore } from "../../lib/events/event-store";

// ---------------------------------------------------------------------------
// Helpers and Arbitraries
// ---------------------------------------------------------------------------

const BUILDER_ROLES = ["exhumer", "bonesetter", "soul-stitcher"] as const;

const safeIdArb = fc
  .stringMatching(/^[a-z0-9_-]{4,16}$/)
  .filter((s) => s.trim().length >= 4);

const wardenAllowedToolSubsetArb = fc.subarray(
  Array.from(WARDEN_ALLOWED_TOOLS),
  { minLength: 1 }
);

const forbiddenToolArb = fc.constantFrom(
  ...Array.from(FORBIDDEN_WARDEN_TOOLS)
);

const unknownToolArb = fc
  .stringMatching(/^[a-z_]{5,12}$/)
  .filter((t) => !WARDEN_ALLOWED_TOOLS.has(t) && !FORBIDDEN_WARDEN_TOOLS.has(t));

function makePactTask(
  id: string,
  deps: string[] = [],
  role: PactRole = "soul-stitcher",
  hard = false,
  order = 0
): PactTask {
  return {
    id,
    title: `Task ${id}`,
    role,
    dependencies: deps,
    depends: deps,
    dependsOn: deps,
    files: [`src/${id}.ts`],
    filesInScope: [`src/${id}.ts`],
    acceptanceCommand: "npm test",
    accept: "npm test",
    hard,
    hardFlag: hard,
    hardRaw: hard ? "yes" : "no",
    rules: ["M1"] as RuleId[],
    ruleIds: ["M1"] as RuleId[],
    line: order * 10 + 1,
  };
}

describe("Task 13.7 (Property 13: Warden isolation) - Property Tests", () => {
  // -------------------------------------------------------------------------
  // Property 13.1: Disjointness between Warden and Builder environments
  // -------------------------------------------------------------------------
  it("Property 13.1: arbitrary valid disjoint Warden and Builder environments always pass isolation (Requirements 14.7, 21.7, 21.8, 24.14, 24.15)", () => {
    const disjointPairArb = fc.record({
      wardenId: safeIdArb,
      builderId: safeIdArb,
      wardenPid: fc.integer({ min: 100, max: 9999 }),
      builderPid: fc.integer({ min: 10000, max: 65535 }),
      builderRole: fc.constantFrom(...BUILDER_ROLES),
      wardenTools: wardenAllowedToolSubsetArb,
      wardenPathSuffix: safeIdArb,
      builderPathSuffix: safeIdArb,
    }).filter((r) => r.wardenId !== r.builderId && r.wardenPathSuffix !== r.builderPathSuffix);

    fc.assert(
      fc.property(disjointPairArb, (gen) => {
        const wardenEnv: WardenEnvironment = {
          role: "warden",
          sessionId: `warden-sess-${gen.wardenId}`,
          processId: gen.wardenPid,
          kiroHome: `/data/warden/home-${gen.wardenId}`,
          checkoutDir: `/data/runs/run-01/warden/checkout-${gen.wardenId}`,
          boxId: `auditbox-${gen.wardenId}`,
          boxType: "auditbox",
          tools: gen.wardenTools,
          writableHostPaths: [`/data/warden/writable/${gen.wardenPathSuffix}`],
        };

        const builderEnv: BuilderEnvironment = {
          role: gen.builderRole,
          sessionId: `builder-sess-${gen.builderId}`,
          processId: gen.builderPid,
          kiroHome: `/data/builders/home-${gen.builderId}`,
          checkoutDir: `/data/builders/worktree-${gen.builderId}`,
          boxId: `runbox-${gen.builderId}`,
          boxType: "runbox",
          tools: ["read", "write", "sandbox_exec", "sandbox_log", "report_task_result"],
          writableHostPaths: [`/data/builders/writable/${gen.builderPathSuffix}`],
        };

        const result: WardenIsolationResult = checkWardenIsolation(wardenEnv, builderEnv);

        assert.equal(
          result.isolated,
          true,
          `Expected disjoint environments to pass isolation, got: ${result.violations.join("; ")}`
        );
        assert.equal(result.violations.length, 0);
      }),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 13.2: Complete violation detection across all isolation dimensions
  // -------------------------------------------------------------------------
  it("Property 13.2: any introduced collision or violation strictly causes isolation to fail (Requirements 14.7, 21.7, 21.8, 24.14, 24.15)", () => {
    const violationModes = [
      "share-session",
      "share-pid",
      "share-home",
      "share-checkout",
      "share-box",
      "bad-box-type",
      "bad-checkout-dir",
      "forbidden-write",
      "forbidden-shell",
      "unknown-tool",
      "share-writable-path",
    ] as const;

    const generator = fc.record({
      wardenId: safeIdArb,
      builderId: safeIdArb,
      wardenPid: fc.integer({ min: 100, max: 9999 }),
      builderPid: fc.integer({ min: 10000, max: 65535 }),
      builderRole: fc.constantFrom(...BUILDER_ROLES),
      mode: fc.constantFrom(...violationModes),
      forbiddenTool: forbiddenToolArb,
      unknownTool: unknownToolArb,
    }).filter((r) => r.wardenId !== r.builderId);

    fc.assert(
      fc.property(generator, (g) => {
        const sharedSession = `shared-session-${g.wardenId}`;
        const sharedPid = g.wardenPid;
        const sharedHome = `/data/shared/kiro-home-${g.wardenId}`;
        const sharedCheckout = `/data/runs/run-01/warden/shared-${g.wardenId}`;
        const sharedBox = `box-${g.wardenId}`;
        const sharedWritablePath = `/data/shared/writable/${g.wardenId}`;

        const isShareSession = g.mode === "share-session";
        const isSharePid = g.mode === "share-pid";
        const isShareHome = g.mode === "share-home";
        const isShareCheckout = g.mode === "share-checkout";
        const isShareBox = g.mode === "share-box";
        const isBadBoxType = g.mode === "bad-box-type";
        const isBadCheckoutDir = g.mode === "bad-checkout-dir";
        const isForbiddenWrite = g.mode === "forbidden-write";
        const isForbiddenShell = g.mode === "forbidden-shell";
        const isUnknownTool = g.mode === "unknown-tool";
        const isShareWritable = g.mode === "share-writable-path";

        let wardenTools: string[] = ["read", "sandbox_exec", "sandbox_log", "warden_verdict"];
        if (isForbiddenWrite) {
          wardenTools = [...wardenTools, "write"];
        } else if (isForbiddenShell) {
          wardenTools = [...wardenTools, g.forbiddenTool];
        } else if (isUnknownTool) {
          wardenTools = [...wardenTools, g.unknownTool];
        }

        const wardenEnv: WardenEnvironment = {
          role: "warden",
          sessionId: isShareSession ? sharedSession : `warden-sess-${g.wardenId}`,
          processId: isSharePid ? sharedPid : g.wardenPid,
          kiroHome: isShareHome ? sharedHome : `/data/warden/home-${g.wardenId}`,
          checkoutDir: isBadCheckoutDir
            ? `/data/builders/worktree-${g.wardenId}`
            : isShareCheckout
            ? sharedCheckout
            : `/data/runs/run-01/warden/checkout-${g.wardenId}`,
          boxId: isShareBox ? sharedBox : `auditbox-${g.wardenId}`,
          boxType: isBadBoxType ? "runbox" : "auditbox",
          tools: wardenTools,
          writableHostPaths: isShareWritable
            ? [sharedWritablePath]
            : [`/data/warden/writable/${g.wardenId}`],
        };

        const builderEnv: BuilderEnvironment = {
          role: g.builderRole,
          sessionId: isShareSession ? sharedSession : `builder-sess-${g.builderId}`,
          processId: isSharePid ? sharedPid : g.builderPid,
          kiroHome: isShareHome ? sharedHome : `/data/builders/home-${g.builderId}`,
          checkoutDir: isShareCheckout ? sharedCheckout : `/data/builders/worktree-${g.builderId}`,
          boxId: isShareBox ? sharedBox : `runbox-${g.builderId}`,
          boxType: "runbox",
          tools: ["read", "write", "sandbox_exec", "sandbox_log", "report_task_result"],
          writableHostPaths: isShareWritable
            ? [sharedWritablePath]
            : [`/data/builders/writable/${g.builderId}`],
        };

        const result = checkWardenIsolation(wardenEnv, builderEnv);

        assert.equal(
          result.isolated,
          false,
          `Expected violation mode '${g.mode}' to fail isolation check`
        );
        assert.ok(
          result.violations.length >= 1,
          `Expected at least one violation for mode '${g.mode}'`
        );
      }),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 13.3: Tool boundary invariance (Zero write tools, Requirement 14.7)
  // -------------------------------------------------------------------------
  it("Property 13.3: Warden tool boundaries strictly enforce zero write tools and permitted tool whitelist (Requirement 14.7)", () => {
    const toolListArb = fc.array(
      fc.oneof(
        fc.constantFrom(...Array.from(WARDEN_ALLOWED_TOOLS)),
        fc.constantFrom(...Array.from(FORBIDDEN_WARDEN_TOOLS)),
        unknownToolArb
      ),
      { minLength: 0, maxLength: 8 }
    );

    fc.assert(
      fc.property(toolListArb, safeIdArb, (tools, id) => {
        const wardenEnv: WardenEnvironment = {
          role: "warden",
          sessionId: `warden-sess-${id}`,
          processId: 1234,
          kiroHome: `/data/warden/home-${id}`,
          checkoutDir: `/data/runs/warden/checkout-${id}`,
          boxId: `auditbox-${id}`,
          boxType: "auditbox",
          tools,
        };

        const builderEnv: BuilderEnvironment = {
          role: "soul-stitcher",
          sessionId: `builder-sess-${id}-other`,
          processId: 5678,
          kiroHome: `/data/builders/home-${id}-other`,
          checkoutDir: `/data/builders/worktree-${id}-other`,
          boxId: `runbox-${id}-other`,
          boxType: "runbox",
          tools: ["read", "write", "sandbox_exec", "report_task_result"],
        };

        const result = checkWardenIsolation(wardenEnv, builderEnv);

        // Verification condition: all tools must be in WARDEN_ALLOWED_TOOLS
        const hasForbidden = tools.some((t) => FORBIDDEN_WARDEN_TOOLS.has(t));
        const hasNonAllowed = tools.some((t) => !WARDEN_ALLOWED_TOOLS.has(t));
        const shouldPass = !hasForbidden && !hasNonAllowed;

        if (shouldPass) {
          assert.equal(
            result.isolated,
            true,
            `Expected clean tool list to pass: ${tools.join(", ")}`
          );
        } else {
          assert.equal(
            result.isolated,
            false,
            `Expected forbidden or non-allowed tools to fail: ${tools.join(", ")}`
          );
          assert.ok(
            result.violations.some(
              (v) => v.includes("Requirement 14.7") || v.includes("tool")
            )
          );
        }
      }),
      { numRuns: 80 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 13.4: Multi-builder concurrent isolation invariance
  // -------------------------------------------------------------------------
  it("Property 13.4: Warden isolation holds across arbitrary number of concurrent builders (Requirements 21.7, 24.14, 24.15)", () => {
    const multiBuilderArb = fc.integer({ min: 1, max: 7 }).chain((count) => {
      const builderArbs = [];
      for (let i = 0; i < count; i++) {
        builderArbs.push(
          fc.record({
            taskId: fc.constant(`T${i + 1}`),
            builderId: safeIdArb,
            role: fc.constantFrom(...BUILDER_ROLES),
            pid: fc.integer({ min: 10000 + i * 1000, max: 10999 + i * 1000 }),
          })
        );
      }
      return fc.record({
        wardenId: safeIdArb,
        wardenPid: fc.integer({ min: 100, max: 999 }),
        builders: fc.tuple(...builderArbs),
        injectViolationIndex: fc.integer({ min: -1, max: count - 1 }),
      });
    });

    fc.assert(
      fc.property(multiBuilderArb, (spec) => {
        const wardenEnv: WardenEnvironment = {
          role: "warden",
          sessionId: `warden-sess-${spec.wardenId}`,
          processId: spec.wardenPid,
          kiroHome: `/data/warden/home-${spec.wardenId}`,
          checkoutDir: `/data/runs/run-01/warden/checkout`,
          boxId: `auditbox-${spec.wardenId}`,
          boxType: "auditbox",
          tools: ["read", "sandbox_exec", "sandbox_log", "warden_verdict"],
          writableHostPaths: [`/data/warden/out/${spec.wardenId}`],
        };

        const builderEnvs: BuilderEnvironment[] = spec.builders.map((b, idx) => {
          const isViolating = idx === spec.injectViolationIndex;
          return {
            role: b.role,
            sessionId: isViolating
              ? wardenEnv.sessionId
              : `builder-sess-${b.taskId}-${b.builderId}`,
            processId: b.pid,
            kiroHome: `/data/builders/${b.taskId}/kiro-home`,
            checkoutDir: `/data/builders/${b.taskId}/worktree`,
            boxId: `runbox-${b.taskId}-${b.builderId}`,
            boxType: "runbox",
            tools: ["read", "write", "sandbox_exec", "report_task_result"],
            writableHostPaths: [`/data/builders/${b.taskId}/out`],
          };
        });

        const result = checkWardenIsolation(wardenEnv, builderEnvs);

        if (spec.injectViolationIndex === -1) {
          assert.equal(
            result.isolated,
            true,
            `Expected all ${builderEnvs.length} builders to be isolated, violations: ${result.violations.join("; ")}`
          );
          assert.equal(result.violations.length, 0);
        } else {
          assert.equal(
            result.isolated,
            false,
            `Expected builder index ${spec.injectViolationIndex} to cause isolation violation`
          );
          assert.ok(result.violations.length >= 1);
        }
      }),
      { numRuns: 60 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 13.5: Path normalization invariance (backslashes vs slashes)
  // -------------------------------------------------------------------------
  it("Property 13.5: path normalization prevents bypass via backslash or redundant slash formatting (Requirements 24.14, 24.15)", () => {
    fc.assert(
      fc.property(
        safeIdArb,
        fc.boolean(),
        fc.boolean(),
        (id, useBackslashesWarden, useBackslashesBuilder) => {
          const baseCheckout = `data/runs/run-01/warden/checkout-${id}`;
          const wardenCheckout = useBackslashesWarden
            ? baseCheckout.replace(/\//g, "\\")
            : baseCheckout;
          const builderCheckout = useBackslashesBuilder
            ? baseCheckout.replace(/\//g, "\\")
            : baseCheckout;

          const wardenEnv: WardenEnvironment = {
            role: "warden",
            sessionId: `warden-sess-${id}`,
            processId: 1001,
            kiroHome: `/data/warden/home-${id}`,
            checkoutDir: wardenCheckout,
            boxId: `auditbox-${id}`,
            boxType: "auditbox",
            tools: ["read", "sandbox_exec", "sandbox_log", "warden_verdict"],
          };

          const builderEnv: BuilderEnvironment = {
            role: "soul-stitcher",
            sessionId: `builder-sess-${id}-other`,
            processId: 2002,
            kiroHome: `/data/builders/home-${id}-other`,
            checkoutDir: builderCheckout,
            boxId: `runbox-${id}-other`,
            boxType: "runbox",
            tools: ["read", "write", "sandbox_exec", "report_task_result"],
          };

          const result = checkWardenIsolation(wardenEnv, builderEnv);

          // Identical checkout paths must be detected regardless of slash style
          assert.equal(
            result.isolated,
            false,
            "Matching checkout directory with different slashes must be recognized as violation"
          );
          assert.ok(
            result.violations.some((v) => v.includes("checkout directory"))
          );
        }
      ),
      { numRuns: 40 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 13.6: Scheduler dispatch maintains builder worktree and role isolation
  // -------------------------------------------------------------------------
  it("Property 13.6: Scheduler dispatches builder tasks with distinct roles and bounded slots (Requirements 23.6, 23.7, 24.14)", () => {
    const taskPlanArb = fc.integer({ min: 2, max: 6 }).chain((taskCount) => {
      const taskArbs = [];
      for (let i = 1; i <= taskCount; i++) {
        const taskId = `T${i}`;
        const priorIds = Array.from({ length: i - 1 }, (_, idx) => `T${idx + 1}`);
        const role: PactRole = i % 2 === 0 ? "soul-stitcher" : "bonesetter";
        taskArbs.push(
          fc.record({
            task: fc.constant(makePactTask(taskId, i > 1 ? [priorIds[0]] : [], role, i === 1, i)),
          })
        );
      }
      return fc.record({
        tasks: fc.tuple(...taskArbs),
        parallelCap: fc.integer({ min: 1, max: 4 }),
      });
    });

    fc.assert(
      fc.property(taskPlanArb, (plan) => {
        const pactTasks = plan.tasks.map((t) => t.task);
        const scheduler = new Scheduler(pactTasks, {
          pactApproved: true,
          approvedTaskIds: pactTasks.map((t) => t.id),
          runParallelCap: plan.parallelCap,
          globalSkeletonLimit: 4,
          runningMax: 4,
        });

        // Dispatch initial ready tasks
        const dispatched = scheduler.dispatchNext();
        assert.ok(dispatched.length <= plan.parallelCap);

        for (const task of dispatched) {
          assert.ok(
            task.role === "bonesetter" || task.role === "soul-stitcher",
            "Builder task role must be bonesetter or soul-stitcher"
          );

          // Synthetic builder environment for dispatched task
          const builderEnv: BuilderEnvironment = {
            role: task.role,
            sessionId: `builder-session-${task.id}`,
            processId: 20000 + task.order,
            kiroHome: `/data/builders/${task.id}/kiro-home`,
            checkoutDir: `/data/builders/${task.id}/worktree`,
            boxId: `runbox-${task.id}`,
            boxType: "runbox",
            tools: ["read", "write", "sandbox_exec", "report_task_result"],
          };

          // Warden environment
          const wardenEnv: WardenEnvironment = {
            role: "warden",
            sessionId: "warden-session-singleton",
            processId: 9000,
            kiroHome: "/data/warden/kiro-home",
            checkoutDir: "/data/runs/run-01/warden/checkout",
            boxId: "auditbox-singleton",
            boxType: "auditbox",
            tools: ["read", "sandbox_exec", "sandbox_log", "warden_verdict"],
          };

          const isolation = checkWardenIsolation(wardenEnv, builderEnv);
          assert.equal(isolation.isolated, true);
          assert.equal(isolation.violations.length, 0);
        }
      }),
      { numRuns: 40 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 13.7: Merge rule candidate evaluation preserves head and candidate isolation
  // -------------------------------------------------------------------------
  it("Property 13.7: Merge rule enforces candidateSha256 and gate passing invariants before merging (Requirements 9.12, 25.6, 25.7, 25.8)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]{40}$/),
        fc.constantFrom("approve", "reject", "pending"),
        fc.boolean(),
        fc.boolean(),
        (commitSha, verdictStatus, gateOk, headMoved) => {
          const candidateDiff = `diff --git a/isolation.ts b/isolation.ts\n+${commitSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);
          const isolationTree = "tree-isolation-main";
          const currentHeadSha = headMoved ? "head-sha-moved" : "head-sha-initial";

          const store = new EventStore(":memory:");
          store.append({
            runId: "run-p13",
            kind: "gate.result",
            actor: "grimoire",
            taskId: "T1",
            data: {
              ok: gateOk,
              tree: isolationTree,
            },
          });
          store.append({
            runId: "run-p13",
            kind: "verdict",
            actor: "warden",
            taskId: "T1",
            data: {
              verdict: verdictStatus,
              candidateSha256,
              tree: isolationTree,
            },
          });

          const result = mergeRule({
            runId: "run-p13",
            task: { id: "T1", runId: "run-p13", candidateSha: commitSha, diff: candidateDiff, tree: isolationTree },
            candidateSha: commitSha,
            diff: candidateDiff,
            tree: isolationTree,
            eventSource: store,
            verdict: {
              verdict: verdictStatus,
              candidateSha256,
              tree: isolationTree,
              checks: {
                install: { ok: true },
                build: { ok: true },
                accept: { ok: true },
                tests: { ok: true },
                noTestWeakening: { ok: true },
              },
            },
            gateResult: { ok: gateOk, tree: isolationTree },
            expectedHeadSha: "head-sha-initial",
            currentHeadSha,
          });

          const expectedMerge = verdictStatus === "approve" && gateOk && !headMoved;

          if (expectedMerge) {
            assert.equal(result.merged, true);
            assert.equal(result.status, "merged");
            assert.equal(result.accepted, true);
          } else {
            assert.equal(result.merged, false);
            assert.equal(result.status, "not_merged");
            assert.ok(result.reasons.length >= 1);
          }
          store.close();
        }
      ),
      { numRuns: 50 }
    );
  });
});
