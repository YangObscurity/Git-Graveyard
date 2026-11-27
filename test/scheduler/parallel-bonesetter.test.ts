/**
 * Task 20.4: Integration tests for the Bonesetter worktree write boundary, the
 * Headless Fallback execution channel and the parallel Soul-stitcher scheduler.
 *
 * Covers:
 *  - Bonesetter write permission ONLY on root manifests/lockfiles and explicit
 *    denial on repository source code / secrets / `.git` / `.kiro`.
 *  - Headless Fallback stream-json parsing, exit-code mapping, auto-denied asks
 *    and `--resume-id` approval resumption (with S2-false refusal).
 *  - ParallelScheduler slot concurrency, approved priority order, Opus/Sonnet
 *    assignment, isolated git worktrees/branches and the serialized Warden queue.
 */
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  BONESETTER_MANIFEST_ALLOW_PATTERNS,
  BONESETTER_WRITABLE_FILENAMES,
  BonesetterWriteDeniedError,
  createBonesetterToolClient,
  isBonesetterWritablePath,
  prepareBonesetterSession,
  validateBonesetterTemplate,
} from "../../lib/agents/bonesetter";
import {
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
} from "../../lib/agents/model-allowlist";
import { GitService } from "../../lib/git/git-service";
import { EventStore } from "../../lib/events/event-store";
import { candidateSha256FromDiff } from "../../lib/merge/candidate-hash";
import type { PactTask } from "../../lib/pact/pact-parser";
// Import via the module barrel to assert the Task 20.3 re-export from index.ts.
import { ParallelScheduler } from "../../lib/scheduler";
import { parallelScopesConflict } from "../../lib/scheduler/parallel-scheduler";
import type {
  ParallelSchedulerRunner,
  ParallelSchedulerCandidate,
  ParallelSchedulerOptions,
  ParallelSchedulerWardenReview,
  ParallelSlotContext,
  ParallelWardenDecision,
} from "../../lib/scheduler/parallel-scheduler";
import type { TaskMergeEvidence } from "../../lib/scheduler/types";
import { mapHeadlessExitCode, parseStreamJsonLine } from "../../lib/acp/stream-parser";
import { HeadlessFallbackChannel } from "../../lib/acp/headless-fallback";
import type { ChildProcessLike, SpawnFunction } from "../../lib/supervisor/types";

