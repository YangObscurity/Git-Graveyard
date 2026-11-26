/**
 * Planner coverage retry: when the first Pact does not cover every DeathCertificate
 * failure, the live session is asked once to fix it. The final coverage gate stays fail-closed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RunOrchestrator } from "../../lib/orchestrator/run-orchestrator";
import {
  buildCoverageRetryPrompt,
  buildPlannerPrompt,
  generatePactWithPlanner,
  PactPlannerCoverageError,
} from "../../lib/pact/pact-planner";
import { validateCandidateFiles } from "../../lib/security/scope-check";

const TEST_FAILURE_REF = "cmd:exhume-run-retry-test-1700000000000";

function createDeathCertificate() {
  return {
    schemaVersion: "v1" as const,
    baseSha: "abc1234",
    runId: "run-retry-01",
    primaryLanguage: "javascript" as const,
    packageManager: "npm" as const,
    createdAt: "2026-11-23T00:00:00.000Z",
    healthy: false,
    failureClasses: ["test_failure"],
    summary: "Tests fail on the baseline.",
    failures: [
      {
        class: "test_failure",
        step: "test" as const,
        message: "npm test exited with code 1",
        file: TEST_FAILURE_REF,
      },
    ],
    rows: [],
    runtimes: [],
    install: { step: "install" as const, command: "npm install", status: "passed" as const },
    build: { step: "build" as const, command: "npm run build", status: "passed" as const },
    test: { step: "test" as const, command: "npm test", status: "failed" as const },
  };
}

const UNCOVERED_PACT = `# Tasks
- [ ] T1. Refresh lockfile
  - role: bonesetter
  - depends:
  - files: package-lock.json
  - accept: npm install
  - hard: no
  - rules: M2
`;

const COVERED_PACT = `# Tasks
- [ ] T1. Fix failing test run
  - role: soul-stitcher
  - depends:
  - files: package.json, test/index.js
  - accept: npm test
  - hard: no
  - rules: M2
`;

function createRecordingClient(replies: string[]) {
  const prompts: string[] = [];
  return {
    prompts,
    client: {
      async prompt(text: string): Promise<string> {
        prompts.push(text);
        return replies[Math.min(prompts.length - 1, replies.length - 1)];
      },
    },
  };
}

describe("buildPlannerPrompt: failure references", () => {
  it("guides matching by step keyword without telling the planner to put only cmd: refs in files:", () => {
    const prompt = buildPlannerPrompt({
      runId: "run-retry-01",
      deathCertificate: createDeathCertificate(),
    });

    assert.match(prompt, /step keyword/i);
    assert.match(prompt, /never list only a `cmd:` reference/i);
    assert.ok(prompt.includes("(test)"));
    assert.ok(prompt.includes(TEST_FAILURE_REF));
  });
});

describe("buildCoverageRetryPrompt", () => {
  it("lists each uncovered failure, explains step matching, and preserves real files: paths", () => {
    const prompt = buildCoverageRetryPrompt([
      { file: TEST_FAILURE_REF, stage: "test", message: "npm test exited with code 1" },
      { ruleId: "M4" },
    ]);

    assert.ok(prompt.includes('step "test"'));
    assert.ok(prompt.includes(TEST_FAILURE_REF));
    assert.ok(prompt.includes("M4"));
    assert.match(prompt, /step keyword/i);
    assert.match(prompt, /files:/);
    assert.match(prompt, /never replace them with only a `cmd:` reference/i);
    assert.match(prompt, /complete Pact/i);
  });
});

describe("generatePactWithPlanner: coverage retry", () => {
  it("asks once more and accepts the corrected Pact without breaking filesInScope", async () => {
    const { client, prompts } = createRecordingClient([UNCOVERED_PACT, COVERED_PACT]);

    const result = await generatePactWithPlanner({
      runId: "run-retry-01",
      deathCertificate: createDeathCertificate(),
      sessionClient: client,
    });

    assert.equal(result.ok, true);
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes(TEST_FAILURE_REF), "retry prompt names the uncovered failure");
    assert.equal(
      validateCandidateFiles(["package.json", "test/index.js"], {
        filesInScope: result.tasks[0].files,
      }).passed,
      true
    );
  });

  it("does not retry when the first Pact already covers every failure", async () => {
    const { client, prompts } = createRecordingClient([COVERED_PACT]);

    await generatePactWithPlanner({
      runId: "run-retry-01",
      deathCertificate: createDeathCertificate(),
      sessionClient: client,
    });

    assert.equal(prompts.length, 1);
  });

  it("still fails closed after one retry when coverage is missing again", async () => {
    const { client, prompts } = createRecordingClient([UNCOVERED_PACT, UNCOVERED_PACT]);

    await assert.rejects(
      generatePactWithPlanner({
        runId: "run-retry-01",
        deathCertificate: createDeathCertificate(),
        sessionClient: client,
      }),
      (err: unknown) => err instanceof PactPlannerCoverageError
    );
    assert.equal(prompts.length, 2, "exactly one retry, never more");
  });

  it("live session client does not re-read stale spec/tasks.md on retry when chunks provide the updated Pact", async () => {
    const plannerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gg-planner-retry-cwd-"));
    try {
      const orchestrator = new RunOrchestrator({
        host: {} as any,
        runsDir: plannerCwd,
      });
      const chunks: string[] = [];
      let dispatches = 0;
      const mockSupervisor = {
        async dispatchTask() {
          dispatches += 1;
          if (dispatches === 1) {
            const specDir = path.join(plannerCwd, "spec");
            fs.mkdirSync(specDir, { recursive: true });
            fs.writeFileSync(path.join(specDir, "tasks.md"), UNCOVERED_PACT, "utf-8");
          } else {
            chunks.push(`\`\`\`markdown\n${COVERED_PACT}\`\`\``);
          }
          return { status: "completed" };
        },
      };

      const sessionClient = (orchestrator as any).createLivePlannerSessionClient(
        mockSupervisor,
        plannerCwd,
        chunks,
        createDeathCertificate()
      );

      const result = await generatePactWithPlanner({
        runId: "run-retry-01",
        deathCertificate: createDeathCertificate(),
        sessionClient,
      });

      assert.equal(result.ok, true);
      assert.equal(dispatches, 2);
      assert.equal(result.tasks[0].title, "Fix failing test run");
    } finally {
      fs.rmSync(plannerCwd, { recursive: true, force: true });
    }
  });
});
