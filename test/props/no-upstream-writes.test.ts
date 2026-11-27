// Task 21.5: Property 15 - No upstream writes.
// Validates: Requirements 29.1, 29.2, 29.3, 29.7.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";

import { GitService, GitServiceError } from "../../lib/git/git-service";
import { EventStore } from "../../lib/events/event-store";

// A fake write token is assembled at runtime so no literal credential-like
// string is ever committed to the test source.
const FAKE_WRITE_TOKEN = ["gh", "p_", "fake", "write", "token", "0000", "1111"].join("");

const ALLOWED_REFUSAL_CODES = new Set([
  "INVALID_RUN_ID",
  "INVALID_ARGUMENT",
  "MISSING_FORK_URL",
  "INVALID_TARGET_URL",
  "MISSING_SOURCE_URL",
  "INVALID_SOURCE_URL",
  "SOURCE_WRITE_FORBIDDEN",
  "INVALID_RUN_PHASE",
  "PUSH_FLAG_DISABLED",
  "PUSH_NOT_CONFIRMED",
  "MISSING_OWNER_LOGIN",
  "TARGET_NOT_OWNER_FORK",
  "MISSING_FORK_CHECKER",
  "NOT_A_FORK",
  "INVALID_PUSH_BRANCH",
  "MISSING_WRITE_TOKEN",
  "PUSH_LOCK_HELD",
  "GIT_COMMAND_FAILED",
]);

const slugArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);

interface FakeGitCall {
  args: string[];
}

/**
 * Installs a fake `git` on PATH that records every invocation to a log file.
 * rev-parse returns a fixed SHA, push succeeds, everything else exits 0.
 */
