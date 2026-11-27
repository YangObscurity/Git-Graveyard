import test from "node:test";
import assert from "node:assert/strict";

import { RunStore } from "../../lib/runs/run-store";
import { EventStore } from "../../lib/events/event-store";
import {
  STATUS_KEYWORDS,
  EvidenceIndex,
  buildEvidenceIndex,
  checkReading,
  extractMarkers,
  splitSentences,
  runReportCheckWithRetry,
  redactAllStringLeaves,
  assignRunOutcomeWithInstallComparison,
} from "../../lib/scribe/report-check";
import {
  ScribeService,
  renderFindingsMarkdown,
  deriveTaskStates,
  isFinalCheckComplete,
} from "../../lib/scribe/scribe-service";
import { SCRIBE_NARRATIVE_FALLBACK_NOTICE } from "../../lib/lifecycle/report-step";
import { Redactor } from "../../lib/security/redactor";

function makeStores() {
  const runStore = new RunStore(":memory:");
  const eventStore = new EventStore(":memory:");
  return { runStore, eventStore };
}

test("report-check: deterministic Findings rendering uses no model output", () => {
  const { runStore, eventStore } = makeStores();
  runStore.createRun({
    runId: "run-findings",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "report",
  });
  eventStore.append({
    runId: "run-findings",
    kind: "task.state",
    actor: "test",
    data: { taskId: "task-1", state: "merged", refs: ["cmd:build"] },
  });
  eventStore.append({
    runId: "run-findings",
    kind: "command.result",
    actor: "test",
    data: { id: "build", exitCode: 0, refs: [] },
  });

  const run = runStore.getRun("run-findings")!;
  const events = eventStore.getEvents("run-findings");
  const first = renderFindingsMarkdown(run, events);
  const second = renderFindingsMarkdown(run, events);

  assert.equal(first, second);
  assert.ok(first.startsWith("## Findings"));
  assert.ok(first.includes("`task-1`: merged (ev:1)"));
  assert.ok(first.includes("`cmd:build` (ev:1)"));
  assert.deepEqual(deriveTaskStates(events), [
    { id: "task-1", state: "merged", seq: 1 },
  ]);
});

test("report-check: ScribeService rejects premature invocation before final_check completes", async () => {
  const { runStore, eventStore } = makeStores();
  runStore.createRun({
    runId: "run-premature",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "legion",
  });
  const service = new ScribeService({ runStore, eventStore });

  assert.equal(service.canRun("run-premature").ok, false);
  await assert.rejects(
    () => service.run({ runId: "run-premature" }),
    (err) => (err as { reason?: string }).reason === "final_check_incomplete"
  );

  const run = runStore.getRun("run-premature")!;
  assert.equal(isFinalCheckComplete(run, eventStore.getEvents("run-premature")), false);
});

test("report-check: extracts and resolves cmd:/file:/gh:/ev: markers", () => {
  assert.deepEqual(extractMarkers("see cmd:build and ev:2"), ["cmd:build", "ev:2"]);
  assert.ok((STATUS_KEYWORDS as readonly string[]).includes("not run"));
  assert.ok((STATUS_KEYWORDS as readonly string[]).includes("resurrected"));

  const index = buildEvidenceIndex({
    commandResults: [{ id: "build" }],
    files: ["src/app.ts"],
    github: ["owner/repo#1"],
    events: [
      { runId: "r", seq: 2, ts: 0, kind: "command.result", actor: "a", data: { refs: [] } },
    ],
  });

  assert.equal(index.resolve("cmd:build"), true);
  assert.equal(index.resolve("file:src/app.ts:12"), true);
  assert.equal(index.resolve("gh:owner/repo#1"), true);
  assert.equal(index.resolve("ev:2"), true);
  assert.equal(index.resolve("cmd:missing"), false);

  const ok = checkReading(
    "Built 3 files (file:src/app.ts). Merged into the fork (gh:owner/repo#1). Build passed (cmd:build) and recorded 2 events (ev:2).",
    index
  );
  assert.equal(ok.passed, true);
  assert.equal(ok.checkedCount >= 3, true);
  assert.ok(ok.resolvedMarkers.includes("cmd:build"));
  assert.ok(ok.resolvedMarkers.includes("ev:2"));
});

