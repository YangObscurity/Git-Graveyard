// Task 13.8: Property test for the merge gate (Property 16: Merge gate (P16))
// Validates: Requirements 9.12, 25.6, 25.7, 25.8

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { before, describe, it } from "node:test";
import * as fc from "fast-check";

import {
  mergeRule,
  checkMergeRule,
  evaluateMergeRule,
  isMergeAllowed as isMergeAllowedRule,
  canMerge,
  computeCandidateSha256 as ruleComputeSha256,
  isCandidateShaMatching,
  isGateResultPassing,
} from "../../lib/merge/merge-rule";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type {
  GateResultInput as MergeGateResultInput,
  MergeRuleOptions,
  TaskInput,
  VerdictInput,
} from "../../lib/merge/types";
import {
  checkMergeGate,
  evaluateMergeGate,
  isMergeAllowed as isMergeAllowedGate,
  canMergeTask,
  checkMergeGateFromEvents,
  mergeGate,
} from "../../lib/warden/merge-gate";
import type {
  GateResultInput as WardenGateResultInput,
  MergeGateEventItem,
  MergeGateOptions,
  WardenVerdictRecord,
} from "../../lib/warden/types";
import {
  buildVerdictRecord,
  computeCandidateSha256 as wardenComputeSha256,
} from "../../lib/warden/warden-review";
import { Scheduler } from "../../lib/scheduler/scheduler";
import type { PactRole, PactTask, RuleId } from "../../lib/pact/pact-parser";
import { GitService, VerifiedMerge } from "../../lib/git/git-service";
import { EventStore } from "../../lib/events/event-store";

// Work package SA2: the scheduler merge path only accepts a VerifiedMerge
// issued by GitService.mergeCandidate. Build one real proof for this file.
interface Sa2RealMergeProof {
  verifiedMerge: VerifiedMerge;
  candidateSha: string;
  candidateSha256: string;
  diff: string;
  tree: string;
}

