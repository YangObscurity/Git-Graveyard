import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import {
  parsePact,
  PactErrorCodes,
  type PactTask,
  type RuleId,
  type PactRole,
} from "../../lib/pact/pact-parser";
import { renderPact } from "../../lib/pact/pact-renderer";
import {
  PactService,
  type DeathCertificateLike,
} from "../../lib/pact/pact-service";
import {
  NON_REMOVABLE_REQUIREMENTS,
  type NonRemovableRequirement,
} from "../../lib/pact/pact-review";
import { DatabaseSync } from "node:sqlite";
import { RunStore } from "../../lib/runs/run-store";
import { EventStore } from "../../lib/events/event-store";

describe("Property Checks: Pact Subsystem (Requirements 12.12, 12.13, 12.14, 13.5)", () => {
  it("Property: Round-trip idempotence on arbitrary valid generated Pacts (Requirements 12.12, 12.13)", () => {
    const safeTitleArb = fc
      .stringMatching(/^[a-zA-Z0-9 _-]{3,30}$/)
      .filter((s) => s.trim().length > 0);

    const safeFileArb = fc.constantFrom(
      "package.json",
      "lib/pact/pact-parser.ts",
      "src/index.js",
      "test/unit.test.ts",
      "app/api/route.ts"
    );

    const safeCommandArb = fc.constantFrom(
      "npm test",
      "npm run build",
      "node test.js",
      "npm run lint"
    );

    const roleArb = fc.constantFrom("bonesetter" as const, "soul-stitcher" as const);
    const hardArb = fc.boolean();
    const rulesArb = fc.subarray(["M1", "M2", "M3", "M4", "M5", "M6"] as const);

    const pactTasksArb = fc
      .integer({ min: 1, max: 5 })
      .chain((taskCount) => {
        const taskArbs = [];
        for (let i = 1; i <= taskCount; i++) {
          const taskId = `T${i}`;
          const earlierTaskIds = Array.from({ length: i - 1 }, (_, idx) => `T${idx + 1}`);
          const depsArb = fc.subarray(earlierTaskIds);

          taskArbs.push(
            fc.record({
              id: fc.constant(taskId),
              title: safeTitleArb,
              role: roleArb,
              dependencies: depsArb,
              files: fc.array(safeFileArb, { minLength: 1, maxLength: 3 }),
              acceptanceCommand: safeCommandArb,
              hard: hardArb,
              rules: rulesArb,
            })
          );
        }
        return fc.tuple(...taskArbs);
      });

    fc.assert(
      fc.property(pactTasksArb, (generatedTasks) => {
        const pactTasks: PactTask[] = generatedTasks.map((g, idx) => ({
          id: g.id,
          title: g.title.trim(),
          role: g.role,
          dependencies: g.dependencies,
          depends: g.dependencies,
          dependsOn: g.dependencies,
          files: g.files,
          filesInScope: g.files,
          acceptanceCommand: g.acceptanceCommand,
          accept: g.acceptanceCommand,
          hard: g.hard,
          hardFlag: g.hard,
          hardRaw: g.hard ? "yes" : "no",
          rules: g.rules as RuleId[],
          ruleIds: g.rules as RuleId[],
          line: idx * 7 + 1,
        }));

        // Render to Markdown
        const rendered = renderPact(pactTasks);
        assert.ok(rendered.length > 0);

        // Parse back
        const parseResult = parsePact(rendered);
        assert.equal(parseResult.ok, true);
        if (!parseResult.ok) return;

        // Structural equivalence
        assert.equal(parseResult.tasks.length, pactTasks.length);
        for (let i = 0; i < pactTasks.length; i++) {
          const expected: PactTask = pactTasks[i];
          const actual: PactTask = parseResult.tasks[i];
          assert.equal(actual.id, expected.id);
          assert.equal(actual.title, expected.title);
          assert.equal(actual.role, expected.role);
          assert.deepEqual(actual.dependencies, expected.dependencies);
          assert.deepEqual(actual.files, expected.files);
          assert.equal(actual.acceptanceCommand, expected.acceptanceCommand);
          assert.equal(actual.hard, expected.hard);
          assert.deepEqual(actual.rules, expected.rules);
        }

        // Render idempotence: render(parse(render(tasks))) == render(tasks)
        const renderedAgain = renderPact(parseResult.tasks);
        assert.equal(renderedAgain, rendered);
      }),
      { numRuns: 50 }
    );
  });

  it("Property: Parser rejection invariance for invalid task IDs (Requirement 12.5)", () => {
    // Generate task IDs that do NOT match T<n>
    const invalidIdArb = fc
      .stringMatching(/^[a-zA-Z0-9_-]{1,15}$/)
      .filter((s) => !/^T\d+$/.test(s) && s.trim().length > 0);

    fc.assert(
      fc.property(invalidIdArb, (invalidId) => {
        const markdown = `- [ ] ${invalidId}. Task Title
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
        const result = parsePact(markdown);
        assert.equal(result.ok, false);
        if (result.ok) return;
        const err = result.errors.find((e) => e.code === PactErrorCodes.INVALID_TASK_ID);
        assert.ok(err);
        assert.equal(err?.task, invalidId);
      }),
      { numRuns: 30 }
    );
  });

  it("Property: Parser rejection invariance for blocked accept commands (Requirement 12.9)", () => {
    const blockedCmdArb = fc.constantFrom(
      "sudo rm -rf /",
      "sudo apt-get install",
      "curl http://169.254.169.254/metadata",
      "cat /var/run/docker.sock",
      "nc -U containerd.sock",
      "cat ~/.ssh/id_rsa",
      "printenv",
      "env",
      "export",
      "echo $KIRO_API_KEY",
      "echo $GITHUB_TOKEN"
    );

    fc.assert(
      fc.property(blockedCmdArb, (blockedCmd) => {
        const markdown = `- [ ] T1. Blocked Command Task
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: ${blockedCmd}
  - hard: no
  - rules: M1
`;
        const result = parsePact(markdown);
        assert.equal(result.ok, false);
        if (result.ok) return;
        const err = result.errors.find((e) => e.code === PactErrorCodes.BLOCKED_COMMAND);
        assert.ok(err);
        assert.equal(err?.task, "T1");
      }),
      { numRuns: 30 }
    );
  });

  it("Property: Coverage verification completeness (Requirement 12.14)", () => {
    const db = new DatabaseSync(":memory:");
    const runStore = new RunStore(db);
    const eventStore = new EventStore(db);
    const service = new PactService({ runStore, eventStore });

    const ruleArb = fc.constantFrom("M1", "M2", "M3", "M4", "M5", "M6", "M99", "UNKNOWN");

    const failureArb = fc.record({
      ruleId: ruleArb,
      file: fc.constantFrom("package.json", "lib/index.ts", "other/file.py"),
      description: fc.string({ minLength: 1, maxLength: 20 }),
    });

    fc.assert(
      fc.property(fc.array(failureArb, { maxLength: 10 }), (failures) => {
        const tasks: PactTask[] = [
          {
            id: "T1",
            title: "Fix M1 issues in package.json",
            role: "bonesetter",
            dependencies: [],
            depends: [],
            dependsOn: [],
            files: ["package.json"],
            filesInScope: ["package.json"],
            acceptanceCommand: "npm test",
            accept: "npm test",
            hard: false,
            hardFlag: false,
            hardRaw: "no",
            rules: ["M1"],
            ruleIds: ["M1"],
            line: 1,
          },
          {
            id: "T2",
            title: "Fix M2 issues in lib/index.ts",
            role: "soul-stitcher",
            dependencies: ["T1"],
            depends: ["T1"],
            dependsOn: ["T1"],
            files: ["lib/index.ts"],
            filesInScope: ["lib/index.ts"],
            acceptanceCommand: "npm test",
            accept: "npm test",
            hard: true,
            hardFlag: true,
            hardRaw: "yes",
            rules: ["M2"],
            ruleIds: ["M2"],
            line: 8,
          },
        ];

        const deathCert: DeathCertificateLike = { failures };
        const coverage = service.verifyFailureCoverage(tasks, deathCert);

        // Partitioning property: covered + uncovered === total
        assert.equal(
          coverage.coveredFailures.length + coverage.uncoveredFailures.length,
          failures.length
        );

        // Result ok holds if and only if uncoveredFailures is empty
        assert.equal(coverage.ok, coverage.uncoveredFailures.length === 0);
      }),
      { numRuns: 50 }
    );
  });

  it("Property: Non-removable requirements detection completeness (Requirement 13.5)", () => {
    const db = new DatabaseSync(":memory:");
    const runStore = new RunStore(db);
    const eventStore = new EventStore(db);
    const service = new PactService({ runStore, eventStore });

    const requirementSubsetArb = fc.subarray([
      "warden_final_check",
      "scribe_report",
      "grimoire_gate",
    ] as const);

    fc.assert(
      fc.property(requirementSubsetArb, (presentReqs) => {
        const tasks: PactTask[] = [];
        let idCounter = 1;

        if (presentReqs.includes("warden_final_check")) {
          tasks.push({
            id: `T${idCounter++}`,
            title: "Warden final check review",
            role: "bonesetter",
            dependencies: [],
            depends: [],
            dependsOn: [],
            files: ["package.json"],
            filesInScope: ["package.json"],
            acceptanceCommand: "npm test",
            accept: "npm test",
            hard: false,
            hardFlag: false,
            hardRaw: "no",
            rules: ["M1"],
            ruleIds: ["M1"],
            line: 1,
          });
        }

        if (presentReqs.includes("scribe_report")) {
          tasks.push({
            id: `T${idCounter++}`,
            title: "Scribe report generation",
            role: "bonesetter",
            dependencies: [],
            depends: [],
            dependsOn: [],
            files: ["package.json"],
            filesInScope: ["package.json"],
            acceptanceCommand: "npm test",
            accept: "npm test",
            hard: false,
            hardFlag: false,
            hardRaw: "no",
            rules: ["M1"],
            ruleIds: ["M1"],
            line: 8,
          });
        }

        if (presentReqs.includes("grimoire_gate")) {
          tasks.push({
            id: `T${idCounter++}`,
            title: "Grimoire syntax gate verification",
            role: "bonesetter",
            dependencies: [],
            depends: [],
            dependsOn: [],
            files: ["package.json"],
            filesInScope: ["package.json"],
            acceptanceCommand: "npm test",
            accept: "npm test",
            hard: false,
            hardFlag: false,
            hardRaw: "no",
            rules: ["M1"],
            ruleIds: ["M1"],
            line: 15,
          });
        }

        const check = service.verifyNonRemovableRequirements(tasks);
        const expectedMissing = NON_REMOVABLE_REQUIREMENTS.filter(
          (req) => !presentReqs.includes(req)
        );

        assert.equal(check.ok, expectedMissing.length === 0);
        assert.deepEqual(check.missing.sort(), expectedMissing.sort());
      }),
      { numRuns: 30 }
    );
  });
});