test("report-check: rejects unbacked numerals, status words and fabricated markers", () => {
  const index = buildEvidenceIndex({ commandResults: [{ id: "build" }] });

  const numeral = checkReading("There were 5 tests.", index);
  assert.equal(numeral.passed, false);
  assert.ok(numeral.unbackedClaims.some((c) => c.claim === "numeral"));

  const status = checkReading("Build passed.", index);
  assert.equal(status.passed, false);
  assert.ok(status.unbackedClaims.some((c) => c.claim === "passed"));

  const fake = checkReading("Merged 4 tasks (ev:999).", index);
  assert.equal(fake.passed, false);
  assert.ok(fake.unbackedClaims.some((c) => c.ref === "ev:999"));

  const fakeCmd = checkReading("Build failed (cmd:nope).", index);
  assert.equal(fakeCmd.passed, false);
  assert.ok(fakeCmd.unbackedClaims.some((c) => c.ref === "cmd:nope"));
});

test("report-check: single retry then pass emits a report.checked event", async () => {
  const { eventStore } = makeStores();
  const index = buildEvidenceIndex({ commandResults: [{ id: "build" }] });
  const retryCalls: number[] = [];

  const result = await runReportCheckWithRetry({
    reading: "Build passed.",
    index,
    retry: (unbackedClaims) => {
      retryCalls.push(unbackedClaims.length);
      return "Build passed (cmd:build).";
    },
    eventStore,
    runId: "run-retry",
  });

  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0], 1);
  assert.equal(result.passed, true);
  assert.equal(result.retried, true);
  assert.equal(result.narrativeDropped, false);
  assert.equal(result.reading, "Build passed (cmd:build).");

  const events = eventStore.getEvents("run-retry", { kind: "report.checked" });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.passed, true);
  assert.equal(events[0].data.retried, true);
  assert.equal(events[0].data.narrativeDropped, false);
});

test("report-check: drops the reading and substitutes the fallback on the second failure", async () => {
  const { eventStore } = makeStores();
  const index = buildEvidenceIndex({ commandResults: [{ id: "build" }] });
  let calls = 0;

  const result = await runReportCheckWithRetry({
    reading: "Build passed.",
    index,
    retry: () => {
      calls++;
      return "Still failed.";
    },
    eventStore,
    runId: "run-drop",
  });

  assert.equal(calls, 1);
  assert.equal(result.narrativeDropped, true);
  assert.equal(result.passed, false);
  assert.equal(result.reading, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
  assert.equal(result.fallbackNotice, SCRIBE_NARRATIVE_FALLBACK_NOTICE);

  const events = eventStore.getEvents("run-drop", { kind: "report.checked" });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.passed, false);
  assert.equal(events[0].data.narrativeDropped, true);
  assert.equal(events[0].data.fallbackNotice, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
});

test("report-check: a throwing retry is still invoked only once and drops the reading", async () => {
  const { eventStore } = makeStores();
  const index = new EvidenceIndex();
  let calls = 0;
  const result = await runReportCheckWithRetry({
    reading: "Build failed.",
    index,
    retry: () => {
      calls++;
      throw new Error("retry exploded");
    },
    eventStore,
    runId: "run-throw",
  });
  assert.equal(calls, 1);
  assert.equal(result.narrativeDropped, true);
  assert.equal(result.reading, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
  assert.equal(result.fallbackNotice, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
  assert.equal(result.passed, false);
});

test("report-check: assigns the outcome with side-by-side baseline vs new install errors", () => {
  const ok = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true },
    baselineInstallError: "npm ERR! baseline install failed",
    newInstallError: { command: "npm ci", exitCode: 1, error: "lockfile mismatch", ref: "cmd:install" },
  });
  assert.equal(ok.outcome, "resurrected");
  assert.equal(ok.installComparison.hasInstallErrors, true);
  assert.equal(ok.installComparison.rows.length, 2);
  assert.equal(ok.installComparison.baseline?.context, "baseline");
  assert.equal(ok.installComparison.new?.context, "new");
  assert.equal(ok.installComparison.new?.exitCode, 1);
  assert.equal(ok.installComparison.new?.ref, "cmd:install");

  const failed = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: false },
    newInstallError: { command: "npm ci", exitCode: 1, error: "still failing" },
  });
  assert.equal(failed.outcome, "not_resurrected");
  assert.equal(failed.installComparison.hasInstallErrors, true);
  assert.equal(failed.installComparison.new?.context, "new");

  const noErrors = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: true, buildPassed: false, testsPassed: false, hasTests: true },
  });
  assert.equal(noErrors.outcome, "partial");
  assert.equal(noErrors.installComparison.hasInstallErrors, false);
});

