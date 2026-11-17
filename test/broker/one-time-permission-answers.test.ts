// Task 10.8 Property Test: One-time permission answers (Property 12 / P12)
// Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6-18.15, 41.23, 45.7

import test, { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as fc from "fast-check";
import {
  PermissionBroker,
  createPermissionBroker,
  decide,
  decideWatchdogTimeout,
  PermissionBrokerRequest,
  PermissionOption,
  PermissionDecision,
  RequestPermissionResponse,
  ConfigurationError,
  MANIFEST_LOCK_FILENAMES,
} from "../../lib/broker/permission-broker";
import { decideWithFixedDecision } from "./test-decision-helper";
import { AcpClient } from "../../lib/supervisor/acp-client";

// Local constant: the broker no longer exports DEFAULT_BROKER_WATCHDOG_LIMIT_MS (SB6),
// so tests that need a valid limit pass this value explicitly.
const BROKER_WATCHDOG_LIMIT_MS = 5000;

// Helpers

function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeOptionKind(opt: PermissionOption): string {
  if (typeof opt.kind === "string" && opt.kind.trim().length > 0) {
    return opt.kind.trim().toLowerCase();
  }
  const id = String(opt.optionId ?? opt.id ?? "").trim().toLowerCase();
  return id;
}

// Arbitrary Generators

const KNOWN_ROLES = [
  "Planner",
  "Exhumer",
  "Bonesetter",
  "Soul-stitcher",
  "Warden",
  "Scribe",
];

const KNOWN_CAPABILITIES = [
  "fs_read",
  "fs_write",
  "mcp",
  "shell",
  "web_fetch",
  "web_search",
  "subagent",
  "skill",
  "power",
];

const ALLOWED_MCP_TOOLS = [
  "necromancer/sandbox_exec",
  "necromancer/sandbox_log",
  "necromancer/report_task_result",
  "necromancer/warden_verdict",
  "necromancer/ask",
  "necromancer/report_blocker",
  "necromancer/propose_task",
  "necromancer/ack_message",
];

const OPTION_KINDS = [
  "allow_once",
  "reject_once",
  "allow_always",
  "reject_always",
  "allow-once",
  "reject-once",
  "allow-always",
  "reject-always",
  "custom_kind",
  "ask_user",
];

const arbitraryOption = fc.record({
  optionId: fc.oneof(
    fc.constantFrom("1", "2", "3", "4", "5"),
    fc.string({ minLength: 1, maxLength: 25 }).filter((s) => s.trim().length > 0)
  ),
  kind: fc.constantFrom(...OPTION_KINDS),
  name: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
});

const arbitraryOfferedOptions = fc.array(arbitraryOption, { minLength: 0, maxLength: 6 });

describe("Property 12: One-time permission answers (P12) - Fast-Check Tests", () => {
  it("P12.1: Pure decide() invariant: selected option is strictly allow_once or reject_once, never persistent", () => {
    fc.assert(
      fc.property(
        arbitraryOfferedOptions,
        fc.constantFrom(...KNOWN_ROLES),
        fc.constantFrom(...KNOWN_CAPABILITIES),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (options, role, capability, target, toolCallId) => {
          const req: PermissionBrokerRequest = {
            requestId: "req-prop-1",
            toolCallId,
            role,
            capability,
            target,
            options,
            cwd: "/workspace/repo",
          };

          const decision: PermissionDecision = decide(req);

          // Invariant 1: outcome is strictly 'selected' or 'cancelled'
          assert.ok(
            decision.outcome.outcome === "selected" || decision.outcome.outcome === "cancelled",
            `Outcome must be selected or cancelled, got: ${decision.outcome.outcome}`
          );

          if (decision.outcome.outcome === "selected") {
            // Requirement 18.1: selected option has kind allow_once or reject_once
            assert.ok(
              decision.optionKind === "allow_once" || decision.optionKind === "reject_once",
              `Selected optionKind must be allow_once or reject_once, got: ${decision.optionKind}`
            );

            assert.ok(decision.selectedOption !== null, "selectedOption must not be null");
            assert.ok(
              decision.selectedOption.kind === "allow_once" ||
                decision.selectedOption.kind === "reject_once",
              `selectedOption.kind must be allow_once or reject_once, got: ${decision.selectedOption.kind}`
            );

            // Requirement 18.2: NEVER selects allow_always or reject_always
            assert.notEqual(decision.optionKind, "allow_always");
            assert.notEqual(decision.optionKind, "reject_always");
            assert.notEqual(decision.selectedOption.kind, "allow_always");
            assert.notEqual(decision.selectedOption.kind, "reject_always");

            // Selected option must originate from the offered options
            // Note: options may share duplicate optionIds, so decide() selects the option object directly
            const matchedInOffered = options.find((o) => o === decision.selectedOption) ?? options.find(
              (o) => (o.optionId === decision.selectedOptionId || o.optionId === decision.selectedOption?.optionId) &&
                     (o.kind === "allow_once" || o.kind === "reject_once")
            );
            assert.ok(matchedInOffered, "Selected option must exist in offered options");
            assert.strictEqual(
              decision.selectedOption,
              matchedInOffered,
              "decide() must select the option object directly"
            );

            // Selected option kind must be exactly the string allow_once or reject_once
            assert.ok(
              matchedInOffered.kind === "allow_once" || matchedInOffered.kind === "reject_once",
              `Offered option kind must be exactly allow_once or reject_once, got: ${matchedInOffered.kind}`
            );
            // reject-once is kept only as a negative case that must never be selected
            assert.notEqual(matchedInOffered.kind, "reject-once");
            assert.notEqual(matchedInOffered.kind, "allow-once");

            // The offered option must NOT have been a persistent option
            const offeredRawKind = normalizeOptionKind(matchedInOffered);
            assert.notEqual(offeredRawKind, "allow_always");
            assert.notEqual(offeredRawKind, "allow-always");
            assert.notEqual(offeredRawKind, "reject_always");
            assert.notEqual(offeredRawKind, "reject-always");

            assert.equal(decision.cancelTurn, false, "cancelTurn must be false on selection");
            assert.equal(decision.anomaly, false, "anomaly must be false on selection");
            assert.equal(decision.event.kind, "permission.decision");
          } else {
            // Requirement 18.3: No one-time option of needed kind offered -> cancel turn and emit anomaly
            assert.equal(decision.selectedOption, null, "selectedOption must be null on cancelled");
            assert.equal(decision.selectedOptionId, null, "selectedOptionId must be null on cancelled");
            assert.equal(decision.optionKind, null, "optionKind must be null on cancelled");
            assert.equal(decision.cancelTurn, true, "cancelTurn must be true on cancelled");
            assert.equal(decision.anomaly, true, "anomaly must be true on cancelled");
            assert.equal(decision.event.kind, "permission.anomaly");

            // Confirm that if cancelled without duplicate option IDs, the needed kind was indeed not present
            const isDuplicate = decision.event.data.reason.startsWith("duplicate_option_id");
            const neededKind = decision.event.data.neededKind;
            if (neededKind && !isDuplicate) {
              const hasMatchingOneTime = options.some((o) => o.kind === neededKind);
              assert.equal(
                hasMatchingOneTime,
                false,
                `Cancelled but offered options had an option matching neededKind '${neededKind}'`
              );
            }
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  it("P12.2: Fast-Check on arbitrary offered options with only persistent options: always cancelled", () => {
    const arbitraryPersistentOptions = fc.array(
      fc.record({
        optionId: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        kind: fc.constantFrom("allow_always", "reject_always", "allow-always", "reject-always"),
        name: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
      }),
      { minLength: 1, maxLength: 5 }
    );

    fc.assert(
      fc.property(
        arbitraryPersistentOptions,
        fc.constantFrom(...KNOWN_ROLES),
        (persistentOptions, role) => {
          const req: PermissionBrokerRequest = {
            requestId: "req-persistent-only",
            role,
            capability: "fs_read",
            target: "/workspace/repo/README.md",
            cwd: "/workspace/repo",
            options: persistentOptions,
          };

          const decision = decide(req);

          // When only persistent options are offered, broker must NEVER select them
          assert.equal(decision.outcome.outcome, "cancelled");
          assert.equal(decision.selectedOption, null);
          assert.equal(decision.selectedOptionId, null);
          assert.equal(decision.cancelTurn, true);
          assert.equal(decision.anomaly, true);
          assert.equal(decision.event.kind, "permission.anomaly");
          assert.ok(
            decision.event.data.reason === "no_one_time_option_offered" ||
            decision.event.data.reason.startsWith("duplicate_option_id")
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it("P12.3: Fast-Check on watchdog timeout: strictly selects reject_once or cancels, never persistent", () => {
    fc.assert(
      fc.property(arbitraryOfferedOptions, fc.constantFrom(...KNOWN_ROLES), (options, role) => {
        const req: PermissionBrokerRequest = {
          requestId: "req-watchdog-prop",
          role,
          options,
        };

        const decision = decideWatchdogTimeout(req, BROKER_WATCHDOG_LIMIT_MS);

        assert.ok(
          decision.outcome.outcome === "selected" || decision.outcome.outcome === "cancelled"
        );

        if (decision.outcome.outcome === "selected") {
          assert.equal(decision.optionKind, "reject_once");
          assert.ok(decision.selectedOption !== null);
          assert.equal(decision.selectedOption.kind, "reject_once");
          assert.notEqual(decision.selectedOption.kind, "allow_always");
          assert.notEqual(decision.selectedOption.kind, "reject_always");
          assert.notEqual(decision.selectedOption.kind, "allow_once");

          const matchedInOffered = options.find((o) => o === decision.selectedOption) ?? options.find(
            (o) => (o.optionId === decision.selectedOptionId || o.optionId === decision.selectedOption?.optionId) &&
                   o.kind === "reject_once"
          );
          assert.ok(matchedInOffered);
          assert.strictEqual(decision.selectedOption, matchedInOffered);
          assert.equal(matchedInOffered.kind, "reject_once");
          assert.notEqual(matchedInOffered.kind, "reject-once");
        } else {
          assert.equal(decision.selectedOption, null);
          assert.equal(decision.cancelTurn, true);
          assert.equal(decision.anomaly, true);
          assert.equal(decision.event.kind, "permission.anomaly");

          // Ensure no valid reject_once option was in options (reject-once is a negative case, never valid)
          const hasRejectOnce = options.some((o) => o.kind === "reject_once");
          assert.equal(hasRejectOnce, false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("P12.4: Fast-Check on PermissionBroker class instance handleRequestPermission(): invariant holds end-to-end", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryOfferedOptions,
        fc.constantFrom(...KNOWN_ROLES),
        fc.constantFrom(...KNOWN_CAPABILITIES),
        async (options, role, capability) => {
          let cancelTurnInvoked = false;
          let eventEmitted: any = null;

          const broker = createPermissionBroker({
            role,
            cwd: "/workspace/repo",
            watchdogLimitMs: 5000,
            onCancelTurn: () => {
              cancelTurnInvoked = true;
            },
            onEvent: (ev) => {
              eventEmitted = ev;
            },
          });

          const req: PermissionBrokerRequest = {
            sessionId: "sess-fc-1",
            requestId: "req-fc-1",
            toolCallId: "tc-fc-1",
            capability,
            target: capability === "mcp" ? "necromancer/report_task_result" : "file.txt",
            options,
          };

          const res: RequestPermissionResponse = await broker.handleRequestPermission(req);

          assert.ok(res.outcome.outcome === "selected" || res.outcome.outcome === "cancelled");

          if (res.outcome.outcome === "selected") {
            const optId = res.outcome.optionId;
            const chosen = options.find(
              (o) => String(o.optionId ?? (o as any).id) === optId &&
                     (o.kind === "allow_once" || o.kind === "reject_once")
            );
            assert.ok(chosen, "Returned optionId must be among offered options");

            assert.ok(
              chosen.kind === "allow_once" || chosen.kind === "reject_once",
              `Selected option kind must be exact one-time (allow_once or reject_once), got: ${chosen.kind}`
            );
            assert.notEqual(chosen.kind, "reject-once");
            assert.notEqual(chosen.kind, "allow-once");
            assert.notEqual(chosen.kind, "allow_always");
            assert.notEqual(chosen.kind, "reject_always");
            assert.equal(cancelTurnInvoked, false);
            assert.equal(eventEmitted?.kind, "permission.decision");
          } else {
            assert.equal(cancelTurnInvoked, true);
            assert.equal(eventEmitted?.kind, "permission.anomaly");
          }
        }
      ),
      { numRuns: 80 }
    );
  });
});

describe("Property 12: permissions.yaml Immutability", () => {
  it("P12.5: permissions.yaml never changes before, during, or after any PermissionBroker operations (Requirement 18.2)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-broker-test-"));
    const permYamlPath = path.join(tmpDir, "permissions.yaml");

    const initialYamlContent = [
      "# Kiro initial permissions file",
      "version: 1",
      "rules:",
      "  - capability: fs_read",
      "    path: /workspace/**",
      "    action: ask",
      "  - capability: shell",
      "    action: deny",
    ].join("\n");

    fs.writeFileSync(permYamlPath, initialYamlContent, "utf-8");
    const initialSha = computeSha256(initialYamlContent);
    const initialStat = fs.statSync(permYamlPath);

    const broker = createPermissionBroker({
      cwd: tmpDir,
      role: "Soul-stitcher",
      watchdogLimitMs: 5000,
    });

    // Run a multitude of diverse requests: allow, reject, cancelled, timeout, async
    const testCases: PermissionBrokerRequest[] = [
      {
        capability: "fs_read",
        target: path.join(tmpDir, "src/code.ts"),
        options: [
          { optionId: "opt-1", kind: "allow_once" },
          { optionId: "opt-2", kind: "reject_once" },
        ],
      },
      {
        capability: "fs_write",
        target: path.join(tmpDir, ".git/config"),
        options: [
          { optionId: "opt-1", kind: "allow_once" },
          { optionId: "opt-2", kind: "reject_once" },
        ],
      },
      {
        capability: "shell",
        target: "rm -rf /",
        options: [
          { optionId: "opt-a", kind: "allow_always" },
          { optionId: "opt-b", kind: "reject_always" },
        ],
      },
      {
        capability: "mcp",
        target: "necromancer/sandbox_exec",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      },
      {
        capability: "fs_read",
        target: "/proc/cpuinfo",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      },
      {
        capability: "fs_read",
        target: path.join(tmpDir, ".env"),
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      },
      {
        capability: "mcp",
        target: "unknown_server/tool",
        options: [{ optionId: "opt-rej", kind: "reject_once" }],
      },
    ];

    for (const tc of testCases) {
      await broker.handleRequestPermission(tc);
      broker.decide(tc);
    }

    // Also run pure decide and watchdog decisions
    for (let i = 0; i < 50; i++) {
      decide({
        role: "Planner",
        capability: i % 2 === 0 ? "fs_read" : "fs_write",
        target: path.join(tmpDir, `file_${i}.txt`),
        cwd: tmpDir,
        options: [
          { optionId: `allow-${i}`, kind: "allow_once" },
          { optionId: `reject-${i}`, kind: "reject_once" },
          { optionId: `always-${i}`, kind: "allow_always" },
        ],
      });

      decideWatchdogTimeout(
        {
          role: "Exhumer",
          options: [{ optionId: `rej-${i}`, kind: "reject_once" }],
        },
        BROKER_WATCHDOG_LIMIT_MS
      );
    }

    // Verify permissions.yaml content and metadata
    assert.ok(fs.existsSync(permYamlPath), "permissions.yaml must still exist");
    const currentContent = fs.readFileSync(permYamlPath, "utf-8");
    const currentSha = computeSha256(currentContent);
    const currentStat = fs.statSync(permYamlPath);

    assert.equal(
      currentSha,
      initialSha,
      "permissions.yaml content hash must not have changed"
    );
    assert.equal(
      currentContent,
      initialYamlContent,
      "permissions.yaml content must remain byte-for-byte identical"
    );
    assert.equal(
      currentStat.size,
      initialStat.size,
      "permissions.yaml file size must remain identical"
    );

    // Clean up temporary directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("Requirement 18.1: Exact One-Time Option Selection", () => {
  it("selects allow_once when rule allows capability and allow_once option is offered", () => {
    const res = decide({
      role: "Planner",
      capability: "mcp",
      target: "necromancer/report_task_result",
      options: [
        { optionId: "opt-1", kind: "allow_once" },
        { optionId: "opt-2", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-1");
    assert.equal(res.optionKind, "allow_once");
    assert.equal(res.cancelTurn, false);
    assert.equal(res.rule, "allow_mcp_gateway_tool");
    assert.equal(res.event.kind, "permission.decision");
  });

  it("selects reject_once when rule rejects capability and reject_once option is offered", () => {
    const res = decide({
      role: "Planner",
      capability: "shell",
      target: "ls",
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-reject");
    assert.equal(res.optionKind, "reject_once");
    assert.equal(res.cancelTurn, false);
    assert.equal(res.rule, "forbidden_capability");
    assert.equal(res.event.kind, "permission.decision");
  });

  it("never selects non-exact kinds like ALLOW_ONCE and cancels when no exact one-time option is offered", () => {
    const res = decide({
      role: "Soul-stitcher",
      cwd: "/repo",
      capability: "fs_read",
      target: "/repo/src/index.ts",
      options: [
        { optionId: "opt-ALLOW", kind: "ALLOW_ONCE" },
        { optionId: "opt-REJECT", kind: "REJECT_ONCE" },
      ],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.equal(res.event.data.reason, "no_one_time_option_offered");
  });

  it("never selects reject-once (ACP invalid kind) and cancels when only reject-once is offered", () => {
    const res = decide({
      role: "Planner",
      capability: "shell",
      target: "ls",
      options: [
        { optionId: "opt-reject", kind: "reject-once" },
      ],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.equal(res.event.data.reason, "no_one_time_option_offered");
  });

  it("selects only exact reject_once when reject-once is offered alongside as negative case", () => {
    const res = decide({
      role: "Planner",
      capability: "shell",
      target: "ls",
      options: [
        { optionId: "opt-bad", kind: "reject-once" },
        { optionId: "opt-good", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-good");
    assert.equal(res.optionKind, "reject_once");
    assert.equal(res.selectedOption?.kind, "reject_once");
  });

  it("supports options where id is used instead of optionId", () => {
    const res = decide({
      role: "Warden",
      capability: "mcp",
      target: "necromancer/warden_verdict",
      options: [
        { id: "choice-allow", kind: "allow_once" },
        { id: "choice-reject", kind: "reject_once" },
      ] as any,
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "choice-allow");
    assert.equal(res.optionKind, "allow_once");
  });

  it("when duplicate optionId 5 is shared, broker does not select any option, returns outcome cancelled and emits anomaly naming the duplicate id", () => {
    const optPersistent = { optionId: "5", kind: "allow-always" };
    const optOneTime = { optionId: "5", kind: "reject_once" };
    const res = decide({
      role: "Soul-stitcher",
      capability: "shell",
      target: "rm -rf /",
      options: [optPersistent, optOneTime],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.ok(
      (res.event.data as any).duplicateOptionId === "5" ||
      (res.event.data as any).duplicateId === "5" ||
      res.event.data.reason.includes("5")
    );
  });

  it("when duplicate optionId 5 is shared in reverse order, broker returns outcome cancelled and emits anomaly naming duplicate id", () => {
    const optOneTime = { optionId: "5", kind: "reject_once" };
    const optPersistent = { optionId: "5", kind: "allow-always" };
    const res = decide({
      role: "Soul-stitcher",
      capability: "shell",
      target: "rm -rf /",
      options: [optOneTime, optPersistent],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.ok(
      (res.event.data as any).duplicateOptionId === "5" ||
      (res.event.data as any).duplicateId === "5" ||
      res.event.data.reason.includes("5")
    );
  });

  it("when duplicate optionId is shared for allow_once, broker returns outcome cancelled and emits anomaly naming duplicate id", () => {
    const optPersistent = { optionId: "5", kind: "reject_always" };
    const optAllowOnce = { optionId: "5", kind: "allow_once" };
    const res = decide({
      role: "Planner",
      cwd: "/workspace/repo",
      capability: "mcp",
      target: "necromancer/ask",
      options: [optPersistent, optAllowOnce],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.ok(
      (res.event.data as any).duplicateOptionId === "5" ||
      (res.event.data as any).duplicateId === "5" ||
      res.event.data.reason.includes("5")
    );
  });

  it("cancels when duplicate optionIds exist but none have an exact one-time kind", () => {
    const res = decide({
      role: "Planner",
      cwd: "/workspace/repo",
      capability: "shell",
      options: [
        { optionId: "5", kind: "allow-always" },
        { optionId: "5", kind: "reject_always" },
        { optionId: "5", kind: "reject-once" },
      ],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.ok(
      (res.event.data as any).duplicateOptionId === "5" ||
      (res.event.data as any).duplicateId === "5" ||
      res.event.data.reason.includes("5")
    );
  });

  it("supports numeric optionId 5 with duplicate IDs and cancels while emitting anomaly naming duplicate id", () => {
    const optPersistent = { optionId: 5 as any, kind: "allow-always" };
    const optOneTime = { optionId: 5 as any, kind: "reject_once" };
    const res = decide({
      role: "Soul-stitcher",
      capability: "shell",
      target: "rm -rf /",
      options: [optPersistent, optOneTime],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.ok(
      (res.event.data as any).duplicateOptionId === "5" ||
      (res.event.data as any).duplicateId === "5" ||
      res.event.data.reason.includes("5")
    );
  });
});

describe("Requirement 18.2: No Persistent Options Ever Selected", () => {
  it("refuses to select allow_always even if allow is the needed outcome", () => {
    const res = decide({
      role: "Planner",
      capability: "mcp",
      target: "necromancer/ask",
      options: [
        { optionId: "opt-perm-allow", kind: "allow_always" },
        { optionId: "opt-rej-once", kind: "reject_once" },
      ],
    });

    // Planner is allowed necromancer/ask, so neededKind is allow_once.
    // Since only allow_always is offered for allow, it must NOT select allow_always.
    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
  });

  it("refuses to select reject_always even if reject is the needed outcome", () => {
    const res = decide({
      role: "Warden",
      capability: "fs_write",
      target: "package.json",
      options: [
        { optionId: "opt-perm-reject", kind: "reject_always" },
        { optionId: "opt-allow-once", kind: "allow_once" },
      ],
    });

    // Warden writes are forbidden, so neededKind is reject_once.
    // Since only reject_always is offered for reject, it must NOT select reject_always.
    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
  });

  it("ignores persistent options when matching one-time options are present", () => {
    const res = decide({
      role: "Planner",
      capability: "mcp",
      target: "necromancer/ask",
      options: [
        { optionId: "opt-perm-allow", kind: "allow_always" },
        { optionId: "opt-one-allow", kind: "allow_once" },
        { optionId: "opt-perm-reject", kind: "reject_always" },
        { optionId: "opt-one-reject", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-one-allow");
    assert.equal(res.optionKind, "allow_once");
  });

  it("ignores persistent options with hyphenated or uppercase formatting", () => {
    const res = decide({
      role: "Soul-stitcher",
      capability: "shell",
      target: "bash",
      options: [
        { optionId: "opt-1", kind: "ALLOW-ALWAYS" },
        { optionId: "opt-2", kind: "REJECT_ALWAYS" },
        { optionId: "opt-3", kind: "reject-always" },
        { optionId: "allow_always", name: "allow_always" } as any,
        { optionId: "reject_always", name: "reject_always" } as any,
      ],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.cancelTurn, true);
  });
});

describe("Requirement 18.3: No One-Time Option of Needed Kind Offered", () => {
  it("cancels turn and emits permission.anomaly when options array is empty", () => {
    const res = decide({
      role: "Planner",
      capability: "mcp",
      target: "necromancer/ask",
      options: [],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.equal(res.event.data.reason, "no_one_time_option_offered");
  });

  it("cancels turn and emits permission.anomaly when options is undefined", () => {
    const res = decide({
      role: "Bonesetter",
      capability: "fs_write",
      target: "package.json",
      cwd: "/repo",
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
  });

  it("cancels turn when needed kind is allow_once but only reject_once is offered", () => {
    const res = decide({
      role: "Soul-stitcher",
      cwd: "/repo",
      capability: "fs_write",
      target: "/repo/src/main.ts",
      options: [{ optionId: "opt-reject", kind: "reject_once" }],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.cancelTurn, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.equal(res.event.data.neededKind, "allow_once");
  });

  it("cancels turn when needed kind is reject_once but only allow_once is offered", () => {
    const res = decide({
      role: "Exhumer",
      capability: "fs_write",
      target: "src/file.ts",
      options: [{ optionId: "opt-allow", kind: "allow_once" }],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.cancelTurn, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.equal(res.event.data.neededKind, "reject_once");
  });

  it("triggers onCancelTurn callback on PermissionBrokerAdapter when turn is cancelled", async () => {
    let cancelledSession: string | undefined;
    let cancelReason: string | undefined;

    const broker = createPermissionBroker({
      watchdogLimitMs: 5000,
      onCancelTurn: (sessionId, reason) => {
        cancelledSession = sessionId;
        cancelReason = reason;
      },
    });

    const res = await broker.handleRequestPermission({
      sessionId: "sess-cancel-test",
      role: "Warden",
      capability: "fs_write",
      target: "any.txt",
      options: [],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(cancelledSession, "sess-cancel-test");
    assert.equal(cancelReason, "no_one_time_option_offered");
  });
});

describe("Requirement 18.4 & 18.5: Evaluation Source and Defaults", () => {
  it("decides solely on identity and arguments, ignoring title and MCP annotations (Requirement 18.4)", () => {
    // Request claims to be harmless in title and annotations, but requests forbidden shell
    const res = decide({
      title: "Harmless read operation",
      description: "Just reading innocuous information",
      role: "Planner",
      capability: "shell",
      target: "cat /etc/passwd",
      _meta: {
        kiro: {
          annotations: { safe: true, preApproved: true },
        },
      },
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-reject");
    assert.equal(res.rule, "forbidden_capability");
  });

  it("defaults unmatched requests to reject_once (Requirement 18.5)", () => {
    const res = decide({
      role: "UnknownRole",
      capability: "unknown_capability",
      target: "unknown_target",
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-reject");
    assert.equal(res.optionKind, "reject_once");
    assert.equal(res.rule, "default_reject");
  });
});

describe("Requirements 18.6 - 18.12: Role Boundaries and Capabilities", () => {
  it("evaluates fs_read: allows inside cwd, rejects secret globs and /proc (Requirements 18.6, 18.7)", () => {
    const cwd = "/workspace/repo";

    // Allowed read inside cwd
    const allowRes = decide({
      role: "Planner",
      cwd,
      capability: "fs_read",
      target: "/workspace/repo/README.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(allowRes.optionKind, "allow_once");
    assert.equal(allowRes.rule, "allow_fs_read_workspace");

    // Rejected read for .env
    const envRes = decide({
      role: "Planner",
      cwd,
      capability: "fs_read",
      target: "/workspace/repo/.env",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(envRes.optionKind, "reject_once");
    assert.equal(envRes.rule, "reject_fs_read_prohibited");

    // Rejected read for /proc
    const procRes = decide({
      role: "Planner",
      cwd,
      capability: "fs_read",
      target: "/proc/self/environ",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(procRes.optionKind, "reject_once");
    assert.equal(procRes.rule, "reject_fs_read_prohibited");
  });

  it("evaluates fs_write: rejects Exhumer and Warden completely (Requirements 18.8, 18.9)", () => {
    const exhumerRes = decide({
      role: "Exhumer",
      cwd: "/workspace/repo",
      capability: "fs_write",
      target: "/workspace/repo/src/file.ts",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(exhumerRes.optionKind, "reject_once");
    assert.equal(exhumerRes.rule, "reject_fs_write_role_forbidden");

    const wardenRes = decide({
      role: "Warden",
      cwd: "/workspace/repo",
      capability: "fs_write",
      target: "/workspace/repo/src/file.ts",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(wardenRes.optionKind, "reject_once");
    assert.equal(wardenRes.rule, "reject_fs_write_role_forbidden");
  });

  it("evaluates fs_write: strictly rejects .git/** and .kiro/** for any role (Requirement 18.9)", () => {
    for (const role of ["Planner", "Bonesetter", "Soul-stitcher", "Scribe"]) {
      const gitRes = decide({
        role,
        cwd: "/workspace/repo",
        capability: "fs_write",
        target: "/workspace/repo/.git/HEAD",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(gitRes.optionKind, "reject_once");
      assert.equal(gitRes.rule, "reject_fs_write_git_kiro");

      const kiroRes = decide({
        role,
        cwd: "/workspace/repo",
        capability: "fs_write",
        target: "/workspace/repo/.kiro/steering/guidance.md",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(kiroRes.optionKind, "reject_once");
      assert.equal(kiroRes.rule, "reject_fs_write_git_kiro");
    }
  });

  it("evaluates role-specific write scopes (Requirements 18.8, 18.9)", () => {
    const cwd = "/workspace/repo";

    // Planner: allowed on specs/**, rejected elsewhere
    const plannerGood = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs/pact.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(plannerGood.optionKind, "allow_once");

    const plannerSpecPrefixBad = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "spec/pact.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(plannerSpecPrefixBad.optionKind, "reject_once");

    const plannerBad = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "src/app.ts",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(plannerBad.optionKind, "reject_once");

    // Bonesetter: allowed on manifests and lockfiles, rejected elsewhere
    const boneGood = decide({
      role: "Bonesetter",
      cwd,
      capability: "fs_write",
      target: "package.json",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(boneGood.optionKind, "allow_once");

    const boneBad = decide({
      role: "Bonesetter",
      cwd,
      capability: "fs_write",
      target: "src/main.ts",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(boneBad.optionKind, "reject_once");

    // Scribe: allowed on report/**, rejected elsewhere
    const scribeGood = decide({
      role: "Scribe",
      cwd,
      capability: "fs_write",
      target: "report/summary.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(scribeGood.optionKind, "allow_once");

    const scribeBad = decide({
      role: "Scribe",
      cwd,
      capability: "fs_write",
      target: "src/index.ts",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(scribeBad.optionKind, "reject_once");
  });

  it("evaluates mcp tools: allows necromancer/* listed for role, rejects unlisted or other servers (Requirements 18.10, 18.11)", () => {
    // Warden: allowed necromancer/warden_verdict
    const wardenVerdict = decide({
      role: "Warden",
      capability: "mcp",
      target: "necromancer/warden_verdict",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(wardenVerdict.optionKind, "allow_once");

    // Warden: rejected on necromancer/propose_task (not listed for Warden)
    const wardenPropose = decide({
      role: "Warden",
      capability: "mcp",
      target: "necromancer/propose_task",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(wardenPropose.optionKind, "reject_once");

    // Any role: rejected on external server
    const externalTool = decide({
      role: "Soul-stitcher",
      capability: "mcp",
      target: "filesystem/write_file",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(externalTool.optionKind, "reject_once");
    assert.equal(externalTool.rule, "reject_unlisted_mcp_tool");
  });

  it("evaluates forbidden capabilities: rejects shell, web_fetch, web_search, subagent, skill, power (Requirement 18.12)", () => {
    const forbidden = ["shell", "web_fetch", "web_search", "subagent", "skill", "power"];

    for (const cap of forbidden) {
      const res = decide({
        role: "Soul-stitcher",
        capability: cap,
        target: "execute",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(res.optionKind, "reject_once", `Capability '${cap}' must be rejected`);
      assert.equal(res.rule, "forbidden_capability");
    }
  });
});

describe("Requirement 18.13 & 18.14: Decision Events and Watchdog Timeout", () => {
  it("emits permission.decision with complete event data payload on every decision (Requirement 18.13)", () => {
    const res = decide({
      requestId: "req-1234",
      toolCallId: "tc-5678",
      role: "Planner",
      capability: "mcp",
      target: "necromancer/ask",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });

    assert.equal(res.event.kind, "permission.decision");
    assert.equal(res.event.actor, "PermissionBroker");
    assert.equal(res.event.data.requestId, "req-1234");
    assert.equal(res.event.data.toolCallId, "tc-5678");
    assert.equal(res.event.data.role, "Planner");
    assert.equal(res.event.data.capability, "mcp");
    assert.equal(res.event.data.target, "necromancer/ask");
    assert.equal(res.event.data.optionKind, "allow_once");
    assert.equal(res.event.data.rule, "allow_mcp_gateway_tool");
  });

  it("enforces watchdog timeout: selects reject_once, logs bug, and emits anomaly (Requirements 18.14, 41.23)", async () => {
    let loggedBug = false;
    let anomalyEvent: any = null;

    const broker = createPermissionBroker({
      watchdogLimitMs: 50,
      onLogBug: () => {
        loggedBug = true;
      },
      onEvent: (ev) => {
        if (ev.kind === "permission.anomaly") {
          anomalyEvent = ev;
        }
      },
    });

    const res = await broker.handleWatchdogTimeout(
      {
        requestId: "req-timeout-1",
        toolCallId: "tc-timeout-1",
        role: "Bonesetter",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      },
      50
    );

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-reject");
    assert.equal(loggedBug, true);
    assert.ok(anomalyEvent);
    assert.equal(anomalyEvent.kind, "permission.anomaly");
    assert.equal(anomalyEvent.data.rule, "broker_watchdog_timeout");
  });
});

describe("Requirement 45.7: Probe P6 Permission Form Fallback", () => {
  it("falls back to documented-safe permission form and rejects when probe P6 indicates fallback", () => {
    const res = decide({
      role: "Soul-stitcher",
      cwd: "/workspace/repo",
      capability: "fs_read",
      target: "/workspace/repo/README.md",
      fallbackChosen: true,
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-reject");
    assert.equal(res.optionKind, "reject_once");
    assert.equal(res.rule, "probe_p6_fallback");
  });

  it("resolves documented-safe form from probeP6 failed outcome object", () => {
    const res = decide({
      role: "Planner",
      cwd: "/workspace/repo",
      capability: "mcp",
      target: "necromancer/report_task_result",
      probeP6: { P6: { id: "P6", passed: false, outcome: "failed" } },
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "selected");
    assert.equal(res.outcome.optionId, "opt-reject");
    assert.equal(res.rule, "probe_p6_fallback");
  });
});

describe("Work package F04: Change 1 - ACP field whitelist & options override", () => {
  it("whitelists allowed fields, drops unwhitelisted parameters, and this.options overrides request values", async () => {
    let capturedRequest: PermissionBrokerRequest | undefined;

    const handlers = new Map<string, (params: unknown, id: string | number) => Promise<unknown>>();
    let fallbackHandler: any;
    const mockTransport = {
      registerRequestHandler: (method: string, handler: any) => {
        handlers.set(method, handler);
      },
      registerFallbackRequestHandler: (handler: any) => {
        fallbackHandler = handler;
      },
      registerNotificationHandler: (_method: string, _handler: any) => {},
      sendRequest: async () => ({}),
      sendNotification: async () => {},
      sendResponse: async () => {},
      sendError: async () => {},
    };

    new AcpClient(mockTransport as any, {
      role: "Planner",
      cwd: "/configured/workspace",
      additionalDirectories: ["/configured/extra"],
      runId: "run-configured-1",
      watchdogLimitMs: 5000,
      onRequestPermission: (req) => {
        capturedRequest = req;
        return { outcome: { outcome: "selected", optionId: "opt-1" } };
      },
    });

    const handler = handlers.get("session/request_permission");
    assert.ok(handler, "session/request_permission handler must be registered");

    const rawParams = {
      sessionId: "session-xyz",
      toolCallId: "tc-99",
      capability: "fs_read",
      target: "specs/pact.md",
      consent: { type: "fs_read" },
      mcpTool: "necromancer/ask",
      arguments: { path: "specs/pact.md" },
      options: [{ optionId: "opt-1", kind: "allow_once" }],
      // Request-supplied values that MUST be overridden:
      role: "Soul-stitcher",
      cwd: "/evil/override/path",
      additionalDirectories: ["/evil/extra"],
      // Unwhitelisted fields that MUST NOT reach brokerRequest:
      decision: "allow_once",
      watchdogLimitMs: 999999,
      timeoutMs: 999999,
      title: "Harmless operation",
      unwhitelistedCustomField: "should_not_leak",
    };

    await handler(rawParams, "req-123");

    assert.ok(capturedRequest, "onRequestPermission should have been called");
    assert.equal(capturedRequest.id, "req-123");
    assert.equal(capturedRequest.requestId, "req-123");
    assert.equal(capturedRequest.sessionId, "session-xyz");
    assert.equal(capturedRequest.runId, "run-configured-1");

    // Overridden by this.options
    assert.equal(capturedRequest.role, "Planner");
    assert.equal(capturedRequest.cwd, "/configured/workspace");
    assert.deepEqual(capturedRequest.additionalDirectories, ["/configured/extra"]);

    // Whitelisted fields preserved
    assert.equal(capturedRequest.toolCallId, "tc-99");
    assert.equal(capturedRequest.capability, "fs_read");
    assert.equal(capturedRequest.target, "specs/pact.md");
    assert.deepEqual(capturedRequest.arguments, { path: "specs/pact.md" });

    // Unwhitelisted fields NOT leaked / spread
    assert.equal((capturedRequest as any).decision, undefined);
    assert.equal((capturedRequest as any).watchdogLimitMs, undefined);
    assert.equal((capturedRequest as any).timeoutMs, undefined);
    assert.equal((capturedRequest as any).title, undefined);
    assert.equal((capturedRequest as any).unwhitelistedCustomField, undefined);
  });
});

describe("Work package F04: Change 2 - No request-supplied decision in production", () => {
  it("ignores request.decision in production decide() and uses test-only helper when fixed decision is needed", () => {
    // In production decide(), passing decision: "allow_once" must NOT permit a forbidden capability
    const prodRes = decide({
      role: "Planner",
      capability: "shell",
      target: "rm -rf /",
      decision: "allow_once",
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    });

    assert.equal(prodRes.outcome.outcome, "selected");
    assert.equal(prodRes.outcome.optionId, "opt-reject");
    assert.equal(prodRes.optionKind, "reject_once");
    assert.equal(prodRes.rule, "forbidden_capability");

    // With the test-only helper, a fixed decision can be used in tests
    const fixedRes = decideWithFixedDecision(
      {
        role: "Planner",
        capability: "shell",
        target: "rm -rf /",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      },
      "allow_once",
      "test_custom_rule"
    );

    assert.equal(fixedRes.outcome.outcome, "selected");
    assert.equal(fixedRes.outcome.optionId, "opt-allow");
    assert.equal(fixedRes.optionKind, "allow_once");
    assert.equal(fixedRes.rule, "test_custom_rule");
  });
});

describe("Work package F04: Change 3 - Duplicate option ids", () => {
  it("cancels and emits permission.anomaly naming duplicate id when multiple options share optionId", () => {
    const res = decide({
      role: "Planner",
      cwd: "/workspace/repo",
      capability: "mcp",
      target: "necromancer/ask",
      options: [
        { optionId: "duplicate-id-42", kind: "allow_once" },
        { optionId: "duplicate-id-42", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.ok(
      (res.event.data as any).duplicateOptionId === "duplicate-id-42" ||
      (res.event.data as any).duplicateId === "duplicate-id-42" ||
      res.event.data.reason.includes("duplicate-id-42")
    );
  });
});

describe("Work package F04: Change 4 - Paths normalisation, cwd required, Planner scope & Bonesetter full relative path", () => {
  it("rejects fs_read and fs_write when cwd is empty (no relative fallback)", () => {
    const readRes = decide({
      role: "Planner",
      cwd: "",
      capability: "fs_read",
      target: "README.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(readRes.optionKind, "reject_once");
    assert.equal(readRes.rule, "reject_fs_read_outside_workspace");

    const writeRes = decide({
      role: "Planner",
      cwd: "",
      capability: "fs_write",
      target: "specs/tasks.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(writeRes.optionKind, "reject_once");
    assert.equal(writeRes.rule, "reject_fs_write_outside_scope");
  });

  it("Planner may write only under specs/ inside cwd, and sibling directory with same prefix must not match", () => {
    const cwd = "/workspace/repo";

    // Allowed: under specs/
    const goodSpecs = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs/tasks.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(goodSpecs.optionKind, "allow_once");
    assert.equal(goodSpecs.rule, "allow_fs_write_scope");

    // Sibling directory with same prefix: specs-sibling must NOT match
    const siblingSpecs = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs-sibling/tasks.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(siblingSpecs.optionKind, "reject_once");
    assert.equal(siblingSpecs.rule, "reject_fs_write_outside_scope");

    const prefixSibling = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs_extra/tasks.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(prefixSibling.optionKind, "reject_once");
    assert.equal(prefixSibling.rule, "reject_fs_write_outside_scope");
  });

  it("Bonesetter may write only exact manifest and lock files matched by full relative path from cwd, not by basename", () => {
    const cwd = "/workspace/repo";

    // Allowed: exact manifest file at cwd root
    const rootManifest = decide({
      role: "Bonesetter",
      cwd,
      capability: "fs_write",
      target: "package.json",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(rootManifest.optionKind, "allow_once");
    assert.equal(rootManifest.rule, "allow_fs_write_scope");

    // Rejected: nested package.json (matched by basename would erroneously allow this)
    const nestedManifest = decide({
      role: "Bonesetter",
      cwd,
      capability: "fs_write",
      target: "src/package.json",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(nestedManifest.optionKind, "reject_once");
    assert.equal(nestedManifest.rule, "reject_fs_write_outside_scope");

    const deepLock = decide({
      role: "Bonesetter",
      cwd,
      capability: "fs_write",
      target: "nested/dir/yarn.lock",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(deepLock.optionKind, "reject_once");
    assert.equal(deepLock.rule, "reject_fs_write_outside_scope");
  });

  it("rejects every path that escapes cwd, including through .. segments", () => {
    const cwd = "/workspace/repo";

    // fs_write escaping cwd via ..
    const writeEscape = decide({
      role: "Soul-stitcher",
      cwd,
      capability: "fs_write",
      target: "../escaped.txt",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(writeEscape.optionKind, "reject_once");
    assert.equal(writeEscape.rule, "reject_fs_write_outside_scope");

    // fs_write escaping cwd via nested ..
    const plannerEscape = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs/../../escaped.txt",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(plannerEscape.optionKind, "reject_once");
    assert.equal(plannerEscape.rule, "reject_fs_write_outside_scope");

    // fs_read escaping cwd via ..
    const readEscape = decide({
      role: "Planner",
      cwd,
      capability: "fs_read",
      target: "../../etc/shadow",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(readEscape.optionKind, "reject_once");
    assert.equal(readEscape.rule, "reject_fs_read_outside_workspace");
  });
});

describe("Work package G01a: Rule 1 - Broker options isolation (role, cwd, additionalDirectories from config only)", () => {
  it("additionalDirectories, role and cwd come only from broker options, never from request", async () => {
    const broker = createPermissionBroker({
      role: "Planner",
      cwd: "/configured/root",
      additionalDirectories: ["/configured/extra"],
      watchdogLimitMs: 5000,
    });

    // Request attempts to forge role, cwd, additionalDirectories
    const forgedReq: PermissionBrokerRequest = {
      sessionId: "s1",
      requestId: "r1",
      toolCallId: "tc1",
      capability: "fs_write",
      target: "specs/plan.md",
      role: "Exhumer", // would be forbidden if taken from request
      cwd: "/evil/cwd",
      additionalDirectories: ["/evil/dir"],
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    };

    const res = await broker.handleRequestPermission(forgedReq);
    // Role is Planner (not Exhumer), cwd is /configured/root, so writing under specs/ is allowed
    assert.equal(res.outcome.outcome, "selected");
    assert.equal((res.outcome as any).optionId, "a");

    // Deciding directly on broker also uses broker options
    const dec = broker.decide(forgedReq);
    assert.equal(dec.role, "Planner");
    assert.equal(dec.optionKind, "allow_once");
    assert.equal(dec.rule, "allow_fs_write_scope");
  });

  it("broker without additionalDirectories does not fall back to request additionalDirectories", () => {
    const broker = createPermissionBroker({
      role: "Planner",
      cwd: "/configured/root",
      watchdogLimitMs: 5000,
    });

    const forgedReq: PermissionBrokerRequest = {
      capability: "fs_read",
      target: "/evil/dir/secret.txt",
      additionalDirectories: ["/evil/dir"],
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    };

    const dec = broker.decide(forgedReq);
    assert.equal(dec.optionKind, "reject_once");
    assert.equal(dec.rule, "reject_fs_read_outside_workspace");
  });

  it("denies requests that ask for / (root) or for directories outside the configured set", () => {
    const broker = createPermissionBroker({
      role: "Planner",
      cwd: "/configured/root",
      additionalDirectories: ["/configured/extra"],
      watchdogLimitMs: 5000,
    });

    // Ask for / on fs_read
    const readRoot = broker.decide({
      capability: "fs_read",
      target: "/",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(readRoot.optionKind, "reject_once");
    assert.equal(readRoot.rule, "reject_fs_read_outside_workspace");

    // Ask for / on fs_write
    const writeRoot = broker.decide({
      capability: "fs_write",
      target: "/",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(writeRoot.optionKind, "reject_once");
    assert.equal(writeRoot.rule, "reject_fs_write_outside_scope");

    // Ask for directory outside configured set on fs_read
    const readOutside = broker.decide({
      capability: "fs_read",
      target: "/completely/outside/path.txt",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(readOutside.optionKind, "reject_once");
    assert.equal(readOutside.rule, "reject_fs_read_outside_workspace");

    // Ask for directory outside configured set on fs_write
    const writeOutside = broker.decide({
      capability: "fs_write",
      target: "/completely/outside/file.txt",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(writeOutside.optionKind, "reject_once");
    assert.equal(writeOutside.rule, "reject_fs_write_outside_scope");

    // Ask for configured additional directory on fs_read is allowed
    const readExtra = broker.decide({
      capability: "fs_read",
      target: "/configured/extra/data.json",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(readExtra.optionKind, "allow_once");
    assert.equal(readExtra.rule, "allow_fs_read_workspace");
  });

  it("AcpClient removes fallback to request values for role, cwd, additionalDirectories", async () => {
    let capturedBrokerReq: any = null;
    let fallbackHandler: any;
    const mockTransport = {
      registerRequestHandler: () => {},
      registerFallbackRequestHandler: (handler: any) => {
        fallbackHandler = handler;
      },
      registerNotificationHandler: () => {},
      sendRequest: async () => ({}),
      sendNotification: async () => {},
      sendResponse: async () => {},
      sendError: async () => {},
    };
    const client = new AcpClient(mockTransport as any, {
      role: "Planner",
      cwd: "/configured/ws",
      additionalDirectories: ["/configured/add"],
      runId: "run-configured-1",
      watchdogLimitMs: 5000,
      onRequestPermission: (req) => {
        capturedBrokerReq = req;
        return { outcome: { outcome: "selected", optionId: "a" } };
      },
    });

    await (client as any).handlePermissionRequest(
      {
        sessionId: "s1",
        role: "Exhumer",
        cwd: "/forged/cwd",
        additionalDirectories: ["/forged/dir"],
        capability: "fs_read",
        target: "specs/pact.md",
        options: [{ optionId: "a", kind: "allow_once" }],
      },
      "req-101"
    );

    assert.ok(capturedBrokerReq);
    assert.equal(capturedBrokerReq!.role, "Planner");
    assert.equal(capturedBrokerReq!.cwd, "/configured/ws");
    assert.deepEqual(capturedBrokerReq!.additionalDirectories, ["/configured/add"]);
  });
});

describe("Work package G01a: Rule 2 - Realpath and symlink checks", () => {
  it("resolves symlinks with fs.realpathSync and denies paths whose real location is outside cwd", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "g01a-broker-sym-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "g01a-outside-"));

    try {
      const realCwd = fs.realpathSync(tmpDir);
      const realOutside = fs.realpathSync(outsideDir);

      // Create an outside secret file
      const outsideFile = path.join(realOutside, "secret.txt");
      fs.writeFileSync(outsideFile, "confidential", "utf-8");

      // Create a symlink pointing to the outside file
      const symlinkFile = path.join(realCwd, "symlink_file.txt");
      fs.symlinkSync(outsideFile, symlinkFile);

      // Create a symlink directory pointing outside
      const symlinkDir = path.join(realCwd, "outside_dir");
      fs.symlinkSync(realOutside, symlinkDir);

      // Create an inside target file and a symlink pointing to inside
      const insideFile = path.join(realCwd, "safe.txt");
      fs.writeFileSync(insideFile, "safe content", "utf-8");
      const safeSymlink = path.join(realCwd, "safe_link.txt");
      fs.symlinkSync(insideFile, safeSymlink);

      const broker = createPermissionBroker({
        role: "Soul-stitcher",
        cwd: realCwd,
        watchdogLimitMs: 5000,
      });

      // 1. Reading symlink that points outside is denied
      const readSymlinkOutside = broker.decide({
        capability: "fs_read",
        target: "symlink_file.txt",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(readSymlinkOutside.optionKind, "reject_once");
      assert.equal(readSymlinkOutside.rule, "reject_fs_read_outside_workspace");

      // 2. Writing to symlink that points outside is denied
      const writeSymlinkOutside = broker.decide({
        capability: "fs_write",
        target: "symlink_file.txt",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(writeSymlinkOutside.optionKind, "reject_once");
      assert.equal(writeSymlinkOutside.rule, "reject_fs_write_outside_scope");

      // 3. Path that does not exist yet inside a symlink directory pointing outside resolves nearest parent and is denied
      const nonExistentOutside = broker.decide({
        capability: "fs_write",
        target: "outside_dir/new_file.txt",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(nonExistentOutside.optionKind, "reject_once");
      assert.equal(nonExistentOutside.rule, "reject_fs_write_outside_scope");

      const nonExistentReadOutside = broker.decide({
        capability: "fs_read",
        target: "outside_dir/nested/missing.txt",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(nonExistentReadOutside.optionKind, "reject_once");
      assert.equal(nonExistentReadOutside.rule, "reject_fs_read_outside_workspace");

      // 4. Symlink pointing to target inside cwd is allowed
      const readSafeSymlink = broker.decide({
        capability: "fs_read",
        target: "safe_link.txt",
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(readSafeSymlink.optionKind, "allow_once");
      assert.equal(readSafeSymlink.rule, "allow_fs_read_workspace");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("Work package G01a: Rule 3 - Watchdog limit from settings object at construction", () => {
  it("watchdog limit comes from settings object passed at construction", () => {
    // Configured via settings object
    const settingsBroker = createPermissionBroker({
      settings: { watchdogLimitMs: 3200 },
    });
    assert.equal(settingsBroker.resolveWatchdogLimit(), 3200);

    // Configured via watchdogLimitMs
    const directBroker = createPermissionBroker({
      watchdogLimitMs: 4100,
    });
    assert.equal(directBroker.resolveWatchdogLimit(), 4100);

    // Request cannot override or extend watchdog limit
    assert.equal(
      settingsBroker.resolveWatchdogLimit({ watchdogLimitMs: 999999, timeoutMs: 999999 }),
      3200
    );
  });

  it("construction without a positive finite limit throws ConfigurationError", () => {
    // Missing settings / empty options
    assert.throws(
      () => createPermissionBroker({}),
      (err: any) => err instanceof ConfigurationError || err.name === "ConfigurationError"
    );

    assert.throws(
      () => createPermissionBroker(),
      (err: any) => err instanceof ConfigurationError || err.name === "ConfigurationError"
    );

    // Negative limit
    assert.throws(
      () => createPermissionBroker({ watchdogLimitMs: -100 }),
      (err: any) => err instanceof ConfigurationError || err.name === "ConfigurationError"
    );

    // Zero limit
    assert.throws(
      () => createPermissionBroker({ watchdogLimitMs: 0 }),
      (err: any) => err instanceof ConfigurationError || err.name === "ConfigurationError"
    );

    // NaN limit
    assert.throws(
      () => createPermissionBroker({ watchdogLimitMs: NaN }),
      (err: any) => err instanceof ConfigurationError || err.name === "ConfigurationError"
    );

    // Infinity limit
    assert.throws(
      () => createPermissionBroker({ watchdogLimitMs: Infinity }),
      (err: any) => err instanceof ConfigurationError || err.name === "ConfigurationError"
    );

    // Invalid non-positive limit inside settings object
    assert.throws(
      () => createPermissionBroker({ settings: { watchdogLimitMs: -50 } }),
      (err: any) => err instanceof ConfigurationError || err.name === "ConfigurationError"
    );
  });
});

describe("Work package G01a: Rule 4 - Planner specs/ only (no spec/ prefix match)", () => {
  it("Planner may write only under specs/ inside cwd and spec/ is rejected", () => {
    const cwd = "/workspace/repo";

    // Allowed: under specs/
    const goodSpecs = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs/pact.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(goodSpecs.optionKind, "allow_once");
    assert.equal(goodSpecs.rule, "allow_fs_write_scope");

    const nestedSpecs = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs/sub/tasks.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(nestedSpecs.optionKind, "allow_once");
    assert.equal(nestedSpecs.rule, "allow_fs_write_scope");

    // Rejected: spec/ prefix match is removed
    const badSpec = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "spec/pact.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(badSpec.optionKind, "reject_once");
    assert.equal(badSpec.rule, "reject_fs_write_outside_scope");

    // Rejected: sibling directory specs-other/
    const badSibling = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs-other/tasks.md",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(badSibling.optionKind, "reject_once");
    assert.equal(badSibling.rule, "reject_fs_write_outside_scope");
  });
});

describe("Work package G01a: Rule 5 - Bonesetter manifest/lock root only & setup.py removed", () => {
  it("Bonesetter manifest and lock names are matched only at cwd root and setup.py is removed", () => {
    const cwd = "/workspace/repo";

    // setup.py is removed from write list: rejected at root
    const setupPy = decide({
      role: "Bonesetter",
      cwd,
      capability: "fs_write",
      target: "setup.py",
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ],
    });
    assert.equal(setupPy.optionKind, "reject_once");
    assert.equal(setupPy.rule, "reject_fs_write_outside_scope");
    assert.equal(MANIFEST_LOCK_FILENAMES.has("setup.py"), false);

    // Other manifest and lock names at cwd root are allowed
    for (const validManifest of [
      "package.json",
      "package-lock.json",
      "requirements.txt",
      "pyproject.toml",
      "setup.cfg",
      "cargo.toml",
      "cargo.lock",
      "go.mod",
      "go.sum",
    ]) {
      const res = decide({
        role: "Bonesetter",
        cwd,
        capability: "fs_write",
        target: validManifest,
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(res.optionKind, "allow_once");
      assert.equal(res.rule, "allow_fs_write_scope");
    }

    // Manifest files in subdirectories are rejected (root only)
    for (const nested of [
      "src/package.json",
      "backend/requirements.txt",
      "sub/pyproject.toml",
      "pkg/cargo.toml",
    ]) {
      const res = decide({
        role: "Bonesetter",
        cwd,
        capability: "fs_write",
        target: nested,
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(res.optionKind, "reject_once");
      assert.equal(res.rule, "reject_fs_write_outside_scope");
    }
  });
});
