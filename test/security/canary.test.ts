// Unit tests for lib/security/canary.ts
// Requirements: 42.6

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  KSK_CANARY_PREFIX,
  GHP_CANARY_PREFIX,
  AKIA_CANARY_PREFIX,
  GITHUB_PAT_CANARY_PREFIX,
  DCKR_PAT_CANARY_PREFIX,
  PEM_CANARY_HEADER,
  PEM_CANARY_FOOTER,
  createCanaryToken,
  createDefaultCanaryTokens,
  getCanaryTokensList,
  plantCanaryInRepositoryFile,
  plantCanaryInRepositoryFiles,
  plantCanaryInDiff,
  plantCanaryInCommandOutput,
  plantCanaryInToolResult,
  plantCanaryInEvent,
  findCanaryOccurrences,
  verifyNoCanaryLeaks,
  verifyDownstreamEventTap,
  verifyEventStoreContainment,
  verifyArtifactContainment,
  verifyCommandLogContainment,
  verifyWorktreeQuarantineOnCanary,
  verifyDiffQuarantineOnCanary,
  runCanaryMemoryPipeline,
  type CanaryTokenSet,
} from "../../lib/security/canary";

import {
  DEFAULT_REDACTION_MASK,
  redactText,
  redactValue,
  scanWorktreeFiles,
  scanCandidateDiff,
  type WorktreeFileInput,
} from "../../lib/security/redactor";

import { EventTap } from "../../lib/events/event-tap";
import { EventStore } from "../../lib/events/event-store";
import { LogStore } from "../../lib/events/log-store";
import { ArtifactCollector } from "../../lib/lifecycle/artifact-collector";
import type { EventInput, EventEnvelope } from "../../lib/events/event-tap";

describe("canary: token definitions and generator helpers", () => {
  it("exports standard canary prefixes matching sensitive token patterns", () => {
    assert.equal(KSK_CANARY_PREFIX, "ksk_CANARY");
    assert.equal(GHP_CANARY_PREFIX, "ghp_CANARY");
    assert.equal(AKIA_CANARY_PREFIX, "AKIA_CANARY");
    assert.equal(GITHUB_PAT_CANARY_PREFIX, "github_pat_CANARY");
    assert.equal(DCKR_PAT_CANARY_PREFIX, "dckr_pat_CANARY");
    assert.ok(PEM_CANARY_HEADER.startsWith("-----BEGIN"));
  });

  it("generates distinct canary tokens for each sensitive kind", () => {
    const ksk = createCanaryToken("ksk", "SAMPLE1");
    const ghp = createCanaryToken("ghp", "SAMPLE2");
    const akia = createCanaryToken("akia", "SAMPLE3");
    const githubPat = createCanaryToken("github_pat", "SAMPLE4");
    const dckrPat = createCanaryToken("dckr_pat", "SAMPLE5");
    const pem = createCanaryToken("pem", "SAMPLE6");

    assert.ok(ksk.startsWith("ksk_CANARY_"));
    assert.ok(ghp.startsWith("ghp_CANARY_"));
    assert.match(akia, /^AKIA[A-Z0-9]{16}$/);
    assert.ok(githubPat.startsWith("github_pat_CANARY_"));
    assert.ok(dckrPat.startsWith("dckr_pat_CANARY_"));
    assert.ok(pem.includes(PEM_CANARY_HEADER));
    assert.ok(pem.includes(PEM_CANARY_FOOTER));
  });

  it("creates a comprehensive default canary token set", () => {
    const set = createDefaultCanaryTokens("TEST_SUITE");
    assert.ok(set.ksk);
    assert.ok(set.ghp);
    assert.ok(set.akia);
    assert.ok(set.githubPat);
    assert.ok(set.dckrPat);
    assert.ok(set.pemBlock);
    assert.ok(set.allTokens.length >= 6);

    const list = getCanaryTokensList(set);
    assert.deepEqual(list, set.allTokens);
  });

  it("normalizes token lists from arrays, strings and objects", () => {
    assert.deepEqual(getCanaryTokensList("token1"), ["token1"]);
    assert.deepEqual(getCanaryTokensList(["t1", "t2", "t1"]), ["t1", "t2"]);
    assert.deepEqual(getCanaryTokensList({ a: "tokA", b: "tokB" } as any), ["tokA", "tokB"]);
  });
});

