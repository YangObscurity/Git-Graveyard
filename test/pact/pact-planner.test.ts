import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generatePactWithPlanner,
  revisePactWithPlanner,
  verifyDeathCertificateCoverage,
  buildPlannerPrompt,
  buildPlannerRevisionPrompt,
  PactPlannerError,
  PactPlannerModelError,
  PactPlannerGrammarError,
  PactPlannerCoverageError,
} from "../../lib/pact/pact-planner";
import { PactService } from "../../lib/pact/pact-service";
import type { EventInput } from "../../lib/events/event-store";
import type { PactTask } from "../../lib/pact/pact-parser";
import { CLAUDE_OPUS_5_5_MODEL_ID } from "../../lib/agents/model-allowlist";

function createSampleDeathCertificate() {
  return {
    schemaVersion: "v1" as const,
    baseSha: "abc1234",
    runId: "run-test-01",
    primaryLanguage: "javascript" as const,
    packageManager: "npm" as const,
    createdAt: new Date().toISOString(),
    healthy: false,
    failureClasses: ["dependency_missing", "syntax_error"],
    summary: "Dependencies missing and syntax errors found.",
    failures: [
      {
        class: "dependency_missing",
        step: "install" as const,
        message: "Module not found: lodash",
        ruleId: "M1",
        file: "package.json",
      },
      {
        class: "syntax_error",
        step: "build" as const,
        message: "Unexpected token in src/index.js",
        ruleId: "M2",
        file: "src/index.js",
      },
    ],
    rows: [],
    runtimes: [],
    install: { step: "install" as const, command: "npm install", status: "failed" as const },
    build: { step: "build" as const, command: "npm run build", status: "failed" as const },
    test: { step: "test" as const, command: "npm test", status: "not run" as const },
  };
}