test("report-check: ScribeService renders Findings and verifies the reading end-to-end", async () => {
  const { runStore, eventStore } = makeStores();
  runStore.createRun({
    runId: "run-svc",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "report",
  });
  eventStore.append({
    runId: "run-svc",
    kind: "task.state",
    actor: "test",
    data: { taskId: "task-1", state: "merged", refs: ["cmd:build"] },
  });
  eventStore.append({
    runId: "run-svc",
    kind: "final_check.result",
    actor: "test",
    data: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true, refs: [] },
  });

  const service = new ScribeService({ runStore, eventStore });
  const result = await service.run({ runId: "run-svc" });

  assert.ok(result.findingsMarkdown.includes("## Findings"));
  assert.equal(result.narrativeDropped, false);
  assert.equal(result.fallbackNotice, null);
  assert.equal(result.reportCheck.passed, true);
  assert.equal(result.outcome, "resurrected");
  assert.equal(result.installComparison.hasInstallErrors, false);
  assert.ok(result.scribeReading.includes("ev:2"));
});

test("report-check: ScribeService retries once then accepts the repaired reading", async () => {
  const { runStore, eventStore } = makeStores();
  runStore.createRun({
    runId: "run-svc-retry",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "report",
  });
  eventStore.append({
    runId: "run-svc-retry",
    kind: "final_check.result",
    actor: "test",
    data: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true, refs: [] },
  });

  const readings = ["Build passed.", "Build passed (ev:1)."];
  let index = 0;
  const service = new ScribeService({
    runStore,
    eventStore,
    scribeRunner: () => readings[index++] ?? null,
  });
  const result = await service.run({ runId: "run-svc-retry" });

  assert.equal(result.narrativeDropped, false);
  assert.equal(result.scribeReading, "Build passed (ev:1).");
});

test("report-check: ScribeService drops the reading when it fails twice", async () => {
  const { runStore, eventStore } = makeStores();
  runStore.createRun({
    runId: "run-svc-drop",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "report",
  });
  eventStore.append({
    runId: "run-svc-drop",
    kind: "final_check.result",
    actor: "test",
    data: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true, refs: [] },
  });

  const service = new ScribeService({
    runStore,
    eventStore,
    scribeRunner: () => "Build passed.",
  });
  const result = await service.run({ runId: "run-svc-drop" });

  assert.equal(result.narrativeDropped, true);
  assert.equal(result.scribeReading, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
  assert.equal(result.fallbackNotice, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
});

test("report-check: install error rows redact secret tokens and keys", () => {
  const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const skToken = "sk-abcdefghijklmnopqrstuvwxyz012345";

  const result = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true },
    baselineInstallError: `npm ERR! baseline install failed with ${ghToken}`,
    newInstallError: {
      command: "npm ci",
      exitCode: 1,
      error: `auth failed using ${skToken}`,
      ref: "cmd:install",
    },
  });

  assert.equal(result.installComparison.hasInstallErrors, true);
  assert.ok(!String(result.installComparison.baseline?.error).includes(ghToken));
  assert.ok(!String(result.installComparison.new?.error).includes(skToken));
  assert.ok(String(result.installComparison.baseline?.error).includes("[REDACTED]"));
  assert.ok(String(result.installComparison.new?.error).includes("[REDACTED]"));
  // Non-secret fields keep passing through untouched.
  assert.equal(result.installComparison.new?.ref, "cmd:install");
  assert.equal(result.installComparison.new?.exitCode, 1);
});

test("report-check: a caller-supplied redactor is honored for install error text", () => {
  const redactor = new Redactor({ autoRegisterEnvSecrets: false });
  const customSecret = "custom-install-secret-value";
  redactor.registerSecret(customSecret);

  const result = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true },
    newInstallError: {
      command: "npm ci",
      exitCode: 1,
      stderr: `leaked ${customSecret} while installing`,
    },
    redactor,
  });

  assert.equal(result.installComparison.hasInstallErrors, true);
  assert.ok(!String(result.installComparison.new?.error).includes(customSecret));
  assert.ok(String(result.installComparison.new?.error).includes("[REDACTED]"));
});

test("report-check: raw unsupported markers never resolve against the evidence index", () => {
  const index = buildEvidenceIndex({
    commandResults: [{ id: "build", ref: "bogus:x" }],
    markers: ["bogus:x", "weird:y"],
  });

  assert.equal(index.resolve("bogus:x"), false);
  assert.equal(index.resolve("weird:y"), false);

  const reading = checkReading("Merged 5 tasks (bogus:x).", index);
  assert.equal(reading.passed, false);
  assert.ok(reading.unbackedClaims.length > 0);
  assert.ok(!reading.resolvedMarkers.includes("bogus:x"));
});

