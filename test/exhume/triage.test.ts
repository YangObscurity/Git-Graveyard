/**
 * Unit tests for Exhume triage, Grimoire base analysis, and Death Certificate storage.
 * Requirements: 11.11, 11.12, 11.13, 11.15.
 * Task: 8.4.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  MODEL_TIER_HAIKU,
} from "../../lib/agents/model-allowlist";
import type { EventInput } from "../../lib/events/event-store";
import {
  formatDeathCertificateTable,
  isRepositoryHealthy,
  loadDeathCertificate,
  type BaselineCommandRow,
} from "../../lib/exhume/death-certificate";
import { ExhumerHarness } from "../../lib/exhume/exhume-harness";
import {
  EXHUMER_MODEL_ID,
  EXHUMER_MODEL_TIER,
  EXHUMER_ROLE,
  ExhumerTriageSession,
  buildExhumerTriagePrompt,
  checkEarlyCompletion,
  handleEarlyCompletion,
  parseHarnessLogs,
  persistDeathCertificate,
  runExhumerTriageSession,
  runGrimoireBaseAnalysis,
  runTriage,
  scanBaseTreeFiles,
} from "../../lib/exhume/triage";

describe("triage: Grimoire base analysis (Requirement 11.11)", () => {
  test("emits grimoire.signal and grimoire.summary events when signals are detected", async () => {
    const recordedEvents: EventInput[] = [];

    const files = [
      {
        path: "src/legacy.js",
        content: 'const request = require("request");\nconsole.log(request);',
        manifestDir: ".",
      },
      {
        path: "package.json",
        content: JSON.stringify({
          name: "test-legacy",
          dependencies: { request: "^2.88.2" },
        }),
        manifestDir: ".",
      },
    ];

    const result = await runGrimoireBaseAnalysis({
      runId: "run-grimoire-01",
      files,
      events: recordedEvents,
    });

    assert.ok(result.signalsCount >= 1);
    assert.ok(result.signals.some((s) => s.ruleId === "M2"));
    assert.ok(result.rules.includes("M2"));

    // Check grimoire.signal events
    const signalEvents = recordedEvents.filter((e) => e.kind === "grimoire.signal");
    assert.equal(signalEvents.length, result.signalsCount);
    for (const evt of signalEvents) {
      assert.equal(evt.actor, "grimoire");
      assert.equal(evt.runId, "run-grimoire-01");
      assert.ok(evt.data?.ruleId);
      assert.ok(evt.data?.file);
      assert.ok(evt.data?.matched);
      assert.ok(Array.isArray(evt.data?.refs));
      assert.ok(((evt.data?.refs as unknown[]) ?? []).length >= 1);
    }

    // Check grimoire.summary event
    const summaryEvent = recordedEvents.find((e) => e.kind === "grimoire.summary");
    assert.ok(summaryEvent);
    assert.equal(summaryEvent.actor, "grimoire");
    assert.equal(summaryEvent.data?.signalsCount, result.signalsCount);
    assert.ok(Array.isArray(summaryEvent.data?.rules));
    assert.ok(Array.isArray(summaryEvent.data?.refs));
  });

  test("emits grimoire.summary even when repository has 0 deprecation signals", async () => {
    const recordedEvents: EventInput[] = [];

    const files = [
      {
        path: "index.js",
        content: 'console.log("clean repository code");',
        manifestDir: ".",
      },
    ];

    const result = await runGrimoireBaseAnalysis({
      runId: "run-grimoire-clean",
      files,
      events: recordedEvents,
    });

    assert.equal(result.signalsCount, 0);
    assert.equal(result.rules.length, 0);

    const signalEvents = recordedEvents.filter((e) => e.kind === "grimoire.signal");
    assert.equal(signalEvents.length, 0);

    const summaryEvent = recordedEvents.find((e) => e.kind === "grimoire.summary");
    assert.ok(summaryEvent);
    assert.equal(summaryEvent.data?.signalsCount, 0);
    assert.ok(Array.isArray(summaryEvent.data?.refs));
  });

  test("scanBaseTreeFiles scans disk directory and ignores submodules and cache", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-scan-"));
    try {
      // Create regular files
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "src", "index.js"),
        'console.log("hello");',
        "utf8"
      );

      // Create ignored folder
      fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "node_modules", "pkg", "index.js"),
        'console.log("ignore me");',
        "utf8"
      );

      // Create submodule path and .gitmodules
      fs.mkdirSync(path.join(tmpDir, "vendor", "submodule"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "vendor", "submodule", "sub.js"),
        'console.log("submodule");',
        "utf8"
      );
      fs.writeFileSync(
        path.join(tmpDir, ".gitmodules"),
        '[submodule "vendor/submodule"]\n  path = vendor/submodule\n  url = https://github.com/example/sub\n',
        "utf8"
      );

      const scanned = scanBaseTreeFiles(tmpDir);

      assert.ok(scanned.some((f) => f.path === "src/index.js"));
      // node_modules excluded
      assert.ok(!scanned.some((f) => f.path.includes("node_modules")));
      // submodule excluded (Requirement 3.11)
      assert.ok(!scanned.some((f) => f.path.includes("vendor/submodule")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("triage: harness command log parsing and failure classification (Task 8.4)", () => {
  test("parses command execution rows and classifies standard failure types", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "version",
        command: "node --version",
        status: "passed",
        exitCode: 0,
      },
      {
        step: "install",
        command: "npm ci --ignore-scripts",
        status: "failed",
        exitCode: 1,
        logRef: "log-install-01",
        reason: "npm ERR! ERESOLVE unable to resolve dependency tree\nconflicting peer dependency",
      },
      {
        step: "build",
        command: "npm run build",
        status: "failed",
        exitCode: 2,
        logRef: "log-build-01",
        reason: "SyntaxError: Unexpected token import in file.js",
      },
      {
        step: "test",
        command: "npm test",
        status: "failed",
        exitCode: 1,
        logRef: "log-test-01",
        reason: "AssertionError: expected true to be false",
      },
    ];

    const classified = parseHarnessLogs(rows);

    assert.ok(classified.failureClasses.includes("install_failed"));
    assert.ok(classified.failureClasses.includes("peer_dependency_conflict"));
    assert.ok(classified.failureClasses.includes("build_failed"));
    assert.ok(classified.failureClasses.includes("syntax_error"));
    assert.ok(classified.failureClasses.includes("test_failed"));
    assert.ok(classified.failureClasses.includes("assertion_error"));

    assert.ok(classified.failures.length >= 4);
    assert.ok(classified.failures.some((f) => f.ref === "cmd:log-install-01"));
  });

  test("inspects full log content from log map", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "install",
        command: "npm install --ignore-scripts",
        status: "failed",
        exitCode: 1,
        logRef: "cmd-log-99",
      },
      {
        step: "build",
        command: "npm run build",
        status: "not run",
      },
      {
        step: "test",
        command: "npm test",
        status: "not run",
      },
    ];

    const logs = new Map<string, string>([
      [
        "cmd-log-99",
        "npm ERR! code MODULE_NOT_FOUND\nError: Cannot find module '@types/node'\n13 duplicate modules omitted",
      ],
    ]);

    const result = parseHarnessLogs(rows, logs);

    assert.ok(result.failureClasses.includes("install_failed"));
    assert.ok(result.failureClasses.includes("missing_dependency"));
    assert.ok(result.failures.some((f) => f.class === "missing_dependency"));
  });
});

describe("triage: Exhumer triage session targeting Claude Haiku 5.5 (Requirement 11.12)", () => {
  test("targets Claude Haiku 5.5 model ID and role exhumer", () => {
    const session = new ExhumerTriageSession({
      runId: "run-target-test",
      baseSha: "sha-target-1",
      rows: [],
    });

    assert.equal(session.getTargetRole(), EXHUMER_ROLE);
    assert.equal(session.getTargetRole(), "exhumer");
    assert.equal(session.getTargetModel(), EXHUMER_MODEL_ID);
    assert.equal(session.getTargetModel(), CLAUDE_HAIKU_5_5_MODEL_ID);
    assert.equal(session.getTargetTier(), EXHUMER_MODEL_TIER);
    assert.equal(session.getTargetTier(), MODEL_TIER_HAIKU);
  });

  test("builds structured prompt containing baseline table and failure excerpts", () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "version",
        command: "node --version",
        status: "passed",
        exitCode: 0,
      },
      {
        step: "install",
        command: "npm ci --ignore-scripts",
        status: "failed",
        exitCode: 1,
        logRef: "ref-01",
        reason: "Missing dependency express",
      },
      {
        step: "build",
        command: "npm run build",
        status: "not run",
        reason: "install failed",
      },
      {
        step: "test",
        command: "npm test",
        status: "not run",
        reason: "install failed",
      },
    ];

    const promptPayload = buildExhumerTriagePrompt({
      runId: "run-prompt-test",
      baseSha: "sha-prompt-1",
      primaryLanguage: "node",
      packageManager: "npm",
      rows,
      failureClasses: ["install_failed", "missing_dependency"],
      failures: [
        {
          class: "missing_dependency",
          step: "install",
          message: "Missing dependency express",
          ref: "cmd:ref-01",
        },
      ],
    });

    assert.equal(promptPayload.role, "exhumer");
    assert.equal(promptPayload.modelId, "claude-haiku-5.5");
    assert.equal(promptPayload.modelTier, "Claude Haiku 5.5");
    assert.ok(promptPayload.prompt.includes("sha-prompt-1"));
    assert.ok(promptPayload.prompt.includes("node --version"));
    assert.ok(promptPayload.prompt.includes("missing_dependency"));
    assert.ok(promptPayload.prompt.includes("Missing dependency express"));
  });

  test("synthesizes findings into DeathCertificate with deterministic classification", async () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "version",
        command: "node --version",
        status: "passed",
        exitCode: 0,
      },
      {
        step: "install",
        command: "npm ci --ignore-scripts",
        status: "failed",
        exitCode: 1,
        logRef: "ref-inst",
        reason: "Cannot find module react",
      },
      {
        step: "build",
        command: "npm run build",
        status: "not run",
        reason: "install failed",
      },
      {
        step: "test",
        command: "npm test",
        status: "not run",
        reason: "install failed",
      },
    ];

    const result = await runExhumerTriageSession({
      runId: "run-synth-01",
      baseSha: "sha-synth-01",
      primaryLanguage: "node",
      packageManager: "npm",
      rows,
    });

    assert.ok(result.deathCertificate);
    assert.equal(result.deathCertificate.baseSha, "sha-synth-01");
    assert.equal(result.deathCertificate.healthy, false);
    assert.ok(result.failureClasses.includes("install_failed"));
    assert.ok(result.failureClasses.includes("missing_dependency"));
    assert.ok(result.deathCertificate.sha256);
    assert.ok(result.summary.length > 0);
  });

  test("uses injected model synthesizer when provided", async () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "install",
        command: "npm install",
        status: "failed",
        exitCode: 1,
      },
      {
        step: "build",
        command: "npm run build",
        status: "not run",
      },
      {
        step: "test",
        command: "npm test",
        status: "not run",
      },
    ];

    let synthesizerCalled = false;
    const mockSynthesizer = async (prompt: string) => {
      synthesizerCalled = true;
      assert.ok(prompt.includes("Exhumer"));
      return {
        failureClasses: ["synthesized_custom_failure"],
        failures: [
          {
            class: "synthesized_custom_failure",
            step: "install" as const,
            message: "Custom synthesized failure message",
          },
        ],
        summary: "Synthesized by Claude Haiku 5.5 model session",
      };
    };

    const sessionRes = await runExhumerTriageSession({
      runId: "run-synth-custom",
      baseSha: "sha-synth-custom",
      rows,
      synthesizer: mockSynthesizer,
    });

    assert.equal(synthesizerCalled, true);
    assert.ok(sessionRes.failureClasses.includes("synthesized_custom_failure"));
    assert.equal(
      sessionRes.summary,
      "Synthesized by Claude Haiku 5.5 model session"
    );
    assert.equal(
      sessionRes.deathCertificate.summary,
      "Synthesized by Claude Haiku 5.5 model session"
    );
  });

  test("verifies session supervisor model and rejects mismatch", async () => {
    const mockSupervisorWithWrongModel = {
      getVerifiedModel() {
        return CLAUDE_OPUS_5_5_MODEL_ID; // Opus instead of Haiku
      },
    };

    const session = new ExhumerTriageSession({
      runId: "run-model-check",
      baseSha: "sha-check-1",
      rows: [],
      supervisor: mockSupervisorWithWrongModel,
    });

    const check = session.verifySessionModel();
    assert.equal(check.ok, false);
    assert.ok(check.error?.includes("does not match Exhumer assigned tier"));

    await assert.rejects(
      async () => {
        await session.runTriageSession();
      },
      /Model verification failed/
    );
  });
});

describe("triage: Death Certificate persistence and event emission (Requirement 11.13)", () => {
  test("persists death certificate to disk and emits exhume.certificate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-persist-"));
    const recordedEvents: EventInput[] = [];

    try {
      const rows: BaselineCommandRow[] = [
        {
          step: "install",
          command: "npm ci",
          status: "passed",
        },
        {
          step: "build",
          command: "npm run build",
          status: "passed",
        },
        {
          step: "test",
          command: "npm test",
          status: "passed",
        },
      ];

      const triageRes = await runExhumerTriageSession({
        runId: "run-persist-01",
        baseSha: "sha-persist-1",
        primaryLanguage: "node",
        packageManager: "npm",
        rows,
      });

      const cert = triageRes.deathCertificate;
      const targetPath = path.join(tmpDir, "death-certificate.json");

      const persistRes = await persistDeathCertificate(cert, {
        filePath: targetPath,
        events: recordedEvents,
      });

      assert.equal(persistRes.filePath, targetPath);
      assert.ok(fs.existsSync(targetPath));

      // Verify certificate can be read back and matches sha256
      const loaded = await loadDeathCertificate(targetPath);
      assert.equal(loaded.baseSha, "sha-persist-1");
      assert.equal(loaded.sha256, cert.sha256);
      assert.equal(loaded.healthy, true);

      // Verify exhume.certificate event (Requirement 11.13)
      assert.equal(recordedEvents.length, 1);
      const evt = recordedEvents[0];
      assert.equal(evt.kind, "exhume.certificate");
      assert.equal(evt.actor, "exhumer");
      assert.equal(evt.data?.baseSha, "sha-persist-1");
      assert.equal(evt.data?.healthy, true);
      assert.equal(evt.data?.sha256, cert.sha256);
      assert.deepEqual(evt.data?.refs, [`cert:${cert.sha256}`]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("triage: early completion with healthy_already (Requirement 11.15)", () => {
  test("returns healthy_already when install, build and tests pass and user stops", async () => {
    const rows: BaselineCommandRow[] = [
      {
        step: "install",
        command: "npm ci",
        status: "passed",
      },
      {
        step: "build",
        command: "npm run build",
        status: "passed",
      },
      {
        step: "test",
        command: "npm test",
        status: "passed",
      },
    ];

    const sessionRes = await runExhumerTriageSession({
      runId: "run-healthy-stop",
      baseSha: "sha-healthy-1",
      rows,
    });

    const cert = sessionRes.deathCertificate;
    assert.equal(cert.healthy, true);

    const recordedEvents: EventInput[] = [];

    // User chooses "Stop here" (Requirement 11.15)
    const earlyRes = await handleEarlyCompletion(cert, {
      userChoice: "Stop here",
      events: recordedEvents,
    });

    assert.equal(earlyRes.shouldCompleteEarly, true);
    assert.equal(earlyRes.outcome, "healthy_already");

    // Check event emission
    assert.equal(recordedEvents.length, 1);
    const evt = recordedEvents[0];
    assert.equal(evt.kind, "run.phase");
    assert.equal(evt.actor, "necromancer");
    assert.equal(evt.data?.phase, "done");
    assert.equal(evt.data?.outcome, "healthy_already");
  });

  test("accepts userStop: true or stopHere: true for healthy_already", () => {
    const rows: BaselineCommandRow[] = [
      { step: "install", command: "npm ci", status: "passed" },
      { step: "build", command: "npm run build", status: "passed" },
      { step: "test", command: "npm test", status: "passed" },
    ];

    const cert = {
      healthy: true,
      install: rows[0],
      build: rows[1],
      test: rows[2],
    } as any;

    const checkStop = checkEarlyCompletion(cert, { userStop: true });
    assert.equal(checkStop.shouldCompleteEarly, true);
    assert.equal(checkStop.outcome, "healthy_already");

    const checkHere = checkEarlyCompletion(cert, { stopHere: true });
    assert.equal(checkHere.shouldCompleteEarly, true);
    assert.equal(checkHere.outcome, "healthy_already");
  });

  test("does NOT complete early with healthy_already if repository has failures", async () => {
    const rows: BaselineCommandRow[] = [
      { step: "install", command: "npm ci", status: "failed", exitCode: 1 },
      { step: "build", command: "npm run build", status: "not run" },
      { step: "test", command: "npm test", status: "not run" },
    ];

    const sessionRes = await runExhumerTriageSession({
      runId: "run-failed-stop",
      baseSha: "sha-failed-1",
      rows,
    });

    const cert = sessionRes.deathCertificate;
    assert.equal(cert.healthy, false);

    const earlyRes = await handleEarlyCompletion(cert, {
      userChoice: "Stop here",
    });

    assert.equal(earlyRes.shouldCompleteEarly, false);
    assert.equal(earlyRes.outcome, undefined);
  });

  test("does NOT complete early if healthy but user does not stop", async () => {
    const rows: BaselineCommandRow[] = [
      { step: "install", command: "npm ci", status: "passed" },
      { step: "build", command: "npm run build", status: "passed" },
      { step: "test", command: "npm test", status: "passed" },
    ];

    const sessionRes = await runExhumerTriageSession({
      runId: "run-healthy-continue",
      baseSha: "sha-healthy-cont",
      rows,
    });

    const cert = sessionRes.deathCertificate;
    assert.equal(cert.healthy, true);

    const earlyRes = await handleEarlyCompletion(cert, {
      userStop: false,
    });

    assert.equal(earlyRes.shouldCompleteEarly, false);
    assert.equal(earlyRes.outcome, undefined);
  });
});

describe("triage: runTriage full orchestration (Task 8.4)", () => {
  test("orchestrates Grimoire analysis, Haiku 5.5 session, certificate persistence, and early completion", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "full-triage-"));
    const recordedEvents: EventInput[] = [];

    try {
      const files = [
        {
          path: "app.js",
          content: 'const request = require("request");\nconsole.log(request);',
        },
      ];

      const rows: BaselineCommandRow[] = [
        { step: "install", command: "npm ci --ignore-scripts", status: "passed" },
        { step: "build", command: "npm run build", status: "passed" },
        { step: "test", command: "npm test", status: "passed" },
      ];

      const triageResult = await runTriage({
        runId: "run-full-01",
        baseSha: "sha-full-1",
        primaryLanguage: "node",
        packageManager: "npm",
        rows,
        files,
        enableGrimoire: true,
        saveCertificate: true,
        storageDir: tmpDir,
        userChoice: "Stop here",
        events: recordedEvents,
      });

      // 1. Grimoire signals detected (Requirement 11.11)
      assert.ok(triageResult.signals.length >= 1);
      assert.ok(recordedEvents.some((e) => e.kind === "grimoire.signal"));
      assert.ok(recordedEvents.some((e) => e.kind === "grimoire.summary"));

      // 2. Exhumer session synthesized Death Certificate (Requirement 11.12)
      assert.ok(triageResult.deathCertificate);
      assert.equal(triageResult.deathCertificate.baseSha, "sha-full-1");

      // 3. Persisted certificate file and emitted exhume.certificate (Requirement 11.13)
      assert.ok(triageResult.certificatePath);
      assert.ok(fs.existsSync(triageResult.certificatePath));
      assert.ok(recordedEvents.some((e) => e.kind === "exhume.certificate"));

      // 4. Early completion with healthy_already (Requirement 11.15)
      assert.equal(triageResult.earlyCompletion.shouldCompleteEarly, true);
      assert.equal(triageResult.outcome, "healthy_already");
      assert.ok(
        recordedEvents.some(
          (e) => e.kind === "run.phase" && e.data?.outcome === "healthy_already"
        )
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("triage: ExhumerHarness integration with Grimoire and early completion", () => {
  test("ExhumerHarness with enableGrimoire emits grimoire events", async () => {
    const recordedEvents: EventInput[] = [];
    const mockRunner = async () => ({ exitCode: 0 });

    const harness = new ExhumerHarness({
      runId: "run-harness-grimoire",
      baseSha: "sha-hg-1",
      wallClockTimeoutMs: 60000,
      enableGrimoire: true,
      files: [
        {
          path: "server.js",
          content: 'const request = require("request");',
        },
        {
          path: "package.json",
        },
      ],
      packageJson: {
        name: "test-hg",
        scripts: { test: "exit 0" },
      },
      runner: mockRunner,
      events: recordedEvents,
    });

    const result = await harness.execute();

    assert.ok(result.signals);
    assert.ok(result.signals.length >= 1);
    assert.ok(recordedEvents.some((e) => e.kind === "grimoire.signal"));
    assert.ok(recordedEvents.some((e) => e.kind === "grimoire.summary"));
    assert.ok(recordedEvents.some((e) => e.kind === "exhume.certificate"));
  });

  test("ExhumerHarness with userChoice 'Stop here' sets outcome to healthy_already", async () => {
    const recordedEvents: EventInput[] = [];
    const mockRunner = async () => ({ exitCode: 0 });

    const harness = new ExhumerHarness({
      runId: "run-harness-stop",
      baseSha: "sha-hs-1",
      wallClockTimeoutMs: 60000,
      userChoice: "Stop here",
      packageJson: {
        name: "test-hs",
        scripts: { test: "node -e 'process.exit(0)'" },
      },
      files: ["package.json"],
      runner: mockRunner,
      events: recordedEvents,
    });

    const result = await harness.execute();

    assert.equal(result.healthy, true);
    assert.equal(result.outcome, "healthy_already");
    assert.equal(result.earlyCompleted, true);

    const doneEvent = recordedEvents.find(
      (e) => e.kind === "run.phase" && e.data?.outcome === "healthy_already"
    );
    assert.ok(doneEvent);
  });
});
