// Work package RB2 tests:
// N-B11:
// - no arbitrary nested skip dirs (nested src/dist, .next, sub/node_modules are scanned)
// - fail-closed scan reads (unreadable file/dir fails closed before and after exec)
// - validated scan limits (positive finite integer limits, ConfigurationError on invalid)
// N-B17:
// - sanitize ESCAPING_SYMLINK host realpath (neither findings nor events expose host realpath)
// - scanClonedRepository throws on unreadable directory and excessive depth

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectWorktreeFiles,
  scanWorktreeFilesBounded,
  handleSandboxExec,
  validateScanLimits,
  ConfigurationError,
  ScanLimitExceededError,
  sanitizeEscapingSymlinkFindings,
  toWorktreeRelativePath,
  type ExecutionToolsOptions,
} from "../../lib/gateway/execution-tools";
import {
  scanClonedRepository,
  neutralizeUntrustedContent,
  findFilesRecursively,
} from "../../lib/security/untrusted-content";
import { LogStore } from "../../lib/events/log-store";
import { EventStore } from "../../lib/events/event-store";
import type {
  ToolExecutionContext,
  SandboxExecRefusedResult,
  SandboxExecFatalResult,
} from "../../lib/gateway/types";

test("RB2 N-B11: nested src/dist, .next, and sub/node_modules secrets are detected", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-nested-secrets-"));
  try {
    // 1. Nested src/dist secret
    fs.mkdirSync(path.join(worktreeDir, "src", "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, "src", "dist", "bundle.js"),
      'const token = "ghp_NestedDistSecret1234567890123456";\n'
    );

    // 2. Nested .next secret
    fs.mkdirSync(path.join(worktreeDir, ".next", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, ".next", "server", "secret.js"),
      'const token = "ghp_NextSecret1234567890123456";\n'
    );

    // 3. Nested sub/node_modules secret
    fs.mkdirSync(path.join(worktreeDir, "sub", "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, "sub", "node_modules", "pkg", "auth.js"),
      'const token = "ghp_NestedNmSecret1234567890123456";\n'
    );

    // 4. Normal files
    fs.writeFileSync(path.join(worktreeDir, "README.md"), "# Project\n");

    // collectWorktreeFiles must collect these nested files
    const collected = collectWorktreeFiles(worktreeDir);
    const collectedPaths = collected.map((f) => f.path);
    assert.ok(collectedPaths.includes("src/dist/bundle.js"));
    assert.ok(collectedPaths.includes(".next/server/secret.js"));
    assert.ok(collectedPaths.includes("sub/node_modules/pkg/auth.js"));
    assert.ok(collectedPaths.includes("README.md"));

    // scanWorktreeFilesBounded must flag them as containing secrets
    const scan = scanWorktreeFilesBounded(worktreeDir);
    assert.equal(scan.passed, false);
    assert.equal(scan.hasSecrets, true);
    assert.ok(scan.flaggedFiles.includes("src/dist/bundle.js"));
    assert.ok(scan.flaggedFiles.includes(".next/server/secret.js"));
    assert.ok(scan.flaggedFiles.includes("sub/node_modules/pkg/auth.js"));

    // handleSandboxExec must refuse before execution
    let runnerRan = false;
    const context: ToolExecutionContext = {
      skeletonId: "skel-rb2-nested",
      role: "Soul-stitcher",
      bearerToken: "token-rb2-1",
      worktreeRoot: worktreeDir,
      runId: "run-rb2-nested",
    };
    const res = (await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          runnerRan = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "SECRET_DETECTED");
    assert.equal(runnerRan, false, "runner must not execute when nested secrets are present");
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("RB2 N-B11: unreadable worktree directory fails closed", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-unreadable-dir-"));
  const lockedDir = path.join(worktreeDir, "locked_dir");
  try {
    fs.mkdirSync(lockedDir, { recursive: true });
    fs.writeFileSync(path.join(lockedDir, "file.txt"), "content");
    fs.chmodSync(lockedDir, 0o000);

    // 1. collectWorktreeFiles throws (does not swallow readdir error)
    assert.throws(
      () => collectWorktreeFiles(worktreeDir),
      (err: unknown) => err instanceof Error && /Failed to read worktree directory/.test((err as Error).message)
    );

    // 2. scanWorktreeFilesBounded throws (does not swallow readdir error)
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir),
      (err: unknown) => err instanceof Error && /Failed to read worktree directory/.test((err as Error).message)
    );

    // 3. handleSandboxExec pre-exec fails closed with status refused
    let runnerRan = false;
    const context: ToolExecutionContext = {
      skeletonId: "skel-rb2-unreadable-dir",
      role: "Soul-stitcher",
      bearerToken: "token-rb2-2",
      worktreeRoot: worktreeDir,
      runId: "run-rb2-unreadable-dir",
    };
    const res = await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          runnerRan = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    );

    assert.equal(res.status, "refused");
    assert.equal(runnerRan, false, "runner must not run when worktree dir is unreadable");
  } finally {
    try {
      fs.chmodSync(lockedDir, 0o755);
    } catch {}
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("RB2 N-B11: unreadable worktree file fails closed in pre-exec and post-exec", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-unreadable-file-"));
  const lockedFile = path.join(worktreeDir, "locked_file.txt");
  try {
    fs.writeFileSync(lockedFile, "secret-like-content");
    fs.chmodSync(lockedFile, 0o000);

    // 1. collectWorktreeFiles throws on unreadable file
    assert.throws(
      () => collectWorktreeFiles(worktreeDir),
      (err: unknown) => err instanceof Error && /Failed to open worktree file/.test((err as Error).message)
    );

    // 2. scanWorktreeFilesBounded throws on unreadable file
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir),
      (err: unknown) => err instanceof Error && /Failed to open worktree file/.test((err as Error).message)
    );

    // 3. Pre-exec handleSandboxExec fails closed with status refused
    let runnerRan = false;
    const context: ToolExecutionContext = {
      skeletonId: "skel-rb2-unreadable-file",
      role: "Soul-stitcher",
      bearerToken: "token-rb2-3",
      worktreeRoot: worktreeDir,
      runId: "run-rb2-unreadable-file",
    };
    const res = await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          runnerRan = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    );

    assert.equal(res.status, "refused");
    assert.equal(runnerRan, false, "runner must not run when worktree file is unreadable");

    // 4. Post-exec scan fails closed with status fatal
    // Restore file so pre-exec passes, but lock it inside the runner before post-exec scan
    fs.chmodSync(lockedFile, 0o644);
    let postRunnerRan = false;
    const postRes = (await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          postRunnerRan = true;
          // Lock the file during run so post-exec scan encounters unreadable file
          fs.chmodSync(lockedFile, 0o000);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    )) as SandboxExecFatalResult;

    assert.equal(postRunnerRan, true);
    assert.equal(postRes.status, "fatal");
    assert.equal(postRes.fatal, true);
    assert.equal(postRes.quarantine, true);
  } finally {
    try {
      fs.chmodSync(lockedFile, 0o644);
    } catch {}
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("RB2 N-B11: validates scan limits on options and options.settings", () => {
  // Invalid values throw ConfigurationError
  assert.throws(
    () => validateScanLimits({ maxScanFiles: 0 }),
    (err: unknown) => err instanceof ConfigurationError
  );
  assert.throws(
    () => validateScanLimits({ maxScanFiles: -1 }),
    (err: unknown) => err instanceof ConfigurationError
  );
  assert.throws(
    () => validateScanLimits({ maxScanFiles: 1.5 }),
    (err: unknown) => err instanceof ConfigurationError
  );
  assert.throws(
    () => validateScanLimits({ maxScanFiles: NaN }),
    (err: unknown) => err instanceof ConfigurationError
  );
  assert.throws(
    () => validateScanLimits({ settings: { maxWorktreeScanFiles: 0 } }),
    (err: unknown) => err instanceof ConfigurationError
  );
  assert.throws(
    () => validateScanLimits({ maxScanTotalBytes: -100 }),
    (err: unknown) => err instanceof ConfigurationError
  );
  assert.throws(
    () => validateScanLimits({ settings: { maxWorktreeScanBytes: -5 } }),
    (err: unknown) => err instanceof ConfigurationError
  );

  // Valid values are accepted and used
  const limits = validateScanLimits({
    maxScanFiles: 50,
    settings: { maxWorktreeScanBytes: 1024 * 1024 },
  });
  assert.equal(limits.maxFiles, 50);
  assert.equal(limits.maxBytes, 1024 * 1024);
});

test("RB2 N-B17: ESCAPING_SYMLINK pre-exec refusal findings do not expose host realpath", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-symlink-pre-wt-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-symlink-pre-out-"));
  try {
    const outsideTarget = path.join(outsideDir, "outside_target.txt");
    fs.writeFileSync(outsideTarget, "outside secret content\n");

    const linkPath = path.join(worktreeDir, "bad_link");
    fs.symlinkSync(outsideTarget, linkPath);

    const emittedEvents: any[] = [];
    const eventStore = new EventStore(":memory:");
    const context: ToolExecutionContext = {
      skeletonId: "skel-rb2-pre-symlink",
      role: "Soul-stitcher",
      bearerToken: "token-rb2-4",
      worktreeRoot: worktreeDir,
      runId: "run-rb2-pre-symlink",
    };

    const res = (await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        eventStore,
        onEmitEvent: (e) => {
          emittedEvents.push(e);
        },
        runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "ESCAPING_SYMLINK");

    // Findings must not expose host realpath or resolvedTarget
    assert.ok(Array.isArray(res.findings) && res.findings.length > 0);
    for (const f of res.findings) {
      assert.equal(f.path, "bad_link", "path must be relative");
      assert.equal(f.ruleId, "ESCAPING_SYMLINK");
      assert.equal(typeof f.fingerprint, "string");
      assert.equal("resolvedTarget" in f, false, "resolvedTarget must be stripped");
      assert.equal("target" in f, false, "target must be stripped");
      const findingStr = JSON.stringify(f);
      assert.equal(
        findingStr.includes(outsideDir),
        false,
        "finding must not expose outside host path"
      );
    }

    // Reason / error must not expose outside host path
    assert.equal(res.error.includes(outsideDir), false, "error must not reveal host realpath");

    // Emitted and stored events must not expose host realpath
    for (const evt of emittedEvents) {
      const evtStr = JSON.stringify(evt);
      assert.equal(evtStr.includes(outsideDir), false, "emitted event must not contain outsideDir");
    }

    const storedEvents = eventStore.getEvents("run-rb2-pre-symlink");
    for (const evt of storedEvents) {
      const evtStr = JSON.stringify(evt);
      assert.equal(evtStr.includes(outsideDir), false, "stored event must not contain outsideDir");
    }
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("RB2 N-B17: ESCAPING_SYMLINK post-exec fatal findings do not expose host realpath", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-symlink-post-wt-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-symlink-post-out-"));
  try {
    const outsideTarget = path.join(outsideDir, "outside_target.txt");
    fs.writeFileSync(outsideTarget, "outside secret content\n");

    const emittedEvents: any[] = [];
    const eventStore = new EventStore(":memory:");
    const context: ToolExecutionContext = {
      skeletonId: "skel-rb2-post-symlink",
      role: "Soul-stitcher",
      bearerToken: "token-rb2-5",
      worktreeRoot: worktreeDir,
      runId: "run-rb2-post-symlink",
    };

    const res = (await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        eventStore,
        onEmitEvent: (e) => {
          emittedEvents.push(e);
        },
        runbox: (async () => {
          // Create escaping symlink during execution
          fs.symlinkSync(outsideTarget, path.join(worktreeDir, "post_bad_link"));
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    )) as SandboxExecFatalResult;

    assert.equal(res.status, "fatal");
    assert.equal(res.fatal, true);
    assert.equal(res.quarantine, true);
    assert.equal(res.code, "ESCAPING_SYMLINK");

    // Findings must not expose host realpath or resolvedTarget
    assert.ok(Array.isArray(res.findings) && (res.findings as any[]).length > 0);
    for (const f of res.findings as any[]) {
      assert.equal(f.path, "post_bad_link", "path must be relative");
      assert.equal(f.ruleId, "ESCAPING_SYMLINK");
      assert.equal(typeof f.fingerprint, "string");
      assert.equal("resolvedTarget" in f, false, "resolvedTarget must be stripped");
      assert.equal("target" in f, false, "target must be stripped");
      const findingStr = JSON.stringify(f);
      assert.equal(
        findingStr.includes(outsideDir),
        false,
        "finding must not expose outside host path"
      );
    }

    assert.equal(res.error.includes(outsideDir), false, "error must not reveal host realpath");
    assert.equal(res.reason?.includes(outsideDir), false, "reason must not reveal host realpath");

    for (const evt of emittedEvents) {
      const evtStr = JSON.stringify(evt);
      assert.equal(evtStr.includes(outsideDir), false, "emitted event must not contain outsideDir");
    }

    const storedEvents = eventStore.getEvents("run-rb2-post-symlink");
    for (const evt of storedEvents) {
      const evtStr = JSON.stringify(evt);
      assert.equal(evtStr.includes(outsideDir), false, "stored event must not contain outsideDir");
    }
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("RB2 N-B17: scanClonedRepository throws on excessive depth", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-deep-repo-"));
  try {
    fs.mkdirSync(path.join(repoDir, "level1", "level2", "level3"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "level1", "level2", "level3", "file.txt"), "hello");

    assert.throws(
      () => scanClonedRepository(repoDir, { maxDepth: 2 }),
      (err: unknown) =>
        err instanceof Error && /Repository scan exceeded maximum depth of 2/.test(err.message)
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("RB2 N-B17: scanClonedRepository throws on unreadable directory", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb2-unreadable-repo-"));
  const lockedSub = path.join(repoDir, "locked_sub");
  try {
    fs.mkdirSync(lockedSub, { recursive: true });
    fs.writeFileSync(path.join(lockedSub, "file.txt"), "hello");
    fs.chmodSync(lockedSub, 0o000);

    assert.throws(
      () => scanClonedRepository(repoDir),
      (err: unknown) =>
        err instanceof Error && /Failed to read repository directory/.test(err.message)
    );
  } finally {
    try {
      fs.chmodSync(lockedSub, 0o755);
    } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("R3B3 N-B11 / N-B17: SCAN_READ_ERROR never exposes raw worktreeRoot paths in findings or error/reason", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3b3-scan-read-err-"));
  const lockedFile = path.join(worktreeDir, "locked_file.txt");
  const lockedDir = path.join(worktreeDir, "locked_dir");
  try {
    fs.mkdirSync(lockedDir, { recursive: true });
    fs.writeFileSync(path.join(lockedDir, "subfile.txt"), "subcontent");
    fs.chmodSync(lockedDir, 0o000);
    fs.writeFileSync(lockedFile, "secret-stuff");
    fs.chmodSync(lockedFile, 0o000);

    // 1. toWorktreeRelativePath helper behavior
    assert.equal(toWorktreeRelativePath(lockedDir, worktreeDir), "locked_dir");
    assert.equal(toWorktreeRelativePath(lockedFile, worktreeDir), "locked_file.txt");
    assert.equal(toWorktreeRelativePath(worktreeDir, worktreeDir), ".");
    assert.equal(toWorktreeRelativePath(null, worktreeDir), ".");
    assert.equal(toWorktreeRelativePath(undefined, worktreeDir), ".");
    assert.equal(toWorktreeRelativePath("/etc/shadow", worktreeDir), "<outside-worktree>");
    assert.equal(toWorktreeRelativePath("../outside", worktreeDir), "<outside-worktree>");
    assert.equal(toWorktreeRelativePath("<outside-worktree>", worktreeDir), "<outside-worktree>");
    assert.equal(
      toWorktreeRelativePath(`Failed to read worktree directory ${worktreeDir}/locked_dir`, worktreeDir),
      "Failed to read worktree directory locked_dir"
    );

    // Direct scans throw without leaking raw worktreeDir in error message
    assert.throws(
      () => collectWorktreeFiles(worktreeDir),
      (err: any) =>
        (err.code === "SCAN_READ_ERROR" || err.code === "EACCES") &&
        !err.message.includes(worktreeDir)
    );
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir),
      (err: any) =>
        (err.code === "SCAN_READ_ERROR" || err.code === "EACCES") &&
        !err.message.includes(worktreeDir)
    );

    // 2. Pre-exec refusal does not leak worktreeDir
    // Restore lockedDir so symlink-scanner passes, leaving lockedFile to trigger SCAN_READ_ERROR
    fs.chmodSync(lockedDir, 0o755);

    const context: ToolExecutionContext = {
      skeletonId: "skel-r3b3-scan-read-pre",
      role: "Soul-stitcher",
      bearerToken: "token-r3b3-1",
      worktreeRoot: worktreeDir,
      runId: "run-r3b3-scan-read-pre",
    };
    const preRes = (await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(preRes.status, "refused");
    assert.equal(preRes.code === "SCAN_READ_ERROR" || preRes.code === "EACCES", true);
    assert.equal(preRes.error.includes(worktreeDir), false, "pre-exec error must not leak raw worktreeRoot");
    assert.ok(Array.isArray(preRes.findings) && preRes.findings.length > 0);
    for (const f of preRes.findings) {
      assert.equal(f.path.includes(worktreeDir), false, "finding path must not leak raw worktreeRoot");
      assert.equal(JSON.stringify(f).includes(worktreeDir), false, "finding must not leak raw worktreeRoot");
    }

    // 3. Post-exec fatal result does not leak worktreeDir
    fs.chmodSync(lockedFile, 0o644);
    const postRes = (await handleSandboxExec(
      { argv: ["git", "status"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          fs.chmodSync(lockedFile, 0o000);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    )) as SandboxExecFatalResult;

    assert.equal(postRes.status, "fatal");
    assert.equal(postRes.code === "SCAN_READ_ERROR" || postRes.code === "EACCES", true);
    assert.equal(postRes.error.includes(worktreeDir), false, "post-exec error must not leak raw worktreeRoot");
    assert.equal(
      typeof postRes.reason === "string" ? postRes.reason.includes(worktreeDir) : false,
      false,
      "post-exec reason must not leak raw worktreeRoot"
    );
    assert.ok(Array.isArray(postRes.findings) && (postRes.findings as any[]).length > 0);
    for (const f of postRes.findings as any[]) {
      assert.equal(f.path.includes(worktreeDir), false, "post-exec finding path must not leak raw worktreeRoot");
      assert.equal(JSON.stringify(f).includes(worktreeDir), false, "post-exec finding must not leak raw worktreeRoot");
    }
  } finally {
    try {
      fs.chmodSync(lockedDir, 0o755);
      fs.chmodSync(lockedFile, 0o644);
    } catch {}
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R3B3 N-B11 / N-B17: CWD_OUTSIDE_WORKTREE never exposes raw worktreeRoot paths or cwd", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3b3-cwd-outside-"));
  try {
    const context: ToolExecutionContext = {
      skeletonId: "skel-r3b3-cwd",
      role: "Soul-stitcher",
      bearerToken: "token-r3b3-2",
      worktreeRoot: worktreeDir,
      runId: "run-r3b3-cwd",
    };

    // 1. Absolute outside path
    const resAbs = (await handleSandboxExec(
      { argv: ["git", "status"], cwd: "/etc/passwd" },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(resAbs.status, "refused");
    assert.equal(resAbs.code, "CWD_OUTSIDE_WORKTREE");
    assert.equal(resAbs.error, "Requested cwd resolves outside worktree root");
    assert.equal(resAbs.error.includes(worktreeDir), false);
    assert.equal(resAbs.error.includes("/etc/passwd"), false);

    // 2. Relative traversal outside path
    const resRel = (await handleSandboxExec(
      { argv: ["git", "status"], cwd: "../outside" },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(resRel.status, "refused");
    assert.equal(resRel.code, "CWD_OUTSIDE_WORKTREE");
    assert.equal(resRel.error, "Requested cwd resolves outside worktree root");
    assert.equal(resRel.error.includes(worktreeDir), false);
    assert.equal(resRel.error.includes("../outside"), false);
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R3B3 N-B11: caller-list entries fail closed on non-file and EACCES, skip on ENOENT", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3b3-caller-list-"));
  const subDir = path.join(worktreeDir, "caller_sub_dir");
  const nodeModulesDir = path.join(worktreeDir, "node_modules");
  const lockedFile = path.join(nodeModulesDir, "locked_file.txt");
  const regularFile = path.join(worktreeDir, "regular.txt");
  try {
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(lockedFile, "secret");
    fs.chmodSync(lockedFile, 0o000);
    fs.writeFileSync(regularFile, "clean content\n");

    const context: ToolExecutionContext = {
      skeletonId: "skel-r3b3-caller",
      role: "Soul-stitcher",
      bearerToken: "token-r3b3-3",
      worktreeRoot: worktreeDir,
      runId: "run-r3b3-caller",
    };

    // 1. Non-file caller entry (directory) fails closed
    assert.throws(
      () => collectWorktreeFiles(worktreeDir, undefined, { worktreeFiles: ["caller_sub_dir"] } as any),
      (err: any) => /Worktree entry is not a regular file/.test(err.message) || err.code === "SCAN_READ_ERROR"
    );
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir, undefined, { worktreeFiles: ["caller_sub_dir"] } as any),
      (err: any) => /Worktree entry is not a regular file/.test(err.message) || err.code === "SCAN_READ_ERROR"
    );
    const nonFileRes = (await handleSandboxExec(
      { argv: ["git", "status"], files: ["caller_sub_dir"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
      }
    )) as SandboxExecRefusedResult;
    assert.equal(nonFileRes.status, "refused");
    assert.equal(nonFileRes.code, "SCAN_READ_ERROR");
    assert.ok(nonFileRes.findings && nonFileRes.findings.length > 0);
    assert.equal(nonFileRes.findings[0].path, "caller_sub_dir");

    // 2. Unreadable caller entry (EACCES) fails closed
    assert.throws(
      () => collectWorktreeFiles(worktreeDir, undefined, { worktreeFiles: ["node_modules/locked_file.txt"] } as any),
      (err: any) => /Failed to open worktree file/.test(err.message) || err.code === "EACCES"
    );
    assert.throws(
      () => scanWorktreeFilesBounded(worktreeDir, undefined, { worktreeFiles: ["node_modules/locked_file.txt"] } as any),
      (err: any) => /Failed to open worktree file/.test(err.message) || err.code === "EACCES"
    );
    const lockedRes = (await handleSandboxExec(
      { argv: ["git", "status"], files: ["node_modules/locked_file.txt"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })) as any,
      }
    )) as SandboxExecRefusedResult;
    assert.equal(lockedRes.status, "refused");
    assert.equal(lockedRes.code === "SCAN_READ_ERROR" || lockedRes.code === "EACCES", true);
    assert.ok(lockedRes.findings && lockedRes.findings.length > 0);
    assert.equal(lockedRes.findings[0].path, "node_modules/locked_file.txt");

    // 3. Missing caller entry (ENOENT) is skipped
    const okCollected = collectWorktreeFiles(worktreeDir, undefined, {
      worktreeFiles: ["non_existent.txt", "regular.txt"],
    } as any);
    assert.ok(okCollected.some((f) => f.path === "regular.txt"));
    assert.equal(okCollected.some((f) => f.path === "non_existent.txt"), false);

    const okScan = scanWorktreeFilesBounded(worktreeDir, undefined, {
      worktreeFiles: ["non_existent.txt", "regular.txt"],
    } as any);
    assert.equal(okScan.passed, true);

    let ran = false;
    const okExec = await handleSandboxExec(
      { argv: ["git", "status"], files: ["non_existent.txt", "regular.txt"] },
      context,
      {
        defaultTimeoutMs: 60000,
        logStore: new LogStore({ inMemory: true }),
        runbox: (async () => {
          ran = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    );
    assert.equal(okExec.status, "completed");
    assert.equal(ran, true);
  } finally {
    try {
      fs.chmodSync(lockedFile, 0o644);
    } catch {}
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R3B3 N-B11 / N-B17: findFilesRecursively and neutralizeUntrustedContent fail closed on unreadable subdirectories and excessive depth", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3b3-untrusted-"));
  const lockedDir = path.join(tempDir, ".kiro", "locked_sub");
  try {
    // 1. findFilesRecursively enforces maxDepth
    fs.mkdirSync(path.join(tempDir, "d1", "d2", "d3", "d4"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "d1", "d2", "d3", "d4", "deep.txt"), "content");
    assert.throws(
      () => findFilesRecursively(tempDir, "", 0, 2),
      (err: unknown) => err instanceof Error && /Directory traversal exceeded maximum depth of 2/.test(err.message)
    );

    // 2. findFilesRecursively treats top-level ENOENT at depth 0 as empty
    const enoentRes = findFilesRecursively(path.join(tempDir, "does-not-exist"), "does-not-exist");
    assert.deepEqual(enoentRes, []);

    // 3. findFilesRecursively fails closed on unreadable subdirectory
    fs.mkdirSync(lockedDir, { recursive: true });
    fs.writeFileSync(path.join(lockedDir, "secret.json"), "{}");
    fs.chmodSync(lockedDir, 0o000);

    assert.throws(
      () => findFilesRecursively(path.join(tempDir, ".kiro"), ".kiro"),
      (err: any) => err?.code === "EACCES" || /permission denied/i.test(err?.message ?? "")
    );

    // 4. neutralizeUntrustedContent fails closed on unreadable subdirectories
    assert.throws(
      () =>
        neutralizeUntrustedContent(tempDir, {
          p7: { id: "P7", passed: false, outcome: "loads untrusted files" },
          scanResult: {
            hasUntrustedContent: true,
            entries: [],
            untrustedPaths: [".kiro"],
            kiroPaths: [".kiro"],
            agentsPaths: [],
            skillPaths: [],
          },
        }),
      (err: any) => err?.code === "EACCES" || /permission denied/i.test(err?.message ?? "")
    );
  } finally {
    try {
      fs.chmodSync(lockedDir, 0o755);
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