test("report-check: an empty Scribe runner reading fails and substitutes the fallback notice", async () => {
  const { runStore, eventStore } = makeStores();
  runStore.createRun({
    runId: "run-empty",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "report",
  });
  eventStore.append({
    runId: "run-empty",
    kind: "final_check.result",
    actor: "test",
    data: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true, refs: [] },
  });

  const service = new ScribeService({
    runStore,
    eventStore,
    scribeRunner: () => "",
  });
  const result = await service.run({ runId: "run-empty" });

  assert.equal(result.narrativeDropped, true);
  assert.equal(result.scribeReading, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
  assert.equal(result.fallbackNotice, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
  assert.equal(result.reportCheck.passed, false);

  // A runner that throws must also be treated as a failed reading.
  runStore.createRun({
    runId: "run-throws-runner",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "report",
  });
  eventStore.append({
    runId: "run-throws-runner",
    kind: "final_check.result",
    actor: "test",
    data: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true, refs: [] },
  });
  const throwingService = new ScribeService({
    runStore,
    eventStore,
    scribeRunner: () => {
      throw new Error("runner exploded");
    },
  });
  const thrown = await throwingService.run({ runId: "run-throws-runner" });
  assert.equal(thrown.narrativeDropped, true);
  assert.equal(thrown.scribeReading, SCRIBE_NARRATIVE_FALLBACK_NOTICE);
  assert.equal(thrown.reportCheck.passed, false);
});

test("report-check: install error command text is redacted alongside the error", () => {
  const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  const result = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: false },
    newInstallError: {
      command: `npm ci --token ${ghToken}`,
      exitCode: 1,
      error: "install failed",
    },
  });

  const command = String(result.installComparison.new?.command ?? "");
  assert.ok(!command.includes(ghToken));
  assert.ok(command.includes("[REDACTED]"));
});

test("report-check: ScribeService applies the injected redactor to installComparison and report.checked", async () => {
  const { runStore, eventStore } = makeStores();
  runStore.createRun({
    runId: "run-svc-redactor",
    url: "https://github.com/owner/repo",
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    phase: "report",
  });
  eventStore.append({
    runId: "run-svc-redactor",
    kind: "final_check.result",
    actor: "test",
    data: { installPassed: true, buildPassed: true, testsPassed: true, hasTests: true, refs: [] },
  });

  const redactor = new Redactor({ autoRegisterEnvSecrets: false });
  const secret = "scribe-custom-secret-xyz-987654";
  redactor.registerSecret(secret);

  const service = new ScribeService({
    runStore,
    eventStore,
    redactor,
    scribeRunner: () => `Build failed with ${secret} (cmd:missing).`,
  });
  const result = await service.run({
    runId: "run-svc-redactor",
    newInstallError: {
      command: `npm ci --secret ${secret}`,
      exitCode: 1,
      error: `install failed with ${secret}`,
    },
  });

  assert.equal(result.installComparison.hasInstallErrors, true);
  assert.ok(!String(result.installComparison.new?.error).includes(secret));
  assert.ok(!String(result.installComparison.new?.command).includes(secret));
  assert.ok(String(result.installComparison.new?.error).includes("[REDACTED]"));

  const events = eventStore.getEvents("run-svc-redactor", { kind: "report.checked" });
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0].data);
  assert.ok(!serialized.includes(secret));
  assert.ok(serialized.includes("[REDACTED]"));
});

test("report-check: rejects a fabricated marker even without any numeral or status keyword", () => {
  const index = buildEvidenceIndex({ commandResults: [{ id: "build" }] });

  const markerOnly = checkReading("See cmd:fabricated.", index);
  assert.equal(markerOnly.passed, false);
  assert.ok(markerOnly.unbackedClaims.some((c) => c.ref === "cmd:fabricated"));

  // A marker that does resolve is accepted even without a numeral or status word.
  const resolved = checkReading("See cmd:build.", index);
  assert.equal(resolved.passed, true);
});

test("report-check: single newlines split sentences without trailing whitespace", () => {
  assert.deepEqual(splitSentences("alpha\nbeta"), ["alpha", "beta"]);
  assert.deepEqual(splitSentences("alpha\n\nbeta"), ["alpha", "beta"]);
  assert.deepEqual(splitSentences("one. two."), ["one.", "two."]);

  const index = buildEvidenceIndex({ commandResults: [{ id: "build" }] });
  const reading = checkReading("See cmd:build.\nSee cmd:fabricated.", index);
  assert.equal(reading.passed, false);
  assert.ok(reading.unbackedClaims.some((c) => c.ref === "cmd:fabricated"));
});