describe("canary: planting into repository files and worktrees (Requirement 42.6)", () => {
  const tokens = createDefaultCanaryTokens("REPO_TEST");

  it("plants canary token at start, end or inline of a file", () => {
    const original = "export const PI = 3.14159;\nexport function circle() {}\n";

    const atEnd = plantCanaryInRepositoryFile(
      { path: "src/math.ts", content: original },
      tokens.ksk,
      "end"
    );
    assert.ok(atEnd.content.endsWith(`// CANARY_INJECTION: ${tokens.ksk}\n`));
    assert.equal(atEnd.originalContent, original);

    const atStart = plantCanaryInRepositoryFile(
      { path: "src/math.ts", content: original },
      tokens.ghp,
      "start"
    );
    assert.ok(atStart.content.startsWith(`// CANARY_INJECTION: ${tokens.ghp}\n`));

    const inline = plantCanaryInRepositoryFile(
      { path: "src/math.ts", content: original },
      tokens.akia,
      "inline"
    );
    assert.ok(inline.content.includes(tokens.akia));
  });

  it("plants canary tokens across multiple repository files", () => {
    const files: WorktreeFileInput[] = [
      { path: "src/index.ts", content: "console.log('init');\n" },
      { path: "src/config.ts", content: "export const cfg = {};\n" },
    ];

    const planted = plantCanaryInRepositoryFiles(files, tokens);
    assert.equal(planted.length, 2);
    assert.ok(planted[0].content.includes(tokens.allTokens[0]));
    assert.ok(planted[1].content.includes(tokens.allTokens[1]));
  });

  it("triggers worktree quarantine when repository files contain canaries (Requirement 42.5)", () => {
    const files: WorktreeFileInput[] = [
      { path: "src/index.ts", content: "console.log('clean');\n" },
    ];
    const cleanScan = verifyWorktreeQuarantineOnCanary(files);
    assert.equal(cleanScan.shouldQuarantine, false);

    const planted = plantCanaryInRepositoryFiles(files, [tokens.ksk, tokens.ghp]);
    const quarantinedScan = verifyWorktreeQuarantineOnCanary(planted);
    assert.equal(quarantinedScan.shouldQuarantine, true);
    assert.equal(quarantinedScan.passed, false);
    assert.ok(quarantinedScan.flaggedFiles.includes("src/index.ts"));
  });

  it("plants canaries in diff and triggers diff quarantine (Requirement 42.5)", () => {
    const cleanDiff = [
      "diff --git a/src/math.ts b/src/math.ts",
      "--- a/src/math.ts",
      "+++ b/src/math.ts",
      "@@ -1,1 +1,2 @@",
      "-export const A = 1;",
      "+export const A = 2;",
    ].join("\n");

    const cleanScan = verifyDiffQuarantineOnCanary(cleanDiff);
    assert.equal(cleanScan.shouldQuarantine, false);

    const plantedDiff = plantCanaryInDiff(cleanDiff, [tokens.ksk, tokens.akia]);
    assert.ok(plantedDiff.includes(tokens.ksk));
    assert.ok(plantedDiff.includes(tokens.akia));

    const quarantinedScan = verifyDiffQuarantineOnCanary(plantedDiff);
    assert.equal(quarantinedScan.shouldQuarantine, true);
    assert.equal(quarantinedScan.passed, false);
  });
});