describe("PactPlanner: Prompt Generation", () => {
  it("builds prompt grounded in deathCertificate, repoPath, and signals", () => {
    const deathCert = createSampleDeathCertificate();
    const prompt = buildPlannerPrompt({
      runId: "run-prompt-01",
      deathCertificate: deathCert,
      repoPath: "/workspace/my-repo",
      signals: [{ ruleId: "M1", message: "outdated lockfile" }],
    });

    assert.ok(prompt.includes("Planner Skeleton"));
    assert.ok(prompt.includes("/workspace/my-repo"));
    assert.ok(prompt.includes("M1"));
    assert.ok(prompt.includes("package.json"));
    assert.ok(prompt.includes("src/index.js"));
    assert.ok(prompt.includes("outdated lockfile"));
  });

  it("builds revision prompt including feedback and previous Pact", () => {
    const deathCert = createSampleDeathCertificate();
    const prevMarkdown = `# Tasks
- [ ] T1. Update dependencies
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;
    const prompt = buildPlannerRevisionPrompt({
      runId: "run-prompt-02",
      deathCertificate: deathCert,
      previousPact: prevMarkdown,
      feedback: "Please mark task T1 as hard: yes and add lodash upgrade",
    });

    assert.ok(prompt.includes("Revision Request"));
    assert.ok(prompt.includes("Please mark task T1 as hard: yes"));
    assert.ok(prompt.includes("T1. Update dependencies"));
  });
});

describe("PactPlanner: generatePactWithPlanner Happy Path", () => {
  it("synthesizes a valid default Pact covering all DeathCertificate failures", async () => {
    const deathCert = createSampleDeathCertificate();
    const recordedEvents: EventInput[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pact-planner-test-"));

    try {
      const result = await generatePactWithPlanner({
        runId: "run-gen-01",
        deathCertificate: deathCert,
        worktreeDir: tmpDir,
        events: recordedEvents,
        emitEvent: async (ev) => {
          recordedEvents.push(ev);
        },
      });

      assert.equal(result.ok, true);
      assert.ok(result.draftId.startsWith("pact-run-gen-01-"));
      assert.ok(result.sha256.length === 64);
      assert.ok(result.tasks.length >= 2);
      assert.equal(result.version, 1);
      assert.equal(result.coverage.ok, true);
      assert.equal(result.modelVerified, true);

      // Verify file written
      assert.ok(result.filePath);
      assert.ok(fs.existsSync(result.filePath));
      const fileContent = fs.readFileSync(result.filePath, "utf-8");
      assert.equal(fileContent, result.markdown);

      // Verify event emitted
      assert.ok(recordedEvents.length >= 1);
      const draftEvent = recordedEvents.find((e) => e.kind === "pact.drafted");
      assert.ok(draftEvent);
      assert.equal(draftEvent.runId, "run-gen-01");
      assert.equal(draftEvent.actor, "planner");
      assert.equal((draftEvent.data as any).pactVersion, 1);
      assert.equal((draftEvent.data as any).sha256, result.sha256);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts plannerRunner callback returning valid Pact markdown", async () => {
    const deathCert = createSampleDeathCertificate();
    const recordedEvents: EventInput[] = [];

    const mockMarkdown = `# Tasks
- [ ] T1. Update dependencies in package.json
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Fix syntax error in src/index.js
  - role: soul-stitcher
  - depends: T1
  - files: src/index.js
  - accept: npm test
  - hard: yes
  - rules: M2
- [ ] T3. Execute Warden final check
  - role: soul-stitcher
  - depends: T2
  - files: src/index.js
  - accept: npm test
  - hard: no
  - rules:
`;

    let runnerPrompt = "";
    const result = await generatePactWithPlanner({
      runId: "run-runner-01",
      deathCertificate: deathCert,
      events: recordedEvents,
      plannerRunner: async (prompt) => {
        runnerPrompt = prompt;
        return mockMarkdown;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.tasks.length, 3);
    assert.equal(result.tasks[0].id, "T1");
    assert.equal(result.tasks[0].role, "bonesetter");
    assert.equal(result.tasks[1].id, "T2");
    assert.equal(result.tasks[1].role, "soul-stitcher");
    assert.ok(runnerPrompt.includes("Planner Skeleton"));
  });

  it("accepts plannerRunner returning JSON format", async () => {
    const deathCert = createSampleDeathCertificate();
    const tasksJson = {
      tasks: [
        {
          id: "T1",
          title: "Fix dependencies",
          role: "bonesetter",
          depends: [],
          files: ["package.json"],
          accept: "npm test",
          hard: false,
          rules: ["M1"],
        },
        {
          id: "T2",
          title: "Fix syntax",
          role: "soul-stitcher",
          depends: ["T1"],
          files: ["src/index.js"],
          accept: "npm test",
          hard: true,
          rules: ["M2"],
        },
      ],
    };

    const result = await generatePactWithPlanner({
      runId: "run-json-01",
      deathCertificate: deathCert,
      plannerRunner: async () => tasksJson,
    });

    assert.equal(result.ok, true);
    assert.equal(result.tasks.length, 2);
    assert.equal(result.coverage.ok, true);
  });

  it("accepts sessionClient.prompt interface", async () => {
    const deathCert = createSampleDeathCertificate();
    const mockMarkdown = `# Tasks
- [ ] T1. Fix M1
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Fix M2
  - role: soul-stitcher
  - depends: T1
  - files: src/index.js
  - accept: npm test
  - hard: no
  - rules: M2
`;

    const result = await generatePactWithPlanner({
      runId: "run-client-01",
      deathCertificate: deathCert,
      sessionClient: {
        async prompt() {
          return mockMarkdown;
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.tasks.length, 2);
  });

  it("passes supervisor model verification when model is Claude Opus 5.5", async () => {
    const deathCert = createSampleDeathCertificate();
    const result = await generatePactWithPlanner({
      runId: "run-super-ok",
      deathCertificate: deathCert,
      supervisor: {
        getVerifiedModel: () => CLAUDE_OPUS_5_5_MODEL_ID,
        getVerifiedAgent: () => "planner",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.modelVerified, true);
  });
});

describe("PactPlanner: Fail-Closed Error Handling", () => {
  it("rejects when supervisor model verification fails (wrong model tier)", async () => {
    const deathCert = createSampleDeathCertificate();

    await assert.rejects(
      async () =>
        generatePactWithPlanner({
          runId: "run-super-fail",
          deathCertificate: deathCert,
          supervisor: {
            getVerifiedModel: () => "claude-haiku-5.5", // Haiku is not allowed for Planner!
            getVerifiedAgent: () => "planner",
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PactPlannerModelError);
        assert.match((err as Error).message, /does not match Planner assigned tier/i);
        return true;
      }
    );
  });

  it("rejects when supervisor reports wrong agent role", async () => {
    const deathCert = createSampleDeathCertificate();

    await assert.rejects(
      async () =>
        generatePactWithPlanner({
          runId: "run-super-agent-fail",
          deathCertificate: deathCert,
          supervisor: {
            getVerifiedModel: () => CLAUDE_OPUS_5_5_MODEL_ID,
            getVerifiedAgent: () => "bonesetter", // Wrong agent!
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PactPlannerModelError);
        assert.match((err as Error).message, /does not match Planner role/i);
        return true;
      }
    );
  });

  it("fails closed when plannerRunner throws an error", async () => {
    const deathCert = createSampleDeathCertificate();

    await assert.rejects(
      async () =>
        generatePactWithPlanner({
          runId: "run-runner-err",
          deathCertificate: deathCert,
          plannerRunner: async () => {
            throw new Error("API connection reset by peer");
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PactPlannerError);
        assert.match((err as Error).message, /API connection reset by peer/i);
        return true;
      }
    );
  });

  it("fails closed when planner produces unparseable Pact grammar", async () => {
    const deathCert = createSampleDeathCertificate();

    await assert.rejects(
      async () =>
        generatePactWithPlanner({
          runId: "run-bad-grammar",
          deathCertificate: deathCert,
          plannerRunner: async () => {
            return "This is just conversational text without any task structure.";
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PactPlannerGrammarError);
        assert.match((err as Error).message, /Planner produced unparseable Pact/i);
        return true;
      }
    );
  });

  it("fails closed when generated Pact fails DeathCertificate coverage", async () => {
    const deathCert = createSampleDeathCertificate(); // Has failures for M1 and M2

    // Runner only produces task for M1, leaving M2 uncovered!
    const incompleteMarkdown = `# Tasks
- [ ] T1. Update dependencies
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
`;

    await assert.rejects(
      async () =>
        generatePactWithPlanner({
          runId: "run-uncovered",
          deathCertificate: deathCert,
          plannerRunner: async () => incompleteMarkdown,
        }),
      (err: unknown) => {
        assert.ok(err instanceof PactPlannerCoverageError);
        assert.match((err as Error).message, /do not cover all DeathCertificate failures/i);
        assert.ok((err as PactPlannerCoverageError).coverageResult);
        assert.equal((err as PactPlannerCoverageError).coverageResult.ok, false);
        return true;
      }
    );
  });
});

describe("PactPlanner: revisePactWithPlanner", () => {
  it("revises existing Pact based on feedback and increments version", async () => {
    const deathCert = createSampleDeathCertificate();
    const recordedEvents: EventInput[] = [];

    const prevMarkdown = `# Tasks
- [ ] T1. Fix M1
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1
- [ ] T2. Fix M2
  - role: soul-stitcher
  - depends: T1
  - files: src/index.js
  - accept: npm test
  - hard: no
  - rules: M2
`;

    const revisedMarkdown = `# Tasks
- [ ] T1. Fix M1 with hard flag
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: yes
  - rules: M1
- [ ] T2. Fix M2
  - role: soul-stitcher
  - depends: T1
  - files: src/index.js
  - accept: npm test
  - hard: yes
  - rules: M2
`;

    const result = await revisePactWithPlanner({
      runId: "run-revise-01",
      deathCertificate: deathCert,
      previousPact: prevMarkdown,
      previousVersion: 1,
      feedback: "Mark all tasks hard: yes",
      events: recordedEvents,
      plannerRunner: async () => revisedMarkdown,
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, 2);
    assert.equal(result.tasks[0].hard, true);
    assert.equal(result.tasks[1].hard, true);

    const revEvent = recordedEvents.find((e) => e.kind === "pact.revised");
    assert.ok(revEvent);
    assert.equal((revEvent.data as any).pactVersion, 2);
    assert.equal((revEvent.data as any).feedback, "Mark all tasks hard: yes");
  });

  it("fails closed on revision failure or coverage drop", async () => {
    const deathCert = createSampleDeathCertificate();

    await assert.rejects(
      async () =>
        revisePactWithPlanner({
          runId: "run-revise-fail",
          deathCertificate: deathCert,
          feedback: "Delete task T2",
          plannerRunner: async () => {
            // Uncovered M2
            return `# Tasks\n- [ ] T1. Only M1\n  - role: bonesetter\n  - depends:\n  - files: package.json\n  - accept: npm test\n  - hard: no\n  - rules: M1\n`;
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PactPlannerCoverageError);
        return true;
      }
    );
  });
});

describe("PactService.verifyDeathCertificateCoverage Integration", () => {
  it("verifies coverage correctly as a static method on PactService", () => {
    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Fix M1",
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
        ruleIds: ["M1"],
        rules: ["M1"],
        line: 1,
      },
    ];

    const coveredCert = { failures: [{ ruleId: "M1", file: "package.json" }] };
    const res1 = (PactService as any).verifyDeathCertificateCoverage(tasks, coveredCert);
    assert.equal(res1.ok, true);

    const uncoveredCert = { failures: [{ ruleId: "M99", file: "other.js" }] };
    const res2 = (PactService as any).verifyDeathCertificateCoverage(tasks, uncoveredCert);
    assert.equal(res2.ok, false);
    assert.equal(res2.uncoveredFailures.length, 1);
  });
});