async function createSa2RealMergeProof(): Promise<Sa2RealMergeProof> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-sa2-props-"));
  try {
    const gitDir = path.join(tmpDir, "git");
    fs.mkdirSync(gitDir, { recursive: true });

    const runGit = (args: string[]): string =>
      childProcess
        .execFileSync("git", args, {
          cwd: gitDir,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            HOME: tmpDir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          } as unknown as NodeJS.ProcessEnv,
        })
        .trim();

    runGit(["init", "--initial-branch=main", "."]);
    runGit(["config", "user.name", "Test Runner"]);
    runGit(["config", "user.email", "runner@example.test"]);
    fs.writeFileSync(path.join(gitDir, "base.txt"), "line 1: base\n", "utf8");
    runGit(["add", "base.txt"]);
    runGit(["commit", "-m", "initial base commit"]);
    const baseSha = runGit(["rev-parse", "HEAD"]);

    const integrationBranch = "graveyard/run-sa2-props";
    runGit(["branch", integrationBranch, baseSha]);
    runGit(["checkout", "-b", "task/sa2-props", integrationBranch]);
    fs.writeFileSync(
      path.join(gitDir, "base.txt"),
      "line 1: base\nline 2: candidate addition\n",
      "utf8"
    );
    runGit(["add", "."]);
    runGit(["commit", "-m", "sa2 candidate work"]);
    const candidateSha = runGit(["rev-parse", "HEAD"]);
    const tree = runGit(["rev-parse", `${candidateSha}^{tree}`]);
    runGit(["checkout", integrationBranch]);

    const diff = childProcess.execFileSync(
      "git",
      ["diff", "--binary", "--no-color", `${baseSha}..${candidateSha}`],
      { cwd: gitDir, encoding: "utf8" }
    );
    const candidateSha256 = candidateSha256FromDiff(diff);

    const service = new GitService({ runsDir: tmpDir });
    const verdict = buildVerdictRecord(candidateSha, {
      verdict: "approve",
      diff,
      tree,
      install: { ok: true },
      build: { ok: true },
      accept: { ok: true },
      tests: { ok: true },
    });
    const mergeResult = await (service as any).mergeCandidate({
      runId: "run-sa2-props",
      candidateSha,
      expectedIntegrationHeadSha: baseSha,
      verdict,
      verdictCandidateSha256: candidateSha256,
      gateResult: { ok: true, tree },
      gitDir,
    });
    assert.ok(mergeResult instanceof VerifiedMerge);

    return {
      verifiedMerge: mergeResult as VerifiedMerge,
      candidateSha,
      candidateSha256,
      diff,
      tree,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

let sa2RealProof: Sa2RealMergeProof;

before(async () => {
  sa2RealProof = await createSa2RealMergeProof();
});

// ---------------------------------------------------------------------------
// Helpers and Arbitraries
// ---------------------------------------------------------------------------

const sha40Arb = fc.stringMatching(/^[0-9a-f]{40}$/);
const sha256Arb = fc.stringMatching(/^[0-9a-f]{64}$/);
const treeIdArb = fc.stringMatching(/^[a-z0-9_-]{4,16}$/);
const taskIdArb = fc.stringMatching(/^T[1-9][0-9]?$/);

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

describe("Task 13.8 (Property 16: Merge gate) - Property Tests", () => {
  // -------------------------------------------------------------------------
  // Property 16.1: Core Merge Gate Acceptance Invariance
  // Requirements: 9.12, 25.6, 25.7, 25.8
  // -------------------------------------------------------------------------
  it("Property 16.1: merge gate accepts candidate if and only if verdict is approve, sha256 matches, gate passed, tree matches, and head is unchanged", () => {
    fc.assert(
      fc.property(
        sha40Arb,
        sha40Arb,
        fc.constantFrom("approve", "reject", "pending", "error", "unknown"),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (
          commitSha,
          otherSha,
          verdictStatus,
          shaMatches,
          gateOk,
          treeMatches,
          headUnchanged
        ) => {
          const candidateDiff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${commitSha}\n`;
          const otherDiff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${otherSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);
          const verdictCandidateSha = shaMatches ? commitSha : otherSha;
          const verdictSha256 = shaMatches
            ? candidateSha256
            : candidateSha256FromDiff(otherDiff);

          const taskTree = "tree-alpha";
          const gateTree = treeMatches ? "tree-alpha" : "tree-beta";
          const verdictTree = treeMatches ? "tree-alpha" : "tree-beta";

          const expectedHeadSha = "head-sha-base";
          const currentHeadSha = headUnchanged ? "head-sha-base" : "head-sha-moved";

          const isApprove = verdictStatus === "approve";
          const isShaMatch = shaMatches || commitSha === otherSha;

          const expectedRuleResult =
            isApprove &&
            isShaMatch &&
            gateOk &&
            treeMatches &&
            headUnchanged;

          const expectedWardenGateResult = expectedRuleResult;

          const eventStore = new EventStore(":memory:");
          eventStore.append({
            runId: "run-p16-1",
            kind: "gate.result",
            actor: "grimoire",
            taskId: "T1",
            data: { ok: gateOk, tree: gateTree, taskId: "T1" },
          });
          eventStore.append({
            runId: "run-p16-1",
            kind: "verdict",
            actor: "warden",
            taskId: "T1",
            data: {
              verdict: verdictStatus,
              candidateSha256: verdictSha256,
              target: "T1",
              tree: verdictTree,
              taskId: "T1",
            },
          });

          // 1. Evaluate via lib/merge (mergeRule)
          const mergeRuleOpts: MergeRuleOptions = {
            runId: "run-p16-1",
            task: { id: "T1", runId: "run-p16-1", candidateSha: commitSha, candidateSha256, tree: taskTree, diff: candidateDiff, events: eventStore as any },
            taskId: "T1",
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: taskTree,
            verdict: {
              verdict: verdictStatus,
              candidateSha256: verdictSha256,
              tree: verdictTree,
            },
            gateResult: {
              ok: gateOk,
              tree: gateTree,
            },
            events: eventStore as any,
            expectedHeadSha,
            currentHeadSha,
          };

          const ruleRes = mergeRule(mergeRuleOpts);

          assert.equal(
            ruleRes.merged,
            expectedRuleResult,
            `mergeRule result ${ruleRes.merged} != expected ${expectedRuleResult} for status=${verdictStatus}, shaMatch=${shaMatches}, gateOk=${gateOk}, treeMatch=${treeMatches}, headUnchanged=${headUnchanged}`
          );
          assert.equal(ruleRes.accepted, expectedRuleResult);
          assert.equal(ruleRes.ok, expectedRuleResult);
          assert.equal(ruleRes.status, expectedRuleResult ? "merged" : "not_merged");

          // 2. Evaluate via lib/warden (checkMergeGate) standalone
          const verdictDiff = shaMatches ? candidateDiff : otherDiff;
          const verdictRecord = buildVerdictRecord(verdictCandidateSha, {
            target: "T1",
            verdict: isApprove ? "approve" : "reject",
            candidateSha256: verdictSha256,
            diff: verdictDiff,
            tree: verdictTree,
            install: { ok: true },
            build: { ok: true },
            accept: { ok: true },
            tests: { ok: true },
          });

          const wardenGateOpts: MergeGateOptions = {
            runId: "run-p16-1",
            verdict: verdictRecord,
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: taskTree,
            taskId: "T1",
            events: eventStore as any,
            gateResult: {
              ok: gateOk,
              tree: gateTree,
            },
            expectedHeadSha,
            currentHeadSha,
          };

          const gateRes = checkMergeGate(wardenGateOpts);

          assert.equal(
            gateRes.accepted,
            expectedWardenGateResult,
            `checkMergeGate standalone result ${gateRes.accepted} != expected ${expectedWardenGateResult}`
          );
          assert.equal(gateRes.ok, expectedWardenGateResult);
          assert.equal(gateRes.merged, expectedWardenGateResult);

          // 3. Evaluate via lib/warden (checkMergeGate with events history verifying tree and precedence)
          const gateWithEventsRes = checkMergeGate({
            ...wardenGateOpts,
            taskId: "T1",
            tree: taskTree,
            events: eventStore as any,
          });

          assert.equal(
            gateWithEventsRes.accepted,
            expectedRuleResult,
            `checkMergeGate with events result ${gateWithEventsRes.accepted} != expected ${expectedRuleResult}`
          );

          // Both implementations agree when full event/tree context is supplied
          assert.equal(ruleRes.merged, gateWithEventsRes.accepted);
          assert.equal(isMergeAllowedRule(mergeRuleOpts), expectedRuleResult);

          // Missing gate result is refused, not backfilled from events
          const noGateResultRes = checkMergeGate({
            ...wardenGateOpts,
            gateResult: undefined,
            taskId: "T1",
            tree: taskTree,
            events: eventStore as any,
          });
          assert.equal(noGateResultRes.accepted, false);
          assert.equal(noGateResultRes.gatePassed, false);
        }
      ),
      { numRuns: 120 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 16.2: Complete Failure Isolation
  // Any single failing condition strictly prevents merge
  // Requirements: 9.12, 25.6, 25.7, 25.8
  // -------------------------------------------------------------------------
  it("Property 16.2: any single failed or missing prerequisite strictly blocks merge and yields reason", () => {
    const failureScenarios = [
      "verdict-not-approve",
      "verdict-missing",
      "sha256-mismatch",
      "gate-failed",
      "gate-missing",
      "tree-mismatch",
      "head-moved",
    ] as const;

    fc.assert(
      fc.property(
        sha40Arb,
        sha40Arb.filter((s) => s.length === 40),
        fc.constantFrom(...failureScenarios),
        (commitSha, differentSha, scenario) => {
          // Ensure differentSha differs from commitSha
          const otherSha =
            commitSha === differentSha
              ? commitSha.split("").reverse().join("")
              : differentSha;

          const candidateDiff = `diff --git a/a b/a\n+${commitSha}\n`;
          const otherDiff = `diff --git a/a b/a\n+${otherSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);
          const otherSha256 = candidateSha256FromDiff(otherDiff);

          let verdict: VerdictInput | undefined = {
            verdict: "approve",
            candidateSha256,
            tree: "tree-main",
          };
          let gateResult: MergeGateResultInput | undefined = {
            ok: true,
            tree: "tree-main",
          };
          let taskTree: string | undefined = "tree-main";
          let expectedHeadSha: string | undefined = "head-commit-1";
          let currentHeadSha: string | undefined = "head-commit-1";

          if (scenario === "verdict-not-approve") {
            verdict = { verdict: "reject", candidateSha256, tree: "tree-main" };
          } else if (scenario === "verdict-missing") {
            verdict = undefined;
          } else if (scenario === "sha256-mismatch") {
            verdict = { verdict: "approve", candidateSha256: otherSha256, tree: "tree-main" };
          } else if (scenario === "gate-failed") {
            gateResult = { ok: false, tree: "tree-main" };
          } else if (scenario === "gate-missing") {
            gateResult = undefined;
          } else if (scenario === "tree-mismatch") {
            gateResult = { ok: true, tree: "tree-different" };
            taskTree = "tree-main";
          } else if (scenario === "head-moved") {
            currentHeadSha = "head-commit-2-moved";
          }

          const opts: MergeRuleOptions = {
            task: { id: "T1", candidateSha: commitSha, candidateSha256, tree: taskTree, diff: candidateDiff },
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: taskTree,
            verdict,
            gateResult,
            expectedHeadSha,
            currentHeadSha,
          };

          const res = mergeRule(opts);

          assert.equal(
            res.merged,
            false,
            `Scenario ${scenario} must never merge, but returned merged=true`
          );
          assert.equal(res.status, "not_merged");
          assert.equal(res.accepted, false);
          assert.ok(res.reasons.length >= 1, "Must contain at least one rejection reason");

          // Validate specific reason matches scenario
          if (scenario === "verdict-not-approve" || scenario === "verdict-missing") {
            assert.equal(res.verdictApproved, false);
          } else if (scenario === "sha256-mismatch") {
            assert.equal(res.candidateShaMatches, false);
          } else if (scenario === "gate-failed" || scenario === "gate-missing") {
            assert.equal(res.gatePassed, false);
          } else if (scenario === "tree-mismatch") {
            assert.equal(res.treeMatches, false);
          } else if (scenario === "head-moved") {
            assert.equal(res.headUnchanged, false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 16.3: Candidate SHA-256 Determinism and Matching Semantics
  // Requirements: 25.6, 25.8
  // -------------------------------------------------------------------------
  it("Property 16.3: candidateSha256 computation is deterministic, case-insensitive, and rejects mismatched hashes", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 500 }),
        sha40Arb,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (diffText, commitSha, uppercaseSha, uppercaseHash, addWhitespace) => {
          // Commit sha string must NOT be hashed
          assert.equal(ruleComputeSha256(commitSha), "");
          assert.equal(wardenComputeSha256(commitSha), "");

          const directHash = crypto
            .createHash("sha256")
            .update(diffText)
            .digest("hex");

          const computedHash = candidateSha256FromDiff(diffText);

          // Determinism
          assert.equal(computedHash, directHash);
          assert.equal(computedHash.length, 64);

          // Formatting variations
          const candidateSha = uppercaseSha ? commitSha.toUpperCase() : commitSha;
          const candidateSha256 = uppercaseHash ? computedHash.toUpperCase() : computedHash;
          const verdictSha256 = uppercaseHash ? computedHash : computedHash.toUpperCase();

          const formattedSha = addWhitespace ? `  ${candidateSha} \n` : candidateSha;
          const formattedHash = addWhitespace ? `\t${verdictSha256} ` : verdictSha256;

          // Matching helper must succeed for valid variations
          assert.equal(
            isCandidateShaMatching(formattedHash, formattedSha, candidateSha256),
            true,
            "Valid SHA variations with case or whitespace must match"
          );

          // Different hash must strictly fail
          const invertedHash = crypto
            .createHash("sha256")
            .update(`${diffText}-different`)
            .digest("hex");
          if (invertedHash !== computedHash) {
            assert.equal(
              isCandidateShaMatching(invertedHash, candidateSha, candidateSha256),
              false,
              "Different hash must never match"
            );
          }
        }
      ),
      { numRuns: 80 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 16.4: EventStore Precedence Invariant
  // Requirement 25.7: "WHEN a Task transitions to merged, THE Necromancer SHALL
  // require that an approve Verdict for the same candidateSha256 and a gate.result
  // event with ok = true for the same tree both precede the task.state merged event
  // in the EventStore."
  // -------------------------------------------------------------------------
  it("Property 16.4: tasks transition to merged only when preceded by an approve verdict matching candidateSha256 and passing gate.result in EventStore", () => {
    const orderingScenarios = [
      "valid:gate-then-verdict-then-merged",
      "valid:verdict-then-gate-then-merged",
      "invalid:merged-first",
      "invalid:verdict-after-merged",
      "invalid:gate-after-merged",
      "invalid:missing-verdict",
      "invalid:missing-gate",
      "invalid:reject-verdict",
      "invalid:gate-failed",
      "invalid:sha-mismatch-verdict",
      "invalid:tree-mismatch-gate",
      "invalid:later-reject-invalidates-approve",
      "invalid:later-gate-failed-invalidates-passing",
    ] as const;

    fc.assert(
      fc.property(
        sha40Arb,
        sha40Arb,
        treeIdArb,
        treeIdArb,
        taskIdArb,
        fc.constantFrom(...orderingScenarios),
        fc.integer({ min: 0, max: 4 }), // noise events before
        fc.integer({ min: 0, max: 4 }), // noise events after
        (
          commitSha,
          otherShaRaw,
          taskTree,
          otherTreeRaw,
          taskId,
          scenario,
          noiseBeforeCount,
          noiseAfterCount
        ) => {
          const otherSha =
            commitSha === otherShaRaw
              ? commitSha.split("").reverse().join("")
              : otherShaRaw;
          const otherTree =
            taskTree === otherTreeRaw ? `${taskTree}-alt` : otherTreeRaw;

          const candidateDiff = `diff --git a/f b/f\n+${commitSha}\n`;
          const otherDiff = `diff --git a/f b/f\n+${otherSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);
          const otherSha256 = candidateSha256FromDiff(otherDiff);

          const events: MergeGateEventItem[] = [];
          let seq = 1;

          // Add arbitrary noise events before
          for (let i = 0; i < noiseBeforeCount; i++) {
            events.push({
              seq: seq++,
              kind: "tool.call",
              data: { tool: "read", path: `src/file-${i}.ts` },
              taskId,
            });
          }

          const passingGateEvent: MergeGateEventItem = {
            seq: seq++,
            kind: "gate.result",
            data: { ok: true, tree: taskTree },
            taskId,
          };

          const failingGateEvent: MergeGateEventItem = {
            seq: seq++,
            kind: "gate.result",
            data: { ok: false, tree: taskTree },
            taskId,
          };

          const mismatchedTreeGateEvent: MergeGateEventItem = {
            seq: seq++,
            kind: "gate.result",
            data: { ok: true, tree: otherTree },
            taskId,
          };

          const approveVerdictEvent: MergeGateEventItem = {
            seq: seq++,
            kind: "verdict",
            data: { verdict: "approve", candidateSha256, target: taskId, tree: taskTree },
            taskId,
          };

          const rejectVerdictEvent: MergeGateEventItem = {
            seq: seq++,
            kind: "verdict",
            data: { verdict: "reject", candidateSha256, target: taskId, tree: taskTree },
            taskId,
          };

          const mismatchedShaVerdictEvent: MergeGateEventItem = {
            seq: seq++,
            kind: "verdict",
            data: { verdict: "approve", candidateSha256: otherSha256, target: taskId, tree: taskTree },
            taskId,
          };

          const mergedStateEvent: MergeGateEventItem = {
            seq: seq++,
            kind: "task.state",
            data: { state: "merged", taskId },
            taskId,
          };

          // Assemble event ordering based on scenario
          if (scenario === "valid:gate-then-verdict-then-merged") {
            events.push(passingGateEvent, approveVerdictEvent, mergedStateEvent);
          } else if (scenario === "valid:verdict-then-gate-then-merged") {
            events.push(approveVerdictEvent, passingGateEvent, mergedStateEvent);
          } else if (scenario === "invalid:merged-first") {
            events.push(mergedStateEvent, passingGateEvent, approveVerdictEvent);
          } else if (scenario === "invalid:verdict-after-merged") {
            events.push(passingGateEvent, mergedStateEvent, approveVerdictEvent);
          } else if (scenario === "invalid:gate-after-merged") {
            events.push(approveVerdictEvent, mergedStateEvent, passingGateEvent);
          } else if (scenario === "invalid:missing-verdict") {
            events.push(passingGateEvent, mergedStateEvent);
          } else if (scenario === "invalid:missing-gate") {
            events.push(approveVerdictEvent, mergedStateEvent);
          } else if (scenario === "invalid:reject-verdict") {
            events.push(passingGateEvent, rejectVerdictEvent, mergedStateEvent);
          } else if (scenario === "invalid:gate-failed") {
            events.push(failingGateEvent, approveVerdictEvent, mergedStateEvent);
          } else if (scenario === "invalid:sha-mismatch-verdict") {
            events.push(passingGateEvent, mismatchedShaVerdictEvent, mergedStateEvent);
          } else if (scenario === "invalid:tree-mismatch-gate") {
            events.push(mismatchedTreeGateEvent, approveVerdictEvent, mergedStateEvent);
          } else if (scenario === "invalid:later-reject-invalidates-approve") {
            events.push(passingGateEvent, approveVerdictEvent, rejectVerdictEvent, mergedStateEvent);
          } else if (scenario === "invalid:later-gate-failed-invalidates-passing") {
            events.push(passingGateEvent, approveVerdictEvent, failingGateEvent, mergedStateEvent);
          }

          // Add arbitrary noise events after
          for (let i = 0; i < noiseAfterCount; i++) {
            events.push({
              seq: seq++,
              kind: "run.log",
              data: { message: `Step ${i} complete` },
              taskId,
            });
          }

          const store = new EventStore(":memory:");
          for (const ev of events) {
            store.append({
              runId: "run-p16-4",
              kind: ev.kind as any,
              actor: (ev as any).actor ?? "system",
              taskId: ev.taskId ?? null,
              data: ev.data ?? {},
            });
          }

          const checkRes = checkMergeGateFromEvents(store, {
            runId: "run-p16-4",
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: taskTree,
            taskId,
          });

          const isExpectedValid = scenario.startsWith("valid:");

          assert.equal(
            checkRes.ok,
            isExpectedValid,
            `checkMergeGateFromEvents ok=${checkRes.ok} != expected=${isExpectedValid} for scenario ${scenario}`
          );

          if (isExpectedValid) {
            assert.equal(checkRes.verdictApproved, true);
            assert.equal(checkRes.gatePassed, true);
            assert.equal(checkRes.eventsPreceded, true);
            assert.equal(checkRes.reasons.length, 0);
          } else {
            assert.equal(checkRes.ok, false);
            assert.ok(
              checkRes.reasons.length >= 1,
              `Rejection in scenario ${scenario} must provide reasons`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 16.5: Scheduler State Transition and EventStore Integration
  // Requirements: 9.12, 23.2, 25.6, 25.7
  // -------------------------------------------------------------------------
  it("Property 16.5: Scheduler merges task and unblocks dependents only when merge gate permits", () => {
    fc.assert(
      fc.property(
        sha40Arb,
        fc.boolean(), // verdict approve vs reject
        fc.boolean(), // sha matches vs mismatch
        fc.boolean(), // gate ok vs fail
        (commitSha, verdictApprove, shaMatches, gateOk) => {
          const candidateDiff = `diff --git a/f b/f\n+${commitSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);
          const otherDiff = `diff --git a/f b/f\n+${commitSha.split("").reverse().join("")}\n`;
          const otherSha256 = candidateSha256FromDiff(otherDiff);
          const verdictCandidateSha256 = shaMatches
            ? candidateSha256
            : otherSha256;

          const taskTree = "tree-main";

          // Set up 2 tasks: T1 and T2 (T2 depends on T1)
          const tasks: PactTask[] = [
            makePactTask("T1", [], "soul-stitcher", false, 0),
            makePactTask("T2", ["T1"], "soul-stitcher", false, 1),
          ];

          const scheduler = new Scheduler(tasks, {
            pactApproved: true,
            approvedTaskIds: ["T1", "T2"],
            runParallelCap: 2,
            runId: "run-sa2-props",
          });

          // Dispatch T1
          const dispatched = scheduler.dispatchTask("T1");
          assert.ok(dispatched);
          assert.equal(scheduler.getTask("T1")?.state, "running");

          // T2 must be pending waiting for T1
          assert.equal(scheduler.getTask("T2")?.state, "pending");

          // T1 finishes and is submitted for review
          scheduler.markInReview("T1");
          assert.equal(scheduler.getTask("T1")?.state, "in_review");

          // Evaluate candidate via merge gate
          const gateResult: WardenGateResultInput = {
            ok: gateOk,
            gate: "syntax",
            tree: taskTree,
          };

          const verdictDiff = shaMatches ? candidateDiff : otherDiff;
          const verdict = buildVerdictRecord(commitSha, {
            target: "T1",
            verdict: verdictApprove ? "approve" : "reject",
            candidateSha256: verdictCandidateSha256,
            diff: verdictDiff,
            tree: taskTree,
            install: { ok: true },
            build: { ok: true },
            accept: { ok: true },
            tests: { ok: true },
          });

          const store = new EventStore(":memory:");
          store.append({
            runId: "run-p16-5",
            kind: "gate.result",
            actor: "grimoire",
            taskId: "T1",
            data: { ok: gateOk, tree: taskTree, taskId: "T1" },
          });
          store.append({
            runId: "run-p16-5",
            kind: "verdict",
            actor: "warden",
            taskId: "T1",
            data: {
              verdict: verdictApprove ? "approve" : "reject",
              candidateSha256: verdictCandidateSha256,
              target: "T1",
              tree: taskTree,
              taskId: "T1",
            },
          });

          const gateEvaluation = checkMergeGate({
            runId: "run-p16-5",
            verdict,
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            gateResult,
            tree: taskTree,
            gateTree: taskTree,
            taskId: "T1",
            events: store as any,
          });

          const allowed = verdictApprove && shaMatches && gateOk;
          assert.equal(gateEvaluation.accepted, allowed);

          if (allowed) {
            const mergeStore = new EventStore(":memory:");
            mergeStore.append({
              runId: "run-sa2-props",
              kind: "task.state",
              actor: "scheduler",
              taskId: "T1",
              data: { taskId: "T1", state: "in_review" },
            });
            mergeStore.append({
              runId: "run-sa2-props",
              kind: "gate.result",
              actor: "grimoire",
              taskId: "T1",
              data: { ok: true, tree: sa2RealProof.tree, taskId: "T1" },
            });
            mergeStore.append({
              runId: "run-sa2-props",
              kind: "verdict",
              actor: "warden",
              taskId: "T1",
              data: {
                verdict: "approve",
                candidateSha256: sa2RealProof.candidateSha256,
                target: "T1",
                tree: sa2RealProof.tree,
                taskId: "T1",
                refs: ["cmd:test"],
              },
            });

            // Task passes merge gate and merges
            scheduler.mergeTask("T1", {
              runId: "run-sa2-props",
              verdict: buildVerdictRecord(sa2RealProof.candidateSha, {
                target: "T1",
                taskId: "T1",
                verdict: "approve",
                diff: sa2RealProof.diff,
                candidateSha256: sa2RealProof.candidateSha256,
                tree: sa2RealProof.tree,
                install: { ok: true },
                build: { ok: true },
                accept: { ok: true },
                tests: { ok: true },
              }),
              candidateSha: sa2RealProof.candidateSha,
              candidateSha256: sa2RealProof.candidateSha256,
              diff: sa2RealProof.diff,
              gateResult: { ok: true, tree: sa2RealProof.tree, gate: "syntax" },
              tree: sa2RealProof.tree,
              gateTree: sa2RealProof.tree,
              taskId: "T1",
              events: mergeStore as any,
              gitMerge: sa2RealProof.verifiedMerge as any,
            });
            assert.equal(scheduler.getTask("T1")?.state, "merged");

            // Dependent task T2 must now become ready (Requirement 23.2)
            assert.equal(
              scheduler.getTask("T2")?.state,
              "ready",
              "When T1 merges, dependent T2 must transition from pending to ready"
            );
          } else {
            // Gate rejected: T1 cannot merge
            scheduler.rejectTask("T1", { reason: gateEvaluation.reason });
            assert.notEqual(scheduler.getTask("T1")?.state, "merged");

            // Dependent task T2 must NEVER become ready
            assert.equal(
              scheduler.getTask("T2")?.state,
              "pending",
              "When T1 is not merged, dependent T2 must remain pending"
            );
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  // -------------------------------------------------------------------------
  // Property 16.6: Pure Function Idempotence and Input Immutability
  // -------------------------------------------------------------------------
  it("Property 16.6: merge gate functions are pure, idempotent, and do not mutate arguments", () => {
    fc.assert(
      fc.property(
        sha40Arb,
        fc.constantFrom("approve", "reject"),
        fc.boolean(),
        (commitSha, verdictStatus, gateOk) => {
          const candidateDiff = `diff --git a/f b/f\n+${commitSha}\n`;
          const candidateSha256 = candidateSha256FromDiff(candidateDiff);

          const taskObj: TaskInput = Object.freeze({
            id: "T1",
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            tree: "tree-test",
          });

          const verdictObj = Object.freeze({
            verdict: verdictStatus,
            candidateSha256,
            target: "T1",
            tree: "tree-test",
          });

          const gateResultObj = Object.freeze({
            ok: gateOk,
            tree: "tree-test",
          });

          // Call 1
          const res1 = mergeRule(taskObj, verdictObj, gateResultObj);
          // Call 2 (Idempotence check)
          const res2 = mergeRule(taskObj, verdictObj, gateResultObj);

          assert.deepEqual(res1, res2, "Subsequent calls with identical inputs must be identical");

          // Aliases consistency
          assert.equal(checkMergeRule(taskObj, verdictObj, gateResultObj).merged, res1.merged);
          assert.equal(evaluateMergeRule(taskObj, verdictObj, gateResultObj).merged, res1.merged);
          assert.equal(isMergeAllowedRule(taskObj, verdictObj, gateResultObj), res1.merged);
          assert.equal(canMerge(taskObj, verdictObj, gateResultObj), res1.merged);

          // Warden aliases consistency
          const wardenRes1 = checkMergeGate({
            verdict: verdictObj,
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            gateResult: gateResultObj,
            tree: "tree-test",
          });
          const wardenRes2 = evaluateMergeGate({
            verdict: verdictObj,
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            gateResult: gateResultObj,
            tree: "tree-test",
          });
          const wardenRes3 = mergeGate({
            verdict: verdictObj,
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            gateResult: gateResultObj,
            tree: "tree-test",
          });

          assert.deepEqual(wardenRes1, wardenRes2);
          assert.deepEqual(wardenRes1, wardenRes3);
          assert.equal(canMergeTask({
            verdict: verdictObj,
            candidateSha: commitSha,
            candidateSha256,
            diff: candidateDiff,
            gateResult: gateResultObj,
            tree: "tree-test",
          }), wardenRes1.accepted);
        }
      ),
      { numRuns: 50 }
    );
  });
});