// Independent literal copy of the ten allowed root manifest/lockfile names. The
// test compares the production allowlist against this list (not itself) so a
// silent change to either side is caught.
const EXPECTED_BONESETTER_ROOT_FILENAMES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "requirements.txt",
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function tempLogPath(prefix: string): { logPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pb-${prefix}-`));
  return {
    logPath: path.join(dir, "stream.jsonl"),
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  } as unknown as NodeJS.ProcessEnv;
}

function runGit(args: string[], cwd: string, home: string): string {
  return childProcess
    .execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(home) })
    .trim();
}

interface RepoFixture {
  tmpDir: string;
  runId: string;
  gitDir: string;
  runDir: string;
  baseSha: string;
  cleanup: () => void;
}

function createRepoFixture(runId: string): RepoFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-repo-"));
  const gitDir = path.join(tmpDir, "git");
  fs.mkdirSync(gitDir, { recursive: true });
  const home = tmpDir;

  runGit(["init", "--initial-branch=main", "."], gitDir, home);
  runGit(["config", "user.name", "Test Runner"], gitDir, home);
  runGit(["config", "user.email", "runner@example.test"], gitDir, home);
  fs.writeFileSync(path.join(gitDir, "README.md"), "base\n", "utf8");
  fs.writeFileSync(
    path.join(gitDir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2),
    "utf8"
  );
  runGit(["add", "."], gitDir, home);
  runGit(["commit", "-m", "base commit"], gitDir, home);
  const baseSha = runGit(["rev-parse", "HEAD"], gitDir, home);
  runGit(["branch", `graveyard/${runId}`, baseSha], gitDir, home);

  return {
    tmpDir,
    runId,
    gitDir,
    runDir: tmpDir,
    baseSha,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function makePactTask(id: string, overrides: Partial<PactTask> = {}): PactTask {
  const hard = overrides.hard ?? false;
  return {
    id,
    title: overrides.title ?? id,
    role: overrides.role ?? "soul-stitcher",
    dependencies: overrides.dependencies ?? [],
    depends: overrides.depends ?? [],
    dependsOn: overrides.dependsOn ?? [],
    files: overrides.files ?? overrides.filesInScope ?? [],
    filesInScope: overrides.filesInScope ?? overrides.files ?? [],
    acceptanceCommand: overrides.acceptanceCommand ?? "true",
    accept: overrides.accept ?? "true",
    hard,
    hardFlag: hard,
    hardRaw: hard ? "yes" : "no",
    ruleIds: overrides.ruleIds ?? [],
    rules: overrides.rules ?? [],
    line: overrides.line ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Headless Fallback harness
// ---------------------------------------------------------------------------

class MockProcess extends EventEmitter {
  stdin = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | string | null = null;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface Captured {
  args?: readonly string[];
  calls: number;
}

/** Writes scripted stdout lines and closes with the given exit code. */
function makeSpawn(
  script: (
    callIndex: number,
    args: readonly string[]
  ) => { lines: unknown[]; code: number | null },
  captured: Captured
): SpawnFunction {
  return (_command: string, args: readonly string[]): ChildProcessLike => {
    captured.calls += 1;
    captured.args = args;
    const proc = new MockProcess();
    const { lines, code } = script(captured.calls - 1, args);
    setImmediate(() => {
      for (const line of lines) {
        proc.stdout.write(
          typeof line === "string" ? line : `${JSON.stringify(line)}\n`
        );
      }
      proc.stdout.end();
      setImmediate(() => {
        proc.exitCode = code;
        proc.emit("close", code);
      });
    });
    return proc as unknown as ChildProcessLike;
  };
}

function makeChannel(
  options: Partial<ConstructorParameters<typeof HeadlessFallbackChannel>[0]> = {}
): HeadlessFallbackChannel {
  const { onAskAutoDeny, ...rest } = options;
  return new HeadlessFallbackChannel({
    runId: "run-1",
    skeletonId: "skel-1",
    kiroHomeDir: "/isolated/kiro-home",
    homeDir: "/isolated/home",
    modelId: CLAUDE_SONNET_5_5_MODEL_ID,
    agentName: "soul-stitcher",
    worktreeDir: "/tmp/worktree",
    p1Passed: false,
    p14Passed: true,
    ...rest,
    // The hook is required in production; default to a no-op and let a test
    // override it (including `undefined` to exercise the fail-closed path).
    onAskAutoDeny: onAskAutoDeny ?? (() => {}),
  });
}

const MODEL_RECORD = { type: "session", model: CLAUDE_SONNET_5_5_MODEL_ID };

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// ParallelScheduler controlled runner
// ---------------------------------------------------------------------------

interface ControlledRunner {
  runner: ParallelSchedulerRunner;
  contexts: Map<string, ParallelSlotContext>;
  dispatchOrder: string[];
  branches: Map<string, string>;
  committed: Map<string, string>;
  running: () => number;
  maxRunning: number;
  pending(): string[];
  release(taskId: string): void;
  releaseAll(): void;
}

function commitWorktree(worktreeDir: string, taskId: string, home: string): string {
  fs.writeFileSync(
    path.join(worktreeDir, `${taskId}.txt`),
    `${taskId} candidate\n`,
    "utf8"
  );
  runGit(["add", "-A"], worktreeDir, home);
  runGit(
    [
      "-c",
      "user.name=Test Runner",
      "-c",
      "user.email=runner@example.test",
      "commit",
      "-m",
      `work ${taskId}`,
    ],
    worktreeDir,
    home
  );
  return runGit(["rev-parse", "HEAD"], worktreeDir, home);
}

/**
 * Commits a large, unrelated file directly onto the run's integration branch
 * (as a concurrent task's merge would), WITHOUT it ever being part of any
 * candidate's diff. Used to prove `workerLoop` measures a candidate against its
 * OWN worktree base so the bloat never overflows the capture buffer.
 */
function commitBigFileToIntegration(
  fixture: RepoFixture,
  fileName: string,
  bytes: number
): string {
  const home = fixture.tmpDir;
  const integrationRef = `graveyard/${fixture.runId}`;
  const head = runGit(["rev-parse", integrationRef], fixture.gitDir, home);
  const wt = path.join(fixture.tmpDir, `external-${fileName}-wt`);
  fs.rmSync(wt, { recursive: true, force: true });
  runGit(["worktree", "add", "--detach", wt, head], fixture.gitDir, home);
  const line = "0123456789abcdef\n";
  const count = Math.ceil(bytes / line.length);
  fs.writeFileSync(path.join(wt, fileName), line.repeat(count), "utf8");
  runGit(["add", "-A"], wt, home);
  runGit(
    [
      "-c",
      "user.name=External Merger",
      "-c",
      "user.email=external@example.test",
      "commit",
      "-m",
      `external big merge ${fileName}`,
    ],
    wt,
    home
  );
  const sha = runGit(["rev-parse", "HEAD"], wt, home);
  runGit(["update-ref", `refs/heads/${integrationRef}`, sha], fixture.gitDir, home);
  runGit(["worktree", "remove", "--force", wt], fixture.gitDir, home);
  return sha;
}

function makeControlledRunner(home: string): ControlledRunner {
  const gates = new Map<string, () => void>();
  const contexts = new Map<string, ParallelSlotContext>();
  const dispatchOrder: string[] = [];
  const branches = new Map<string, string>();
  const committed = new Map<string, string>();
  const state = { running: 0, maxRunning: 0 };

  const runner: ParallelSchedulerRunner = async (ctx) => {
    state.running += 1;
    state.maxRunning = Math.max(state.maxRunning, state.running);
    contexts.set(ctx.taskId, ctx);
    dispatchOrder.push(ctx.taskId);
    branches.set(ctx.taskId, ctx.branch);

    await new Promise<void>((resolve) => {
      gates.set(ctx.taskId, resolve);
      ctx.signal.addEventListener(
        "abort",
        () => {
          gates.delete(ctx.taskId);
          resolve();
        },
        { once: true }
      );
    });

    state.running -= 1;
    if (ctx.signal.aborted) {
      return { ok: false, reason: "aborted" };
    }
    const sha = commitWorktree(ctx.worktreeDir, ctx.taskId, home);
    committed.set(ctx.taskId, sha);
    return { ok: true, candidateSha: sha };
  };

  const release = (taskId: string): void => {
    const gate = gates.get(taskId);
    if (gate) {
      gates.delete(taskId);
      gate();
    }
  };

  return {
    runner,
    contexts,
    dispatchOrder,
    branches,
    committed,
    running: () => state.running,
    get maxRunning() {
      return state.maxRunning;
    },
    pending: () => [...gates.keys()],
    release,
    releaseAll: () => {
      for (const id of [...gates.keys()]) {
        release(id);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Bonesetter worktree write boundary
// ---------------------------------------------------------------------------

describe("Bonesetter worktree write boundary (Task 20.4)", () => {
  it("permits writes only on the ten root manifest/lockfile names", () => {
    assert.equal(EXPECTED_BONESETTER_ROOT_FILENAMES.length, 10);
    assert.deepEqual(
      [...BONESETTER_WRITABLE_FILENAMES].sort(),
      [...EXPECTED_BONESETTER_ROOT_FILENAMES].map((n) => n.toLowerCase()).sort()
    );
    for (const name of EXPECTED_BONESETTER_ROOT_FILENAMES) {
      assert.equal(isBonesetterWritablePath(name), true, `${name} must be writable`);
    }
    // Root-only: a nested manifest is never writable.
    assert.equal(isBonesetterWritablePath("packages/app/package.json"), false);
    assert.equal(isBonesetterWritablePath("./package.json"), false);
  });

  it("denies repository source code, secrets, .git/ and .kiro/", () => {
    const denied = [
      "src/index.ts",
      "lib/app.js",
      "app/main.py",
      ".env",
      ".env.local",
      "id_rsa",
      "deploy.pem",
      ".git/config",
      ".git/HEAD",
      ".kiro/steering/guide.md",
      "../package.json",
      "/etc/passwd",
      "requirements-dev.txt",
    ];
    for (const p of denied) {
      assert.equal(isBonesetterWritablePath(p), false, `${p} must be denied`);
    }
  });

  it("initializes against a real temp git worktree and enforces the boundary via the tool client", async () => {
    const runId = "pbbone";
    const fixture = createRepoFixture(runId);
    const service = new GitService({ runsDir: fixture.runDir });
    const worktree = await service.createTaskWorktree({
      runId,
      taskId: "bone-1",
      gitDir: fixture.gitDir,
      runDir: fixture.runDir,
    });
    try {
      // A genuine git worktree was provisioned on disk.
      assert.ok(fs.existsSync(worktree.worktreeDir));
      assert.ok(fs.existsSync(path.join(worktree.worktreeDir, ".git")));

      const session = prepareBonesetterSession({
        runId,
        skeletonId: "skel-1",
        worktreeDir: worktree.worktreeDir,
        baseDir: path.join(fixture.runDir, "homes"),
        grimoireGuidance: [{ fileName: "guide.md", content: "# Guide\n" }],
      });
      assert.equal(session.modelId, CLAUDE_SONNET_5_5_MODEL_ID);
      assert.equal(session.policyPreset, "read-workspace");
      assert.deepEqual(session.manifestAllowPatterns, [
        ...BONESETTER_MANIFEST_ALLOW_PATTERNS,
      ]);
      assert.equal(session.steeringFiles.length, 1);
      assert.ok(
        fs.existsSync(
          path.join(worktree.worktreeDir, ".kiro", "steering", "guide.md")
        )
      );
      // The committed template still validates against the allowlist.
      validateBonesetterTemplate();

      const written: string[] = [];
      const client = createBonesetterToolClient({
        read: async () => ({}),
        write: async (args) => {
          fs.writeFileSync(
            path.join(worktree.worktreeDir, args.path),
            args.content,
            "utf8"
          );
          written.push(args.path);
          return { ok: true };
        },
        sandboxExec: async () => ({}),
        sandboxLog: async () => ({}),
        reportTaskResult: async () => ({}),
        ask: async () => ({}),
        reportBlocker: async () => ({}),
        ackMessage: async () => ({}),
      });

      await client.write({ path: "package.json", content: '{"name":"x"}' });
      await client.write({ path: "package-lock.json", content: "{}" });
      await client.write({ path: "yarn.lock", content: "lockfile-version: 1\n" });
      assert.deepEqual(written, [
        "package.json",
        "package-lock.json",
        "yarn.lock",
      ]);
      assert.ok(fs.existsSync(path.join(worktree.worktreeDir, "package.json")));

      for (const bad of [
        "src/index.ts",
        ".env",
        ".git/config",
        ".kiro/steering/guide.md",
        "packages/app/package.json",
      ]) {
        await assert.rejects(
          () => client.write({ path: bad, content: "x" }),
          BonesetterWriteDeniedError
        );
      }
      // A denied source write never touched disk.
      assert.equal(fs.existsSync(path.join(worktree.worktreeDir, "src")), false);
    } finally {
      await worktree.cleanup();
      fixture.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Headless Fallback execution
// ---------------------------------------------------------------------------

describe("Headless Fallback execution (Task 20.4)", () => {
  it("parses stream-json lines defensively", () => {
    assert.deepEqual(parseStreamJsonLine('{"type":"session","id":"s-1"}'), {
      type: "session",
      id: "s-1",
    });
    assert.equal(parseStreamJsonLine(""), null);
    assert.equal(parseStreamJsonLine("  "), null);
    assert.equal(parseStreamJsonLine("{ not json")?.type, "parse_warning");
  });

  it("maps exit codes 0/1/3/4 with output discard only for 4", () => {
    assert.deepEqual(mapHeadlessExitCode(0), {
      ok: true,
      status: "success",
      discardOutput: false,
    });
    assert.deepEqual(mapHeadlessExitCode(1), {
      ok: false,
      status: "failure",
      discardOutput: false,
    });
    assert.deepEqual(mapHeadlessExitCode(3), {
      ok: false,
      status: "gateway_missing",
      discardOutput: false,
    });
    assert.deepEqual(mapHeadlessExitCode(4), {
      ok: false,
      status: "missing_agent",
      discardOutput: true,
    });
  });

  it("maps exit 0 to success and exit 1/3 to their statuses", async () => {
    for (const [code, status] of [
      [0, "success"],
      [1, "failure"],
      [3, "gateway_missing"],
    ] as const) {
      const { logPath, cleanup } = tempLogPath(`exit-${code}`);
      try {
        const captured: Captured = { calls: 0 };
        const channel = makeChannel({
          logPath,
          spawnFn: makeSpawn(
            () => ({
              lines: [MODEL_RECORD, { type: "assistant", text: "done" }],
              code,
            }),
            captured
          ),
        });
        const result = await channel.runTurn({ prompt: "run" });
        assert.equal(result.status, status, `exit ${code}`);
        assert.equal(result.ok, code === 0);
        assert.equal(result.outputDiscarded, false);
      } finally {
        cleanup();
      }
    }
  });

  it("maps exit 4 to missing_agent and discards the streamed output", async () => {
    const { logPath, cleanup } = tempLogPath("exit-4");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        spawnFn: makeSpawn(
          () => ({
            lines: [MODEL_RECORD, { type: "assistant", text: "leaked output" }],
            code: 4,
          }),
          captured
        ),
      });
      const result = await channel.runTurn({ prompt: "run" });
      assert.equal(result.status, "missing_agent");
      assert.equal(result.ok, false);
      assert.equal(result.outputDiscarded, true);
      assert.equal(result.output, "");
    } finally {
      cleanup();
    }
  });

  it("invokes the explicit onAskAutoDeny hook and records the auto-denied ask", async () => {
    const { logPath, cleanup } = tempLogPath("ask");
    try {
      const denied: Array<string | null> = [];
      const channel = makeChannel({
        logPath,
        onAskAutoDeny: (ask) => {
          denied.push(ask.askId);
        },
        spawnFn: makeSpawn(
          () => ({
            lines: [
              MODEL_RECORD,
              { type: "ask_request", askId: "a-1", text: "which manager?" },
            ],
            code: 0,
          }),
          { calls: 0 }
        ),
      });
      const result = await channel.runTurn({ prompt: "run" });
      assert.equal(result.ok, true);
      assert.deepEqual(denied, ["a-1"]);
      assert.equal(result.autoDeniedAsks.length, 1);
      assert.equal(result.autoDeniedAsks[0].askId, "a-1");
    } finally {
      cleanup();
    }
  });
});

describe("Headless Fallback approval interrupts (Task 20.4)", () => {
  it("refuses needs_approval when S2 resume is unsupported and never resumes", async () => {
    const { logPath, cleanup } = tempLogPath("s2-false");
    try {
      const captured: Captured = { calls: 0 };
      const channel = makeChannel({
        logPath,
        s2ResumeSupported: false,
        onApproval: () => "approve",
        spawnFn: makeSpawn(
          () => ({
            lines: [
              {
                type: "session",
                sessionId: "sess-9",
                model: CLAUDE_SONNET_5_5_MODEL_ID,
              },
              { type: "approval_request", approvalId: "ap-1", tool: "shell" },
            ],
            code: 0,
          }),
          captured
        ),
      });
      const result = await channel.runTurn({ prompt: "run a command" });
      assert.equal(result.ok, false);
      assert.equal(result.status, "refused");
      assert.equal(result.reason, "approval_resume_unsupported");
      assert.equal(result.approvals.length, 1);
      assert.equal(result.approvals[0].approvalId, "ap-1");
      assert.equal(captured.calls, 1);
    } finally {
      cleanup();
    }
  });

  it("resumes with --resume-id <sessionId> after an approved interrupt", async () => {
    const { logPath, cleanup } = tempLogPath("s2-true");
    try {
      const spawnArgs: Array<readonly string[]> = [];
      const seenApprovalIds: Array<string | null> = [];
      const channel = makeChannel({
        logPath,
        s2ResumeSupported: true,
        onApproval: (request) => {
          seenApprovalIds.push(request.approvalId);
          return "approve";
        },
        spawnFn: (_command, args) => {
          spawnArgs.push(args);
          const proc = new MockProcess();
          const call = spawnArgs.length - 1;
          const lines =
            call === 0
              ? [
                  {
                    type: "session",
                    sessionId: "sess-42",
                    model: CLAUDE_SONNET_5_5_MODEL_ID,
                  },
                  { type: "approval_request", approvalId: "ap-7", tool: "shell" },
                ]
              : [MODEL_RECORD];
          setImmediate(() => {
            for (const line of lines) {
              proc.stdout.write(`${JSON.stringify(line)}\n`);
            }
            proc.stdout.end();
            setImmediate(() => {
              proc.exitCode = 0;
              proc.emit("close", 0);
            });
          });
          return proc as unknown as ChildProcessLike;
        },
      });
      const result = await channel.runTurn({ prompt: "run a command" });
      assert.equal(result.ok, true);
      assert.equal(result.resumed, true);
      assert.deepEqual(seenApprovalIds, ["ap-7"]);
      assert.equal(spawnArgs.length, 2);
      const resumeArgs = spawnArgs[1];
      const resumeIndex = resumeArgs.indexOf("--resume-id");
      assert.ok(resumeIndex >= 0, "resume turn must carry --resume-id");
      assert.equal(resumeArgs[resumeIndex + 1], "sess-42");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ParallelScheduler integration (real temp git worktrees)
// ---------------------------------------------------------------------------

function makeScheduler(
  fixture: RepoFixture,
  tasks: PactTask[],
  runner: ParallelSchedulerRunner,
  overrides: Partial<ParallelSchedulerOptions> = {}
): ParallelScheduler {
  return new ParallelScheduler({
    runId: fixture.runId,
    runsDir: fixture.runDir,
    gitDir: fixture.gitDir,
    integrationBranch: `graveyard/${fixture.runId}`,
    tasks,
    approvedTaskIds: tasks.map((t) => t.id),
    runner,
    ...overrides,
  });
}

async function drainRun<T>(
  runPromise: Promise<T>,
  controller: ControlledRunner,
  timeoutMs = 15000
): Promise<T> {
  let done = false;
  const tracked = runPromise.then(
    (value) => {
      done = true;
      return value;
    },
    (err) => {
      done = true;
      throw err;
    }
  );
  const deadline = Date.now() + timeoutMs;
  while (!done) {
    if (Date.now() > deadline) {
      throw new Error(
        `drainRun timed out after ${timeoutMs}ms: ParallelScheduler.run() did not settle`
      );
    }
    controller.releaseAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return tracked;
}

/**
 * A Warden review that approves every candidate with its own hash. When a
 * harness is supplied the reviewed sha is recorded so the harness's
 * `mergeCandidate` can assert the exact approved commit is what merged.
 */
function makeApprovingWarden(
  harness?: MergeHarness
): ParallelSchedulerWardenReview {
  return async (candidate: ParallelSchedulerCandidate) => {
    harness?.reviewedShas.set(candidate.taskId, candidate.candidateSha);
    return {
      approved: true,
      candidateSha256: candidate.candidateSha256,
    };
  };
}

interface MergeHarness {
  gitService: GitService;
  store: EventStore;
  mergeCandidate: NonNullable<ParallelSchedulerOptions["mergeCandidate"]>;
  /** Candidate shas recorded by the Warden review, keyed by task id. */
  reviewedShas: Map<string, string>;
  wardenReview: ParallelSchedulerWardenReview;
}

/**
 * Builds a `mergeCandidate` executor that performs a real verified git merge and
 * returns the evidence the composed Scheduler requires. The scheduler rebases an
 * approved candidate onto the integration head BEFORE `wardenReview`, so the
 * candidate sha is already a descendant of the integration head here. This
 * executor asserts that invariant (and that the reviewed sha is the merged sha)
 * instead of replaying or mutating the candidate.
 */
function makeMergeHarness(fixture: RepoFixture): MergeHarness {
  const gitService = new GitService({ runsDir: fixture.runDir });
  const store = new EventStore();
  const home = fixture.tmpDir;
  const integrationRef = `graveyard/${fixture.runId}`;
  const reviewedShas = new Map<string, string>();

  const mergeCandidate: MergeHarness["mergeCandidate"] = async (candidate) => {
    // The snapshot handed to the merge is the SAME deep-frozen snapshot the
    // Warden reviewed, so it can neither be mutated nor differ from review.
    const reviewedSha = reviewedShas.get(candidate.taskId);
    assert.ok(
      reviewedSha,
      `${candidate.taskId} must be reviewed before it is merged`
    );
    assert.equal(
      reviewedSha,
      candidate.candidateSha,
      "reviewedSha must equal mergedSha (the approved commit is what merges)"
    );
    assert.ok(
      Object.isFrozen(candidate),
      "candidate snapshot passed to mergeCandidate must be frozen"
    );

    const head = runGit(["rev-parse", integrationRef], fixture.gitDir, home);
    // The scheduler rebased the candidate onto the integration head BEFORE the
    // Warden reviewed it, so the candidate is already a descendant here.
    assert.doesNotThrow(
      () =>
        runGit(
          ["merge-base", "--is-ancestor", head, candidate.candidateSha],
          fixture.gitDir,
          home
        ),
      "candidateSha must already be a descendant of the integration head"
    );

    const candidateSha = candidate.candidateSha;
    const tree = runGit(["rev-parse", `${candidateSha}^{tree}`], fixture.gitDir, home);
    const rawDiff = childProcess
      .execFileSync(
        "git",
        ["diff", "--binary", "--no-color", "--end-of-options", `${head}..${candidateSha}`],
        {
          cwd: fixture.gitDir,
          encoding: "utf8",
          env: gitEnv(home),
          maxBuffer: 20 * 1024 * 1024,
        }
      )
      .toString();
    const candidateSha256 = candidateSha256FromDiff(rawDiff);
    store.append({
      runId: fixture.runId,
      kind: "verdict",
      actor: "warden",
      taskId: candidate.taskId,
      data: { taskId: candidate.taskId, verdict: "approve", candidateSha256, tree },
    });
    store.append({
      runId: fixture.runId,
      kind: "gate.result",
      actor: "gate",
      taskId: candidate.taskId,
      data: { taskId: candidate.taskId, ok: true, tree },
    });
    const verdict = {
      verdict: "approve",
      status: "approve",
      candidateSha,
      candidateSha256,
      tree,
      reasons: [{ text: "All checks passed", refs: ["cmd:true"] }],
      checks: {
        install: { ok: true },
        build: { ok: true },
        accept: { ok: true },
        tests: { ok: true },
        noTestWeakening: { ok: true },
      },
    };
    const gateResult = { ok: true, tree };
    const mergeResult = await (gitService as any).mergeCandidate({
      runId: fixture.runId,
      candidateSha,
      expectedIntegrationHeadSha: head,
      candidateSha256,
      verdict,
      verdictCandidateSha256: candidateSha256,
      gateResult,
      gitDir: fixture.gitDir,
      runDir: fixture.runDir,
    });
    if (!mergeResult || !mergeResult.ok || !mergeResult.merged) {
      return { ok: false, reason: mergeResult?.reason ?? "merge_failed" };
    }
    const evidence = {
      verdict,
      gateResult,
      candidateSha,
      candidateSha256,
      tree,
      gateTree: tree,
      verdictTree: tree,
      expectedHeadSha: head,
      currentHeadSha: head,
      integrationHeadSha: head,
      diff: rawDiff,
      taskId: candidate.taskId,
      runId: fixture.runId,
      eventSource: store,
      gitMerge: mergeResult,
    } as unknown as TaskMergeEvidence;
    return { ok: true, evidence };
  };

  const harness: MergeHarness = {
    gitService,
    store,
    mergeCandidate,
    reviewedShas,
    // Replaced immediately below; makeApprovingWarden records into `reviewedShas`.
    wardenReview: async () => ({ approved: false, reason: "uninitialized" }),
  };
  harness.wardenReview = makeApprovingWarden(harness);
  return harness;
}

describe("ParallelScheduler concurrency & dispatch (Task 20.4)", () => {
  it("never exceeds min(parallelCap, globalCap, runningMax)", async () => {
    const fixture = createRepoFixture("cap");
    try {
      const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id, index) =>
        makePactTask(id, { filesInScope: [`src/${id}.ts`], line: index + 1 })
      );
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        globalCap: 3,
        runningMax: 4,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
      });
      // min over the SPECIFIED bounds only; default 1 when none is specified.
      assert.equal(
        makeScheduler(fixture, tasks, controller.runner, {
          globalCap: 3,
          runningMax: 4,
        }).getEffectiveCap(),
        3
      );
      assert.equal(
        makeScheduler(fixture, tasks, controller.runner, {}).getEffectiveCap(),
        1
      );

      assert.equal(scheduler.getEffectiveCap(), 2);
      assert.equal(scheduler.getScheduler().getEffectiveLimit(), 2);
      assert.equal(scheduler.maxConcurrentWarden, 1);

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);
      assert.equal(scheduler.getStatus().activeSlots, 2);

      const summary = await drainRun(runPromise, controller);
      assert.equal(summary.effectiveCap, 2);
      assert.equal(summary.maxObservedConcurrency, 2);
      assert.ok(summary.maxObservedConcurrency <= 2);
      assert.equal(controller.maxRunning, 2);
      assert.equal(summary.dispatched, 6);
      assert.equal(summary.candidatesProduced, 6);
      assert.equal(summary.merged, 6);
    } finally {
      fixture.cleanup();
    }
  });

  it("dispatches in approved priority order, assigns Opus/Sonnet and isolates worktrees", async () => {
    const fixture = createRepoFixture("prio");
    try {
      const tasks = [
        makePactTask("t1", { hard: true, filesInScope: ["src/t1.ts"], line: 1 }),
        makePactTask("t2", { filesInScope: ["src/t2.ts"], line: 2 }),
        makePactTask("t3", { filesInScope: ["src/t3.ts"], line: 3 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
      });

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);

      // Priority order from the approved tasks.md.
      assert.deepEqual(scheduler.getDispatchSequence().slice(0, 2), ["t1", "t2"]);
      // Opus for hard: yes, Sonnet for standard tasks.
      assert.equal(
        controller.contexts.get("t1")!.modelId,
        CLAUDE_OPUS_5_5_MODEL_ID
      );
      assert.equal(
        controller.contexts.get("t2")!.modelId,
        CLAUDE_SONNET_5_5_MODEL_ID
      );
      assert.equal(
        scheduler.getScheduler().getModelTier("t1"),
        CLAUDE_OPUS_5_5_MODEL_ID
      );
      assert.equal(
        scheduler.getScheduler().getModelTier("t2"),
        CLAUDE_SONNET_5_5_MODEL_ID
      );

      // Separate isolated worktrees on distinct branches.
      assert.equal(controller.branches.get("t1"), "task/t1");
      assert.equal(controller.branches.get("t2"), "task/t2");
      assert.notEqual(
        controller.contexts.get("t1")!.worktreeDir,
        controller.contexts.get("t2")!.worktreeDir
      );
      for (const id of ["t1", "t2"]) {
        assert.ok(
          fs.existsSync(controller.contexts.get(id)!.worktreeDir),
          `${id} worktree exists while running`
        );
      }

      // Freeing a slot dispatches the next task in priority order.
      controller.release("t1");
      await waitFor(() => scheduler.getDispatchSequence().length >= 3);
      assert.equal(scheduler.getDispatchSequence()[2], "t3");

      const summary = await drainRun(runPromise, controller);
      assert.equal(summary.candidatesProduced, 3);
      // Each slot ran on its own distinct branch.
      assert.equal(new Set([...controller.branches.values()]).size, 3);

      // Deterministic slot cleanup on completion.
      const builders = path.join(fixture.runDir, fixture.runId, "builders");
      for (const id of ["t1", "t2", "t3"]) {
        assert.equal(
          fs.existsSync(path.join(builders, id)),
          false,
          `${id} worktree cleaned up`
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("never dispatches two concurrent slots with overlapping filesInScope", async () => {
    const fixture = createRepoFixture("conflict");
    try {
      assert.equal(
        parallelScopesConflict(["src/shared.ts"], ["src/shared.ts"]),
        true
      );
      assert.equal(parallelScopesConflict(["src/a.ts"], ["src/b.ts"]), false);

      const tasks = [
        makePactTask("A", { filesInScope: ["src/shared.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/shared.ts"], line: 2 }),
        makePactTask("C", { filesInScope: ["src/c.ts"], line: 3 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 3,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
      });

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);

      // A and C run; B is skipped because A owns src/shared.ts while it runs.
      assert.deepEqual(scheduler.getDispatchSequence(), ["A", "C"]);
      assert.equal(scheduler.getStatus().activeSlots, 2);
      assert.equal(controller.contexts.has("B"), false);

      const summary = await drainRun(runPromise, controller);
      // Once A merges and releases its claim, B may finally be dispatched (never
      // concurrently with A) and merges as well.
      assert.deepEqual(scheduler.getDispatchSequence(), ["A", "C", "B"]);
      assert.equal(summary.taskStates.A, "merged");
      assert.equal(summary.taskStates.C, "merged");
      assert.equal(summary.taskStates.B, "merged");
      assert.equal(summary.merged, 3);
    } finally {
      fixture.cleanup();
    }
  });
});


describe("ParallelScheduler serialized Warden review (Task 20.4)", () => {
  it("serializes review (maxConcurrentWarden === 1) while other slots keep working", async () => {
    const fixture = createRepoFixture("warden");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
        makePactTask("C", { filesInScope: ["src/c.ts"], line: 3 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const reviewGate: { release?: () => void } = {};
      const reviewOrder: string[] = [];
      const wardenReview = async (
        candidate: ParallelSchedulerCandidate
      ): Promise<ParallelWardenDecision> => {
        reviewOrder.push(candidate.taskId);
        if (candidate.taskId === "A") {
          await new Promise<void>((resolve) => {
            reviewGate.release = resolve;
          });
        }
        harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
        return { approved: true, candidateSha256: candidate.candidateSha256 };
      };
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        wardenReview,
        mergeCandidate: harness.mergeCandidate,
      });
      assert.equal(scheduler.maxConcurrentWarden, 1);

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);
      assert.deepEqual(scheduler.getDispatchSequence().slice(0, 2), ["A", "B"]);
      assert.ok(controller.committed.has("A") === false);

      // A finishes and enters the review queue, where it is held. Waiting until
      // A's `wardenReview` has actually entered guarantees B waits behind A.
      controller.release("A");
      await waitFor(
        () => reviewGate.release !== undefined && reviewOrder.length === 1
      );
      assert.equal(scheduler.getStatus().activeReviews, 1);
      assert.ok(controller.committed.has("A"), "A committed its candidate");

      // The freed slot dispatches C while A is still being reviewed and B keeps
      // running in its own worktree (review never stalls active Soul-stitchers).
      await waitFor(() => scheduler.getDispatchSequence().includes("C"));
      assert.equal(scheduler.getStatus().activeSlots, 2);
      assert.ok(controller.pending().includes("B"));
      await waitFor(() => controller.pending().includes("C"));

      // B finishes and is queued behind A. Because the Warden is strictly
      // serialized, B must still be waiting while A is held.
      controller.release("B");
      await waitFor(() => scheduler.getStatus().pendingReviews >= 1);
      assert.equal(scheduler.getStatus().activeReviews, 1);
      assert.equal(reviewOrder.length, 1);
      assert.equal(reviewOrder[0], "A");

      // Release the held review, then let the rest drain.
      reviewGate.release?.();
      const summary = await drainRun(runPromise, controller);
      assert.equal(summary.maxObservedWardenConcurrency, 1);
      assert.equal(scheduler.getMaxObservedWardenConcurrency(), 1);
      assert.equal(reviewOrder.length, 3);
      assert.equal(reviewOrder[0], "A");
      assert.equal(summary.approved, 3);
      assert.equal(summary.merged, 3);
    } finally {
      fixture.cleanup();
    }
  });

  it("tracks rejection retries and re-queues the task", async () => {
    const fixture = createRepoFixture("retry");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      let reviews = 0;
      const retries: Array<[string, number, string]> = [];
      const wardenReview = async (
        candidate: ParallelSchedulerCandidate
      ): Promise<ParallelWardenDecision> => {
        reviews += 1;
        if (reviews === 1) {
          return { approved: false, reason: "changes requested" };
        }
        harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
        return { approved: true, candidateSha256: candidate.candidateSha256 };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          wardenReview,
          mergeCandidate: harness.mergeCandidate,
          onRetry: (taskId, attempt, reason) => {
            retries.push([taskId, attempt, reason]);
          },
        }
      );

      const summary = await drainRun(scheduler.run(), controller);
      assert.equal(reviews, 2);
      assert.equal(summary.retried, 1);
      assert.equal(summary.dispatched, 2);
      assert.equal(scheduler.getScheduler().getTask("A")!.attempts, 2);
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 2);
      assert.equal(records[0].approved, false);
      assert.equal(records[1].approved, true);
      assert.equal(retries.length, 1);
      assert.equal(retries[0][0], "A");
      assert.equal(retries[0][2], "changes requested");
      assert.equal(summary.taskStates.A, "merged");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("ParallelScheduler stop & abort (Task 20.4)", () => {
  it("stop() halts new dispatch while active slots and reviews drain", async () => {
    const fixture = createRepoFixture("stop");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
        makePactTask("C", { filesInScope: ["src/c.ts"], line: 3 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
      });

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);
      assert.deepEqual(scheduler.getDispatchSequence().slice(0, 2), ["A", "B"]);

      scheduler.stop("user stop");
      assert.equal(scheduler.isStopRequested, true);
      assert.equal(scheduler.getScheduler().isStopRequested, true);

      controller.release("A");
      controller.release("B");
      const summary = await runPromise;

      assert.equal(summary.stopRequested, true);
      assert.equal(summary.dispatched, 2);
      assert.equal(scheduler.getDispatchSequence().includes("C"), false);
      assert.equal(summary.taskStates.C, "ready");
    } finally {
      fixture.cleanup();
    }
  });

  it("abort() signals active slots, abandons them and tears down worktrees", async () => {
    const fixture = createRepoFixture("abort");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
        makePactTask("C", { filesInScope: ["src/c.ts"], line: 3 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
      });

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);
      const worktrees = ["A", "B"].map(
        (id) => controller.contexts.get(id)!.worktreeDir
      );
      for (const dir of worktrees) {
        assert.ok(fs.existsSync(dir));
      }

      scheduler.abort("user abort");
      assert.equal(scheduler.isAborted, true);
      const summary = await runPromise;

      assert.equal(summary.aborted, true);
      assert.equal(summary.taskStates.A, "abandoned");
      assert.equal(summary.taskStates.B, "abandoned");
      assert.equal(summary.taskStates.C, "ready");
      assert.equal(summary.candidatesProduced, 0);
      for (const dir of worktrees) {
        assert.equal(fs.existsSync(dir), false, `${dir} torn down`);
      }
    } finally {
      fixture.cleanup();
    }
  });
  it("abort() transitions queued in_review candidates out of in_review", async () => {
    const fixture = createRepoFixture("abortqueued");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const reviewGate: { release?: () => void } = {};
      const wardenReview = async (
        candidate: ParallelSchedulerCandidate
      ): Promise<ParallelWardenDecision> => {
        if (candidate.taskId === "A") {
          await new Promise<void>((resolve) => {
            reviewGate.release = resolve;
          });
        }
        return { approved: true, candidateSha256: candidate.candidateSha256 };
      };
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        maxConcurrentWarden: 1,
        wardenReview,
      });

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);
      // Enter A's review first so B deterministically waits in the serialized
      // review queue behind A.
      controller.release("A");
      await waitFor(() => reviewGate.release !== undefined);
      controller.release("B");

      // A's review is held, so B's candidate waits on the serialized queue while
      // its task sits in `in_review`.
      await waitFor(() =>
        scheduler.getReviewQueue().some((candidate) => candidate.taskId === "B")
      );
      assert.equal(scheduler.getScheduler().getTask("B")!.state, "in_review");

      scheduler.abort("user abort");

      // abort() must immediately end every queued in_review candidate.
      assert.notEqual(scheduler.getScheduler().getTask("B")!.state, "in_review");

      reviewGate.release?.();
      const summary = await drainRun(runPromise, controller, 5000);

      assert.notEqual(summary.taskStates.A, "in_review");
      assert.notEqual(summary.taskStates.B, "in_review");
    } finally {
      fixture.cleanup();
    }
  });


});


describe("ParallelScheduler pause & resume (Task 20.4)", () => {
  it("pause() keeps the loop alive so resume() finishes queued tasks after slots drain", async () => {
    const fixture = createRepoFixture("pause");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
        makePactTask("C", { filesInScope: ["src/c.ts"], line: 3 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
      });

      const runPromise = scheduler.run();
      await waitFor(() => controller.pending().length >= 2);
      assert.deepEqual(scheduler.getDispatchSequence().slice(0, 2), ["A", "B"]);

      scheduler.pause();
      assert.equal(scheduler.isPaused, true);

      // The two running slots drain while paused; the queued task must NOT be
      // dispatched and the loop must NOT exit.
      controller.release("A");
      controller.release("B");
      await waitFor(() => scheduler.getStatus().activeSlots === 0);
      assert.equal(scheduler.getStatus().activeSlots, 0);
      assert.equal(scheduler.getDispatchSequence().includes("C"), false);

      let settled = false;
      void runPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(
        settled,
        false,
        "run() must stay pending while paused with queued work"
      );

      // resume() wakes the loop, dispatches the queued task and finishes the run.
      scheduler.resume();
      await waitFor(() => controller.pending().includes("C"));
      controller.release("C");
      const summary = await runPromise;

      assert.equal(summary.dispatched, 3);
      assert.deepEqual(scheduler.getDispatchSequence(), ["A", "B", "C"]);
      assert.equal(summary.taskStates.C, "merged");
    } finally {
      fixture.cleanup();
    }
  });
});


describe("ParallelScheduler defers worktree cleanup until after Warden review (Task 20.4)", () => {
  it("keeps candidate.worktreeDir intact during wardenReview and cleans it up only afterwards", async () => {
    const fixture = createRepoFixture("wardenclean");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const observed: Array<{ taskId: string; dir: string; existed: boolean }> =
        [];
      const wardenReview = async (
        candidate: ParallelSchedulerCandidate
      ): Promise<ParallelWardenDecision> => {
        observed.push({
          taskId: candidate.taskId,
          dir: candidate.worktreeDir,
          existed: fs.existsSync(candidate.worktreeDir),
        });
        harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
        return { approved: true, candidateSha256: candidate.candidateSha256 };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        { parallelCap: 1, wardenReview, mergeCandidate: harness.mergeCandidate }
      );

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(observed.length, 1);
      assert.equal(
        observed[0].existed,
        true,
        "candidate.worktreeDir must exist inside wardenReview"
      );
      assert.equal(
        fs.existsSync(observed[0].dir),
        false,
        "worktree must be cleaned up only after wardenReview returns"
      );
      assert.equal(summary.approved, 1);
    } finally {
      fixture.cleanup();
    }
  });
});


describe("ParallelScheduler fail-closed Warden default (Task 20.4)", () => {
  it("omitting wardenReview fails closed with zero approvals", async () => {
    const fixture = createRepoFixture("failclosed");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        { parallelCap: 1 }
      );

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(summary.approved, 0, "no candidate may be approved");
      const records = scheduler.getReviewRecords();
      assert.ok(records.length > 0, "candidates were still reviewed");
      assert.ok(records.every((record) => record.approved === false));
      assert.ok(
        records.every((record) => record.reason === "warden_review_missing")
      );
      // Attempts exhaust and the task fails rather than merging.
      assert.equal(summary.taskStates.A, "failed");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("ParallelScheduler retry accounting (Task 20.4)", () => {
  it("exhausting maxAttempts does not over-count summary.retried or fire onRetry", async () => {
    const fixture = createRepoFixture("retrymax");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const retries: Array<[string, number, string]> = [];
      let reviews = 0;
      const wardenReview = async (): Promise<ParallelWardenDecision> => {
        reviews += 1;
        return { approved: false, reason: "changes requested" };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          maxAttempts: 2,
          wardenReview,
          onRetry: (taskId, attempt, reason) => {
            retries.push([taskId, attempt, reason]);
          },
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      // Attempt 1 -> rejected -> retried once. Attempt 2 -> rejected -> failed
      // (attempts exhausted) without incrementing the retry counter.
      assert.equal(reviews, 2);
      assert.equal(summary.dispatched, 2);
      assert.equal(summary.retried, 1);
      assert.equal(summary.taskStates.A, "failed");
      assert.equal(retries.length, 1);
      assert.equal(retries[0][0], "A");
    } finally {
      fixture.cleanup();
    }
  });
});


describe("ParallelScheduler verifies warden candidateSha256 (Task 20.4)", () => {
  it("rejects an approval whose candidateSha256 does not match the candidate", async () => {
    const fixture = createRepoFixture("shamismatch");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const scheduler = new ParallelScheduler({
        runId: fixture.runId,
        runsDir: fixture.runDir,
        gitDir: fixture.gitDir,
        integrationBranch: `graveyard/${fixture.runId}`,
        tasks: [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        approvedTaskIds: ["A"],
        parallelCap: 1,
        maxAttempts: 1,
        runner: controller.runner,
        wardenReview: async () => ({
          approved: true,
          reason: "looks good",
          candidateSha256: "f".repeat(64),
        }),
      });

      const summary = await drainRun(scheduler.run(), controller);
      assert.equal(summary.approved, 0);
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].approved, false);
      assert.equal(records[0].reason, "candidateSha256_mismatch");
    } finally {
      fixture.cleanup();
    }
  });

  it("accepts an approval whose candidateSha256 matches case-insensitively", async () => {
    const fixture = createRepoFixture("shamatch");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const scheduler = new ParallelScheduler({
        runId: fixture.runId,
        runsDir: fixture.runDir,
        gitDir: fixture.gitDir,
        integrationBranch: `graveyard/${fixture.runId}`,
        tasks: [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        approvedTaskIds: ["A"],
        parallelCap: 1,
        maxAttempts: 1,
        runner: controller.runner,
        // The approval carries the real candidate hash in a different case.
        wardenReview: async (candidate) => {
          harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
          return {
            approved: true,
            candidateSha256: (candidate.candidateSha256 ?? "").toUpperCase(),
          };
        },
        mergeCandidate: harness.mergeCandidate,
      });

      const summary = await drainRun(scheduler.run(), controller);
      assert.equal(summary.approved, 1);
      assert.equal(summary.merged, 1);
      assert.equal(summary.taskStates.A, "merged");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("ParallelScheduler fail-closed merge evidence (Task 20.4)", () => {
  it("fails closed (merge_evidence_missing) without advancing the integration branch when no evidence is supplied", async () => {
    const fixture = createRepoFixture("noevidence");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const integrationRef = `graveyard/${fixture.runId}`;
      const before = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          maxAttempts: 1,
          wardenReview: makeApprovingWarden(),
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(summary.approved, 0);
      assert.equal(summary.merged, 0);
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].approved, false);
      assert.equal(records[0].reason, "merge_evidence_missing");
      const after = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      assert.equal(
        after,
        before,
        "integration branch must not advance without verified merge evidence"
      );
      assert.equal(summary.taskStates.A, "failed");
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed (merge_evidence_candidate_mismatch) when evidence binds a different candidateSha", async () => {
    const fixture = createRepoFixture("mismatchsha");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const integrationRef = `graveyard/${fixture.runId}`;
      const before = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      const mergeCandidate: NonNullable<
        ParallelSchedulerOptions["mergeCandidate"]
      > = async (candidate) => {
        // A real verified merge advances the integration ref before the executor
        // returns. Returning mismatched evidence AFTER the ref moved must roll it
        // back so git refs and scheduler state never diverge.
        runGit(
          [
            "update-ref",
            `refs/heads/${integrationRef}`,
            candidate.candidateSha,
          ],
          fixture.gitDir,
          fixture.tmpDir
        );
        return {
          ok: true,
          evidence: {
            candidateSha: "0".repeat(40),
            candidateSha256: candidate.candidateSha256,
            verdict: {
              candidateSha: candidate.candidateSha,
              candidateSha256: candidate.candidateSha256,
            },
            gateResult: { ok: true, tree: "a".repeat(40) },
            diff: candidate.diff ?? "diff",
          } as unknown as TaskMergeEvidence,
        };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          maxAttempts: 1,
          wardenReview: makeApprovingWarden(),
          mergeCandidate,
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(summary.merged, 0);
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].approved, false);
      assert.equal(records[0].reason, "merge_evidence_candidate_mismatch");
      const after = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      assert.equal(
        after,
        before,
        "a moved integration ref must be rolled back to `before`"
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed (merge_evidence_candidate_mismatch) when evidence binds a different candidateSha256", async () => {
    const fixture = createRepoFixture("mismatchsha256");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const integrationRef = `graveyard/${fixture.runId}`;
      const before = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      const mergeCandidate: NonNullable<
        ParallelSchedulerOptions["mergeCandidate"]
      > = async (candidate) => ({
        ok: true,
        evidence: {
          candidateSha: candidate.candidateSha,
          candidateSha256: "f".repeat(64),
          verdict: {
            candidateSha: candidate.candidateSha,
            candidateSha256: "f".repeat(64),
          },
          gateResult: { ok: true, tree: "a".repeat(40) },
          diff: candidate.diff ?? "diff",
        } as unknown as TaskMergeEvidence,
      });
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          maxAttempts: 1,
          wardenReview: makeApprovingWarden(),
          mergeCandidate,
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(summary.merged, 0);
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].approved, false);
      assert.equal(records[0].reason, "merge_evidence_candidate_mismatch");
      const after = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      assert.equal(after, before, "mismatched evidence must not move git refs");
    } finally {
      fixture.cleanup();
    }
  });
});


describe("ParallelScheduler verified merge & unblocking (Task 20.4)", () => {
  it("unblocks a dependent task (T2 depends on T1) to ready -> running -> merged after T1 merges", async () => {
    const fixture = createRepoFixture("dependent");
    try {
      const tasks = [
        makePactTask("T1", { filesInScope: ["src/t1.ts"], line: 1 }),
        makePactTask("T2", {
          filesInScope: ["src/t2.ts"],
          line: 2,
          dependencies: ["T1"],
        }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const dispatchStates: string[] = [];
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
        onDispatch: (context) => {
          dispatchStates.push(
            scheduler.getScheduler().getTask(context.taskId)!.state
          );
        },
      });

      const summary = await drainRun(scheduler.run(), controller);

      // T1 merges first; only then is the dependent T2 ready and dispatched.
      assert.deepEqual(scheduler.getDispatchSequence(), ["T1", "T2"]);
      assert.deepEqual(dispatchStates, ["running", "running"]);
      assert.equal(summary.taskStates.T1, "merged");
      assert.equal(summary.taskStates.T2, "merged");
      assert.equal(summary.merged, 2);
    } finally {
      fixture.cleanup();
    }
  });

  it("merges parallel candidates tree-preservingly so both A.txt and B.txt survive", async () => {
    const fixture = createRepoFixture("treesafe");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
      });

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(summary.taskStates.A, "merged");
      assert.equal(summary.taskStates.B, "merged");
      assert.equal(summary.merged, 2);

      // The second merge must replay B onto the advanced integration head, so
      // the integration commit carries BOTH files instead of only B's tree.
      const integrationRef = `graveyard/${fixture.runId}`;
      const aContent = runGit(
        ["show", `${integrationRef}:A.txt`],
        fixture.gitDir,
        fixture.tmpDir
      );
      const bContent = runGit(
        ["show", `${integrationRef}:B.txt`],
        fixture.gitDir,
        fixture.tmpDir
      );
      assert.equal(aContent.trim(), "A candidate");
      assert.equal(bContent.trim(), "B candidate");
    } finally {
      fixture.cleanup();
    }
  });


  it("rejects a Warden approval that omits candidateSha256 (fail-closed)", async () => {
    const fixture = createRepoFixture("shamissing");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          maxAttempts: 1,
          wardenReview: async () => ({ approved: true }),
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(summary.approved, 0);
      assert.equal(summary.merged, 0);
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].approved, false);
      assert.equal(records[0].reason, "candidateSha256_missing");
      assert.equal(summary.taskStates.A, "failed");
    } finally {
      fixture.cleanup();
    }
  });

  it("abort during resolveHeadSha() never enqueues a candidate, hangs settle(), or leaks the worktree", async () => {
    const fixture = createRepoFixture("aborthead");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const worktreeDirs: string[] = [];
      const runner: ParallelSchedulerRunner = async (context) => {
        worktreeDirs.push(context.worktreeDir);
        return { ok: true };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        runner,
        { parallelCap: 1, maxAttempts: 1 }
      );

      // Park the worker inside the candidate-head resolveHeadSha() call until we
      // abort. The FIRST resolveHeadSha call captures the worktree base (the
      // pre-rebase diff anchor) and resolves immediately.
      let headCalls = 0;
      let releaseHead: ((sha: string) => void) | undefined;
      (scheduler as any).resolveHeadSha = () => {
        headCalls += 1;
        if (headCalls === 1) {
          return Promise.resolve("0".repeat(40));
        }
        return new Promise<string>((resolve) => {
          releaseHead = resolve;
        });
      };

      const runPromise = scheduler.run();
      await waitFor(() => releaseHead !== undefined);
      assert.equal(worktreeDirs.length, 1);
      assert.ok(fs.existsSync(worktreeDirs[0]));

      scheduler.abort("stop");
      releaseHead!("0".repeat(40));

      // A 5s deadline inside drainRun fails fast if settle() hangs.
      const summary = await drainRun(runPromise, controller, 5000);

      assert.equal(summary.aborted, true);
      assert.equal(summary.candidatesProduced, 0);
      assert.equal(scheduler.getReviewQueue().length, 0);
      assert.equal(summary.taskStates.A, "abandoned");
      assert.equal(
        fs.existsSync(worktreeDirs[0]),
        false,
        "aborted worktree must be torn down"
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("abort() while readCandidateDiff is pending never enqueues a candidate or hangs settle()", async () => {
    const fixture = createRepoFixture("abortdiff");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const worktreeDirs: string[] = [];
      const runner: ParallelSchedulerRunner = async (context) => {
        worktreeDirs.push(context.worktreeDir);
        return { ok: true };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        runner,
        { parallelCap: 1, maxAttempts: 1 }
      );

      // Park the worker inside readCandidateDiff() until we abort.
      let releaseDiff: ((diff: string | undefined) => void) | undefined;
      (scheduler as any).readCandidateDiff = () =>
        new Promise<string | undefined>((resolve) => {
          releaseDiff = resolve;
        });

      const runPromise = scheduler.run();
      await waitFor(() => releaseDiff !== undefined);
      assert.equal(worktreeDirs.length, 1);
      assert.ok(fs.existsSync(worktreeDirs[0]));

      scheduler.abort("stop");
      releaseDiff!(undefined);

      // A 5s deadline inside drainRun fails fast if settle() hangs.
      const summary = await drainRun(runPromise, controller, 5000);

      assert.equal(summary.aborted, true);
      assert.equal(summary.candidatesProduced, 0);
      assert.equal(scheduler.getReviewQueue().length, 0);
      assert.equal(summary.taskStates.A, "abandoned");
      assert.equal(
        fs.existsSync(worktreeDirs[0]),
        false,
        "aborted worktree must be torn down"
      );
    } finally {
      fixture.cleanup();
    }
  });


  it("throwing onReview / onCleanup callbacks never lose slots or block rejection retries", async () => {
    const fixture = createRepoFixture("throwsafe");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      let reviews = 0;
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 2,
          wardenReview: async (candidate) => {
            reviews += 1;
            if (reviews === 1) {
              return { approved: false, reason: "changes requested" };
            }
            harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
            return { approved: true, candidateSha256: candidate.candidateSha256 };
          },
          mergeCandidate: harness.mergeCandidate,
          onReview: () => {
            throw new Error("onReview boom");
          },
          onCleanup: () => {
            throw new Error("onCleanup boom");
          },
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      // The first rejection still retried despite the throwing onReview observer.
      assert.equal(reviews, 2);
      assert.equal(summary.retried, 1);
      assert.equal(summary.merged, 1);
      assert.equal(summary.taskStates.A, "merged");
      // No slot leaked: every slot is available again at the end of the run.
      assert.equal(scheduler.getStatus().activeSlots, 0);
      assert.equal(
        scheduler.getStatus().availableSlots,
        scheduler.getEffectiveCap()
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("ParallelScheduler merge reason propagation, large diffs & nested mismatch (Task 20.4)", () => {
  it("propagates a merge executor's refusal reason to reviewRecords and onRetry", async () => {
    const fixture = createRepoFixture("headchanged");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const retries: Array<[string, number, string]> = [];
      const mergeCandidate: NonNullable<
        ParallelSchedulerOptions["mergeCandidate"]
      > = async () => ({ ok: false, reason: "integration_head_changed" });
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          maxAttempts: 2,
          wardenReview: makeApprovingWarden(),
          mergeCandidate,
          onRetry: (taskId, attempt, reason) => {
            retries.push([taskId, attempt, reason]);
          },
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      const records = scheduler.getReviewRecords();
      assert.ok(records.length >= 1);
      assert.equal(records[0].approved, false);
      assert.equal(
        records[0].reason,
        "integration_head_changed",
        "the executor's refusal reason must not be dropped"
      );
      assert.equal(retries.length, 1);
      assert.equal(retries[0][0], "A");
      assert.equal(retries[0][2], "integration_head_changed");
      assert.equal(summary.merged, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("merges a candidate whose diff exceeds 1.2 MiB (20 MiB capture buffer)", async () => {
    const fixture = createRepoFixture("bigdiff");
    try {
      const harness = makeMergeHarness(fixture);
      const home = fixture.tmpDir;
      const bigContent = "x".repeat(1.5 * 1024 * 1024);
      const runner: ParallelSchedulerRunner = async (context) => {
        fs.writeFileSync(
          path.join(context.worktreeDir, "big.txt"),
          `${bigContent}\n`,
          "utf8"
        );
        runGit(["add", "-A"], context.worktreeDir, home);
        runGit(
          [
            "-c",
            "user.name=Test Runner",
            "-c",
            "user.email=runner@example.test",
            "commit",
            "-m",
            "big candidate",
          ],
          context.worktreeDir,
          home
        );
        const sha = runGit(["rev-parse", "HEAD"], context.worktreeDir, home);
        return { ok: true, candidateSha: sha };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        runner,
        {
          parallelCap: 1,
          wardenReview: harness.wardenReview,
          mergeCandidate: harness.mergeCandidate,
        }
      );

      const summary = await scheduler.run();

      assert.equal(summary.approved, 1);
      assert.equal(summary.merged, 1);
      assert.equal(summary.taskStates.A, "merged");
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 1);
      assert.equal((records[0].candidateSha256 ?? "").length, 64);
      // The final integration commit carries the big file in full.
      const integrationRef = `graveyard/${fixture.runId}`;
      const size = Number(
        runGit(
          ["cat-file", "-s", `${integrationRef}:big.txt`],
          fixture.gitDir,
          home
        )
      );
      assert.ok(size > 1.2 * 1024 * 1024, `big.txt size was ${size}`);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a nested verdict.candidateSha mismatch and rolls back a moved integration ref", async () => {
    const fixture = createRepoFixture("nestedmismatch");
    try {
      const controller = makeControlledRunner(fixture.tmpDir);
      const integrationRef = `graveyard/${fixture.runId}`;
      const before = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      const mergeCandidate: NonNullable<
        ParallelSchedulerOptions["mergeCandidate"]
      > = async (candidate) => {
        // Advance the integration ref as a real merge would, then return evidence
        // whose NESTED verdict names a different commit: the internal discrepancy
        // must be rejected and the moved ref rolled back.
        runGit(
          [
            "update-ref",
            `refs/heads/${integrationRef}`,
            candidate.candidateSha,
          ],
          fixture.gitDir,
          fixture.tmpDir
        );
        return {
          ok: true,
          evidence: {
            candidateSha: candidate.candidateSha,
            candidateSha256: candidate.candidateSha256,
            verdict: {
              candidateSha: "1".repeat(40),
              candidateSha256: candidate.candidateSha256,
            },
            gateResult: { ok: true, tree: "a".repeat(40) },
            diff: candidate.diff ?? "diff",
          } as unknown as TaskMergeEvidence,
        };
      };
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        controller.runner,
        {
          parallelCap: 1,
          maxAttempts: 1,
          wardenReview: makeApprovingWarden(),
          mergeCandidate,
        }
      );

      const summary = await drainRun(scheduler.run(), controller);

      assert.equal(summary.merged, 0);
      const records = scheduler.getReviewRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0].approved, false);
      assert.equal(records[0].reason, "merge_evidence_candidate_mismatch");
      const after = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      assert.equal(
        after,
        before,
        "a moved integration ref must be rolled back to `before`"
      );
    } finally {
      fixture.cleanup();
    }
  });
});


describe("ParallelScheduler merge lock, drift & rebase hardening (Task 20.4)", () => {
  it("serializes concurrent merges so a drifting task re-queues for re-review without wiping a sibling's merge", async () => {
    const fixture = createRepoFixture("drift");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);
      const integrationRef = `graveyard/${fixture.runId}`;

      // Force A to merge before B's verified merge runs, while guaranteeing B's
      // rebase check already happened: A only approves once B has reached the
      // Warden, and B only approves once A has merged. With the reviews running
      // concurrently (maxConcurrentWarden: 2) this is exactly the interleaving
      // that used to let B's rollback clobber A's freshly merged ref.
      let bReachedWarden!: () => void;
      const bAtWarden = new Promise<void>((resolve) => {
        bReachedWarden = resolve;
      });
      let aMerged!: () => void;
      const aMergedPromise = new Promise<void>((resolve) => {
        aMerged = resolve;
      });

      const mergeCandidate: NonNullable<
        ParallelSchedulerOptions["mergeCandidate"]
      > = async (candidate, decision) => {
        const result = await harness.mergeCandidate(candidate, decision);
        if (candidate.taskId === "A") {
          aMerged();
        }
        return result;
      };

      const wardenReview: ParallelSchedulerWardenReview = async (candidate) => {
        if (candidate.taskId === "A") {
          await bAtWarden;
        } else {
          bReachedWarden();
          await aMergedPromise;
        }
        harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
        return { approved: true, candidateSha256: candidate.candidateSha256 };
      };

      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        maxConcurrentWarden: 2,
        maxAttempts: 1,
        wardenReview,
        mergeCandidate,
      });

      const summary = await drainRun(scheduler.run(), controller);

      // A merged cleanly. B drifted against A's freshly merged head, but instead
      // of being refused fail-closed (which would burn B's single attempt) it was
      // re-queued for a rebase + re-review against the new head, then merged.
      assert.equal(summary.taskStates.A, "merged");
      assert.equal(summary.taskStates.B, "merged");
      assert.equal(summary.merged, 2);
      const records = scheduler.getReviewRecords();
      const bRecord = records.find((record) => record.taskId === "B");
      assert.ok(bRecord, "B must have produced a review record");
      assert.equal(bRecord!.approved, true);
      // The base-drift re-queue is NOT a rejected attempt: B never burned its
      // single attempt, the builder never re-ran, and no retry was counted.
      assert.equal(scheduler.getScheduler().getTask("B")!.attempts, 1);
      assert.equal(summary.retried, 0);
      // Exactly one review record per task: the requeue did not record a decision.
      assert.equal(
        records.filter((record) => record.taskId === "B").length,
        1
      );

      // A's commit and its files are fully intact: the integration ref still
      // descends from A's candidate commit and A's file was never wiped out by a
      // rollback.
      const head = runGit(
        ["rev-parse", integrationRef],
        fixture.gitDir,
        fixture.tmpDir
      );
      assert.doesNotThrow(() =>
        runGit(
          [
            "merge-base",
            "--is-ancestor",
            controller.committed.get("A")!,
            head,
          ],
          fixture.gitDir,
          fixture.tmpDir
        )
      );
      assert.equal(
        runGit(
          ["show", `${integrationRef}:A.txt`],
          fixture.gitDir,
          fixture.tmpDir
        ).trim(),
        "A candidate"
      );
    } finally {
      fixture.cleanup();
    }
  });


  it("rejects the second of two concurrent same-file edits with rebase_conflict", async () => {
    const fixture = createRepoFixture("samefile");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const harness = makeMergeHarness(fixture);
      const home = fixture.tmpDir;
      const integrationRef = `graveyard/${fixture.runId}`;
      const worktrees = new Map<string, string>();
      let aQueuedResolve: (() => void) | undefined;
      const aQueued = new Promise<void>((resolve) => {
        aQueuedResolve = resolve;
      });
      // A must not merge until B's worktree base commit has been fixed by
      // `createTaskWorktree`, otherwise B could be cut from the already-merged
      // head and its rebase would no longer conflict.
      let bDispatchedResolve: (() => void) | undefined;
      const bDispatched = new Promise<void>((resolve) => {
        bDispatchedResolve = resolve;
      });

      const runner: ParallelSchedulerRunner = async (context) => {
        worktrees.set(context.taskId, context.worktreeDir);
        // Hold B until A's candidate is queued so A is reviewed (and merged)
        // first; B is then rebased onto A and conflicts on the shared file.
        // Hold A until B has been dispatched (its base commit fixed) so A can
        // never merge before B's worktree exists.
        if (context.taskId === "B") {
          await aQueued;
        } else {
          await bDispatched;
        }
        const srcDir = path.join(context.worktreeDir, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(
          path.join(srcDir, "shared.ts"),
          context.taskId === "A"
            ? "export const who = 'A';\n"
            : "export const who = 'B';\n",
          "utf8"
        );
        runGit(["add", "-A"], context.worktreeDir, home);
        runGit(
          [
            "-c",
            "user.name=Test Runner",
            "-c",
            "user.email=runner@example.test",
            "commit",
            "-m",
            `work ${context.taskId}`,
          ],
          context.worktreeDir,
          home
        );
        const sha = runGit(["rev-parse", "HEAD"], context.worktreeDir, home);
        return { ok: true, candidateSha: sha };
      };

      const scheduler = makeScheduler(fixture, tasks, runner, {
        parallelCap: 2,
        maxAttempts: 1,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
        onDispatch: (context) => {
          if (context.taskId === "B") {
            bDispatchedResolve?.();
          }
        },
        onCandidate: (candidate) => {
          if (candidate.taskId === "A") {
            aQueuedResolve?.();
          }
        },
      });

      const summary = await scheduler.run();

      assert.equal(summary.taskStates.A, "merged");
      assert.equal(summary.merged, 1);
      const records = scheduler.getReviewRecords();
      const bRecord = records.find((record) => record.taskId === "B");
      assert.ok(bRecord, "B must have produced a review record");
      assert.equal(bRecord!.approved, false);
      assert.equal(bRecord!.reason, "rebase_conflict");
      assert.equal(summary.taskStates.B, "failed");
      // The conflicted worktree was torn down deterministically.
      assert.equal(fs.existsSync(worktrees.get("B")!), false);
      // A's shared-file edit is the one that survived on the integration branch.
      assert.match(
        runGit(
          ["show", `${integrationRef}:src/shared.ts`],
          fixture.gitDir,
          home
        ),
        /'A'/
      );
    } finally {
      fixture.cleanup();
    }
  });


  it("rejects an empty rebased diff fail-closed instead of reusing a stale hash", async () => {
    const fixture = createRepoFixture("emptydiff");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const harness = makeMergeHarness(fixture);
      const home = fixture.tmpDir;
      const worktrees = new Map<string, string>();
      let aQueuedResolve: (() => void) | undefined;
      const aQueued = new Promise<void>((resolve) => {
        aQueuedResolve = resolve;
      });
      // A must not merge until B's worktree base commit has been fixed by
      // `createTaskWorktree`, otherwise B could be cut from the already-merged
      // head and produce no rebase conflict at all.
      let bDispatchedResolve: (() => void) | undefined;
      const bDispatched = new Promise<void>((resolve) => {
        bDispatchedResolve = resolve;
      });

      const runner: ParallelSchedulerRunner = async (context) => {
        worktrees.set(context.taskId, context.worktreeDir);
        if (context.taskId === "B") {
          await aQueued;
        } else {
          await bDispatched;
        }
        const srcDir = path.join(context.worktreeDir, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        // A and B make the EXACT same edit.
        fs.writeFileSync(
          path.join(srcDir, "shared.ts"),
          "export const who = 'same';\n",
          "utf8"
        );
        runGit(["add", "-A"], context.worktreeDir, home);
        runGit(
          [
            "-c",
            "user.name=Test Runner",
            "-c",
            "user.email=runner@example.test",
            "commit",
            "-m",
            `work ${context.taskId}`,
          ],
          context.worktreeDir,
          home
        );
        const sha = runGit(["rev-parse", "HEAD"], context.worktreeDir, home);
        return { ok: true, candidateSha: sha };
      };

      const scheduler = makeScheduler(fixture, tasks, runner, {
        parallelCap: 2,
        maxAttempts: 1,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
        onDispatch: (context) => {
          if (context.taskId === "B") {
            bDispatchedResolve?.();
          }
        },
        onCandidate: (candidate) => {
          if (candidate.taskId === "A") {
            aQueuedResolve?.();
          }
        },
      });

      const summary = await scheduler.run();

      assert.equal(summary.merged, 1);
      const records = scheduler.getReviewRecords();
      const bRecord = records.find((record) => record.taskId === "B");
      assert.ok(bRecord, "B must have produced a review record");
      assert.equal(bRecord!.approved, false);
      assert.equal(bRecord!.reason, "empty_rebased_diff");
      assert.equal(summary.taskStates.B, "failed");
      // The empty-diff worktree was torn down deterministically.
      assert.equal(fs.existsSync(worktrees.get("B")!), false);
    } finally {
      fixture.cleanup();
    }
  });


  it("measures a worker candidate against its worktree base, not a bloated integration head", async () => {
    const fixture = createRepoFixture("basesha");
    try {
      const home = fixture.tmpDir;
      const integrationRef = `graveyard/${fixture.runId}`;
      let bigHead = "";
      const runner: ParallelSchedulerRunner = async (context) => {
        // A tiny candidate on top of the worktree base.
        fs.writeFileSync(
          path.join(context.worktreeDir, "tiny.txt"),
          "tiny\n",
          "utf8"
        );
        runGit(["add", "-A"], context.worktreeDir, home);
        runGit(
          [
            "-c",
            "user.name=Test Runner",
            "-c",
            "user.email=runner@example.test",
            "commit",
            "-m",
            "tiny",
          ],
          context.worktreeDir,
          home
        );
        const sha = runGit(["rev-parse", "HEAD"], context.worktreeDir, home);
        // A large UNRELATED merge lands on the integration branch AFTER this
        // worktree was cut from its base. A pre-rebase diff against the live
        // integration head would now be a >20 MiB deletion and overflow the
        // capture buffer; against the captured base it stays tiny.
        bigHead = commitBigFileToIntegration(fixture, "big.txt", 24 * 1024 * 1024);
        return { ok: true, candidateSha: sha };
      };

      const harness = makeMergeHarness(fixture);
      const scheduler = makeScheduler(
        fixture,
        [makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 })],
        runner,
        {
          parallelCap: 1,
          maxAttempts: 1,
          wardenReview: harness.wardenReview,
          mergeCandidate: harness.mergeCandidate,
        }
      );

      // Record every diff base the scheduler uses.
      const diffBases: Array<string | undefined> = [];
      const original = (scheduler as any).readCandidateDiff.bind(scheduler);
      (scheduler as any).readCandidateDiff = (
        dir: string,
        sha: string,
        base?: string
      ) => {
        diffBases.push(base);
        return original(dir, sha, base);
      };

      const summary = await scheduler.run();

      assert.equal(summary.merged, 1);
      assert.equal(summary.taskStates.A, "merged");
      // The tiny candidate never overflowed the capture buffer.
      assert.equal(
        scheduler
          .getReviewRecords()
          .some((record) => record.reason === "candidate_diff_too_large"),
        false
      );
      // The worker's pre-rebase diff was anchored at the captured worktree base
      // — never at the bloated integration head (which would have overflowed the
      // capture buffer with a >24 MiB spurious deletion).
      assert.ok(
        diffBases.includes(fixture.baseSha),
        "worker diff must be measured against the worktree base"
      );
      // The post-rebase diff is anchored at the EXACT integration head captured
      // once inside `reviewLoop` (not re-read from the live ref), and no other
      // diff base is used.
      assert.deepEqual(
        diffBases.filter((base): base is string => base !== undefined),
        [fixture.baseSha, bigHead],
        "pre-rebase uses the captured base; post-rebase uses the exact integration head"
      );
      // The bloated integration head and the tiny candidate both survived.
      const bigSize = Number(
        runGit(
          ["cat-file", "-s", `${integrationRef}:big.txt`],
          fixture.gitDir,
          home
        )
      );
      assert.ok(bigSize > 20 * 1024 * 1024, `big.txt size was ${bigSize}`);
      assert.equal(
        runGit(
          ["show", `${integrationRef}:tiny.txt`],
          fixture.gitDir,
          home
        ).trim(),
        "tiny"
      );
    } finally {
      fixture.cleanup();
    }
  });
  it("rebases onto the resolved integration head even when the ref advances mid-review", async () => {
    const fixture = createRepoFixture("icashe");
    try {
      const home = fixture.tmpDir;
      const integrationBranch = `graveyard/${fixture.runId}`;
      const integrationRef = `refs/heads/${integrationBranch}`;
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const harness = makeMergeHarness(fixture);

      // A must not produce its candidate until B's worktree base commit has been
      // fixed, so B is cut from `fixture.baseSha` and rooted there.
      let bDispatchedResolve: (() => void) | undefined;
      const bDispatched = new Promise<void>((resolve) => {
        bDispatchedResolve = resolve;
      });
      // B must not produce its candidate until A's candidate has been queued (and
      // therefore reviewed and merged first), so B's review observes A's merged
      // head as the integration head.
      let aQueuedResolve: (() => void) | undefined;
      const aQueued = new Promise<void>((resolve) => {
        aQueuedResolve = resolve;
      });
      let aSha = "";
      const runner: ParallelSchedulerRunner = async (context) => {
        if (context.taskId === "A") {
          await bDispatched;
          aSha = commitWorktree(context.worktreeDir, context.taskId, home);
          return { ok: true, candidateSha: aSha };
        }
        await aQueued;
        const sha = commitWorktree(context.worktreeDir, context.taskId, home);
        return { ok: true, candidateSha: sha };
      };

      // Capture the exact candidate snapshot handed to the Warden on B's FIRST
      // review: the reviewed candidate rebased onto the integration head resolved
      // BEFORE the concurrent ref advance. Re-queued reviews are not recorded, so
      // this is the only aSha-bound review snapshot.
      const bRecord: { candidateSha: string; candidateSha256?: string } = {
        candidateSha: "",
      };
      const wardenReview: ParallelSchedulerWardenReview = async (candidate) => {
        if (candidate.taskId === "B" && bRecord.candidateSha === "") {
          bRecord.candidateSha = candidate.candidateSha;
          bRecord.candidateSha256 = candidate.candidateSha256;
        }
        harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
        return {
          approved: true,
          candidateSha256: candidate.candidateSha256,
        };
      };

      const scheduler = makeScheduler(fixture, tasks, runner, {
        parallelCap: 2,
        maxConcurrentWarden: 1,
        maxAttempts: 1,
        wardenReview,
        mergeCandidate: harness.mergeCandidate,
        onDispatch: (context) => {
          if (context.taskId === "B") {
            bDispatchedResolve?.();
          }
        },
        onCandidate: (candidate) => {
          if (candidate.taskId === "A") {
            aQueuedResolve?.();
          }
        },
      });

      // Intercept the git boundary so that, immediately AFTER B's integration head
      // resolves to A's merged sha (`aSha`) and BEFORE the rebase runs, a
      // concurrent merge advances `refs/heads/<integrationBranch>` to a newer
      // commit (`cSha`). `reviewLoop` must still rebase onto the captured `aSha`.
      let advanced = false;
      let cSha = "";
      const rebaseTargets: string[] = [];
      const originalResolveGitRef = (scheduler as any).resolveGitRef.bind(
        scheduler
      );
      (scheduler as any).resolveGitRef = async (
        cwd: string,
        ref: string
      ): Promise<string | undefined> => {
        const resolved = await originalResolveGitRef(cwd, ref);
        if (!advanced && ref === integrationRef && resolved === aSha) {
          advanced = true;
          // A sibling merge lands on the integration branch right after the head
          // was resolved, diverging from `aSha`.
          cSha = commitBigFileToIntegration(fixture, "concurrent.txt", 64);
        }
        return resolved;
      };
      const originalGitCapture = (scheduler as any).gitCapture.bind(scheduler);
      (scheduler as any).gitCapture = (
        cwd: string,
        args: readonly string[]
      ): Promise<string> => {
        if (args.includes("rebase") && args[args.length - 1] !== "--abort") {
          rebaseTargets.push(args[args.length - 1]);
        }
        return originalGitCapture(cwd, args);
      };

      const summary = await scheduler.run();

      // Guard the regression scenario: the concurrent advance actually fired.
      assert.equal(advanced, true, "the concurrent ref advance must have fired");
      assert.notEqual(cSha, "");
      assert.notEqual(cSha, aSha);

      // 1. `rebase` targeted the captured `aSha`, never the mutable ref name, so
      // the rebased candidate's parent is `aSha` (not `cSha`).
      assert.equal(
        rebaseTargets[0],
        aSha,
        "rebase must target the captured integration head"
      );
      assert.equal(
        rebaseTargets.includes(integrationRef),
        false,
        "rebase must never target the mutable integration ref"
      );
      assert.ok(bRecord.candidateSha, "B must have reached the Warden");
      assert.equal(
        runGit(["rev-parse", `${bRecord.candidateSha}^`], fixture.gitDir, home),
        aSha,
        "B's rebased parent must be the captured aSha, not cSha"
      );

      const runDiff = (base: string, head: string): string =>
        childProcess
          .execFileSync(
            "git",
            [
              "diff",
              "--binary",
              "--no-color",
              "--end-of-options",
              `${base}..${head}`,
            ],
            {
              cwd: fixture.gitDir,
              encoding: "utf8",
              env: gitEnv(home),
              maxBuffer: 20 * 1024 * 1024,
            }
          )
          .toString();

      // 2. The reviewed hash binds to `aSha..candidateSha` and excludes cSha's
      // concurrent change.
      assert.equal(
        bRecord.candidateSha256,
        candidateSha256FromDiff(runDiff(aSha, bRecord.candidateSha))
      );
      assert.equal(
        runDiff(aSha, bRecord.candidateSha).includes("concurrent.txt"),
        false,
        "the reviewed diff must not include the concurrent cSha change"
      );

      // 3. The ref moved before the final merge lock, so B detected the
      // post-approval drift and re-queued; it resolved against the moved head
      // without corrupting the `aSha`-bound evidence or burning an attempt.
      assert.equal(summary.taskStates.A, "merged");
      assert.equal(summary.taskStates.B, "merged");
      assert.equal(summary.merged, 2);
      assert.equal(scheduler.getScheduler().getTask("B")!.attempts, 1);
      assert.equal(summary.retried, 0);
      const bRecords = scheduler
        .getReviewRecords()
        .filter((record) => record.taskId === "B");
      assert.equal(bRecords.length, 1);
      assert.equal(bRecords[0].approved, true);
      assert.equal(
        runGit(["show", `${integrationBranch}:B.txt`], fixture.gitDir, home),
        "B candidate"
      );
    } finally {
      fixture.cleanup();
    }
  });

});


describe("ParallelScheduler pending emission & base-drift requeue (Task 20.4)", () => {
  it("never dispatches a dependent while a verified merge emission is pending or rolled back", async () => {
    const fixture = createRepoFixture("pendingemission");
    try {
      const home = fixture.tmpDir;
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("C", {
          filesInScope: ["src/c.ts"],
          line: 2,
          dependencies: ["A"],
        }),
      ];
      const harness = makeMergeHarness(fixture);
      const dispatched: string[] = [];
      const runner: ParallelSchedulerRunner = async (context) => {
        dispatched.push(context.taskId);
        const sha = commitWorktree(context.worktreeDir, context.taskId, home);
        return { ok: true, candidateSha: sha };
      };

      // Hold A's `merged` state emission open, then reject it to force the
      // composed Scheduler to compensate (roll back) A's merge and its eager
      // release of the dependent C.
      let mergedEmitStarted = false;
      let rejectMergedEmit: ((err: unknown) => void) | undefined;
      const mergedEmitGate = new Promise<void>((_resolve, reject) => {
        rejectMergedEmit = reject;
      });
      const emit = (envelope: any): void | Promise<void> => {
        if (
          envelope?.kind === "task.state" &&
          envelope?.taskId === "A" &&
          envelope?.data?.state === "merged"
        ) {
          mergedEmitStarted = true;
          return mergedEmitGate;
        }
        return undefined;
      };

      const scheduler = makeScheduler(fixture, tasks, runner, {
        parallelCap: 1,
        maxAttempts: 1,
        emit,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
      });

      const runPromise = scheduler.run();
      await waitFor(() => mergedEmitStarted);

      // The composed Scheduler applied the merged state and eagerly marked C
      // `ready`, but A's merge emission is still in flight.
      assert.equal(scheduler.getScheduler().getTask("A")!.state, "merged");
      assert.equal(scheduler.getScheduler().getTask("C")!.state, "ready");
      assert.equal(scheduler.getStatus().activeSlots, 0);
      assert.equal(
        scheduler.selectReadyTasks(10).some((task) => task.id === "C"),
        false,
        "a dependent of a pending merge must not be selected"
      );
      // Simulate the run loop waking mid-emission: C must still never launch.
      (scheduler as any).dispatchReady();
      assert.equal(dispatched.includes("C"), false);
      assert.equal(scheduler.getDispatchSequence().includes("C"), false);

      // Reject the emission: the merge rolls back and C returns to a non-running
      // state instead of being launched against rolled-back state.
      rejectMergedEmit!(new Error("merge emission rejected"));

      const summary = await runPromise;

      assert.deepEqual(dispatched, ["A"]);
      assert.equal(scheduler.getDispatchSequence().includes("C"), false);
      assert.equal(summary.taskStates.A, "failed");
      assert.notEqual(summary.taskStates.C, "running");
      assert.notEqual(summary.taskStates.C, "merged");
      assert.equal(summary.merged, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("re-queues a post-approval base drift for re-review without burning the single attempt", async () => {
    const fixture = createRepoFixture("driftrequeue");
    try {
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const controller = makeControlledRunner(fixture.tmpDir);
      const harness = makeMergeHarness(fixture);

      // Force the interleaving that produces post-approval drift: B reaches the
      // Warden, THEN A merges, and only then is B approved against the stale head
      // it was rebased onto.
      let bReachedWarden!: () => void;
      const bAtWarden = new Promise<void>((resolve) => {
        bReachedWarden = resolve;
      });
      let aMerged!: () => void;
      const aMergedPromise = new Promise<void>((resolve) => {
        aMerged = resolve;
      });
      const wardenCalls = new Map<string, number>();
      const wardenReview: ParallelSchedulerWardenReview = async (candidate) => {
        wardenCalls.set(
          candidate.taskId,
          (wardenCalls.get(candidate.taskId) ?? 0) + 1
        );
        if (candidate.taskId === "A") {
          await bAtWarden;
        } else {
          bReachedWarden();
          await aMergedPromise;
        }
        harness.reviewedShas.set(candidate.taskId, candidate.candidateSha);
        return { approved: true, candidateSha256: candidate.candidateSha256 };
      };
      const mergeCandidate: NonNullable<
        ParallelSchedulerOptions["mergeCandidate"]
      > = async (candidate, decision) => {
        const result = await harness.mergeCandidate(candidate, decision);
        if (candidate.taskId === "A") {
          aMerged();
        }
        return result;
      };

      const scheduler = makeScheduler(fixture, tasks, controller.runner, {
        parallelCap: 2,
        maxConcurrentWarden: 2,
        maxAttempts: 1,
        wardenReview,
        mergeCandidate,
      });

      const summary = await drainRun(scheduler.run(), controller);

      // B hit post-approval drift, was re-queued and re-reviewed (Warden called
      // twice), yet never burned its single attempt and produced no rejection.
      assert.equal(summary.taskStates.A, "merged");
      assert.equal(summary.taskStates.B, "merged");
      assert.equal(summary.merged, 2);
      assert.equal(wardenCalls.get("B"), 2);
      assert.equal(scheduler.getScheduler().getTask("B")!.attempts, 1);
      assert.equal(summary.retried, 0);
      const bRecords = scheduler
        .getReviewRecords()
        .filter((record) => record.taskId === "B");
      assert.equal(bRecords.length, 1);
      assert.equal(bRecords[0].approved, true);
    } finally {
      fixture.cleanup();
    }
  });


  it("hashes a fast-forwarded candidate against the exact integration head so evidence matches", async () => {
    const fixture = createRepoFixture("ffhash");
    try {
      const home = fixture.tmpDir;
      const integrationRef = `graveyard/${fixture.runId}`;
      const tasks = [
        makePactTask("A", { filesInScope: ["src/a.ts"], line: 1 }),
        makePactTask("B", { filesInScope: ["src/b.ts"], line: 2 }),
      ];
      const harness = makeMergeHarness(fixture);

      let bDispatchedResolve: (() => void) | undefined;
      const bDispatched = new Promise<void>((resolve) => {
        bDispatchedResolve = resolve;
      });
      let aSha = "";
      const runner: ParallelSchedulerRunner = async (context) => {
        if (context.taskId === "A") {
          // Do not let A merge before B's worktree base commit is fixed.
          await bDispatched;
          aSha = commitWorktree(context.worktreeDir, context.taskId, home);
          return { ok: true, candidateSha: aSha };
        }
        // B: wait for A to merge, then FAST-FORWARD the worktree branch to the
        // NEWER integration head before committing. The runner never rewound to
        // its own base, so `candidate.baseSha` (captured at worktree creation)
        // stays the OLD head while B's candidate descends from the new one.
        const deadline = Date.now() + 10000;
        let head = fixture.baseSha;
        while (head === fixture.baseSha) {
          if (Date.now() > deadline) {
            throw new Error("A never merged");
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          head = runGit(["rev-parse", integrationRef], fixture.gitDir, home);
        }
        runGit(
          [
            "-c",
            "user.name=Test Runner",
            "-c",
            "user.email=runner@example.test",
            "reset",
            "--hard",
            head,
          ],
          context.worktreeDir,
          home
        );
        const sha = commitWorktree(context.worktreeDir, context.taskId, home);
        return { ok: true, candidateSha: sha };
      };

      const scheduler = makeScheduler(fixture, tasks, runner, {
        parallelCap: 2,
        maxAttempts: 1,
        wardenReview: harness.wardenReview,
        mergeCandidate: harness.mergeCandidate,
        onDispatch: (context) => {
          if (context.taskId === "B") {
            bDispatchedResolve?.();
          }
        },
      });

      const summary = await scheduler.run();

      assert.equal(summary.taskStates.A, "merged");
      assert.equal(summary.taskStates.B, "merged");
      assert.equal(summary.merged, 2);

      const bRecord = scheduler
        .getReviewRecords()
        .find((record) => record.taskId === "B");
      assert.ok(bRecord, "B must have produced a review record");
      assert.equal(bRecord!.approved, true);
      const bCandidateSha = bRecord!.candidateSha;

      const runDiff = (base: string, head: string): string =>
        childProcess
          .execFileSync(
            "git",
            [
              "diff",
              "--binary",
              "--no-color",
              "--end-of-options",
              `${base}..${head}`,
            ],
            {
              cwd: fixture.gitDir,
              encoding: "utf8",
              env: gitEnv(home),
              maxBuffer: 20 * 1024 * 1024,
            }
          )
          .toString();

      // The reviewed hash binds to `integrationHead..candidateSha` (the head A
      // merged), NOT the stale base the runner fast-forwarded past. If B had not
      // been re-hashed the Warden evidence would have mismatched and the merge
      // would have failed closed.
      assert.equal(
        bRecord!.candidateSha256,
        candidateSha256FromDiff(runDiff(aSha, bCandidateSha))
      );
      assert.notEqual(
        bRecord!.candidateSha256,
        candidateSha256FromDiff(runDiff(fixture.baseSha, bCandidateSha))
      );
    } finally {
      fixture.cleanup();
    }
  });

});