async function withFakeGit<T>(
  fn: (context: {
    readCalls: () => FakeGitCall[];
    reset: () => void;
    logFile: string;
  }) => Promise<T>
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p15-fake-git-"));
  const logFile = path.join(dir, "calls.jsonl");
  fs.writeFileSync(logFile, "");
  const script = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
"${process.execPath}" -e '
  const fs = require("node:fs");
  const args = process.argv.slice(2).filter((a) => a !== "--");
  fs.appendFileSync(${JSON.stringify(
    logFile
  )}, JSON.stringify({ args }) + "\\n");
  if (args.includes("rev-parse")) {
    process.stdout.write("1111222233334444555566667777888899990000\\n");
    process.exit(0);
  }
  process.exit(0);
' "$SCRIPT_DIR" -- "$@"
`;
  const gitPath = path.join(dir, "git");
  fs.writeFileSync(gitPath, script, { encoding: "utf8" });
  fs.chmodSync(gitPath, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = dir + (origPath ? `:${origPath}` : "");
  const readCalls = (): FakeGitCall[] => {
    const raw = fs.readFileSync(logFile, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as FakeGitCall);
  };
  try {
    return await fn({
      readCalls,
      reset: () => fs.writeFileSync(logFile, ""),
      logFile,
    });
  } finally {
    process.env.PATH = origPath;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

function pushTargetAndRefspec(call: FakeGitCall): {
  target: string | undefined;
  refspec: string | undefined;
} {
  const idx = call.args.indexOf("push");
  if (idx < 0) return { target: undefined, refspec: undefined };
  let j = idx + 1;
  if (call.args[j] === "--") j += 1;
  return { target: call.args[j], refspec: call.args[j + 1] };
}

describe("Property 15: No upstream writes (pushToFork)", () => {
  it("refuses upstream targets, missing push flag, non-done phases and non-graveyard branches", async () => {
    await fc.assert(
      fc.asyncProperty(
        slugArb,
        slugArb,
        slugArb,
        slugArb,
        slugArb,
        fc.constantFrom("queued", "legion", "report"),
        async (runId, sOwner, sRepo, fOwner, fRepo, phase) => {
          const sourceUrl = `https://github.com/${sOwner}/${sRepo}`;
          const forkUrl = `https://github.com/${fOwner}/${fRepo}`;
          // Independent gate tests must use a real distinct fork target.
          fc.pre(sourceUrl !== forkUrl);
          const service = new GitService({ ownerLogin: fOwner, sourceRepoUrl: sourceUrl });
          const common = {
            targetRepoUrl: forkUrl,
            sourceRepoUrl: sourceUrl,
            forkChecker: async () => `${sOwner}/${sRepo}`,
            token: FAKE_WRITE_TOKEN,
          };

          // Non-"done" phase is refused before any network operation.
          await assert.rejects(
            service.pushToFork(runId, { ...common, runPhase: phase, invitePushFlag: true }),
            (err: unknown) =>
              err instanceof GitServiceError && err.code === "INVALID_RUN_PHASE"
          );

          // Missing/disabled invite push flag is refused.
          await assert.rejects(
            service.pushToFork(runId, {
              ...common,
              runPhase: "done",
              invitePushFlag: false,
            }),
            (err: unknown) =>
              err instanceof GitServiceError && err.code === "PUSH_FLAG_DISABLED"
          );

          // Explicit push confirmation of false is refused.
          await assert.rejects(
            service.pushToFork(runId, {
              ...common,
              runPhase: "done",
              invitePushFlag: true,
              pushConfirm: false,
            }),
            (err: unknown) =>
              err instanceof GitServiceError && err.code === "PUSH_NOT_CONFIRMED"
          );

          // The upstream source repository is never a legal target.
          await assert.rejects(
            service.pushToFork(runId, {
              ...common,
              targetRepoUrl: sourceUrl,
              runPhase: "done",
              invitePushFlag: true,
            }),
            (err: unknown) =>
              err instanceof GitServiceError && err.code === "SOURCE_WRITE_FORBIDDEN"
          );

          // Only graveyard/<runId> may be pushed.
          await assert.rejects(
            service.pushToFork(runId, {
              ...common,
              runPhase: "done",
              invitePushFlag: true,
              pushConfirm: true,
              branchName: "main",
            }),
            (err: unknown) =>
              err instanceof GitServiceError && err.code === "INVALID_PUSH_BRANCH"
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  it("never pushes to the source repository and always uses graveyard/<runId>", async () => {
    await withFakeGit(async ({ readCalls, reset }) => {
      const eventStore = new EventStore(":memory:");
      await fc.assert(
        fc.asyncProperty(
          slugArb,
          slugArb,
          slugArb,
          slugArb,
          slugArb,
          fc.boolean(),
          fc.constantFrom("queued", "legion", "report", "done"),
          fc.boolean(),
          fc.option(fc.boolean(), { nil: undefined }),
          fc.constantFrom("default", "main", "correct", "refspec"),
          async (
            runId,
            sOwner,
            sRepo,
            fOwner,
            fRepo,
            useSourceTarget,
            phase,
            flag,
            confirm,
            branchMode
          ) => {
            reset();
            const sourceUrl = `https://github.com/${sOwner}/${sRepo}`;
            const forkUrl = `https://github.com/${fOwner}/${fRepo}`;
            // Independent gate tests must use a real distinct fork target.
            fc.pre(sourceUrl !== forkUrl);
            const service = new GitService({
              ownerLogin: fOwner,
              sourceRepoUrl: sourceUrl,
              runsDir: os.tmpdir(),
            });
            const branch = `graveyard/${runId}`;
            let branchName: string | undefined;
            if (branchMode === "main") branchName = "main";
            else if (branchMode === "correct") branchName = branch;
            else if (branchMode === "refspec") branchName = `refs/heads/${branch}`;

            const options: Record<string, unknown> = {
              targetRepoUrl: useSourceTarget ? sourceUrl : forkUrl,
              sourceRepoUrl: sourceUrl,
              runPhase: phase,
              invitePushFlag: flag,
              forkChecker: async () => `${sOwner}/${sRepo}`,
              token: FAKE_WRITE_TOKEN,
              eventStore,
              gitDir: path.join(os.tmpdir(), "p15-no-such-git-dir"),
            };
            if (confirm !== undefined) options.pushConfirm = confirm;
            if (branchName !== undefined) options.branchName = branchName;

            let code: string | undefined;
            try {
              await service.pushToFork(runId, options as never);
            } catch (err) {
              if (err instanceof GitServiceError) code = err.code;
              else throw err;
            }

            const pushes = readCalls().filter((c) => c.args.includes("push"));
            for (const push of pushes) {
              const { target, refspec } = pushTargetAndRefspec(push);
              assert.notEqual(
                target,
                sourceUrl,
                "pushToFork must never push to the source repository"
              );
              assert.equal(target, forkUrl, "pushToFork must only push to the verified fork");
              assert.equal(
                refspec,
                `refs/heads/${branch}:refs/heads/${branch}`,
                "pushToFork must only push the graveyard/<runId> branch"
              );
              assert.ok(!refspec.startsWith("+"), "force push must be impossible");
              assert.ok(
                !refspec.includes("refs/heads/main"),
                "main must never be pushed"
              );
            }

            if (code !== undefined) {
              assert.ok(
                ALLOWED_REFUSAL_CODES.has(code),
                `unexpected refusal code '${code}' for run ${runId}`
              );
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});