describe("canary: planting into command stdout and stderr (Requirement 42.6)", () => {
  const tokens = createDefaultCanaryTokens("CMD_TEST");

  it("plants canaries into stdout, stderr and merged streams", () => {
    const planted = plantCanaryInCommandOutput(
      { stdout: "Tests: 12 passed", stderr: "warning: deprecated flag" },
      [tokens.ksk, tokens.ghp]
    );

    assert.ok(planted.stdout.includes(tokens.ksk));
    assert.ok(planted.stderr.includes(tokens.ghp));
    assert.ok(planted.merged.includes(tokens.ksk));
    assert.ok(planted.merged.includes(tokens.ghp));
  });

  it("redacts command stdout and stderr, leaving zero canary tokens", () => {
    const planted = plantCanaryInCommandOutput(
      { stdout: "Compilation output", stderr: "Error stack info" },
      tokens
    );

    const redactedStdout = redactText(planted.stdout);
    const redactedStderr = redactText(planted.stderr);
    const redactedMerged = redactText(planted.merged);

    assert.ok(!redactedStdout.includes(tokens.ksk));
    assert.ok(!redactedStderr.includes(tokens.ghp));
    assert.ok(!redactedMerged.includes(tokens.akia));

    const check = verifyCommandLogContainment(
      { stdout: redactedStdout, stderr: redactedStderr, merged: redactedMerged },
      tokens
    );
    assert.equal(check.passed, true);
    assert.equal(check.leaked, false);
    assert.equal(check.occurrences.length, 0);
  });

  it("redacts command output stored in LogStore", () => {
    const logStore = new LogStore({ inMemory: true });
    const planted = plantCanaryInCommandOutput(
      { stdout: "Running build...", stderr: "Subprocess failed" },
      [tokens.ksk, tokens.akia]
    );

    const stored = logStore.storeCommandOutput({
      stdout: planted.stdout,
      stderr: planted.stderr,
      exitCode: 1,
    });

    assert.ok(!stored.stdoutTail.includes(tokens.ksk));
    assert.ok(!stored.stderrTail.includes(tokens.akia));
    assert.ok(stored.stdoutTail.includes(DEFAULT_REDACTION_MASK));

    const check = verifyCommandLogContainment(stored, tokens);
    assert.equal(check.passed, true);
  });
});

describe("canary: planting into tool result payloads (Requirement 42.6)", () => {
  const tokens = createDefaultCanaryTokens("TOOL_TEST");

  it("plants canaries into tool payload target field and nested structures", () => {
    const rawPayload = {
      toolName: "sandbox_exec",
      command: ["git", "status"],
      output: "On branch main",
    };

    const planted = plantCanaryInToolResult(rawPayload, [tokens.ksk, tokens.ghp]);
    assert.ok(typeof planted.payload.output === "string");
    assert.ok((planted.payload.output as string).includes(tokens.ksk));
    assert.ok(Array.isArray(planted.payload.canarySecrets));

    const leakedBeforeRedaction = verifyNoCanaryLeaks(planted.payload, tokens);
    assert.equal(leakedBeforeRedaction.passed, false);
    assert.ok(leakedBeforeRedaction.occurrences.length > 0);
  });

  it("redacts tool result payload completely via redactValue", () => {
    const rawPayload = {
      tool: "read_file",
      content: `const secret = "${tokens.ksk}";\nconst key = "${tokens.akia}";\n`,
    };

    const planted = plantCanaryInToolResult(rawPayload, tokens);
    const sanitized = redactValue(planted.payload);

    const check = verifyNoCanaryLeaks(sanitized, tokens);
    assert.equal(check.passed, true);
    assert.equal(check.leaked, false);
    assert.equal(check.occurrences.length, 0);
  });
});