test("report-check: only command.result events resolve cmd: markers", () => {
  const startedOnly = buildEvidenceIndex({
    events: [
      {
        runId: "r",
        seq: 1,
        ts: 0,
        kind: "command.started",
        actor: "a",
        data: { id: "started-only", refs: [] },
      },
    ],
  });
  assert.equal(startedOnly.resolve("cmd:started-only"), false);

  const completed = buildEvidenceIndex({
    events: [
      {
        runId: "r",
        seq: 2,
        ts: 0,
        kind: "command.result",
        actor: "a",
        data: { id: "completed", refs: [] },
      },
    ],
  });
  assert.equal(completed.resolve("cmd:completed"), true);
});

test("report-check: a trailing sentence period is stripped from markers", () => {
  assert.deepEqual(extractMarkers("See cmd:abc."), ["cmd:abc"]);
  assert.deepEqual(extractMarkers("See ev:7."), ["ev:7"]);
  // A single trailing sentence period is stripped from a file citation while the
  // internal dots (the `.ts` extension) are preserved.
  assert.deepEqual(extractMarkers("See file:src/a.ts."), ["file:src/a.ts"]);

  const index = buildEvidenceIndex({
    commandResults: [{ id: "abc" }],
    files: ["src/a.ts"],
  });
  assert.equal(index.resolve("cmd:abc."), true);
  assert.equal(checkReading("See cmd:abc.", index).passed, true);
  assert.equal(index.resolve("file:src/a.ts."), true);
  assert.equal(checkReading("See file:src/a.ts.", index).passed, true);
});

test("report-check: fallback redaction is cycle-safe for arrays and objects", () => {
  const arr: unknown[] = ["secret"];
  arr.push(arr);
  const outArr = redactAllStringLeaves(arr) as unknown[];
  assert.equal(outArr[0], "[REDACTED]");
  assert.equal(outArr[1], "[REDACTED]");

  const obj: Record<string, unknown> = { secret: "value" };
  obj.self = obj;
  const outObj = redactAllStringLeaves(obj) as Record<string, unknown>;
  assert.equal(outObj.secret, "[REDACTED]");
  assert.equal(outObj.self, "[REDACTED]");
});

test("report-check: the fallback report.checked reports the second check's details", async () => {
  const { eventStore } = makeStores();
  const index = buildEvidenceIndex({ commandResults: [{ id: "build" }] });

  const result = await runReportCheckWithRetry({
    reading: "Build passed.",
    index,
    // The retry produces a different (still unbacked) reading whose resolved
    // marker and two checked clauses differ from the first attempt.
    retry: () => "Build passed (cmd:build); there were 9 tests.",
    eventStore,
    runId: "run-second-fallback",
  });

  assert.equal(result.narrativeDropped, true);
  assert.equal(result.passed, false);
  // The fallback reflects the SECOND check, not the stale first attempt.
  assert.equal(result.reportCheck.checkedCount, 2);
  assert.deepEqual([...result.reportCheck.resolvedMarkers], ["cmd:build"]);
  assert.equal(result.reportCheck.unbackedClaims.length, 1);
  assert.equal(result.reportCheck.unbackedClaims[0].claim, "numeral");
  assert.equal(result.reportCheck.unbackedClaims[0].text, "there were 9 tests.");

  const events = eventStore.getEvents("run-second-fallback", {
    kind: "report.checked",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.checkedCount, 2);
  assert.deepEqual(events[0].data.resolvedMarkers, ["cmd:build"]);
  const claims = events[0].data.unbackedClaims as { claim: string; text: string }[];
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim, "numeral");
  assert.equal(claims[0].text, "there were 9 tests.");
});

test("report-check: install error ref is redacted while plain refs pass through", () => {
  const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const result = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: false },
    newInstallError: {
      command: "npm ci",
      exitCode: 1,
      error: "install failed",
      ref: `cmd:${ghToken}`,
    },
  });
  const ref = String(result.installComparison.new?.ref ?? "");
  assert.ok(!ref.includes(ghToken));
  assert.ok(ref.includes("[REDACTED]"));

  const plain = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: false },
    newInstallError: {
      command: "npm ci",
      exitCode: 1,
      error: "install failed",
      ref: "cmd:install",
    },
  });
  assert.equal(plain.installComparison.new?.ref, "cmd:install");

  const redactor = new Redactor({ autoRegisterEnvSecrets: false });
  const custom = "custom-ref-secret-abc-123456";
  redactor.registerSecret(custom);
  const withRedactor = assignRunOutcomeWithInstallComparison({
    tasks: [{ id: "task-1", state: "merged" }],
    finalCheck: { installPassed: false },
    newInstallError: {
      command: "npm ci",
      exitCode: 1,
      error: "install failed",
      ref: `cmd:${custom}`,
    },
    redactor,
  });
  assert.ok(!String(withRedactor.installComparison.new?.ref).includes(custom));
});