describe("canary: downstream of EventTap verification (Requirement 42.6)", () => {
  const tokens = createDefaultCanaryTokens("EVENT_TAP_TEST");

  it("redacts single event appended through EventTap", () => {
    const eventStore = new EventStore(":memory:");
    const eventTap = new EventTap(eventStore);

    const plantedTool = plantCanaryInToolResult(
      { status: "ok", output: "executed" },
      [tokens.ksk, tokens.ghp]
    );

    const input: EventInput = {
      runId: "run-tap-01",
      kind: "skeleton.tool_result",
      actor: `actor-${tokens.ksk}`,
      skeletonId: `skel-${tokens.ghp}`,
      taskId: `task-${tokens.akia}`,
      data: {
        payload: plantedTool.payload,
        refs: ["evidence/file1.txt"],
      },
    };

    const envelope = eventTap.append(input);

    // Verify envelope downstream of EventTap
    assert.ok(!envelope.actor.includes(tokens.ksk));
    assert.ok(!envelope.skeletonId?.includes(tokens.ghp));
    assert.ok(!envelope.taskId?.includes(tokens.akia));

    const check = verifyDownstreamEventTap(envelope, tokens);
    assert.equal(check.passed, true);
    assert.equal(check.leaked, false);
    assert.equal(check.occurrences.length, 0);
  });

  it("redacts batch events appended through EventTap", () => {
    const eventStore = new EventStore(":memory:");
    const eventTap = new EventTap(eventStore);

    const plantedOutput = plantCanaryInCommandOutput(
      { stdout: "stdout log", stderr: "stderr log" },
      tokens
    );

    const batchInputs: EventInput[] = [
      {
        runId: "run-batch-01",
        kind: "command.result",
        actor: "necro",
        data: {
          stdout: plantedOutput.stdout,
          stderr: plantedOutput.stderr,
          refs: [],
        },
      },
      {
        runId: "run-batch-01",
        kind: "grimoire.signal",
        actor: "grimoire",
        data: {
          line: `CANARY MATCH: ${tokens.githubPat}`,
          refs: ["repo:file.ts#L10"],
        },
      },
    ];

    const envelopes = eventTap.appendBatch(batchInputs);
    assert.equal(envelopes.length, 2);

    const check = verifyDownstreamEventTap(envelopes, tokens);
    assert.equal(check.passed, true);
    assert.equal(check.leaked, false);
  });

  it("redacts event retrieved via eventTap.getEvents", () => {
    const eventStore = new EventStore(":memory:");
    const eventTap = new EventTap(eventStore);

    const rawEvent = plantCanaryInEvent(
      {
        runId: "run-query-01",
        kind: "task.state",
        actor: "necro",
        data: { refs: [] },
      },
      tokens
    );

    eventTap.append(rawEvent);

    const retrieved = eventTap.getEvents("run-query-01");
    assert.ok(retrieved.length > 0);

    const check = verifyDownstreamEventTap(retrieved, tokens);
    assert.equal(check.passed, true);
  });
});

describe("canary: EventStore containment verification (Requirement 42.6, 42.8)", () => {
  const tokens = createDefaultCanaryTokens("STORE_TEST");

  it("ensures SQLite database rows contain zero canary tokens", () => {
    const eventStore = new EventStore(":memory:");
    const eventTap = new EventTap(eventStore);

    const runId = "run-store-01";
    const plantedTool = plantCanaryInToolResult(
      { exitCode: 0, details: "success" },
      tokens
    );

    eventTap.append({
      runId,
      kind: "skeleton.tool_result",
      actor: "skel",
      data: {
        tool: "sandbox_exec",
        result: plantedTool.payload,
        refs: [],
      },
    });

    // Check through verifyEventStoreContainment helper
    const check = verifyEventStoreContainment(eventStore, runId, tokens);
    assert.equal(check.passed, true);
    assert.equal(check.leaked, false);
    assert.equal(check.occurrences.length, 0);

    // Direct SQLite raw query verification
    const rows = eventStore.db
      .prepare("SELECT data FROM events WHERE runId = ?")
      .all(runId) as Array<{ data: string }>;

    for (const row of rows) {
      for (const tok of tokens.allTokens) {
        assert.ok(
          !row.data.includes(tok),
          `Direct SQLite inspection leaked canary token: ${tok}`
        );
      }
    }
  });
});

describe("canary: generated artifacts containment verification (Requirement 42.6)", () => {
  const tokens = createDefaultCanaryTokens("ARTIFACT_TEST");

  it("verifies in-memory artifacts contain zero canary tokens", () => {
    const plantedDiff = plantCanaryInDiff(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      tokens
    );

    const artifacts = {
      "all.patch": redactText(plantedDiff),
      "report.md": redactText(`Report summary containing ${tokens.ksk} and ${tokens.ghp}`),
      "events.ndjson": `{"seq":1,"kind":"command.result","data":{"output":"${DEFAULT_REDACTION_MASK}"}}\n`,
    };

    const check = verifyArtifactContainment(artifacts, tokens);
    assert.equal(check.passed, true);
    assert.equal(check.leaked, false);
    assert.equal(check.occurrences.length, 0);
  });

  it("verifies on-disk artifacts collected via ArtifactCollector contain zero canaries", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "canary-artifacts-"));
    try {
      const runId = "run-disk-artifacts-01";
      const artifactsDir = path.join(tmpDir, "artifacts");

      const collector = new ArtifactCollector({
        runId,
        artifactsDir,
      });

      // 1. Collect sanitized patch
      const rawPatch = plantCanaryInDiff(
        "diff --git a/pkg.json b/pkg.json\n--- a/pkg.json\n+++ b/pkg.json\n@@ -1 +1 @@\n-1\n+2\n",
        tokens
      );
      const sanitizedPatch = redactText(rawPatch);
      await collector.collectPatch(sanitizedPatch);

      // 2. Collect sanitized report
      const rawReport = `# Final Report\nOutput log: ${tokens.ksk}\n`;
      const sanitizedReport = redactText(rawReport);
      await collector.collectReport(sanitizedReport);

      // 3. Collect sanitized spec bundle
      await collector.collectSpecBundle({
        requirements: "# Requirements\nAll clean\n",
        design: "# Design\nNo secrets\n",
        tasks: "# Tasks\n- [ ] T1. Done\n",
      });

      // 4. Verify artifact directory containment
      const manifest = collector.getManifest();
      const check = verifyArtifactContainment(manifest, tokens);
      assert.equal(check.passed, true);
      assert.equal(check.leaked, false);
      assert.equal(check.occurrences.length, 0);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("canary: detection sensitivity and leak alerting", () => {
  const tokens = createDefaultCanaryTokens("LEAK_ALERT_TEST");

  it("detects canary occurrences in plain text and nested objects", () => {
    const leakingObject = {
      meta: {
        author: "tester",
        key: tokens.ksk,
      },
      list: [1, 2, tokens.ghp],
      mapping: new Map([["secret", tokens.akia]]),
      buf: Buffer.from(`data with ${tokens.githubPat}`),
    };

    const occs = findCanaryOccurrences(leakingObject, tokens);
    assert.ok(occs.length >= 4);

    const tokensFound = new Set(occs.map((o) => o.token));
    assert.ok(tokensFound.has(tokens.ksk));
    assert.ok(tokensFound.has(tokens.ghp));
    assert.ok(tokensFound.has(tokens.akia));
    assert.ok(tokensFound.has(tokens.githubPat));
  });

  it("fails verification when an artifact contains an unredacted canary token", () => {
    const leakingArtifacts = {
      "all.patch": "clean patch",
      "leaking.txt": `secret is ${tokens.ksk}`,
    };

    const check = verifyArtifactContainment(leakingArtifacts, tokens);
    assert.equal(check.passed, false);
    assert.equal(check.leaked, true);
    assert.ok(check.leakedTokens.includes(tokens.ksk));
    assert.ok(check.reason?.includes("Canary leak"));
  });

  it("fails verification when an event downstream of EventTap leaks an unredacted token", () => {
    const leakingEnvelope: EventEnvelope = {
      runId: "run-leak-01",
      seq: 1,
      ts: Date.now(),
      kind: "command.result",
      actor: "necro",
      data: {
        unredactedStdout: `leaked: ${tokens.ghp}`,
        refs: [],
      },
    };

    const check = verifyDownstreamEventTap(leakingEnvelope, tokens);
    assert.equal(check.passed, false);
    assert.equal(check.leaked, true);
    assert.ok(check.leakedTokens.includes(tokens.ghp));
  });

  it("handles circular objects gracefully without infinite loop", () => {
    const circularObj: any = { name: "loop" };
    circularObj.self = circularObj;

    const occs = findCanaryOccurrences(circularObj, tokens);
    assert.equal(occs.length, 0);

    circularObj.token = tokens.ksk;
    const occsWithToken = findCanaryOccurrences(circularObj, tokens);
    assert.equal(occsWithToken.length, 1);
  });
});

describe("canary: end-to-end CI pipeline simulation (Requirement 42.6)", () => {
  it("runs in-memory canary test pipeline and confirms 100% containment", () => {
    const report = runCanaryMemoryPipeline({
      runId: "ci-canary-test-01",
    });

    assert.equal(report.passed, true);
    assert.equal(report.worktreeQuarantined, true);
    assert.equal(report.diffQuarantined, true);
    assert.equal(report.downstreamEventTapPassed, true);
    assert.equal(report.eventStorePassed, true);
    assert.equal(report.commandLogsPassed, true);
    assert.equal(report.artifactsPassed, true);
    assert.equal(report.leakedOccurrences.length, 0);
    assert.ok(report.summary.includes("Canary CI suite passed"));
  });
});
